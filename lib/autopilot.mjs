// 自动研究（设计见 docs/AUTOPILOT.md）：用户不输入，总控自己提出想法、按流程检验，找到站得住的候选交给用户确认。
// 原则：在预算内诚实地找，找不到就说找不到。
//
// 这个文件只有纯函数（不读写文件、不调模型），服务端（server.mjs）负责存取运行记录：
//  - newRun / normalizeOptions：一轮的设置（预算、上限）
//  - kickoffMessage：交给总控的开工说明
//  - guard：工具调用之前的硬规则（先登记、预算、验证期关卡、不标 main、找到就停、超时）
//  - record：工具调用成功之后记账（建了哪个项目、跑了什么回测、检验结论）
//  - autoAnswer：自动研究里 ask_user 的问题由这里按规则回答，不弹给用户
//  - ledger / ledgerText：账本（代码算的，附在汇报后面）

// 自主探索：一轮可以换几次方向（每个方向登记一批想法，每批最多 BATCH_MAX 个），想法总数不超过 ideas。
// timingGate：择时想法按什么标准判「跑赢基准」。'return' = 收益跑赢（原来的做法）；'risk-adjusted' = 风险调整后跑赢
// （夏普差显著为正且最大回撤 ≤ 基准的 2/3，见 lib/stats.mjs）。由用户在开工前选定，一轮之内不能改。
export const DEFAULTS = { ideas: 6, versions: 2, directions: 3, usd: 20, minutes: 180, stopOnFind: true, scope: 'any', universe: 'sp500', direction: '', timingGate: 'return', untilFound: false };
// 连续模式（untilFound）：一轮没找到就自动开下一轮，直到找到、用量或时间用完。每一轮是一条新的运行记录、一个新的对话
// （上下文是干净的，「已经试过的」是最新的）；用量和时间上限是所有轮次合计的。
export const MAX_ROUNDS = 40;
export const TIMING_GATES = new Set(['return', 'risk-adjusted']);
export const BATCH_MAX = 3;
const SCOPES = new Set(['stock', 'timing', 'any']);
const clampInt = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

export function normalizeOptions(o = {}) {
  const b = o.budget || {};
  return {
    ideas: clampInt(b.ideas ?? o.ideas, 1, 10, DEFAULTS.ideas),
    versions: clampInt(b.versions ?? o.versions, 1, 5, DEFAULTS.versions),
    usd: clampInt(o.usd ?? (o.caps && o.caps.usd), 1, 500, DEFAULTS.usd),
    minutes: clampInt(o.minutes ?? (o.caps && o.caps.minutes), 10, 24 * 60, DEFAULTS.minutes),
    directions: clampInt(b.directions ?? o.directions, 1, 5, DEFAULTS.directions),
    direction: String(o.direction || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    stopOnFind: o.stopOnFind === undefined ? DEFAULTS.stopOnFind : Boolean(o.stopOnFind),
    scope: SCOPES.has(o.scope) ? o.scope : DEFAULTS.scope,
    timingGate: TIMING_GATES.has(o.timingGate) ? o.timingGate : DEFAULTS.timingGate,
    untilFound: o.untilFound === true,
    universe: /^[A-Za-z0-9_-]{1,40}$/.test(String(o.universe || '')) ? String(o.universe) : DEFAULTS.universe,
  };
}

export function newRun(opts = {}, { now = Date.now(), runId = null, lang = 'zh', chain = null } = {}) {
  const o = normalizeOptions(opts);
  return {
    untilFound: o.untilFound,
    // 连续模式的接力信息（只由服务端在开下一轮时传进来，不从网页请求里读）：
    // { id: 第一轮的 runId, round: 第几轮, usdTotal, minutesTotal, startedAt, spent: 前几轮花的, history: 前几轮每个方向的结果 }
    chain: o.untilFound ? (chain || { id: null, round: 1, usdTotal: o.usd, minutesTotal: o.minutes, startedAt: now, spent: 0, history: [] }) : null,
    runId: runId || `ap${now.toString(36)}`,
    status: 'running', reason: null, lang: lang === 'en' ? 'en' : 'zh',
    createdAt: now, endedAt: null, rootThreadId: null,
    scope: o.scope, universe: o.universe,
    budget: { ideas: o.ideas, versions: o.versions, directions: o.directions },
    caps: { usd: o.usd, minutes: o.minutes }, stopOnFind: o.stopOnFind,
    direction: o.direction, // 用户给的方向（可选）
    timingGate: o.timingGate, // 择时想法的判定标准（开工前定好）
    ideaVerdicts: {},    // projectId → 想法检验的结论（'signal' | 'weak' | 'none'），read_research 时记
    plan: null,          // 所有批次的想法，planIdea 从 1 开始全局编号：[{ title, logic, kind, failIf, batch }]
    batches: [],         // 方向：[{ name, whyNew, data }]，第 i 批的想法 batch = i + 1
    projects: {},        // projectId → planIdea（第几个想法，从 1 开始）
    current: null,       // 最近在做的项目
    tests: {},           // projectId → 想法检验次数
    backtests: {},       // backtestId → { projectId, role, period }
    validations: {},     // backtestId → { pass, period, at }
    found: [],           // 开发期、验证期都通过的候选 [{ projectId, backtestId, devBacktestId }]
    awaiting: [],        // 等用户确认的事（标 main 等）
    decisions: [],       // 自动回答的记录
    refusals: [],        // 被硬规则拦下的调用
    cost: 0,
  };
}

/* ---------------- 开工说明 ---------------- */

// 择时想法按什么标准判：开工说明里写明，免得 agent 一批批登记注定过不了的想法。
// （按「收益跑赢」判时，在股票和债券之间切换、目的是少跌的规则，牛市里收益上很难跑赢买入持有——
//  2026-11 的几轮真实运行里，登记的 8 个想法有 4 个是这一类。）
export function timingNote(run) {
  const en = run.lang === 'en';
  if (run.timingGate === 'risk-adjusted') {
    return en ? '- Timing ideas in this run are judged on the risk-adjusted standard the user chose before the run: the Sharpe difference versus buy-and-hold must be significantly positive AND the maximum drawdown at most 2/3 of the benchmark\'s. Helm sets this on each timing project when it is created; you cannot switch it. Stock ideas keep the return standard.'
      : '- 这一轮的择时想法按用户开工前选定的「风险调整」标准判：相对买入持有的夏普差显著为正，而且最大回撤 ≤ 基准的 2/3。Helm 在建择时项目时自动设好，你不能改。选股想法仍按收益标准。';
  }
  return en ? '- Timing ideas in this run are judged on RETURN: at least 90% confidence of beating buy-and-hold of the traded asset. A rule whose purpose is to lose less (switching from stocks to bonds or cash in bad regimes) gives up return in a long bull market and almost never passes this gate, however sensible it is. Only register a timing idea if you expect it to beat buy-and-hold on return; do not spend the budget on purely defensive switches. You cannot change the standard.'
    : '- 这一轮的择时想法按「收益」判：要有 90% 以上把握跑赢所交易资产的买入持有。目的是少跌的规则（坏的时候从股票换到债券或现金）在长牛市里会让出收益，逻辑再合理也几乎过不了这一关。只有预计在收益上也能跑赢买入持有的择时想法才登记，不要把预算花在纯防守的切换上。这个标准你不能改。';
}

export function kickoffMessage(run, ctx = {}) {
  const en = run.lang === 'en';
  const { ideas, versions } = run.budget;
  const dirs = run.budget.directions || 1;
  const batch = Math.min(BATCH_MAX, ideas);
  const extra = [ctx.tested ? `${en ? '[Already tested — do not repeat]' : '【已经试过的（不要再做）】'}\n${ctx.tested}` : '', ctx.menu ? `${en ? '[Data and tools you can use]' : '【可以用的数据和工具】'}\n${ctx.menu}` : ''].filter(Boolean).join('\n\n');
  const chainTxt = chainNote(run);
  const scope = run.scope === 'stock' ? (en ? 'stock selection (ranking stocks in a universe)' : '选股（在股票池里按特征挑股票）')
    : run.scope === 'timing' ? (en ? 'ETF timing (when to hold a few ETFs)' : 'ETF 择时（少数几个 ETF 之间的买卖时点）')
      : (en ? 'stock selection or ETF timing' : '选股或 ETF 择时都可以');
  if (en) {
    return `[Autopilot research] The user turned on autopilot: nobody will answer questions or give input in this run. Propose ideas yourself, test them through the normal Helm flow, then report.

Scope: ${scope}; universe: ${run.universe} (point-in-time members); development period and holdout as in CLAUDE.md; benchmarks as in CLAUDE.md.
Budget: at most ${ideas} idea(s) in total, in at most ${dirs} direction(s) (each direction is one registered batch of at most ${batch} ideas); for each idea at most ${versions} idea test(s) and at most ${versions} development-period candidate version(s).${run.direction ? `\nDirection given by the user: ${run.direction}` : ''}
Exploring on your own is the point of this run, not tuning parameters until something passes:
- A direction = a source of edge: a data set, a mechanism or a market (e.g. macro / rates, earnings quality changes, market breadth, cross-asset, a different universe). Prefer directions that are NOT just the best-known published factors in large caps; those are mostly arbitraged away.
- If a whole batch fails, you may open a NEW direction with another autopilot_plan call (direction.name, direction.whyNew = why it is a different source of edge, not the same idea with another parameter, window or universe). Each batch is reviewed by an independent reviewer; ideas it drops do not use budget — replace them.
- Inside one batch, each idea must be a different bet. Two indicators of the same thing (e.g. two measures of credit stress driving the same SPY/bond switch) will pass or fail together but cost two trials: register the better-motivated one and use the other slot for a different mechanism.
- Do not repeat anything in "already tested" below.
${timingNote(run)}
- Every registered idea must reach a verdict (no signal / no dev pass / holdout result). Helm checks this when you report and sends you back for anything left half-done while budget remains.
Rules (Helm enforces them in code; a refused call means stop that path, not find another way):
1. Before anything else, register the first batch with autopilot_plan (direction + ideas: one sentence, economic logic and what counts as failure for each). Work through a batch in order; no swapped or extra ideas inside a batch. A new batch only after every idea of the current batch has been started.
2. One project per idea: create_project with planIdea (1-based). Dispatch as usual: stock ideas researcher idea test → export if signal or weak → engineer dev period → analyst validate; timing ideas engineer dev period → analyst validate. Set kind (stock / timing) on every idea when you register it.
3. "No signal", or no dev pass within the version budget, ends that idea; move to the next. Do not retest on another universe, window or parameter.
4. Holdout only after the dev candidate passes validate_backtest, at most once per idea, no changes afterwards.
5. Never mark main or start paper trading; a candidate that passes both periods is left for the user to confirm.${run.stopOnFind ? ' Stop as soon as one candidate passes both periods.' : ''}
6. Final report: how many ideas, idea tests and dev versions, how many holdout looks, and each idea's verdict. If nothing was found, say so plainly. Helm appends its own ledger after your report.
If you need a decision, use ask_user as usual and tag each question's category (spec / trial / holdout / promotion / other) and the conservative option; Helm answers automatically by rule, nobody waits.${chainTxt ? `\n\n${chainTxt}` : ''}${extra ? `\n\n${extra}` : ''}`;
  }
  return `【自动研究】用户开启了自动研究：这一轮没有人会回答问题或给输入，你自己提出想法、按 Helm 的正常流程检验，最后汇报。

范围：${scope}；股票池：${run.universe}（历史成分股）；开发期、验证期和基准按 CLAUDE.md。
预算：一共最多 ${ideas} 个想法，最多 ${dirs} 个方向（每个方向登记一批，每批最多 ${batch} 个想法）；每个想法最多 ${versions} 次想法检验、最多 ${versions} 个开发期候选版本。${run.direction ? `\n用户指定的方向：${run.direction}` : ''}
这一轮的意义在于自己探索，而不是调参数调到通过：
- 「方向」是收益的来源：一类数据、一种机制或一个市场（比如宏观 / 利率、财报质量的变化、市场宽度、跨资产、别的股票池）。优先选不是「大盘股里最出名的公开因子」的方向，那些大多已经被套利掉了。
- 一批都不行，可以再调一次 autopilot_plan 开一个新方向：写 direction.name 和 direction.whyNew（为什么是不同的收益来源，而不是同一个想法换参数、换窗口、换股票池）。每一批都会先过独立审核员，被筛掉的想法不占预算，换掉再登记。
- 一批之内，每个想法要是不同的一注。同一件事的两个指标（比如两个衡量信用压力的序列，驱动同一个 SPY / 债券切换）会一起过或一起不过，却要算两次尝试：只登记逻辑更站得住的那个，另一个名额留给不同的机制。
- 下面「已经试过的」里的东西不要再做。
${timingNote(run)}
- 登记过的每个想法都要做到有结论（没有信号 / 开发期没通过 / 验证期结果）。你汇报时 Helm 会检查，预算还有而某个想法做到一半，会让你回去补完。
规则（Helm 在代码里强制；调用被拒绝就是这条路到此为止，不要换别的办法绕过去）：
1. 开工前先用 autopilot_plan 登记第一批（direction + 想法：每个写一句话、经济逻辑、怎样算失败）。一批之内按顺序做，不换题、不加题；这一批每个想法都开始做了，才能登记下一批。
2. 每个想法建一个项目，create_project 带 planIdea（第几个想法，从 1 开始）。照常派活：选股走 研究员想法检验 → 有信号（或信号弱）导出 → 工程师开发期 → 分析师检验；择时走 工程师开发期 → 分析师检验。登记时每个想法都要写 kind（stock / timing）。
3. 想法检验「没有信号」、或开发期在版本预算内都没通过，就结束这个想法，进入下一个。不要换股票池、换窗口、换参数重测。
4. 验证期：只有开发期候选通过 validate_backtest 之后才跑，每个想法最多一次，看完不改。
5. 不标 main、不开模拟实盘：开发期和验证期都通过的候选留给用户确认。${run.stopOnFind ? '找到一个这样的候选就停。' : ''}
6. 结束时汇报：试了几个想法、几次想法检验、几个开发期版本、验证期看了几次、每个想法的结论；没找到就直说没找到。Helm 会在你的汇报后面附上它自己记的账本。
需要拍板的地方照常用 ask_user，并给每个问题标 category（spec / trial / holdout / promotion / other）、给保守选项标 conservative：Helm 会按规则自动回答，不会等人。${chainTxt ? `\n\n${chainTxt}` : ''}${extra ? `\n\n${extra}` : ''}`;
}

/* ---------------- 连续模式：没找到就开下一轮 ---------------- */

const shortVerdict = (x, en) => (x.holdoutPassed && x.devPassed ? (en ? 'passed both periods' : '两段都通过')
  : x.holdoutFailed ? (en ? 'passed dev, failed holdout' : '开发期通过、验证期没通过')
    : x.devPassed ? (en ? 'passed dev' : '开发期通过')
      : x.devVersions ? (en ? 'no dev pass' : '开发期没通过')
        : x.tests ? (en ? 'no signal' : '想法检验没有信号') : (en ? 'not done' : '没做完'));

/** 这一轮每个方向的结果（给下一轮的开工说明用）：[{ round, name, whyNew, ideas: [{ title, kind, verdict }] }] */
export function roundSummary(run) {
  const en = run.lang === 'en';
  const L = ledger(run);
  const round = run.chain ? run.chain.round : 1;
  return (run.batches || []).map((b, i) => ({
    round, name: String(b.name || '').slice(0, 80), whyNew: String(b.whyNew || '').slice(0, 200),
    ideas: (run.plan || []).map((it, k) => ({ it, x: L.per.find((y) => y.planIdea === k + 1) })).filter(({ it }) => (it.batch || 1) === i + 1)
      .map(({ it, x }) => ({ title: String(it.title).slice(0, 90), kind: it.kind || null, verdict: x ? shortVerdict(x, en) : (en ? 'not started' : '没开始'), devPass: Boolean(x && x.devPassed) })),
  }));
}

/**
 * 这一轮结束后要不要接着开下一轮。返回 { options, chain }（传给 newRun）或 { stop: 原因 }；不是连续模式返回 null。
 * 只在这一轮正常结束（done）、没找到候选时接着开；出错 / 被停掉 / 中断不接（出错的那一轮用户重发消息恢复，做完后照样会接）。
 */
export function nextRound(run, { now = Date.now() } = {}) {
  if (!run || !run.untilFound || !run.chain || run.status !== 'done') return null;
  if (run.found.length) return { stop: 'found' };
  const c = run.chain;
  const L = ledger(run);
  // 有想法开发期通过了、验证期却没跑成（续跑两次也没补上）：这是眼下最值钱的线索，停下来交给用户，不接着花预算找别的
  if (L.per.some((x) => x.devPassed && !x.holdoutLooks)) return { stop: 'holdout-pending' };
  // 这一轮什么都没测（没登记成、或一个检验都没跑）：再开也是空转，停下来让用户看
  if (!(L.tests + L.devVersions)) return { stop: 'no-progress' };
  if (c.round >= MAX_ROUNDS) return { stop: 'rounds' };
  const spent = Math.round(((c.spent || 0) + (run.cost || 0)) * 1e4) / 1e4;
  const usdLeft = Math.floor(c.usdTotal - spent);
  const minutesLeft = Math.floor(c.minutesTotal - (now - c.startedAt) / 60000);
  if (usdLeft < 1) return { stop: 'usd' };
  if (minutesLeft < 10) return { stop: 'time' };
  return {
    options: { budget: { ...run.budget }, scope: run.scope, universe: run.universe, direction: run.direction || '', timingGate: run.timingGate || 'return', stopOnFind: run.stopOnFind, untilFound: true, usd: usdLeft, minutes: minutesLeft },
    chain: { id: c.id || run.runId, round: c.round + 1, usdTotal: c.usdTotal, minutesTotal: c.minutesTotal, startedAt: c.startedAt, spent, history: [...(c.history || []), ...roundSummary(run)].slice(-60) },
  };
}

/** 连续模式写进开工说明的一段：这是第几轮、前几轮每个方向的结果、接下来该怎么换方向 */
export function chainNote(run) {
  if (!run.untilFound || !run.chain) return '';
  const en = run.lang === 'en';
  const c = run.chain;
  const hist = (c.history || []).map((d) => `- ${en ? 'Round' : '第'} ${d.round}${en ? '' : ' 轮'} · ${d.name || (en ? 'direction' : '方向')}：${d.ideas.map((x) => `${x.title}${x.kind ? `（${x.kind}）` : ''} → ${x.verdict}`).join('；')}`);
  // 哪一类已经试得多、全没结果：选股（stock）和择时（timing）分开数
  const flat = (c.history || []).flatMap((d) => d.ideas);
  const dead = (kind) => { const xs = flat.filter((x) => x.kind === kind); return xs.length >= 4 && xs.every((x) => !x.devPass) ? xs.length : 0; };
  const ds = dead('stock'); const dt = dead('timing');
  const steer = [
    ds ? (en ? `Stock-selection ideas on ${run.universe} have now failed ${ds} times in a row in this search without one dev pass. Unless you have a clearly different kind of information, leave stock selection in this universe and work on something else (timing, cross-asset, macro, another universe from the data list).` : `这次搜索里，${run.universe} 上的选股想法已经连续 ${ds} 个没有一个通过开发期。除非有明显不同的信息来源，否则离开这个股票池里的选股，换别的（择时、跨资产、宏观、数据清单里的其他股票池）。`) : '',
    dt ? (en ? `Timing ideas have now failed ${dt} times in a row in this search. Change the kind of signal or the assets, not the indicator.` : `这次搜索里，择时想法已经连续 ${dt} 个没通过。换信号的类型或交易的资产，不要只是换一个指标。`) : '',
  ].filter(Boolean).join('\n');
  if (en) {
    return `[Continuous search — round ${c.round}] The user asked Helm to keep searching until a candidate passes both periods or the total budget ($${c.usdTotal}, ${c.minutesTotal} min; $${Number(c.spent || 0).toFixed(2)} spent so far) runs out. If this round finds nothing, Helm starts the next round by itself with a fresh conversation, so:
- Do not lower any standard or stretch an idea to get a pass in this round. A clean "nothing found" is the right way to end a round.
- Every test in every round raises the multiple-testing bar for everything after it. Spend each slot on the idea you believe in most, not on filling the list; registering fewer ideas than the budget is fine.
- You choose the directions. Use what earlier rounds learned: do not reopen a direction close to one that already failed, and say in direction.whyNew what earlier result made you pick this one.${hist.length ? `\nWhat earlier rounds of this search tried:\n${hist.join('\n')}` : ''}${steer ? `\n${steer}` : ''}`;
  }
  return `【连续搜索 · 第 ${c.round} 轮】用户要求一直找，直到有候选两段都通过，或者总预算用完（一共 $${c.usdTotal}、${c.minutesTotal} 分钟；到现在花了 $${Number(c.spent || 0).toFixed(2)}）。这一轮没找到，Helm 会自己开下一轮（新的对话），所以：
- 不要为了在这一轮里出结果而放宽任何标准、或者硬撑一个想法。干净地说「这一轮没找到」就是一轮正确的结束方式。
- 每一轮的每一次检验，都会抬高之后所有想法的多重检验门槛。每个名额留给你最有把握的想法，不要为了填满清单而登记；登记得比预算少没关系。
- 方向由你定。用上前几轮学到的：不要再开和已经失败的方向相近的方向；在 direction.whyNew 里写明是前面哪个结果让你选了这个方向。${hist.length ? `\n这次搜索前几轮试过的：\n${hist.join('\n')}` : ''}${steer ? `\n${steer}` : ''}`;
}

/* ---------------- 开工时附上的背景：已经试过的、可以用的数据 ---------------- */

/** 已经试过的（来自想法记录 lib/journal.mjs 的 entries）：只列「测过什么、结论是什么」，不列「哪个赚钱多」 */
export function testedText(entries = [], { lang = 'zh', max = 40 } = {}) {
  const en = lang === 'en';
  const ideas = entries.filter((e) => e.kind === 'idea').map((e) => `- ${en ? 'Idea test' : '想法检验'}：${String(e.what || '').slice(0, 120)}（${e.outcome || '?'}${e.projectName ? `；${en ? 'project' : '项目'}「${String(e.projectName).slice(0, 40)}」` : ''}）`);
  const byProj = new Map();
  for (const e of entries.filter((x) => x.kind === 'backtest' && x.projectId != null)) {
    const p = byProj.get(e.projectId) || { name: e.projectName, n: 0, verdicts: new Set() };
    p.n += 1;
    if (e.validated === 'fail' || /没过统计检验/.test(e.detail || '')) p.verdicts.add(en ? 'failed validation' : '没过统计检验');
    if (e.validated === 'pass') p.verdicts.add(en ? 'passed validation' : '通过统计检验');
    if (e.outcomeCode === 'main') p.verdicts.add(en ? 'main version' : '有主版本');
    if (e.stage === '验证期') p.verdicts.add(en ? 'holdout used' : '看过验证期');
    byProj.set(e.projectId, p);
  }
  const projs = [...byProj.values()].map((p) => `- ${en ? 'Strategy' : '策略'}「${String(p.name || '').slice(0, 60)}」：${p.n} ${en ? 'backtest(s)' : '个回测'}${p.verdicts.size ? `，${[...p.verdicts].join('、')}` : ''}`);
  const lines = [...ideas, ...projs];
  if (!lines.length) return '';
  const head = en ? `On this history Helm has already run ${ideas.length} idea test(s) and ${byProj.size} strategy project(s); every one counts toward the multiple-testing threshold.` : `这段历史上已经做过 ${ideas.length} 次想法检验、${byProj.size} 个策略项目，每一个都算进多重检验的门槛。`;
  return [head, ...lines.slice(-max)].join('\n');
}

export const MACRO_SERIES = ['DGS2', 'DGS10', 'T10Y2Y', 'T10Y3M', 'DFF', 'BAA10Y', 'VIXCLS', 'NFCI', 'UNRATE', 'CPIAUCSL'];

/** 可以用的数据和工具（股票池、价量、财报字段、宏观、市场宽度、自建数据集） */
export function dataMenu({ universes = [], fundFields = {}, datasets = [], breadth = false, lang = 'zh' } = {}) {
  const en = lang === 'en';
  const L = [];
  if (universes.length) L.push(`- ${en ? 'Universes' : '股票池'}：${universes.map((u) => `${u.key}${u.kind ? `（${u.kind}）` : ''}`).join('、')}`);
  L.push(en ? '- Price/volume factors for idea tests (test_idea): Qlib expressions over $open $high $low $close $volume $vwap $mkt' : '- 价量因子（test_idea）：Qlib 表达式，字段 $open $high $low $close $volume $vwap $mkt');
  const ff = Object.keys(fundFields);
  if (ff.length) L.push(`- ${en ? 'Point-in-time SEC fundamentals (test_idea "fundamental")' : '财报字段（时点正确，test_idea 的 fundamental）'}：${ff.join('、')}`);
  L.push(`- ${en ? 'FRED macro in LEAN via helm_data.HelmMacro("ID") (fetch_macro)' : '宏观序列（FRED，策略里用 helm_data.HelmMacro("ID")，fetch_macro 下载）'}：${MACRO_SERIES.join('、')} …`);
  L.push(en ? `- Market breadth (HelmBreadth, test_timing_signal): ${breadth ? 'ready' : 'build_breadth first'}` : `- 市场宽度（HelmBreadth，test_timing_signal）：${breadth ? '已经算好' : '要先 build_breadth'}`);
  if (datasets.length) L.push(`- ${en ? 'Custom datasets (HelmDataset)' : '自建数据集（HelmDataset）'}：${datasets.map((d) => d.name).filter(Boolean).slice(0, 20).join('、')}`);
  L.push(en ? '- Volatility targeting (HelmVol) for position sizing' : '- 波动率目标（HelmVol）：按风险调仓位');
  return L.join('\n');
}

/* ---------------- 登记前先过审核员（lib/critic.mjs） ---------------- */

/** 审核员要审的「题目」：这一批想法各是一个选项。label 带序号，保证唯一且不超过 80 字 */
export function planReviewItems(args = {}, lang = 'zh') {
  const en = lang === 'en';
  const ideas = Array.isArray(args.ideas) ? args.ideas : [];
  const d = args.direction && typeof args.direction === 'object' ? args.direction : {};
  return [{
    header: en ? 'Idea batch' : '想法清单',
    question: en ? `Autopilot wants to test this batch of ideas${d.name ? ` (direction: ${d.name})` : ''}. Which are worth testing?` : `自动研究想测这一批想法${d.name ? `（方向：${d.name}）` : ''}，哪些值得测？`,
    options: ideas.map((x, i) => ({ label: `${i + 1}. ${String(x.title || '')}`.slice(0, 80), description: `${String(x.logic || '').slice(0, 400)}${d.whyNew ? ` / ${en ? 'why new' : '为什么是新方向'}：${String(d.whyNew).slice(0, 200)}` : ''}` })),
  }];
}

/** 审核结论 → 放行或拒绝（被筛掉的想法要换掉再登记，不占预算）。审核出错（rv 为空）就放行 */
export function planReviewVerdict(rv, items, lang = 'zh') {
  const en = lang === 'en';
  const rq = rv && rv.questions && rv.questions[0];
  if (!rq || !rq.applicable) return { allow: true };
  const dropped = items[0].options.filter((o) => rq.options[o.label] && rq.options[o.label].verdict === 'drop');
  if (!dropped.length) return { allow: true };
  const why = dropped.map((o) => `${o.label}（${(rq.options[o.label].flags || []).join(', ') || 'other'}）：${rq.options[o.label].reason || ''}`).join('；');
  return {
    allow: false,
    message: en ? `Error: autopilot rule: the independent reviewer dropped ${dropped.length === items[0].options.length ? 'every idea in this batch' : 'some ideas'} — ${why}. Replace them and register again (this does not use budget).${rv.fix ? ` Reviewer's suggestion: ${rv.fix}` : ''}`
      : `错误：自动研究规则：独立审核员筛掉了${dropped.length === items[0].options.length ? '这一批的全部想法' : '其中一些想法'}——${why}。换掉再登记（不占预算）。${rv.fix ? `审核员的建议：${rv.fix}` : ''}`,
  };
}

/* ---------------- 账本 ---------------- */

const isDevCandidate = (b) => (b.role || 'candidate') === 'candidate' && (b.period || 'dev') === 'dev';
const isHoldout = (b) => b.period === 'holdout' || b.period === 'full';
const btsOf = (run, pid) => Object.entries(run.backtests).filter(([, b]) => Number(b.projectId) === Number(pid)).map(([id, b]) => ({ id, ...b }));

export function devVersions(run, pid) { return btsOf(run, pid).filter(isDevCandidate).length; }
export function holdoutLooks(run, pid) { return btsOf(run, pid).filter(isHoldout).length; }
export function devPassed(run, pid) { return btsOf(run, pid).some((b) => isDevCandidate(b) && run.validations[b.id] && run.validations[b.id].pass); }
export function ideasUsed(run) { return Object.keys(run.projects).length; }
const inRun = (run, pid) => pid != null && Object.prototype.hasOwnProperty.call(run.projects, String(Number(pid)));

export function ledger(run) {
  const per = Object.entries(run.projects).sort((a, b) => a[1] - b[1]).map(([pid, idx]) => {
    const bs = btsOf(run, pid);
    const hold = bs.filter(isHoldout);
    const holdV = hold.map((b) => run.validations[b.id]).filter(Boolean);
    return {
      planIdea: idx, projectId: Number(pid), title: run.plan && run.plan[idx - 1] ? run.plan[idx - 1].title : '', batch: run.plan && run.plan[idx - 1] ? run.plan[idx - 1].batch || 1 : 1,
      tests: run.tests[pid] || 0, devVersions: bs.filter(isDevCandidate).length, devValidated: bs.filter((b) => isDevCandidate(b) && run.validations[b.id]).length, holdoutLooks: hold.length,
      devPassed: devPassed(run, pid), holdoutPassed: holdV.some((v) => v.pass), holdoutFailed: holdV.length > 0 && !holdV.some((v) => v.pass),
    };
  });
  return {
    registered: run.plan ? run.plan.length : 0, ideas: per.length, directions: (run.batches || []).length,
    tests: per.reduce((a, x) => a + x.tests, 0), devVersions: per.reduce((a, x) => a + x.devVersions, 0), holdoutLooks: per.reduce((a, x) => a + x.holdoutLooks, 0),
    found: run.found.length, refusals: run.refusals.length, decisions: run.decisions.length, cost: run.cost, per,
  };
}

export function ledgerText(run) {
  const en = run.lang === 'en';
  const L = ledger(run);
  const verdict = (x) => (x.holdoutPassed && x.devPassed ? (en ? 'passed dev and holdout — waiting for you to confirm' : '开发期和验证期都通过，等你确认')
    : x.holdoutFailed ? (en ? 'passed dev, failed holdout' : '开发期通过，验证期没通过')
      : x.devPassed ? (en ? 'passed dev, holdout not run' : '开发期通过，验证期没跑')
        : x.devVersions && x.devValidated ? (en ? `no dev pass (${x.devVersions} version(s), ${x.devValidated} validated)` : `开发期没通过（${x.devVersions} 个版本，检验了 ${x.devValidated} 个）`)
          : x.devVersions ? (en ? `${x.devVersions} dev version(s), none validated` : `${x.devVersions} 个开发期版本，没做统计检验`)
          : x.tests ? (en ? 'stopped at the idea test' : '停在想法检验') : (en ? 'not started' : '没开始'));
  const lines = en
    ? [`Helm ledger (counted by code): ${L.ideas}/${run.budget.ideas} ideas, ${L.tests} idea tests, ${L.devVersions} dev versions, ${L.holdoutLooks} holdout look(s), ${L.found} candidate(s) passing both periods, ${L.refusals} call(s) refused by the rules, ${L.decisions} question(s) answered automatically.`]
    : [`Helm 账本（代码记的）：${L.ideas}/${run.budget.ideas} 个想法，${L.tests} 次想法检验，${L.devVersions} 个开发期版本，验证期看了 ${L.holdoutLooks} 次，${L.found} 个候选两段都通过；${L.refusals} 次调用被规则拦下，${L.decisions} 个问题自动回答。`];
  if (L.directions) lines[0] += en ? ` Directions: ${L.directions}/${run.budget.directions || 1}.` : `方向：${L.directions}/${run.budget.directions || 1} 个。`;
  const batches = run.batches || [];
  (run.plan || []).forEach((it, i) => {
    const b = it.batch || 1;
    if (batches.length > 1 && (i === 0 || (run.plan[i - 1].batch || 1) !== b)) lines.push(`${en ? 'Direction' : '方向'} ${b}${batches[b - 1] && batches[b - 1].name ? `「${batches[b - 1].name}」` : ''}：`);
    const x = L.per.find((y) => y.planIdea === i + 1);
    lines.push(`- ${en ? 'Idea' : '想法'} ${i + 1}「${it.title}」${x ? `（project ${x.projectId}）：${verdict(x)}` : `：${en ? 'not started' : '没开始'}`}`);
  });
  return lines.join('\n');
}

/* ---------------- 硬规则 ---------------- */

const T = (run, zh, en) => (run.lang === 'en' ? en : zh);
const normTitle = (t) => String(t || '').toLowerCase().replace(/[\s，,。.:：;；、（）()「」"'\-—_]/g, '');
const refuse = (run, tool, message) => ({ allow: false, message: `${T(run, '错误：自动研究规则：', 'Error: autopilot rule: ')}${message}` });

// 只读的工具：一轮结束之后（用户接着问结果）还能用
export const READ_ONLY = new Set(['list_projects', 'read_project', 'read_file', 'list_data', 'list_datasets', 'read_dataset', 'wait_for_backtest', 'read_backtest', 'list_backtests',
  'read_backtest_orders', 'read_backtest_log', 'read_backtest_code', 'read_tuning', 'list_universes', 'universe_members', 'research_status', 'read_research', 'list_signals',
  'list_paper_sessions', 'read_paper_session', 'ask_user', 'approve', 'verify_changes', 'revert_my_changes']);

/** 工具调用之前：{ allow: true } 或 { allow: false, message }。now 用于检查时间上限 */
export function guard(run, tool, args = {}, { now = Date.now() } = {}) {
  if (!run || run.status !== 'running') {
    if (READ_ONLY.has(tool)) return { allow: true };
    return refuse(run || { lang: 'zh' }, tool, T(run || {}, '这一轮自动研究已经结束：只能查看结果，不能再开新的工作。', 'this autopilot run has ended: you can look at results but not start new work.'));
  }
  const pid = args.projectId != null ? Number(args.projectId) : null;
  const started = ['autopilot_plan', 'create_project', 'test_idea', 'create_backtest', 'start_research', 'tune_backtest', 'sensitivity_backtest'];
  if (started.includes(tool) && now - (run.resumedAt || run.createdAt) > run.caps.minutes * 60000) return refuse(run, tool, T(run, `超过时间上限（${run.caps.minutes} 分钟），停下汇报。`, `time limit (${run.caps.minutes} min) reached; stop and report.`));
  if (started.includes(tool) && run.cost >= run.caps.usd) return refuse(run, tool, T(run, `用量超过上限（$${run.caps.usd}），停下汇报。`, `usage cap ($${run.caps.usd}) reached; stop and report.`));
  const foundStop = run.stopOnFind && run.found.length > 0;

  switch (tool) {
    case 'autopilot_plan': {
      const ideas = Array.isArray(args.ideas) ? args.ideas : [];
      const used = run.plan ? run.plan.length : 0;
      const left = run.budget.ideas - used;
      const batchMax = Math.min(BATCH_MAX, run.budget.ideas);
      const dir = args.direction && typeof args.direction === 'object' ? args.direction : {};
      if (!ideas.length) return refuse(run, tool, T(run, '想法清单是空的。', 'the idea list is empty.'));
      if (ideas.some((x) => !x || !String(x.title || '').trim() || !String(x.logic || '').trim())) return refuse(run, tool, T(run, '每个想法都要有 title（一句话）和 logic（经济逻辑）。', 'every idea needs a title and its economic logic.'));
      // 择时按风险调整标准判的这一轮：kind 决定用哪个标准，必须写明
      if (run.timingGate === 'risk-adjusted' && ideas.some((x) => x.kind !== 'stock' && x.kind !== 'timing')) return refuse(run, tool, T(run, '每个想法都要写 kind：stock（选股）或 timing（ETF 择时）。', 'every idea needs kind: stock or timing.'));
      if (run.plan) {
        // 换方向：上一批都开始做了、方向数和想法总数都还有预算、写清楚为什么是新的收益来源
        if (foundStop) return refuse(run, tool, T(run, '已经找到两段都通过的候选，按设置停下汇报。', 'a candidate already passed both periods; stop and report.'));
        if ((run.batches || []).length >= (run.budget.directions || 1)) return refuse(run, tool, T(run, `方向数已经用完（最多 ${run.budget.directions || 1} 个），停下汇报。`, `no directions left (at most ${run.budget.directions || 1}); stop and report.`));
        const notStarted = run.plan.map((_, i) => i + 1).filter((k) => !Object.values(run.projects).includes(k));
        if (notStarted.length) return refuse(run, tool, T(run, `这一批还有想法没开始（第 ${notStarted.join('、')} 个）：先做完这一批，才能换方向。`, `ideas ${notStarted.join(', ')} of the current batch have not started; finish the batch before a new direction.`));
        if (!String(dir.name || '').trim() || !String(dir.whyNew || '').trim()) return refuse(run, tool, T(run, '换方向要写 direction.name 和 direction.whyNew（为什么是不同的收益来源，而不是同一个想法换参数 / 窗口 / 股票池）。', 'a new direction needs direction.name and direction.whyNew (why it is a different source of edge, not the same idea with other parameters / window / universe).'));
        const seen = new Set(run.plan.map((x) => normTitle(x.title)));
        const dup = ideas.find((x) => seen.has(normTitle(x.title)));
        if (dup) return refuse(run, tool, T(run, `「${String(dup.title).slice(0, 60)}」已经登记过，不能再做一次。`, `"${String(dup.title).slice(0, 60)}" was already registered.`));
      }
      if (left <= 0) return refuse(run, tool, T(run, `想法总数的预算（${run.budget.ideas} 个）已经用完，停下汇报。`, `the idea budget (${run.budget.ideas}) is used up; stop and report.`));
      if (ideas.length > Math.min(batchMax, left)) return refuse(run, tool, T(run, `这一批最多 ${Math.min(batchMax, left)} 个想法（每批最多 ${batchMax} 个，想法总数还剩 ${left} 个）。`, `at most ${Math.min(batchMax, left)} ideas in this batch (at most ${batchMax} per batch, ${left} left in total).`));
      return { allow: true };
    }
    case 'create_project': {
      if (!run.plan) return refuse(run, tool, T(run, '先用 autopilot_plan 登记想法清单。', 'register the idea list with autopilot_plan first.'));
      if (foundStop) return refuse(run, tool, T(run, '已经找到两段都通过的候选，按设置停下汇报。', 'a candidate already passed both periods; stop and report.'));
      const k = Number(args.planIdea);
      if (!Number.isInteger(k) || k < 1 || k > run.plan.length) return refuse(run, tool, T(run, `create_project 要带 planIdea（1–${run.plan.length}），清单外的想法不能做。`, `create_project needs planIdea (1-${run.plan.length}); ideas outside the list are not allowed.`));
      if (Object.values(run.projects).includes(k)) return refuse(run, tool, T(run, `第 ${k} 个想法已经建过项目，一个想法只建一个项目。`, `idea ${k} already has a project; one project per idea.`));
      return { allow: true };
    }
    case 'test_idea': case 'start_research': {
      if (!run.plan) return refuse(run, tool, T(run, '先用 autopilot_plan 登记想法清单。', 'register the idea list with autopilot_plan first.'));
      if (!inRun(run, pid)) return refuse(run, tool, T(run, `项目 ${pid} 不是这一轮自动研究建的项目。`, `project ${pid} was not created in this autopilot run.`));
      if (foundStop) return refuse(run, tool, T(run, '已经找到两段都通过的候选，按设置停下汇报。', 'a candidate already passed both periods; stop and report.'));
      if (tool === 'start_research' && Number(args.tune) > 0) return refuse(run, tool, T(run, '自动研究里不调参（start_research 的 tune 要为 0）。', 'no tuning in autopilot (start_research tune must be 0).'));
      if ((run.tests[pid] || 0) >= run.budget.versions) return refuse(run, tool, T(run, `这个想法的想法检验预算（${run.budget.versions} 次）用完了：结束这个想法。`, `this idea's test budget (${run.budget.versions}) is used up; end this idea.`));
      return { allow: true };
    }
    case 'create_backtest': {
      if (!run.plan) return refuse(run, tool, T(run, '先用 autopilot_plan 登记想法清单。', 'register the idea list with autopilot_plan first.'));
      if (!inRun(run, pid)) return refuse(run, tool, T(run, `项目 ${pid} 不是这一轮自动研究建的项目。`, `project ${pid} was not created in this autopilot run.`));
      if (args.role === 'main') return refuse(run, tool, T(run, '自动研究不能标 main：用 candidate，通过的留给用户确认。', 'autopilot cannot mark main; use candidate and leave it for the user.'));
      const b = { role: args.role || 'candidate', period: args.period || 'dev' };
      if (isHoldout(b)) {
        if (!devPassed(run, pid)) return refuse(run, tool, T(run, '这个想法的开发期候选还没有通过 validate_backtest，不能看验证期。', 'no dev candidate of this idea has passed validate_backtest; the holdout stays closed.'));
        if (holdoutLooks(run, pid) >= 1) return refuse(run, tool, T(run, '这个想法的验证期已经看过一次，不能再看。', 'this idea has already used its one holdout look.'));
        return { allow: true };
      }
      if (isDevCandidate(b)) {
        if (foundStop) return refuse(run, tool, T(run, '已经找到两段都通过的候选，按设置停下汇报。', 'a candidate already passed both periods; stop and report.'));
        if (holdoutLooks(run, pid) >= 1) return refuse(run, tool, T(run, '这个想法已经看过验证期，不能再改出新版本。', 'this idea has seen its holdout; no new versions.'));
        if (devVersions(run, pid) >= run.budget.versions) return refuse(run, tool, T(run, `这个想法的开发期版本预算（${run.budget.versions} 个）用完了：结束这个想法。`, `this idea's dev version budget (${run.budget.versions}) is used up; end this idea.`));
      }
      return { allow: true };
    }
    case 'tune_backtest':
      // 调参一次就是几十个候选：自动研究的版本预算管不住它
      return refuse(run, tool, T(run, '自动研究里不调参：参数按规则说明事先定好，版本预算内改规则就是新版本。', 'no parameter tuning in autopilot: parameters are fixed in the spec; a rule change within the version budget is a new version.'));
    case 'update_backtest':
      if (args.role === 'main') return refuse(run, tool, T(run, '自动研究不能标 main，留给用户确认。', 'autopilot cannot mark main; the user confirms.'));
      if (args.period && inRun(run, pid) && args.backtestId && run.backtests[args.backtestId] && args.period !== run.backtests[args.backtestId].period) return refuse(run, tool, T(run, '自动研究里不能改回测的时间段标签。', 'autopilot cannot relabel a backtest\'s period.'));
      return { allow: true };
    default:
      return { allow: true };
  }
}

/* ---------------- 记账 ---------------- */

/** 工具调用成功之后记账（会改 run）。返回 { found: 新找到的候选 | null } */
export function record(run, tool, args = {}, result = '', { isError = false, now = Date.now() } = {}) {
  const text = String(result || '');
  if (isError || /^(错误|Error)[:：]/.test(text)) return { found: null };
  const pid = args.projectId != null ? Number(args.projectId) : null;
  if (pid != null && inRun(run, pid)) run.current = pid;
  switch (tool) {
    case 'autopilot_plan': {
      run.batches = run.batches || [];
      const d = args.direction && typeof args.direction === 'object' ? args.direction : {};
      run.batches.push({ name: String(d.name || '').slice(0, 120) || `${run.lang === 'en' ? 'Direction' : '方向'} ${run.batches.length + 1}`, whyNew: String(d.whyNew || '').slice(0, 600), data: String(d.data || '').slice(0, 300), at: now });
      const b = run.batches.length;
      const from = (run.plan || []).length + 1;
      run.plan = [...(run.plan || []), ...(args.ideas || []).map((x) => ({ title: String(x.title || '').slice(0, 200), logic: String(x.logic || '').slice(0, 600), kind: x.kind || null, failIf: String(x.failIf || '').slice(0, 300), batch: b }))];
      const to = run.plan.length;
      const note = run.lang === 'en' ? `Direction ${b} of at most ${run.budget.directions || 1}; these ideas are planIdea ${from}${to > from ? `-${to}` : ''}; ${run.budget.ideas - to} idea(s) left in the budget.`
        : `这是第 ${b} 个方向（最多 ${run.budget.directions || 1} 个）；这一批的 planIdea 是 ${from}${to > from ? `–${to}` : ''}；想法预算还剩 ${run.budget.ideas - to} 个。`;
      return { found: null, note };
    }
    case 'create_project': {
      const m = text.match(/projectId=(\d+)/);
      if (m) { run.projects[m[1]] = Number(args.planIdea); run.current = Number(m[1]); }
      return { found: null };
    }
    case 'test_idea': case 'start_research':
      if (pid != null) run.tests[pid] = (run.tests[pid] || 0) + 1;
      return { found: null };
    case 'test_timing_signal': {
      // 择时信号检验（市场宽度等）：结论当场返回（每个序列一行「**有信号 / 信号弱 / 没有信号**」）。
      // 之前不记账：账本写「0 次想法检验」，交付检查还把检验过、没有信号的想法当成「没跑开发期」催着做
      if (pid == null || !inRun(run, pid)) return { found: null };
      run.tests[pid] = (run.tests[pid] || 0) + 1;
      const vs = [...text.matchAll(/\*\*(有信号|信号弱|没有信号)\*\*/g)].map((m) => m[1]);
      if (vs.length) { run.ideaVerdicts = run.ideaVerdicts || {}; run.ideaVerdicts[pid] = vs.includes('有信号') ? 'signal' : vs.includes('信号弱') ? 'weak' : 'none'; }
      return { found: null };
    }
    case 'create_backtest': {
      const m = text.match(/backtestId=([A-Za-z0-9_-]+)/);
      if (m && pid != null) run.backtests[m[1]] = { projectId: pid, role: args.role || 'candidate', period: args.period || 'dev', at: now };
      return { found: null };
    }
    case 'update_backtest':
      if (args.backtestId && run.backtests[args.backtestId]) { if (args.role) run.backtests[args.backtestId].role = args.role; }
      return { found: null };
    case 'read_research': {
      // 想法检验的结论（每个因子一行「结论：有信号 / 信号弱 / 没有信号」）：记最好的那个，交付检查要用
      if (pid == null || !inRun(run, pid)) return { found: null };
      const vs = [...text.matchAll(/结论：\s*(有信号|信号弱|没有信号)/g)].map((m) => m[1]);
      if (!vs.length) return { found: null };
      run.ideaVerdicts = run.ideaVerdicts || {};
      run.ideaVerdicts[pid] = vs.includes('有信号') ? 'signal' : vs.includes('信号弱') ? 'weak' : 'none';
      return { found: null };
    }
    case 'validate_backtest': {
      const b = run.backtests[args.backtestId];
      const pass = /结论：✅|Verdict: ✅|✅ 通过|✅ pass/i.test(text) ? true : /结论：❌|❌/.test(text) ? false : null;
      if (pass === null || !b) return { found: null };
      run.validations[args.backtestId] = { pass, period: b.period, at: now };
      if (pass && isHoldout(b) && devPassed(run, b.projectId) && !run.found.some((f) => f.backtestId === args.backtestId)) {
        const dev = btsOf(run, b.projectId).filter((x) => isDevCandidate(x) && run.validations[x.id] && run.validations[x.id].pass).pop();
        const f = { projectId: Number(b.projectId), backtestId: args.backtestId, devBacktestId: dev ? dev.id : null, at: now };
        run.found.push(f);
        return { found: f };
      }
      return { found: null };
    }
    default:
      return { found: null };
  }
}

/* ---------------- 交付检查：登记过的想法有没有做到有结论 ---------------- */

/**
 * 总控汇报时，哪些登记过的想法还停在半路（预算、时间都还有的时候才算）。返回给 agent 的待办清单，空数组 = 可以结束。
 * 起因：2026-11-24 的一轮只花了 $1.95（上限 $20）就结束了，三个想法里一个「信号弱」没进开发期、一个建了项目没回测。
 * 这里不替 agent 做决定：只指出流程上明确该做而没做的一步。开发期没通过后要不要用剩下的版本预算，仍由 agent 判断。
 */
export function unfinished(run, { now = Date.now() } = {}) {
  if (!run || run.status !== 'running' || !run.plan || !run.plan.length) return [];
  if (run.stopOnFind && run.found.length) return [];
  if (run.cost >= run.caps.usd) return [];
  if (now - (run.resumedAt || run.createdAt) > run.caps.minutes * 60000) return [];
  const en = run.lang === 'en';
  const out = [];
  const pidOf = (k) => { const e = Object.entries(run.projects).find(([, v]) => v === k); return e ? Number(e[0]) : null; };
  run.plan.forEach((it, i) => {
    const k = i + 1;
    const name = `${en ? 'Idea' : '想法'} ${k}「${String(it.title).slice(0, 50)}」`;
    const pid = pidOf(k);
    if (pid == null) { out.push(en ? `${name}: registered but never started — create its project (planIdea=${k}) and run it through the flow` : `${name}：登记了但没开始——建项目（planIdea=${k}），按流程做`); return; }
    const bs = btsOf(run, pid);
    const dev = bs.filter(isDevCandidate);
    const hold = bs.filter(isHoldout);
    const tests = run.tests[pid] || 0;
    const verdict = (run.ideaVerdicts || {})[pid] || null;
    const p = en ? `${name} (project ${pid})` : `${name}（项目 ${pid}）`;
    const notValidated = [...dev, ...hold].filter((b) => !run.validations[b.id]);
    if (notValidated.length) { out.push(en ? `${p}: backtest ${notValidated.map((b) => b.id).join(', ')} has no validate_backtest verdict — have the analyst validate it` : `${p}：回测 ${notValidated.map((b) => b.id).join('、')} 还没有 validate_backtest 的结论——交给分析师检验`); return; }
    if (hold.length) return; // 验证期看过并检验过：这个想法结束
    if (dev.length) {
      if (devPassed(run, pid)) out.push(en ? `${p}: passed the dev period but the holdout was never run — engineer runs it once, analyst validates` : `${p}：开发期通过了但没跑验证期——工程师跑一次验证期，分析师检验`);
      return; // 开发期没通过：结束（要不要再改一版由 agent 定）
    }
    if (tests > 0) {
      if (!verdict) out.push(en ? `${p}: idea test submitted but its verdict was never read — read_research, then act on it` : `${p}：想法检验提交了但没读结论——read_research，再按结论走`);
      else if (verdict !== 'none') out.push(en ? `${p}: the ${it.kind === 'timing' ? 'signal' : 'idea'} test found ${verdict === 'signal' ? 'a signal' : 'a weak signal'} but no dev-period backtest followed — ${it.kind === 'timing' ? '' : 'export the signal, '}engineer runs the dev period, analyst validates` : `${p}：${it.kind === 'timing' ? '信号检验' : '想法检验'}是「${verdict === 'signal' ? '有信号' : '信号弱'}」，但没有进开发期——${it.kind === 'timing' ? '' : '导出信号，'}工程师跑开发期，分析师检验`);
      return;
    }
    out.push(it.kind === 'timing'
      ? (en ? `${p}: project created but no dev-period backtest — engineer writes the code and runs the dev period, analyst validates` : `${p}：建了项目但没跑开发期——工程师写代码跑开发期，分析师检验`)
      : (en ? `${p}: project created but nothing was tested — run the idea test (stock) or the dev-period backtest (timing)` : `${p}：建了项目但什么都没测——做想法检验（选股）或跑开发期回测（择时）`));
  });
  return out;
}

/** 这一轮里，按风险调整标准判的项目（择时想法 + 用户开工前选了 risk-adjusted）。服务端建项目后据此写 project.json */
export function wantsRiskAdjusted(run, planIdea) {
  const it = run && run.plan ? run.plan[Number(planIdea) - 1] : null;
  return Boolean(run && run.timingGate === 'risk-adjusted' && it && it.kind === 'timing');
}

/* ---------------- 自动回答 ---------------- */

const CONSERVATIVE_RE = /^(不|别|停|先不|暂不|跳过|保持|结束|放弃|no\b|don['’]?t|stop|skip|keep|leave|end\b)/i;
export const CATEGORIES = new Set(['spec', 'trial', 'holdout', 'promotion', 'other']);

function trialLeft(run) {
  const pid = run.current;
  const ideasLeft = run.budget.ideas - ideasUsed(run);
  const versionsLeft = pid != null && inRun(run, pid) ? run.budget.versions - Math.max(devVersions(run, pid), run.tests[pid] || 0) : 0;
  return { ideasLeft, versionsLeft, any: ideasLeft > 0 || versionsLeft > 0 };
}

/**
 * q: { questions: [{ question, category?, options: [{ label, conservative? }] }] }；review: 审核员的结果（lib/critic.mjs，可以为空）。
 * 返回 { answers: [{ selected: [label] }], text: 给 agent 的回答, decisions: [...], awaiting: [...] }
 */
export function autoAnswer(run, q, review = null, { now = Date.now() } = {}) {
  const en = run.lang === 'en';
  const decisions = [];
  const awaiting = [];
  const answers = [];
  const lines = [];
  if (review && review.noneWorth) {
    q.questions.forEach((qq) => { answers.push({ selected: [] }); decisions.push({ at: now, question: qq.question, category: qq.category || null, picked: null, why: en ? 'the reviewer judged none of the options worth doing' : '审核员认为所有选项都不值得做' }); });
    return {
      answers, decisions, awaiting,
      text: en ? `Autopilot answered automatically: the independent reviewer judged none of these options worth testing (${review.summary || ''}). End this idea and move on; do not retry it in another form.`
        : `自动研究自动回答：独立审核员认为这组选项都不值得测（${review.summary || ''}）。结束这个想法，进入下一个；不要换个说法再试。`,
    };
  }
  const left = trialLeft(run);
  q.questions.forEach((qq, i) => {
    const rq = review && review.questions ? review.questions[i] : null;
    const verdictOf = (o) => (rq && rq.applicable && rq.options && rq.options[o.label] ? rq.options[o.label].verdict : null);
    const live = qq.options.filter((o) => verdictOf(o) !== 'drop');
    const cons = live.find((o) => o.conservative === true) || live.find((o) => CONSERVATIVE_RE.test(o.label)) || null;
    const rec = live[0] || null;
    const cat = CATEGORIES.has(qq.category) ? qq.category : null;
    let pick = null; let why = '';
    if (cat === 'promotion') {
      pick = cons; why = en ? 'marking main / paper trading is left for the user to confirm' : '标 main / 开模拟留给用户确认';
      awaiting.push({ at: now, question: qq.question, projectId: run.current });
    } else if (cat === 'holdout') {
      const ok = run.current != null && devPassed(run, run.current) && holdoutLooks(run, run.current) < 1;
      pick = ok ? rec : cons; why = ok ? (en ? 'dev passed and the holdout is unused: recommended option' : '开发期已通过、验证期还没看：按推荐') : (en ? 'the holdout is closed (dev not passed or already used): conservative option' : '验证期没开放（开发期没通过或已经看过）：选保守项');
    } else if (cat === 'trial') {
      pick = left.any ? rec : cons; why = left.any ? (en ? `budget left (${left.ideasLeft} idea(s), ${Math.max(0, left.versionsLeft)} version(s) for this idea): recommended option` : `预算还有（${left.ideasLeft} 个想法、这个想法还剩 ${Math.max(0, left.versionsLeft)} 个版本）：按推荐`) : (en ? 'budget used up: conservative option' : '预算用完：选保守项');
    } else if (cat === 'spec' || cat === 'other') {
      pick = rec; why = en ? 'spec / other question: recommended option' : '规则说明 / 其他问题：按推荐';
    } else {
      pick = cons || rec; why = cons ? (en ? 'question not tagged: conservative option' : '问题没标类别：选保守项') : (en ? 'question not tagged and no conservative option: recommended option, with a warning' : '问题没标类别、也没有保守项：按推荐，并提醒');
    }
    if (rec && verdictOf(qq.options[0]) === 'drop' && pick === rec) why += en ? ' (the first option was dropped by the reviewer)' : '（第一个选项被审核员筛掉了）';
    answers.push({ selected: pick ? [pick.label] : [] });
    decisions.push({ at: now, question: qq.question, category: cat, picked: pick ? pick.label : null, why });
    const tail = !pick ? (en ? 'no usable option: do not do this; end this path and report.' : '没有可用的选项：不要做这件事，结束这条路并汇报。')
      : !cat && !cons ? (en ? ' If this adds a trial or touches the holdout, do not do it: stop and report.' : '如果这会增加尝试次数或碰验证期，就不要做，停下汇报。') : '';
    lines.push(`${i + 1}. ${qq.question}\n   → ${pick ? pick.label : (en ? '(none)' : '（不选）')}（${why}）${tail ? ` ${tail}` : ''}`);
  });
  const head = en ? 'Autopilot answered automatically (nobody is waiting; do not ask again):' : '自动研究自动回答（没有人在等，不要再问一遍）：';
  return { answers, decisions, awaiting, text: `${head}\n${lines.join('\n')}` };
}

/**
 * 从中途开始（评测的快速探针用；以后「接着上一轮做」也能用）：把已经发生的进度写进运行记录。
 * seed: { plan, projects: {pid: planIdea}, tests: {pid: n}, backtests: {id: {projectId, role, period}}, validations: {id: {pass}}, found, current }
 */
export function applySeed(run, seed = {}) {
  if (Array.isArray(seed.plan)) run.plan = seed.plan.slice(0, run.budget.ideas).map((x) => ({ title: String(x.title || '').slice(0, 200), logic: String(x.logic || '').slice(0, 600), kind: x.kind || null, failIf: String(x.failIf || '').slice(0, 300), batch: Number(x.batch) || 1 }));
  if (Array.isArray(seed.batches)) run.batches = seed.batches.map((d) => ({ name: String(d.name || ''), whyNew: String(d.whyNew || ''), data: String(d.data || ''), at: run.createdAt }));
  else if (run.plan) run.batches = [...new Set(run.plan.map((x) => x.batch))].map((b) => ({ name: `${run.lang === 'en' ? 'Direction' : '方向'} ${b}`, whyNew: '', data: '', at: run.createdAt }));
  for (const [pid, k] of Object.entries(seed.projects || {})) if (/^\d+$/.test(pid)) run.projects[pid] = Number(k);
  for (const [pid, n] of Object.entries(seed.tests || {})) if (/^\d+$/.test(pid)) run.tests[pid] = Number(n) || 0;
  for (const [id, b] of Object.entries(seed.backtests || {})) run.backtests[id] = { projectId: Number(b.projectId), role: b.role || 'candidate', period: b.period || 'dev', at: run.createdAt };
  for (const [id, v] of Object.entries(seed.validations || {})) run.validations[id] = { pass: Boolean(v.pass), period: (run.backtests[id] || {}).period || null, at: run.createdAt };
  if (Array.isArray(seed.found)) run.found = seed.found.map((f) => ({ ...f, projectId: Number(f.projectId) }));
  run.current = seed.current != null ? Number(seed.current) : Object.keys(run.projects).map(Number).pop() ?? null;
  return run;
}

/** 从中途开始时，接在开工说明后面的「目前进度」：代码记的账本 + 调用方补充的一段话 */
export function progressMessage(run, note = '', ctx = {}) {
  const en = run.lang === 'en';
  return `${kickoffMessage(run, ctx)}\n\n${en ? '[Progress so far — continue this run from here; the idea list is already registered]' : '【目前进度：接着这一轮往下做，想法清单已经登记过了】'}\n${ledgerText(run)}${note ? `\n${String(note).slice(0, 4000)}` : ''}`;
}

/**
 * 接着做：一轮出错 / 中断 / 被停掉之后，用户在它的对话里再发一条消息（比如换了模型重发），就从原来的进度继续：
 * 预算、清单、账本都沿用，时间上限从现在重新算。已经正常结束（done）的不接着做。返回是否恢复了。
 */
export const RESUMABLE = new Set(['error', 'interrupted', 'stopped']);
export function resume(run, { now = Date.now() } = {}) {
  if (!run || !RESUMABLE.has(run.status)) return false;
  run.status = 'running'; run.reason = null; run.endedAt = null; run.resumedAt = now;
  run.resumes = (run.resumes || 0) + 1;
  return true;
}

/** 运行记录里给网页看的摘要 */
export function runView(run) {
  if (!run) return null;
  return {
    runId: run.runId, status: run.status, reason: run.reason, createdAt: run.createdAt, endedAt: run.endedAt, rootThreadId: run.rootThreadId,
    scope: run.scope, universe: run.universe, budget: run.budget, caps: run.caps, stopOnFind: run.stopOnFind, timingGate: run.timingGate || 'return',
    untilFound: Boolean(run.untilFound), chain: run.chain ? { id: run.chain.id, round: run.chain.round, usdTotal: run.chain.usdTotal, minutesTotal: run.chain.minutesTotal, spent: run.chain.spent || 0, startedAt: run.chain.startedAt } : null, chainEnd: run.chainEnd || null, nextRunId: run.nextRunId || null,
    plan: run.plan, batches: run.batches || [], direction: run.direction || '', ledger: ledger(run), found: run.found, awaiting: run.awaiting || [], decisions: run.decisions.slice(-50), refusals: run.refusals.slice(-50).map((x) => ({ ...x, message: String(x.message || '').replace(/^(错误|Error)[:：]\s*/, '') })), lang: run.lang, cost: run.cost, tokens: run.tokens || null,
  };
}
