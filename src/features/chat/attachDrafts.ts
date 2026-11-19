/**
 * Готовые, но ещё не отправленные вложения по чатам.
 *
 * Composer пересоздаётся при смене чата (key={chatId}), и файлы из его состояния пропадали.
 * Здесь они живут в памяти окна: ушли в другой чат и вернулись — вложения на месте.
 * Объекты File в localStorage не положить; после перезагрузки окна вложения не сохраняются.
 */

const drafts = new Map<string, File[]>();

export function readAttachDraft(chatId: string): File[] {
  return drafts.get(chatId) ?? [];
}

export function writeAttachDraft(chatId: string, files: File[]) {
  if (files.length) drafts.set(chatId, files);
  else drafts.delete(chatId);
}

/** Чаты, в которых лежат неотправленные вложения (для отметки в списке). */
export function chatsWithAttachDraft(): string[] {
  return Array.from(drafts.keys());
}
