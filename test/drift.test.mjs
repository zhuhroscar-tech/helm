// 模拟实盘「是否在预期内」：node test/drift.test.mjs
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bootstrapBand, percentRank, assessDrift, forwardFromLatest, loadDrift, maxDrawdownOfReturns } from '../lib/drift.mjs';

let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); if (!cond) failed++; };
const near = (a, b, t) => Math.abs(a - b) <= t;

// 1. 常数收益：分布退化成精确的复利值，实现值正好等于它时百分位 = 50%
{
  const r = Array(300).fill(0.001);
  const exact = 1.001 ** 25 - 1;
  const { band, sorted } = bootstrapBand(r, 25);
  check('常数收益：5 个分位都等于精确复利值', Object.values(band).every((x) => near(x, exact, 1e-12)), JSON.stringify(band));
  check('常数收益：实现值 = 精确值 → 百分位 50%', percentRank(sorted, exact) === 0.5);
}

// 2. 近似独立同分布：用确定性伪随机造一段日收益，分布中位数处的百分位约 50%，且 5–95 分位包住中间
{
  let a = 12345; const rnd = () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a / 4294967296; };
  const gauss = () => { let s = 0; for (let i = 0; i < 12; i++) s += rnd(); return s - 6; };
  const r = Array.from({ length: 2500 }, () => 0.0004 + 0.01 * gauss());
  const { band, sorted } = bootstrapBand(r, 60);
  const rank = percentRank(sorted, band.p50);
  check('i.i.d.：中位数的百分位 ≈ 50%（±2%）', near(rank, 0.5, 0.02), rank.toFixed(3));
  check('分位数递增', band.p5 < band.p25 && band.p25 < band.p50 && band.p50 < band.p75 && band.p75 < band.p95);
  const mu = r.reduce((x, y) => x + y, 0) / r.length;
  check('i.i.d.：p50 接近样本均值复利（±1%）', near(band.p50, (1 + mu) ** 60 - 1, 0.01), `${band.p50.toFixed(4)} vs ${((1 + mu) ** 60 - 1).toFixed(4)}`);
  check('p5 的百分位 ≈ 5%', near(percentRank(sorted, band.p5), 0.05, 0.01));
  // 3. 固定种子可复现；换种子结果不同
  const again = bootstrapBand(r, 60);
  check('同一种子：结果逐位一致', JSON.stringify(again.band) === JSON.stringify(band));
  check('换种子：结果不同', JSON.stringify(bootstrapBand(r, 60, { seed: 1 }).band) !== JSON.stringify(band));
  // 4. 判定规则
  const mk = (n, rr) => assessDrift({ btReturns: r, fwd: { n, r: rr, dd: 0.01, bench: null, excess: null, from: 'a', to: 'b' } });
  check('n<20：太早，但仍给出范围', (() => { const d = mk(10, 0.5); return d.verdict === 'early' && d.band && d.verdictText === '太早，还看不出来'; })());
  check('n≥20 且在范围内：在回测预期范围内', mk(60, band.p50).verdict === 'in');
  const low = mk(60, band.p5 - 0.05); const high = mk(60, band.p95 + 0.05);
  check('低于 5%：低于回测预期，建议先查数据/执行差异', low.verdict === 'low' && /数据|执行/.test(low.notes.join('')));
  check('高于 95%：高于回测预期，说明偏高也是偏离', high.verdict === 'high' && /偏离/.test(high.notes.join('')));
  check('说明里有“不证明策略有效”', /不证明/.test(low.notes.join('')));
  check('回撤对比：返回回测最大回撤', near(mk(60, 0).dd.backtest, maxDrawdownOfReturns(r), 1e-12));
}

// 5. 前向数据来自 latest.json 的曲线
{
  const f = forwardFromLatest({ equity: [['d0', 100], ['d1', 110], ['d2', 99]], benchmark: [['d0', 50], ['d1', 51], ['d2', 52]] });
  check('forward：n、r 来自曲线首尾', f.n === 2 && near(f.r, -0.01, 1e-12));
  check('forward：超额 = 策略 − 基准（同日期）', near(f.excess, -0.01 - 0.04, 1e-12));
  check('forward：回撤取曲线最大回撤', near(f.dd, 0.1, 1e-12));
  check('forward：没有基准 → excess 为 null', forwardFromLatest({ equity: [['a', 1], ['b', 2]] }).excess === null);
  check('forward：不足 2 个点 → null', forwardFromLatest({ equity: [['a', 1]] }) === null && forwardFromLatest(null) === null);
  check('没有新交易日：给中文说明而不是数字', (() => { const d = assessDrift({ btReturns: Array(100).fill(0.001), fwd: null }); return d.available === false && /还没有新的交易日/.test(d.note); })());
  check('回测日收益太少：给中文说明', assessDrift({ btReturns: [0.01], fwd: { n: 5, r: 0.01, dd: 0 } }).available === false);
}

// 6. 加载器：缺文件的路径
{
  const dir = await mkdtemp(path.join(os.tmpdir(), 'helm-drift-'));
  try {
    check('没有这个模拟 → found=false', (await loadDrift(dir, 1, 'pabcdef123456')).found === false);
    const sd = path.join(dir, '1', 'paper', 'pabcdef123456');
    await mkdir(sd, { recursive: true });
    await writeFile(path.join(sd, 'session.json'), JSON.stringify({ sessionId: 'pabcdef123456', sourceBacktestId: 'abcd1234' }));
    await writeFile(path.join(sd, 'latest.json'), JSON.stringify({ equity: [['a', 1], ['b', 1.01]] }));
    const r = await loadDrift(dir, 1, 'pabcdef123456');
    check('来源回测结果找不到 → 中文说明，没有数字', r.found && r.drift.available === false && /找不到来源回测/.test(r.drift.note) && r.drift.band === undefined);
    await writeFile(path.join(sd, 'session.json'), JSON.stringify({ sessionId: 'pabcdef123456' }));
    check('session 没记来源回测 → 中文说明', /没有记录来源回测/.test((await loadDrift(dir, 1, 'pabcdef123456')).drift.note));
    const bd = path.join(dir, '1', 'backtests', 'abcd1234', 'out');
    await mkdir(bd, { recursive: true });
    await writeFile(path.join(bd, 'abcd1234.json'), '{坏的');
    await writeFile(path.join(sd, 'session.json'), JSON.stringify({ sessionId: 'pabcdef123456', sourceBacktestId: 'abcd1234' }));
    check('结果文件损坏 → 中文说明，不抛错', (await loadDrift(dir, 1, 'pabcdef123456')).drift.available === false);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
