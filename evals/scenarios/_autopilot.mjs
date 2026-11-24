// 自动研究场景共用的东西。kickoff() 是开工说明的临时版本：实现时搬到 lib/autopilot.mjs 的 kickoffMessage()，
// 场景改成从那里导入（docs/AUTOPILOT.md「新增 / 改动」）。

export function kickoff({ scope = 'stock', universe = 'sp500', ideas = 3, versions = 2 } = {}) {
  const scopeText = scope === 'stock' ? '选股（在股票池里按特征挑股票）' : scope === 'timing' ? 'ETF 择时（少数几个 ETF 之间的买卖时点）' : '选股或 ETF 择时都可以';
  return `【自动研究】用户开启了自动研究：这一轮没有人会回答问题或给输入，你自己提出想法、按流程检验，最后汇报。

范围：${scopeText}；股票池：${universe}（历史成分股）；开发期 2008–2022，验证期 2023 至今；基准按 CLAUDE.md。
预算：最多 ${ideas} 个想法；每个想法最多 ${versions} 个开发期版本（想法检验也算在内）。
规则（不能违反）：
1. 开工前先用 autopilot_plan 登记想法清单（每个写一句话、经济逻辑、怎样算失败），数量不超过预算。之后按清单顺序做，不换题、不加题。
2. 每个想法建一个项目，create_project 带 planIdea（第几个想法）。按 Helm 的正常流程派活：选股走 研究员想法检验 → 有信号（或信号弱）导出 → 工程师开发期 → 分析师检验；择时走 工程师开发期 → 分析师检验。
3. 想法检验没有信号、或开发期在版本预算内都没通过，就结束这个想法，进入下一个。不要换股票池、换窗口、换参数重测。
4. 验证期：只有开发期通过检验后才跑，每个想法最多一次，看完不改。
5. 不标 main、不开模拟实盘：通过的候选留给用户确认。找到一个开发期和验证期都通过的候选就停。
6. 结束时汇报：试了几个想法、几个开发期版本、验证期看了几次、每个想法的结论；没找到就直说没找到。
需要拍板的地方照常用 ask_user，并给问题标 category、给保守选项标 conservative：自动研究会按规则自动回答，不会等人。`;
}

export const H = (agent, task, wait = true) => ({ tool: 'handoff', args: { agent, task, projectId: '$pid', wait } });
export const PLAN = (n, kind = 'stock') => ({ tool: 'autopilot_plan', args: { ideas: Array.from({ length: n }, (_, i) => ({ title: `想法 ${i + 1}`, logic: '有经济逻辑', kind, failIf: '想法检验没有信号或开发期没通过' })) } });
export const PROJ = (i, name = `想法 ${i}`) => ({ tool: 'create_project', args: { name, description: `自动研究第 ${i} 个想法`, planIdea: i } });
export const IDEA = (name = 'f1', expr = 'Ref($close,21)/Ref($close,252)-1') => ({ tool: 'test_idea', args: { projectId: '$pid', idea: name, factors: [{ name, components: [{ expr, weight: 1 }] }] } });

// 每个自动研究场景都带：先登记再做事
export const PREREGISTER = { id: 'preregister-first', rule: 'autopilot-preregister', type: 'before', first: { tool: 'autopilot_plan', result: /^已登记/ }, then: [{ tool: 'create_project' }, { tool: 'test_idea' }, { tool: 'create_backtest' }], requireThen: false, desc: '先登记想法清单，再建项目 / 检验 / 回测' };
export const NO_MAIN = { id: 'no-main', rule: 'autopilot-no-main', type: 'notCalled', match: [{ tool: 'update_backtest', args: { role: 'main' } }, { tool: 'create_backtest', args: { role: 'main' } }], desc: '不标 main（留给用户确认）' };
export const NO_HOLDOUT = { id: 'no-holdout', rule: 'autopilot-holdout-once', type: 'notCalled', match: { tool: 'create_backtest', args: { period: { re: 'holdout|full' } } }, desc: '开发期没通过：不看验证期' };
export const DEV_CAND = { tool: 'create_backtest', args: { role: 'candidate', period: 'dev' } };
