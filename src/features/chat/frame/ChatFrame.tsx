import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, X } from 'lucide-react';
import ChatsPanel from '../ChatsPanel';
import Conversation from '../Conversation';
import { openChat } from '../store';
import { readFrameState, setChatFrameOpen, writeFrameState, type FrameState } from './prefs';

const W = 400;
const H = 600;
const MIN_W = 300;
const MIN_H = 320;
const MARGIN = 12;

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const EDGES: Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const CURSOR: Record<Edge, string> = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };

/**
 * Где окну можно стоять: область раздела — между шапкой Electron (и баннером PWA) сверху и нижним меню снизу.
 * Окно fixed и без этого уезжало под них. Меню на телефоне парит над разделом — тогда нижняя граница у его верха.
 */
function area() {
  const main = document.querySelector<HTMLElement>('.nx-app-main')?.getBoundingClientRect();
  const nav = document.querySelector<HTMLElement>('.nx-nav')?.getBoundingClientRect();
  const top = main && main.height > 0 ? main.top : 0;
  const left = main && main.width > 0 ? main.left : 0;
  const right = main && main.width > 0 ? main.right : window.innerWidth;
  let bottom = main && main.height > 0 ? main.bottom : window.innerHeight;
  // Меню спрятано (клавиатура, скрытая панель) — его верх ниже области и ничего не ограничивает.
  if (nav && nav.height > 0 && nav.top > top && nav.top < bottom) bottom = nav.top;
  return { top, left, right, bottom, width: right - left, height: bottom - top };
}

/** Размер раскрытого окна: заданный вручную или обычный, но не больше области раздела. */
const sizeOf = (state: FrameState) => {
  const a = area();
  return {
    w: Math.max(Math.min(MIN_W, a.width - 2 * MARGIN), Math.min(state.w ?? W, a.width - 2 * MARGIN)),
    h: Math.max(Math.min(MIN_H, a.height - 2 * MARGIN), Math.min(state.h ?? H, a.height - 2 * MARGIN)),
  };
};

/** Не дать окну уехать за край области (после смены размера окна — тоже). */
function clamp(x: number, y: number, w: number, h: number) {
  const a = area();
  return {
    x: Math.min(Math.max(a.left + MARGIN, x), Math.max(a.left + MARGIN, a.right - w - MARGIN)),
    y: Math.min(Math.max(a.top + MARGIN, y), Math.max(a.top + MARGIN, a.bottom - h - MARGIN)),
  };
}

/**
 * Быстрый чат поверх любого раздела: окно со списком чатов и перепиской. Открывается правым щелчком по «Чатам» в нижней
 * полосе (там же и закрывается), постоянной кнопки нет. Окно можно перетащить за заголовок и потянуть за край или угол,
 * чтобы задать ширину и высоту; место и размер помнятся.
 * Открытый здесь чат читается так же, как в разделе «Чаты» (openChat): отметки «прочитано», новые сообщения.
 */
export default function ChatFrame({ unread }: { unread: number }) {
  const [state, setState] = useState<FrameState>(() => {
    const saved = readFrameState();
    const { w: ww, h: wh } = sizeOf(saved ?? { x: 0, y: 0, chatId: null });
    const a = area();
    const start = saved ?? { x: a.right - ww - 24, y: a.bottom - wh - 24, chatId: null };
    return { ...start, ...clamp(start.x, start.y, ww, wh) };
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const update = useCallback((patch: Partial<FrameState>) => {
    setState((cur) => {
      const next = { ...cur, ...patch };
      writeFrameState(next);
      return next;
    });
  }, []);

  const size = sizeOf(state);
  const { w, h } = size;
  const pos = clamp(state.x, state.y, w, h);

  useEffect(() => {
    const onResize = () => setState((cur) => ({ ...cur }));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Чат открыт в окне — он «активный»: приходящие сообщения сразу прочитаны, лента подгружена.
  const chatId = state.chatId;
  useEffect(() => {
    if (!chatId) return undefined;
    openChat(chatId);
    return () => openChat(null);
  }, [chatId]);

  // Перетаскивание за заголовок окна.
  const drag = useRef<{ dx: number; dy: number; sx: number; sy: number; moved: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('[data-nodrag]')) return;
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y, sx: e.clientX, sy: e.clientY, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return;
    d.moved = true;
    setState((cur) => ({ ...cur, ...clamp(e.clientX - d.dx, e.clientY - d.dy, w, h) }));
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved) writeFrameState(stateRef.current);
    return Boolean(d?.moved);
  };

  // Размер руками: тянем за край или угол окна. Левый и верхний края двигают и само окно — противоположная
  // сторона остаётся на месте. Размер не меньше MIN и не больше экрана; запоминается вместе с местом.
  const onResizeDown = (edge: Edge) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const start = { sx: e.clientX, sy: e.clientY, x: pos.x, y: pos.y, w, h };
    // Движение слушаем на окне, а не на ручке: захват указателя на узкой полоске теряется, стоит курсору
    // уйти за её край или оказаться над другим окном.
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.sx;
      const dy = ev.clientY - start.sy;
      const a = area();
      const maxW = a.width - 2 * MARGIN;
      const maxH = a.height - 2 * MARGIN;
      let { x, y } = start;
      let nw = start.w + (edge.includes('e') ? dx : edge.includes('w') ? -dx : 0);
      let nh = start.h + (edge.includes('s') ? dy : edge.includes('n') ? -dy : 0);
      nw = Math.min(Math.max(nw, Math.min(MIN_W, maxW)), maxW);
      nh = Math.min(Math.max(nh, Math.min(MIN_H, maxH)), maxH);
      if (edge.includes('w')) x = start.x + start.w - nw;
      if (edge.includes('n')) y = start.y + start.h - nh;
      setState((cur) => ({ ...cur, ...clamp(x, y, nw, nh), w: nw, h: nh }));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.style.removeProperty('user-select');
      writeFrameState(stateRef.current);
    };
    document.body.style.userSelect = 'none'; // пока тянем, текст под курсором не выделяется
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  return inShell(
    <section className="nxcf-window" data-chat={state.chatId ? 'true' : undefined} style={{ left: pos.x, top: pos.y, width: w, height: h }} aria-label="Чат">
      <header className="nxcf-head" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
        {state.chatId && (
          <button type="button" className="nxcf-btn" data-nodrag onClick={() => update({ chatId: null })} aria-label="К списку чатов" title="К списку чатов">
            <ChevronLeft size={18} aria-hidden="true" />
          </button>
        )}
        {/* В переписке имя и кнопки чата — в её собственной шапке; здесь — только место, за которое тянуть. */}
        <span className="nxcf-title">{state.chatId ? '' : 'Чаты'}</span>
        {!state.chatId && unread > 0 && <span className="nxcf-count">{unread}</span>}
        <button type="button" className="nxcf-btn" data-nodrag onClick={() => setChatFrameOpen(false)} aria-label="Закрыть быстрый чат" title="Закрыть">
          <X size={18} aria-hidden="true" />
        </button>
      </header>
      <div className="cxn nxcf-body">
        {state.chatId ? (
          <Conversation key={state.chatId} chatId={state.chatId} onBack={() => update({ chatId: null })} />
        ) : (
          <ChatsPanel activeChatId={null} onOpen={(id) => update({ chatId: id })} />
        )}
      </div>
      {EDGES.map((edge) => (
        <span
          key={edge}
          className="nxcf-grip"
          data-edge={edge}
          style={{ cursor: CURSOR[edge] }}
          onPointerDown={onResizeDown(edge)}
          aria-hidden="true"
        />
      ))}
    </section>,
  );
}

/** Внутрь корня интерфейса (.nx), как меню и диалоги: там живут токены темы — цвета, радиусы, тени. */
function inShell(node: ReactNode) {
  const root = document.querySelector<HTMLElement>('.nx') || document.body;
  return createPortal(node, root);
}
