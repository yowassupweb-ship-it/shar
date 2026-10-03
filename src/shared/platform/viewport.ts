import { useEffect, type RefObject } from 'react';

/**
 * Видимая область телефона и клавиатура — один механизм на весь новый шар.
 *
 * iOS (и Android при interactiveWidget: resizes-visual) не уменьшает окно,
 * когда выезжает клавиатура: сжимается только visualViewport, а Safari ещё и
 * сдвигает страницу вверх, чтобы показать поле. Корень `.nx` поэтому
 * привязан к видимой области: высота — visualViewport.height, верх — его
 * offsetTop (переменные --nx-vvh и --nx-vv-top, см. base.css). Композер,
 * шапка, листы и меню остаются над клавиатурой без собственной математики.
 *
 * Открытая клавиатура отмечается `data-kb="open"` на корне: нижний
 * безопасный отступ (--nx-safe-bottom) тогда равен нулю — клавиатура и так
 * закрывает полосу «домой», — а капсула меню прячется. Высота последней
 * клавиатуры (--nx-kb-last) нужна панели эмодзи: она встаёт на её место.
 */

const KB_MIN = 150;
const KB_KEY = 'nx:kb-h';
/** Ширина полосы у левого края, откуда начинается жест «назад». */
export const EDGE_SWIPE_PX = 24;

export function isCoarse(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
}

/** Установленное на iPhone приложение: у него нет системного жеста «назад»
 *  от края — его делаем сами. Во вкладке Safari жест свой, наш бы с ним спорил. */
export function isIosStandalone(): boolean {
  return typeof navigator !== 'undefined' && (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** Касание у левого края в установленном приложении — это жест «назад», а не свайп по сообщению. */
export function isEdgeSwipeStart(x: number): boolean {
  return x <= EDGE_SWIPE_PX && isIosStandalone();
}

function isEditable(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !['button', 'checkbox', 'radio', 'range', 'file', 'submit', 'reset', 'color'].includes(el.type);
  return (el as HTMLElement).isContentEditable === true;
}

const SCROLLABLE = /(auto|scroll)/;
const NATIVE_DRAG = 'input[type="range"], [role="slider"], [data-native-drag]';

/**
 * Что прокрутит палец, опущенный на `target`: 'free' — не вмешиваемся (чужой
 * оверлей, ползунок, горизонтальная лента), элемент — вертикальный скролл,
 * null — внутри корня прокручивать нечего.
 */
function scrollerFrom(target: Element | null, root: HTMLElement): 'free' | HTMLElement | null {
  if (!target || !root.contains(target)) return 'free';
  if (target.closest(NATIVE_DRAG)) return 'free';
  for (let el: Element | null = target; el && el !== root; el = el.parentElement) {
    const st = getComputedStyle(el);
    if (SCROLLABLE.test(st.overflowY) && el.scrollHeight > el.clientHeight + 1) return el as HTMLElement;
    if (SCROLLABLE.test(st.overflowX) && el.scrollWidth > el.clientWidth + 1) return 'free';
  }
  return null;
}

export function useViewportSync(rootRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = rootRef.current;
    const vv = window.visualViewport;
    if (!root || !vv || !isCoarse()) return undefined;

    try {
      const saved = Number(localStorage.getItem(KB_KEY));
      if (saved > KB_MIN) root.style.setProperty('--nx-kb-last', `${saved}px`);
    } catch { /* нет хранилища — панель эмодзи возьмёт высоту по умолчанию */ }

    // Документ заперт: iOS не может прокрутить страницу к полю ввода — только
    // сдвинуть видимую область, и её мы тут же возвращаем (scrollTo). Так было в
    // старом чате, отлаженном на iPhone. Без замка документ ездил под корнем.
    document.documentElement.classList.add('nx-locked');

    let raf = 0;
    let lastKb = 0;
    // Высота экрана без клавиатуры. В установленном PWA iOS сжимает не только
    // visualViewport, но порой и innerHeight — разница innerHeight − vv.height
    // тогда ≈ 0, и интерфейс «не видел» клавиатуру: оставлял под полем отступ
    // полосы «домой» (поле висело высоко). Считаем от наибольшей высоты,
    // замеренной без фокуса в поле.
    let baseline = Math.max(window.innerHeight, Math.round(vv.height));
    const apply = () => {
      raf = 0;
      // Щипок-увеличение тоже меняет visualViewport — это не клавиатура.
      if (Math.abs(vv.scale - 1) > 0.01) return;
      // Safari сдвигает видимую область к полю ввода — возвращаем (scrollTo).
      // Пока она не вернулась, корень следует за её верхом (offsetTop), иначе
      // шапка уезжает за верх экрана. offsetTop после scrollTo обновится
      // событием scroll у visualViewport — apply пересчитается сам.
      const shifted = window.scrollY !== 0 || window.scrollX !== 0 || vv.offsetTop > 0;
      if (shifted) window.scrollTo(0, 0);
      const height = Math.round(vv.height);
      const editing = isEditable(document.activeElement);
      if (!editing) baseline = Math.max(Math.round(window.innerHeight), height);
      else baseline = Math.max(baseline, Math.round(window.innerHeight));
      const kb = Math.max(0, baseline - height);
      root.style.setProperty('--nx-vvh', `${height}px`);
      const open = kb > KB_MIN && editing;
      root.style.setProperty('--nx-vv-top', open ? `${Math.max(0, Math.round(vv.offsetTop))}px` : '0px');
      if (open) {
        root.dataset.kb = 'open';
        if (Math.abs(kb - lastKb) > 4) {
          lastKb = kb;
          root.style.setProperty('--nx-kb-last', `${kb}px`);
          try { localStorage.setItem(KB_KEY, String(kb)); } catch { /* ignore */ }
        }
      } else {
        delete root.dataset.kb;
      }
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(apply); };

    // Первый показ клавиатуры после запуска iOS иногда не присылает resize
    // вовремя — после фокуса сверяемся с visualViewport ещё секунду.
    let poll = 0;
    const onFocus = () => {
      schedule();
      let n = 0;
      window.clearInterval(poll);
      poll = window.setInterval(() => { schedule(); if (++n >= 8) window.clearInterval(poll); }, 125);
    };
    const onBlur = () => { window.setTimeout(schedule, 50); };

    // Страница не должна ездить за пальцем. При открытой клавиатуре видимая
    // область iOS меньше окна, и «лишнее» движение — там, где нечего
    // прокручивать, или по ленте, упёршейся в край, — сдвигает саму видимую
    // область: шапка уезжала за верх экрана. Гасим движение в обоих случаях.
    let scroller: 'free' | HTMLElement | null = 'free';
    let lastY = 0;
    const onTouchStart = (e: TouchEvent) => {
      scroller = scrollerFrom(e.target as Element | null, root);
      lastY = e.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1 || !e.cancelable || scroller === 'free') return;
      const y = e.touches[0].clientY;
      const dy = y - lastY;
      lastY = y;
      if (!scroller) { e.preventDefault(); return; }
      const atTop = scroller.scrollTop <= 0;
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
      if ((dy > 0 && atTop) || (dy < 0 && atBottom)) e.preventDefault();
    };

    apply();
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, { passive: true });
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', onBlur);
    document.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(poll);
      vv.removeEventListener('resize', schedule);
      vv.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('focusout', onBlur);
      document.removeEventListener('touchstart', onTouchStart, { capture: true });
      document.removeEventListener('touchmove', onTouchMove);
      delete root.dataset.kb;
      document.documentElement.classList.remove('nx-locked');
      ['--nx-vvh', '--nx-vv-top'].forEach((p) => root.style.removeProperty(p));
    };
  }, [rootRef]);
}

/** Видимая часть экрана в координатах fixed-позиционирования — для меню и подсказок. */
export function visibleBox(): { top: number; bottom: number; width: number } {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv || Math.abs(vv.scale - 1) > 0.01) return { top: 0, bottom: window.innerHeight, width: window.innerWidth };
  return { top: vv.offsetTop, bottom: vv.offsetTop + vv.height, width: vv.width };
}
