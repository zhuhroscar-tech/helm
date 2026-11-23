// 调参（超参数搜索）的纯函数部分：LEAN 引擎用。没有任何 I/O，test/tune.test.mjs 直接测。
//
// 方法（都有公开论文依据，计算量小）：
//  1. 搜索：拉丁超立方的随机搜索（Bergstra & Bengio 2012：同样预算下随机搜索不比网格差、通常更好；
//     拉丁超立方让每个参数的取值区间被均匀覆盖）。正数参数在对数尺度上取值（×0.5 到 ×2）。
//  2. 选参：不挑「最好的那一个」，挑「附近也好」的那一个（参数平台 / plateau）：每个候选和它最近的几个
//     候选取平均夏普，平均最高的胜出。单点最好往往是运气，邻居也好才可能是规律。
//  3. 检验：CSCV 估计回测过拟合的概率 PBO（Bailey, Borwein, López de Prado & Zhu, 2017,
//     Journal of Computational Finance）：把开发期切成 S 段，所有「一半段当样本内、另一半当样本外」的组合里，
//     样本内最好的参数在样本外排到中位数以下的比例。PBO 高 = 调参挑出来的是噪音。
//  4. 计数：每个候选都记进尝试次数（trials.jsonl），去膨胀夏普的门槛随之抬高（Bailey & López de Prado 2014）。
import { mulberry32 } from './stats.mjs';

export const TUNE_DEFAULT_BUDGET = 16; // 含原参数那一个（原参数直接用原回测，不重跑）
export const TUNE_MIN_BUDGET = 6;
export const TUNE_MAX_BUDGET = 40;
export const TUNE_RANGE_FACTOR = 2; // 默认范围：默认值 ÷2 到 ×2（对数尺度）
export const TUNE_MAX_RANGE_FACTOR = 10; // 自定义范围最多偏离默认值 10 倍

const SQ252 = Math.sqrt(252);
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
export const sharpe = (r) => { const v = r.filter(Number.isFinite); if (v.length < 2) return 0; const s = sd(v); return s > 1e-12 ? (mean(v) / s) * SQ252 : 0; };

// 字符串 → 32 位种子（同一个任务编号每次抽到同样的候选，可复现）
export function seedOf(text) {
  let h = 2166136261;
  for (const ch of String(text)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * 每个参数的搜索范围。params：[{name, default, isInt}]；custom：{名字: [lo, hi]}（可选）。
 * 返回 { ranges: [{name, default, isInt, lo, hi, log}], errors: [文字] }
 */
export function buildRanges(params, custom = {}) {
  const ranges = []; const errors = [];
  for (const p of params) {
    const d = p.default;
    if (!Number.isFinite(d) || d === 0) { errors.push(`${p.name}：默认值为 0 或不是数字，没法按比例搜索`); continue; }
    let lo; let hi;
    const c = custom && custom[p.name];
    if (c != null) {
      if (!Array.isArray(c) || c.length !== 2 || !c.every(Number.isFinite) || !(c[0] < c[1])) { errors.push(`${p.name}：范围要写成 [下限, 上限]，且下限 < 上限`); continue; }
      [lo, hi] = c;
      if (Math.sign(lo) !== Math.sign(d) || Math.sign(hi) !== Math.sign(d)) { errors.push(`${p.name}：范围必须和默认值同号（不能跨过 0）`); continue; }
      const f = Math.max(Math.abs(hi / d), Math.abs(d / lo));
      if (f > TUNE_MAX_RANGE_FACTOR + 1e-9) { errors.push(`${p.name}：范围离默认值超过 ${TUNE_MAX_RANGE_FACTOR} 倍，太宽了`); continue; }
    } else {
      const a = Math.abs(d) / TUNE_RANGE_FACTOR; const b = Math.abs(d) * TUNE_RANGE_FACTOR;
      [lo, hi] = d > 0 ? [a, b] : [-b, -a];
    }
    if (p.isInt) {
      lo = d > 0 ? Math.max(1, Math.round(lo)) : Math.round(lo);
      hi = d > 0 ? Math.round(hi) : Math.min(-1, Math.round(hi));
      if (lo === hi) { errors.push(`${p.name}：整数范围只有一个值，没有可搜索的`); continue; }
    }
    ranges.push({ name: p.name, default: d, isInt: Boolean(p.isInt), lo, hi, log: true });
  }
  for (const k of Object.keys(custom || {})) if (!params.some((p) => p.name === k)) errors.push(`${k}：代码里没有这个参数`);
  return { ranges, errors };
}

// [0,1] → 参数值（对数尺度：按倍数均匀；整数四舍五入）。u = 0 对应 lo，u = 1 对应 hi
function logBounds(r) {
  const m1 = Math.log(Math.min(Math.abs(r.lo), Math.abs(r.hi))); const m2 = Math.log(Math.max(Math.abs(r.lo), Math.abs(r.hi)));
  return { s: Math.sign(r.lo), m1, m2 };
}
function fromUnit(r, u) {
  const { s, m1, m2 } = logBounds(r);
  let v = s > 0 ? Math.exp(m1 + (m2 - m1) * u) : -Math.exp(m2 - (m2 - m1) * u);
  v = r.isInt ? Math.round(v) : Number(v.toPrecision(6));
  return Math.min(r.hi, Math.max(r.lo, v));
}
// 参数值 → [0,1]（算邻居距离用）
export function toUnit(r, v) {
  const { s, m1, m2 } = logBounds(r);
  if (m2 === m1) return 0;
  const x = Math.log(Math.abs(v));
  const u = s > 0 ? (x - m1) / (m2 - m1) : (m2 - x) / (m2 - m1);
  return Math.min(1, Math.max(0, u));
}

/**
 * 拉丁超立方抽样：budget 个候选，第 0 个固定是原参数。整数参数重复的组合会重抽（最多 20 次），
 * 实在凑不满就少几个（小整数范围的情况）。返回 [{id, values: {名字: 值}, isDefault}]
 */
export function sampleConfigs(ranges, budget, seed) {
  const rnd = mulberry32(seed >>> 0);
  const n = Math.max(1, budget - 1);
  const def = Object.fromEntries(ranges.map((r) => [r.name, r.default]));
  const out = [{ id: 'c0', values: def, isDefault: true }];
  const key = (v) => ranges.map((r) => v[r.name]).join('|');
  const seen = new Set([key(def)]);
  for (let attempt = 0; attempt < 20 && out.length < budget; attempt++) {
    // 每一维：把 [0,1] 切成 n 格，每格抽一个点，再打乱顺序
    const cols = ranges.map(() => {
      const cells = Array.from({ length: n }, (_, i) => (i + rnd()) / n);
      for (let i = cells.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [cells[i], cells[j]] = [cells[j], cells[i]]; }
      return cells;
    });
    for (let i = 0; i < n && out.length < budget; i++) {
      const v = Object.fromEntries(ranges.map((r, d) => [r.name, fromUnit(r, cols[d][i])]));
      const k = key(v);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ id: `c${out.length}`, values: v, isDefault: false });
    }
  }
  return out;
}

/**
 * 参数平台：每个候选和它最近的 k 个候选（参数空间里，按 [0,1] 尺度的欧氏距离）取平均夏普。
 * cands：[{id, values, sharpe}]（sharpe 为 null 的不参与）。返回按平滑分数排好的 [{id, smooth, neighbors}]
 */
export function plateauScores(ranges, cands, k = 3) {
  const ok = cands.filter((c) => Number.isFinite(c.sharpe));
  const pos = (c) => ranges.map((r) => toUnit(r, c.values[r.name]));
  const P = ok.map(pos);
  const kk = Math.min(k, Math.max(0, ok.length - 1));
  const rows = ok.map((c, i) => {
    const d = ok.map((_, j) => ({ j, dist: j === i ? Infinity : Math.hypot(...P[i].map((x, t) => x - P[j][t])) })).sort((a, b) => a.dist - b.dist).slice(0, kk);
    const vals = [c.sharpe, ...d.map((x) => ok[x.j].sharpe)];
    return { id: c.id, sharpe: c.sharpe, smooth: mean(vals), neighbors: d.map((x) => ok[x.j].id) };
  });
  return rows.sort((a, b) => b.smooth - a.smooth || a.id.localeCompare(b.id));
}

/**
 * 从平台里挑推荐参数（两步）：先用 plateauScores 找平滑分数最高的「平台」（一个候选 + 最近的 k 个邻居），
 * 再推荐这一组里离组中心最近的那个候选，而不是平台分数最高的那个点本身。
 * 原因：范围边上的点，邻居全在一侧，邻居的平均夏普会把边上的点「抬」起来，单用平台分数时约 1/8 的抽样
 * 会推荐到范围边上（山顶在中间时）。取组中心：无噪声时偏离山顶的比例 12.7% → 3.5%，带噪声时 23.8% → 8.6%，
 * 一个凭运气 +2 的孤立候选被推荐的比例 19.3% → 13.9%（test/tune.test.mjs 的抽样统计）。
 * 返回 { id, smooth, neighbors, group }；没有候选时返回 null。
 */
export function recommendFromPlateau(ranges, cands, plateau = plateauScores(ranges, cands)) {
  const best = plateau[0];
  if (!best) return null;
  const byId = new Map(cands.map((c) => [c.id, c]));
  const group = [best.id, ...best.neighbors].filter((id) => byId.has(id));
  const pos = (id) => ranges.map((r) => toUnit(r, byId.get(id).values[r.name]));
  const P = group.map(pos);
  const center = ranges.map((_, t) => mean(P.map((p) => p[t])));
  const pick = group.map((id, i) => ({ id, d: Math.hypot(...P[i].map((x, t) => x - center[t])) }))
    .sort((a, b2) => a.d - b2.d || a.id.localeCompare(b2.id))[0].id;
  return { id: pick, smooth: best.smooth, neighbors: best.neighbors, group };
}

/**
 * CSCV（组合对称交叉验证）估计 PBO。R：候选 × 日收益（同样长度，按日期对齐）。
 * S：把日期等分成 S 段（偶数）。返回 { pbo, combos, S, probLoss, degradation }，日期太短时返回 null。
 */
export function cscvPbo(R, S = 8) {
  const N = R.length;
  if (N < 2) return null;
  const T = Math.min(...R.map((r) => r.length));
  if (S % 2 || T < S * 20) return null;
  const size = Math.floor(T / S);
  const blocks = Array.from({ length: S }, (_, b) => [b * size, b === S - 1 ? T : (b + 1) * size]);
  const half = S / 2;
  const combos = [];
  const pick = (start, acc) => {
    if (acc.length === half) { combos.push(acc.slice()); return; }
    for (let b = start; b < S; b++) { acc.push(b); pick(b + 1, acc); acc.pop(); }
  };
  pick(0, []);
  const seg = (r, bs) => bs.flatMap((b) => r.slice(blocks[b][0], blocks[b][1]));
  let below = 0; let loss = 0; const isOos = [];
  for (const c of combos) {
    const oos = [...Array(S).keys()].filter((b) => !c.includes(b));
    const ins = R.map((r) => sharpe(seg(r, c)));
    const outs = R.map((r) => sharpe(seg(r, oos)));
    let best = 0;
    for (let i = 1; i < N; i++) if (ins[i] > ins[best]) best = i;
    // 样本外排名（1 = 最差），归一化到 (0,1)，logit ≤ 0 即在中位数及以下
    const rank = outs.filter((x) => x < outs[best]).length + (outs.filter((x) => x === outs[best]).length + 1) / 2;
    const w = rank / (N + 1);
    if (Math.log(w / (1 - w)) <= 0) below++;
    if (outs[best] < 0) loss++;
    isOos.push([ins[best], outs[best]]);
  }
  // 样本内最好 → 样本外的线性斜率（负 = 样本内越好、样本外越差，典型过拟合）
  const xs = isOos.map((p) => p[0]); const ys = isOos.map((p) => p[1]);
  const mx = mean(xs); const my = mean(ys);
  const vx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  const slope = vx > 1e-12 ? xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / vx : null;
  return { pbo: below / combos.length, combos: combos.length, S, probLoss: loss / combos.length, degradation: slope, meanIsBest: mx, meanOosOfBest: my };
}

// 开发期多长就切多少段：至少每段 20 个交易日
export function cscvBlocks(T) {
  if (T >= 8 * 63) return 8;
  if (T >= 6 * 42) return 6;
  if (T >= 4 * 20) return 4;
  return null;
}

/**
 * 结论（规则事先定好）：
 *  - PBO > 0.5：调参在过拟合，保持原参数。
 *  - 推荐值的平台夏普没有比原参数高出 max(0.1, 10%)：调参没带来可信的改进，保持原参数。
 *  - PBO 在 0.25–0.5：可以考虑，但要谨慎。
 *  - 否则：可以考虑采用推荐值（作为新的一次尝试，先改 spec，再跑开发期并做统计检验）。
 */
export function tuneVerdict({ pbo, defaultSmooth, bestSmooth, recommendedIsDefault }) {
  const margin = Math.max(0.1, 0.1 * Math.abs(defaultSmooth ?? 0));
  if (pbo != null && pbo > 0.5) return { code: 'overfit', adopt: false, text: `PBO = ${pbo.toFixed(2)} > 0.5：样本内最好的参数，在样本外有一半以上的情况排在中位数以下。调参挑出来的是噪音，保持规则说明里的原参数。` };
  if (recommendedIsDefault) return { code: 'keep', adopt: false, text: '参数平台最高的就是原参数：不需要改。' };
  if (!(Number.isFinite(bestSmooth) && Number.isFinite(defaultSmooth)) || bestSmooth - defaultSmooth < margin) {
    return { code: 'no-gain', adopt: false, text: `推荐参数的平台夏普只比原参数高 ${Number.isFinite(bestSmooth - defaultSmooth) ? (bestSmooth - defaultSmooth).toFixed(2) : '—'}（要求至少 ${margin.toFixed(2)}）：改进不可信，保持原参数。` };
  }
  if (pbo == null) return { code: 'unchecked', adopt: false, text: '开发期太短，没法估计 PBO：改进无法检验，保持原参数。' };
  if (pbo > 0.25) return { code: 'caution', adopt: true, text: `可以考虑推荐参数，但 PBO = ${pbo.toFixed(2)} 偏高（0.25–0.5），过拟合的可能不小。采用前先看分段稳定性和参数敏感性。` };
  return { code: 'adopt', adopt: true, text: `可以考虑推荐参数：平台夏普比原参数高 ${(bestSmooth - defaultSmooth).toFixed(2)}，PBO = ${pbo.toFixed(2)}。` };
}

export const TUNE_RULES = '调参规则：只在开发期调，验证期一次都不碰；每个候选都计入尝试次数（去膨胀夏普的门槛随之抬高）；不挑单点最好，挑参数平台（附近也好）的那组；PBO > 0.5 或改进不够大就保持原参数。采用推荐值 = 改规则：先改 spec.md 和 get_parameter 默认值，再作为新的候选跑开发期、做 validate_backtest，通过后验证期只跑一次。';
