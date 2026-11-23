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
    check('只有 EFA/EEM/AGG：不行', !L.precheck({ files: [{ name: 'main.py', content: 't = ["EFA","EEM","AGG"]' }], backtests: BTS }).ok);
    check('已用 HelmSignals：不行', !L.precheck({ files: [{ name: 'main.py', content: 'from helm_data import HelmSignals\nx="SPY"' }], backtests: BTS }).ok);
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
