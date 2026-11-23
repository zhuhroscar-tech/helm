// Helm 配置系统：声明式 SCHEMA + loadConfig（默认值 < helm.config.json < 环境变量）。
// 纯函数，import 时没有副作用。applyToEnv 把「来自文件」的值写回环境变量（不覆盖已有的），
// 所以现有代码继续读 process.env 就行。
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// type: int | string | bool | enum | path
// default '' 表示「不设置，用程序内置默认」（例如路径类默认在代码里按仓库位置算）
export const SCHEMA = [
  { key: 'server.port', env: 'PORT', type: 'int', default: 4377, min: 1, max: 65535,
    en: 'Port the console listens on (127.0.0.1 only).', zh: '网页服务监听的端口（只监听本机 127.0.0.1）。' },
  { key: 'claude.bin', env: 'CLAUDE_BIN', type: 'string', default: 'claude',
    en: 'Claude Code command: name on PATH or absolute path.', zh: 'Claude Code 命令：PATH 里的名字或绝对路径。' },
  { key: 'claude.model', env: 'CLAUDE_MODEL', type: 'string', default: '',
    en: 'Default model for agents (alias like "sonnet" or a full model id). Empty = Claude Code default.', zh: 'agent 默认模型（别名如 sonnet，或完整模型 ID）。留空 = 用 Claude Code 自己的默认。' },
  { key: 'claude.effort', env: 'CLAUDE_EFFORT', type: 'enum', values: ['', 'low', 'medium', 'high', 'xhigh', 'max'], default: '',
    en: 'Default reasoning effort. Empty = Claude Code default.', zh: '默认推理强度。留空 = 用 Claude Code 自己的默认。' },
  { key: 'agents.maxRuns', env: 'HELM_MAX_RUNS', type: 'int', default: 8, min: 1, max: 64,
    en: 'Maximum number of agent runs at the same time.', zh: '同时运行的 agent 数量上限。' },
  { key: 'agents.approvalWaitMs', env: 'HELM_APPROVAL_WAIT_MS', type: 'int', default: 900000, min: 1000, max: 1140000,
    en: 'How long an agent waits for you to approve an action (ms). Keep below the 20 min MCP tool timeout.', zh: 'agent 等你批准操作的最长时间（毫秒）。要比 MCP 工具的 20 分钟超时短。' },
  { key: 'agents.questionWaitMs', env: 'HELM_QUESTION_WAIT_MS', type: 'int', default: 900000, min: 1000, max: 1140000,
    en: 'How long an agent waits for your answer to a question (ms).', zh: 'agent 等你回答问题的最长时间（毫秒）。' },
  { key: 'security.execSandbox', env: 'HELM_EXEC_SANDBOX', type: 'enum', values: ['on', 'off'], default: 'on',
    en: 'macOS sandbox for agent-run code and backtests. "off" makes agent commands require your approval instead; backtests/paper runs refuse to start without the sandbox (non-macOS) unless this is "off", in which case strategy code runs unsandboxed.', zh: 'agent 运行代码和回测用的 macOS 沙盒。设为 off 后 agent 的这类命令改为要你批准；没有沙盒（不是 macOS）时回测 / 模拟实盘会拒绝运行，除非设为 off（此时策略代码不在沙盒里运行）。' },
  { key: 'engine.dotnetBin', env: 'DOTNET_BIN', type: 'path', default: '',
    en: 'Path to the dotnet executable. Empty = ~/.dotnet/dotnet.', zh: 'dotnet 可执行文件路径。留空 = ~/.dotnet/dotnet。' },
  { key: 'engine.leanData', env: 'HELM_LEAN_DATA', type: 'path', default: '',
    en: 'LEAN price data directory. Empty = engine/Lean/Data.', zh: 'LEAN 行情数据目录。留空 = engine/Lean/Data。' },
  { key: 'storage.projectsDir', env: 'HELM_PROJECTS_DIR', type: 'path', default: '',
    en: 'Where strategy projects are stored. Empty = projects/.', zh: '策略项目存放目录。留空 = projects/。' },
  { key: 'storage.threadsDir', env: 'HELM_THREADS_DIR', type: 'path', default: '',
    en: 'Where chat threads are stored. Empty = data/threads/.', zh: '对话记录存放目录。留空 = data/threads/。' },
  { key: 'storage.trialsFile', env: 'HELM_TRIALS_FILE', type: 'path', default: '',
    en: 'Trial (multiple-testing) ledger file. Empty = data/trials.jsonl.', zh: '尝试次数（多重检验）登记文件。留空 = data/trials.jsonl。' },
  { key: 'paper.alpacaFile', env: 'HELM_ALPACA_FILE', type: 'path', default: '',
    en: 'Alpaca paper-trading credentials file. Empty = data/secrets/alpaca.json if it already exists, else ~/Library/Application Support/Helm/secrets/alpaca.json.', zh: 'Alpaca 模拟盘密钥文件。留空 = 已有的 data/secrets/alpaca.json，没有就用 ~/Library/Application Support/Helm/secrets/alpaca.json。' },
  { key: 'paper.alpacaTimeoutMs', env: 'HELM_ALPACA_TIMEOUT_MS', type: 'int', default: 15000, min: 1000, max: 120000,
    en: 'Timeout of one Alpaca API request (ms).', zh: '单次 Alpaca 接口请求的超时（毫秒）。' },
  { key: 'paper.alpacaBackoffMs', env: 'HELM_ALPACA_BACKOFF_MS', type: 'int', default: 1000, min: 0, max: 30000,
    en: 'Base wait between Alpaca retries (ms).', zh: 'Alpaca 请求重试之间的基础等待（毫秒）。' },
  { key: 'qlib.python', env: 'QS_PYTHON', type: 'path', default: '',
    en: 'Python with qlib installed, for research. Empty = auto-detect.', zh: '研究用的、装了 qlib 的 Python。留空 = 自动查找。' },
  { key: 'qlib.scriptsDir', env: 'QS_SCRIPTS', type: 'path', default: '',
    en: 'qlib research scripts directory. Empty = engine/qlib_research.', zh: 'qlib 研究脚本目录。留空 = engine/qlib_research。' },
  { key: 'qlib.secUserAgent', env: 'QS_SEC_USER_AGENT', type: 'string', default: '', secret: true,
    en: 'User-Agent (name + email) sent to SEC EDGAR for fundamentals downloads.', zh: '下载 SEC 财报基本面时发给 EDGAR 的 User-Agent（姓名 + 邮箱）。' },
  { key: 'qlib.ideaRegistry', env: 'QS_IDEA_REGISTRY', type: 'path', default: '',
    en: 'Idea registry file. Empty = ~/.qlib/qs_cache/idea_registry.jsonl.', zh: '想法登记文件。留空 = ~/.qlib/qs_cache/idea_registry.jsonl。' },
  { key: 'qlib.sp500PitFile', env: 'HELM_SP500_PIT', type: 'path', default: '',
    en: 'S&P 500 point-in-time membership file. Empty = ~/.qlib/qs_cache/membership/sp500_pit.txt.', zh: 'S&P 500 历史成分股文件。留空 = ~/.qlib/qs_cache/membership/sp500_pit.txt。' },
  { key: 'reports.soffice', env: 'HELM_SOFFICE', type: 'path', default: '',
    en: 'LibreOffice soffice, used to turn generated decks into PDF. Empty = auto-detect.', zh: '把生成的汇报转成 PDF 用的 LibreOffice soffice。留空 = 自动查找。' },
];

// 内部 / 测试专用变量：不进 SCHEMA，不能写在配置文件里（文档附录用）
export const INTERNAL_ENV = [
  ['HELM_SANDBOX_ASSUME', 'Tests: pretend the sandbox is available/unavailable.'],
  ['HELM_SANDBOX_DIR', 'Tests: where sandbox profiles are written (default data/sandbox).'],
  ['HELM_REQUIRE_LEAN', 'Tests: =1 makes real-LEAN tests fail instead of skip when LEAN is not installed.'],
  ['HELM_FETCH_BACKOFF', 'Base wait (seconds) between Yahoo download retries (default 2).'],
  ['HELM_AGENTS_FILE', 'Tests: use another agents.json.'],
  ['HELM_MCP_CONFIG', 'Tests: use another MCP config file (default data/mcp.json).'],
  ['HELM_AI_FILE', 'Tests: use another AI-connection file (default: existing data/secrets/ai.json, else ~/Library/Application Support/Helm/secrets/ai.json).'],
  ['HELM_TRANSLATE', '=0 turns off translating user/agent content into the UI language.'],
  ['HELM_TRANSLATIONS_FILE', 'Tests: use another translation cache (default data/i18n/translations.json).'],
  ['HELM_DECK_DIR', 'Tests: where deck settings, template and logo live (default data/deck).'],
  ['HELM_AI_TEST_TIMEOUT_MS', 'Timeout of the AI connection test request (default 20000).'],
  ['HELM_CHANGE_ROOT', 'Tests: root directory for the change-approval policy.'],
  ['HELM_CHANGE_TESTS', 'Tests: fake test runner for the change-approval flow.'],
  ['HELM_TEST_TIMEOUT_MS', 'Tests: per-file timeout of test/all.mjs.'],
  ['HELM_PAPER_DRIFT', 'Tests: =0 disables paper-trading drift calculation.'],
  ['HELM_AGENT, HELM_THREAD_ID', 'Set by the server for the MCP child process.'],
  ['HELM_URL, HELM_TOKEN', 'Set by the server for the MCP child process (random per start).'],
  ['HELM_WRITE_ONLY', 'Set by the server: restricts which files an agent may write via MCP.'],
  ['HELM_CONFIG', 'Path of the config file itself (read by loadConfig, not a setting).'],
  ['QS_TRA_BUDGET', 'Tests: "epochs,steps" budget for fast TRA smoke tests.'],
];

// 密钥放哪：环境变量（HELM_ALPACA_FILE / HELM_AI_FILE）优先；仓库里已经有旧的 data/secrets/<name> 就继续用（不迁移、不丢）；
// 新装默认放到仓库外（仓库常在 iCloud 同步的「桌面 / 文稿」里）：macOS 是 ~/Library/Application Support/Helm/secrets，
// 其它系统是 $XDG_CONFIG_HOME/helm/secrets。目录 0700、文件 0600 由保存的地方负责
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function userSecretsDir({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Helm', 'secrets');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'helm', 'secrets');
}
export const legacySecretsDir = (root = REPO_ROOT) => path.join(root, 'data', 'secrets');
export function secretFile(name, envKey, { env = process.env, root = REPO_ROOT, ...o } = {}) {
  if (envKey && env[envKey]) return env[envKey];
  const legacy = path.join(legacySecretsDir(root), name);
  return existsSync(legacy) ? legacy : path.join(userSecretsDir({ env, ...o }), name);
}

const BOOL_T = new Set(['1', 'true', 'yes', 'on']);
const BOOL_F = new Set(['0', 'false', 'no', 'off']);

function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
function suggest(key, keys) {
  let best = null, bd = Infinity;
  for (const k of keys) { const d = Math.min(lev(key.toLowerCase(), k.toLowerCase()), lev(key.split('.').pop().toLowerCase(), k.split('.').pop().toLowerCase())); if (d < bd) { bd = d; best = k; } }
  return best && bd <= Math.max(3, Math.floor(best.length / 3)) ? best : null;
}

function rangeText(s) {
  if (s.type === 'int') return `integer ${s.min ?? '-inf'}..${s.max ?? 'inf'}`;
  if (s.type === 'enum') return `one of ${s.values.map((v) => (v === '' ? '""' : v)).join(', ')}`;
  if (s.type === 'bool') return 'true or false';
  return s.type;
}

// 校验并规整一个值；返回 { ok, value } 或 { ok:false, msg }
function coerce(s, raw, fromEnv, root) {
  if (raw === undefined || raw === null) return { ok: false, msg: 'no value' };
  const bad = () => ({ ok: false, msg: `invalid value ${JSON.stringify(raw)}; expected ${rangeText(s)}` });
  switch (s.type) {
    case 'int': {
      let n = raw;
      if (typeof raw === 'string') { if (!/^\s*-?\d+\s*$/.test(raw)) return bad(); n = Number(raw); }
      else if (typeof raw !== 'number' || fromEnv) return bad();
      if (!Number.isInteger(n)) return bad();
      if ((s.min != null && n < s.min) || (s.max != null && n > s.max)) return bad();
      return { ok: true, value: n };
    }
    case 'bool': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      if (typeof raw === 'string') { const v = raw.trim().toLowerCase(); if (BOOL_T.has(v)) return { ok: true, value: true }; if (BOOL_F.has(v)) return { ok: true, value: false }; }
      return bad();
    }
    case 'enum':
      return typeof raw === 'string' && s.values.includes(raw.trim()) ? { ok: true, value: raw.trim() } : bad();
    case 'path': {
      if (typeof raw !== 'string') return bad();
      let p = raw.trim();
      if (p === '') return { ok: true, value: '' };
      if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
      return { ok: true, value: fromEnv ? p : path.resolve(root, p) };
    }
    default:
      return typeof raw === 'string' ? { ok: true, value: raw } : bad();
  }
}

function flatten(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out.push([key, v]);
  }
  return out;
}

export function loadConfig({ root = process.cwd(), env = process.env, file, schema = SCHEMA } = {}) {
  const values = {}, sources = {}, errors = [], warnings = [];
  for (const s of schema) { values[s.key] = s.default; sources[s.key] = 'default'; }
  const byKey = new Map(schema.map((s) => [s.key, s]));

  const explicit = file || env.HELM_CONFIG;
  const filePath = explicit ? path.resolve(root, explicit) : path.join(root, 'helm.config.json');
  let parsed = null;
  if (!existsSync(filePath)) {
    if (explicit) warnings.push(`config file not found: ${filePath}`);
  } else {
    try { parsed = JSON.parse(readFileSync(filePath, 'utf8')); }
    catch (e) { errors.push(`${filePath}: invalid JSON (${e.message})`); }
    if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) { errors.push(`${filePath}: top level must be a JSON object`); parsed = null; }
  }
  if (parsed) {
    const keys = [...byKey.keys()];
    for (const [k, v] of flatten(parsed)) {
      const s = byKey.get(k);
      if (!s) {
        if (k === '$schema' || k.startsWith('_')) continue; // 允许注释用的下划线键
        const sg = suggest(k, keys);
        warnings.push(`unknown key "${k}" in ${filePath}${sg ? ` (did you mean "${sg}"?)` : ''}`);
        continue;
      }
      const r = coerce(s, v, false, path.dirname(filePath));
      if (r.ok) { values[k] = r.value; sources[k] = 'file'; }
      else errors.push(`${k} (file): ${r.msg}`);
    }
  }
  for (const s of schema) {
    const raw = env[s.env];
    if (raw === undefined || raw === '') continue; // 空串当作没设（和现有代码的 || 行为一致）
    const r = coerce(s, raw, true, root);
    if (r.ok) { values[s.key] = r.value; sources[s.key] = 'env'; }
    else errors.push(`${s.key} (env ${s.env}): ${r.msg}`);
  }
  return { values, sources, errors, warnings, file: filePath, fileLoaded: parsed !== null, schema };
}

export function applyToEnv(config, env = process.env) {
  const applied = [];
  for (const s of config.schema || SCHEMA) {
    if (config.sources[s.key] !== 'file') continue;
    const v = config.values[s.key];
    if (v === '' || v === undefined) continue;
    if (env[s.env] !== undefined && env[s.env] !== '') continue;
    env[s.env] = s.type === 'bool' ? (v ? '1' : '0') : String(v);
    applied.push(s.env);
  }
  return applied;
}

export function describeConfig(config) {
  return (config.schema || SCHEMA).map((s) => {
    const v = config.values[s.key];
    const shown = s.secret && v !== '' && v != null ? '********' : v;
    return { key: s.key, env: s.env, type: s.type, value: shown, default: s.default, source: config.sources[s.key], description: s.en, descriptionZh: s.zh };
  });
}
