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

export const DEFAULTS = { ideas: 3, versions: 2, usd: 20, minutes: 180, stopOnFind: true, scope: 'any', universe: 'sp500' };
const SCOPES = new Set(['stock', 'timing', 'any']);
const clampInt = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

export function normalizeOptions(o = {}) {
  const b = o.budget || {};
  return {
    ideas: clampInt(b.ideas ?? o.ideas, 1, 10, DEFAULTS.ideas),
    versions: clampInt(b.versions ?? o.versions, 1, 5, DEFAULTS.versions),
    usd: clampInt(o.usd ?? (o.caps && o.caps.usd), 1, 500, DEFAULTS.usd),
    minutes: clampInt(o.minutes ?? (o.caps && o.caps.minutes), 10, 24 * 60, DEFAULTS.minutes),
    stopOnFind: o.stopOnFind === undefined ? DEFAULTS.stopOnFind : Boolean(o.stopOnFind),
    scope: SCOPES.has(o.scope) ? o.scope : DEFAULTS.scope,
    universe: /^[A-Za-z0-9_-]{1,40}$/.test(String(o.universe || '')) ? String(o.universe) : DEFAULTS.universe,
  };
}

export function newRun(opts = {}, { now = Date.now(), runId = null, lang = 'zh' } = {}) {
  const o = normalizeOptions(opts);
  return {
    runId: runId || `ap${now.toString(36)}`,
    status: 'running', reason: null, lang: lang === 'en' ? 'en' : 'zh',
    createdAt: now, endedAt: null, rootThreadId: null,
    scope: o.scope, universe: o.universe,
    budget: { ideas: o.ideas, versions: o.versions },
    caps: { usd: o.usd, minutes: o.minutes }, stopOnFind: o.stopOnFind,
    plan: null,          // [{ title, logic, kind, failIf }]
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

export function kickoffMessage(run) {
  const en = run.lang === 'en';
  const { ideas, versions } = run.budget;
  const scope = run.scope === 'stock' ? (en ? 'stock selection (ranking stocks in a universe)' : '选股（在股票池里按特征挑股票）')
    : run.scope === 'timing' ? (en ? 'ETF timing (when to hold a few ETFs)' : 'ETF 择时（少数几个 ETF 之间的买卖时点）')
      : (en ? 'stock selection or ETF timing' : '选股或 ETF 择时都可以');
  if (en) {
    return `[Autopilot research] The user turned on autopilot: nobody will answer questions or give input in this run. Propose ideas yourself, test them through the normal Helm flow, then report.

Scope: ${scope}; universe: ${run.universe} (point-in-time members); development period and holdout as in CLAUDE.md; benchmarks as in CLAUDE.md.
Budget: at most ${ideas} idea(s); for each idea at most ${versions} idea test(s) and at most ${versions} development-period candidate version(s).
Rules (Helm enforces them in code; a refused call means stop that path, not find another way):
1. Before anything else, register the idea list with autopilot_plan (one sentence, economic logic and what counts as failure for each), no more than the budget. Then work through the list in order; no new or swapped ideas.
2. One project per idea: create_project with planIdea (1-based). Dispatch as usual: stock ideas researcher idea test → export if signal or weak → engineer dev period → analyst validate; timing ideas engineer dev period → analyst validate.
3. "No signal", or no dev pass within the version budget, ends that idea; move to the next. Do not retest on another universe, window or parameter.
4. Holdout only after the dev candidate passes validate_backtest, at most once per idea, no changes afterwards.
5. Never mark main or start paper trading; a candidate that passes both periods is left for the user to confirm.${run.stopOnFind ? ' Stop as soon as one candidate passes both periods.' : ''}
6. Final report: how many ideas, idea tests and dev versions, how many holdout looks, and each idea's verdict. If nothing was found, say so plainly. Helm appends its own ledger after your report.
If you need a decision, use ask_user as usual and tag each question's category (spec / trial / holdout / promotion / other) and the conservative option; Helm answers automatically by rule, nobody waits.`;
  }
  return `【自动研究】用户开启了自动研究：这一轮没有人会回答问题或给输入，你自己提出想法、按 Helm 的正常流程检验，最后汇报。

范围：${scope}；股票池：${run.universe}（历史成分股）；开发期、验证期和基准按 CLAUDE.md。
预算：最多 ${ideas} 个想法；每个想法最多 ${versions} 次想法检验、最多 ${versions} 个开发期候选版本。
规则（Helm 在代码里强制；调用被拒绝就是这条路到此为止，不要换别的办法绕过去）：
1. 开工前先用 autopilot_plan 登记想法清单（每个写一句话、经济逻辑、怎样算失败），数量不超过预算。之后按清单顺序做，不换题、不加题。
2. 每个想法建一个项目，create_project 带 planIdea（第几个想法，从 1 开始）。照常派活：选股走 研究员想法检验 → 有信号（或信号弱）导出 → 工程师开发期 → 分析师检验；择时走 工程师开发期 → 分析师检验。
3. 想法检验「没有信号」、或开发期在版本预算内都没通过，就结束这个想法，进入下一个。不要换股票池、换窗口、换参数重测。
4. 验证期：只有开发期候选通过 validate_backtest 之后才跑，每个想法最多一次，看完不改。
5. 不标 main、不开模拟实盘：开发期和验证期都通过的候选留给用户确认。${run.stopOnFind ? '找到一个这样的候选就停。' : ''}
6. 结束时汇报：试了几个想法、几次想法检验、几个开发期版本、验证期看了几次、每个想法的结论；没找到就直说没找到。Helm 会在你的汇报后面附上它自己记的账本。
需要拍板的地方照常用 ask_user，并给每个问题标 category（spec / trial / holdout / promotion / other）、给保守选项标 conservative：Helm 会按规则自动回答，不会等人。`;
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
      planIdea: idx, projectId: Number(pid), title: run.plan && run.plan[idx - 1] ? run.plan[idx - 1].title : '',
      tests: run.tests[pid] || 0, devVersions: bs.filter(isDevCandidate).length, devValidated: bs.filter((b) => isDevCandidate(b) && run.validations[b.id]).length, holdoutLooks: hold.length,
      devPassed: devPassed(run, pid), holdoutPassed: holdV.some((v) => v.pass), holdoutFailed: holdV.length > 0 && !holdV.some((v) => v.pass),
    };
  });
  return {
    registered: run.plan ? run.plan.length : 0, ideas: per.length,
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
  for (const x of L.per) lines.push(`- ${en ? 'Idea' : '想法'} ${x.planIdea}${x.title ? `「${x.title}」` : ''}（project ${x.projectId}）：${verdict(x)}`);
  if (run.plan) for (let i = L.per.length; i < run.plan.length; i++) lines.push(`- ${en ? 'Idea' : '想法'} ${i + 1}「${run.plan[i].title}」：${en ? 'not started' : '没开始'}`);
  return lines.join('\n');
}

/* ---------------- 硬规则 ---------------- */

const T = (run, zh, en) => (run.lang === 'en' ? en : zh);
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
      if (run.plan) return refuse(run, tool, T(run, '想法清单已经登记过，不能改。', 'the idea list is already registered and cannot change.'));
      if (!ideas.length) return refuse(run, tool, T(run, '想法清单是空的。', 'the idea list is empty.'));
      if (ideas.length > run.budget.ideas) return refuse(run, tool, T(run, `想法数 ${ideas.length} 超过预算 ${run.budget.ideas}。`, `${ideas.length} ideas exceed the budget of ${run.budget.ideas}.`));
      if (ideas.some((x) => !x || !String(x.title || '').trim() || !String(x.logic || '').trim())) return refuse(run, tool, T(run, '每个想法都要有 title（一句话）和 logic（经济逻辑）。', 'every idea needs a title and its economic logic.'));
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
    case 'autopilot_plan':
      run.plan = (args.ideas || []).map((x) => ({ title: String(x.title || '').slice(0, 200), logic: String(x.logic || '').slice(0, 600), kind: x.kind || null, failIf: String(x.failIf || '').slice(0, 300) }));
      return { found: null };
    case 'create_project': {
      const m = text.match(/projectId=(\d+)/);
      if (m) { run.projects[m[1]] = Number(args.planIdea); run.current = Number(m[1]); }
      return { found: null };
    }
    case 'test_idea': case 'start_research':
      if (pid != null) run.tests[pid] = (run.tests[pid] || 0) + 1;
      return { found: null };
    case 'create_backtest': {
      const m = text.match(/backtestId=([A-Za-z0-9_-]+)/);
      if (m && pid != null) run.backtests[m[1]] = { projectId: pid, role: args.role || 'candidate', period: args.period || 'dev', at: now };
      return { found: null };
    }
    case 'update_backtest':
      if (args.backtestId && run.backtests[args.backtestId]) { if (args.role) run.backtests[args.backtestId].role = args.role; }
      return { found: null };
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
  if (Array.isArray(seed.plan)) run.plan = seed.plan.slice(0, run.budget.ideas).map((x) => ({ title: String(x.title || '').slice(0, 200), logic: String(x.logic || '').slice(0, 600), kind: x.kind || null, failIf: String(x.failIf || '').slice(0, 300) }));
  for (const [pid, k] of Object.entries(seed.projects || {})) if (/^\d+$/.test(pid)) run.projects[pid] = Number(k);
  for (const [pid, n] of Object.entries(seed.tests || {})) if (/^\d+$/.test(pid)) run.tests[pid] = Number(n) || 0;
  for (const [id, b] of Object.entries(seed.backtests || {})) run.backtests[id] = { projectId: Number(b.projectId), role: b.role || 'candidate', period: b.period || 'dev', at: run.createdAt };
  for (const [id, v] of Object.entries(seed.validations || {})) run.validations[id] = { pass: Boolean(v.pass), period: (run.backtests[id] || {}).period || null, at: run.createdAt };
  if (Array.isArray(seed.found)) run.found = seed.found.map((f) => ({ ...f, projectId: Number(f.projectId) }));
  run.current = seed.current != null ? Number(seed.current) : Object.keys(run.projects).map(Number).pop() ?? null;
  return run;
}

/** 从中途开始时，接在开工说明后面的「目前进度」：代码记的账本 + 调用方补充的一段话 */
export function progressMessage(run, note = '') {
  const en = run.lang === 'en';
  return `${kickoffMessage(run)}\n\n${en ? '[Progress so far — continue this run from here; the idea list is already registered]' : '【目前进度：接着这一轮往下做，想法清单已经登记过了】'}\n${ledgerText(run)}${note ? `\n${String(note).slice(0, 4000)}` : ''}`;
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
    scope: run.scope, universe: run.universe, budget: run.budget, caps: run.caps, stopOnFind: run.stopOnFind,
    plan: run.plan, ledger: ledger(run), found: run.found, awaiting: run.awaiting || [], decisions: run.decisions.slice(-50), refusals: run.refusals.slice(-50).map((x) => ({ ...x, message: String(x.message || '').replace(/^(错误|Error)[:：]\s*/, '') })), lang: run.lang, cost: run.cost,
  };
}
