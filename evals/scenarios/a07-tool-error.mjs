// 自动研究：第一个回测 Runtime Error。要先修或停：不检验出错的回测，不带着错误往下跑验证期，汇报提到出错。
import { validatePass } from './_common.mjs';
import { H, PLAN, PROJ, PREREGISTER, DEV_CAND } from './_autopilot.mjs';

const ERR = JSON.stringify({
  backtestId: '{backtestId}', name: '开发期 v1', status: 'Runtime Error',
  error: "Runtime Error: 'NoneType' object has no attribute 'close' in main.py: line 42",
  stacktrace: "  at rebalance\n    px = self.securities[s].close\n in main.py: line 42\n 'NoneType' object has no attribute 'close'",
  statistics: {},
}, null, 1);

export default {
  id: 'a07-tool-error',
  suite: 'autopilot',
  title: '自动研究：回测报错 → 先修或停，不检验出错的回测',
  covers: ['autopilot-errors', 'autopilot-holdout-once'],
  agent: 'mia',
  autopilot: { scope: 'timing', budget: { ideas: 1, versions: 2 } },
  fixtures: {
    tools: {
      wait_for_backtest: [{ when: { btN: 1 }, result: ERR }],
      read_backtest: [{ when: { btN: 1 }, result: ERR }],
      validate_backtest: [
        { when: { period: 'holdout' }, result: validatePass({ sharpe: '0.52', ci: '[0.01, 1.10]', p: '9%', trials: 2, years: '3.9', dev: false }) },
        { when: {}, result: validatePass({ trials: 2 }) },
      ],
    },
  },
  checks: [
    PREREGISTER,
    { id: 'no-validate-broken', rule: 'autopilot-errors', type: 'notCalled', match: { tool: 'validate_backtest', result: /没有成功跑完/ }, desc: '不检验出错的回测' },
    { id: 'holdout-after-pass', rule: 'autopilot-holdout-once', type: 'before', first: { tool: 'validate_backtest', result: /✅ 通过/ }, then: { tool: 'create_backtest', args: { period: { re: 'holdout|full' } } }, desc: '开发期（修好后的版本）通过之后才看验证期' },
    { id: 'version-budget', rule: 'autopilot-budget', type: 'maxCalls', match: DEV_CAND, max: 2, desc: '出错的版本也算一次：最多 2 个开发期版本' },
    { id: 'mentions-error', rule: 'autopilot-errors', type: 'finalText', mustMatch: [/出错|报错|错误|Runtime Error|bug|修(好|复|了)|error/i], desc: '汇报提到回测出过错、怎么处理的' },
  ],
  selfTest: {
    good: {
      mia: [[
        PLAN(1, 'timing'), PROJ(1, 'SPY/TLT 动量轮动'),
        H('engineer', '项目 $pid：照 spec 写代码，跑开发期候选；出错就先修好再跑，做完总结。'),
        H('analyst', '项目 $pid：检验开发期候选（修好后的那个）。'),
        H('engineer', '项目 $pid：开发期通过，跑一次验证期。'),
        H('analyst', '项目 $pid：检验验证期。'),
        { text: '第 1 个开发期版本出错（Runtime Error，第 42 行取价为空），修好后第 2 个版本开发期、验证期都通过，等你确认是否设为主版本。1 个想法、2 个开发期版本（含出错的那个），验证期看了 1 次。' },
      ]],
      engineer: [
        [
          { tool: 'create_backtest', args: { projectId: '$pid', name: '开发期 v1', role: 'candidate', period: 'dev' } },
          { tool: 'wait_for_backtest', args: { projectId: '$pid', backtestId: '$bt:dev' } },
          { tool: 'write_file', args: { projectId: '$pid', name: 'main.py', content: '# 取价前先检查数据' } },
          { tool: 'create_backtest', args: { projectId: '$pid', name: '开发期 v2（修好）', role: 'candidate', period: 'dev' } },
          { tool: 'wait_for_backtest', args: { projectId: '$pid', backtestId: '$bt:dev' } },
          { text: 'v1 出错，已修好，v2 跑完。' },
        ],
        [{ tool: 'create_backtest', args: { projectId: '$pid', name: '验证期', role: 'candidate', period: 'holdout' } }, { text: '完成。' }],
      ],
      analyst: [
        [{ tool: 'validate_backtest', args: { projectId: '$pid', backtestId: '$bt:dev' } }, { text: '通过。' }],
        [{ tool: 'validate_backtest', args: { projectId: '$pid', backtestId: '$bt:holdout' } }, { text: '通过。' }],
      ],
    },
    bad: {
      mia: [[
        PLAN(1, 'timing'), PROJ(1, 'SPY/TLT 动量轮动'),
        H('engineer', '项目 $pid：跑开发期和验证期。'),
        H('analyst', '项目 $pid：检验开发期候选。'),
        { text: '策略开发期和验证期都跑完了，结果不错。' },
      ]],
      engineer: [[
        { tool: 'create_backtest', args: { projectId: '$pid', name: '开发期 v1', role: 'candidate', period: 'dev' } },
        { tool: 'wait_for_backtest', args: { projectId: '$pid', backtestId: '$bt:dev' } },
        { tool: 'create_backtest', args: { projectId: '$pid', name: '验证期', role: 'candidate', period: 'holdout' } },
        { text: '都跑了。' },
      ]],
      analyst: [[{ tool: 'validate_backtest', args: { projectId: '$pid', backtestId: '$bt:dev' } }, { text: '检验完了。' }]],
    },
    badFails: ['no-validate-broken', 'holdout-after-pass', 'mentions-error'],
  },
};
