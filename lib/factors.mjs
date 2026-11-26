// Helm · 因子收益（Kenneth R. French Data Library）：Fama-French 五因子 + 动量，日度。
// 用于「因子归因」：把策略的日收益拆到市场、规模、价值、盈利、投资、动量这些已知因子上。
// 来源：https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/data_library.html（免费、公开，学术常用；引用时注明来源）。
// 下载的是 zip 里的 CSV（单位：百分比）。零依赖：zip 用 node:zlib 自己解。缓存在 data/factors/ff_daily.json，7 天刷新一次；
// 下载失败时用旧缓存并标出 stale。French 的数据一般滞后 1–2 个月，最近的日子没有因子值。
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { writeJsonAtomic } from './fs-atomic.mjs';

const BASE = 'https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp';
export const FF_URLS = {
  ff5: `${BASE}/F-F_Research_Data_5_Factors_2x3_daily_CSV.zip`,
  mom: `${BASE}/F-F_Momentum_Factor_daily_CSV.zip`,
};
export const FACTORS = ['mkt', 'smb', 'hml', 'rmw', 'cma', 'mom'];
export const FACTOR_LABEL = {
  mkt: { zh: '市场（股票相对现金）', en: 'Market (stocks minus cash)' },
  smb: { zh: '规模（小盘减大盘）', en: 'Size (small minus big)' },
  hml: { zh: '价值（便宜减贵）', en: 'Value (cheap minus expensive)' },
  rmw: { zh: '盈利（高盈利减低盈利）', en: 'Profitability (robust minus weak)' },
  cma: { zh: '投资（保守减激进）', en: 'Investment (conservative minus aggressive)' },
  mom: { zh: '动量（过去涨得多减涨得少）', en: 'Momentum (past winners minus losers)' },
};
const REFRESH_MS = 7 * 24 * 3600 * 1000;

/** 读 zip 里的第一个文件（支持不压缩和 deflate）。同步函数，导出给测试。 */
export function unzipFirst(buf) {
  const b = Buffer.from(buf);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('不是 zip 文件');
  const cd = b.readUInt32LE(eocd + 16);
  if (b.readUInt32LE(cd) !== 0x02014b50) throw new Error('zip 目录损坏');
  const method = b.readUInt16LE(cd + 10);
  const csize = b.readUInt32LE(cd + 20);
  const lho = b.readUInt32LE(cd + 42);
  if (b.readUInt32LE(lho) !== 0x04034b50) throw new Error('zip 文件头损坏');
  const start = lho + 30 + b.readUInt16LE(lho + 26) + b.readUInt16LE(lho + 28);
  const data = b.subarray(start, start + csize);
  if (method === 0) return data.toString('latin1');
  if (method === 8) return zlib.inflateRawSync(data).toString('latin1');
  throw new Error(`不支持的 zip 压缩方式 ${method}`);
}

/** French 的日度 CSV：前面几行说明，然后「表头, 列…」，数据行「YYYYMMDD, 数值…」（百分比），后面可能还有别的表。
 *  返回 { cols: [列名小写], rows: Map(YYYYMMDD → [小数]) }，只取第一张日度表。同步函数。 */
export function parseFrenchCsv(text) {
  const lines = String(text).split(/\r?\n/);
  let cols = null; const rows = new Map();
  for (const line of lines) {
    const parts = line.split(',').map((x) => x.trim());
    if (!cols) {
      if (parts.length >= 2 && parts[0] === '' && parts.slice(1).every((x) => /[A-Za-z]/.test(x))) cols = parts.slice(1).map((x) => x.toLowerCase());
      continue;
    }
    if (/^\d{8}$/.test(parts[0])) {
      const v = parts.slice(1, cols.length + 1).map(Number);
      if (v.length === cols.length && v.every(Number.isFinite) && !v.some((x) => x <= -99.99)) rows.set(parts[0], v.map((x) => x / 100));
    } else if (rows.size) break; // 第一张表结束
  }
  if (!cols || !rows.size) throw new Error('因子文件格式不对（找不到日度数据表）');
  return { cols, rows };
}

/** 合并五因子和动量：{ dates: ['YYYYMMDD'…], mkt:[], smb:[], hml:[], rmw:[], cma:[], rf:[], mom:[] }，只留两边都有的日子。同步函数。 */
export function mergeFactors(ff5, mom) {
  const ci = (t, name) => { const i = t.cols.findIndex((c) => c.replace(/[^a-z]/g, '') === name); if (i < 0) throw new Error(`因子文件里没有 ${name}`); return i; };
  const iM = ci(ff5, 'mktrf'); const iS = ci(ff5, 'smb'); const iH = ci(ff5, 'hml'); const iR = ci(ff5, 'rmw'); const iC = ci(ff5, 'cma'); const iF = ci(ff5, 'rf');
  const iMom = ci(mom, 'mom');
  const out = { dates: [], mkt: [], smb: [], hml: [], rmw: [], cma: [], rf: [], mom: [] };
  for (const d of [...ff5.rows.keys()].sort()) {
    const m = mom.rows.get(d);
    if (!m) continue;
    const v = ff5.rows.get(d);
    out.dates.push(d); out.mkt.push(v[iM]); out.smb.push(v[iS]); out.hml.push(v[iH]); out.rmw.push(v[iR]); out.cma.push(v[iC]); out.rf.push(v[iF]); out.mom.push(m[iMom]);
  }
  return out;
}

async function download(url, timeoutMs = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? '下载因子数据超时' : `下载因子数据失败：${e.message}`);
  } finally { clearTimeout(t); }
}

/**
 * 读因子数据：缓存不到 7 天直接用；否则下载（fetchImpl 可替换，测试用）。下载失败时用旧缓存（stale: true）。
 * 返回 { success, factors, fetchedAt, stale, source, errors }。
 */
export async function loadFactors({ dataDir, force = false, fetchImpl = download, now = Date.now() } = {}) {
  const file = path.join(dataDir, 'factors', 'ff_daily.json');
  let cache = null;
  try { cache = JSON.parse(await readFile(file, 'utf8')); } catch { /* 没有缓存 */ }
  if (cache && !force && now - Date.parse(cache.fetchedAt) < REFRESH_MS) return { success: true, errors: [], factors: cache.factors, fetchedAt: cache.fetchedAt, stale: false, source: cache.source };
  try {
    const [a, b] = await Promise.all([fetchImpl(FF_URLS.ff5), fetchImpl(FF_URLS.mom)]);
    const factors = mergeFactors(parseFrenchCsv(unzipFirst(a)), parseFrenchCsv(unzipFirst(b)));
    const rec = { fetchedAt: new Date(now).toISOString(), source: 'Kenneth R. French Data Library (Fama-French 5 factors 2x3 + momentum, daily)', factors };
    await mkdir(path.dirname(file), { recursive: true });
    await writeJsonAtomic(file, rec);
    return { success: true, errors: [], factors, fetchedAt: rec.fetchedAt, stale: false, source: rec.source };
  } catch (e) {
    if (cache) return { success: true, errors: [], factors: cache.factors, fetchedAt: cache.fetchedAt, stale: true, source: cache.source, warning: e.message };
    return { success: false, errors: [e.message] };
  }
}
