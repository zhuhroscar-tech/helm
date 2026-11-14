// 研究流水线 + agent 任务：把「项目走到哪一阶段」（想法记录）和「哪个 agent 在做、谁交给谁」（对话记录）合成一张看板。
// 只读：不改任何对话或项目，只汇报已经保存的东西和正在运行的 agent。
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export const PIPE_STAGES = [
  { id: 'idea', zh: '想法', owner: 'mia', desc: '写规则说明、选路线' },
  { id: 'test', zh: '想法检验', owner: 'researcher', desc: 'qlib 因子在开发期有没有信号', journal: '想法检验' },
  { id: 'dev', zh: '开发期回测', owner: 'engineer', desc: '照 spec 写 LEAN 代码，跑开发期', journal: '开发期回测' },
  { id: 'gate', zh: '统计检验', owner: 'analyst', desc: '置信区间、去膨胀夏普，通过才标 main', journal: '统计检验' },
  { id: 'holdout', zh: '验证期', owner: 'engineer', desc: '样本外只跑一次', journal: '验证期' },
  { id: 'paper', zh: '模拟实盘', owner: 'mia', desc: '冻结代码，每天收盘后前向跑', journal: '模拟实盘' },
];
const STAGE_IDX = Object.fromEntries(PIPE_STAGES.map((s, i) => [s.journal || s.zh, i]));

const readJson = async (f, d = null) => { try { return JSON.parse(await readFile(f, 'utf8')); } catch { return d; } };
const short = (name) => String(name || '').replace(/^mcp__.*?__/i, '');
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

/* ---------------- 对话 → 任务摘要 ---------------- */

// 一个对话算一个任务：谁做、谁交来的、关于哪个项目、现在什么状态、最后一步/结论是什么
export function summarizeThread(t, { running = false } = {}) {
  const msgs = Array.isArray(t.messages) ? t.messages : [];
  const pids = new Map(); // projectId -> 权重（最后出现的位置）
  let created = null;
  let order = 0;
  const handoffs = [];
  for (const m of msgs) {
    const c = m.context || {};
    if (Number.isInteger(c.projectId)) pids.set(c.projectId, ++order);
    for (const p of m.parts || []) {
      if (p.kind !== 'tool') continue;
      const inp = p.input && typeof p.input === 'object' ? p.input : {};
      if (Number.isInteger(inp.projectId)) pids.set(inp.projectId, ++order);
      if (short(p.name) === 'create_project' && p.status === 'done') {
        const mm = String(p.result || '').match(/projectId=(\d+)/);
        if (mm) { created = Number(mm[1]); pids.set(created, ++order); }
      }
      if (short(p.name) === 'handoff') {
        const tid = (String(p.result || '').match(/threadId=([A-Za-z0-9-]+)/) || [])[1] || null;
        handoffs.push({ to: inp.agent || null, wait: Boolean(inp.wait), task: clip(inp.task, 400), threadId: tid, status: p.status === 'running' && !running ? 'stopped' : p.status || 'done', projectId: Number.isInteger(inp.projectId) ? inp.projectId : null });
      }
    }
  }
  const projectIds = [...pids.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const lastA = [...msgs].reverse().find((m) => m.role === 'assistant');
  const firstU = msgs.find((m) => m.role === 'user');
  let status = running ? 'running' : 'done';
  if (!running && lastA) {
    if (lastA.error) status = 'error';
    else if (lastA.stopped) status = 'stopped';
    else if (!(lastA.parts || []).length) status = 'stopped'; // 进程被打断、什么都没留下
  }
  const parts = (lastA && lastA.parts) || [];
  const lastTool = [...parts].reverse().find((p) => p.kind === 'tool' && short(p.name) !== 'ToolSearch');
  const texts = parts.filter((p) => p.kind === 'text' && p.text).map((p) => p.text);
  const cost = msgs.reduce((s, m) => s + (Number.isFinite(m.cost) ? m.cost : 0), 0);
  return {
    id: t.id, agent: t.agent, title: t.title || '', createdAt: t.createdAt || (firstU && firstU.at) || null, updatedAt: t.updatedAt || null,
    from: t.from ? { agent: t.from.agent, threadId: t.from.threadId } : null, depth: t.depth || 0,
    projectId: created ?? projectIds[0] ?? null, projectIds,
    status, turns: msgs.filter((m) => m.role === 'user').length,
    brief: clip(firstU ? String(firstU.text || '').replace(/^【[^】]*】\s*/, '') : '', 300),
    lastStep: lastTool ? short(lastTool.name) : null,
    outcome: status === 'error' ? clip(lastA.error, 200) : clip(texts[texts.length - 1] || '', 280),
    handoffs, cost: cost || null, duration: lastA && lastA.duration ? lastA.duration : null, model: lastA && lastA.model ? lastA.model : null,
  };
}

const CACHE = new Map(); // file -> { mtime, size, summary }
export async function loadTasks(threadsDir, liveThreads = new Map()) {
  let files = [];
  try { files = (await readdir(threadsDir)).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    const id = f.slice(0, -5);
    const live = liveThreads.get(id);
    if (live) { out.push(summarizeThread(live, { running: true })); continue; }
    const file = path.join(threadsDir, f);
    try {
      const st = await stat(file);
      const hit = CACHE.get(file);
      if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) { out.push(hit.summary); continue; }
      const t = JSON.parse(await readFile(file, 'utf8'));
      const summary = summarizeThread(t);
      CACHE.set(file, { mtime: st.mtimeMs, size: st.size, summary });
      out.push(summary);
    } catch { /* 坏文件跳过 */ }
  }
  // 交接出来的对话没提到项目时，跟着来源对话走
  const byId = new Map(out.map((x) => [x.id, x]));
  for (const x of out) {
    let cur = x; let hops = 0;
    while (x.projectId == null && cur.from && hops++ < 5) { cur = byId.get(cur.from.threadId); if (!cur) break; if (cur.projectId != null) x.projectId = cur.projectId; }
  }
  // 子任务：谁交出来的
  for (const x of out) x.children = out.filter((y) => y.from && y.from.threadId === x.id).map((y) => y.id);
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/* ---------------- 看板 ---------------- */

function gateOf(stageId, es) {
  // 每个阶段给一个「过了没有」：pass / fail / weak / pending / null（还没到）
  if (!es.length) return null;
  if (stageId === 'test') {
    const best = es.map((e) => e.outcomeCode).includes('signal') ? 'signal' : es.some((e) => e.outcomeCode === 'weak') ? 'weak' : es.some((e) => e.outcomeCode === 'none') ? 'none' : 'pending';
    return { state: best === 'signal' ? 'pass' : best === 'weak' ? 'weak' : best === 'none' ? 'fail' : 'pending', label: best === 'signal' ? '有信号' : best === 'weak' ? '信号弱' : best === 'none' ? '没有信号' : '未完成' };
  }
  if (stageId === 'gate') {
    if (es.some((e) => e.outcomeCode === 'main')) return { state: 'pass', label: '已通过，标了 main' };
    return { state: 'fail', label: '没通过统计检验' };
  }
  if (stageId === 'dev') {
    const done = es.filter((e) => e.outcome !== '没跑完' && e.outcomeCode !== 'deleted');
    return done.length ? { state: 'pass', label: `${done.length} 个回测` } : { state: 'pending', label: '没跑完' };
  }
  if (stageId === 'holdout') return { state: 'pass', label: `看过 ${es.length} 次` };
  if (stageId === 'paper') return es.some((e) => e.outcomeCode === 'active') ? { state: 'pass', label: '进行中' } : { state: 'pending', label: '已停止' };
  return null;
}

// journal: loadJournal() 的结果；projects: [{projectId, name, modified}]；tasks: loadTasks() 的结果；running: runningList()
export function buildPipeline({ journal, projects = [], tasks = [], running = [], drafts = [] }) {
  const entries = (journal && journal.entries) || [];
  const byProj = new Map();
  const ensure = (id, name) => {
    if (!byProj.has(id)) byProj.set(id, { projectId: id, name: name || `项目 #${id}`, entries: [], tasks: [], modified: null });
    return byProj.get(id);
  };
  for (const p of projects) { const x = ensure(p.projectId, p.name); x.modified = p.modified || null; x.description = p.description || ''; }
  // 已删除的项目（只剩尝试记录）不上看板；没给项目列表时（测试）按记录建卡片
  const known = projects.length ? new Set(projects.map((p) => p.projectId)) : null;
  for (const e of entries) if (e.projectId != null && (!known || known.has(e.projectId))) ensure(e.projectId, e.projectName).entries.push(e);
  for (const t of tasks) if (t.projectId != null && byProj.has(t.projectId)) byProj.get(t.projectId).tasks.push(t);

  const runIds = new Set(running.map((r) => r.threadId));
  const cards = [];
  for (const p of byProj.values()) {
    let reached = 0;
    for (const e of p.entries) reached = Math.max(reached, STAGE_IDX[e.stage] ?? 0);
    const stages = PIPE_STAGES.map((s, i) => {
      const es = s.journal ? p.entries.filter((e) => e.stage === s.journal) : [];
      return { id: s.id, zh: s.zh, count: es.length, gate: i === 0 ? { state: 'pass', label: '已建项目' } : gateOf(s.id, es) };
    });
    const cur = stages[reached];
    const live = p.tasks.filter((t) => runIds.has(t.id));
    const draft = drafts.find((d) => p.tasks.some((t) => t.id === d.threadId));
    let status = 'idle'; let note = '';
    if (live.length) { status = 'active'; }
    else if (cur.id === 'test' && cur.gate && cur.gate.state === 'fail') { status = 'stopped'; note = '想法检验没有信号，按规则到此为止'; }
    else if (cur.id === 'gate' && cur.gate && cur.gate.state === 'fail') { status = 'blocked'; note = '统计检验没通过，不能标 main'; }
    else if (cur.gate && cur.gate.state === 'pending') { status = 'blocked'; note = cur.gate.label; }
    else if (cur.id === 'paper' && cur.gate && cur.gate.state === 'pass') { status = 'live'; }
    const last = p.entries.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0];
    // 接力链：按时间排的任务（根任务 + 它交出去的子任务），最近的 8 个
    const relay = p.tasks.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).slice(-8).map((t) => ({
      id: t.id, agent: t.agent, from: t.from, status: runIds.has(t.id) ? 'running' : t.status, title: t.title, createdAt: t.createdAt,
    }));
    const updated = Math.max(Date.parse(p.modified || '') || 0, ...p.tasks.map((t) => t.updatedAt || 0), Date.parse((last && last.date) || '') || 0);
    cards.push({
      projectId: p.projectId, name: p.name, description: p.description || '', stage: PIPE_STAGES[reached].id, stageIdx: reached, stages, status, note,
      key: last && last.key ? last.key : null, last: last ? { what: last.what, outcome: last.outcome, stage: last.stage, date: last.date, link: last.link } : null,
      working: live.map((t) => ({ threadId: t.id, agent: t.agent, title: t.title, from: t.from })),
      drafting: draft ? { from: draft.from, agent: draft.agent, threadId: draft.threadId } : null,
      relay, taskCount: p.tasks.length, updatedAt: updated || null,
    });
  }
  cards.sort((a, b) => (b.status === 'active') - (a.status === 'active') || (b.updatedAt || 0) - (a.updatedAt || 0));
  const unassigned = tasks.filter((t) => t.projectId == null || !byProj.has(t.projectId)).slice(0, 20);
  const counts = Object.fromEntries(PIPE_STAGES.map((s) => [s.id, cards.filter((c) => c.stage === s.id).length]));
  return { stages: PIPE_STAGES, cards, counts, unassigned, running };
}

// 一个项目的完整时间线：阶段记录（想法检验、回测…）和 agent 任务（谁交给谁、做了什么）按时间合在一起
export function projectTimeline({ journal, tasks, projectId }) {
  const ev = [];
  for (const e of ((journal && journal.entries) || []).filter((x) => x.projectId === projectId)) {
    ev.push({ kind: 'stage', at: Date.parse(e.date || '') || 0, stage: e.stage, what: e.what, detail: e.detail, outcome: e.outcome, outcomeCode: e.outcomeCode, key: e.key, link: e.link });
  }
  for (const t of tasks.filter((x) => x.projectId === projectId)) {
    ev.push({ kind: 'task', at: t.createdAt || 0, ...t });
  }
  return ev.sort((a, b) => b.at - a.at);
}
