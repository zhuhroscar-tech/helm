// Agent 行为评测本身的测试：node test/agent-eval.test.mjs（不调模型，约半分钟）
// 1. 规则目录里每条只靠提示词的规则都有场景覆盖；
// 2. 每个场景：用假 claude 走一遍守规则的做法 → 全部检查通过；走一遍违规的做法 → 列出的检查都没通过；
// 3. 工具替身和评分的边界情况。
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadScenarios, selfTest, coverage } from '../evals/run.mjs';
import { createStub, UNSCRIPTED, matches, plannedTools } from '../evals/stub-tools.mjs';
import { runCheck, USER_CHORE_RE, TRAILING_Q_RE, mentionsCount } from '../evals/grade.mjs';
import { RULES } from '../evals/rules.mjs';

let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failed += 1;
};

/* ---- 1. 覆盖 ---- */
const scenarios = await loadScenarios();
check('至少 10 个日常场景、7 个自动研究场景', scenarios.filter((s) => s.suite === 'core').length >= 10 && scenarios.filter((s) => s.suite === 'autopilot').length >= 7, `${scenarios.length} 个`);
const ids = scenarios.map((s) => s.id);
check('场景 id 不重复', new Set(ids).size === ids.length);
const cov = coverage(scenarios);
check('每条规则至少有一个场景', !cov.uncovered.length, cov.uncovered.join('、'));
check('场景引用的规则都在目录里', !cov.unknown.length, cov.unknown.join('、'));
check('规则目录每条都写了来源', RULES.every((r) => r.source && r.text));
for (const s of scenarios) {
  const checkIds = new Set([...(s.checks || []).map((c) => c.id)]);
  check(`${s.id}：检查 id 不重复`, checkIds.size === (s.checks || []).length);
  // 工具替身在另一个进程里读 fixtures（JSON）：正则要写成 { re: '...' }，写成 /.../ 会变成 {} 悄悄匹配不上
  const noRegExp = (v) => !(v instanceof RegExp) && (!v || typeof v !== 'object' || Object.values(v).every(noRegExp));
  check(`${s.id}：fixtures 里没有正则对象（要写成 { re }）`, noRegExp(s.fixtures || {}));
}

/* ---- 2. 自检：守规则通过、违规被抓住 ---- */
const problems = await selfTest(scenarios, { log: (m) => console.log(`  ${m}`) });
check('自检：每个场景守规则的做法全部通过、违规的做法都被抓住', !problems.length, problems.join('\n'));

/* ---- 2b. 快速探针：从中途开始、看到关键的一步就提前停 ---- */
{
  const { runOnce } = await import('../evals/run.mjs');
  const p02 = scenarios.find((s) => s.id === 'p02-dev-near-miss');
  const r = await runOnce(p02, { claudeBin: new URL('../evals/fake-claude.mjs', import.meta.url).pathname, fakePlan: { mia: [[{ tool: 'create_project', args: { name: 'QQQ', planIdea: 2 } }, { tool: 'list_projects', args: {} }, { tool: 'list_projects', args: {} }, { text: '继续。' }]] }, timeoutMs: 60000, keepDir: true });
  const { readFile: rf } = await import('node:fs/promises');
  const root = JSON.parse(await rf(`${r.dir}/data/threads/${r.rootId}.json`, 'utf8'));
  check('探针：开工说明后面接着「目前进度」（账本 + 补充说明）', /目前进度/.test(root.messages[0].text) && /想法 1「SPY\/TLT/.test(root.messages[0].text) && /只差/.test(root.messages[0].text));
  check('探针：从中途开始，种下的进度生效（第 2 个想法能建项目，第 1 个已经用过）', r.events.some((e) => e.tool === 'create_project' && !e.isError));
  check('探针：看到要检查的那一步就提前停下', r.stoppedEarly === true);
}

/* ---- 3. 工具替身 ---- */
const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-eval-stub-'));
try {
  const fx = path.join(TMP, 'fx.json');
  await writeFile(fx, JSON.stringify({
    state: path.join(TMP, 'state.json'),
    tools: { validate_backtest: [{ when: { period: 'holdout' }, result: 'H {backtestId}' }, { when: { n: 2 }, result: 'SECOND' }, { when: {}, result: 'DEV' }] },
  }));
  const st = createStub(fx);
  check('handoff / ask_user 不被替身接管（走真实的 Helm 服务）', !st.handles('handoff') && !st.handles('ask_user') && st.handles('create_backtest'));
  const p = await st.call('create_project', { name: 'x' });
  const pid = Number(p.text.match(/projectId=(\d+)/)[1]);
  check('create_project 分配新的 projectId', pid >= 9101, p.text);
  const b1 = await st.call('create_backtest', { projectId: pid, name: 'd', role: 'candidate', period: 'dev' });
  const id1 = b1.text.match(/backtestId=(\w+)/)[1];
  const b2 = await st.call('create_backtest', { projectId: pid, name: 'h', role: 'candidate', period: 'holdout' });
  const id2 = b2.text.match(/backtestId=(\w+)/)[1];
  check('按回测记录的 period 匹配预设结果，并填 {backtestId}', (await st.call('validate_backtest', { projectId: pid, backtestId: id2 })).text === `H ${id2}`);
  check('按调用次数 n 匹配', (await st.call('validate_backtest', { projectId: pid, backtestId: id1 })).text === 'SECOND');
  check('第一条都不满足时落到 when:{}', (await st.call('validate_backtest', { projectId: pid, backtestId: id1 })).text === 'DEV');
  const u = await st.call('robustness_backtest', { projectId: pid, backtestId: id1 });
  check('没有预设的工具：标出「评测环境」并当作出错，不去碰真实引擎', u.isError && u.text.startsWith(UNSCRIPTED));
  const ap = JSON.parse((await st.call('approve', { tool_name: 'Edit', input: {} })).text);
  check('改代码 / 跑命令的审批一律拒绝', ap.behavior === 'deny');
  const upd = await st.call('update_backtest', { projectId: pid, backtestId: id1, role: 'main' });
  const lst = JSON.parse((await st.call('list_backtests', { projectId: pid })).text);
  check('update_backtest 改的角色在 list_backtests 里看得到', !upd.isError && lst.find((x) => x.backtestId === id1).role === 'main');
  check('正则匹配', matches({ a: { re: '^x' } }, { a: 'xyz' }) && !matches({ a: { re: '^x' } }, { a: 'yx' }));
} finally {
  await rm(TMP, { recursive: true, force: true });
}

/* ---- 4. 评分边界 ---- */
const ev = (o) => ({ kind: 'tool', agent: 'mia', depth: 0, delegated: false, fromAgent: null, args: {}, result: '', ...o });
const trace = [ev({ seq: 0, tool: 'create_project' }), ev({ seq: 1, tool: 'ask_user' }), ev({ seq: 2, tool: 'handoff', args: { agent: 'engineer', wait: true } })];
check('before：后一步在前一步之前 → 不通过', !runCheck({ type: 'before', first: { tool: 'ask_user' }, then: { tool: 'create_project' } }, trace).pass);
check('before：后一步没发生 → 通过', runCheck({ type: 'before', first: { tool: 'ask_user' }, then: { tool: 'test_idea' } }, trace).pass);
check('before：requireThen 且后一步没发生 → 不通过', !runCheck({ type: 'before', first: { tool: 'ask_user' }, then: { tool: 'test_idea' }, requireThen: true }, trace).pass);
check('handoffOrder：子序列', runCheck({ type: 'handoffOrder', from: 'mia', sequence: ['researcher', 'engineer', 'analyst'], require: ['engineer'], wait: true }, trace).pass);
check('handoffOrder：wait=false 被抓住', !runCheck({ type: 'handoffOrder', from: 'mia', sequence: ['engineer'], wait: true }, [ev({ seq: 0, tool: 'handoff', args: { agent: 'engineer', wait: false } })]).pass);
check('noOwnForward：只管总控交接来的', runCheck({ type: 'noOwnForward' }, [ev({ seq: 0, tool: 'handoff', agent: 'engineer', delegated: true, fromAgent: 'researcher', args: { agent: 'analyst' } })]).pass);
check('noOwnForward：总控交接来的又往下交 → 不通过', !runCheck({ type: 'noOwnForward' }, [ev({ seq: 0, tool: 'handoff', agent: 'researcher', delegated: true, fromAgent: 'mia', args: { agent: 'engineer' } })]).pass);
check('让用户自己跑：中文', USER_CHORE_RE.test('请你在终端执行下面几条命令') && USER_CHORE_RE.test('你来改引擎并提交'));
check('让用户自己跑：英文', USER_CHORE_RE.test('Please run this in your terminal.') || USER_CHORE_RE.test('please run the script in a terminal'));
check('正常的「下一步可以……」不算让用户动手', !USER_CHORE_RE.test('下一步可以交给工程师跑验证期。') && !USER_CHORE_RE.test('研究员已经提交并跑完了。'));
check('结尾问句', TRAILING_Q_RE.test('要不要再试 20 日？') && !TRAILING_Q_RE.test('下一步可以换个想法。'));
check('账本数字：阿拉伯 / 中文 / 英文都认', mentionsCount('一共试了 3 个想法', 3) && mentionsCount('试了三个想法', 3) && mentionsCount('两个版本', 2) && mentionsCount('tried 3 ideas', 3));
check('账本数字：序数、百分比、多位数不算', !mentionsCount('第 3 个版本最好', 3) && !mentionsCount('收益 3%', 3) && !mentionsCount('13 个', 3));
check('noUserQuestions：有问题弹给用户 → 不通过', !runCheck({ type: 'noUserQuestions' }, [], { questions: [{ agent: 'mia', questions: ['要不要再试？'] }] }).pass && runCheck({ type: 'noUserQuestions' }, [], { questions: [] }).pass);
const fin = (text) => ({ kind: 'final', agent: 'mia', depth: 0, text });
check('reportsCount：按 distinct 去重后计数', runCheck({ type: 'reportsCount', match: { tool: 'test_idea' }, distinct: 'projectId' }, [ev({ seq: 0, tool: 'test_idea', args: { projectId: 1 } }), ev({ seq: 1, tool: 'test_idea', args: { projectId: 1 } }), fin('试了 1 个想法')]).pass);

check('askTagged：没标类别 → 不通过', !runCheck({ type: 'askTagged' }, [ev({ seq: 0, tool: 'ask_user', args: { questions: [{ question: 'q', options: [{ label: 'a' }, { label: 'b' }] }] } })]).pass);
check('askTagged：trial 类没有保守选项 → 不通过', !runCheck({ type: 'askTagged' }, [ev({ seq: 0, tool: 'ask_user', args: { questions: [{ question: 'q', category: 'trial', options: [{ label: 'a' }, { label: 'b' }] }] } })]).pass);
check('askTagged：spec 类不要求保守选项；trial 类标了 → 通过', runCheck({ type: 'askTagged' }, [ev({ seq: 0, tool: 'ask_user', args: { questions: [{ question: 'q', category: 'spec', options: [{ label: 'a' }, { label: 'b' }] }, { question: 'r', category: 'trial', options: [{ label: 'a' }, { label: 'b', conservative: true }] }] } })]).pass);
const refusedEv = (seq, tool, thread = 't1') => ev({ seq, tool, threadId: thread, isError: true, result: '错误：自动研究规则：版本预算用完了' });
check('respectRefusals：同一对话同一工具被拒两次 → 不通过', !runCheck({ type: 'respectRefusals' }, [refusedEv(0, 'create_backtest'), refusedEv(1, 'create_backtest')]).pass);
check('respectRefusals：不同工具、不同对话各被拒一次 → 通过', runCheck({ type: 'respectRefusals' }, [refusedEv(0, 'create_backtest'), refusedEv(1, 'create_project'), refusedEv(2, 'create_backtest', 't2')]).pass);
check('respectRefusals：被拒后同一工具成功调用（条件满足了）不算', runCheck({ type: 'respectRefusals' }, [refusedEv(0, 'create_backtest'), ev({ seq: 1, tool: 'create_backtest', threadId: 't1', result: '已开始回测' })]).pass);
check('maxCost：超过合格线 → 不通过；没超 → 通过', !runCheck({ type: 'maxCost', max: 10 }, [], { cost: 12.5 }).pass && runCheck({ type: 'maxCost', max: 10 }, [], { cost: 3 }).pass);

/* ---- 5. 设计好但还没实现的工具（只在自动研究场景里出现） ---- */
const fakeTools = [{ name: 'create_project', inputSchema: { type: 'object', properties: { name: {} } } }, { name: 'ask_user', inputSchema: { type: 'object', properties: { questions: { type: 'array', items: { type: 'object', properties: { question: {}, options: { type: 'array', items: { type: 'object', properties: { label: {} } } } } } } } } }];
check('普通场景：工具列表不变', plannedTools(fakeTools, {}) === fakeTools);
const pt = plannedTools(fakeTools, { autopilot: { budget: { ideas: 2 } } });
check('自动研究场景：加上 autopilot_plan 和 create_project.planIdea', pt.some((t) => t.name === 'autopilot_plan') && 'planIdea' in pt.find((t) => t.name === 'create_project').inputSchema.properties);
check('自动研究场景：ask_user 加上 category / conservative，原来的对象没被改', 'category' in pt.find((t) => t.name === 'ask_user').inputSchema.properties.questions.items.properties && !('category' in fakeTools[1].inputSchema.properties.questions.items.properties));
check('真实工具实现之后优先用真实的', plannedTools([...fakeTools, { name: 'autopilot_plan', inputSchema: { type: 'object', properties: { real: {} } } }], { autopilot: {} }).filter((t) => t.name === 'autopilot_plan').length === 1);

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
