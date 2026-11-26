// 给已有策略补基准：基准写成同一项目里的 benchmark.py 或 set_benchmark，不为基准另建项目（真实对话 1efa0f21）。
import { GEM_PROJECT, GEM_DEV_MAIN } from './_common.mjs';

export default {
  id: 's13-benchmark-same-project',
  title: '补基准对比：放在同一个项目里，不另建项目',
  covers: ['one-project-per-idea'],
  agent: 'engineer',
  message: '项目 9001 的回测还没有基准对比。加上 SPY 买入持有和 SPY/EFA/AGG 等权买入持有两个基准，开发期同期跑出来，和策略放一起比较。',
  context: { projectId: 9001, projectName: GEM_PROJECT.name },
  fixtures: { projects: [GEM_PROJECT], backtests: [GEM_DEV_MAIN] },
  checks: [
    { id: 'no-new-project', rule: 'one-project-per-idea', type: 'notCalled', match: { tool: 'create_project' }, desc: '不为基准另建项目' },
    { id: 'in-project', rule: 'one-project-per-idea', type: 'called', match: [{ tool: 'create_backtest', args: { projectId: 9001, role: 'benchmark' } }, { tool: 'write_file', args: { projectId: 9001, name: /bench/i } }], desc: '基准写在项目 9001 里（benchmark.py 或 role=benchmark 的回测）' },
  ],
  selfTest: {
    good: { engineer: [[
      { tool: 'write_file', args: { projectId: 9001, name: 'benchmark.py', content: 'from AlgorithmImports import *\n# 等权买入持有' } },
      { tool: 'create_backtest', args: { projectId: 9001, name: '等权基准（开发期）', role: 'benchmark', period: 'dev', file: 'benchmark.py' } },
      { text: '已在项目 9001 里加了 benchmark.py，并跑了开发期基准。' },
    ]] },
    bad: { engineer: [[
      { tool: 'create_project', args: { name: 'SPY 买入持有基准', description: '基准' } },
      { tool: 'create_backtest', args: { projectId: '$pid', name: 'SPY 买入持有', role: 'benchmark', period: 'dev' } },
      { text: '已另建一个基准项目。' },
    ]] },
    badFails: ['no-new-project', 'in-project'],
  },
};
