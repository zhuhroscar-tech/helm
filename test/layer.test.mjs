// 「叠加 Qlib 选股」测试：node test/layer.test.mjs
// 模型调用全部 mock；任务文件写到临时目录。
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as L from '../lib/layer.mjs';

let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failed += 1;
};
const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-layer-'));

const GEM = [{ name: 'main.py', content: 'class G(QCAlgorithm):\n    def initialize(self):\n        tickers = ["SPY", "EFA", "EEM", "AGG"]\n' }];
const BTS = [
  { backtestId: 'c1', name: 'cand', role: 'candidate', status: 'Completed.' },
  { backtestId: 'h1', name: 'holdout', role: 'main', status: 'Completed.', period: 'holdout' },
  { backtestId: 'm1', name: 'main', role: 'main', status: 'Completed.', compoundingAnnualReturn: '10.3%', sharpeRatio: 0.4 },
  { backtestId: 'e1', name: 'broken', role: 'main', status: 'Runtime Error', error: 'x' },
];
const RAW = {
  summary: 'Good fit for the SPY leg.',
  options: [
    { title: 'Top 20 momentum', tests: 'Do momentum picks beat SPY inside GEM?', how: 'Hold top 20', replaces: 'SPY', universe: 'sp500', signalType: 'idea', signal: '12-1 momentum', holdings: 'top 20', trials: 2, risk: 'medium', risks: ['turnover'], fit: 5 },
    { title: 'Invent TLT', tests: 'x', replaces: 'TLT', universe: 'bonds', trials: 1 },
    { title: 'Wrong universe', tests: 'x', replaces: 'SPY', universe: 'nasdaq100', trials: 1 },
    { title: '', tests: 'no title', replaces: 'SPY' },
    { title: 'LightGBM', tests: 'Does a model beat SPY?', replaces: 'spy', universe: 'sp500', signalType: 'weird', trials: 99, risk: 'extreme', fit: 9, extra: 'drop me' },
    { title: 'Three', tests: 't', replaces: 'SPY', universe: 'sp500', trials: 0 },
    { title: 'Four', tests: 't', replaces: 'SPY', universe: 'sp500' },
    { title: 'Five', tests: 't', replaces: 'SPY', universe: 'sp500' },
  ],
};

try {
  /* ---------- 预检 ---------- */
  {
    check('选基准回测：主版本优先，跳过验证期 / 出错的', L.pickBacktest(BTS).backtestId === 'm1');
    check('没有主版本：用候选', L.pickBacktest(BTS.filter((b) => b.backtestId !== 'm1')).backtestId === 'c1');
    const onlyBench = [{ backtestId: 'b1', role: 'benchmark', status: 'Completed.' }, { backtestId: 'd1', role: 'debug', status: 'Completed.' }];
    check('只有基准 / 调试回测：不拿来当基线', L.pickBacktest(onlyBench) === null);
    check('没有角色的回测仍然可以当基线', L.pickBacktest([...onlyBench, { backtestId: 'x1', status: 'Completed.' }]).backtestId === 'x1');
    const pc = L.precheck({ files: GEM, backtests: BTS });
    check('GEM：可以叠加，只有 SPY 一条腿', pc.ok && pc.legs.length === 1 && pc.legs[0].etf === 'SPY' && pc.legs[0].universe === 'sp500' && pc.legs[0].pit === 'pit');
    check('没有回测：不行', !L.precheck({ files: GEM, backtests: [] }).ok);
    const noLeg = L.precheck({ files: [{ name: 'main.py', content: 't = ["EFA","EEM","AGG"]' }], backtests: BTS });
    check('只有 EFA/EEM/AGG：仍可叠加（不选股的层），但不给选股层', noLeg.ok && noLeg.legs.length === 0 && /没有地方叠加/.test(noLeg.qlibBlocked));
    const sig = L.precheck({ files: [{ name: 'main.py', content: 'from helm_data import HelmSignals\nx="SPY"' }], backtests: BTS });
    check('已用 HelmSignals：仍可叠加，但不再给选股层', sig.ok && sig.legs.length === 0 && /HelmSignals/.test(sig.qlibBlocked));
    check('识别已经用了 HelmVol', L.precheck({ files: [{ name: 'main.py', content: 'from helm_data import HelmVol\nx="SPY"' }], backtests: BTS }).usesVol === true);
    const uni = [{ key: 'sp500', label: 'S&P 500', kind: 'point-in-time', exported: null }, { key: 'nasdaq100', label: 'NDX', kind: 'partial-point-in-time', exported: { end: '2026-11-20' } }];
    const pc2 = L.precheck({ files: [{ name: 'main.py', content: 'a="SPY"; b="QQQ"; c="QQQ"' }], backtests: BTS, universes: uni });
    check('多条腿 + 股票池状态', pc2.ok && pc2.legs.length === 2 && pc2.legs.find((l) => l.etf === 'SPY').ready === false && pc2.legs.find((l) => l.etf === 'QQQ').pit === 'partial');
    check('注释和 .md 不算', L.tickersInCode([{ name: 'spec.md', content: '"SPY"' }]).size === 0);
  }

  /* ---------- 整理模型输出 ---------- */
  const legs = L.precheck({ files: GEM, backtests: BTS }).legs;
  {
    const r = L.sanitizeOptions(RAW, legs, 'en');
    const lay = r.options.filter((o) => o.kind === 'layer');
    check('最多 4 个方案 + 「不加这一层」', lay.length === L.MAX_OPTIONS && r.options.length === L.MAX_OPTIONS + 1 && r.options.at(-1).kind === 'none');
    check('丢掉：编造的腿 / 不对的股票池 / 没标题', !r.options.some((o) => ['Invent TLT', 'Wrong universe'].includes(o.title)) && lay.every((o) => o.title));
    const g = lay.find((o) => o.title === 'LightGBM');
    check('截断：trials 1–10、风险和信号类型只认枚举、fit 1–5', g.trials === 10 && g.risk === 'medium' && g.signalType === 'idea' && g.fit === 5);
    check('不带多余字段', !('extra' in g));
    check('编号 a,b,c,d,none', r.options.map((o) => o.id).join(',') === 'a,b,c,d,none');
    check('replaces 大小写统一', g.replaces === 'SPY');
    check('「不加这一层」：0 次尝试', r.options.at(-1).trials === 0);
    const r2 = L.sanitizeOptions({ options: [] }, legs, 'zh');
    check('模型什么都没给：只剩「不加这一层」', r2.options.length === 1 && r2.options[0].title === '不加这一层');
    check('垃圾输入不报错', L.sanitizeOptions(null, legs).options.length === 1 && L.sanitizeOptions({ options: 'x' }, legs).options.length === 1);
    const snapLegs = [{ etf: 'DIA', universe: 'dia', label: 'Dow 30', pit: 'snapshot', ready: true }];
    const r3 = L.sanitizeOptions({ options: [{ title: 'Dow', tests: 't', replaces: 'DIA', universe: 'dia', risk: 'low' }] }, snapLegs, 'en');
    check('没有历史成分股：自动写上幸存者偏差，风险至少中', /survivorship/i.test(r3.options[0].risks[0]) && r3.options[0].risk === 'medium');
  }

  /* ---------- 不选股的方案 + 什么时候推荐 ---------- */
  {
    const alts0 = L.alternativeOptions({ peers: [], lang: 'zh' });
    check('没有别的策略：仓位层 + 先做互补策略', alts0.map((o) => o.kind).join(',') === 'vol,complement');
    const peers = [{ projectId: 2, name: '债券趋势', backtestId: 'b2', sharpe: 0.6 }, { projectId: 3, name: '均值回归', backtestId: 'b3', sharpe: 0.5 }];
    const alts1 = L.alternativeOptions({ peers, usesVol: true, lang: 'en' });
    check('有别的策略、已用 HelmVol：只给策略组合', alts1.length === 1 && alts1[0].kind === 'portfolio' && alts1[0].peers.length === 2 && /债券趋势/.test(alts1[0].tests));
    const q = L.sanitizeOptions(RAW, legs, 'zh');
    const good = L.composeOptions({ qlib: { ...q, outlook: 'promising' }, alts: alts0, priorIdeas: [], lang: 'zh' });
    check('选股前景好：选股方案在前（最多 3 个），不标推荐', !good.recommendAlt && good.options[0].kind === 'layer' && good.options.filter((o) => o.kind === 'layer').length === 3 && good.options.every((o) => !o.recommended) && good.options.at(-1).kind === 'none');
    const prior = L.priorIdeaResults([
      { mode: 'idea', idea: '动量', ideaResult: { factors: [{ label: '12-1 动量', verdict: 'none' }] } },
      { mode: 'full', title: 'x' },
      { mode: 'idea', idea: '低波', ideaResult: { factors: [{ label: 'a', verdict: 'none' }, { label: 'b', verdict: 'weak' }] } },
    ]);
    check('读出之前的想法检验结论', prior.length === 2 && prior[0].best === 'none' && prior[1].best === 'weak');
    const bad = L.composeOptions({ qlib: { ...q, outlook: 'promising' }, alts: alts0, priorIdeas: prior, lang: 'zh' });
    check('之前没有信号：不选股的方案排前面并标推荐，选股最多留 2 个', bad.recommendAlt && bad.options[0].kind === 'vol' && bad.options[0].recommended && bad.options.filter((o) => o.kind === 'layer').length === 2 && /1 次想法检验没有信号/.test(bad.why.join()));
    const poor = L.composeOptions({ qlib: { ...q, outlook: 'poor' }, alts: alts0, priorIdeas: [], lang: 'en' });
    check('模型判断前景差：也推荐不选股的方案', poor.recommendAlt && poor.options[0].recommended && /weak/.test(poor.why.join()));
    const blocked = L.composeOptions({ qlib: { summary: '', options: L.sanitizeOptions(null, [], 'zh').options }, alts: alts0, qlibBlocked: '没有可换的腿', lang: 'zh' });
    check('qlib 放不进去：只有不选股的方案 + 不加', blocked.recommendAlt && blocked.options.map((o) => o.kind).join(',') === 'vol,complement,none');
    check('「不加这一层」永远在最后', [good, bad, poor, blocked].every((r) => r.options.at(-1).kind === 'none'));
    let called = 0;
    const nr = await L.runAssessment({ context: {}, legs: [], lang: 'zh', runModel: async () => { called += 1; return '{}'; } });
    check('没有可换的腿：不调用模型', called === 0 && nr.options.length === 1 && nr.options[0].kind === 'none');
    const tv = L.taskMessage({ option: alts0[0], backtest: { backtestId: 'm1', name: 'main' }, lang: 'zh' });
    check('仓位层任务：一个事先定好的版本 + 停止条件 + 不动主版本', /HelmVol\(target=0\.10/.test(tv) && /至少小 25%/.test(tv) && /0\.05/.test(tv) && /不改当前主版本/.test(tv) && /m1/.test(tv));
    const tp = L.taskMessage({ option: alts1[0], backtest: { backtestId: 'm1' }, lang: 'en' });
    check('组合任务：先确认组成策略通过检验、权重事先定、和最好的单个策略对照', /validate_backtest/.test(tp) && /fixed in advance/.test(tp) && /best single component as the ablation/.test(tp) && /project 2, backtest b2/.test(tp) && /Never optimise weights/.test(tp));
    const tc = L.taskMessage({ option: alts0[1], backtest: {}, lang: 'zh' });
    check('互补策略任务：先 ask_user 再动手，新项目，汇报相关性', /ask_user/.test(tc) && /新项目/.test(tc) && /相关性/.test(tc));
    check('提示词：不重复已经没有信号的因子、要给前景判断', /priorIdeaTests/.test(L.assessPrompt('en')) && /"outlook"/.test(L.assessPrompt('en')));
  }

  /* ---------- qlib 择时过滤 + 因子归因 ---------- */
  {
    const t = L.alternativeOptions({ equityLeg: 'SPY', breadth: 'ready', peers: [], lang: 'zh' });
    check('有美股 ETF：给择时过滤，排在最前', t[0].kind === 'timing' && t[0].equityLeg === 'SPY' && t.map((o) => o.kind).join(',') === 'timing,vol,complement');
    check('宽度已算好：风险里不提准备数据', !t[0].risks.some((r) => /prepare|build_breadth/.test(r)));
    const tp = L.alternativeOptions({ equityLeg: 'SPY', breadth: 'prepare', lang: 'en' });
    check('股票池没准备：风险里写明先 prepare_universe', /prepare_universe/.test(tp[0].risks[0]));
    check('没有美股 ETF：不给择时过滤', !L.alternativeOptions({ equityLeg: null }).some((o) => o.kind === 'timing'));
    check('已经用了 HelmBreadth：不再给', !L.alternativeOptions({ equityLeg: 'SPY', usesBreadth: true }).some((o) => o.kind === 'timing'));
    const tm = L.taskMessage({ option: tp[0], backtest: { backtestId: 'm1' }, lang: 'en' });
    check('择时任务：只测一次事先定好的序列、没有信号就停、候选 vs 消融、不动主版本', /test_timing_signal ONCE/.test(tm) && /\["pct_above_200"\]/.test(tm) && /stop and report/.test(tm) && /ablation/.test(tm) && /Do not change the current main version/.test(tm) && /prepare_universe/.test(tm));
    const tz = L.taskMessage({ option: t[0], backtest: { backtestId: 'm1' }, lang: 'zh' });
    check('择时任务（中文）：宽度已算好时不让再准备', !/prepare_universe|build_breadth\("sp500"\)。/.test(tz) && /HelmBreadth/.test(tz));
    check('precheck 识别 HelmBreadth', L.precheck({ files: [{ name: 'main.py', content: 'from helm_data import HelmBreadth\nx="SPY"' }], backtests: BTS }).usesBreadth === true);
    const attr = { available: true, r2: 0.7, alpha: { annual: 0.01, t: 0.5 }, exposures: [{ factor: 'mom', beta: 0.3, t: 4 }], summary: '动量暴露明显' };
    const ctx = L.buildContext({ files: GEM, backtest: BTS[2], legs, attribution: attr, lang: 'zh' });
    check('模型材料里带因子归因', ctx.factorAttribution && ctx.factorAttribution.exposures[0].factor === 'mom' && ctx.factorAttribution.summary === '动量暴露明显');
    check('没有归因时为 null', L.buildContext({ files: GEM, backtest: BTS[2], legs }).factorAttribution === null);
    check('提示词：别把已有暴露当新东西', /factorAttribution/.test(L.assessPrompt('en')));
  }

  /* ---------- 提示词和任务 ---------- */
  {
    const p = L.assessPrompt('en');
    check('提示词：只许用给定的腿、不要自己加「不加」', /replaceableLegs/.test(p) && /do not include one/.test(p));
    check('提示词：要求 JSON、语言跟界面', /ONE JSON object/.test(p) && /English/.test(p) && /简体中文/.test(L.assessPrompt('zh')));
    const ctx = L.buildContext({ project: { name: '1', nameEn: 'GEM', description: 'd' }, spec: 'x'.repeat(9000), files: GEM, backtest: BTS[2], holdoutRuns: 1, legs, lang: 'en' });
    check('材料：截断 spec、带主版本统计和验证期次数', ctx.spec.length === 6000 && ctx.backtest.sharpe === 0.4 && ctx.holdoutRuns === 1 && ctx.project.name === 'GEM');
    const opt = L.sanitizeOptions(RAW, legs, 'zh').options[0];
    const m = L.taskMessage({ option: opt, backtest: { backtestId: 'm1', name: 'main' }, lang: 'zh' });
    check('任务：带方案、对照回测和护栏', m.includes(opt.title) && m.includes('m1') && /只用开发期/.test(m) && /消融/.test(m) && /不改当前主版本/.test(m) && /不要换着花样/.test(m));
    const me = L.taskMessage({ option: { ...opt, dataReady: false }, backtest: {}, lang: 'en' });
    check('任务（英文）：数据没准备就先 prepare_universe', /prepare_universe/.test(me) && /ablation/.test(me) && !/[一-鿿]/.test(me.replace(opt.title, '').replace(opt.tests, '').replace(opt.how, '').replace(opt.signal, '').replace(opt.holdings, '')));
  }

  /* ---------- 评估（mock 模型） ---------- */
  {
    let n = 0;
    const r = await L.runAssessment({ context: {}, legs, lang: 'en', runModel: async () => { n += 1; return n === 1 ? 'Sure! here you go' : '```json\n' + JSON.stringify(RAW) + '\n```'; } });
    check('第一次不是 JSON：再问一次', n === 2 && r.options.length === 5);
    let threw = false;
    try { await L.runAssessment({ context: {}, legs, runModel: async () => { throw new Error('claude exit 1'); } }); } catch { threw = true; }
    check('模型出错：抛出（由服务端记成 error）', threw);
  }

  /* ---------- 存储 ---------- */
  {
    const id = L.newLayerId(new Date('2026-11-23T10:00:00Z'));
    check('编号格式', /^20261123-100000-[a-f0-9]{4}$/.test(id));
    await L.saveLayer(TMP, { layerId: id, projectId: 7, status: 'ready', result: { options: [] } });
    check('存取', (await L.readLayer(TMP, 7, id)).status === 'ready' && (await L.listLayers(TMP, 7)).length === 1);
    check('非法编号读不到', (await L.readLayer(TMP, 7, '../../etc/passwd')) === null);
    let bad = false;
    try { await L.saveLayer(TMP, { layerId: '../x', projectId: 7 }); } catch { bad = true; }
    check('非法编号存不了', bad);
  }
} finally {
  await rm(TMP, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
