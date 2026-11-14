// 回测指纹：记下一次回测到底跑在哪版代码、哪份数据上。
// 数据被悄悄重新下载（Yahoo 修正历史、qlib 重新导出）或代码改了，结果会变；有了指纹就能发现。
//
// LEAN 日线数据：<data>/equity/usa/daily/<sym>.zip，里面只有一个 <sym>.csv，
// 每行 "yyyyMMdd 00:00,O,H,L,C,V"（价格 ×1e4）。zip 本身带写入时间，同样的数据重新打包字节也会变，
// 所以哈希的是解压后的 CSV 内容，不是 zip 文件。
// 这个模块不依赖 engine.mjs（避免循环引用），数据目录由调用方传入，测试可以用临时目录。
import { readFile, writeFile, stat, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const FINGERPRINT_VERSION = 1;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Yahoo 用 BRK-B，LEAN 用 brk.b（和 engine/fetch_data.py 的 lean_symbol 一致）
export const leanSymbol = (t) => String(t).trim().toUpperCase().replace(/-/g, '.').toLowerCase();
export const dailyFile = (t) => `equity/usa/daily/${leanSymbol(t)}.zip`;

/* ---------------- 代码 ---------------- */

// files: [{ name, content }]。按文件名排序后把 名字 + 内容 一起哈希，另外给每个文件单独一个哈希。
// 只算 .py：spec.md 这类规则说明不参与回测，改它不算改代码
export function codeFingerprint(files) {
  const sorted = [...(files || [])].filter((f) => f && f.name && /\.py$/.test(f.name)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const h = crypto.createHash('sha256');
  const per = {};
  for (const f of sorted) {
    const content = String(f.content ?? '');
    per[f.name] = sha256(content);
    h.update(`${f.name}\0${content}\0`);
  }
  return { hash: h.digest('hex'), files: per };
}

/* ---------------- 读 zip（只认 LEAN 数据用到的单文件 zip：stored / deflate） ---------------- */

export function unzipFirst(buf) {
  // 先找中央目录结尾记录（EOCD），从中央目录拿大小和偏移，不依赖本地头里的大小（可能用了 data descriptor）
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是 zip 文件');
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cdOff) !== 0x02014b50) throw new Error('zip 中央目录损坏');
  const method = buf.readUInt16LE(cdOff + 10);
  const csize = buf.readUInt32LE(cdOff + 20);
  const usize = buf.readUInt32LE(cdOff + 24);
  const lho = buf.readUInt32LE(cdOff + 42);
  if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error('zip 本地头损坏');
  const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
  const raw = buf.subarray(start, start + csize);
  if (method === 0) return raw;
  if (method === 8) return zlib.inflateRawSync(raw, usize > 0 ? { maxOutputLength: Math.max(usize, 1) } : {});
  throw new Error(`不支持的压缩方式 ${method}`);
}

const NL = 10;
const lean8 = (s) => (/^\d{8}/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null);

// 一份 LEAN 日线 CSV 的摘要：内容哈希、首末日期、行数
export function csvSummary(csv) {
  let rows = 0;
  let firstStart = -1;
  let lastStart = -1;
  let lineStart = 0;
  for (let i = csv.indexOf(NL); ; i = csv.indexOf(NL, i + 1)) {
    const end = i < 0 ? csv.length : i;
    if (end > lineStart) { rows += 1; if (firstStart < 0) firstStart = lineStart; lastStart = lineStart; }
    if (i < 0) break;
    lineStart = i + 1;
  }
  const head = (at) => (at < 0 ? '' : csv.toString('latin1', at, Math.min(at + 8, csv.length)));
  return { sha256: sha256(csv), firstDate: lean8(head(firstStart)), lastDate: lean8(head(lastStart)), rows };
}

/* ---------------- 缓存：按 路径 + 大小 + 修改时间，文件没动就不重新解压 ---------------- */

async function loadCache(file) {
  if (!file) return { file: null, map: {}, dirty: false };
  try { return { file, map: JSON.parse(await readFile(file, 'utf8')).entries || {}, dirty: false }; } catch { return { file, map: {}, dirty: false }; }
}
async function saveCache(c) {
  if (!c.file || !c.dirty) return;
  try {
    await mkdir(path.dirname(c.file), { recursive: true });
    const tmp = `${c.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: FINGERPRINT_VERSION, entries: c.map }));
    await rename(tmp, c.file);
  } catch { /* 缓存写不进去不影响结果 */ }
}
async function cached(c, abs, kind, compute) {
  let st;
  try { st = await stat(abs); } catch { return null; }
  const key = `${kind}:${abs}`;
  const hit = c.map[key];
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.v;
  const v = await compute();
  c.map[key] = { size: st.size, mtimeMs: st.mtimeMs, v };
  c.dirty = true;
  return v;
}

/* ---------------- 数据 ---------------- */

function csvColumn0(text) {
  const out = new Set();
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    const j = l.indexOf(',');
    if (j > 0) out.add(l.slice(0, j).trim());
  }
  return out;
}
function csvColumn(text, col) {
  const out = new Set();
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length > col && parts[col]) out.add(parts[col].trim());
  }
  return out;
}

// 策略会订阅哪些代码：代码里写死的（baseTickers，来自 engine.tickersInCode）+ HelmUniverse 的全部历史成员
// + HelmSignals 打分里出现的代码（信号的 json 写了 universe 就用那个股票池的成员，否则读信号 CSV 的 ticker 列）。
// 股票池 / 信号文件本身也记一份哈希：成员名单或打分变了同样会改变结果。
export async function strategyInputs({ dataDir, code, baseTickers = [], cache }) {
  const c = cache || { map: {}, dirty: false };
  const src = String(code || '');
  const uniKeys = [...new Set([...src.matchAll(/HelmUniverse\(\s*["']([A-Za-z0-9_]{2,20})["']/g)].map((m) => m[1]))];
  const sigNames = [...new Set([...src.matchAll(/HelmSignals\(\s*["']([A-Za-z0-9_]{3,60})["']/g)].map((m) => m[1]))];
  const tickers = new Set(baseTickers.map((t) => String(t).toUpperCase()));
  const files = [];
  const uniTickers = async (key) => {
    const rel = `helm/universes/${key}.csv`;
    const v = await cached(c, path.join(dataDir, rel), 'uni', async () => [...csvColumn0(await readFile(path.join(dataDir, rel), 'utf8'))]);
    return { rel, list: v };
  };
  for (const key of uniKeys) {
    const { rel, list } = await uniTickers(key);
    files.push(rel);
    for (const t of list || []) tickers.add(t.toUpperCase());
  }
  for (const name of sigNames) {
    const rel = `helm/signals/${name}.csv`;
    files.push(rel, `helm/signals/${name}.json`);
    let meta = null;
    try { meta = JSON.parse(await readFile(path.join(dataDir, 'helm', 'signals', `${name}.json`), 'utf8')); } catch { /* 没有说明文件 */ }
    let list = null;
    if (meta && meta.universe && /^[A-Za-z0-9_]{2,20}$/.test(meta.universe)) {
      const u = await uniTickers(meta.universe);
      if (u.list) { list = u.list; files.push(u.rel); }
    }
    if (!list) list = await cached(c, path.join(dataDir, rel), 'sigtk', async () => [...csvColumn(await readFile(path.join(dataDir, rel), 'utf8'), 1)]);
    for (const t of list || []) tickers.add(t.toUpperCase());
  }
  // FRED 宏观序列文件：数值被修订或更新同样会改变结果
  for (const m of src.matchAll(/HelmMacro\(\s*["']([A-Za-z0-9_]{2,30})["']/g)) files.push(`helm/macro/${m[1].toUpperCase()}.csv`);
  // 自建数据集：内容和说明（版本号在说明文件里）都记一份哈希，重新保存或换版本都会改变指纹
  for (const m of src.matchAll(/HelmDataset\(\s*["']([A-Za-z0-9_]{2,40})["']/g)) files.push(`helm/custom/${m[1]}.csv`, `helm/custom/${m[1]}.meta.json`);
  return { tickers: [...tickers].sort(), files: [...new Set(files)].sort() };
}

// tickers：代码列表；files：额外要哈希的数据文件（相对 dataDir，比如股票池 CSV）。
// 缺失的文件记成 { missing: true }，不报错。
export async function dataFingerprint({ dataDir, tickers = [], files = [], cacheFile } = {}) {
  const t0 = Date.now();
  const c = await loadCache(cacheFile);
  const out = { hash: null, tickers: {}, files: {}, missing: [], count: 0, ms: 0 };
  const list = [...new Set(tickers.map((t) => String(t).toUpperCase()))].sort();
  const queue = [...list];
  const worker = async () => {
    while (queue.length) {
      const t = queue.shift();
      const rel = dailyFile(t);
      const abs = path.join(dataDir, rel);
      let v = null;
      try { v = await cached(c, abs, 'daily', async () => csvSummary(unzipFirst(await readFile(abs)))); } catch (e) { v = { error: String(e.message || e).slice(0, 120) }; }
      out.tickers[t] = v ? { file: rel, ...v } : { file: rel, missing: true };
      if (!v) out.missing.push(t);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  for (const rel of [...new Set(files)].sort()) {
    const abs = path.join(dataDir, rel);
    let v = null;
    try {
      v = await cached(c, abs, 'file', async () => {
        const buf = await readFile(abs);
        let rows = 0;
        for (let i = buf.indexOf(NL); i >= 0; i = buf.indexOf(NL, i + 1)) rows += 1;
        return { sha256: sha256(buf), rows };
      });
    } catch { v = null; }
    out.files[rel] = v || { missing: true };
  }
  await saveCache(c);
  const h = crypto.createHash('sha256');
  for (const t of list) { const x = out.tickers[t]; h.update(`${t}\0${x.sha256 || (x.missing ? 'MISSING' : 'ERROR')}\n`); }
  for (const rel of Object.keys(out.files).sort()) h.update(`${rel}\0${out.files[rel].sha256 || 'MISSING'}\n`);
  out.hash = h.digest('hex');
  out.missing.sort();
  out.count = list.length;
  out.ms = Date.now() - t0;
  return out;
}

/* ---------------- 比较 ---------------- */

// 一只股票两次的数据为什么不同：
// extended = 起点相同、终点更晚（多半只是补了新交易日；只凭摘要无法证明旧数据没被改）
// altered  = 日期范围和行数完全一样，内容却变了（历史价格被修正过，最值得注意）
function tickerChange(t, a, b) {
  if (!a || a.missing) return { ticker: t, kind: b && !b.missing ? 'added' : 'missing', before: a || null, after: b || null };
  if (!b || b.missing) return { ticker: t, kind: 'removed', before: a, after: b || null };
  let kind = 'changed';
  if (a.firstDate === b.firstDate && a.lastDate === b.lastDate && a.rows === b.rows) kind = 'altered';
  else if (a.firstDate === b.firstDate && String(b.lastDate) > String(a.lastDate) && b.rows > a.rows) kind = 'extended';
  else if (a.firstDate === b.firstDate && String(b.lastDate) < String(a.lastDate)) kind = 'shortened';
  const pick = (x) => ({ firstDate: x.firstDate, lastDate: x.lastDate, rows: x.rows, sha256: x.sha256 ? x.sha256.slice(0, 12) : null });
  return { ticker: t, kind, before: pick(a), after: pick(b) };
}

export const CHANGE_ZH = {
  altered: '同一段日期内价格被改过', extended: '数据变长（多半只是补了新交易日）', shortened: '数据变短', changed: '起点或行数变了',
  added: '这次才有数据', removed: '这次缺数据', missing: '两次都缺数据',
  newTicker: '这次多订阅的代码', droppedTicker: '这次不再订阅的代码',
};

export function diffData(ref, cur) {
  if (!ref || !cur) return null;
  const changed = [];
  const keys = [...new Set([...Object.keys(ref.tickers || {}), ...Object.keys(cur.tickers || {})])].sort();
  for (const t of keys) {
    const a = (ref.tickers || {})[t];
    const b = (cur.tickers || {})[t];
    if (a && b && a.sha256 && a.sha256 === b.sha256) continue;
    if (a && b && a.missing && b.missing) continue;
    if (!a && b) { changed.push({ ticker: t, kind: 'newTicker', before: null, after: { firstDate: b.firstDate, lastDate: b.lastDate, rows: b.rows } }); continue; }
    if (a && !b) { changed.push({ ticker: t, kind: 'droppedTicker', before: { firstDate: a.firstDate, lastDate: a.lastDate, rows: a.rows }, after: null }); continue; }
    changed.push(tickerChange(t, a, b));
  }
  const files = [];
  for (const f of [...new Set([...Object.keys(ref.files || {}), ...Object.keys(cur.files || {})])].sort()) {
    const a = (ref.files || {})[f];
    const b = (cur.files || {})[f];
    if (!a || !b || a.sha256 !== b.sha256) files.push({ file: f, before: a ? { rows: a.rows ?? null, missing: Boolean(a.missing) } : null, after: b ? { rows: b.rows ?? null, missing: Boolean(b.missing) } : null });
  }
  return { changed, files };
}

export function diffCode(ref, cur) {
  const a = (ref && ref.files) || {};
  const b = (cur && cur.files) || {};
  const out = [];
  for (const f of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (a[f] === b[f]) continue;
    out.push({ file: f, kind: !a[f] ? 'added' : !b[f] ? 'removed' : 'modified' });
  }
  return out;
}

// 拿这次回测和同项目的其他回测比：
//   代码相同（同一个入口文件、同一个代码哈希）的回测里，数据哈希不同 → dataChanged，列出变了的代码
//   找不到代码相同的回测 → codeChanged（和上一次有指纹的回测比，列出改了哪些文件）或 first
export function fingerprintCheck(meta, others, { limit = 60 } = {}) {
  const fp = meta && meta.fingerprint;
  if (!fp || !fp.code) return { status: 'none' };
  const entry = (m) => m.file || 'main.py';
  const ts = (m) => String(m.created || '');
  const pool = (others || []).filter((o) => o && o.backtestId !== meta.backtestId && o.fingerprint && o.fingerprint.code);
  const nearest = (arr) => {
    const before = arr.filter((o) => ts(o) <= ts(meta)).sort((x, y) => ts(y).localeCompare(ts(x)));
    if (before.length) return before[0];
    return arr.sort((x, y) => ts(x).localeCompare(ts(y)))[0] || null;
  };
  const ref0 = (o) => ({ backtestId: o.backtestId, name: o.name, created: o.created });
  const same = pool.filter((o) => o.fingerprint.code.hash === fp.code.hash && entry(o) === entry(meta));
  if (same.length) {
    if (!fp.data) return { status: 'pending', sameCodePeers: same.length };
    const withData = same.filter((o) => o.fingerprint.data && o.fingerprint.data.hash);
    const differ = withData.filter((o) => o.fingerprint.data.hash !== fp.data.hash);
    if (!differ.length) return { status: 'same', sameCodePeers: same.length, sameDataPeers: withData.length };
    const ref = nearest(differ);
    const d = diffData(ref.fingerprint.data, fp.data);
    return {
      status: 'dataChanged', message: '同样的代码，数据和之前不同',
      sameCodePeers: same.length, differentDataPeers: differ.length, ref: ref0(ref),
      changedCount: d.changed.length, changed: d.changed.slice(0, limit), changedFiles: d.files,
      altered: d.changed.filter((x) => x.kind === 'altered').length,
    };
  }
  const prev = nearest(pool.filter((o) => ts(o) <= ts(meta)));
  if (!prev) return { status: 'first' };
  return { status: 'codeChanged', ref: ref0(prev), codeFiles: diffCode(prev.fingerprint.code, fp.code), entryChanged: entry(prev) !== entry(meta) };
}
