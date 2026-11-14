// 交接卡片的查找和取回答：从 public/app.js 原样取出 findChildRun / handoffAnswer 在 vm 里跑（和 calendar.test 同一做法）。
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); if (!cond) failed++; };

// 界面文字走 i18n：把真正的 i18n-dict.js / i18n.js 装进 vm，语言固定中文（这个测试核对的是中文界面）
const i18nGlobals = {};
{
  const g = { navigator: { language: 'zh-CN' }, localStorage: { getItem: () => 'zh', setItem() {}, removeItem() {} } };
  g.window = g; g.globalThis = g; vm.createContext(g);
  for (const f of ['i18n-dict.js', 'i18n.js']) vm.runInContext(await readFile(new URL(`../public/${f}`, import.meta.url), 'utf8'), g);
  Object.assign(i18nGlobals, { HELM_I18N: g.HELM_I18N, _t: g._t, _regT: g._regT, t: g.t });
}
const src = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const a = src.indexOf('function handoffAgent('); const b = src.indexOf('\nfunction toolHTML(');
check('app.js 里能找到交接卡片的查找函数', a > 0 && b > a);

const S = {
  agents: [{ id: 'mia', name: '总控', glyph: '◎', color: '#d4ff4f' }, { id: 'engineer', name: '策略工程师', glyph: '⌘', color: '#6cb6ff' }, { id: 'analyst', name: '分析师', glyph: 'Σ', color: '#c792ea' }],
  openTools: new Set(),
  running: new Map([
    ['c1', { agent: 'engineer', title: '写代码', from: { agent: 'mia', threadId: 'p1' } }],
    ['c2', { agent: 'analyst', title: '诊断', from: { agent: 'mia', threadId: 'p2' } }],
    ['c3', { agent: 'engineer', title: '没有来源的对话', from: null }],
  ]),
};
const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ctx = vm.createContext({ ...i18nGlobals, S, esc, md: (x) => `<p>${esc(x)}</p>` });
vm.runInContext(`${src.slice(a, b)}\nthis.api = { findChildRun, handoffAnswer, handoffHTML };`, ctx);
const { findChildRun, handoffAnswer, handoffHTML } = ctx.api;

check('运行中：按来源对话 + agent 找到对方的对话', JSON.stringify(findChildRun('p1', 'engineer')) === JSON.stringify({ threadId: 'c1', title: '写代码' }));
check('agent 不对：找不到', findChildRun('p1', 'analyst') === null);
check('来源对话不对：找不到', findChildRun('p2', 'engineer') === null);
check('没有来源的对话不会被误认', findChildRun('p1', 'engineer').threadId !== 'c3' && findChildRun(null, 'engineer') === null);
check('wait=true 的结果：取出最终回答', handoffAnswer('策略工程师已完成，threadId=abc。它的最终回答：\n\n结论：通过\n夏普 1.2') === '结论：通过\n夏普 1.2');
check('wait=false 的结果：没有回答可取', handoffAnswer('已交给策略工程师，threadId=abc。对方已经开始工作，用户可以点网站右侧的标签查看。') === '');
check('没有结果：空串', handoffAnswer(null) === '' && handoffAnswer(undefined) === '');

// 同时交给同一个 agent 两次
S.running.set('c4', { agent: 'engineer', title: '回测 AAPL 动量', from: { agent: 'mia', threadId: 'p1' } });
{
  const used = new Set();
  const x = findChildRun('p1', 'engineer', '回测 AAPL 动量策略', used);
  const y = findChildRun('p1', 'engineer', '别的任务', used);
  check('任务文字对得上的优先（即使不是第一个）', x.threadId === 'c4');
  check('第二张卡认走另一个，不重复', y.threadId === 'c1');
  check('都被认走后返回 null', findChildRun('p1', 'engineer', 'x', used) === null);
}

// 卡片渲染
const card = (p, o = {}) => handoffHTML(p, o.parent ?? 'p1', 'mia', o.live ?? true, o.used ?? null);
let h = card({ id: 't1', status: 'running', input: { agent: 'engineer', task: '写代码', wait: true } });
check('运行中 + 找到对方：显示对方标题和打开按钮', h.includes('策略工程师正在处理：') && h.includes('data-open-thread="c1"') && h.includes('class="handoff running"'));
h = card({ id: 't1', status: 'running', input: {} });
check('输入还没写完：不抛错，不显示成总控', h.includes('正在准备交接') && !h.includes('总控 →') && !h.includes('data-open-thread'));
h = card({ id: 't1', status: 'running', input: undefined });
check('input 缺失也不抛错', h.includes('class="handoff running"'));
h = card({ id: 't1', status: 'running', input: { agent: 'engineer', task: 'x', wait: true } }, { live: false });
check('从磁盘读回来仍是 running：画成已中断', h.includes('handoff stopped') && h.includes('已中断') && !h.includes('class="spin"'));
h = card({ id: 't1', status: 'stopped', input: { agent: 'analyst', task: 'x', wait: true }, result: '' });
check('stopped 状态', h.includes('handoff stopped') && h.includes('分析师的任务已中断'));
h = card({ id: 't1', status: 'error', input: { agent: 'analyst', task: 'x' }, result: '错误：<b>坏</b>' });
check('error：显示错误且转义', h.includes('交接失败') && h.includes('&lt;b&gt;坏&lt;/b&gt;') && !h.includes('<b>坏'));
h = card({ id: 't1', status: 'done', input: { agent: 'engineer', task: 't', wait: false }, result: '已交给策略工程师，threadId=2f1c-9a。对方已经开始工作' });
check('wait=false 完成：已交给 + 从结果取 threadId', h.includes('已交给策略工程师') && h.includes('data-open-thread="2f1c-9a"'));
h = card({ id: 't9', status: 'done', input: { agent: 'engineer', task: 't', wait: true }, result: '策略工程师已完成，threadId=ab12。它的最终回答：\n\n<script>x</script>结论' });
check('wait=true 完成：回答在 details 里，经 md 转义，没有裸 script', h.includes('<details class="h-result"') && h.includes('&lt;script&gt;') && !h.includes('<script>'));
S.openTools.add('h-t9');
check('展开状态跟着 S.openTools 保留', card({ id: 't9', status: 'done', input: { agent: 'engineer', task: 't', wait: true }, result: '已完成，threadId=ab12。它的最终回答：\n\n答' }).includes('data-tid="h-t9" open'));
h = card({ id: 't1', status: 'done', input: { agent: '<img src=x onerror=1>', task: '<i>', wait: false } });
check('未知 agent / 任务里的标签被转义', !/<img|<i>/.test(h));
check('卡片里没有内联事件属性', !/<[^>]*\son[a-z]+=/i.test(h));
check('shortTool 能剥掉 mcp__ 前缀（含 - 的服务名）', (() => { const c2 = vm.createContext({}); vm.runInContext(src.match(/const shortTool = .*?;/)[0] + 'this.r=[shortTool("mcp__qc__handoff"),shortTool("mcp__helm-qc__handoff"),shortTool("Read")]', c2); return c2.r.join() === 'handoff,handoff,Read'; })());

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
