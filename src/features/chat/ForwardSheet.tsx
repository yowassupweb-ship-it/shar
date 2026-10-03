import { useMemo, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import type { Message } from '@/shared/types/chat';
import { showToast } from '@/shared/ui/Toast';
import { Avatar } from '@/shared/ui/Avatar';
import { plural } from '@/shared/ui/format';
import { Sheet } from '@/shared/ui/overlay';
import { forwardMessages } from './messageActions';
import {
  chatTitle, isFavorites, isGroupChat, isNotifications, lastActivity, otherParticipant, useChatStore,
} from './store';

/** Переслать сообщения в другой чат — перенос ForwardMessageModal. */
export default function ForwardSheet({ messages, onClose, onDone }: {
  messages: Message[]; onClose: () => void; onDone?: () => void;
}) {
  const chats = useChatStore((s) => s.chats);
  const me = useChatStore((s) => s.me);
  const users = useChatStore((s) => s.users);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(chats)
      .filter((c) => !isNotifications(c))
      .filter((c) => !q || chatTitle(c, me, users).toLowerCase().includes(q))
      .sort((a, b) => (isFavorites(b) ? 1 : 0) - (isFavorites(a) ? 1 : 0) || lastActivity(b) - lastActivity(a));
  }, [chats, me, users, query]);

  const pick = async (chatId: string) => {
    if (busy) return;
    setBusy(chatId);
    const ok = await forwardMessages(chatId, messages);
    setBusy(null);
    if (ok) {
      const title = chats[chatId] ? chatTitle(chats[chatId], me, users) : 'чат';
      showToast(`Переслано в «${title}»`, 'success');
      onDone?.();
      onClose();
    }
  };

  const n = messages.length;
  return (
    <Sheet title={n > 1 ? `Переслать ${n} ${plural(n, ['сообщение', 'сообщения', 'сообщений'])}` : 'Переслать сообщение'} onClose={onClose} busy={Boolean(busy)}>
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
          <button key={c.id} type="button" className="nx-pick" disabled={Boolean(busy)} onClick={() => void pick(c.id)}>
            <Avatar
              name={title}
              seed={c.id}
              src={c.avatar || other?.avatar}
              person={!isGroupChat(c) && !isFavorites(c)}
              kind={isFavorites(c) ? 'favorites' : undefined}
              size={36}
            />
            <span className="nx-pick-text"><span>{title}</span></span>
            {busy === c.id && <Loader2 size={16} className="nx-spin" aria-label="Пересылаю" />}
          </button>
        );
      })}
    </Sheet>
  );
}
