// 自建数据集：agent 从网上查到的事件、公司属性、时间序列，整理成表存进 LEAN 数据目录 helm/custom/<name>.csv，
// 策略里用 helm_data.HelmDataset("<name>") 读取。每一行必须有 available_date（信息第一次公开的日期），
// 读取时只给「严格早于今天」公开的行，没有前视。这个模块不依赖 engine.mjs，数据目录由调用方传入，测试可以用临时目录。
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const NAME_RE = /^[a-z0-9_]{2,40}$/;
export const KINDS = ['events', 'attributes', 'timeseries'];
export const MAX_ROWS = 50000;
export const MAX_BYTES = 5 * 1024 * 1024;
const MAX_SOURCES = 200;
const MAX_BAD = 8;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.\-]{0,11}$/;

// 各类数据集的列（存盘顺序）：必填 / 可选
const SCHEMA = {
  events: { need: ['available_date', 'event', 'source'], opt: ['symbol', 'value'], key: 'event' },
  attributes: { need: ['available_date', 'symbol', 'field', 'value', 'source'], opt: [], key: 'field' },
  timeseries: { need: ['available_date', 'date', 'value', 'source'], opt: ['symbol'], key: 'date' },
};
const COLS = {
  events: ['available_date', 'symbol', 'event', 'value', 'source'],
  attributes: ['available_date', 'symbol', 'field', 'value', 'source'],
  timeseries: ['available_date', 'date', 'symbol', 'value', 'source'],
};

export const customDir = (dataDir) => path.join(dataDir, 'helm', 'custom');
export const datasetsInCode = (code) => [...new Set([...String(code || '').matchAll(/HelmDataset\(\s*["']([A-Za-z0-9_]{2,40})["']/g)].map((m) => m[1]))];

// 敏感特征的兜底检查：Helm 不收集、不推断具体个人的健康、残疾、宗教、性取向等特征。主要靠 agent 提示词，这里只是挡一道。
const SENSITIVE = /自闭症|孤独症|残疾|疾病|病史|患病|健康状况|确诊|诊断为|被诊断|宗教|信仰|性取向|同性恋|跨性别|\bautis|\bdisabilit|\bdisabled\b|\bdiagnos(?:is|ed|es)\b|medical (?:history|condition)|health condition|\breligio|sexual orientation|\bgay\b|\blesbian\b|transgender/i;
const sensitiveMsg = (where, hit) => `不能保存：${where}涉及个人的健康、残疾、宗教、性取向等敏感特征（命中「${hit}」）。Helm 不收集、也不推断具体个人的这类信息。可以改成公司层面、公开能查到的代理指标（如公司披露的员工福利政策、ESG 评级、行业分类）。`;

// 美东日期（市场日期）：UTC 日期在美国晚上会提前一天，在东八区早上会晚一天
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const validDate = (s) => {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && s >= '1900-01-01';
};
const isHttp = (u) => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } };
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const numLike = (s) => /^\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?\s*$/i.test(s);

/** 校验并整理。返回 { errors, sources, rows, columns }；errors 非空就不能保存。 */
export function validateDataset(input) {
  const errors = [];
  const a = input && typeof input === 'object' ? input : {};
  const name = String(a.name ?? '');
  const kind = a.kind;
  if (!NAME_RE.test(name)) errors.push('name 只能用小写字母、数字、下划线，长度 2–40（如 sp500_adds）');
  if (!KINDS.includes(kind)) errors.push(`kind 只能是 ${KINDS.join(' / ')}`);
  const desc = typeof a.description === 'string' ? a.description.trim() : '';
  if (!desc) errors.push('缺少 description（一句话说明这份数据是什么、覆盖哪些年份和公司）');
  const notes = typeof a.notes === 'string' ? a.notes.trim() : '';
  const columns = Array.isArray(a.columns) ? a.columns.map(String) : null;
  if (!columns || !columns.length) errors.push('缺少 columns（列名数组）');
  if (!Array.isArray(a.rows) || !a.rows.length) errors.push('rows 必须是非空数组');
  if (Array.isArray(a.rows) && a.rows.length > MAX_ROWS) errors.push(`行数太多：${a.rows.length}，最多 ${MAX_ROWS} 行`);
  // 敏感特征
  for (const [where, text] of [['数据集名', name], ['说明', desc], ['列名', (columns || []).join(' ')]]) {
    const m = SENSITIVE.exec(text);
    if (m) return { errors: [sensitiveMsg(where, m[0])] };
  }
  // 来源
  const sources = [];
  if (!Array.isArray(a.sources) || !a.sources.length) errors.push('缺少 sources：每份数据都要有来源网址（url、title、retrieved_at）');
  else if (a.sources.length > MAX_SOURCES) errors.push(`来源太多：最多 ${MAX_SOURCES} 个`);
  else {
    a.sources.forEach((s, i) => {
      const o = s && typeof s === 'object' ? s : {};
      const retrieved = typeof o.retrieved_at === 'string' ? o.retrieved_at.slice(0, 10) : '';
      if (!isHttp(o.url)) errors.push(`sources[${i}].url 必须是 http(s) 网址`);
      else if (!validDate(retrieved)) errors.push(`sources[${i}].retrieved_at 必须是 YYYY-MM-DD（你查到它的日期）`);
      else sources.push({ url: String(o.url).slice(0, 500), title: String(o.title || '').slice(0, 200), retrieved_at: retrieved });
    });
  }
  if (errors.length || !KINDS.includes(kind)) return { errors };
  const sch = SCHEMA[kind];
  const allowed = new Set([...sch.need, ...sch.opt]);
  for (const c of sch.need) if (!columns.includes(c)) errors.push(`columns 缺少必填列 ${c}（${kind} 需要：${sch.need.join('、')}${sch.opt.length ? `；可选：${sch.opt.join('、')}` : ''}）`);
  for (const c of columns) if (!allowed.has(c)) errors.push(`columns 里有不支持的列 ${c}（${kind} 只支持：${[...allowed].join('、')}）`);
  if (errors.length) return { errors };

  const bad = [];
  const note = (i, why) => { if (bad.length < MAX_BAD) bad.push(`第 ${i + 1} 行：${why}`); else if (bad.length === MAX_BAD) bad.push('……（还有更多错误行）'); };
  const seen = new Set();
  const out = [];
  const todayS = today();
  const srcIdx = new Map(sources.map((s, i) => [s.url, i]));
  a.rows.forEach((raw, i) => {
    const r = Array.isArray(raw) ? Object.fromEntries(columns.map((c, j) => [c, raw[j]])) : raw;
    if (!r || typeof r !== 'object') return note(i, '不是对象');
    for (const k of Object.keys(r)) if (!allowed.has(k)) return note(i, `有不支持的列 ${k}`);
    const ad = r.available_date;
    if (ad === undefined || ad === null || ad === '') return note(i, '缺少 available_date（信息第一次公开的日期）');
    if (!validDate(ad)) return note(i, `available_date「${ad}」不是有效的 YYYY-MM-DD 日期`);
    if (ad > todayS) return note(i, `available_date ${ad} 在未来：公开日期不可能晚于今天`);
    let symbol = '';
    if (r.symbol !== undefined && r.symbol !== null && r.symbol !== '') {
      symbol = String(r.symbol).trim().toUpperCase();
      if (!SYMBOL_RE.test(symbol)) return note(i, `symbol「${r.symbol}」不是美股代码（要和 fetch_data 用的一样，如 AAPL、BRK-B）`);
    } else if (kind === 'attributes') return note(i, '缺少 symbol');
    let src = r.source;
    if (typeof src === 'string' && isHttp(src)) {
      if (!srcIdx.has(src)) { if (sources.length >= MAX_SOURCES) return note(i, '来源太多'); srcIdx.set(src, sources.length); sources.push({ url: src.slice(0, 500), title: '', retrieved_at: todayS }); }
      src = srcIdx.get(src);
    }
    if (!Number.isInteger(src) || src < 0 || src >= sources.length) return note(i, `source「${r.source}」不是 sources 里的序号（0–${sources.length - 1}）或网址`);
    let key = '';
    if (kind === 'events') {
      key = typeof r.event === 'string' ? r.event.trim() : '';
      if (!key) return note(i, '缺少 event');
    } else if (kind === 'attributes') {
      key = typeof r.field === 'string' ? r.field.trim() : '';
      if (!key) return note(i, '缺少 field');
    } else {
      if (!validDate(r.date)) return note(i, `date「${r.date}」不是有效的 YYYY-MM-DD 日期`);
      if (r.date > ad) return note(i, `date ${r.date} 晚于 available_date ${ad}：数据所属日期之前不可能已经公开`);
      key = r.date;
    }
    if (key.length > 120) return note(i, `${kind === 'events' ? 'event' : 'field'} 太长（最多 120 字）`);
    if (kind !== 'timeseries') {
      const m = SENSITIVE.exec(key);
      if (m) { bad.length = 0; if (!errors.length) errors.push(sensitiveMsg(`${kind === 'events' ? 'event' : 'field'} 的值「${key}」`, m[0])); return; }
    }
    let value = r.value;
    const needValue = kind !== 'events';
    if (value === undefined || value === null || value === '') {
      if (needValue) return note(i, '缺少 value');
      value = '';
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) return note(i, 'value 不是有限数字');
    } else if (typeof value === 'string') {
      if (kind === 'timeseries') return note(i, 'value 必须是数字');
      if (/^\s*[-+]?(nan|inf|infinity)\s*$/i.test(value)) return note(i, 'value 不是有限数字');
      if (numLike(value) && !Number.isFinite(Number(value))) return note(i, 'value 不是有限数字');
      if (value.length > 200) return note(i, 'value 太长（最多 200 字）');
    } else return note(i, 'value 只能是数字或文字');
    const dk = `${symbol}\0${ad}\0${key}`;
    if (seen.has(dk)) return note(i, `重复：同一代码、同一 available_date、同一${kind === 'events' ? ' event' : kind === 'attributes' ? ' field' : ' date'}（${symbol || '无代码'} ${ad} ${key}）已经出现过`);
    seen.add(dk);
    out.push({ available_date: ad, symbol, event: kind === 'events' ? key : '', field: kind === 'attributes' ? key : '', date: kind === 'timeseries' ? key : '', value, source: src });
  });
  if (errors.length) return { errors };
  if (bad.length) return { errors: [`${bad.length > MAX_BAD ? `${MAX_BAD}+` : bad.length} 处错误行，整份数据没有保存：`, ...bad] };
  out.sort((x, y) => (x.available_date < y.available_date ? -1 : x.available_date > y.available_date ? 1 : 0));
  return { errors: [], sources, rows: out, kind, name, description: desc, notes, columns: COLS[kind] };
}

const toCsv = (v) => {
  const cols = v.columns;
  return `${cols.join(',')}\n${v.rows.map((r) => cols.map((c) => csvCell(r[c])).join(',')).join('\n')}\n`;
};

export async function saveDataset(input, { dataDir }) {
  const v = validateDataset(input);
  if (v.errors.length) return { success: false, errors: v.errors };
  const csv = toCsv(v);
  const buf = Buffer.from(csv, 'utf8');
  if (buf.length > MAX_BYTES) return { success: false, errors: [`数据太大：${(buf.length / 1048576).toFixed(1)} MB，最多 5 MB`] };
  const dir = customDir(dataDir);
  await mkdir(dir, { recursive: true });
  let prev = null;
  try { prev = JSON.parse(await readFile(path.join(dir, `${v.name}.meta.json`), 'utf8')); } catch { /* 第一次保存 */ }
  const now = new Date().toISOString();
  const symbols = [...new Set(v.rows.map((r) => r.symbol).filter(Boolean))];
  const meta = {
    name: v.name, description: v.description, kind: v.kind, columns: v.columns,
    sources: v.sources, notes: v.notes,
    rows: v.rows.length, symbols: symbols.length,
    firstAvailable: v.rows[0].available_date, lastAvailable: v.rows[v.rows.length - 1].available_date,
    version: prev && Number.isInteger(prev.version) ? prev.version + 1 : 1,
    created: (prev && prev.created) || now, updated: now,
    hash: sha256(buf), provenance: 'web',
  };
  const uid = `${process.pid}.${crypto.randomUUID().slice(0, 8)}`;
  const tmpC = path.join(dir, `.${v.name}.csv.${uid}.tmp`);
  const tmpM = path.join(dir, `.${v.name}.meta.${uid}.tmp`);
  await writeFile(tmpC, buf);
  await writeFile(tmpM, JSON.stringify(meta, null, 1));
  await rename(tmpC, path.join(dir, `${v.name}.csv`));
  await rename(tmpM, path.join(dir, `${v.name}.meta.json`));
  return { success: true, meta, replaced: Boolean(prev) };
}

export async function listDatasets({ dataDir }) {
  const dir = customDir(dataDir);
  let files = [];
  try { files = await readdir(dir); } catch { return { success: true, datasets: [] }; }
  const out = [];
  for (const f of files.filter((x) => x.endsWith('.meta.json') && !x.startsWith('.')).sort()) {
    try { out.push(JSON.parse(await readFile(path.join(dir, f), 'utf8'))); } catch { /* 损坏的说明文件跳过 */ }
  }
  out.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  return { success: true, datasets: out };
}

function parseCsv(text) {
  const rows = [];
  let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export async function readDataset({ dataDir, name, start = 0, limit = 100 }) {
  if (!NAME_RE.test(String(name || ''))) return { success: false, errors: ['name 不对'] };
  const dir = customDir(dataDir);
  let meta; let text;
  try { meta = JSON.parse(await readFile(path.join(dir, `${name}.meta.json`), 'utf8')); text = await readFile(path.join(dir, `${name}.csv`), 'utf8'); } catch { return { success: false, errors: [`自建数据集 ${name} 不存在`] }; }
  const all = parseCsv(text);
  const head = all[0] || [];
  const s = Math.max(0, Math.floor(Number(start) || 0));
  const l = Math.min(500, Math.max(1, Math.floor(Number(limit) || 100)));
  const rows = all.slice(1).slice(s, s + l).map((r) => Object.fromEntries(head.map((c, i) => [c, r[i]])));
  return { success: true, meta, total: Math.max(0, all.length - 1), start: s, rows };
}

/** 回测用到的自建数据集：写进回测记录，结果页据此显示版本、来源和提醒 */
export async function datasetUsage({ dataDir, names }) {
  const out = [];
  for (const name of names) {
    let m = null;
    try { m = JSON.parse(await readFile(path.join(customDir(dataDir), `${name}.meta.json`), 'utf8')); } catch { /* 不存在 */ }
    out.push(m
      ? { name, version: m.version, provenance: m.provenance || 'web', rows: m.rows, hash: String(m.hash || '').slice(0, 12), firstAvailable: m.firstAvailable, lastAvailable: m.lastAvailable, notes: m.notes || '', sources: (m.sources || []).slice(0, 50), sourceCount: (m.sources || []).length }
      : { name, missing: true });
  }
  return out;
}
