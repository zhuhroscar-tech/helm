// 模拟实盘「是否在预期内」：用来源回测的日收益做块自助法，看冻结后 n 个交易日的累计收益落在哪个位置。
// 只检验“和回测是否一致”，不证明策略有效。纯函数 + 一个只读加载器，不写任何文件。
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { prepare } from './robust.mjs';
import { mulberry32 } from './stats.mjs';

export const MIN_DAYS = 20;   // 少于这么多个交易日不下结论
export const BLOCK = 10;      // 平均块长（交易日）
export const DRAWS = 5000;
export const SEED = 20261111;

export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const x = (sorted.length - 1) * q;
  const lo = Math.floor(x); const hi = Math.ceil(x);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (x - lo);
}

export function maxDrawdownOfReturns(r) {
  let v = 1; let peak = 1; let dd = 0;
  for (const x of r) { v *= 1 + x; if (v > peak) peak = v; dd = Math.max(dd, 1 - v / peak); }
  return dd;
}
export function maxDrawdownOfLevels(levels) {
  let peak = -Infinity; let dd = 0;
  for (const v of levels) { if (v > peak) peak = v; if (peak > 0) dd = Math.max(dd, 1 - v / peak); }
  return dd;
}

// 平稳（几何块长）循环块自助法：每一步以 1/block 的概率跳到随机起点，否则接着上一天（到头绕回开头）。
export function bootstrapBand(returns, n, { block = BLOCK, draws = DRAWS, seed = SEED } = {}) {
  const r = (returns || []).filter((x) => Number.isFinite(x));
  if (!r.length || !(n >= 1)) return null;
  const len = r.length; const p = 1 / block;
  const rnd = mulberry32(seed);
  const out = new Float64Array(draws);
  for (let d = 0; d < draws; d++) {
    let i = Math.floor(rnd() * len); let v = 1;
    for (let k = 0; k < n; k++) {
      if (k > 0) i = rnd() < p ? Math.floor(rnd() * len) : (i + 1) % len;
      v *= 1 + r[i];
    }
    out[d] = v - 1;
  }
  const sorted = Array.from(out).sort((a, b) => a - b);
  const band = { p5: quantile(sorted, 0.05), p25: quantile(sorted, 0.25), p50: quantile(sorted, 0.5), p75: quantile(sorted, 0.75), p95: quantile(sorted, 0.95) };
  return { band, sorted };
}

// 百分位：比 r 小的占比 + 一半相等的占比（退化分布时恰好是 50%）
export function percentRank(sorted, r) {
  if (!sorted.length) return null;
  const eps = 1e-12; let below = 0; let equal = 0;
  for (const x of sorted) { if (x < r - eps) below++; else if (x <= r + eps) equal++; }
  return (below + equal / 2) / sorted.length;
}

export const VERDICT_TEXT_EN = {
  early: 'Too early to tell',
  in: 'Within the backtest-expected range',
  low: 'Below the backtest-expected range',
  high: 'Above the backtest-expected range',
};
export const VERDICT_TEXT = {
  early: '太早，还看不出来',
  in: '在回测预期范围内',
  low: '低于回测预期',
  high: '高于回测预期',
};

// 从 latest.json 取冻结后的数据：用权益曲线和基准曲线（log 里第一条权益没有按冻结日重算，不用）
export function forwardFromLatest(latest) {
  const ok = (a) => (Array.isArray(a) ? a : []).filter((p) => Array.isArray(p) && Number.isFinite(+p[1]) && +p[1] > 0);
  const e = ok(latest && latest.equity); const b = ok(latest && latest.benchmark);
  if (e.length < 2) return null;
  const f = { n: e.length - 1, from: e[0][0], to: e[e.length - 1][0], r: +e[e.length - 1][1] / +e[0][1] - 1, dd: maxDrawdownOfLevels(e.map((p) => +p[1])), bench: null, excess: null, benchDays: 0 };
  const bd = new Map(b.map((p) => [p[0], +p[1]]));
  const common = e.filter((p) => bd.has(p[0]));
  if (common.length >= 2) {
    const a = common[0]; const z = common[common.length - 1];
    f.bench = bd.get(z[0]) / bd.get(a[0]) - 1;
    f.excess = (+z[1] / +a[1] - 1) - f.bench;
    f.benchDays = common.length - 1;
  }
  return f;
}

const pc = (x, d = 1) => `${x < 0 ? '−' : ''}${Math.abs(x * 100).toFixed(d)}%`;

// btReturns：来源回测每个交易日一个收益；fwd：forwardFromLatest 的结果
export function assessDrift({ btReturns, fwd, opts, lang = 'zh' }) {
  const en = lang === 'en';
  if (!fwd || !(fwd.n >= 1)) return { available: false, note: en ? 'No new trading days since the freeze, so there is no return to compare yet.' : '冻结后还没有新的交易日，暂时没有可比较的收益。' };
  if (!btReturns || btReturns.length < 30) return { available: false, note: en ? 'The source backtest has too few daily returns (under 30 days) to estimate an expected range.' : '来源回测的日收益太少（不足 30 天），没法估计预期范围。' };
  const bs = bootstrapBand(btReturns, fwd.n, opts);
  const rank = percentRank(bs.sorted, fwd.r);
  const btDd = maxDrawdownOfReturns(btReturns);
  let verdict = 'in';
  if (fwd.n < MIN_DAYS) verdict = 'early';
  else if (rank < 0.05) verdict = 'low';
  else if (rank > 0.95) verdict = 'high';
  const notes = [];
  if (verdict === 'early') notes.push(en ? `Only ${fwd.n} trading days (under ${MIN_DAYS}); the range is very wide, so wherever it lands says little.` : `只有 ${fwd.n} 个交易日（不到 ${MIN_DAYS} 天），范围很宽，落在哪里都说明不了什么。`);
  if (verdict === 'low') notes.push(en ? 'Below 95% of the backtest-based simulations. First check for differences in data and execution (data source, fill prices, slippage, unfilled orders), then judge whether the strategy has lost its edge.' : '低于回测 95% 的模拟结果。先查数据和执行有没有差异（数据源、成交价、滑点、未成交的单），再判断策略的优势是不是没了。');
  if (verdict === 'high') notes.push(en ? 'Above 95% of the backtest-based simulations. Running high is also a deviation: it may be luck, or a gap between the backtest and live conditions, so do not read it as the strategy being better.' : '高于回测 95% 的模拟结果。偏高也是偏离：可能是运气，也可能是回测和实际有差别，不能直接当成策略更好了。');
  if (fwd.dd > btDd && fwd.n >= MIN_DAYS) notes.push(en ? `The max drawdown since the freeze (${pc(fwd.dd)}) already exceeds the backtest's full-period max drawdown (${pc(btDd)}).` : `冻结后的最大回撤 ${pc(fwd.dd)} 已超过回测全程的最大回撤 ${pc(btDd)}。`);
  notes.push(en ? 'This only checks whether live results are consistent with the backtest; it does not prove the strategy works. The fewer the trading days, the less reliable the conclusion.' : '这只检验“和回测是否一致”，不证明策略有效；交易日越少，结论越不可靠。');
  return {
    available: true, n: fwd.n, r: fwd.r, from: fwd.from, to: fwd.to,
    band: bs.band, rank, verdict, verdictText: (en ? VERDICT_TEXT_EN : VERDICT_TEXT)[verdict],
    excess: fwd.excess == null ? null : { bench: fwd.bench, excess: fwd.excess, days: fwd.benchDays },
    dd: { forward: fwd.dd, backtest: btDd },
    method: { block: (opts && opts.block) || BLOCK, draws: (opts && opts.draws) || DRAWS, btDays: btReturns.length },
    notes,
  };
}

const readJson = async (f) => { try { return JSON.parse(await readFile(f, 'utf8')); } catch { return null; } };

export async function loadDrift(projectsDir, projectId, sessionId, lang = 'zh') {
  const en = lang === 'en';
  const dir = path.join(projectsDir, String(projectId), 'paper', sessionId);
  const session = await readJson(path.join(dir, 'session.json'));
  if (!session) return { found: false };
  const latest = await readJson(path.join(dir, 'latest.json'));
  const bid = String(session.sourceBacktestId || '').replace(/[^a-f0-9]/g, '');
  const noRes = (note) => ({ found: true, drift: { available: false, note } });
  if (!bid) return noRes(en ? 'This simulation has no recorded source backtest, so the expected range cannot be estimated.' : '这个模拟没有记录来源回测，没法估计预期范围。');
  const result = await readJson(path.join(projectsDir, String(projectId), 'backtests', bid, 'out', `${bid}.json`));
  if (!result) return noRes(en ? 'The source backtest result file was not found (the backtest may have been deleted), so the expected range cannot be estimated.' : '找不到来源回测的结果文件（回测可能被删了），没法估计预期范围。');
  let P; try { P = prepare(result); } catch { P = null; }
  if (!P || !P.r.length) return noRes(en ? 'No daily returns could be read from the source backtest result file, so the expected range cannot be estimated.' : '来源回测的结果文件读不出日收益，没法估计预期范围。');
  const fwd = forwardFromLatest(latest);
  const drift = assessDrift({ btReturns: P.r, fwd, lang });
  if (drift.available) drift.source = { backtestId: bid, name: session.sourceName || null };
  return { found: true, drift };
}
