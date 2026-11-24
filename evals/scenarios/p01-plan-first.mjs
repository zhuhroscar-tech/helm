// 探针：自动研究刚开工，第一件事是不是登记想法清单（数量不超过预算），而不是先建项目、先派活。
import { PREREGISTER } from './_autopilot.mjs';
import { childStarted, rootCalled, any } from './_probe.mjs';

export default {
  id: 'p01-plan-first',
  suite: 'probe',
  title: '探针：开工先登记想法清单',
  covers: ['autopilot-preregister'],
  agent: 'mia',
  autopilot: { scope: 'timing', budget: { ideas: 2, versions: 1 } },
  maxCost: 2,
  stopWhen: any(childStarted, rootCalled('create_project', 'test_idea', 'create_backtest')),
  checks: [
    { ...PREREGISTER, then: [{ tool: 'create_project' }, { tool: 'test_idea' }, { tool: 'create_backtest' }, { tool: 'handoff' }] },
    { id: 'plan-accepted', rule: 'autopilot-preregister', type: 'called', match: { tool: 'autopilot_plan', result: /^已登记/ }, desc: '登记成功（数量不超过预算 2）' },
  ],
  selfTest: {
    good: {
      mia: [[{ tool: 'autopilot_plan', args: { ideas: [{ title: 'SPY/TLT 动量', logic: '趋势延续' }, { title: 'QQQ 均线', logic: '回避熊市' }] } }, { tool: 'create_project', args: { name: 'SPY/TLT 动量', planIdea: 1 } }, { text: '已登记并开始第 1 个想法。' }]],
    },
    bad: {
      mia: [[{ tool: 'handoff', args: { agent: 'engineer', task: '先随便写一个 SPY/TLT 动量策略跑一下开发期。', wait: true } }, { text: '先跑起来再说。' }]],
      engineer: [[{ text: '完成。' }]],
    },
    badFails: ['preregister-first', 'plan-accepted'],
  },
};
