#!/usr/bin/env node
// 行为评测的自检用的假 claude：不调模型，按 EVAL_FAKE_PLAN 里写好的步骤，通过真实的 MCP（qc-mcp.mjs + 工具替身）调工具，
// 输出和真 claude 一样的 stream-json。用来证明：守规则的做法能通过检查，违反规则的做法会被抓住。
//
// 计划文件：{ "<agentId>": [[第 1 次运行的步骤], [第 2 次运行的步骤], ...] }
// 步骤：{ "tool": "handoff", "args": {...} } 或 { "text": "..." }
// args 里的字符串可以用占位符（从工具替身的状态文件里取）：
//   $pid            最近建的项目 id（数字）
//   $bt:<period>[:<role>]  最近一个匹配的回测 id，比如 $bt:dev:candidate
//   $job            最近一次想法检验的 jobId
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log('0.0.0 (eval fake)'); process.exit(0); }
if (argv[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'fake' })); process.exit(0); }

const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
let prompt = '';
for await (const c of process.stdin) prompt += c;

const agent = process.env.HELM_AGENT;
const planFile = process.env.EVAL_FAKE_PLAN;
const plan = planFile ? JSON.parse(readFileSync(planFile, 'utf8')) : {};
const countFile = planFile ? `${planFile}.count.json` : null;
const counts = countFile && existsSync(countFile) ? JSON.parse(readFileSync(countFile, 'utf8')) : {};
const k = counts[agent] || 0;
counts[agent] = k + 1;
if (countFile) writeFileSync(countFile, JSON.stringify(counts));
const steps = ((plan[agent] || [])[k]) || [{ text: `（假 claude：${agent} 第 ${k + 1} 次运行没有计划）` }];

const sid = `fake-${String(process.env.HELM_THREAD_ID || 'x').slice(0, 8)}`;
emit({ type: 'system', subtype: 'init', session_id: sid, model: 'fake-model' });

// MCP 客户端：按 --mcp-config 起工具服务
const cfg = JSON.parse(argv[argv.indexOf('--mcp-config') + 1]);
const srv = cfg.mcpServers.qc;
const mcp = spawn(srv.command, srv.args, { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
const waiting = new Map();
let buf = '';
mcp.stdout.setEncoding('utf8');
mcp.stdout.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    const w = waiting.get(msg.id);
    if (w) { waiting.delete(msg.id); w(msg); }
  }
});
let rid = 0;
const rpc = (method, params) => new Promise((resolve) => { const id = ++rid; waiting.set(id, resolve); mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '0' } });

const state = () => {
  try {
    const fx = JSON.parse(readFileSync(process.env.HELM_EVAL_FIXTURES, 'utf8'));
    return JSON.parse(readFileSync(fx.state, 'utf8'));
  } catch { return { projects: [], backtests: [], research: [] }; }
};
const sub = (v) => {
  if (typeof v === 'string') {
    if (v === '$pid') { const ps = state().projects; return ps.length ? Number(ps[ps.length - 1].projectId) : 0; }
    if (v === '$job') { const js = state().research; return js.length ? js[js.length - 1].jobId : ''; }
    const m = v.match(/^\$bt:([a-z]*)(?::([a-z]+))?$/);
    if (m) { const b = state().backtests.filter((x) => (!m[1] || x.period === m[1]) && (!m[2] || x.role === m[2])).pop(); return b ? b.backtestId : 'missing'; }
    return v;
  }
  if (Array.isArray(v)) return v.map(sub);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, sub(vv)]));
  return v;
};

let n = 0;
for (const s of steps) {
  // { fail: '原因' }：模拟 claude 出错结束（比如账号用不了这个模型）
  if (s.fail !== undefined) { mcp.stdin.end(); emit({ type: 'result', session_id: sid, is_error: true, result: s.fail, total_cost_usd: 0, duration_ms: 1 }); process.exit(0); }
  if (s.text !== undefined) { emit({ type: 'assistant', message: { content: [{ type: 'text', text: s.text }] } }); continue; }
  const id = `toolu_fake_${++n}`;
  const input = sub(s.args || {});
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: `mcp__qc__${s.tool}`, input }] } });
  const r = await rpc('tools/call', { name: s.tool, arguments: input });
  const res = r.result || { content: [{ type: 'text', text: JSON.stringify(r.error) }], isError: true };
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: res.content, is_error: Boolean(res.isError) }] } });
}
mcp.stdin.end();
emit({ type: 'result', session_id: sid, result: 'ok', total_cost_usd: 0, duration_ms: 1 });
process.exit(0);
