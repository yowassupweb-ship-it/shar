import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  ArrowLeft, BellOff, CheckCircle2, ChevronDown, ChevronUp, Loader2, RotateCcw, Search, X,
} from 'lucide-react';
import { showToast } from '@/shared/ui/Toast';
import { Avatar } from '@/shared/ui/Avatar';
import { lastSeenText, plural } from '@/shared/ui/format';
import { togglePin } from './messageActions';
import {
  chatTitle, isFavorites, isGroupChat, isMuted, isNotifications, isRequestChat, loadChats, otherParticipant, previewText,
  setPanel, useChatStore, type Msg,
} from './store';

/**
 * Шапка переписки пилюлями, как панель инструментов macOS: слева —
 * «назад, аватар, имя», справа — действия. Висит над лентой без подложки,
 * лента уходит под неё. Ниже — пилюля закреплённого сообщения.
 *
 * Поиск по чату превращает шапку в поле поиска со счётчиком и стрелками.
 */

export interface SearchState {
  query: string;
  index: number;
  matches: string[];
}

export default function ChatHeader({
  chatId, onBack, search, onSearch, pinned, onJump,
}: {
  chatId: string;
  onBack: () => void;
  search: SearchState | null;
  onSearch: (s: SearchState | null) => void;
  pinned: Msg[];
  onJump: (messageId: string) => void;
}) {
  const chat = useChatStore((s) => s.chats[chatId]);
  const me = useChatStore((s) => s.me);
  const users = useChatStore((s) => s.users);
  const typing = useChatStore((s) => s.typing[chatId]);
  const panel = useChatStore((s) => s.panel);
  const [pinIndex, setPinIndex] = useState(0);
  const [requestBusy, setRequestBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const uid = String(me?.id ?? '');
  const title = chat ? chatTitle(chat, me, users) : 'Чат';
  const group = Boolean(chat && isGroupChat(chat));
  const other = chat && !group ? otherParticipant(chat, me, users) : undefined;
  const muted = Boolean(chat && isMuted(chat, uid));
  const typingNames = typing ? Object.values(typing) : [];
  const kind = chat && isFavorites(chat) ? 'favorites' : chat && isNotifications(chat) ? 'notifications' : undefined;
  const request = Boolean(chat && isRequestChat(chat));
  const requestMine = request && String(chat?.creatorId ?? '') === uid;
  const requestResolved = request && String(chat?.discussionStatus || '') === 'request_resolved';

  let subtitle = '';
  let live = false;
  if (typingNames.length) {
    live = true;
    subtitle = group ? `${typingNames.slice(0, 2).join(', ')} ${typingNames.length > 1 ? 'печатают' : 'печатает'}…` : 'печатает…';
  } else if (group) {
    const n = chat?.participantIds?.length || 0;
    subtitle = `${n} ${plural(n, ['участник', 'участника', 'участников'])}`;
  } else if (other) {
    subtitle = lastSeenText(other.lastSeen, other.isOnline);
    live = Boolean(other.isOnline);
  } else if (chat && isFavorites(chat)) {
    subtitle = 'Заметки для себя';
  }

  useEffect(() => { if (search) inputRef.current?.focus(); }, [search !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setPinIndex(0); }, [chatId, pinned.length]);

  const setRequest = async (resolved: boolean) => {
    setRequestBusy(true);
    try {
      const res = await fetch(`/api/requests/${encodeURIComponent(chatId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: uid, resolved }),
      });
      if (!res.ok) throw new Error(String(res.status));
      await loadChats();
    } catch {
      showToast('Не получилось — нет связи с сервером', 'error');
    } finally {
      setRequestBusy(false);
    }
  };

  const pin = pinned.length ? pinned[Math.min(pinIndex, pinned.length - 1)] : null;

  if (search) {
    const total = search.matches.length;
    const step = (d: number) => {
      if (!total) return;
      const index = (search.index + d + total) % total;
      onSearch({ ...search, index });
    };
    return (
      <div className="cxh">
        <div className="cxh-pill cxh-search" role="search">
          <Search size={15} aria-hidden="true" />
          <label className="nx-sr" htmlFor="cxh-search-input">Поиск в чате</label>
          <input
            id="cxh-search-input"
            ref={inputRef}
            type="search"
            value={search.query}
            placeholder="Поиск в чате"
            autoComplete="off"
            onChange={(e) => onSearch({ ...search, query: e.target.value, index: 0 })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onSearch(null);
              else if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
            }}
          />
          {search.query.trim() && (
            <span className="cxh-count" aria-live="polite">{total ? `${search.index + 1} из ${total}` : 'Не найдено'}</span>
          )}
        </div>
        <div className="cxh-pill cxh-actions">
          <button type="button" className="nx-icon-btn" disabled={total < 2} onClick={() => step(1)} aria-label="Раньше"><ChevronUp size={18} /></button>
          <button type="button" className="nx-icon-btn" disabled={total < 2} onClick={() => step(-1)} aria-label="Позже"><ChevronDown size={18} /></button>
          <button type="button" className="nx-icon-btn" onClick={() => onSearch(null)} aria-label="Закрыть поиск"><X size={18} /></button>
        </div>
      </div>
    );
  }

  // Шапка — сетка из трёх колонок, а не абсолютное позиционирование, как в
  // старом чате: там на телефоне длинное имя заезжало под кнопки. Здесь
  // середина по центру математически, имя режется многоточием и не может
  // налезть на «назад» и поиск. На десктопе «назад» нет, пилюля — слева.
  return (
    <div className="cxh">
      <div className="cxh-row">
        <button type="button" className="cxh-round cxh-back" onClick={onBack} aria-label="К списку чатов">
          <ArrowLeft size={20} aria-hidden="true" />
        </button>
        <div className="cxh-pill cxh-id">
          <button
            type="button"
            className="cxh-who"
            onClick={() => setPanel(panel === 'profile' ? null : 'profile')}
            aria-label={`Профиль: ${title}`}
            aria-expanded={panel === 'profile'}
          >
            <Avatar name={title} seed={chatId} src={chat?.avatar || other?.avatar} person={Boolean(chat && !group && !kind)} kind={kind} online={Boolean(other?.isOnline)} size={40} />
            <span className="cxh-text">
              <span className="cxh-title-line">
                <span className="cxh-title">{title}</span>
                {muted && <BellOff className="cxh-muted" size={12} aria-label="Звук выключен" />}
              </span>
              {subtitle && <span className="cxh-sub" data-live={live ? 'true' : undefined}>{subtitle}</span>}
            </span>
          </button>
        </div>
        <span className="cxh-spacer" />
        {requestMine && (
          <button type="button" className="cxh-pill cxh-request" disabled={requestBusy} onClick={() => void setRequest(!requestResolved)}>
            {requestBusy ? <Loader2 size={15} className="nx-spin" aria-hidden="true" /> : requestResolved ? <RotateCcw size={15} aria-hidden="true" /> : <CheckCircle2 size={15} aria-hidden="true" />}
            {requestResolved ? 'Возобновить заявку' : 'Закрыть заявку'}
          </button>
        )}
        <button type="button" className="cxh-round cxh-find" onClick={() => onSearch({ query: '', index: 0, matches: [] })} aria-label="Поиск в чате">
          <Search size={19} aria-hidden="true" />
        </button>
      </div>
      {pin && (
        <div className="cxh-pin" style={{ '--pin-n': Math.min(pinned.length, 4), '--pin-i': Math.min(pinIndex, pinned.length - 1) % 4 } as CSSProperties}>
          <button
            type="button"
            className="cxh-pin-body"
            onClick={() => { onJump(String(pin.id)); if (pinned.length > 1) setPinIndex((i) => (i + 1) % pinned.length); }}
            aria-label={`Закреплённое сообщение: ${previewText(pin) || 'сообщение'}. Показать в переписке`}
          >
            <span className="cxh-pin-bar" aria-hidden="true" />
            <span className="cxh-pin-text">
              <b>{pinned.length > 1 ? `Закреплённое ${Math.min(pinIndex, pinned.length - 1) + 1} из ${pinned.length}` : 'Закреплённое сообщение'}</b>
              <span>{previewText(pin) || 'Сообщение'}</span>
            </span>
          </button>
          <button type="button" className="nx-icon-btn cxh-pin-x" onClick={() => void togglePin(chatId, String(pin.id))} aria-label="Открепить" title="Открепить">
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
