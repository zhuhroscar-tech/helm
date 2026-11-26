// 工作台（harness）的公共部分：每个 agent 一份工作台定义（同目录下的 mia / engineer / researcher / analyst / risk / scout），
// 这里是它们共用的纯函数（不读写文件、不调模型），服务端（server.mjs）负责保存每次运行的状态。
//
// 一份工作台定义：
//   id / title / mission    是谁、负责什么
//   deny                    这个 agent 用不到的 qc 工具（在 agents.json 的 deniedTools 之外再收紧）；allowOnly 则是只留这些
//   writeExt                write_file 只能写这些后缀（比如研究员、分析师只能写 .md）
//   loop                    一次运行的循环上限：工具调用数、单个工具的次数、时间、重复调用、没做完时最多续几次
//   subagents               能不能派子 agent：一次运行最多几个、同时几个、能派给谁（scout 只读 / worker 完整）
//   direction               研究方向：decide 能定 / suggest 只能提建议 / read 只能看
//   rules                   调用工具之前的硬规则：(ctx) => 拒绝的原因 | null
//   contract                运行结束时的交付检查：(ctx) => 还缺什么（空数组 = 做完了）
//
// guard：工具调用之前（qc-mcp.mjs 每次调用都先问服务端）；record：调用之后记账；contract：claude 进程结束时检查，
// 还缺东西就由服务端用同一个会话续跑（最多 loop.maxContinuations 次），这就是工作台的外层循环。

export const INTERNAL = new Set(['approve']); // Claude Code 自动调用的审批，不计数、不拦
export const READ_ONLY = new Set(['list_projects', 'read_project', 'read_file', 'list_data', 'list_datasets', 'read_dataset', 'wait_for_backtest', 'read_backtest',
  'list_backtests', 'read_backtest_orders', 'read_backtest_log', 'read_backtest_code', 'read_tuning', 'list_universes', 'universe_members', 'research_status',
  'read_research', 'list_signals', 'list_paper_sessions', 'read_paper_session', 'attribute_backtest']);
// 轮询类：同样的参数连着调很多次是正常的
export const POLLING = new Set(['wait_for_backtest', 'research_status', 'read_tuning', 'read_research', 'read_backtest', 'list_backtests', 'read_paper_session']);
// 被拦下时告诉 agent 这件事归谁做
export const OWNER = {
  test_idea: 'researcher', start_research: 'researcher', resume_research: 'researcher', export_signals: 'researcher', build_breadth: 'researcher', test_timing_signal: 'researcher',
  write_file: 'engineer', compile: 'engineer', create_backtest: 'engineer', tune_backtest: 'engineer', sensitivity_backtest: 'engineer', save_dataset: 'engineer', create_project: 'mia',
  validate_backtest: 'analyst', update_backtest: 'analyst', robustness_backtest: 'analyst',
};
export const DEFAULT_LOOP = { maxToolCalls: 120, hardFactor: 3, maxMinutes: 120, maxContinuations: 2, repeatErrors: 3, repeatSame: 5, perTool: {} };

const refuse = (state, tool, message, now) => {
  state.refusals.push({ at: now, tool, message: message.slice(0, 300) });
  return { allow: false, message: `错误：工作台规则：${message}` };
};
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
export const signature = (tool, args) => `${tool}:${JSON.stringify(sortKeys(args || {})).slice(0, 2000)}`;
const pidOf = (args) => (args && args.projectId != null && Number.isFinite(Number(args.projectId)) ? Number(args.projectId) : null);
const isSpec = (name) => /^spec\.(md|py)$/i.test(String(name || ''));

export function loopOf(h, { autopilot = false } = {}) {
  const l = { ...DEFAULT_LOOP, ...(h.loop || {}), perTool: { ...((h.loop && h.loop.perTool) || {}) } };
  // 自动研究有自己的预算和时间上限（lib/autopilot.mjs），这里只留防死循环的部分
  if (autopilot) { l.maxMinutes = 0; l.maxToolCalls *= 4; l.perTool = {}; }
  return l;
}

export function isDenied(h, tool) {
  if (INTERNAL.has(tool)) return false;
  if (h.allowOnly) return !h.allowOnly.has(tool);
  return (h.deny || []).includes(tool);
}
/** 这个工作台在一份完整工具清单里禁用了哪些 */
export const deniedTools = (h, allTools) => allTools.filter((t) => isDenied(h, t));

/** 一次运行的状态。carry：同一个对话上一次运行留下的（读过哪些项目的 spec） */
export function newState({ now = Date.now(), carry = null, autopilot = false } = {}) {
  return {
    startedAt: now, autopilot: Boolean(autopilot),
    total: 0, seen: 0, calls: {}, errSig: {}, lastSig: null, sameCount: 0,
    specSeen: Object.fromEntries(((carry && carry.specSeen) || []).map((p) => [p, true])),
    wrote: {}, created: [], backtests: [], jobs: [], validations: {}, handoffs: [],
    children: 0, continuations: 0, refusals: [], stopped: null,
  };
}
export const carryOf = (state) => ({ specSeen: Object.keys(state.specSeen).map(Number).filter(Number.isFinite).slice(-50) });

/** 工具调用之前。返回 { allow } 或 { allow: false, message } */
export function guard(h, state, tool, args = {}, { now = Date.now() } = {}) {
  if (INTERNAL.has(tool)) return { allow: true };
  const loop = loopOf(h, state);
  if (isDenied(h, tool)) {
    const o = OWNER[tool];
    return refuse(state, tool, `${tool} 不在「${h.title}」的工作台里${o && o !== h.id ? `，这件事归 ${o} 做：用 handoff 交给它` : ''}。不要换别的工具绕过。`, now);
  }
  if (loop.maxMinutes && now - state.startedAt > loop.maxMinutes * 60000 && !READ_ONLY.has(tool)) return refuse(state, tool, `这次运行超过了时间上限（${loop.maxMinutes} 分钟）：不再开新的工作，给出最终总结，写明做到哪一步、还差什么。`, now);
  if (state.total >= loop.maxToolCalls) return refuse(state, tool, `这次运行的工具调用预算（${loop.maxToolCalls} 次）用完了：停下来给最终总结，写明做到哪一步、还差什么。`, now);
  const cap = loop.perTool[tool];
  if (cap != null && (state.calls[tool] || 0) >= cap) return refuse(state, tool, `${tool} 这次运行最多 ${cap} 次，已经用完。${h.capNotes && h.capNotes[tool] ? h.capNotes[tool] : '照实汇报现有结果，不要换别的工具绕过。'}`, now);
  const sig = signature(tool, args);
  if ((state.errSig[sig] || 0) >= loop.repeatErrors) return refuse(state, tool, `同样参数的 ${tool} 已经连续失败 ${loop.repeatErrors} 次：不要再试同一个调用，读错误信息换做法，或者照实汇报。`, now);
  if (!POLLING.has(tool) && sig === state.lastSig && state.sameCount >= loop.repeatSame) return refuse(state, tool, `同样参数的 ${tool} 已经连着调用了 ${state.sameCount} 次，结果不会变：往下做，或者给出总结。`, now);
  if (tool === 'write_file' && h.writeExt && !isSpec(args.name) && !h.writeExt.some((e) => String(args.name || '').toLowerCase().endsWith(e))) {
    return refuse(state, tool, `「${h.title}」只能写 ${h.writeExt.join(' / ')} 文件；${args.name} 是代码，交给 engineer 写。`, now);
  }
  for (const rule of h.rules || []) {
    const why = rule({ h, state, tool, args, pid: pidOf(args) });
    if (why) return refuse(state, tool, why, now);
  }
  return { allow: true };
}

/** 工具调用之后记账。返回 { note }：附在工具结果后面给 agent 看的提醒 */
export function record(h, state, tool, args = {}, result = '', { isError = false, datesOnly = false } = {}) {
  if (INTERNAL.has(tool)) return { note: '' };
  const text = String(result || '');
  const failed = isError || /^(错误|Error)[:：]/.test(text);
  const sig = signature(tool, args);
  state.total += 1;
  state.calls[tool] = (state.calls[tool] || 0) + 1;
  state.sameCount = sig === state.lastSig ? state.sameCount + 1 : 1;
  state.lastSig = sig;
  if (failed) state.errSig[sig] = (state.errSig[sig] || 0) + 1; else delete state.errSig[sig];
  const pid = pidOf(args);
  if (!failed) {
    switch (tool) {
      case 'read_project': if (pid != null) state.specSeen[pid] = true; break;
      case 'read_file': if (pid != null && isSpec(args.name)) state.specSeen[pid] = true; break;
      case 'write_file':
        if (pid == null) break;
        if (isSpec(args.name)) state.specSeen[pid] = true;
        else if (datesOnly) (state.datesOnly || (state.datesOnly = [])).push(`${pid}/${String(args.name || '')}`); // 只改了回测起止日期：不算改策略（验证期规则用）
        else (state.wrote[pid] || (state.wrote[pid] = [])).push(String(args.name || ''));
        break;
      case 'create_project': { const m = text.match(/projectId=(\d+)/); if (m) state.created.push(Number(m[1])); break; }
      case 'create_backtest': { const m = text.match(/backtestId=([A-Za-z0-9_-]+)/); if (m) state.backtests.push({ id: m[1], pid, period: args.period || 'dev', role: args.role || 'candidate', waited: false }); break; }
      case 'wait_for_backtest': case 'read_backtest': case 'read_backtest_orders': case 'read_backtest_log':
        for (const b of state.backtests) if (b.id === args.backtestId) b.waited = true;
        break;
      case 'test_idea': case 'start_research': { const m = text.match(/jobId=([A-Za-z0-9_-]+)/); if (m) state.jobs.push({ id: m[1], pid, kind: tool, read: false }); break; }
      case 'read_research': for (const j of state.jobs) if (!args.jobId || j.id === args.jobId) j.read = true; break;
      case 'validate_backtest': {
        const pass = /结论：✅|Verdict: ✅|✅ 通过|✅ pass/i.test(text) ? true : /结论：❌|❌/.test(text) ? false : null;
        if (pass !== null && args.backtestId) state.validations[args.backtestId] = pass;
        break;
      }
      case 'handoff': state.handoffs.push({ agent: args.agent, pid, wait: args.wait === true }); break;
      default: break;
    }
  }
  const loop = loopOf(h, state);
  const notes = [];
  const cap = loop.perTool[tool];
  if (cap != null && cap - state.calls[tool] <= 1) notes.push(`${tool} 这次运行还剩 ${Math.max(0, cap - state.calls[tool])} 次`);
  const left = loop.maxToolCalls - state.total;
  if (left === 10 || left === 3) notes.push(`工具调用预算还剩 ${left} 次，留出给最终总结的余量`);
  return { note: notes.length ? `（工作台：${notes.join('；')}）` : '' };
}

const NUMBERS_RE = /\d+(\.\d+)?\s*%/g;
/** 给了一堆数字，却一个读数据的工具都没调过 */
export function ungroundedNumbers(state, text) {
  const n = (String(text).match(NUMBERS_RE) || []).length;
  const read = Object.keys(state.calls).some((t) => READ_ONLY.has(t) || ['validate_backtest', 'robustness_backtest', 'sensitivity_backtest'].includes(t));
  return n >= 3 && !read && state.handoffs.length === 0 && state.children === 0;
}

/** 运行结束时的交付检查：返回还缺什么 */
export function contract(h, state, text = '', { delegated = false } = {}) {
  const miss = [];
  const pendingBt = state.backtests.filter((b) => !b.waited);
  if (pendingBt.length) miss.push(`回测 ${pendingBt.map((b) => b.id).join('、')} 提交了但没有等结果：用 wait_for_backtest 等它跑完，读统计，再总结`);
  const pendingJob = state.jobs.filter((j) => j.kind === 'test_idea' && !j.read);
  if (pendingJob.length) miss.push(`想法检验 ${pendingJob.map((j) => j.id).join('、')} 提交了但没有读结果：research_status(waitSec) 等完成，再 read_research`);
  if (delegated && state.total > 0 && !String(text).trim()) miss.push('这是交接来的任务，但没有给出最终总结：写明结论、关键数字、projectId / backtestId');
  for (const m of (h.contract ? h.contract({ h, state, text: String(text), delegated }) : [])) miss.push(m);
  return [...new Set(miss)];
}

export function continueMessage(miss, lang = 'zh') {
  const list = miss.map((m, i) => `${i + 1}. ${m}`).join('\n');
  return lang === 'en'
    ? `[Helm harness] The task is not finished yet. Still missing:\n${list}\n\nDo only these, then give the final summary. If one of them cannot be done, say so plainly and why; do not make up results. (The items above are written in Chinese; reply in English.)`
    : `【Helm 工作台】这次任务还没做完，还缺：\n${list}\n\n只补上这些，然后给出最终总结。其中哪一项确实做不了，就照实说做不了和原因，不要编结果。`;
}

/** 派子 agent 之前的检查（服务端调用）。返回 { error } 或 { tasks: [{ agent, task, mode, projectId, backtestId }] } */
export function planSubagents(h, state, tasks, { isSub = false, agents = [] } = {}) {
  const s = h.subagents;
  if (isSub || !s || !s.max) return { error: `「${h.title}」在这次运行里不能再派子 agent（子 agent 不能再往下派）。自己完成，或者在总结里写明建议。` };
  if (!Array.isArray(tasks) || !tasks.length) return { error: 'tasks 不能为空' };
  if (tasks.length > s.parallel) return { error: `一次最多同时派 ${s.parallel} 个子 agent` };
  if (state.children + tasks.length > s.max) return { error: `这次运行最多派 ${s.max} 个子 agent，已经派了 ${state.children} 个` };
  const out = [];
  for (const t of tasks) {
    const id = String((t && t.agent) || '');
    if (!agents.includes(id)) return { error: `没有 id 为 ${id} 的 agent。可选：${Object.keys(s.targets).join(', ')}` };
    const most = s.targets[id];
    if (!most) return { error: `「${h.title}」不能把子任务派给 ${id}。可选：${Object.entries(s.targets).map(([k, v]) => `${k}（${v}）`).join('、')}` };
    const mode = t.mode === 'worker' || (t.mode == null && most === 'worker') ? 'worker' : 'scout';
    if (mode === 'worker' && most !== 'worker') return { error: `派给 ${id} 只能用 scout（只读）模式` };
    const task = String(t.task || '').trim();
    if (task.length < 10) return { error: '每个子任务的说明都要写清：做什么、projectId、怎样算完成' };
    out.push({ agent: id, task, mode, projectId: t.projectId || null, backtestId: t.backtestId || null });
  }
  if (new Set(out.map((t) => `${t.agent}:${t.task}`)).size !== out.length) return { error: '有两个子任务完全一样' };
  return { tasks: out };
}

/** 拼进系统提示词的一段：让 agent 事先知道代码会强制什么（规则本身在代码里，不靠提示词） */
export function promptFor(h, { autopilot = false, sub = null } = {}) {
  const loop = loopOf(h, { autopilot });
  const caps = Object.entries(loop.perTool).map(([k, v]) => `${k} ≤ ${v}`).join('、');
  const lines = [`\n\n## 你的工作台（Helm 在代码里强制，不是建议）`, `职责：${h.mission}`];
  lines.push(`- 循环上限：一次运行最多 ${loop.maxToolCalls} 次 qc 工具调用${loop.maxMinutes ? `、${loop.maxMinutes} 分钟` : ''}${caps ? `；其中 ${caps}` : ''}。同样参数的调用连续失败 ${loop.repeatErrors} 次会被拦下。工具返回「工作台规则」的错误时，这条路到此为止：不要换别的工具绕过，照实汇报。`);
  for (const r of h.ruleNotes || []) lines.push(`- ${r}`);
  if (h.deliver && h.deliver.length) lines.push(`- 交付要求（结束时 Helm 会检查，缺了会让你继续补）：${h.deliver.join('；')}。`);
  if (sub) {
    lines.push(sub.mode === 'scout'
      ? '- 你这次是子 agent（scout，只读）：只能读和查，不能改任何东西、不能提问、不能再往下派。只回答交给你的那一个问题，给出结论和依据（数字照抄工具结果），然后结束。'
      : '- 你这次是子 agent（worker）：只完成交给你的这一段，不能再往下派子 agent；做完给出最终总结（结论、关键数字、projectId / backtestId）。');
  } else if (h.subagents && h.subagents.max) {
    const s = h.subagents;
    lines.push(`- 子 agent：需要并行查几件互不依赖的事时，用 mcp__qc__subagent 一次派出最多 ${s.parallel} 个（这次运行总共 ${s.max} 个），等它们都做完一起拿回结果。能派给：${Object.entries(s.targets).map(([k, v]) => `${k}（${v === 'worker' ? 'worker 完整权限 / scout 只读' : 'scout 只读'}）`).join('、')}。任务说明要完整自洽。按阶段、有先后依赖的工作仍然用 handoff。`);
  }
  if (!sub && !autopilot && h.direction === 'decide') {
    lines.push('- 研究方向：用户没有给具体想法、让你自己找方向，或者一个方向做完要换下一个时，用 mcp__qc__research_direction。先 action=read 看已经测过什么、有什么数据；action=set 登记方向（名字、经济逻辑、1–3 个事先定好的假设和各自怎样算失败），再开始检验；做完用 action=conclude 写结论和依据，才能登记下一个。方向数有上限，每个方向的想法检验次数按登记的假设数算，换方向必须说明为什么是不同的收益来源。用户已经给了具体想法时不用登记，直接按流程做。');
  } else if (!sub && !autopilot && h.direction === 'suggest') {
    lines.push('- 研究方向：你不决定研究方向。做的过程中发现值得研究的方向，用 mcp__qc__research_direction(action=suggest) 记下来，由总控或研究员决定。');
  }
  return lines.join('\n');
}

/** 给网页和审计看的摘要 */
export function summary(h, state) {
  return { id: h.id, calls: state.total, perTool: state.calls, continuations: state.continuations, children: state.children, refusals: state.refusals.slice(-20), stopped: state.stopped };
}
