import type { Chat, Message, User } from '@/shared/types/chat';

/** Ответ сервера, который стоит повторить: связь, таймаут, перезапуск бэкенда,
 *  перегрузка. 401 тоже временный — SessionGuard вернёт сессию, очередь дождётся. */
export function isRetryableStatus(status: number): boolean {
  return status === 0 || status === 401 || status === 408 || status === 425 || status === 429 || status >= 500;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(url: string, init: RequestInit = {}, timeoutMs = 10000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store', ...init, signal: controller.signal });
  } catch {
    throw new HttpError(0, 'network');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new HttpError(res.status, res.statusText || String(res.status));
  return (await res.json()) as T;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  chats: (userId: string) =>
    request<Chat[]>(`/api/chats?user_id=${encodeURIComponent(userId)}&include_archived=true`, {}, 15000),

  users: () => request<User[]>('/api/users', {}, 10000),

  messages: (chatId: string, opts: { limit?: number; before?: string } = {}) => {
    const qs = new URLSearchParams({ limit: String(opts.limit ?? 50) });
    if (opts.before) qs.set('before', opts.before);
    return request<{ messages: Message[]; hasMore: boolean }>(
      `/api/chats/${encodeURIComponent(chatId)}/messages?${qs}`,
      {},
      10000,
    );
  },

  send: (chatId: string, body: Record<string, unknown>) =>
    request<Message>(`/api/chats/${encodeURIComponent(chatId)}/messages`, json(body), 15000),

  markRead: (chatId: string, userId: string, lastMessageId: string) =>
    request<unknown>(`/api/chats/${encodeURIComponent(chatId)}/mark-read`, json({ userId, lastMessageId }), 8000),

  typing: (chatId: string, userId: string, userName: string, isTyping: boolean, kind: 'text' | 'file' | 'voice' = 'text') =>
    request<unknown>(`/api/chats/${encodeURIComponent(chatId)}/typing`, json({ userId, userName, isTyping, kind }), 5000),
};
