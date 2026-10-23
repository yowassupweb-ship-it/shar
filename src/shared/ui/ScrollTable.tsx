import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Широкая таблица с прокруткой вбок — полоса и снизу, и сверху: у длинной таблицы нижняя полоса уезжает за экран,
 * и прокрутить её, не долистав до конца, было нельзя. Верхняя полоса появляется, только если таблица не влезает,
 * и движется вместе с нижней.
 */
export function ScrollTable({ className, children }: { className: string; children: ReactNode }) {
  const body = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [over, setOver] = useState(false);

  useEffect(() => {
    const el = body.current;
    if (!el) return undefined;
    const measure = () => { setWidth(el.scrollWidth); setOver(el.scrollWidth > el.clientWidth + 1); };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, []);

  // Две полосы двигают друг друга; эхо гаснет само: то же значение прокрутки события не порождает.
  const follow = (from: HTMLDivElement | null, to: HTMLDivElement | null) => {
    if (from && to && Math.abs(to.scrollLeft - from.scrollLeft) > 0.5) to.scrollLeft = from.scrollLeft;
  };

  return (
    <>
      {over && (
        <div ref={top} className="nx-table-topbar" onScroll={() => follow(top.current, body.current)} aria-hidden="true">
          <div style={{ width }} />
        </div>
      )}
      <div ref={body} className={className} onScroll={() => follow(body.current, top.current)}>{children}</div>
    </>
  );
}
