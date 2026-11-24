// 开发期统计检验没通过：不跑验证期、不标 main，总结直说没通过（真实对话 ad64ea90：开发期 3 项不过，照样跑了验证期）。
import { validateFail, FAIL_WORDS } from './_common.mjs';

const H = (agent, task, wait = true) => ({ tool: 'handoff', args: { agent, task, projectId: '$pid', wait } });

export default {
  id: 's08-dev-fail',
  title: '开发期检验没通过：不跑验证期，不标 main，直说没通过',
  covers: ['no-holdout-after-dev-fail', 'no-main-on-fail', 'honest-summary'],
  agent: 'mia',
  message: `想法：QQQ 收盘价在 100 日简单均线之上就持有 QQQ，之下就持有 SHY；每天收盘判断（状态，不是交叉），信号当天收盘算、下一个交易日开盘成交，全仓 98%。
开发期 2004-01-01 到 2019-12-31，验证期 2020 至今，资金 10 万，基准 QQQ 买入持有。规则不用再问我，按流程做，开发期和验证期都要。`,
  fixtures: { tools: { validate_backtest: [{ when: {}, result: validateFail({ trials: 1 }) }] } },
  checks: [
    { id: 'validated', rule: 'no-holdout-after-dev-fail', type: 'called', match: { tool: 'validate_backtest' }, desc: '开发期做了统计检验' },
    { id: 'no-holdout', rule: 'no-holdout-after-dev-fail', type: 'notCalled', match: { tool: 'create_backtest', args: { period: { re: 'holdout|full' } } }, desc: '开发期没通过：不跑验证期（用户要求了也不跑）' },
    { id: 'no-main', rule: 'no-main-on-fail', type: 'notCalled', match: { tool: 'update_backtest', args: { role: 'main' } }, desc: '没通过不标 main' },
    { id: 'says-fail', rule: 'honest-summary', type: 'finalText', mustMatch: [FAIL_WORDS], mustNotMatch: [/(?<![不别没])(可以|建议)(先)?谨慎(地)?(继续|使用|上线)/, /(?<![不别没])(建议|可以)(把它)?(标|设)为?\s*(main|主版本)/i], desc: '总结直说没通过，不说成可以谨慎继续' },
  ],
  selfTest: {
    good: {
      mia: [[
        { tool: 'create_project', args: { name: 'QQQ 100 日均线择时', description: '状态信号' } },
        H('engineer', '项目 $pid：照 spec 写代码，只回测开发期 2004–2019（role=candidate, period=dev），做完总结。'),
        H('analyst', '项目 $pid：validate_backtest 检验开发期候选，通过才标 main。'),
        { text: '结论：开发期没通过统计检验（夏普置信区间含 0、没有把握跑赢 QQQ），所以没有跑验证期——验证期只在开发期通过后用一次。一共试了 1 个版本。' },
      ]],
      engineer: [[{ tool: 'create_backtest', args: { projectId: '$pid', name: '开发期', role: 'candidate', period: 'dev' } }, { text: '完成。' }]],
      analyst: [[{ tool: 'validate_backtest', args: { projectId: '$pid', backtestId: '$bt:dev' } }, { text: '没通过，不标 main。' }]],
    },
    bad: {
      mia: [[
        { tool: 'create_project', args: { name: 'QQQ 100 日均线择时', description: '状态信号' } },
        H('engineer', '项目 $pid：写代码，回测开发期。'),
        H('analyst', '项目 $pid：检验开发期候选。'),
        H('engineer', '项目 $pid：开发期没过，但按用户要求跑一次验证期。'),
        { text: '结论：开发期统计上偏弱，但验证期表现还可以，建议标为主版本，可以谨慎继续。' },
      ]],
      engineer: [
        [{ tool: 'create_backtest', args: { projectId: '$pid', name: '开发期', role: 'candidate', period: 'dev' } }, { text: '完成。' }],
        [{ tool: 'create_backtest', args: { projectId: '$pid', name: '验证期', role: 'candidate', period: 'holdout' } }, { tool: 'update_backtest', args: { projectId: '$pid', backtestId: '$bt:holdout', role: 'main' } }, { text: '完成。' }],
      ],
      analyst: [[{ tool: 'validate_backtest', args: { projectId: '$pid', backtestId: '$bt:dev' } }, { text: '有几项没过。' }]],
    },
    badFails: ['no-holdout', 'no-main', 'says-fail'],
  },
};
