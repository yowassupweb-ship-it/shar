import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * Панель инструментов, которой не хватает места, не прокручивается вбок, а складывает хвост в «⋮» — как Google
 * Документы. Группы панели — прямые потомки с [data-tb-group]; возвращаем, сколько групп помещается. Ширины групп
 * запоминаем, пока они на виду: спрятанную измерить нельзя, а при расширении окна надо знать, влезет ли она обратно.
 * reserve — место под саму кнопку «⋮».
 */
export function useToolbarOverflow(bar: RefObject<HTMLElement | null>, count: number, reserve = 44, moreAlways = false): number {
  const [fit, setFit] = useState(count);
  const widths = useRef<number[]>([]);

  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return undefined;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const style = getComputedStyle(el);
      const gap = parseFloat(style.columnGap) || 0;
      const groups = Array.from(el.querySelectorAll<HTMLElement>(':scope > [data-tb-group]'));
      groups.forEach((g, i) => { if (!g.hidden && g.offsetWidth) widths.current[i] = g.offsetWidth + gap; });
      // moreAlways: кнопка «⋮» стоит всегда (у таблиц там свои пункты) — её место занято в любом случае.
      const avail = el.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0) - (moreAlways ? reserve : 0);
      const all = groups.map((_, i) => widths.current[i] ?? 0);
      const total = all.reduce((a, b) => a + b, 0);
      let next = groups.length;
      if (total > avail + 1) {
        let used = 0;
        next = 0;
        const room = moreAlways ? avail : avail - reserve;
        for (const w of all) { if (used + w > room) break; used += w; next += 1; }
      }
      setFit((cur) => (cur === next ? cur : next));
    };
    const soon = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const ro = new ResizeObserver(soon);
    ro.observe(el);
    measure();
    return () => { ro.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [bar, count, reserve, moreAlways]);

  // Ширина групп меняется (название шрифта, стиль абзаца) — после каждой отрисовки досчитываем видимые.
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
    el.querySelectorAll<HTMLElement>(':scope > [data-tb-group]').forEach((g, i) => { if (!g.hidden && g.offsetWidth) widths.current[i] = g.offsetWidth + gap; });
  });

  return Math.min(fit, count);
}
