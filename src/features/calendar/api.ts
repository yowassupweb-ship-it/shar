import { create } from 'zustand';
import { realtime, type RealtimeEvent } from '@/shared/realtime/realtime';
import { displayName, useChatStore } from '@/features/chat';
import { byStart, localIso, normalize, parseLocal, rowId, type CalEvent } from './model';

/**
 * Данные календаря: события видимого диапазона.
 *
 * Сервер разворачивает повторы сам (/api/events с диапазоном), поэтому держим
 * ровно то, что на экране, и перечитываем диапазон после каждой записи.
 * Правка сразу видна (оптимистично), ошибка — откат.
 *
 * Живое обновление — без опроса: сервер шлёт calendar_changed всем, чей
 * календарь затронула запись, а после переподключения сокета приходит resync.
 */

export type Phase = 'idle' | 'loading' | 'ready' | 'error';
export type Scope = 'this' | 'following' | 'all';

interface State {
  events: CalEvent[];
  range: { from: string; to: string } | null;
  phase: Phase;
}

export const useCalendar = create<State>(() => ({ events: [], range: null, phase: 'idle' }));

/** id вошедшего пользователя — единый источник: shared/session. */
export { myId } from '@/shared/session/session';
import { myId } from '@/shared/session/session';

export const isMine = (e: CalEvent) => !e.createdBy || e.createdBy === myId();

// ── Кэш: последний диапазон показывается мгновенно ──────────────────────────

const cacheKey = () => `nxcal:v1:${myId()}`;

function readCache(from: string, to: string): CalEvent[] | null {
  try {
    const c = JSON.parse(localStorage.getItem(cacheKey()) || 'null') as { from: string; to: string; events: CalEvent[] } | null;
    return c && c.from === from && c.to === to ? c.events : null;
  } catch { return null; }
}
function writeCache(from: string, to: string, events: CalEvent[]) {
  try { localStorage.setItem(cacheKey(), JSON.stringify({ from, to, events })); } catch { /* переполнено — без кэша */ }
}

// ── Чтение ──────────────────────────────────────────────────────────────────

let seq = 0;

export async function loadRange(from: string, to: string): Promise<void> {
  const cur = useCalendar.getState();
  const sameRange = cur.range?.from === from && cur.range?.to === to;
  if (!sameRange) {
    const cached = readCache(from, to);
    useCalendar.setState({ range: { from, to }, events: cached || [], phase: cached ? 'ready' : 'loading' });
  }
  listen();
  const mine = ++seq;
  try {
    const qs = new URLSearchParams({ startDate: from, endDate: to, userId: myId(), personal: 'true' });
    const res = await fetch(`/api/events?${qs}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as { events?: Record<string, unknown>[] };
    if (mine !== seq) return; // пока ждали, перешли на другой диапазон
    const events = (data.events || []).map(normalize).filter((e): e is CalEvent => Boolean(e)).sort(byStart);
    useCalendar.setState({ events, phase: 'ready' });
    writeCache(from, to, events);
  } catch {
    if (mine === seq) useCalendar.setState((s) => ({ phase: s.events.length ? 'ready' : 'error' }));
  }
}

export function reload(): Promise<void> {
  const r = useCalendar.getState().range;
  return r ? loadRange(r.from, r.to) : Promise.resolve();
}

let reloadTimer: number | null = null;
function reloadSoon() {
  if (reloadTimer !== null) window.clearTimeout(reloadTimer);
  reloadTimer = window.setTimeout(() => { reloadTimer = null; void reload(); }, 250);
}

let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  realtime.subscribe((e: RealtimeEvent) => {
    if (e.type === 'calendar_changed' || e.type === 'resync') reloadSoon();
  });
}

// ── Запись ──────────────────────────────────────────────────────────────────

export interface Draft {
  title: string;
  description?: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  color?: string;
  reminderMinutesBefore?: number | null;
  recurrenceRule?: string | null;
  participants: string[];
  sharedWithAll: boolean;
}

/** Поля для сервера: те же имена, что в метаданных события. */
function body(d: Partial<Draft>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...d };
  if (d.start !== undefined) { out.startDateTime = d.start; out.startDate = d.start; delete out.start; }
  if (d.end !== undefined) { out.endDateTime = d.end; out.endDate = d.end; delete out.end; }
  return out;
}

function replaceLocal(fn: (list: CalEvent[]) => CalEvent[]) {
  useCalendar.setState((s) => ({ events: fn(s.events).sort(byStart) }));
}

async function call(url: string, method: string, payload?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(String(res.status));
  return res.json().catch(() => null);
}

export async function createEvent(d: Draft): Promise<void> {
  const me = useChatStore.getState().me;
  const id = crypto.randomUUID();
  const createdBy = myId();
  const local: CalEvent = { ...d, id, createdBy, createdByName: displayName(me) };
  const before = useCalendar.getState().events;
  replaceLocal((list) => [...list, local]);
  try {
    await call('/api/events', 'POST', { ...body(d), id, createdBy, userId: createdBy, createdByName: displayName(me), type: 'personal' });
  } catch (e) {
    useCalendar.setState({ events: before });
    throw e;
  }
  void reload();
}

export async function updateEvent(e: CalEvent, patch: Partial<Draft>, scope: Scope = 'all'): Promise<void> {
  const before = useCalendar.getState().events;
  replaceLocal((list) => list.map((x) => (x.id === e.id ? { ...x, ...patch } : x)));
  try {
    const recurring = Boolean(e.masterId);
    let fields = patch;
    // Серия целиком: новое время повторения — это сдвиг начала серии на ту же
    // разницу, а не новое начало (иначе серия начиналась бы с этого повторения).
    if (recurring && scope === 'all' && (patch.start || patch.end)) {
      const master = normalize((await call(`/api/events/${encodeURIComponent(rowId(e))}`, 'GET')) as Record<string, unknown>);
      if (master) {
        const shift = (iso: string | undefined, from: string, base: string) =>
          (iso ? localIso(new Date(parseLocal(base).getTime() + (parseLocal(iso).getTime() - parseLocal(from).getTime()))) : undefined);
        fields = {
          ...patch,
          ...(patch.start ? { start: shift(patch.start, e.start, master.start) } : {}),
          ...(patch.end ? { end: shift(patch.end, e.end, master.end) } : {}),
        };
      }
    }
    await call(`/api/events/${encodeURIComponent(rowId(e))}`, 'PUT', {
      ...body(fields),
      ...(recurring && scope !== 'all' ? { editScope: scope, recurrenceId: e.recurrenceId } : {}),
    });
  } catch (err) {
    useCalendar.setState({ events: before });
    throw err;
  }
  void reload();
}

export async function deleteEvent(e: CalEvent, scope: Scope = 'all'): Promise<void> {
  const before = useCalendar.getState().events;
  const series = rowId(e);
  replaceLocal((list) => list.filter((x) => (scope === 'this' ? x.id !== e.id : rowId(x) !== series)));
  try {
    const qs = new URLSearchParams({ deleteScope: scope === 'this' ? 'this' : 'all' });
    if (scope === 'this' && e.recurrenceId) qs.set('recurrenceId', e.recurrenceId);
    await call(`/api/events/${encodeURIComponent(series)}?${qs}`, 'DELETE');
  } catch (err) {
    useCalendar.setState({ events: before });
    throw err;
  }
  void reload();
}

/** Поделились со мной, а мне не нужно, — убрать себя из участников. */
export async function leaveEvent(e: CalEvent): Promise<void> {
  const me = myId();
  await updateEvent(e, { participants: e.participants.filter((p) => p !== me) }, 'all');
}
