import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Строка, сменившая место (перенесли вы, коллега или другое ваше устройство), не прыгает, а «переезжает»:
 * после отрисовки сравниваем положение каждого [data-flip] с прошлым и проигрываем сдвиг (FLIP).
 * Положение считаем от начала прокручиваемого списка — сама прокрутка анимацию не вызывает. Смена resetKey
 * (другой раздел, другой поиск) — новый список, его строки не «переезжают».
 */
export function useFlip(container: RefObject<HTMLElement | null>, deps: unknown[], resetKey = '') {
  const prev = useRef(new Map<string, number>());
  const lastKey = useRef(resetKey);
  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const base = root.getBoundingClientRect().top - root.scrollTop;
    const next = new Map<string, number>();
    const animate = !reducedMotion() && lastKey.current === resetKey;
    lastKey.current = resetKey;
    // Сначала все замеры, потом все анимации: запуск анимации между замерами сбрасывал стили, и каждый следующий
    // getBoundingClientRect пересчитывал их заново — на сотнях строк раскрытие папки подвисало на сотни миллисекунд.
    const moved: Array<[HTMLElement, number]> = [];
    root.querySelectorAll<HTMLElement>('[data-flip]').forEach((el) => {
      const key = el.dataset.flip as string;
      const top = el.getBoundingClientRect().top - base;
      next.set(key, top);
      const was = prev.current.get(key);
      if (animate && was !== undefined && Math.abs(was - top) > 2) moved.push([el, was - top]);
    });
    prev.current = next;
    // Анимировать имеет смысл только видимое: строки за краем списка переезжают молча.
    const view = root.clientHeight;
    for (const [el, shift] of moved) {
      const top = next.get(el.dataset.flip as string)! - root.scrollTop;
      if (top + shift > view + 200 && top > view + 200) continue;
      if (top + shift < -200 && top < -200) continue;
      el.animate([{ transform: `translateY(${shift}px)` }, { transform: 'none' }], { duration: 280, easing: 'cubic-bezier(.2, .8, .2, 1)' });
    }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Перетаскивание у верхнего или нижнего края списка прокручивает его — тем быстрее, чем ближе к краю. */
export function useDragAutoScroll(container: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const EDGE = 64;
    const MAX_SPEED = 22;
    let speed = 0;
    let frame = 0;
    const tick = () => {
      const el = container.current;
      if (el && speed) el.scrollTop += speed;
      frame = speed ? requestAnimationFrame(tick) : 0;
    };
    const onDragOver = (e: DragEvent) => {
      const el = container.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      let next = 0;
      if (e.clientX >= r.left && e.clientX <= r.right) {
        if (e.clientY < r.top + EDGE) next = -Math.ceil(Math.min(1, (r.top + EDGE - e.clientY) / EDGE) * MAX_SPEED);
        else if (e.clientY > r.bottom - EDGE) next = Math.ceil(Math.min(1, (e.clientY - (r.bottom - EDGE)) / EDGE) * MAX_SPEED);
      }
      speed = next;
      if (speed && !frame) frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      speed = 0;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    };
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('dragend', stop);
    document.addEventListener('drop', stop);
    return () => {
      stop();
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('dragend', stop);
      document.removeEventListener('drop', stop);
    };
  }, [container]);
}
