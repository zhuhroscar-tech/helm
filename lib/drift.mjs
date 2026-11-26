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
// 只在固定检查点下结论，不是每天都判一次。每天拿 5% / 95% 去比是「重复检验」：
// 和回测完全一致的策略，250 个交易日里也有约一半会至少被标一次“偏离”（实测见 test/stats-calibration.test.mjs）。
// 第一年 4 个检查点，每个检查点每一侧 1.25%（Bonferroni：4 次 × 2 侧 × 1.25% = 10%，和原来单次 5% / 95% 的总误报率相同）。
// 一年以后每 250 个交易日再看一次，每次每一侧同样 1.25%（每多一年，误报率上限多 2.5%）。
export const CHECKPOINTS = [20, 60, 120, 250];
export const CHECK_EVERY = 250;
export const TAIL = 0.0125;
/** n 个交易日为止已经到过的检查点（升序） */
export function checkpointsUpTo(n) {
  const out = CHECKPOINTS.filter((c) => c <= n);
  for (let c = CHECKPOINTS[CHECKPOINTS.length - 1] + CHECK_EVERY; c <= n; c += CHECK_EVERY) out.push(c);
  return out;
}
/** 下一个检查点 */
export function nextCheckpoint(n) {
  const first = CHECKPOINTS.find((c) => c > n);
  if (first) return first;
  const last = CHECKPOINTS[CHECKPOINTS.length - 1];
  return last + (Math.floor((n - last) / CHECK_EVERY) + 1) * CHECK_EVERY;
}

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
  // path[k] = 冻结后第 k 个交易日为止的累计收益（path[0] = 0）：检查点的结论要用“当时”的累计收益，不是今天的
  const f = { n: e.length - 1, from: e[0][0], to: e[e.length - 1][0], r: +e[e.length - 1][1] / +e[0][1] - 1, path: e.map((p) => +p[1] / +e[0][1] - 1), dd: maxDrawdownOfLevels(e.map((p) => +p[1])), bench: null, excess: null, benchDays: 0 };
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
  // 结论只在检查点下：取最近一个已到的检查点上的累计收益，和那一天的自助法分布比，每一侧 1.25%。
  // 两个检查点之间，结论保持上一个检查点的不变；今天的范围和百分位照常给出，只作参考。
  // fwd.path 没有（调用方只给了 n 和 r）时，把今天当作唯一的一次检查。
  const judge = (rk) => (rk < TAIL ? 'low' : rk > 1 - TAIL ? 'high' : 'in');
  const hasPath = Array.isArray(fwd.path) && fwd.path.length === fwd.n + 1;
  const checkpoints = [];
  if (fwd.n >= MIN_DAYS) {
    if (hasPath) {
      for (const c of checkpointsUpTo(fwd.n)) {
        const b = c === fwd.n ? bs : bootstrapBand(btReturns, c, opts);
        const rk = percentRank(b.sorted, fwd.path[c]);
        checkpoints.push({ n: c, r: fwd.path[c], rank: rk, verdict: judge(rk) });
      }
    } else checkpoints.push({ n: fwd.n, r: fwd.r, rank, verdict: judge(rank) });
  }
  const at = checkpoints.length ? checkpoints[checkpoints.length - 1] : null;
  const verdict = at ? at.verdict : 'early';
  const next = nextCheckpoint(fwd.n);
  const pct = (x) => `${+(x * 100).toFixed(2)}%`;
  const notes = [];
  if (verdict === 'early') notes.push(en ? `Only ${fwd.n} trading days (under ${MIN_DAYS}); the range is very wide, so wherever it lands says little.` : `只有 ${fwd.n} 个交易日（不到 ${MIN_DAYS} 天），范围很宽，落在哪里都说明不了什么。`);
  if (verdict === 'low') notes.push(en ? `Below ${pct(1 - TAIL)} of the backtest-based simulations at the day-${at.n} checkpoint. First check for differences in data and execution (data source, fill prices, slippage, unfilled orders), then judge whether the strategy has lost its edge.` : `在第 ${at.n} 个交易日的检查点上，低于回测 ${pct(1 - TAIL)} 的模拟结果。先查数据和执行有没有差异（数据源、成交价、滑点、未成交的单），再判断策略的优势是不是没了。`);
  if (verdict === 'high') notes.push(en ? `Above ${pct(1 - TAIL)} of the backtest-based simulations at the day-${at.n} checkpoint. Running high is also a deviation: it may be luck, or a gap between the backtest and live conditions, so do not read it as the strategy being better.` : `在第 ${at.n} 个交易日的检查点上，高于回测 ${pct(1 - TAIL)} 的模拟结果。偏高也是偏离：可能是运气，也可能是回测和实际有差别，不能直接当成策略更好了。`);
  if (at && hasPath) {
    const earlier = checkpoints.slice(0, -1).filter((c) => c.verdict !== 'in');
    if (earlier.length) notes.push(en ? `Earlier checkpoint(s) outside the range: ${earlier.map((c) => `day ${c.n} (${c.verdict === 'low' ? 'below' : 'above'})`).join(', ')}.` : `之前的检查点有过偏离：${earlier.map((c) => `第 ${c.n} 天（${c.verdict === 'low' ? '偏低' : '偏高'}）`).join('、')}。`);
    notes.push(en ? `The verdict is set only at fixed checkpoints (day ${CHECKPOINTS.join(', ')}, then every ${CHECK_EVERY}), each at ${pct(TAIL)} per side, so a strategy that matches its backtest is flagged at most about 10% of the time in the first year. This one is from day ${at.n}${at.n === fwd.n ? '' : `; today's position is for reference only`}; the next is day ${next}.` : `结论只在固定检查点下（第 ${CHECKPOINTS.join('、')} 个交易日，之后每 ${CHECK_EVERY} 天一次），每一侧 ${pct(TAIL)}：和回测一致的策略，第一年被误标的概率最多约 10%。现在的结论来自第 ${at.n} 天${at.n === fwd.n ? '' : '，今天的位置只作参考'}；下一个检查点是第 ${next} 天。`);
  }
  if (fwd.dd > btDd && fwd.n >= MIN_DAYS) notes.push(en ? `The max drawdown since the freeze (${pc(fwd.dd)}) already exceeds the backtest's full-period max drawdown (${pc(btDd)}).` : `冻结后的最大回撤 ${pc(fwd.dd)} 已超过回测全程的最大回撤 ${pc(btDd)}。`);
  notes.push(en ? 'This only checks whether live results are consistent with the backtest; it does not prove the strategy works. The fewer the trading days, the less reliable the conclusion.' : '这只检验“和回测是否一致”，不证明策略有效；交易日越少，结论越不可靠。');
  return {
    available: true, n: fwd.n, r: fwd.r, from: fwd.from, to: fwd.to,
    band: bs.band, rank, verdict, checkpoint: at, checkpoints, nextCheckpoint: next, verdictText: (en ? VERDICT_TEXT_EN : VERDICT_TEXT)[verdict],
    excess: fwd.excess == null ? null : { bench: fwd.bench, excess: fwd.excess, days: fwd.benchDays },
    dd: { forward: fwd.dd, backtest: btDd },
    method: { block: (opts && opts.block) || BLOCK, draws: (opts && opts.draws) || DRAWS, btDays: btReturns.length, tail: TAIL, checkpoints: CHECKPOINTS, every: CHECK_EVERY },
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
