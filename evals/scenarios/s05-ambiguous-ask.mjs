// 想法里有会明显改变结果、原话定不下来的歧义（「转弱」「转强」怎么定义）：总控开工前用 ask_user 问，
// 不先建项目、不先派活，也不在回复末尾提问（真实对话 ad64ea90、542de60d、7f2f5979、29abbf6d）。
export default {
  id: 's05-ambiguous-ask',
  title: '有关键歧义的想法：总控开工前用 ask_user 问',
  covers: ['ask-before-start'],
  agent: 'mia',
  message: '想法：市场转弱的时候把 QQQ 换成债券，转强了再换回来。帮我做成策略。',
  checks: [
    { id: 'asked', rule: 'ask-before-start', type: 'called', match: { tool: 'ask_user', agent: 'mia' }, desc: '用 ask_user 问「转弱 / 转强」怎么定义' },
    { id: 'ask-before-project', rule: 'ask-before-start', type: 'before', first: { tool: 'ask_user' }, then: { tool: 'create_project' }, desc: '先问，再建项目' },
    { id: 'ask-before-handoff', rule: 'ask-before-start', type: 'before', first: { tool: 'ask_user' }, then: { tool: 'handoff' }, desc: '先问，再派活' },
  ],
  selfTest: {
    good: {
      mia: [[
        { tool: 'ask_user', args: { questions: [{ question: '「转弱」用什么判断？', header: '信号', options: [{ label: 'QQQ 跌破 200 日均线（推荐）' }, { label: '12 个月动量为负' }] }] } },
        { tool: 'create_project', args: { name: 'QQQ 均线择时', description: '跌破 200 日均线换债券' } },
        { tool: 'handoff', args: { agent: 'engineer', task: '项目 $pid：照 spec 写 LEAN 代码，只回测开发期，做完总结。', projectId: '$pid', wait: true } },
        { text: '已按你选的「跌破 200 日均线」建好项目并交给工程师。下一步交给分析师检验。' },
      ]],
      engineer: [[{ text: '完成。' }]],
    },
    bad: {
      mia: [[
        { tool: 'create_project', args: { name: 'QQQ 择时', description: '转弱换债券' } },
        { text: '「转弱」你想用 200 日均线还是 12 个月动量？' },
      ]],
    },
    badFails: ['asked', 'ask-before-project', 'no-trailing-question'],
  },
};
