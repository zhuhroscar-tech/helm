'use strict';
/* 第一次打开 Helm：设置向导（语言 → 检查这台电脑 → 接入 AI）+ 功能导览（在真实界面上逐个指出功能在哪）。
   只读 app.js 的状态（S），调用它的函数（loadHealth / loadAi / openAiModal / openChat / selectAgent …），不改它的数据结构。
   看过一次就记在 localStorage（helm.onboarded），左下角「设置向导」可以再打开。 */
(() => {
  const SETUP_CMD = 'scripts/setup.sh';
  const CLAUDE_CMD = 'curl -fsSL https://claude.ai/install.sh | bash';
  const ENGINE_IDS = ['dotnet', 'lean', 'python', 'libpython'];
  const STEPS = ['welcome', 'machine', 'ai', 'ready'];
  const isEn = () => HELM_I18N.lang() === 'en';
  const hName = (c) => (isEn() ? c.en || c.zh : c.zh);

  /* ---------------- 设置向导 ---------------- */
  let dlg = null;
  let step = 0;
  let poll = 0;
  let checking = false;

  function ensureDialog() {
    if (dlg) return dlg;
    dlg = document.createElement('dialog');
    dlg.className = 'modal onb';
    dlg.setAttribute('aria-labelledby', 'onbH');
    document.body.appendChild(dlg);
    dlg.addEventListener('click', onClick);
    dlg.addEventListener('cancel', () => markDone()); // Esc = 以后再说
    dlg.addEventListener('close', () => clearTimeout(poll));
    // AI 连接对话框关掉后，刷新向导里的连接状态
    const ai = document.getElementById('aiModal');
    if (ai) ai.addEventListener('close', () => { if (dlg.open && STEPS[step] === 'ai') loadAi(true).then(render); });
    return dlg;
  }

  function open(at = 0) {
    endTour(false);
    ensureDialog();
    step = at;
    render();
    if (!dlg.open) dlg.showModal();
    focusPrimary();
  }

  function go(n) { step = Math.max(0, Math.min(STEPS.length - 1, n)); render(); focusPrimary(); }
  function focusPrimary() { setTimeout(() => { const b = dlg && dlg.querySelector('.onb-actions .primary') || dlg.querySelector('.onb-actions button'); if (b) b.focus(); }, 30); }
  function markDone() { store.set('onboarded', 1); }

  const dots = () => `<ol class="onb-steps" aria-label="${esc(_t('ob007', { n: step + 1, total: STEPS.length }))}">${STEPS.map((_, i) => `<li class="${i < step ? 'done' : i === step ? 'cur' : ''}"></li>`).join('')}</ol>`;
  const cmd = (text) => `<div class="onb-cmd"><code>${esc(text)}</code><button type="button" class="btn sm" data-onb-copy="${esc(text)}">${_t('ob020')}</button></div>`;
  const mark = (ok) => (ok === null ? '<span class="onb-mark wait" aria-hidden="true"></span>'
    : `<span class="onb-mark ${ok ? 'ok' : 'bad'}" aria-hidden="true">${ok ? '<svg viewBox="0 0 16 16"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '<svg viewBox="0 0 16 16"><path d="M5 5l6 6M11 5l-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'}</span>`);

  function render() {
    if (!dlg) return;
    const name = STEPS[step];
    clearTimeout(poll);
    dlg.innerHTML = `<div class="onb-in">${name === 'welcome' ? '' : dots()}${VIEWS[name]()}</div>`;
    if (name === 'machine') schedulePoll();
  }

  const VIEWS = {
    welcome() {
      const lp = HELM_I18N.pref();
      return `
      <div class="onb-hero">
        <svg class="onb-wheel" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6.2" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><g stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M12 1.8v3.4M12 18.8v3.4M1.8 12h3.4M18.8 12h3.4M4.8 4.8l2.4 2.4M16.8 16.8l2.4 2.4M4.8 19.2l2.4-2.4M16.8 7.2l2.4-2.4"/></g></svg>
        <h2 id="onbH">${_t('ob001')}</h2>
      </div>
      <p class="onb-lead">${_t('ob002')}</p>
      <p class="onb-p">${_t('ob003')}</p>
      <div class="onb-lang"><span>${_t('ob004')}</span><span class="theme-seg" role="group" aria-label="${_t('ob004')}">${[['auto', _t('k0924')], ['zh', _t('x009')], ['en', _t('x010')]].map(([v, t]) => `<button type="button" data-onb-lang="${v}" aria-pressed="${v === lp}">${t}</button>`).join('')}</span></div>
      <div class="onb-actions"><button type="button" class="btn" data-onb="later">${_t('ob006')}</button><button type="button" class="btn primary" data-onb="next">${_t('ob005')}</button></div>`;
    },

    machine() {
      const h = S.health;
      const comps = h && Array.isArray(h.components) ? h.components.filter((c) => c.id !== 'ai') : null;
      const req = comps ? comps.filter((c) => c.required) : [];
      const opt = comps ? comps.filter((c) => !c.required) : [];
      const miss = req.filter((c) => !c.ok);
      const status = !comps ? `<span class="onb-pill">${_t('ob012')}</span>`
        : miss.length ? `<span class="onb-pill bad">${_t('ob014', { n: miss.length })}</span>` : `<span class="onb-pill ok">${_t('ob013')}</span>`;
      const row = (c) => `<li>${mark(checking && !c.ok ? null : c.ok)}<span class="onb-name">${esc(hName(c))}</span>${c.detail ? `<code class="onb-detail">${esc(String(c.detail))}</code>` : ''}</li>`;
      const engineMissing = miss.some((c) => ENGINE_IDS.includes(c.id));
      const claudeMissing = miss.some((c) => c.id === 'claude');
      const fixes = [
        claudeMissing ? `<div class="onb-fix"><p>${_t('ob017')}</p>${cmd(CLAUDE_CMD)}<p class="onb-note">${_t('ob018')}</p></div>` : '',
        engineMissing ? `<div class="onb-fix"><p>${h.installDir ? _t('ux044') : _t('ob015')}</p>${cmd(h.installDir ? `cd "${h.installDir}" && ${SETUP_CMD}` : SETUP_CMD)}<p class="onb-note">${_t('ob016')}</p></div>` : '',
      ].join('');
      const optMiss = opt.filter((c) => !c.ok);
      return `
      <div class="onb-head"><h2 id="onbH">${_t('ob010')}</h2>${status}</div>
      <p class="onb-p">${_t('ob011')}</p>
      ${comps ? `<ul class="onb-list">${req.map(row).join('')}</ul>` : '<div class="skeleton" style="height:150px"></div>'}
      ${fixes}
      ${optMiss.length ? `<details class="onb-opt"><summary>${_t('ob022')} · ${optMiss.map((c) => esc(hName(c))).join(_t('k0015'))}</summary>
        <ul class="onb-list">${opt.map(row).join('')}</ul><p class="onb-note">${_t('ob023')} ${_t('ob024')}</p></details>` : ''}
      <div class="onb-actions">
        <button type="button" class="btn" data-onb="back">${_t('ob026')}</button>
        <button type="button" class="btn" data-onb="recheck" ${checking ? 'aria-busy="true"' : ''}>${_t('ob019')}</button>
        ${miss.length || !comps ? `<button type="button" class="btn" data-onb="next">${_t('ob027')}</button>` : `<button type="button" class="btn primary" data-onb="next">${_t('ob025')}</button>`}
      </div>`;
    },

    ai() {
      const claudeOk = !(S.health && (S.health.missing || []).includes('claude'));
      const a = S.ai && S.ai.ai;
      const login = S.ai && S.ai.login;
      const ok = Boolean(a) && (!login || login.ok);
      const state = !claudeOk ? `<div class="onb-ai bad">${mark(false)}<span>${_t('ob037')}</span></div>`
        : !S.ai ? `<div class="onb-ai">${mark(null)}<span>${_t('ob012')}</span></div>`
          : ok ? `<div class="onb-ai ok">${mark(true)}<span>${esc(_t('ob032', { mode: aiModeName(a.mode) }))}${login && login.subscription ? ` · Claude ${esc(login.subscription.charAt(0).toUpperCase() + login.subscription.slice(1))}` : ''}</span></div>`
            : `<div class="onb-ai bad">${mark(false)}<span>${esc(_t('ob033', { error: zhErr((login && login.error) || '') }))}</span></div>`;
      return `
      <div class="onb-head"><h2 id="onbH">${_t('ob030')}</h2></div>
      <p class="onb-p">${_t('ob031')}</p>
      ${state}
      <div class="onb-choices">
        ${[['subscription', _t('ob038')], ['apiKey', _t('ob039')], ['custom', _t('ob045')]].map(([m, d]) => `<div><b>${esc(aiModeName(m))}</b><span>${d}</span></div>`).join('')}
      </div>
      <p class="onb-note">${_t('ob036')}</p>
      <div class="onb-actions">
        <button type="button" class="btn" data-onb="back">${_t('ob026')}</button>
        <button type="button" class="btn ${ok ? '' : 'primary'}" data-onb="ai" ${claudeOk ? '' : 'disabled'}>${ok ? _t('ob035') : _t('ob034')}</button>
        <button type="button" class="btn ${ok ? 'primary' : ''}" data-onb="next">${ok ? _t('ob025') : _t('ob027')}</button>
      </div>`;
    },

    ready() {
      const h = S.health;
      const login = S.ai && S.ai.login;
      const missing = (h && (h.missing || []).length) || (login && !login.ok);
      return `
      <div class="onb-head"><h2 id="onbH">${missing ? _t('ux043') : _t('ob040')}</h2></div>
      ${missing ? `<p class="onb-warn">${_t('ob044')}</p>` : ''}
      <p class="onb-p">${_t('ob041', { key: esc(MOD_KEY.trim()) })}</p>
      <p class="onb-note">${_t('ux045')} <button type="button" class="linkish" data-onb="settings">${_t('ux046')}</button></p>
      <div class="onb-actions">
        <button type="button" class="btn" data-onb="back">${_t('ob026')}</button>
        <button type="button" class="btn" data-onb="skipTour">${_t('ob043')}</button>
        <button type="button" class="btn primary" data-onb="tour">${_t('ob042')}</button>
      </div>`;
    },
  };

  // 停在「检查这台电脑」这一步、还有缺的：每 6 秒自动重查一次（用户在终端里装好了，这里自己变绿）
  function schedulePoll() {
    const h = S.health;
    if (!h) { recheck(); return; }
    if (!(h.missing || []).some((id) => id !== 'ai')) return;
    poll = setTimeout(() => { if (dlg.open && STEPS[step] === 'machine' && !document.hidden) recheck(true); else schedulePoll(); }, 6000);
  }
  async function recheck(quiet = false) {
    if (checking) return;
    checking = !quiet;
    if (!quiet) render();
    await loadHealth(true);
    checking = false;
    if (dlg.open && STEPS[step] === 'machine') render();
  }

  async function onClick(e) {
    const lang = e.target.closest('[data-onb-lang]');
    if (lang) { applyLang(lang.dataset.onbLang); render(); focusPrimary(); return; }
    const cp = e.target.closest('[data-onb-copy]');
    if (cp) { const ok = await copyText(cp.dataset.onbCopy); cp.textContent = ok ? _t('ob021') : _t('ob046'); setTimeout(() => { cp.textContent = _t('ob020'); }, 1600); return; }
    const b = e.target.closest('[data-onb]');
    if (!b) return;
    const act = b.dataset.onb;
    if (act === 'later') { markDone(); dlg.close(); return; }
    if (act === 'back') { go(step - 1); return; }
    if (act === 'recheck') { recheck(); return; }
    if (act === 'ai') { openAiModal(); return; }
    if (act === 'settings') { markDone(); dlg.close(); openSettings(); return; }
    if (act === 'skipTour') { markDone(); dlg.close(); return; }
    if (act === 'tour') { markDone(); dlg.close(); startTour(); return; }
    if (act === 'next') {
      go(step + 1);
      if (STEPS[step] === 'machine' && !S.health) recheck();
      if (STEPS[step] === 'ai') loadAi(true).then(() => { if (STEPS[step] === 'ai') render(); });
    }
  }

  /* ---------------- 功能导览 ---------------- */
  // prep：把目标露出来（打开对话框 / 侧栏）；目标看不见就跳过这一步
  // 只留最要紧的几步：从哪里开始（首页想法框）、对话在哪、状态灯、设置
  const TOUR = [
    { sel: '#ideaForm', t: 'ux047', d: 'ux048', prep: 'chatClosed' },
    { sel: '#chatToggle', t: 'ob050', d: 'ob051', prep: 'chatClosed' },
    { sel: '#status', t: 'ob056', d: 'ob057', prep: 'chatClosed' },
    { sel: '#sideFoot', t: 'ob066', d: 'ob067', prep: 'side' },
    { final: true, t: 'ob070', d: 'ob071' },
  ];
  let tour = null; // { i, el, hole, card, side: 原来的侧栏状态, chat: 原来对话框是否打开 }

  function startTour() {
    const app = document.getElementById('app');
    tour = { i: 0, side: { open: app.classList.contains('side-open'), hidden: app.classList.contains('side-hidden') }, chat: app.classList.contains('chat-open') };
    const el = document.createElement('div');
    el.className = 'tour';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', _t('ob084'));
    el.innerHTML = '<div class="tour-hole"></div><div class="tour-card" tabindex="-1"></div>';
    document.body.appendChild(el);
    tour.el = el; tour.hole = el.firstChild; tour.card = el.lastChild;
    el.addEventListener('click', onTourClick);
    document.addEventListener('keydown', onTourKey, true);
    window.addEventListener('resize', place);
    show(0, 1);
  }

  function prep(kind) {
    const app = document.getElementById('app');
    if (kind === 'chat') openChat();
    if (kind === 'chatClosed' || kind === 'side') closeChat();
    if (kind === 'side') {
      if (narrow()) app.classList.add('side-open'); else app.classList.remove('side-hidden');
    } else if (narrow()) app.classList.remove('side-open');
  }
  const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; };

  function show(i, dir) {
    if (!tour) return;
    while (i >= 0 && i < TOUR.length) {
      const s = TOUR[i];
      if (s.final) break;
      prep(s.prep);
      if (visible(document.querySelector(s.sel))) break;
      i += dir;
    }
    if (i < 0) i = 0;
    if (i >= TOUR.length) { endTour(); return; }
    tour.i = i;
    const s = TOUR[i];
    if (s.final) { closeChat(); restoreSide(); } else { const el = document.querySelector(s.sel); if (el) el.scrollIntoView({ block: 'nearest' }); }
    const real = TOUR.filter((x) => !x.final).length;
    const n = TOUR.slice(0, i + 1).filter((x) => !x.final).length;
    tour.card.innerHTML = s.final ? `
      <h3 id="tourH">${_t(s.t)}</h3><p>${_t(s.d)}</p>
      <blockquote class="tour-q">${esc(_t('ob072'))}</blockquote>
      <p class="tour-note">${_t('ob075')}</p>
      <div class="tour-actions"><button type="button" class="btn sm" data-tour="end">${_t('ob074')}</button><button type="button" class="btn sm primary" data-tour="try">${_t('ob073')}</button></div>`
      : `
      <div class="tour-k">${n} / ${real}</div>
      <h3 id="tourH">${_t(s.t)}</h3><p>${_t(s.d, { key: esc(MOD_KEY.trim()) })}</p>
      <div class="tour-actions"><button type="button" class="linkish" data-tour="end">${_t('ob081')}</button><span class="sp"></span>
        ${n > 1 ? `<button type="button" class="btn sm" data-tour="back">${_t('ob026')}</button>` : ''}<button type="button" class="btn sm primary" data-tour="next">${_t('ob025')}</button></div>`;
    tour.el.setAttribute('aria-labelledby', 'tourH');
    tour.el.classList.toggle('final', Boolean(s.final));
    // 侧栏 / 对话框有展开动画：等它停下再量位置
    place();
    setTimeout(place, 260);
    setTimeout(() => { const b = tour && tour.card.querySelector('.primary'); if (b) b.focus(); }, 40);
  }

  function place() {
    if (!tour) return;
    const s = TOUR[tour.i];
    const { hole, card } = tour;
    const cw = Math.min(320, innerWidth - 32);
    card.style.width = `${cw}px`;
    if (s.final) {
      hole.style.cssText = `left:${innerWidth / 2}px;top:${innerHeight / 2}px;width:0;height:0`;
      card.style.left = `${(innerWidth - cw) / 2}px`;
      card.style.top = `${Math.max(16, (innerHeight - card.offsetHeight) / 2)}px`;
      return;
    }
    const target = document.querySelector(s.sel);
    if (!target) return;
    const r = target.getBoundingClientRect();
    const pad = 6;
    const x = Math.max(4, r.left - pad); const y = Math.max(4, r.top - pad);
    const w = Math.min(innerWidth - 8, r.right + pad) - x; const h = Math.min(innerHeight - 8, r.bottom + pad) - y;
    hole.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
    // 卡片放在目标旁边：右 → 左 → 下 → 上，放不下就贴边
    const ch = card.offsetHeight; const gap = 14;
    const clampY = (v) => Math.max(16, Math.min(innerHeight - ch - 16, v));
    const clampX = (v) => Math.max(16, Math.min(innerWidth - cw - 16, v));
    let left; let top;
    if (x + w + gap + cw <= innerWidth - 16) { left = x + w + gap; top = clampY(y); }
    else if (x - gap - cw >= 16) { left = x - gap - cw; top = clampY(y); }
    else if (y + h + gap + ch <= innerHeight - 16) { left = clampX(x); top = y + h + gap; }
    else { left = clampX(x); top = Math.max(16, y - gap - ch); }
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  function restoreSide() {
    if (!tour) return;
    const app = document.getElementById('app');
    app.classList.toggle('side-open', tour.side.open);
    app.classList.toggle('side-hidden', tour.side.hidden);
  }

  function endTour(restore = true) {
    if (!tour) return;
    if (restore) { restoreSide(); if (tour.chat) openChat(); else closeChat(); }
    document.removeEventListener('keydown', onTourKey, true);
    window.removeEventListener('resize', place);
    tour.el.remove();
    tour = null;
  }

  // 「试试第一个策略」：放进首页的想法框（主路径），用户改好再交给团队
  function tryFirst() {
    endTour(false);
    restoreSide();
    closeChat();
    const fill = (n = 0) => {
      const box = document.getElementById('ideaInput');
      if (!box) { if (n < 40) setTimeout(() => fill(n + 1), 100); return; }
      box.value = _t('ob072');
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    };
    if (!document.getElementById('ideaInput')) location.hash = '#/';
    fill();
  }

  function onTourClick(e) {
    const b = e.target.closest('[data-tour]');
    if (!b) return;
    const a = b.dataset.tour;
    if (a === 'next') show(tour.i + 1, 1);
    else if (a === 'back') show(tour.i - 1, -1);
    else if (a === 'try') tryFirst();
    else endTour();
  }
  function onTourKey(e) {
    if (!tour) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endTour(); return; }
    if (e.key === 'ArrowRight' && !TOUR[tour.i].final) { e.preventDefault(); show(tour.i + 1, 1); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); show(tour.i - 1, -1); return; }
    // 焦点留在卡片里
    if (e.key === 'Tab') {
      const f = [...tour.card.querySelectorAll('button')];
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      e.preventDefault();
      f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
    }
  }

  /* ---------------- 入口 ---------------- */
  document.addEventListener('click', (e) => { if (e.target.closest('[data-onb-open]')) open(0); });
  // 第一次打开：等 app.js 初始化完（agent 列表到了）再弹，避免和首页的加载抢
  function boot(n = 0) {
    if (store.get('onboarded', 0)) return;
    if (!(S.agents && S.agents.length) && n < 60) { setTimeout(() => boot(n + 1), 150); return; }
    if (document.querySelector('dialog[open]')) return;
    open(0);
  }
  if (document.readyState === 'complete') setTimeout(boot, 400); else window.addEventListener('load', () => setTimeout(boot, 400));

  window.HelmOnboarding = { open, startTour };
})();
