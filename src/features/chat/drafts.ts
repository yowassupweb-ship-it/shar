import { useSyncExternalStore } from 'react';

/**
 * Черновики сообщений по чатам. Ключ `draft_<chatId>` — тот же, что у старого
 * интерфейса: начатое там сообщение видно здесь и наоборот.
 */

const key = (chatId: string) => `draft_${chatId}`;
const EVENT = 'shar-draft-changed';

export function readDraft(chatId: string): string {
  try { return localStorage.getItem(key(chatId)) || ''; } catch { return ''; }
}

export function writeDraft(chatId: string, text: string) {
  try {
    if (text.trim()) localStorage.setItem(key(chatId), text);
    else localStorage.removeItem(key(chatId));
  } catch { /* хранилище недоступно — черновик проживёт до перезагрузки в поле */ }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: chatId }));
}

function subscribe(onChange: () => void) {
  const onStorage = (e: StorageEvent) => { if (!e.key || e.key.startsWith('draft_')) onChange(); };
  window.addEventListener(EVENT, onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener('storage', onStorage);
  };
}

export function useDraft(chatId: string): string {
  return useSyncExternalStore(subscribe, () => readDraft(chatId), () => '');
}
