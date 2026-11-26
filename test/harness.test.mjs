// 每个 agent 的工作台（lib/harness/）：node test/harness.test.mjs
// 前半是纯函数（工具范围、循环上限、硬规则、交付检查、子 agent、研究方向）；
// 后半端到端：真实的 server.mjs + MCP + 工具替身 + 假 claude，检查拦截、续跑、并行子 agent、研究方向账本。
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Harness from '../lib/harness/index.mjs';
import { QC_TOOLS, effectiveTools } from '../lib/agents.mjs';
import { runOnce } from '../evals/run.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FAKE = path.join(ROOT, 'evals', 'fake-claude.mjs');
let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${String(extra).slice(0, 400)})` : ''}`);
  if (!cond) failed += 1;
};
const D = Harness.Directions;
const agents = JSON.parse(await readFile(path.join(ROOT, 'agents.json'), 'utf8'));
const ALL = QC_TOOLS.map((t) => t.id);
const hx = (id, thread = {}) => Harness.resolve(agents.find((a) => a.id === id), thread);
const ok = (g) => g.allow === true;

/* ---------------- 工具范围 ---------------- */
check('五个 agent 各有一份工作台', agents.every((a) => Harness.HARNESSES[a.id] && Harness.HARNESSES[a.id].id === a.id));
check('工作台里禁用的都是真实存在的工具', Object.values(Harness.HARNESSES).every((h) => (h.deny || []).every((t) => ALL.includes(t))));
const state = (id) => Object.fromEntries(effectiveTools(agents.find((a) => a.id === id)).map((t) => [t.id, t.state]));
check('工程师：能写代码和回测，不能做想法检验', state('engineer').write_file === 'allowed' && state('engineer').create_backtest === 'allowed' && state('engineer').test_idea === 'denied');
check('研究员：能做想法检验，不能回测，只能写 .md', state('researcher').test_idea === 'allowed' && state('researcher').create_backtest === 'denied' && state('researcher').write_file === 'limited');
check('分析师：能检验和标 main，不能回测和研究', state('analyst').validate_backtest === 'allowed' && state('analyst').update_backtest === 'allowed' && state('analyst').create_backtest === 'denied' && state('analyst').test_idea === 'denied');
check('风控官：只读，不能改回测标签', state('risk').update_backtest === 'denied' && state('risk').create_backtest === 'denied' && state('risk').read_backtest === 'allowed');
check('总控：沿用 agents.json 的禁用，能派子 agent 和定方向', state('mia').create_backtest === 'denied' && state('mia').subagent === 'allowed' && state('mia').research_direction === 'allowed');
const scout = hx('engineer', { sub: { mode: 'scout' } });
check('scout 子 agent：只留只读工具', Harness.deniedTools(scout, ALL).includes('write_file') && Harness.deniedTools(scout, ALL).includes('handoff') && Harness.deniedTools(scout, ALL).includes('subagent')
  && !Harness.deniedTools(scout, ALL).includes('read_backtest') && !Harness.isDenied(scout, 'approve'));

/* ---------------- 循环上限和硬规则 ---------------- */
{
  const h = hx('engineer'); const s = Harness.newState();
  check('工程师：不在工作台里的工具被拦，并说明归谁做', /researcher/.test(Harness.guard(h, s, 'test_idea', {}).message || ''));
  check('工程师：没读 spec 就写代码被拦', !ok(Harness.guard(h, s, 'write_file', { projectId: 7, name: 'main.py' })));
  check('工程师：写 spec.md 不用先读', ok(Harness.guard(h, s, 'write_file', { projectId: 7, name: 'spec.md' })));
  Harness.record(h, s, 'read_project', { projectId: 7 }, '项目：x（projectId=7）');
  check('工程师：读过项目之后可以写代码', ok(Harness.guard(h, s, 'write_file', { projectId: 7, name: 'main.py' })));
  Harness.record(h, s, 'write_file', { projectId: 7, name: 'main.py' }, '已更新 main.py');
  check('工程师：改过代码还没跑开发期，不能跑验证期', !ok(Harness.guard(h, s, 'create_backtest', { projectId: 7, period: 'holdout' })));
  Harness.record(h, s, 'create_backtest', { projectId: 7, period: 'dev', role: 'candidate' }, '已开始回测「v1」，backtestId=bt1（projectId=7）');
  check('工程师：开发期跑过之后可以跑验证期', ok(Harness.guard(h, s, 'create_backtest', { projectId: 7, period: 'holdout' })));
  check('标 main：没检验过被拦', /validate_backtest/.test(Harness.guard(h, s, 'update_backtest', { backtestId: 'bt1', role: 'main' }).message || ''));
  { // 验证期只能靠改起止日期来跑：另一次运行里的工程师只改日期，不该被当成「改了策略」（2026-11-25 真实运行里，开发期通过的候选因此跑不了验证期）
    const dev = 'class A(QCAlgorithm):\n    def initialize(self):\n        self.set_start_date(2008, 1, 1)\n        self.set_end_date(2019, 12, 31)\n        self.set_cash(100000)\n        self.spy = self.add_equity("SPY").symbol\n';
    const hold = dev.replace('2008, 1, 1', '2020, 1, 1').replace('2019, 12, 31', '2026, 10, 30');
    check('只改起止日期：算日期改动', Harness.datesOnlyChange(hold, [dev]) === true);
    check('照抄成另一个文件、只改日期（holdout.py）：也算', Harness.datesOnlyChange(hold, ['# other\n', dev]) === true);
    check('行尾空白、换行符不同不影响', Harness.datesOnlyChange(hold.replace(/\n/g, '\r\n').replace('set_cash(100000)', 'set_cash(100000)   '), [dev]) === true);
    check('顺手改了别的（资金）：不算', Harness.datesOnlyChange(hold.replace('100000', '200000'), [dev]) === false);
    check('顺手改了参数（把规则藏在日期行后面也不行）', Harness.datesOnlyChange(hold.replace('self.set_end_date(2026, 10, 30)', 'self.set_end_date(2026, 10, 30); self.lookback = 99'), [dev]) === false);
    check('多加一行逻辑：不算', Harness.datesOnlyChange(`${hold}        self.x = 1\n`, [dev]) === false);
    check('全新的代码（项目里没有对应的旧文件）：不算', Harness.datesOnlyChange(hold, []) === false && Harness.datesOnlyChange(hold, ['print(1)\n']) === false);
    check('把日期行删光：不算（没有日期行的回测会跑全部历史）', Harness.datesOnlyChange(dev.split('\n').filter((l) => !/set_(start|end)_date/.test(l)).join('\n'), [dev]) === false);
    check('空内容：不算', Harness.datesOnlyChange('', [dev]) === false && Harness.datesOnlyChange('', ['']) === false);
    const e2 = hx('engineer'); const s2 = Harness.newState(); // 新的一次运行：这次运行里没有开发期回测
    Harness.record(e2, s2, 'read_project', { projectId: 9 }, '项目：x（projectId=9）');
    Harness.record(e2, s2, 'write_file', { projectId: 9, name: 'main.py' }, '已更新 main.py', { datesOnly: true });
    check('另一次运行里只改了日期：可以跑验证期', ok(Harness.guard(e2, s2, 'create_backtest', { projectId: 9, period: 'holdout' })), JSON.stringify(Harness.guard(e2, s2, 'create_backtest', { projectId: 9, period: 'holdout' })));
    Harness.record(e2, s2, 'write_file', { projectId: 9, name: 'main.py' }, '已更新 main.py');
    const g2 = Harness.guard(e2, s2, 'create_backtest', { projectId: 9, period: 'holdout' });
    check('之后又改了策略：验证期被拦，并说明只改日期可以', !ok(g2) && /只改起止日期/.test(g2.message || ''), g2.message);
  }
  Harness.record(h, s, 'validate_backtest', { backtestId: 'bt1' }, '结论：❌ 未通过');
  check('标 main：检验没通过被拦', /没通过/.test(Harness.guard(h, s, 'update_backtest', { backtestId: 'bt1', role: 'main' }).message || ''));
  Harness.record(h, s, 'validate_backtest', { backtestId: 'bt1' }, '结论：✅ 通过，可以标为主版本');
  check('标 main：检验通过后放行', ok(Harness.guard(h, s, 'update_backtest', { backtestId: 'bt1', role: 'main' })));
  check('交付检查：回测没等结果', Harness.contract(h, s, '做完了', {}).some((m) => /wait_for_backtest/.test(m)));
  Harness.record(h, s, 'wait_for_backtest', { backtestId: 'bt1' }, '{}');
  check('交付检查：交接来的任务要写 backtestId', Harness.contract(h, s, '做完了', { delegated: true }).some((m) => /backtestId/.test(m)) && Harness.contract(h, s, '回测 bt1 完成', { delegated: true }).length === 0);
  for (let i = 0; i < 7; i++) Harness.record(h, s, 'create_backtest', { projectId: 7, name: `v${i}` }, `已开始回测，backtestId=x${i}`);
  check('单个工具的次数上限：第 9 次回测被拦', /最多 8 次/.test(Harness.guard(h, s, 'create_backtest', { projectId: 7, name: 'v9' }).message || ''));
  check('读过的 spec 留给同一个对话的下一次运行', Harness.newState({ carry: Harness.carryOf(s) }).specSeen[7] === true);
}
{
  const h = hx('analyst'); const s = Harness.newState();
  for (let i = 0; i < 3; i++) Harness.record(h, s, 'read_backtest', { backtestId: 'nope' }, '错误：回测 nope 不存在', { isError: true });
  check('同样的调用连续失败 3 次：第 4 次被拦', /连续失败/.test(Harness.guard(h, s, 'read_backtest', { backtestId: 'nope' }).message || '') && ok(Harness.guard(h, s, 'read_backtest', { backtestId: 'other' })));
  const s2 = Harness.newState();
  for (let i = 0; i < 5; i++) Harness.record(h, s2, 'list_projects', {}, '[]');
  check('同样的调用连着成功 5 次：被拦', /结果不会变/.test(Harness.guard(h, s2, 'list_projects', {}).message || ''));
  const s3 = Harness.newState();
  for (let i = 0; i < 9; i++) Harness.record(h, s3, 'wait_for_backtest', { backtestId: 'b' }, '{}');
  check('轮询类工具重复调用不拦', ok(Harness.guard(h, s3, 'wait_for_backtest', { backtestId: 'b' })));
  const s4 = Harness.newState(); s4.total = 90;
  check('工具调用预算用完：全部拦下', /预算/.test(Harness.guard(h, s4, 'read_backtest', {}).message || ''));
  const s5 = Harness.newState({ now: Date.now() - 61 * 60000 });
  check('超过时间上限：不再开新工作，只读还可以', !ok(Harness.guard(h, s5, 'validate_backtest', { backtestId: 'b' })) && ok(Harness.guard(h, s5, 'read_backtest', { backtestId: 'b' })));
  check('分析师：写代码被拦（只能写 .md）', /只能写/.test(Harness.guard(h, Harness.newState(), 'write_file', { projectId: 1, name: 'main.py' }).message || ''));
  check('分析师交付检查：没检验就说可以继续', Harness.contract(h, Harness.newState(), '结论：可以继续').some((m) => /validate_backtest/.test(m)));
  check('分析师交付检查：没读数据就给数字', Harness.contract(h, Harness.newState(), '夏普 1.2，回撤 12%，年化 9%，胜率 55%').some((m) => /读数据/.test(m)));
  const sAuto = Harness.newState({ autopilot: true }); sAuto.total = 200;
  check('自动研究里只留防死循环的上限（预算归 autopilot 管）', ok(Harness.guard(hx('mia'), sAuto, 'handoff', { agent: 'engineer', task: 'x' })) && Harness.loopOf(hx('mia'), sAuto).maxMinutes === 0);
}
{
  const h = hx('researcher'); const s = Harness.newState();
  for (let i = 0; i < 3; i++) Harness.record(h, s, 'test_idea', { projectId: 1, idea: `f${i}` }, `已开始想法检验 jobId=j${i}`);
  check('研究员：一次运行最多 3 次想法检验', /没有信号/.test(Harness.guard(h, s, 'test_idea', { projectId: 1, idea: 'f4' }).message || ''));
  check('研究员交付检查：想法检验没读结果', Harness.contract(h, s, '没有信号').some((m) => /read_research/.test(m)));
  Harness.record(h, s, 'read_research', {}, '结论：没有信号');
  check('研究员交付检查：结论要写成三档之一', Harness.contract(h, s, '做完了，见上').length === 1 && Harness.contract(h, s, '结论：没有信号').length === 0);
  const m = hx('mia'); const sm = Harness.newState();
  Harness.record(m, sm, 'handoff', { agent: 'engineer', projectId: 5, wait: true }, '策略工程师已完成');
  check('总控交付检查：交给工程师的项目要有 spec.md', Harness.contract(m, sm, '完成').length === 1);
  Harness.record(m, sm, 'write_file', { projectId: 5, name: 'spec.md' }, '已更新 spec.md');
  check('总控交付检查：写过 spec 就通过', Harness.contract(m, sm, '完成').length === 0);
}
check('提示词：写明循环上限、子 agent 和研究方向', /循环上限/.test(Harness.promptFor(hx('researcher'))) && /mcp__qc__subagent/.test(Harness.promptFor(hx('researcher'))) && /research_direction/.test(Harness.promptFor(hx('researcher')))
  && !/action=set/.test(Harness.promptFor(hx('engineer'))) && /scout/.test(Harness.promptFor(scout, { sub: { mode: 'scout' } })) && !/research_direction/.test(Harness.promptFor(hx('mia'), { autopilot: true })));

/* ---------------- 子 agent ---------------- */
{
  const ids = agents.map((a) => a.id);
  const T = (agent, mode) => ({ agent, task: '读项目 9001 的开发期回测，说明最大回撤发生在哪一段', ...(mode ? { mode } : {}) });
  const r = Harness.planSubagents(hx('researcher'), Harness.newState(), [T('analyst'), { ...T('researcher'), task: '查一下动量因子近年的文献，附链接和结论' }], { agents: ids });
  check('研究员派两个 scout', r.tasks && r.tasks.length === 2 && r.tasks.every((t) => t.mode === 'scout'));
  check('研究员不能派 worker', /scout/.test(Harness.planSubagents(hx('researcher'), Harness.newState(), [T('engineer', 'worker')], { agents: ids }).error || ''));
  check('风控官不能派给工程师', Boolean(Harness.planSubagents(hx('risk'), Harness.newState(), [T('engineer')], { agents: ids }).error));
  check('总控派的默认是 worker', Harness.planSubagents(hx('mia'), Harness.newState(), [T('engineer')], { agents: ids }).tasks[0].mode === 'worker');
  check('一次同时最多 parallel 个', Boolean(Harness.planSubagents(hx('engineer'), Harness.newState(), [T('engineer'), T('analyst'), T('researcher')], { agents: ids }).error));
  const used = Harness.newState(); used.children = 3;
  check('一次运行的总数上限', /最多派 3 个/.test(Harness.planSubagents(hx('researcher'), used, [T('analyst')], { agents: ids }).error || ''));
  check('子 agent 不能再往下派', Boolean(Harness.planSubagents(hx('engineer', { sub: { mode: 'worker' } }), Harness.newState(), [T('analyst')], { isSub: true, agents: ids }).error));
  check('两个一样的子任务被拒', Boolean(Harness.planSubagents(hx('mia'), Harness.newState(), [T('engineer'), T('engineer')], { agents: ids }).error));
}

/* ---------------- 研究方向 ---------------- */
{
  const l = D.newLedger('root1');
  const who = { by: 'researcher', threadId: 't', mode: 'decide' };
  const dir = (name, extra = {}) => ({ name, thesis: '盈利质量改善的公司被低估，市场对应计项目反应不足', hypotheses: [{ title: `${name}：应计比率低的股票之后跑赢`, failIf: 'IC 的 t 值低于门槛' }], ...extra });
  check('不负责定方向的 agent 不能 set', /不决定研究方向/.test(D.apply(l, 'set', dir('财报质量'), { by: 'engineer', mode: 'suggest' }).error || ''));
  check('可以提建议', D.apply(l, 'suggest', { text: '回测里发现小盘股的滑点假设偏乐观，值得单独研究' }, { by: 'engineer', mode: 'suggest' }).changed === true);
  check('假设要写怎样算失败', Boolean(D.apply(l, 'set', { ...dir('财报质量'), hypotheses: [{ title: 'x' }] }, who).error));
  check('假设最多 3 个', Boolean(D.apply(l, 'set', { ...dir('财报质量'), hypotheses: [1, 2, 3, 4].map((i) => ({ title: `h${i}`, failIf: 'f' })) }, who).error));
  check('登记第一个方向', D.apply(l, 'set', dir('财报质量'), who).changed === true && D.active(l).name === '财报质量');
  check('进行中不能再登记', /还在进行中/.test(D.apply(l, 'set', dir('宏观利率', { whyNew: '收益来源是利率期限结构，和个股基本面无关' }), who).error || ''));
  check('没跑过检验不能写成没有信号', /还没有跑过任何检验/.test(D.apply(l, 'conclude', { outcome: 'none', evidence: 'IC 很低，t 值 0.4，低于门槛，所以没有信号' }, who).error || ''));
  D.noteTool(l, 'test_idea', false); D.noteTool(l, 'test_idea', false);
  check('想法检验次数按假设数算（1 个假设 → 最多 2 次）', /上限 2 次/.test(D.guardTest(l, 'test_idea') || '') && D.guardTest(l, 'read_research') === null);
  check('结束要有依据', Boolean(D.apply(l, 'conclude', { outcome: 'none', evidence: '不行' }, who).error));
  check('结束方向', D.apply(l, 'conclude', { outcome: 'none', evidence: 'jobId=j1：IC 0.004，t 值 0.6，低于门槛，没有信号' }, who).changed === true && D.active(l) === null);
  check('换方向要写 whyNew', /whyNew/.test(D.apply(l, 'set', dir('宏观利率'), who).error || ''));
  check('不能重复以前的方向', /已经做过/.test(D.apply(l, 'set', dir('财报质量', { whyNew: '这次换一个窗口再看一遍同样的东西试试看行不行' }), who).error || ''));
  D.apply(l, 'set', dir('宏观利率', { whyNew: '收益来源是利率期限结构，和个股基本面无关' }), who);
  D.apply(l, 'conclude', { outcome: 'abandoned', evidence: '需要的利率期货数据本地没有，也没有免费的公开来源' }, who);
  D.apply(l, 'set', dir('市场宽度', { whyNew: '看的是大盘内部结构，不是利率也不是个股基本面' }), who);
  D.noteTool(l, 'test_timing_signal', false);
  D.apply(l, 'conclude', { outcome: 'weak', evidence: 'test_timing_signal：5 日持有 t 值 1.7，只是信号弱' }, who);
  check('三个方向都记下了', l.directions.length === 3 && l.directions.every((d) => d.status === 'closed'), JSON.stringify(l.directions.map((d) => [d.name, d.status])));
  check('方向数用完', /用完/.test(D.apply(l, 'set', dir('第四个', { whyNew: '又一个完全不同的收益来源，和前面三个都不相关' }), who).error || ''));
  check('账本文字列出方向、结论和建议', /财报质量/.test(D.ledgerText(l)) && /没有信号/.test(D.ledgerText(l)) && /滑点/.test(D.ledgerText(l)));
}

/* ---------------- 端到端 ---------------- */
const PROJECT = { projectId: 9001, name: 'SPY 均线', description: '', files: { 'spec.md': '# 规则说明\nSPY 50/200 均线', 'main.py': 'from AlgorithmImports import *\nclass A(QCAlgorithm):\n    pass' } };
const threadsOf = async (dir) => Promise.all((await readdir(path.join(dir, 'data', 'threads'))).filter((f) => f.endsWith('.json')).map(async (f) => JSON.parse(await readFile(path.join(dir, 'data', 'threads', f), 'utf8'))));
const toolsOf = (r) => r.events.filter((e) => e.kind === 'tool');
const refused = (r, tool, re) => toolsOf(r).some((e) => e.tool === tool && e.isError && re.test(e.result));

// 1. 工程师：拦截 + 续跑（提交了回测没等结果 → 工作台让它继续）
{
  const scenario = { id: 'hx-engineer', suite: 'harness', title: 'engineer', agent: 'engineer', message: '给项目 9001 加一个 10% 移动止损，回测开发期', checks: [], fixtures: { projects: [PROJECT] } };
  const plan = {
    engineer: [[
      { tool: 'write_file', args: { projectId: 9001, name: 'main.py', content: 'x = 1' } },                 // 拒：没读 spec
      { tool: 'test_idea', args: { projectId: 9001, idea: 'f', factors: [] } },                             // 拒：不在工作台里
      { tool: 'read_project', args: { projectId: 9001 } },
      { tool: 'write_file', args: { projectId: 9001, name: 'main.py', content: 'x = 2' } },
      { tool: 'create_backtest', args: { projectId: 9001, name: '加止损', role: 'candidate', period: 'dev' } },
      { tool: 'update_backtest', args: { projectId: 9001, backtestId: '$bt:dev', role: 'main' } },           // 拒：没检验
      { text: '已经提交回测。' },
    ]],
    'engineer:continue': [[{ tool: 'wait_for_backtest', args: { projectId: 9001, backtestId: '$bt:dev' } }, { text: '回测跑完了，夏普见上。' }]],
  };
  const r = await runOnce(scenario, { claudeBin: FAKE, fakePlan: plan, timeoutMs: 60000, keepDir: true });
  check('工程师：运行正常结束', !r.error && r.rootId, r.error || '');
  check('端到端：没读 spec 就写代码被拦', refused(r, 'write_file', /先 read_project/));
  check('端到端：不在工作台里的工具被拦', refused(r, 'test_idea', /不在「策略工程师」的工作台里/));
  check('端到端：读过之后写代码放行', toolsOf(r).some((e) => e.tool === 'write_file' && !e.isError));
  check('端到端：没检验就标 main 被拦', refused(r, 'update_backtest', /validate_backtest/));
  check('端到端：回测没等结果 → 工作台续跑，补上了 wait_for_backtest', toolsOf(r).some((e) => e.tool === 'wait_for_backtest' && !e.isError));
  const t = (await threadsOf(r.dir)).find((x) => x.id === r.rootId);
  const a = t.messages[t.messages.length - 1];
  check('端到端：续跑记在同一条回答里，只续了一次', t.messages.length === 2 && a.harness && a.harness.continuations === 1 && !a.harness.missing, JSON.stringify(a.harness));
  check('端到端：摘要里记了 3 次拦截', a.harness.refusals.length === 3 && a.harness.id === 'engineer');
  check('端到端：读过的 spec 记在对话上', t.harness && t.harness.specSeen.includes(9001));
}

// 2. 研究员：并行派两个只读子 agent；scout 改不了东西，也不能再往下派
{
  const scenario = { id: 'hx-subagent', suite: 'harness', title: 'subagent', agent: 'researcher', message: '看看项目 9001 值不值得继续研究', checks: [], fixtures: { projects: [PROJECT] } };
  const plan = {
    researcher: [
      [
        { tool: 'subagent', args: { tasks: [{ agent: 'engineer', task: '把项目 9001 改成每周调仓并回测开发期', mode: 'worker' }] } },      // 拒：只能 scout
        { tool: 'subagent', args: { tasks: [
          { agent: 'analyst', task: '读项目 9001 的代码和规则说明，说明有没有前视偏差', projectId: 9001 },
          { agent: 'researcher', task: '读项目 9001 的规则说明，判断均线交叉有没有经济逻辑', projectId: 9001 },
        ] } },
        { text: '两个子任务都回来了：没有信号。' },
      ],
      // 子 agent 里的研究员是第 2 次以 researcher 身份运行
      [{ tool: 'subagent', args: { tasks: [{ agent: 'analyst', task: '再往下派一层试试看能不能行得通' }] } }, { text: '研究员子任务结论：有经济逻辑。' }],
    ],
    analyst: [[
      { tool: 'validate_backtest', args: { projectId: 9001, backtestId: 'x' } },                                                         // 拒：scout 只读
      { tool: 'read_project', args: { projectId: 9001 } },
      { text: '分析师结论：没有前视偏差。' },
    ]],
  };
  const r = await runOnce(scenario, { claudeBin: FAKE, fakePlan: plan, timeoutMs: 60000, keepDir: true });
  check('子 agent：运行正常结束', !r.error && r.rootId, r.error || '');
  check('端到端：研究员派 worker 被拒', refused(r, 'subagent', /只能用 scout/));
  const call = toolsOf(r).find((e) => e.tool === 'subagent' && !e.isError && e.threadId === r.rootId);
  check('端到端：两个子 agent 的结论一起拿回来', Boolean(call) && /没有前视偏差/.test(call.result) && /有经济逻辑/.test(call.result), call && call.result);
  check('端到端：scout 调用会改东西的工具被拦', refused(r, 'validate_backtest', /不在「回测分析师」的工作台里/));
  check('端到端：子 agent 不能再往下派', refused(r, 'subagent', /subagent 不在「研究员」的工作台里/));
  const ts = await threadsOf(r.dir);
  const kids = ts.filter((x) => x.sub);
  check('端到端：子对话记了模式、来源和根对话', kids.length === 2 && kids.every((x) => x.sub.mode === 'scout' && x.from.threadId === r.rootId && x.root === r.rootId && x.depth === 1));
  check('端到端：父对话记了派出去 2 个', ts.find((x) => x.id === r.rootId).messages[1].harness.children === 2);
}

// 3. 研究员自己定研究方向：登记 → 检验 → 超过假设数被拦 → 结束 → 换方向要说明
{
  const scenario = { id: 'hx-direction', suite: 'harness', title: 'direction', agent: 'researcher', message: '我没有具体想法，你自己在 S&P 500 里找一个方向研究', checks: [],
    fixtures: { projects: [PROJECT], tools: { read_research: [{ when: {}, result: '结论：没有信号\nIC 0.003，t 值 0.5' }] } } };
  const IDEA = (n) => ({ tool: 'test_idea', args: { projectId: 9001, idea: `应计 ${n}`, factors: [{ name: `f${n}`, components: [{ expr: '$close', weight: 1 }] }] } });
  const SET = (name, extra = {}) => ({ tool: 'research_direction', args: { action: 'set', name, thesis: '应计比率低的公司盈利质量更高，市场对此反应不足', hypotheses: [{ title: `${name}：低应计跑赢`, failIf: 't 值低于门槛' }], ...extra } });
  const WHY = { whyNew: '收益来源是利率期限结构，和个股基本面无关' };
  const plan = {
    researcher: [[
      { tool: 'research_direction', args: { action: 'read' } },
      { tool: 'research_direction', args: { action: 'set', name: '财报质量', thesis: '太短' } },                              // 拒：没写清
      SET('财报质量'),
      IDEA(1), IDEA(2),
      IDEA(3),                                                                                                                // 拒：1 个假设最多 2 次
      { tool: 'read_research', args: { projectId: 9001 } },
      SET('宏观利率', WHY),                                                                                                   // 拒：上一个还没结束
      { tool: 'research_direction', args: { action: 'conclude', outcome: 'none', evidence: 'IC 0.003，t 值 0.5，低于门槛：没有信号' } },
      SET('宏观利率'),                                                                                                        // 拒：没写 whyNew
      SET('宏观利率', WHY),
      { text: '第一个方向没有信号，已经换到第二个方向。' },
    ]],
  };
  const r = await runOnce(scenario, { claudeBin: FAKE, fakePlan: plan, timeoutMs: 60000, keepDir: true });
  check('研究方向：运行正常结束', !r.error && r.rootId, r.error || '');
  const dirs = toolsOf(r).filter((e) => e.tool === 'research_direction');
  check('端到端：read 返回账本', dirs.length === 7 && /研究方向账本/.test(dirs[0].result), dirs[0] && dirs[0].result);
  check('端到端：逻辑没写清被拒', dirs[1].isError && /thesis/.test(dirs[1].result));
  check('端到端：登记成功，写明检验次数上限', !dirs[2].isError && /最多 2 次/.test(dirs[2].result));
  check('端到端：超过假设数的想法检验被拦', refused(r, 'test_idea', /上限 2 次/) && toolsOf(r).filter((e) => e.tool === 'test_idea' && !e.isError).length === 2);
  check('端到端：上一个没结束不能换方向', dirs[3].isError && /还在进行中/.test(dirs[3].result));
  check('端到端：结束后换方向要写 whyNew', !dirs[4].isError && dirs[5].isError && /whyNew/.test(dirs[5].result) && !dirs[6].isError);
  const ledger = JSON.parse(await readFile(path.join(r.dir, 'data', 'directions', `${r.rootId}.json`), 'utf8'));
  check('端到端：账本落盘（两个方向，第一个没有信号、检验 2 次）', ledger.directions.length === 2 && ledger.directions[0].outcome === 'none' && ledger.directions[0].tests === 2 && ledger.directions[1].status === 'active', JSON.stringify(ledger.directions.map((d) => [d.name, d.status, d.tests])));
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
