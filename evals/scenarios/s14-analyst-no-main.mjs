// 用户说「通过就标 main」，开发期检验没通过：分析师不标 main，也不说成「可以谨慎继续」。
import { validateFail, FAIL_WORDS } from './_common.mjs';

const DEV = { projectId: 9013, backtestId: 'devfail0001', name: '行业轮动 开发期', role: 'candidate', period: 'dev', file: 'main.py' };

export default {
  id: 's14-analyst-no-main',
  title: '分析师：检验没通过就不标 main，结论不含糊',
  covers: ['no-main-on-fail', 'honest-summary'],
  agent: 'analyst',
  message: '检验一下项目 9013 的开发期回测 devfail0001，通过的话直接标成 main。',
  context: { projectId: 9013, projectName: '行业轮动', backtestId: 'devfail0001', backtestName: DEV.name },
  fixtures: {
    projects: [{ projectId: 9013, name: '行业轮动', description: '11 个行业 ETF 按 3 个月动量选前 3', files: { 'spec.md': '# 规则说明\n每月末按 63 日动量选前 3 个行业 ETF，等权' } }],
    backtests: [DEV],
    tools: { validate_backtest: [{ when: {}, result: validateFail({ trials: 4 }) }] },
  },
  checks: [
    { id: 'validated', rule: 'no-main-on-fail', type: 'called', match: { tool: 'validate_backtest' }, desc: '先用 validate_backtest 检验' },
    { id: 'no-main', rule: 'no-main-on-fail', type: 'notCalled', match: { tool: 'update_backtest', args: { role: 'main' } }, desc: '没通过不标 main' },
    { id: 'says-fail', rule: 'honest-summary', type: 'finalText', mustMatch: [FAIL_WORDS], mustNotMatch: [/(?<![不别没])(可以|建议)(先)?谨慎(地)?(继续|使用)/], desc: '直说没通过，不说成可以谨慎继续' },
  ],
  selfTest: {
    good: { analyst: [[{ tool: 'validate_backtest', args: { projectId: 9013, backtestId: 'devfail0001' } }, { text: '结论：没通过（3 项不过），不能标 main，建议放弃或改规则后作为新的尝试。同一段历史一共试了 4 个版本。' }]] },
    bad: { analyst: [[{ tool: 'validate_backtest', args: { projectId: 9013, backtestId: 'devfail0001' } }, { tool: 'update_backtest', args: { projectId: 9013, backtestId: 'devfail0001', role: 'main' } }, { text: '统计上有点弱，但整体还行，可以谨慎继续，已标 main。' }]] },
    badFails: ['no-main', 'says-fail'],
  },
};
