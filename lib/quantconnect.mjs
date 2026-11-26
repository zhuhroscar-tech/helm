// Helm · QuantConnect 云端客户端：把一次回测的代码快照发到用户自己的 QC 账户（建项目 → 上传 .py → 云端编译）。
// 零依赖，使用全局 fetch（Node ≥ 20）。接口文档：https://www.quantconnect.com/docs/v2/cloud-platform/api-reference
//
// 约定：
//   - QC 没有 OAuth，「登录」= User ID + API token（QC 网站 My Account → Security 里发邮件获取）。
//   - 凭据保存在 Helm 的 secrets 目录 quantconnect.json（可用 HELM_QC_FILE 覆盖），权限 0600，先写临时文件再 rename。
//   - token 本身从不发出去：每个请求只带 sha256(token:timestamp)（QC 的签名方式）；任何返回值、错误、日志里都不出现 token。
//   - 只调用 authenticate / projects/create / files/* / compile/*。不建云端回测、不碰实盘接口（live/*）。
//   - 只有网页上的用户能发送；agent 没有这个工具。
import { mkdir, readFile, writeFile, rename, rm, chmod } from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { secretFile } from './config.mjs';
import { appendLine } from './fs-atomic.mjs';

export const QC_BASE = 'https://www.quantconnect.com/api/v2';
export const QC_WEB = 'https://www.quantconnect.com';
// 允许的接口（白名单）：别的路径一律拒绝，保证这个模块不可能被用来部署实盘
const ALLOWED = new Set(['authenticate', 'projects/create', 'files/read', 'files/create', 'files/update', 'compile/create', 'compile/read']);
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_FILES = 50;
const MAX_FILE_BYTES = 1024 * 1024;

const credsFile = () => secretFile('quantconnect.json', 'HELM_QC_FILE');
const timeoutMs = () => {
  const v = Number(process.env.HELM_QC_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
};
const pollMs = () => {
  const v = Number(process.env.HELM_QC_POLL_MS);
  return Number.isFinite(v) && v >= 0 ? v : 2000;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** User ID 打码：123456 → 12**56。同步函数。 */
export function maskUserId(id) {
  const s = String(id ?? '');
  if (s.length <= 4) return '****';
  return `${s.slice(0, 2)}${'*'.repeat(Math.min(6, s.length - 4))}${s.slice(-2)}`;
}

/** QC 的签名头：Authorization: Basic base64(userId:sha256(token:ts))，Timestamp: ts。同步函数，导出给测试。 */
export function authHeaders({ userId, token }, now = Date.now()) {
  const ts = String(Math.floor(now / 1000));
  const hash = crypto.createHash('sha256').update(`${token}:${ts}`, 'utf8').digest('hex');
  return { Authorization: `Basic ${Buffer.from(`${userId}:${hash}`, 'utf8').toString('base64')}`, Timestamp: ts };
}

function scrub(text, creds) {
  let s = String(text ?? '');
  if (creds?.token) s = s.split(creds.token).join('***');
  return s.slice(0, 500);
}

/** 发一个 QC API 请求（都是 POST + JSON）。HTTP 错误或 success:false 都抛出中文错误（err.status / err.qcErrors）。 */
async function call(endpoint, body, creds) {
  if (!ALLOWED.has(endpoint)) throw new Error(`Helm 不允许调用 QuantConnect 接口 ${endpoint}`);
  const url = `${QC_BASE}/${endpoint}`;
  if (!url.startsWith(`${QC_BASE}/`) || new URL(url).origin !== new URL(QC_BASE).origin) throw new Error('QuantConnect 接口地址不对');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs());
  let res; let text;
  try {
    res = await fetch(url, { method: 'POST', headers: { ...authHeaders(creds), 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body || {}), signal: ctl.signal, redirect: 'error' });
    text = await res.text();
  } catch (e) {
    throw Object.assign(new Error(e.name === 'AbortError' ? `连接 QuantConnect 超时（${Math.round(timeoutMs() / 1000)} 秒）` : `连不上 QuantConnect：${scrub(e.message, creds)}`), { status: 0 });
  } finally { clearTimeout(timer); }
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error('QuantConnect 拒绝了这组凭据（User ID 或 API token 不对，或电脑时间偏差太大）'), { status: res.status });
  let j = null;
  try { j = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!res.ok) throw Object.assign(new Error(`QuantConnect 返回 HTTP ${res.status}：${scrub(j?.errors?.join('; ') || text, creds)}`), { status: res.status });
  if (!j || typeof j !== 'object') throw Object.assign(new Error('QuantConnect 返回的不是 JSON'), { status: res.status });
  if (j.success === false) {
    const errs = Array.isArray(j.errors) ? j.errors.map((x) => scrub(x, creds)) : [];
    throw Object.assign(new Error(errs.join('; ') || `QuantConnect ${endpoint} 失败`), { status: res.status, qcErrors: errs });
  }
  return j;
}

/* ---------------- 凭据 ---------------- */

export async function loadCreds() {
  try {
    const j = JSON.parse(await readFile(credsFile(), 'utf8'));
    if (typeof j?.userId === 'string' && typeof j?.token === 'string' && j.userId && j.token) return { userId: j.userId, token: j.token };
    return null;
  } catch { return null; }
}

async function writeCredsAtomic(creds) {
  const file = credsFile();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify({ userId: creds.userId, token: creds.token, savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/** 先调用 /authenticate 验证，成功才保存。失败时不写任何东西。 */
export async function saveCreds({ userId, token } = {}) {
  const u = typeof userId === 'string' ? userId.trim() : String(userId ?? '').trim();
  const t = typeof token === 'string' ? token.trim() : '';
  const errors = [];
  if (!/^\d{1,12}$/.test(u)) errors.push('User ID 应该是一串数字（在 QuantConnect 发给你的邮件里）');
  if (!t) errors.push('请填写 API token');
  else if (t.length < 16 || /\s/.test(t)) errors.push('API token 格式不对（应是一长串没有空格的字符）');
  if (errors.length) return { success: false, errors };
  try { await call('authenticate', {}, { userId: u, token: t }); } catch (e) { return { success: false, errors: [`QuantConnect 验证失败：${e.message}`] }; }
  try { await writeCredsAtomic({ userId: u, token: t }); } catch (e) { return { success: false, errors: [`凭据保存失败：${e.message}`] }; }
  return { success: true, errors: [], status: { connected: true, userIdMasked: maskUserId(u) } };
}

export async function clearCreds() {
  await rm(credsFile(), { force: true });
  return { success: true, errors: [] };
}

/** 连接状态。默认不联网（只看有没有保存的凭据）；verify=true 时调用 /authenticate 确认。 */
export async function status({ verify = false } = {}) {
  const c = await loadCreds();
  if (!c) return { connected: false };
  const userIdMasked = maskUserId(c.userId);
  if (!verify) return { connected: true, userIdMasked };
  try { await call('authenticate', {}, c); return { connected: true, userIdMasked, verified: true }; } catch (e) { return { connected: false, userIdMasked, error: e.message }; }
}

/* ---------------- 发送 ---------------- */

/** helm_data 依赖检测（和网页上的提示同一套规则）。同步函数。 */
export function helmDataUsage(files = []) {
  const py = files.filter((f) => /\.py$/i.test(f.name));
  const used = [...new Set(py.flatMap((f) => String(f.content).match(/\bHelm(?:Signals|Universe|Macro|Dataset)\b/g) || []))];
  const imports = py.some((f) => /^\s*(?:from|import)\s+helm_data\b/m.test(String(f.content)));
  return { uses: used.length > 0 || imports, classes: used, imports };
}

/** QC 项目名：「Helm/<项目名> <回测号前 6 位> <时间>」，去掉 QC 不接受的字符。同步函数。 */
export function qcProjectName(projectName, backtestId, now = new Date()) {
  const clean = String(projectName || 'Helm project').replace(/[^\p{L}\p{N} _.-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Helm project';
  const stamp = now.toISOString().slice(0, 16).replace('T', ' ').replace(':', '');
  return `Helm/${clean} ${String(backtestId || '').slice(0, 6)} ${stamp}`.trim();
}

function checkFiles(files) {
  const py = (Array.isArray(files) ? files : []).filter((f) => f && /\.py$/i.test(f.name));
  if (!py.length) return { error: '这次回测的代码快照里没有 .py 文件' };
  if (py.length > MAX_FILES) return { error: `文件太多（${py.length} 个，上限 ${MAX_FILES}）` };
  for (const f of py) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*\.py$/.test(f.name)) return { error: `文件名不能发到 QuantConnect：${f.name}` };
    if (Buffer.byteLength(String(f.content), 'utf8') > MAX_FILE_BYTES) return { error: `文件太大：${f.name}` };
  }
  if (!py.some((f) => f.name === 'main.py')) return { error: '代码快照里没有 main.py（QuantConnect 从 main.py 启动）' };
  return { py };
}

/**
 * 建 QC 项目、上传全部 .py、云端编译。
 * 返回 { success, errors, project: { projectId, name, url }, uploaded: [...], compile: { state, compileId, logs } }。
 * 编译失败不算发送失败：项目已经建好，success 仍为 true，compile.state = 'BuildError'，logs 里是错误。
 */
export async function pushProject({ name, files, compile = true, maxPollMs = 90000 } = {}) {
  const creds = await loadCreds();
  if (!creds) return { success: false, errors: ['还没有连接 QuantConnect 账户'] };
  const chk = checkFiles(files);
  if (chk.error) return { success: false, errors: [chk.error] };
  let project;
  try {
    const r = await call('projects/create', { name: String(name), language: 'Py' }, creds);
    const p = Array.isArray(r.projects) ? r.projects[0] : null;
    if (!p || !Number.isSafeInteger(Number(p.projectId))) throw new Error('QuantConnect 没有返回项目编号');
    project = { projectId: Number(p.projectId), name: p.name || String(name), url: `${QC_WEB}/project/${Number(p.projectId)}` };
  } catch (e) { return { success: false, errors: [`在 QuantConnect 建项目失败：${e.message}`] }; }

  // 新建的 Py 项目自带 main.py（和 research.ipynb）：已存在的文件用 update，其余 create
  let existing = new Set(['main.py']);
  try {
    const r = await call('files/read', { projectId: project.projectId }, creds);
    if (Array.isArray(r.files)) existing = new Set(r.files.map((f) => f.name));
  } catch { /* 读不到就按默认（只有 main.py） */ }
  const uploaded = [];
  for (const f of chk.py) {
    const body = { projectId: project.projectId, name: f.name, content: String(f.content), codeSourceId: 'Helm' };
    try {
      if (existing.has(f.name)) await call('files/update', body, creds);
      else {
        try { await call('files/create', body, creds); } catch (e) {
          if (!/exist/i.test(e.message)) throw e;
          await call('files/update', body, creds);
        }
      }
      uploaded.push(f.name);
    } catch (e) {
      return { success: false, errors: [`上传 ${f.name} 失败：${e.message}（QuantConnect 上已建好项目，可以打开看看）`], project, uploaded };
    }
  }
  if (!compile) return { success: true, errors: [], project, uploaded, compile: null };

  let c;
  try {
    c = await call('compile/create', { projectId: project.projectId }, creds);
  } catch (e) {
    return { success: true, errors: [], project, uploaded, compile: { state: 'Unknown', compileId: null, logs: [], error: `没能开始编译：${e.message}` } };
  }
  const compileId = c.compileId;
  let state = c.state || 'InQueue';
  let logs = Array.isArray(c.logs) ? c.logs : [];
  let error = null;
  const t0 = Date.now();
  while (state === 'InQueue' && compileId && Date.now() - t0 < maxPollMs) {
    await sleep(pollMs());
    try {
      const r = await call('compile/read', { projectId: project.projectId, compileId }, creds);
      state = r.state || state;
      if (Array.isArray(r.logs)) logs = r.logs;
    } catch (e) { error = `读取编译结果失败：${e.message}`; break; }
  }
  if (!error && state === 'InQueue') error = '编译还在排队，请到 QuantConnect 上查看结果';
  return { success: true, errors: [], project, uploaded, compile: { state, compileId: compileId || null, logs: logs.map((l) => String(l).slice(0, 2000)).slice(-60), error } };
}

/** 记一笔发送记录（append-only）：projects/<id>/qc-exports.jsonl。不含任何凭据。 */
export async function logExport(projectsDir, projectId, entry) {
  const file = path.join(projectsDir, String(projectId), 'qc-exports.jsonl');
  await appendLine(file, JSON.stringify({ at: new Date().toISOString(), ...entry }));
}

export async function listExports(projectsDir, projectId, backtestId) {
  try {
    const lines = (await readFile(path.join(projectsDir, String(projectId), 'qc-exports.jsonl'), 'utf8')).split('\n');
    return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x && (!backtestId || x.backtestId === backtestId));
  } catch { return []; }
}
