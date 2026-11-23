// AI 连接（订阅 / API key / 兼容接口）：node test/ai-connect.test.mjs
// 1) lib/ai.mjs：校验、旧 key 沿用规则、启动参数、连接测试、保存（失败不写文件、0600）、apiKeyHelper
// 2) 真的 server.mjs + 假 claude + 本机假「兼容接口」：保存后 agent 进程拿到的环境变量和参数对不对，key 不进环境变量、不回网页
import { mkdtemp, rm, readFile, writeFile, chmod, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as AI from '../lib/ai.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-ai-'));
let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); if (!cond) failed += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(50); } return null; };
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

/* ---------- 本机假接口：只认 GOODKEY，模型只认 good-model ---------- */
const GOOD = 'sk-test-GOODKEY-1234567890';
const seen = [];
const fakeApi = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push({ url: req.url, key: req.headers['x-api-key'], body });
    const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.headers['x-api-key'] !== GOOD) return send(401, { error: { message: 'invalid x-api-key' } });
    if (req.url === '/openai/v1/messages') return send(200, { choices: [] }); // OpenAI 格式的地址：有回应但不是 Messages
    if (req.url !== '/anthropic/v1/messages') return send(404, { error: { message: 'not found' } });
    if (JSON.parse(body || '{}').model !== 'good-model') return send(404, { error: { message: 'model not found' } });
    return send(200, { type: 'message', content: [{ type: 'text', text: 'OK' }] });
  });
});
const API_PORT = await freePort();
await new Promise((r) => fakeApi.listen(API_PORT, '127.0.0.1', r));
const API = `http://127.0.0.1:${API_PORT}`;

/* ---------- 1) lib ---------- */
{
  check('校验：未知方式被拒', AI.normalize({ mode: 'x' }).errors?.length === 1);
  check('校验：auto / subscription 不要 key', AI.normalize({ mode: 'subscription' }).cfg?.mode === 'subscription' && !('apiKey' in AI.normalize({ mode: 'auto', apiKey: 'k' }).cfg));
  check('校验：custom 要完整网址、https、模型名', AI.normalize({ mode: 'custom', apiKey: 'k', baseUrl: 'api.x.com', model: 'm' }).errors
    && AI.normalize({ mode: 'custom', apiKey: 'k', baseUrl: 'http://evil.example.com', model: 'm' }).errors
    && AI.normalize({ mode: 'custom', apiKey: 'k', baseUrl: 'https://a.com/anthropic' }).errors
    && AI.normalize({ mode: 'custom', apiKey: 'k', baseUrl: 'https://a.com/v1/messages', model: 'm' }).errors
    && AI.normalize({ mode: 'custom', apiKey: 'k', baseUrl: 'https://u:p@a.com', model: 'm' }).errors
    && AI.normalize({ mode: 'custom', apiKey: 'k', baseUrl: 'http://localhost:4000/', model: 'm' }).cfg?.baseUrl === 'http://localhost:4000');
  check('校验：key 里有空格被拒', AI.normalize({ mode: 'apiKey', apiKey: 'a b' }).errors?.length === 1);
  const keep = { mode: 'custom', apiKey: 'OLD', baseUrl: 'https://a.com/anthropic', model: 'm' };
  check('key 留空：同一接口沿用旧 key', AI.normalize({ mode: 'custom', baseUrl: 'https://a.com/anthropic/', model: 'm2' }, keep).cfg?.apiKey === 'OLD');
  check('key 留空：换了接口地址不沿用（不把 A 家的 key 发给 B 家）', AI.normalize({ mode: 'custom', baseUrl: 'https://b.com/anthropic', model: 'm' }, keep).errors?.length === 1);
  check('key 留空：换了方式不沿用', AI.normalize({ mode: 'apiKey' }, keep).errors?.length === 1);

  const sub = AI.claudeLaunch({ mode: 'subscription' });
  check('启动：auto 不改任何东西', JSON.stringify(AI.claudeLaunch({ mode: 'auto' })) === JSON.stringify({ unset: [], env: {}, args: [], model: null }));
  check('启动：订阅去掉环境里的 key / 地址，不加 apiKeyHelper', sub.unset.includes('ANTHROPIC_API_KEY') && sub.unset.includes('ANTHROPIC_BASE_URL') && sub.args.length === 0
    && !('ANTHROPIC_API_KEY' in AI.applyLaunchEnv({ ANTHROPIC_API_KEY: 'x', PATH: '/bin' }, sub)));
  const f = path.join(TMP, 'k.json');
  const cus = AI.claudeLaunch({ mode: 'custom', apiKey: GOOD, baseUrl: API, model: 'good-model' }, { file: f });
  const st = JSON.parse(cus.args[1]);
  check('启动：兼容接口设地址、所有模型别名指向用户模型、强制 --model', cus.env.ANTHROPIC_BASE_URL === API && cus.env.ANTHROPIC_DEFAULT_HAIKU_MODEL === 'good-model' && cus.model === 'good-model');
  check('启动：key 不在环境变量和参数里，只在 apiKeyHelper 读的文件里', !JSON.stringify(cus).includes(GOOD) && cus.args[0] === '--settings' && st.apiKeyHelper.includes(f));
  await writeFile(f, JSON.stringify({ apiKey: GOOD }));
  check('apiKeyHelper：打印出 key，别的什么都没有', execFileSync('/bin/sh', ['-c', st.apiKeyHelper]).toString() === GOOD);
  let helperFailed = false; try { execFileSync('/bin/sh', ['-c', st.apiKeyHelper.replace(f, path.join(TMP, 'none.json'))], { stdio: 'pipe' }); } catch { helperFailed = true; }
  check('apiKeyHelper：没有文件时失败退出（不打印空 key）', helperFailed);

  check('测试：错 key → 401 的说法', /密钥无效/.test((await AI.testAi({ mode: 'custom', apiKey: 'bad', baseUrl: `${API}/anthropic`, model: 'good-model' })).error || ''));
  check('测试：错模型 → 404 的说法', /模型名不对/.test((await AI.testAi({ mode: 'custom', apiKey: GOOD, baseUrl: `${API}/anthropic`, model: 'nope' })).error || ''));
  check('测试：OpenAI 格式的地址 → 提示要用兼容 Anthropic 的地址', /不是 Anthropic Messages 格式/.test((await AI.testAi({ mode: 'custom', apiKey: GOOD, baseUrl: `${API}/openai`, model: 'good-model' })).error || ''));
  check('测试：连不上 → 说清楚', /连不上接口/.test((await AI.testAi({ mode: 'custom', apiKey: GOOD, baseUrl: `http://127.0.0.1:${await freePort()}`, model: 'm' })).error || ''));
  check('测试：正确设置通过（max_tokens 1）', (await AI.testAi({ mode: 'custom', apiKey: GOOD, baseUrl: `${API}/anthropic`, model: 'good-model' })).ok && JSON.parse(seen.at(-1).body).max_tokens === 1);
  const fakeFetch = async (url, o) => ({ ok: o.headers['x-api-key'] === GOOD && /\/v1\/models/.test(url), status: o.headers['x-api-key'] === GOOD ? 200 : 401, text: async () => '{}' });
  check('测试：Anthropic key 用 GET /v1/models（不花钱）', (await AI.testAi({ mode: 'apiKey', apiKey: GOOD }, { fetchImpl: fakeFetch })).ok && !(await AI.testAi({ mode: 'apiKey', apiKey: 'bad' }, { fetchImpl: fakeFetch })).ok);

  const sf = path.join(TMP, 'secrets', 'ai.json');
  const bad = await AI.saveAi({ mode: 'custom', apiKey: 'bad', baseUrl: `${API}/anthropic`, model: 'good-model' }, { file: sf });
  check('保存：测试没通过就不写文件', !bad.success && !existsSync(sf), JSON.stringify(bad));
  const ok = await AI.saveAi({ mode: 'custom', apiKey: GOOD, baseUrl: `${API}/anthropic`, model: 'good-model' }, { file: sf });
  check('保存：通过后写入，权限 0600，返回值不带 key', ok.success && ((await stat(sf)).mode & 0o777) === 0o600 && !JSON.stringify(ok).includes(GOOD) && ok.ai.keyHint === '…7890', JSON.stringify(ok));
  await AI.saveAi({ mode: 'subscription' }, { file: sf });
  check('保存：改成订阅后文件里不再有 key', !(await readFile(sf, 'utf8')).includes(GOOD));
}

/* ---------- 2) server ---------- */
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
// 假 claude：auth status 报已登录（带邮箱，测试网页拿不到）；对话时记下环境变量和参数
const FAKE = path.join(TMP, 'fake-claude.mjs');
const OUT = path.join(TMP, 'out'); await mkdir(OUT, { recursive: true });
await writeFile(FAKE, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
const a = process.argv.slice(2);
if (a.includes('--version')) { console.log('0.0.0 (fake)'); process.exit(0); }
if (a[0] === 'auth') { console.log(JSON.stringify({ loggedIn: !process.env.ANTHROPIC_BASE_URL, authMethod: 'claude.ai', email: 'someone@example.com', orgName: 'Secret Org', subscriptionType: 'max' })); process.exit(0); }
let prompt = ''; for await (const c of process.stdin) prompt += c;
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(ANTHROPIC_|CLAUDE_CODE_USE)/.test(k)));
writeFileSync(process.env.FAKE_OUT + '/' + process.env.HELM_THREAD_ID + '.json', JSON.stringify({ args: a, env }));
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'fake' }));
console.log(JSON.stringify({ type: 'result', session_id: 's', result: 'ok', total_cost_usd: 0 }));
`);
await chmod(FAKE, 0o755);
const AI_FILE = path.join(TMP, 'srv-secrets', 'ai.json');
const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT), HELM_PROJECTS_DIR: path.join(TMP, 'projects'), HELM_TRIALS_FILE: path.join(TMP, 'trials.jsonl'), HELM_ALPACA_FILE: path.join(TMP, 'srv-secrets', 'a.json'),
    HELM_AI_FILE: AI_FILE, HELM_THREADS_DIR: path.join(TMP, 'data', 'threads'), HELM_MCP_CONFIG: path.join(TMP, 'mcp.json'), CLAUDE_BIN: FAKE, FAKE_OUT: OUT,
    ANTHROPIC_API_KEY: 'ENV-KEY-FROM-SHELL', ANTHROPIC_BASE_URL: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = ''; server.stdout.on('data', (c) => { log += c; }); server.stderr.on('data', (c) => { log += c; });
try {
  const up = await until(async () => { try { return (await req('GET', '/api/agents')).status === 200; } catch { return false; } }, 10000);
  check('测试服务已启动', up, up ? '' : log.slice(-300));
  const TOKEN = ((await req('GET', '/')).text.match(/name="helm-token" content="([a-f0-9]+)"/) || [])[1];
  const H = { 'x-helm-ui-token': TOKEN, Origin: BASE };
  const chat = async () => {
    const tid = (await req('POST', '/api/chat', { headers: H, body: { agent: 'mia', message: 'hi', model: 'opus' } })).json.threadId;
    return until(async () => { try { return JSON.parse(await readFile(path.join(OUT, `${tid}.json`), 'utf8')); } catch { return null; } });
  };

  const s0 = await req('GET', '/api/ai/status', { headers: H });
  check('状态：默认 auto，登录方式有，邮箱 / 组织名不给网页', s0.json?.ai?.mode === 'auto' && s0.json.login?.ok && s0.json.login.method === 'claude.ai' && !/someone@example|Secret Org/.test(s0.text), s0.text);
  check('状态接口要网页令牌', (await req('GET', '/api/ai/status')).status === 403);
  const h = await req('GET', '/api/health?refresh=1', { headers: H });
  check('健康检查：有 AI 连接这一项', (h.json?.components || []).some((c) => c.id === 'ai' && c.required && c.ok));
  const r0 = await chat();
  check('auto：和以前一样，沿用环境里的 key', r0?.env.ANTHROPIC_API_KEY === 'ENV-KEY-FROM-SHELL' && !r0.args.includes('--settings'));

  const bad = await req('POST', '/api/actions/ai-save', { headers: { ...H, 'X-Helm-Lang': 'en' }, body: { aiMode: 'custom', apiKey: 'wrong', baseUrl: `${API}/anthropic`, aiModel: 'good-model' } });
  check('保存：错 key 不保存，英文界面报英文', bad.json && !bad.json.success && /invalid key/.test(bad.json.errors.join('')) && !existsSync(AI_FILE), bad.text);
  const sv = await req('POST', '/api/actions/ai-save', { headers: H, body: { aiMode: 'custom', apiKey: GOOD, baseUrl: `${API}/anthropic`, aiModel: 'good-model' } });
  check('保存：兼容接口通过，返回值里没有 key', sv.json?.success && sv.json.ai.mode === 'custom' && !sv.text.includes(GOOD), sv.text);
  const r1 = await chat();
  const helper = r1 && JSON.parse(r1.args[r1.args.indexOf('--settings') + 1]).apiKeyHelper;
  check('兼容接口：环境里没有 key（连 shell 里的也去掉了），有地址和模型', r1 && !('ANTHROPIC_API_KEY' in r1.env) && r1.env.ANTHROPIC_BASE_URL === `${API}/anthropic` && r1.env.ANTHROPIC_MODEL === 'good-model', JSON.stringify(r1?.env));
  check('兼容接口：--model 用用户的模型（忽略网页选的 opus）', r1 && r1.args[r1.args.lastIndexOf('--model') + 1] === 'good-model' && r1.args.filter((x) => x === '--model').length === 1);
  check('兼容接口：apiKeyHelper 读得出 key', helper && execFileSync('/bin/sh', ['-c', helper]).toString() === GOOD);
  const keepKey = await req('POST', '/api/actions/ai-save', { headers: H, body: { aiMode: 'custom', baseUrl: `${API}/anthropic`, aiModel: 'good-model' } });
  check('保存：key 留空沿用已保存的', keepKey.json?.success, keepKey.text);
  check('重新测试已保存的连接', (await req('POST', '/api/actions/ai-test', { headers: H, body: {} })).json?.success);

  const sub = await req('POST', '/api/actions/ai-save', { headers: H, body: { aiMode: 'subscription' } });
  check('保存：订阅（假 claude 报已登录）', sub.json?.success && sub.json.login?.ok, sub.text);
  const r2 = await chat();
  check('订阅：环境里没有任何 key 和地址，不加 apiKeyHelper，按网页选的模型', r2 && !('ANTHROPIC_API_KEY' in r2.env) && !('ANTHROPIC_BASE_URL' in r2.env) && !r2.args.includes('--settings') && r2.args[r2.args.indexOf('--model') + 1] === 'opus', JSON.stringify(r2?.env));
  check('改成订阅后，密钥文件里不再有 key', !(await readFile(AI_FILE, 'utf8')).includes(GOOD));
  check('清除：回到 auto', (await req('POST', '/api/actions/ai-clear', { headers: H, body: {} })).json?.ai?.mode === 'auto' && !existsSync(AI_FILE));
} catch (e) {
  check('没有异常', false, e.stack);
}
server.kill('SIGTERM');
fakeApi.close();
await rm(TMP, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
