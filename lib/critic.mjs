// Helm · 审核员：智能体给出的选项（开工前的提问、叠加一层的方案）在给用户看之前，由一个独立的模型调用逐个审。
//
// - 独立：只看选项本身和项目事实（用户原话、规则说明、之前的检验结论），看不到出选项的智能体是怎么想的。
// - 事前判断：不跑回测、不看数据。先把每个选项都回测一遍再挑最好的，等于多重检验，所以审核不占尝试次数，
//   也只能判断「值不值得测」，不能判断「会不会赚钱」。
// - 每个选项：keep（值得做）/ caution（可以做，但有要说明的问题）/ drop（不值得做）+ 问题代码 + 一句理由；
//   整组：noneWorth（全部都不值得做）+ 怎么改才值得测。
// - 不是研究选择的提问（项目名用中文还是英文、要不要现在开始）标 applicable: false，不审。
// - 出错、超时就不审（选项照常显示），不挡流程。
import { extractJson } from './deck/pipeline.mjs';

export const FLAGS = {
  hindsight: { zh: '事后挑选', en: 'Hindsight selection', d: 'picks assets, periods or rules using knowledge of what later did well (e.g. backtesting today\'s winners over the years they won)' },
  no_logic: { zh: '没有经济逻辑', en: 'No economic logic', d: 'no plausible reason why it should earn a return or reduce risk' },
  duplicate: { zh: '重复已有暴露', en: 'Duplicate exposure', d: 'just more of an exposure the strategy already has (market beta, momentum) or a known factor renamed' },
  tested_none: { zh: '已测过没信号', en: 'Already tested, no signal', d: 'the same or a re-worded idea already came back "no signal" in this project' },
  data_gap: { zh: '数据不够', en: 'Data gap', d: 'needs data Helm does not have, or only with survivorship bias (no point-in-time membership)' },
  too_few_obs: { zh: '样本太少', en: 'Too few observations', d: 'too few independent decisions or assets to ever show significance' },
  costs: { zh: '成本吃掉收益', en: 'Costs', d: 'turnover, shorting or borrow costs likely exceed the edge' },
  overfit: { zh: '过拟合风险', en: 'Overfitting risk', d: 'many free parameters or many variants to try' },
  lookahead: { zh: '可能有前视', en: 'Possible look-ahead', d: 'the rule as described would use information not available at the time' },
  other: { zh: '其他', en: 'Other', d: 'anything else important' },
};
const VERDICTS = new Set(['keep', 'caution', 'drop']);
export const enabled = (env = process.env) => env.HELM_CRITIC !== '0';

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export function criticPrompt(lang = 'zh') {
  const L = lang === 'en' ? 'English' : '简体中文';
  return `You are Helm's independent reviewer for quantitative research choices. Another agent wrote some options for the user to choose from; you did not write them and you cannot see its reasoning. Judge each option BEFORE any data is looked at: is it worth testing at all?

You must NOT judge by guessing which option would make the most money; that can only be learned by testing, and testing every option to pick the best is multiple testing. Judge only by the checklist below and the facts given (the user's request, the project's spec, earlier test results).

Checklist (use these codes):
${Object.entries(FLAGS).map(([k, v]) => `- ${k}: ${v.d}`).join('\n')}

Verdicts:
- keep: worth testing as described.
- caution: worth testing, but the user should know a specific problem.
- drop: not worth testing as described (a checklist problem makes any result untrustworthy or the idea pointless).
A problem shared by ALL options (for example the whole universe was picked with hindsight) applies to every option: then set "noneWorth": true and say in "fix" what would make the question worth testing.
Questions that are not research choices (naming, language, whether to start now, formatting) get "applicable": false and no option reviews.
Be strict but fair: most reasonable, standard options should be keep or caution. Never invent facts.

Reply with ONE JSON object only, all text in ${L}:
{"questions":[{"index":0,"applicable":true,"options":[{"label":"exact option label","verdict":"keep|caution|drop","flags":["code"],"reason":"one sentence"}]}],
 "noneWorth":false,"summary":"one or two sentences overall","fix":"if noneWorth: what to change so it becomes worth testing, else empty"}`;
}

/** 审核的输入材料（截断）。items: [{ question, header?, options: [{label, description}] }]。同步函数。 */
export function buildInput({ kind = 'ask', intro = '', items = [], request = '', project = null, spec = '', priorIdeas = [], facts = null } = {}) {
  return {
    kind,
    userRequest: clip(request, 1500),
    intro: clip(intro, 600),
    project: project ? { name: clip(project.name, 120), description: clip(project.description, 800) } : null,
    spec: String(spec || '').slice(0, 4000),
    earlierTests: priorIdeas.slice(-6),
    facts: facts || null,
    questions: items.map((q, i) => ({ index: i, header: clip(q.header, 20), question: clip(q.question, 400), options: (q.options || []).map((o) => ({ label: clip(o.label, 80), description: clip(o.description, 400) })) })),
  };
}

/**
 * 整理模型输出：只接受给定选项的 label，未知的代码丢掉。items 同 buildInput。同步函数。
 * 返回 { questions: [{ applicable, options: { [label]: { verdict, flags, reason } } }], noneWorth, summary, fix }。
 */
export function sanitizeReview(raw, items = [], lang = 'zh') {
  const qs = items.map((q, i) => {
    const r = raw && Array.isArray(raw.questions) ? raw.questions.find((x) => x && Number(x.index) === i) || raw.questions[i] : null;
    const applicable = Boolean(r && r.applicable !== false && Array.isArray(r.options));
    const options = {};
    if (applicable) {
      for (const o of q.options || []) {
        const m = r.options.find((x) => x && clip(x.label, 80) === clip(o.label, 80));
        if (!m) continue;
        const verdict = VERDICTS.has(m.verdict) ? m.verdict : 'caution';
        const flags = (Array.isArray(m.flags) ? m.flags : []).map(String).filter((f) => f in FLAGS).slice(0, 4);
        options[o.label] = { verdict, flags, reason: clip(m.reason, 240) };
      }
    }
    return { applicable: applicable && Object.keys(options).length > 0, options };
  });
  const reviewed = qs.filter((q) => q.applicable);
  // 「全部都不值得做」只在真的审了、而且审过的选项全是 drop 时成立（模型说 noneWorth 但又有 keep 的，以逐项为准）
  const allDrop = reviewed.length > 0 && reviewed.every((q) => Object.values(q.options).every((o) => o.verdict === 'drop'));
  return { questions: qs, noneWorth: allDrop, summary: clip(raw && raw.summary, 400), fix: allDrop ? clip(raw && raw.fix, 400) : '', lang };
}

/** 跑一次审核：runModel({ system, input, model }) → 文本。出错返回 null（不审）。 */
export async function review({ input, items, lang = 'zh', runModel, model = process.env.HELM_CRITIC_MODEL || 'sonnet', timeoutMs = 120000 }) {
  if (!items.length) return null;
  const system = criticPrompt(lang);
  const call = async (extra = '') => extractJson(await runModel({ system, input: JSON.stringify(input) + extra, model, timeoutMs }));
  try {
    let raw;
    try { raw = await call(); } catch (e) {
      if (!/JSON/i.test(String(e && e.message))) throw e;
      raw = await call('\n\nYour previous reply was not valid JSON. Reply with the JSON object only.');
    }
    return { ...sanitizeReview(raw, items, lang), at: new Date().toISOString(), model };
  } catch { return null; }
}

/** 某题默认选哪个：第一个没被筛掉的选项；全部被筛掉返回 null。同步函数。 */
export function defaultPick(question, rq) {
  const opts = question.options || [];
  if (!rq || !rq.applicable) return opts[0] ? opts[0].label : null;
  const ok = opts.find((o) => !rq.options[o.label] || rq.options[o.label].verdict !== 'drop');
  return ok ? ok.label : null;
}

const flagText = (flags, lang) => flags.map((f) => FLAGS[f][lang === 'en' ? 'en' : 'zh']).join(lang === 'en' ? ', ' : '、');

/**
 * 给交出提问的智能体的补充说明（中文，智能体提示词是中文）：
 *  - 用户选了被筛掉 / 有保留的选项：照用户的选择做，但要在总结里说明风险；
 *  - 跳过或超时：默认用第一个没被筛掉的选项；全部被筛掉就不要继续执行。
 * 返回 { note, defaults: [label|null] }。同步函数。
 */
export function agentNote(q, rv, { skipped = false } = {}) {
  if (!rv) return { note: '', defaults: q.questions.map((qq) => (qq.options[0] ? qq.options[0].label : null)) };
  const defaults = q.questions.map((qq, i) => defaultPick(qq, rv.questions[i]));
  const lines = [];
  if (rv.noneWorth) {
    lines.push(`审核员认为这组选项都不值得照原样做：${rv.summary || ''}${rv.fix ? ` 建议：${rv.fix}` : ''}`);
    if (skipped) lines.push('用户没有选：不要继续执行，先向用户说明审核员的意见，并给出改过之后值得测的做法（可以再用 ask_user 问）。');
    else lines.push('用户仍然做了选择：照用户的选择做，但在最终总结里明确写出审核员指出的问题。');
    return { note: lines.join('\n'), defaults };
  }
  q.questions.forEach((qq, i) => {
    const rq = rv.questions[i];
    if (!rq || !rq.applicable) return;
    const chosen = skipped ? [defaults[i]].filter(Boolean) : ((q.answers && q.answers[i] && q.answers[i].selected) || []);
    for (const label of chosen) {
      const o = rq.options[label];
      if (o && o.verdict !== 'keep') lines.push(`「${label}」审核员标为${o.verdict === 'drop' ? '不值得做' : '有保留'}（${flagText(o.flags, 'zh') || '其他'}）：${o.reason}。照用户的选择做，但在总结里说明这一点。`);
    }
    if (skipped && defaults[i] && qq.options[0] && defaults[i] !== qq.options[0].label) lines.push(`第 ${i + 1} 题：推荐的第一个选项被审核员筛掉了，默认改用「${defaults[i]}」。`);
  });
  return { note: lines.length ? `审核员意见：\n${lines.join('\n')}` : '', defaults };
}

/** 叠加一层的方案：把审核结论贴到每个方案上并重新排序（被筛掉的排到「不加这一层」前面最后）。同步函数。 */
export function applyToOptions(result, rv) {
  if (!rv || !rv.questions[0] || !rv.questions[0].applicable) return { ...result, review: rv ? { summary: rv.summary, noneWorth: false, fix: '' } : null };
  const rq = rv.questions[0];
  const opts = result.options.map((o) => {
    if (o.kind === 'none') return o;
    const r = rq.options[o.title] || null;
    return { ...o, review: r, recommended: Boolean(o.recommended && !(r && r.verdict === 'drop')) };
  });
  const none = opts.filter((o) => o.kind === 'none');
  const live = opts.filter((o) => o.kind !== 'none');
  const rank = (o) => (o.review ? { keep: 0, caution: 1, drop: 2 }[o.review.verdict] : 1);
  live.sort((a, b) => rank(a) - rank(b));
  const allDrop = live.length > 0 && live.every((o) => o.review && o.review.verdict === 'drop');
  return { ...result, options: [...live, ...none], review: { summary: rv.summary, noneWorth: allDrop, fix: allDrop ? rv.fix : '' } };
}
