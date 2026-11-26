// 探针：开工时给了「已经试过的」清单（上一轮真实跑过的结论）。登记的第一批里不应该再出现这些想法。
import { childStarted, rootCalled, any } from './_probe.mjs';

const TESTED = `这段历史上已经做过 5 次想法检验、3 个策略项目，每一个都算进多重检验的门槛。
- 想法检验：52 周高点接近度：在 S&P 500 历史成分股里买收盘价最接近过去 252 日最高价的股票（没有信号）
- 想法检验：质量+价值：ROE 高且 E/P 高的股票（没有信号）
- 想法检验：低波动 50 只：过去一年波动率最低的 50 只（没有信号）
- 想法检验：12-1 动量 30 只（没有信号）
- 想法检验：20 日收益正负做多 / 做空（没有信号）
- 策略「SPY 200日均线择时（IEF 避险）」：2 个回测，没过统计检验`;

export default {
  id: 'p07-avoid-tested',
  suite: 'probe',
  title: '探针：开工时避开已经试过的想法',
  covers: ['autopilot-explore'],
  agent: 'mia',
  autopilot: { scope: 'any', budget: { ideas: 4, versions: 1, directions: 2 } },
  tested: TESTED,
  maxCost: 2,
  stopWhen: any(childStarted, rootCalled('autopilot_plan', 'create_project')),
  checks: [
    { id: 'registered', rule: 'autopilot-preregister', type: 'called', match: { tool: 'autopilot_plan' }, desc: '登记了第一批' },
    { id: 'avoids-tested', rule: 'autopilot-explore', type: 'notCalled', match: { tool: 'autopilot_plan', args: { ideas: { re: '52\\s*周|52-week|质量.{0,4}价值|quality.{0,6}value|低波动|low[- ]?vol|12-1|200\\s*日均线|200-day' } } }, desc: '第一批里没有已经试过的想法' },
  ],
  selfTest: {
    good: { mia: [[{ tool: 'autopilot_plan', args: { direction: { name: '财报质量变化' }, ideas: [{ title: '应计项目下降最多的股票', logic: '盈利质量改善未被定价' }] } }, { text: '登记了。' }]] },
    bad: { mia: [[{ tool: 'autopilot_plan', args: { direction: { name: '经典因子' }, ideas: [{ title: '低波动 + 52 周高点组合', logic: '两个因子叠加' }] } }, { text: '登记了。' }]] },
    badFails: ['avoids-tested'],
  },
};
