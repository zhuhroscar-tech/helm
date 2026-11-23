// UI 走查工具（给人和模拟用户用）：起一个临时 Helm（复制真实项目，不改原数据）+ 无头 Chrome，按步骤操作并截图。
// 用法：node test/ux/drive.mjs <steps.json> <输出目录> [--lang zh|en] [--width 1440] [--height 900]
// steps：[{ "go": "#/p/1002" }, { "click": "css 选择器" }, { "clickText": "按钮上的字" }, { "type": ["#input", "文字"] },
//         { "key": "Escape" }, { "back": true }, { "forward": true }, { "wait": 800 }, { "shot": "名字", "full": false }, { "text": true }]
// 每次 shot 存 PNG；text 输出当前页面可见文字（前 3000 字）、可点的按钮/链接列表；最后打印 JS 报错。
import { spawn } from 'node:child_process';
import { mkdtemp, cp, writeFile, chmod, rm, readFile, mkdir } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import net from 'node:net'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const steps = JSON.parse(await readFile(argv[0], 'utf8'));
const OUT = path.resolve(argv[1]); await mkdir(OUT, { recursive: true });
const LANG = opt('lang', 'zh'); const W = Number(opt('width', 1440)); const H = Number(opt('height', 900));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-ux-'));
await cp(path.join(ROOT, 'projects'), path.join(TMP, 'projects'), { recursive: true, filter: (s) => !s.includes('/.trash') && !/\/(runs|paper\/[^/]+\/runs)\//.test(s) });
const FAKE = path.join(TMP, 'fake-claude');
await writeFile(FAKE, `#!/usr/bin/env node
if (process.argv[2] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' })); process.exit(0); }
if (process.argv.includes('--version')) { console.log('2.1.311 (Claude Code)'); process.exit(0); }
console.log(JSON.stringify({ type: 'result', result: '[]' }));
`); await chmod(FAKE, 0o755);
const PORT = await freePort(); const CDP = await freePort();
const env = { ...process.env, PORT: String(PORT), HELM_PROJECTS_DIR: path.join(TMP, 'projects'), HELM_TRIALS_FILE: path.join(ROOT, 'data', 'trials.jsonl'), HELM_ALPACA_FILE: path.join(TMP, 's', 'a.json'),
  HELM_AI_FILE: path.join(TMP, 's', 'ai.json'), HELM_THREADS_DIR: path.join(TMP, 'threads'), HELM_MCP_CONFIG: path.join(TMP, 'mcp.json'), HELM_PAPER_DRIFT: '0', HELM_TRANSLATE: '0', HELM_DECK_DIR: path.join(TMP, 'deck'), CLAUDE_BIN: FAKE };
const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: 'ignore' });
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE)).ok) break; } catch {} await sleep(250); }
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${path.join(TMP, 'chrome')}`, '--no-first-run', `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
let wsUrl; for (let i = 0; i < 60 && !wsUrl; i++) { try { wsUrl = (await (await fetch(`http://127.0.0.1:${CDP}/json`)).json()).find((x) => x.type === 'page')?.webSocketDebuggerUrl; } catch {} await sleep(250); }
const ws = new WebSocket(wsUrl); await new Promise((r) => ws.addEventListener('open', r));
let seq = 0; const pend = new Map(); const errs = [];
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text); });
const cmd = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
await cmd('Runtime.enable'); await cmd('Page.enable');
await cmd('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 600 });
await cmd('Page.navigate', { url: BASE }); await sleep(1200);
await ev(`localStorage.setItem('helm.onboarded', 'true'); localStorage.setItem('helm.lang', ${JSON.stringify(LANG)});`);
await cmd('Page.navigate', { url: BASE }); await sleep(2500);
const visible = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const dlg = [...document.querySelectorAll('dialog[open]')].pop();
  const scope = dlg || document.getElementById('app') || document.body;
  const clickables = [...scope.querySelectorAll('a[href], button, [role=tab], tr[data-href], summary, input, select, textarea')].filter(vis).map((el) => {
    const t = (el.innerText || el.value || el.getAttribute('aria-label') || el.title || el.placeholder || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
    return \`[\${el.tagName.toLowerCase()}\${el.disabled ? ' disabled' : ''}] \${t}\`;
  }).filter((x, i, a) => a.indexOf(x) === i).slice(0, 120);
  return { url: location.hash, dialog: dlg ? (dlg.querySelector('h2')||{}).innerText || 'dialog' : null, text: scope.innerText.replace(/\\n{3,}/g, '\\n\\n').slice(0, 3000), clickables };
})()`;
const log = [];
for (const s of steps) {
  try {
    if (s.go) { await ev(`location.hash = ${JSON.stringify(s.go.replace(/^#/, ''))}`); await sleep(s.wait ?? 1800); }
    else if (s.click) { const r = await ev(`(() => { const b = document.querySelector(${JSON.stringify(s.click)}); if (!b) return 'not found'; b.scrollIntoView({block:'center'}); b.click(); return 'ok'; })()`); log.push(`click ${s.click}: ${r}`); await sleep(s.wait ?? 900); }
    else if (s.clickText) { const r = await ev(`(() => { const want = ${JSON.stringify(s.clickText)}; const vis = (el) => el.getBoundingClientRect().width > 0; const dlg = [...document.querySelectorAll('dialog[open]')].pop(); const all = [...(dlg || document).querySelectorAll('a, button, [role=tab], tr[data-href], summary, label')].filter(vis); const b = all.find((el) => (el.innerText || '').trim() === want) || all.find((el) => (el.innerText || '').includes(want)); if (!b) return 'not found'; b.scrollIntoView({block:'center'}); b.click(); return 'ok: ' + b.tagName; })()`); log.push(`clickText ${s.clickText}: ${r}`); await sleep(s.wait ?? 900); }
    else if (s.type) { await ev(`(() => { const el = document.querySelector(${JSON.stringify(s.type[0])}); el.focus(); el.value = ${JSON.stringify(s.type[1])}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`); }
    else if (s.key) { await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: s.key, code: s.key, windowsVirtualKeyCode: s.key === 'Escape' ? 27 : 0 }); await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: s.key, code: s.key }); await sleep(s.wait ?? 500); }
    else if (s.back) { await ev('history.back()'); await sleep(s.wait ?? 1500); log.push(`back → ${await ev('location.hash')} scrollTop=${await ev("document.getElementById('main').scrollTop")}`); }
    else if (s.forward) { await ev('history.forward()'); await sleep(s.wait ?? 1500); log.push(`forward → ${await ev('location.hash')} scrollTop=${await ev("document.getElementById('main').scrollTop")}`); }
    else if (s.eval) log.push(`eval: ${JSON.stringify(await ev(s.eval))}`);
    else if (s.wait) await sleep(s.wait);
    else if (s.scroll != null) { await ev(`document.getElementById('main').scrollTop = ${Number(s.scroll)}`); await sleep(400); }
    if (s.shot) {
      const name = s.shot;
      if (s.full) { const h = await ev(`Math.max(document.getElementById('main').scrollHeight + 80, ${H})`); await cmd('Emulation.setDeviceMetricsOverride', { width: W, height: Math.min(h, 5000), deviceScaleFactor: 1, mobile: W < 600 }); await sleep(700); }
      const r = await cmd('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64'));
      if (s.full) await cmd('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 600 });
      log.push(`shot ${path.join(OUT, name + '.png')}`);
    }
    if (s.text) { const v = await ev(visible); log.push(`--- page ${v.url}${v.dialog ? ` (dialog: ${v.dialog})` : ''}\n${v.text}\n--- clickable:\n${v.clickables.join('\n')}`); }
  } catch (e) { log.push(`step ${JSON.stringify(s)} failed: ${e.message}`); }
}
console.log(log.join('\n'));
console.log('JS errors:', errs.length ? errs.slice(0, 5) : 'none');
ws.close(); chrome.kill(); server.kill(); await sleep(300); await rm(TMP, { recursive: true, force: true }); process.exit(0);
