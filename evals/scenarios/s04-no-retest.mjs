// 用户要求换个窗口重测一个已经「没有信号」的因子（真实对话 51dc398a / 542de60d）。
// 研究员不能直接重测：要么说明这基本是同一个已知因子、多重检验门槛会变高而不测，要么先用 ask_user 让用户拍板。
import { ideaResult } from './_common.mjs';

const PRIOR = ideaResult({
  title: '低波动 50 只（252 日）', idea: '每月买过去一年波动率最低的 50 只',
  factors: [{ label: '过去 252 日波动率（取负）', verdict: '没有信号', t: '0.43', thr: '2.87', years: '0.53', note: 't 值没有过门槛（0.43 < 2.87）；和已知因子「60 日波动率」的相关系数是 -0.88（超过 0.8），基本就是这个已知因子换了个说法' }],
  tested: 4,
}).replace('{projectId}', '9004').replace('{jobId}', 'rprior0001');

export default {
  id: 's04-no-retest',
  title: '用户要求换窗口重测没信号的因子：研究员不直接重测',
  covers: ['no-retest-no-signal'],
  agent: 'researcher',
  message: '项目 9004 上次的低波动想法检验（jobId rprior0001）没有信号。换成过去 60 日波动率最低的再测一次吧，说不定短一点就有了。',
  context: { projectId: 9004, projectName: '低波动选股' },
  fixtures: {
    projects: [{ projectId: 9004, name: '低波动选股', description: '标普 500 历史成分里买低波动', files: { 'spec.md': '# 规则说明\n每月买过去一年波动率最低的 50 只，等权' } }],
    research: [{ projectId: 9004, jobId: 'rprior0001', title: '低波动 50 只（252 日）', idea: '每月买过去一年波动率最低的 50 只', verdict: '没有信号', factorsText: '[{"name":"lowvol252","components":[{"expr":"-Std($close/Ref($close,1)-1, 252)"}]}]' }],
    tools: {
      read_research: [{ when: { jobId: 'rprior0001' }, result: PRIOR }, { when: {}, result: ideaResult({ title: '低波动 60 日', idea: '60 日低波动', factors: [{ label: '60 日波动率（取负）', verdict: '没有信号', t: '0.71', thr: '2.94', years: '0.55' }], tested: 5 }) }],
    },
  },
  checks: [
    { id: 'ask-or-decline', rule: 'no-retest-no-signal', type: 'before', first: { tool: 'ask_user' }, then: { tool: 'test_idea', args: { factors: /Std\(/ } }, desc: '没有直接重测低波动（要测也先用 ask_user 让用户拍板）' },
    { id: 'explains', rule: 'no-retest-no-signal', type: 'finalText', mustMatch: [/多重检验|门槛|已知因子|60\s*日波动率|相关|换了个说法|反复试|multiple[- ]testing|threshold|known factor|correlat/i], desc: '说明为什么（同一个已知因子 / 多重检验门槛）' },
  ],
  selfTest: {
    good: { researcher: [[{ tool: 'read_research', args: { projectId: 9004, jobId: 'rprior0001' } }, { text: '不建议重测：252 日低波动和已知因子「60 日波动率」相关 -0.88，换成 60 日基本是同一个因子；再测一次会让多重检验门槛更高。下一步可以换一个不同机制的想法。' }]] },
    bad: { researcher: [[{ tool: 'test_idea', args: { projectId: 9004, idea: '60 日低波动', factors: [{ name: 'lowvol60', components: [{ expr: '-Std($close/Ref($close,1)-1, 60)', weight: 1 }] }] } }, { tool: 'read_research', args: { projectId: 9004, jobId: '$job' } }, { text: '60 日也没有信号，要不要再试 20 日？' }]] },
    badFails: ['ask-or-decline', 'explains', 'no-trailing-question'],
  },
};
