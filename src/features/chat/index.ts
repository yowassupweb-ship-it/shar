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
  isNotifications,
} from './store';
export type { ChatRow } from './store';
