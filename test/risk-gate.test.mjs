// 择时类策略的「风险调整后跑赢基准」：夏普差配对自助法 P(≤0) < 10%，且最大回撤 ≤ 基准的 2/3
import assert from 'node:assert/strict';
import { validateResult } from '../lib/stats.mjs';

// 合成数据：基准 8 年日收益，中间有一段 −50% 的崩盘；策略在崩盘期间持有现金，其余时间和基准一样
let seed = 11; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const days = []; for (let t = Date.UTC(2010, 0, 4); days.length < 252 * 8; t += 86400000) { const d = new Date(t).getUTCDay(); if (d && d < 6) days.push(t / 1000 + 21 * 3600); }
const crash = (i) => i > 900 && i < 1100;
const rb = days.map((_, i) => (crash(i) ? -0.0035 : 0.0006) + (rnd() - 0.5) * 0.02);
const build = (rets) => { let v = 100000; return days.map((t, i) => { if (i) v *= 1 + rets[i]; return [t, v]; }); };
const result = (strat) => ({ charts: { 'Strategy Equity': { series: { Equity: { values: build(strat) } } }, Benchmark: { series: { Benchmark: { values: build(rb) } } } } });

const timing = rb.map((x, i) => (crash(i) ? 0.00005 : x));
const v = validateResult(result(timing), { gateMode: 'risk-adjusted' }, [1]);
const g = v.gates.find((x) => x.id === 'riskadj');
assert.ok(g, '择时模式下用 riskadj 代替 excess');
assert.ok(!v.gates.some((x) => x.id === 'excess'));
assert.equal(g.ok, true, g.detail);
assert.ok(v.numbers.riskAdjusted.mdd < v.numbers.riskAdjusted.mddBench * 2 / 3);

// 和基准一模一样：夏普差 0，P(≤0)=100%，不通过
const same = validateResult(result(rb), { gateMode: 'risk-adjusted' }, [1]).gates.find((x) => x.id === 'riskadj');
assert.equal(same.ok, false);

// 默认模式不变：还是 excess
assert.ok(validateResult(result(timing), {}, [1]).gates.some((x) => x.id === 'excess'));
console.log('risk-gate: 择时策略按风险调整后比较 ✓', g.detail);
