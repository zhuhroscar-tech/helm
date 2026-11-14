// FRED 宏观序列（利率、信用利差、收益率曲线……）下载到 LEAN 数据目录 helm/macro/<ID>.csv，
// 策略里用 helm_data.HelmMacro("<ID>") 读取（只给当时已经公布的值）。FRED 的 CSV 接口免费、不需要密钥。
import { mkdir, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import path from 'node:path';

const UA = 'HelmConsole/1.0 (personal research tool)';
export const SERIES_ID = /^[A-Za-z0-9_]{2,30}$/;
const FRESH_MS = 20 * 3600 * 1000;

export const macroDir = (dataDir) => path.join(dataDir, 'helm', 'macro');

/** 代码里 HelmMacro("X") 用到的序列 */
export function macroInCode(code) {
  return [...new Set([...String(code || '').matchAll(/HelmMacro\(\s*["']([A-Za-z0-9_]{2,30})["']/g)].map((m) => m[1].toUpperCase()))];
}

/** 解析 FRED CSV（observation_date,ID）；缺失值「.」跳过 */
export function parseFredCsv(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/).slice(1)) {
    const [d, v] = line.split(',');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) continue;
    const x = Number(v);
    if (v === undefined || v.trim() === '.' || v.trim() === '' || !Number.isFinite(x)) continue;
    rows.push([d, x]);
  }
  return rows;
}

/** 相邻观测的中位间隔（天）：1 = 日度，7 = 周度，约 30 = 月度 */
export function medianGapDays(rows) {
  const g = [];
  for (let i = 1; i < rows.length; i++) g.push((Date.parse(rows[i][0]) - Date.parse(rows[i - 1][0])) / 86400000);
  if (!g.length) return null;
  g.sort((a, b) => a - b);
  return g[Math.floor(g.length / 2)];
}

async function download(id, fetchImpl) {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}`;
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 60000);
      const r = await fetchImpl(url, { headers: { 'User-Agent': UA }, signal: ctl.signal }).finally(() => clearTimeout(t));
      if (r.status === 404) throw Object.assign(new Error(`FRED 没有序列 ${id}`), { fatal: true });
      if (!r.ok) throw new Error(`FRED 返回 ${r.status}`);
      const text = await r.text();
      if (!/^observation_date,|^DATE,/i.test(text)) throw Object.assign(new Error(`FRED 没有序列 ${id}（返回的不是 CSV）`), { fatal: true });
      return text;
    } catch (e) { last = e; if (e.fatal) break; }
  }
  throw last;
}

/** 下载或更新序列。20 小时内下载过的不重复下载（force 例外）。 */
export async function fetchMacro(series, { dataDir, force = false, fetchImpl = fetch } = {}) {
  if (!dataDir) throw new Error('需要 dataDir');
  const dir = macroDir(dataDir);
  await mkdir(dir, { recursive: true });
  const results = [];
  for (const raw of [...new Set((series || []).map((s) => String(s).toUpperCase()))]) {
    if (!SERIES_ID.test(raw)) { results.push({ id: raw, status: 'error', error: '序列代码只能是字母、数字、下划线' }); continue; }
    const csv = path.join(dir, `${raw}.csv`);
    try {
      if (!force) {
        const st = await stat(csv).catch(() => null);
        if (st && Date.now() - st.mtimeMs < FRESH_MS) { results.push({ id: raw, status: 'cached', ...(await readMeta(dir, raw)) }); continue; }
      }
      const rows = parseFredCsv(await download(raw, fetchImpl));
      if (!rows.length) throw new Error(`序列 ${raw} 没有数据`);
      await writeFile(csv, `date,value\n${rows.map(([d, v]) => `${d},${v}`).join('\n')}\n`);
      const meta = { id: raw, source: 'FRED', fetched: new Date().toISOString(), rows: rows.length, start: rows[0][0], end: rows[rows.length - 1][0], gapDays: medianGapDays(rows) };
      await writeFile(path.join(dir, `${raw}.json`), JSON.stringify(meta, null, 1));
      results.push({ status: 'ok', ...meta });
    } catch (e) {
      const have = await stat(csv).catch(() => null);
      results.push({ id: raw, status: 'error', error: String(e.message || e), ...(have ? { stale: true, ...(await readMeta(dir, raw)) } : {}) });
    }
  }
  return { results };
}

async function readMeta(dir, id) {
  try { const m = JSON.parse(await readFile(path.join(dir, `${id}.json`), 'utf8')); return { rows: m.rows, start: m.start, end: m.end, gapDays: m.gapDays, fetched: m.fetched }; } catch { return {}; }
}

export async function listMacro({ dataDir }) {
  const dir = macroDir(dataDir);
  const out = [];
  for (const f of await readdir(dir).catch(() => [])) if (f.endsWith('.json')) { const id = f.slice(0, -5); out.push({ id, ...(await readMeta(dir, id)) }); }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
