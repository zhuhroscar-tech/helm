// 开工前问用户（mcp__qc__ask_user）：node test/ask-user.test.mjs
// 临时目录起一个真的 server.mjs；假的 claude 照 MCP 工具的做法 POST /api/ask，测试扮演用户在网页上作答。
import { mkdtemp, rm, readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-ask-'));
let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); if (!cond) failed += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(50); } return null; };
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
function req(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request(`${BASE}${p}`, { method, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { /* */ } resolve({ status: res.statusCode, text, json }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

// 假 claude：stdin 里 ASK 后面是 JSON（要问的问题）；先记下启动参数，再问，把回答写到 OUT/<threadId>.json
const FAKE = path.join(TMP, 'fake-claude.mjs');
const OUT = path.join(TMP, 'out'); await mkdir(OUT, { recursive: true });
await writeFile(FAKE, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
const a = process.argv.slice(2);
if (a.includes('--version')) { console.log('0.0.0 (fake)'); process.exit(0); }
let prompt = ''; for await (const c of process.stdin) prompt += c;
const emit = (o) => console.log(JSON.stringify(o));
writeFileSync(process.env.FAKE_OUT + '/' + process.env.HELM_THREAD_ID + '.args.json', JSON.stringify(a));
emit({ type: 'system', subtype: 'init', session_id: 's', model: 'fake' });
const body = JSON.parse(prompt.slice(prompt.indexOf('ASK') + 3));
const r = await fetch(process.env.HELM_URL + '/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-helm-token': process.env.HELM_TOKEN }, body: JSON.stringify({ threadId: process.env.HELM_THREAD_ID, ...body }) });
const j = await r.json();
writeFileSync(process.env.FAKE_OUT + '/' + process.env.HELM_THREAD_ID + '.json', JSON.stringify({ status: r.status, ...j }));
emit({ type: 'assistant', message: { content: [{ type: 'text', text: '好的，开始做' }] } });
emit({ type: 'result', session_id: 's', result: 'ok', total_cost_usd: 0 });
`);
await chmod(FAKE, 0o755);
const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT), HELM_PROJECTS_DIR: path.join(TMP, 'projects'), HELM_TRIALS_FILE: path.join(TMP, 'trials.jsonl'), HELM_ALPACA_FILE: path.join(TMP, 'secrets', 'a.json'),
    HELM_THREADS_DIR: path.join(TMP, 'data', 'threads'), HELM_MCP_CONFIG: path.join(TMP, 'mcp.json'), CLAUDE_BIN: FAKE, FAKE_OUT: OUT, HELM_QUESTION_WAIT_MS: '6000', HELM_CHANGE_ROOT: path.join(TMP, 'repo') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = ''; server.stdout.on('data', (c) => { log += c; }); server.stderr.on('data', (c) => { log += c; });
const out = (tid) => until(async () => { try { return JSON.parse(await readFile(path.join(OUT, `${tid}.json`), 'utf8')); } catch { return null; } }, 20000);
const Q2 = [
  { question: '基准用每月调仓还是买入后不动？', header: '基准', options: [{ label: '每月调仓（推荐）', description: '和策略同频率' }, { label: '买入不动', description: '字面读法' }] },
  { question: '要检验哪些持有天数？', header: '持有', multiSelect: true, options: [{ label: '5 天' }, { label: '20 天' }, { label: '60 天' }] },
];

try {
  const up = await until(async () => { try { return (await req('GET', '/api/agents')).status === 200; } catch { return false; } }, 10000);
  check('测试服务已启动', up, up ? '' : log.slice(-300));
  const TOKEN = ((await req('GET', '/')).text.match(/name="helm-token" content="([a-f0-9]+)"/) || [])[1];
  const H = { 'x-helm-ui-token': TOKEN, Origin: BASE };
  const start = async (agent, body) => (await req('POST', '/api/chat', { headers: H, body: { agent, message: `ASK${JSON.stringify(body)}` } })).json.threadId;
  check('提问接口要 agent 令牌', (await req('POST', '/api/ask', { body: { threadId: 'x', questions: Q2 } })).status === 403);

  // 1) 正常作答：单选 + 多选 + 补充 + 另外一句话
  const t1 = await start('mia', { intro: '有两处会改变结果', questions: Q2 });
  const q1 = await until(async () => (await req('GET', '/api/questions')).json.questions.find((q) => q.threadId === t1 && q.state === 'pending'), 10000);
  check('网页上出现待回答的问题（含选项和说明）', q1 && q1.questions.length === 2 && q1.questions[0].options[0].description === '和策略同频率' && q1.questions[1].multiSelect && q1.intro === '有两处会改变结果');
  const args = JSON.parse(await readFile(path.join(OUT, `${t1}.args.json`), 'utf8'));
  const sys = args[args.indexOf('--append-system-prompt') + 1];
  check('系统提示词：开工前用 ask_user 问，不在结尾问', /开工前问，不在结尾问/.test(sys) && /mcp__qc__ask_user/.test(sys));
  check('自带的 AskUserQuestion 被禁用（-p 下用不了）', args.slice(args.indexOf('--disallowedTools')).includes('AskUserQuestion'));
  check('回答接口要网页令牌', (await req('POST', `/api/questions/${q1.id}`, { body: { skip: true } })).status === 403);
  check('什么都没选不能提交', (await req('POST', `/api/questions/${q1.id}`, { headers: H, body: { answers: [{ selected: [] }, { selected: [] }] } })).status === 400);
  const ans = await req('POST', `/api/questions/${q1.id}`, { headers: H, body: { answers: [{ selected: ['买入不动', '不存在的选项'] }, { selected: ['5 天', '60 天'], other: '再加 120 天' }], freeText: '成本按 10bp' } });
  check('提交回答', ans.status === 200 && ans.json.question.state === 'answered');
  const o1 = await out(t1);
  check('agent 拿到文字版回答（单选只留一个、多选都留、补充和另外的话都在）', o1.status === 200 && o1.text.includes('→ 买入不动') && !o1.text.includes('不存在的选项') && o1.text.includes('5 天、60 天') && o1.text.includes('再加 120 天') && o1.text.includes('成本按 10bp'), o1.text);
  check('重复回答被拒', (await req('POST', `/api/questions/${q1.id}`, { headers: H, body: { skip: true } })).status === 409);

  // 2) 跳过 → 按推荐的做
  const t2 = await start('researcher', { questions: Q2.slice(0, 1) });
  const q2 = await until(async () => (await req('GET', '/api/questions')).json.questions.find((q) => q.threadId === t2 && q.state === 'pending'), 10000);
  await req('POST', `/api/questions/${q2.id}`, { headers: H, body: { skip: true } });
  const o2 = await out(t2);
  check('跳过：agent 按每题第一个（推荐）继续', /跳过/.test(o2.text) && /第一个/.test(o2.text));

  // 3) 没人回答：超时按推荐的做
  const t3 = await start('engineer', { questions: Q2.slice(0, 1) });
  const o3 = await out(t3);
  check('超时：agent 按推荐的继续，并要在总结里说明', /没有回答/.test(o3.text) && /总结/.test(o3.text));

  // 4) 格式不对：直接报错给 agent，不弹卡片
  const t4 = await start('mia', { questions: [{ question: '只有一个选项？', options: [{ label: 'A' }] }] });
  const o4 = await out(t4);
  check('选项少于 2 个：报错给 agent', o4.status === 400 && /2–4 个选项/.test(o4.error));
  const t5 = await start('mia', { questions: [1, 2, 3, 4, 5].map((i) => ({ question: `问题 ${i}？`, options: [{ label: 'A' }, { label: 'B' }] })) });
  const o5 = await out(t5);
  check('超过 4 个问题：报错给 agent', o5.status === 400 && /1–4/.test(o5.error));
} catch (e) {
  check('没有异常', false, e.stack);
}
server.kill('SIGTERM');
await rm(TMP, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
