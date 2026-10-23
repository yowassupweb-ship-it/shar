import { create } from 'zustand';
import type { Chat, Message, User } from '@/shared/types/chat';
import { api, HttpError, isRetryableStatus } from './api';
import { sendMessage, sendRead, sendTyping } from './transport';
import { realtime, type RealtimeEvent, type RealtimeStatus } from '@/shared/realtime/realtime';
import { isReadingNow } from '@/shared/platform/push/userAttention';
import type { FileRef } from '@/features/workspace';

/**
 * Состояние мессенджера живёт здесь, а не в компоненте страницы.
 *
 * Лента чата — нормализованная: `ids` в порядке времени и `byId`. Событие из
 * сокета, ответ на отправку и догоняющий запрос сливаются одной функцией
 * `upsert`, поэтому порядок их прихода ничего не решает, а повтор безвреден.
 *
 * Отправка — через очередь с `clientNonce`: сообщение сразу на экране, запрос
 * повторяется при сбое связи, бэкенд по нонсу не создаёт второй копии, а эхо из
 * сокета заменяет черновик на месте (ключ отрисовки `_key` не меняется, пузырь
 * не мигает). Очередь переживает перезагрузку страницы.
 *
 * Открытие чата не ждёт ничего: лента берётся из локального кэша мгновенно,
 * свежая страница с сервера догружается параллельно.
 */

export type SendStatus = 'sending' | 'failed';
export type Msg = Message & { _key: string; _status?: SendStatus };
export type Phase = 'idle' | 'loading' | 'ready' | 'error';
export type TypingKind = 'text' | 'file' | 'voice';

export interface Thread {
  ids: string[];
  byId: Record<string, Msg>;
  hasMore: boolean;
  phase: Phase;
  olderLoading: boolean;
}

export type ChatRow = Chat & {
  lastMessage?: Message;
  unreadCount?: number;
  readAtByUser?: Record<string, string>;
  /** Превью, которое важнее последнего сообщения: «Елена отреагировала 👍». */
  preview?: { text: string; at: string; afterId?: string };
};

/** Вложение в том виде, в каком оно уходит на сервер. */
export interface OutAttachment {
  type: string;
  url: string;
  name: string;
  size: number;
  width?: number;
  height?: number;
  duration?: number;
  peaks?: number[];
  mimeType?: string;
  /** Только на экране: процент загрузки, пока файл не дошёл. */
  _uploadProgress?: number;
  /** Локальный preview живёт до перезагрузки и не даёт изображению мигнуть при смене URL после upload. */
  _previewUrl?: string;
}

function withoutUploadProgress(attachment: OutAttachment): OutAttachment {
  const copy = { ...attachment };
  delete copy._uploadProgress;
  return copy;
}

function durableAttachment(attachment: OutAttachment): OutAttachment {
  const copy = withoutUploadProgress(attachment);
  delete copy._previewUrl;
  return copy;
}

interface OutboxEntry {
  chatId: string;
  nonce: string;
  content: string;
  replyToId?: string;
  createdAt: string;
  attempts: number;
  attachments?: OutAttachment[];
  metadata?: Record<string, unknown>;
}

interface State {
  me: User | null;
  users: Record<string, User>;
  chats: Record<string, ChatRow>;
  chatsPhase: Phase;
  threads: Record<string, Thread>;
  typing: Record<string, Record<string, string>>;
  /** Что именно делает собеседник: печатает, шлёт файл, записывает голосовое. */
  typingKind: Record<string, Record<string, TypingKind>>;
  activeChatId: string | null;
  status: RealtimeStatus;
  /** Чат → кто сейчас в его голосовой комнате. */
  rooms: Record<string, string[]>;
  /** Список показывает архив вместо активных чатов. */
  archiveView: boolean;
  /** Закрепления, сделанные здесь: сервер отдаёт pinnedByUser не всегда. */
  localPins: string[];
  /** Композер по чатам: на что отвечаем, что правим. */
  compose: Record<string, { replyToId?: string; editingId?: string }>;
  /** Боковая панель переписки: эмодзи и стикеры, профиль, просмотр вложения. */
  panel: 'emoji' | 'profile' | 'doc' | null;
  /** Вложение, открытое в панели просмотра (panel === 'doc'). */
  docView: FileRef | null;
  /** Чей профиль открыт в панели поверх профиля чата (аватар в ленте, участник). */
  personId: string | null;
  /** Режим выделения сообщений (пересылка и удаление пачкой). */
  selection: { chatId: string; ids: string[] } | null;
  /** Пересылаемые сообщения, прикреплённые к композеру чата: уходят по кнопке отправки вместе с комментарием. */
  forwardDraft: Record<string, Message[]>;
}

export const useChatStore = create<State>(() => ({
  me: null,
  users: {},
  chats: {},
  chatsPhase: 'idle',
  threads: {},
  typing: {},
  typingKind: {},
  activeChatId: null,
  status: 'connecting',
  rooms: {},
  archiveView: false,
  localPins: [],
  compose: {},
  panel: null,
  docView: null,
  personId: null,
  selection: null,
  forwardDraft: {},
}));

const set = useChatStore.setState;
const get = useChatStore.getState;

// ── Порядок ─────────────────────────────────────────────────────────────────

// База хранит время без зоны (по Москве) и так же отдаёт его в списке и ленте,
// а ответ на отправку и событие сокета — с зоной. Для сравнений время без зоны
// читаем как московское: иначе у человека не в московском поясе сообщения из
// разных путей сравнивались со сдвигом на часы, и свежее превью не вставало.
const NAIVE_ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
const ts = (iso?: string) => {
  if (!iso) return 0;
  const s = String(iso);
  return new Date(NAIVE_ISO.test(s) ? `${s.replace(' ', 'T')}+03:00` : s).getTime() || 0;
};

function cmp(a: Msg, b: Msg): number {
  const d = ts(a.createdAt) - ts(b.createdAt);
  if (d !== 0) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const emptyThread = (): Thread => ({ ids: [], byId: {}, hasMore: true, phase: 'idle', olderLoading: false });

const nonceOf = (m: Message): string | undefined => {
  const n = m.metadata?.clientNonce;
  return n ? String(n) : undefined;
};

/** Вливает сообщения в ленту. Черновик с тем же нонсом заменяется настоящим. */
function upsert(thread: Thread, incoming: Message[]): Thread {
  if (incoming.length === 0) return thread;
  const byId = { ...thread.byId };
  let ids = thread.ids;
  let reorder = false;
  for (const raw of incoming) {
    const id = String(raw.id);
    const nonce = nonceOf(raw);
    const draft = nonce && nonce !== id ? byId[nonce] : undefined;
    if (draft) {
      delete byId[nonce!];
      ids = ids.filter((x) => x !== nonce);
    }
    const prev = byId[id];
    const localAttachments = (draft?.attachments?.length ? draft.attachments : prev?.attachments) as OutAttachment[] | undefined;
    const attachments = raw.attachments?.length
      ? raw.attachments.map((attachment, index) => {
        const local = localAttachments?.[index];
        const previewUrl = local?._previewUrl || (local?.url?.startsWith('blob:') ? local.url : undefined);
        return previewUrl ? { ...attachment, _previewUrl: previewUrl } : attachment;
      })
      : draft?.attachments?.length
        ? draft.attachments
        : prev?.attachments;
    const next: Msg = {
      ...(draft || {}),
      ...(prev || {}),
      ...raw,
      id,
      ...(attachments ? { attachments } : {}),
      _key: draft?._key || prev?._key || nonce || id,
      _status: undefined,
    };
    byId[id] = next;
    if (!prev) {
      const lastId = ids[ids.length - 1];
      if (!reorder && (!lastId || cmp(byId[lastId], next) <= 0)) ids = [...ids, id];
      else { ids = [...ids, id]; reorder = true; }
    } else if (prev.createdAt !== next.createdAt) {
      reorder = true;
    }
  }
  if (reorder) ids = [...ids].sort((a, b) => cmp(byId[a], byId[b]));
  return { ...thread, ids, byId };
}

/** Черновик встаёт по времени и сохраняет свой статус отправки. */
function insertDraft(thread: Thread, draft: Msg): Thread {
  const byId = { ...thread.byId, [draft.id]: draft };
  const ids = [...thread.ids.filter((x) => x !== draft.id), draft.id].sort((a, b) => cmp(byId[a], byId[b]));
  return { ...thread, ids, byId };
}

function removeMsg(thread: Thread, id: string): Thread {
  if (!thread.byId[id]) return thread;
  const byId = { ...thread.byId };
  delete byId[id];
  return { ...thread, byId, ids: thread.ids.filter((x) => x !== id) };
}

function patchThread(chatId: string, fn: (t: Thread) => Thread) {
  set((s) => {
    const cur = s.threads[chatId] || emptyThread();
    const next = fn(cur);
    return next === cur ? s : { threads: { ...s.threads, [chatId]: next } };
  });
  previewFromThread(chatId);
  schedulePersistThread(chatId);
}

/** Список не отстаёт от ленты: если в загруженной ленте есть сообщение новее
 *  превью в списке (событие сокета потерялось, список пришёл из старого кэша
 *  или запрос списка не удался), превью берётся из ленты. Черновики не в счёт —
 *  их в список кладёт сама отправка. */
function previewFromThread(chatId: string) {
  const { threads, chats } = get();
  const t = threads[chatId];
  const chat = chats[chatId];
  if (!t || !chat) return;
  let newest: Msg | undefined;
  for (let i = t.ids.length - 1; i >= 0; i--) {
    const m = t.byId[t.ids[i]];
    if (m && !m._status) { newest = m; break; }
  }
  if (!newest) return;
  if (String(chat.lastMessage?.id ?? '') === newest.id) {
    // То же сообщение, но его правили: превью в списке должно показать новый текст.
    if (chat.lastMessage && (chat.lastMessage.content !== newest.content || Boolean(chat.lastMessage.isEdited) !== Boolean(newest.isEdited))) {
      const { content, isEdited } = newest;
      patchChat(chatId, (c) => (c.lastMessage ? { ...c, lastMessage: { ...c.lastMessage, content, isEdited } } : c));
    }
    return;
  }
  if (ts(newest.createdAt) <= ts(chat.lastMessage?.createdAt)) return;
  const { _key, _status, ...message } = newest;
  touchPreview(chatId, message);
}

function patchChat(chatId: string, fn: (c: ChatRow) => ChatRow) {
  set((s) => {
    const cur = s.chats[chatId];
    if (!cur) return s;
    return { chats: { ...s.chats, [chatId]: fn(cur) } };
  });
  schedulePersistChats();
}

// ── Локальный кэш ───────────────────────────────────────────────────────────
// localStorage, а не IndexedDB: чтение синхронное, лента есть уже в первом
// кадре. Храним хвост ленты (последние 60) — этого хватает на экран.

const CACHE_V = 'cxn1';
const THREAD_TAIL = 60;
const MAX_CACHED_THREADS = 40;

const lsGet = <T,>(key: string): T | null => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch { return null; }
};
const lsSet = (key: string, value: unknown) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* переполнено — живём без кэша */ }
};
const lsDel = (key: string) => { try { localStorage.removeItem(key); } catch { /* ignore */ } };

const threadKey = (chatId: string) => `${CACHE_V}:thread:${chatId}`;
const chatsKey = (uid: string) => `${CACHE_V}:chats:${uid}`;
const usersKey = `${CACHE_V}:users`;
const outboxKey = (uid: string) => `${CACHE_V}:outbox:${uid}`;
const lruKey = `${CACHE_V}:lru`;

const persistTimers = new Map<string, number>();
function debounce(key: string, fn: () => void, ms = 400) {
  const prev = persistTimers.get(key);
  if (prev) window.clearTimeout(prev);
  persistTimers.set(key, window.setTimeout(() => { persistTimers.delete(key); fn(); }, ms));
}

function schedulePersistThread(chatId: string) {
  debounce(`t:${chatId}`, () => {
    const t = get().threads[chatId];
    if (!t) return;
    const tail = t.ids
      .map((id) => t.byId[id])
      .filter((m) => m && !m._status)
      .slice(-THREAD_TAIL)
      .map(({ _key, _status, ...m }) => ({
        ...m,
        attachments: m.attachments?.map((attachment) => durableAttachment(attachment as OutAttachment)),
      }));
    lsSet(threadKey(chatId), tail);
    const lru = (lsGet<string[]>(lruKey) || []).filter((x) => x !== chatId);
    lru.push(chatId);
    while (lru.length > MAX_CACHED_THREADS) lsDel(threadKey(lru.shift()!));
    lsSet(lruKey, lru);
  });
}

function schedulePersistChats() {
  debounce('chats', () => {
    const { me, chats } = get();
    if (me) lsSet(chatsKey(String(me.id)), Object.values(chats));
  }, 800);
}

function hydrateThread(chatId: string): Thread | null {
  const cached = lsGet<Message[]>(threadKey(chatId));
  if (!cached?.length) return null;
  return { ...upsert(emptyThread(), cached), phase: 'idle' };
}

// ── Черновики из очереди ────────────────────────────────────────────────────

function readOutbox(): OutboxEntry[] {
  const me = get().me;
  return me ? lsGet<OutboxEntry[]>(outboxKey(String(me.id))) || [] : [];
}
function writeOutbox(list: OutboxEntry[]) {
  const me = get().me;
  if (!me) return;
  if (list.length) lsSet(outboxKey(String(me.id)), list);
  else lsDel(outboxKey(String(me.id)));
}

function draftMessage(e: OutboxEntry, status: SendStatus): Msg {
  const me = get().me!;
  return {
    id: e.nonce,
    _key: e.nonce,
    _status: status,
    chatId: e.chatId,
    authorId: String(me.id),
    authorName: displayName(me),
    content: e.content,
    mentions: [],
    replyToId: e.replyToId,
    createdAt: e.createdAt,
    isEdited: false,
    attachments: e.attachments,
    metadata: { ...(e.metadata || {}), clientNonce: e.nonce },
  };
}

const inFlight = new Set<string>();
const BACKOFF = [1000, 2000, 4000, 8000, 15000, 30000];

async function deliver(nonce: string) {
  if (inFlight.has(nonce)) return;
  const entry = readOutbox().find((e) => e.nonce === nonce);
  const me = get().me;
  if (!entry || !me) return;
  inFlight.add(nonce);
  patchThread(entry.chatId, (t) => (t.byId[nonce] ? { ...t, byId: { ...t.byId, [nonce]: { ...t.byId[nonce], _status: 'sending' } } } : t));
  try {
    const saved = await sendMessage(entry.chatId, {
      id: nonce,
      content: entry.content,
      authorId: String(me.id),
      authorName: displayName(me),
      replyToId: entry.replyToId,
      attachments: (entry.attachments || []).map(durableAttachment),
      metadata: { ...(entry.metadata || {}), clientNonce: nonce },
    });
    writeOutbox(readOutbox().filter((e) => e.nonce !== nonce));
    patchThread(entry.chatId, (t) => upsert(t, [{ ...saved, metadata: { ...(saved.metadata || {}), clientNonce: nonce } }]));
    touchPreview(entry.chatId, saved);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 0;
    const attempts = entry.attempts + 1;
    const retry = isRetryableStatus(status) && attempts < BACKOFF.length;
    writeOutbox(readOutbox().map((e) => (e.nonce === nonce ? { ...e, attempts } : e)));
    if (retry) {
      window.setTimeout(() => { void deliver(nonce); }, BACKOFF[attempts - 1]);
    } else {
      patchThread(entry.chatId, (t) => (t.byId[nonce] ? { ...t, byId: { ...t.byId, [nonce]: { ...t.byId[nonce], _status: 'failed' } } } : t));
    }
  } finally {
    inFlight.delete(nonce);
  }
}

function flushOutbox() {
  for (const e of readOutbox()) {
    patchThread(e.chatId, (t) => (t.byId[e.nonce] ? t : insertDraft(t, draftMessage(e, 'sending'))));
    void deliver(e.nonce);
  }
}

// ── Помощники ───────────────────────────────────────────────────────────────

export function displayName(u: User | null | undefined): string {
  if (!u) return '';
  if (u.name?.trim()) return u.name.trim();
  if (u.email?.includes('@')) return u.email.split('@')[0];
  return u.username || '';
}

export function isFavorites(c: Chat) {
  return Boolean(c.isFavoritesChat || String(c.id).startsWith('favorites_'));
}
export function isNotifications(c: Chat) {
  const id = String(c.id);
  return Boolean(c.isNotificationsChat || id.startsWith('notifications-') || id.startsWith('notifications_'));
}

export function otherParticipant(c: Chat, me: User | null, users: Record<string, User>): User | undefined {
  if (c.isGroup || !me) return undefined;
  const other = (c.participantIds || []).map(String).find((id) => id !== String(me.id));
  return other ? users[other] : undefined;
}

export function chatTitle(c: Chat, me: User | null, users: Record<string, User>): string {
  if (isFavorites(c)) return 'Избранное';
  if (isNotifications(c)) return 'Уведомления';
  if (c.title?.trim()) return c.title.trim();
  const others = (c.participantIds || []).map(String).filter((id) => id !== String(me?.id ?? ''));
  if (!others.length) return 'Личные заметки';
  const names = others.map((id) => displayName(users[id])).filter(Boolean);
  return names.length ? names.join(', ') : 'Чат';
}

export const isRequestChat = (c: Chat) => /^Заявка\s+№/.test(c.title || '');

export function isGroupChat(c: Chat) {
  return Boolean(c.isGroup) || (c.participantIds?.length ?? 0) > 2;
}

const truthy = (v: unknown) => v === true || String(v).toLowerCase() === 'true';

export function isPinned(c: Chat, uid: string, localPins: string[]): boolean {
  return truthy(c.pinnedByUser?.[uid]) || localPins.includes(String(c.id));
}

export function isMuted(c: Chat, uid: string): boolean {
  if (truthy(c.mutedByUser?.[uid])) return true;
  try { return localStorage.getItem(`chat_muted:${c.id}:${uid}`) === 'true'; } catch { return false; }
}

export function isArchived(c: ChatRow, uid: string): boolean {
  if (isFavorites(c) || isNotifications(c)) return false;
  return truthy(c.archivedByUser?.[uid]) || Boolean(c.isArchivedForUser);
}

const isSystem = (m: Message) =>
  Boolean(m.isSystemMessage || (m as { is_system_message?: boolean }).is_system_message || m.metadata?.systemEvent);

export type PreviewKind = 'text' | 'voice' | 'poll' | 'photo' | 'video' | 'file' | 'sticker' | 'call-in' | 'call-out' | 'grant-file' | 'grant-folder';

type AttachmentLike = { type?: string; fileType?: string; mimeType?: string; name?: string; filename?: string; duration?: number };

/** Превью в списке, цитатах и уведомлениях — без символов разметки:
 *  «**Срочно**» показываем как «Срочно». Снимаем только парные знаки, чтобы не
 *  трогать подчёркивания в именах файлов и одиночные звёздочки. */
export function plainFromMarkdown(text: string): string {
  return text
    .replace(/```[a-z0-9-]*\n?([\s\S]*?)```/gi, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/!?\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/(^|[\s(])([*_])(?=\S)([^*_\n]*?\S)\2(?=[\s).,!?:;]|$)/g, '$1$3')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}[-*+]\s+\[[ xX]\]\s+/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}


/** Текст превью и его вид — по виду список рисует значок (как в старом списке). */
export function describePreview(m?: Message): { kind: PreviewKind; text: string } {
  if (!m) return { kind: 'text', text: '' };
  const content = (m.content || '').replace(/<[^>]*>/g, '').trim();
  if (content) {
    if (/ вошёл\(-ла\) в голосовую комнату$/.test(content)) return { kind: 'call-in', text: content };
    if (/ вышел\(-ла\) из комнаты$/.test(content)) return { kind: 'call-out', text: content };
    const grant = content.match(/открыл\(а\) вам доступ к (файлу|папке) «.+»$/);
    if (grant) return { kind: grant[1] === 'файлу' ? 'grant-file' : 'grant-folder', text: content };
    return { kind: 'text', text: plainFromMarkdown(content) };
  }
  if (m.metadata?.poll) return { kind: 'poll', text: 'Опрос' };
  const att = m.attachments?.[0] as AttachmentLike | undefined;
  if (att) {
    const type = String(att.type || att.fileType || att.mimeType || '');
    if (type === 'voice') return { kind: 'voice', text: `Голосовое сообщение · ${Math.max(0, Math.round(Number(att.duration) || 0))} сек` };
    if (type.startsWith('image') || /\.(png|jpe?g|gif|webp|heic|avif)$/i.test(String(att.name || ''))) return { kind: 'photo', text: 'Фото' };
    if (type.startsWith('video')) return { kind: 'video', text: 'Видео' };
    return { kind: 'file', text: att.name || att.filename || 'Файл' };
  }
  if (m.metadata?.sticker) return { kind: 'sticker', text: 'Стикер' };
  return { kind: 'text', text: '…' };
}

export function previewText(m?: Message): string {
  return describePreview(m).text;
}

/** Последнее сообщение из списка чатов приходит из SQL как есть — в snake_case. */
function normalizeLast(raw: unknown): Message | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  return {
    ...(r as unknown as Message),
    id: String(r.id ?? ''),
    chatId: String(r.chatId ?? r.chat_id ?? ''),
    authorId: String(r.authorId ?? r.author_id ?? ''),
    authorName: String(r.authorName ?? r.author_name ?? ''),
    createdAt: String(r.createdAt ?? r.created_at ?? ''),
    isSystemMessage: Boolean(r.isSystemMessage ?? r.is_system_message),
  };
}

export function lastActivity(c: ChatRow): number {
  return Math.max(ts(c.lastMessage?.createdAt), ts(c.preview?.at)) || ts(c.createdAt);
}

function touchPreview(chatId: string, m: Message) {
  patchChat(chatId, (c) => (ts(c.lastMessage?.createdAt) > ts(m.createdAt)
    ? c
    // Новое сообщение снимает «X отреагировал(а)» — по факту прихода, а не по
    // времени: время реакции — часы клиента, сообщения — часы сервера.
    : { ...c, lastMessage: m, preview: undefined }));
}

// ── Прочтение ───────────────────────────────────────────────────────────────

const lastReadSent: Record<string, string> = {};
const readAt: Record<string, number> = {};

function closeChatNotifications(chatId: string) {
  if (!chatId || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.ready
    .then((registration) => registration.active?.postMessage({ type: 'close-notifications', chatId }))
    .catch(() => {});
}

export function markActiveRead() {
  const { activeChatId: chatId, threads, me } = get();
  if (!chatId || !me || !isReadingNow()) return;
  const t = threads[chatId];
  const lastId = t?.ids.slice().reverse().find((id) => !t.byId[id]._status);
  const chat = get().chats[chatId];
  const hadUnread = Boolean(chat?.unreadCount);
  if (hadUnread) patchChat(chatId, (c) => ({ ...c, unreadCount: 0 }));
  if (!lastId || lastReadSent[chatId] === lastId) {
    if (hadUnread) closeChatNotifications(chatId);
    return;
  }
  closeChatNotifications(chatId);
  lastReadSent[chatId] = lastId;
  readAt[chatId] = Date.now();
  sendRead(chatId, String(me.id), lastId).catch(() => { delete lastReadSent[chatId]; });
}

// ── Загрузка ────────────────────────────────────────────────────────────────

let chatsRequest: Promise<void> | null = null;

/** Личных чатов с одной и той же парой бывает два (гонка при создании) —
 *  оставляем тот, где переписка свежее. */
function dedupePrivate(list: ChatRow[]): ChatRow[] {
  const byPair = new Map<string, ChatRow>();
  const out: ChatRow[] = [];
  for (const c of list) {
    if (isFavorites(c) || isNotifications(c) || c.isGroup) { out.push(c); continue; }
    const key = (c.participantIds || []).map(String).sort().join('|');
    const seen = byPair.get(key);
    if (!seen) { byPair.set(key, c); out.push(c); continue; }
    if (lastActivity(c) > lastActivity(seen)) {
      out[out.indexOf(seen)] = c;
      byPair.set(key, c);
    }
  }
  return out;
}

/** Лента не должна отставать от списка. Если список знает сообщение новее,
 *  чем есть в загруженной ленте этого чата (сокет пропустил событие, пуш
 *  пришёл раньше, список обновился другим путём), — догружаем ленту. */
function catchUpThreads(chats: Record<string, ChatRow>) {
  const { threads } = get();
  for (const [cid, t] of Object.entries(threads)) {
    const last = chats[cid]?.lastMessage;
    if (!last?.id || t.phase !== 'ready' || t.byId[String(last.id)]) continue;
    const newest = t.ids.length ? ts(t.byId[t.ids[t.ids.length - 1]].createdAt) : 0;
    if (ts(last.createdAt) > newest) void loadLatest(cid);
  }
}

/** Удалённые сообщения: их нельзя возвращать в превью чата как «более свежее из двух». */
const deletedMessageIds = new Set<string>();
export function markMessageDeleted(id: string, chatId?: string) {
  deletedMessageIds.add(id);
  if (deletedMessageIds.size > 500) deletedMessageIds.delete(deletedMessageIds.values().next().value as string);
  // Удалили последнее сообщение — сразу показываем предыдущее из загруженной ленты,
  // не дожидаясь перечитывания списка.
  const chat = chatId ? get().chats[chatId] : undefined;
  if (!chatId || !chat || String(chat.lastMessage?.id ?? '') !== id) return;
  const t = get().threads[chatId];
  if (!t) return;
  for (let i = t.ids.length - 1; i >= 0; i--) {
    const m = t.byId[t.ids[i]];
    if (m && !m._status && String(m.id) !== id) {
      const { _key, _status, ...message } = m;
      patchChat(chatId, (c) => ({ ...c, lastMessage: message, preview: undefined }));
      return;
    }
  }
}

export function loadChats(): Promise<void> {
  const me = get().me;
  if (!me) return Promise.resolve();
  if (chatsRequest) return chatsRequest;
  if (!Object.keys(get().chats).length) set({ chatsPhase: 'loading' });
  chatsRequest = api.chats(String(me.id))
    .then((list) => {
      const prev = get().chats;
      const active = get().activeChatId;
      const merged: ChatRow[] = [];
      for (const raw of list) {
        const c = raw as ChatRow;
        const id = String(c.id);
        const server: ChatRow = { ...c, id, lastMessage: normalizeLast(c.lastMessage) };
        const old = prev[id];
        // Сокет мог принести сообщение, которого в снимке сервера ещё нет —
        // превью берём свежее из двух.
        if (old && !deletedMessageIds.has(String(old.lastMessage?.id ?? '')) && ts(old.lastMessage?.createdAt) > ts(server.lastMessage?.createdAt)) server.lastMessage = old.lastMessage;
        if (old?.preview && String(server.lastMessage?.id ?? '') === (old.preview.afterId ?? '')) server.preview = old.preview;
        // «Прочитано» собеседника: сокет мог принести отметку новее снимка (сервер
        // рассылает её до записи в базу). Для каждого берём более позднюю — иначе
        // только что появившееся «Прочитано» пропадало до следующего обновления.
        if (old?.readAtByUser) {
          const marks = { ...(server.readMessagesByUser || {}) };
          const at = { ...(server.readAtByUser || {}) };
          for (const [uid, oldAt] of Object.entries(old.readAtByUser)) {
            if (ts(oldAt) > ts(at[uid]) && old.readMessagesByUser?.[uid]) {
              marks[uid] = old.readMessagesByUser[uid];
              at[uid] = oldAt;
            }
          }
          server.readMessagesByUser = marks;
          server.readAtByUser = at;
        }
        // Непрочитанных нет, если чат открыт или мы только что отметили
        // прочитанным именно последнее сообщение из снимка.
        const readUpToLast = Boolean(server.lastMessage) && lastReadSent[id] === String(server.lastMessage?.id);
        const justRead = Date.now() - (readAt[id] || 0) < 15000;
        if (id === active || readUpToLast || justRead || isFavorites(server)) server.unreadCount = 0;
        merged.push(server);
      }
      const chats: Record<string, ChatRow> = {};
      for (const c of dedupePrivate(merged)) chats[c.id] = c;
      set({ chats, chatsPhase: 'ready' });
      catchUpThreads(chats);
      schedulePersistChats();
      schedulePrefetch();
    })
    .catch(() => { if (get().chatsPhase !== 'ready') set({ chatsPhase: 'error' }); })
    .finally(() => { chatsRequest = null; });
  return chatsRequest;
}

let statusTimer: number | null = null;

/** Лёгкая сверка «в сети»: события presence теряются при обрыве сокета, поэтому раз в минуту (пока вкладка на экране) сверяемся. */
function refreshStatuses() {
  if (document.visibilityState !== 'visible') return;
  fetch('/api/users/statuses', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((rows: { id: string; isOnline?: boolean; lastSeen?: string }[] | null) => {
      if (!Array.isArray(rows)) return;
      set((st) => {
        let changed = false;
        const users = { ...st.users };
        for (const r of rows) {
          const u = users[String(r.id)];
          if (!u) continue;
          const isOnline = r.isOnline === true;
          const lastSeen = r.lastSeen || u.lastSeen;
          if (u.isOnline !== isOnline || u.lastSeen !== lastSeen) { users[String(r.id)] = { ...u, isOnline, lastSeen }; changed = true; }
        }
        return changed ? { users } : st;
      });
    })
    .catch(() => { /* следующая сверка догонит */ });
}

function loadUsers() {
  api.users()
    .then((list) => {
      const users: Record<string, User> = {};
      for (const u of list) users[String(u.id)] = u;
      set({ users });
      lsSet(usersKey, list);
    })
    .catch(() => { /* имена останутся из кэша */ });
}

const latestRequests: Record<string, Promise<void> | undefined> = {};

// ── Упреждающая подгрузка ───────────────────────────────────────────────────
// Открытие чата мгновенно, только если его лента уже лежит в кэше. После
// загрузки списка, в простое, тянем хвосты самых свежих чатов, которых в кэше
// нет, — по два параллельно. На телефоне наведения нет, и без этого первый тап
// по чату ждал бы сеть.

const PREFETCH_TOP = 12;
let prefetchDone = false;

function schedulePrefetch() {
  if (prefetchDone) return;
  prefetchDone = true;
  const run = () => {
    const queue = Object.values(get().chats)
      .sort((a, b) => lastActivity(b) - lastActivity(a))
      .slice(0, PREFETCH_TOP)
      .map((c) => c.id)
      .filter((id) => !get().threads[id] && !lsGet(threadKey(id)));
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        if (get().threads[id]) continue;
        try {
          const { messages, hasMore } = await api.messages(id, { limit: 50 });
          if (get().threads[id]) continue; // пока ждали, чат открыли — там своя загрузка
          set((st) => ({ threads: { ...st.threads, [id]: { ...upsert(emptyThread(), messages), hasMore, phase: 'ready' } } }));
          schedulePersistThread(id);
        } catch { /* не страшно: откроют — загрузится обычным путём */ }
      }
    };
    void Promise.all([worker(), worker()]);
  };
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (idle) idle(run, { timeout: 3000 }); else window.setTimeout(run, 1500);
}

/** Свежая страница ленты. Сливается с тем, что уже есть; удалённое на сервере
 *  внутри окна страницы исчезает и локально. */
export function loadLatest(chatId: string): Promise<void> {
  const pending = latestRequests[chatId];
  if (pending) return pending;
  patchThread(chatId, (t) => (t.phase === 'ready' ? t : { ...t, phase: t.ids.length ? t.phase : 'loading' }));
  const req = api.messages(chatId, { limit: 50 })
    .then(({ messages, hasMore }) => {
      patchThread(chatId, (t) => {
        const fresh = new Set(messages.map((m) => String(m.id)));
        const floor = messages.length ? ts(messages[0].createdAt) : Infinity;
        let next = t;
        for (const id of t.ids) {
          const m = t.byId[id];
          if (!m._status && !fresh.has(id) && ts(m.createdAt) >= floor) next = removeMsg(next, id);
        }
        next = upsert(next, messages);
        return { ...next, phase: 'ready', hasMore: next.ids.length > messages.length ? t.hasMore : hasMore };
      });
      if (get().activeChatId === chatId) markActiveRead();
    })
    .catch(() => patchThread(chatId, (t) => (t.ids.length ? { ...t, phase: 'ready' } : { ...t, phase: 'error' })))
    .finally(() => { latestRequests[chatId] = undefined; });
  latestRequests[chatId] = req;
  return req;
}

export async function loadOlder(chatId: string) {
  const t = get().threads[chatId];
  if (!t || t.olderLoading || !t.hasMore) return;
  const first = t.ids.map((id) => t.byId[id]).find((m) => !m._status);
  if (!first) return;
  patchThread(chatId, (x) => ({ ...x, olderLoading: true }));
  try {
    const { messages, hasMore } = await api.messages(chatId, { limit: 50, before: first.createdAt });
    patchThread(chatId, (x) => ({ ...upsert(x, messages), hasMore, olderLoading: false }));
  } catch {
    patchThread(chatId, (x) => ({ ...x, olderLoading: false }));
  }
}

/** Догружает историю, пока в ленте не появится нужное сообщение (переход из
 *  профиля или поиска к давнему сообщению). Не больше 20 страниц. */
export async function ensureLoaded(chatId: string, messageId: string): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    const t = get().threads[chatId];
    if (t?.byId[messageId]) return true;
    if (!t || !t.hasMore) return false;
    await loadOlder(chatId);
    const after = get().threads[chatId];
    if (after && after.ids.length === t.ids.length) return Boolean(after.byId[messageId]);
  }
  return Boolean(get().threads[chatId]?.byId[messageId]);
}

export function openChat(chatId: string | null) {
  set({ activeChatId: chatId, personId: null });
  if (!chatId) return;
  if (!get().threads[chatId]) {
    const cached = hydrateThread(chatId);
    if (cached) set((s) => ({ threads: { ...s.threads, [chatId]: cached } }));
  }
  void loadLatest(chatId);
  markActiveRead();
}

// ── Отправка ────────────────────────────────────────────────────────────────

export function sendText(chatId: string, text: string, replyToId = get().compose[chatId]?.replyToId) {
  const content = text.trim();
  const me = get().me;
  if (!content || !me) return;
  const nonce = crypto.randomUUID();
  const entry: OutboxEntry = { chatId, nonce, content, replyToId, createdAt: new Date().toISOString(), attempts: 0 };
  writeOutbox([...readOutbox(), entry]);
  const draft = draftMessage(entry, 'sending');
  patchThread(chatId, (t) => insertDraft(t, draft));
  touchPreview(chatId, draft);
  setCompose(chatId, {});
  void deliver(nonce);
}

/** Прикрепить сообщения к композеру чата для пересылки (null или пусто — снять). */
export function setForwardDraft(chatId: string, messages: Message[] | null) {
  set((st) => {
    const next = { ...st.forwardDraft };
    if (messages && messages.length) next[chatId] = messages; else delete next[chatId];
    return { forwardDraft: next };
  });
}

export function setCompose(chatId: string, value: { replyToId?: string; editingId?: string }) {
  set((st) => ({ compose: { ...st.compose, [chatId]: value } }));
}

export function retrySend(chatId: string, nonce: string) {
  // Файлы, которые так и не загрузились, перезагружаем заново.
  const files = pendingFiles.get(nonce);
  if (files && !readOutbox().some((e) => e.nonce === nonce)) { void uploadAndSend(nonce, files); return; }
  writeOutbox(readOutbox().map((e) => (e.nonce === nonce ? { ...e, attempts: 0 } : e)));
  void deliver(nonce);
}

// ── Вложения: файлы, голосовые, стикеры ─────────────────────────────────────
// Сообщение с файлом появляется сразу — с превью из blob-ссылки и процентом
// загрузки. В очередь отправки оно попадает только после загрузки, уже с
// настоящим адресом: blob-ссылка умирает вместе со страницей, и дослать её
// после перезагрузки было бы нечем.

interface PendingUpload {
  chatId: string;
  files: File[];
  attachments: OutAttachment[];
  content: string;
  replyToId?: string;
  createdAt: string;
}

const pendingFiles = new Map<string, PendingUpload>();

function kindOf(file: File): string {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return 'file';
}

async function imageSize(file: File): Promise<{ width?: number; height?: number }> {
  if (!file.type.startsWith('image/') || typeof createImageBitmap === 'undefined') return {};
  try {
    const bmp = await createImageBitmap(file);
    const size = { width: bmp.width, height: bmp.height };
    bmp.close();
    return size;
  } catch { return {}; }
}

let filePingAt = 0;
function pingUploading(chatId: string, kind: 'file' | 'voice', force = false) {
  const me = get().me;
  if (!me) return;
  const now = Date.now();
  if (!force && now - filePingAt < 2000) return;
  filePingAt = now;
  sendTyping(chatId, String(me.id), displayName(me), true, kind);
}

// Прогресс загрузки: сеть присылает события десятки раз в секунду, а каждое
// обновление пересобирает ленту. Рисуем не чаще раза в кадр — последнее значение.
const progressQueue = new Map<string, { chatId: string; pct: number }>();
let progressFrame = 0;
function setUploadProgress(chatId: string, nonce: string, pct: number) {
  progressQueue.set(nonce, { chatId, pct });
  if (progressFrame) return;
  progressFrame = requestAnimationFrame(() => {
    progressFrame = 0;
    const batch = Array.from(progressQueue.entries());
    progressQueue.clear();
    for (const [id, { chatId: cid, pct: value }] of batch) {
      patchThread(cid, (t) => {
        const m = t.byId[id];
        if (!m) return t;
        const attachments = (m.attachments || []).map((a) => ({ ...a, _uploadProgress: value }));
        return { ...t, byId: { ...t.byId, [id]: { ...m, attachments } } };
      });
    }
  });
}

/** Серверная копия отправленного фото загружена — локальное превью больше не
 *  нужно: убираем его из сообщения и освобождаем blob (полный файл в памяти). */
export function releasePreview(url: string) {
  if (!url?.startsWith('blob:')) return;
  set((st) => {
    let changed = false;
    const threads = { ...st.threads };
    for (const [cid, t] of Object.entries(st.threads)) {
      for (const id of t.ids) {
        const m = t.byId[id];
        if (!m.attachments?.some((a) => (a as OutAttachment)._previewUrl === url)) continue;
        const attachments = (m.attachments as OutAttachment[]).map((a) => {
          if (a._previewUrl !== url) return a;
          const copy = { ...a };
          delete copy._previewUrl;
          return copy;
        });
        threads[cid] = { ...threads[cid], byId: { ...threads[cid].byId, [id]: { ...m, attachments } } };
        changed = true;
      }
    }
    return changed ? { threads } : st;
  });
  // С запасом на кадр подмены: картинка уже стоит на серверном адресе.
  window.setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* уже освобождён */ } }, 1500);
}

/** Освободить blob-превью и файлы неотправленного сообщения. */
function releaseJob(nonce: string) {
  const job = pendingFiles.get(nonce);
  if (!job) return;
  for (const a of job.attachments) if (a.url?.startsWith('blob:')) { try { URL.revokeObjectURL(a.url); } catch { /* ignore */ } }
  pendingFiles.delete(nonce);
}

async function uploadAndSend(nonce: string, job: PendingUpload) {
  const { uploadFileWithProgress } = await import('@/shared/api/uploadFile');
  const voice = job.attachments.some((a) => a.type === 'voice');
  patchThread(job.chatId, (t) => (t.byId[nonce] ? { ...t, byId: { ...t.byId, [nonce]: { ...t.byId[nonce], _status: 'sending' } } } : t));
  pingUploading(job.chatId, voice ? 'voice' : 'file', true);
  try {
    const progress = job.files.map(() => 0);
    const dimensions = job.files.map((file) => imageSize(file));
    const uploaded = await Promise.all(job.files.map(async (file, i) => {
      const res = await uploadFileWithProgress(file, (pct) => {
        progress[i] = pct;
        pingUploading(job.chatId, voice ? 'voice' : 'file');
        setUploadProgress(job.chatId, nonce, Math.round(progress.reduce((a, b) => a + b, 0) / progress.length));
      });
      const rest = withoutUploadProgress(job.attachments[i]);
      return {
        ...rest,
        ...(await dimensions[i]),
        url: res.url,
        ...(rest.type === 'image' && rest.url.startsWith('blob:') ? { _previewUrl: rest.url } : {}),
      } as OutAttachment;
    }));
    patchThread(job.chatId, (t) => {
      const draft = t.byId[nonce];
      return draft ? { ...t, byId: { ...t.byId, [nonce]: { ...draft, attachments: uploaded } } } : t;
    });
    pendingFiles.delete(nonce);
    // Фото держат blob как превью до загрузки серверной копии (releasePreview);
    // голосовым и файлам он после отправки не нужен — освобождаем сразу.
    for (const a of job.attachments) {
      if (a.type !== 'image' && a.url?.startsWith('blob:')) { try { URL.revokeObjectURL(a.url); } catch { /* ignore */ } }
    }
    const durableAttachments = uploaded.map(durableAttachment);
    const entry: OutboxEntry = {
      chatId: job.chatId, nonce, content: job.content, replyToId: job.replyToId,
      createdAt: job.createdAt, attempts: 0, attachments: durableAttachments,
    };
    writeOutbox([...readOutbox().filter((e) => e.nonce !== nonce), entry]);
    void deliver(nonce);
  } catch {
    patchThread(job.chatId, (t) => (t.byId[nonce] ? { ...t, byId: { ...t.byId, [nonce]: { ...t.byId[nonce], _status: 'failed' } } } : t));
  } finally {
    const me = get().me;
    if (me) sendTyping(job.chatId, String(me.id), displayName(me), false, voice ? 'voice' : 'file');
  }
}

/** Сигнал собеседнику: «отправляет файл» / «записывает голосовое». */
export function pingActivity(chatId: string, kind: 'file' | 'voice', stop = false) {
  const me = get().me;
  if (!me) return;
  if (stop) { sendTyping(chatId, String(me.id), displayName(me), false, kind); return; }
  pingUploading(chatId, kind);
}

/** Файлы (с подписью или без). Несколько фото уходят одним сообщением — альбомом. */
export function sendFiles(chatId: string, files: File[], caption = '') {
  const me = get().me;
  if (!me || !files.length) return;
  const nonce = crypto.randomUUID();
  const replyToId = get().compose[chatId]?.replyToId;
  const attachments: OutAttachment[] = files.map((f) => ({
    type: kindOf(f),
    url: URL.createObjectURL(f),
    name: f.name,
    size: f.size,
    mimeType: f.type,
    _uploadProgress: 0,
  }));
  const job: PendingUpload = { chatId, files, attachments, content: caption.trim(), replyToId, createdAt: new Date().toISOString() };
  pendingFiles.set(nonce, job);
  const draft = draftMessage({ chatId, nonce, content: job.content, replyToId, createdAt: job.createdAt, attempts: 0, attachments }, 'sending');
  patchThread(chatId, (t) => insertDraft(t, draft));
  touchPreview(chatId, draft);
  setCompose(chatId, {});
  void uploadAndSend(nonce, job);
}

/** Загрузить файлы для отложенного сообщения: без черновика в ленте — сообщение появится, когда уйдёт. */
export async function uploadForLater(files: File[]): Promise<OutAttachment[]> {
  const { uploadFileWithProgress } = await import('@/shared/api/uploadFile');
  return Promise.all(files.map(async (file) => {
    const [res, size] = await Promise.all([uploadFileWithProgress(file, () => {}), imageSize(file)]);
    return { type: kindOf(file), url: res.url, name: file.name, size: file.size, mimeType: file.type, ...size };
  }));
}

export function sendVoice(chatId: string, file: File, duration: number, peaks?: number[]) {
  const me = get().me;
  if (!me) return;
  const nonce = crypto.randomUUID();
  const attachments: OutAttachment[] = [{
    type: 'voice', url: URL.createObjectURL(file), name: file.name, size: file.size,
    duration: Math.round(duration), peaks, mimeType: file.type, _uploadProgress: 0,
  }];
  const replyToId = get().compose[chatId]?.replyToId;
  const job: PendingUpload = { chatId, files: [file], attachments, content: '', replyToId, createdAt: new Date().toISOString() };
  pendingFiles.set(nonce, job);
  const draft = draftMessage({ chatId, nonce, content: '', replyToId, createdAt: job.createdAt, attempts: 0, attachments }, 'sending');
  patchThread(chatId, (t) => insertDraft(t, draft));
  touchPreview(chatId, draft);
  setCompose(chatId, {});
  void uploadAndSend(nonce, job);
}

export function setSelection(value: { chatId: string; ids: string[] } | null) {
  set({ selection: value });
}

export function toggleSelected(chatId: string, id: string) {
  const cur = get().selection;
  if (!cur || cur.chatId !== chatId) { set({ selection: { chatId, ids: [id] } }); return; }
  const ids = cur.ids.includes(id) ? cur.ids.filter((x) => x !== id) : [...cur.ids, id];
  set({ selection: ids.length ? { chatId, ids } : null });
}

export function setPanel(panel: 'emoji' | 'profile' | null) {
  set({ panel, personId: null, docView: null });
}

/** Просмотр вложения в боковой панели переписки (вместо профиля или эмодзи). */
export function openDocument(file: FileRef) {
  set({ panel: 'doc', docView: file, personId: null });
}

/** Профиль человека в боковой панели; null — назад к профилю чата. */
export function openPerson(userId: string | null) {
  set({ panel: 'profile', personId: userId });
}

export function sendPoll(chatId: string, question: string, options: string[], multipleChoice: boolean, isAnonymous: boolean, allowRevote: boolean) {
  const me = get().me;
  if (!me) return;
  const nonce = crypto.randomUUID();
  const poll = {
    question,
    options: options.map((text) => ({ id: Math.random().toString(36).slice(2, 11), text, voters: [] as string[] })),
    multipleChoice, allowRevote, isAnonymous,
  };
  const entry: OutboxEntry = { chatId, nonce, content: '', createdAt: new Date().toISOString(), attempts: 0, metadata: { poll } };
  writeOutbox([...readOutbox(), entry]);
  const draft = draftMessage(entry, 'sending');
  patchThread(chatId, (t) => insertDraft(t, draft));
  touchPreview(chatId, draft);
  void deliver(nonce);
}

export function sendSticker(chatId: string, url: string, emoji: string, setName: string) {
  const me = get().me;
  if (!me) return;
  const nonce = crypto.randomUUID();
  const entry: OutboxEntry = {
    chatId, nonce, content: emoji || '🎭', createdAt: new Date().toISOString(), attempts: 0,
    replyToId: get().compose[chatId]?.replyToId,
    metadata: { sticker: { url, emoji, setName } },
  };
  writeOutbox([...readOutbox(), entry]);
  const draft = draftMessage(entry, 'sending');
  patchThread(chatId, (t) => insertDraft(t, draft));
  touchPreview(chatId, draft);
  setCompose(chatId, {});
  void deliver(nonce);
}

export function discardSend(chatId: string, nonce: string) {
  writeOutbox(readOutbox().filter((e) => e.nonce !== nonce));
  releaseJob(nonce);
  patchThread(chatId, (t) => removeMsg(t, nonce));
}

let typingSentAt = 0;
export function notifyTyping(chatId: string, active: boolean) {
  const me = get().me;
  if (!me) return;
  const now = Date.now();
  if (active && now - typingSentAt < 2500) return;
  typingSentAt = active ? now : 0;
  sendTyping(chatId, String(me.id), displayName(me), active);
}

// ── События ─────────────────────────────────────────────────────────────────

const typingTimers: Record<string, number> = {};

function setTyping(chatId: string, userId: string, name: string | null, kind: TypingKind = 'text') {
  const key = `${chatId}:${userId}`;
  if (typingTimers[key]) { window.clearTimeout(typingTimers[key]); delete typingTimers[key]; }
  set((s) => {
    const cur = { ...(s.typing[chatId] || {}) };
    const kinds = { ...(s.typingKind[chatId] || {}) };
    if (name) { cur[userId] = name; kinds[userId] = kind; } else { delete cur[userId]; delete kinds[userId]; }
    return { typing: { ...s.typing, [chatId]: cur }, typingKind: { ...s.typingKind, [chatId]: kinds } };
  });
  // Без повторного сигнала индикатор гаснет сам: печать — быстрее, загрузка — дольше.
  if (name) typingTimers[key] = window.setTimeout(() => setTyping(chatId, userId, null), kind === 'text' ? 6000 : 30000);
}

/** Видели ли уже это сообщение в событиях (и запомнить). Хватает хвоста в
 *  несколько сотен: повтор приходит через миллисекунды, а не часы. */
const seenIds = new Set<string>();
function seenMessage(id: string): boolean {
  if (seenIds.has(id)) return true;
  seenIds.add(id);
  if (seenIds.size > 500) seenIds.delete(seenIds.values().next().value as string);
  return false;
}

let chatsReloadTimer: number | null = null;
function reloadChatsSoon() {
  if (chatsReloadTimer !== null) return;
  chatsReloadTimer = window.setTimeout(() => { chatsReloadTimer = null; void loadChats(); }, 300);
}

function onEvent(e: RealtimeEvent) {
  const { me, activeChatId, threads } = get();
  if (!me) return;
  const chatId = e.chatId ? String(e.chatId) : '';

  switch (e.type) {
    case 'resync': {
      void loadChats();
      // Пока сокета не было, события «в сети / не в сети» терялись — сверяемся.
      loadUsers();
      if (activeChatId) void loadLatest(activeChatId);
      refreshRooms();
      flushOutbox();
      return;
    }
    case 'new_message': {
      const msg = normalizeLast(e.message);
      const messageChatId = chatId || msg?.chatId || '';
      if (!messageChatId) return;
      if (!msg?.id) {
        if (threads[messageChatId]) void loadLatest(messageChatId);
        reloadChatsSoon();
        return;
      }
      // Одно событие приходит дважды: из своего сокета и из сокета уведомлений
      // (мост shar:ws-event). Лента чата может быть не загружена — тогда повтор
      // узнаём по превью в списке, иначе непрочитанных стало бы на одно больше.
      const known = seenMessage(String(msg.id))
        || Boolean(threads[messageChatId]?.byId[String(msg.id)])
        || String(get().chats[messageChatId]?.lastMessage?.id ?? '') === String(msg.id);
      if (threads[messageChatId] || messageChatId === activeChatId) patchThread(messageChatId, (t) => upsert(t, [msg]));
      if (!get().chats[messageChatId]) { reloadChatsSoon(); return; }
      touchPreview(messageChatId, msg);
      setTyping(messageChatId, String(msg.authorId), null);
      const mine = String(msg.authorId) === String(me.id);
      const looking = messageChatId === activeChatId && isReadingNow();
      // В «Уведомлениях» всё системное и «от меня» — и всё же это новости.
      const notice = isNotifications(get().chats[messageChatId]);
      if (!known && !looking && (notice || ((!mine || msg.metadata?.source === 'manager') && !isSystem(msg)))) {
        patchChat(messageChatId, (c) => ({ ...c, unreadCount: (c.unreadCount || 0) + 1 }));
      }
      if (looking && !mine) markActiveRead();
      return;
    }
    case 'message_edited': {
      const id = String(e.messageId || '');
      patchThread(chatId, (t) => (t.byId[id] ? { ...t, byId: { ...t.byId, [id]: { ...t.byId[id], content: String(e.content ?? ''), isEdited: true } } } : t));
      return;
    }
    case 'card_updated': {
      // Карточка из внешней системы (заявка с сайта) поменяла состояние: взяли, закрыли.
      const id = String(e.messageId || '');
      patchThread(chatId, (t) => {
        const m = t.byId[id];
        return m ? { ...t, byId: { ...t.byId, [id]: { ...m, metadata: { ...(m.metadata || {}), card: e.card as Record<string, unknown> } } } } : t;
      });
      return;
    }
    case 'message_deleted': {
      if (e.messageId) markMessageDeleted(String(e.messageId), chatId);
      patchThread(chatId, (t) => removeMsg(t, String(e.messageId || '')));
      reloadChatsSoon();
      return;
    }
    case 'reaction': {
      const id = String(e.messageId || '');
      const actor = String(e.actorUserId || '');
      // В списке показываем только реакции на мои сообщения — как в Telegram.
      // Реакция на чужое сообщение в общем чате — не новость для меня.
      const target = get().threads[chatId]?.byId[id] || (String(get().chats[chatId]?.lastMessage?.id) === id ? get().chats[chatId]?.lastMessage : undefined);
      if (actor && actor !== String(me.id) && target && String(target.authorId) === String(me.id)) {
        const emoji = Object.entries((e.reactions || {}) as Record<string, string[]>)
          .find(([, who]) => Array.isArray(who) && who.map(String).includes(actor))?.[0];
        if (emoji) {
          const name = displayName(get().users[actor]) || 'Кто-то';
          patchChat(chatId, (c) => ({ ...c, preview: { text: `${name} отреагировал(а) ${emoji}`, at: new Date().toISOString(), afterId: String(c.lastMessage?.id ?? '') } }));
        }
      }
      patchThread(chatId, (t) => {
        const m = t.byId[id];
        if (!m) return t;
        return { ...t, byId: { ...t.byId, [id]: { ...m, metadata: { ...(m.metadata || {}), reactions: e.reactions as Record<string, string[]> } } } };
      });
      return;
    }
    case 'push_delivered': {
      const id = String(e.messageId || '');
      patchThread(chatId, (t) => (t.byId[id] ? { ...t, byId: { ...t.byId, [id]: { ...t.byId[id], _pushDelivered: true } } } : t));
      return;
    }
    case 'poll_vote': {
      const id = String(e.messageId || '');
      patchThread(chatId, (t) => {
        const m = t.byId[id];
        if (!m) return t;
        return { ...t, byId: { ...t.byId, [id]: { ...m, metadata: { ...(m.metadata || {}), poll: e.poll as Record<string, unknown> } } } };
      });
      return;
    }
    case 'voice_listened': {
      const id = String(e.messageId || '');
      patchThread(chatId, (t) => {
        const m = t.byId[id];
        if (!m) return t;
        return { ...t, byId: { ...t.byId, [id]: { ...m, metadata: { ...(m.metadata || {}), voiceListened: true } } } };
      });
      return;
    }
    case 'read_receipt': {
      const uid = String(e.userId || '');
      patchChat(chatId, (c) => ({
        ...c,
        readMessagesByUser: { ...(c.readMessagesByUser || {}), [uid]: String(e.lastMessageId || '') },
        readAtByUser: { ...(c.readAtByUser || {}), [uid]: String(e.readAt || '') },
        ...(uid === String(me.id) ? { unreadCount: 0 } : {}),
      }));
      if (uid === String(me.id)) { readAt[chatId] = Date.now(); closeChatNotifications(chatId); }
      return;
    }
    case 'notifications_read': {
      // Прочитано на другом моём устройстве. Отмечаем время прочтения так же,
      // как при локальном: снимок списка, запрошенный чуть раньше и пришедший
      // позже, иначе вернул бы бейдж (см. justRead в loadChats).
      readAt[chatId] = Date.now();
      patchChat(chatId, (c) => ({ ...c, unreadCount: 0 }));
      closeChatNotifications(chatId);
      return;
    }
    case 'typing': {
      const uid = String(e.userId || '');
      if (!chatId || uid === String(me.id)) return;
      const kind: TypingKind = e.kind === 'file' || e.kind === 'voice' ? e.kind : 'text';
      setTyping(chatId, uid, e.isTyping === false ? null : String(e.userName || 'Кто-то'), kind);
      return;
    }
    case 'presence': {
      // Сервер считает «в сети» по открытому сокету: первый сокет человека —
      // сразу «в сети», последний закрылся — «не в сети» через 15 с (без
      // мигания при переподключении).
      const uid = String(e.userId || '');
      const user = uid ? get().users[uid] : undefined;
      if (!user) return;
      const isOnline = e.isOnline === true;
      const lastSeen = String(e.lastSeen || '') || user.lastSeen;
      if (user.isOnline === isOnline && user.lastSeen === lastSeen) return;
      set((st) => ({ users: { ...st.users, [uid]: { ...user, isOnline, lastSeen } } }));
      return;
    }
    case 'chat_created': {
      reloadChatsSoon();
      return;
    }
    default:
      if (e.type.startsWith('call_')) refreshRoomsSoon();
  }
}

// ── Голосовые комнаты ───────────────────────────────────────────────────────

export function refreshRooms() {
  fetch('/api/calls/active-rooms', { cache: 'no-store' })
    .then((r) => r.json())
    .then((data) => set({ rooms: (data?.rooms || {}) as Record<string, string[]> }))
    .catch(() => {});
}

let roomsTimer: number | null = null;
function refreshRoomsSoon() {
  if (roomsTimer !== null) window.clearTimeout(roomsTimer);
  roomsTimer = window.setTimeout(() => { roomsTimer = null; refreshRooms(); }, 200);
}

// ── Счётчик для меню и значка приложения ────────────────────────────────────
// Считаем чаты, а не сообщения — как старый интерфейс: бейдж в меню и значок
// приложения не должны расходиться.

let lastUnreadTotal = -1;
function broadcastUnread() {
  const total = unreadChatsTotal(get().chats);
  if (total === lastUnreadTotal) return;
  lastUnreadTotal = total;
  try { localStorage.setItem('shar_unread_total', String(total)); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent('shar-unread-changed', { detail: { count: total } }));
}

export function unreadChatsTotal(chats: Record<string, ChatRow>): number {
  let n = 0;
  for (const c of Object.values(chats)) if ((c.unreadCount || 0) > 0 && !isFavorites(c)) n += 1;
  return n;
}

// ── Запуск ──────────────────────────────────────────────────────────────────

// ── Догонялки: возврат в приложение и пуш, пришедший мимо сокета ──────────
// Не опрос по таймеру: одна догрузка на конкретное событие.

let lastWakeSync = 0;
function onVisible() {
  if (document.visibilityState !== 'visible') return;
  const now = Date.now();
  if (now - lastWakeSync < 2000) return;
  lastWakeSync = now;
  // На телефоне после сна сокет часто мёртв, хотя браузер этого не видит, —
  // догружаем открытый чат и список сразу, не дожидаясь сокета.
  const active = get().activeChatId;
  if (active) void loadLatest(active);
  void loadChats();
  refreshStatuses();
}

/** Сервис-воркер показал пуш о сообщении. Если за секунду оно не пришло по
 *  сокету — сокет мёртв: переподключаем и догружаем. */
function onPushSync(chatId: string, pushedAt: string) {
  const pushTs = ts(pushedAt) || Date.now();
  window.setTimeout(() => {
    const chat = get().chats[chatId];
    const have = chat ? Math.max(ts(chat.lastMessage?.createdAt), ts(chat.preview?.at)) : 0;
    // Сверяем и ленту, а не только список: список мог обновиться другим путём,
    // а открытая переписка — остаться без сообщения.
    const t = get().threads[chatId];
    const threadHave = t?.ids.length ? ts(t.byId[t.ids[t.ids.length - 1]].createdAt) : 0;
    const threadBehind = Boolean(t) && threadHave < pushTs - 5000;
    if (have >= pushTs - 5000 && !threadBehind) return; // уже есть — сокет в порядке
    if (threadBehind && have >= pushTs - 5000) { void loadLatest(chatId); return; }
    realtime.heal();
    void loadChats();
    if (get().threads[chatId] || get().activeChatId === chatId) void loadLatest(chatId);
  }, 1000);
}

function onServiceWorker(e: MessageEvent) {
  const d = (e.data || {}) as { type?: string; chatId?: string; timestamp?: string };
  if (!d.chatId) return;
  if (d.type === 'push-sync') onPushSync(String(d.chatId), String(d.timestamp || ''));
  if (d.type === 'notification-navigate') window.dispatchEvent(new CustomEvent('nx:open-chat', { detail: String(d.chatId) }));
}

let started: string | null = null;
let stopRealtime: (() => void) | null = null;
let unsubscribe: (() => void) | null = null;
let unsubscribeStatus: (() => void) | null = null;
let unsubscribeUnread: (() => void) | null = null;

export function readCachedMe(): User | null {
  return lsGet<User>('myAccount');
}

/** Всё стартует параллельно: список чатов, пользователи, сокет, лента из ссылки. */
export function boot(me: User) {
  const uid = String(me.id);
  if (started === uid) return;
  shutdown();
  started = uid;

  const cachedChats = lsGet<ChatRow[]>(chatsKey(uid)) || [];
  const cachedUsers = lsGet<User[]>(usersKey) || [];
  const chats: Record<string, ChatRow> = {};
  for (const c of cachedChats) chats[String(c.id)] = c;
  const users: Record<string, User> = {};
  // «В сети» из кэша — вчерашняя правда: до ответа сервера считаем всех не в сети.
  for (const u of cachedUsers) users[String(u.id)] = { ...u, isOnline: false };
  const localPins = lsGet<string[]>('shar_pinned_chats') || [];
  set({ me, chats, users, localPins, chatsPhase: cachedChats.length ? 'ready' : 'idle', threads: {}, typing: {}, typingKind: {} });
  unsubscribeUnread = useChatStore.subscribe((st, prev) => { if (st.chats !== prev.chats) broadcastUnread(); });
  broadcastUnread();

  unsubscribe = realtime.subscribe(onEvent);
  unsubscribeStatus = realtime.onStatus((status) => set({ status }));
  stopRealtime = realtime.start(uid);
  void loadChats();
  loadUsers();
  refreshRooms();
  flushOutbox();
  document.addEventListener('visibilitychange', onVisible);
  navigator.serviceWorker?.addEventListener('message', onServiceWorker);
  statusTimer = window.setInterval(refreshStatuses, 60000);
}

export function shutdown() {
  if (statusTimer !== null) { window.clearInterval(statusTimer); statusTimer = null; }
  document.removeEventListener('visibilitychange', onVisible);
  navigator.serviceWorker?.removeEventListener('message', onServiceWorker);
  unsubscribe?.(); unsubscribe = null;
  unsubscribeStatus?.(); unsubscribeStatus = null;
  if (unsubscribeUnread) {
    unsubscribeUnread();
    unsubscribeUnread = null;
    window.dispatchEvent(new Event('shar-unread-page-unmounted'));
  }
  stopRealtime?.(); stopRealtime = null;
  started = null;
  prefetchDone = false;
}


// ── Для соседних модулей чата ───────────────────────────────────────────────

export const internals = {
  set,
  get,
  patchChat,
  lsGet,
  lsSet,
  patchThread,
  preload(chatId: string) {
    if (get().threads[chatId]) return;
    const cached = hydrateThread(chatId);
    if (cached) set((st) => ({ threads: { ...st.threads, [chatId]: cached } }));
    void loadLatest(chatId);
  },
};
