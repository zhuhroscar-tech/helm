// 2026-11-14 性能和健壮性改动的回归测试：node test/efficiency.test.mjs
// 每个提速都和原来的写法逐位比较（结果必须完全一样）；健壮性改动用并发 / 崩溃场景检查。全部在临时目录里。
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-eff-'));
process.env.HELM_PROJECTS_DIR = path.join(TMP, 'projects');
process.env.HELM_TRIALS_FILE = path.join(TMP, 'trials.jsonl');
process.env.HELM_ALPACA_FILE = path.join(TMP, 'secrets', 'alpaca.json');
const S = await import('../lib/stats.mjs');
const R = await import('../lib/robust.mjs');
const E = await import('../lib/engine.mjs');
const A = await import('../lib/fs-atomic.mjs');
const C = await import('../lib/market-calendar.mjs');

let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); if (!cond) failed += 1; };
let seed = 11; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

/* ---------- 自助法：提速后和原来的写法逐位相同 ---------- */
{
  const SQ = Math.sqrt(252);
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
  const sharpe = (r) => { const s = sd(r); return s > 1e-12 ? (mean(r) / s) * SQ : 0; };
  // 原来的实现（循环块 + reduce + 复制数组的配对检验）
  function ref(r, stat, { n = 2000, block = 20, seed: sd0 = 7 } = {}) {
    const len = r.length; const rr = S.mulberry32(sd0); const out = new Float64Array(n); const x = new Float64Array(len);
    for (let i = 0; i < n; i++) { let k = 0; while (k < len) { const s = Math.floor(rr() * len); for (let j = 0; j < block && k < len; j++) x[k++] = r[(s + j) % len]; } out[i] = stat(x); }
    const sorted = Array.from(out).sort((a, b) => a - b); const q = (p) => sorted[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
    return { lo: q(0.025), hi: q(0.975), pLe0: sorted.filter((v) => v <= 0).length / n };
  }
  const a = Array.from({ length: 900 }, () => (rnd() - 0.49) * 0.02); const b = Array.from({ length: 900 }, () => (rnd() - 0.495) * 0.015);
  check('自助法：夏普区间和原来的写法逐位相同', JSON.stringify(ref(a, sharpe)) === JSON.stringify(S.blockBootstrap(a, sharpe)));
  const idx = a.map((_, i) => i); const pick = (arr, x) => Array.from(x, (k) => arr[k]);
  const old = ref(idx, (x) => sharpe(pick(a, x)) - sharpe(pick(b, x)));
  // 新的配对检验走 validateResult 的风险调整模式；这里直接用同一个下标自助法核对数值
  const nw = S.blockBootstrapIdx(a.length, (ix) => { const f = (arr) => sharpe(Array.from(ix, (k) => arr[k])); return f(a) - f(b); });
  check('自助法：配对（同日下标）检验和原来逐位相同', JSON.stringify(old) === JSON.stringify(nw));
  // 速度：同一组数据，validateResult 的风险调整模式（配对检验）不再每次复制数组
  const res = { charts: { 'Strategy Equity': { series: { Equity: { values: [] } } }, Benchmark: { series: { Benchmark: { values: [] } } } } };
  let e = 100000; let bmv = 100; const t0d = Date.parse('2010-01-04T21:00:00Z') / 1000;
  for (let i = 0, d = 0; i < 2500; d++) { const t = t0d + d * 86400; const dow = new Date(t * 1000).getUTCDay(); if (dow === 0 || dow === 6) continue; e *= 1 + (rnd() - 0.49) * 0.02; bmv *= 1 + (rnd() - 0.49) * 0.015; res.charts['Strategy Equity'].series.Equity.values.push([t, e]); res.charts.Benchmark.series.Benchmark.values.push([t, bmv]); i++; }
  const t1 = performance.now(); S.validateResult(res, { gateMode: 'risk-adjusted' }, [0.5]); const ms = performance.now() - t1;
  check('风险调整模式的检验：约 10 年数据在 1 秒内（原来 7700 点要 660 ms，现在约 100 ms）', ms < 1000, `${ms.toFixed(0)} ms`);
}

/* ---------- 市场状态：有序窗口中位数和逐日排序完全一样 ---------- */
{
  const sd = (a) => { const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
  const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  function refLabels(bc) { // 原来的写法
    const n = bc.length; const labels = new Array(n).fill(null); const ret = new Array(n).fill(null);
    for (let j = 1; j < n; j++) ret[j] = bc[j] / bc[j - 1] - 1;
    const vol = new Array(n).fill(null); for (let j = 20; j < n; j++) vol[j] = sd(ret.slice(j - 19, j + 1));
    let sum = 0;
    for (let j = 0; j < n; j++) { sum += bc[j]; if (j >= 200) sum -= bc[j - 200]; if (j < 199) continue; if (j < 20 + 252 - 1) continue; const med = median(vol.slice(j - 251, j + 1)); labels[j] = { trend: bc[j] > sum / 200 ? 'up' : 'down', vol: vol[j] > med ? 'high' : 'low' }; }
    return labels;
  }
  let same = true;
  for (let k = 0; k < 12; k++) {
    const n = 280 + Math.floor(rnd() * 1500); let v = 100; const bc = [];
    for (let i = 0; i < n; i++) { v *= 1 + (rnd() - 0.5) * 0.02; bc.push(k % 4 === 0 ? Math.round(v) : v); } // 有的序列有很多重复值
    if (JSON.stringify(refLabels(bc)) !== JSON.stringify(R.regimeLabels(bc))) same = false;
  }
  check('市场状态标签：和逐日排序的写法完全一样（12 条随机序列，含大量重复值）', same);
  let v = 100; const bc = Array.from({ length: 4000 }, () => (v *= 1 + (rnd() - 0.5) * 0.02));
  const t0 = performance.now(); R.regimeLabels(bc); const ms = performance.now() - t0;
  check('市场状态标签：4000 天在 20 ms 内（原来约 35 ms，现在约 1 ms）', ms < 20, `${ms.toFixed(1)} ms`);
}

/* ---------- 交易日按日历判断 ---------- */
check('日历：1994 年以后的临时休市都认得', ['1994-04-27', '2001-09-11', '2001-09-14', '2004-06-11', '2007-01-02', '2012-10-29', '2012-10-30', '2018-12-05', '2025-01-09'].every((d) => !C.isTradingDay(d)));
check('日历：马丁·路德·金日 1998 年起才休市', C.isTradingDay('1997-01-20') && !C.isTradingDay('1998-01-19'));
{
  // 基准某个交易日收盘价和前一天完全一样（真实发生过）：这一天要保留，不能当成休市
  const T = (iso, h) => Date.parse(`${iso}T${h}:00:00Z`) / 1000;
  const days = ['2024-03-04', '2024-03-05', '2024-03-06', '2024-03-07', '2024-03-08', '2024-03-11'];
  const eq = [[T(days[0], '05'), 100]]; const bm = [[T(days[0], '05'), 50]];
  days.forEach((d, i) => { eq.push([T(d, '21'), 100 + i]); bm.push([T(d, '21'), i === 3 ? 52 : 50 + i]); }); // 3-07 的基准 = 3-06
  const res = { charts: { 'Strategy Equity': { series: { Equity: { values: eq } } }, Benchmark: { series: { Benchmark: { values: bm } } } } };
  const P = R.prepare(res);
  const isoD = (d) => new Date(d * 86400000).toISOString().slice(0, 10);
  check('基准平盘的交易日不再被丢掉（2024-03-07 基准收盘价和前一天一样，但是交易日）', P.days.map(isoD).includes('2024-03-07'), P.days.map(isoD).join(','));
}

/* ---------- 落盘：fsync + 半行保护 + 损坏可见 ---------- */
{
  const f = path.join(TMP, 'x.jsonl');
  await writeFile(f, '{"a":1}\n{"b":2'); // 上次崩溃留下半行
  await A.appendLine(f, JSON.stringify({ c: 3 }));
  const rows = (await readFile(f, 'utf8')).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  check('追加前补换行：半行之后的新记录仍然读得出来', rows.length === 2 && rows[1].c === 3, JSON.stringify(rows));
  const j = path.join(TMP, 'y.json');
  await A.writeJsonAtomic(j, { ok: true });
  check('原子写入：写完读回一致，没有留下临时文件', (await A.readJsonFile(j)).ok === true && !(await import('node:fs')).readdirSync(TMP).some((x) => x.endsWith('.tmp')));
  await writeFile(j, '{"broken": ');
  const errs = []; const orig = console.error; console.error = (m) => errs.push(String(m));
  const got = await A.readJsonFile(j, 'fallback'); await A.readJsonFile(j, 'fallback');
  console.error = orig;
  check('损坏的文件：返回默认值，并且记一次日志（不再悄悄当成“没有”）', got === 'fallback' && errs.length === 1 && /损坏/.test(errs[0]));
}

/* ---------- 回测元数据：并发设主版本，结果总是正好一个 ---------- */
const mk = async (pid, k) => {
  const ids = [];
  await mkdir(path.join(TMP, 'projects', String(pid)), { recursive: true });
  await writeFile(path.join(TMP, 'projects', String(pid), 'project.json'), JSON.stringify({ projectId: pid, name: 't' }));
  for (let i = 0; i < k; i++) {
    const id = crypto.randomBytes(16).toString('hex'); ids.push(id);
    const d = path.join(TMP, 'projects', String(pid), 'backtests', id); await mkdir(path.join(d, 'out'), { recursive: true });
    await writeFile(path.join(d, 'meta.json'), JSON.stringify({ backtestId: id, projectId: pid, name: `bt${i}`, status: 'Completed.', role: 'candidate', period: 'dev', created: new Date().toISOString() }));
  }
  return ids;
};
{
  const ids = await mk(3, 8);
  const runner = path.join(TMP, 'main.mjs');
  await writeFile(runner, `process.env.HELM_PROJECTS_DIR = process.argv[2];
const E = await import(${JSON.stringify(path.join(ROOT, 'lib', 'engine.mjs'))});
await Promise.all(process.argv.slice(3).map((id) => E.setMainByUser({ projectId: 3, backtestId: id })));`);
  const run = (chunk) => new Promise((res) => { const p = spawn(process.execPath, [runner, path.join(TMP, 'projects'), ...chunk], { stdio: 'inherit' }); p.on('close', res); });
  await Promise.all([run(ids.slice(0, 4)), run(ids.slice(4)), ...ids.map((id) => E.setMainByUser({ projectId: 3, backtestId: id }))]);
  const metas = await Promise.all(ids.map(async (id) => JSON.parse(await readFile(path.join(TMP, 'projects', '3', 'backtests', id, 'meta.json'), 'utf8'))));
  const mains = metas.filter((m) => m.role === 'main');
  check('两个进程 + 本进程同时把 8 个回测设为主版本：最后正好一个主版本', mains.length === 1, `主版本 ${mains.length} 个`);
  check('其余的都是候选，「用户选定」标记清掉了', metas.filter((m) => m.role === 'candidate' && !m.mainBy).length === 7);
}
{
  // 改别的回测的角色时只动 role：回测进程同时写进去的状态和摘要不会被旧内容盖掉
  const [a, b] = await mk(4, 2);
  const fb = path.join(TMP, 'projects', '4', 'backtests', b, 'meta.json');
  const mb = JSON.parse(await readFile(fb, 'utf8')); mb.role = 'main'; await writeFile(fb, JSON.stringify(mb));
  const setA = E.setMainByUser({ projectId: 4, backtestId: a });
  await E.withFileLock(fb, async () => { const m = JSON.parse(await readFile(fb, 'utf8')); m.status = 'Completed.'; m.summary = { sharpeRatio: 1.23 }; await A.writeJsonAtomic(fb, m); });
  await setA;
  const after = JSON.parse(await readFile(fb, 'utf8'));
  check('降级别的主版本时，不会盖掉它同时写进去的摘要', after.role === 'candidate' && after.summary && after.summary.sharpeRatio === 1.23, JSON.stringify(after).slice(0, 160));
}

/* ---------- 结果文件缓存：文件变了就重读 ---------- */
{
  const [id] = await mk(5, 1);
  const out = path.join(TMP, 'projects', '5', 'backtests', id, 'out', `${id}.json`);
  const mkRes = (cash) => ({ charts: { 'Strategy Equity': { series: { Equity: { values: [[1700000000, cash], [1700086400, cash + 1]] } } } }, statistics: { 'End Equity': String(cash + 1) }, orders: {} });
  await writeFile(out, JSON.stringify(mkRes(100)));
  const r1 = await E.backtestsRead({ projectId: 5, backtestId: id });
  await writeFile(out, JSON.stringify(mkRes(500)));
  await utimes(out, new Date(), new Date(Date.now() + 5000)); // 确保修改时间变了
  const r2 = await E.backtestsRead({ projectId: 5, backtestId: id });
  check('结果文件缓存：文件改了会重读', r1.backtest.statistics['End Equity'] === '101' && r2.backtest.statistics['End Equity'] === '501');
  const t0 = performance.now(); for (let i = 0; i < 20; i++) await E.chartRead({ projectId: 5, backtestId: id, name: 'Strategy Equity' }); const ms = (performance.now() - t0) / 20;
  check('结果文件缓存：没变时不再重新解析', ms < 5, `${ms.toFixed(2)} ms/次`);
}

/* ---------- Python：整表生成 LEAN 日线行，和逐行 iterrows 完全一样 ---------- */
{
  const py = spawnSync('python3', ['-I', '-c', 'import pandas, numpy'], { encoding: 'utf8' });
  if (py.status !== 0) console.log('SKIP  Python 没有 pandas，跳过 LEAN 日线行的比较');
  else {
    const code = `
import sys, types, numpy as np, pandas as pd
sys.modules['yfinance'] = types.ModuleType('yfinance')
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'engine'))})
import fetch_data as F
def old(df):
    lines = []
    for idx, r in df.iterrows():
        d = idx.strftime("%Y%m%d")
        o, h, l, c = (int(round(float(r[k]) * 10000)) for k in ("Open", "High", "Low", "Close"))
        if min(o, h, l, c) <= 0: continue
        h, l = max(h, o, c), min(l, o, c)
        v = int(r["Volume"]) if r["Volume"] == r["Volume"] else 0
        lines.append(f"{d} 00:00,{o},{h},{l},{c},{v}")
    return lines
rng = np.random.default_rng(3); n = 3000
idx = pd.date_range('2000-01-03', periods=n, freq='B', tz='America/New_York')
base = np.cumprod(1 + rng.normal(0, 0.02, n)) * 20
df = pd.DataFrame({'Open': base * (1 + rng.normal(0, .01, n)), 'High': base * 1.01, 'Low': base * 0.99, 'Close': base, 'Volume': rng.integers(0, 10**8, n).astype(float)}, index=idx)
df.iloc[5, 4] = np.nan; df.iloc[7, 0] = -0.5; df.iloc[11, 3] = 1.00005; df.iloc[12, 3] = 2.00015; df.iloc[14, 1] = df.iloc[14, 3] * 0.98
src = open(${JSON.stringify(path.join(ROOT, 'engine', 'qlib_bridge.py'))}).read()
ns = {'np': np, 'pd': pd}; exec(src[src.index('def lean_rows'):src.index('def spells_of')], ns)
dq = df.rename(columns=str.lower); dq.index = dq.index.tz_localize(None)
def old_b(df):
    out = []
    for d, r in df.iterrows():
        o, h, l, c = (int(round(float(r[k]) * 10000)) for k in ("open", "high", "low", "close"))
        h, l = max(h, o, c), min(l, o, c)
        v = int(r["volume"]) if r["volume"] == r["volume"] else 0
        out.append(f"{d:%Y%m%d} 00:00,{o},{h},{l},{c},{v}")
    return out
print(old(df) == F.lean_lines(df, ("Open", "High", "Low", "Close", "Volume"), drop_nonpositive=True), old_b(dq) == ns['lean_rows'](dq))
`;
    const r = spawnSync('python3', ['-I', '-c', code], { encoding: 'utf8' });
    check('Python：fetch_data / qlib_bridge 整表写法和逐行结果完全一样（含负价、缺失成交量、四舍五入边界）', r.stdout.trim() === 'True True', (r.stdout + r.stderr).trim().slice(-300));
  }
}

await rm(TMP, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
