// 模拟实盘“执行偏差”测试：node test/paper-drift.test.mjs（加 --fast 只跑不需要 LEAN 的部分）
// 全程用假的 Alpaca 模拟盘（mock globalThis.fetch，不联网、不用真密钥），项目目录指到临时目录。
import { mkdtemp, rm, mkdir, writeFile, readFile, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const FAST = process.argv.includes('--fast');
const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-drift-'));
process.env.HELM_PROJECTS_DIR = path.join(TMP, 'projects');
process.env.HELM_TRIALS_FILE = path.join(TMP, 'trials.jsonl');
process.env.HELM_ALPACA_FILE = path.join(TMP, 'secrets', 'alpaca.json');

const PP = await import('../lib/paper.mjs');
const A = await import('../lib/alpaca.mjs');

let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failed += 1;
};

/* ---------- 假的 Alpaca 模拟盘服务器 ---------- */
const srv = { account: { id: 'acc', status: 'ACTIVE', cash: '100000', equity: '100000', buying_power: '200000' }, positions: [], orders: [], posted: [] };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.origin !== 'https://paper-api.alpaca.markets') throw new Error(`unexpected host ${u.origin}`);
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
  const method = init.method || 'GET';
  if (u.pathname === '/v2/account') return json(srv.account);
  if (u.pathname === '/v2/positions') return json(srv.positions);
  if (u.pathname === '/v2/orders' && method === 'POST') {
    const b = JSON.parse(init.body);
    srv.posted.push(JSON.parse(init.body));
    if (srv.orders.some((o) => o.client_order_id === b.client_order_id)) return json({ message: 'client_order_id must be unique' }, 422);
    const o = { ...b, id: `o${srv.orders.length + 1}`, status: 'accepted', filled_qty: '0', filled_avg_price: null, submitted_at: new Date().toISOString() };
    srv.orders.push(o);
    return json(o);
  }
  const del = u.pathname.match(/^\/v2\/orders\/(.+)$/);
  if (del && method === 'DELETE') { const o = srv.orders.find((x) => x.id === decodeURIComponent(del[1])); if (o) o.status = 'canceled'; return new Response(null, { status: 204 }); }
  if (u.pathname === '/v2/orders') {
    const st = u.searchParams.get('status');
    return json(srv.orders.filter((o) => st !== 'open' || ['accepted', 'new', 'partially_filled'].includes(o.status)));
  }
  return json({ message: 'not found' }, 404);
};
const order = (o) => ({ id: o.id, client_order_id: o.coid, symbol: o.symbol, side: o.side, qty: String(o.qty), filled_qty: String(o.filled || 0), filled_avg_price: o.px == null ? null : String(o.px), status: o.status, submitted_at: '2026-11-05T22:31:00Z' });
const position = (symbol, qty, price) => ({ symbol, qty: String(qty), market_value: String(qty * price), current_price: String(price), avg_entry_price: String(price), side: 'long' });

try {
  await A.saveCreds({ keyId: 'PKDRIFTTEST1234', secret: 'drift-test-secret-not-real' });

  /* ---------- 1. 手算对照：上一次的计划 + 假服务器上的成交结果 ---------- */
  {
    const pid = 1001; const sid = 'pdrifttest01';
    const sd = path.join(process.env.HELM_PROJECTS_DIR, String(pid), 'paper', sid);
    await mkdir(sd, { recursive: true });
    const prev = {
      runAt: '2026-11-05T22:30:00.000Z', dataDate: '2026-11-05', frozenAt: '2026-11-01', equity: 100000,
      holdings: { SPY: { qty: 100, price: 500, weight: 0.5 }, QQQ: { qty: 75, price: 400, weight: 0.3 }, TLT: { qty: 111, price: 90, weight: 0.1 }, GLD: { qty: 40, price: 200, weight: 0.08 } },
      alpaca: {
        account: { equity: 100000 }, planEquity: 100000,
        positions: [{ symbol: 'IWM', qty: 10, marketValue: 2000, currentPrice: 200, side: 'long' }],
        plan: {
          orders: [
            { symbol: 'IWM', side: 'sell', qty: 10, estValue: 2000 }, { symbol: 'SPY', side: 'buy', qty: 100, estValue: 50000 },
            { symbol: 'QQQ', side: 'buy', qty: 75, estValue: 30000 }, { symbol: 'TLT', side: 'buy', qty: 111, estValue: 9990 }, { symbol: 'GLD', side: 'buy', qty: 40, estValue: 8000 },
          ],
          targetValue: { SPY: 50000, QQQ: 30000, TLT: 10000, GLD: 8000, IWM: 0 }, skipped: [], notes: [],
        },
        submitted: [], errors: [{ symbol: 'GLD', side: 'buy', qty: 40, error: 'Alpaca 拒绝：403 insufficient buying power' }],
      },
    };
    await writeFile(path.join(sd, 'log.jsonl'), `${JSON.stringify({ ...prev, dataDate: '2026-11-04', alpaca: { ...prev.alpaca } })}\n${JSON.stringify(prev)}\n`);
    const t = `${sid}-20261105-`;
    srv.orders = [
      order({ id: 'a1', coid: `${t}IWM-sell`, symbol: 'IWM', side: 'sell', qty: 10, filled: 10, px: 199, status: 'filled' }),
      order({ id: 'a2', coid: `${t}SPY-buy`, symbol: 'SPY', side: 'buy', qty: 100, filled: 100, px: 500.25, status: 'filled' }),
      order({ id: 'a3', coid: `${t}QQQ-buy`, symbol: 'QQQ', side: 'buy', qty: 75, filled: 30, px: 399.8, status: 'expired' }),
      order({ id: 'a4', coid: `${t}TLT-buy`, symbol: 'TLT', side: 'buy', qty: 111, filled: 0, px: null, status: 'rejected' }),
      // 不该算进来的：前一个数据日的单、别的会话、手动单
      order({ id: 'x1', coid: `${sid}-20261104-SPY-buy`, symbol: 'SPY', side: 'buy', qty: 100, filled: 100, px: 600, status: 'filled' }),
      order({ id: 'x2', coid: 'pother000001-20261105-SPY-buy', symbol: 'SPY', side: 'buy', qty: 7, filled: 7, px: 650, status: 'filled' }),
      order({ id: 'x3', coid: 'manual-1', symbol: 'QQQ', side: 'buy', qty: 3, filled: 3, px: 1, status: 'filled' }),
    ];
    srv.positions = [position('SPY', 100, 501), position('QQQ', 30, 402), position('AAPL', 5, 200)];
    srv.account = { ...srv.account, equity: '100500' };
    const holdingsNow = { SPY: { price: 501 }, QQQ: { price: 402 }, TLT: { price: 91 }, GLD: { price: 205 } };
    const d = await PP.computeDrift({ A, pid, sessionId: sid, dataDate: '2026-11-06', holdings: holdingsNow });
    const row = (s) => d.rows && d.rows.find((x) => x.symbol === s);
    check('对比的是上一个数据日（2026-11-05）的计划', d.available && d.against === '2026-11-05', JSON.stringify(d).slice(0, 200));
    // SPY 买 100 股，参考价 500（计划用的收盘价），成交 500.25：+0.25/500 = +5.00 bps，$25.00
    check('全部成交：SPY 滑点 = +5.00 bps / $25.00（手算）', row('SPY').status === 'filled' && row('SPY').refPrice === 500 && row('SPY').fillPrice === 500.25 && row('SPY').slippageBps === 5 && row('SPY').slippageUsd === 25, JSON.stringify(row('SPY')));
    // IWM 卖 10 股，参考价 = 当时持仓现价 200（不在目标里，planRebalance 用持仓现价），成交 199：卖便宜 1 美元 = +50.00 bps，$10.00
    check('卖单：IWM 用当时持仓现价做参考，卖便宜 = +50.00 bps / $10.00', row('IWM').status === 'filled' && row('IWM').refSource === '当时持仓现价' && row('IWM').slippageBps === 50 && row('IWM').slippageUsd === 10 && row('IWM').targetWeight === 0, JSON.stringify(row('IWM')));
    // QQQ 只成交 30/75，均价 399.8：-5.00 bps / -$6.00（比计划好）；没成交 45 股，现价 402：机会成本 (402-400)*45 = $90
    check('部分成交：QQQ 标为部分成交，-5.00 bps / -$6.00，机会成本 $90', row('QQQ').status === 'partial' && row('QQQ').filledQty === 30 && row('QQQ').unfilledQty === 45 && row('QQQ').slippageBps === -5 && row('QQQ').slippageUsd === -6 && row('QQQ').opportunityUsd === 90, JSON.stringify(row('QQQ')));
    check('被拒：TLT（Alpaca 状态 rejected）标为被拒绝，机会成本 (91-90)*111 = $111', row('TLT').status === 'rejected' && row('TLT').filledQty === 0 && row('TLT').slippageBps === null && row('TLT').opportunityUsd === 111, JSON.stringify(row('TLT')));
    check('被拒：GLD（提交时就失败）标为被拒绝并带上错误信息，机会成本 (205-200)*40 = $200', row('GLD').status === 'rejected' && /insufficient/.test(row('GLD').error) && row('GLD').opportunityUsd === 200, JSON.stringify(row('GLD')));
    check('目标权重 vs 实际权重：SPY 0.5 → 50100/100500', row('SPY').targetWeight === 0.5 && row('SPY').actualWeight === Math.round((50100 / 100500) * 1e4) / 1e4 && row('TLT').actualWeight === 0, `${row('SPY').targetWeight} → ${row('SPY').actualWeight}`);
    const T = d.totals;
    // 执行成本 25 - 6 + 10 = 29；机会成本 90 + 111 + 200 = 401；合计 430 = 43.00 bps（占 100000）
    check('合计：执行成本 $29、机会成本 $401、执行偏差 $430 = 43.00 bps', T.executionCostUsd === 29 && T.opportunityCostUsd === 401 && T.shortfallUsd === 430 && T.shortfallBps === 43, JSON.stringify(T));
    check('合计：按成交额加权的平均滑点 29/64000 = 4.53 bps', T.avgSlippageBps === 4.53, String(T.avgSlippageBps));
    check('合计：没有全部成交的订单 3 笔（QQQ、TLT、GLD）', T.notFullyFilled === 3 && T.orders === 5);
    check('策略不要的持仓：列出 AAPL', d.untargeted.length === 1 && d.untargeted[0].symbol === 'AAPL' && d.untargeted[0].marketValue === 1000 && T.untargetedCount === 1, JSON.stringify(d.untargeted));
    check('别的数据日 / 别的会话 / 手动单不算进来', row('SPY').fillPrice === 500.25 && row('QQQ').filledQty === 30);

    const none = await PP.computeDrift({ A, pid, sessionId: sid, dataDate: '2026-11-04', holdings: {} });
    check('没有更早的下单记录时：说明还不能对比，不编数字', none.applicable && !none.available && /还没有上一次/.test(none.reason) && !none.rows);
    const pending = PP.driftFromData({ sessionId: sid, prev, orders: srv.orders.map((o) => ({ clientOrderId: o.client_order_id, qty: +o.qty, filledQty: 0, filledAvgPrice: null, status: 'accepted', symbol: o.symbol, side: o.side })), positions: [], account: { equity: 100000 } });
    check('还没开盘时：订单标为等待成交', pending.rows.find((x) => x.symbol === 'SPY').status === 'pending' && pending.totals.pending >= 3);
    check('内部模拟：执行偏差标为不适用', PP.DRIFT_SIM.applicable === false && /不计算/.test(PP.DRIFT_SIM.reason));
  }

  /* ---------- 2. 真实 LEAN：内部模拟不适用；Alpaca 模式算出偏差，且有没有偏差代码下的单完全一样 ---------- */
  if (!FAST) {
    const E = await import('../lib/engine.mjs');
    const status = await E.engineStatus();
    if (!status.ok) {
      check('本地 LEAN 引擎就绪', false, `缺少 ${status.missing.join(', ')}`);
    } else {
      const code = `from AlgorithmImports import *
class DriftTest(QCAlgorithm):
    def initialize(self):
        self.set_start_date(2024, 1, 2)
        self.set_end_date(2024, 2, 1)
        self.set_cash(100000)
        self.spy = self.add_equity("SPY", Resolution.DAILY).symbol
        self.qqq = self.add_equity("QQQ", Resolution.DAILY).symbol
    def on_data(self, data):
        if not self.portfolio.invested:
            self.set_holdings(self.spy, 0.5)
            self.set_holdings(self.qqq, 0.4)
`;
      const p = await E.createProject({ name: 'Drift Test', code });
      const pid = p.projects[0].projectId;
      const b = await E.createBacktest({ projectId: pid, name: '偏差测试', role: 'debug', period: 'dev' });
      const bid = b.backtest.backtestId;
      for (let t0 = Date.now(); Date.now() - t0 < 5 * 60 * 1000;) {
        const r = await E.backtestsRead({ projectId: pid, backtestId: bid });
        if (r.success && !/Queue|Progress/.test(r.backtest.status)) break;
        await new Promise((res) => setTimeout(res, 1000));
      }

      const sim = await PP.startSession({ projectId: pid, backtestId: bid, mode: 'sim', capital: 50000, wait: true });
      const rs = sim.success && await PP.readSession({ projectId: pid, sessionId: sim.session.sessionId, remote: false });
      check('内部模拟（真实 LEAN）：执行偏差不适用，不编数字', rs && rs.latest && rs.latest.drift && rs.latest.drift.applicable === false && !rs.latest.drift.rows && rs.log.at(-1).drift.applicable === false, sim.success ? JSON.stringify(rs && rs.latest && rs.latest.drift) : sim.errors.join(''));
      await PP.stopSession({ projectId: pid, sessionId: sim.session.sessionId });

      srv.orders = []; srv.posted = [];
      srv.account = { ...srv.account, equity: '100000', cash: '99400' };
      srv.positions = [position('AAPL', 3, 200)];
      // 测试里直接把 meta 标成通过检验的 main（Alpaca 只能从通过检验的主版本开始；真实流程要过 validate_backtest）
      const mf = path.join(process.env.HELM_PROJECTS_DIR, String(pid), 'backtests', bid, 'meta.json');
      await writeFile(mf, JSON.stringify({ ...JSON.parse(await readFile(mf, 'utf8')), role: 'main', mainRejected: null }));
      const alp = await PP.startSession({ projectId: pid, backtestId: bid, mode: 'alpaca', wait: true });
      const sid = alp.success && alp.session.sessionId;
      const sd = path.join(process.env.HELM_PROJECTS_DIR, String(pid), 'paper', String(sid));
      const r1 = sid && await PP.readSession({ projectId: pid, sessionId: sid, remote: false });
      const snap1 = r1 && r1.log.at(-1);
      check('Alpaca 第一次运行：下了单，执行偏差说明还没有可对比的记录', alp.success && alp.firstRun.success && srv.orders.length >= 2 && snap1.drift && snap1.drift.available === false, alp.success ? `${srv.orders.map((o) => `${o.side} ${o.qty} ${o.symbol}`).join(', ')} ${JSON.stringify(snap1 && snap1.drift)}` : alp.errors.join(''));

      // 假装这些单是更早一个数据日下的，并且第二天开盘成交了：SPY 全部成交（贵 0.1%），QQQ 只成交一半，AAPL 卖单被拒
      const oldDate = '2000-01-03'; const oldTag = '20000103';
      const lines = (await readFile(path.join(sd, 'log.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
      for (const x of lines) {
        x.dataDate = oldDate;
        for (const s of x.alpaca.submitted) s.clientOrderId = s.clientOrderId.replace(/-(\d{8})-/, `-${oldTag}-`);
      }
      await writeFile(path.join(sd, 'log.jsonl'), `${lines.map((x) => JSON.stringify(x)).join('\n')}\n`);
      const ref = (s) => lines[0].holdings[s].price;
      const fills = {};
      for (const o of srv.orders) {
        o.client_order_id = o.client_order_id.replace(/-(\d{8})-/, `-${oldTag}-`);
        if (o.symbol === 'AAPL') { o.status = 'rejected'; continue; }
        const q = Number(o.qty); const filled = o.symbol === 'QQQ' ? Math.floor(q / 2) : q;
        const px = Math.round(ref(o.symbol) * 1.001 * 100) / 100;
        Object.assign(o, { status: filled === q ? 'filled' : 'expired', filled_qty: String(filled), filled_avg_price: String(px) });
        fills[o.symbol] = { q, filled, px };
      }
      srv.positions = [position('AAPL', 3, 200), ...Object.entries(fills).map(([s, f]) => position(s, f.filled, f.px))];
      const invested = Object.values(fills).reduce((a, f) => a + f.filled * f.px, 0);
      srv.account = { ...srv.account, equity: '100000', cash: String(Math.round((100000 - 600 - invested) * 100) / 100) };

      // 同一个起点跑两次：一次关掉偏差代码，一次打开，对比 POST 出去的订单
      const backup = path.join(TMP, 'backup-session');
      await cp(sd, backup, { recursive: true });
      const srvState = JSON.stringify({ orders: srv.orders, positions: srv.positions, account: srv.account });
      const runOnce = async (driftEnv) => {
        await rm(sd, { recursive: true, force: true });
        await cp(backup, sd, { recursive: true });
        Object.assign(srv, JSON.parse(srvState));
        srv.posted = [];
        if (driftEnv == null) delete process.env.HELM_PAPER_DRIFT; else process.env.HELM_PAPER_DRIFT = driftEnv;
        const r = await PP.runSession({ projectId: pid, sessionId: sid, force: true });
        delete process.env.HELM_PAPER_DRIFT;
        const rr = await PP.readSession({ projectId: pid, sessionId: sid, remote: false });
        return { r, posted: srv.posted.slice(), snap: rr.log.at(-1), latest: rr.latest };
      };
      const off = await runOnce('0');
      const on = await runOnce(null);
      check('第二天运行成功（关 / 开偏差代码各一次）', off.r.success && on.r.success, `${off.r.success ? '' : off.r.errors} ${on.r.success ? '' : on.r.errors}`);
      check('下单完全一样：有没有偏差代码，POST 的订单逐字段相同', off.posted.length > 0 && JSON.stringify(off.posted) === JSON.stringify(on.posted), `关：${JSON.stringify(off.posted)} 开：${JSON.stringify(on.posted)}`);
      check('关掉时快照里没有 drift，打开时有', !off.snap.drift && on.snap.drift && on.snap.drift.available === true && on.latest.drift && on.latest.drift.against === oldDate, JSON.stringify(on.snap.drift).slice(0, 300));
      const D = on.snap.drift;
      const spy = D && D.rows.find((x) => x.symbol === 'SPY');
      const qqq = D && D.rows.find((x) => x.symbol === 'QQQ');
      const aapl = D && D.rows.find((x) => x.symbol === 'AAPL');
      const bps = (f, r) => Math.round(((f - r) / r) * 1e4 * 100) / 100;
      check('真实计划价：SPY 全部成交，滑点 = (成交价-计划收盘价)/计划收盘价', spy && spy.status === 'filled' && spy.refPrice === Math.round(ref('SPY') * 1e4) / 1e4 && spy.slippageBps === bps(fills.SPY.px, ref('SPY')), JSON.stringify(spy));
      check('真实计划价：QQQ 部分成交；AAPL 不是这个模拟买的，没有下过单，仍列为策略不要的持仓', qqq && qqq.status === 'partial' && !aapl && D.untargeted.some((x) => x.symbol === 'AAPL') && D.totals.notFullyFilled === 1, JSON.stringify(D && D.totals));
      await PP.stopSession({ projectId: pid, sessionId: sid });
    }
  }
} finally {
  globalThis.fetch = realFetch;
  await rm(TMP, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
