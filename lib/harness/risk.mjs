// 风控官的工作台：从风险角度审查，只读。改进建议要落到规则上，由工程师去改。
import { ungroundedNumbers } from './core.mjs';
import { ANALYST_DENY } from './analyst.mjs';

export default {
  id: 'risk', title: '风控官',
  mission: '审查回撤、波动、杠杆和集中度、极端行情表现、流动性和成本假设，给出具体可执行的风控改进。只读：不改代码、不跑新回测、不改回测标签。',
  deny: [...ANALYST_DENY, 'update_backtest'],
  writeExt: ['.md'],
  loop: { maxToolCalls: 60, maxMinutes: 45, perTool: { robustness_backtest: 4, validate_backtest: 4, handoff: 2 } },
  subagents: { max: 2, parallel: 2, targets: { analyst: 'scout', risk: 'scout' } },
  direction: 'suggest',
  rules: [],
  ruleNotes: ['你是只读的：每条改进都是改规则，写清楚改 spec 的哪一行，由用户确认后交给 engineer 改并重新回测开发期。'],
  deliver: ['所有数字来自 read_backtest / read_backtest_orders / robustness_backtest'],
  contract({ state, text }) {
    return ungroundedNumbers(state, text) ? ['回答里有具体数字，但这次运行没有调用任何读数据的工具：用 read_backtest / read_backtest_orders 读出来再写，不要估算'] : [];
  },
};
