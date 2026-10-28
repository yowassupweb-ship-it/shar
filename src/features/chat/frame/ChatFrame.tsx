import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, MessageCircle, Minus } from 'lucide-react';
import ChatsPanel from '../ChatsPanel';
import Conversation from '../Conversation';
import { openChat } from '../store';
import { readFrameState, writeFrameState, type FrameState } from './prefs';

const W = 400;
const H = 600;
const MIN_W = 300;
const MIN_H = 320;
const BUBBLE = 39; // было 56: при крупном масштабе кнопка закрывала содержимое
const MARGIN = 12;

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const EDGES: Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const CURSOR: Record<Edge, string> = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };

/** Размер раскрытого окна: заданный вручную или обычный, но не больше экрана. */
const sizeOf = (state: FrameState) => ({
  w: Math.max(Math.min(MIN_W, window.innerWidth - 2 * MARGIN), Math.min(state.w ?? W, window.innerWidth - 2 * MARGIN)),
  h: Math.max(Math.min(MIN_H, window.innerHeight - 2 * MARGIN), Math.min(state.h ?? H, window.innerHeight - 2 * MARGIN)),
});

/** Не дать окну уехать за край экрана (после смены размера окна — тоже). */
function clamp(x: number, y: number, w: number, h: number) {
  return {
    x: Math.min(Math.max(MARGIN, x), Math.max(MARGIN, window.innerWidth - w - MARGIN)),
    y: Math.min(Math.max(MARGIN, y), Math.max(MARGIN, window.innerHeight - h - MARGIN)),
  };
}

/**
 * Плавающий чат поверх любого раздела, как в старом Шаре: круглая кнопка с числом непрочитанных; нажал — окно со
 * списком чатов и перепиской. И кнопку, и окно можно перетащить (за кнопку или заголовок окна), у окна — потянуть
 * за край или угол, чтобы задать ширину и высоту; место и размер помнятся.
 * Открытый здесь чат читается так же, как в разделе «Чаты» (openChat): отметки «прочитано», новые сообщения.
 */
export default function ChatFrame({ unread }: { unread: number }) {
  const [state, setState] = useState<FrameState>(() => {
    const saved = readFrameState();
    const start = saved ?? { x: window.innerWidth - BUBBLE - 24, y: window.innerHeight - BUBBLE - 96, open: false, chatId: null };
    return { ...start, ...clamp(start.x, start.y, BUBBLE, BUBBLE) };
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
  const w = state.open ? size.w : BUBBLE;
  const h = state.open ? size.h : BUBBLE;
  const pos = clamp(state.x, state.y, w, h);

  useEffect(() => {
    const onResize = () => setState((cur) => ({ ...cur }));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Чат открыт в окне — он «активный»: приходящие сообщения сразу прочитаны, лента подгружена.
  const chatId = state.open ? state.chatId : null;
  useEffect(() => {
    if (!chatId) return undefined;
    openChat(chatId);
    return () => openChat(null);
  }, [chatId]);

  // Перетаскивание: за кнопку (если сдвинули больше чем на 4 px — это не нажатие) или за заголовок окна.
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

  // Раскрываемся от кнопки: окно встаёт так, чтобы кнопка оказалась в его углу, и не вылезает за экран.
  const expand = () => {
    const { w: ww, h: wh } = sizeOf(state);
    const right = pos.x + BUBBLE / 2 > window.innerWidth / 2;
    const bottom = pos.y + BUBBLE / 2 > window.innerHeight / 2;
    update({ open: true, ...clamp(right ? pos.x + BUBBLE - ww : pos.x, bottom ? pos.y + BUBBLE - wh : pos.y, ww, wh) });
  };
  const collapse = () => {
    const right = pos.x + w / 2 > window.innerWidth / 2;
    const bottom = pos.y + h / 2 > window.innerHeight / 2;
    update({ open: false, ...clamp(right ? pos.x + w - BUBBLE : pos.x, bottom ? pos.y + h - BUBBLE : pos.y, BUBBLE, BUBBLE) });
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
      const maxW = window.innerWidth - 2 * MARGIN;
      const maxH = window.innerHeight - 2 * MARGIN;
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

  if (!state.open) {
    return inShell(
      <button
        type="button"
        className="nxcf-bubble"
        style={{ left: pos.x, top: pos.y }}
        aria-label={unread ? `Чаты: ${unread} непрочитанных` : 'Чаты'}
        title="Чаты (перетащите, чтобы переставить)"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => { if (!onPointerUp() && e.button === 0) expand(); }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); expand(); } }}
      >
        <MessageCircle size={17} aria-hidden="true" />
        {unread > 0 && <span className="nxcf-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>,
    );
  }

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
        <button type="button" className="nxcf-btn" data-nodrag onClick={collapse} aria-label="Свернуть" title="Свернуть">
          <Minus size={18} aria-hidden="true" />
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
