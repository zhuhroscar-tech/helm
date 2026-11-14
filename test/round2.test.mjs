// 第二轮后端加固回归测试（不需要 LEAN、不联网）：node test/round2.test.mjs
// 覆盖：并发建项目编号不重复、stopResearch 不误杀复用 pid、下载失败时回测提前失败（本地有数据则容忍）、
// 信号/股票池过期保护（Python + 运行前警告）、MCP 工具参数校验（表驱动）。
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-r2-'));
process.env.HELM_PROJECTS_DIR = path.join(TMP, 'projects');
process.env.HELM_TRIALS_FILE = path.join(TMP, 'trials.jsonl');
process.env.HELM_ALPACA_FILE = path.join(TMP, 'secrets', 'alpaca.json');
process.env.QS_SCRIPTS = path.join(TMP, 'qs');
await mkdir(process.env.QS_SCRIPTS, { recursive: true });
await writeFile(path.join(process.env.QS_SCRIPTS, 'run.sh'), '#!/bin/sh\nexit 0\n');

const E = await import('../lib/engine.mjs');
const Q = await import('../lib/qlib.mjs');
const PD = process.env.HELM_PROJECTS_DIR;
let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

try {
  /* ---- 1. 并发建项目：编号不重复 ---- */
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => E.createProject({ name: `并发 ${i}` })));
  const ids = rs.map((r) => r.success && r.projects[0].projectId);
  check('12 个并发 createProject 全部成功且编号互不相同', ids.every(Boolean) && new Set(ids).size === 12, ids.join(','));
  // 另一个“进程”（这里用直接 mkdir 模拟）抢先占了下一个编号：EEXIST 后要重算，不能覆盖
  const next = Math.max(...ids) + 1;
  await mkdir(path.join(PD, String(next)));
  await writeFile(path.join(PD, String(next), 'project.json'), '{"mine":true}');
  const r13 = await E.createProject({ name: '抢号后' });
  check('编号已被占用的目录不会被覆盖', r13.success && r13.projects[0].projectId > next && JSON.parse(await readFile(path.join(PD, String(next), 'project.json'), 'utf8')).mine === true);

  /* ---- 2. stopResearch：pid 对不上就不杀 ---- */
  const pid = ids[0];
  const jobsDir = path.join(PD, String(pid), 'research', 'jobs');
  await mkdir(jobsDir, { recursive: true });
  const mkJob = (jobId, child, extra) => writeFile(path.join(jobsDir, `${jobId}.json`), JSON.stringify({ jobId, projectId: pid, title: 't', mode: 'factors', args: [], runDir: path.join(TMP, 'run'), log: path.join(TMP, 'x.log'), created: new Date().toISOString(), pid: child.pid, ...extra }));
  const spawnSleep = () => { const c = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' }); c.unref(); return c; };
  const reaped = (c) => new Promise((res) => { c.on('exit', () => res(true)); setTimeout(() => res(false), 3000); });
  const c1 = spawnSleep();
  await mkJob('r261111120001aa', c1, { pidStart: 'Mon Jan  1 00:00:00 2001' });
  const s1 = await Q.stopResearch({ projectId: pid, jobId: 'r261111120001aa' });
  await sleep(300);
  const j1 = JSON.parse(await readFile(path.join(jobsDir, 'r261111120001aa.json'), 'utf8'));
  check('启动时间对不上：不杀进程，任务标成已过期', s1.success && s1.stopped === false && s1.stale === true && isAlive(c1.pid) && j1.stale === true, JSON.stringify(s1));
  const view = await Q.readResearch({ projectId: pid, jobId: 'r261111120001aa' });
  check('过期的任务显示为已停止，不是运行中', view.success && view.job.status !== 'running', view.job && view.job.status);
  const c2 = spawnSleep();
  await mkJob('r261111120002aa', c2, {}); // 老任务文件没有 pidStart，命令行里也没有 run.sh
  const s2 = await Q.stopResearch({ projectId: pid, jobId: 'r261111120002aa' });
  await sleep(300);
  check('没有启动时间记录、命令行也不是研究引擎：不杀', s2.stale === true && isAlive(c2.pid));
  const c3 = spawnSleep();
  await sleep(100);
  const info = await Q.procInfo(c3.pid);
  await mkJob('r261111120003aa', c3, { pidStart: info && info.start });
  const gone = reaped(c3);
  const s3 = await Q.stopResearch({ projectId: pid, jobId: 'r261111120003aa' });
  check('启动时间对得上：正常停止', Boolean(info) && s3.stopped === true && (await gone), JSON.stringify(s3));
  for (const c of [c1, c2]) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* ok */ } }

  /* ---- 3. 下载整体失败：缺数据就提前失败并点名，本地有数据则容忍 ---- */
  const mkBacktest = async (code) => {
    const bid = [...Array(16)].map(() => 'abcdef0123456789'[Math.floor(Math.random() * 16)]).join('');
    const dir = path.join(PD, String(pid), 'backtests', bid);
    await mkdir(path.join(dir, 'code'), { recursive: true });
    await writeFile(path.join(dir, 'code', 'main.py'), code);
    await writeFile(path.join(dir, 'meta.json'), JSON.stringify({ backtestId: bid, projectId: pid, name: 'x', status: 'In Queue', created: new Date().toISOString() }));
    return { bid, meta: async () => JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8')) };
  };
  const CODE = 'from AlgorithmImports import *\nclass A(QCAlgorithm):\n    def initialize(self):\n        self.add_equity("ZZZQ", Resolution.DAILY)\n        self.add_equity("SPY", Resolution.DAILY)\n';
  const hooks0 = { ...E._hooks };
  E._hooks.fetchData = async () => ({ results: [], error: 'Traceback: 网络不通' });
  E._hooks.hasLocalData = (t) => t === 'SPY';
  const b1 = await mkBacktest(CODE);
  await E.runBacktestJob(pid, b1.bid);
  const m1 = await b1.meta();
  check('下载整体失败且 ZZZQ 本地没有数据：回测提前失败，点名 ZZZQ，不提 SPY', m1.status === 'Runtime Error' && /缺少回测必需的行情数据：ZZZQ/.test(m1.error) && !/：.*SPY.*。本地/.test(m1.error), m1.error);
  E._hooks.fetchData = async () => ({ results: [{ ticker: 'ZZZQ', status: 'error', error: 'Yahoo 没有这个代码的数据' }, { ticker: 'SPY', status: 'cached', start: '2000-01-01', end: '2026-01-01' }] });
  const b2 = await mkBacktest(CODE);
  await E.runBacktestJob(pid, b2.bid);
  const m2 = await b2.meta();
  check('单个代码下载失败、本地也没有：同样提前失败', /缺少回测必需的行情数据：ZZZQ/.test(m2.error || ''), m2.error);
  E._hooks.hasLocalData = () => true;
  const b3 = await mkBacktest(CODE);
  await E.runBacktestJob(pid, b3.bid);
  const m3 = await b3.meta();
  check('本地有旧数据：容忍下载失败，只记警告，继续往下跑', !/缺少回测必需/.test(m3.error || '') && (m3.dataWarnings || []).some((w) => /ZZZQ/.test(w)), `${m3.error} | ${(m3.dataWarnings || []).join(';')}`);
  Object.assign(E._hooks, hooks0);

  /* ---- 4. 数据过期：Python 端返回空并只警告一次；运行前警告 ---- */
  const dd = path.join(TMP, 'ldata');
  await mkdir(path.join(dd, 'helm', 'signals'), { recursive: true });
  await mkdir(path.join(dd, 'helm', 'universes'), { recursive: true });
  await writeFile(path.join(dd, 'helm', 'signals', 'sg_test.csv'), 'date,ticker,score\n2024-01-02,A,1\n2024-01-03,B,2\n');
  await writeFile(path.join(dd, 'helm', 'signals', 'sg_test.json'), JSON.stringify({ segments: { dev: { start: '2023-01-01', end: '2024-01-03' } } }));
  await writeFile(path.join(dd, 'helm', 'universes', 'u_test.csv'), 'ticker,start,end\nA,2020-01-01,2024-01-03\n');
  await writeFile(path.join(dd, 'helm', 'universes', 'u_test.json'), JSON.stringify({ end: '2024-01-03' }));
  const py = `
import sys
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'engine'))})
import helm_data as h
s = h.HelmSignals("sg_test"); u = h.HelmUniverse("u_test")
assert s.last_date == "2024-01-03" and u.last_date == "2024-01-03"
assert s.latest("2024-01-04") == {"B": 2.0}                 # 正常
assert s.latest("2024-01-10") == {"B": 2.0}                 # 容差内（5 个交易日）
assert h.WARNINGS == []
assert s.latest("2024-02-01") == {} and s.latest("2024-02-02") == {} and s.top("2024-02-01", 3) == []
assert u.members("2024-01-03") == ["A"] and u.members("2024-03-01") == [] and u.is_member("A", "2024-03-01") is False
assert len(h.WARNINGS) == 2, h.WARNINGS                      # 每个对象只警告一次
print("OK")
`;
  const pr = spawnSync('python3', ['-I', '-c', py], { env: { ...process.env, HELM_LEAN_DATA: dd }, encoding: 'utf8' });
  const warnLines = (pr.stdout.match(/\[HELM 警告\]/g) || []).length;
  check('helm_data：过期后返回空、只警告一次，容差内照常', pr.status === 0 && /OK/.test(pr.stdout) && warnLines === 2, `${pr.stdout.slice(-300)}${pr.stderr.slice(-300)}`);
  const codeSig = 'self.set_end_date(2024, 6, 30)\nsig = HelmSignals("sg_test")\nuni = HelmUniverse("u_test")\n';
  const w = await E.staleDataWarnings({ dataDir: dd, code: codeSig });
  check('运行前警告：回测结束日期晚于信号 / 股票池导出日', w.length === 2 && /sg_test.*2024-01-03.*2024-06-30/.test(w[0]) && /u_test/.test(w[1]), JSON.stringify(w));
  const w2 = await E.staleDataWarnings({ dataDir: dd, code: 'self.set_end_date(2024, 1, 8)\nHelmSignals("sg_test")\n' });
  check('结束日期在一周容差内：不警告', w2.length === 0, JSON.stringify(w2));

  /* ---- 5. MCP 工具参数校验（表驱动）：全部是工具错误，没有崩溃 ---- */
  const mcp = spawn(process.execPath, [path.join(ROOT, 'mcp', 'qc-mcp.mjs')], { env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let mout = '';
  mcp.stdout.on('data', (c) => { mout += c; });
  mcp.stdin.on('error', () => {});
  const huge = 'x'.repeat(130);
  const CASES = [
    ['read_project', {}, /缺少必填参数 projectId/],
    ['read_project', { projectId: 'abc' }, /projectId 必须是整数/],
    ['read_project', { projectId: 1.5 }, /必须是整数/],
    ['read_project', { projectId: -3 }, /正整数/],
    ['read_project', { projectId: null }, /缺少必填参数/],
    ['read_project', 'oops', /参数 必须是对象|必须是对象/],
    ['create_project', { name: 5 }, /name 必须是字符串/],
    ['create_project', { name: huge }, /name 太长了/],
    ['create_project', { name: '' }, /缺少必填参数 name/],
    ['write_file', { projectId: 1001, name: 'a.py', content: { a: 1 } }, /content 必须是字符串/],
    ['fetch_data', { tickers: 'AAPL' }, /tickers 必须是数组/],
    ['fetch_data', { tickers: [1, 2] }, /必须是字符串/],
    ['fetch_data', { tickers: ['AAPL'], force: 'yes' }, /force 必须是 true 或 false/],
    ['create_backtest', { projectId: 1001, name: 'n', role: 'king', period: 'dev' }, /role 只能是/],
    ['wait_for_backtest', { projectId: 1001, backtestId: 'abcd', timeoutSec: 'long' }, /timeoutSec 必须是整数/],
    ['universe_members', { index: 'nasdaq9', date: '2024-01-02' }, /index 只能是/],
    ['test_idea', { projectId: 1001, idea: 'x', factors: 'low_pe' }, /factors 必须是数组/],
    ['list_paper_sessions', { projectId: 'x' }, /projectId 必须是整数/],
    ['handoff', { agent: 'nobody', task: 'y' }, /agent 只能是/],
    ['不存在的工具', {}, /未知工具/],
  ];
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} })}\n`);
  CASES.forEach(([name, args], i) => mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name, arguments: args } })}\n`));
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'tools/call', params: { name: 'list_projects', arguments: null } })}\n`);
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'tools/call', params: null })}\n`);
  const exited = new Promise((res) => mcp.on('close', (code) => res(code)));
  mcp.stdin.end();
  const code = await Promise.race([exited, sleep(20000).then(() => { mcp.kill('SIGKILL'); return 'timeout'; })]);
  const byId = Object.fromEntries(mout.split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((m) => [m.id, m]));
  CASES.forEach(([name, , re], i) => {
    const r = (byId[i + 1] || {}).result;
    const text = r && r.content && r.content[0].text;
    check(`MCP ${name} ${JSON.stringify(CASES[i][1]).slice(0, 40)}：工具错误，信息匹配`, Boolean(r) && r.isError === true && re.test(text), String(text).slice(0, 100));
  });
  check('MCP：arguments 为 null 当作空参数；params 为 null 不崩；进程正常退出', byId[100] && byId[100].result && byId[100].result.isError === false && byId[101] && code === 0, `exit=${code}`);
} catch (e) {
  check('测试过程没有异常', false, e.stack);
} finally {
  await rm(TMP, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
