// Helm · 「叠加 Qlib 选股」：在已有的 LEAN 策略（比如 GEM）里，让 qlib 在策略的美股 ETF 那条腿里选股。
//
// 流程：
//   1. precheck（确定性、不花钱）：有回测、代码里有能换成 qlib 股票池的美股 ETF、还没用 HelmSignals。
//   2. 评估：一次不带工具的模型调用（和汇报一样），只输出 JSON：2–4 个叠加方案。服务端校验、截断，
//      并且一定追加「不加这一层」——不能让模型只给「加」的选项。
//   3. 用户在网页上（Kahoot 式的色块）选一个；选择被记下，再把带护栏的任务交给总控（mia）走正常对话。
//      真正的工作用现有工具完成：test_idea（只用开发期）→ export_signals → 候选回测 + 原策略做消融对照 → 统计检验。
//      主版本和模拟实盘不动；没跑的方案不计入尝试次数。
//
// 文件：projects/<id>/layers/<layerId>.json
import { readFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeJsonAtomic } from './fs-atomic.mjs';
import { extractJson } from './deck/pipeline.mjs';

// 美股 ETF → qlib 股票池。pit：成分股是否按历史日期（去幸存者偏差）
export const ETF_UNIVERSE = {
  SPY: 'sp500', VOO: 'sp500', IVV: 'sp500', SPLG: 'sp500',
  QQQ: 'nasdaq100', QQQM: 'nasdaq100',
  DIA: 'dia',
  IWM: 'iwm80',
  SOXX: 'sox', SMH: 'sox',
  OEF: 'spy100',
};
const STATIC_PIT = { sp500: 'pit', nasdaq100: 'partial', dia: 'snapshot', sox: 'snapshot', spy100: 'snapshot', iwm80: 'snapshot' };
const UNI_LABEL = { sp500: 'S&P 500', nasdaq100: 'Nasdaq-100', dia: 'Dow 30', sox: 'PHLX Semiconductor', spy100: 'S&P 100', iwm80: 'Russell 2000 (80-name sample)' };
const RISKS = new Set(['low', 'medium', 'high']);
const SIGNALS = new Set(['idea', 'full']);
export const MAX_OPTIONS = 4;

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** 代码里出现的 ETF 代码（只认引号里的大写代码）。同步函数。 */
export function tickersInCode(files = []) {
  const out = new Set();
  for (const f of files) {
    if (!/\.py$/i.test(f.name)) continue;
    for (const m of String(f.content).matchAll(/["']([A-Z]{2,5})["']/g)) out.add(m[1]);
  }
  return out;
}

/**
 * 确定性预检。files = 主版本（或最新）回测的代码快照；backtests = 回测列表；universes = listUniverses() 的结果（可以是 null）。
 * 返回 { ok, reason?, legs: [{ etf, universe, label, pit, ready }], backtest }。同步函数。
 */
/** 以哪个回测为准：主版本 > 最新候选 > 最新一个跑完的回测（列表按时间倒序）。同步函数。 */
export function pickBacktest(backtests = []) {
  const done = backtests.filter((b) => b && !b.error && /complet/i.test(String(b.status || '')) && b.period !== 'holdout');
  return done.find((b) => b.role === 'main') || done.find((b) => b.role === 'candidate') || done[0] || null;
}

export function precheck({ files = [], backtests = [], universes = null } = {}) {
  const bt = pickBacktest(backtests);
  if (!bt) return { ok: false, reason: '这个项目还没有跑完的回测：先有一个策略，才能在上面叠加一层', legs: [] };
  const py = files.filter((f) => /\.py$/i.test(f.name));
  if (!py.length) return { ok: false, reason: '找不到这个策略的代码快照', legs: [], backtest: bt };
  if (py.some((f) => /\bHelmSignals\b/.test(String(f.content)))) return { ok: false, reason: '这个策略已经在用 qlib 信号（HelmSignals），不需要再叠加', legs: [], backtest: bt };
  const uniBy = new Map((universes || []).map((u) => [u.key, u]));
  const legs = [];
  for (const t of tickersInCode(py)) {
    const key = ETF_UNIVERSE[t];
    if (!key) continue;
    const u = uniBy.get(key);
    const pit = u ? (u.kind === 'point-in-time' ? 'pit' : u.kind === 'partial-point-in-time' ? 'partial' : u.kind === 'snapshot' ? 'snapshot' : STATIC_PIT[key]) : STATIC_PIT[key];
    legs.push({ etf: t, universe: key, label: (u && u.label) || UNI_LABEL[key], pit, ready: u ? Boolean(u.exported) : null });
  }
  if (!legs.length) return { ok: false, reason: '代码里没有能换成个股的美股指数 ETF（比如 SPY、QQQ、DIA、IWM）：qlib 选股没有地方叠加', legs: [], backtest: bt };
  return { ok: true, legs, backtest: bt };
}

/** 交给模型的材料（截断过）。同步函数。 */
export function buildContext({ project = {}, spec = '', files = [], backtest = {}, holdoutRuns = 0, legs = [], lang = 'zh' } = {}) {
  const main = files.find((f) => f.name === 'main.py') || files.find((f) => /\.py$/i.test(f.name));
  return {
    lang,
    project: { name: clip(project.nameEn && lang === 'en' ? project.nameEn : project.name, 120), description: clip(project.description, 1200) },
    spec: String(spec || '').slice(0, 6000),
    code: main ? { name: main.name, content: String(main.content).slice(0, 10000) } : null,
    backtest: {
      name: clip(backtest.name, 120), role: backtest.role || null, period: backtest.period || null,
      cagr: backtest.compoundingAnnualReturn ?? null, sharpe: backtest.sharpeRatio ?? null, maxDrawdown: backtest.drawdown ?? null, trades: backtest.trades ?? null,
    },
    holdoutRuns,
    replaceableLegs: legs.map((l) => ({ etf: l.etf, universe: l.universe, label: l.label, pointInTime: l.pit, dataReady: l.ready })),
  };
}

export function assessPrompt(lang = 'zh') {
  const L = lang === 'en' ? 'English' : '简体中文';
  return `You are Helm's quant researcher. The user has a working LEAN strategy and is considering ONE extra layer: replace a US-equity ETF leg of the strategy with individual stocks chosen by a qlib signal from that ETF's index universe (for example: when the strategy would hold SPY, hold the top-ranked S&P 500 stocks instead). The strategy's own timing/allocation rules stay the same.

Read the material (JSON) and propose 2 to ${MAX_OPTIONS} concrete, genuinely different ways to add this layer. Be honest: if the fit is weak, say so in "summary" and keep the options few; Helm always adds a "no layer" choice itself, so do not include one.

Rules for every option:
- It may only replace one of "replaceableLegs" (use its exact etf and universe). Never invent other data.
- signalType "idea" = 1-3 hand-written qlib factor formulas tested with test_idea on the development period (cheap, preferred). "full" = Alpha158 factors + LightGBM via full qlib research (heavier, many more trials, only if clearly justified).
- "trials" = how many variants it will add to the project's trial count (be realistic, 1-6). More trials raise the significance bar.
- Name real risks: universe without point-in-time membership (survivorship bias), higher turnover and costs, holdout already used (holdoutRuns > 0 means the holdout is not clean for the comparison), concentration, signal decay.
- The original strategy will be run unchanged as the ablation to beat; the main version and paper trading are not touched.

Reply with ONE JSON object only, no other text, all text fields in ${L}:
{"summary":"one or two sentences on how well qlib stock selection fits this strategy",
 "options":[{"title":"<= 28 chars","tests":"the single question this option answers, one sentence","how":"2-3 sentences: exactly what changes in the strategy","replaces":"ETF","universe":"key","signalType":"idea|full","signal":"what signal, e.g. the factor formulas in words","holdings":"e.g. top 20, equal weight, monthly","trials":2,"risk":"low|medium|high","risks":["short risk", "..."],"fit":1}]}
"fit" is 1-5 (5 = best fit). Order options from best fit to worst.`;
}

/**
 * 校验并整理模型输出。legs = precheck 的 legs。永远在最后追加「不加这一层」。同步函数。
 * 返回 { summary, options }；没有合格方案时 options 里只有「不加这一层」。
 */
export function sanitizeOptions(raw, legs = [], lang = 'zh') {
  const en = lang === 'en';
  const allowed = new Map(legs.map((l) => [l.etf, l]));
  const src = raw && Array.isArray(raw.options) ? raw.options : [];
  const options = [];
  for (const o of src) {
    if (!o || typeof o !== 'object') continue;
    const leg = allowed.get(String(o.replaces || '').toUpperCase());
    if (!leg) continue;
    if (o.universe && String(o.universe) !== leg.universe) continue;
    const title = clip(o.title, 40);
    const tests = clip(o.tests, 240);
    if (!title || !tests) continue;
    const trials = Math.min(10, Math.max(1, Math.round(Number(o.trials) || 1)));
    options.push({
      id: String.fromCharCode(97 + options.length),
      kind: 'layer',
      title, tests,
      how: clip(o.how, 600),
      replaces: leg.etf, universe: leg.universe, universeLabel: leg.label, pit: leg.pit, dataReady: leg.ready,
      signalType: SIGNALS.has(o.signalType) ? o.signalType : 'idea',
      signal: clip(o.signal, 300),
      holdings: clip(o.holdings, 120),
      trials,
      risk: RISKS.has(o.risk) ? o.risk : 'medium',
      risks: (Array.isArray(o.risks) ? o.risks : []).map((r) => clip(r, 160)).filter(Boolean).slice(0, 4),
      fit: Math.min(5, Math.max(1, Math.round(Number(o.fit) || 3))),
    });
    if (options.length >= MAX_OPTIONS) break;
  }
  // 不在白名单股票池里的、做不到「按历史成分股」的，风险里一定写上
  for (const o of options) {
    if (o.pit !== 'pit') {
      const note = en ? (o.pit === 'partial' ? 'Membership history is only partial: some survivorship bias' : 'No historical membership: survivorship bias') : (o.pit === 'partial' ? '成分股历史不完整：有一定幸存者偏差' : '没有历史成分股：有幸存者偏差');
      if (!o.risks.some((r) => /survivor|幸存/i.test(r))) o.risks = [note, ...o.risks].slice(0, 4);
      if (o.risk === 'low') o.risk = 'medium';
    }
  }
  options.push({
    id: 'none', kind: 'none',
    title: en ? 'No layer' : '不加这一层',
    tests: en ? 'Keep the strategy as it is. Nothing runs and no trials are added.' : '保持策略原样。什么都不跑，也不增加尝试次数。',
    how: '', trials: 0, risk: 'low', risks: [], fit: null,
  });
  return { summary: clip(raw && raw.summary, 400), options };
}

/** 交给总控的任务（用户的界面语言）。同步函数。 */
export function taskMessage({ option, project = {}, backtest = {}, lang = 'zh' }) {
  const o = option;
  if (lang === 'en') {
    return `Layer up Qlib on this project (chosen by the user from Helm's layer options).

Chosen option: ${o.title}
Question it tests: ${o.tests}
What changes: ${o.how}
Replace: the ${o.replaces} leg with individual stocks from the ${o.universeLabel} universe (${o.universe})
Signal: ${o.signalType === 'full' ? 'full qlib research (Alpha158 + LightGBM)' : 'idea test (1-3 qlib factor formulas)'}: ${o.signal}
Holdings: ${o.holdings || 'decide in the spec'}
Expected trials: ${o.trials}
Baseline: backtest ${backtest.backtestId || ''} (${backtest.name || ''})

Rules (do not break):
1. Write the layer into spec.md first (which leg, signal, holdings, rebalancing, costs), then code. The strategy's own timing rules stay unchanged.
2. Signal work on the development period only. If the idea test says "no signal", stop and report; do not try variants until one passes.
3. Run the layered version as a candidate, and the original strategy unchanged on the same period as the ablation. Compare them side by side.
4. Do not change the current main version or any paper-trading session. Only propose promotion if the candidate passes validate_backtest and beats the ablation.
5. ${o.dataReady === false ? `Prepare the ${o.universe} universe first (prepare_universe).` : `Check that the ${o.universe} universe data is ready before starting.`}
6. Report the trial count and, if the holdout has been used before, say the holdout comparison is not clean.`;
  }
  return `在这个项目上叠加 Qlib 选股（用户从 Helm 的叠加方案里选的）。

选中的方案：${o.title}
要回答的问题：${o.tests}
具体改动：${o.how}
替换：把 ${o.replaces} 这条腿换成 ${o.universeLabel}（${o.universe}）股票池里的个股
信号：${o.signalType === 'full' ? '完整 qlib 研究（Alpha158 + LightGBM）' : '想法检验（1–3 个 qlib 因子公式）'}：${o.signal}
持仓：${o.holdings || '在规则说明里定'}
预计尝试次数：${o.trials}
对照基准：回测 ${backtest.backtestId || ''}（${backtest.name || ''}）

规则（不能违反）：
1. 先把这一层写进 spec.md（换哪条腿、信号、持仓、调仓、成本），再写代码。策略原来的择时规则不变。
2. 信号只用开发期。想法检验结论是「没有信号」就停下汇报，不要换着花样试到通过为止。
3. 叠加后的版本跑成候选（candidate），原策略在同一时期原样跑一次做消融对照（ablation），两者并排对比。
4. 不改当前主版本，不动任何模拟实盘。只有候选通过 validate_backtest 且跑赢消融对照，才建议用户设为主版本。
5. ${o.dataReady === false ? `先准备 ${o.universe} 股票池（prepare_universe）。` : `开始前确认 ${o.universe} 股票池的数据已经准备好。`}
6. 汇报尝试次数；如果验证期之前已经用过，要说明验证期对比已经不干净。`;
}

/**
 * 跑一次评估：runModel({ system, input, model }) → 文本。回复不是 JSON 就带提醒再问一次。
 * 返回 sanitizeOptions 的结果；模型出错就抛出。
 */
export async function runAssessment({ context, legs, lang = 'zh', runModel, model = 'sonnet' }) {
  const system = assessPrompt(lang);
  const input = JSON.stringify(context);
  let raw;
  try { raw = extractJson(await runModel({ system, input, model })); } catch (e) {
    if (!/JSON/i.test(String(e && e.message))) throw e;
    raw = extractJson(await runModel({ system, input: `${input}\n\nYour previous reply was not valid JSON. Reply with the JSON object only.`, model }));
  }
  return sanitizeOptions(raw, legs, lang);
}

/* ---------------- 任务存储 ---------------- */

const layerDir = (projectsDir, projectId) => path.join(projectsDir, String(projectId), 'layers');
const isLayerId = (s) => typeof s === 'string' && /^[0-9]{8}-[0-9]{6}-[a-f0-9]{4}$/.test(s);

export function newLayerId(now = new Date()) {
  return `${now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}-${crypto.randomBytes(2).toString('hex')}`;
}

export async function saveLayer(projectsDir, job) {
  if (!isLayerId(job.layerId)) throw new Error('bad layer id');
  await mkdir(layerDir(projectsDir, job.projectId), { recursive: true });
  job.updatedAt = new Date().toISOString();
  await writeJsonAtomic(path.join(layerDir(projectsDir, job.projectId), `${job.layerId}.json`), job);
  return job;
}

export async function readLayer(projectsDir, projectId, layerId) {
  if (!isLayerId(layerId)) return null;
  try { return JSON.parse(await readFile(path.join(layerDir(projectsDir, projectId), `${layerId}.json`), 'utf8')); } catch { return null; }
}

export async function listLayers(projectsDir, projectId) {
  let names = [];
  try { names = (await readdir(layerDir(projectsDir, projectId))).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names.sort()) { const j = await readLayer(projectsDir, projectId, n.slice(0, -5)); if (j) out.push(j); }
  return out;
}
