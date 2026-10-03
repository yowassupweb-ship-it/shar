import { create } from 'zustand';
import { realtime, type RealtimeEvent } from '@/shared/realtime/realtime';
import { htmlToMarkdown, markdownToHtml } from './markdown';

/**
 * Данные раздела «Задачи»: тот же /api/todos, что у старого экрана, — задачи
 * общие, старый и новый экраны видят одно и то же.
 *
 * Текст задачи — markdown в metadata.md (как документ MBOX). В description
 * одновременно пишем HTML из него: старый экран читает именно description.
 * Задача без metadata.md (создана в старом экране) открывается переводом её
 * HTML в markdown — при первой правке markdown сохранится рядом.
 */

export type Status = 'pending' | 'in-progress' | 'review' | 'stuck' | 'cancelled' | 'todo';
export type Priority = 'low' | 'medium' | 'high';

export interface Task {
  id: string;
  title: string;
  description?: string;
  status?: Status;
  priority?: Priority;
  completed?: boolean;
  isCompleted?: boolean;
  archived?: boolean;
  dueDate?: string | null;
  listId?: string | null;
  authorId?: string | null;
  assignedById?: string | null;
  assignedBy?: string | null;
  assignedToId?: string | null;
  assignedTo?: string | null;
  assignedToIds?: string[];
  createdAt: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
  chatId?: string;
}

export interface TaskList { id: string; name: string; color?: string; creatorId?: string; allowedUsers?: string[] }

/** Списки, которые касаются меня: мои, открытые мне лично или где лежат мои задачи. Плюс текущий. */
export function relevantLists(lists: TaskList[], tasks: Record<string, Task>, currentId?: string | null): TaskList[] {
  const me = myId();
  const used = new Set<string>();
  for (const t of Object.values(tasks)) {
    if (!t.listId) continue;
    if (assigneesOf(t).includes(me) || [t.assignedById, t.authorId].some((id) => id && String(id) === me)) used.add(String(t.listId));
  }
  return lists
    .filter((l) => l.id === currentId || String(l.creatorId || '') === me || (l.allowedUsers || []).map(String).includes(me) || used.has(l.id))
    .sort((x, y) => x.name.localeCompare(y.name, 'ru'));
}

export const STATUSES: { id: Status; label: string; tone: string }[] = [
  { id: 'in-progress', label: 'В работе', tone: 'var(--note-blue)' },
  { id: 'pending', label: 'В ожидании', tone: 'var(--note-orange)' },
  { id: 'review', label: 'На проверке', tone: 'var(--note-green)' },
  { id: 'stuck', label: 'Застряла', tone: 'var(--note-red)' },
  { id: 'cancelled', label: 'Отменена', tone: 'var(--note-gray)' },
];
export const statusOf = (t: Task): Status => (t.status === 'todo' || !t.status ? 'pending' : t.status);
export const isDone = (t: Task) => Boolean(t.isCompleted ?? t.completed);
export const PRIORITIES: { id: Priority; label: string }[] = [
  { id: 'high', label: 'Высокий' },
  { id: 'medium', label: 'Обычный' },
  { id: 'low', label: 'Низкий' },
];

/** id вошедшего пользователя — единый источник: shared/session. */
export { myId } from '@/shared/session/session';
import { myId } from '@/shared/session/session';

/** Текст задачи в markdown: свой или переведённый из старого HTML. */
export function taskMarkdown(t: Task): string {
  const md = t.metadata?.md;
  return typeof md === 'string' ? md : htmlToMarkdown(t.description || '');
}

export function assigneesOf(t: Task): string[] {
  const ids = (t.assignedToIds && t.assignedToIds.length ? t.assignedToIds : t.assignedToId ? [t.assignedToId] : []).map(String);
  return Array.from(new Set(ids));
}

// ── Стор ────────────────────────────────────────────────────────────────────

interface State {
  tasks: Record<string, Task>;
  lists: TaskList[];
  phase: 'loading' | 'ready' | 'error';
}

const CACHE_KEY = 'nx:tasks-cache';

function readCache(): Pick<State, 'tasks' | 'lists'> | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as { tasks: Task[]; lists: TaskList[]; uid: string };
    if (d.uid !== myId()) return null;
    return { tasks: Object.fromEntries(d.tasks.map((t) => [t.id, t])), lists: d.lists };
  } catch { return null; }
}

let cacheTimer = 0;
function writeCacheSoon() {
  window.clearTimeout(cacheTimer);
  cacheTimer = window.setTimeout(() => {
    const s = useTasks.getState();
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ uid: myId(), tasks: Object.values(s.tasks), lists: s.lists })); } catch { /* переполнено — не страшно */ }
  }, 500);
}

export const useTasks = create<State>(() => ({ tasks: {}, lists: [], phase: 'loading' }));

let booted = false;
let inflight: Promise<void> | null = null;

/** Первая загрузка: сразу из кэша, затем с сервера. Повторные вызовы — один запрос. */
export function loadTasks(): Promise<void> {
  if (!booted) {
    booted = true;
    const cached = readCache();
    if (cached) useTasks.setState({ ...cached, phase: 'ready' });
    listen();
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch(`/api/todos?userId=${encodeURIComponent(myId())}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const d = (await res.json()) as { todos?: Task[]; lists?: TaskList[] };
      const tasks: Record<string, Task> = {};
      for (const t of d.todos || []) if (t && t.id && !t.archived) tasks[String(t.id)] = { ...t, id: String(t.id) };
      useTasks.setState({ tasks, lists: d.lists || [], phase: 'ready' });
      writeCacheSoon();
    } catch {
      useTasks.setState((s) => ({ phase: Object.keys(s.tasks).length ? 'ready' : 'error' }));
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function put(t: Task) {
  useTasks.setState((s) => ({ tasks: { ...s.tasks, [t.id]: t } }));
  writeCacheSoon();
}

/** Задачи приходят по тому же сокету, что и чаты: task_created / task_updated. */
function listen() {
  realtime.subscribe((e: RealtimeEvent) => {
    if (e.type !== 'task_created' && e.type !== 'task_updated' && e.type !== 'task_deleted') return;
    const id = String(e.taskId || '');
    if (!id) return;
    if (e.type === 'task_deleted') {
      useTasks.setState((s) => { const next = { ...s.tasks }; delete next[id]; return { tasks: next }; });
      return;
    }
    const incoming = e.task as Task | undefined;
    if (!incoming) return;
    const cur = useTasks.getState().tasks[id];
    // Своя правка, которую мы ещё сохраняем, важнее эха с сервера.
    if (dirty.has(id)) return;
    put({ ...cur, ...incoming, id });
  });
  // После переподключения — перечитать: пока сокета не было, события не приходили.
  realtime.subscribe((e: RealtimeEvent) => { if (e.type === 'resync') void loadTasks(); });
}

const dirty = new Set<string>();

// ── Запись ──────────────────────────────────────────────────────────────────

async function send(method: 'POST' | 'PUT', body: Record<string, unknown>): Promise<Task> {
  const res = await fetch('/api/todos', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as Task;
}

export async function createTask(init: Partial<Task> & { md?: string }): Promise<Task> {
  const me = myId();
  const md = init.md ?? '';
  const saved = await send('POST', {
    type: 'todo',
    title: init.title || '',
    description: markdownToHtml(md),
    status: init.status || 'pending',
    priority: init.priority || 'medium',
    authorId: me,
    assignedById: me,
    assignedToId: init.assignedToId || me,
    assignedToIds: init.assignedToIds || [init.assignedToId || me],
    listId: init.listId || useTasks.getState().lists[0]?.id || null,
    dueDate: init.dueDate || null,
    metadata: { md },
  });
  const t = { ...saved, id: String(saved.id) };
  put(t);
  return t;
}

/** Правка полей: сразу в стор, затем на сервер. Ошибка — откат и исключение. */
export async function updateTask(id: string, patch: Partial<Task>): Promise<void> {
  const before = useTasks.getState().tasks[id];
  if (!before) return;
  put({ ...before, ...patch, updatedAt: new Date().toISOString() });
  dirty.add(id);
  try {
    const saved = await send('PUT', { id, ...patch });
    put({ ...useTasks.getState().tasks[id], ...saved, id });
  } catch (e) {
    put(before);
    throw e;
  } finally {
    dirty.delete(id);
  }
}

/** Текст задачи: заголовок — первая строка, markdown — в metadata.md, HTML — в description. */
export function saveText(id: string, title: string, md: string): Promise<void> {
  const t = useTasks.getState().tasks[id];
  return updateTask(id, {
    title,
    description: markdownToHtml(md),
    metadata: { ...(t?.metadata || {}), md },
  });
}

export async function deleteTask(id: string): Promise<void> {
  const before = useTasks.getState().tasks[id];
  useTasks.setState((s) => { const next = { ...s.tasks }; delete next[id]; return { tasks: next }; });
  const res = await fetch(`/api/todos?id=${encodeURIComponent(id)}&type=todo`, { method: 'DELETE' });
  if (!res.ok) {
    if (before) put(before);
    throw new Error(String(res.status));
  }
  writeCacheSoon();
}
