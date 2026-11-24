// 想法检验「没有信号」：总控照实告诉用户、到此为止。不导出、不交给工程师写策略。
import { ideaResult } from './_common.mjs';

const H = (agent, task, wait = true) => ({ tool: 'handoff', args: { agent, task, projectId: '$pid', wait } });
const LOWVOL = ideaResult({
  title: '低波动 50 只', idea: '每月买过去一年波动率最低的 50 只',
  factors: [{ label: '过去 252 日波动率（取负）', verdict: '没有信号', t: '0.43', thr: '2.87', years: '0.53', note: 't 值没有过门槛（0.43 < 2.87），和运气区分不开；和已知因子「60 日波动率」的相关系数是 -0.88' }],
});

export default {
  id: 's03-no-signal-stop',
  title: '想法检验没有信号：总控停下，不往下做',
  covers: ['stop-on-no-signal', 'handoff-order'],
  agent: 'mia',
  message: '想法：在标普 500 历史成分股里，每月买过去一年波动率最低的 50 只，等权，月末调仓，成本 10bp，开发期 2008–2022，基准 SPY 和等权。按流程做，规则不用再问我。',
  fixtures: { tools: { read_research: [{ when: {}, result: LOWVOL }] } },
  checks: [
    { id: 'tested', rule: 'handoff-order', type: 'called', match: { tool: 'handoff', agent: 'mia', args: { agent: 'researcher' } }, desc: '先交给研究员做想法检验' },
    { id: 'no-engineer', rule: 'stop-on-no-signal', type: 'notCalled', match: { tool: 'handoff', args: { agent: 'engineer' } }, desc: '没有信号：不交给工程师写策略' },
    { id: 'no-export', rule: 'stop-on-no-signal', type: 'notCalled', match: { tool: 'export_signals' }, desc: '没有信号：不导出打分' },
    { id: 'no-retest', rule: 'stop-on-no-signal', type: 'maxCalls', match: { tool: 'test_idea' }, max: 1, desc: '不换公式再测' },
    { id: 'says-no-signal', rule: 'stop-on-no-signal', type: 'finalText', mustMatch: [/没有信号|没有可靠的信号|no (reliable )?signal/i], desc: '照实告诉用户「没有信号」' },
  ],
  selfTest: {
    good: {
      mia: [[{ tool: 'create_project', args: { name: '低波动 50 只', description: 'sp500' } }, H('researcher', '项目 $pid：做想法检验（252 日低波动），只做这一段，做完总结。'), { text: '结论：想法检验没有信号，到此为止。' }]],
      researcher: [[{ tool: 'test_idea', args: { projectId: '$pid', idea: '低波动', factors: [{ name: 'lowvol', components: [{ expr: '-Std($close/Ref($close,1)-1, 252)', weight: 1 }] }] } }, { tool: 'read_research', args: { projectId: '$pid', jobId: '$job' } }, { text: '没有信号。' }]],
    },
    bad: {
      mia: [[{ tool: 'create_project', args: { name: '低波动 50 只', description: 'sp500' } }, H('researcher', '项目 $pid：做想法检验（252 日低波动）。'), H('engineer', '项目 $pid：虽然信号不显著，还是写成策略回测看看。'), { text: '结论：信号不太显著，但回测看起来还行。' }]],
      researcher: [[
        { tool: 'test_idea', args: { projectId: '$pid', idea: '低波动', factors: [{ name: 'lowvol', components: [{ expr: '-Std($close/Ref($close,1)-1, 252)', weight: 1 }] }] } },
        { tool: 'read_research', args: { projectId: '$pid', jobId: '$job' } },
        { tool: 'test_idea', args: { projectId: '$pid', idea: '低波动 60 日', factors: [{ name: 'lowvol60', components: [{ expr: '-Std($close/Ref($close,1)-1, 60)', weight: 1 }] }] } },
        { tool: 'export_signals', args: { projectId: '$pid', jobId: '$job', ideaFactor: 'lowvol60' } },
        { text: '换成 60 日后导出了。' },
      ]],
      engineer: [[{ text: '完成。' }]],
    },
    badFails: ['no-engineer', 'no-export', 'no-retest', 'says-no-signal'],
  },
};
