// 健壮性回归测试（不需要 LEAN、不联网）：node test/robust.test.mjs
// 每一项对应一个修过的问题：全中文项目名、并发写同一个 JSON、backtestId 路径穿越、qlib 引擎启动失败、
// MCP 收到非对象消息、没有 venv 时 LEAN 的报错。项目目录、qlib 引擎目录都指到临时目录，真实数据不碰。
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-robust-'));
process.env.HELM_PROJECTS_DIR = path.join(TMP, 'projects');
process.env.HELM_TRIALS_FILE = path.join(TMP, 'trials.jsonl');
process.env.HELM_ALPACA_FILE = path.join(TMP, 'secrets', 'alpaca.json');
// 假的 qlib 引擎目录：run.sh 存在但没有执行权限，spawn 会失败（EACCES）
process.env.QS_SCRIPTS = path.join(TMP, 'qs');
await mkdir(process.env.QS_SCRIPTS, { recursive: true });
await writeFile(path.join(process.env.QS_SCRIPTS, 'run.sh'), '#!/bin/sh\nexit 0\n');
await chmod(path.join(process.env.QS_SCRIPTS, 'run.sh'), 0o644);

const E = await import('../lib/engine.mjs');
const Q = await import('../lib/qlib.mjs');

let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PD = process.env.HELM_PROJECTS_DIR;

try {
  /* ---- 1. 全中文（没有任何字母数字）的项目名：以前 className 抛 TypeError，项目建到一半没有 main.py ---- */
  let r;
  try { r = await E.createProject({ name: '动量策略' }); } catch (e) { r = { success: false, errors: [`抛出异常：${e.message}`] }; }
  const pid = r.success ? r.projects[0].projectId : null;
  const mainPy = pid ? await readFile(path.join(PD, String(pid), 'main.py'), 'utf8').catch(() => '') : '';
  check('全中文项目名能建项目，main.py 里有 QCAlgorithm 子类', r.success && Boolean(E.findAlgorithmClass(mainPy)), r.success ? E.findAlgorithmClass(mainPy) : r.errors.join(''));
  for (const nm of ['—— ！！', '3 号策略', 'sma 交叉 v2']) {
    let x;
    try { x = await E.createProject({ name: nm }); } catch (e) { x = { success: false, errors: [e.message] }; }
    const code = x.success ? await readFile(path.join(PD, String(x.projects[0].projectId), 'main.py'), 'utf8') : '';
    check(`项目名「${nm}」：类名是合法的 Python 标识符`, x.success && /^[A-Za-z_]\w*$/.test(E.findAlgorithmClass(code) || ''), x.success ? E.findAlgorithmClass(code) : x.errors.join(''));
  }

  /* ---- 2. 并发写同一个 JSON：以前临时文件同名，后一个 rename 报 ENOENT ---- */
  const outs = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => E.updateProject({ projectId: pid, description: `第 ${i} 次` })));
  const bad = outs.filter((o) => o.status === 'rejected' || !o.value.success);
  const pj = JSON.parse(await readFile(path.join(PD, String(pid), 'project.json'), 'utf8'));
  const leftovers = (await readdir(path.join(PD, String(pid)))).filter((f) => f.endsWith('.tmp'));
  check('40 个并发 updateProject 全部成功，project.json 完整，没有残留临时文件', bad.length === 0 && /^第 \d+ 次$/.test(pj.description) && leftovers.length === 0, bad.length ? `${bad.length} 个失败：${bad[0].reason ? bad[0].reason.message : bad[0].value.errors.join('')}` : leftovers.join(' '));

  /* ---- 3. backtestId 路径穿越：结果 / 日志文件名以前直接拼原始 id ---- */
  const bt = path.join(PD, String(pid), 'backtests');
  const hex = 'ab12cd34ef56ab12cd34ef56ab12cd34';
  await mkdir(path.join(bt, hex, 'out'), { recursive: true });
  await writeFile(path.join(bt, hex, 'out', `${hex}.json`), JSON.stringify({ charts: { Good: { ok: 1 } }, orders: {} }));
  await writeFile(path.join(bt, hex, 'out', `${hex}-log.txt`), '正常日志\n');
  // 回测目录之外的文件（穿越的目标）
  await writeFile(path.join(bt, 'leak.json'), JSON.stringify({ charts: { X: { secret: 1 } }, orders: {} }));
  await writeFile(path.join(bt, 'leak-log.txt'), 'SECRET-LINE\n');
  const evil = '../../leak';
  const c1 = await E.chartRead({ projectId: pid, backtestId: evil, name: 'X' });
  const l1 = await E.logRead({ projectId: pid, backtestId: evil });
  const o1 = await E.ordersRead({ projectId: pid, backtestId: evil });
  check('backtestId 带 ../ 读不到回测目录之外的 .json / -log.txt', !c1.success && !l1.success && !o1.success, JSON.stringify([c1.success, l1.success, o1.success]));
  const c2 = await E.chartRead({ projectId: pid, backtestId: hex, name: 'Good' });
  const l2 = await E.logRead({ projectId: pid, backtestId: hex });
  check('正常的十六进制 backtestId 照常读结果和日志', c2.success && c2.chart.ok === 1 && l2.success && l2.logs[0] === '正常日志');

  /* ---- 4. qlib 引擎启动失败（run.sh 不能执行）：返回错误，不能让进程崩掉 ---- */
  const jobId = 'r261111120000ab';
  const rd = path.join(PD, String(pid), 'research');
  await mkdir(path.join(rd, 'jobs'), { recursive: true });
  await writeFile(path.join(rd, 'jobs', `${jobId}.json`), JSON.stringify({ jobId, projectId: pid, title: 't', mode: 'factors', args: ['run'], runDir: path.join(rd, 'quant_runs', `X_${jobId}`), log: path.join(rd, `${jobId}.log`), created: new Date().toISOString() }));
  let crashed = null;
  const onCrash = (e) => { crashed = e; };
  process.on('uncaughtException', onCrash);
  const rs = await Q.resumeResearch({ projectId: pid, jobId });
  const st = await Q.startResearch({ projectId: pid, target: 'QQQ', mode: 'factors' });
  await sleep(300); // spawn 的 error 事件是异步发的，等它出来
  process.off('uncaughtException', onCrash);
  check('run.sh 不能执行：resume_research 返回看得懂的错误', !rs.success && /启动失败/.test(rs.errors.join('')), JSON.stringify(rs.errors || rs.job));
  check('run.sh 不能执行：start_research 返回错误，不留下假的任务', !st.success && /启动失败/.test(st.errors.join('')) && (await Q.listResearch({ projectId: pid })).jobs.length === 1, JSON.stringify(st.errors));
  check('启动失败没有变成未捕获异常（否则整个服务会崩）', crashed === null, crashed ? crashed.message : '');
  const qs = await Q.qlibStatus().catch((e) => ({ error: e.message }));
  check('qlibStatus 带 data / dataDir 字段（体检接口用）', typeof qs.data === 'boolean' && typeof qs.dataDir === 'string', JSON.stringify(qs));

  /* ---- 5. MCP 收到合法 JSON 但不是对象的行：忽略，进程不退出 ---- */
  const mcp = spawn(process.execPath, [path.join(ROOT, 'mcp', 'qc-mcp.mjs')], { env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let mout = ''; let merr = '';
  mcp.stdout.on('data', (c) => { mout += c; });
  mcp.stderr.on('data', (c) => { merr += c; });
  const exited = new Promise((res) => mcp.on('close', (code) => res(code)));
  mcp.stdin.on('error', () => {});
  mcp.stdin.write('null\n123\n"x"\n[1]\n');
  await sleep(400);
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' })}\n`);
  mcp.stdin.end();
  const code = await Promise.race([exited, sleep(15000).then(() => { mcp.kill('SIGKILL'); return 'timeout'; })]);
  check('MCP：null / 数字 / 字符串 / 数组 行之后还能回应 ping，正常退出', code === 0 && /"id":7/.test(mout), `exit=${code} out=${mout.slice(0, 120)} err=${merr.slice(-200)}`);

  /* ---- 6. 没有 venv 时跑 LEAN：报看得懂的错，而不是 Cannot read properties of null ---- */
  check('lintPython：有 venv 用 venv，没有就退回系统 python3', E.lintPython() === (existsSync(E.VENV_PY) ? E.VENV_PY : 'python3'), E.lintPython());
  if (existsSync(E.VENV_PY)) {
    console.log('SKIP  本机装了 engine/.venv，不测「没有 venv」的报错');
  } else {
    let msg = '';
    try { await E.runLean({ algorithmFile: path.join(TMP, 'x.py'), className: 'X', outDir: path.join(TMP, 'out'), id: 'x' }); } catch (e) { msg = e.message; }
    check('没有 venv：runLean 的报错说明缺 engine/.venv', /engine\/\.venv/.test(msg) && !/Cannot read properties/.test(msg), msg);
  }
} catch (e) {
  check('测试过程没有异常', false, e.stack);
} finally {
  await rm(TMP, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
