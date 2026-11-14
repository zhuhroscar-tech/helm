// UI 语言：中文 / English。字典在 i18n-dict.js（HELM_DICT.zh / .en，键一一对应，test/i18n.test.mjs 核对）。
// 偏好存在 localStorage 'helm.lang'（auto | zh | en），写法和主题（theme.js）一致；auto = 浏览器语言以 zh 开头用中文，否则 English。
// 放在 <head> 里同步执行：先设好 <html lang>，避免闪屏。
(function (g) {
  'use strict';
  var KEY = 'helm.lang';
  var D = g.HELM_DICT || { zh: {}, en: {} };
  var pref = 'auto';
  try { var v = g.localStorage.getItem(KEY); if (v === 'zh' || v === 'en') pref = v; } catch (e) { /* 隐私模式等：当作 auto */ }

  function resolve(p) {
    if (p === 'zh' || p === 'en') return p;
    var nl = '';
    try { nl = String((g.navigator && g.navigator.language) || ''); } catch (e) { /* 忽略 */ }
    return /^zh/i.test(nl) ? 'zh' : 'en';
  }
  var lang = resolve(pref);
  function sync() { try { g.document.documentElement.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en'); } catch (e) { /* 无 DOM（测试环境） */ } }
  sync();

  // t(key, vars)：先查当前语言，缺了退回中文（中文是源），再退回键名本身。{name} 用 vars 里的同名值替换；vars 里没有的原样保留。
  function t(key, vars) {
    var d = D[lang] || {};
    var s = d[key];
    if (s == null) s = (D.zh || {})[key];
    if (s == null) s = key;
    if (vars) s = s.replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(vars, n) ? String(vars[n]) : m; });
    return s;
  }

  // 模块顶层的字典 / 表（比如 const X = { a: _t('k1') }）在语言切换后要重算：用 _regT 登记，切换时统一重跑。
  var tables = [];
  function regT(fn) { fn(); tables.push(fn); }

  // 静态 HTML：data-i18n="键"（元素文字）、data-i18n-attr="属性:键;属性:键"（title / aria-label / placeholder）
  function applyStatic(root) {
    var doc = g.document; if (!doc) return;
    root = root || doc;
    var i, els = root.querySelectorAll('[data-i18n]');
    for (i = 0; i < els.length; i++) els[i].textContent = t(els[i].getAttribute('data-i18n')).replace(/&amp;/g, '&');
    els = root.querySelectorAll('[data-i18n-attr]');
    for (i = 0; i < els.length; i++) {
      els[i].getAttribute('data-i18n-attr').split(';').forEach(function (p) {
        var kv = p.split(':'); if (kv.length === 2 && kv[0] && kv[1]) els[i].setAttribute(kv[0], t(kv[1]).replace(/&amp;/g, '&'));
      });
    }
    if (root === doc) { var ti = doc.querySelector('title[data-i18n]'); if (ti && !doc.title.includes('·')) doc.title = t(ti.getAttribute('data-i18n')); }
  }

  function setPref(p) {
    pref = p === 'zh' || p === 'en' ? p : 'auto';
    try { if (pref === 'auto') g.localStorage.removeItem(KEY); else g.localStorage.setItem(KEY, pref); } catch (e) { /* 隐私模式：本次有效 */ }
    lang = resolve(pref);
    sync();
    tables.forEach(function (f) { f(); });
    applyStatic();
  }

  var api = {
    t: t, regT: regT, applyStatic: applyStatic, setPref: setPref, dict: D,
    lang: function () { return lang; },
    pref: function () { return pref; },
    locale: function () { return lang === 'zh' ? 'zh-CN' : 'en-US'; },
    resolve: resolve,
  };
  g.HELM_I18N = api;
  g._t = t;
  g._regT = regT;
  g.t = t;
  if (g.document && g.document.addEventListener) g.document.addEventListener('DOMContentLoaded', function () { applyStatic(); });
})(typeof globalThis !== 'undefined' ? globalThis : window);
