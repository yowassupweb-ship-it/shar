/**
 * Публичный API фичи «Чаты» для остального приложения.
 *
 * Стор чатов заодно держит справочник людей (users) и текущего пользователя —
 * им пользуются задачи, календарь, файлы, почта. Другие фичи импортируют
 * только отсюда, не из внутренних файлов chat/.
 */
export {
  boot,
  shutdown,
  useChatStore,
  unreadChatsTotal,
  displayName,
  chatTitle,
  isFavorites,
  isMuted,
  isNotifications,
  isGroupChat,
  otherParticipant,
  lastActivity,
} from './store';
export { requestJump } from './jump';
export { sendText, openDocument } from './store';
export { createChat } from './actions';
export type { ChatRow } from './store';
export { default as ChatFrame } from './frame/ChatFrame';
export { chatFrameEnabled, setChatFrameEnabled, subscribeChatFrame } from './frame/prefs';
