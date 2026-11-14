// Alpaca 模拟盘客户端测试：node test/alpaca.test.mjs
// 全程 mock globalThis.fetch，不发任何真实网络请求；密钥文件写到临时目录，使用假密钥。
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-alpaca-'));
const CREDS = path.join(TMP, 'nested', 'secrets', 'alpaca.json');
process.env.HELM_ALPACA_FILE = CREDS;
process.env.HELM_ALPACA_BACKOFF_MS = '5'; // 测试里把指数退避的基数调小

const realFetch = globalThis.fetch;
let calls = [];
let handler = () => { throw new Error('unexpected fetch'); };
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  calls.push({ url: u, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined, signal: init.signal });
  return handler(u, init);
};
const json = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const A = await import('../lib/alpaca.mjs');

let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failed += 1;
};
const find = (plan, sym, side) => plan.orders.find((o) => o.symbol === sym && (!side || o.side === side));
const skip = (plan, sym) => plan.skipped.find((s) => s.symbol === sym);
const wellFormed = (plan) => plan.orders.every((o) => Number.isInteger(o.qty) && o.qty > 0 && o.estValue >= 0)
  && (() => { const i = plan.orders.findIndex((o) => o.side === 'buy'); return i < 0 || plan.orders.slice(i).every((o) => o.side === 'buy'); })();
const pos = (symbol, qty, currentPrice) => ({ symbol, qty, currentPrice, marketValue: qty * currentPrice, avgEntryPrice: currentPrice, side: 'long' });

const FAKE = { keyId: 'PKABCDEFWXYZ', secret: 'fake-secret-do-not-use-123' };
const ACCOUNT = { id: 'acc-1', status: 'ACTIVE', currency: 'USD', cash: '1000.5', equity: '100000', buying_power: '200000', portfolio_value: '100000', pattern_day_trader: false, trading_blocked: false };

try {
  /* ---------- planRebalance ---------- */
  {
    const p = A.planRebalance({ targets: { SPY: 0.5, QQQ: 0.3 }, equity: 100000, positions: [], prices: { SPY: 500, QQQ: 400 } });
    check('新建仓：SPY 买 100 股', find(p, 'SPY', 'buy')?.qty === 100, JSON.stringify(find(p, 'SPY')));
    check('新建仓：QQQ 买 75 股', find(p, 'QQQ', 'buy')?.qty === 75);
    check('新建仓：targetValue', p.targetValue.SPY === 50000 && p.targetValue.QQQ === 30000);
    check('新建仓：无缩放提示', p.notes.length === 0, p.notes.join(';'));
    check('新建仓：整数且先卖后买', wellFormed(p));
  }
  {
    const p = A.planRebalance({
      targets: { SPY: 0.5, QQQ: 0.3 }, equity: 100000,
      positions: [pos('SPY', 150, 500), pos('QQQ', 50, 400)], prices: { SPY: 500, QQQ: 400 },
    });
    check('部分调仓：SPY 减 50 股', find(p, 'SPY', 'sell')?.qty === 50, JSON.stringify(p.orders));
    check('部分调仓：QQQ 加 25 股', find(p, 'QQQ', 'buy')?.qty === 25);
    check('部分调仓：卖单在买单之前', p.orders[0].side === 'sell' && wellFormed(p));
  }
  {
    const p = A.planRebalance({ targets: { SPY: 0.5 }, equity: 100000, positions: [pos('IWM', 10, 200), pos('TINY', 1, 20)], prices: { SPY: 500, IWM: 200 } });
    const iwm = find(p, 'IWM', 'sell');
    check('清仓：不在目标中的 IWM 全部卖出', iwm?.qty === 10 && /不在目标/.test(iwm.reason), JSON.stringify(iwm));
    check('清仓：小额持仓（$20 < 最小交易额）仍清仓', find(p, 'TINY', 'sell')?.qty === 1);
    check('清仓：缺价时回退到持仓 currentPrice', find(p, 'TINY', 'sell')?.estValue === 20);
    check('清仓：targetValue 为 0', p.targetValue.IWM === 0);
    check('清仓：先卖后买', wellFormed(p) && p.orders.at(-1).symbol === 'SPY');
  }
  {
    const p = A.planRebalance({ targets: { SPY: 0 }, equity: 10000, positions: [pos('SPY', 3, 100)], prices: {} });
    check('目标权重 0：清仓', find(p, 'SPY', 'sell')?.qty === 3 && /目标权重为 0/.test(find(p, 'SPY').reason));
  }
  {
    const p = A.planRebalance({ targets: { AAA: 0.6, BBB: 0.6 }, equity: 10000, positions: [], prices: { AAA: 10, BBB: 10 } });
    check('maxGross：总仓位 1.2 缩放到 0.98，各 490 股', find(p, 'AAA')?.qty === 490 && find(p, 'BBB')?.qty === 490, JSON.stringify(p.orders));
    check('maxGross：targetValue 4900', p.targetValue.AAA === 4900);
    check('maxGross：有缩放提示', p.notes.some((n) => /超过上限/.test(n)));
    const p2 = A.planRebalance({ targets: { AAA: 0.6, BBB: 0.6 }, equity: 10000, positions: [], prices: { AAA: 10, BBB: 10 }, opts: { maxGross: 0.5 } });
    check('maxGross：自定义上限 0.5 → 各 250 股', find(p2, 'AAA')?.qty === 250);
  }
  {
    const p = A.planRebalance({ targets: { SPY: 0.497 }, equity: 100000, positions: [pos('SPY', 99, 500)], prices: { SPY: 500 } });
    check('minWeightDiff：0.2% 变化被跳过', p.orders.length === 0 && /低于阈值/.test(skip(p, 'SPY')?.reason || ''), JSON.stringify(p));
    const p2 = A.planRebalance({ targets: { XYZ: 0.04 }, equity: 1000, positions: [], prices: { XYZ: 10 } });
    check('minTradeValue：$40 < $50 被跳过', p2.orders.length === 0 && /最小交易额/.test(skip(p2, 'XYZ')?.reason || ''));
    const p3 = A.planRebalance({ targets: { XYZ: 0.04 }, equity: 1000, positions: [], prices: { XYZ: 10 }, opts: { minTradeValue: 10 } });
    check('minTradeValue：阈值降到 $10 后买 4 股', find(p3, 'XYZ', 'buy')?.qty === 4);
    const p4 = A.planRebalance({ targets: { XYZ: 0.3 }, equity: 1000, positions: [], prices: { XYZ: 400 } });
    check('整股：$300 买不起 1 股 $400 → 跳过', p4.orders.length === 0 && !!skip(p4, 'XYZ'));
  }
  {
    const p = A.planRebalance({
      targets: { SPY: 0.5 }, equity: 10000, positions: [pos('IWM', 20, 100)], prices: { SPY: 100, IWM: 100 }, opts: { cash: 1000 },
    });
    check('现金约束：IWM 先全部卖出', p.orders[0].symbol === 'IWM' && p.orders[0].side === 'sell' && p.orders[0].qty === 20);
    check('现金约束：SPY 50 股缩减为 30 股（现金 1000 + 卖出 2000）', find(p, 'SPY', 'buy')?.qty === 30, JSON.stringify(p.orders));
    check('现金约束：有缩减提示', p.notes.some((n) => /缩减/.test(n)));
    const buyTotal = p.orders.filter((o) => o.side === 'buy').reduce((a, o) => a + o.estValue, 0);
    check('现金约束：买入总额 ≤ 可用现金', buyTotal <= 3000 && wellFormed(p));
    const p2 = A.planRebalance({ targets: { SPY: 0.5 }, equity: 10000, positions: [], prices: { SPY: 100 }, opts: { cash: -500 } });
    check('现金约束：现金为负时不买', p2.orders.length === 0 && !!skip(p2, 'SPY'));
  }
  {
    const p = A.planRebalance({ targets: { 'brk.b': 0.2 }, equity: 100000, positions: [pos('BRK.B', 10, 400)], prices: { 'brk.b': 400 } });
    check('符号规范化：brk.b → BRK.B 加仓 40 股', find(p, 'BRK.B', 'buy')?.qty === 40, JSON.stringify(p.orders));
    check('符号规范化：不会误判为清仓', !p.orders.some((o) => o.side === 'sell'));
    check('符号规范化：targetValue 键为 BRK.B', p.targetValue['BRK.B'] === 20000 && !('brk.b' in p.targetValue));
    check('normalizeSymbol：BRK B / brk/b → BRK.B', A.normalizeSymbol(' brk b ') === 'BRK.B' && A.normalizeSymbol('brk/b') === 'BRK.B');
  }
  {
    const p = A.planRebalance({ targets: { XYZ: 0.2, SPY: 0.2 }, equity: 100000, positions: [], prices: { SPY: 500 } });
    check('缺价：XYZ 被跳过并说明原因', /缺少价格/.test(skip(p, 'XYZ')?.reason || '') && !find(p, 'XYZ'));
    check('缺价：其他标的照常', find(p, 'SPY')?.qty === 40);
  }
  {
    const p = A.planRebalance({ targets: { SPY: 0.5 }, equity: 10000, positions: [pos('OLD', 2.5, 100)], prices: { SPY: 100 } });
    check('零碎股：清仓只卖整股 2 股并提示', find(p, 'OLD', 'sell')?.qty === 2 && p.notes.some((n) => /零碎股/.test(n)));
    const p2 = A.planRebalance({ targets: { SPY: -0.1, QQQ: 0.1 }, equity: 0, positions: [], prices: { SPY: 1 } });
    check('净值为 0：不生成订单', p2.orders.length === 0 && p2.notes.length > 0);
    const p3 = A.planRebalance({ targets: { SPY: -0.1 }, equity: 1000, positions: [{ ...pos('TSLA', -5, 100), side: 'short' }], prices: { SPY: 1 } });
    check('负权重 / 空头持仓：跳过不下单', p3.orders.length === 0 && !!skip(p3, 'SPY') && !!skip(p3, 'TSLA'));
  }

  /* ---------- HTTP 层 ---------- */
  await A.clearCreds();
  {
    let err;
    try { await A.getAccount(); } catch (e) { err = e; }
    check('未配置密钥：报中文错误且不发请求', /尚未配置/.test(err?.message || '') && calls.length === 0);
  }

  // 先保存一组假密钥
  calls = [];
  handler = () => json(401, { code: 40110000, message: 'request is not authorized' });
  {
    const r = await A.saveCreds(FAKE);
    check('saveCreds 401：返回 success:false', r.success === false && /401/.test(r.errors?.[0] || '') && /request is not authorized/.test(r.errors[0]), JSON.stringify(r));
    check('saveCreds 401：没有写文件', !existsSync(CREDS) && !existsSync(path.dirname(CREDS)));
    check('saveCreds 401：错误中不含 secret', !JSON.stringify(r).includes(FAKE.secret));
    check('saveCreds：只请求模拟盘 /v2/account', calls.length === 1 && calls[0].url.origin === 'https://paper-api.alpaca.markets' && calls[0].url.pathname === '/v2/account');
    check('saveCreds：带认证头', calls[0].headers['APCA-API-KEY-ID'] === FAKE.keyId && calls[0].headers['APCA-API-SECRET-KEY'] === FAKE.secret);
    const r2 = await A.saveCreds({ keyId: 'AKLIVEKEY1234', secret: 'x' });
    check('saveCreds：实盘样式密钥给出提示', /实盘/.test(r2.errors?.[0] || ''));
    const r3 = await A.saveCreds({ keyId: '', secret: '' });
    check('saveCreds：空输入直接拒绝，不发请求', r3.success === false && r3.errors.length === 2 && calls.length === 2);
  }
  handler = () => json(200, ACCOUNT);
  {
    const r = await A.saveCreds(FAKE);
    check('saveCreds 200：success:true 且返回账户摘要', r.success === true && r.account.equity === 100000 && r.account.cash === 1000.5 && r.account.buyingPower === 200000, JSON.stringify(r));
    check('saveCreds 200：账户摘要字段齐全', ['id', 'status', 'currency', 'cash', 'equity', 'buyingPower', 'portfolioValue', 'patternDayTrader', 'tradingBlocked'].every((k) => k in r.account));
    check('saveCreds 200：返回值不含 secret', !JSON.stringify(r).includes(FAKE.secret));
    const st = await stat(CREDS);
    check('saveCreds 200：文件权限 0600', (st.mode & 0o777) === 0o600, (st.mode & 0o777).toString(8));
    const saved = JSON.parse(await readFile(CREDS, 'utf8'));
    check('saveCreds 200：文件内容正确', saved.keyId === FAKE.keyId && saved.secret === FAKE.secret);
    const loaded = await A.loadCreds();
    check('loadCreds：读回密钥', loaded?.keyId === FAKE.keyId && loaded?.secret === FAKE.secret);
    const leftovers = (await import('node:fs')).readdirSync(path.dirname(CREDS)).filter((f) => f.endsWith('.tmp'));
    check('saveCreds：没有残留临时文件', leftovers.length === 0);
  }
  // 已保存成功后，再次保存失败不覆盖旧文件
  handler = () => json(403, { message: 'forbidden' });
  {
    const r = await A.saveCreds({ keyId: 'PKOTHER99999', secret: 'other-secret' });
    const saved = JSON.parse(await readFile(CREDS, 'utf8'));
    check('saveCreds 失败：不覆盖已有密钥', r.success === false && saved.keyId === FAKE.keyId);
  }
  {
    handler = () => json(200, ACCOUNT);
    const s = await A.status();
    check('status：已连接 + 打码 PK****WXYZ', s.connected === true && s.keyIdMasked === 'PK****WXYZ' && s.account?.equity === 100000, JSON.stringify(s));
    check('status：不泄露 secret 和完整 key', !JSON.stringify(s).includes(FAKE.secret) && !JSON.stringify(s).includes(FAKE.keyId));
    handler = () => json(401, { message: 'request is not authorized' });
    const s2 = await A.status();
    check('status：验证失败 connected:false 带错误', s2.connected === false && s2.keyIdMasked === 'PK****WXYZ' && /Alpaca 拒绝：401/.test(s2.error || ''));
    check('maskKeyId：短 key 全打码', A.maskKeyId('PK12') === '****');
  }
  {
    handler = () => json(403, { code: 40310000, message: 'forbidden' });
    let err;
    try { await A.getAccount(); } catch (e) { err = e; }
    check('HTTP 错误格式：Alpaca 拒绝：403 forbidden', err?.message === 'Alpaca 拒绝：403 forbidden' && err.status === 403, err?.message);
    handler = () => new Response('upstream exploded', { status: 500, statusText: 'Internal Server Error' });
    err = undefined;
    try { await A.getPositions(); } catch (e) { err = e; }
    check('HTTP 错误格式：非 JSON 正文', err?.message === 'Alpaca 拒绝：500 upstream exploded', err?.message);
    handler = () => new Response('', { status: 502, statusText: 'Bad Gateway' });
    err = undefined;
    try { await A.getClock(); } catch (e) { err = e; }
    check('HTTP 错误格式：空正文用 statusText', err?.message === 'Alpaca 拒绝：502 Bad Gateway', err?.message);
    check('formatAlpacaError 同步可用', A.formatAlpacaError(422, '{"message":"qty must be > 0"}').message === 'Alpaca 拒绝：422 qty must be > 0');
  }
  {
    process.env.HELM_ALPACA_TIMEOUT_MS = '50';
    handler = (u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    let err;
    calls = [];
    try { await A.getAccount(); } catch (e) { err = e; }
    check('超时：AbortController 中止并报中文错误', /超时/.test(err?.message || ''), err?.message);
    check('超时：GET 超时不重试（已等满一个超时）', calls.length === 1 && err?.kind === 'timeout');
    delete process.env.HELM_ALPACA_TIMEOUT_MS;
    handler = () => { throw new TypeError('fetch failed'); };
    err = undefined;
    try { await A.getAccount(); } catch (e) { err = e; }
    check('网络错误：中文提示', /无法连接/.test(err?.message || ''));
  }
  {
    calls = [];
    handler = (u) => {
      if (u.pathname === '/v2/positions') return json(200, [{ symbol: 'AAPL', qty: '10', market_value: '1900.5', avg_entry_price: '180', current_price: '190.05', side: 'long' }]);
      if (u.pathname === '/v2/clock') return json(200, { is_open: true, next_open: '2026-11-09T14:30:00Z', next_close: '2026-11-08T21:00:00Z', timestamp: '2026-11-08T15:00:00Z' });
      if (u.pathname === '/v2/orders') return json(200, [{ id: 'o1', client_order_id: 'c1', symbol: 'AAPL', qty: '5', filled_qty: '5', filled_avg_price: '190.1', side: 'buy', status: 'filled', submitted_at: 't0', filled_at: 't1' }]);
      if (u.pathname.startsWith('/v2/orders/')) return new Response(null, { status: 204 });
      return json(404, { message: 'not found' });
    };
    const ps = await A.getPositions();
    check('getPositions：数字化字段', ps[0].symbol === 'AAPL' && ps[0].qty === 10 && ps[0].marketValue === 1900.5 && ps[0].avgEntryPrice === 180 && ps[0].currentPrice === 190.05 && ps[0].side === 'long');
    const c = await A.getClock();
    check('getClock：字段映射', c.isOpen === true && c.nextOpen === '2026-11-09T14:30:00Z' && c.timestamp === '2026-11-08T15:00:00Z');
    const os2 = await A.listOrders({ status: 'closed', limit: 9999, after: '2026-11-01T00:00:00Z' });
    const q = calls.at(-1).url.searchParams;
    check('listOrders：参数与字段', q.get('status') === 'closed' && q.get('limit') === '500' && q.get('after') === '2026-11-01T00:00:00Z' && os2[0].filledQty === 5 && os2[0].filledAvgPrice === 190.1 && os2[0].clientOrderId === 'c1');
    const cx = await A.cancelOrder('abc-123');
    check('cancelOrder：DELETE 204', cx.success === true && calls.at(-1).method === 'DELETE' && calls.at(-1).url.pathname === '/v2/orders/abc-123');
    check('所有请求都指向模拟盘', calls.every((x) => x.url.origin === 'https://paper-api.alpaca.markets'));
  }
  {
    calls = [];
    const bad = [{ symbol: 'SPY', qty: 1.5, side: 'buy' }, { symbol: 'SPY', qty: 0, side: 'buy' }, { symbol: 'SPY', qty: 1, side: 'short' }, { symbol: '', qty: 1, side: 'buy' }];
    let n = 0;
    for (const b of bad) { try { await A.submitOrder(b); } catch { n += 1; } }
    check('submitOrder：非法数量/方向/代码被拒，且不发请求', n === 4 && calls.length === 0);
    handler = () => json(200, { id: 'o9', status: 'accepted', symbol: 'BRK.B', qty: '3', side: 'buy' });
    const r = await A.submitOrder({ symbol: 'brk.b', qty: 3, side: 'buy', clientOrderId: 'x1' });
    const b = calls.at(-1).body;
    check('submitOrder：请求体', b.symbol === 'BRK.B' && b.qty === '3' && b.side === 'buy' && b.type === 'market' && b.time_in_force === 'day' && b.client_order_id === 'x1' && r.id === 'o9');
  }

  /* ---------- executePlan ---------- */
  {
    const plan = { orders: [
      { symbol: 'SPY', side: 'buy', qty: 10, estValue: 5000 },
      { symbol: 'IWM', side: 'sell', qty: 5, estValue: 1000 },
      { symbol: 'QQQ', side: 'buy', qty: 2, estValue: 800 },
    ] };
    calls = [];
    const dry = await A.executePlan(plan, { dryRun: true, tag: 't1' });
    check('executePlan dryRun：不发请求', calls.length === 0 && dry.submitted.length === 3 && dry.submitted.every((s) => s.status === 'dry_run'));
    check('executePlan dryRun：先卖后买', dry.submitted[0].symbol === 'IWM');

    let k = 0;
    handler = (u, init) => {
      if ((init.method || 'GET') === 'GET' && u.pathname === '/v2/account') return json(200, ACCOUNT);
      if ((init.method || 'GET') === 'GET' && u.pathname.startsWith('/v2/assets/')) return json(200, { symbol: decodeURIComponent(u.pathname.split('/').pop()), status: 'active', tradable: true });
      const body = JSON.parse(init.body);
      if (body.symbol === 'QQQ') return json(422, { code: 40010001, message: 'client_order_id must be unique' });
      k += 1;
      return json(200, { id: `id-${k}`, status: 'accepted', symbol: body.symbol, qty: body.qty, side: body.side, client_order_id: body.client_order_id });
    };
    const longTag = 'rebalance-2026-11-08-very-long-tag-name-xxxxxxxxxxxxxxxx';
    const r = await A.executePlan(plan, { tag: longTag });
    check('executePlan：重复 clientOrderId 记入 errors 而不抛出', r.errors.length === 1 && r.errors[0].symbol === 'QQQ' && /422/.test(r.errors[0].error) && /unique/.test(r.errors[0].error), JSON.stringify(r.errors));
    check('executePlan：成功的两笔', r.submitted.length === 2 && r.submitted[0].symbol === 'IWM' && r.submitted[0].id === 'id-1' && r.submitted[1].symbol === 'SPY');
    const postsOf = () => calls.filter((c) => c.method === 'POST');
    const ids = postsOf().map((c) => c.body.client_order_id);
    check('executePlan：先卖后买的提交顺序', postsOf().map((c) => c.body.side).join(',') === 'sell,buy,buy');
    check('executePlan：下单前查账户、买单前查资产（只读 GET）', calls.filter((c) => c.method === 'GET').map((c) => c.url.pathname).join(',') === '/v2/account,/v2/assets/SPY,/v2/assets/QQQ');
    check('executePlan：clientOrderId 截断到 48 字符', ids.every((id) => id.length <= 48) && ids[0] === `${longTag}-IWM-sell`.slice(0, 48));
    const r2 = await A.executePlan(plan, { tag: 'run7' });
    check('executePlan：clientOrderId = tag-symbol-side', postsOf().at(-3).body.client_order_id === 'run7-IWM-sell' && r2.submitted.length === 2);
  }

  /* ---------- 加固：假服务器（超时补查、限流、资产检查、账户检查） ---------- */
  // 服务器层记录真正“到达服务器”的请求；传输层可以丢请求（没到服务器）、丢回包（到了但客户端超时）或直接回 429/5xx
  const server = { orders: new Map(), postsByCoid: new Map(), account: { ...ACCOUNT }, assets: {}, lookupFails: false };
  let transport = []; // 每项：(u, init) => undefined（放行）| 'drop-request' | 'drop-response' | Response
  let attempts = [];  // 客户端发出的每个请求（包括没到服务器的）
  const aborted = (init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const orderView = (o) => ({ id: o.id, client_order_id: o.client_order_id, symbol: o.symbol, side: o.side, qty: o.qty, status: 'accepted', type: 'market', time_in_force: 'day' });
  const serve = (u, init) => {
    const m = init.method || 'GET';
    if (m === 'POST' && u.pathname === '/v2/orders') {
      const b = JSON.parse(init.body);
      server.postsByCoid.set(b.client_order_id, (server.postsByCoid.get(b.client_order_id) || 0) + 1);
      if (server.orders.has(b.client_order_id)) return json(422, { code: 40010001, message: 'client_order_id must be unique' });
      const o = { ...b, id: `srv-${server.orders.size + 1}` };
      server.orders.set(b.client_order_id, o);
      return json(200, orderView(o));
    }
    if (m === 'GET' && u.pathname === '/v2/orders:by_client_order_id') {
      if (server.lookupFails) return json(500, { message: 'lookup exploded' });
      const o = server.orders.get(u.searchParams.get('client_order_id'));
      return o ? json(200, orderView(o)) : json(404, { code: 40410000, message: 'order not found' });
    }
    if (m === 'GET' && u.pathname === '/v2/account') return json(200, server.account);
    const am = u.pathname.match(/^\/v2\/assets\/(.+)$/);
    if (m === 'GET' && am) {
      const sym = decodeURIComponent(am[1]);
      const a = server.assets[sym];
      if (a === 'route404') return json(404, { message: 'Not Found' });
      return a ? json(200, { symbol: sym, class: 'us_equity', ...a }) : json(404, { code: 40410000, message: `asset not found for ${sym}` });
    }
    if (m === 'DELETE') return json(429, { message: 'rate limit exceeded' });
    return json(404, { message: 'Not Found' });
  };
  handler = async (u, init) => {
    attempts.push({ method: init.method || 'GET', path: u.pathname, coid: init.body ? JSON.parse(init.body).client_order_id : u.searchParams.get('client_order_id'), at: Date.now() });
    const f = transport.length ? transport.shift()(u, init) : undefined;
    if (f === 'drop-request') return aborted(init);
    if (f === 'drop-response') { serve(u, init); return aborted(init); }
    if (f instanceof Response) return f;
    return serve(u, init);
  };
  const reset = () => { transport = []; attempts = []; };
  const onPost = (f) => (u, init) => ((init.method === 'POST') ? f : undefined);
  const postsTo = (coid) => attempts.filter((x) => x.method === 'POST' && x.coid === coid).length;
  process.env.HELM_ALPACA_TIMEOUT_MS = '60';
  {
    // (a) 下单超时，但订单其实已经到了服务器 → 补查到就算已提交，不重下
    reset();
    transport = [onPost('drop-response')];
    const r = await A.submitOrder({ symbol: 'SPY', qty: 1, side: 'buy', clientOrderId: 'case-a' });
    check('(a) 下单超时但订单已存在：按 clientOrderId 补查到，不重下', r.recovered === true && r.id === 'srv-1' && postsTo('case-a') === 1 && attempts.some((x) => x.path === '/v2/orders:by_client_order_id' && x.coid === 'case-a'), JSON.stringify(attempts.map((x) => `${x.method} ${x.path}`)));

    // (b) 下单超时，请求根本没到服务器 → 补查 404 → 用同一个 clientOrderId 重下恰好 1 次
    reset();
    transport = [onPost('drop-request')];
    const r2 = await A.submitOrder({ symbol: 'SPY', qty: 2, side: 'buy', clientOrderId: 'case-b' });
    check('(b) 下单超时且补查 404：同一个 clientOrderId 恰好重下 1 次', r2.id && !r2.recovered && postsTo('case-b') === 2 && server.postsByCoid.get('case-b') === 1, `客户端 POST ${postsTo('case-b')} 次，服务器收到 ${server.postsByCoid.get('case-b')} 次`);

    // (b2) 两次都没到服务器 → 报错，绝不下第三次
    reset();
    transport = [onPost('drop-request'), () => undefined, onPost('drop-request')];
    let err;
    try { await A.submitOrder({ symbol: 'SPY', qty: 2, side: 'buy', clientOrderId: 'case-b2' }); } catch (e) { err = e; }
    check('(b2) 重下也超时：报错，最多 2 次 POST', /已用同一个 clientOrderId 重下 1 次/.test(err?.message || '') && postsTo('case-b2') === 2 && !server.orders.has('case-b2'), err?.message);

    // (b3) 503（没处理）→ 补查 404 → 重下成功
    reset();
    transport = [onPost(json(503, { message: 'service unavailable' }))];
    const r3 = await A.submitOrder({ symbol: 'QQQ', qty: 1, side: 'sell', clientOrderId: 'case-b3' });
    check('(b3) 下单 503：补查后重下 1 次成功', r3.id && postsTo('case-b3') === 2 && server.postsByCoid.get('case-b3') === 1);

    // (b4) 超时后补查也失败 → 结果不确定，不重下
    reset();
    server.lookupFails = true;
    transport = [onPost('drop-request')];
    err = undefined;
    try { await A.submitOrder({ symbol: 'SPY', qty: 1, side: 'buy', clientOrderId: 'case-b4' }); } catch (e) { err = e; }
    server.lookupFails = false;
    check('(b4) 补查也失败：报“结果不确定”且不重下', err?.uncertain === true && /结果不确定/.test(err.message) && postsTo('case-b4') === 1, err?.message);

    // (b5) 没有 clientOrderId 时超时：无法确认，不补查也不重下
    reset();
    transport = [onPost('drop-request')];
    err = undefined;
    try { await A.submitOrder({ symbol: 'SPY', qty: 1, side: 'buy' }); } catch (e) { err = e; }
    check('(b5) 没有 clientOrderId：超时直接报错，不重下', /超时/.test(err?.message || '') && attempts.length === 1);
  }
  {
    // (c) 429 + Retry-After 后 200 → 成功，且确实等了
    reset();
    transport = [() => new Response(JSON.stringify({ code: 42910000, message: 'rate limit exceeded' }), { status: 429, headers: { 'Retry-After': '0.12' } })];
    const acc = await A.getAccount();
    const gap = attempts[1].at - attempts[0].at;
    check('(c) 429 + Retry-After：等待后重试成功', acc.equity === 100000 && attempts.length === 2 && gap >= 110, `间隔 ${gap}ms`);

    reset();
    transport = [() => new Response('{"message":"rate limit exceeded"}', { status: 429, headers: { 'X-RateLimit-Reset': String((Date.now() + 200) / 1000) } })];
    await A.getPositions().catch(() => {});
    const gap2 = attempts[1].at - attempts[0].at;
    check('(c) 429 + X-RateLimit-Reset：不早于重置时间重试', attempts.length === 2 && gap2 >= 180, `间隔 ${gap2}ms`);

    reset();
    transport = [onPost(new Response('{"message":"rate limit exceeded"}', { status: 429, headers: { 'Retry-After': '0.05' } }))];
    const r = await A.submitOrder({ symbol: 'IWM', qty: 1, side: 'buy', clientOrderId: 'case-c' });
    check('(c) 下单 429 后重试成功，只有一笔订单', r.id && postsTo('case-c') === 2 && server.postsByCoid.get('case-c') === 1);

    // (d) 一直 429 → 有界失败
    reset();
    const always429 = () => new Response('{"message":"rate limit exceeded"}', { status: 429, headers: { 'Retry-After': '0.02' } });
    transport = [always429, always429, always429, always429, always429];
    let err;
    try { await A.getAccount(); } catch (e) { err = e; }
    check('(d) 一直 429：最多 3 次后报错', err?.status === 429 && attempts.length === 3 && /仍被限流/.test(err.message), err?.message);

    reset();
    transport = [() => new Response('{"message":"rate limit exceeded"}', { status: 429, headers: { 'Retry-After': '120' } })];
    err = undefined;
    const t0 = Date.now();
    try { await A.getAccount(); } catch (e) { err = e; }
    check('(d) 要求等待超过 30 秒上限：立即放弃，不提前重试', err?.status === 429 && attempts.length === 1 && Date.now() - t0 < 1000 && /上限/.test(err.message), err?.message);

    reset();
    err = undefined;
    try { await A.cancelOrder('x-1'); } catch (e) { err = e; }
    check('(d) DELETE 不重试', err?.status === 429 && attempts.length === 1);
  }
  {
    // (e) 不可交易的资产跳过并报告，其他订单照常
    reset();
    server.assets = { OK1: { status: 'active', tradable: true }, BAD: { status: 'active', tradable: false }, OLD: { status: 'inactive', tradable: true }, ODD: 'route404' };
    const cache = new Map();
    const chk = await A.checkAssets(['ok1', 'BAD', 'OLD', 'GONE', 'ODD'], { cache });
    check('(e) checkAssets：分出可交易 / 不可交易 / 无法确认', chk.ok.join() === 'OK1' && chk.untradable.map((x) => x.symbol).join() === 'BAD,OLD,GONE' && chk.unknown.map((x) => x.symbol).join() === 'ODD', JSON.stringify(chk));
    const plan = { orders: [
      { symbol: 'AAA', side: 'sell', qty: 3, estValue: 300 },
      { symbol: 'BAD', side: 'buy', qty: 5, estValue: 500 },
      { symbol: 'GONE', side: 'buy', qty: 5, estValue: 500 },
      { symbol: 'OK1', side: 'buy', qty: 4, estValue: 400 },
      { symbol: 'ODD', side: 'buy', qty: 1, estValue: 100 },
    ] };
    const n0 = attempts.length;
    const r = await A.executePlan(plan, { tag: 'case-e', assetCache: cache });
    const posted = attempts.slice(n0).filter((x) => x.method === 'POST').map((x) => x.coid);
    check('(e) executePlan：不可交易的 BAD / GONE 跳过并报告', r.skipped.map((x) => x.symbol).join() === 'BAD,GONE' && r.errors.filter((x) => x.skipped).length === 2 && /不可交易/.test(r.skipped[0].reason), JSON.stringify(r));
    check('(e) executePlan：卖单和可交易的买单照常（无法确认的交给 Alpaca 校验）', posted.join() === 'case-e-AAA-sell,case-e-OK1-buy,case-e-ODD-buy' && r.submitted.length === 3, posted.join());
    check('(e) 资产查询按运行缓存，不重复请求', attempts.slice(n0).filter((x) => x.path.startsWith('/v2/assets/')).length === 0);
    const p = A.planRebalance({ targets: { OK1: 0.4, BAD: 0.3 }, equity: 10000, positions: [pos('BAD', 10, 100), pos('KEEP', 5, 100)], prices: { OK1: 100, BAD: 100, KEEP: 100 }, opts: { untradable: chk.untradable } });
    check('(e) planRebalance：不可交易的持仓不买不卖，其他照常', !p.orders.some((o) => o.symbol === 'BAD') && /不可交易/.test(skip(p, 'BAD')?.reason || '') && find(p, 'OK1', 'buy')?.qty === 40 && find(p, 'KEEP', 'sell')?.qty === 5, JSON.stringify(p.orders));
    const p2 = A.planRebalance({ targets: { OK1: 0.4 }, equity: 10000, positions: [pos('BAD', 10, 100)], prices: { OK1: 100, BAD: 100 }, opts: { untradable: ['BAD'] } });
    check('(e) planRebalance：不在目标里的不可交易持仓也不会被清仓', !p2.orders.some((o) => o.symbol === 'BAD' && o.side === 'sell'));
  }
  {
    // (f) 账户暂停交易 / 被禁止交易 → 拒绝，一笔都不下
    const plan = { orders: [{ symbol: 'OK1', side: 'buy', qty: 1, estValue: 100 }] };
    for (const [flag, re] of [['trade_suspended_by_user', /trade_suspended_by_user/], ['trading_blocked', /trading_blocked/], ['account_blocked', /account_blocked/]]) {
      reset();
      server.account = { ...ACCOUNT, [flag]: true };
      let err;
      try { await A.executePlan(plan, { tag: `case-f-${flag}` }); } catch (e) { err = e; }
      check(`(f) ${flag}：拒绝下单并给出中文原因`, err?.code === 'ACCOUNT_BLOCKED' && re.test(err.message) && /不/.test(err.message) && !attempts.some((x) => x.method === 'POST'), err?.message);
    }
    const acc = await A.getAccount();
    check('(f) 账户摘要：tradingBlocked / blockedReason', acc.tradingBlocked === true && /account_blocked/.test(acc.blockedReason));
    server.account = { ...ACCOUNT, trade_suspended_by_user: true };
    const acc2 = await A.getAccount();
    check('(f) 账户摘要：trade_suspended_by_user 也算不能交易（旧调用方检查 tradingBlocked 也会拒绝）', acc2.tradingBlocked === true && acc2.tradeSuspendedByUser === true);
    let thrown;
    try { A.assertCanTrade(acc2); } catch (e) { thrown = e; }
    check('(f) assertCanTrade 同步抛出', /暂停了交易/.test(thrown?.message || '') && A.assertCanTrade({ ...ACCOUNT }) === true);
    server.account = { id: 'acc-2', status: 'ACTIVE', cash: '1', equity: '1', buying_power: '4', multiplier: '4' };
    const acc3 = await A.getAccount();
    check('PDT 字段已移除：patternDayTrader 为 false，multiplier / buyingPower 照常', acc3.patternDayTrader === false && acc3.multiplier === 4 && acc3.buyingPower === 4 && acc3.tradingBlocked === false && acc3.blockedReason === null);
    server.account = { ...ACCOUNT };
  }
  delete process.env.HELM_ALPACA_TIMEOUT_MS;
  {
    // (g) 所有用例里，服务器从没收到过两次相同 client_order_id 的下单
    const dups = [...server.postsByCoid.entries()].filter(([, n]) => n > 1);
    check('(g) 服务器从未收到同一 client_order_id 的两次下单', dups.length === 0 && server.postsByCoid.size >= 7, JSON.stringify(dups));
  }

  /* ---------- 只连模拟盘：源码 grep ---------- */
  {
    const src = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'alpaca.mjs'), 'utf8');
    const stripped = src.split('paper-api.alpaca.markets').join('');
    check('源码中没有实盘地址（除 paper-api 外不出现 api.alpaca.markets）', !stripped.includes('api.alpaca.markets'));
    check('源码中 PAPER_BASE 写死为模拟盘', A.PAPER_BASE === 'https://paper-api.alpaca.markets' && /const PAPER_BASE = 'https:\/\/paper-api\.alpaca\.markets'/.test(src));
    check('源码不读取覆盖地址的环境变量', !/process\.env\.[A-Z_]*(BASE|URL|ENDPOINT)/.test(src));
  }

  /* ---------- clearCreds ---------- */
  {
    await A.clearCreds();
    check('clearCreds：文件已删除', !existsSync(CREDS) && (await A.loadCreds()) === null);
    const s = await A.status();
    check('status：无密钥时 connected:false', s.connected === false && !('keyIdMasked' in s));
  }
} catch (e) {
  console.log(`FAIL  未捕获异常：${e.stack || e}`);
  failed += 1;
} finally {
  globalThis.fetch = realFetch;
  await rm(TMP, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
