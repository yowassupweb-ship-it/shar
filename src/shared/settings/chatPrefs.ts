import { myId } from '@/shared/session/session';
import { appearanceVars, normalizeAppearance, type ChatAppearance } from './chatAppearance';

/**
 * Настройки чата пользователя (`chatSettings`): хранятся в профиле на сервере
 * и копией в localStorage — тот же ключ, что у старого фронта.
 *
 * v2 использует размер шрифта (общие со старым фронтом поля) и своё
 * оформление в `v2` (фон, узор, пузыри — см. chatAppearance.ts). Поля
 * старого интерфейса (bubbleColor, chatBackground…) не читаем: там у многих
 * сохранены его значения по умолчанию, и v2 внезапно перекрасился бы.
 * Сохраняем всегда объект целиком, поэтому чужие поля не теряются.
 */

export interface ChatPrefs {
  fontSize: number;       // компьютер, px
  fontSizeMobile: number; // телефон, px
  v2?: Partial<ChatAppearance>;
  [legacy: string]: unknown;
}

export const FONT_LIMITS = {
  desktop: { min: 12, max: 20, fallback: 14 },
  mobile: { min: 11, max: 24, fallback: 17 },
} as const;

const KEY = 'chatSettings';

const clamp = (v: unknown, { min, max, fallback }: { min: number; max: number; fallback: number }) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

export function readChatPrefs(): ChatPrefs {
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { /* битый кэш */ }
  return {
    ...raw,
    fontSize: clamp(raw.fontSize, FONT_LIMITS.desktop),
    fontSizeMobile: clamp(raw.fontSizeMobile, FONT_LIMITS.mobile),
  };
}

const isDark = () => document.documentElement.classList.contains('dark');
let applied: string[] = [];
let watching = false;

/** Переменные, которые читают лента и пузыри (timeline.css, chat.css).
 *  Оформление своё у светлой и тёмной темы — при смене темы переприменяем. */
export function applyChatPrefs(p: ChatPrefs = readChatPrefs()) {
  const root = document.documentElement.style;
  root.setProperty('--chat-font-size-desktop', `${p.fontSize}px`);
  root.setProperty('--chat-font-size-mobile', `${p.fontSizeMobile}px`);
  const vars = appearanceVars(normalizeAppearance(p.v2), isDark() ? 'dark' : 'light');
  for (const k of applied) if (!(k in vars)) root.removeProperty(k);
  for (const [k, v] of Object.entries(vars)) root.setProperty(k, v);
  applied = Object.keys(vars);
  if (!watching) {
    watching = true;
    new MutationObserver(() => applyChatPrefs()).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
  }
}

export function readAppearance(): ChatAppearance {
  return normalizeAppearance(readChatPrefs().v2);
}

export function saveAppearance(next: ChatAppearance): ChatAppearance {
  saveChatPrefs({ v2: next });
  return next;
}

let saveTimer: number | null = null;

/** Применить сразу, на сервер — с задержкой (ползунок шлёт десятки изменений). */
export function saveChatPrefs(patch: Partial<ChatPrefs>): ChatPrefs {
  const next = { ...readChatPrefs(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* без кэша */ }
  applyChatPrefs(next);
  window.dispatchEvent(new CustomEvent('chatSettingsChanged', { detail: next }));
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    const id = myId();
    if (!id) return;
    void fetch(`/api/users/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatSettings: next }),
    }).catch(() => { /* останется локально, уйдёт со следующим изменением */ });
  }, 800);
  return next;
}

/** Настройки из профиля (другое устройство могло их поменять). Локальные правки поверх. */
export function adoptServerChatPrefs(server: unknown) {
  if (!server || typeof server !== 'object') return;
  let local: Record<string, unknown> = {};
  try { local = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { /* битый кэш */ }
  const merged = { ...(server as Record<string, unknown>), ...local };
  try { localStorage.setItem(KEY, JSON.stringify(merged)); } catch { /* без кэша */ }
  applyChatPrefs(readChatPrefs());
}
