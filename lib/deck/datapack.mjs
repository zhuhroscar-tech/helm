// 汇报的「数据包」：幻灯片上能出现的所有数字，都从这里来（只读 Helm 保存的结果，不经过模型）。
// 模型拿到的是 facts 表（每个数字一个键，比如 b1.cagr → "6.9%"），写文字时只能用 {{b1.cagr}} 这样的占位符；
// 图表也只写「哪个回测、哪种图」，序列由渲染器从这里取。
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { READ_ENDPOINTS, PROJECTS_DIR } from '../engine.mjs';
import { listSessions } from '../paper.mjs';
import { listResearch } from '../qlib.mjs';
import { localize } from '../i18n.mjs';

const MAX_POINTS = 420; // 每条曲线最多这么多点（PPT 原生图表点太多会卡）
const MAX_BACKTESTS = 6;

const pct = (v, d = 1) => (v == null || !Number.isFinite(v) ? null : `${(v * 100).toFixed(d)}%`);
const sgn = (v, d = 1) => (v == null || !Number.isFinite(v) ? null : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%`);
const num = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : v.toFixed(d));
const pnum = (s) => { const m = String(s ?? '').replace(/[,$\s]/g, '').match(/^-?[\d.]+/); return m ? Number(m[0]) : null; };
const ppct = (s) => { const v = pnum(s); return v == null ? null : v / 100; };
const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);

function downsample(points, n = MAX_POINTS) {
  if (points.length <= n) return points;
  const step = (points.length - 1) / (n - 1);
  const out = [];
  for (let i = 0; i < n; i++) out.push(points[Math.round(i * step)]);
  return out;
}

// LEAN 的序列：[[秒, 值, …]] → 每天最后一个值
function daily(values) {
  const m = new Map();
  for (const v of values || []) if (Array.isArray(v) && Number.isFinite(v[1])) m.set(day(v[0]), v[1]);
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function maxDrawdown(vals) {
  let peak = -Infinity; let mdd = 0; const dd = [];
  for (const v of vals) { peak = Math.max(peak, v); const d = peak > 0 ? v / peak - 1 : 0; dd.push(d); mdd = Math.min(mdd, d); }
  return { mdd, dd };
}

function cagrOf(series) {
  if (series.length < 2) return null;
  const [d0, v0] = series[0]; const [d1, v1] = series[series.length - 1];
  const yrs = (Date.parse(d1) - Date.parse(d0)) / (365.25 * 864e5);
  return yrs > 0 && v0 > 0 ? (v1 / v0) ** (1 / yrs) - 1 : null;
}

// 按月、按年的收益（月末对月末）
function periodic(series) {
  const monthEnd = new Map();
  for (const [d, v] of series) monthEnd.set(d.slice(0, 7), v);
  const months = [...monthEnd.entries()];
  const cells = {}; const year = {};
  let prev = series.length ? series[0][1] : null;
  const yearStart = {};
  for (const [ym, v] of months) {
    const [y, m] = ym.split('-');
    (cells[y] = cells[y] || Array(12).fill(null))[Number(m) - 1] = prev ? v / prev - 1 : null;
    if (!(y in yearStart)) yearStart[y] = prev;
    year[y] = yearStart[y] ? v / yearStart[y] - 1 : null;
    prev = v;
  }
  return { cells, year, years: Object.keys(cells).sort() };
}

async function chart(projectId, backtestId, name) {
  const r = await READ_ENDPOINTS['backtests/chart/read']({ projectId, backtestId, name });
  return r && r.success ? r.chart : null;
}

const PERIOD = { dev: ['开发期', 'Development'], holdout: ['验证期', 'Holdout'] };
const MONTHS = { zh: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'], en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] };

/** 选哪些回测：用户指定的；否则主版本 + 验证期 + 开发期里夏普最高的几个 */
export function pickBacktests(list, ids) {
  const done = list.filter((b) => b.status === 'Completed.' && !b.error);
  if (Array.isArray(ids) && ids.length) return ids.map((id) => done.find((b) => b.backtestId === id)).filter(Boolean).slice(0, MAX_BACKTESTS);
  const main = done.filter((b) => b.role === 'main');
  const hold = done.filter((b) => b.period === 'holdout' && !main.includes(b));
  const rest = done.filter((b) => !main.includes(b) && !hold.includes(b)).sort((a, b) => (b.sharpeRatio ?? -9) - (a.sharpeRatio ?? -9));
  return [...main, ...hold, ...rest].slice(0, Math.min(MAX_BACKTESTS, Math.max(3, main.length + hold.length + 2)));
}

export async function buildDataPack({ projectId, backtestIds = null, lang = 'zh' }) {
  const L = (zh, en) => (lang === 'en' ? en : zh);
  const projects = (await READ_ENDPOINTS['projects/read']({})).projects || [];
  const project = projects.find((p) => p.projectId === projectId);
  if (!project) throw new Error(`项目 ${projectId} 不存在`);
  const files = (await READ_ENDPOINTS['files/read']({ projectId })).files || [];
  const spec = (files.find((f) => f.name === 'spec.md') || {}).content || '';
  const list = (await READ_ENDPOINTS['backtests/list']({ projectId })).backtests || [];
  const chosen = pickBacktests(list, backtestIds);
  if (!chosen.length) throw new Error(L('这个项目还没有跑完的回测，没有东西可以汇报', 'This project has no finished backtest to report on'));

  const backtests = [];
  const facts = {};
  let trials = null;
  for (const [i, s] of chosen.entries()) {
    const ref = `b${i + 1}`;
    const read = (await READ_ENDPOINTS['backtests/read']({ projectId, backtestId: s.backtestId })).backtest || {};
    const st = read.statistics || {};
    const val = (await READ_ENDPOINTS['backtests/validate']({ projectId, backtestId: s.backtestId })).validation || {};
    const nums = val.numbers || {};
    if (nums.trials != null) trials = Math.max(trials || 0, nums.trials);
    const eqC = await chart(projectId, s.backtestId, 'Strategy Equity');
    const bmC = await chart(projectId, s.backtestId, 'Benchmark');
    const eq = daily(eqC && eqC.series && (eqC.series.Equity || Object.values(eqC.series)[0] || {}).values);
    const bm = daily(bmC && bmC.series && (Object.values(bmC.series)[0] || {}).values);
    const bmMap = new Map(bm);
    // 两条线对齐到同一组日期，起点都归一到 100
    const dates = eq.map(([d]) => d).filter((d) => !bm.length || bmMap.has(d));
    const eqMap = new Map(eq);
    const S = dates.map((d) => eqMap.get(d));
    const B = bm.length ? dates.map((d) => bmMap.get(d)) : null;
    const norm = (arr) => (arr && arr.length ? arr.map((v) => +(v / arr[0] * 100).toFixed(2)) : null);
    const sN = norm(S); const bN = norm(B);
    const sDD = maxDrawdown(S); const bDD = B ? maxDrawdown(B) : null;
    const idx = downsample(dates.map((_, k) => k));
    const strat = periodic(dates.map((d, k) => [d, S[k]]));
    const bench = B ? periodic(dates.map((d, k) => [d, B[k]])) : null;
    const benchCagr = B ? cagrOf(dates.map((d, k) => [d, B[k]])) : null;
    const start = dates[0] || ''; const end = dates[dates.length - 1] || '';
    const years = start && end ? (Date.parse(end) - Date.parse(start)) / (365.25 * 864e5) : null;
    const cagr = ppct(st['Compounding Annual Return']);
    const f = {
      cagr: { value: cagr, text: pct(cagr) },
      net: { value: ppct(st['Net Profit']), text: pct(ppct(st['Net Profit']), 0) },
      sharpe: { value: nums.sharpe ?? pnum(st['Sharpe Ratio']), text: num(nums.sharpe ?? pnum(st['Sharpe Ratio'])) },
      maxdd: { value: -Math.abs(ppct(st.Drawdown) ?? 0), text: pct(-Math.abs(ppct(st.Drawdown) ?? 0)) },
      vol: { value: pnum(st['Annual Standard Deviation']), text: pct(pnum(st['Annual Standard Deviation'])) },
      winrate: { value: ppct(st['Win Rate']), text: pct(ppct(st['Win Rate']), 0) },
      trades: { value: pnum(st['Total Orders']), text: st['Total Orders'] ?? null },
      fees: { value: pnum(st['Total Fees']), text: st['Total Fees'] ?? null },
      excess: { value: nums.annualExcess ?? null, text: sgn(nums.annualExcess) },
      excessLo: { value: nums.excessCi?.[0] ?? null, text: sgn(nums.excessCi?.[0]) },
      excessHi: { value: nums.excessCi?.[1] ?? null, text: sgn(nums.excessCi?.[1]) },
      pExcessLe0: { value: nums.pExcessLe0 ?? null, text: pct(nums.pExcessLe0, 0) },
      sharpeLo: { value: nums.sharpeCi?.[0] ?? null, text: num(nums.sharpeCi?.[0]) },
      sharpeHi: { value: nums.sharpeCi?.[1] ?? null, text: num(nums.sharpeCi?.[1]) },
      dsr: { value: nums.dsr ?? null, text: pct(nums.dsr, 0) },
      trials: { value: nums.trials ?? null, text: nums.trials != null ? String(nums.trials) : null },
      benchCagr: { value: benchCagr, text: pct(benchCagr) },
      benchMaxdd: { value: bDD ? bDD.mdd : null, text: bDD ? pct(bDD.mdd) : null },
      years: { value: years, text: years != null ? years.toFixed(1) : null },
      start: { value: null, text: start },
      end: { value: null, text: end },
      verdict: { value: null, text: val.pass ? L('通过全部统计检验', 'passed every statistical check') : L('没有通过统计检验', 'did not pass the statistical checks') },
    };
    for (const [k, v] of Object.entries(f)) if (v.text != null) facts[`${ref}.${k}`] = { ...v, src: s.backtestId };
    const gates = (val.gates || []).map((g) => ({ id: g.id, ok: Boolean(g.ok), label: localize(lang, g.zh), detail: localize(lang, g.detail || '') }));
    backtests.push({
      ref, backtestId: s.backtestId, name: s.name, short: String(s.name).replace(/[（(].*$/, '').slice(0, 40) || ref,
      role: s.role || null, period: s.period || null, periodText: L(...(PERIOD[s.period] || ['—', '—'])),
      start, end, pass: Boolean(val.pass), gates, facts: f,
      codeHash: read.fingerprint?.code?.hash || null, dataHash: read.fingerprint?.data?.hash || null,
      benchmarkName: null,
      series: {
        equity: { dates: idx.map((k) => dates[k]), strategy: idx.map((k) => sN[k]), benchmark: bN ? idx.map((k) => bN[k]) : null },
        drawdown: { dates: idx.map((k) => dates[k]), strategy: idx.map((k) => +sDD.dd[k].toFixed(4)), benchmark: bDD ? idx.map((k) => +bDD.dd[k].toFixed(4)) : null },
        annual: { years: strat.years, strategy: strat.years.map((y) => strat.year[y] ?? 0), benchmark: bench ? strat.years.map((y) => bench.year[y] ?? 0) : null },
      },
      monthly: { years: strat.years, months: MONTHS[lang === 'en' ? 'en' : 'zh'], cells: strat.cells, year: strat.year },
    });
  }
  // 「主角」：主版本 > 验证期 > 第一个
  const primary = (backtests.find((b) => b.role === 'main') || backtests.find((b) => b.period === 'holdout') || backtests[0]).ref;

  // 模拟实盘：只要冻结之后的前向表现
  const paper = [];
  try {
    for (const s of ((await listSessions({ projectId })).sessions || []).slice(0, 4)) {
      const sm = s.summary || {};
      const ref = `p${paper.length + 1}`;
      const f = {
        return: { value: sm.return ?? null, text: sgn(sm.return) },
        benchReturn: { value: sm.benchmarkReturn ?? null, text: sgn(sm.benchmarkReturn) },
        maxdd: { value: sm.maxDrawdown ?? null, text: pct(sm.maxDrawdown) },
        days: { value: sm.days ?? null, text: sm.days != null ? String(sm.days) : null },
        since: { value: null, text: s.frozenAt || String(s.created || '').slice(0, 10) },
        asOf: { value: null, text: sm.dataDate || null },
      };
      for (const [k, v] of Object.entries(f)) if (v.text != null) facts[`${ref}.${k}`] = { ...v, src: s.sessionId };
      paper.push({ ref, name: s.name, mode: s.mode, status: s.status, source: s.sourceName, facts: f });
    }
  } catch { /* 没有模拟实盘 */ }

  // 想法检验 / 研究：只带结论文字，不带本机路径
  const research = [];
  try {
    for (const j of ((await listResearch({ projectId })).jobs || []).slice(0, 4)) {
      research.push({ ref: `r${research.length + 1}`, title: j.title || '', idea: j.idea || '', verdict: j.verdict || '', status: j.status, universe: j.target || '' });
    }
  } catch { /* 没有研究 */ }

  if (trials != null) facts.trials = { value: trials, text: String(trials), src: 'trials' };
  const now = new Date();
  const name = (lang === 'en' ? project.nameEn : project.nameZh) || project.name;
  return {
    meta: {
      projectId, lang, generatedAt: now.toISOString(),
      dateText: lang === 'en' ? now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`,
      methodNotes: [
        L('回测引擎：QuantConnect LEAN（开源），在本机运行；行情为 Yahoo Finance 复权日线。', 'Backtest engine: QuantConnect LEAN (open source), run locally; prices are adjusted daily bars from Yahoo Finance.'),
        L('开发期用来设计和调整策略；验证期的数据在开发时没有看过，只运行一次。', 'The development period was used to design and tune the strategy; holdout data was not looked at during development and was run once.'),
        trials != null ? L(`在同一段历史上一共尝试过 ${trials} 个版本；去膨胀夏普已经扣除了多次尝试带来的运气成分。`, `${trials} versions were tried on the same history; the deflated Sharpe ratio adjusts for that.`) : null,
        L('回测是假设业绩，不代表实际交易结果，也不预示未来表现。', 'Backtests are hypothetical results. They are not actual trading results and do not predict future performance.'),
      ].filter(Boolean),
    },
    project: { name, description: project.description || '', spec: spec.slice(0, 6000) },
    primary, backtests, paper, research, facts,
  };
}

/** 给模型看的精简版：facts 表 + 每个回测的名字、阶段、检验结果（不带序列） */
export function packForModel(pack) {
  return {
    project: pack.project,
    primary: pack.primary,
    backtests: pack.backtests.map((b) => ({ ref: b.ref, name: b.name, period: b.period, role: b.role, start: b.start, end: b.end, passedChecks: b.pass, gates: b.gates.map((g) => ({ ok: g.ok, label: g.label, detail: g.detail })), years: b.monthly.years })),
    paper: pack.paper.map((p) => ({ ref: p.ref, name: p.name, mode: p.mode, status: p.status, source: p.source })),
    research: pack.research,
    facts: Object.fromEntries(Object.entries(pack.facts).map(([k, v]) => [k, v.text])),
  };
}

export async function readProjectFile(projectId, name) {
  try { return await readFile(path.join(PROJECTS_DIR, String(projectId), name), 'utf8'); } catch { return null; }
}
