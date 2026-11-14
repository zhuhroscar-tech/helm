// 主版本差距：从检验区间反推「要怎样才能通过」
import assert from 'node:assert/strict';
import { mainNeeds } from '../lib/stats.mjs';

const near = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) < tol, `${a} ≈ ${b}`);
// 项目 1002 的 GEM 候选：超额 +1.39%/年，95% 区间 [−5.5%, 8.0%]
const v = {
  ok: true, pass: false,
  gates: [
    { id: 'ci', ok: true, zh: 'ci', detail: '' },
    { id: 'excess', ok: false, zh: '跑赢基准', detail: 'x' },
    { id: 'len', ok: true, zh: 'len', detail: '' },
  ],
  numbers: { annualExcess: 0.0139, excessCi: [-0.055, 0.080], trackingError: 0.14, sharpe: 0.6, sharpeCi: [0.19, 1.08], years: 14.8 },
};
const [n] = mainNeeds(v);
assert.equal(n.id, 'excess');
near(n.se, 0.135 / 3.92);
near(n.needExcess, 1.2816 * 0.135 / 3.92);          // ≈ 4.4%/年
assert.ok(n.needExcess > 0.043 && n.needExcess < 0.045);
near(n.needTe, 0.14 * 0.0139 / n.needExcess);        // 超额不变时跟踪误差要降到 ≈ 4.4%
// 夏普区间没过：所需年数随 se² 放大
const v2 = { ok: true, pass: false, gates: [{ id: 'ci', ok: false, zh: 'ci', detail: '' }], numbers: { sharpe: 0.3, sharpeCi: [-0.2, 0.8], years: 5 } };
const [c] = mainNeeds(v2);
near(c.needSharpe, 1.96 * 1 / 3.92);
near(c.needYears, 5 * (0.5 / 0.3) ** 2);
// 通过了 / 没结果：空
assert.deepEqual(mainNeeds({ ok: true, pass: true, gates: [] }), []);
assert.deepEqual(mainNeeds(null), []);
console.log('main-needs: 差距推算 ✓');
