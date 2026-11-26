// 研究员自己接的选股想法（不是总控交接来的），想法检验「信号弱」：要导出打分并交给工程师，回答里明说只是弱
// （真实对话 29e99902：信号弱就停了，标题写成「没有可以直接用的信号」）。
import { ideaResult } from './_common.mjs';

export default {
  id: 's12-weak-signal',
  title: '研究员：信号弱也导出并交给工程师，明说只是弱',
  covers: ['weak-signal-export'],
  agent: 'researcher',
  message: '项目 9012：想法是标普 500 里过去 5 天跌得最多的股票下周会反弹（短期反转）。做想法检验，有用的话继续往下做成策略。',
  context: { projectId: 9012, projectName: '短期反转' },
  fixtures: {
    projects: [{ projectId: 9012, name: '短期反转', description: '过去 5 天跌得最多的下周反弹', files: {} }],
    tools: {
      read_research: [{ when: {}, result: ideaResult({ title: '1 周反转', idea: '过去 5 天跌得最多的下周反弹', factors: [{ label: '1 周反转', verdict: '信号弱', t: '3.04', thr: '2.77', years: '0.88', note: '扣掉交易成本后多空收益不为正，所以只是弱' }] }) }],
    },
  },
  checks: [
    { id: 'exported', rule: 'weak-signal-export', type: 'called', match: { tool: 'export_signals', agent: 'researcher' }, desc: '信号弱也导出打分' },
    { id: 'handed', rule: 'weak-signal-export', type: 'called', match: { tool: 'handoff', agent: 'researcher', args: { agent: 'engineer' } }, desc: '交给工程师写成策略' },
    { id: 'export-first', rule: 'weak-signal-export', type: 'before', first: { tool: 'export_signals' }, then: { tool: 'handoff', agent: 'researcher', args: { agent: 'engineer' } }, desc: '先导出再交接' },
    { id: 'says-weak', rule: 'weak-signal-export', type: 'finalText', agent: 'researcher', mustMatch: [/弱|weak/i], desc: '明说只是「信号弱」' },
  ],
  selfTest: {
    good: {
      researcher: [[
        { tool: 'test_idea', args: { projectId: 9012, idea: '1 周反转', factors: [{ name: 'rev_1w', components: [{ expr: '-($close/Ref($close,5)-1)', weight: 1 }] }] } },
        { tool: 'read_research', args: { projectId: 9012, jobId: '$job' } },
        { tool: 'export_signals', args: { projectId: 9012, jobId: '$job', ideaFactor: 'rev_1w' } },
        { tool: 'handoff', args: { agent: 'engineer', task: '项目 9012：用 HelmSignals 把导出的 1 周反转打分写成 LEAN 策略，只回测开发期，做完总结。', projectId: 9012, wait: true } },
        { text: '结论：信号弱（t=3.04 刚过门槛，扣成本后多空不为正）。已导出并交给工程师回测开发期。' },
      ]],
      engineer: [[{ tool: 'create_backtest', args: { projectId: 9012, name: '开发期', role: 'candidate', period: 'dev' } }, { text: '完成。' }]],
    },
    bad: {
      researcher: [[
        { tool: 'test_idea', args: { projectId: 9012, idea: '1 周反转', factors: [{ name: 'rev_1w', components: [{ expr: '-($close/Ref($close,5)-1)', weight: 1 }] }] } },
        { tool: 'read_research', args: { projectId: 9012, jobId: '$job' } },
        { text: '结论：没有可以直接用的信号，到此为止。' },
      ]],
    },
    badFails: ['exported', 'handed', 'says-weak'],
  },
};
