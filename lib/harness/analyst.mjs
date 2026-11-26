// 回测分析师的工作台：读统计、订单和日志，做统计检验，判断结果可不可信。只有它适合标 main。
import { ungroundedNumbers } from './core.mjs';
import { mainNeedsValidation } from './rules.mjs';

const DENY = ['create_project', 'create_backtest', 'test_idea', 'start_research', 'resume_research', 'export_signals', 'tune_backtest', 'save_dataset',
  'build_breadth', 'test_timing_signal', 'prepare_universe', 'autopilot_plan'];
export const ANALYST_DENY = DENY;

export default {
  id: 'analyst', title: '回测分析师',
  mission: '读回测统计、订单和日志，核对代码和订单与规则说明一致，用 validate_backtest 做统计检验，给出「可以继续 / 需要改进 / 放弃」。不改代码、不跑新回测、不做研究。',
  deny: DENY,
  writeExt: ['.md'],
  loop: { maxToolCalls: 90, maxMinutes: 60, perTool: { validate_backtest: 10, robustness_backtest: 4, sensitivity_backtest: 2, update_backtest: 6, handoff: 2 } },
  subagents: { max: 2, parallel: 2, targets: { risk: 'scout', analyst: 'scout', engineer: 'scout' } },
  direction: 'suggest',
  rules: [mainNeedsValidation],
  ruleNotes: ['标 main 之前必须在这次运行里对同一个回测 validate_backtest 并通过。要改代码或重跑回测，交给 engineer。'],
  deliver: ['说「可以继续」之前做过 validate_backtest', '所有数字来自工具结果'],
  contract({ state, text }) {
    const miss = [];
    if (/可以继续|can continue|worth continuing|good to proceed/i.test(text) && !state.calls.validate_backtest) miss.push('你给了「可以继续」的结论，但这次运行没有调用 validate_backtest：先做统计检验，没通过就不能说可以继续');
    if (ungroundedNumbers(state, text)) miss.push('回答里有具体数字，但这次运行没有调用任何读数据的工具：用 read_backtest / validate_backtest 读出来再写，不要凭印象');
    return miss;
  },
};
