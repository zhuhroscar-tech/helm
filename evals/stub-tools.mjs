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
      counts: {},
      seq: 0,
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
    create_project: (st, a) => {
      const id = st.nextProjectId++;
      st.projects.push({ projectId: id, name: a.name, description: a.description || '', files: a.code ? { 'main.py': a.code } : {} });
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
      st.backtests.push({ projectId: a.projectId, backtestId: id, name: a.name || `回测 ${n}`, role: a.role || null, period: a.period || null, file: a.file || 'main.py', created: new Date().toISOString() });
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
      st.research.push({ projectId: a.projectId, jobId: id, title: a.title || a.idea, idea: a.idea, factorsText, verdict: null });
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
    handles: (name) => !PASSTHROUGH.has(name),
    async call(name, args = {}) {
      const st = load();
      st.counts[name] = (st.counts[name] || 0) + 1;
      const b = args.backtestId ? bt(st, args.backtestId) : null;
      const j = args.jobId ? job(st, args.jobId) : null;
      const ctx = {
        ...(b ? { period: b.period, role: b.role, name: b.name, file: b.file } : {}),
        ...(j ? { idea: j.idea, title: j.title, factorsText: j.factorsText } : {}),
        ...args,
        n: st.counts[name],
        factorsText: args.factors ? JSON.stringify(args.factors) : (j ? j.factorsText : undefined),
      };
      // 先按默认逻辑更新状态（建项目、记下回测和研究），再看场景有没有覆盖结果
      const fn = defaults[name];
      let text = fn ? fn(st, args) : null;
      // create_backtest / test_idea 新生成的 id 要能在场景结果里用
      if (name === 'create_backtest') ctx.backtestId = st.backtests[st.backtests.length - 1].backtestId;
      if (name === 'test_idea') ctx.jobId = st.research[st.research.length - 1].jobId;
      const s = scripted(st, name, ctx);
      // 研究结论写回记录，research_status 列表里能看到
      if (s && name === 'read_research' && j) { const m = s.text.match(/结论：(有信号|信号弱|没有信号)/); if (m) j.verdict = m[1]; }
      save(st);
      if (s) return s;
      if (text !== null) return { text, isError: /^错误：/.test(text) };
      return { text: `${UNSCRIPTED}工具 ${name} 在这个场景里没有预设结果，当作暂时不可用。`, isError: true };
    },
  };
}
