import { assigneesOf, myId, type Task } from './api';
import { parseDue } from './due';

/**
 * Повтор задачи по расписанию. Задача остаётся одной, а в календаре появляется
 * серия её сроков на месяц вперёд — у автора и у исполнителей. Горизонт в месяц
 * сервер сдвигает сам (см. _roll_recurring_calendar_events, taskRepeat).
 */

export const TASK_REPEATS: { id: string; label: string; rule: string | null }[] = [
  { id: 'none', label: 'Не повторять', rule: null },
  { id: 'daily', label: 'Каждый день', rule: 'FREQ=DAILY' },
  { id: 'weekdays', label: 'По будням', rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' },
  { id: 'weekly', label: 'Каждую неделю', rule: 'FREQ=WEEKLY' },
  { id: 'biweekly', label: 'Раз в две недели', rule: 'FREQ=WEEKLY;INTERVAL=2' },
  { id: 'monthly', label: 'Каждый месяц', rule: 'FREQ=MONTHLY' },
];

export const repeatIdOf = (t: Task) => String((t.metadata as { repeat?: string } | undefined)?.repeat || 'none');
export const repeatLabel = (id: string) => TASK_REPEATS.find((r) => r.id === id)?.label || 'Повтор';

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Поставить (или снять) серию сроков задачи в календаре. */
export async function syncTaskRepeat(task: Task, repeatId: string): Promise<void> {
  const eventId = `taskrep-${task.id}`;
  const rep = TASK_REPEATS.find((r) => r.id === repeatId);
  if (!rep?.rule) {
    await fetch(`/api/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' }).catch(() => null);
    return;
  }
  const start = task.dueDate ? new Date(`${String(task.dueDate).slice(0, 10)}T12:00:00`) : new Date();
  const until = new Date();
  until.setDate(until.getDate() + 31);
  const day = ymd(start);
  const time = parseDue(task.dueDate)?.time || '';
  // Со временем в сроке серия — получасовые блоки в это время, без времени — на весь день.
  const startAt = time ? `${day}T${time}:00` : `${day}T00:00:00`;
  const endClock = time ? (() => { const [h, m] = time.split(':').map(Number); const t = h * 60 + m + 30; return t >= 1440 ? '23:59' : `${pad(Math.floor(t / 60))}:${pad(t % 60)}`; })() : '';
  const endAt = time ? `${day}T${endClock}:00` : `${day}T00:00:00`;
  const me = myId();
  const body = {
    id: eventId,
    title: task.title || 'Задача',
    description: 'Повторяющаяся задача',
    startDate: startAt,
    startDateTime: startAt,
    endDate: endAt,
    endDateTime: endAt,
    allDay: !time,
    color: 'green',
    reminderMinutesBefore: null,
    recurrenceRule: `${rep.rule};UNTIL=${ymd(until).replace(/-/g, '')}T235959`,
    participants: assigneesOf(task).filter((id) => id !== me),
    sharedWithAll: false,
    createdBy: me,
    userId: me,
    taskId: task.id,
    taskRepeat: true,
    type: 'task',
  };
  const put = await fetch(`/api/events/${encodeURIComponent(eventId)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (put.ok) return;
  const post = await fetch('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!post.ok) throw new Error(String(post.status));
}
