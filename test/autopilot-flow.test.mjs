// 自动研究端到端：node test/autopilot-flow.test.mjs
// 真实的 server.mjs + MCP + 工具替身 + 假 claude（按写好的步骤调工具），检查服务端这一侧：
// 开工说明、硬规则拦截（MCP → /api/autopilot/guard）、记账、提问自动回答不弹给用户、账本附在汇报后面、运行记录和接口、停止。
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOnce } from '../evals/run.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FAKE = path.join(ROOT, 'evals', 'fake-claude.mjs');
let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failed += 1;
};

const PASS = '结论：✅ 通过，可以标为主版本\n✓ 夏普 95% 置信区间下限 > 0';
const scenario = {
  id: 'autopilot-flow', suite: 'autopilot', title: 'flow', agent: 'mia', checks: [],
  autopilot: { scope: 'timing', budget: { ideas: 2, versions: 1 } },
  fixtures: { tools: { validate_backtest: [{ when: {}, result: PASS }] } },
};
const H = (agent, task) => ({ tool: 'handoff', args: { agent, task, projectId: '$pid', wait: true } });
const plan = {
  mia: [[
    { tool: 'create_project', args: { name: '太早了', planIdea: 1 } },                                      // 拒：没登记
    { tool: 'autopilot_plan', args: { ideas: [{ title: 'SPY/TLT 动量', logic: '趋势延续' }, { title: 'QQQ 均线', logic: '风险规避' }] } },
    { tool: 'ask_user', args: { questions: [{ question: '要不要多跑几个参数？', category: 'trial', options: [{ label: '多跑几个（推荐）' }, { label: '只跑一个', conservative: true }] }] } },
    { tool: 'create_project', args: { name: 'SPY/TLT 动量', planIdea: 1 } },
    { tool: 'create_project', args: { name: '同一个想法再建一个', planIdea: 1 } },                            // 拒：一个想法一个项目
    H('engineer', '项目 $pid：照 spec 写代码，跑开发期候选（只有 1 个版本的预算）。'),
    H('analyst', '项目 $pid：检验开发期候选。'),
    H('engineer', '项目 $pid：开发期通过，跑一次验证期。'),
    H('analyst', '项目 $pid：检验验证期。'),
    { tool: 'create_project', args: { name: 'QQQ 均线', planIdea: 2 } },                                     // 拒：找到就停
    { text: '找到一个候选：开发期、验证期都通过，等你确认。' },
  ]],
  engineer: [
    [
      { tool: 'create_backtest', args: { projectId: '$pid', name: 'v1', role: 'candidate', period: 'dev' } },
      { tool: 'create_backtest', args: { projectId: '$pid', name: '想先看验证期', role: 'candidate', period: 'holdout' } }, // 拒：开发期还没通过
      { tool: 'create_backtest', args: { projectId: '$pid', name: 'v2', role: 'candidate', period: 'dev' } },              // 拒：版本预算 1
      { text: '开发期 v1 跑完。' },
    ],
    [
      { tool: 'create_backtest', args: { projectId: '$pid', name: '验证期', role: 'candidate', period: 'holdout' } },
      { tool: 'update_backtest', args: { projectId: '$pid', backtestId: '$bt:holdout', role: 'main' } },                // 拒：不标 main
      { text: '验证期跑完。' },
    ],
  ],
  analyst: [
    [{ tool: 'validate_backtest', args: { projectId: '$pid', backtestId: '$bt:dev' } }, { text: '开发期通过。' }],
    [{ tool: 'validate_backtest', args: { projectId: '$pid', backtestId: '$bt:holdout' } }, { text: '验证期通过。' }],
  ],
};

const r = await runOnce(scenario, { claudeBin: FAKE, fakePlan: plan, timeoutMs: 90000, keepDir: true });
check('运行正常结束', !r.error && r.rootId, r.error || '');
const tools = r.events.filter((e) => e.kind === 'tool');
const refused = (tool, re) => tools.some((e) => e.tool === tool && e.isError && re.test(e.result));
check('没登记就建项目：被拒', refused('create_project', /先用 autopilot_plan/));
check('同一个想法建第二个项目：被拒', refused('create_project', /已经建过/));
check('开发期没通过就看验证期：被拒', refused('create_backtest', /不能看验证期/));
check('超过版本预算：被拒', refused('create_backtest', /版本预算/));
check('标 main：被拒', refused('update_backtest', /不能标 main/));
check('找到候选后再开新想法：被拒', refused('create_project', /找到/));
check('开发期通过后的验证期：放行', tools.some((e) => e.tool === 'create_backtest' && e.args.period === 'holdout' && !e.isError));
const ask = tools.find((e) => e.tool === 'ask_user');
check('提问由服务端自动回答，不弹给用户', ask && /自动研究自动回答/.test(ask.result) && r.questions.length === 0, ask && ask.result.slice(0, 120));
check('自动回答：trial 类、预算还有 → 按推荐', ask && /多跑几个（推荐）/.test(ask.result));
check('子对话也受同样的规则（交接时带上自动研究）', tools.some((e) => e.agent === 'engineer' && e.isError && /自动研究规则/.test(e.result)));

const root = JSON.parse(await readFile(path.join(r.dir, 'data', 'threads', `${r.rootId}.json`), 'utf8'));
const last = root.messages[root.messages.length - 1];
const led = last.parts.find((p) => p.helm === 'autopilot-ledger');
check('汇报后面附上了代码记的账本', led && /Helm 账本/.test(led.text) && /1\/2 个想法/.test(led.text) && /1 个候选两段都通过/.test(led.text), led && led.text);
check('评分时账本不算 agent 说的话', !r.events.some((e) => e.kind === 'final' && /Helm 账本/.test(e.text)));
check('根对话标着自动研究', Boolean(root.autopilot));
const runFile = path.join(r.dir, 'data', 'autopilot', `${root.autopilot}.json`);
const ap = JSON.parse(await readFile(runFile, 'utf8'));
check('运行记录：结束、找到 1 个候选、等用户确认', ap.status === 'done' && ap.found.length === 1 && ap.awaiting.some((w) => w.what === 'main'), `${ap.status} found=${ap.found.length}`);
check('运行记录：6 次拒绝、1 个自动决定都记下来了', ap.refusals.length === 6 && ap.decisions.length === 1 && ap.decisions[0].picked === '多跑几个（推荐）', `refusals=${ap.refusals.length} decisions=${ap.decisions.length}`);
check('运行记录：开工说明里写的预算和设置一致', ap.budget.ideas === 2 && ap.budget.versions === 1 && ap.caps.usd === 20);
check('开工说明由服务端生成（含 autopilot_plan、预算）', /自动研究/.test(root.messages[0].text) && /最多 2 个想法/.test(root.messages[0].text) && /autopilot_plan/.test(root.messages[0].text));

/* ---- 出错后换模型重发：从原来的进度接着做（真实情况：第一次用的模型账号用不了） ---- */
const r3 = await runOnce({ ...scenario, id: 'autopilot-resume', autopilot: { scope: 'timing', budget: { ideas: 1, versions: 1 } }, followUps: ['（换了模型重发）'] }, {
  claudeBin: FAKE, timeoutMs: 60000, keepDir: true,
  fakePlan: { mia: [
    [{ fail: 'Fable 5.1 requires usage credits.' }],
    [{ tool: 'autopilot_plan', args: { ideas: [{ title: 'SPY/TLT 动量', logic: '趋势延续' }] } }, { tool: 'create_project', args: { name: 'SPY/TLT 动量', planIdea: 1 } }, { text: '接着做了。' }],
  ] },
});
const t3 = r3.events.filter((e) => e.kind === 'tool');
check('出错后重发：工具没有被「已经结束」拒绝，能登记、能建项目', t3.length === 2 && t3.every((e) => !e.isError), t3.map((e) => `${e.tool}:${e.isError ? e.result.slice(0, 40) : 'ok'}`).join(' '));
const ap3 = JSON.parse(await readFile(path.join(r3.dir, 'data', 'autopilot', `${r3.autopilotRunId}.json`), 'utf8'));
check('出错后重发：运行记录恢复后正常结束，记着恢复过 1 次', ap3.status === 'done' && ap3.resumes === 1 && Object.keys(ap3.projects).length === 1, `${ap3.status} resumes=${ap3.resumes}`);

/* ---- 停止 + 接口 ---- */
const r2 = await runOnce({ ...scenario, id: 'autopilot-stop', autopilot: { budget: { ideas: 1, versions: 1 } } }, {
  claudeBin: FAKE, timeoutMs: 60000, keepDir: true,
  fakePlan: { mia: [[{ tool: 'autopilot_plan', args: { ideas: [{ title: 'x', logic: 'y' }, { title: 'z', logic: 'w' }] } }, { text: '想法太多被拒了，停下。' }]] },
});
const t2 = r2.events.filter((e) => e.kind === 'tool');
check('清单超过预算：被拒', t2[0] && t2[0].isError && /超过预算/.test(t2[0].result));
const ap2 = JSON.parse(await readFile(path.join(r2.dir, 'data', 'autopilot', `${r2.autopilotRunId}.json`), 'utf8'));
check('没登记成功也照常结束并有账本', ap2.status === 'done' && ap2.plan === null);

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
