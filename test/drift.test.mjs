// 模拟实盘「是否在预期内」：node test/drift.test.mjs
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bootstrapBand, percentRank, assessDrift, forwardFromLatest, loadDrift, maxDrawdownOfReturns, checkpointsUpTo, nextCheckpoint } from '../lib/drift.mjs';

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
  // 结论的门槛是每一侧 1.25%（固定检查点 + Bonferroni），不是 5%：落在 5% 和 1.25% 之间不再算偏离
  const q = (x) => sorted[Math.round((sorted.length - 1) * x)];
  check('5% 分位以下、1.25% 以上：仍在预期范围内', mk(60, (q(0.0125) + band.p5) / 2).verdict === 'in' && mk(60, (q(0.9875) + band.p95) / 2).verdict === 'in');
  const low = mk(60, q(0.0125) - 0.02); const high = mk(60, q(0.9875) + 0.02);
  check('低于 1.25%：低于回测预期，建议先查数据/执行差异', low.verdict === 'low' && /数据|执行/.test(low.notes.join('')));
  check('高于 98.75%：高于回测预期，说明偏高也是偏离', high.verdict === 'high' && /偏离/.test(high.notes.join('')));
  // 有逐日路径时：结论取最近一个检查点（20 / 60 / 120 / 250，之后每 250 天）上的累计收益，两个检查点之间不变
  check('检查点：20、60、120、250，之后每 250 天', JSON.stringify(checkpointsUpTo(19)) === '[]' && JSON.stringify(checkpointsUpTo(130)) === '[20,60,120]' && JSON.stringify(checkpointsUpTo(760)) === '[20,60,120,250,500,750]' && nextCheckpoint(0) === 20 && nextCheckpoint(60) === 120 && nextCheckpoint(250) === 500 && nextCheckpoint(600) === 750);
  const withPath = (path) => assessDrift({ btReturns: r, fwd: { n: path.length - 1, r: path[path.length - 1], path, dd: 0.01, bench: null, excess: null, from: 'a', to: 'b' } });
  const flat = (n, v) => Array.from({ length: n + 1 }, (_, i) => (i === 0 ? 0 : v));
  {
    // 第 60 天在范围内，之后到第 100 天暴跌：下一个检查点（120）还没到，结论保持“在预期内”，但今天的百分位照实给出
    const p = flat(100, band.p50); p[100] = -0.6;
    const d = withPath(p);
    check('两个检查点之间：结论不变，今天的位置只作参考', d.verdict === 'in' && d.checkpoint.n === 60 && d.rank < 0.01 && d.nextCheckpoint === 120 && /只作参考/.test(d.notes.join('')), JSON.stringify([d.verdict, d.checkpoint, d.rank]));
    // 到了第 120 天仍然很低：结论变成偏低
    const p2 = flat(120, band.p50); for (let i = 100; i <= 120; i++) p2[i] = -0.6;
    const d2 = withPath(p2);
    check('到下一个检查点仍偏离：结论更新', d2.verdict === 'low' && d2.checkpoint.n === 120 && d2.checkpoints.length === 3);
    // 第 60 天偏低，第 120 天回到范围内：结论是“在预期内”，说明里保留之前偏离过
    const p3 = flat(120, 0.02); p3[60] = -0.6;
    const d3 = withPath(p3);
    check('之前的检查点偏离过：结论按最新检查点，说明里写出来', d3.verdict === 'in' && /第 60 天（偏低）/.test(d3.notes.join('')), d3.notes.join(' | '));
    check('不到 20 天：太早，没有检查点', withPath(flat(12, 0.3)).verdict === 'early' && withPath(flat(12, 0.3)).checkpoints.length === 0);
    check('英文说明', /checkpoint/.test(assessDrift({ btReturns: r, fwd: { n: 60, r: -0.9, path: flat(60, -0.9), dd: 0 }, lang: 'en' }).notes.join(' ')));
  }
  check('说明里有“不证明策略有效”', /不证明/.test(low.notes.join('')));
  check('回撤对比：返回回测最大回撤', near(mk(60, 0).dd.backtest, maxDrawdownOfReturns(r), 1e-12));
}

// 5. 前向数据来自 latest.json 的曲线
{
  const f = forwardFromLatest({ equity: [['d0', 100], ['d1', 110], ['d2', 99]], benchmark: [['d0', 50], ['d1', 51], ['d2', 52]] });
  check('forward：n、r 来自曲线首尾', f.n === 2 && near(f.r, -0.01, 1e-12));
  check('forward：path 是逐日累计收益', f.path.length === 3 && f.path[0] === 0 && near(f.path[1], 0.1, 1e-12) && near(f.path[2], -0.01, 1e-12));
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
