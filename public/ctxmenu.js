// 右键菜单（学 macOS 的上下文菜单）：只管弹出、定位、键盘、子菜单和动画，不知道业务。
// 用法：HelmCtx.open(items, { x, y } 或 { anchor: 元素 }, { target: 被右键的元素 })
// item：{ label, run, hint, checked, disabled, danger, sub: [items] } 或 'sep'（分隔线）
// 约定（和 macOS 一致）：
// - 鼠标打开时不预先高亮任何一项；键盘（≣ 键 / Shift+F10）打开时高亮第一项
// - ↑↓ 移动、→ 进子菜单、← 退出子菜单、↵ / 空格 执行、Esc 关闭、按首字母跳到那一项
// - 被右键的那一行描一圈强调色，菜单关掉后去掉；菜单关闭时焦点回到原来的位置
// - 点外面、滚动、改窗口大小、切走窗口、换页面都会关闭
(() => {
  const CHECK = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const CHEV = '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  let root = null; // { el, items, target, restore, sub: { el, items, parentIdx } | null }
  let subTimer = 0;

  function build(items, level) {
    const el = document.createElement('div');
    el.className = `ctx${level ? ' ctx-sub' : ''}`;
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-orientation', 'vertical');
    el.tabIndex = -1;
    const hasCheck = items.some((it) => it && it !== 'sep' && it.checked != null);
    el.innerHTML = items.map((it, i) => {
      if (it === 'sep') return '<div class="ctx-sep" role="separator"></div>';
      const role = it.checked != null ? 'menuitemcheckbox' : 'menuitem';
      const attrs = [`role="${role}"`, `data-i="${i}"`, 'tabindex="-1"'];
      if (it.checked != null) attrs.push(`aria-checked="${Boolean(it.checked)}"`);
      if (it.disabled) attrs.push('aria-disabled="true"');
      if (it.sub) attrs.push('aria-haspopup="menu"', 'aria-expanded="false"');
      return `<div class="ctx-item${it.danger ? ' danger' : ''}" ${attrs.join(' ')}${it.title ? ` title="${esc(it.title)}"` : ''}>`
        + `${hasCheck ? `<span class="ctx-check">${it.checked ? CHECK : ''}</span>` : ''}`
        + `<span class="ctx-label">${esc(it.label)}</span>`
        + `${it.sub ? `<span class="ctx-hint">${CHEV}</span>` : it.hint ? `<span class="ctx-hint">${esc(it.hint)}</span>` : ''}</div>`;
    }).join('');
    document.body.appendChild(el);
    return el;
  }

  // 放在点击处右下方；放不下就翻到左边 / 上边，最后夹在窗口里
  function place(el, x, y, flipX = null) {
    const M = 8;
    const r = el.getBoundingClientRect();
    let left = x; let top = y;
    if (left + r.width > innerWidth - M) left = flipX != null ? flipX - r.width : x - r.width;
    if (top + r.height > innerHeight - M) top = Math.max(M, innerHeight - M - r.height);
    el.style.left = `${Math.max(M, Math.round(left))}px`;
    el.style.top = `${Math.max(M, Math.round(top))}px`;
    el.style.transformOrigin = `${left < x ? 'right' : 'left'} ${top < y ? 'bottom' : 'top'}`;
  }

  const usable = (items, i) => items[i] && items[i] !== 'sep' && !items[i].disabled;
  const rows = (menu) => [...menu.el.querySelectorAll('.ctx-item')];
  const rowAt = (menu, i) => menu.el.querySelector(`.ctx-item[data-i="${i}"]`);
  const activeIdx = (menu) => { const a = menu.el.querySelector('.ctx-item.on'); return a ? Number(a.dataset.i) : -1; };

  function highlight(menu, i, focus = true) {
    rows(menu).forEach((r) => r.classList.toggle('on', Number(r.dataset.i) === i));
    const r = rowAt(menu, i);
    if (r && focus) r.focus({ preventScroll: true });
    else if (focus) menu.el.focus({ preventScroll: true });
  }
  function step(menu, dir) {
    const n = menu.items.length;
    let i = activeIdx(menu);
    for (let k = 0; k < n; k++) {
      i = i < 0 ? (dir > 0 ? 0 : n - 1) : (i + dir + n) % n;
      if (usable(menu.items, i)) { highlight(menu, i); return; }
    }
  }

  function openSub(i, viaKeyboard) {
    clearTimeout(subTimer);
    if (root.sub && root.sub.parentIdx === i) { if (viaKeyboard) { highlight(root.sub, -1, false); step(root.sub, 1); } return; }
    closeSub();
    const it = root.items[i];
    if (!it || !it.sub || it.disabled) return;
    const row = rowAt(root, i);
    const el = build(it.sub, 1);
    const pr = row.getBoundingClientRect();
    place(el, pr.right - 2, pr.top - 5, pr.left + 2);
    row.setAttribute('aria-expanded', 'true');
    row.classList.add('open');
    root.sub = { el, items: it.sub, parentIdx: i };
    wire(root.sub, 1);
    requestAnimationFrame(() => el.classList.add('show'));
    if (viaKeyboard) step(root.sub, 1);
  }
  function closeSub() {
    clearTimeout(subTimer);
    if (!root || !root.sub) return;
    const row = rowAt(root, root.sub.parentIdx);
    if (row) { row.setAttribute('aria-expanded', 'false'); row.classList.remove('open'); }
    root.sub.el.remove();
    root.sub = null;
  }

  function activate(menu, i, viaKeyboard) {
    const it = menu.items[i];
    if (!usable(menu.items, i)) return;
    if (it.sub) { openSub(i, viaKeyboard); return; }
    const row = rowAt(menu, i);
    // macOS：选中的那一项闪一下再关。动作要在这次点击里立刻执行：
    // Safari / WKWebView 只允许在用户操作的同一个事件里写剪贴板，延迟执行会拷贝失败
    row.classList.add('blink');
    try { it.run && it.run(); } catch (e) { console.error(e); }
    const mine = root;
    if (reduced()) close(); else setTimeout(() => { if (root === mine) close(); }, 90);
  }

  function wire(menu, level) {
    menu.el.addEventListener('pointermove', (e) => {
      const r = e.target.closest('.ctx-item');
      if (!r) return;
      const i = Number(r.dataset.i);
      if (level === 0 && root.sub && root.sub.parentIdx !== i) {
        // 往子菜单斜着移动时会经过别的项：等一下再关，免得子菜单一闪就没
        clearTimeout(subTimer);
        subTimer = setTimeout(() => { closeSub(); if (menu.items[i] && menu.items[i].sub) openSub(i, false); }, 180);
      } else if (level === 0 && menu.items[i] && menu.items[i].sub && !root.sub) {
        clearTimeout(subTimer);
        subTimer = setTimeout(() => openSub(i, false), 120);
      }
      if (level === 1) clearTimeout(subTimer);
      highlight(menu, usable(menu.items, i) ? i : -1, false);
      if (level === 1 && root.sub) { const pr = rowAt(root, root.sub.parentIdx); if (pr) pr.classList.add('on'); }
    });
    menu.el.addEventListener('pointerleave', () => { if (!(level === 0 && root && root.sub)) highlight(menu, -1, false); });
    menu.el.addEventListener('click', (e) => {
      const r = e.target.closest('.ctx-item');
      if (r) activate(menu, Number(r.dataset.i), false);
    });
    menu.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  function onKey(e) {
    if (!root) return;
    const menu = root.sub && root.sub.el.contains(document.activeElement) ? root.sub : root;
    const k = e.key;
    if (k === 'Escape') { e.preventDefault(); if (menu === root.sub) { const p = root.sub.parentIdx; closeSub(); highlight(root, p); } else close(true); return; }
    if (k === 'Tab') { e.preventDefault(); close(true); return; }
    if (k === 'ArrowDown') { e.preventDefault(); step(menu, 1); return; }
    if (k === 'ArrowUp') { e.preventDefault(); step(menu, -1); return; }
    if (k === 'Home' || k === 'End') { e.preventDefault(); highlight(menu, -1, false); step(menu, k === 'Home' ? 1 : -1); return; }
    if (k === 'ArrowRight') { const i = activeIdx(menu); if (menu === root && i >= 0 && root.items[i].sub) { e.preventDefault(); openSub(i, true); } return; }
    if (k === 'ArrowLeft') { if (menu === root.sub) { e.preventDefault(); const p = root.sub.parentIdx; closeSub(); highlight(root, p); } return; }
    if (k === 'Enter' || k === ' ') { e.preventDefault(); const i = activeIdx(menu); if (i >= 0) activate(menu, i, true); return; }
    if (k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // 按首字母跳转（中文按拼音做不到，就按显示的第一个字）
      const c = k.toLowerCase();
      const n = menu.items.length; const from = activeIdx(menu);
      for (let s = 1; s <= n; s++) {
        const i = (from + s + n) % n;
        if (usable(menu.items, i) && String(menu.items[i].label).trim().toLowerCase().startsWith(c)) { e.preventDefault(); highlight(menu, i); return; }
      }
    }
  }
  function onDown(e) { if (root && !root.el.contains(e.target) && !(root.sub && root.sub.el.contains(e.target))) close(); }
  function onAway() { close(); }

  function open(items, at, opts = {}) {
    close();
    const list = items.filter((it, i, a) => it && !(it === 'sep' && (i === 0 || a[i - 1] === 'sep' || i === a.length - 1)));
    if (!list.length) return;
    const el = build(list, 0);
    root = { el, items: list, target: opts.target || null, restore: document.activeElement, sub: null };
    if (root.target) root.target.classList.add('ctx-target');
    if (at.anchor) { const r = at.anchor.getBoundingClientRect(); place(el, r.left + 12, r.bottom - 4); }
    else place(el, at.x + 1, at.y + 1);
    wire(root, 0);
    requestAnimationFrame(() => el.classList.add('show'));
    if (at.anchor) step(root, 1); else el.focus({ preventScroll: true });
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    addEventListener('blur', onAway);
    addEventListener('resize', onAway);
    addEventListener('hashchange', onAway);
    document.addEventListener('scroll', onAway, true);
  }

  function close(refocus = false) {
    if (!root) return;
    const r = root;
    closeSub();
    root = null;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onDown, true);
    removeEventListener('blur', onAway);
    removeEventListener('resize', onAway);
    removeEventListener('hashchange', onAway);
    document.removeEventListener('scroll', onAway, true);
    if (r.target) r.target.classList.remove('ctx-target');
    // 关闭时淡出（macOS 的菜单是淡出，不是消失）
    if (reduced()) r.el.remove();
    else { r.el.classList.remove('show'); r.el.classList.add('hide'); setTimeout(() => r.el.remove(), 120); }
    if (refocus && r.restore && document.contains(r.restore)) r.restore.focus({ preventScroll: true });
  }

  window.HelmCtx = { open, close, isOpen: () => Boolean(root) };
})();
