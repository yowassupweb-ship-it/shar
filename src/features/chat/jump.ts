/**
 * «Открыть чат и прокрутить к сообщению» из мест вне самого чата (поиск, закладки).
 * Просьба ждёт, пока нужный чат откроется: Conversation забирает её при появлении и по событию.
 */
let pending: { chatId: string; messageId: string } | null = null;

export function requestJump(chatId: string, messageId: string) {
  pending = { chatId, messageId };
  window.dispatchEvent(new CustomEvent('nx:jump-message', { detail: pending }));
}

/** Забрать отложенную просьбу для этого чата (один раз). */
export function takeJump(chatId: string): string | null {
  if (!pending || pending.chatId !== chatId) return null;
  const id = pending.messageId;
  pending = null;
  return id;
}
