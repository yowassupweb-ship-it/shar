import type { CalEvent } from '@/features/calendar';
import { assigneesOf, isDone, myId, statusOf, type Task } from './api';
import { repeatIdOf } from './repeat';
import { parseDue } from './due';

/**
 * Задачи со сроком как события календаря. Не записи в базе событий: рисуются из списка задач, поэтому срок
 * в задаче и в календаре — одно и то же, расходиться им нечему (так же устроены дни рождения). Без времени —
 * на весь день, со временем — получасовой блок. Повторяющиеся не берём: их срокам даёт место серия
 * в календаре (repeat.ts). Правится задача в «Задачах»: событие открывает её, не редактор.
 */

export const TASK_EVENT = 'task:';
export const isTaskEvent = (id: string) => id.startsWith(TASK_EVENT);
export const taskIdOfEvent = (id: string) => id.slice(TASK_EVENT.length);

const pad = (n: number) => String(n).padStart(2, '0');
const local = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;

/** Касается ли меня задача: я исполнитель, автор или заказчик. */
const isMyTask = (t: Task) => {
  const me = myId();
  return assigneesOf(t).includes(me) || [t.authorId, t.assignedById].some((id) => id && String(id) === me);
};

export function taskEvents(tasks: Record<string, Task>, from: Date, to: Date): CalEvent[] {
  const out: CalEvent[] = [];
  const now = Date.now();
  for (const t of Object.values(tasks)) {
    if (!t.dueDate || t.archived || isDone(t) || statusOf(t) === 'cancelled' || repeatIdOf(t) !== 'none' || !isMyTask(t)) continue;
    const due = parseDue(t.dueDate);
    if (!due) continue;
    const start = due.time ? due.day : new Date(due.day.getFullYear(), due.day.getMonth(), due.day.getDate());
    if (start < from || start >= to) continue;
    const end = due.time ? new Date(start.getTime() + 30 * 60000) : start;
    const late = (due.time ? start.getTime() : start.getTime() + 86400000) < now;
    out.push({
      id: `${TASK_EVENT}${t.id}`,
      title: t.title || 'Задача',
      description: 'Задача',
      start: local(start),
      end: local(end),
      allDay: !due.time,
      color: late ? 'red' : t.priority === 'high' ? 'orange' : 'purple',
      participants: [],
      sharedDepartments: [],
      participantsCanEdit: false,
      sharedWithAll: false,
      createdBy: 'system:task', // не «моё» для календаря: не тянется и не удаляется отсюда
    });
  }
  return out;
}
