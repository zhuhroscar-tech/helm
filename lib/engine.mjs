// 本地 LEAN 引擎：项目 / 文件 / 编译 / 回测 / 结果，全部存在本机磁盘
// 返回值刻意模仿 QuantConnect REST API 的结构，前端和 agent 都按同一套字段读
import { spawn, execFile } from 'node:child_process';
import { existsSync, symlinkSync, lstatSync, unlinkSync, realpathSync, readlinkSync } from 'node:fs';
import { readFile, writeFile, appendFile, mkdir, mkdtemp, readdir, rm, rename, stat, open } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateResult, resultWindow, GATE_RULES, checkConsistency, mainNeeds, dailySharpe } from './stats.mjs';
import { fetchMacro, macroInCode } from './macro.mjs';
import { discoverParams, sensitivityPlan, sensitivityVerdict, sensitivityConclusion, SENS_MAX_PARAMS, SENS_WARNING, prepare as prepareSeries } from './robust.mjs';
import { buildRanges, sampleConfigs, plateauScores, recommendFromPlateau, cscvPbo, cscvBlocks, tuneVerdict, seedOf, TUNE_DEFAULT_BUDGET, TUNE_MIN_BUDGET, TUNE_MAX_BUDGET, TUNE_RULES } from './tune.mjs';
import { datasetsInCode, datasetUsage } from './datasets.mjs';
import { codeFingerprint, strategyInputs, dataFingerprint, fingerprintCheck, diffData, FINGERPRINT_VERSION } from './fingerprint.mjs';
import { readJsonFile, writeJsonAtomic, appendLine } from './fs-atomic.mjs';
import { userSecretsDir } from './config.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENGINE = path.join(ROOT, 'engine');
export const LEAN_DIR = path.join(ENGINE, 'Lean');
export const LAUNCHER_DIR = path.join(LEAN_DIR, 'Launcher', 'bin', 'Release');
export const DATA_DIR = process.env.HELM_LEAN_DATA || path.join(LEAN_DIR, 'Data'); // 测试可指到临时目录（helm_data.py 也认这个变量）
// 测试时可以用环境变量指到临时目录，不碰真实项目
export const PROJECTS_DIR = process.env.HELM_PROJECTS_DIR || path.join(ROOT, 'projects');
export const VENV_PY = path.join(ENGINE, '.venv', 'bin', 'python');
const HOME = os.homedir();
export const DOTNET = process.env.DOTNET_BIN || path.join(HOME, '.dotnet', 'dotnet');

const ok = (extra = {}) => ({ success: true, errors: [], ...extra });
const fail = (msg) => ({ success: false, errors: [msg] });
const now = () => new Date().toISOString();
const SAFE_FILE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,80}\.py$/;
// 规则说明：agent 写代码前先写 spec.md（只这一个非 .py 文件，不参与编译、检查和回测）
const DOC_FILE = /^spec\.md$/;

/* ---------------- python runtime discovery ---------------- */

let pyRuntime = null;
async function pythonRuntime() {
  if (pyRuntime) return pyRuntime;
  const out = await new Promise((resolve) => {
    execFile(VENV_PY, ['-I', '-c', 'import sys,sysconfig,json;print(json.dumps({"home":sys.base_prefix,"libdir":sysconfig.get_config_var("LIBDIR"),"ver":"%d.%d"%sys.version_info[:2]}))'],
      { timeout: 10000 }, (err, stdout) => resolve(err ? null : stdout));
  });
  if (!out) return null;
  const j = JSON.parse(out);
  const ext = process.platform === 'darwin' ? 'dylib' : 'so';
  pyRuntime = {
    home: j.home,
    dll: path.join(j.libdir, `libpython${j.ver}.${ext}`),
    sitePackages: path.join(ENGINE, '.venv', 'lib', `python${j.ver}`, 'site-packages'),
  };
  return pyRuntime;
}

export async function engineStatus() {
  const checks = {
    dotnet: existsSync(DOTNET),
    lean: existsSync(path.join(LAUNCHER_DIR, 'QuantConnect.Lean.Launcher.dll')),
    python: existsSync(VENV_PY),
  };
  const py = checks.python ? await pythonRuntime() : null;
  checks.libpython = Boolean(py && existsSync(py.dll));
  const missing = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  let data = {};
  try { data = JSON.parse(await readFile(path.join(DATA_DIR, 'helm-meta.json'), 'utf8')); } catch { /* no data yet */ }
  return { ok: missing.length === 0, missing, tickers: Object.keys(data).length };
}

/* ---------------- projects ---------------- */

const pdir = (id) => path.join(PROJECTS_DIR, String(Number(id)));
// backtestId 只认十六进制字符。目录名和结果 / 日志文件名都必须用清洗过的 id：
// 文件名里直接拼原始 id 的话，"../../x" 这种写法能读到回测目录之外的 .json / -log.txt
const cleanBid = (bid) => String(bid).replace(/[^a-f0-9]/g, '');
const bdir = (pid, bid) => path.join(pdir(pid), 'backtests', cleanBid(bid));

// 读写都走 lib/fs-atomic.mjs：写入先 fsync 再 rename；文件损坏时记日志而不是悄悄当成“没有”
const readJson = readJsonFile;
const writeJson = writeJsonAtomic;

// 文件锁：先读、改、再写的记录（验证期记录）会被服务进程和每个 MCP 进程同时改。
// 临时文件 + rename 只能防写坏，防不了“两边都读到旧的、后写的覆盖先写的”，所以读改写要上锁：
// 同一进程内按文件排队，跨进程用 <file>.lock（O_EXCL 创建，超过 staleMs 没释放视为崩溃残留）。
const LOCAL_LOCKS = new Map();
export async function withFileLock(file, fn, { timeoutMs = 20000, staleMs = 30000 } = {}) {
  const prev = LOCAL_LOCKS.get(file) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const chain = prev.then(() => mine);
  LOCAL_LOCKS.set(file, chain);
  await prev;
  try {
    const lock = `${file}.lock`;
    const t0 = Date.now();
    for (;;) {
      try {
        const fh = await open(lock, 'wx');
        await fh.writeFile(`${process.pid} ${now()}\n`);
        await fh.close();
        break;
      } catch (e) {
        // 目录不存在（回测 / 项目不存在）：没有东西要保护，直接执行，让 fn 自己报「不存在」
        if (e.code === 'ENOENT') return await fn();
        if (e.code !== 'EEXIST') throw e;
        try {
          const st = await stat(lock);
          if (Date.now() - st.mtimeMs > staleMs) { await rm(lock, { force: true }); continue; }
        } catch { continue; } // 刚好被释放
        if (Date.now() - t0 > timeoutMs) throw new Error(`等待文件锁超时：${path.basename(file)}`);
        await new Promise((r) => setTimeout(r, 10 + Math.random() * 40));
      }
    }
    try { return await fn(); } finally { await rm(lock, { force: true }); }
  } finally {
    release();
    if (LOCAL_LOCKS.get(file) === chain) LOCAL_LOCKS.delete(file);
  }
}

async function touchProject(id) {
  const f = path.join(pdir(id), 'project.json');
  const p = await readJson(f);
  if (p) { p.modified = now(); await writeJson(f, p); }
}

export async function listProjects() {
  await mkdir(PROJECTS_DIR, { recursive: true });
  const ids = (await readdir(PROJECTS_DIR)).filter((d) => /^\d+$/.test(d));
  const ps = [];
  for (const id of ids) {
    const p = await readJson(path.join(PROJECTS_DIR, id, 'project.json'));
    if (p) ps.push(p);
  }
  return ps.sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
}

export async function projectsRead({ projectId } = {}) {
  if (projectId != null) {
    const p = await readJson(path.join(pdir(projectId), 'project.json'));
    return p ? ok({ projects: [p] }) : fail(`项目 ${projectId} 不存在`);
  }
  return ok({ projects: await listProjects() });
}

const STARTER = (cls) => `# region imports
from AlgorithmImports import *
# endregion


class ${cls}(QCAlgorithm):

    def initialize(self):
        self.set_start_date(2015, 1, 1)
        self.set_cash(100000)
        self.spy = self.add_equity("SPY", Resolution.DAILY).symbol

    def on_data(self, data: Slice):
        if not self.portfolio.invested:
            self.set_holdings(self.spy, 1)
`;

// 新建项目时可选的起始模板（网页“新建项目”用）
export const TEMPLATES = {
  buyhold: STARTER('BuyAndHold'),
  sma: `# region imports
from AlgorithmImports import *
# endregion


class SmaCrossover(QCAlgorithm):
    """快慢均线交叉：快线上穿慢线满仓，下穿清仓。"""

    def initialize(self):
        self.set_start_date(2015, 1, 1)
        self.set_cash(100000)
        self.symbol = self.add_equity("SPY", Resolution.DAILY).symbol
        self.fast = self.sma(self.symbol, 50)
        self.slow = self.sma(self.symbol, 200)
        self.set_warm_up(200)

    def on_data(self, data: Slice):
        if self.is_warming_up:
            return
        if self.fast.current.value > self.slow.current.value:
            if not self.portfolio.invested:
                self.set_holdings(self.symbol, 0.98)
        elif self.portfolio.invested:
            self.liquidate()
`,
  rotation: `# region imports
from AlgorithmImports import *
# endregion


class MomentumRotation(QCAlgorithm):
    """每月初持有过去 3 个月涨得最多的 ETF。"""

    def initialize(self):
        self.set_start_date(2010, 1, 1)
        self.set_cash(100000)
        tickers = ["SPY", "QQQ", "TLT", "GLD"]
        self.symbols = [self.add_equity(t, Resolution.DAILY).symbol for t in tickers]
        self.momentum = {s: self.momp(s, 63) for s in self.symbols}
        self.set_warm_up(63)
        self.schedule.on(self.date_rules.month_start("SPY"), self.time_rules.after_market_open("SPY", 30), self.rebalance)

    def rebalance(self):
        if self.is_warming_up:
            return
        best = max(self.symbols, key=lambda s: self.momentum[s].current.value)
        for s in self.symbols:
            if s != best and self.portfolio[s].invested:
                self.liquidate(s)
        self.set_holdings(best, 0.98)
`,
};

// 英文界面新建项目时，模板里的说明（docstring）换成英文
const TEMPLATE_DOC_EN = {
  '快慢均线交叉：快线上穿慢线满仓，下穿清仓。': 'Moving-average crossover: go fully long when the fast SMA crosses above the slow SMA, exit when it crosses below.',
  '每月初持有过去 3 个月涨得最多的 ETF。': 'At the start of each month, hold the ETF with the best return over the past 3 months.',
};
export function templateCode(key, lang = 'zh') {
  if (!Object.hasOwn(TEMPLATES, key)) return undefined;
  let code = TEMPLATES[key];
  if (lang === 'en') for (const [zh, en] of Object.entries(TEMPLATE_DOC_EN)) code = code.split(zh).join(en);
  return code;
}

let idLock = Promise.resolve();
// 项目名的另一种语言：网页按界面语言显示 nameEn / nameZh，没有就显示原来的 name（用户数据，原样保留）
const ALT_NAMES = ['nameEn', 'nameZh'];
function applyAltNames(p, src) {
  for (const k of ALT_NAMES) {
    if (src[k] === undefined || src[k] === null) continue;
    const v = String(src[k]).trim().slice(0, 120);
    if (v) p[k] = v; else delete p[k];
  }
}

export async function createProject({ name, language = 'Py', code, description = '', nameEn, nameZh }) {
  if (!name || typeof name !== 'string') return fail('需要项目名称');
  if (language !== 'Py') return fail('本地引擎目前只支持 Python 策略');
  await mkdir(PROJECTS_DIR, { recursive: true });
  // 编号分配：进程内串行 + 独占 mkdir（EEXIST 就重算再试），并发调用或多个进程都不会拿到同一个编号
  let projectId, dir;
  const prev = idLock; let release; idLock = new Promise((r) => { release = r; });
  await prev;
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const ids = (await readdir(PROJECTS_DIR)).filter((d) => /^\d+$/.test(d)).map(Number);
      // 回收站里的编号也不复用，免得新项目和旧记录（对话、统计检验次数）混在一起
      const trash = path.join(PROJECTS_DIR, '.trash');
      if (existsSync(trash)) for (const d of await readdir(trash)) { const n = Number((d.match(/^(\d+)-/) || [])[1]); if (n) ids.push(n); }
      projectId = ids.length ? Math.max(...ids) + 1 : 1001;
      dir = pdir(projectId);
      try { await mkdir(dir); break; } catch (e) { if (e.code !== 'EEXIST') throw e; projectId = null; }
    }
  } finally { release(); }
  if (!projectId) return fail('分配项目编号失败，请重试');
  await mkdir(path.join(dir, 'backtests'), { recursive: true });
  const p = { projectId, name: name.slice(0, 120), language: 'Py', description, created: now(), modified: now(), parameters: [] };
  applyAltNames(p, { nameEn, nameZh });
  await writeJson(path.join(dir, 'project.json'), p);
  await writeFile(path.join(dir, 'main.py'), code || STARTER(className(name)));
  return ok({ projects: [p] });
}

function className(name) {
  // 名字里没有任何字母数字（比如全中文）时 split 会给出 ['']，要先滤掉，否则 w[0] 是 undefined
  const c = String(name).replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  return /^[A-Za-z]/.test(c) ? `${c}Algorithm` : 'MyAlgorithm';
}

export async function updateProject({ projectId, name, description, nameEn, nameZh }) {
  const f = path.join(pdir(projectId), 'project.json');
  const p = await readJson(f);
  if (!p) return fail(`项目 ${projectId} 不存在`);
  if (name) p.name = String(name).slice(0, 120);
  if (description != null) p.description = String(description).slice(0, 2000);
  applyAltNames(p, { nameEn, nameZh });
  p.modified = now();
  await writeJson(f, p);
  return ok({ projects: [p] });
}

// 用户在网页上改名（POST /api/actions/project-rename）：和 MCP 的 update_project 共用 updateProject。
// 和 agent 不同，这里不悄悄截断：空名（只有空白也算）和超过 120 字的名字直接拒绝。
// 网页按界面语言显示 nameZh / nameEn（没有才用 name），所以改名时同时改 name 和当前语言的名字，改完立刻看得到。
export const PROJECT_NAME_MAX = 120;
export async function renameProject({ projectId, name, lang }) {
  if (typeof name !== 'string') return fail('需要项目名称');
  const n = name.replace(/\s+/g, ' ').trim();
  if (!n) return fail('项目名称不能为空');
  if (n.length > PROJECT_NAME_MAX) return fail(`项目名称太长了（最多 ${PROJECT_NAME_MAX} 个字符）`);
  // 另一种语言的名字清掉（空字符串 = 删除）：否则切换语言后还显示旧名字，像是没改成
  return updateProject({ projectId, name: n, nameZh: lang === 'en' ? '' : n, nameEn: lang === 'en' ? n : '' });
}

/* ---------------- files ---------------- */

export async function filesRead({ projectId, name }) {
  const dir = pdir(projectId);
  if (!existsSync(dir)) return fail(`项目 ${projectId} 不存在`);
  const names = name ? [name] : (await readdir(dir)).filter((f) => f.endsWith('.py') || DOC_FILE.test(f)).sort((a, b) => (a === 'main.py' ? -1 : b === 'main.py' ? 1 : a.localeCompare(b)));
  const files = [];
  for (const n of names) {
    if (!SAFE_FILE.test(n) && !DOC_FILE.test(n)) return fail(`文件名不合法：${n}`);
    try { files.push({ name: n, content: await readFile(path.join(dir, n), 'utf8') }); } catch { if (name) return fail(`找不到文件 ${n}`); }
  }
  return ok({ files });
}

export async function writeProjectFile({ projectId, name, content }) {
  const dir = pdir(projectId);
  if (!existsSync(dir)) return fail(`项目 ${projectId} 不存在`);
  if (!SAFE_FILE.test(name || '') && !DOC_FILE.test(name || '')) return fail('文件名必须是 .py 文件（或规则说明 spec.md），只能包含字母、数字、下划线、点和横线');
  const existed = existsSync(path.join(dir, name));
  await writeFile(path.join(dir, name), String(content ?? ''));
  await touchProject(projectId);
  return ok({ created: !existed });
}

// 用户在网页上自己改代码（POST /api/data/files/update）：只能覆盖项目里已有的 .py 文件，不能新建、不能带路径，
// 最大 200 KB。先写临时文件再改名；写完更新项目修改时间，并用同一套检查编译一次，结果一起返回
export const USER_FILE_MAX = 200_000;
export async function updateProjectFileByUser({ projectId, name, content }) {
  const dir = pdir(projectId);
  if (!existsSync(path.join(dir, 'project.json'))) return fail(`项目 ${projectId} 不存在`);
  if (typeof name !== 'string' || !SAFE_FILE.test(name) || path.basename(name) !== name) return fail('只能修改项目里已有的 .py 文件');
  if (typeof content !== 'string') return fail('content 必须是字符串');
  if (Buffer.byteLength(content, 'utf8') > USER_FILE_MAX) return fail(`文件太大了（最多 ${USER_FILE_MAX / 1000} KB）`);
  const f = path.join(dir, name);
  let st; try { st = await stat(f); } catch { return fail(`找不到文件 ${name}`); }
  if (!st.isFile()) return fail('只能修改项目里已有的 .py 文件');
  const tmp = `${f}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try { await writeFile(tmp, content); await rename(tmp, f); } catch (e) { await rm(tmp, { force: true }).catch(() => {}); throw e; }
  await touchProject(projectId);
  const compile = await compileProject({ projectId, entry: name }).catch(() => null);
  return ok({ name, bytes: Buffer.byteLength(content, 'utf8'), compile });
}

export async function deleteProjectFile({ projectId, name }) {
  if (!SAFE_FILE.test(name || '')) return fail('文件名不合法');
  if (name === 'main.py') return fail('不能删除入口文件 main.py');
  const f = path.join(pdir(projectId), name);
  if (!existsSync(f)) return fail(`找不到文件 ${name}`);
  await rm(f);
  await touchProject(projectId);
  return ok();
}

/* ---------------- compile ---------------- */

export function findAlgorithmClass(code) {
  const m = String(code).match(/^class\s+(\w+)\s*\(\s*QCAlgorithm\s*\)/m);
  return m ? m[1] : null;
}

// 回测前的静态检查（engine/lint_strategy.py，只解析 AST，不执行代码）：语法错误、危险导入/调用、
// 非日线 Resolution、LEAN 选股等是 errors（阻止回测）；其余是 warnings。
// files = [{ name, content }]，entries 里的文件必须有 QCAlgorithm 子类。返回 { errors, warnings }，每条 { file, line, code, msg_zh }
// 检查器只用 Python 标准库（ast），不依赖 venv 里的包：venv 还没装好时退回系统的 python3，
// 这样没装引擎也能看到真实的检查结果，而不是「检查器出错：spawn ENOENT」。回测本身仍然必须用 venv。
export const lintPython = () => (existsSync(VENV_PY) ? VENV_PY : 'python3');
export function lintSources(files, { entries = ['main.py'] } = {}) {
  return new Promise((resolve) => {
    const fallback = (msg) => resolve({ errors: [{ file: '', line: 0, code: 'linter', msg_zh: `检查器出错：${msg}` }], warnings: [] });
    const child = execFile(lintPython(), ['-I', path.join(ENGINE, 'lint_strategy.py')], { timeout: 30000, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      if (err && !stdout) return fallback(stderr || err.message);
      try { resolve(JSON.parse(stdout)); } catch { fallback(stdout || stderr); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ files, entries }));
  });
}

// 把检查结果排成给人和 agent 看的日志：先「必须修复」，再「警告」，都带文件名和行号
export function lintLogs({ errors = [], warnings = [] }) {
  const row = (d) => `  ${d.file ? `${d.file} ` : ''}${d.line ? `第 ${d.line} 行 ` : ''}[${d.code}] ${d.msg_zh}`;
  const logs = [];
  if (errors.length) logs.push(`必须修复（${errors.length} 处，不修好不能回测）：`, ...errors.map(row));
  if (warnings.length) logs.push(`警告（${warnings.length} 处，不阻止回测，请确认是有意为之）：`, ...warnings.map(row));
  return logs;
}

// skipLint 只给测试用（验证 LEAN 沙盒本身时要故意跑危险代码），server 和 MCP 都不会传
export async function compileProject({ projectId, entry, skipLint = false }) {
  const fr = await filesRead({ projectId });
  if (!fr.success) return fr;
  const main = fr.files.find((f) => f.name === 'main.py');
  if (!main) return ok({ state: 'BuildError', logs: ['缺少入口文件 main.py'] });
  const entries = ['main.py'];
  if (entry && entry !== 'main.py' && fr.files.some((f) => f.name === entry)) entries.push(entry);
  let lint = await lintSources(fr.files.filter((f) => f.name.endsWith('.py')), { entries });
  if (skipLint) lint = { errors: lint.errors.filter((e) => ['syntax', 'no-algorithm', 'linter'].includes(e.code)), warnings: [] };
  return ok({ compileId: crypto.randomBytes(8).toString('hex'), state: lint.errors.length ? 'BuildError' : 'BuildSuccess', logs: lintLogs(lint), lint });
}

/* ---------------- data ---------------- */

export function tickersInCode(code) {
  const set = new Set(['SPY']); // LEAN 默认基准
  const re = /add_equity\s*\(\s*["']([A-Za-z0-9.\-^]{1,12})["']|set_benchmark\s*\(\s*["']([A-Za-z0-9.\-^]{1,12})["']/g;
  let m;
  while ((m = re.exec(code))) set.add((m[1] || m[2]).toUpperCase());
  // 列表形式：tickers = ["SPY", "QQQ", ...]
  for (const lm of String(code).matchAll(/\[\s*((?:["'][A-Z][A-Z0-9.\-]{0,9}["']\s*,?\s*){2,})\]/g)) {
    for (const t of lm[1].matchAll(/["']([A-Z][A-Z0-9.\-]{0,9})["']/g)) set.add(t[1]);
  }
  return [...set];
}

export function fetchData(tickers, { force = false, minEnd } = {}) {
  const list = [...new Set((tickers || []).map((t) => String(t).trim().toUpperCase()).filter((t) => /^[A-Z0-9.\-^]{1,12}$/.test(t)))];
  if (!list.length) return Promise.resolve({ results: [] });
  return new Promise((resolve) => {
    execFile(VENV_PY, ['-I', path.join(ENGINE, 'fetch_data.py'), DATA_DIR, ...list, ...(force ? ['--force'] : []), ...(minEnd && /^\d{4}-\d{2}-\d{2}$/.test(minEnd) ? [`--min-end=${minEnd}`] : [])], { timeout: 300000, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      try { resolve(JSON.parse(String(stdout).trim().split('\n').pop())); } catch { resolve({ results: [], error: (stderr || (err && err.message) || '下载失败').slice(-600) }); }
    });
  });
}

// 测试用的替身入口：真实运行时就是 fetchData 和“本地日线文件是否存在”
const defaultRunLean = (o) => runLean(o);
export const _hooks = {
  // 调参任务编号（也是候选抽样的随机种子）：测试里固定它，结果才可复现
  newTuneJobId: () => crypto.randomBytes(8).toString('hex'),
  fetchData: (t) => fetchData(t),
  hasLocalData: (t) => existsSync(path.join(DATA_DIR, 'equity', 'usa', 'daily', `${String(t).trim().toUpperCase().replace(/-/g, '.').toLowerCase()}.zip`)),
  runLean: defaultRunLean,
  // 参数敏感性：独立进程里跑（和回测一样，页面关掉也不影响）
  startSensitivity: (projectId, backtestId, jobId) => {
    const code = `import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'lib', 'engine.mjs')).href)}).then((E) => E.runSensitivityJob(Number(process.argv[1]), process.argv[2], process.argv[3])).then(() => process.exit(0), () => process.exit(1));`;
    const child = spawn(process.execPath, ['-e', code, String(projectId), backtestId, String(jobId || '')], { detached: true, stdio: 'ignore', cwd: ROOT, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => RUNNER_ENV_KEYS.test(k))) });
    // 没有 error 监听时，启动失败会变成未捕获异常把整个服务带崩；同时把“运行中”标记改成出错，免得卡 25 分钟
    child.on('error', (e) => { sensMarkError(projectId, backtestId, `参数敏感性进程启动失败：${e.message}`, jobId).catch(() => {}); });
    child.unref();
  },
  // 调参：同样在独立进程里跑
  startTune: (projectId, backtestId, jobId) => {
    const code = `import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'lib', 'engine.mjs')).href)}).then((E) => E.runTuneJob(Number(process.argv[1]), process.argv[2], process.argv[3])).then(() => process.exit(0), () => process.exit(1));`;
    const child = spawn(process.execPath, ['-e', code, String(projectId), backtestId, String(jobId || '')], { detached: true, stdio: 'ignore', cwd: ROOT, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => RUNNER_ENV_KEYS.test(k))) });
    child.on('error', (e) => { tuneMarkError(projectId, backtestId, `调参进程启动失败：${e.message}`, jobId).catch(() => {}); });
    child.unref();
  },
};

export async function listData() {
  return readJson(path.join(DATA_DIR, 'helm-meta.json'), {});
}

/* ---------------- backtests ---------------- */

function parseNum(s) {
  if (s == null) return null;
  const n = parseFloat(String(s).replace(/[$,%\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// 回测的角色和时间段：让人一眼分清哪个是最终策略、哪些只是对照或调试
export const ROLES = ['main', 'candidate', 'control', 'ablation', 'benchmark', 'debug'];
export const PERIODS = ['dev', 'holdout', 'full'];
const pickRole = (r) => (ROLES.includes(r) ? r : null);
const pickPeriod = (p) => (PERIODS.includes(p) ? p : null);

// 验证期纪律：每次用验证期跑策略都记一笔（删掉回测也不会抹掉记录），第 2 次起网页和 agent 都会被提醒
async function logHoldout(projectId, backtestId) {
  const f = path.join(pdir(projectId), 'holdout_log.json');
  return withFileLock(f, async () => {
    const log = await readJson(f, []);
    let i = log.findIndex((x) => x.backtestId === backtestId);
    if (i < 0) { log.push({ backtestId, at: now() }); i = log.length - 1; await writeJson(f, log); }
    return i + 1;
  });
}
export async function holdoutViews(projectId) {
  return (await readJson(path.join(pdir(projectId), 'holdout_log.json'), [])).length;
}

// 尝试记录：每个跑完的非基准回测记一笔（全局、只追加）。去膨胀夏普按它数“在同一段历史上试过几次”，
// 所以删掉失败的回测、或者换个新项目重来，都不会让次数变少。多个回测进程会同时写，用 JSONL 追加。
export const TRIALS_FILE = process.env.HELM_TRIALS_FILE || path.join(ROOT, 'data', 'trials.jsonl');

async function readTrials() {
  let text = '';
  try { text = await readFile(TRIALS_FILE, 'utf8'); } catch { return []; }
  const seen = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const t = JSON.parse(line); if (t.backtestId && !seen.has(t.backtestId)) seen.set(t.backtestId, t); } catch { /* 跳过坏行 */ }
  }
  return [...seen.values()];
}

// 以基准身份跑完的回测：永久标记，之后改什么角色都不算“跑过一次策略”（防止先改调试再转正绕过计数）
const isBenchRun = (m) => Boolean(m && (m.ranAsBenchmark || (m.role === 'benchmark' && /Completed/.test(m.status))));

async function recordTrial(meta, result) {
  if (!meta || isBenchRun(meta) || !/Completed/.test(meta.status)) return null;
  const sharpe = meta.summary && meta.summary.sharpeRatio;
  if (!Number.isFinite(sharpe)) return null;
  const known = await readTrials();
  const prev = known.find((t) => t.backtestId === meta.backtestId);
  if (prev) return prev;
  const sd = dailySharpe(result);
  const t = { backtestId: meta.backtestId, projectId: Number(meta.projectId), period: meta.period || null, window: resultWindow(result), sharpe, ...(Number.isFinite(sd) ? { sharpeDaily: sd } : {}), at: meta.completed || now() };
  await mkdir(path.dirname(TRIALS_FILE), { recursive: true });
  await appendLine(TRIALS_FILE, JSON.stringify(t));
  return t;
}

// 两个日期区间重叠的天数 ≥ 较短那段的一半，就算“同一段历史”
function sameHistory(a, b) {
  if (!a || !b) return false;
  const d = (s) => Date.parse(`${s}T00:00:00Z`) / 86400000;
  const overlap = Math.min(d(a[1]), d(b[1])) - Math.max(d(a[0]), d(b[0]));
  const shorter = Math.min(d(a[1]) - d(a[0]), d(b[1]) - d(b[0]));
  return shorter > 0 && overlap >= shorter / 2;
}

async function trialSharpes(projectId, meta, result) {
  const self = await recordTrial(meta, result);
  const win = (self && self.window) || resultWindow(result);
  // 只按“是不是同一段历史”来数，不看 period 标签：改标签（比如 dev 改成 full）不能换来更少的尝试次数
  const pool = (await readTrials()).filter((t) => t.backtestId === meta.backtestId || sameHistory(t.window, win));
  const sr = meta.summary && meta.summary.sharpeRatio;
  if (!pool.some((t) => t.backtestId === meta.backtestId) && Number.isFinite(sr)) pool.push({ backtestId: meta.backtestId, projectId: Number(projectId), sharpe: sr, sharpeDaily: dailySharpe(result) });
  const own = pool.filter((t) => t.projectId === Number(projectId)).length;
  // 优先用和被检验的夏普同口径的 sharpeDaily；旧记录没有这个字段，才退回 LEAN 的夏普
  return { sharpes: pool.map((t) => (Number.isFinite(t.sharpeDaily) ? t.sharpeDaily : t.sharpe)), own, other: pool.length - own };
}

export async function validateBacktestUncached({ projectId, backtestId }) {
  const m = await loadMeta(projectId, backtestId);
  if (!m) return fail('回测不存在');
  if (!/Completed/.test(m.status)) return fail('回测还没跑完或出错了，不能做统计检验');
  const r = await loadResult(projectId, backtestId);
  if (!r) return fail('找不到回测结果');
  const t = await trialSharpes(projectId, m, r);
  const sharpes = t.sharpes.length ? t.sharpes : [m.summary && m.summary.sharpeRatio];
  // 项目可以声明自己是择时类策略：「跑赢基准」改看风险调整后（见 stats.mjs）。写在 project.json 的 validation 字段
  const proj = await readJson(path.join(pdir(projectId), 'project.json'));
  const gateMode = proj && proj.validation === 'risk-adjusted' ? 'risk-adjusted' : null;
  const validation = validateResult(r, { ...m, gateMode }, sharpes, t);
  if (gateMode) validation.gateMode = gateMode;
  // 指标一致性：LEAN 的头条数字和权益曲线、订单记录对不上，就是「指标互相矛盾」，直接判不通过（挡住 main），
  // 不做任何自动修正。这一关放在最前面，网页和 validate_backtest 都能直接看到；mainRejected 也会列出它。
  const c = checkConsistency(r);
  validation.consistency = c;
  const nChecked = c.checks.length;
  validation.gates = [
    c.ok
      ? { id: 'consistency', zh: '指标自洽（LEAN 统计和权益曲线、订单记录互相核对）', value: c.worst ? c.worst.ratio : null, ok: true, detail: c.skipped ? `${nChecked} 项一致；${c.skipped}` : `${nChecked} 项核对全部一致` }
      : { id: 'consistency', zh: '指标互相矛盾', value: c.worst ? c.worst.ratio : null, ok: false, detail: c.failures.join('；') },
    ...(validation.gates || []),
  ];
  if (!c.ok) {
    validation.pass = false;
    if (!validation.ok) validation.reason = `${validation.reason}；另外指标互相矛盾：${c.failures.join('；')}`;
  }
  validation.needs = mainNeeds(validation);
  return ok({ validation });
}

/* 统计检验的小缓存（每次约 200 ms，页面上会反复请求）。
   检验结果只取决于：回测的 meta.json 和结果文件、尝试记录 trials.jsonl（决定「试了几次」和 deflated Sharpe）、
   验证期记录 holdout_log.json、project.json 里声明的 validation 模式。这些都进缓存键（路径 + mtime + 大小，模式取值本身），
   任何一个变了就重算。失败结果不缓存；算的过程中尝试记录被追加（这次检验自己登记了一次尝试）时也不缓存，下次再存。
   最多 100 条，LRU。输出和不缓存时完全一样（取出时深拷贝）。 */
const VALIDATE_CACHE_MAX = 100;
const validateCache = new Map();
export const _validateCache = { clear: () => validateCache.clear(), size: () => validateCache.size, hits: 0, misses: 0 };
const fstat = async (f) => { try { const st = await stat(f); return `${st.mtimeMs}:${st.size}`; } catch { return '-'; } };
async function validateKey(projectId, backtestId) {
  const bd = bdir(projectId, backtestId); const bid = cleanBid(backtestId);
  const proj = await readJson(path.join(pdir(projectId), 'project.json'));
  const parts = await Promise.all([
    fstat(path.join(bd, 'meta.json')), fstat(path.join(bd, 'out', `${bid}.json`)), fstat(TRIALS_FILE), fstat(path.join(pdir(projectId), 'holdout_log.json')),
  ]);
  return JSON.stringify([PROJECTS_DIR, Number(projectId), bid, ...parts, TRIALS_FILE, proj && proj.validation === 'risk-adjusted' ? 'risk-adjusted' : null]);
}
/* 统计检验的结论落盘：backtests/<id>/validation.json（不放进 meta.json：meta 的 mtime 是缓存键的一部分，写它会让缓存永远失效）。
   研究流水线、想法记录、自动研究的验证期关卡都读它。结论没变就不重写。 */
export async function saveValidation(projectId, backtestId, v) {
  if (!v) return;
  const f = path.join(bdir(projectId, backtestId), 'validation.json');
  const next = { pass: Boolean(v.pass), ok: v.ok !== false, failed: (v.gates || []).filter((g) => !g.ok).map((g) => g.id), period: v.period || null };
  const prev = await readJson(f);
  if (prev && prev.pass === next.pass && prev.ok === next.ok && JSON.stringify(prev.failed) === JSON.stringify(next.failed)) return;
  await writeJson(f, { ...next, at: now() });
}
export async function loadValidation(projectId, backtestId) {
  return readJson(path.join(bdir(projectId, backtestId), 'validation.json'));
}

export async function validateBacktest(args) {
  let key = null;
  try { key = await validateKey(args.projectId, args.backtestId); } catch { key = null; }
  if (key && validateCache.has(key)) {
    const hit = validateCache.get(key); validateCache.delete(key); validateCache.set(key, hit); _validateCache.hits += 1;
    return structuredClone(hit);
  }
  _validateCache.misses += 1;
  const res = await validateBacktestUncached(args);
  if (res && res.success) await saveValidation(args.projectId, args.backtestId, res.validation).catch(() => {});
  if (key && res && res.success) {
    let after = null;
    try { after = await validateKey(args.projectId, args.backtestId); } catch { /* 不缓存 */ }
    if (after === key) {
      validateCache.set(key, structuredClone(res));
      while (validateCache.size > VALIDATE_CACHE_MAX) validateCache.delete(validateCache.keys().next().value);
    }
  }
  return res;
}

// 补账：把记录功能上线前已有的回测补进尝试记录和验证期记录。可重复执行，已记过的不会重复。
export async function reconcileLedgers() {
  const report = { trialsAdded: 0, holdoutBackfilled: [] };
  if (!existsSync(PROJECTS_DIR)) return report;
  const before = new Set((await readTrials()).map((t) => t.backtestId));
  for (const pid of await readdir(PROJECTS_DIR)) {
    const root = path.join(PROJECTS_DIR, pid, 'backtests');
    if (!/^\d+$/.test(pid) || !existsSync(root)) continue;
    const metas = [];
    for (const id of await readdir(root)) {
      const m = await readJson(path.join(root, id, 'meta.json'));
      if (m) metas.push(m);
    }
    metas.sort((a, b) => String(a.created).localeCompare(String(b.created)));
    for (const m of metas) {
      if (isBenchRun(m) && !m.ranAsBenchmark) { m.ranAsBenchmark = true; await writeJson(path.join(root, m.backtestId, 'meta.json'), m); }
      if (!before.has(m.backtestId) && !isBenchRun(m) && /Completed/.test(m.status)) {
        const r = await loadResult(pid, m.backtestId);
        if (r && (await recordTrial(m, r))) report.trialsAdded += 1;
      }
    }
    // 验证期：按创建时间补记，并把“第几次”写回回测
    const logFile = path.join(PROJECTS_DIR, pid, 'holdout_log.json');
    await withFileLock(logFile, async () => {
      const log = await readJson(logFile, []);
      let changed = false;
      for (const m of metas) {
        if (m.period !== 'holdout' || m.role === 'benchmark') continue;
        let i = log.findIndex((x) => x.backtestId === m.backtestId);
        if (i < 0) { log.push({ backtestId: m.backtestId, at: m.created || now(), backfilled: true }); i = log.length - 1; changed = true; report.holdoutBackfilled.push(`${pid}/${m.backtestId}`); }
        if (m.holdoutSeq !== i + 1) { m.holdoutSeq = i + 1; await writeJson(path.join(root, m.backtestId, 'meta.json'), m); }
      }
      if (changed) await writeJson(logFile, log);
    });
  }
  return report;
}

// 同一时间段里用户亲自选定的主版本（mainBy = user），没有返回 null
async function userMainOf(projectId, period, exceptId) {
  const root = path.join(pdir(projectId), 'backtests');
  let ids = [];
  try { ids = await readdir(root); } catch { return null; }
  for (const id of ids) {
    if (id === exceptId) continue;
    const o = await readJson(path.join(root, id, 'meta.json'));
    if (o && o.role === 'main' && o.mainBy === 'user' && (o.period || null) === (period || null)) return id;
  }
  return null;
}

// 改别的回测的 meta：在那个文件的锁里重新读，只改要改的字段。
// 以前是读一份、改 role、整份写回：如果中间回测进程刚写了「已完成」和结果摘要，会被旧内容盖掉。fn 返回 false 表示不用写。
async function patchMeta(file, fn) {
  return withFileLock(file, async () => {
    const o = await readJson(file);
    if (!o || fn(o) === false) return o;
    await writeJson(file, o);
    return o;
  });
}

// 让 backtestId 成为这个时间段唯一的主版本。项目级锁里先确认自己（磁盘上）仍是 main，再把同时段其它 main 降为候选：
// 两个主版本同时跑完时，先拿到锁的那个把另一个降级，另一个拿到锁时发现自己已经不是 main，就什么都不做 —— 结果总是正好一个。
async function demoteOtherMains(projectId, backtestId, period) {
  const root = path.join(pdir(projectId), 'backtests');
  await withFileLock(path.join(pdir(projectId), '.main-role'), async () => {
    const self = await readJson(path.join(root, cleanBid(backtestId), 'meta.json'));
    if (!self || self.role !== 'main') return;
    for (const id of await readdir(root)) {
      if (id === backtestId || id.startsWith('.')) continue;
      await patchMeta(path.join(root, id, 'meta.json'), (o) => {
        if (!(o.role === 'main' && (o.period || null) === (period || null))) return false;
        o.role = 'candidate'; o.mainBy = null; o.mainChosenAt = null;
      });
    }
  });
}

// file：同一个项目里要运行的入口文件。默认 main.py；基准、对照这类辅助策略写成 benchmark.py 等文件放在同一个项目里，不要另建项目
// 回测用了哪些 qlib 信号 / 股票池：从代码里的 HelmSignals("x") / HelmUniverse("y") 认出来，
// 信号再追溯到产生它的研究任务（想法检验或完整研究），这样项目页能把“研究 → 回测”连起来
// 研究目录 …/projects/<id>/research/quant_runs/<名字>_<jobId> → 项目和研究 id
export function runSource(run) {
  const m = String(run || '').replace(/[\\/]+$/, '').match(/projects[\\/](\d+)[\\/]research[\\/]quant_runs[\\/][^\\/]*_(r[0-9a-z]{6,24})$/);
  return { projectId: m ? Number(m[1]) : null, jobId: m ? m[2] : null };
}
export async function codeSources(code) {
  const sig = [...new Set([...String(code).matchAll(/HelmSignals\(\s*["']([A-Za-z0-9_]{3,60})["']/g)].map((m) => m[1]))];
  const uni = [...new Set([...String(code).matchAll(/HelmUniverse\(\s*["']([A-Za-z0-9_]{2,20})["']/g)].map((m) => m[1]))];
  if (!sig.length && !uni.length) return null;
  const signals = [];
  for (const nameS of sig) {
    const m = await readJson(path.join(DATA_DIR, 'helm', 'signals', `${nameS}.json`));
    const src = runSource(m && m.source_run);
    signals.push({ name: nameS, kind: m ? m.kind : null, factor: m ? ((m.idea_factor && m.idea_factor.name) || m.factor || m.feature || null) : null, projectId: src.projectId, jobId: src.jobId || (m && /^r[0-9a-z]{6,24}$/.test(String(m.source_job || '')) ? m.source_job : null), missing: !m });
  }
  return { signals, universes: uni };
}

export async function createBacktest({ projectId, name, role, period, file, skipLint = false }) {
  const entry = file ? String(file) : 'main.py';
  if (!SAFE_FILE.test(entry)) return fail('file 只能是项目里的 .py 文件名，比如 benchmark.py');
  // 和 compile 工具同一套检查（语法 + 静态检查）；有「必须修复」时不跑回测，不消耗一次尝试
  const c = await compileProject({ projectId, entry, skipLint });
  if (!c.success) return c;
  if (c.state !== 'BuildSuccess') return ok({ compile: c, backtest: null });
  if (_hooks.runLean === defaultRunLean && !leanSandboxState().ok) return fail(SANDBOX_MISSING_MSG);
  if (entry !== 'main.py') {
    const fr0 = await filesRead({ projectId });
    const f0 = fr0.success && fr0.files.find((f) => f.name === entry);
    if (!f0) return fail(`项目里没有 ${entry}，先用 write_file 写好它`);
    if (!findAlgorithmClass(f0.content)) return fail(`${entry} 里找不到继承 QCAlgorithm 的类`);
  }
  const backtestId = crypto.randomBytes(16).toString('hex');
  const dir = bdir(projectId, backtestId);
  await mkdir(path.join(dir, 'code'), { recursive: true });
  // 快照代码：之后改代码不影响这次回测，也能随时看到当时跑的是哪版
  const fr = await filesRead({ projectId });
  for (const f of fr.files) await writeFile(path.join(dir, 'code', f.name), f.content);
  const meta = {
    backtestId, projectId: Number(projectId), name: name || `回测 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    status: 'In Queue...', progress: 0, created: now(), completed: null, error: null, stacktrace: null, note: '',
    role: pickRole(role), period: pickPeriod(period), file: entry,
  };
  const main = fr.files.find((f) => f.name === entry);
  const src = main ? await codeSources(main.content) : null;
  if (src) meta.sources = src;
  // 指纹：代码在这里记；数据要等回测进程下载完数据、启动 LEAN 之前再记（下载可能会更新数据）
  meta.fingerprint = { version: FINGERPRINT_VERSION, code: codeFingerprint(fr.files), data: null };
  if (meta.period === 'holdout' && meta.role !== 'benchmark') meta.holdoutSeq = await logHoldout(projectId, backtestId);
  await writeJson(path.join(dir, 'meta.json'), meta);
  const child = spawn(process.execPath, [path.join(ROOT, 'lib', 'run-backtest.mjs'), String(projectId), backtestId], {
    // 回测进程本身是 Helm 自己的代码：只给它用得到的环境变量（白名单 RUNNER_ENV_KEYS）。
    // HELM_TOKEN / HELM_URL / Alpaca 密钥都不传；LEAN 子进程另有更严的白名单（runLean）
    detached: true, stdio: 'ignore', cwd: ROOT, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => RUNNER_ENV_KEYS.test(k))),
  });
  // 没有 error 监听时，spawn 失败（EAGAIN / EMFILE）会变成未捕获异常把服务带崩，回测也会一直停在「排队中」
  child.on('error', (e) => {
    writeJson(path.join(dir, 'meta.json'), { ...meta, status: 'Runtime Error', completed: now(), progress: 1, error: `回测进程启动失败：${e.message}` }).catch(() => {});
  });
  child.unref();
  await touchProject(projectId);
  return ok({ compile: c, backtest: meta });
}

// 跑一次本地 LEAN（回测和模拟实盘共用）。返回 { result, error }；result 是 LEAN 的结果 JSON
// 策略代码是 agent 写的，在 LEAN 里以用户身份运行。用 macOS 沙盒禁止它读写 Alpaca 密钥所在的目录，
// 否则策略可以 open() 密钥文件、self.debug() 打到日志里，再被 agent 读回去。
export function secretDirs() {
  const dirs = [path.join(ROOT, 'data', 'secrets'), userSecretsDir()];
  for (const k of ['HELM_ALPACA_FILE', 'HELM_AI_FILE', 'HELM_QC_FILE']) if (process.env[k]) dirs.push(path.dirname(path.resolve(process.env[k])));
  return pathForms(dirs);
}
// 沙盒按真实路径匹配（macOS 的 /var、/tmp 都是指向 /private 的链接），每个路径两种写法都要写
function realPath(d) {
  const parts = []; let cur = path.resolve(d);
  while (cur !== path.dirname(cur)) { try { return path.join(realpathSync(cur), ...parts); } catch { parts.unshift(path.basename(cur)); cur = path.dirname(cur); } }
  return path.resolve(d);
}
const pathForms = (list) => [...new Set(list.filter(Boolean).flatMap((d) => [path.resolve(d), realPath(d)]))];
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
// 策略代码（agent 写的）跑在这个沙盒里：
// - 不能联网（包括本机 127.0.0.1:4377 上的 Helm 接口）
// - $HOME、仓库、项目目录、尝试记录一律不能读；只开放 LEAN 运行必需的：engine/（LEAN、数据、venv）、dotnet、
//   Python 运行时、这次回测的代码目录、输出目录、私有临时目录
// - 只能写这次回测的输出目录和私有临时目录
// - 密钥目录和仓库 .env 最后再拦一次（规则后写的优先）
// run 不传时只拦密钥目录（旧行为）
// 策略沙盒的状态：available = 系统有 sandbox-exec；off = 用户明确设了 HELM_EXEC_SANDBOX=off。
// 没有沙盒又没设 off 时，回测 / 模拟实盘一律拒绝跑（不在沙盒外悄悄运行 AI 写的代码）
export function leanSandboxState() {
  const available = process.platform === 'darwin' && existsSync(SANDBOX_EXEC);
  const off = process.env.HELM_EXEC_SANDBOX === 'off';
  return { available, off, ok: available || off };
}
export const SANDBOX_MISSING_MSG = '策略沙盒不可用（这台机器没有 macOS 的 /usr/bin/sandbox-exec），为了安全不运行 AI 写的策略代码。确实要在没有沙盒的情况下运行，请在 .env 里加一行 HELM_EXEC_SANDBOX=off 后重启 Helm（策略代码将能读写你的文件、联网）。';
export function sandboxed(cmd, args, run) {
  const sb = leanSandboxState();
  if (!sb.available) { if (sb.off) return [cmd, args]; throw new Error(SANDBOX_MISSING_MSG); }
  const q = (p) => `"${String(p).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const sub = (list) => pathForms(list).map((d) => `(subpath ${q(d)})`).join(' ');
  const lit = (list) => [...new Set(list)].map((d) => `(literal ${q(d)})`).join(' ');
  const secrets = `(deny file-read* file-write* ${sub(secretDirs())} ${lit(pathForms([path.join(ROOT, '.env')]))})`;
  if (!run) return [SANDBOX_EXEC, ['-p', `(version 1)(allow default)${secrets}`, cmd, ...args]];
  const { algorithmFile, outDir, tmpDir, py } = run;
  const readable = [ENGINE, path.dirname(DOTNET), path.dirname(realPath(DOTNET)), path.dirname(algorithmFile), outDir, tmpDir];
  if (py) readable.push(py.home, path.dirname(py.dll), py.sitePackages);
  // 路径解析要 stat 每一级父目录（只给元数据，不能列目录内容）
  const ancestors = [];
  for (const d of pathForms(readable)) for (let cur = path.dirname(d); cur !== path.dirname(cur); cur = path.dirname(cur)) ancestors.push(cur);
  const trials = process.env.HELM_TRIALS_FILE ? pathForms([process.env.HELM_TRIALS_FILE]) : [];
  const profile = [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny file-write*)',
    `(allow file-write* ${sub([outDir, tmpDir])} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty"))`,
    `(deny file-read* ${sub([os.homedir(), ROOT, PROJECTS_DIR])}${trials.length ? ` ${lit(trials)}` : ''})`,
    `(allow file-read* ${sub(readable)})`,
    `(allow file-read-metadata ${lit(ancestors)})`,
    secrets,
  ].join('\n');
  return [SANDBOX_EXEC, ['-p', profile, cmd, ...args]];
}
// LEAN 进程只拿到这些环境变量（白名单）；其余（API key、HELM_* 路径等）一律不传
const LEAN_ENV_KEYS = /^(PATH|HOME|USER|LOGNAME|LANG|LC_[A-Z]+|TZ|DOTNET_[A-Za-z0-9_]+)$/;
// run-backtest.mjs 进程（下载数据 + 启动 LEAN）：系统基础变量、代理 / 证书（下载数据用）、dotnet、Helm 的路径设置
const RUNNER_ENV_KEYS = /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|LANG|LC_[A-Z]+|TZ|(HTTPS?|ALL|NO)_PROXY|(https?|all|no)_proxy|SSL_CERT_(FILE|DIR)|REQUESTS_CA_BUNDLE|DOTNET_[A-Za-z0-9_]+|DOTNET_BIN|HELM_PROJECTS_DIR|HELM_TRIALS_FILE|HELM_ALPACA_FILE|HELM_EXEC_SANDBOX|HELM_LEAN_DATA|HELM_LANG)$/;

// LEAN 启动参数。parameters（可选，{名字: 字符串值}）对应 LEAN 的 --parameters 名字:值,名字:值，
// 策略里用 self.get_parameter 读取；不传时参数列表和以前完全一样
export function leanArgs({ algorithmFile, className, outDir, id, name, parameters }) {
  const args = [
    path.join(LAUNCHER_DIR, 'QuantConnect.Lean.Launcher.dll'),
    '--environment', 'backtesting',
    '--algorithm-language', 'Python',
    '--algorithm-location', algorithmFile,
    '--algorithm-type-name', className,
    '--data-folder', `${DATA_DIR}/`,
    '--results-destination-folder', outDir,
    '--algorithm-id', id,
    '--backtest-name', name || id,
    '--close-automatically', 'true',
  ];
  const kv = Object.entries(parameters || {});
  if (kv.length) {
    for (const [k, v] of kv) if (!/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(k) || !/^[-+0-9.eE]{1,30}$/.test(String(v))) throw new Error(`参数 ${k} 的名字或值不合法`);
    args.push('--parameters', kv.map(([k, v]) => `${k}:${v}`).join(','));
  }
  return args;
}

export async function runLean({ algorithmFile, className, outDir, id, name, onProgress, parameters, timeoutMs = 20 * 60 * 1000 }) {
  const py = await pythonRuntime();
  if (!py) throw new Error('找不到 Python 运行环境（engine/.venv 不存在或启动不了），LEAN 跑不起来。按 README 的安装步骤装好引擎后再试。');
  ensureHelmData(py);
  await mkdir(outDir, { recursive: true });
  const args = leanArgs({ algorithmFile, className, outDir, id, name, parameters });
  // 每次运行一个私有临时目录（沙盒里唯一可写的地方之一），跑完删掉
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'helm-lean-'));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => LEAN_ENV_KEYS.test(k))),
    TMPDIR: tmpDir,
    DOTNET_ROOT: path.dirname(DOTNET),
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_EnableDiagnostics: '0', // 否则 dotnet 会在 TMPDIR 建诊断用的 unix socket（沙盒禁止网络）
    PYTHONNET_PYDLL: py.dll,
    PYTHONHOME: py.home,
    PYTHONPATH: py.sitePackages,
    PYTHONDONTWRITEBYTECODE: '1',
    MPLCONFIGDIR: tmpDir, // matplotlib 读不到 ~/.matplotlib，缓存写到私有临时目录
  };
  const [cmd, cmdArgs] = sandboxed(DOTNET, args, { algorithmFile, outDir, tmpDir, py });
  await new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { cwd: LAUNCHER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let lastBeat = 0; let pct = null; let tail = []; let fresh = false;
    child.stdout.on('data', (chunk) => {
      // 用 LEAN 日志里的进度粗略估算；最后几行日志一起交给页面（运行中也能看到它在做什么）
      const str = String(chunk);
      const m = str.match(/(\d{1,3})% complete/);
      if (m) pct = Number(m[1]) / 100;
      const lines = str.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
      if (lines.length) { tail = tail.concat(lines).slice(-12); fresh = true; }
      if (onProgress && (m || fresh) && Date.now() - lastBeat > 1500) { lastBeat = Date.now(); fresh = false; onProgress(pct, tail.map((l) => scrubPaths(l).slice(0, 240))); }
    });
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', () => { clearTimeout(timer); resolve(); });
    child.on('error', () => { clearTimeout(timer); resolve(); });
  });
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  const result = await readJson(path.join(outDir, `${id}.json`));
  if (result) return { result, error: null };
  let tail = '';
  try { tail = (await readFile(path.join(outDir, 'log.txt'), 'utf8')).split('\n').filter((l) => /ERROR/.test(l)).slice(-10).join('\n'); } catch { /* none */ }
  return { result: null, error: tail || 'LEAN 没有生成结果文件（可能是引擎启动失败）' };
}

// 策略会读的数据：代码里的代码 + HelmUniverse 成员 + HelmSignals 打分（以及股票池 / 信号文件本身）
export async function backtestDataFingerprint(code, dataDir = DATA_DIR) {
  const inp = await strategyInputs({ dataDir, code, baseTickers: tickersInCode(code) });
  return dataFingerprint({ dataDir, tickers: inp.tickers, files: inp.files });
}

// 由 run-backtest.mjs 调用（独立进程，网页和 agent 退出都不影响它跑完）
// 运行前的“数据过期”提示（只是警告，不拦截）：回测结束日期（代码里的 set_end_date，没写就当作今天）
// 比信号/股票池导出的最后一天晚了一周以上时，引擎里的 HelmSignals/HelmUniverse 会返回空，策略等于没有信号。
export async function staleDataWarnings({ dataDir = DATA_DIR, code, today = new Date() }) {
  const out = [];
  const src = String(code || '');
  const m = src.match(/^[ \t]*self\.(?:set_end_date|SetEndDate)\(\s*(\d{4})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})/m);
  const endDate = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const endStr = endDate.toISOString().slice(0, 10);
  const lateBy = (last) => /^\d{4}-\d{2}-\d{2}$/.test(String(last)) ? Math.round((endDate - new Date(`${last}T00:00:00Z`)) / 86400000) : 0;
  const readMeta = async (kind, key) => readJson(path.join(dataDir, 'helm', kind, `${key}.json`), null);
  for (const mm of src.matchAll(/HelmSignals\(\s*["']([A-Za-z0-9_]{3,60})["']/g)) {
    const meta = await readMeta('signals', mm[1]);
    const ends = Object.values((meta && meta.segments) || {}).map((x) => x && x.end).filter(Boolean).sort();
    const last = ends[ends.length - 1];
    if (last && lateBy(last) > 7) out.push(`信号 ${mm[1]} 只到 ${last}，回测结束日期是 ${endStr}：${last} 之后策略拿不到打分。请重新导出信号或把结束日期提前。`);
  }
  for (const mm of src.matchAll(/HelmUniverse\(\s*["']([A-Za-z0-9_]{2,20})["']/g)) {
    const meta = await readMeta('universes', mm[1]);
    const last = meta && meta.end;
    if (last && lateBy(last) > 7) out.push(`股票池 ${mm[1]} 只到 ${last}，回测结束日期是 ${endStr}：${last} 之后成分股是空的。请重新 prepare_universe 或把结束日期提前。`);
  }
  return out;
}

export async function runBacktestJob(projectId, backtestId) {
  const dir = bdir(projectId, backtestId);
  const metaFile = path.join(dir, 'meta.json');
  const meta = await readJson(metaFile);
  if (!meta) return;
  // 运行期间用户可能改了名字、角色、时间段：每次写之前先读回这些字段，避免跑完时被旧值覆盖
  // 在文件锁里读回、合并、写入：网页 / agent 同时改角色时不会互相覆盖
  const save = (patch) => withFileLock(metaFile, async () => {
    const disk = await readJson(metaFile);
    if (disk) for (const k of ['name', 'note', 'role', 'period', 'holdoutSeq', 'mainRejected', 'mainBy', 'mainChosenAt']) if (k in disk) meta[k] = disk[k];
    Object.assign(meta, patch);
    return writeJson(metaFile, meta);
  });
  try {
    const entry = meta.file && SAFE_FILE.test(meta.file) ? meta.file : 'main.py';
    const code = await readFile(path.join(dir, 'code', entry), 'utf8');
    const cls = findAlgorithmClass(code);
    await save({ status: 'In Progress...', progress: 0.05, phase: '准备数据' });
    const wanted = tickersInCode(code);
    const fetched = await _hooks.fetchData(wanted);
    const bad = (fetched.results || []).filter((r) => r.status === 'error');
    // 下载整体失败（脚本崩了/超时/没联网）时 results 是空的：这时每个代码都当作“没更新成功”。
    // 本地有旧数据的照常跑（只记警告）；本地一点数据都没有的，LEAN 只会安静地跑空，所以直接失败并点名。
    if (fetched.error) for (const t of wanted) if (!bad.some((r) => String(r.ticker).toUpperCase() === t.toUpperCase())) bad.push({ ticker: t, status: 'error', error: `下载失败：${String(fetched.error).slice(-200)}` });
    const missing = [...new Set(bad.map((r) => String(r.ticker)).filter((t) => wanted.some((w) => w.toUpperCase() === t.toUpperCase()) && !_hooks.hasLocalData(t)))];
    if (missing.length) {
      const why = bad.filter((r) => missing.includes(String(r.ticker))).map((r) => `${r.ticker}（${r.error}）`).join('；');
      await save({ status: 'Runtime Error', completed: now(), progress: 1, phase: null, data: [], error: `缺少回测必需的行情数据：${missing.join('、')}。本地没有这些代码的数据，下载也失败了：${why}。请检查网络和代码拼写后重试。`, dataWarnings: bad.map((r) => `${r.ticker}: ${r.error}`) });
      return;
    }
    meta.data = (fetched.results || []).map(({ ticker, start, end, status }) => ({ ticker, start, end, status }));
    // 代码里 HelmMacro("X") 用到的 FRED 序列：回测前更新（下载失败但本地有旧数据时照常运行，只记警告）
    const macroIds = macroInCode(code);
    if (macroIds.length) {
      const mr = (await fetchMacro(macroIds, { dataDir: DATA_DIR }).catch((err) => ({ results: macroIds.map((id) => ({ id, status: 'error', error: String(err.message || err) })) }))).results;
      meta.macro = mr.map(({ id, start, end, status }) => ({ id, start, end, status }));
      for (const r of mr) if (r.status === 'error') bad.push({ ticker: `FRED ${r.id}`, error: r.stale ? `${r.error}（用本地旧数据，截至 ${r.end}）` : r.error });
    }
    // 代码里 HelmDataset("x") 用到的自建数据集：记下版本和来源，结果页据此提醒；数据集不存在时只记警告（LEAN 运行时会报错）
    const dsNames = datasetsInCode(code);
    if (dsNames.length) {
      meta.datasets = await datasetUsage({ dataDir: DATA_DIR, names: dsNames });
      for (const d of meta.datasets) if (d.missing) bad.push({ ticker: `自建数据集 ${d.name}`, error: '不存在：先让 agent 用 save_dataset 创建' });
    }
    await save({ progress: 0.15, phase: '运行 LEAN', dataWarnings: [...bad.map((r) => `${r.ticker}: ${r.error}`), ...await staleDataWarnings({ code }).catch(() => [])] });
    // 数据指纹：LEAN 真正读到的那份数据（下载之后、运行之前）。出错只记下原因，不影响回测
    try {
      const fp = meta.fingerprint && meta.fingerprint.code ? meta.fingerprint : { version: FINGERPRINT_VERSION, code: codeFingerprint((await backtestCode({ projectId, backtestId })).files || []) };
      await save({ fingerprint: { ...fp, data: await backtestDataFingerprint(code) } });
    } catch (e) {
      await save({ fingerprint: { ...(meta.fingerprint || {}), data: null, dataError: String(e.message || e).slice(0, 200) } }).catch(() => {});
    }

    const out = path.join(dir, 'out');
    const lr = await runLean({
      algorithmFile: path.join(dir, 'code', entry), className: cls, outDir: out, id: backtestId, name: meta.name,
      onProgress: (p, logTail) => save({ ...(p != null ? { progress: 0.15 + 0.8 * p } : {}), logTail }).catch(() => {}),
    });
    const result = lr.result;
    const logFile = path.join(out, `${backtestId}-log.txt`);
    if (!result) {
      await save({ status: 'Runtime Error', completed: now(), progress: 1, phase: null, logTail: null, error: lr.error });
      return;
    }
    const state = result.state || {};
    const s = result.statistics || {};
    const failed = state.Status === 'RuntimeError' || Boolean(state.RuntimeError);
    await save({
      status: failed ? 'Runtime Error' : 'Completed.',
      completed: now(), progress: 1, phase: null, logTail: null,
      error: failed ? (state.RuntimeError || '运行时错误') : null,
      stacktrace: failed ? (state.StackTrace || null) : null,
      summary: {
        netProfit: s['Net Profit'] ?? null,
        compoundingAnnualReturn: s['Compounding Annual Return'] ?? null,
        sharpeRatio: parseNum(s['Sharpe Ratio']),
        drawdown: s.Drawdown ?? null,
        winRate: s['Win Rate'] ?? null,
        trades: parseNum(s['Total Orders']),
      },
      hasLog: existsSync(logFile),
    });
    if (!failed && meta.role === 'benchmark') await save({ ranAsBenchmark: true });
    if (!failed) await recordTrial(meta, result).catch(() => {});
    // 运行前选了“主版本”：跑完必须通过统计检验才保留，否则降为候选并写明原因
    if (!failed && meta.role === 'main' && meta.mainBy !== 'user') {
      const v = await validateBacktest({ projectId, backtestId });
      const um = v.success && v.validation.pass ? await userMainOf(projectId, meta.period, backtestId) : null;
      if (um) await save({ role: 'candidate', note: `${meta.note ? `${meta.note}\n` : ''}通过了统计检验；这个时间段的主版本是用户选定的 ${um}，所以先标为候选。` });
      else if (v.success && v.validation.pass) await demoteOtherMains(projectId, backtestId, meta.period);
      else await save({ role: 'candidate', mainRejected: v.success ? v.validation.gates.filter((g) => !g.ok).map((g) => `${g.zh}：${g.detail}`) : v.errors });
    }
  } catch (e) {
    await save({ status: 'Runtime Error', completed: now(), progress: 1, phase: null, error: `引擎出错：${e.message}` });
  }
}

async function loadMeta(projectId, backtestId) {
  return readJson(path.join(bdir(projectId, backtestId), 'meta.json'));
}
// LEAN 结果文件 3.7–5.2 MB，解析一次约 12–20 ms；回测页打开时 read / chart / orders / 检验会各读一遍。
// 按「路径 + 修改时间 + 大小」缓存最近用过的几个（解析后的对象约 30 MB，只留 3 个）。文件变了就重读。
// 返回的对象是共享的：调用方只能读，不能改。
const RESULT_CACHE = new Map();
const RESULT_CACHE_MAX = 3;
async function loadResult(projectId, backtestId) {
  const f = path.join(bdir(projectId, backtestId), 'out', `${cleanBid(backtestId)}.json`);
  let st;
  try { st = await stat(f); } catch { return null; }
  const sig = `${st.mtimeMs}:${st.size}`;
  const hit = RESULT_CACHE.get(f);
  if (hit && hit.sig === sig) { RESULT_CACHE.delete(f); RESULT_CACHE.set(f, hit); return hit.r; } // 移到最近
  const r = await readJson(f);
  if (r) {
    RESULT_CACHE.set(f, { sig, r });
    while (RESULT_CACHE.size > RESULT_CACHE_MAX) RESULT_CACHE.delete(RESULT_CACHE.keys().next().value);
  }
  return r;
}

// 回测进程意外消失（比如电脑重启）时，把卡住的状态标成出错
async function reconcile(meta) {
  if (!meta || !/Queue|Progress/.test(meta.status)) return meta;
  try {
    const st = await stat(path.join(bdir(meta.projectId, meta.backtestId), 'meta.json'));
    if (Date.now() - st.mtimeMs > 25 * 60 * 1000) {
      meta.status = 'Runtime Error';
      meta.error = '回测进程中断了（超过 25 分钟没有更新），请重新运行。';
      await writeJson(path.join(bdir(meta.projectId, meta.backtestId), 'meta.json'), meta);
    }
  } catch { /* ignore */ }
  return meta;
}

export async function backtestsList({ projectId }) {
  const root = path.join(pdir(projectId), 'backtests');
  if (!existsSync(pdir(projectId))) return fail(`项目 ${projectId} 不存在`);
  const ids = existsSync(root) ? await readdir(root) : [];
  const list = [];
  for (const id of ids) {
    const m = await reconcile(await loadMeta(projectId, id));
    if (!m) continue;
    list.push({ backtestId: m.backtestId, name: m.name, status: m.status, progress: m.progress, created: m.created, error: m.error, note: m.note, role: m.role || null, period: m.period || null, file: m.file && m.file !== 'main.py' ? m.file : null, holdoutSeq: m.holdoutSeq || null, mainRejected: m.mainRejected || null, mainBy: m.mainBy || null, sources: m.sources || null, ...(m.summary || {}) });
  }
  list.sort((a, b) => String(b.created).localeCompare(String(a.created)));
  return ok({ backtests: list, count: list.length });
}

export async function backtestsRead({ projectId, backtestId }) {
  const m = await reconcile(await loadMeta(projectId, backtestId));
  if (!m) return fail('回测不存在');
  const r = /Completed|Error/.test(m.status) ? await loadResult(projectId, backtestId) : null;
  // 和同项目其他回测的指纹比：同样的代码、数据却不同时提醒（老回测没有指纹，返回 status: none）
  let fpCheck = { status: 'none' };
  if (m.fingerprint) {
    try {
      const root = path.join(pdir(projectId), 'backtests');
      const others = [];
      for (const id of await readdir(root)) {
        if (id === m.backtestId) continue;
        const o = await loadMeta(projectId, id);
        if (o && o.fingerprint) others.push(o);
      }
      fpCheck = fingerprintCheck(m, others);
    } catch { /* 比较失败不影响读取 */ }
  }
  // 数据在这次回测之后有没有更新过（行情每天刷新、Yahoo 会回溯调整复权价）：用现在本地的数据重算一次指纹和当时记的比。
  // 指纹按文件大小 + 修改时间缓存，平时只是 stat 一下。true = 变了（重跑结果可能不同），false = 没变，null = 没法判断（老回测 / 出错）
  let dataChanged = null; let dataChangedTickers = [];
  const was = m.fingerprint && m.fingerprint.data;
  if (was && was.hash && /Completed/.test(m.status)) {
    try {
      const entry = m.file && SAFE_FILE.test(m.file) ? m.file : 'main.py';
      const cur = await backtestDataFingerprint(await readFile(path.join(bdir(projectId, backtestId), 'code', entry), 'utf8'));
      dataChanged = cur.hash !== was.hash;
      if (dataChanged) dataChangedTickers = ((diffData(was, cur) || {}).changed || []).map((c) => c.ticker).slice(0, 30);
    } catch { dataChanged = null; }
  }
  return ok({
    backtest: {
      ...m,
      fingerprintCheck: fpCheck,
      dataChanged,
      dataChangedTickers,
      dataChangedNote: dataChanged ? '这次回测之后行情数据已经更新过，现在重跑结果可能不同；重跑一次可以对比' : null,
      statistics: r ? r.statistics : {},
      runtimeStatistics: r ? r.runtimeStatistics : {},
      charts: r ? Object.keys(r.charts || {}) : [],
    },
  });
}

export async function chartRead({ projectId, backtestId, name }) {
  const r = await loadResult(projectId, backtestId);
  if (!r) return fail('还没有结果');
  const chart = (r.charts || {})[name];
  return chart ? ok({ chart }) : fail(`没有名为 ${name} 的图表`);
}

const ORDER_TYPE = ['Market', 'Limit', 'StopMarket', 'StopLimit', 'MarketOnOpen', 'MarketOnClose', 'OptionExercise', 'LimitIfTouched', 'ComboMarket', 'ComboLimit', 'ComboLegLimit', 'TrailingStop'];
const ORDER_STATUS = ['New', 'Submitted', 'PartiallyFilled', 'Filled', 'Canceled', 'None', 'Invalid', 'CancelPending', 'UpdateSubmitted'];
export async function ordersRead({ projectId, backtestId, start = 0, end = 100 }) {
  const r = await loadResult(projectId, backtestId);
  if (!r) return fail('还没有结果');
  const all = Object.values(r.orders || {}).sort((a, b) => a.id - b.id);
  const orders = all.slice(start, end).map((o) => ({
    id: o.id, time: o.time, symbol: o.symbol && o.symbol.value, type: ORDER_TYPE[o.type] ?? o.type,
    direction: o.direction === 0 ? 'Buy' : o.direction === 1 ? 'Sell' : o.direction,
    quantity: o.quantity, price: o.price, status: ORDER_STATUS[o.status] ?? o.status, tag: o.tag || undefined,
  }));
  return ok({ orders, length: all.length });
}

export async function logRead({ projectId, backtestId, query = '', start = 0, end = 300 }) {
  const f = path.join(bdir(projectId, backtestId), 'out', `${cleanBid(backtestId)}-log.txt`);
  let lines = [];
  try { lines = (await readFile(f, 'utf8')).split('\n').filter(Boolean); } catch { return fail('没有日志（回测可能还没跑完）'); }
  if (query) lines = lines.filter((l) => l.toLowerCase().includes(String(query).toLowerCase()));
  return ok({ logs: lines.slice(start, end), length: lines.length });
}

export async function updateBacktest(args) {
  const f = path.join(bdir(args.projectId, args.backtestId), 'meta.json');
  // 自己的 meta 在锁里读改写；把别的主版本降级放在锁外面做（它要拿项目锁和别人的文件锁，放在里面可能互相等）
  const r = await withFileLock(f, () => updateBacktestLocked(f, args));
  if (r.promote) await demoteOtherMains(args.projectId, args.backtestId, r.promote.period);
  return r.result;
}
async function updateBacktestLocked(f, { projectId, backtestId, name, note, role, period }) {
  const res = (result, promote = null) => ({ result, promote });
  const m = await readJson(f);
  if (!m) return res(fail('回测不存在'));
  if (name) m.name = String(name).slice(0, 120);
  if (note != null) m.note = String(note).slice(0, 4000);
  if (role !== undefined) {
    if (role && !ROLES.includes(role)) return res(fail(`role 只能是 ${ROLES.join(' / ')}`));
    // 跑完时是基准的回测不记入尝试次数，所以不能事后改成策略角色；否则可以用“基准”身份试很多版本、只把最好的转正
    if (isBenchRun(m) && !['benchmark', 'debug'].includes(role)) {
      return res(fail('这个回测是以基准身份跑完的，没有计入尝试次数，不能改成策略角色。要把它当策略，请用对应的 role 重新跑一次回测。'));
    }
    // 用户在网页上亲自选的主版本：agent 不能把别的回测顶替它（见下面），这个回测本身被改成别的角色时，清掉「用户选定」标记
    if (role !== 'main') { m.mainBy = null; m.mainChosenAt = null; }
    m.role = role || null;
  }
  if (period !== undefined) {
    if (period && !PERIODS.includes(period)) return res(fail(`period 只能是 ${PERIODS.join(' / ')}`));
    m.period = period || null;
  }
  if (m.period === 'holdout' && m.role !== 'benchmark' && !m.holdoutSeq) m.holdoutSeq = await logHoldout(projectId, backtestId);
  // 主版本要过统计检验；同一时间段只保留一个主版本，新主版本把旧的降为候选
  // 已经是用户亲自选定的主版本：保持原样，不再过关卡
  if (role === 'main' && m.mainBy === 'user') { await writeJson(f, m); return res(ok()); }
  if (role === 'main') {
    const um = await userMainOf(projectId, m.period, backtestId);
    if (um) {
      m.role = 'candidate';
      await writeJson(f, m);
      return res(fail(`用户已经在网页上选定了这个时间段的主版本（${um}），agent 不能替换它。这个回测先标为候选；在总结里告诉用户它的检验结果，由用户决定要不要换。`));
    }
    await writeJson(f, m);
    const v = await validateBacktest({ projectId, backtestId });
    if (!v.success) { m.role = 'candidate'; await writeJson(f, m); return res(fail(`不能标为主版本：${v.errors.join('; ')}`)); }
    if (!v.validation.pass) {
      m.role = 'candidate';
      m.mainRejected = v.validation.gates.filter((g) => !g.ok).map((g) => `${g.zh}：${g.detail}`);
      await writeJson(f, m);
      return res(fail(`不能标为主版本，没通过统计检验：${m.mainRejected.join('；')}。${GATE_RULES}`));
    }
    m.mainRejected = null;
    await writeJson(f, m);
    return res(ok(), { period: m.period });
  }
  await writeJson(f, m);
  return res(ok());
}

/** 删除项目：整个目录移到 projects/.trash/<id>-<时间>，不直接抹掉，需要时可以手动搬回来。
 *  有回测在跑时拒绝（模拟实盘、qlib 研究由 server 先检查）。 */
// 用户在网页上亲自选定主版本（只有网页能调，agent 没有这个接口）：用户的决定，不经过统计检验关卡。
// 统计检验的结果照旧算、照旧在检验面板里显示，但不再写进 mainRejected，不阻止 Alpaca 模拟，也不会被自动降级。
// 以基准身份跑完的回测除外：它没记进尝试次数，转成策略会让尝试次数少算（研究登记的完整性，不是对选择的评判）。
export async function setMainByUser({ projectId, backtestId }) {
  const f = path.join(bdir(projectId, backtestId), 'meta.json');
  const r = await withFileLock(f, async () => {
    const m = await readJson(f);
    if (!m) return fail('回测不存在');
    if (!/Completed/.test(m.status || '')) return fail('回测还没跑完，跑完后才能设为主版本');
    if (isBenchRun(m)) return fail('这个回测是以基准身份跑完的，没有计入尝试次数，不能设为主版本。要用这份代码，请用策略角色重新跑一次。');
    m.role = 'main';
    m.mainBy = 'user';
    m.mainChosenAt = now();
    m.mainRejected = null;
    await writeJson(f, m);
    return ok({ role: 'main', mainBy: 'user', period: m.period });
  });
  if (r.success) await demoteOtherMains(projectId, backtestId, r.period);
  return r;
}

export async function trashProject({ projectId }) {
  const id = Number(projectId);
  if (!Number.isInteger(id) || id <= 0) return fail('项目编号不对');
  const dir = pdir(id);
  if (!existsSync(path.join(dir, 'project.json'))) return fail(`项目 ${id} 不存在`);
  const bdirRoot = path.join(dir, 'backtests');
  if (existsSync(bdirRoot)) for (const b of await readdir(bdirRoot)) {
    const m = await readJson(path.join(bdirRoot, b, 'meta.json'));
    if (m && /Queue|Progress/.test(m.status || '')) return fail('这个项目还有回测在运行，等它结束再删');
    // 参数敏感性 / 调参是在后台跑的：项目被挪走后它们还会往原路径写，调参候选也已经记进了 trials.jsonl
    for (const [f, stale] of [[path.join(bdirRoot, b, 'sensitivity', 'sensitivity.json'), SENS_STALE_MS], [path.join(bdirRoot, b, 'tuning', 'tuning.json'), TUNE_STALE_MS]]) {
      const j = await readJson(f);
      if (j && j.status === 'running' && Date.now() - (await stat(f).then((x) => x.mtimeMs, () => 0)) <= stale) return fail('这个项目还有参数敏感性或调参在运行，等它结束再删');
    }
  }
  const trash = path.join(PROJECTS_DIR, '.trash');
  await mkdir(trash, { recursive: true });
  const dest = path.join(trash, `${id}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await rename(dir, dest);
  return ok({ trashedTo: path.relative(PROJECTS_DIR, dest) });
}

export async function deleteBacktest({ projectId, backtestId }) {
  const dir = bdir(projectId, backtestId);
  if (!existsSync(path.join(dir, 'meta.json'))) return fail('回测不存在');
  await rm(dir, { recursive: true, force: true });
  return ok();
}

export async function backtestCode({ projectId, backtestId }) {
  const dir = path.join(bdir(projectId, backtestId), 'code');
  try {
    const names = (await readdir(dir)).filter((f) => f.endsWith('.py'));
    const files = [];
    for (const n of names) files.push({ name: n, content: await readFile(path.join(dir, n), 'utf8') });
    return ok({ files });
  } catch { return fail('找不到这次回测的代码快照'); }
}

/* ---------------- 参数敏感性 ----------------
   用某个回测冻结的代码快照，把每个 self.get_parameter 参数分别 ×0.8、×1.2 各重跑一次（只改这一个参数）。
   结果只放在 backtests/<id>/sensitivity/ 里：不是回测记录，不进回测列表、不能标主版本、不能模拟实盘，
   也不计入尝试次数（trials.jsonl）。验证期的回测不允许做，否则等于对验证期多看几次。 */
const sensDir = (projectId, backtestId) => path.join(bdir(projectId, backtestId), 'sensitivity');
const sensFile = (projectId, backtestId) => path.join(sensDir(projectId, backtestId), 'sensitivity.json');
const SENS_STALE_MS = 25 * 60 * 1000;
const sensRunning = new Set();

// 和回测结果同一套读法（见 runBacktestJob）
function resultMetrics(result) {
  const s = (result && result.statistics) || {};
  return { annualReturn: s['Compounding Annual Return'] ?? null, sharpe: parseNum(s['Sharpe Ratio']), maxDrawdown: s.Drawdown ?? null, orders: parseNum(s['Total Orders']) };
}

// 验证期的判断：回测标了 holdout，或验证期记录（holdout_log.json）里有它
async function isHoldoutRun(projectId, backtestId, meta) {
  if (meta && meta.period === 'holdout') return true;
  const log = await readJson(path.join(pdir(projectId), 'holdout_log.json'), []);
  return Array.isArray(log) && log.some((x) => x.backtestId === cleanBid(backtestId));
}

// 错误信息里的绝对路径（ENOENT 之类）换成相对写法，网页和 MCP 不该看到用户的目录
const scrubPaths = (s) => String(s).split(ROOT).join('.').split(os.homedir()).join('~');
async function sensMarkError(projectId, backtestId, msg, jobId) {
  const f = sensFile(projectId, backtestId);
  const j = await readJson(f);
  if (j && j.status === 'running' && (!jobId || j.jobId === jobId)) { j.status = 'error'; j.error = scrubPaths(msg); j.phase = null; j.completed = now(); await writeJson(f, j); }
}

async function sensStatus(projectId, backtestId) {
  const f = sensFile(projectId, backtestId);
  const j = await readJson(f);
  if (j && j.status === 'running') {
    try {
      if (Date.now() - (await stat(f)).mtimeMs > SENS_STALE_MS) { j.status = 'error'; j.error = '参数敏感性的进程中断了（超过 25 分钟没有更新），请重新运行。'; }  // 只在返回值里标成中断，不写文件：读取没有副作用，下一次 runSensitivity 才会替换掉它
    } catch { /* ignore */ }
  }
  return j;
}

async function sensInputs(projectId, backtestId) {
  const bid = cleanBid(backtestId);
  const meta = await loadMeta(projectId, bid);
  if (!meta) return { error: '回测不存在' };
  const bc = await backtestCode({ projectId, backtestId: bid });
  const entry = meta.file && SAFE_FILE.test(meta.file) ? meta.file : 'main.py';
  const f = bc.success && bc.files.find((x) => x.name === entry);
  const found = f ? discoverParams(f.content) : { params: [], skipped: [] };
  // 默认值为 0 的参数没法按比例微调：移到“不能自动微调”
  for (const p of found.params.filter((x) => !sensitivityPlan([x]).length)) found.skipped.push({ name: p.name, reason: '默认值为 0，没法按比例微调' });
  found.params = found.params.filter((x) => sensitivityPlan([x]).length);
  return { bid, meta, entry, code: f ? f.content : '', files: bc.success ? bc.files : [], ...found, holdout: await isHoldoutRun(projectId, bid, meta) };
}

// 给网页和 MCP：能不能做、有哪些参数、已有的结果
export async function sensitivityRead({ projectId, backtestId }) {
  const I = await sensInputs(projectId, backtestId);
  if (I.error) return fail(I.error);
  const sensitivity = await sensStatus(projectId, I.bid);
  let canRun = true; let reason = null;
  if (I.holdout) { canRun = false; reason = '这是验证期回测。验证期只能当最后的检验，对它重跑变体就是多看几次，所以不提供参数敏感性。请对开发期的回测做。'; }
  else if (!/Completed/.test(I.meta.status || '')) { canRun = false; reason = '回测还没有跑完。'; }
  else if (!I.params.length) { canRun = false; reason = I.skipped.length ? '代码里的参数默认值都不是数字常量，没法自动微调。' : '这版代码没有用 self.get_parameter 声明可微调的参数。'; }
  else if (I.params.length > SENS_MAX_PARAMS) { canRun = false; reason = `声明了 ${I.params.length} 个参数，超过上限 ${SENS_MAX_PARAMS} 个。参数太多重跑次数会失控，请精简到关键的几个。`; }
  else if (sensitivity && sensitivity.status === 'running') { canRun = false; reason = '参数敏感性正在运行。'; }
  return ok({ holdout: I.holdout, canRun, reason, params: I.params, skipped: I.skipped, plan: sensitivityPlan(I.params), maxParams: SENS_MAX_PARAMS, sensitivity: sensitivity || null });
}

export async function runSensitivity({ projectId, backtestId }) {
  const I = await sensInputs(projectId, backtestId);
  if (I.error) return fail(I.error);
  const key = `${Number(projectId)}/${I.bid}`;
  if (I.holdout) return fail('这是验证期回测，不能做参数敏感性：对验证期重跑变体，等于多看几次验证期。请对开发期的回测做。');
  if (!/Completed/.test(I.meta.status || '')) return fail('回测还没有跑完（或运行失败），不能做参数敏感性。');
  if (!I.params.length) return fail(I.skipped.length ? '代码里的参数默认值都不是数字常量，没法自动微调。' : '这版代码没有用 self.get_parameter("名字", 默认值) 声明参数，没有可微调的东西。');
  if (I.params.length > SENS_MAX_PARAMS) return fail(`声明了 ${I.params.length} 个参数，超过上限 ${SENS_MAX_PARAMS} 个。参数太多重跑次数会失控，请精简到关键的几个再做。`);
  const plan = sensitivityPlan(I.params);
  if (!plan.length) return fail('没有可以微调的值（默认值为 0 的参数没法按比例微调）。');
  // 先占位再读状态：两个请求同时进来时，后到的要么看到内存里的占位，要么看到文件里的 running，不会各起一个进程
  if (sensRunning.has(key)) return fail('这个回测的参数敏感性正在运行，等它跑完。');
  sensRunning.add(key);
  try {
    const prev = await sensStatus(projectId, I.bid);
    if (prev && prev.status === 'running') return fail('这个回测的参数敏感性正在运行，等它跑完。');
    await mkdir(sensDir(projectId, I.bid), { recursive: true });
    const jobId = crypto.randomBytes(8).toString('hex');
    const s = { version: 1, jobId, projectId: Number(projectId), backtestId: I.bid, status: 'running', progress: 0, phase: '排队', started: now(), completed: null, error: null, total: plan.length, done: 0, variantsRun: 0, warning: SENS_WARNING, params: I.params, skipped: I.skipped, plan, base: null, variants: [], rows: [], conclusion: null };
    await writeJson(sensFile(projectId, I.bid), s);
    _hooks.startSensitivity(Number(projectId), I.bid, jobId);
    return ok({ sensitivity: s, message: `已开始：共 ${plan.length} 次重跑` });
  } catch (e) {
    return fail(`启动失败：${e.message}`);
  } finally {
    // 防重复点击只需要覆盖“写文件 → 文件里 status=running”这段；之后由文件本身表示运行中
    sensRunning.delete(key);
  }
}

export async function runSensitivityJob(projectId, backtestId, jobId) {
  const bid = cleanBid(backtestId);
  const f = sensFile(projectId, bid);
  const s = await readJson(f);
  if (!s || s.status !== 'running') return;
  // 只有文件里的任务编号还是自己的才允许写：被新一轮运行替换后，旧进程安静退出，不覆盖新结果
  const myId = jobId || s.jobId;
  const STALE = Symbol('stale');
  const isMine = async () => { const cur = await readJson(f); return !!cur && cur.jobId === myId; };
  if (!(await isMine())) return;
  const save = async (patch) => { if (!(await isMine())) throw STALE; Object.assign(s, patch); return writeJson(f, s); };
  try {
    const I = await sensInputs(projectId, bid);
    if (I.error) throw new Error(I.error);
    const dir = bdir(projectId, bid);
    const cls = findAlgorithmClass(I.code);
    if (!cls) throw new Error('代码快照里找不到继承 QCAlgorithm 的类');
    // 和普通回测同一道静态检查（危险导入 / 调用等）：变体虽然用的是已有快照，但快照文件可能在回测之后被改过
    const lint = await lintSources(I.files.filter((x) => x.name.endsWith('.py')), { entries: [I.entry] });
    if (lint.errors.length) throw new Error(`代码检查没通过：${lint.errors.slice(0, 3).map((e) => `${e.file}:${e.line} ${e.msg_zh}`).join('；')}`);
    // 变体要和原回测用同一份数据比：不更新数据，只检查本地有没有；数据变了就在结果里提示
    const missing = tickersInCode(I.code).filter((t) => !_hooks.hasLocalData(t));
    if (missing.length) throw new Error(`本地缺少行情数据：${missing.join('、')}`);
    try {
      const fp = await backtestDataFingerprint(I.code);
      const was = I.meta.fingerprint && I.meta.fingerprint.data;
      if (was) s.dataChanged = JSON.stringify(fp) !== JSON.stringify(was);
    } catch { s.dataChanged = null; }
    const baseRes = await loadResult(projectId, bid);
    s.base = baseRes ? resultMetrics(baseRes) : { annualReturn: I.meta.summary && I.meta.summary.compoundingAnnualReturn, sharpe: I.meta.summary && I.meta.summary.sharpeRatio, maxDrawdown: I.meta.summary && I.meta.summary.drawdown, orders: I.meta.summary && I.meta.summary.trades };
    const plan = s.plan || sensitivityPlan(I.params);
    for (let i = 0; i < plan.length; i++) {
      const v = plan[i];
      if (!(await isMine())) return;
      await save({ phase: `重跑 ${i + 1}/${plan.length}：${v.name} = ${v.value}`, progress: i / plan.length });
      const out = path.join(sensDir(projectId, bid), v.id);
      const rec = { id: v.id, name: v.name, which: v.which, value: v.value, factor: v.factor, status: 'error', error: null };
      try {
        const lr = await _hooks.runLean({
          algorithmFile: path.join(dir, 'code', I.entry), className: cls, outDir: path.join(out, 'out'), id: v.id, name: `敏感性 ${v.name}=${v.value}`,
          parameters: { [v.name]: String(v.value) },
          onProgress: (p) => save({ progress: (i + p) / plan.length }).catch(() => {}),
        });
        const st = (lr.result && lr.result.state) || {};
        if (!lr.result) rec.error = lr.error || 'LEAN 没有生成结果';
        else if (st.Status === 'RuntimeError' || st.RuntimeError) rec.error = st.RuntimeError || '运行时错误';
        else { Object.assign(rec, resultMetrics(lr.result), { status: 'ok' }); }
      } catch (e) { rec.error = scrubPaths(e.message || e).slice(0, 300); }
      s.variants.push(rec);
      await save({ done: i + 1, variantsRun: s.variants.length, progress: (i + 1) / plan.length });
    }
    const rows = I.params.map((p) => {
      const mine = s.variants.filter((x) => x.name === p.name);
      const lo = mine.find((x) => x.which === 'lo') || null; const hi = mine.find((x) => x.which === 'hi') || null;
      const vd = sensitivityVerdict(s.base.sharpe, mine.map((x) => ({ sharpe: x.status === 'ok' ? x.sharpe : null })));
      return { name: p.name, default: p.default, isInt: p.isInt, lo, hi, verdict: vd.verdict, reason: vd.reason };
    });
    await save({ status: 'done', phase: null, progress: 1, completed: now(), rows, conclusion: sensitivityConclusion(rows) });
  } catch (e) {
    if (e === STALE) return;
    await save({ status: 'error', phase: null, completed: now(), error: `引擎出错：${scrubPaths(e.message)}` }).catch(() => {});
  }
}

/* ---------------- 调参（超参数搜索，LEAN 策略） ----------------
   对一个已完成的开发期回测：用它冻结的代码快照，在 self.get_parameter 参数的范围里做拉丁超立方随机搜索，
   每组参数在同一段开发期上跑一次 LEAN。原参数直接用原回测的结果（不重跑）。
   选参挑参数平台（附近也好），用 CSCV 估计 PBO，结论按 lib/tune.mjs 的固定规则给出。
   每个候选都记进 trials.jsonl（source = 'tune'），去膨胀夏普的门槛随之抬高；候选本身不是回测记录，
   不进回测列表、不能标 main、不能模拟实盘。验证期的回测不允许调参。 */
const tuneDir = (projectId, backtestId) => path.join(bdir(projectId, backtestId), 'tuning');
const tuneFile = (projectId, backtestId) => path.join(tuneDir(projectId, backtestId), 'tuning.json');
const TUNE_STALE_MS = 25 * 60 * 1000;
const tuneRunning = new Set();

async function tuneMarkError(projectId, backtestId, msg, jobId) {
  const f = tuneFile(projectId, backtestId);
  const j = await readJson(f);
  if (j && j.status === 'running' && (!jobId || j.jobId === jobId)) { j.status = 'error'; j.error = scrubPaths(msg); j.phase = null; j.completed = now(); await writeJson(f, j); }
}
async function tuneStatus(projectId, backtestId) {
  const f = tuneFile(projectId, backtestId);
  const j = await readJson(f);
  if (j && j.status === 'running') {
    try { if (Date.now() - (await stat(f)).mtimeMs > TUNE_STALE_MS) { j.status = 'error'; j.error = '调参进程中断了（超过 25 分钟没有更新），请重新运行。'; } } catch { /* ignore */ }
  }
  return j;
}
// 能不能调：只看开发期、已完成、有可调参数
function tuneBlocker(I) {
  if (I.holdout) return '这是验证期回测，不能调参：在验证期上挑参数就是偷看答案。请对开发期的回测调。';
  if (I.meta.period !== 'dev') return `这个回测的时间段标的是「${I.meta.period || '未标记'}」。调参只能在开发期回测上做（period = dev），全期回测含验证期，也不行。`;
  if (!/Completed/.test(I.meta.status || '')) return '回测还没有跑完（或运行失败），不能调参。';
  if (!I.params.length) return I.skipped.length ? '代码里的参数默认值都不是数字常量，没法搜索。' : '这版代码没有用 self.get_parameter("名字", 默认值) 声明参数，没有可调的东西。';
  if (I.params.length > SENS_MAX_PARAMS) return `声明了 ${I.params.length} 个参数，超过上限 ${SENS_MAX_PARAMS} 个。参数越多越容易调出噪音，请先精简到关键的几个。`;
  return null;
}

export async function tuneRead({ projectId, backtestId }) {
  const I = await sensInputs(projectId, backtestId);
  if (I.error) return fail(I.error);
  const tuning = await tuneStatus(projectId, I.bid);
  const reason = tuneBlocker(I) || (tuning && tuning.status === 'running' ? '调参正在运行。' : null);
  return ok({ canRun: !reason, reason, params: I.params, skipped: I.skipped, rules: TUNE_RULES, budget: { default: TUNE_DEFAULT_BUDGET, min: TUNE_MIN_BUDGET, max: TUNE_MAX_BUDGET }, tuning: tuning || null });
}

export async function runTune({ projectId, backtestId, budget = TUNE_DEFAULT_BUDGET, ranges = {} }) {
  const I = await sensInputs(projectId, backtestId);
  if (I.error) return fail(I.error);
  const why = tuneBlocker(I);
  if (why) return fail(why);
  const n = Number(budget);
  if (!Number.isInteger(n) || n < TUNE_MIN_BUDGET || n > TUNE_MAX_BUDGET) return fail(`budget（候选个数）要在 ${TUNE_MIN_BUDGET}–${TUNE_MAX_BUDGET} 之间`);
  const R = buildRanges(I.params, ranges || {});
  if (R.errors.length) return fail(`搜索范围有误：${R.errors.join('；')}`);
  if (!R.ranges.length) return fail('没有可以搜索的参数。');
  const key = `${Number(projectId)}/${I.bid}`;
  if (tuneRunning.has(key)) return fail('这个回测正在调参，等它跑完。');
  tuneRunning.add(key);
  try {
    const prev = await tuneStatus(projectId, I.bid);
    if (prev && prev.status === 'running') return fail('这个回测正在调参，等它跑完。');
    await mkdir(tuneDir(projectId, I.bid), { recursive: true });
    const jobId = _hooks.newTuneJobId();
    const configs = sampleConfigs(R.ranges, n, seedOf(jobId));
    const t = { version: 1, jobId, projectId: Number(projectId), backtestId: I.bid, status: 'running', progress: 0, phase: '排队', started: now(), completed: null, error: null,
      method: 'Latin-hypercube random search (Bergstra & Bengio 2012) → parameter-plateau pick → CSCV probability of backtest overfitting (Bailey et al. 2017)',
      rules: TUNE_RULES, ranges: R.ranges, configs, total: configs.length - 1, done: 0, candidates: [], trialsAdded: 0, result: null };
    await writeJson(tuneFile(projectId, I.bid), t);
    _hooks.startTune(Number(projectId), I.bid, jobId);
    return ok({ tuning: t, message: `已开始：${configs.length} 组参数（原参数用原回测，另外 ${configs.length - 1} 次重跑），每一次都计入尝试次数` });
  } catch (e) {
    return fail(`启动失败：${e.message}`);
  } finally {
    tuneRunning.delete(key);
  }
}

// 从 LEAN 结果取日收益（按日期）：CSCV 要所有候选在同样的日期上比
function dailyReturns(result) {
  const P = prepareSeries(result);
  return { days: P.rDay, r: P.r };
}

export async function runTuneJob(projectId, backtestId, jobId) {
  const bid = cleanBid(backtestId);
  const f = tuneFile(projectId, bid);
  const t = await readJson(f);
  if (!t || t.status !== 'running') return;
  const myId = jobId || t.jobId;
  const STALE = Symbol('stale');
  const isMine = async () => { const cur = await readJson(f); return !!cur && cur.jobId === myId; };
  if (!(await isMine())) return;
  const save = async (patch) => { if (!(await isMine())) throw STALE; Object.assign(t, patch); return writeJson(f, t); };
  try {
    const I = await sensInputs(projectId, bid);
    if (I.error) throw new Error(I.error);
    const block = tuneBlocker(I);
    if (block) throw new Error(block);
    const dir = bdir(projectId, bid);
    const cls = findAlgorithmClass(I.code);
    if (!cls) throw new Error('代码快照里找不到继承 QCAlgorithm 的类');
    const lint = await lintSources(I.files.filter((x) => x.name.endsWith('.py')), { entries: [I.entry] });
    if (lint.errors.length) throw new Error(`代码检查没通过：${lint.errors.slice(0, 3).map((e) => `${e.file}:${e.line} ${e.msg_zh}`).join('；')}`);
    const missing = tickersInCode(I.code).filter((x) => !_hooks.hasLocalData(x));
    if (missing.length) throw new Error(`本地缺少行情数据：${missing.join('、')}`);
    const baseRes = await loadResult(projectId, bid);
    if (!baseRes) throw new Error('原回测没有结果文件');
    const series = new Map(); // id -> { days, r }
    const cands = [];
    const base = { id: 'c0', values: t.configs[0].values, isDefault: true, status: 'ok', ...resultMetrics(baseRes) };
    series.set('c0', dailyReturns(baseRes));
    cands.push(base);
    const window = resultWindow(baseRes);
    let added = 0;
    for (let i = 1; i < t.configs.length; i++) {
      const c = t.configs[i];
      if (!(await isMine())) return;
      await save({ phase: `候选 ${i}/${t.configs.length - 1}：${Object.entries(c.values).map(([k, v]) => `${k}=${v}`).join(', ')}`, progress: (i - 1) / (t.configs.length - 1) });
      const out = path.join(tuneDir(projectId, bid), c.id);
      const rec = { id: c.id, values: c.values, isDefault: false, status: 'error', error: null };
      try {
        const lr = await _hooks.runLean({
          algorithmFile: path.join(dir, 'code', I.entry), className: cls, outDir: path.join(out, 'out'), id: `${bid}-${c.id}`, name: `调参 ${c.id}`,
          parameters: Object.fromEntries(Object.entries(c.values).map(([k, v]) => [k, String(v)])),
          onProgress: (p) => save({ progress: (i - 1 + p) / (t.configs.length - 1) }).catch(() => {}),
        });
        const st = (lr.result && lr.result.state) || {};
        if (!lr.result) rec.error = lr.error || 'LEAN 没有生成结果';
        else if (st.Status === 'RuntimeError' || st.RuntimeError) rec.error = st.RuntimeError || '运行时错误';
        else {
          Object.assign(rec, resultMetrics(lr.result), { status: 'ok' });
          series.set(c.id, dailyReturns(lr.result));
          // 每个跑成功的候选都是一次尝试：记进 trials.jsonl，去膨胀夏普的门槛随之抬高
          if (Number.isFinite(rec.sharpe)) {
            await mkdir(path.dirname(TRIALS_FILE), { recursive: true });
            await appendLine(TRIALS_FILE, JSON.stringify({ backtestId: `tune-${bid}-${myId}-${c.id}`, projectId: Number(projectId), period: 'dev', window, sharpe: rec.sharpe, ...(Number.isFinite(dailySharpe(lr.result)) ? { sharpeDaily: dailySharpe(lr.result) } : {}), at: now(), source: 'tune', of: bid }));
            added++;
          }
        }
      } catch (e) { rec.error = scrubPaths(e.message || e).slice(0, 300); }
      // 只留日收益和指标：LEAN 的整套输出很大，删掉
      await rm(out, { recursive: true, force: true }).catch(() => {});
      cands.push(rec);
      await save({ done: i, candidates: cands, trialsAdded: added, progress: i / (t.configs.length - 1) });
    }
    // 对齐日期（所有成功候选共有的交易日），算平台和 PBO
    const okIds = cands.filter((c) => c.status === 'ok' && series.has(c.id)).map((c) => c.id);
    const common = okIds.reduce((acc, id) => { const set = new Set(series.get(id).days); return acc ? acc.filter((d) => set.has(d)) : series.get(id).days.slice(); }, null) || [];
    const mat = okIds.map((id) => { const s = series.get(id); const m = new Map(s.days.map((d, k) => [d, s.r[k]])); return common.map((d) => m.get(d)); });
    const S = cscvBlocks(common.length);
    const pbo = S && okIds.length >= 4 ? cscvPbo(mat, S) : null;
    const okCands = cands.filter((c) => c.status === 'ok' && Number.isFinite(c.sharpe));
    const plateau = plateauScores(t.ranges, okCands);
    const best = recommendFromPlateau(t.ranges, okCands, plateau); // 最好的平台里离组中心最近的候选（不是平台分数最高的点本身）
    const def = plateau.find((x) => x.id === 'c0') || null;
    const rawBest = cands.filter((c) => c.status === 'ok' && Number.isFinite(c.sharpe)).sort((a, b) => b.sharpe - a.sharpe)[0] || null;
    const verdict = tuneVerdict({ pbo: pbo ? pbo.pbo : null, defaultSmooth: def ? def.smooth : null, bestSmooth: best ? best.smooth : null, recommendedIsDefault: best ? best.id === 'c0' : true });
    const rec = best && cands.find((c) => c.id === best.id);
    const result = {
      recommended: rec ? { id: rec.id, values: rec.values, sharpe: rec.sharpe, smooth: best.smooth, neighbors: best.neighbors, group: best.group } : null,
      default: { values: base.values, sharpe: base.sharpe, smooth: def ? def.smooth : null },
      rawBest: rawBest ? { id: rawBest.id, values: rawBest.values, sharpe: rawBest.sharpe } : null,
      pbo, days: common.length, candidatesOk: okIds.length, verdict,
      next: verdict.adopt
        ? '要采用：先改 spec.md 里这些参数的值和 get_parameter 的默认值（这是改规则），再作为新的候选回测跑开发期，用 validate_backtest 检验；通过后验证期只跑一次。'
        : '保持规则说明里的原参数，不要改代码。',
    };
    await save({ status: 'done', phase: null, progress: 1, completed: now(), result });
  } catch (e) {
    if (e === STALE) return;
    await save({ status: 'error', phase: null, completed: now(), error: `引擎出错：${scrubPaths(e.message)}` }).catch(() => {});
  }
}

/* ---------------- dispatcher for the website (read-only) ---------------- */

export const READ_ENDPOINTS = {
  'projects/read': projectsRead,
  'files/read': filesRead,
  'backtests/list': backtestsList,
  'backtests/read': backtestsRead,
  'backtests/chart/read': chartRead,
  'backtests/orders/read': ordersRead,
  'backtests/log/read': logRead,
  'backtests/code/read': backtestCode,
  'backtests/validate': validateBacktest,
};

// 让 LEAN 策略可以 `from helm_data import HelmUniverse, HelmSignals`
export function ensureHelmData(py) {
  if (!py) return;
  const link = path.join(py.sitePackages, 'helm_data.py');
  const target = path.join(ENGINE, 'helm_data.py');
  try {
    const st = lstatSync(link);
    // 仓库搬过位置时旧链接会指向不存在的文件：只有指向当前 engine/helm_data.py 才保留
    if (st.isSymbolicLink() && readlinkSync(link) === target) return;
    unlinkSync(link);
  } catch { /* missing */ }
  try { symlinkSync(target, link); } catch { /* read-only venv: strategies can't import helm_data */ }
}
