// Модель пользователя системы

export type UserRole = 'admin' | 'user';

export interface User {
  id: string;
  
  // Основные данные
  username: string;           // Логин
  name: string;               // ФИО
  email: string;              // Рабочая почта (для связи)
  password?: string;          // Пароль (не возвращается клиенту)
  
  // Telegram
  telegramId?: string;        // Telegram ID (для авторизации и уведомлений)
  telegramUsername?: string;  // @username в Telegram
  
  // Организация (справочные поля для фильтрации)
  department?: string;        // Отдел (ID из справочника)
  position?: string;          // Должность (ID из справочника)
  workSchedule?: string;      // График работы (например: "Пн-Пт 9:00-18:00")
  phone?: string;             // Рабочий телефон
  
  // Роли и права
  role: UserRole;             // Системная роль: admin или user
  
  canSeeAllTasks?: boolean;   // Суперадмин - видит ВСЕ задачи (включая чужие приватные)
  
  // Доступные инструменты
  enabledTools: string[];     // Список ID доступных инструментов
  
  // Метаданные
  createdAt: string;
  updatedAt?: string;
  lastLoginAt?: string;
  isOnline?: boolean;
  
  // Аватар
  avatar?: string;
}

// Справочник отделов
export interface Department {
  id: string;
  name: string;
  color?: string;
  order: number;
  parentId?: string | null;   // set → this is a sub-department nested under that parent
}

// Справочник должностей
export interface Position {
  id: string;
  name: string;
  departmentId?: string;      // Привязка к отделу (опционально)
  order: number;
}

// Справочники по умолчанию
export const DEFAULT_DEPARTMENTS: Department[] = [
  { id: 'marketing', name: 'Маркетинг', color: '#3b82f6', order: 0 },
  { id: 'sales', name: 'Продажи', color: '#10b981', order: 1 },
  { id: 'development', name: 'Разработка', color: '#8b5cf6', order: 2 },
  { id: 'support', name: 'Поддержка', color: '#f59e0b', order: 3 },
  { id: 'hr', name: 'HR', color: '#ec4899', order: 4 },
  { id: 'finance', name: 'Финансы', color: '#14b8a6', order: 5 },
  { id: 'management', name: 'Руководство', color: '#f43f5e', order: 6 },
];

export const DEFAULT_POSITIONS: Position[] = [
  { id: 'director', name: 'Директор', order: 0 },
  { id: 'manager', name: 'Менеджер', order: 1 },
  { id: 'lead', name: 'Руководитель направления', order: 2 },
  { id: 'specialist', name: 'Специалист', order: 3 },
  { id: 'junior', name: 'Младший специалист', order: 4 },
  { id: 'intern', name: 'Стажер', order: 5 },
];

// Проверка права видеть задачу
export function canSeeTask(
  viewer: User,
  task: { 
    assignedById?: string; 
    assignedToId?: string; 
    listId: string;
  },
  allowedListIds: Set<string>
): boolean {
  // Суперадмин видит всё
  if (viewer.canSeeAllTasks) return true;
  
  // Задача в доступном списке
  if (allowedListIds.has(task.listId)) return true;
  
  // Viewer - исполнитель задачи
  if (task.assignedToId === viewer.id) return true;
  
  // Viewer - автор задачи
  if (task.assignedById === viewer.id) return true;
  
  return false;
}

// Проверка права видеть событие
export function canSeeEvent(
  viewer: User,
  event: {
    createdBy?: string;
    participants?: string[];
  }
): boolean {
  // Суперадмин видит всё
  if (viewer.canSeeAllTasks) return true;
  
  // Viewer - создатель
  if (event.createdBy === viewer.id) return true;
  
  // Viewer - участник
  if (event.participants?.includes(viewer.id)) return true;
  
  // Публичное событие (без участников)
  if (!event.participants || event.participants.length === 0) return true;
  
  return false;
}
