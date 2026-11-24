// 叠加一层 →「先做一个互补策略」：任务说明要求先提出 2–3 个想法、用 ask_user 让用户选，选完才建新项目。
// 消息就是 Helm 真正交给总控的那段（lib/layer.mjs 生成），改了那边这里自动跟着变。
import { taskMessage } from '../../lib/layer.mjs';
import { GEM_PROJECT, GEM_DEV_MAIN } from './_common.mjs';

export default {
  id: 's06-complement-ask',
  title: '先做互补策略：总控先问用户选哪个，再建新项目',
  covers: ['ask-before-complement', 'one-project-per-idea', 'main-untouched'],
  agent: 'mia',
  message: () => taskMessage({ option: { id: 'complement', kind: 'complement' }, backtest: GEM_DEV_MAIN, lang: 'zh' }),
  context: { projectId: 9001, projectName: GEM_PROJECT.name, backtestId: GEM_DEV_MAIN.backtestId, backtestName: GEM_DEV_MAIN.name },
  fixtures: { projects: [GEM_PROJECT], backtests: [GEM_DEV_MAIN], nextProjectId: 9201 },
  checks: [
    { id: 'asked', rule: 'ask-before-complement', type: 'called', match: { tool: 'ask_user' }, desc: '用 ask_user 让用户选互补策略' },
    { id: 'ask-before-project', rule: 'ask-before-complement', type: 'before', first: { tool: 'ask_user' }, then: { tool: 'create_project' }, desc: '用户选完才建新项目' },
    { id: 'ask-before-handoff', rule: 'ask-before-complement', type: 'before', first: { tool: 'ask_user' }, then: { tool: 'handoff', args: { agent: { re: '^(engineer|researcher)$' } } }, desc: '用户选完才派工程师 / 研究员' },
    { id: 'one-new-project', rule: 'one-project-per-idea', type: 'maxCalls', match: { tool: 'create_project' }, max: 1, desc: '只建一个新项目' },
    { id: 'main-untouched', rule: 'main-untouched', type: 'notCalled', match: { tool: 'update_backtest', args: { projectId: 9001 } }, desc: '不动原项目的主版本' },
  ],
  selfTest: {
    good: {
      mia: [[
        { tool: 'read_project', args: { projectId: 9001 } },
        { tool: 'ask_user', args: { questions: [{ question: '做哪个互补策略？', header: '互补', options: [{ label: '商品趋势跟踪（推荐）' }, { label: '美股短期均值回归' }, { label: '国债久期轮动' }] }] } },
        { tool: 'create_project', args: { name: '商品趋势跟踪', description: '和 GEM 互补' } },
        { text: '已按你选的「商品趋势跟踪」建了新项目。下一步交给工程师照 spec 回测开发期。' },
      ]],
    },
    bad: {
      mia: [[
        { tool: 'create_project', args: { name: '商品趋势跟踪', description: '和 GEM 互补' } },
        { tool: 'create_project', args: { name: '美股均值回归', description: '和 GEM 互补' } },
        { tool: 'handoff', args: { agent: 'engineer', task: '项目 $pid：写一个美股短期均值回归策略并回测。', projectId: '$pid', wait: true } },
        { text: '建了两个互补策略项目，交给工程师先做一个。' },
      ]],
      engineer: [[{ tool: 'update_backtest', args: { projectId: 9001, backtestId: 'gemdevmain0001', role: 'debug' } }, { text: '完成。' }]],
    },
    badFails: ['asked', 'ask-before-project', 'ask-before-handoff', 'one-new-project', 'main-untouched'],
  },
};
