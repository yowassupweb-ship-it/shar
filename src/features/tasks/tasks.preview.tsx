import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { useChatStore } from '@/features/chat';
import { myId, useTasks, type Task } from './api';
import TasksScreen from './TasksScreen';

/**
 * Проверка экрана задач вне приложения (в окне с Vite, без сервера): общая папка «Корп сайт» с цепочкой из четырёх
 * этапов (первый закрыт) и задача «себе». `await (await import('/src/features/tasks/tasks.preview.tsx')).mountTasks()`.
 */
let root: Root | null = null;
let host: HTMLDivElement | null = null;

export function unmountTasks(): void { root?.unmount(); root = null; host?.remove(); host = null; }

export function mountTasks(): string {
  unmountTasks();
  const me = myId() || 'u-me';
  const now = new Date().toISOString();
  const users = { [me]: { id: me, name: 'Антон', username: 'anton' }, u2: { id: 'u2', name: 'Роман', username: 'roma' }, u3: { id: 'u3', name: 'Татьяна', username: 'tanya' } };
  useChatStore.setState((s) => ({ users: { ...s.users, ...users } } as never));
  const chain = (order: number) => ({ id: 'chain-demo', order: order * 1024, name: 'Корп сайт — публикация' });
  const task = (id: string, title: string, extra: Partial<Task>): Task => ({
    id, title, status: 'pending', priority: 'medium', authorId: me, assignedById: me, assignedToId: me, assignedToIds: [me], listId: 'L1',
    createdAt: now, updatedAt: now, metadata: { md: '' }, ...extra,
  });
  const tasks: Record<string, Task> = {
    t1: task('t1', 'Собрать макет главной', { isCompleted: true, completed: true, metadata: { md: '', chain: chain(1) } }),
    t2: task('t2', 'Тестирование сайта', { status: 'in-progress', assignedToIds: ['u2'], assignedToId: 'u2', metadata: { md: '', chain: chain(2) } }),
    t3: task('t3', 'Согласование текстов', { assignedToIds: ['u3'], assignedToId: 'u3', metadata: { md: '', chain: chain(3) } }),
    t4: task('t4', 'Публикация', { metadata: { md: '', chain: chain(4) } }),
    t5: task('t5', 'Задача себе: позвонить подрядчику', {}),
    t6: task('t6', 'Обновить фото тура', { assignedToIds: [me], assignedToId: me, assignedById: 'u2', authorId: 'u2', isNew: true }),
  };
  useTasks.setState({ tasks, lists: [{ id: 'L1', name: 'Корп сайт', color: 'var(--note-blue)', creatorId: me, sharedLevel: 'edit' }], phase: 'ready' } as never);
  host = document.createElement('div');
  host.id = 'tasks-preview';
  host.className = 'nx';
  host.style.cssText = 'position:fixed;inset:0;z-index:900;display:flex;background:var(--bg-color,#fff)';
  document.body.prepend(host);
  root = createRoot(host);
  root.render(<MemoryRouter><TasksScreen /></MemoryRouter>);
  return me;
}
