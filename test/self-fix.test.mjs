// agent 自己改代码：改动规则、快照 / 测试 / 自动恢复、审批流程。node test/self-fix.test.mjs
// 服务部分在临时目录起一个真的 server.mjs，HELM_CHANGE_ROOT 指到临时的「仓库」，不会改到真实文件；
// 假的 claude 照 Claude Code 的做法先调审批（POST /api/approval），批准了才写文件。
import { mkdtemp, rm, readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide, classifyCommand, integrityTouched, topLevelBlocks, applyEdit, simpleDiff } from '../lib/change-policy.mjs';
import { ChangeStore, testPlan, needsRestart } from '../lib/changes.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-selffix-'));
let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); if (!cond) failed += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(50); } return null; };

/* ---------------- 规则（纯函数） ---------------- */
const REPO = path.join(TMP, 'repo');
const put = async (rel, text) => { await mkdir(path.dirname(path.join(REPO, rel)), { recursive: true }); await writeFile(path.join(REPO, rel), text); };
const idea = `MAX_FACTORS = 5\nALPHA = 0.05\nT_FLOOR = 2.0\n\n\ndef t_threshold(m, alpha=ALPHA):\n    return max(T_FLOOR, m)\n\n\nFIELDS = {"close"}\n\n\ndef market_return(c):\n    return c\n`;
await put('engine/qlib_research/qs_idea.py', idea);
await put('lib/stats.mjs', 'export const X = 1;\n');
await put('server.mjs', '// server\n');
await put('lib/qlib.mjs', 'const A = 1;\nexport function checkExpr(e) {\n  return null;\n}\n');
await put('data/trials.jsonl', '{"backtestId":"x"}\n');
await put('engine/qlib_research/qs_data.py', 'X = 1\n');
await put('test/lint.test.mjs', '// t\n');
await put('lib/change-policy.mjs', '// p\n');
await put('mcp/qc-mcp.mjs', '// m\n');
const rt = (f) => { try { return require_(f); } catch { return null; } };
import { readFileSync } from 'node:fs';
function require_(f) { return readFileSync(f, 'utf8'); }
const eng = { id: 'engineer', name: '策略工程师' };
const mia = { id: 'mia', name: '总控', orchestrator: true };
// 默认按「两种沙盒都可用」测规则（Mac 上的正常情况）；NS = 沙盒不可用
const SB = { agent: true, research: true };
const D = (toolName, input, agent = eng, sandbox = SB) => decide({ agent, toolName, input, root: REPO, cwd: path.join(REPO, 'workspace'), readText: rt, sandbox });
const NS = (toolName, input) => D(toolName, input, eng, {});
const P = (rel) => path.join(REPO, rel);

check('切块：Python 顶层函数和常量', Object.keys(topLevelBlocks(idea, 'x.py')).join(',') === 'MAX_FACTORS,ALPHA,T_FLOOR,t_threshold,FIELDS,market_return');
check('切块：JS', Object.keys(topLevelBlocks('const A = 1;\nexport async function f() {\n}\nexport const B = 2;\n', 'x.mjs')).join(',') === 'A,f,B');
check('研究规则：改 FIELDS / market_return 不算', integrityTouched('engine/qlib_research/qs_idea.py', idea, idea.replace('{"close"}', '{"close", "mkt"}')).length === 0);
check('研究规则：改 T_FLOOR 算', integrityTouched('engine/qlib_research/qs_idea.py', idea, idea.replace('T_FLOOR = 2.0', 'T_FLOOR = 1.0')).join() === 'T_FLOOR');
check('研究规则：删掉 t_threshold 也算', integrityTouched('engine/qlib_research/qs_idea.py', idea, idea.replace(/def t_threshold[\s\S]*?m\)\n/, '')).includes('t_threshold'));
check('applyEdit：找不到 old_string 返回 null', applyEdit('Edit', { old_string: 'nope', new_string: 'x' }, 'abc') === null);
check('simpleDiff：只给改动的地方', simpleDiff('a\nb\nc\n', 'a\nB\nc\n').text.includes('- b') && simpleDiff('a\nb\nc\n', 'a\nB\nc\n').added === 1);

let d = D('Edit', { file_path: P('engine/qlib_research/qs_idea.py'), old_string: 'FIELDS = {"close"}', new_string: 'FIELDS = {"close", "mkt"}' });
check('engine/ 里加字段：直接放行', d.action === 'allow', d.title);
d = D('Edit', { file_path: P('engine/qlib_research/qs_idea.py'), old_string: 'T_FLOOR = 2.0', new_string: 'T_FLOOR = 1.5' });
check('engine/ 里降低 t 门槛：要批准（研究规则）', d.action === 'ask' && d.category === 'integrity' && /T_FLOOR/.test(d.title) && d.diff.text.includes('+ T_FLOOR = 1.5'));
check('lib/stats.mjs 任何改动都要批准', D('Write', { file_path: P('lib/stats.mjs'), content: 'export const X = 2;\n' }).category === 'integrity');
check('新建 mcp/ 里的文件：要批准（平台代码，不在沙盒里运行）', D('Write', { file_path: P('mcp/extra.mjs'), content: 'x' }).action === 'ask');
check('改 lib/ 任何文件：要批准', D('Edit', { file_path: P('lib/qlib.mjs'), old_string: 'const A = 1;', new_string: 'const A = 2;' }).action === 'ask');
check('改审批工具 mcp/qc-mcp.mjs：要批准', D('Edit', { file_path: P('mcp/qc-mcp.mjs'), old_string: '// m', new_string: '// x' }).action === 'ask');
check('大小写换个写法也认得：lib/Change-Policy.mjs、LIB/STATS.mjs 要批准', D('Edit', { file_path: P('lib/Change-Policy.mjs'), old_string: '// p', new_string: '// x' }).action === 'ask' && D('Write', { file_path: P('LIB/STATS.mjs'), content: 'x' }).category === 'integrity');
check('大小写换个写法也认得：Data/secrets、.GIT 不行', D('Write', { file_path: P('Data/secrets/alpaca.json'), content: '{}' }).action === 'deny' && D('Write', { file_path: P('.GIT/config'), content: 'x' }).action === 'deny');
check('helm_data.py / lint_strategy.py：要批准（防偷看未来的检查）', D('Write', { file_path: P('engine/helm_data.py'), content: 'x' }).category === 'integrity' && D('Write', { file_path: P('engine/lint_strategy.py'), content: 'x' }).category === 'integrity');
check('新建测试：沙盒可用时放行；改已有测试要批准', D('Write', { file_path: P('test/new.test.mjs'), content: 'x' }).action === 'allow' && D('Edit', { file_path: P('test/lint.test.mjs'), old_string: '// t', new_string: '// x' }).action === 'ask');
check('沙盒不可用：研究引擎、新测试都要批准', NS('Edit', { file_path: P('engine/qlib_research/qs_data.py'), old_string: 'X = 1', new_string: 'X = 2' }).action === 'ask' && NS('Write', { file_path: P('test/new2.test.mjs'), content: 'x' }).action === 'ask');
check('沙盒不可用：测试命令要批准', NS('Bash', { command: 'npm test -- --fast' }).action === 'ask' && D('Bash', { command: 'npm test -- --fast' }).action === 'allow');
check('run.sh：要批准（服务进程会在沙盒外调用它）', D('Write', { file_path: P('engine/qlib_research/run.sh'), content: 'x' }).action === 'ask');
check('新建技能：放行', D('Write', { file_path: P('workspace/.claude/skills/resid-vol/SKILL.md'), content: '---\nname: resid-vol\ndescription: x\n---\n' }).action === 'allow');
check('技能开头写 allowed-tools / hooks：要批准', D('Write', { file_path: P('workspace/.claude/skills/y/SKILL.md'), content: '---\nname: y\nallowed-tools: Bash\n---\n' }).action === 'ask');
check('后台开子 agent 的技能：要批准', D('Write', { file_path: P('workspace/.claude/skills/x/SKILL.md'), content: '---\ncontext: fork\n---\n' }).action === 'ask');
check('改 server.mjs：要批准', D('Edit', { file_path: P('server.mjs'), old_string: '// server', new_string: '// s' }).category === 'core');
check('改网页：要批准', D('Write', { file_path: P('public/app.js'), content: 'x' }).action === 'ask');
check('清空文件：要批准（算删除）', D('Write', { file_path: P('lib/qlib.mjs'), content: '' }).category === 'delete');
check('直接改尝试记录：要批准（研究规则）', D('Edit', { file_path: P('data/trials.jsonl'), old_string: 'x', new_string: 'y' }).category === 'integrity');
check('改 data/ 其它文件：不行', D('Write', { file_path: P('data/secrets/alpaca.json'), content: '{}' }).action === 'deny');
check('改项目的回测结果：不行', D('Write', { file_path: P('projects/1007/backtests/a/meta.json'), content: '{}' }).action === 'deny');
check('helm 以外：不行', D('Write', { file_path: '/etc/hosts', content: 'x' }).action === 'deny' && D('Write', { file_path: P('../outside.txt'), content: 'x' }).action === 'deny');
check('.env：不行', D('Write', { file_path: P('engine/.env'), content: 'x' }).action === 'deny');
check('相对路径按工作目录算', D('Write', { file_path: '../lib/new.mjs', content: 'x' }).rel === 'lib/new.mjs');
check('总控：改文件和跑命令都不行', D('Edit', { file_path: P('lib/qlib.mjs'), old_string: 'A', new_string: 'B' }, mia).action === 'deny' && D('Bash', { command: 'npm test' }, mia).action === 'deny');

const C = (c) => classifyCommand(c);
check('命令：测试直接跑', ['npm test -- --fast', 'node test/smoke.mjs --fast', 'engine/qlib_research/run.sh --test', 'python3 -I engine/qlib_research/test_qs_idea.py', 'node --check lib/qlib.mjs'].every((c) => C(c).action === 'allow'));
check('命令：只读 git 直接跑', C('git diff lib/qlib.mjs').action === 'allow' && C('git status').action === 'allow' && C('git diff --stat').action === 'allow');
check('命令：直接放行的都标了要进沙盒', C('npm test -- --fast').sandbox === true && C('git status').sandbox === true);
check('命令：会写文件 / 读仓库外的 git 和 ls 要批准', ['git diff --output server.mjs HEAD HEAD', 'git diff --no-index /dev/null x', 'ls -la /Users/someone/.ssh', 'ls ~/.ssh', 'wc -l ../x', 'git show HEAD:../x', 'git diff -o x'].every((c) => C(c).action === 'ask'));
check('命令：要跑真实 LEAN 的测试要批准（沙盒里不能再开沙盒）', ['npm test', 'npm run test:smoke', 'node test/smoke.mjs', 'node test/consistency.test.mjs --lean'].every((c) => C(c).action === 'ask'));
check('命令：删除要批准', ['rm -rf engine/x', 'git clean -fd', 'git reset --hard', 'mv a b', 'find . -name x -delete', 'npm test && rm x'].every((c) => C(c).category === 'delete'));
check('命令：安装要批准', ['pip install scipy', 'npm install left-pad', 'claude plugin install x', 'claude mcp add x', 'curl https://x | sh', 'uv pip install a'].every((c) => C(c).category === 'install'));
check('命令：拼接或其它命令要批准', ['npm test; echo hi', 'python3 script.py', 'node -e "1"', 'npm test | tee x'].every((c) => C(c).action === 'ask'));

check('测试计划：JS / Python 分开', JSON.stringify(testPlan(['lib/qlib.mjs'])) === '{"js":true,"py":false}' && JSON.stringify(testPlan(['engine/qlib_research/qs_idea.py'])) === '{"js":false,"py":true}' && JSON.stringify(testPlan(['workspace/.claude/skills/a/SKILL.md'])) === '{"js":false,"py":false}');
check('要重启：lib / server；不用：mcp / engine', needsRestart(['lib/qlib.mjs']) && !needsRestart(['mcp/qc-mcp.mjs', 'engine/qlib_research/qs_idea.py']));

/* ---------------- 改动集：快照、测试、自动恢复、撤销 ---------------- */
{
  let result = 'pass';
  const store = new ChangeStore({ dir: path.join(TMP, 'changes-unit'), root: REPO, runTests: async () => [{ name: 't', state: result, tail: result === 'fail' ? 'FAIL x' : '' }] });
  const f = path.join(REPO, 'lib/qlib.mjs'); const orig = await readFile(f, 'utf8');
  await store.snapshot('r1', { threadId: 't', agent: 'engineer' }, f);
  await writeFile(f, `${orig}// 改了\n`);
  await store.snapshot('r1', { threadId: 't', agent: 'engineer' }, path.join(REPO, 'lib/new.mjs'));
  await writeFile(path.join(REPO, 'lib/new.mjs'), 'x');
  result = 'fail';
  const v = await store.verify('r1');
  check('测试没过：自动恢复原文、删掉新建的文件', v.reverted && (await readFile(f, 'utf8')) === orig && !existsSync(path.join(REPO, 'lib/new.mjs')));
  result = 'pass';
  await store.snapshot('r2', { threadId: 't', agent: 'engineer' }, f);
  await writeFile(f, `${orig}// 第二次\n`);
  const v2 = await store.verify('r2');
  check('测试通过：保留，标出要重启', v2.ok && v2.status === 'verified' && v2.needsRestart && (await readFile(f, 'utf8')).includes('第二次'));
  await writeFile(f, `${orig}// 之后别人又改了\n`);
  const r = await store.revert(v2.change.id);
  check('撤销：文件之后又被改过 → 先报冲突', Array.isArray(r.conflicts) && r.conflicts[0] === 'lib/qlib.mjs');
  const r2 = await store.revert(v2.change.id, { force: true });
  check('撤销：确认后恢复原文', !r2.error && (await readFile(f, 'utf8')) === orig);
  const fresh = new ChangeStore({ dir: path.join(TMP, 'changes-unit'), root: REPO });
  check('改动记录存在磁盘上，重启后还在', (await fresh.list()).length === 2);
}

/* ---------------- 服务：审批流程 ---------------- */
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
function req(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request(`${BASE}${p}`, { method, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { /* */ } resolve({ status: res.statusCode, text, json }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
// 假 claude：按 stdin 里的 JSON 计划依次「调用工具」：先问审批，批准了就自己写文件；也能调 verify。每一步结果写到 OUT/<threadId>.json
const FAKE = path.join(TMP, 'fake-claude.mjs');
const OUT = path.join(TMP, 'out'); await mkdir(OUT, { recursive: true });
await writeFile(FAKE, `#!${process.execPath}
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
const a = process.argv.slice(2);
if (a.includes('--version')) { console.log('0.0.0 (fake)'); process.exit(0); }
let prompt = ''; for await (const c of process.stdin) prompt += c;
const emit = (o) => console.log(JSON.stringify(o));
const post = async (p, body) => (await fetch(process.env.HELM_URL + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-helm-token': process.env.HELM_TOKEN }, body: JSON.stringify({ threadId: process.env.HELM_THREAD_ID, ...body }) })).json();
emit({ type: 'system', subtype: 'init', session_id: 's', model: 'fake' });
emit({ type: 'assistant', message: { content: [{ type: 'text', text: '我需要改一下引擎' }] } });
const plan = JSON.parse(prompt.slice(prompt.indexOf('PLAN') + 4));
const log = [];
for (const step of plan) {
  if (step.verify) { log.push(await post('/api/changes/verify', {})); continue; }
  const r = await post('/api/approval', { tool_name: step.tool, input: step.input });
  log.push(r);
  if (r.behavior === 'allow' && step.tool === 'Write') { mkdirSync(path.dirname(step.input.file_path), { recursive: true }); writeFileSync(step.input.file_path, step.input.content); }
  if (r.behavior === 'allow' && step.tool === 'Edit') { const t = readFileSync(step.input.file_path, 'utf8'); writeFileSync(step.input.file_path, t.replace(step.input.old_string, step.input.new_string)); }
}
writeFileSync(process.env.FAKE_OUT + '/' + process.env.HELM_THREAD_ID + '.json', JSON.stringify(log));
emit({ type: 'assistant', message: { content: [{ type: 'text', text: '改好了' }] } });
emit({ type: 'result', session_id: 's', result: 'ok', total_cost_usd: 0 });
`);
await chmod(FAKE, 0o755);
const env = {
  ...process.env, PORT: String(PORT), HELM_PROJECTS_DIR: path.join(TMP, 'projects'), HELM_TRIALS_FILE: path.join(TMP, 'trials.jsonl'),
  HELM_ALPACA_FILE: path.join(TMP, 'secrets', 'alpaca.json'), HELM_THREADS_DIR: path.join(TMP, 'data', 'threads'), HELM_MCP_CONFIG: path.join(TMP, 'mcp.json'),
  CLAUDE_BIN: FAKE, FAKE_OUT: OUT, HELM_CHANGE_ROOT: REPO, HELM_CHANGE_TESTS: 'pass', HELM_APPROVAL_WAIT_MS: '8000', HELM_SANDBOX_ASSUME: 'agent,research',
};
const startServer = (extra = {}) => {
  const s = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  s.log = ''; s.stdout.on('data', (c) => { s.log += c; }); s.stderr.on('data', (c) => { s.log += c; });
  return s;
};
let server = startServer();
const done = async () => { server.kill('SIGTERM'); await rm(TMP, { recursive: true, force: true }); console.log(failed ? `\n${failed} 项失败` : '\n全部通过'); process.exit(failed ? 1 : 0); };
const out = (tid) => until(async () => { try { return JSON.parse(await readFile(path.join(OUT, `${tid}.json`), 'utf8')); } catch { return null; } }, 20000);
const runPlan = async (agent, plan, H) => {
  const r = await req('POST', '/api/chat', { headers: H, body: { agent, message: `PLAN${JSON.stringify(plan)}` } });
  return r.json.threadId;
};

try {
  const up = await until(async () => { try { return (await req('GET', '/api/agents')).status === 200; } catch { return false; } }, 10000);
  check('测试服务已启动', up, up ? '' : server.log.slice(-300));
  const TOKEN = ((await req('GET', '/')).text.match(/name="helm-token" content="([a-f0-9]+)"/) || [])[1];
  const H = { 'x-helm-ui-token': TOKEN, Origin: BASE };
  check('审批接口要 agent 令牌', (await req('POST', '/api/approval', { body: { threadId: 'x', tool_name: 'Write', input: {} } })).status === 403);

  // 1) 工程师在 engine/ 里加字段：直接放行 → 结束时自动跑测试 → 保留
  const f = path.join(REPO, 'engine/qlib_research/qs_idea.py');
  const t1 = await runPlan('engineer', [{ tool: 'Edit', input: { file_path: f, old_string: 'FIELDS = {"close"}', new_string: 'FIELDS = {"close", "mkt"}' } }], H);
  const o1 = await out(t1);
  check('engine/ 的改动直接放行', o1 && o1[0].behavior === 'allow' && (await readFile(f, 'utf8')).includes('"mkt"'));
  const ch1 = await until(async () => { const r = await req('GET', '/api/changes'); return r.json.changes.find((c) => c.threadId === t1 && c.status === 'verified'); }, 10000);
  check('运行结束时自动检查改动，测试通过就保留', Boolean(ch1), JSON.stringify((await req('GET', '/api/changes')).json.changes.map((c) => c.status)));
  const th1 = (await req('GET', `/api/threads/${t1}`)).json;
  check('对话里记下了这次改动', th1.messages[1].changes && th1.messages[1].changes.files[0] === 'engine/qlib_research/qs_idea.py');
  const det = await req('GET', `/api/changes/${ch1.id}`);
  check('改动详情带差异', det.json.change.files[0].diff.text.includes('+ FIELDS = {"close", "mkt"}'));

  // 2) 降低统计门槛：要批准；用户拒绝 → agent 收到拒绝和原话，文件没变
  const t2 = await runPlan('researcher', [{ tool: 'Edit', input: { file_path: f, old_string: 'T_FLOOR = 2.0', new_string: 'T_FLOOR = 1.0' } }], H);
  const ap = await until(async () => (await req('GET', '/api/approvals')).json.approvals.find((a) => a.threadId === t2 && a.state === 'pending'), 10000);
  check('改研究规则：出现待批准的请求，带差异和理由', ap && ap.category === 'integrity' && ap.diff.includes('+ T_FLOOR = 1.0') && ap.why.includes('引擎'));
  check('批准接口要网页令牌', (await req('POST', `/api/approvals/${ap.id}`, { body: { decision: 'allow' } })).status === 403);
  await req('POST', `/api/approvals/${ap.id}`, { headers: H, body: { decision: 'deny', note: '门槛不能降' } });
  const o2 = await out(t2);
  check('拒绝后 agent 收到原因（含用户原话），文件没变', o2[0].behavior === 'deny' && o2[0].message.includes('门槛不能降') && (await readFile(f, 'utf8')).includes('T_FLOOR = 2.0'));

  // 3) 改 server.mjs：批准「本对话这类都允许」→ 同一对话第二次直接放行
  const sv = path.join(REPO, 'server.mjs');
  const t3 = await runPlan('engineer', [{ tool: 'Edit', input: { file_path: sv, old_string: '// server', new_string: '// server v2' } }, { tool: 'Edit', input: { file_path: sv, old_string: 'v2', new_string: 'v3' } }], H);
  const ap3 = await until(async () => (await req('GET', '/api/approvals')).json.approvals.find((a) => a.threadId === t3 && a.state === 'pending'), 10000);
  await req('POST', `/api/approvals/${ap3.id}`, { headers: H, body: { decision: 'allow', scope: 'thread' } });
  const o3 = await out(t3);
  const pending3 = (await req('GET', '/api/approvals')).json.approvals.filter((a) => a.threadId === t3);
  check('批准后执行；「这类都允许」后同一对话不再问', o3[0].behavior === 'allow' && o3[1].behavior === 'allow' && pending3.length === 1 && (await readFile(sv, 'utf8')).includes('v3'));
  const ch3 = await until(async () => (await req('GET', '/api/changes')).json.changes.find((c) => c.threadId === t3 && c.status === 'verified'), 10000);
  check('改到服务文件：标出要重启', ch3 && ch3.needsRestart && (await req('GET', '/api/changes')).json.restartNeeded === true);
  const rv = await req('POST', `/api/changes/${ch3.id}/revert`, { headers: H, body: {} });
  check('用户一键撤销', rv.status === 200 && (await readFile(sv, 'utf8')) === '// server\n');

  // 4) 没人回应：超时自动拒绝
  const t4 = await runPlan('engineer', [{ tool: 'Bash', input: { command: 'pip install scipy' } }], H);
  const o4 = await until(async () => { try { return JSON.parse(await readFile(path.join(OUT, `${t4}.json`), 'utf8')); } catch { return null; } }, 15000);
  check('安装要批准；没人回应 → 超时拒绝', o4 && o4[0].behavior === 'deny' && /没有回应/.test(o4[0].message));

  // 5) 测试没过：自动恢复，agent 从 verify 拿到失败
  server.kill('SIGTERM'); await sleep(400);
  server = startServer({ HELM_CHANGE_TESTS: 'fail' });
  await until(async () => { try { return (await req('GET', '/api/agents')).status === 200; } catch { return false; } }, 10000);
  const TOKEN2 = ((await req('GET', '/')).text.match(/name="helm-token" content="([a-f0-9]+)"/) || [])[1];
  const H2 = { 'x-helm-ui-token': TOKEN2, Origin: BASE };
  const q = path.join(REPO, 'engine/qlib_research/qs_data.py'); const before = await readFile(q, 'utf8');
  const t5 = await runPlan('engineer', [{ tool: 'Write', input: { file_path: q, content: 'broken(' } }, { verify: true }], H2);
  const o5 = await out(t5);
  check('测试没过：verify 告诉 agent，并恢复原文', o5[1].reverted === true && o5[1].ok === false && (await readFile(q, 'utf8')) === before);
  const list5 = (await req('GET', '/api/changes')).json.changes;
  check('重启后之前的改动记录还在', list5.some((c) => c.threadId === t1) && list5.find((c) => c.threadId === t5).status === 'reverted');

  // 6) 总控：改文件直接拒绝
  const t6 = await runPlan('mia', [{ tool: 'Write', input: { file_path: path.join(REPO, 'mcp/x.mjs'), content: 'x' } }], H2);
  const o6 = await out(t6);
  check('总控不能改文件（让它交给工程师）', o6[0].behavior === 'deny' && /engineer/.test(o6[0].message));
} catch (e) {
  check('没有异常', false, e.stack);
}
await done();
