import { useSyncExternalStore } from 'react';
import { QUICK_REACTIONS } from '@/shared/emoji/emojiData';
import { myId } from '@/shared/session/session';

/**
 * Закреплённые реакции — те, что стоят в быстром ряду меню сообщения. По умолчанию — общий набор Шара без 😊;
 * человек собирает свой в панели настройки (кнопка «+» в ряду → «Настроить»). Хранится на устройстве, по человеку.
 */

export const MAX_PINNED = 8;
export const DEFAULT_PINNED = QUICK_REACTIONS.filter((e) => e !== '😊');

const key = () => `nx:pinned-reactions:${myId() || 'anon'}`;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

// useSyncExternalStore требует одинаковый объект между вызовами, пока данные не менялись: держим снимок строкой.
let cache: { raw: string | null; list: string[] } | null = null;

function read(): string[] {
  let raw: string | null = null;
  try { raw = localStorage.getItem(key()); } catch { /* нет хранилища — набор по умолчанию */ }
  if (cache && cache.raw === raw) return cache.list;
  let list = DEFAULT_PINNED;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed.filter((e): e is string => typeof e === 'string' && e.length > 0).slice(0, MAX_PINNED);
    } catch { /* битая запись — по умолчанию */ }
  }
  cache = { raw, list };
  return list;
}

export function setPinnedReactions(list: string[]) {
  const next = [...new Set(list)].slice(0, MAX_PINNED);
  try { localStorage.setItem(key(), JSON.stringify(next)); } catch { /* не запомним — на сессию хватит */ }
  cache = null;
  emit();
}

export const resetPinnedReactions = () => {
  try { localStorage.removeItem(key()); } catch { /* ignore */ }
  cache = null;
  emit();
};

export function usePinnedReactions(): string[] {
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, read, () => DEFAULT_PINNED);
}
