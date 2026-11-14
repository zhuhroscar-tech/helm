// 调参（LEAN 引擎）：node test/tune.test.mjs
// 纯函数（范围、拉丁超立方、参数平台、CSCV PBO、结论）+ 用替身 LEAN 跑一遍完整任务。全程在临时目录。
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-tune-'));
process.env.HELM_PROJECTS_DIR = path.join(TMP, 'projects');
process.env.HELM_TRIALS_FILE = path.join(TMP, 'trials.jsonl');
process.env.HELM_ALPACA_FILE = path.join(TMP, 'secrets', 'alpaca.json');
const T = await import('../lib/tune.mjs');
const E = await import('../lib/engine.mjs');
const { mulberry32 } = await import('../lib/stats.mjs');
const PD = process.env.HELM_PROJECTS_DIR;

let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); if (!cond) failed += 1; };

// 正态随机数（Box–Muller）
const gauss = (rnd) => Math.sqrt(-2 * Math.log(rnd() || 1e-12)) * Math.cos(2 * Math.PI * rnd());

try {
  /* ---- 范围 ---- */
  {
    const P = [{ name: 'fast', default: 20, isInt: true }, { name: 'thr', default: -0.02, isInt: false }, { name: 'z', default: 0, isInt: true }];
    const { ranges, errors } = T.buildRanges(P);
    const f = ranges.find((r) => r.name === 'fast'); const t = ranges.find((r) => r.name === 'thr');
    check('默认范围：÷2 到 ×2（整数取整）', f.lo === 10 && f.hi === 40);
    check('负数参数：范围保持负号', t.lo === -0.04 && t.hi === -0.01);
    check('默认值 0：没法按比例搜索，报出来', errors.length === 1 && /z/.test(errors[0]));
    const bad = T.buildRanges(P.slice(0, 2), { fast: [1, 500], thr: [-0.1, 0.01], nope: [1, 2] }).errors;
    check('自定义范围：太宽 / 跨过 0 / 没有这个参数都被拒', bad.length === 3, bad.join(' | '));
    check('自定义范围：合法的照用', T.buildRanges(P.slice(0, 1), { fast: [5, 60] }).ranges[0].hi === 60);
  }

  /* ---- 拉丁超立方 ---- */
  {
    const ranges = T.buildRanges([{ name: 'a', default: 20, isInt: true }, { name: 'b', default: 0.5, isInt: false }]).ranges;
    const c = T.sampleConfigs(ranges, 16, T.seedOf('job1'));
    check('候选数 = budget，第一个是原参数', c.length === 16 && c[0].isDefault && c[0].values.a === 20 && c[0].values.b === 0.5);
    check('全部在范围内、整数参数是整数', c.every((x) => x.values.a >= 10 && x.values.a <= 40 && Number.isInteger(x.values.a) && x.values.b >= 0.25 && x.values.b <= 1));
    check('没有重复的组合', new Set(c.map((x) => `${x.values.a}|${x.values.b}`)).size === c.length);
    const u = c.slice(1).map((x) => T.toUnit(ranges[1], x.values.b)).sort((p, q) => p - q);
    check('分层：每一格（1/15）里正好一个点', u.every((x, i) => Math.floor(x * 15 - 1e-9) === i || Math.abs(x * 15 - i) < 1e-6), u.map((x) => x.toFixed(2)).join(','));
    check('同一个任务编号抽到同样的候选（可复现）', JSON.stringify(T.sampleConfigs(ranges, 16, T.seedOf('job1'))) === JSON.stringify(c));
    const tiny = T.sampleConfigs(T.buildRanges([{ name: 'k', default: 2, isInt: true }]).ranges, 16, 1);
    check('小整数范围（1–4）凑不满就少几个，不重复', tiny.length <= 4 && new Set(tiny.map((x) => x.values.k)).size === tiny.length);
  }

  /* ---- 参数平台 ---- */
  {
    const ranges = T.buildRanges([{ name: 'a', default: 20, isInt: true }]).ranges;
    // 一个孤立的尖峰（a=39，夏普 3）和一片平台（a=14–18，夏普 1.4 左右）
    const cands = [[20, 1.0], [14, 1.4], [15, 1.5], [16, 1.45], [18, 1.35], [30, 0.2], [33, 0.1], [39, 3.0], [11, 0.8], [25, 0.6]].map(([a, s], i) => ({ id: `c${i}`, values: { a }, sharpe: s }));
    const top = T.plateauScores(ranges, cands)[0];
    const pick = cands.find((c) => c.id === top.id).values.a;
    check('平台：挑平台中间的参数，不挑孤立尖峰', pick >= 14 && pick <= 18, `挑了 a=${pick}`);
  }

  /* ---- 参数平台：抽样统计（固定种子）。一个参数无关时也能大致找到山顶；一个运气好的孤立候选大多挑不中 ---- */
  {
    const { ranges } = T.buildRanges([{ name: 'fast', default: 20, isInt: true }, { name: 'thr', default: 0.5, isInt: false }]);
    const hill = (f) => ((0.0006 - 0.000004 * (f - 16) ** 2) / 0.01) * Math.sqrt(252);
    let miss = 0; let lucky = 0; const N = 300;
    for (let i = 0; i < N; i++) {
      const c = T.sampleConfigs(ranges, 12, T.seedOf(`plateau-${i}`));
      const cands = c.map((x) => ({ ...x, sharpe: hill(x.values.fast) }));
      if (Math.abs(cands.find((x) => x.id === T.plateauScores(ranges, cands)[0].id).values.fast - 16) > 4) miss++;
      const L = 1 + (i % (c.length - 1));
      const withLuck = cands.map((x, j) => ({ ...x, sharpe: x.sharpe + (j === L ? 2 : 0) }));
      if (T.plateauScores(ranges, withLuck)[0].id === withLuck[L].id) lucky++;
    }
    check('平台（抽样统计）：有一个无关参数时，偏离山顶超过 4 的比例 < 25%', miss / N < 0.25, `${miss}/${N}`);
    check('平台（抽样统计）：一个候选夏普凭运气 +2 时，被挑中的比例 < 35%（单点最优是 100%）', lucky / N < 0.35, `${lucky}/${N}`);
  }

  /* ---- CSCV PBO ---- */
  {
    const rnd = mulberry32(7);
    const days = 756; // 3 年
    // 纯噪声：20 个候选都没有真实优势 → PBO 应该在 0.5 附近（挑出来的最好的在样本外是随机的）
    const noise = Array.from({ length: 20 }, () => Array.from({ length: days }, () => 0.01 * gauss(rnd)));
    const p0 = T.cscvPbo(noise, 8);
    check('纯噪声：PBO 接近 0.5（0.25–0.75）', p0.pbo > 0.25 && p0.pbo < 0.75, p0.pbo.toFixed(2));
    check('8 段 → 70 种组合', p0.combos === 70);
    // 有一个候选真的更好（每天多 0.002）→ 它在样本外也排前面 → PBO 很低
    const real = noise.map((r, i) => (i === 3 ? r.map((x) => x + 0.002) : r));
    const p1 = T.cscvPbo(real, 8);
    check('有真实优势的候选：PBO 很低（< 0.1）', p1.pbo < 0.1, p1.pbo.toFixed(2));
    check('太短（< 20 天一段）不估计', T.cscvPbo(noise.map((r) => r.slice(0, 100)), 8) === null);
    check('段数随长度变：3 年 8 段，1 年 6 段，半年 4 段，太短 null', T.cscvBlocks(756) === 8 && T.cscvBlocks(252) === 6 && T.cscvBlocks(126) === 4 && T.cscvBlocks(50) === null);
  }

  /* ---- 结论规则 ---- */
  {
    check('PBO > 0.5 → 保持原参数', T.tuneVerdict({ pbo: 0.6, defaultSmooth: 1, bestSmooth: 2, recommendedIsDefault: false }).code === 'overfit');
    check('推荐的就是原参数 → 不改', T.tuneVerdict({ pbo: 0.1, defaultSmooth: 1, bestSmooth: 1, recommendedIsDefault: true }).code === 'keep');
    check('改进不够（< 0.1）→ 保持原参数', T.tuneVerdict({ pbo: 0.1, defaultSmooth: 1, bestSmooth: 1.05, recommendedIsDefault: false }).code === 'no-gain');
    check('PBO 0.25–0.5 → 谨慎', T.tuneVerdict({ pbo: 0.4, defaultSmooth: 1, bestSmooth: 1.5, recommendedIsDefault: false }).code === 'caution');
    check('PBO 低、改进够 → 可以考虑', T.tuneVerdict({ pbo: 0.1, defaultSmooth: 1, bestSmooth: 1.5, recommendedIsDefault: false }).adopt === true);
    check('估计不了 PBO → 不采用', T.tuneVerdict({ pbo: null, defaultSmooth: 1, bestSmooth: 1.5, recommendedIsDefault: false }).adopt === false);
  }

  /* ---- 完整任务（替身 LEAN） ---- */
  const pid = (await E.createProject({ name: '调参测试' })).projects[0].projectId;
  const CODE = 'from AlgorithmImports import *\nclass S(QCAlgorithm):\n    def initialize(self):\n        self.add_equity("SPY", Resolution.DAILY)\n        self.fast = int(self.get_parameter("fast", 20))\n        self.thr = self.get_parameter("thr", 0.5)\n';
  // 造一条 3 年的权益曲线：日收益 = 噪声 + 由参数决定的漂移（fast 在 16 附近最好，平滑的山丘）
  const T0 = Date.UTC(2018, 0, 2) / 1000;
  const equity = (seed, drift) => {
    const rnd = mulberry32(seed); let v = 1e6; const pts = [];
    for (let d = 0, k = 0; k < 760; d++) {
      const t = T0 + d * 86400 + 20 * 3600; const dow = new Date(t * 1000).getUTCDay();
      if (dow === 0 || dow === 6) continue;
      v *= 1 + drift + 0.01 * gauss(rnd); pts.push([t, v]); k++;
    }
    return { state: { Status: 'Completed' }, statistics: { 'Compounding Annual Return': '10%', 'Sharpe Ratio': String((drift / 0.01) * Math.sqrt(252)), Drawdown: '9%', 'Total Orders': '40' }, charts: { 'Strategy Equity': { series: { Equity: { values: pts } } } } };
  };
  const driftOf = (fast) => 0.0006 - 0.000004 * (fast - 16) ** 2;
  let seq = 0;
  const mkBt = async (meta = {}) => {
    const bid = (0xbeef00 + (seq += 1)).toString(16).padStart(16, '0');
    const dir = path.join(PD, String(pid), 'backtests', bid);
    await mkdir(path.join(dir, 'code'), { recursive: true }); await mkdir(path.join(dir, 'out'), { recursive: true });
    await writeFile(path.join(dir, 'code', 'main.py'), CODE);
    await writeFile(path.join(dir, 'meta.json'), JSON.stringify({ backtestId: bid, projectId: pid, name: `bt${seq}`, status: 'Completed.', progress: 1, created: new Date().toISOString(), role: 'candidate', period: 'dev', file: 'main.py', ...meta }));
    await writeFile(path.join(dir, 'out', `${bid}.json`), JSON.stringify(equity(1, driftOf(20))));
    return bid;
  };
  const jobs = []; const calls = [];
  E._hooks.hasLocalData = () => true;
  // 固定抽样种子：12 个随机候选里「平台」选法有约 1/8 的抽样会落在范围边上（这是它抗孤立尖峰的代价，
  // 见 lib/tune.mjs plateauScores），不固定的话这条测试大约每 3–8 次失败一次
  E._hooks.newTuneJobId = () => 'a1b2c3d4e5f60718';
  E._hooks.startTune = (p, b, j) => { jobs.push(E.runTuneJob(p, b, j)); };
  E._hooks.runLean = async (o) => {
    calls.push(o);
    const fast = Number(o.parameters.fast);
    // 同一个随机种子：候选之间只差漂移，噪声相同（和真实回测里「同一段行情」一样）
    const result = equity(1, driftOf(fast));
    await mkdir(o.outDir, { recursive: true });
    return { result, error: null };
  };

  const holdoutBt = await mkBt({ period: 'holdout' });
  const fullBt = await mkBt({ period: 'full' });
  check('验证期回测不能调', !(await E.runTune({ projectId: pid, backtestId: holdoutBt })).success);
  check('全期回测（含验证期）不能调', !(await E.runTune({ projectId: pid, backtestId: fullBt })).success);
  const bt = await mkBt();
  check('budget 超出范围被拒', !(await E.runTune({ projectId: pid, backtestId: bt, budget: 100 })).success);
  const r = await E.runTune({ projectId: pid, backtestId: bt, budget: 12 });
  check('开始调参', r.success && r.tuning.configs.length === 12, JSON.stringify(r.errors));
  check('同时再开一次被拒', !(await E.runTune({ projectId: pid, backtestId: bt })).success);
  await Promise.all(jobs);
  const out = await E.tuneRead({ projectId: pid, backtestId: bt });
  const R = out.tuning.result;
  check('原参数不重跑：LEAN 只跑了 11 次', calls.length === 11, String(calls.length));
  check('跑完：每个候选都有结果', out.tuning.status === 'done' && out.tuning.candidates.length === 12 && out.tuning.candidates.every((c) => c.status === 'ok'), out.tuning.error || '');
  check('推荐参数在真实最优（fast≈16）附近', Math.abs(R.recommended.values.fast - 16) <= 4, `推荐 fast=${R.recommended.values.fast}`);
  check('估计了 PBO（3 年 → 8 段）', R.pbo && R.pbo.S === 8 && R.pbo.pbo >= 0 && R.pbo.pbo <= 1);
  const trials = (await readFile(process.env.HELM_TRIALS_FILE, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  check('每个跑成功的候选都记进尝试次数（source = tune，开发期）', trials.length === 11 && trials.every((x) => x.source === 'tune' && x.period === 'dev' && x.window && Number.isFinite(x.sharpe)));
  check('候选的 LEAN 输出删掉了（只留指标和结论）', calls.every((c) => !c.outDir.includes('..')) && (await import('node:fs')).existsSync(path.join(PD, String(pid), 'backtests', bt, 'tuning', 'c1')) === false);
  check('结论里写了下一步', typeof R.next === 'string' && R.next.length > 10 && typeof R.verdict.text === 'string');
  const J = await import('../lib/journal.mjs');
  const jr = await J.loadJournal({ projectsDir: PD, trialsFile: process.env.HELM_TRIALS_FILE, holdoutRegistry: path.join(TMP, 'none.json') });
  check('想法记录：调参候选不单独列成「已删除的回测」，但计入试验次数', !jr.entries.some((e) => /^已删除的回测 tune/.test(e.what)) && jr.summary.tuneTrials === 11 && jr.summary.trials.total === 11);
} catch (e) {
  check('没有异常', false, e.stack);
}
await rm(TMP, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
