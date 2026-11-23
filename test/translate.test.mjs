// 内容翻译（用户 / agent 写的项目说明、回测名、对话……按界面语言显示）：node test/translate.test.mjs
// 1) lib/translate.mjs：哪些要翻、分批、失败拆单条、退避、缓存落盘、translateData 只动显示字段
// 2) 真的 server.mjs + 假 claude（「翻译」= 加前缀）：英文界面第一次拿到原文，后台翻完推 translations_updated，再取就是译文；
//    中文界面不动中文；Markdown 规则说明翻了但保留原文；对话里工具调用的参数 / 结果不翻
import { mkdtemp, rm, readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Translator, translateData, needsTranslation, parseArray } from '../lib/translate.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-tr-'));
let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); if (!cond) failed += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(50); } return null; };
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

/* ---------- 1) lib ---------- */
try {
  check('要不要翻：英文界面只翻含中文的', needsTranslation('低波动', 'en') && !needsTranslation('Low vol', 'en') && !needsTranslation('', 'en'));
  check('要不要翻：中文界面只翻像句子的英文（代号、文件名、网址、单词不翻）', needsTranslation('Buy the lowest volatility stocks', 'zh')
    && !needsTranslation('SPY', 'zh') && !needsTranslation('main.py', 'zh') && !needsTranslation('lowvol_252_monthly_rebalance', 'zh')
    && !needsTranslation('https://example.com/a b c', 'zh') && !needsTranslation('含中文 with some English words', 'zh'));
  check('解析：容忍代码块和前后废话', JSON.stringify(parseArray('Sure:\n```json\n["a","b"]\n```')) === '["a","b"]');

  const calls = [];
  const file = path.join(TMP, 'lib', 'tr.json');
  let mode = 'ok';
  const t = new Translator({ file, delayMs: 10, runBatch: async (texts, target) => {
    calls.push({ n: texts.length, target });
    if (mode === 'down') throw new Error('not logged in');
    if (mode === 'badOne' && texts.some((x) => x.includes('坏'))) {
      if (texts.length > 1) return ['only one'];
      throw new Error('bad');
    }
    return texts.map((x) => `EN(${x})`);
  } });
  let updates = 0; t.onUpdate = () => { updates += 1; };
  check('第一次查：没有译文，返回 null 并排队', t.lookup('你好', 'en') === null && t.pending() === 1);
  t.lookup('世界', 'en'); t.lookup('你好', 'en');
  await until(() => t.pending() === 0);
  check('同一批翻：两段文字一次调用（重复的只翻一次）', calls.length === 1 && calls[0].n === 2, JSON.stringify(calls));
  check('翻完：再查直接返回译文，并通知更新', t.tr('你好', 'en') === 'EN(你好)' && updates === 1);

  mode = 'badOne'; calls.length = 0;
  t.lookup('好的一', 'en'); t.lookup('坏的二', 'en'); t.lookup('好的三', 'en');
  await until(() => t.pending() === 0);
  check('整批结果长度不对 → 拆成单条重试，好的照样翻出来', t.tr('好的一', 'en') === 'EN(好的一)' && t.tr('好的三', 'en') === 'EN(好的三)' && t.tr('坏的二', 'en') === '坏的二', JSON.stringify(calls));
  const before = calls.length; t.lookup('坏的二', 'en'); await sleep(60);
  check('单条失败：10 分钟内不再重试', calls.length === before);

  mode = 'down'; calls.length = 0;
  for (let i = 0; i < 4; i++) { t.lookup(`第${i}段`, 'en'); await until(() => t.pending() === 0, 2000); }
  t.lookup('第九段', 'en'); await sleep(200);
  check('连续失败（比如没登录）：暂停一阵，不再一条一条地狂试', calls.length === 3 && t.pausedUntil > Date.now(), `calls=${calls.length}`);

  await sleep(1300);
  const disk = JSON.parse(await readFile(file, 'utf8'));
  check('缓存写到文件；新建的 Translator 读得回来', Object.keys(disk.entries).length === 4 && new Translator({ file, runBatch: async () => [] }).tr('你好', 'en') === 'EN(你好)');

  const fake = { tr: (s) => `T(${s})` };
  const d = translateData(fake, 'en', { projectId: 1, name: '项目', files: [{ name: 'spec.md', content: '# 规则' }, { name: 'main.py', content: '# 代码' }],
    messages: [{ text: '回答', parts: [{ type: 'tool', input: { name: '原样' }, result: '原样' }] }], reasons_zh: ['甲', '乙'], options: [{ label: '选项' }] });
  check('translateData：显示字段翻，id 不动', d.name === 'T(项目)' && d.projectId === 1 && d.messages[0].text === 'T(回答)' && d.reasons_zh.join() === 'T(甲),T(乙)');
  check('translateData：.md 内容翻并保留原文，.py 不动', d.files[0].content === 'T(# 规则)' && d.files[0].contentOriginal === '# 规则' && d.files[1].content === '# 代码' && !('contentOriginal' in d.files[1]));
  check('translateData：工具参数 / 结果、问答选项不翻', d.messages[0].parts[0].input.name === '原样' && d.messages[0].parts[0].result === '原样' && d.options[0].label === '选项');
} catch (e) { check('lib 没有异常', false, e.stack); }

/* ---------- 2) server ---------- */
const FAKE = path.join(TMP, 'fake-claude');
const CALLS = path.join(TMP, 'calls.log');
await writeFile(FAKE, `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
if (a[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
if (a.includes('--version')) { console.log('9.9.9'); process.exit(0); }
let input = ''; process.stdin.on('data', (c) => { input += c; }).on('end', () => {
  fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ args: a, input }) + '\\n');
  const sp = a[a.indexOf('--system-prompt') + 1] || '';
  const to = /into English/.test(sp) ? 'EN' : 'ZH';
  const out = JSON.parse(input).map((s) => to + ':' + s);
  console.log(JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify(out) }));
});
`);
await chmod(FAKE, 0o755);
// 假 claude 用的是 CommonJS 的 require：放进一个没有 package.json type=module 的目录里
const PROJ = path.join(TMP, 'projects');
await mkdir(path.join(PROJ, '1001'), { recursive: true });
await writeFile(path.join(PROJ, '1001', 'project.json'), JSON.stringify({ projectId: 1001, name: '低波动策略', description: 'Buy the fifty least volatile stocks each month', created: '2026-01-01T00:00:00Z', modified: '2026-01-01T00:00:00Z' }));
await writeFile(path.join(PROJ, '1001', 'main.py'), '# 代码注释不翻\n');
await writeFile(path.join(PROJ, '1001', 'spec.md'), '# 规则说明\n每月调仓\n');

const PORT = await freePort();
const env = { ...process.env, PORT: String(PORT), HELM_PROJECTS_DIR: PROJ, HELM_TRIALS_FILE: path.join(TMP, 'trials.jsonl'), HELM_ALPACA_FILE: path.join(TMP, 's', 'a.json'),
  HELM_AI_FILE: path.join(TMP, 's', 'ai.json'), HELM_THREADS_DIR: path.join(TMP, 'threads'), HELM_MCP_CONFIG: path.join(TMP, 'mcp.json'), HELM_PAPER_DRIFT: '0',
  HELM_TRANSLATIONS_FILE: path.join(TMP, 'srv-tr.json'), CLAUDE_BIN: FAKE };
delete env.HELM_TRANSLATE;
const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let slog = ''; server.stdout.on('data', (c) => { slog += c; }); server.stderr.on('data', (c) => { slog += c; });
const BASE = `http://127.0.0.1:${PORT}`;
try {
  await until(async () => { try { return (await fetch(BASE)).ok; } catch { return false; } }, 20000);
  const TOKEN = (await (await fetch(BASE)).text()).match(/name="helm-token" content="([a-f0-9]+)"/)[1];
  const H = (lang) => ({ 'Content-Type': 'application/json', 'X-Helm-UI-Token': TOKEN, 'X-Helm-Lang': lang, Origin: BASE, 'Sec-Fetch-Site': 'same-origin' });
  const post = async (p, b, lang) => (await fetch(BASE + p, { method: 'POST', headers: H(lang), body: JSON.stringify(b) })).json();

  // 订阅事件：等 translations_updated
  const ctrl = new AbortController(); let events = '';
  fetch(`${BASE}/api/events`, { headers: H('en'), signal: ctrl.signal }).then(async (r) => { for await (const c of r.body) events += Buffer.from(c).toString(); }).catch(() => {});

  const p1 = (await post('/api/data/projects/read', {}, 'en')).projects[0];
  check('英文界面第一次：先给原文（不等翻译）', p1.name === '低波动策略', p1.name);
  check('后台翻完推 translations_updated', Boolean(await until(() => events.includes('translations_updated'))));
  const p2 = (await post('/api/data/projects/read', {}, 'en')).projects[0];
  check('再取：名字是英文译文，英文说明不动', p2.name === 'EN:低波动策略' && p2.description === 'Buy the fifty least volatile stocks each month', JSON.stringify(p2));
  const z1 = (await post('/api/data/projects/read', {}, 'zh')).projects[0];
  await until(async () => (await post('/api/data/projects/read', {}, 'zh')).projects[0].description.startsWith('ZH:'));
  const z2 = (await post('/api/data/projects/read', {}, 'zh')).projects[0];
  check('中文界面：中文名不动，英文说明翻成中文', z1.name === '低波动策略' && z2.name === '低波动策略' && z2.description === 'ZH:Buy the fifty least volatile stocks each month', JSON.stringify(z2));

  await post('/api/data/files/read', { projectId: 1001 }, 'en');
  await until(async () => (await post('/api/data/files/read', { projectId: 1001 }, 'en')).files.find((f) => f.name === 'spec.md').content.startsWith('EN:'));
  const files = (await post('/api/data/files/read', { projectId: 1001 }, 'en')).files;
  const spec = files.find((f) => f.name === 'spec.md'); const py = files.find((f) => f.name === 'main.py');
  check('规则说明 spec.md 翻译，原文放 contentOriginal（复制 / 下载用）；代码不翻', spec.content.startsWith('EN:') && spec.contentOriginal === '# 规则说明\n每月调仓\n' && py.content === '# 代码注释不翻\n');

  const disk = await readFile(path.join(ROOT, 'projects', '..', 'package.json'), 'utf8').catch(() => '');
  const pj = JSON.parse(await readFile(path.join(PROJ, '1001', 'project.json'), 'utf8'));
  check('原始数据文件不被改动', pj.name === '低波动策略' && Boolean(disk));
  const calls = (await readFile(CALLS, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const a0 = calls[0].args;
  check('翻译调用：不带工具、不带 MCP、不留会话、默认 haiku', a0.includes('--tools') && a0[a0.indexOf('--tools') + 1] === '' && a0.includes('--strict-mcp-config') && a0.includes('--no-session-persistence') && a0[a0.indexOf('--model') + 1] === 'haiku');
  const health = await (await fetch(`${BASE}/api/agents`, { headers: H('en') })).json();
  check('agents 接口不翻（名字由界面字典管）', Array.isArray(health));
  ctrl.abort();
} catch (e) { check('server 没有异常', false, `${e.stack}\n${slog.slice(-2000)}`); }
server.kill();
await sleep(200);
await rm(TMP, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
