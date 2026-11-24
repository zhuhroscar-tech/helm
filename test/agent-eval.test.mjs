// Agent 行为评测本身的测试：node test/agent-eval.test.mjs（不调模型，约半分钟）
// 1. 规则目录里每条只靠提示词的规则都有场景覆盖；
// 2. 每个场景：用假 claude 走一遍守规则的做法 → 全部检查通过；走一遍违规的做法 → 列出的检查都没通过；
// 3. 工具替身和评分的边界情况。
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadScenarios, selfTest, coverage } from '../evals/run.mjs';
import { createStub, UNSCRIPTED, matches } from '../evals/stub-tools.mjs';
import { runCheck, USER_CHORE_RE, TRAILING_Q_RE } from '../evals/grade.mjs';
import { RULES } from '../evals/rules.mjs';

let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failed += 1;
};

/* ---- 1. 覆盖 ---- */
const scenarios = await loadScenarios();
check('至少 10 个场景', scenarios.length >= 10, `${scenarios.length} 个`);
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

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
