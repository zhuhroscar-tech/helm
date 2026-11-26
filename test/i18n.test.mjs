// 界面语言（中文 / English）测试：node test/i18n.test.mjs
// 1) 字典：zh / en 键完全一致、没有空值、占位符 {name} 一致；public/*.js 和 index.html 用到的键都在字典里
// 2) t()：插值、缺键回退、语言偏好（auto / zh / en）
// 3) 服务端：lang 校验、错误提示按 X-Helm-Lang 返回英文（否则中文）、健康检查带英文、agent 的启动参数里有没有「用 English 回复」
import { mkdtemp, rm, readFile, readdir, writeFile, chmod } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { localize, localizeData, langOf, langPrompt } from '../lib/i18n.mjs';
import { analyzeRobust, robustText } from '../lib/robust.mjs';
import { assessDrift } from '../lib/drift.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failed += 1;
};
const CJK = /[一-鿿]/;

/* ---------- 字典 ---------- */
const read = (f) => readFile(path.join(ROOT, 'public', f), 'utf8');
function loadI18n(win = {}) {
  const store = new Map();
  const ctx = {
    ...win,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    navigator: { language: win.navLang || 'en-US' },
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  return { ctx, store, run: async () => { vm.runInContext(await read('i18n-dict.js'), ctx); vm.runInContext(await read('i18n.js'), ctx); return ctx.HELM_I18N; } };
}
const base = loadI18n();
const I = await base.run();
const { zh, en } = I.dict;
const kz = Object.keys(zh).sort(); const ke = Object.keys(en).sort();
check('zh / en 字典键完全一致', JSON.stringify(kz) === JSON.stringify(ke), `zh=${kz.length} en=${ke.length} 只在zh=${kz.filter((k) => !(k in en)).slice(0, 3)} 只在en=${ke.filter((k) => !(k in zh)).slice(0, 3)}`);
check('字典不少于 1000 条', kz.length >= 1000, String(kz.length));
check('没有空值', kz.every((k) => String(zh[k]).trim() && String(en[k]).trim()), kz.filter((k) => !String(zh[k]).trim() || !String(en[k]).trim()).slice(0, 3).join(','));
const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
// 个别消息被拆成前后两段（中间夹着代码生成的内容），占位符分布在两段里，这里只核对整体是否一致
const badPh = kz.filter((k) => ph(zh[k]) !== ph(en[k]));
check('zh / en 的 {占位符} 一致（拆段的除外）', badPh.every((k) => ['k0812', 'k0813'].includes(k)), badPh.filter((k) => !['k0812', 'k0813'].includes(k)).slice(0, 5).join(','));
check('英文值里没有汉字', kz.filter((k) => CJK.test(en[k]) && !['x009', 'x008'].includes(k) && !/^ag_/.test(k)).length === 0, kz.filter((k) => CJK.test(en[k]) && !['x009', 'x008'].includes(k)).slice(0, 5).join(','));
check('中文值里有汉字（或是标记为语言无关的键）', kz.filter((k) => !/[一-鿿　-〿＀-￯]/.test(zh[k]) && !['x010'].includes(k)).length === 0, kz.filter((k) => !/[一-鿿　-〿＀-￯]/.test(zh[k])).slice(0, 5).join(','));

/* ---------- 代码里用到的键都在字典里（静态扫描） ---------- */
const files = (await readdir(path.join(ROOT, 'public'))).filter((f) => f.endsWith('.js') && !f.startsWith('i18n'));
const used = new Map();
for (const f of files) {
  const src = await read(f);
  for (const m of src.matchAll(/\b_t\('([A-Za-z0-9_]+)'/g)) used.set(m[1], f);
}
const html = await read('index.html');
for (const m of html.matchAll(/data-i18n="([^"]+)"/g)) used.set(m[1], 'index.html');
for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) for (const p of m[1].split(';')) used.set(p.split(':')[1], 'index.html');
const unknown = [...used.keys()].filter((k) => !(k in zh));
check(`public/*.js 和 index.html 用到的 ${used.size} 个键都在字典里`, unknown.length === 0, unknown.slice(0, 5).map((k) => `${k}@${used.get(k)}`).join(','));
const unusedDefault = kz.filter((k) => !used.has(k) && /^[khx]\d+$/.test(k));
check('字典里没有没人用的自动编号键', unusedDefault.length === 0, unusedDefault.slice(0, 5).join(','));
// 代码里除了字典、注释和语言无关的数据，不应再有汉字（见 docs/ARCHITECTURE.md 的 Language 一节）
const appSrc = await read('app.js');
const codeCjk = appSrc.split('\n').filter((l) => CJK.test(l) && !/^\s*(\/\/|\/\*|\*)/.test(l) && CJK.test(l.replace(/\s\/\/.*$/, '').replace(/\/\*.*?\*\//g, '')));
check('app.js 里剩下的汉字只在「服务器返回的中文数据」的匹配里', codeCjk.length <= 20, `${codeCjk.length} 行`);
check('index.html 里没有汉字', !CJK.test(html));

/* ---------- t() 与语言偏好 ---------- */
check('t(): {name} 插值', I.t('k0030', { name: 'main.py' }) !== 'k0030' && I.t('k0030', { name: 'main.py' }).includes('main.py'));
const t1 = I.t('k0010', { floor: 5 });
check('t(): 数字插值（英文）', t1 === '5 min ago', t1);
check('t(): vars 里没有的占位符原样保留', I.t('k0010', {}).includes('{floor}'));
check('t(): 缺键退回键名', I.t('no_such_key') === 'no_such_key');
// 英文单复数：「{n} project(s)」按前面最近的数字占位符定；没有数字时原样保留
check('t(): 英文单数（1 project）', I.t('hm_t1', { n: 1 }) === '1 project waiting on you', I.t('hm_t1', { n: 1 }));
check('t(): 英文复数（3 projects）', I.t('hm_t1', { n: 3 }) === '3 projects waiting on you', I.t('hm_t1', { n: 3 }));
check('t(): 英文 0 用复数', I.t('hm_gClosed', { n: 0 }).startsWith('0 ideas '), I.t('hm_gClosed', { n: 0 }));
check('t(): 一句里两个 (s) 各看各的数字', I.t('k0981', { v: 1, v2: 9 }) === '· 1 project · 9 idea-check jobs', I.t('k0981', { v: 1, v2: 9 }));
check('t(): 数字后面隔着标签也认（</b> trading day(s)）', I.t('k1091', { v: 1, v2: '', v3: '', rk: 5 }).includes('</b> trading day since freeze'), I.t('k1091', { v: 1, v2: '', v3: '', rk: 5 }));
check('t(): 没有数字可依据时保留 (s)', I.t('hm_t1', {}).includes('project(s)') && I.t('hm_t1', { n: 'many' }).includes('project(s)'));
check('auto + 浏览器语言 en-US → English', I.lang() === 'en' && I.locale() === 'en-US');
I.setPref('zh');
check('setPref(zh)：中文、zh-CN、写入 localStorage', I.lang() === 'zh' && I.locale() === 'zh-CN' && base.store.get('helm.lang') === 'zh' && I.t('k0010', { floor: 5 }) === '5 分钟前', I.t('k0010', { floor: 5 }));
I.setPref('auto');
check('setPref(auto)：清掉存储', !base.store.has('helm.lang'));
const zhb = loadI18n({ navLang: 'zh-TW' }); const IZ = await zhb.run();
check('auto + 浏览器语言 zh-TW → 中文', IZ.lang() === 'zh');
const saved = loadI18n({ navLang: 'zh-CN' }); saved.store.set('helm.lang', 'en'); const IS = await saved.run();
check('localStorage 里存的 en 优先于浏览器语言', IS.lang() === 'en');
const bad = loadI18n(); bad.ctx.localStorage.getItem = () => { throw new Error('blocked'); }; const IB = await bad.run();
check('localStorage 不可用时不报错，按 auto', IB.lang() === 'en');
// _regT：模块顶层的表在切换语言后重算
let tbl = null; I.regT(() => { tbl = I.t('k0010', { floor: 1 }); });
const before = tbl; I.setPref('zh'); const after = tbl; I.setPref('auto');
check('regT 登记的表随语言重算', before === '1 min ago' && after === '1 分钟前', `${before} / ${after}`);

/* ---------- 服务端消息表 ---------- */
check('localize: 精确匹配', localize('en', '消息为空') === 'The message is empty');
check('localize: 带参数', localize('en', '项目 12 不存在') === "Project 12 doesn't exist");
check('localize: 没有英文的原样返回中文', localize('en', '一句根本没登记的话') === '一句根本没登记的话');
check('localize: zh 不动', localize('zh', '消息为空') === '消息为空');
const d = localizeData('en', { success: false, errors: ['回测不存在', '没登记'], nested: { reason: '模拟不存在' } });
check('localizeData: errors[] 和嵌套的 reason', d.errors[0] === "The backtest doesn't exist" && d.errors[1] === '没登记' && d.nested.reason === "The simulation doesn't exist");
check('langOf: 请求体优先、非法值回中文', langOf({ headers: { 'x-helm-lang': 'en' } }) === 'en' && langOf({ headers: { 'x-helm-lang': 'en' } }, { lang: 'zh' }) === 'zh' && langOf({ headers: { 'x-helm-lang': 'fr' } }) === 'zh' && langOf({ headers: {} }) === 'zh');
check('langPrompt: zh 为空，en 要求英文回复', langPrompt('zh') === '' && /Reply to the user in English/.test(langPrompt('en')));

/* ---------- 起一个真实的服务 ---------- */
const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-i18n-'));
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
function req(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request(`${BASE}${p}`, { method, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { /* html */ } resolve({ status: res.statusCode, text, json, headers: res.headers }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const FAKE = path.join(TMP, 'fake-claude.mjs');
const ARGS_OUT = path.join(TMP, 'claude-args.json');
await writeFile(FAKE, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
const a = process.argv.slice(2);
if (a.includes('--version')) { console.log('0.0.0 (fake)'); process.exit(0); }
writeFileSync(process.env.FAKE_ARGS_OUT, JSON.stringify({ args: a, env: process.env }));
console.log(JSON.stringify({ type: 'result', session_id: 'fake', result: 'ok', total_cost_usd: 0 }));
`);
await chmod(FAKE, 0o755);
const env = {
  ...process.env, PORT: String(PORT), HELM_PROJECTS_DIR: path.join(TMP, 'projects'), HELM_TRIALS_FILE: path.join(TMP, 'trials.jsonl'),
  HELM_ALPACA_FILE: path.join(TMP, 'secrets', 'alpaca.json'), HELM_THREADS_DIR: path.join(TMP, 'threads'), HELM_MCP_CONFIG: path.join(TMP, 'mcp.json'),
  CLAUDE_BIN: FAKE, FAKE_ARGS_OUT: ARGS_OUT,
};
const REAL_MCP = path.join(ROOT, 'data', 'mcp.json');
const realMcpBefore = await readFile(REAL_MCP, 'utf8').catch(() => null);
const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (c) => { serverLog += c; });
server.stderr.on('data', (c) => { serverLog += c; });
const done = async () => {
  server.kill('SIGTERM');
  await rm(TMP, { recursive: true, force: true });
  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
};
try {
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { try { up = (await req('GET', '/api/agents')).status === 200; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  check('测试服务已启动', up, up ? `port=${PORT}` : serverLog.slice(-400));
  if (!up) await done();
  const page = await req('GET', '/');
  const TOKEN = (page.text.match(/<meta name="helm-token" content="([a-f0-9]{64})">/) || [])[1];
  const ORIGIN = BASE;
  const good = { 'X-Helm-UI-Token': TOKEN, Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin' };
  for (const f of ['i18n.js', 'i18n-dict.js']) { const r = await req('GET', `/${f}`); check(`服务器提供 /${f}`, r.status === 200 && /javascript/.test(r.headers['content-type'] || ''), `status=${r.status}`); }
  check('index.html 先加载字典和 i18n.js 再加载 app.js', /i18n-dict\.js[\s\S]*i18n\.js[\s\S]*app\.js/.test(page.text));

  // validateBody：lang 只能是 zh / en
  const mk = (lang, h = {}) => req('POST', '/api/chat', { headers: { ...good, ...h }, body: { message: '你好 hello', agent: 'mia', ...(lang === undefined ? {} : { lang }) } });
  for (const bad of ['fr', 'EN', 1, true, '']) {
    const r = await mk(bad);
    check(`lang=${JSON.stringify(bad)} 被拒绝（400）`, r.status === 400 && /lang/.test(r.json.error || ''), `status=${r.status} ${r.json && r.json.error}`);
  }
  const rEn = await mk('en');
  check('lang=en 被接受', rEn.status === 200 && Boolean(rEn.json.threadId), `status=${rEn.status}`);
  await new Promise((r) => setTimeout(r, 600));
  const aEn = JSON.parse(await readFile(ARGS_OUT, 'utf8')).args;
  const sysEn = aEn[aEn.indexOf('--append-system-prompt') + 1];
  check('lang=en：启动 claude 的系统提示里有「用 English 回复」', /Reply to the user in English/.test(sysEn));
  const rZh = await mk('zh');
  check('lang=zh 被接受', rZh.status === 200, `status=${rZh.status}`);
  await new Promise((r) => setTimeout(r, 600));
  const aZh = JSON.parse(await readFile(ARGS_OUT, 'utf8')).args;
  const sysZh = aZh[aZh.indexOf('--append-system-prompt') + 1];
  check('lang=zh：系统提示里没有英文回复指令（行为不变）', !/Reply to the user in English/.test(sysZh) && /团队/.test(sysZh));
  const rNone = await mk(undefined);
  check('不带 lang 也能发（默认中文）', rNone.status === 200);
  await new Promise((r) => setTimeout(r, 600));
  const aNone = JSON.parse(await readFile(ARGS_OUT, 'utf8')).args;
  check('不带 lang：提示里没有英文回复指令', !/Reply to the user in English/.test(aNone[aNone.indexOf('--append-system-prompt') + 1]));
  const rHdr = await mk(undefined, { 'X-Helm-Lang': 'en' });
  await new Promise((r) => setTimeout(r, 600));
  const aHdr = JSON.parse(await readFile(ARGS_OUT, 'utf8')).args;
  check('请求头 X-Helm-Lang: en 同样生效', rHdr.status === 200 && /Reply to the user in English/.test(aHdr[aHdr.indexOf('--append-system-prompt') + 1]));

  // 错误提示：X-Helm-Lang: en → 英文；没有 → 中文
  const eEn = await req('POST', '/api/actions/compile', { headers: { ...good, 'X-Helm-Lang': 'en' }, body: {} });
  const eZh = await req('POST', '/api/actions/compile', { headers: good, body: {} });
  check('缺字段：X-Helm-Lang: en → 英文', eEn.status === 400 && eEn.json.error === 'Missing required field projectId', eEn.json && eEn.json.error);
  check('缺字段：不带语言头 → 中文', eZh.status === 400 && eZh.json.error === '缺少必填字段 projectId', eZh.json && eZh.json.error);
  const tokEn = await req('POST', '/api/actions/compile', { headers: { Origin: ORIGIN, 'X-Helm-Lang': 'en' }, body: { projectId: 1 } });
  check('令牌错误：英文提示里有 "UI token"（网页据此提示刷新）', tokEn.status === 403 && /UI token/.test(tokEn.json.error), tokEn.json && tokEn.json.error);
  const biz = await req('POST', '/api/data/backtests/read', { headers: { ...good, 'X-Helm-Lang': 'en' }, body: { projectId: 999999, backtestId: 'abcdef12' } });
  check('业务错误 errors[]：不存在的项目 → 英文', biz.json && Array.isArray(biz.json.errors) && /doesn't exist|not found/i.test(biz.json.errors.join(' ')) && !CJK.test(biz.json.errors.join(' ')), JSON.stringify(biz.json));
  const bizZh = await req('POST', '/api/data/backtests/read', { headers: good, body: { projectId: 999999, backtestId: 'abcdef12' } });
  check('同一个业务错误不带语言头 → 中文', bizZh.json && CJK.test((bizZh.json.errors || []).join(' ')), JSON.stringify(bizZh.json));

  // 健康检查
  const hEn = await req('GET', '/api/health', { headers: { 'X-Helm-Lang': 'en' } });
  const comps = (hEn.json && hEn.json.components) || [];
  check('健康检查：每一项都有英文名', comps.length >= 6 && comps.every((c) => typeof c.en === 'string' && c.en && !CJK.test(c.en)), JSON.stringify(comps.map((c) => c.en)));
  check('健康检查：没就绪的项带英文的补救办法 hintEn', comps.filter((c) => !c.ok).every((c) => typeof c.hintEn === 'string' && c.hintEn && !CJK.test(c.hintEn)) && comps.every((c) => typeof c.zh === 'string' && CJK.test(c.zh)));
  const hOpt = comps.find((c) => c.id === 'priceData');
  check('健康检查：detail 随语言头翻译', !hOpt || !CJK.test(hOpt.detail || ''), hOpt && hOpt.detail);

  /* ---------- 服务端生成的文字（robust / journal / drift / 统计提醒 / 敏感性结论）随语言走 ---------- */
  {
    const N = 1600; const t0 = Date.UTC(2005, 0, 3) / 1000; const ts = [];
    for (let t = t0; ts.length < N; t += 86400) { const dw = new Date(t * 1000).getUTCDay(); if (dw !== 0 && dw !== 6) ts.push(t); }
    const res = { statistics: {}, charts: {
      'Strategy Equity': { series: { Equity: { values: ts.map((t, i) => [t + 21 * 3600, 100000 * (1 + 0.0003 * i + 0.01 * Math.sin(i / 9))]) } } },
      Benchmark: { series: { Benchmark: { values: ts.map((t, i) => [t + 21 * 3600, 100 + 10 * Math.sin(i / 17) + i * 0.02 + (i % 7) * 0.3]) } } },
    } };
    const ev = [{ status: 'filled', fillQuantity: 10, fillPrice: 100, time: ts[300] + 21 * 3600 }];
    const zh = analyzeRobust(res, ev, { period: 'dev' });
    const en = analyzeRobust(res, ev, { period: 'dev', lang: 'en' });
    const strs = (o, out = []) => { if (typeof o === 'string') out.push(o); else if (o && typeof o === 'object') for (const v of Object.values(o)) strs(v, out); return out; };
    check('稳健性：中文输出不变（段标签 / 状态标签 / 结论仍是中文）', zh.segments.thirds[0].label === '第 1 段' && zh.regimes.cells[0].label === '上升趋势 · 低波动' && CJK.test(zh.summary.text) && /没有基准|前 \d+ 个交易日基准历史不够长/.test(zh.notes.join('')));
    check('稳健性：英文结论 / 状态标签 / 备注 / 规则没有汉字', !strs(en).some((x) => CJK.test(x)), strs(en).filter((x) => CJK.test(x)).slice(0, 2).join(' | '));
    check('稳健性：英文标签是 uptrend / downtrend + volatility', /^Uptrend · low volatility$/.test(en.regimes.cells[0].label) && /^Downtrend · high volatility$/.test(en.regimes.cells[3].label) && en.segments.thirds[0].label === 'Part 1');
    check('稳健性：英文和中文的数字一致（只换文字）', en.regimes.cells.every((c, i) => c.days === zh.regimes.cells[i].days && c.annReturn === zh.regimes.cells[i].annReturn) && en.summary.years === zh.summary.years);
    const hoEn = analyzeRobust(res, ev, { period: 'holdout', lang: 'en' });
    check('稳健性：验证期 / 太短的英文结论没有汉字', !CJK.test(hoEn.summary.text) && !CJK.test(hoEn.summary.reason || ''), hoEn.summary.text);
    check('稳健性：空曲线的英文提示没有汉字', !strs(analyzeRobust({}, null, { lang: 'en' })).some((x) => CJK.test(x)));
    check('robustText：en 没有汉字，zh 仍是中文', !CJK.test(robustText(en, 'en')) && /^结论：/.test(robustText(zh)) && robustText(zh) === robustText(zh, 'zh'), robustText(en, 'en').split('\n').filter((l) => CJK.test(l))[0]);

    const btR = Array.from({ length: 300 }, (_, i) => 0.0004 + 0.01 * Math.sin(i));
    const dz = assessDrift({ btReturns: btR, fwd: { n: 5, r: 0.01, dd: 0.02, bench: null, excess: null, from: 'a', to: 'b' } });
    const de = assessDrift({ btReturns: btR, fwd: { n: 5, r: 0.01, dd: 0.02, bench: null, excess: null, from: 'a', to: 'b' }, lang: 'en' });
    check('漂移：中文判定不变', dz.verdictText === '太早，还看不出来' && dz.verdict === 'early');
    check('漂移：英文判定和备注没有汉字，判定码不变', de.verdict === 'early' && /^Too early/.test(de.verdictText) && !strs(de).some((x) => CJK.test(x)));
    for (const [r, v] of [[-0.6, 'low'], [0.6, 'high'], [0.0, 'in']]) {
      const d = assessDrift({ btReturns: btR, fwd: { n: 40, r, dd: 0.5, bench: null, excess: null, from: 'a', to: 'b' }, lang: 'en' });
      check(`漂移：英文 ${v}（备注含回撤超过提示时也没有汉字）`, !strs(d).some((x) => CJK.test(x)) && /range/.test(d.verdictText));
    }
    check('漂移：不可用时的英文说明没有汉字', !CJK.test(assessDrift({ btReturns: btR, fwd: null, lang: 'en' }).note) && !CJK.test(assessDrift({ btReturns: [0.01], fwd: { n: 5 }, lang: 'en' }).note));

    // 想法记录：journal 产出的阶段 / 结论 / 关键数字标签 / 说明，经 localizeData 翻成英文
    const jr = { summary: { byStage: { 想法检验: 0, 开发期回测: 1, 统计检验: 0, 验证期: 0, 模拟实盘: 0 } }, entries: [
      { stage: '开发期回测', outcome: '候选', detail: '你选定的主版本 · 验证期第 2 次 · variant_a.py', what: '方案 A', projectName: '项目 #7', key: { label: '夏普', value: 0.37 } },
      { stage: '统计检验', outcome: '主版本', detail: '没过统计检验（2 项没达标）', key: { label: '夏普', value: 1 } },
      { stage: '想法检验', outcome: '没有信号', detail: '3 个因子 · 最好：momentum · 5 日', key: { label: 'IC t 值', value: 2.1 } },
      { stage: '验证期', outcome: '没跑完', detail: '用过验证期' },
      { stage: '模拟实盘', outcome: '进行中', detail: '进行中 · 冻结 2026-01-02', what: 'sim1（来自 回测）' },
      { stage: '开发期回测', outcome: '已删除', detail: '回测文件已删除，只剩尝试记录', what: '已删除的回测 abc123' },
    ] };
    const jen = localizeData('en', structuredClone(jr));
    const jstr = strs(jen).filter((x) => x !== '方案 A' && x !== 'variant_a.py');
    check('想法记录：英文阶段 / 结论 / 标签 / 说明没有汉字（用户数据除外）', !jstr.some((x) => CJK.test(x)), jstr.filter((x) => CJK.test(x)).join(' | '));
    check('想法记录：英文内容正确（byStage 键、key 标签、拼接说明）', jen.summary.byStage['Dev-period backtest'] === 1 && jen.entries[0].outcome === 'Candidate' && jen.entries[0].key.label === 'Sharpe' && jen.entries[0].detail === 'Main version you picked · Holdout look #2 · variant_a.py' && jen.entries[2].key.label === 'IC t-stat' && jen.entries[2].detail === '3 factors · best: momentum · 5-day' && jen.entries[0].projectName === 'Project #7');
    check('想法记录：中文原样不变', JSON.stringify(localizeData('zh', structuredClone(jr))) === JSON.stringify(jr));

    // 统计检验提醒 + 敏感性结论
    check('统计提醒：样本内警告英文、无汉字', !CJK.test(localize('en', '这是开发期（样本内）结果：参数是在这段数据上挑的，通过检验也不代表样本外有效，还要在验证期验证一次。')) && /in-sample/.test(localize('en', '这是开发期（样本内）结果：参数是在这段数据上挑的，通过检验也不代表样本外有效，还要在验证期验证一次。')));
    const { sensitivityConclusion, SENS_WARNING } = await import('../lib/robust.mjs');
    const concl = [
      sensitivityConclusion([{ name: 'a', verdict: '稳' }, { name: 'b', verdict: '稳' }, { name: 'c', verdict: null }]),
      sensitivityConclusion([{ name: 'fast', verdict: '敏感' }, { name: 'slow', verdict: '方向翻转' }]),
      sensitivityConclusion([{ name: 'x', verdict: null }]),
    ];
    check('敏感性：结论 / 警告英文无汉字（参数名除外），中文不变', concl.every((c) => CJK.test(c) && !CJK.test(localize('en', c))) && !CJK.test(localize('en', SENS_WARNING)) && localize('zh', concl[0]) === concl[0], concl.map((c) => localize('en', c)).join(' / '));
  }
} catch (e) {
  check('测试本身没有抛异常', false, e.stack || String(e));
} finally {
  const realMcpAfter = await readFile(REAL_MCP, 'utf8').catch(() => null);
  check('真实的 data/mcp.json 没被测试改写', realMcpBefore === realMcpAfter);
  await done();
}
