// 手机伴侣：node test/companion.test.mjs
// 1) 纯逻辑（lib/companion.mjs）：开关、配对码、令牌、限速、收件箱、摘要
// 2) 真实服务：默认不监听；打开后只有那几个接口；没有令牌读不到；主服务的接口从伴侣端口碰不到；手机发来的想法进收件箱
import { mkdtemp, rm, readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Companion, lanUrls, searchSummary, buildSummary, PAIR_TTL_MS, PAIR_MAX_WRONG, IDEA_MAX } from '../lib/companion.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); if (!cond) failed += 1; };
const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-comp-'));

try {
  /* ---------------- 纯逻辑 ---------------- */
  let clock = 1_800_000_000_000;
  const C = new Companion({ dir: path.join(TMP, 'a'), now: () => clock });
  await C.load();
  check('默认关闭、没有令牌', C.state.enabled === false && C.state.token === null);
  check('关着时不能配对', (await C.pair('123456')).error === 'disabled');
  check('关着时任何令牌都不认', C.authorized('Bearer abc') === false);
  await C.setEnabled(true);
  check('打开后还没生成配对码：不能配对', (await C.pair('123456')).error === 'no-code');
  const p1 = C.newPairCode();
  check('配对码是 6 位数字，10 分钟有效', /^\d{6}$/.test(p1.code) && p1.expiresAt === clock + PAIR_TTL_MS);
  const wrong = p1.code === '000000' ? '111111' : '000000';
  check('错的配对码被拒', (await C.pair(wrong)).error === 'wrong-code');
  const ok1 = await C.pair(p1.code);
  check('对的配对码换到 64 位令牌', /^[a-f0-9]{64}$/.test(ok1.token || ''), JSON.stringify(ok1).slice(0, 40));
  check('一个码只能用一次', (await C.pair(p1.code)).error === 'no-code');
  check('令牌：对的认、错的不认、格式不对的不认', C.authorized(`Bearer ${ok1.token}`) && !C.authorized(`Bearer ${'0'.repeat(64)}`) && !C.authorized(ok1.token) && !C.authorized('') && !C.authorized(undefined));
  const st = await stat(path.join(TMP, 'a', 'companion.json'));
  check('状态文件只有本人能读（0600）', (st.mode & 0o777) === 0o600, (st.mode & 0o777).toString(8));
  const p2 = C.newPairCode();
  for (let i = 0; i < PAIR_MAX_WRONG; i++) await C.pair(p2.code === '999999' ? '888888' : '999999');
  check(`连错 ${PAIR_MAX_WRONG} 次：配对码作废（对的也不行了）`, (await C.pair(p2.code)).error === 'no-code');
  const p3 = C.newPairCode(); clock += PAIR_TTL_MS + 1;
  check('过期的配对码不能用', (await C.pair(p3.code)).error === 'no-code');
  const p4 = C.newPairCode();
  check('第二台手机配对拿到同一个令牌（不把第一台踢掉）', (await C.pair(p4.code)).token === ok1.token);
  const C2 = new Companion({ dir: path.join(TMP, 'a') }); await C2.load();
  check('重启后：开关和令牌还在，配对码不在', C2.state.enabled && C2.authorized(`Bearer ${ok1.token}`) && (await C2.pair(p4.code)).error === 'no-code');
  await C.reset();
  check('断开所有手机：旧令牌失效', !C.authorized(`Bearer ${ok1.token}`) && C.state.token === null);
  await C.setEnabled(false);
  check('关闭后令牌不认', !C.authorized(`Bearer ${ok1.token}`));
  // 限速
  for (let i = 0; i < 19; i++) C.fail('1.2.3.4');
  check('错 19 次还没拦', !C.blocked('1.2.3.4'));
  C.fail('1.2.3.4');
  check('错 20 次：拦住这个地址，别的地址不受影响', C.blocked('1.2.3.4') && !C.blocked('5.6.7.8'));
  clock += 10 * 60 * 1000 + 1;
  check('10 分钟后放开', !C.blocked('1.2.3.4'));

  // 收件箱
  check('太短的想法不收', (await C.addIdea(' a ')).error === 'too-short');
  check('太长的想法不收', (await C.addIdea('x'.repeat(IDEA_MAX + 1))).error === 'too-long');
  const i1 = await C.addIdea('  信用利差走阔时少拿股票\r\n多拿国债\u0007  ');
  check('想法进收件箱：去掉首尾空白和控制字符，状态是 new', i1.idea && i1.idea.text === '信用利差走阔时少拿股票\n多拿国债' && i1.idea.status === 'new' && /^in/.test(i1.idea.id), JSON.stringify(i1));
  const i2 = await C.addIdea('第二个想法：小盘股反转');
  check('新的排在前面', (await C.inbox()).map((x) => x.id).join() === [i2.idea.id, i1.idea.id].join());
  check('处理一条：用了', (await C.actIdea(i1.idea.id, 'used')).idea.status === 'used' && (await C.inbox()).find((x) => x.id === i1.idea.id).status === 'used');
  check('处理：不认识的动作 / 不存在的条目被拒', (await C.actIdea(i2.idea.id, 'run')).error === 'bad-status' && (await C.actIdea('nope', 'used')).error === 'not-found');
  for (let i = 0; i < 49; i++) await C.addIdea(`填满收件箱 ${i} 号想法`);
  check('没处理的满 50 条：不再收（防止被灌）', (await C.addIdea('第 51 条想法')).error === 'inbox-full');

  // 地址
  const urls = lanUrls(4378, { hostname: 'Oscars-MacBook.local', ifaces: { lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }], en0: [{ family: 'IPv4', internal: false, address: '192.168.1.23' }, { family: 'IPv6', internal: false, address: 'fe80::1' }] } });
  check('地址：Bonjour 名和局域网 IPv4，不含回环和 IPv6', urls.join() === 'http://Oscars-MacBook.local:4378,http://192.168.1.23:4378', urls.join());

  // 摘要
  check('没跑过：search 是 null', searchSummary([]) === null && buildSummary({}).search === null);
  const per = (k, o) => ({ planIdea: k, projectId: 100 + k, tests: 0, devVersions: 0, devPassed: false, holdoutPassed: false, holdoutFailed: false, ...o });
  const rA = { runId: 'apa', status: 'done', createdAt: 1000, endedAt: 1000 + 25 * 60000, untilFound: true, nextRunId: 'apb', chain: { id: null, round: 1, usdTotal: 20, startedAt: 1000, spent: 0 }, cost: 3.85, tokens: { in: 1000, out: 500, cache: 9000 }, found: [], caps: { usd: 20 },
    plan: [{ title: '低应计' }, { title: '低资产增长' }], batches: [{ name: '财报质量' }], ledger: { ideas: 2, tests: 2, devVersions: 0, holdoutLooks: 0, per: [per(1, { tests: 1 }), per(2, { tests: 1 })] } };
  const rB = { runId: 'apb', status: 'running', createdAt: 1000 + 26 * 60000, endedAt: null, untilFound: true, chain: { id: 'apa', round: 2, usdTotal: 20, startedAt: 1000, spent: 3.85 }, cost: 1.15, tokens: { in: 200, out: 100, cache: 0 }, found: [], caps: { usd: 16 },
    plan: [{ title: '信用利差择时', kind: 'timing' }, { title: 'NFCI 择时', kind: 'timing' }], batches: [{ name: '宏观信用' }], ledger: { ideas: 1, tests: 0, devVersions: 1, holdoutLooks: 0, per: [per(1, { devVersions: 1 })] } };
  const old = { runId: 'apold', status: 'done', createdAt: 5, endedAt: 9, cost: 99, found: [{ projectId: 7 }], ledger: { ideas: 9 } };
  const s = searchSummary([rB, rA, old], { now: 1000 + 40 * 60000 });
  check('连续搜索：两轮合在一起算（不把更早的另一次搜索算进来）', s.state === 'running' && s.round === 2 && s.rounds === 2 && s.costUsd === 5 && s.capUsd === 20 && s.ideas === 3 && s.ideaTests === 2 && s.devVersions === 1 && s.found.length === 0, JSON.stringify({ c: s.costUsd, i: s.ideas, r: s.rounds }));
  check('token 按轮累加', s.tokens.in === 1200 && s.tokens.out === 600 && s.tokens.cache === 9000);
  check('跑了多久：从第一轮开始算', s.minutes === 40);
  check('这一轮的想法和结论', s.current.length === 2 && s.current[0].verdict === 'dev-fail' && s.current[1].verdict === 'pending' && s.directions[0] === '宏观信用');
  const done = searchSummary([{ ...rB, status: 'done', endedAt: 1000 + 50 * 60000, chainEnd: 'usd' }, rA], { now: 1000 + 60 * 60000 });
  check('用量用完没找到：nothing，带原因', done.state === 'nothing' && done.reason === 'usd' && done.minutes === 50);
  const gap = searchSummary([{ ...rA, nextRunId: null }], { now: 1000 + 26 * 60000 });
  check('两轮之间的一两秒仍算在跑', gap.state === 'running');
  const fnd = searchSummary([{ ...rB, status: 'done', endedAt: 2000, found: [{ projectId: 1030, backtestId: 'h' }] }, rA], { projectName: (id) => (id === 1030 ? 'NFCI 择时' : '') });
  check('找到了：found，带候选的项目名', fnd.state === 'found' && fnd.found[0].name === 'NFCI 择时' && fnd.found[0].projectId === 1030);
  check('出错 / 被停掉', searchSummary([{ ...rB, status: 'error', reason: 'session limit' }]).state === 'error' && searchSummary([{ ...rB, status: 'stopped', reason: 'user' }]).state === 'stopped');
  const single = searchSummary([{ runId: 'x', status: 'done', createdAt: 0, endedAt: 60000, cost: 1.946, found: [], caps: { usd: 20 }, ledger: { ideas: 3, tests: 2 } }]);
  check('不是连续模式的一轮也能看；没记 token 时是 null', single.state === 'nothing' && single.continuous === false && single.costUsd === 1.95 && single.tokens === null && single.capUsd === 20);
  const sum = buildSummary({ runs: [rB, rA], paper: [{ name: 'GEM', project: 'Dual momentum', mode: 'alpaca', days: 12, ret: -0.028, bench: -0.022, ok: true, secret: 'x' }], inbox: await C.inbox(), host: 'Mac.local', now: 5 });
  check('整个摘要：只有约定的字段（多余的字段不带出去）', sum.host === 'Mac' && sum.paper[0].ret === -0.028 && !('secret' in sum.paper[0]) && sum.inbox.new === 50 && Object.keys(sum).sort().join() === 'at,host,inbox,paper,search');

  /* ---------------- 真实服务 ---------------- */
  const freePort = () => new Promise((resolve) => { const s0 = net.createServer(); s0.listen(0, '127.0.0.1', () => { const p = s0.address().port; s0.close(() => resolve(p)); }); });
  const PORT = await freePort(); const CPORT = await freePort();
  const D = path.join(TMP, 'srv');
  await mkdir(path.join(D, 'projects'), { recursive: true });
  const env = { ...process.env, PORT: String(PORT), HELM_COMPANION_PORT: String(CPORT), HELM_COMPANION_HOST: '127.0.0.1', HELM_THREADS_DIR: path.join(D, 'data', 'threads'), HELM_PROJECTS_DIR: path.join(D, 'projects'), HELM_TRIALS_FILE: path.join(D, 'trials.jsonl'),
    HELM_MCP_CONFIG: path.join(D, 'mcp.json'), HELM_AI_FILE: path.join(D, 's', 'ai.json'), HELM_ALPACA_FILE: path.join(D, 's', 'alpaca.json'), HELM_TRANSLATIONS_FILE: path.join(D, 'tr.json'), HELM_PAPER_DRIFT: '0', HELM_TRANSLATE: '0', CLAUDE_BIN: path.join(D, 'no-such-claude'), HELM_LANG: 'zh' };
  await mkdir(path.join(D, 'data', 'autopilot'), { recursive: true });
  await writeFile(path.join(D, 'data', 'autopilot', 'apdemo1.json'), JSON.stringify({ runId: 'apdemo1', status: 'done', createdAt: Date.now() - 3600000, endedAt: Date.now() - 1800000, rootThreadId: 't', scope: 'any', universe: 'sp500', budget: { ideas: 6, versions: 2, directions: 3 }, caps: { usd: 20, minutes: 180 }, stopOnFind: true, plan: [{ title: '低应计', logic: 'l', batch: 1 }], batches: [{ name: '财报质量' }], projects: { 1017: 1 }, tests: { 1017: 1 }, backtests: {}, validations: {}, found: [], awaiting: [], decisions: [], refusals: [], cost: 3.85, tokens: { in: 12345, out: 678, cache: 90000 }, lang: 'zh' }));
  const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; server.stdout.on('data', (c) => { logs += c; }); server.stderr.on('data', (c) => { logs += c; });
  const main = `http://127.0.0.1:${PORT}`; const comp = `http://127.0.0.1:${CPORT}`;
  const req = async (base, method, p, { headers = {}, body } = {}) => { try { const r = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ } return { status: r.status, text, json, headers: r.headers }; } catch (e) { return { status: 0, text: String(e.cause ? e.cause.code : e.message), json: null }; } };
  try {
    for (let i = 0; i < 80; i++) { if ((await req(main, 'GET', '/api/health')).status) break; await new Promise((r) => setTimeout(r, 150)); }
    const page = await req(main, 'GET', '/');
    const TOKEN = (page.text.match(/<meta name="helm-token" content="([a-f0-9]{64})">/) || [])[1];
    const UI = { 'X-Helm-UI-Token': TOKEN, Origin: `http://127.0.0.1:${PORT}` };
    check('默认：伴侣端口没有在听', (await req(comp, 'GET', '/')).status === 0);
    const st0 = await req(main, 'GET', '/api/companion');
    check('主服务报告：关着、没配对、不给地址', st0.json && st0.json.enabled === false && st0.json.paired === false && st0.json.urls.length === 0, st0.text.slice(0, 120));
    check('没有页面令牌不能打开伴侣', (await req(main, 'POST', '/api/companion', { body: { action: 'enable' } })).status === 403);
    check('关着时不能生成配对码', (await req(main, 'POST', '/api/companion', { headers: UI, body: { action: 'pair' } })).status === 409);
    const on = await req(main, 'POST', '/api/companion', { headers: UI, body: { action: 'enable' } });
    check('打开：开始监听', on.json && on.json.enabled && on.json.listening && on.json.port === CPORT, on.text.slice(0, 160));
    const idx = await req(comp, 'GET', '/');
    check('伴侣首页能打开，带着严格的 CSP，不带主页面的令牌', idx.status === 200 && /Helm/.test(idx.text) && /default-src 'none'/.test(idx.headers.get('content-security-policy') || '') && !/helm-token/.test(idx.text) && !idx.text.includes(TOKEN));
    for (const f of ['/app.js', '/style.css', '/manifest.webmanifest', '/icon.svg']) check(`伴侣静态文件 ${f}`, (await req(comp, 'GET', f)).status === 200);
    for (const f of ['/styles.css', '/i18n-dict.js', '/../server.mjs', '/%2e%2e/server.mjs', '/companion/app.js', '/index.html/../../agents.json']) check(`伴侣端口拿不到别的文件 ${f}`, (await req(comp, 'GET', f)).status === 404);
    check('没有令牌：摘要 401', (await req(comp, 'GET', '/api/summary')).status === 401);
    check('没有令牌：不能写想法', (await req(comp, 'POST', '/api/ideas', { body: { text: '没有令牌的想法' } })).status === 401);
    for (const p of ['/api/chat', '/api/autopilot/start', '/api/companion', '/api/actions/backtest', '/api/data/files/read', '/api/threads', '/api/inbox']) {
      const r1 = await req(comp, 'POST', p, { body: {} }); const r2 = await req(comp, 'GET', p);
      check(`主服务的接口从伴侣端口碰不到 ${p}`, [401, 404].includes(r1.status) && [401, 404].includes(r2.status), `${r1.status}/${r2.status}`);
    }
    check('主页面的令牌在伴侣端口上没用', (await req(comp, 'GET', '/api/summary', { headers: { Authorization: `Bearer ${TOKEN}`, ...UI } })).status === 401);
    check('还没生成配对码：配对 403', (await req(comp, 'POST', '/api/pair', { body: { code: '123456' } })).status === 403);
    const pc = await req(main, 'POST', '/api/companion', { headers: UI, body: { action: 'pair' } });
    check('电脑上生成配对码', pc.json && /^\d{6}$/.test(pc.json.pair.code) && pc.json.pair.expiresAt > Date.now(), pc.text.slice(0, 160));
    check('GET 状态不带出配对码和令牌', !/"code"|"token"/.test((await req(main, 'GET', '/api/companion')).text));
    const paired = await req(comp, 'POST', '/api/pair', { body: { code: pc.json.pair.code } });
    const PT = paired.json && paired.json.token;
    check('手机配对：拿到令牌', paired.status === 200 && /^[a-f0-9]{64}$/.test(PT || ''));
    const A = { Authorization: `Bearer ${PT}` };
    const sm = await req(comp, 'GET', '/api/summary', { headers: A });
    check('有令牌：读到摘要（上一轮没找到、花了 $3.85、token 数）', sm.status === 200 && sm.json.search && sm.json.search.state === 'nothing' && sm.json.search.costUsd === 3.85 && sm.json.search.tokens.in === 12345 && sm.json.search.ideaTests === 1 && sm.json.search.current[0].title === '低应计' && sm.json.search.current[0].verdict === 'no-signal', sm.text.slice(0, 300));
    check('摘要里没有路径、对话、令牌', !sm.text.includes(D) && !/rootThreadId|token"|sessionId|\/Users\//.test(sm.text.replace(/"tokens"/g, '')));
    const sent = await req(comp, 'POST', '/api/ideas', { headers: A, body: { text: '手机上想到的：信用利差走阔时减仓' } });
    check('手机发想法：进收件箱', sent.status === 200 && sent.json.idea.status === 'new');
    check('太短的想法 400', (await req(comp, 'POST', '/api/ideas', { headers: A, body: { text: 'a' } })).status === 400);
    check('超大的请求体不收', [400, 413].includes((await req(comp, 'POST', '/api/ideas', { headers: A, body: { text: 'x'.repeat(40000) } })).status));
    const ib = await req(main, 'GET', '/api/inbox');
    check('电脑上看得到这条想法；它没有开任何对话（不会自己开工）', ib.json.ideas.length === 1 && ib.json.ideas[0].text === '手机上想到的：信用利差走阔时减仓' && ((await req(main, 'GET', '/api/threads')).json || []).length === 0);
    const used = await req(main, 'POST', '/api/inbox', { headers: UI, body: { id: ib.json.ideas[0].id, action: 'used' } });
    check('电脑上处理：标成用了；手机上看得到状态', used.status === 200 && (await req(comp, 'GET', '/api/ideas', { headers: A })).json.ideas[0].status === 'used');
    check('处理不存在的条目 404；没有页面令牌 403', (await req(main, 'POST', '/api/inbox', { headers: UI, body: { id: 'nope', action: 'used' } })).status === 404 && (await req(main, 'POST', '/api/inbox', { body: { id: 'x', action: 'used' } })).status === 403);
    await req(main, 'POST', '/api/companion', { headers: UI, body: { action: 'reset' } });
    check('断开所有手机：旧令牌 401', (await req(comp, 'GET', '/api/summary', { headers: A })).status === 401);
    let st429 = 0; for (let i = 0; i < 25; i++) st429 = (await req(comp, 'GET', '/api/summary', { headers: { Authorization: 'Bearer deadbeef' } })).status;
    check('一直用错的令牌试：被限速（429）', st429 === 429, String(st429));
    const off = await req(main, 'POST', '/api/companion', { headers: UI, body: { action: 'disable' } });
    check('关闭：不再监听', off.json && off.json.enabled === false && off.json.listening === false && (await req(comp, 'GET', '/')).status === 0);
    check('主服务仍然只在 127.0.0.1', /127\.0\.0\.1|localhost/.test(logs) && (await req(main, 'GET', '/api/health')).status === 200);
    check('不认识的 action 400', (await req(main, 'POST', '/api/companion', { headers: UI, body: { action: 'open-everything' } })).status === 400);
  } finally {
    server.kill('SIGTERM');
    await new Promise((r) => { if (server.exitCode !== null) r(); else { server.on('exit', r); setTimeout(r, 4000); } });
  }
} finally {
  await rm(TMP, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
