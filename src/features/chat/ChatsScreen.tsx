import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useShellOptions } from '@/shared/shell/ShellContext';
import Splitter from '@/shared/ui/Splitter';
import ChatsPanel from './ChatsPanel';
import Conversation from './Conversation';
import { openChat, setPanel, useChatStore } from './store';

/**
 * Раздел «Чаты» нового шара: каркас с меню, список, переписка.
 *
 * Адрес чата — `?chat=<id>`: уведомление открывает нужную переписку сразу,
 * без главной страницы аккаунта. Первый кадр строится из локального кэша,
 * сеть только догоняет.
 */

function readChatParam(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('chat');
}

/** Шаг истории нового чата. nxPushed — под ним лежит список, «назад» ведёт
 *  туда; иначе (открыли по ссылке) «назад» увёл бы со страницы. nxPanel —
 *  поверх переписки открыт профиль (только телефон, см. Conversation). */
type HistState = { nxChat?: string | null; nxPushed?: boolean; nxPanel?: string } | null;

function writeChatParam(chatId: string | null, push: boolean) {
  const url = new URL(window.location.href);
  if (chatId) url.searchParams.set('chat', chatId);
  else url.searchParams.delete('chat');
  const prev = window.history.state as HistState;
  const state: HistState = { nxChat: chatId, nxPushed: Boolean(chatId) && (push || Boolean(prev?.nxPushed)) };
  if (push) window.history.pushState(state, '', url);
  else window.history.replaceState(state, '', url);
}

const NARROW = '(max-width: 640px)';
const subscribeMedia = (cb: () => void) => {
  const mq = window.matchMedia(NARROW);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
};
const subscribeNoop = () => () => {};

export default function ChatsScreen() {
  const mounted = useSyncExternalStore(subscribeNoop, () => true, () => false);
  const narrow = useSyncExternalStore(subscribeMedia, () => window.matchMedia(NARROW).matches, () => false);
  const activeChatId = useChatStore((s) => s.activeChatId);
  const layoutRef = useRef<HTMLDivElement>(null);

  // Соединение и список чатов подняты в общем каркасе (NxRoot) и живут между
  // разделами. Здесь — только какой чат открыт: из адреса при входе, никакой —
  // при уходе в другой раздел (иначе чат «читался» бы из Контактов).
  useEffect(() => {
    openChat(readChatParam());
    return () => openChat(null);
  }, []);

  // Назад/вперёд в браузере и системный жест «назад» на телефоне. Профиль на
  // телефоне — свой шаг истории (см. Conversation): «назад» сперва закрывает его.
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const st = useChatStore.getState();
      if (st.panel === 'profile' && (e.state as HistState)?.nxPanel !== 'profile') setPanel(null);
      const id = readChatParam();
      if (id !== st.activeChatId) {
        if (!id && window.matchMedia(NARROW).matches) setPanel(null);
        openChat(id);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Нажали на уведомление при уже открытом окне — открываем чат без перезагрузки.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = String((e as CustomEvent).detail || '');
      if (!id) return;
      writeChatParam(id, false);
      openChat(id);
    };
    window.addEventListener('nx:open-chat', onOpen);
    return () => window.removeEventListener('nx:open-chat', onOpen);
  }, []);

  const open = useCallback((chatId: string) => {
    if (chatId === useChatStore.getState().activeChatId) return;
    // На узком экране открытие чата — новый экран: «назад» ведёт в список.
    writeChatParam(chatId, window.matchMedia(NARROW).matches && !useChatStore.getState().activeChatId);
    openChat(chatId);
  }, []);

  const back = useCallback(function goBack() {
    const st = window.history.state as HistState;
    // Сверху шаг профиля — сначала снимаем его, потом уходим из переписки.
    if (st?.nxPanel) {
      window.addEventListener('popstate', () => goBack(), { once: true });
      window.history.back();
      return;
    }
    // На телефоне панель эмодзи принадлежит переписке и уходит с ней.
    if (window.matchMedia(NARROW).matches) setPanel(null);
    if (st?.nxPushed) window.history.back();
    else { writeChatParam(null, false); openChat(null); }
  }, []);

  useShellOptions({
    navHidden: narrow && Boolean(activeChatId),
    onReselect: () => { if (useChatStore.getState().activeChatId) back(); },
  });

  if (!mounted) return null;

  return (
    <div ref={layoutRef} className="cxn" data-pane={activeChatId ? 'chat' : 'list'}>
      <ChatsPanel activeChatId={activeChatId} onOpen={open} />
      {!narrow && (
        <Splitter
          containerRef={layoutRef}
          cssVar="--cxn-sidebar"
          storageKey="nx:chats-sidebar-width"
          min={280}
          max={560}
          initial={360}
          label="Ширина списка чатов"
        />
      )}
      {activeChatId ? (
        <Conversation chatId={activeChatId} onBack={back} />
      ) : (
        <section className="cxn-main" aria-label="Переписка">
          <div className="nx-state cxn-empty">
            <img src="/icons/nav-v2/new.png?v=3" alt="" width={72} height={72} draggable={false} />
            <h2>Выберите чат</h2>
            <p>Переписка откроется здесь.</p>
          </div>
        </section>
      )}
    </div>
  );
}
