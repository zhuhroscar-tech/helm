// LEAN 回测的统计检验：和 qlib 研究引擎（engine/qlib_research）同一套思路（块自助法夏普置信区间、超额收益、
// 考虑尝试次数的“去膨胀夏普”），用来客观决定一个回测能不能标成主版本。

import { isTradingDay } from './market-calendar.mjs';

const SQ252 = Math.sqrt(252);
const isoDay = (d) => new Date(d * 86400000).toISOString().slice(0, 10);
// 交易日按美股休市日历判断（public/calendar.js，含 1994 年以后的临时休市）。
// 以前用「基准收盘价和前一天完全一样」当作休市，会把真实交易日也去掉（项目 1002 的 15 年里有 50 天），年数少算约 1.3%。
export const isMarketDay = (d) => isTradingDay(isoDay(d));

function normPoints(values) {
  const arr = Array.isArray(values) ? values : Object.values(values || {});
  const out = [];
  for (const p of arr) {
    let t; let v;
    if (Array.isArray(p)) { t = p[0]; v = p[p.length - 1]; } else if (p && typeof p === 'object') { t = p.x ?? p.time; v = p.y ?? p.close ?? p.value; }
    t = +t; v = +v;
    if (Number.isFinite(t) && Number.isFinite(v)) out.push([t > 1e12 ? t / 1000 : t, v]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}
export function series(result, chart, prefer) {
  const c = result && result.charts && result.charts[chart];
  if (!c || !c.series) return [];
  const s = c.series[prefer] || Object.values(c.series)[0];
  return normPoints(s && s.values);
}
// 每个交易日一个点（取当天最后一个）。LEAN 的图表连周末也有点（数值不变），
// 按纽约日期去掉周六周日，否则一年会被当成 365 个交易日，年化数字全部偏低。
// LEAN 在纽约午夜（04/05Z）记的点是前一天的收盘值，收盘点在 20/21Z：按 t-6h 归日，午夜点归到前一天。
export function tradingDay(t) {
  const d = Math.floor((t - 6 * 3600) / 86400);
  const dow = (d + 4) % 7; // 1970-01-01 是周四；0=周日 6=周六
  return dow === 0 || dow === 6 ? null : d;
}
// 落在周末的点（周日 / 周一凌晨的点，值是上周五的收盘）：周五还没有值时补到周五，已经有就不动。
// 回测从周一开始时，起点只有周一凌晨这一个点；以前把它丢掉，第一天的收益就没了，日收益复利和曲线首尾对不上。
export function byDay(pts) {
  const m = new Map();
  for (const p of pts) {
    const d = tradingDay(p[0]);
    if (d != null) { m.set(d, p[1]); continue; }
    const raw = Math.floor((p[0] - 6 * 3600) / 86400);
    const fri = raw - ((raw + 4) % 7 === 6 ? 1 : 2);
    if (!m.has(fri)) m.set(fri, p[1]);
  }
  return m;
}

// 回测实际覆盖的日期区间（纽约日期，YYYY-MM-DD），用来判断两次尝试是不是用了同一段历史
export function resultWindow(result) {
  const days = [...byDay(series(result, 'Strategy Equity', 'Equity')).keys()].sort((a, b) => a - b);
  if (days.length < 2) return null;
  const iso = (d) => new Date(d * 86400000).toISOString().slice(0, 10);
  return [iso(days[0]), iso(days[days.length - 1])];
}

// 均值 / 标准差用普通循环：自助法每次重抽都要算一遍（2000 次 × 几千天），
// Float64Array 上的 reduce 比 for 循环慢约 6 倍（实测 138 ms → 21 ms）。两遍算法，数值和原来完全一样。
function mean(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s / a.length; }
function sd(a) {
  const m = mean(a); let v = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - m; v += d * d; }
  return Math.sqrt(v / (a.length - 1));
}
// 方差为 0 的判断留一点余量（和 robust.mjs 的 sharpeOf 一致）：纯浮点噪声不能算出一个天文数字的夏普
const sharpe = (r) => { const s = sd(r); return s > 1e-12 ? (mean(r) / s) * SQ252 : 0; };

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 循环块自助法（Politis & Romano 1992）：保留 20 天内的自相关，重抽 2000 次。
// 块可以从任何一天开始并绕回开头，所以每一天被抽中的机会相同；
// 不绕回的写法会让首尾约 20 天几乎抽不到（最近的亏损会被忽略）。
// 生成重抽的下标（同一组随机数），stat(idx) 用下标取数：配对检验（同一天的策略和基准）不用复制数组
export function blockBootstrapIdx(len, stat, { n = 2000, block = 20, seed = 7 } = {}) {
  if (len < block * 2) return null;
  const rnd = mulberry32(seed);
  const out = new Float64Array(n);
  const idx = new Int32Array(len);
  for (let i = 0; i < n; i++) {
    let k = 0;
    while (k < len) {
      const s = Math.floor(rnd() * len);
      for (let j = 0; j < block && k < len; j++) idx[k++] = (s + j) % len;
    }
    out[i] = stat(idx);
  }
  out.sort(); // Float64Array 按数值排序
  const q = (p) => out[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
  let le0 = 0; while (le0 < n && out[le0] <= 0) le0++;
  return { lo: q(0.025), hi: q(0.975), pLe0: le0 / n };
}
export function blockBootstrap(r, stat, opts = {}) {
  const x = new Float64Array(r.length);
  return blockBootstrapIdx(r.length, (idx) => { for (let k = 0; k < idx.length; k++) x[k] = r[idx[k]]; return stat(x); }, opts);
}
// 按下标取子样本的夏普（不分配新数组）
function sharpeAt(a, idx) {
  const n = idx.length; let s = 0;
  for (let k = 0; k < n; k++) s += a[idx[k]];
  const m = s / n; let v = 0;
  for (let k = 0; k < n; k++) { const d = a[idx[k]] - m; v += d * d; }
  const sdv = Math.sqrt(v / (n - 1));
  return sdv > 1e-12 ? (m / sdv) * SQ252 : 0;
}

// 标准正态
function ncdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}
function ninv(p) {
  // Acklam
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5; const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// 概率夏普（Bailey & López de Prado）：真实夏普 > srStar 的概率。sr、srStar 都是日频单位
function psr(r, srStar) {
  const n = r.length;
  const m = mean(r); const s = sd(r);
  if (!(s > 0) || n < 30) return null;
  const sr = m / s;
  const skew = r.reduce((a, x) => a + (x - m) ** 3, 0) / n / s ** 3;
  const kurt = r.reduce((a, x) => a + (x - m) ** 4, 0) / n / s ** 4;
  const den = Math.sqrt(Math.max(1e-12, 1 - skew * sr + ((kurt - 1) / 4) * sr * sr));
  return ncdf(((sr - srStar) * Math.sqrt(n - 1)) / den);
}

// 去膨胀夏普：试了 N 个版本，最好那个的夏普天然偏高。期望最大值 SR0 来自 N 次尝试的夏普离散度
function deflatedSharpe(r, trialSharpesAnnual) {
  const N = Math.max(1, trialSharpesAnnual.length);
  if (N < 2) return { dsr: psr(r, 0), sr0: 0, trials: N };
  const daily = trialSharpesAnnual.map((x) => x / SQ252);
  const v = sd(daily) ** 2;
  const g = 0.5772156649;
  const sr0 = Math.sqrt(v) * ((1 - g) * ninv(1 - 1 / N) + g * ninv(1 - 1 / (N * Math.E)));
  return { dsr: psr(r, sr0), sr0: sr0 * SQ252, trials: N };
}

// 统计检验用的日频序列：每个交易日一个权益值，去掉周末和节假日，再算日收益。
// validateResult 和 checkConsistency 共用这一份，保证“核对的”就是“关卡用的”那条序列。
function dailyEquity(result) {
  const eqM = byDay(series(result, 'Strategy Equity', 'Equity'));
  const bmM = byDay(series(result, 'Benchmark', 'Benchmark').filter((p) => p[1] > 0));
  // 休市日（LEAN 的图表在休市日也会记点，数值不变）按日历去掉；第一个点是起点，总是保留
  const days = [...eqM.keys()].sort((a, b) => a - b).filter((d, i) => i === 0 || isMarketDay(d));
  const eqV = days.map((d) => eqM.get(d));
  const r = [];
  for (let i = 1; i < eqV.length; i++) if (eqV[i - 1] > 0) r.push(eqV[i] / eqV[i - 1] - 1);
  return { days, eqV, r, bmM };
}

// 和关卡检验用的同一个口径（日收益 mean/sd·√252，无风险利率 0）：记进尝试记录，去膨胀夏普的门槛才和被检验的夏普同一把尺子。
// LEAN 的「Sharpe Ratio」是 ((1+日均)^252 − 1 − 无风险利率) / 年化波动，口径不同，离散度会被放大约 10–20%。
export function dailySharpe(result) {
  const { r } = dailyEquity(result);
  return r.length >= 2 ? sharpe(r) : null;
}

/* ---------------- 指标一致性核对 ----------------
 * 别家的回测系统报过“收益 79%”、实际约 26% 的错，因为没有任何东西交叉核对。这里把 LEAN 报出的头条数字
 * 和权益曲线本身逐项对一遍，任何一项对不上就是「指标互相矛盾」，不能标主版本。只报告，绝不自动修正。
 * LEAN 的口径（engine/Lean/Common/Statistics/PortfolioStatistics.cs、StatisticsBuilder.cs、Statistics.cs）：
 *   End Equity = 权益曲线（Strategy Equity / Equity 的收盘值）最后一个点；Start Equity = 初始资金 = 曲线第一个点；
 *   Net Profit = End / Start − 1，保留 3 位小数（百分数）；
 *   Compounding Annual Return = (End / Start)^(1/年数) − 1，年数 = 曲线首尾两个点相隔的日历天数 / 365；
 *   Drawdown = 曲线上相对历史最高点的最大回撤，小数保留 3 位，也就是 0.1 个百分点的粒度；
 *   Total Orders = 创建过的全部订单（含无效、已取消），即结果里 orders 的条数，不是只数成交的；
 *   Win Rate / Loss Rate = 盈利 / 亏损的平仓次数占比，各自四舍五入到整数 %。
 * 曲线采样：纽约午夜（04/05Z）的点是前一天的收盘值，收盘点在 20/21Z，见 tradingDay。
 */
export const CONSISTENCY_TOL = {
  equityRel: 1e-4, // 金额（Start / End Equity 对曲线首尾点）：相对差 ≤ 0.01%。LEAN 只把金额舍入到分
  pctAbs: 0.01, // 百分比（净利润、复合年化、Helm 日收益复利）：差 ≤ 0.01 个百分点，
  pctRel: 1e-4, //   或者该数值本身的 0.01%，取大者（LEAN 保留 3 位小数，舍入误差 0.0005 个百分点）
  drawdownAbs: 0.06, // 回撤：差 ≤ 0.06 个百分点。LEAN 舍入到 0.1 个百分点，舍入误差最多 0.05
  winLossAbs: 1, // 胜率 + 败率：和 100% 差 ≤ 1 个百分点（两者各自舍入到整数 %，和可能是 99 或 101）
  orders: 0, // 订单数：必须完全相等
};

// 必须存在且是有限数字的头条指标；其余列在 OPTIONAL_FINITE 里的有就查
const REQUIRED_STATS = ['Net Profit', 'Compounding Annual Return', 'Drawdown', 'Sharpe Ratio', 'Start Equity', 'End Equity', 'Total Orders'];
const OPTIONAL_FINITE = ['Sortino Ratio', 'Probabilistic Sharpe Ratio', 'Win Rate', 'Loss Rate', 'Alpha', 'Beta', 'Annual Standard Deviation', 'Annual Variance', 'Information Ratio', 'Tracking Error', 'Treynor Ratio', 'Total Fees', 'Average Win', 'Average Loss', 'Expectancy', 'Profit-Loss Ratio'];
const STAT_ZH = {
  'Net Profit': '净利润', 'Compounding Annual Return': '复合年化收益', Drawdown: '最大回撤', 'Sharpe Ratio': '夏普比率',
  'Start Equity': '起始资金', 'End Equity': '期末权益', 'Total Orders': '订单总数', 'Sortino Ratio': '索提诺比率',
  'Probabilistic Sharpe Ratio': '概率夏普', 'Win Rate': '胜率', 'Loss Rate': '败率', Alpha: 'Alpha', Beta: 'Beta',
  'Annual Standard Deviation': '年化波动率', 'Annual Variance': '年化方差', 'Information Ratio': '信息比率', 'Tracking Error': '跟踪误差',
  'Treynor Ratio': '特雷诺比率', 'Total Fees': '总手续费', 'Average Win': '平均盈利', 'Average Loss': '平均亏损', Expectancy: '期望值', 'Profit-Loss Ratio': '盈亏比',
};
const statNum = (raw) => (raw == null ? null : parseFloat(String(raw).replace(/[$,%\s]/g, '')));
const pctStr = (x) => (Number.isFinite(x) ? `${x.toFixed(3)}%` : String(x));
const moneyStr = (x) => (Number.isFinite(x) ? x.toFixed(2) : String(x));

/**
 * 核对一个 LEAN 结果里的数字是否互相一致。只读，不改结果。
 * @returns {{ ok, skipped, checks: [{id, zh, ok, lean, helm, diff, tol, msg}], failures: string[], worst }}
 *   failures 是每个不一致项的中文说明（含两个数字）；worst 是“差值 / 容差”最大的一项（全部一致时也给出，便于看余量）。
 */
export function checkConsistency(result) {
  const T = CONSISTENCY_TOL;
  const s = (result && result.statistics) || {};
  const checks = [];
  const add = (id, zh, lean, helm, tol, fmt, msgHead, leanLabel = 'LEAN') => {
    const diff = Math.abs(lean - helm);
    const ok = Number.isFinite(diff) && diff <= tol;
    checks.push({ id, zh, ok, lean, helm, diff, tol, msg: ok ? null : `${msgHead}：${leanLabel} ${fmt(lean)}，${zh} ${fmt(helm)}（差 ${fmt(diff)}，容差 ${fmt(tol)}）` });
  };

  // 1. 头条数字必须存在且是有限数字（NaN / ∞ 说明统计本身坏了）
  const v = {};
  for (const k of [...REQUIRED_STATS, ...OPTIONAL_FINITE]) {
    const present = k in s && s[k] != null && String(s[k]).trim() !== '';
    if (!present && !REQUIRED_STATS.includes(k)) continue;
    v[k] = present ? statNum(s[k]) : null;
    if (!Number.isFinite(v[k])) {
      checks.push({ id: `finite:${k}`, zh: '有限数字', ok: false, lean: present ? String(s[k]) : null, helm: null, diff: Infinity, tol: 0,
        msg: present ? `「${STAT_ZH[k] || k}」（${k}）不是有限数字：LEAN 报 ${s[k]}` : `缺少头条指标「${STAT_ZH[k] || k}」（${k}）` });
    }
  }

  // 2. 订单数：LEAN 数的是全部订单（含无效、取消）
  const orders = result && result.orders ? Object.keys(result.orders).length : 0;
  if (Number.isFinite(v['Total Orders'])) add('orders', '结果里的订单条数', v['Total Orders'], orders, T.orders, (x) => String(x), '订单总数对不上');

  // 3. 胜率 + 败率 ≈ 100%（有平仓交易时）
  const tp = (result && result.totalPerformance) || {};
  const nTrades = Number((tp.tradeStatistics && tp.tradeStatistics.totalNumberOfTrades) ?? (Array.isArray(tp.closedTrades) ? tp.closedTrades.length : 0)) || 0;
  if (Number.isFinite(v['Win Rate']) && Number.isFinite(v['Loss Rate']) && (nTrades > 0 || v['Win Rate'] + v['Loss Rate'] > 0)) {
    add('winloss', '应为', v['Win Rate'] + v['Loss Rate'], 100, T.winLossAbs, (x) => `${+x.toFixed(2)}%`, `胜率 + 败率不等于 100%（${nTrades} 笔平仓交易）`);
  }

  // 4. 和权益曲线对账
  const pts = series(result, 'Strategy Equity', 'Equity');
  const { days, eqV, r } = dailyEquity(result);
  let skipped = null;
  if (pts.length < 2 || days.length < 3) {
    // LEAN 在不足 2 个日收益时不计算收益类指标（全是 0），没法对账；这种回测本来也过不了“至少 1 年”的关卡
    skipped = pts.length < 2 ? '没有权益曲线，无法和曲线对账' : '样本太短（不足 3 个交易日），LEAN 不计算收益类指标，未和曲线对账';
  } else {
    const [t0, e0] = pts[0];
    const [t1, e1] = pts[pts.length - 1];
    const curveRet = (e1 / e0 - 1) * 100;
    const pctTol = (x) => Math.max(T.pctAbs, T.pctRel * Math.abs(x));
    if (Number.isFinite(v['Start Equity'])) add('start', '权益曲线第一个点', v['Start Equity'], e0, T.equityRel * Math.abs(e0), moneyStr, '起始资金对不上');
    if (Number.isFinite(v['End Equity'])) add('end', '权益曲线最后一个点', v['End Equity'], e1, T.equityRel * Math.abs(e1), moneyStr, '期末权益对不上');
    if (Number.isFinite(v['Net Profit'])) add('netProfit', '按权益曲线首尾算', v['Net Profit'], curveRet, pctTol(v['Net Profit']), pctStr, '净利润对不上');
    const years = (t1 - t0) / 86400 / 365;
    if (Number.isFinite(v['Compounding Annual Return']) && years > 0 && e0 > 0 && e1 > 0) {
      const cagr = ((e1 / e0) ** (1 / years) - 1) * 100;
      add('cagr', `按权益曲线和日期（${years.toFixed(2)} 年）重算`, v['Compounding Annual Return'], cagr, pctTol(v['Compounding Annual Return']), pctStr, '复合年化收益对不上');
    }
    if (Number.isFinite(v.Drawdown)) {
      let peak = -Infinity; let mdd = 0;
      for (const e of eqV) { if (e > peak) peak = e; if (peak > 0) mdd = Math.max(mdd, 1 - e / peak); }
      add('drawdown', '按日频权益重算', v.Drawdown, mdd * 100, T.drawdownAbs, pctStr, '最大回撤对不上');
    }
    // Helm 自己的日收益（统计检验关卡用的就是这条）复利回去，必须等于曲线的总收益
    const helmRet = (r.reduce((acc, x) => acc * (1 + x), 1) - 1) * 100;
    add('helmDaily', '权益曲线首尾', helmRet, curveRet, pctTol(curveRet), pctStr, 'Helm 统计检验用的日收益复利出的总收益和曲线对不上', 'Helm 日收益复利');
  }

  const failures = checks.filter((c) => !c.ok).map((c) => c.msg);
  let worst = null;
  for (const c of checks) {
    const ratio = c.tol > 0 ? c.diff / c.tol : (c.diff > 0 || !Number.isFinite(c.diff) ? Infinity : 0);
    if (!worst || ratio > worst.ratio) worst = { id: c.id, ratio, ok: c.ok, lean: c.lean, helm: c.helm, diff: c.diff, tol: c.tol };
  }
  return { ok: failures.length === 0, skipped, checks, failures, worst };
}

export const GATE_RULES = '主版本必须同时满足：① 夏普的 95% 置信区间下限 > 0；② 有 90% 以上把握跑赢同期基准（块自助法下超额收益 ≤ 0 的概率 < 10%，只看点估计 > 0 不够）；③ 去膨胀夏普 ≥ 95%（已经扣掉在同一段历史上试过多少个版本的运气成分：所有项目都算，不看开发期/验证期标签，删掉回测也不会减少次数）；④ 至少 1 年数据；⑤ 指标自洽：LEAN 报出的净利润、期末权益、复合年化、最大回撤、订单数、胜率败率要和权益曲线、订单记录互相对得上，夏普等头条数字必须是有限数字，任何一项对不上就是「指标互相矛盾」。择时类策略（项目 project.json 里 validation = "risk-adjusted"，必须在看验证期之前设定）把 ② 换成「风险调整后跑赢基准」：同日配对块自助法下夏普差 ≤ 0 的概率 < 10%，并且最大回撤不超过基准的 2/3。';

/**
 * @param result     LEAN 结果 JSON
 * @param meta       回测 meta（role/period/holdoutSeq）
 * @param trials     同一段历史上（所有项目、同一 period）非基准的已完成尝试的 LEAN 夏普列表（含自己）
 * @param trialInfo  { own, other }：其中本项目和其他项目各几次，只用于说明
 */
export function validateResult(result, meta = {}, trials = [], trialInfo = null) {
  const { days, eqV, r, bmM } = dailyEquity(result);
  if (days.length < 30) return { ok: false, reason: '数据太少，无法做统计检验', gates: [], pass: false };

  const ex = []; const br = []; const sr_ = [];
  for (let i = 1; i < days.length; i++) {
    const b0 = bmM.get(days[i - 1]); const b1 = bmM.get(days[i]);
    if (b0 > 0 && b1 > 0 && eqV[i - 1] > 0) { const rb = b1 / b0 - 1; const rs = eqV[i] / eqV[i - 1] - 1; br.push(rb); sr_.push(rs); ex.push(rs - rb); }
  }
  const years = r.length / 252;
  const sr = sharpe(r);
  const boot = blockBootstrap(r, (x) => sharpe(x));
  const exBoot = ex.length > 40 ? blockBootstrap(ex, (x) => mean(x) * 252) : null;
  const annEx = ex.length ? mean(ex) * 252 : null;
  const te = ex.length > 2 ? sd(ex) * SQ252 : null;
  const ds = deflatedSharpe(r, trials.filter((x) => Number.isFinite(x)));
  const psr0 = psr(r, 0);
  const psrBench = br.length > 30 ? psr(r, mean(br) / sd(br)) : null;

  // 择时类策略（项目 project.json 里 validation = "risk-adjusted"）：「跑赢基准」看风险调整后，不看收益。
  // 规则（2026-11-09 定，先于任何验证期运行）：同日配对块自助法下 P(夏普差 ≤ 0) < 10%，并且最大回撤 ≤ 基准的 2/3。
  const riskMode = meta.gateMode === 'risk-adjusted';
  let ra = null;
  if (riskMode && sr_.length > 40) {
    const sdBoot = blockBootstrapIdx(sr_.length, (idx) => sharpeAt(sr_, idx) - sharpeAt(br, idx));
    const mddOf = (rets) => { let eq = 1, pk = 1, m = 0; for (const x of rets) { eq *= 1 + x; if (eq > pk) pk = eq; m = Math.max(m, 1 - eq / pk); } return m; };
    ra = { sharpeDiff: sharpe(sr_) - sharpe(br), sdCi: sdBoot && [sdBoot.lo, sdBoot.hi], pSdLe0: sdBoot ? sdBoot.pLe0 : null, mdd: mddOf(sr_), mddBench: mddOf(br) };
    ra.ddOk = ra.mdd <= ra.mddBench * (2 / 3);
    ra.sdOk = ra.pSdLe0 != null && ra.pSdLe0 < 0.10;
  }
  const excessGate = riskMode
    ? { id: 'riskadj', zh: '风险调整后跑赢基准（夏普差自助法 P(≤0) < 10%，且最大回撤 ≤ 基准的 2/3）', value: ra ? ra.pSdLe0 : null, ok: Boolean(ra && ra.sdOk && ra.ddOk),
        detail: ra ? `夏普差 ${ra.sharpeDiff >= 0 ? '+' : ''}${ra.sharpeDiff.toFixed(2)}，95% 区间 [${ra.sdCi ? ra.sdCi[0].toFixed(2) : '?'}, ${ra.sdCi ? ra.sdCi[1].toFixed(2) : '?'}]，P(≤0) = ${ra.pSdLe0 != null ? Math.round(ra.pSdLe0 * 100) : '?'}%；最大回撤 ${(ra.mdd * 100).toFixed(1)}% vs 基准 ${(ra.mddBench * 100).toFixed(1)}%（上限 ${(ra.mddBench * 200 / 3).toFixed(1)}%）` : '没有基准数据' }
    : null;
  const gates = [
    { id: 'ci', zh: '夏普 95% 置信区间下限 > 0（无风险利率按 0 计，和 qlib 引擎一致）', value: boot ? boot.lo : null, ok: Boolean(boot && boot.lo > 0), detail: boot ? `[${boot.lo.toFixed(2)}, ${boot.hi.toFixed(2)}]` : '样本太短' },
    ...(excessGate ? [excessGate] : [{ id: 'excess', zh: '有 90% 以上把握跑赢基准（超额收益自助法 P(≤0) < 10%）', value: exBoot ? exBoot.pLe0 : null, ok: annEx != null && annEx > 0 && Boolean(exBoot) && exBoot.pLe0 < 0.10, detail: annEx == null ? '没有基准数据' : `超额 ${(annEx * 100).toFixed(2)}%/年${exBoot ? `，95% 区间 [${(exBoot.lo * 100).toFixed(1)}%, ${(exBoot.hi * 100).toFixed(1)}%]，P(≤0) = ${(exBoot.pLe0 * 100).toFixed(0)}%` : ''}` }]),
    { id: 'dsr', zh: `去膨胀夏普 ≥ 95%（同一段历史共试过 ${ds.trials} 个版本${trialInfo && trialInfo.other ? `：本项目 ${trialInfo.own}、其他项目 ${trialInfo.other}` : ''}）`, value: ds.dsr, ok: ds.dsr != null && ds.dsr >= 0.95, detail: ds.dsr == null ? '样本太短' : `${(ds.dsr * 100).toFixed(1)}%${ds.trials > 1 ? `（${ds.trials} 次尝试里最好的夏普，靠运气也能到 ${ds.sr0.toFixed(2)}）` : ''}` },
    { id: 'len', zh: '至少 1 年数据', value: years, ok: years >= 1, detail: `${years.toFixed(1)} 年` },
  ];
  const warnings = [];
  if (meta.period === 'holdout' && meta.holdoutSeq > 1) warnings.push(`这是本项目第 ${meta.holdoutSeq} 次看验证期：之前的结果可能已经影响了策略设计，验证期不再是干净的样本外。`);
  if (meta.period === 'dev') warnings.push('这是开发期（样本内）结果：参数是在这段数据上挑的，通过检验也不代表样本外有效，还要在验证期验证一次。');
  if (ex.length && Math.abs(ex.length - r.length) > r.length * 0.1) warnings.push('基准数据和策略日期对不齐的天数较多，超额收益仅供参考。');
  return {
    ok: true,
    pass: gates.every((g) => g.ok),
    gates,
    warnings,
    numbers: {
      sharpe: sr, sharpeCi: boot && [boot.lo, boot.hi], pSharpeLe0: boot && boot.pLe0,
      annualExcess: annEx, excessCi: exBoot && [exBoot.lo, exBoot.hi], pExcessLe0: exBoot && exBoot.pLe0,
      trackingError: te, infoRatio: annEx != null && te > 0 ? annEx / te : null,
      psr: psr0, psrVsBenchmark: psrBench, riskAdjusted: ra, dsr: ds.dsr, trials: ds.trials, sr0: ds.sr0, years, days: r.length,
    },
    holdoutSeq: meta.holdoutSeq || null,
    rules: GATE_RULES,
  };
}

/**
 * 主版本还差什么：对每个没通过的检验，算出「要怎样才能通过」。纯函数，输入 validateResult/validateBacktest 的结果。
 * 区间按正态近似反推标准误：se ≈ (上限 − 下限) / 3.92。
 *  - excess：P(超额 ≤ 0) < 10% ⇔ 超额 ≥ 1.2816·se；超额不变时，跟踪误差要按 se 同比例降到 te·超额/(1.2816·se)
 *  - ci：夏普下限 > 0 ⇔ 夏普 ≥ 1.96·se；夏普不变时，所需年数按 se ∝ 1/√年 推算
 */
export function mainNeeds(v) {
  if (!v || !v.ok || v.pass) return [];
  const n = v.numbers || {};
  const out = [];
  for (const g of v.gates || []) {
    if (g.ok) continue;
    const d = { id: g.id, zh: g.zh, detail: g.detail };
    if (g.id === 'excess' && n.excessCi && n.annualExcess != null) {
      const se = (n.excessCi[1] - n.excessCi[0]) / 3.92;
      Object.assign(d, { se, haveExcess: n.annualExcess, needExcess: 1.2816 * se, haveTe: n.trackingError ?? null });
      d.needTe = n.annualExcess > 0 && n.trackingError > 0 && se > 0 ? n.trackingError * n.annualExcess / (1.2816 * se) : null;
    } else if (g.id === 'ci' && n.sharpeCi && n.sharpe != null) {
      const se = (n.sharpeCi[1] - n.sharpeCi[0]) / 3.92;
      Object.assign(d, { se, haveSharpe: n.sharpe, needSharpe: 1.96 * se });
      d.needYears = n.sharpe > 0 && n.years ? n.years * (1.96 * se / n.sharpe) ** 2 : null;
      d.haveYears = n.years ?? null;
    } else if (g.id === 'dsr') {
      Object.assign(d, { haveDsr: n.dsr ?? null, needDsr: 0.95, trials: n.trials ?? null, sr0: n.sr0 ?? null });
    } else if (g.id === 'len') {
      Object.assign(d, { haveYears: n.years ?? null, needYears: 1 });
    }
    out.push(d);
  }
  return out;
}
