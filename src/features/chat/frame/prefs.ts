/**
 * Быстрый чат — окно с перепиской поверх любого раздела. Открывается правым щелчком по «Чатам» в нижней полосе, пока
 * человек в другом разделе (и по нему же закрывается). Постоянной кнопки на экране нет. Открыто ли окно — состояние
 * сессии; где оно стоит, какого размера и какой чат в нём открыт — помнится на этом устройстве.
 */

let opened = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

export function chatFrameOpen(): boolean { return opened; }

export function setChatFrameOpen(on: boolean) {
  if (opened === on) return;
  opened = on;
  emit();
}

export function toggleChatFrame() { setChatFrameOpen(!opened); }

export function subscribeChatFrame(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Состояние окна: где стоит, какого размера, какой чат открыт. */
export interface FrameState { x: number; y: number; chatId: string | null; /** Размер окна, поставленный вручную. */ w?: number; h?: number }
const STATE_KEY = 'nx:chat-frame-state';

export function readFrameState(): FrameState | null {
  try {
    const raw = JSON.parse(localStorage.getItem(STATE_KEY) || 'null') as Partial<FrameState> | null;
    if (!raw || typeof raw.x !== 'number' || typeof raw.y !== 'number') return null;
    const size = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
    return { x: raw.x, y: raw.y, chatId: typeof raw.chatId === 'string' ? raw.chatId : null, w: size(raw.w), h: size(raw.h) };
  } catch { return null; }
}

export function writeFrameState(state: FrameState) {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch { /* не запомним — не страшно */ }
}
