// agent 自己改代码 / 跑命令时的规则：哪些直接放行、哪些要用户批准、哪些一律不行。
// Claude Code 的 Edit / Write / Bash 调用都会先经过 MCP 的 approve 工具（--permission-prompt-tool），再由这里判断。
//
// 规则文件只管「改哪个文件」；改完的代码运行时做什么由 lib/exec-sandbox.mjs 的 macOS 沙盒管。
// 原则：会在沙盒外运行的代码（Helm 服务、MCP、回测进程、引擎顶层脚本）改动一律要批准；
// 只在沙盒里运行的代码（qlib 研究引擎、新建的测试）才可以直接改。
// 这里还防「agent 出于好意做了不该自己决定的事」：删东西、改研究规则（统计门槛、多重检验登记、验证期锁）、从网上装东西。
import path from 'node:path';
import { realpathSync } from 'node:fs';

// 可以直接改的范围（相对 helm 根目录）。研究引擎只在研究沙盒可用时才放行（sandbox.research）
export const FREE_DIRS = ['engine/qlib_research/', 'workspace/.claude/skills/', 'workspace/skills/'];
// 在沙盒外运行的平台代码：改动要批准（会在 Helm 服务 / MCP / 回测进程里直接运行，读得到密钥、能调 Helm 接口）
const PLATFORM_DIRS = ['lib/', 'mcp/', 'engine/', 'public/'];
// 一律不能碰
const DENY_DIRS = ['.git/', 'node_modules/', 'engine/lean/', 'engine/.venv/', 'data/', 'projects/', 'graphify-out/'];
const DENY_FILE = /(^|\/)\.env(\.|$)|\.pem$|(^|\/)id_(rsa|ed25519|ecdsa)/;
// 改了要批准：服务本身、网页、agent 配置和权限、共享规则、包脚本（测试会执行它）
const ASK_FILES = new Set(['server.mjs', 'agents.json', 'package.json', 'workspace/claude.md', 'readme.md', 'test/all.mjs',
  'engine/qlib_research/run.sh']);
const ASK_DIRS = ['public/'];
// 只读这些登记表也算研究规则的一部分：直接编辑等于篡改记录
const INTEGRITY_DATA = [/^data\/trials\.jsonl$/, /^projects\/\d+\/holdout_log\.json$/];

// 研究规则：这些定义（函数 / 常量）有任何改动都要批准，并给用户看差异。'*' = 整个文件
export const INTEGRITY = {
  'lib/stats.mjs': ['*'],
  'lib/tune.mjs': ['*'],
  'lib/engine.mjs': ['readTrials', 'isBenchRun', 'recordTrial', 'sameHistory', 'trialSharpes', 'holdoutViews', 'validateBacktestUncached', 'validateBacktest', 'tuneBlocker', 'runTuneJob',
    'logHoldout', 'withFileLock', 'updateBacktest', 'updateBacktestLocked', 'setMainByUser', 'demoteOtherMains', 'patchMeta'],
  'lib/fs-atomic.mjs': ['*'],
  'engine/helm_data.py': ['*'],
  'engine/lint_strategy.py': ['*'],
  'lib/exec-sandbox.mjs': ['*'],
  'engine/qlib_research/qs_idea.py': ['HORIZON_RANGE', 'DEFAULT_HORIZONS', 'KNOWN_FACTORS', 'KNOWN_FUND', 'CLIP_MAD', 'ALPHA', 'T_FLOOR',
    'YEAR_MIN_DAYS', 'MIN_DAYS', 'MIN_COVERAGE', 'SIGN_SHARE', 'DUP_CORR', 'cs_rank', 'combine_components', 'fwd_returns', 'daily_rank_ic',
    'nw_lags', 'nw_tstat', 'ic_stats', 'winsorize_rows', 'quantile_stats', 't_threshold', 'registry_path', 'registry_read', 'registry_add',
    'registry_trials', 'evaluate_factor', 'judge'],
  'engine/qlib_research/qs_pipeline.py': ['phase_design', 'phase_idea', 'phase_holdout', '_registry_key', '_registry_prior', '_registry_add'],
  'engine/qlib_research/qs_core.py': ['design_splits', 'splits_to_json', 'splits_from_json', 'cscv_pbo', 'TUNE_SPACE', 'tune_select'],
};

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

/* ---------------- 顶层定义切块（Python / JS） ---------------- */
const PY_START = /^(?:async\s+def|def|class)\s+([A-Za-z_]\w*)|^([A-Za-z_]\w*)\s*(?::[^=]*)?=(?!=)/;
const JS_START = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/;
// 文件按顶层定义切成块：{ 名字: 文本 }。一个块从定义那一行到下一个顶层定义之前
export function topLevelBlocks(text, file) {
  const py = /\.py$/.test(file);
  const re = py ? PY_START : JS_START;
  const lines = String(text || '').split('\n');
  const blocks = {};
  let cur = null; let buf = [];
  const flush = () => { if (cur) blocks[cur] = buf.join('\n').replace(/\s+$/g, ''); };
  for (const line of lines) {
    const m = line.match(re);
    if (m) { flush(); cur = m[1] || m[2]; buf = [line]; } else if (cur) buf.push(line);
  }
  flush();
  return blocks;
}
// 哪些受保护的定义变了（新增、删除、内容不同都算）
export function integrityTouched(rel, oldText, newText) {
  const names = INTEGRITY[rel];
  if (!names) return [];
  if (names.includes('*')) return oldText === newText ? [] : ['整个文件'];
  const a = topLevelBlocks(oldText, rel); const b = topLevelBlocks(newText, rel);
  return names.filter((n) => (a[n] ?? null) !== (b[n] ?? null));
}

/* ---------------- 差异（给用户看） ---------------- */
// 去掉首尾相同的行，剩下的旧块 / 新块各取前 120 行
export function simpleDiff(oldText, newText, { context = 3, max = 120 } = {}) {
  const a = String(oldText ?? '').split('\n'); const b = String(newText ?? '').split('\n');
  let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0; while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  if (s === a.length && s === b.length) return { text: '', added: 0, removed: 0 };
  const from = Math.max(0, s - context);
  const out = [`@@ 第 ${s + 1} 行起 @@`];
  for (let i = from; i < s; i++) out.push(`  ${a[i]}`);
  const del = a.slice(s, a.length - e); const add = b.slice(s, b.length - e);
  for (const l of del.slice(0, max)) out.push(`- ${l}`);
  if (del.length > max) out.push(`- …（还有 ${del.length - max} 行）`);
  for (const l of add.slice(0, max)) out.push(`+ ${l}`);
  if (add.length > max) out.push(`+ …（还有 ${add.length - max} 行）`);
  for (let i = a.length - e; i < Math.min(a.length, a.length - e + context); i++) out.push(`  ${a[i]}`);
  return { text: out.join('\n'), added: add.length, removed: del.length };
}

// Edit / MultiEdit 之后的文件内容（找不到 old_string 时返回 null：工具自己会失败）
export function applyEdit(toolName, input, oldText) {
  if (toolName === 'Write') return String(input.content ?? '');
  const edits = toolName === 'MultiEdit' ? (input.edits || []) : [input];
  let t = oldText ?? '';
  for (const ed of edits) {
    const o = String(ed.old_string ?? ''); const n = String(ed.new_string ?? '');
    if (o === '') { if (t === '') { t = n; continue; } return null; }
    if (!t.includes(o)) return null;
    t = ed.replace_all ? t.split(o).join(n) : t.replace(o, () => n);
  }
  return t;
}

/* ---------------- 命令 ---------------- */
const SHELL_META = /[;&|<>`]|\$\(|\$\{|\n/;
// 直接放行的命令都会被改写成在沙盒里跑（server.mjs 用 wrapAgentCommand）。
// 要跑真实 LEAN 的（npm test 完整模式、test:smoke、--lean）不在这里：LEAN 自己要开沙盒，沙盒里不能再开，所以要批准、在沙盒外跑。
const TEST_CMDS = [
  /^npm (run )?test -- --fast$/,
  /^node (\.\/)?test\/[\w.-]+\.test\.mjs( --fast)?$/, /^node (\.\/)?test\/smoke\.mjs --fast$/, /^node --check [\w./-]+\.m?js$/,
  /^(\.\/)?engine\/qlib_research\/run\.sh --test$/,
  /^(python3?|engine\/\.venv\/bin\/python) -I (\.\/)?engine\/qlib_research\/test_\w+\.py$/,
];
// 只读命令：参数只能是仓库里的相对路径（不许 /、~、..），git 不许 --output / --no-index 这类会写文件或读仓库外的参数
const REL_ARGS = '( (?!-)(?![^ ]*\\.\\.)[\\w.][\\w./@^~:-]*| -[a-zA-Z]+| --[a-z][a-z-]*)*';
const READONLY_CMDS = [new RegExp(`^git (status|diff|log|show)${REL_ARGS}$`), new RegExp(`^ls${REL_ARGS}$`), /^pwd$/, new RegExp(`^wc${REL_ARGS}$`)];
const BAD_GIT = /\s--(output|no-index|ext-diff|textconv|exec-path|git-dir|work-tree)\b|\s-o\b|\s-c\b/;
const INSTALL = /\b(pip3?|uv|npm|pnpm|yarn|brew|conda|apt(-get)?|gem|cargo)\b.*\b(install|add|i)\b|\bclaude\s+(plugin|mcp)\b|\bnpx\b|\bcurl\b|\bwget\b/;
const DELETE = /(^|\s|;|&&)(rm|rmdir|unlink|shred|trash)\s|\bgit\s+(clean|rm|reset\s+--hard|checkout\s+--|restore)\b|\bfind\b.*-delete|\bmv\s/;

export function classifyCommand(cmd) {
  const c = String(cmd || '').trim().replace(/\s+2>&1$/, '');
  if (!c) return { action: 'deny', category: 'command', title: '空命令' };
  if (DELETE.test(c)) return { action: 'ask', category: 'delete', title: '运行会删除或移动文件的命令' };
  if (INSTALL.test(c)) return { action: 'ask', category: 'install', title: '安装 / 下载外部的东西' };
  if (!SHELL_META.test(c) && TEST_CMDS.some((r) => r.test(c))) return { action: 'allow', category: 'test', title: '跑测试（沙盒里）', sandbox: true };
  if (!SHELL_META.test(c) && !BAD_GIT.test(` ${c}`) && READONLY_CMDS.some((r) => r.test(c))) return { action: 'allow', category: 'read', title: '只读命令（沙盒里）', sandbox: true };
  return { action: 'ask', category: 'command', title: '运行命令' };
}

/* ---------------- 路径 ---------------- */
// macOS 的磁盘不分大小写（lib/Stats.mjs 就是 lib/stats.mjs），还可能有符号链接：
// 先把最近一个存在的上级目录换成真实路径，再统一 Unicode 写法和大小写，所有规则都按这个 key 比较。
function realish(p) {
  const parts = []; let cur = path.resolve(p);
  while (cur !== path.dirname(cur)) {
    try { return path.join(realpathSync(cur), ...parts); } catch { parts.unshift(path.basename(cur)); cur = path.dirname(cur); }
  }
  return path.resolve(p);
}
export function canonicalRel(root, abs) {
  const r = realish(root); const a = realish(abs);
  const rel = path.relative(r, a).split(path.sep).join('/').normalize('NFC');
  return { rel, key: rel.toLowerCase(), real: a };
}
const SKILL_KEYS = new Set(['name', 'description']);
function skillExtraKeys(text) {
  const m = String(text || '').match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return [];
  return m[1].split('\n').map((l) => (l.match(/^([A-Za-z_][\w-]*)\s*:/) || [])[1]).filter((k) => k && !SKILL_KEYS.has(k.toLowerCase()));
}

/* ---------------- 总入口 ---------------- */
// 返回 { action: 'allow'|'ask'|'deny', category, title, detail, path, rel, diff, integrity, before, after }
// sandbox = { agent, research }：两种沙盒能不能用（lib/exec-sandbox.mjs 的 sandboxReady）。不传 = 都不能用（最严）
export function decide({ agent, toolName, input = {}, root, cwd, readText, sandbox = {} }) {
  if (agent && agent.orchestrator && (EDIT_TOOLS.has(toolName) || toolName === 'Bash')) {
    return { action: 'deny', category: 'role', title: `${agent.name}是调度者，不自己改代码或跑命令`, detail: '这不是说这件事不能做：用 handoff 交给 engineer（策略工程师）或 researcher（研究员），把要改什么、为什么、怎样算完成写清楚——交接是正确做法，不算绕过规则。' };
  }
  if (toolName === 'Bash') {
    const r = classifyCommand(input.command);
    const out = { ...r, detail: String(input.command || '').slice(0, 2000), command: String(input.command || '') };
    // 没有沙盒就不能直接放行：测试会执行 agent 刚写的代码
    if (r.action === 'allow' && r.sandbox && !sandbox.agent) return { ...out, action: 'ask', sandbox: false, title: `${r.category === 'test' ? '跑测试' : '只读命令'}（沙盒不可用，要批准）` };
    return out;
  }
  if (toolName === 'NotebookEdit') return { action: 'deny', category: 'role', title: '不支持编辑 Notebook' };
  if (!EDIT_TOOLS.has(toolName)) {
    return { action: 'deny', category: 'unknown', title: `工具 ${toolName} 不在 Helm 允许的范围里`, detail: '如果确实需要，说明用途，让用户在 agents.json 里放开。' };
  }
  const abs = path.resolve(cwd || root, String(input.file_path || ''));
  const { rel, key, real } = canonicalRel(root, abs);
  if (!input.file_path || rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { action: 'deny', category: 'outside', title: '不能改 Helm 文件夹以外的文件', path: abs, rel };
  }
  if (DENY_FILE.test(key)) return { action: 'deny', category: 'secret', title: '不能改密钥 / .env 类文件', path: abs, rel };
  const before = readText(abs); // null = 文件不存在
  const after = applyEdit(toolName, input, before);
  if (INTEGRITY_DATA.some((r) => r.test(key))) {
    return { action: 'ask', category: 'integrity', title: `直接编辑研究登记表 ${rel}`, path: abs, rel, before, after, diff: simpleDiff(before, after ?? before), integrity: ['登记表'] };
  }
  if (DENY_DIRS.some((d) => key.startsWith(d))) {
    return { action: 'deny', category: 'outside', title: `${rel.split('/')[0]}/ 不能直接改`, detail: key.startsWith('projects/') ? '项目代码用 write_file；回测结果、研究结果、模拟实盘记录不能改。' : '这是运行数据或第三方代码。', path: abs, rel };
  }
  const base = { path: abs, rel, before, after, created: before == null, real };
  const diff = after == null ? null : simpleDiff(before ?? '', after);
  if (toolName === 'Write' && before != null && String(input.content ?? '').trim() === '') {
    return { ...base, diff, action: 'ask', category: 'delete', title: `清空文件 ${rel}` };
  }
  const integrityKey = Object.keys(INTEGRITY).find((k) => k.toLowerCase() === key);
  const touched = after == null || !integrityKey ? [] : integrityTouched(integrityKey, before ?? '', after);
  if (touched.length) {
    return { ...base, diff, integrity: touched, action: 'ask', category: 'integrity', title: `改动研究规则 / 安全检查：${rel}（${touched.slice(0, 4).join('、')}${touched.length > 4 ? ' 等' : ''}）` };
  }
  if (ASK_FILES.has(key) || ASK_DIRS.some((d) => key.startsWith(d))) {
    return { ...base, diff, action: 'ask', category: 'core', title: `改动 ${rel}（服务 / 网页 / 权限 / 共享规则）` };
  }
  if (/^workspace\/(\.claude\/)?skills\/.+\/skill\.md$/.test(key)) {
    const extra = skillExtraKeys(after);
    if (extra.length) return { ...base, diff, action: 'ask', category: 'core', title: `技能 ${rel} 的开头设置了 ${extra.join('、')}（可能给自己开工具权限或后台子 agent）` };
  }
  // 测试：新建的测试文件只在沙盒里运行（agent 自己跑；test/all.mjs 对清单外的文件也套 agent 沙盒）；改已有的测试要批准
  if (key.startsWith('test/')) {
    if (before == null && sandbox.agent) return { ...base, diff, action: 'allow', category: 'edit', title: `新建测试 ${rel}` };
    return { ...base, diff, action: 'ask', category: 'core', title: `改动已有的测试 ${rel}（测试决定改动能不能保留）` };
  }
  // 研究引擎的代码会被研究进程和改完后的自动测试执行：两种沙盒都可用才放行
  if (key.startsWith('engine/qlib_research/') && !(sandbox.research && sandbox.agent)) {
    return { ...base, diff, action: 'ask', category: 'core', title: `改动研究引擎 ${rel}（研究沙盒不可用，代码会在沙盒外运行）` };
  }
  if (FREE_DIRS.some((d) => key.startsWith(d))) return { ...base, diff, action: 'allow', category: 'edit', title: `${before == null ? '新建' : '修改'} ${rel}` };
  if (PLATFORM_DIRS.some((d) => key.startsWith(d))) {
    return { ...base, diff, action: 'ask', category: 'core', title: `改动平台代码 ${rel}（在 Helm 服务 / MCP / 回测进程里直接运行，不在沙盒里）` };
  }
  return { ...base, diff, action: 'ask', category: 'core', title: `改动 ${rel}（不在可以直接改的目录里）` };
}

// 同一对话里「这类都允许」的匹配键
export function scopeKey(d) {
  if (d.category === 'command' || d.category === 'install' || d.category === 'delete') return `${d.category}:${d.command || d.rel || ''}`;
  return `${d.category}:${d.rel || ''}`;
}
