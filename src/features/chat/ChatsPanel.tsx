import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  AlertCircle, Archive, ArchiveRestore, Bell, FileText, MessageSquare, Moon, MoreHorizontal, Pin, PinOff, Plus, RotateCw,
  Search, Sun, Trash2, Users,
} from 'lucide-react';
import { useTheme } from '@/shared/theme/ThemeContext';
import { SearchField } from '@/shared/ui/SearchField';
import { askConfirm, Menu, MenuItem, type MenuAnchor } from '@/shared/ui/overlay';
import SharMark from '@/shared/ui/SharMark';
import { isIosBrowserTab, notificationState, requestNotifications, type NotificationState } from '@/shared/platform/notifications';
import { deleteChat, setArchived, setArchiveView, togglePin } from './actions';
import { ListRow, type RowHandlers } from './ListRow';
import NewChatSheet from './NewChatSheet';
import RequestSheet from './RequestSheet';
import {
  chatTitle, internals, isArchived, isFavorites, isNotifications, isPinned, lastActivity, loadChats, previewText,
  useChatStore, type ChatRow,
} from './store';

/**
 * Панель списка чатов — перенос ChatSidebar из test-chat-v3.
 *
 * Порядок как в старом списке: Уведомления, Избранное, закреплённые (в
 * порядке закрепления), остальные — по последней активности. Архив —
 * отдельный вид того же списка.
 */

const PULL_REFRESH = 64;
const PULL_ARCHIVE = 258;
const PULL_MAX = 310;
const PULL_DAMP = 0.35;
const PULL_FLICK = 1.1; // px/мс: быстрее — это рывок, а не намеренный длинный жест

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Загружаю чаты">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="nx-skel-row cxl-skel">
          <span className="nx-skel nx-skel-avatar" />
          <span className="nx-skel-lines">
            <span className="nx-skel nx-skel-line" style={{ '--w': `${50 + ((i * 17) % 35)}%` } as CSSProperties} />
            <span className="nx-skel nx-skel-line" style={{ '--w': `${30 + ((i * 23) % 45)}%` } as CSSProperties} />
          </span>
        </div>
      ))}
    </div>
  );
}

type PullStage = 'idle' | 'pull' | 'refresh' | 'archive';

export default function ChatsPanel({ activeChatId, onOpen }: { activeChatId: string | null; onOpen: (id: string) => void }) {
  const chats = useChatStore((s) => s.chats);
  const phase = useChatStore((s) => s.chatsPhase);
  const status = useChatStore((s) => s.status);
  const me = useChatStore((s) => s.me);
  const users = useChatStore((s) => s.users);
  const localPins = useChatStore((s) => s.localPins);
  const archiveView = useChatStore((s) => s.archiveView);
  const { theme, toggleTheme } = useTheme();

  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [toolsAnchor, setToolsAnchor] = useState<MenuAnchor | null>(null);
  const [createAnchor, setCreateAnchor] = useState<MenuAnchor | null>(null);
  const [rowMenu, setRowMenu] = useState<{ chatId: string; anchor: MenuAnchor } | null>(null);
  const [sheet, setSheet] = useState<'chat' | 'group' | 'request' | null>(null);
  const [notif, setNotif] = useState<NotificationState>('unsupported');
  const [bootSpin, setBootSpin] = useState(true);
  // Десктоп (Electron): бренд живёт в заголовке окна, поиск — в шапке списка.
  const [desktop] = useState(() => typeof document !== 'undefined' && document.documentElement.dataset.platform === 'electron');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setNotif(notificationState()); }, []);
  // Короткий оборот знака при запуске — «приложение проснулось».
  useEffect(() => { const t = window.setTimeout(() => setBootSpin(false), 2000); return () => window.clearTimeout(t); }, []);

  const uid = String(me?.id ?? '');

  const list = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    const rank = (c: ChatRow) => (isNotifications(c) ? 0 : isFavorites(c) ? 1 : isPinned(c, uid, localPins) ? 2 : 3);
    return Object.values(chats)
      .filter((c) => {
        const special = isFavorites(c) || isNotifications(c);
        if (special) return !archiveView;
        return isArchived(c, uid) === archiveView;
      })
      .filter((c) => {
        if (!q) return true;
        return chatTitle(c, me, users).toLowerCase().includes(q) || previewText(c.lastMessage).toLowerCase().includes(q);
      })
      .sort((a, b) => {
        const ra = rank(a);
        const rb = rank(b);
        if (ra !== rb) return ra - rb;
        if (ra === 2) return (a.pinnedOrderByUser?.[uid] ?? 0) - (b.pinnedOrderByUser?.[uid] ?? 0) || lastActivity(b) - lastActivity(a);
        return lastActivity(b) - lastActivity(a);
      });
  }, [chats, me, users, uid, localPins, archiveView, deferredQuery]);

  // ── Обработчики строк: стабильные, чтобы memo строк работал ───────────────
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  const handlers = useMemo<RowHandlers>(() => ({
    onOpen: (id) => openRef.current(id),
    onMenu: (id, at) => setRowMenu({ chatId: id, anchor: at }),
    onHover: (id) => internals.preload(id),
    onPin: (id) => { void togglePin(id); },
    onArchive: (id) => { void setArchived(id, true); },
    onDelete: (id) => { void confirmDelete(id); },
  }), []);

  // ── Жест «тянуть вниз»: короткий — обновить, длинный — архив ─────────────
  const listRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const floatRef = useRef<HTMLDivElement>(null);
  // Высота парящей капсулы (с полосой архива) → отступ списка сверху.
  useEffect(() => {
    const stage = stageRef.current;
    const float = floatRef.current;
    if (!stage || !float) return undefined;
    const ro = new ResizeObserver(() => stage.style.setProperty('--cxl-float-h', `${Math.ceil(float.offsetHeight)}px`));
    ro.observe(float);
    return () => ro.disconnect();
  }, []);
  const pillRef = useRef<HTMLDivElement>(null);
  const pull = useRef({ startY: 0, active: false, dist: 0, lastY: 0, lastT: 0, vel: 0 });
  const [pullStage, setPullStage] = useState<PullStage>('idle');

  const drawPull = useCallback((dist: number) => {
    const el = pillRef.current;
    if (el) {
      el.style.transform = `translate(-50%, ${Math.min(dist, PULL_MAX) * 0.6}px) scale(${dist > 8 ? 1 : 0.9})`;
      el.style.opacity = dist > 8 ? '1' : '0';
    }
    const stage: PullStage = dist < 8 ? 'idle' : dist >= PULL_ARCHIVE ? 'archive' : dist >= PULL_REFRESH ? 'refresh' : 'pull';
    setPullStage((p) => (p === stage ? p : stage));
  }, []);

  const onPullStart = (e: React.TouchEvent) => {
    const el = listRef.current;
    if (!el) return;
    const y = e.touches[0].clientY;
    pull.current = { startY: y, active: el.scrollTop <= 0, dist: 0, lastY: y, lastT: performance.now(), vel: 0 };
    if (pillRef.current) pillRef.current.dataset.dragging = 'true';
  };
  const onPullMove = (e: React.TouchEvent) => {
    const p = pull.current;
    if (!p.active) return;
    const y = e.touches[0].clientY;
    const now = performance.now();
    const dt = now - p.lastT;
    if (dt > 0) { p.vel = p.vel * 0.6 + ((y - p.lastY) / dt) * 0.4; p.lastY = y; p.lastT = now; }
    const dy = y - p.startY;
    if (dy <= 0) { if (p.dist) { p.dist = 0; drawPull(0); } return; }
    const damped = dy <= PULL_ARCHIVE ? dy : PULL_ARCHIVE + (dy - PULL_ARCHIVE) * PULL_DAMP;
    p.dist = Math.min(damped, PULL_MAX);
    drawPull(p.dist);
  };
  const onPullEnd = () => {
    const p = pull.current;
    const { dist, vel } = p;
    p.active = false;
    p.dist = 0;
    if (pillRef.current) delete pillRef.current.dataset.dragging;
    drawPull(0);
    if (dist >= PULL_ARCHIVE && vel <= PULL_FLICK) setArchiveView(!useChatStore.getState().archiveView);
    else if (dist >= PULL_REFRESH) void loadChats();
  };

  const busy = bootSpin || phase === 'loading' || status !== 'open';
  const menuChat = rowMenu ? chats[rowMenu.chatId] : undefined;

  let body;
  if (!list.length && (phase === 'idle' || phase === 'loading') && !query && !archiveView) {
    body = <Skeleton />;
  } else if (!list.length && phase === 'error' && !archiveView) {
    body = (
      <div className="nx-state" data-tone="danger" role="alert">
        <AlertCircle size={28} aria-hidden="true" />
        <h2>Не загрузил список чатов</h2>
        <p>Сервер не ответил. Проверьте связь и повторите.</p>
        <button type="button" className="nx-ghost" onClick={() => void loadChats()}>
          <RotateCw size={14} aria-hidden="true" /> Повторить
        </button>
      </div>
    );
  } else if (!list.length) {
    body = (
      <div className="nx-state">
        {query ? <Search size={28} aria-hidden="true" /> : archiveView ? <Archive size={28} aria-hidden="true" /> : <MessageSquare size={28} aria-hidden="true" />}
        <h2>{query ? 'Ничего не найдено' : archiveView ? 'Архив пуст' : 'Пока нет чатов'}</h2>
        <p>
          {query ? 'Попробуйте другой запрос.'
            : archiveView ? 'Сюда попадают чаты, которые вы убрали в архив.'
              : 'Начните переписку с коллегой.'}
        </p>
        {query ? <button type="button" className="nx-ghost" onClick={() => setQuery('')}>Сбросить поиск</button>
          : archiveView ? <button type="button" className="nx-ghost" onClick={() => setArchiveView(false)}>К активным чатам</button>
            : <button type="button" className="nx-primary" onClick={() => setSheet('chat')}>Новый чат</button>}
      </div>
    );
  } else {
    body = (
      <div key={archiveView ? 'archive' : 'active'} className="cxl-rows">
        {list.map((c) => <ListRow key={c.id} chat={c} active={c.id === activeChatId} h={handlers} />)}
      </div>
    );
  }

  return (
    <aside className="cxl" aria-label="Чаты">
      {/* Шапка как тулбар macOS в одну строку: знак слева, поиск-капсула
          посередине, кнопки-квадраты без рамки справа. */}
      <header className="cxl-head">
        <div className="cxl-bar">
          {!desktop && (
            // Электрон: знак и «ШАР» — в заголовке окна (ElectronShell).
            <div className="cxl-brand cxl-brand-compact" role="status" aria-live="polite">
              <SharMark size={32} busy={busy} />
              <span className="cxl-brand-text">
                <span className="nx-wordmark">{archiveView ? 'Архив' : 'ШАР'}</span>
                {status !== 'open' && (
                  <span className="cxl-brand-status" data-tone={status === 'connecting' ? undefined : 'warn'}>
                    {status === 'connecting' ? 'Подключаюсь…' : 'Нет связи'}
                  </span>
                )}
              </span>
            </div>
          )}
          <SearchField
            ref={searchRef}
            className="cxl-search cxl-search-inline"
            value={query}
            onChange={setQuery}
            placeholder={archiveView ? 'Поиск в архиве' : 'Поиск'}
            label="Поиск по чатам"
          />
          <div className="cxl-tools">
            {!archiveView && (
              <button
                type="button"
                className="cxl-compose"
                aria-label="Создать"
                title="Создать"
                aria-haspopup="menu"
                aria-expanded={Boolean(createAnchor)}
                onClick={(e) => setCreateAnchor(createAnchor ? null : { element: e.currentTarget, align: 'end' })}
              >
                <img className="cxl-compose-img" src="/icons/nav-v2/plus.png?v=1" alt="" draggable={false} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              className="cxl-tool"
              aria-label="Меню списка"
              title="Ещё"
              aria-haspopup="menu"
              aria-expanded={Boolean(toolsAnchor)}
              onClick={(e) => setToolsAnchor(toolsAnchor ? null : { element: e.currentTarget, align: 'end' })}
            >
              <MoreHorizontal size={18} aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>
      {/* Поиск — парящая стеклянная капсула над списком, как композер над
          перепиской: список уезжает под неё. Отступ списка сверху равен её
          реальной высоте (--cxl-float-h), вместе с полосой архива. */}
      <div ref={stageRef} className="cxl-stage">
        <div ref={floatRef} className="cxl-float" data-empty={!archiveView ? 'true' : undefined}>
          {archiveView && (
            <button type="button" className="cxl-archive-bar" onClick={() => setArchiveView(false)}>
              <Archive size={14} aria-hidden="true" /> Архив · вернуться к активным чатам
            </button>
          )}
        </div>

        <div
          ref={listRef}
          className="cxl-list nx-scroll-y"
          onTouchStart={onPullStart}
          onTouchMove={onPullMove}
          onTouchEnd={onPullEnd}
          onTouchCancel={onPullEnd}
        >
          <div ref={pillRef} className="cxl-pull" data-stage={pullStage} aria-hidden="true">
            {pullStage === 'archive' ? <Archive size={16} /> : <RotateCw size={16} />}
            <span>
              {pullStage === 'archive' ? (archiveView ? 'Отпустите — активные' : 'Отпустите — архив')
                : pullStage === 'refresh' ? 'Отпустите — обновить' : 'Тяните вниз'}
            </span>
          </div>
          {body}
        </div>
      </div>

      {!archiveView && (
        <button
          type="button"
          className="nx-primary-round cxl-fab"
          aria-label="Создать"
          aria-haspopup="menu"
          aria-expanded={Boolean(createAnchor)}
          onClick={(e) => setCreateAnchor(createAnchor ? null : { element: e.currentTarget, align: 'end', side: 'above' })}
        >
          <Plus size={18} aria-hidden="true" />
        </button>
      )}

      {toolsAnchor && (
        <Menu anchor={toolsAnchor} label="Меню списка" onClose={() => setToolsAnchor(null)}>
          <MenuItem icon={<Archive size={16} />} onSelect={() => { setArchiveView(!archiveView); setToolsAnchor(null); }}>
            {archiveView ? 'Активные чаты' : 'Архив'}
          </MenuItem>
          <MenuItem icon={theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />} onSelect={() => { toggleTheme(); setToolsAnchor(null); }}>
            {theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
          </MenuItem>
          {notif !== 'granted' && notif !== 'unsupported' && (isIosBrowserTab() ? (
            <div className="nx-menu-note">
              <b>Уведомления на iPhone</b>
              Добавьте приложение на экран «Домой»: «Поделиться» → «На экран „Домой“».
            </div>
          ) : (
            <MenuItem
              icon={<Bell size={16} />}
              onSelect={() => {
                setToolsAnchor(null);
                void requestNotifications(uid).then(setNotif);
              }}
            >
              Разрешить уведомления
            </MenuItem>
          ))}
          <div className="nx-menu-sep" />
          <MenuItem icon={<RotateCw size={16} />} onSelect={() => window.location.reload()}>Перезагрузить</MenuItem>
        </Menu>
      )}

      {createAnchor && (
        <Menu anchor={createAnchor} label="Создать" onClose={() => setCreateAnchor(null)}>
          <MenuItem icon={<FileText size={16} />} onSelect={() => { setCreateAnchor(null); setSheet('request'); }}>Новая заявка</MenuItem>
          <MenuItem icon={<MessageSquare size={16} />} onSelect={() => { setCreateAnchor(null); setSheet('chat'); }}>Новый чат</MenuItem>
          <MenuItem icon={<Users size={16} />} onSelect={() => { setCreateAnchor(null); setSheet('group'); }}>Новый групповой чат</MenuItem>
        </Menu>
      )}

      {rowMenu && menuChat && (
        <Menu anchor={rowMenu.anchor} label={chatTitle(menuChat, me, users)} onClose={() => setRowMenu(null)}>
          <MenuItem
            icon={isPinned(menuChat, uid, localPins) ? <PinOff size={16} /> : <Pin size={16} />}
            onSelect={() => { void togglePin(menuChat.id); setRowMenu(null); }}
          >
            {isPinned(menuChat, uid, localPins) ? 'Открепить' : 'Закрепить'}
          </MenuItem>
          {!isFavorites(menuChat) && !isNotifications(menuChat) && (
            <MenuItem
              icon={isArchived(menuChat, uid) ? <ArchiveRestore size={16} /> : <Archive size={16} />}
              onSelect={() => { void setArchived(menuChat.id, !isArchived(menuChat, uid)); setRowMenu(null); }}
            >
              {isArchived(menuChat, uid) ? 'Вернуть из архива' : 'В архив'}
            </MenuItem>
          )}
          {!isFavorites(menuChat) && !isNotifications(menuChat) && (
            <MenuItem icon={<Trash2 size={16} />} tone="danger" onSelect={() => { setRowMenu(null); void confirmDelete(menuChat.id); }}>
              Удалить чат
            </MenuItem>
          )}
        </Menu>
      )}

      {(sheet === 'chat' || sheet === 'group') && (
        <NewChatSheet group={sheet === 'group'} onClose={() => setSheet(null)} onCreated={(id) => { setSheet(null); onOpen(id); }} />
      )}
      {sheet === 'request' && (
        <RequestSheet onClose={() => setSheet(null)} onCreated={(id) => { setSheet(null); onOpen(id); }} />
      )}
    </aside>
  );
}

async function confirmDelete(chatId: string) {
  const chat = useChatStore.getState().chats[chatId];
  const ok = await askConfirm({
    title: 'Удалить чат?',
    text: `Переписка пропадёт у всех участников, вернуть её будет нельзя.${chat?.todoId ? ' Связанная задача уйдёт в архив.' : ''}`,
    confirm: 'Удалить',
    tone: 'danger',
  });
  if (ok) void deleteChat(chatId);
}
