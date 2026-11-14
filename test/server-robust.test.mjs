// 服务健壮性测试：node test/server-robust.test.mjs
// 在临时目录里起一个自己的 server.mjs（随机空闲端口）和假的 claude，不会真的启动 claude，不碰真实项目。
// 覆盖：坏请求体返回 400（不是 500）、agent 输出里被拆开的汉字不乱码、同一个对话并发发送只跑一个、
// /api/handoff 出错不会把服务带崩、/api/health 体检接口。
import { mkdtemp, rm, readFile, writeFile, chmod } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-srv-'));

let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;

// body 是对象就按 JSON 发；raw 是原样发出去的字符串（用来发坏 JSON）
function req(method, p, { headers = {}, body, raw } = {}) {
  return new Promise((resolve, reject) => {
    const data = raw !== undefined ? Buffer.from(raw) : body === undefined ? null : Buffer.from(JSON.stringify(body));
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

// 假的 claude：--version 打印版本；其它情况把环境变量写到文件，然后分两次输出一条中文增量——
// 第一次写到「量」字的第 1 个字节为止，隔 250ms 再写剩下的，模拟一个汉字被拆在两个数据块里
const SAY = '动量策略回测完成';
const FAKE = path.join(TMP, 'fake-claude.mjs');
const ENV_OUT = path.join(TMP, 'claude-env.json');
await writeFile(FAKE, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
const a = process.argv.slice(2);
if (a.includes('--version')) { console.log('0.0.0 (fake)'); process.exit(0); }
writeFileSync(process.env.FAKE_ENV_OUT, JSON.stringify(process.env));
const line = Buffer.from(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ${JSON.stringify(SAY)} } } }) + '\\n');
const cut = line.indexOf(Buffer.from('量')) + 1;
process.stdout.write(line.subarray(0, cut));
setTimeout(() => {
  process.stdout.write(line.subarray(cut));
  setTimeout(() => { console.log(JSON.stringify({ type: 'result', session_id: 'fake', result: 'ok', total_cost_usd: 0 })); }, 250);
}, 250);
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
  FAKE_ENV_OUT: ENV_OUT,
};
const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
let serverExit = null;
server.stdout.on('data', (c) => { serverLog += c; });
server.stderr.on('data', (c) => { serverLog += c; });
server.on('close', (code) => { serverExit = code; });

const done = async () => {
  server.kill('SIGTERM');
  await rm(TMP, { recursive: true, force: true });
  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
};
const waitIdle = async (threadId) => {
  for (let i = 0; i < 100; i++) {
    const t = await req('GET', `/api/threads/${threadId}`);
    if (t.json && t.json.running === false) return t.json;
    await sleep(100);
  }
  return null;
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
  const good = { 'X-Helm-UI-Token': TOKEN, Origin: BASE, 'Sec-Fetch-Site': 'same-origin' };

  /* ---- 坏请求：400 + 看得懂的话，不是 500 + JSON.parse 的内部报错 ---- */
  const badJson = await req('POST', '/api/actions/compile', { headers: good, raw: '{"projectId": 1' });
  check('请求体不是合法 JSON：400，中文说明', badJson.status === 400 && /不是合法的 JSON/.test((badJson.json || {}).error || ''), `status=${badJson.status} ${badJson.text.slice(0, 120)}`);
  for (const raw of ['null', '[1,2]', '"x"', '42']) {
    const r = await req('POST', '/api/data/files/read', { headers: good, raw });
    check(`请求体是 ${raw}（不是对象）：400`, r.status === 400 && /JSON 对象/.test((r.json || {}).error || ''), `status=${r.status} ${r.text.slice(0, 120)}`);
  }
  const noAuth = await req('POST', '/api/actions/compile', { raw: '{bad' });
  check('没有令牌的坏请求仍然先被 403 挡住', noAuth.status === 403, `status=${noAuth.status}`);
  const badPath = await req('GET', '/%E0%A4%A');
  check('路径里有坏的 % 编码：400', badPath.status === 400, `status=${badPath.status}`);

  /* ---- /api/health ---- */
  const h = await req('GET', '/api/health');
  const hj = h.json || {};
  const ids = (hj.components || []).map((c) => c.id);
  const want = ['claude', 'dotnet', 'lean', 'python', 'libpython', 'priceData', 'qlib', 'qlibData'];
  check('/api/health：200，列出全部检查项', h.status === 200 && want.every((id) => ids.includes(id)), `status=${h.status} ${ids.join(',')}`);
  const shapeOk = (hj.components || []).every((c) => typeof c.ok === 'boolean' && typeof c.required === 'boolean' && typeof c.zh === 'string' && typeof c.detail === 'string' && (c.ok ? c.hint === null : typeof c.hint === 'string' && c.hint.length > 0));
  check('/api/health：每项有 ok / required / zh / detail，没就绪的带 hint', shapeOk, JSON.stringify((hj.components || []).find((c) => typeof c.detail !== 'string') || ''));
  const reqMissing = (hj.components || []).filter((c) => c.required && !c.ok).map((c) => c.id);
  check('/api/health：ok 和 missing 只看必需项，可选项进 optionalMissing', hj.ok === (reqMissing.length === 0) && JSON.stringify(hj.missing) === JSON.stringify(reqMissing) && Array.isArray(hj.optionalMissing) && hj.optionalMissing.every((id) => !hj.components.find((c) => c.id === id).required), JSON.stringify({ ok: hj.ok, missing: hj.missing, optionalMissing: hj.optionalMissing }));
  check('/api/health：详情里不带用户主目录的绝对路径', !(h.text || JSON.stringify(hj)).includes(os.homedir()), os.homedir());
  check('/api/health：假的 claude 可用', (hj.components.find((c) => c.id === 'claude') || {}).ok === true && /fake/.test(hj.components.find((c) => c.id === 'claude').detail));
  const st = await req('GET', '/api/status');
  check('/api/health 和 /api/status 的引擎结论一致', st.json && want.slice(1, 5).every((id) => st.json.engine.missing.includes(id) === hj.missing.includes(id)), JSON.stringify(st.json && st.json.engine));
  const hPost = await req('POST', '/api/health', { body: {} });
  check('/api/health 只读：POST 没有令牌 403', hPost.status === 403, `status=${hPost.status}`);

  /* ---- agent 输出里一个汉字被拆在两个数据块里：不能变成乱码 ---- */
  const chat = await req('POST', '/api/chat', { headers: good, body: { message: '你好' } });
  const threadId = chat.json && chat.json.threadId;
  check('发消息：200，拿到 threadId', chat.status === 200 && Boolean(threadId), `status=${chat.status} ${chat.text.slice(0, 120)}`);
  const t1 = await waitIdle(threadId);
  const said = t1 && t1.messages[1] && t1.messages[1].parts.filter((x) => x.kind === 'text').map((x) => x.text).join('');
  check('被拆开的汉字完整还原（没有 U+FFFD）', said === SAY, JSON.stringify(said));

  /* ---- 同一个对话并发发两条：只能跑一个，另一个 409 ---- */
  const [a, b] = await Promise.all([
    req('POST', '/api/chat', { headers: good, body: { message: '第二条', threadId } }),
    req('POST', '/api/chat', { headers: good, body: { message: '第二条', threadId } }),
  ]);
  const codes = [a.status, b.status].sort();
  check('同一个对话并发发送：一个 200、一个 409', codes[0] === 200 && codes[1] === 409, `${codes.join(',')} ${a.text.slice(0, 80)} ${b.text.slice(0, 80)}`);
  const t2 = await waitIdle(threadId);
  check('并发之后对话里只多了一问一答', t2 && t2.messages.length === 4, t2 ? `messages=${t2.messages.length}` : '对话没有结束');

  /* ---- /api/handoff 里出错：返回错误，服务不能崩 ---- */
  const HANDOFF = JSON.parse(await readFile(ENV_OUT, 'utf8')).HELM_TOKEN;
  const ho = await req('POST', '/api/handoff', { headers: { 'x-helm-token': HANDOFF }, raw: '{"agent": ' });
  check('/api/handoff 收到坏 JSON：400', ho.status === 400, `status=${ho.status} ${ho.text.slice(0, 120)}`);
  await sleep(200);
  const alive = await req('GET', '/api/agents').catch((e) => ({ status: 0, text: e.message }));
  check('之后服务还活着', alive.status === 200 && serverExit === null, `status=${alive.status} exit=${serverExit} ${serverLog.slice(-300)}`);
  /* ---- 输入校验审计：每个 POST 路由，类型不对 / 缺字段 / 太长 / projectId 不是整数 → 400，绝不是 500 ---- */
  const POSTS = ['/api/data/projects/read', '/api/data/files/read', '/api/data/backtests/list', '/api/data/backtests/read', '/api/data/backtests/chart/read', '/api/data/backtests/orders/read',
    '/api/data/backtests/log/read', '/api/data/backtests/code/read', '/api/data/backtests/validate',
    '/api/actions/project', '/api/actions/project-delete', '/api/actions/compile', '/api/actions/backtest', '/api/actions/backtest-tag',
    '/api/qlib/universes', '/api/qlib/universe-status', '/api/qlib/research/list', '/api/qlib/research/read', '/api/qlib/signals', '/api/qlib/holdouts',
    '/api/actions/universe', '/api/actions/research', '/api/actions/idea', '/api/actions/research-stop', '/api/actions/research-resume',
    '/api/paper/list', '/api/paper/read', '/api/alpaca/status', '/api/actions/paper-start', '/api/actions/paper-stop', '/api/actions/paper-run',
    '/api/actions/alpaca-connect', '/api/actions/alpaca-disconnect', '/api/actions/signals', '/api/chat', '/api/chat/stop'];
  const LONG = 'y'.repeat(300000);
  const BADS = [
    ['缺字段', {}, null],
    ['projectId 是小数', { projectId: 1.5, backtestId: 'abcdef123456', jobId: 'r1', sessionId: 'p1', index: 'sp500', name: 'a', message: 'hi', keyId: 'k', secret: 's', threadId: 'abcdef12' }, /projectId/],
    ['projectId 是字符串', { projectId: 'abc', backtestId: 'abcdef123456', jobId: 'r1', sessionId: 'p1', index: 'sp500', name: 'a', message: 'hi', keyId: 'k', secret: 's', threadId: 'abcdef12' }, /projectId/],
    ['projectId 是对象', { projectId: { a: 1 }, backtestId: 'abcdef123456', jobId: 'r1', sessionId: 'p1', index: 'sp500', name: 'a', message: 'hi', keyId: 'k', secret: 's', threadId: 'abcdef12' }, /projectId/],
    ['名字是数字', { projectId: 1001, name: 12, message: 12, backtestId: 12, jobId: 12, sessionId: 12, index: 12, keyId: 12, secret: 12, threadId: 12 }, /必须是字符串/],
    ['名字太长', { projectId: 1001, name: 'n'.repeat(500), message: LONG, backtestId: 'b'.repeat(500), jobId: 'j'.repeat(500), sessionId: 's'.repeat(500), index: 'i'.repeat(500), keyId: 'k'.repeat(500), secret: 's'.repeat(500), threadId: 't'.repeat(500) }, /太长/],
    ['数组 / 布尔 / 数字类型错', { projectId: 1001, tickers: { a: 1 }, factors: 'x', horizons: 5, full: 'yes', fresh: 1, capital: 'lots', costBps: [1], holdoutYears: {}, backtestId: 'abcdef123456', jobId: 'r1', sessionId: 'p1', index: 'sp500', name: 'a', message: 'hi', keyId: 'k', secret: 's', threadId: 'abcdef12', context: [1] }, /必须是/],
  ];
  const bad500 = []; const not400 = [];
  for (const route of POSTS) {
    for (const [label, body, re] of BADS) {
      const r = await req('POST', route, { headers: good, body });
      if (r.status >= 500) bad500.push(`${route} ${label} -> ${r.status} ${r.text.slice(0, 80)}`);
      else if (re && r.status !== 400 && !(route === '/api/qlib/universes' || route === '/api/qlib/signals' || route === '/api/qlib/holdouts' || route === '/api/alpaca/status' || route === '/api/actions/alpaca-disconnect' || route === '/api/paper/list')) not400.push(`${route} ${label} -> ${r.status}`);
      if (r.status === 400 && !/[\u4e00-\u9fa5]/.test((r.json || {}).error || '')) not400.push(`${route} ${label}: 400 但没有中文说明 ${r.text.slice(0, 60)}`);
    }
  }
  check(`${POSTS.length} 个 POST 路由 × ${BADS.length} 种坏输入：没有 500`, bad500.length === 0, bad500.slice(0, 3).join(' | '));
  check('坏输入返回 400 + 中文说明（需要这些字段的路由）', not400.length === 0, not400.slice(0, 3).join(' | '));
  const miss = await req('POST', '/api/actions/project', { headers: good, body: { description: 'x' } });
  check('新建项目缺 name：400 缺少必填字段', miss.status === 400 && /缺少必填字段 name/.test(miss.json.error), miss.text.slice(0, 100));
  // 服务端在读完之前就回 413 并断开，客户端可能先看到连接被重置，两种都算挡住了
  const big = await req('POST', '/api/actions/project', { headers: good, raw: JSON.stringify({ name: 'a', description: 'z'.repeat(2_100_000) }) }).catch((e) => ({ status: e.code }));
  check('请求体超过 2MB：413（或连接被断开）', big.status === 413 || big.status === 'ECONNRESET' || big.status === 'EPIPE', `status=${big.status}`);
  await sleep(200); // 413 之后服务端会关掉那条连接，等客户端的连接池清掉它
  const okProj = await req('POST', '/api/actions/project', { headers: good, body: { name: '校验后的正常项目' } }).catch(() => req('POST', '/api/actions/project', { headers: good, body: { name: '校验后的正常项目' } }));
  check('合法请求不受影响', okProj.status === 200 && okProj.json.success === true, okProj.text.slice(0, 100));

  /* ---- /api/health 的提示：能复制粘贴的中文操作，和 README 的安装步骤一致 ---- */
  const HINT_MUST = { dotnet: /dotnet-install\.sh.*--channel 10\.0.*~\/\.dotnet/, lean: /git clone --depth 1 https:\/\/github\.com\/QuantConnect\/Lean\.git engine\/Lean.*dotnet build engine\/Lean\/Launcher\/QuantConnect\.Lean\.Launcher\.csproj -c Release/, python: /uv venv --python 3\.11 engine\/\.venv.*uv pip install --python engine\/\.venv\/bin\/python numpy==1\.26\.4/, libpython: /uv venv --python 3\.11 engine\/\.venv/, claude: /claude --version.*CLAUDE_BIN/, qlib: /run\.sh --which-python/, qlibData: /us_data/ };
  const hp = await req('GET', '/api/health?refresh=1');
  const hc = hp.json.components;
  const hintBad = Object.entries(HINT_MUST).filter(([id, re]) => { const c = hc.find((x) => x.id === id); return !c || c.ok || !/[\u4e00-\u9fa5]/.test(c.hint) ? false : !re.test(c.hint); }).map(([id]) => id);
  check('/api/health：没就绪的项，hint 里有 README 里的命令', hintBad.length === 0, hintBad.join(','));
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 20 }, () => req('GET', '/api/health')));
  check('/api/health 连发 20 次（有缓存）很快返回', Date.now() - t0 < 3000, `${Date.now() - t0}ms`);

  /* ---- 生命周期：端口被占用 → 友好提示；SIGTERM → 关闭事件流、正常退出 ---- */
  const dup = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let dupLog = ''; dup.stdout.on('data', (c) => { dupLog += c; }); dup.stderr.on('data', (c) => { dupLog += c; });
  const dupCode = await new Promise((res) => { dup.on('close', res); setTimeout(() => { dup.kill('SIGKILL'); res('timeout'); }, 10000); });
  check('端口被占用：退出码 1，提示 Helm 可能已经在运行 + 地址', dupCode === 1 && /已被占用/.test(dupLog) && /可能已经在运行/.test(dupLog) && dupLog.includes(`http://localhost:${PORT}`) && !/at .*node:/.test(dupLog), `exit=${dupCode} ${dupLog.slice(-200)}`);
  check('启动信息里有访问地址', serverLog.includes(`http://localhost:${PORT}`), serverLog.slice(0, 150));
  const sse = await new Promise((resolve) => {
    const r = http.request(`${BASE}/api/events`, { method: 'GET' }, (res) => { res.on('data', () => {}); res.on('end', () => resolve('ended')); res.on('error', () => resolve('error')); });
    r.on('error', () => resolve('error')); r.end();
    setTimeout(async () => { server.kill('SIGTERM'); }, 400);
    setTimeout(() => resolve('hung'), 8000);
  });
  await sleep(300);
  check('SIGTERM：事件流被关闭（不挂起），进程正常退出（码 0）', sse !== 'hung' && serverExit === 0 && /正在关闭/.test(serverLog), `sse=${sse} exit=${serverExit} ${serverLog.slice(-200)}`);
} catch (e) {
  check('测试过程没有异常', false, `${e.stack}\n${serverLog.slice(-600)}`);
}
await done();
