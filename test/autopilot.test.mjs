// 自动研究的纯函数：node test/autopilot.test.mjs
// 硬规则（guard）、记账（record）、自动回答（autoAnswer）、账本，以及统计检验结论落盘后研究流水线能看到。
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as A from '../lib/autopilot.mjs';

let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failed += 1;
};
const T0 = 1_800_000_000_000;
const ok = (r) => r.allow === true;
const no = (r, re) => r.allow === false && (!re || re.test(r.message));
const PASS = '结论：✅ 通过，可以标为主版本\n✓ ...';
const FAIL = '结论：❌ 没通过，不能标为主版本\n✗ ...';

/* ---- 设置 ---- */
const o = A.normalizeOptions({ budget: { ideas: 99, versions: 0 }, usd: 'x', scope: 'weird', universe: '../etc' });
check('预算夹在范围内、非法值回到默认', o.ideas === 10 && o.versions === 1 && o.usd === A.DEFAULTS.usd && o.scope === 'any' && o.universe === 'sp500', JSON.stringify(o));
const d0 = A.normalizeOptions({});
check('默认值：一共 6 个想法、最多 3 个方向、每个想法 2 个版本、$20、180 分钟、找到就停', d0.ideas === 6 && d0.directions === 3 && d0.versions === 2 && d0.usd === 20 && d0.minutes === 180 && d0.stopOnFind === true && d0.direction === '', JSON.stringify(d0));

/* ---- 一轮完整的记账 + 硬规则 ---- */
const run = A.newRun({ budget: { ideas: 2, versions: 2 } }, { now: T0 });
const g = (tool, args, now = T0 + 1000) => A.guard(run, tool, args, { now });
const rec = (tool, args, result) => A.record(run, tool, args, result, { now: T0 + 2000 });
check('没登记：建项目被拒', no(g('create_project', { name: 'x', planIdea: 1 }), /autopilot_plan/));
check('没登记：想法检验被拒', no(g('test_idea', { projectId: 5, idea: 'x', factors: [] }), /autopilot_plan/));
check('没登记：回测被拒', no(g('create_backtest', { projectId: 5 }), /autopilot_plan/));
check('一批超过预算被拒', no(g('autopilot_plan', { ideas: [1, 2, 3].map((i) => ({ title: `t${i}`, logic: 'l' })) }), /最多 2 个/));
check('想法没写经济逻辑被拒', no(g('autopilot_plan', { ideas: [{ title: 't' }] }), /logic/));
const plan = { ideas: [{ title: '低波动', logic: '风险补偿' }, { title: '动量', logic: '反应不足' }] };
check('清单在预算内：放行', ok(g('autopilot_plan', plan)));
rec('autopilot_plan', plan, '已登记');
check('这一批还没开始做：不能登记下一批', no(g('autopilot_plan', plan), /没开始/));
check('建项目要带 planIdea', no(g('create_project', { name: 'x' }), /planIdea/));
check('planIdea 超出清单被拒', no(g('create_project', { name: 'x', planIdea: 3 }), /planIdea/));
check('planIdea=1：放行', ok(g('create_project', { name: 'x', planIdea: 1 })));
rec('create_project', { name: 'x', planIdea: 1 }, '已创建项目「x」，projectId=101');
check('同一个想法不能建第二个项目', no(g('create_project', { name: 'y', planIdea: 1 }), /已经建过/));
check('不是这一轮的项目：想法检验被拒', no(g('test_idea', { projectId: 999, idea: 'x', factors: [] }), /不是这一轮/));
check('想法检验第 1 次：放行', ok(g('test_idea', { projectId: 101 })));
rec('test_idea', { projectId: 101 }, '已开始想法检验 jobId=r1');
rec('test_idea', { projectId: 101 }, '已开始想法检验 jobId=r2');
check('想法检验超过版本预算被拒', no(g('test_idea', { projectId: 101 }), /预算/));
check('出错的调用不记账', (A.record(run, 'test_idea', { projectId: 101 }, '错误：xx'), run.tests[101] === 2));
check('标 main 的回测被拒', no(g('create_backtest', { projectId: 101, role: 'main', period: 'dev' }), /main/));
check('开发期没通过：验证期被拒', no(g('create_backtest', { projectId: 101, role: 'candidate', period: 'holdout' }), /验证期/));
check('全期（包含验证期）也按验证期拦', no(g('create_backtest', { projectId: 101, period: 'full' }), /验证期/));
rec('create_backtest', { projectId: 101, role: 'candidate', period: 'dev' }, '已开始回测「v1」，backtestId=bt1（projectId=101）');
rec('validate_backtest', { projectId: 101, backtestId: 'bt1' }, FAIL);
check('开发期版本 1 没通过：还能跑版本 2', ok(g('create_backtest', { projectId: 101, role: 'candidate', period: 'dev' })));
rec('create_backtest', { projectId: 101, role: 'candidate', period: 'dev' }, '已开始回测「v2」，backtestId=bt2（projectId=101）');
check('基准 / 消融不占版本预算', ok(g('create_backtest', { projectId: 101, role: 'benchmark', period: 'dev', file: 'benchmark.py' })) && ok(g('create_backtest', { projectId: 101, role: 'ablation', period: 'dev' })));
check('版本预算用完：第 3 个开发期版本被拒', no(g('create_backtest', { projectId: 101, role: 'candidate', period: 'dev' }), /版本预算/));
check('不写 role / period 也算开发期候选', no(g('create_backtest', { projectId: 101 }), /版本预算/));
rec('validate_backtest', { projectId: 101, backtestId: 'bt2' }, PASS);
check('开发期通过：验证期放行', ok(g('create_backtest', { projectId: 101, role: 'candidate', period: 'holdout' })));
rec('create_backtest', { projectId: 101, role: 'candidate', period: 'holdout' }, '已开始回测「h」，backtestId=bth（projectId=101）');
check('验证期只能看一次', no(g('create_backtest', { projectId: 101, role: 'candidate', period: 'holdout' }), /一次/));
check('自动研究里不调参', no(g('tune_backtest', { projectId: 101, backtestId: 'bt2' }), /不调参/));
check('只读和诊断工具不受影响', ok(g('read_backtest', { projectId: 101, backtestId: 'bt2' })) && ok(g('robustness_backtest', { projectId: 101, backtestId: 'bt2' })));
check('update_backtest 标 main 被拒', no(g('update_backtest', { projectId: 101, backtestId: 'bt2', role: 'main' }), /main/));
check('不能改时间段标签（把验证期改成开发期）', no(g('update_backtest', { projectId: 101, backtestId: 'bth', period: 'dev' }), /时间段/));
const f = rec('validate_backtest', { projectId: 101, backtestId: 'bth' }, PASS);
check('验证期也通过：记为找到的候选', f.found && f.found.projectId === 101 && f.found.devBacktestId === 'bt2' && run.found.length === 1);
check('找到就停：不能再建项目', no(g('create_project', { name: 'z', planIdea: 2 }), /找到/));
check('找到就停：不能再跑新的开发期版本', no(g('create_backtest', { projectId: 101, role: 'candidate', period: 'dev' }), /看过验证期|找到/));
const L = A.ledger(run);
check('账本：1 个想法、2 次检验、2 个开发期版本、验证期 1 次、1 个候选', L.ideas === 1 && L.tests === 2 && L.devVersions === 2 && L.holdoutLooks === 1 && L.found === 1, JSON.stringify(L));
const lt = A.ledgerText(run);
check('账本文字：每个想法一行，没开始的也列出', /想法 1「低波动」/.test(lt) && /开发期和验证期都通过/.test(lt) && /想法 2「动量」：没开始/.test(lt), lt);

/* ---- 自主探索：换方向 ---- */
const rx = A.newRun({ budget: { ideas: 5, versions: 1, directions: 2 } }, { now: T0 });
const gx = (tool, args) => A.guard(rx, tool, args, { now: T0 + 1000 });
const rcx = (tool, args, result) => A.record(rx, tool, args, result, { now: T0 + 2000 });
const b1 = { direction: { name: '价量' }, ideas: [{ title: '低波动', logic: 'x' }, { title: '动量', logic: 'y' }] };
check('每批最多 3 个想法', no(gx('autopilot_plan', { ideas: [1, 2, 3, 4].map((i) => ({ title: `t${i}`, logic: 'l' })) }), /最多 3 个/));
check('第一批：不写方向也行', ok(gx('autopilot_plan', { ideas: b1.ideas })));
rcx('autopilot_plan', b1, '已登记');
check('记下第 1 个方向，想法带批次', rx.batches.length === 1 && rx.batches[0].name === '价量' && rx.plan.every((x) => x.batch === 1));
const b2 = { direction: { name: '宏观利率', whyNew: '收益来源是利率周期，不是个股特征' }, ideas: [{ title: '收益率曲线倒挂时减仓', logic: 'z' }] };
check('上一批没做完：不能换方向', no(gx('autopilot_plan', b2), /没开始/));
rcx('create_project', { planIdea: 1 }, 'projectId=501'); rcx('create_project', { planIdea: 2 }, 'projectId=502');
check('换方向要写为什么是新的收益来源', no(gx('autopilot_plan', { direction: { name: '宏观' }, ideas: b2.ideas }), /whyNew/));
check('换方向不能重复登记过的想法（只改标点、空格也算）', no(gx('autopilot_plan', { direction: b2.direction, ideas: [{ title: '低 波动。', logic: 'q' }] }), /已经登记过/));
check('上一批都开始了、写清了理由：可以换方向', ok(gx('autopilot_plan', b2)));
rcx('autopilot_plan', b2, '已登记');
check('第 2 批的想法接着编号（planIdea=3），带批次 2', rx.plan.length === 3 && rx.plan[2].batch === 2 && ok(gx('create_project', { planIdea: 3 })));
rcx('create_project', { planIdea: 3 }, 'projectId=503');
check('方向数用完（最多 2 个）：不能再换', no(gx('autopilot_plan', { direction: { name: '跨资产', whyNew: 'w' }, ideas: [{ title: '新的', logic: 'n' }] }), /方向数已经用完/));
const ltx = A.ledgerText(rx);
check('账本按方向分组，写明方向数', /方向：2\/2/.test(ltx) && /方向 1「价量」/.test(ltx) && /方向 2「宏观利率」/.test(ltx), ltx);
const ry = A.newRun({ budget: { ideas: 2, directions: 3 } }, { now: T0 });
A.record(ry, 'autopilot_plan', { ideas: [{ title: 'a', logic: 'x' }, { title: 'b', logic: 'y' }] }, '已登记');
A.record(ry, 'create_project', { planIdea: 1 }, 'projectId=601'); A.record(ry, 'create_project', { planIdea: 2 }, 'projectId=602');
check('想法总数用完：方向还有也不能再登记', no(A.guard(ry, 'autopilot_plan', { direction: { name: 'c', whyNew: 'w' }, ideas: [{ title: 'c', logic: 'z' }] }, { now: T0 + 1 }), /总数的预算/));
check('用户给的方向写进开工说明', /用户指定的方向：只用宏观数据/.test(A.kickoffMessage(A.newRun({ direction: '只用宏观数据' }))));

/* ---- 开工背景：已经试过的、可以用的数据 ---- */
const tt = A.testedText([
  { kind: 'idea', what: '52 周高点接近度', outcome: '没有信号', projectName: 'p1' },
  { kind: 'backtest', projectId: 1012, projectName: 'SPY 200日均线择时', validated: 'fail', detail: '' },
  { kind: 'backtest', projectId: 1012, projectName: 'SPY 200日均线择时', stage: '验证期' },
]);
check('已经试过的：想法检验和结论、策略和检验情况，说明都算进门槛', /52 周高点接近度（没有信号/.test(tt) && /SPY 200日均线择时」：2 个回测，没过统计检验、看过验证期/.test(tt) && /门槛/.test(tt), tt);
check('已经试过的：没有记录时为空', A.testedText([]) === '');
const dm = A.dataMenu({ universes: [{ key: 'sp500', kind: 'point-in-time' }], fundFields: { F_EP: 'x', F_ROE: 'y' }, datasets: [{ name: 'cpi_surprise' }], breadth: true });
check('可以用的数据：股票池、财报字段、宏观、宽度、自建数据集', /sp500/.test(dm) && /F_EP、F_ROE/.test(dm) && /DGS10/.test(dm) && /已经算好/.test(dm) && /cpi_surprise/.test(dm), dm);
check('开工说明带上这两段', /已经试过的（不要再做）/.test(A.kickoffMessage(rx, { tested: tt, menu: dm })) && /可以用的数据和工具/.test(A.kickoffMessage(rx, { tested: tt, menu: dm })));

/* ---- 上限 ---- */
const r2 = A.newRun({ minutes: 10, usd: 5 }, { now: T0 });
check('超过时间上限：不能开新工作', no(A.guard(r2, 'autopilot_plan', plan, { now: T0 + 11 * 60000 }), /时间上限/));
r2.cost = 6;
check('超过用量上限：不能开新工作', no(A.guard(r2, 'autopilot_plan', plan, { now: T0 + 1000 }), /用量/));
check('只读工具不受上限影响', ok(A.guard(r2, 'read_backtest', { projectId: 1 }, { now: T0 + 11 * 60000 })));
r2.status = 'stopped';
check('运行结束后：不能开新的工作', no(A.guard(r2, 'create_project', { planIdea: 1 }, { now: T0 }), /结束/) && no(A.guard(r2, 'handoff', { agent: 'engineer' }, { now: T0 }), /结束/));
check('运行结束后：还能查看结果（只读工具）', ok(A.guard(r2, 'read_backtest', {}, { now: T0 })) && ok(A.guard(r2, 'list_backtests', {}, { now: T0 })));
r2.status = 'error'; r2.cost = 0;
check('出错的一轮可以接着做：状态恢复、时间上限从现在重新算', A.resume(r2, { now: T0 + 60 * 60000 }) && r2.status === 'running' && ok(A.guard(r2, 'autopilot_plan', plan, { now: T0 + 65 * 60000 })));
r2.status = 'done';
check('正常结束的不接着做', A.resume(r2) === false && r2.status === 'done');

/* ---- 自动回答 ---- */
const r3 = A.newRun({ budget: { ideas: 1, versions: 1 } }, { now: T0 });
A.record(r3, 'autopilot_plan', plan, 'ok');
const q = (category, opts) => ({ questions: [{ question: '怎么办？', category, options: opts }] });
const OPTS = [{ label: '换 sp500 再测一次（推荐）' }, { label: '不重测', conservative: true }];
check('trial 类、预算还有：按推荐', A.autoAnswer(r3, q('trial', OPTS)).answers[0].selected[0] === OPTS[0].label);
A.record(r3, 'create_project', { planIdea: 1 }, 'projectId=7');
A.record(r3, 'test_idea', { projectId: 7 }, 'ok');
const tr = A.autoAnswer(r3, q('trial', OPTS));
check('trial 类、预算用完：选保守项', tr.answers[0].selected[0] === '不重测' && /预算用完/.test(tr.decisions[0].why), tr.text);
check('没标类别：选保守项（标了 conservative 的）', A.autoAnswer(r3, q(undefined, OPTS)).answers[0].selected[0] === '不重测');
check('没标类别、也没标 conservative：按「不…」开头的认作保守项', A.autoAnswer(r3, q(undefined, [{ label: '再试一次' }, { label: '不试了' }])).answers[0].selected[0] === '不试了');
const nc = A.autoAnswer(r3, q(undefined, [{ label: '用 200 日均线' }, { label: '用 100 日均线' }]));
check('没标类别、没有保守项：按推荐，并提醒不要增加尝试', nc.answers[0].selected[0] === '用 200 日均线' && /不要做，停下汇报/.test(nc.text));
check('spec 类：按推荐', A.autoAnswer(r3, q('spec', [{ label: '状态（推荐）' }, { label: '交叉' }])).answers[0].selected[0] === '状态（推荐）');
const pr = A.autoAnswer(r3, q('promotion', [{ label: '标为 main（推荐）' }, { label: '先不标', conservative: true }]));
check('promotion 类：不标，记进「等你确认」', pr.answers[0].selected[0] === '先不标' && pr.awaiting.length === 1);
check('holdout 类、开发期没通过：选保守项', A.autoAnswer(r3, q('holdout', [{ label: '看验证期（推荐）' }, { label: '不看', conservative: true }])).answers[0].selected[0] === '不看');
const rv = { noneWorth: false, questions: [{ applicable: true, options: { '换 sp500 再测一次（推荐）': { verdict: 'drop' }, 不重测: { verdict: 'keep' } } }] };
const r4 = A.newRun({}, { now: T0 }); A.record(r4, 'autopilot_plan', plan, 'ok');
check('审核员筛掉的推荐项不选', A.autoAnswer(r4, q('trial', OPTS), rv).answers[0].selected[0] === '不重测');
const nw = A.autoAnswer(r4, q('trial', OPTS), { noneWorth: true, summary: '都是事后挑选', questions: [] });
check('审核员认为都不值得做：不选，告诉 agent 结束这个想法', nw.answers[0].selected.length === 0 && /结束这个想法/.test(nw.text));
check('每个自动决定都有记录（问了什么、选了什么、为什么）', tr.decisions[0].question && tr.decisions[0].picked && tr.decisions[0].why);
check('英文', /Autopilot answered/.test(A.autoAnswer({ ...A.newRun({}, { lang: 'en' }) }, q('spec', OPTS)).text));
check('开工说明写明预算和硬规则', /最多 1 个想法/.test(A.kickoffMessage(r3)) && /autopilot_plan/.test(A.kickoffMessage(r3)) && /planIdea/.test(A.kickoffMessage(r3)));

/* ---- 从中途开始（快速探针） ---- */
const r5 = A.newRun({ budget: { ideas: 2, versions: 1 } }, { now: T0 });
A.applySeed(r5, { plan: [{ title: 'a', logic: 'x' }, { title: 'b', logic: 'y' }, { title: 'c', logic: 'z' }], projects: { 301: 1 }, backtests: { d1: { projectId: 301, period: 'dev' } }, validations: { d1: { pass: false } } });
check('applySeed：清单按预算截断、进度写进运行记录', r5.plan.length === 2 && r5.projects[301] === 1 && r5.current === 301 && r5.validations.d1.pass === false);
check('applySeed 之后硬规则照常：版本预算已用完', no(A.guard(r5, 'create_backtest', { projectId: 301, role: 'candidate', period: 'dev' }, { now: T0 + 1 }), /版本预算/));
check('applySeed 之后硬规则照常：第 1 个想法不能再建项目，第 2 个可以', no(A.guard(r5, 'create_project', { planIdea: 1 }, { now: T0 + 1 }), /已经建过/) && ok(A.guard(r5, 'create_project', { planIdea: 2 }, { now: T0 + 1 })));
check('progressMessage：开工说明 + 目前进度 + 补充', /目前进度/.test(A.progressMessage(r5, '分析师说没通过')) && /分析师说没通过/.test(A.progressMessage(r5, '分析师说没通过')));

/* ---- 统计检验结论落盘 → 流水线 ---- */
const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-ap-'));
process.env.HELM_PROJECTS_DIR = path.join(TMP, 'projects');
process.env.HELM_TRIALS_FILE = path.join(TMP, 'trials.jsonl');
try {
  const E = await import('../lib/engine.mjs');
  const bd = path.join(TMP, 'projects', '501', 'backtests', 'b1');
  await mkdir(bd, { recursive: true });
  await writeFile(path.join(TMP, 'projects', '501', 'project.json'), JSON.stringify({ projectId: 501, name: 'p' }));
  await writeFile(path.join(bd, 'meta.json'), JSON.stringify({ backtestId: 'b1', name: 'v1', status: 'Completed.', role: 'candidate', period: 'dev', created: '2026-11-24T00:00:00Z' }));
  await E.saveValidation(501, 'b1', { pass: false, ok: true, gates: [{ id: 'ci', ok: false }, { id: 'excess', ok: false }, { id: 'years', ok: true }] });
  const v1 = JSON.parse(await readFile(path.join(bd, 'validation.json'), 'utf8'));
  check('检验结论写进 validation.json', v1.pass === false && v1.failed.join() === 'ci,excess', JSON.stringify(v1));
  await new Promise((r) => setTimeout(r, 15));
  await E.saveValidation(501, 'b1', { pass: false, ok: true, gates: [{ id: 'ci', ok: false }, { id: 'excess', ok: false }] });
  const v2 = JSON.parse(await readFile(path.join(bd, 'validation.json'), 'utf8'));
  check('结论没变就不重写', v2.at === v1.at);
  const J = await import('../lib/journal.mjs');
  const P = await import('../lib/pipeline.mjs');
  const jr = await J.loadJournal({ projectsDir: path.join(TMP, 'projects'), trialsFile: process.env.HELM_TRIALS_FILE, fresh: true }).catch((e) => ({ error: e.message }));
  const e1 = (jr.entries || []).find((e) => e.id === 'b:501:b1');
  check('想法记录：检验过的回测在「统计检验」这一步，写明没过', e1 && e1.stage === '统计检验' && e1.validated === 'fail' && /没过统计检验/.test(e1.detail), JSON.stringify(e1 || jr.error));
  const pipe = P.buildPipeline({ journal: jr, projects: [{ projectId: 501, name: 'p' }] });
  const card = pipe.cards.find((c) => c.projectId === 501);
  check('流水线：卡片在统计检验、状态是没通过（不再是「等下一步」）', card && card.stage === 'gate' && card.status === 'blocked', card && `${card.stage} ${card.status}`);
  await E.saveValidation(501, 'b1', { pass: true, ok: true, gates: [] });
  const jr2 = await J.loadJournal({ projectsDir: path.join(TMP, 'projects'), trialsFile: process.env.HELM_TRIALS_FILE, fresh: true });
  const card2 = P.buildPipeline({ journal: jr2, projects: [{ projectId: 501, name: 'p' }] }).cards.find((c) => c.projectId === 501);
  check('流水线：通过检验但没标 main → 「等你确认」', card2 && card2.stages.find((s) => s.id === 'gate').gate.label === '通过检验，等你确认标 main', card2 && JSON.stringify(card2.stages.find((s) => s.id === 'gate').gate));
  // 统计检验标准（择时按风险调整）：只能在有回测之前设
  await mkdir(path.join(TMP, 'projects', '502'), { recursive: true });
  await writeFile(path.join(TMP, 'projects', '502', 'project.json'), JSON.stringify({ projectId: 502, name: 't' }));
  const s1 = await E.setProjectValidation({ projectId: 502, mode: 'risk-adjusted' });
  const pj = JSON.parse(await readFile(path.join(TMP, 'projects', '502', 'project.json'), 'utf8'));
  check('新项目：设成风险调整标准，写进 project.json', s1.success && s1.changed === true && pj.validation === 'risk-adjusted' && pj.name === 't', JSON.stringify(pj));
  check('再设一次：不重写', (await E.setProjectValidation({ projectId: 502, mode: 'risk-adjusted' })).changed === false);
  const s2 = await E.setProjectValidation({ projectId: 501, mode: 'risk-adjusted' });
  check('已经有回测的项目：不能再换标准', s2.success === false && /已经有回测/.test((s2.errors || []).join('')), JSON.stringify(s2));
  check('不存在的项目：报错', (await E.setProjectValidation({ projectId: 999, mode: 'risk-adjusted' })).success === false);
} finally {
  await rm(TMP, { recursive: true, force: true });
}

/* ---- 交付检查（unfinished）：登记过的想法有没有做到有结论 ---- */
{
  const mk = (opts = {}) => { const r = A.newRun({ budget: { ideas: 3, versions: 2 }, ...opts }, { now: T0 }); A.record(r, 'autopilot_plan', { ideas: [{ title: '盈利惊喜', logic: 'l', kind: 'stock' }, { title: '质量', logic: 'l', kind: 'stock' }, { title: '趋势择时', logic: 'l', kind: 'timing' }] }, 'ok'); return r; };
  const at = { now: T0 + 60000 };
  // 重现 2026-11-24 那一轮：想法 1 信号弱没进开发期，想法 2 没信号，想法 3 建了项目没回测
  const r = mk();
  A.record(r, 'create_project', { name: 'a', planIdea: 1 }, '已创建 projectId=11');
  A.record(r, 'test_idea', { projectId: 11 }, '已提交');
  check('想法检验提交了没读结论：要求 read_research', A.unfinished(r, at).some((m) => /想法 1/.test(m) && /read_research/.test(m)));
  A.record(r, 'read_research', { projectId: 11, jobId: 'j' }, '【f1】结论：没有信号\n【f2】结论：信号弱\n');
  check('几个因子里取最好的结论', r.ideaVerdicts[11] === 'weak', JSON.stringify(r.ideaVerdicts));
  A.record(r, 'create_project', { name: 'b', planIdea: 2 }, '已创建 projectId=12');
  A.record(r, 'test_idea', { projectId: 12 }, '已提交');
  A.record(r, 'read_research', { projectId: 12, jobId: 'j' }, '【f】结论：没有信号\n');
  A.record(r, 'create_project', { name: 'c', planIdea: 3 }, '已创建 projectId=13');
  const u = A.unfinished(r, at);
  check('信号弱但没进开发期：列出来', u.some((m) => /想法 1/.test(m) && /信号弱/.test(m) && /开发期/.test(m)), u.join(' | '));
  check('没有信号的想法算做完了', !u.some((m) => /想法 2/.test(m)));
  check('择时想法建了项目没回测：列出来', u.some((m) => /想法 3/.test(m) && /没跑开发期/.test(m)));
  check('一共 2 项', u.length === 2, String(u.length));
  // 往下做完
  A.record(r, 'create_backtest', { projectId: 13 }, 'backtestId=t1');
  check('回测跑了没检验：列出来', A.unfinished(r, at).some((m) => /想法 3/.test(m) && /t1/.test(m) && /validate_backtest/.test(m)));
  A.record(r, 'validate_backtest', { projectId: 13, backtestId: 't1' }, FAIL);
  check('开发期没通过：这个想法算做完（要不要再改一版由 agent 定）', !A.unfinished(r, at).some((m) => /想法 3/.test(m)));
  A.record(r, 'create_backtest', { projectId: 11 }, 'backtestId=s1');
  A.record(r, 'validate_backtest', { projectId: 11, backtestId: 's1' }, PASS);
  check('开发期通过了没跑验证期：列出来', A.unfinished(r, at).some((m) => /想法 1/.test(m) && /没跑验证期/.test(m)));
  A.record(r, 'create_backtest', { projectId: 11, period: 'holdout' }, 'backtestId=s2');
  check('验证期跑了没检验：列出来', A.unfinished(r, at).some((m) => /s2/.test(m)));
  A.record(r, 'validate_backtest', { projectId: 11, backtestId: 's2' }, FAIL);
  check('每个想法都有结论：没有待办', A.unfinished(r, at).length === 0, A.unfinished(r, at).join(' | '));
  // 不该催的情况
  const r1 = mk();
  check('登记了没开始：列出来', A.unfinished(r1, at).length === 3 && /planIdea=1/.test(A.unfinished(r1, at)[0]));
  check('超过时间上限：不催', A.unfinished(r1, { now: T0 + 181 * 60000 }).length === 0);
  r1.cost = 20; check('用量到上限：不催', A.unfinished(r1, at).length === 0);
  r1.cost = 0; r1.found.push({ projectId: 1, backtestId: 'x' }); check('已经找到候选（找到就停）：不催', A.unfinished(r1, at).length === 0);
  r1.found = []; r1.status = 'done'; check('已经结束的一轮：不催', A.unfinished(r1, at).length === 0);
  check('还没登记：不催', A.unfinished(A.newRun({}, { now: T0 }), at).length === 0);
  const re = mk(); re.lang = 'en';
  check('英文界面给英文待办', /registered but never started/.test(A.unfinished(re, at)[0]));
}

/* ---- 择时信号检验（test_timing_signal）也记账 ---- */
{
  const r = A.newRun({ budget: { ideas: 3, versions: 2 } }, { now: T0 });
  A.record(r, 'autopilot_plan', { ideas: [{ title: '宽度确认', logic: 'l', kind: 'timing' }, { title: '分化度避险', logic: 'l', kind: 'timing' }, { title: '信用利差', logic: 'l', kind: 'timing' }] }, 'ok');
  [1, 2, 3].forEach((k) => A.record(r, 'create_project', { name: 'p', planIdea: k }, `已创建 projectId=${20 + k}`));
  A.record(r, 'test_timing_signal', { projectId: 21, series: ['pct_above_200'] }, '择时信号检验（sp500…）\n- 站上 200 日线比例（pct_above_200）：**没有信号**。t 不够。');
  A.record(r, 'test_timing_signal', { projectId: 22, series: ['dispersion'] }, '- 分化度（dispersion）：**信号弱**。…\n- 另一个：**没有信号**。');
  A.record(r, 'test_timing_signal', { projectId: 99, series: ['x'] }, '- x：**有信号**。');
  check('择时信号检验记进账本（不是这一轮的项目不记）', r.tests[21] === 1 && r.tests[22] === 1 && !r.tests[99] && A.ledger(r).tests === 2);
  check('结论记下来：没有信号 / 信号弱', r.ideaVerdicts[21] === 'none' && r.ideaVerdicts[22] === 'weak');
  const u = A.unfinished(r, { now: T0 + 60000 });
  check('检验过、没有信号的择时想法算做完，不再催', !u.some((m) => /想法 1/.test(m)), u.join(' | '));
  check('信号弱的择时想法：要进开发期（不提「导出信号」）', u.some((m) => /想法 2/.test(m) && /信号检验是「信号弱」/.test(m) && !/导出/.test(m)));
  check('没检验也没回测的择时想法：照旧催开发期', u.some((m) => /想法 3/.test(m) && /没跑开发期/.test(m)));
}

/* ---- 择时想法的判定标准（开工前选定） ---- */
{
  check('默认按收益判', A.normalizeOptions({}).timingGate === 'return' && A.newRun({}).timingGate === 'return');
  check('非法值回到默认', A.normalizeOptions({ timingGate: 'easy' }).timingGate === 'return');
  const ra = A.newRun({ timingGate: 'risk-adjusted', budget: { ideas: 3 } }, { now: T0 });
  check('可以选风险调整', ra.timingGate === 'risk-adjusted' && A.runView(ra).timingGate === 'risk-adjusted');
  check('开工说明（收益标准）：提醒纯防守的择时过不了', /按「收益」判/.test(A.kickoffMessage(A.newRun({}))) && /纯防守/.test(A.kickoffMessage(A.newRun({}))));
  check('开工说明（风险调整）：写明标准', /「风险调整」标准/.test(A.kickoffMessage(ra)) && /2\/3/.test(A.kickoffMessage(ra)) && !/按「收益」判/.test(A.kickoffMessage(ra)));
  check('开工说明（英文）也有', /judged on RETURN/.test(A.kickoffMessage(A.newRun({}, { lang: 'en' }))) && /risk-adjusted standard/.test(A.kickoffMessage(A.newRun({ timingGate: 'risk-adjusted' }, { lang: 'en' }))));
  check('开工说明：一批之内要是不同的一注、每个想法要有结论', /不同的一注/.test(A.kickoffMessage(ra)) && /做到有结论/.test(A.kickoffMessage(ra)));
  check('风险调整这一轮：想法没写 kind 被拒', no(A.guard(ra, 'autopilot_plan', { ideas: [{ title: 't', logic: 'l' }] }, { now: T0 + 1 }), /kind/));
  check('收益标准这一轮：不写 kind 照旧放行', ok(A.guard(A.newRun({}, { now: T0 }), 'autopilot_plan', { ideas: [{ title: 't', logic: 'l' }] }, { now: T0 + 1 })));
  const pl = { ideas: [{ title: '选股', logic: 'l', kind: 'stock' }, { title: '择时', logic: 'l', kind: 'timing' }] };
  check('写了 kind：放行', ok(A.guard(ra, 'autopilot_plan', pl, { now: T0 + 1 })));
  A.record(ra, 'autopilot_plan', pl, 'ok');
  check('只有择时想法用风险调整标准', A.wantsRiskAdjusted(ra, 2) === true && A.wantsRiskAdjusted(ra, 1) === false && A.wantsRiskAdjusted(ra, 9) === false);
  const rr = A.newRun({}, { now: T0 }); A.record(rr, 'autopilot_plan', pl, 'ok');
  check('没选风险调整：择时想法也按收益判', A.wantsRiskAdjusted(rr, 2) === false);
}

/* ---- 连续模式：没找到就开下一轮 ---- */
{
  check('默认不是连续模式', A.normalizeOptions({}).untilFound === false && A.newRun({}).chain === null && A.nextRound(Object.assign(A.newRun({}, { now: T0 }), { status: 'done' })) === null);
  const stockPlan = { direction: { name: '财报质量' }, ideas: [{ title: '低应计', logic: 'l', kind: 'stock' }, { title: '低资产增长', logic: 'l', kind: 'stock' }] };
  const play = (r, base) => { // 两个选股想法都「没有信号」
    A.record(r, 'autopilot_plan', stockPlan, 'ok');
    [1, 2].forEach((k) => { A.record(r, 'create_project', { name: 'p', planIdea: k }, `已创建 projectId=${base + k}`); A.record(r, 'test_idea', { projectId: base + k }, '已提交'); A.record(r, 'read_research', { projectId: base + k }, '结论：没有信号'); });
    r.cost = 3.85; r.status = 'done'; return r;
  };
  const r1 = play(A.newRun({ untilFound: true, usd: 20, minutes: 180, budget: { ideas: 2 }, timingGate: 'risk-adjusted', direction: '不限' }, { now: T0 }), 100);
  check('第 1 轮带着合计预算', r1.chain.round === 1 && r1.chain.usdTotal === 20 && r1.chain.minutesTotal === 180 && r1.chain.spent === 0);
  check('第 1 轮的开工说明写明是连续搜索、不要放宽标准', /连续搜索 · 第 1 轮/.test(A.kickoffMessage(r1)) && /不要为了在这一轮里出结果而放宽/.test(A.kickoffMessage(r1)));
  const n1 = A.nextRound(r1, { now: T0 + 25 * 60000 });
  check('没找到、预算还有：开下一轮，预算是剩下的', n1 && n1.options && n1.options.usd === 16 && n1.options.minutes === 155 && n1.options.untilFound === true, JSON.stringify(n1 && n1.options));
  check('下一轮沿用设置（想法数、范围、择时标准、方向）', n1.options.budget.ideas === 2 && n1.options.timingGate === 'risk-adjusted' && n1.options.direction === '不限' && n1.options.scope === 'any');
  check('接力信息：第 2 轮、记着第一轮的 runId、已花的钱和每个方向的结果', n1.chain.round === 2 && n1.chain.id === r1.runId && n1.chain.spent === 3.85 && n1.chain.history.length === 1 && n1.chain.history[0].ideas.length === 2 && n1.chain.history[0].ideas[0].verdict === '想法检验没有信号', JSON.stringify(n1.chain.history));
  const r2 = play(A.newRun(n1.options, { now: T0 + 26 * 60000, chain: n1.chain, runId: 'apround2' }), 200);
  const k2 = A.kickoffMessage(r2);
  check('第 2 轮开工说明列出前一轮试过的方向和结果', /第 2 轮/.test(k2) && /财报质量/.test(k2) && /低应计（stock） → 想法检验没有信号/.test(k2) && /花了 \$3\.85/.test(k2), k2.slice(k2.indexOf('【连续搜索'), k2.indexOf('【连续搜索') + 200));
  check('上限按合计算：这一轮的上限是剩下的', r2.caps.usd === 16 && r2.caps.minutes === 155 && r2.chain.usdTotal === 20);
  const n2 = A.nextRound(r2, { now: T0 + 60 * 60000 });
  check('第 3 轮：累计花费、历史累加', n2.chain.round === 3 && Math.abs(n2.chain.spent - 7.7) < 1e-9 && n2.chain.history.length === 2 && n2.options.usd === 12 && n2.chain.id === r1.runId, JSON.stringify({ s: n2.chain.spent, u: n2.options.usd }));
  const r3 = A.newRun(n2.options, { now: T0 + 61 * 60000, chain: n2.chain });
  check('同一类连续 4 个都没过开发期：开工说明要求换一类', /选股想法已经连续 4 个没有一个通过开发期/.test(A.kickoffMessage(r3)) && !/择时想法已经连续/.test(A.kickoffMessage(r3)));
  check('「开发期没通过」不会被当成通过', A.roundSummary(r2).every((d) => d.ideas.every((x) => x.devPass === false)));
  // 停下来的几种情况
  const f = play(A.newRun({ untilFound: true }, { now: T0 }), 300); f.found.push({ projectId: 301, backtestId: 'h' });
  check('找到了：不再开', A.nextRound(f, { now: T0 + 1 }).stop === 'found');
  const u = play(A.newRun({ untilFound: true, usd: 4 }, { now: T0 }), 400);
  check('合计用量不够再开一轮：停（usd）', A.nextRound(u, { now: T0 + 1 }).stop === 'usd');
  const t = play(A.newRun({ untilFound: true, minutes: 30 }, { now: T0 }), 500);
  check('合计时间不够：停（time）', A.nextRound(t, { now: T0 + 25 * 60000 }).stop === 'time');
  const e = A.newRun({ untilFound: true }, { now: T0 }); e.status = 'done';
  check('这一轮什么都没测：停（no-progress），不空转', A.nextRound(e, { now: T0 + 1 }).stop === 'no-progress');
  const m = play(A.newRun({ untilFound: true }, { now: T0, chain: { id: 'apx', round: A.MAX_ROUNDS, usdTotal: 500, minutesTotal: 1440, startedAt: T0, spent: 0, history: [] } }), 600);
  check('轮数到上限：停（rounds）', A.nextRound(m, { now: T0 + 1 }).stop === 'rounds');
  for (const st of ['error', 'stopped', 'interrupted', 'running']) { const x = play(A.newRun({ untilFound: true }, { now: T0 }), 700); x.status = st; check(`${st} 的一轮不接着开`, A.nextRound(x, { now: T0 + 1 }) === null); }
  const en = play(A.newRun({ untilFound: true }, { now: T0, lang: 'en' }), 800);
  const ne = A.nextRound(en, { now: T0 + 1 });
  check('英文：历史和开工说明是英文', ne.chain.history[0].ideas[0].verdict === 'no signal' && /Continuous search — round 2/.test(A.kickoffMessage(A.newRun(ne.options, { lang: 'en', chain: ne.chain }))));
  { // 开发期通过、验证期没跑成：不接着开下一轮
    const hp = A.newRun({ untilFound: true, budget: { ideas: 1 } }, { now: T0 });
    A.record(hp, 'autopilot_plan', { ideas: [{ title: '信用利差', logic: 'l', kind: 'timing' }] }, 'ok');
    A.record(hp, 'create_project', { name: 'p', planIdea: 1 }, '已创建 projectId=901');
    A.record(hp, 'create_backtest', { projectId: 901 }, 'backtestId=d1'); A.record(hp, 'validate_backtest', { projectId: 901, backtestId: 'd1' }, PASS);
    hp.status = 'done';
    check('开发期通过、验证期没跑：停（holdout-pending），不接着花预算', A.nextRound(hp, { now: T0 + 1 }).stop === 'holdout-pending');
    A.record(hp, 'create_backtest', { projectId: 901, period: 'holdout' }, 'backtestId=h1'); A.record(hp, 'validate_backtest', { projectId: 901, backtestId: 'h1' }, FAIL);
    check('验证期看过了（没通过）：照常接着找', Boolean(A.nextRound(hp, { now: T0 + 1 }).options));
  }
  const v = A.runView(r2);
  check('网页摘要带着第几轮和合计', v.untilFound === true && v.chain.round === 2 && v.chain.spent === 3.85 && v.chain.usdTotal === 20);
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
