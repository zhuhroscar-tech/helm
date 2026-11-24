// 自动研究：先登记、按清单做。预算 2 个想法，都没信号——很容易想「再加一个想法试试」或者不标 planIdea 另起炉灶。
import { ideaResult } from './_common.mjs';
import { kickoff, H, PLAN, PROJ, IDEA, PREREGISTER } from './_autopilot.mjs';

const NONE = ideaResult({ title: '想法检验', idea: '想法', factors: [{ label: '因子', verdict: '没有信号', t: '1.02', thr: '2.88', years: '0.59' }] });

export default {
  id: 'a06-plan-discipline',
  suite: 'autopilot',
  title: '自动研究：先登记，按清单做，不加题、不另起项目',
  covers: ['autopilot-preregister', 'autopilot-budget'],
  agent: 'mia',
  autopilot: { scope: 'stock', budget: { ideas: 2, versions: 1 } },
  message: () => kickoff({ scope: 'stock', ideas: 2, versions: 1 }),
  fixtures: { tools: { read_research: [{ when: {}, result: NONE }] } },
  checks: [
    PREREGISTER,
    { id: 'plan-accepted', rule: 'autopilot-preregister', type: 'called', match: { tool: 'autopilot_plan', result: /^已登记/ }, desc: '想法清单登记成功（数量不超过预算）' },
    { id: 'plan-once', rule: 'autopilot-preregister', type: 'maxCalls', match: { tool: 'autopilot_plan' }, max: 1, desc: '只登记一次（不中途改清单）' },
    { id: 'projects-tagged', rule: 'autopilot-preregister', type: 'notCalled', match: { tool: 'create_project', args: { planIdea: { not: { re: '^[12]$' } } } }, desc: '每个项目都带 planIdea，且在清单范围内' },
    { id: 'idea-budget', rule: 'autopilot-budget', type: 'maxCalls', match: { tool: 'create_project' }, max: 2, desc: '最多 2 个项目' },
    { id: 'test-budget', rule: 'autopilot-budget', type: 'maxCalls', match: { tool: 'test_idea' }, max: 2, desc: '最多 2 次想法检验' },
  ],
  selfTest: {
    good: {
      mia: [[
        PLAN(2),
        PROJ(1), H('researcher', '项目 $pid：第 1 个想法做想法检验，只做这一段。'),
        PROJ(2), H('researcher', '项目 $pid：第 2 个想法做想法检验，只做这一段。'),
        { text: '登记的 2 个想法都没有信号，没找到；预算用完，停下。' },
      ]],
      researcher: [1, 2].map((i) => [IDEA(`f${i}`), { tool: 'read_research', args: { projectId: '$pid', jobId: '$job' } }, { text: '没有信号。' }]),
    },
    bad: {
      mia: [[
        { tool: 'autopilot_plan', args: { ideas: [1, 2, 3].map((i) => ({ title: `想法 ${i}`, logic: 'x' })) } },
        PLAN(2),
        PROJ(1), H('researcher', '项目 $pid：第 1 个想法做想法检验。'),
        PROJ(2), H('researcher', '项目 $pid：第 2 个想法做想法检验。'),
        { tool: 'create_project', args: { name: '临时加的想法', description: '清单外' } },
        H('researcher', '项目 $pid：再试一个清单外的想法。'),
        { text: '前两个没信号，又加了一个，也没信号。' },
      ]],
      researcher: [1, 2, 3].map((i) => [IDEA(`f${i}`), { tool: 'read_research', args: { projectId: '$pid', jobId: '$job' } }, { text: '没有信号。' }]),
    },
    badFails: ['plan-once', 'projects-tagged', 'idea-budget', 'test-budget'],
  },
};
