// 想法记录：node test/journal.test.mjs（临时目录里造一棵小树）
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadJournal, parseTrials } from '../lib/journal.mjs';

let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); if (!cond) failed++; };
const J = (f, o) => writeFile(f, JSON.stringify(o));

const dir = await mkdtemp(path.join(os.tmpdir(), 'helm-journal-'));
try {
  const P = path.join(dir, 'projects'); const trialsFile = path.join(dir, 'trials.jsonl');
  const bt = async (pid, id, meta) => { const d = path.join(P, String(pid), 'backtests', id); await mkdir(d, { recursive: true }); await J(path.join(d, 'meta.json'), { backtestId: id, projectId: pid, status: 'Completed.', ...meta }); };
  await mkdir(path.join(P, '2001'), { recursive: true });
  await J(path.join(P, '2001', 'project.json'), { projectId: 2001, name: '测试项目 A' });
  await J(path.join(P, '2001', 'holdout_log.json'), [{ backtestId: 'bbbb2222', at: '2026-02-01T00:00:00Z' }]);
  await bt(2001, 'aaaa1111', { name: '开发版', role: 'candidate', period: 'dev', completed: '2026-01-10T00:00:00Z', summary: { sharpeRatio: 0.8 }, mainRejected: ['夏普区间：下限 < 0', '至少 1 年数据：不足'] });
  await bt(2001, 'bbbb2222', { name: '验证版', role: 'main', period: 'holdout', holdoutSeq: 1, completed: '2026-02-01T00:00:00Z', summary: { sharpeRatio: 0.5 } });
  await bt(2001, 'cccc3333', { name: '基准', role: 'benchmark', period: 'dev', completed: '2026-01-11T00:00:00Z' });
  await bt(2001, 'dddd4444', { name: '失败的', role: 'candidate', status: 'Runtime Error', created: '2026-01-12T00:00:00Z' });
  // 想法检验任务 + 结果
  const run = path.join(P, '2001', 'research', 'quant_runs', 'SP500_r260101aaaa');
  await mkdir(run, { recursive: true }); await mkdir(path.join(P, '2001', 'research', 'jobs'), { recursive: true });
  await J(path.join(P, '2001', 'research', 'jobs', 'r260101aaaa.json'), { jobId: 'r260101aaaa', projectId: 2001, mode: 'idea', idea: '低波动股票未来收益更高', created: '2026-01-05T00:00:00Z', runDir: '/不存在的旧路径/SP500_r260101aaaa' });
  await J(path.join(run, 'idea.json'), { factors: [{ name: 'f1', label: '低波动', verdict: 'weak', best_horizon: 20, ic: { 20: { t: 1.4 } } }, { name: 'f2', label: '动量', verdict: 'signal', best_horizon: 60, ic: { 60: { t: 3.2 } } }] });
  await J(path.join(P, '2001', 'research', 'jobs', 'r260101bbbb.json'), { jobId: 'r260101bbbb', projectId: 2001, mode: 'idea', idea: '还在跑的想法', created: '2026-01-06T00:00:00Z', runDir: path.join(P, 'nowhere') });
  // 模拟实盘
  const sd = path.join(P, '2001', 'paper', 'pabcdef123456'); await mkdir(sd, { recursive: true });
  await J(path.join(sd, 'session.json'), { sessionId: 'pabcdef123456', name: '模拟 1', sourceName: '验证版', status: 'active', created: '2026-03-01T00:00:00Z', frozenAt: '2026-02-28' });
  // 第二个项目：只有目录，没有 project.json
  await mkdir(path.join(P, '2002'), { recursive: true });
  // trials：含坏行、重复、已删除回测
  await writeFile(trialsFile, [
    JSON.stringify({ backtestId: 'aaaa1111', projectId: 2001, period: 'dev', window: ['2010-01-01', '2020-01-01'], sharpe: 0.8, at: '2026-01-10T00:00:00Z' }),
    '这不是 JSON', '{"backtestId": ', '',
    JSON.stringify({ backtestId: 'aaaa1111', projectId: 2001, sharpe: 9, at: '2026-01-10T00:00:00Z' }),
    JSON.stringify({ backtestId: 'gone0000', projectId: 2001, period: 'dev', window: ['2011-01-01', '2020-06-01'], sharpe: 0.3, at: '2025-12-01T00:00:00Z' }),
    JSON.stringify({ backtestId: 'far00000', projectId: 2002, period: 'dev', window: ['1990-01-01', '1995-01-01'], sharpe: 0.1, at: '2025-11-01T00:00:00Z' }),
  ].join('\n'));
  const opts = { projectsDir: P, trialsFile, holdoutRegistry: path.join(dir, '没有.json') };

  check('parseTrials：坏行跳过、重复去掉', parseTrials(await (await import('node:fs/promises')).readFile(trialsFile, 'utf8')).length === 3);
  const j = await loadJournal(opts);
  const S = j.summary; const E = j.entries;
  check('回测数 = 3 个有效 + 2 个只剩记录（基准不算）', S.backtests === 5 && S.benchmarks === 1, `${S.backtests}/${S.benchmarks}`);
  check('想法数 = 2', S.ideas === 2);
  check('模拟实盘 = 1', S.paper === 1);
  check('验证期用了 1 次（项目 A）', S.holdout.find((h) => h.projectId === 2001).looks === 1 && S.holdoutLooksTotal === 1);
  check('门槛用的试验次数：总数 3，与最近一次同一段历史 2', S.trials.total === 3 && S.trials.sameHistory === 2, JSON.stringify(S.trials));
  check('来源：没有 qlib 登记表 → null；有 trials', S.sources.holdoutRegistry === null && S.sources.trials === true);
  check('按日期从新到旧', E.every((e, i) => i === 0 || String(E[i - 1].date) >= String(e.date)));
  const get = (id) => E.find((e) => e.id === id);
  const a = get('b:2001:aaaa1111'); const b = get('b:2001:bbbb2222');
  check('开发版：统计检验阶段，没过 2 项，夏普 0.8', a.stage === '统计检验' && /2 项没达标/.test(a.detail) && a.key.value === 0.8 && a.link === '#/p/2001/b/aaaa1111');
  check('验证版：验证期阶段，主版本，验证期第 1 次', b.stage === '验证期' && b.outcome === '主版本' && /第 1 次/.test(b.detail));
  check('基准不出现在列表里', !get('b:2001:cccc3333'));
  check('失败的回测标“没跑完”', get('b:2001:dddd4444').outcome === '没跑完');
  const i1 = get('i:2001:r260101aaaa'); const i2 = get('i:2001:r260101bbbb');
  check('想法检验：取最好的因子（有信号，t=3.2），runDir 失效时按文件名回退', i1.stage === '想法检验' && i1.outcome === '有信号' && i1.key.value === 3.2, JSON.stringify(i1.key));
  check('想法检验没有结果文件 → 未完成，不报错', i2.outcome === '未完成' && i2.key === null);
  const g = get('t:gone0000');
  check('已删除的回测靠 trials 记录保留', g && g.outcome === '已删除' && g.key.value === 0.3 && g.link === null);
  check('模拟实盘条目', get('p:2001:pabcdef123456').stage === '模拟实盘');
  check('没有 project.json 的项目不崩', S.holdout.some((h) => h.projectId === 2002));
  check('阶段计数之和 = 条目数', Object.values(S.byStage).reduce((x, y) => x + y, 0) === S.total);
  // 缓存：来源没变 → 同一个对象；变了 → 重建
  check('缓存：来源没变返回同一份', (await loadJournal(opts)) === j);
  await new Promise((r) => setTimeout(r, 20));
  await writeFile(trialsFile, `${JSON.stringify({ backtestId: 'new00000', projectId: 2001, period: 'dev', window: ['2010-01-01', '2020-01-01'], sharpe: 0.2, at: '2026-04-01T00:00:00Z' })}\n`);
  const j2 = await loadJournal(opts);
  check('缓存：trials 变了就重建', j2 !== j && j2.summary.trials.total === 1);
  // 全部缺失
  const empty = await loadJournal({ projectsDir: path.join(dir, '没有'), trialsFile: path.join(dir, '没有.jsonl'), holdoutRegistry: path.join(dir, '没有.json') });
  check('来源全不存在：空列表，不抛错', empty.entries.length === 0 && empty.summary.total === 0 && empty.summary.sources.trials === false);
  // 500 条上限
  const many = Array.from({ length: 620 }, (_, k) => JSON.stringify({ backtestId: `m${String(k).padStart(6, '0')}`, projectId: 2001, period: 'dev', sharpe: 0.1, at: new Date(Date.UTC(2026, 0, 1, 0, 0, k)).toISOString() })).join('\n');
  await writeFile(trialsFile, many);
  const big = await loadJournal(opts);
  check('最多返回最近 500 条，汇总仍按全部算', big.entries.length === 500 && big.summary.total > 620 && big.entries[0].date > big.entries[499].date);
} finally { await rm(dir, { recursive: true, force: true }); }

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
