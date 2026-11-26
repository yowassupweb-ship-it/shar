import { create } from 'zustand';
import { realtime } from '@/shared/realtime/realtime';

/**
 * Число на кнопке «Задачи»: новые поручения + непрочитанные комментарии (комментарий к задаче — как сообщение).
 * Считает сервер (GET /api/todos/badge, todos/seen.py); перечитываем, когда пришёл комментарий или задача,
 * когда задачу открыли здесь или на другом устройстве (tasks_badge) и после переподключения сокета.
 */
export const useTasksBadge = create<{ count: number }>(() => ({ count: 0 }));

let timer = 0;

async function refresh(): Promise<void> {
  try {
    const res = await fetch('/api/todos/badge', { cache: 'no-store' });
    if (!res.ok) return;
    const count = Number((await res.json())?.count) || 0;
    if (useTasksBadge.getState().count !== count) useTasksBadge.setState({ count });
  } catch { /* нет связи — останется прежнее */ }
}

/** Пересчитать чуть позже (несколько событий подряд — один запрос). */
export function refreshTasksBadge(wait = 400): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void refresh(), wait);
}

const EVENTS = new Set(['task_comments', 'task_created', 'task_updated', 'task_deleted', 'tasks_badge', 'resync', 'tasks_resync']);

/** Запустить счётчик (на всё время входа). Возвращает остановку. */
export function startTasksBadge(): () => void {
  void refresh();
  const off = realtime.subscribe((event) => {
    if (EVENTS.has(String((event as { type?: string }).type || ''))) refreshTasksBadge();
  });
  return () => {
    off();
    window.clearTimeout(timer);
    useTasksBadge.setState({ count: 0 });
  };
}
