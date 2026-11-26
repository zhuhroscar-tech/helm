// Helm · 「叠加一层」：在已有的 LEAN 策略（比如 GEM）上加一层。四类：
//   - qlib 选股：把策略里的美股 ETF 那条腿换成 qlib 选出的个股（模型评估出 2–4 个方案）；
//   - qlib 择时过滤：用标普 500 历史成分股算的市场宽度（HelmBreadth）确认 / 过滤策略的股票仓位；
//   - 仓位层：波动率目标（HelmVol），不选股，只按预测波动率缩放仓位；
//   - 策略组合：和其他通过检验的策略按事先定好的权重合在一起；还没有别的策略时，先做一个互补（低相关）的策略。
// 选股层经常「没有信号」：qlib 放不进去、之前的想法检验已经没有信号、或模型判断前景弱时，
// 仓位层和组合排在前面并标「推荐」。后两类是确定性的方案（不用模型写），保证一定出现。
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

// 基准、对照、消融、调试回测不是「策略」：不能拿来叠加，也不能当叠加前后对比的基线
const NOT_STRATEGY = new Set(['benchmark', 'control', 'ablation', 'debug']);
/** 以哪个回测为准：主版本 > 最新候选 > 最新一个跑完的策略回测（列表按时间倒序）。同步函数。 */
export function pickBacktest(backtests = []) {
  const done = backtests.filter((b) => b && !b.error && /complet/i.test(String(b.status || '')) && b.period !== 'holdout');
  return done.find((b) => b.role === 'main') || done.find((b) => b.role === 'candidate') || done.find((b) => !NOT_STRATEGY.has(b.role)) || null;
}

/**
 * 确定性预检。files = 主版本（或最新）回测的代码快照；backtests = 回测列表；universes = listUniverses() 的结果（可以是 null）。
 * 返回 { ok, reason?, legs: [{ etf, universe, label, pit, ready }], backtest }。同步函数。
 */
export function precheck({ files = [], backtests = [], universes = null } = {}) {
  const bt = pickBacktest(backtests);
  if (!bt) return { ok: false, reason: '这个项目还没有跑完的回测：先有一个策略，才能在上面叠加一层', legs: [] };
  const py = files.filter((f) => /\.py$/i.test(f.name));
  if (!py.length) return { ok: false, reason: '找不到这个策略的代码快照', legs: [], backtest: bt };
  // 仓位层已经用了就不再推荐；qlib 放不进去时不再整体拒绝，只是不给选股方案（仓位层 / 组合照样给）
  const usesVol = py.some((f) => /\bHelmVol\b/.test(String(f.content)));
  const usesBreadth = py.some((f) => /\bHelmBreadth\b/.test(String(f.content)));
  if (py.some((f) => /\bHelmSignals\b/.test(String(f.content)))) return { ok: true, legs: [], backtest: bt, usesVol, usesBreadth, qlibBlocked: '这个策略已经在用 qlib 信号（HelmSignals），不再叠加选股层' };
  const uniBy = new Map((universes || []).map((u) => [u.key, u]));
  const legs = [];
  for (const t of tickersInCode(py)) {
    const key = ETF_UNIVERSE[t];
    if (!key) continue;
    const u = uniBy.get(key);
    const pit = u ? (u.kind === 'point-in-time' ? 'pit' : u.kind === 'partial-point-in-time' ? 'partial' : u.kind === 'snapshot' ? 'snapshot' : STATIC_PIT[key]) : STATIC_PIT[key];
    legs.push({ etf: t, universe: key, label: (u && u.label) || UNI_LABEL[key], pit, ready: u ? Boolean(u.exported) : null });
  }
  if (!legs.length) return { ok: true, legs: [], backtest: bt, usesVol, usesBreadth, qlibBlocked: '代码里没有能换成个股的美股指数 ETF（比如 SPY、QQQ、DIA、IWM）：qlib 选股没有地方叠加' };
  return { ok: true, legs, backtest: bt, usesVol, usesBreadth, qlibBlocked: null };
}

/** 交给模型的材料（截断过）。同步函数。 */
/**
 * 这个项目之前的想法检验（qlib）：每个想法里最好的因子结论。jobs = listResearch().jobs。同步函数。
 * 返回 [{ idea, best: 'signal'|'weak'|'none', factors: [{ label, verdict }] }]
 */
export function priorIdeaResults(jobs = []) {
  const order = { signal: 2, weak: 1, none: 0 };
  return jobs.filter((j) => j && j.mode === 'idea' && j.ideaResult && Array.isArray(j.ideaResult.factors) && j.ideaResult.factors.length).map((j) => {
    const factors = j.ideaResult.factors.map((f) => ({ label: clip(f.label || f.name, 80), verdict: order[f.verdict] != null ? f.verdict : 'none' }));
    const best = factors.slice().sort((a, b) => order[b.verdict] - order[a.verdict])[0].verdict;
    return { idea: clip(j.idea || j.title, 200), best, factors };
  });
}

export function buildContext({ project = {}, spec = '', files = [], backtest = {}, holdoutRuns = 0, legs = [], priorIdeas = [], attribution = null, lang = 'zh' } = {}) {
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
    priorIdeaTests: priorIdeas.slice(-8),
    factorAttribution: attribution && attribution.available ? {
      r2: attribution.r2, alphaAnnual: attribution.alpha.annual, alphaT: attribution.alpha.t,
      exposures: attribution.exposures.map((e) => ({ factor: e.factor, beta: e.beta, t: e.t })), summary: attribution.summary,
    } : null,
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
- "factorAttribution" (if present) says which known factors already drive the strategy. A stock-selection layer that just adds more of an exposure the strategy already has (e.g. momentum picks on a strategy with a clear momentum beta) is not new; say so and rate it lower.
- "priorIdeaTests" lists this project's earlier idea tests. Never propose a factor that already came back "none" (or a re-worded version of it). Only propose genuinely different hypotheses with their own economic reason.
- Also judge the outlook honestly: well-known factors are weak in large caps, and the layer only matters while the strategy holds that ETF. Use "poor" when a stock-selection layer is unlikely to add anything; Helm will then recommend a position-sizing layer or a strategy portfolio instead.

Reply with ONE JSON object only, no other text, all text fields in ${L}:
{"summary":"one or two sentences on how well qlib stock selection fits this strategy","outlook":"promising|weak|poor",
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
  const outlook = raw && ['promising', 'weak', 'poor'].includes(raw.outlook) ? raw.outlook : null;
  return { summary: clip(raw && raw.summary, 400), outlook, options };
}

/**
 * 不选股的方案（确定性，不用模型写）：仓位层（波动率目标）和策略组合 / 先做互补策略。
 * peers = 其他项目的主版本 [{ projectId, name, sharpe }]。同步函数。
 */
export function alternativeOptions({ usesVol = false, usesBreadth = false, peers = [], equityLeg = null, breadth = null, lang = 'zh' } = {}) {
  const en = lang === 'en';
  const out = [];
  // qlib 择时过滤：策略有美股 ETF 那条腿时才有意义（宽度是美股大盘内部的指标）
  if (equityLeg && !usesBreadth) {
    const prep = breadth === 'ready' ? null : breadth === 'build' ? (en ? 'Breadth not built yet: build_breadth first' : '宽度还没算：先 build_breadth') : (en ? 'S&P 500 universe not prepared yet: prepare_universe first' : '标普 500 股票池还没准备：先 prepare_universe');
    out.push({
      id: 'timing', kind: 'timing', equityLeg, breadth,
      title: en ? 'Breadth timing filter' : '市场宽度择时过滤',
      tests: en ? `Does S&P 500 breadth (share of members above their 200-day average) predict ${equityLeg}'s next returns well enough to confirm the strategy's stock exposure?`
        : `标普 500 的市场宽度（站上 200 日均线的成分股比例）能不能预测 ${equityLeg} 后续收益，用来确认策略的股票仓位？`,
      how: en ? `Uses qlib's point-in-time S&P 500 members, which ETF prices alone can't show. First an honest time-series test on the development period (one pre-declared series, non-overlapping samples). Only if it finds a signal: the strategy holds ${equityLeg} only while breadth > 50% on its own rebalancing days, otherwise its usual safe asset.`
        : `用 qlib 的标普 500 历史成分股，这是只看 ETF 价格看不到的。先在开发期做一次时间序列检验（事先定好的一个序列，不重叠样本）。有信号才继续：策略只在自己的调仓日、宽度 > 50% 时持有 ${equityLeg}，否则转到它原来的避险资产。`,
      signal: en ? 'Market breadth from point-in-time members (HelmBreadth)' : '历史成分股算的市场宽度（HelmBreadth）',
      holdings: en ? 'Same assets; the filter only changes when the stock leg is held' : '资产不变，只改股票那条腿什么时候持有',
      trials: 2, risk: 'medium',
      risks: [
        ...(prep ? [prep] : []),
        ...(en ? ['Timing decisions are rare: about 240 independent observations in 20 years, so evidence is usually weak', 'Can keep you out of strong rebounds that start while breadth is still low']
          : ['择时很少做决定：20 年只有约 240 个独立样本，证据通常偏弱', '宽度还低时开始的强反弹可能会错过']),
      ],
      fit: null,
    });
  }
  if (!usesVol) {
    out.push({
      id: 'vol', kind: 'vol',
      title: en ? 'Volatility targeting' : '波动率目标（仓位层）',
      tests: en ? 'Does scaling position size by forecast volatility cut drawdowns without losing much Sharpe?' : '按预测波动率缩放仓位，能不能明显压低回撤、夏普又不怎么掉？',
      how: en ? 'Keep every signal and trade of the strategy. Each day HelmVol forecasts volatility from past returns only (HAR model, EWMA fallback) and scales the whole position to a 10% annual target, never above 1× leverage. One pre-declared variant.'
        : '策略的信号和买卖都不变。HelmVol 每天只用过去的收益预测波动率（HAR 模型，历史不够时用 EWMA），把整体仓位缩放到年化 10% 的目标，不加杠杆（最多 1 倍）。只跑事先定好的一个版本。',
      signal: en ? 'Forecast volatility (no return prediction)' : '预测波动率（不预测收益）',
      holdings: en ? 'Same holdings, scaled exposure' : '持仓不变，只缩放仓位',
      trials: 1, risk: 'low',
      risks: en ? ['Aims at lower drawdowns, not higher returns', 'Can lag a sudden volatility spike by a few days'] : ['目标是降回撤，不是提高收益', '波动突然放大时会慢几天'],
      fit: null,
    });
  }
  const names = peers.slice(0, 3).map((p) => p.name).join(en ? ', ' : '、');
  if (peers.length) {
    out.push({
      id: 'portfolio', kind: 'portfolio', peers: peers.slice(0, 5),
      title: en ? 'Combine with other strategies' : '和其他策略组合',
      tests: en ? `Is a fixed-weight mix with ${names} stronger than this strategy alone?` : `和「${names}」按固定权重合在一起，是否比单独这个策略更稳？`,
      how: en ? 'One LEAN strategy runs each strategy as a sleeve with weights fixed in advance (equal weight or inverse volatility from the development period), nets overlapping orders and charges real costs. Diversification works even without new alpha.'
        : '写成一个 LEAN 策略，把每个策略当成一个子账户，按事先定好的权重（等权，或用开发期算的波动率倒数），合并重叠的订单并按真实成本计算。分散化不需要找到新的超额收益也能起作用。',
      signal: en ? 'No new signal: combines existing strategies' : '没有新信号：组合已有策略',
      holdings: en ? 'Each sleeve keeps its own rules' : '每个子策略按自己的规则',
      trials: 1, risk: 'medium',
      risks: en ? ['Only strategies that passed validation may be included', 'Benefit depends on low correlation between them'] : ['只能放已经通过检验的策略', '效果取决于它们之间相关性低不低'],
      fit: null,
    });
  } else {
    out.push({
      id: 'complement', kind: 'complement',
      title: en ? 'Build a complementary strategy' : '先做一个互补策略',
      tests: en ? 'Can we find a strategy with low correlation to this one, so the two can later be combined?' : '能不能找到一个和当前策略相关性低的策略，以后两个合在一起更稳？',
      how: en ? 'You have no other validated strategy yet. The orchestrator proposes 2-3 ideas likely to be low-correlated (for example mean reversion or a bond/gold trend), you pick one, and it is built as a new project through the normal flow.'
        : '你还没有别的通过检验的策略。总控先提出 2–3 个大概率低相关的想法（比如均值回归、债券 / 黄金趋势），你选一个，作为新项目走正常流程。',
      signal: en ? 'A new, different strategy' : '一个新的、不同的策略',
      holdings: '', trials: 1, risk: 'medium',
      risks: en ? ['A new strategy must pass validation on its own first', 'Counts as a new idea in the trial registry'] : ['新策略要先自己通过检验', '在尝试次数里算一个新想法'],
      fit: null,
    });
  }
  return out;
}

/**
 * 合成最终的色块：qlib 方案 + 不选股方案 + 「不加这一层」。
 * 什么时候推荐不选股的方案：qlib 放不进去、之前的想法检验没有信号、模型判断前景弱 / 差、或没有合格的选股方案。
 * 推荐时不选股的方案排前面（标 recommended），选股方案最多留 2 个；否则选股方案最多 3 个在前。同步函数。
 */
export function composeOptions({ qlib = { summary: '', outlook: null, options: [] }, alts = [], priorIdeas = [], qlibBlocked = null, lang = 'zh' } = {}) {
  const en = lang === 'en';
  const layer = (qlib.options || []).filter((o) => o.kind === 'layer');
  const noSignal = priorIdeas.filter((p) => p.best === 'none').length;
  const reasons = [];
  if (qlibBlocked) reasons.push(qlibBlocked);
  if (noSignal) reasons.push(en ? `${noSignal} earlier idea test(s) on this project found no signal` : `这个项目之前有 ${noSignal} 次想法检验没有信号`);
  if (qlib.outlook === 'weak' || qlib.outlook === 'poor') reasons.push(en ? 'the agent rates the stock-selection outlook as weak' : '智能体判断选股层前景弱');
  if (!qlibBlocked && !layer.length) reasons.push(en ? 'no usable stock-selection option' : '没有合格的选股方案');
  const recommendAlt = reasons.length > 0 && alts.length > 0;
  const mark = (o, rec) => ({ ...o, recommended: rec });
  const none = (qlib.options || []).find((o) => o.kind === 'none') || sanitizeOptions(null, [], lang).options.at(-1);
  const options = recommendAlt
    ? [...alts.map((o) => mark(o, true)), ...layer.slice(0, 2).map((o) => mark(o, false))]
    : [...layer.slice(0, 3).map((o) => mark(o, false)), ...alts.map((o) => mark(o, false))];
  return { summary: qlib.summary || '', outlook: qlib.outlook || null, recommendAlt, why: reasons, options: [...options, none] };
}

/** 交给总控的任务（用户的界面语言）。同步函数。 */
export function taskMessage({ option, project = {}, backtest = {}, lang = 'zh' }) {
  const o = option;
  if (o.kind === 'vol' || o.kind === 'portfolio' || o.kind === 'complement' || o.kind === 'timing') return altTaskMessage({ option: o, backtest, lang });
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

function altTaskMessage({ option: o, backtest = {}, lang = 'zh' }) {
  const en = lang === 'en';
  const base = en ? `Baseline: backtest ${backtest.backtestId || ''} (${backtest.name || ''})` : `对照基准：回测 ${backtest.backtestId || ''}（${backtest.name || ''}）`;
  if (o.kind === 'timing') {
    const prep = o.breadth === 'ready' ? '' : o.breadth === 'build' ? (en ? 'build_breadth("sp500") first. ' : '先 build_breadth("sp500")。') : (en ? 'prepare_universe("sp500") first (it also builds breadth). ' : '先 prepare_universe("sp500")（会顺便算宽度）。');
    return en ? `Add a market-breadth timing filter to this project (chosen by the user from Helm's layer options).

${base}

Steps and rules (do not break):
1. Researcher: ${prep}Run test_timing_signal ONCE with series ["pct_above_200"] and horizons [21, 63] on the spec's development period. If the verdict is "no signal", stop and report; do not try other series, thresholds or horizons.
2. Only if "signal" (or "weak", reported as weak, and the user agrees): write the filter into spec.md first: on the strategy's own rebalancing days, hold ${o.equityLeg} only if HelmBreadth("sp500").value(self.time, "pct_above_200") > 0.5, otherwise hold the strategy's usual safe asset. Nothing else changes. One pre-declared variant.
3. Engineer: implement with HelmBreadth (see the "择时过滤" section of workspace/CLAUDE.md), run it as a candidate on the development period, and the original strategy unchanged as the ablation on the same period.
4. Pass only if validate_backtest passes AND Sharpe is not lower AND max drawdown is not larger than the ablation's. Holdout once at most, after the dev pass.
5. Do not change the current main version or any paper-trading session. Report the trial count and the number of independent observations.`
      : `在这个项目上加一层市场宽度择时过滤（用户从 Helm 的叠加方案里选的）。

${base}

步骤和规则（不能违反）：
1. 研究员：${prep}用 test_timing_signal 只测一次：series ["pct_above_200"]、horizons [21, 63]，开发期按 spec.md。结论「没有信号」就停下汇报，不要换序列、阈值或持有天数再试。
2. 只有「有信号」（或「信号弱」、照实说明且用户同意）才继续：先写进 spec.md：在策略原来的调仓日，HelmBreadth("sp500").value(self.time, "pct_above_200") > 0.5 才持有 ${o.equityLeg}，否则持有策略原来的避险资产；其他规则都不变。只做事先定好的一个版本。
3. 工程师：按 workspace/CLAUDE.md「择时过滤」一节用 HelmBreadth 实现，开发期跑成候选；原策略在同一时期原样跑一次做消融对照。
4. 合格线：通过 validate_backtest，并且夏普不低于对照、最大回撤不大于对照。开发期通过后验证期最多跑一次。
5. 不改当前主版本，不动任何模拟实盘。汇报尝试次数和独立样本数。`;
  }
  if (o.kind === 'vol') {
    return en ? `Add a volatility-targeting layer to this project (chosen by the user from Helm's layer options).

${base}

Rules (do not break):
1. Follow the "波动率目标（HelmVol）" section of workspace/CLAUDE.md. Write the layer into spec.md first: HelmVol(target=0.10, max_leverage=1.0), scale applied to the existing target weights; signals and trades unchanged.
2. One pre-declared variant only. Run it as a candidate on the development period, and the original strategy unchanged as the ablation on the same period.
3. Pass only if max drawdown is at least 25% smaller than the ablation's AND Sharpe is not more than 0.05 lower AND validate_backtest passes. Otherwise stop and report; do not try other targets.
4. Do not change the current main version or any paper-trading session. Holdout once at most, only after the dev pass.
5. Report the trial count.`
      : `在这个项目上加一层波动率目标（用户从 Helm 的叠加方案里选的）。

${base}

规则（不能违反）：
1. 按 workspace/CLAUDE.md 的「波动率目标（HelmVol）」一节做。先写进 spec.md：HelmVol(target=0.10, max_leverage=1.0)，缩放系数乘到原来的目标权重上；信号和买卖不变。
2. 只跑事先定好的一个版本：开发期跑成候选，原策略在同一时期原样跑一次做消融对照。
3. 通过条件：最大回撤比对照至少小 25%，并且夏普比对照低不超过 0.05，并且通过 validate_backtest。否则停下汇报，不要换别的目标波动率再试。
4. 不改当前主版本，不动任何模拟实盘。开发期通过后，验证期最多跑一次。
5. 汇报尝试次数。`;
  }
  if (o.kind === 'portfolio') {
    const list = (o.peers || []).map((p) => `${p.name}（project ${p.projectId}, backtest ${p.backtestId}）`).join(en ? '; ' : '；');
    return en ? `Build a strategy portfolio on this project (chosen by the user from Helm's layer options): combine this strategy with ${list}.

${base}

Rules (do not break):
1. The analyst first confirms each component's main version passes validate_backtest; drop any that does not. Never add strategies because they performed well recently.
2. Write spec.md first: components, weights fixed in advance (equal weight, or inverse volatility computed on the development period only), monthly rebalancing between sleeves, costs.
3. The engineer writes one LEAN strategy that runs each component as a sleeve, nets overlapping orders and charges costs. Run it as a candidate on the development period; run the best single component as the ablation on the same period.
4. Report the correlation matrix of the components and the combined Sharpe and drawdown next to each component. Never optimise weights on the full history.
5. Do not change any main version or paper-trading session. Report the trial count.`
      : `在这个项目上做策略组合（用户从 Helm 的叠加方案里选的）：把当前策略和 ${list} 合在一起。

${base}

规则（不能违反）：
1. 先由回测分析师确认每个组成策略的主版本都通过 validate_backtest，不通过的去掉。不能因为最近表现好就加进来。
2. 先写 spec.md：组成策略、事先定好的权重（等权，或只用开发期算的波动率倒数）、子策略之间每月再平衡、成本。
3. 工程师写一个 LEAN 策略，每个组成策略是一个子账户，合并重叠订单并计成本。开发期跑成候选；最好的单个组成策略在同一时期跑一次做消融对照。
4. 汇报组成策略之间的相关性矩阵，以及组合和每个组成策略的夏普、回撤并排对比。不要在全部历史上优化权重。
5. 不改任何主版本，不动任何模拟实盘。汇报尝试次数。`;
  }
  return en ? `Help me build a strategy that complements this one (chosen by the user from Helm's layer options), so the two can later be combined.

${base}

Steps:
1. Read this project's spec and results. Propose 2-3 strategy ideas likely to have low correlation with it (different asset classes or a different mechanism, e.g. mean reversion vs trend), each with its economic reason and expected correlation. Ask me to choose with ask_user before building anything.
2. Build the chosen one as a NEW project through the normal flow: spec.md first, dev period only, candidate backtest, validate_backtest. If it fails, stop and report; do not try variants until one passes.
3. Report its daily-return correlation with this strategy over the common development period.
4. Do not change this project's main version or paper trading.`
    : `帮我做一个和当前策略互补的策略（用户从 Helm 的叠加方案里选的），以后两个可以合在一起。

${base}

步骤：
1. 读这个项目的规则说明和结果，提出 2–3 个大概率和它低相关的策略想法（不同资产类别，或不同机制，比如均值回归对趋势），每个写明经济逻辑和预计相关性。动手之前用 ask_user 让我选。
2. 把选中的那个作为新项目走正常流程：先写 spec.md、只用开发期、候选回测、validate_backtest。没通过就停下汇报，不要换着花样试到通过为止。
3. 汇报它和当前策略在共同开发期里日收益的相关性。
4. 不改这个项目的主版本，不动模拟实盘。`;
}

/**
 * 跑一次评估：runModel({ system, input, model }) → 文本。回复不是 JSON 就带提醒再问一次。
 * 返回 sanitizeOptions 的结果；模型出错就抛出。
 */
export async function runAssessment({ context, legs, lang = 'zh', runModel, model = 'sonnet' }) {
  // 没有可替换的腿：不用问模型（省一次调用），只给不选股的方案
  if (!legs || !legs.length) return { summary: '', outlook: null, options: sanitizeOptions(null, [], lang).options };
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
