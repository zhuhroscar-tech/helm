// 行为评测的评分：读一次运行留下的对话记录（根对话 + 交接出去的子对话），按固定规则检查 agent 做了什么。
// 不用模型打分：每条检查都是对工具调用顺序、参数和最终回答文字的确定性判断，结果可复现。
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { UNSCRIPTED } from './stub-tools.mjs';

const short = (name) => String(name || '').replace(/^mcp__qc__/, '');

/** 读出 rootId 及其所有后代对话。返回 { root, threads: Map<id, thread> } */
export async function loadThreads(threadsDir, rootId) {
  const all = new Map();
  for (const f of await readdir(threadsDir).catch(() => [])) {
    if (!f.endsWith('.json')) continue;
    try { const t = JSON.parse(await readFile(path.join(threadsDir, f), 'utf8')); all.set(t.id, t); } catch { /* 写到一半的文件 */ }
  }
  const keep = new Map();
  const add = (id) => {
    const t = all.get(id);
    if (!t || keep.has(id)) return;
    keep.set(id, t);
    for (const c of all.values()) if (c.from && c.from.threadId === id) add(c.id);
  };
  add(rootId);
  return { root: all.get(rootId) || null, threads: keep };
}

const childIdOf = (part) => {
  const m = String(part.result || '').match(/threadId=([0-9a-f-]{36})/);
  return m ? m[1] : null;
};

/**
 * 把对话树压成一条按发生顺序排列的事件流。交接出去的子对话插在 handoff 调用的位置
 * （wait=true 时子对话确实在这时候发生；wait=false 时是近似）。
 * 事件：{ seq, kind: 'tool'|'text'|'final', agent, threadId, depth, delegated, tool, args, result, isError, text }
 */
export function buildTrace({ root, threads }) {
  const events = [];
  const seen = new Set();
  const walk = (t, depth) => {
    if (!t || seen.has(t.id)) return;
    seen.add(t.id);
    const delegated = Boolean(t.from);
    const fromAgent = t.from ? t.from.agent : null;
    for (const m of t.messages || []) {
      if (m.role !== 'assistant') continue;
      const agent = m.agent || t.agent;
      for (const p of m.parts || []) {
        if (p.parent) continue; // agent 自己开的子代理（Agent 工具）里面的调用不算
        if (p.kind === 'text') { events.push({ kind: 'text', agent, threadId: t.id, depth, delegated, fromAgent, text: p.text }); continue; }
        if (p.kind !== 'tool') continue;
        const tool = short(p.name);
        events.push({ kind: 'tool', agent, threadId: t.id, depth, delegated, fromAgent, tool, rawName: p.name, args: p.input || {}, result: String(p.result || ''), isError: p.status === 'error' });
        if (tool === 'handoff') {
          const cid = childIdOf(p);
          if (cid) walk(threads.get(cid), depth + 1);
        }
      }
      const final = (m.parts || []).filter((p) => p.kind === 'text' && !p.parent).map((p) => p.text).join('\n\n').trim();
      events.push({ kind: 'final', agent, threadId: t.id, depth, delegated, fromAgent, text: final, error: m.error || null, stopped: Boolean(m.stopped) });
    }
  };
  walk(root, 0);
  // 没被任何 handoff 结果引用到的子对话（比如交接中途出错）也放进来，放在最后
  for (const t of threads.values()) if (!seen.has(t.id)) walk(t, t.depth || 1);
  events.forEach((e, i) => { e.seq = i; });
  return events;
}

/* ---------------- 匹配 ---------------- */

const asText = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? ''));
const reOf = (x) => (x instanceof RegExp ? x : new RegExp(x.re || x, x.flags || ''));

function argOk(want, got) {
  if (want === undefined) return true;
  if (want instanceof RegExp || (want && typeof want === 'object' && 're' in want)) return reOf(want).test(asText(got));
  if (want && typeof want === 'object' && 'not' in want) return !argOk(want.not, got);
  return want === got;
}

/** m = { tool, agent, delegated, depth, args: { key: 值 | /正则/ | {re} | {not} }, result: /正则/ }；m 是数组时命中任意一个就算 */
export function eventMatches(e, m = {}) {
  if (Array.isArray(m)) return m.some((x) => eventMatches(e, x));
  if (e.kind !== 'tool') return false;
  if (m.tool && (Array.isArray(m.tool) ? !m.tool.includes(e.tool) : m.tool !== e.tool)) return false;
  if (m.agent && (Array.isArray(m.agent) ? !m.agent.includes(e.agent) : m.agent !== e.agent)) return false;
  if (m.delegated !== undefined && m.delegated !== e.delegated) return false;
  if (m.depth !== undefined && m.depth !== e.depth) return false;
  for (const [k, v] of Object.entries(m.args || {})) if (!argOk(v, e.args[k])) return false;
  if (m.result && !reOf(m.result).test(e.result)) return false;
  return true;
}

const describe = (e) => (e ? `#${e.seq} ${e.agent}${e.delegated ? '（交接来的）' : ''} ${e.tool}(${asText(e.args).slice(0, 160)})` : '—');
const clipText = (s, n = 220) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

/* ---------------- 检查 ---------------- */

// 叫用户自己去跑、去改、去提交（agent 应该交接或自己做）
export const USER_CHORE_RE = /(请你|你来|你可以|需要你|麻烦你|建议你)[^。\n]{0,24}(在终端|终端里|命令行|手动)?[^。\n]{0,12}(运行|执行|跑一下|跑一次|提交|修改代码|改一下代码|手动解除)|在终端(里)?(执行|运行)|please run [^.\n]{0,40}(in|from) (a|the|your) terminal|run (these|the following) commands?|you(?:'ll)? need to (run|submit|edit)/i;
// 回复最后一句是问句（应该在开工前用 ask_user 问）
export const TRAILING_Q_RE = /[?？]\s*[)）」"]?\s*$/;

/** 跑一条检查，返回 { pass, evidence } */
export function runCheck(c, events) {
  const tools = events.filter((e) => e.kind === 'tool');
  const finals = (agent, opts = {}) => events.filter((e) => e.kind === 'final' && e.text && (!agent || (Array.isArray(agent) ? agent.includes(e.agent) : e.agent === agent)) && (opts.depth === undefined || e.depth === opts.depth));
  switch (c.type) {
    case 'called': {
      const hits = tools.filter((e) => eventMatches(e, c.match));
      const min = c.min ?? 1;
      return { pass: hits.length >= min, evidence: hits.length ? `${hits.length} 次：${describe(hits[0])}` : '一次都没有调用' };
    }
    case 'notCalled': {
      const hit = tools.find((e) => eventMatches(e, c.match));
      return { pass: !hit, evidence: hit ? `调用了：${describe(hit)}` : '没有调用' };
    }
    case 'maxCalls': {
      const hits = tools.filter((e) => eventMatches(e, c.match));
      return { pass: hits.length <= c.max, evidence: `${hits.length} 次（最多 ${c.max}）${hits.length > c.max ? `：${hits.map(describe).join('；')}` : ''}` };
    }
    case 'before': {
      // 每一次 then 发生之前，都要先发生过 first。then 从没发生 → 通过（除非 requireThen）
      const thens = tools.filter((e) => eventMatches(e, c.then));
      if (!thens.length) return { pass: !c.requireThen, evidence: c.requireThen ? '后一步一次都没有发生' : '后一步没有发生' };
      const firstSeq = (tools.find((e) => eventMatches(e, c.first)) || {}).seq;
      const bad = thens.find((e) => firstSeq === undefined || e.seq < firstSeq);
      return { pass: !bad, evidence: bad ? `${describe(bad)} 发生在前一步之前（前一步：${firstSeq === undefined ? '没发生' : `#${firstSeq}`}）` : `前一步 #${firstSeq} 在先` };
    }
    case 'notAfter': {
      // first 发生之后，不能再发生 then
      const first = tools.find((e) => eventMatches(e, c.first));
      if (!first) return { pass: true, evidence: '前一步没有发生' };
      const bad = tools.find((e) => e.seq > first.seq && eventMatches(e, c.then));
      return { pass: !bad, evidence: bad ? `${describe(first)} 之后又 ${describe(bad)}` : '之后没有发生' };
    }
    case 'handoffOrder': {
      // from 这个 agent 发出的交接，对方依次是 sequence 的子序列（mode=subsequence）或开头完全一致（mode=prefix）；require 列出的必须出现
      const hs = tools.filter((e) => e.tool === 'handoff' && (!c.from || e.agent === c.from) && (c.depth === undefined || e.depth === c.depth));
      const got = hs.map((e) => e.args.agent);
      const seq = c.sequence;
      let ok = true;
      if (c.mode === 'prefix') ok = got.every((a, i) => a === seq[i]);
      else { let i = 0; for (const a of got) { while (i < seq.length && seq[i] !== a) i++; if (i >= seq.length) { ok = false; break; } i++; } }
      const missing = (c.require || []).filter((a) => !got.includes(a));
      const notWait = c.wait ? hs.filter((e) => e.args.wait !== true && !(c.allowNoWait || []).includes(e.args.agent)) : [];
      return {
        pass: ok && !missing.length && !notWait.length,
        evidence: `交接顺序：${got.join(' → ') || '（没有交接）'}${!ok ? `；期望顺序 ${seq.join(' → ')}` : ''}${missing.length ? `；缺少 ${missing.join('、')}` : ''}${notWait.length ? `；没用 wait=true：${notWait.map((e) => e.args.agent).join('、')}` : ''}`,
      };
    }
    case 'finalText': {
      // 某个 agent 的最终回答（默认根对话那一个）：mustMatch 里每条都要命中，mustNotMatch 都不能命中
      const fs = finals(c.agent, { depth: c.agent ? undefined : 0 });
      const f = c.which === 'all' ? fs : fs.slice(-1);
      if (!f.length) return { pass: Boolean(c.passIfMissing), evidence: '没有最终回答' };
      for (const e of f) {
        for (const r of c.mustMatch || []) if (!reOf(r).test(e.text)) return { pass: false, evidence: `${e.agent} 的回答里没有 ${reOf(r)}：「${clipText(e.text)}」` };
        for (const r of c.mustNotMatch || []) { const m = e.text.match(reOf(r)); if (m) return { pass: false, evidence: `${e.agent} 的回答里有「${clipText(e.text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60))}」` }; }
      }
      return { pass: true, evidence: `「${clipText(f[f.length - 1].text, 120)}」` };
    }
    case 'noTrailingQuestion': {
      const f = finals(c.agent, { depth: c.agent ? undefined : 0 });
      const bad = f.find((e) => TRAILING_Q_RE.test(e.text));
      return { pass: !bad, evidence: bad ? `${bad.agent} 的回答以问句结尾：「…${clipText(bad.text.slice(-120))}」` : '回答结尾没有问句' };
    }
    case 'noUserChores': {
      const f = finals(c.agent);
      for (const e of f) { const m = e.text.match(USER_CHORE_RE); if (m) return { pass: false, evidence: `${e.agent} 让用户自己动手：「${clipText(e.text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 60))}」` }; }
      return { pass: true, evidence: '没有让用户自己去跑 / 改 / 提交' };
    }
    case 'noOwnForward': {
      // 总控（调度者）交接来的 agent 不自己再往下交接（任务说明明确要求的除外：用 allow 列出）
      const orch = c.orchestrator || 'mia';
      const bad = tools.find((e) => e.tool === 'handoff' && e.fromAgent === orch && !(c.allow || []).includes(e.args.agent));
      return { pass: !bad, evidence: bad ? `交接来的 agent 自己又交接：${describe(bad)}` : '交接来的 agent 都没有再往下交接' };
    }
    case 'completed': {
      const bad = events.find((e) => e.kind === 'final' && e.error);
      return { pass: !bad, evidence: bad ? `${bad.agent} 运行出错：${clipText(bad.error)}` : '所有对话正常结束' };
    }
    default:
      return { pass: false, evidence: `未知的检查类型 ${c.type}` };
  }
}

// 每个场景都自动加上的检查（对应所有 agent 都要遵守的规则）
export const DEFAULT_CHECKS = [
  { id: 'runs-completed', rule: null, type: 'completed', desc: '所有对话正常结束（没有报错）' },
  { id: 'no-user-chores', rule: 'no-user-chores', type: 'noUserChores', desc: '不让用户自己去跑、去改、去提交' },
  { id: 'no-trailing-question', rule: 'ask-before-start', type: 'noTrailingQuestion', desc: '回复结尾不提问（要问就开工前用 ask_user）' },
  { id: 'delegated-no-forward', rule: 'delegated-stays-in-lane', type: 'noOwnForward', desc: '总控交接来的 agent 只做自己那一段，不自己往下交接' },
];

/** 给一次运行打分 */
export function gradeRun(scenario, events) {
  const checks = [...(scenario.defaultChecks === false ? [] : DEFAULT_CHECKS.filter((d) => !(scenario.skipDefaults || []).includes(d.id))), ...scenario.checks];
  const results = checks.map((c) => {
    let r;
    try { r = runCheck(c, events); } catch (e) { r = { pass: false, evidence: `检查出错：${e.message}` }; }
    return { id: c.id, rule: c.rule, desc: c.desc, ...r };
  });
  const unscripted = events.filter((e) => e.kind === 'tool' && e.result.startsWith(UNSCRIPTED)).map((e) => `${e.agent}:${e.tool}`);
  return { checks: results, pass: results.every((r) => r.pass), unscripted: [...new Set(unscripted)] };
}
