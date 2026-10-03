/*
 * Выполняется синхронно в <head>, до React: тема и платформа должны быть
 * на <html> с первого кадра, иначе тёмная тема мигает светлой.
 * Ключи localStorage общие со старым фронтом (themePref/theme).
 */
(function () {
  var root = document.documentElement;
  try {
    var pref = localStorage.getItem('themePref');
    if (pref === 'dark') pref = 'graphite';
    if (!pref) pref = localStorage.getItem('theme') === 'dark' ? 'graphite' : 'light';
    var last = localStorage.getItem('themeLastDark');
    if (last !== 'gray' && last !== 'graphite' && last !== 'black') last = 'graphite';
    var sysDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var palette = pref === 'system' ? (sysDark ? last : 'light') : pref;
    if (['light', 'gray', 'graphite', 'black'].indexOf(palette) < 0) palette = 'light';
    root.classList.toggle('dark', palette !== 'light');
    root.setAttribute('data-theme', palette);
  } catch (e) {}
  try {
    if (window.sharDesktop) root.setAttribute('data-platform', 'electron');
  } catch (e) {}
})();
