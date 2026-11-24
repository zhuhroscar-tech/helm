// Helm · 因子归因：策略的日收益（减无风险利率）对 Fama-French 五因子 + 动量做回归。
// 回答「这个策略的收益是哪来的」：市场暴露、规模、价值、盈利、投资、动量，剩下的是 alpha（因子解释不了的部分）。
// 只读回测已存的结果，不跑新回测，不计入尝试次数。标准误用 Newey-West（日收益有自相关）。
// 局限：因子都是美股的，持有债券、海外股票的时期解释力会低（R² 低不代表有 alpha）。
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { prepare } from './robust.mjs';
import { FACTORS, FACTOR_LABEL, loadFactors } from './factors.mjs';

export const MIN_DAYS = 252;
const T_SIG = 2;

/** 解线性方程组（高斯消元，部分选主元）。同步函数。 */
function solve(A, b) {
  const n = b.length; const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-14) return null;
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}
function invert(A) {
  const n = A.length; const cols = [];
  for (let j = 0; j < n; j++) { const e = Array(n).fill(0); e[j] = 1; const x = solve(A, e); if (!x) return null; cols.push(x); }
  return A.map((_, i) => cols.map((c) => c[i]));
}

/**
 * OLS + Newey-West 标准误。y: [n]，X: [n][k]（第一列是 1）。返回 { beta, se, t, r2, resid }，奇异时返回 null。同步函数。
 */
export function olsNW(y, X, lag = null) {
  const n = y.length; const k = X[0].length;
  const XtX = Array.from({ length: k }, () => Array(k).fill(0)); const Xty = Array(k).fill(0);
  for (let i = 0; i < n; i++) for (let a = 0; a < k; a++) { Xty[a] += X[i][a] * y[i]; for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b]; }
  const inv = invert(XtX);
  if (!inv) return null;
  const beta = inv.map((r) => r.reduce((s, v, j) => s + v * Xty[j], 0));
  const resid = y.map((v, i) => v - X[i].reduce((s, x, j) => s + x * beta[j], 0));
  const L = lag == null ? Math.floor(4 * (n / 100) ** (2 / 9)) : lag;
  // S = Σ_l w_l Σ_t u_t u_{t-l} (x_t x_{t-l}' + x_{t-l} x_t')
  const S = Array.from({ length: k }, () => Array(k).fill(0));
  for (let l = 0; l <= L; l++) {
    const w = l === 0 ? 1 : 1 - l / (L + 1);
    for (let t = l; t < n; t++) {
      const uu = resid[t] * resid[t - l];
      for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) {
        const v = X[t][a] * X[t - l][b] * uu;
        S[a][b] += l === 0 ? v : w * (v + X[t - l][a] * X[t][b] * uu);
      }
    }
  }
  const V = inv.map((r) => S[0].map((_, j) => r.reduce((s, v, m) => s + v * S[m].reduce((ss, sv, q) => ss + sv * inv[q][j], 0), 0)));
  const se = V.map((r, i) => Math.sqrt(Math.max(0, r[i])));
  const ym = y.reduce((s, v) => s + v, 0) / n;
  const sst = y.reduce((s, v) => s + (v - ym) ** 2, 0);
  const sse = resid.reduce((s, v) => s + v * v, 0);
  return { beta, se, t: beta.map((b, i) => (se[i] > 0 ? b / se[i] : 0)), r2: sst > 0 ? 1 - sse / sst : 0, resid, lag: L, n };
}

const dayIndex = (d) => Math.floor(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)) / 86400000);

/**
 * 归因计算。r: 策略日收益，rDay: 每个收益对应的日序号（robust.prepare 的 rDay），factors: loadFactors().factors。
 * 返回 { available, reason?, n, start, end, alpha: {annual, t}, r2, exposures: [{factor, beta, t, contribution, significant}], ... }。同步函数。
 */
export function attribute({ r, rDay, factors, lang = 'zh' }) {
  const en = lang === 'en';
  const fIdx = new Map(factors.dates.map((d, i) => [dayIndex(d), i]));
  const y = []; const X = []; const days = [];
  for (let i = 0; i < r.length; i++) {
    const j = fIdx.get(rDay[i]);
    if (j == null || !Number.isFinite(r[i])) continue;
    y.push(r[i] - factors.rf[j]);
    X.push([1, ...FACTORS.map((f) => factors[f][j])]);
    days.push(rDay[i]);
  }
  const iso = (d) => new Date(d * 86400000).toISOString().slice(0, 10);
  const lastF = factors.dates.length ? factors.dates[factors.dates.length - 1] : null;
  if (y.length < MIN_DAYS) {
    return { available: false, n: y.length, factorsEnd: lastF ? `${lastF.slice(0, 4)}-${lastF.slice(4, 6)}-${lastF.slice(6)}` : null,
      reason: en ? `Only ${y.length} days overlap with the factor data (need ${MIN_DAYS})` : `回测和因子数据只重叠 ${y.length} 天（至少要 ${MIN_DAYS} 天）` };
  }
  const fit = olsNW(y, X);
  if (!fit) return { available: false, n: y.length, reason: en ? 'The regression could not be solved (factors are collinear over this period)' : '回归解不出来（这段时间因子之间共线）' };
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const exposures = FACTORS.map((f, k) => {
    const beta = fit.beta[k + 1]; const t = fit.t[k + 1];
    const fm = mean(X.map((row) => row[k + 1]));
    return { factor: f, label: FACTOR_LABEL[f][en ? 'en' : 'zh'], beta: round(beta, 3), t: round(t, 2), contribution: round(beta * fm * 252, 4), significant: Math.abs(t) >= T_SIG };
  });
  const alphaAnnual = fit.beta[0] * 252;
  const excessAnnual = mean(y) * 252;
  const out = {
    available: true, n: y.length, start: iso(days[0]), end: iso(days[days.length - 1]), lag: fit.lag,
    r2: round(fit.r2, 3), excessAnnual: round(excessAnnual, 4),
    alpha: { annual: round(alphaAnnual, 4), t: round(fit.t[0], 2), significant: Math.abs(fit.t[0]) >= T_SIG },
    exposures,
    factorsEnd: lastF ? `${lastF.slice(0, 4)}-${lastF.slice(4, 6)}-${lastF.slice(6)}` : null,
  };
  out.summary = summarize(out, lang);
  return out;
}

const round = (x, d) => (Number.isFinite(x) ? Number(x.toFixed(d)) : null);
const pct = (x) => `${(x * 100).toFixed(1)}%`;

/** 一段话的结论（不带术语）。同步函数。 */
export function summarize(a, lang = 'zh') {
  const en = lang === 'en';
  const sig = a.exposures.filter((e) => e.significant).sort((x, y) => Math.abs(y.beta) - Math.abs(x.beta));
  const parts = [];
  const r2 = a.r2;
  parts.push(en
    ? `Known factors explain ${Math.round(r2 * 100)}% of the daily ups and downs (R²).`
    : `已知因子能解释每天涨跌的 ${Math.round(r2 * 100)}%（R²）。`);
  if (sig.length) {
    parts.push(en
      ? `Clear exposures: ${sig.map((e) => `${e.label.split(' (')[0].toLowerCase()} ${e.beta >= 0 ? '+' : ''}${e.beta}`).join(', ')}.`
      : `明显的暴露：${sig.map((e) => `${e.label.split('（')[0]} ${e.beta >= 0 ? '+' : ''}${e.beta}`).join('、')}。`);
  } else parts.push(en ? 'No factor exposure is statistically clear.' : '没有哪个因子暴露在统计上是明确的。');
  const mom = a.exposures.find((e) => e.factor === 'mom');
  if (mom && mom.significant && mom.beta > 0.2) parts.push(en ? 'A good part of the return behaves like momentum.' : '收益里有相当一部分表现得像动量。');
  parts.push(a.alpha.significant
    ? (en ? `What the factors don't explain (alpha) is ${pct(a.alpha.annual)} a year and statistically clear (t = ${a.alpha.t}).` : `扣掉因子后剩下的年化 ${pct(a.alpha.annual)}（alpha），统计上是明确的（t = ${a.alpha.t}）。`)
    : (en ? `What the factors don't explain (alpha) is ${pct(a.alpha.annual)} a year, indistinguishable from zero (t = ${a.alpha.t}).` : `扣掉因子后剩下的年化 ${pct(a.alpha.annual)}（alpha），和 0 分不开（t = ${a.alpha.t}）。`));
  if (r2 < 0.5) parts.push(en ? 'The factors are US-equity only, so periods in bonds or foreign stocks are poorly explained; a low R² is not evidence of alpha.' : '因子都是美股的，持有债券或海外股票的时期解释不了；R² 低不代表有 alpha。');
  return parts.join(en ? ' ' : '');
}

const CACHE = new Map();
/** 读回测结果 + 因子数据，算归因（按结果文件和因子数据的时间缓存）。 */
export async function loadAttribution({ projectsDir, dataDir, projectId, backtestId, lang = 'zh', fetchImpl } = {}) {
  const pid = Number(projectId);
  const bid = String(backtestId || '').replace(/[^a-f0-9]/g, '');
  if (!Number.isSafeInteger(pid) || pid <= 0 || !bid) return { success: false, errors: ['projectId 或 backtestId 不对'] };
  const f = path.join(projectsDir, String(pid), 'backtests', bid, 'out', `${bid}.json`);
  let mt;
  try { mt = (await stat(f)).mtimeMs; } catch { return { success: false, errors: ['这个回测还没有结果文件（没跑完或运行失败）'] }; }
  const fac = await loadFactors({ dataDir, ...(fetchImpl ? { fetchImpl } : {}) });
  if (!fac.success) return { success: false, errors: fac.errors };
  const key = `${pid}/${bid}/${lang}`; const sig = `${mt}|${fac.fetchedAt}`;
  const hit = CACHE.get(key);
  if (hit && hit.sig === sig) return { success: true, errors: [], attribution: hit.a };
  let result;
  try { result = JSON.parse(await readFile(f, 'utf8')); } catch { return { success: false, errors: ['回测结果文件读不出来'] }; }
  const P = prepare(result);
  const a = { ...attribute({ r: P.r, rDay: P.rDay, factors: fac.factors, lang }), source: fac.source, fetchedAt: fac.fetchedAt, stale: fac.stale };
  if (CACHE.size > 60) CACHE.delete(CACHE.keys().next().value);
  CACHE.set(key, { sig, a });
  return { success: true, errors: [], attribution: a };
}
