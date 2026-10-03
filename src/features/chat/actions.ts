import type { Chat } from '@/shared/types/chat';
import { internals, isArchived, isMuted, isPinned, loadChats, openChat } from './store';

/**
 * Действия над чатами из списка: закрепить, архив, удалить, звук, создать.
 * Каждое сначала меняет состояние на экране, потом идёт на сервер; при отказе
 * сервера состояние возвращается, а список перечитывается.
 */

const { get, set, patchChat, lsSet } = internals;

const myId = () => String(get().me?.id ?? '');

async function post(url: string, body: unknown, method = 'POST'): Promise<Response> {
  return fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function saveLocalPins(pins: string[]) {
  set({ localPins: pins });
  lsSet('shar_pinned_chats', pins);
}

export async function togglePin(chatId: string) {
  const uid = myId();
  const chat = get().chats[chatId];
  if (!uid || !chat) return;
  const was = isPinned(chat, uid, get().localPins);
  const apply = (pinned: boolean) => {
    const pins = get().localPins.filter((id) => id !== chatId);
    saveLocalPins(pinned ? [...pins, chatId] : pins);
    patchChat(chatId, (c) => ({ ...c, pinnedByUser: { ...(c.pinnedByUser || {}), [uid]: pinned } }));
  };
  apply(!was);
  try {
    const res = await post(`/api/chats/${encodeURIComponent(chatId)}/pin`, { userId: uid, isPinned: !was });
    if (!res.ok) throw new Error(String(res.status));
    void loadChats();
  } catch {
    apply(was);
  }
}

export async function setArchived(chatId: string, archived: boolean) {
  const uid = myId();
  const chat = get().chats[chatId];
  if (!uid || !chat) return;
  const was = isArchived(chat, uid);
  const apply = (value: boolean) => patchChat(chatId, (c) => ({
    ...c,
    isArchivedForUser: value,
    archivedByUser: { ...(c.archivedByUser || {}), [uid]: value },
  }));
  apply(archived);
  // Архивировали открытый чат из активного списка — закрываем его.
  if (archived && get().activeChatId === chatId && !get().archiveView) openChat(null);
  try {
    const res = await post(`/api/chats/${encodeURIComponent(chatId)}/archive`, { userId: uid, isArchived: archived });
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    apply(was);
  } finally {
    void loadChats();
  }
}

export async function deleteChat(chatId: string) {
  const prev = get().chats[chatId];
  if (!prev) return;
  if (get().activeChatId === chatId) openChat(null);
  set((s) => {
    const chats = { ...s.chats };
    delete chats[chatId];
    return { chats };
  });
  try {
    const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    set((s) => ({ chats: { ...s.chats, [chatId]: prev } }));
  } finally {
    void loadChats();
  }
}

export async function toggleMute(chatId: string) {
  const uid = myId();
  const chat = get().chats[chatId];
  if (!uid || !chat) return;
  const next = !isMuted(chat, uid);
  patchChat(chatId, (c) => ({ ...c, mutedByUser: { ...(c.mutedByUser || {}), [uid]: next } }));
  // Локальная отметка — запасной источник, если сервер не ответит.
  try { localStorage.setItem(`chat_muted:${chatId}:${uid}`, String(next)); } catch { /* ignore */ }
  // Сервис-воркер не показывает системные уведомления заглушённого чата.
  navigator.serviceWorker?.ready
    .then((reg) => reg.active?.postMessage({ type: 'mute-chat', userId: uid, chatId, muted: next }))
    .catch(() => {});
  try {
    const res = await post(`/api/chats/${encodeURIComponent(chatId)}/mute`, { userId: uid, muted: next });
    if (res.ok) {
      const data = await res.json();
      if (data?.mutedByUser) patchChat(chatId, (c) => ({ ...c, mutedByUser: data.mutedByUser }));
    }
  } catch { /* сеть — оставляем локальное состояние */ }
}

export function setArchiveView(on: boolean) {
  set({ archiveView: on });
}

let creating = false;

/** Новый личный или групповой чат. Возвращает id созданного (или найденного) чата. */
export async function createChat(userIds: string[], group?: { title: string }): Promise<string | null> {
  const uid = myId();
  if (!uid || !userIds.length || creating) return null;
  creating = true;
  try {
    const participantIds = Array.from(new Set([...userIds, uid]));
    const res = await post('/api/chats', {
      participantIds,
      title: group ? group.title.trim() || undefined : undefined,
      isGroup: Boolean(group),
      creatorId: group ? uid : undefined,
    });
    if (!res.ok) return null;
    const chat = (await res.json()) as Chat;
    await loadChats();
    return String(chat.id);
  } catch {
    return null;
  } finally {
    creating = false;
  }
}

export interface Department { id: string; name: string; color?: string }

/** Отделы, которые принимают заявки (настраивается в админке). */
export async function loadRequestDepartments(): Promise<Department[]> {
  const [cfgRes, deptRes] = await Promise.all([fetch('/api/request-departments'), fetch('/api/departments')]);
  const cfg = await cfgRes.json().catch(() => ({}));
  const dj = await deptRes.json().catch(() => ({}));
  const allowed: string[] = Array.isArray(cfg?.departmentIds) ? cfg.departmentIds.map(String) : [];
  const all: Department[] = Array.isArray(dj?.departments) ? dj.departments : [];
  return all.filter((d) => allowed.includes(String(d.id)));
}

/** Заявка в отдел: создаётся чат со всеми сотрудниками отдела. */
export async function createRequest(departmentId: string): Promise<string | null> {
  const uid = myId();
  if (!uid) return null;
  try {
    const res = await post('/api/requests', { creatorId: uid, departmentId });
    if (!res.ok) return null;
    const data = await res.json();
    const chatId = data?.chat?.id ? String(data.chat.id) : null;
    if (chatId) await loadChats();
    return chatId;
  } catch {
    return null;
  }
}
