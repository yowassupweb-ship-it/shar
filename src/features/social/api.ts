/**
 * «Соцсети»: сообщения и комментарии из ВКонтакте и MAX приходят карточками в чаты Шара, ответ
 * клиенту уходит от имени сообщества или бота. Здесь — запросы раздела и кнопки «Ответить клиенту» на карточке.
 */

export type Platform = 'vk' | 'max' | 'telegram';
export type SourceType = 'private' | 'business' | 'group' | 'comments';

export interface SocialAnswer { by: string; byName: string; text: string; at: string }

/** Карточка в чате (metadata.card сообщения) и строка ленты раздела — одно и то же. */
export interface SocialCardData {
  kind: 'social';
  itemId?: string;
  /** Диалог в модуле «Соцсети», куда относится сообщение. */
  dialogId?: string;
  platform: Platform;
  platformLabel: string;
  account: string;
  sourceTitle: string;
  sourceType: SourceType;
  sourceLabel: string;
  authorName: string;
  authorUsername: string;
  text: string;
  media: string[];
  context: string;
  link: string | null;
  /** ВКонтакте даёт ответить из Шара на сообщения и комментарии на стене; на фото, видео, товары — только на сайте. */
  canReply?: boolean;
  status: 'new' | 'answered';
  answers: SocialAnswer[];
}

export interface SocialItem extends SocialCardData { id: string; createdAt: string | null; chatId: string | null; messageId: string | null }

export interface ChatRef { id: string; title: string }

export interface SocialSource {
  extChatId: string; title: string; type: SourceType; typeLabel: string; chat: ChatRef | null; lastSeen: string | null;
}

export interface SocialAccount {
  id: string;
  platform: Platform;
  platformLabel: string;
  title: string;
  botUsername: string;
  defaultChat: ChatRef | null;
  status: { ok?: boolean; error?: string; checkedAt?: string };
  sources: SocialSource[];
}

async function call<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    cache: 'no-store',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = String((await res.json())?.detail || ''); } catch { /* не JSON */ }
    throw new Error(detail || 'Не удалось — проверьте связь');
  }
  return (await res.json()) as T;
}

export const replyToClient = (itemId: string, text: string) =>
  call<{ ok: boolean; answers: SocialAnswer[] }>(`/api/social/items/${encodeURIComponent(itemId)}/reply`, 'POST', { text });

export function listItems(filter: { status?: 'new' | 'answered' | ''; q?: string }) {
  const qs = new URLSearchParams();
  if (filter.status) qs.set('status', filter.status);
  if (filter.q?.trim()) qs.set('q', filter.q.trim());
  return call<{ items: SocialItem[]; counts: { new: number; answered: number } }>(`/api/social/items?${qs}`);
}

export const listAccounts = () => call<{ accounts: SocialAccount[] }>('/api/social/accounts');
export const addAccount = (platform: Platform, token: string, title: string) =>
  call<{ account: SocialAccount }>('/api/social/accounts', 'POST', { platform, token, title });
export const checkAccount = (id: string) => call<{ account: SocialAccount }>(`/api/social/accounts/${id}/check`, 'POST', {});
export const removeAccount = (id: string) => call<{ ok: boolean }>(`/api/social/accounts/${id}`, 'DELETE');
export const setDefaultChat = (id: string, chatId: string | null) =>
  call<{ account: SocialAccount }>(`/api/social/accounts/${id}`, 'PATCH', { defaultChatId: chatId });
export const routeSource = (id: string, extChatId: string, chatId: string | null) =>
  call<{ account: SocialAccount }>(`/api/social/accounts/${id}/sources/${encodeURIComponent(extChatId)}`, 'PUT', { chatId });

/** Диалог с клиентом: все площадки в одном списке, у каждого диалога — своя. */
export interface SocialDialog {
  id: string;
  accountId: string;
  platform: Platform;
  platformLabel: string;
  account: string;
  kind: SourceType;
  title: string;
  clientName: string;
  clientUsername: string;
  sourceTitle: string;
  context: string;
  link: string | null;
  chatId: string | null;
  lastText: string;
  lastDir: 'in' | 'out';
  lastAt: string | null;
  waiting: boolean;
}

export interface DialogMessage {
  id: string;
  direction: 'in' | 'out';
  text: string;
  media: string[];
  link: string | null;
  context: string;
  authorName: string;
  authorUserId: string | null;
  at: string | null;
}

/** mode: «Диалоги» — личные и беседы, «Комментарии» — комментарии к постам (две вкладки раздела). */
export function listDialogs(mode: 'dialogs' | 'comments', filter: { waiting?: boolean; platform?: Platform | ''; q?: string }) {
  const qs = new URLSearchParams({ kind: mode });
  if (filter.waiting) qs.set('filter', 'waiting');
  if (filter.platform) qs.set('platform', filter.platform);
  if (filter.q?.trim()) qs.set('q', filter.q.trim());
  return call<{ dialogs: SocialDialog[]; waiting: { dialogs: number; comments: number } }>(`/api/social/dialogs?${qs}`);
}

export const loadDialog = (id: string) =>
  call<{ dialog: SocialDialog; messages: DialogMessage[]; canReply: boolean }>(`/api/social/dialogs/${encodeURIComponent(id)}`);

/** Вложение ответа — файл, уже загруженный в Шар (/api/upload). */
export interface OutFile { url: string; name: string; type: string }

export const sendToDialog = (id: string, text: string, attachments: OutFile[] = []) =>
  call<{ ok: boolean }>(`/api/social/dialogs/${encodeURIComponent(id)}/messages`, 'POST', { text, attachments });

/** Уведомления модуля: кому (отдельно для вкладок) и куда. «Выбранные» — только из тех, у кого есть доступ. */
export interface NotifyRule { to: 'all' | 'selected'; users: string[] }
export interface NotifySettings { dialogs: NotifyRule; comments: NotifyRule; desktop: boolean; push: boolean }
export interface NotifyPerson { id: string; name: string; admin: boolean }

export const loadNotify = () => call<{ settings: NotifySettings; people: NotifyPerson[] }>('/api/social/notify');
export const saveNotify = (settings: NotifySettings) => call<{ settings: NotifySettings }>('/api/social/notify', 'PUT', settings);
