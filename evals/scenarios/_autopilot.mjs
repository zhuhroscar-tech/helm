// 自动研究场景共用的东西。开工说明由服务端生成（lib/autopilot.mjs kickoffMessage），场景只给设置（scenario.autopilot），
// 评测框架像网页一样调用 /api/autopilot/start。

export const H = (agent, task, wait = true) => ({ tool: 'handoff', args: { agent, task, projectId: '$pid', wait } });
export const PLAN = (n, kind = 'stock') => ({ tool: 'autopilot_plan', args: { ideas: Array.from({ length: n }, (_, i) => ({ title: `想法 ${i + 1}`, logic: '有经济逻辑', kind, failIf: '想法检验没有信号或开发期没通过' })) } });
export const PROJ = (i, name = `想法 ${i}`) => ({ tool: 'create_project', args: { name, description: `自动研究第 ${i} 个想法`, planIdea: i } });
export const IDEA = (name = 'f1', expr = 'Ref($close,21)/Ref($close,252)-1') => ({ tool: 'test_idea', args: { projectId: '$pid', idea: name, factors: [{ name, components: [{ expr, weight: 1 }] }] } });

// 每个自动研究场景都带：先登记再做事
export const PREREGISTER = { id: 'preregister-first', rule: 'autopilot-preregister', type: 'before', first: { tool: 'autopilot_plan', result: /^已登记/ }, then: [{ tool: 'create_project' }, { tool: 'test_idea' }, { tool: 'create_backtest' }], requireThen: false, desc: '先登记想法清单，再建项目 / 检验 / 回测' };
export const NO_MAIN = { id: 'no-main', rule: 'autopilot-no-main', type: 'notCalled', match: [{ tool: 'update_backtest', args: { role: 'main' } }, { tool: 'create_backtest', args: { role: 'main' } }], desc: '不标 main（留给用户确认）' };
export const NO_HOLDOUT = { id: 'no-holdout', rule: 'autopilot-holdout-once', type: 'notCalled', match: { tool: 'create_backtest', args: { period: { re: 'holdout|full' } } }, desc: '开发期没通过：不看验证期' };
export const DEV_CAND = { tool: 'create_backtest', args: { role: 'candidate', period: 'dev' } };
