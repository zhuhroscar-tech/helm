// 模拟实盘 Alpaca 安全规则测试：node test/paper-safety.test.mjs（加 --fast 只跑不需要 LEAN 的部分）
// 1) 只动这个模拟自己买的仓位，策略资金不含别的持仓；2) Alpaca 只能从通过检验的 main 回测开始；
// 3) 数据下载失败或过期的那天不下单；4) 不可交易的目标跳过；5) 老格式会话（没有账本，冻结样本）照样能读、能跑。
// 全程用假的 Alpaca 模拟盘（mock globalThis.fetch，不联网、不用真密钥），项目目录指到临时目录；真实项目只读。
import { mkdtemp, rm, mkdir, writeFile, readFile, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { leanSkip } from './lean-skip.mjs';

const FAST = process.argv.includes('--fast');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-safety-'));
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
const srv = { account: {}, positions: [], orders: [], posted: [], untradable: new Set() };
const reset = ({ cash = 100000, equity = 100000, positions = [], orders = [], untradable = [] } = {}) => {
  Object.assign(srv, { account: { id: 'acc', status: 'ACTIVE', cash: String(cash), equity: String(equity), buying_power: String(cash * 2) }, positions, orders, posted: [], untradable: new Set(untradable) });
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.origin !== 'https://paper-api.alpaca.markets') throw new Error(`unexpected host ${u.origin}`);
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
  const method = init.method || 'GET';
  if (u.pathname === '/v2/account') return json(srv.account);
  if (u.pathname === '/v2/positions') return json(srv.positions);
  if (u.pathname === '/v2/orders:by_client_order_id') {
    const o = srv.orders.find((x) => x.client_order_id === u.searchParams.get('client_order_id'));
    return o ? json(o) : json({ code: 40410000, message: 'order not found' }, 404);
  }
  const asset = u.pathname.match(/^\/v2\/assets\/(.+)$/);
  if (asset) { const s = decodeURIComponent(asset[1]); return json({ symbol: s, class: 'us_equity', status: 'active', tradable: !srv.untradable.has(s) }); }
  if (u.pathname === '/v2/orders' && method === 'POST') {
    const b = JSON.parse(init.body);
    srv.posted.push(b);
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
const position = (symbol, qty, price) => ({ symbol, qty: String(qty), market_value: String(qty * price), current_price: String(price), avg_entry_price: String(price), side: 'long' });
const filledOrder = (coid, symbol, side, qty, px) => ({ id: `f-${coid}`, client_order_id: coid, symbol, side, qty: String(qty), filled_qty: String(qty), filled_avg_price: String(px), status: 'filled', submitted_at: '2026-11-05T22:31:00Z' });

// 在临时项目目录里放一个 Alpaca 会话（只有 session.json 和 log），然后单独调用下单这一步（不需要 LEAN）
const PID = 1001;
async function mkSession(sid, { capital = 50000, log = [] } = {}) {
  const dir = path.join(process.env.HELM_PROJECTS_DIR, String(PID), 'paper', sid);
  await mkdir(dir, { recursive: true });
  const s = { sessionId: sid, projectId: PID, mode: 'alpaca', status: 'active', created: '2026-11-05T20:00:00.000Z', capital, entry: 'main.py', className: 'X' };
  await writeFile(path.join(dir, 'session.json'), JSON.stringify(s));
  await writeFile(path.join(dir, 'log.jsonl'), log.map((x) => JSON.stringify(x)).join('\n') + (log.length ? '\n' : ''));
  return { s, sf: path.join(dir, 'session.json'), dir };
}
const step = (ctx, sid, extra) => PP.alpacaStep({ A, s: ctx.s, pid: PID, sessionId: sid, sf: ctx.sf, dataDate: '2026-11-06', expected: '2026-11-06', fetchErrors: [], ...extra });
const ordersOf = (posted) => posted.map((o) => `${o.side} ${o.qty} ${o.symbol}`).join(', ');

try {
  await A.saveCreds({ keyId: 'PKSAFETYTEST1234', secret: 'safety-test-secret-not-real' });

  /* ---------- (a) 账户里有不是这个模拟买的 AAPL，策略目标是 0：不碰它，资金不含它 ---------- */
  {
    const sid = 'psafetya0001';
    const ctx = await mkSession(sid, { capital: 50000 });
    reset({ cash: 98000, equity: 100000, positions: [position('AAPL', 10, 200)] });
    const holdings = { SPY: { qty: 50, price: 500, weight: 0.5 }, AAPL: { qty: 0, price: 200, weight: 0 } };
    const r = await step(ctx, sid, { holdings, barDates: { SPY: '2026-11-06', AAPL: '2026-11-06' } });
    const a = r.alpaca;
    check('(a) 不是这个模拟买的 AAPL（目标 0）：不下任何 AAPL 单', !srv.posted.some((o) => o.symbol === 'AAPL') && !a.plan.orders.some((o) => o.symbol === 'AAPL'), ordersOf(srv.posted));
    check('(a) 策略资金 = 起始资金 50000，不含 AAPL 的 2000；AAPL 列为别人的持仓', a.capital === 50000 && a.planEquity === 50000 && a.foreign.some((p) => p.symbol === 'AAPL' && p.qty === 10) && a.own.length === 0, `capital=${a.capital} foreign=${JSON.stringify(a.foreign)}`);
    check('(a) 按 50000 的一半买 SPY：50 股', srv.posted.length === 1 && srv.posted[0].symbol === 'SPY' && srv.posted[0].side === 'buy' && srv.posted[0].qty === '50', ordersOf(srv.posted));
    check('(a) 快照里有账本（计入的订单为空）', a.ledger && a.ledger.netCash === 0 && Object.keys(a.ledger.qty).length === 0);
  }

  /* ---------- (b) 这个模拟买过的 QQQ，现在目标是 0：卖掉自己的 20 股（账户里另有用户的 10 股 QQQ 不动） ---------- */
  {
    const sid = 'psafetyb0001';
    const ctx = await mkSession(sid, { capital: 50000, log: [{ dataDate: '2026-11-05', runAt: '2026-11-05T22:30:00.000Z', holdings: {}, alpaca: { submitted: [{ symbol: 'QQQ', side: 'buy', qty: 20, clientOrderId: `${sid}-20261105-QQQ-buy` }], errors: [], plan: { orders: [{ symbol: 'QQQ', side: 'buy', qty: 20, estValue: 8000 }], targetValue: { QQQ: 8000 } } } }] });
    reset({ cash: 88000, equity: 100300, positions: [position('QQQ', 30, 410), position('AAPL', 10, 200)], orders: [filledOrder(`${sid}-20261105-QQQ-buy`, 'QQQ', 'buy', 20, 400), filledOrder('manual-1', 'QQQ', 'buy', 10, 380)] });
    const holdings = { SPY: { qty: 50, price: 500, weight: 0.5 } };
    const r = await step(ctx, sid, { holdings, barDates: { SPY: '2026-11-06' } });
    const a = r.alpaca;
    const sells = srv.posted.filter((o) => o.side === 'sell');
    check('(b) 自己买的 QQQ 目标变 0：卖出自己的 20 股（不卖用户的 10 股）', sells.length === 1 && sells[0].symbol === 'QQQ' && sells[0].qty === '20', ordersOf(srv.posted));
    check('(b) AAPL 仍然不碰', !srv.posted.some((o) => o.symbol === 'AAPL'));
    // 资金 = 50000 − 20×400（买入）+ 20×410（现值）= 50200
    check('(b) 策略资金 = 50000 − 8000 + 8200 = 50200；自己的仓位 QQQ 20 股，别人的 QQQ 10 股', a.capital === 50200 && a.own.length === 1 && a.own[0].qty === 20 && a.foreign.some((p) => p.symbol === 'QQQ' && p.qty === 10), `capital=${a.capital} own=${JSON.stringify(a.own)}`);
    check('(b) 买 SPY 按 50200 的一半：50 股', srv.posted.some((o) => o.symbol === 'SPY' && o.side === 'buy' && o.qty === '50'), ordersOf(srv.posted));
    check('(b) 账本记下计入的订单，手动单不算', a.ledger.counted.length === 1 && a.ledger.counted[0] === `${sid}-20261105-QQQ-buy` && a.ledger.qty.QQQ === 20 && a.ledger.netCash === -8000, JSON.stringify(a.ledger));
    // 账本增量：下一次只补新订单，已经计入的不会重复算
    const led2 = PP.ledgerFromOrders({ prev: a.ledger, sessionId: sid, orders: [filledOrder(`${sid}-20261105-QQQ-buy`, 'QQQ', 'buy', 20, 400), filledOrder(`${sid}-20261106-QQQ-sell`, 'QQQ', 'sell', 20, 412)] });
    check('(b) 账本增量：已计入的订单不重复，卖出后 QQQ 清零、现金 +8240', !led2.qty.QQQ && led2.netCash === 240 && led2.counted.length === 1, JSON.stringify(led2));
    const sb = PP.sessionBook({ capital: 50000, ledger: { qty: { QQQ: 20 }, netCash: -8000 }, positions: [{ symbol: 'QQQ', qty: 5, currentPrice: 410, marketValue: 2050, side: 'long' }] });
    check('(b) 用户手动卖掉一部分后：自己的股数不超过账户实际股数（5 股）', sb.own[0].qty === 5 && sb.foreign.length === 0 && sb.capital === 42000 + 2050, JSON.stringify(sb));
    let threw = '';
    try { PP.ledgerFromOrders({ sessionId: sid, orders: [{ ...filledOrder(`${sid}-x-SPY-buy`, 'SPY', 'buy', 1, 1), status: 'partially_filled' }] }); } catch (e) { threw = e.message; }
    check('(b) 自己还有没结束的订单时拒绝算账（不下单）', /没结束的订单/.test(threw), threw);
  }

  /* ---------- (c) Alpaca 只能从通过检验的 main 回测开始 ---------- */
  {
    check('(c) 关卡：用户选定的主版本放行（即使检验没全过）', PP.alpacaGateReason({ role: 'main', mainBy: 'user', mainRejected: ['去膨胀夏普：0.3'] }) === null && PP.alpacaGateReason({ role: 'debug', mainBy: 'user' }) !== null);
    check('(c) 关卡：main 且没有 mainRejected 才放行', PP.alpacaGateReason({ role: 'main', mainRejected: null }) === null && /主版本/.test(PP.alpacaGateReason({ role: 'candidate' })) && /没有通过统计检验/.test(PP.alpacaGateReason({ role: 'candidate', mainRejected: ['去膨胀夏普：0.3'] })));
    const bid = 'cafe0000cafe0000';
    const bd = path.join(process.env.HELM_PROJECTS_DIR, '1003', 'backtests', bid);
    await mkdir(path.join(bd, 'code'), { recursive: true });
    await writeFile(path.join(bd, 'code', 'main.py'), 'from AlgorithmImports import *\nclass G(QCAlgorithm):\n    def initialize(self):\n        self.set_start_date(2020, 1, 1)\n        self.add_equity("SPY")\n');
    await writeFile(path.join(bd, 'meta.json'), JSON.stringify({ backtestId: bid, name: '候选', status: 'Completed', role: 'candidate', mainRejected: ['去膨胀夏普：0.31，低于 0.95'] }));
    reset();
    const r = await PP.startSession({ projectId: 1003, backtestId: bid, mode: 'alpaca' });
    check('(c) 候选回测开 Alpaca：拒绝，并用中文说明原因', !r.success && /只能从主版本/.test(r.errors.join('')) && /去膨胀夏普/.test(r.errors.join('')), r.errors && r.errors.join(''));
    check('(c) 拒绝时一个请求都没有发、也没建会话', srv.posted.length === 0 && !existsSync(path.join(process.env.HELM_PROJECTS_DIR, '1003', 'paper')));
  }

  /* ---------- (d) 数据下载失败 / 日线过期：一笔都不下，下次数据正常时照常下单 ---------- */
  {
    const sid = 'psafetyd0001';
    const ctx = await mkSession(sid, { capital: 50000 });
    reset();
    const holdings = { SPY: { qty: 50, price: 500, weight: 0.5 } };
    const e1 = await step(ctx, sid, { holdings, fetchErrors: ['SPY: Yahoo 超时'], barDates: { SPY: '2026-11-06' } });
    const e2 = await step(ctx, sid, { holdings, barDates: { SPY: '2026-11-05' } });
    const e3 = await step(ctx, sid, { holdings, expected: '2026-11-09', barDates: { SPY: '2026-11-06' } });
    check('(d) 下载失败：不下单，原因写明', e1.skipReason && /数据更新失败/.test(e1.skipReason) && /SPY: Yahoo 超时/.test(e1.alpaca.note) && e1.alpaca.submitted.length === 0, e1.skipReason);
    check('(d) 某个目标的日线停在前一天：不下单', e2.skipReason && /SPY（2026-11-05）/.test(e2.skipReason), e2.skipReason);
    check('(d) 数据日早于应有的数据日：不下单', e3.skipReason && /还没有 2026-11-09/.test(e3.skipReason), e3.skipReason);
    check('(d) 三次跳过：0 个 POST', srv.posted.length === 0, ordersOf(srv.posted));
    const ok = await step(ctx, sid, { holdings, barDates: { SPY: '2026-11-06' } });
    check('(d) 数据正常的下一次：照常下单', !ok.skipReason && srv.posted.length === 1 && srv.posted[0].symbol === 'SPY', ordersOf(srv.posted));
  }

  /* ---------- (e) 不可交易的目标跳过，其他照常 ---------- */
  {
    const sid = 'psafetye0001';
    const ctx = await mkSession(sid, { capital: 50000 });
    reset({ untradable: ['XYZ'] });
    const holdings = { SPY: { qty: 40, price: 500, weight: 0.4 }, XYZ: { qty: 150, price: 100, weight: 0.3 } };
    const r = await step(ctx, sid, { holdings, barDates: { SPY: '2026-11-06', XYZ: '2026-11-06' } });
    const a = r.alpaca;
    check('(e) 不可交易的 XYZ 不下单，SPY 照常买', !srv.posted.some((o) => o.symbol === 'XYZ') && srv.posted.some((o) => o.symbol === 'SPY' && o.side === 'buy'), ordersOf(srv.posted));
    check('(e) 快照里有 untradable 和 skipped', a.untradable.some((x) => x.symbol === 'XYZ') && Array.isArray(a.skipped) && a.plan.skipped.some((x) => x.symbol === 'XYZ'), JSON.stringify(a.untradable));
  }

  /* ---------- (f) 老格式会话（没有账本）的冻结样本：照样读、照样算 ---------- */
  // 样本按一个真实老格式会话第一次运行之后的结构手写（所有 id 都是假的），
  // 直接写进临时目录，不读真实 projects/：真实会话之后怎么变（多了几天记录、有了账本）都不影响这个测试。
  const OLD_SID = 'pfixture0001';
  const copied = path.join(process.env.HELM_PROJECTS_DIR, '1002', 'paper', OLD_SID);
  {
    const oldHoldings = { EFA: { qty: 6994, filledQty: 6994, pendingQty: 0, price: 101.89, weight: 0.9492050231677963 } };
    const oldSession = {
      sessionId: OLD_SID, projectId: 1002, sourceBacktestId: '0000aaaa1111bbbb2222cccc3333dddd', sourceName: '候选 #4', name: 'GEM', mode: 'alpaca', status: 'active',
      created: '2026-11-08T20:19:23.939Z', entry: 'main.py', className: 'GlobalEquityMomentum', capital: 1000000, frozenAt: '2026-11-06',
      lastRun: { at: '2026-11-08T20:19:31.567Z', dataDate: '2026-11-06', ok: true }, lastAttemptAt: '2026-11-08T20:19:26.089Z', stoppedAt: null, runningSince: null,
    };
    // 老格式：alpaca 快照里没有 ledger / capital / own / foreign / planEquity
    const oldSnap = {
      runAt: '2026-11-08T20:19:31.567Z', dataDate: '2026-11-06', frozenAt: '2026-11-06', equity: 750753.1488, benchmarkEquity: 750753.1488, holdings: oldHoldings, fetchErrors: [],
      alpaca: {
        account: { id: 'acc-fixture', status: 'ACTIVE', currency: 'USD', cash: 1000000, equity: 1000000, buyingPower: 4000000, portfolioValue: 1000000, patternDayTrader: false, tradingBlocked: false },
        positions: [],
        plan: { orders: [{ symbol: 'EFA', side: 'buy', qty: 9315, estValue: 949105.35, reason: '新建仓 0.00% → 94.92%' }], skipped: [], targetValue: { EFA: 949205.02 }, notes: [] },
        cancelled: [],
        submitted: [{ symbol: 'EFA', side: 'buy', qty: 9315, id: 'order-fixture-0001', status: 'accepted', clientOrderId: `${OLD_SID}-20261106-EFA-buy` }],
        errors: [], note: null,
      },
    };
    const oldLatest = {
      summary: { dataDate: '2026-11-06', days: 0, return: 0, benchmarkReturn: 0, maxDrawdown: 0, equity: 1000000, invalidOrders: 0, alpacaEquity: 1000000 },
      equity: [['2026-11-06', 1000000]], benchmark: [['2026-11-06', 1000000]], holdings: oldHoldings, orders: [], dataDate: '2026-11-06', frozenAt: '2026-11-06',
    };
    await mkdir(copied, { recursive: true });
    await writeFile(path.join(copied, 'session.json'), JSON.stringify(oldSession, null, 1));
    await writeFile(path.join(copied, 'log.jsonl'), `${JSON.stringify(oldSnap)}\n`);
    await writeFile(path.join(copied, 'latest.json'), JSON.stringify(oldLatest, null, 1));
    const sid = 'pfixture0001';
    const rs = await PP.readSession({ projectId: 1002, sessionId: sid, remote: false });
    check('(f) 老格式会话的样本能读出来（1 条记录，没有账本）', rs.success && rs.session.mode === 'alpaca' && rs.log.length === 1 && !rs.log[0].alpaca.ledger, rs.success ? '' : rs.errors.join(''));
    // 假设周一开盘 EFA 那笔单以 102.10 全部成交，周一收盘 102.50；账户里只有这个模拟（和用户开始时一样）
    const s = rs.session; const snap = rs.log[0];
    const sub = snap.alpaca.submitted[0];
    const fill = 102.10; const close = 102.5;
    const cash = Math.round((s.capital - sub.qty * fill) * 100) / 100;
    reset({ cash, equity: cash + sub.qty * close, positions: [position('EFA', sub.qty, close)], orders: [{ ...filledOrder(sub.clientOrderId, 'EFA', 'buy', sub.qty, fill), id: sub.id, submitted_at: '2026-11-08T20:19:31Z' }] });
    const holdings = JSON.parse(JSON.stringify(rs.latest.holdings));
    for (const h of Object.values(holdings)) h.price = close;
    const r = await PP.alpacaStep({ A, s, pid: 1002, sessionId: sid, sf: path.join(copied, 'session.json'), dataDate: '2026-11-09', expected: '2026-11-09', fetchErrors: [], holdings, barDates: { EFA: '2026-11-09' } });
    const a = r.alpaca;
    const want = Math.round((s.capital - sub.qty * fill + sub.qty * close) * 100) / 100;
    check('(f) 老会话没有账本：从 Alpaca 订单补出 EFA 9315 股，资金 = 1,000,000 − 9315×102.10 + 9315×102.50', a && a.ledger.qty.EFA === sub.qty && a.capital === want && a.own[0].symbol === 'EFA' && a.foreign.length === 0, a ? `capital=${a.capital} want=${want} plan=${JSON.stringify(a.plan.orders)}` : JSON.stringify(r));
    check('(f) 只有这个模拟时，策略资金 = 账户净值（和改之前一样）', a && Math.abs(a.capital - (cash + sub.qty * close)) < 0.01, `capital=${a && a.capital} equity=${cash + sub.qty * close}`);
    console.log(`INFO  (f) 用户会话重启后的策略资金：$${a && a.capital}（起始 $${s.capital}，EFA ${sub.qty} 股，假设成交 ${fill}、收盘 ${close}）；计划：${a && JSON.stringify(a.plan.orders)}；跳过：${a && JSON.stringify(a.plan.skipped)}`);
  }

  /* ---------- (g) 运行失败也写进每日记录；同一个原因连续失败只记第一条；失败行不影响之后的下单 ---------- */
  {
    const sid = 'psafetyg0001';
    const prevRow = { runAt: '2026-11-05T22:30:00.000Z', dataDate: '2026-11-05', equity: 50000, holdings: {}, fetchErrors: [], alpaca: { submitted: [], errors: [], plan: { orders: [], targetValue: {} } } };
    const ctx = await mkSession(sid, { capital: 50000, log: [prevRow] });
    // 会话里没有 code/ 目录：读冻结代码这一步就失败，不会走到下载数据和 LEAN
    const r1 = await PP.runSession({ projectId: PID, sessionId: sid });
    const r2 = await PP.runSession({ projectId: PID, sessionId: sid });
    const rs = await PP.readSession({ projectId: PID, sessionId: sid, remote: false });
    const rows = rs.log.filter((x) => x.failed);
    check('(g) 运行失败：返回失败，lastRun 记下原因', !r1.success && !r2.success && rs.session.lastRun && rs.session.lastRun.ok === false && Boolean(rs.session.lastRun.error), JSON.stringify(rs.session.lastRun));
    check('(g) 失败写进 log.jsonl（failed: true + 原因 + 时间），没有净值和持仓', rows.length >= 1 && rows[0].failed === true && Boolean(rows[0].error) && Boolean(rows[0].runAt) && rows[0].equity === undefined && rows[0].alpaca === undefined, JSON.stringify(rows[0]));
    check('(g) 失败原因里没有绝对路径', !rows[0].error.includes(TMP) && !rs.session.lastRun.error.includes(TMP) && !r1.errors.join('').includes(TMP) && /projects\/1001\/paper/.test(rows[0].error), rows[0].error);
    check('(g) 同一个原因连续失败两次：只记第一条', rs.log.length === 2 && rows.length === 1, `log ${rs.log.length} 行`);
    check('(g) sameFailure：原因或数据日不同就是新的一条', PP.sameFailure({ failed: true, error: 'a', dataDate: null }, { error: 'a', dataDate: null }) && !PP.sameFailure({ failed: true, error: 'a' }, { error: 'b' }) && !PP.sameFailure({ failed: true, error: 'a', dataDate: '2026-11-05' }, { error: 'a', dataDate: '2026-11-06' }) && !PP.sameFailure({ error: 'a' }, { error: 'a' }) && !PP.sameFailure(undefined, { error: 'a' }));
    check('(g) 上一次调仓计划的查找跳过失败行', PP.prevPlanRun(rs.log, '2026-11-06') && PP.prevPlanRun(rs.log, '2026-11-06').dataDate === '2026-11-05');
    // 记录里夹着失败行，下一次下单照常（账本、“这个数据日下过单没有”都不受影响）
    reset({ cash: 50000, equity: 50000 });
    const ok = await step(ctx, sid, { holdings: { SPY: { qty: 40, price: 500, weight: 0.4 } }, barDates: { SPY: '2026-11-06' } });
    check('(g) 记录里有失败行：之后照常下单', !ok.skipReason && srv.posted.length === 1 && srv.posted[0].symbol === 'SPY' && ok.alpaca.submitted.length === 1, ordersOf(srv.posted));
  }

  /* ---------- (h) 休市日：应有的数据日是上一个交易日，不当成数据过期 ---------- */
  {
    // 2026-11-26 感恩节（周四）美东 18:00；11-27 半日市照常；2026-07-03 独立日补休（周五）
    const T = (iso) => new Date(iso);
    check('(h) 感恩节当天收盘后：应有数据日 = 周三 11-25（老口径是 11-26）', PP.expectedTradingDate(T('2026-11-26T23:00:00Z')) === '2026-11-25' && PP.expectedTradingDate(T('2026-11-27T06:00:00Z')) === '2026-11-25');
    check('(h) 感恩节次日当天仍是 11-25，过了美东午夜是 11-27', PP.expectedTradingDate(T('2026-11-27T23:00:00Z')) === '2026-11-25' && PP.expectedTradingDate(T('2026-11-28T06:00:00Z')) === '2026-11-27');
    check('(h) 长周末（周五休市）：周一收盘前应有数据日 = 周四', PP.expectedTradingDate(T('2026-07-06T14:00:00Z')) === '2026-07-02');
    check('(h) 普通交易日和老口径一致', ['2026-11-09T15:00:00Z', '2026-11-09T22:30:00Z', '2026-11-07T18:00:00Z'].every((x) => PP.expectedTradingDate(T(x)) === PP.expectedDataDate(T(x))));
    check('(h) 休市日数据停在上一个交易日：不算过期', PP.staleDataReason({ dataDate: '2026-11-25', expected: PP.expectedTradingDate(T('2026-11-26T23:00:00Z')), barDates: { SPY: '2026-11-25' } }) === null);
  }

  /* ---------- (i) 定时任务：这一轮要不要跑 ---------- */
  {
    const now = Date.parse('2026-11-10T23:00:00Z'); const want = '2026-11-10';
    const base = { status: 'active', lastRun: { ok: true, dataDate: '2026-11-09' }, lastAttemptAt: '2026-11-09T22:30:00Z', runningSince: null };
    const R = (patch, opt = {}) => PP.shouldRunNow({ ...base, ...patch }, { want, now, ...opt });
    check('(i) 新的数据日还没跑：跑', R({}) === true);
    check('(i) 这个数据日已经跑成功：不跑', R({ lastRun: { ok: true, dataDate: '2026-11-10' } }) === false);
    check('(i) 已停止 / 正在跑：不跑', R({ status: 'stopped' }) === false && R({}, { running: true }) === false);
    check('(i) 1 小时前刚失败：先不跑；3 小时后再跑', R({ lastRun: { ok: false, dataDate: '2026-11-09' }, lastAttemptAt: '2026-11-10T22:00:00Z' }) === false && R({ lastRun: { ok: false, dataDate: '2026-11-09' }, lastAttemptAt: '2026-11-10T19:30:00Z' }) === true);
    check('(i) 上次运行被打断（留着 runningSince）：不等 3 小时，马上补跑', R({ lastAttemptAt: '2026-11-10T22:50:00Z', runningSince: '2026-11-10T22:50:00Z' }) === true);
    check('(i) 被打断但这个数据日其实已经跑成功：不跑', R({ lastRun: { ok: true, dataDate: '2026-11-10' }, lastAttemptAt: '2026-11-10T22:50:00Z', runningSince: '2026-11-10T22:50:00Z' }) === false);
    check('(i) 从没跑过：跑', PP.shouldRunNow({ status: 'active', lastRun: null, lastAttemptAt: null }, { want, now }) === true);
  }

  /* ---------- 真实 LEAN：开始 / 运行的完整流程 ---------- */
  if (!FAST) {
    const E = await import('../lib/engine.mjs');
    const status = await E.engineStatus();
    if (!status.ok) {
      leanSkip(check, status);
    } else {
      // (f) 老格式样本用真实 LEAN 跑一次（证明重启后照样能跑）：需要策略代码，只读复制真实会话冻结的 code/（开始模拟时就定下、之后不会变）
      const realCode = path.join(ROOT, 'projects', '1002', 'paper', OLD_SID, 'code');
      if (!existsSync(path.join(realCode, 'main.py'))) {
        console.log(`SKIP  (f) 没有找到 projects/1002/paper/${OLD_SID}/code，跳过真实 LEAN 重跑`);
      } else {
        await cp(realCode, path.join(copied, 'code'), { recursive: true, filter: (f) => !f.includes('__pycache__') });
        const sub = JSON.parse((await readFile(path.join(copied, 'log.jsonl'), 'utf8')).split('\n')[0]).alpaca.submitted[0];
        reset({ cash: 48938.5, equity: 48938.5 + sub.qty * 102.5, positions: [position('EFA', sub.qty, 102.5)], orders: [{ ...filledOrder(sub.clientOrderId, 'EFA', 'buy', sub.qty, 102.1), id: sub.id }] });
        const rr = await PP.runSession({ projectId: 1002, sessionId: OLD_SID, force: true });
        const after = await PP.readSession({ projectId: 1002, sessionId: OLD_SID, remote: false });
        const last = after.log.at(-1);
        // 数据日和样本那天相同：不再下单；数据日更新了：可以小幅调仓，但已经成交的那笔 EFA 不会再买一遍
        const sameDay = last && last.dataDate === '2026-11-06';
        const noDouble = !srv.posted.some((o) => o.client_order_id === sub.clientOrderId) && !srv.posted.some((o) => o.symbol === 'EFA' && o.side === 'buy' && Number(o.qty) >= sub.qty / 2);
        check('(f) 老格式样本用真实 LEAN 重跑成功、没有重复下单', rr.success && noDouble && (!sameDay || srv.posted.length === 0), rr.success ? `${last && last.dataDate} ${ordersOf(srv.posted)} ${JSON.stringify(last && last.alpaca && last.alpaca.note)}` : rr.errors.join(''));
      }

      // 一个 Alpaca 账户同时只能跟一个模拟：先停掉上面这些测试会话
      for (const x of (await PP.listSessions()).sessions) if (x.status === 'active') await PP.stopSession({ projectId: x.projectId, sessionId: x.sessionId });
      const code = (extra = '') => `from AlgorithmImports import *
class SafetyTest(QCAlgorithm):
    def initialize(self):
        self.set_start_date(2024, 1, 2)
        self.set_end_date(2024, 2, 1)
        self.set_cash(100000)
        self.spy = self.add_equity("SPY", Resolution.DAILY).symbol
        self.qqq = self.add_equity("QQQ", Resolution.DAILY).symbol${extra}
    def on_data(self, data):
        if not self.portfolio.invested:
            self.set_holdings(self.spy, 0.5)
            self.set_holdings(self.qqq, 0.4)
`;
      const p = await E.createProject({ name: 'Safety Test', code: code() });
      const pid = p.projects[0].projectId;
      const b = await E.createBacktest({ projectId: pid, name: '安全测试', role: 'debug', period: 'dev' });
      const bid = b.backtest.backtestId;
      for (let t0 = Date.now(); Date.now() - t0 < 5 * 60 * 1000;) {
        const r = await E.backtestsRead({ projectId: pid, backtestId: bid });
        if (r.success && !/Queue|Progress/.test(r.backtest.status)) break;
        await new Promise((res) => setTimeout(res, 1000));
      }
      reset({ cash: 98000, equity: 100000, positions: [position('AAPL', 10, 200)] });
      const refused = await PP.startSession({ projectId: pid, backtestId: bid, mode: 'alpaca', wait: true });
      check('(c) 真实回测（role=debug）开 Alpaca：拒绝', !refused.success && /主版本/.test(refused.errors.join('')) && srv.posted.length === 0, refused.errors && refused.errors.join(''));
      const sim = await PP.startSession({ projectId: pid, backtestId: bid, mode: 'sim', capital: 50000, wait: true });
      check('(c) 同一个回测开内部模拟：照常允许', sim.success && sim.firstRun && sim.firstRun.success, sim.success ? JSON.stringify(sim.firstRun).slice(0, 200) : sim.errors.join(''));
      if (sim.success) await PP.stopSession({ projectId: pid, sessionId: sim.session.sessionId });

      // 测试里直接把 meta 标成通过检验的 main（真实流程要过 validate_backtest），再开 Alpaca：账户里的 AAPL 不动
      const mf = path.join(process.env.HELM_PROJECTS_DIR, String(pid), 'backtests', bid, 'meta.json');
      await writeFile(mf, JSON.stringify({ ...JSON.parse(await readFile(mf, 'utf8')), role: 'main', mainRejected: null }));
      const alp = await PP.startSession({ projectId: pid, backtestId: bid, mode: 'alpaca', wait: true });
      const s2 = alp.success && alp.session;
      check('(a) 开始时列出账户里的其他持仓（不会动），起始资金 = 净值 − 这些持仓市值', alp.success && alp.otherPositions.some((x) => x.symbol === 'AAPL') && s2.capital === 98000 && s2.otherPositionsAtStart.length === 1, alp.success ? JSON.stringify(alp.otherPositions) : alp.errors.join(''));
      check('(a) 真实 LEAN 第一次运行：买入策略持仓，不卖 AAPL', alp.success && alp.firstRun.success && srv.posted.some((o) => o.side === 'buy') && !srv.posted.some((o) => o.symbol === 'AAPL'), ordersOf(srv.posted) + (alp.success && !alp.firstRun.success ? alp.firstRun.errors.join('') : ''));
      if (s2) {
        const sd = path.join(process.env.HELM_PROJECTS_DIR, String(pid), 'paper', s2.sessionId);
        const r1 = await PP.readSession({ projectId: pid, sessionId: s2.sessionId, remote: false });
        const a1 = r1.log.at(-1).alpaca;
        check('(a) 快照：策略资金 98000、AAPL 在别人的持仓里', a1.capital === 98000 && a1.foreign.some((x) => x.symbol === 'AAPL') && r1.latest.summary.alpacaOwnEquity === 98000, `capital=${a1.capital}`);

        // (d) 端到端：代码里多一个下载不到的代码 → 下载失败 → 这天不下单、记录原因；去掉后再跑 → 照常下单
        const codeFile = path.join(sd, 'code', 'main.py');
        const good = await readFile(codeFile, 'utf8');
        await writeFile(codeFile, good.replace('.symbol\n    def on_data', '.symbol\n        self.unused = ["ZZQXQ1", "ZZQXQ2"]\n    def on_data'));
        srv.posted = [];
        const bad = await PP.runSession({ projectId: pid, sessionId: s2.sessionId, force: true });
        const rb = await PP.readSession({ projectId: pid, sessionId: s2.sessionId, remote: false });
        const lb = rb.log.at(-1);
        check('(d) 端到端：下载失败的那天 0 个 POST，快照写明跳过原因，lastRun 标为跳过（会重试）', bad.success && bad.skipDay && srv.posted.length === 0 && /数据更新失败/.test(lb.skipReason || '') && lb.alpaca.submitted.length === 0 && rb.session.lastRun.skipped && rb.session.lastRun.ok === false, bad.success ? `${bad.reason} posted=${srv.posted.length}` : bad.errors.join(''));
        await writeFile(codeFile, good);
        // 假装第一次的单是更早一个数据日下的（还没成交），并清掉“这个数据日已下单”的记录，模拟下一个交易日
        for (const o of srv.orders) o.client_order_id = o.client_order_id.replace(/-(\d{8})-/, '-20000101-');
        await writeFile(path.join(sd, 'log.jsonl'), '');
        const fresh = await PP.runSession({ projectId: pid, sessionId: s2.sessionId });
        check('(d) 端到端：数据正常的下一次（不加 force）照常下单，AAPL 仍不动', fresh.success && !fresh.skipped && srv.posted.length >= 1 && !srv.posted.some((o) => o.symbol === 'AAPL') && srv.posted.every((o) => o.client_order_id.startsWith(`${s2.sessionId}-`)), fresh.success ? ordersOf(srv.posted) : fresh.errors.join(''));
        await PP.stopSession({ projectId: pid, sessionId: s2.sessionId });
      }
    }
  }
} finally {
  globalThis.fetch = realFetch;
  await rm(TMP, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
