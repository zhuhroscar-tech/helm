// Helm 冒烟测试：npm test（全部，含一次真实 LEAN 回测，约半分钟）或 npm test -- --fast（只测统计，不跑 LEAN）。
// 全程在临时目录里进行：项目和尝试记录都指到临时目录，不会碰真实项目、真实的验证期记录和尝试记录。
import { isTradingDay } from '../lib/market-calendar.mjs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { leanSkip } from './lean-skip.mjs';

const FAST = process.argv.includes('--fast');
const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-smoke-'));
process.env.HELM_PROJECTS_DIR = path.join(TMP, 'projects');
process.env.HELM_TRIALS_FILE = path.join(TMP, 'trials.jsonl');
process.env.HELM_ALPACA_FILE = path.join(TMP, 'secrets', 'alpaca.json');

const S = await import('../lib/stats.mjs');
const E = await import('../lib/engine.mjs');
const PP = await import('../lib/paper.mjs');

let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failed += 1;
};

/* ---------- 统计检验（合成数据，确定性） ---------- */

// 生成 LEAN 结果的样子：每个日历日一个点（含周末，周末数值不变），时间戳是当天收盘（UTC 21:00，冬令时 16:00 ET）
function fakeResult({ years = 3, drift = 0, vol = 0.01, benchDrift = 0, seed = 1 }) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const eq = []; const bm = [];
  let e = 100000; let b = 100;
  const t0 = Date.UTC(2015, 0, 5, 21) / 1000; // 周一收盘
  for (let i = 0; i < years * 365; i++) {
    const t = t0 + i * 86400;
    const dow = new Date(t * 1000).getUTCDay();
    if (dow !== 0 && dow !== 6 && isTradingDay(new Date(t * 1000).toISOString().slice(0, 10))) { // 休市日数值也不变
      const common = vol * gauss();
      e *= 1 + drift + common;
      b *= 1 + benchDrift + common * 0.9 + vol * 0.3 * gauss();
    }
    eq.push([t, e, e, e, e]); bm.push([t, b]);
  }
  return { charts: { 'Strategy Equity': { series: { Equity: { values: eq } } }, Benchmark: { series: { Benchmark: { values: bm } } } } };
}

{
  const strong = S.validateResult(fakeResult({ drift: 0.0012, benchDrift: 0.0002 }), {}, [1]);
  check('强信号：四道关卡全部通过', strong.ok && strong.pass, strong.gates.map((g) => `${g.id}:${g.ok}`).join(' '));
  check('周末和休市日被剔除：3 年约 755 个交易日', Math.abs(strong.numbers.days - 755) < 10, `days=${strong.numbers.days}`);

  const noise = S.validateResult(fakeResult({ drift: 0, benchDrift: 0.0003, seed: 7 }), {}, [0.1]);
  check('没有优势的策略不能通过', noise.ok && !noise.pass);

  const short = S.validateResult(fakeResult({ years: 0.5, drift: 0.002 }), {}, [1]);
  check('不足 1 年：长度关卡不通过', short.ok && !short.gates.find((g) => g.id === 'len').ok);

  const r = fakeResult({ drift: 0.0006, benchDrift: 0.0002, seed: 3 });
  const few = S.validateResult(r, {}, [1.0, 0.8]).numbers.dsr;
  const many = S.validateResult(r, {}, Array.from({ length: 40 }, (_, i) => -1 + i * 0.06)).numbers.dsr;
  check('尝试越多，去膨胀夏普越低', few > many, `2 次=${few && few.toFixed(3)}，40 次=${many && many.toFixed(3)}`);

  const w = S.resultWindow(fakeResult({ years: 1 }));
  check('resultWindow 返回首尾交易日', Array.isArray(w) && w[0] === '2015-01-05', w && w.join(' → '));

  const ho = S.validateResult(r, { period: 'holdout', holdoutSeq: 3 }, [1]);
  check('第 3 次看验证期会有警告', ho.warnings.some((x) => x.includes('第 3 次')));
}


/* ---------- 模拟实盘：纯函数 ---------- */
{
  const code = 'class A(QCAlgorithm):\n    def initialize(self):\n        self.set_start_date(2020, 1, 1)\n        self.set_end_date(2021, 1, 1)  # dev\n';
  check('冻结代码：替换结束日期', PP.patchEndDate(code, '2026-11-06').includes('self.set_end_date(2026, 11, 6)') && !PP.patchEndDate(code, '2026-11-06').includes('2021, 1, 1'));
  const noEnd = 'class A(QCAlgorithm):\n    def initialize(self):\n        self.set_start_date(2020, 1, 1)\n        self.add_equity("SPY")\n';
  check('冻结代码：没有结束日期时插在开始日期后面', /set_start_date\(2020, 1, 1\)\n        self\.set_end_date\(2026, 11, 6\)/.test(PP.patchEndDate(noEnd, '2026-11-06')));
  const pos = PP.positionsFromOrders({ 1: { symbol: { value: 'SPY' }, quantity: 10, status: 3 }, 2: { symbol: { value: 'SPY' }, quantity: -10, status: 3 }, 3: { symbol: { value: 'QQQ' }, quantity: 5, status: 3 }, 4: { symbol: { value: 'QQQ' }, quantity: 3, status: 1 }, 5: { symbol: { value: 'TLT' }, quantity: 9, status: 7 } });
  check('从订单推出持仓（已成交 + 待执行，忽略无效单）', !pos.filled.SPY && pos.filled.QQQ === 5 && pos.pending.QQQ === 3 && !pos.filled.TLT && !pos.pending.TLT, JSON.stringify(pos));
  check('交易日：周六用周五的数据', PP.expectedDataDate(new Date('2026-11-07T18:00:00Z')) === '2026-11-06');
  check('交易日：美东当天过完（午夜）才算当天（LEAN 只跑到美东的昨天）', PP.expectedDataDate(new Date('2026-11-09T15:00:00Z')) === '2026-11-06' && PP.expectedDataDate(new Date('2026-11-09T22:30:00Z')) === '2026-11-06' && PP.expectedDataDate(new Date('2026-11-10T04:50:00Z')) === '2026-11-06' && PP.expectedDataDate(new Date('2026-11-10T05:10:00Z')) === '2026-11-09');
  // LEAN 的权益点：午夜点是前一天的收盘值，收盘点是当天的
  const T = (iso) => Date.parse(iso) / 1000;
  const dd = PP.daily([[T('2026-11-05T05:00:00Z'), 100], [T('2026-11-05T21:00:00Z'), 101], [T('2026-11-06T05:00:00Z'), 101], [T('2026-11-07T05:00:00Z'), 102], [T('2026-11-08T05:00:00Z'), 102]]);
  check('权益点归到正确的交易日（午夜点算前一天）', JSON.stringify(dd) === JSON.stringify([['2026-11-04', 100], ['2026-11-05', 101], ['2026-11-06', 102]]), JSON.stringify(dd));
  const cmt = 'class A(QCAlgorithm):\n    def initialize(self):\n        # self.set_end_date(2019, 1, 1)\n        self.set_start_date(2020, 1, 1)\n        self.set_end_date(datetime(2021, 1, 1)); self.set_cash(50000)\n';
  const pc = PP.patchEndDate(cmt, '2026-11-06');
  check('冻结代码：不改注释，保留同一行的其他语句', pc.includes('# self.set_end_date(2019, 1, 1)') && pc.includes('self.set_end_date(2026, 11, 6); self.set_cash(50000)'), pc.split('\n').slice(2, 5).join(' | '));
}

/* ---------- 想法检验：输入校验（Qlib 表达式最后会走 Python eval，必须严格） ---------- */
{
  const Q = await import('../lib/qlib.mjs');
  const good = ['Ref($close,21)/Ref($close,252)-1', '-1*Std($close/Ref($close,1)-1,60)', 'Rank(Mean($volume,20))', 'Corr($close,$volume,20)',
    'Std($close/Ref($close,1)-1-Cov($close/Ref($close,1)-1,$mkt,252)/Var($mkt,252)*$mkt,252)'];
  const bad = ['__import__(os)', '$close.x', 'open(1)', 'eval(1)', 'Mean($closex,5)', '"abc"', 'Ref($close,-5)x', 'a'.repeat(301), 'Std($mkt,252)', '$market'];
  check('表达式白名单：正常公式通过', good.every((e) => Q.checkExpr(e) === null), good.filter((e) => Q.checkExpr(e) !== null).join(' | '));
  check('表达式白名单：危险或未知的写法被拒', bad.every((e) => Q.checkExpr(e) !== null), bad.filter((e) => Q.checkExpr(e) === null).join(' | '));
  const f = (components, name = 'quiet_rev') => [{ name, label: 'x', components }];
  check('因子校验：表达式 + 基本面组合通过', Q.validateIdeaFactors(f([{ expr: 'Ref($close,21)/$close-1', weight: 1 }, { fundamental: 'f_ep', weight: -0.5 }])) === null);
  check('因子校验：不存在的基本面字段、零权重、expr 和 fundamental 同时写都被拒',
    Q.validateIdeaFactors(f([{ fundamental: 'F_NOPE' }])) !== null && Q.validateIdeaFactors(f([{ expr: '$close', weight: 0 }])) !== null
    && Q.validateIdeaFactors(f([{ expr: '$close', fundamental: 'F_EP' }])) !== null && Q.validateIdeaFactors(f([{ expr: '$close' }], 'Bad-Name')) !== null
    && Q.validateIdeaFactors(Array.from({ length: 6 }, (_, i) => ({ name: `f${i}`, components: [{ expr: '$close' }] }))) !== null);
  const rs = E.runSource('/x/helm/projects/1002/research/quant_runs/SP500_r1a2b3c4d5/');
  check('回测来源：从研究目录认出项目和研究', rs.projectId === 1002 && rs.jobId === 'r1a2b3c4d5', JSON.stringify(rs));
  const cs = await E.codeSources('from helm_data import HelmSignals, HelmUniverse\nself.sig = HelmSignals("no_such_signal_xyz")\nself.uni = HelmUniverse("sp500")');
  check('回测来源：解析代码里的 HelmSignals / HelmUniverse', cs && cs.signals[0].name === 'no_such_signal_xyz' && cs.signals[0].missing === true && cs.universes[0] === 'sp500', JSON.stringify(cs));
  check('回测来源：没有用 qlib 数据的代码没有来源', (await E.codeSources('self.add_equity("SPY")')) === null);
}

/* ---------- 引擎：真实 LEAN 回测 + 验证期和尝试记录 ---------- */

async function waitDone(projectId, backtestId, timeoutMs = 5 * 60 * 1000) {
  const t0 = Date.now();
  for (;;) {
    const r = await E.backtestsRead({ projectId, backtestId });
    const st = r.success && r.backtest.status;
    if (st && !/Queue|Progress/.test(st)) return r.backtest;
    if (Date.now() - t0 > timeoutMs) return r.success ? r.backtest : null;
    await new Promise((res) => setTimeout(res, 1000));
  }
}

if (!FAST) {
  const status = await E.engineStatus();
  if (!status.ok) {
    leanSkip(check, status);
  } else {
    const p = await E.createProject({ name: 'Smoke Test' });
    const pid = p.projects[0].projectId;
    check('建项目', p.success);

    const a = await E.createBacktest({ projectId: pid, name: '冒烟 A', role: 'debug', period: 'holdout' });
    const b = await E.createBacktest({ projectId: pid, name: '冒烟 B', role: 'debug', period: 'holdout' });
    check('验证期按次数编号', a.backtest && b.backtest && a.backtest.holdoutSeq === 1 && b.backtest.holdoutSeq === 2);

    const missing = await E.createBacktest({ projectId: pid, name: '缺文件', role: 'benchmark', period: 'dev', file: 'benchmark.py' });
    check('file 参数：文件不存在时给出明确错误', !missing.success && /benchmark\.py/.test(missing.errors.join('')));

    const ra = await waitDone(pid, a.backtest.backtestId);
    const rb = await waitDone(pid, b.backtest.backtestId);
    check('LEAN 回测跑完', ra && rb && /Completed/.test(ra.status) && /Completed/.test(rb.status), ra && `${ra.status} ${ra.error || ''}`);
    check('有夏普等统计', ra && Number.isFinite(ra.summary && ra.summary.sharpeRatio));

    const lines = async () => (await readFile(process.env.HELM_TRIALS_FILE, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
    check('跑完自动记入尝试记录', (await lines()) === 2, `${await lines()} 条`);

    await E.deleteBacktest({ projectId: pid, backtestId: a.backtest.backtestId });
    const v = await E.validateBacktest({ projectId: pid, backtestId: b.backtest.backtestId });
    check('删掉回测不会减少尝试次数', v.success && v.validation.numbers.trials === 2, v.success ? `trials=${v.validation.numbers.trials}` : v.errors.join(''));
    check('删掉回测不会抹掉验证期记录', (await E.holdoutViews(pid)) === 2);

    const re = await E.reconcileLedgers();
    check('补账可以重复执行（不重复记）', re.trialsAdded === 0 && re.holdoutBackfilled.length === 0, JSON.stringify(re));

    const m = await E.updateBacktest({ projectId: pid, backtestId: b.backtest.backtestId, role: 'main' });
    check('标 main 必须和统计检验结论一致', m.success === v.validation.pass, m.success ? '已标 main' : String(m.errors).slice(0, 60));

    await E.updateBacktest({ projectId: pid, backtestId: b.backtest.backtestId, period: 'full' });
    const v2 = await E.validateBacktest({ projectId: pid, backtestId: b.backtest.backtestId });
    check('改 period 标签不会减少尝试次数', v2.success && v2.validation.numbers.trials === 2, v2.success ? `trials=${v2.validation.numbers.trials}` : v2.errors.join(''));

    const c = await E.createBacktest({ projectId: pid, name: '冒烟 基准', role: 'benchmark', period: 'dev' });
    await waitDone(pid, c.backtest.backtestId);
    const toMain = await E.updateBacktest({ projectId: pid, backtestId: c.backtest.backtestId, role: 'candidate' });
    const toDebug = await E.updateBacktest({ projectId: pid, backtestId: c.backtest.backtestId, role: 'debug' });
    check('跑完的基准回测不能改成策略角色（可以改成调试）', !toMain.success && /基准/.test(toMain.errors.join('')) && toDebug.success);
    check('基准回测不记入尝试次数', (await lines()) === 2, `${await lines()} 条`);
    const twoStep = await E.updateBacktest({ projectId: pid, backtestId: c.backtest.backtestId, role: 'candidate' });
    const cleared = await E.updateBacktest({ projectId: pid, backtestId: c.backtest.backtestId, role: null });
    check('先改调试再转正、或清空角色，也绕不过去', !twoStep.success && !cleared.success);

    const d = await E.createBacktest({ projectId: pid, name: '冒烟 D', role: 'debug', period: 'dev' });
    await E.updateBacktest({ projectId: pid, backtestId: d.backtest.backtestId, role: 'control', name: '冒烟 D 改名' });
    const rd = await waitDone(pid, d.backtest.backtestId);
    check('运行中改的角色和名字，跑完后不会被覆盖', rd && rd.role === 'control' && rd.name === '冒烟 D 改名', rd && `${rd.role} ${rd.name}`);

    /* ---------- 模拟实盘：内部模拟（真实 LEAN）+ Alpaca（假服务器，不联网） ---------- */
    const sim = await PP.startSession({ projectId: pid, backtestId: d.backtest.backtestId, mode: 'sim', capital: 50000, wait: true });
    const s1 = sim.success && sim.session;
    check('内部模拟：开始并跑完第一次', sim.success && sim.firstRun && sim.firstRun.success && s1.frozenAt && s1.lastRun && s1.lastRun.ok, sim.success ? JSON.stringify(sim.firstRun).slice(0, 160) : sim.errors.join(''));
    const rs1 = s1 && await PP.readSession({ projectId: pid, sessionId: s1.sessionId });
    check('内部模拟：有目标持仓和前向曲线（从起始资金开始）', rs1 && rs1.latest && Object.keys(rs1.latest.holdings).length > 0 && rs1.latest.equity.length >= 1 && Math.abs(rs1.latest.equity[0][1] - 50000) < 1e-6, rs1 && JSON.stringify(rs1.latest && rs1.latest.holdings));
    const again = s1 && await PP.runSession({ projectId: pid, sessionId: s1.sessionId });
    check('同一个数据日不会重复跑', again && again.success && again.skipped);

    // 假的 Alpaca 模拟盘服务器
    const realFetch = globalThis.fetch;
    const posted = [];
    const SECRET = 'smoke-secret-should-never-be-written-elsewhere';
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      if (u.origin !== 'https://paper-api.alpaca.markets') throw new Error(`unexpected host ${u.origin}`);
      const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
      if (u.pathname === '/v2/account') return json({ id: 'x', status: 'ACTIVE', cash: '100000', equity: '100000', buying_power: '200000' });
      if (u.pathname === '/v2/positions') return json([{ symbol: 'AAPL', qty: '3', market_value: '600', current_price: '200', avg_entry_price: '190', side: 'long' }]);
      const view = (b) => ({ id: b.id, client_order_id: b.client_order_id, symbol: b.symbol, side: b.side, qty: b.qty, status: b.status, submitted_at: b.at });
      if (u.pathname === '/v2/orders' && init.method === 'POST') {
        const b = JSON.parse(init.body);
        if (posted.some((o) => o.client_order_id === b.client_order_id)) return json({ message: 'client_order_id must be unique' }, 422);
        Object.assign(b, { id: `o${posted.length + 1}`, status: 'accepted', at: new Date().toISOString() });
        posted.push(b);
        return json(view(b));
      }
      const del = u.pathname.match(/^\/v2\/orders\/(.+)$/);
      if (del && init.method === 'DELETE') { const o = posted.find((x) => x.id === decodeURIComponent(del[1])); if (o) o.status = 'canceled'; return new Response(null, { status: 204 }); }
      if (u.pathname === '/v2/orders') {
        const st = u.searchParams.get('status');
        return json(posted.filter((o) => st !== 'open' || o.status === 'accepted').map(view));
      }
      return json({ message: 'not found' }, 404);
    };
    try {
      const A = await import('../lib/alpaca.mjs');
      const gated = await PP.startSession({ projectId: pid, backtestId: d.backtest.backtestId, mode: 'alpaca' });
      check('不是通过检验的主版本不能开 Alpaca', !gated.success && /主版本/.test(gated.errors.join('')));
      // 测试里直接把 meta 标成通过检验的 main（真实流程要过 validate_backtest）
      const dmf = path.join(process.env.HELM_PROJECTS_DIR, String(pid), 'backtests', d.backtest.backtestId, 'meta.json');
      await (await import('node:fs/promises')).writeFile(dmf, JSON.stringify({ ...JSON.parse(await readFile(dmf, 'utf8')), role: 'main', mainRejected: null }));
      const noKey = await PP.startSession({ projectId: pid, backtestId: d.backtest.backtestId, mode: 'alpaca' });
      check('没连接 Alpaca 时不能选 Alpaca 模式', !noKey.success && /Alpaca/.test(noKey.errors.join('')));
      const sc = await A.saveCreds({ keyId: 'PKSMOKETEST1234', secret: SECRET });
      const alp = await PP.startSession({ projectId: pid, backtestId: d.backtest.backtestId, mode: 'alpaca', wait: true });
      const s2 = alp.success && alp.session;
      check('Alpaca 模式：开始后按目标持仓下单（不动不是这个模拟买的 AAPL，买入策略持仓）', sc.success && alp.success && alp.firstRun.success && !posted.some((o) => o.symbol === 'AAPL') && posted.some((o) => o.side === 'buy') && alp.otherPositions.some((p) => p.symbol === 'AAPL'), JSON.stringify(posted.map((o) => `${o.side} ${o.qty} ${o.symbol}`)) + (alp.success ? '' : alp.errors.join('')));
      check('Alpaca 订单的 client_order_id 带模拟 ID 和数据日', s2 && posted.length && posted.every((o) => o.client_order_id.startsWith(`${s2.sessionId}-`) && o.client_order_id.length <= 48));
      const busy = await PP.startSession({ projectId: pid, backtestId: d.backtest.backtestId, mode: 'alpaca' });
      check('一个 Alpaca 账户同时只能跟一个模拟', !busy.success && /只能跟一个/.test(busy.errors.join('')));
      const n = posted.length;
      const forced = s2 && await PP.runSession({ projectId: pid, sessionId: s2.sessionId, force: true });
      check('同一个数据日强制重跑也不会重复下单', forced && forced.success && posted.length === n, `下单 ${n} → ${posted.length}`);

      // 跨天：昨天收盘后的单还挂着没成交（持仓没变），今天再跑：先撤昨天的单，再按新计划下一次，不能翻倍
      const { writeFile: wf } = await import('node:fs/promises');
      const sdirP = path.join(process.env.HELM_PROJECTS_DIR, String(pid), 'paper', s2.sessionId);
      for (const o of posted) o.client_order_id = o.client_order_id.replace(/-(\d{8})-/, '-20000101-'); // 假装是更早一天下的
      await wf(path.join(sdirP, 'log.jsonl'), ''); // 清掉“今天已下单”的记录
      const cross = await PP.runSession({ projectId: pid, sessionId: s2.sessionId, force: true });
      const openBuys = posted.filter((o) => o.status === 'accepted' && o.side === 'buy');
      check('跨天：先撤掉还没成交的旧挂单再下单，买单不会翻倍', cross.success && posted.slice(0, n).every((o) => o.status === 'canceled') && openBuys.length === 1, `${cross.success ? '' : cross.errors.join('')} 挂着的买单 ${openBuys.length} 笔`);

      // 账户里有不是这个模拟下的挂单：不下单
      posted.push({ id: 'ext1', client_order_id: 'manual-order-1', symbol: 'TSLA', side: 'buy', qty: '1', status: 'accepted', at: new Date().toISOString() });
      for (const o of posted) if (o.status === 'accepted' && o.id !== 'ext1') o.client_order_id = o.client_order_id.replace(/-(\d{8})-/, '-20000102-');
      await wf(path.join(sdirP, 'log.jsonl'), '');
      const m0 = posted.length;
      const foreign = await PP.runSession({ projectId: pid, sessionId: s2.sessionId, force: true });
      check('账户里有别人的挂单时不动这个账户', !foreign.success && /不是这个模拟下的挂单/.test(foreign.errors.join('')) && posted.length === m0);
      posted.find((o) => o.id === 'ext1').status = 'canceled';

      // 权重超过 1（杠杆）或无效时，不能把持仓当成“不在目标里”全部卖掉
      const lev = A.planRebalance({ targets: { SPY: 1.5, QQQ: NaN }, equity: 100000, positions: [{ symbol: 'SPY', qty: 100, marketValue: 50000, currentPrice: 500, side: 'long' }, { symbol: 'QQQ', qty: 10, marketValue: 4000, currentPrice: 400, side: 'long' }], prices: { SPY: 500, QQQ: 400 } });
      check('杠杆目标按比例缩放、无效目标保持不动（不会全部卖出）', !lev.orders.some((o) => o.side === 'sell') && lev.orders.some((o) => o.symbol === 'SPY' && o.side === 'buy'), JSON.stringify(lev.orders.map((o) => `${o.side} ${o.qty} ${o.symbol}`)));
      const { execFileSync } = await import('node:child_process');
      let leaked = '';
      try { leaked = execFileSync('grep', ['-rl', SECRET, process.env.HELM_PROJECTS_DIR]).toString(); } catch { leaked = ''; }
      const st = await A.status();
      check('Alpaca secret 不会写进项目目录，也不会出现在状态里', !leaked && !JSON.stringify(st).includes(SECRET), leaked);
      const stop = s2 && await PP.stopSession({ projectId: pid, sessionId: s2.sessionId });
      const afterStop = s2 && await PP.runSession({ projectId: pid, sessionId: s2.sessionId, force: true });
      check('停止后不再运行', stop && stop.success && afterStop && !afterStop.success);
    } finally {
      globalThis.fetch = realFetch;
    }

    // agent 写的策略代码在 LEAN 里运行：不能读到 Alpaca 密钥文件（LEAN 跑在 macOS 沙盒里）
    const spy = `from AlgorithmImports import *
class Spy(QCAlgorithm):
    def initialize(self):
        self.set_start_date(2024, 1, 2)
        self.set_end_date(2024, 1, 10)
        self.add_equity("SPY", Resolution.DAILY)
        try:
            self.debug("LEAK:" + open(${JSON.stringify(process.env.HELM_ALPACA_FILE)}).read())
        except Exception as e:
            self.debug("BLOCKED:" + type(e).__name__)
    def on_data(self, data):
        pass
`;
    await E.writeProjectFile({ projectId: pid, name: 'main.py', content: spy });
    const sb = await E.createBacktest({ projectId: pid, name: '沙盒', role: 'debug', period: 'dev', skipLint: true }); // 故意跑危险代码验证沙盒，跳过代码检查
    const sbr = sb.backtest && await waitDone(pid, sb.backtest.backtestId);
    const lg = sbr && await E.logRead({ projectId: pid, backtestId: sb.backtest.backtestId, query: '' });
    const logText = JSON.stringify(lg || {});
    check('策略代码读不到 Alpaca 密钥（LEAN 在沙盒里运行）', /BLOCKED:PermissionError/.test(logText) && !logText.includes('smoke-secret'), (logText.match(/(LEAK|BLOCKED)[^"\\]{0,40}/) || [sbr && sbr.status])[0]);
  }
}

await rm(TMP, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
