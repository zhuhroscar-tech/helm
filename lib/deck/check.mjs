// 汇报的数字核对：模型只写叙述和 {{b1.cagr}} 这样的占位符，数字由这里从 Helm 的数据里填。
// 模型自己写出来、在数据里找不到出处的数字，会被标出来（先交给修改环节，改不掉就在界面上提示）。

export const LAYOUTS = ['exec_summary', 'chart', 'two_charts', 'kpis', 'table', 'bullets', 'divider'];
export const CHARTS = ['equity', 'drawdown', 'annual', 'metric_bars', 'excess_bridge', 'monthly'];
export const TABLES = ['gates', 'compare', 'monthly', 'custom'];
export const METRICS = ['cagr', 'net', 'sharpe', 'maxdd', 'excess', 'vol', 'winrate', 'trades', 'dsr', 'benchCagr', 'benchMaxdd'];
export const LIMITS = { slides: 18, sections: 7, title: 90, bullet: 160, bullets: 6 };

const PH = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
// 数字：可带正负号、千分位、小数、百分号/倍数
const NUM = /[+\-−]?\d[\d,]*(?:\.\d+)?\s*[%x×倍]?/g;

/** 遍历 spec 里所有「给人看的」字符串（跳过引用回测 / 指标的字段） */
const SKIP = new Set(['layout', 'bt', 'bts', 'metric', 'metrics', 'highlight', 'type', 'kind', 'tone', 'verdictTone', 'section', 'emphasis']);
function walk(node, fn, at = '') {
  if (Array.isArray(node)) return node.map((v, i) => walk(v, fn, `${at}[${i}]`));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = SKIP.has(k) ? v : walk(v, fn, at ? `${at}.${k}` : k);
    return out;
  }
  return typeof node === 'string' ? fn(node, at) : node;
}

function norm(s) {
  return String(s).replace(/[,\s]/g, '').replace(/−/g, '-').replace(/倍$/, 'x').replace(/×$/, 'x');
}

/** 允许出现的「数字」：所有 facts 的文字、项目名称 / 规则说明 / 回测名字里出现的数字、年份、小整数 */
function allowedNumbers(pack) {
  const ok = new Set();
  const add = (s) => { for (const m of String(s || '').match(NUM) || []) { ok.add(norm(m)); ok.add(norm(m).replace(/^[+-]/, '')); } };
  for (const f of Object.values(pack.facts || {})) add(f.text);
  add(pack.project?.name); add(pack.project?.description); add(pack.project?.spec);
  for (const b of pack.backtests || []) { add(b.name); add(b.start); add(b.end); for (const g of b.gates || []) { add(g.label); add(g.detail); } }
  for (const p of pack.paper || []) add(p.name);
  for (const r of pack.research || []) { add(r.title); add(r.idea); add(r.verdict); add(r.universe); }
  for (const n of pack.meta?.methodNotes || []) add(n);
  add(pack.meta?.dateText);
  return ok;
}

const CONSTANTS = new Set(['0', '0%', '100', '500', '1000', '2000', '3000', '90%', '95%', '99%', '100%']);

function harmless(raw) {
  const n = norm(raw);
  if (/^(19|20)\d\d$/.test(n)) return true;            // 年份
  if (/^\d{1,2}$/.test(n) && +n <= 12) return true;       // 序号、月份、「三个版本」这类小数目
  if (CONSTANTS.has(n)) return true;                      // 指数名（标普 500、纳斯达克 100）、净值起点 100、置信水平
  return false;
}

/**
 * 填占位符并核对数字。
 * 返回 { spec: 填好数字的版本, issues: [{kind, where, text, detail}] }
 *   kind: unknownFact（占位符在数据里没有）/ rawNumber（数字没有出处）/ schema（结构问题）
 */
export function checkDeck(spec, pack, { audience } = {}) {
  const issues = [];
  const facts = pack.facts || {};
  const ok = allowedNumbers(pack);
  const filled = walk(spec, (s, where) => {
    // 客户版：正文里不出现内部代号（b1 / p2 这类只在来源行和附录里用）
    if (audience === 'client' && !/(^|\.)source$/.test(where)) {
      const code = s.replace(PH, ' ').match(/(?<![A-Za-z0-9_])[bp]\d{1,2}(?![A-Za-z0-9_])/);
      if (code) issues.push({ kind: 'jargon', where, text: s, detail: code[0] });
    }
    const stripped = s.replace(PH, ' ');
    for (const m of stripped.match(NUM) || []) {
      if (harmless(m) || ok.has(norm(m))) continue;
      issues.push({ kind: 'rawNumber', where, text: s, detail: m.trim() });
    }
    return s.replace(PH, (all, key) => {
      const f = facts[key];
      if (!f || f.text == null) { issues.push({ kind: 'unknownFact', where, text: s, detail: key }); return '—'; }
      return f.text;
    });
  });
  // KPI 的 value 是纯数字的地方：必须是占位符或者和数据一致（上面已覆盖），这里不重复
  issues.push(...validateSpec(filled, pack));
  return { spec: filled, issues };
}

/** 结构核对：版式、图表、引用的回测、数量上限。会顺手修正能修的（截断、去掉坏引用）。 */
export function validateSpec(spec, pack) {
  const issues = [];
  const refs = new Set((pack.backtests || []).map((b) => b.ref));
  const bad = (where, detail) => issues.push({ kind: 'schema', where, text: '', detail });
  if (!spec || typeof spec !== 'object') { bad('', 'spec 不是对象'); return issues; }
  if (!spec.title) bad('title', '缺少标题');
  spec.sections = (Array.isArray(spec.sections) ? spec.sections : []).map(String).slice(0, LIMITS.sections);
  const slides = Array.isArray(spec.slides) ? spec.slides : [];
  if (!slides.length) bad('slides', '没有内容页');
  if (slides.length > LIMITS.slides) { bad('slides', `超过 ${LIMITS.slides} 页，多出的已去掉`); slides.length = LIMITS.slides; }
  spec.slides = slides;
  const fixRef = (obj, key, where) => {
    if (obj[key] == null) return;
    if (!refs.has(obj[key])) { bad(where, `引用了不存在的回测 ${obj[key]}`); obj[key] = pack.primary; }
  };
  const fixRefs = (obj, key, where) => {
    if (!Array.isArray(obj[key])) return;
    const keep = obj[key].filter((r) => refs.has(r));
    if (keep.length !== obj[key].length) bad(where, `去掉了不存在的回测 ${obj[key].filter((r) => !refs.has(r)).join(', ')}`);
    obj[key] = keep.length ? keep : [pack.primary];
  };
  const chart = (c, where) => {
    if (!c) return;
    if (!CHARTS.includes(c.type)) { bad(where, `不认识的图表 ${c.type}，改成资金曲线`); c.type = 'equity'; }
    fixRef(c, 'bt', where); fixRefs(c, 'bts', where);
    if (c.type === 'metric_bars' && !METRICS.includes(c.metric)) { bad(where, `不认识的指标 ${c.metric}`); c.metric = 'sharpe'; }
  };
  slides.forEach((s, i) => {
    const at = `slides[${i}]`;
    if (!LAYOUTS.includes(s.layout)) { bad(at, `不认识的版式 ${s.layout}，按要点页画`); s.layout = 'bullets'; }
    if (s.layout !== 'divider' && !s.title) bad(at, '缺少标题');
    if (s.title && s.title.length > LIMITS.title) bad(`${at}.title`, '标题太长');
    if (s.section != null && !(Number.isInteger(s.section) && s.section >= 0 && s.section < spec.sections.length)) s.section = null;
    chart(s.chart, `${at}.chart`);
    chart(s.left?.chart, `${at}.left.chart`);
    chart(s.right?.chart, `${at}.right.chart`);
    if (s.table) {
      if (!TABLES.includes(s.table.kind)) { bad(`${at}.table`, `不认识的表格 ${s.table.kind}`); s.table.kind = 'custom'; }
      fixRef(s.table, 'bt', `${at}.table`); fixRefs(s.table, 'bts', `${at}.table`);
      if (Array.isArray(s.table.metrics)) s.table.metrics = s.table.metrics.filter((m) => METRICS.includes(m));
    }
    for (const key of ['bullets']) if (Array.isArray(s[key])) s[key] = s[key].slice(0, LIMITS.bullets);
    for (const p of [...(s.panels || []), ...(s.columns || [])]) if (Array.isArray(p.bullets)) p.bullets = p.bullets.slice(0, LIMITS.bullets);
  });
  return issues;
}

/** 给修改环节看的问题清单 */
export function describeIssues(issues, lang = 'zh') {
  const zh = lang !== 'en';
  return issues.map((x) => {
    if (x.kind === 'rawNumber') return zh ? `${x.where}：数字「${x.detail}」在数据里找不到出处，改用占位符或删掉（原文：${x.text}）` : `${x.where}: number "${x.detail}" has no source in the data; use a placeholder or drop it (text: ${x.text})`;
    if (x.kind === 'jargon') return zh ? `${x.where}：客户版正文里出现了内部代号「${x.detail}」，改成通俗的名字（比如「验证期版本」）（原文：${x.text}）` : `${x.where}: internal code "${x.detail}" in a client deck; use a plain name such as "the holdout version" (text: ${x.text})`;
    if (x.kind === 'unknownFact') return zh ? `${x.where}：占位符 {{${x.detail}}} 在数据里没有` : `${x.where}: placeholder {{${x.detail}}} is not in the data`;
    return `${x.where}: ${x.detail}`;
  });
}
