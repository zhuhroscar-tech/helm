// 运行「agent 可以直接改」的代码时套的 macOS 沙盒（sandbox-exec）。
//
// 为什么要有：agent 可以不经批准改 engine/qlib_research/ 和新建测试文件，这些代码之后会被执行
// （agent 跑测试、改完自动检查、qlib 研究和导出）。规则文件只能管「改哪个文件」，管不了「改完的代码运行时做什么」，
// 所以运行时由操作系统来拦：
//   - 读不到密钥和凭据（data/secrets、.env、~/.ssh、~/.aws、钥匙串、Claude 凭据……）
//   - 连不上正在运行的 Helm（127.0.0.1:<PORT>）：拿不到网页令牌，不能自己批准自己的请求
//   - 改不了仓库里的代码和规则（server.mjs、lib/、mcp/、change-policy、测试、项目记录、尝试记录）
//   - agent 跑的测试命令连外网也不行；qlib 研究要下载 SEC 数据，可以联网，但仍然连不上 Helm
//
// 沙盒不可用（不是 macOS，或规则编译失败）时一律「收紧」而不是「放开」：
// agent 的测试命令改为要批准，engine/qlib_research/ 的改动改为要批准（见 change-policy.mjs 的 sandbox 参数）。
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { userSecretsDir } from './config.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const HOME = os.homedir();
// Helm 的端口：服务进程有 PORT，MCP / 回测进程只有 HELM_URL
const defaultPort = () => Number(process.env.PORT || (String(process.env.HELM_URL || '').match(/:(\d+)\/?$/) || [])[1] || 4377);

function realPath(d) {
  const parts = []; let cur = path.resolve(d);
  while (cur !== path.dirname(cur)) {
    try { return path.join(realpathSync(cur), ...parts); } catch { parts.unshift(path.basename(cur)); cur = path.dirname(cur); }
  }
  return path.resolve(d);
}
// 沙盒按真实路径匹配（/tmp → /private/tmp），两种写法都写上
const forms = (list) => [...new Set(list.filter(Boolean).flatMap((d) => [path.resolve(d), realPath(d)]))];
const q = (p) => `"${String(p).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const sub = (list) => forms(list).map((d) => `(subpath ${q(d)})`).join(' ');
const lit = (list) => forms(list).map((d) => `(literal ${q(d)})`).join(' ');
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 读写都不行的东西：密钥、凭据、别的对话记录
export function secretPaths({ root = ROOT } = {}) {
  const dirs = [path.join(root, 'data', 'secrets'), userSecretsDir(), path.join(root, 'data', 'threads'),
    ...['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.config/gh', '.claude', 'Library/Keychains', 'Library/Cookies'].map((d) => path.join(HOME, d))];
  for (const k of ['HELM_ALPACA_FILE', 'HELM_AI_FILE', 'HELM_QC_FILE']) if (process.env[k]) dirs.push(path.dirname(path.resolve(process.env[k])));
  const files = [path.join(root, '.env'), ...['.netrc', '.git-credentials', '.npmrc', '.pypirc', '.claude.json', '.zsh_history', '.bash_history'].map((f) => path.join(HOME, f))];
  return { dirs, files };
}

const DEV = '(literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/(tty|fd/)")';
const TMP = () => [os.tmpdir(), '/tmp', '/private/tmp', '/private/var/folders'];

// kind = 'agent'：agent 自己跑的测试 / 只读命令，以及改完后的自动检查
// kind = 'research'：qlib 研究、想法检验（会执行 engine/qlib_research 里的代码）
// kind = 'export'：股票池导出。和 research 一样，另外只多放行 LEAN 的日线价格目录 —— 导出的活就是往那里写价格，
//   而普通研究任务不该碰回测要用的价格数据（之前导出也用 research 规则，结果每次都在写 aapl.zip 时被拦）
export function sandboxProfile(kind, { port = defaultPort(), root = ROOT, projectsDir, leanDataDir } = {}) {
  const research = kind === 'research' || kind === 'export';
  const lean = leanDataDir || path.join(root, 'engine', 'Lean', 'Data');
  const { dirs, files } = secretPaths({ root });
  const helm = `(deny network-outbound (remote ip ${q(`localhost:${port}`)}))`;
  const lines = ['(version 1)', '(allow default)'];
  if (kind === 'agent') {
    // 测试会在本机随机端口起服务再连上去：只放行本机，外网一律不行
    lines.push('(deny network-outbound)', '(allow network-outbound (remote ip "localhost:*") (remote unix-socket))');
  }
  lines.push(helm, '(deny file-write*)');
  const writable = [...TMP(), path.join(HOME, '.cache', 'quant-strategy')];
  if (research) {
    writable.push(path.join(HOME, '.cache'), path.join(HOME, '.qlib'), path.join(HOME, '.config', 'quant-strategy'), path.join(HOME, '.matplotlib'),
      path.join(root, 'data', 'qlib'), path.join(lean, 'helm'));
  }
  if (kind === 'export') writable.push(...['daily', 'map_files', 'factor_files'].map((d) => path.join(lean, 'equity', 'usa', d)));
  let allowW = `(allow file-write* ${sub(writable)} ${DEV}`;
  if (kind === 'export') allowW += ` ${lit([path.join(lean, 'helm-meta.json'), path.join(lean, 'helm-meta.tmp')])}`;
  if (research) {
    // 研究结果只能写到 projects/<id>/research/ 下面；验证期记录、回测、模拟实盘记录写不了
    for (const p of forms([projectsDir || path.join(root, 'projects')])) allowW += ` (regex #"^${reEsc(p)}/[0-9]+/research/")`;
  }
  lines.push(`${allowW})`);
  lines.push(`(deny file-read* file-write* ${sub(dirs)} ${lit(files)})`);
  return lines.join('\n');
}

// 规则写到 data/sandbox/ 下（agent 的 Edit/Write 进不了 data/，沙盒里的进程也写不了），用 -f 引用
function profileFile(kind, opts) {
  // HELM_SANDBOX_DIR 只给测试用（test/all.mjs 指到临时目录，测试不往仓库里写）
  const dir = process.env.HELM_SANDBOX_DIR || path.join(opts.root || ROOT, 'data', 'sandbox');
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${kind}-${opts.port || defaultPort()}.sb`);
  writeFileSync(f, sandboxProfile(kind, opts));
  return f;
}

const READY = new Map();
// 沙盒能不能用：macOS + sandbox-exec 存在 + 规则能编译（用规则跑一次 /usr/bin/true）。结果缓存。
export function sandboxReady(kind, opts = {}) {
  if (process.env.HELM_EXEC_SANDBOX === 'off') return false;
  if (process.platform !== 'darwin' || !existsSync(SANDBOX_EXEC)) return false;
  const key = `${kind}:${opts.port || defaultPort()}`;
  if (READY.has(key)) return READY.get(key);
  let ok = false;
  try {
    const f = profileFile(kind, opts);
    const r = spawnSync(SANDBOX_EXEC, ['-f', f, '/usr/bin/true'], { timeout: 10000 });
    ok = r.status === 0;
    if (!ok) console.error(`[helm] ${kind} 沙盒规则不可用：${String(r.stderr || '').trim().slice(0, 300)}（相关操作改为要用户批准）`);
  } catch (e) { console.error(`[helm] ${kind} 沙盒不可用：${e.message}`); }
  READY.set(key, ok);
  return ok;
}

// spawn / execFile 用：返回 [cmd, args]。沙盒不可用时原样返回（调用方要先用 sandboxReady 决定能不能这样跑）
export function sandboxArgs(kind, cmd, args, opts = {}) {
  if (!sandboxReady(kind, opts)) return [cmd, args];
  return [SANDBOX_EXEC, ['-f', profileFile(kind, opts), cmd, ...args]];
}

// shell 单引号转义
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// agent 的 Bash 命令：改写成在沙盒里跑（通过审批返回的 updatedInput）。沙盒不可用时返回 null
export function wrapAgentCommand(command, opts = {}) {
  if (!sandboxReady('agent', opts)) return null;
  // 去掉 claude 进程环境里的模型密钥：用户自己在环境变量里设的 ANTHROPIC_API_KEY 等，不让 agent 的命令打印出来
  return `${SANDBOX_EXEC} -f ${shq(profileFile('agent', opts))} /usr/bin/env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN /bin/bash -c ${shq(command)}`;
}

// 给子进程的环境变量里去掉密钥和 Helm 的令牌
const SECRET_ENV = /^(ALPACA_|APCA_|HELM_TOKEN$|HELM_UI_TOKEN$|ANTHROPIC_|CLAUDE_CODE_OAUTH|AWS_|GITHUB_TOKEN$|GH_TOKEN$|OPENAI_)/;
export function scrubEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!SECRET_ENV.test(k)) out[k] = v;
  return out;
}
