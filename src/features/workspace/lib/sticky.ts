import type { DragEvent } from 'react';

/** Материалы в отдельных окнах (заметки на рабочем столе, документ и таблица) — только в приложении для компьютера (desktop/electron/sticky-notes.cjs); в браузере этих кнопок нет. */
export const stickyBridge = () => (typeof window === 'undefined' ? null : window.sharDesktop?.sticky ?? null);

export const canSticky = (kind: string) => (kind === 'note' || kind === 'document' || kind === 'table') && stickyBridge() !== null;

/** Подпись пункта меню: заметка живёт «на рабочем столе», документ и таблица — в отдельном окне. */
export const stickyLabel = (kind: string) => (kind === 'note' ? 'На рабочий стол' : 'В отдельном окне');

/** Материал в отдельном окне. `point` — куда поставить (экранные координаты), иначе каскадом; opts — вид и размер окна. */
export function openSticky(noteId: string, point?: { x: number; y: number } | null, opts?: { kind?: string; width?: number; height?: number }) {
  return stickyBridge()?.open(String(noteId), point ?? null, opts ?? null);
}

/** Заметку удалили — окно на столе больше не нужно. */
export function forgetSticky(noteId: string) {
  void stickyBridge()?.forget(String(noteId));
}

/**
 * Заметку вытащили за пределы окна Шара и отпустили — она становится окном на рабочем столе в точке отпускания.
 * Внутри окна перетаскивание работает как раньше (в чат, в документ и т. п.).
 */
export function dragNoteOut(event: DragEvent, noteId: string, kind = 'note') {
  if (!stickyBridge()) return;
  const outside = event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight;
  if (!outside || event.dataTransfer.dropEffect !== 'none') return;
  void openSticky(noteId, { x: event.screenX, y: event.screenY }, { kind });
}
