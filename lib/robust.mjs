// 回测稳健性分析：只用这个回测已经存好的结果文件（权益曲线、基准、订单事件），不重跑 LEAN、不联网。
// 全部是纯函数（analyzeRobust），文件读取和缓存在 loadRobust。口径和 lib/stats.mjs 一致：
// 每个交易日一个点（同一天多个点取最后一个）、日收益、夏普 = 均值/标准差 × √252、无风险利率 0。
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { series, byDay, isMarketDay } from './stats.mjs';

const SQ252 = Math.sqrt(252);
export const COST_BPS = [5, 10, 25, 50];
export const MIN_REGIME_DAYS = 60;
const MA_DAYS = 200;
const VOL_DAYS = 20;
const VOL_BASE = 252;
const MAX_BPS = 200;

/* ---------- 读取：series / byDay 直接用 stats.mjs 的（同一套规则） ---------- */
const EN = (lang) => lang === 'en';
const iso = (d) => new Date(d * 86400000).toISOString().slice(0, 10);

/* ---------- 小工具 ---------- */
function mean(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s / a.length; }
function sd(a) { const m = mean(a); let v = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - m; v += d * d; } return Math.sqrt(v / (a.length - 1)); }
// 方差为 0 时夏普记 0（和 stats.mjs 一致）；少于 2 个点没法算，返回 null
export const sharpeOf = (r) => { if (r.length < 2) return null; const s = sd(r); return s > 1e-12 ? (mean(r) / s) * SQ252 : 0; };
export const compound = (r) => r.reduce((a, x) => a * (1 + x), 1) - 1;
export const annualize = (total, n) => (n > 0 ? (total <= -1 ? -1 : (1 + total) ** (252 / n) - 1) : null);
function maxDrawdown(r) {
  let path_ = 1; let peak = 1; let dd = 0;
  for (const x of r) { path_ *= 1 + x; if (path_ > peak) peak = path_; dd = Math.max(dd, 1 - path_ / peak); }
  return dd;
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sh2 = (x) => (x == null || !Number.isFinite(x) ? '—' : `${x < 0 ? '−' : ''}${Math.abs(x).toFixed(2)}`);
const pct = (x, d = 1) => (x == null || !Number.isFinite(x) ? '—' : `${x < 0 ? '−' : ''}${Math.abs(x * 100).toFixed(d)}%`);

/* ---------- 日频序列 ---------- */
// 策略：每个交易日一个权益值；节假日（基准和前一天完全一样）去掉。ben 与 days 对齐，没有基准的日子是 null。
export function prepare(result) {
  const eqM = byDay(series(result, 'Strategy Equity', 'Equity').filter((p) => p[1] > 0));
  const bmM = byDay(series(result, 'Benchmark', 'Benchmark').filter((p) => p[1] > 0));
  const days = [...eqM.keys()].sort((a, b) => a - b).filter((d, i) => i === 0 || isMarketDay(d)); // 和 stats.mjs 同一个规则
  const eq = days.map((d) => eqM.get(d));
  const ben = days.map((d) => (bmM.has(d) ? bmM.get(d) : null));
  const r = []; const br = []; const rDay = []; const rIdx = [];
  for (let i = 1; i < days.length; i++) {
    r.push(eq[i] / eq[i - 1] - 1);
    br.push(ben[i] != null && ben[i - 1] != null ? ben[i] / ben[i - 1] - 1 : null);
    rDay.push(days[i]); rIdx.push(i);
  }
  // 基准自己的交易日序列（用来分市场状态），同样按日历去掉休市日
  const bd = []; const bc = [];
  for (const d of [...bmM.keys()].sort((a, b) => a - b)) {
    if (bc.length && !isMarketDay(d)) continue;
    bd.push(d); bc.push(bmM.get(d));
  }
  return { days, eq, ben, r, br, rDay, rIdx, bd, bc, hasBench: br.some((x) => x != null) };
}

/* ---------- 1. 分段稳定性 ---------- */
function segMetrics(r, br, hasBench) {
  const total = compound(r);
  const out = { days: r.length, ret: total, sharpe: sharpeOf(r), maxDd: maxDrawdown(r), benchRet: null, excess: null };
  if (hasBench) {
    const b = br.filter((x) => x != null);
    if (b.length) { out.benchRet = compound(b); out.excess = total - out.benchRet; }
  }
  return out;
}
export function segments(P, lang = 'zh') {
  const { r, br, rDay, hasBench } = P;
  const n = r.length;
  const years = [];
  if (n) {
    let start = 0;
    for (let k = 1; k <= n; k++) {
      if (k === n || new Date(rDay[k] * 86400000).getUTCFullYear() !== new Date(rDay[start] * 86400000).getUTCFullYear()) {
        const m = segMetrics(r.slice(start, k), br.slice(start, k), hasBench);
        years.push({ label: String(new Date(rDay[start] * 86400000).getUTCFullYear()), start: iso(rDay[start]), end: iso(rDay[k - 1]), partial: m.days < 200, ...m });
        start = k;
      }
    }
  }
  const thirds = [];
  if (n >= 3) {
    for (let i = 0; i < 3; i++) {
      const a = Math.floor((i * n) / 3); const b = Math.floor(((i + 1) * n) / 3);
      thirds.push({ label: EN(lang) ? `Part ${i + 1}` : `第 ${i + 1} 段`, start: iso(rDay[a]), end: iso(rDay[b - 1]), partial: false, ...segMetrics(r.slice(a, b), br.slice(a, b), hasBench) });
    }
  }
  // 汇总
  const withEx = years.filter((y) => y.excess != null);
  const full = years.filter((y) => !y.partial);
  const pool = full.length ? full : years;
  const worst = pool.length ? pool.reduce((a, y) => (y.ret < a.ret ? y : a)) : null;
  const logs = years.map((y) => (y.ret > -1 ? Math.log(1 + y.ret) : -Infinity));
  const totalLog = logs.reduce((s, x) => s + x, 0);
  let concentration = { applicable: false, flag: false, year: null, share: null };
  if (years.length >= 2 && Number.isFinite(totalLog) && totalLog > 0) {
    let bi = 0; logs.forEach((x, i) => { if (x > logs[bi]) bi = i; });
    const share = logs[bi] / totalLog;
    concentration = { applicable: true, flag: share > 0.5, year: years[bi].label, share };
  }
  return {
    years, thirds,
    summary: {
      yearCount: years.length,
      positiveShare: years.length ? years.filter((y) => y.ret > 0).length / years.length : null,
      beatShare: withEx.length ? withEx.filter((y) => y.excess > 0).length / withEx.length : null,
      beatCount: withEx.filter((y) => y.excess > 0).length, // 跑赢基准的年数；benchYears 是有基准数据的年数
      benchYears: withEx.length,
      worst: worst ? { label: worst.label, ret: worst.ret } : null,
      concentration,
    },
  };
}

/* ---------- 2. 成本压力 ---------- */
// 成交 → [{ t(秒), value(成交额，正数) }]。优先用订单事件；没有事件文件时退回结果里的 orders。
export function fillsFrom(events, result) {
  const fills = [];
  if (Array.isArray(events)) {
    for (const e of events) {
      if (!e || !/^(filled|partiallyfilled)$/i.test(String(e.status || ''))) continue;
      const q = Math.abs(+e.fillQuantity); const px = +e.fillPrice; let t = +e.time;
      if (!(q > 0) || !(px > 0) || !Number.isFinite(t)) continue;
      if (t > 1e12) t /= 1000;
      fills.push({ t, value: q * px, fee: Number.isFinite(+e.orderFeeAmount) && /usd/i.test(String(e.orderFeeCurrency || 'USD')) ? +e.orderFeeAmount : 0 });
    }
    return { fills, source: 'events' };
  }
  const o = result && result.orders;
  const list = Array.isArray(o) ? o : o && typeof o === 'object' ? Object.values(o) : [];
  for (const x of list) {
    if (!x || (x.status !== 2 && x.status !== 3)) continue;
    const q = Math.abs(+x.quantity); const px = +x.price; const t = Date.parse(x.lastFillTime || x.time) / 1000;
    if (q > 0 && px > 0 && Number.isFinite(t)) fills.push({ t, value: q * px, fee: 0 });
  }
  return { fills, source: list.length ? 'orders' : 'none' };
}
const parseMoney = (s) => { const m = String(s == null ? '' : s).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? +m[0] : null; };

export function costs(P, fills, result) {
  const { days, eq, r, br, hasBench } = P;
  const n = r.length;
  const turn = new Array(n).fill(0);
  let traded = 0; let dropped = 0;
  for (const f of fills) {
    let d = Math.floor((f.t - 6 * 3600) / 86400);
    // 找到不晚于成交日的最后一个交易日；成交在第一个点之前或当天，算到第一个有收益的日子
    let lo = 0; let hi = days.length - 1; let idx = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (days[mid] <= d) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
    if (idx < 0 || !days.length) { idx = 1; }
    idx = Math.min(Math.max(idx, 1), days.length - 1);
    if (n === 0 || d > days[days.length - 1] + 5) { dropped++; continue; }
    turn[idx - 1] += f.value / eq[idx];
    traded += f.value;
  }
  const hasTrades = traded > 0;
  const yrs = n / 252;
  const adj = (c) => r.map((x, k) => x - (c / 1e4) * turn[k]);
  const metricsAt = (c) => {
    const a = adj(c);
    const annReturn = annualize(compound(a), n);
    const b = br.filter((x) => x != null);
    const annBench = hasBench && b.length ? annualize(compound(b), b.length) : null;
    // 超额只在两边都有数据的那些天上比：基准只覆盖一部分时间时，不能拿策略全程的年化去减基准那一段的年化
    const common = b.length === n ? a : a.filter((_, k) => br[k] != null);
    const annOnBench = annBench == null ? null : annualize(compound(common), common.length);
    return { bps: c, annReturn, sharpe: sharpeOf(a), annExcess: annBench == null || annOnBench == null ? null : annOnBench - annBench, annBench };
  };
  const rows = [0, ...COST_BPS].map(metricsAt);
  // 临界成本：二分法，在 0–200 个基点内找年化超额（或年化收益）降到 0 的位置
  const solve = (key) => {
    if (!n) return { status: 'na', bps: null };
    const f = (c) => metricsAt(c)[key];
    const f0 = f(0);
    if (f0 == null) return { status: 'na', bps: null };
    if (!hasTrades) return { status: f0 > 0 ? 'noTrades' : 'already', bps: f0 > 0 ? null : 0 };
    if (f0 <= 0) return { status: 'already', bps: 0 };
    if (f(MAX_BPS) > 0) return { status: 'above', bps: null };
    let lo = 0; let hi = MAX_BPS;
    for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (f(mid) > 0) lo = mid; else hi = mid; }
    return { status: 'cross', bps: (lo + hi) / 2 };
  };
  const stats = (result && result.statistics) || {};
  let fees = parseMoney(stats['Total Fees']);
  const feeSum = fills.reduce((s, f) => s + (f.fee || 0), 0);
  if (fees == null && feeSum > 0) fees = feeSum;
  return {
    available: n > 0,
    hasTrades,
    tradeDays: turn.filter((x) => x > 0).length,
    tradedValue: traded,
    annTurnover: yrs > 0 ? turn.reduce((s, x) => s + x, 0) / yrs : null,
    droppedFills: dropped,
    fees,
    feesBps: fees != null && traded > 0 ? (fees / traded) * 1e4 : null,
    rows,
    breakEven: hasBench ? solve('annExcess') : null,
    breakEvenAbs: solve('annReturn'),
    benchAnn: rows[0].annBench,
  };
}

/* ---------- 3. 市场状态 ---------- */
// 标签 labels[j]：用基准到第 j 天（含）为止的收盘价算出来的状态，只含这一天及以前的信息。
//   trend: 收盘 > 自己的 200 日均线 → up，否则 down
//   vol:   最近 20 日已实现波动 > 它自己最近 252 个值的中位数 → high，否则 low
export function regimeLabels(bc) {
  const n = bc.length;
  const labels = new Array(n).fill(null);
  const ret = new Array(n).fill(null);
  for (let j = 1; j < n; j++) ret[j] = bc[j] / bc[j - 1] - 1;
  const vol = new Array(n).fill(null);
  for (let j = VOL_DAYS; j < n; j++) vol[j] = sd(ret.slice(j - VOL_DAYS + 1, j + 1));
  // 最近 VOL_BASE 个波动值的中位数：维护一个有序窗口（二分插入 / 删除），不再每天把 252 个数重新排序。
  // O(n·log w) 次比较 + O(n·w) 次搬移，取代 O(n·w·log w)；中位数的值和原来逐日排序完全一样。
  const win = [];
  const lowerBound = (x) => { let lo = 0; let hi = win.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (win[mid] < x) lo = mid + 1; else hi = mid; } return lo; };
  const first = VOL_DAYS + VOL_BASE - 1;
  let sum = 0;
  for (let j = 0; j < n; j++) {
    sum += bc[j];
    if (j >= MA_DAYS) sum -= bc[j - MA_DAYS];
    if (j >= VOL_DAYS) {
      win.splice(lowerBound(vol[j]), 0, vol[j]);
      if (j - VOL_BASE >= VOL_DAYS) win.splice(lowerBound(vol[j - VOL_BASE]), 1);
    }
    if (j < MA_DAYS - 1 || j < first) continue;
    const m = win.length >> 1;
    const med = win.length % 2 ? win[m] : (win[m - 1] + win[m]) / 2;
    labels[j] = { trend: bc[j] > sum / MA_DAYS ? 'up' : 'down', vol: vol[j] > med ? 'high' : 'low' };
  }
  return labels;
}
const TREND_ZH = { up: '上升趋势', down: '下降趋势' };
const VOL_ZH = { low: '低波动', high: '高波动' };
const TREND_EN = { up: 'Uptrend', down: 'Downtrend' };
const VOL_EN = { low: 'low volatility', high: 'high volatility' };

export function regimes(P, lang = 'zh') {
  const { r, br, rDay, bd, bc, hasBench } = P;
  const en = EN(lang);
  const tL = (t) => (en ? TREND_EN[t] : TREND_ZH[t]); const vL = (v) => (en ? VOL_EN[v] : VOL_ZH[v]);
  if (!hasBench || bc.length < 2) return { available: false, reason: en ? 'No benchmark data, so market regimes cannot be split.' : '没有基准数据，没法划分市场状态。', cells: [], marginals: [], classified: 0, unclassified: r.length };
  const labels = regimeLabels(bc);
  // 第 k 个收益发生在 rDay[k] 这一天；它的标签取基准上严格早于这一天的最后一个交易日
  const lab = new Array(r.length).fill(null);
  let j = -1;
  for (let k = 0; k < r.length; k++) {
    while (j + 1 < bd.length && bd[j + 1] < rDay[k]) j++;
    lab[k] = j >= 0 ? labels[j] : null;
  }
  const stat = (pick) => {
    const ks = []; for (let k = 0; k < r.length; k++) if (lab[k] && pick(lab[k])) ks.push(k);
    const days = ks.length;
    if (days < MIN_REGIME_DAYS) return { days, small: true, annReturn: null, benchAnn: null, sharpe: null };
    const sr = ks.map((k) => r[k]); const b = ks.map((k) => br[k]).filter((x) => x != null);
    return { days, small: false, annReturn: annualize(compound(sr), days), benchAnn: b.length ? annualize(compound(b), b.length) : null, sharpe: sharpeOf(sr) };
  };
  const cells = [];
  for (const t of ['up', 'down']) for (const v of ['low', 'high']) cells.push({ trend: t, vol: v, label: `${tL(t)} · ${vL(v)}`, ...stat((l) => l.trend === t && l.vol === v) });
  const marginals = [
    ...['up', 'down'].map((t) => ({ dim: en ? 'Trend' : '趋势', value: t, label: tL(t), ...stat((l) => l.trend === t) })),
    ...['low', 'high'].map((v) => ({ dim: en ? 'Volatility' : '波动', value: v, label: vL(v), ...stat((l) => l.vol === v) })),
  ];
  const classified = lab.filter(Boolean).length;
  return { available: true, classified, unclassified: r.length - classified, cells, marginals, minDays: MIN_REGIME_DAYS, rule: en ? `Trend: prior-day benchmark close vs its own ${MA_DAYS}-day moving average; volatility: prior ${VOL_DAYS}-day realized volatility vs the median of its own last ${VOL_BASE} days` : `趋势：前一日基准收盘 vs 它的 ${MA_DAYS} 日均线；波动：前 ${VOL_DAYS} 日已实现波动 vs 它自己近 ${VOL_BASE} 日的中位数` };
}

/* ---------- 4. 一句话结论（固定规则，没有模型） ---------- */
function breakEvenText(c, lang = 'zh') {
  const be = c.breakEven || c.breakEvenAbs;
  if (!be) return null;
  if (EN(lang)) {
    const w = c.breakEven ? 'excess return' : 'return';
    if (be.status === 'noTrades') return 'There were almost no fills, so costs barely affect the result';
    if (be.status === 'above') return `Even with ${MAX_BPS} bps of extra cost per fill, annualized ${w} stays positive`;
    if (be.status === 'already') return c.breakEven ? 'Even with no extra cost, the annualized return does not beat the benchmark' : 'Even with no extra cost, the annualized return is not positive';
    if (be.status === 'cross') return `Paying about ${be.bps.toFixed(0)} bps extra per fill takes annualized ${w} to zero`;
    return null;
  }
  const what = c.breakEven ? '超额收益' : '收益';
  if (be.status === 'noTrades') return '这次几乎没有成交，成本基本不影响结果';
  if (be.status === 'above') return `成交成本再加到 ${MAX_BPS} 个基点，${what}仍为正`;
  if (be.status === 'already') return c.breakEven ? '连额外成本都没加，年化就没跑赢基准' : '连额外成本都没加，年化收益就不为正';
  if (be.status === 'cross') return `每笔成交额外多付约 ${be.bps.toFixed(0)} 个基点，年化${what}就归零`;
  return null;
}
export function conclude({ period, years, seg, c, reg, lang = 'zh' }) {
  if (EN(lang)) return concludeEn({ period, years, seg, c, reg });
  const short = period === 'holdout' || years < 3;
  const reason = period === 'holdout' && years < 3 ? `这是验证期的回测，只有 ${years.toFixed(1)} 年` : period === 'holdout' ? '这是验证期的回测' : `回测只有 ${years.toFixed(1)} 年，不到 3 年`;
  const be = breakEvenText(c);
  if (short) return { short: true, reason, text: `${reason}，分段和市场状态的样本太短，只能参考，说明不了什么。${be ? `${be}。` : ''}` };
  const parts = [];
  const cc = seg.summary.concentration;
  if (cc.flag) parts.push(`收益过度依赖 ${cc.year} 年（占全部对数收益的 ${(cc.share * 100).toFixed(0)}%）`);
  else if (seg.summary.yearCount) {
    const s = seg.summary; const pos = Math.round(s.positiveShare * s.yearCount);
    parts.push(`${s.yearCount} 年里 ${pos} 年为正${s.beatShare != null ? `、${s.beatCount ?? Math.round(s.beatShare * s.yearCount)} 年跑赢基准${s.benchYears != null && s.benchYears < s.yearCount ? `（只有 ${s.benchYears} 年有基准数据）` : ''}` : ''}，没有只靠某一年`);
  }
  const ok = (reg.cells || []).filter((x) => !x.small);
  if (reg.available && ok.length >= 2) {
    const best = ok.reduce((a, x) => (x.annReturn > a.annReturn ? x : a)); const worstC = ok.reduce((a, x) => (x.annReturn < a.annReturn ? x : a));
    parts.push(`赚钱主要在「${best.label}」（年化 ${pct(best.annReturn)}），「${worstC.label}」最弱（${pct(worstC.annReturn)}）`);
  } else if (reg.available) parts.push('市场状态里样本够的格子不到两个，看不出在哪种行情赚钱');
  if (be) parts.push(be);
  return { short: false, reason: null, text: `${parts.join('；')}。只反映这一段历史。` };
}

function concludeEn({ period, years, seg, c, reg }) {
  const short = period === 'holdout' || years < 3;
  const reason = period === 'holdout' && years < 3 ? `This is a holdout-period backtest and only ${years.toFixed(1)} years long` : period === 'holdout' ? 'This is a holdout-period backtest' : `The backtest is only ${years.toFixed(1)} years long, under 3 years`;
  const be = breakEvenText(c, 'en');
  if (short) return { short: true, reason, text: `${reason}, so the sub-period and regime samples are too short to read much into.${be ? ` ${be}.` : ''}` };
  const parts = [];
  const cc = seg.summary.concentration;
  if (cc.flag) parts.push(`Returns lean too heavily on ${cc.year} (${(cc.share * 100).toFixed(0)}% of total log return)`);
  else if (seg.summary.yearCount) {
    const s = seg.summary; const pos = Math.round(s.positiveShare * s.yearCount);
    parts.push(`${pos} of ${s.yearCount} years positive${s.beatShare != null ? `, ${s.beatCount ?? Math.round(s.beatShare * s.yearCount)} beat the benchmark${s.benchYears != null && s.benchYears < s.yearCount ? ` (benchmark data for only ${s.benchYears} years)` : ''}` : ''}, so it does not hinge on a single year`);
  }
  const ok = (reg.cells || []).filter((x) => !x.small);
  if (reg.available && ok.length >= 2) {
    const best = ok.reduce((a, x) => (x.annReturn > a.annReturn ? x : a)); const worstC = ok.reduce((a, x) => (x.annReturn < a.annReturn ? x : a));
    parts.push(`Most of the profit comes in "${best.label}" (${pct(best.annReturn)} annualized), and "${worstC.label}" is weakest (${pct(worstC.annReturn)})`);
  } else if (reg.available) parts.push('Fewer than two regime cells have enough samples, so it is unclear which market regime pays');
  if (be) parts.push(be);
  return { short: false, reason: null, text: `${((x) => x.charAt(0).toUpperCase() + x.slice(1))(parts.map((x) => x.charAt(0).toLowerCase() + x.slice(1)).join('; '))}. This reflects this historical period only.` };
}

/* ---------- 汇总 ---------- */
export function analyzeRobust(result, events, { period = null, lang = 'zh' } = {}) {
  const en = EN(lang);
  const P = prepare(result || {});
  const notes = [];
  const years = P.r.length / 252;
  if (P.r.length < 2) {
    return { segments: { years: [], thirds: [], summary: { yearCount: 0, positiveShare: null, beatShare: null, worst: null, concentration: { applicable: false, flag: false, year: null, share: null } } }, costs: { available: false, rows: [], breakEven: null, breakEvenAbs: null }, regimes: { available: false, reason: en ? 'The equity curve is too short.' : '权益曲线太短。', cells: [], marginals: [], classified: 0, unclassified: 0 }, summary: { text: en ? 'The equity curve is too short (under 2 trading days) for a robustness analysis.' : '权益曲线太短（少于 2 个交易日），没法做稳健性分析。', short: true, reason: en ? 'Data too short' : '数据太短', days: P.r.length, years, start: null, end: null, period }, notes: [en ? 'The equity curve is too short.' : '权益曲线太短。'] };
  }
  const seg = segments(P, lang);
  const { fills, source } = fillsFrom(events, result);
  const c = costs(P, fills, result);
  const reg = regimes(P, lang);
  if (!P.hasBench) notes.push(en ? 'This backtest has no benchmark data: excess return, break-even cost (vs the benchmark) and market regimes are skipped.' : '这个回测没有基准数据：超额收益、临界成本（相对基准）和市场状态都跳过。');
  if (!fills.length) notes.push(en ? 'No fills recorded; treated as no trading (turnover 0, so cost stress changes nothing).' : '没有成交记录，按没有交易处理（换手 0，成本压力不改变结果）。');
  if (source === 'orders') notes.push(en ? 'No order-events file found; turnover is estimated from the orders in the result instead.' : '没找到订单事件文件，换手改用结果里的订单估算。');
  if (c.droppedFills) notes.push(en ? `${c.droppedFills} fills came after the end of the equity curve and were not counted.` : `${c.droppedFills} 笔成交晚于权益曲线末尾，没计入。`);
  if (reg.available && reg.unclassified) notes.push(en ? `The benchmark history was too short to classify the first ${reg.unclassified} trading days; they are excluded (unclassified).` : `前 ${reg.unclassified} 个交易日基准历史不够长，没法分类，已排除（未分类）。`);
  const summary = { ...conclude({ period, years, seg, c, reg, lang }), days: P.r.length, years, start: iso(P.rDay[0]), end: iso(P.rDay[P.rDay.length - 1]), period };
  return { segments: seg, costs: c, regimes: reg, summary, notes };
}

/* ---------- 读文件 + 缓存（按回测 + 文件修改时间） ---------- */
const CACHE = new Map();
async function mtime(f) { try { return (await stat(f)).mtimeMs; } catch { return null; } }
async function json(f) { try { return JSON.parse(await readFile(f, 'utf8')); } catch { return null; } }

export async function loadRobust(projectsDir, projectId, backtestId, lang = 'zh') {
  const pid = Number(projectId);
  const bid = String(backtestId || '').replace(/[^a-f0-9]/g, '');
  if (!Number.isSafeInteger(pid) || pid <= 0 || !bid) return { success: false, errors: ['projectId 或 backtestId 不对'] };
  const dir = path.join(projectsDir, String(pid), 'backtests', bid);
  const fRes = path.join(dir, 'out', `${bid}.json`);
  const fEv = path.join(dir, 'out', `${bid}-order-events.json`);
  const fMeta = path.join(dir, 'meta.json');
  const mt = await mtime(fRes);
  if (mt == null) return { success: false, errors: ['这个回测还没有结果文件（没跑完或运行失败）'] };
  const key = `${pid}/${bid}/${EN(lang) ? 'en' : 'zh'}`; const sig = `${mt}|${await mtime(fEv)}|${await mtime(fMeta)}`;
  const hit = CACHE.get(key);
  if (hit && hit.sig === sig) return { success: true, robust: hit.robust };
  const result = await json(fRes);
  if (!result) return { success: false, errors: ['回测结果文件读不出来'] };
  const meta = await json(fMeta);
  const events = await json(fEv);
  const robust = analyzeRobust(result, Array.isArray(events) ? events : null, { period: meta && meta.period, lang });
  if (CACHE.size > 60) CACHE.delete(CACHE.keys().next().value);
  CACHE.set(key, { sig, robust });
  return { success: true, robust };
}

/* ---------- 给 MCP 工具的文字版（数字和网页是同一份） ---------- */
function robustTextEn(R) {
  const L = [`Conclusion: ${R.summary.text}`];
  const S = R.segments;
  const row = (y) => `${y.label} (${y.start} to ${y.end}, ${y.days} days${y.partial ? ', partial year' : ''}) return ${pct(y.ret)}, Sharpe ${sh2(y.sharpe)}, max drawdown ${pct(y.maxDd)}${y.excess == null ? '' : `, excess ${pct(y.excess)}`}`;
  if (S.years.length) {
    L.push('[Sub-period stability · by year]', ...S.years.map(row), '[By thirds]', ...S.thirds.map(row));
    const s = S.summary;
    L.push(`Positive years: ${pct(s.positiveShare, 0)}${s.beatShare == null ? '' : `, years beating the benchmark: ${pct(s.beatShare, 0)}`}${s.worst ? `, worst ${s.worst.label}: ${pct(s.worst.ret)}` : ''}${s.concentration.flag ? `, WARNING: ${s.concentration.year} accounts for ${pct(s.concentration.share, 0)} of total log return` : ''}`);
  }
  const c = R.costs;
  if (c.available) {
    L.push(`[Cost stress] (turnover estimated from traded value) annual turnover ${c.annTurnover == null ? '—' : `${(c.annTurnover * 100).toFixed(0)}%`}, traded on ${c.tradeDays} days${c.fees == null ? '' : `, fees paid $${c.fees.toFixed(2)}`}`);
    for (const x of c.rows) L.push(`Extra ${x.bps} bps: annualized ${pct(x.annReturn)}, Sharpe ${sh2(x.sharpe)}${x.annExcess == null ? '' : `, annualized excess ${pct(x.annExcess)}`}`);
    const t = breakEvenText(c, 'en'); if (t) L.push(t);
  }
  const G = R.regimes;
  if (G.available) {
    L.push(`[Market regimes] ${G.rule}; unclassified ${G.unclassified} days`);
    for (const x of [...G.cells, ...G.marginals]) L.push(`${x.label}: ${x.days} days${x.small ? ', too few samples (under 60 days)' : `, strategy annualized ${pct(x.annReturn)}, benchmark annualized ${pct(x.benchAnn)}, Sharpe ${sh2(x.sharpe)}`}`);
  } else L.push(`[Market regimes] ${G.reason}`);
  for (const n of R.notes) L.push(`Note: ${n}`);
  return L.join('\n');
}
export function robustText(R, lang = 'zh') {
  if (EN(lang)) return robustTextEn(R);
  const L = [`结论：${R.summary.text}`];
  const S = R.segments;
  const row = (y) => `${y.label}（${y.start}～${y.end}，${y.days} 天${y.partial ? '，不足整年' : ''}）收益 ${pct(y.ret)}，夏普 ${sh2(y.sharpe)}，最大回撤 ${pct(y.maxDd)}${y.excess == null ? '' : `，超额 ${pct(y.excess)}`}`;
  if (S.years.length) {
    L.push('【分段稳定性·按年】', ...S.years.map(row), '【按三等份】', ...S.thirds.map(row));
    const s = S.summary;
    L.push(`为正的年份占 ${pct(s.positiveShare, 0)}${s.beatShare == null ? '' : `，跑赢基准的年份占 ${pct(s.beatShare, 0)}`}${s.worst ? `，最差 ${s.worst.label} 年 ${pct(s.worst.ret)}` : ''}${s.concentration.flag ? `，⚠ ${s.concentration.year} 年占总对数收益 ${pct(s.concentration.share, 0)}` : ''}`);
  }
  const c = R.costs;
  if (c.available) {
    L.push(`【成本压力】（换手由成交额估算）年化换手 ${c.annTurnover == null ? '—' : `${(c.annTurnover * 100).toFixed(0)}%`}，成交 ${c.tradeDays} 天${c.fees == null ? '' : `，已付手续费 $${c.fees.toFixed(2)}`}`);
    for (const x of c.rows) L.push(`额外 ${x.bps} 个基点：年化 ${pct(x.annReturn)}，夏普 ${sh2(x.sharpe)}${x.annExcess == null ? '' : `，年化超额 ${pct(x.annExcess)}`}`);
    const t = breakEvenText(c); if (t) L.push(t);
  }
  const G = R.regimes;
  if (G.available) {
    L.push(`【市场状态】${G.rule}；未分类 ${G.unclassified} 天`);
    for (const x of [...G.cells, ...G.marginals]) L.push(`${x.label}：${x.days} 天${x.small ? '，样本太少（不足 60 天）' : `，策略年化 ${pct(x.annReturn)}，基准年化 ${pct(x.benchAnn)}，夏普 ${sh2(x.sharpe)}`}`);
  } else L.push(`【市场状态】${G.reason}`);
  for (const n of R.notes) L.push(`注：${n}`);
  return L.join('\n');
}

/* ---------- 参数敏感性：纯函数（发现参数、生成变体、判定） ---------- */
export const SENS_MAX_PARAMS = 6;
export const SENS_WARNING = '这些重跑只是诊断。挑出“看起来最好”的那个变体并采用，就是调参：必须把它当作一次新的回测重新跑，并计入尝试次数。';
const NUM_LIT = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?';
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

/** 静态找 self.get_parameter("名字", 数字) / GetParameter：返回 { params: [{name, default, isInt}], skipped: [{name, reason}] } */
export function discoverParams(code) {
  const src = String(code || '').split('\n').map((l) => l.replace(/(^|\s)#.*$/, '$1')).join('\n');
  const params = []; const skipped = []; const seen = new Map();
  const re = /\bself\s*\.\s*(?:get_parameter|GetParameter)\s*\(\s*(["'])([^"'\n]{1,60})\1\s*([,)])/g;
  const lit = new RegExp(`^\\s*(${NUM_LIT})\\s*\\)`);
  let m;
  while ((m = re.exec(src))) {
    const name = m[2];
    let def = null; let isInt = false; let why = null;
    if (m[3] === ')') why = '没有默认值';
    else {
      const t = src.slice(re.lastIndex, re.lastIndex + 80).match(lit);
      if (!t) why = '默认值不是数字常量';
      else { def = Number(t[1]); isInt = !/[.eE]/.test(t[1]); if (!Number.isFinite(def)) why = '默认值不是数字常量'; }
    }
    if (!why && !PARAM_NAME.test(name)) why = '名字只能用字母、数字、下划线';
    if (why) { if (!skipped.some((s) => s.name === name)) skipped.push({ name, reason: why }); continue; }
    const prev = seen.get(name);
    if (prev) {
      if (prev.default !== def && !skipped.some((s) => s.name === name)) skipped.push({ name, reason: '同名参数出现多次且默认值不同' });
      continue;
    }
    seen.set(name, { name, default: def, isInt });
  }
  for (const p of seen.values()) if (!skipped.some((s) => s.name === p.name)) params.push(p);
  return { params, skipped };
}

/** 默认值 ×0.8 与 ×1.2。整数四舍五入，且至少差 1；整数原本为正（负）时不允许变成 ≤0（≥0）；跑不了的返回 null */
export function variantValues(def, isInt) {
  if (!Number.isFinite(def) || def === 0) return { lo: null, hi: null };
  const make = (f) => {
    if (!isInt) return Number((def * f).toPrecision(10));
    let v = Math.round(def * f);
    if (v === def) v = def + (f < 1 ? -1 : 1) * Math.sign(def);
    return v === 0 ? 0 : v;
  };
  const fix = (v) => (isInt && (v === 0 || Math.sign(v) !== Math.sign(def)) ? null : v);
  return { lo: fix(make(0.8)), hi: fix(make(1.2)) };
}

/** 要跑的变体清单（每个参数最多两个）：[{id, name, which, factor, value}] */
export function sensitivityPlan(params) {
  const out = [];
  params.forEach((p, i) => {
    const v = variantValues(p.default, p.isInt);
    if (v.lo != null) out.push({ id: `p${i + 1}_lo`, name: p.name, which: 'lo', factor: 0.8, value: v.lo });
    if (v.hi != null) out.push({ id: `p${i + 1}_hi`, name: p.name, which: 'hi', factor: 1.2, value: v.hi });
  });
  return out;
}

/** 单个参数的判定。variants：[{sharpe}]（跑失败的 sharpe 为 null）。规则固定、只描述，不排名 */
export function sensitivityVerdict(baseSharpe, variants) {
  const vs = variants || [];
  if (!Number.isFinite(baseSharpe) || !vs.length) return { verdict: null, reason: '没有可比较的结果' };
  const ok = vs.filter((v) => Number.isFinite(v.sharpe));
  const flip = ok.find((v) => baseSharpe * v.sharpe < 0);
  if (flip) return { verdict: '方向翻转', reason: '有一个变体的夏普正负号和原来相反' };
  if (ok.length < vs.length) return { verdict: null, reason: '有变体没跑成功，无法判断' };
  const band = Math.abs(baseSharpe) < 0.5 ? 0.15 : 0.3 * Math.abs(baseSharpe);
  const bad = ok.find((v) => !(baseSharpe * v.sharpe > 0 || (baseSharpe === 0 && v.sharpe === 0)) || Math.abs(v.sharpe - baseSharpe) > band + 1e-12);
  if (bad) return { verdict: '敏感', reason: `夏普变化超出允许范围（${Math.abs(baseSharpe) < 0.5 ? '±0.15' : '±30%'}）` };
  return { verdict: '稳', reason: `两个变体的夏普方向不变、都在${Math.abs(baseSharpe) < 0.5 ? '±0.15' : '±30%'}以内` };
}

/** 一句话结论：rows = [{name, verdict}] */
export function sensitivityConclusion(rows) {
  const judged = rows.filter((r) => r.verdict);
  const unk = rows.length - judged.length;
  const tail = unk ? `（另有 ${unk} 个参数没跑成功，没法判断）` : '';
  if (!judged.length) return `没有可判断的参数${tail}。`;
  const flips = judged.filter((r) => r.verdict === '方向翻转');
  const sens = judged.filter((r) => r.verdict !== '稳');
  if (!sens.length) return `${judged.length} 个参数各微调 ±20% 后，夏普方向不变、变化不大：结果对这些参数不敏感${tail}。`;
  return `${sens.length} 个参数（${sens.map((r) => r.name).join('、')}）微调 ±20% 后夏普明显变化${flips.length ? `，其中 ${flips.map((r) => r.name).join('、')} 的夏普方向翻转` : ''}：原来的表现可能依赖这些参数的具体取值${tail}。`;
}
