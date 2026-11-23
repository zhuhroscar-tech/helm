// 模拟实盘（前向检验）：把一个跑完的回测“冻结”，之后每个交易日收盘后用最新数据重跑一次，
// 冻结日之后的那段收益就是真正没见过的数据。两种模式：
//   sim    —— Helm 内部记账，成交按 LEAN 的成交模型
//   alpaca —— 同样算出目标持仓，再到用户自己的 Alpaca 模拟账户下单（只连模拟环境）
// 冻结后代码不能改；要改就开一段新的模拟。
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { readFile, writeFile, mkdir, readdir, rm, rename, cp, appendFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { PROJECTS_DIR, DATA_DIR, ROOT, runLean, fetchData, tickersInCode, findAlgorithmClass, withFileLock } from './engine.mjs';
import { isTradingDay, prevTradingDay } from './market-calendar.mjs';
import { readJsonFile, writeJsonAtomic, appendLine } from './fs-atomic.mjs';

const ok = (extra = {}) => ({ success: true, errors: [], ...extra });
const fail = (msg) => ({ success: false, errors: [msg] });
const now = () => new Date().toISOString();
// 错误信息里的绝对路径（ENOENT 之类）换成相对写法：网页、MCP 和每日记录里不该出现用户的目录结构
const scrubPaths = (x) => String(x).split(PROJECTS_DIR).join('projects').split(ROOT).join('.').split(os.homedir()).join('~');
const SID = /^p[0-9a-z]{6,24}$/;
const SAFE_FILE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,80}\.py$/;
export const MODES = ['sim', 'alpaca'];
// 交易日 D 的数据在美东 D+1 日 00:00 之后才跑：LEAN 回测的结束日期最多到「美东时间的昨天」
// （engine/Lean/Algorithm/QCAlgorithm.cs SetEndDate），收盘当晚跑只能跑到前一天，会报「LEAN 只跑到…」。
// 订单本来就是下一个交易日开盘成交，晚几个小时提交不影响成交价。
export const RUN_AFTER_ET = '00:00';

// 服务器订阅运行结果，推送给网页
const listeners = new Set();
export function onPaperEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const emit = (ev) => { for (const fn of listeners) { try { fn(ev); } catch { /* 忽略 */ } } };

let alpacaMod = null;
async function alpaca() {
  if (!alpacaMod) alpacaMod = await import('./alpaca.mjs');
  return alpacaMod;
}

const readJson = readJsonFile; // lib/fs-atomic.mjs：写入先 fsync；损坏的文件记日志
const writeJson = writeJsonAtomic;

const pdir = (pid) => path.join(PROJECTS_DIR, String(Number(pid)));
const sdir = (pid, sid) => path.join(pdir(pid), 'paper', sid);
const bdir = (pid, bid) => path.join(pdir(pid), 'backtests', bid);

/* ---------------- 美东时间和交易日 ---------------- */

function etParts(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false });
  const o = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${o.year}-${o.month}-${o.day}`, hm: `${o.hour === '24' ? '00' : o.hour}:${o.minute}`, weekday: o.weekday };
}
const isWeekend = (wd) => wd === 'Sat' || wd === 'Sun';
function prevWeekday(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  do { d.setUTCDate(d.getUTCDate() - 1); } while ([0, 6].includes(d.getUTCDay()));
  return d.toISOString().slice(0, 10);
}
// 现在应该能拿到的最近一个完整交易日（不考虑节假日；节假日由数据本身决定）
export function expectedDataDate(d = new Date()) {
  return prevWeekday(etParts(d).date);
}
// 同上，但跳过美股休市日（lib/market-calendar.mjs）：休市那天不会有新数据，“应该有的数据日”是上一个交易日。
// 用在「数据够不够新」的判断和定时任务上，这样休市日不会被当成数据过期、每 3 小时白跑一次。
// 读日线时的上限仍然用 expectedDataDate：有没有那天的数据由数据本身说了算，日历万一错了也不会漏掉真实的日线。
export function expectedTradingDate(d = new Date()) {
  return prevTradingDay(etParts(d).date);
}

/* ---------------- LEAN 数据：读日线 zip ---------------- */

// 日线 zip 的全部行。一次运行里同一只股票会读好几遍（持仓估值、执行偏差、SPY 交易日表、预期检验），
// 每次都开一个 unzip 进程；按「路径 + 修改时间 + 大小」缓存（数据每天更新时 zip 会变，自动重读），并发调用共用同一次读取。
const ZIP_CACHE = new Map();
const ZIP_CACHE_MAX = 64;
function readZipLines(ticker) {
  const z = path.join(DATA_DIR, 'equity', 'usa', 'daily', `${String(ticker).toLowerCase().replace(/-/g, '.')}.zip`);
  let st;
  try { st = statSync(z); } catch { return Promise.resolve([]); }
  const sig = `${st.mtimeMs}:${st.size}`;
  const hit = ZIP_CACHE.get(z);
  if (hit && hit.sig === sig) { ZIP_CACHE.delete(z); ZIP_CACHE.set(z, hit); return hit.p; }
  const p = new Promise((resolve) => {
    execFile('unzip', ['-p', z], { maxBuffer: 64 << 20 }, (err, out) => {
      if (err) ZIP_CACHE.delete(z); // 读失败不缓存
      resolve(err ? [] : String(out).trim().split('\n'));
    });
  });
  ZIP_CACHE.set(z, { sig, p });
  while (ZIP_CACHE.size > ZIP_CACHE_MAX) ZIP_CACHE.delete(ZIP_CACHE.keys().next().value);
  return p;
}
const lineDate = (l) => `${l.slice(0, 4)}-${l.slice(4, 6)}-${l.slice(6, 8)}`;
const lineClose = (l) => Number(l.split(',')[4]) / 10000;

// 不晚于 limit 的最后一根日线
async function lastBar(ticker, limit) {
  const lines = await readZipLines(ticker);
  for (let i = lines.length - 1; i >= 0; i--) {
    const d = lineDate(lines[i]);
    if (d <= limit) return { date: d, close: lineClose(lines[i]) };
  }
  return null;
}

/* ---------------- 冻结代码 → 每次运行时只改结束日期 ---------------- */

export function patchEndDate(code, iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const call = `self.set_end_date(${y}, ${m}, ${d})`;
  // 只认行首的真实调用（不认注释），括号可以嵌套一层，例如 set_end_date(datetime(2019, 1, 1))；同一行后面的语句原样保留
  const ARGS = '(?:[^()\\n]|\\([^()\\n]*\\))*';
  const re = new RegExp(`^([ \\t]*)self\\.(?:set_end_date|SetEndDate)\\(${ARGS}\\)`, 'gm');
  const hits = code.match(re);
  if (hits) return code.replace(re, (_m, ind) => `${ind}${call}`);
  const st = code.match(/^([ \t]*)self\.(set_start_date|SetStartDate)\([^\n]*\)[^\n]*$/m);
  if (!st) return null;
  return code.replace(st[0], `${st[0]}\n${st[1]}${call}`);
}

/* ---------------- 从 LEAN 结果推出持仓 ---------------- */

function seriesOf(result, chart, prefer) {
  const c = result && result.charts && result.charts[chart];
  if (!c || !c.series) return [];
  const s = c.series[prefer] || Object.values(c.series)[0];
  const vals = Array.isArray(s && s.values) ? s.values : Object.values((s && s.values) || {});
  const out = [];
  for (const p of vals) {
    let t; let v;
    if (Array.isArray(p)) { t = p[0]; v = p[p.length - 1]; } else if (p && typeof p === 'object') { t = p.x ?? p.time; v = p.y ?? p.close ?? p.value; }
    t = +t; v = +v;
    if (Number.isFinite(t) && Number.isFinite(v)) out.push([t > 1e12 ? t / 1000 : t, v]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}
// 每个交易日一个点（YYYY-MM-DD）。LEAN 在纽约午夜记的点是前一天的收盘值，所以用 t-6h 的日期归类：
// 午夜点（04/05Z）归到前一天，收盘点（20/21Z）归到当天；同一天取最后一个。只保留 SPY 有日线的日子（去掉节假日）。
export function daily(points, tradingDays) {
  const m = new Map();
  for (const [t, v] of points) {
    const d = new Date((t - 6 * 3600) * 1000).toISOString().slice(0, 10);
    if (tradingDays ? tradingDays.has(d) : ![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())) m.set(d, v);
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}
async function tradingDaySet() {
  return new Set((await readZipLines('SPY')).map(lineDate));
}

// LEAN 订单状态：0 新建 1 已提交 2 部分成交 3 已成交 5 已取消 9 修改已提交（仍是挂单）
// events（LEAN 的 <id>-order-events.json，可选）：有的话按每笔成交的 fillQuantity（带符号）算已成交股数，
// 这样「部分成交后取消」的订单不会丢掉已成交的那部分，部分成交的挂单也只把没成交的余量算作待执行。
const OPEN_STATUS = new Set([0, 1, 2, 9]);
const symOf = (o) => String((o.symbol && (o.symbol.value || o.symbol.permtick)) || '').toUpperCase();
export function positionsFromOrders(orders, events = null) {
  const filled = {}; const pending = {};
  const list = Object.values(orders || {});
  if (Array.isArray(events) && events.length) {
    const byOrder = {};
    for (const e of events) {
      const q = Number(e && e.fillQuantity);
      if (!q || !Number.isFinite(q)) continue;
      byOrder[e.orderId] = (byOrder[e.orderId] || 0) + q;
      const sym = String(e.symbolValue || e.symbolPermtick || '').toUpperCase();
      if (sym) filled[sym] = (filled[sym] || 0) + q;
    }
    for (const o of list) {
      const sym = symOf(o);
      if (!sym || !Number.isFinite(+o.quantity) || !OPEN_STATUS.has(o.status)) continue;
      const rest = Number(o.quantity) - (byOrder[o.id] || 0);
      if (Math.abs(rest) > 1e-9) pending[sym] = (pending[sym] || 0) + rest;
    }
  } else {
    for (const o of list) {
      const sym = symOf(o);
      if (!sym || !Number.isFinite(+o.quantity)) continue;
      if (o.status === 3) filled[sym] = (filled[sym] || 0) + Number(o.quantity);
      else if (OPEN_STATUS.has(o.status)) pending[sym] = (pending[sym] || 0) + Number(o.quantity);
    }
  }
  for (const k of Object.keys(filled)) if (Math.abs(filled[k]) < 1e-9) delete filled[k];
  return { filled, pending };
}

/* ---------------- 执行偏差（implementation shortfall）：上一次下的单实际成交得怎样 ---------------- */
// 只读：不影响下单。参考价 = 上一次计划用的价格（数据日的 LEAN 日线收盘价；不在目标里的持仓用当时的持仓现价），
// 和下单逻辑 planRebalance 的取价顺序一致。正数 = 比计划差（买贵了 / 卖便宜了）。

export const DRIFT_SIM = { applicable: false, reason: '内部模拟按 LEAN 的成交规则记账，没有真实成交可以对比，不计算执行偏差。' };
const driftOn = () => process.env.HELM_PAPER_DRIFT !== '0'; // 测试用开关：=0 时完全不算（用来对比下单是否完全一致）
const normSym = (x) => String(x ?? '').trim().toUpperCase().replace(/[\s/]+/g, '.'); // 与 alpaca.normalizeSymbol 相同
const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const fnum = (x) => { const v = Number(x); return x != null && x !== '' && Number.isFinite(v) ? v : null; };
const DONE_UNFILLED = { canceled: 'canceled', cancelled: 'canceled', expired: 'expired', done_for_day: 'expired', stopped: 'canceled', suspended: 'canceled' };
export const DRIFT_STATUS_ZH = { filled: '全部成交', partial: '部分成交', rejected: '被拒绝', canceled: '已撤销未成交', expired: '过期未成交', pending: '还在等待成交', missing: 'Alpaca 查不到这笔单', none: '无需下单' };

// 上一次真正做过调仓计划的运行（数据日早于这次）
export function prevPlanRun(log, dataDate) {
  for (let i = (log || []).length - 1; i >= 0; i--) {
    const x = log[i];
    if (x && x.dataDate < dataDate && x.alpaca && x.alpaca.plan) return x;
  }
  return null;
}

/**
 * 纯函数。prev：上一次运行的快照（log.jsonl 里的一行）；orders：Alpaca 订单（listOrders 的结果，按这个模拟 + 那个数据日的 clientOrderId 前缀筛选）；
 * positions / account：现在的 Alpaca 持仓和账户；pricesNow：现在的价格（算没成交部分的机会成本）。
 */
export function driftFromData({ sessionId, prev, orders = [], positions = [], account = {}, pricesNow = {} }) {
  const pa = prev.alpaca || {};
  const plan = pa.plan || { orders: [], targetValue: {} };
  const tag = `${sessionId}-${String(prev.dataDate).replace(/-/g, '')}-`;
  const planEq = fnum(pa.planEquity) || fnum(pa.account && pa.account.equity);
  const eqNow = fnum(account.equity);
  // 参考价：和 planRebalance 的取价一致（目标持仓的收盘价优先，没有就用当时的持仓现价）
  const refPx = {};
  for (const p of pa.positions || []) { const v = fnum(p.currentPrice); if (v > 0) refPx[normSym(p.symbol)] = { price: v, source: '当时持仓现价' }; }
  for (const [k, h] of Object.entries(prev.holdings || {})) { const v = fnum(h && h.price); if (v > 0) refPx[normSym(k)] = { price: v, source: `${prev.dataDate} 收盘价` }; }
  // 那个数据日下的单（同一代码同一方向合并）
  const got = {};
  for (const o of orders || []) {
    if (!String(o.clientOrderId || '').startsWith(tag)) continue;
    const key = `${normSym(o.symbol)}|${o.side}`;
    const g = got[key] || (got[key] = { qty: 0, filledQty: 0, notional: 0, statuses: [] });
    const fq = fnum(o.filledQty) || 0; const fp = fnum(o.filledAvgPrice);
    g.qty += fnum(o.qty) || 0; g.filledQty += fq; if (fq > 0 && fp > 0) g.notional += fq * fp;
    g.statuses.push(o.status);
  }
  const errs = {};
  for (const e of pa.errors || []) errs[`${normSym(e.symbol)}|${e.side}`] = e;
  const posNow = {};
  for (const p of positions || []) { const s = normSym(p.symbol); const c = posNow[s] || (posNow[s] = { qty: 0, marketValue: 0 }); c.qty += fnum(p.qty) || 0; c.marketValue += fnum(p.marketValue) || 0; }
  const targetW = {};
  for (const [k, v] of Object.entries(plan.targetValue || {})) { const tv = fnum(v); if (tv > 0 && planEq > 0) targetW[normSym(k)] = tv / planEq; }
  const actualW = (s) => (!(eqNow > 0) ? null : posNow[s] ? r4(posNow[s].marketValue / eqNow) : 0);

  const rows = [];
  const seen = new Set();
  for (const po of plan.orders || []) {
    const symbol = normSym(po.symbol); const side = po.side; const key = `${symbol}|${side}`;
    seen.add(symbol);
    const qty = fnum(po.qty) || 0;
    const g = got[key]; const err = errs[key];
    const filledQty = g ? g.filledQty : 0;
    const fillPx = g && g.filledQty > 0 && g.notional > 0 ? g.notional / g.filledQty : null;
    let status;
    if (!g) status = err ? 'rejected' : 'missing';
    else if (filledQty >= qty - 1e-9) status = 'filled';
    else if (g.statuses.includes('rejected')) status = 'rejected';
    else if (filledQty > 0) status = 'partial';
    else status = DONE_UNFILLED[g.statuses[g.statuses.length - 1]] || 'pending';
    const ref = refPx[symbol] || (fnum(po.estValue) > 0 && qty > 0 ? { price: po.estValue / qty, source: '计划估算价' } : null);
    const sign = side === 'buy' ? 1 : -1;
    const slipOk = filledQty > 0 && fillPx > 0 && ref && ref.price > 0;
    const unfilled = Math.max(0, qty - filledQty);
    const pNow = fnum(pricesNow[symbol]);
    rows.push({
      symbol, side, qty, filledQty, status, statusZh: DRIFT_STATUS_ZH[status],
      error: err ? err.error : (status === 'rejected' ? 'Alpaca 拒绝了这笔单' : null),
      refPrice: ref ? r4(ref.price) : null, refSource: ref ? ref.source : null,
      fillPrice: fillPx != null ? r4(fillPx) : null,
      slippageBps: slipOk ? r2(((sign * (fillPx - ref.price)) / ref.price) * 1e4) : null,
      slippageUsd: slipOk ? r2(sign * (fillPx - ref.price) * filledQty) : null,
      unfilledQty: unfilled,
      opportunityUsd: unfilled > 0 ? (pNow > 0 && ref && ref.price > 0 ? r2(sign * (pNow - ref.price) * unfilled) : null) : 0,
      targetWeight: symbol in targetW ? r4(targetW[symbol]) : 0,
      actualWeight: actualW(symbol),
    });
  }
  // 目标里有、但这次不用下单的代码（权重变化太小等）：也对比一下实际权重
  for (const symbol of Object.keys(targetW).sort()) {
    if (seen.has(symbol)) continue;
    const ref = refPx[symbol];
    rows.push({ symbol, side: null, qty: 0, filledQty: 0, status: 'none', statusZh: DRIFT_STATUS_ZH.none, error: null, refPrice: ref ? r4(ref.price) : null, refSource: ref ? ref.source : null, fillPrice: null, slippageBps: null, slippageUsd: null, unfilledQty: 0, opportunityUsd: 0, targetWeight: r4(targetW[symbol]), actualWeight: actualW(symbol) });
  }
  const untargeted = Object.entries(posNow).filter(([s, p]) => !(s in targetW) && Math.abs(p.qty) > 1e-9)
    .map(([symbol, p]) => ({ symbol, qty: p.qty, marketValue: r2(p.marketValue), weight: eqNow > 0 ? r4(p.marketValue / eqNow) : null }));

  const orderRows = rows.filter((x) => x.status !== 'none');
  const executionCost = r2(orderRows.reduce((a, x) => a + (x.slippageUsd || 0), 0));
  const opportunityCost = r2(orderRows.reduce((a, x) => a + (x.opportunityUsd || 0), 0));
  const shortfall = r2(executionCost + opportunityCost);
  const filledRefNotional = orderRows.reduce((a, x) => a + (x.slippageUsd != null ? x.refPrice * x.filledQty : 0), 0);
  return {
    applicable: true, available: true,
    against: prev.dataDate, prevRunAt: prev.runAt || null, computedAt: now(),
    planEquity: planEq, equityNow: eqNow,
    rows, untargeted,
    totals: {
      orders: orderRows.length,
      notFullyFilled: orderRows.filter((x) => x.status !== 'filled').length,
      pending: orderRows.filter((x) => x.status === 'pending').length,
      executionCostUsd: executionCost, // 已成交部分：成交均价 vs 参考价
      opportunityCostUsd: opportunityCost, // 没成交部分：现价 vs 参考价（错过的涨跌）
      missingPrice: orderRows.filter((x) => x.opportunityUsd == null).map((x) => x.symbol),
      shortfallUsd: shortfall,
      shortfallBps: planEq > 0 ? r2((shortfall / planEq) * 1e4) : null, // 占下单时的账户净值
      avgSlippageBps: filledRefNotional > 0 ? r2((executionCost / filledRefNotional) * 1e4) : null, // 按成交额加权
      untargetedCount: untargeted.length,
    },
    note: `参考价是 ${prev.dataDate} 收盘后做计划时用的价格（LEAN 日线收盘价，复权数据），订单在下一个交易日开盘成交，所以滑点包含隔夜跳空。正数 = 比计划差。实际权重用的是现在的持仓市值，包含成交之后的行情变化。`,
  };
}

// 在调仓计划之前调用：只读 Alpaca（订单 / 持仓 / 账户），出错不影响这次运行
export async function computeDrift({ A, pid, sessionId, dataDate, holdings }) {
  try {
    const prev = prevPlanRun(await readLog(pid, sessionId), dataDate);
    if (!prev) return { applicable: true, available: false, reason: '还没有上一次的下单记录可以对比：第一次下单之后，下一个交易日的运行会显示成交偏差。' };
    const after = prev.runAt && Number.isFinite(Date.parse(prev.runAt)) ? new Date(Date.parse(prev.runAt) - 3600 * 1000).toISOString() : undefined;
    const orders = await A.listOrders({ status: 'all', limit: 500, after });
    const positions = await A.getPositions();
    const account = await A.getAccount();
    const pricesNow = {};
    for (const [k, h] of Object.entries(holdings || {})) if (h && h.price > 0) pricesNow[normSym(k)] = h.price;
    for (const p of positions) if (!(normSym(p.symbol) in pricesNow) && p.currentPrice > 0) pricesNow[normSym(p.symbol)] = p.currentPrice;
    for (const o of prev.alpaca.plan.orders || []) {
      const sym = normSym(o.symbol);
      if (!(sym in pricesNow)) { const b = await lastBar(sym, dataDate); if (b && b.close > 0) pricesNow[sym] = b.close; }
    }
    return driftFromData({ sessionId, prev, orders, positions, account, pricesNow });
  } catch (e) {
    return { applicable: true, available: false, error: `算执行偏差失败：${String(e.message || e).slice(0, 300)}` };
  }
}

/* ---------------- Alpaca 安全：只动自己的仓位、数据不新就跳过 ---------------- */
// 资金口径（Alpaca 模式下策略按多少钱换算目标股数）：
//   策略资金 C = 起始资金 s.capital + 这个模拟自己的已实现盈亏 + 未实现盈亏
//             = （s.capital − 自己买入花的钱 + 自己卖出收回的钱）+ 自己持仓的现值
//             = 归属这个模拟的现金 + 这个模拟自己持仓的市值
// “自己的”只认 client_order_id 以 `${sessionId}-` 开头、并且有成交的 Alpaca 订单（净成交股数；不会超过账户里实际的股数）。
// 账户里其他持仓（用户自己的、别的程序的）不计入 C，也永远不会被卖。账户只有这个模拟时，C 和以前用的账户净值一样。

/** 纯函数：这次的数据能不能用来下单。不能用时返回中文原因，能用返回 null。 */
export function staleDataReason({ fetchErrors = [], dataDate, expected, barDates = {} } = {}) {
  if (fetchErrors.length) return `数据更新失败（${fetchErrors.slice(0, 3).join('；')}${fetchErrors.length > 3 ? ` 等 ${fetchErrors.length} 个` : ''}），今天不下单，下次定时运行会重试`;
  if (expected && dataDate && dataDate < expected) return `数据只更新到 ${dataDate}，还没有 ${expected} 的收盘数据，今天不下单，下次定时运行会重试`;
  const old = Object.entries(barDates).filter(([, d]) => !d || d < dataDate).map(([k, d]) => `${k}（${d || '没有日线'}）`);
  if (old.length) return `这些目标持仓的日线没有更新到 ${dataDate}：${old.join('、')}，今天不下单，下次定时运行会重试`;
  return null;
}

const ALP_OPEN = new Set(['new', 'accepted', 'pending_new', 'partially_filled', 'pending_cancel', 'pending_replace', 'accepted_for_bidding', 'calculated', 'held']);
// listOrders 的摘要和 getOrderByClientOrderId 的原始对象都能用
const normOrder = (o = {}) => ({
  id: o.id ?? null, clientOrderId: String(o.clientOrderId ?? o.client_order_id ?? ''), symbol: normSym(o.symbol), side: o.side,
  filledQty: fnum(o.filledQty ?? o.filled_qty) || 0, filledAvgPrice: fnum(o.filledAvgPrice ?? o.filled_avg_price), status: o.status ?? null,
});

/**
 * 纯函数：在上一本账（prev）的基础上，加上这次查到的、这个模拟自己的订单成交，得到新账本。
 * 账本 = { asOf, netCash（卖出收回 − 买入花费）, qty: {代码: 净成交股数}, counted: [这次计入的 clientOrderId] }。
 * 必须在撤掉自己所有挂单之后调用：这时之前的订单都已结束，成交数不会再变。
 */
export function ledgerFromOrders({ prev = null, orders = [], sessionId, asOf = now() }) {
  const led = { asOf, netCash: prev ? Number(prev.netCash) || 0 : 0, qty: { ...((prev && prev.qty) || {}) }, counted: [] };
  const done = new Set((prev && prev.counted) || []);
  const seen = new Set();
  for (const raw of orders) {
    const o = normOrder(raw);
    if (!o.clientOrderId.startsWith(`${sessionId}-`) || done.has(o.clientOrderId) || seen.has(o.clientOrderId)) continue;
    if (ALP_OPEN.has(o.status)) throw new Error(`这个模拟还有没结束的订单（${o.side} ${o.symbol}，状态 ${o.status}），算不清自己的仓位，这次不下单`);
    seen.add(o.clientOrderId);
    led.counted.push(o.clientOrderId);
    if (!(o.filledQty > 0)) continue;
    if (!(o.filledAvgPrice > 0)) throw new Error(`订单 ${o.clientOrderId} 有成交但没有成交均价，算不清自己的资金，这次不下单`);
    const sign = o.side === 'buy' ? 1 : -1;
    led.qty[o.symbol] = (led.qty[o.symbol] || 0) + sign * o.filledQty;
    led.netCash -= sign * o.filledQty * o.filledAvgPrice;
    if (Math.abs(led.qty[o.symbol]) < 1e-9) delete led.qty[o.symbol];
  }
  led.netCash = r2(led.netCash);
  return led;
}

/**
 * 纯函数：按账本和账户持仓拆出“自己的”和“别人的”仓位，算策略资金 C（口径见上面）。
 * 自己的股数 = min(账本净成交股数, 账户实际股数)；价格优先用 prices（LEAN 收盘价），没有就用持仓现价。
 */
export function sessionBook({ capital, ledger, positions = [], prices = {} }) {
  const lq = (ledger && ledger.qty) || {};
  const own = []; const foreign = [];
  for (const p of positions) {
    const sym = normSym(p.symbol); const qty = fnum(p.qty) || 0;
    const mine = p.side === 'short' || qty < 0 ? 0 : Math.max(0, Math.min(lq[sym] || 0, qty));
    const price = fnum(prices[sym]) > 0 ? fnum(prices[sym]) : (fnum(p.currentPrice) > 0 ? fnum(p.currentPrice) : (qty ? (fnum(p.marketValue) || 0) / qty : 0));
    if (mine > 0) own.push({ symbol: sym, qty: mine, currentPrice: price, marketValue: r2(mine * price), side: 'long' });
    const rest = qty - mine;
    if (Math.abs(rest) > 1e-9) foreign.push({ symbol: sym, qty: rest, marketValue: r2(rest * (fnum(p.currentPrice) || price)), side: rest < 0 ? 'short' : 'long' });
  }
  const cash = r2((Number(capital) || 0) + ((ledger && Number(ledger.netCash)) || 0));
  const ownValue = r2(own.reduce((a, x) => a + x.marketValue, 0));
  return { capital: r2(cash + ownValue), cash, ownValue, own, foreign };
}

// 读出最近一本账，再补上之后这个模拟下的单（列表 + 记录里的 clientOrderId 逐个补查），得到新账本
async function updateLedger({ A, s, sessionId, log }) {
  let base = null; let from = 0;
  for (let i = log.length - 1; i >= 0; i--) { const L = log[i] && log[i].alpaca && log[i].alpaca.ledger; if (L) { base = L; from = i; break; } }
  const t0 = base ? Date.parse(base.asOf) : Date.parse(s.created);
  const asOf = now();
  const after = Number.isFinite(t0) ? new Date(t0 - 3600 * 1000).toISOString() : undefined;
  const listed = (await A.listOrders({ status: 'all', limit: 500, after })).filter((o) => String(o.clientOrderId || o.client_order_id || '').startsWith(`${sessionId}-`));
  const have = new Set(listed.map((o) => String(o.clientOrderId || o.client_order_id)));
  const done = new Set((base && base.counted) || []);
  const known = new Set();
  for (const x of log.slice(base ? from : 0)) for (const o of (x.alpaca && x.alpaca.submitted) || []) if (o.clientOrderId) known.add(o.clientOrderId);
  const extra = [];
  for (const coid of known) {
    if (have.has(coid) || done.has(coid)) continue;
    const o = await A.getOrderByClientOrderId(coid);
    if (o) extra.push(o);
  }
  return ledgerFromOrders({ prev: base, orders: [...listed, ...extra], sessionId, asOf });
}

/* ---------------- 会话 ---------------- */

async function listSessionIds(pid) {
  const d = path.join(pdir(pid), 'paper');
  if (!existsSync(d)) return [];
  return (await readdir(d)).filter((x) => SID.test(x));
}

async function allSessions() {
  const out = [];
  if (!existsSync(PROJECTS_DIR)) return out;
  for (const pid of await readdir(PROJECTS_DIR)) {
    if (!/^\d+$/.test(pid)) continue;
    for (const sid of await listSessionIds(pid)) {
      const s = await readJson(path.join(sdir(pid, sid), 'session.json'));
      if (s) out.push(s);
    }
  }
  return out;
}

async function readLog(pid, sid) {
  let text = '';
  try { text = await readFile(path.join(sdir(pid, sid), 'log.jsonl'), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) { if (line.trim()) { try { out.push(JSON.parse(line)); } catch { /* 跳过坏行 */ } } }
  return out;
}

// 运行失败也记进每日记录（failed: true，没有净值和持仓）。定时任务每 3 小时重试一次，
// 同一个原因连续失败只记第一条，免得一个坏掉的模拟把真正的运行记录挤出去。
// 失败行没有 alpaca / drift 字段，所以账本、执行偏差、“这个数据日下过单没有”这些读记录的地方都不受影响。
export function sameFailure(last, row) {
  return Boolean(last && last.failed && last.error === row.error && (last.dataDate || null) === (row.dataDate || null));
}
async function appendFailure(pid, sid, row) {
  const log = await readLog(pid, sid);
  if (sameFailure(log[log.length - 1], row)) return false;
  await appendLine(path.join(sdir(pid, sid), 'log.jsonl'), JSON.stringify(row));
  return true;
}

export async function startSession({ projectId, backtestId, mode = 'sim', capital, name, wait = false }) {
  const pid = Number(projectId);
  if (!MODES.includes(mode)) return fail(`mode 只能是 ${MODES.join(' / ')}`);
  if (!/^[a-f0-9]{8,64}$/.test(String(backtestId || ''))) return fail('backtestId 不对');
  const meta = await readJson(path.join(bdir(pid, backtestId), 'meta.json'));
  if (!meta) return fail('回测不存在');
  if (!/Completed/.test(meta.status)) return fail('只能用跑完的回测开始模拟实盘');
  const entry = meta.file && SAFE_FILE.test(meta.file) ? meta.file : 'main.py';
  const codeDir = path.join(bdir(pid, backtestId), 'code');
  let code;
  try { code = await readFile(path.join(codeDir, entry), 'utf8'); } catch { return fail('找不到这个回测的代码快照'); }
  const className = findAlgorithmClass(code);
  if (!className) return fail('代码里找不到继承 QCAlgorithm 的类');
  if (/helm_data|HelmUniverse|HelmSignals/.test(code)) return fail('用了 qlib 股票池或信号的策略暂时不能模拟实盘：那些数据不是每天更新的。目前只支持代码里直接写股票/ETF 代码的策略。');
  if (!patchEndDate(code, '2000-01-01')) return fail('代码里找不到 set_start_date，无法设置每天的结束日期');
  let otherPositions;
  if (mode === 'alpaca') {
    const gate = alpacaGateReason(meta);
    if (gate) return fail(gate);
    const A = await alpaca();
    const st = await A.status();
    if (!st.connected) return fail(st.error ? `Alpaca 连接失败：${st.error}` : '还没有连接 Alpaca 模拟账户，先在弹窗里连接');
    // 账户里已有的持仓都不是这个模拟买的：列出来告诉用户“不会动这些持仓”，也不计入策略资金
    let pos;
    try { pos = await A.getPositions(); } catch (e) { return fail(`读取 Alpaca 持仓失败：${e.message}`); }
    otherPositions = pos.map((p) => ({ symbol: p.symbol, qty: p.qty, marketValue: p.marketValue, side: p.side }));
    if (!(capital > 0)) {
      // 起始资金 = 账户净值 − 已有持仓市值（账户里只有现金时就是账户净值）
      const otherValue = otherPositions.reduce((a, p) => a + (Number(p.marketValue) || 0), 0);
      capital = st.account && st.account.equity > 0 ? r2(Math.max(0, st.account.equity - otherValue)) : undefined;
      if (!(capital > 0)) return fail('Alpaca 账户扣掉已有持仓后没有可用资金，无法开始');
    }
  }
  // 检查“账户是否被占用”和写入新会话之间不能有别的 start 插进来
  const release = await lockStart();
  try {
    if (mode === 'alpaca') {
      const busy = (await allSessions()).find((s) => s.mode === 'alpaca' && (s.status === 'active' || RUNNING.has(s.sessionId)));
      if (busy) return fail(`已经有一个在用 Alpaca 账户的模拟（项目 ${busy.projectId}「${busy.name}」${busy.status === 'active' ? '' : '，正在结束最后一次运行'}）。一个模拟账户同一时间只能跟一个策略${busy.status === 'active' ? '，先停掉它' : '，稍等一两分钟再试'}。`);
    }
    const r = await createSession({ pid, backtestId, mode, capital, name, wait, meta, entry, codeDir, className, otherPositions });
    return otherPositions ? { ...r, otherPositions } : r;
  } finally { release(); }
}

/** Alpaca 模式只能从主版本开始：agent 标的主版本要通过统计检验（没通过会降为候选并写 mainRejected）；用户在网页上亲自选定的主版本（mainBy = user）直接算。返回中文原因或 null。 */
export function alpacaGateReason(meta = {}) {
  // 用户在网页上亲自选定的主版本（mainBy = user）是用户的决定，直接放行
  if (meta.role === 'main' && (meta.mainBy === 'user' || !(Array.isArray(meta.mainRejected) && meta.mainRejected.length))) return null;
  const why = meta.mainRejected && meta.mainRejected.length ? `它没有通过统计检验：${meta.mainRejected.join('；')}` : `它的角色是「${meta.role || '未标记'}」，不是主版本`;
  return `Alpaca 模拟账户只能从主版本（main）回测开始，${why}。可以在回测页点「设为主版本」（你自己的决定），或者先用 Helm 内部模拟。`;
}

let startChain = Promise.resolve();
function lockStart() {
  let release;
  const next = new Promise((r) => { release = r; });
  const prev = startChain;
  startChain = prev.then(() => next);
  return prev.then(() => release);
}

async function createSession({ pid, backtestId, mode, capital, name, wait, meta, entry, codeDir, className, otherPositions }) {
  const sessionId = `p${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
  const dir = sdir(pid, sessionId);
  await mkdir(path.join(dir, 'code'), { recursive: true });
  await cp(codeDir, path.join(dir, 'code'), { recursive: true, filter: (s) => !s.includes('__pycache__') });
  const session = {
    sessionId, projectId: pid, sourceBacktestId: String(backtestId), sourceName: meta.name,
    name: String(name || '').slice(0, 120) || `${meta.name} · ${mode === 'alpaca' ? 'Alpaca 模拟账户' : '内部模拟'}`,
    mode, status: 'active', created: now(), entry, className,
    capital: Number(capital) > 0 ? Number(capital) : (mode === 'sim' ? 100000 : null),
    frozenAt: null, // 第一次运行时确定：这天之后的数据才算前向
    lastRun: null, lastAttemptAt: null, stoppedAt: null,
    ...(otherPositions ? { otherPositionsAtStart: otherPositions } : {}),
  };
  await writeJson(path.join(dir, 'session.json'), session);
  // 第一次运行（下载数据 + 跑 LEAN）要十几秒到几分钟，放到后台，完成后推送事件
  const first = runSession({ projectId: pid, sessionId });
  if (wait) { const firstRun = await first; return ok({ session: (await readJson(path.join(dir, 'session.json'))) || session, firstRun }); }
  first.catch(() => {});
  return ok({ session, firstRun: 'started' });
}

export async function stopSession({ projectId, sessionId }) {
  if (!SID.test(String(sessionId || ''))) return fail('sessionId 不对');
  const f = path.join(sdir(projectId, sessionId), 'session.json');
  const s = await withFileLock(f, async () => {
    const cur = await readJson(f);
    if (cur && cur.status !== 'stopped') { cur.status = 'stopped'; cur.stoppedAt = now(); await writeJson(f, cur); }
    return cur;
  });
  if (!s) return fail('模拟不存在');
  // 正在跑的那次会在下单前重新检查状态，看到已停止就不会下单
  const notes = [];
  if (RUNNING.has(sessionId)) notes.push('正在进行的这次运行会在下单前看到“已停止”，不会再下单。');
  if (s.mode === 'alpaca') notes.push('Alpaca 账户里的持仓不会自动平掉，需要的话请到 Alpaca 网站手动处理。');
  return ok({ session: s, note: notes.join('') || null });
}

export async function listSessions({ projectId } = {}) {
  const all = projectId ? (await Promise.all((await listSessionIds(projectId)).map((sid) => readJson(path.join(sdir(projectId, sid), 'session.json'))))).filter(Boolean) : await allSessions();
  const out = [];
  for (const s of all) {
    const latest = await readJson(path.join(sdir(s.projectId, s.sessionId), 'latest.json'));
    out.push({ ...s, summary: latest ? latest.summary : null });
  }
  return ok({ sessions: out.sort((a, b) => String(b.created).localeCompare(String(a.created))) });
}

export async function readSession({ projectId, sessionId, remote = true }) {
  if (!SID.test(String(sessionId || ''))) return fail('sessionId 不对');
  const dir = sdir(projectId, sessionId);
  const s = await readJson(path.join(dir, 'session.json'));
  if (!s) return fail('模拟不存在');
  const latest = await readJson(path.join(dir, 'latest.json'));
  const log = await readLog(projectId, sessionId);
  let alpacaOrders = null;
  if (s.mode === 'alpaca' && remote) {
    try {
      const A = await alpaca();
      const all = await A.listOrders({ status: 'all', limit: 200 });
      alpacaOrders = (all || []).filter((o) => String(o.client_order_id || o.clientOrderId || '').startsWith(`${sessionId}-`)).slice(0, 100);
    } catch (e) { alpacaOrders = { error: e.message }; }
  }
  // MCP 是另一个进程，RUNNING 是空的，所以也看 session.json 里的 runningSince（超过 30 分钟视为已中断）
  const running = RUNNING.has(sessionId) || Boolean(s.runningSince && Date.now() - Date.parse(s.runningSince) < 30 * 60 * 1000);
  return ok({ session: s, latest, log: log.slice(-120), alpacaOrders, running });
}

/* ---------------- Alpaca 下单这一步（runSession 调用；测试可以单独调用，不需要 LEAN） ---------------- */

/**
 * 返回 { skipReason?, drift?, alpaca }，alpaca 写进当天快照的 snap.alpaca。
 * s.capital 是起始资金（策略资金口径见 sessionBook 上面的说明）。sf 是 session.json 路径（下单前最后确认没有被停止）。
 */
export async function alpacaStep({ A, s, pid, sessionId, sf, dataDate, holdings, fetchErrors = [], expected, barDates = {} }) {
  // 1) 数据有问题（下载失败 / 不是最新交易日 / 某个目标的日线没更新）：一笔都不下
  const skipReason = staleDataReason({ fetchErrors, dataDate, expected, barDates });
  if (skipReason) return { skipReason, alpaca: { skipDay: skipReason, account: null, positions: null, plan: null, cancelled: [], submitted: [], errors: [], skipped: [], untradable: [], note: skipReason } };
  // 2) 目标必须完整：任何一个持仓缺价格、是空头，都不下单
  const bad = Object.entries(holdings).filter(([, h]) => h.weight == null || !(h.price > 0) || h.qty < 0).map(([k]) => k);
  if (bad.length) throw new Error(`这些持仓缺少价格或是空头，无法安全调仓：${bad.join(', ')}。Alpaca 模式只支持多头、有日线数据的股票/ETF。`);
  const targets = {}; const prices = {};
  for (const [sym, h] of Object.entries(holdings)) { if (h.weight > 0) targets[sym] = h.weight; prices[sym] = h.price; }
  const gross = Object.values(targets).reduce((x, y) => x + y, 0);
  if (gross > 1) for (const k of Object.keys(targets)) targets[k] /= gross; // 带杠杆的策略按比例缩到满仓以内
  const out = {};
  // 上一次下的单实际成交得怎样（只读，在撤单和做新计划之前看；不影响下面的下单）
  if (driftOn()) out.drift = await computeDrift({ A, pid, sessionId, dataDate, holdings });
  const log = await readLog(pid, sessionId);
  const already = log.some((x) => x.dataDate === dataDate && x.alpaca && x.alpaca.submitted && x.alpaca.submitted.length);
  const account = await A.getAccount();
  if (account.tradingBlocked) throw new Error(account.blockedReason || 'Alpaca 账户被禁止交易（trading_blocked），请到 Alpaca 网站查看');
  if (already) {
    out.alpaca = { account, positions: null, plan: null, planEquity: null, cancelled: [], submitted: [], errors: [], skipped: [], untradable: [], note: '这个数据日已经下过单，不再重复' };
    return out;
  }
  // 3) 还没成交的挂单（比如昨天收盘后提交、要今天开盘才成交的）：是这个模拟下的就先撤掉再重算，
  //    否则同样的买单会再下一遍，仓位翻倍；有不是这个模拟下的挂单就不动这个账户
  const cancelled = [];
  const open = await A.listOrders({ status: 'open', limit: 500 });
  const todayTag = `${sessionId}-${dataDate.replace(/-/g, '')}-`;
  // 同一个数据日的单已经在挂着（上次下完单还没来得及写记录就中断了）：不撤、不重下
  if (open.some((o) => String(o.clientOrderId || '').startsWith(todayTag))) throw new Error('这个数据日的订单已经提交过、还在等待成交，不再重复下单');
  const mine = open.filter((o) => String(o.clientOrderId || '').startsWith(`${sessionId}-`));
  const foreignOpen = open.filter((o) => !String(o.clientOrderId || '').startsWith(`${sessionId}-`));
  if (foreignOpen.length) throw new Error(`Alpaca 账户里有 ${foreignOpen.length} 笔不是这个模拟下的挂单（${foreignOpen.slice(0, 5).map((o) => `${o.side} ${o.symbol}`).join('、')}），为了不打架这次不下单。请到 Alpaca 网站处理后再点“立即更新”。`);
  for (const o of mine) { await A.cancelOrder(o.id); cancelled.push(o.symbol); }
  if (mine.length) {
    const t0 = Date.now();
    for (;;) {
      const still = (await A.listOrders({ status: 'open', limit: 500 })).filter((o) => String(o.clientOrderId || '').startsWith(`${sessionId}-`));
      if (!still.length) break;
      if (Date.now() - t0 > 30000) throw new Error(`撤销之前的挂单还没完成（${still.length} 笔），这次不下单，稍后会自动重试`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  // 4) 自己的仓位和策略资金：只认这个模拟自己下过、有成交的订单
  const ledger = await updateLedger({ A, s, sessionId, log });
  const positions = await A.getPositions();
  const acct = cancelled.length ? await A.getAccount() : account;
  const book = sessionBook({ capital: s.capital, ledger, positions, prices });
  const assetCache = new Map();
  const chk = await A.checkAssets(Object.keys(targets), { cache: assetCache });
  const cash = Math.max(0, Math.min(book.cash, Number(acct.cash) || 0)); // 归属这个模拟的现金，但不超过账户里实际的现金
  const plan = A.planRebalance({ targets, equity: book.capital, positions: book.own, prices, opts: { untradable: chk.untradable, cash } });
  // 保险：卖单只能卖这个模拟自己的股数（planRebalance 只看到了自己的仓位，这里再核一遍）
  const ownQty = Object.fromEntries(book.own.map((p) => [p.symbol, p.qty]));
  const dropped = plan.orders.filter((o) => o.side === 'sell' && !(o.qty <= (ownQty[normSym(o.symbol)] || 0) + 1e-9));
  if (dropped.length) {
    plan.orders = plan.orders.filter((o) => !dropped.includes(o));
    plan.notes.push(`不是这个模拟买的股数不卖：${dropped.map((o) => `${o.symbol} ${o.qty} 股`).join('、')}`);
  }
  // 5) 下单前最后再确认一次没有被停止
  const last = await readJson(sf);
  if (!last || last.status !== 'active') throw new Error('模拟已经停止，这次不下单');
  const exec = await A.executePlan(plan, { tag: `${sessionId}-${dataDate.replace(/-/g, '')}`, assetCache });
  out.alpaca = {
    account: acct, positions, plan, planEquity: book.capital, cancelled,
    capital: book.capital, sessionCash: book.cash, ownValue: book.ownValue, own: book.own, foreign: book.foreign, ledger,
    submitted: exec.submitted, errors: exec.errors, skipped: exec.skipped || [], untradable: chk.untradable, note: exec.note || null,
  };
  return out;
}

/* ---------------- 每天的运行 ---------------- */

const RUNNING = new Set();
export const runningSessions = () => [...RUNNING]; // 这个进程里正在更新的模拟（关闭服务时提示用）

export async function runSession({ projectId, sessionId, force = false, onStarted }) {
  const pid = Number(projectId);
  if (!SID.test(String(sessionId || ''))) return fail('sessionId 不对');
  if (RUNNING.has(sessionId)) return fail('这个模拟正在运行');
  RUNNING.add(sessionId); // 检查和占位之间不能有 await，否则两个调用会同时进来
  const dir = sdir(pid, sessionId);
  const sf = path.join(dir, 'session.json');
  const s = await readJson(sf);
  if (!s || s.status !== 'active') { RUNNING.delete(sessionId); return fail(s ? '这个模拟已经停止' : '模拟不存在'); }
  emit({ type: 'paper_running', projectId: pid, sessionId });
  if (onStarted) onStarted(); // 通过了开头的检查：「立即更新」接口这时才回复成功
  // 在文件锁里读改写，和 stopSession 用同一把锁：运行中途用户点了停止，这里写回时不会把 status 改回 active
  const setSession = (patch) => withFileLock(sf, async () => { const cur = (await readJson(sf)) || s; Object.assign(cur, patch); await writeJson(sf, cur); return cur; });
  let failDataDate = null; // 失败时如果已经知道数据日，写进失败记录
  try {
    await setSession({ lastAttemptAt: now(), runningSince: now() });
    const code = await readFile(path.join(dir, 'code', s.entry), 'utf8');
    const tickers = [...new Set([...tickersInCode(code), 'SPY'])];
    const fetched = await fetchData(tickers, { minEnd: expectedTradingDate() });
    const fetchErrors = (fetched.results || []).filter((r) => r.status === 'error').map((r) => `${r.ticker}: ${r.error}`);
    if (fetched.error) fetchErrors.push(`下载失败：${String(fetched.error).slice(0, 200)}`);
    // 数据日：SPY 不晚于“应有数据日”的最后一根日线（盘中跑时排除今天未收盘的那根）
    const bar = await lastBar('SPY', expectedDataDate());
    if (!bar) throw new Error('读不到 SPY 的日线数据');
    const dataDate = bar.date;
    failDataDate = dataDate;
    if (!force && s.lastRun && s.lastRun.ok && s.lastRun.dataDate >= dataDate) {
      emit({ type: 'paper_updated', projectId: pid, sessionId, ok: true, skipped: true, dataDate });
      return ok({ skipped: true, reason: `${dataDate} 已经跑过，还没有更新的数据`, dataDate });
    }
    const runDir = path.join(dir, 'runs', dataDate);
    await rm(runDir, { recursive: true, force: true });
    await mkdir(path.join(runDir, 'code'), { recursive: true });
    await cp(path.join(dir, 'code'), path.join(runDir, 'code'), { recursive: true });
    const patched = patchEndDate(code, dataDate);
    await writeFile(path.join(runDir, 'code', s.entry), patched);
    const id = `${sessionId}-${dataDate.replace(/-/g, '')}`;
    const lr = await runLean({ algorithmFile: path.join(runDir, 'code', s.entry), className: s.className, outDir: path.join(runDir, 'out'), id, name: s.name });
    if (!lr.result) throw new Error(lr.error);
    const st = lr.result.state || {};
    if (st.Status === 'RuntimeError' || st.RuntimeError) throw new Error(`策略运行出错：${st.RuntimeError || 'Runtime Error'}`);

    const days = await tradingDaySet();
    const eq = daily(seriesOf(lr.result, 'Strategy Equity', 'Equity'), days);
    const bm = daily(seriesOf(lr.result, 'Benchmark', 'Benchmark').filter((p) => p[1] > 0), days);
    if (!eq.length) throw new Error('LEAN 结果里没有权益曲线');
    // 结束日期没改成功时（比如代码里结束日期写法特殊），LEAN 会停在旧日期，前向收益会一直是 0：直接报错
    if (eq[eq.length - 1][0] < dataDate) throw new Error(`LEAN 只跑到 ${eq[eq.length - 1][0]}，没有跑到数据日 ${dataDate}。通常是还没过美东午夜（LEAN 最多跑到美东的昨天），Helm 会自动重试；一直这样的话，检查代码里有没有自己设结束日期。`);
    const frozenAt = s.frozenAt || dataDate;
    const base = eq.filter(([d]) => d <= frozenAt).pop() || eq[0];
    const bBase = bm.filter(([d]) => d <= frozenAt).pop() || bm[0];
    let cap = s.capital;
    if (!cap && s.mode === 'alpaca') { cap = (await (await alpaca()).getAccount()).equity; if (cap > 0) await setSession({ capital: cap }); }
    if (!(cap > 0)) cap = base[1];
    const fwd = eq.filter(([d]) => d >= frozenAt).map(([d, v]) => [d, (v / base[1]) * cap]);
    const fwdBm = bBase ? bm.filter(([d]) => d >= frozenAt).map(([d, v]) => [d, (v / bBase[1]) * cap]) : [];

    // 目标持仓：已成交的 + 还挂着的（下一个交易日执行的）
    const events = await readJson(path.join(runDir, 'out', `${id}-order-events.json`));
    const { filled, pending } = positionsFromOrders(lr.result.orders, Array.isArray(events) ? events : null);
    const lastEq = eq[eq.length - 1][1];
    const syms = [...new Set([...Object.keys(filled), ...Object.keys(pending)])];
    const holdings = {};
    const barDates = {};
    for (const sym of syms) {
      const qty = (filled[sym] || 0) + (pending[sym] || 0);
      if (Math.abs(qty) < 1e-9) continue;
      const b = await lastBar(sym, dataDate);
      barDates[sym] = b ? b.date : null;
      const price = b ? b.close : null;
      holdings[sym] = { qty, filledQty: filled[sym] || 0, pendingQty: pending[sym] || 0, price, weight: price ? (qty * price) / lastEq : null };
    }
    const fwdOrders = Object.values(lr.result.orders || {})
      .filter((o) => String(o.time || '').slice(0, 10) >= frozenAt)
      .map((o) => ({ time: o.time, symbol: o.symbol && o.symbol.value, qty: o.quantity, price: o.price, status: o.status, type: o.type }))
      .slice(-200);

    const ret = fwd.length ? fwd[fwd.length - 1][1] / cap - 1 : 0;
    const bret = fwdBm.length ? fwdBm[fwdBm.length - 1][1] / cap - 1 : null;
    let peak = -Infinity; let mdd = 0;
    for (const [, v] of fwd) { peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); }
    const invalidOrders = fwdOrders.filter((o) => o.status === 7).length;
    const summary = { dataDate, days: Math.max(0, fwd.length - 1), return: ret, benchmarkReturn: bret, maxDrawdown: mdd, equity: fwd.length ? fwd[fwd.length - 1][1] : cap, invalidOrders };

    // 股数按这个模拟的资金换算（LEAN 用的是回测自己的资金规模；Alpaca 模式下单只用权重）
    if (lastEq > 0) {
      const k = summary.equity / lastEq;
      for (const h of Object.values(holdings)) { h.qty = Math.floor(h.qty * k); h.filledQty = Math.floor(h.filledQty * k); h.pendingQty = Math.floor(h.pendingQty * k); }
    }
    const snap = { runAt: now(), dataDate, frozenAt, equity: summary.equity, benchmarkEquity: fwdBm.length ? fwdBm[fwdBm.length - 1][1] : null, holdings, fetchErrors };

    // Alpaca：把这个模拟自己的仓位调到目标权重（账户里别的持仓不动）
    if (s.mode === 'alpaca') {
      const A = await alpaca();
      // 跑 LEAN 要几分钟，期间用户可能点了停止：下单前重新读一次状态
      const cur = await readJson(sf);
      if (!cur || cur.status !== 'active') throw new Error('模拟已经停止，这次不下单');
      const r = await alpacaStep({ A, s: { ...s, capital: cap }, pid, sessionId, sf, dataDate, holdings, fetchErrors, expected: expectedTradingDate(), barDates });
      if (r.drift) snap.drift = r.drift;
      snap.alpaca = r.alpaca;
      if (r.skipReason) {
        // 数据有问题：这天一笔都不下，只记一条带原因的记录；lastRun 记为未完成，定时任务 3 小时后重试
        snap.skipReason = r.skipReason;
        await appendLine(path.join(dir, 'log.jsonl'), JSON.stringify(snap));
        await setSession({ runningSince: null, lastRun: { at: now(), dataDate: (s.lastRun && s.lastRun.dataDate) || null, ok: false, skipped: true, error: r.skipReason } });
        emit({ type: 'paper_updated', projectId: pid, sessionId, ok: true, skipped: true, skipReason: r.skipReason, dataDate });
        return ok({ skipped: true, skipDay: true, reason: r.skipReason, dataDate });
      }
      summary.alpacaEquity = r.alpaca.account ? r.alpaca.account.equity : null;
      if (r.alpaca.capital != null) summary.alpacaOwnEquity = r.alpaca.capital;
    } else if (driftOn()) {
      snap.drift = DRIFT_SIM;
    }

    await appendLine(path.join(dir, 'log.jsonl'), JSON.stringify(snap));
    await writeJson(path.join(dir, 'latest.json'), { summary, equity: fwd, benchmark: fwdBm, holdings, orders: fwdOrders, dataDate, frozenAt, ...(snap.drift ? { drift: snap.drift } : {}) });
    await setSession({ frozenAt, runningSince: null, lastRun: { at: now(), dataDate, ok: true, error: null } });
    // 只保留最近 3 次运行的 LEAN 输出，省磁盘
    const runs = (await readdir(path.join(dir, 'runs'))).sort();
    for (const old of runs.slice(0, -3)) await rm(path.join(dir, 'runs', old), { recursive: true, force: true });
    emit({ type: 'paper_updated', projectId: pid, sessionId, ok: true, dataDate });
    return ok({ dataDate, summary, alpaca: snap.alpaca ? { submitted: snap.alpaca.submitted.length, errors: snap.alpaca.errors.length } : null });
  } catch (e) {
    const at = now();
    const error = scrubPaths(e.message || e).slice(0, 600);
    await setSession({ runningSince: null, lastRun: { at, dataDate: (s.lastRun && s.lastRun.dataDate) || null, ok: false, error } }).catch(() => {});
    await appendFailure(pid, sessionId, { runAt: at, dataDate: failDataDate, failed: true, error }).catch(() => {});
    emit({ type: 'paper_updated', projectId: pid, sessionId, ok: false, error: error.slice(0, 200) });
    return fail(`模拟运行失败：${error}`);
  } finally {
    RUNNING.delete(sessionId);
    // 要加锁：不加锁的读-改-写会盖掉这期间 stopSession 写进去的 status:'stopped'，停掉的模拟又会被定时任务跑起来
    await withFileLock(sf, async () => {
      const cur = await readJson(sf);
      if (cur && cur.runningSince) { cur.runningSince = null; await writeJson(sf, cur); }
    }).catch(() => {});
  }
}

/* ---------------- 定时：每个交易日收盘后自动跑 ---------------- */

/**
 * 纯函数：定时任务这一轮要不要跑这个模拟。
 *  - 已停止、这个进程正在跑：不跑；应有的数据日已经跑成功：不跑。
 *  - 3 小时内刚试过（失败或没拿到新数据）：先不跑，免得反复重试。
 *  - 例外：session.json 里还留着 runningSince、但这个进程并没有在跑它 —— 上一次运行被打断了（Helm 被关掉或崩了，
 *    正常结束一定会清掉这个标记）。这种情况不等 3 小时，马上补跑；Alpaca 下单那一步自己会防重复（同一个数据日的单不会下两遍）。
 */
export function shouldRunNow(s, { want, now = Date.now(), running = false } = {}) {
  if (!s || s.status !== 'active' || running) return false;
  if (s.lastRun && s.lastRun.ok && s.lastRun.dataDate >= want) return false;
  const recent = Boolean(s.lastAttemptAt) && now - Date.parse(s.lastAttemptAt) < 3 * 3600 * 1000;
  const interrupted = Boolean(s.runningSince);
  return !recent || interrupted;
}

let timer = null;
export function startScheduler() {
  if (timer) return;
  let ticking = false;
  const tick = async () => {
    if (ticking) return; // 上一轮还没跑完（LEAN 慢）就跳过，避免同一轮里重复跑
    ticking = true;
    try {
      const want = expectedTradingDate();
      for (const s0 of await allSessions()) {
        try {
          const s = (await readJson(path.join(sdir(s0.projectId, s0.sessionId), 'session.json'))) || s0; // 读最新状态
          // 失败或没拿到新数据时 3 小时后再试；上次运行被打断的马上补跑（见 shouldRunNow）
          if (!shouldRunNow(s, { want, running: RUNNING.has(s.sessionId) })) continue;
          await runSession({ projectId: s.projectId, sessionId: s.sessionId });
        } catch { /* 一个会话出错不影响其他会话 */ }
      }
    } finally { ticking = false; }
  };
  setTimeout(() => tick().catch(() => {}), 15000);
  timer = setInterval(() => tick().catch(() => {}), 10 * 60 * 1000);
}
