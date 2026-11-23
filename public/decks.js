'use strict';
/* 研发汇报：一键把项目的回测结果做成幻灯片（pptx + PDF）。
   页面部分：项目里的「汇报」标签（列表 / 单份汇报的进度、大纲确认、评审、预览、下载）和「生成汇报」对话框（模板在最上面，先选模板再生成）。
   用 app.js 的 $ / esc / safePost / toast / renderMain / S，不改它的数据结构。 */
(() => {
  const STAGES = ['data', 'outline', 'build', 'review', 'fix', 'render', 'pdf'];
  const D = { list: null, listFor: null, deck: null, deckFor: null, settings: null, loading: false };
  const isEn = () => HELM_I18N.lang() === 'en';
  const when = (s) => { try { return new Date(s).toLocaleString(HELM_I18N.locale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return s || ''; } };
  const icon = {
    deck: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2.5 3h11v7.5h-11zM8 10.5V13M5.5 13h5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 8.2V7M8 8.2V5.5M11 8.2V6.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    dl: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  /* ---------------- 数据 ---------------- */
  async function loadList(projectId, silent) {
    if (!silent || D.listFor !== projectId) { D.list = null; D.listFor = projectId; }
    const r = await safePost('/api/decks/list', { projectId });
    if (D.listFor !== projectId) return;
    D.list = r.success ? r.decks : { error: (r.errors || []).join('; ') };
    rerender();
  }
  async function loadDeck(projectId, deckId, silent) {
    if (!silent || D.deckFor !== deckId) { D.deck = null; D.deckFor = deckId; }
    const r = await safePost('/api/decks/read', { projectId, deckId });
    if (D.deckFor !== deckId) return;
    D.deck = r.success ? r.deck : { error: (r.errors || []).join('; ') };
    rerender();
  }
  async function loadSettings() {
    const r = await safePost('/api/decks/settings', {});
    D.settings = r.success ? r.settings : null;
    return D.settings;
  }
  function onTab() {
    return S.route.view === 'project' && S.route.tab === 'reports';
  }
  function rerender() {
    if (!onTab()) return;
    // 正在输入修改意见时不重画，免得把字冲掉
    const ta = document.getElementById('dkNote');
    const keep = ta && document.activeElement === ta ? ta.value : null;
    if (keep != null) return;
    renderMain();
  }
  /** 进入「汇报」标签时调用 */
  function load(projectId, deckId) {
    if (deckId) loadDeck(projectId, deckId);
    else loadList(projectId);
  }

  /* ---------------- 标签页 ---------------- */
  const audT = (a) => (a === 'client' ? _t('dk010') : _t('dk009'));
  const langT = (l) => (l === 'en' ? 'English' : '中文');
  const stageT = (s) => _t({ data: 'dk020', outline: 'dk021', build: 'dk022', review: 'dk023', fix: 'dk024', render: 'dk025', pdf: 'dk026', done: 'dk027' }[s] || 'dk020');
  function gradeHTML(g) {
    if (!g) return '';
    const k = String(g).toLowerCase();
    const label = { green: _t('dk030'), yellow: _t('dk031'), red: _t('dk032') }[k] || esc(g);
    return `<span class="dk-grade ${k}" title="${_t('dk033')}"><i></i>${label}</span>`;
  }
  function statusHTML(d) {
    if (d.status === 'done') return `<span class="badge done"><span class="led"></span>${_t('dk027')}</span>`;
    if (d.status === 'awaiting') return `<span class="badge run dk-wait"><span class="led"></span>${_t('dk028')}</span>`;
    if (d.status === 'error') return `<span class="badge err">${d.error === 'interrupted' ? _t('dk035') : _t('dk029')}</span>`;
    return `<span class="badge run"><span class="led"></span>${stageT(d.stage)}</span>`;
  }

  function tabHTML(projectId) {
    const deckId = S.route.deckId;
    if (deckId) return detailHTML(projectId, deckId);
    const intro = `<div class="dk-intro"><p>${_t('dk001')}</p><button class="btn primary" data-dk="new">${icon.deck}${_t('dk002')}</button></div>`;
    const list = D.listFor === projectId ? D.list : null;
    if (list && list.error) return `${intro}${errorBox(_t('dk003'), list.error)}`;
    if (!Array.isArray(list)) return `${intro}<div class="skeleton" style="height:120px"></div>`;
    if (!list.length) return `${intro}<div class="panel empty"><div class="big">${_t('dk004')}</div><p>${_t('dk005')}</p></div>`;
    return `${intro}<div class="panel"><div class="table-wrap"><table class="data dk-table"><thead><tr><th>${_t('dk006')}</th><th>${_t('dk007')}</th><th>${_t('dk008')}</th><th>${_t('dk033')}</th><th>${_t('dk011')}</th><th class="r"></th></tr></thead><tbody>
      ${list.map((d) => `<tr data-href="#/p/${projectId}/reports/${esc(d.deckId)}"><td class="name" title="${esc(d.title || '')}">${esc(d.title || _t('dk012'))}</td>
        <td>${audT(d.options?.audience)} · ${langT(d.options?.lang)}</td><td>${statusHTML(d)}</td><td>${gradeHTML(d.grade)}</td><td class="mono when">${esc(when(d.createdAt))}</td>
        <td class="r dk-dl">${d.files?.pdf ? `<a class="btn sm" href="${fileUrl(projectId, d.deckId, 'pdf')}" download>PDF</a>` : ''}${d.files?.pptx ? `<a class="btn sm" href="${fileUrl(projectId, d.deckId, 'pptx')}" download>PPTX</a>` : ''}</td></tr>`).join('')}
    </tbody></table></div></div>`;
  }
  const fileUrl = (projectId, deckId, kind) => `/api/decks/file?${new URLSearchParams({ projectId, deckId, kind })}`;
  const pageUrl = (projectId, deckId, n, v) => `/api/decks/page?${new URLSearchParams({ projectId, deckId, n, v: v || '' })}`;

  function stepsHTML(d) {
    const cur = d.status === 'done' ? STAGES.length : STAGES.indexOf(d.stage);
    const awaiting = d.status === 'awaiting';
    return `<ol class="dk-steps">${STAGES.map((s, i) => {
      const st = i < cur || (awaiting && i <= 1) ? 'done' : i === cur ? (d.status === 'error' ? 'err' : 'now') : 'todo';
      return `<li class="${st}"><i>${st === 'done' ? '✓' : i + 1}</i><span>${stageT(s)}</span></li>`;
    }).join('')}</ol>`;
  }

  function outlineHTML(d) {
    const o = d.outline;
    if (!o) return '';
    const sections = o.sections || [];
    const by = new Map();
    (o.slides || []).forEach((s, i) => { const k = Number.isInteger(s.section) ? s.section : -1; if (!by.has(k)) by.set(k, []); by.get(k).push({ ...s, n: i + 1 }); });
    const groups = [...by.entries()].sort((a, b) => a[0] - b[0]);
    const editable = d.status === 'awaiting';
    return `<section class="panel section dk-outline">
      <div class="panel-head"><h2>${_t('dk040')}</h2><span class="meta">${_t('dk041', { n: (o.slides || []).length })}</span></div>
      <div class="dk-gt"><span>${_t('dk042')}</span><p>${esc(o.governingThoughtFilled || o.governingThought || '')}</p></div>
      ${o.storyline ? `<p class="dk-story">${esc(o.storylineFilled || o.storyline)}</p>` : ''}
      ${groups.map(([k, slides]) => `<div class="dk-sec"><h3>${k >= 0 && sections[k] ? `<b>${['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'][k] || k + 1}.</b> ${esc(sections[k])}` : ''}</h3>
        <ol>${slides.map((s) => `<li value="${s.n}"><div class="dk-t">${esc(s.titleFilled || s.title || '')}</div>
          ${(s.pointsFilled || s.points || []).length ? `<ul>${(s.pointsFilled || s.points).map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
          <span class="dk-vis">${esc(layoutT(s.layout))}${s.visual ? ` · ${esc(s.visual)}` : ''}</span></li>`).join('')}</ol></div>`).join('')}
      ${editable ? `<div class="dk-approve">
        <label class="field"><span>${_t('dk043')}</span><textarea id="dkNote" rows="2" maxlength="2000" placeholder="${_t('dk044')}"></textarea></label>
        <div class="modal-actions"><button class="btn" data-dk="redo">${_t('dk045')}</button><button class="btn primary" data-dk="approve">${_t('dk046')}</button></div>
        <p class="modal-hint">${_t('dk047')}</p></div>` : ''}
    </section>`;
  }
  const layoutT = (l) => ({ exec_summary: _t('dk050'), chart: _t('dk051'), two_charts: _t('dk052'), kpis: _t('dk053'), table: _t('dk054'), bullets: _t('dk055'), divider: _t('dk056') }[l] || l || '');

  function reviewHTML(d) {
    const r = d.review;
    if (!r) return '';
    const fixes = (r.fixes || []).slice(0, 3);
    const changes = r.changes || [];
    return `<section class="panel section dk-review">
      <div class="panel-head"><h2>${_t('dk060')}</h2>${gradeHTML(r.grade)}</div>
      ${r.verdict ? `<p class="dk-verdict">${esc(r.verdict)}</p>` : ''}
      <div class="dk-cols">
        ${fixes.length ? `<div><h3>${_t('dk061')}</h3><ol>${fixes.map((f) => `<li><b>${esc(f.title || '')}</b><span>${esc(f.instruction || '')}</span></li>`).join('')}</ol></div>` : ''}
        ${changes.length ? `<div><h3>${_t('dk062')}</h3><ul>${changes.slice(0, 8).map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>` : ''}
      </div>
      ${r.works ? `<p class="dk-works"><span>${_t('dk063')}</span>${esc(r.works)}</p>` : ''}
    </section>`;
  }

  function issuesHTML(d) {
    const nums = (d.issues || []).filter((x) => x.kind === 'rawNumber' || x.kind === 'unknownFact');
    const codes = (d.issues || []).filter((x) => x.kind === 'jargon');
    const warns = (d.warnings || []).filter((w) => !/^pdf:/.test(w));
    const pdfWarn = (d.warnings || []).find((w) => /^pdf:/.test(w));
    if (!nums.length && !codes.length && !warns.length && !pdfWarn) {
      return d.status === 'done' ? `<p class="dk-ok">✓ ${_t('dk070')}</p>` : '';
    }
    return `<section class="panel section dk-issues"><div class="panel-head"><h2>${_t('dk071')}</h2></div>
      ${nums.length ? `<p class="modal-hint">${_t('dk072')}</p><ul>${nums.map((x) => `<li><code>${esc(x.detail)}</code> ${esc(x.text || '')}</li>`).join('')}</ul>` : ''}
      ${codes.length ? `<p class="modal-hint">${_t('dk076')}</p><ul>${codes.map((x) => `<li><code>${esc(x.detail)}</code> ${esc(x.text || '')}</li>`).join('')}</ul>` : ''}
      ${warns.length ? `<ul>${warns.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      ${pdfWarn ? `<p class="modal-hint warn-t">${/not installed/.test(pdfWarn) ? _t('dk073') : _t('dk074')}</p>` : ''}
    </section>`;
  }

  function previewHTML(projectId, d) {
    if (!d.pages) return '';
    const v = encodeURIComponent(d.finishedAt || d.updatedAt || '');
    return `<section class="panel section"><div class="panel-head"><h2>${_t('dk080')}</h2><span class="meta">${_t('dk081', { n: d.pages })}</span></div>
      <div class="dk-pages">${Array.from({ length: d.pages }, (_, i) => `<button class="dk-page" data-dk-page="${i + 1}" aria-label="${_t('dk082', { n: i + 1 })}"><img loading="lazy" src="${pageUrl(projectId, d.deckId, i + 1, v)}" alt=""><span>${i + 1}</span></button>`).join('')}</div></section>`;
  }

  function detailHTML(projectId, deckId) {
    const back = `<a class="dk-back" href="#/p/${projectId}/reports">← ${_t('dk090')}</a>`;
    const d = D.deckFor === deckId ? D.deck : null;
    if (d && d.error && !d.deckId) return `${back}${errorBox(_t('dk003'), d.error)}`;
    if (!d) return `${back}<div class="skeleton" style="height:200px"></div>`;
    const o = d.options || {};
    const busy = d.status === 'running';
    const actions = [
      d.files?.pdf ? `<a class="btn primary" href="${fileUrl(projectId, deckId, 'pdf')}" download>${icon.dl}PDF</a>` : '',
      d.files?.pptx ? `<a class="btn ${d.files?.pdf ? '' : 'primary'}" href="${fileUrl(projectId, deckId, 'pptx')}" download>${icon.dl}PowerPoint</a>` : '',
      d.status === 'done' ? `<button class="btn" data-dk="rerender" title="${_t('dk092')}">${_t('dk091')}</button>` : '',
      d.status === 'error' ? `<button class="btn primary" data-dk="retry">${_t('dk093')}</button>` : '',
      !busy ? `<button class="btn quiet-del" data-dk="delete" title="${_t('dk094')}" aria-label="${_t('dk094')}"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` : '',
    ].join('');
    const err = d.status === 'error' ? errorBox(d.error === 'interrupted' ? _t('dk035') : _t('dk029'), d.error === 'interrupted' ? _t('dk036') : zhErr(d.error || '')) : '';
    const running = busy ? `<p class="dk-running">${_t('dk095')}</p>` : '';
    return `${back}<div class="dk-head"><div><h2>${esc(d.title || _t('dk012'))}</h2>
        <p class="meta">${audT(o.audience)} · ${langT(o.lang)} · ${o.length === 'short' ? _t('dk013') : _t('dk014')} · ${o.quality === 'best' ? _t('dk015') : _t('dk016')} · ${esc(when(d.createdAt))}</p></div>
        <div class="actions">${actions}</div></div>
      ${stepsHTML(d)}${running}${err}
      ${d.status === 'awaiting' ? outlineHTML(d) : ''}
      ${d.status === 'done' ? `${issuesHTML(d)}${previewHTML(projectId, d)}${reviewHTML(d)}` : ''}
      ${d.status !== 'awaiting' && d.outline ? `<details class="dk-more"><summary>${_t('dk096')}</summary>${outlineHTML(d)}</details>` : ''}`;
  }

  /* ---------------- 大图预览 ---------------- */
  let viewer = null;
  let vPage = 1;
  function openViewer(n) {
    const d = D.deck;
    if (!d || !d.pages) return;
    if (!viewer) {
      viewer = document.createElement('dialog');
      viewer.className = 'modal dk-viewer';
      viewer.setAttribute('aria-label', _t('dk080'));
      document.body.appendChild(viewer);
      viewer.addEventListener('click', (e) => {
        if (e.target === viewer) return viewer.close();
        const b = e.target.closest('[data-v]');
        if (b) step(b.dataset.v === 'next' ? 1 : b.dataset.v === 'prev' ? -1 : 0);
      });
      viewer.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') step(1); if (e.key === 'ArrowLeft') step(-1); });
    }
    vPage = n;
    drawViewer();
    if (!viewer.open) viewer.showModal();
  }
  function step(k) {
    if (!k) return viewer.close();
    const d = D.deck;
    vPage = Math.min(d.pages, Math.max(1, vPage + k));
    drawViewer();
  }
  function drawViewer() {
    const d = D.deck;
    const v = encodeURIComponent(d.finishedAt || d.updatedAt || '');
    viewer.innerHTML = `<img src="${pageUrl(S.route.projectId, d.deckId, vPage, v)}" alt="${_t('dk082', { n: vPage })}">
      <div class="dk-vbar"><button class="btn sm" data-v="prev" ${vPage <= 1 ? 'disabled' : ''} aria-label="${_t('dk097')}">←</button><span>${vPage} / ${d.pages}</span><button class="btn sm" data-v="next" ${vPage >= d.pages ? 'disabled' : ''} aria-label="${_t('dk098')}">→</button><button class="btn sm" data-v="close">${_t('dk099')}</button></div>`;
  }

  /* ---------------- 生成对话框 ---------------- */
  let dlg = null;
  let dlgProject = null;
  function ensureDialog() {
    if (dlg) return dlg;
    dlg = document.createElement('dialog');
    dlg.className = 'modal dk-new';
    dlg.setAttribute('aria-labelledby', 'dkH');
    document.body.appendChild(dlg);
    dlg.addEventListener('click', onDialogClick);
    dlg.addEventListener('change', onDialogChange);
    dlg.addEventListener('submit', (e) => { e.preventDefault(); create(); });
    return dlg;
  }
  async function openCreate(projectId) {
    dlgProject = projectId;
    ensureDialog();
    dlg.innerHTML = `<form><h2 id="dkH">${_t('dk002')}</h2><div class="skeleton" style="height:240px"></div></form>`;
    dlg.showModal();
    await loadSettings();
    drawDialog();
  }
  function swatch(c, label) {
    return `<span class="dk-sw" title="${esc(label)} #${esc(c)}"><i style="background:#${/^[0-9A-Fa-f]{6}$/.test(c) ? c : 'ccc'}"></i>${esc(label)}</span>`;
  }
  function templateHTML() {
    const st = D.settings || {};
    const t = st.template;
    const pal = t ? t.palette || {} : { highlight: 'FFF22D', accent: 'C8102E', dark: '121316' };
    const name = t ? esc(st.templateName || '') : _t('dk101');
    const kind = t ? (t.kind === 'pdf' ? _t('dk102') : t.useMaster ? _t('dk103') : _t('dk104')) : _t('dk105');
    const prev = t && st.hasPreview ? `<img class="dk-tprev" src="/api/decks/template-preview?v=${encodeURIComponent(st.templateName || '')}" alt="">` : `<div class="dk-tprev dk-tdefault" aria-hidden="true"><b></b><i></i><em></em><span></span></div>`;
    return `<fieldset class="dk-tpl"><legend>${_t('dk100')}</legend>
      <div class="dk-trow">${prev}<div class="dk-tinfo"><b>${name}</b><span>${kind}</span>
        <div class="dk-sws">${swatch(pal.highlight, _t('dk106'))}${swatch(pal.accent, _t('dk107'))}${swatch(pal.dark, _t('dk108'))}</div>
        ${t && t.note === 'not16x9' ? `<p class="modal-hint warn-t">${_t('dk109')}</p>` : ''}
        <div class="dk-tbtns"><label class="btn sm dk-file">${_t('dk110')}<input type="file" id="dkTplFile" accept=".pptx,.potx,.pdf"></label>${t ? `<button type="button" class="btn sm" data-dk="tpl-clear">${_t('dk111')}</button>` : ''}</div>
      </div></div>
      <p class="modal-hint">${_t('dk112')}</p>
      <div class="dk-grid2">
        <label class="field"><span>${_t('dk113')}</span><input id="dkFirm" maxlength="200" value="${esc(st.firm || '')}" placeholder="${_t('dk114')}"></label>
        <label class="field"><span>${_t('dk115')}</span><input id="dkPresenter" maxlength="200" value="${esc(st.presenter || '')}" placeholder="${_t('dk116')}"></label>
      </div>
      <div class="dk-logo"><span>${_t('dk117')}</span>${st.logo ? `<em>✓ ${_t('dk118')}</em><button type="button" class="btn sm" data-dk="logo-clear">${_t('dk119')}</button>` : `<em>${_t('dk120')}</em>`}<label class="btn sm dk-file">${st.logo ? _t('dk121') : _t('dk122')}<input type="file" id="dkLogoFile" accept=".png,.jpg,.jpeg"></label></div>
    </fieldset>`;
  }
  function backtestsHTML() {
    const bts = (Array.isArray(S.backtests) ? S.backtests : []).filter((b) => /Completed/i.test(b.status || ''));
    if (!bts.length) return `<p class="modal-hint warn-t">${_t('dk130')}</p>`;
    return `<details class="dk-bts"><summary>${_t('dk131')}</summary><p class="modal-hint">${_t('dk132')}</p>
      <div class="dk-btlist">${bts.slice(0, 40).map((b) => `<label><input type="checkbox" name="dkBt" value="${esc(b.backtestId)}"><span>${esc(b.name || b.backtestId)}</span>${b.period === 'holdout' ? `<em>${_t('k0176')}</em>` : b.period === 'dev' ? `<em>${_t('k0175')}</em>` : ''}${b.role === 'main' ? `<em class="main">${_t('k0157')}</em>` : ''}</label>`).join('')}</div></details>`;
  }
  function drawDialog() {
    const st = D.settings || {};
    const lang = isEn() ? 'en' : 'zh';
    dlg.innerHTML = `<form>
      <h2 id="dkH">${_t('dk002')}</h2>
      <p class="modal-hint">${_t('dk140')}</p>
      ${templateHTML()}
      <fieldset class="dk-opts"><legend>${_t('dk141')}</legend>
        <div class="dk-seg" role="radiogroup" aria-label="${_t('dk007')}"><span>${_t('dk142')}</span>
          <label><input type="radio" name="dkAud" value="team" checked><b>${_t('dk009')}</b><i>${_t('dk143')}</i></label>
          <label><input type="radio" name="dkAud" value="client"><b>${_t('dk010')}</b><i>${_t('dk144')}</i></label></div>
        <div class="dk-seg"><span>${_t('dk145')}</span>
          <label><input type="radio" name="dkLang" value="zh" ${lang === 'zh' ? 'checked' : ''}><b>中文</b></label>
          <label><input type="radio" name="dkLang" value="en" ${lang === 'en' ? 'checked' : ''}><b>English</b></label></div>
        <div class="dk-seg"><span>${_t('dk146')}</span>
          <label><input type="radio" name="dkLen" value="standard" checked><b>${_t('dk014')}</b></label>
          <label><input type="radio" name="dkLen" value="short"><b>${_t('dk013')}</b></label></div>
        <div class="dk-seg"><span>${_t('dk147')}</span>
          <label><input type="radio" name="dkQ" value="standard" checked><b>${_t('dk016')}</b></label>
          <label><input type="radio" name="dkQ" value="best"><b>${_t('dk015')}</b><i>${_t('dk148')}</i></label></div>
        <div id="dkDisc" hidden><label class="field"><span>${_t('dk149')}</span><textarea id="dkDisclaimer" rows="3" maxlength="4000" placeholder="${_t('dk150')}">${esc((lang === 'en' ? st.disclaimerEn : st.disclaimer) || '')}</textarea></label></div>
        ${backtestsHTML()}
        <label class="field"><span>${_t('dk151')}</span><textarea id="dkNotes" rows="2" maxlength="2000" placeholder="${_t('dk152')}"></textarea></label>
        <label class="dk-check"><input type="checkbox" id="dkReview" checked><span>${_t('dk153')}</span></label>
      </fieldset>
      <p class="modal-hint">${_t('dk154')}</p>
      <div class="modal-actions"><button type="button" class="btn" data-dk="cancel">${_t('h045')}</button><button type="submit" class="btn primary" id="dkGo">${_t('dk155')}</button></div>
    </form>`;
  }
  function onDialogChange(e) {
    if (e.target.name === 'dkAud') { const box = dlg.querySelector('#dkDisc'); if (box) box.hidden = e.target.value !== 'client'; }
    if (e.target.id === 'dkTplFile' && e.target.files[0]) upload('template', e.target.files[0]);
    if (e.target.id === 'dkLogoFile' && e.target.files[0]) upload('logo', e.target.files[0]);
  }
  async function onDialogClick(e) {
    if (e.target === dlg) return;
    const b = e.target.closest('[data-dk]');
    if (!b) return;
    const k = b.dataset.dk;
    if (k === 'cancel') return dlg.close();
    if (k === 'tpl-clear' || k === 'logo-clear') {
      const keep = snapshot();
      const r = await safePost('/api/actions/deck-settings', k === 'tpl-clear' ? { clearTemplate: true } : { clearLogo: true });
      if (!r.success) return toast((r.errors || []).join('; '));
      await loadSettings();
      drawDialog();
      restore(keep);
    }
  }
  // 换模板 / logo 时整块重画，先记住已经填的选项
  function snapshot() {
    const f = dlg.querySelector('form');
    if (!f) return null;
    const v = {};
    for (const el of f.querySelectorAll('input, textarea')) {
      if (el.type === 'file') continue;
      v[el.id || `${el.name}:${el.value}`] = el.type === 'radio' || el.type === 'checkbox' ? el.checked : el.value;
    }
    return v;
  }
  function restore(v) {
    if (!v) return;
    for (const el of dlg.querySelectorAll('input, textarea')) {
      const key = el.id || `${el.name}:${el.value}`;
      if (!(key in v) || el.type === 'file') continue;
      if (el.type === 'radio' || el.type === 'checkbox') el.checked = v[key]; else el.value = v[key];
    }
    const aud = dlg.querySelector('input[name=dkAud]:checked');
    const box = dlg.querySelector('#dkDisc');
    if (box && aud) box.hidden = aud.value !== 'client';
  }
  function readFile64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }
  async function upload(kind, file) {
    const limit = kind === 'logo' ? 5 : 60;
    if (file.size > limit * 1024 * 1024) return toast(_t('dk160', { n: limit }));
    const keep = snapshot();
    const tpl = dlg.querySelector('.dk-tpl');
    if (tpl) tpl.setAttribute('aria-busy', 'true');
    toast(kind === 'logo' ? _t('dk161') : _t('dk162'));
    let r;
    try {
      const data = await readFile64(file);
      r = await safePost(kind === 'logo' ? '/api/actions/deck-logo' : '/api/actions/deck-template', { name: file.name.slice(-120), data });
    } catch (e) { r = { success: false, errors: [e.message] }; }
    if (!r.success) toast(`${_t('dk163')}${(r.errors || []).map((x) => (x === 'unsupported' ? _t('dk164') : x)).join('; ')}`);
    else toast(kind === 'logo' ? _t('dk165') : _t('dk166'));
    await loadSettings();
    drawDialog();
    restore(keep);
  }
  async function create() {
    const f = dlg.querySelector('form');
    const val = (n) => (f.querySelector(`input[name=${n}]:checked`) || {}).value;
    const audience = val('dkAud');
    const lang = val('dkLang');
    const settings = { firm: f.querySelector('#dkFirm').value.trim(), presenter: f.querySelector('#dkPresenter').value.trim() };
    const disc = f.querySelector('#dkDisclaimer');
    if (audience === 'client' && disc) settings[lang === 'en' ? 'disclaimerEn' : 'disclaimer'] = disc.value.trim();
    const go = f.querySelector('#dkGo');
    go.setAttribute('aria-busy', 'true');
    const s = await safePost('/api/actions/deck-settings', settings);
    if (!s.success) { go.removeAttribute('aria-busy'); return toast((s.errors || []).join('; ')); }
    const ids = [...f.querySelectorAll('input[name=dkBt]:checked')].map((x) => x.value);
    const body = { projectId: dlgProject, audience, lang, length: val('dkLen'), quality: val('dkQ'), notes: f.querySelector('#dkNotes').value.trim(), reviewOutline: f.querySelector('#dkReview').checked };
    if (ids.length) body.backtestIds = ids.slice(0, 6);
    const r = await safePost('/api/actions/deck-create', body);
    go.removeAttribute('aria-busy');
    if (!r.success) return toast(`${_t('dk167')}${(r.errors || []).join('; ')}`);
    dlg.close();
    toast(body.reviewOutline ? _t('dk168') : _t('dk169'));
    location.hash = `#/p/${dlgProject}/reports/${r.deck.deckId}`;
  }

  /* ---------------- 标签页里的按钮 ---------------- */
  document.addEventListener('click', async (e) => {
    const pg = e.target.closest('[data-dk-page]');
    if (pg) return openViewer(Number(pg.dataset.dkPage));
    const b = e.target.closest('[data-dk]');
    if (!b || (dlg && dlg.contains(b))) return;
    const k = b.dataset.dk;
    const projectId = S.route.projectId;
    const deckId = S.route.deckId;
    if (k === 'new') return openCreate(projectId);
    if (!deckId) return;
    const note = (document.getElementById('dkNote') || {}).value || '';
    const call = async (path, body, okMsg) => {
      b.setAttribute('aria-busy', 'true');
      const r = await safePost(path, { projectId, deckId, ...body });
      b.removeAttribute('aria-busy');
      if (!r.success) { toast((r.errors || []).join('; ')); return false; }
      if (okMsg) toast(okMsg);
      await loadDeck(projectId, deckId, true);
      return true;
    };
    if (k === 'approve') return call('/api/actions/deck-approve', { note: note.trim() }, _t('dk170'));
    if (k === 'redo') {
      if (!note.trim()) { toast(_t('dk171')); document.getElementById('dkNote')?.focus(); return; }
      return call('/api/actions/deck-redo', { note: note.trim() }, _t('dk172'));
    }
    if (k === 'retry') return call('/api/actions/deck-retry', {}, _t('dk173'));
    if (k === 'rerender') return call('/api/actions/deck-rerender', {}, _t('dk174'));
    if (k === 'delete') {
      if (!confirm(_t('dk175'))) return;
      const r = await safePost('/api/actions/deck-delete', { projectId, deckId });
      if (!r.success) return toast((r.errors || []).join('; '));
      location.hash = `#/p/${projectId}/reports`;
    }
  });

  /** 服务端推送：某份汇报有进展 */
  function onEvent(ev) {
    const pid = ev.projectId;
    const deck = ev.deck;
    if (onTab() && S.route.projectId === pid) {
      if (S.route.deckId && deck && S.route.deckId === deck.deckId) loadDeck(pid, deck.deckId, true);
      else if (!S.route.deckId) loadList(pid, true);
    }
    if (!deck) return;
    const viewing = onTab() && S.route.deckId === deck.deckId;
    const go = { label: _t('k0129'), run: () => { location.hash = `#/p/${pid}/reports/${deck.deckId}`; } };
    if (!viewing && deck.status === 'awaiting' && deck.stage === 'outline') toast(_t('dk180'), { ...go, sticky: true });
    if (!viewing && deck.status === 'done' && deck.stage === 'done') toast(_t('dk181'), go);
    if (!viewing && deck.status === 'error') toast(_t('dk182'), go);
  }

  window.HelmDecks = { tabHTML, load, openCreate, onEvent, icon };
})();
