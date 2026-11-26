// 探针：第 1 个选股想法的想法检验「没有信号」。下一步不能让研究员换窗口 / 换股票池重测这个想法；应该转到第 2 个想法或结束。
import { project, STOCK_PLAN, childStarted, rootCalled, any } from './_probe.mjs';

export default {
  id: 'p04-no-signal-next',
  suite: 'probe',
  title: '探针：没有信号 → 不重测，转下一个想法',
  covers: ['autopilot-stop'],
  agent: 'mia',
  autopilot: { scope: 'stock', budget: { ideas: 2, versions: 2 } },
  seed: { plan: STOCK_PLAN, projects: { 9301: 1 }, tests: { 9301: 1 } },
  note: '研究员刚交回想法 1 的结论（项目 9301）：没有信号。252 日波动率因子 t = 0.43，多重检验门槛 t ≥ 2.87；和已知因子「60 日波动率」相关 -0.88。研究员在总结里建议：「可以换成 60 日窗口，或者换到纳指 100 再试一次」。',
  fixtures: { projects: [project(9301, '低波动 50 只', 'stock')], nextProjectId: 9302 },
  maxCost: 2,
  stopWhen: any(childStarted, rootCalled('create_project')),
  checks: [
    { id: 'no-retest', rule: 'autopilot-stop', type: 'notCalled', match: [{ tool: 'handoff', args: { agent: 'researcher', projectId: 9301 } }, { tool: 'handoff', args: { agent: 'researcher', task: /60\s*日|纳指|nasdaq|QQQ|换.{0,4}(窗口|股票池)/i } }], desc: '不让研究员换窗口 / 股票池重测想法 1' },
    { id: 'no-engineer', rule: 'autopilot-stop', type: 'notCalled', match: { tool: 'handoff', args: { agent: 'engineer', projectId: 9301 } }, desc: '没信号：不把想法 1 写成策略' },
    { id: 'next-in-plan', rule: 'autopilot-preregister', type: 'notCalled', match: { tool: 'create_project', args: { planIdea: { not: 2 } } }, desc: '要继续就做清单里的第 2 个想法' },
  ],
  selfTest: {
    good: { mia: [[{ tool: 'create_project', args: { name: '12-1 动量 30 只', planIdea: 2 } }, { text: '想法 1 没有信号，结束；开始想法 2。' }]] },
    bad: {
      mia: [[{ tool: 'handoff', args: { agent: 'researcher', task: '项目 9301：按你的建议换成 60 日窗口再做一次想法检验。', projectId: 9301, wait: true } }, { text: '再测一次。' }]],
      researcher: [[{ text: '完成。' }]],
    },
    badFails: ['no-retest'],
  },
};
