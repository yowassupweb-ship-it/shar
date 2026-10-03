import { memo, useRef, useState, type ReactNode } from 'react';
import {
  Archive, BarChart2, BellOff, File as FileIcon, FolderOpen, Image as ImageIcon, Mic, PhoneOff, Pin, Trash2, Video,
} from 'lucide-react';
import type { User } from '@/shared/types/chat';
import { renderTextWithEmoji } from '@/shared/emoji/emojiText';
import { Avatar, type AvatarKind } from '@/shared/ui/Avatar';
import { formatListTime } from '@/shared/ui/format';
import { useDraft } from './drafts';
import {
  chatTitle, describePreview, displayName, isFavorites, isGroupChat, isMuted, isNotifications, isPinned,
  isRequestChat, otherParticipant, useChatStore, type ChatRow, type PreviewKind,
} from './store';

/**
 * Строка списка чатов — перенос ChatRow из test-chat-v3 со всеми его
 * возможностями, на токенах доктрины.
 */

export interface RowHandlers {
  onOpen: (chatId: string) => void;
  onMenu: (chatId: string, at: { x: number; y: number }) => void;
  onHover: (chatId: string) => void;
  onPin: (chatId: string) => void;
  onArchive: (chatId: string) => void;
  onDelete: (chatId: string) => void;
}

const SWIPE_WIDTH = 168; // три действия по 56px
const LONG_PRESS_MS = 480;

const PREVIEW_ICON: Partial<Record<PreviewKind, ReactNode>> = {
  voice: <Mic size={14} />,
  poll: <BarChart2 size={14} />,
  photo: <ImageIcon size={14} />,
  video: <Video size={14} />,
  'call-in': <Mic size={14} />,
  'call-out': <PhoneOff size={14} />,
  'grant-file': <FileIcon size={14} />,
  'grant-folder': <FolderOpen size={14} />,
};

function readersOf(chat: ChatRow, meId: string, users: Record<string, User>): User[] {
  const last = chat.lastMessage;
  if (!last) return [];
  const markers = chat.readMessagesByUser || {};
  const readAt = chat.readAtByUser || {};
  const sentAt = new Date(last.createdAt).getTime();
  return (chat.participantIds || [])
    .map(String)
    .filter((pid) => pid !== meId)
    .filter((pid) => {
      if (markers[pid] && markers[pid] === String(last.id)) return true;
      const t = readAt[pid] ? new Date(readAt[pid]).getTime() : NaN;
      return !Number.isNaN(t) && t >= sentAt;
    })
    .map((pid) => users[pid])
    .filter((u): u is User => Boolean(u));
}

function ReadDot({ readers }: { readers: User[] }) {
  const read = readers.length > 0;
  return (
    <span className="cxl-read" data-read={read ? 'true' : undefined}>
      <span className="cxl-read-dot" aria-label={read ? 'Прочитано' : 'Не прочитано'} />
      {read && (
        <span className="cxl-readers" role="tooltip">
          <span className="cxl-readers-title">Прочитали</span>
          {readers.map((r) => (
            <span key={r.id} className="cxl-reader">
              <Avatar name={displayName(r)} seed={String(r.id)} src={r.avatar} person size={20} />
              <span>{displayName(r)}</span>
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

export const ListRow = memo(function ListRow({ chat, active, h }: { chat: ChatRow; active: boolean; h: RowHandlers }) {
  const me = useChatStore((s) => s.me);
  const users = useChatStore((s) => s.users);
  const localPins = useChatStore((s) => s.localPins);
  const typing = useChatStore((s) => s.typing[chat.id]);
  const room = useChatStore((s) => (s.rooms[chat.id]?.length ?? 0) > 0);
  const draft = useDraft(chat.id);

  const meId = String(me?.id ?? '');
  const title = chatTitle(chat, me, users);
  const group = isGroupChat(chat);
  const other = group ? undefined : otherParticipant(chat, me, users);
  const muted = isMuted(chat, meId);
  const pinned = isPinned(chat, meId, localPins);
  const unread = active ? 0 : chat.unreadCount || 0;
  const last = chat.lastMessage;
  const typingNames = typing ? Object.values(typing) : [];

  const kind: AvatarKind | undefined = isFavorites(chat) ? 'favorites'
    : isNotifications(chat) ? 'notifications'
      : isRequestChat(chat) ? 'request' : undefined;

  // Своё последнее сообщение: «Вы: » и точка прочтения. Системные строки о
  // комнатах и уведомления уже называют действующее лицо — префикс там лишний.
  const preview = describePreview(last);
  const isCallLine = preview.kind === 'call-in' || preview.kind === 'call-out';
  const mine = Boolean(last) && String(last?.authorId) === meId && !isNotifications(chat) && !isCallLine;
  let prefix = '';
  if (mine) prefix = 'Вы: ';
  else if (group && last?.authorName && !last.isSystemMessage && !isCallLine) prefix = `${last.authorName.split(' ')[0]}: `;

  const showDraft = Boolean(draft) && !active;
  const readers = mine && !typingNames.length ? readersOf(chat, meId, users) : [];
  const time = formatListTime(chat.preview ? chat.preview.at : last?.createdAt);

  // ── Свайп влево: закрепить / архив / удалить ─────────────────────────────
  const [offset, setOffset] = useState(0);
  const touch = useRef({ x: 0, y: 0, start: 0, deciding: false, horizontal: false, longPress: 0 as number | 0, pressed: false });

  const clearLongPress = () => {
    if (touch.current.longPress) { window.clearTimeout(touch.current.longPress); touch.current.longPress = 0; }
  };

  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    touch.current = { ...touch.current, x: t.clientX, y: t.clientY, start: offset, deciding: true, horizontal: false, pressed: false };
    clearLongPress();
    touch.current.longPress = window.setTimeout(() => {
      touch.current.longPress = 0;
      touch.current.pressed = true;
      touch.current.deciding = false;
      navigator.vibrate?.(8);
      h.onMenu(chat.id, { x: t.clientX, y: t.clientY });
    }, LONG_PRESS_MS);
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const st = touch.current;
    const t = e.touches[0];
    const dx = t.clientX - st.x;
    const dy = t.clientY - st.y;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) clearLongPress();
    if (!st.deciding && !st.horizontal) return;
    if (st.deciding) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      st.deciding = false;
      st.horizontal = Math.abs(dx) > Math.abs(dy) * 1.3 && (dx < 0 || st.start < 0);
    }
    if (st.horizontal) setOffset(Math.max(-SWIPE_WIDTH, Math.min(0, st.start + dx)));
  };
  const onTouchEnd = () => {
    clearLongPress();
    const st = touch.current;
    st.deciding = false;
    if (st.horizontal) {
      st.horizontal = false;
      setOffset((v) => (v < -SWIPE_WIDTH / 2 ? -SWIPE_WIDTH : 0));
    }
  };

  const hoverTimer = useRef(0);

  let previewNode: ReactNode;
  if (typingNames.length) {
    previewNode = <span className="cxl-preview" data-tone="live">{group ? `${typingNames[0]} печатает…` : 'печатает…'}</span>;
  } else if (showDraft) {
    previewNode = <span className="cxl-preview" data-tone="draft"><b>Черновик: </b>{renderTextWithEmoji(draft, `d-${chat.id}`, '1em')}</span>;
  } else if (chat.preview) {
    previewNode = <span className="cxl-preview">{renderTextWithEmoji(chat.preview.text, `r-${chat.id}`, '1em')}</span>;
  } else if (last) {
    const icon = PREVIEW_ICON[preview.kind];
    previewNode = (
      <span className="cxl-preview">
        {prefix && <b>{prefix}</b>}
        {icon && <span className="cxl-preview-icon" aria-hidden="true">{icon}</span>}
        {preview.kind === 'text' ? renderTextWithEmoji(preview.text, `p-${chat.id}`, '1em') : preview.text}
      </span>
    );
  } else {
    previewNode = <span className="cxl-preview">Нет сообщений</span>;
  }

  return (
    <div className="cxl-row-wrap" data-chat-row-id={chat.id}>
      <div className="cxl-swipe" aria-hidden={offset === 0} style={{ opacity: Math.min(1, -offset / 40) }}>
        <button type="button" className="cxl-swipe-btn" tabIndex={offset ? 0 : -1} onClick={() => { h.onPin(chat.id); setOffset(0); }} aria-label={pinned ? 'Открепить' : 'Закрепить'}>
          <Pin size={18} />
        </button>
        <button type="button" className="cxl-swipe-btn" tabIndex={offset ? 0 : -1} onClick={() => { h.onArchive(chat.id); setOffset(0); }} aria-label="В архив">
          <Archive size={18} />
        </button>
        <button type="button" className="cxl-swipe-btn" data-tone="danger" tabIndex={offset ? 0 : -1} onClick={() => { h.onDelete(chat.id); setOffset(0); }} aria-label="Удалить">
          <Trash2 size={18} />
        </button>
      </div>
      <button
        type="button"
        className="cxl-row"
        aria-current={active ? 'true' : undefined}
        data-unread={unread > 0 ? 'true' : undefined}
        data-swiping={offset !== 0 && offset !== -SWIPE_WIDTH ? 'true' : undefined}
        style={offset ? { transform: `translateX(${offset}px)` } : undefined}
        onClick={() => {
          if (touch.current.pressed) { touch.current.pressed = false; return; }
          if (offset !== 0) { setOffset(0); return; }
          h.onOpen(chat.id);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          if (touch.current.pressed) return;
          h.onMenu(chat.id, { x: e.clientX, y: e.clientY });
        }}
        onMouseEnter={() => {
          if (active) return;
          window.clearTimeout(hoverTimer.current);
          hoverTimer.current = window.setTimeout(() => h.onHover(chat.id), 150);
        }}
        onMouseLeave={() => window.clearTimeout(hoverTimer.current)}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      >
        <Avatar
          name={title}
          seed={chat.id}
          src={chat.avatar || other?.avatar}
          kind={kind}
          person={!group && !kind}
          online={Boolean(other?.isOnline)}
          room={room}
        />
        <span className="cxl-body">
          <span className="cxl-top">
            <span className="cxl-title">{title}</span>
            <span className="cxl-flags">
              {pinned && <Pin size={12} aria-label="Закреплён" />}
              {muted && <BellOff size={12} aria-label="Без звука" />}
              {mine && !typingNames.length && time && <ReadDot readers={readers} />}
              <span className="cxl-time">{time}</span>
            </span>
          </span>
          <span className="cxl-bottom">
            {previewNode}
            {unread > 0 && (
              <span className="nx-count" data-muted={muted ? 'true' : undefined} aria-label={`Непрочитанных: ${unread}`}>
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </span>
        </span>
      </button>
    </div>
  );
});
