/**
 * Плавающее окно чата (как в старом Шаре): переписка поверх любого раздела. Включается в Настройки → Внешний вид,
 * по умолчанию выключено. Настройка этого устройства — хранится в браузере.
 */

const KEY = 'nx:chat-frame';
const EVENT = 'nx:chat-frame-changed';

export function chatFrameEnabled(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

export function setChatFrameEnabled(on: boolean) {
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* приватное окно — до перезагрузки */ }
  window.dispatchEvent(new Event(EVENT));
}

export function subscribeChatFrame(fn: () => void): () => void {
  const onStorage = (e: StorageEvent) => { if (e.key === KEY) fn(); };
  window.addEventListener(EVENT, fn);
  window.addEventListener('storage', onStorage);
  return () => { window.removeEventListener(EVENT, fn); window.removeEventListener('storage', onStorage); };
}

/** Состояние окна: где стоит, раскрыто ли, какой чат открыт. */
export interface FrameState { x: number; y: number; open: boolean; chatId: string | null; /** Размер раскрытого окна, поставленный вручную. */ w?: number; h?: number }
const STATE_KEY = 'nx:chat-frame-state';

export function readFrameState(): FrameState | null {
  try {
    const raw = JSON.parse(localStorage.getItem(STATE_KEY) || 'null') as Partial<FrameState> | null;
    if (!raw || typeof raw.x !== 'number' || typeof raw.y !== 'number') return null;
    const size = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
    return { x: raw.x, y: raw.y, open: Boolean(raw.open), chatId: typeof raw.chatId === 'string' ? raw.chatId : null, w: size(raw.w), h: size(raw.h) };
  } catch { return null; }
}

export function writeFrameState(state: FrameState) {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch { /* не запомним — не страшно */ }
}
