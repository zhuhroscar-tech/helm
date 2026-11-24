#!/usr/bin/env node
// Agent 行为评测：用真实的 Helm 服务 + 真实的 claude 跑事先写好的场景，工具结果用替身（evals/stub-tools.mjs），
// 再按固定规则给 agent 的决定打分（evals/grade.mjs）。用来发现改提示词、换模型之后 agent 悄悄不守规则了。
//
//   npm run eval                                  全部场景，每个跑 3 次
//   npm run eval -- --scenario s03,s07 --runs 1   只跑几个
//   npm run eval -- --model sonnet --effort high  指定模型 / 思考深度（所有 agent 都用它）
//   npm run eval -- --agents data/agents-backups/xxx.json   用另一份 agents.json（比如改提示词之前的备份）
//   npm run eval -- --baseline evals/results/<上一次>.json   和上一次比，标出变差的检查
//   npm run eval -- --list                        列出场景和覆盖的规则
//   npm run eval -- --selftest                    不调模型：用假 claude 证明每个场景的检查能抓住违规（几十秒）
//
// 每次真实运行都要花模型用量：一个场景大约几毛到几美元（总控场景会交接好几个 agent）。
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, cp } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadThreads, buildTrace, gradeRun } from './grade.mjs';
import { RULES } from './rules.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.dirname(HERE);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 场景 ---------------- */

// 场景分两组：core（日常，s*.mjs）和 autopilot（自动研究，a*.mjs，一轮花用量多，默认不跑）
export async function loadScenarios(filter = null, { suite = 'all' } = {}) {
  const dir = path.join(HERE, 'scenarios');
  const files = (await readdir(dir)).filter((f) => /^[sa]\d+.*\.mjs$/.test(f)).sort();
  const out = [];
  for (const f of files) {
    const m = await import(pathToFileURL(path.join(dir, f)).href);
    const s = m.default;
    s.suite = s.suite || 'core';
    if (filter) { if (filter.some((x) => s.id === x || s.id.startsWith(`${x}-`))) out.push(s); continue; }
    if (suite === 'all' || s.suite === suite) out.push(s);
  }
  return out;
}

/* ---------------- 起一个临时的 Helm 服务 ---------------- */

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

function request(base, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request(`${base}${p}`, { method, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch { /* html */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function subscribe(base, onEvent) {
  const r = http.get(`${base}/api/events`, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = block.split('\n').find((l) => l.startsWith('data: '));
        if (line) { try { onEvent(JSON.parse(line.slice(6))); } catch { /* ignore */ } }
      }
    });
  });
  r.on('error', () => {});
  return () => r.destroy();
}

/**
 * 跑一个场景一次。返回 { rootId, events, grade, cost, durationMs, error, dir }
 * opts: { claudeBin, model, effort, agentsFile, timeoutMs, fakePlan, keepDir, log }
 */
export async function runOnce(scenario, opts = {}) {
  const log = opts.log || (() => {});
  const TMP = await mkdtemp(path.join(os.tmpdir(), `helm-eval-${scenario.id.slice(0, 12)}-`));
  const threadsDir = path.join(TMP, 'data', 'threads');
  await mkdir(threadsDir, { recursive: true });
  const fixturesPath = path.join(TMP, 'fixtures.json');
  await writeFile(fixturesPath, JSON.stringify({ scenario: scenario.id, state: path.join(TMP, 'state.json'), ...(scenario.autopilot ? { autopilot: scenario.autopilot } : {}), ...(scenario.fixtures || {}) }, null, 1));
  let planPath = null;
  if (opts.fakePlan) { planPath = path.join(TMP, 'plan.json'); await writeFile(planPath, JSON.stringify(opts.fakePlan)); }

  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    PORT: String(PORT),
    HELM_PROJECTS_DIR: path.join(TMP, 'projects'),
    HELM_TRIALS_FILE: path.join(TMP, 'trials.jsonl'),
    HELM_ALPACA_FILE: path.join(TMP, 'secrets', 'alpaca.json'),
    HELM_THREADS_DIR: threadsDir,
    HELM_MCP_CONFIG: path.join(TMP, 'mcp.json'),
    HELM_DECK_DIR: path.join(TMP, 'deck'),
    HELM_CHANGE_ROOT: path.join(TMP, 'change-root'), // 万一放行了改文件，也只能改到临时目录
    HELM_QC_FILE: path.join(TMP, 'secrets', 'qc.json'),
    HELM_LEAN_DATA: path.join(TMP, 'lean-data'),
    HELM_UPDATE_ROOT: TMP,
    QS_IDEA_REGISTRY: path.join(TMP, 'idea_registry.jsonl'),
    QS_TIMING_REGISTRY: path.join(TMP, 'timing_registry.jsonl'),
    HELM_TRANSLATE: '0',
    HELM_NO_AUTO_UPDATE: '1',
    HELM_EVAL_FIXTURES: fixturesPath,
    CLAUDE_BIN: opts.claudeBin || process.env.CLAUDE_BIN || 'claude',
    ...(opts.agentsFile ? { HELM_AGENTS_FILE: path.resolve(opts.agentsFile) } : {}),
    ...(opts.model ? { CLAUDE_MODEL: opts.model } : {}),
    ...(opts.effort ? { CLAUDE_EFFORT: opts.effort } : {}),
    ...(planPath ? { EVAL_FAKE_PLAN: planPath } : {}),
  };
  await mkdir(env.HELM_CHANGE_ROOT, { recursive: true });
  const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', (c) => { serverLog = (serverLog + c).slice(-6000); });
  server.stderr.on('data', (c) => { serverLog = (serverLog + c).slice(-6000); });
  const t0 = Date.now();
  let unsub = () => {};
  const out = { scenario: scenario.id, rootId: null, events: [], grade: null, cost: 0, durationMs: 0, error: null, dir: TMP, questions: [] };
  try {
    let up = false;
    for (let i = 0; i < 150 && !up; i++) {
      try { up = (await request(BASE, 'GET', '/api/agents')).status === 200; } catch { await sleep(100); }
    }
    if (!up) throw new Error(`Helm 服务没起来：${serverLog.slice(-600)}`);
    const page = await request(BASE, 'GET', '/');
    const TOKEN = (page.text.match(/<meta name="helm-token" content="([a-f0-9]{64})">/) || [])[1];
    const H = { 'X-Helm-UI-Token': TOKEN, Origin: BASE };

    // 用户的角色：问题按场景回答（默认跳过 = 按推荐的第一个选项）
    let rootEnded = false;
    const ends = new Set();
    unsub = subscribe(BASE, async (ev) => {
      if (ev.type === 'question_request' && ev.question) {
        const q = ev.question;
        // 自动研究的场景：问题本该由服务端自动回答，弹到这里就记一笔（检查 no-user-questions 会不通过），再跳过让它继续
        const body = typeof scenario.answer === 'function' && scenario.suite !== 'autopilot' ? scenario.answer(q) : { skip: true };
        out.questions.push({ agent: q.agent, questions: (q.questions || []).map((x) => x.question), answered: body.skip ? '跳过（按推荐）' : JSON.stringify(body) });
        log(`    ${q.agent} 用 ask_user 问了 ${q.questions.length} 个问题 → ${body.skip ? '按推荐' : '按场景回答'}`);
        await request(BASE, 'POST', `/api/questions/${q.id}`, { headers: H, body }).catch(() => {});
      }
      if (ev.type === 'run_start' && ev.threadId !== out.rootId) log(`    → ${ev.agent} 开始${ev.from ? `（${ev.from.agent} 交接来的）` : ''}`);
      if (ev.type === 'run_end') { ends.add(ev.threadId); if (ev.threadId === out.rootId) rootEnded = true; }
    });
    await sleep(100);

    const mo = { ...(opts.model ? { model: opts.model } : {}), ...(opts.effort ? { effort: opts.effort } : {}) };
    let chat;
    if (scenario.autopilot) {
      // 自动研究：和网页上点「自动研究」一样，由服务端生成开工说明（lib/autopilot.mjs kickoffMessage）
      chat = await request(BASE, 'POST', '/api/autopilot/start', { headers: H, body: { ...scenario.autopilot, ...mo } });
    } else {
      const message = typeof scenario.message === 'function' ? scenario.message() : scenario.message;
      chat = await request(BASE, 'POST', '/api/chat', { headers: H, body: { agent: scenario.agent || 'mia', message, context: scenario.context || undefined, ...mo } });
    }
    if (chat.status !== 200) throw new Error(`发消息失败：${chat.status} ${chat.text.slice(0, 200)}`);
    out.rootId = chat.json.threadId;
    out.autopilotRunId = chat.json.runId || null;
    if (ends.has(out.rootId)) rootEnded = true;

    const timeoutMs = opts.timeoutMs || scenario.timeoutMs || (scenario.suite === 'autopilot' ? 150 : 40) * 60 * 1000;
    while (Date.now() - t0 < timeoutMs) {
      if (rootEnded) {
        const list = (await request(BASE, 'GET', '/api/threads')).json || [];
        if (!list.some((t) => t.running)) break;
      }
      await sleep(500);
    }
    if (Date.now() - t0 >= timeoutMs) {
      out.error = `超时（${Math.round(timeoutMs / 60000)} 分钟）`;
      await request(BASE, 'POST', '/api/chat/stop', { headers: H, body: { threadId: out.rootId } }).catch(() => {});
      await sleep(2000);
    }
  } catch (e) {
    out.error = e.message;
  } finally {
    unsub();
    server.kill('SIGTERM');
    await new Promise((r) => { if (server.exitCode !== null) r(); else { server.on('exit', r); setTimeout(r, 5000); } });
  }
  out.durationMs = Date.now() - t0;
  if (out.rootId) {
    const tree = await loadThreads(threadsDir, out.rootId);
    out.events = buildTrace(tree);
    for (const t of tree.threads.values()) for (const m of t.messages || []) if (m.role === 'assistant' && typeof m.cost === 'number') out.cost += m.cost;
    out.grade = gradeRun(scenario, out.events, { questions: out.questions, cost: out.cost });
    if (out.error) out.grade.pass = false;
  }
  if (!opts.keepDir && !opts.saveTo) await rm(TMP, { recursive: true, force: true });
  if (opts.saveTo) {
    await mkdir(opts.saveTo, { recursive: true });
    await cp(threadsDir, path.join(opts.saveTo, 'threads'), { recursive: true }).catch(() => {});
    await writeFile(path.join(opts.saveTo, 'trace.json'), JSON.stringify(out.events, null, 1));
    if (!opts.keepDir) await rm(TMP, { recursive: true, force: true });
  }
  return out;
}

/* ---------------- 汇总 ---------------- */

export function summarize(scenarios, runsBy) {
  const rows = [];
  for (const s of scenarios) {
    const runs = runsBy[s.id] || [];
    const ids = runs[0] && runs[0].grade ? runs[0].grade.checks.map((c) => c.id) : [];
    for (const id of ids) {
      const rs = runs.map((r) => (r.grade ? r.grade.checks.find((c) => c.id === id) : null));
      const passed = rs.filter((c) => c && c.pass).length;
      const first = rs.find((c) => c && !c.pass) || rs[0];
      rows.push({ scenario: s.id, check: id, rule: first && first.rule, desc: first && first.desc, passed, runs: runs.length, rate: runs.length ? passed / runs.length : 0, evidence: first ? first.evidence : '' });
    }
    if (runs.some((r) => r.error || !r.grade)) rows.push({ scenario: s.id, check: 'run-completed', rule: null, desc: '运行正常结束', passed: runs.filter((r) => !r.error && r.grade).length, runs: runs.length, rate: runs.filter((r) => !r.error && r.grade).length / runs.length, evidence: runs.map((r) => r.error).filter(Boolean).join('；') });
  }
  return rows;
}

const status = (rate) => (rate >= 1 ? 'pass' : rate >= 0.5 ? 'flaky' : 'fail');

export function compare(rows, baseline) {
  const base = new Map((baseline.rows || []).map((r) => [`${r.scenario}/${r.check}`, r]));
  return rows.map((r) => {
    const b = base.get(`${r.scenario}/${r.check}`);
    return { ...r, baseRate: b ? b.rate : null, regressed: Boolean(b && r.rate < b.rate - 0.34) };
  });
}

function fileHash(p) { try { return createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12); } catch { return null; } }

export function markdownReport(meta, rows, runsBy, scenarios) {
  const L = [];
  L.push(`# Agent 行为评测 ${meta.stamp}`, '');
  L.push(`- 模型：${meta.model || '（agents.json / 默认）'}，思考深度：${meta.effort || '（默认）'}，claude ${meta.claudeVersion || '?'}`);
  L.push(`- agents.json：${meta.agentsFile}（${meta.agentsHash}），workspace/CLAUDE.md：${meta.claudeMdHash}，git ${meta.git || '?'}`);
  L.push(`- 每个场景 ${meta.runs} 次；总用量 $${meta.cost.toFixed(2)}；用时 ${Math.round(meta.durationMs / 60000)} 分钟`);
  if (meta.baseline) L.push(`- 对比：${meta.baseline}`);
  const bad = rows.filter((r) => r.rate < 1);
  L.push('', `**结果：${rows.length - bad.length}/${rows.length} 项检查每次都通过**${rows.some((r) => r.regressed) ? `；**${rows.filter((r) => r.regressed).length} 项比上次变差**` : ''}`, '');
  L.push('| 场景 | 检查 | 规则 | 通过 | 状态 | 证据（第一次没通过的） |', '|---|---|---|---|---|---|');
  for (const r of rows) {
    const st = status(r.rate) + (r.regressed ? ' ↓' : '') + (r.baseRate != null && r.baseRate !== r.rate ? `（上次 ${Math.round(r.baseRate * 100)}%）` : '');
    L.push(`| ${r.scenario} | ${r.desc || r.check} | ${r.rule || ''} | ${r.passed}/${r.runs} | ${st} | ${r.rate < 1 ? String(r.evidence || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 300) : ''} |`);
  }
  L.push('', '## 每次运行', '');
  for (const s of scenarios) {
    for (const [i, r] of (runsBy[s.id] || []).entries()) {
      const hs = r.events.filter((e) => e.kind === 'tool' && e.tool === 'handoff').map((e) => `${e.agent}→${e.args.agent}${e.args.wait ? '' : '(不等)'}`);
      L.push(`- **${s.id} #${i + 1}**：${r.grade && r.grade.pass ? '全部通过' : '有没通过的'}；$${r.cost.toFixed(2)}，${Math.round(r.durationMs / 1000)} 秒；交接 ${hs.join('，') || '无'}${r.questions.length ? `；问了用户 ${r.questions.length} 次` : ''}${r.grade && r.grade.unscripted.length ? `；没预设结果的工具：${r.grade.unscripted.join('、')}` : ''}${r.error ? `；出错：${r.error}` : ''}${r.saved ? `；记录：${r.saved}` : ''}`);
    }
  }
  return L.join('\n');
}

/* ---------------- 自检（不调模型） ---------------- */

/** 每个场景跑两次假 claude：good 计划要全部通过，bad 计划要在 badFails 列出的检查上不通过 */
export async function selfTest(scenarios, { log = console.log } = {}) {
  const problems = [];
  for (const s of scenarios) {
    if (!s.selfTest) { problems.push(`${s.id}：没有 selfTest`); continue; }
    const good = await runOnce(s, { claudeBin: path.join(HERE, 'fake-claude.mjs'), fakePlan: s.selfTest.good, timeoutMs: 60000 });
    const gFail = good.grade ? good.grade.checks.filter((c) => !c.pass) : [{ id: 'run', evidence: good.error }];
    if (gFail.length || good.error) problems.push(`${s.id} 守规则的做法没通过：${gFail.map((c) => `${c.id}（${c.evidence}）`).join('；')}${good.error ? ` ${good.error}` : ''}`);
    if (good.grade && good.grade.unscripted.length) problems.push(`${s.id} 守规则的做法用到了没预设结果的工具：${good.grade.unscripted.join('、')}`);
    const bad = await runOnce(s, { claudeBin: path.join(HERE, 'fake-claude.mjs'), fakePlan: s.selfTest.bad, timeoutMs: 60000 });
    const failed = new Set(bad.grade ? bad.grade.checks.filter((c) => !c.pass).map((c) => c.id) : []);
    const missed = (s.selfTest.badFails || []).filter((id) => !failed.has(id));
    if (!s.selfTest.badFails || !s.selfTest.badFails.length) problems.push(`${s.id}：selfTest.badFails 为空`);
    if (missed.length) problems.push(`${s.id} 违反规则的做法没被抓住：${missed.join('、')}（实际没通过：${[...failed].join('、') || '无'}）`);
    log(`${missed.length || gFail.length ? 'FAIL' : 'PASS'}  ${s.id}：守规则 ${gFail.length ? '✗' : '✓'}，违规被抓住 ${(s.selfTest.badFails || []).length - missed.length}/${(s.selfTest.badFails || []).length}`);
  }
  return problems;
}

/** 规则覆盖：每条规则至少有一个场景，场景引用的规则都在目录里 */
export function coverage(scenarios) {
  const covered = new Map(RULES.map((r) => [r.id, []]));
  const unknown = [];
  for (const s of scenarios) {
    for (const id of s.covers || []) { if (covered.has(id)) covered.get(id).push(s.id); else unknown.push(`${s.id}:${id}`); }
    for (const c of s.checks || []) if (c.rule && !covered.has(c.rule)) unknown.push(`${s.id}/${c.id}:${c.rule}`);
  }
  return { covered, uncovered: [...covered].filter(([, v]) => !v.length).map(([k]) => k), unknown };
}

/* ---------------- 命令行 ---------------- */

function argVal(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }

async function main() {
  const args = process.argv.slice(2);
  const filter = argVal(args, '--scenario') ? argVal(args, '--scenario').split(',').map((x) => x.trim()).filter(Boolean) : null;
  // 自检默认两组都跑（不花用量）；真实运行默认只跑 core，自动研究要 --suite autopilot
  const suite = argVal(args, '--suite') || (args.includes('--selftest') || args.includes('--list') ? 'all' : 'core');
  const scenarios = await loadScenarios(filter, { suite });
  if (!scenarios.length) { console.error('没有匹配的场景'); process.exit(2); }

  if (args.includes('--list')) {
    for (const s of scenarios) console.log(`${s.id}  [${s.suite}·${s.agent || 'mia'}] ${s.title}\n    规则：${(s.covers || []).join('、')}`);
    const cov = coverage(await loadScenarios());
    console.log(`\n规则覆盖：${RULES.length - cov.uncovered.length}/${RULES.length}${cov.uncovered.length ? `，没覆盖：${cov.uncovered.join('、')}` : ''}`);
    return;
  }
  if (args.includes('--selftest')) {
    const problems = await selfTest(scenarios);
    if (problems.length) { console.log(`\n${problems.join('\n')}`); process.exit(1); }
    console.log('\n自检通过：每个场景守规则的做法全部通过，违规的做法都被抓住。');
    return;
  }

  const runs = Math.max(1, Number(argVal(args, '--runs') || (suite === 'autopilot' ? 1 : 3)));
  const model = argVal(args, '--model');
  const effort = argVal(args, '--effort');
  const agentsFile = argVal(args, '--agents');
  const claudeArg = argVal(args, '--claude');
  const claudeBin = claudeArg && claudeArg.includes('/') ? path.resolve(claudeArg) : claudeArg; // 服务的工作目录不同，相对路径要先变成绝对路径
  const baselineFile = argVal(args, '--baseline');
  const parallel = Math.max(1, Number(argVal(args, '--parallel') || 1));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const outDir = path.resolve(argVal(args, '--out') || path.join(HERE, 'results'));
  const runDir = path.join(outDir, stamp);
  let claudeVersion = null;
  try { claudeVersion = execFileSync(claudeBin || process.env.CLAUDE_BIN || 'claude', ['--version'], { encoding: 'utf8', timeout: 15000 }).trim(); } catch { /* 没装 */ }
  if (!claudeVersion) { console.error('找不到 claude 命令：先装好 Claude Code 并登录（或用 --claude 指定路径）。不调模型的自检用 --selftest。'); process.exit(2); }

  if (suite !== 'core' && !filter) console.log('注意：自动研究场景一轮可能花 5–20 美元、一两个小时；先用 --runs 1。');
  console.log(`Agent 行为评测：${scenarios.length} 个场景 × ${runs} 次${model ? `，模型 ${model}` : ''}${effort ? `，思考 ${effort}` : ''}${agentsFile ? `，agents=${agentsFile}` : ''}`);
  console.log('每次运行都会花模型用量。Ctrl+C 可以随时停。\n');
  const runsBy = {};
  const jobs = [];
  for (const s of scenarios) for (let i = 0; i < runs; i++) jobs.push({ s, i });
  let next = 0;
  const t0 = Date.now();
  const worker = async () => {
    while (next < jobs.length) {
      const { s, i } = jobs[next++];
      console.log(`▶ ${s.id} #${i + 1}  ${s.title}`);
      const saveTo = path.join(runDir, `${s.id}-${i + 1}`);
      const r = await runOnce(s, { claudeBin, model, effort, agentsFile, saveTo, log: (m) => console.log(m) });
      r.saved = path.relative(ROOT, saveTo);
      (runsBy[s.id] = runsBy[s.id] || [])[i] = r;
      const bad = r.grade ? r.grade.checks.filter((c) => !c.pass) : [];
      console.log(`  ${r.error ? `出错：${r.error}` : bad.length ? `✗ ${bad.map((c) => c.id).join('、')}` : '✓ 全部通过'}（$${r.cost.toFixed(2)}，${Math.round(r.durationMs / 1000)} 秒）`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, worker));

  let rows = summarize(scenarios, runsBy);
  let baseline = null;
  if (baselineFile) { baseline = JSON.parse(await readFile(baselineFile, 'utf8')); rows = compare(rows, baseline); }
  const agentsPath = path.resolve(agentsFile || path.join(ROOT, 'agents.json'));
  let git = null; try { git = execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* 不是 git 仓库 */ }
  const meta = {
    stamp, runs, model, effort, claudeVersion, git,
    agentsFile: path.relative(ROOT, agentsPath), agentsHash: fileHash(agentsPath), claudeMdHash: fileHash(path.join(ROOT, 'workspace', 'CLAUDE.md')),
    cost: Object.values(runsBy).flat().reduce((a, r) => a + (r.cost || 0), 0), durationMs: Date.now() - t0,
    baseline: baselineFile ? path.relative(ROOT, path.resolve(baselineFile)) : null,
  };
  await mkdir(outDir, { recursive: true });
  const jsonFile = path.join(outDir, `${stamp}.json`);
  const mdFile = path.join(outDir, `${stamp}.md`);
  const slim = Object.fromEntries(Object.entries(runsBy).map(([k, v]) => [k, v.map((r) => ({ grade: r.grade, cost: r.cost, durationMs: r.durationMs, error: r.error, questions: r.questions, saved: r.saved }))]));
  await writeFile(jsonFile, JSON.stringify({ meta, rows, runs: slim }, null, 1));
  await writeFile(mdFile, markdownReport(meta, rows, runsBy, scenarios));

  console.log('\n结果：');
  for (const r of rows) console.log(`  ${status(r.rate).padEnd(5)} ${r.passed}/${r.runs}  ${r.scenario} / ${r.check}${r.regressed ? '  ↓ 比上次差' : ''}${r.rate < 1 ? `\n         ${String(r.evidence).slice(0, 200)}` : ''}`);
  console.log(`\n总用量 $${meta.cost.toFixed(2)}。报告：${path.relative(process.cwd(), mdFile)}`);
  console.log(`下次改了提示词或换了模型，用 --baseline ${path.relative(process.cwd(), jsonFile)} 对比。`);
  const failing = rows.filter((r) => status(r.rate) === 'fail' || r.regressed);
  process.exit(failing.length ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
