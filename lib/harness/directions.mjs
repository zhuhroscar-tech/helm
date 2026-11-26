// 研究方向的账本（纯函数）：总控和研究员可以自己定研究方向，但有上限、要事先登记、换方向要有依据。
// 一条研究线 = 一个根对话和它交接 / 派出去的所有子对话，共用一份账本（服务端存在 data/directions/<根对话 id>.json）。
// 自动研究（lib/autopilot.mjs）有自己的 autopilot_plan，不走这里。
//
// 规则（都在代码里）：
//  - 同一时间只有一个进行中的方向；做完要先 conclude（结论 + 依据）才能登记下一个
//  - 一条研究线最多 MAX_DIRECTIONS 个方向；每个方向 1–HYP_MAX 个事先定好的假设，各自写明怎样算失败
//  - 第二个方向起必须写 whyNew（为什么是不同的收益来源），名字和假设不能和以前的重复
//  - 进行中的方向，想法检验次数不超过「假设数 + 1」（多的 1 次留给公式写错重测）
//  - 结论是「有信号 / 信号弱 / 没有信号」的，这个方向下必须真的跑过检验；没跑过只能记成 abandoned 并写原因
export const MAX_DIRECTIONS = 3;
export const HYP_MAX = 3;
export const OUTCOMES = ['signal', 'weak', 'none', 'abandoned'];
const OUTCOME_ZH = { signal: '有信号', weak: '信号弱', none: '没有信号', abandoned: '放弃（没有检验）' };
const TEST_TOOLS = new Set(['test_idea', 'start_research', 'test_timing_signal']);
const EVIDENCE_TOOLS = new Set(['read_research', 'validate_backtest', 'read_backtest', 'wait_for_backtest', 'research_status']);

const norm = (s) => String(s || '').toLowerCase().replace(/[\s\p{P}]+/gu, '');
const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

export const newLedger = (rootThreadId) => ({ rootThreadId, max: MAX_DIRECTIONS, directions: [], suggestions: [] });
export const active = (l) => l.directions.find((d) => d.status === 'active') || null;
export const testCap = (d) => d.hypotheses.length + 1;

/** 进行中的方向下，想法检验之前的检查。返回拒绝原因或 null */
export function guardTest(ledger, tool) {
  const d = ledger && active(ledger);
  if (!d || tool !== 'test_idea') return null;
  return d.tests >= testCap(d)
    ? `方向「${d.name}」登记了 ${d.hypotheses.length} 个假设，想法检验已经做了 ${d.tests} 次（上限 ${testCap(d)} 次）：用 research_direction(action=conclude) 写下这个方向的结论，不要继续换公式试。`
    : null;
}
/** 工具成功之后记到进行中的方向上。返回账本有没有变 */
export function noteTool(ledger, tool, isError) {
  const d = ledger && active(ledger);
  if (!d || isError) return false;
  if (TEST_TOOLS.has(tool)) { d.tests += 1; return true; }
  if (EVIDENCE_TOOLS.has(tool)) { d.evidence += 1; return d.evidence === 1; }
  return false;
}

/**
 * 执行一次 research_direction。mode：decide（总控、研究员）/ suggest（工程师、分析师、风控）/ read（子 agent）
 * 返回 { error } 或 { text, changed }
 */
export function apply(ledger, action, args = {}, { by = '', threadId = '', mode = 'read', now = Date.now() } = {}) {
  const cur = active(ledger);
  if (action === 'read') return { text: ledgerText(ledger), changed: false };
  if (action === 'suggest') {
    if (mode === 'read') return { error: '子 agent 不能提研究方向的建议：写在你的结论里。' };
    const text = clean(args.text || args.thesis, 600);
    if (text.length < 10) return { error: 'suggest 要带 text：一两句话说清建议研究什么、为什么。' };
    ledger.suggestions.push({ by, threadId, text, at: now });
    ledger.suggestions = ledger.suggestions.slice(-20);
    return { text: '已记下这条建议，由总控或研究员决定要不要做。你继续完成手上的任务。', changed: true };
  }
  if (mode !== 'decide') return { error: '你不决定研究方向：可以用 action=read 看、用 action=suggest 提建议，由总控或研究员决定。' };
  if (action === 'conclude') {
    if (!cur) return { error: '没有进行中的方向。' };
    if (!OUTCOMES.includes(args.outcome)) return { error: `conclude 要带 outcome：${OUTCOMES.join(' / ')}` };
    const evidence = clean(args.evidence, 1200);
    if (evidence.length < 20) return { error: 'conclude 要带 evidence：照抄工具结果里的关键数字（IC、t 值、检验结论、backtestId / jobId），或者写明为什么没法检验。' };
    if (args.outcome !== 'abandoned' && cur.tests + cur.evidence === 0) return { error: `方向「${cur.name}」下还没有跑过任何检验，不能写成「${OUTCOME_ZH[args.outcome]}」。先按登记的假设去检验；确实没法检验（比如拿不到数据）就用 outcome=abandoned 并写明原因。` };
    Object.assign(cur, { status: 'closed', outcome: args.outcome, evidenceText: evidence, closedAt: now, closedBy: by });
    const left = ledger.max - ledger.directions.length;
    return { text: `方向「${cur.name}」已结束：${OUTCOME_ZH[args.outcome]}。${left > 0 ? `还可以再登记 ${left} 个方向（要写 whyNew：为什么是不同的收益来源）；没有更好的方向就停下汇总。` : '方向数已经用完：停下汇总，照实告诉用户找到了什么、没找到什么。'}`, changed: true };
  }
  if (action !== 'set') return { error: 'action 只能是 read / set / conclude / suggest' };
  if (cur) return { error: `方向「${cur.name}」还在进行中：先用 action=conclude 写下它的结论和依据，才能登记下一个。` };
  if (ledger.directions.length >= ledger.max) return { error: `这条研究线的方向数已经用完（最多 ${ledger.max} 个）：停下汇总，照实告诉用户。` };
  const name = clean(args.name, 80);
  const thesis = clean(args.thesis, 800);
  const hyps = (Array.isArray(args.hypotheses) ? args.hypotheses : []).map((x) => ({ title: clean(x && x.title, 200), failIf: clean(x && x.failIf, 300) }));
  if (name.length < 2) return { error: 'set 要带 name（方向名，比如「财报质量变化」）。' };
  if (thesis.length < 20) return { error: 'set 要带 thesis：经济逻辑，为什么这个方向应该有效、钱是从谁那里赚的。' };
  if (!hyps.length || hyps.length > HYP_MAX) return { error: `hypotheses 要 1–${HYP_MAX} 个：检验之前定好，不能边看结果边加。` };
  if (hyps.some((x) => !x.title || !x.failIf)) return { error: '每个假设都要有 title（一句话）和 failIf（怎样算失败）。' };
  if (ledger.directions.length) {
    if (clean(args.whyNew, 600).length < 20) return { error: '换方向要写 whyNew：为什么是不同的收益来源，而不是上一个想法换参数 / 窗口 / 股票池。' };
    if (ledger.directions.some((d) => norm(d.name) === norm(name))) return { error: `方向「${name}」已经做过，不能再做一次。` };
    const seen = new Set(ledger.directions.flatMap((d) => d.hypotheses.map((x) => norm(x.title))));
    const dup = hyps.find((x) => seen.has(norm(x.title)));
    if (dup) return { error: `假设「${dup.title.slice(0, 60)}」已经登记过，不能再做一次。` };
  }
  if (new Set(hyps.map((x) => norm(x.title))).size !== hyps.length) return { error: '有两个假设是一样的。' };
  const d = { n: ledger.directions.length + 1, name, thesis, whyNew: clean(args.whyNew, 600), data: clean(args.data, 300), hypotheses: hyps,
    status: 'active', outcome: null, evidenceText: '', tests: 0, evidence: 0, by, threadId, at: now, closedAt: null };
  ledger.directions.push(d);
  return { text: `已登记第 ${d.n} 个方向「${name}」（最多 ${ledger.max} 个），${hyps.length} 个假设，想法检验最多 ${testCap(d)} 次。按登记的假设依次检验，不换题、不加题；做完用 action=conclude 写结论和依据。`, changed: true };
}

export function ledgerText(ledger) {
  const lines = [`研究方向账本：已用 ${ledger.directions.length} / ${ledger.max} 个方向。`];
  for (const d of ledger.directions) {
    lines.push(`\n${d.n}. ${d.name}（${d.status === 'active' ? '进行中' : `已结束：${OUTCOME_ZH[d.outcome] || d.outcome}`}；登记人 ${d.by}；想法检验 ${d.tests} / ${testCap(d)} 次）`);
    lines.push(`   逻辑：${d.thesis}`);
    if (d.whyNew) lines.push(`   为什么是新的：${d.whyNew}`);
    for (const h of d.hypotheses) lines.push(`   - 假设：${h.title}｜算失败：${h.failIf}`);
    if (d.evidenceText) lines.push(`   依据：${d.evidenceText}`);
  }
  if (!ledger.directions.length) lines.push('还没有登记过方向。');
  if (ledger.suggestions.length) {
    lines.push('\n其他 agent 提的建议（还没决定做不做）：');
    for (const s of ledger.suggestions.slice(-8)) lines.push(`- ${s.by}：${s.text}`);
  }
  return lines.join('\n');
}

export const view = (ledger) => ({ rootThreadId: ledger.rootThreadId, max: ledger.max, directions: ledger.directions, suggestions: ledger.suggestions });
