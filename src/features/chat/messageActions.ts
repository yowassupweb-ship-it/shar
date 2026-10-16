import type { Message } from '@/shared/types/chat';
import { showToast } from '@/shared/ui/Toast';
import { isRetryableStatus } from './api';
import { writeDraft } from './drafts';
import { internals, loadChats, markMessageDeleted, setCompose, type Thread } from './store';
import { sendMessage } from './transport';

/**
 * Действия с одним сообщением: реакция, голос в опросе, «прослушано», правка,
 * удаление. Экран меняется сразу; сервер рассылает итог остальным по сокету.
 * Если сервер отказал — возвращаем как было и говорим, что случилось.
 */

const { get, patchThread } = internals;

type Meta = NonNullable<Message['metadata']>;
const myId = () => String(get().me?.id ?? '');

function findMsg(chatId: string, id: string) {
  return get().threads[chatId]?.byId[id];
}

function patchMsg(chatId: string, id: string, fn: (m: Message) => Message) {
  patchThread(chatId, (t: Thread) => {
    const m = t.byId[id];
    return m ? { ...t, byId: { ...t.byId, [id]: { ...m, ...fn(m) } } } : t;
  });
}

const setMeta = (chatId: string, id: string, patch: Partial<Meta>) =>
  patchMsg(chatId, id, (m) => ({ ...m, metadata: { ...(m.metadata || {}), ...patch } }));

async function patchRequest(chatId: string, id: string, body: Record<string, unknown>) {
  return fetch(`/api/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function normalizeReactions(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string[]> = {};
  for (const [emoji, ids] of Object.entries(raw as Record<string, unknown>)) {
    const list = Array.from(new Set(Array.isArray(ids) ? ids.map(String).filter(Boolean) : []));
    if (list.length) out[emoji] = list;
  }
  return out;
}

/** Поставить или снять реакцию. На сервер уходит дельта «переключи мою»,
 *  поэтому одновременные реакции других не затираются. */
export async function toggleReaction(chatId: string, messageId: string, emoji: string) {
  const uid = myId();
  const msg = findMsg(chatId, messageId);
  if (!uid || !msg) return;
  const prev = normalizeReactions(msg.metadata?.reactions);
  const mine = (prev[emoji] || []).includes(uid);
  const next = { ...prev };
  const list = mine ? (prev[emoji] || []).filter((x) => x !== uid) : [...(prev[emoji] || []), uid];
  if (list.length) next[emoji] = list; else delete next[emoji];
  setMeta(chatId, messageId, { reactions: next });
  try {
    const res = await patchRequest(chatId, messageId, { metadata: { reactionToggle: { emoji } }, userId: uid });
    if (!res.ok) throw new Error(String(res.status));
    const updated = (await res.json()) as Message;
    if (updated?.metadata?.reactions) setMeta(chatId, messageId, { reactions: normalizeReactions(updated.metadata.reactions) });
    // Автору чужого сообщения — пуш о реакции (как в старом чате).
    if (!mine && String(msg.authorId) !== uid) {
      const me = get().me;
      fetch('/api/push/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipientIds: [String(msg.authorId)],
          title: `${me?.name || 'Кто-то'} отреагировал ${emoji}`,
          body: msg.content ? msg.content.slice(0, 60) : 'Сообщение',
          url: `/account?tab=messages&chat=${chatId}`,
          tag: `reaction-${messageId}`,
        }),
      }).catch(() => {});
    }
  } catch {
    setMeta(chatId, messageId, { reactions: prev });
    showToast('Реакция не сохранилась — нет связи с сервером', 'error');
  }
}

type Poll = { options?: { id: string; voters?: string[] }[]; multipleChoice?: boolean; allowRevote?: boolean };

export async function votePoll(chatId: string, messageId: string, optionId: string) {
  const uid = myId();
  const msg = findMsg(chatId, messageId);
  const poll = msg?.metadata?.poll as Poll | undefined;
  if (!uid || !msg || !poll) return;
  const votedAnywhere = (poll.options || []).some((o) => (o.voters || []).includes(uid));
  if (!poll.allowRevote && votedAnywhere) return;
  const votedHere = (poll.options || []).some((o) => o.id === optionId && (o.voters || []).includes(uid));
  const next = {
    ...poll,
    options: (poll.options || []).map((o) => {
      const voters = o.voters || [];
      if (o.id === optionId) return { ...o, voters: votedHere ? voters.filter((v) => v !== uid) : [...voters, uid] };
      return poll.multipleChoice ? o : { ...o, voters: voters.filter((v) => v !== uid) };
    }),
  };
  setMeta(chatId, messageId, { poll: next });
  try {
    const res = await patchRequest(chatId, messageId, { metadata: { poll: next }, userId: uid });
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    setMeta(chatId, messageId, { poll: poll as Record<string, unknown> });
    showToast('Голос не учтён — нет связи с сервером', 'error');
  }
}

export function markVoiceListened(chatId: string, messageId: string) {
  const msg = findMsg(chatId, messageId);
  if (!msg || msg.metadata?.voiceListened) return;
  setMeta(chatId, messageId, { voiceListened: true });
  patchRequest(chatId, messageId, { metadata: { voiceListened: true }, userId: myId() }).catch(() => {});
}

/** Правка своего сообщения. Три попытки; не вышло — откат, текст — в черновик. */
export async function editMessage(chatId: string, messageId: string, content: string) {
  const msg = findMsg(chatId, messageId);
  const text = content.trim();
  if (!msg || !text || text === msg.content) { setCompose(chatId, {}); return; }
  const before = { content: msg.content, isEdited: msg.isEdited };
  patchMsg(chatId, messageId, (m) => ({ ...m, content: text, isEdited: true }));
  setCompose(chatId, {});
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await patchRequest(chatId, messageId, { content: text });
      if (res.ok) return;
      if (!isRetryableStatus(res.status)) break;
    } catch { /* сеть — ещё попытка */ }
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  patchMsg(chatId, messageId, (m) => ({ ...m, ...before }));
  writeDraft(chatId, text);
  showToast('Правка не сохранилась — текст вернули в поле ввода', 'error');
}

let chatsReloadTimer: number | null = null;
/** Список чатов после удаления: превью в нём остаётся прежним, пока его не перечитать.
 *  Другим участникам это делает событие message_deleted, самому удаляющему — только здесь.
 *  Пакетное удаление (несколько сообщений подряд) даёт один запрос. */
function reloadChatsAfterDelete() {
  if (chatsReloadTimer !== null) window.clearTimeout(chatsReloadTimer);
  chatsReloadTimer = window.setTimeout(() => { chatsReloadTimer = null; void loadChats(); }, 400);
}

/** Удаление: сначала анимация исчезновения (data-leaving), потом из ленты. */
export async function deleteMessage(chatId: string, messageId: string) {
  const uid = myId();
  try {
    const res = await fetch(
      `/api/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}?userId=${encodeURIComponent(uid)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      showToast(
        res.status === 403 ? 'Нет прав удалить это сообщение'
          : res.status === 404 ? 'Сообщение уже удалено'
            : isRetryableStatus(res.status) ? 'Не удалось удалить — нет связи с сервером. Попробуйте ещё раз'
              : `Не удалось удалить сообщение (${res.status})`,
        'error',
      );
      return;
    }
    markMessageDeleted(messageId, chatId);
    patchMsg(chatId, messageId, (m) => ({ ...m, _leaving: true } as Message));
    window.setTimeout(() => {
      patchThread(chatId, (t: Thread) => {
        if (!t.byId[messageId]) return t;
        const byId = { ...t.byId };
        delete byId[messageId];
        return { ...t, byId, ids: t.ids.filter((x) => x !== messageId) };
      });
    }, 220);
    reloadChatsAfterDelete();
  } catch {
    showToast('Не удалось удалить — нет связи с сервером. Попробуйте ещё раз', 'error');
  }
}

export async function copyMessageText(msg: Message) {
  try {
    await navigator.clipboard.writeText(msg.content || '');
    showToast('Скопировано', 'success');
  } catch {
    showToast('Не удалось скопировать', 'error');
  }
}

/** Закрепить или открепить сообщение в чате. */
export async function togglePin(chatId: string, messageId: string) {
  const msg = findMsg(chatId, messageId);
  const uid = myId();
  if (!msg || !uid) return;
  const was = Boolean(msg.metadata?.isPinned);
  setMeta(chatId, messageId, { isPinned: !was });
  try {
    const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: uid, isPinned: !was }),
    });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json().catch(() => ({}));
    const meta = data?.pinnedMessage?.metadata || {};
    setMeta(chatId, messageId, { isPinned: meta.isPinned ?? !was, pinnedBy: meta.pinnedBy, pinnedAt: meta.pinnedAt });
  } catch {
    setMeta(chatId, messageId, { isPinned: was });
    showToast(was ? 'Не открепилось — нет связи с сервером' : 'Не закрепилось — нет связи с сервером', 'error');
  }
}

/** Пересылка — строго по очереди, чтобы пачка пришла в исходном порядке. */
export async function forwardMessages(targetChatId: string, messages: Message[]): Promise<boolean> {
  const me = get().me;
  if (!me || !messages.length) return false;
  const sorted = [...messages].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  try {
    for (const m of sorted) {
      const md = (m.metadata || {}) as Record<string, unknown>;
      // Тем же путём, что и обычная отправка: кадр в сокет (chat_realtime),
      // без подтверждения — HTTP с тем же id, сервер не создаст копию.
      const created = await sendMessage(targetChatId, {
        id: crypto.randomUUID(),
        content: m.content || '',
        authorId: String(me.id),
        authorName: me.name || me.username || '',
        attachments: m.attachments || [],
        forwardedFrom: String(m.id),
        forwardedFromUserId: String(m.forwardedFromUserId || md.forwardedFromUserId || m.authorId || ''),
        forwardedFromUsername: String(m.forwardedFromUsername || md.forwardedFromUsername || md.fromUserName || m.authorName || ''),
      }) as Message | null;
      // Сервер не шлёт автору его же событие — дописываем ответ сами.
      if (created?.id) patchThread(targetChatId, (t: Thread) => (t.byId[String(created.id)] ? t : upsertOne(t, created)));
    }
    return true;
  } catch {
    showToast('Не всё переслалось — нет связи с сервером', 'error');
    return false;
  }
}

function upsertOne(t: Thread, m: Message): Thread {
  const id = String(m.id);
  const byId = { ...t.byId, [id]: { ...m, id, _key: id } };
  const ids = [...t.ids, id].sort((a, b) => new Date(byId[a].createdAt).getTime() - new Date(byId[b].createdAt).getTime());
  return { ...t, ids, byId };
}

/** Картинка в буфер. Браузер принимает только PNG — перекодируем через canvas. */
export async function copyImage(url: string) {
  try {
    const res = await fetch(url);
    let blob = await res.blob();
    if (blob.type !== 'image/png') {
      const bmp = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      canvas.getContext('2d')?.drawImage(bmp, 0, 0);
      bmp.close();
      blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('png'))), 'image/png'));
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    showToast('Картинка скопирована', 'success');
  } catch {
    showToast('Не удалось скопировать картинку', 'error');
  }
}

/** Копировать: выделенный фрагмент, если он есть, иначе весь текст. */
export async function copySelectionOr(msg: Message) {
  const selected = window.getSelection()?.toString().trim();
  try {
    await navigator.clipboard.writeText(selected || msg.content || '');
    showToast('Скопировано', 'success');
  } catch {
    showToast('Не удалось скопировать', 'error');
  }
}

export async function editPoll(chatId: string, messageId: string, question: string, options: string[], multipleChoice: boolean, isAnonymous: boolean, allowRevote: boolean) {
  const prev = findMsg(chatId, messageId)?.metadata?.poll;
  const poll = {
    question, multipleChoice, allowRevote, isAnonymous,
    options: options.map((text) => ({ id: Math.random().toString(36).slice(2, 11), text, voters: [] as string[] })),
  };
  setMeta(chatId, messageId, { poll });
  try {
    const res = await patchRequest(chatId, messageId, { metadata: { poll }, userId: myId() });
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    if (prev) setMeta(chatId, messageId, { poll: prev });
    showToast('Опрос не сохранился — нет связи с сервером', 'error');
  }
}
