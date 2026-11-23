// 项目改名：node test/project-rename.test.mjs
// 起一个自己的 server.mjs（临时目录、随机端口），走 POST /api/actions/project-rename：
// 改名成功并写进当前语言的名字；空名 / 只有空白 / 超长被拒；没有页面令牌被拒；回测和尝试次数（trials.jsonl）不受影响；
// 网页（⋯ 菜单、右键菜单、Mac 菜单桥）和 Mac App 菜单都接上了，中英文案齐全。
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-rename-'));
let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); if (!cond) failed += 1; };

const PORT = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const BASE = `http://127.0.0.1:${PORT}`;
function req(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request(`${BASE}${p}`, { method, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { /* html */ } resolve({ status: res.statusCode, text, json }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const PROJECTS = path.join(TMP, 'projects');
const TRIALS = path.join(TMP, 'trials.jsonl');
const env = {
  ...process.env, PORT: String(PORT), HELM_PROJECTS_DIR: PROJECTS, HELM_TRIALS_FILE: TRIALS,
  HELM_ALPACA_FILE: path.join(TMP, 'secrets', 'alpaca.json'), HELM_THREADS_DIR: path.join(TMP, 'threads'), HELM_MCP_CONFIG: path.join(TMP, 'mcp.json'),
  CLAUDE_BIN: path.join(TMP, 'no-claude'),
};
const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', (c) => { log += c; });
server.stderr.on('data', (c) => { log += c; });

try {
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { try { up = (await req('GET', '/api/agents')).status === 200; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  check('测试服务已启动', up, up ? '' : log.slice(-400));
  if (!up) throw new Error('server did not start');
  const TOKEN = ((await req('GET', '/')).text.match(/<meta name="helm-token" content="([a-f0-9]{64})">/) || [])[1];
  const good = { 'X-Helm-UI-Token': TOKEN, Origin: BASE, 'Sec-Fetch-Site': 'same-origin' };
  const rename = (body, headers = good) => req('POST', '/api/actions/project-rename', { headers, body });

  const created = await req('POST', '/api/actions/project', { headers: good, body: { name: '旧名字', nameEn: 'Old name', nameZh: '旧名字', template: 'buyhold' } });
  const projectId = created.json.projects[0].projectId;
  const pj = path.join(PROJECTS, String(projectId), 'project.json');

  // 一个已完成的回测 + 一条尝试记录：改名前后都应该原样不动
  const bdir = path.join(PROJECTS, String(projectId), 'backtests', 'ab0001');
  await mkdir(bdir, { recursive: true });
  await writeFile(path.join(bdir, 'meta.json'), JSON.stringify({ backtestId: 'ab0001', projectId, name: 'v1', status: 'Completed.', created: '2026-01-01T00:00:00Z', role: 'main', summary: { sharpeRatio: 0.4 } }));
  const trialLine = `${JSON.stringify({ backtestId: 'ab0001', projectId, period: 'dev', window: ['2005-01-01', '2019-12-31'], sharpe: 0.4, at: '2026-01-01T00:00:00Z' })}\n`;
  await writeFile(TRIALS, trialLine);
  const btBefore = (await req('POST', '/api/data/backtests/list', { headers: good, body: { projectId } })).json;
  const before = JSON.parse(await readFile(pj, 'utf8'));

  /* ---- 改名成功 ---- */
  const r = await rename({ projectId, name: '  新名字   GEM  ', lang: 'zh' });
  const p = r.json && r.json.projects && r.json.projects[0];
  check('改名成功：200 + success', r.status === 200 && r.json.success === true, JSON.stringify(r.json));
  check('改名：空白被压缩、首尾去掉，写进 name 和 nameZh', p && p.name === '新名字 GEM' && p.nameZh === '新名字 GEM', JSON.stringify(p));
  // 另一种语言的旧名字清掉：否则切到英文界面还显示 Old name，像是没改成（英文界面这时显示 name，也就是新名字）
  check('改名（中文界面）：旧的英文名清掉，英文界面也显示新名字', p && !p.nameEn);
  const disk = JSON.parse(await readFile(pj, 'utf8'));
  check('改名：写进 project.json，编号、创建时间、说明不变', disk.name === '新名字 GEM' && disk.projectId === before.projectId && disk.created === before.created && disk.description === before.description);
  const en = (await rename({ projectId, name: 'Dual momentum', lang: 'en' })).json.projects[0];
  check('英文界面改名：写进 nameEn，旧的中文名清掉', en.nameEn === 'Dual momentum' && !en.nameZh && en.name === 'Dual momentum');
  const listed = (await req('POST', '/api/data/projects/read', { headers: good, body: {} })).json.projects.find((x) => x.projectId === projectId);
  check('项目列表拿到新名字', listed && listed.nameEn === 'Dual momentum' && !listed.nameZh && listed.name === 'Dual momentum');

  /* ---- 被拒绝 ---- */
  for (const [label, name] of [['空名', ''], ['只有空白', '   \t '], ['超过 120 字', 'x'.repeat(121)], ['不是字符串', 123]]) {
    const x = await rename({ projectId, name });
    check(`${label} → 被拒`, x.status === 400 || (x.json && x.json.success === false), `status=${x.status} ${JSON.stringify(x.json)}`);
  }
  const ws = await rename({ projectId, name: 'y'.repeat(120) });
  check('正好 120 字：可以', ws.json && ws.json.success === true && ws.json.projects[0].name.length === 120);
  const missing = await rename({ projectId: 999999, name: 'nope' });
  check('不存在的项目 → 失败', missing.json && missing.json.success === false);
  const noTok = await rename({ projectId, name: 'hack' }, { Origin: BASE });
  check('没有页面令牌 → 403', noTok.status === 403);
  const cross = await rename({ projectId, name: 'hack' }, { ...good, 'Sec-Fetch-Site': 'cross-site' });
  check('跨站请求 → 403', cross.status === 403);
  check('被拒的请求没有改到名字', JSON.parse(await readFile(pj, 'utf8')).name === 'y'.repeat(120));

  /* ---- 回测、尝试次数不受影响 ---- */
  const btAfter = (await req('POST', '/api/data/backtests/list', { headers: good, body: { projectId } })).json;
  check('回测列表不变', JSON.stringify(btAfter.backtests) === JSON.stringify(btBefore.backtests) && btAfter.count === 1, `${JSON.stringify(btBefore)} → ${JSON.stringify(btAfter)}`);
  check('尝试记录 trials.jsonl 不变', (await readFile(TRIALS, 'utf8')) === trialLine);

  /* ---- 网页、Mac App、文案都接上了 ---- */
  const app = await readFile(path.join(ROOT, 'public', 'app.js'), 'utf8');
  check('项目页 ⋯ 菜单有「重命名…」', /moreMenu\('projMore'[\s\S]{0,600}data-action="project-rename"/.test(app));
  check('侧栏 / 首页右键菜单有「重命名…」', /function projCtx[\s\S]{0,1800}doAction\('project-rename'/.test(app));
  check('Mac 菜单桥：MENU_CMDS 和 menuSync 都有 project-rename', /'project-rename': \(\) =>/.test(app) && /rename: has\('\[data-action="project-rename"\]'\)/.test(app));
  check('改名广播会刷新页面', /ev\.type === 'project_renamed'/.test(app));
  const swift = await readFile(path.join(ROOT, 'macos', 'Sources', 'Helm', 'AppDelegate.swift'), 'utf8');
  check('Mac App「项目」菜单有「重命名…」，按 rename 状态变灰', /web\(L\("重命名…", "Rename…"\), "project-rename"\)/.test(swift) && /"project-rename": "rename"/.test(swift));
  globalThis.window = {};
  await import(path.join(ROOT, 'public', 'i18n-dict.js'));
  const D = globalThis.window.HELM_DICT;
  const keys = ['pr_rename', 'pr_title', 'pr_save', 'pr_empty', 'pr_done'];
  check('中英文案都有', keys.every((k) => D.zh[k] && D.en[k] && D.zh[k] !== D.en[k]));
} catch (e) {
  failed += 1;
  console.log('FAIL  异常', e && e.stack);
} finally {
  server.kill('SIGTERM');
  await rm(TMP, { recursive: true, force: true });
  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
}
