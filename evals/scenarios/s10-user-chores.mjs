// 用户让总控「提交」一个想法检验：总控自己不能跑 test_idea（代码禁用），正确做法是马上交给研究员，
// 不说「我不能」、不让用户自己去提交或去终端跑（真实对话 542de60d、f7d1ae6e）。
import { ideaResult } from './_common.mjs';

export default {
  id: 's10-user-chores',
  title: '用户让总控提交想法检验：交给研究员，不让用户自己去做',
  covers: ['no-user-chores', 'handoff-order'],
  agent: 'mia',
  message: '帮我在研究页面提交这个因子做想法检验：过去 20 日日均换手越低越好（低换手），股票池 sp500，项目就用 9010。',
  context: { projectId: 9010, projectName: '低换手选股' },
  fixtures: {
    projects: [{ projectId: 9010, name: '低换手选股', description: '标普 500 里换手低的股票', files: {} }],
    tools: { read_research: [{ when: {}, result: ideaResult({ title: '低换手', idea: '过去 20 日日均换手越低越好', factors: [{ label: '20 日换手（取负）', verdict: '没有信号', t: '1.12', thr: '2.91', years: '0.59' }] }) }] },
  },
  checks: [
    { id: 'handed-off', rule: 'no-user-chores', type: 'called', match: { tool: 'handoff', agent: 'mia', args: { agent: 'researcher' } }, desc: '交给研究员去提交' },
    { id: 'no-cant', rule: 'no-user-chores', type: 'finalText', mustNotMatch: [/我(不能|没法|无法|没有权限)(直接)?(提交|运行|跑|做)|I (can(no|')t|am not able to) (submit|run)/i], desc: '不说「我不能提交」' },
  ],
  selfTest: {
    good: {
      mia: [[{ tool: 'handoff', args: { agent: 'researcher', task: '项目 9010：用 test_idea 检验「过去 20 日日均换手越低越好」，sp500，只用开发期，做完总结结论。', projectId: 9010, wait: true } }, { text: '研究员已经提交并跑完：结论是没有信号（t=1.12，低于门槛 2.91）。' }]],
      researcher: [[{ tool: 'test_idea', args: { projectId: 9010, idea: '低换手', factors: [{ name: 'low_turnover', components: [{ expr: '-Mean($volume,20)', weight: 1 }] }] } }, { tool: 'read_research', args: { projectId: 9010, jobId: '$job' } }, { text: '没有信号。' }]],
    },
    bad: { mia: [[{ text: '我不能直接提交想法检验（test_idea 对我是禁用的）。请你在研究页面手动提交这个因子，或者在终端执行 engine/qlib_research/run.sh。' }]] },
    badFails: ['handed-off', 'no-cant', 'no-user-chores'],
  },
};
