// 参数敏感性测试：node test/sensitivity.test.mjs（快速模式 --fast 只测替身 LEAN；不带 --fast 时多跑一次真实 LEAN 的参数通路检查）
// 全程在临时目录里；LEAN 用 E._hooks 的替身，不需要 dotnet。
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, stat, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FAST = process.argv.includes('--fast');
const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-sens-'));
process.env.HELM_PROJECTS_DIR = path.join(TMP, 'projects');
process.env.HELM_TRIALS_FILE = path.join(TMP, 'trials.jsonl');
process.env.HELM_ALPACA_FILE = path.join(TMP, 'secrets', 'alpaca.json');

const E = await import('../lib/engine.mjs');
const R = await import('../lib/robust.mjs');
const PP = await import('../lib/paper.mjs');
const PD = process.env.HELM_PROJECTS_DIR;

let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failed += 1;
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  /* ---- 1. 参数发现 ---- */
  {
    const d = R.discoverParams(`class A(QCAlgorithm):
    def initialize(self):
        self.fast = int(self.get_parameter("fast", 20))
        self.slow = self.get_parameter('slow', 50)
        self.thr = self.GetParameter("thr", 0.5)
        self.neg = self.get_parameter("neg", -5)
        self.sci = self.get_parameter("tiny", 1e-3)
        self.dup = self.get_parameter("fast", 20)
        self.bad = self.get_parameter("calc", int(3))
        self.none = self.get_parameter("nodefault")
        self.str = self.get_parameter("s", "abc")
        # self.get_parameter("commented", 9)
        self.v = self.get_parameter(name_var, 3)
`);
    const by = Object.fromEntries(d.params.map((p) => [p.name, p]));
    check('发现：整数、浮点、camelCase、负数、科学计数', eq(Object.keys(by), ['fast', 'slow', 'thr', 'neg', 'tiny']) && by.fast.isInt && by.slow.default === 50 && !by.thr.isInt && by.thr.default === 0.5 && by.neg.default === -5 && !by.tiny.isInt && by.tiny.default === 0.001, JSON.stringify(d.params));
    check('发现：重复声明只算一个', d.params.filter((p) => p.name === 'fast').length === 1);
    check('发现：非字面量 / 无默认值 / 字符串默认值列为不能自动微调', ['calc', 'nodefault', 's'].every((n) => d.skipped.some((x) => x.name === n)) && !d.params.some((p) => p.name === 'calc'), JSON.stringify(d.skipped));
    check('发现：注释里的和变量名的调用被忽略', !by.commented && !d.skipped.some((x) => x.name === 'commented'));
    const conflict = R.discoverParams('self.get_parameter("a", 5)\nself.get_parameter("a", 6)');
    check('发现：同名但默认值不同 → 不能自动微调', conflict.params.length === 0 && conflict.skipped.length === 1);
    check('发现：没有参数', eq(R.discoverParams('x = 1'), { params: [], skipped: [] }));
  }

  /* ---- 2. 变体取值 ---- */
  {
    const v = R.variantValues;
    check('变体：整数 1 → 只有 2（0.8 倍取整回到 1，再减 1 会变成 0，跳过）', eq(v(1, true), { lo: null, hi: 2 }), JSON.stringify(v(1, true)));
    check('变体：整数 2 → 1 / 3（不能和默认值相同）', eq(v(2, true), { lo: 1, hi: 3 }));
    check('变体：整数 3 → 2 / 4', eq(v(3, true), { lo: 2, hi: 4 }));
    check('变体：整数 20 → 16 / 24', eq(v(20, true), { lo: 16, hi: 24 }));
    check('变体：浮点 0.5 → 0.4 / 0.6', eq(v(0.5, false), { lo: 0.4, hi: 0.6 }));
    check('变体：浮点 0.05 → 0.04 / 0.06', eq(v(0.05, false), { lo: 0.04, hi: 0.06 }));
    check('变体：负整数保持符号（-10 → -8 / -12）', eq(v(-10, true), { lo: -8, hi: -12 }));
    check('变体：负浮点 -0.5 → -0.4 / -0.6', eq(v(-0.5, false), { lo: -0.4, hi: -0.6 }));
    check('变体：-1 不会变成 0', eq(v(-1, true), { lo: null, hi: -2 }));
    check('变体：默认值 0 没法按比例微调', eq(v(0, true), { lo: null, hi: null }) && eq(v(0, false), { lo: null, hi: null }));
    for (const d of [3, 7, 12, 50, 252, 1000]) { const x = v(d, true); check(`变体：整数 ${d} 两个变体都和默认值不同、且为整数`, [x.lo, x.hi].every((q) => Number.isInteger(q) && q !== d)); }
    const plan = R.sensitivityPlan([{ name: 'a', default: 1, isInt: true }, { name: 'b', default: 0.5, isInt: false }]);
    check('计划：每个参数最多两个变体', plan.length === 3 && plan.map((x) => x.id).join() === 'p1_hi,p2_lo,p2_hi', plan.map((x) => x.id).join());
  }

  /* ---- 3. 判定规则 ---- */
  {
    const vd = (b, a, c) => R.sensitivityVerdict(b, [{ sharpe: a }, { sharpe: c }]).verdict;
    check('判定：都在 ±30% 内 → 稳', vd(1, 0.75, 1.25) === '稳');
    check('判定：恰好 ±30% 边界 → 稳', vd(1, 0.7, 1.3) === '稳');
    check('判定：超出 30% → 敏感', vd(1, 0.65, 1.1) === '敏感');
    check('判定：|夏普| < 0.5 用 ±0.15 的绝对带', vd(0.3, 0.2, 0.4) === '稳' && vd(0.3, 0.1, 0.4) === '敏感');
    check('判定：|夏普| = 0.5 时用相对带（±0.15 刚好）', vd(0.5, 0.35, 0.65) === '稳' && vd(0.5, 0.34, 0.5) === '敏感');
    check('判定：方向翻转优先于敏感', vd(1, -0.1, 1) === '方向翻转' && vd(0.3, 0.3, -0.05) === '方向翻转');
    check('判定：负夏普同样按绝对值', vd(-1, -0.8, -1.2) === '稳' && vd(-1, 0.2, -1) === '方向翻转');
    check('判定：只有一个变体也能判', R.sensitivityVerdict(1, [{ sharpe: 1.1 }]).verdict === '稳');
    check('判定：有变体没跑成功 → 无法判断（有翻转时仍报翻转）', R.sensitivityVerdict(1, [{ sharpe: 1 }, { sharpe: null }]).verdict === null && R.sensitivityVerdict(1, [{ sharpe: -1 }, { sharpe: null }]).verdict === '方向翻转');
    const c1 = R.sensitivityConclusion([{ name: 'a', verdict: '稳' }, { name: 'b', verdict: '稳' }]);
    const c2 = R.sensitivityConclusion([{ name: 'a', verdict: '稳' }, { name: 'b', verdict: '方向翻转' }, { name: 'c', verdict: '敏感' }]);
    check('结论：全稳 / 有敏感的各一句话', /不敏感/.test(c1) && /b、c/.test(c2) && /b 的夏普方向翻转/.test(c2) && !/\n/.test(c1 + c2), `${c1} | ${c2}`);
  }

  /* ---- 4. LEAN 配置：默认不变，变体带参数 ---- */
  {
    const base = { algorithmFile: '/x/main.py', className: 'A', outDir: '/x/out', id: 'abc', name: 'N' };
    const expected = [
      path.join(E.LAUNCHER_DIR, 'QuantConnect.Lean.Launcher.dll'), '--environment', 'backtesting', '--algorithm-language', 'Python',
      '--algorithm-location', '/x/main.py', '--algorithm-type-name', 'A', '--data-folder', `${E.DATA_DIR}/`,
      '--results-destination-folder', '/x/out', '--algorithm-id', 'abc', '--backtest-name', 'N', '--close-automatically', 'true',
    ];
    check('默认运行：LEAN 参数和以前逐项一致', eq(E.leanArgs(base), expected));
    check('不传 / 传空 parameters：和默认完全一样', eq(E.leanArgs({ ...base, parameters: undefined }), expected) && eq(E.leanArgs({ ...base, parameters: {} }), expected));
    const withP = E.leanArgs({ ...base, parameters: { fast: '16', thr: '0.4' } });
    check('变体：多出 --parameters 名字:值，其余不变', eq(withP.slice(0, expected.length), expected) && eq(withP.slice(expected.length), ['--parameters', 'fast:16,thr:0.4']), JSON.stringify(withP.slice(expected.length)));
    let bad = 0;
    for (const p of [{ 'a:1,b': '1' }, { a: '1,b:2' }, { a: 'x y' }, { 'a b': '1' }]) { try { E.leanArgs({ ...base, parameters: p }); } catch { bad += 1; } }
    check('参数名或值里有 , : 空格等字符会被拒绝（不能夹带别的参数）', bad === 4);
  }

  /* ---- 5. 造几个“已完成”的回测，LEAN 用替身 ---- */
  const pid = (await E.createProject({ name: '敏感性测试' })).projects[0].projectId;
  const CODE = `from AlgorithmImports import *
class S(QCAlgorithm):
    def initialize(self):
        self.set_start_date(2018, 1, 1)
        self.add_equity("SPY", Resolution.DAILY)
        self.fast = int(self.get_parameter("fast", 20))
        self.thr = self.get_parameter("thr", 0.5)
        self.w = self.get_parameter("width", 10)
        self.calc = self.get_parameter("calc", int(4))
`;
  let seq = 0;
  const mkBt = async ({ code = CODE, meta = {}, holdoutLog = false } = {}) => {
    const bid = (0xabc000 + (seq += 1)).toString(16).padStart(16, '0');
    const dir = path.join(PD, String(pid), 'backtests', bid);
    await mkdir(path.join(dir, 'code'), { recursive: true });
    await mkdir(path.join(dir, 'out'), { recursive: true });
    await writeFile(path.join(dir, 'code', 'main.py'), code);
    await writeFile(path.join(dir, 'meta.json'), JSON.stringify({ backtestId: bid, projectId: pid, name: `bt${seq}`, status: 'Completed.', progress: 1, created: new Date().toISOString(), role: 'candidate', period: 'dev', file: 'main.py', summary: { sharpeRatio: 1, compoundingAnnualReturn: '10%', drawdown: '12%' }, ...meta }));
    await writeFile(path.join(dir, 'out', `${bid}.json`), JSON.stringify({ state: { Status: 'Completed' }, statistics: { 'Compounding Annual Return': '10.000%', 'Sharpe Ratio': '1.0', Drawdown: '12.000%', 'Total Orders': '30' } }));
    if (holdoutLog) await writeFile(path.join(PD, String(pid), 'holdout_log.json'), JSON.stringify([{ backtestId: bid, at: new Date().toISOString() }]));
    return bid;
  };

  let gate = null; // 非空时替身 LEAN 在这里暂停
  const hooks0 = { ...E._hooks };
  const calls = []; const jobs = [];
  E._hooks.hasLocalData = () => true;
  E._hooks.startSensitivity = (p, b, j) => { jobs.push(E.runSensitivityJob(p, b, j)); };
  // 替身 LEAN：夏普由“哪个参数、往哪边调”决定；记下收到的 parameters
  E._hooks.runLean = async (o) => {
    calls.push(o);
    if (gate) await gate;
    const [[name, val]] = Object.entries(o.parameters);
    const lo = Number(val) < { fast: 20, thr: 0.5, width: 10 }[name];
    const sh = { fast: lo ? 0.9 : 1.2, thr: lo ? 0.8 : -0.2, width: lo ? 0.2 : 1.0 }[name];
    await mkdir(o.outDir, { recursive: true });
    const result = { state: { Status: 'Completed' }, statistics: { 'Compounding Annual Return': `${(sh * 10).toFixed(3)}%`, 'Sharpe Ratio': String(sh), Drawdown: '9.000%', 'Total Orders': String(30 + calls.length) } };
    await writeFile(path.join(o.outDir, `${o.id}.json`), JSON.stringify(result));
    return { result, error: null };
  };

  /* ---- 6. 拒绝的情况 ---- */
  const holdoutBt = await mkBt({ meta: { period: 'holdout', holdoutSeq: 1 } });
  const holdoutLogBt = await mkBt({ holdoutLog: true });
  const noneBt = await mkBt({ code: 'from AlgorithmImports import *\nclass S(QCAlgorithm):\n    def initialize(self):\n        self.add_equity("SPY")\n' });
  const nonLitBt = await mkBt({ code: 'from AlgorithmImports import *\nclass S(QCAlgorithm):\n    def initialize(self):\n        self.add_equity("SPY")\n        self.x = self.get_parameter("x", int(3))\n' });
  const manyBt = await mkBt({ code: `from AlgorithmImports import *\nclass S(QCAlgorithm):\n    def initialize(self):\n        self.add_equity("SPY")\n${[1, 2, 3, 4, 5, 6, 7].map((i) => `        self.p${i} = self.get_parameter("p${i}", ${i * 10})`).join('\n')}\n` });
  const runningBt = await mkBt();
  const unfinishedBt = await mkBt({ meta: { status: 'In Progress...' } });
  const rj = async (bid) => E.runSensitivity({ projectId: pid, backtestId: bid });
  let r = await rj(holdoutBt);
  check('拒绝：验证期回测（period = holdout）', !r.success && /验证期/.test(r.errors.join('')), r.errors && r.errors[0]);
  r = await rj(holdoutLogBt);
  check('拒绝：验证期记录（holdout_log.json）里有的回测', !r.success && /验证期/.test(r.errors.join('')));
  await rm(path.join(PD, String(pid), 'holdout_log.json'), { force: true });
  r = await rj(noneBt);
  check('拒绝：没有声明参数，说明怎么写', !r.success && /get_parameter/.test(r.errors.join('')), r.errors && r.errors[0]);
  r = await rj(nonLitBt);
  check('拒绝：参数默认值都不是数字常量', !r.success && /不是数字常量/.test(r.errors.join('')));
  r = await rj(manyBt);
  check('拒绝：超过 6 个参数，写明上限', !r.success && /7 个/.test(r.errors.join('')) && /上限 6/.test(r.errors.join('')), r.errors && r.errors[0]);
  r = await rj(unfinishedBt);
  check('拒绝：回测还没跑完', !r.success && /没有跑完|没跑完/.test(r.errors.join('')));
  r = await rj('0000000000000000');
  check('拒绝：回测不存在', !r.success);
  check('拒绝的情况没有留下 sensitivity 目录，也没有调用 LEAN', !existsSync(path.join(PD, String(pid), 'backtests', holdoutBt, 'sensitivity')) && calls.length === 0);
  const rd = await E.sensitivityRead({ projectId: pid, backtestId: holdoutBt });
  check('读取：验证期回测 canRun = false，且说明原因', rd.success && rd.holdout === true && rd.canRun === false && /验证期/.test(rd.reason));
  const rn = await E.sensitivityRead({ projectId: pid, backtestId: noneBt });
  check('读取：没有参数 canRun = false', rn.success && rn.canRun === false && rn.params.length === 0);

  /* ---- 7. 正常运行（替身 LEAN）---- */
  const bid = await mkBt();
  const trials0 = await readFile(process.env.HELM_TRIALS_FILE, 'utf8').catch(() => '');
  const listBefore = (await E.backtestsList({ projectId: pid })).count;
  const rp = await E.sensitivityRead({ projectId: pid, backtestId: bid });
  check('读取：有 3 个可微调参数、1 个不能自动微调、计划 6 次重跑', rp.canRun && rp.params.length === 3 && rp.skipped.length === 1 && rp.plan.length === 6, JSON.stringify({ p: rp.params.length, s: rp.skipped.length, plan: rp.plan.length }));
  const start = await rj(bid);
  check('运行：已开始，共 6 次重跑', start.success && start.sensitivity.total === 6 && start.sensitivity.status === 'running', start.errors && start.errors[0]);
  const again = await rj(bid);
  check('拒绝：同一个回测已经在运行', !again.success && /正在运行/.test(again.errors.join('')));
  await Promise.all(jobs);
  const sf = path.join(PD, String(pid), 'backtests', bid, 'sensitivity', 'sensitivity.json');
  check('生成 sensitivity.json', existsSync(sf));
  const S = JSON.parse(await readFile(sf, 'utf8'));
  check('状态完成，进度 100%，重跑 6 个变体', S.status === 'done' && S.progress === 1 && S.variantsRun === 6 && S.variants.length === 6 && calls.length === 6, `${S.status} ${S.variantsRun}`);
  check('每次重跑只改一个参数，值是默认值 ×0.8 / ×1.2', calls.every((c) => Object.keys(c.parameters).length === 1) && eq(calls.map((c) => `${Object.keys(c.parameters)[0]}=${Object.values(c.parameters)[0]}`), ['fast=16', 'fast=24', 'thr=0.4', 'thr=0.6', 'width=8', 'width=12']), calls.map((c) => JSON.stringify(c.parameters)).join(' '));
  check('变体用的是回测冻结的代码快照', calls.every((c) => c.algorithmFile === path.join(PD, String(pid), 'backtests', bid, 'code', 'main.py')));
  check('原版指标来自原回测的结果文件', S.base.sharpe === 1 && S.base.annualReturn === '10.000%' && S.base.maxDrawdown === '12.000%');
  const by = Object.fromEntries(S.rows.map((x) => [x.name, x]));
  check('判定：fast 稳 / thr 方向翻转 / width 敏感', by.fast.verdict === '稳' && by.thr.verdict === '方向翻转' && by.width.verdict === '敏感', S.rows.map((x) => `${x.name}:${x.verdict}`).join(' '));
  check('每行有 −20% / +20% 的值和指标', by.fast.lo.value === 16 && by.fast.hi.value === 24 && by.fast.hi.sharpe === 1.2 && by.fast.lo.annualReturn === '9.000%' && by.fast.lo.maxDrawdown === '9.000%');
  check('带固定警告（挑最好的变体 = 调参，要作为新回测计数）', /调参/.test(S.warning) && /新的回测/.test(S.warning) && /计入尝试次数/.test(S.warning) && S.warning === R.SENS_WARNING);
  check('有一句话结论', typeof S.conclusion === 'string' && /thr/.test(S.conclusion));
  check('记录了不能自动微调的参数', eq(S.skipped.map((x) => x.name), ['calc']));
  check('变体输出放在 sensitivity/<变体>/out 里', existsSync(path.join(PD, String(pid), 'backtests', bid, 'sensitivity', 'p1_lo', 'out', 'p1_lo.json')));
  const fin = await E.sensitivityRead({ projectId: pid, backtestId: bid });
  check('读取：完成后返回结果，仍可再跑一次', fin.success && fin.sensitivity.status === 'done' && fin.canRun === true);

  /* ---- 8. 变体不是回测；不影响尝试次数 ---- */
  check('变体不出现在回测列表里', (await E.backtestsList({ projectId: pid })).count === listBefore && !(await E.backtestsList({ projectId: pid })).backtests.some((b) => /^p\d_(lo|hi)$/.test(b.backtestId)));
  check('回测目录下没有多出变体条目', !(await readdir(path.join(PD, String(pid), 'backtests'))).some((n) => /^p\d_/.test(n)));
  let mains = 0;
  for (const id of ['p1_lo', 'p1_hi', 'p2_lo', '1', 'sensitivity']) {
    const m = await E.updateBacktest({ projectId: pid, backtestId: id, role: 'main' });
    if (!m.success) mains += 1;
  }
  check('变体不能标成主版本', mains === 5);
  let paperOk = 0;
  for (const id of ['p1_lo', 'p1_hi', 'sensitivity']) {
    const ps = await PP.startSession({ projectId: pid, backtestId: id, mode: 'sim', capital: 50000 }).catch(() => ({ success: false }));
    if (!ps.success) paperOk += 1;
  }
  check('变体不能开始模拟实盘', paperOk === 3);
  check('尝试记录（trials.jsonl）没有变化', (await readFile(process.env.HELM_TRIALS_FILE, 'utf8').catch(() => '')) === trials0);
  const meta1 = JSON.parse(await readFile(path.join(PD, String(pid), 'backtests', bid, 'meta.json'), 'utf8'));
  check('原回测的 meta.json 没被改动', meta1.role === 'candidate' && meta1.status === 'Completed.' && meta1.period === 'dev');

  const zeroBt = await mkBt({ code: 'from AlgorithmImports import *\nclass S(QCAlgorithm):\n    def initialize(self):\n        self.add_equity("SPY")\n        self.a = self.get_parameter("a", 0)\n        self.b = self.get_parameter("b", 5)\n' });
  const rz = await E.sensitivityRead({ projectId: pid, backtestId: zeroBt });
  check('默认值为 0 的参数列入“不能自动微调”，不占重跑次数', rz.params.length === 1 && rz.params[0].name === 'b' && rz.skipped.some((x) => x.name === 'a') && rz.plan.length === 2, JSON.stringify(rz.skipped));

  /* ---- 9. 失败的变体 / 进程中断 ---- */
  const bid2 = await mkBt({ code: 'from AlgorithmImports import *\nclass S(QCAlgorithm):\n    def initialize(self):\n        self.add_equity("SPY")\n        self.k = self.get_parameter("fast", 20)\n' });
  jobs.length = 0; calls.length = 0;
  const lean1 = E._hooks.runLean;
  E._hooks.runLean = async (o) => (Number(o.parameters.fast) > 20 ? { result: null, error: 'boom' } : lean1(o));
  await rj(bid2); await Promise.all(jobs);
  const S2 = JSON.parse(await readFile(path.join(PD, String(pid), 'backtests', bid2, 'sensitivity', 'sensitivity.json'), 'utf8'));
  check('一个变体没跑成功：任务照常完成，该参数无法判断，原因写在变体上', S2.status === 'done' && S2.rows[0].verdict === null && S2.rows[0].hi.status === 'error' && /boom/.test(S2.rows[0].hi.error));
  E._hooks.runLean = lean1;
  const bid3 = await mkBt();
  await mkdir(path.join(PD, String(pid), 'backtests', bid3, 'sensitivity'), { recursive: true });
  const stale = path.join(PD, String(pid), 'backtests', bid3, 'sensitivity', 'sensitivity.json');
  await writeFile(stale, JSON.stringify({ status: 'running', progress: 0.3 }));
  
  const old = new Date(Date.now() - 40 * 60 * 1000); await utimes(stale, old, old);
  const rs = await E.sensitivityRead({ projectId: pid, backtestId: bid3 });
  check('运行中但 25 分钟没更新：标成中断，可以重新运行', rs.sensitivity.status === 'error' && /中断/.test(rs.sensitivity.error) && rs.canRun);
  {
    const st0 = await stat(stale); const b0 = await readFile(stale, 'utf8');
    await E.sensitivityRead({ projectId: pid, backtestId: bid3 }); await E.sensitivityRead({ projectId: pid, backtestId: bid3 });
    const st1 = await stat(stale);
    check('读取没有副作用：陈旧任务只在返回值里标成中断，文件内容和修改时间不变', (await readFile(stale, 'utf8')) === b0 && st1.mtimeMs === st0.mtimeMs);
  }

  /* ---- 9a. 任务编号：旧进程被新一轮运行替换后不能覆盖新结果 ---- */
  {
    const bidJ = await mkBt();
    const fJ = path.join(PD, String(pid), 'backtests', bidJ, 'sensitivity', 'sensitivity.json');
    jobs.length = 0; calls.length = 0;
    let release; gate = new Promise((res) => { release = res; });
    const rA = await rj(bidJ); // A：在第一次重跑里暂停
    const jobA = jobs[0];
    await sleep(150);
    const idA = JSON.parse(await readFile(fJ, 'utf8')).jobId;
    const oldT = new Date(Date.now() - 40 * 60 * 1000); await utimes(fJ, oldT, oldT); // 标成陈旧
    gate = null;
    const rB = await rj(bidJ); // B：替换陈旧的 A，一路跑完
    await jobs[1]; await sleep(50);
    const bytesB = await readFile(fJ, 'utf8'); const SB = JSON.parse(bytesB);
    release(); await jobA; await sleep(100);
    const after = await readFile(fJ, 'utf8');
    check('每次运行有自己的任务编号，写在 sensitivity.json 里', rA.success && rB.success && idA && SB.jobId && idA !== SB.jobId, `${idA} / ${SB.jobId}`);
    check('旧进程恢复后安静退出：B 的结果文件一个字节都没变', SB.status === 'done' && after === bytesB);
  }

  /* ---- 9b. 评审补充：并发启动只起一个进程 / 变体也过静态检查 / MCP 文字 / 错误里没有绝对路径 ---- */
  {
    const bidR = await mkBt();
    jobs.length = 0; calls.length = 0;
    const [r1, r2] = await Promise.all([E.runSensitivity({ projectId: pid, backtestId: bidR }), E.runSensitivity({ projectId: pid, backtestId: bidR })]);
    check('同时点两次：只有一次成功启动，只起一个进程', [r1, r2].filter((x) => x.success).length === 1 && jobs.length === 1, JSON.stringify([r1.success, r2.success, jobs.length]));
    await Promise.all(jobs);

    const bidL = await mkBt({ code: 'from AlgorithmImports import *\nimport os\nclass S(QCAlgorithm):\n    def initialize(self):\n        self.add_equity("SPY")\n        os.system("echo hi")\n        self.k = self.get_parameter("fast", 20)\n' });
    jobs.length = 0; calls.length = 0;
    await rj(bidL); await Promise.all(jobs);
    const SL = JSON.parse(await readFile(path.join(PD, String(pid), 'backtests', bidL, 'sensitivity', 'sensitivity.json'), 'utf8'));
    check('快照里有危险代码：变体不跑，任务标成出错并说明代码检查没通过', SL.status === 'error' && /代码检查没通过/.test(SL.error) && calls.length === 0, SL.error);
    check('出错信息里没有绝对路径', !SL.error.includes(os.homedir()) && !SL.error.includes(TMP));

    const bidM = await mkBt();
    const mcp = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'qc-mcp.mjs')], { env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let mo = ''; mcp.stdout.on('data', (c) => { mo += c; }); mcp.stdin.on('error', () => {});
    const done = new Promise((res) => mcp.on('close', res));
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sensitivity_backtest', arguments: { projectId: pid, backtestId: bidM } } })}\n`);
    mcp.stdin.end();
    await Promise.race([done, sleep(20000).then(() => mcp.kill('SIGKILL'))]);
    const txt = (mo.split('\n').filter(Boolean).map((l) => JSON.parse(l))[0] || {}).result;
    const t0 = txt && txt.content[0].text;
    check('MCP sensitivity_backtest（还没跑过）：写“共 6 次重跑”，不是把数组直接拼进句子', /共 6 次重跑/.test(t0 || '') && !/\[object/.test(t0 || ''), String(t0).slice(0, 120));
  }

  Object.assign(E._hooks, hooks0);

  /* ---- 10. 真实 LEAN：参数通路（只在完整模式跑）---- */
  if (!FAST) {
    const status = await E.engineStatus();
    if (!status.ok) check('本地 LEAN 引擎就绪', false, `缺少 ${status.missing.join(', ')}`);
    else {
      const SMA = `from AlgorithmImports import *


class SensitivityProbe(QCAlgorithm):
    def initialize(self):
        self.set_start_date(2018, 1, 1)
        self.set_end_date(2020, 12, 31)
        self.set_cash(100000)
        self.set_benchmark("SPY")
        self.symbol = self.add_equity("SPY", Resolution.DAILY).symbol
        self.window = int(self.get_parameter("sma_window", 10))
        self.ma = self.sma(self.symbol, self.window, Resolution.DAILY)
        self.set_warm_up(60, Resolution.DAILY)

    def on_data(self, data: Slice):
        if self.is_warming_up or not self.ma.is_ready:
            return
        price = self.securities[self.symbol].price
        if price > self.ma.current.value:
            if not self.portfolio.invested:
                self.set_holdings(self.symbol, 0.98)
        elif self.portfolio.invested:
            self.liquidate()
`;
      const rp2 = (await E.createProject({ name: 'Sensitivity Probe' })).projects[0].projectId;
      await E.writeProjectFile({ projectId: rp2, name: 'main.py', content: SMA });
      const bt = await E.createBacktest({ projectId: rp2, name: '敏感性 原版', role: 'debug', period: 'dev' });
      const waitBt = async () => { const t0 = Date.now(); for (;;) { const x = await E.backtestsRead({ projectId: rp2, backtestId: bt.backtest.backtestId }); if (x.success && !/Queue|Progress/.test(x.backtest.status)) return x.backtest; if (Date.now() - t0 > 5 * 60 * 1000) return null; await sleep(1000); } };
      const done = await waitBt();
      check('真实 LEAN：原版回测跑完', done && /Completed/.test(done.status), done && `${done.status} ${done.error || ''}`);
      const ids = bt.backtest.backtestId;
      const trialsReal = await readFile(process.env.HELM_TRIALS_FILE, 'utf8').catch(() => '');
      const go = await E.runSensitivity({ projectId: rp2, backtestId: ids });
      check('真实 LEAN：参数敏感性已开始（独立进程）', go.success && go.sensitivity.total === 2, go.errors && go.errors[0]);
      let cur = null; const t0 = Date.now();
      while (Date.now() - t0 < 10 * 60 * 1000) { cur = (await E.sensitivityRead({ projectId: rp2, backtestId: ids })).sensitivity; if (cur && cur.status !== 'running') break; await sleep(2000); }
      check('真实 LEAN：两个变体都跑完', cur && cur.status === 'done' && cur.variants.length === 2 && cur.variants.every((v) => v.status === 'ok'), cur && JSON.stringify(cur.variants.map((v) => v.error || v.status)));
      if (cur && cur.status === 'done') {
        const b = cur.base;
        const differs = (v) => v.orders !== b.orders || v.sharpe !== b.sharpe || v.annualReturn !== b.annualReturn;
        check('真实 LEAN：两个变体的订单数或收益和原版不同（参数真的传进了策略）', cur.variants.every(differs), JSON.stringify({ base: b, lo: cur.variants[0], hi: cur.variants[1] }));
        check('真实 LEAN：两个变体之间也不同', cur.variants[0].orders !== cur.variants[1].orders || cur.variants[0].sharpe !== cur.variants[1].sharpe);
      }
      check('真实 LEAN：不改变尝试记录和回测列表', (await readFile(process.env.HELM_TRIALS_FILE, 'utf8').catch(() => '')) === trialsReal && (await E.backtestsList({ projectId: rp2 })).count === 1);
    }
  }
} catch (e) {
  check('测试过程没有异常', false, e.stack);
}

await rm(TMP, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
