import type { Message } from '@/shared/types/chat';
import { realtime, type RealtimeEvent } from '@/shared/realtime/realtime';
import { api, HttpError } from './api';

/**
 * Транспорт переписки: как сообщение, «печатает» и «прочитано» доходят до
 * сервера. Стор зовёт только эти функции и не знает, каким путём всё ушло.
 *
 * Быстрый путь — кадр в уже открытый сокет (см. backend/chat_realtime.py):
 * ни HTTP-запроса, ни прокси, ни очереди за потоком на сервере. Сервер
 * отвечает ack (сохранено) или nack (отказ). Нет подтверждения за ACK_TIMEOUT —
 * та же отправка уходит по HTTP с тем же id: сервер узнаёт повтор по
 * первичному ключу и второй копии не создаёт.
 *
 * Сокетом пользуемся, только если сервер объявил поддержку (кадр hello).
 * Со старым сервером всё сразу идёт по HTTP, без ожидания таймаута.
 */

const ACK_TIMEOUT = 5000;

export interface OutgoingMessage {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  replyToId?: string;
  attachments?: unknown[];
  metadata?: Record<string, unknown>;
  /** Пересылка: исходное сообщение и его автор. */
  forwardedFrom?: string;
  forwardedFromUserId?: string;
  forwardedFromUsername?: string;
}

type Pending = { resolve: (m: Message) => void; reject: (e: HttpError) => void; timer: number };
const pending = new Map<string, Pending>();
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  realtime.subscribe((e: RealtimeEvent) => {
    if (e.type !== 'ack' && e.type !== 'nack') return;
    const id = String(e.id || '');
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    window.clearTimeout(p.timer);
    if (e.type === 'ack') p.resolve(e.message as Message);
    else p.reject(new HttpError(Number(e.status) || 500, String(e.error || 'nack')));
  });
  // Сокет оборвался — подтверждения по нему уже не будет. Не ждём таймаута:
  // отправка сразу уходит по HTTP с тем же id, сервер дубля не создаст.
  realtime.onStatus((status) => {
    if (status === 'open' || !pending.size) return;
    for (const [id, p] of Array.from(pending)) {
      pending.delete(id);
      window.clearTimeout(p.timer);
      p.reject(new HttpError(0, 'socket closed'));
    }
  });
}

function viaSocket(chatId: string, msg: OutgoingMessage): Promise<Message> | null {
  if (!realtime.supports('send')) return null;
  listen();
  return new Promise<Message>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(msg.id);
      reject(new HttpError(0, 'ack timeout'));
    }, ACK_TIMEOUT);
    pending.set(msg.id, { resolve, reject, timer });
    const sent = realtime.send({
      type: 'send',
      id: msg.id,
      chatId,
      content: msg.content,
      authorName: msg.authorName,
      replyToId: msg.replyToId,
      attachments: msg.attachments || [],
      metadata: msg.metadata || {},
      forwardedFrom: msg.forwardedFrom,
      forwardedFromUserId: msg.forwardedFromUserId,
      forwardedFromUsername: msg.forwardedFromUsername,
    });
    if (!sent) {
      window.clearTimeout(timer);
      pending.delete(msg.id);
      reject(new HttpError(0, 'socket closed'));
    }
  });
}

/** Отправить сообщение. Возвращает сохранённое сервером. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function sendMessage(chatId: string, msg: OutgoingMessage): Promise<Message> {
  // Черновики из старой очереди (id вида temp_…) — только по HTTP и без id:
  // сервер задаст свой, а сопоставит по clientNonce.
  const clientId = UUID_RE.test(msg.id);
  const socket = clientId ? viaSocket(chatId, msg) : null;
  if (socket) {
    try {
      return await socket;
    } catch (err) {
      // Отказ по существу (403, 400) — повторять бессмысленно.
      if (err instanceof HttpError && err.status !== 0 && err.status < 500) throw err;
      // Нет подтверждения или сбой сервера — тот же id по HTTP.
    }
  }
  return api.send(chatId, {
    ...(clientId ? { id: msg.id } : {}),
    content: msg.content,
    authorId: msg.authorId,
    authorName: msg.authorName,
    mentions: [],
    replyToId: msg.replyToId,
    attachments: msg.attachments || [],
    metadata: msg.metadata || {},
    forwardedFrom: msg.forwardedFrom,
    forwardedFromUserId: msg.forwardedFromUserId,
    forwardedFromUsername: msg.forwardedFromUsername,
  });
}

export function sendTyping(chatId: string, userId: string, userName: string, isTyping: boolean, kind: 'text' | 'file' | 'voice' = 'text') {
  if (realtime.send({ type: 'typing', chatId, userName, isTyping, kind })) return;
  api.typing(chatId, userId, userName, isTyping, kind).catch(() => {});
}

export function sendRead(chatId: string, userId: string, lastMessageId: string): Promise<unknown> {
  if (realtime.send({ type: 'read', chatId, lastMessageId })) return Promise.resolve();
  return api.markRead(chatId, userId, lastMessageId);
}
