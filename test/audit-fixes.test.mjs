// 2026-11-12 审计里复现出来的四个问题的回归测试（全部是合成数据，不读真实项目）。
import path from 'node:path';
import os from 'node:os';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, cp, writeFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as S from '../lib/stats.mjs';
import { analyzeRobust } from '../lib/robust.mjs';
import { isTradingDay } from '../lib/market-calendar.mjs';

let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); if (!cond) failed++; };

const T = (iso) => Date.parse(iso) / 1000;
// 交易日（跳过周末和美股休市日）：真实的 LEAN 结果只在交易日有变化
function weekdays(start, n) { const out = []; const d = new Date(`${start}T00:00:00Z`); while (out.length < n) { const s = d.toISOString().slice(0, 10); if (isTradingDay(s)) out.push(s); d.setUTCDate(d.getUTCDate() + 1); } return out; }
// LEAN 形状的结果：起点是开始日纽约午夜（05:00Z）的一个点，之后每个交易日 21:00Z 一个收盘点
function mk(start, eqOf, { bmOf = null, bmUntil = null, n = 300 } = {}) {
  const days = weekdays(start, n);
  const eq = [[T(`${days[0]}T05:00:00Z`), 100000]]; const bm = bmOf ? [[T(`${days[0]}T05:00:00Z`), 100]] : [];
  days.forEach((d, i) => { eq.push([T(`${d}T21:00:00Z`), eqOf(i)]); if (bmOf && (!bmUntil || d <= bmUntil)) bm.push([T(`${d}T21:00:00Z`), bmOf(i)]); });
  const e0 = eq[0][1]; const e1 = eq[eq.length - 1][1];
  return { charts: { 'Strategy Equity': { series: { Equity: { values: eq } } }, ...(bmOf ? { Benchmark: { series: { Benchmark: { values: bm } } } } : {}) }, orders: {}, statistics: { 'Start Equity': String(e0), 'End Equity': String(e1), 'Net Profit': `${((e1 / e0 - 1) * 100).toFixed(3)}%`, 'Sharpe Ratio': '1', 'Total Orders': '0' } };
}
let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const path_ = (n) => { let v = 100000; const out = []; for (let i = 0; i < n; i++) { v *= 1 + (rnd() - 0.48) * 0.01; out.push(v); } return out; };

/* 1. 周一开始的回测：第一天的收益不能丢 */
{
  const p = path_(300);
  for (const [label, start] of [['周一', '2020-01-06'], ['周二', '2020-01-07'], ['周五', '2020-01-10']]) {
    const c = S.checkConsistency(mk(start, (i) => p[i]));
    const h = c.checks.find((x) => x.id === 'helmDaily');
    check(`${label}开始：Helm 日收益复利 = 曲线首尾总收益`, h && h.ok, h ? `${h.lean.toFixed(3)}% vs ${h.helm.toFixed(3)}%` : '没有这项检查');
  }
  const m = S.byDay([[T('2020-01-10T21:00:00Z'), 5], [T('2020-01-12T05:00:00Z'), 6], [T('2020-01-13T05:00:00Z'), 7]]);
  check('周五已经有收盘值时，周末 / 周一凌晨的点不覆盖它', m.size === 1 && [...m.values()][0] === 5);
}

/* 2. 基准只覆盖一部分时间：超额只在共同的那段上比，跑赢年数不乱算 */
{
  const days = weekdays('2020-01-01', 1100);
  const cut = days.findIndex((d) => d > '2021-12-31');
  let v = 100000; const eq = days.map((d, i) => { v *= i < cut ? 1.0002 : 1.002; return v; });
  let b = 100; const bm = days.map(() => { b *= 1.0002; return b; });
  const r = analyzeRobust(mk('2020-01-01', (i) => eq[i], { bmOf: (i) => bm[i], bmUntil: '2021-12-31', n: 1100 }), null, {});
  check('共同区间里两边涨幅一样：年化超额约为 0', Math.abs(r.costs.rows[0].annExcess) < 0.002, String(r.costs.rows[0].annExcess));
  const s = r.segments.summary;
  check('跑赢年数只数有基准的年份', s.benchYears === 2 && s.beatCount <= 2 && /只有 2 年有基准数据/.test(r.summary.text) && !/5 年跑赢基准/.test(r.summary.text), r.summary.text);
  const full = analyzeRobust(mk('2020-01-01', (i) => eq[i], { bmOf: (i) => bm[i], n: 1100 }), null, {});
  check('基准覆盖全程时：超额 = 策略年化 − 基准年化（和以前一样），文字不加说明', Math.abs(full.costs.rows[0].annExcess - (full.costs.rows[0].annReturn - full.costs.rows[0].annBench)) < 1e-12 && !/年有基准数据/.test(full.summary.text));
}

/* 3. 波动为 0（只有浮点噪声）的曲线：夏普记 0，过不了置信区间这一关 */
{
  const v = S.validateResult(mk('2020-01-06', (i) => 100000 * 1.0001 ** (i + 1), { n: 400 }), {}, [1]);
  const ci = v.gates.find((g) => g.id === 'ci');
  check('零波动曲线：夏普 = 0，置信区间关卡不通过', v.numbers.sharpe === 0 && ci && ci.ok === false, `${v.numbers.sharpe} ${ci && ci.detail}`);
}

/* 4. 仓库路径里有空格和中文：想法记录的默认目录不能是百分号编码的 */
{
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'helm-audit-'));
  const dir = path.join(tmp, '量化 helm', 'lib');
  await mkdir(dir, { recursive: true });
  await cp(fileURLToPath(new URL('../lib/journal.mjs', import.meta.url)), path.join(dir, 'journal.mjs'));
  const J = await import(pathToFileURL(path.join(dir, 'journal.mjs')).href);
  const d = J.defaults();
  check('默认项目目录是真实路径', !process.env.HELM_PROJECTS_DIR ? d.projectsDir === path.join(realpathSync(tmp), '量化 helm', 'projects') : true, d.projectsDir);
  check('默认路径里没有百分号编码', !/%[0-9A-F]{2}/.test(d.trialsFile) || Boolean(process.env.HELM_TRIALS_FILE), d.trialsFile);
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
