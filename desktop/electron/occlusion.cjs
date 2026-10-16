/**
 * Какая часть окна Шара реально видна на экране.
 *
 * Chromium умеет считать перекрытие сам (CalculateNativeWinOcclusion), но у нас
 * оно выключено: перекрытое окно переставало перерисовываться, и человек видел
 * вчерашний список (см. main.cjs). Фокус окна тоже не ответ: пишут в одном окне,
 * а Шар открыт целиком на втором мониторе — смотрят на него, хотя фокуса у него
 * нет. Поэтому перекрытие считаем сами: берём сетку точек поверх окна и у
 * каждой спрашиваем у Windows, чьё окно лежит сверху (WindowFromPoint). Точки,
 * где сверху окно нашего же процесса (карточка уведомления, окно звонка), не
 * считаются перекрытием.
 *
 * koffi — вызов user32 без компиляции. Не загрузился (не Windows, нет бинарника)
 * — visibleFraction() вернёт null, и main.cjs вернётся к правилу «по фокусу».
 */

const GA_ROOT = 2;
const GRID = 7;       // 7×7 точек
const MARGIN_DIP = 6; // от рамки окна: у самого края бывают тени и невидимая рамка resize

let api = null;
let loadFailed = false;

function load() {
  if (api || loadFailed) return api;
  if (process.platform !== 'win32') { loadFailed = true; return null; }
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' });
    api = {
      WindowFromPoint: user32.func('uintptr_t __stdcall WindowFromPoint(POINT pt)'),
      GetAncestor: user32.func('uintptr_t __stdcall GetAncestor(uintptr_t hwnd, uint32_t flags)'),
      GetWindowThreadProcessId: user32.func('uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint32_t *pid)'),
    };
  } catch (err) {
    loadFailed = true;
    console.error('[occlusion] koffi unavailable, falling back to focus only:', err?.message || err);
    return null;
  }
  return api;
}

/** Доля (0..1) точек окна, над которыми нет чужих окон; null — посчитать нечем. */
function visibleFraction(win, screen) {
  const native = load();
  if (!native || !win || win.isDestroyed()) return null;
  try {
    const handle = win.getNativeWindowHandle();
    const ours = Number(handle.length >= 8 ? handle.readBigUInt64LE(0) : handle.readUInt32LE(0));
    const b = win.getBounds();
    let counted = 0;
    let visible = 0;
    const pidOut = [0];
    for (let iy = 0; iy < GRID; iy += 1) {
      for (let ix = 0; ix < GRID; ix += 1) {
        const dip = {
          x: Math.round(b.x + MARGIN_DIP + ((b.width - 2 * MARGIN_DIP) * ix) / (GRID - 1)),
          y: Math.round(b.y + MARGIN_DIP + ((b.height - 2 * MARGIN_DIP) * iy) / (GRID - 1)),
        };
        // Точка вне любого экрана (окно частично за краем) — не «перекрыта», её просто нет.
        const display = screen.getDisplayNearestPoint(dip);
        const db = display.bounds;
        if (dip.x < db.x || dip.y < db.y || dip.x >= db.x + db.width || dip.y >= db.y + db.height) continue;
        const px = screen.dipToScreenPoint(dip);
        const hwnd = native.WindowFromPoint({ x: Math.round(px.x), y: Math.round(px.y) });
        counted += 1;
        if (!hwnd) continue;
        const root = native.GetAncestor(hwnd, GA_ROOT) || hwnd;
        if (root === ours) { visible += 1; continue; }
        native.GetWindowThreadProcessId(root, pidOut);
        if (pidOut[0] === process.pid) visible += 1; // другое окно Шара (карточка, звонок) не прячет окно от человека
      }
    }
    return counted ? visible / counted : null;
  } catch (err) {
    console.error('[occlusion] check failed:', err?.message || err);
    loadFailed = true;
    return null;
  }
}

module.exports = { visibleFraction };
