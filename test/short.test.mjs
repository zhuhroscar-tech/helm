// 做空支持：node test/short.test.mjs
// 1) 回测：engine/test_helm_short.py（融券费按空头市值 × 费率 × 自然日/360 扣现金）+ 代码检查提醒（做空没算融券费、现金账户做空）
// 2) Alpaca 调仓计划：开空 / 加空 / 减空 / 平空、翻仓只先平仓、总仓位按 Σ|权重| 缩放、先降风险后开仓
// 3) 下单：账户不能做空时跳过空单、借不到（不是 easy_to_borrow）的跳过、clientOrderId 带 short / cover
// 4) 模拟实盘：自己的空头仓位和资金算对；策略要做空但账户不能空时一笔都不下
// 全程用假的 Alpaca 模拟盘（mock fetch，不联网），项目目录指到临时目录。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-short-'));
process.env.HELM_PROJECTS_DIR = path.join(TMP, 'projects');
process.env.HELM_TRIALS_FILE = path.join(TMP, 'trials.jsonl');
process.env.HELM_ALPACA_FILE = path.join(TMP, 'secrets', 'alpaca.json');
const A = await import('../lib/alpaca.mjs');
const PP = await import('../lib/paper.mjs');
const E = await import('../lib/engine.mjs');

let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); if (!cond) failed += 1; };
const pos = (symbol, qty, price) => ({ symbol, qty, currentPrice: price, marketValue: qty * price, side: qty < 0 ? 'short' : 'long' });
const find = (p, sym, intent) => p.orders.find((o) => o.symbol === sym && (intent ? (o.intent || o.side) === intent : true));

/* ---------- 1) 回测：融券费 + 代码检查 ---------- */
{
  const py = existsSync(path.join(ROOT, 'engine/.venv/bin/python')) ? path.join(ROOT, 'engine/.venv/bin/python') : 'python3';
  const r = spawnSync(py, ['-I', path.join(ROOT, 'engine', 'test_helm_short.py')], { encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  check('engine/test_helm_short.py 全部通过', r.status === 0 && /ALL PASSED/.test(out), out.split('\n').filter((l) => /Error|assert/i.test(l)).join(' | '));

  const base = (extra = '', init = '') => `from AlgorithmImports import *
from helm_data import HelmShortCost

class LongShort(QCAlgorithm):
    def initialize(self):
        self.set_start_date(2015, 1, 1)
        self.set_cash(100000)
        self.set_benchmark("SPY")
${init}        self.a = self.add_equity("SPY", Resolution.DAILY).symbol
        self.b = self.add_equity("IWM", Resolution.DAILY).symbol
${extra}
    def on_data(self, data):
        self.set_holdings(self.a, 0.5)
        self.set_holdings(self.b, -0.5)
`;
  const codes = (L) => L.warnings.map((w) => w.code);
  const withCost = base('        self.borrow = HelmShortCost(rate=0.005)\n', '        self.set_brokerage_model(BrokerageName.INTERACTIVE_BROKERS_BROKERAGE, AccountType.MARGIN)\n');
  const L1 = await E.lintSources([{ name: 'main.py', content: withCost }]);
  check('做空 + HelmShortCost + 保证金账户：没有 error，也没有做空提醒', !L1.errors.length && !codes(L1).some((c) => c.startsWith('short-')), JSON.stringify([L1.errors, codes(L1)]));
  const L2 = await E.lintSources([{ name: 'main.py', content: base() }]);
  check('做空但没用 HelmShortCost：提醒 short-no-borrow-cost', codes(L2).includes('short-no-borrow-cost'));
  const L3 = await E.lintSources([{ name: 'main.py', content: base('        self.borrow = HelmShortCost()\n', '        self.set_brokerage_model(BrokerageName.INTERACTIVE_BROKERS_BROKERAGE, AccountType.CASH)\n') }]);
  check('现金账户做空：提醒 short-cash-account', codes(L3).includes('short-cash-account'));
  const L4 = await E.lintSources([{ name: 'main.py', content: base().replace('self.set_holdings(self.b, -0.5)', 'self.market_order(self.b, -self.n)').replace('self.set_holdings(self.a, 0.5)', 'self.n = 10') }]);
  check('下单数量取负（market_order(x, -n)）也算做空', codes(L4).includes('short-no-borrow-cost'));
  const L5 = await E.lintSources([{ name: 'main.py', content: base().replace('self.set_holdings(self.b, -0.5)', 'self.set_holdings(self.b, 0.4)') }]);
  check('纯多头：没有做空提醒', !codes(L5).some((c) => c.startsWith('short-')));
  const L6 = await E.lintSources([{ name: 'main.py', content: withCost.replace('HelmShortCost(rate=0.005)', 'HelmShortCost(rate=0.005)\n        x = self.borrow._last') }]);
  check('读 HelmShortCost 的下划线属性被拦', L6.errors.length > 0);
}

/* ---------- 2) 调仓计划 ---------- */
{
  const p = A.planRebalance({ targets: { SPY: 0.5, IWM: -0.3 }, equity: 100000, positions: [], prices: { SPY: 500, IWM: 200 }, opts: { allowShort: true, maxGross: 1.6 } });
  check('开空：IWM 卖出 150 股（intent=short）', find(p, 'IWM', 'short')?.qty === 150 && find(p, 'IWM').side === 'sell', JSON.stringify(p.orders));
  check('多头腿照常：SPY 买 100 股', find(p, 'SPY', 'buy')?.qty === 100);
  check('顺序：先开空、再买多（开空所得算进可用现金）', p.orders.map((o) => o.intent || o.side).join() === 'short,buy');

  const off = A.planRebalance({ targets: { SPY: 0.5, IWM: -0.3 }, equity: 100000, positions: [], prices: { SPY: 500, IWM: 200 } });
  check('没允许做空：负权重跳过，不下空单（原来的行为）', !find(off, 'IWM') && /做空/.test(off.skipped.find((s) => s.symbol === 'IWM')?.reason || ''));

  const p2 = A.planRebalance({ targets: { IWM: -0.2, TLT: 0 }, equity: 100000, positions: [pos('IWM', -150, 200), pos('TLT', -50, 100), pos('XLE', -10, 80)], prices: { IWM: 200, TLT: 100, XLE: 80 }, opts: { allowShort: true } });
  check('减空：IWM -150 → -100 股，买入 50 股平空（intent=cover）', find(p2, 'IWM', 'cover')?.qty === 50 && find(p2, 'IWM').side === 'buy', JSON.stringify(p2.orders));
  check('目标 0 / 不在目标里的空头：全部平空', find(p2, 'TLT', 'cover')?.qty === 50 && find(p2, 'XLE', 'cover')?.qty === 10);

  const p3 = A.planRebalance({ targets: { IWM: -0.4 }, equity: 100000, positions: [pos('IWM', -100, 200)], prices: { IWM: 200 }, opts: { allowShort: true } });
  check('加空：-100 → -200 股，再卖 100 股', find(p3, 'IWM', 'short')?.qty === 100);

  const p4 = A.planRebalance({ targets: { AAPL: -0.2, MSFT: 0.2 }, equity: 100000, positions: [pos('AAPL', 50, 200), pos('MSFT', -30, 400)], prices: { AAPL: 200, MSFT: 400 }, opts: { allowShort: true } });
  check('多翻空：这次只卖掉 50 股多头，不开空', p4.orders.filter((o) => o.symbol === 'AAPL').length === 1 && find(p4, 'AAPL', 'sell')?.qty === 50);
  check('空翻多：这次只买 30 股平空，不买多', p4.orders.filter((o) => o.symbol === 'MSFT').length === 1 && find(p4, 'MSFT', 'cover')?.qty === 30);
  check('翻仓写了说明', p4.notes.filter((n) => /下次运行再开/.test(n)).length === 2);

  const p5 = A.planRebalance({ targets: { A1: 1.0, B1: -1.0 }, equity: 100000, positions: [], prices: { A1: 100, B1: 100 }, opts: { allowShort: true, maxGross: 1.6 } });
  check('总仓位按 Σ|权重| 缩放：200% → 160%（各 80%）', find(p5, 'A1', 'buy')?.qty === 800 && find(p5, 'B1', 'short')?.qty === 800 && p5.notes.some((n) => /缩放/.test(n)), JSON.stringify(p5.orders));

  const p6 = A.planRebalance({ targets: { SPY: 0 }, equity: 100000, positions: [pos('SPY', 10, 500), pos('IWM', -20, 200)], prices: { SPY: 500, IWM: 200, QQQ: 400 }, opts: { allowShort: true } });
  check('顺序：卖多 → 平空', p6.orders.map((o) => o.intent || o.side).join() === 'sell,cover');
  const p7 = A.planRebalance({ targets: {}, equity: 100000, positions: [pos('IWM', -20, 200)], prices: { IWM: 200 } });
  check('没允许做空：已有空头持仓不动（原来的行为）', p7.orders.length === 0 && /空头/.test(p7.skipped[0]?.reason || ''));
}

/* ---------- 假的 Alpaca 模拟盘 ---------- */
const srv = { account: {}, positions: [], orders: [], posted: [], assets: {} };
const reset = ({ cash = 100000, equity = 100000, shorting = true, positions = [], orders = [], assets = {} } = {}) => {
  Object.assign(srv, { account: { id: 'acc', status: 'ACTIVE', cash: String(cash), equity: String(equity), buying_power: String(cash * 2), multiplier: shorting ? '2' : '1', shorting_enabled: shorting }, positions, orders, posted: [], assets });
};
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
  if (asset) { const s = decodeURIComponent(asset[1]); return json({ symbol: s, class: 'us_equity', status: 'active', tradable: true, shortable: true, easy_to_borrow: true, ...(srv.assets[s] || {}) }); }
  if (u.pathname === '/v2/orders' && method === 'POST') {
    const b = JSON.parse(init.body);
    srv.posted.push(b);
    const o = { ...b, id: `o${srv.orders.length + 1}`, status: 'accepted', filled_qty: '0', filled_avg_price: null, submitted_at: new Date().toISOString() };
    srv.orders.push(o);
    return json(o);
  }
  if (u.pathname === '/v2/orders') { const st = u.searchParams.get('status'); return json(srv.orders.filter((o) => st !== 'open' || ['accepted', 'new', 'partially_filled'].includes(o.status))); }
  return json({ message: 'not found' }, 404);
};
const apos = (symbol, qty, price) => ({ symbol, qty: String(qty), market_value: String(qty * price), current_price: String(price), avg_entry_price: String(price), side: qty < 0 ? 'short' : 'long' });
const filled = (coid, symbol, side, qty, px) => ({ id: `f-${coid}`, client_order_id: coid, symbol, side, qty: String(qty), filled_qty: String(qty), filled_avg_price: String(px), status: 'filled', submitted_at: '2026-11-05T22:31:00Z' });

try {
  await A.saveCreds({ keyId: 'PKSHORTTEST12345', secret: 'short-test-secret-not-real' });

  /* ---------- 3) 下单 ---------- */
  {
    const plan = { orders: [
      { symbol: 'SPY', side: 'buy', qty: 10, estValue: 5000 },
      { symbol: 'IWM', side: 'sell', intent: 'short', qty: 5, estValue: 1000 },
      { symbol: 'TLT', side: 'buy', intent: 'cover', qty: 3, estValue: 300 },
      { symbol: 'QQQ', side: 'sell', qty: 2, estValue: 800 },
    ] };
    reset();
    const r = await A.executePlan(plan, { tag: 'st1' });
    check('下单顺序：卖多 → 平空 → 开空 → 买多', srv.posted.map((o) => `${o.side}:${o.symbol}`).join() === 'sell:QQQ,buy:TLT,sell:IWM,buy:SPY', srv.posted.map((o) => `${o.side}:${o.symbol}`).join());
    check('clientOrderId 带 short / cover（和普通买卖不重名）', srv.posted.find((o) => o.symbol === 'IWM').client_order_id === 'st1-IWM-short' && srv.posted.find((o) => o.symbol === 'TLT').client_order_id === 'st1-TLT-cover' && r.submitted.find((s) => s.symbol === 'IWM').intent === 'short');

    reset({ shorting: false });
    const r2 = await A.executePlan(plan, { tag: 'st2' });
    check('账户不能做空：空单跳过并说明，别的照常', !srv.posted.some((o) => o.symbol === 'IWM') && /不能做空/.test(r2.skipped.find((s) => s.symbol === 'IWM')?.reason || '') && srv.posted.length === 3);

    reset({ assets: { IWM: { easy_to_borrow: false } } });
    const r3 = await A.executePlan(plan, { tag: 'st3' });
    check('不是 easy_to_borrow：空单跳过并说明', !srv.posted.some((o) => o.symbol === 'IWM') && /easy_to_borrow/.test(r3.skipped[0]?.reason || ''));
    reset({ assets: { IWM: { shortable: false } } });
    const r4 = await A.executePlan(plan, { tag: 'st4' });
    check('shortable=false：空单跳过', !srv.posted.some((o) => o.symbol === 'IWM') && /shortable/.test(r4.skipped[0]?.reason || ''));
    const acct = await A.getAccount();
    check('账户摘要有 shortingEnabled', acct.shortingEnabled === true);
  }

  /* ---------- 4) 模拟实盘 ---------- */
  const PID = 1003;
  const mkSession = async (sid, { capital = 50000, log = [] } = {}) => {
    const dir = path.join(process.env.HELM_PROJECTS_DIR, String(PID), 'paper', sid);
    await mkdir(dir, { recursive: true });
    const s = { sessionId: sid, projectId: PID, mode: 'alpaca', status: 'active', created: '2026-11-05T20:00:00.000Z', capital, entry: 'main.py', className: 'X' };
    await writeFile(path.join(dir, 'session.json'), JSON.stringify(s));
    await writeFile(path.join(dir, 'log.jsonl'), log.map((x) => JSON.stringify(x)).join('\n') + (log.length ? '\n' : ''));
    return { s, sf: path.join(dir, 'session.json') };
  };
  const step = (ctx, sid, extra) => PP.alpacaStep({ A, s: ctx.s, pid: PID, sessionId: sid, sf: ctx.sf, dataDate: '2026-11-06', expected: '2026-11-06', fetchErrors: [], ...extra });
  {
    const sb = PP.sessionBook({ capital: 50000, ledger: { qty: { IWM: -100 }, netCash: 20000 }, positions: [{ symbol: 'IWM', qty: -130, currentPrice: 190, marketValue: -24700, side: 'short' }] });
    check('自己的空头：账本 -100、账户 -130 → 自己的 -100，别人的 -30', sb.own[0]?.qty === -100 && sb.own[0].side === 'short' && sb.foreign[0]?.qty === -30, JSON.stringify(sb));
    check('资金 = 50000 + 20000（开空所得）− 19000（空头现值）= 51000', sb.capital === 51000 && sb.cash === 70000, `capital=${sb.capital}`);
    const sb2 = PP.sessionBook({ capital: 50000, ledger: { qty: { IWM: -100 } }, positions: [{ symbol: 'IWM', qty: 20, currentPrice: 190, marketValue: 3800, side: 'long' }] });
    check('账本是空头、账户是多头：不算自己的', sb2.own.length === 0 && sb2.foreign[0]?.qty === 20);
  }
  {
    const sid = 'pshorta00001';
    const ctx = await mkSession(sid);
    reset();
    const holdings = { SPY: { qty: 50, price: 500, weight: 0.5 }, IWM: { qty: -100, price: 200, weight: -0.4 } };
    const r = await step(ctx, sid, { holdings, barDates: { SPY: '2026-11-06', IWM: '2026-11-06' } });
    check('多空策略：开空 IWM 100 股、买 SPY 50 股', srv.posted.some((o) => o.symbol === 'IWM' && o.side === 'sell' && o.qty === '100') && srv.posted.some((o) => o.symbol === 'SPY' && o.side === 'buy' && o.qty === '50'), srv.posted.map((o) => `${o.side} ${o.qty} ${o.symbol}`).join(', '));
    check('开空先于买多', srv.posted[0].symbol === 'IWM' && r.alpaca.errors.length === 0);
  }
  {
    const sid = 'pshortb00001';
    const ctx = await mkSession(sid);
    reset({ shorting: false });
    const holdings = { SPY: { qty: 50, price: 500, weight: 0.5 }, IWM: { qty: -100, price: 200, weight: -0.4 } };
    let err = null;
    try { await step(ctx, sid, { holdings, barDates: { SPY: '2026-11-06', IWM: '2026-11-06' } }); } catch (e) { err = e; }
    check('策略要做空但账户不能空：一笔都不下', err && /不能做空/.test(err.message) && srv.posted.length === 0, err?.message);
  }
  {
    const sid = 'pshortc00001';
    const ctx = await mkSession(sid);
    reset({ assets: { GME: { easy_to_borrow: false } } });
    const holdings = { SPY: { qty: 50, price: 500, weight: 0.5 }, GME: { qty: -100, price: 20, weight: -0.04 }, IWM: { qty: -100, price: 200, weight: -0.4 } };
    const r = await step(ctx, sid, { holdings, barDates: { SPY: '2026-11-06', IWM: '2026-11-06', GME: '2026-11-06' } });
    check('借不到的 GME：不开空并写明，别的空头照常', !srv.posted.some((o) => o.symbol === 'GME') && r.alpaca.plan.notes.some((n) => /GME/.test(n) && /easy_to_borrow/.test(n)) && srv.posted.some((o) => o.symbol === 'IWM'));
  }
  {
    // 这个模拟之前开过 IWM 空头 100 股；账户里还有用户自己的 XLE 多头。策略现在不空 IWM 了：平空 100 股；XLE 目标为空但不是自己的，不开空不卖
    const sid = 'pshortd00001';
    const ctx = await mkSession(sid, { log: [{ dataDate: '2026-11-05', runAt: '2026-11-05T22:30:00.000Z', holdings: {}, alpaca: { submitted: [{ symbol: 'IWM', side: 'sell', intent: 'short', qty: 100, clientOrderId: `${sid}-20261105-IWM-short` }], errors: [], plan: { orders: [], targetValue: {} } } }] });
    reset({ positions: [apos('IWM', -100, 190), apos('XLE', 10, 80)], orders: [filled(`${sid}-20261105-IWM-short`, 'IWM', 'sell', 100, 200)] });
    const holdings = { SPY: { qty: 50, price: 500, weight: 0.5 }, XLE: { qty: -10, price: 80, weight: -0.1 } };
    const r = await step(ctx, sid, { holdings, barDates: { SPY: '2026-11-06', XLE: '2026-11-06' } });
    check('不再做空 IWM：买入 100 股平空（cover）', srv.posted.some((o) => o.symbol === 'IWM' && o.side === 'buy' && o.qty === '100' && /-cover$/.test(o.client_order_id)), srv.posted.map((o) => `${o.side} ${o.qty} ${o.symbol}`).join(', '));
    check('账户里有别人持仓的 XLE：不开空', !srv.posted.some((o) => o.symbol === 'XLE'));
    check('资金 = 50000 + 20000 − 19000 = 51000', r.alpaca.capital === 51000, `capital=${r.alpaca.capital}`);
  }
} catch (e) {
  check('没有异常', false, e.stack);
}
await rm(TMP, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
