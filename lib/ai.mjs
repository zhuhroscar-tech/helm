// AI 连接：用户下载 Helm 后，选择 agent 用哪种方式调用模型。
//   auto          —— 不干预，沿用 Claude Code 自己的登录 / 环境变量（升级前的行为，默认）
//   subscription  —— 用 Claude 订阅（Pro / Max / Team）：去掉环境里的 API key，让 Claude Code 用 `claude` 登录的账号
//   apiKey        —— Anthropic API key（console.anthropic.com）
//   custom        —— 任何兼容 Anthropic Messages API 的接口（DeepSeek、Kimi、智谱 GLM、OpenRouter、自建 LiteLLM 网关……）：
//                    base URL + key + 模型名
//
// 密钥只存在 ai.json（新装在 ~/Library/Application Support/Helm/secrets，已有的 data/secrets 继续用；0600，HELM_AI_FILE 可覆盖），不进环境变量：Claude Code 通过 apiKeyHelper
// 调 lib/ai-key-helper.mjs 读出来。这样 agent 跑的命令（在沙盒里，读不到 data/secrets）也拿不到密钥，`env` 打印不出来。
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { secretFile } from './config.mjs';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const HELPER = path.join(REPO_ROOT, 'lib', 'ai-key-helper.mjs');
export const MODES = ['auto', 'subscription', 'apiKey', 'custom'];
export const ANTHROPIC_BASE = 'https://api.anthropic.com';
// 子进程环境里会影响 Claude Code 认证 / 接口地址的变量：非 auto 模式一律先去掉，再按所选模式设置
export const AUTH_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];

export const aiFile = () => secretFile('ai.json', 'HELM_AI_FILE');
const TIMEOUT_MS = () => Math.max(1000, Number(process.env.HELM_AI_TEST_TIMEOUT_MS || 20000));

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export const maskKey = (k) => (typeof k === 'string' && k.length > 8 ? `…${k.slice(-4)}` : k ? '…' : '');

/** 读取保存的设置；没有或损坏时返回 { mode: 'auto' }。 */
export async function loadAi(file = aiFile()) {
  try {
    const j = JSON.parse(await readFile(file, 'utf8'));
    if (!j || !MODES.includes(j.mode)) return { mode: 'auto' };
    return { mode: j.mode, apiKey: typeof j.apiKey === 'string' ? j.apiKey : '', baseUrl: typeof j.baseUrl === 'string' ? j.baseUrl : '',
      model: typeof j.model === 'string' ? j.model : '', savedAt: j.savedAt || null, checkedAt: j.checkedAt || null };
  } catch { return { mode: 'auto' }; }
}

/** 给网页看的：不带密钥本身，只带末 4 位。 */
export function publicView(cfg) {
  return { mode: cfg.mode, hasKey: Boolean(cfg.apiKey), keyHint: maskKey(cfg.apiKey), baseUrl: cfg.mode === 'custom' ? cfg.baseUrl : '',
    model: cfg.mode === 'custom' ? cfg.model : '', savedAt: cfg.savedAt || null, checkedAt: cfg.checkedAt || null };
}

/**
 * 启动 claude 用的东西：要删掉的环境变量、要加的环境变量、额外参数、强制模型。
 * file：apiKeyHelper 读哪个文件（测试连接时指向还没正式保存的临时文件）。
 */
export function claudeLaunch(cfg, { file = aiFile(), node = process.execPath } = {}) {
  if (!cfg || cfg.mode === 'auto' || !MODES.includes(cfg.mode)) return { unset: [], env: {}, args: [], model: null };
  const out = { unset: AUTH_ENV, env: {}, args: [], model: null };
  if (cfg.mode === 'subscription') return out;
  out.args = ['--settings', JSON.stringify({ apiKeyHelper: `${shq(node)} ${shq(HELPER)} ${shq(file)}` })];
  if (cfg.mode === 'custom') {
    out.env.ANTHROPIC_BASE_URL = cfg.baseUrl;
    if (cfg.model) {
      // Claude Code 内部会用 opus / sonnet / haiku 别名（含后台的小任务）：都指向用户的模型，否则会去请求对方不认识的 Claude 模型名
      for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']) out.env[k] = cfg.model;
      out.model = cfg.model;
    }
  }
  return out;
}

/** 按 claudeLaunch 的结果改环境变量（返回新对象）。 */
export function applyLaunchEnv(env, launch) {
  const e = { ...env };
  for (const k of launch.unset) delete e[k];
  return Object.assign(e, launch.env);
}

/** 校验并规范化用户填的设置。返回 { cfg } 或 { errors }。keep：已保存的设置（key 留空 = 沿用原来的 key）。 */
export function normalize(input = {}, keep = { mode: 'auto' }) {
  const mode = String(input.mode || '');
  if (!MODES.includes(mode)) return { errors: ['连接方式只能是 auto、subscription、apiKey 或 custom'] };
  if (mode === 'auto' || mode === 'subscription') return { cfg: { mode } };
  let apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  // 只有接口地址没变时才沿用旧 key：换了服务商还沿用，会把 A 家的 key 发给 B 家
  const errors = [];
  let baseUrl = '';
  if (mode === 'custom') {
    baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim().replace(/\/+$/, '') : '';
    let u = null;
    try { u = new URL(baseUrl); } catch { /* 下面报错 */ }
    if (!u || !/^https?:$/.test(u.protocol) || u.username || u.password) errors.push('接口地址要是完整的网址，例如 https://api.deepseek.com/anthropic');
    else if (u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) errors.push('接口地址要用 https（只有本机的 localhost 可以用 http）');
    else if (/\/v1\/messages$/.test(u.pathname)) errors.push('接口地址填到 /v1 之前就行，不要带 /v1/messages');
  }
  const sameTarget = keep.mode === mode && (mode !== 'custom' || keep.baseUrl === baseUrl);
  if (!apiKey && sameTarget && keep.apiKey) apiKey = keep.apiKey;
  if (!apiKey) errors.push('请填写 API key');
  else if (/\s/.test(apiKey) || apiKey.length > 500) errors.push('API key 格式不对（不能有空格，最长 500 个字符）');
  const model = mode === 'custom' && typeof input.model === 'string' ? input.model.trim() : '';
  if (mode === 'custom' && !model) errors.push('请填写模型名（对方文档里的模型 ID，例如 deepseek-chat）');
  else if (model && !/^[\w.:/@+-]{1,120}$/.test(model)) errors.push('模型名只能有字母、数字和 . _ - : / @ +');
  if (errors.length) return { errors };
  return { cfg: mode === 'custom' ? { mode, apiKey, baseUrl, model } : { mode, apiKey } };
}

function friendly(status, text) {
  let msg = '';
  try { const j = JSON.parse(text); msg = j?.error?.message || j?.message || j?.error || ''; } catch { msg = String(text || '').slice(0, 160); }
  msg = typeof msg === 'string' ? msg.slice(0, 200) : '';
  if (status === 401 || status === 403) return `密钥无效或没有权限（HTTP ${status}）${msg ? `：${msg}` : ''}`;
  if (status === 404) return `接口地址或模型名不对（HTTP 404）${msg ? `：${msg}` : ''}`;
  if (status === 429) return `额度用完或请求太频繁（HTTP 429）${msg ? `：${msg}` : ''}`;
  return `接口返回 HTTP ${status}${msg ? `：${msg}` : ''}`;
}

/**
 * 用最小的请求验证设置：
 *   apiKey → GET /v1/models（不花钱）
 *   custom → POST /v1/messages，max_tokens 1（花一点点额度；兼容接口不一定有 /v1/models）
 * subscription / auto 不在这里验证（要看 Claude Code 的登录状态，见 server 的 subscriptionStatus）。
 */
export async function testAi(cfg, { fetchImpl = fetch } = {}) {
  if (cfg.mode !== 'apiKey' && cfg.mode !== 'custom') return { ok: true };
  const base = cfg.mode === 'custom' ? cfg.baseUrl : ANTHROPIC_BASE;
  const headers = { 'x-api-key': cfg.apiKey, Authorization: `Bearer ${cfg.apiKey}`, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS());
  try {
    const res = cfg.mode === 'apiKey'
      ? await fetchImpl(`${base}/v1/models?limit=1`, { headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' }, signal: ctl.signal })
      : await fetchImpl(`${base}/v1/messages`, { method: 'POST', headers, signal: ctl.signal, redirect: 'error',
        body: JSON.stringify({ model: cfg.model, max_tokens: 1, messages: [{ role: 'user', content: 'Reply with OK' }] }) });
    const text = await res.text().catch(() => '');
    if (!res.ok) return { ok: false, error: friendly(res.status, text) };
    if (cfg.mode === 'custom') {
      let j = null; try { j = JSON.parse(text); } catch { /* 下面报错 */ }
      if (!j || (j.type !== 'message' && !Array.isArray(j.content))) return { ok: false, error: '接口有回应，但不是 Anthropic Messages 格式。请确认填的是对方「兼容 Anthropic」的地址（通常以 /anthropic 结尾），不是 OpenAI 格式的地址' };
    }
    return { ok: true };
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, error: `连接超时（${Math.round(TIMEOUT_MS() / 1000)} 秒没有回应）` };
    return { ok: false, error: `连不上接口：${e.cause?.code || e.message}` };
  } finally { clearTimeout(timer); }
}

async function writeAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
  } catch (e) { await rm(tmp, { force: true }).catch(() => {}); throw e; }
}

/** 校验 → 测试连接 → 成功才保存。auto / subscription 直接保存（不含密钥）。 */
export async function saveAi(input, { file = aiFile(), fetchImpl } = {}) {
  const keep = await loadAi(file);
  const n = normalize(input, keep);
  if (n.errors) return { success: false, errors: n.errors };
  const t = await testAi(n.cfg, { fetchImpl });
  if (!t.ok) return { success: false, errors: [`连接测试没通过：${t.error}`] };
  const now = new Date().toISOString();
  const saved = { ...n.cfg, savedAt: now, checkedAt: n.cfg.apiKey ? now : null };
  try { await writeAtomic(file, saved); } catch (e) { return { success: false, errors: [`保存失败：${e.message}`] }; }
  return { success: true, ai: publicView(saved) };
}

/** 重新测试已保存的设置（不改设置，只更新 checkedAt）。 */
export async function retestAi({ file = aiFile(), fetchImpl } = {}) {
  const cfg = await loadAi(file);
  const t = await testAi(cfg, { fetchImpl });
  if (t.ok && cfg.apiKey) { cfg.checkedAt = new Date().toISOString(); await writeAtomic(file, cfg).catch(() => {}); }
  return t.ok ? { success: true, ai: publicView(cfg) } : { success: false, errors: [`连接测试没通过：${t.error}`], ai: publicView(cfg) };
}

/** 删掉保存的设置，回到 auto。 */
export async function clearAi({ file = aiFile() } = {}) {
  await rm(file, { force: true });
  return { success: true, ai: publicView({ mode: 'auto' }) };
}
