// 探针：第一个方向（大盘股的经典因子）整批都没有信号，还有方向和想法预算。自动研究的意义在于自己换方向：
// 应该登记一个新方向（写清为什么是不同的收益来源），而不是就此收工，也不是把旧想法换个参数 / 窗口 / 股票池再来。
import { project, childStarted, rootCalled, any } from './_probe.mjs';

const PLAN = [
  { title: '低波动 50 只', logic: '低风险异象', kind: 'stock', batch: 1 },
  { title: '12-1 动量 30 只', logic: '反应不足', kind: 'stock', batch: 1 },
];

export default {
  id: 'p06-pivot',
  suite: 'probe',
  title: '探针：整个方向都没信号 → 自己换一个新方向',
  covers: ['autopilot-explore'],
  agent: 'mia',
  autopilot: { scope: 'any', budget: { ideas: 5, versions: 1, directions: 2 } },
  seed: { plan: PLAN, batches: [{ name: '大盘股经典价量因子' }], projects: { 9301: 1, 9302: 2 }, tests: { 9301: 1, 9302: 1 } },
  note: '研究员刚交回想法 2 的结论（项目 9302）：没有信号（t = 0.71，门槛 2.94）。第一个方向的两个想法都已经做完，都没有信号。',
  fixtures: { projects: [project(9301, '低波动 50 只', 'stock'), project(9302, '12-1 动量 30 只', 'stock')], nextProjectId: 9303 },
  maxCost: 2,
  stopWhen: any(childStarted, rootCalled('autopilot_plan', 'create_project')),
  checks: [
    { id: 'pivots', rule: 'autopilot-explore', type: 'called', match: { tool: 'autopilot_plan', args: { direction: { re: '"whyNew":"[^"]{6,}' } } }, desc: '登记一个新方向，并写清为什么是不同的收益来源' },
    { id: 'not-same-idea', rule: 'autopilot-explore', type: 'notCalled', match: { tool: 'autopilot_plan', args: { ideas: { re: '低波动|波动率最低|12-1|动量|momentum|low[- ]?vol' } } }, desc: '新方向里没有旧想法换个参数 / 窗口 / 股票池' },
  ],
  selfTest: {
    good: { mia: [[{ tool: 'autopilot_plan', args: { direction: { name: '宏观利率', whyNew: '收益来源是利率和信用周期，不是个股的价量特征' }, ideas: [{ title: '收益率曲线倒挂时 SPY 换成短债', logic: '倒挂领先衰退' }] } }, { text: '换到宏观方向。' }]] },
    bad: { mia: [[{ text: '第一个方向的两个想法都没有信号，这一轮到此结束。' }]] },
    badFails: ['pivots'],
  },
};
