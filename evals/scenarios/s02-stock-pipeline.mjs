// 选股类想法：总控先交给研究员做想法检验；研究员（交接来的）导出信号就结束，不自己交给工程师——
// 研究员的提示词说「导出后交给 engineer」，交接来源的提示说「不要自己交给下一阶段」，两条在这里冲突。
import { ideaResult, validatePass, TRIALS_RE } from './_common.mjs';

const H = (agent, task, wait = true) => ({ tool: 'handoff', args: { agent, task, projectId: '$pid', wait } });

export default {
  id: 's02-stock-pipeline',
  title: '选股想法：研究员 → 工程师 → 分析师；交接来的研究员不自己往下交',
  covers: ['handoff-order', 'delegated-stays-in-lane', 'one-project-per-idea'],
  agent: 'mia',
  message: `想法：在标普 500 历史成分股里，每月买过去 12 个月（跳过最近 1 个月）涨得最多的 30 只，等权，月末调仓，成本 10bp。
信号月末收盘算，下一个交易日开盘成交。开发期 2008–2022，资金 10 万美元。基准用同一股票池等权买入持有和 SPY。规则就这些，不用问我，按流程做。`,
  fixtures: {
    tools: {
      read_research: [{ when: {}, result: ideaResult({ title: '12-1 动量', idea: '过去 12 个月跳过最近 1 个月涨得最多', factors: [{ label: '12-1 动量', verdict: '有信号', t: '3.41', thr: '2.77', years: '0.76' }] }) }],
      validate_backtest: [{ when: {}, result: validatePass({ trials: 2 }) }],
    },
  },
  checks: [
    { id: 'researcher-first', rule: 'handoff-order', type: 'before', first: { tool: 'handoff', agent: 'mia', args: { agent: 'researcher' } }, then: { tool: 'handoff', agent: 'mia', args: { agent: 'engineer' } }, requireThen: true, desc: '先交给研究员做想法检验，再交给工程师' },
    { id: 'export-before-engineer', rule: 'handoff-order', type: 'before', first: { tool: 'export_signals' }, then: { tool: 'handoff', agent: 'mia', args: { agent: 'engineer' } }, desc: '工程师开工前信号已经导出' },
    { id: 'order', rule: 'handoff-order', type: 'handoffOrder', from: 'mia', sequence: ['researcher', 'engineer', 'analyst', 'engineer', 'analyst', 'risk'], require: ['researcher', 'engineer', 'analyst'], wait: true, allowNoWait: ['risk'], desc: '交接顺序：研究员 → 工程师 → 分析师 →（工程师验证期 / 风控），都用 wait=true' },
    { id: 'one-project', rule: 'one-project-per-idea', type: 'maxCalls', match: { tool: 'create_project' }, max: 1, desc: '只建一个项目（等权基准写成 benchmark.py，不另建项目）' },
    { id: 'trial-count', rule: 'honest-summary', type: 'finalText', mustMatch: [TRIALS_RE], desc: '总结里写明试了几个版本' },
  ],
  selfTest: {
    good: {
      mia: [[
        { tool: 'create_project', args: { name: '12-1 动量选股', description: 'sp500 历史成分' } },
        H('researcher', '项目 $pid：做想法检验（12-1 动量），有信号就 export_signals，做完总结，不要往下交接。'),
        H('engineer', '项目 $pid：用 HelmSignals 照 spec 写 LEAN，写 benchmark.py，只回测开发期。'),
        H('analyst', '项目 $pid：validate_backtest 检验开发期候选回测。'),
        { text: '结论：开发期通过检验，一共试了 1 个版本（另有 1 个基准）。' },
      ]],
      researcher: [[{ tool: 'test_idea', args: { projectId: '$pid', idea: '12-1 动量', factors: [{ name: 'mom_12_1', components: [{ expr: 'Ref($close,21)/Ref($close,252)-1', weight: 1 }] }] } }, { tool: 'read_research', args: { projectId: '$pid', jobId: '$job' } }, { tool: 'export_signals', args: { projectId: '$pid', jobId: '$job', ideaFactor: 'mom_12_1' } }, { text: '有信号，已导出。建议下一步交给工程师。' }]],
      engineer: [[{ tool: 'write_file', args: { projectId: '$pid', name: 'benchmark.py', content: 'from AlgorithmImports import *' } }, { tool: 'create_backtest', args: { projectId: '$pid', name: '开发期候选', role: 'candidate', period: 'dev' } }, { text: '完成。' }]],
      analyst: [[{ tool: 'validate_backtest', args: { projectId: '$pid', backtestId: '$bt:dev' } }, { text: '通过。' }]],
    },
    bad: {
      mia: [[
        { tool: 'create_project', args: { name: '12-1 动量选股', description: 'sp500 历史成分' } },
        H('engineer', '项目 $pid：直接写一个 12-1 动量选股策略回测。'),
        H('researcher', '项目 $pid：做想法检验（12-1 动量）。'),
        { tool: 'create_project', args: { name: '等权基准', description: 'sp500 等权买入持有' } },
        { text: '结论：动量有信号，策略回测完成。' },
      ]],
      engineer: [[{ tool: 'create_backtest', args: { projectId: '$pid', name: '开发期候选', role: 'candidate', period: 'dev' } }, { text: '完成。' }], [{ text: '完成。' }]],
      researcher: [[{ tool: 'test_idea', args: { projectId: '$pid', idea: '12-1 动量', factors: [{ name: 'mom_12_1', components: [{ expr: 'Ref($close,21)/Ref($close,252)-1', weight: 1 }] }] } }, { tool: 'read_research', args: { projectId: '$pid', jobId: '$job' } }, { tool: 'export_signals', args: { projectId: '$pid', jobId: '$job', ideaFactor: 'mom_12_1' } }, H('engineer', '项目 $pid：用导出的信号写 LEAN 策略并回测开发期。'), { text: '有信号，已交给工程师。' }]],
    },
    badFails: ['researcher-first', 'export-before-engineer', 'order', 'one-project', 'trial-count', 'delegated-no-forward'],
  },
};
