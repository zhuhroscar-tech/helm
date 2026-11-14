// Helm · Alpaca 模拟盘（paper）客户端。零依赖，使用全局 fetch（Node ≥ 20）。
//
// 安全约定：
//   - 只连接模拟盘。交易接口地址写死为 PAPER_BASE，没有任何参数或环境变量可以改它；
//     每次请求前还会再核对一次 URL 前缀。验证失败就报错，绝不尝试其他地址。
//   - 密钥保存在 <repo>/data/secrets/alpaca.json（可用 HELM_ALPACA_FILE 覆盖），
//     文件权限 0600，先写临时文件再 rename，保证原子性。
//   - 任何返回值、错误信息、日志里都不出现 secret；status() 只给出打码后的 key id。
//   - 每个请求都有超时；GET 遇到 429 / 5xx / 连不上会有限次重试（≤3 次、等待合计 ≤30 秒）。
//     下单只在带 clientOrderId 时重试：结果不确定先按 clientOrderId 补查，查不到才重下 1 次，绝不出现两笔同号订单。
import { mkdir, readFile, writeFile, rename, rm, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PAPER_BASE = 'https://paper-api.alpaca.markets';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TIMEOUT_MS = 15000;
// 重试上限：最多 3 次请求，所有等待加起来不超过 30 秒
const MAX_TRIES = 3;
const MAX_TOTAL_WAIT_MS = 30000;
const DEFAULT_BACKOFF_MS = 1000;

const credsFile = () => process.env.HELM_ALPACA_FILE || path.join(REPO_ROOT, 'data', 'secrets', 'alpaca.json');
const timeoutMs = () => {
  const v = Number(process.env.HELM_ALPACA_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
};
const backoffMs = () => {
  const v = Number(process.env.HELM_ALPACA_BACKOFF_MS);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_BACKOFF_MS;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 小工具 ---------------- */

const num = (x, dflt = 0) => {
  const v = typeof x === 'number' ? x : parseFloat(x);
  return Number.isFinite(v) ? v : dflt;
};
const round2 = (x) => Math.round(x * 100) / 100;
// 浮点安全的向下取整：29.9999999 → 30 而不是 29
const floorQty = (x) => (x > 0 ? Math.floor(x + 1e-9) : 0);

/** LEAN 符号 → Alpaca 符号：去空白、转大写，空格/斜杠分隔的类别股统一为点号（brk.b / BRK B → BRK.B）。同步函数。 */
export function normalizeSymbol(sym) {
  return String(sym ?? '').trim().toUpperCase().replace(/[\s/]+/g, '.');
}

/** key id 打码：PKABCDEFWXYZ → PK****WXYZ。同步函数。 */
export function maskKeyId(keyId) {
  const k = String(keyId ?? '');
  if (k.length <= 6) return '****';
  return `${k.slice(0, 2)}****${k.slice(-4)}`;
}

/* ---------------- 字段整形 ---------------- */

// 账户为什么不能下单（中文）；可以下单时返回 null。
// 字段见 https://docs.alpaca.markets/reference/getaccount-1 ：account_blocked / trading_blocked / trade_suspended_by_user
function accountBlockReason(a = {}) {
  if (a.account_blocked) return 'Alpaca 账户已被冻结（account_blocked），不能下单，请到 Alpaca 网站查看';
  if (a.trading_blocked) return 'Alpaca 账户被禁止交易（trading_blocked），不能下单，请到 Alpaca 网站查看';
  if (a.trade_suspended_by_user) return 'Alpaca 账户在设置里暂停了交易（trade_suspended_by_user），Helm 不会下单；如需继续，请先到 Alpaca 网站的账户设置里恢复交易';
  return null;
}

function summarizeAccount(a = {}) {
  const blockedReason = accountBlockReason(a);
  return {
    id: a.id ?? null,
    status: a.status ?? null,
    currency: a.currency ?? 'USD',
    cash: num(a.cash),
    equity: num(a.equity),
    // FINRA 2026-06-04 取消 PDT 规则后，Alpaca 要求改用 buying_power；pattern_day_trader 等字段已于 2026-07-06 从 API 移除
    // https://alpaca.markets/blog/finra-retires-the-pdt-rule-introducing-alpacas-new-intraday-margin-framework/
    buyingPower: num(a.buying_power),
    // 保证金类别：1 / 2 / 4（文档字段 multiplier，https://docs.alpaca.markets/reference/getaccount-1）
    multiplier: a.multiplier == null ? null : num(a.multiplier, null),
    portfolioValue: num(a.portfolio_value ?? a.equity),
    // 字段已移除：没有这个字段就是“没有 PDT 标记”（PDT 身份已不存在），旧账户若仍返回 true 则照实显示
    patternDayTrader: a.pattern_day_trader === true,
    tradingBlocked: Boolean(blockedReason),
    tradeSuspendedByUser: Boolean(a.trade_suspended_by_user),
    blockedReason,
  };
}

/** 账户不能下单时抛出中文错误（err.code = 'ACCOUNT_BLOCKED'）。参数可以是 getAccount() 的摘要或原始对象。同步函数。 */
export function assertCanTrade(account = {}) {
  const reason = 'blockedReason' in account ? account.blockedReason : accountBlockReason(account);
  if (reason) throw Object.assign(new Error(reason), { code: 'ACCOUNT_BLOCKED' });
  return true;
}

function summarizePosition(p = {}) {
  return {
    symbol: normalizeSymbol(p.symbol),
    qty: num(p.qty),
    marketValue: num(p.market_value),
    avgEntryPrice: num(p.avg_entry_price),
    currentPrice: num(p.current_price),
    side: p.side ?? (num(p.qty) < 0 ? 'short' : 'long'),
  };
}

function summarizeOrder(o = {}) {
  return {
    id: o.id ?? null,
    clientOrderId: o.client_order_id ?? null,
    symbol: o.symbol ?? null,
    side: o.side ?? null,
    type: o.type ?? o.order_type ?? null,
    timeInForce: o.time_in_force ?? null,
    qty: o.qty == null ? null : num(o.qty),
    filledQty: num(o.filled_qty),
    filledAvgPrice: o.filled_avg_price == null ? null : num(o.filled_avg_price),
    limitPrice: o.limit_price == null ? null : num(o.limit_price),
    status: o.status ?? null,
    submittedAt: o.submitted_at ?? null,
    filledAt: o.filled_at ?? null,
  };
}

/* ---------------- HTTP ---------------- */

/** 把非 2xx 响应格式化成中文错误信息，例如 “Alpaca 拒绝：403 forbidden”。同步函数。 */
export function formatAlpacaError(status, bodyText = '', statusText = '') {
  let msg = '';
  let code;
  try {
    const j = JSON.parse(bodyText);
    msg = j?.message ?? '';
    code = j?.code;
  } catch {
    msg = String(bodyText || '').trim().slice(0, 300);
  }
  if (!msg) msg = statusText || '未知错误';
  const err = new Error(`Alpaca 拒绝：${status} ${msg}`);
  err.status = status;
  if (code !== undefined) err.alpacaCode = code;
  return err;
}

const tagErr = (err, kind) => Object.assign(err, { kind });

// 发一次请求（含读完响应正文）。每次都有自己的 AbortController 超时，超时也覆盖读正文。
// 失败时抛出带 kind 的错误：timeout（不知道服务器有没有收到）/ network / redirect。
async function sendOnce(method, url, c, body) {
  const ms = timeoutMs();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'APCA-API-KEY-ID': c.keyId,
        'APCA-API-SECRET-KEY': c.secret,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      redirect: 'error', // 跟随重定向会把密钥头发到别的主机
    });
    const text = await res.text();
    return { res, text };
  } catch (e) {
    if (e?.name === 'AbortError' || ctrl.signal.aborted) throw tagErr(new Error(`Alpaca 请求超时（${ms / 1000} 秒）`), 'timeout');
    if (/redirect/i.test(String(e?.cause?.message ?? '')) || /redirect/i.test(String(e?.message ?? ''))) {
      throw tagErr(new Error('Alpaca 返回了重定向，已拒绝跟随（只允许连接模拟盘）'), 'redirect');
    }
    throw tagErr(new Error(`无法连接 Alpaca 模拟盘：${e?.message ?? e}`), 'network');
  } finally {
    clearTimeout(timer);
  }
}

// 429 时应该等多久（毫秒）；没有可用的头时返回 null。
// Alpaca 文档：收到 429 先停下，不要早于 X-RateLimit-Reset（Unix 秒）重试，并做带抖动的指数退避。
// https://docs.alpaca.markets/docs/rate-limits ；文档没提 Retry-After，但若代理/网关给了也照办（取两者中较晚的）。
function rateLimitWaitMs(res) {
  const waits = [];
  const ra = res.headers.get('retry-after');
  if (ra != null && ra !== '') {
    const s = Number(ra);
    if (Number.isFinite(s) && s >= 0) waits.push(s * 1000);
    else if (Number.isFinite(Date.parse(ra))) waits.push(Math.max(0, Date.parse(ra) - Date.now()));
  }
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) waits.push(Math.max(0, reset * 1000 - Date.now()));
  return waits.length ? Math.max(...waits) : null;
}
const expBackoff = (attempt) => backoffMs() * 2 ** (attempt - 1);
const withJitter = (ms) => ms + Math.random() * Math.min(250, ms * 0.1);
const RETRYABLE_5XX = new Set([500, 502, 503, 504]);

/**
 * retry：
 *   'idempotent'（GET 默认）—— 429、5xx、连不上时重试；超时不重试（已经等了一个完整超时）
 *   'rate'      —— 只在 429 时重试（429 表示请求被限流拒绝、没有被处理；用于带 clientOrderId 的下单）
 *   false       —— 不重试（DELETE、不带 clientOrderId 的下单）
 * 最多 MAX_TRIES 次请求，等待总和不超过 MAX_TOTAL_WAIT_MS；限流要求的等待超过上限就直接报错，不提前重试。
 */
async function request(method, pathname, { query, body, creds, retry = method === 'GET' ? 'idempotent' : false } = {}) {
  const c = creds ?? (await loadCreds());
  if (!c) throw new Error('尚未配置 Alpaca 模拟盘密钥');

  const url = new URL(pathname, PAPER_BASE);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  // 双保险：只允许模拟盘地址
  if (url.origin !== PAPER_BASE) throw new Error('拒绝请求：只允许连接 Alpaca 模拟盘');

  let waited = 0;
  for (let attempt = 1; ; attempt += 1) {
    let wait = null;
    let lastErr;
    let r;
    try {
      r = await sendOnce(method, url, c, body);
    } catch (e) {
      if (retry === 'idempotent' && e.kind === 'network') { lastErr = e; wait = withJitter(expBackoff(attempt)); } else throw e;
    }
    if (r) {
      const { res, text } = r;
      if (res.ok) {
        if (!text) return null;
        try {
          return JSON.parse(text);
        } catch {
          throw new Error('Alpaca 返回了无法解析的数据');
        }
      }
      lastErr = formatAlpacaError(res.status, text, res.statusText);
      if (res.status === 429 && (retry === 'idempotent' || retry === 'rate')) {
        wait = withJitter(rateLimitWaitMs(res) ?? expBackoff(attempt));
      } else if (retry === 'idempotent' && RETRYABLE_5XX.has(res.status)) {
        wait = withJitter(expBackoff(attempt));
      } else {
        throw lastErr;
      }
    }
    if (attempt >= MAX_TRIES) {
      if (lastErr.status === 429) lastErr.message += `（已请求 ${attempt} 次仍被限流，请稍后再试）`;
      throw lastErr;
    }
    if (waited + wait > MAX_TOTAL_WAIT_MS) {
      if (lastErr.status === 429) lastErr.message += `（限流要求再等 ${Math.ceil(wait / 1000)} 秒，超过 ${MAX_TOTAL_WAIT_MS / 1000} 秒上限，已放弃，请稍后再试）`;
      throw lastErr;
    }
    await sleep(wait);
    waited += wait;
  }
}

/* ---------------- 密钥 ---------------- */

/** 读取已保存的密钥；不存在或损坏时返回 null。 */
export async function loadCreds() {
  try {
    const j = JSON.parse(await readFile(credsFile(), 'utf8'));
    if (typeof j?.keyId === 'string' && typeof j?.secret === 'string' && j.keyId && j.secret) {
      return { keyId: j.keyId, secret: j.secret };
    }
    return null;
  } catch {
    return null;
  }
}

async function writeCredsAtomic(creds) {
  const file = credsFile();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const data = JSON.stringify({ keyId: creds.keyId, secret: creds.secret, savedAt: new Date().toISOString() }, null, 2);
  try {
    await writeFile(tmp, data, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/** 先用 GET /v2/account 在模拟盘验证，成功才写入文件。失败时不写任何东西。 */
export async function saveCreds({ keyId, secret } = {}) {
  const k = typeof keyId === 'string' ? keyId.trim() : '';
  const s = typeof secret === 'string' ? secret.trim() : '';
  const errors = [];
  if (!k) errors.push('请填写 API Key ID');
  if (!s) errors.push('请填写 Secret Key');
  if (errors.length) return { success: false, errors };

  let account;
  try {
    account = summarizeAccount(await request('GET', '/v2/account', { creds: { keyId: k, secret: s } }));
  } catch (e) {
    let msg = `模拟盘验证失败：${e.message}`;
    if ((e.status === 401 || e.status === 403) && /^AK/i.test(k)) {
      msg += '（这个 Key 看起来是实盘密钥，Helm 只支持模拟盘，请在 Alpaca 后台切换到 Paper 后生成密钥）';
    }
    return { success: false, errors: [msg] };
  }
  try {
    await writeCredsAtomic({ keyId: k, secret: s });
  } catch (e) {
    return { success: false, errors: [`密钥保存失败：${e.message}`] };
  }
  return { success: true, account };
}

/** 删除已保存的密钥。 */
export async function clearCreds() {
  await rm(credsFile(), { force: true });
  return { success: true };
}

/** 连接状态：有密钥就调用 /v2/account 确认。 */
export async function status() {
  const c = await loadCreds();
  if (!c) return { connected: false };
  const keyIdMasked = maskKeyId(c.keyId);
  try {
    const account = summarizeAccount(await request('GET', '/v2/account', { creds: c }));
    return { connected: true, keyIdMasked, account };
  } catch (e) {
    return { connected: false, keyIdMasked, error: e.message };
  }
}

/* ---------------- 交易接口 ---------------- */

export async function getAccount() {
  return summarizeAccount(await request('GET', '/v2/account'));
}

export async function getPositions() {
  const list = await request('GET', '/v2/positions');
  return Array.isArray(list) ? list.map(summarizePosition) : [];
}

export async function getClock() {
  const c = (await request('GET', '/v2/clock')) ?? {};
  return { isOpen: Boolean(c.is_open), nextOpen: c.next_open ?? null, nextClose: c.next_close ?? null, timestamp: c.timestamp ?? null };
}

export async function listOrders({ status: st = 'all', limit = 100, after } = {}) {
  if (!['open', 'closed', 'all'].includes(st)) throw new Error(`订单状态参数无效：${st}`);
  const lim = Math.min(500, Math.max(1, Math.floor(num(limit, 100))));
  const list = await request('GET', '/v2/orders', { query: { status: st, limit: lim, after, direction: 'desc' } });
  return Array.isArray(list) ? list.map(summarizeOrder) : [];
}

const TIFS = ['day', 'gtc', 'opg', 'cls', 'ioc', 'fok'];

export async function submitOrder({ symbol, qty, side, type = 'market', timeInForce = 'day', clientOrderId, limitPrice } = {}) {
  const sym = normalizeSymbol(symbol);
  if (!sym || !/^[A-Z0-9.\-]+$/.test(sym)) throw new Error(`股票代码无效：${symbol}`);
  const q = Number(qty);
  if (!Number.isInteger(q) || q <= 0) throw new Error(`下单数量必须是正整数股：${qty}`);
  if (side !== 'buy' && side !== 'sell') throw new Error(`买卖方向无效：${side}（只能是 buy 或 sell）`);
  if (type !== 'market' && type !== 'limit') throw new Error(`订单类型无效：${type}（只支持 market / limit）`);
  if (!TIFS.includes(timeInForce)) throw new Error(`有效期参数无效：${timeInForce}`);
  const body = { symbol: sym, qty: String(q), side, type, time_in_force: timeInForce };
  if (type === 'limit') {
    const lp = Number(limitPrice);
    if (!Number.isFinite(lp) || lp <= 0) throw new Error('限价单必须提供有效的限价');
    body.limit_price = String(lp);
  }
  const coid = clientOrderId ? String(clientOrderId).slice(0, 128) : '';
  // 没有 clientOrderId 就无法确认“上一次到底下没下成”，所以完全不重试
  if (!coid) return summarizeOrder(await request('POST', '/v2/orders', { body, retry: false }));
  body.client_order_id = coid;

  // 有 clientOrderId：超时 / 连不上 / 5xx 时结果不确定，先按 clientOrderId 查一下：
  // 查到了就当作已提交；确定没有（404）才用同一个 clientOrderId 重下，最多重下 1 次。
  // Alpaca 对 client_order_id 做唯一性校验，即使查询有延迟，重下也不会产生第二笔订单。
  const ambiguous = (e) => e.kind === 'timeout' || e.kind === 'network' || RETRYABLE_5XX.has(e.status);
  const lookup = async (cause) => {
    try {
      return await getOrderByClientOrderId(coid);
    } catch (le) {
      throw Object.assign(new Error(`下单结果不确定：${cause.message}；按 clientOrderId ${coid} 查询也失败（${le.message}）。为避免重复下单没有重试，请到 Alpaca 网站核对`), { uncertain: true, clientOrderId: coid });
    }
  };
  for (let posts = 1; ; posts += 1) {
    try {
      return summarizeOrder(await request('POST', '/v2/orders', { body, retry: 'rate' }));
    } catch (e) {
      // 重下时被告知 client_order_id 重复：说明第一次其实已经到了，查出来返回
      const dup = posts > 1 && e.status === 422 && /client_order_id|unique/i.test(e.message);
      if (!ambiguous(e) && !dup) throw e;
      const found = await lookup(e);
      if (found) return { ...summarizeOrder(found), recovered: true };
      if (posts >= 2) throw Object.assign(new Error(`下单失败：${e.message}（已用同一个 clientOrderId 重下 1 次，Alpaca 上仍查不到这笔订单）`), { clientOrderId: coid });
    }
  }
}

/**
 * 按 clientOrderId 查订单原始对象；不存在（404）返回 null。
 * GET /v2/orders:by_client_order_id?client_order_id=… —— https://docs.alpaca.markets/reference/getorderbyclientorderid
 */
export async function getOrderByClientOrderId(clientOrderId) {
  const coid = String(clientOrderId ?? '');
  if (!coid) throw new Error('查询订单需要 clientOrderId');
  try {
    return await request('GET', '/v2/orders:by_client_order_id', { query: { client_order_id: coid } });
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

/**
 * 查一个代码在 Alpaca 的资产信息。GET /v2/assets/{symbol} —— https://docs.alpaca.markets/reference/get-v2-assets-symbol_or_asset_id
 * 字段 status 为 active / inactive，tradable 表示能否在 Alpaca 交易。
 */
export async function getAsset(symbol) {
  const sym = normalizeSymbol(symbol);
  if (!sym || !/^[A-Z0-9.\-]+$/.test(sym)) throw new Error(`股票代码无效：${symbol}`);
  const a = (await request('GET', `/v2/assets/${encodeURIComponent(sym)}`)) ?? {};
  return {
    symbol: normalizeSymbol(a.symbol ?? sym),
    name: a.name ?? null,
    exchange: a.exchange ?? null,
    assetClass: a.class ?? null,
    status: a.status ?? null,
    tradable: a.tradable === true,
    fractionable: a.fractionable === true,
  };
}

// Alpaca 明确说“没有这个资产”的 404（区别于路径不存在之类的普通 404）
const isAssetNotFound = (e) => e?.status === 404 && (e.alpacaCode === 40410000 || /asset/i.test(e.message));

/**
 * 检查一批代码能否买入。结果按代码缓存在 cache（Map）里，同一次运行重复调用不会重复请求。
 * 返回 { ok: [代码], untradable: [{symbol, reason}], unknown: [{symbol, error}] }。
 * unknown = 查询失败、无法确认（不跳过，交给 Alpaca 下单时校验）。
 */
export async function checkAssets(symbols = [], { cache = new Map() } = {}) {
  const out = { ok: [], untradable: [], unknown: [] };
  for (const s of [...new Set([...symbols].map(normalizeSymbol).filter(Boolean))]) {
    if (!cache.has(s)) {
      let v;
      try {
        const a = await getAsset(s);
        if (!a.tradable) v = { ok: false, reason: `Alpaca 显示 ${s} 不可交易（tradable=false），跳过买入` };
        else if (a.status !== 'active') v = { ok: false, reason: `${s} 在 Alpaca 的状态是 ${a.status ?? '未知'}（不是 active），跳过买入` };
        else v = { ok: true };
      } catch (e) {
        v = isAssetNotFound(e) ? { ok: false, reason: `Alpaca 找不到代码 ${s}，跳过买入` } : { ok: null, error: e.message };
      }
      cache.set(s, v);
    }
    const v = cache.get(s);
    if (v.ok === true) out.ok.push(s);
    else if (v.ok === false) out.untradable.push({ symbol: s, reason: v.reason });
    else out.unknown.push({ symbol: s, error: v.error });
  }
  return out;
}

export async function cancelOrder(id) {
  if (!id || typeof id !== 'string') throw new Error('撤单需要订单 ID');
  await request('DELETE', `/v2/orders/${encodeURIComponent(id)}`);
  return { success: true, id };
}

/* ---------------- 调仓计划（纯函数） ---------------- */

/**
 * 根据目标权重生成调仓计划。纯函数、同步、不访问网络。
 * @param {object} p
 * @param {Record<string, number>} p.targets  目标权重 {SYMBOL: 0..1}
 * @param {number} p.equity                   账户净值
 * @param {Array}  p.positions                getPositions() 的结果
 * @param {Record<string, number>} p.prices   最新价（缺失时用持仓 currentPrice）
 * @param {object} [p.opts]  maxGross=0.98, minTradeValue=50, minWeightDiff=0.005,
 *                           cash（可选，默认 = 净值 − 多头持仓市值），
 *                           untradable（可选，checkAssets() 判定不可交易的代码：不买也不卖，现有仓位保持不动）
 */
export function planRebalance({ targets = {}, equity, positions = [], prices = {}, opts = {} } = {}) {
  const maxGross = num(opts.maxGross, 0.98);
  const minTradeValue = num(opts.minTradeValue, 50);
  const minWeightDiff = num(opts.minWeightDiff, 0.005);
  const untradable = new Set([...(opts.untradable || [])].map((x) => normalizeSymbol(typeof x === 'string' ? x : x?.symbol)).filter(Boolean));
  const orders = [];
  const skipped = [];
  const targetValue = {};
  const notes = [];
  const eq = num(equity, 0);

  if (!(eq > 0)) {
    notes.push('账户净值无效或为 0，无法生成调仓计划');
    return { orders, skipped, targetValue, notes };
  }

  // 价格表：键统一规范化
  const px = {};
  for (const [k, v] of Object.entries(prices || {})) {
    const p = num(v, NaN);
    if (p > 0) px[normalizeSymbol(k)] = p;
  }

  // 目标权重：规范化、校验、合并重复键（单个权重超过 1 的杠杆目标交给下面的总仓位缩放）
  const tw = {};
  const keep = new Set();
  for (const [k, v] of Object.entries(targets || {})) {
    const sym = normalizeSymbol(k);
    const w = Number(v);
    if (!sym) continue;
    // 权重无效时这个代码保持不动（绝不能因为目标没读懂就把它当成“不在目标里”全部卖掉）
    if (!Number.isFinite(w) || w < 0) {
      skipped.push({ symbol: sym, reason: `目标权重无效：${v}，保持现有仓位不动` });
      keep.add(sym);
      continue;
    }
    tw[sym] = (tw[sym] ?? 0) + w;
  }
  const gross = Object.values(tw).reduce((a, b) => a + b, 0);
  if (gross > maxGross + 1e-12) {
    const f = maxGross / gross;
    for (const s of Object.keys(tw)) tw[s] *= f;
    notes.push(`目标总仓位 ${(gross * 100).toFixed(1)}% 超过上限 ${(maxGross * 100).toFixed(1)}%，已按比例缩放`);
  }

  // 当前持仓
  const pos = {};
  let longValue = 0;
  for (const p of positions || []) {
    const sym = normalizeSymbol(p.symbol);
    if (!sym) continue;
    const qty = num(p.qty);
    if (p.side === 'short' || qty < 0) {
      skipped.push({ symbol: sym, reason: '空头持仓，调仓计划不处理，请手动平仓' });
      pos[sym] = { short: true };
      continue;
    }
    const cur = pos[sym] ?? { qty: 0, currentPrice: 0, marketValue: 0 };
    cur.qty += qty;
    cur.currentPrice = num(p.currentPrice) || cur.currentPrice;
    cur.marketValue += num(p.marketValue, qty * num(p.currentPrice));
    pos[sym] = cur;
    longValue += num(p.marketValue, qty * num(p.currentPrice));
  }

  const sells = [];
  const buys = [];
  const symbols = [...new Set([...Object.keys(tw), ...Object.keys(pos)])].sort();

  for (const sym of symbols) {
    const cur = pos[sym];
    if (cur?.short || keep.has(sym)) continue;
    // 不可交易：绝不能因为它买不了就把它（或别的持仓）卖掉，原样保持
    if (untradable.has(sym)) {
      skipped.push({ symbol: sym, reason: 'Alpaca 显示不可交易，不买也不卖，保持现有仓位不动' });
      continue;
    }
    const inTargets = Object.prototype.hasOwnProperty.call(tw, sym);
    const w = inTargets ? tw[sym] : 0;
    targetValue[sym] = round2(w * eq);
    const curQty = cur?.qty ?? 0;
    const price = px[sym] ?? (cur?.currentPrice > 0 ? cur.currentPrice : undefined);

    if (!(price > 0)) {
      skipped.push({ symbol: sym, reason: '缺少价格，无法计算股数' });
      continue;
    }

    // 清仓（不在目标中，或目标权重为 0）：不受阈值限制
    if (w === 0) {
      if (curQty <= 0) continue;
      const q = floorQty(curQty);
      if (q < curQty - 1e-9) notes.push(`${sym} 有零碎股 ${round2(curQty - q)} 股未纳入整股卖单，需手动处理`);
      if (q <= 0) {
        skipped.push({ symbol: sym, reason: '持仓不足 1 股，无法整股卖出' });
        continue;
      }
      sells.push({ symbol: sym, side: 'sell', qty: q, estValue: round2(q * price), reason: inTargets ? '目标权重为 0，清仓' : '不在目标中，全部卖出' });
      continue;
    }

    const curW = (curQty * price) / eq;
    const diffW = Math.abs(w - curW);
    if (diffW < minWeightDiff) {
      skipped.push({ symbol: sym, reason: `权重变化 ${(diffW * 100).toFixed(2)}% 低于阈值 ${(minWeightDiff * 100).toFixed(2)}%` });
      continue;
    }

    const targetQty = floorQty((w * eq) / price);
    const delta = targetQty - curQty;
    const q = floorQty(Math.abs(delta));
    if (q <= 0) {
      skipped.push({ symbol: sym, reason: '按整股取整后无需调整' });
      continue;
    }
    const est = round2(q * price);
    if (est < minTradeValue) {
      skipped.push({ symbol: sym, reason: `交易金额 $${est} 低于最小交易额 $${minTradeValue}` });
      continue;
    }
    const pct = `${(curW * 100).toFixed(2)}% → ${(w * 100).toFixed(2)}%`;
    if (delta > 0) buys.push({ symbol: sym, side: 'buy', qty: q, estValue: est, reason: curQty > 0 ? `加仓 ${pct}` : `新建仓 ${pct}` });
    else sells.push({ symbol: sym, side: 'sell', qty: q, estValue: est, reason: `减仓 ${pct}` });
  }

  // 现金约束：买入总额不能超过（现金 + 卖出所得）
  const cash = opts.cash !== undefined ? num(opts.cash) : eq - longValue;
  const sellProceeds = sells.reduce((a, o) => a + o.estValue, 0);
  const available = cash + sellProceeds;
  const buyTotal = buys.reduce((a, o) => a + o.estValue, 0);
  let finalBuys = buys;
  if (buyTotal > available + 1e-6) {
    const f = Math.max(0, available) / buyTotal;
    finalBuys = [];
    for (const o of buys) {
      const price = o.estValue / o.qty;
      const q = floorQty(o.qty * f);
      const est = round2(q * price);
      if (q <= 0 || est < minTradeValue) {
        skipped.push({ symbol: o.symbol, reason: '现金不足，缩减后买入量过小' });
        continue;
      }
      finalBuys.push({ ...o, qty: q, estValue: est, reason: `${o.reason}（现金不足，已缩减）` });
    }
    notes.push(`预计买入 $${round2(buyTotal)} 超过卖出后可用现金 $${round2(available)}，买单已按 ${(f * 100).toFixed(1)}% 缩减`);
  }

  sells.sort((a, b) => b.estValue - a.estValue);
  finalBuys.sort((a, b) => b.estValue - a.estValue);
  return { orders: [...sells, ...finalBuys], skipped, targetValue, notes };
}

/* ---------------- 执行计划 ---------------- */

function defaultTag() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `helm-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

/**
 * 按“先卖后买”顺序逐笔提交。单笔失败（包括 clientOrderId 重复）记入 errors，不抛出。
 * 非 dryRun 时：
 *   - 先查账户，account_blocked / trading_blocked / trade_suspended_by_user 时抛出中文错误（一笔都不下）；
 *   - 每笔买单先查资产，不可交易的跳过，记入 skipped 和 errors（skipped: true），其他订单照常；
 *     assetCache（Map）可以和 checkAssets() 共用，同一次运行不重复查询。
 * 返回 { submitted, errors, skipped }。
 */
export async function executePlan(plan, { dryRun = false, tag, assetCache = new Map(), checkAccount = true, checkAssets: doCheckAssets = true } = {}) {
  const submitted = [];
  const errors = [];
  const skipped = [];
  const list = Array.isArray(plan?.orders) ? plan.orders : [];
  const ordered = [...list.filter((o) => o.side === 'sell'), ...list.filter((o) => o.side === 'buy')];
  for (const o of list) {
    if (o.side !== 'sell' && o.side !== 'buy') errors.push({ symbol: o.symbol, side: o.side, qty: o.qty, error: `买卖方向无效：${o.side}` });
  }
  const t = String(tag || defaultTag()).replace(/[^A-Za-z0-9._-]/g, '-');

  if (!dryRun && checkAccount && ordered.length) assertCanTrade(await getAccount());

  for (const o of ordered) {
    const symbol = normalizeSymbol(o.symbol);
    const clientOrderId = `${t}-${symbol}-${o.side}`.slice(0, 48);
    if (dryRun) {
      submitted.push({ symbol, side: o.side, qty: o.qty, id: null, status: 'dry_run', clientOrderId });
      continue;
    }
    if (o.side === 'buy' && doCheckAssets) {
      const chk = await checkAssets([symbol], { cache: assetCache });
      if (chk.untradable.length) {
        const reason = chk.untradable[0].reason;
        skipped.push({ symbol, side: o.side, qty: o.qty, reason });
        errors.push({ symbol, side: o.side, qty: o.qty, error: reason, skipped: true });
        continue;
      }
    }
    try {
      const r = await submitOrder({ symbol, qty: o.qty, side: o.side, type: 'market', timeInForce: 'day', clientOrderId });
      submitted.push({ symbol, side: o.side, qty: o.qty, id: r.id, status: r.status, clientOrderId, ...(r.recovered ? { recovered: true } : {}) });
    } catch (e) {
      errors.push({ symbol, side: o.side, qty: o.qty, error: e.message, ...(e.uncertain ? { uncertain: true } : {}) });
    }
  }
  return { submitted, errors, skipped };
}
