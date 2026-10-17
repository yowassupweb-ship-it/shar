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
  if (typeof navigator === 'undefined') return false;
  if ((navigator as Navigator & { standalone?: boolean }).standalone === true) return true;
  // iOS 26: у приложения, установленного по манифесту, navigator.standalone бывает пуст — смотрим display-mode.
  return /iPhone|iPad|iPod/.test(navigator.userAgent) && window.matchMedia('(display-mode: standalone)').matches;
}

/** Касание у левого края в установленном приложении — это жест «назад», а не свайп по сообщению. */
export function isEdgeSwipeStart(x: number): boolean {
  return x <= EDGE_SWIPE_PX && isIosStandalone();
}

/**
 * Высота экрана в CSS-пикселях для установленного на iPhone приложения (портрет), иначе 0.
 * iPad не трогаем: там окно бывает меньше экрана (Split View).
 */
function screenHeightCss(): number {
  if (!isIosStandalone() || typeof screen === 'undefined' || !/iPhone/.test(navigator.userAgent)) return 0;
  if (window.innerHeight <= window.innerWidth) return 0;
  // Экран — в точках, страница — в CSS-пикселях: при увеличенном масштабе (115% и т.п.) их меньше.
  // Ширину iOS не урезает — по ней и масштаб: экран 440×956 при окне 383 → страница 832.
  const scale = window.innerWidth / Math.min(screen.width, screen.height);
  if (scale < 0.5 || scale > 1.01) return 0;
  return Math.round(Math.max(screen.width, screen.height) * scale);
}

/** Масштаб видимой области при запуске (useViewportSync): у увеличенного отображения он ≠ 1. */
let launchScale = 1;
const pinched = (vv: VisualViewport) => Math.abs(vv.scale / launchScale - 1) > 0.01;

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
    // iOS 26, приложение с главного экрана: окно короче экрана (у 440×956 при масштабе 115% — 778 вместо 832),
    // ниже его края iOS ничего не рисует — чёрная полоса снизу. Замер показал: когда сам документ
    // (html, body) высотой с экран, iOS отдаёт окно целиком. Высота — постоянная (base.css, nx-ios-app),
    // при клавиатуре не снимается: иначе после неё окно оставалось коротким.
    const html = document.documentElement;
    const screenH = screenHeightCss();
    if (screenH) {
      html.classList.add('nx-ios-app');
      html.style.setProperty('--nx-screen-h', `${screenH}px`);
    }

    let raf = 0;
    let lastKb = 0;
    // Высота экрана без клавиатуры. В установленном PWA iOS сжимает не только
    // visualViewport, но порой и innerHeight — разница innerHeight − vv.height
    // тогда ≈ 0, и интерфейс «не видел» клавиатуру: оставлял под полем отступ
    // полосы «домой» (поле висело высоко). Считаем от наибольшей высоты,
    // замеренной без фокуса в поле.
    let baseline = Math.max(window.innerHeight, Math.round(vv.height));
    // Щипок-увеличение тоже меняет visualViewport — это не клавиатура. Сравниваем с масштабом при
    // запуске, а не с 1: при увеличенном масштабе отображения (115%) iOS отдаёт scale ≠ 1 всегда,
    // и подгонка под клавиатуру не работала вовсе.
    launchScale = vv.scale || 1;
    // Установленное на iPhone приложение: страницу к полю ввода двигает сам Safari — плавно, вместе
    // с клавиатурой. Любая своя подгонка (сжать корень, вернуть сдвиг, сжать заранее) за ним не
    // поспевала, и всё мигало. Здесь раскладка не меняется: поле при клавиатуре только становится
    // широким (data-kb, CSS), а шапка смещается на сдвиг Safari (--nx-pan) и остаётся наверху.
    const native = isIosStandalone();
    if (native) root.dataset.kbNative = 'true';
    const apply = () => {
      raf = 0;
      if (pinched(vv)) return;
      // Safari сдвигает видимую область к полю ввода — возвращаем (scrollTo).
      // Пока она не вернулась, корень следует за её верхом (offsetTop), иначе
      // шапка уезжает за верх экрана. offsetTop после scrollTo обновится
      // событием scroll у visualViewport — apply пересчитается сам.
      const shifted = window.scrollY !== 0 || window.scrollX !== 0 || vv.offsetTop > 0;
      if (shifted && !native) window.scrollTo(0, 0);
      const height = Math.round(vv.height);
      const editing = isEditable(document.activeElement);
      if (!editing) baseline = Math.max(Math.round(window.innerHeight), height);
      else baseline = Math.max(baseline, Math.round(window.innerHeight));
      const kb = Math.max(0, baseline - height);
      root.style.setProperty('--nx-vvh', `${height}px`);
      const open = kb > KB_MIN && editing;
      root.style.setProperty('--nx-vv-top', open && !native ? `${Math.max(0, Math.round(vv.offsetTop))}px` : '0px');
      if (native) root.style.setProperty('--nx-pan', open ? `${Math.max(0, Math.round(vv.offsetTop))}px` : '0px');
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
    // iOS 26 укорачивает окно установленного приложения уже после запуска и без события resize —
    // первый замер видел другую высоту, и корень так и оставался коротким. Пересчитываем ещё
    // несколько раз после старта и при возврате из фона.
    const settle = [100, 500, 1500, 3000].map((ms) => window.setTimeout(schedule, ms));
    const onShow = () => { if (document.visibilityState === 'visible') { schedule(); window.setTimeout(schedule, 400); } };
    document.addEventListener('visibilitychange', onShow);
    window.addEventListener('pageshow', onShow);
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
      settle.forEach((t) => window.clearTimeout(t));
      document.removeEventListener('visibilitychange', onShow);
      window.removeEventListener('pageshow', onShow);
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
      document.documentElement.classList.remove('nx-locked', 'nx-ios-app');
      document.documentElement.style.removeProperty('--nx-screen-h');
      delete root.dataset.kbNative;
      ['--nx-vvh', '--nx-vv-top', '--nx-pan'].forEach((p) => root.style.removeProperty(p));    };
  }, [rootRef]);
}

/** Видимая часть экрана в координатах fixed-позиционирования — для меню и подсказок. */
export function visibleBox(): { top: number; bottom: number; width: number } {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv || pinched(vv)) return { top: 0, bottom: window.innerHeight, width: window.innerWidth };
  return { top: vv.offsetTop, bottom: vv.offsetTop + vv.height, width: vv.width };
}
