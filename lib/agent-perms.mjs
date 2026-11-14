// agent（claude -p）读文件的黑名单。
// Claude Code 的 Read(...) 拒绝规则同时作用于 Read / Glob / Grep（以及 Edit / Write），规则语法见
// https://code.claude.com/docs/en/permissions ：`~/x` 从家目录算，`//abs` 是绝对路径（单个 / 开头是相对工作目录，不是绝对路径）。
// 拒绝优先于允许，所以 --allowedTools 里的裸 Read 不会把这些路径放出来。
// 家目录下的敏感位置每个都写两种形式（~/ 和 //绝对路径），以防某种写法在某个版本里没匹配上。
import os from 'node:os';
import path from 'node:path';

// 相对家目录的敏感位置（目录用 /**，单个文件直接写）
export const HOME_SECRETS = [
  '.ssh/**', '.aws/**', '.gnupg/**', '.config/**', '.kube/**', '.docker/**', '.azure/**', '.gcloud/**',
  '.netrc', '.npmrc', '.pypirc', '.git-credentials', '.gitconfig',
  '.zsh_history', '.bash_history', '.python_history', '.node_repl_history',
  'Library/**', // 钥匙串、浏览器 cookie、各种 App 的令牌都在这里
  // Claude 自己的凭据、设置、其它会话的对话记录和记忆。
  // 注意不能整个拒绝 ~/.claude/**：工具输出太长时 Claude 会存到 ~/.claude/projects/<p>/<session>/tool-results/ 再让 agent 读回来
  '.claude.json', '.claude/.credentials.json', '.claude/settings.json', '.claude/settings.local.json',
  '.claude/history.jsonl', '.claude/projects/*/*.jsonl', '.claude/projects/*/memory/**',
];

// 全盘任何位置的密钥类文件
export const ANYWHERE_SECRETS = ['**/.env', '**/.env.*', '**/*.pem', '**/id_rsa*', '**/id_ed25519*', '**/id_ecdsa*'];

const abs = (p) => `//${String(p).replace(/^\/+/, '')}`;

// 返回 --disallowedTools 用的 Read(...) 规则列表
export function sensitiveReadDenies({ home = os.homedir(), root, extraDirs = [] } = {}) {
  const rules = [];
  for (const rel of HOME_SECRETS) {
    rules.push(`Read(~/${rel})`, `Read(${abs(path.posix.join(home, rel))})`);
  }
  for (const pat of ANYWHERE_SECRETS) rules.push(`Read(//${pat})`);
  // 仓库 data/ 里 agent 不该直接读的：Alpaca 密钥、其它对话记录、服务日志（data/qlib 和 trials.jsonl 保留可读）
  if (root) for (const rel of ['data/secrets/**', 'data/threads/**', 'data/server.log']) rules.push(`Read(${abs(path.posix.join(root, rel))})`);
  for (const d of extraDirs) rules.push(`Read(${abs(d)}/**)`);
  return [...new Set(rules)];
}
