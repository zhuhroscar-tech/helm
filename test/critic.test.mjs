// 审核员（lib/critic.mjs）：node test/critic.test.mjs
// 1) 整理模型输出、默认选项、给智能体的补充说明、叠加方案的排序 —— 纯函数
// 2) 端到端：临时目录起 server.mjs，假 claude 一边当智能体（POST /api/ask），一边当审核员（-p --tools ''，回 JSON），
//    看审核结论有没有推到网页、跳过时默认选项是否避开了被筛掉的、全部被筛掉时是否让智能体停下。
import { mkdtemp, rm, readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as C from '../lib/critic.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${String(extra).slice(0, 300)})` : ''}`); if (!cond) failed += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(50); } return null; };

const Q = [
  { question: '每天按什么规则决定做多还是做空？', header: '多空信号', options: [{ label: '时序动量', description: '过去 20 天收益 > 0 做多' }, { label: '相对强弱多空', description: '最强做多最弱做空' }, { label: '短期反转', description: '5 天跌了做多' }] },
  { question: '项目名用中文还是英文？', options: [{ label: '中文' }, { label: '英文' }] },
];
const RAW_MIXED = {
  questions: [
    { index: 0, applicable: true, options: [
      { label: '时序动量', verdict: 'drop', flags: ['hindsight', 'bogus'], reason: '三只股票是事后挑的赢家' },
      { label: '相对强弱多空', verdict: 'caution', flags: ['too_few_obs'], reason: '只有三只股票' },
      { label: '短期反转', verdict: 'weird', flags: [], reason: '' },
      { label: '不存在的选项', verdict: 'keep', flags: [], reason: 'x' },
    ] },
    { index: 1, applicable: false },
  ],
  noneWorth: true, summary: '有事后挑选问题', fix: '先换成按当时规则选出的股票池',
};

/* ---------- 纯函数 ---------- */
{
  const rv = C.sanitizeReview(RAW_MIXED, Q);
  check('只接受给定选项、未知代码丢掉、未知结论当有保留', Object.keys(rv.questions[0].options).length === 3 && rv.questions[0].options['时序动量'].flags.join() === 'hindsight' && rv.questions[0].options['短期反转'].verdict === 'caution');
  check('不是研究选择的问题不审', rv.questions[1].applicable === false);
  check('模型说「全部不值得」但有不是 drop 的：以逐项为准', rv.noneWorth === false && rv.fix === '');
  check('默认选项：避开被筛掉的第一个', C.defaultPick(Q[0], rv.questions[0]) === '相对强弱多空');
  check('默认选项：不审的问题用第一个', C.defaultPick(Q[1], rv.questions[1]) === '中文');
  const allDrop = C.sanitizeReview({ questions: [{ index: 0, applicable: true, options: Q[0].options.map((o) => ({ label: o.label, verdict: 'drop', flags: ['hindsight'], reason: '事后挑的' })) }, { index: 1, applicable: false }], summary: 's', fix: '换股票池' }, Q);
  check('全部 drop：noneWorth + 建议', allDrop.noneWorth && allDrop.fix === '换股票池');
  check('全部 drop：没有默认选项', C.defaultPick(Q[0], allDrop.questions[0]) === null);
  const q = { questions: Q, answers: [{ selected: ['时序动量'] }, { selected: ['中文'] }] };
  const n1 = C.agentNote(q, rv);
  check('用户选了被筛掉的：照做但要在总结里说明', /「时序动量」审核员标为不值得做/.test(n1.note) && /照用户的选择做/.test(n1.note) && /事后挑选/.test(n1.note));
  const n2 = C.agentNote({ questions: Q }, rv, { skipped: true });
  check('跳过：默认改用没被筛掉的，并说明', n2.defaults[0] === '相对强弱多空' && /默认改用「相对强弱多空」/.test(n2.note));
  const n3 = C.agentNote({ questions: Q }, allDrop, { skipped: true });
  check('跳过且全部被筛掉：让智能体不要继续', /不要继续执行/.test(n3.note) && /换股票池/.test(n3.note));
  check('没有审核结论：不加说明，默认第一个', C.agentNote({ questions: Q }, null).note === '' && C.agentNote({ questions: Q }, null).defaults[0] === '时序动量');
  check('提示词：不许按「谁更赚钱」来判断、要列出问题代码', /must NOT judge by guessing which option would make the most money/.test(C.criticPrompt('en')) && /hindsight/.test(C.criticPrompt('zh')) && /简体中文/.test(C.criticPrompt('zh')));
  let threw = false;
  const failing = await C.review({ input: {}, items: Q, runModel: async () => { threw = true; throw new Error('claude exit 1'); } });
  check('审核出错：返回 null（不挡流程）', threw && failing === null);
  let n = 0;
  const ok = await C.review({ input: {}, items: Q, runModel: async () => { n += 1; return n === 1 ? 'sure' : JSON.stringify(RAW_MIXED); } });
  check('回复不是 JSON：再问一次', n === 2 && ok && ok.questions[0].applicable);
  check('没有选项：不调用模型', (await C.review({ input: {}, items: [], runModel: async () => { throw new Error('x'); } })) === null);
  // 叠加一层的方案
  const result = { options: [
    { id: 'a', kind: 'layer', title: 'A 动量选股', recommended: false }, { id: 'vol', kind: 'vol', title: '波动率目标', recommended: true },
    { id: 'timing', kind: 'timing', title: '宽度择时', recommended: true }, { id: 'none', kind: 'none', title: '不加这一层' },
  ] };
  const lrv = C.sanitizeReview({ questions: [{ index: 0, applicable: true, options: [{ label: 'A 动量选股', verdict: 'keep', flags: [], reason: 'ok' }, { label: '波动率目标', verdict: 'drop', flags: ['duplicate'], reason: '已经有' }, { label: '宽度择时', verdict: 'caution', flags: ['too_few_obs'], reason: '样本少' }] }] }, [{ question: 'q', options: result.options.filter((o) => o.kind !== 'none').map((o) => ({ label: o.title })) }]);
  const applied = C.applyToOptions(result, lrv);
  check('叠加方案：值得做的排前面、筛掉的排最后（「不加」仍在末尾）', applied.options.map((o) => o.id).join() === 'a,timing,vol,none');
  check('被筛掉的不再标「推荐」', applied.options.find((o) => o.id === 'vol').recommended === false && applied.options.find((o) => o.id === 'timing').recommended === true);
  check('没有审核结论：原样返回', C.applyToOptions(result, null).options.map((o) => o.id).join() === 'a,vol,timing,none');
  check('HELM_CRITIC=0 关闭', C.enabled({ HELM_CRITIC: '0' }) === false && C.enabled({}) === true);
}

/* ---------- 端到端：服务 + 假 claude ---------- */
const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-critic-'));
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
const OUT = path.join(TMP, 'out'); await mkdir(OUT, { recursive: true });
const FAKE = path.join(TMP, 'fake-claude.mjs');
// 审核员调用（runModelOnce：带 --tools ''）回 JSON；智能体调用按消息里的 MODE 提问。
await writeFile(FAKE, `#!${process.execPath}
import { writeFileSync, readFileSync } from 'node:fs';
const a = process.argv.slice(2);
if (a.includes('--version')) { console.log('0.0.0 (fake)'); process.exit(0); }
let prompt = ''; for await (const c of process.stdin) prompt += c;
if (a.includes('--tools')) {
  const mode = readFileSync(process.env.FAKE_OUT + '/mode', 'utf8').trim();
  const opts = ['时序动量', '相对强弱多空', '短期反转'];
  const review = { questions: [{ index: 0, applicable: true, options: opts.map((l, i) => ({ label: l, verdict: mode === 'alldrop' ? 'drop' : i === 0 ? 'drop' : 'keep', flags: ['hindsight'], reason: '三只股票是事后挑选的' })) }], summary: '整体有事后挑选问题', fix: '换成按当时规则选出来的股票池' };
  writeFileSync(process.env.FAKE_OUT + '/critic-input.json', prompt);
  setTimeout(() => { console.log(JSON.stringify({ result: JSON.stringify(review), is_error: false })); }, 300);
} else {
  const emit = (o) => console.log(JSON.stringify(o));
  emit({ type: 'system', subtype: 'init', session_id: 's', model: 'fake' });
  const r = await fetch(process.env.HELM_URL + '/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-helm-token': process.env.HELM_TOKEN },
    body: JSON.stringify({ threadId: process.env.HELM_THREAD_ID, intro: '开工前确认', questions: [{ question: '每天按什么规则决定做多还是做空？', header: '多空信号', options: [{ label: '时序动量' }, { label: '相对强弱多空' }, { label: '短期反转' }] }] }) });
  const j = await r.json();
  writeFileSync(process.env.FAKE_OUT + '/' + process.env.HELM_THREAD_ID + '.json', JSON.stringify(j));
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } });
  emit({ type: 'result', session_id: 's', result: 'ok', total_cost_usd: 0, duration_ms: 1 });
}
`);
await chmod(FAKE, 0o755);
const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT), HELM_PROJECTS_DIR: path.join(TMP, 'projects'), HELM_TRIALS_FILE: path.join(TMP, 'trials.jsonl'), HELM_ALPACA_FILE: path.join(TMP, 'secrets', 'alpaca.json'),
    HELM_THREADS_DIR: path.join(TMP, 'data', 'threads'), HELM_MCP_CONFIG: path.join(TMP, 'mcp.json'), CLAUDE_BIN: FAKE, FAKE_OUT: OUT, HELM_TRANSLATE: '0', HELM_CHANGE_ROOT: path.join(TMP, 'repo') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = ''; server.stdout.on('data', (c) => { log += c; }); server.stderr.on('data', (c) => { log += c; });
const events = [];
try {
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { try { up = (await req('GET', '/api/agents')).status === 200; } catch { await sleep(100); } }
  check('测试服务已启动', up, log.slice(-300));
  const page = await req('GET', '/');
  const TOKEN = (page.text.match(/<meta name="helm-token" content="([a-f0-9]{64})">/) || [])[1];
  const H = { 'X-Helm-UI-Token': TOKEN, Origin: BASE };
  http.get(`${BASE}/api/events`, (res) => { let buf = ''; res.setEncoding('utf8'); res.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); const l = b.split('\n').find((x) => x.startsWith('data: ')); if (l) try { events.push(JSON.parse(l.slice(6))); } catch { /* */ } } }); });
  await sleep(200);

  // 1) 跳过提问：默认避开被筛掉的「时序动量」
  await writeFile(path.join(OUT, 'mode'), 'one');
  const c1 = await req('POST', '/api/chat', { headers: H, body: { agent: 'mia', message: '做一个每天交易英伟达、微软、Meta 的多空策略' } });
  const t1 = c1.json.threadId;
  const reviewed = await until(() => events.find((e) => e.type === 'question_reviewed' && e.threadId === t1));
  check('审核结论推到了网页（question_reviewed）', reviewed && reviewed.review.status === 'done' && reviewed.review.questions[0].options['时序动量'].verdict === 'drop', JSON.stringify(reviewed && reviewed.review).slice(0, 200));
  const qreq = events.find((e) => e.type === 'question_request' && e.question.threadId === t1);
  check('提问先推出去（审核中），不等审核', qreq && qreq.question.review && qreq.question.review.status === 'running');
  const ci = JSON.parse(await readFile(path.join(OUT, 'critic-input.json'), 'utf8'));
  check('审核员看到用户原话和选项，看不到智能体的思路', /英伟达/.test(ci.userRequest) && ci.questions[0].options.length === 3 && !('reasoning' in ci));
  const qs = (await req('GET', '/api/questions')).json.questions;
  await req('POST', `/api/questions/${qs.find((x) => x.threadId === t1).id}`, { headers: H, body: { skip: true } });
  const r1 = await until(async () => { try { return JSON.parse(await readFile(path.join(OUT, `${t1}.json`), 'utf8')); } catch { return null; } });
  check('跳过：智能体收到的默认是「相对强弱多空」并附审核说明', r1 && /相对强弱多空/.test(r1.text) && /审核员/.test(r1.text) && !/每题第一个/.test(r1.text), r1 && r1.text);

  // 2) 全部被筛掉、用户跳过：让智能体停下
  await writeFile(path.join(OUT, 'mode'), 'alldrop');
  const c2 = await req('POST', '/api/chat', { headers: H, body: { agent: 'mia', message: '同样的三只股票再来一次' } });
  const t2 = c2.json.threadId;
  await until(() => events.find((e) => e.type === 'question_reviewed' && e.threadId === t2));
  const qs2 = (await req('GET', '/api/questions')).json.questions;
  await req('POST', `/api/questions/${qs2.find((x) => x.threadId === t2).id}`, { headers: H, body: { skip: true } });
  const r2 = await until(async () => { try { return JSON.parse(await readFile(path.join(OUT, `${t2}.json`), 'utf8')); } catch { return null; } });
  check('全部被筛掉 + 跳过：让智能体不要继续，带上建议', r2 && /不要继续执行/.test(r2.text) && /按当时规则/.test(r2.text), r2 && r2.text);
} catch (e) {
  check('测试本身没有抛异常', false, e.stack);
} finally {
  server.kill('SIGTERM');
  await sleep(300);
  await rm(TMP, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
