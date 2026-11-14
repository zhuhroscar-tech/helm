// 服务鉴权与 agent 权限测试：node test/server-auth.test.mjs
// 在临时目录里起一个自己的 server.mjs（随机空闲端口），用假的 claude 可执行文件记录启动参数，不会真的启动 claude。
import { mkdtemp, rm, readFile, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sensitiveReadDenies } from '../lib/agent-perms.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-auth-'));
const HOME = os.homedir();

let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failed += 1;
};

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

// 假的 claude：--version 打印版本；其它情况把参数和环境写到文件，然后输出一条 result 事件
const FAKE = path.join(TMP, 'fake-claude.mjs');
const ARGS_OUT = path.join(TMP, 'claude-args.json');
await writeFile(FAKE, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
const a = process.argv.slice(2);
if (a.includes('--version')) { console.log('0.0.0 (fake)'); process.exit(0); }
writeFileSync(process.env.FAKE_ARGS_OUT, JSON.stringify({ args: a, env: process.env }));
console.log(JSON.stringify({ type: 'result', session_id: 'fake', result: 'ok', total_cost_usd: 0 }));
`);
await chmod(FAKE, 0o755);

const env = {
  ...process.env,
  PORT: String(PORT),
  HELM_PROJECTS_DIR: path.join(TMP, 'projects'),
  HELM_TRIALS_FILE: path.join(TMP, 'trials.jsonl'),
  HELM_ALPACA_FILE: path.join(TMP, 'secrets', 'alpaca.json'),
  HELM_THREADS_DIR: path.join(TMP, 'threads'),
  HELM_MCP_CONFIG: path.join(TMP, 'mcp.json'),
  CLAUDE_BIN: FAKE,
  FAKE_ARGS_OUT: ARGS_OUT,
};
// 真实的 data/mcp.json 不能被测试里起的服务改写（否则正在运行的 Helm 的 agent 会被指到测试环境）
const REAL_MCP = path.join(ROOT, 'data', 'mcp.json');
const realMcpBefore = existsSync(REAL_MCP) ? await readFile(REAL_MCP, 'utf8') : null;
const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (c) => { serverLog += c; });
server.stderr.on('data', (c) => { serverLog += c; });

const done = async () => {
  server.kill('SIGTERM');
  await rm(TMP, { recursive: true, force: true });
  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
};

try {
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await req('GET', '/api/agents')).status === 200; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  check('测试服务已启动', up, up ? `port=${PORT}` : serverLog.slice(-400));
  if (!up) await done();

  /* ---- 令牌注入 ---- */
  const page = await req('GET', '/');
  const m = page.text.match(/<meta name="helm-token" content="([a-f0-9]{64})">/);
  const TOKEN = m && m[1];
  check('index.html 注入了页面令牌', Boolean(TOKEN));
  check('index.html 不缓存', page.headers['cache-control'] === 'no-store', page.headers['cache-control']);
  const again = await req('GET', '/index.html');
  check('/index.html 同样注入令牌', again.text.includes(TOKEN));

  const ORIGIN = `http://127.0.0.1:${PORT}`;
  const good = { 'X-Helm-UI-Token': TOKEN, Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin' };

  /* ---- 正常请求 ---- */
  const proj = await req('POST', '/api/actions/project', { headers: good, body: { name: 'auth-test', template: 'buyhold' } });
  const projectId = proj.json && proj.json.projects && proj.json.projects[0].projectId;
  check('令牌 + Origin 正确：建项目 200', proj.status === 200 && Boolean(projectId), `status=${proj.status}`);
  const comp = await req('POST', '/api/actions/compile', { headers: good, body: { projectId } });
  check('令牌 + Origin 正确：编译 200', comp.status === 200 && comp.json && comp.json.success === true, `status=${comp.status} state=${comp.json && comp.json.state}`);
  const noFetchMeta = await req('POST', '/api/actions/compile', { headers: { 'X-Helm-UI-Token': TOKEN, Origin: `http://localhost:${PORT}` }, body: { projectId } });
  check('没有 Sec-Fetch-Site 头、Origin 用 localhost：200', noFetchMeta.status === 200, `status=${noFetchMeta.status}`);

  /* ---- 被拒绝的请求 ---- */
  const cases = [
    ['不带令牌 → 403', { Origin: ORIGIN }],
    ['错误令牌 → 403', { 'X-Helm-UI-Token': 'f'.repeat(64), Origin: ORIGIN }],
    ['长度不同的令牌 → 403', { 'X-Helm-UI-Token': 'abc', Origin: ORIGIN }],
    ['有令牌但没有 Origin → 403', { 'X-Helm-UI-Token': TOKEN }],
    ['有令牌但 Origin 是别的网站 → 403', { 'X-Helm-UI-Token': TOKEN, Origin: 'http://evil.example' }],
    ['有令牌但 Origin 是 https 同端口 → 403', { 'X-Helm-UI-Token': TOKEN, Origin: `https://127.0.0.1:${PORT}` }],
    ['Sec-Fetch-Site 是 cross-site → 403', { ...good, 'Sec-Fetch-Site': 'cross-site' }],
    ['Sec-Fetch-Site 是 same-site → 403', { ...good, 'Sec-Fetch-Site': 'same-site' }],
  ];
  for (const [name, headers] of cases) {
    const r = await req('POST', '/api/actions/compile', { headers, body: { projectId } });
    check(name, r.status === 403 && /请求被拒绝/.test((r.json && r.json.error) || ''), `status=${r.status}`);
  }
  for (const p of ['/api/actions/paper-start', '/api/actions/paper-stop', '/api/actions/paper-run', '/api/actions/alpaca-connect', '/api/actions/alpaca-disconnect', '/api/chat', '/api/chat/stop', '/api/data/files/read']) {
    const r = await req('POST', p, { body: {} });
    check(`无令牌 POST ${p} → 403`, r.status === 403, `status=${r.status}`);
  }
  const del = await req('DELETE', '/api/threads/abcdef-123456', { headers: { Origin: ORIGIN } });
  check('无令牌 DELETE 对话 → 403', del.status === 403, `status=${del.status}`);
  const ho = await req('POST', '/api/handoff', { headers: { 'X-Helm-UI-Token': TOKEN, Origin: ORIGIN }, body: {} });
  check('handoff 不认网页令牌，只认 HANDOFF_TOKEN → 403', ho.status === 403, `status=${ho.status}`);
  check('Alpaca 密钥文件没有被写入', !existsSync(env.HELM_ALPACA_FILE));

  /* ---- GET 读接口照常 ---- */
  for (const p of ['/api/status', '/api/options', '/api/agents', '/api/threads', '/api/qlib/status', '/app.js', '/styles.css']) {
    const r = await req('GET', p);
    check(`GET ${p} → 200`, r.status === 200, `status=${r.status}`);
  }
  check('测试里起的服务把 MCP 配置写在临时目录，没有动真实的 data/mcp.json', existsSync(env.HELM_MCP_CONFIG) && (existsSync(REAL_MCP) ? await readFile(REAL_MCP, 'utf8') : null) === realMcpBefore);
  /* ---- 安全头：页面有内容安全策略，脚本只能来自本站文件；所有响应不许猜类型、不许被嵌进 iframe ---- */
  {
    const page = await req('GET', '/');
    const csp = String(page.headers['content-security-policy'] || '');
    check('首页带内容安全策略：脚本只许本站、不许内联和 eval', /script-src 'self'(;|$)/.test(csp) && !/script-src[^;]*unsafe/.test(csp) && /default-src 'self'/.test(csp) && /object-src 'none'/.test(csp) && /base-uri 'none'/.test(csp), csp);
    check('内容安全策略：只能连本站接口，不能被别的页面嵌入', /connect-src 'self'(;|$)/.test(csp) && /frame-ancestors 'none'/.test(csp));
    for (const p of ['/', '/app.js', '/calendar.js', '/styles.css', '/api/status', '/api/no-such']) {
      const r = await req('GET', p);
      check(`GET ${p} 带 nosniff / DENY / no-referrer`, r.headers['x-content-type-options'] === 'nosniff' && r.headers['x-frame-options'] === 'DENY' && r.headers['referrer-policy'] === 'no-referrer', JSON.stringify([r.headers['x-content-type-options'], r.headers['x-frame-options']]));
    }
    // 页面本身要守得住这条策略：index.html 里没有内联脚本和 on* 属性，app.js 生成的 HTML 里也没有
    const html = page.text;
    const inlineScript = /<script(?![^>]*\bsrc=)[^>]*>/i.test(html);
    const appJs = (await req('GET', '/app.js')).text;
    const handlers = `${html}\n${appJs}`.match(/<[a-z][^<>]*\son[a-z]+\s*=\s*["'][^"']/gi) || [];
    check('页面没有内联脚本和 on* 事件属性（否则会被策略拦下）', !inlineScript && handlers.length === 0, handlers.slice(0, 3).join(' | '));
    check('app.js 不用 eval / new Function', !/\beval\s*\(|new Function\s*\(/.test(appJs));
    const scripts = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
    const links = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
    check('页面引用的脚本和样式都是本站文件', scripts.length >= 2 && [...scripts, ...links].every((u) => /^\/[a-z0-9.-]+$/.test(u)), [...scripts, ...links].join(' '));
    for (const u of scripts) { const r = await req('GET', u); check(`页面引用的 ${u} 能取到`, r.status === 200 && /javascript/.test(r.headers['content-type'] || '')); }
  }
  const sse = await new Promise((resolve) => {
    http.get(`${BASE}/api/events`, (res) => { res.once('data', (c) => { resolve({ status: res.statusCode, first: String(c) }); res.destroy(); }); });
  });
  check('GET /api/events（SSE）→ 200 且收到 hello', sse.status === 200 && sse.first.includes('"hello"'));

  /* ---- agent 启动参数（假 claude，不真的启动） ---- */
  const chat = await req('POST', '/api/chat', { headers: good, body: { message: '测试权限参数' } });
  check('令牌正确：/api/chat 200', chat.status === 200, `status=${chat.status} ${chat.text.slice(0, 120)}`);
  for (let i = 0; i < 50 && !existsSync(ARGS_OUT); i++) await new Promise((r) => setTimeout(r, 100));
  const spawned = existsSync(ARGS_OUT) ? JSON.parse(await readFile(ARGS_OUT, 'utf8')) : { args: [], env: {} };
  const args = spawned.args;
  const di = args.indexOf('--disallowedTools');
  const ai = args.indexOf('--allowedTools');
  const denied = di >= 0 ? args.slice(di + 1).filter((x) => !x.startsWith('--')) : [];
  const expected = [
    'Read(~/.ssh/**)', `Read(/${HOME}/.ssh/**)`, 'Read(~/.aws/**)', `Read(/${HOME}/.aws/**)`, 'Read(~/.gnupg/**)', 'Read(~/.config/**)',
    'Read(~/.netrc)', 'Read(~/.kube/**)', 'Read(~/.docker/**)', 'Read(~/.npmrc)', 'Read(~/.pypirc)', 'Read(~/Library/**)', `Read(/${HOME}/Library/**)`,
    'Read(~/.claude.json)', 'Read(~/.claude/.credentials.json)', 'Read(~/.claude/projects/*/*.jsonl)',
    'Read(//**/.env)', 'Read(//**/.env.*)',
    `Read(/${ROOT}/data/secrets/**)`, `Read(/${ROOT}/data/threads/**)`, `Read(/${path.dirname(env.HELM_ALPACA_FILE)}/**)`, `Read(/${env.HELM_THREADS_DIR}/**)`,
    'Bash', 'Edit', 'Write', 'mcp__qc__delete_file', // 总控（调度者）：改文件和跑命令直接禁用
  ];
  const missing = expected.filter((r) => !denied.includes(r));
  check('claude 的 --disallowedTools 含全部敏感路径拒绝规则', di > 0 && missing.length === 0, missing.length ? `缺少 ${missing.join(' ')}` : `${denied.length} 条`);
  check('拒绝规则里没有单斜杠开头的“伪绝对路径”', !denied.some((r) => /^Read\(\/[^/]/.test(r)));
  // 只看绝对路径规则：去掉 Read(// 和通配部分，剩下的字面前缀如果是 agent 正常要读的目录的前缀，就是误伤
  const legit = ['projects/1/main.py', 'engine/helm_data.py', 'engine/Lean/Data/equity/usa/daily/spy.zip', 'data/qlib/x.json', 'data/trials.jsonl', 'lib/engine.mjs', 'workspace/CLAUDE.md'].map((f) => path.join(ROOT, f));
  const prefixes = denied.filter((r) => (r.startsWith('Read(//') && !r.startsWith('Read(//**')) || r.startsWith('Read(~/')).map((r) => r.slice(5, -1).replace(/^~\//, `${HOME}/`).replace(/^\/\//, '/').split('*')[0]);
  const hurt = legit.filter((f) => prefixes.some((pre) => pre.endsWith('/') ? f.startsWith(pre) : (f === pre || f.startsWith(`${pre}/`))));
  check('不拒绝 projects/、engine/、lib/、data/qlib、trials.jsonl（agent 正常要读）', hurt.length === 0, hurt.join(' '));
  check('改文件 / 跑命令的审批走 mcp__qc__approve', args[args.indexOf('--permission-prompt-tool') + 1] === 'mcp__qc__approve');
  check('--allowedTools 仍有 Read/Glob/Grep', ai > 0 && ['Read', 'Glob', 'Grep'].every((t) => args.slice(ai, di).includes(t)));
  const envText = JSON.stringify(spawned.env || {});
  check('网页令牌不在 agent 进程的环境变量里', Boolean(TOKEN) && !envText.includes(TOKEN));
  check('agent 进程拿到 handoff 用的 HELM_TOKEN', /^[a-f0-9]{48}$/.test((spawned.env || {}).HELM_TOKEN || ''));

  /* ---- 规则生成函数本身 ---- */
  const rules = sensitiveReadDenies({ home: '/Users/x', root: '/repo', extraDirs: ['/tmp/s'] });
  check('sensitiveReadDenies：home 两种写法 + 绝对路径用 //',
    rules.includes('Read(~/.ssh/**)') && rules.includes('Read(//Users/x/.ssh/**)') && rules.includes('Read(//repo/data/secrets/**)') && rules.includes('Read(//tmp/s/**)'));
  check('sensitiveReadDenies：不整个拒绝 ~/.claude（工具长输出要读回来）', !rules.includes('Read(~/.claude/**)'));
} catch (e) {
  check('测试过程没有异常', false, `${e.stack}\n${serverLog.slice(-600)}`);
}
await done();
