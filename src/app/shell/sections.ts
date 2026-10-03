import { paths } from '@/shared/navigation/routes';

/**
 * Разделы шара — один список на всё приложение. Нижнее меню (телефон) и
 * нижняя полоса (десктоп) строятся из него, поэтому новый раздел добавляется
 * здесь (и маршрутом в app/routes.tsx), а не в каждой раскладке отдельно.
 */

export type SectionId = 'chats' | 'tasks' | 'calendar' | 'contacts' | 'files' | 'mail' | 'more';

export interface Section {
  id: SectionId;
  label: string;
  href: string;
  /** Иконка из public/icons/nav-v2 — цветная, одна на обе темы. */
  icon: string;
}

export const SECTIONS: Section[] = [
  { id: 'chats', label: 'Чаты', href: paths.chats, icon: 'chats' },
  { id: 'tasks', label: 'Задачи', href: paths.tasks, icon: 'todo' },
  { id: 'calendar', label: 'Календарь', href: paths.calendar, icon: 'calendar' },
  { id: 'contacts', label: 'Контакты', href: paths.contacts, icon: 'contacts' },
  { id: 'files', label: 'Файлы', href: paths.files, icon: 'files' },
  { id: 'mail', label: 'Почта', href: paths.mail, icon: 'mail' },
  { id: 'more', label: 'Ещё', href: paths.more, icon: 'menu' },
];

/** Страницы вне меню и раздел, пункт которого они подсвечивают. */
const NESTED: Record<string, SectionId> = {
  [paths.settings]: 'more', [paths.admin]: 'more', [paths.utm]: 'more', [paths.guide]: 'more',
};

export function sectionFor(pathname: string | null): Section {
  const nested = pathname ? NESTED[pathname] : undefined;
  return SECTIONS.find((s) => s.href === pathname || s.id === nested) || SECTIONS[0];
}
