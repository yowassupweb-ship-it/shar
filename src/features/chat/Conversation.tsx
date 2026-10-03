import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ChatHeader, { type SearchState } from './ChatHeader';
import Composer from './Composer';
import EmojiPanel from './EmojiPanel';
import PersonProfile from './PersonProfile';
import ProfilePanel from './ProfilePanel';
import Timeline from './timeline/Timeline';
import Splitter from '@/shared/ui/Splitter';
import { useEdgeBack } from './useEdgeBack';
import { chatTitle, ensureLoaded, isNotifications, markActiveRead, openPerson, setPanel, useChatStore, type Msg } from './store';

/**
 * Экран переписки. Шапка и композер — пилюли, висящие над лентой без
 * подложки (как в macOS); лента оставляет под ними место по их реальной
 * высоте (--header-h, --composer-h). Справа — боковая панель: профиль или
 * эмодзи со стикерами. На узком экране панель встаёт под композером.
 */
export default function Conversation({ chatId, onBack }: { chatId: string; onBack: () => void }) {
  const chat = useChatStore((s) => s.chats[chatId]);
  const me = useChatStore((s) => s.me);
  const users = useChatStore((s) => s.users);
  const panel = useChatStore((s) => s.panel);
  const thread = useChatStore((s) => s.threads[chatId]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState<SearchState | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const [jumpTo, setJumpTo] = useState<{ id: string; n: number } | null>(null);
  // Чей профиль открыт поверх профиля чата — в сторе: закрытие панели и
  // смена чата сбрасывают его сами (setPanel, openChat).
  const person = useChatStore((s) => s.personId);

  useEdgeBack(sectionRef, narrow, onBack);

  // Профиль на телефоне закрывает всю переписку — это отдельный экран, и
  // «назад» (кнопка, жест Safari, Android) должен закрывать сперва его.
  useEffect(() => {
    if (!narrow) return;
    const st = window.history.state as { nxPanel?: string } | null;
    if (panel === 'profile' && st?.nxPanel !== 'profile') {
      window.history.pushState({ ...st, nxPanel: 'profile' }, '', window.location.href);
    } else if (panel !== 'profile' && st?.nxPanel === 'profile') {
      window.history.back();
    }
  }, [panel, narrow]);

  const title = chat ? chatTitle(chat, me, users) : 'Чат';

  useEffect(() => { setSearch(null); }, [chatId]);

  // Вернулись на вкладку — всё, что видно, прочитано.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') markActiveRead(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // Высоты шапки и композера → отступы ленты сверху и снизу.
  useEffect(() => {
    const body = bodyRef.current;
    const head = headerRef.current;
    const comp = composerRef.current;
    if (!body || !head || !comp) return undefined;
    const ro = new ResizeObserver(() => {
      body.style.setProperty('--header-h', `${Math.ceil(head.offsetHeight)}px`);
      body.style.setProperty('--composer-h', `${Math.ceil(comp.offsetHeight)}px`);
    });
    ro.observe(head);
    ro.observe(comp);
    return () => ro.disconnect();
  }, [chatId]);

  // Совпадения поиска — по загруженной ленте, от новых к старым.
  const query = search?.query.trim().toLowerCase() || '';
  const matches = useMemo(() => {
    if (!query || !thread) return [];
    const out: string[] = [];
    for (let i = thread.ids.length - 1; i >= 0; i--) {
      const m = thread.byId[thread.ids[i]];
      if (m.content && m.content.toLowerCase().includes(query)) out.push(String(m.id));
    }
    return out;
  }, [query, thread]);
  const searchState = search ? { ...search, matches, index: Math.min(search.index, Math.max(0, matches.length - 1)) } : null;
  const activeMatch = searchState?.matches[searchState.index];
  useEffect(() => { if (activeMatch) setJumpTo((j) => ({ id: activeMatch, n: (j?.n || 0) + 1 })); }, [activeMatch]);

  const pinned = useMemo(() => {
    if (!thread) return [] as Msg[];
    return thread.ids.map((id) => thread.byId[id])
      .filter((m) => m.metadata?.isPinned && !m.isSystemMessage && String(m.notificationType || '').toLowerCase() !== 'message_pin')
      .reverse();
  }, [thread]);

  const jump = useCallback((id: string) => setJumpTo((j) => ({ id, n: (j?.n || 0) + 1 })), []);
  // Из профиля — и к давним сообщениям: сначала догружаем историю до них.
  const jumpDeep = useCallback((id: string) => {
    void ensureLoaded(chatId, id).then((ok) => { if (ok) requestAnimationFrame(() => jump(id)); });
  }, [chatId, jump]);

  return (
    <section ref={sectionRef} className="cxn-main cxv" aria-label={title} data-panel={panel || undefined}>
      <div className="cxv-column">
        <div ref={bodyRef} className="cxv-body">
          <div ref={headerRef} className="cxv-head">
            <ChatHeader
              chatId={chatId}
              onBack={onBack}
              search={searchState}
              onSearch={setSearch}
              pinned={pinned}
              onJump={jump}
            />
          </div>
          <Timeline key={chatId} chatId={chatId} chat={chat} query={searchState?.query || ''} jumpTo={jumpTo} onAvatar={openPerson} />
          <div ref={composerRef} className="cxn-composer-wrap">
            <Composer key={chatId} chatId={chatId} readOnly={Boolean(chat && isNotifications(chat))} />
          </div>
        </div>
      </div>
      {panel && !narrow && (
        <Splitter
          containerRef={sectionRef}
          cssVar="--cxv-panel"
          storageKey="nx:chat-panel-width"
          min={300}
          max={560}
          initial={340}
          edge="left"
          label="Ширина боковой панели"
        />
      )}
      {panel === 'emoji' && <EmojiPanel chatId={chatId} />}
      {panel === 'profile' && person && <PersonProfile userId={person} onBack={() => openPerson(null)} />}
      {panel === 'profile' && !person && (
        <ProfilePanel
          onPerson={openPerson}
          chatId={chatId}
          // На телефоне профиль закрывает переписку — уходим к ней, иначе поиска и сообщения не видно.
          onSearch={() => { if (narrow) setPanel(null); setSearch({ query: '', index: 0, matches: [] }); }}
          onJump={(id) => { if (narrow) setPanel(null); jumpDeep(id); }}
        />
      )}
    </section>
  );
}
