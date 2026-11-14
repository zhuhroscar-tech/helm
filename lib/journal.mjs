// 想法记录：把想法检验、回测、验证期、模拟实盘按时间排成一张表。
// 只读、只汇报已经保存下来的数字，不在这里算任何新的统计量。来源缺失时跳过，不报错。
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const STAGES = ['想法检验', '开发期回测', '统计检验', '验证期', '模拟实盘'];
export const MAX_ENTRIES = 500;

const readJson = async (f, dflt = null) => { try { return JSON.parse(await readFile(f, 'utf8')); } catch { return dflt; } };
const mtime = async (f) => { try { return (await stat(f)).mtimeMs; } catch { return null; } };
const ls = async (d) => { try { return await readdir(d); } catch { return []; } };
const num = (x) => (Number.isFinite(x) ? x : null);

// trials.jsonl：每行一个 JSON，坏行直接跳过；同一个 backtestId 只留第一条（和 engine.mjs 一致）
export function parseTrials(text) {
  const seen = new Map();
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try { const t = JSON.parse(line); if (t && t.backtestId && !seen.has(t.backtestId)) seen.set(t.backtestId, t); } catch { /* 跳过坏行 */ }
  }
  return [...seen.values()];
}

// 和 engine.mjs 的 sameHistory 同一口径：两个日期区间重叠 ≥ 较短那段的一半
function sameHistory(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const d = (s) => Date.parse(`${s}T00:00:00Z`) / 86400000;
  const overlap = Math.min(d(a[1]), d(b[1])) - Math.max(d(a[0]), d(b[0]));
  const shorter = Math.min(d(a[1]) - d(a[0]), d(b[1]) - d(b[0]));
  return shorter > 0 && overlap >= shorter / 2;
}

async function scanSources(o) {
  const pids = (await ls(o.projectsDir)).filter((n) => /^\d+$/.test(n)).sort((a, b) => a - b);
  const src = { pids, projects: [] };
  for (const pid of pids) {
    const base = path.join(o.projectsDir, pid);
    const p = { pid, base, backtests: await ls(path.join(base, 'backtests')), jobs: [], sessions: await ls(path.join(base, 'paper')) };
    p.jobs = (await ls(path.join(base, 'research', 'jobs'))).filter((f) => /^r[0-9a-z]{6,24}\.json$/.test(f));
    p.runs = await ls(path.join(base, 'research', 'quant_runs'));
    src.projects.push(p);
  }
  return src;
}

async function signature(o, src) {
  const parts = [`t${await mtime(o.trialsFile)}`, `r${await mtime(o.holdoutRegistry)}`];
  for (const p of src.projects) {
    parts.push(p.pid, await mtime(path.join(p.base, 'project.json')), await mtime(path.join(p.base, 'holdout_log.json')));
    for (const b of p.backtests) parts.push(await mtime(path.join(p.base, 'backtests', b, 'meta.json')));
    for (const j of p.jobs) parts.push(j, await mtime(path.join(p.base, 'research', 'jobs', j)));
    // 想法检验的结果 idea.json 是引擎在任务文件不再变化之后才写的，要单独算进签名，否则跑完了还显示「未完成」
    for (const r of p.runs) parts.push(r, await mtime(path.join(p.base, 'research', 'quant_runs', r, 'idea.json')));
    for (const s of p.sessions) parts.push(s, await mtime(path.join(p.base, 'paper', s, 'session.json')));
  }
  return parts.join('|');
}

const IDEA_ORDER = { signal: 2, weak: 1, none: 0 };
const IDEA_ZH = { signal: '有信号', weak: '信号弱', none: '没有信号' };

async function ideaEntry(p, jobFile, name) {
  const job = await readJson(path.join(p.base, 'research', 'jobs', jobFile));
  if (!job || job.mode !== 'idea') return null;
  // runDir 里记的是当时的绝对路径；项目目录挪过的话按文件名在本项目里找
  const runs = [job.runDir, job.runDir && path.join(p.base, 'research', 'quant_runs', path.basename(job.runDir))].filter(Boolean);
  let res = null;
  for (const r of runs) { res = await readJson(path.join(r, 'idea.json')); if (res) break; }
  const facs = res && Array.isArray(res.factors) ? res.factors : [];
  const best = facs.slice().sort((a, b) => (IDEA_ORDER[b.verdict] ?? -1) - (IDEA_ORDER[a.verdict] ?? -1))[0];
  const bh = best && best.best_horizon != null ? String(best.best_horizon) : null;
  const t = best && best.ic && bh && best.ic[bh] ? num(best.ic[bh].t) : null;
  const label = best && IDEA_ZH[best.verdict] ? IDEA_ZH[best.verdict] : null;
  return {
    id: `i:${p.pid}:${job.jobId}`, kind: 'idea', date: job.created || null, projectId: Number(p.pid), projectName: name,
    what: String(job.idea || job.title || job.jobId).slice(0, 200),
    detail: facs.length ? `${facs.length} 个因子${best && best.label ? ` · 最好：${String(best.label).slice(0, 40)}` : ''}${bh ? ` · ${bh} 日` : ''}` : (res ? '没有因子结果' : '还没有结果'),
    stage: '想法检验', outcome: label || '未完成', outcomeCode: best ? best.verdict : 'pending',
    key: t != null ? { label: 'IC t 值', value: t } : null,
    link: `#/p/${p.pid}/r/${job.jobId}`,
  };
}

async function build(o, src) {
  const trials = parseTrials(await readFile(o.trialsFile, 'utf8').catch(() => ''));
  const trialById = new Map(trials.map((t) => [t.backtestId, t]));
  const hoReg = await readJson(o.holdoutRegistry, null);
  const entries = []; const holdout = []; const seenBt = new Set(); const names = new Map();
  const counts = { ideas: 0, backtests: 0, paper: 0, benchmarks: 0, failed: 0 };

  for (const p of src.projects) {
    const proj = await readJson(path.join(p.base, 'project.json'), {});
    const name = proj.name || `项目 #${p.pid}`;
    names.set(Number(p.pid), name);
    const hlog = await readJson(path.join(p.base, 'holdout_log.json'), []);
    const hoIds = new Set((Array.isArray(hlog) ? hlog : []).map((x) => x && x.backtestId));
    holdout.push({ projectId: Number(p.pid), name, looks: hoIds.size });

    for (const b of p.backtests) {
      const m = await readJson(path.join(p.base, 'backtests', b, 'meta.json'));
      if (!m || !m.backtestId) continue;
      seenBt.add(m.backtestId);
      if (m.ranAsBenchmark || m.role === 'benchmark') { counts.benchmarks++; continue; }
      const done = /Completed/.test(m.status || '');
      const rejected = Array.isArray(m.mainRejected) ? m.mainRejected.length : 0;
      const holdoutUsed = m.period === 'holdout' || hoIds.has(m.backtestId);
      let stage = '开发期回测';
      if (holdoutUsed && m.period === 'holdout') stage = '验证期';
      else if (m.role === 'main' || rejected) stage = '统计检验';
      let outcome = m.role === 'main' ? '主版本' : m.role === 'debug' ? '调试' : m.role === 'control' ? '对照' : m.role === 'ablation' ? '消融' : '候选';
      // 还在排队 / 运行的不算失败：只有出错结束的才算「没跑完」
      const running = /Queue|Progress/.test(m.status || '');
      if (!done) { outcome = running ? '运行中' : '没跑完'; if (!running) counts.failed++; }
      const bits = [];
      if (m.role === 'main' && m.mainBy === 'user') bits.push('你选定的主版本'); else if (rejected) bits.push(`没过统计检验（${rejected} 项没达标）`); else if (m.role === 'main') bits.push('已通过统计检验');
      if (m.period === 'holdout') bits.push(`验证期第 ${m.holdoutSeq || '?'} 次`);
      else if (holdoutUsed) bits.push('用过验证期');
      if (m.file && m.file !== 'main.py') bits.push(m.file);
      const sharpe = num(m.summary && m.summary.sharpeRatio) ?? num(trialById.get(m.backtestId) && trialById.get(m.backtestId).sharpe);
      counts.backtests++;
      entries.push({
        id: `b:${p.pid}:${m.backtestId}`, kind: 'backtest', date: m.completed || m.created || null, projectId: Number(p.pid), projectName: name,
        what: String(m.name || m.backtestId).slice(0, 200), detail: bits.join(' · '),
        stage, outcome, outcomeCode: m.role || 'candidate', period: m.period || null,
        key: sharpe != null ? { label: '夏普', value: sharpe } : null,
        link: `#/p/${p.pid}/b/${m.backtestId}`,
      });
    }

    for (const jf of p.jobs) {
      const e = await ideaEntry(p, jf, name);
      if (e) { counts.ideas++; entries.push(e); }
    }

    for (const sid of p.sessions) {
      const s = await readJson(path.join(p.base, 'paper', sid, 'session.json'));
      if (!s || !s.sessionId) continue;
      counts.paper++;
      entries.push({
        id: `p:${p.pid}:${s.sessionId}`, kind: 'paper', date: s.created || null, projectId: Number(p.pid), projectName: name,
        what: `${s.name || s.sessionId}（来自 ${s.sourceName || '回测'}）`,
        detail: `${s.status === 'active' ? '进行中' : '已停止'}${s.frozenAt ? ` · 冻结 ${s.frozenAt}` : ''}`,
        stage: '模拟实盘', outcome: s.status === 'active' ? '进行中' : '已停止', outcomeCode: s.status || 'unknown', key: null,
        link: `#/p/${p.pid}/s/${s.sessionId}`,
      });
    }
  }

  // 回测已经被删、但尝试记录还在：照样算一次尝试（去膨胀夏普就是这样数的）
  for (const t of trials) {
    if (seenBt.has(t.backtestId)) continue;
    if (t.source === 'tune') { counts.tune = (counts.tune || 0) + 1; continue; } // 调参候选：只计入尝试次数，不单独列一行
    counts.backtests++;
    const pid = Number(t.projectId);
    entries.push({
      id: `t:${t.backtestId}`, kind: 'backtest', date: t.at || null, projectId: Number.isFinite(pid) ? pid : null, projectName: names.get(pid) || (Number.isFinite(pid) ? `项目 #${pid}` : '—'),
      what: `已删除的回测 ${String(t.backtestId).slice(0, 6)}`, detail: '回测文件已删除，只剩尝试记录',
      stage: t.period === 'holdout' ? '验证期' : '开发期回测', outcome: '已删除', outcomeCode: 'deleted', period: t.period || null,
      key: num(t.sharpe) != null ? { label: '夏普', value: t.sharpe } : null, link: null,
    });
  }

  entries.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const byStage = Object.fromEntries(STAGES.map((s) => [s, 0]));
  for (const e of entries) byStage[e.stage]++;

  // 门槛用的试验次数：全局尝试总数，以及和「最近一次尝试」同一段历史的次数（去膨胀夏普按这个数）
  const last = trials.filter((t) => t.window).sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
  const summary = {
    ideas: counts.ideas, backtests: counts.backtests, paper: counts.paper, benchmarks: counts.benchmarks, failed: counts.failed, tuneTrials: counts.tune || 0,
    byStage, holdout,
    holdoutLooksTotal: holdout.reduce((s, h) => s + h.looks, 0),
    trials: { total: trials.length, sameHistory: last ? trials.filter((t) => t.backtestId === last.backtestId || sameHistory(t.window, last.window)).length : null, window: last ? last.window : null },
    sources: { trials: trials.length > 0, projects: src.pids.length, ideaJobs: counts.ideas, holdoutRegistry: Array.isArray(hoReg) ? hoReg.filter((r) => !r.synthetic_null_test).length : null },
    total: entries.length,
  };
  return { summary, entries: entries.slice(0, MAX_ENTRIES) };
}

const CACHE = new Map();
export function defaults() {
  // fileURLToPath：路径里有空格或中文时，URL 的 pathname 是百分号编码的，会找不到项目目录
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  return {
    projectsDir: process.env.HELM_PROJECTS_DIR || path.join(root, 'projects'),
    trialsFile: process.env.HELM_TRIALS_FILE || path.join(root, 'data', 'trials.jsonl'),
    holdoutRegistry: path.join(os.homedir(), '.qlib', 'qs_cache', 'holdout_registry.json'),
  };
}

export async function loadJournal(opts = {}) {
  const o = { ...defaults(), ...opts };
  const src = await scanSources(o);
  const sig = await signature(o, src);
  const key = `${o.projectsDir}|${o.trialsFile}|${o.holdoutRegistry}`;
  const hit = CACHE.get(key);
  if (hit && hit.sig === sig) return hit.value;
  const value = await build(o, src);
  CACHE.set(key, { sig, value });
  return value;
}
