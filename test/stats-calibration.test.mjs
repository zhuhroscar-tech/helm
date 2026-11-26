// 统计检验的校准：用模拟数据量出“本来没问题却被判有问题 / 本来没优势却通过”的比例。
//   node test/stats-calibration.test.mjs          完整（约 1 分钟）
//   node test/stats-calibration.test.mjs --fast   次数减少，门槛放宽
// 1. 概率夏普（去膨胀夏普用的同一个公式）：真实夏普 = 0 时，PSR ≥ 95% 的比例应该在 5% 左右。
//    日收益有正自相关（AR(1) φ = 0.2）时，不做 Newey-West 修正会到约 9%。
// 2. 模拟实盘「是否在预期内」：前向收益和回测来自同一个分布时，250 个交易日里被标成偏离的比例。
//    每天拿 5% / 95% 判一次（旧规则）约一半会被标到；固定检查点 + 每侧 1.25%（现在的规则）不超过 10%。
import { psr, mulberry32, NW_FLOOR } from '../lib/stats.mjs';
import { assessDrift, bootstrapBand, percentRank, CHECKPOINTS, TAIL } from '../lib/drift.mjs';

const FAST = process.argv.includes('--fast');
let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); if (!cond) failed++; };
const pc = (x) => `${(x * 100).toFixed(1)}%`;

const rnd = mulberry32(20261125);
const gauss = () => { let u = 0; while (u === 0) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
const ar1 = (n, phi, mu = 0) => { const r = new Array(n); let x = gauss() / Math.sqrt(1 - phi * phi); for (let i = 0; i < n; i++) { x = phi * x + gauss(); r[i] = mu + 0.01 * x; } return r; };

// ---- 1. 概率夏普的误通过率 ----
{
  const SIMS = FAST ? 1500 : 4000;
  const tol = FAST ? 0.02 : 0.012; // 抽样误差：4000 次时 5% 的标准误约 0.35%
  const rate = (n, phi, opts) => { let k = 0; for (let s = 0; s < SIMS; s++) if (psr(ar1(n, phi), 0, opts) >= 0.95) k++; return k / SIMS; };
  for (const n of [252, 756, 2520]) {
    const iid0 = rate(n, 0, { nw: false }); const nw0 = rate(n, 0);
    const iid2 = rate(n, 0.2, { nw: false }); const nw2 = rate(n, 0.2);
    const neg = rate(n, -0.2);
    console.log(`n=${n}  独立同分布：旧 ${pc(iid0)} → 新 ${pc(nw0)}   φ=0.2：旧 ${pc(iid2)} → 新 ${pc(nw2)}   φ=−0.2：新 ${pc(neg)}`);
    check(`n=${n}：独立同分布时误通过率不超过 5%（+抽样误差）`, nw0 <= 0.05 + tol, pc(nw0));
    check(`n=${n}：φ=0.2 时旧公式明显偏高（> 7%），说明这个测试量得出问题`, iid2 > 0.07, pc(iid2));
    check(`n=${n}：φ=0.2 时修正后误通过率 ≤ 7%`, nw2 <= 0.07, pc(nw2));
    check(`n=${n}：负自相关不会放宽关卡（因子下限 ${NW_FLOOR}）`, neg <= 0.05 + tol, pc(neg));
  }
  // 真有优势的策略不能被修正卡死：年化夏普 1.0、3 年、无自相关，通过率和旧公式相差很小
  const power = (opts) => { let k = 0; const S = FAST ? 500 : 1500; for (let s = 0; s < S; s++) if (psr(ar1(756, 0, 0.01 / Math.sqrt(252)), 0, opts) >= 0.95) k++; return k / S; };
  const pOld = power({ nw: false }); const pNew = power();
  check('年化夏普 1.0、3 年：修正后通过率下降不超过 5 个百分点', pOld - pNew <= 0.05, `旧 ${pc(pOld)} → 新 ${pc(pNew)}`);
}

// ---- 2. 模拟实盘偏离的误报率（250 个交易日） ----
{
  const PATHS = FAST ? 120 : 400; const H = 250; const DRAWS = FAST ? 1000 : 2000;
  const bt = ar1(2520, 0, 0.0004);
  // 旧规则：第 20 天起每天判一次，5% / 95%。每天的分布各做一次自助法太慢，这里每 5 天看一次（只会低估旧规则的误报率）
  const daily = []; for (let n = 20; n <= H; n += 5) daily.push({ n, sorted: bootstrapBand(bt, n, { draws: DRAWS, seed: 100 + n }).sorted });
  let oldFlag = 0; let newFlag = 0; let newFinal = 0;
  for (let p = 0; p < PATHS; p++) {
    const fr = ar1(H, 0, 0.0004);
    const path = [0]; let v = 1; for (const x of fr) { v *= 1 + x; path.push(v - 1); }
    if (daily.some((d) => { const rk = percentRank(d.sorted, path[d.n]); return rk < 0.05 || rk > 0.95; })) oldFlag++;
    const D = assessDrift({ btReturns: bt, fwd: { n: H, r: path[H], path, dd: 0 }, opts: { draws: DRAWS } });
    if (D.checkpoints.some((c) => c.verdict !== 'in')) newFlag++;
    if (D.verdict !== 'in') newFinal++;
  }
  console.log(`和回测同分布的 ${PATHS} 条路径、${H} 个交易日：旧规则（每 5 天判一次 5%/95%）至少被标一次 ${pc(oldFlag / PATHS)}；新规则（检查点 ${CHECKPOINTS.join('/')}，每侧 ${TAIL * 100}%）至少被标一次 ${pc(newFlag / PATHS)}，最后一个检查点被标 ${pc(newFinal / PATHS)}`);
  check('旧规则的误报率很高（> 25%），说明这个测试量得出问题', oldFlag / PATHS > 0.25, pc(oldFlag / PATHS));
  check('新规则：一年内至少被误标一次的比例 ≤ 10%（+抽样误差）', newFlag / PATHS <= 0.10 + (FAST ? 0.06 : 0.035), pc(newFlag / PATHS));
  // 真的偏离要能看出来：前向日均收益比回测低 0.15%/天（年化约 −38%），到第 250 天应该大多被标成偏低
  let caught = 0; const P2 = FAST ? 60 : 150;
  for (let p = 0; p < P2; p++) {
    const fr = ar1(H, 0, 0.0004 - 0.0015);
    const path = [0]; let v = 1; for (const x of fr) { v *= 1 + x; path.push(v - 1); }
    if (assessDrift({ btReturns: bt, fwd: { n: H, r: path[H], path, dd: 0 }, opts: { draws: DRAWS } }).verdict === 'low') caught++;
  }
  check('真的变差（日均低 0.15%）：第 250 天多数被标成偏低', caught / P2 >= (FAST ? 0.4 : 0.6), pc(caught / P2));
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
