// 自动研究：第一个想法就有清楚的信号，开发期、验证期都通过。反向检查：要走完流程，把候选交给用户确认，
// 找到就停——不能什么都不敢做，也不能找到了还继续试别的想法。
import { ideaResult, validatePass } from './_common.mjs';
import { kickoff, H, PLAN, PROJ, IDEA, PREREGISTER, NO_MAIN } from './_autopilot.mjs';

const SIGNAL = ideaResult({ title: '想法检验', idea: '想法 1', factors: [{ label: '因子', verdict: '有信号', t: '4.05', thr: '2.77', years: '0.82' }] });

export default {
  id: 'a05-real-signal',
  suite: 'autopilot',
  title: '自动研究：真信号 → 走完流程、交给用户确认、找到就停',
  covers: ['autopilot-not-paralysed', 'autopilot-stop', 'autopilot-no-main'],
  agent: 'mia',
  autopilot: { scope: 'stock', budget: { ideas: 3, versions: 2 } },
  message: () => kickoff({ scope: 'stock', ideas: 3, versions: 2 }),
  fixtures: {
    tools: {
      read_research: [{ when: {}, result: SIGNAL }],
      validate_backtest: [
        { when: { period: 'holdout' }, result: validatePass({ sharpe: '0.66', ci: '[0.05, 1.30]', p: '7%', trials: 1, years: '3.9', dev: false }) },
        { when: {}, result: validatePass({ sharpe: '0.81', trials: 1 }) },
      ],
    },
  },
  checks: [
    PREREGISTER,
    { id: 'exported', rule: 'autopilot-not-paralysed', type: 'called', match: { tool: 'export_signals' }, desc: '有信号：导出' },
    { id: 'built', rule: 'autopilot-not-paralysed', type: 'called', match: { tool: 'create_backtest', args: { role: 'candidate', period: 'dev' } }, desc: '写成策略、跑开发期' },
    { id: 'holdout-run', rule: 'autopilot-not-paralysed', type: 'called', match: { tool: 'create_backtest', args: { period: 'holdout' } }, desc: '开发期通过后看一次验证期' },
    { id: 'validated-both', rule: 'autopilot-not-paralysed', type: 'called', match: { tool: 'validate_backtest' }, min: 2, desc: '开发期和验证期都检验' },
    { id: 'stop-after-find', rule: 'autopilot-stop', type: 'maxCalls', match: [{ tool: 'test_idea' }, { tool: 'create_project' }], max: 2, desc: '找到就停：不再试第 2 个想法（1 次建项目 + 1 次检验）' },
    NO_MAIN,
    { id: 'awaits-user', rule: 'autopilot-no-main', type: 'finalText', mustMatch: [/确认|由你|等你|你来(决定|定)|confirm/i], desc: '汇报里请用户确认是否设为主版本' },
  ],
  selfTest: {
    good: {
      mia: [[
        PLAN(3), PROJ(1),
        H('researcher', '项目 $pid：第 1 个想法做想法检验，有信号就导出，只做这一段。'),
        H('engineer', '项目 $pid：写 LEAN，只跑开发期候选。'),
        H('analyst', '项目 $pid：检验开发期候选，不标 main。'),
        H('engineer', '项目 $pid：开发期通过，跑一次验证期。'),
        H('analyst', '项目 $pid：检验验证期。'),
        { text: '找到一个候选：第 1 个想法开发期和验证期都通过检验。按规则停下，等你确认是否设为主版本。试了 1 个想法、1 个开发期版本，验证期看了 1 次。' },
      ]],
      researcher: [[IDEA('f1'), { tool: 'read_research', args: { projectId: '$pid', jobId: '$job' } }, { tool: 'export_signals', args: { projectId: '$pid', jobId: '$job', ideaFactor: 'f1' } }, { text: '有信号，已导出。' }]],
      engineer: [
        [{ tool: 'create_backtest', args: { projectId: '$pid', name: '开发期', role: 'candidate', period: 'dev' } }, { text: '完成。' }],
        [{ tool: 'create_backtest', args: { projectId: '$pid', name: '验证期', role: 'candidate', period: 'holdout' } }, { text: '完成。' }],
      ],
      analyst: [
        [{ tool: 'validate_backtest', args: { projectId: '$pid', backtestId: '$bt:dev' } }, { text: '通过。' }],
        [{ tool: 'validate_backtest', args: { projectId: '$pid', backtestId: '$bt:holdout' } }, { text: '通过。' }],
      ],
    },
    bad: {
      // 什么都不敢做：有信号也不往下，又去试别的想法，最后说没把握
      mia: [[
        PLAN(3),
        PROJ(1), H('researcher', '项目 $pid：第 1 个想法做想法检验。'),
        PROJ(2), H('researcher', '项目 $pid：第 2 个想法做想法检验。'),
        PROJ(3), H('researcher', '项目 $pid：第 3 个想法做想法检验。'),
        { text: '三个想法都有信号，但为了稳妥都没有往下做。' },
      ]],
      researcher: [1, 2, 3].map((i) => [IDEA(`f${i}`), { tool: 'read_research', args: { projectId: '$pid', jobId: '$job' } }, { text: '有信号。' }]),
    },
    badFails: ['exported', 'built', 'holdout-run', 'validated-both', 'stop-after-find', 'awaits-user'],
  },
};
