import { memo, type CSSProperties } from 'react';
import { Bell, Check, CornerUpLeft, Forward } from 'lucide-react';
import type { Message, User } from '@/shared/types/chat';
import LinkPreview from '@/features/chat/bubbles/LinkPreview';
import StickerBubble from '@/features/chat/bubbles/StickerBubble';
import VoiceMessagePlayer from '@/features/chat/bubbles/VoiceMessagePlayer';
import PollBubble, { type PollData } from '@/features/chat/polls/PollBubble';
import { getAppleEmojiUrl } from '@/shared/emoji/appleEmoji';
import { renderTextWithEmoji } from '@/shared/emoji/emojiText';
import { Avatar } from '@/shared/ui/Avatar';
import { formatTime, tintFor } from '@/shared/ui/format';
import { previewText, type Msg } from '../store';
import {
  CallLine, classify, FileCard, firstUrl, Media, NoticeCard, notificationInfo, readerName, RichText, SharedItemCard,
} from './content';

/**
 * Одно сообщение ленты — перенос строки из ChatTimelineV3.
 *
 * Жесты (долгое нажатие, правый клик, свайпы) ловит лента на уровне
 * контейнера — по data-msg-id, — поэтому у строки нет своих слушателей,
 * кроме кнопок реакций и ответа.
 */

export interface RowCtx {
  myId: string;
  users: Record<string, User>;
  usersMap: Map<string, User>;
  isGroup: boolean;
  notificationsChat: boolean;
  mobile: boolean;
  columnWidth: number;
  query: string;
  onReply: (m: Message) => void;
  onReact: (m: Message, emoji: string) => void;
  onVote: (messageId: string, optionId: string) => void;
  onVoiceListened: (messageId: string) => void;
  onOpenImage: (url: string, all: string[]) => void;
  onJump: (messageId: string) => void;
  onAvatar?: (userId: string) => void;
  /** Режим выделения: отмеченные сообщения (null — режим выключен). */
  selected: Set<string> | null;
}

function Tail() {
  return (
    <svg className="cxn-tail" viewBox="0 0 54 43" aria-hidden="true">
      <path d="M0 0.499267L34.6094 0C33.0121 21.1337 48.9046 36.6954 53.6988 41.6932C27.9965 45.1995 3.95473 26.7565 0 0.499267Z" />
    </svg>
  );
}

function Reactions({ m, ctx }: { m: Message; ctx: RowCtx }) {
  const entries = Object.entries(m.metadata?.reactions || {}).filter(([, ids]) => Array.isArray(ids) && ids.length);
  if (!entries.length) return null;
  const shown = entries.slice(0, 3);
  return (
    <div className="cxm-reactions" onClick={(e) => e.stopPropagation()}>
      {shown.map(([emoji, ids]) => {
        const mine = ids.map(String).includes(ctx.myId);
        const people = ids.map((id) => ctx.users[String(id)]).filter(Boolean) as User[];
        const names = people.map((u) => readerName(u)).join(', ');
        return (
          <button
            key={emoji}
            type="button"
            className="cxm-reaction"
            data-mine={mine ? 'true' : undefined}
            title={names ? `${emoji} — ${names}` : emoji}
            aria-label={`${emoji}: ${ids.length}${mine ? ', вы тоже' : ''}`}
            onClick={() => ctx.onReact(m, emoji)}
          >
            <span className="cxm-reaction-people">
              {people.slice(0, 3).map((u) => (
                <Avatar key={u.id} name={readerName(u)} seed={String(u.id)} src={u.avatar} person size={16} />
              ))}
            </span>
            <img src={getAppleEmojiUrl(emoji)} alt="" draggable={false} />
            {ids.length > 1 && <span className="cxm-reaction-count">{ids.length}</span>}
          </button>
        );
      })}
      {entries.length > 3 && <span className="cxm-reaction cxm-reaction-more">+{entries.length - 3}</span>}
    </div>
  );
}

export const MessageRow = memo(function MessageRow({
  m, prev, next, reply, enter, ctx,
}: {
  m: Msg; prev?: Msg; next?: Msg; reply?: Message; enter: boolean; ctx: RowCtx;
}) {
  const md = (m.metadata || {}) as Record<string, unknown>;
  const isCall = String(m.notificationType || '').toLowerCase() === 'call';
  if (isCall) {
    return (
      <div className="cxm-row cxm-row-center" data-msg-id={m.id} data-enter={enter ? 'center' : undefined}>
        <CallLine m={m} />
      </div>
    );
  }

  const notification = ctx.notificationsChat || Boolean(m.isSystemMessage);
  const mine = String(m.authorId) === ctx.myId && !notification;
  const author = ctx.users[String(m.authorId)];
  const p = classify(m);
  const gap = 5 * 60 * 1000;
  const sameAuthor = (o?: Msg) => Boolean(o) && String(o!.authorId) === String(m.authorId)
    && !o!.isSystemMessage && Math.abs(new Date(o!.createdAt).getTime() - new Date(m.createdAt).getTime()) < gap;
  const groupedPrev = sameAuthor(prev);
  const groupedNext = sameAuthor(next);
  const last = !groupedNext;
  const time = formatTime(m.createdAt);

  // Автор уведомления: живой человек, если он есть и это не я; иначе — «Система».
  const n = notification ? notificationInfo(m) : null;
  const actor = n?.fromUserId ? ctx.users[n.fromUserId] : n?.fromUserName
    ? Object.values(ctx.users).find((u) => u.name === n.fromUserName || u.username === n.fromUserName)
    : author;
  const fromSystem = notification && (!actor || String(actor.id) === ctx.myId);
  const avatarUser = notification ? actor : author;
  const senderName = readerName(author, m.authorName || '');
  const showName = ctx.isGroup && !mine && !notification && !groupedPrev;

  const forwardedFrom = String(md.source || '') === 'manager'
    ? 'Менеджерская программа'
    : String(m.forwardedFromUsername || md.forwardedFromUsername || md.fromUserName
      || readerName(ctx.users[String(m.forwardedFromUserId || md.forwardedFromUserId || '')]) || '').trim();

  const textColor = mine ? 'var(--on-accent)' : 'var(--text-main)';
  const companion = p.hasText || p.files.length > 0;
  const avail = ctx.columnWidth > 0 ? Math.max(140, ctx.columnWidth - 88) : 480;
  const mediaW = Math.min(companion ? (ctx.mobile ? 260 : 290) : (ctx.mobile ? 320 : 480), avail);
  const albumH = ctx.mobile ? 360 : 420;
  const singleH = ctx.mobile ? 420 : 480;
  const hasReactions = Object.values(m.metadata?.reactions || {}).some((ids) => Array.isArray(ids) && ids.length);
  const bubbleless = p.emojiCount > 0 || Boolean(p.sticker);
  const tail = last && !notification && !bubbleless && !p.mediaOnly && !p.voiceOnly;
  const allUrls = p.images.map((i) => i.url);
  const url = p.hasText && !p.images.length && !bubbleless && !notification ? firstUrl(m.content) : null;

  // Время живёт в пузыре. Без реакций — справа в последней строке текста
  // (распорка в конце текста не даёт строке заехать под время); с реакциями —
  // опускается на их строку: реакции слева, время справа.
  const inBubbleReactions = hasReactions && !p.mediaOnly && !bubbleless;
  const meta = (
    <span className="cxm-meta">
      {m.isEdited && !m.isDeleted && <span>изм.</span>}
      <time dateTime={m.createdAt}>{time}</time>
    </span>
  );
  const textLast = p.hasText && !url && !p.poll && !p.voice.length && !p.files.length
    && !(md.isSharedItem && md.sharedFileUrl) && !n?.action;
  const inlineMeta = !notification && !inBubbleReactions && textLast;

  let body;
  if (p.mediaOnly) {
    body = (
      <div className="cxm-media-only">
        {forwardedFrom && <span className="cxm-overlay-pill" data-pos="top"><Forward size={12} /> От {forwardedFrom}</span>}
        {showName && <span className="cxm-overlay-pill" data-pos={forwardedFrom ? 'second' : 'top'}>{senderName}</span>}
        <Media images={p.images} videos={p.videos} maxWidth={mediaW} maxHeight={p.images.length > 1 ? albumH : singleH} onOpen={ctx.onOpenImage} />
        <time className="cxm-overlay-time" dateTime={m.createdAt}>{time}</time>
      </div>
    );
  } else if (p.emojiCount > 0) {
    const size = (p.emojiCount === 1 ? 56 : p.emojiCount === 2 ? 46 : p.emojiCount === 3 ? 38 : 32) * (ctx.mobile ? 1.08 : 1);
    body = (
      <>
        {showName && <span className="cxm-name cxm-name-outside" style={{ '--tint': tintFor(String(m.authorId)) } as CSSProperties}>{senderName}</span>}
        <div className="cxm-emoji" style={{ fontSize: Math.round(size) }}>
          {renderTextWithEmoji(m.content.trim(), `eo${m.id}`, '1em')}
        </div>
        <div className="cxm-bare-meta">{meta}</div>
      </>
    );
  } else if (p.sticker) {
    body = (
      <>
        {showName && <span className="cxm-name cxm-name-outside" style={{ '--tint': tintFor(String(m.authorId)) } as CSSProperties}>{senderName}</span>}
        <StickerBubble
          sticker={{ url: p.sticker.url, emoji: p.sticker.emoji || '', setName: p.sticker.setName || '' }}
          size={ctx.mobile ? 152 : 132}
          hasReactions={hasReactions}
          isMobileView={ctx.mobile}
          timestamp={time}
        />
      </>
    );
  } else {
    body = (
      <>
        {n && (
          <NoticeCard
            m={m}
            n={n}
            time={time}
            query={ctx.query}
            actorName={!fromSystem && actor ? readerName(actor) : undefined}
            actorId={actor ? String(actor.id) : undefined}
            actorAvatar={actor?.avatar}
          />
        )}
        {forwardedFrom && <div className="cxm-forwarded"><Forward size={14} aria-hidden="true" /> Переслано от {forwardedFrom}</div>}
        {showName && <span className="cxm-name" style={{ '--tint': tintFor(String(m.authorId)) } as CSSProperties}>{senderName}</span>}
        {m.replyToId && (
          <button
            type="button"
            className="cxm-quote"
            onClick={(e) => { e.stopPropagation(); if (reply) ctx.onJump(String(reply.id)); }}
            disabled={!reply}
          >
            <b>{reply ? readerName(ctx.users[String(reply.authorId)], reply.authorName) : 'Сообщение'}</b>
            <span>{reply ? previewText(reply) || 'Сообщение' : 'Сообщение удалено или ещё не загружено'}</span>
          </button>
        )}
        {(p.images.length > 0 || p.videos.length > 0) && (
          <div className="cxm-media-top">
            <Media images={p.images} videos={p.videos} maxWidth={mediaW} maxHeight={p.images.length > 1 ? albumH : singleH} onOpen={ctx.onOpenImage} />
          </div>
        )}
        {p.audios.map((a, i) => (
          <div key={a.url + i} className="cxm-audio" onClick={(e) => e.stopPropagation()}>
            {a.name && <span>{a.name}</span>}
            <audio src={a.url} controls preload="metadata" />
          </div>
        ))}
        {p.hasText && !n && (
          <div className="cxm-text">
            <RichText text={m.content} query={ctx.query} id={m.id} />
            {inlineMeta && <span className="cxm-meta-spacer" data-edited={m.isEdited ? 'true' : undefined} aria-hidden="true" />}
          </div>
        )}
        {url && <div className="cxm-link-preview"><LinkPreview url={url} isMyMessage={mine} /></div>}
        {p.poll && (
          <PollBubble
            poll={p.poll as unknown as PollData}
            messageId={String(m.id)}
            currentUserId={ctx.myId}
            usersById={ctx.usersMap}
            textColor={textColor}
            onVote={ctx.onVote}
          />
        )}
        {p.voice.length > 0 && (
          <div className={p.voiceOnly ? undefined : 'cxm-stack'}>
            {p.voice.map((a, i) => (
              <VoiceMessagePlayer
                key={a.url + i}
                playKey={`${m.id}-voice-${i}`}
                url={a.url}
                duration={a.duration}
                initialPeaks={a.peaks}
                fillBubble={p.voiceOnly}
                textColor={textColor}
                showUnlistenedDot={!mine && !md.voiceListened}
                onListened={() => ctx.onVoiceListened(String(m.id))}
                senderLabel={mine ? 'Вы' : senderName}
                onJumpToSelf={() => ctx.onJump(String(m.id))}
                isMobileView={ctx.mobile}
              />
            ))}
          </div>
        )}
        {p.files.length > 0 && (
          <div className="cxm-stack">
            {p.files.map((a, i) => (
              <FileCard key={a.url + i} att={a} />
            ))}
          </div>
        )}
        {Boolean(md.isSharedItem && md.sharedFileUrl) && <SharedItemCard md={md} onOpenImage={(u) => ctx.onOpenImage(u, [u])} />}
        {inlineMeta ? (
          <span className="cxm-meta-inline">{meta}</span>
        ) : !notification && (
          <div className="cxm-foot">
            {inBubbleReactions && <Reactions m={m} ctx={ctx} />}
            {meta}
          </div>
        )}
      </>
    );
  }

  return (
    <div
      className="cxm-row"
      data-msg-id={m.id}
      data-mine={mine ? 'true' : 'false'}
      data-grouped-prev={groupedPrev ? 'true' : undefined}
      data-grouped-next={groupedNext ? 'true' : undefined}
      data-notice={notification ? 'true' : undefined}
      data-status={m._status}
      data-leaving={(m as { _leaving?: boolean })._leaving ? 'true' : undefined}
      data-enter={enter ? (mine ? 'right' : 'left') : undefined}
      data-selected={ctx.selected?.has(String(m.id)) ? 'true' : undefined}
    >
      <div className="cxm-line">
        {ctx.selected && !m._status && (
          <span className="cxm-check" aria-hidden="true">
            {ctx.selected.has(String(m.id)) && <Check size={13} strokeWidth={3} />}
          </span>
        )}
        {!mine && !notification && (
          <span className="cxm-avatar-col">
            {last && (fromSystem ? (
              <span className="nx-avatar cxm-system-avatar" data-kind="notifications" style={{ '--size': '28px' } as CSSProperties} title="Система">
                <Bell size={14} aria-hidden="true" />
              </span>
            ) : (ctx.isGroup || notification) ? (
              <button
                type="button"
                className="cxm-avatar-btn"
                disabled={!ctx.onAvatar || !ctx.isGroup}
                onClick={(e) => { e.stopPropagation(); if (avatarUser) ctx.onAvatar?.(String(avatarUser.id)); }}
                aria-label={avatarUser ? `Профиль: ${readerName(avatarUser)}` : undefined}
              >
                <Avatar name={readerName(avatarUser, m.authorName)} seed={String(avatarUser?.id || m.authorId)} src={avatarUser?.avatar} person size={28} />
              </button>
            ) : (
              <Avatar name={readerName(avatarUser, m.authorName)} seed={String(avatarUser?.id || m.authorId)} src={avatarUser?.avatar} person size={28} />
            ))}
          </span>
        )}
        {mine && !inBubbleReactions && <Reactions m={m} ctx={ctx} />}
        <div
          className="cxn-bubble cxm-bubble"
          data-kind={p.mediaOnly ? 'media' : p.voiceOnly ? 'voice' : bubbleless ? 'bare' : notification ? 'notice' : undefined}
          style={{ '--tint': tintFor(String(m.authorId)) } as CSSProperties}
        >
          {body}
          {tail && <Tail />}
        </div>
        {!mine && !inBubbleReactions && <Reactions m={m} ctx={ctx} />}
        {!mine && !ctx.mobile && !notification && (
          <span className="cxm-hover-cluster">
            <button type="button" className="cxm-reply-btn" tabIndex={-1} onClick={(e) => { e.stopPropagation(); ctx.onReply(m); }} aria-label="Ответить">
              <CornerUpLeft size={13} strokeWidth={2.2} />
            </button>
          </span>
        )}
      </div>

    </div>
  );
});
