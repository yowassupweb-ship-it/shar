import { useEffect, useRef, type RefObject } from 'react';
import { isEdgeSwipeStart } from '@/shared/platform/viewport';
import { setPanel, useChatStore } from './store';

/**
 * Жест «назад» от левого края — как в iOS: переписка уезжает за пальцем,
 * из-под неё выдвигается список. Открыт профиль — уезжает он.
 *
 * Только установленное на iPhone приложение: во вкладке Safari у системы
 * свой такой жест (он ведёт по истории — туда же, куда и наш), на Android —
 * системная «назад». Слушатели нативные: движение нужно отменять (passive:
 * false) и не отдавать ленте, иначе палец у края начинал бы ещё и свайп
 * ответа по сообщению.
 */

const DONE_SHARE = 0.35;
const FLICK = 0.5; // px/мс
const EASE = 'transform .24s cubic-bezier(.25, 1, .5, 1)';

export function useEdgeBack(sectionRef: RefObject<HTMLElement | null>, enabled: boolean, onBack: () => void) {
  const backRef = useRef(onBack);
  useEffect(() => { backRef.current = onBack; }, [onBack]);

  useEffect(() => {
    const section = sectionRef.current;
    const layout = section?.parentElement;
    if (!enabled || !section || !layout) return undefined;

    let on = false;
    let decided = false;
    let profile = false;
    let x0 = 0;
    let y0 = 0;
    let t0 = 0;
    let dx = 0;
    let el: HTMLElement | null = null;
    let list: HTMLElement | null = null;
    let finish = 0;

    const reset = () => {
      if (el) { el.style.transition = ''; el.style.transform = ''; }
      if (list) { list.style.transition = ''; }
      layout.removeAttribute('data-edge');
      layout.style.removeProperty('--edge-p');
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1 || finish) return;
      const t = e.touches[0];
      if (!isEdgeSwipeStart(t.clientX)) return;
      on = true;
      decided = false;
      x0 = t.clientX;
      y0 = t.clientY;
      t0 = performance.now();
      dx = 0;
    };

    const onMove = (e: TouchEvent) => {
      if (!on) return;
      const t = e.touches[0];
      const mx = t.clientX - x0;
      const my = t.clientY - y0;
      if (!decided) {
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
        if (mx <= 0 || Math.abs(my) > mx) { on = false; return; }
        decided = true;
        profile = useChatStore.getState().panel === 'profile';
        el = profile ? section.querySelector<HTMLElement>('.cxp') : section;
        if (!el) { on = false; return; }
        list = profile ? null : layout.querySelector<HTMLElement>('.cxl');
        el.style.transition = 'none';
        if (!profile) layout.setAttribute('data-edge', 'true');
      }
      e.stopPropagation();
      if (e.cancelable) e.preventDefault();
      dx = Math.max(0, mx);
      el!.style.transform = `translateX(${dx}px)`;
      if (!profile) layout.style.setProperty('--edge-p', String(Math.min(1, dx / section.offsetWidth)));
    };

    const onEnd = (e: TouchEvent) => {
      if (!on) return;
      on = false;
      if (!decided || !el) return;
      e.stopPropagation();
      const w = el.offsetWidth;
      const speed = dx / Math.max(1, performance.now() - t0);
      const done = dx > w * DONE_SHARE || (speed > FLICK && dx > 40);
      el.style.transition = EASE;
      el.style.transform = `translateX(${done ? w : 0}px)`;
      if (list) list.style.transition = EASE;
      if (!profile) layout.style.setProperty('--edge-p', done ? '1' : '0');
      finish = window.setTimeout(() => {
        finish = 0;
        if (!done) { reset(); return; }
        // Экран уже уехал: не возвращаем его на место до того, как React его
        // уберёт, — иначе мелькнёт кадр со старой перепиской.
        if (profile) setPanel(null);
        else backRef.current();
        window.setTimeout(reset, 400);
      }, 240);
    };

    section.addEventListener('touchstart', onStart, { capture: true, passive: true });
    section.addEventListener('touchmove', onMove, { capture: true, passive: false });
    section.addEventListener('touchend', onEnd, { capture: true });
    section.addEventListener('touchcancel', onEnd, { capture: true });
    return () => {
      window.clearTimeout(finish);
      section.removeEventListener('touchstart', onStart, { capture: true });
      section.removeEventListener('touchmove', onMove, { capture: true });
      section.removeEventListener('touchend', onEnd, { capture: true });
      section.removeEventListener('touchcancel', onEnd, { capture: true });
      layout.removeAttribute('data-edge');
      layout.style.removeProperty('--edge-p');
    };
  }, [sectionRef, enabled]);
}
