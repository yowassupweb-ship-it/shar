import { myId } from '@/shared/session/session';

/**
 * История посещений: в каких чатах, материалах «Офиса», задачах, файлах и карточках людей человек был.
 * Хранится на устройстве (по человеку), последние ~80 записей; повторные заходы поднимают запись наверх.
 */
export type VisitKind = 'chat' | 'office' | 'task' | 'file' | 'person';

export interface Visit {
  key: string;
  kind: VisitKind;
  title: string;
  subtitle?: string;
  /** Подвид: у материала «Офиса» — note | document | table | presentation. */
  sub?: string;
  /** Куда вести. */
  path: string;
  ts: number;
  /** Сколько раз заходили. */
  n: number;
}

const LIMIT = 80;
const storageKey = () => `nx:visits:${myId() || 'anon'}`;

export function getVisits(): Visit[] {
  try {
    const list = JSON.parse(localStorage.getItem(storageKey()) || '[]');
    return Array.isArray(list) ? (list as Visit[]).filter((v) => v && v.key && v.path) : [];
  } catch { return []; }
}

const listeners = new Set<() => void>();
export const onVisitsChanged = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export function recordVisit(entry: Omit<Visit, 'key' | 'ts' | 'n'> & { id: string }) {
  if (!entry.title) return;
  const key = `${entry.kind}:${entry.id}`;
  const list = getVisits();
  const prev = list.find((v) => v.key === key);
  const now = Date.now();
  if (prev && now - prev.ts < 2000 && prev.title === entry.title) return;
  const next: Visit = { key, kind: entry.kind, title: entry.title, subtitle: entry.subtitle, sub: entry.sub, path: entry.path, ts: now, n: (prev?.n || 0) + 1 };
  try { localStorage.setItem(storageKey(), JSON.stringify([next, ...list.filter((v) => v.key !== key)].slice(0, LIMIT))); } catch { /* нет хранилища — история на сессию не нужна */ }
  listeners.forEach((fn) => fn());
}

export function forgetVisit(key: string) {
  try { localStorage.setItem(storageKey(), JSON.stringify(getVisits().filter((v) => v.key !== key))); } catch { /* ignore */ }
  listeners.forEach((fn) => fn());
}

export function clearVisits() {
  try { localStorage.removeItem(storageKey()); } catch { /* ignore */ }
  listeners.forEach((fn) => fn());
}
