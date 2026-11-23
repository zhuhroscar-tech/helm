// 2026-11-14 代码审查里 4 个最高优先级问题的回归测试，以及「用户手动设为主版本」：node test/p0-fixes.test.mjs
// 全部在临时目录里跑，不碰真实项目。
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-p0-'));
process.env.HELM_PROJECTS_DIR = path.join(TMP, 'projects');
process.env.HELM_TRIALS_FILE = path.join(TMP, 'trials.jsonl');
process.env.HELM_ALPACA_FILE = path.join(TMP, 'secrets', 'alpaca.json');
const E = await import('../lib/engine.mjs');
const S = await import('../lib/stats.mjs');
const X = await import('../lib/exec-sandbox.mjs');
const PP = await import('../lib/paper.mjs');

let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); if (!cond) failed += 1; };

/* ---------- 1. 循环块自助法：每一天被抽中的机会相同 ---------- */
{
  const n = 300;
  const idx = Array.from({ length: n }, (_, i) => i);
  const counts = new Float64Array(n);
  S.blockBootstrap(idx, (x) => { for (const v of x) counts[v] += 1; return 0; }, { n: 400 });
  const avg = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += counts[i]; return s / (b - a); };
  const ends = (avg(0, 10) + avg(n - 10, n)) / 2; const mid = avg(140, 160);
  check('自助法：首尾 10 天和中间被抽中的次数差不多（不绕回时首尾只有中间的约 1/10）', ends / mid > 0.85 && ends / mid < 1.15, `首尾/中间 = ${(ends / mid).toFixed(3)}`);
  const base = Array.from({ length: n }, (_, i) => 0.003 + 0.004 * Math.sin(i * 1.7));
  const sh = (x) => { let m = 0; for (const v of x) m += v; m /= x.length; let s = 0; for (const v of x) s += (v - m) ** 2; return (m / Math.sqrt(s / (x.length - 1))) * Math.sqrt(252); };
  const midL = base.slice(); const endL = base.slice();
  for (let i = 0; i < 5; i++) { midL[150 + i] = -0.04; endL[n - 5 + i] = -0.04; }
  const a = S.blockBootstrap(midL, sh); const b = S.blockBootstrap(endL, sh);
  const d = Math.abs((a.lo + a.hi) / 2 - (b.lo + b.hi) / 2);
  check('自助法：同样的亏损放在中间还是最后，置信区间几乎一样', d < 0.1 && Math.abs(a.lo - b.lo) < 0.1, `中点差 ${d.toFixed(3)}`);
}

/* ---------- 4. 验证期记录：两个进程同时登记不丢 ---------- */
const mkBacktests = async (pid, k, extra = {}) => {
  const ids = [];
  await mkdir(path.join(TMP, 'projects', String(pid)), { recursive: true });
  await writeFile(path.join(TMP, 'projects', String(pid), 'project.json'), JSON.stringify({ projectId: pid, name: 't' }));
  for (let i = 0; i < k; i++) {
    const id = crypto.randomBytes(16).toString('hex'); ids.push(id);
    const d = path.join(TMP, 'projects', String(pid), 'backtests', id); await mkdir(d, { recursive: true });
    await writeFile(path.join(d, 'meta.json'), JSON.stringify({ backtestId: id, name: `bt${i}`, status: 'Completed.', role: 'debug', period: 'dev', created: new Date().toISOString(), ...extra }));
  }
  return ids;
};
{
  const ids = await mkBacktests(1, 24);
  const runner = path.join(TMP, 'tag.mjs');
  await writeFile(runner, `process.env.HELM_PROJECTS_DIR = process.argv[2];
const E = await import(${JSON.stringify(path.join(ROOT, 'lib', 'engine.mjs'))});
const r = await Promise.all(process.argv.slice(3).map((id) => E.updateBacktest({ projectId: 1, backtestId: id, period: 'holdout' })));
console.log(r.every((x) => x.success) ? 'ok' : 'fail');`);
  const run = (chunk) => new Promise((res) => { const p = spawn(process.execPath, [runner, path.join(TMP, 'projects'), ...chunk], { stdio: ['ignore', 'pipe', 'inherit'] }); let o = ''; p.stdout.on('data', (c) => { o += c; }); p.on('close', () => res(o.trim())); });
  const inproc = Promise.all(ids.slice(0, 8).map((id) => E.updateBacktest({ projectId: 1, backtestId: id, period: 'holdout' })));
  const outs = await Promise.all([run(ids.slice(8, 16)), run(ids.slice(16, 24)), inproc]);
  const log = JSON.parse(await readFile(path.join(TMP, 'projects', '1', 'holdout_log.json'), 'utf8'));
  const seqs = [];
  for (const id of ids) seqs.push(JSON.parse(await readFile(path.join(TMP, 'projects', '1', 'backtests', id, 'meta.json'), 'utf8')).holdoutSeq);
  seqs.sort((x, y) => x - y);
  check('验证期记录：本进程 8 个 + 两个子进程各 8 个同时登记 → 24 条，不丢', outs[0] === 'ok' && outs[1] === 'ok' && log.length === 24 && new Set(log.map((x) => x.backtestId)).size === 24, `记录 ${log.length} 条`);
  check('验证期记录：「第几次」是 1..24，没有重复', seqs.join(',') === Array.from({ length: 24 }, (_, i) => i + 1).join(','), seqs.join(','));
  check('验证期记录：锁文件用完就删', !(await readFile(path.join(TMP, 'projects', '1', 'holdout_log.json.lock'), 'utf8').catch(() => null)));
}

/* ---------- 3. helm_data：完整数据存在下划线属性里，策略读它会被拦 ---------- */
{
  const src = `from AlgorithmImports import *
from helm_data import HelmSignals, HelmUniverse, HelmMacro
import helm_data
class A(QCAlgorithm):
    def initialize(self):
        self.set_start_date(2020, 1, 1); self.set_cash(100000); self.set_benchmark("SPY")
        self.sig = HelmSignals("x"); self.uni = HelmUniverse("sp500"); self.y2 = HelmMacro("DGS2")
        self._mine = 1
    def on_data(self, data):
        b = self.sig._by.get("2020-01-02")
        c = self.uni._spells["AAPL"][-1][1]
        d = self.y2._values[-1]
        e = getattr(self.sig, "_dates")
        f = helm_data._DATA
        g = self._mine
        h = self.sig.latest(self.time)
class Peek(HelmSignals):
    def peek(self):
        return self._by
`;
  const r = await E.lintSources([{ name: 'main.py', content: src }]);
  const lines = (r.errors || []).filter((x) => x.code === 'private-attr').map((x) => x.line).sort((a, b) => a - b);
  check('lint：读 _by / _spells / _values、getattr("_dates")、helm_data._DATA、继承 HelmSignals 都拦', lines.join(',') === '10,11,12,13,14,17', lines.join(','));
  check('lint：自己的 self._x 和公开方法不拦', !(r.errors || []).some((x) => x.line === 15 || x.line === 16));
  const hd = await readFile(path.join(ROOT, 'engine', 'helm_data.py'), 'utf8');
  const pubData = hd.match(/self\.(by_date|spells|dates|values|avail|rows)\s*=/g);
  check('helm_data：整份数据都存在下划线属性里（没有 self.by_date / spells / dates / values = ...）', !pubData, pubData ? pubData.join(' ') : '');
}

/* ---------- 1. 沙盒规则：读不到密钥、连不上 Helm、改不了仓库 ---------- */
{
  const ag = X.sandboxProfile('agent', { port: 4999, root: ROOT });
  const rs = X.sandboxProfile('research', { port: 4999, root: ROOT, projectsDir: path.join(ROOT, 'projects') });
  check('沙盒（agent）：连不上 Helm 的端口，也连不上外网', /\(deny network-outbound \(remote ip "localhost:4999"\)\)/.test(ag) && /^\(deny network-outbound\)$/m.test(ag));
  check('沙盒（agent）：只能写临时目录', /\(deny file-write\*\)/.test(ag) && !ag.includes(`(subpath "${path.join(ROOT, 'lib')}")`) && !ag.includes(`(subpath "${ROOT}")`));
  check('沙盒：密钥目录和 .env 读写都不行（规则写在最后，优先）', ag.trim().split('\n').pop().startsWith('(deny file-read* file-write*') && ag.includes(path.join(ROOT, 'data', 'secrets')) && ag.includes(path.join(ROOT, '.env')));
  check('沙盒（research）：可以联网但连不上 Helm；只能写 projects/<id>/research/', /\(deny network-outbound \(remote ip "localhost:4999"\)\)/.test(rs) && !/^\(deny network-outbound\)$/m.test(rs) && /\/\[0-9\]\+\/research\//.test(rs));
  const LD = path.join(ROOT, 'engine', 'Lean', 'Data');
  const ex = X.sandboxProfile('export', { port: 4999, root: ROOT, projectsDir: path.join(ROOT, 'projects'), leanDataDir: LD });
  check('沙盒（export）：股票池导出能写 LEAN 日线价格目录和 helm-meta.json', ['daily', 'map_files', 'factor_files'].every((d) => ex.includes(`(subpath "${path.join(LD, 'equity', 'usa', d)}")`)) && ex.includes(`(literal "${path.join(LD, 'helm-meta.json')}")`));
  check('沙盒（research）：普通研究任务写不了 LEAN 价格数据', !rs.includes(path.join('equity', 'usa', 'daily')) && !rs.includes('helm-meta.json'));
  check('沙盒（export）：其余限制和 research 一样（连不上 Helm、密钥规则在最后）', /\(deny network-outbound \(remote ip "localhost:4999"\)\)/.test(ex) && ex.trim().split('\n').pop().startsWith('(deny file-read* file-write*'));
  check('去掉密钥环境变量', !('ALPACA_API_KEY' in X.scrubEnv({ ALPACA_API_KEY: 'x', HELM_TOKEN: 'y', PATH: '/bin' })) && !('HELM_TOKEN' in X.scrubEnv({ HELM_TOKEN: 'y' })) && X.scrubEnv({ PATH: '/bin' }).PATH === '/bin');
  if (process.platform !== 'darwin') check('不是 macOS：沙盒报告不可用（规则会收紧为要批准）', X.sandboxReady('agent', { port: 4999 }) === false && X.wrapAgentCommand('npm test -- --fast', { port: 4999 }) === null);
}

/* ---------- 用户手动设为主版本 ---------- */
{
  const [a, b, c, bench] = await mkBacktests(2, 4);
  const mf = (id) => path.join(TMP, 'projects', '2', 'backtests', id, 'meta.json');
  const meta = async (id) => JSON.parse(await readFile(mf(id), 'utf8'));
  const bm = await meta(bench); bm.role = 'benchmark'; bm.ranAsBenchmark = true; await writeFile(mf(bench), JSON.stringify(bm));
  const r1 = await E.setMainByUser({ projectId: 2, backtestId: a });
  const ma = await meta(a);
  check('用户设为主版本：调试回测也可以，不经过统计检验', r1.success && ma.role === 'main' && ma.mainBy === 'user' && !ma.mainRejected);
  check('用户选的主版本：Alpaca 关卡放行', PP.alpacaGateReason(ma) === null);
  const r2 = await E.updateBacktest({ projectId: 2, backtestId: b, role: 'main' });
  check('agent 不能把别的回测标成主版本来顶替用户选的', !r2.success && /用户已经在网页上选定/.test(r2.errors.join('')) && (await meta(a)).role === 'main' && (await meta(b)).role === 'candidate');
  const r3 = await E.updateBacktest({ projectId: 2, backtestId: a, role: 'main', note: '备注' });
  check('对用户选的主版本再标 main：保持原样，不重新过关卡', r3.success && (await meta(a)).mainBy === 'user' && (await meta(a)).note === '备注');
  await E.setMainByUser({ projectId: 2, backtestId: c });
  check('用户换一个主版本：同时段原来的改为候选，标记清掉', (await meta(c)).mainBy === 'user' && (await meta(a)).role === 'candidate' && !(await meta(a)).mainBy);
  const r4 = await E.setMainByUser({ projectId: 2, backtestId: bench });
  check('以基准身份跑完的回测不能设为主版本（它没记进尝试次数）', !r4.success && /基准身份/.test(r4.errors.join('')));
  await E.updateBacktest({ projectId: 2, backtestId: c, role: 'candidate' });
  check('用户把主版本改成别的角色：「用户选定」标记清掉', !(await meta(c)).mainBy);
  const list = await E.backtestsList({ projectId: 2 });
  check('回测列表带 mainBy', list.success && list.backtests.some((x) => 'mainBy' in x));
}

await rm(TMP, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
