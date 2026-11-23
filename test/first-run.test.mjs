// 第一次安装 / 第一次使用时的问题：node test/first-run.test.mjs（不跑 LEAN，全程临时目录）
//   密钥默认位置、安装提示、策略沙盒缺失时拒绝、用户改代码接口、数据更新提示、英文模板、claude 不存在时的体检
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-firstrun-'));
process.env.HELM_PROJECTS_DIR = path.join(TMP, 'projects');
process.env.HELM_TRIALS_FILE = path.join(TMP, 'trials.jsonl');
process.env.HELM_ALPACA_FILE = path.join(TMP, 'secrets', 'alpaca.json');
process.env.HELM_LEAN_DATA = path.join(TMP, 'lean-data');

const C = await import('../lib/config.mjs');
const H = await import('../lib/setup-hints.mjs');
const E = await import('../lib/engine.mjs');

let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failed += 1;
};
const CJK = /[一-龥]/;

/* ---- 1. 密钥默认位置 ---- */
{
  const root = path.join(TMP, 'repo'); const home = path.join(TMP, 'home');
  const o = { root, home, platform: 'darwin', env: {} };
  check('密钥：新装默认放在 ~/Library/Application Support/Helm/secrets', C.secretFile('ai.json', 'HELM_AI_FILE', o) === path.join(home, 'Library', 'Application Support', 'Helm', 'secrets', 'ai.json'));
  await mkdir(path.join(root, 'data', 'secrets'), { recursive: true });
  await writeFile(path.join(root, 'data', 'secrets', 'alpaca.json'), '{}');
  check('密钥：仓库里已有旧文件就继续用（不迁移）', C.secretFile('alpaca.json', 'HELM_ALPACA_FILE', o) === path.join(root, 'data', 'secrets', 'alpaca.json'));
  check('密钥：环境变量优先', C.secretFile('alpaca.json', 'HELM_ALPACA_FILE', { ...o, env: { HELM_ALPACA_FILE: '/x/a.json' } }) === '/x/a.json');
  check('密钥：其它系统用 XDG 目录', C.secretFile('ai.json', null, { root, home, platform: 'linux', env: { XDG_CONFIG_HOME: '/cfg' } }) === '/cfg/helm/secrets/ai.json');
  const X = await import('../lib/exec-sandbox.mjs');
  check('密钥：新位置也在沙盒的禁止读写名单里', X.secretPaths().dirs.includes(C.userSecretsDir()) && E.secretDirs().includes(C.userSecretsDir()));
}

/* ---- 2. 安装提示 ---- */
{
  const req = path.join(ROOT, 'engine', 'requirements.txt');
  if (existsSync(req)) {
    const want = readFileSync(req, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
    check('提示：pip 包清单来自 engine/requirements.txt', JSON.stringify(H.pipPackages()) === JSON.stringify(want), H.pipPackages().join(' '));
  }
  const a = H.setupHints({ venvExists: false }); const b = H.setupHints({ venvExists: true });
  check('提示：没有 engine/.venv 时 libpython 只说先装 Python 环境，不提删除 / 改名', /scripts\/setup\.sh/.test(a.libpython.en) && !/rename|delete/i.test(a.libpython.en) && !/删|改名/.test(a.libpython.zh));
  check('提示：有 engine/.venv 时才提重建', /rename/i.test(b.libpython.en));
  check('提示：dotnet / lean / python 首选 scripts/setup.sh，原始命令放 cmd', ['dotnet', 'lean', 'python'].every((k) => /scripts\/setup\.sh/.test(a[k].en) && /scripts\/setup\.sh/.test(a[k].zh) && a[k].cmd && !a[k].en.includes(a[k].cmd)));
  check('提示：claude 推荐官方安装脚本、提到 EACCES 和重启 Helm', /claude\.ai\/install\.sh/.test(a.claude.en) && /EACCES/.test(a.claude.en) && /restart Helm/.test(a.claude.en) && /重启 Helm/.test(a.claude.zh));
  check('提示：setupCommand 带引号的安装目录', H.setupCommand('/a b/helm') === 'cd "/a b/helm" && scripts/setup.sh');
}

/* ---- 3. 策略沙盒不可用：拒绝运行，除非 HELM_EXEC_SANDBOX=off ---- */
{
  const plat = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux' });
  const prev = process.env.HELM_EXEC_SANDBOX;
  try {
    delete process.env.HELM_EXEC_SANDBOX;
    let threw = null; try { E.sandboxed('/bin/echo', ['x'], null); } catch (e) { threw = e.message; }
    check('沙盒：没有 sandbox-exec 时拒绝运行策略（不再悄悄裸跑）', threw && /HELM_EXEC_SANDBOX=off/.test(threw), threw);
    check('沙盒：状态 ok=false', E.leanSandboxState().ok === false);
    process.env.HELM_EXEC_SANDBOX = 'off';
    const r = E.sandboxed('/bin/echo', ['x'], null);
    check('沙盒：HELM_EXEC_SANDBOX=off 时按用户要求不套沙盒', r[0] === '/bin/echo' && E.leanSandboxState().ok === true && E.leanSandboxState().available === false);
  } finally {
    Object.defineProperty(process, 'platform', plat);
    if (prev === undefined) delete process.env.HELM_EXEC_SANDBOX; else process.env.HELM_EXEC_SANDBOX = prev;
  }
  if (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) check('沙盒：本机（macOS）照常套沙盒', E.sandboxed('/bin/echo', ['x'], null)[0] === '/usr/bin/sandbox-exec');
}

/* ---- 4. 英文模板 ---- */
check('模板：英文界面建的均线模板没有中文', !CJK.test(E.templateCode('sma', 'en')) && !CJK.test(E.templateCode('rotation', 'en')) && CJK.test(E.templateCode('sma', 'zh')));
check('模板：不存在的模板返回 undefined', E.templateCode('nope', 'en') === undefined && E.templateCode('__proto__', 'en') === undefined);

/* ---- 5. 用户改代码 ---- */
const p = await E.createProject({ name: 'First run' });
const pid = p.projects[0].projectId;
{
  const before = JSON.parse(await readFile(path.join(process.env.HELM_PROJECTS_DIR, String(pid), 'project.json'), 'utf8')).modified;
  await new Promise((r) => setTimeout(r, 15));
  const code = (await E.filesRead({ projectId: pid, name: 'main.py' })).files[0].content.replace('set_cash(100000)', 'set_cash(50000)');
  const u = await E.updateProjectFileByUser({ projectId: pid, name: 'main.py', content: code });
  const after = JSON.parse(await readFile(path.join(process.env.HELM_PROJECTS_DIR, String(pid), 'project.json'), 'utf8')).modified;
  check('改代码：已有的 main.py 可以改，写入并编译', u.success && (await E.filesRead({ projectId: pid, name: 'main.py' })).files[0].content === code && u.compile && u.compile.state, JSON.stringify(u).slice(0, 200));
  check('改代码：更新项目修改时间', after !== before, `${before} → ${after}`);
  for (const [name, why] of [['../x.py', '路径'], ['new.py', '新文件'], ['spec.md', '非 .py'], ['a/b.py', '子目录']]) {
    const r = await E.updateProjectFileByUser({ projectId: pid, name, content: 'x' });
    check(`改代码：拒绝${why}（${name}）`, !r.success, JSON.stringify(r.errors));
  }
  const big = await E.updateProjectFileByUser({ projectId: pid, name: 'main.py', content: 'x'.repeat(E.USER_FILE_MAX + 1) });
  check('改代码：超过大小上限拒绝', !big.success && /KB/.test(big.errors[0]));
  check('改代码：不存在的项目拒绝', !(await E.updateProjectFileByUser({ projectId: 99999, name: 'main.py', content: 'x' })).success);
}

/* ---- 6. 回测之后数据更新过：backtests/read 给 dataChanged ---- */
{
  const zipOne = (name, text) => { // 最小的 zip（一个 deflate 文件）
    const data = zlib.deflateRawSync(Buffer.from(text)); const nm = Buffer.from(name);
    const crc = zlib.crc32 ? zlib.crc32(Buffer.from(text)) : 0;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(text.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(text.length, 24); ch.writeUInt16LE(nm.length, 28);
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + nm.length, 12); end.writeUInt32LE(30 + nm.length + data.length, 16);
    return Buffer.concat([lh, nm, data, ch, nm, end]);
  };
  const daily = path.join(process.env.HELM_LEAN_DATA, 'equity', 'usa', 'daily');
  await mkdir(daily, { recursive: true });
  await writeFile(path.join(daily, 'spy.zip'), zipOne('spy.csv', '20200102 00:00,3000000,3010000,2990000,3005000,100\n'));
  const bid = 'abcdef0123456789abcdef0123456789';
  const dir = path.join(process.env.HELM_PROJECTS_DIR, String(pid), 'backtests', bid);
  await mkdir(path.join(dir, 'code'), { recursive: true });
  const code = (await E.filesRead({ projectId: pid, name: 'main.py' })).files[0].content;
  await writeFile(path.join(dir, 'code', 'main.py'), code);
  const fp = await E.backtestDataFingerprint(code);
  await writeFile(path.join(dir, 'meta.json'), JSON.stringify({ backtestId: bid, projectId: pid, name: 'x', status: 'Completed.', created: new Date().toISOString(), role: 'debug', period: 'dev', file: 'main.py', fingerprint: { version: 1, code: null, data: fp } }));
  const r1 = await E.backtestsRead({ projectId: pid, backtestId: bid });
  check('数据：没更新时 dataChanged = false', r1.success && r1.backtest.dataChanged === false, JSON.stringify(r1.backtest && r1.backtest.dataChanged));
  await new Promise((r) => setTimeout(r, 20));
  await writeFile(path.join(daily, 'spy.zip'), zipOne('spy.csv', '20200102 00:00,3000000,3010000,2990000,3006000,100\n20200103 00:00,3000000,3010000,2990000,3005000,100\n'));
  const r2 = await E.backtestsRead({ projectId: pid, backtestId: bid });
  check('数据：数据更新后 dataChanged = true，并列出变了的代码', r2.success && r2.backtest.dataChanged === true && r2.backtest.dataChangedTickers.includes('SPY') && r2.backtest.dataChangedNote, JSON.stringify({ c: r2.backtest && r2.backtest.dataChanged, t: r2.backtest && r2.backtest.dataChangedTickers }));
}

/* ---- 7. 服务：claude 不存在时体检不能说 AI 连接正常；改代码接口要令牌 ---- */
{
  const PORT = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
  const BASE = `http://127.0.0.1:${PORT}`;
  const req = (method, p2, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request(`${BASE}${p2}`, { method, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers } }, (res) => {
      const ch = []; res.on('data', (c) => ch.push(c));
      res.on('end', () => { const text = Buffer.concat(ch).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { /* html */ } resolve({ status: res.statusCode, text, json }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  const env = { ...process.env, PORT: String(PORT), HELM_THREADS_DIR: path.join(TMP, 'threads'), HELM_MCP_CONFIG: path.join(TMP, 'mcp.json'), HELM_AI_FILE: path.join(TMP, 's', 'ai.json'),
    HELM_TRANSLATIONS_FILE: path.join(TMP, 'tr.json'), HELM_PAPER_DRIFT: '0', HELM_TRANSLATE: '0', CLAUDE_BIN: path.join(TMP, 'no-such-claude'), LANG: 'en_US.UTF-8', HELM_LANG: '' };
  const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; server.stdout.on('data', (c) => { log += c; }); server.stderr.on('data', (c) => { log += c; });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { try { await req('GET', '/api/health'); up = true; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  try {
    const h = (await req('GET', '/api/health?refresh=1', { headers: { 'X-Helm-Lang': 'en' } })).json;
    const c = (id) => h.components.find((x) => x.id === id);
    check('体检：claude 不存在 → claude 项不通过，说明是没装（不是 spawn ENOENT）', !c('claude').ok && /not found/.test(c('claude').detail) && !/ENOENT/.test(c('claude').detail), c('claude').detail);
    check('体检：claude 不存在 → AI 连接也不通过（不再显示「连接正常 / 版本较旧」）', !c('ai').ok && h.missing.includes('ai') && !/older/i.test(c('ai').detail), JSON.stringify(c('ai')));
    check('体检：claude 提示是官方安装脚本 + 重启 Helm', /claude\.ai\/install\.sh/.test(c('claude').hintEn) && /restart Helm/.test(c('claude').hintEn));
    check('体检：带 installDir 和 setupCommand', h.installDir === ROOT && h.setupCommand.endsWith('scripts/setup.sh'));
    check('体检：有策略沙盒一项', Boolean(c('sandbox')) && Array.isArray(h.warnings));
    await new Promise((r) => setTimeout(r, 500));
    check('启动日志：系统语言是英文时用英文，指向 scripts/setup.sh 之类的安装说明', /Helm is running/.test(log) && !/已启动/.test(log) && !/ENOENT/.test(log), log.slice(0, 300));
    const page = await req('GET', '/');
    const TOKEN = (page.text.match(/<meta name="helm-token" content="([a-f0-9]{64})">/) || [])[1];
    const body = { projectId: pid, name: 'main.py', content: 'print(1)\n' };
    const no = await req('POST', '/api/data/files/update', { headers: { Origin: `http://localhost:${PORT}` }, body });
    check('改代码接口：没有页面令牌 403', no.status === 403);
    const good = { 'X-Helm-UI-Token': TOKEN, Origin: `http://127.0.0.1:${PORT}`, 'Sec-Fetch-Site': 'same-origin' };
    const yes = await req('POST', '/api/data/files/update', { headers: { ...good, Host: `127.0.0.1:${PORT}` }, body });
    check('改代码接口：有令牌时写入成功', yes.json && yes.json.success === true, yes.text.slice(0, 200));
    const bad = await req('POST', '/api/data/files/update', { headers: { ...good, 'X-Helm-Lang': 'en' }, body: { ...body, name: '../../server.py' } });
    check('改代码接口：路径穿越被拒绝（英文说明）', bad.json && bad.json.success === false && !CJK.test(bad.json.errors.join('')), bad.text.slice(0, 200));
  } finally { server.kill('SIGTERM'); }
}

await rm(TMP, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
