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
check('默认值：3 个想法、2 个版本、$20、180 分钟、找到就停', JSON.stringify(A.normalizeOptions({})) === JSON.stringify({ ideas: 3, versions: 2, usd: 20, minutes: 180, stopOnFind: true, scope: 'any', universe: 'sp500' }));

/* ---- 一轮完整的记账 + 硬规则 ---- */
const run = A.newRun({ budget: { ideas: 2, versions: 2 } }, { now: T0 });
const g = (tool, args, now = T0 + 1000) => A.guard(run, tool, args, { now });
const rec = (tool, args, result) => A.record(run, tool, args, result, { now: T0 + 2000 });
check('没登记：建项目被拒', no(g('create_project', { name: 'x', planIdea: 1 }), /autopilot_plan/));
check('没登记：想法检验被拒', no(g('test_idea', { projectId: 5, idea: 'x', factors: [] }), /autopilot_plan/));
check('没登记：回测被拒', no(g('create_backtest', { projectId: 5 }), /autopilot_plan/));
check('清单超过预算被拒', no(g('autopilot_plan', { ideas: [1, 2, 3].map((i) => ({ title: `t${i}`, logic: 'l' })) }), /超过预算/));
check('想法没写经济逻辑被拒', no(g('autopilot_plan', { ideas: [{ title: 't' }] }), /logic/));
const plan = { ideas: [{ title: '低波动', logic: '风险补偿' }, { title: '动量', logic: '反应不足' }] };
check('清单在预算内：放行', ok(g('autopilot_plan', plan)));
rec('autopilot_plan', plan, '已登记');
check('清单只能登记一次', no(g('autopilot_plan', plan), /已经登记/));
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

/* ---- 上限 ---- */
const r2 = A.newRun({ minutes: 10, usd: 5 }, { now: T0 });
check('超过时间上限：不能开新工作', no(A.guard(r2, 'autopilot_plan', plan, { now: T0 + 11 * 60000 }), /时间上限/));
r2.cost = 6;
check('超过用量上限：不能开新工作', no(A.guard(r2, 'autopilot_plan', plan, { now: T0 + 1000 }), /用量/));
check('只读工具不受上限影响', ok(A.guard(r2, 'read_backtest', { projectId: 1 }, { now: T0 + 11 * 60000 })));
r2.status = 'stopped';
check('运行结束后：一律拒绝', no(A.guard(r2, 'read_backtest', {}, { now: T0 }), /结束/));

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
} finally {
  await rm(TMP, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
