// 研究流水线 / Agents 页 / 调度者权限 / 交接说明边写边显示：node test/pipeline-agents.test.mjs
// 纯函数部分直接测；服务部分在临时目录起一个真的 server.mjs，用假的 claude 输出 stream-json。
import { mkdtemp, rm, readFile, writeFile, chmod, mkdir, readdir } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { summarizeThread, buildPipeline, projectTimeline } from '../lib/pipeline.mjs';
import { QC_TOOLS, effectiveTools, validateAgentPatch } from '../lib/agents.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-pipe-'));
let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); if (!cond) failed += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(50); } return null; };

/* ---------------- 纯函数 ---------------- */
const mcpSrc = await readFile(path.join(ROOT, 'mcp', 'qc-mcp.mjs'), 'utf8');
const mcpNames = [...mcpSrc.matchAll(/^ {4}name: '([a-z_]+)'/gm)].map((m) => m[1]);
check('工具目录和 qc-mcp 的工具一一对应', JSON.stringify([...mcpNames].sort()) === JSON.stringify(QC_TOOLS.map((t) => t.id).sort()), `mcp ${mcpNames.length} / 目录 ${QC_TOOLS.length}`);

const agents = JSON.parse(await readFile(path.join(ROOT, 'agents.json'), 'utf8'));
const mia = agents.find((a) => a.id === 'mia');
check('总控是调度者，只能写 spec.md', mia.orchestrator === true && JSON.stringify(mia.writeOnly) === '["spec.md"]');
const miaTools = Object.fromEntries(effectiveTools(mia).map((t) => [t.id, t.state]));
check('总控不能跑回测、想法检验、统计检验、标 main', ['create_backtest', 'test_idea', 'validate_backtest', 'update_backtest', 'compile', 'export_signals'].every((t) => miaTools[t] === 'denied'));
check('总控能交接、建项目、读结果', ['handoff', 'create_project', 'read_research', 'read_backtest', 'list_backtests'].every((t) => miaTools[t] === 'allowed') && miaTools.write_file === 'limited');
check('agents.json 里禁用的都是真实存在的工具', agents.every((a) => (a.deniedTools || []).every((t) => QC_TOOLS.some((q) => q.id === t))));
const eng = Object.fromEntries(effectiveTools(agents.find((a) => a.id === 'engineer')).map((t) => [t.id, t.state]));
check('工程师能写代码和回测，删除要「允许删除」', eng.write_file === 'allowed' && eng.create_backtest === 'allowed' && eng.delete_backtest === 'ask');

check('改 agent：不能改 id / 权限', Boolean(validateAgentPatch({ id: 'x' }).error) && Boolean(validateAgentPatch({ deniedTools: [] }).error));
check('改 agent：提示词不能为空', Boolean(validateAgentPatch({ prompt: '   ' }).error));
check('改 agent：模型必须在列表里', Boolean(validateAgentPatch({ model: 'gpt' }, { models: [{ id: 'opus' }] }).error) && validateAgentPatch({ model: 'opus' }, { models: [{ id: 'opus' }] }).patch.model === 'opus');
check('改 agent：模型可以清空（跟随输入框）', validateAgentPatch({ model: '' }).patch.model === null);

const root = {
  id: 't1', agent: 'mia', title: '低波动', createdAt: 1, updatedAt: 5,
  messages: [
    { role: 'user', text: '我有一个想法', at: 1 },
    { role: 'assistant', parts: [
      { kind: 'tool', name: 'mcp__qc__create_project', input: { name: 'x' }, status: 'done', result: '已创建项目「x」，projectId=1007' },
      { kind: 'tool', name: 'mcp__qc__read_project', input: { projectId: 1002 }, status: 'done', result: '' },
      { kind: 'tool', name: 'mcp__qc__handoff', input: { agent: 'researcher', task: '做想法检验', wait: true }, status: 'done', result: '研究员已完成，threadId=t2。它的最终回答：\n\n没有信号' },
      { kind: 'text', text: '结论：没有信号' },
    ], cost: 0.02, duration: 3000 },
  ],
};
const s1 = summarizeThread(root);
check('对话摘要：建的项目优先当作这个任务的项目', s1.projectId === 1007, String(s1.projectId));
check('对话摘要：记下交接给谁、拿到的 threadId', s1.handoffs.length === 1 && s1.handoffs[0].to === 'researcher' && s1.handoffs[0].threadId === 't2');
check('对话摘要：结论取最后一段文字', s1.outcome === '结论：没有信号' && s1.status === 'done');
const broken = summarizeThread({ id: 't3', agent: 'engineer', messages: [{ role: 'user', text: 'x' }, { role: 'assistant', parts: [] }] });
check('对话摘要：被打断、什么都没留下的算「中断」', broken.status === 'stopped');
check('对话摘要：运行中的就是进行中', summarizeThread(root, { running: true }).status === 'running');

const child = { ...summarizeThread({ id: 't2', agent: 'researcher', from: { agent: 'mia', threadId: 't1' }, createdAt: 2, updatedAt: 4, messages: [{ role: 'user', text: '【总控 交接给你的任务】\n\n做想法检验' }, { role: 'assistant', parts: [{ kind: 'text', text: '没有信号' }] }] }) };
child.projectId = 1007; // loadTasks 会让子任务跟着来源对话的项目走
const journal = { entries: [
  { projectId: 1007, projectName: '低波动', stage: '想法检验', outcome: '没有信号', outcomeCode: 'none', date: '2026-11-13T18:36:00Z', key: { label: 'IC t 值', value: 0.43 }, what: '低波动' },
  { projectId: 1001, projectName: '已删除', stage: '开发期回测', outcome: '已删除', outcomeCode: 'deleted', date: '2026-11-01', what: 'x' },
  { projectId: 1002, projectName: 'GEM', stage: '模拟实盘', outcome: '进行中', outcomeCode: 'active', date: '2026-11-06', what: 'p' },
  { projectId: 1002, projectName: 'GEM', stage: '统计检验', outcome: '主版本', outcomeCode: 'main', date: '2026-11-05', what: 'b' },
] };
const projects = [{ projectId: 1007, name: '低波动', modified: '2026-11-13T18:36:00Z' }, { projectId: 1002, name: 'GEM' }, { projectId: 1008, name: '新想法' }];
const pipe = buildPipeline({ journal, projects, tasks: [s1, child], running: [], drafts: [] });
const card = (id) => pipe.cards.find((c) => c.projectId === id);
check('看板：已删除的项目不上看板', !card(1001));
check('看板：没有记录的项目在「想法」列', card(1008) && card(1008).stage === 'idea');
check('看板：想法检验没有信号 → 停在想法检验', card(1007).stage === 'test' && card(1007).status === 'stopped');
check('看板：模拟实盘进行中', card(1002).stage === 'paper' && card(1002).status === 'live' && card(1002).stages[3].gate.state === 'pass');
check('看板：接力链按时间排，子任务带来源', card(1007).relay.map((r) => r.agent).join('>') === 'mia>researcher' && card(1007).relay[1].from.agent === 'mia');
const live = buildPipeline({ journal, projects, tasks: [s1, child], running: [{ threadId: 't2', agent: 'researcher' }], drafts: [{ threadId: 't1', from: 'mia', agent: 'engineer' }] });
check('看板：有 agent 在做 → 进行中，写明是谁', live.cards[0].projectId === 1007 && live.cards[0].status === 'active' && live.cards[0].working[0].agent === 'researcher');
check('看板：正在写交接说明也显示出来', live.cards[0].drafting && live.cards[0].drafting.agent === 'engineer');
const tl = projectTimeline({ journal, tasks: [s1, child], projectId: 1007 });
check('时间线：阶段记录和 agent 任务合在一起', tl.some((e) => e.kind === 'stage') && tl.filter((e) => e.kind === 'task').length === 2);

/* ---------------- 服务 ---------------- */
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
function req(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request(`${BASE}${p}`, { method, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { /* html */ } resolve({ status: res.statusCode, text, json }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
// 订阅一个对话的事件流，收集事件
function stream(threadId) {
  const events = [];
  const r = http.get(`${BASE}/api/threads/${threadId}/stream`, (res) => {
    let buf = ''; res.setEncoding('utf8');
    res.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); const l = b.split('\n').find((x) => x.startsWith('data: ')); if (l) { try { events.push(JSON.parse(l.slice(6))); } catch { /* */ } } } });
  });
  r.on('error', () => {});
  return { events, close: () => r.destroy() };
}

// 假 claude：把参数和环境写下来；然后像真的一样流式写一个交接工具调用的参数（每 150ms 一块），最后结束
const FAKE = path.join(TMP, 'fake-claude.mjs');
const ARGS = path.join(TMP, 'args');
await mkdir(ARGS, { recursive: true });
await writeFile(FAKE, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
const a = process.argv.slice(2);
if (a.includes('--version')) { console.log('0.0.0 (fake)'); process.exit(0); }
writeFileSync(process.env.FAKE_ARGS + '/' + process.env.HELM_AGENT + '.json', JSON.stringify({ args: a, env: { HELM_AGENT: process.env.HELM_AGENT, HELM_WRITE_ONLY: process.env.HELM_WRITE_ONLY } }));
const emit = (o) => console.log(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
emit({ type: 'system', subtype: 'init', session_id: 's', model: 'fake' });
emit({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'mcp__qc__handoff', input: {} } } });
const chunks = ['{"agent":', '"researcher"', ',"task":"', 'x'.repeat(300), '","wait":true}'];
for (const c of chunks) { emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: c } } }); await sleep(450); }
emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } });
emit({ type: 'assistant', message: { content: [{ type: 'text', text: '好' }] } });
emit({ type: 'result', session_id: 's', result: 'ok', total_cost_usd: 0 });
`);
await chmod(FAKE, 0o755);
const AGENTS_FILE = path.join(TMP, 'agents.json');
await writeFile(AGENTS_FILE, JSON.stringify(agents, null, 2));
const THREADS = path.join(TMP, 'threads');
const env = {
  ...process.env, PORT: String(PORT), HELM_PROJECTS_DIR: path.join(TMP, 'projects'), HELM_TRIALS_FILE: path.join(TMP, 'trials.jsonl'),
  HELM_ALPACA_FILE: path.join(TMP, 'secrets', 'alpaca.json'), HELM_THREADS_DIR: THREADS, HELM_MCP_CONFIG: path.join(TMP, 'mcp.json'),
  HELM_AGENTS_FILE: AGENTS_FILE, CLAUDE_BIN: FAKE, FAKE_ARGS: ARGS,
};
const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; server.stdout.on('data', (c) => { log += c; }); server.stderr.on('data', (c) => { log += c; });
const done = async () => { server.kill('SIGTERM'); await rm(TMP, { recursive: true, force: true }); console.log(failed ? `\n${failed} 项失败` : '\n全部通过'); process.exit(failed ? 1 : 0); };

try {
  const up = await until(async () => { try { return (await req('GET', '/api/agents')).status === 200; } catch { return false; } }, 10000);
  check('测试服务已启动', up, up ? '' : log.slice(-300));
  const html = (await req('GET', '/')).text;
  const TOKEN = (html.match(/name="helm-token" content="([a-f0-9]+)"/) || [])[1];
  const H = { 'x-helm-ui-token': TOKEN, Origin: BASE };

  const d = await req('GET', '/api/agents/mia');
  check('GET /api/agents/mia：带提示词、工具和调度者规则', d.status === 200 && d.json.agent.prompt.length > 100 && d.json.tools.length === QC_TOOLS.length && /调度者/.test(d.json.orchestratorPrompt));
  check('PUT 没有页面令牌被拒', (await req('PUT', '/api/agents/risk', { body: { role: '改' } })).status === 403);
  check('PUT 改权限被拒', (await req('PUT', '/api/agents/risk', { headers: H, body: { deniedTools: [] } })).status === 400);
  const put = await req('PUT', '/api/agents/risk', { headers: H, body: { role: '新的定位', model: 'sonnet' } });
  const saved = JSON.parse(await readFile(AGENTS_FILE, 'utf8')).find((a) => a.id === 'risk');
  check('PUT 改定位和模型：写回 agents.json', put.status === 200 && saved.role === '新的定位' && saved.model === 'sonnet');
  check('PUT 之前备份了旧文件', (await readdir(path.join(TMP, 'agents-backups'))).length === 1);
  check('改完立刻生效（/api/agents 是新的）', (await req('GET', '/api/agents')).json.find((a) => a.id === 'risk').role === '新的定位');

  // 给总控发一条消息：看它拿到的权限，以及交接说明边写边显示
  const chat = await req('POST', '/api/chat', { headers: H, body: { agent: 'mia', message: '我有一个想法' } });
  const tid = chat.json && chat.json.threadId;
  check('发消息给总控', chat.status === 200 && Boolean(tid), chat.text.slice(0, 200));
  const st = stream(tid);
  const draftWithAgent = await until(() => st.events.find((e) => e.type === 'draft' && e.agent === 'researcher'), 8000);
  check('交接说明还没写完就推送「正在写交接 → 研究员」', Boolean(draftWithAgent), JSON.stringify(st.events.slice(0, 4)));
  const pipeLive = await until(async () => { const r = await req('GET', '/api/pipeline'); return r.json.running.length ? r.json : null; }, 3000);
  check('运行中 /api/pipeline 列出在工作的 agent', Boolean(pipeLive) && pipeLive.running[0].agent === 'mia');
  await until(() => st.events.find((e) => e.type === 'end'), 10000);
  st.close();
  const grew = st.events.filter((e) => e.type === 'draft' && e.chars > 0).map((e) => e.chars);
  check('写的过程中字数在增加', grew.length >= 2 && grew[grew.length - 1] > grew[0], grew.join(','));
  check('写完后清掉「正在写」', st.events.some((e) => e.type === 'draft' && e.name === null));
  const a = JSON.parse(await readFile(path.join(ARGS, 'mia.json'), 'utf8'));
  const disallowed = a.args.slice(a.args.indexOf('--disallowedTools') + 1);
  check('总控启动时禁用了执行类工具', a.args.includes('--disallowedTools') && ['create_backtest', 'test_idea', 'validate_backtest', 'update_backtest'].every((t) => disallowed.includes(`mcp__qc__${t}`)));
  check('总控的 write_file 名单经环境变量传给 MCP', a.env.HELM_WRITE_ONLY === 'spec.md' && a.env.HELM_AGENT === 'mia');
  const sys = a.args[a.args.indexOf('--append-system-prompt') + 1];
  check('总控的系统提示词带调度者规则', /你是调度者（严格）/.test(sys));
  check('总控知道交接不是绕过规则、不让用户自己动手', /不算绕过/.test(sys) && /不要让用户自己去跑/.test(sys) && /交接是正确做法|这不是绕过权限规则/.test(sys));

  const tasks = await req('GET', '/api/tasks');
  check('/api/tasks 列出刚才的任务', tasks.status === 200 && tasks.json.tasks.some((t) => t.id === tid && t.agent === 'mia'));
  const pipe2 = await req('GET', '/api/pipeline');
  check('/api/pipeline 返回 6 个阶段', pipe2.status === 200 && pipe2.json.stages.length === 6 && pipe2.json.unassigned.some((t) => t.id === tid));

  // MCP：调度者写代码文件被拦下（不碰真实项目：项目目录指到临时目录）
  const mcp = spawn(process.execPath, [path.join(ROOT, 'mcp', 'qc-mcp.mjs')], { env: { ...env, HELM_WRITE_ONLY: 'spec.md' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = ''; mcp.stdout.on('data', (c) => { out += c; });
  const call = (id, name, args) => mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } })}\n`);
  call(1, 'write_file', { projectId: 1, name: 'main.py', content: 'x' });
  call(2, 'create_project', { name: 'x', code: 'print(1)' });
  await until(() => out.includes('"id":1') && out.includes('"id":2'), 5000);
  mcp.kill();
  check('MCP：调度者不能写 main.py', /你只能写 spec\.md/.test(out));
  check('MCP：调度者建项目不能带代码', /你不能写策略代码/.test(out));
} catch (e) {
  check('没有异常', false, e.stack);
}
await done();
