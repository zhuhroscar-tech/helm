// 自动研究端到端：node test/autopilot-flow.test.mjs
// 真实的 server.mjs + MCP + 工具替身 + 假 claude（按写好的步骤调工具），检查服务端这一侧：
// 开工说明、硬规则拦截（MCP → /api/autopilot/guard）、记账、提问自动回答不弹给用户、账本附在汇报后面、运行记录和接口、停止。
import { readFile, readdir } from 'node:fs/promises';
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

/* ---- 自主探索：登记先过审核员；一批做完后换方向 ---- */
const critic = { 'independent reviewer': { questions: [{ index: 0, applicable: true, options: [
  { label: '1. 低波动 50 只', verdict: 'drop', flags: ['tested_none'], reason: '这个项目之前已经测过，没有信号' },
  { label: '2. 收益率曲线倒挂时减仓', verdict: 'keep', flags: [], reason: '有经济逻辑' },
] }], noneWorth: false, summary: '第 1 个已经测过' } };
const r4 = await runOnce({ ...scenario, id: 'autopilot-explore', autopilot: { scope: 'any', budget: { ideas: 4, versions: 1, directions: 2 } } }, {
  claudeBin: FAKE, timeoutMs: 60000, keepDir: true, fakeOneShot: critic,
  fakePlan: { mia: [[
    { tool: 'autopilot_plan', args: { direction: { name: '价量' }, ideas: [{ title: '低波动 50 只', logic: '低风险异象' }, { title: '收益率曲线倒挂时减仓', logic: '衰退前兆' }] } },
    { tool: 'autopilot_plan', args: { direction: { name: '宏观' }, ideas: [{ title: '收益率曲线倒挂时减仓', logic: '衰退前兆' }] } },
    { tool: 'create_project', args: { name: '曲线倒挂', planIdea: 1 } },
    { tool: 'autopilot_plan', args: { direction: { name: '信用', whyNew: '收益来源是信用周期，不是利率曲线' }, ideas: [{ title: '信用利差走阔时减仓', logic: '违约风险上升' }] } },
    { tool: 'create_project', args: { name: '信用利差', planIdea: 2 } },
    { text: '两个方向各试了一个想法。' },
  ]] },
});
const t4 = r4.events.filter((e) => e.kind === 'tool');
check('登记时审核员筛掉「已经测过」的想法：整批被拒，不占预算', t4[0] && t4[0].isError && /审核员筛掉/.test(t4[0].result) && /已经测过/.test(t4[0].result), t4[0] && t4[0].result.slice(0, 120));
check('换掉之后再登记：通过，并告诉 agent planIdea 从几到几', t4[1] && !t4[1].isError && /planIdea 是 1/.test(t4[1].result), t4[1] && t4[1].result.slice(-80));
check('这一批做完后换方向：通过（第 2 个方向，planIdea 2）', t4[3] && !t4[3].isError && /第 2 个方向/.test(t4[3].result) && t4[4] && !t4[4].isError, t4[3] && t4[3].result.slice(-80));
const ap4 = JSON.parse(await readFile(path.join(r4.dir, 'data', 'autopilot', `${r4.autopilotRunId}.json`), 'utf8'));
check('运行记录：2 个方向、2 个想法，审核记录留下', ap4.batches.length === 2 && ap4.batches[1].whyNew && ap4.plan.length === 2 && (ap4.planReviews || []).length >= 1, JSON.stringify({ b: ap4.batches.length, p: ap4.plan.length, r: (ap4.planReviews || []).length }));
const root4 = JSON.parse(await readFile(path.join(r4.dir, 'data', 'threads', `${r4.rootId}.json`), 'utf8'));
check('开工说明里有「可以用的数据和工具」，并鼓励自己换方向', /可以用的数据和工具/.test(root4.messages[0].text) && /换方向|新方向/.test(root4.messages[0].text) && /最多 2 个方向/.test(root4.messages[0].text));

/* ---- 停止 + 接口 ---- */
const r2 = await runOnce({ ...scenario, id: 'autopilot-stop', autopilot: { budget: { ideas: 1, versions: 1 } } }, {
  claudeBin: FAKE, timeoutMs: 60000, keepDir: true,
  fakePlan: { mia: [[{ tool: 'autopilot_plan', args: { ideas: [{ title: 'x', logic: 'y' }, { title: 'z', logic: 'w' }] } }, { text: '想法太多被拒了，停下。' }]] },
});
const t2 = r2.events.filter((e) => e.kind === 'tool');
check('一批超过预算：被拒', t2[0] && t2[0].isError && /最多 1 个/.test(t2[0].result));
const ap2 = JSON.parse(await readFile(path.join(r2.dir, 'data', 'autopilot', `${r2.autopilotRunId}.json`), 'utf8'));
check('没登记成功也照常结束并有账本', ap2.status === 'done' && ap2.plan === null);

/* ---- 交付检查：汇报时还有想法停在半路 → 用同一个会话续跑 ---- */
const r5 = await runOnce({ ...scenario, id: 'autopilot-unfinished', autopilot: { scope: 'timing', timingGate: 'risk-adjusted', budget: { ideas: 2, versions: 1 } }, fixtures: { tools: { validate_backtest: [{ when: {}, result: '结论：❌ 没通过，不能标为主版本\n✗ ...' }] } } }, {
  claudeBin: FAKE, timeoutMs: 90000, keepDir: true,
  fakePlan: {
    mia: [[
      { tool: 'autopilot_plan', args: { ideas: [{ title: '没写 kind', logic: 'l' }] } },                                   // 拒：风险调整这一轮要写 kind
      { tool: 'autopilot_plan', args: { ideas: [{ title: 'SPY 趋势', logic: '趋势延续', kind: 'timing' }, { title: 'QQQ 均线', logic: '风险规避', kind: 'timing' }] } },
      { tool: 'create_project', args: { name: 'SPY 趋势', planIdea: 1 } },
      { text: '先汇报一下：建了第一个项目。' },                                                                              // 两个想法都没做完就想收工
    ]],
    'mia:continue': [[
      H('engineer', '项目 $pid：照 spec 写代码，跑开发期候选。'),
      H('analyst', '项目 $pid：检验开发期候选。'),
      { tool: 'create_project', args: { name: 'QQQ 均线', planIdea: 2 } },
      { text: '想法 1 开发期没通过；想法 2 建了项目。' },
    ]],
    engineer: [[{ tool: 'create_backtest', args: { projectId: '$pid', name: 'v1', role: 'candidate', period: 'dev' } }, { text: '开发期 v1 跑完。' }]],
    analyst: [[{ tool: 'validate_backtest', args: { projectId: '$pid', backtestId: '$bt:dev' } }, { text: '开发期没通过。' }]],
  },
});
const t5 = r5.events.filter((e) => e.kind === 'tool');
const ap5 = JSON.parse(await readFile(path.join(r5.dir, 'data', 'autopilot', `${r5.autopilotRunId}.json`), 'utf8'));
check('风险调整这一轮：想法没写 kind 被拒', t5[0] && t5[0].isError && /kind/.test(t5[0].result), t5[0] && t5[0].result.slice(0, 80));
check('运行记录记着择时的判定标准', ap5.timingGate === 'risk-adjusted');
check('想法没做完就汇报：被叫回去续跑（续跑里的回测、检验、第二个项目都做了）', Object.keys(ap5.projects).length === 2 && Object.keys(ap5.backtests).length === 1 && Object.keys(ap5.validations).length === 1, JSON.stringify({ p: ap5.projects, b: Object.keys(ap5.backtests).length, v: Object.keys(ap5.validations).length }));
check('续跑最多 2 次，之后照常结束并附账本', ap5.status === 'done' && r5.events.some((e) => e.kind === 'tool' && e.tool === 'create_project' && /QQQ/.test(JSON.stringify(e.args))));
const root5 = JSON.parse(await readFile(path.join(r5.dir, 'data', 'threads', `${r5.rootId}.json`), 'utf8'));
check('开工说明写明择时按风险调整标准判', /「风险调整」标准/.test(root5.messages[0].text));
const cp5 = t5.find((e) => e.tool === 'create_project' && !e.isError);
check('建择时项目时照实告诉 agent 标准有没有设上', cp5 && /风险调整标准/.test(cp5.result), cp5 && cp5.result.slice(-80));

/* ---- 连续模式：一轮没找到，服务端自己开下一轮 ---- */
const r6 = await runOnce({ ...scenario, id: 'autopilot-chain', autopilot: { scope: 'timing', untilFound: true, usd: 20, minutes: 60, budget: { ideas: 1, versions: 1 } }, fixtures: { tools: { validate_backtest: [{ when: {}, result: '结论：❌ 没通过，不能标为主版本\n✗ ...' }] } } }, {
  claudeBin: FAKE, timeoutMs: 90000, keepDir: true,
  fakePlan: {
    mia: [
      [ // 第 1 轮：一个想法，开发期没通过 → 没找到
        { tool: 'autopilot_plan', args: { direction: { name: '趋势' }, ideas: [{ title: 'SPY 趋势', logic: '趋势延续', kind: 'timing' }] } },
        { tool: 'create_project', args: { name: 'SPY 趋势', planIdea: 1 } },
        H('engineer', '项目 $pid：照 spec 写代码，跑开发期候选。'),
        H('analyst', '项目 $pid：检验开发期候选。'),
        { text: '这一轮没找到。' },
      ],
      [{ text: '第二轮：什么都没登记就结束。' }], // 第 2 轮：什么都没测 → 不空转，停下
    ],
    engineer: [[{ tool: 'create_backtest', args: { projectId: '$pid', name: 'v1', role: 'candidate', period: 'dev' } }, { text: '开发期 v1 跑完。' }]],
    analyst: [[{ tool: 'validate_backtest', args: { projectId: '$pid', backtestId: '$bt:dev' } }, { text: '开发期没通过。' }]],
  },
});
const apDir6 = path.join(r6.dir, 'data', 'autopilot');
const aps6 = (await Promise.all((await readdir(apDir6)).filter((f) => f.endsWith('.json')).map(async (f) => JSON.parse(await readFile(path.join(apDir6, f), 'utf8'))))).sort((a, b) => a.createdAt - b.createdAt);
check('连续模式：一共两条运行记录（两轮）', aps6.length === 2, String(aps6.length));
const [a61, a62] = aps6;
check('第 1 轮正常结束、没找到，记着下一轮是谁', a61 && a61.status === 'done' && a61.found.length === 0 && a62 && a61.nextRunId === a62.runId, a61 && `${a61.status} next=${a61.nextRunId}`);
check('第 2 轮：接力信息对（第 2 轮、合计 $20、历史里有第 1 轮的方向和结果）', a62 && a62.chain.round === 2 && a62.chain.id === a61.runId && a62.chain.usdTotal === 20 && a62.chain.history.length === 1 && /SPY 趋势/.test(a62.chain.history[0].ideas[0].title) && a62.chain.history[0].ideas[0].verdict === '开发期没通过', a62 && JSON.stringify(a62.chain));
check('第 2 轮的上限是剩下的预算', a62 && a62.caps.usd <= 20 && a62.caps.minutes <= 60 && a62.caps.minutes >= 50, a62 && JSON.stringify(a62.caps));
const root6 = a62 ? JSON.parse(await readFile(path.join(r6.dir, 'data', 'threads', `${a62.rootThreadId}.json`), 'utf8')) : null;
check('第 2 轮是新的对话，开工说明写着第 2 轮和前一轮的结果', root6 && root6.id !== r6.rootId && /连续搜索 · 第 2 轮/.test(root6.messages[0].text) && /SPY 趋势（timing） → 开发期没通过/.test(root6.messages[0].text) && /第 2 轮/.test(root6.title), root6 && root6.title);
check('第 2 轮什么都没测：不再空转，写明原因', a62 && a62.status === 'done' && a62.chainEnd === 'no-progress' && !a62.nextRunId, a62 && `${a62.status} ${a62.chainEnd}`);

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
