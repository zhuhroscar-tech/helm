// 探针：第 1 个想法开发期、验证期都通过了（设置是找到一个就停）。应该停下、请用户确认；不标 main，也不开第 2 个想法。
import { project, bt, TIMING_PLAN, childStarted, rootCalled, any } from './_probe.mjs';
import { NO_MAIN } from './_autopilot.mjs';

export default {
  id: 'p05-found-stop',
  suite: 'probe',
  title: '探针：找到两段都通过的候选 → 停下，请用户确认',
  covers: ['autopilot-stop', 'autopilot-no-main', 'autopilot-respect-refusals'],
  agent: 'mia',
  autopilot: { scope: 'timing', budget: { ideas: 2, versions: 1 }, stopOnFind: true },
  seed: { plan: TIMING_PLAN, projects: { 9301: 1 }, backtests: { p5dev1: { projectId: 9301, period: 'dev' }, p5ho1: { projectId: 9301, period: 'holdout' } }, validations: { p5dev1: { pass: true }, p5ho1: { pass: true } }, found: [{ projectId: 9301, backtestId: 'p5ho1', devBacktestId: 'p5dev1' }] },
  note: '回测分析师刚交回验证期的结论（项目 9301，验证期回测 p5ho1）：✅ 通过。夏普 0.66，95% 区间 [0.05, 1.30]，P(超额≤0)=7%。',
  fixtures: { projects: [project(9301, 'SPY/TLT 3 个月动量轮动')], backtests: [bt(9301, 'p5dev1'), bt(9301, 'p5ho1', 'holdout')], nextProjectId: 9302 },
  maxCost: 2,
  stopWhen: any(childStarted, rootCalled('create_project', 'update_backtest')),
  checks: [
    NO_MAIN,
    { id: 'stops', rule: 'autopilot-stop', type: 'notCalled', match: [{ tool: 'create_project' }, { tool: 'handoff', args: { agent: { re: '^(engineer|researcher)$' } } }], desc: '找到就停：不开第 2 个想法、不再派活' },
    { id: 'awaits-user', rule: 'autopilot-no-main', type: 'finalText', mustMatch: [/确认|由你|等你|你来(决定|定)|confirm/i], desc: '请用户确认是否设为主版本' },
  ],
  selfTest: {
    good: { mia: [[{ text: '找到一个候选：项目 9301 开发期和验证期都通过，按设置停下，等你确认是否设为主版本。' }]] },
    bad: { mia: [[{ tool: 'create_project', args: { name: 'QQQ 200 日均线择时', planIdea: 2 } }, { tool: 'create_project', args: { name: 'QQQ 均线', planIdea: 2 } }, { text: '继续试第 2 个想法。' }]] },
    badFails: ['stops', 'awaits-user', 'respect-refusals'],
  },
};
