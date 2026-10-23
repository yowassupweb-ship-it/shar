import { create } from 'zustand';
import type { CalEvent } from '@/features/calendar/model';

/** День рождения сотрудника. Год необязателен — без него не показываем возраст. */
export interface Birthday { userId: string; name: string; avatar: string; day: number; month: number; year: number | null }

interface State {
  items: Birthday[];
  mine: Birthday | null;
  /** Ответ сервера получен (до этого плашку «Укажите…» не показываем, чтобы она не мигала). */
  loaded: boolean;
  /** На сервере нет раздела (бэкенд старее клиента) — молчим. */
  unsupported: boolean;
}

export const useBirthdays = create<State>(() => ({ items: [], mine: null, loaded: false, unsupported: false }));

async function call(url: string, init?: RequestInit) {
  const res = await fetch(url, { cache: 'no-store', ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) } });
  if (res.status === 404 || res.status === 405) { useBirthdays.setState({ unsupported: true, loaded: true }); return; }
  if (!res.ok) {
    let message = 'Не удалось сохранить';
    try { message = (await res.json()).detail || message; } catch { /* не JSON */ }
    throw new Error(typeof message === 'string' ? message : 'Проверьте дату');
  }
  const data = (await res.json()) as { items: Birthday[]; mine: Birthday | null };
  useBirthdays.setState({ items: data.items, mine: data.mine, loaded: true, unsupported: false });
}

let pending: Promise<void> | null = null;
/** Загрузить один раз за сессию (повторный вызов отдаёт тот же запрос). */
export function loadBirthdays(force = false) {
  if (!force && (pending || useBirthdays.getState().loaded)) return pending ?? Promise.resolve();
  pending = call('/api/birthdays').catch(() => undefined).finally(() => { pending = null; });
  return pending;
}

export const saveMyBirthday = (day: number, month: number, year: number | null) =>
  call('/api/birthdays/me', { method: 'PUT', body: JSON.stringify({ day, month, year }) });

export const clearMyBirthday = () => call('/api/birthdays/me', { method: 'DELETE' });

export const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** «14 марта» или «14 марта 1990». */
export const formatBirthday = (b: Pick<Birthday, 'day' | 'month' | 'year'>, withYear = true) =>
  `${b.day} ${MONTHS_GEN[b.month - 1]}${withYear && b.year ? ` ${b.year}` : ''}`;

/** id события-дня рождения в календаре: такие события не правятся и не открываются в редакторе. */
export const isBirthdayEvent = (id: string) => id.startsWith('bday:');

/**
 * Дни рождения как события календаря на весь день — для каждого года, попавшего в период. Не записи в базе:
 * рисуются из списка, поэтому у всех одинаковые и не дублируются. 29 февраля в невисокосный год — 28-го.
 */
export function birthdayEvents(items: Birthday[], from: Date, to: Date): CalEvent[] {
  const pad = (n: number) => String(n).padStart(2, '0');
  const out: CalEvent[] = [];
  for (let year = from.getFullYear(); year <= to.getFullYear(); year += 1) {
    for (const b of items) {
      const leap = new Date(year, 1, 29).getMonth() === 1;
      const day = b.month === 2 && b.day === 29 && !leap ? 28 : b.day;
      const date = new Date(year, b.month - 1, day);
      if (date < from || date > to) continue;
      const iso = `${year}-${pad(b.month)}-${pad(day)}T00:00:00`;
      const age = b.year ? year - b.year : null;
      out.push({
        id: `bday:${b.userId}:${year}`,
        title: `🎂 ${b.name}${age && age > 0 ? ` — ${age}` : ''}`,
        description: `День рождения: ${formatBirthday(b)}`,
        start: iso,
        end: iso,
        allDay: true,
        color: 'orange',
        participants: [],
        sharedWithAll: true,
        createdBy: 'system:birthday', // не «моё»: не тянется, не удаляется
      });
    }
  }
  return out;
}
