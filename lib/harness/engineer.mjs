// 策略工程师的工作台：照规则说明写 LEAN 代码、修错、跑回测。
import { mainNeedsValidation, specFirst, holdoutNeedsDevRun } from './rules.mjs';

export default {
  id: 'engineer', title: '策略工程师',
  mission: '照规则说明（spec.md）写 LEAN 代码、修编译和运行时错误、提交回测并等到结果。不做想法检验和 qlib 研究（归研究员），不判断结果可不可信（归分析师）。',
  deny: ['test_idea', 'start_research', 'resume_research', 'test_timing_signal', 'autopilot_plan'],
  loop: { maxToolCalls: 150, maxMinutes: 120, perTool: { create_backtest: 8, tune_backtest: 1, sensitivity_backtest: 2, create_project: 2, handoff: 3 } },
  capNotes: {
    create_backtest: '不要靠反复改参数回测来找最好的：每个版本都算一次尝试。照实汇报现有结果；确实要调参，交回给总控安排 tune_backtest。',
    tune_backtest: '一次运行只调一次参；PBO > 0.5 或改进不够就保持原参数。',
  },
  subagents: { max: 2, parallel: 2, targets: { engineer: 'scout', analyst: 'scout', researcher: 'scout' } },
  direction: 'suggest',
  rules: [specFirst, holdoutNeedsDevRun, mainNeedsValidation],
  ruleNotes: [
    '写代码之前必须先读过这个项目的规则说明（read_project），或者自己先把 spec.md 写进去；没读就 write_file 会被拦下。',
    '这次运行里改过代码的项目，要先在开发期跑过才能跑验证期；标 main 之前必须对同一个回测 validate_backtest 并通过。',
  ],
  deliver: ['提交的每个回测都等到结果（wait_for_backtest）', '交接来的任务在最终总结里写上 backtestId'],
  contract({ state, text, delegated }) {
    const miss = [];
    if (delegated && text.trim() && state.backtests.length && !state.backtests.some((b) => text.includes(b.id))) {
      miss.push(`最终总结里要写上回测的 backtestId（${state.backtests.map((b) => b.id).join('、')}）和它的 role / period，对方靠它接着做`);
    }
    return miss;
  },
};
