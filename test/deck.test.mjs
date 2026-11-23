// 研发汇报（一键生成幻灯片）：node test/deck.test.mjs
// 1) lib/deck/check.mjs：占位符填数、没有出处的数字被标出、常见常数不误报、结构修正
// 2) lib/deck/pipeline.mjs：假模型走完 大纲 → 等确认 → 写稿 → 评审 → 修改 → 渲染；修改环节把数字问题改掉；重启后「进行中」变成中断
// 3) engine/deck：渲染出 pptx（原生图表、页数对）；模板分析（.pptx 取主题色；非 16:9 不当母版）
// 4) server.mjs：设置保存、模板上传（base64）、列表 / 404、坏 id 被拒
// 需要 engine/.venv 里装了 python-pptx；没装时跳过 3) 和渲染部分并说明
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkDeck } from '../lib/deck/check.mjs';
import { DeckService, extractJson, findSoffice } from '../lib/deck/pipeline.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-deck-'));
const PY = path.join(ROOT, 'engine', '.venv', 'bin', 'python');
const HAS_PPTX = existsSync(PY) && spawnSync(PY, ['-I', '-c', 'import pptx, pypdfium2'], { stdio: 'ignore' }).status === 0;
let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); if (!cond) failed += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(50); } return null; };
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

/* ---------- 假数据包：两个回测（开发期 + 验证期），500 个交易日 ---------- */
function fakePack() {
  const days = 500;
  const dates = Array.from({ length: days }, (_, i) => new Date(Date.UTC(2020, 0, 1) + i * 864e5 * 1.45).toISOString().slice(0, 10));
  const series = (drift) => {
    let v = 100; let bv = 100; let peak = 100; let bpeak = 100;
    const s = []; const b = []; const dd = []; const bdd = [];
    dates.forEach((_, i) => {
      v *= 1 + drift + Math.sin(i / 9) * 0.006; bv *= 1 + 0.0004 + Math.cos(i / 11) * 0.005;
      peak = Math.max(peak, v); bpeak = Math.max(bpeak, bv);
      s.push(+v.toFixed(2)); b.push(+bv.toFixed(2)); dd.push(+(v / peak - 1).toFixed(4)); bdd.push(+(bv / bpeak - 1).toFixed(4));
    });
    return { equity: { dates, strategy: s, benchmark: b }, drawdown: { dates, strategy: dd, benchmark: bdd }, annual: { years: ['2020', '2021', '2022'], strategy: [0.08, -0.03, 0.12], benchmark: [0.1, 0.05, -0.02] } };
  };
  const months = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
  const bt = (ref, name, period, drift, f) => ({
    ref, backtestId: `id${ref}`, name, short: name, role: period === 'holdout' ? 'main' : 'candidate', period, periodText: period === 'holdout' ? '验证期' : '开发期',
    start: '2020-01-01', end: '2022-12-30', pass: period === 'dev', facts: f, codeHash: 'abc123', dataHash: 'def456',
    gates: [{ id: 'dsr', ok: period === 'dev', label: '去膨胀夏普 ≥ 95%', detail: '' }, { id: 'excess', ok: false, label: '年化超额显著为正', detail: '' }],
    series: series(drift), monthly: { years: ['2020', '2021', '2022'], months, cells: { 2020: Array(12).fill(0.01), 2021: Array(12).fill(-0.005), 2022: Array(12).fill(0.008) }, year: { 2020: 0.08, 2021: -0.03, 2022: 0.12 } },
  });
  const F = (cagr, sharpe, maxdd, excess) => ({ cagr: { value: cagr, text: `${(cagr * 100).toFixed(1)}%` }, sharpe: { value: sharpe, text: sharpe.toFixed(2) }, maxdd: { value: maxdd, text: `${(maxdd * 100).toFixed(1)}%` }, excess: { value: excess, text: `${excess > 0 ? '+' : ''}${(excess * 100).toFixed(1)}%` }, benchCagr: { value: 0.07, text: '7.0%' }, dsr: { value: 0.52, text: '52%' }, net: { value: 0.3, text: '30%' }, vol: { value: 0.15, text: '15.0%' }, winrate: { value: 0.6, text: '60%' }, trades: { value: 40, text: '40' }, benchMaxdd: { value: -0.2, text: '-20.0%' } });
  const b1 = bt('b1', '方案 A（验证期）', 'holdout', 0.0002, F(0.069, 0.43, -0.327, -0.067));
  const b2 = bt('b2', '方案 A（开发期）', 'dev', 0.0006, F(0.103, 0.61, -0.295, 0.014));
  const facts = {};
  for (const b of [b1, b2]) for (const [k, v] of Object.entries(b.facts)) facts[`${b.ref}.${k}`] = { ...v, src: b.backtestId };
  facts.trials = { value: 27, text: '27', src: 'trials' };
  return {
    meta: { projectId: 1, lang: 'zh', generatedAt: new Date().toISOString(), dateText: '2026年11月20日', methodNotes: ['回测引擎：QuantConnect LEAN。', '回测是假设业绩。'] },
    project: { name: '全球动量轮动', description: '每月在股票和债券之间切换', spec: '每月第一个交易日调仓，持有 12-1 动量最强的资产' },
    primary: 'b1', backtests: [b1, b2], paper: [], research: [], facts,
  };
}
const pack = fakePack();

/* ---------- 1) 数字核对 ---------- */
try {
  const spec = {
    title: '全球动量轮动', subtitle: '验证期跑输标普 500', sections: ['摘要', '结果'],
    slides: [
      { layout: 'exec_summary', section: 0, title: '验证期年化 {{b1.cagr}}，低于开发期的 {{b2.cagr}}', columns: [{ heading: '开发期', bullets: ['夏普 {{b2.sharpe}}', '虚构的 12.7%'] }] },
      { layout: 'chart', section: 1, title: '净值（起点 = 100）', chart: { type: 'equity', bt: 'b9' } },
      { layout: 'wat', section: 7, title: '一共试了 {{trials}} 个版本，95% 区间 {{b1.nope}}' },
      { layout: 'table', section: 1, title: '对比', table: { kind: 'compare', bts: ['b1', 'b2', 'b5'], metrics: ['cagr', 'bogus'] } },
    ],
  };
  const r = checkDeck(spec, pack);
  check('占位符填成数据里的文字', r.spec.slides[0].title === '验证期年化 6.9%，低于开发期的 10.3%', r.spec.slides[0].title);
  const raw = r.issues.filter((x) => x.kind === 'rawNumber').map((x) => x.detail);
  check('没有出处的数字被标出', raw.includes('12.7%'), JSON.stringify(raw));
  check('标普 500、起点 100、95%、年份、12-1（规则里有）不误报', !raw.some((x) => ['500', '100', '95%', '12'].includes(x)), JSON.stringify(raw));
  check('不存在的占位符：标出并显示成 —', r.issues.some((x) => x.kind === 'unknownFact' && x.detail === 'b1.nope') && r.spec.slides[2].title.endsWith('—'));
  check('坏引用改成主回测、未知版式改成要点页、越界章节清空', r.spec.slides[1].chart.bt === 'b1' && r.spec.slides[2].layout === 'bullets' && r.spec.slides[2].section === null);
  check('对比表去掉不存在的回测和指标', JSON.stringify(r.spec.slides[3].table.bts) === '["b1","b2"]' && JSON.stringify(r.spec.slides[3].table.metrics) === '["cagr"]');
  check('原 spec 不被改（模型版本留给修改环节）', spec.slides[0].title.includes('{{b1.cagr}}'));
  const cj = checkDeck({ title: 't', slides: [{ layout: 'chart', title: 'b3 补了数据后回撤更浅', bullets: ['看 b1 的 {{b1.cagr}}'], source: 'Helm 回测 b1（LEAN）' }] }, pack, { audience: 'client' });
  const codes = cj.issues.filter((x) => x.kind === 'jargon');
  check('客户版：正文里的内部代号被标出，来源行和占位符不算', codes.length === 2 && codes.every((x) => !/source/.test(x.where)), JSON.stringify(codes));
  check('团队版：内部代号不管', checkDeck({ title: 't', slides: [{ layout: 'chart', title: 'b3 更好' }] }, pack, { audience: 'team' }).issues.every((x) => x.kind !== 'jargon'));
  check('extractJson：代码块 / 前后废话', extractJson('好的：\n```json\n{"a":1}\n```') .a === 1 && extractJson('Here you go {"b":[1,2]} done').b[1] === 2);
} catch (e) { check('数字核对没有异常', false, e.stack); }

/* ---------- 2) 流水线（假模型） ---------- */
const OUTLINE = { audience: '客户', governingThought: '验证期年化 {{b1.cagr}}，没有跑赢基准', storyline: 's / c / r', sections: ['摘要', '结果', '下一步'],
  slides: [{ section: 0, layout: 'exec_summary', title: '验证期没有通过', points: ['开发期 {{b2.cagr}}'], visual: '' }, { section: 1, layout: 'chart', title: '净值', points: [], visual: 'chart equity b1' }] };
const SPEC = { title: '全球动量轮动', subtitle: '验证期没有跑赢基准', sections: ['摘要', '结果', '下一步'],
  slides: [
    { layout: 'exec_summary', section: 0, title: '验证期年化 {{b1.cagr}}，没有跑赢基准', subtitle: '', columns: [{ heading: '开发期', bullets: ['年化 {{b2.cagr}}', '夏普 {{b2.sharpe}}'], verdict: '接近', tone: 'neutral' }, { heading: '验证期', bullets: ['年化 {{b1.cagr}}', '超额 {{b1.excess}}，编的 33.3%'], verdict: '没有通过', tone: 'negative' }], verdict: '不上线', verdictTone: 'negative' },
    { layout: 'chart', section: 1, title: '验证期净值落后基准', chart: { type: 'equity', bt: 'b1' }, chartTitle: '净值（起点 = 100）', sideTitle: '怎么读', bullets: ['黑线是策略'], takeaway: '超额 {{b1.excess}}' },
    { layout: 'two_charts', section: 1, title: '回撤和逐年收益', left: { heading: '回撤', chart: { type: 'drawdown', bt: 'b1' } }, right: { heading: '逐年', chart: { type: 'annual', bt: 'b1' } } },
    { layout: 'kpis', section: 1, title: '关键数字', kpis: [{ value: '{{b2.cagr}}', label: '年化', highlight: true }, { value: '{{b2.sharpe}}', label: '夏普' }], chart: { type: 'excess_bridge', bt: 'b2' }, chartTitle: '拆解' },
    { layout: 'table', section: 1, title: '检验', table: { kind: 'gates', bt: 'b1' } },
    { layout: 'table', section: 1, title: '版本对比', table: { kind: 'compare', bts: ['b1', 'b2'], metrics: ['cagr', 'sharpe', 'maxdd'], highlight: 'b1' } },
    { layout: 'chart', section: 1, title: '夏普', chart: { type: 'metric_bars', bts: ['b1', 'b2'], metric: 'sharpe', highlight: 'b1' } },
    { layout: 'table', section: 1, title: '月度', table: { kind: 'monthly', bt: 'b1' } },
    { layout: 'bullets', section: 2, title: '下一步', panels: [{ heading: '保留', bullets: ['模拟实盘'] }, { heading: '不做', bullets: ['不调参'] }], takeaway: '三个月后复盘' },
  ] };
const modelCalls = [];
async function fakeModel({ system, input, model }) {
  modelCalls.push({ role: system.split('\n')[0].match(/STRATEGIST|BUILDER|CRITIC|FIXER/)?.[0], model, input, system });
  if (system.includes('STRATEGIST')) return `好的，这是大纲：\n${JSON.stringify(OUTLINE)}`;
  if (system.includes('BUILDER')) return '```json\n' + JSON.stringify(SPEC) + '\n```';
  if (system.includes('CRITIC')) return JSON.stringify({ grade: 'yellow', verdict: '数字有一处没出处', slides: [], fixes: [{ title: '删掉编的数字', instruction: '第 1 页' }], factCheck: [], works: '结论先行' });
  if (system.includes('FIXER')) {
    const fixed = JSON.parse(JSON.stringify(SPEC));
    fixed.slides[0].columns[1].bullets[1] = '超额 {{b1.excess}}';
    return JSON.stringify({ spec: fixed, changes: ['删掉了没有出处的 33.3%'] });
  }
  throw new Error('unknown role');
}
try {
  const projectsDir = path.join(TMP, 'projects');
  await mkdir(path.join(projectsDir, '7'), { recursive: true });
  const updates = [];
  const svc = new DeckService({
    projectsDir, dataDir: path.join(TMP, 'deck'), python: PY, rendererDir: path.join(ROOT, 'engine', 'deck'), soffice: null,
    runModel: fakeModel, buildDataPack: async () => pack, onUpdate: (d) => updates.push(`${d.status}:${d.stage}`),
  });
  await svc.saveSettings({ firm: 'Test Capital', presenter: '研究部' });
  const d = await svc.create(7, { audience: 'client', lang: 'zh', quality: 'best', reviewOutline: true });
  await svc.active.get(d.deckId);
  const r1 = await svc.read(7, d.deckId);
  check('大纲做好后停下等确认', r1.status === 'awaiting' && r1.outline.slides.length === 2, r1.status + (r1.error || ''));
  check('大纲里的占位符先填好给人看', r1.outline.governingThoughtFilled === '验证期年化 6.9%，没有跑赢基准' && r1.outline.slides[0].pointsFilled[0] === '开发期 10.3%');
  check('质量「最好」用 opus', modelCalls[0].model === 'opus');
  check('给模型的数据不带序列（只有 facts 和摘要）', !modelCalls[0].input.includes('"series"') && modelCalls[0].input.includes('b1.cagr'));
  if (HAS_PPTX) {
    await svc.approve(7, d.deckId, '把验证期放前面');
    await svc.active.get(d.deckId);
    const r2 = await svc.read(7, d.deckId);
    check('确认后走完：完成', r2.status === 'done', `${r2.status} ${r2.error || ''}`);
    check('顺序：策划 → 写稿 → 评审 → 修改', modelCalls.map((c) => c.role).join(',') === 'STRATEGIST,BUILDER,CRITIC,FIXER', modelCalls.map((c) => c.role).join(','));
    check('确认时的意见交给写稿', modelCalls[1].system.includes('把验证期放前面') && modelCalls[1].input.includes('"outline"'));
    check('评审看到的是填好数字的版本和数字核对结果', modelCalls[2].input.includes('6.9%') && modelCalls[2].input.includes('33.3%'));
    check('修改后数字问题清零', (r2.issues || []).filter((x) => x.kind !== 'schema').length === 0, JSON.stringify(r2.issues));
    check('评审和修改记录存下来', r2.review.grade === 'yellow' && r2.review.changes[0].includes('33.3%'));
    const dir = svc.dir(7, d.deckId);
    const deck = JSON.parse(await readFile(path.join(dir, 'deck.json'), 'utf8'));
    check('最终稿里是真数字，没有占位符', !JSON.stringify(deck).includes('{{') && deck.slides[0].title.includes('6.9%'));
    check('没装 LibreOffice：只有 pptx，并提示', r2.files.pptx === 'deck.pptx' && !r2.files.pdf && r2.warnings.some((w) => /LibreOffice/.test(w)));
    check('状态推送经过每个阶段', ['running:build', 'running:review', 'running:fix', 'running:render', 'done:done'].every((s) => updates.includes(s)), updates.join(' '));
    // pptx 内容：页数 = 封面 + 目录 + 9 页 + 附录 + 免责声明；图表是原生图表
    const probe = spawnSync(PY, ['-I', '-c', `
import sys, json
from pptx import Presentation
p = Presentation(sys.argv[1])
charts = sum(1 for s in p.slides for sh in s.shapes if getattr(sh, 'has_chart', False) and sh.has_chart)
texts = ' '.join(sh.text_frame.text for s in p.slides for sh in s.shapes if sh.has_text_frame)
print(json.dumps({"n": len(p.slides), "charts": charts, "firm": "Test Capital" in texts, "disc": "不构成任何投资建议" in texts, "ph": "{{" in texts}))
`, path.join(dir, 'deck.pptx')], { encoding: 'utf8' });
    const info = JSON.parse(probe.stdout || '{}');
    check('pptx：封面 + 目录 + 9 页 + 附录 + 客户版免责声明 = 13 页', info.n === 13, probe.stdout + probe.stderr);
    check('pptx：图表是可编辑的原生图表', info.charts >= 6, String(info.charts));
    check('pptx：公司名、免责声明在，没有残留占位符', info.firm && info.disc && !info.ph);
    // 有 LibreOffice 时：转成 PDF，中英混排的句子里中文不能丢（headless 渲染后端会丢）
    const soffice = findSoffice();
    if (soffice) {
      const svcPdf = new DeckService({ projectsDir, dataDir: path.join(TMP, 'deck'), python: PY, rendererDir: path.join(ROOT, 'engine', 'deck'), runModel: fakeModel, buildDataPack: async () => pack });
      await svcPdf.rerender(7, d.deckId);
      await svcPdf.active.get(d.deckId);
      const r3 = await svcPdf.read(7, d.deckId);
      const txt = spawnSync(PY, ['-I', '-c', 'import sys, pypdfium2 as p; d = p.PdfDocument(sys.argv[1]); print(d[2].get_textpage().get_text_range())', path.join(dir, 'deck.pdf')], { encoding: 'utf8' }).stdout || '';
      check('PDF：生成了，并且有每页预览图', r3.files.pdf === 'deck.pdf' && r3.pages === 13 && existsSync(path.join(dir, 'pages', 'p13.png')), JSON.stringify(r3.files) + r3.pages);
      check('PDF：中英混排的标题里中文完整', txt.replace(/\s+/g, '').includes('验证期年化6.9%，没有跑赢基准'), txt.slice(0, 120));
    } else console.log('SKIP  PDF：没有 LibreOffice');
    // 重新排版：不调用模型
    const before = modelCalls.length;
    await svc.rerender(7, d.deckId);
    await svc.active.get(d.deckId);
    check('重新排版不调用模型', modelCalls.length === before && (await svc.read(7, d.deckId)).status === 'done');
  } else {
    console.log('SKIP  渲染部分：engine/.venv 里没有 python-pptx / pypdfium2');
  }
  // 重启后：「进行中」的任务没人跑了 → 中断
  const job = JSON.parse(await readFile(path.join(svc.dir(7, d.deckId), 'job.json'), 'utf8'));
  await writeFile(path.join(svc.dir(7, d.deckId), 'job.json'), JSON.stringify({ ...job, status: 'running', stage: 'build' }));
  const svc2 = new DeckService({ projectsDir, dataDir: path.join(TMP, 'deck'), python: PY, rendererDir: path.join(ROOT, 'engine', 'deck'), soffice: null, runModel: fakeModel, buildDataPack: async () => pack });
  const list = await svc2.list(7);
  check('服务重启后，进行中的任务显示为中断', list[0].status === 'error' && list[0].error === 'interrupted');
  let threw = false; try { svc2.dir(7, '../x'); } catch { threw = true; }
  check('汇报 id 不能带路径', threw);
} catch (e) { check('流水线没有异常', false, e.stack); }

/* ---------- 3) 模板分析 ---------- */
if (HAS_PPTX) {
  try {
    const mk = path.join(TMP, 'mk.py');
    await writeFile(mk, `
import sys
from pptx import Presentation
from pptx.util import Inches
p = Presentation()
if sys.argv[2] == 'wide':
    p.slide_width, p.slide_height = Inches(13.333), Inches(7.5)
p.save(sys.argv[1])
`);
    const run = (args) => spawnSync(PY, ['-I', ...args], { encoding: 'utf8' });
    run([mk, path.join(TMP, 'narrow.pptx'), 'narrow']);
    run([mk, path.join(TMP, 'wide.pptx'), 'wide']);
    const a = JSON.parse(run([path.join(ROOT, 'engine', 'deck', 'template.py'), path.join(TMP, 'wide.pptx'), path.join(TMP, 'tw')]).stdout.trim());
    const b = JSON.parse(run([path.join(ROOT, 'engine', 'deck', 'template.py'), path.join(TMP, 'narrow.pptx'), path.join(TMP, 'tn')]).stdout.trim());
    check('16:9 模板：当母版用，取 accent1 做高亮', a.ok && a.useMaster && a.palette.highlight === (a.themeColors.accent1 || '').toUpperCase() && existsSync(path.join(TMP, 'tw', 'template.pptx')), JSON.stringify(a.palette));
    check('4:3 模板：只取配色，提示不是 16:9', b.ok && !b.useMaster && b.note === 'not16x9' && !existsSync(path.join(TMP, 'tn', 'template.pptx')));
  } catch (e) { check('模板分析没有异常', false, e.stack); }
} else console.log('SKIP  模板分析：没有 python-pptx');

/* ---------- 4) 服务端接口 ---------- */
const PROJ = path.join(TMP, 'srv-projects');
await mkdir(PROJ, { recursive: true });
const PORT = await freePort();
const env = { ...process.env, PORT: String(PORT), HELM_PROJECTS_DIR: PROJ, HELM_TRIALS_FILE: path.join(TMP, 'trials.jsonl'), HELM_ALPACA_FILE: path.join(TMP, 's', 'a.json'),
  HELM_AI_FILE: path.join(TMP, 's', 'ai.json'), HELM_THREADS_DIR: path.join(TMP, 'threads'), HELM_MCP_CONFIG: path.join(TMP, 'mcp.json'), HELM_PAPER_DRIFT: '0',
  HELM_TRANSLATE: '0', HELM_DECK_DIR: path.join(TMP, 'srv-deck'), CLAUDE_BIN: '/nonexistent/claude' };
const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let slog = ''; server.stdout.on('data', (c) => { slog += c; }); server.stderr.on('data', (c) => { slog += c; });
const BASE = `http://127.0.0.1:${PORT}`;
try {
  await until(async () => { try { return (await fetch(BASE)).ok; } catch { return false; } }, 20000);
  const TOKEN = (await (await fetch(BASE)).text()).match(/name="helm-token" content="([a-f0-9]+)"/)[1];
  const H = { 'Content-Type': 'application/json', 'X-Helm-UI-Token': TOKEN, 'X-Helm-Lang': 'zh', Origin: BASE, 'Sec-Fetch-Site': 'same-origin' };
  const post = async (p, b) => { const r = await fetch(BASE + p, { method: 'POST', headers: H, body: JSON.stringify(b) }); return { status: r.status, ...(await r.json()) }; };
  const s1 = await post('/api/actions/deck-settings', { firm: 'Srv Capital', presenter: 'PM' });
  const s2 = await post('/api/decks/settings', {});
  check('设置保存后读得回来', s1.success && s2.settings.firm === 'Srv Capital' && s2.settings.logo === false);
  const list = await post('/api/decks/list', { projectId: 5 });
  check('没有汇报的项目：空列表', list.success && Array.isArray(list.decks) && list.decks.length === 0);
  const bad = await post('/api/decks/read', { projectId: 5, deckId: '../../etc' });
  check('坏 deckId：被拒', bad.status === 404 || bad.status === 400);
  const f404 = await fetch(`${BASE}/api/decks/file?projectId=5&deckId=abcdef-12&kind=pptx`);
  check('文件不存在：404', f404.status === 404);
  const evil = await fetch(`${BASE}/api/decks/file?projectId=5&deckId=..%2F..&kind=pptx`);
  check('文件下载的 id 校验', evil.status === 400);
  const noTok = await fetch(BASE + '/api/actions/deck-settings', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: '{}' });
  check('改设置要页面令牌', noTok.status === 403);
  const unsup = await post('/api/actions/deck-template', { name: 'x.docx', data: Buffer.from('hi').toString('base64') });
  check('不支持的模板格式：拒绝', unsup.success === false && unsup.errors[0] === 'unsupported');
  if (HAS_PPTX) {
    const up = await post('/api/actions/deck-template', { name: 'wide.pptx', data: (await readFile(path.join(TMP, 'wide.pptx'))).toString('base64') });
    const s3 = await post('/api/decks/settings', {});
    check('上传 pptx 模板：分析出配色并记住名字', up.success && up.template.useMaster && s3.settings.templateName === 'wide.pptx' && /^[0-9A-F]{6}$/.test(s3.settings.template.palette.highlight), JSON.stringify(up).slice(0, 300));
    const clr = await post('/api/actions/deck-settings', { clearTemplate: true });
    check('恢复内置模板', clr.success && clr.settings.template === null && !existsSync(path.join(TMP, 'srv-deck', 'template')));
  }
  const create = await post('/api/actions/deck-create', { projectId: 5, audience: 'team' });
  check('生成：立刻返回任务（在后台跑）', create.success && /^[0-9]{8}-[0-9]{6}-[a-f0-9]{4}$/.test(create.deck.deckId), JSON.stringify(create));
  const failedJob = await until(async () => { const r = await post('/api/decks/read', { projectId: 5, deckId: create.deck.deckId }); return r.deck && r.deck.status === 'error' ? r.deck : null; });
  check('项目不存在：任务出错并写明原因', failedJob && /不存在|not/.test(failedJob.error || ''), JSON.stringify(failedJob));
  const del = await post('/api/actions/deck-delete', { projectId: 5, deckId: create.deck.deckId });
  check('删除汇报', del.success && !existsSync(path.join(PROJ, '5', 'decks', create.deck.deckId)));
  const tooLong = await post('/api/actions/deck-create', { projectId: 5, notes: 'x'.repeat(3000) });
  check('请求校验：备注太长 400', tooLong.status === 400);
} catch (e) { check('server 没有异常', false, `${e.stack}\n${slog.slice(-2000)}`); }
server.kill();
await sleep(200);
await rm(TMP, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
