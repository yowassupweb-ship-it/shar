import { ScrollTable } from '@/shared/ui/ScrollTable';
import { openEventById } from '@/features/calendar';
import { Fragment, memo, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import {
  ArrowRight, Bell, Calendar, CheckSquare, Eye, File as FileIcon, FileText, Folder, FolderOpen, Image as ImageIcon, MessageSquare, Mic,
  PenLine, PhoneMissed, PhoneOff, Video,
} from 'lucide-react';
import { canOpenInEditor, openInEditor, viewKindOf } from '@/features/workspace';
import type { Message, User } from '@/shared/types/chat';
import { renderTextWithEmoji } from '@/shared/emoji/emojiText';
import { Avatar } from '@/shared/ui/Avatar';
import { attachmentUrl, formatTime } from '@/shared/ui/format';
import { knownRatio, rememberRatio, thumbUrl } from '@/shared/ui/media';
import { computeAlbumLayout } from './album';
import { openDocument, releasePreview } from '../store';
import { navigate } from '@/shared/navigation/navigate';
import { internalPath, links } from '@/shared/navigation/routes';
import { Spinner } from '@/shared/ui/Spinner';
import { downloadOnClick } from '@/shared/platform/download';

/**
 * Содержимое сообщения: разбор вложений и отрисовка каждого вида. Правила
 * разбора и размеры — из ChatTimelineV3, чтобы сообщения выглядели и вели себя
 * как раньше.
 */

export type Att = {
  url: string; name?: string; type?: string; mimeType?: string; size?: number;
  width?: number; height?: number; duration?: number; peaks?: number[];
  _previewUrl?: string;
};

const AUDIO_RE = /\.(mp3|wav|ogg|m4a|aac|flac|opus)(\?|$)/i;
const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|heic)(\?|$)/i;
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\uFE0F|\u200D|\s)+$/u;

export function emojiOnlyCount(text: string): number {
  const t = text.trim();
  if (!t || !EMOJI_ONLY.test(t) || /^[\d#*\s]+$/.test(t)) return 0;
  const seg = typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? Array.from(new (Intl as unknown as { Segmenter: new (l: string, o: object) => { segment: (s: string) => Iterable<unknown> } }).Segmenter('ru', { granularity: 'grapheme' }).segment(t.replace(/\s+/g, '')))
    : Array.from(t.replace(/\s+/g, ''));
  return seg.length <= 6 ? seg.length : 0;
}

export interface Parts {
  images: Att[];
  videos: Att[];
  audios: Att[];
  voice: Att[];
  files: Att[];
  hasText: boolean;
  poll?: Record<string, unknown>;
  sticker?: { url: string; emoji?: string; setName?: string };
  emojiCount: number;
  /** Только фото/видео — без подложки пузыря, время поверх картинки. */
  mediaOnly: boolean;
  /** Только голосовое — пузырь целиком занят плеером. */
  voiceOnly: boolean;
}

export function classify(m: Message): Parts {
  const atts = ((m.attachments || []) as Att[]).map((a) => ({ ...a, url: attachmentUrl(a?.url) }));
  const isAudio = (a: Att) => a.type === 'audio' || AUDIO_RE.test(String(a.url || a.name || ''));
  const isImage = (a: Att) => a.type === 'image' || (!a.type && IMAGE_RE.test(String(a.name || a.url)));
  const images = atts.filter(isImage);
  const videos = atts.filter((a) => a.type === 'video');
  const voice = atts.filter((a) => a.type === 'voice');
  const audios = atts.filter((a) => a.type !== 'voice' && isAudio(a));
  const files = atts.filter((a) => !isImage(a) && a.type !== 'video' && a.type !== 'voice' && !isAudio(a));
  const hasText = Boolean(m.content?.trim());
  const poll = m.metadata?.poll;
  const sticker = m.metadata?.sticker?.url ? m.metadata.sticker : undefined;
  const hasMedia = images.length > 0 || videos.length > 0;
  const emojiCount = hasMedia || files.length || voice.length || m.replyToId || poll || sticker ? 0 : emojiOnlyCount(m.content || '');
  return {
    images, videos, audios, voice, files, hasText, poll, sticker, emojiCount,
    mediaOnly: hasMedia && !hasText && !files.length && !audios.length && !m.replyToId,
    voiceOnly: voice.length > 0 && !hasText && !hasMedia && !files.length,
  };
}

// ── Текст: ссылки, эмодзи Apple, подсветка поиска ──────────────────────────

const URL_RE = /(https?:\/\/[^\s<>"']+[^\s<>"'.,:;!?)\]])/g;

function highlight(text: string, query: string, key: string): ReactNode {
  const q = query.trim();
  if (!q) return renderTextWithEmoji(text, key, '1.15em');
  const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return text.split(re).map((part, i) => (i % 2 === 1
    ? <mark key={`${key}-h${i}`} className="cxm-mark">{part}</mark>
    : <Fragment key={`${key}-t${i}`}>{renderTextWithEmoji(part, `${key}-t${i}`, '1.15em')}</Fragment>));
}

// ── Markdown ───────────────────────────────────────────────────────────────
// Разметка в сообщениях: **жирный**, *курсив*, ~~зачёркнутый~~, `код`, блоки
// кода, цитаты, списки и задачи, таблицы, заголовки, ссылки. Одиночный Enter
// остаётся переносом строки (remark-breaks), как в любом мессенджере.
// Безопасно: HTML не отображается, javascript:-ссылки вырезаются, картинки по
// чужим ссылкам не грузятся (показываем ссылкой — иначе ими можно следить за
// прочтением). Внутри разметки работают эмодзи Apple и подсветка поиска.

/** Есть ли в тексте разметка — иначе обходимся быстрым путём без парсера. */
const MD_HINT = /(\*\*|__|~~|`|^\s{0,3}#{1,6}\s|^\s{0,3}>|^\s{0,3}[-*+]\s|^\s{0,3}\d+[.)]\s|\[[^\]]+\]\([^)]+\)|^\s*\|.*\|\s*$|(^|\s)[*_][^\s*_][^*_\n]*[*_](?=\s|$|[.,!?]))/m;

function mapText(children: ReactNode, query: string, key: string): ReactNode {
  if (typeof children === 'string') return highlight(children, query, key);
  if (Array.isArray(children)) return children.map((c, i) => (typeof c === 'string' ? <Fragment key={i}>{highlight(c, query, `${key}-${i}`)}</Fragment> : c));
  return children;
}

/** Ссылка на страницу самого Шара (документ, чат…) открывается внутри приложения, остальные — как обычно. */
function openLink(e: React.MouseEvent, href?: string) {
  e.stopPropagation();
  const inside = href ? internalPath(href) : null;
  if (inside && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) {
    e.preventDefault();
    navigate(inside);
  }
}

function mdComponents(query: string, id: string): Components {
  const t = (tag: string) => function Wrapped({ children }: { children?: ReactNode }) {
    const Tag = tag as 'p';
    return <Tag>{mapText(children, query, `${id}-${tag}`)}</Tag>;
  };
  return {
    p: t('p'), li: t('li'), strong: t('strong'), em: t('em'), del: t('del'), td: t('td'), th: t('th'),
    h1: t('h4'), h2: t('h4'), h3: t('h5'), h4: t('h5'), h5: t('h6'), h6: t('h6'),
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => openLink(e, href)}>{children}</a>
    ),
    img: ({ src, alt }) => (
      <a href={typeof src === 'string' ? src : undefined} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>{alt || 'Картинка'}</a>
    ),
    table: ({ children }) => <ScrollTable className="cxm-md-table"><table>{children}</table></ScrollTable>,
    pre: ({ children }) => <pre className="cxm-md-pre">{children}</pre>,
    input: ({ checked }) => <input type="checkbox" checked={Boolean(checked)} disabled readOnly />,
  };
}

const MD_PLUGINS = [remarkGfm, remarkBreaks];

export const RichText = memo(function RichText({ text, query = '', id }: { text: string; query?: string; id: string }) {
  if (MD_HINT.test(text)) {
    return (
      <div className="cxm-md">
        <ReactMarkdown remarkPlugins={MD_PLUGINS} skipHtml components={mdComponents(query, id)}>{text}</ReactMarkdown>
      </div>
    );
  }
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((p, i) => (i % 2 === 1
        ? <a key={i} href={p} target="_blank" rel="noopener noreferrer" onClick={(e) => openLink(e, p)}>{p}</a>
        : <Fragment key={i}>{highlight(p, query, `${id}-${i}`)}</Fragment>))}
    </>
  );
});

export function firstUrl(text?: string): string | null {
  return (text || '').match(/https?:\/\/[^\s<>"']+/)?.[0] ?? null;
}

// ── Фото: одно или альбом, по настоящим пропорциям ──────────────────────────

type PhotoState = 'loading' | 'ok' | 'error';

/** Фото в ленте: превью под реальную ширину, не оригинал. Превью недоступно —
 *  оригинал; не открылся и он — заглушка с повтором, а не битая картинка.
 *
 *  Переход на оригинал запоминается отдельно от загрузки: раньше после
 *  удачной загрузки оригинала лента снова брала превью, то снова падало — и
 *  фото, которое только что показалось, превращалось в «Не загрузилось». */
function Photo({ att, style, width, onOpen, onRatio, className }: {
  att: Att; style?: React.CSSProperties; width: number; onOpen: () => void; onRatio: () => void; className?: string;
}) {
  const server = thumbUrl(att.url, width);
  const preview = att._previewUrl && att._previewUrl !== server ? att._previewUrl : undefined;
  const [serverReady, setServerReady] = useState(false);
  const [state, setState] = useState<PhotoState>('loading');
  const [original, setOriginal] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Настоящие пропорции загруженной картинки: ими, а не прикидкой по метаданным, задаётся рамка.
  const [natural, setNatural] = useState<number | null>(null);

  // Только что отправленное фото: пока серверная копия не скачана и не
  // декодирована, показываем локальное превью — подмена происходит, когда
  // новая картинка уже готова, без пустого кадра. После подмены превью (blob)
  // освобождается: иначе вкладка держала бы в памяти полные файлы.
  useEffect(() => {
    if (!preview || att.url.startsWith('blob:')) return undefined;
    let alive = true;
    const im = new Image();
    im.src = server;
    im.decode()
      .then(() => { if (alive) { setServerReady(true); releasePreview(preview); } })
      .catch(() => { /* сервер не отдал — остаёмся на превью, onError ниже решит дальше */ });
    return () => { alive = false; };
  }, [preview, server, att.url]);

  const thumb = preview && !serverReady ? preview : server;
  const src = original ? att.url : thumb;
  if (state === 'error') {
    return (
      <button
        type="button"
        className={`cxm-photo cxm-photo-error ${className || ''}`}
        style={style}
        onClick={(e) => { e.stopPropagation(); setState('loading'); setOriginal(false); setAttempt((n) => n + 1); }}
      >
        <ImageIcon size={22} aria-hidden="true" />
        <span>Не загрузилось · повторить</span>
      </button>
    );
  }
  return (
    <img
      // Ключ — только номер попытки: при смене адреса (превью → сервер,
      // превью ленты → оригинал) элемент не пересоздаётся и не мигает пустым.
      key={attempt}
      src={attempt ? `${src}${src.includes('?') ? '&' : '?'}r=${attempt}` : src}
      alt={att.name || 'Фото'}
      className={`cxm-photo ${className || ''}`}
      data-loaded={state === 'ok' ? 'true' : undefined}
      loading="lazy"
      decoding="async"
      draggable={false}
      style={natural && className?.includes('cxm-photo-single') ? { ...style, height: 'auto', aspectRatio: String(natural) } : style}
      onLoad={(e) => {
        const img = e.currentTarget;
        if (img.naturalWidth && img.naturalHeight) {
          // Место под фото считалось по запомненным пропорциям или по width/height
          // вложения. У снимков с телефона те — до поворота по EXIF: портрет
          // вставал в альбомную рамку и обрезался. Верим загруженной картинке и
          // перекладываем, если она не совпала с рамкой.
          const planned = knownRatio(att.url) ?? (att.width && att.height ? att.width / att.height : undefined);
          const r = img.naturalWidth / img.naturalHeight;
          rememberRatio(att.url, r);
          setNatural(r);
          if (!planned || Math.abs(planned - r) / r > 0.02) onRatio();
        }
        setState('ok');
      }}
      onError={() => {
        if (preview && !serverReady) return; // превью живо, серверную копию ждём отдельно
        if (!original && thumb !== att.url) { setOriginal(true); return; }
        // Сеть моргнула — одна тихая повторная попытка, прежде чем звать человека.
        if (attempt === 0) { setAttempt(1); return; }
        setState('error');
      }}
      onClick={(e) => { e.stopPropagation(); onOpen(); }}
    />
  );
}

const ratioOf = (a: Att, fallback: number) => knownRatio(a.url)
  || (a.width && a.height ? a.width / a.height : fallback);

export function Media({ images, videos, maxWidth, maxHeight, onOpen }: {
  images: Att[]; videos: Att[]; maxWidth: number; maxHeight: number; onOpen: (url: string, all: string[]) => void;
}) {
  const [, bump] = useState(0);
  const onRatio = () => bump((n) => n + 1);
  const all = images.map((i) => i.url);
  let photos: ReactNode = null;
  if (images.length === 1) {
    const r = ratioOf(images[0], 4 / 3);
    let w = maxWidth;
    let h = w / r;
    if (h > maxHeight) { h = maxHeight; w = h * r; }
    photos = (
      <Photo
        att={images[0]}
        className="cxm-photo-single"
        // aspect-ratio держит место до загрузки там, где высота считается сама (фото с подписью).
        style={{ width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)), aspectRatio: String(r) }}
        width={Math.max(1, Math.round(w))}
        onOpen={() => onOpen(images[0].url, all)}
        onRatio={onRatio}
      />
    );
  } else if (images.length > 1) {
    const layout = computeAlbumLayout(images.map((i) => ratioOf(i, 1.4)), maxWidth, 2, maxHeight);
    photos = (
      <div className="cxm-album" style={{ width: layout.width, height: layout.height }}>
        {images.slice(0, 4).map((img, i) => {
          const b = layout.boxes[i];
          if (!b) return null;
          return (
            <div key={img.url + i} className="cxm-album-cell" style={{ left: b.x, top: b.y, width: b.w, height: b.h }}>
              <Photo att={img} className="cxm-photo-fill" width={Math.round(b.w)} onOpen={() => onOpen(img.url, all)} onRatio={onRatio} />
              {i === 3 && images.length > 4 && <span className="cxm-album-more">+{images.length - 4}</span>}
            </div>
          );
        })}
      </div>
    );
  }
  return (
    <>
      {photos}
      {videos.map((v, i) => (
        <video key={v.url + i} className="cxm-video" src={v.url} controls playsInline preload="metadata" onClick={(e) => e.stopPropagation()} />
      ))}
    </>
  );
}

// ── Уведомление (чат «Уведомления» и системные карточки) ───────────────────

const NOTIFICATION_LABEL: Record<string, string> = {
  new_task: 'Новая задача',
  task_updated: 'Обновление задачи',
  task_status_changed: 'Изменение статуса',
  new_comment: 'Новый комментарий',
  mention: 'Упоминание',
  new_executor: 'Новый исполнитель',
  removed_executor: 'Исполнитель удалён',
  post_updated: 'Обновление публикации',
  post_status_changed: 'Статус публикации',
  post_new_comment: 'Комментарий к публикации',
  info: 'Уведомление',
};

type AnyMeta = Record<string, unknown>;
const str = (v: unknown) => (v == null ? '' : String(v));

export function notificationInfo(m: Message) {
  const md = (m.metadata || {}) as AnyMeta;
  const taskId = str(m.linkedTaskId || md.linkedTaskId || md.linked_task_id || md.taskId || md.todoId);
  const eventId = str(m.linkedEventId || md.linkedEventId || md.linked_event_id || md.eventId);
  const postId = str(m.linkedPostId || md.linkedPostId || md.linked_post_id);
  const chatId = str(m.linkedChatId || md.linkedChatId || md.linked_chat_id);
  const fileId = str(md.linkedFileId || md.fileId);
  const folderId = str(md.linkedFolderId || md.folderId);
  const actionUrl = str(md.actionUrl).trim();
  const type = str(m.notificationType).trim().toLowerCase();
  const manager = str(md.source) === 'manager';
  const label = type === 'event_reminder' ? '' : manager ? 'Колокольчик' : (NOTIFICATION_LABEL[type] || 'Уведомление');

  let action: { label: string; icon: ReactNode; run: () => void } | null = null;
  const go = (url: string) => () => { navigate(url); };
  if (actionUrl) action = { label: str(md.actionLabel).trim() || 'Открыть в менеджерке', icon: <Bell size={14} />, run: () => { window.open(actionUrl, '_blank', 'noopener,noreferrer'); } };
  else if (taskId) action = { label: 'Открыть задачу', icon: <CheckSquare size={14} />, run: go(links.task(taskId)) };
  // Событие открывается здесь же, в редакторе календаря, — без ухода со страницы.
  else if (eventId) action = { label: 'Открыть событие', icon: <Calendar size={14} />, run: () => { void openEventById(eventId); } };
  else if (chatId) action = { label: 'Открыть чат', icon: <ArrowRight size={14} />, run: go(links.chat(chatId)) };
  else if (fileId) action = { label: 'Открыть файл', icon: <FileIcon size={14} />, run: go(links.file(fileId)) };
  else if (folderId) action = { label: 'Открыть папку', icon: <FolderOpen size={14} />, run: go(links.folder(folderId)) };

  const icon = taskId ? <CheckSquare size={12} /> : eventId ? <Calendar size={12} /> : <Bell size={12} />;
  // Вид — для значка и его цвета в карточке (NoticeCard).
  const kind: NoticeKind = manager ? 'manager'
    : type.includes('comment') || type === 'mention' ? 'comment'
      : taskId ? 'task' : eventId ? 'event' : postId ? 'post' : chatId ? 'chat' : fileId || folderId ? 'file' : 'info';
  const typeLabel = label || (type === 'event_reminder' ? 'Напоминание' : KIND_LABEL[kind]);
  return {
    label, icon, action, kind, typeLabel,
    fromUserId: str(md.fromUserId || md.from_user_id), fromUserName: str(md.fromUserName || md.from_user_name).trim(),
  };
}

export type NoticeKind = 'event' | 'task' | 'comment' | 'post' | 'chat' | 'file' | 'manager' | 'info';
const KIND_LABEL: Record<NoticeKind, string> = {
  event: 'Событие', task: 'Задача', comment: 'Комментарий', post: 'Публикация', chat: 'Чат', file: 'Файл',
  manager: 'Колокольчик', info: 'Уведомление',
};
const KIND_ICON: Record<NoticeKind, ComponentType<{ size?: number }>> = {
  event: Calendar, task: CheckSquare, comment: MessageSquare, post: FileText, chat: MessageSquare, file: FolderOpen,
  manager: Bell, info: Bell,
};

/** Эмодзи в начале строки — сервер ставит их вместо значка вида; у нас значок свой. */
const LEADING_EMOJI = /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\uFE0F|\u200D|\s)+/u;
const norm = (t: string) => t.replace(LEADING_EMOJI, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Заголовок — первая строка без эмодзи; тело — остальное, если оно не
 *  повторяет заголовок (сервер часто присылает одно и то же дважды). */
export function splitNotice(content: string): { title: string; body: string } {
  const lines = (content || '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const title = (lines[0] || '').replace(LEADING_EMOJI, '').trim();
  const rest = lines.slice(1).filter((l) => norm(l) !== norm(title));
  return { title, body: rest.join('\n') };
}

/** Карточка уведомления — как в Центре уведомлений macOS: значок вида,
 *  тип и время, заголовок, тело, от кого, одно тихое действие-ссылка. */
export function NoticeCard({ m, n, time, query, actorName, actorId, actorAvatar }: {
  m: Message; n: ReturnType<typeof notificationInfo>; time: string; query: string;
  actorName?: string; actorId?: string; actorAvatar?: string;
}) {
  const { title, body } = splitNotice(m.content || '');
  const Icon = KIND_ICON[n.kind];
  return (
    <article className="cxm-notice" data-kind={n.kind}>
      <span className="cxm-notice-icon" aria-hidden="true"><Icon size={18} /></span>
      <div className="cxm-notice-main">
        <div className="cxm-notice-top">
          <span className="cxm-notice-type">{n.typeLabel}</span>
          <time dateTime={m.createdAt}>{time}</time>
        </div>
        {title && <div className="cxm-notice-title">{highlight(title, query, `nt-${m.id}`)}</div>}
        {body && <div className="cxm-notice-body">{highlight(body, query, `nb-${m.id}`)}</div>}
        {actorName && (
          <div className="cxm-notice-from">
            <Avatar name={actorName} seed={actorId || actorName} src={actorAvatar} person size={16} />
            <span>{actorName}</span>
          </div>
        )}
        {n.action && (
          <button type="button" className="cxm-notice-link" onClick={(e) => { e.stopPropagation(); n.action!.run(); }}>
            {n.action.label}<ArrowRight size={14} aria-hidden="true" />
          </button>
        )}
      </div>
    </article>
  );
}

// ── Строка голосовой комнаты: «вошёл / вышел / пропущен» ───────────────────

export function CallLine({ m }: { m: Message }) {
  const md = (m.metadata || {}) as AnyMeta;
  const missed = md.callStatus === 'missed';
  const left = md.callAction === 'left';
  const tone = missed ? 'danger' : left ? 'off' : 'ok';
  return (
    <div className="cxm-call" data-tone={tone}>
      {missed ? <PhoneMissed size={14} /> : left ? <PhoneOff size={14} /> : <Mic size={14} />}
      <span>{m.content}</span>
      <time dateTime={m.createdAt}>{formatTime(m.createdAt)}</time>
    </div>
  );
}

// ── Карточка файла или папки, которой поделились ────────────────────────────

export function SharedItemCard({ md, onOpenImage }: { md: AnyMeta; onOpenImage: (url: string) => void }) {
  const url = str(md.sharedFileUrl);
  const itemId = str(md.itemId);
  const type = str(md.sharedFileType);
  const preview = str(md.sharedFilePreview);
  const icon = type === 'folder' ? <Folder size={20} /> : type === 'image' ? <ImageIcon size={20} /> : type === 'video' ? <Video size={20} /> : <FileText size={20} />;
  return (
    <button
      type="button"
      className="cxm-shared"
      onClick={(e) => {
        e.stopPropagation();
        if (type === 'image') onOpenImage(preview || url);
        else if (itemId) navigate(type === 'folder' ? links.folder(itemId) : links.file(itemId));
        else window.open(url, '_blank', 'noopener');
      }}
    >
      {preview ? <img src={preview} alt="" /> : <span className="cxm-shared-icon">{icon}</span>}
      <span className="cxm-shared-text">
        <b>{str(md.sharedFileName)}</b>
        <span>Открыть в файлах</span>
      </span>
    </button>
  );
}

export function readerName(u: User | undefined, fallback = ''): string {
  if (!u) return fallback;
  return (u.name || u.username || fallback).trim();
}

// ── Файл: расширение, имя, размер, скачивание ───────────────────────────────

function fmtSize(b?: number): string {
  if (!b || b <= 0) return '';
  if (b < 1024) return `${b} Б`;
  if (b < 1048576) return `${(b / 1024).toFixed(1).replace('.', ',')} КБ`;
  return `${(b / 1048576).toFixed(1).replace('.', ',')} МБ`;
}

/**
 * Файл в переписке. Скачать — по карточке. Справа кнопки-иконки: просмотр (в боковой панели) — у файлов, которые она
 * умеет показать, и «Открыть в Шаре» — у всего, что умеет импорт «Офиса» (Word, Excel, CSV, Markdown, текст,
 * PowerPoint, PDF).
 */
export function FileCard({ att }: { att: Att }) {
  const name = att.name || decodeURIComponent(att.url.split('/').pop() || 'Файл');
  const ext = (name.match(/\.([a-z0-9]{1,5})$/i)?.[1] || 'файл').toUpperCase();
  const viewable = viewKindOf(name) !== null;
  const editable = canOpenInEditor(name);
  const [opening, setOpening] = useState(false);
  const card = (
    <a className="cxm-file" href={att.url} target="_blank" rel="noopener noreferrer" download={name} onClick={downloadOnClick(att.url, name)}>
      <span className="cxm-file-ext" style={{ '--tint': tintForExt(ext) } as React.CSSProperties}>{ext.slice(0, 4)}</span>
      <span className="cxm-file-text">
        <b>{name}</b>
        <span>{[fmtSize(att.size), 'Скачать'].filter(Boolean).join(' · ')}</span>
      </span>
    </a>
  );
  if (!viewable && !editable) return card;
  return (
    <div className="cxm-file-wrap" style={{ '--file-actions': (viewable ? 1 : 0) + (editable ? 1 : 0) } as React.CSSProperties}>
      {card}
      <div className="cxm-file-actions">
        {viewable && (
          <button type="button" title="Просмотр" aria-label={`Просмотр: ${name}`} onClick={(e) => { e.stopPropagation(); openDocument({ url: att.url, name, size: att.size }); }}>
            <Eye size={17} aria-hidden="true" />
          </button>
        )}
        {editable && (
          <button
            type="button"
            title="Открыть в Шаре — копия, исходный файл не изменится"
            aria-label={`Открыть в Шаре: ${name}`}
            disabled={opening}
            onClick={(e) => { e.stopPropagation(); setOpening(true); void openInEditor({ url: att.url, name, size: att.size }).finally(() => setOpening(false)); }}
          >
            {opening ? <Spinner size={16} label="Открываю" /> : <PenLine size={16} aria-hidden="true" />}
          </button>
        )}
      </div>
    </div>
  );
}

function tintForExt(ext: string): string {
  if (/PDF/.test(ext)) return 'var(--note-red)';
  if (/DOCX?|RTF|ODT/.test(ext)) return 'var(--note-blue)';
  if (/XLSX?|CSV|ODS/.test(ext)) return 'var(--note-green)';
  if (/PPTX?|KEY/.test(ext)) return 'var(--note-orange)';
  if (/ZIP|RAR|7Z|TAR|GZ/.test(ext)) return 'var(--note-purple)';
  return 'var(--note-gray)';
}
