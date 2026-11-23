// 交接（handoff）端到端测试：node test/handoff-flow.test.mjs
// 在临时目录起一个真的 server.mjs，用假的 claude 输出 stream-json；
// 需要交接时假 claude 自己按 MCP 工具的方式 POST /api/handoff（wait=true / false 都有）。
import { mkdtemp, rm, readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-handoff-'));

let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(50); } return null; };

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;

function req(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request(`${BASE}${p}`, { method, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch { /* html */ }
        resolve({ status: res.statusCode, text, json, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// 订阅 /api/events，把收到的事件都存进 events
function subscribe() {
  const events = [];
  const r = http.get(`${BASE}/api/events`, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = block.split('\n').find((l) => l.startsWith('data: '));
        if (line) { try { events.push(JSON.parse(line.slice(6))); } catch { /* ignore */ } }
      }
    });
  });
  r.on('error', () => {});
  return { events, close: () => r.destroy() };
}

// 假的 claude。prompt 从 stdin 读：
//  - 以「【」开头：是被交接的任务，直接回答（含 SLOW 则先等 1.5 秒，含 HANG 则等 30 秒，用来测「停止」）
//  - 以「PLAN」开头：后面是 JSON 数组，每项是 /api/handoff 的请求体（可用 fromThreadId 覆盖），按 MCP 工具的方式依次 POST，
//    每项前后各输出 tool_use / tool_result 事件，响应写到 OUT/<threadId>.json
const FAKE = path.join(TMP, 'fake-claude.mjs');
const OUT = path.join(TMP, 'out');
await mkdir(OUT, { recursive: true });
await writeFile(FAKE, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
const a = process.argv.slice(2);
if (a.includes('--version')) { console.log('0.0.0 (fake)'); process.exit(0); }
const emit = (o) => console.log(JSON.stringify(o));
let prompt = '';
for await (const c of process.stdin) prompt += c;
const { HELM_URL, HELM_TOKEN, HELM_THREAD_ID } = process.env;
const sid = 'fake-' + HELM_THREAD_ID.slice(0, 8);
emit({ type: 'system', subtype: 'init', session_id: sid, model: 'fake-model' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (prompt.startsWith('【')) {
  if (prompt.includes('SLOW')) await sleep(1500);
  if (prompt.includes('HANG')) await sleep(30000);
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: '子任务完成：' + prompt.split('\\n\\n')[1].slice(0, 30) }] } });
} else if (prompt.startsWith('PLAN')) {
  const plan = JSON.parse(prompt.slice(4));
  const results = [];
  let n = 0;
  for (const item of plan) {
    const id = 'toolu_' + (++n);
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'mcp__qc__handoff', input: item }] } });
    const body = { fromThreadId: HELM_THREAD_ID, ...item };
    const r = await fetch(HELM_URL + '/api/handoff', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-helm-token': item.badToken ? 'x'.repeat(48) : HELM_TOKEN }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    results.push({ status: r.status, body: j });
    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: JSON.stringify(j) }], is_error: !r.ok }] } });
  }
  writeFileSync(process.env.FAKE_OUT_DIR + '/' + HELM_THREAD_ID + '.json', JSON.stringify(results));
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: '交接都发完了' }] } });
} else {
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: '普通回答' }] } });
}
emit({ type: 'result', session_id: sid, result: 'ok', total_cost_usd: 0, duration_ms: 1 });
`);
await chmod(FAKE, 0o755);

const THREADS = path.join(TMP, 'threads');
const env = {
  ...process.env,
  PORT: String(PORT),
  HELM_PROJECTS_DIR: path.join(TMP, 'projects'),
  HELM_TRIALS_FILE: path.join(TMP, 'trials.jsonl'),
  HELM_ALPACA_FILE: path.join(TMP, 'secrets', 'alpaca.json'),
  HELM_THREADS_DIR: THREADS,
  HELM_MCP_CONFIG: path.join(TMP, 'mcp.json'),
  CLAUDE_BIN: FAKE,
  FAKE_OUT_DIR: OUT,
};
const REAL_MCP = path.join(ROOT, 'data', 'mcp.json');
const realMcpBefore = existsSync(REAL_MCP) ? await readFile(REAL_MCP, 'utf8') : null;
const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (c) => { serverLog += c; });
server.stderr.on('data', (c) => { serverLog += c; });

const subs = [];
const done = async () => {
  for (const s of subs) s.close();
  server.kill('SIGTERM');
  const realMcpAfter = existsSync(REAL_MCP) ? await readFile(REAL_MCP, 'utf8') : null;
  check('真实 data/mcp.json 没被测试服务改写', realMcpBefore === realMcpAfter);
  await rm(TMP, { recursive: true, force: true });
  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
};

try {
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await req('GET', '/api/agents')).status === 200; } catch { await sleep(100); }
  }
  check('测试服务已启动', up, up ? `port=${PORT}` : serverLog.slice(-400));
  if (!up) await done();

  const page = await req('GET', '/');
  const TOKEN = (page.text.match(/<meta name="helm-token" content="([a-f0-9]{64})">/) || [])[1];
  check('拿到页面令牌', Boolean(TOKEN));
  const good = { 'X-Helm-UI-Token': TOKEN, Origin: BASE };
  const chat = (agent, message) => req('POST', '/api/chat', { headers: good, body: { agent, message } });
  const planOf = (items) => 'PLAN' + JSON.stringify(items);
  const results = async (tid) => until(async () => { try { return JSON.parse(await readFile(path.join(OUT, `${tid}.json`), 'utf8')); } catch { return null; } });
  const getThread = async (id) => (await req('GET', `/api/threads/${id}`)).json;

  const bus = subscribe(); subs.push(bus);
  await until(() => bus.events.find((e) => e.type === 'hello'));

  /* ---- 1. wait=true：慢子任务，运行中另一个客户端连进来 ---- */
  const t1 = 'SLOW 请帮我检查项目 1 的回测是否有未来函数，给出结论。';
  const c1 = await chat('mia', planOf([{ agent: 'engineer', task: t1, wait: true }]));
  check('POST /api/chat 200', c1.status === 200 && c1.json && c1.json.threadId, `status=${c1.status}`);
  const parentId = c1.json.threadId;
  const childStart = await until(() => bus.events.find((e) => e.type === 'run_start' && e.threadId !== parentId));
  check('总线对子对话发出 run_start', Boolean(childStart));
  check('run_start 带 from（父 agent + 父 threadId）', childStart && childStart.from && childStart.from.agent === 'mia' && childStart.from.threadId === parentId, JSON.stringify(childStart && childStart.from));
  check('run_start 的 agent 是被交接的 agent', childStart && childStart.agent === 'engineer');
  const parentStart = bus.events.find((e) => e.type === 'run_start' && e.threadId === parentId);
  check('父对话 run_start 的 from 为 null', parentStart && parentStart.from === null);
  const childId = childStart.threadId;

  const late = subscribe(); subs.push(late);
  const hello = await until(() => late.events.find((e) => e.type === 'hello'));
  const hc = hello && hello.running.find((r) => r.threadId === childId);
  check('中途连进来的客户端：hello.running 含子对话且带 from', hc && hc.from && hc.from.agent === 'mia' && hc.from.threadId === parentId, JSON.stringify(hello && hello.running));
  const hp = hello && hello.running.find((r) => r.threadId === parentId);
  check('hello.running 里父对话 from 为 null', hp && hp.from === null);

  const childEnd = await until(() => bus.events.find((e) => e.type === 'run_end' && e.threadId === childId));
  check('总线对子对话发出 run_end', Boolean(childEnd) && !childEnd.error, JSON.stringify(childEnd));
  const r1 = await results(parentId);
  check('wait=true 响应 200 且 wait:true', r1 && r1[0].status === 200 && r1[0].body.wait === true && r1[0].body.threadId === childId, JSON.stringify(r1 && r1[0]));
  check('wait=true 响应带子对话最终文字', r1 && /子任务完成/.test(r1[0].body.text || ''), r1 && r1[0].body.text);
  check('wait=true 响应无 error', r1 && !r1[0].body.error);
  await until(async () => bus.events.find((e) => e.type === 'run_end' && e.threadId === parentId));
  const parent = await getThread(parentId);
  const tool = parent && parent.messages.flatMap((m) => m.parts || []).find((p) => p.kind === 'tool' && p.name === 'mcp__qc__handoff');
  check('父对话保存了 handoff 工具块', Boolean(tool));
  check('工具块 status=done 且有 result', tool && tool.status === 'done' && /子任务完成/.test(tool.result || ''), tool && `${tool.status} ${String(tool.result).slice(0, 60)}`);
  const child = await getThread(childId);
  check('子对话 agent / from / depth 正确', child && child.agent === 'engineer' && child.from && child.from.agent === 'mia' && child.from.threadId === parentId && child.depth === 1, child && JSON.stringify({ a: child.agent, f: child.from, d: child.depth }));
  const cu = child && child.messages.find((m) => m.role === 'user');
  check('子对话首条用户消息以【…交接给你的任务】开头并带 from', cu && /^【.+交接给你的任务】/.test(cu.text) && cu.from && cu.from.threadId === parentId, cu && cu.text.slice(0, 30));
  const ca = child && child.messages.find((m) => m.role === 'assistant');
  check('子对话保存了最终回答', ca && ca.parts.some((p) => p.kind === 'text' && /子任务完成/.test(p.text)));

  /* ---- 2. wait=false 立即返回 ---- */
  const c2 = await chat('mia', planOf([{ agent: 'analyst', task: 'SLOW 请把项目 2 的最近一次回测写成一段摘要。', wait: false }]));
  const p2 = c2.json.threadId;
  const r2 = await results(p2);
  const w0 = r2 && r2[0];
  check('wait=false 响应 200，带 threadId，wait:false', w0 && w0.status === 200 && w0.body.wait === false && typeof w0.body.threadId === 'string', JSON.stringify(w0));
  const bgId = w0 && w0.body.threadId;
  const bgRunning = (await req('GET', '/api/threads')).json.find((t) => t.id === bgId);
  check('wait=false：响应时子对话仍在运行（没等它）', bgRunning && bgRunning.running === true);
  check('wait=false 响应没有 text', w0 && w0.body.text === undefined);
  const bgEnd = await until(() => bus.events.find((e) => e.type === 'run_end' && e.threadId === bgId));
  check('wait=false 的子对话之后正常 run_end', Boolean(bgEnd));

  /* ---- 3. 列表 ---- */
  await sleep(200);
  const list = (await req('GET', '/api/threads')).json;
  const li = list.find((t) => t.id === childId);
  check('GET /api/threads 列出子对话并带 from', li && li.from && li.from.agent === 'mia' && li.from.threadId === parentId && li.agent === 'engineer', JSON.stringify(li));
  const lp = list.find((t) => t.id === parentId);
  check('GET /api/threads 里父对话 from 为 null', lp && lp.from === null);

  /* ---- 4. 拒绝 ---- */
  // 造一个 depth=3 的对话：再交接就是第 4 层
  const deepId = 'deep-thread-0001';
  await writeFile(path.join(THREADS, `${deepId}.json`), JSON.stringify({ id: deepId, title: 'deep', agent: 'analyst', depth: 3, sessionId: null, createdAt: 1, updatedAt: 1, messages: [] }));
  const long = '请检查项目 1 的回测并给出结论。';
  const c3 = await chat('mia', planOf([
    { agent: 'nobody', task: long },
    { agent: 'engineer', task: '太短了' },
    { agent: 'mia', task: long },
    { agent: 'engineer', task: long, fromThreadId: deepId },
    { agent: 'engineer', task: long, fromThreadId: 'no-such-thread-id' },
    { agent: 'engineer', task: long, badToken: true },
  ]));
  const r3 = await results(c3.json.threadId);
  const cn = (i) => r3 && r3[i];
  const zh = (s) => /[一-鿿]/.test(s || '');
  check('未知 agent → 400 + 中文原因', cn(0) && cn(0).status === 400 && zh(cn(0).body.error), JSON.stringify(cn(0)));
  check('任务少于 10 字 → 400 + 中文原因', cn(1) && cn(1).status === 400 && zh(cn(1).body.error), JSON.stringify(cn(1)));
  check('交接给自己 → 400 + 中文原因', cn(2) && cn(2).status === 400 && /自己/.test(cn(2).body.error), JSON.stringify(cn(2)));
  check('深度超过 3 → 400 + 中文原因', cn(3) && cn(3).status === 400 && /层/.test(cn(3).body.error), JSON.stringify(cn(3)));
  check('未知 fromThreadId → 400 + 中文原因', cn(4) && cn(4).status === 400 && zh(cn(4).body.error), JSON.stringify(cn(4)));
  check('错误令牌 → 403', cn(5) && cn(5).status === 403, JSON.stringify(cn(5)));
  const noTok = await req('POST', '/api/handoff', { body: { fromThreadId: parentId, agent: 'engineer', task: long } });
  check('没带令牌 → 403', noTok.status === 403);
  const after = (await req('GET', '/api/threads')).json;
  check('被拒绝的交接没有创建新对话', after.filter((t) => t.from).length === 2, `from 数=${after.filter((t) => t.from).length}`);

  /* ---- 5. 被拒绝的交接，父对话里工具块应为 error ---- */
  await until(() => bus.events.find((e) => e.type === 'run_end' && e.threadId === c3.json.threadId));
  const p3 = await getThread(c3.json.threadId);
  const tools3 = p3.messages.flatMap((m) => m.parts || []).filter((p) => p.kind === 'tool');
  check('被拒绝的 handoff 工具块 status=error', tools3.length === 6 && tools3.every((t) => t.status === 'error'), tools3.map((t) => t.status).join(','));

  /* ---- 6. 停掉总控：它用 wait=true 等着的子对话一起停；wait=false 的不受影响 ---- */
  const c6 = await chat('mia', planOf([
    { agent: 'analyst', task: 'HANG 并行任务：给项目 3 写一段摘要，不需要等。', wait: false },
    { agent: 'engineer', task: 'HANG 被等的任务：检查项目 3 的回测有没有未来函数。', wait: true },
  ]));
  const p6 = c6.json.threadId;
  const kids = await until(() => {
    const st = bus.events.filter((e) => e.type === 'run_start' && e.from && e.from.threadId === p6);
    return st.length === 2 ? st : null;
  });
  check('两个子对话都开始了', Boolean(kids));
  const waited = kids && kids.find((e) => e.agent === 'engineer').threadId;
  const parallel = kids && kids.find((e) => e.agent === 'analyst').threadId;
  await sleep(300);
  const t0 = Date.now();
  const st6 = await req('POST', '/api/chat/stop', { headers: good, body: { threadId: p6 } });
  check('停止返回连带停了 2 个（总控 + 被等的子对话）', st6.status === 200 && st6.json.stopped === 2, JSON.stringify(st6.json));
  const endW = await until(() => bus.events.find((e) => e.type === 'run_end' && e.threadId === waited), 8000);
  check('被等的子对话随总控一起停止（不用再到它的对话里停）', endW && endW.stopped === true && Date.now() - t0 < 8000, JSON.stringify(endW));
  const endP = await until(() => bus.events.find((e) => e.type === 'run_end' && e.threadId === p6), 8000);
  check('总控本身停止', endP && endP.stopped === true);
  await sleep(500);
  check('wait=false 的并行子对话仍在运行', !bus.events.some((e) => e.type === 'run_end' && e.threadId === parallel));
  const hello6 = subscribe(); subs.push(hello6);
  const h6 = await until(() => hello6.events.find((e) => e.type === 'hello'));
  check('运行列表里只剩并行子对话', h6 && h6.running.some((r) => r.threadId === parallel) && !h6.running.some((r) => r.threadId === waited || r.threadId === p6), JSON.stringify(h6 && h6.running.map((r) => r.threadId)));
  await req('POST', '/api/chat/stop', { headers: good, body: { threadId: parallel } });
  const endPar = await until(() => bus.events.find((e) => e.type === 'run_end' && e.threadId === parallel), 8000);
  check('并行子对话可以单独停止', endPar && endPar.stopped === true);
} catch (e) {
  check('测试本身没有抛异常', false, e && e.stack);
  console.log(serverLog.slice(-800));
}
await done();
