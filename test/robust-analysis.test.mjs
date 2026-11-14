// 稳健性分析：合成序列 + 已知答案
import assert from 'node:assert/strict';
import { analyzeRobust, prepare, regimeLabels, regimes, costs, fillsFrom, sharpeOf, annualize, compound } from '../lib/robust.mjs';
import { isTradingDay } from '../lib/market-calendar.mjs';
// 交易日（周末和美股休市日都不算）：真实的 LEAN 结果只在交易日有变化
const isTD = (t) => isTradingDay(new Date(t * 1000).toISOString().slice(0, 10));

const near = (a, b, tol = 1e-9, m = '') => assert.ok(Math.abs(a - b) <= tol, `${m} ${a} ≈ ${b}`);

// 交易日序列：从 2005-01-03（周一）起 n 个交易日（跳过周末和休市日），收盘点在 21:00Z
function bdays(n, y = 2005, m = 0, d = 3) {
  const out = []; let t = Date.UTC(y, m, d) / 1000;
  while (out.length < n) { if (isTD(t)) out.push(t); t += 86400; }
  return out;
}
const mk = (n, eqF, bmF, extra = {}) => {
  const ts = bdays(n);
  const eqV = ts.map((t, i) => [t + 21 * 3600, eqF(i, t)]);
  const r = { charts: { 'Strategy Equity': { series: { Equity: { values: eqV } } } }, statistics: {}, ...extra };
  if (bmF) r.charts.Benchmark = { series: { Benchmark: { values: ts.map((t, i) => [t + 21 * 3600, bmF(i, t)]) } } };
  return { r, ts };
};
const yearOf = (t) => new Date(t * 1000).getUTCFullYear();

// 1. 常数日收益：年化精确，零方差夏普 = 0
{
  const { r } = mk(757, (i) => 100000 * 1.0004 ** i, (i) => 100 * 1.0002 ** i);
  const R = analyzeRobust(r, []);
  const all = compound(prepare(r).r);
  near(all, 1.0004 ** 756 - 1, 1e-9);
  near(annualize(all, 756), 1.0004 ** 252 - 1, 1e-9, '年化');
  assert.equal(sharpeOf(new Array(50).fill(0.001)), 0);
  assert.equal(R.segments.years[0].sharpe, 0);
  assert.equal(sharpeOf([0.01]), null);
  near(R.costs.rows[0].annReturn, 1.0004 ** 252 - 1, 1e-9);
  near(R.costs.rows[0].annExcess, 1.0004 ** 252 - 1.0002 ** 252, 1e-9);
  // 年度行：每年收益 = 复利；跨年链乘 = 总收益
  const chain = R.segments.years.reduce((a, y) => a * (1 + y.ret), 1) - 1;
  near(chain, all, 1e-9);
  assert.equal(R.segments.thirds.length, 3);
  near(R.segments.thirds.reduce((a, y) => a * (1 + y.ret), 1) - 1, all, 1e-9);
  assert.equal(R.segments.summary.concentration.flag, false, '均匀增长不集中');
  assert.equal(R.segments.summary.positiveShare, 1);
  assert.equal(R.segments.summary.beatShare, 1);
}

// 2. 只在 2006 年赚钱 → 集中度警示；2005 和 2007 不涨
{
  const ts = bdays(780); let v = 100000; const pts = [];
  ts.forEach((t) => { if (yearOf(t) === 2006) v *= 1.002; pts.push([t + 21 * 3600, v]); });
  const R = analyzeRobust({ charts: { 'Strategy Equity': { series: { Equity: { values: pts } } } } }, []);
  const c = R.segments.summary.concentration;
  assert.equal(c.flag, true); assert.equal(c.year, '2006'); near(c.share, 1, 1e-9);
  assert.equal(R.segments.summary.worst.ret <= 0.0000001, true);
  assert.match(R.summary.text, /2006/);
  assert.equal(R.segments.summary.beatShare, null, '无基准没有跑赢占比');
  assert.equal(R.segments.years[0].excess, null);
  assert.ok(R.notes.some((n) => /没有基准/.test(n)));
  assert.equal(R.regimes.available, false);
  assert.equal(R.costs.breakEven, null);
}

// 3. 脏数据：重复时间戳（最后一个赢）、周末点、NaN、同日盘中点
{
  const ts = bdays(40); const pts = [];
  ts.forEach((t, i) => {
    pts.push([t + 14 * 3600, 5]);              // 盘中点（会被覆盖）
    pts.push([t + 21 * 3600, 1000 + i]);
    pts.push([t + 21 * 3600, 1000 + i]);       // 重复
  });
  pts.push([bdays(1)[0] + 5 * 86400 + 21 * 3600, 777]); // 周六（2005-01-08）
  pts.push([ts[3] + 22 * 3600, NaN]);
  const P = prepare({ charts: { 'Strategy Equity': { series: { Equity: { values: pts } } } } });
  assert.equal(P.days.length, 40);
  assert.deepEqual(P.eq.slice(0, 3), [1000, 1001, 1002]);
  assert.equal(P.r.length, 39);
}

// 4. 换手和成本：构造一笔成交，精确核对
{
  const N = 301;
  const { r, ts } = mk(N, (i) => 100000 * 1.01 ** i, (i) => 100 * 1.0005 ** i);
  const P = prepare(r);
  const idx = 100; const value = 50000;
  const ev = [
    { status: 'submitted', fillQuantity: 0, fillPrice: 0, time: ts[idx] + 15 * 3600 },
    { status: 'filled', fillQuantity: -500, fillPrice: 100, time: ts[idx] + 21 * 3600, orderFeeAmount: 2.5, orderFeeCurrency: 'USD' },
  ];
  const R = analyzeRobust({ ...r, statistics: { 'Total Fees': '$12.50' } }, ev);
  const turn = value / P.eq[idx];
  near(R.costs.tradedValue, value, 1e-9);
  near(R.costs.annTurnover, turn / ((N - 1) / 252), 1e-12);
  assert.equal(R.costs.tradeDays, 1);
  assert.equal(R.costs.fees, 12.5);
  const row10 = R.costs.rows.find((x) => x.bps === 10);
  const g = 1.01 ** (N - 1) * (1.01 - 0.001 * turn) / 1.01;
  near(row10.annReturn, g ** (252 / (N - 1)) - 1, 1e-9, '10bp 年化');
  assert.deepEqual(R.costs.rows.map((x) => x.bps), [0, 5, 10, 25, 50]);
  assert.ok(row10.annReturn < R.costs.rows[0].annReturn);
  // 单笔成交太便宜，200 基点内还跑赢
  assert.equal(R.costs.breakEven.status, 'above');
  // 大换手：每天成交 = 权益的 1 倍，临界成本是闭式可核对的
  const evBig = P.days.slice(1).map((d, k) => ({ status: 'filled', fillQuantity: P.eq[k + 1] / 100, fillPrice: 100, time: d * 86400 + 21 * 3600 }));
  const R2 = analyzeRobust(r, evBig);
  near(R2.costs.annTurnover, 252, 1e-6, '日日全换手');
  assert.equal(R2.costs.breakEven.status, 'cross');
  const b = R2.costs.breakEven.bps;
  // 每天多付 c 个基点：日收益 0.01 − c/1e4，增长 (1+0.01−c/1e4)^(N−1)，等于基准 1.0005^(N−1) 时归零
  const closed = (0.01 - 0.0005) * 1e4; // 95 bp
  near(b, closed, 1e-6, '临界成本');
  // 同一回测不含订单：换手 0，成本不改变结果
  const R3 = analyzeRobust(r, []);
  assert.equal(R3.costs.hasTrades, false); assert.equal(R3.costs.annTurnover, 0);
  assert.ok(R3.costs.rows.every((x) => x.annReturn === R3.costs.rows[0].annReturn));
  assert.equal(R3.costs.breakEven.status, 'noTrades');
  assert.ok(R3.notes.some((n) => /没有成交/.test(n)));
  // 基准比策略强：一开始就没跑赢
  const { r: r4 } = mk(300, (i) => 100000 * 1.0001 ** i, (i) => 100 * 1.001 ** i);
  assert.equal(analyzeRobust(r4, [{ status: 'filled', fillQuantity: 10, fillPrice: 10, time: bdays(5)[3] + 21 * 3600 }]).costs.breakEven.status, 'already');
  // 没有订单事件文件时退回 result.orders
  const f = fillsFrom(null, { orders: { 1: { status: 3, quantity: 10, price: 5, lastFillTime: '2005-03-01T21:00:00Z' }, 2: { status: 7, quantity: 9, price: 9 } } });
  assert.equal(f.source, 'orders'); assert.equal(f.fills.length, 1); near(f.fills[0].value, 50);
}

// 5. 市场状态：只用前一日及以前的信息
{
  // 5a. 单调上涨 → 趋势全是 up；单调下跌 → 全是 down；暖机期 271 个点
  const up = regimeLabels(Array.from({ length: 400 }, (_, i) => 100 * 1.001 ** i));
  assert.equal(up.filter(Boolean).length, 400 - 271);
  assert.ok(up.filter(Boolean).every((l) => l.trend === 'up'));
  assert.equal(up[270], null); assert.ok(up[271]);
  const dn = regimeLabels(Array.from({ length: 400 }, (_, i) => 100 * 0.999 ** i));
  assert.ok(dn.filter(Boolean).every((l) => l.trend === 'down'));
  // 5b. 未来的冲击不改变更早的标签
  const base = Array.from({ length: 800 }, (_, i) => 100 + 10 * Math.sin(i / 17) + i * 0.02 + (i % 7) * 0.3);
  const t0 = 600;
  const shocked = base.map((x, i) => (i >= t0 ? x * 0.4 : x));
  const a = regimeLabels(base); const b = regimeLabels(shocked);
  for (let j = 0; j < t0; j++) assert.deepEqual(a[j], b[j], `第 ${j} 天标签被未来改变`);
  assert.notDeepEqual(a.slice(t0), b.slice(t0));
  // 5c. 端到端：冲击发生在最后一个交易日，策略各格的天数、收益、夏普都不变（该日的标签只用前一天的信息）
  const N = 1600; const mkB = (shock) => mk(N, (i) => 100000 * (1 + 0.0003 * i + 0.01 * Math.sin(i / 9)), (i) => (i === N - 1 && shock ? 20 : 100 + 10 * Math.sin(i / 17) + i * 0.02 + (i % 7) * 0.3)).r;
  const g1 = regimes(prepare(mkB(false))); const g2 = regimes(prepare(mkB(true)));
  assert.equal(g1.classified, N - 1 - 271);
  assert.equal(g1.unclassified, 271);
  for (let i = 0; i < g1.cells.length; i++) {
    assert.equal(g1.cells[i].days, g2.cells[i].days);
    assert.equal(g1.cells[i].annReturn, g2.cells[i].annReturn);
    assert.equal(g1.cells[i].sharpe, g2.cells[i].sharpe);
  }
  assert.equal(g1.cells.reduce((s, c) => s + c.days, 0), g1.classified);
  for (const m of [['趋势', 2], ['波动', 2]]) assert.equal(g1.marginals.filter((x) => x.dim === m[0]).length, m[1]);
  assert.equal(g1.marginals.filter((x) => x.dim === '趋势').reduce((s, c) => s + c.days, 0), g1.classified);
  // 5d. 样本少于 60 天的格子：只标记，不出年化
  const small = regimes(prepare(mk(420, (i) => 100000 + i * 10 + (i % 5) * 30, (i) => 100 + i * 0.05 + (i % 3)).r));
  assert.ok(small.cells.some((c) => c.small));
  for (const c of [...small.cells, ...small.marginals]) { if (c.days < 60) { assert.equal(c.small, true); assert.equal(c.annReturn, null); assert.equal(c.benchAnn, null); assert.equal(c.sharpe, null); } else assert.ok(Number.isFinite(c.annReturn)); }
}

// 6. 太短 / 验证期：结论里说明样本太短
{
  const { r } = mk(10, (i) => 100 + i, (i) => 50 + i);
  const R = analyzeRobust(r, []);
  assert.equal(R.summary.short, true); assert.match(R.summary.text, /不到 3 年|太短/);
  assert.equal(R.segments.years.length, 1); assert.equal(R.segments.years[0].partial, true);
  assert.equal(R.regimes.classified, 0);
  const { r: long } = mk(1000, (i) => 100000 * 1.0003 ** i, (i) => 100 * 1.0002 ** i);
  const H = analyzeRobust(long, [], { period: 'holdout' });
  assert.equal(H.summary.short, true); assert.match(H.summary.text, /验证期/); assert.match(H.summary.text, /说明不了什么/);
  const L = analyzeRobust(long, [], { period: 'dev' });
  assert.equal(L.summary.short, false);
  assert.equal(analyzeRobust({}, null).summary.short, true); // 空结果不抛错
}

// 7. 一个贴近真实结果文件形状的小样本：5 元组权益点、午夜点、周末点、订单事件、费用
{
  const day = (s) => Date.parse(`${s}T00:00:00Z`) / 1000;
  const eqPts = []; const bmPts = []; let e = 100000; let b = 80;
  for (let d = day('2005-01-01'); d <= day('2008-01-31'); d += 86400) { // 2005–2007 整 3 年只有约 753 个交易日（2.99 年），多给一个月
    const wd = new Date(d * 1000).getUTCDay();
    eqPts.push([d + 5 * 3600, e, e, e, e]);      // 纽约午夜点 = 前一天的收盘值（周末也有，数值不变）
    bmPts.push([d + 5 * 3600, b]);
    if (wd !== 0 && wd !== 6 && isTD(d)) { e *= 1.0004; b *= 1.0003; eqPts.push([d + 21 * 3600, e, e, e, e]); bmPts.push([d + 21 * 3600, b]); }
  }
  const result = {
    charts: { 'Strategy Equity': { series: { Equity: { values: eqPts }, Return: { values: [] } } }, Benchmark: { series: { Benchmark: { values: bmPts } } } },
    statistics: { 'Total Fees': '$1,286.51', 'Net Profit': '0%' },
    orders: { 1: { status: 3, quantity: 10, price: 10, lastFillTime: '2005-02-01T21:00:00Z' } },
  };
  const events = [
    { symbolValue: 'SPY', time: day('2005-02-01') + 21 * 3600, status: 'filled', orderFeeAmount: 1, orderFeeCurrency: 'USD', fillPrice: 100, fillQuantity: 100, direction: 'buy' },
    { symbolValue: 'SPY', time: day('2006-06-01') + 21 * 3600, status: 'filled', orderFeeAmount: 1, orderFeeCurrency: 'USD', fillPrice: 120, fillQuantity: -100, direction: 'sell' },
    { symbolValue: 'SPY', time: day('2006-06-01') + 15 * 3600, status: 'invalid' },
  ];
  const R = analyzeRobust(result, events, { period: 'dev' });
  assert.deepEqual(R.segments.years.map((y) => y.label), ['2005', '2006', '2007', '2008']);
  const P = prepare(result);
  near(R.segments.years.reduce((a, y) => a * (1 + y.ret), 1), P.eq[P.eq.length - 1] / P.eq[0], 1e-9);
  assert.equal(R.costs.tradeDays, 2); assert.equal(R.costs.fees, 1286.51);
  near(R.costs.tradedValue, 100 * 100 + 100 * 120, 1e-9);
  assert.ok(R.regimes.available);
  assert.ok(R.regimes.cells.length === 4 && R.regimes.classified > 0);
  assert.equal(R.summary.short, false); // 约 3.07 年（按交易日日历）
  JSON.stringify(R);
}
console.log('robust-analysis: 分段 / 成本 / 市场状态 / 结论 ✓');
