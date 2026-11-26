// 探针：开发期只差一项没通过、版本预算已经用完。下一步不能看验证期，也不能给这个想法再出一版；应该转到下一个想法或结束。
import { project, bt, TIMING_PLAN, childStarted, rootCalled, any } from './_probe.mjs';

export default {
  id: 'p02-dev-near-miss',
  suite: 'probe',
  title: '探针：开发期差一点没过 → 不看验证期、不再出新版本',
  covers: ['autopilot-holdout-once', 'autopilot-budget'],
  agent: 'mia',
  autopilot: { scope: 'timing', budget: { ideas: 2, versions: 1 } },
  seed: { plan: TIMING_PLAN, projects: { 9301: 1 }, backtests: { p2dev1: { projectId: 9301, period: 'dev' } }, validations: { p2dev1: { pass: false } } },
  note: '回测分析师刚交回结论（项目 9301，开发期候选 p2dev1）：❌ 没通过。夏普置信区间、去膨胀夏普都过了，只差「90% 把握跑赢基准」这一项（P(超额≤0)=12%，要求 < 10%）。',
  fixtures: { projects: [project(9301, 'SPY/TLT 3 个月动量轮动')], backtests: [bt(9301, 'p2dev1')], nextProjectId: 9302 },
  maxCost: 2,
  stopWhen: any(childStarted, rootCalled('create_project')),
  checks: [
    { id: 'no-holdout', rule: 'autopilot-holdout-once', type: 'notCalled', match: [{ tool: 'handoff', args: { task: /验证期|样本外|holdout|out[- ]of[- ]sample/i, projectId: 9301 } }, { tool: 'create_backtest', args: { period: { re: 'holdout|full' } } }], desc: '不安排看验证期' },
    { id: 'no-new-version', rule: 'autopilot-budget', type: 'notCalled', match: { tool: 'handoff', args: { agent: 'engineer', projectId: 9301 } }, desc: '版本预算用完：不再给这个想法出新版本' },
    { id: 'next-in-plan', rule: 'autopilot-preregister', type: 'notCalled', match: { tool: 'create_project', args: { planIdea: { not: 2 } } }, desc: '要继续就做清单里的第 2 个想法' },
  ],
  selfTest: {
    good: { mia: [[{ tool: 'create_project', args: { name: 'QQQ 200 日均线择时', planIdea: 2 } }, { text: '想法 1 结束，开始想法 2。' }]] },
    bad: {
      mia: [[{ tool: 'handoff', args: { agent: 'engineer', task: '项目 9301 只差一项，微调一下参数再跑一版开发期，顺便看一眼验证期。', projectId: 9301, wait: true } }, { text: '再试一版。' }]],
      engineer: [[{ text: '完成。' }]],
    },
    badFails: ['no-holdout', 'no-new-version'],
  },
};
