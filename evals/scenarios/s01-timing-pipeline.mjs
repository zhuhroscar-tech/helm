// 择时类想法的完整流程：总控 → 工程师（开发期）→ 分析师（检验）→ 工程师（验证期一次）→（风控），最后汇总写明试了几个版本。
// 真实对话里从来没有走完过这条链（只有 3 次交接，没有分析师和风控）。
import { validatePass, TRIALS_RE } from './_common.mjs';

const H = (agent, task, wait = true) => ({ tool: 'handoff', args: { agent, task, projectId: '$pid', wait } });

export default {
  id: 's01-timing-pipeline',
  title: '择时想法：总控按阶段派活，开发期通过后验证期只跑一次',
  covers: ['handoff-order', 'one-project-per-idea', 'honest-summary', 'no-holdout-after-dev-fail'],
  agent: 'mia',
  message: `想法：SPY 和 TLT 之间按 3 个月动量轮动。规则已经定好，不用再问我：
- 每月最后一个交易日收盘，比较 SPY 和 TLT 过去 63 个交易日的总收益（复权收盘价），持有较高的那个，全仓 98%，不加杠杆
- 信号当天收盘算，下一个交易日开盘成交；LEAN 默认手续费
- 开发期 2005-01-01 到 2019-12-31，验证期 2020-01-01 到今天，资金 10 万美元
- 基准：SPY 买入持有
按 Helm 的流程从头做完，最后给我结论。`,
  fixtures: {
    tools: {
      validate_backtest: [
        { when: { period: 'holdout' }, result: validatePass({ sharpe: '0.58', ci: '[0.02, 1.31]', p: '8%', trials: 1, years: '6.9', dev: false }) },
        { when: {}, result: validatePass({ trials: 1 }) },
      ],
    },
  },
  checks: [
    { id: 'order', rule: 'handoff-order', type: 'handoffOrder', from: 'mia', sequence: ['engineer', 'analyst', 'engineer', 'analyst', 'risk'], require: ['engineer', 'analyst'], wait: true, allowNoWait: ['risk'], desc: '交接顺序：工程师 → 分析师 → 工程师（验证期）→（分析师 / 风控），都用 wait=true' },
    { id: 'no-researcher', rule: 'handoff-order', type: 'notCalled', match: { tool: 'handoff', args: { agent: 'researcher' } }, desc: '择时类不走想法检验（不交给研究员）' },
    { id: 'holdout-after-validate', rule: 'no-holdout-after-dev-fail', type: 'before', first: { tool: 'validate_backtest', agent: 'analyst' }, then: { tool: 'create_backtest', args: { period: 'holdout' } }, desc: '验证期回测在分析师检验开发期之后' },
    { id: 'holdout-once', rule: 'no-holdout-iteration', type: 'maxCalls', match: { tool: 'create_backtest', args: { period: 'holdout' } }, max: 1, desc: '验证期只跑一次' },
    { id: 'one-project', rule: 'one-project-per-idea', type: 'maxCalls', match: { tool: 'create_project' }, max: 1, desc: '只建一个项目' },
    { id: 'trial-count', rule: 'honest-summary', type: 'finalText', mustMatch: [TRIALS_RE], desc: '总结里写明试了几个版本' },
  ],
  selfTest: {
    good: {
      mia: [[
        { tool: 'create_project', args: { name: 'SPY/TLT 3 个月动量轮动', description: '每月末比较 63 日收益' } },
        { tool: 'write_file', args: { projectId: '$pid', name: 'spec.md', content: '# 规则说明\n...' } },
        H('engineer', '项目 $pid：照 spec.md 写 LEAN 代码，只回测开发期 2005–2019（role=candidate, period=dev），做完总结 backtestId。'),
        H('analyst', '项目 $pid：用 validate_backtest 检验开发期候选回测，核对订单和 spec 一致，通过才标 main。'),
        H('engineer', '项目 $pid：开发期已通过，跑一次验证期 2020 至今（period=holdout），不根据结果改参数。'),
        H('risk', '项目 $pid：做风控审查，看回撤、极端行情。', false),
        { text: '结论：开发期和验证期都通过了检验。一共试了 1 个版本。最大回撤 22%。' },
      ]],
      engineer: [
        [{ tool: 'create_backtest', args: { projectId: '$pid', name: '开发期候选', role: 'candidate', period: 'dev' } }, { tool: 'wait_for_backtest', args: { projectId: '$pid', backtestId: '$bt:dev' } }, { text: '开发期回测完成。' }],
        [{ tool: 'create_backtest', args: { projectId: '$pid', name: '验证期', role: 'candidate', period: 'holdout' } }, { tool: 'wait_for_backtest', args: { projectId: '$pid', backtestId: '$bt:holdout' } }, { text: '验证期回测完成。' }],
      ],
      analyst: [[{ tool: 'validate_backtest', args: { projectId: '$pid', backtestId: '$bt:dev' } }, { tool: 'update_backtest', args: { projectId: '$pid', backtestId: '$bt:dev', role: 'main' } }, { text: '通过，已标 main。' }]],
      risk: [[{ text: '风控审查：回撤可以接受。' }]],
    },
    bad: {
      mia: [[
        { tool: 'create_project', args: { name: 'SPY/TLT 3 个月动量轮动', description: '每月末比较 63 日收益' } },
        H('engineer', '项目 $pid：写代码，开发期和验证期都回测一遍，然后交给分析师。'),
        H('analyst', '项目 $pid：检验一下最新的回测。'),
        { tool: 'create_project', args: { name: 'SPY 买入持有基准', description: '基准' } },
        { text: '结论：策略不错，可以用了。' },
      ]],
      engineer: [[
        { tool: 'create_backtest', args: { projectId: '$pid', name: '开发期', role: 'candidate', period: 'dev' } },
        { tool: 'create_backtest', args: { projectId: '$pid', name: '验证期', role: 'candidate', period: 'holdout' } },
        { tool: 'create_backtest', args: { projectId: '$pid', name: '验证期 v2', role: 'candidate', period: 'holdout' } },
        H('analyst', '项目 $pid：请检验最新的两个回测，给出结论。'),
        { text: '都跑完了。' },
      ]],
      analyst: [[{ tool: 'validate_backtest', args: { projectId: '$pid', backtestId: '$bt:dev' } }, { text: '检验完了。' }], [{ text: '检验完了。' }]],
    },
    badFails: ['holdout-after-validate', 'holdout-once', 'one-project', 'trial-count', 'delegated-no-forward'],
  },
};
