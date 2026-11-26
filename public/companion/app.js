'use strict';
/* Helm 手机伴侣：看自动搜索有没有找到、花了多少；把想法记下来发给电脑。
   只和这台电脑上的伴侣服务说话（lib/companion.mjs）：配对换令牌，之后读摘要、写收件箱。
   不在家（连不上电脑）时想法先存在手机里，连上了自动发出去。 */
(() => {
  const ZH = /^zh/i.test(navigator.language || '');
  document.documentElement.lang = ZH ? 'zh-CN' : 'en';
  const T = ZH ? {
    tabNow: '现在', tabIdeas: '想法',
    pairH: '连接到你的 Helm', pairP: '在电脑上打开 Helm → 设置 → 手机伴侣，点「生成配对码」，把 6 位数字填在这里。', pairBtn: '连接', pairing: '正在连接…',
    eWrong: '配对码不对，或者已经过期。在电脑上重新生成一个。', eNoCode: '电脑上还没有生成配对码，或者已经过期。', eMany: '试的次数太多了，过 10 分钟再试。', eNet: '连不上电脑。确认手机和电脑在同一个 Wi-Fi，Helm 开着。',
    updated: '更新于', refresh: '刷新', offline: '连不上电脑', offlineP: '显示的是上次看到的内容。',
    sSearch: '自动搜索', round: '第 {n} 轮', rounds: '共 {n} 轮',
    hRunning: '正在找', hFound1: '找到 1 个候选', hFoundN: '找到 {n} 个候选', hNothing: '这次没找到', hError: '出错停下了', hStopped: '停下了', hNone: '还没开始过',
    pRunning0: '还没有想法做完。', pRunning: '已经试了 {n} 个想法，还没有通过的。', pFound: '开发期和验证期都通过了。回到电脑上确认要不要设为主版本。',
    pNothing: '试了 {n} 个想法，没有一个两段都通过。', pNone: '在电脑上的「研究流水线」里开始一次自动研究，这里就能看到进度。',
    rUsd: '合计用量到了上限。', rTime: '合计时间到了上限。', rRounds: '轮数到了上限。', rNoProgress: '最后一轮什么都没测成，先停下了。', rHoldout: '有想法开发期通过了，验证期没跑成：回电脑上看看。', rUser: '是你停掉的。', rCost: '用量到了上限。', rRestart: 'Helm 重启过，这一轮中断了。',
    sUsage: '用量', of: '上限 ${n}', tokIn: '输入', tokOut: '输出', tokCache: '缓存 Token', tokNone: '这几轮开始时还没有记 token，只有花费',
    kIdeas: '试过的想法', kTests: '想法检验', kDev: '开发期版本', kHold: '看过验证期', kTime: '用时', kTok: 'Token', min: '分钟', hr: '小时',
    sCurrent: '这一轮的想法', vFound: '两段都通过', vHoldFail: '验证期没过', vDevPass: '开发期通过', vDevFail: '开发期没过', vNoSignal: '没有信号', vPending: '在做 / 没开始',
    sPaper: '模拟实盘', days: '{n} 个交易日', vs: '基准 {v}', paperBad: '上次运行失败', paperNone: '没有在跑的模拟实盘。',
    ideaH: '记一个想法', ideaP: '用大白话写。它会进电脑上的收件箱，等你在电脑上点一下才交给团队，不会自己开工。', ideaPh: '比如：信用利差走阔的月份少拿股票，多拿中期国债。', send: '发给电脑', sending: '正在发…', saved: '存在手机里，连上电脑后自动发',
    sSent: '发过的', stNew: '在收件箱', stUsed: '已交给团队', stDismissed: '已忽略', stQueued: '等着发', noIdeas: '还没有发过想法。', tooShort: '再多写几个字。', inboxFull: '电脑上的收件箱满了（50 条没处理）。先去电脑上处理几条。',
    unpair: '断开这台手机', unpairQ: '断开后要重新输入配对码才能再连。断开吗？', justNow: '刚刚', mAgo: '{n} 分钟前', hAgo: '{n} 小时前', dAgo: '{n} 天前',
  } : {
    tabNow: 'Now', tabIdeas: 'Ideas',
    pairH: 'Connect to your Helm', pairP: 'On your computer open Helm → Settings → Phone companion, press "New pairing code", and enter the 6 digits here.', pairBtn: 'Connect', pairing: 'Connecting…',
    eWrong: 'That code is wrong or has expired. Make a new one on your computer.', eNoCode: 'There is no pairing code on the computer, or it has expired.', eMany: 'Too many attempts. Try again in 10 minutes.', eNet: 'Can’t reach the computer. Check that the phone is on the same Wi-Fi and Helm is running.',
    updated: 'Updated', refresh: 'Refresh', offline: 'Can’t reach the computer', offlineP: 'Showing what was last seen.',
    sSearch: 'Autopilot search', round: 'Round {n}', rounds: '{n} rounds',
    hRunning: 'Searching', hFound1: '1 candidate found', hFoundN: '{n} candidates found', hNothing: 'Nothing found this time', hError: 'Stopped on an error', hStopped: 'Stopped', hNone: 'Not started yet',
    pRunning0: 'No idea has finished yet.', pRunning: '{n} ideas tried so far; none has passed.', pFound: 'It passed both the development period and the holdout. Confirm it on your computer.',
    pNothing: '{n} ideas tried; none passed both periods.', pNone: 'Start an autopilot run from Research pipeline on your computer and its progress shows up here.',
    rUsd: 'The total usage cap was reached.', rTime: 'The total time limit was reached.', rRounds: 'The round limit was reached.', rNoProgress: 'The last round tested nothing, so the search paused.', rHoldout: 'An idea passed the dev period but its holdout did not run: check on your computer.', rUser: 'You stopped it.', rCost: 'The usage cap was reached.', rRestart: 'Helm restarted and the round was interrupted.',
    sUsage: 'Usage', of: 'cap ${n}', tokIn: 'in', tokOut: 'out', tokCache: 'Cached tokens', tokNone: 'Tokens were not recorded yet when these rounds ran; cost only',
    kIdeas: 'Ideas tried', kTests: 'Idea tests', kDev: 'Dev versions', kHold: 'Holdout looks', kTime: 'Time', kTok: 'Tokens', min: 'min', hr: 'h',
    sCurrent: 'This round’s ideas', vFound: 'passed both', vHoldFail: 'failed holdout', vDevPass: 'passed dev', vDevFail: 'no dev pass', vNoSignal: 'no signal', vPending: 'in progress',
    sPaper: 'Paper trading', days: '{n} trading days', vs: 'benchmark {v}', paperBad: 'last run failed', paperNone: 'No paper session is running.',
    ideaH: 'Write down an idea', ideaP: 'Plain words are fine. It lands in the inbox on your computer and waits there until you hand it to the team; nothing starts by itself.', ideaPh: 'E.g. hold fewer stocks and more mid-term Treasuries in months when credit spreads widen.', send: 'Send to computer', sending: 'Sending…', saved: 'Saved on this phone; it sends when the computer is reachable',
    sSent: 'Sent', stNew: 'in inbox', stUsed: 'handed to the team', stDismissed: 'dismissed', stQueued: 'waiting to send', noIdeas: 'No ideas sent yet.', tooShort: 'Write a little more.', inboxFull: 'The inbox on the computer is full (50 unhandled). Clear some there first.',
    unpair: 'Disconnect this phone', unpairQ: 'You will need a new pairing code to connect again. Disconnect?', justNow: 'just now', mAgo: '{n} min ago', hAgo: '{n} h ago', dAgo: '{n} d ago',
  };
  const t = (k, v) => String(T[k] ?? k).replace(/\{(\w+)\}/g, (m, n) => (v && n in v ? v[n] : m));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ls = { get(k, d) { try { const v = localStorage.getItem(`helmc.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem(`helmc.${k}`, JSON.stringify(v)); } catch { /* 隐私模式 */ } }, del(k) { try { localStorage.removeItem(`helmc.${k}`); } catch { /* 同上 */ } } };
  const $ = (s) => document.querySelector(s);
  const S = { token: ls.get('token', null), tab: 'now', sum: ls.get('sum', null), ideas: ls.get('ideas', []), queue: ls.get('queue', []), online: null, busy: false, pairErr: '', ideaMsg: '', draft: ls.get('draft', '') };

  async function call(path, { method = 'GET', body } = {}) {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(path, { method, headers: { ...(S.token ? { Authorization: `Bearer ${S.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal, cache: 'no-store' });
      let j = null; try { j = await r.json(); } catch { /* 空响应 */ }
      return { status: r.status, json: j || {} };
    } catch { return { status: 0, json: {} }; } finally { clearTimeout(timer); }
  }

  /* ---------------- 格式 ---------------- */
  const big = (n) => (n == null ? '—' : n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k` : String(n));
  const pct = (v) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v * 100).toFixed(2)}%`);
  const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? t('justNow') : m < 60 ? t('mAgo', { n: m }) : m < 1440 ? t('hAgo', { n: Math.round(m / 60) }) : t('dAgo', { n: Math.round(m / 1440) }); };
  const dur = (m) => (m < 90 ? `${m} ${t('min')}` : `${(m / 60).toFixed(1)} ${t('hr')}`);
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const REASON = { usd: 'rUsd', time: 'rTime', rounds: 'rRounds', 'no-progress': 'rNoProgress', 'holdout-pending': 'rHoldout', user: 'rUser', cost: 'rCost', restart: 'rRestart' };
  const VERDICT = { found: ['vFound', 'ok'], 'holdout-fail': ['vHoldFail', 'no'], 'dev-pass': ['vDevPass', 'ok'], 'dev-fail': ['vDevFail', 'no'], 'no-signal': ['vNoSignal', 'no'], pending: ['vPending', 'wait'] };

  /* ---------------- 画面 ---------------- */
  function pairHTML() {
    return `<section class="pair">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><g stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M12 1.8v3.4M12 18.8v3.4M1.8 12h3.4M18.8 12h3.4M4.8 4.8l2.4 2.4M16.8 16.8l2.4 2.4M4.8 19.2l2.4-2.4M16.8 7.2l2.4-2.4"/></g></svg>
      <h1>${t('pairH')}</h1><p>${t('pairP')}</p>
      <form id="pairForm"><input id="pairCode" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="6" placeholder="000000" aria-label="${t('pairH')}">
      <button class="btn primary" type="submit" ${S.busy ? 'disabled' : ''}>${S.busy ? t('pairing') : t('pairBtn')}</button></form>
      <p class="err" role="alert">${esc(S.pairErr)}</p></section>`;
  }

  function heroHTML(s) {
    if (!s) return `<div class="hero"><div class="eyebrow">${t('sSearch')}</div><h1>${t('hNone')}</h1><p>${t('pNone')}</p></div>`;
    const eyebrow = `${t('sSearch')}${s.continuous || s.round > 1 ? ` · ${s.state === 'running' ? t('round', { n: s.round }) : t('rounds', { n: s.rounds })}` : ''}`;
    const why = s.reason && REASON[s.reason] ? ` ${t(REASON[s.reason])}` : s.reason && s.state === 'error' ? ` ${esc(String(s.reason).slice(0, 140))}` : '';
    if (s.state === 'running') return `<div class="hero"><div class="eyebrow">${eyebrow}</div><h1><span class="live"></span>${t('hRunning')}</h1><p>${s.ideas ? t('pRunning', { n: s.ideas }) : t('pRunning0')}</p></div>`;
    if (s.state === 'found') return `<div class="hero found"><div class="eyebrow">${eyebrow}</div><h1>${s.found.length === 1 ? t('hFound1') : t('hFoundN', { n: s.found.length })}</h1><p>${t('pFound')}</p>
      ${s.found.map((f) => `<div class="found-card"><b>${esc(f.name)}</b><span class="mono">#${esc(f.projectId)}</span></div>`).join('')}</div>`;
    const head = s.state === 'error' ? 'hError' : s.state === 'stopped' ? 'hStopped' : 'hNothing';
    return `<div class="hero ${s.state === 'error' ? 'bad' : ''}"><div class="eyebrow">${eyebrow}${s.endedAt ? ` · ${ago(s.endedAt)}` : ''}</div><h1>${t(head)}</h1><p>${t('pNothing', { n: s.ideas })}${why}</p></div>`;
  }

  function nowHTML() {
    const d = S.sum;
    const bar = `<div class="bar"><span><i class="dot ${S.online === false ? 'off' : S.online ? 'on' : ''}"></i><b>${esc(d ? d.host : 'Helm')}</b></span><span>${S.online === false ? t('offline') : d ? `${t('updated')} ${clock(d.at)}` : ''}<button type="button" data-refresh>${t('refresh')}</button></span></div>`;
    if (!d) return `${bar}<div class="hero"><div class="skeleton"></div></div>${S.online === false ? `<p class="note">${t('eNet')}</p>` : ''}`;
    const s = d.search;
    let usage = '';
    if (s) {
      const share = s.capUsd ? Math.min(100, Math.round((s.costUsd / s.capUsd) * 100)) : 0;
      const tk = s.tokens;
      usage = `<section class="sec"><h2>${t('sUsage')}</h2>
        <div class="usage"><span class="big num">$${s.costUsd.toFixed(2)}</span>${s.capUsd ? `<span class="cap num">${t('of', { n: s.capUsd })}</span>` : ''}</div>
        ${s.capUsd ? `<div class="meter" role="img" aria-label="${share}%"><i data-w="${share}"></i></div>` : ''}
        <div class="grid">
          <div class="cell"><div class="k">${t('kTok')}</div><div class="v num">${tk ? big(tk.in + tk.out) : '—'}</div>${tk ? `<div class="sub num">${t('tokIn')} ${big(tk.in)} · ${t('tokOut')} ${big(tk.out)}</div>` : ''}</div>
          <div class="cell"><div class="k">${tk ? t('tokCache') : t('kTime')}</div><div class="v num">${tk ? big(tk.cache) : dur(s.minutes)}</div></div>
          <div class="cell"><div class="k">${t('kIdeas')}</div><div class="v num">${s.ideas}</div></div>
          <div class="cell"><div class="k">${t('kTests')}</div><div class="v num">${s.ideaTests}</div></div>
          <div class="cell"><div class="k">${t('kDev')}</div><div class="v num">${s.devVersions}</div></div>
          <div class="cell"><div class="k">${t('kHold')}</div><div class="v num">${s.holdoutLooks}</div></div>
        </div>${tk ? `<p class="note">${t('kTime')} · ${dur(s.minutes)}</p>` : `<p class="note">${t('tokNone')}</p>`}</section>`;
    }
    const cur = s && s.current && s.current.length ? `<section class="sec"><h2>${t('sCurrent')}</h2><ul class="list">${s.current.map((x) => { const v = VERDICT[x.verdict] || VERDICT.pending; return `<li><span class="t">${esc(x.title)}</span><span class="chip ${v[1]}">${t(v[0])}</span></li>`; }).join('')}</ul></section>` : '';
    const paper = `<section class="sec"><h2>${t('sPaper')}</h2>${d.paper.length ? `<ul class="list">${d.paper.map((p) => `<li><span class="t">${esc(p.name)}<small>${esc(p.project)} · ${p.ok ? t('days', { n: p.days }) : `<span class="down">${t('paperBad')}</span>`}</small></span>
        <span class="r"><span class="v num ${p.ret > 0 ? 'up' : p.ret < 0 ? 'down' : ''}">${pct(p.ret)}</span><small class="num">${t('vs', { v: pct(p.bench) })}</small></span></li>`).join('')}</ul>` : `<p class="note">${t('paperNone')}</p>`}</section>`;
    return `${bar}${heroHTML(s)}${S.online === false ? `<p class="note">${t('offlineP')}</p>` : ''}${usage}${cur}${paper}<div class="foot"><button type="button" class="link" data-unpair>${t('unpair')}</button></div>`;
  }

  function ideasHTML() {
    const all = [...S.queue.map((x) => ({ ...x, status: 'queued' })), ...S.ideas];
    const st = { new: 'stNew', used: 'stUsed', dismissed: 'stDismissed', queued: 'stQueued' };
    return `<div class="hero"><h1>${t('ideaH')}</h1><p>${t('ideaP')}</p></div>
      <form class="compose sec" id="ideaForm"><textarea id="ideaText" maxlength="2000" placeholder="${esc(t('ideaPh'))}" aria-label="${t('ideaH')}">${esc(S.draft)}</textarea>
      <div class="row"><span class="count" role="status">${esc(S.ideaMsg)}</span><button class="btn primary" type="submit" ${S.busy ? 'disabled' : ''}>${S.busy ? t('sending') : t('send')}</button></div></form>
      <section class="sec"><h2>${t('sSent')}</h2>${all.length ? `<ul class="list">${all.map((x) => `<li><span class="t">${esc(x.text)}<small>${ago(x.at)}</small></span><span class="chip ${x.status === 'used' ? 'ok' : x.status === 'queued' ? 'wait' : 'no'}">${t(st[x.status] || 'stNew')}</span></li>`).join('')}</ul>` : `<p class="note">${t('noIdeas')}</p>`}</section>`;
  }

  function render() {
    const app = $('#app'); const tabs = $('#tabs');
    if (!S.token) { tabs.hidden = true; app.innerHTML = pairHTML(); const i = $('#pairCode'); if (i && !S.busy) i.focus(); return; }
    tabs.hidden = false;
    for (const b of tabs.querySelectorAll('button')) { if (b.dataset.tab === S.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }
    for (const el of tabs.querySelectorAll('[data-t]')) el.textContent = t(el.dataset.t);
    const qb = $('#queueBadge'); qb.hidden = !S.queue.length; qb.textContent = S.queue.length;
    // 正在写想法时后台刷新不重画，免得把光标和键盘冲掉
    if (S.tab === 'ideas' && document.activeElement && document.activeElement.id === 'ideaText' && !render.force) return;
    render.force = false;
    app.innerHTML = S.tab === 'ideas' ? ideasHTML() : nowHTML();
    for (const m of app.querySelectorAll('[data-w]')) m.style.width = `${Number(m.dataset.w) || 0}%`; // 页面不允许内联样式（CSP），宽度用脚本设
  }

  /* ---------------- 数据 ---------------- */
  function dropToken() { S.token = null; ls.del('token'); S.sum = null; ls.del('sum'); S.ideas = []; ls.del('ideas'); }
  async function refresh() {
    if (!S.token) return;
    const r = await call('/api/summary');
    if (r.status === 401) { dropToken(); render.force = true; return render(); }
    S.online = r.status === 200;
    if (S.online) { S.sum = r.json; ls.set('sum', S.sum); await flushQueue(); const i = await call('/api/ideas'); if (i.status === 200) { S.ideas = i.json.ideas || []; ls.set('ideas', S.ideas); } }
    render();
  }
  async function flushQueue() {
    while (S.queue.length) {
      const q = S.queue[0];
      const r = await call('/api/ideas', { method: 'POST', body: { text: q.text } });
      if (r.status === 200 || r.status === 400) { S.queue.shift(); ls.set('queue', S.queue); } else break; // 400 = 这条内容电脑不收（太短 / 太长），不再反复发
    }
  }
  async function sendIdea(text) {
    const tx = text.trim();
    if (tx.length < 4) { S.ideaMsg = t('tooShort'); render.force = true; return render(); }
    S.busy = true; S.ideaMsg = ''; render.force = true; render();
    const r = await call('/api/ideas', { method: 'POST', body: { text: tx } });
    S.busy = false;
    if (r.status === 200) { S.ideas = [r.json.idea, ...S.ideas]; ls.set('ideas', S.ideas); S.draft = ''; ls.del('draft'); S.ideaMsg = ''; S.online = true; }
    else if (r.status === 401) { dropToken(); }
    else if (r.status === 429) { S.ideaMsg = t('inboxFull'); }
    else if (r.status === 400) { S.ideaMsg = t('tooShort'); }
    else { S.queue = [{ id: `q${Date.now()}`, at: Date.now(), text: tx }, ...S.queue]; ls.set('queue', S.queue); S.draft = ''; ls.del('draft'); S.ideaMsg = t('saved'); S.online = false; }
    render.force = true; render();
  }

  /* ---------------- 事件 ---------------- */
  document.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (e.target.id === 'pairForm') {
      const code = $('#pairCode').value.replace(/\D/g, '');
      if (code.length !== 6 || S.busy) return;
      S.busy = true; S.pairErr = ''; render();
      const r = await call('/api/pair', { method: 'POST', body: { code } });
      S.busy = false;
      if (r.status === 200 && r.json.token) { S.token = r.json.token; ls.set('token', S.token); S.online = true; render(); return refresh(); }
      S.pairErr = r.status === 0 || r.status === 503 ? t('eNet') : r.status === 429 ? t('eMany') : r.json.error === 'no-code' ? t('eNoCode') : t('eWrong');
      render();
    } else if (e.target.id === 'ideaForm') sendIdea($('#ideaText').value);
  });
  document.addEventListener('input', (e) => { if (e.target.id === 'ideaText') { S.draft = e.target.value; ls.set('draft', S.draft); } });
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) { S.tab = tab.dataset.tab; S.ideaMsg = ''; render.force = true; render(); $('#app').scrollTop = 0; return; }
    if (e.target.closest('[data-refresh]')) { refresh(); return; }
    if (e.target.closest('[data-unpair]') && window.confirm(t('unpairQ'))) { dropToken(); render.force = true; render(); }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden && S.token) refresh(); }, 20000);

  render();
  refresh();
})();
