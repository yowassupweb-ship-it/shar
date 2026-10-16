import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { visibleBox } from '@/shared/platform/viewport';

/**
 * Выделение сообщения долгим нажатием на телефоне — как в прежнем Шаре (и в Telegram, iMessage):
 * переписка размывается и темнеет, нажатое сообщение рисуется поверх резким и чуть приподнимается,
 * а реакции и действия — сразу под ним. Сообщение — копия его строки (вид пузыря держится на
 * .cxm-row[data-mine]), так что оно выглядит ровно как в ленте. При закрытии копия опускается
 * на место, размытие гаснет.
 */

export type FocusShot = {
  /** Копия строки сообщения (cloneNode) — вставляется как есть. */
  clone: HTMLElement;
  /** Где строка стоит на экране. */
  rect: { top: number; left: number; width: number; height: number };
  /** Где пузырь: под ним встаёт меню. */
  bubble: { top: number; left: number; right: number; bottom: number };
  mine: boolean;
  /** На сколько поднять сообщение, чтобы оно и меню под ним поместились на экране (≤ 0). */
  shift: number;
};

const GAP = 10;
const MARGIN = 10;
/** Высота меню с реакциями до того, как оно нарисовано, — с запасом. */
const MENU_ESTIMATE = 420;

export function focusShot(row: HTMLElement, bubbleEl: HTMLElement): FocusShot {
  const r = row.getBoundingClientRect();
  const b = bubbleEl.getBoundingClientRect();
  const box = visibleBox();
  let top = b.top;
  if (top + b.height + GAP + MENU_ESTIMATE > box.bottom - MARGIN) {
    top = Math.max(box.top + MARGIN, box.bottom - MARGIN - MENU_ESTIMATE - GAP - b.height);
  }
  const clone = row.cloneNode(true) as HTMLElement;
  clone.removeAttribute('id');
  return {
    clone,
    rect: { top: r.top, left: r.left, width: r.width, height: r.height },
    bubble: { top: b.top, left: b.left, right: b.right, bottom: b.bottom },
    mine: row.dataset.mine === 'true',
    shift: Math.min(0, top - b.top),
  };
}

/** Точка для меню: под пузырём, у его края со стороны автора. */
export function focusAnchor(shot: FocusShot) {
  return { x: shot.mine ? shot.bubble.right : shot.bubble.left, y: shot.bubble.bottom + shot.shift + GAP };
}

export function BubbleFocus({ shot, closing }: { shot: FocusShot; closing: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { host.current?.replaceChildren(shot.clone); }, [shot]);
  const root = document.querySelector<HTMLElement>('.nx') || document.body;
  return createPortal(
    <div className="cxm-focus" data-closing={closing ? 'true' : undefined} aria-hidden="true">
      <div className="cxm-focus-scrim" />
      <div
        className="cxm-focus-shot"
        style={{ top: shot.rect.top, left: shot.rect.left, width: shot.rect.width, transform: `translateY(${closing ? 0 : shot.shift}px)` }}
      >
        <div ref={host} className="cxm-focus-lift" style={{ transformOrigin: shot.mine ? 'right center' : 'left center' }} />
      </div>
    </div>,
    root,
  );
}
