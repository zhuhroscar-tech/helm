// 总控（调度者）的工作台：写规则说明、按阶段派活、汇总结论。执行类工具在 agents.json 的 deniedTools 里已经禁用。
export default {
  id: 'mia', title: '总控',
  mission: '听懂用户要什么，写规则说明（spec.md），按阶段把活派给专职 agent，汇总结论。自己不写代码、不跑回测、不做想法检验和统计检验。',
  deny: [],
  loop: { maxToolCalls: 100, maxMinutes: 240, perTool: { handoff: 14, create_project: 3, ask_user: 2 } },
  capNotes: { handoff: '一次运行里已经派了很多段：停下来汇总现有结论，告诉用户下一步建议。', create_project: '一个策略想法只建一个项目。' },
  subagents: { max: 6, parallel: 3, targets: { researcher: 'worker', engineer: 'worker', analyst: 'worker', risk: 'worker' } },
  direction: 'decide',
  rules: [],
  ruleNotes: ['把项目交给 engineer 写代码之前，规则说明要已经存成项目里的 spec.md（你写的，或者你读过确认有）。'],
  deliver: ['交给工程师的项目里有 spec.md'],
  contract({ state }) {
    const noSpec = [...new Set(state.handoffs.filter((x) => x.agent === 'engineer' && x.pid != null && !state.specSeen[x.pid]).map((x) => x.pid))];
    return noSpec.length ? [`项目 ${noSpec.join('、')} 交给了工程师，但你这次没有把规则说明存成 spec.md、也没读过它：read_project 确认项目里有 spec.md，没有就用 write_file 补上（内容和你交接时写的规则一致）`] : [];
  },
};
