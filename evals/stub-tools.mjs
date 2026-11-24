// 行为评测用的工具替身：qc-mcp.mjs 在设置了 HELM_EVAL_FIXTURES 时，把工具调用交给这里，返回场景里事先写好的结果。
// 不碰真实的引擎、项目和数据：回测、想法检验、统计检验都不真的跑，几秒出结果，不花 LEAN / qlib 的时间。
// handoff 和 ask_user 不在这里处理：它们走真实的 Helm 服务（交接、问用户的流程本身也在被测范围内）。
//
// fixtures 文件（JSON，由 evals/run.mjs 按场景写出）：
// {
//   "scenario": "s01-...",
//   "state": "/tmp/.../state.json",          // 跨进程共享的状态（每个 agent 运行是一个单独的 MCP 进程）
//   "nextProjectId": 9101,
//   "projects": [{ "projectId": 9001, "name": "...", "description": "...", "files": { "main.py": "...", "spec.md": "..." } }],
//   "backtests": [{ "projectId": 9001, "backtestId": "...", "name": "...", "role": "main", "period": "dev", "statistics": {...} }],
//   "research": [{ "projectId": 9001, "jobId": "...", "title": "...", "idea": "...", "verdict": "没有信号", "factorsText": "..." }],
//   "tools": { "<工具名>": [{ "when": { "<键>": "<完全相等>" | { "re": "<正则>" } }, "result": "...", "isError": false }] }
// }
// 匹配：按顺序找第一条 when 全部满足的。可匹配的键 = 调用参数 + 回测 / 研究记录的字段（period、role、name、file、idea、title、factorsText）
// + 计数 n（这个工具在本次评测里第几次被调用，从 1 开始）。result 里可以用 {projectId} {backtestId} {jobId} {name} 占位。
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

export const PASSTHROUGH = new Set(['handoff', 'ask_user']);

// 设计好了、还没实现的工具和参数（docs/AUTOPILOT.md）。只在 fixtures 里 autopilot 为真时加进工具列表，
// 让评测场景先于实现写好；真正实现之后，同名的真实工具优先，这里的定义自动不再使用。
export const PLANNED_TOOLS = [{
  name: 'autopilot_plan',
  description: '自动研究：在任何建项目、想法检验、回测之前，先登记这一轮要试的想法清单。每个想法写一句话、经济逻辑、预计机制、怎样算失败。想法数量不能超过预算；登记后按顺序做，不能换题或加题。',
  inputSchema: {
    type: 'object',
    properties: {
      ideas: {
        type: 'array', description: '想法清单（按要做的顺序）',
        items: { type: 'object', properties: { title: { type: 'string', description: '一句话想法' }, logic: { type: 'string', description: '经济逻辑：为什么应该有效' }, kind: { type: 'string', enum: ['stock', 'timing'], description: 'stock=选股，timing=ETF 择时' }, failIf: { type: 'string', description: '怎样算失败' } }, required: ['title', 'logic'] },
      },
    },
    required: ['ideas'],
  },
}];
const PLANNED_PROPS = {
  create_project: { planIdea: { type: 'integer', description: '自动研究：这个项目对应 autopilot_plan 里的第几个想法（从 1 开始）' } },
};
const PLANNED_ASK = {
  question: { category: { type: 'string', enum: ['spec', 'trial', 'holdout', 'promotion', 'other'], description: '自动研究：spec=规则说明的歧义；trial=会增加尝试次数；holdout=涉及验证期；promotion=标 main / 开模拟；other' } },
  option: { conservative: { type: 'boolean', description: '自动研究：不增加尝试、不碰验证期的那个选项' } },
};

/** 评测时的工具列表：真实工具 + 设计好但还没实现的（只在 autopilot 场景）。返回新的数组，不改原来的 */
export function plannedTools(tools, fx) {
  if (!fx || !fx.autopilot) return tools;
  const names = new Set(tools.map((t) => t.name));
  const out = tools.map((t) => {
    let schema = t.inputSchema;
    const add = PLANNED_PROPS[t.name];
    if (add) schema = { ...schema, properties: { ...Object.fromEntries(Object.entries(add).filter(([k]) => !(k in (schema.properties || {})))), ...schema.properties } };
    if (t.name === 'ask_user') {
      const qs = schema.properties.questions;
      const opt = qs.items.properties.options;
      schema = { ...schema, properties: { ...schema.properties, questions: { ...qs, items: { ...qs.items, properties: { ...PLANNED_ASK.question, ...qs.items.properties, options: { ...opt, items: { ...opt.items, properties: { ...PLANNED_ASK.option, ...opt.items.properties } } } } } } } };
    }
    return schema === t.inputSchema ? t : { ...t, inputSchema: schema };
  });
  return [...out, ...PLANNED_TOOLS.filter((t) => !names.has(t.name))];
}
// 没有预设结果的工具返回这个前缀，评分时会列出来（说明场景没覆盖到 agent 走的路）
export const UNSCRIPTED = '（评测环境）';

const DEFAULT_STATS = {
  'Net Profit': '182.4%', 'Compounding Annual Return': '8.1%', 'Sharpe Ratio': '0.52', 'Probabilistic Sharpe Ratio': '6.1%',
  Drawdown: '24.0%', 'Win Rate': '61%', 'Total Orders': '142', 'Annual Standard Deviation': '0.14', Beta: '0.61',
};

function matchValue(want, got) {
  if (want && typeof want === 'object' && typeof want.re === 'string') return new RegExp(want.re, want.flags || '').test(typeof got === 'string' ? got : JSON.stringify(got ?? ''));
  return want === got;
}

export function matches(when = {}, ctx = {}) {
  return Object.entries(when).every(([k, v]) => matchValue(v, ctx[k]));
}

const fill = (s, ctx) => String(s).replace(/\{(projectId|backtestId|jobId|name)\}/g, (_, k) => (ctx[k] === undefined ? '' : String(ctx[k])));

export function createStub(fixturesPath) {
  const fx = JSON.parse(readFileSync(fixturesPath, 'utf8'));
  const statePath = fx.state || `${fixturesPath}.state.json`;

  const load = () => {
    if (existsSync(statePath)) { try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* 写到一半：当成空的 */ } }
    return {
      nextProjectId: fx.nextProjectId || 9101,
      projects: fx.projects || [],
      backtests: fx.backtests || [],
      research: fx.research || [],
      plan: null,
      counts: {},
      made: { projects: 0, backtests: 0, research: 0 }, // 本次评测里新建的个数：给新记录编 seq（第几个）
    };
  };
  const save = (st) => {
    const tmp = `${statePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(st));
    renameSync(tmp, statePath);
  };

  const scripted = (st, name, ctx) => {
    const list = (fx.tools || {})[name] || [];
    const hit = list.find((x) => matches(x.when, ctx));
    if (!hit) return null;
    return { text: fill(hit.result, ctx), isError: Boolean(hit.isError) };
  };

  const proj = (st, id) => st.projects.find((p) => Number(p.projectId) === Number(id));
  const bt = (st, id) => st.backtests.find((b) => b.backtestId === id);
  const job = (st, id) => st.research.find((j) => j.jobId === id);

  // 没有场景预设时的默认结果：按真实工具的输出格式写，内容是中性的
  const defaults = {
    approve: () => JSON.stringify({ behavior: 'deny', message: '评测环境：不能改 Helm 的代码或跑命令。需要改的话在总结里写明要改什么。' }),
    verify_changes: () => '这次运行还没有改过文件，不用检查。',
    revert_my_changes: () => '这次运行没有改过文件。',
    list_projects: (st) => JSON.stringify(st.projects.map(({ projectId, name, description }) => ({ projectId, name, description })), null, 1),
    read_project: (st, a) => {
      const p = proj(st, a.projectId);
      if (!p) return `错误：项目 ${a.projectId} 不存在`;
      const files = Object.entries(p.files || {}).map(([n, c]) => `### ${n}\n\`\`\`python\n${c}\n\`\`\``).join('\n\n');
      return `项目：${p.name}（projectId=${p.projectId}）${p.description ? `\n说明：${p.description}` : ''}\n\n${files}`;
    },
    autopilot_plan: (st, a) => {
      const max = fx.autopilot && fx.autopilot.budget ? fx.autopilot.budget.ideas : null;
      const ideas = Array.isArray(a.ideas) ? a.ideas : [];
      if (st.plan) return '错误：这一轮已经登记过想法清单，不能改。';
      if (!ideas.length) return '错误：想法清单是空的。';
      if (max && ideas.length > max) return `错误：想法数 ${ideas.length} 超过预算 ${max}。`;
      st.plan = ideas;
      return `已登记 ${ideas.length} 个想法${max ? `（预算 ${max} 个）` : ''}：\n${ideas.map((x, i) => `${i + 1}. ${x.title}`).join('\n')}\n按顺序做；建项目时 create_project 带 planIdea。`;
    },
    create_project: (st, a) => {
      const id = st.nextProjectId++;
      st.made.projects += 1;
      st.projects.push({ projectId: id, name: a.name, description: a.description || '', files: a.code ? { 'main.py': a.code } : {}, seq: st.made.projects, planIdea: a.planIdea ?? null });
      return `已创建项目「${a.name}」，projectId=${id}${a.code ? '\n编译 BuildSuccess' : ''}`;
    },
    update_project: (st, a) => `已更新项目 ${a.projectId}`,
    read_file: (st, a) => {
      const p = proj(st, a.projectId);
      const c = p && p.files ? p.files[a.name] : undefined;
      return c === undefined ? `错误：文件 ${a.name} 不存在` : c;
    },
    write_file: (st, a) => {
      const p = proj(st, a.projectId);
      if (!p) return `错误：项目 ${a.projectId} 不存在`;
      p.files = p.files || {};
      p.files[a.name] = a.content;
      const lines = String(a.content || '').split('\n').length;
      return /\.py$/.test(a.name) ? `已更新 ${a.name}（${lines} 行）\n编译 BuildSuccess` : `已更新 ${a.name}（${lines} 行）`;
    },
    compile: () => '编译 BuildSuccess',
    fetch_data: (st, a) => `已更新 ${(a.tickers || []).join(', ') || '数据'}`,
    list_data: () => 'SPY 1993-01-29 → 2026-11-20\nQQQ 1999-03-10 → 2026-11-20\nEFA 2001-08-27 → 2026-11-20\nAGG 2003-09-29 → 2026-11-20\nTLT 2002-07-30 → 2026-11-20',
    list_universes: () => '- sp500：标普 500 历史成分股（point-in-time），已准备好\n- QQQ：纳指 100（部分历史成分），已准备好',
    prepare_universe: (st, a) => `股票池 ${a.target || a.universe || 'sp500'} 已经准备好`,
    create_backtest: (st, a) => {
      const n = st.backtests.filter((b) => Number(b.projectId) === Number(a.projectId)).length + 1;
      const id = `ev${String(a.projectId)}${a.period || 'x'}${n}${Math.random().toString(16).slice(2, 8)}`;
      st.made.backtests += 1;
      // ver：这个项目里第几个同角色、同时间段的回测（「第 2 个开发期候选版本」）
      const ver = st.backtests.filter((b) => Number(b.projectId) === Number(a.projectId) && (b.role || null) === (a.role || null) && (b.period || null) === (a.period || null)).length + 1;
      st.backtests.push({ projectId: a.projectId, backtestId: id, name: a.name || `回测 ${n}`, role: a.role || null, period: a.period || null, file: a.file || 'main.py', created: new Date().toISOString(), seq: st.made.backtests, ver });
      return `已开始回测「${a.name || `回测 ${n}`}」，backtestId=${id}（projectId=${a.projectId}）。网站会自动显示进度。`;
    },
    wait_for_backtest: (st, a) => {
      const b = bt(st, a.backtestId);
      if (!b) return `错误：回测 ${a.backtestId} 不存在`;
      return JSON.stringify({ backtestId: b.backtestId, name: b.name, status: 'Completed.', phase: undefined, statistics: b.statistics || DEFAULT_STATS }, null, 1);
    },
    list_backtests: (st, a) => JSON.stringify(st.backtests.filter((b) => Number(b.projectId) === Number(a.projectId)).map((b) => ({
      backtestId: b.backtestId, name: b.name, status: 'Completed.', role: b.role, period: b.period,
      sharpe: (b.statistics || DEFAULT_STATS)['Sharpe Ratio'], drawdown: (b.statistics || DEFAULT_STATS).Drawdown,
    })), null, 1),
    update_backtest: (st, a) => {
      const b = bt(st, a.backtestId);
      if (!b) return `错误：回测 ${a.backtestId} 不存在`;
      for (const k of ['name', 'note', 'role', 'period']) if (a[k] !== undefined) b[k] = a[k];
      return `已更新回测 ${a.backtestId}`;
    },
    read_backtest_orders: () => '[]（评测环境：订单略）',
    read_backtest_log: () => '（评测环境：日志略）',
    test_idea: (st, a) => {
      const n = st.research.length + 1;
      const id = `rev${n}${Math.random().toString(16).slice(2, 10)}`;
      const factorsText = JSON.stringify(a.factors || []);
      st.made.research += 1;
      st.research.push({ projectId: a.projectId, jobId: id, title: a.title || a.idea, idea: a.idea, factorsText, verdict: null, seq: st.made.research });
      return `已开始想法检验 jobId=${id}「${a.title || a.idea}」：${(a.factors || []).map((f) => f.label || f.name).join('、')}。一般几分钟，网站「研究」标签实时显示；用 research_status(waitSec) 等完成，再用 read_research 读结果。`;
    },
    research_status: (st, a) => {
      if (!a.jobId) {
        const js = st.research.filter((j) => Number(j.projectId) === Number(a.projectId));
        return js.length ? js.map((j) => `- ${j.jobId}「${j.title}」complete（100%）${j.verdict ? ` → ${j.verdict}` : ''}`).join('\n') : '这个项目还没有研究任务。';
      }
      const j = job(st, a.jobId);
      return j ? `「${j.title}」complete，100%\n✓环境 ✓股票池 ✓价格数据 ✓冻结实验设计 ✓计算因子 ✓检验 ✓报告` : `错误：研究 ${a.jobId} 不存在`;
    },
    export_signals: (st, a) => `✅ 已导出信号 "idea_${a.jobId}_${a.ideaFactor || 'f1'}"：412000 行，503 只股票；开发期（滚动样本外） 2008-03-31 → 2024-11-19。
用法：
from helm_data import HelmSignals, HelmUniverse
sig = HelmSignals("idea_${a.jobId}_${a.ideaFactor || 'f1'}")
picks = sig.top(self.time, k=10)`,
    list_signals: () => '（还没有导出的信号）',
  };

  return {
    tools: (real) => plannedTools(real, fx),
    handles: (name) => !PASSTHROUGH.has(name),
    async call(name, args = {}) {
      const st = load();
      st.counts[name] = (st.counts[name] || 0) + 1;
      const b = args.backtestId ? bt(st, args.backtestId) : null;
      const j = args.jobId ? job(st, args.jobId) : null;
      const pOf = (pid) => (pid != null ? proj(st, pid) : null);
      const p = pOf(args.projectId ?? (b && b.projectId) ?? (j && j.projectId));
      // 可匹配的序号：btN / jobN / projN = 本次评测里第几个新建的回测 / 想法检验 / 项目；ver = 项目里第几个同角色同时间段的回测；planIdea = 项目对应第几个登记的想法
      const ctx = {
        ...(b ? { period: b.period, role: b.role, name: b.name, file: b.file, btN: b.seq, ver: b.ver } : {}),
        ...(j ? { idea: j.idea, title: j.title, factorsText: j.factorsText, jobN: j.seq } : {}),
        ...(p ? { projN: p.seq, planIdea: p.planIdea } : {}),
        ...args,
        n: st.counts[name],
        factorsText: args.factors ? JSON.stringify(args.factors) : (j ? j.factorsText : undefined),
      };
      // 出错的回测不能检验（和真实的 validate_backtest 一样）
      if (name === 'validate_backtest' && b && b.status === 'error') {
        save(st);
        return { text: '错误：这个回测没有成功跑完（Runtime Error），不能做统计检验。先修好代码重新回测。', isError: true };
      }
      // 先按默认逻辑更新状态（建项目、记下回测和研究），再看场景有没有覆盖结果
      const fn = defaults[name];
      let text = fn ? fn(st, args) : null;
      // create_backtest / test_idea / create_project 新生成的记录要能在场景结果里用、按序号匹配
      if (name === 'create_backtest') { const nb = st.backtests[st.backtests.length - 1]; Object.assign(ctx, { backtestId: nb.backtestId, btN: nb.seq, ver: nb.ver }); }
      if (name === 'test_idea') { const nj = st.research[st.research.length - 1]; Object.assign(ctx, { jobId: nj.jobId, jobN: nj.seq }); }
      if (name === 'create_project' && /projectId=/.test(text || '')) { const np = st.projects[st.projects.length - 1]; Object.assign(ctx, { projectId: np.projectId, projN: np.seq, planIdea: np.planIdea }); }
      const s = scripted(st, name, ctx);
      // 研究结论写回记录，research_status 列表里能看到
      if (s && name === 'read_research' && j) { const m = s.text.match(/结论：(有信号|信号弱|没有信号)/); if (m) j.verdict = m[1]; }
      // 回测报错：记下来，之后不能检验
      if (s && b && /wait_for_backtest|read_backtest/.test(name) && /Runtime Error/.test(s.text)) b.status = 'error';
      save(st);
      if (s) return s;
      if (text !== null) return { text, isError: /^错误：/.test(text) };
      return { text: `${UNSCRIPTED}工具 ${name} 在这个场景里没有预设结果，当作暂时不可用。`, isError: true };
    },
  };
}
