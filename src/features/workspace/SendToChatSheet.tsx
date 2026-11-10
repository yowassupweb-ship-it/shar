import { useEffect, useMemo, useState } from 'react';
import { Eye, Link2, Pencil, Search } from 'lucide-react';
import {
  chatTitle, isFavorites, isGroupChat, isNotifications, lastActivity, otherParticipant, sendText, useChatStore,
} from '@/features/chat';
import { absolute, links } from '@/shared/navigation/routes';
import { myId } from '@/shared/session/session';
import { Avatar } from '@/shared/ui/Avatar';
import { Sheet } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import { workspaceApi } from './api';
import { KINDS } from './kinds';
import type { AccessLevel, AccessMode, Item, SharesState } from './types';

type Choice = 'none' | 'view' | 'edit';

/**
 * «Отправить в чат»: выбираем чат, затем — давать ли его участникам доступ к материалу и какой (просмотр или правка).
 * Доступ выдаётся каждому участнику отдельно и никогда не понижается (кто уже может править, правку не теряет).
 * Не владелец выдавать доступ не может — ему просто уходит ссылка. Если материал и так открыт всем в Шаре на правку,
 * вопрос про доступ не задаём.
 */
export function SendToChatSheet({ item, onClose }: {
  item: Pick<Item, 'id' | 'kind' | 'title' | 'isOwner'> & { accessLevel: AccessLevel; accessMode: AccessMode };
  onClose: () => void;
}) {
  const chats = useChatStore((s) => s.chats);
  const me = useChatStore((s) => s.me);
  const users = useChatStore((s) => s.users);
  const [query, setQuery] = useState('');
  const [chatId, setChatId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const title = item.title || KINDS[item.kind].untitled;
  const everyoneEdits = item.accessLevel === 'all' && item.accessMode === 'edit';

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(chats)
      .filter((c) => !isNotifications(c))
      .filter((c) => !q || chatTitle(c, me, users).toLowerCase().includes(q))
      .sort((a, b) => (isFavorites(b) ? 1 : 0) - (isFavorites(a) ? 1 : 0) || lastActivity(b) - lastActivity(a));
  }, [chats, me, users, query]);

  const chat = chatId ? chats[chatId] : undefined;
  const others = useMemo(() => (chat?.participantIds || []).map(String).filter((id) => id !== myId()), [chat]);
  const chatName = chat ? chatTitle(chat, me, users) : '';
  // Кто из участников чата уже имеет доступ: выдача доступа в кого-то, у кого он есть, — лишний вопрос.
  // Список читаем сразу при выборе чата; пока он грузится, считаем, что доступа нет (спросим, как раньше).
  const [current, setCurrent] = useState<SharesState | null>(null);
  useEffect(() => {
    if (!chatId || !item.isOwner) return undefined;
    let alive = true;
    setCurrent(null);
    void workspaceApi.shares(item.id).then((c) => { if (alive) setCurrent(c); }).catch(() => {});
    return () => { alive = false; };
  }, [chatId, item.id, item.isOwner]);
  // Доступ бывает и от папки выше (inherited) — он тоже считается; «move» у папки включает правку.
  const roleOf = (id: string) => {
    const roles = [current?.shares.find((s) => s.userId === id)?.role, ...(current?.inherited || []).filter((i) => i.kind === 'user' && i.id === id).map((i) => i.role)];
    return roles.some((r) => r === 'edit' || r === 'move') ? 'edit' : roles.some(Boolean) ? 'view' : undefined;
  };
  /** «Все в Шаре» на просмотр — просмотр есть у каждого. */
  const hasView = (id: string) => item.accessLevel === 'all' || Boolean(roleOf(id));
  const noView = others.filter((id) => !hasView(id));
  const noEdit = others.filter((id) => roleOf(id) !== 'edit');
  const viewDone = noView.length === 0;
  /** Доступ имеет смысл спрашивать, только если его можно выдать и кому-то его не хватает. */
  const canGrant = item.isOwner && !everyoneEdits && others.length > 0 && (current ? noEdit.length > 0 : true);

  async function send(choice: Choice) {
    if (!chatId) return;
    setBusy(true);
    setError('');
    try {
      if (choice !== 'none' && canGrant) {
        const current = await workspaceApi.shares(item.id);
        for (const userId of others) {
          const has = current.shares.find((s) => s.userId === userId)?.role;
          // Не понижаем: тот, у кого уже правка, остаётся с правкой; «все в Шаре» на правку покрывает всех.
          if (has === 'edit' || has === choice) continue;
          if (choice === 'view' && item.accessLevel === 'all') continue;
          await workspaceApi.setShare(item.id, { userId }, choice);
        }
      }
      const how = choice === 'edit' ? ' (можно править)' : choice === 'view' ? ' (просмотр)' : '';
      sendText(chatId, `Поделился${how}: «${title}»\n${absolute(links.office(item.kind, item.id))}`);
      showToast(`Отправлено в «${chatName}»${choice === 'none' ? '' : choice === 'edit' ? ': участники могут править' : ': участники могут смотреть'}`, 'success');
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось отправить');
      setBusy(false);
    }
  }

  // Шаг 1 — выбор чата.
  if (!chatId) {
    return (
      <Sheet title={`Отправить в чат: ${title}`} onClose={onClose}>
        <div className="cxs-controls">
          <label className="nx-field" data-variant="filter">
            <Search size={15} aria-hidden="true" />
            <span className="nx-sr">Поиск чата</span>
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Кому отправить" autoFocus />
          </label>
        </div>
        {list.length === 0 && <p className="nx-hint">Ничего не нашлось.</p>}
        {list.map((c) => {
          const name = chatTitle(c, me, users);
          const other = isGroupChat(c) ? undefined : otherParticipant(c, me, users);
          return (
            <button
              key={c.id}
              type="button"
              className="nx-pick"
              onClick={() => setChatId(String(c.id))}
            >
              <Avatar name={name} seed={c.id} src={c.avatar || other?.avatar} person={!isGroupChat(c) && !isFavorites(c)} kind={isFavorites(c) ? 'favorites' : undefined} size={36} />
              <span className="nx-pick-text"><span>{name}</span></span>
            </button>
          );
        })}
      </Sheet>
    );
  }

  // Шаг 2 — доступ.
  const group = chat ? isGroupChat(chat) : false;
  return (
    <Sheet title={`Отправить в «${chatName}»`} onClose={onClose} busy={busy}>
      <div className="nws-send">
        {canGrant ? (
          <>
            <p className="nws-send-note">
              {viewDone
                ? <>{group ? 'У всех участников чата' : 'У собеседника'} уже есть просмотр «{title}». Можно дать и редактирование.</>
                : <>Дать {group ? 'участникам чата' : 'собеседнику'} доступ к «{title}»? Без доступа материал по ссылке не откроется.
                  {group && noView.length < others.length && <> Доступ уже есть у {others.length - noView.length} из {others.length}.</>}</>}
            </p>
            <div className="nws-send-options">
              {!viewDone && (
                <button type="button" className="nx-pick" disabled={busy} onClick={() => void send('view')}>
                  <Eye size={18} aria-hidden="true" /><span className="nx-pick-text"><span>Дать просмотр</span><small>Смогут читать, но не менять</small></span>
                </button>
              )}
              <button type="button" className="nx-pick" disabled={busy} onClick={() => void send('edit')}>
                <Pencil size={18} aria-hidden="true" /><span className="nx-pick-text"><span>Дать редактирование</span><small>Смогут читать и менять</small></span>
              </button>
              <button type="button" className="nx-pick" disabled={busy} onClick={() => void send('none')}>
                <Link2 size={18} aria-hidden="true" /><span className="nx-pick-text"><span>{viewDone ? 'Оставить как есть' : 'Только ссылка, без доступа'}</span><small>{viewDone ? 'Уйдёт ссылка, права не меняются' : 'Откроется у тех, у кого доступ уже есть'}</small></span>
              </button>
            </div>
          </>
        ) : (
          <p className="nws-send-note">
            {!item.isOwner ? 'Доступом управляет владелец, поэтому уйдёт только ссылка.' : everyoneEdits ? 'Материал уже открыт всем в Шаре на редактирование — уйдёт ссылка.'
              : others.length > 0 ? 'У всех в этом чате уже есть право править — доступ не меняем, уйдёт ссылка.'
              : chat && isFavorites(chat) ? 'В «Избранное» вы пишете себе: уйдёт ссылка, давать доступ некому.' : 'В этом чате нет других участников — уйдёт ссылка.'}
            {item.isOwner && !everyoneEdits && <> Сейчас {item.accessLevel === 'all' ? 'материал открыт всем в Шаре (только просмотр)' : 'его видите только вы и те, кому выдан доступ'}; доступ можно изменить кнопкой «Поделиться».</>}
          </p>
        )}
        {error && <p className="nws-send-note nws-error" role="alert">{error}</p>}
        <div className="nws-send-actions">
          {!canGrant && <button type="button" className="nx-primary" disabled={busy} onClick={() => void send('none')}>{busy ? 'Отправляю…' : 'Отправить ссылку'}</button>}
          <button type="button" className="nx-ghost" disabled={busy} onClick={() => setChatId(null)}>Выбрать другой чат</button>
        </div>
      </div>
    </Sheet>
  );
}
