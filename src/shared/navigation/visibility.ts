/**
 * Какие разделы пользователь показывает в меню — `visibleTabs` в профиле
 * (ключи общие со старым фронтом). По умолчанию видно всё, кроме почты:
 * её включают явно. «Чаты» и «Ещё» не скрываются.
 */
export type TabKey = 'tasks' | 'calendar' | 'contacts' | 'files' | 'mail';

export function isTabVisible(tabs: Record<string, boolean> | undefined, key: string): boolean {
  if (key === 'chats' || key === 'more') return true;
  return key === 'mail' ? Boolean(tabs?.mail) : tabs?.[key] !== false;
}
