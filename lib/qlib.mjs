// Qlib 研究能力：调用项目里的 qlib 研究引擎（engine/qlib_research，原 quant-strategy 引擎），
// Helm 只负责启动、记录、读结果和把数据/信号转成 LEAN 格式。所有研究数字都来自引擎的输出文件。
import { spawn, execFile } from 'node:child_process';
import { existsSync, openSync, closeSync, readFileSync, statSync, appendFileSync, accessSync, constants as FS } from 'node:fs';
import { readFile, writeFile, mkdir, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { ROOT, ENGINE, DATA_DIR, PROJECTS_DIR } from './engine.mjs';
import { sandboxArgs, scrubEnv } from './exec-sandbox.mjs';
import { writeJsonAtomic } from './fs-atomic.mjs';
import { expectedTradingDate } from './paper.mjs';

const HOME = os.homedir();
const PIT_FILES = { sp500: path.join(HOME, '.qlib', 'qs_cache', 'membership', 'sp500_pit.txt') };
// 和研究引擎的 ALIASES 一致：这些写法都指 S&P 500
const PIT_KEY = { sp500: 'sp500', spy: 'sp500', spx: 'sp500', 's&p500': 'sp500' };
export const QS_DIR = process.env.QS_SCRIPTS || path.join(ENGINE, 'qlib_research');
const RUN_SH = path.join(QS_DIR, 'run.sh');
const BRIDGE = path.join(ENGINE, 'qlib_bridge.py');
const QDATA = path.join(ROOT, 'data', 'qlib');
const EXPORTS = path.join(QDATA, 'exports');
// 研究引擎（engine/qlib_research，agent 可以直接改）和桥接脚本（会 import 它）都在研究沙盒里跑：
// 读不到密钥、连不上 Helm、只能写研究结果目录和缓存（见 lib/exec-sandbox.mjs）。环境变量去掉密钥。
const SB = { projectsDir: PROJECTS_DIR, leanDataDir: DATA_DIR };
const boxed = (cmd, args) => sandboxArgs('research', cmd, args, SB);
// 股票池导出要往 LEAN 的日线目录写价格：单独一套规则（见 exec-sandbox.mjs 的 'export'）
const boxedExport = (cmd, args) => sandboxArgs('export', cmd, args, SB);

const ok = (extra = {}) => ({ success: true, errors: [], ...extra });
const fail = (msg) => ({ success: false, errors: [msg] });
const now = () => new Date().toISOString();
const readJson = async (f, dflt = null) => { try { return JSON.parse(await readFile(f, 'utf8')); } catch { return dflt; } };
async function writeJson(f, data) {
  await mkdir(path.dirname(f), { recursive: true });
  await writeJsonAtomic(f, data); // 先 fsync 再 rename（lib/fs-atomic.mjs）
}
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

export const PHASES = ['env', 'universe', 'data', 'design', 'features', 'factors', 'model', 'robustness', 'advanced', 'portfolio', 'overlay', 'holdout', 'report'];
export const PHASE_ZH = {
  env: '环境', universe: '股票池', data: '价格数据', design: '冻结实验设计', features: '计算因子', factors: '因子筛选',
  model: '模型训练', robustness: '稳健性检验', advanced: '进阶模型', portfolio: '组合构建', overlay: '风险叠加', holdout: '验证期检验', report: '报告',
  idea: '想法检验',
};
// 想法检验只跑到实验设计，然后直接检验用户的因子（只用开发期，不碰验证期）
export const IDEA_PHASES = ['env', 'universe', 'data', 'design', 'idea'];
export const UNIVERSE_KEYS = ['sp500', 'nasdaq100', 'dia', 'sox', 'spy100', 'iwm80'];

/* ---------------- python ---------------- */

let qpy = null;
// 研究专用环境（推荐）：engine/.qlib-venv（uv venv --python 3.11 engine/.qlib-venv && uv pip install … pyqlib lightgbm …）
export const QLIB_VENV_PY = path.join(ENGINE, '.qlib-venv', 'bin', 'python');
// 想法检验、股票池导出、导出信号不需要 qlib（公式在 qs_expr 里算）：用 Helm 自己的 engine/.venv（和 LEAN 同一个环境）。
// 只有完整因子研究（LightGBM、qlib 回测）才要下面那个装了 qlib 的 Python。
export const ENGINE_VENV_PY = path.join(ENGINE, '.venv', 'bin', 'python');
export async function enginePython() {
  if (process.env.QS_PYTHON) return process.env.QS_PYTHON;
  if (existsSync(ENGINE_VENV_PY)) return ENGINE_VENV_PY;
  return qlibPython(); // 没有 engine/.venv 时，装了 qlib 的 Python 也能跑这些
}
export const QLIB_NEEDED = '完整因子研究需要 qlib（LightGBM / qlib 回测引擎），这台机器上没找到装了 qlib 的 Python。想法检验、股票池和导出信号不需要 qlib。安装方法见 engine/qlib_research/run.sh 开头的说明';

export async function qlibPython() {
  if (qpy) return qpy;
  if (process.env.QS_PYTHON) return (qpy = process.env.QS_PYTHON);
  // 有专用环境时直接用它（run.sh 也是同样的顺序），不去用系统里碰巧装了 qlib 的 Python
  if (existsSync(QLIB_VENV_PY)) return (qpy = QLIB_VENV_PY);
  try {
    const c = readFileSync(path.join(HOME, '.cache', 'quant-strategy', 'python'), 'utf8').trim();
    if (c && existsSync(c)) return (qpy = c);
  } catch { /* fall through */ }
  qpy = await new Promise((resolve) => execFile(...boxed(RUN_SH, ['--which-python']), { timeout: 60000, env: scrubEnv() }, (err, out) => resolve(err ? null : String(out).trim())));
  return qpy;
}

// qlib 的美股日线数据（研究引擎和 engine/qlib_bridge.py 都读这里）
export const QLIB_DATA_DIR = path.join(HOME, '.qlib', 'qlib_data', 'us_data');
export async function qlibStatus() {
  // ok：想法检验 / 股票池能不能用（不需要 qlib）；qlib：完整因子研究能不能用
  const [py, qpy] = await Promise.all([enginePython(), qlibPython()]);
  return { ok: Boolean(py) && existsSync(RUN_SH), python: py, qlib: Boolean(qpy), qlibPython: qpy, engine: QS_DIR, runSh: existsSync(RUN_SH), dataDir: QLIB_DATA_DIR, data: existsSync(QLIB_DATA_DIR), dataEnd: qlibDataEnd() };
}

// qlib 美股数据的最后一个交易日（calendars/day.txt 的最后一行）；按修改时间缓存。没有数据时 null
let calCache = null;
export function qlibDataEnd(dir = QLIB_DATA_DIR) {
  const f = path.join(dir, 'calendars', 'day.txt');
  try {
    const m = statSync(f).mtimeMs;
    if (calCache && calCache.f === f && calCache.m === m) return calCache.v;
    const last = readFileSync(f, 'utf8').trim().split('\n').pop().trim().slice(0, 10);
    calCache = { f, m, v: /^\d{4}-\d{2}-\d{2}$/.test(last) ? last : null };
    return calCache.v;
  } catch { return null; }
}

async function bridge(args, timeout = 120000) {
  const py = await enginePython();
  if (!py) return { error: '找不到研究用的 Python（engine/.venv）。在 helm 目录运行 npm run doctor 看怎么装' };
  return new Promise((resolve) => {
    execFile(...boxed(py, ['-I', BRIDGE, ...args]), { timeout, maxBuffer: 32 << 20, cwd: os.tmpdir(), env: scrubEnv() }, (err, stdout, stderr) => {
      const last = String(stdout).trim().split('\n').pop();
      try { resolve(JSON.parse(last)); } catch { resolve({ error: (String(stderr).trim().split('\n').slice(-6).join('\n') || (err && err.message) || '桥接脚本出错').slice(-1500) }); }
    });
  });
}

/* ---------------- 股票池（历史成分股 + LEAN 数据） ---------------- */

let uniCache = null;
export async function listUniverses({ fresh = false } = {}) {
  if (!fresh && uniCache && Date.now() - uniCache.at < 60000) return uniCache.value;
  const r = await bridge(['universes', '--data', DATA_DIR]);
  if (r.error) return fail(r.error);
  // 数据已经到最近一个完整交易日：网页显示「已是最新」，不再像是在催用户再点一次「更新」
  const latest = expectedTradingDate();
  for (const u of r.universes) {
    u.job = await universeJob(u.key);
    u.upToDate = Boolean(u.exported && u.exported.end && String(u.exported.end) >= latest);
    u.latestTradingDay = latest;
  }
  uniCache = { at: Date.now(), value: ok(r) };
  return uniCache.value;
}

export async function universeMembers({ index, date }) {
  if (!UNIVERSE_KEYS.includes(index)) return fail(`股票池只能是 ${UNIVERSE_KEYS.join(' / ')}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return fail('date 格式是 YYYY-MM-DD');
  const r = await bridge(['members', '--index', index, '--date', date], 300000);
  return r.error ? fail(r.error) : ok(r);
}

async function universeJob(key) {
  const st = await readJson(path.join(EXPORTS, `${key}.json`));
  if (st && st.status === 'running' && !alive(st.pid)) { st.status = 'failed'; st.error = st.error || '导出进程中断了，请重新准备'; }
  return st;
}

export async function prepareUniverse({ index, start = '2008-01-01' }) {
  if (!UNIVERSE_KEYS.includes(index)) return fail(`股票池只能是 ${UNIVERSE_KEYS.join(' / ')}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return fail('start 格式是 YYYY-MM-DD');
  const cur = await universeJob(index);
  if (cur && cur.status === 'running') return ok({ job: cur, already: true });
  const py = await enginePython();
  if (!py) return fail('找不到研究用的 Python（engine/.venv）。在 helm 目录运行 npm run doctor 看怎么装');
  await mkdir(EXPORTS, { recursive: true });
  const status = path.join(EXPORTS, `${index}.json`);
  await writeJson(status, { index, status: 'running', phase: '启动', progress: 0.01, started: now(), start });
  const logFd = openSync(path.join(EXPORTS, `${index}.log`), 'a');
  const child = spawn(...boxedExport(py, ['-I', BRIDGE, 'export', '--index', index, '--data', DATA_DIR, '--workdir', QDATA, '--start', start, '--status', status]),
    { detached: true, stdio: ['ignore', logFd, logFd], cwd: os.tmpdir(), env: scrubEnv() });
  // 没有 error 监听时，启动失败（文件不存在 / 没有执行权限）会变成未捕获异常，把整个服务带崩
  child.on('error', () => {});
  child.unref();
  closeSync(logFd);
  if (!child.pid) {
    await writeJson(status, { index, status: 'failed', error: `导出进程启动失败：${py} 无法运行`, started: now(), start });
    uniCache = null;
    return fail(`导出进程启动失败：${py} 无法运行`);
  }
  const job = (await readJson(status)) || { index, status: 'running', started: now(), start };
  job.pid = child.pid;
  await writeJson(status, job);
  uniCache = null;
  return ok({ job });
}

export async function universeStatus({ index }) {
  if (!UNIVERSE_KEYS.includes(index)) return fail('未知股票池');
  const job = await universeJob(index);
  const summary = await readJson(path.join(DATA_DIR, 'helm', 'universes', `${index}.json`));
  return ok({ job, summary });
}

/* ---------------- 研究任务 ---------------- */

const rdir = (projectId) => path.join(PROJECTS_DIR, String(Number(projectId)), 'research');
const jobFile = (projectId, jobId) => path.join(rdir(projectId), 'jobs', `${jobId}.json`);
const JOB_ID = /^r[0-9a-z]{6,24}$/;

// 任务是不是真的还在跑：只看 pid 活着不够 —— 任务停了以后（尤其重启后）pid 可能被别的进程复用，
// 那样任务会永远显示「在跑」、不能续跑、还占着并发名额。所以要核对进程的启动时间（没记录时核对命令行）。
// ps 超时（拿不到信息但 pid 活着）时保守地当作还在跑，免得重复启动。
const isOurs = (job, info) => (job.pidStart ? info.start === job.pidStart : /qs_pipeline\.py|run\.sh/.test(info.command));
async function jobRunning(job) {
  if (!alive(job.pid) || job.stale) return false;
  const info = await procInfo(job.pid);
  if (!info) return alive(job.pid);
  return isOurs(job, info);
}

function phaseState(job, ps, running) {
  const want = job.mode === 'idea' ? IDEA_PHASES : job.mode === 'factors' ? PHASES.slice(0, PHASES.indexOf('factors') + 1) : PHASES;
  const phases = want.map((p) => ({ id: p, zh: PHASE_ZH[p], status: (ps && ps[p] && ps[p].status) || 'pending', seconds: ps && ps[p] && ps[p].seconds, error: ps && ps[p] && ps[p].error }));
  const done = phases.filter((p) => p.status === 'complete' || p.status === 'skipped').length;
  const failed = phases.find((p) => p.status === 'failed');
  let status = 'stopped';
  if (failed && !running) status = 'failed';
  else if (done === phases.length) status = 'complete';
  else if (running) status = 'running';
  const cur = phases.find((p) => p.status === 'running');
  return { phases, status, progress: done / phases.length, current: running && cur ? cur.zh : null, error: failed ? failed.error : null };
}

async function jobView(job, { deep = false } = {}) {
  const run = job.runDir;
  const ps = await readJson(path.join(run, 'phase_status.json'));
  const st = phaseState(job, ps, await jobRunning(job));
  const ho = await readJson(path.join(run, 'holdout_results.json'));
  const fa = await readJson(path.join(run, 'factors.json'));
  const view = {
    ...job, args: undefined, pid: undefined, pidStart: undefined, ...st,
    // qlib 数据截止到哪天：研究结论只覆盖到这一天
    qlibDataEnd: qlibDataEnd(),
    verdict: ho ? ho.verdict : null,
    holdoutStatus: ho ? ho.holdout_status : null,
    topFactors: fa && fa.top_factors ? fa.top_factors.slice(0, deep ? 15 : 3) : null,
    horizon: fa ? fa.horizon : null,
    hasSignals: existsSync(path.join(run, 'results', 'pred_dev.pkl')),
  };
  if (job.mode === 'idea') {
    const res = await readJson(path.join(run, 'idea.json'));
    view.idea = job.idea;
    view.ideaResult = res ? (deep ? res : {
      summary_zh: res.summary_zh, trials: res.trials,
      factors: (res.factors || []).map((f) => ({ name: f.name, label: f.label, verdict: f.verdict, verdict_zh: f.verdict_zh, best_horizon: f.best_horizon, ic: f.ic && f.best_horizon != null ? f.ic[String(f.best_horizon)] : null, long_short_net_annual: f.quantiles && f.quantiles.long_short_net_annual })),
    }) : null;
    const order = { signal: 2, weak: 1, none: 0 };
    const best = res && (res.factors || []).slice().sort((a, b) => (order[b.verdict] ?? -1) - (order[a.verdict] ?? -1))[0];
    view.verdict = best ? best.verdict_zh : null;
    view.hasSignals = Boolean(res && (res.factors || []).length);
  }
  if (!deep) return view;
  const uni = await readJson(path.join(run, 'universe.json'));
  const audit = await readJson(path.join(run, 'data_audit.json'));
  const model = await readJson(path.join(run, 'model.json'));
  const rob = await readJson(path.join(run, 'robustness.json'));
  const pf = await readJson(path.join(run, 'portfolio.json'));
  const sp = await readJson(path.join(run, 'splits.json'));
  view.universe = uni && { kind: uni.membership_kind, n: uni.n, source: uni.source, asOf: uni.as_of, note: uni.survivorship_note, benchmark: uni.benchmark_etf };
  view.data = audit && { coverage: audit.member_day_coverage, start: audit.calendar_start, end: audit.calendar_end, missing: (audit.missing || []).length, uncertain: (audit.uncertain_corrections || []).length };
  view.factorRule = fa && fa.rule;
  view.factorWindow = fa && fa.window;
  view.factorHorizons = fa && fa.counts_by_horizon ? Object.keys(fa.counts_by_horizon).length : null;
  view.weakFactorSignal = fa ? fa.weak_factor_signal : null;
  view.splits = sp && { holdout: [sp.holdout_start, sp.end], folds: (sp.folds || []).length, purge: sp.purge_days };
  view.model = model && { name: model.model, ic: model.walk_forward_ic || null, longShort: model.signal_analysis ? model.signal_analysis['Long-Short Ann Return'] : null,
    // 线性对照（ridge）：LightGBM 有没有比带 L2 惩罚的线性模型更好；只是诊断，不影响结论和尝试次数
    tuning: model.tuning || null,
    ridge: model.ridge_baseline && model.ridge_baseline.walk_forward_ic ? { ic: model.ridge_baseline.walk_forward_ic, lgbMinusRidge: model.ridge_baseline.lgb_minus_ridge, lgbBeatsRidge: model.ridge_baseline.lgb_beats_ridge } : null };
  view.robustness = rob && { permP: rob.perm_p, permZ: rob.perm_z, icT: rob.ic_t_nonoverlap, yearsPositive: rob.years_positive, yearsTotal: rob.years_total, verdict: rob.verdict };
  view.portfolio = pf && { chosen: pf.chosen, rebalanceDays: pf.rebalance_every_days, strategy: pf.strategy, baselines: pf.baselines, random: pf.random_sharpe, breakevenBps: pf.breakeven_cost_bps_vs_ew, note: pf.note };
  view.gates = ho ? { failed: ho.failed || [], passed: ho.passed || [], previous: ho.previous_examinations || [] } : null;
  view.holdout = ho ? { window: ho.window, strategy: ho.strategy, baselines: ho.baselines, ci: ho.sharpe_bootstrap_95ci, excessVsEw: ho.excess_vs_ew, random: ho.random_sharpe } : null;
  try { view.report = await readFile(path.join(run, job.mode === 'idea' ? 'idea_report.md' : 'report.md'), 'utf8'); } catch { view.report = null; }
  try { view.plots = (await readdir(path.join(run, 'plots'))).filter((f) => f.endsWith('.png')); } catch { view.plots = []; }
  try {
    const lines = (await readFile(job.log, 'utf8')).split('\n').filter((l) => /^\[\d\d:\d\d:\d\d\]/.test(l));
    view.logTail = lines.slice(-25);
  } catch { view.logTail = []; }
  return view;
}

function cleanTarget(t) {
  const s = String(t || '').trim();
  return /^[A-Za-z0-9&]{1,20}$/.test(s) ? s : null;
}

export async function startResearch({ projectId, title, target, tickers, benchmark, features = 'alpha158', neutralize = 'none', start = '2008-01-01', holdoutYears = 2, mode = 'full', advanced = 'off', costBps, tune = 0 }) {
  const pid = Number(projectId);
  if (!existsSync(path.join(PROJECTS_DIR, String(pid)))) return fail(`项目 ${projectId} 不存在`);
  if (!existsSync(RUN_SH)) return fail(`找不到 qlib 研究引擎：${RUN_SH}`);
  if (!(await qlibPython())) return fail(QLIB_NEEDED);
  const tgt = cleanTarget(target);
  if (!tgt) return fail('target 必须是指数/ETF 名，比如 sp500、QQQ、SOX、DIA，或 custom（配合 tickers）');
  let tick = null;
  if (tgt.toLowerCase() === 'custom') {
    const list = (Array.isArray(tickers) ? tickers : String(tickers || '').split(',')).map((x) => String(x).trim().toUpperCase()).filter((x) => /^[A-Z0-9.\-]{1,10}$/.test(x));
    if (list.length < 5) return fail('custom 股票池至少要 5 只股票（tickers）');
    tick = [...new Set(list)].join(',');
  }
  if (!['alpha158', 'fundamental', 'both'].includes(features)) return fail('features 只能是 alpha158 / fundamental / both');
  if (!['none', 'sector'].includes(neutralize)) return fail('neutralize 只能是 none / sector');
  if (!['full', 'factors'].includes(mode)) return fail('mode 只能是 full（完整研究）/ factors（只做因子扫描）');
  if (!['off', 'auto', 'tra'].includes(advanced)) return fail('advanced 只能是 off / auto / tra');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return fail('start 格式是 YYYY-MM-DD');
  const hy = Number(holdoutYears);
  if (!(hy >= 0.5 && hy <= 5)) return fail('holdoutYears 要在 0.5 到 5 之间');
  const tn = Number(tune || 0);
  if (!Number.isInteger(tn) || tn < 0 || tn > 30 || (tn > 0 && tn < 6)) return fail('tune（LightGBM 调参的候选个数）要么 0（不调），要么 6–30');
  if (tn > 0 && mode !== 'full') return fail('调参只在 mode=full 时有用（factors 模式不训练模型）');
  const existing = await listResearchRaw(pid);
  const runningNow = [];
  for (const j of existing) if (await jobRunning(j)) runningNow.push(j);
  if (runningNow.length >= 2) return fail('这个项目已经有 2 个研究在跑了，等它们跑完再开新的（qlib 很吃 CPU）');

  const d = new Date();
  const jobId = `r${d.toISOString().slice(0, 19).replace(/[-:T]/g, '').slice(2)}${crypto.randomBytes(4).toString('hex')}`; // 4 字节随机：同一秒启动两个任务也不会撞号（1 字节时 1/256）
  const name = tgt.toLowerCase() === 'custom' ? 'CUSTOM' : tgt.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const wd = rdir(pid);
  await mkdir(path.join(wd, 'jobs'), { recursive: true });
  const args = ['run', '--target', tgt, '--name', name, '--run-id', jobId, '--workdir', wd, '--start', start,
    '--holdout-years', String(hy), '--features', features, '--neutralize', neutralize, '--advanced', advanced];
  if (tick) args.push('--tickers', tick);
  // S&P 500：用补全到最近的历史成分股名单（qlib 2020 + Wikipedia 变更表），有就自动用
  const pit = PIT_FILES[PIT_KEY[tgt.toLowerCase()]];
  if (pit && existsSync(pit)) args.push('--membership-file', pit);
  if (benchmark !== undefined && benchmark !== null) args.push('--benchmark', String(benchmark).toUpperCase().replace(/[^A-Z0-9.\-]/g, ''));
  if (costBps != null && Number.isFinite(Number(costBps))) args.push('--cost-bps', String(Number(costBps)));
  if (tn > 0) args.push('--tune', String(tn));
  const job = {
    jobId, projectId: pid, title: String(title || '').slice(0, 120) || `${name} ${features === 'alpha158' ? '价量因子' : features === 'fundamental' ? '基本面因子' : '价量+基本面'}${mode === 'factors' ? ' · 因子扫描' : ' · 完整研究'}`,
    target: tgt, tickers: tick, benchmark: benchmark ?? null, features, neutralize, start, holdoutYears: hy, mode, advanced, tune: tn,
    args, runDir: path.join(wd, 'quant_runs', `${name}_${jobId}`), log: path.join(wd, `${jobId}.log`), created: now(),
  };
  job.pid = spawnRun(job);
  if (!job.pid) return fail(SPAWN_FAIL);
  job.pidStart = await procInfo(job.pid).then((i) => i && i.start);
  await writeJson(jobFile(pid, jobId), job);
  return ok({ job: await jobView(job) });
}

// 想法检验：把一句话的想法写成 1–5 个因子（Qlib 表达式或已有的基本面字段），在历史成分股上只用开发期检验
const FACTOR_NAME = /^[a-z][a-z0-9_]{0,29}$/;
// SEC 财报因子（engine/qlib_research/qs_fundamentals.py 的 FEATURES；时点正确，只用当时已公布的财报）
export const FUND_FIELDS = {
  F_EP: '盈利收益率（TTM 净利润 / 市值，市盈率倒数）', F_BM: '账面市值比', F_SP: '销售收益率（TTM 收入 / 市值）', F_CFP: '现金流收益率（TTM 经营现金流 / 市值）',
  F_SIZE: '规模（对数市值）', F_ROE: 'ROE', F_ROA: 'ROA', F_GPA: '毛利 / 总资产', F_OPA: '营业利润 / 总资产', F_ACC: '应计项目（越高盈利质量越差）',
  F_LEV: '杠杆（总负债 / 总资产）', F_REVG: '收入同比增长', F_NIG: '净利润同比变化 / 总资产', F_AG: '总资产增长', F_SUE: '盈利意外（标准化）',
};
// Qlib 解析表达式时最后会走 Python eval，所以只放行白名单里的运算符和价格字段
const QLIB_OPS = new Set(['Ref', 'Mean', 'Std', 'Var', 'Sum', 'Max', 'Min', 'Med', 'Mad', 'Skew', 'Kurt', 'Delta', 'Slope', 'Rsquare', 'Resi', 'Corr', 'Cov', 'Rank', 'Abs', 'Log', 'Sign', 'Power', 'If', 'Gt', 'Ge', 'Lt', 'Le', 'Eq', 'Ne', 'And', 'Or', 'Not', 'Greater', 'Less', 'Quantile', 'IdxMax', 'IdxMin', 'EMA', 'WMA', 'Count', 'Mask']);
const QLIB_FIELDS = new Set(['open', 'high', 'low', 'close', 'volume', 'vwap', 'factor', 'mkt']); // $mkt：股票池自己的等权市场收益（qs_idea.market_return）
export function checkExpr(expr) {
  const e = String(expr || '');
  if (!e.trim()) return '表达式为空';
  if (e.length > 300) return '表达式超过 300 个字符';
  if (e.includes('__')) return '不能包含双下划线';
  if (!/^[A-Za-z0-9_$().,+\-*/<>=!&| ]+$/.test(e)) return '含有不允许的字符（只能用字母、数字、$、括号、逗号、小数点和 + - * / < > = ! & |）';
  for (const m of e.matchAll(/\$?[A-Za-z_][A-Za-z0-9_]*|\d*\.\d+|\d+|\./g)) {
    const t = m[0];
    if (t === '.') return '小数点只能出现在数字里';
    if (/^[\d.]+$/.test(t)) continue;
    if (t.startsWith('$')) { if (!QLIB_FIELDS.has(t.slice(1))) return `没有字段 ${t}（可用：${[...QLIB_FIELDS].map((x) => `$${x}`).join(' ')}）`; continue; }
    if (!QLIB_OPS.has(t)) return `不认识 ${t}（只能用 Qlib 运算符，例如 Ref、Mean、Std、Rank、Corr、EMA）`;
  }
  const feats = [...e.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
  if (feats.length && feats.every((f) => f === 'mkt')) return '只用 $mkt 的公式对每只股票都一样，没法在股票之间比较；要和股票自己的字段（比如 $close）一起用';
  return null;
}
export function validateIdeaFactors(factors) {
  if (!Array.isArray(factors) || !factors.length) return '至少要有 1 个因子';
  if (factors.length > 5) return '一个想法最多 5 个因子（因子越多，多重检验的门槛越高）';
  const names = new Set();
  for (const f of factors) {
    if (!f || !FACTOR_NAME.test(String(f.name || ''))) return `因子名 ${f && f.name} 不合法：小写字母开头，只能用小写字母、数字、下划线，最多 30 个字符`;
    if (names.has(f.name)) return `因子名 ${f.name} 重复`;
    names.add(f.name);
    const comps = f.components;
    if (!Array.isArray(comps) || !comps.length || comps.length > 4) return `因子 ${f.name} 要有 1–4 个组成部分（components）`;
    for (const c of comps) {
      const w = c.weight == null ? 1 : Number(c.weight);
      if (!Number.isFinite(w) || w === 0 || Math.abs(w) > 10) return `因子 ${f.name} 的权重不合法：${c.weight}`;
      const hasE = typeof c.expr === 'string' && c.expr.trim(); const hasF = typeof c.fundamental === 'string' && c.fundamental.trim();
      if (Boolean(hasE) === Boolean(hasF)) return `因子 ${f.name} 的每个组成部分要么写 expr（Qlib 表达式），要么写 fundamental（基本面字段名），不能都写或都不写`;
      if (hasE) { const why = checkExpr(c.expr); if (why) return `因子 ${f.name} 的表达式不能用：${why}`; }
      if (hasF && !FUND_FIELDS[String(c.fundamental).toUpperCase()]) return `因子 ${f.name} 的基本面字段 ${c.fundamental} 不存在，可用：${Object.keys(FUND_FIELDS).join(' ')}`;
    }
  }
  return null;
}

export async function startIdea({ projectId, idea, factors, target = 'sp500', tickers, benchmark, horizons = [5, 20, 60], title, start = '2008-01-01', holdoutYears = 2, costBps }) {
  const pid = Number(projectId);
  if (!existsSync(path.join(PROJECTS_DIR, String(pid)))) return fail(`项目 ${projectId} 不存在`);
  if (!existsSync(RUN_SH)) return fail(`找不到 qlib 研究引擎：${RUN_SH}`);
  const sentence = String(idea || '').trim().slice(0, 500);
  if (!sentence) return fail('idea 要写上这次检验的想法（一句话）');
  const bad = validateIdeaFactors(factors);
  if (bad) return fail(bad);
  const hz = (Array.isArray(horizons) ? horizons : [horizons]).map(Number).filter((h) => Number.isInteger(h) && h >= 1 && h <= 120);
  // 上限和研究引擎 qs_idea.py 的 HORIZON_RANGE = (1, 120) 一致；超出的话引擎一启动就会退出
  if (!hz.length || hz.length > 4 || hz.length !== (Array.isArray(horizons) ? horizons : [horizons]).length) return fail('horizons 是 1–4 个持有天数（1–120 个交易日），比如 [5, 20, 60]');
  const tgt = cleanTarget(target);
  if (!tgt) return fail('target 必须是指数/ETF 名，比如 sp500、QQQ，或 custom（配合 tickers）');
  let tick = null;
  if (tgt.toLowerCase() === 'custom') {
    const list = (Array.isArray(tickers) ? tickers : String(tickers || '').split(',')).map((x) => String(x).trim().toUpperCase()).filter((x) => /^[A-Z0-9.\-]{1,10}$/.test(x));
    if (list.length < 20) return fail('想法检验是横截面比较，custom 股票池至少要 20 只股票');
    tick = [...new Set(list)].join(',');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return fail('start 格式是 YYYY-MM-DD');
  const hy = Number(holdoutYears);
  if (!(hy >= 0.5 && hy <= 5)) return fail('holdoutYears 要在 0.5 到 5 之间');
  const existing = await listResearchRaw(pid);
  if ((await Promise.all(existing.map(jobRunning))).filter(Boolean).length >= 2) return fail('这个项目已经有 2 个研究在跑了，等它们跑完再开新的（qlib 很吃 CPU）');

  const d = new Date();
  const jobId = `r${d.toISOString().slice(0, 19).replace(/[-:T]/g, '').slice(2)}${crypto.randomBytes(4).toString('hex')}`; // 4 字节随机：同一秒启动两个任务也不会撞号（1 字节时 1/256）
  const name = tgt.toLowerCase() === 'custom' ? 'CUSTOM' : tgt.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const wd = rdir(pid);
  await mkdir(path.join(wd, 'jobs'), { recursive: true });
  const spec = {
    idea: sentence, horizons: hz,
    factors: factors.map((f) => ({ name: f.name, label: String(f.label || f.name).slice(0, 60), components: f.components.map((c) => (c.expr ? { expr: c.expr.trim(), weight: c.weight == null ? 1 : Number(c.weight) } : { fundamental: c.fundamental.trim().toUpperCase(), weight: c.weight == null ? 1 : Number(c.weight) })) })),
  };
  const ideaFile = path.join(wd, 'jobs', `${jobId}.idea.json`);
  await writeJson(ideaFile, spec);
  const args = ['run', '--target', tgt, '--name', name, '--run-id', jobId, '--workdir', wd, '--start', start, '--holdout-years', String(hy), '--advanced', 'off', '--idea-file', ideaFile];
  if (tick) args.push('--tickers', tick);
  const pit = PIT_FILES[PIT_KEY[tgt.toLowerCase()]];
  if (pit && existsSync(pit)) args.push('--membership-file', pit);
  if (benchmark !== undefined && benchmark !== null) args.push('--benchmark', String(benchmark).toUpperCase().replace(/[^A-Z0-9.\-]/g, ''));
  if (costBps != null && Number.isFinite(Number(costBps))) args.push('--cost-bps', String(Number(costBps)));
  const job = {
    jobId, projectId: pid, mode: 'idea', idea: sentence, spec,
    title: String(title || '').slice(0, 120) || `想法检验：${sentence.slice(0, 40)}`,
    target: tgt, tickers: tick, benchmark: benchmark ?? null, features: 'idea', neutralize: 'none', start, holdoutYears: hy, advanced: 'off',
    args, runDir: path.join(wd, 'quant_runs', `${name}_${jobId}`), log: path.join(wd, `${jobId}.log`), created: now(),
  };
  job.pid = spawnRun(job);
  if (!job.pid) return fail(SPAWN_FAIL);
  job.pidStart = await procInfo(job.pid).then((i) => i && i.start);
  await writeJson(jobFile(pid, jobId), job);
  return ok({ job: await jobView(job) });
}

const SPAWN_FAIL = `qlib 研究引擎启动失败：${RUN_SH} 不存在或没有执行权限`;
// 返回子进程 pid；启动失败（run.sh 不存在 / 没有执行权限）时返回 undefined，原因写进任务日志。
// 一定要有 error 监听：否则启动失败会变成未捕获异常，把整个服务（和所有正在跑的 agent）带崩。
function spawnRun(job) {
  const args = job.mode === 'factors' ? [...job.args, '--stop-after', 'factors'] : job.args;
  // 套了沙盒时真正被 spawn 的是 /usr/bin/sandbox-exec，它总能起来并拿到 pid；
  // run.sh 本身没有执行权限要在这里先查，否则会留下一个「在跑」但其实立刻失败的假任务
  try { accessSync(RUN_SH, FS.X_OK); } catch (e) {
    try { appendFileSync(job.log, `[helm] 研究引擎启动失败：${e.message}\n`); } catch { /* 日志写不进去就算了 */ }
    return undefined;
  }
  const fd = openSync(job.log, 'a');
  const child = spawn(...boxed(RUN_SH, args), { detached: true, stdio: ['ignore', fd, fd], cwd: os.tmpdir(), env: { ...scrubEnv(), PYTHONWARNINGS: 'ignore' } });
  child.on('error', (e) => { try { appendFileSync(job.log, `[helm] 研究引擎启动失败：${e.message}\n`); } catch { /* 日志写不进去就算了 */ } });
  child.unref();
  closeSync(fd);
  return child.pid;
}

async function listResearchRaw(pid) {
  const dir = path.join(rdir(pid), 'jobs');
  if (!existsSync(dir)) return [];
  const out = [];
  // 只认 <jobId>.json；<jobId>.idea.json 是想法检验的规则文件，不是任务
  for (const f of await readdir(dir)) if (f.endsWith('.json') && JOB_ID.test(f.slice(0, -5))) { const j = await readJson(path.join(dir, f)); if (j) out.push(j); }
  return out.sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

export async function listResearch({ projectId }) {
  const jobs = await listResearchRaw(Number(projectId));
  return ok({ jobs: await Promise.all(jobs.map((j) => jobView(j))) });
}

async function loadJob(projectId, jobId) {
  if (!JOB_ID.test(String(jobId || ''))) return null;
  return readJson(jobFile(Number(projectId), jobId));
}

export async function readResearch({ projectId, jobId }) {
  const job = await loadJob(projectId, jobId);
  if (!job) return fail('研究任务不存在');
  return ok({ job: await jobView(job, { deep: true }) });
}

// 继续：停下的/失败的任务原样续跑；因子扫描做完后可以升级成完整研究（引擎会从因子之后接着跑）
export async function resumeResearch({ projectId, jobId, full = false }) {
  const job = await loadJob(projectId, jobId);
  if (!job) return fail('研究任务不存在');
  if (await jobRunning(job)) return fail('这个研究还在跑');
  if (full && job.mode === 'idea') return fail('想法检验不能升级成完整研究；要做完整研究请另开一个');
  if (!existsSync(RUN_SH)) return fail(`找不到 qlib 研究引擎：${RUN_SH}`);
  if ((full || job.mode !== 'idea') && !(await qlibPython())) return fail(QLIB_NEEDED);
  if (full) job.mode = 'full';
  const pid = spawnRun(job);
  if (!pid) return fail(SPAWN_FAIL);
  job.pid = pid;
  delete job.stale; delete job.staleNote;
  job.pidStart = await procInfo(pid).then((i) => i && i.start);
  job.resumed = now();
  await writeJson(jobFile(job.projectId, jobId), job);
  return ok({ job: await jobView(job) });
}

// 读进程的启动时间和命令行（macOS / Linux 的 ps 都支持）；进程不存在返回 null。3 秒超时，不会卡住事件循环。
export function procInfo(pid) {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 1) return resolve(null);
    execFile('ps', ['-o', 'lstart=,command=', '-p', String(pid)], { timeout: 3000, env: { ...process.env, LC_ALL: 'C' } }, (err, out) => {
      const m = !err && String(out).trim().match(/^(\w{3}\s+\w{3}\s+\d+\s+[\d:]{8}\s+\d{4})\s+(.*)$/s);
      resolve(m ? { start: m[1].replace(/\s+/g, ' '), command: m[2] } : null);
    });
  });
}

// 停止前先确认这个 pid 还是当初启动的研究进程：重启后 pid 可能被别的程序复用，kill -pid 会误伤无关进程组。
// 确认不了（没记录启动时间、或启动时间/命令对不上）就只把任务标记为已过期，不杀任何进程。
export async function stopResearch({ projectId, jobId }) {
  const job = await loadJob(projectId, jobId);
  if (!job) return fail('研究任务不存在');
  if (!alive(job.pid)) return ok({ stopped: false });
  const info = await procInfo(job.pid);
  if (!info) return ok({ stopped: false });
  const verified = isOurs(job, info); // run.sh 用 exec 换成了 python，ps 里看到的是 qs_pipeline.py
  if (!verified) {
    job.stale = true; job.staleNote = `pid ${job.pid} 已不是这个研究进程（可能是重启后被别的程序复用），未执行停止`;
    await writeJson(jobFile(job.projectId, jobId), job);
    return ok({ stopped: false, stale: true, note: job.staleNote });
  }
  try { process.kill(-job.pid, 'SIGTERM'); } catch { try { process.kill(job.pid, 'SIGTERM'); } catch { /* gone */ } }
  return ok({ stopped: true });
}

export async function exportSignals({ projectId, jobId, feature, ideaFactor, name }) {
  const job = await loadJob(projectId, jobId);
  if (!job) return fail('研究任务不存在');
  if (job.mode === 'idea') {
    const names = ((job.spec && job.spec.factors) || []).map((f) => f.name);
    if (!ideaFactor && names.length === 1) ideaFactor = names[0];
    if (!ideaFactor) return fail(`想法检验要指定导出哪个因子（ideaFactor）：${names.join(' / ')}`);
    if (!names.includes(ideaFactor)) return fail(`这次想法检验里没有因子 ${ideaFactor}，可选：${names.join(' / ')}`);
    feature = undefined;
  } else if (ideaFactor) return fail('ideaFactor 只用于想法检验');
  const nm = name ? String(name) : `p${job.projectId}_${jobId}${feature ? `_${String(feature).toLowerCase()}` : ideaFactor ? `_${ideaFactor}` : ''}`;
  if (!/^[A-Za-z0-9_]{3,60}$/.test(nm)) return fail('name 只能用字母、数字和下划线');
  if (feature && !/^[A-Za-z0-9_]{1,30}$/.test(String(feature))) return fail('feature 名不合法');
  const args = ['signals', '--run', job.runDir, '--data', DATA_DIR, '--name', nm];
  if (feature) args.push('--feature', String(feature));
  if (ideaFactor) args.push('--idea-factor', String(ideaFactor));
  const r = await bridge(args, 600000);
  if (r.error) return fail(r.error);
  job.signals = [...new Set([...(job.signals || []), nm])];
  await writeJson(jobFile(job.projectId, jobId), job);
  return ok({ signals: r });
}

export async function listSignals() {
  const dir = path.join(DATA_DIR, 'helm', 'signals');
  if (!existsSync(dir)) return ok({ signals: [] });
  const out = [];
  for (const f of await readdir(dir)) if (f.endsWith('.json')) { const j = await readJson(path.join(dir, f)); if (j) out.push(j); }
  return ok({ signals: out.sort((a, b) => String(b.exported).localeCompare(String(a.exported))) });
}

export async function researchPlot({ projectId, jobId, file }) {
  const job = await loadJob(projectId, jobId);
  if (!job || !/^[A-Za-z0-9_.-]+\.png$/.test(String(file || ''))) return null;
  try { return await readFile(path.join(job.runDir, 'plots', file)); } catch { return null; }
}

// 引擎的验证期登记表：每个指数的验证期被看过几次（研究和 LEAN 回测共用这条纪律）
export async function holdoutRegistry() {
  const reg = await readJson(path.join(HOME, '.qlib', 'qs_cache', 'holdout_registry.json'), []);
  return reg.filter((r) => !r.synthetic_null_test).map(({ key, window, at }) => ({ key, window, at }));
}
