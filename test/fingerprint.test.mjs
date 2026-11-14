// 回测指纹测试：node test/fingerprint.test.mjs
// 全程用临时目录和合成的 LEAN 日线 zip，不碰真实数据和项目。
// 加 --real 时额外在真实 engine/Lean/Data 上（只读）测一次 sp500 策略的指纹耗时。
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-fp-'));
process.env.HELM_PROJECTS_DIR = path.join(TMP, 'projects');
process.env.HELM_TRIALS_FILE = path.join(TMP, 'trials.jsonl');
process.env.HELM_ALPACA_FILE = path.join(TMP, 'secrets', 'alpaca.json');

const F = await import('../lib/fingerprint.mjs');
const E = await import('../lib/engine.mjs');

let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failed += 1;
};

/* ---------- 合成 zip（和 Python zipfile 一样：单文件、deflate；dosTime 不同模拟“重新下载后重新打包”） ---------- */
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function makeZip(name, text, dosTime = 0) {
  const data = Buffer.from(text);
  const comp = zlib.deflateRawSync(data);
  const nm = Buffer.from(name);
  const crc = crc32(data);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(8, 8);
  lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(0x5921, 12); lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26); lh.writeUInt16LE(0, 28);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8); cd.writeUInt16LE(8, 10);
  cd.writeUInt16LE(dosTime, 12); cd.writeUInt16LE(0x5921, 14); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20);
  cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nm.length, 28); cd.writeUInt32LE(0, 42);
  const cdOff = 30 + nm.length + comp.length;
  const cdBuf = Buffer.concat([cd, nm]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(cdOff, 16);
  return Buffer.concat([lh, nm, comp, cdBuf, eocd]);
}
const bars = (n, start = 20200102, bump = {}) => Array.from({ length: n }, (_, i) => {
  const d = String(start + i);
  const c = 1000000 + i * 100 + (bump[i] || 0);
  return `${d} 00:00,${c},${c + 50},${c - 50},${c},${100000 + i}`;
}).join('\n') + '\n';

const DATA = path.join(TMP, 'Data');
const daily = path.join(DATA, 'equity', 'usa', 'daily');
await mkdir(daily, { recursive: true });
await mkdir(path.join(DATA, 'helm', 'universes'), { recursive: true });
await mkdir(path.join(DATA, 'helm', 'signals'), { recursive: true });
const putZip = (sym, text, dosTime = 0) => writeFile(path.join(daily, `${sym}.zip`), makeZip(`${sym}.csv`, text, dosTime));
await putZip('spy', bars(20));
await putZip('aaa', bars(20));
await putZip('bbb', bars(15, 20200105));
await putZip('brk.b', bars(10));
await writeFile(path.join(DATA, 'helm', 'universes', 'tiny.csv'), 'ticker,start,end\nAAA,2020-01-02,2020-01-21\nBBB,2020-01-05,2020-01-19\nBRK-B,2020-01-02,2020-01-11\n');
await writeFile(path.join(DATA, 'helm', 'signals', 'sig_x.csv'), 'date,ticker,score\n2020-01-03,AAA,1.0\n2020-01-03,CCC,0.5\n');
await writeFile(path.join(DATA, 'helm', 'signals', 'sig_x.json'), JSON.stringify({ name: 'sig_x', kind: 'factor' }));

/* ---------- 读 zip 和摘要 ---------- */
const sum = F.csvSummary(F.unzipFirst(makeZip('x.csv', bars(5))));
check('zip 摘要：首末日期和行数', sum.firstDate === '2020-01-02' && sum.lastDate === '2020-01-06' && sum.rows === 5, JSON.stringify(sum));
check('zip 摘要：没有结尾换行也数对行数', F.csvSummary(F.unzipFirst(makeZip('x.csv', bars(5).trimEnd()))).rows === 5);

/* ---------- 代码指纹 ---------- */
const filesA = [{ name: 'main.py', content: 'print(1)\n' }, { name: 'util.py', content: 'X = 1\n' }];
const c1 = F.codeFingerprint(filesA);
const c2 = F.codeFingerprint([...filesA].reverse());
check('代码指纹：同样的文件（顺序不同）哈希相同', c1.hash === c2.hash && c1.files['main.py'] === c2.files['main.py']);
const c3 = F.codeFingerprint([filesA[0], { name: 'util.py', content: 'X = 2\n' }]);
const dc = F.diffCode(c1, c3);
check('代码指纹：改一个文件哈希就变，并指出是哪个文件', c3.hash !== c1.hash && dc.length === 1 && dc[0].file === 'util.py' && dc[0].kind === 'modified', JSON.stringify(dc));
const s1 = F.codeFingerprint([...filesA, { name: 'spec.md', content: '规则 A' }]);
const s2 = F.codeFingerprint([...filesA, { name: 'spec.md', content: '规则 B' }]);
check('代码指纹：只算 .py，改 spec.md 不改变代码哈希', s1.hash === c1.hash && s2.hash === c1.hash && !('spec.md' in s1.files));
check('代码指纹：改文件名也算改了代码', F.codeFingerprint([filesA[0], { name: 'util2.py', content: 'X = 1\n' }]).hash !== c1.hash);

/* ---------- 策略用到的数据 ---------- */
const code = `from helm_data import HelmUniverse, HelmSignals
self.uni = HelmUniverse("tiny")
self.sig = HelmSignals("sig_x")
self.add_equity("SPY", Resolution.DAILY)
self.add_equity("ZZZ", Resolution.DAILY)`;
const inp = await F.strategyInputs({ dataDir: DATA, code, baseTickers: E.tickersInCode(code) });
check('策略输入：代码里的 + 股票池成员 + 信号里的代码', ['AAA', 'BBB', 'BRK-B', 'CCC', 'SPY', 'ZZZ'].every((t) => inp.tickers.includes(t)) && inp.tickers.length === 6, inp.tickers.join(','));
check('策略输入：股票池和信号文件本身也记哈希', ['helm/universes/tiny.csv', 'helm/signals/sig_x.csv', 'helm/signals/sig_x.json'].every((f) => inp.files.includes(f)), inp.files.join(','));

const d1 = await E.backtestDataFingerprint(code, DATA);
const d2 = await E.backtestDataFingerprint(code, DATA);
check('数据指纹：同样的输入哈希相同', d1.hash === d2.hash && d1.hash && /^[0-9a-f]{64}$/.test(d1.hash));
check('数据指纹：每只股票有文件、哈希、首末日期、行数', d1.tickers.AAA.file === 'equity/usa/daily/aaa.zip' && /^[0-9a-f]{64}$/.test(d1.tickers.AAA.sha256) && d1.tickers.AAA.firstDate === '2020-01-02' && d1.tickers.AAA.lastDate === '2020-01-21' && d1.tickers.AAA.rows === 20, JSON.stringify(d1.tickers.AAA));
check('数据指纹：BRK-B 对应 LEAN 的 brk.b.zip', d1.tickers['BRK-B'].file === 'equity/usa/daily/brk.b.zip' && d1.tickers['BRK-B'].rows === 10);
check('数据指纹：缺数据的代码记为 missing，不报错', d1.tickers.ZZZ.missing === true && d1.tickers.CCC.missing === true && d1.missing.join(',') === 'CCC,ZZZ', d1.missing.join(','));

// 重新打包（zip 里的时间不同、内容一样）：哈希不变
await putZip('aaa', bars(20), 0x1234);
check('数据指纹：同样的数据重新打包（zip 字节不同）哈希不变', (await E.backtestDataFingerprint(code, DATA)).hash === d1.hash);

// 改一根 K 线：哈希变，指出是 BBB，类型是“同一段日期内被改”
await putZip('bbb', bars(15, 20200105, { 7: 300 }));
const d3 = await E.backtestDataFingerprint(code, DATA);
const diff3 = F.diffData(d1, d3);
check('数据指纹：改一根 K 线哈希就变', d3.hash !== d1.hash);
check('数据指纹：指出变的是哪只股票（同一段日期内被改）', diff3.changed.length === 1 && diff3.changed[0].ticker === 'BBB' && diff3.changed[0].kind === 'altered' && diff3.files.length === 0, JSON.stringify(diff3.changed));

// 多一个交易日：extended
await putZip('bbb', bars(16, 20200105));
const d4 = await E.backtestDataFingerprint(code, DATA);
const diff4 = F.diffData(d1, d4);
check('数据指纹：补了新交易日算“数据变长”', diff4.changed.length === 1 && diff4.changed[0].kind === 'extended' && diff4.changed[0].after.rows === 16, JSON.stringify(diff4.changed));

// 股票池成员变了：文件哈希变，订阅的代码也变
await writeFile(path.join(DATA, 'helm', 'universes', 'tiny.csv'), 'ticker,start,end\nAAA,2020-01-02,2020-01-21\nBBB,2020-01-05,2020-01-19\n');
const d5 = await E.backtestDataFingerprint(code, DATA);
const diff5 = F.diffData(d4, d5);
check('数据指纹：股票池名单变了也能发现', d5.hash !== d4.hash && diff5.files.some((f) => f.file === 'helm/universes/tiny.csv') && diff5.changed.some((c) => c.ticker === 'BRK-B' && c.kind === 'droppedTicker'), JSON.stringify(diff5));

// 坏 zip：记下错误，不崩
await writeFile(path.join(daily, 'zzz.zip'), 'not a zip');
const d6 = await E.backtestDataFingerprint(code, DATA);
check('数据指纹：坏 zip 记下错误，不崩', d6.tickers.ZZZ.error && !d6.tickers.ZZZ.missing, JSON.stringify(d6.tickers.ZZZ));
await rm(path.join(daily, 'zzz.zip'));

// 缓存：同样大小和修改时间直接用缓存；文件变了重新算
const cacheFile = path.join(TMP, 'fpcache.json');
const k1 = await F.dataFingerprint({ dataDir: DATA, tickers: ['AAA', 'BBB'], cacheFile });
const k2 = await F.dataFingerprint({ dataDir: DATA, tickers: ['AAA', 'BBB'], cacheFile });
await putZip('bbb', bars(17, 20200105));
const k3 = await F.dataFingerprint({ dataDir: DATA, tickers: ['AAA', 'BBB'], cacheFile });
check('缓存：命中时结果一样，文件变了会重新算', k1.hash === k2.hash && k3.hash !== k1.hash && k3.tickers.BBB.rows === 17 && JSON.parse(await readFile(cacheFile, 'utf8')).entries);

/* ---------- 和同项目其他回测比较 ---------- */
const fp = (codeFp, dataFp) => ({ version: 1, code: codeFp, data: dataFp });
const mk = (id, created, f, extra = {}) => ({ backtestId: id, name: id, created, file: 'main.py', fingerprint: f, ...extra });
const a = mk('a', '2026-01-01', fp(c1, d1));
const b = mk('b', '2026-01-02', fp(c1, d1));
const c = mk('c', '2026-01-03', fp(c1, d3));
const dd = mk('d', '2026-01-04', fp(c3, d3));
check('比较：同代码同数据 → same', F.fingerprintCheck(b, [a]).status === 'same');
const chk = F.fingerprintCheck(c, [a, b]);
check('比较：同代码、数据不同 → 「同样的代码，数据和之前不同」并列出 BBB', chk.status === 'dataChanged' && chk.message === '同样的代码，数据和之前不同' && chk.changed[0].ticker === 'BBB' && chk.ref.backtestId === 'b' && chk.altered === 1, JSON.stringify(chk).slice(0, 200));
const chk2 = F.fingerprintCheck(dd, [a, b, c]);
check('比较：代码不同 → codeChanged，列出改了的文件', chk2.status === 'codeChanged' && chk2.codeFiles[0].file === 'util.py' && chk2.ref.backtestId === 'c', JSON.stringify(chk2));
check('比较：第一个回测 → first；老回测没有指纹 → none', F.fingerprintCheck(a, []).status === 'first' && F.fingerprintCheck({ backtestId: 'x' }, [a]).status === 'none');
check('比较：入口文件不同（benchmark.py）不算同一份代码', F.fingerprintCheck({ ...c, file: 'benchmark.py' }, [a, b]).status === 'codeChanged');
check('比较：数据还没记下（运行中）→ pending', F.fingerprintCheck(mk('e', '2026-01-05', fp(c1, null)), [a]).status === 'pending');

/* ---------- 引擎：backtestsRead 带上比较结果；老回测（没有指纹）照常读 ---------- */
const p = await E.createProject({ name: 'FP Test' });
const pid = p.projects[0].projectId;
const root = path.join(process.env.HELM_PROJECTS_DIR, String(pid), 'backtests');
const ids = ['0a', '0b', '0c'].map((x) => x.padEnd(32, '0'));
const metas = [
  { backtestId: ids[0], projectId: pid, name: '老回测', status: 'Completed.', created: '2026-01-01T00:00:00Z' },
  { backtestId: ids[1], projectId: pid, name: '新 1', status: 'Completed.', created: '2026-01-02T00:00:00Z', file: 'main.py', fingerprint: fp(c1, d1) },
  { backtestId: ids[2], projectId: pid, name: '新 2', status: 'Completed.', created: '2026-01-03T00:00:00Z', file: 'main.py', fingerprint: fp(c1, d3) },
];
for (const m of metas) { await mkdir(path.join(root, m.backtestId), { recursive: true }); await writeFile(path.join(root, m.backtestId, 'meta.json'), JSON.stringify(m)); }
const r0 = await E.backtestsRead({ projectId: pid, backtestId: ids[0] });
check('引擎：老回测（没有指纹）照常读，比较结果为 none', r0.success && r0.backtest.fingerprintCheck.status === 'none' && !r0.backtest.fingerprint);
const r2 = await E.backtestsRead({ projectId: pid, backtestId: ids[2] });
check('引擎：backtestsRead 发现同代码数据变了', r2.success && r2.backtest.fingerprintCheck.status === 'dataChanged' && r2.backtest.fingerprintCheck.changed.some((x) => x.ticker === 'BBB'), r2.success && r2.backtest.fingerprintCheck.status);
const list = await E.backtestsList({ projectId: pid });
check('引擎：回测列表不受影响', list.success && list.count === 3);

/* ---------- 可选：真实数据耗时（只读） ---------- */
if (process.argv.includes('--real')) {
  const real = path.join(E.DATA_DIR);
  const sp = `from helm_data import HelmUniverse\nself.uni = HelmUniverse("sp500")\nself.add_equity("SPY", Resolution.DAILY)`;
  const t0 = Date.now();
  const r = await E.backtestDataFingerprint(sp, real);
  const ms = Date.now() - t0;
  check('真实数据：sp500 策略指纹 < 3 秒', ms < 3000 && r.count > 500, `${r.count} 只，缺 ${r.missing.length}，${ms} ms`);
}

await rm(TMP, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
