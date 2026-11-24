// 因子归因测试：node test/attribution.test.mjs
// 不联网：French 的 zip 用测试自己拼出来（deflate），下载函数替换成假的。
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import * as F from '../lib/factors.mjs';
import * as A from '../lib/attribution.mjs';
import { mulberry32 } from '../lib/stats.mjs';

let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); if (!cond) failed += 1; };
const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-attr-'));

// 最小的 zip（一个文件，deflate）
function zipOf(name, text) {
  const data = Buffer.from(text, 'latin1'); const comp = zlib.deflateRawSync(data); const nm = Buffer.from(name);
  const crc = zlib.crc32 ? zlib.crc32(data) : 0;
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc >>> 0, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(crc >>> 0, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nm.length, 28); cd.writeUInt32LE(0, 42);
  const cdOff = lh.length + nm.length + comp.length;
  const eo = Buffer.alloc(22); eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(1, 8); eo.writeUInt16LE(1, 10); eo.writeUInt32LE(cd.length + nm.length, 12); eo.writeUInt32LE(cdOff, 16);
  return Buffer.concat([lh, nm, comp, cd, nm, eo]);
}

// 合成 6 年的日度因子
const rnd = mulberry32(5); const g = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const dates = []; for (let t = Date.UTC(2010, 0, 4); dates.length < 1500; t += 86400000) { const d = new Date(t); if (d.getUTCDay() % 6) dates.push(d.toISOString().slice(0, 10).replace(/-/g, '')); }
const fac = { mkt: [], smb: [], hml: [], rmw: [], cma: [], mom: [], rf: [] };
for (let i = 0; i < dates.length; i++) { fac.mkt.push(0.0004 + 0.01 * g()); for (const k of ['smb', 'hml', 'rmw', 'cma', 'mom']) fac[k].push(0.0001 + 0.005 * g()); fac.rf.push(0.00005); }
const pctRow = (i, cols) => cols.map((k) => (fac[k][i] * 100).toFixed(4)).join(',');
const ff5Csv = `This file was created using the 202510 CRSP database.\n\n,Mkt-RF,SMB,HML,RMW,CMA,RF\n${dates.map((d, i) => `${d},${pctRow(i, ['mkt', 'smb', 'hml', 'rmw', 'cma', 'rf'])}`).join('\n')}\n\nAnnual factors\n,Mkt-RF\n2010,1.0\n`;
const momCsv = `Momentum file\n\n,Mom   \n${dates.map((d, i) => `${d},${pctRow(i, ['mom'])}`).join('\n')}\n`;

try {
  /* ---- zip / CSV ---- */
  check('解 zip（deflate）', F.unzipFirst(zipOf('a.CSV', 'hello,world')) === 'hello,world');
  const p5 = F.parseFrenchCsv(ff5Csv);
  check('French CSV：读第一张日度表，单位换成小数', p5.cols.join(',') === 'mkt-rf,smb,hml,rmw,cma,rf' && p5.rows.size === dates.length && Math.abs(p5.rows.get(dates[0])[0] - fac.mkt[0]) < 1e-6);
  const merged = F.mergeFactors(p5, F.parseFrenchCsv(momCsv));
  check('合并五因子和动量', merged.dates.length === dates.length && merged.mom.length === dates.length);
  let bad = false; try { F.parseFrenchCsv('nothing here'); } catch { bad = true; }
  check('格式不对：报错', bad);

  /* ---- 下载 + 缓存 + 失败回退 ---- */
  let calls = 0;
  const fetchImpl = async (url) => { calls += 1; return url.includes('Momentum') ? zipOf('m.CSV', momCsv) : zipOf('f.CSV', ff5Csv); };
  const r1 = await F.loadFactors({ dataDir: TMP, fetchImpl, now: Date.parse('2026-01-01') });
  check('第一次：下载并缓存', r1.success && calls === 2 && r1.factors.dates.length === dates.length && /French/.test(r1.source));
  const r2 = await F.loadFactors({ dataDir: TMP, fetchImpl, now: Date.parse('2026-01-03') });
  check('7 天内：用缓存不下载', r2.success && calls === 2);
  const r3 = await F.loadFactors({ dataDir: TMP, fetchImpl: async () => { throw new Error('offline'); }, now: Date.parse('2026-02-01') });
  check('过期又下载失败：用旧缓存并标 stale', r3.success && r3.stale === true && /offline/.test(r3.warning));
  const r4 = await F.loadFactors({ dataDir: path.join(TMP, 'empty'), fetchImpl: async () => { throw new Error('offline'); } });
  check('没有缓存又下载失败：报错', !r4.success && /offline/.test(r4.errors[0]));

  /* ---- 回归：埋进去的暴露能找回来 ---- */
  const day = (d) => Math.floor(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)) / 86400000);
  const rDay = dates.map(day);
  const r = dates.map((_, i) => fac.rf[i] + 0.0002 + 0.8 * fac.mkt[i] + 0.4 * fac.mom[i] + 0.004 * g());
  const a = A.attribute({ r, rDay, factors: merged, lang: 'zh' });
  const ex = Object.fromEntries(a.exposures.map((e) => [e.factor, e]));
  check('找回市场 β≈0.8、动量≈0.4', Math.abs(ex.mkt.beta - 0.8) < 0.05 && Math.abs(ex.mom.beta - 0.4) < 0.05, `${ex.mkt.beta} ${ex.mom.beta}`);
  check('没埋的因子 β≈0、不显著', ['smb', 'hml', 'rmw', 'cma'].every((k) => Math.abs(ex[k].beta) < 0.08 && !ex[k].significant), a.exposures.map((e) => `${e.factor}:${e.beta}/${e.t}`).join(' '));
  check('年化 alpha≈5%（0.0002×252）', Math.abs(a.alpha.annual - 0.0504) < 0.03, a.alpha.annual);
  check('R² 合理', a.r2 > 0.8 && a.r2 < 1, a.r2);
  check('结论提到动量', /动量/.test(a.summary), a.summary);
  check('收益拆解：alpha + Σ 贡献 = 平均超额收益', Math.abs(a.alpha.annual + a.exposures.reduce((s, e) => s + e.contribution, 0) - a.excessAnnual) < 0.002);
  const noAlpha = A.attribute({ r: dates.map((_, i) => fac.rf[i] + 1.0 * fac.mkt[i] + 0.004 * g()), rDay, factors: merged, lang: 'en' });
  check('没有 alpha：判为和 0 分不开', !noAlpha.alpha.significant && /indistinguishable from zero/.test(noAlpha.summary), noAlpha.alpha.t);
  const short = A.attribute({ r: r.slice(0, 100), rDay: rDay.slice(0, 100), factors: merged });
  check('重叠太短：不做', !short.available && /至少要 252/.test(short.reason));
  // Newey-West：残差有自相关时，标准误比普通 OLS 大
  const ar = []; let e = 0; for (let i = 0; i < 1500; i++) { e = 0.6 * e + 0.004 * g(); ar.push(e); }
  const y = ar.map((v, i) => 0.5 * fac.mkt[i] + v);
  const X = y.map((_, i) => [1, fac.mkt[i]]);
  const nw = A.olsNW(y, X); const plain = A.olsNW(y, X, 0);
  check('Newey-West：自相关残差下标准误更大', nw.se[0] > plain.se[0] * 1.3, `${nw.se[0]} vs ${plain.se[0]}`);

  /* ---- 从回测结果文件读 ---- */
  const pd = path.join(TMP, 'projects'); const bid = 'abc123';
  await mkdir(path.join(pd, '7', 'backtests', bid, 'out'), { recursive: true });
  let v = 100000; const pts = [[Math.floor(Date.UTC(2010, 0, 1, 21) / 1000), v]];
  for (let i = 0; i < dates.length; i++) { v *= 1 + r[i]; const d = dates[i]; pts.push([Math.floor(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), 21) / 1000), v]); }
  await writeFile(path.join(pd, '7', 'backtests', bid, 'out', `${bid}.json`), JSON.stringify({ charts: { 'Strategy Equity': { series: { Equity: { values: pts } } } } }));
  const L = await A.loadAttribution({ projectsDir: pd, dataDir: TMP, projectId: 7, backtestId: bid, lang: 'zh', fetchImpl });
  check('从回测结果算归因', L.success && L.attribution.available && Math.abs(L.attribution.exposures[0].beta - 0.8) < 0.06, JSON.stringify(L.errors || L.attribution.reason));
  check('标明数据来源', /French/.test(L.attribution.source));
  const L2 = await A.loadAttribution({ projectsDir: pd, dataDir: TMP, projectId: 7, backtestId: 'ffff', fetchImpl });
  check('没有结果文件：说明', !L2.success && /结果文件/.test(L2.errors[0]));
} finally {
  await rm(TMP, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
