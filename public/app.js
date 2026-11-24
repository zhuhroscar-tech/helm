'use strict';

/* ================= helpers ================= */
const $ = (s, r = document) => r.querySelector(s);
const LOC = () => HELM_I18N.locale(); // 数字 / 日期格式跟随界面语言（zh-CN / en-US）
const parenRe = () => (HELM_I18N.lang() === 'zh' ? /（.*?）/g : /\s*\([^)]*\)/g); // 图例短标签：去掉括号里的补充说明
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// 把系统原始报错里的英文片段换成人话（找不到程序等）
let zhErr; _regT(() => { zhErr = (s) => String(s ?? '').replace(/spawn\s+(\S+)\s+ENOENT/g, _t('k0001')).replace(/\bENOENT\b/g, _t('k0002')).replace(/\bEACCES\b/g, _t('k0003')); });
const store = {
  get(k, d) { try { const v = localStorage.getItem(`helm.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`helm.${k}`, JSON.stringify(v)); } catch { /* 隐私模式等情况忽略 */ } },
};
const narrow = () => window.matchMedia('(max-width: 760px)').matches;

// 服务器每次启动生成的页面令牌（注入在 index.html 的 meta 里），所有会改状态的请求都要带上
const UI_TOKEN = document.querySelector('meta[name="helm-token"]')?.content || '';
async function api(path, opts = {}) {
  let r;
  try {
    r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', 'X-Helm-UI-Token': UI_TOKEN, 'X-Helm-Lang': HELM_I18N.lang(), ...(opts.headers || {}) } });
  } catch (e) {
    // 浏览器的原始报错（Failed to fetch）对用户没用，换成能照着做的说法
    throw new Error(_t('k0004'));
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    // 服务重启后旧页面的令牌失效：所有数据请求都被拒，页面只剩灰色占位条。明确提示刷新（不自动消失）
    if (r.status === 403 && /页面令牌|UI token/i.test(j.error || '') && !api.staleWarned) {
      api.staleWarned = true;
      toast(_t('k0005'), { label: _t('k0006'), run: () => location.reload(), sticky: true });
    }
    // 错误体有两种形状：{ error: '…' }（校验 / 权限）和 { success:false, errors:['…'] }（业务）
    throw new Error(j.error || (Array.isArray(j.errors) && j.errors.length ? j.errors.join(_t('k0007')) : '') || `${_t('k0008', { status: r.status })}`);
  }
  return j;
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });
// 所有读取 / 动作都走这两个：失败统一成 { success:false, errors:[…] }，调用方不用再各写一遍 catch
const safePost = (path, body) => post(path, body).catch((e) => ({ success: false, errors: [e.message] }));
const data = (ep, body = {}) => safePost(`/api/data/${ep}`, body);
const dget = (ep, q) => api(`/api/data/${ep}?${new URLSearchParams(q)}`).catch((e) => ({ success: false, errors: [e.message] }));

// 读取 SSE 流（fetch 版，便于中止）
async function readSSE(url, onEvent, signal) {
  const res = await fetch(url, { signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (line) { try { onEvent(JSON.parse(line.slice(6))); } catch { /* 坏包 */ } }
    }
  }
}

function parseDate(s) {
  if (s == null || s === '') return null;
  if (typeof s === 'number') return new Date(s > 1e12 ? s : s * 1000);
  const iso = /Z|[+-]\d\d:?\d\d$/.test(s) ? s : `${String(s).replace(' ', 'T')}Z`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t);
}
function ago(s) {
  const d = parseDate(s);
  if (!d) return '—';
  const sec = (Date.now() - d) / 1000;
  if (sec < 60) return _t('k0009');
  if (sec < 3600) return `${_t('k0010', { floor: Math.floor(sec / 60) })}`;
  if (sec < 86400) return `${_t('k0011', { floor: Math.floor(sec / 3600) })}`;
  if (sec < 86400 * 30) return `${_t('k0012', { floor: Math.floor(sec / 86400) })}`;
  return d.toLocaleDateString(LOC());
}
// 相对时间带绝对时间：悬停（title）显示完整日期时间，屏幕阅读器读 datetime
function agoT(s) {
  const d = parseDate(s);
  if (!d) return '—';
  return `<time datetime="${d.toISOString()}" title="${esc(d.toLocaleString(LOC(), { hourCycle: 'h23' }))}">${esc(ago(s))}</time>`;
}
// 百分比统一一位小数（LEAN 给的 "46.000%" 这种字符串也重新格式化），负号用真正的减号
function pct(v, sign = true, d = 1) {
  let n;
  if (typeof v === 'string' && /%$/.test(v.trim())) n = parseFloat(v);
  else if (v == null || v === '' || Number.isNaN(+v)) return '—';
  else n = +v * 100;
  if (!Number.isFinite(n)) return '—';
  const t = Math.abs(n).toFixed(d);
  return `${n < 0 && +t !== 0 ? '−' : sign && n > 0 && +t !== 0 ? '+' : ''}${t}%`;
}
const num = (v, d = 2) => (v == null || v === '' || Number.isNaN(+v) ? '—' : (+v).toFixed(d).replace(/^-(?=\d*\.?\d*[1-9])/, '−').replace(/^-/, ''));
// 接近 0 的不上色（显示成 +0.0% 却标绿 / 标红只会误导）：带 % 的字符串按百分数、其余字符串（夏普等）都是 |x| < 0.05；
// 数字按小数收益率，|x| < 0.0005（即 0.05%）。eps 可以自己指定
function signClass(v, eps) {
  const s = String(v ?? '');
  const n = parseFloat(s.replace(/−/g, '-').replace(/[^0-9.\-]/g, ''));
  const e = eps ?? (typeof v === 'number' ? 0.0005 : 0.05);
  return Number.isNaN(n) || Math.abs(n) < e ? '' : n > 0 ? 'up' : 'down';
}
const isRunning = (b) => Boolean(b) && !b.error && /queue|progress/i.test(b.status || '');
const isFailed = (b) => Boolean(b) && (/error/i.test(b.status || '') || Boolean(b.error));
const getCss = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const MOD_KEY = /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : 'Ctrl ';
// 读取失败的统一样式：一句人话 + 重试，不显示堆栈
let errorBox; _regT(() => { errorBox = (what, msg) => `<div class="error-box load-err" role="alert"><div><b>${esc(what)}</b>${msg ? `<span>${esc(zhErr(String(msg).split('\n')[0]).slice(0, 300))}</span>` : ''}</div><button type="button" class="btn sm" data-reload>${_t('k0013')}</button></div>`; });
// 防重复提交：同一个 key 的操作还没返回时，再点一次直接忽略；按钮显示进行中
const BUSY = new Set();
async function once(key, btn, fn) {
  if (BUSY.has(key)) return undefined;
  BUSY.add(key);
  if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
  try { return await fn(); } finally {
    BUSY.delete(key);
    if (btn && btn.isConnected) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
  }
}

// 复制到剪贴板：优先异步 API，不行（非安全上下文、权限被拒）时退回 execCommand
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* 继续退回 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}
function downloadText(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// 「搬回 QuantConnect」：直接发到用户自己的 QC 账户（建项目 + 上传 + 云端编译），或者手动复制 main.py 等文件；提示 helm_data 依赖与差异
function openQcDialog(files, ctx = {}) {
  const py = files.filter((f) => /\.py$/i.test(f.name));
  const main = py.find((f) => f.name === 'main.py') || py[0];
  if (!main) { toast(_t('k0014')); return; }
  const others = py.filter((f) => f !== main);
  const used = [...new Set(py.flatMap((f) => String(f.content).match(/\bHelm(?:Signals|Universe|Macro|Dataset)\b/g) || []))];
  const importsHd = py.some((f) => /^\s*(?:from|import)\s+helm_data\b/m.test(String(f.content)));
  const usesHd = Boolean(used.length || importsHd);
  const warn = usesHd
    ? `<div class="error-box"><b>${_t('k0018')}</b><p style="margin:6px 0 0">${_t('k0019')}${used.length ? `${_t('k0016')}${used.map((u) => `<span class="mono">${esc(u)}</span>`).join(_t('k0015'))}${_t('k0017')}` : ''}${_t('k0020')}</p></div>`
    : '';
  const canSend = Boolean(ctx.projectId && ctx.backtestId);
  const st = { status: null, busy: false, result: null, prev: null };
  const { d } = openModal({ cls: 'qc-dlg', labelId: 'qcT', html: `<div class="cd-body"><h2 id="qcT">${_t('k0023')}</h2>
    ${warn}
    ${canSend ? `<section class="qc-send" id="qcSend" aria-live="polite"><p class="meta">${_t('qc_checking')}</p></section>` : ''}
    <details class="qc-manual"${canSend ? '' : ' open'}><summary>${_t('qc_manual')}</summary>
    <div class="qc-files"><div class="qc-row"><span class="mono">${esc(main.name)}</span><button type="button" class="btn primary sm" data-qc-copy="${esc(main.name)}">${_t('k0021', { v: esc(main.name) })}</button></div></div>
    ${others.length ? `<div class="cd-msg"><p>${_t('k0022', { n: others.length })}</p></div>
    <div class="qc-files">${others.map((f) => `<div class="qc-row"><span class="mono">${esc(f.name)}</span><button type="button" class="btn sm" data-qc-copy="${esc(f.name)}">${_t('k0021', { v: esc(f.name) })}</button></div>`).join('')}</div>` : ''}
    <ol class="qc-list">
      <li>${_t('k0024')}</li>
      <li>${_t('k0025')}</li>
      <li>${_t('k0026')}</li>
      <li>${_t('k0027')}</li>
    </ol></details>
    <div class="modal-actions"><a class="btn" href="https://www.quantconnect.com/" target="_blank" rel="noopener noreferrer">${_t('k0028')}</a><button type="button" class="btn" data-qc-close>${_t('k0029')}</button></div></div>`,
  onClick: async (e, close) => {
    if (e.target.closest('[data-qc-close]')) { close(); return; }
    const b = e.target.closest('[data-qc-copy]');
    if (b) { const f = py.find((x) => x.name === b.dataset.qcCopy); if (f) copyText(f.content).then((ok) => toast(ok ? `${_t('k0030', { name: f.name })}` : _t('k0031'))); return; }
    if (st.busy) return;
    if (e.target.closest('[data-qc-connect]')) {
      const userId = d.querySelector('#qcUid').value.trim(); const token = d.querySelector('#qcTok').value.trim();
      if (!userId || !token) { toast(_t('qc_need')); return; }
      st.busy = true; renderSend();
      const r = await safePost('/api/actions/qc-connect', { userId, token });
      st.busy = false;
      if (!r.success) { renderSend(); d.querySelector('#qcTok').value = ''; d.querySelector('#qcUid').value = userId; toast(`${_t('qc_fail')}${(r.errors || []).join('; ')}`); return; }
      st.status = r.status; renderSend(); toast(_t('qc_connected'));
      return;
    }
    if (e.target.closest('[data-qc-disconnect]')) {
      st.busy = true; renderSend();
      await safePost('/api/actions/qc-disconnect', {});
      st.busy = false; st.status = { connected: false }; st.result = null; renderSend();
      return;
    }
    if (e.target.closest('[data-qc-push]')) {
      let confirmHelmData = false;
      if (usesHd) {
        if (!await askConfirm({ title: _t('qc_hd_t'), message: _t('qc_hd_m'), ok: _t('qc_hd_ok') })) return;
        confirmHelmData = true;
      }
      st.busy = true; st.result = null; renderSend();
      const r = await safePost('/api/actions/qc-push', { projectId: ctx.projectId, backtestId: ctx.backtestId, confirmHelmData });
      st.busy = false; st.result = r;
      if (r.project) st.prev = { url: r.project.url, qcName: r.project.name, at: new Date().toISOString() };
      if (!r.success && /QuantConnect 拒绝|rejected these credentials|还没有连接|No QuantConnect account/.test((r.errors || []).join(' '))) st.status = { connected: false };
      renderSend();
    }
  } });
  function renderSend() {
    const box = d.querySelector('#qcSend');
    if (!box || !st.status) return;
    const dis = st.busy ? ' disabled' : '';
    let html = `<h3>${_t('qc_send_h')}</h3>`;
    if (!st.status.connected) {
      html += `<p class="meta">${_t('qc_send_p')}</p>
        <div class="qc-form"><label class="field"><span>User ID</span><input id="qcUid" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="123456"></label>
        <label class="field"><span>API token</span><input id="qcTok" type="password" autocomplete="off" spellcheck="false"></label></div>
        <p class="meta">${_t('qc_help')} <a href="https://www.quantconnect.com/settings" target="_blank" rel="noopener noreferrer">quantconnect.com/settings</a></p>
        <div class="qc-actions"><button type="button" class="btn primary sm" data-qc-connect${dis}>${st.busy ? _t('qc_checking') : _t('qc_connect')}</button></div>`;
    } else {
      html += `<p class="meta">${_t('qc_as', { v: esc(st.status.userIdMasked || '') })} · <button type="button" class="linkish" data-qc-disconnect${dis}>${_t('qc_disc')}</button></p>
        <p class="meta">${_t('qc_what')}</p>
        <div class="qc-actions"><button type="button" class="btn primary sm" data-qc-push${dis}>${st.busy ? _t('qc_sending') : _t('qc_send')}</button></div>`;
      const r = st.result;
      if (r && !r.success && !r.needsConfirm) html += `<div class="error-box"><p style="margin:0">${esc((r.errors || []).join('; '))}</p>${r.project ? `<p style="margin:6px 0 0"><a href="${esc(r.project.url)}" target="_blank" rel="noopener noreferrer">${_t('qc_open')}</a></p>` : ''}</div>`;
      if (r && r.success) {
        const c = r.compile || {};
        const line = c.state === 'BuildSuccess' ? `<span class="qc-ok">${_t('qc_build_ok')}</span>` : c.state === 'BuildError' ? `<span class="qc-bad">${_t('qc_build_err')}</span>` : `<span class="meta">${esc(c.error || _t('qc_build_q'))}</span>`;
        html += `<div class="qc-result"><p style="margin:0">${_t('qc_done', { n: (r.uploaded || []).length })} <a href="${esc(r.project.url)}" target="_blank" rel="noopener noreferrer">${_t('qc_open')}</a></p><p style="margin:6px 0 0">${line}</p>
          ${c.state === 'BuildError' && c.logs && c.logs.length ? `<pre class="qc-logs">${esc(c.logs.join('\n'))}</pre>` : ''}
          <p class="meta" style="margin:6px 0 0">${_t('qc_next')}</p></div>`;
      } else if (st.prev && !r) {
        html += `<p class="meta">${_t('qc_prev', { v: esc(st.prev.at && parseDate(st.prev.at) ? parseDate(st.prev.at).toLocaleString(LOC(), { dateStyle: 'short', timeStyle: 'short' }) : '—') })} <a href="${esc(st.prev.url)}" target="_blank" rel="noopener noreferrer">${_t('qc_open')}</a></p>`;
      }
    }
    box.innerHTML = html;
  }
  if (canSend) {
    Promise.all([safePost('/api/qc/status', {}), safePost('/api/actions/qc-exports', { projectId: ctx.projectId, backtestId: ctx.backtestId })]).then(([s1, s2]) => {
      st.status = s1.success ? s1.status : { connected: false };
      const ex = s2.success ? s2.exports.filter((x) => x.url && x.ok) : []; // 只算成功编译的那次
      st.prev = ex.length ? ex[ex.length - 1] : null;
      renderSend();
    });
  }
}

// 「叠加一层」：预检 → 智能体评估 qlib 选股方案，再加上不选股的方案（仓位层、策略组合 / 互补策略）→ Kahoot 式色块让用户选 → 交给总控。
// 选股层前景弱或之前没有信号时，不选股的方案排前面并标「推荐」。
// 色块颜色 + 形状一起区分（不只靠颜色）；键盘 1–9 选方案、0 选「不加这一层」、Enter 确认、Esc 关闭。
const LY_TILES = [['red', '▲'], ['blue', '◆'], ['yellow', '●'], ['green', '■']];
function openLayerModal() {
  const projectId = S.route.projectId;
  if (!projectId) return;
  const st = { phase: 'check', pc: null, layer: null, sel: null, busy: false, timer: null, err: null, ready: null };
  const { d, close } = openModal({ cls: 'layer-dlg', labelId: 'lyT', html: `<div class="cd-body"><h2 id="lyT">${_t('ly_title')}</h2><div class="ly-body" aria-live="polite"></div></div>`,
    onClick: async (e, cl) => {
      if (e.target.closest('[data-ly-close]')) { cl(); return; }
      if (st.busy) return;
      if (e.target.closest('[data-ly-start]')) { start(); return; }
      if (e.target.closest('[data-ly-prev]')) { st.phase = 'run'; poll(st.ready); return; }
      if (e.target.closest('[data-ly-back]')) { st.sel = null; render(); return; }
      if (e.target.closest('[data-ly-retry]')) { start(); return; }
      const t = e.target.closest('[data-ly-opt]');
      if (t) { st.sel = t.dataset.lyOpt; render(); return; }
      if (e.target.closest('[data-ly-go]')) choose();
    },
    onClose: () => { clearTimeout(st.timer); document.removeEventListener('keydown', onKey, true); } });
  const box = d.querySelector('.ly-body');
  const opts = () => (st.layer && st.layer.result ? st.layer.result.options : []);
  function onKey(e) {
    if (!d.open || st.phase !== 'pick' || st.busy || e.metaKey || e.ctrlKey || e.altKey || e.target.closest('input, textarea')) return; // ⌘/Ctrl+0 是复位缩放，别吞掉
    const list = opts();
    if (/^[1-9]$/.test(e.key)) { const o = list.filter((x) => x.kind !== 'none')[Number(e.key) - 1]; if (o) { st.sel = o.id; render(); e.preventDefault(); } }
    else if (e.key === '0') { st.sel = 'none'; render(); e.preventDefault(); }
    else if (e.key === 'Enter' && st.sel && !e.target.closest('button')) { choose(); e.preventDefault(); }
  }
  document.addEventListener('keydown', onKey, true);
  const pitLabel = (p) => (p === 'pit' ? _t('ly_pit') : p === 'partial' ? _t('ly_pit_part') : _t('ly_pit_no'));
  const riskLabel = (r) => _t(r === 'high' ? 'ly_risk_h' : r === 'low' ? 'ly_risk_l' : 'ly_risk_m');
  function tileHTML(o, i) {
    if (o.kind === 'none') return `<button type="button" class="ly-tile ly-none${st.sel === o.id ? ' sel' : ''}${st.sel && st.sel !== o.id ? ' dim' : ''}" data-ly-opt="none" aria-pressed="${st.sel === o.id}"><span class="ly-key">0</span><span class="ly-shape" aria-hidden="true">✕</span><span class="ly-tx"><b>${esc(o.title)}</b><i>${esc(o.tests)}</i></span></button>`;
    const [color, shape] = LY_TILES[i % 4];
    const what = o.kind === 'timing' ? _t('ly_k_timing') : o.kind === 'vol' ? _t('ly_k_vol') : o.kind === 'portfolio' ? _t('ly_k_port', { n: (o.peers || []).length + 1 }) : o.kind === 'complement' ? _t('ly_k_comp') : `${esc(o.replaces)} → ${esc(o.universeLabel || o.universe)}`;
    return `<button type="button" class="ly-tile ly-${color}${st.sel === o.id ? ' sel' : ''}${st.sel && st.sel !== o.id ? ' dim' : ''}" data-ly-opt="${esc(o.id)}" aria-pressed="${st.sel === o.id}">
      <span class="ly-key">${i + 1}</span><span class="ly-shape" aria-hidden="true">${shape}</span>
      <span class="ly-tx"><b>${o.recommended ? `<span class="ly-rec">${_t('ly_rec')}</span>` : ''}${esc(o.title)}</b><i>${esc(o.tests)}</i>
      <span class="ly-badges"><em>${what}</em><em>${_t('ly_trials', { n: o.trials })}</em><em>${riskLabel(o.risk)}</em></span></span></button>`;
  }
  function detailHTML(o) {
    if (o.kind === 'none') return `<div class="ly-detail"><p>${_t('ly_none_d')}</p><div class="modal-actions"><button type="button" class="btn" data-ly-back>${_t('ly_back')}</button><button type="button" class="btn primary" data-ly-go>${_t('ly_keep')}</button></div></div>`;
    return `<div class="ly-detail"><h3>${esc(o.title)}</h3>
      ${o.how ? `<p>${esc(o.how)}</p>` : ''}
      <dl class="ly-dl">
        <dt>${_t('ly_d_signal')}</dt><dd>${o.kind === 'layer' ? `${o.signalType === 'full' ? _t('ly_sig_full') : _t('ly_sig_idea')}${o.signal ? ` · ${esc(o.signal)}` : ''}` : esc(o.signal || '')}</dd>
        ${o.holdings ? `<dt>${_t('ly_d_hold')}</dt><dd>${esc(o.holdings)}</dd>` : ''}
        ${o.kind === 'layer' ? `<dt>${_t('ly_d_data')}</dt><dd>${esc(o.universeLabel || o.universe)} · ${pitLabel(o.pit)}${o.dataReady === false ? ` · ${_t('ly_prep')}` : ''}</dd>` : ''}
        ${o.kind === 'portfolio' ? `<dt>${_t('ly_d_peers')}</dt><dd><ul>${(o.peers || []).map((p) => `<li>${esc(p.name)}${p.sharpe != null ? ` · ${_t('ly_sharpe')} ${esc(Number(p.sharpe).toFixed(2))}` : ''}</li>`).join('')}</ul></dd>` : ''}
        <dt>${_t('ly_d_trials')}</dt><dd>${_t('ly_trials', { n: o.trials })} · ${_t('ly_trials_d')}</dd>
        ${o.risks && o.risks.length ? `<dt>${_t('ly_d_risks')}</dt><dd><ul>${o.risks.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></dd>` : ''}
      </dl>
      <p class="meta">${_t('ly_guard')}</p>
      <div class="modal-actions"><button type="button" class="btn" data-ly-back>${_t('ly_back')}</button><button type="button" class="btn primary" data-ly-go>${_t('ly_go')}</button></div></div>`;
  }
  function render() {
    let h = '';
    if (st.phase === 'check') h = `<p class="meta">${_t('ly_checking')}</p>`;
    else if (st.phase === 'fail') h = `<div class="error-box"><p style="margin:0">${esc(st.err || '')}</p></div><div class="modal-actions"><button type="button" class="btn" data-ly-close>${_t('k0029')}</button></div>`;
    else if (st.phase === 'intro') {
      const legs = st.pc.legs.map((l) => `<span class="ly-chip"><b>${esc(l.etf)}</b> → ${esc(l.label)} <i>${pitLabel(l.pit)}${l.ready === false ? ` · ${_t('ly_prep')}` : ''}</i></span>`).join('');
      const notes = [st.pc.qlibBlocked ? esc(st.pc.qlibBlocked) : '', st.pc.noSignal ? _t('ly_nosig', { n: st.pc.noSignal }) : ''].filter(Boolean);
      h = `<p>${_t('ly_intro', { v: esc(st.pc.backtest ? st.pc.backtest.name : '') })}</p>
        ${legs ? `<p class="meta">${_t('ly_legs')}</p><div class="ly-chips">${legs}</div>` : ''}
        ${notes.length ? `<p class="ly-sum">${notes.join('<br>')}${_t('ly_alt_first')}</p>` : ''}
        ${st.pc.attribution ? `<p class="meta"><b>${_t('ly_attr')}</b>${esc(st.pc.attribution.summary)}</p>` : ''}
        <ol class="qc-list"><li>${_t('ly_s1')}</li><li>${_t('ly_s2')}</li><li>${_t('ly_s3')}</li></ol>
        <p class="meta">${_t('ly_cost')}</p>
        <div class="modal-actions">${st.ready ? `<button type="button" class="btn" data-ly-prev>${_t('ly_prev')}</button>` : ''}<button type="button" class="btn" data-ly-close>${_t('k0033')}</button><button type="button" class="btn primary" data-ly-start>${_t('ly_start')}</button></div>`;
    } else if (st.phase === 'run') {
      h = `<div class="ly-wait"><div class="ly-shapes" aria-hidden="true">${LY_TILES.map(([c, s2]) => `<span class="ly-${c}">${s2}</span>`).join('')}</div><p>${_t('ly_running')}</p><p class="meta">${_t('ly_running_d')}</p></div>
        <div class="modal-actions"><button type="button" class="btn" data-ly-close>${_t('ly_bg')}</button></div>`;
    } else if (st.phase === 'error') {
      h = `<div class="error-box"><p style="margin:0">${esc(st.err || '')}</p></div><div class="modal-actions"><button type="button" class="btn" data-ly-close>${_t('k0029')}</button><button type="button" class="btn primary" data-ly-retry>${_t('ly_retry')}</button></div>`;
    } else if (st.phase === 'pick') {
      const list = opts();
      const layers = list.filter((o) => o.kind !== 'none');
      const none = list.find((o) => o.kind === 'none');
      const sel = list.find((o) => o.id === st.sel);
      const R = st.layer.result;
      h = `${R.summary ? `<p class="ly-sum">${esc(R.summary)}</p>` : ''}
        ${R.recommendAlt && R.why && R.why.length ? `<p class="meta">${_t('ly_why', { v: R.why.map(esc).join(_t('k0007')) })}</p>` : ''}
        ${layers.length ? '' : `<p class="meta">${_t('ly_nofit')}</p>`}
        <div class="ly-grid${layers.length === 1 ? ' one' : ''}">${layers.map((o, i) => tileHTML(o, i)).join('')}</div>
        ${none ? tileHTML(none, 4) : ''}
        ${sel ? detailHTML(sel) : `<p class="meta ly-hint">${_t('ly_hint')}</p>`}`;
    }
    box.innerHTML = h;
    if (st.phase === 'pick' && st.sel) { const dt = box.querySelector('.ly-detail'); if (dt) dt.scrollIntoView({ block: 'nearest' }); }
  }
  async function poll(layerId) {
    clearTimeout(st.timer);
    const r = await safePost('/api/actions/layer-read', { projectId, layerId });
    if (!d.open) return;
    if (!r.success) { st.phase = 'error'; st.err = (r.errors || []).join('; '); render(); return; }
    st.layer = r.layer;
    if (r.layer.status === 'running') { if (st.phase !== 'run') { st.phase = 'run'; render(); } st.timer = setTimeout(() => poll(layerId), 2500); return; }
    if (r.layer.status === 'error') { st.phase = 'error'; st.err = r.layer.error; render(); return; }
    if (r.layer.status === 'ready') { st.phase = 'pick'; st.sel = null; render(); return; }
    st.phase = 'error'; st.err = _t('ly_used'); render();
  }
  async function start() {
    st.busy = true;
    const r = await safePost('/api/actions/layer-assess', { projectId });
    st.busy = false;
    if (!r.success) { st.phase = 'error'; st.err = (r.errors || []).join('; '); render(); return; }
    st.phase = 'run'; render(); poll(r.layerId);
  }
  async function choose() {
    if (!st.sel || st.busy) return;
    st.busy = true;
    const r = await safePost('/api/actions/layer-choose', { projectId, layerId: st.layer.layerId, optionId: st.sel });
    st.busy = false;
    if (!r.success) { toast((r.errors || []).join('; ')); return; }
    close(true);
    if (r.declined) { toast(_t('ly_kept')); return; }
    toast(_t('ly_sent'));
    askAgent(r.agent || 'mia', r.message);
  }
  render();
  safePost('/api/actions/layer-precheck', { projectId }).then((r) => {
    if (!d.open) return;
    if (!r.success) { st.phase = 'fail'; st.err = (r.errors || []).join('; '); render(); return; }
    if (r.running) { st.phase = 'run'; render(); poll(r.running); return; }
    if (!r.precheck.ok) { st.phase = 'fail'; st.err = r.precheck.reason; render(); return; }
    st.pc = r.precheck; st.ready = r.ready; st.phase = 'intro'; render();
  });
}

// 应用内对话框的公共骨架（确认框、搬回 QuantConnect 共用）：原生 <dialog>.showModal()，页面其余部分自动不可聚焦；
// Esc / 点遮罩 = close(false)；Tab 在框内循环。close(值) 只生效一次，再调用 onClose(值)。
function openModal({ cls = '', labelId, describedBy, role, html, onClick, onClose }) {
  const d = document.createElement('dialog');
  d.className = `modal confirm-dlg${cls ? ` ${cls}` : ''}`;
  d.setAttribute('aria-labelledby', labelId);
  if (describedBy) d.setAttribute('aria-describedby', describedBy);
  if (role) d.setAttribute('role', role);
  d.innerHTML = html;
  document.body.appendChild(d);
  let done = false;
  const close = (v) => {
    if (done) return;
    done = true;
    try { d.close(); } catch { /* 已关闭 */ }
    d.remove();
    if (onClose) onClose(v);
  };
  d.addEventListener('mousedown', (e) => { if (e.target === d) close(false); }); // 点遮罩 = 取消（和其他对话框一致：按下时判断，拖选文字时松手在框外不会误关）
  if (onClick) d.addEventListener('click', (e) => onClick(e, close));
  d.addEventListener('cancel', (e) => { e.preventDefault(); close(false); }); // Esc
  d.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    // 只算真的能拿到焦点的：收起的 <details> 里的按钮看不见，<summary> 自己可以聚焦
    const f = [...d.querySelectorAll('input:not([type=hidden]), textarea, select, button:not([disabled]), a[href], summary')].filter((el) => el.getClientRects().length);
    if (!f.length) return;
    const i = f.indexOf(document.activeElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
  });
  d.showModal();
  return { d, close };
}

// 应用内确认框：代替浏览器自带的 confirm()。返回 Promise<boolean>。
// 用原生 <dialog>.showModal()：页面其余部分自动不可聚焦；Esc 取消；Tab 在框内循环；
// 危险操作的确认钮用警示色，默认焦点落在“取消”（安全的那个）上，Enter 触发当前聚焦的按钮。
function askConfirm({ title, message, ok = _t('k0032'), cancel = _t('k0033'), danger = false }) {
  return new Promise((resolve) => {
    const id = `cd${Date.now().toString(36)}`;
    const prevFocus = document.activeElement;
    const { d } = openModal({
      labelId: `${id}t`,
      describedBy: `${id}m`,
      role: danger ? 'alertdialog' : '',
      html: `<div class="cd-body"><h2 id="${id}t">${esc(title)}</h2>
      <div class="cd-msg" id="${id}m">${String(message).split('\n').map((l) => `<p>${esc(l)}</p>`).join('')}</div>
      <div class="modal-actions"><button type="button" class="btn" data-cd="no">${esc(cancel)}</button><button type="button" class="btn ${danger ? 'danger' : 'primary'}" data-cd="yes">${esc(ok)}</button></div></div>`,
      onClick: (e, close) => { const b = e.target.closest('[data-cd]'); if (b) close(b.dataset.cd === 'yes'); },
      onClose: (v) => {
        resolve(Boolean(v));
        // 稍后再还焦点：触发它的按钮可能正被 once() 暂时禁用，等它恢复可用
        setTimeout(() => { if (prevFocus && prevFocus.isConnected && prevFocus.focus) { try { prevFocus.focus({ preventScroll: true }); } catch { /* 忽略 */ } } }, 30);
      },
    });
    d.querySelector(danger ? '[data-cd=no]' : '[data-cd=yes]').focus();
  });
}

/* ================= state ================= */
const S = {
  status: null,
  agents: [],
  options: { models: [], efforts: [] },
  model: store.get('model', '') || 'auto',   // 'auto' 自动挑 | 模型 id（没有「默认」这一项）
  effort: store.get('effort', '') || 'auto',
  projects: null,
  route: { view: 'home' },
  project: null,
  backtests: null,
  files: null,
  fileSel: 'main.py',
  compileResult: null,
  backtest: null,
  charts: null,
  orders: null,
  logs: null,
  code: null,
  agentId: store.get('agent', 'mia'),
  thread: null,        // 当前打开的对话
  threads: [],         // 所有对话摘要
  running: new Map(),  // threadId -> { agent, title }  服务器上正在跑的 agent
  sub: null,           // 当前对话的事件流订阅 { threadId, ctrl }
  ctxOff: false,
  openTools: new Set(),
  known: new Map(),
  pollTimer: null,
  latest: {},
  btFilter: 'key',     // key=隐藏调试 | all | debug          // projectId -> 最近一次回测（首页卡片用）
  research: null,      // 当前项目的 qlib 研究任务列表
  rjob: null,          // 当前打开的研究任务（详情）
  papers: null,        // 当前项目的模拟实盘列表
  cmpSel: [],          // 回测列表里勾选的对比对象（backtestId）
  cmpCache: null,      // 对比用的数据：projectId/backtestId -> { b, eq, bm, val }
  specBt: null,        // 当前回测的规则说明快照 { id, spec }
  robustBt: null,      // 当前回测的稳健性分析 { id, robust, error }
  sensBt: null,        // 当前回测的参数敏感性 { id, r（接口返回）, error }
  paper: null,         // 当前打开的模拟实盘（详情）
  drift: null,         // 模拟实盘「是否在预期内」：{ sessionId, data | error }
  journal: null,       // 想法记录：{ data | error, q, project, stage, outcome }
  alpaca: null,        // Alpaca 模拟账户连接状态
  validation: null,    // 当前回测的统计检验
  universes: null,     // qlib 股票池
  route2: store.get('ideaRoute', 'auto'), // 首页想法的研究路线：auto | fast | deep
  ideaModel: store.get('ideaModel', '') || 'auto',   // 首页想法用的模型：'auto' 自动挑 | 模型 id
  ideaEffort: store.get('ideaEffort', '') || 'auto', // 首页想法用的思考深度：同上
};
// agents.json 里的默认名字 / 定位 / 示例任务是中文；英文界面下换成字典里的英文。用户改过的（和默认不一样）原样显示。
function localizeAgents(raw) {
  const zh = HELM_I18N.dict.zh;
  return raw.map((x) => {
    const loc = (v, key) => (v === zh[key] ? _t(key) : v);
    const name = loc(x.name, `ag_${x.id}_name`);
    return { ...x, name, role: loc(x.role, `ag_${x.id}_role`), starters: (x.starters || []).map((s, i) => loc(s, `ag_${x.id}_s${i + 1}`)), color: 'var(--muted)', glyph: String(name || '?').slice(0, 1) };
  });
}
// 模型 / 思考深度选项（服务器给的是中文说明）：默认文字换成字典里的英文，用户设置的原样显示
function localizeOpt(m) {
  const zh = HELM_I18N.dict.zh;
  const loc = (v, k) => (v === zh[k] ? _t(k) : v);
  return { ...m, label: loc(m.label, `opt_${m.id}_label`), desc: loc(m.desc, `opt_${m.id}_desc`) };
}
function localizeOptions(o) { return { ...o, models: (o.models || []).map(localizeOpt), efforts: (o.efforts || []).map(localizeOpt) }; }
function setAgents(raw) { S.agentsRaw = raw; S.agents = localizeAgents(raw); }
let agentOf; _regT(() => { agentOf = (id) => S.agents.find((a) => a.id === id) || S.agents[0] || { id: 'mia', name: _t('k0034'), glyph: '◎', color: '#d4ff4f', role: '', starters: [] }; });
const currentRunning = () => Boolean(S.thread && S.thread.id && S.running.has(S.thread.id));

let TOOL_LABELS; _regT(() => { TOOL_LABELS = {
  handoff: _t('k0035'), ask_user: _t('k0036'), verify_changes: _t('k0037'), revert_my_changes: _t('k0038'), list_projects: _t('k0039'), read_project: _t('k0040'), create_project: _t('k0041'), update_project: _t('k0042'),
  read_file: _t('k0043'), write_file: _t('k0044'), delete_file: _t('k0045'), compile: _t('k0046'), create_backtest: _t('k0047'),
  wait_for_backtest: _t('k0048'), read_backtest: _t('k0049'), list_backtests: _t('k0050'), read_backtest_orders: _t('k0051'),
  read_backtest_log: _t('k0052'), read_backtest_code: _t('k0053'), update_backtest: _t('k0054'), delete_backtest: _t('k0055'),
  fetch_data: _t('k0056'), list_data: _t('k0057'), validate_backtest: _t('k0058'),
  list_universes: _t('k0059'), universe_members: _t('k0060'), prepare_universe: _t('k0061'), start_research: _t('k0062'),
  research_status: _t('k0063'), read_research: _t('k0064'), resume_research: _t('k0065'), stop_research: _t('k0066'),
  export_signals: _t('k0067'), list_signals: _t('k0068'),
  Read: _t('k0069'), Glob: _t('k0070'), Grep: _t('k0071'), WebSearch: _t('k0072'), WebFetch: _t('k0073'), TodoWrite: _t('k0074'), ToolSearch: _t('k0075'),
}; });
const MUTATING = new Set(['create_project', 'update_project', 'write_file', 'delete_file', 'create_backtest', 'update_backtest', 'delete_backtest', 'wait_for_backtest',
  'start_research', 'resume_research', 'stop_research', 'export_signals', 'prepare_universe']);
const shortTool = (name) => String(name || '').replace(/^mcp__.*?__/i, ''); // mcp__<服务名>__<工具>，服务名里带 - 或 _ 也能剥掉

/* ================= status ================= */
// 首页数据（状态、体检、项目、最近回测）是各自异步到的：合并成下一帧画一次，而不是每到一份就整页重画
let homeRaf = 0;
const onHomePage = () => S.route.view === 'home' && !S.route.data && !S.route.journal && !S.route.page;
function renderHomeSoon() {
  if (!onHomePage()) return;
  cancelAnimationFrame(homeRaf);
  homeRaf = requestAnimationFrame(() => { if (onHomePage()) renderMain(); });
}
async function loadStatus(force = false) {
  loadHealth(force);
  loadAi(force);
  try { S.status = await api(`/api/status${force ? '?refresh=1' : ''}`); } catch (e) { S.status = { error: e.message }; }
  renderStatus();
  renderHomeSoon();
}
// 环境体检：哪些组件没就绪、怎么补。/api/health?refresh=1 强制重新检查
async function loadHealth(force = false) {
  try { S.health = await api(`/api/health${force ? '?refresh=1' : ''}`); } catch (e) { S.health = { error: e.message }; }
  renderHomeSoon();
  return S.health;
}
// 「重新检查」：首页按钮和 App 菜单「服务 → 重新检查环境」共用。还缺东西时把怎么补直接摊开，提示里点名缺的是哪一项
async function recheckHealth() {
  S.healthClosed = false;
  const h = await loadHealth(true);
  if (!h || !Array.isArray(h.components)) { toast(_t('k1548')); return; }
  const hn = (id) => { const c = h.components.find((x) => x.id === id); return c ? (HELM_I18N.lang() === 'en' ? c.en || c.zh : c.zh) : id; };
  toast(h.missing && h.missing.length ? _t('k1546', { names: h.missing.map(hn).join(_t('k0015')) }) : _t('k1547'));
}
function healthHTML() {
  const st = S.status || {};
  const h = S.health;
  if (S.status && S.status.error) return `
    <div class="error-box" style="margin-top:18px" role="alert">${_t('k0076', { v: esc(S.status.error) })} <button type="button" class="linkish" data-refresh>${_t('k0013')}</button></div>`;
  if (!h) return '';
  if (h.error || !Array.isArray(h.components)) {
    // 旧版服务没有 /api/health：退回到 /api/status 的简单提示
    const claudeOk = st.claude && st.claude.ok;
    const eng = st.engine || {};
    return (!claudeOk || !eng.ok) && S.status ? `
    <div class="error-box" style="margin-top:18px"><b>${_t('k0081')}</b>${!claudeOk ? `${_t('k0077')}${esc(st.claude?.error || '')}${_t('k0078')}` : ''}${!eng.ok ? `${_t('k0079')}${esc((eng.missing || []).join(', '))}${_t('k0080')}` : ''}</div>` : '';
  }
  const byId = (id) => h.components.find((c) => c.id === id);
  const miss = (h.missing || []).map(byId).filter(Boolean);
  const opt = (h.optionalMissing || []).map(byId).filter(Boolean);
  const hName = (c) => (HELM_I18N.lang() === 'en' ? c.en || c.zh : c.zh);
  const hHint = (c) => (HELM_I18N.lang() === 'en' ? c.hintEn || c.hint : c.hint);
  // 每一项：缺什么 → 怎么补（说明 + 可复制的命令 / AI 设置按钮）→ 现在检查到的状态
  const fix = (c) => (c.cmd ? `<div class="md-code hl-cmd"><span class="hl-cmd-k">${_t('hl_cmd')}</span><button type="button" class="copy-code" data-copy-code aria-label="${_t('k1415')}">${_t('k1416')}</button><pre><code>${esc(c.cmd)}</code></pre></div>` : '')
    + (c.id === 'ai' ? `<button type="button" class="btn sm hl-act" data-ai-open>${_t('hl_ai')}</button>` : '');
  const item = (c) => `<li><b>${esc(hName(c))}</b>${hHint(c) ? `<span>${esc(zhErr(hHint(c)))}</span>` : ''}${c.ok ? '' : fix(c)}${c.detail ? `<code>${esc(zhErr(c.detail))}</code>` : ''}</li>`;
  const when = h.checkedAt ? `${_t('k0082')} ${esc(parseDate(h.checkedAt) ? parseDate(h.checkedAt).toLocaleTimeString(LOC(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '—')}</span>` : '';
  const recheck = _t('k0083');
  const req = miss.length ? `<section class="health bad" role="alert" aria-label="${_t('k0084')}">
      <details class="health-d" ${S.healthClosed === true ? '' : 'open'}><summary>${_t('k0085', { names: esc(miss.map(hName).join(_t('k0015'))) })}</summary>
        <ul>${miss.map(item).join('')}</ul><p class="hl-foot">${_t('k0086', { when })}</p></details>
      ${recheck}</section>` : '';
  const optSec = opt.length ? `<section class="health-opt" aria-label="${_t('k0087')}">
      <details class="health-od"><summary>${_t('k0088')}${opt.map((c) => esc(hName(c))).join(_t('k0015'))}</summary><ul>${opt.map(item).join('')}</ul></details>
      ${miss.length ? '' : recheck.replace('btn sm', 'linkish')}</section>` : '';
  return req + optSec;
}
function renderStatus() {
  const st = S.status;
  if (!st) return;
  if (st.error) { $('#status').innerHTML = _t('k0089'); return; }
  const c = st.claude || {};
  const e = st.engine || {};
  $('#status').innerHTML = `
    <button class="pill ${c.ok ? 'ok' : 'bad'}" data-refresh title="${esc(c.ok ? `${_t('k0090', { version: c.version })}` : zhErr(c.error))}" aria-label="${esc(`Claude: ${c.ok ? _t('k0090', { version: c.version }) : zhErr(c.error)}`)}"><span class="led"></span><span class="txt">${c.ok ? `Claude ${esc(String(c.version).split(' ')[0])}` : _t('k0091')}</span><span class="txt-s" aria-hidden="true">Claude</span></button>
    <button class="pill ${e.ok ? 'ok' : 'bad'}" data-refresh title="${esc(e.ok ? `${_t('k0092', { tickers: e.tickers })}` : `${_t('k0093')}${(e.missing || []).join(', ')}`)}" aria-label="${esc(`${e.ok ? _t('k0094') : _t('k0095')}: ${e.ok ? _t('k0092', { tickers: e.tickers }) : `${_t('k0093')}${(e.missing || []).join(', ')}`}`)}"><span class="led"></span><span class="txt">${e.ok ? _t('k0094') : _t('k0095')}</span><span class="txt-s" aria-hidden="true">LEAN</span></button>${aiPillHTML()}`;
}

/* ---- AI 连接：订阅 / API key / 兼容接口（lib/ai.mjs）。密钥只发给服务端保存，网页只拿到末 4 位 ---- */
const aiModeName = (m) => ({ auto: _t('k1560'), subscription: _t('k1561'), apiKey: _t('k1562'), custom: _t('k1563') }[m] || m);
async function loadAi(force = false) {
  try { S.ai = await api(`/api/ai/status${force ? '?refresh=1' : ''}`); } catch { S.ai = null; }
  renderStatus();
}
function aiPillHTML() {
  if (!S.ai || !S.ai.ai) return '';
  const { ai, login } = S.ai;
  const ok = !login || login.ok;
  const tip = ok ? _t('k1564', { mode: aiDetected() }) : zhErr((login && login.error) || '');
  return `<button type="button" class="pill ${ok ? 'ok' : 'bad'}" data-ai-open title="${esc(tip)}" aria-label="${esc(`AI: ${tip}`)}"><span class="led"></span><span class="txt">AI · ${esc(aiDetected())}</span><span class="txt-s" aria-hidden="true">AI</span></button>`;
}
function aiSelectedMode() { const r = document.querySelector('#aiForm input[name="aiMode"]:checked'); return r ? r.value : 'auto'; }
function renderAiModal() {
  const mode = aiSelectedMode();
  const cur = (S.ai && S.ai.ai) || { mode: 'auto' };
  const needsKey = mode === 'apiKey' || mode === 'custom';
  $('#aiKeyWrap').hidden = !needsKey;
  $('#aiUrlWrap').hidden = mode !== 'custom';
  $('#aiModelWrap').hidden = mode !== 'custom';
  $('#aiCustomNote').hidden = mode !== 'custom';
  $('#aiSubNote').hidden = mode !== 'subscription';
  // 留空沿用旧 key：只在同一种方式、同一个接口地址时成立（服务端也是这么判断的）
  const sameTarget = cur.mode === mode && (mode !== 'custom' || ($('#aiUrl').value.trim().replace(/\/+$/, '') === cur.baseUrl));
  $('#aiKeyKeep').hidden = !(needsKey && cur.hasKey && sameTarget);
  $('#aiKey').placeholder = cur.hasKey && sameTarget ? cur.keyHint : (mode === 'apiKey' ? 'sk-ant-…' : '');
  const login = S.ai && S.ai.login;
  $('#aiState').textContent = `${_t('k1565', { mode: aiModeName(cur.mode) })}${cur.hasKey ? ` · ${cur.keyHint}` : ''}${login && !login.ok ? ` · ${zhErr(login.error || '')}` : ''}`;
}
async function openAiModal() {
  await loadAi(true);
  const cur = (S.ai && S.ai.ai) || { mode: 'auto' };
  for (const r of document.querySelectorAll('#aiForm input[name="aiMode"]')) r.checked = r.value === cur.mode;
  $('#aiUrl').value = cur.baseUrl || '';
  $('#aiModel').value = cur.model || '';
  $('#aiKey').value = '';
  renderAiModal();
  $('#aiModal').showModal();
}
async function saveAiUI() {
  const body = { aiMode: aiSelectedMode(), apiKey: $('#aiKey').value.trim(), baseUrl: $('#aiUrl').value.trim(), aiModel: $('#aiModel').value.trim() };
  const r = await once('ai-save', $('#aiSave'), () => safePost('/api/actions/ai-save', body));
  if (!r) return;
  if (!r.success) { toast(`${_t('k1566')}${(r.errors || []).map(zhErr).join('; ')}`); return; }
  $('#aiKey').value = '';
  S.ai = { success: true, ai: r.ai, login: r.login };
  renderStatus();
  loadHealth(true);
  if (r.login && !r.login.ok) { renderAiModal(); toast(`${_t('k1567')}${zhErr(r.login.error || '')}`); return; }
  $('#aiModal').close();
  toast(_t('k1568', { mode: aiModeName(r.ai.mode) }));
}
async function testAiUI() {
  const r = await once('ai-test', $('#aiTest'), () => safePost('/api/actions/ai-test', {}));
  if (!r) return;
  if (r.ai) S.ai = { success: true, ai: r.ai, login: r.login || (S.ai && S.ai.login) };
  renderStatus(); renderAiModal();
  toast(r.success ? _t('k1569') : `${_t('k1566')}${(r.errors || []).map(zhErr).join('; ')}`);
}

// 顶栏“运行中”：并行任务一览
function renderRuns() {
  const n = S.running.size;
  const el = $('#runs');
  if (!n) { el.innerHTML = ''; return; }
  const items = [...S.running.entries()].map(([id, r]) => {
    const a = agentOf(r.agent);
    return `<button class="run-item" data-open-thread="${esc(id)}"><span class="g" style="color:${a.color}">${esc(a.glyph)}</span><span class="who">${esc(a.name)}</span><span class="tt">${esc(r.title)}</span><span class="spin"></span></button>`;
  }).join('');
  el.innerHTML = `<button class="runs-btn" id="runsBtn" aria-haspopup="true">${_t('k0096', { n })}</button><div class="runs-menu" id="runsMenu" hidden>${items}</div>`;
}

/* ================= projects ================= */
function loadProjects() {
  if (!S.projectsP) S.projectsP = loadProjectsNow().finally(() => { S.projectsP = null; });
  return S.projectsP;
}
async function loadProjectsNow() {
  const btn = $('#refreshProjects');
  btn.classList.add('spin');
  const r = await data('projects/read');
  btn.classList.remove('spin');
  // 读取失败不等于「没有项目」：保留上一次的列表，并明确提示
  S.projectsError = r.success ? null : (r.errors || []).join(_t('k0007')) || _t('k0097');
  S.projects = r.success ? r.projects : (S.projects || []);
  if (S.route.projectId) S.project = S.projects.find((p) => p.projectId === S.route.projectId) || S.project;
  renderProjects();
  if (onHomePage()) { renderHomeSoon(); loadLatest(); }
  renderCrumbs();
}
async function loadLatest() {
  const top = (S.projects || []).slice(0, 8);
  S.home = S.home || {};
  await Promise.all(top.map(async (p) => {
    const pid = p.projectId;
    const [r, rs, pp] = await Promise.all([
      data('backtests/list', { projectId: pid }),
      post('/api/qlib/research/list', { projectId: pid }).catch(() => ({ success: false })),
      post('/api/paper/list', { projectId: pid }).catch(() => ({ success: false })),
    ]);
    if (r.success) S.latest[pid] = r.backtests.find((b) => !isRunning(b) && !isFailed(b)) || r.backtests[0] || null;
    S.home[pid] = { bts: r.success ? r.backtests : [], rs: rs.success ? rs.jobs : [], pap: pp.success ? pp.sessions : [] };
  }));
  renderHomeSoon();
}
function renderProjects() {
  const ul = $('#projectList');
  const q = $('#projectSearch').value.trim().toLowerCase();
  $('#projCount').textContent = S.projects ? S.projects.length : '';
  if (!S.projects) {
    ul.innerHTML = Array.from({ length: 4 }, () => '<li style="padding:7px 10px"><div class="skeleton" style="height:14px"></div></li>').join('');
    return;
  }
  if (S.projectsError && !S.projects.length) {
    ul.innerHTML = `<li class="side-empty">${_t('k0098')}<button type="button" class="linkish" data-reload>${_t('k0013')}</button></li>`;
    return;
  }
  const list = S.projects.filter((p) => !q || [p.name, p.nameEn, p.nameZh].some((x) => String(x || '').toLowerCase().includes(q)));
  if (q && !list.length) {
    ul.innerHTML = `<li class="side-empty" role="status">${_t('k0099')}${esc($('#projectSearch').value.trim())}${_t('k0100')}<button type="button" class="linkish" data-clear-search>${_t('k0101')}</button></li>`;
    return;
  }
  ul.innerHTML = list.map((p) => `
    <li><a href="#/p/${p.projectId}" class="${S.route.projectId === p.projectId ? 'active' : ''}" ${S.route.projectId === p.projectId ? 'aria-current="page"' : ''} title="${esc(pName(p))}">
      <span class="pname">${esc(pName(p))}</span><span class="lang">${agoT(p.modified)}</span>
    </a></li>`).join('') || `<li class="side-empty">${S.projects.length ? _t('k0102') : _t('k0103')}</li>`;
}
async function ensureProject(projectId) {
  const find = () => S.projects && S.projects.find((p) => p.projectId === projectId);
  // 项目列表正在加载时等它，不再为同一个项目单独发一次请求
  if (!find() && S.projectsP) await S.projectsP;
  const hit = find();
  if (hit) { S.project = hit; return hit; }
  const r = await data('projects/read', { projectId });
  if (r.success && r.projects && r.projects[0]) S.project = r.projects[0];
  return S.project;
}

/* ================= routing ================= */
// #/  ·  #/p/1001[/code|/backtests|/research]  ·  #/p/1001/b/<id>[/orders|/logs|/code]  ·  #/p/1001/r/<jobId>
function parseRoute() {
  const h = location.hash.replace(/^#/, '');
  let m = h.match(/^\/p\/(\d+)\/b\/([a-f0-9]+)(?:\/(orders|logs|code|spec|robust))?/);
  if (m) return { view: 'backtest', projectId: +m[1], backtestId: m[2], tab: m[3] || 'overview' };
  m = h.match(/^\/p\/(\d+)\/r\/(r[0-9a-z]+)/);
  if (m) return { view: 'research', projectId: +m[1], jobId: m[2] };
  m = h.match(/^\/p\/(\d+)\/s\/(p[0-9a-z]+)/);
  if (m) return { view: 'paper', projectId: +m[1], sessionId: m[2] };
  m = h.match(/^\/p\/(\d+)\/compare(?:\/([a-f0-9,]*))?/);
  if (m) return { view: 'project', projectId: +m[1], tab: 'compare', ids: [...new Set((m[2] || '').split(',').filter(Boolean))] };
  m = h.match(/^\/p\/(\d+)\/reports(?:\/([a-z0-9-]{6,64}))?/);
  if (m) return { view: 'project', projectId: +m[1], tab: 'reports', deckId: m[2] || null };
  m = h.match(/^\/p\/(\d+)(?:\/(code|backtests|research|paper|rules))?/);
  if (m) return { view: 'project', projectId: +m[1], tab: m[2] || null };
  m = h.match(/^\/pipeline(?:\/(\d+))?$/);
  if (m) return { view: 'home', page: 'pipeline', pipeProject: m[1] ? +m[1] : null };
  m = h.match(/^\/agents\/changes(?:\/(c[a-z0-9]+))?$/);
  if (m) return { view: 'home', page: 'agents', agentsView: 'changes', changeId: m[1] || null };
  m = h.match(/^\/agents(?:\/([a-z0-9_-]+))?$/);
  if (m) return { view: 'home', page: 'agents', agentsView: m[1] || 'list' };
  return { view: 'home', data: h === '/data', journal: h === '/journal' };
}
// 同一个页面的两种写法（#/p/1 和 #/p/1/backtests）当成一样
const sameHref = (a, b) => String(a || '').replace(/\/(backtests|research|paper)$/, '') === String(b || '').replace(/\/(backtests|research|paper)$/, '');
function onRoute() {
  const nk = navKey();
  NAV.cur = location.hash;
  const back = nk.revisit && NAV.pos.has(nk.key) ? NAV.pos.get(nk.key) : null;
  const prev = S.route;
  S.route = parseRoute();
  stopPoll();
  const sameProject = prev.projectId === S.route.projectId;
  const sameBacktest = prev.backtestId && prev.backtestId === S.route.backtestId;
  if (!sameProject) { chartCache.clear(); S.project = null; S.files = null; S.backtests = null; S.research = null; S.papers = null; S.cmpSel = []; S.cmpCache = null; S.compileResult = null; S.fileSel = 'main.py'; S.codeEdit = null; }
  S.ctxOff = false;
  // 从 /research、/paper 链接进来：画好后滚到概览里对应的区块（后退回来恢复原位置时不抢）
  S.secJump = back == null && S.route.view === 'project' && (S.route.tab === 'research' || S.route.tab === 'paper') ? S.route.tab : null;
  $('#app').classList.remove('side-open');
  $('[data-nav=home]').classList.toggle('active', S.route.view === 'home' && !S.route.data && !S.route.journal && !S.route.page);
  $('[data-nav=pipeline]').classList.toggle('active', S.route.page === 'pipeline');
  $('[data-nav=agents]').classList.toggle('active', S.route.page === 'agents');
  $('[data-nav=data]').classList.toggle('active', Boolean(S.route.data));
  $('[data-nav=journal]').classList.toggle('active', Boolean(S.route.journal));
  renderProjects();
  renderCrumbs();
  renderCtx();
  if (S.route.view === 'project') { loadProjectView(sameProject && prev.view === 'project'); if (S.route.tab === 'reports' && window.HelmDecks) HelmDecks.load(S.route.projectId, S.route.deckId); }
  else if (S.route.view === 'backtest') { if (sameBacktest) { renderMain(); loadTabData(); } else loadBacktestView(); }
  else if (S.route.view === 'research') loadResearchView(prev.jobId === S.route.jobId);
  else if (S.route.view === 'paper') loadPaperView(prev.sessionId === S.route.sessionId);
  else if (S.route.journal) { renderMain(); loadJournal(); }
  else if (S.route.page === 'pipeline') {
    if (S.pipe && prev.pipeProject !== S.route.pipeProject) S.pipe.tl = null;
    if (S.route.pipeProject && prev.pipeProject !== S.route.pipeProject) S.pipeScroll = true; // 点了卡片：画好后把详情滚进视野
    renderMain(); loadPipeline();
  }
  else if (S.route.page === 'agents') { if (S.ag && prev.agentsView !== S.route.agentsView) { S.ag.dirty = false; S.ag.detail = null; } renderMain(); loadAgentsPage(); }
  else { renderMain(); loadUniverses(); if (S.route.data) loadDatasets(); }
  if (back != null) restoreScroll(back);
  else if (!(sameProject && (prev.view === S.route.view))) $('#main').scrollTop = 0;
}
// 后退 / 前进（含触控板双指滑动）回到上一页时，回到离开时看的位置，像 Safari 一样。
// 每条历史记录在 history.state 里带一个 key；新打开的页面没有 key → 从顶部开始。
const NAV = { seq: 0, pos: new Map(), want: null };
function navKey() {
  const st = history.state;
  if (st && st.helmNav) return { key: st.helmNav, revisit: true };
  const key = `${Date.now().toString(36)}-${++NAV.seq}`;
  try { history.replaceState({ ...(st || {}), helmNav: key, helmPrev: NAV.keepPrev !== undefined ? NAV.keepPrev : NAV.cur || null }, ''); } catch { /* 忽略 */ }
  NAV.keepPrev = undefined;
  return { key, revisit: false };
}
function restoreScroll(top) {
  NAV.want = { key: history.state && history.state.helmNav, top, until: Date.now() + 4000 };
  applyScrollWant();
}
// 内容是异步加载的：每次重画后再试一次，直到页面够高或超时
function applyScrollWant() {
  const w = NAV.want; const main = $('#main');
  if (!w || !main) return;
  if (Date.now() > w.until || (history.state && history.state.helmNav) !== w.key) { NAV.want = null; return; }
  main.scrollTop = w.top;
  if (main.scrollHeight - main.clientHeight >= w.top - 2 && !main.querySelector('.skeleton')) NAV.want = null;
}
function renderCrumbs() {
  const r = S.route;
  const parts = [`<a href="#/">${_t('h010')}</a>`];
  if (r.data) parts.push(_t('k0104'));
  if (r.journal) parts.push(_t('k0105'));
  if (r.page === 'pipeline') parts.push(_t('k0106'));
  if (r.page === 'agents') parts.push('<a href="#/agents">Agents</a>');
  if (r.page === 'agents' && r.agentsView === 'tasks') parts.push(_t('k0107'));
  else if (r.page === 'agents' && r.agentsView && r.agentsView !== 'list') parts.push(`<a href="#/agents/${esc(r.agentsView)}">${esc(agentOf(r.agentsView).name)}</a>`);
  if (r.projectId) parts.push(`<a href="#/p/${r.projectId}">${esc((S.project && S.project.projectId === r.projectId ? pName(S.project) : pNameById(r.projectId)) || `${_t('k0108', { projectId: r.projectId })}`)}</a>`);
  if (r.tab === 'compare') parts.push(`${_t('k0109', { projectId: r.projectId })}`, `<a href="#/p/${r.projectId}/compare/${(r.ids || []).join(',')}">${_t('k0110')}`);
  if (r.backtestId) parts.push(`<a href="#/p/${r.projectId}/b/${r.backtestId}">${esc(S.backtest?.name || _t('k0111'))}</a>`);
  if (r.sessionId) parts.push(`${_t('k0112', { projectId: r.projectId })}`, `<a href="#/p/${r.projectId}/s/${r.sessionId}">${esc(S.paper && S.paper.session && S.paper.session.sessionId === r.sessionId ? S.paper.session.name : r.sessionId)}</a>`);
  if (r.jobId) parts.push(`${_t('k0113', { projectId: r.projectId })}`, `<a href="#/p/${r.projectId}/r/${r.jobId}">${esc(S.rjob && S.rjob.jobId === r.jobId ? S.rjob.title : r.jobId)}</a>`);
  $('#crumbs').innerHTML = parts.join('<span class="sep">/</span>');
  setTitle();
}
// 浏览器标签页标题跟着当前页面走
let TAB_ZH; _regT(() => { TAB_ZH = { code: _t('k0114'), backtests: _t('k0111'), research: _t('k0115'), paper: _t('k0116'), orders: _t('k0117'), logs: _t('k0118'), rules: _t('k0119'), spec: _t('k0119'), robust: _t('k0120'), compare: _t('k0121') }; });;
// 项目名按界面语言显示：英文界面用 nameEn，中文界面用 nameZh，没有就用原来的 name（agent 建项目时会两种都给）
function pName(p) {
  if (!p) return '';
  return (HELM_I18N.lang() === 'en' ? p.nameEn : p.nameZh) || p.name || '';
}
// 想法记录、流水线里只有 projectId + 服务端给的原名：从项目列表里找到项目再按语言取名
function pNameById(id, fallback = '') {
  const n = Number(id);
  const p = (S.project && S.project.projectId === n ? S.project : null) || (S.projects || []).find((x) => x.projectId === n);
  return p ? pName(p) : fallback || '';
}
function setTitle() {
  const r = S.route;
  const proj = S.project && S.project.projectId === r.projectId ? pName(S.project) : r.projectId ? `${_t('k0108', { projectId: r.projectId })}` : '';
  let t = _t('k0122');
  if (r.data) t = _t('k0123');
  else if (r.journal) t = _t('k0124');
  else if (r.page === 'pipeline') t = _t('k0125');
  else if (r.page === 'agents') t = r.agentsView === 'tasks' ? _t('k0126') : r.agentsView && r.agentsView !== 'list' ? `${agentOf(r.agentsView).name} · Agents` : 'Agents';
  else if (r.view === 'project') t = `${proj}${r.tab && TAB_ZH[r.tab] ? ` · ${TAB_ZH[r.tab]}` : ''}`;
  else if (r.view === 'backtest') t = `${(S.backtest && S.backtest.name) || _t('k0111')}${r.tab && TAB_ZH[r.tab] ? ` · ${TAB_ZH[r.tab]}` : ''} · ${proj}`;
  else if (r.view === 'research') t = `${(S.rjob && S.rjob.jobId === r.jobId && S.rjob.title) || _t('k0127')} · ${proj}`;
  else if (r.view === 'paper') t = `${(S.paper && S.paper.session && S.paper.session.sessionId === r.sessionId && S.paper.session.name) || _t('k0116')} · ${proj}`;
  document.title = `${t} · Helm`;
}

/* ================= polling & notifications ================= */
function track(list) {
  for (const b of list || []) {
    if (!b || !b.backtestId) continue;
    const prev = S.known.get(b.backtestId);
    if (prev && isRunning(prev) && !isRunning(b)) {
      const pid = S.route.projectId;
      if (isFailed(b)) toast(`${_t('k0128', { name: b.name })}`, { label: _t('k0129'), run: () => { location.hash = `#/p/${pid}/b/${b.backtestId}`; } });
      else toast(`${_t('k0130', { name: b.name })}`, { label: _t('k0129'), run: () => { location.hash = `#/p/${pid}/b/${b.backtestId}`; } });
    }
    S.known.set(b.backtestId, { status: b.status, error: b.error });
  }
}
// 轮询只有一个所有者：S.pollTimer / S.pollFn。页面在后台时不发请求，回到前台立刻补一次；换页面时全部清掉
function pollIn(fn, ms) {
  clearTimeout(S.pollTimer);
  S.pollFn = fn;
  S.pollTimer = setTimeout(() => { if (document.hidden) return; S.pollFn = null; fn(); }, ms);
}
function stopPoll() { clearTimeout(S.pollTimer); S.pollFn = null; }
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !S.pollFn) return;
  const fn = S.pollFn;
  stopPoll();
  fn();
});
function schedulePoll() {
  stopPoll();
  const r = S.route;
  if (r.view === 'project' && Array.isArray(S.backtests) && S.backtests.some(isRunning)) {
    pollIn(() => loadProjectView(true), 2500);
  } else if (r.view === 'project' && Array.isArray(S.research) && S.research.some((j) => j.status === 'running')) {
    pollIn(() => loadProjectView(true), 5000);
  } else if (r.view === 'backtest' && r.tab === 'robust' && S.sensBt && S.sensBt.r && S.sensBt.r.sensitivity && S.sensBt.r.sensitivity.status === 'running') {
    pollIn(() => loadSens(r.backtestId, true), 2000);
  } else if (r.view === 'backtest' && r.tab === 'robust' && S.tuneBt && S.tuneBt.r && S.tuneBt.r.tuning && S.tuneBt.r.tuning.status === 'running') {
    pollIn(() => loadTune(r.backtestId), 3000);
  } else if (r.view === 'backtest' && isRunning(S.backtest)) {
    pollIn(() => loadBacktestView(true), 2000);
  } else if (r.view === 'paper' && S.paper && (S.paper.running || (S.paper.session && !S.paper.session.lastRun && S.paper.session.status === 'active'))) {
    pollIn(() => loadPaperView(true), 3000);
  } else if (r.view === 'research' && S.rjob && S.rjob.status === 'running') {
    pollIn(() => loadResearchView(true), 4000);
  } else if (r.view === 'home' && Array.isArray(S.universes) && S.universes.some((u) => u.job && u.job.status === 'running')) {
    pollIn(() => loadUniverses(true), 3000);
  }
}

/* ================= project view（QC 式工作区：回测 / 代码） ================= */
async function loadProjectView(silent = false) {
  const { projectId } = S.route;
  if (!silent) renderMain();
  const [bt, files, rs] = await Promise.all([
    data('backtests/list', { projectId }),
    data('files/read', { projectId }),
    safePost('/api/qlib/research/list', { projectId }),
    ensureProject(projectId),
    post('/api/paper/list', { projectId }).then((r) => { if (r.success) S.papers = r.sessions; else if (!Array.isArray(S.papers)) S.papers = { error: (r.errors || []).join(_t('k0007')) }; })
      .catch((e) => { if (!Array.isArray(S.papers)) S.papers = { error: e.message }; }),
  ]);
  if (S.route.view !== 'project' || S.route.projectId !== projectId) return;
  if (rs.success) {
    for (const j of rs.jobs) {
      const prev = (Array.isArray(S.research) ? S.research : []).find((x) => x.jobId === j.jobId);
      if (prev && prev.status === 'running' && j.status !== 'running') toast(`${_t('k0134', { title: j.title })}${j.status === 'complete' ? _t('k0131') : j.status === 'failed' ? _t('k0132') : _t('k0133')}`, { label: _t('k0129'), run: () => { location.hash = `#/p/${projectId}/r/${j.jobId}`; } });
    }
    S.research = rs.jobs;
  } else if (!Array.isArray(S.research)) S.research = { error: (rs.errors || []).join(_t('k0007')) };
  if (bt.success) { S.backtests = bt.backtests; track(S.backtests); } else if (!silent || !Array.isArray(S.backtests)) S.backtests = { error: (bt.errors || []).join('; ') };
  if (files.success) S.files = files.files; else if (!Array.isArray(S.files)) S.files = { error: (files.errors || []).join(_t('k0007')) };
  if (!S.route.tab) S.route.tab = 'backtests';
  // 轮询回来的数据和上次一样、页面也没换标签：不重画整页
  const sig = JSON.stringify([S.route.tab, S.route.deckId, S.route.ids, S.backtests, S.files, S.research, S.papers, S.project && S.project.modified, S.compileResult]);
  const unchanged = silent && sig === S.projSig;
  S.projSig = sig;
  if (!unchanged) { renderMain(); renderCrumbs(); renderCtx(); }
  schedulePoll();
  if (S.route.tab === 'compare') loadCompare();
}

function statusBadge(b) {
  if (isFailed(b)) return _t('k0135');
  if (isRunning(b)) {
    const p = b.progress != null ? ` ${Math.round(+b.progress * 100)}%` : '';
    return `<span class="badge run"><span class="led"></span>${/queue/i.test(b.status) ? _t('k0136') : _t('k0137')}${p}</span>`;
  }
  return _t('k0138');
}
function askItem(agentId, label, hint, text) {
  const a = agentOf(agentId);
  return `<button role="menuitem" data-ask="${agentId}" data-text="${esc(text)}"><span class="agent-dot" style="background:${a.color}"></span><span class="ai-l"><b>${esc(label)}</b><i>${esc(hint)} · ${esc(a.name)}</i></span></button>`;
}
function askBtn(agentId, label, text, primary = false) {
  const a = agentOf(agentId);
  return `<button class="btn ${primary ? 'primary' : ''}" data-ask="${agentId}" data-text="${esc(text)}" title="${_t('k0139', { v: esc(a.name) })}"><span class="agent-dot" style="background:${a.color}"></span>${esc(label)}</button>`;
}
// 「更多」菜单：次要 / 危险操作收进 ⋯，页面上只留一个主操作和少量次操作（学 macOS 工具栏的做法）
const MORE_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="12.5" cy="8" r="1.3" fill="currentColor"/></svg>';
function moreMenu(id, items) {
  const body = items.filter(Boolean).join('');
  if (!body) return '';
  return `<div class="run-wrap"><button type="button" class="btn icon-only" data-menu="${id}" aria-haspopup="menu" aria-expanded="false" aria-controls="${id}" aria-label="${_t('ux001')}" title="${_t('ux001')}">${MORE_SVG}</button><div class="run-menu more-menu" id="${id}" role="menu" hidden>${body}</div></div>`;
}
const menuItem = (attrs, label, hint = '', danger = false) => `<button type="button" role="menuitem" class="${danger ? 'danger' : ''}" ${attrs}><span class="ai-l"><b>${label}</b>${hint ? `<i>${hint}</i>` : ''}</span></button>`;
const menuSep = '<hr class="rm-sep">';
// 弹出菜单统一开关：同步 aria-expanded，打开时焦点进第一项，关闭时焦点回到触发按钮
function menuTrigger(m) { return m && document.querySelector(`[aria-controls="${m.id}"]`); }
function closeMenus(except, refocus = false) {
  document.querySelectorAll('.run-menu').forEach((x) => {
    if (x === except || x.hidden) return;
    x.hidden = true;
    const t = menuTrigger(x); if (t) { t.setAttribute('aria-expanded', 'false'); if (refocus) t.focus(); }
  });
}
function toggleMenu(m, viaKeyboard = false) {
  if (!m) return;
  const open = m.hidden;
  closeMenus(m);
  m.hidden = !open;
  const t = menuTrigger(m); if (t) t.setAttribute('aria-expanded', String(open));
  if (open && viaKeyboard) { const first = m.querySelector('button:not([disabled])'); if (first) first.focus(); }
}
function tabsHTML(base, tabs, active) {
  return `<nav class="tabs" role="tablist">${tabs.map(([id, label, count]) => `<a role="tab" aria-selected="${id === active}" class="${id === active ? 'active' : ''}" href="${base}${id === tabs[0][0] && base.includes('/b/') ? '' : `/${id}`}">${esc(label)}${count != null ? `<span class="count">${count}</span>` : ''}</a>`).join('')}</nav>`;
}

function projectHTML() {
  const { projectId, tab } = S.route;
  const p = S.project && S.project.projectId === projectId ? S.project : null;
  const bts = S.backtests;
  const count = Array.isArray(bts) ? bts.length : null;
  const stg = Array.isArray(S.backtests) && Array.isArray(S.research) ? projStage({ projectId }, { bts: S.backtests, rs: S.research, pap: Array.isArray(S.papers) ? S.papers : [] }) : null;
  const overview = isOverview(tab);
  const head = `<div class="page-head pv-head">
      <div>
        <h1>${esc(p ? pName(p) : `${_t('k0108', { projectId })}`)}</h1>
        ${p && p.description ? `<p class="sub clamp" title="${esc(p.description)}">${esc(p.description)}</p>` : ''}
        <p class="pv-meta"><span class="mono">#${esc(projectId)}</span>${p ? `<span>${_t('k0140', { v: agoT(p.modified) })}</span>` : ''}</p>
      </div>
      <div class="actions">
        <div class="run-wrap">
          <button class="btn" data-menu="askMenu" aria-haspopup="menu" aria-expanded="false" aria-controls="askMenu">${_t('k0168')}<svg viewBox="0 0 16 16" width="11" height="11"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>
          <div class="run-menu ask-menu" id="askMenu" role="menu" hidden><div class="rm-h">${_t('k0169')}</div>
            ${askItem('researcher', _t('k0141'), _t('k0142'), IDEA_ASK)}
            ${askItem('engineer', _t('k0143'), _t('k0144'), _t('k0145'))}
            ${askItem('engineer', _t('k0146'), _t('k0147'), _t('k0148'))}
            ${count > 1 ? askItem('analyst', _t('k0149'), _t('k0150'), _t('k0151')) : ''}
            ${askItem('risk', _t('k0152'), _t('k0153'), _t('k0154'))}
          </div>
        </div>
        ${moreMenu('projMore', [
    menuItem(`data-dk="new"`, _t('dk002')),
    // 完整 qlib 研究是从零找选股因子：只放在还没有回测的空项目里；已有策略的项目给「叠加 Qlib 选股」
    count ? menuItem(`data-action="layer"`, `${_t('ly_menu')}${ELL}`, _t('ly_menu_d')) : count === 0 ? menuItem(`data-action="research"`, _t('k0747')) : '',
    menuItem(`data-action="compile"`, _t('k0046'), _t('ux002')),
    menuItem(`data-action="project-rename"`, `${_t('pr_rename')}${ELL}`),
    menuSep,
    menuItem(`data-action="project-delete"`, _t('k0172'), '', true),
  ])}
        <div class="run-wrap">
          <span class="split-btn"><button class="btn ${overview ? '' : 'primary'}" data-run-role="candidate" title="${_t('ux006')}"><svg viewBox="0 0 16 16" width="12" height="12"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>${_t('k0047')}</button><button class="btn split-caret ${overview ? '' : 'primary'}" data-action="backtest" aria-haspopup="menu" aria-expanded="false" aria-controls="runMenu" aria-label="${_t('ux007')}" title="${_t('ux007')}"><svg viewBox="0 0 16 16" width="11" height="11"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></span>
          <div class="run-menu" id="runMenu" role="menu" hidden><div class="rm-h">${_t('k0170')}</div>
            ${[['candidate', _t('k0155'), _t('k0156')], ['main', _t('k0157'), _t('k0158')], ['control', _t('k0159'), _t('k0160')], ['ablation', _t('k0161'), _t('k0162')], ['benchmark', _t('k0163'), _t('k0164')], ['debug', _t('k0165'), _t('k0166')]]
    .map(([k, zh, d]) => `<button role="menuitem" data-run-role="${k}"><span class="role ${ROLE_META[k][1]}">${zh}</span><i>${d}</i></button>`).join('')}
          </div>
        </div>
      </div>
    </div>
    `;
  const tabs = flowTabsHTML(projectId, tab);
  const body = tab === 'compare' ? compareTabHTML(projectId) : tab === 'rules' ? rulesTabHTML(projectId) : tab === 'code' ? codeTabHTML() : tab === 'reports' && window.HelmDecks ? HelmDecks.tabHTML(projectId) : projOverviewHTML(projectId, stg);
  return `<div class="page">${head}${tabs}${body}</div>`;
}
// 概览 = 想法检验 + 回测 + 模拟实盘放在一页，从上到下就是项目的进展；旧链接 /research、/paper 滚到对应区块
const isOverview = (tab) => !tab || tab === 'backtests' || tab === 'research' || tab === 'paper';
// 项目状态卡：一眼看出走到哪一步、结论是什么、下一步只有一个按钮。
// 按钮不和页头重复：页头已有「运行回测」，这里永远不放它。
const CHECK_SVG = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CHEVRON_SVG = '<svg class="rl-chev" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// 验证期已经跑过且没通过：这就是结论（诊断结果由 mainSummaryHTML 异步取回，回来后整页重画）
function holdoutFailed(projectId) {
  if (!Array.isArray(S.backtests)) return false;
  const ho = S.backtests.filter((b) => b.role === 'candidate' && b.period === 'holdout' && !isRunning(b) && !isFailed(b))
    .sort((x, y) => String(y.created).localeCompare(String(x.created)))[0];
  const d = ho && S.mainDiag && S.mainDiag.key === `${projectId}:${ho.backtestId}` ? S.mainDiag.v : null;
  return Boolean(d && d.ok && !d.pass);
}
function projHero(projectId, stg) {
  if (!stg) return { html: `<div class="pv-hero"><div class="skeleton" style="height:84px"></div></div>`, asksIdea: false };
  const base = `#/p/${projectId}`;
  const rs = Array.isArray(S.research) ? S.research : [];
  const ideas = rs.filter((j) => j.mode === 'idea').sort((a, b) => String(b.created).localeCompare(String(a.created)));
  const last = ideas[0];
  const signal = ideas.find((j) => j.verdict === '有信号' || j.verdict === '信号弱');
  const step = stg.step;
  const nBt = Array.isArray(S.backtests) ? S.backtests.filter((b) => b.role !== 'debug').length : 0;
  const askIdea = (label) => `<button class="btn primary" data-ask="researcher" data-text="${esc(IDEA_ASK)}">${label}</button>`;
  const go = (label, href, bad = false) => `<a class="btn primary ${bad ? 'danger' : ''}" href="${href}">${label}</a>`;
  const link = (label, href) => `<a class="pv-link" href="${href}">${label}</a>`;
  // cur：当前在第几步（1–4）；tone：none / run / bad
  let cur; let tone = ''; let title; let desc; let act = ''; let asksIdea = false;
  if (step === 4) { cur = 4; if (stg.paperBad) { tone = 'bad'; title = _t('pv_t4b'); desc = _t('pv_d4b'); act = go(_t('ux024'), stg.next.href, true); } else { tone = 'live'; title = _t('pv_t4'); desc = _t('pv_d4'); act = go(stg.next.t, stg.next.href); } }
  else if (step === 3) { cur = 4; title = _t('pv_t3'); desc = _t('pv_d3'); act = go(stg.next.t, stg.next.href); }
  else if (step === 2 && holdoutFailed(projectId)) { cur = 3; tone = 'bad'; title = _t('pv_tHo'); desc = _t('pv_dHo'); act = askIdea(_t('k0233')); asksIdea = true; }
  else if (step === 2) { cur = 3; title = _t('pv_t2', { n: nBt }); desc = _t('pv_d2'); act = go(stg.next.t, stg.next.href); }
  else if (signal) { cur = 2; title = signal.verdict === '信号弱' ? _t('pv_tWeak') : _t('pv_tSig'); desc = _t('pv_dSig'); act = link(_t('pv_cSee'), `${base}/r/${esc(signal.jobId)}`) + go(stg.next.t, stg.next.href); }
  else if (Array.isArray(S.backtests) && S.backtests.some(isRunning)) { cur = 2; tone = 'run'; title = _t('pv_tBt'); desc = _t('pv_dBt'); }
  else if (last && last.status === 'running') { cur = 1; tone = 'run'; title = _t('pv_tRun'); desc = esc(last.idea || last.current || ''); act = link(_t('pv_cRun'), `${base}/r/${esc(last.jobId)}`); }
  else if (last && last.status === 'failed') { cur = 1; tone = 'bad'; title = _t('pv_tErr'); desc = _t('pv_dErr'); act = go(_t('ux024'), `${base}/r/${esc(last.jobId)}`); }
  else if (last) { cur = 1; tone = 'bad'; title = _t('pv_tNo'); desc = _t('pv_dNo'); act = link(_t('pv_cSee'), `${base}/r/${esc(last.jobId)}`) + askIdea(_t('k0233')); asksIdea = true; }
  else { cur = 1; title = _t('pv_t0'); desc = _t('pv_d0'); act = askIdea(_t('pv_c0')); asksIdea = true; }
  const skipped = !ideas.length && cur > 1; // 没做想法检验直接回测：第一步记为「跳过」
  const steps = [1, 2, 3, 4].map((i) => {
    const st = i < cur || (i === 4 && step === 4 && !stg.paperBad) ? (i === 1 && skipped ? 'skip' : 'done') : i === cur ? (tone === 'bad' ? 'bad' : 'cur') : 'todo';
    const mark = st === 'done' ? CHECK_SVG : `<span>${i}</span>`;
    return `<li class="pv-st ${st}" ${st === 'cur' || st === 'bad' ? 'aria-current="step"' : ''}><span class="pv-bar"></span><span class="pv-lbl"><span class="pv-n">${mark}</span>${_t(`pv_s${i}`)}${st === 'skip' ? `<em>${_t('pv_skip')}</em>` : ''}</span></li>`;
  }).join('');
  return {
    asksIdea,
    html: `<section class="pv-hero ${tone}" aria-labelledby="pvTitle">
      <ol class="pv-steps" aria-label="${_t('pv_prog')}">${steps}</ol>
      <div class="pv-main">
        <div class="pv-text"><h2 id="pvTitle">${tone === 'run' ? '<span class="led" aria-hidden="true"></span>' : ''}${title}</h2>${desc ? `<p>${desc}</p>` : ''}</div>
        ${act ? `<div class="pv-act">${act}</div>` : ''}
      </div>
    </section>`,
  };
}
function projOverviewHTML(projectId, stg) {
  const hero = projHero(projectId, stg);
  const sec = (id, title, n, act, body) => `<section class="psec" id="sec-${id}"><div class="sec-head"><h2>${title}${n ? ` <span class="meta">${n}</span>` : ''}</h2>${act ? `<div class="sec-act">${act}</div>` : ''}</div>${body}</section>`;
  const rs = S.research; const bts = S.backtests; const pap = S.papers;
  const step = stg ? stg.step : 0;
  // 想法检验：走到回测之后折叠成一行摘要；没做过就不出现（状态卡已经说清楚了，不放「还没有」）
  const ideaN = Array.isArray(rs) ? rs.length : 0;
  const rsBody = researchTabHTML(projectId);
  const rsAct = hero.asksIdea ? '' : askBtn('researcher', _t('ux033'), IDEA_ASK).replace('class="btn ', 'class="btn sm quiet ');
  const research = !Array.isArray(rs) ? sec('research', _t('k0115'), 0, '', rsBody)
    : !ideaN ? ''
      : step >= 2 ? `<details class="psec psec-fold" id="sec-research"><summary class="sec-head"><h2>${_t('k0115')} <span class="meta">${ideaN}</span></h2><span class="meta">${researchSummary(rs)}</span></summary>${rsBody}</details>`
        : sec('research', _t('k0115'), ideaN, rsAct, rsBody);
  const btN = Array.isArray(bts) ? bts.filter((b) => b.role !== 'debug').length : 0;
  const backtests = !Array.isArray(bts) || bts.length ? sec('backtests', _t('ux034'), btN, '', backtestsTabHTML(bts, projectId)) : '';
  const papN = Array.isArray(pap) ? pap.length : 0;
  const paper = step >= 3 || papN ? sec('paper', _t('k0116'), papN, '', paperTabHTML(projectId, stg)) : '';
  return `${hero.html}${research}${backtests}${paper}`;
}
function researchSummary(rs) {
  const ideas = rs.filter((j) => j.mode === 'idea');
  const good = ideas.filter((j) => j.verdict === '有信号' || j.verdict === '信号弱').length;
  return ideas.length ? _t('k0847', { n: ideas.length, good }) : '';
}

let ROLE_META; _regT(() => { ROLE_META = {
  main: [_t('k0157'), 'main'], candidate: [_t('k0174'), 'cand'], control: [_t('k0159'), 'ctrl'],
  ablation: [_t('k0161'), 'abl'], benchmark: [_t('k0163'), 'bench'], debug: [_t('k0165'), 'dbg'],
}; });
const ROLE_ORDER = ['main', 'candidate', 'control', 'ablation', 'benchmark', null, 'debug'];
let PERIOD_ZH; _regT(() => { PERIOD_ZH = { dev: _t('k0175'), holdout: _t('k0176'), full: _t('k0177') }; });
let PERIOD_TIP; _regT(() => { PERIOD_TIP = { dev: _t('k0178'), holdout: _t('k0179'), full: _t('k0180') }; });
let roleBadge; _regT(() => { roleBadge = (r) => (r && ROLE_META[r] ? `<span class="role ${ROLE_META[r][1]}">${ROLE_META[r][0]}</span>` : _t('k0181')); });
let periodTag; _regT(() => { periodTag = (p, seq) => (p && PERIOD_ZH[p] ? `<span class="period ${p === 'holdout' && seq > 1 ? 'reused' : ''}" title="${PERIOD_TIP[p]}${p === 'holdout' && seq ? `${_t('k0183', { seq })}${seq > 1 ? _t('k0182') : ''}` : ''}">${PERIOD_ZH[p]}${p === 'holdout' && seq > 1 ? ` ${_t('k0184', { seq })}` : ''}</span>` : ''); });
function roleSelect(b) {
  const opts = [['', _t('k0185')], ...Object.entries(ROLE_META).map(([k, [zh]]) => [k, zh])];
  return `<select class="role-sel ${b.role && ROLE_META[b.role] ? ROLE_META[b.role][1] : 'none'}" data-role-sel="${b.backtestId}" aria-label="${_t('k0186')}" title="${_t('k0187')}">${opts.map(([k, zh]) => `<option value="${k}" ${(b.role || '') === k ? 'selected' : ''}>${zh}</option>`).join('')}</select>`;
}

// 「设为主版本」按钮：用户自己的决定，不经过统计检验关卡（检验结果照常显示，供参考）
let setMainBtn; _regT(() => { setMainBtn = (b, label = _t('k0188')) => (b && b.role !== 'main' && b.role !== 'benchmark' && !b.ranAsBenchmark
  ? `<button type="button" class="btn" data-action="set-main" data-bid="${esc(b.backtestId)}" title="${_t('k0189')}">${label}</button>` : ''); });
let mainByUserTag; _regT(() => { mainByUserTag = (b) => (b && b.role === 'main' && b.mainBy === 'user' ? _t('k0190') : ''); });

// 主版本诊断：没过哪一项、差多少、可以怎么改。每个方案一个按钮，一次只试一个；另有固定预算的一键尝试。
let GATE_SHORT; _regT(() => { GATE_SHORT = { consistency: _t('k0191'), ci: _t('k0192'), excess: _t('k0193'), riskadj: _t('k0194'), dsr: _t('k0195'), len: _t('k0196') }; });;
function needLine(n) {
  if (n.id === 'excess' && n.needExcess != null) return `${_t('k0198', { v: pct(n.needExcess, false), v2: pct(n.haveExcess) })}${n.needTe != null ? `${_t('k0197', { v: pct(n.haveTe, false), v2: pct(n.needTe, false) })}` : ''}${_t('k0199')}`;
  if (n.id === 'ci' && n.needSharpe != null) return `${_t('k0201', { v: num(n.needSharpe), v2: num(n.haveSharpe) })}${n.needYears != null ? `${_t('k0200', { toFixed: n.needYears.toFixed(0), v: num(n.haveYears, 1) })}` : ''}${_t('k0199')}`;
  if (n.id === 'dsr') return `${_t('k0202', { v: pct(n.haveDsr, false) })} ${esc(n.trials ?? '?')} ${_t('k0203')}`;
  if (n.id === 'len') return `${_t('k0204', { v: num(n.haveYears, 1) })}`;
  if (n.id === 'consistency') return _t('k0205');
  return '';
}
let MAIN_OPTS; _regT(() => { MAIN_OPTS = {
  excess: [
    ['engineer', _t('k0206'), _t('k0207')],
    ['engineer', _t('k0208'), _t('k0209')],
    ['researcher', _t('k0210'), _t('k0211')],
  ],
  ci: [
    ['engineer', _t('k0212'), _t('k0213')],
    ['engineer', _t('k0214'), _t('k0215')],
  ],
  riskadj: [
    ['engineer', _t('k0216'), _t('k0217')],
    ['engineer', _t('k0218'), _t('k0219')],
  ],
  dsr: [['engineer', _t('k0220'), _t('k0221')]],
  len: [['engineer', _t('k0222'), _t('k0223')]],
  consistency: [['engineer', _t('k0224'), _t('k0225')]],
}; });
function optPrompt(projectId, b, n, [, t, how]) {
  return `${_t('k0226', { projectId, backtestId: b.backtestId, name: b.name })}${b.period || 'dev'}${_t('k0227')}${GATE_SHORT[n.id] || n.zh}${_t('k0228', { detail: n.detail })}${needLine(n).replace(/<[^>]+>/g, '')}
${_t('k0229', { t, how })}`;
}
function oneClickPrompt(projectId, b) {
  return `${_t('k0230', { projectId, backtestId: b.backtestId, name: b.name })}`;
}
function mainDiagHTML(projectId, b, holdout = false) {
  const key = `${projectId}:${b.backtestId}`;
  if (!S.mainDiag || S.mainDiag.key !== key) {
    S.mainDiag = { key, loading: true };
    data('backtests/validate', { projectId, backtestId: b.backtestId }).then((r) => {
      if (!S.mainDiag || S.mainDiag.key !== key) return;
      S.mainDiag = { key, v: r.success ? r.validation : null };
      if (S.route.view === 'project' && S.route.projectId === projectId) renderMain();
    }).catch(() => { S.mainDiag = { key, v: null }; });
  }
  if (S.mainDiag.loading) return _t('k0231');
  const v = S.mainDiag.v;
  if (!v || !v.ok) return '';
  if (v.pass) return `<div class="md-diag"><p class="md-sub">${_t('k0232', { v: esc(b.name) })}</p><div class="md-next">${setMainBtn(b)}</div></div>`;
  const needs = v.needs || [];
  const okN = v.gates.filter((g) => g.ok).length;
  // 验证期只能用一次：用过之后它就是最终结论，不再提供「再试一个方案」
  if (holdout) return `<div class="md-diag">
    <p class="md-verdict">${_t('k0235')}</p>
    <p class="md-sub">${_t('k0236', { projectId, backtestId: b.backtestId, v: esc(b.name), okN, n: v.gates.length })}${needs.map((n) => esc(GATE_SHORT[n.id] || n.zh)).join(_t('k0015'))}${_t('k0237')}</p>
    <div class="md-next">${setMainBtn(b, _t('k0234'))}</div>
  </div>`;
  return `<div class="md-diag">
    <p class="md-verdict">${_t('k0242')}</p>
    <div class="md-next"><span>${_t('k0243')}</span>${setMainBtn(b, `${_t('k0239', { v: esc(b.name) })}`)}</div>
    <p class="md-sub">${_t('k0244', { projectId, backtestId: b.backtestId, v: esc(b.name), v2: esc(b.name), okN, n: v.gates.length })}</p>
    ${needs.map((n) => `<div class="md-gate">
      <p class="md-why"><span class="down">✕</span> ${esc(GATE_SHORT[n.id] || n.zh)}<em>${esc(n.detail)}</em></p>
      <p class="md-need">${needLine(n)}</p>
      <ul class="md-opts">${(MAIN_OPTS[n.id] || []).map((o) => `<li><div><b>${esc(o[1])}</b><i>${esc(o[2])}</i></div>${askBtn(o[0], _t('k0240'), optPrompt(projectId, b, n, o))}</li>`).join('')}</ul>
    </div>`).join('')}
    <div class="md-all"><p>${_t('k0245')}</p>${askBtn('analyst', _t('k0241'), oneClickPrompt(projectId, b))}</div>
  </div>`;
}

// 主版本摘要：最终策略是哪个，和同期基准比怎么样
function mainSummaryHTML(bts, projectId) {
  const done = bts.filter((b) => !isRunning(b) && !isFailed(b));
  const mains = done.filter((b) => b.role === 'main');
  const cands = done.filter((b) => b.role === 'candidate');
  const benchOf = (period) => done.find((b) => b.role === 'benchmark' && b.period === period);
  const line = (b) => {
    const bm = benchOf(b.period);
    const vs = bm ? `<span class="ms-vs">${_t('k0246', { v: esc(String(bm.name || '').replace(/^(基准|Benchmark)\s*[:：]\s*/i, '')), v2: pct(bm.compoundingAnnualReturn), v3: num(bm.sharpeRatio) })}</span>` : '';
    return `${_t('k0247', { projectId, backtestId: b.backtestId, v: periodTag(b.period), v2: mainByUserTag(b), v3: esc(b.name), v4: signClass(b.compoundingAnnualReturn), v5: pct(b.compoundingAnnualReturn), v6: num(b.sharpeRatio), v7: pct(b.drawdown, false), vs })}`;
  };
  // 一句白话结论：和同期基准比，收益和风险各怎么样（新手不用自己判断 0.40 算高还是低）
  const verdictOf = (b) => {
    const bm = benchOf(b.period);
    if (!bm) return '';
    const r = parseFloat(b.compoundingAnnualReturn); const rb = parseFloat(bm.compoundingAnnualReturn);
    const d = parseFloat(b.drawdown); const db = parseFloat(bm.drawdown);
    if (![r, rb, d, db].every(Number.isFinite)) return '';
    // 年化差不到 0.05 个百分点（显示出来一样）算「和基准持平」，不说跑赢 / 落后
    const toPct = (v, n) => (/%/.test(String(v)) ? n : n * 100);
    const tie = Math.abs(toPct(b.compoundingAnnualReturn, r) - toPct(bm.compoundingAnnualReturn, rb)) < 0.05;
    const k = tie ? ['mid', d <= db ? 'ux060' : 'ux061'] : r >= rb && d <= db ? ['good', 'ux008'] : r >= rb ? ['mid', 'ux009'] : d < db ? ['mid', 'ux010'] : ['bad', 'ux011'];
    return `<span class="ms-verdict ${k[0]}">${_t(k[1])}</span>`;
  };
  const mainDev = mains.find((b) => b.period !== 'holdout') || mains[0];
  if (mains.length) return `<div class="main-sum"><div class="ms-h"><span class="role main">${_t('k0157')}</span>${verdictOf(mainDev)}</div>${mains.sort((a, b) => String(a.period).localeCompare(String(b.period))).map(line).join('')}</div>`;
  const untagged = bts.filter((b) => !b.role).length;
  const ho = cands.filter((b) => b.period === 'holdout').sort((x, y) => String(y.created).localeCompare(String(x.created)))[0];
  const best = cands.filter((b) => b.period !== 'holdout').sort((x, y) => (+y.sharpeRatio || -9) - (+x.sharpeRatio || -9))[0];
  return `<div class="main-sum empty"><div class="ms-h">${_t('k0254')}</div>
    ${ho ? mainDiagHTML(projectId, ho, true) : best ? mainDiagHTML(projectId, best) : `<p class="md-sub" style="margin-top:8px">${untagged === bts.length ? _t('k0250') : _t('k0251')}</p>`}
    <div class="ms-act" ${cands.length ? 'hidden' : ''}>${askBtn('analyst', _t('k0252'), _t('k0253'))}</div></div>`;
}

// 回测用到的 qlib 信号来自哪次研究：点击回到那次研究
function srcBadge(b, projectId) {
  const sig = b.sources && (b.sources.signals || []).find((x) => x.jobId);
  if (!sig) return '';
  const pid = sig.projectId || projectId;
  return `<a class="src-badge" href="#/p/${pid}/r/${esc(sig.jobId)}" title="${_t('k0256', { v: esc(sig.name) })}${sig.factor ? `${_t('k0255', { v: esc(sig.factor) })}` : ''}${_t('k0257', { v: esc(sig.jobId) })}">${sig.kind === 'idea' ? _t('k0115') : _t('k0127')} ${esc(sig.factor || sig.jobId)}</a>`;
}
function backtestsTabHTML(bts, projectId) {
  if (bts == null) return `<div class="panel" style="padding:16px;display:grid;gap:10px">${Array.from({ length: 4 }, () => '<div class="skeleton" style="height:18px"></div>').join('')}</div>`;
  if (bts.error) return errorBox(_t('k0258'), bts.error);
  if (!bts.length) {
    return `<p class="psec-empty">${_t('ux036')} ${_t('ux077')}</p>`;
  }
  const nDebug = bts.filter((b) => b.role === 'debug').length;
  const f = S.btFilter;
  const shown = bts.filter((b) => (f === 'all' ? true : f === 'debug' ? b.role === 'debug' : b.role !== 'debug'));
  const rank = (b) => ROLE_ORDER.indexOf(b.role || null);
  const prank = (b) => ['dev', 'holdout', 'full', null].indexOf(b.period || null);
  shown.sort((a, b) => rank(a) - rank(b) || prank(a) - prank(b) || String(b.created).localeCompare(String(a.created)));
  const chip = (k, label, n) => `<button class="fchip ${f === k ? 'active' : ''}" aria-pressed="${f === k}" data-bt-filter="${k}">${label}${n != null ? `<span>${n}</span>` : ''}</button>`;
  return `${mainSummaryHTML(bts, projectId)}
    <div class="bt-toolbar"><div class="seg-chips" role="group" aria-label="${_t('ux004')}">${chip('key', _t('k0261'), bts.length - nDebug)}${chip('all', _t('k0262'), bts.length)}${nDebug ? chip('debug', _t('k0165'), nDebug) : ''}</div>
    ${cmpBarHTML(bts, shown, projectId)}</div>
    <div class="panel"><div class="table-wrap"><table class="data"><thead><tr>
      <th class="cb"><span class="sr">${_t('k0267')}</span></th><th>${_t('k0268')}</th><th>${_t('k0270')}</th><th class="r">${_t('k0272')}</th><th class="r">${_t('k0273')}</th><th class="r">${_t('k0274')}</th><th class="r">${_t('k0117')}</th>
    </tr></thead><tbody>${shown.map((b) => `
      <tr data-href="#/p/${projectId}/b/${b.backtestId}" class="${b.role === 'debug' ? 'dim' : ''} ${b.role === 'main' ? 'is-main' : ''}">
        <td class="cb">${cmpBox(b)}</td>
        <td class="name" title="${esc(b.name)}${b.mainRejected ? `${_t('k0265')}${esc(b.mainRejected.join(_t('k0007')))}` : ''}">${b.role && ROLE_META[b.role] ? roleBadge(b.role) : ''}${periodTag(b.period, b.holdoutSeq)}${b.file ? `<span class="period mono">${esc(b.file)}</span>` : ''}${esc(b.name)}${srcBadge(b, projectId)}${doneBt(b) ? '' : ` ${statusBadge(b)}`}</td>
        <td class="when">${agoT(b.created)}</td>
        <td class="r ${signClass(b.compoundingAnnualReturn)}">${pct(b.compoundingAnnualReturn)}</td>
        <td class="r">${num(b.sharpeRatio)}</td>
        <td class="r ${b.drawdown && parseFloat(b.drawdown) ? 'down' : ''}">${pct(b.drawdown, false)}</td>
        <td class="r">${b.trades == null || Number.isNaN(+b.trades) ? '—' : (+b.trades).toLocaleString(LOC())}</td>
      </tr>`).join('') || _t('k0266')}</tbody></table></div></div>`;
}

function codeView(content) {
  const lines = String(content || '').split('\n');
  return `<div class="code"><pre class="ln" aria-hidden="true">${lines.map((_, i) => i + 1).join('\n')}</pre><pre class="src">${esc(content)}</pre></div>`;
}
let codeActions; _regT(() => { codeActions = (src, name) => `<span class="code-actions"><button type="button" class="btn sm" data-code-copy data-src="${src}" data-name="${esc(name)}">${_t('k0021', { v: esc(name) })}</button><button type="button" class="btn sm" data-code-dl data-src="${src}" data-name="${esc(name)}">${_t('k0275', { v: esc(name) })}</button></span>`; });
function codeTabHTML() {
  const files = S.files;
  if (!files) return '<div class="skeleton" style="height:320px"></div>';
  if (files.error) return errorBox(_t('k0276'), files.error);
  if (!files.length) return _t('k0277');
  const f = files.find((x) => x.name === S.fileSel) || files[0];
  const cr = S.compileResult;
  // 编译结果 = 语法 + 静态检查：logs 里先是「必须修复」（阻止回测），再是「警告」（不阻止）
  const crOk = cr && cr.state === 'BuildSuccess';
  const nWarn = cr && cr.lint ? cr.lint.warnings.length : 0;
  const crLogs = cr && cr.logs && cr.logs.length ? `<pre>${esc(cr.logs.join('\n'))}</pre>` : '';
  const compileBar = cr ? `<div class="compile ${crOk ? 'ok' : 'bad'}">${crOk ? `${_t('k0279')}${nWarn ? `${_t('k0278', { nWarn })}` : ''}` : _t('k0280')}${crLogs}</div>` : '';
  // 自己改代码：服务端有 files/update 接口时才能保存（保存后照常编译 / 回测）
  const editing = f && S.codeEdit && S.codeEdit.name === f.name;
  const tabs = files.map((x) => `<button class="${x.name === f.name ? 'active' : ''}" data-file="${esc(x.name)}">${esc(x.name)}</button>`).join('');
  if (editing) return `<div class="panel code-panel-wrap">
    <div class="file-tabs">${tabs}<span class="code-actions"><button type="button" class="btn sm" data-code-cancel>${_t('k0033')}</button><button type="button" class="btn sm primary" data-code-save>${_t('ux073')}</button></span><span class="meta">${_t('ux067')}</span></div>
    <textarea id="codeEditor" class="code-editor" spellcheck="false" autocomplete="off" aria-label="${esc(f.name)}">${esc(S.codeEdit.draft)}</textarea>
  </div>`;
  return `<div class="panel code-panel-wrap">
    <div class="file-tabs">${tabs}
      ${f ? `<button type="button" class="btn sm" data-code-edit="${esc(f.name)}">${_t('ux074')}</button>${codeActions('project', f.name)}` : ''}<button type="button" class="btn sm" data-action="compile" title="${_t('ux002')}">${_t('k0046')}</button><span class="meta">${_t('k0282')}</span></div>
    ${compileBar}
    ${f ? codeView(f.content) : _t('k0281')}
  </div>`;
}

/* ================= 规则说明（spec.md） ================= */
let SPEC_ASK; _regT(() => { SPEC_ASK = _t('k0283'); });
// 打开对话并把文字预填进输入框，不自动发送：让用户先看一眼、改一改
function prefillChat(agentId, text) {
  if (!(S.thread && S.thread.agent === agentId && !currentRunning())) {
    closeSub();
    S.agentId = agentId;
    store.set('agent', agentId);
    S.thread = null;
    renderAgents();
    renderThread();
  }
  openChat();
  const input = $('#input');
  input.value = text;
  autosize();
  updateComposer();
  input.focus();
}
let specPanel; _regT(() => { specPanel = (content, meta) => `<div class="panel section rules"><div class="panel-head"><h2>${_t('k0119')}</h2><span class="meta">${meta}</span></div><div class="md rules-md">${md(content)}</div></div>`; });
let specEmpty; _regT(() => { specEmpty = (why, extra = '') => `<div class="panel empty spec-empty"><div class="big">${_t('k0284')}</div><p>${why}</p><div class="r-btns"><button type="button" class="btn primary" data-prefill="engineer" data-text="${esc(SPEC_ASK)}">${_t('k0285')}</button>${extra}</div><p class="data-note" style="margin-top:12px">${_t('k0286')}</p></div>`; });
function rulesTabHTML() {
  const files = S.files;
  if (!files) return '<div class="skeleton" style="height:320px"></div>';
  if (files.error) return errorBox(_t('k0287'), files.error);
  const f = files.find((x) => x.name === 'spec.md');
  if (!f || !String(f.content || '').trim()) return specEmpty(_t('k0288'));
  return specPanel(f.content, _t('k0289'));
}
function specTabHTML(projectId, backtestId) {
  const sb = S.specBt && S.specBt.id === backtestId ? S.specBt : null;
  if (!sb) return '<div class="skeleton" style="height:320px"></div>';
  if (sb.error) return errorBox(_t('k0287'), sb.error);
  if (!sb.spec || !String(sb.spec).trim()) {
    const cur = Array.isArray(S.files) && S.files.some((x) => x.name === 'spec.md');
    return specEmpty(_t('k0290'), cur ? `${_t('k0291', { projectId })}` : '');
  }
  return specPanel(sb.spec, _t('k0292'));
}

/* ================= 稳健性（分段 / 成本压力 / 市场状态） ================= */
let ROB_WHY; _regT(() => { ROB_WHY = {
  seg: _t('k0293'),
  cost: _t('k0294'),
  reg: _t('k0295'),
  attr: _t('at_why'),
}; });;
let rbHead; _regT(() => { rbHead = (title, meta, key) => `<div class="panel-head"><h2>${esc(title)}</h2><span class="meta">${esc(meta)}</span><button type="button" class="gate-i" data-rob-why aria-expanded="false" aria-label="${_t('k0296', { v: esc(title) })}" title="${_t('k0297')}">ⓘ</button></div><p class="gate-why rob-why" hidden>${esc(ROB_WHY[key])}</p>`; });
const rbFact = (k, v, cls = '') => `<div class="rob-fact"><div class="k">${esc(k)}</div><div class="v ${cls}">${v}</div></div>`;
const rbBar = (x, max) => {
  if (x == null || !Number.isFinite(+x) || !(max > 0)) return '<span class="rbar" aria-hidden="true"></span>';
  const w = Math.min(50, (Math.abs(+x) / max) * 50);
  return `<span class="rbar" aria-hidden="true"><i class="${+x < 0 ? 'neg' : 'pos'}" style="width:${w.toFixed(1)}%"></i></span>`;
};
function rbSegTable(rows, first) {
  if (!rows.length) return '';
  const max = Math.max(...rows.map((y) => Math.abs(y.ret)).filter(Number.isFinite), 0);
  return `<div class="table-wrap"><table class="data rob-table"><thead><tr><th>${esc(first)}</th><th class="r">${_t('k0300')}</th><th class="r">${_t('k0301')}</th><th class="bar-h"><span class="sr">${_t('k0302')}</span></th><th class="r">${_t('k0273')}</th><th class="r">${_t('k0274')}</th><th class="r">${_t('k0163')}</th><th class="r">${_t('k0303')}</th></tr></thead><tbody>${rows.map((y) => `<tr class="static"><td>${esc(y.label)}${y.partial ? _t('k0298') : ''}<div class="when mono">${_t('k0299', { v: esc(y.start), v2: esc(y.end) })}</div></td><td class="r">${y.days}</td><td class="r ${y.ret < 0 ? 'down' : 'up'}">${pc(y.ret)}</td><td class="bar-c">${rbBar(y.ret, max)}</td><td class="r">${num(y.sharpe)}</td><td class="r">${pct(y.maxDd, false)}</td><td class="r">${pc(y.benchRet)}</td><td class="r">${pc(y.excess)}</td></tr>`).join('')}</tbody></table></div>`;
}
function rbBreakEven(c) {
  const be = c.breakEven || c.breakEvenAbs;
  if (!be) return '';
  const what = c.breakEven ? _t('k0304') : _t('k0305');
  const t = { noTrades: _t('k0306'), above: `${_t('k0307', { what })}`, already: c.breakEven ? _t('k0308') : _t('k0309'), cross: `${_t('k0310', { round: Math.round(be.bps), what })}` }[be.status];
  return t ? `<p class="rob-be"><b>${esc(t)}</b>${c.breakEven ? '' : _t('k0311')}</p>` : '';
}
/* ---- 参数敏感性：稳健性页里的一节 ---- */
let SENS_ASK; _regT(() => { SENS_ASK = _t('k0312'); });
let SENS_WHY; _regT(() => { SENS_WHY = _t('k0313'); });
const sensLabel = (v) => ({ 稳: _t('x004'), 敏感: _t('x005'), 方向翻转: _t('x006') })[v] || v;
let sensVerdict; _regT(() => { sensVerdict = (v) => `<span class="sens-v ${v === '稳' ? 'ok' : v ? 'bad' : ''}">${esc(sensLabel(v) || _t('k0314'))}</span>`; });
const sensVal = (x, isInt) => (x == null ? '—' : String(isInt ? x : +(+x).toPrecision(6)));
function sensRows(row, base) {
  const m = (x) => (x && x.status === 'ok' ? `<td class="r ${signClass(x.annualReturn)}">${pct(x.annualReturn)}</td><td class="r">${num(x.sharpe)}</td><td class="r">${pct(x.maxDrawdown, false)}</td>` : `<td class="r" colspan="3"><span class="when">${x ? esc(`${_t('k0315')}${String(x.error || '').slice(0, 80)}`) : _t('k0316')}</span></td>`);
  const mv = (lab, x, val) => `<tr class="static"><td>${lab}</td><td class="r mono">${esc(sensVal(val, row.isInt))}</td>${m(x)}</tr>`;
  return `<tr class="grp"><td colspan="5"><b>${esc(row.name)}</b> · ${sensVerdict(row.verdict)} <span class="when">${esc(row.reason || '')}</span></td></tr>
    ${mv(_t('k0317'), { status: 'ok', ...base }, row.default)}${mv(_t('k0318'), row.lo, row.lo ? row.lo.value : null)}${mv(_t('k0319'), row.hi, row.hi ? row.hi.value : null)}`;
}
function sensSectionHTML(backtestId) {
  const head = (meta) => `<div class="panel-head"><h2>${_t('k0320')}</h2><span class="meta">${esc(meta)}</span><button type="button" class="gate-i" data-rob-why aria-expanded="false" aria-label="${_t('k0321')}" title="${_t('k0297')}">ⓘ</button></div><p class="gate-why rob-why" hidden>${esc(SENS_WHY)}</p>`;
  const sb = S.sensBt && S.sensBt.id === backtestId ? S.sensBt : null;
  if (!sb) return `<div class="panel section rob-sec sens">${head(_t('k0322'))}<div class="skeleton" style="height:90px"></div></div>`;
  if (sb.error) return `<div class="panel section rob-sec sens">${head(_t('k0322'))}${errorBox(_t('k0323'), sb.error)}</div>`;
  const r = sb.r; const sn = r.sensitivity;
  const running = sn && sn.status === 'running';
  if (r.holdout) return `<div class="panel section rob-sec sens">${head(_t('k0324'))}<p class="rob-text">${_t('k0325')}</p><p class="data-note">${_t('k0326')}</p></div>`;
  const skipped = r.skipped && r.skipped.length ? `<p class="data-note">${_t('k0328')}${r.skipped.map((x) => `${_t('k0327', { v: esc(x.name), v2: esc(x.reason) })}`).join(_t('k0015'))}${_t('k0199')}</p>` : '';
  const prog = running ? `<div class="sens-live" role="status"><div class="bar"><div style="width:${Math.round((+sn.progress || 0) * 100)}%"></div></div><p class="data-note">${esc(sn.phase || _t('k0137'))} · ${Math.round((+sn.progress || 0) * 100)}${_t('k0329')}</p></div>` : '';
  const n = r.plan.length;
  const btn = `<div class="r-btns"><button type="button" class="btn primary" data-sens-run ${r.canRun ? '' : 'disabled'}>${running ? _t('k0330') : sn && sn.status === 'done' ? _t('k0331') : _t('k0332')}</button><span class="data-note">${r.canRun ? `${_t('k0333', { n })}` : esc(r.reason || '')}</span></div>`;
  if (!r.params.length && !(sn && sn.status === 'done')) {
    return `<div class="panel section rob-sec sens">${head(_t('k0334'))}<div class="empty spec-empty"><div class="big">${_t('k0335')}</div>
      <p>${_t('k0336')}</p>
      <div class="r-btns"><button type="button" class="btn primary" data-prefill="engineer" data-text="${esc(SENS_ASK)}">${_t('k0337')}</button></div>
      <p class="data-note" style="margin-top:12px">${_t('k0338')}</p>${skipped}</div></div>`;
  }
  const list = r.params.length ? `<div class="table-wrap"><table class="data rob-table"><thead><tr><th>${_t('k0339')}</th><th class="r">−20%</th><th class="r">${_t('k0340')}</th><th class="r">+20%</th></tr></thead><tbody>${r.params.map((p, i) => { const lo = r.plan.find((x) => x.id === `p${i + 1}_lo`); const hi = r.plan.find((x) => x.id === `p${i + 1}_hi`); return `<tr class="static"><td class="mono">${esc(p.name)}</td><td class="r mono">${esc(sensVal(lo && lo.value, p.isInt))}</td><td class="r mono">${esc(sensVal(p.default, p.isInt))}</td><td class="r mono">${esc(sensVal(hi && hi.value, p.isInt))}</td></tr>`; }).join('')}</tbody></table></div>` : '';
  let res = '';
  if (sn && sn.status === 'done') {
    res = `<div class="rob-sub">${_t('k0342')}${esc(sn.completed ? String(sn.completed).slice(0, 16).replace('T', ' ') : '')}${_t('k0017')}</div>
      <p class="rob-text sens-concl">${esc(sn.conclusion || '')}</p>
      <div class="table-wrap"><table class="data rob-table"><thead><tr><th>${_t('k0343')}</th><th class="r">${_t('k0344')}</th><th class="r">${_t('k0305')}</th><th class="r">${_t('k0273')}</th><th class="r">${_t('k0274')}</th></tr></thead><tbody>${sn.rows.map((row) => sensRows(row, sn.base)).join('')}</tbody></table></div>
      ${sn.dataChanged ? _t('k0341') : ''}`;
  } else if (sn && sn.status === 'error') res = errorBox(_t('k0345'), sn.error);
  return `<div class="panel section rob-sec sens">${head(sn && sn.status === 'done' ? `${_t('k0346', { variantsRun: sn.variantsRun })}` : _t('k0322'))}
    ${r.params.length > 0 && r.params.length <= r.maxParams && !(sn && sn.status === 'done') ? list : ''}${skipped}${prog}${btn}${res}
    <p class="sens-warn" role="note"><b>${_t('k0348')}</b>${esc((sn && sn.warning) || _t('k0347'))}</p></div>`;
}
async function loadSens(backtestId, silent = false) {
  const { projectId } = S.route;
  const r = await dget('backtests/sensitivity', { projectId, backtestId });
  if (S.route.backtestId !== backtestId) return;
  S.sensBt = { id: backtestId, r: r.success ? r : null, error: r.success ? null : (r.errors || []).join(_t('k0007')) };
  if (S.route.tab === 'robust') { renderMain(); schedulePoll(); }
}
/* ---------- 调参（超参数搜索）：开发期回测上的拉丁超立方搜索 + 参数平台 + PBO ---------- */
let TUNE_WHY; _regT(() => { TUNE_WHY = _t('k0349'); });
async function loadTune(backtestId) {
  const { projectId } = S.route;
  const r = await dget('backtests/tune', { projectId, backtestId });
  if (S.route.backtestId !== backtestId) return;
  S.tuneBt = { id: backtestId, r: r.success ? r : null, error: r.success ? null : (r.errors || []).join(_t('k0007')) };
  if (S.route.tab === 'robust') { renderMain(); schedulePoll(); }
}
function tuneSectionHTML(backtestId) {
  const head = (meta) => `<div class="panel-head"><h2>${_t('k0350')}</h2><span class="meta">${esc(meta)}</span><button type="button" class="gate-i" data-rob-why aria-expanded="false" aria-label="${_t('k0351')}" title="${_t('k0297')}">ⓘ</button></div><p class="gate-why rob-why" hidden>${esc(TUNE_WHY)}</p>`;
  const tb = S.tuneBt && S.tuneBt.id === backtestId ? S.tuneBt : null;
  if (!tb) return `<div class="panel section rob-sec">${head(_t('k0352'))}<div class="skeleton" style="height:70px"></div></div>`;
  if (tb.error) return `<div class="panel section rob-sec">${head(_t('k0352'))}${errorBox(_t('k0353'), tb.error)}</div>`;
  const r = tb.r; const T = r.tuning;
  const running = T && T.status === 'running';
  const fmt = (v) => Object.entries(v || {}).map(([k, x]) => `${k}=${x}`).join(_t('k0354'));
  const btn = `<div class="r-btns"><button type="button" class="btn" data-tune-run ${r.canRun ? '' : 'disabled'}>${running ? _t('k0330') : T && T.status === 'done' ? _t('k0355') : _t('k0356')}</button><span class="data-note">${r.canRun ? `${_t('k0357', { default: r.budget.default })}` : esc(r.reason || '')}</span></div>`;
  const prog = running ? `<div class="sens-live" role="status"><div class="bar"><div style="width:${Math.round((+T.progress || 0) * 100)}%"></div></div><p class="data-note">${esc(T.phase || _t('k0137'))} ${_t('k0358', { done: T.done, total: T.total, trialsAdded: T.trialsAdded })}</p></div>` : '';
  let res = '';
  if (T && T.status === 'done' && T.result) {
    const R = T.result;
    const v = R.verdict || {};
    res = `<p class="rob-text sens-concl"><b>${v.adopt ? _t('k0359') : _t('k0360')}${_t('k0365')}${esc(v.text || '')}</p>
      <div class="table-wrap"><table class="data rob-table"><thead><tr><th></th><th>${_t('k0339')}</th><th class="r">${_t('k0273')}</th><th class="r">${_t('k0366')}</th></tr></thead><tbody>
      <tr class="static"><td>${_t('k0367')}</td><td class="mono">${esc(fmt(R.default.values))}</td><td class="r">${num(R.default.sharpe)}</td><td class="r">${num(R.default.smooth)}</td></tr>
      ${R.recommended ? `<tr class="static"><td>${_t('k0361')}</td><td class="mono">${esc(fmt(R.recommended.values))}</td><td class="r">${num(R.recommended.sharpe)}</td><td class="r">${num(R.recommended.smooth)}</td></tr>` : ''}
      ${R.rawBest ? `<tr class="static"><td><span class="when">${_t('k0362')}</span></td><td class="mono">${esc(fmt(R.rawBest.values))}</td><td class="r">${num(R.rawBest.sharpe)}</td><td class="r">—</td></tr>` : ''}
      </tbody></table></div>
      <p class="data-note">${R.pbo ? `${_t('k0363', { toFixed: R.pbo.pbo.toFixed(2), S: R.pbo.S, combos: R.pbo.combos })}` : _t('k0364')} ${_t('k0368', { candidatesOk: R.candidatesOk, trialsAdded: T.trialsAdded })}${esc(R.next || '')}</p>`;
  } else if (T && T.status === 'error') res = errorBox(_t('k0369'), T.error);
  return `<div class="panel section rob-sec">${head(T && T.status === 'done' ? `${_t('k0370', { n: T.configs.length })}` : _t('k0352'))}${prog}${btn}${res}</div>`;
}
async function runTuneUI(btn) {
  const { projectId, backtestId } = S.route;
  const r = S.tuneBt && S.tuneBt.r;
  if (!r || !r.canRun) return;
  if (!(await askConfirm({ title: _t('k0356'), message: `${_t('k0371', { default: r.budget.default })}${r.params.map((p) => p.name).join(_t('k0015'))}${_t('k0372')}`, ok: _t('k0356') }))) return;
  await once(`tune-${backtestId}`, btn, async () => {
    const res = await safePost('/api/actions/tune', { projectId, backtestId });
    if (!res.success) { toast((res.errors || []).join(_t('k0007')) || _t('k0373')); return; }
    await loadTune(backtestId);
  });
}

function robustTabHTML(backtestId) {
  const rb = S.robustBt && S.robustBt.id === backtestId ? S.robustBt : null;
  if (!rb) return '<div class="skeleton" style="height:320px"></div>';
  if (rb.error) return errorBox(_t('k0374'), rb.error);
  const R = rb.robust;
  if (!R || !R.segments || !R.segments.years.length) return `<div class="panel empty"><div class="big">${_t('k0375')}</div><p>${_t('k0376')}</p></div>`;
  const sm = R.summary; const S1 = R.segments; const ss = S1.summary; const c = R.costs; const g = R.regimes;
  const concl = `<div class="panel section-first"><div class="panel-head"><h2>${_t('k0379')}</h2>${sm.short ? _t('k0377') : ''}</div>
    <p class="rob-text">${esc(sm.text)}</p>
    <p class="data-note">${_t('k0380', { v: esc(sm.start), v2: esc(sm.end), days: sm.days, toFixed: sm.years.toFixed(1) })}${sm.period === 'holdout' ? _t('k0378') : ''} ${_t('k0381')}</p>
    ${R.notes.length ? `<ul class="rob-notes">${R.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}</div>`;
  const cc = ss.concentration;
  const facts1 = `<div class="rob-facts">${rbFact(_t('k0382'), ss.positiveShare == null ? '—' : `${Math.round(ss.positiveShare * 100)}%`)}${rbFact(_t('k0383'), ss.beatShare == null ? '—' : `${Math.round(ss.beatShare * 100)}%`)}${rbFact(_t('k0384'), ss.worst ? `${esc(ss.worst.label)} · ${pc(ss.worst.ret)}` : '—', ss.worst && ss.worst.ret < 0 ? 'down' : '')}${rbFact(_t('k0385'), !cc.applicable ? '—' : cc.flag ? `<span class="down">${_t('k0386', { v: esc(cc.year), round: Math.round(cc.share * 100) })}</span>` : `${_t('k0387', { round: Math.round(cc.share * 100) })}`)}</div>`;
  const sec1 = `<div class="panel section rob-sec">${rbHead(_t('k0388'), _t('k0389'), 'seg')}${facts1}
    ${rbSegTable(S1.years, _t('k0390'))}${S1.thirds.length ? `<div class="rob-sub">${_t('k0392')}</div>${rbSegTable(S1.thirds, _t('k0391'))}` : ''}</div>`;
  let sec2;
  if (!c.available) sec2 = `<div class="panel section rob-sec">${rbHead(_t('k0393'), _t('k0394'), 'cost')}<p class="data-note">${_t('k0395')}</p></div>`;
  else {
    const hasEx = c.rows.some((x) => x.annExcess != null);
    sec2 = `<div class="panel section rob-sec">${rbHead(_t('k0393'), _t('k0396'), 'cost')}
    <div class="rob-facts">${rbFact(_t('k0397'), c.annTurnover == null ? '—' : `${(c.annTurnover * 100).toFixed(0)}%`)}${rbFact(_t('k0398'), String(c.tradeDays))}${rbFact(_t('k0399'), c.tradedValue ? `$${Math.round(c.tradedValue).toLocaleString(LOC())}` : '—')}${rbFact(_t('k0400'), c.fees == null ? '—' : `$${c.fees.toLocaleString(LOC(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${c.feesBps != null ? ` ${_t('k0401', { toFixed: c.feesBps.toFixed(1) })}` : ''}`)}</div>
    <div class="table-wrap"><table class="data rob-table"><thead><tr><th>${_t('k0405')}</th><th class="r">${_t('k0305')}</th><th class="r">${_t('k0273')}</th>${hasEx ? _t('k0402') : ''}</tr></thead><tbody>${c.rows.map((x) => `<tr class="static"><td>${x.bps ? `${_t('k0403', { bps: x.bps })}` : _t('k0404')}</td><td class="r">${pc(x.annReturn)}</td><td class="r">${num(x.sharpe)}</td>${hasEx ? `<td class="r ${x.annExcess != null && x.annExcess < 0 ? 'down' : ''}">${pc(x.annExcess)}</td>` : ''}</tr>`).join('')}</tbody></table></div>
    ${rbBreakEven(c)}<p class="data-note">${_t('k0406')}</p></div>`;
  }
  let sec3;
  if (!g.available) sec3 = `<div class="panel section rob-sec">${rbHead(_t('k0407'), _t('k0408'), 'reg')}<p class="data-note">${esc(g.reason || _t('k0395'))}</p></div>`;
  else {
    const row = (x) => `<tr class="static"><td>${esc(x.label)}</td><td class="r">${x.days}</td>${x.small ? _t('k0409') : `<td class="r">${pc(x.annReturn)}</td><td class="r">${pc(x.benchAnn)}</td><td class="r ${x.annReturn != null && x.benchAnn != null && x.annReturn < x.benchAnn ? 'down' : ''}">${x.annReturn != null && x.benchAnn != null ? pc(x.annReturn - x.benchAnn) : '—'}</td><td class="r">${num(x.sharpe)}</td>`}</tr>`;
    sec3 = `<div class="panel section rob-sec">${rbHead(_t('k0407'), `${_t('k0410', { classified: g.classified, unclassified: g.unclassified })}`, 'reg')}
    <div class="table-wrap"><table class="data rob-table"><thead><tr><th>${_t('k0269')}</th><th class="r">${_t('k0300')}</th><th class="r">${_t('k0411')}</th><th class="r">${_t('k0412')}</th><th class="r">${_t('k0413')}</th><th class="r">${_t('k0414')}</th></tr></thead><tbody>
    <tr class="grp"><td colspan="6">${_t('k0408')}</td></tr>${g.cells.map(row).join('')}
    <tr class="grp"><td colspan="6">${_t('k0415')}</td></tr>${g.marginals.map(row).join('')}</tbody></table></div>
    <p class="data-note">${_t('k0416', { v: esc(g.rule) })}</p></div>`;
  }
  return `<div class="rob">${concl}${sec1}${sec2}${sec3}${attrSectionHTML(backtestId)}${sensSectionHTML(backtestId)}${tuneSectionHTML(backtestId)}</div>`;
}

// 因子归因（只读诊断，不计入尝试次数）：收益来自哪些已知因子，剩下的 alpha 是否显著
function attrSectionHTML(backtestId) {
  const ab = S.attrBt && S.attrBt.id === backtestId ? S.attrBt : null;
  const head = rbHead(_t('at_h'), _t('at_sub'), 'attr');
  if (!ab || ab.loading) return `<div class="panel section rob-sec">${head}<div class="skeleton" style="height:120px"></div></div>`;
  if (ab.error) return `<div class="panel section rob-sec">${head}<p class="data-note">${esc(ab.error)}</p></div>`;
  const a = ab.a;
  if (!a || !a.available) return `<div class="panel section rob-sec">${head}<p class="data-note">${esc((a && a.reason) || '')}</p></div>`;
  const rows = a.exposures.map((e) => `<tr class="static"><td>${esc(e.label)}</td><td class="r ${e.significant ? 'strong' : ''}">${e.beta >= 0 ? '+' : ''}${num(e.beta)}</td><td class="r">${num(e.t)}</td><td class="r">${pc(e.contribution)}</td></tr>`).join('');
  return `<div class="panel section rob-sec">${head}
    <p class="rob-text">${esc(a.summary)}</p>
    <div class="rob-facts">${rbFact(_t('at_r2'), `${Math.round(a.r2 * 100)}%`)}${rbFact(_t('at_alpha'), `${pc(a.alpha.annual)} · t ${num(a.alpha.t)}`, a.alpha.significant ? '' : 'muted')}${rbFact(_t('at_excess'), pc(a.excessAnnual))}${rbFact(_t('at_days'), `${a.n}`)}</div>
    <div class="table-wrap"><table class="data rob-table"><thead><tr><th>${_t('at_factor')}</th><th class="r">${_t('at_beta')}</th><th class="r">t</th><th class="r">${_t('at_contrib')}</th></tr></thead><tbody>${rows}
    <tr class="static"><td>${_t('at_alpha_row')}</td><td class="r">—</td><td class="r">${num(a.alpha.t)}</td><td class="r">${pc(a.alpha.annual)}</td></tr></tbody></table></div>
    <p class="data-note">${_t('at_note', { v: esc(a.start), v2: esc(a.end), v3: esc(a.factorsEnd || '?') })}${a.stale ? ` ${_t('at_stale')}` : ''}</p></div>`;
}

async function runSens(btn) {
  const { projectId, backtestId } = S.route;
  const r = S.sensBt && S.sensBt.r;
  if (!r || !r.canRun) return;
  const n = r.plan.length;
  if (!(await askConfirm({ title: _t('k0332'), message: `${_t('k0417', { n, n2: r.params.length })}`, ok: _t('k0418') }))) return;
  await once(`sens-${backtestId}`, btn, async () => {
    const res = await safePost('/api/actions/sensitivity', { projectId, backtestId });
    if (!res.success) { toast((res.errors || []).join(_t('k0007')) || _t('k0373')); return; }
    await loadSens(backtestId);
  });
}

/* ================= 对比：勾选 2–4 个回测 ================= */
const CMP_MAX = 4;
const CMP_LETTER = ['A', 'B', 'C', 'D'];
// 线型 + 颜色双重区分：实线 / 长虚线 / 点线 / 点划线；基准是更细的圆点线
const CMP_STYLE = [{ c: '--text', dash: '', w: 2.2 }, { c: '--accent', dash: '9 4', w: 2 }, { c: '--info', dash: '1.5 4', w: 2.4 }, { c: '--text-2', dash: '10 3 2 3', w: 2 }];
const doneBt = (b) => Boolean(b) && !isRunning(b) && !isFailed(b) && /Completed/i.test(b.status || '');
let cmpBox; _regT(() => { cmpBox = (b) => {
  if (!doneBt(b)) return '';
  const on = S.cmpSel.includes(b.backtestId);
  const full = !on && S.cmpSel.length >= CMP_MAX;
  return `<input type="checkbox" id="cmp-${esc(b.backtestId)}" data-cmp="${esc(b.backtestId)}" ${on ? 'checked' : ''} ${full ? 'disabled' : ''} aria-label="${_t('k0421', { v: esc(b.name) })}" title="${full ? `${_t('k0419', { CMP_MAX })}` : _t('k0420')}">`;
}; });
// 默认建议：主版本 vs 最新候选；没有主版本就拿最近两个候选
function cmpSuggest(bts) {
  const done = bts.filter(doneBt).sort((a, b) => String(b.created).localeCompare(String(a.created)));
  const main = done.find((b) => b.role === 'main');
  const cands = done.filter((b) => b.role === 'candidate');
  if (main && cands[0]) return { ids: [main.backtestId, cands[0].backtestId], label: _t('k0422') };
  if (!main && cands.length >= 2) return { ids: [cands[1].backtestId, cands[0].backtestId], label: _t('k0423') };
  return null;
}
function cmpBarHTML(bts, shown, projectId) {
  const ids = new Set(bts.map((b) => b.backtestId));
  S.cmpSel = S.cmpSel.filter((id) => ids.has(id));
  const n = S.cmpSel.length;
  const sg = cmpSuggest(bts);
  const hint = n >= CMP_MAX ? `${_t('k0427', { CMP_MAX })}` : n ? (n < 2 ? _t('k0428') : `${_t('k0429', { n, v: CMP_MAX - n })}`) : `${_t('k0430', { CMP_MAX })}`;
  const go = n >= 2 ? `<a class="btn" href="#/p/${projectId}/compare/${S.cmpSel.join(',')}">${_t('k0424', { n })}` : `<button type="button" class="btn" disabled title="${hint}">${_t('k0121')}${n ? ` ${_t('k0425', { n })}` : ''}</button>`;
  if (!shown.some(doneBt)) return '';
  return `<div class="cmp-bar">${n ? `<span class="cmp-hint">${hint}</span>` : ''}${sg ? `<a class="linkish" href="#/p/${projectId}/compare/${sg.ids.join(',')}">${_t('k0431', { v: esc(sg.label) })}` : ''}${n ? _t('k0432') : ''}${go}</div>`;
}

const cmpBusy = new Set();
async function loadCompare() {
  const { projectId, ids } = S.route;
  if (S.route.tab !== 'compare') return;
  const cache = S.cmpCache || (S.cmpCache = new Map());
  const need = (ids || []).slice(0, CMP_MAX).filter((id) => !cache.has(`${projectId}/${id}`) && !cmpBusy.has(`${projectId}/${id}`));
  if (!need.length) return;
  await Promise.all(need.map(async (id) => {
    const key = `${projectId}/${id}`;
    cmpBusy.add(key);
    try {
      const q = { projectId, backtestId: id };
      const [rd, ch, val] = await Promise.all([data('backtests/read', q), chartsOf(projectId, id), data('backtests/validate', q)]);
      cache.set(key, rd.success
        ? { ok: true, b: rd.backtest, eq: ch.ok ? ch.equity : [], bm: ch.bmOk ? ch.benchmark.filter((p) => p[1] > 0) : [], val: val.success ? val.validation : null }
        : { ok: false, error: (rd.errors || []).join(_t('k0007')) || _t('k0433') });
    } finally { cmpBusy.delete(key); }
  }));
  if (S.route.tab === 'compare' && S.route.projectId === projectId) renderMain();
}

// 二分：第一个 / 最后一个落在 day（美东日期）范围里的点
const idxFirstGE = (pts, day) => { let lo = 0; let hi = pts.length; while (lo < hi) { const m = (lo + hi) >> 1; if (isoDay(pts[m][0]) < day) lo = m + 1; else hi = m; } return lo; };
const idxLastLE = (pts, day) => { let lo = 0; let hi = pts.length; while (lo < hi) { const m = (lo + hi) >> 1; if (isoDay(pts[m][0]) <= day) lo = m + 1; else hi = m; } return lo - 1; };
const maxDD = (pts) => { let pk = -Infinity; let dd = 0; for (const [, v] of pts) { pk = Math.max(pk, v); dd = Math.min(dd, v / pk - 1); } return dd; };
// 每个回测自己的区间；共同区间 = 最晚的起点 → 最早的终点。曲线只画共同区间，并在起点统一成 100
function cmpBuild(items) {
  const rng = items.map((it) => (it.eq.length > 1 ? { s: isoDay(it.eq[0][0]), e: isoDay(it.eq[it.eq.length - 1][0]) } : null));
  const m = { rng, same: false, lo: null, hi: null, overlap: false, lines: [], bench: null, n: 0 };
  if (rng.some((r) => !r)) return m;
  m.same = rng.every((r) => r.s === rng[0].s && r.e === rng[0].e);
  m.lo = rng.map((r) => r.s).reduce((a, b) => (a > b ? a : b));
  m.hi = rng.map((r) => r.e).reduce((a, b) => (a < b ? a : b));
  if (m.lo >= m.hi) return m;
  const clip = (pts) => {
    const i = idxFirstGE(pts, m.lo); const j = idxLastLE(pts, m.hi);
    if (j - i < 1 || !(pts[i][1] > 0)) return null;
    const base = pts[i][1];
    return pts.slice(i, j + 1).map(([t, v]) => [t, (v / base) * 100]);
  };
  const lines = items.map((it) => clip(it.eq));
  if (lines.some((l) => !l)) return m;
  m.overlap = true;
  m.lines = lines.map((pts) => ({ pts, ret: pts[pts.length - 1][1] / 100 - 1, dd: maxDD(pts) }));
  m.n = lines[0].length;
  for (const it of items) { const bp = it.bm.length > 1 ? clip(it.bm) : null; if (bp) { m.bench = { pts: bp, ret: bp[bp.length - 1][1] / 100 - 1, from: it }; break; } }
  return m;
}
const cmpPf = (x) => { const n = parseFloat(String(x ?? '').replace(/[%,$]/g, '')); return Number.isFinite(n) ? n : null; };

function cmpItems() {
  const { projectId, ids } = S.route;
  const cache = S.cmpCache || new Map();
  return (ids || []).slice(0, CMP_MAX).map((id) => {
    const c = cache.get(`${projectId}/${id}`);
    const listed = Array.isArray(S.backtests) ? S.backtests.find((b) => b.backtestId === id) : null;
    return { id, c, b: (c && c.ok && c.b) || listed || null, listed };
  });
}
function compareTabHTML(projectId) {
  const back = `${_t('k0434', { projectId })}`;
  const ids = (S.route.ids || []);
  const sg = Array.isArray(S.backtests) ? cmpSuggest(S.backtests) : null;
  if (ids.length < 2) return `${back}<div class="panel empty"><div class="big">${_t('k0436', { CMP_MAX })}</div><p>${_t('k0437')}</p>${sg ? `<a class="btn primary" href="#/p/${projectId}/compare/${sg.ids.join(',')}">${_t('k0435', { v: esc(sg.label) })}` : ''}</div>`;
  if (!Array.isArray(S.backtests)) return `${back}<div class="skeleton" style="height:320px"></div>`;
  S.cmpSel = ids.slice(0, CMP_MAX);
  const items = cmpItems();
  const lost = items.filter((it) => !it.listed);
  if (lost.length) return `${back}${errorBox(_t('k0438'), `${_t('k0439')}${lost.map((x) => x.id.slice(0, 8)).join(_t('k0015'))}${_t('k0440')}`)}`;
  const bad = items.filter((it) => !doneBt(it.listed));
  if (bad.length) return `${back}<div class="panel empty"><div class="big">${_t('k0441')}</div><p>${bad.map((x) => esc(x.listed.name)).join(_t('k0015'))} ${_t('k0442')}</p></div>`;
  if (items.some((it) => !it.c)) return `${back}<div class="skeleton" style="height:120px;margin-bottom:12px"></div><div class="skeleton" style="height:300px"></div>`;
  const failed = items.filter((it) => !it.c.ok);
  if (failed.length) return `${back}${errorBox(_t('k0258'), failed.map((f) => `${_t('k0443', { name: f.listed.name, error: f.c.error })}`).join(_t('k0007')))}`;
  const rows = items.map((it) => ({ ...it, eq: it.c.eq, bm: it.c.bm, val: it.c.val, st: it.c.b.statistics || {} }));
  const M = cmpBuild(rows);
  const range = (r) => (r ? `${r.s} → ${r.e}` : '—');
  let note;
  if (!M.rng.every(Boolean)) note = _t('k0444');
  else if (!M.overlap) note = `${_t('k0445')}`;
  else if (M.same) note = `${_t('k0446')}${range({ s: M.lo, e: M.hi })}${_t('k0447', { lo: M.lo })}`;
  else note = `${_t('k0448')}${range({ s: M.lo, e: M.hi })}${_t('k0449', { n: M.n, lo: M.lo })}`;

  const mark = (vals, best, on) => {
    if (!on || !best) return new Set();
    const nums = vals.filter((v) => v != null);
    if (nums.length < 2 || new Set(nums).size < 2) return new Set();
    const t = best === 'max' ? Math.max(...nums) : Math.min(...nums);
    return new Set(vals.map((v, i) => (v === t ? i : -1)).filter((i) => i >= 0));
  };
  const tr = (label, vals, txt, best, on, cls = '', tip = '') => {
    const bs = mark(vals, best, on);
    return `<tr class="static"><th scope="row"${tip ? ` title="${esc(tip)}"` : ''}>${label}</th>${vals.map((v, i) => `<td class="r ${cls && v != null ? (cls === 'sign' ? signClass(v) : cls) : ''} ${bs.has(i) ? 'best' : ''}">${bs.has(i) ? _t('k0450') : ''}${esc(txt[i])}</td>`).join('')}</tr>`;
  };
  const ann = rows.map((r) => cmpPf(r.st['Compounding Annual Return']));
  const shp = rows.map((r) => cmpPf(r.st['Sharpe Ratio']));
  const ddn = rows.map((r) => cmpPf(r.st.Drawdown));
  const win = rows.map((r) => (noClosedTrades(r.st) ? null : cmpPf(r.st['Win Rate'])));
  const ord = rows.map((r) => cmpPf(r.st['Total Orders']));
  const gates = rows.map((r) => (r.val && r.val.ok ? { p: r.val.gates.filter((g) => g.ok).length, t: r.val.gates.length } : null));
  const gateTip = rows.map((r) => (r.val && !r.val.ok ? r.val.reason || _t('k0451') : ''));
  const markOn = M.same;
  const ovRet = M.lines.map((l) => l.ret);
  const ovDD = M.lines.map((l) => l.dd);
  const head = rows.map((r, i) => `<th scope="col" class="cmp-col"><span class="cmp-letter" style="--c:${getCss(CMP_STYLE[i].c)}">${CMP_LETTER[i]}</span> ${roleBadge(r.listed.role)}${periodTag(r.listed.period, r.listed.holdoutSeq)}<a class="cmp-name" href="#/p/${projectId}/b/${esc(r.id)}" title="${esc(r.listed.name)}">${esc(r.listed.name)}</a></th>`).join('');
  const table = `<div class="panel section"><div class="panel-head"><h2>${_t('k0462')}</h2><span class="meta">${markOn ? _t('k0452') : _t('k0453')}</span></div>
    <div class="table-wrap"><table class="data cmp-table"><thead><tr><th scope="col"><span class="sr">${_t('k0462')}</span></th>${head}</tr></thead><tbody>
    ${tr(_t('k0305'), ann, ann.map((v) => (v == null ? '—' : pct(`${v}%`))), 'max', markOn, 'sign')}
    ${tr(_t('k0273'), shp, shp.map((v) => num(v)), 'max', markOn)}
    ${tr(_t('k0274'), ddn, ddn.map((v) => (v == null ? '—' : pct(`${v}%`, false))), 'min', markOn, 'down')}
    ${tr(_t('k0454'), win, win.map((v) => (v == null ? '—' : pct(`${v}%`, false, 0))), 'max', markOn, '', _t('k0455'))}
    ${tr(_t('k0456'), ord, ord.map((v) => (v == null ? '—' : v.toLocaleString(LOC()))), null, false)}
    ${tr(_t('k0457'), gates.map((g) => (g ? g.p : null)), gates.map((g, i) => (g ? `${g.p}/${g.t}` : '—')), 'max', markOn && gates.every((g) => g && g.t === gates[0].t), '', gateTip.find(Boolean) || '')}
    <tr class="static"><th scope="row">${_t('k0463')}</th>${M.rng.map((r, i) => `<td class="r cmp-range">${esc(range(r))}</td>`).join('')}</tr>
    ${M.overlap && !M.same ? `${tr(_t('k0458'), ovRet, ovRet.map((v) => pct(v)), 'max', true, 'sign', _t('k0459'))}${tr(_t('k0460'), ovDD, ovDD.map((v) => (v == null ? '—' : pct(Math.abs(v), false))), 'max', true, 'down', _t('k0461'))}` : ''}
    <tr class="static cmp-act"><th scope="row"><span class="sr">${_t('ux017')}</span></th>${rows.map((r) => `<td class="r">${r.listed.role === 'main' ? `<span class="role main">${_t('k0157')}</span>` : setMainBtn(r.listed) ? setMainBtn(r.listed).replace('class="btn"', 'class="btn sm"') : ''}</td>`).join('')}</tr>
    </tbody></table></div></div>`;

  let chart = '';
  if (M.overlap) {
    const legend = rows.map((r, i) => `<li><svg class="swg" width="26" height="8" viewBox="0 0 26 8" aria-hidden="true"><line x1="1" x2="25" y1="4" y2="4" stroke="${getCss(CMP_STYLE[i].c)}" stroke-width="${CMP_STYLE[i].w}" ${CMP_STYLE[i].dash ? `stroke-dasharray="${CMP_STYLE[i].dash}" stroke-linecap="round"` : ''}/></svg><b class="cmp-letter-t">${CMP_LETTER[i]}</b> <span title="${esc(r.listed.name)}">${esc(r.listed.name)}</span> <em class="mono ${signClass(M.lines[i].ret)}">${pct(M.lines[i].ret)}</em></li>`).join('')
      + (M.bench ? `<li><svg class="swg" width="26" height="8" viewBox="0 0 26 8" aria-hidden="true"><line x1="1" x2="25" y1="4" y2="4" stroke="${getCss('--muted')}" stroke-width="1.3" stroke-dasharray="1 3.5" stroke-linecap="round"/></svg>${_t('k0464', { v: CMP_LETTER[rows.indexOf(M.bench.from)], v2: signClass(M.bench.ret), v3: pct(M.bench.ret) })}</li>` : '');
    chart = `<div class="panel section"><div class="panel-head"><h2>${_t('k0465')}</h2><span class="meta">${_t('k0466')}</span></div>
      <ul class="cmp-legend">${legend}</ul><div class="chart-wrap" id="cmpChart"></div></div>`;
  }
  return `${back}<p class="cmp-note">${note}</p>${chart}${table}`;
}
function drawCompare() {
  const el = $('#cmpChart');
  if (!el) return;
  const items = cmpItems();
  if (items.some((it) => !it.c || !it.c.ok)) return;
  const M = cmpBuild(items.map((it) => ({ ...it, eq: it.c.eq, bm: it.c.bm })));
  if (!M.overlap) return;
  const trunc = (t, n) => (t.length > n ? `${t.slice(0, n)}…` : t);
  const series = M.lines.map((l, i) => ({
    label: `${CMP_LETTER[i]}`, short: CMP_LETTER[i], tipLabel: `${CMP_LETTER[i]} ${trunc(items[i].listed.name, 14)}`,
    color: getCss(CMP_STYLE[i].c), pts: l.pts, dashArray: CMP_STYLE[i].dash, width: CMP_STYLE[i].w, endLabel: `${CMP_LETTER[i]} ${l.pts[l.pts.length - 1][1].toFixed(0)}`,
  }));
  if (M.bench) series.push({ label: _t('k0163'), short: _t('k0163'), tipLabel: _t('k0163'), color: getCss('--muted'), pts: M.bench.pts, dashArray: '1 3.5', width: 1.3, endLabel: `${_t('k0467', { toFixed: M.bench.pts[M.bench.pts.length - 1][1].toFixed(0) })}` });
  lineChart(el, series, { height: 300, padR: narrow() ? 58 : 76, noLegend: true, fmt: (v) => v.toFixed(0), tipFmt: (v) => v.toFixed(1), empty: _t('k0468'), aria: `${_t('k0469')}${series.map((s) => s.tipLabel).join(_t('k0015'))}${_t('k0470')}` });
}

/* ================= backtest view（概览 / 订单 / 日志 / 代码） ================= */
async function loadBacktestView(silent = false) {
  const { projectId, backtestId } = S.route;
  if (!silent) { S.orderSort = null; S.backtest = null; S.charts = null; S.orders = null; S.logs = null; S.code = null; S.robustBt = null; S.attrBt = null; S.sensBt = null; S.tuneBt = null; S.validation = null; renderMain(); }
  ensureProject(projectId).then(() => { renderCrumbs(); renderCtx(); });
  const r = await data('backtests/read', { projectId, backtestId });
  if (S.route.backtestId !== backtestId) return;
  if (!r.success) { S.backtest = { loadError: (r.errors || []).join('; ') }; renderMain(); return; }
  const wasRunning = isRunning(S.backtest);
  S.backtest = r.backtest;
  track([S.backtest]);
  renderMain();
  renderCrumbs();
  renderCtx();
  if (!isRunning(S.backtest) && (!S.charts || wasRunning)) { S.charts = null; S.orders = null; loadCharts(); loadTabData(); }
  schedulePoll();
}

function normPoints(values) {
  const arr = Array.isArray(values) ? values : Object.values(values || {});
  const out = [];
  for (const p of arr) {
    let t; let v;
    if (Array.isArray(p)) { t = p[0]; v = p[p.length - 1]; } else if (p && typeof p === 'object') { t = p.x ?? p.time; v = p.y ?? p.close ?? p.value; }
    t = +t; v = +v;
    if (Number.isFinite(t) && Number.isFinite(v)) out.push([t > 1e12 ? t / 1000 : t, v]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}
function pickSeries(chart, prefer) {
  if (!chart || !chart.series) return [];
  const s = prefer.map((n) => chart.series[n]).find(Boolean) || Object.values(chart.series)[0];
  return normPoints(s && s.values);
}
// 权益曲线 + 基准：结果页和对比页共用一份内存缓存（回测完成后不会变）。最多留 6 个，换项目时清空；失败的不缓存
const chartCache = new Map();
function chartsOf(projectId, backtestId) {
  const k = `${projectId}/${backtestId}`;
  let hit = chartCache.get(k);
  if (hit) { chartCache.delete(k); chartCache.set(k, hit); return hit; }
  hit = Promise.all([
    data('backtests/chart/read', { projectId, backtestId, name: 'Strategy Equity' }),
    data('backtests/chart/read', { projectId, backtestId, name: 'Benchmark' }),
  ]).then(([eq, bm]) => ({ ok: eq.success, equity: pickSeries(eq.chart, ['Equity']), benchmark: pickSeries(bm.chart, ['Benchmark']), bmOk: bm.success }));
  chartCache.set(k, hit);
  hit.then((v) => { if (!(v.ok && v.bmOk) && chartCache.get(k) === hit) chartCache.delete(k); });
  while (chartCache.size > 6) chartCache.delete(chartCache.keys().next().value);
  return hit;
}
async function loadCharts() {
  const { projectId, backtestId } = S.route;
  const [ch, orders, val] = await Promise.all([
    chartsOf(projectId, backtestId),
    data('backtests/orders/read', { projectId, backtestId, start: 0, end: 500 }),
    data('backtests/validate', { projectId, backtestId }),
  ]);
  if (S.route.backtestId !== backtestId) return;
  S.validation = val.success ? val.validation : null;
  S.charts = { equity: ch.equity, benchmark: ch.benchmark };
  S.orders = orders.success ? orders : null;
  S.ordersError = orders.success ? null : (orders.errors || []).join(_t('k0007'));
  renderMain();
}
async function loadTabData() {
  const { projectId, backtestId, tab } = S.route;
  if (tab === 'logs' && !S.logs) {
    const r = await data('backtests/log/read', { projectId, backtestId, start: 0, end: 2000 });
    S.logs = r.success ? r : { logs: [], length: 0, error: (r.errors || []).join('; ') };
    if (S.route.backtestId === backtestId) renderMain();
  }
  if (tab === 'spec' && (!S.specBt || S.specBt.id !== backtestId)) {
    const r = await dget('backtests/spec', { projectId, backtestId });
    S.specBt = { id: backtestId, spec: r.success ? r.spec : undefined, error: r.success ? null : (r.errors || []).join(_t('k0007')) };
    if (S.route.backtestId === backtestId) renderMain();
  }
  if (tab === 'robust' && (!S.robustBt || S.robustBt.id !== backtestId)) {
    const r = await dget('backtests/robust', { projectId, backtestId });
    S.robustBt = { id: backtestId, robust: r.success ? r.robust : null, error: r.success ? null : (r.errors || []).join(_t('k0007')) };
    if (S.route.backtestId === backtestId) renderMain();
  }
  if (tab === 'robust' && (!S.attrBt || S.attrBt.id !== backtestId)) {
    // 因子归因：第一次要下载 French 因子数据（几秒），之后缓存 7 天
    S.attrBt = { id: backtestId, loading: true };
    dget('backtests/attribution', { projectId, backtestId }).then((r) => {
      S.attrBt = { id: backtestId, a: r.success ? r.attribution : null, error: r.success ? null : (r.errors || []).join(_t('k0007')) };
      if (S.route.backtestId === backtestId && S.route.tab === 'robust') renderMain();
    });
  }
  if (tab === 'robust' && (!S.sensBt || S.sensBt.id !== backtestId)) loadSens(backtestId);
  if (tab === 'robust' && (!S.tuneBt || S.tuneBt.id !== backtestId)) loadTune(backtestId);
  if (tab === 'code' && !S.code) {
    const r = await data('backtests/code/read', { projectId, backtestId });
    S.code = r.success ? r.files : { error: (r.errors || []).join(_t('k0007')) };
    if (S.route.backtestId === backtestId) renderMain();
  }
}

const KPI_KEYS = [
  ['Net Profit', true], ['Compounding Annual Return', true], ['Sharpe Ratio', false],
  ['Drawdown', 'dd'], ['Win Rate', false], ['Total Orders', false],
];

// LEAN 统计项的中文名（悬停显示英文原名）
let STAT_ZH; _regT(() => { STAT_ZH = {
  'Total Orders': _t('k0471'), 'Average Win': _t('k0472'), 'Average Loss': _t('k0473'), 'Compounding Annual Return': _t('k0305'),
  Drawdown: _t('k0274'), Expectancy: _t('k0474'), 'Start Equity': _t('k0475'), 'End Equity': _t('k0476'), 'Net Profit': _t('k0271'),
  'Sharpe Ratio': _t('k0477'), 'Sortino Ratio': _t('k0478'), 'Probabilistic Sharpe Ratio': _t('k0479'), 'Loss Rate': _t('k0480'),
  'Win Rate': _t('k0454'), 'Profit-Loss Ratio': _t('k0481'), Alpha: 'Alpha', Beta: 'Beta', 'Annual Standard Deviation': _t('k0482'),
  'Annual Variance': _t('k0483'), 'Information Ratio': _t('k0484'), 'Tracking Error': _t('k0485'), 'Treynor Ratio': _t('k0486'),
  'Total Fees': _t('k0487'), 'Estimated Strategy Capacity': _t('k0488'), 'Lowest Capacity Asset': _t('k0489'),
  'Portfolio Turnover': _t('k0490'), 'Drawdown Recovery': _t('k0491'), 'Total Net Profit': _t('k0492'),
}; });;
const statName = (k) => STAT_ZH[k] || k;
// 这些指标只统计“已平仓交易”；持仓从没清零时 LEAN 全给 0，显示成 0 会误导
const TRADE_STATS = new Set(['Average Win', 'Average Loss', 'Expectancy', 'Loss Rate', 'Win Rate', 'Profit-Loss Ratio']);
const noClosedTrades = (stats) => ['Win Rate', 'Loss Rate'].every((k) => parseFloat(stats[k]) === 0) && parseFloat(stats['Total Orders']) > 0;
const money = (v, short = false) => {
  const n = parseFloat(String(v).replace(/[$,]/g, ''));
  if (Number.isNaN(n)) return v;
  if (short) return Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${n.toFixed(0)}`;
  return `$${n.toLocaleString(LOC(), { maximumFractionDigits: 2 })}`;
};
const MONEY_STATS = new Set(['Start Equity', 'End Equity', 'Total Fees', 'Estimated Strategy Capacity']);
function statValue(k, v, stats) {
  if (TRADE_STATS.has(k) && noClosedTrades(stats)) return { v: '—', tip: _t('k0493') };
  if (MONEY_STATS.has(k)) return { v: money(v) };
  if (typeof v === 'string' && /^-?[\d.]+%$/.test(v.trim())) return { v: pct(v, false) };
  if (typeof v === 'string' && /^-?\d+\.\d{3,}$/.test(v.trim())) return { v: num(v, 2) };
  if (typeof v === 'string' && /^\d{4,}$/.test(v.trim())) return { v: (+v).toLocaleString(LOC()) };
  return { v };
}

/* ---- QC 式滚动窗口指标：从权益曲线算 ---- */
function normCdf(x) {
  // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}
function trailingStats(eq, stats) {
  const d = dailySeries(eq);
  const out = { m3: null, y1sharpe: null, y5psr: null, y5dd: null, y5cagr: null, capacity: stats['Estimated Strategy Capacity'] ? money(stats['Estimated Strategy Capacity'], true) : null };
  if (d.length < 3) return out;
  const end = d[d.length - 1][0];
  const span = (end - d[0][0]) / 86400;
  const win = (days) => (span >= days * 0.97 ? d.filter((p) => p[0] >= end - days * 86400) : null);
  const rets = (a) => a.slice(1).map((p, i) => p[1] / a[i][1] - 1);
  const moments = (r) => {
    const n = r.length;
    const m = r.reduce((s, x) => s + x, 0) / n;
    const sd = Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1));
    const skew = r.reduce((s, x) => s + (x - m) ** 3, 0) / n / sd ** 3;
    const kurt = r.reduce((s, x) => s + (x - m) ** 4, 0) / n / sd ** 4;
    return { n, m, sd, skew, kurt };
  };
  const m3 = win(91);
  if (m3) out.m3 = m3[m3.length - 1][1] / m3[0][1] - 1;
  const y1 = win(365);
  if (y1 && y1.length > 20) out.y1sharpe = sharpeLean(rets(y1), impliedRf(stats));
  const y5 = win(365 * 5);
  if (y5 && y5.length > 60) {
    const { n, m, sd, skew, kurt } = moments(rets(y5));
    if (sd > 0) {
      const sr = m / sd;
      const den = Math.sqrt(Math.max(1e-12, 1 - skew * sr + ((kurt - 1) / 4) * sr * sr));
      out.y5psr = normCdf((sr * Math.sqrt(n - 1)) / den);
    }
    let peak = -Infinity; let dd = 0;
    for (const [, v] of y5) { peak = Math.max(peak, v); dd = Math.max(dd, 1 - v / peak); }
    out.y5dd = dd;
    const yr = (t) => new Date(t * 1000).getUTCFullYear();
    out.y5range = `${yr(y5[0][0])}–${yr(y5[y5.length - 1][0])}`;
    const yrs = (y5[y5.length - 1][0] - y5[0][0]) / 86400 / 365.25;
    out.y5cagr = (y5[y5.length - 1][1] / y5[0][1]) ** (1 / yrs) - 1;
  }
  return out;
}
// 每个交易日一个点。LEAN 图表连周末也有点（数值不变），按纽约日期去掉周六周日，否则年化会偏低
function dailySeries(pts) {
  const byDay = new Map();
  for (const p of pts) {
    const d = Math.floor((p[0] - 4 * 3600) / 86400);
    const dow = (d + 4) % 7;
    if (dow !== 0 && dow !== 6) byDay.set(d, p);
  }
  return [...byDay.values()];
}
// LEAN 的夏普 = (几何年化的日均收益 − 无风险利率) / 年化波动。
// 从回测自己的夏普反推 LEAN 用的平均无风险利率，再用同一个利率算基准和滚动窗口，保证口径和 KPI 一致。
function sharpeLean(r, rf) {
  if (r.length < 3) return null;
  const m = r.reduce((a, x) => a + x, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / (r.length - 1));
  return sd > 0 ? (((1 + m) ** 252 - 1) - rf) / (sd * Math.sqrt(252)) : null;
}
const dailyRets = (d) => d.slice(1).map((p, i) => p[1] / d[i][1] - 1);
function impliedRf(stats) {
  if (!S.charts || !S.charts.equity.length) return 0;
  const r = dailyRets(dailySeries(S.charts.equity));
  const sr = parseFloat(stats && stats['Sharpe Ratio']);
  if (r.length < 30 || !Number.isFinite(sr)) return 0;
  const m = r.reduce((a, x) => a + x, 0) / r.length;
  const sdStat = parseFloat(stats['Annual Standard Deviation']);
  const sd = Number.isFinite(sdStat) && sdStat > 0 ? sdStat : Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / (r.length - 1)) * Math.sqrt(252);
  const rf = ((1 + m) ** 252 - 1) - sr * sd;
  return Number.isFinite(rf) && rf > -0.02 && rf < 0.12 ? rf : 0;
}
function perf(d, rf = 0) {
  if (d.length < 3) return null;
  const yrs = (d[d.length - 1][0] - d[0][0]) / 86400 / 365.25;
  const r = d.slice(1).map((p, i) => p[1] / d[i][1] - 1);
  const m = r.reduce((a, x) => a + x, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / (r.length - 1));
  let peak = -Infinity; let dd = 0;
  for (const [, v] of d) { peak = Math.max(peak, v); dd = Math.max(dd, 1 - v / peak); }
  return { cagr: yrs > 0 ? (d[d.length - 1][1] / d[0][1]) ** (1 / yrs) - 1 : null, dd, sharpe: sd > 0 ? sharpeLean(r, rf) : null, yrs };
}
// 一句话结论：同期跑赢还是跑输 SPY，用什么代价
function verdictHTML(stats) {
  if (!S.charts || !S.charts.equity.length || !S.charts.benchmark.length) return '';
  const eq = dailySeries(S.charts.equity);
  const t0 = eq[0][0];
  const t1 = eq[eq.length - 1][0];
  const bm = dailySeries(S.charts.benchmark.filter((p) => p[1] > 0 && p[0] >= t0 && p[0] <= t1));
  const rf = impliedRf(stats);
  const a = perf(eq, rf); const b = perf(bm, rf);
  // 策略和基准的夏普必须同一算法（同一序列频率、同一无风险利率、同一年化）：不再用 LEAN 的夏普替换策略这一边，
  // 否则买入持有 SPY 也会显示「夏普 0.48 vs 0.41」
  if (!a || !b) return ''; // 少于 3 个交易日：perf 返回 null
  if ( a.cagr == null || b.cagr == null) return '';
  const p2 = (v) => pct(v, false);
  const gap = Math.abs(a.cagr - b.cagr) * 100;
  // 差距不到 0.05 个百分点（显示出来是 0.0）算打平，不说「跑赢」
  if (gap < 0.05) return `<div class="verdict mixed" title="${_t('k0499', { toFixed: a.yrs.toFixed(1), toFixed2: (rf * 100).toFixed(1) })}"><div class="vd-h">${esc(_t('vd_tie'))}</div></div>`;
  const beat = a.cagr > b.cagr;
  const ddBetter = a.dd < b.dd;
  const shBetter = a.sharpe != null && b.sharpe != null && a.sharpe > b.sharpe;
  let head;
  if (beat && !ddBetter) head = `${_t('k0494', { toFixed: gap.toFixed(1) })}`;
  else if (beat) head = `${_t('k0495', { toFixed: gap.toFixed(1) })}`;
  else if (ddBetter && shBetter) head = `${_t('k0496', { toFixed: gap.toFixed(1) })}`;
  else if (ddBetter) head = `${_t('k0497', { toFixed: gap.toFixed(1) })}`;
  else head = `${_t('k0498', { toFixed: gap.toFixed(1) })}`;
  // 统计检验没过时，跑赢只是「看起来」：标题里直说，免得和下面的 ✗ 打架
  const notSig = beat && S.validation && S.validation.ok && !S.validation.pass;
  if (notSig) head += _t('ux013');
  const tone = notSig ? 'mixed' : beat && (ddBetter || shBetter) ? 'good' : !beat && !ddBetter ? 'bad' : 'mixed';
  // 差距小到显示出来几乎一样（回撤 < 0.05 个百分点、夏普 < 0.05）：不标好坏色
  const row = (k, x, y, better, tie = false, tip = '') => `<span class="vd-m"${tip ? ` title="${esc(tip)}"` : ''}><i>${k}</i><b class="${tie ? '' : better ? 'up' : 'down'}">${x}</b><em>vs ${y}</em></span>`;
  return `<div class="verdict ${tone}" title="${_t('k0499', { toFixed: a.yrs.toFixed(1), toFixed2: (rf * 100).toFixed(1) })}">
    <div class="vd-h">${esc(head)}</div>
    <div class="vd-row">${row(_t('k0272'), p2(a.cagr), p2(b.cagr), beat)}${row(_t('k0274'), p2(a.dd), p2(b.dd), ddBetter, Math.abs(a.dd - b.dd) * 100 < 0.05)}${a.sharpe != null && b.sharpe != null ? row(_t('k0273'), num(a.sharpe), num(b.sharpe), shBetter, Math.abs(a.sharpe - b.sharpe) < 0.05, _t('ux083')) : ''}<span class="vd-note">${_t('k0500', { toFixed: a.yrs.toFixed(1) })}</span></div>
  </div>`;
}
function trailingHTML(stats) {
  if (!S.charts || !S.charts.equity.length) return '';
  const t = trailingStats(S.charts.equity, stats);
  const short = _t('k0501');
  // colored：true = 收益（小数，|x| < 0.05% 不上色）；数字 = 自定阈值（夏普用 0.05）
  const cell = (label, v, fmt, tip, colored = true) => {
    const ok = v != null && Number.isFinite(v);
    return `<div class="tr-cell" title="${esc(tip)}"><div class="v ${ok && colored ? signClass(v, colored === true ? 0.0005 : colored) : ''}">${ok ? fmt(v) : '—'}</div><div class="k">${label}</div></div>`;
  };
  const p2 = (v) => pct(v, false);
  const ps = (v) => pct(v, true);
  const r5 = t.y5range ? `${_t('k0502', { y5range: t.y5range })}` : '';
  return `<div class="trailing" aria-label="${_t('k0514')}">
    ${cell(_t('k0503'), t.m3, ps, t.m3 == null ? short : _t('k0504'))}
    ${cell(_t('k0505'), t.y1sharpe, (v) => num(v), t.y1sharpe == null ? short : `${_t('k0506')}. ${_t('ux062')}`, 0.05)}
    ${cell(_t('k0507'), t.y5psr, p2, t.y5psr == null ? short : `${_t('k0508')} ${_t('ux062')}`, false)}
    ${t.y5range ? `<div class="tr-range">${_t('k0509', { y5range: t.y5range })}</div>` : ''}${cell(_t('k0510'), t.y5dd, p2, t.y5dd == null ? short : `${_t('k0511', { r5 })}`, false)}
    ${cell(_t('k0512'), t.y5cagr, ps, t.y5cagr == null ? short : `${_t('k0513', { r5 })}`)}
    <div class="tr-cell" title="${_t('k0515')}"><div class="v">${t.capacity ? esc(t.capacity) : '—'}</div><div class="k">${_t('k0516')}</div></div>
  </div>`;
}

// 回测详情的操作：一个「下一步」主按钮 + 至多一个次按钮，其余收进 ⋯
function btActions(b) {
  const done = !isRunning(b) && !isFailed(b) && /Completed/.test(b.status || '');
  const failedChecks = S.validation && S.validation.ok && !S.validation.pass;
  const paperBtn = done ? _t('k0518') : '';
  const diag = askBtn('analyst', _t('k0521'), _t('k0522'), true);
  const interpret = askBtn('analyst', _t('k0523'), _t('k0524'), !(done && b.role === 'main'));
  const improve = menuItem(`data-ask="engineer" data-text="${esc(_t('k0520'))}"`, _t('k0519'));
  if (!done) return `${moreMenu('btMore', [improve])}${interpret}`;
  if (b.role === 'main') return `${moreMenu('btMore', [improve, menuItem(`data-ask="analyst" data-text="${esc(_t('k0524'))}"`, _t('k0523'))])}${failedChecks ? `${paperBtn}${diag}` : paperBtn.replace('class="btn"', 'class="btn primary"')}`;
  const more = [improve, paperBtn ? menuItem('data-action="paper-new"', _t('k0116')) : '', failedChecks ? menuItem(`data-ask="analyst" data-text="${esc(_t('k0524'))}"`, _t('k0523')) : ''];
  return `${moreMenu('btMore', more)}${setMainBtn(b)}${failedChecks ? diag : interpret}`;
}
function backtestHTML() {
  const { projectId, backtestId, tab } = S.route;
  const b = S.backtest;
  if (!b) return `<div class="page"><div class="skeleton" style="height:28px;width:40%;margin-bottom:22px"></div><div class="skeleton" style="height:84px"></div><div class="skeleton" style="height:300px;margin-top:18px"></div></div>`;
  if (b.loadError) return `<div class="page">${errorBox(_t('k0258'), b.loadError)}</div>`;
  const stats = b.statistics || {};
  const head = `<div class="page-head">
      <div>
        <div class="eyebrow">${_t('k0525', { v: esc(backtestId.slice(0, 10)), v2: statusBadge(b), v3: !isRunning(b) && !isFailed(b) ? roleSelect(b) : roleBadge(b.role), v4: mainByUserTag(b), v5: periodTag(b.period, b.holdoutSeq), v6: fpWarnBadge(b), v7: agoT(b.created) })}</div>
        <h1>${esc(b.name || _t('k0111'))}</h1>
        ${b.note ? `<p class="sub">${esc(b.note)}</p>` : ''}
      </div>
      <div class="actions">${btActions(b)}
      </div>
    </div>`;

  if (isRunning(b)) {
    const p = b.progress != null ? Math.round(+b.progress * 100) : 0;
    return `<div class="page">${head}<div class="panel" style="padding:22px 20px">
      <div style="display:flex;justify-content:space-between;margin-bottom:10px"><span>${/queue/i.test(b.status) ? _t('k0526') : `${esc(b.phase || _t('k0527'))}…`}</span><span class="mono">${p}%</span></div>
      <div class="bar"><div style="width:${p}%"></div></div>
      <p class="sub" style="margin-top:12px">${_t('k0528')} <a href="#/p/${projectId}/code">${_t('ux019')} →</a></p>
      ${Array.isArray(b.logTail) && b.logTail.length ? `<details class="pp-details live-log" open><summary>${_t('ux018')}</summary><pre class="logs" style="max-height:200px">${esc(b.logTail.join('\n'))}</pre></details>` : ''}</div></div>`;
  }
  const errBox = isFailed(b) ? `<div class="error-box" style="margin-bottom:18px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><b>${_t('k0531')}</b>${askBtn('engineer', _t('k0529'), _t('k0530'), true)}</div>
      <pre>${esc(zhErr(b.error || ''))}${b.stacktrace && b.stacktrace !== b.error ? `\n${esc(zhErr(b.stacktrace))}` : ''}</pre></div>` : '';
  const kpis = `<div class="kpis">${KPI_KEYS.map(([k, colored]) => {
    const { v, tip } = stats[k] == null ? { v: '—' } : statValue(k, stats[k], stats);
    const cls = colored === true ? signClass(v) : colored === 'dd' && v && parseFloat(v) ? 'down' : '';
    return `<div class="kpi" title="${esc(tip || k)}"><div class="k">${statName(k)}</div><div class="v ${cls}">${esc(v)}</div></div>`;
  }).join('')}</div>${trailingHTML(stats)}`;
  const invalid = S.orders ? S.orders.orders.filter((x) => x.status === 'Invalid').length : 0;
  const tabs = tabsHTML(`#/p/${projectId}/b/${backtestId}`, [
    ['overview', _t('k0532')], ['spec', _t('k0119')], ['robust', _t('k0120')], ['orders', invalid ? `${_t('k0533', { invalid })}` : _t('k0117'), S.orders ? S.orders.length : null], ['logs', _t('k0118')], ['code', _t('k0114')],
  ], tab);
  let body = '';
  if (tab === 'spec') body = specTabHTML(projectId, backtestId);
  else if (tab === 'robust') body = robustTabHTML(backtestId);
  else if (tab === 'orders') body = ordersTabHTML();
  else if (tab === 'logs') body = logsTabHTML();
  else if (tab === 'code') body = S.code == null ? '<div class="skeleton" style="height:300px"></div>' : S.code.error ? errorBox(_t('k0534'), S.code.error) : S.code.length ? `<div class="panel">${S.code.map((f, i) => `<div class="file-tabs"><button class="active">${esc(f.name)}</button>${codeActions('bt', f.name)}${i === 0 ? _t('k0535') : ''}<span class="meta">${_t('k0536')}</span></div>${codeView(f.content)}`).join('')}</div>` : _t('k0537');
  else body = overviewHTML(b, stats, invalid);
  const dataNote = b.dataChanged === true ? `<p class="data-note bt-data-changed" role="note"${(b.dataChangedTickers || []).length ? ` title="${esc(b.dataChangedTickers.join(', '))}"` : ''}>${_t('ux063')}</p>` : '';
  return `<div class="page">${head}${errBox}${dataNote}${isFailed(b) ? '' : verdictHTML(stats)}${tab === 'overview' || !tab ? validationHTML(b) : ''}${kpis}${tabs}${body}</div>`;
}

// 每项检验在测什么（一句话，和 lib/stats.mjs 的算法一致）。key = 检验 id
let GATE_WHY; _regT(() => { GATE_WHY = {
  ci: _t('k0538'),
  excess: _t('k0539'),
  riskadj: _t('k0540'),
  dsr: _t('k0541'),
  len: _t('k0542'),
}; });;
let gateHTML; _regT(() => { gateHTML = (g) => `<div class="gate ${g.ok ? 'ok' : 'bad'}"><b>${g.ok ? '✓' : '✗'}</b>${esc(g.zh)}<span>${esc(g.detail)}</span>${GATE_WHY[g.id] ? `<button type="button" class="gate-i" data-gate-why aria-expanded="false" aria-label="${_t('k0296', { v: esc(g.zh) })}" title="${_t('k0297')}">ⓘ</button><p class="gate-why gw-${esc(g.id)}" hidden>${esc(GATE_WHY[g.id])}</p>` : ''}</div>`; });

// 统计检验：和 qlib 引擎同一套思路，决定能不能标主版本
function validationHTML(b) {
  return datasetCautionHTML(b) + validationInnerHTML(b);
}
function validationInnerHTML(b) {
  const v = S.validation;
  const rej = b.mainRejected && b.mainRejected.length ? `<div class="order-warn">${_t('k0543')}${esc(b.mainRejected.join(_t('k0007')))}</div>` : '';
  if (!v) return rej;
  if (!v.ok) {
    const bad = (v.gates || []).filter((g) => !g.ok);
    return `${rej}<div class="panel section stat-test fail"><div class="panel-head"><h2>${_t('k0544')}${esc(v.reason || _t('k0451'))}</span></h2></div>${bad.length ? `<div class="gates">${bad.map((g) => gateHTML({ ...g, detail: g.detail || '' })).join('')}</div>` : ''}</div>`;
  }
  const n = v.numbers;
  const fail = v.gates.filter((g) => !g.ok); const okG = v.gates.filter((g) => g.ok);
  const gate = gateHTML;
  return `${rej}<div class="panel section stat-test ${v.pass ? 'pass' : 'fail'}">
    <div class="panel-head"><h2 class="st-h"><span class="st-score mono">${okG.length}/${v.gates.length}</span>${v.pass ? _t('k0545') : b.role === 'main' && b.mainBy === 'user' ? _t('k0546') : _t('k0547')}</h2>
      ${_t('k0548', { v: esc(v.rules) })}</div>
    ${fail.length ? `<div class="gates">${fail.map(gate).join('')}</div>` : ''}
    ${v.warnings.map((w) => `<p class="st-warn">${esc(w)}</p>`).join('')}
    <details class="st-more"><summary>${_t('k0549', { n: okG.length })}</summary><div class="gates">${okG.map(gate).join('')}</div>
    <p class="data-note" style="margin:6px 16px 14px">${_t('k0550', { v: num(n.sharpe) })} ${n.pSharpeLe0 == null ? '—' : `${(n.pSharpeLe0 * 100).toFixed(1)}%`} ${_t('k0551')} ${n.psrVsBenchmark == null ? '—' : `${(n.psrVsBenchmark * 100).toFixed(1)}%`} ${_t('k0552', { v: num(n.infoRatio), v2: num(n.years, 1) })}</p></details>
  </div>`;
}

let DS_CAUTION; _regT(() => { DS_CAUTION = _t('k0553'); });
const webDatasets = (b) => (b.datasets || []).filter((d) => !d.missing && (d.provenance || 'web') === 'web');
const datasetCautionHTML = (b) => (webDatasets(b).length ? `<div class="order-warn ds-caution" role="note"><span>${DS_CAUTION}</span></div>` : '');
function datasetNoteHTML(b) {
  return (b.datasets || []).map((d) => d.missing
    ? `<p class="data-note warn">${_t('k0554', { v: esc(d.name) })}</p>`
    : `<details class="data-note ds-used"><summary>${_t('k0557', { v: esc(d.name), v2: esc(d.version) })}${esc(d.sourceCount || (d.sources || []).length)}${_t('k0017')}</summary>${d.notes ? `<p class="ds-notes">${esc(d.notes)}</p>` : ''}<ol class="ds-src">${(d.sources || []).map(sourceLi).join('')}</ol>${(d.sourceCount || 0) > (d.sources || []).length ? `<p class="ds-notes">${_t('k0555')} ${(d.sources || []).length} ${_t('k0556')}</p>` : ''}</details>`).join('');
}
function overviewHTML(b, stats, invalid) {
  const entries = Object.entries(stats);
  const half = Math.ceil(entries.length / 2);
  const col = (arr) => `<div>${arr.map(([k, raw]) => {
    const { v, tip } = statValue(k, raw, stats);
    return `<div class="stat-row" title="${esc(tip || k)}"><span>${esc(statName(k))}</span><span class="${/Net Profit|Return|Alpha/.test(k) ? signClass(v) : ''}">${esc(v)}</span></div>`;
  }).join('')}</div>`;
  const rt = Object.entries(b.runtimeStatistics || {});
  const RT_ZH = { Equity: _t('k0558'), Fees: _t('k0559'), Holdings: _t('k0560'), 'Net Profit': _t('rt_net_profit'), 'Probabilistic Sharpe Ratio': _t('k0561'), Return: _t('k0562'), Unrealized: _t('k0563'), Volume: _t('k0564') };
  const noTrades = noClosedTrades(stats) ? _t('k0565') : '';
  const warn = invalid ? `<div class="order-warn">${_t('k0566', { invalid, projectId: S.route.projectId, backtestId: S.route.backtestId })}</div>` : '';
  return `${warn}
    <div class="panel section">
      <div class="panel-head"><h2>${_t('k0572')}</h2><span class="meta">${_t('k0573')}</span></div>
      <div class="chart-wrap" id="eqChart"><div class="skeleton" style="height:260px;margin:10px 16px"></div></div>
      <div class="chart-wrap dd" id="ddChart"><div class="skeleton" style="height:120px;margin:10px 16px"></div></div>
    </div>
    ${entries.length ? `<div class="panel section"><div class="panel-head"><h2>${_t('k0567')}</h2><span class="meta">${_t('k0568')}</span></div><div class="stats-cols">${col(entries.slice(0, half))}${col(entries.slice(half))}</div></div>${noTrades}` : ''}
    ${rt.length ? `<div class="panel section"><div class="panel-head"><h2>${_t('k0569')}</h2></div><div class="stats-cols">${[rt.slice(0, Math.ceil(rt.length / 2)), rt.slice(Math.ceil(rt.length / 2))].map((a) => `<div>${a.map(([k, v]) => `<div class="stat-row" title="${esc(k)}"><span>${esc(RT_ZH[k] || k)}</span><span class="${/Net Profit|Return|Unrealized/.test(k) ? signClass(v) : ''}">${esc(v)}</span></div>`).join('')}</div>`).join('')}</div></div>` : ''}
    ${b.data && b.data.length ? `<p class="data-note">${_t('k0570')}${b.data.map((d) => `${esc(d.ticker)} ${esc(d.start || '')}→${esc(d.end || '')}`).join(' · ')}${_t('k0571')}</p>` : ''}
    ${datasetNoteHTML(b)}
    ${fingerprintHTML(b)}`;
}

// 数据与代码指纹：这次回测跑在哪版代码、哪份数据上；同样的代码数据却变了时提醒
let FP_KIND_ZH; _regT(() => { FP_KIND_ZH = {
  altered: _t('k0574'), extended: _t('k0575'), shortened: _t('k0576'), changed: _t('k0577'),
  added: _t('k0578'), removed: _t('k0579'), newTicker: _t('k0580'), droppedTicker: _t('k0581'),
}; });;
function fpWarnBadge(b) {
  const c = b && b.fingerprintCheck;
  if (!c || c.status !== 'dataChanged') return '';
  return `<span class="badge err" title="${esc(`${_t('k0583')}${(c.ref && c.ref.name) || ''}${_t('k0584', { changedCount: c.changedCount })}${c.changedFiles && c.changedFiles.length ? `${_t('k0582', { n: c.changedFiles.length })}` : ''}${_t('k0585')}`)}"><span class="led">${_t('k0586')}</span>`;
}
function fingerprintHTML(b) {
  const fp = b.fingerprint;
  if (!fp || !fp.code) return _t('k0587');
  const c = b.fingerprintCheck || {};
  const d = fp.data;
  const short = (h) => (h ? String(h).slice(0, 12) : '—');
  const ref = c.ref ? `${_t('k0588', { projectId: S.route.projectId, v: esc(c.ref.backtestId) })}${esc(c.ref.name || String(c.ref.backtestId).slice(0, 8))}${_t('k0589')}` : '';
  const span = (x) => (x ? `${x.firstDate || ''}→${x.lastDate || ''} ${x.rows ?? ''} ${_t('k0590')}` : _t('k0591'));
  let note = '';
  if (c.status === 'dataChanged') {
    const items = (c.changed || []).slice(0, 30).map((x) => `<span class="mono" title="${esc(`${_t('k0592', { v: span(x.before), v2: span(x.after) })}`)}">${_t('k0593', { v: esc(x.ticker) })}${esc(FP_KIND_ZH[x.kind] || x.kind)}${_t('k0017')}`).join(_t('k0015'));
    const files = (c.changedFiles || []).map((f) => `<span class="mono">${esc(f.file)}</span>`).join(_t('k0015'));
    note = `<div class="order-warn"><div>${_t('k0597', { ref, differentDataPeers: c.differentDataPeers, changedCount: c.changedCount })}${c.altered ? `${_t('k0594', { altered: c.altered })}` : ''}${_t('k0598')}<br>${items}${c.changedCount > 30 ? ` ${_t('k0595', { changedCount: c.changedCount })}` : ''}${files ? `<br>${_t('k0596', { files })}` : ''}</div></div>`;
  } else if (c.status === 'codeChanged') {
    const files = (c.codeFiles || []).map((f) => `${_t('k0602', { v: esc(f.file) })}${f.kind === 'added' ? _t('k0599') : f.kind === 'removed' ? _t('k0600') : _t('k0601')}${_t('k0017')}`).join(_t('k0015'));
    note = `<p class="data-note" style="margin:10px 16px 0">${_t('k0605', { ref })}${c.entryChanged ? _t('k0603') : ''}${files ? `${_t('k0604', { files })}` : ''}${_t('k0199')}</p>`;
  } else if (c.status === 'same') {
    note = `<p class="data-note" style="margin:10px 16px 0">${_t('k0606', { sameDataPeers: c.sameDataPeers })}</p>`;
  } else if (c.status === 'pending') {
    note = _t('k0607');
  }
  const tks = d ? Object.entries(d.tickers || {}) : [];
  const ok = tks.filter(([, x]) => x.sha256);
  const first = ok.map(([, x]) => x.firstDate).filter(Boolean).sort()[0];
  const last = ok.map(([, x]) => x.lastDate).filter(Boolean).sort().pop();
  const row = (k, v, tip = '') => `<div class="stat-row"${tip ? ` title="${esc(tip)}"` : ''}><span>${k}</span><span>${v}</span></div>`;
  const codeRows = Object.entries(fp.code.files || {}).map(([n, h]) => row(`<span class="mono">${esc(n)}</span>`, short(h), h));
  const miss = (d && d.missing) || [];
  const dataRows = d ? [
    row(_t('k0608'), short(d.hash), d.hash),
    row(_t('k0609'), `${d.count}${miss.length ? ` ${_t('k0610', { n: miss.length })}` : ''}`, miss.length ? `${_t('k0611')}${miss.join(', ')}` : ''),
    row(_t('k0612'), first ? `${esc(first)} → ${esc(last)}` : '—', _t('k0613')),
    ...Object.entries(d.files || {}).map(([f, x]) => row(`<span class="mono">${esc(f.replace(/^helm\//, ''))}</span>`, x.missing ? _t('k0614') : short(x.sha256), x.sha256 || '')),
  ] : [row(_t('k0615'), fp.dataError ? `${_t('k0616', { v: esc(fp.dataError) })}` : _t('k0617'))];
  const list = tks.length ? `<details style="margin:4px 16px 14px"><summary class="data-note" style="cursor:pointer;margin:6px 0">${_t('k0621', { n: tks.length })}</summary>
    <pre class="logs" style="max-height:280px">${esc(tks.map(([t, x]) => (x.sha256 ? `${_t('k0618', { padEnd: t.padEnd(7), firstDate: x.firstDate, lastDate: x.lastDate, padStart: String(x.rows).padStart(5), slice: x.sha256.slice(0, 12) })}` : `${t.padEnd(7)} ${x.missing ? _t('k0619') : `${_t('k0620')}${x.error || ''}`}`)).join('\n'))}</pre></details>` : '';
  return `<div class="panel section" id="fingerprint">
    <div class="panel-head"><h2>${_t('k0623')}</h2>${_t('k0624')}</div>
    ${note}
    <div class="stats-cols"><div>${row(_t('k0622'), short(fp.code.hash), fp.code.hash)}${codeRows.join('')}</div><div>${dataRows.join('')}</div></div>
    ${list}
  </div>`;
}

// 订单表排序：点列头 升序 → 降序 → 恢复原顺序
let ORDER_COLS; _regT(() => { ORDER_COLS = [['time', _t('k0625')], ['symbol', _t('k0114')], ['direction', _t('k0626')], ['quantity', _t('k0627'), 'r'], ['price', _t('k0628'), 'r'], ['status', _t('k0269')], ['type', _t('k0629')]]; });
function sortedOrders(list) {
  const so = S.orderSort;
  if (!so) return list;
  const val = (x) => {
    switch (so.key) {
      case 'quantity': return Math.abs(+x.quantity || 0);
      case 'price': return (x.status === 'Filled' || x.status === 'PartiallyFilled') && +x.price ? +x.price : -Infinity;
      case 'time': return typeof x.time === 'number' ? x.time : String(x.time || '');
      default: return String(x[so.key] || '');
    }
  };
  const d = so.dir === 'desc' ? -1 : 1;
  return list.map((x, i) => [x, i]).sort((a, b) => {
    const va = val(a[0]); const vb = val(b[0]);
    const c = typeof va === 'number' && typeof vb === 'number' ? (va === vb ? 0 : va < vb ? -1 : 1) : String(va).localeCompare(String(vb), LOC());
    return c * d || a[1] - b[1];
  }).map((p) => p[0]);
}
function ordersTabHTML() {
  const o = S.orders;
  if (!o) return S.charts ? errorBox(_t('k0630'), S.ordersError || '') : '<div class="skeleton" style="height:300px"></div>';
  if (!o.orders.length) return _t('k0631');
  const STATUS = { Filled: [_t('k0632'), 'done'], Invalid: [_t('k0633'), 'err'], Canceled: [_t('k0634'), ''], PartiallyFilled: [_t('k0635'), 'run'] };
  const invalid = o.orders.filter((x) => x.status === 'Invalid').length;
  const rows = sortedOrders(o.orders).map((x) => {
    const [stxt, scls] = STATUS[x.status] || [x.status || '—', ''];
    const filled = x.status === 'Filled' || x.status === 'PartiallyFilled';
    return `<tr class="static ${x.status === 'Invalid' ? 'invalid' : ''}">
      <td class="when mono">${esc(String(x.time || '').slice(0, 10))}</td><td>${esc(x.symbol || '')}</td>
      <td class="${x.direction === 'Buy' ? 'up' : x.direction === 'Sell' ? 'down' : ''}">${x.direction === 'Buy' ? _t('k0636') : x.direction === 'Sell' ? _t('k0637') : esc(x.direction)}</td>
      <td class="r">${esc(Math.abs(+x.quantity || 0).toLocaleString(LOC()))}</td>
      <td class="r">${filled && +x.price ? `$${(+x.price).toFixed(2)}` : '—'}</td>
      <td><span class="badge ${scls}">${esc(stxt)}</span></td>
      <td class="when">${esc(x.type || '')}${x.tag ? ` · ${esc(x.tag)}` : ''}</td></tr>`;
  }).join('');
  const warn = invalid ? `<div class="order-warn"><span>${_t('k0639', { invalid })}</span>
    ${askBtn('engineer', _t('k0529'), _t('k0638'))}</div>` : '';
  return `${warn}<div class="panel"><div class="panel-head"><h2>${_t('k0117')}</h2>${_t('k0642', { n: o.length })}${o.length > o.orders.length ? `${_t('k0640', { n: o.orders.length })}` : ''}</span></div>
    <div class="table-wrap orders-wrap"><table class="data"><thead><tr>${ORDER_COLS.map(([k, zh, c]) => { const on = S.orderSort && S.orderSort.key === k; const dir = on ? S.orderSort.dir : 'none'; return `<th class="${c || ''}" aria-sort="${dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}"><button type="button" class="th-sort ${on ? 'on' : ''}" id="sort-${k}" data-sort="${k}" title="${_t('k0641', { zh })}">${zh}<span class="arr" aria-hidden="true">${dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : ''}</span></button></th>`; }).join('')}</tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

function logsTabHTML() {
  const l = S.logs;
  if (!l) return '<div class="skeleton" style="height:300px"></div>';
  if (l.error) return errorBox(_t('k0643'), l.error);
  if (!l.logs.length) return _t('k0644');
  return `<div class="panel"><div class="panel-head"><h2>${_t('k0118')}</h2>${_t('k0646', { n: l.length })}${l.length > l.logs.length ? `${_t('k0645', { n: l.logs.length })}` : ''}</span></div>
    <pre class="logs">${esc(l.logs.join('\n'))}</pre></div>`;
}

/* ================= qlib 研究 ================= */
let UNI_ZH; _regT(() => { UNI_ZH = { sp500: 'S&P 500', qqq: _t('k0647'), nasdaq100: _t('k0647'), sox: _t('k0648'), dia: _t('k0649'), spy100: 'S&P 100', iwm80: _t('k0650'), custom: _t('k0651') }; });;
const uniName = (t) => UNI_ZH[String(t || '').toLowerCase()] || String(t || '').toUpperCase();
let FEAT_ZH; _regT(() => { FEAT_ZH = { alpha158: _t('k0652'), fundamental: _t('k0653'), both: _t('k0654') }; });
// 这些股票池的数据有已知问题（2026-11-08 体检），修好之前在研究页醒目提示
const DATA_WARN_TARGETS = new Set(['sp500', 'spy', 'spx', 's&p500', 'qqq', 'ndx', 'nasdaq100', 'nasdaq']);
let KIND_ZH; _regT(() => { KIND_ZH = { 'point-in-time': _t('k0655'), 'partial-point-in-time': _t('k0656'), snapshot: _t('k0657') }; });
let RSTATUS; _regT(() => { RSTATUS = { running: [_t('k0137'), 'run'], complete: [_t('k0131'), 'done'], failed: [_t('k0658'), 'err'], stopped: [_t('k0659'), ''] }; });
const rBadge = (j) => { const [t, c] = RSTATUS[j.status] || [j.status, '']; return `<span class="badge ${c}"><span class="led"></span>${esc(t)}${j.status === 'running' ? ` ${Math.round((+j.progress || 0) * 100)}%` : ''}</span>`; };

function verdictZh(v) {
  if (!v) return null;
  const seen = /previously examined/i.test(v);
  if (/^CANDIDATE/.test(v)) return { short: _t('k0660'), text: _t('k0661'), note: _t('k0662'), cls: 'good', seen };
  if (/^INCONCLUSIVE/.test(v)) return { short: _t('k0663'), text: _t('k0664'), note: _t('k0665'), cls: 'mixed', seen };
  return { short: _t('k0666'), text: _t('k0667'), note: _t('k0668'), cls: 'bad', seen };
}
// 引擎的门槛说明是英文的，翻成中文显示
function gateZh(g) {
  const s = String(g);
  const rules = [
    [/^walk-forward IC t-stat(?: \(([^)]+)\))? (-?[\d.]+) \(need > ([\d.]+)\)/, (m) => `${_t('k0669', { v: m[2], v2: m[3] })}`],
    [/^permutation p-value(?: \(([^)]+)\))? ([\d.]+) \(need < ([\d.]+)\)/, (m) => `${_t('k0670', { v: m[2], v2: m[3] })}`],
    [/^permutation control.*not run/, () => _t('k0671')],
    [/^dev net Sharpe (-?[\d.]+) vs equal-weight universe (-?[\d.]+)/, (m) => `${_t('k0672', { v: m[1], v2: m[2] })}`],
    [/^dev net Sharpe (-?[\d.]+) vs random top-K 95th pct (-?[\d.]+)/, (m) => `${_t('k0673', { v: m[1], v2: m[2] })}`],
    [/^dev net Sharpe (-?[\d.]+) vs simple momentum top-K (-?[\d.]+)/, (m) => `${_t('k0674', { v: m[1], v2: m[2] })}`],
    [/^holdout mean IC ([+-]?[\d.]+) \(need > 0\)/, (m) => `${_t('k0675', { v: m[1] })}`],
    [/^holdout excess vs equal-weight ([+-]?[\d.]+%) \(need > 0\)/, (m) => `${_t('k0676', { v: m[1] })}`],
    [/^holdout Sharpe 95% CI lower bound (-?[\d.]+) \(need > 0\)/, (m) => `${_t('k0677', { v: m[1] })}`],
    [/^holdout Sharpe (-?[\d.]+) vs random top-K 95th pct (-?[\d.]+)/, (m) => `${_t('k0678', { v: m[1], v2: m[2] })}`],
  ];
  for (const [re, f] of rules) { const m = s.match(re); if (m) return f(m); }
  return s;
}
// Alpha158 / 基本面因子的中文说明
let FACTOR_ZH; _regT(() => { FACTOR_ZH = {
  KMID: _t('k0679'), KLEN: _t('k0680'), KMID2: _t('k0681'), KUP: _t('k0682'), KUP2: _t('k0683'), KLOW: _t('k0684'), KLOW2: _t('k0685'), KSFT: _t('k0686'), KSFT2: _t('k0687'),
  OPEN: _t('k0688'), HIGH: _t('k0689'), LOW: _t('k0690'), VWAP: _t('k0691'),
  ROC: _t('k0692'), MA: _t('k0693'), STD: _t('k0694'), BETA: _t('k0695'), RSQR: _t('k0696'), RESI: _t('k0697'),
  MAX: _t('k0698'), MIN: _t('k0699'), QTLU: _t('k0700'), QTLD: _t('k0701'), RANK: _t('k0702'), RSV: _t('k0703'),
  IMAX: _t('k0704'), IMIN: _t('k0705'), IMXD: _t('k0706'), CORR: _t('k0707'), CORD: _t('k0708'),
  CNTP: _t('k0709'), CNTN: _t('k0710'), CNTD: _t('k0711'), SUMP: _t('k0712'), SUMN: _t('k0713'), SUMD: _t('k0714'),
  VMA: _t('k0715'), VSTD: _t('k0716'), WVMA: _t('k0717'), VSUMP: _t('k0718'), VSUMN: _t('k0719'), VSUMD: _t('k0720'),
  F_EP: _t('k0721'), F_BM: _t('k0722'), F_SP: _t('k0723'), F_CFP: _t('k0724'), F_SIZE: _t('k0725'), F_ROE: _t('k0726'), F_ROA: _t('k0727'),
  F_GPA: _t('k0728'), F_OPA: _t('k0729'), F_ACC: _t('k0730'), F_LEV: _t('k0731'), F_REVG: _t('k0732'), F_EG: _t('k0733'), F_AG: _t('k0734'), F_SUE: _t('k0735'),
}; });;
function factorZh(name) {
  const n = String(name || '').toUpperCase();
  if (FACTOR_ZH[n]) return FACTOR_ZH[n];
  const m = n.match(/^([A-Z_]+?)(\d+)$/);
  if (m && FACTOR_ZH[m[1]]) return `${FACTOR_ZH[m[1]].replace(_t('k0736'), `${_t('k0737', { v: m[2] })}`).replace(_t('k0738'), `${_t('k0739', { v: m[2] })}`)}`;
  return '';
}
let BASE_ZH; _regT(() => { BASE_ZH = (k) => (k === 'Equal-weight universe' ? _t('k0740') : k === 'Momentum top-K' ? _t('k0741') : k.replace(/^(\S+) buy-and-hold$/, _t('k0742'))); });

function researchTabHTML(projectId) {
  const list = S.research;
  if (list == null) return '<div class="skeleton" style="height:160px"></div>';
  if (list.error) return errorBox(_t('k0743'), list.error);
  if (!list.length) return `<p class="psec-empty">${_t('ux036')}</p>`;
  // 一行一次检验：名字 + 想法原文在左，结论在右；整行可点。「想法检验」标签和「完成」状态在这一节里是废话，不再显示
  return `<div class="rl" role="list">${list.map((j) => {
    const isIdea = j.mode === 'idea';
    const v = isIdea ? null : verdictZh(j.verdict);
    const top = j.topFactors && j.topFactors[0];
    const res = isIdea && j.verdict ? ideaTag(j.verdict) : v ? `<span class="vtag ${v.cls}" title="${esc(v.text)}">${esc(v.short)}</span>` : top ? `<span class="meta">${_t('k0750', { v: esc(top.factor), v2: num(top.mean_ic, 3) })}</span>` : j.status === 'running' || j.status === 'failed' || j.error ? rBadge(j) : '—';
    const what = isIdea ? esc(j.idea || '') : `${esc(FEAT_ZH[j.features] || j.features)}${j.neutralize === 'sector' ? _t('k0752') : ''}`;
    return `<a role="listitem" class="rl-row" href="#/p/${projectId}/r/${esc(j.jobId)}">
      <span class="rl-main"><span class="rl-title">${esc(j.title)}${isIdea ? '' : `<span class="mode">${j.mode === 'factors' ? _t('k0753') : _t('k0754')}</span>`}</span><span class="rl-sub" title="${esc(j.idea || '')}">${what}</span></span>
      <span class="rl-meta">${esc(uniName(j.target))}<span>${agoT(j.created)}</span></span>
      <span class="rl-res">${res}</span>${CHEVRON_SVG}</a>`;
  }).join('')}</div>`;
}

async function loadResearchView(silent = false) {
  const { projectId, jobId } = S.route;
  if (!silent) { S.rjob = null; renderMain(); }
  ensureProject(projectId).then(() => { renderCrumbs(); renderCtx(); });
  const [r, bt] = await Promise.all([
    safePost('/api/qlib/research/read', { projectId, jobId }),
    data('backtests/list', { projectId }).catch(() => ({ success: false })),
  ]);
  if (S.route.jobId !== jobId) return;
  if (bt.success) S.backtests = bt.backtests;
  const prev = S.rjob;
  S.rjob = r.success ? r.job : { loadError: (r.errors || []).join('; ') };
  if (prev && prev.status === 'running' && S.rjob.status && S.rjob.status !== 'running') toast(`${_t('k0127')}${S.rjob.status === 'complete' ? _t('k0759') : _t('k0760')}`);
  renderMain();
  renderCrumbs();
  renderCtx();
  schedulePoll();
}

function perfRow(name, d, h, strong) {
  const c = (x, f) => (x == null || !Number.isFinite(+x) ? '<td class="r">—</td>' : `<td class="r ${f === 'p' ? signClass(x) : ''}">${f === 'p' ? pct(x, false) : num(x)}</td>`);
  return `<tr class="static ${strong ? 'is-main' : ''}"><td>${esc(name)}</td>${c(d && d.cagr, 'p')}${c(d && d.sharpe)}${c(d && d.max_drawdown, 'p')}${c(h && h.cagr, 'p')}${c(h && h.sharpe)}${c(h && h.max_drawdown, 'p')}</tr>`;
}

function dataNotesHTML(j) {
  const notes = `${DATA_WARN_TARGETS.has(String(j.target || '').toLowerCase()) ? _t('k0761') : ''}${j.universe.kind === 'snapshot' ? _t('k0762') : ''}${/membership file/.test(j.universe.source || '') ? `<p class="data-note">${_t('k0763')} ${esc(j.universe.asOf || '?')}${_t('k0764')}</p>` : ''}${j.universe.kind === 'partial-point-in-time' ? `<p class="data-note">${_t('k0768')} ${esc(j.universe.asOf || _t('k0765'))}${j.data && j.data.end ? `${_t('k0766', { v: esc(j.data.end) })}` : ''}${_t('k0769')} ${esc(j.universe.asOf || _t('k0767'))} ${_t('k0770')}</p>` : ''}`;
  if (!notes.trim()) return '';
  const warn = DATA_WARN_TARGETS.has(String(j.target || '').toLowerCase());
  const summary = warn ? _t('k0771') : j.universe.kind === 'snapshot' ? _t('k0772') : _t('k0773');
  return `<details class="data-notes"><summary>${_t('k0774', { summary })}</summary>${notes}</details>`;
}
function rDataLine(j) {
  return j.universe ? `<div class="r-facts">
      <div>${_t('k0782')}${esc(KIND_ZH[j.universe.kind] || j.universe.kind)}${_t('k0783', { v: esc(j.universe.n) })}</div>
      ${j.data ? `<div>${_t('k0776', { toFixed: (j.data.coverage * 100).toFixed(1), v: esc(j.data.start), v2: esc(j.data.end) })}${j.data.missing ? `${_t('k0775', { missing: j.data.missing })}` : ''}</i></div>` : ''}
      ${j.splits ? `<div>${_t('k0779', { v: esc(j.splits.holdout[0]), v2: esc(j.splits.holdout[1]) })}${j.mode === 'idea' ? _t('k0777') : `${_t('k0778', { folds: j.splits.folds, purge: j.splits.purge })}`}</i></div>` : ''}
      ${j.robustness ? `<div><span>${_t('k0780')}</span><b class="${+j.robustness.permP < 0.05 ? 'up' : 'down'}">${_t('k0781', { v: num(j.robustness.permP, 3), v2: esc(j.robustness.yearsPositive), v3: esc(j.robustness.yearsTotal) })}</div>` : ''}
    </div>${dataNotesHTML(j)}` : '';
}

/* ---- 想法检验（一句话想法 → 因子公式 → 开发期检验） ---- */
const IDEA_V = { 有信号: 'good', 信号弱: 'mixed', 没有信号: 'bad' };
const ideaLabel = (v) => ({ 有信号: _t('x001'), 信号弱: _t('x002'), 没有信号: _t('x003') })[v] || v;
const ideaTag = (v) => (v ? `<span class="vtag ${IDEA_V[v] || ''}">${esc(ideaLabel(v))}</span>` : '');
let KNOWN_ZH; _regT(() => { KNOWN_ZH = { momentum_12_1: _t('k0784'), reversal_1m: _t('k0785'), volatility_60d: _t('k0786'), size_dollar_volume: _t('k0787'), value_earnings_yield: _t('k0788') }; });
// 小数 → 百分比；pct 是唯一的实现（负号统一用 −，四舍五入成 0 不带符号），pc 只是把参数顺序换成 (值, 小数位, 带符号)
const pc = (x, d = 1, sign = true) => pct(x, sign, d);
let IDEA_ASK; _regT(() => { IDEA_ASK = _t('k0789'); });

// 柱状图：五分组年化收益 / 逐年 IC。正数朝上，负数朝下
function barsSVG(items, { fmt, w = 300, h = 110, cls = '' } = {}) {
  if (!items.length) return '';
  const vals = items.map((it) => (Number.isFinite(+it.v) ? +it.v : 0));
  // 零线位置随数据范围变：全是正数时零线在底部，正负都有时按比例分
  const hi = Math.max(0, ...vals); const lo = Math.min(0, ...vals); const span = (hi - lo) || 1e-9;
  const top = 14; const bot = 18; const plot = h - top - bot - (lo < 0 ? 10 : 0);
  const mid = top + (hi / span) * plot;
  const bw = w / items.length; const gap = Math.min(10, bw * 0.25);
  const bars = items.map((it, i) => {
    const v = vals[i]; const bh = Math.max((Math.abs(v) / span) * plot, 1);
    const y = v >= 0 ? mid - bh : mid; const x = i * bw + gap / 2; const cx = i * bw + bw / 2;
    const ty = v >= 0 ? y - 3 : y + bh + 9;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - gap).toFixed(1)}" height="${bh.toFixed(1)}" rx="2" class="${v >= 0 ? 'pos' : 'neg'}"><title>${_t('k0790', { v: esc(it.label), v2: esc(fmt(it.v)) })}</title></rect>`
      + (items.length <= 8 ? `<text x="${cx.toFixed(1)}" y="${ty.toFixed(1)}" class="val">${esc(fmt(it.v))}</text>` : '')
      + `<text x="${cx.toFixed(1)}" y="${h - 4}" class="lab">${esc(it.short ?? it.label)}</text>`;
  }).join('');
  return `<svg class="bars ${cls}" viewBox="0 0 ${w} ${h}" role="img">${bars}<line x1="0" x2="${w}" y1="${mid}" y2="${mid}" class="zero"/></svg>`;
}

function ideaFactorCard(f, j) {
  const { projectId, jobId } = S.route;
  const specF = (j.spec && (j.spec.factors || []).find((x) => x.name === f.name)) || {};
  const comps = specF.components || f.components || [];
  const tot = comps.reduce((a, c) => a + Math.abs(+c.weight || 1), 0) || 1;
  const compHTML = comps.map((c) => {
    const w = comps.length > 1 ? `<span class="w">${((Math.abs(+c.weight || 1) / tot) * 100).toFixed(0)}%${+c.weight < 0 ? _t('k0791') : ''}</span>` : '';
    return c.expr ? `<div class="comp">${w}<code>${esc(c.expr)}</code></div>` : `<div class="comp">${w}<code>${esc(c.fundamental)}</code><span class="when">${esc(factorZh(c.fundamental) || _t('k0792'))}</span></div>`;
  }).join('');
  const h = f.best_horizon;
  const ics = f.ic || {};
  const hz = Object.keys(ics).sort((a, b) => a - b);
  const icTable = hz.length ? `<table class="data mini"><thead><tr><th>${_t('k0795')}</th><th class="r">${_t('k0796')}</th><th class="r">${_t('k0797')}</th><th class="r">${_t('k0798')}</th></tr></thead><tbody>${hz.map((k) => {
    const s = ics[k] || {};
    return `<tr class="static ${+k === h ? 'is-main' : ''}"><td>${_t('k0794', { v: esc(k) })}${+k === h ? _t('k0793') : ''}</td><td class="r ${signClass(s.mean)}">${num(s.mean, 3)}</td><td class="r">${num(s.t, 2)}</td><td class="r">${s.pos_share == null ? '—' : pc(s.pos_share, 0, false)}</td></tr>`;
  }).join('')}</tbody></table>` : '';
  const q = f.quantiles || {};
  const qa = q.annual_returns || [];
  const qChart = qa.length ? `<div class="ichart"><div class="ich">${_t('k0804')}${esc(q.horizon || h)} ${_t('k0805')}</div>${barsSVG(qa.map((v, i) => ({ v, label: `${_t('k0799', { v: i + 1 })}`, short: i === 0 ? _t('k0800') : i === qa.length - 1 ? _t('k0801') : String(i + 1) })), { fmt: (x) => pc(x) })}
    <div class="ich-f">${_t('k0806', { v: signClass(q.long_short_annual), v2: pc(q.long_short_annual), v3: signClass(q.long_short_net_annual), v4: pc(q.long_short_net_annual) })}${q.monotonic ? _t('k0802') : ''}${f.turnover_top_quintile != null ? ` ${_t('k0803', { v: pc(f.turnover_top_quintile, 0, false) })}` : ''}</div></div>` : '';
  const yrs = Object.entries(f.by_year_ic || {}).sort(([a], [b]) => a - b);
  const yChart = yrs.length ? `<div class="ichart"><div class="ich">${_t('k0808', { v: esc(h) })}</div>${barsSVG(yrs.map(([y, v]) => ({ v, label: y, short: yrs.length > 10 ? `'${String(y).slice(2)}` : y })), { fmt: (x) => num(x, 3) })}
    <div class="ich-f">${f.share_years_positive != null ? `${_t('k0807', { v: pc(f.share_years_positive, 0, false) })}` : ''}</div></div>` : '';
  const corr = Object.entries(f.corr_known || {}).filter(([, c]) => c != null);
  const corrHTML = corr.length ? `<div class="corrs"><span>${_t('k0810')}</span>${corr.map(([n, c]) => `<b class="${Math.abs(c) > 0.8 ? 'hi' : Math.abs(c) > 0.5 ? 'mid' : ''}" title="${Math.abs(c) > 0.8 ? _t('k0809') : ''}">${esc(KNOWN_ZH[n] || n)} ${c > 0 ? '+' : ''}${num(c, 2)}</b>`).join('')}</div>` : '';
  const usable = f.verdict === 'signal' || f.verdict === 'weak' || f.verdict_zh === '有信号' || f.verdict_zh === '信号弱';
  const reb = h || 20;
  const acts = usable ? `<div class="if-acts"><button class="btn sm" data-action="research-signals" data-factor="${esc(f.name)}" title="${_t('k0815')}">${_t('k0816')}</button>${askBtn('engineer', _t('k0811'), `${_t('k0812', { jobId, projectId, name: f.name })}${f.label || f.name}${_t('k0813', { verdict_zh: f.verdict_zh, jobId, name: f.name, reb })}`, !/弱/.test(f.verdict_zh || ''))}</div>${f.verdict_zh === '信号弱' ? _t('k0814') : ''}`
    : _t('k0817');
  return `<div class="panel section ifac ${IDEA_V[f.verdict_zh] || ''}">
    <div class="panel-head"><h2>${esc(f.label || f.name)} <span class="mono meta">${esc(f.name)}</span></h2>${ideaTag(f.verdict_zh)}</div>
    <div class="if-body">
      <div class="comps">${compHTML}</div>
      ${f.reasons_zh && f.reasons_zh.length ? `<ul class="reasons">${f.reasons_zh.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      <div class="if-grid">${icTable ? `<div>${icTable}</div>` : ''}${qChart}${yChart}</div>
      ${corrHTML}
      ${f.coverage != null || f.days != null ? `<p class="meta if-meta">${f.days != null ? `${_t('k0818', { v: esc(f.days) })}` : ''}${f.coverage != null ? ` ${_t('k0819', { v: pc(f.coverage, 0, false) })}` : ''}</p>` : ''}
      ${acts}
    </div></div>`;
}

// 由这次想法检验的信号回测出来的回测
function linkedBacktests(jobId, projectId) {
  const bts = Array.isArray(S.backtests) ? S.backtests.filter((b) => b.sources && (b.sources.signals || []).some((s) => s.jobId === jobId)) : [];
  if (!bts.length) return '';
  return `<div class="panel section"><div class="panel-head"><h2>${_t('k0820')}</h2><span class="meta">${_t('k0425', { n: bts.length })}</span></div><div class="table-wrap"><table class="data"><thead><tr><th>${_t('k0111')}</th><th>${_t('k0821')}</th><th>${_t('k0269')}</th><th class="r">${_t('k0272')}</th><th class="r">${_t('k0273')}</th><th class="r">${_t('k0274')}</th></tr></thead><tbody>
    ${bts.map((b) => `<tr data-href="#/p/${projectId}/b/${b.backtestId}"><td class="name">${periodTag(b.period, b.holdoutSeq)}${esc(b.name)}</td><td class="mono">${esc((b.sources.signals || []).filter((s) => s.jobId === jobId).map((s) => s.factor || s.name).join(', '))}</td><td>${statusBadge(b)}</td><td class="r ${signClass(b.compoundingAnnualReturn)}">${pct(b.compoundingAnnualReturn)}</td><td class="r">${num(b.sharpeRatio)}</td><td class="r">${pct(b.drawdown, false)}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}

function ideaHTML(j) {
  const { projectId, jobId } = S.route;
  const res = j.ideaResult || {};
  const facs = res.factors || [];
  const actions = [
    j.status === 'running' ? _t('k0822') : '',
    (j.status === 'stopped' || j.status === 'failed') ? _t('k0823') : '',
    j.status === 'complete' ? askBtn('researcher', _t('k0824'), `${_t('k0825', { jobId, projectId })}`) : '',
    j.status === 'complete' && j.verdict && j.verdict !== '有信号' ? askBtn('researcher', _t('k0826'), `${_t('k0827', { jobId, projectId, verdict: j.verdict })}`, true) : '',
  ].join('');
  const head = `<div class="page-head"><div>
      <div class="eyebrow">${_t('k0829', { v: esc(jobId), v2: rBadge(j), v3: agoT(j.created) })}</div>
      <h1>${esc(j.title)}</h1>
      <p class="sub idea-q">“${esc(j.idea || '')}”</p>
      <p class="sub">${esc(uniName(j.target))}${j.tickers ? `${_t('k0016')}${esc(j.tickers.split(',').length)} ${_t('k0828')}` : ''} · ${facs.length || (j.spec && j.spec.factors ? j.spec.factors.length : '?')} ${_t('k0830', { v: esc(j.start), v2: esc(j.holdoutYears) })}</p>
    </div><div class="actions">${actions}</div></div>`;
  const steps = `<ol class="steps">${j.phases.map((p) => `<li class="${esc(p.status)}" title="${esc(p.error || (p.seconds ? `${_t('k0831', { seconds: p.seconds })}` : ''))}"><i></i><span>${esc(p.zh)}</span></li>`).join('')}</ol>`;
  const err = j.status === 'failed' && j.error ? `<div class="error-box" style="margin-bottom:16px">${_t('k0834')}${esc((j.phases.find((p) => p.status === 'failed') || {}).zh || '')}${_t('k0835')}<pre>${esc(j.error)}</pre>${askBtn('researcher', _t('k0832'), `${_t('k0833', { jobId, projectId, error: j.error })}`)}</div>` : '';
  const running = j.status === 'running' ? `<div class="panel r-live"><div class="panel-head"><h2>${_t('k0837')}${esc(j.current || _t('k0836'))}</h2><span class="meta">${_t('k0838', { round: Math.round(j.progress * 100) })}</span></div><div class="bar" style="margin:0 16px 12px"><div style="width:${Math.round(j.progress * 100)}%"></div></div>${j.logTail && j.logTail.length ? `<pre class="logs" style="max-height:180px">${esc(j.logTail.slice(-10).join('\n'))}</pre>` : ''}</div>` : '';
  const cls = IDEA_V[j.verdict] || '';
  const trials = res.trials || {};
  const summary = res.summary_zh ? `<div class="verdict ${cls}"><div class="vd-h">${ideaTag(j.verdict)} ${esc(res.summary_zh)}</div>
    <p class="vd-note">${trials.t_threshold != null ? `${_t('k0839', { v: num(trials.t_threshold, 2) })} ${esc(trials.universe_total ?? '?')} ${_t('k0840')}${esc(trials.tests_total ?? '?')} ${_t('k0841')}` : ''}${_t('k0842')}</p></div>` : '';
  const plots = j.plots && j.plots.length ? `<div class="panel section"><div class="panel-head"><h2>${_t('k0843')}</h2></div><div class="r-plots">${j.plots.map((f) => `<figure><img loading="lazy" src="/api/qlib/research/plot?projectId=${projectId}&jobId=${jobId}&file=${encodeURIComponent(f)}" alt="${esc(f)}"><figcaption>${esc(f)}</figcaption></figure>`).join('')}</div></div>` : '';
  const sigs = j.signals && j.signals.length ? `<p class="data-note">${_t('k0844')}${j.signals.map((n) => `<code>${esc(n)}</code>`).join(_t('k0015'))}${_t('k0845')}</p>` : '';
  const report = j.report ? `<details class="panel section r-report"><summary>${_t('k0846')}</summary><div class="md">${md(j.report.replace(/\]\(plots\/([^)]+)\)/g, (_, f) => `](/api/qlib/research/plot?projectId=${projectId}&jobId=${jobId}&file=${encodeURIComponent(f)})`))}</div></details>` : '';
  return `<div class="page">${head}${steps}${err}${running}${summary}${rDataLine(j)}${facs.map((f) => ideaFactorCard(f, j)).join('')}${sigs}${linkedBacktests(jobId, projectId)}${plots}${report}</div>`;
}

// 项目流程条：想法检验 → 回测 → 统计检验 → 模拟实盘
// 流程即标签：① 想法检验 → ② 回测与统计检验 → ③ 模拟实盘；代码放在右侧
function flowTabsHTML(projectId, active) {
  const ov = isOverview(active) || active === 'compare';
  const t = (sel, href, label, icon = '', extra = '') => `<a role="tab" aria-selected="${sel}" class="ft-code ${sel ? 'active' : ''}" href="#/p/${projectId}${href}">${icon}${label}${extra}</a>`;
  return `<nav class="flow-tabs proj-tabs" role="tablist" aria-label="${_t('k0857')}">
    ${t(ov, '', _t('ux035'))}
    ${t(active === 'rules', '/rules', _t('k0858'))}
    ${t(active === 'reports', '/reports', _t('dk191'))}
    ${t(active === 'code', '/code', _t('k0114'), '', Array.isArray(S.files) ? `<span class="count">${S.files.length}</span>` : '')}
  </nav>`;
}

// 多重检验：从 N 个因子 × H 个预测周期里挑最强的，单次 |t|>2 的门槛不够
const FEAT_N = { alpha158: 158, alpha360: 360 };
function factorTests(j) {
  const n = FEAT_N[String(j.features || '').toLowerCase()];
  const h = j.factorHorizons || 4;
  return n ? n * h : null;
}
function invNorm(p) { // Acklam 近似，p 在 (0,1)
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const q = Math.min(p, 1 - p);
  const r = Math.sqrt(-2 * Math.log(q));
  const x = (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1);
  return p < 0.5 ? x : -x;
}
function factorT(j) { const m = factorTests(j); return m ? -invNorm(0.025 / m) : 2; }
function factorTrialsNote(j) {
  const m = factorTests(j);
  return m ? `${_t('k0859', { m, v: FEAT_N[String(j.features).toLowerCase()] })} ${j.factorHorizons || 4} ${_t('k0860', { toFixed: factorT(j).toFixed(2) })}`
    : _t('k0861');
}
function researchHTML() {
  const { projectId, jobId } = S.route;
  const j = S.rjob;
  if (!j) return '<div class="page"><div class="skeleton" style="height:28px;width:40%;margin-bottom:22px"></div><div class="skeleton" style="height:120px"></div></div>';
  if (j.loadError) return `<div class="page">${errorBox(_t('k0862'), j.loadError)}</div>`;
  if (j.mode === 'idea') return ideaHTML(j);
  const v = verdictZh(j.verdict);
  const factorsDone = j.phases.find((p) => p.id === 'factors')?.status === 'complete';
  const actions = [
    j.status === 'running' ? _t('k0822') : '',
    (j.status === 'stopped' || j.status === 'failed') ? _t('k0823') : '',
    j.mode === 'factors' && j.status === 'complete' ? _t('k0864') : '',
    j.hasSignals ? _t('k0865') : '',
    j.status !== 'running' && (factorsDone || j.verdict) ? askBtn('analyst', _t('k0866'), `${_t('k0867', { jobId, projectId })}`) : '',
    j.hasSignals ? askBtn('engineer', _t('k0868'), `${_t('k0869', { jobId, projectId })} ${j.portfolio && j.portfolio.rebalanceDays ? j.portfolio.rebalanceDays : 5} ${_t('k0870')} ${j.portfolio && j.portfolio.chosen ? j.portfolio.chosen.topk : 10} ${_t('k0871')}`) : '',
  ].join('');
  const head = `<div class="page-head"><div>
      <div class="eyebrow">${_t('k0873', { v: esc(jobId), v2: rBadge(j), v3: agoT(j.created) })}</div>
      <h1>${esc(j.title)}</h1>
      <p class="sub">${esc(uniName(j.target))}${j.tickers ? `${_t('k0016')}${esc(j.tickers.split(',').length)} ${_t('k0828')}` : ''} · ${esc(FEAT_ZH[j.features] || j.features)}${j.neutralize === 'sector' ? _t('k0752') : ''} · ${j.mode === 'factors' ? _t('k0753') : _t('k0754')} ${_t('k0874', { v: esc(j.start), v2: esc(j.holdoutYears) })}${j.advanced !== 'off' ? _t('k0872') : ''}</p>
    </div><div class="actions">${actions}</div></div>`;
  const steps = `<ol class="steps">${j.phases.map((p) => `<li class="${esc(p.status)}" title="${esc(p.error || (p.seconds ? `${_t('k0831', { seconds: p.seconds })}` : ''))}"><i></i><span>${esc(p.zh)}</span></li>`).join('')}</ol>`;
  const err = j.status === 'failed' && j.error ? `<div class="error-box" style="margin-bottom:16px">${_t('k0834')}${esc((j.phases.find((p) => p.status === 'failed') || {}).zh || '')}${_t('k0835')}<pre>${esc(j.error)}</pre>${askBtn('researcher', _t('k0832'), `${_t('k0875', { jobId, projectId, error: j.error })}`)}</div>` : '';
  const running = j.status === 'running' ? `<div class="panel r-live"><div class="panel-head"><h2>${_t('k0837')}${esc(j.current || _t('k0836'))}</h2><span class="meta">${_t('k0838', { round: Math.round(j.progress * 100) })}</span></div><div class="bar" style="margin:0 16px 12px"><div style="width:${Math.round(j.progress * 100)}%"></div></div>${j.logTail && j.logTail.length ? `<pre class="logs" style="max-height:180px">${esc(j.logTail.slice(-10).join('\n'))}</pre>` : ''}</div>` : '';

  const verdict = v ? `<div class="verdict ${v.cls}"><div class="vd-h">${esc(v.text)}${v.seen || j.holdoutStatus === 'previously examined' ? _t('k0876') : j.holdoutStatus === 'untouched' ? _t('k0877') : ''}</div>
      <p class="vd-note">${esc(v.note)}</p>
      ${j.gates ? `<div class="gates">${j.gates.failed.map((g) => `<div class="gate bad"><b>✗</b>${esc(gateZh(g))}</div>`).join('')}${j.gates.passed.map((g) => `<div class="gate ok"><b>✓</b>${esc(gateZh(g))}</div>`).join('')}</div>` : ''}</div>` : '';

  const dataLine = rDataLine(j);

  const pf = j.portfolio; const ho = j.holdout;
  const perf = pf && pf.strategy ? `<div class="panel section"><div class="panel-head"><h2>${_t('k0883')}</h2>${_t('k0884')}${pf.chosen ? `${_t('k0878', { v: esc(pf.rebalanceDays), v2: esc(pf.chosen.topk) })}` : ''}</span></div>
      <div class="table-wrap"><table class="data"><thead><tr><th></th><th class="r">${_t('k0885')}</th><th class="r">${_t('k0273')}</th><th class="r">${_t('k0274')}</th><th class="r">${_t('k0886')}</th><th class="r">${_t('k0273')}</th><th class="r">${_t('k0274')}</th></tr></thead><tbody>
      ${perfRow(_t('k0879'), pf.strategy, ho && ho.strategy, true)}
      ${Object.keys(pf.baselines || {}).map((k) => perfRow(BASE_ZH(k), pf.baselines[k], ho && ho.baselines && ho.baselines[k])).join('')}
      ${pf.random ? `<tr class="static"><td>${_t('k0880')}</td><td></td><td class="r nowrap">${num(pf.random.mean)} / ${num(pf.random.p95)}</td><td></td><td></td><td class="r nowrap">${ho && ho.random ? `${num(ho.random.mean)} / ${num(ho.random.p95)}` : '—'}</td><td></td></tr>` : ''}
      </tbody></table></div>${ho && ho.ci ? `<p class="data-note" style="margin:10px 16px 14px">${_t('k0882', { v: num(ho.ci.lo), v2: num(ho.ci.hi) })}${pf.breakevenBps != null ? `${_t('k0881', { v: esc(pf.breakevenBps) })}` : ''}${_t('k0199')}</p>` : ''}</div>` : '';

  const factors = j.topFactors && j.topFactors.length ? `<div class="panel section"><div class="panel-head"><h2>${_t('k0888')}</h2>${_t('k0889')}${esc((j.factorWindow || []).join(' → '))}${_t('k0890', { v: esc(j.horizon) })}${j.weakFactorSignal ? _t('k0887') : ''}</span></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>${_t('k0821')}</th><th>${_t('k0891')}</th><th class="r">IC</th><th class="r">ICIR</th><th class="r">${_t('k0892')}</th></tr></thead><tbody>
      ${j.topFactors.map((f) => `<tr class="static"><td class="mono">${esc(f.factor)}</td><td class="when">${esc(factorZh(f.factor))}</td><td class="r ${signClass(f.mean_ic)}">${num(f.mean_ic, 4)}</td><td class="r">${num(f.icir, 3)}</td><td class="r ${Math.abs(f.t_nonoverlap) > factorT(j) ? 'strong' : ''}">${num(f.t_nonoverlap, 2)}</td></tr>`).join('')}
      </tbody></table></div><p class="data-note" style="margin:10px 16px 14px">${_t('k0893', { v: factorTrialsNote(j) })}</p></div>` : '';

  const plotsCap = { 'nav_drawdown.png': _t('k0894'), 'annual_returns.png': _t('k0895'), 'ic_by_year.png': _t('k0896') };
  const plots = j.plots && j.plots.length ? `<div class="panel section"><div class="panel-head"><h2>${_t('k0843')}</h2><span class="meta">${_t('k0897')}</span></div><div class="r-plots">${j.plots.map((f) => `<figure><img loading="lazy" src="/api/qlib/research/plot?projectId=${projectId}&jobId=${jobId}&file=${encodeURIComponent(f)}" alt="${esc(plotsCap[f] || f)}"><figcaption>${esc(plotsCap[f] || f)}</figcaption></figure>`).join('')}</div></div>` : '';
  const report = j.report ? `<details class="panel section r-report"><summary>${_t('k0898')}</summary><div class="md">${md(j.report.replace(/\]\(plots\/([^)]+)\)/g, (_, f) => `](/api/qlib/research/plot?projectId=${projectId}&jobId=${jobId}&file=${encodeURIComponent(f)})`))}</div></details>` : '';
  const sigs = j.signals && j.signals.length ? `<p class="data-note">${_t('k0844')}${j.signals.map((n) => `<code>${esc(n)}</code>`).join(_t('k0015'))}${_t('k0845')}</p>` : '';
  return `<div class="page">${head}${steps}${err}${running}${verdict}${dataLine}${perf}${factors}${plots}${sigs}${report}</div>`;
}

/* ---- 股票池（首页） ---- */
async function loadUniverses(silent = false) {
  const r = await safePost('/api/qlib/universes', { fresh: silent });
  if (!r.success) {
    if (!Array.isArray(S.universes) || !S.universes.length) S.universes = { error: (r.errors || []).join(_t('k0007')) };
    if (S.route.view === 'home') { const el = $('#uniPanel'); if (el) el.outerHTML = universesHTML(); }
    return;
  }
  const prev = Array.isArray(S.universes) ? S.universes : null;
  S.universes = r.universes;
  if (prev) for (const u of S.universes) { const p = prev.find((x) => x.key === u.key); if (p && p.job && p.job.status === 'running' && u.job && u.job.status !== 'running') toast(`${u.label} ${u.job.status === 'complete' ? _t('k0899') : `${_t('k0900')}${u.job.error || ''}`}`); }
  if (S.route.view === 'home') { const el = $('#uniPanel'); if (el) el.outerHTML = universesHTML(); }
  schedulePoll();
}
function universesHTML() {
  const list = S.universes;
  const body = list == null ? '<div class="skeleton" style="height:120px;margin:12px 16px"></div>' : list.error != null ? errorBox(_t('k0901'), list.error || _t('k0902')) : !list.length ? _t('k0903')
    : `<div class="unis">${list.map((u) => {
      const job = u.job && u.job.status === 'running' ? u.job : null;
      const ex = u.exported;
      // 已有旧数据、但最近一次更新失败：之前这里只显示「已就绪」，失败被藏起来，用户只能一遍遍点「更新」
      // 已经到最近一个完整交易日：写明「已是最新」，按钮变成不显眼的「重新准备」（之前一直显示「更新」，用户更新完还以为要再更新）
      const fresh = Boolean(ex && u.upToDate && !(u.job && u.job.status === 'failed'));
      const lastFail = ex && u.job && u.job.status === 'failed' ? `<i class="u-fail" title="${esc(u.job.error || '')}">${_t('u_fail', { v: esc(String(u.job.error || '').slice(0, 80)) })}</i>` : '';
      const st = job ? `${_t('k0904')} ${Math.round((job.progress || 0) * 100)}%<i>${esc(job.phase || '')}</i></span>`
        : ex ? `<span class="u-st ok">${_t('k0905', { v: esc(ex.start), v2: esc(ex.end) })} ${esc(ex.members_per_day ? ex.members_per_day.median : '?')} ${_t('k0906')}${fresh ? `<i class="u-fresh">${_t('u_fresh')}</i>` : ''}${lastFail}</span>`
          : u.job && u.job.status === 'failed' ? `<span class="u-st bad" title="${esc(u.job.error || '')}">${_t('k0907')}${esc(String(u.job.error || '').slice(0, 60))}</i></span>` : _t('k0908');
      return `<div class="uni"><div class="u-n"><b>${esc(u.label)}</b><span class="u-k ${u.kind === 'snapshot' ? 'snap' : u.kind === 'partial-point-in-time' ? 'part' : 'pit'}" ${u.kind === 'partial-point-in-time' ? `${_t('k0909')} ${esc(u.qlib_as_of || '?')}${_t('k0910')}` : u.membership_source ? `${_t('k0911', { v: esc(u.membership_source) })}` : ''}>${u.kind === 'snapshot' ? _t('k0912') : u.kind === 'partial-point-in-time' ? `${_t('k0913')} ${esc(String(u.qlib_as_of || '?').slice(0, 7))}` : u.membership_source ? `${_t('k0913')} ${esc(String(u.qlib_as_of || '?').slice(0, 7))}` : _t('k0914')}</span></div>
        <div class="u-m">${_t('k0920')} ${esc(u.names_ever ?? '?')} ${_t('k0921', { v: esc(u.bench) })}</div>${u.data_warning ? `<div class="u-warn" title="${esc(u.data_warning)}">${_t('k0915')}</div>` : ''}${st}
        ${job ? '' : `<button type="button" class="btn sm${fresh ? ' quiet' : ''}" data-prepare="${esc(u.key)}" title="${fresh ? esc(_t('u_fresh_t')) : ''}" aria-label="${ex ? _t('k0916') : _t('k0917')} ${_t('k0919', { v: esc(u.label) })}">${lastFail ? _t('u_retry') : fresh ? _t('u_rebuild') : ex ? _t('k0916') : _t('k0918')}</button>`}</div>`;
    }).join('')}</div>`;
  return `<div class="panel" id="uniPanel"><div class="panel-head"><h2>${_t('k0922')}</h2><span class="meta">${_t('k0923')}</span></div>${body}</div>`;
}

/* ================= home ================= */
let ROUTES; _regT(() => { ROUTES = [
  ['auto', _t('k0924'), _t('k0925'), _t('ux078')], // [键, 名字, 详细说明（悬停）, 一句白话（显示在旁边）]
  ['fast', _t('k0926'), _t('k0927'), _t('ux079')],
  ['deep', _t('k0928'), _t('k0929'), _t('ux080')],
]; });
// 首页示例：点一下填进输入框，可以改了再交
let EXAMPLES; _regT(() => { EXAMPLES = [
  [_t('k0930'), _t('k0931')],
  [_t('k0932'), _t('k0933')],
  [_t('k0934'), _t('k0935')],
]; });
let QUICK; _regT(() => { QUICK = [
  { agent: 'mia', text: _t('k0936') },
  { agent: 'engineer', text: _t('k0937') },
  { agent: 'researcher', text: _t('k0938') },
  { agent: 'analyst', text: _t('k0939') },
  { agent: 'researcher', text: _t('k0940') },
]; });

// 每个项目在流程里走到哪一步、下一步做什么 —— 首页就是工作流本身
function projStage(p, hh) {
  const h = hh || (S.home || {})[p.projectId];
  if (!h) return null;
  const base = `#/p/${p.projectId}`;
  const bts = h.bts.filter((b) => b.role !== 'debug' && !isFailed(b));
  const done = bts.filter((b) => /Completed/i.test(b.status || ''));
  const main = done.find((b) => b.role === 'main');
  const ideas = h.rs.filter((j) => j.mode === 'idea');
  const signal = ideas.find((j) => j.verdict === '有信号' || j.verdict === '信号弱');
  const live = h.pap.find((s) => s.status === 'active');
  const best = main || done.slice().sort((a, b) => (+b.sharpeRatio || -9) - (+a.sharpeRatio || -9))[0] || null;
  let step; let next;
  const liveBad = h.pap.find((x) => x.status === 'active' && x.lastRun && !x.lastRun.ok && !x.lastRun.skipped);
  if (liveBad) { step = 4; next = { t: _t('ux024'), href: `${base}/s/${liveBad.sessionId}`, bad: true }; }
  else if (live) { step = 4; next = { t: _t('k0941'), href: `${base}/s/${live.sessionId}` }; }
  else if (main) { step = 3; next = { t: _t('k0942'), href: `${base}/b/${main.backtestId}` }; }
  else if (done.length) { step = 2; next = { t: _t('k0943'), href: `${base}/b/${best.backtestId}` }; }
  else if (signal) { step = 1; next = { t: _t('k0944'), href: `${base}/r/${signal.jobId}` }; }
  else if (ideas.length) { step = 1; next = { t: _t('k0233'), href: `${base}/research`, ask: 'researcher' }; }
  else { step = 0; next = { t: _t('ux082'), href: base }; } // 什么都还没做（比如刚从模板建好）：模板代码直接能回测
  return { step, next, best, paperBad: Boolean(liveBad), running: h.bts.some(isRunning) || h.rs.some((j) => j.status === 'running') };
}
let STEP_ZH; _regT(() => { STEP_ZH = [_t('k0945'), _t('k0946'), _t('k0111'), _t('k0157'), _t('k0947')]; });
// 当前在哪一步：和项目页状态卡同一套名字。想法没有信号算卡在第一步
function stageMarks(st) {
  const blocked = st.step === 1 && st.next && st.next.ask;
  const cur = st.step === 4 ? 4 : blocked ? 1 : st.step + 1;
  const bad = blocked || st.paperBad;
  const label = st.step === 0 ? _t('ux081') : _t(`pv_s${cur}`);
  return `<span class="stage ${bad ? 'bad' : ''}">${[1, 2, 3, 4].map((i) => `<i class="${i < cur || (st.step === 4 && !bad) ? 'on' : i === cur && st.step ? 'cur' : ''}"></i>`).join('')}<em>${label}</em></span>`;
}
function projRow(p) {
  const st = projStage(p);
  const b = st ? st.best : undefined;
  const cell = (v, cls = '') => `<td class="r ${cls}">${v}</td>`;
  // 不用 colspan：窄屏按列号隐藏夏普、回撤时，合并单元格会把整张表撑歪
  const nums = b === undefined ? `<td class="r"><span class="skeleton" style="display:inline-block;width:48px;height:12px"></span></td><td class="r"></td><td class="r"></td>`
    : !b ? `<td class="r faint">—</td><td class="r"></td><td class="r"></td>`
      : cell(pct(b.compoundingAnnualReturn), signClass(b.compoundingAnnualReturn)) + cell(num(b.sharpeRatio)) + cell(pct(b.drawdown, false));
  const h = (S.home || {})[p.projectId];
  const paperBad = h && Array.isArray(h.pap) && h.pap.some((x) => x.status === 'active' && x.lastRun && !x.lastRun.ok && !x.lastRun.skipped);
  const a = attnOf(p); const hot = a && (a.paper || a.bt || a.decide);
  return `<tr data-href="#/p/${p.projectId}" class="${hot ? 'hot' : ''}"><td class="name"><b>${esc(pName(p))}</b><span class="when">${agoT(p.modified)}${st && st.running ? _t('k0948') : ''}${paperBad ? ` · <span class="down">${_t('ux012')}</span>` : ''}</span></td>
    <td>${st ? stageMarks(st) : ''}</td>${nums}
    <td class="next">${st ? `<a href="${esc(st.next.href)}" class="${st.next.bad ? 'down' : ''}">${st.next.t}<span aria-hidden="true">→</span></a>` : ''}</td></tr>`;
}

/* ================= 想法记录 ================= */
let JR_WHY; _regT(() => { JR_WHY = _t('k0949'); });
async function loadJournal() {
  if (!S.journal) S.journal = { q: '', project: '', stage: '', outcome: '' };
  const hadData = Boolean(S.journal.data);
  if (!hadData) { S.journal.error = null; renderMain(); }
  try { const r = await api('/api/data/journal'); if (r.success) { S.journal.data = { summary: r.summary, entries: r.entries }; S.journal.error = null; } else S.journal.error = (r.errors || []).join(_t('k0007')) || _t('k0433'); } catch (e) { S.journal.error = e.message; }
  if (!S.route.journal) return;
  renderMain();
}
function journalFiltered() {
  const J = S.journal; const E = (J.data && J.data.entries) || [];
  const q = (J.q || '').trim().toLowerCase();
  return E.filter((e) => (!J.project || String(e.projectId) === J.project) && (!J.stage || e.stage === J.stage) && (!J.outcome || e.outcome === J.outcome)
    && (!q || `${e.what} ${e.detail} ${e.projectName} ${pNameById(e.projectId)} ${e.stage} ${e.outcome}`.toLowerCase().includes(q)));
}
function journalRowsHTML(rows) {
  if (!rows.length) return _t('k0950');
  return rows.map((e) => {
    const k = e.key ? `<span class="jr-kl">${esc(e.key.label)}</span> ${num(e.key.value)}` : '—';
    const attrs = e.link ? ` data-href="${esc(e.link)}"` : ' class="static"';
    return `<tr${attrs}><td class="mono">${esc(String(e.date || '').slice(0, 10)) || '—'}</td>
      <td class="jr-proj" title="${esc(pNameById(e.projectId, e.projectName))}">${e.projectId != null ? `<a href="#/p/${e.projectId}">${esc(pNameById(e.projectId, e.projectName))}</a>` : esc(e.projectName)}</td>
      <td class="jr-what" title="${esc(e.what)}">${esc(e.what)}${e.detail ? `<span class="when">${esc(e.detail)}</span>` : ''}</td>
      <td>${esc(e.stage)}</td><td>${esc(e.outcome)}</td><td class="r">${k}</td></tr>`;
  }).join('');
}
function journalHTML() {
  const J = S.journal || {};
  const head = `<div class="page-head"><div><div class="eyebrow"><span>${_t('k0951')}</span></div><h1>${_t('k0124')} <button type="button" class="gate-i" data-jr-why aria-expanded="false" aria-label="${_t('k0952')}" title="${_t('k0297')}">ⓘ</button></h1>
      <p class="sub">${_t('k0953')}</p><p class="gate-why jr-why" hidden>${esc(JR_WHY)}</p></div></div>`;
  if (J.error != null && !J.data) return `<div class="page">${head}${errorBox(_t('k0954'), J.error)}</div>`;
  if (!J.data) return `<div class="page">${head}<div class="skeleton" style="height:64px"></div><div class="skeleton" style="height:260px;margin-top:18px"></div></div>`;
  const { summary: S0, entries } = J.data;
  if (!entries.length) return `<div class="page">${head}<div class="panel empty"><div class="big">${_t('k0955')}</div><p>${_t('k0956')}</p></div></div>`;
  const cell = (k, v, sub) => `<div class="pg-cell"><div class="pg-k">${k}</div><div class="pg-v mono">${v}</div>${sub ? `<div class="pg-sub">${sub}</div>` : ''}</div>`;
  const st = S0.byStage || {};
  const holdSub = (S0.holdout || []).filter((h) => h.looks).map((h) => `${esc(h.name.split(/[（(]/)[0].trim().slice(0, 12))} ${h.looks}`).join('<br>') || _t('k0957');
  const tr = S0.trials || {};
  const stages = [_t('k0115'), _t('k0958'), _t('k0058'), _t('k0176'), _t('k0116')];
  const sum = `<div class="pg-grid jr-sum">
    ${cell(_t('k0115'), esc(S0.ideas), _t('k0959'))}
    ${cell(_t('k0111'), esc(S0.backtests), `${_t('k0960')} ${st['统计检验'] || 0} ${_t('k0961')}`)}
    ${cell(_t('k0176'), esc(S0.holdoutLooksTotal), holdSub)}
    ${cell(_t('k0962'), esc(tr.total ?? '—'), tr.sameHistory != null ? `${_t('k0963', { v: esc(tr.sameHistory) })}<br>${_t('k0964')}` : _t('k0965'))}
  </div><p class="pg-note jr-reach">${_t('k0966')}${stages.map((x) => `${esc(x)} <b class="mono">${esc(st[x] || 0)}</b>`).join(' · ')}</p>`;
  const projs = [...new Map(entries.map((e) => [e.projectId, pNameById(e.projectId, e.projectName)])).entries()].filter(([id]) => id != null);
  const outs = [...new Set(entries.map((e) => e.outcome))];
  const opt = (v, cur, label) => `<option value="${esc(v)}"${String(cur) === String(v) ? ' selected' : ''}>${esc(label ?? v)}</option>`;
  const rows = journalFiltered();
  const filt = `<div class="filters jr-filters"><label class="search jr-search"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="m10.5 10.5 3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg><input id="jrQ" type="search" placeholder="${_t('k0971')}" value="${esc(J.q || '')}" aria-label="${_t('k0972')}"></label>
    <select class="jr-sel" id="jrProject" aria-label="${_t('k0973')}">${opt('', J.project, _t('k0967'))}${projs.map(([id, n]) => opt(String(id), J.project, n)).join('')}</select>
    <select class="jr-sel" id="jrStage" aria-label="${_t('k0974')}">${opt('', J.stage, _t('k0968'))}${stages.map((x) => opt(x, J.stage)).join('')}</select>
    <select class="jr-sel" id="jrOutcome" aria-label="${_t('k0975')}">${opt('', J.outcome, _t('k0969'))}${outs.map((x) => opt(x, J.outcome)).join('')}</select>
    ${_t('k0976', { n: rows.length, n2: entries.length })}${S0.total > entries.length ? `${_t('k0970', { n: entries.length, total: S0.total })}` : ''}</span></div>`;
  const src = S0.sources || {};
  const srcNote = `<p class="data-note">${_t('k0980')} ${src.trials ? _t('k0977') : _t('k0591')} ${_t('k0981', { v: esc(src.projects), v2: esc(src.ideaJobs) })}${src.holdoutRegistry == null ? _t('k0978') : ` ${_t('k0979', { v: esc(src.holdoutRegistry) })}`}${_t('k0982')}</p>`;
  return `<div class="page">${head}${sum}${filt}<div class="panel"><div class="table-wrap"><table class="data jr-tbl"><thead><tr><th>${_t('k0625')}</th><th>${_t('k0973')}</th><th>${_t('k0983')}</th><th>${_t('k0974')}</th><th>${_t('k0975')}</th><th class="r">${_t('k0984')}</th></tr></thead><tbody id="jrBody">${journalRowsHTML(rows)}</tbody></table></div></div>${srcNote}</div>`;
}

/* ---------- 自建数据集（agent 从网上整理的表，只读） ---------- */
let DS_KIND; _regT(() => { DS_KIND = { events: _t('k0985'), attributes: _t('k0986'), timeseries: _t('k0987') }; });;
const httpUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');
const sourceLi = (s) => { const u = httpUrl(s.url); const t = esc(s.title || s.url || ''); return `<li>${u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${t}</a>` : t}<span class="when"> · ${esc(s.retrieved_at || '')}</span></li>`; };
async function loadDatasets() {
  const r = await api('/api/datasets').catch((e) => ({ success: false, errors: [e.message] }));
  S.datasets = r.success ? r.datasets : { error: (r.errors || []).join(_t('k0007')) || _t('k0433') };
  const el = $('#dsPanel');
  if (el && S.route.data) el.outerHTML = datasetsHTML();
}
function datasetsHTML() {
  const list = S.datasets;
  const body = list == null ? '<div class="skeleton" style="height:80px;margin:12px 16px"></div>'
    : list.error != null ? errorBox(_t('k0988'), list.error)
      : !list.length ? _t('k0989')
        : `<div class="table-wrap"><table class="data ds-tbl"><thead><tr><th>${_t('k0268')}</th><th>${_t('k0629')}</th><th class="r">${_t('k0992')}</th><th class="r">${_t('k0993')}</th><th>${_t('k0994')}</th><th class="r">${_t('k0343')}</th><th>${_t('k0916')}</th><th class="r">${_t('k0995')}</th></tr></thead><tbody>${list.map((m) => `<tr class="static">
          <td class="ds-name"><b class="mono">${esc(m.name)}</b><span>${esc(m.description || '')}</span>
            <details><summary>${_t('k0991')}</summary>${m.notes ? `<p class="ds-notes">${esc(m.notes)}</p>` : _t('k0990')}<ol class="ds-src">${(m.sources || []).map(sourceLi).join('')}</ol></details></td>
          <td>${esc(DS_KIND[m.kind] || m.kind)}</td><td class="r mono">${esc(m.rows)}</td><td class="r mono">${esc(m.symbols)}</td><td class="mono">${esc(m.firstAvailable)} → ${esc(m.lastAvailable)}</td>
          <td class="r mono">v${esc(m.version)}</td><td class="when" title="${esc(m.updated || '')}">${esc(String(m.updated || '').slice(0, 10))}</td><td class="r mono">${esc((m.sources || []).length)}</td></tr>`).join('')}</tbody></table></div>`;
  return `<div class="panel" id="dsPanel"><div class="panel-head"><h2>${_t('k0996')}</h2><span class="meta">${_t('k0997')}</span></div>${body}</div>`;
}
function dataHTML() {
  return `<div class="page">
    <div class="page-head"><div><div class="eyebrow"><span>${_t('k0615')}</span></div><h1>${_t('k0123')}</h1>
      <p class="sub">${_t('k0998')}</p></div></div>
    ${universesHTML()}
    ${datasetsHTML()}
  </div>`;
}
// 首页「需要处理」：离开一段时间回来，先看到哪里出了问题、哪里在等你决定，点一下直达
const WEEK = 7 * 864e5;
function attnOf(p) {
  const h = (S.home || {})[p.projectId];
  if (!h) return null;
  const paper = (h.pap || []).find((x) => x.status === 'active' && x.lastRun && !x.lastRun.ok && !x.lastRun.skipped);
  const bt = (h.bts || []).find((b) => b.role !== 'debug' && isFailed(b) && b.created && Date.now() - new Date(b.created).getTime() < WEEK && !(h.bts || []).some((x) => x !== b && !isFailed(x) && x.created > b.created));
  const st = projStage(p);
  return { paper, bt, decide: st && st.step === 2 && !st.running ? st : null };
}
function attnScore(p) { const a = attnOf(p); return !a ? 0 : a.paper ? 3 : a.bt ? 2 : a.decide ? 1 : 0; }
// 首页标题下的一句话：哪些事卡在你这里（按严重程度排）；返回 { n, line }
function attnSummary() {
  if (!S.projects || !S.home) return null;
  const list = S.projects.map((p) => attnOf(p)).filter((a) => a && (a.paper || a.bt || a.decide));
  const parts = [['paper', 'ux021'], ['bt', 'ux022'], ['decide', 'ux023']]
    .map(([k, key]) => [list.filter((a) => a[k]).length, key]).filter(([n]) => n).map(([n, key]) => _t(key, { n }));
  return { n: list.length, bad: list.some((a) => a.paper || a.bt), line: parts.join(_t('k0007')) };
}
// 首页想法框的模型 / 思考深度：默认、自动（Haiku 先读一遍任务再挑）、或指定一个
const OPT_ICON = {
  model: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 14 5v6l-6 3.5L2 11V5z M2 5l6 3.5L14 5M8 8.5V14.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  effort: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 13V9M6 13V6M10 13V4M14 13V2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
};
function ideaOptsHTML() {
  const { models = [], efforts = [] } = S.options || {};
  // 选项还没加载时保留存着的值（不改 S），加载后 renderMain 会重画
  const m = S.ideaModel || 'auto';
  const e = S.ideaEffort || 'auto';
  const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
  const ms = opt('auto', _t('am_autoModel'), m) + models.map((x) => opt(x.id, x.label, m)).join('');
  const es = opt('auto', _t('am_autoEffort'), e) + efforts.map((x) => opt(x.id, _t('k1441', { v: x.label }), e)).join('');
  return `<div class="run-opts idea-opts">
      <label class="opt set" title="${esc(m === 'auto' ? _t('am_autoTip') : _t('h031'))}">${OPT_ICON.model}<select id="ideaModelSel" aria-label="${esc(_t('h031'))}">${ms}</select></label>
      <label class="opt set" title="${esc(e === 'auto' ? _t('am_autoTip') : _t('h032'))}">${OPT_ICON.effort}<select id="ideaEffortSel" aria-label="${esc(_t('h032'))}">${es}</select></label>
    </div>`;
}
// 消息底部：自动挑了什么、为什么（挑失败时说明用了默认值）
function autoPickHTML(a) {
  if (!a) return '';
  if (a.error && !a.model && !a.effort) return `<span class="auto-pick" title="${esc(a.error)}">${_t('am_failed')}</span>`;
  const eff = a.effort ? (S.options.efforts.find((x) => x.id === a.effort) || {}).label || a.effort : '';
  const v = [a.model ? modelLabel(a.model) : '', eff ? _t('k1441', { v: eff }) : ''].filter(Boolean).join(' · ');
  return `<span class="auto-pick" title="${esc(a.reason || '')}">${esc(_t('am_picked', { v }))}</span>`;
}
// 首页视线：① 标题直接说「有几件事卡在你这里」→ ② 项目表，需要你处理的排最前、下一步用强调色 → ③ 写下一个想法 → ④ 直接问智能体。
// 回访用户的顺序固定不变（不随状态跳动）；第一次用、还没有项目时，输入框就是全部重点，放最前。
function homeHTML() {
  const h = new Date().getHours();
  const greet = h < 5 ? _t('k0999') : h < 11 ? _t('k1000') : h < 14 ? _t('k1001') : h < 18 ? _t('k1002') : _t('k1003');
  const setup = healthHTML();
  const projs = S.projects ? S.projects.slice().sort((a, b) => attnScore(b) - attnScore(a)).slice(0, 8) : null;
  const firstRun = projs && !projs.length && !S.projectsError;
  const attn = attnSummary();
  const nHot = projs ? projs.filter((p) => attnScore(p) > 0).length : 0;
  const rows = projs ? projs.map((p, i) => (i === nHot && nHot ? `<tr class="static grp"><td colspan="6">${_t('hm_other')}</td></tr>` : '') + projRow(p)).join('') : '<tr class="static"><td colspan="6"><div class="skeleton" style="height:40px"></div></td></tr>';
  const projSec = S.projectsError && !(projs && projs.length) ? errorBox(_t('k1004'), S.projectsError)
    : firstRun ? `<ol class="first-run" aria-label="${_t('k1005')}">
        <li>${_t('k1006')}</li>
        <li>${_t('k1007')}</li>
        <li>${_t('k1008')}</li>
        <li>${_t('k1009')}</li>
      </ol>
      <p class="empty-line">${_t('k1010')}<button type="button" class="linkish" data-new-project>${_t('k1011')}</button>${_t('k1012')}</p>`
      : `<div class="table-wrap"><table class="data home-proj"><thead><tr><th>${_t('k0268')}</th><th>${_t('k0974')}</th><th class="r">${_t('k0272')}</th><th class="r">${_t('k0273')}</th><th class="r">${_t('k1014')}</th><th class="r">${_t('k0173')}</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${S.projects && S.projects.length > 8 ? `<p class="data-note">${_t('k1013')}</p>` : ''}`;
  const composer = `<form class="idea" id="ideaForm">
      <textarea id="ideaInput" rows="3" aria-label="${_t('k1021')}" aria-describedby="ideaHint" placeholder="${_t('k1022')}"></textarea>
      <div class="idea-foot">
        <div class="route-pick" role="radiogroup" aria-label="${_t('k1023')}">${ROUTES.map(([k, zh, tip]) => `<button type="button" role="radio" aria-checked="${S.route2 === k}" class="${S.route2 === k ? 'active' : ''}" data-route2="${k}" title="${esc(tip)}">${zh}</button>`).join('')}
          ${((rt) => `<span class="route-tip" title="${esc(rt[2])}">${esc(rt[3])}</span>`)(ROUTES.find((r) => r[0] === S.route2) || ROUTES[0])}</div>
        ${ideaOptsHTML()}
        <button class="btn primary" type="submit" id="ideaSubmit">${_t('k1024', { MOD_KEY })}</button>
      </div>
    </form>
    ${ideaErrHTML()}
    ${ideaMissHTML()}
    <div class="idea-ex" id="ideaHint"><span>${_t('k1025')}</span>${EXAMPLES.map(([t, text]) => `<button type="button" data-example="${esc(text)}" title="${esc(text)}">${esc(t)}</button>`).join('')}</div>`;
  const quick = `<section class="home-sec">
      <div class="sec-head"><h2>${_t('k1026')}</h2></div>
      <div class="quick-list">${QUICK.map((q) => { const a = agentOf(q.agent); return `<button type="button" data-prefill="${q.agent}" data-text="${esc(q.text)}" title="${esc(_t('ux042'))}"><span>${esc(q.text)}</span><em>${esc(a.name)}</em></button>`; }).join('')}</div>
    </section>`;
  if (firstRun || S.projectsError) return `<div class="page">
    <div class="hero"><h1>${_t('k1019')}</h1><p class="sub">${_t('k1020')}</p></div>
    ${composer}
    ${setup}
    <section class="home-sec"><div class="sec-head"><h2>${firstRun ? _t('k1018') : _t('h015')}</h2></div>${projSec}</section>
    ${quick}
  </div>`;
  const title = !attn ? greet : attn.n ? _t('hm_t1', { n: attn.n }) : _t('hm_t0');
  const sub = !attn ? '' : attn.n ? attn.line : _t('hm_d0');
  return `<div class="page">
    <div class="hero home-status ${attn && attn.n ? 'has-attn' : ''} ${attn && attn.bad ? 'bad' : ''}"><h1>${title}</h1>${sub ? `<p class="sub">${esc(sub)}</p>` : ''}</div>
    ${setup}
    <section class="home-sec home-proj-sec">
      <div class="sec-head"><h2>${_t('h015')}</h2><span class="meta">${S.projects && S.projects.length ? S.projects.length : ''}</span></div>
      ${projSec}
    </section>
    <section class="home-sec home-new">
      <div class="sec-head"><h2>${_t('k1019')}</h2></div>
      ${composer}
    </section>
    ${quick}
  </div>`;
}


/* ================= 模拟实盘（前向检验） ================= */
let PMODE; _regT(() => { PMODE = { sim: [_t('k1028'), _t('k1029')], alpaca: [_t('k1030'), _t('k1031')] }; });;
const dayT = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), 17) / 1000; // 美东中午：任何美国时区显示都是同一天
const money0 = (v) => (v == null || Number.isNaN(+v) ? '—' : `$${(+v).toLocaleString(LOC(), { maximumFractionDigits: 0 })}`);
function paperBadge(s) {
  if (s.status !== 'active') return _t('k1032');
  if (s.lastRun && s.lastRun.skipped) return _t('k1033');
  if (s.lastRun && !s.lastRun.ok) return _t('k1034');
  if (!s.lastRun) return _t('k1035');
  return _t('k1036');
}
const modeTag = (m) => `<span class="pmode ${m === 'alpaca' ? 'alpaca' : 'sim'}">${esc(PMODE[m] ? PMODE[m][0] : m)}</span>`;

function paperTabHTML(projectId, stg) {
  const intro = '';
  const list = S.papers;
  if (list && list.error) return `${intro}${errorBox(_t('k1038'), list.error)}`;
  if (!Array.isArray(list)) return `${intro}<div class="skeleton" style="height:120px"></div>`;
  if (!list.length) return `<p class="psec-empty">${_t('ux036')}${stg && stg.step === 3 ? '' : ''}</p>`;
  const now = new Date();
  return `${intro}<div class="panel"><div class="table-wrap"><table class="data"><thead><tr><th>${_t('k0947')}</th><th>${_t('k0269')}</th><th>${_t('k1045')}</th><th class="r">${_t('k1046')}</th><th class="r">${_t('k1047')}</th><th class="r">${_t('k0274')}</th><th>${_t('k1048')}</th><th>${_t('k1049')}</th></tr></thead><tbody>
    ${list.map((x) => {
      const m = x.summary;
      const run = paperLastRun(x);
      const nx = paperNextRun(x, now);
      const nxT = nx.kind === 'stopped' ? '—' : nx.kind === 'soon' ? _t('k1041') : nx.at ? localWhen(nx.at) : '—';
      return `<tr data-href="#/p/${projectId}/s/${esc(x.sessionId)}"><td class="name" title="${esc(x.name)}">${modeTag(x.mode)} ${esc(x.name)}</td><td title="${x.lastRun ? `${_t('k1042', { v: esc(ago(x.lastRun.at)) })}` : ''}">${paperBadge(x)}</td><td class="mono" title="${m ? `${_t('k1043', { v: esc(m.days) })}` : ''}">${esc(x.frozenAt || '—')}${x.frozenAt ? `<span class="when">${_t('k1044', { v: calDays(x.frozenAt, now) })}</span>` : ''}</td>
        <td class="r ${m ? signClass(m.return) : ''}">${m ? pc(m.return, 2) : '—'}</td><td class="r">${m ? pc(m.benchmarkReturn, 2) : '—'}</td><td class="r ${m && m.maxDrawdown ? 'down' : ''}">${m ? pc(m.maxDrawdown, 2) : '—'}</td>
        <td title="${run.why ? esc(zhErr(run.why)) : ''}">${resHTML(run.kind)}${run.at ? `<span class="when"> ${esc(ymd2(run.at))}</span>` : ''}</td><td class="mono when">${esc(nxT)}</td></tr>`;
    }).join('')}</tbody></table></div></div>`;
}

async function loadPaperView(silent = false) {
  const { projectId, sessionId } = S.route;
  if (!silent || !S.paper || !S.paper.session || S.paper.session.sessionId !== sessionId) { S.paper = null; renderMain(); }
  const [r] = await Promise.all([safePost('/api/paper/read', { projectId, sessionId }), ensureProject(projectId)]);
  if (S.route.view !== 'paper' || S.route.sessionId !== sessionId) return;
  S.paper = r.success ? r : { loadError: (r.errors || []).join('; ') };
  renderMain();
  renderCrumbs();
  renderCtx();
  schedulePoll();
  if (r.success) loadDrift(projectId, sessionId);
}
// 「是否在预期内」：服务器只读来源回测的结果文件；失败不影响页面其余部分
async function loadDrift(projectId, sessionId) {
  if (!S.drift || S.drift.sessionId !== sessionId) S.drift = { sessionId };
  let next;
  try { const r = await api(`/api/data/paper/drift?projectId=${encodeURIComponent(projectId)}&sessionId=${encodeURIComponent(sessionId)}`); next = r.success ? { sessionId, data: r.drift } : { sessionId, error: (r.errors || []).join(_t('k0007')) }; } catch (e) { next = { sessionId, error: e.message }; }
  if (S.route.view !== 'paper' || S.route.sessionId !== sessionId) return;
  S.drift = next;
  renderMain();
}


function drawPaperChart() {
  const L = S.paper && S.paper.latest;
  const el = $('#pxChart');
  if (!el || !L) return;
  if (L.equity.length < 2) { el.innerHTML = _t('k1050'); return; }
  const eq = L.equity.map(([d, v]) => [dayT(d), v]);
  const bm = (L.benchmark || []).map(([d, v]) => [dayT(d), v]);
  lineChart(el, [
    { label: _t('k1051'), color: getCss('--text'), pts: eq },
    ...(bm.length ? [{ label: _t('k0163'), color: getCss('--muted'), pts: bm, dash: true }] : []),
  ], { height: 260, fmt: (v) => (Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : `$${(v / 1e3).toFixed(1)}k`), tipFmt: money0, empty: _t('k1052') });
}

/* ================= 模拟实盘：一眼看清（只读，数据都来自 session.json / latest.json / log.jsonl） ================= */
const ET_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false });
function etParts(d) {
  const o = Object.fromEntries(ET_FMT.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${o.year}-${o.month}-${o.day}`, hm: `${o.hour === '24' ? '00' : o.hour}:${o.minute}`, weekday: o.weekday };
}
const addDaysISO = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const prevWeekdayISO = (iso) => { let d = addDaysISO(iso, -1); while ([0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())) d = addDaysISO(d, -1); return d; };
// 美股休市日历（public/calendar.js，和服务端共用同一份规则）；万一没加载到，就退回只看周末
const CAL = window.HelmCalendar || null;
const isTradingISO = (iso) => (CAL ? CAL.isTradingDay(iso) : ![0, 6].includes(new Date(`${iso}T12:00:00Z`).getUTCDay()));
// 和 lib/paper.mjs 的 expectedTradingDate 一样：美东的昨天及以前最近的交易日（LEAN 回测最多只跑到美东的昨天）
function expectedDataDateET(now) {
  const e = etParts(now);
  return CAL ? CAL.prevTradingDay(e.date) : prevWeekdayISO(e.date);
}
// 交易日 iso 结束、可以跑的时刻：美东 iso 的第二天 00:00（夏令时 / 冬令时各试一次）
function etAfterDay(iso) {
  const next = addDaysISO(iso, 1);
  const [y, m, d] = next.split('-').map(Number);
  for (const off of [4, 5]) { const t = new Date(Date.UTC(y, m - 1, d, off, 0)); const e = etParts(t); if (e.date === next && e.hm === '00:00') return t; }
  return new Date(Date.UTC(y, m - 1, d, 5, 0));
}
// 下次自动运行的估计：Helm 每 10 分钟检查一次；这一天的数据还没跑成功就立刻跑（刚试过的 3 小时后再试）；跑完了就等下一个交易日结束（美东午夜，跳过休市日）
function paperNextRun(s, now = new Date()) {
  if (!s || s.status !== 'active') return { kind: 'stopped' };
  const want = expectedDataDateET(now);
  const lr = s.lastRun;
  if (!(lr && lr.ok && lr.dataDate >= want)) {
    const last = s.lastAttemptAt ? Date.parse(s.lastAttemptAt) : 0;
    if (last && last + 3 * 3600e3 > now.getTime()) return { kind: 'retry', at: new Date(last + 3 * 3600e3) };
    return { kind: 'soon', at: now };
  }
  let day = addDaysISO(lr.dataDate > want ? lr.dataDate : want, 1); // 已经跑过的那天之后的第一个交易日
  let closed = null; // 中间跳过的休市日（不含周末），页面上说明为什么不是明天
  for (let i = 0; i < 12; i++) {
    const t = etAfterDay(day);
    if (isTradingISO(day) && t > now) return { kind: 'sched', at: t, closed };
    const why = CAL ? CAL.holidayName(day, HELM_I18N.lang()) : null;
    if (why && !closed) closed = { date: day, name: why };
    day = addDaysISO(day, 1);
  }
  return { kind: 'sched', at: null };
}
const localWhen = (d, withDay = true) => d.toLocaleString(LOC(), { ...(withDay ? { month: 'numeric', day: 'numeric', weekday: 'short' } : {}), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const tzName = (d) => (new Intl.DateTimeFormat(LOC(), { timeZoneName: 'short' }).formatToParts(d).find((x) => x.type === 'timeZoneName') || {}).value || '';
const calDays = (iso, now = new Date()) => { const a = Date.parse(`${iso}T00:00:00Z`); const n = Date.parse(`${etParts(now).date}T00:00:00Z`); return Number.isFinite(a) ? Math.max(0, Math.round((n - a) / 86400e3)) : null; };

// 上次运行的状态：成功 / 跳过（带记录下来的原因）/ 失败
function paperLastRun(s) {
  const lr = s.lastRun;
  if (!lr) return { kind: s.status === 'active' ? 'first' : 'none' };
  if (lr.ok) return { kind: 'ok', at: lr.at, dataDate: lr.dataDate };
  if (lr.skipped) return { kind: 'skip', at: lr.at, why: lr.error || '' };
  return { kind: 'fail', at: lr.at, why: lr.error || '' };
}
let resHTML; _regT(() => { resHTML = (k) => (k === 'ok' ? _t('k1053') : k === 'skip' ? _t('k1054') : k === 'fail' ? _t('k1055') : '—'); });
const ymd2 = (iso) => { const d = parseDate(iso); return d ? `${d.toLocaleDateString(LOC(), { month: 'numeric', day: 'numeric' })} ${localWhen(d, false)}` : '—'; };
// 冻结后的策略收益和基准收益：两条曲线按日期对齐，用同一段天数算。缺任何一条就只显示有的
function paperFwd(P) {
  const L = P.latest;
  const eq = L && Array.isArray(L.equity) ? L.equity : [];
  const bm = L && Array.isArray(L.benchmark) ? L.benchmark : [];
  const ok = (a) => a.filter((p) => Array.isArray(p) && Number.isFinite(+p[1]) && +p[1] > 0);
  const e = ok(eq); const b = ok(bm);
  if (e.length < 2) return null;
  const bd = new Map(b.map((p) => [p[0], +p[1]]));
  const common = e.filter((p) => bd.has(p[0]));
  const out = { from: e[0][0], to: e[e.length - 1][0], ret: +e[e.length - 1][1] / +e[0][1] - 1, points: e.length, bench: null };
  if (common.length >= 2) {
    const a = common[0]; const z = common[common.length - 1];
    out.from = a[0]; out.to = z[0];
    out.ret = +z[1] / +a[1] - 1;
    out.bench = bd.get(z[0]) / bd.get(a[0]) - 1;
  }
  return out;
}
function paperGlanceHTML(s, P) {
  const now = new Date();
  const m = P.latest && P.latest.summary;
  const fwd = paperFwd(P);
  const run = paperLastRun(s);
  const nx = paperNextRun(s, now);
  const days = s.frozenAt ? calDays(s.frozenAt, now) : null;
  const cell = (k, v, sub, title = '') => `<div class="pg-cell"${title ? ` title="${esc(title)}"` : ''}><div class="pg-k">${k}</div><div class="pg-v">${v}</div>${sub ? `<div class="pg-sub">${sub}</div>` : ''}</div>`;
  const frozen = cell(_t('k1045'), s.frozenAt ? `<span class="mono">${esc(s.frozenAt)}</span>` : '—',
    s.frozenAt ? `${_t('k1057', { days })}${m && m.days != null ? ` ${_t('k1056', { v: esc(m.days) })}` : ''}` : _t('k1058'));
  const ret = cell(_t('k1059'), fwd ? `<span class="${signClass(fwd.ret)}">${pc(fwd.ret, 2)}</span>` : '—',
    fwd ? (fwd.bench != null ? `${_t('k1060', { v: signClass(fwd.bench), v2: pc(fwd.bench, 2), v3: pc(fwd.ret - fwd.bench, 2) })}<br>${esc(fwd.from)} → ${esc(fwd.to)}` : `${_t('k1061', { v: esc(fwd.from), v2: esc(fwd.to) })}`) : _t('k1062'),
    _t('k1063'));
  const lastV = run.kind === 'none' ? '—' : run.kind === 'first' ? _t('k1064') : `${resHTML(run.kind)}`;
  const lastSub = run.kind === 'ok' ? `${_t('k1065', { v: esc(ymd2(run.at)), v2: esc(run.dataDate) })}` : run.kind === 'fail' ? `${esc(ymd2(run.at))} · ${_t('ux014')}` : run.kind === 'skip' ? `${esc(ymd2(run.at))}<br>${esc(zhErr(run.why).slice(0, 160))}` : '';
  const last = cell(_t('k1048'), lastV, lastSub);
  let nxV; let nxSub;
  if (nx.kind === 'stopped') { nxV = _t('k1066'); nxSub = _t('k1067'); } else if (nx.kind === 'soon') { nxV = _t('k1068'); nxSub = _t('k1069'); } else if (nx.kind === 'retry') { nxV = `<span class="mono">${esc(localWhen(nx.at))}</span>`; nxSub = `${_t('k1070', { v: esc(tzName(nx.at)) })}`; } else if (nx.at) { nxV = `<span class="mono">${esc(localWhen(nx.at))}</span>`; nxSub = `${_t('k1072', { v: esc(tzName(nx.at)) })}${nx.closed ? `<br>${_t('k1071', { v: esc(nx.closed.date.slice(5)), v2: esc(nx.closed.name) })}` : ''}`; } else { nxV = '—'; nxSub = ''; }
  const next = cell(`${_t('k1074')}${nx.kind === 'stopped' ? '' : _t('k1073')}`, nxV, nxSub);
  const foreign = s.mode === 'alpaca' ? paperForeign(s, P) : null;
  const note = foreign && foreign.list.length ? `<p class="pg-note">${_t('k1076')}${foreign.list.map((p) => `<span class="mono">${_t('k1075', { v: esc(p.symbol), v2: num(p.qty, 0) })}</span>`).join(_t('k0015'))}${_t('k1077')}</p>` : '';
  return `<div class="panel section"><div class="panel-head"><h2>${_t('k1078')}</h2><span class="meta">${_t('k1079')}</span></div><div class="pg-grid">${frozen}${m && m.days ? '' : ret}${last}${next}</div>${paperVerdictHTML(s)}${note}${paperRunsHTML(s, P, run)}</div>`;
}
/* ---- 是否在预期内：冻结后的收益 vs 来源回测按块自助法得到的范围 ---- */
let PD_WHY; _regT(() => { PD_WHY = _t('k1080'); });
const PD_ICON = { early: '…', in: '✓', low: '↓', high: '↑' };
function driftBarHTML(D) {
  const b = D.band;
  const lo0 = Math.min(b.p5, D.r, 0); const hi0 = Math.max(b.p95, D.r, 0);
  const pad = (hi0 - lo0) * 0.06 || 0.005; const lo = lo0 - pad; const hi = hi0 + pad;
  const at = (x) => Math.min(100, Math.max(0, ((x - lo) / (hi - lo)) * 100));
  const f = (x) => at(x).toFixed(2);
  const mp = at(D.r);
  const side = mp < 22 ? 'l' : mp > 78 ? 'r' : 'c';
  const aria = `${_t('k1081', { v: pc(D.r, 2), v2: pc(b.p5, 2), v3: pc(b.p95, 2), v4: pc(b.p50, 2) })}`;
  return `<div class="pd-bar" role="img" aria-label="${esc(aria)}">
      ${_t('k1082', { side, v: f(D.r), v2: pc(D.r, 2), v3: f(0), v4: f(b.p5), toFixed: (at(b.p95) - at(b.p5)).toFixed(2), v5: f(b.p25), toFixed2: (at(b.p75) - at(b.p25)).toFixed(2), v6: f(b.p50), v7: f(D.r) })}
    </div>
    <div class="pd-leg">${_t('k1083', { v: pc(b.p5, 2), v2: pc(b.p25, 2), v3: pc(b.p50, 2), v4: pc(b.p75, 2), v5: pc(b.p95, 2) })}</div>`;
}
function paperVerdictHTML(s) {
  const wrap = (inner) => `<div class="pd" id="paperDrift">${inner}</div>`;
  const head = (v, sub, why = true) => `<div class="pd-head">${_t('k1085', { v })}${sub ? `<span class="pd-sub">${sub}</span>` : ''}${why ? _t('k1084') : ''}</div>${why ? `<p class="gate-why pd-why" hidden>${esc(PD_WHY)}</p>` : ''}`;
  const d = S.drift && S.drift.sessionId === s.sessionId ? S.drift : null;
  if (!d || (!d.data && d.error == null)) return wrap(`${head('', '', false)}<div class="skeleton" style="height:44px;margin-top:10px"></div>`);
  if (d.error != null) return wrap(`${head('', '', false)}<div class="error-box load-err" role="alert" style="margin-top:10px"><div>${_t('k1086', { v: esc(zhErr(String(d.error)).slice(0, 200)) })}</div><button type="button" class="btn sm" data-reload>${_t('k0013')}</button></div>`);
  const D = d.data;
  if (!D.available) return wrap(`${head('', '', false)}<div class="empty" style="padding:10px 0 2px;text-align:left">${esc(D.note || _t('k1087'))}</div>`);
  const rk = Math.round(D.rank * 100);
  const ex = D.excess ? `${_t('k1088', { v: signClass(D.excess.bench), v2: pc(D.excess.bench, 2), v3: signClass(D.excess.excess), v4: pc(D.excess.excess, 2), v5: esc(D.excess.days) })}` : _t('k1089');
  const dd = `${_t('k1090', { v: pc(-D.dd.forward, 2, false), v2: pc(-D.dd.backtest, 1, false) })}`;
  return `<div class="pd" id="paperDrift" data-n="${esc(D.n)}" data-r="${esc(D.r)}" data-verdict="${esc(D.verdict)}">
    ${head(`<b class="pd-verdict pd-v-${esc(D.verdict)}"><i aria-hidden="true">${PD_ICON[D.verdict] || ''}</i>${esc(D.verdictText)}</b>`, `${_t('k1091', { v: esc(D.n), v2: signClass(D.r), v3: pc(D.r, 2), rk })}`)}
    ${driftBarHTML(D)}
    <p class="pd-line">${ex}<span class="pd-dot">·</span>${dd}</p>
    <p class="pd-note">${D.notes.map(esc).join(' ')}</p>
  </div>`;
}
// 账户里不是这个模拟买的持仓：最近一次运行看到的；还没运行过就用开始时的列表
function paperForeign(s, P) {
  const snap = (P.log || []).slice().reverse().find((x) => x.alpaca && Array.isArray(x.alpaca.foreign));
  const list = snap ? snap.alpaca.foreign : s.otherPositionsAtStart;
  return Array.isArray(list) ? { list, snap } : null;
}
// 最近 10 次运行：成功 / 跳过（原因）/ 失败（原因）。失败也写进每日记录（failed: true）；老版本没写，所以 lastRun 的失败比日志里最后一条新时仍补一行
function paperRunsHTML(s, P, run) {
  const log = Array.isArray(P.log) ? P.log : [];
  const rows = log.slice(-10).reverse().map((x) => {
    if (x.failed) return { at: x.runAt, dataDate: x.dataDate, kind: 'fail', why: x.error || '' };
    const bits = [];
    if (x.skipReason) bits.push(x.skipReason);
    else {
      for (const e of x.fetchErrors || []) bits.push(`${_t('k1092', { e })}`);
      const er = (x.alpaca && x.alpaca.errors) || [];
      if (er.length) bits.push(`${_t('k1093', { n: er.length })}${er.slice(0, 3).map((e) => `${e.symbol} ${e.error}`).join(_t('k0007'))}`);
      const sub = x.alpaca && Array.isArray(x.alpaca.submitted) ? x.alpaca.submitted.length : null;
      if (sub != null && !er.length && !bits.length) bits.push(sub ? `${_t('k1094', { sub })}` : _t('k1095'));
    }
    return { at: x.runAt, dataDate: x.dataDate, kind: x.skipReason ? 'skip' : 'ok', why: bits.join(_t('k0007')) };
  });
  const lastLog = log.length ? Date.parse(log[log.length - 1].runAt) : 0;
  if (run.kind === 'fail' && Date.parse(run.at) > lastLog) {
    const top = log[log.length - 1];
    // 同一个原因连续失败时每日记录里只有第一条：这一行显示最近一次的时间，并说明从什么时候开始失败
    if (top && top.failed && top.error === run.why) rows[0] = { ...rows[0], at: run.at, why: `${_t('k1096', { why: run.why, v: ymd2(top.runAt) })}` };
    else rows.unshift({ at: run.at, dataDate: null, kind: 'fail', why: run.why });
  }
  if (!rows.length) return _t('k1097');
  if (run.kind === 'fail' && rows[0] && rows[0].kind === 'fail') rows[0] = { ...rows[0], why: _t('ux014') + (String(rows[0].why).startsWith(run.why) ? String(rows[0].why).slice(run.why.length) : '') };
  const shown = rows.slice(0, 10);
  return `<div class="table-wrap" style="margin-top:14px"><table class="data runs-tbl"><thead><tr><th>${_t('k1098')}</th><th>${_t('k1099')}</th><th>${_t('k0975')}</th><th>${_t('k1100')}</th></tr></thead><tbody>
    ${shown.map((r) => `<tr class="static"><td class="mono">${esc(ymd2(r.at))}</td><td class="mono">${esc(r.dataDate || '—')}</td><td>${resHTML(r.kind)}</td><td class="why">${r.why ? esc(zhErr(r.why).slice(0, 300)) : '—'}</td></tr>`).join('')}
  </tbody></table></div>`;
}

let ALP_STATUS_ZH; _regT(() => { ALP_STATUS_ZH = { new: _t('k1101'), accepted: _t('k1102'), pending_new: _t('k1103'), partially_filled: _t('k0635'), filled: _t('k1104'), canceled: _t('k1105'), expired: _t('k1106'), rejected: _t('k1107'), done_for_day: _t('k1108'), replaced: _t('k1109') }; });
let LEAN_STATUS_ZH; _regT(() => { LEAN_STATUS_ZH = { 0: _t('k1110'), 1: _t('k1101'), 2: _t('k0635'), 3: _t('k1104'), 5: _t('k1105'), 7: _t('k0633') }; });

// 执行偏差：上一次下的单实际成交 vs 计划（正数 = 比计划差）
const usd2 = (v) => (v == null || Number.isNaN(+v) ? '—' : `${+v > 0 ? '+' : +v < 0 ? '−' : ''}$${Math.abs(+v).toLocaleString(LOC(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const bpsT = (v) => (v == null || Number.isNaN(+v) ? '—' : `${+v > 0 ? '+' : ''}${(+v).toFixed(2)}`);
const costClass = (v) => (v == null || !+v ? '' : +v > 0 ? 'down' : 'up');
function paperDriftHTML(s, P) {
  const head = (meta) => `<div class="panel-head"><h2>${_t('k1111')}</h2><span class="meta">${meta}</span></div>`;
  if (s.mode !== 'alpaca') return '<div class="panel section">' + head(_t('k1112')) + _t('k1113');
  const L = P.latest;
  const D = (L && L.drift) || ((P.log || []).slice().reverse().find((x) => x.drift) || {}).drift;
  if (!D) return '<div class="panel section">' + head(_t('k1112')) + _t('k1114');
  if (!D.available) return `<div class="panel section">${head(_t('k1112'))}<div class="${D.error ? 'error-box' : 'empty'}" style="padding:16px">${esc(D.error || D.reason || _t('k1115'))}</div></div>`;
  const T = D.totals || {};
  const tot = `<p class="sub" style="margin:0;padding:10px 16px 12px;line-height:1.9">
      ${_t('k1122', { v: costClass(T.shortfallUsd), v2: usd2(T.shortfallUsd), v3: bpsT(T.shortfallBps), v4: costClass(T.executionCostUsd), v5: usd2(T.executionCostUsd) })}${T.avgSlippageBps != null ? `${_t('k1116', { v: bpsT(T.avgSlippageBps) })}` : ''}
      ${_t('k1123', { v: costClass(T.opportunityCostUsd), v2: usd2(T.opportunityCostUsd) })} ${T.notFullyFilled ? `<span class="warn-t">${_t('k1117', { notFullyFilled: T.notFullyFilled })}</span>` : `${T.orders || 0} ${_t('k1118')}`}
      ${T.untargetedCount ? ` ${_t('k1120')}${(D.untargeted || []).map((u) => `${_t('k1119', { v: esc(u.symbol), v2: num(u.qty, 0), v3: pct(u.weight, false) })}`).join(_t('k0015'))}</span>` : ''}
      ${T.missingPrice && T.missingPrice.length ? ` ${_t('k1121')}${esc(T.missingPrice.join(_t('k0015')))}` : ''}</p>`;
  const rows = (D.rows || []).map((r) => `<tr class="static${r.status === 'rejected' ? ' bad' : r.status === 'none' ? ' dim' : ''}" title="${esc([r.refSource ? `${_t('k1124', { refSource: r.refSource })}` : '', r.error || ''].filter(Boolean).join(_t('k0007')))}">
      <td class="mono">${esc(r.symbol)} ${r.side ? (r.side === 'buy' ? _t('k1125') : _t('k1126')) : ''}</td>
      <td>${r.status === 'filled' || r.status === 'none' ? esc(r.statusZh) : `<span class="warn-t">${esc(r.statusZh)}</span>`}</td>
      <td class="r">${r.side ? `${num(r.filledQty, 0)}/${num(r.qty, 0)}` : '—'}</td>
      <td class="r">${r.refPrice != null ? num(r.refPrice) : '—'} → ${r.fillPrice != null ? num(r.fillPrice) : '—'}</td>
      <td class="r ${costClass(r.slippageBps)}">${bpsT(r.slippageBps)}</td>
      <td class="r ${costClass(r.slippageUsd)}">${r.slippageUsd != null ? usd2(r.slippageUsd) : '—'}</td>
      <td class="r">${pct(r.targetWeight, false)} → ${pct(r.actualWeight, false)}</td></tr>`).join('');
  return `<div class="panel section">${head(`${_t('k1127', { v: esc(D.against) })}`)}${tot}
    ${rows ? `<div class="table-wrap"><table class="data"><thead><tr><th>${_t('k0114')}</th><th>${_t('k0632')}</th><th class="r">${_t('k1128')}</th><th class="r">${_t('k1129')}</th><th class="r">${_t('k1130')}</th><th class="r">${_t('k1131')}</th><th class="r">${_t('k1132')}</th></tr></thead><tbody>${rows}</tbody></table></div>` : _t('k1133')}
    <p class="data-note" style="padding:0 16px 12px">${esc(D.note || '')}</p></div>`;
}

// KPI 里的资金：放得下又不过粗（$1.02M），完整金额在悬停提示里
const moneyM = (v) => (v == null || !Number.isFinite(+v) ? '—' : Math.abs(+v) >= 1e6 ? `$${(+v / 1e6).toFixed(2)}M` : money0(v));
function paperHTML() {
  const P = S.paper;
  const { projectId } = S.route;
  if (!P) return `<div class="page"><div class="skeleton" style="height:28px;width:40%;margin-bottom:22px"></div><div class="skeleton" style="height:84px"></div><div class="skeleton" style="height:260px;margin-top:18px"></div></div>`;
  if (P.loadError) return `<div class="page">${errorBox(_t('k1038'), P.loadError)}</div>`;
  const s = P.session; const L = P.latest; const m = L && L.summary;
  const active = s.status === 'active';
  const head = `<div class="page-head">
      <div>
        <div class="eyebrow">${_t('k1146', { v: esc(s.sessionId), v2: paperBadge(s), v3: modeTag(s.mode), v4: agoT(s.created) })}</div>
        <h1>${esc(s.name)}</h1>
        <p class="sub">${_t('k1147', { projectId, v: esc(s.sourceBacktestId) })}${esc(s.sourceName || s.sourceBacktestId)}${_t('k1148')} ${esc(s.frozenAt || _t('k1135'))} ${_t('k1149')}${s.mode === 'sim' ? ` ${_t('k1136', { v: money0(s.capital) })}` : ''}</p>
      </div>
      <div class="actions">
        ${active ? `<button class="btn quiet" data-action="paper-stop" title="${_t('ux005')}">${_t('k1140')}</button>` : ''}
        ${active ? `<button class="btn" data-action="paper-run" ${P.running ? 'disabled' : ''} title="${_t('k1139')}">${P.running ? _t('k1137') : _t('k1138')}</button>` : ''}
        ${m ? askBtn('analyst', _t('k1141'), `${_t('k1143', { sessionId: s.sessionId, projectId })}${s.mode === 'alpaca' ? _t('k1142') : ''}${_t('k1144')}`) : ''}
      </div>
    </div>`;
  const err = s.lastRun && s.lastRun.skipped ? `<div class="order-warn" style="margin-bottom:16px">${_t('k1150', { v: agoT(s.lastRun.at) })}${esc(s.lastRun.error || '')}<br>${_t('k1151')}</div>`
    : s.lastRun && !s.lastRun.ok ? `<div class="error-box" style="margin-bottom:16px"><b>${_t('k1152', { v: agoT(s.lastRun.at) })}</b><pre>${esc(s.lastRun.error || '')}</pre><p class="sub" style="margin:6px 0 0">${_t('k1151')}</p></div>` : '';
  const running = P.running || (active && !s.lastRun) ? `<div class="panel" style="padding:16px 18px;margin-bottom:16px">${_t('k1153')}</div>` : '';
  const kpis = m && !m.days ? `<p class="pp-wait">${_t('k1155')}${s.mode === 'alpaca' && (m.alpacaOwnEquity ?? m.alpacaEquity) != null ? ` ${_t('k1154')} ${money(m.alpacaOwnEquity ?? m.alpacaEquity, true)}` : ''}</p>` : m ? `<div class="kpis">
      <div class="kpi"><div class="k">${_t('k1046')}</div><div class="v ${signClass(m.return)}">${pc(m.return, 2)}</div></div>
      <div class="kpi"><div class="k">${_t('k1047')}</div><div class="v">${pc(m.benchmarkReturn, 2)}</div></div>
      <div class="kpi"><div class="k">${_t('k0303')}</div><div class="v ${m.benchmarkReturn != null ? signClass(m.return - m.benchmarkReturn) : ''}">${m.benchmarkReturn != null ? pc(m.return - m.benchmarkReturn, 2) : '—'}</div></div>
      <div class="kpi"><div class="k">${_t('k0274')}</div><div class="v ${m.maxDrawdown ? 'down' : ''}">${pc(m.maxDrawdown, 2)}</div></div>
      <div class="kpi"><div class="k">${_t('k1162')}</div><div class="v">${esc(m.days)}</div></div>
      <div class="kpi"><div class="k" ${s.mode === 'alpaca' && m.alpacaOwnEquity != null ? _t('k1156') : ''}>${s.mode === 'alpaca' ? (m.alpacaOwnEquity != null ? _t('k1157') : _t('k1158')) : _t('k1159')}</div><div class="v" title="${esc(money0(s.mode === 'alpaca' ? (m.alpacaOwnEquity != null ? m.alpacaOwnEquity : m.alpacaEquity) : m.equity))}">${moneyM(s.mode === 'alpaca' ? (m.alpacaOwnEquity != null ? m.alpacaOwnEquity : m.alpacaEquity) : m.equity)}</div></div>
    </div>
    <p class="sub" style="margin:10px 0 0">${_t('k1163', { v: esc(m.dataDate) })}${m.days < 60 ? ` ${_t('k1160')}` : ''}${m.invalidOrders ? ` <span class="warn-t">${_t('k1161', { invalidOrders: m.invalidOrders })}</span>` : ''}</p>` : '';
  const chart = L && !(m && !m.days) ? `<div class="panel section"><div class="panel-head"><h2>${_t('k1166')}</h2><span class="meta">${s.mode === 'alpaca' ? _t('k1164') : _t('k1165')}</span></div><div class="chart-wrap" id="pxChart"></div></div>` : '';
  const H = L ? Object.entries(L.holdings || {}) : [];
  const holdings = L ? `<div class="panel section"><div class="panel-head"><h2>${_t('k1171')}</h2><span class="meta">${_t('k1172', { v: esc(L.dataDate) })}</span></div>
    ${H.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>${_t('k0114')}</th><th class="r">${_t('k0627')}</th><th class="r">${_t('k1167')}</th><th class="r">${_t('k1168')}</th><th class="r">${_t('k1169')}</th></tr></thead><tbody>
      ${H.sort((a, b) => (b[1].weight || 0) - (a[1].weight || 0)).map(([sym, h]) => `<tr><td class="mono">${esc(sym)}</td><td class="r">${(+h.qty).toLocaleString(LOC())}</td><td class="r">${h.pendingQty ? (+h.pendingQty).toLocaleString(LOC()) : '—'}</td><td class="r">${h.price != null ? `$${num(h.price)}` : '—'}</td><td class="r">${h.weight != null ? pct(h.weight, false) : '—'}</td></tr>`).join('')}
    </tbody></table></div>` : _t('k1170')}</div>` : '';
  let orders = '';
  if (s.mode === 'alpaca') {
    const ao = P.alpacaOrders;
    orders = `<div class="panel section"><div class="panel-head"><h2>${_t('k1177')}</h2><span class="meta">${_t('k1178')}</span></div>
      ${ao && ao.error ? `<div class="error-box">${_t('k1173', { v: esc(ao.error) })}</div>` : Array.isArray(ao) && ao.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>${_t('k1174')}</th><th>${_t('k0114')}</th><th>${_t('k0626')}</th><th>${_t('k0627')}</th><th>${_t('k0632')}</th><th>${_t('k1175')}</th><th>${_t('k0269')}</th></tr></thead><tbody>
        ${ao.map((o) => `<tr><td class="when">${esc((o.submittedAt || '').replace('T', ' ').slice(0, 16))}</td><td class="mono">${esc(o.symbol)}</td><td>${o.side === 'buy' ? _t('k1125') : _t('k1126')}</td><td class="mono">${num(o.qty, 0)}</td><td class="mono">${num(o.filledQty, 0)}</td><td class="mono">${o.filledAvgPrice != null ? `$${num(o.filledAvgPrice)}` : '—'}</td><td>${esc(ALP_STATUS_ZH[o.status] || o.status)}</td></tr>`).join('')}
      </tbody></table></div>` : _t('k1176')}</div>`;
  } else if (L) {
    orders = `<div class="panel section"><div class="panel-head"><h2>${_t('k1181')}</h2><span class="meta">${_t('k1182')}</span></div>
      ${L.orders && L.orders.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>${_t('k1179')}</th><th>${_t('k0114')}</th><th>${_t('k0627')}</th><th>${_t('k0628')}</th><th>${_t('k0269')}</th></tr></thead><tbody>
        ${L.orders.slice().reverse().map((o) => `<tr class="${o.status === 7 ? 'bad' : ''}"><td class="when">${esc(String(o.time).slice(0, 10))}</td><td class="mono">${esc(o.symbol)}</td><td class="mono">${num(o.qty, 0)}</td><td class="mono">${o.price ? `$${num(o.price)}` : '—'}</td><td>${esc(LEAN_STATUS_ZH[o.status] || o.status)}</td></tr>`).join('')}
      </tbody></table></div>` : _t('k1180')}</div>`;
  }
  const log = P.log && P.log.length ? `<div class="panel section"><div class="panel-head"><h2>${_t('k1186')}</h2><span class="meta">${_t('k1187')}</span></div><div class="table-wrap"><table class="data"><thead><tr><th>${_t('k1099')}</th><th>${_t('k1098')}</th><th>${_t('k1188')}</th><th>${_t('k0163')}</th>${s.mode === 'alpaca' ? _t('k1183') : ''}<th>${_t('k1189')}</th></tr></thead><tbody>
      ${P.log.slice().reverse().slice(0, 60).map((x) => (x.failed ? `<tr><td class="mono">${esc(x.dataDate || '—')}</td><td class="when">${agoT(x.runAt)}</td><td colspan="${s.mode === 'alpaca' ? 4 : 2}">${resHTML('fail')}</td><td class="sub">—</td></tr>` : `<tr><td class="mono">${esc(x.dataDate)}</td><td class="when">${agoT(x.runAt)}</td><td class="mono">${money0(x.equity)}</td><td class="mono">${money0(x.benchmarkEquity)}</td>${s.mode === 'alpaca' ? `<td class="mono">${money0(x.alpaca && x.alpaca.account && x.alpaca.account.equity)}</td><td>${x.alpaca ? `${(x.alpaca.submitted || []).length} ${_t('k1185')}${(x.alpaca.errors || []).length ? `${_t('k1184', { n: x.alpaca.errors.length })}` : ''}` : '—'}</td>` : ''}<td class="sub">${esc([...(x.fetchErrors || []).map((e) => `${_t('k1092', { e })}`), ...((x.alpaca && x.alpaca.errors) || []).map((e) => `${e.symbol} ${e.error}`), (x.alpaca && x.alpaca.note) || ''].filter(Boolean).join(_t('k0007')).slice(0, 200))}</td></tr>`)).join('')}
    </tbody></table></div></div>` : '';
  const drift = L ? paperDriftHTML(s, P) : '';
  // 先看状态、收益曲线和持仓；成交偏差、账户里的其它持仓、订单和每日记录收进一个「详细记录」
  const nLog = P.log ? P.log.length : 0;
  const more = drift || orders || log ? `<details class="pp-details"><summary>${_t('ux015')}<span class="meta">${_t('ux016', { n: nLog })}</span></summary>${drift}${paperOthersHTML(s, P)}${orders}${log}</details>` : '';
  return `<div class="page">${head}${err}${running}${kpis}${paperGlanceHTML(s, P)}${chart}${holdings}${more}</div>`;
}

// Alpaca：账户里不是这个模拟买的持仓（最近一次运行看到的；还没运行过就用开始时的列表）
function paperOthersHTML(s, P) {
  if (s.mode !== 'alpaca') return '';
  const fg = paperForeign(s, P);
  if (!fg) return '';
  const { list, snap } = fg;
  const meta = snap ? `${_t('k1190', { v: esc(snap.dataDate) })}` : _t('k1191');
  return `<div class="panel section"><div class="panel-head"><h2>${_t('k1194')}</h2><span class="meta">${meta}</span></div>
    ${list.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>${_t('k0114')}</th><th>${_t('k0627')}</th><th>${_t('k1192')}</th></tr></thead><tbody>
      ${list.map((p) => `<tr><td class="mono">${esc(p.symbol)}</td><td class="mono">${num(p.qty, 0)}</td><td class="mono">${money0(p.marketValue)}</td></tr>`).join('')}
    </tbody></table></div>` : _t('k1193')}</div>`;
}

async function openPaperModal() {
  const d = $('#paperModal');
  const b = S.backtest;
  if (!d || !b) return;
  // 统计检验没过：先说清楚（首页说的流程是检验通过后才模拟实盘），用户坚持再开
  const v = S.validation;
  if (v && v.ok && !v.pass && !(await askConfirm({ title: _t('ux064'), message: _t('ux065', { okN: (v.gates || []).filter((g) => g.ok).length, n: (v.gates || []).length }), ok: _t('ux066') }))) return;
  $('#ppSource').textContent = b.name || b.backtestId;
  $('#ppName').value = '';
  $('#ppSim').checked = true;
  d.showModal();
  await refreshAlpaca();
}
async function refreshAlpaca() {
  $('#ppAlpacaState').textContent = _t('k1195');
  S.alpaca = await post('/api/alpaca/status').catch((e) => ({ connected: false, error: e.message }));
  renderPaperModal();
}
// Alpaca 只能从通过统计检验的主版本开始（和 lib/paper.mjs 的 alpacaGateReason 一致；服务器也会再查一次）
function alpacaGate(b) {
  if (!b) return null;
  if (b.role === 'main' && !(b.mainRejected && b.mainRejected.length)) return null;
  return b.mainRejected && b.mainRejected.length
    ? `${_t('k1196')}${b.mainRejected.join(_t('k0007'))}${_t('k1197')}`
    : `${_t('k1198')}${(ROLE_META[b.role] && ROLE_META[b.role][0]) || b.role || _t('k0185')}${_t('k1199')}`;
}
function renderPaperModal() {
  const a = S.alpaca || { connected: false };
  const alp = $('#ppAlpaca');
  const gate = alpacaGate(S.backtest);
  alp.disabled = !a.connected || Boolean(gate);
  if (alp.disabled && alp.checked) $('#ppSim').checked = true;
  const mode = alp.checked ? 'alpaca' : 'sim';
  $('#ppGate').hidden = !gate;
  $('#ppGate').textContent = gate || '';
  $('#ppCapWrap').hidden = mode !== 'sim';
  $('#ppAlpacaWarn').hidden = mode !== 'alpaca';
  $('#ppAlpacaState').innerHTML = a.connected
    ? `${_t('k1201')}${esc(a.keyIdMasked || '')}${_t('k1202')} ${money0(a.account && a.account.equity)}${a.account && a.account.tradingBlocked ? _t('k1200') : ''} · <button type="button" class="linkish" id="ppDisconnect">${_t('k1203')}</button>`
    : `${a.error ? `${_t('k1204', { v: esc(a.error) })} ` : _t('k1205')}<button type="button" class="linkish" id="ppShowConnect">${_t('ux058')}</button> · <a href="${ALPACA_KEYS_URL}" target="_blank" rel="noopener noreferrer">${_t('ux059')}</a>`;
  const sc = $('#ppShowConnect'); if (sc) sc.onclick = () => openSettings('alpaca');
  const dc = $('#ppDisconnect'); if (dc) dc.onclick = async () => {
    if (!(await askConfirm({ title: _t('k1207'), message: _t('k1208'), ok: _t('k1203'), danger: true }))) return;
    const r = await safePost('/api/actions/alpaca-disconnect');
    if (!r.success) toast(`${_t('k1209')}${(r.errors || []).join('; ')}`);
    refreshAlpaca();
  };
}
async function submitPaper() {
  const mode = $('#ppAlpaca').checked ? 'alpaca' : 'sim';
  if (mode === 'alpaca' && !(await askConfirm({ title: _t('k1213'), message: _t('k1214'), ok: _t('k1215') }))) return;
  const { projectId, backtestId } = S.route;
  const body = { projectId, backtestId, mode, name: $('#ppName').value.trim() || undefined, capital: mode === 'sim' ? Number($('#ppCapital').value) || 100000 : undefined };
  const r = await once('paper-start', $('#ppStart'), () => safePost('/api/actions/paper-start', body));
  if (!r) return;
  if (!r.success) { toast(`${_t('k1216')}${(r.errors || []).join('; ')}`); return; }
  $('#paperModal').close();
  if (r.otherPositions && r.otherPositions.length) toast(`${_t('k1076')}${r.otherPositions.map((p) => `${_t('k1217', { symbol: p.symbol, v: num(p.qty, 0) })}`).join(_t('k0015'))}`);
  location.hash = `#/p/${projectId}/s/${r.session.sessionId}`;
}

/* ================= 设置：AI 连接 / Alpaca 模拟账户 / 外观和语言（左下角「设置」，设置向导里也能打开） ================= */
const ALPACA_KEYS_URL = 'https://app.alpaca.markets/paper/dashboard/overview';
let settingsDlg = null;
const capWord = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
// 实际在用的 AI：自动模式下显示检测到的账号类型（Claude Max、API key…），而不是笼统的「自动」
function aiDetected() {
  const a = S.ai && S.ai.ai; const l = S.ai && S.ai.login;
  if (!a) return '';
  if (a.mode === 'custom') return a.model || a.baseUrl || aiModeName('custom');
  if (a.mode === 'apiKey') return aiModeName('apiKey');
  if (l && l.ok && l.subscription) return `Claude ${capWord(l.subscription)}`;
  if (l && l.ok && /api.?key/i.test(l.method || '')) return aiModeName('apiKey');
  if (l && l.ok && l.method) return _t('ux051');
  return aiModeName(a.mode);
}
function setAiHTML() {
  if (!S.ai || !S.ai.ai) return `<p class="modal-hint">${_t('ob012')}</p>`;
  const { ai: a, login: l } = S.ai;
  const ok = !l || l.ok;
  const when = S.aiCheckedAt ? ` · ${esc(new Date(S.aiCheckedAt).toLocaleTimeString(LOC(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }))}` : '';
  const used = `${esc(aiDetected())}${a.hasKey ? ` · <span class="mono">${esc(a.keyHint || '')}</span>` : ''}${a.baseUrl ? ` · <span class="mono">${esc(a.baseUrl)}</span>` : ''}`;
  return `<dl class="set-kv"><dt>${_t('ux052')}</dt><dd>${esc(aiModeName(a.mode))}</dd><dt>${_t('ux053')}</dt><dd>${used}</dd>
    <dt>${_t('ux054')}</dt><dd>${ok ? `<span class="up">${_t('k1569')}</span>` : `<span class="down">${esc(zhErr((l && l.error) || ''))}</span>`}${when}</dd></dl>
    <div class="set-btns"><button type="button" class="btn sm" data-set-ai-test>${_t('h108')}</button><button type="button" class="btn sm" data-set-ai-change>${_t('ob035')}</button></div>`;
}
function setAlpHTML() {
  const a = S.alpaca;
  if (!a) return `<p class="modal-hint">${_t('k1195')}</p>`;
  if (a.connected) return `<p class="set-line">${_t('k1201')}${esc(a.keyIdMasked || '')}${_t('k1202')} ${money0(a.account && a.account.equity)}${a.account && a.account.tradingBlocked ? _t('k1200') : ''}</p>
    <div class="set-btns"><button type="button" class="btn sm" data-set-alp-dc>${_t('k1203')}</button></div>`;
  return `${a.error ? `<p class="set-line">${_t('k1204', { v: esc(a.error) }).replace(/\s*·\s*$/, '')}</p>` : ''}
    <p class="modal-hint">${_t('ux055')}</p>
    <p class="modal-hint">${_t('h083')} <a href="${ALPACA_KEYS_URL}" target="_blank" rel="noopener noreferrer">app.alpaca.markets</a> ${_t('h084')} <b>Paper</b> ${_t('h085')}</p>
    <label class="field"><span>API Key ID</span><input id="setAlpKey" autocomplete="off" spellcheck="false" placeholder="PK…"></label>
    <label class="field"><span>Secret Key</span><input id="setAlpSecret" type="password" autocomplete="new-password" spellcheck="false"></label>
    <div class="set-btns"><button type="button" class="btn sm primary" data-set-alp-connect>${_t('h086')}</button></div>`;
}
// 更新（lib/updater.mjs）：自动更新开关、当前版本、GitHub 上的新版本、为什么暂时不能更新
const UPD_INSTALL = 'curl -fsSL https://raw.githubusercontent.com/zhuhroscar-tech/helm/main/install.sh | bash';
function updBlockerText(b, st) {
  if (b === 'branch') return _t('upd_b_branch', { b: esc(st.branch || '?') });
  if (b === 'dirty') return _t('upd_b_dirty', { n: st.dirty });
  if (b === 'ahead') return _t('upd_b_ahead');
  if (b === 'diverged') return _t('upd_b_diverged');
  if (b === 'busy') return _t('upd_b_busy');
  if (b === 'no-remote') return _t('upd_b_noremote');
  return _t('upd_b_notgit');
}
function setUpdHTML() {
  const U = S.upd;
  if (!U) return `<p class="modal-hint">${_t('upd15')}</p>`;
  if (U.error && !U.state) return `<p class="modal-hint">${esc(U.error)}</p>`;
  const st = U.state || {}; const set = U.settings || {}; const av = set.available;
  const ver = st.git ? `<span class="mono">${esc(st.short || '')}</span> · ${esc(String(st.date || '').slice(0, 10))}` : '—';
  const news = av && av.behind ? _t('upd06', { n: av.behind }) : set.lastCheck ? _t('upd05') : '';
  const when = set.lastCheck ? ` · ${_t('upd09')} ${esc(new Date(set.lastCheck).toLocaleString(LOC(), { hour12: false }))}` : '';
  const list = av && av.commits && av.commits.length ? `<ul class="upd-list">${av.commits.slice(0, 5).map((c) => `<li><span class="mono">${esc(c.sha)}</span> ${esc(c.subject)}</li>`).join('')}</ul>` : '';
  const bl = (U.blockers || []).length ? `<p class="set-line down">${_t('upd10')} ${U.blockers.map((b) => updBlockerText(b, st)).join('; ')}</p>` : '';
  const setup = av && (av.needsSetup || av.needsApp) ? `<p class="modal-hint">${_t('upd14')} <code>${esc(UPD_INSTALL)}</code></p>` : '';
  const err = set.lastError ? `<p class="set-line down">${esc(set.lastError)}</p>` : '';
  return `<label class="upd-toggle"><input type="checkbox" id="setUpdAuto" data-upd-toggle ${set.autoUpdate ? 'checked' : ''}> <span>${_t('upd02')}</span></label>
    <p class="modal-hint">${_t('upd03')}</p>
    <dl class="set-kv"><dt>${_t('upd04')}</dt><dd>${ver}</dd><dt>GitHub</dt><dd>${news ? esc(news) : '—'}${when}</dd></dl>${list}${bl}${setup}${err}
    <div class="set-btns"><button type="button" class="btn sm" data-upd-check>${_t('upd07')}</button>${av && av.behind ? `<button type="button" class="btn sm primary" data-upd-apply ${(U.blockers || []).length ? 'disabled' : ''}>${_t('upd08')}</button>` : ''}</div>`;
}
async function loadUpdate() {
  try { S.upd = await api('/api/update/status'); } catch (e) { S.upd = { error: e.message }; }
  renderSettings('upd');
}

function settingsBodyHTML() {
  return `<h2 id="setH">${_t('ux049')}</h2>
    <section class="set-sec" id="setAi" aria-labelledby="setAiH"><h3 id="setAiH">${_t('h092')}</h3><div class="set-in">${setAiHTML()}</div></section>
    <section class="set-sec" id="setAlp" aria-labelledby="setAlpH"><h3 id="setAlpH">${_t('h081')}</h3><div class="set-in">${setAlpHTML()}</div></section>
    <section class="set-sec" id="setUpd" aria-labelledby="setUpdH"><h3 id="setUpdH">${_t('upd01')}</h3><div class="set-in">${setUpdHTML()}</div></section>
    <section class="set-sec" id="setLook" aria-labelledby="setLookH"><h3 id="setLookH">${_t('ux056')}</h3><div class="set-in side-foot">${lookRowsHTML()}</div></section>
    <div class="modal-actions"><button type="button" class="btn" data-onb-open>${_t('ob080')}</button><button type="button" class="btn primary" data-set-close>${_t('ux057')}</button></div>`;
}
// part：'ai' | 'alp' 只重画那一块（Alpaca 表单里正在输入的内容不被冲掉）；不传 = 整个重画（换了语言）
function renderSettings(part) {
  if (!settingsDlg) return;
  const d = settingsDlg.d;
  if (part === 'ai') { const el = d.querySelector('#setAi .set-in'); if (el) el.innerHTML = setAiHTML(); return; }
  if (part === 'alp') { const el = d.querySelector('#setAlp .set-in'); if (el) el.innerHTML = setAlpHTML(); return; }
  if (part === 'upd') { const el = d.querySelector('#setUpd .set-in'); if (el) el.innerHTML = setUpdHTML(); return; }
  const body = d.querySelector('.set-body'); if (body) body.innerHTML = settingsBodyHTML();
}
async function loadAlpacaStatus() {
  S.alpaca = await post('/api/alpaca/status').catch((e) => ({ connected: false, error: e.message }));
  renderSettings('alp');
  if ($('#paperModal').open) renderPaperModal();
}
async function onSettingsClick(e, close) {
  if (e.target.closest('[data-set-close]') || e.target.closest('[data-onb-open]')) { close(); return; }
  const ut = e.target.closest('[data-upd-toggle]');
  if (ut) {
    const r = await safePost('/api/update/settings', { autoUpdate: ut.checked });
    if (!r.success) { ut.checked = !ut.checked; toast((r.errors || [r.error]).join('; ')); }
    loadUpdate();
    return;
  }
  const uc = e.target.closest('[data-upd-check]');
  if (uc) {
    uc.disabled = true; uc.textContent = _t('upd15');
    const r = await safePost('/api/update/check', {});
    if (!r.success) toast(_t('upd11', { e: r.detail || r.error || (r.errors || []).join('; ') }));
    await loadUpdate();
    return;
  }
  const ua = e.target.closest('[data-upd-apply]');
  if (ua) {
    ua.disabled = true;
    const r = await safePost('/api/update/apply', {});
    if (!r.success) toast(r.error === 'rolled-back' ? _t('upd16') : (r.blockers || []).map((b) => updBlockerText(b, (S.upd && S.upd.state) || {})).join('; ') || String(r.error || ''));
    await loadUpdate();
    return;
  }
  if (e.target.closest('[data-set-ai-change]')) { openAiModal(); return; }
  const t = e.target.closest('[data-set-ai-test]');
  if (t) { t.disabled = true; await testAiUI(); S.aiCheckedAt = Date.now(); renderSettings('ai'); return; }
  const c = e.target.closest('[data-set-alp-connect]');
  if (c) {
    const keyId = $('#setAlpKey').value.trim(); const secret = $('#setAlpSecret').value.trim();
    if (!keyId || !secret) { toast(_t('k1210')); return; }
    c.disabled = true;
    const r = await safePost('/api/actions/alpaca-connect', { keyId, secret });
    c.disabled = false;
    if (!r.success) { $('#setAlpSecret').value = ''; toast(`${_t('k1211')}${(r.errors || []).join('; ')}`); return; }
    S.alpaca = r.status;
    renderSettings('alp');
    if ($('#paperModal').open) renderPaperModal();
    toast(_t('k1212'));
    return;
  }
  if (e.target.closest('[data-set-alp-dc]')) {
    if (!(await askConfirm({ title: _t('k1207'), message: _t('k1208'), ok: _t('k1203'), danger: true }))) return;
    const r = await safePost('/api/actions/alpaca-disconnect');
    if (!r.success) toast(`${_t('k1209')}${(r.errors || []).join('; ')}`);
    loadAlpacaStatus();
  }
}
// section：'alpaca' 时打开后滚到 Alpaca 那一块
function openSettings(section) {
  if (!settingsDlg) {
    settingsDlg = openModal({ cls: 'settings-dlg', labelId: 'setH', html: `<div class="cd-body set-body">${settingsBodyHTML()}</div>`, onClick: onSettingsClick, onClose: () => { settingsDlg = null; } });
    loadAi(true).then(() => { S.aiCheckedAt = Date.now(); renderSettings('ai'); });
    loadAlpacaStatus();
    loadUpdate();
  }
  const sec = section === 'alpaca' ? settingsDlg.d.querySelector('#setAlp') : null;
  if (sec) { sec.scrollIntoView({ block: 'start' }); setTimeout(() => { const k = settingsDlg && settingsDlg.d.querySelector('#setAlpKey'); if (k) k.focus(); }, 300); }
  else settingsDlg.d.querySelector('[data-set-close]').focus();
}

function renderMain() {
  const v = S.route.view;
  const main = $('#main');
  const top = main.scrollTop;
  let html = v === 'project' ? projectHTML() : v === 'backtest' ? backtestHTML() : v === 'research' ? researchHTML() : v === 'paper' ? paperHTML() : S.route.page === 'pipeline' ? pipelineHTML() : S.route.page === 'agents' ? agentsHTML() : S.route.journal ? journalHTML() : S.route.data ? dataHTML() : homeHTML();
  // 详情页顶部：一个返回按钮回到上一级（像 iOS / macOS 的导航栏），不再叠一条流程条
  if (v === 'backtest' || v === 'research' || v === 'paper') {
    const parent = v === 'research' ? 'research' : v === 'backtest' ? 'backtests' : 'paper';
    const label = _t('ux035');
    const back = `<a class="back-bar" href="#/p/${S.route.projectId}/${parent}"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>${label}</a>`;
    html = html.replace('<div class="page">', `<div class="page">${back}`);
  }
  // 后台刷新会重画整页：保住正在输入的想法、焦点和展开的折叠块
  const idea = $('#ideaInput');
  const keep = idea ? { value: idea.value, focus: document.activeElement === idea, a: idea.selectionStart, b: idea.selectionEnd } : null;
  const ae = document.activeElement;
  const focusSel = !keep?.focus && ae && main.contains(ae) ? (ae.id ? `#${CSS.escape(ae.id)}` : ae.matches('tr[data-href]') ? `tr[data-href="${CSS.escape(ae.dataset.href)}"]` : ae.matches('a[href]') ? `a[href="${CSS.escape(ae.getAttribute('href'))}"]` : ae.dataset.action ? `[data-action="${CSS.escape(ae.dataset.action)}"]` : null) : null;
  const openDetails = [...main.querySelectorAll('details[open]')].map((d) => d.className).filter(Boolean);
  main.innerHTML = html;
  main.scrollTop = top;
  applyScrollWant();
  if (S.secJump && v === 'project') { const el = document.getElementById(`sec-${S.secJump}`); if (el) { S.secJump = null; if (el.tagName === 'DETAILS') el.open = true; el.scrollIntoView({ block: 'start' }); } else if (Array.isArray(S.papers) && Array.isArray(S.research)) S.secJump = null; }
  // 可点击的表格行也能用键盘到达
  main.querySelectorAll('tr[data-href]').forEach((tr) => { tr.tabIndex = 0; tr.setAttribute('role', 'link'); });
  for (const cls of openDetails) { const d = main.querySelector(`details[class="${CSS.escape(cls)}"]`); if (d) d.open = true; }
  const idea2 = $('#ideaInput');
  if (idea2 && !keep) idea2.value = store.get('ideaDraft', '') || ''; // 刷新或离开再回来：恢复没交出去的想法
  if (keep && idea2) {
    idea2.value = keep.value;
    if (keep.focus) { idea2.focus({ preventScroll: true }); try { idea2.setSelectionRange(keep.a, keep.b); } catch { /* 忽略 */ } }
  } else if (focusSel) { try { const f = main.querySelector(focusSel); if (f) f.focus({ preventScroll: true }); } catch { /* 忽略 */ } }
  main.setAttribute('aria-busy', String(/class="skeleton"/.test(html)));
  if (v === 'backtest' && S.charts && $('#eqChart')) drawCharts();
  if (v === 'paper' && $('#pxChart')) drawPaperChart();
  if (v === 'project' && S.route.tab === 'compare' && $('#cmpChart')) drawCompare();
  menuSync();
}

/* ================= charts (纯 SVG) ================= */
function drawCharts() {
  const eqEl = $('#eqChart');
  const ddEl = $('#ddChart');
  if (!eqEl || !S.charts) return;
  const eq = S.charts.equity;
  let bm = S.charts.benchmark.filter((p) => p[1] > 0);
  if (eq.length && bm.length) {
    const t0 = eq[0][0];
    const startIdx = Math.max(0, bm.findIndex((p) => p[0] >= t0));
    const scale = eq[0][1] / bm[startIdx][1];
    bm = bm.slice(startIdx).map(([t, v]) => [t, v * scale]);
  }
  const money = (v) => (Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : Math.abs(v) >= 1e4 ? `$${(v / 1e3).toFixed(0)}k` : `$${v.toFixed(0)}`);
  lineChart(eqEl, [
    { label: _t('k0879'), color: getCss('--text'), pts: eq },
    ...(bm.length ? [{ label: _t('k0163'), color: getCss('--muted'), pts: bm, dash: true }] : []),
  ], { height: 260, fmt: money, tipFmt: (v) => `$${v.toLocaleString(LOC(), { maximumFractionDigits: 0 })}`, empty: _t('k0468'), aria: _t('k1219') });
  let peak = -Infinity;
  const dd = eq.map(([t, v]) => { peak = Math.max(peak, v); return [t, peak > 0 ? v / peak - 1 : 0]; });
  if (ddEl) lineChart(ddEl, [{ label: _t('k1014'), color: getCss('--down'), pts: dd, area: true, areaTop: true }], { height: 120, zeroTop: true, fmt: (v) => `${(v * 100).toFixed(0)}%`, tipFmt: (v) => `${(v * 100).toFixed(2)}%`, empty: '—', aria: _t('k1220') });
}
function niceTicks(min, max, n = 4) {
  const span = max - min || Math.abs(max) || 1;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) || step0;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}
function nearestIdx(pts, t) {
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid][0] < t) lo = mid; else hi = mid; }
  return Math.abs(pts[lo][0] - t) <= Math.abs(pts[hi][0] - t) ? lo : hi;
}
const nearest = (pts, t) => pts[nearestIdx(pts, t)];
// LEAN 的时间戳是美东午夜：按美东日期显示，不然在美国西部时区会少一天
const NY_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const isoDay = (t) => NY_DAY.format(new Date(t * 1000));
// 折线图：纯 SVG。鼠标悬停或键盘（Tab 聚焦后 ←/→ 逐点、Shift+←/→ 跳 20 点、Home/End 两端、Esc 取消）都能看到十字线和数值；
// 图上方常驻一行读数（默认显示最新一点），所以不用鼠标也能读到数。策略/基准靠线型（实线粗 / 虚线细 + 空心点）区分，不只靠颜色。
function lineChart(el, series, o) {
  el._draw = () => {
    const all = series.flatMap((s) => s.pts);
    if (!all.length) { el.innerHTML = `<div class="chart-empty">${esc(o.empty || _t('k0619'))}</div>`; return; }
    const W = Math.max(el.clientWidth, 320);
    const H = o.height;
    const padL = 58; const padR = o.padR || 16; const padT = 12; const padB = 26;
    let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity;
    for (const [t, v] of all) { if (t < x0) x0 = t; if (t > x1) x1 = t; if (v < y0) y0 = v; if (v > y1) y1 = v; }
    const pad = (y1 - y0) * 0.08 || Math.abs(y1) * 0.05 || 1;
    if (o.zeroTop) { y1 = 0; y0 -= pad; } else { y0 -= pad; y1 += pad; }
    const X = (t) => padL + ((t - x0) / (x1 - x0 || 1)) * (W - padL - padR);
    const Y = (v) => padT + (1 - (v - y0) / (y1 - y0 || 1)) * (H - padT - padB);
    const yt = niceTicks(y0, y1, o.height > 200 ? 5 : 3);
    const spanDays = (x1 - x0) / 86400;
    const fmtX = (t) => { const [y, m, d] = isoDay(t).split('-'); return spanDays > 400 ? `${y}${spanDays < 1500 ? `-${m}` : ''}` : `${+m}/${+d}`; };
    const xt = Array.from({ length: 6 }, (_, i) => x0 + ((x1 - x0) * i) / 5);
    const gid = `g${el.id}`;
    const sw = (s) => s.width || (s.dash ? 1.4 : 2);
    const dashOf = (s) => (s.dashArray != null ? s.dashArray : s.dash ? '5 4' : '');
    const hollow = (s) => Boolean(s.dash || s.dashArray);
    const paths = series.map((s, i) => {
      if (!s.pts.length) return '';
      const d = `M${s.pts.map(([t, v]) => `${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join('L')}`;
      const base = s.areaTop ? Y(0) : H - padB;
      const area = s.area ? `<path d="${d}L${X(s.pts[s.pts.length - 1][0]).toFixed(1)},${base}L${X(s.pts[0][0]).toFixed(1)},${base}Z" fill="url(#${gid}${i})"/>` : '';
      // 图例放在左上角：线尾标签会压在曲线上，看不清
      const lx = padL + 10 + i * 64; const ly = padT + 8;
      const lab = series.length > 1 && s.label && !o.noLegend ? `<g class="legend"><line x1="${lx}" x2="${lx + 18}" y1="${ly}" y2="${ly}" stroke="${s.color}" stroke-width="${sw(s)}" ${dashOf(s) ? `stroke-dasharray="${dashOf(s)}"` : ''}/><text class="end-lab" x="${lx + 23}" y="${ly + 3.5}" fill="${getCss('--text-2')}">${esc(String(s.label).replace(parenRe(), ''))}</text></g>` : '';
      return `${area}<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${sw(s)}" ${dashOf(s) ? `stroke-dasharray="${dashOf(s)}"` : ''} ${s.dashArray ? 'stroke-linecap="round"' : ''} stroke-linejoin="round"/>${lab}`;
    }).join('');
    // 线尾直接标注（对比图用）：按纵向位置排开，互相不压
    const ends = series.filter((s) => s.endLabel && s.pts.length).map((s) => { const q = s.pts[s.pts.length - 1]; return { s, x: X(q[0]), y: Y(q[1]), ty: Y(q[1]) }; }).sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].ty - ends[i - 1].ty < 13) ends[i].ty = ends[i - 1].ty + 13;
    const over = ends.length ? ends[ends.length - 1].ty - (H - padB - 2) : 0;
    if (over > 0) ends.forEach((e) => { e.ty -= over; });
    const endSvg = ends.map((e) => `<g class="endl"><line x1="${e.x.toFixed(1)}" y1="${e.y.toFixed(1)}" x2="${(e.x + 6).toFixed(1)}" y2="${e.ty.toFixed(1)}" stroke="${e.s.color}" stroke-width="1"/><text class="end-lab" x="${(e.x + 9).toFixed(1)}" y="${(e.ty + 3.5).toFixed(1)}" fill="${e.s.color}">${esc(e.s.endLabel)}</text></g>`).join('');
    const defs = series.map((s, i) => (s.area ? `<linearGradient id="${gid}${i}" x1="0" y1="${s.areaTop ? 1 : 0}" x2="0" y2="${s.areaTop ? 0 : 1}"><stop offset="0" stop-color="${s.color}" stop-opacity=".28"/><stop offset="1" stop-color="${s.color}" stop-opacity="0"/></linearGradient>` : '')).join('');
    const hadFocus = el.contains(document.activeElement) && document.activeElement.tagName === 'svg';
    const caption = o.caption ? `<text class="cap-lab" x="${padL + 10}" y="${padT + 12}">${esc(o.caption)}</text>` : '';
    el.innerHTML = `<div class="chart-read" aria-live="off"></div><svg viewBox="0 0 ${W} ${H}" height="${H}" tabindex="0" role="application" aria-roledescription="${_t('k1221')}" aria-label="${esc(o.aria || series.map((s) => s.label).join(_t('k0015')))}${_t('k1222')}">
      <defs>${defs}</defs>
      <g class="grid">${yt.map((v) => `<line x1="${padL}" x2="${W - padR}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/>`).join('')}</g>
      <g class="axis">${yt.map((v) => `<text x="${padL - 10}" y="${(Y(v) + 3.5).toFixed(1)}" text-anchor="end">${esc(o.fmt(v))}</text>`).join('')}
        ${xt.map((t, i) => `<text x="${X(t).toFixed(1)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === 5 ? 'end' : 'middle'}">${fmtX(t)}</text>`).join('')}</g>
      ${paths}${endSvg}${caption}
      <g class="hov" style="display:none"><line y1="${padT}" y2="${H - padB}" stroke="${getCss('--text-2')}" stroke-width="1" stroke-dasharray="2 3"/>${series.map((s) => (hollow(s)
        ? `<circle r="4" fill="${getCss('--panel')}" stroke="${s.color}" stroke-width="1.6"/>`
        : `<circle r="3.5" fill="${s.color}" stroke="${getCss('--panel')}" stroke-width="2"/>`)).join('')}</g>
      <rect x="${padL}" y="${padT}" width="${W - padL - padR}" height="${H - padT - padB}" fill="transparent"/>
    </svg><div class="chart-tip" hidden></div>`;
    const svg = el.querySelector('svg');
    const hov = svg.querySelector('.hov');
    const tip = el.querySelector('.chart-tip');
    const read = el.querySelector('.chart-read');
    if (hadFocus) svg.focus({ preventScroll: true });
    const fmtV = o.tipFmt || o.fmt;
    const glyph = (s) => (s.dashArray != null ? `<svg class="swg" width="22" height="8" viewBox="0 0 22 8" aria-hidden="true"><line x1="1" x2="21" y1="4" y2="4" stroke="${s.color}" stroke-width="${s.width || 2}" ${s.dashArray ? `stroke-dasharray="${s.dashArray}" stroke-linecap="round"` : ''}/></svg>` : `<i class="sw ${s.dash ? 'dash' : 'solid'}" style="--c:${s.color}" aria-hidden="true"></i>`);
    const ref = series.find((s) => s.pts.length).pts;
    const rows = (t) => series.map((s) => (s.pts.length ? { s, p: nearest(s.pts, t) } : null)).filter(Boolean);
    const readout = (t, label) => {
      read.innerHTML = `<span class="cr-d">${label}${isoDay(t)}</span>${rows(t).map(({ s, p }) => `<span class="cr-s">${series.length > 1 ? glyph(s) : ''}${esc(String(s.short || s.label).replace(parenRe(), ''))} <b>${esc(fmtV(p[1]))}</b></span>`).join('')}`;
    };
    const rest = () => { hov.style.display = 'none'; tip.hidden = true; readout(ref[ref.length - 1][0], _t('k1223')); };
    let idx = -1;
    const show = (t) => {
      const hits = series.map((s) => (s.pts.length ? nearest(s.pts, t) : null));
      const r0 = hits.find(Boolean);
      const px = X(r0[0]);
      hov.style.display = '';
      hov.querySelector('line').setAttribute('x1', px);
      hov.querySelector('line').setAttribute('x2', px);
      hov.querySelectorAll('circle').forEach((c, i) => { const h = hits[i]; if (h) { c.setAttribute('cx', X(h[0])); c.setAttribute('cy', Y(h[1])); } });
      tip.hidden = false;
      tip.innerHTML = `<div class="t">${isoDay(r0[0])}</div>${series.map((s, i) => (hits[i] ? `<div class="row"><span>${glyph(s)}${esc(s.tipLabel || s.label)}</span><span>${esc(fmtV(hits[i][1]))}</span></div>` : '')).join('')}`;
      const rect = svg.getBoundingClientRect();
      tip.style.left = `${Math.min(Math.max((px / W) * rect.width, 70), rect.width - 70)}px`;
      tip.style.top = `${(Y(hits[0] ? hits[0][1] : r0[1]) / H) * svg.getBoundingClientRect().height + (svg.getBoundingClientRect().top - el.getBoundingClientRect().top)}px`;
      readout(r0[0], '');
      return r0[0];
    };
    let moveRaf = 0; let moveX = 0;
    svg.addEventListener('mousemove', (e) => {
      moveX = e.clientX;
      if (moveRaf) return; // 每帧最多算一次十字线
      moveRaf = requestAnimationFrame(() => {
        moveRaf = 0;
        const rect = svg.getBoundingClientRect();
        const x = ((moveX - rect.left) / rect.width) * W;
        const t = x0 + ((x - padL) / (W - padL - padR)) * (x1 - x0);
        idx = nearestIdx(ref, t);
        read.setAttribute('aria-live', 'off');
        show(ref[idx][0]);
      });
    });
    svg.addEventListener('mouseleave', () => { cancelAnimationFrame(moveRaf); moveRaf = 0; if (document.activeElement !== svg) rest(); });
    svg.addEventListener('focus', () => { if (idx < 0) idx = ref.length - 1; show(ref[idx][0]); });
    svg.addEventListener('blur', () => { idx = -1; rest(); });
    svg.addEventListener('keydown', (e) => {
      const big = e.shiftKey ? 20 : 1;
      let n = idx < 0 ? ref.length - 1 : idx;
      if (e.key === 'ArrowLeft') n -= big;
      else if (e.key === 'ArrowRight') n += big;
      else if (e.key === 'PageUp') n -= 20;
      else if (e.key === 'PageDown') n += 20;
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = ref.length - 1;
      else if (e.key === 'Escape') { if (idx >= 0) { e.stopPropagation(); idx = -1; rest(); } return; } else return;
      e.preventDefault();
      idx = Math.max(0, Math.min(ref.length - 1, n));
      read.setAttribute('aria-live', 'polite'); // 键盘移动时读出当前点
      show(ref[idx][0]);
    });
    rest();
  };
  el._draw();
  if (!el._ro) {
    el._ro = new ResizeObserver(() => { cancelAnimationFrame(el._raf); el._raf = requestAnimationFrame(() => { if (el.isConnected && el._draw) el._draw(); }); });
    el._ro.observe(el);
  }
}

/* ================= 研究流水线 + Agents ================= */
// 流水线：每个项目一张卡片，按走到的阶段放进列里；卡片上是 agent 接力链（谁交给谁、此刻谁在做）。
// Agents：团队名单、所有任务、每个 agent 的定位 / 系统提示词 / 实际能用的工具（提示词可以在这里改）。
let PIPE_STATUS; _regT(() => { PIPE_STATUS = { active: [_t('k1224'), 'st-active'], stopped: [_t('k0659'), 'st-stopped'], blocked: [_t('k1225'), 'st-blocked'], live: [_t('k1226'), 'st-live'], idle: [_t('k1227'), 'st-idle'] }; });;
let TASK_STATUS; _regT(() => { TASK_STATUS = { running: [_t('k1224'), 'st-active'], done: [_t('k0131'), 'st-done'], error: [_t('k0658'), 'st-error'], stopped: [_t('k1228'), 'st-stopped'] }; });
const GATE_CLS = { pass: 'g-pass', weak: 'g-weak', fail: 'g-fail', pending: 'g-pend' };
const agentGlyph = (id, extra = '') => { const a = agentOf(id); return `<span class="ag-g ${extra}" title="${esc(a.name)}">${esc(a.glyph)}</span>`; };
const pill = ([t, c]) => `<span class="st-pill ${c}">${esc(t)}</span>`;

async function loadPipeline() {
  if (!S.pipe) S.pipe = { data: null, error: null, tl: null };
  try { const r = await api('/api/pipeline'); S.pipe.data = r; S.pipe.error = null; } catch (e) { S.pipe.error = e.message; }
  const sel = S.route.pipeProject;
  if (sel) {
    try { const r = await api(`/api/pipeline/${sel}`); S.pipe.tl = { projectId: sel, items: r.timeline }; } catch (e) { S.pipe.tl = { projectId: sel, error: e.message }; }
  }
  if (S.route.page === 'pipeline') {
    renderMain();
    if (S.pipeScroll && S.pipe.tl) {
      S.pipeScroll = false;
      const el = $('.pipe-detail'); const main = $('#main');
      if (el && main) main.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - 16), behavior: 'smooth' });
    }
  }
}
let pipeTimer = 0;
const refreshPipelineSoon = () => { clearTimeout(pipeTimer); pipeTimer = setTimeout(() => { if (S.route.page === 'pipeline') loadPipeline(); }, 500); };

function relayHTML(relay, working) {
  if (!relay.length) return _t('k1229');
  const live = new Set((working || []).map((w) => w.threadId));
  const chips = relay.map((r, i) => {
    const st = live.has(r.id) ? 'running' : r.status;
    const arrow = i ? `<i class="rl-arrow ${r.from ? 'handed' : ''}" aria-hidden="true">${r.from ? '→' : '·'}</i>` : '';
    return `${arrow}<button type="button" class="rl-chip rl-${esc(st)}" data-open-thread="${esc(r.id)}" title="${_t('k0790', { v: esc(agentOf(r.agent).name), v2: esc(r.title) })}${r.from ? `${_t('k1230', { v: esc(agentOf(r.from.agent).name) })}` : ''}">${esc(agentOf(r.agent).glyph)}</button>`;
  }).join('');
  return `<div class="relay" aria-label="${_t('k1231')}">${chips}</div>`;
}

function pipeCardHTML(c) {
  const sel = S.route.pipeProject === c.projectId;
  const segs = c.stages.map((s, i) => `<span class="seg ${i <= c.stageIdx && s.gate ? GATE_CLS[s.gate.state] || '' : ''} ${i === c.stageIdx ? 'cur' : ''}" title="${esc(s.zh)}${s.gate ? `${_t('k1232', { v: esc(s.gate.label) })}` : _t('k1233')}"></span>`).join('');
  const w = c.working[0];
  const doing = c.drafting
    ? `<div class="pc-doing">${agentGlyph(c.drafting.from, 'live')}${_t('k1234', { v: esc(agentOf(c.drafting.from).name) })}${c.drafting.agent ? ` → ${esc(agentOf(c.drafting.agent).name)}` : ''}</span></div>`
    : w ? `<div class="pc-doing">${agentGlyph(w.agent, 'live')}<span>${_t('k1235', { v: esc(agentOf(w.agent).name), v2: esc(w.title) })}</span></div>` : '';
  const last = c.last ? `<div class="pc-last"><span class="pc-stage">${esc(c.last.stage)}</span>${esc(c.last.outcome)}${c.key ? ` · ${esc(c.key.label)} <b class="mono">${num(c.key.value)}</b>` : ''}</div>` : _t('k1236');
  return `<article class="pipe-card ${sel ? 'sel' : ''} ${c.status === 'active' ? 'is-active' : ''}">
    <a class="pc-link" href="#/pipeline${sel ? '' : `/${c.projectId}`}" aria-label="${sel ? _t('k1237') : _t('k0129')} ${_t('k1238', { v: esc(pNameById(c.projectId, c.name)) })}"></a>
    <div class="pc-name" title="${esc(pNameById(c.projectId, c.name))}">${esc(pNameById(c.projectId, c.name))}</div>
    <div class="pc-segs" aria-hidden="true">${segs}</div>
    <div class="pc-meta">${pill(PIPE_STATUS[c.status] || PIPE_STATUS.idle)}<span class="pc-when">${c.updatedAt ? agoT(c.updatedAt) : ''}</span></div>
    ${last}
    ${doing}
    ${c.note && c.status !== 'active' ? `<div class="pc-note">${esc(c.note)}</div>` : ''}
    ${relayHTML(c.relay, c.working)}
  </article>`;
}

function liveStripHTML(d) {
  const run = (d.running || []);
  const drafts = (d.cards || []).filter((c) => c.drafting).map((c) => c.drafting);
  if (!run.length && !drafts.length) return _t('k1239');
  const items = run.map((r) => {
    const a = agentOf(r.agent);
    const proj = (d.cards || []).find((c) => c.working.some((w) => w.threadId === r.threadId));
    return `<button type="button" class="ls-item" data-open-thread="${esc(r.threadId)}">${agentGlyph(r.agent, 'live')}<span class="ls-t"><b>${esc(a.name)}</b>${r.from ? `<em>${_t('k1240', { v: esc(agentOf(r.from.agent).name) })}</em>` : ''}<span>${esc(r.title)}</span>${proj ? `<em>· ${esc(proj.name)}</em>` : ''}</span><span class="ls-time">${r.startedAt ? esc(ago(r.startedAt).replace(_t('k1241'), '')) : ''}</span></button>`;
  });
  for (const x of drafts) items.push(`<div class="ls-item drafting">${agentGlyph(x.from, 'live')}${_t('k1242', { v: esc(agentOf(x.from).name) })} ${esc(x.agent ? agentOf(x.agent).name : '…')}</span></span></div>`);
  return `<div class="live-strip"><div class="ls-h">${_t('k1243', { n: run.length })}</div>${items.join('')}</div>`;
}

function timelineHTML(card) {
  const T = S.pipe.tl;
  if (!T || T.projectId !== card.projectId) return '<div class="skeleton" style="height:120px"></div>';
  if (T.error) return errorBox(_t('k1244'), T.error);
  if (!T.items.length) return _t('k1245');
  return `<ol class="tl">${T.items.map((e) => {
    if (e.kind === 'stage') {
      const cls = e.outcomeCode === 'none' || /没过|没跑完|did not pass|didn't pass|not finished|didn't finish/i.test(`${e.outcome}${e.detail}`) ? 'g-fail' : e.outcomeCode === 'weak' ? 'g-weak' : e.outcomeCode === 'signal' || e.outcomeCode === 'main' ? 'g-pass' : '';
      return `<li class="tl-stage"><span class="tl-dot ${cls}"></span><div class="tl-body"><div class="tl-h"><span class="pc-stage">${esc(e.stage)}</span><b>${esc(e.outcome)}</b>${e.key ? `<span class="mono">${esc(e.key.label)} ${num(e.key.value)}</span>` : ''}<span class="tl-when">${e.at ? agoT(e.at) : ''}</span></div>
        <div class="tl-what">${e.link ? `<a href="${esc(e.link)}">${esc(e.what)}</a>` : esc(e.what)}${e.detail ? `<span class="muted"> · ${esc(e.detail)}</span>` : ''}</div></div></li>`;
    }
    const a = agentOf(e.agent);
    const st = TASK_STATUS[e.status] || TASK_STATUS.done;
    const hs = (e.handoffs || []).map((h) => `<li>${agentGlyph(e.agent)}<i>→</i>${agentGlyph(h.to)}<span class="th-text" title="${esc(h.task)}">${esc(h.task.slice(0, 140))}${h.task.length > 140 ? '…' : ''}</span>${h.threadId ? `<button type="button" class="linkish" data-open-thread="${esc(h.threadId)}">${_t('k1246', { v: esc(agentOf(h.to).name) })}</button>` : ''}</li>`).join('');
    return `<li class="tl-task">${agentGlyph(e.agent, e.status === 'running' ? 'live' : '')}<div class="tl-body"><div class="tl-h"><b>${esc(a.name)}</b>${e.from ? `<span class="muted">${_t('k1247', { v: esc(agentOf(e.from.agent).name) })}</span>` : _t('k1248')}${pill(st)}<span class="tl-when">${e.at ? agoT(e.at) : ''}</span></div>
      <div class="tl-what">${esc(e.brief || e.title)}</div>
      ${e.outcome && e.status !== 'running' ? `<div class="tl-out">${esc(e.outcome)}</div>` : ''}
      ${hs ? `<ul class="tl-hand">${hs}</ul>` : ''}
      <div class="tl-act"><button type="button" class="btn sm" data-open-thread="${esc(e.id)}">${_t('k1249')}</button>${e.duration ? `<span class="muted mono">${(e.duration / 1000).toFixed(0)}s</span>` : ''}${e.cost ? `<span class="muted mono">≈$${e.cost.toFixed(3)}</span>` : ''}</div></div></li>`;
  }).join('')}</ol>`;
}

function pipeDetailHTML(d) {
  const c = d.cards.find((x) => x.projectId === S.route.pipeProject);
  if (!c) return '';
  const nextAsk = `${_t('k1250', { projectId: c.projectId, name: c.name })}`;
  const stages = c.stages.map((s, i) => `<li class="${i < c.stageIdx ? 'done' : i === c.stageIdx ? 'cur' : ''}"><span class="seg ${s.gate && i <= c.stageIdx ? GATE_CLS[s.gate.state] || '' : ''}"></span><b>${esc(s.zh)}</b><span>${s.gate && i <= c.stageIdx ? esc(s.gate.label) : _t('k1251')}</span>${agentGlyph(d.stages[i].owner)}</li>`).join('');
  return `<section class="pipe-detail" aria-label="${_t('k1238', { v: esc(pNameById(c.projectId, c.name)) })}">
    <div class="pd-head"><div><div class="eyebrow">${_t('k0167', { projectId: c.projectId })}</div><h2>${esc(pNameById(c.projectId, c.name))}</h2>${c.description ? `<p class="sub clamp">${esc(c.description)}</p>` : ''}</div>
      <div class="actions">${_t('k1253', { projectId: c.projectId })}${c.status !== 'active' && c.status !== 'stopped' ? `<button type="button" class="btn primary" data-ask="mia" data-text="${esc(nextAsk)}">${_t('k1252')}</button>` : ''}${_t('k1254')}</div></div>
    <ol class="pd-stages">${stages}</ol>
    <h3 class="pd-sub">${_t('k1255')}</h3>
    ${timelineHTML(c)}
  </section>`;
}

function pipelineHTML() {
  const P = S.pipe || {};
  const head = `<div class="page-head"><div><div class="eyebrow"><span>${_t('k1256')}</span></div><h1>${_t('k0125')}</h1>
    <p class="sub">${_t('k1257')}</p></div></div>`;
  if (P.error && !P.data) return `<div class="page wide">${head}${errorBox(_t('k1258'), P.error)}</div>`;
  if (!P.data) return `<div class="page wide">${head}<div class="skeleton" style="height:48px"></div><div class="skeleton" style="height:320px;margin-top:16px"></div></div>`;
  const d = P.data;
  const cols = d.stages.map((s, i) => {
    const cards = d.cards.filter((c) => c.stageIdx === i);
    const o = agentOf(s.owner);
    return `<section class="pipe-col" aria-label="${esc(s.zh)}"><header><div class="pcol-t"><b>${esc(s.zh)}</b><span class="count">${cards.length}</span></div>
      <div class="pcol-o">${agentGlyph(s.owner)}<span>${esc(o.name)} · ${esc(s.desc)}</span></div></header>
      <div class="pcol-body">${cards.map(pipeCardHTML).join('') || '<div class="pcol-empty">—</div>'}</div></section>`;
  }).join('');
  const un = d.unassigned.length ? `<details class="pipe-un"><summary>${_t('k1259', { n: d.unassigned.length })}</summary><ul>${d.unassigned.map((t) => `<li>${agentGlyph(t.agent)}<button type="button" class="linkish" data-open-thread="${esc(t.id)}">${esc(t.title)}</button>${pill(TASK_STATUS[t.status] || TASK_STATUS.done)}<span class="muted">${agoT(t.updatedAt)}</span></li>`).join('')}</ul></details>` : '';
  return `<div class="page wide">${head}${liveStripHTML(d)}<div class="pipe-board">${cols}</div>${pipeDetailHTML(d)}${un}</div>`;
}

/* ---------- Agents ---------- */
async function loadAgentsPage() {
  if (!S.ag) S.ag = { tasks: null, error: null, detail: null, q: '', agent: '', status: '', dirty: false };
  try { const r = await api('/api/tasks'); S.ag.tasks = r.tasks; S.ag.error = null; } catch (e) { S.ag.error = e.message; }
  const id = S.route.agentsView;
  if (id === 'changes') await loadChanges();
  if (id && !['list', 'tasks', 'changes'].includes(id) && !(S.ag.detail && S.ag.detail.agent.id === id && S.ag.dirty)) {
    try { S.ag.detail = await api(`/api/agents/${encodeURIComponent(id)}`); S.ag.dirty = false; } catch (e) { S.ag.detail = { error: e.message, agent: { id } }; }
  }
  if (S.route.page === 'agents') renderMain();
}
let agTimer = 0;
const refreshAgentsSoon = () => { clearTimeout(agTimer); agTimer = setTimeout(() => { if (S.route.page === 'agents' && !(S.ag && S.ag.dirty)) loadAgentsPage(); }, 600); };
async function reloadAgentList() {
  try { setAgents(await api('/api/agents')); } catch { /* 保持旧的 */ }
  renderAgents();
}
function newTaskFor(agentId) {
  closeSub();
  S.agentId = agentId; store.set('agent', agentId);
  S.thread = null; store.set('thread', null);
  renderAgents(); renderThread(); openChat();
  setTimeout(() => $('#input').focus(), 50);
}

function agentStats(id) {
  const T = (S.ag && S.ag.tasks) || [];
  const mine = T.filter((t) => t.agent === id);
  return {
    total: mine.length, running: [...S.running.values()].filter((r) => r.agent === id).length,
    received: mine.filter((t) => t.from).length, handed: mine.reduce((s, t) => s + (t.handoffs || []).length, 0),
    last: mine[0] ? mine[0].updatedAt : null, cost: mine.reduce((s, t) => s + (t.cost || 0), 0),
  };
}
function agentsTabs(active) {
  const T = (S.ag && S.ag.tasks) || [];
  const nPend = pendingApprovals().length;
  const tabs = [['list', 'Agents', S.agents.length], ['tasks', _t('k1260'), T.length], ['changes', nPend ? `${_t('k1261', { nPend })}` : _t('k1262'), S.chg && S.chg.list ? S.chg.list.length : null]];
  const d = S.route.agentsView;
  if (d && !['list', 'tasks', 'changes'].includes(d)) tabs.push([d, `Agent / ${agentOf(d).name}`, null]);
  return `<nav class="tabs" role="tablist">${tabs.map(([id, label, n]) => `<a role="tab" aria-selected="${id === active}" class="${id === active ? 'active' : ''}" href="#/agents${id === 'list' ? '' : `/${id}`}">${esc(label)}${n != null ? `<span class="count">${n}</span>` : ''}</a>`).join('')}</nav>`;
}
const modelName = (id) => { const m = (S.options.models || []).find((x) => x.id === id); return m ? m.label : id; };

function agentsListHTML() {
  const rows = S.agents.map((a) => {
    const st = agentStats(a.id);
    return `<tr data-href="#/agents/${esc(a.id)}"><td>${agentGlyph(a.id)} <b>${esc(a.name)}</b>${a.orchestrator ? _t('k1263') : ''}</td>
      <td class="ag-role" title="${esc(a.role)}">${esc(a.role)}</td>
      <td>${a.model ? esc(modelName(a.model)) : _t('k1264')}</td>
      <td class="r">${st.total}</td>
      <td>${st.running ? pill([_t('k0137'), 'st-active']) : _t('k1265')}</td>
      <td class="when">${st.last ? agoT(st.last) : '—'}</td>
      <td class="r ag-act">${_t('k1266', { v: esc(a.id) })}<button type="button" class="linkish" data-new-task="${esc(a.id)}">${_t('k1267')}</button></td></tr>`;
  }).join('');
  return `<div class="panel"><div class="table-wrap"><table class="data ag-tbl"><thead><tr><th>${_t('k1268')}</th><th>${_t('k1269')}</th><th>${_t('k1270')}</th><th class="r">${_t('k1260')}</th><th>${_t('k0269')}</th><th>${_t('k1271')}</th><th class="r">${_t('k1272')}</th></tr></thead><tbody>${rows}</tbody></table></div></div>
    <p class="data-note">${_t('k1273')}</p>`;
}

function tasksFiltered() {
  const A = S.ag; const T = A.tasks || [];
  const q = A.q.trim().toLowerCase();
  return T.filter((t) => (!A.agent || t.agent === A.agent) && (!A.status || t.status === A.status || (A.status === 'handoff' && t.from))
    && (!q || `${t.title} ${t.brief} ${t.outcome}`.toLowerCase().includes(q)));
}
function taskRowsHTML(rows) {
  if (!rows.length) return _t('k1274');
  return rows.slice(0, 300).map((t) => `<tr data-open-thread="${esc(t.id)}" tabindex="0"><td class="when">${agoT(t.updatedAt)}</td>
    <td>${agentGlyph(t.agent)} ${esc(agentOf(t.agent).name)}</td>
    <td class="tk-what" title="${esc(t.brief)}"><span class="name">${esc(t.title)}</span>${t.handoffs && t.handoffs.length ? `${_t('k1275')} ${t.handoffs.map((h) => esc(agentOf(h.to).name)).join(_t('k0015'))}</span>` : ''}</td>
    <td>${t.from ? `${agentGlyph(t.from.agent)} <span class="muted">${esc(agentOf(t.from.agent).name)} →</span>` : _t('k1276')}</td>
    <td>${t.projectId != null ? `<a href="#/pipeline/${t.projectId}">#${t.projectId}</a>` : '<span class="muted">—</span>'}</td>
    <td>${pill(TASK_STATUS[t.status] || TASK_STATUS.done)}</td></tr>`).join('');
}
function tasksTabHTML() {
  const A = S.ag;
  const rows = tasksFiltered();
  const opt = (v, cur, label) => `<option value="${esc(v)}"${String(cur) === String(v) ? ' selected' : ''}>${esc(label)}</option>`;
  return `<div class="filters"><label class="search jr-search"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="m10.5 10.5 3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg><input id="tkQ" type="search" placeholder="${_t('k1280')}" value="${esc(A.q)}" aria-label="${_t('k1281')}"></label>
    <select class="jr-sel" id="tkAgent" aria-label="agent">${opt('', A.agent, _t('k1277'))}${S.agents.map((a) => opt(a.id, A.agent, a.name)).join('')}</select>
    <select class="jr-sel" id="tkStatus" aria-label="${_t('k0269')}">${opt('', A.status, _t('k1278'))}${opt('running', A.status, _t('k1224'))}${opt('done', A.status, _t('k0131'))}${opt('error', A.status, _t('k0658'))}${opt('stopped', A.status, _t('k1228'))}${opt('handoff', A.status, _t('k1279'))}</select>
    <span class="meta" id="tkCount">${rows.length} / ${(A.tasks || []).length} ${_t('k1282')}</div>
    <div class="panel"><div class="table-wrap"><table class="data tk-tbl"><thead><tr><th>${_t('k0916')}</th><th>Agent</th><th>${_t('k1260')}</th><th>${_t('k1283')}</th><th>${_t('k0973')}</th><th>${_t('k0269')}</th></tr></thead><tbody id="tkBody">${taskRowsHTML(rows)}</tbody></table></div></div>`;
}

function agentDetailHTML() {
  const D = S.ag.detail;
  if (!D) return '<div class="skeleton" style="height:300px"></div>';
  if (D.error) return errorBox(_t('k1284'), D.error);
  const a = D.agent; const st = agentStats(a.id);
  const opt = (v, cur, label) => `<option value="${esc(v)}"${String(cur || '') === String(v) ? ' selected' : ''}>${esc(label)}</option>`;
  const groups = [...new Set(D.tools.map((t) => t.group))];
  const TS = { allowed: _t('k1285'), denied: _t('k1286'), limited: _t('k1287'), ask: _t('k1288') };
  const tools = groups.map((g) => `<div class="tool-g"><span class="tg-h">${esc(g)}</span>${D.tools.filter((t) => t.group === g).map((t) => `<span class="tool-c t-${t.state}" title="${esc(t.id)}${t.why ? ` · ${esc(t.why)}` : ''}">${esc(t.label)}${t.state !== 'allowed' ? `<i>${TS[t.state]}</i>` : ''}</span>`).join('')}</div>`).join('');
  const recent = ((S.ag.tasks || []).filter((t) => t.agent === a.id)).slice(0, 8);
  return `<div class="ag-hero">${agentGlyph(a.id, 'big')}<div><h2>${esc(a.name)}${a.orchestrator ? _t('k1263') : ''}</h2><p class="sub">${esc(a.role)}</p></div>
      <div class="actions"><button type="button" class="btn primary" data-new-task="${esc(a.id)}">${_t('k1267')}</button></div></div>
    <div class="pg-grid ag-stats">
      <div class="pg-cell"><div class="pg-k">${_t('k1260')}</div><div class="pg-v mono">${st.total}</div><div class="pg-sub">${st.running ? `${_t('k1289', { running: st.running })}` : _t('k1290')}</div></div>
      <div class="pg-cell"><div class="pg-k">${_t('k1299')}</div><div class="pg-v mono">${st.received}</div><div class="pg-sub">${_t('k1300')}</div></div>
      <div class="pg-cell"><div class="pg-k">${_t('k1301')}</div><div class="pg-v mono">${st.handed}</div><div class="pg-sub">${_t('k1302')}</div></div>
      <div class="pg-cell"><div class="pg-k">${_t('k1303')}</div><div class="pg-v mono">${st.cost ? `≈$${st.cost.toFixed(2)}` : '—'}</div><div class="pg-sub">${_t('k1304')}</div></div>
    </div>
    <h3 class="pd-sub">${_t('k1305')}</h3>
    <form class="ag-form" id="agentForm" data-agent="${esc(a.id)}">
      <div class="ag-main">
        <div class="ag-row"><label class="field"><span>${_t('k1268')}</span><input name="name" maxlength="20" value="${esc(a.name)}" required></label>
          <label class="field"><span>${_t('k1270')}</span><select name="model">${opt('', a.model, `${_t('k1292')}${D.envModel ? `${_t('k1291', { envModel: D.envModel })}` : ''}`)}${D.models.map(localizeOpt).map((m) => opt(m.id, a.model, m.label)).join('')}</select></label>
          <label class="field"><span>${_t('k1306')}</span><select name="effort">${opt('', a.effort, _t('k1292'))}${D.efforts.map(localizeOpt).map((m) => opt(m.id, a.effort, m.label)).join('')}</select></label></div>
        <label class="field"><span>${_t('k1307')}</span><input name="role" maxlength="120" value="${esc(a.role)}" required></label>
        <label class="field"><span>${_t('k1308')}</span><textarea name="prompt" rows="16" maxlength="20000" required>${esc(a.prompt)}</textarea></label>
        <label class="field"><span>${_t('k1309')}</span><textarea name="starters" rows="3">${esc((a.starters || []).join('\n'))}</textarea></label>
        <div class="ag-save"><button type="submit" class="btn primary" id="agSave" ${S.ag.dirty ? '' : 'disabled'}>${_t('k1310')}</button><button type="button" class="btn" data-ag-reset ${S.ag.dirty ? '' : 'disabled'}>${_t('k1311')}</button><span class="muted" id="agMsg">${S.ag.dirty ? _t('k1293') : _t('k1294')}</span></div>
      </div>
      <aside class="ag-help"><h4>${_t('k1308')}</h4><p>${_t('k1312')}</p>
        <h4>${_t('k1313')}</h4><p>${_t('k1314')}${a.orchestrator ? _t('k1295') : ''}${_t('k1315')}</p>
        <h4>${_t('k1316')}</h4><p>${_t('k1317')}</p></aside>
    </form>
    <details class="ag-auto"><summary>${_t('k1318')}</summary><pre>${esc(D.teamPrompt)}</pre></details>
    ${D.orchestratorPrompt ? `<details class="ag-auto" open><summary>${_t('k1296')}</summary><pre>${esc(D.orchestratorPrompt)}</pre></details>` : ''}
    <h3 class="pd-sub">${_t('k1319')}</h3>
    <div class="tools-grid"><div class="tool-g"><span class="tg-h">${_t('k1320')}</span>${(D.localTools || []).map((t) => `<span class="tool-c t-${t.state}" title="${esc(t.why)}">${esc(t.label)}<i>${t.state === 'denied' ? _t('k1286') : _t('k1297')}</i></span>`).join('')}<a class="linkish" href="#/agents/changes">${_t('k1321')}</a></div>${tools}<div class="tool-g"><span class="tg-h">${_t('k1322')}</span>${D.baseTools.map((t) => `<span class="tool-c t-allowed">${esc(TOOL_LABELS[t] || t)}</span>`).join('')}<span class="tool-c t-denied" title="${esc(D.blocked.join(_t('k0015')))}">${_t('k1323')}</div></div>
    <h3 class="pd-sub">${_t('k1324')}</h3>
    ${recent.length ? `<div class="panel"><div class="table-wrap"><table class="data tk-tbl"><tbody>${taskRowsHTML(recent)}</tbody></table></div></div>` : _t('k1298')}`;
}

function agentsHTML() {
  const v = S.route.agentsView || 'list';
  const head = `<div class="page-head"><div><div class="eyebrow"><span>${_t('k1325')}</span></div><h1>Agents</h1>
    <p class="sub">${_t('k1326')}</p></div></div>`;
  if (!S.ag || (!S.ag.tasks && !S.ag.error)) return `<div class="page">${head}<div class="skeleton" style="height:260px"></div></div>`;
  const body = v === 'list' ? agentsListHTML() : v === 'tasks' ? tasksTabHTML() : v === 'changes' ? changesTabHTML() : agentDetailHTML();
  return `<div class="page">${head}${agentsTabs(v)}${S.ag.error ? errorBox(_t('k1327'), S.ag.error) : ''}${body}</div>`;
}

function agentFormPatch(form) {
  const f = new FormData(form);
  return {
    name: String(f.get('name') || ''), role: String(f.get('role') || ''), prompt: String(f.get('prompt') || ''),
    model: String(f.get('model') || '') || null, effort: String(f.get('effort') || '') || null,
    starters: String(f.get('starters') || '').split('\n').map((x) => x.trim()).filter(Boolean),
  };
}
function wirePipelineAgents() {
  document.addEventListener('click', (e) => {
    const nt = e.target.closest('[data-new-task]');
    if (nt) { e.preventDefault(); e.stopPropagation(); newTaskFor(nt.dataset.newTask); return; }
    const ot = e.target.closest('[data-open-thread]');
    const inMain = ot && ot.closest('#main');
    if (e.target.closest('[data-idea-miss-x]')) { S.ideaMiss = null; const m = $('#ideaMiss'); if (m) m.outerHTML = ideaMissHTML(); }
    if (inMain && !e.target.closest('a[href]')) { e.preventDefault(); e.stopPropagation(); openThread(ot.dataset.openThread); return; }
    if (e.target.closest('[data-ag-reset]')) { S.ag.dirty = false; S.ag.detail = null; loadAgentsPage(); }
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches && e.target.matches('tr[data-open-thread]')) { e.preventDefault(); openThread(e.target.dataset.openThread); }
  });
  document.addEventListener('input', (e) => {
    if (e.target.closest && e.target.closest('#agentForm') && S.ag && !S.ag.dirty) {
      S.ag.dirty = true;
      const b = $('#agSave'); if (b) b.disabled = false;
      const r = $('[data-ag-reset]'); if (r) r.disabled = false;
      const m = $('#agMsg'); if (m) m.textContent = _t('k1293');
    }
    if (e.target.id === 'tkQ' && S.ag) {
      S.ag.q = e.target.value;
      const rows = tasksFiltered();
      const body = $('#tkBody'); if (body) body.innerHTML = taskRowsHTML(rows);
      const c = $('#tkCount'); if (c) c.textContent = `${rows.length} / ${(S.ag.tasks || []).length} ${_t('k1328')}`;
    }
  });
  document.addEventListener('change', (e) => {
    const k = e.target.id === 'tkAgent' ? 'agent' : e.target.id === 'tkStatus' ? 'status' : null;
    if (k && S.ag) { S.ag[k] = e.target.value; renderMain(); const s = $(`#${e.target.id}`); if (s) s.focus({ preventScroll: true }); }
  });
  document.addEventListener('submit', async (e) => {
    if (e.target.id !== 'agentForm') return;
    e.preventDefault();
    const id = e.target.dataset.agent;
    const btn = $('#agSave'); if (btn) btn.disabled = true;
    try {
      const r = await api(`/api/agents/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(agentFormPatch(e.target)) });
      S.ag.dirty = false; S.ag.detail = null;
      toast(`${_t('k1329', { name: r.agent.name })}`);
      await reloadAgentList();
      loadAgentsPage();
    } catch (err) {
      if (btn) btn.disabled = false;
      const m = $('#agMsg'); if (m) m.textContent = `${_t('k1330', { message: err.message })}`;
    }
  });
  window.addEventListener('beforeunload', (e) => { if (S.ag && S.ag.dirty && S.route.page === 'agents') { e.preventDefault(); e.returnValue = ''; } });
}



/* ---------- 开工前问用户（ask_user） ---------- */
S.questions = new Map(); // id -> 问题组（服务端 questionView）
S.qDraft = new Map();    // id -> { sel: [[label]], other: [''] } 用户还没提交的选择（重画时保住）
const pendingQuestions = (threadId) => [...S.questions.values()].filter((q) => q.state === 'pending' && (!threadId || q.threadId === threadId)).sort((a, b) => a.at - b.at);
async function loadQuestions() {
  try { const r = await api('/api/questions'); S.questions = new Map(r.questions.map((q) => [q.id, q])); } catch { /* 下次事件再补 */ }
  onApprovalsChanged();
}
function qDraft(q) {
  if (!S.qDraft.has(q.id)) S.qDraft.set(q.id, { sel: q.questions.map(() => []), other: q.questions.map(() => '') });
  return S.qDraft.get(q.id);
}
function questionCardHTML(q) {
  const d = qDraft(q); const ag = agentOf(q.agent);
  const left = Math.max(0, Math.round((q.expiresAt - Date.now()) / 60000));
  const items = q.questions.map((qq, i) => `<fieldset class="qq"><legend>${qq.header ? `<span class="qq-h">${esc(qq.header)}</span>` : ''}${esc(qq.question)}${qq.multiSelect ? _t('k1331') : ''}</legend>
    <div class="qq-opts">${qq.options.map((o) => { const on = d.sel[i].includes(o.label); return `<button type="button" class="qq-opt ${on ? 'on' : ''}" data-q-opt="${i}" data-label="${esc(o.label)}" aria-pressed="${on}"><b>${esc(o.label)}</b>${o.description ? `<i>${esc(o.description)}</i>` : ''}</button>`; }).join('')}</div>
    <input type="text" class="qq-other" data-q-other="${i}" value="${esc(d.other[i])}" placeholder="${_t('k1332')}" maxlength="1000" aria-label="${_t('k1333')}"></fieldset>`).join('');
  return `<form class="qcard" data-q="${esc(q.id)}">
    <div class="qc-top">${_t('k1334', { v: esc(ag.glyph), v2: esc(ag.name), left })}</div>
    ${q.intro ? `<p class="qc-intro">${esc(q.intro)}</p>` : ''}${items}
    <div class="ap-act"><button type="submit" class="btn sm primary">${_t('k1335')}</button><button type="button" class="btn sm" data-q-skip>${_t('k1336')}</button></div>
  </form>`;
}
// 对话里的 ask_user 工具：等待中 → 可以作答的卡片；回答过 → 简短的问答记录
function askBlockHTML(p, live) {
  const q = live && p.status === 'running' && S.thread ? pendingQuestions(S.thread.id)[0] : null;
  if (q) return questionCardHTML(q);
  const qs = (p.input && Array.isArray(p.input.questions)) ? p.input.questions : [];
  const res = String(p.result || '');
  const skipped = /跳过|没有回答|作废/.test(res);
  return `<details class="qdone"><summary>${_t('k1340', { n: qs.length })}${p.status === 'running' ? _t('k1337') : skipped ? _t('k1338') : _t('k1339')}</summary>
    <div class="md">${md(res || qs.map((x, i) => `${i + 1}. ${x.question}`).join('\n'))}</div></details>`;
}
async function answerQuestion(id, { freeText = '', skip = false } = {}) {
  const q = S.questions.get(id); if (!q) return;
  const d = qDraft(q);
  const body = skip ? { skip: true } : { answers: q.questions.map((_, i) => ({ selected: d.sel[i], other: d.other[i] })), freeText };
  try {
    await api(`/api/questions/${id}`, { method: 'POST', body: JSON.stringify(body) });
    q.state = skip ? 'skipped' : 'answered';
    S.qDraft.delete(id);
    if (freeText) { $('#input').value = ''; autosize(); }
    onApprovalsChanged();
  } catch (e) { toast(`${_t('k1341', { message: e.message })}`); }
}
function wireQuestions() {
  document.addEventListener('click', (e) => {
    const o = e.target.closest('[data-q-opt]');
    if (o) {
      e.preventDefault();
      const card = o.closest('[data-q]'); const q = S.questions.get(card.dataset.q); if (!q) return;
      const i = Number(o.dataset.qOpt); const label = o.dataset.label; const d = qDraft(q);
      if (q.questions[i].multiSelect) d.sel[i] = d.sel[i].includes(label) ? d.sel[i].filter((x) => x !== label) : [...d.sel[i], label];
      else d.sel[i] = d.sel[i][0] === label ? [] : [label];
      card.querySelectorAll(`[data-q-opt="${i}"]`).forEach((b) => { const on = d.sel[i].includes(b.dataset.label); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
      return;
    }
    const sk = e.target.closest('[data-q-skip]');
    if (sk) { e.preventDefault(); answerQuestion(sk.closest('[data-q]').dataset.q, { skip: true }); }
  });
  document.addEventListener('input', (e) => {
    const t = e.target.closest && e.target.closest('[data-q-other]');
    if (!t) return;
    const q = S.questions.get(t.closest('[data-q]').dataset.q); if (q) qDraft(q).other[Number(t.dataset.qOther)] = t.value;
  });
  document.addEventListener('submit', (e) => {
    const f = e.target.closest && e.target.closest('form[data-q]');
    if (!f) return;
    e.preventDefault();
    const q = S.questions.get(f.dataset.q); if (!q) return;
    const d = qDraft(q);
    if (!d.sel.some((x) => x.length) && !d.other.some((x) => x.trim())) { toast(_t('k1342')); return; }
    answerQuestion(q.id);
  });
}

/* ---------- agent 自己改代码：审批 + 改动记录 ---------- */
S.approvals = new Map(); // id -> 审批请求（服务端 approvalView）
let APPR_CAT; _regT(() => { APPR_CAT = { integrity: [_t('k1343'), 'cat-integrity'], delete: [_t('k0600'), 'cat-delete'], install: [_t('k1344'), 'cat-install'], core: [_t('k1345'), 'cat-core'], command: [_t('k1346'), 'cat-command'] }; });;
let CHG_ST; _regT(() => { CHG_ST = { open: [_t('k1347'), 'st-idle'], verifying: [_t('k1348'), 'st-active'], verified: [_t('k1349'), 'st-done'], kept: [_t('k1350'), 'st-done'], failed: [_t('k1351'), 'st-error'], reverted: [_t('k1352'), 'st-stopped'], unverified: [_t('k1353'), 'st-blocked'] }; });
const pendingApprovals = (threadId) => [...S.approvals.values()].filter((a) => a.state === 'pending' && (!threadId || a.threadId === threadId)).sort((a, b) => a.at - b.at);
async function loadApprovals() {
  try { const r = await api('/api/approvals'); S.approvals = new Map(r.approvals.map((a) => [a.id, a])); } catch { /* 下次事件再补 */ }
  onApprovalsChanged();
}
function onApprovalsChanged() {
  const n = pendingApprovals().length + pendingQuestions().length;
  let b = $('#apprBadge');
  if (!b) { b = document.createElement('button'); b.type = 'button'; b.id = 'apprBadge'; b.className = 'appr-badge'; $('#runs').before(b); }
  b.hidden = !n;
  b.textContent = `${_t('k1354', { n })}`;
  updateComposer();
  if (S.thread && S.running.has(S.thread.id)) { renderLive(); }
  if (S.route.page === 'agents' && S.route.agentsView === 'changes') renderMain();
}
function diffHTML(text) {
  if (!text) return '';
  return `<pre class="diff">${String(text).split('\n').map((l) => `<span class="${l.startsWith('+ ') ? 'd-add' : l.startsWith('- ') ? 'd-del' : l.startsWith('@@') ? 'd-hunk' : ''}">${esc(l)}</span>`).join('\n')}</pre>`;
}
function approvalCardHTML(a) {
  const ag = agentOf(a.agent); const [cat, cls] = APPR_CAT[a.category] || [_t('k1272'), 'cat-command'];
  const left = Math.max(0, Math.round((a.expiresAt - Date.now()) / 60000));
  const warn = a.category === 'integrity' ? _t('k1355')
    : a.category === 'delete' && a.command ? _t('k1356')
    : a.category === 'install' ? _t('k1357') : '';
  return `<div class="approval" data-appr="${esc(a.id)}">
    <div class="ap-top">${_t('k1361', { cls, v: esc(cat), v2: esc(ag.name), v3: esc(a.title), left })}</div>
    ${a.why ? `<details class="ap-why"><summary>${_t('k1358')}</summary><div class="md">${md(a.why)}</div></details>` : ''}
    ${a.integrity && a.integrity.length ? `<p class="ap-sub">${_t('k1359')}${a.integrity.map((x) => `<code>${esc(x)}</code>`).join(' ')}</p>` : ''}
    ${a.command ? `<pre class="ap-cmd">$ ${esc(a.command)}</pre>` : ''}
    ${a.diff ? `<div class="ap-diff-h">${esc(a.rel || '')} ${a.created ? _t('k1360') : ''}<span class="mono">+${a.added || 0} −${a.removed || 0}</span></div>${diffHTML(a.diff)}` : ''}
    ${warn}
    <div class="ap-act"><input type="text" class="ap-note" placeholder="${_t('k1362')}" aria-label="${_t('k1363')}" maxlength="500">
      <button type="button" class="btn sm primary" data-appr-do="allow">${_t('k1364')}</button>
      <button type="button" class="btn sm" data-appr-do="thread" title="${_t('k1365')}">${_t('k1366')}</button>
      <button type="button" class="btn sm danger" data-appr-do="deny">${_t('k1367')}</button></div>
  </div>`;
}
function approvalsHTML(threadId) {
  const list = pendingApprovals(threadId);
  return list.length ? `<div class="approvals">${list.map(approvalCardHTML).join('')}</div>` : '';
}
function changeCardHTML(c) {
  const [st, cls] = CHG_ST[c.status] || [c.status, 'st-idle'];
  return `<div class="chg-card"><div class="cc-top">${_t('k1369', { n: c.files.length, v: pill([st, cls]) })}${c.needsRestart ? _t('k1368') : ''}${_t('k1370', { v: esc(c.id) })}</div>
    <div class="cc-files">${c.files.map((f) => `<code>${esc(f)}</code>`).join(' ')}</div>${c.revertReason && c.status === 'reverted' ? `<div class="muted">${esc(c.revertReason)}</div>` : ''}</div>`;
}
async function loadChanges() {
  if (!S.chg) S.chg = { list: null, detail: null, error: null };
  try { const r = await api('/api/changes'); S.chg.list = r.changes; S.chg.restart = r.restartNeeded; S.chg.error = null; } catch (e) { S.chg.error = e.message; }
  const id = S.route.changeId;
  if (id) { try { S.chg.detail = (await api(`/api/changes/${id}`)).change; } catch (e) { S.chg.detail = { id, error: e.message }; } } else S.chg.detail = null;
}
async function refreshRestart() {
  try { const r = await api('/api/changes'); const was = S.restartNeeded; S.restartNeeded = r.restartNeeded; if (r.restartNeeded && !was) toast(_t('k1371'), { sticky: true }); } catch { /* 忽略 */ }
}
let POLICY_HTML; _regT(() => { POLICY_HTML = `<div class="policy"><div><h4>${_t('k1372')}</h4><p>${_t('k1373')}</p></div>
  <div><h4>${_t('k1374')}</h4><p>${_t('k1375')}</p></div>
  <div><h4>${_t('k1376')}</h4><p>${_t('k1377')}</p></div></div>`; });
function changesTabHTML() {
  const C = S.chg || {};
  const pend = pendingApprovals();
  const pendHTML = pend.length ? `<h3 class="pd-sub">${_t('k1379', { n: pend.length })}</h3>${pend.map((a) => `<div class="ap-wrap"><div class="ap-ctx">${agentGlyph(a.agent)} <button type="button" class="linkish" data-open-thread="${esc(a.threadId)}">${esc(a.threadTitle || _t('k1378'))}</button></div>${approvalCardHTML(a)}</div>`).join('')}` : '';
  const restart = C.restart ? _t('k1380') : '';
  if (C.error && !C.list) return `${pendHTML}${errorBox(_t('k1381'), C.error)}`;
  if (!C.list) return `${pendHTML}<div class="skeleton" style="height:200px"></div>`;
  const rows = C.list.map((c) => {
    const [st, cls] = CHG_ST[c.status] || [c.status, 'st-idle'];
    const sel = S.route.changeId === c.id;
    return `<tr data-href="#/agents/changes${sel ? '' : `/${esc(c.id)}`}" class="${sel ? 'sel' : ''}"><td class="when">${agoT(c.at)}</td><td>${agentGlyph(c.agent)} ${esc(agentOf(c.agent).name)}</td>
      <td class="tk-what"><span class="name">${c.files.map((f) => esc(f.rel)).join(_t('k0015'))}</span><span class="when">${esc(c.title || '')}</span></td>
      <td>${pill([st, cls])}${c.needsRestart && c.status !== 'reverted' ? _t('k1382') : ''}</td>
      <td class="r">${c.approvals ? `${_t('k1383', { approvals: c.approvals })}` : ''}</td></tr>`;
  }).join('');
  const D = C.detail;
  let det = '';
  if (D && D.error) det = errorBox(_t('k1381'), D.error);
  else if (D) {
    const suites = D.tests ? D.tests.suites.map((x) => `<div class="suite ${x.state}">${_t('k1387', { v: esc(x.name) })}${x.state === 'pass' ? _t('k1384') : x.state === 'skipped' ? _t('k1385') : _t('k1386')}${x.state === 'fail' && x.tail ? `<pre>${esc(x.tail)}</pre>` : ''}</div>`).join('') : _t('k1388');
    det = `<section class="chg-detail"><div class="pd-head"><div><div class="eyebrow">${_t('k1393', { v: esc(D.id) })}</div><h2>${agentGlyph(D.agent)} ${esc(agentOf(D.agent).name)} · ${esc(D.title || '')}</h2></div>
      <div class="actions"><button type="button" class="btn" data-open-thread="${esc(D.threadId)}">${_t('k1249')}</button>${D.status !== 'reverted' ? `<button type="button" class="btn danger" data-chg-revert="${esc(D.id)}">${_t('k1389')}</button>` : ''}</div></div>
      ${D.revertReason ? `<p class="muted">${esc(D.revertReason)}</p>` : ''}
      <h3 class="pd-sub">${_t('k1394')}</h3>${suites}
      ${D.approvals && D.approvals.length ? `<h3 class="pd-sub">${_t('k1390')}</h3><ul class="ap-log">${D.approvals.map((x) => `<li>${esc(x.how)} · ${esc(x.title)}</li>`).join('')}</ul>` : ''}
      <h3 class="pd-sub">${_t('k1395')}</h3>
      ${D.files.map((f) => `<div class="ap-diff-h">${esc(f.rel)} ${f.existed ? '' : _t('k1360')}${f.exists ? '' : _t('k1391')}<span class="mono">+${f.diff.added} −${f.diff.removed}</span></div>${f.diff.text ? diffHTML(f.diff.text) : _t('k1392')}`).join('')}
    </section>`;
  }
  return `${restart}${pendHTML}<h3 class="pd-sub">${_t('k1398')}</h3>${POLICY_HTML}
    <h3 class="pd-sub">${_t('k1399')}</h3>
    ${C.list.length ? `<div class="panel"><div class="table-wrap"><table class="data tk-tbl chg-tbl"><thead><tr><th>${_t('k1179')}</th><th>Agent</th><th>${_t('k1396')}</th><th>${_t('k0269')}</th><th class="r"></th></tr></thead><tbody>${rows}</tbody></table></div></div>` : _t('k1397')}
    ${det}`;
}
function wireApprovals() {
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-appr-do]');
    if (b) {
      e.preventDefault(); e.stopPropagation();
      const card = b.closest('[data-appr]'); const id = card.dataset.appr;
      const note = (card.querySelector('.ap-note') || {}).value || '';
      card.querySelectorAll('button').forEach((x) => { x.disabled = true; });
      const how = b.dataset.apprDo;
      try {
        await api(`/api/approvals/${id}`, { method: 'POST', body: JSON.stringify({ decision: how === 'deny' ? 'deny' : 'allow', scope: how === 'thread' ? 'thread' : 'once', note }) });
        const a = S.approvals.get(id); if (a) a.state = how === 'deny' ? 'denied' : 'allowed';
        onApprovalsChanged();
      } catch (err) { toast(`${_t('k1400', { message: err.message })}`); card.querySelectorAll('button').forEach((x) => { x.disabled = false; }); }
      return;
    }
    if (e.target.closest('#apprBadge')) { const a = pendingQuestions()[0] || pendingApprovals()[0]; if (a) openThread(a.threadId); return; }
    const rv = e.target.closest('[data-chg-revert]');
    if (rv) {
      e.preventDefault(); e.stopPropagation();
      const id = rv.dataset.chgRevert;
      const ok = await askConfirm({ title: _t('k1401'), message: _t('k1402'), ok: _t('k1403'), danger: true });
      if (!ok) return;
      try {
        let r;
        try { r = await api(`/api/changes/${id}/revert`, { method: 'POST', body: '{}' }); } catch (err) {
          if (!/又被改过|changed again/i.test(err.message)) throw err;
          const again = await askConfirm({ title: _t('k1404'), message: `${err.message}`, ok: _t('k1405'), danger: true });
          if (!again) return;
          r = await api(`/api/changes/${id}/revert`, { method: 'POST', body: JSON.stringify({ force: true }) });
        }
        toast(r.needsRestart ? _t('k1406') : _t('k1352'));
        await loadChanges(); renderMain(); refreshRestart();
      } catch (err) { toast(`${_t('k1407', { message: err.message })}`); }
    }
  }, true);
}

/* ================= chat ================= */
function renderAgents() {
  $('#agentRow').innerHTML = S.agents.map((a) => {
    const n = [...S.running.values()].filter((r) => r.agent === a.id).length;
    return `<button class="agent-chip ${a.id === S.agentId ? 'active' : ''} ${n ? 'busy' : ''}" style="--c:${a.color}" data-agent="${esc(a.id)}" role="tab" aria-selected="${a.id === S.agentId}" title="${esc(a.role)}${n ? ` ${_t('k1408', { n })}` : ''}">
      <span class="g">${esc(a.glyph)}</span>${esc(a.name)}${n ? `${_t('k1409')}${n > 1 ? n : ''}</span>` : ''}
    </button>`;
  }).join('');
  $('#input').placeholder = `${_t('k1410', { name: agentOf(S.agentId).name })}`;
}

// 点 agent 标签：打开它正在跑的对话，否则打开它最近的对话，都没有就是新对话
function selectAgent(id) {
  S.agentId = id;
  store.set('agent', id);
  const running = [...S.running.entries()].find(([, r]) => r.agent === id);
  if (running) { openThread(running[0]); return; }
  const recent = S.threads.find((t) => t.agent === id);
  if (recent && !(S.thread && S.thread.agent === id)) { openThread(recent.id); return; }
  if (S.thread && S.thread.agent !== id) { closeSub(); S.thread = null; store.set('thread', null); }
  renderAgents();
  renderThread();
}

async function loadThreads() {
  try { S.threads = await api('/api/threads'); } catch { S.threads = []; }
  if (!$('#threadMenu').hidden) renderThreadMenu();
}

function closeSub() { if (S.sub) { S.sub.ctrl.abort(); S.sub = null; } }

let openSeq = 0;
async function openThread(id, { quiet = false } = {}) {
  closeSub();
  const tok = ++openSeq;
  let t;
  try { t = await api(`/api/threads/${encodeURIComponent(id)}`); } catch (e) { toast(`${_t('k1411', { message: e.message })}`); return; }
  if (tok !== openSeq) return; // 连点了别的对话：只认最后一次
  S.thread = t;
  S.agentId = t.agent;
  store.set('thread', id);
  store.set('agent', t.agent);
  if (!quiet) openChat();
  renderAgents();
  renderThread();
  if (t.running) subscribe(id);
}

// 订阅某个对话的实时事件（服务器先发快照，再推增量）
function subscribe(threadId) {
  closeSub();
  const ctrl = new AbortController();
  S.sub = { threadId, ctrl };
  const onEv = (ev) => {
    if (!S.thread || S.thread.id !== threadId) return;
    const msgs = S.thread.messages;
    let live = msgs[msgs.length - 1];
    if (ev.type === 'snapshot') {
      if (live && live.role === 'assistant') msgs[msgs.length - 1] = ev.message; else msgs.push(ev.message);
      renderThread();
      return;
    }
    if (!live || live.role !== 'assistant') { live = { role: 'assistant', agent: S.thread.agent, parts: [] }; msgs.push(live); }
    if (ev.type === 'end') {
      // 运行已结束：立刻失败时（比如 claude 没装），run_end 可能比发送请求的响应先到，这里兜底清掉「运行中」
      S.running.delete(threadId); if (S.stopping === threadId) S.stopping = null;
      renderRuns(); renderRunBar(); updateComposer();
      // 用服务器保存的最终版本（包含模型、用量等）替换
      api(`/api/threads/${threadId}`).then((t) => { if (S.thread && S.thread.id === threadId) { S.thread = t; renderThread({ keep: true }); } }).catch(() => {});
      return;
    }
    applyEvent(ev, live);
  };
  readSSE(`/api/threads/${threadId}/stream`, onEv, ctrl.signal).catch(() => {});
}

function applyEvent(ev, live) {
  switch (ev.type) {
    case 'text_start': live.parts.push({ kind: 'text', text: '' }); break;
    case 'delta': {
      let last = live.parts[live.parts.length - 1];
      if (!last || last.kind !== 'text') { last = { kind: 'text', text: '' }; live.parts.push(last); }
      last.text += ev.text;
      break;
    }
    case 'tool_use': live.draft = null; live.parts.push({ ...ev.part }); break;
    case 'draft': live.draft = ev.name ? { name: ev.name, agent: ev.agent || null, chars: ev.chars || 0 } : null; break;
    case 'tool_result': {
      const p = live.parts.find((x) => x.kind === 'tool' && x.id === ev.id);
      if (p) { p.status = ev.status; p.result = ev.result; }
      break;
    }
    case 'result':
      live.cost = ev.cost; live.duration = ev.duration;
      if (ev.model) live.model = ev.model;
      if (ev.error) live.error = ev.error;
      if (ev.denied && ev.denied.length) live.denied = ev.denied;
      break;
    default: break;
  }
  renderLive();
}

function newThreadUI() {
  closeSub();
  openSeq += 1;
  S.thread = null;
  store.set('thread', null);
  renderAgents();
  renderThread();
  $('#input').focus();
}

function renderThreadMenu() {
  const m = $('#threadMenu');
  if (!S.threads.length) { m.innerHTML = _t('k1412'); return; }
  m.innerHTML = S.threads.map((t) => {
    const a = agentOf(t.agent);
    const run = S.running.has(t.id);
    return `<div class="thread-item ${S.thread && S.thread.id === t.id ? 'active' : ''}" role="button" tabindex="0" data-thread="${esc(t.id)}">
      <span class="g" style="color:${a.color}">${esc(a.glyph)}</span><span class="tt">${t.from ? '↳ ' : ''}${esc(t.title)}</span><span class="w">${run ? '<span class="spin"></span>' : agoT(t.updatedAt)}</span>
      ${run ? '<span></span>' : `<button type="button" class="x" data-del="${esc(t.id)}" title="${_t('k1413')}" aria-label="${_t('k1414', { v: esc(t.title) })}">✕</button>`}</div>`;
  }).join('');
}

// 内置的 Markdown 渲染（离线可用，不依赖 CDN）。先整体转义，再只生成白名单里的标签；
// 链接只允许 http(s)、站内 # 和 /api/ 路径，所以 agent 或服务器返回的文本无法注入脚本。
function mdInline(t) {
  const codes = [];
  t = t.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  const safeUrl = (u, img) => ((img ? /^\/api\//i : /^(https?:\/\/|#\/|\/api\/)/i).test(u) && !/[\s<>"']|&(quot|#39|lt|gt);/.test(u) ? u : null);
  // 生成的标签先收起来，免得后面的加粗/自动链接规则改到属性里
  const tags = [];
  const stash = (h) => { tags.push(h); return `\u0001${tags.length - 1}\u0001`; };
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, u) => (safeUrl(u, true) ? stash(`<img loading="lazy" src="${u}" alt="${alt}">`) : m));
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, txt, u) => (safeUrl(u) ? `${stash(/^https?:/i.test(u) ? `<a href="${u}" target="_blank" rel="noopener noreferrer">` : `<a href="${u}">`)}${txt}${stash('</a>')}` : m));
  t = t.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>').replace(/__([^_\n]+?)__/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, '$1<em>$2</em>');
  t = t.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');
  t = t.replace(/(^|[\s（(：:，,])(https?:\/\/[^\s<>"'）)\u0000\u0001]+)/g, (m, pre, u) => `${pre}<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
  t = t.replace(/\u0001(\d+)\u0001/g, (_, i) => tags[+i]);
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
}
function md(text) {
  const lines = esc(String(text || '').replace(/\r\n?/g, '\n').replace(/[\u0000\u0001]/g, '')).split('\n');
  const out = [];
  let i = 0;
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const isSep = (l) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(l || '') && /-/.test(l || '') && /\|/.test(l || '');
  const listRe = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const hrRe = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i += 1; continue; }
    const fence = l.match(/^\s*(```|~~~)/);
    if (fence) {
      const buf = []; i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) { buf.push(lines[i]); i += 1; }
      i += 1;
      out.push(`<div class="md-code"><button type="button" class="copy-code" data-copy-code aria-label="${_t('k1415')}">${_t('k1416')}</button><pre><code>${buf.join('\n')}</code></pre></div>`);
      continue;
    }
    const h = l.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) { const n = Math.min(h[1].length + 1, 6); out.push(`<h${n}>${mdInline(h[2])}</h${n}>`); i += 1; continue; }
    if (hrRe.test(l)) { out.push('<hr>'); i += 1; continue; }
    if (/\|/.test(l) && isSep(lines[i + 1])) {
      const head = cells(l);
      const align = cells(lines[i + 1]).map((c) => (/^:?-+:$/.test(c) ? (c.startsWith(':') ? 'center' : 'right') : ''));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && /\|/.test(lines[i])) { rows.push(cells(lines[i])); i += 1; }
      const at = (k) => (align[k] ? ` style="text-align:${align[k]}"` : '');
      out.push(`<div class="md-table"><table><thead><tr>${head.map((c, k) => `<th${at(k)}>${mdInline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, k) => `<td${at(k)}>${mdInline(r[k] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*&gt;\s?/.test(l)) {
      const buf = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*&gt;\s?/, '')); i += 1; }
      out.push(`<blockquote>${buf.map(mdInline).join('<br>')}</blockquote>`);
      continue;
    }
    if (listRe.test(l)) {
      // 嵌套按缩进分层；一层里的续行并进上一项
      const build = (indent) => {
        const first = lines[i].match(listRe);
        const tag = /\d/.test(first[2]) ? 'ol' : 'ul';
        let html = `<${tag}>`;
        while (i < lines.length) {
          const m = lines[i].match(listRe);
          if (!m) {
            if (lines[i].trim() && /^\s+/.test(lines[i]) && html.endsWith('</li>')) { html = `${html.slice(0, -5)}<br>${mdInline(lines[i].trim())}</li>`; i += 1; continue; }
            break;
          }
          const ind = m[1].length;
          if (ind < indent) break;
          if (ind > indent + 1 && html.endsWith('</li>')) { html = `${html.slice(0, -5)}${build(ind)}</li>`; continue; }
          html += `<li>${mdInline(m[3])}</li>`;
          i += 1;
        }
        return `${html}</${tag}>`;
      };
      out.push(build(l.match(listRe)[1].length));
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~)/.test(lines[i]) && !/^\s{0,3}#{1,6}\s/.test(lines[i]) && !hrRe.test(lines[i]) && !listRe.test(lines[i]) && !/^\s*&gt;\s?/.test(lines[i]) && !(/\|/.test(lines[i]) && isSep(lines[i + 1]))) { buf.push(lines[i]); i += 1; }
    if (!buf.length) { buf.push(lines[i]); i += 1; } // 兜底：任何情况下都往前走一行
    out.push(`<p>${buf.map(mdInline).join('<br>')}</p>`);
  }
  return out.join('');
}
function prettyModel(id) {
  const m = String(id || '').match(/claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/);
  if (!m) return String(id || '');
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}
const modelLabel = (id) => (S.options.models.find((x) => x.id === id) || {}).label || id;

function toolArg(short, input = {}) {
  if (!input || typeof input !== 'object') return '';
  if (short === 'write_file') return `${input.name || ''} · ${String(input.content || '').split('\n').length} ${_t('k0590')}`;
  if (short === 'fetch_data') return (input.tickers || []).join(', ');
  return input.name || input.query || input.filter || input.description || input.url || input.pattern || input.file_path
    || (input.backtestId ? `${String(input.backtestId).slice(0, 10)}…` : '') || (input.projectId ? `#${input.projectId}` : '');
}

// 交接卡片里的 agent：严格按 id 查；没有 id（输入还没写完）或查不到时不要退回总控，否则会显示成「总控 → 总控」
function handoffAgent(id) {
  const f = (S.agents || []).find((x) => x.id === id);
  if (f) return f;
  return { id: id || '', name: id ? String(id) : '…', glyph: '…', color: 'var(--text-2)' };
}
// 交接：对方的对话在运行中时，按「来源对话 + agent」找到它（wait=true 时工具结果要等对方做完才返回，threadId 还拿不到）。
// 同一条消息里同时交给同一个 agent 两次时：优先按任务文字和对话标题的开头对上，再排除这一轮里已经被别的卡片认走的（used）
function findChildRun(parentId, agentId, task = '', used = null) {
  if (!parentId) return null;
  const norm = (x) => String(x || '').replace(/\s+/g, ' ').trim();
  const nt = norm(task);
  const cands = [];
  for (const [tid, r] of S.running) {
    if (r.from && r.from.threadId === parentId && r.agent === agentId && !(used && used.has(tid))) cands.push({ threadId: tid, title: r.title });
  }
  if (!cands.length) return null;
  const hit = nt ? cands.find((c) => { const h = norm(c.title).slice(0, 12); return h && nt.includes(h); }) : null;
  const pick = hit || cands[0];
  if (used) used.add(pick.threadId);
  return pick;
}
// wait=true 的工具结果形如「…它的最终回答：\n\n<正文>」；取出正文，取不到就是空串
function handoffAnswer(result) {
  const m = String(result || '').match(/最终回答：\n\n([\s\S]*)$/);
  return m ? m[1].trim() : '';
}

// live=false 时还停在 running 的交接（比如服务重启、运行被打断后从磁盘读回来）按「已中断」画，免得转圈转个没完
function handoffHTML(p, parentId, parentAgent, live = true, used = null) {
  const input = p.input && typeof p.input === 'object' ? p.input : {};
  const a = handoffAgent(input.agent);
  const from = (S.agents || []).find((x) => x.id === parentAgent) || { name: '', glyph: '', color: 'var(--text-2)' };
  const st = p.status === 'running' && !live ? 'stopped' : ['running', 'error', 'stopped'].includes(p.status) ? p.status : 'done';
  const task = typeof input.task === 'string' ? input.task : '';
  const fromResult = (String(p.result || '').match(/threadId=([A-Za-z0-9-]+)/) || [])[1];
  const child = st === 'running' && input.agent ? findChildRun(parentId, input.agent, task, used) : null;
  const tid = fromResult || (child && child.threadId) || null;
  const answer = st === 'done' && input.wait ? handoffAnswer(p.result) : '';
  let state;
  if (st === 'running') state = !input.agent ? _t('k1417') : input.wait ? (child ? `${_t('k1418', { name: a.name, title: child.title })}` : `${_t('k1419', { name: a.name })}`) : _t('k1420');
  else if (st === 'error') state = _t('k1421');
  else if (st === 'stopped') state = `${_t('k1422', { name: a.name })}`;
  else state = input.wait ? `${_t('k1423', { name: a.name })}` : `${_t('k1424', { name: a.name })}`;
  const open = answer && S.openTools.has(`h-${p.id}`) ? 'open' : '';
  return `<div class="handoff ${st}">
    <div class="h-top"><span class="g">${esc(a.glyph)}</span><span class="h-state">${st === 'running' ? '<span class="spin"></span>' : ''}${esc(state)}</span>
      ${tid ? `<button type="button" class="btn sm" data-open-thread="${esc(tid)}">${_t('k1425', { v: esc(a.name) })}</button>` : ''}</div>
    <div class="h-flow"><span>${esc(from.name)}</span><i aria-hidden="true">→</i><span>${esc(a.name)}</span><span class="h-mode">${input.wait ? _t('k1426') : _t('k1427')}</span></div>
    ${task ? `<div class="h-task">${esc(task.slice(0, 280))}${task.length > 280 ? '…' : ''}</div>` : ''}
    ${answer ? `<details class="h-result" data-tid="h-${esc(p.id)}" ${open}><summary>${_t('k1428', { v: esc(a.name), n: answer.length })}</summary><div class="md">${md(answer)}</div></details>` : ''}
    ${st === 'error' ? `<div class="h-err">${esc(p.result || '')}</div>` : ''}
  </div>`;
}

// 工具参数还在流式写出来的时候（交接说明、整份代码）：说清楚在准备什么，别只显示「思考中」
function draftText(d) {
  const short = shortTool(d.name);
  const n = d.chars > 40 ? ` ${_t('k1429', { toLocaleString: d.chars.toLocaleString() })}` : '';
  if (d.name === 'helm:verify') return _t('k1430');
  if (short === 'handoff') return d.agent ? `${_t('k1431', { name: agentOf(d.agent).name, n })}` : `${_t('k1432', { n })}`;
  return `${_t('k1433')}${TOOL_LABELS[short] || short}${n}`;
}
function draftHTML(d, fromAgent) {
  if (shortTool(d.name) === 'handoff') {
    const a = d.agent ? handoffAgent(d.agent) : null;
    const from = agentOf(fromAgent);
    return `<div class="handoff running drafting"><div class="h-top"><span class="g">${esc(a ? a.glyph : '…')}</span><span class="h-state"><span class="spin"></span>${esc(draftText(d))}</span></div>
      <div class="h-flow"><span>${esc(from.name)}</span><i aria-hidden="true">→</i><span>${esc(a ? a.name : '…')}${_t('k1434')}</div></div>`;
  }
  return `<div class="thinking"><span class="dots"><span></span><span></span><span></span></span>${esc(draftText(d))}</div>`;
}

function toolHTML(p) {
  const short = shortTool(p.name);
  const ico = p.status === 'running' ? '<span class="spinner"></span>' : p.status === 'error' ? '<span class="bad">✕</span>' : p.status === 'stopped' ? '<span class="stop">■</span>' : '<span class="ok">✓</span>';
  return `<details class="tool" data-tid="${esc(p.id)}" ${S.openTools.has(p.id) ? 'open' : ''}>
    <summary><span class="ico">${ico}</span><span class="lbl">${esc(TOOL_LABELS[short] || short)}</span><span class="arg">${esc(toolArg(short, p.input))}</span></summary>
    <div class="detail"><div class="cap">${_t('k1435')}</div><pre>${esc(JSON.stringify(p.input, null, 2))}</pre>${p.result != null ? `<div class="cap">${_t('k0975')}</div><pre>${esc(p.result)}</pre>` : ''}</div>
  </details>`;
}

function aiInner(m, live, last = false) {
  let html = '';
  let tools = [];
  const usedKids = new Set(); // 同一条消息里的多张交接卡片不要认到同一个对方对话
  const flush = () => { if (tools.length) { html += `<div class="tools">${tools.map(toolHTML).join('')}</div>`; tools = []; } };
  m.parts.forEach((p, i) => {
    if (p.kind === 'tool' && shortTool(p.name) === 'handoff') { flush(); html += handoffHTML(p, S.thread && S.thread.id, m.agent, live, usedKids); return; }
    if (p.kind === 'tool' && shortTool(p.name) === 'ask_user') { flush(); html += askBlockHTML(p, live); return; }
    if (p.kind === 'tool') { if (shortTool(p.name) !== 'ToolSearch') tools.push(p); return; }
    flush();
    html += `<div class="md ${live && i === m.parts.length - 1 ? 'cursor' : ''}">${md(p.text)}</div>`;
  });
  flush();
  if (live && m.draft) {
    html += draftHTML(m.draft, m.agent);
  } else if (live && (!m.parts.length || m.parts[m.parts.length - 1].kind === 'tool')) {
    const runningTool = m.parts.some((p) => p.kind === 'tool' && p.status === 'running');
    html += `<div class="thinking"><span class="dots"><span></span><span></span><span></span></span>${runningTool ? _t('k1436') : _t('k1437')}</div>`;
  }
  if (m.error) html += `<div class="notice err"><b>${_t('k0132')}</b><pre>${esc(zhErr(m.error))}</pre>${last ? `<button type="button" class="btn sm" data-retry-last>${_t('k0013')}</button>` : ''}</div>`;
  // 运行结束却什么都没说（没有文字、没有工具、没报错）：别留一个空白的名字，说清楚并给「重试」
  else if (!live && !m.stopped && !m.parts.some((p) => (p.kind === 'text' && String(p.text || '').trim()) || (p.kind === 'tool' && shortTool(p.name) !== 'ToolSearch'))) {
    html += `<div class="notice warn">${_t('ux040')}${last ? ` <button type="button" class="btn sm" data-retry-last>${_t('k0013')}</button>` : ''}</div>`;
  }
  if (m.denied && m.denied.length) {
    html += `<div class="notice warn">${_t('k1438')}${m.denied.map((d) => `<code>${esc(TOOL_LABELS[shortTool(d)] || shortTool(d))}</code>`).join(_t('k0015'))}${_t('k0199')}
      <br><button class="btn sm" data-retry-danger>${_t('k1439')}</button></div>`;
  }
  if (live && S.thread) html += approvalsHTML(S.thread.id);
  if (m.changes) html += changeCardHTML(m.changes);
  if (m.stopped) html += _t('k1440');
  if (!live && (m.duration || m.model)) {
    const swapped = m.requestedModel && m.model && !String(m.model).includes(m.requestedModel);
    const eff = m.effort ? (S.options.efforts.find((e) => e.id === m.effort) || {}).label || m.effort : '';
    html += `<div class="foot">
      ${m.model ? `<span class="mdl">${esc(prettyModel(m.model))}</span>` : ''}${eff ? `<span>${_t('k1441', { v: esc(eff) })}</span>` : ''}
      ${swapped ? `${_t('k1442', { v: esc(modelLabel(m.requestedModel)) })}` : ''}${autoPickHTML(m.auto)}
      ${m.duration ? `<span>${(m.duration / 1000).toFixed(1)}s</span>` : ''}${m.cost ? `${_t('k1443', { toFixed: (+m.cost).toFixed(3) })}` : ''}
    </div>`;
  }
  return html;
}

function msgHTML(m, live = false, last = false) {
  if (m.role === 'user') {
    if (m.from) {
      const a = agentOf(m.from.agent);
      return `<div class="msg handed"><div class="handed-head" style="--c:${a.color}">${_t('k1444', { v: esc(a.glyph), v2: esc(a.name) })}<button class="link" data-open-thread="${esc(m.from.threadId)}">${_t('k1445')}</button></div>
        <div class="bubble">${esc(m.text.replace(/^【[^】]*】\s*/, ''))}</div></div>`;
    }
    const c = m.context;
    const ctxTxt = c ? (c.backtestName || c.backtestId ? `${_t('k0111')} ${c.backtestName || ''}` : c.projectName ? `${_t('k1446', { projectName: c.projectName })}` : c.projectId ? `${_t('k0108', { projectId: c.projectId })}` : '') : '';
    const long = m.text.length > 320;
    return `<div class="msg user"><div class="bubble ${long ? 'clamp' : ''}">${esc(m.text)}</div>${long ? _t('k1447') : ''}${ctxTxt || m.allowDanger ? `<div class="ctx-mini">${ctxTxt ? `<span>${_t('k1448', { v: esc(ctxTxt) })}</span>` : ''}${m.allowDanger ? _t('k1449') : ''}</div>` : ''}</div>`;
  }
  const a = agentOf(m.agent);
  return `<div class="msg ai" ${live ? 'data-live' : ''}><div class="who"><span class="g" style="--c:${a.color}">${esc(a.glyph)}</span><b>${esc(a.name)}</b></div><div class="body">${aiInner(m, live, last)}</div></div>`;
}

// 在项目 / 回测 / 模拟实盘页打开对话时，示例问题先给跟这一页有关的
function ctxStarters() {
  const c = S.ctxOff ? null : currentContext();
  if (!c) return [];
  if (c.backtestId) return [_t('ux028'), _t('ux029')];
  if (c.paperSessionId) return [_t('ux030')];
  if (c.jobId) return [_t('ux031')];
  return [_t('ux026'), _t('ux027')];
}
// 从页面上打开对话、还没开始聊时，按页面预选更合适的 agent（只替换默认的总控，不改用户自己选的）
function ctxAgent() {
  const r = S.route;
  if (r.view === 'backtest') return 'analyst';
  if (r.view === 'research') return 'researcher';
  if (r.view === 'project' && r.tab === 'code') return 'engineer';
  return null;
}
function introHTML(a) {
  return `<div class="intro"><div class="g" style="--c:${a.color}">${esc(a.glyph)}</div><h3>${esc(a.name)}</h3><p>${esc(a.role)}</p>
    <div class="starters">${[...ctxStarters(), ...(a.starters || [])].slice(0, 5).map((s) => `<button data-starter="${esc(s)}">${esc(s)}</button>`).join('')}</div></div>`;
}

const nearBottom = () => { const b = $('#messages'); return b.scrollHeight - b.scrollTop - b.clientHeight < 80; };
// 自动滚动：用户往上滚去看前面的内容后就不再被拉回底部（出现「回到最新」），滚回底部或点按钮后恢复
S.pinned = true;
function renderThread(opts = {}) {
  const box = $('#messages');
  $('#threadTitle').textContent = (S.thread && S.thread.title) || _t('k1450');
  const keepTop = box.scrollTop;
  const wasPinned = S.pinned;
  if (!S.thread || !S.thread.messages.length) { box.innerHTML = introHTML(agentOf(S.agentId)); S.pinned = true; updateComposer(); return; }
  const run = currentRunning();
  box.innerHTML = S.thread.messages.map((m, i) => msgHTML(m, run && i === S.thread.messages.length - 1 && m.role === 'assistant', !run && i === S.thread.messages.length - 1)).join('');
  unclampBubbles();
  if (opts.keep && !wasPinned) box.scrollTop = keepTop; else { box.scrollTop = box.scrollHeight; S.pinned = true; }
  updateComposer();
}
let liveRaf = 0;
function renderLive() {
  cancelAnimationFrame(liveRaf);
  liveRaf = requestAnimationFrame(() => {
    const el = $('#messages [data-live]');
    const m = S.thread && S.thread.messages[S.thread.messages.length - 1];
    if (!el || !m) { renderThread(); return; }
    const stick = S.pinned;
    el.querySelector('.body').innerHTML = aiInner(m, true);
    if (stick) $('#messages').scrollTop = $('#messages').scrollHeight;
    renderRunBar();
  });
}
// 运行状态条：谁在工作、做到哪一步、已用时、停止、（用户上滚时）回到最新
const tool_is_other = (tool) => Boolean(tool) && shortTool(tool.name) !== 'handoff'; // 正在跑的是别的工具时，步骤文字照旧
function renderRunBar() {
  const bar = $('#runBar');
  const run = currentRunning();
  // 这个对话交出去、还在运行的任务（对方的 run.from 指回本对话）
  const kids = S.thread ? [...S.running.entries()].filter(([, r]) => r.from && r.from.threadId === S.thread.id) : [];
  bar.hidden = !run && !kids.length;
  let kb = $('#rbKids');
  if (!kb) { kb = document.createElement('span'); kb.id = 'rbKids'; kb.className = 'rb-kids'; bar.insertBefore(kb, $('#jumpBtn')); }
  const kHTML = kids.slice(0, 3).map(([id, r]) => `<button type="button" class="linkish" data-open-thread="${esc(id)}">${_t('k1246', { v: esc(agentOf(r.agent).name) })}</button>`).join('');
  if (kb.innerHTML !== kHTML) kb.innerHTML = kHTML;
  $('#stopBtn').hidden = !run;
  if (!run) {
    // 自己已经说完（wait=false 交接），但对方还在做
    const names = [...new Set(kids.map(([, r]) => agentOf(r.agent).name))].join(_t('k0015'));
    const t0 = `${_t('k1451', { names })}`;
    if ($('#rbText').textContent !== t0) $('#rbText').textContent = t0;
    $('#rbTime').textContent = '';
    $('#jumpBtn').hidden = true;
    return;
  }
  const a = agentOf(S.thread.agent);
  const m = S.thread.messages[S.thread.messages.length - 1];
  const parts = (m && m.role === 'assistant' && m.parts) || [];
  const tool = [...parts].reverse().find((p) => p.kind === 'tool' && p.status === 'running' && shortTool(p.name) !== 'ToolSearch');
  const last = parts[parts.length - 1];
  const step = S.stopping === S.thread.id ? _t('k1452') : m && m.draft ? draftText(m.draft) : tool ? `${_t('k1453')}${TOOL_LABELS[shortTool(tool.name)] || shortTool(tool.name)}` : last && last.kind === 'text' ? _t('k1454') : _t('k1437');
  const waitNames = [...new Set(kids.map(([, r]) => agentOf(r.agent).name))].join(_t('k0015'));
  const waitAp = pendingApprovals(S.thread.id)[0];
  const waitQ = pendingQuestions(S.thread.id)[0];
  const txt = waitQ ? `${_t('k1455', { name: a.name })}` : waitAp ? `${_t('k1456', { name: a.name, title: waitAp.title })}` : kids.length && !tool_is_other(tool) ? `${_t('k1457', { name: a.name, waitNames })}` : `${_t('k1458', { name: a.name, step })}`;
  if ($('#rbText').textContent !== txt) $('#rbText').textContent = txt;
  const st = S.runStart && S.runStart.get(S.thread.id);
  $('#rbTime').textContent = st ? `${_t('k1459', { v: Math.max(0, Math.round((Date.now() - st) / 1000)) })}` : '';
  $('#jumpBtn').hidden = S.pinned;
  const sb = $('#stopBtn');
  sb.disabled = S.stopping === S.thread.id;
}

function currentContext() {
  const r = S.route;
  if (r.view === 'home') return null;
  const ctx = { view: r.view === 'project' ? _t('k1460') : r.view === 'research' ? _t('k1461') : r.view === 'paper' ? _t('k1462') : _t('k1463'), projectId: r.projectId };
  if (r.view === 'paper') { ctx.paperSessionId = r.sessionId; if (S.paper && S.paper.session) ctx.paperName = S.paper.session.name; }
  if (r.view === 'research') { ctx.jobId = r.jobId; if (S.rjob && S.rjob.jobId === r.jobId) ctx.jobTitle = S.rjob.title; }
  if (S.project && S.project.projectId === r.projectId) ctx.projectName = S.project.name;
  if (r.view === 'backtest') { ctx.backtestId = r.backtestId; if (S.backtest && S.backtest.name) ctx.backtestName = S.backtest.name; }
  if (r.tab) ctx.tab = r.tab;
  return ctx;
}
function renderCtx() {
  const ctx = currentContext();
  const row = $('#ctxRow');
  // 还没开始聊：示例问题跟着当前页面换
  if ((!S.thread || !S.thread.messages.length) && $('#messages')) $('#messages').innerHTML = introHTML(agentOf(S.agentId));
  if (!ctx) { row.innerHTML = ''; return; }
  const proj = ctx.projectName || `#${ctx.projectId}`;
  const label = ctx.paperSessionId ? `${proj} / ${ctx.paperName || _t('k0116')}` : ctx.backtestId ? `${proj} / ${ctx.backtestName || _t('k0111')}` : ctx.jobId ? `${proj} / ${ctx.jobTitle || _t('k0127')}` : proj;
  const what = [ctx.projectName || `#${ctx.projectId}`, ctx.backtestName || ctx.backtestId, ctx.paperName || ctx.paperSessionId, ctx.jobTitle || ctx.jobId, ctx.tab].filter(Boolean).join(' · ');
  row.innerHTML = `<div class="ctx-chip ${S.ctxOff ? 'off' : ''}" title="${esc(_t('ux032', { v: what }))}"><span class="lab">${S.ctxOff ? _t('k1464') : _t('k1465')}</span><span>${esc(label)}</span>
    <button type="button" data-ctx-toggle title="${S.ctxOff ? _t('k1466') : _t('k1467')}">${S.ctxOff ? '+' : '✕'}</button></div>`;
}

function updateComposer() {
  const run = currentRunning();
  $('#app').classList.toggle('busy', run);
  $('#sendBtn').title = run ? _t('k1468') : _t('k1469');
  $('#sendBtn').setAttribute('aria-label', run ? _t('k1468') : _t('k1470'));
  $('#sendBtn').disabled = Boolean(S.sending) && !run;
  const ib = $('#ideaSubmit'); if (ib) { ib.disabled = Boolean(S.sending); if (S.sending) ib.setAttribute('aria-busy', 'true'); else ib.removeAttribute('aria-busy'); }
  const asking = run && S.thread ? pendingQuestions(S.thread.id)[0] : null;
  $('#app').classList.toggle('asking', Boolean(asking));
  if (asking) { $('#sendBtn').title = _t('k1471'); $('#sendBtn').setAttribute('aria-label', _t('k1471')); }
  $('#input').placeholder = asking ? `${_t('k1472')}` : run ? `${_t('k1473', { name: agentOf(S.agentId).name })}` : `${_t('k1410', { name: agentOf(S.agentId).name })}`;
  renderRunBar();
}

// 返回 { ok, error }。opts.idea：来自首页想法框——不动聊天输入框，失败时由调用方保留文字并显示重试
async function send(text, opts = {}) {
  text = String(text || '').trim();
  if (!text) return { ok: false };
  if (!opts.idea && currentRunning()) { toast(_t('k1474')); return { ok: false }; }
  if (S.sending) return { ok: false };
  // claude 命令行不可用时，不发出去：文字原样留着，给出能照着做的说明（状态可能是旧的，先强制刷新一次）
  if (S.status && S.status.claude && S.status.claude.ok === false) await loadStatus(true);
  if (S.status && S.status.claude && S.status.claude.ok === false) {
    const why = _t('k1475');
    if (!opts.idea) toast(`${_t('k1476', { why })}`);
    return { ok: false, error: why };
  }
  // 首页想法框发出的消息不能用掉对话框里勾的「允许危险操作」
  const allowDanger = opts.allowDanger ?? (opts.idea ? false : $('#allowDanger').checked);
  if (!opts.idea) $('#allowDanger').checked = false;
  const ctx = opts.idea || S.ctxOff ? null : currentContext();
  const input = $('#input');
  if (!opts.idea) { input.value = ''; autosize(); }
  let r;
  S.sending = true;
  updateComposer();
  try {
    const model = (opts.idea ? S.ideaModel : S.model) || 'auto';
    const effort = (opts.idea ? S.ideaEffort : S.effort) || 'auto';
    r = await post('/api/chat', { threadId: opts.idea ? undefined : S.thread && S.thread.id, agent: opts.idea ? 'mia' : S.thread ? S.thread.agent : S.agentId, message: text, context: ctx, allowDanger, model, effort, lang: HELM_I18N.lang() });
  } catch (e) {
    if (!opts.idea) { toast(`${_t('k1477', { message: e.message })}`); if (!input.value) { input.value = text; autosize(); } }
    return { ok: false, error: e.message };
  } finally { S.sending = false; updateComposer(); }
  S.agentId = r.agent;
  store.set('agent', r.agent);
  if (!S.thread || S.thread.id !== r.threadId) S.thread = { id: r.threadId, title: r.title, agent: r.agent, messages: [] };
  S.thread.messages.push({ role: 'user', text, context: ctx, allowDanger }, { role: 'assistant', agent: r.agent, parts: [], requestedModel: r.model || null, effort: r.effort || null, auto: r.auto || null });
  store.set('thread', r.threadId);
  S.running.set(r.threadId, { agent: r.agent, title: r.title });
  (S.runStart = S.runStart || new Map()).set(r.threadId, Date.now());
  S.pinned = true;
  renderAgents();
  renderRuns();
  renderThread();
  subscribe(r.threadId);
  loadThreads();
  return { ok: true, threadId: r.threadId };
}

// 首页想法：每个想法一个新对话，可以连续提交多个并行处理。
// 失败（网络断了、页面令牌过期、服务没开）时文字原样留在想法框里，并在框下显示原因和「重试」。
async function submitIdea() {
  const box = $('#ideaInput');
  const idea = box ? box.value.trim() : '';
  if (!idea) { if (box) box.focus(); toast(_t('k1478')); return; }
  if (S.sending) return;
  setIdeaError(null);
  const before = new Set((S.projects || []).map((p) => p.projectId));
  const r = await send(ideaPrompt(idea, S.route2), { idea: true });
  if (r.ok) {
    if (r.threadId) S.ideaRuns.set(r.threadId, { before, threads: new Set([r.threadId]), error: null });
    if (S.ideaMiss) { S.ideaMiss = null; const m = $('#ideaMiss'); if (m) m.outerHTML = ideaMissHTML(); }
    store.set('ideaDraft', '');
    const b = $('#ideaInput'); if (b) b.value = '';
    openChat();
  } else if (r.error) {
    setIdeaError(r.error);
  }
}
function setIdeaError(msg) {
  S.ideaError = msg;
  const el = $('#ideaErr');
  if (el) el.outerHTML = ideaErrHTML();
}
let ideaErrHTML; _regT(() => { ideaErrHTML = () => (S.ideaError
  ? `<div class="error-box load-err idea-err" id="ideaErr" role="alert"><div>${_t('k1479', { v: esc(S.ideaError) })}</div><button type="button" class="btn sm" data-idea-retry>${_t('k0013')}</button></div>`
  : '<div id="ideaErr" hidden></div>'); });

// 首页想法交给团队后：总控和它交出去的对话都结束了、却没有新项目，就在想法框下面说一声，并给对话链接
S.ideaRuns = new Map(); // 根对话 id → { before: 提交前已有的项目, threads: 这一组对话, error }
const ideaRunOf = (threadId) => [...S.ideaRuns.entries()].find(([, x]) => x.threads.has(threadId)) || null;
async function ideaRunEnded(ev) {
  const hit = ideaRunOf(ev.threadId);
  if (!hit) return;
  const [root, x] = hit;
  if (ev.error && ev.threadId === root) x.error = ev.error;
  if ([...x.threads].some((id) => S.running.has(id))) return;
  S.ideaRuns.delete(root);
  await loadProjects();
  if ((S.projects || []).some((p) => !x.before.has(p.projectId))) return;
  S.ideaMiss = { threadId: root, error: Boolean(x.error) };
  const el = $('#ideaMiss'); if (el) el.outerHTML = ideaMissHTML();
}
const ideaMissHTML = () => (S.ideaMiss
  ? `<div class="attn-bar bad idea-miss" id="ideaMiss" role="status"><span>${S.ideaMiss.error ? _t('ux038') : _t('ux037')}</span><button type="button" class="linkish" data-open-thread="${esc(S.ideaMiss.threadId)}" data-idea-miss-x>${_t('ux039')}</button><span class="sp"></span><button type="button" class="linkish" data-idea-miss-x aria-label="${_t('ux041')}">✕</button></div>`
  : '<div id="ideaMiss" hidden></div>');

async function stop() {
  if (!S.thread || !S.thread.id) return;
  S.stopping = S.thread.id;
  renderRunBar();
  const r = await post('/api/chat/stop', { threadId: S.thread.id }).catch((e) => { S.stopping = null; toast(`${_t('k1480', { message: e.message })}`); renderRunBar(); return null; });
  if (r && !r.ok) { S.stopping = null; renderRunBar(); } // 服务器说没有在跑的任务
}

// 「展开全文」只给真的被截断的消息（按字数判断会误判：短行多的长消息其实已经显示全了）。对话框收着时量不到，打开时再量
function unclampBubbles() {
  for (const b of document.querySelectorAll('#messages .bubble.clamp')) {
    if (b.clientHeight > 0 && b.scrollHeight <= b.clientHeight + 2) { b.classList.remove('clamp'); const more = b.nextElementSibling; if (more && more.matches('[data-bubble-more]')) more.remove(); }
  }
}
function openChat() {
  requestAnimationFrame(unclampBubbles);
  $('#app').classList.add('chat-open');
  $('#chatToggle').setAttribute('aria-expanded', 'true');
}
function closeChat() { $('#app').classList.remove('chat-open'); $('#threadMenu').hidden = true; $('#chatToggle').setAttribute('aria-expanded', 'false'); }

// 页面上的“让 agent 做 X”按钮：同一 agent 且空闲就接着当前对话，否则开新对话（可以并行）
function askAgent(agentId, text) {
  if (!(S.thread && S.thread.agent === agentId && !currentRunning())) {
    closeSub();
    S.agentId = agentId;
    store.set('agent', agentId);
    S.thread = null;
    renderAgents();
    renderThread();
  }
  openChat();
  return send(text);
}

// 「重试」：按当前页面重新读取
function reloadView() {
  const v = S.route.view;
  loadStatus(true);
  loadProjects();
  if (v === 'project') { S.backtests = null; S.files = null; S.research = null; S.papers = null; loadProjectView(); }
  else if (v === 'backtest') loadBacktestView();
  else if (v === 'research') loadResearchView();
  else if (v === 'paper') loadPaperView();
  else { if (!Array.isArray(S.universes)) S.universes = null; renderMain(); loadUniverses(); }
}

/* ================= event bus ================= */
let refreshTimer = 0;
function refreshViews() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    loadProjects();
    if (S.route.view === 'project') { S.compileResult = null; loadProjectView(true); }
    if (S.route.view === 'backtest') loadBacktestView(true);
    if (S.route.view === 'research') loadResearchView(true);
    if (S.route.view === 'paper') loadPaperView(true);
    if (S.route.view === 'home') loadUniverses(true);
  }, 400);
}
// 用户 / agent 写的内容由服务端按界面语言翻译：译文到了（或换了语言）就把当前看到的数据重新取一遍
function refreshContent() {
  refreshViews();
  if (S.route.journal) loadJournal();
  if (S.route.page === 'pipeline') loadPipeline();
  if (S.route.data) loadDatasets();
  loadThreads();
  if (S.thread && S.thread.id && !S.running.has(S.thread.id) && !S.thread.running) {
    const box = document.querySelector('#messages'); const y = box ? box.scrollTop : null;
    openThread(S.thread.id, { quiet: true }).then(() => { const b = document.querySelector('#messages'); if (b && y != null) b.scrollTop = y; });
  }
}
function connectBus() {
  const es = new EventSource('/api/events');
  es.onmessage = (msg) => {
    let ev;
    try { ev = JSON.parse(msg.data); } catch { return; }
    if (ev.type === 'translations_updated') {
      clearTimeout(S.trTimer); S.trTimer = setTimeout(refreshContent, 300);
    } else if (ev.type === 'hello') {
      S.running = new Map(ev.running.map((r) => [r.threadId, { agent: r.agent, title: r.title, from: r.from || null }]));
    } else if (ev.type === 'run_start') {
      S.running.set(ev.threadId, { agent: ev.agent, title: ev.title, from: ev.from || null });
      const fam = ev.from && ideaRunOf(ev.from.threadId); if (fam) fam[1].threads.add(ev.threadId);
      if (ev.from && S.thread && ev.from.threadId === S.thread.id) renderLive(); // 交接卡片：对方开始了
      if (ev.from) {
        const src = agentOf(ev.from.agent);
        const dst = agentOf(ev.agent);
        toast(`${_t('k1481', { name: src.name, name2: dst.name, title: ev.title })}`, { label: `${_t('k1482', { name: dst.name })}`, run: () => openThread(ev.threadId) });
      }
      loadThreads();
    } else if (ev.type === 'run_end') {
      const gone = S.running.get(ev.threadId);
      S.running.delete(ev.threadId);
      if (gone && gone.from && S.thread && gone.from.threadId === S.thread.id) renderLive(); // 交接卡片：对方做完了
      if (S.stopping === ev.threadId) S.stopping = null;
      if (!S.thread || S.thread.id !== ev.threadId) {
        const a = agentOf(ev.agent);
        toast(`${a.name}${ev.error ? _t('k0132') : ev.stopped ? _t('k0659') : _t('k0759')}${_t('k1483', { title: ev.title })}`, { label: _t('k0129'), run: () => openThread(ev.threadId) });
      }
      ideaRunEnded(ev);
      loadThreads();
    } else if (ev.type === 'tool_done') {
      const short = shortTool(ev.name);
      if (MUTATING.has(short) && ev.status === 'done') {
        refreshViews();
        const pid = ev.input && ev.input.projectId;
        if (short === 'create_project') {
          const m = String(ev.result).match(/projectId=(\d+)/);
          if (m) toast(_t('k1484'), { label: _t('k1485'), run: () => { location.hash = `#/p/${m[1]}/code`; } });
        }
        if (short === 'create_backtest' && pid && S.route.projectId !== pid) {
          const m = String(ev.result).match(/backtestId=([a-f0-9]+)/);
          if (m) toast(_t('k1486'), { label: _t('k0129'), run: () => { location.hash = `#/p/${pid}/b/${m[1]}`; } });
        }
      }
    } else if (ev.type === 'project_renamed') {
      refreshViews();
    } else if (ev.type === 'project_deleted') {
      if (S.route.projectId === ev.projectId) location.hash = '#/';
      loadProjects();
    } else if (ev.type === 'backtest_started' || ev.type === 'project_created') {
      refreshViews();
    } else if (ev.type === 'research_started') {
      refreshViews();
      if (S.route.view === 'research') loadResearchView(true);
      if (S.route.projectId !== ev.projectId) toast(_t('k1487'), { label: _t('k0129'), run: () => { location.hash = `#/p/${ev.projectId}/r/${ev.jobId}`; } });
    } else if (ev.type === 'paper_started' || ev.type === 'paper_updated' || ev.type === 'paper_running') {
      if (S.route.view === 'paper' && S.route.sessionId === ev.sessionId) loadPaperView(true);
      else if (S.route.view === 'project' && S.route.projectId === ev.projectId) loadProjectView(true);
      if (ev.type === 'paper_updated' && ev.skipped && S.route.sessionId === ev.sessionId) toast(ev.skipReason ? `${_t('k1488', { skipReason: ev.skipReason })}` : `${_t('k1489', { dataDate: ev.dataDate })}`);
      if (ev.type === 'paper_updated' && ev.ok === false && S.route.sessionId !== ev.sessionId) toast(`${_t('k1490')}${ev.error || ''}`, { label: _t('k0129'), run: () => { location.hash = `#/p/${ev.projectId}/s/${ev.sessionId}`; } });
    } else if (ev.type === 'deck_updated') {
      if (window.HelmDecks) HelmDecks.onEvent(ev);
    } else if (ev.type === 'universe_started') {
      if (S.route.view === 'home') loadUniverses(true);
    } else if (ev.type === 'update_applied') {
      toast(ev.autoRestart ? _t('upd12', { v: ev.to }) : _t('upd13', { v: ev.to }), { sticky: !ev.autoRestart });
      if (settingsDlg) loadUpdate();
    } else if (ev.type === 'agents_changed') {
      reloadAgentList();
    } else if (ev.type === 'approval_request') {
      S.approvals.set(ev.approval.id, ev.approval);
      onApprovalsChanged();
      const a = agentOf(ev.approval.agent);
      if (!(S.thread && S.thread.id === ev.approval.threadId && $('#app').classList.contains('chat-open'))) {
        toast(`${_t('k1491', { name: a.name, title: ev.approval.title })}`, { label: _t('k1492'), run: () => openThread(ev.approval.threadId), sticky: true });
      }
    } else if (ev.type === 'question_request') {
      S.questions.set(ev.question.id, ev.question);
      onApprovalsChanged();
      if (!(S.thread && S.thread.id === ev.question.threadId && $('#app').classList.contains('chat-open'))) {
        toast(`${_t('k1493', { name: agentOf(ev.question.agent).name, n: ev.question.questions.length })}`, { label: _t('k1494'), run: () => openThread(ev.question.threadId), sticky: true });
      }
    } else if (ev.type === 'question_settled') {
      const x = S.questions.get(ev.id); if (x) x.state = ev.state;
      onApprovalsChanged();
    } else if (ev.type === 'approval_settled') {
      const x = S.approvals.get(ev.id); if (x) x.state = ev.state;
      onApprovalsChanged();
    } else if (ev.type === 'changes_updated') {
      if (S.route.page === 'agents' && S.route.agentsView === 'changes') loadChanges().then(() => renderMain());
      refreshRestart();
    }
    // 流水线和 Agents 页跟着实时刷新：谁开始、谁交给谁、谁做完、工具做完了什么
    if (['hello', 'run_start', 'run_end', 'tool_done', 'handoff_draft', 'project_created', 'project_deleted', 'backtest_started', 'research_started', 'paper_updated'].includes(ev.type)) {
      refreshPipelineSoon();
      if (ev.type !== 'tool_done' && ev.type !== 'handoff_draft') refreshAgentsSoon();
    }
    renderAgents();
    renderRuns();
    if (!$('#threadMenu').hidden) renderThreadMenu();
    updateComposer();
  };
}

/* ================= 右键菜单（组件在 ctxmenu.js） ================= */
// 只给「一行代表一个东西」的地方加：项目（首页表格、侧栏）、回测行、想法检验行。
// 菜单里只放已有的操作（不造新功能）；需要再确认或会填进对话框的，名字后面带「…」（macOS 惯例）。
// 让智能体做事：只把请求填进对话框，不自动发送——右键容易误点。
const ELL = '…';
function ctxCopy(text, label) {
  copyText(text).then((ok) => toast(ok ? _t('cx_copied', { v: label || text }) : _t('cx_copyFail')));
}
// 先切到那个项目（对话会带上当前项目），等页面换好再填对话框
function inProject(pid, fn) {
  if (S.route.projectId === pid && S.route.view === 'project') { fn(); return; }
  addEventListener('hashchange', () => setTimeout(fn, 0), { once: true });
  location.hash = `#/p/${pid}`;
}
function projCtx(pid) {
  const p = (S.projects || []).find((x) => x.projectId === pid);
  const st = p ? projStage(p) : null;
  const here = S.route.projectId === pid && S.route.view === 'project' && isOverview(S.route.tab);
  const ask = (agent, text) => () => inProject(pid, () => prefillChat(agent, text));
  const nx = st && st.step > 0 ? st.next : null;
  return [
    here ? null : { label: _t('cx_open'), hint: '↵', run: () => { location.hash = `#/p/${pid}`; } },
    nx ? { label: nx.ask ? `${nx.t}${ELL}` : nx.t, run: nx.ask ? ask(nx.ask, IDEA_ASK) : () => { location.hash = nx.href; } } : null,
    'sep',
    { label: _t('cx_ask'), sub: [
      { label: `${_t('k0141')}${ELL}`, title: _t('k0142'), run: ask('researcher', IDEA_ASK) },
      { label: `${_t('k0143')}${ELL}`, title: _t('k0144'), run: ask('engineer', _t('k0145')) },
      { label: `${_t('k0146')}${ELL}`, title: _t('k0147'), run: ask('engineer', _t('k0148')) },
      { label: `${_t('k0149')}${ELL}`, title: _t('k0150'), run: ask('analyst', _t('k0151')) },
      { label: `${_t('k0152')}${ELL}`, title: _t('k0153'), run: ask('risk', _t('k0154')) },
    ] },
    'sep',
    { label: `${_t('pr_rename')}${ELL}`, run: () => doAction('project-rename', { pid }) },
    { label: _t('cx_copyId'), run: () => ctxCopy(`#${pid}`) },
    'sep',
    { label: `${_t('k0172')}${ELL}`, danger: true, run: () => doAction('project-delete', { pid }) },
  ];
}
async function tagBacktest(projectId, backtestId, role) {
  const r = await safePost('/api/actions/backtest-tag', { projectId, backtestId, role: role || null });
  if (!r.success) { toast(`${_t('k1553')}${(r.errors || []).join('; ')}`); return; }
  loadProjectView(true);
}
function btCtx(pid, bid) {
  const b = Array.isArray(S.backtests) && S.backtests.find((x) => x.backtestId === bid);
  if (!b) return null;
  const inCmp = S.cmpSel.includes(bid);
  const canMain = b.role !== 'main' && b.role !== 'benchmark' && !b.ranAsBenchmark && doneBt(b);
  return [
    { label: _t('cx_open'), hint: '↵', run: () => { location.hash = `#/p/${pid}/b/${bid}`; } },
    { label: _t('cx_cmp'), checked: inCmp, disabled: !inCmp && S.cmpSel.length >= CMP_MAX, title: !inCmp && S.cmpSel.length >= CMP_MAX ? _t('k0419', { CMP_MAX }) : '',
      run: () => { S.cmpSel = inCmp ? S.cmpSel.filter((x) => x !== bid) : [...S.cmpSel, bid]; renderMain(); } },
    'sep',
    canMain ? { label: _t('k0188'), run: () => doAction('set-main', { pid, bid }) } : null,
    // 「主版本」不放进子菜单：上面已经有「设为主版本」，同一个操作只出现一次
    { label: _t('cx_tag'), sub: [...['candidate', 'control', 'ablation', 'benchmark', 'debug'].map((k) => ({ label: ROLE_META[k][0], checked: b.role === k, run: () => tagBacktest(pid, bid, k) })),
      'sep', { label: _t('k0185'), checked: !b.role, run: () => tagBacktest(pid, bid, null) }] },
    'sep',
    { label: `${_t('cx_diag')}${ELL}`, run: () => prefillChat('analyst', _t('cx_diagT', { backtestId: bid, name: b.name || '' })) },
    'sep',
    { label: _t('cx_copyBt'), run: () => ctxCopy(bid) },
  ];
}
function jobCtx(pid, jobId) {
  const j = Array.isArray(S.research) && S.research.find((x) => x.jobId === jobId);
  if (!j) return null;
  return [
    { label: _t('cx_open'), hint: '↵', run: () => { location.hash = `#/p/${pid}/r/${jobId}`; } },
    j.status === 'complete' ? { label: `${_t('cx_read')}${ELL}`, run: () => prefillChat('researcher', _t('k0825', { jobId, projectId: pid })) } : null,
    'sep',
    { label: _t('cx_copyJob'), run: () => ctxCopy(jobId) },
  ];
}
// 被右键的是什么：返回 { el: 要描边的元素, items }
function ctxHit(node) {
  if (!node || !node.closest) return null;
  const pr = node.closest('table.home-proj tr[data-href^="#/p/"], #projectList a[href^="#/p/"]');
  if (pr) { const pid = Number((pr.dataset.href || pr.getAttribute('href')).split('/')[2]); return pid ? { el: pr, items: projCtx(pid) } : null; }
  const bt = node.closest('tr[data-href*="/b/"]');
  if (bt) { const [, , pid, , bid] = bt.dataset.href.split('/'); const items = btCtx(Number(pid), bid); return items ? { el: bt, items } : null; }
  const rj = node.closest('a.rl-row[href*="/r/"]');
  if (rj) { const [, , pid, , jobId] = rj.getAttribute('href').split('/'); const items = jobCtx(Number(pid), jobId); return items ? { el: rj, items } : null; }
  return null;
}
document.addEventListener('contextmenu', (e) => {
  if (e.shiftKey || !window.HelmCtx) return; // 按住 Shift 右键：保留系统菜单（查元素、调试用）
  if (e.target.closest && e.target.closest('input, textarea, [contenteditable="true"]')) return;
  const hit = ctxHit(e.target);
  if (!hit) { HelmCtx.close(); return; }
  e.preventDefault();
  const items = hit.items.slice();
  // 选中了这一行里的文字：第一项给「拷贝」，免得右键把系统的拷贝弄没了
  const sel = String(getSelection() || '').trim();
  if (sel && hit.el.contains(getSelection().anchorNode)) items.unshift({ label: _t('cx_copy'), hint: `${MOD_KEY.trim()}C`, run: () => ctxCopy(sel, sel.length > 24 ? `${sel.slice(0, 24)}…` : sel) }, 'sep');
  // 键盘打开（Shift+F10 / 菜单键）：没有鼠标坐标，贴着那一行弹出并高亮第一项
  const kb = !e.clientX && !e.clientY;
  HelmCtx.open(items, kb ? { anchor: hit.el } : { x: e.clientX, y: e.clientY }, { target: hit.el });
});

/* ================= project actions（不经过 AI） ================= */
async function doAction(kind, ds = {}) {
  const projectId = Number(ds.pid) || S.route.projectId; // 右键菜单可以对别的项目操作（首页、侧栏）
  if (!projectId) return;
  if (kind === 'compile') {
    toast(_t('k1495'));
    const r = await safePost('/api/actions/compile', { projectId });
    S.compileResult = r.success ? r : { state: 'BuildError', logs: r.errors };
    if (S.route.view === 'project') { location.hash = `#/p/${projectId}/code`; renderMain(); }
    toast(S.compileResult.state === 'BuildSuccess' ? _t('k1496') : _t('k1497'));
  }
  if (kind === 'backtest') { toggleMenu($('#runMenu'), ds.kb === '1'); return; }
  if (kind === 'project-delete') {
    const pp = (S.projects || []).find((x) => x.projectId === projectId);
    const name = (S.project && S.project.projectId === projectId && pName(S.project)) || (pp && pName(pp)) || `#${projectId}`;
    if (!(await askConfirm({ title: _t('k0172'), message: `${_t('k1498', { name })}`, ok: _t('k0600'), danger: true }))) return;
    const r = await safePost('/api/actions/project-delete', { projectId });
    if (!r.success) { toast((r.errors || [_t('x011')]).join(_t('k0007'))); return; }
    toast(_t('k1499'));
    location.hash = '#/';
    await loadProjects();
    return;
  }
  if (kind === 'project-rename') { openRenameModal(projectId); return; }
  if (kind === 'research') { openResearchModal(); return; }
  if (kind === 'paper-new') { openPaperModal(); return; }
  if (kind === 'set-main') {
    const backtestId = (ds && ds.bid) || S.route.backtestId;
    const r = await safePost('/api/actions/backtest-main', { projectId, backtestId });
    if (!r.success) { toast(`${_t('k1500')}${(r.errors || []).join(_t('k0007'))}`); return; }
    toast(_t('k1501'));
    if (S.route.view === 'backtest') loadBacktestView(true); else loadProjectView(true);
    return;
  }
  if (kind === 'paper-stop' || kind === 'paper-run') {
    const sessionId = S.route.sessionId;
    if (kind === 'paper-stop' && !(await askConfirm({ title: _t('k1502'), message: S.paper && S.paper.session.mode === 'alpaca' ? _t('k1503') : _t('k1504'), ok: _t('k1140'), danger: true }))) return;
    const r = await safePost(`/api/actions/${kind}`, { projectId, sessionId });
    if (!r.success) toast(`${kind === 'paper-run' ? _t('k0916') : _t('k1140')}${_t('k1505')}${(r.errors || []).join('; ')}`);
    else toast(kind === 'paper-run' ? _t('k1506') : r.note || _t('k0659'));
    loadPaperView(true);
    return;
  }
  if (kind.startsWith('research-')) {
    const jobId = S.route.jobId;
    const fail = (r) => toast(`${_t('k1505')}${(r.errors || [r.error || _t('k0097')]).join('; ')}`);
    let r;
    if (kind === 'research-stop') r = await safePost('/api/actions/research-stop', { projectId, jobId });
    if (kind === 'research-resume' || kind === 'research-full') r = await safePost('/api/actions/research-resume', { projectId, jobId, full: kind === 'research-full' });
    if (kind === 'research-signals') {
      toast(_t('k1507'));
      r = await safePost('/api/actions/signals', { projectId, jobId, ideaFactor: ds.factor || undefined });
      if (r.success) toast(`${_t('k1508', { name: r.signals.name, rows: r.signals.rows, tickers: r.signals.tickers, name2: r.signals.name })}`);
    }
    if (r && !r.success) fail(r);
    loadResearchView(true);
  }
  if (kind === 'backtest-run') {
    toast(_t('k1509'));
    const r = await safePost('/api/actions/backtest', { projectId, ...S.runSpec });
    if (!r.success) { toast(`${_t('k1510')}${(r.errors || []).join('; ')}`); return; }
    if (!r.backtest) {
      S.compileResult = r.compile;
      location.hash = `#/p/${projectId}/code`;
      renderMain();
      toast(_t('k1511'));
      return;
    }
    location.hash = `#/p/${projectId}/b/${r.backtest.backtestId}`;
  }
}

// 首页一句话 → 发给总控的完整指令。三种路线共用同一套收尾：统计检验、一个项目、表格对比
function ideaPrompt(idea, route) {
  const common = [
    _t('k1512'),
    _t('k1513'),
    _t('k1514'),
  ];
  const spec = _t('k1515');
  const lean = _t('k1516');
  const qlibIdea = _t('k1517');
  const qlibScan = _t('k1518');
  const qlibFull = _t('k1519');
  let steps;
  if (route === 'fast') {
    steps = [`${_t('k1520', { spec })}`, lean];
  } else if (route === 'deep') {
    steps = [`${_t('k1521', { spec })}`,
      `${_t('k1522', { qlibIdea, qlibFull })}`, `${_t('k1523', { lean })}`];
  } else {
    steps = [`${_t('k1524', { spec })}`,
      `${_t('k1525', { qlibIdea })}`,
      `${_t('k1526', { lean })}`];
  }
  const all = [...steps, ...common];
  return `${_t('k1527', { idea })}${all.map((x, i) => `${i + 1}. ${x}`).join('\n')}`;
}

function openResearchModal() {
  const d = $('#researchModal');
  if (!d) return;
  $('#rmTitle').value = '';
  d.showModal();
}
async function submitResearch() {
  const target = $('#rmTarget').value;
  const body = {
    projectId: S.route.projectId,
    target,
    title: $('#rmTitle').value.trim() || undefined,
    features: (document.querySelector('input[name=rmFeat]:checked') || {}).value || 'alpha158',
    mode: (document.querySelector('input[name=rmMode]:checked') || {}).value || 'factors',
    neutralize: $('#rmSector').checked ? 'sector' : 'none',
    advanced: $('#rmTra').checked ? 'auto' : 'off',
    start: $('#rmStart').value || '2008-01-01',
  };
  if (target === 'custom') body.tickers = $('#rmTickers').value.split(/[\s,，]+/).filter(Boolean);
  if (target === 'custom' && body.tickers.length < 5) { toast(_t('k1528')); $('#rmTickers').focus(); return; }
  const r = await once('research-start', $('#rmStartBtn'), () => safePost('/api/actions/research', body));
  if (!r) return;
  if (!r.success) { toast(`${_t('k1216')}${(r.errors || []).join('; ')}`); return; }
  $('#researchModal').close();
  location.hash = `#/p/${S.route.projectId}/r/${r.job.jobId}`;
}

function openProjectModal() {
  const d = $('#projectModal');
  $('#pmName').value = '';
  $('#pmDesc').value = '';
  $('#pmNameErr').hidden = true;
  $('#pmName').removeAttribute('aria-invalid');
  d.showModal();
  $('#pmName').focus();
}

// 项目改名（项目页 ⋯ 菜单、侧栏/首页右键、Mac 菜单「项目 → 重命名…」）：回车确认，Esc 取消，空名不能提交。
// 服务端把名字写进 name 和当前界面语言的 nameZh / nameEn（pName 优先显示后者），这里先就地更新，再等 project_renamed 广播刷新
function openRenameModal(projectId) {
  const p = (S.project && S.project.projectId === projectId ? S.project : null) || (S.projects || []).find((x) => x.projectId === projectId);
  const cur = p ? pName(p) : '';
  const prevFocus = document.activeElement;
  const id = `rn${Date.now().toString(36)}`;
  let busy = false;
  const { d, close } = openModal({
    cls: 'rename-dlg', labelId: `${id}t`,
    html: `<form class="cd-body" novalidate><h2 id="${id}t">${_t('pr_title')}</h2>
      <label class="field"><span>${_t('h033')}</span><input name="name" maxlength="120" autocomplete="off" spellcheck="false" value="${esc(cur)}" aria-describedby="${id}e"><span class="field-err" id="${id}e" role="alert" hidden></span></label>
      <div class="modal-actions"><button type="button" class="btn" data-rn="no">${_t('k0033')}</button><button type="submit" class="btn primary" data-rn="yes">${_t('pr_save')}</button></div></form>`,
    onClick: (e, cl) => { if (e.target.closest('[data-rn=no]')) cl(false); },
    onClose: () => setTimeout(() => { if (prevFocus && prevFocus.isConnected && prevFocus.focus) { try { prevFocus.focus({ preventScroll: true }); } catch { /* 忽略 */ } } }, 30),
  });
  const inp = d.querySelector('input');
  const err = d.querySelector('.field-err');
  const ok = d.querySelector('[data-rn=yes]');
  const showErr = (msg) => { err.textContent = msg; err.hidden = false; inp.setAttribute('aria-invalid', 'true'); };
  const sync = () => { const empty = !inp.value.trim(); ok.disabled = empty || busy; if (!empty) { err.hidden = true; inp.removeAttribute('aria-invalid'); } };
  inp.addEventListener('input', sync);
  d.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const name = inp.value.replace(/\s+/g, ' ').trim();
    if (!name) { showErr(_t('pr_empty')); inp.focus(); return; }
    if (name === cur) { close(false); return; }
    busy = true; sync();
    const r = await safePost('/api/actions/project-rename', { projectId, name, lang: HELM_I18N.lang() });
    busy = false; sync();
    if (!r.success) { showErr(zhErr((r.errors || [_t('x011')]).join(_t('k0007')))); inp.focus(); return; }
    const np = r.projects[0];
    for (const x of [S.project, ...(S.projects || [])]) {
      if (!x || x.projectId !== projectId) continue;
      for (const k of ['name', 'nameEn', 'nameZh', 'modified']) { if (np[k] === undefined) delete x[k]; else x[k] = np[k]; }
    }
    close(true);
    renderProjects();
    renderCrumbs();
    if (S.route.projectId === projectId && S.route.view === 'project') renderMain();
    if (onHomePage()) renderHomeSoon();
    toast(_t('pr_done'));
  });
  sync();
  inp.focus();
  inp.select();
}

/* ================= toast ================= */
function toast(text, action) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${esc(zhErr(text))}</span>${action ? `<button class="btn sm">${esc(action.label)}</button>` : ''}<button class="t-x" aria-label="${_t('k0029')}">✕</button>`;
  if (action) el.querySelector('.btn').onclick = () => { el.remove(); action.run(); };
  el.querySelector('.t-x').onclick = () => el.remove();
  const box = $('#toasts');
  box.appendChild(el);
  while (box.children.length > 4) box.firstChild.remove();
  if (!(action && action.sticky)) setTimeout(() => el.remove(), action ? 10000 : 3500);
}

/* ================= run options ================= */
function renderRunOpts() {
  const { models, efforts } = S.options;
  const ms = $('#modelSel');
  const es = $('#effortSel');
  ms.innerHTML = `<option value="auto">${esc(_t('am_autoModel'))}</option>` + models.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('');
  es.innerHTML = `<option value="auto">${esc(_t('am_autoEffort'))}</option>` + efforts.map((e) => `<option value="${esc(e.id)}">${_t('k1441', { v: esc(e.label) })}</option>`).join('');
  if (!models.some((m) => m.id === S.model)) S.model = 'auto';
  if (!efforts.some((e) => e.id === S.effort)) S.effort = 'auto';
  if (!models.some((m) => m.id === S.ideaModel)) S.ideaModel = 'auto';
  if (!efforts.some((e) => e.id === S.ideaEffort)) S.ideaEffort = 'auto';
  ms.value = S.model;
  es.value = S.effort;
  ms.closest('.opt').classList.add('set');
  es.closest('.opt').classList.add('set');
  const mSel = models.find((m) => m.id === S.model);
  const eSel = efforts.find((e) => e.id === S.effort);
  ms.closest('.opt').title = S.model === 'auto' ? _t('am_autoTip') : mSel ? `${_t('k1533', { label: mSel.label, desc: mSel.desc })}` : _t('k1534');
  es.closest('.opt').title = S.effort === 'auto' ? _t('am_autoTip') : eSel ? `${_t('k1535', { label: eSel.label, desc: eSel.desc })}` : _t('k1536');
}

/* ================= wiring ================= */
function autosize() {
  const t = $('#input');
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 200)}px`;
}

let jrTimer = 0;
function wire() {
  const app = $('#app');
  $('#chatToggle').onclick = () => {
    if (app.classList.contains('chat-open')) closeChat();
    else {
      const pick = ctxAgent();
      if (pick && !S.thread && S.agentId === 'mia' && S.agents.some((a) => a.id === pick)) { S.agentId = pick; renderAgents(); renderThread(); }
      openChat(); setTimeout(() => $('#input').focus(), 30);
    }
  };
  $('#chatClose').onclick = closeChat;
  $('#brandBtn').onclick = () => { if (narrow()) app.classList.toggle('side-open'); else app.classList.toggle('side-hidden'); };
  $('#menuBtn').onclick = () => { app.classList.toggle('side-open'); if (app.classList.contains('side-open')) { const f = $('#sidebar a, #sidebar button'); if (f) f.focus(); } };
  // 抽屉打开时：菜单按钮的状态跟着变，窄屏下主区域不可操作（键盘 Tab 不会钻到抽屉后面）
  new MutationObserver(() => {
    const open = app.classList.contains('side-open');
    $('#menuBtn').setAttribute('aria-expanded', String(open));
    $('#menuBtn').setAttribute('aria-label', open ? _t('k1537') : _t('k1538'));
    $('#main').inert = open && narrow();
  }).observe(app, { attributes: true, attributeFilter: ['class'] });
  $('#scrim').onclick = () => { closeChat(); app.classList.remove('side-open'); };
  $('#refreshProjects').onclick = loadProjects;
  $('#projectSearch').oninput = renderProjects;
  $('#newThread').onclick = newThreadUI;
  $('#newProjectBtn').onclick = openProjectModal;
  $('#pmCancel').onclick = () => $('#projectModal').close();
  $('#rmCancel').onclick = () => $('#researchModal').close();
  $('#ppCancel').onclick = () => $('#paperModal').close();
  $('#ppSim').onchange = renderPaperModal;
  $('#ppAlpaca').onchange = renderPaperModal;
  $('#aiModal').addEventListener('close', () => renderSettings('ai'));
  $('#aiCancel').onclick = () => $('#aiModal').close();
  $('#aiTest').onclick = testAiUI;
  for (const r of document.querySelectorAll('#aiForm input[name="aiMode"]')) r.onchange = renderAiModal;
  $('#aiUrl').oninput = renderAiModal;
  $('#aiForm').addEventListener('submit', (e) => { e.preventDefault(); saveAiUI(); });
  $('#paperForm').addEventListener('submit', (e) => { e.preventDefault(); submitPaper(); });
  $('#rmTarget').onchange = () => { $('#rmTickersWrap').hidden = $('#rmTarget').value !== 'custom'; };
  $('#researchForm').addEventListener('submit', (e) => { e.preventDefault(); submitResearch(); });
  $('#pmName').addEventListener('input', () => { if ($('#pmName').value.trim().length >= 2) { $('#pmNameErr').hidden = true; $('#pmName').removeAttribute('aria-invalid'); } });
  $('#projectForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#pmName').value.trim();
    const bad = name.length < 2;
    $('#pmNameErr').hidden = !bad;
    $('#pmName').setAttribute('aria-invalid', String(bad));
    if (bad) { $('#pmName').focus(); return; }
    const tpl = (document.querySelector('input[name=tpl]:checked') || {}).value;
    const r = await once('project-create', $('#pmCreate'), () => safePost('/api/actions/project', { name, description: $('#pmDesc').value.trim(), template: tpl }));
    if (!r) return;
    if (!r.success) { toast(`${_t('k1539')}${(r.errors || []).join('; ')}`); return; }
    $('#projectModal').close();
    await loadProjects();
    location.hash = `#/p/${r.projects[0].projectId}/code`;
  });

  $('#threadBtn').onclick = (e) => {
    e.stopPropagation();
    const m = $('#threadMenu');
    m.hidden = !m.hidden;
    if (!m.hidden) { renderThreadMenu(); loadThreads(); }
  };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#threadMenu')) $('#threadMenu').hidden = true;
    if (!e.target.closest('#runs')) { const rm = $('#runsMenu'); if (rm) rm.hidden = true; }
  });
  $('#threadMenu').addEventListener('click', async (e) => {
    e.stopPropagation();
    const del = e.target.closest('[data-del]');
    if (del) {
      if (!(await askConfirm({ title: _t('k1540'), message: _t('k1541'), ok: _t('k0600'), danger: true }))) return;
      const deleted = await api(`/api/threads/${encodeURIComponent(del.dataset.del)}`, { method: 'DELETE' }).then(() => true, (err) => { toast(`${_t('k1542', { message: err.message })}`); return false; });
      if (!deleted) return; // 没删掉（比如对话正在运行）：不要把当前对话清掉
      if (S.thread && S.thread.id === del.dataset.del) newThreadUI();
      loadThreads();
      return;
    }
    const item = e.target.closest('[data-thread]');
    if (item) { $('#threadMenu').hidden = true; openThread(item.dataset.thread); }
  });

  $('#agentRow').addEventListener('click', (e) => { const b = e.target.closest('[data-agent]'); if (b) selectAgent(b.dataset.agent); });

  $('#messages').addEventListener('scroll', () => {
    const p = nearBottom();
    if (p !== S.pinned) { S.pinned = p; if (!$('#runBar').hidden) $('#jumpBtn').hidden = p; }
  }, { passive: true });
  $('#jumpBtn').onclick = () => { const b = $('#messages'); S.pinned = true; b.scrollTop = b.scrollHeight; $('#jumpBtn').hidden = true; };
  $('#stopBtn').onclick = stop;
  setInterval(() => { if (!$('#runBar').hidden) renderRunBar(); }, 1000);
  $('#messages').addEventListener('click', (e) => {
    const s = e.target.closest('[data-starter]');
    if (s) { send(s.dataset.starter); return; }
    if (e.target.closest('[data-retry-danger]')) {
      const lastUser = [...(S.thread?.messages || [])].reverse().find((m) => m.role === 'user');
      if (lastUser) send(lastUser.text, { allowDanger: true });
    }
    if (e.target.closest('[data-retry-last]')) {
      const lastUser = [...(S.thread?.messages || [])].reverse().find((m) => m.role === 'user');
      if (lastUser) send(lastUser.text);
    }
  });
  $('#messages').addEventListener('toggle', (e) => {
    const d = e.target.closest && e.target.closest('details[data-tid]');
    if (!d) return;
    if (d.open) S.openTools.add(d.dataset.tid); else S.openTools.delete(d.dataset.tid);
  }, true);

  $('#ctxRow').addEventListener('click', (e) => { if (e.target.closest('[data-ctx-toggle]')) { S.ctxOff = !S.ctxOff; renderCtx(); } });
  $('#modelSel').addEventListener('change', (e) => { S.model = e.target.value; store.set('model', S.model); renderRunOpts(); });
  $('#effortSel').addEventListener('change', (e) => { S.effort = e.target.value; store.set('effort', S.effort); renderRunOpts(); });

  $('#main').addEventListener('submit', (e) => {
    if (e.target.id !== 'ideaForm') return;
    e.preventDefault();
    submitIdea();
  });
  $('#main').addEventListener('toggle', (e) => { if (e.target.matches && e.target.matches('details.health-d')) S.healthClosed = !e.target.open; }, true);
  // 代码编辑框：Tab 插入 4 个空格（Python 缩进），Shift+Tab 照常移走焦点
  $('#main').addEventListener('keydown', (e) => {
    if (e.target.id !== 'codeEditor' || e.key !== 'Tab' || e.shiftKey) return;
    e.preventDefault();
    e.target.setRangeText('    ', e.target.selectionStart, e.target.selectionEnd, 'end');
    e.target.dispatchEvent(new Event('input', { bubbles: true }));
  });
  $('#main').addEventListener('input', (e) => {
    if (e.target.id === 'ideaInput') store.set('ideaDraft', e.target.value);
    if (e.target.id === 'codeEditor' && S.codeEdit) { S.codeEdit.draft = e.target.value; S.codeEdit.dirty = true; }
    if (e.target.id === 'jrQ' && S.journal) {
      S.journal.q = e.target.value;
      clearTimeout(jrTimer);
      jrTimer = setTimeout(() => {
        const body = $('#jrBody');
        if (!body || !S.journal || !S.journal.data) return;
        const rows = journalFiltered();
        body.innerHTML = journalRowsHTML(rows);
        body.querySelectorAll('tr[data-href]').forEach((tr) => { tr.tabIndex = 0; tr.setAttribute('role', 'link'); });
        const c = $('#jrCount'); if (c) c.textContent = `${_t('k1543', { n: rows.length, n2: S.journal.data.entries.length })}`;
      }, 120);
    }
  });
  $('#main').addEventListener('change', (e) => {
    const k = { jrProject: 'project', jrStage: 'stage', jrOutcome: 'outcome' }[e.target.id];
    if (k && S.journal) { S.journal[k] = e.target.value; renderMain(); const sel = $('#' + e.target.id); if (sel) sel.focus({ preventScroll: true }); }
    // 首页想法框的模型 / 思考深度：只改这一块，不重画整页（输入框里的字和焦点要保留）
    const io = { ideaModelSel: ['ideaModel', 'ideaModel'], ideaEffortSel: ['ideaEffort', 'ideaEffort'] }[e.target.id];
    if (io) {
      S[io[0]] = e.target.value; store.set(io[1], e.target.value);
      const box = e.target.closest('.idea-opts'); const id = e.target.id;
      if (box) { box.outerHTML = ideaOptsHTML(); const sel = $('#' + id); if (sel) sel.focus({ preventScroll: true }); }
    }
  });
  $('#main').addEventListener('keydown', (e) => {
    if (e.target.id === 'ideaInput' && e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) { e.preventDefault(); $('#ideaForm').requestSubmit(); }
    // 可点击的表格行：回车打开
    if (e.key === 'Enter' && e.target.matches && e.target.matches('tr[data-href]')) { e.preventDefault(); location.hash = e.target.dataset.href; }
  });
  // 对话列表项是 role=button：回车/空格打开
  $('#threadMenu').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-thread]')) { e.preventDefault(); e.target.click(); }
  });
  // 点对话框外面的遮罩关闭（Esc 浏览器自带）
  document.querySelectorAll('dialog.modal').forEach((d) => d.addEventListener('mousedown', (e) => { if (e.target === d) d.close(); }));

  const askingNow = () => (currentRunning() && S.thread ? pendingQuestions(S.thread.id)[0] : null);
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = askingNow();
    if (q && $('#input').value.trim()) { answerQuestion(q.id, { freeText: $('#input').value }); return; }
    if (currentRunning()) stop(); else send($('#input').value);
  });
  const input = $('#input');
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      const q = askingNow();
      if (q) { if (input.value.trim()) answerQuestion(q.id, { freeText: input.value }); return; }
      if (!currentRunning()) send(input.value);
    }
  });

  document.addEventListener('click', async (e) => {
    const cc = e.target.closest('[data-copy-code]');
    if (cc) {
      const code = cc.parentElement.querySelector('code');
      copyText(code ? code.textContent : '').then((ok) => { cc.textContent = ok ? _t('k1544') : _t('k1545'); setTimeout(() => { cc.textContent = _t('k1416'); }, 1600); });
      return;
    }
    if (e.target.closest('[data-ai-open]')) { openAiModal(); return; }
    if (e.target.closest('[data-refresh]')) { loadStatus(true); loadProjects(); return; }
    if (e.target.closest('[data-reload]')) { reloadView(); return; }
    if (e.target.closest('[data-clear-search]')) { const si = $('#projectSearch'); si.value = ''; renderProjects(); si.focus(); return; }
    const hr = e.target.closest('[data-health-refresh]');
    if (hr) { once('health', hr, recheckHealth); return; }
    const ex = e.target.closest('[data-example]');
    if (ex) { const t = $('#ideaInput'); if (t) { t.value = ex.dataset.example; store.set('ideaDraft', t.value); t.focus(); t.setSelectionRange(t.value.length, t.value.length); } return; }
    if (e.target.closest('[data-idea-retry]')) { const f = $('#ideaForm'); if (f) f.requestSubmit(); return; }
    if (e.target.closest('#runsBtn')) { const rm = $('#runsMenu'); rm.hidden = !rm.hidden; return; }
    const ot = e.target.closest('[data-open-thread]');
    if (ot) { const rm = $('#runsMenu'); if (rm) rm.hidden = true; openThread(ot.dataset.openThread); return; }
    if (e.target.closest('[data-new-project]')) { openProjectModal(); return; }
    const r2 = e.target.closest('[data-route2]');
    if (r2) { S.route2 = r2.dataset.route2; store.set('ideaRoute', S.route2); const box = r2.closest('.route-pick'); box.querySelectorAll('[data-route2]').forEach((b) => { const on = b === r2; b.classList.toggle('active', on); b.setAttribute('aria-checked', on); }); const rt = (ROUTES.find((x) => x[0] === S.route2) || ROUTES[0]); const tipEl = box.querySelector('.route-tip'); tipEl.textContent = rt[3]; tipEl.title = rt[2]; return; }
    const prep = e.target.closest('[data-prepare]');
    if (prep) {
      prep.disabled = true;
      prep.setAttribute('aria-busy', 'true');
      post('/api/actions/universe', { index: prep.dataset.prepare }).then((r) => {
        if (!r.success) toast(`${_t('k1549')}${(r.errors || []).join('; ')}`); else toast(_t('k1550'));
        loadUniverses(true);
      }).catch((err) => { toast(`${_t('k1551', { message: err.message })}`); prep.disabled = false; prep.removeAttribute('aria-busy'); });
      return;
    }
    const rr = e.target.closest('[data-run-role]');
    if (rr) {
      const role = rr.dataset.runRole;
      const n = (Array.isArray(S.backtests) ? S.backtests.length : 0) + 1;
      S.runSpec = { role, name: `${ROLE_META[role][0]} #${n}` };
      closeMenus();
      once('backtest-run', $('[data-action=backtest]') || rr, () => doAction('backtest-run'));
      return;
    }
    const bb = e.target.closest('a.back-bar');
    if (bb && history.state && sameHref(history.state.helmPrev, bb.getAttribute('href'))) { e.preventDefault(); history.back(); return; }
    const tb = S.route.view === 'backtest' && e.target.closest('nav.tabs a[href]');
    if (tb && !e.metaKey && !e.ctrlKey) { e.preventDefault(); NAV.keepPrev = history.state ? history.state.helmPrev : null; location.replace(tb.getAttribute('href')); return; }
    const mt = e.target.closest('[data-menu]');
    if (mt) { toggleMenu(document.getElementById(mt.dataset.menu), e.detail === 0); return; }
    if (!e.target.closest('.run-wrap') || e.target.closest('.run-menu button')) closeMenus();
    const act = e.target.closest('[data-action]');
    if (act) {
      const k = act.dataset.action;
      // 打开菜单/对话框的按钮立即响应；会发请求的按钮在返回前不能再点
      if (k === 'backtest') doAction(k, { kb: e.detail === 0 ? '1' : '0' });
      else if (k === 'layer') openLayerModal();
      else if (k === 'research' || k === 'paper-new' || k === 'project-rename') doAction(k, act.dataset);
      else once(`action:${k}`, act, () => doAction(k, act.dataset));
      return;
    }
    const f = e.target.closest('[data-file]');
    if (f) { if (S.codeEdit && S.codeEdit.name !== f.dataset.file && S.codeEdit.dirty && !(await askConfirm({ title: _t('ux068'), message: _t('ux069'), ok: _t('ux070'), danger: true }))) return; if (S.codeEdit && S.codeEdit.name !== f.dataset.file) S.codeEdit = null; S.fileSel = f.dataset.file; renderMain(); return; }
    const ce = e.target.closest('[data-code-edit]');
    if (ce) { const file = (S.files || []).find((x) => x.name === ce.dataset.codeEdit); if (file) { S.codeEdit = { name: file.name, draft: file.content || '', dirty: false }; renderMain(); const ta = $('#codeEditor'); if (ta) ta.focus(); } return; }
    if (e.target.closest('[data-code-cancel]')) { if (S.codeEdit && S.codeEdit.dirty && !(await askConfirm({ title: _t('ux068'), message: _t('ux069'), ok: _t('ux070'), danger: true }))) return; S.codeEdit = null; renderMain(); return; }
    const cs = e.target.closest('[data-code-save]');
    if (cs && S.codeEdit) {
      const { name, draft } = S.codeEdit;
      const r = await once('code-save', cs, () => data('files/update', { projectId: S.route.projectId, name, content: draft }));
      if (!r) return;
      if (!r.success) { toast(`${_t('ux071')}${(r.errors || []).map(zhErr).join('; ')}`); return; }
      S.codeEdit = null; S.compileResult = null; S.projSig = null;
      toast(_t('ux072', { name }));
      loadProjectView(true);
      return;
    }
    const ask = e.target.closest('[data-ask]');
    if (ask) { closeMenus(); askAgent(ask.dataset.ask, ask.dataset.text); return; }
    const so = e.target.closest('[data-sort]');
    if (so) {
      const k = so.dataset.sort; const cur = S.orderSort;
      S.orderSort = !cur || cur.key !== k ? { key: k, dir: 'asc' } : cur.dir === 'asc' ? { key: k, dir: 'desc' } : null;
      renderMain();
      return;
    }
    if (e.target.closest('[data-qc-export]')) { if (Array.isArray(S.code)) openQcDialog(S.code, { projectId: S.route.projectId, backtestId: S.route.backtestId }); return; }
    const cb = e.target.closest('[data-code-copy], [data-code-dl]');
    if (cb) {
      const list = cb.dataset.src === 'bt' ? S.code : S.files;
      const f = Array.isArray(list) && list.find((x) => x.name === cb.dataset.name);
      if (!f) return;
      const raw = f.contentOriginal ?? f.content; // 规则说明显示的是译文；复制 / 下载用原文
      if (cb.hasAttribute('data-code-copy')) copyText(raw).then((ok) => toast(ok ? `${_t('k0030', { name: f.name })}` : _t('k0031')));
      else { downloadText(f.name, raw); toast(`${_t('k1552', { name: f.name })}`); }
      return;
    }
    if (e.target.closest('[data-cmp-clear]')) { S.cmpSel = []; renderMain(); return; }
    const sr = e.target.closest('[data-sens-run]');
    if (sr) { runSens(sr); return; }
    const tr = e.target.closest('[data-tune-run]');
    if (tr) { runTuneUI(tr); return; }
    const pf = e.target.closest('[data-prefill]');
    if (pf) { prefillChat(pf.dataset.prefill, pf.dataset.text); return; }
    const bf = e.target.closest('[data-bt-filter]');
    if (bf) { S.btFilter = bf.dataset.btFilter; renderMain(); return; }
    if (e.target.closest('select, input, label') || e.target.closest('a[href]')) return;
    const row = e.target.closest('tr[data-href]');
    if (row) location.hash = row.dataset.href;
  });

  document.addEventListener('keydown', (e) => {
    const menu = e.target.closest && e.target.closest('.run-menu');
    if (menu && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      const items = [...menu.querySelectorAll('button:not([disabled])')];
      const i = items.indexOf(e.target);
      const n = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      e.preventDefault(); if (items[n]) items[n].focus(); return;
    }
    if (e.key === 'ArrowDown' && e.target.matches && e.target.matches('[aria-haspopup="menu"]')) {
      const m = document.getElementById(e.target.getAttribute('aria-controls'));
      if (m) { e.preventDefault(); if (m.hidden) toggleMenu(m, true); else { const f = m.querySelector('button:not([disabled])'); if (f) f.focus(); } return; }
    }
    const mod = e.metaKey || e.ctrlKey;
    const dlg = Boolean(document.querySelector('dialog[open]')); // 对话框开着时，对话面板在它后面、拿不到焦点
    if (mod && !dlg && e.key.toLowerCase() === 'j') { e.preventDefault(); $('#chatToggle').click(); }
    if (mod && !dlg && e.key.toLowerCase() === 'k') { e.preventDefault(); openChat(); input.focus(); }
    if (e.key === 'Escape') {
      if (!$('#threadMenu').hidden) { $('#threadMenu').hidden = true; $('#threadBtn').focus(); return; }
      if (document.querySelector('dialog[open]')) return;
      const openMenu = [...document.querySelectorAll('.run-menu, #runsMenu')].find((x) => !x.hidden);
      if (openMenu && openMenu.classList.contains('run-menu')) { closeMenus(null, true); return; }
      if (openMenu) { openMenu.hidden = true; const t = openMenu.parentElement && openMenu.parentElement.querySelector('button'); if (t) t.focus(); return; }
      const wasChat = app.classList.contains('chat-open');
      const wasSide = app.classList.contains('side-open');
      closeChat(); app.classList.remove('side-open');
      if (wasChat) $('#chatToggle').focus(); else if (wasSide && narrow()) $('#menuBtn').focus();
    }
  });

  document.addEventListener('change', async (e) => {
    const cb = e.target.closest('[data-cmp]');
    if (cb) {
      const id = cb.dataset.cmp;
      const cur = S.cmpSel.filter((x) => x !== id);
      S.cmpSel = cb.checked && cur.length < CMP_MAX ? [...cur, id] : cur;
      renderMain();
      return;
    }
    const sel = e.target.closest('[data-role-sel]');
    if (!sel) return;
    sel.disabled = true;
    // 在网页上选「主版本」= 用户自己的决定，走 backtest-main（不经过统计检验关卡）
    const r = sel.value === 'main'
      ? await safePost('/api/actions/backtest-main', { projectId: S.route.projectId, backtestId: sel.dataset.roleSel })
      : await safePost('/api/actions/backtest-tag', { projectId: S.route.projectId, backtestId: sel.dataset.roleSel, role: sel.value || null });
    // 失败时数据没变，loadProjectView 会因为签名相同而跳过重绘：要自己恢复下拉框，并清掉签名强制重绘
    if (!r.success) { toast(`${_t('k1553')}${(r.errors || []).join('; ')}`); sel.disabled = false; S.projSig = null; if (S.route.view === 'backtest') loadBacktestView(true); else loadProjectView(true); return; }
    if (sel.value === 'main') toast(_t('k1501'));
    if (S.route.view === 'backtest') loadBacktestView(true); else loadProjectView(true);
  });
  document.addEventListener('focusout', (e) => {
    const wrap = e.target.closest && e.target.closest('.run-wrap');
    if (wrap && e.relatedTarget && !wrap.contains(e.relatedTarget)) closeMenus();
  });
  let scrollRaf = 0;
  $('#main').addEventListener('scroll', () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; const k = history.state && history.state.helmNav; if (k && !NAV.want) NAV.pos.set(k, $('#main').scrollTop); });
  }, { passive: true });
  window.addEventListener('wheel', () => { NAV.want = null; }, { passive: true }); // 用户自己在滚：不再抢着恢复位置
  window.addEventListener('hashchange', () => { closeChat(); onRoute(); }); // 从对话里点链接跳页面时收起对话窗
}

// 主题切换：自动 / 浅 / 深；图表颜色在渲染时读取，切换后重画
function themePref() { try { return localStorage.getItem('helm.theme') || 'auto'; } catch (e) { return 'auto'; } }
function renderThemeSeg() {
  const el = document.getElementById('sideFoot'); if (!el) return;
  el.innerHTML = `<button type="button" class="tf-guide" data-settings-open><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>${_t('ux049')}</button>`;
  renderSettings();
}
document.addEventListener('click', (e) => { if (e.target.closest('[data-settings-open]')) openSettings(); });
// 外观 + 语言两行：只在「设置」对话框里（左下角只留「设置」入口，同一个控件不出现两次）
function lookRowsHTML() {
  const cur = themePref();
  const lp = HELM_I18N.pref();
  return `<div class="tf-row">${_t('k1557')}${[['auto', _t('k0924')], ['light', _t('k1554')], ['dark', _t('k1555')]].map(([v, t]) => `<button type="button" data-theme-set="${v}" aria-pressed="${v === cur}" title="${v === 'auto' ? _t('k1556') : ''}">${t}</button>`).join('')}</span></div>`
    + `<div class="tf-row"><span class="tf-k">${_t('x007')}</span><span class="theme-seg" role="group" aria-label="${_t('x007')}">${[['auto', _t('k0924'), _t('x008')], ['zh', _t('x009'), ''], ['en', _t('x010'), '']].map(([v, t, tip]) => `<button type="button" data-lang-set="${v}" aria-pressed="${v === lp}" title="${tip}">${t}</button>`).join('')}</span></div>`;
}
function applyTheme(v) {
  const root = document.documentElement;
  root.classList.add('theme-anim');
  if (v === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', v);
  try { if (v === 'auto') localStorage.removeItem('helm.theme'); else localStorage.setItem('helm.theme', v); } catch (e) {}
  renderThemeSeg();
  setTimeout(() => root.classList.remove('theme-anim'), 300);
  if (typeof renderMain === 'function') renderMain();
}
document.addEventListener('click', (e) => { const b = e.target.closest('[data-theme-set]'); if (b) applyTheme(b.dataset.themeSet); });
// 界面语言：不刷新页面，把当前能看到的东西都按新语言重画一遍；数据（含对话）重新向服务端要新语言的版本
function applyLang(v) {
  HELM_I18N.setPref(v);
  S.projSig = null;
  if (S.agentsRaw) S.agents = localizeAgents(S.agentsRaw);
  if (S.optionsRaw) S.options = localizeOptions(S.optionsRaw);
  const k = document.querySelector('#chatToggle kbd'); if (k) k.textContent = `${MOD_KEY}J`;
  renderThemeSeg();
  renderStatus(); renderRuns(); renderProjects(); renderAgents(); renderRunOpts(); renderThread(); renderRunBar();
  renderCrumbs(); renderCtx(); setTitle(); renderMain();
  refreshContent(); // 数据（项目说明、对话……）按新语言重新取
  menuSync();
}
document.addEventListener('click', (e) => { const b = e.target.closest('[data-lang-set]'); if (b) applyLang(b.dataset.langSet); });
document.addEventListener('click', (e) => {
  const m = e.target.closest('[data-bubble-more]');
  if (m) { const bub = m.previousElementSibling; const open = bub.classList.toggle('clamp') === false; m.textContent = open ? _t('k1237') : _t('k1558'); m.setAttribute('aria-expanded', String(open)); return; }
  const rw = e.target.closest('[data-rob-why]');
  if (rw) { const p = rw.closest('.panel-head').nextElementSibling; if (p) { p.hidden = !p.hidden; rw.setAttribute('aria-expanded', String(!p.hidden)); } return; }
  const jw = e.target.closest('[data-jr-why]');
  if (jw) { const p = document.querySelector('.jr-why'); if (p) { p.hidden = !p.hidden; jw.setAttribute('aria-expanded', String(!p.hidden)); } return; }
  const pw = e.target.closest('[data-pd-why]');
  if (pw) { const p = pw.closest('.pd') && pw.closest('.pd').querySelector('.pd-why'); if (p) { p.hidden = !p.hidden; pw.setAttribute('aria-expanded', String(!p.hidden)); } return; }
  const w = e.target.closest('[data-gate-why]');
  if (w) { const row = w.closest('.gate'); const p = row && row.querySelector('.gate-why'); if (p) { p.hidden = !p.hidden; w.setAttribute('aria-expanded', String(!p.hidden)); } }
});
try { matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (themePref() === 'auto') renderMain(); }); } catch (e) {}

async function init() {
  HELM_I18N.applyStatic();
  renderThemeSeg();
  wire();
  wirePipelineAgents();
  wireApprovals();
  wireQuestions();
  const k = document.querySelector('#chatToggle kbd'); if (k) k.textContent = `${MOD_KEY}J`;
  try { setAgents(await api('/api/agents')); } catch (e) { toast(`${_t('k1559', { message: e.message })}`); }
  try { S.optionsRaw = await api('/api/options'); S.options = localizeOptions(S.optionsRaw); } catch { /* 选择器保持默认 */ }
  if (!S.agents.some((a) => a.id === S.agentId)) S.agentId = S.agents[0] ? S.agents[0].id : 'mia';
  renderRunOpts();
  renderAgents();
  connectBus();
  loadApprovals();
  loadQuestions();
  refreshRestart();
  await loadThreads();
  const last = store.get('thread', null);
  if (last && S.threads.some((t) => t.id === last)) await openThread(last, { quiet: true }); else renderThread();
  renderProjects();
  onRoute();
  loadStatus();
  loadProjects();
  setInterval(() => { if (S.route.view === 'home' && !document.hidden) loadStatus(); }, 120000);
}

/* ================= Mac App 菜单 ↔ 网页 =================
 * App 的菜单栏（Swift）通过 window.helmMenu('命令') 调到这里；网页把「现在哪些命令能用、主题和语言是什么」
 * 推给 App（webkit.messageHandlers.helmMenu），菜单项据此变灰或打勾。浏览器里没有这个桥，这一段什么都不做。
 * 命令尽量「点页面上已有的那个按钮」，这样和用鼠标点走同一条路（同样的确认框、防连点）。 */
const IN_APP = Boolean(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.helmMenu);
const mainBtn = (sel) => document.querySelector(`#main ${sel}:not([disabled])`);
function goThen(hash, fn) {
  if (location.hash === hash || (hash === '#/' && !location.hash)) { fn(); return; }
  addEventListener('hashchange', () => setTimeout(fn, 0), { once: true });
  location.hash = hash;
}
function focusWhenReady(sel, n = 20) { const el = document.querySelector(sel); if (el) { el.focus(); if (el.select) el.select(); } else if (n) setTimeout(() => focusWhenReady(sel, n - 1), 50); }
const MENU_CMDS = {
  'nav-home': () => { location.hash = '#/'; },
  'nav-data': () => { location.hash = '#/data'; },
  'nav-journal': () => { location.hash = '#/journal'; },
  'nav-pipeline': () => { location.hash = '#/pipeline'; },
  'nav-agents': () => { location.hash = '#/agents'; },
  'new-project': () => openProjectModal(),
  'new-idea': () => goThen('#/', () => focusWhenReady('#ideaInput')),
  find: () => { if (narrow()) $('#app').classList.add('side-open'); focusWhenReady('#projectSearch'); },
  chat: () => $('#chatToggle').click(),
  ask: () => { openChat(); $('#input').focus(); },
  settings: () => openSettings(),
  ai: () => openAiModal(),
  health: () => goThen('#/', recheckHealth),
  shortcuts: () => openShortcuts(),
  // ⌘R 容易顺手按到（以前是重新载入），而每次回测都计入尝试次数：先确认
  run: async () => {
    if (!mainBtn('[data-run-role="candidate"]')) return;
    if (!(await askConfirm({ title: _t('mr_title'), message: _t('mr_msg'), ok: _t('k0047') }))) return;
    const b = mainBtn('[data-run-role="candidate"]'); if (b) b.click();
  },
  compile: () => { const b = mainBtn('[data-action="compile"]'); if (b) b.click(); },
  research: () => { const b = mainBtn('[data-action="research"]'); if (b) b.click(); },
  paper: () => { const b = mainBtn('[data-action="paper-new"]'); if (b) b.click(); },
  'set-main': () => { const b = mainBtn('[data-action="set-main"]'); if (b) b.click(); },
  'project-delete': () => { const b = mainBtn('[data-action="project-delete"]'); if (b) b.click(); },
  'project-rename': () => { const b = mainBtn('[data-action="project-rename"]'); if (b) b.click(); },
};
window.helmMenu = (cmd) => {
  const m = /^(theme|lang)-(auto|light|dark|zh|en)$/.exec(cmd);
  if (m) { if (m[1] === 'theme') applyTheme(m[2]); else applyLang(m[2]); return; }
  // 已经开着一个对话框：不在它上面再叠别的（主题、语言除外）
  if (document.querySelector('dialog[open]')) return;
  const f = MENU_CMDS[cmd];
  if (f) f();
};
let menuSent = '';
function menuSync() {
  if (!IN_APP) return;
  const has = (sel) => Boolean(mainBtn(sel));
  const st = {
    run: has('[data-run-role="candidate"]'), compile: has('[data-action="compile"]'), research: has('[data-action="research"]'),
    paper: has('[data-action="paper-new"]'), setMain: has('[data-action="set-main"]'), del: has('[data-action="project-delete"]'), rename: has('[data-action="project-rename"]'),
    nav: S.route.view !== 'home' ? 'project' : S.route.page || (S.route.data ? 'data' : S.route.journal ? 'journal' : 'home'),
    theme: themePref(), lang: HELM_I18N.pref(),
  };
  const j = JSON.stringify(st);
  if (j === menuSent) return;
  menuSent = j;
  try { window.webkit.messageHandlers.helmMenu.postMessage(st); } catch { /* App 关窗时可能已断开 */ }
}
// 快捷键一览（帮助 → 键盘快捷键，⌘/）。浏览器里只列网页自己能接住的那几个
function openShortcuts() {
  const K = (k) => k.replace(/⌘/g, MOD_KEY);
  const app = [
    [_t('sc_g_go'), [['⌘1', _t('sc_home')], ['⌘2', _t('sc_data')], ['⌘3', _t('sc_journal')], ['⌘4', _t('sc_pipeline')], ['⌘5', _t('sc_agents')], ['⌘F', _t('sc_find')], ['⌘[  ⌘]', _t('sc_back')]]],
    [_t('sc_g_make'), [['⌘N', _t('sc_newproj')], ['⇧⌘N', _t('sc_newidea')], ['⌘↩', _t('sc_submit')]]],
    [_t('sc_g_proj'), [['⌘R', _t('sc_run')], ['⌘B', _t('sc_compile')]]],
    [_t('sc_g_agent'), [['⌘J', _t('sc_chat')], ['⌘K', _t('sc_ask')], ['Esc', _t('sc_esc')]]],
    [_t('sc_g_app'), [['⌘,', _t('sc_settings')], ['⇧⌘R', _t('sc_reload')], ['⌘+  ⌘−  ⌘0', _t('sc_zoom')], ['⌘/', _t('sc_this')]]],
  ];
  const web = [[_t('sc_g_agent'), [['⌘J', _t('sc_chat')], ['⌘K', _t('sc_ask')], ['⌘↩', _t('sc_submit')], ['Esc', _t('sc_esc')]]]];
  const groups = IN_APP ? app : web;
  openModal({
    cls: 'sc-dlg', labelId: 'scH',
    html: `<div class="cd-body"><h2 id="scH">${_t('sc_title')}</h2>
      <div class="sc-grid">${groups.map(([g, rows]) => `<section><h3>${g}</h3><dl>${rows.map(([k, d]) => `<div><dt>${esc(d)}</dt><dd><kbd>${esc(K(k))}</kbd></dd></div>`).join('')}</dl></section>`).join('')}</div>
      ${IN_APP ? '' : `<p class="sc-note">${_t('sc_web')}</p>`}
      <div class="modal-actions"><button type="button" class="btn primary" data-sc-close>${_t('k0032')}</button></div></div>`,
    onClick: (e, close) => { if (e.target.closest('[data-sc-close]')) close(); },
  }).d.querySelector('[data-sc-close]').focus();
}
document.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === '/' && !IN_APP) { e.preventDefault(); if (!document.querySelector('dialog[open]')) openShortcuts(); } });
addEventListener('hashchange', () => setTimeout(menuSync, 0));
// 页面有 40 多处只局部重画（回测诊断、股票池、模拟实盘……），不经过 renderMain：盯住 #main 的变化再同步一次，
// 不然菜单会停在旧状态（例如回测页上明明有「设为主版本」按钮，菜单里却是灰的）。menuSync 状态没变时不发消息
if (IN_APP) { let mt = 0; new MutationObserver(() => { clearTimeout(mt); mt = setTimeout(menuSync, 120); }).observe($('#main'), { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] }); }

init();
