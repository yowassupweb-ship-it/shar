import { FileText, Globe, Hash, MessagesSquare, Search, Settings, Shield, type LucideIcon } from 'lucide-react';
import { CoreIcon } from '@/shared/ui/CoreIcon';
import { paths } from '@/shared/navigation/routes';

/**
 * Инструменты раздела «Ещё» — только те, что переписаны в v2 (остальные
 * инструменты старого фронта сюда не переносятся). Права — как раньше:
 *  - админ видит всё;
 *  - adminOnly — только админ;
 *  - standard — всем;
 *  - остальное — тем, кому выдан (user.enabledTools).
 */

export interface Tool {
  id: string;
  name: string;
  /** Одна строка о том, зачем инструмент, — для поиска и подсказки. */
  hint: string;
  href: string;
  icon: LucideIcon;
  /** Два цвета плашки — как у иконок приложений macOS. */
  tint: [string, string];
  external?: boolean;
  standard?: boolean;
  adminOnly?: boolean;
}

export const TOOLS: Tool[] = [
  // Открывает окно поиска (Ctrl+K), а не страницу: на телефоне это единственный вход в него.
  { id: 'spotlight', name: 'Поиск', hint: 'Поиск по всему Шару: чаты, люди, файлы, история', href: '#search', icon: Search, tint: ['#7dd3fc', '#2563eb'], standard: true },
  { id: 'utm-generator', name: 'Генератор UTM', hint: 'Ссылки с метками для рекламы', href: paths.utm, icon: Hash, tint: ['#e879f9', '#db2777'] },
  { id: 'site-leads', name: 'Заявки', hint: 'Заявки с corp и school.vs-travel.ru: кто взял, что закрыто', href: paths.leads, icon: Globe, tint: ['#5eead4', '#0f766e'] },
  { id: 'social', name: 'Соцсети', hint: 'Сообщения и комментарии из ВКонтакте и MAX — ответ из Шара', href: paths.social, icon: MessagesSquare, tint: ['#7dd3fc', '#0284c7'] },
  // Чат с агентами. Не стандартный и не только для админа: админ видит сразу, остальным выдаёт админ (enabledTools).
  { id: 'core', name: 'Ядро', hint: 'Чат с агентами Шара: задачи, документы, ответы с ходом работы', href: paths.core, icon: CoreIcon, tint: ['#a78bfa', '#4f46e5'] },
  { id: 'how-to-shar', name: 'Инструкция', hint: 'Как работать в Шаре', href: paths.guide, icon: FileText, tint: ['#a3e635', '#059669'], standard: true },
  { id: 'admin', name: 'Админка', hint: 'Пользователи, права, система', href: paths.admin, icon: Shield, tint: ['#fbbf24', '#ea580c'], adminOnly: true },
  { id: 'settings', name: 'Настройки', hint: 'Профиль, уведомления, внешний вид', href: paths.settings, icon: Settings, tint: ['#9ca3af', '#475569'], standard: true },
];

/** Инструменты, доступ к которым выдаёт админ (не стандартные и не только для админа). */
export const GRANTABLE_TOOLS = TOOLS.filter((t) => !t.standard && !t.adminOnly);

export interface Account { role?: string; enabledTools?: string[]; pinnedTools?: string[] }

export function availableTools(user: Account | null): Tool[] {
  const admin = user?.role === 'admin';
  const granted = new Set(user?.enabledTools || []);
  return TOOLS.filter((t) => admin || (!t.adminOnly && (t.standard || granted.has(t.id))));
}
