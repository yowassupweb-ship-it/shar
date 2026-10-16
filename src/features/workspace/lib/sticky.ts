import type { DragEvent } from 'react';

/** Заметки на рабочем столе — только в приложении для компьютера (desktop/electron/sticky-notes.cjs); в браузере этих кнопок нет. */
export const stickyBridge = () => (typeof window === 'undefined' ? null : window.sharDesktop?.sticky ?? null);

export const canSticky = (kind: string) => kind === 'note' && stickyBridge() !== null;

/** Заметка в отдельном окне на рабочем столе. `point` — куда поставить (экранные координаты), иначе каскадом. */
export function openSticky(noteId: string, point?: { x: number; y: number }) {
  return stickyBridge()?.open(String(noteId), point);
}

/** Заметку удалили — окно на столе больше не нужно. */
export function forgetSticky(noteId: string) {
  void stickyBridge()?.forget(String(noteId));
}

/**
 * Заметку вытащили за пределы окна Шара и отпустили — она становится окном на рабочем столе в точке отпускания.
 * Внутри окна перетаскивание работает как раньше (в чат, в документ и т. п.).
 */
export function dragNoteOut(event: DragEvent, noteId: string) {
  if (!stickyBridge()) return;
  const outside = event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight;
  if (!outside || event.dataTransfer.dropEffect !== 'none') return;
  void openSticky(noteId, { x: event.screenX, y: event.screenY });
}
