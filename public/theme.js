// 主题：自动（跟随系统白天/黑夜）/ 浅 / 深。放在 <head> 里同步执行，避免闪屏。
(function () {
  var k = 'helm.theme', v = null;
  try { v = localStorage.getItem(k); } catch (e) {}
  if (v === 'light' || v === 'dark') document.documentElement.setAttribute('data-theme', v);
})();
