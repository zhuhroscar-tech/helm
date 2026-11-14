// 前后端契约测试：node test/contract.test.mjs
// 按 public/app.js 真实发出的请求形状（数字就是数字、布尔就是布尔）逐个打后端，
// 断言：没有 400（校验过严）也没有 5xx。项目 / 回测不存在导致的 404、409、success:false 都算正常。
// 会产生副作用的路由（真跑 agent / LEAN / qlib / Alpaca）不在这里发，列在 SKIPPED 里。
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-contract-'));
let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = await new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const BASE = `http://127.0.0.1:${PORT}`;

function req(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request(`${BASE}${p}`, { method, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// 假 claude：只会打印版本、立刻结束，/api/chat 不会真的调用模型
const FAKE = path.join(TMP, 'fake-claude.mjs');
await writeFile(FAKE, `#!${process.execPath}
if (process.argv.includes('--version')) console.log('0.0.0 (fake)');
else console.log(JSON.stringify({ type: 'result', session_id: 'fake', result: 'ok', total_cost_usd: 0 }));
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
};
const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (c) => { serverLog += c; });
server.stderr.on('data', (c) => { serverLog += c; });
const done = async () => {
  server.kill('SIGTERM');
  await sleep(200);
  await rm(TMP, { recursive: true, force: true });
  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
};

// 有副作用、这里不发的路由
const SKIPPED = [
  'POST /api/actions/backtest',          // 提交真实 LEAN 回测
  'POST /api/actions/research',          // 启动 qlib 研究进程
  'POST /api/actions/idea',              // 启动 agent / 研究
  'POST /api/actions/universe',          // 下载股票池数据
  'POST /api/actions/alpaca-connect',    // 会去连 Alpaca 校验密钥
  'POST /api/actions/paper-start',       // 可能连 Alpaca / 启动模拟盘
  'POST /api/actions/paper-run',         // 拉行情 / 下单
  'POST /api/actions/research-resume',   // 重新拉起研究进程
  'POST /api/actions/signals',           // 调 qlib 导出信号
  'POST /api/actions/sensitivity',       // 启动独立进程，用 LEAN 把每个参数 ±20% 重跑
];

try {
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await req('GET', '/api/agents')).status === 200; } catch { await sleep(100); }
  }
  check('测试服务已启动', up, up ? `port=${PORT}` : serverLog.slice(-400));
  if (!up) await done();
  const page = await req('GET', '/');
  const TOKEN = (page.text.match(/<meta name="helm-token" content="([a-f0-9]{64})">/) || [])[1];
  const H = { 'X-Helm-UI-Token': TOKEN, Origin: BASE, 'Sec-Fetch-Site': 'same-origin' };

  let covered = 0;
  const hit = async (label, method, p, body) => {
    covered += 1;
    let r;
    try { r = await req(method, p, { headers: H, body }); } catch (e) { check(`${label}`, false, e.message); return null; }
    check(`${label}：不是 400 / 5xx`, r.status !== 400 && r.status < 500, `HTTP ${r.status} ${r.text.slice(0, 120)}`);
    return r;
  };

  // 先建一个临时项目，让多数路由走到真实处理函数
  const created = await hit('POST /api/actions/project', 'POST', '/api/actions/project', { name: 'contract', description: '', template: 'momentum' });
  const pid = created && created.json && created.json.projects && created.json.projects[0] && created.json.projects[0].projectId;
  check('临时项目创建成功', Number.isInteger(Number(pid)), JSON.stringify(created && created.json).slice(0, 120));
  const projectId = Number(pid);
  const bt = 'a1b2c3d4e5f60718'; // 不存在的回测 id
  const job = 'abcdef123456';    // 不存在的研究 id
  const sid = 'abcdef123456';    // 不存在的模拟盘 id

  // GET
  for (const p of ['/api/status', '/api/status?refresh=1', '/api/health', '/api/health?refresh=1', '/api/options', '/api/agents', '/api/threads', '/api/threads/nonexistent-thread', '/api/qlib/status']) {
    await hit(`GET ${p}`, 'GET', p);
  }
  await hit('DELETE /api/threads/:id', 'DELETE', '/api/threads/nonexistent-thread');
  // SSE：只看响应头
  covered += 1;
  const sse = await new Promise((resolve) => {
    const r = http.request(`${BASE}/api/events`, { method: 'GET', headers: H }, (res) => { resolve(res.statusCode); res.destroy(); });
    r.on('error', () => resolve('error')); r.end();
    setTimeout(() => resolve('timeout'), 5000);
  });
  check('GET /api/events (EventSource)：200', sse === 200, String(sse));

  const dsr = await hit('GET /api/datasets（自建数据集列表）', 'GET', '/api/datasets');
  check('GET /api/datasets：{ success, datasets: [] }', Boolean(dsr && dsr.status === 200 && dsr.json && dsr.json.success === true && Array.isArray(dsr.json.datasets)), dsr && dsr.text.slice(0, 100));

  // /api/data/*：projectId 数字 / 字符串都试（路由里可能是字符串）
  for (const pidv of [projectId, String(projectId)]) {
    const t = typeof pidv;
    await hit(`data projects/read (${t})`, 'POST', '/api/data/projects/read', { projectId: pidv });
    await hit(`data backtests/list (${t})`, 'POST', '/api/data/backtests/list', { projectId: pidv });
    await hit(`data files/read (${t})`, 'POST', '/api/data/files/read', { projectId: pidv });
    await hit(`data backtests/read (${t})`, 'POST', '/api/data/backtests/read', { projectId: pidv, backtestId: bt });
    await hit(`GET data backtests/spec (${t})`, 'GET', `/api/data/backtests/spec?projectId=${pidv}&backtestId=${bt}`);
    await hit(`GET data backtests/robust (${t})`, 'GET', `/api/data/backtests/robust?projectId=${pidv}&backtestId=${bt}`);
    await hit(`GET data backtests/sensitivity (${t})`, 'GET', `/api/data/backtests/sensitivity?projectId=${pidv}&backtestId=${bt}`);
    await hit(`GET data paper/drift (${t})`, 'GET', `/api/data/paper/drift?projectId=${pidv}&sessionId=pabcdef123456`);
    await hit(`GET data journal (${t})`, 'GET', '/api/data/journal');
    await hit(`GET datasets (${t})`, 'GET', '/api/datasets');
    await hit(`data backtests/chart/read Strategy Equity (${t})`, 'POST', '/api/data/backtests/chart/read', { projectId: pidv, backtestId: bt, name: 'Strategy Equity' });
    await hit(`data backtests/chart/read Benchmark (${t})`, 'POST', '/api/data/backtests/chart/read', { projectId: pidv, backtestId: bt, name: 'Benchmark' });
    await hit(`data backtests/orders/read start/end 数字 (${t})`, 'POST', '/api/data/backtests/orders/read', { projectId: pidv, backtestId: bt, start: 0, end: 500 });
    await hit(`data backtests/log/read start/end 数字 (${t})`, 'POST', '/api/data/backtests/log/read', { projectId: pidv, backtestId: bt, start: 0, end: 2000 });
    await hit(`data backtests/code/read (${t})`, 'POST', '/api/data/backtests/code/read', { projectId: pidv, backtestId: bt });
    await hit(`data backtests/validate (${t})`, 'POST', '/api/data/backtests/validate', { projectId: pidv, backtestId: bt });
  }

  // actions
  await hit('actions/compile', 'POST', '/api/actions/compile', { projectId });
  await hit('actions/backtest-tag (role 字符串)', 'POST', '/api/actions/backtest-tag', { projectId, backtestId: bt, role: 'baseline' });
  await hit('actions/backtest-tag (role null)', 'POST', '/api/actions/backtest-tag', { projectId, backtestId: bt, role: null });
  await hit('actions/research-stop', 'POST', '/api/actions/research-stop', { projectId, jobId: job });
  await hit('actions/paper-stop', 'POST', '/api/actions/paper-stop', { projectId, sessionId: sid });
  await hit('actions/alpaca-disconnect (空体)', 'POST', '/api/actions/alpaca-disconnect', {});

  // qlib / paper 读取
  await hit('qlib/universes (fresh 布尔)', 'POST', '/api/qlib/universes', { fresh: false });
  await hit('qlib/universe-status', 'POST', '/api/qlib/universe-status', { index: 'sp500' });
  await hit('qlib/research/list', 'POST', '/api/qlib/research/list', { projectId });
  await hit('qlib/research/read', 'POST', '/api/qlib/research/read', { projectId, jobId: job });
  await hit('paper/list', 'POST', '/api/paper/list', { projectId });
  await hit('paper/read', 'POST', '/api/paper/read', { projectId, sessionId: sid });
  await hit('alpaca/status (空体)', 'POST', '/api/alpaca/status', {});

  // 聊天（假 claude，不调模型）
  await hit('chat/stop', 'POST', '/api/chat/stop', { threadId: 'nonexistent-thread' });
  const chat = await hit('chat (threadId undefined, model/effort null, context 对象)', 'POST', '/api/chat', { threadId: undefined, agent: 'mia', message: '你好', context: { projectId, tab: 'code' }, allowDanger: false, model: null, effort: null });
  if (chat && chat.json && chat.json.threadId) await hit('GET threads/:id/stream', 'GET', `/api/threads/${chat.json.threadId}`);

  // 最后删除临时项目
  await hit('actions/project-delete', 'POST', '/api/actions/project-delete', { projectId });

  console.log(`覆盖 ${covered} 个请求，跳过 ${SKIPPED.length} 个有副作用的路由：${SKIPPED.join(' | ')}`);
} catch (e) {
  check('测试过程没有异常', false, `${e.stack}\n${serverLog.slice(-600)}`);
}
await done();
