import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, MessageCircle, Minus } from 'lucide-react';
import ChatsPanel from '../ChatsPanel';
import Conversation from '../Conversation';
import { openChat } from '../store';
import { readFrameState, writeFrameState, type FrameState } from './prefs';

const W = 400;
const H = 600;
const BUBBLE = 56;
const MARGIN = 12;

/** Не дать окну уехать за край экрана (после смены размера окна — тоже). */
function clamp(x: number, y: number, w: number, h: number) {
  return {
    x: Math.min(Math.max(MARGIN, x), Math.max(MARGIN, window.innerWidth - w - MARGIN)),
    y: Math.min(Math.max(MARGIN, y), Math.max(MARGIN, window.innerHeight - h - MARGIN)),
  };
}

/**
 * Плавающий чат поверх любого раздела, как в старом Шаре: круглая кнопка с числом непрочитанных; нажал — окно со
 * списком чатов и перепиской. И кнопку, и окно можно перетащить (за кнопку или заголовок окна) — место помнится.
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

  const w = state.open ? Math.min(W, window.innerWidth - 2 * MARGIN) : BUBBLE;
  const h = state.open ? Math.min(H, window.innerHeight - 2 * MARGIN) : BUBBLE;
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
    const ww = Math.min(W, window.innerWidth - 2 * MARGIN);
    const wh = Math.min(H, window.innerHeight - 2 * MARGIN);
    const right = pos.x + BUBBLE / 2 > window.innerWidth / 2;
    const bottom = pos.y + BUBBLE / 2 > window.innerHeight / 2;
    update({ open: true, ...clamp(right ? pos.x + BUBBLE - ww : pos.x, bottom ? pos.y + BUBBLE - wh : pos.y, ww, wh) });
  };
  const collapse = () => {
    const right = pos.x + w / 2 > window.innerWidth / 2;
    const bottom = pos.y + h / 2 > window.innerHeight / 2;
    update({ open: false, ...clamp(right ? pos.x + w - BUBBLE : pos.x, bottom ? pos.y + h - BUBBLE : pos.y, BUBBLE, BUBBLE) });
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
        <MessageCircle size={24} aria-hidden="true" />
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
    </section>,
  );
}

/** Внутрь корня интерфейса (.nx), как меню и диалоги: там живут токены темы — цвета, радиусы, тени. */
function inShell(node: ReactNode) {
  const root = document.querySelector<HTMLElement>('.nx') || document.body;
  return createPortal(node, root);
}
