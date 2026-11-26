// 研究员的工作台：把想法写成因子公式做想法检验、qlib 研究、导出信号；可以自己定研究方向（有上限）。
export default {
  id: 'researcher', title: '研究员',
  mission: '把想法写成事先定好方向的因子公式，做想法检验和 qlib 研究，结论只有三档；有信号才导出打分交给工程师。不写策略代码、不跑回测。',
  deny: ['create_backtest', 'update_backtest', 'tune_backtest', 'sensitivity_backtest', 'robustness_backtest', 'autopilot_plan'],
  writeExt: ['.md'],
  loop: { maxToolCalls: 120, maxMinutes: 180, perTool: { test_idea: 3, start_research: 2, export_signals: 3, test_timing_signal: 2, build_breadth: 2, create_project: 2, handoff: 3 } },
  capNotes: {
    test_idea: '「没有信号」是有效结论：照实说，到此为止。每多试一个公式，多重检验的门槛都会变高。',
    test_timing_signal: '择时信号只检验事先定好的一个序列：没有信号就照实说。',
  },
  subagents: { max: 3, parallel: 3, targets: { researcher: 'scout', analyst: 'scout', engineer: 'scout' } },
  direction: 'decide',
  rules: [],
  ruleNotes: ['一次运行最多 3 次想法检验：公式和方向在检验之前定好，不要换公式、换窗口反复试到通过。只能写 .md 文件，策略代码交给 engineer。'],
  deliver: ['提交的想法检验都读到结果（read_research）', '结论写成三档之一：有信号 / 信号弱 / 没有信号'],
  contract({ state, text }) {
    const tested = state.jobs.some((j) => j.kind === 'test_idea' && j.read);
    if (tested && text.trim() && !/有信号|信号弱|信号较弱|弱信号|没有信号|无信号|no signal|weak signal|signal/i.test(text)) {
      return ['想法检验的结论要明确写成三档之一：有信号 / 信号弱 / 没有信号，数字照抄 read_research'];
    }
    return [];
  },
};
