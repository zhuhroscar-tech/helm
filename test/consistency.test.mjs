// 指标一致性核对（stats.checkConsistency）的测试：node test/consistency.test.mjs
//   默认：合成的 LEAN 结果（确定性，不跑 LEAN），外加 main 关卡在临时目录里的端到端检查。
//   --lean：再跑两次真实 LEAN 回测（买入持有 + 均线交叉，约 1 分钟），要求真实结果通过核对。
// 全程用临时目录，不碰真实项目和尝试记录。
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { leanSkip } from './lean-skip.mjs';

const LEAN = process.argv.includes('--lean');
const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-consistency-'));
process.env.HELM_PROJECTS_DIR = path.join(TMP, 'projects');
process.env.HELM_TRIALS_FILE = path.join(TMP, 'trials.jsonl');
process.env.HELM_ALPACA_FILE = path.join(TMP, 'secrets', 'alpaca.json');

const S = await import('../lib/stats.mjs');
const E = await import('../lib/engine.mjs');

let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failed += 1;
};

// 按 LEAN 的样子造一个结果：每个日历日纽约午夜（05Z）一个点，记的是前一天的收盘值；工作日 21Z 再记当天收盘。
// 统计数字按 LEAN 的公式和舍入规则从这条曲线算出来，所以默认是完全自洽的。
function leanLike({ years = 3, drift = 0.0006, vol = 0.01, seed = 11, nOrders = 40, nTrades = 18, wins = 11 } = {}) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const eq = []; const bm = [];
  let e = 100000; let b = 300;
  const d0 = Date.UTC(2020, 0, 1) / 1000; // 周三
  for (let i = 0; i < Math.round(years * 365); i++) {
    const day = d0 + i * 86400;
    eq.push([day + 5 * 3600, e, e, e, e]); bm.push([day + 5 * 3600, b]); // 午夜：前一天收盘
    const dow = new Date(day * 1000).getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const z = gauss();
      e *= 1 + drift + vol * z;
      b *= 1 + 0.0003 + vol * 0.9 * z + vol * 0.3 * gauss();
      eq.push([day + 21 * 3600, e, e, e, e]); bm.push([day + 21 * 3600, b]);
    }
  }
  const e0 = eq[0][4]; const e1 = eq[eq.length - 1][4];
  const yrs = (eq[eq.length - 1][0] - eq[0][0]) / 86400 / 365;
  let peak = -Infinity; let mdd = 0;
  for (const p of eq) { peak = Math.max(peak, p[4]); mdd = Math.max(mdd, 1 - p[4] / peak); }
  const orders = {};
  for (let i = 1; i <= nOrders; i++) orders[i] = { id: i, status: i % 7 === 0 ? 7 : 3, quantity: 10, symbol: { value: 'SPY' } };
  const winRate = nTrades ? Math.round((wins / nTrades) * 100) : 0;
  const lossRate = nTrades ? Math.round(((nTrades - wins) / nTrades) * 100) : 0;
  return {
    charts: { 'Strategy Equity': { series: { Equity: { values: eq } } }, Benchmark: { series: { Benchmark: { values: bm } } } },
    orders,
    totalPerformance: { tradeStatistics: { totalNumberOfTrades: nTrades } },
    statistics: {
      'Total Orders': String(nOrders),
      'Compounding Annual Return': `${(((e1 / e0) ** (1 / yrs) - 1) * 100).toFixed(3)}%`,
      Drawdown: `${(Math.round(mdd * 1000) / 10).toFixed(3)}%`,
      'Start Equity': String(e0),
      'End Equity': e1.toFixed(2),
      'Net Profit': `${((e1 / e0 - 1) * 100).toFixed(3)}%`,
      'Sharpe Ratio': '0.912',
      'Sortino Ratio': '1.104',
      'Probabilistic Sharpe Ratio': '61.2%',
      'Win Rate': `${winRate}%`,
      'Loss Rate': `${lossRate}%`,
      Alpha: '0.02', Beta: '0.9',
      'Total Fees': '$120.50',
    },
  };
}

const mutate = (base, patch) => { const r = structuredClone(base); Object.assign(r.statistics, patch); return r; };
const failedIds = (c) => c.checks.filter((x) => !x.ok).map((x) => x.id);

/* ---------- 纯函数：合成数据 ---------- */
const base = leanLike();
{
  const c = S.checkConsistency(base);
  check('自洽的合成结果通过核对', c.ok && !c.skipped, c.failures.join('；') || `${c.checks.length} 项，最紧 ${c.worst.id} ${c.worst.ratio.toFixed(2)}×容差`);
  check('核对项齐全（订单、胜败率、起止权益、净利润、年化、回撤、Helm 日收益）', ['orders', 'winloss', 'start', 'end', 'netProfit', 'cagr', 'drawdown', 'helmDaily'].every((id) => c.checks.some((x) => x.id === id)));
  const reported = parseFloat(base.statistics['Net Profit']);

  const p2 = S.checkConsistency(mutate(base, { 'Net Profit': `${(reported * 2).toFixed(3)}%` }));
  check('净利润翻倍被发现', !p2.ok && failedIds(p2).includes('netProfit'), p2.failures[0]);
  check('矛盾说明是中文且同时给出两个数字', /净利润对不上/.test(p2.failures[0]) && p2.failures[0].includes(`${(reported * 2).toFixed(3)}%`) && p2.failures[0].includes(`${reported.toFixed(3)}%`));

  const cg = S.checkConsistency(mutate(base, { 'Compounding Annual Return': '79.000%' }));
  check('复合年化报错（报 79%）被发现', !cg.ok && failedIds(cg).includes('cagr'), cg.failures[0]);

  const dd = parseFloat(base.statistics.Drawdown);
  const dw = S.checkConsistency(mutate(base, { Drawdown: `${(dd / 2).toFixed(3)}%` }));
  check('最大回撤报错被发现', !dw.ok && failedIds(dw).includes('drawdown'), dw.failures[0]);
  const dr = S.checkConsistency(mutate(base, { Drawdown: `${(dd + 0.2).toFixed(3)}%` }));
  check('回撤差 0.2 个百分点（超过 LEAN 的舍入粒度）也被发现', !dr.ok && failedIds(dr).includes('drawdown'));

  const oc = S.checkConsistency(mutate(base, { 'Total Orders': String(Object.keys(base.orders).length + 1) }));
  check('订单数对不上被发现', !oc.ok && failedIds(oc).includes('orders'), oc.failures[0]);
  const filledOnly = Object.values(base.orders).filter((o) => o.status === 3).length;
  const of = S.checkConsistency(mutate(base, { 'Total Orders': String(filledOnly) }));
  check('订单数按 LEAN 口径数全部订单（只数成交的会对不上）', !of.ok && failedIds(of).includes('orders'));

  const ns = S.checkConsistency(mutate(base, { 'Sharpe Ratio': 'NaN' }));
  check('夏普是 NaN 被发现', !ns.ok && failedIds(ns).includes('finite:Sharpe Ratio'), ns.failures[0]);
  const inf = S.checkConsistency(mutate(base, { 'Sortino Ratio': '∞' }));
  check('其他头条数字是 ∞ 也被发现', !inf.ok && failedIds(inf).includes('finite:Sortino Ratio'));
  const miss = structuredClone(base); delete miss.statistics['Net Profit'];
  check('缺少头条指标被发现', !S.checkConsistency(miss).ok);

  const ee = S.checkConsistency(mutate(base, { 'End Equity': (parseFloat(base.statistics['End Equity']) * 1.01).toFixed(2) }));
  check('期末权益和曲线对不上被发现', !ee.ok && failedIds(ee).includes('end'));
  const wl = S.checkConsistency(mutate(base, { 'Loss Rate': '20%' }));
  check('胜率 + 败率 ≠ 100% 被发现', !wl.ok && failedIds(wl).includes('winloss'), wl.failures[0]);

  // 只改曲线、不改统计：LEAN 的数字和曲线对不上（例如结果文件被截断）
  const cut = structuredClone(base);
  cut.charts['Strategy Equity'].series.Equity.values = cut.charts['Strategy Equity'].series.Equity.values.slice(0, -200);
  const cc = S.checkConsistency(cut);
  check('曲线被截断：净利润 / 期末权益对不上', !cc.ok && failedIds(cc).includes('end') && failedIds(cc).includes('netProfit'));

  // 只核对，不修改：输入原样不动
  const before = JSON.stringify(mutate(base, { 'Net Profit': `${(reported * 2).toFixed(3)}%` }));
  const input = JSON.parse(before); S.checkConsistency(input);
  check('核对不会修改输入（不自动修正）', JSON.stringify(input) === before);

  const none = leanLike({ nTrades: 0, wins: 0 });
  check('没有平仓交易时胜率败率都是 0 不算矛盾', S.checkConsistency(none).ok);
}

/* ---------- main 关卡：临时目录里的端到端 ---------- */
{
  const pid = 4242;
  const write = async (bid, result, extra = {}) => {
    const dir = path.join(process.env.HELM_PROJECTS_DIR, String(pid), 'backtests', bid);
    await mkdir(path.join(dir, 'out'), { recursive: true });
    await writeFile(path.join(dir, 'out', `${bid}.json`), JSON.stringify(result));
    await writeFile(path.join(dir, 'meta.json'), JSON.stringify({ backtestId: bid, projectId: pid, name: bid, status: 'Completed.', role: 'candidate', period: 'dev', created: new Date().toISOString(), summary: { sharpeRatio: 2.5 }, ...extra }));
  };
  // 强信号且自洽：统计检验应当通过、可以标 main
  const strong = leanLike({ years: 3, drift: 0.0015, vol: 0.006, seed: 5 });
  await write('aaaa0001', strong);
  const good = await E.validateBacktest({ projectId: pid, backtestId: 'aaaa0001' });
  const g0 = good.success && good.validation.gates[0];
  check('自洽的回测：关卡里有一致性一项且通过', g0 && g0.id === 'consistency' && g0.ok, g0 && g0.detail);
  const mainOk = await E.updateBacktest({ projectId: pid, backtestId: 'aaaa0001', role: 'main' });
  check('自洽且统计检验通过：可以标 main', good.success && good.validation.pass === true && mainOk.success, mainOk.success ? '' : String(mainOk.errors).slice(0, 120));

  // 同一条曲线，但净利润报成两倍：其余关卡都能过，唯独一致性不过 → 不能标 main
  const bad = mutate(strong, { 'Net Profit': `${(parseFloat(strong.statistics['Net Profit']) * 2).toFixed(3)}%` });
  await write('bbbb0002', bad);
  const v = await E.validateBacktest({ projectId: pid, backtestId: 'bbbb0002' });
  const others = v.success && v.validation.gates.filter((g) => g.id !== 'consistency');
  check('矛盾的回测：统计检验判不通过，原因是「指标互相矛盾」', v.success && !v.validation.pass && v.validation.gates[0].zh === '指标互相矛盾' && others.every((g) => g.ok), v.success ? v.validation.gates[0].detail : '');
  const m = await E.updateBacktest({ projectId: pid, backtestId: 'bbbb0002', role: 'main' });
  check('矛盾的回测不能标 main，拒绝理由里写明「指标互相矛盾」', !m.success && /指标互相矛盾/.test(m.errors.join('')), String(m.errors).slice(0, 100));
  const meta = (await E.backtestsList({ projectId: pid })).backtests.find((b) => b.backtestId === 'bbbb0002');
  check('被拒后降为候选，mainRejected 里可见', meta.role === 'candidate' && meta.mainRejected.some((x) => /指标互相矛盾/.test(x)));
  const still = (await E.backtestsList({ projectId: pid })).backtests.find((b) => b.backtestId === 'aaaa0001');
  check('原来的 main 不受影响', still.role === 'main');
  check('结果文件没有被改动（不自动修正）', JSON.stringify(JSON.parse(await (await import('node:fs/promises')).readFile(path.join(process.env.HELM_PROJECTS_DIR, String(pid), 'backtests', 'bbbb0002', 'out', 'bbbb0002.json'), 'utf8'))) === JSON.stringify(bad));
}

/* ---------- 可选：真实 LEAN ---------- */
async function waitDone(projectId, backtestId, timeoutMs = 5 * 60 * 1000) {
  const t0 = Date.now();
  for (;;) {
    const r = await E.backtestsRead({ projectId, backtestId });
    const st = r.success && r.backtest.status;
    if (st && !/Queue|Progress/.test(st)) return r.backtest;
    if (Date.now() - t0 > timeoutMs) return r.success ? r.backtest : null;
    await new Promise((res) => setTimeout(res, 1000));
  }
}
if (LEAN) {
  const status = await E.engineStatus();
  if (!status.ok) leanSkip(check, status);
  else {
    for (const [label, code] of [['买入持有（默认模板）', undefined], ['均线交叉（有平仓交易）', E.TEMPLATES.sma]]) {
      const p = await E.createProject({ name: `Consistency ${label}`, ...(code ? { code } : {}) });
      const pid = p.projects[0].projectId;
      const b = await E.createBacktest({ projectId: pid, name: label, role: 'debug', period: 'dev' });
      const done = b.backtest && await waitDone(pid, b.backtest.backtestId);
      if (!done || !/Completed/.test(done.status)) { check(`真实 LEAN：${label} 跑完`, false, done && `${done.status} ${done.error || ''}`); continue; }
      const v = await E.validateBacktest({ projectId: pid, backtestId: b.backtest.backtestId });
      const c = v.success && v.validation.consistency;
      check(`真实 LEAN：${label} 通过一致性核对`, c && c.ok && !c.skipped, c ? (c.failures.join('；') || `${c.checks.length} 项，最紧 ${c.worst.id} ${c.worst.ratio.toFixed(2)}×容差`) : String(v.errors));
    }
  }
}

await rm(TMP, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
