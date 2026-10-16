import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { Message } from '@/shared/types/chat';
import { showToast } from '@/shared/ui/Toast';
import { Avatar } from '@/shared/ui/Avatar';
import { plural } from '@/shared/ui/format';
import { Sheet } from '@/shared/ui/overlay';
import { navigate } from '@/shared/navigation/navigate';
import { links, paths } from '@/shared/navigation/routes';
import {
  chatTitle, isFavorites, isGroupChat, isNotifications, lastActivity, otherParticipant, setForwardDraft, useChatStore,
} from './store';

/** Открыть чат: на странице чатов — на месте, иначе переходом. */
function goToChat(chatId: string) {
  if (window.location.pathname === paths.chats) window.dispatchEvent(new CustomEvent('nx:open-chat', { detail: chatId }));
  else navigate(links.chat(chatId));
}

/**
 * Переслать сообщения в другой чат. Сообщения не уходят сразу: человека переносит в выбранный чат, а они
 * встают в композере вложением — можно дописать комментарий, убрать лишнее и отправить одной кнопкой.
 */
export default function ForwardSheet({ messages, onClose, onDone }: {
  messages: Message[]; onClose: () => void; onDone?: () => void;
}) {
  const chats = useChatStore((s) => s.chats);
  const me = useChatStore((s) => s.me);
  const users = useChatStore((s) => s.users);
  const [query, setQuery] = useState('');

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(chats)
      .filter((c) => !isNotifications(c))
      .filter((c) => !q || chatTitle(c, me, users).toLowerCase().includes(q))
      .sort((a, b) => (isFavorites(b) ? 1 : 0) - (isFavorites(a) ? 1 : 0) || lastActivity(b) - lastActivity(a));
  }, [chats, me, users, query]);

  const pick = (chatId: string) => {
    setForwardDraft(chatId, messages);
    const title = chats[chatId] ? chatTitle(chats[chatId], me, users) : 'чат';
    showToast(`Открыл «${title}»: сообщения прикреплены, нажмите «Отправить»`, 'success');
    onDone?.();
    onClose();
    goToChat(chatId);
  };

  const n = messages.length;
  return (
    <Sheet title={n > 1 ? `Переслать ${n} ${plural(n, ['сообщение', 'сообщения', 'сообщений'])}` : 'Переслать сообщение'} onClose={onClose}>
      <div className="cxs-controls">
        <label className="nx-field" data-variant="filter">
          <Search size={15} aria-hidden="true" />
          <span className="nx-sr">Поиск чата</span>
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Кому переслать" autoFocus />
        </label>
      </div>
      {list.length === 0 && <p className="nx-hint">Ничего не нашлось.</p>}
      {list.map((c) => {
        const title = chatTitle(c, me, users);
        const other = isGroupChat(c) ? undefined : otherParticipant(c, me, users);
        return (
          <button key={c.id} type="button" className="nx-pick" onClick={() => pick(c.id)}>
            <Avatar
              name={title}
              seed={c.id}
              src={c.avatar || other?.avatar}
              person={!isGroupChat(c) && !isFavorites(c)}
              kind={isFavorites(c) ? 'favorites' : undefined}
              size={36}
            />
            <span className="nx-pick-text"><span>{title}</span></span>
          </button>
        );
      })}
    </Sheet>
  );
}
