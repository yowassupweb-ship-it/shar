import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * Данные раздела «Контакты»: сотрудники, отделы, присутствие.
 *
 * Первый кадр — из локального кэша (тот же contacts_cache, что у старой
 * страницы), сеть догоняет. Присутствие обновляется лёгким опросом
 * /api/users/statuses, пока вкладка видна.
 */

export interface Contact {
  id: string;
  name?: string;
  username?: string;
  email?: string;
  position?: string;
  department?: string;
  departmentIds?: string[];
  isDepartmentHead?: boolean;
  workSchedule?: string;
  phone?: string;
  avatar?: string;
  role?: 'admin' | 'user';
  telegramUsername?: string;
  createdAt?: string;
  isOnline?: boolean;
  lastSeen?: string;
}

export interface Department {
  id: string;
  name: string;
  color?: string;
  parentId?: string | null;
  order?: number;
}

export interface Group {
  id: string;
  name: string;
  color?: string;
  /** Подгруппы — подразделы отдела; пустой список — люди прямо в отделе. */
  subs: { id: string; name: string; color?: string; members: Contact[] }[];
  /** Люди отдела вне подразделов (или все, если подразделов нет). */
  members: Contact[];
  total: number;
}

export type Phase = 'loading' | 'ready' | 'error';

const CACHE = 'contacts_cache';
const STATUS_EVERY = 15000;
export const NO_DEPT = '__none__';

export function contactName(c?: Contact): string {
  return (c?.name || c?.username || 'Сотрудник').trim();
}

function readCache(): Contact[] {
  try { return JSON.parse(localStorage.getItem(CACHE) || '[]') as Contact[]; } catch { return []; }
}

export function readMe(): (Contact & { role?: string }) | null {
  try { return JSON.parse(localStorage.getItem('myAccount') || 'null'); } catch { return null; }
}

const DEPT_CACHE = 'contacts_departments_cache';

// Память между заходами в раздел: при возврате список строится мгновенно и
// ровно в том же порядке. Раньше отделы не кэшировались вовсе — первый кадр
// группировал людей по «призракам» (id отдела вместо названия), а через
// мгновение, когда приходили отделы, всё перестраивалось заново.
let memContacts: Contact[] | null = null;
let memDepartments: Department[] | null = null;

function readDeptCache(): Department[] | null {
  try {
    const raw = localStorage.getItem(DEPT_CACHE);
    return raw ? (JSON.parse(raw) as Department[]) : null;
  } catch { return null; }
}

export function useContacts() {
  const [contacts, setContacts] = useState<Contact[]>(() => memContacts ?? readCache());
  const [departments, setDepartments] = useState<Department[]>(() => memDepartments ?? readDeptCache() ?? []);
  // Отделы известны (из памяти, кэша или сервера) — только тогда показываем группы.
  const [deptsReady, setDeptsReady] = useState<boolean>(() => Boolean(memDepartments ?? readDeptCache()));
  const [contactsPhase, setContactsPhase] = useState<Phase>(() => ((memContacts ?? readCache()).length ? 'ready' : 'loading'));

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/users', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const list = await res.json();
      const users = Array.isArray(list) ? (list as Contact[]).map((u) => ({ ...u, id: String(u.id) })) : [];
      const serialized = JSON.stringify(users);
      memContacts = users;
      // Те же данные — не трогаем состояние: список не перерисовывается и не «прыгает».
      setContacts((prev) => (JSON.stringify(prev) === serialized ? prev : users));
      setContactsPhase('ready');
      try { localStorage.setItem(CACHE, serialized); } catch { /* кэш не обязателен */ }
    } catch {
      setContactsPhase((p) => (p === 'ready' ? p : 'error'));
    }
  }, []);

  useEffect(() => {
    void load();
    fetch('/api/departments', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!Array.isArray(d?.departments)) return;
        const list = d.departments as Department[];
        const serialized = JSON.stringify(list);
        memDepartments = list;
        setDepartments((prev) => (JSON.stringify(prev) === serialized ? prev : list));
        try { localStorage.setItem(DEPT_CACHE, serialized); } catch { /* кэш не обязателен */ }
      })
      .catch(() => {})
      // Отделы не пришли — всё равно показываем людей (группами по имеющимся данным).
      .finally(() => setDeptsReady(true));
  }, [load]);

  const phase: Phase = contactsPhase === 'ready' && !deptsReady ? 'loading' : contactsPhase;

  // Присутствие: пока вкладка на экране. Ответ бывает в трёх формах — старые и новые бэкенды.
  useEffect(() => {
    let timer = 0;
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const res = await fetch('/api/users/statuses', { cache: 'no-store' });
        if (!res.ok) return;
        const raw = await res.json();
        const rows: Record<string, unknown>[] = Array.isArray(raw) ? raw : raw?.statuses || raw?.users || [];
        const map = new Map<string, { isOnline: boolean; lastSeen?: string }>();
        for (const r of rows) {
          const id = String(r.id ?? r.userId ?? r.user_id ?? '');
          if (id) map.set(id, { isOnline: r.isOnline === true || r.is_online === true, lastSeen: (r.lastSeen ?? r.last_seen) as string | undefined });
        }
        if (map.size) {
          setContacts((prev) => prev.map((c) => {
            const s = map.get(c.id);
            return s && (s.isOnline !== c.isOnline || (s.lastSeen && s.lastSeen !== c.lastSeen))
              ? { ...c, isOnline: s.isOnline, lastSeen: s.lastSeen ?? c.lastSeen } : c;
          }));
        }
      } catch { /* следующий опрос догонит */ }
    };
    timer = window.setInterval(tick, STATUS_EVERY);
    const onVisible = () => { if (document.visibilityState === 'visible') void tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);

  return { contacts, departments, phase, reload: load };
}

/** Поиск по имени, логину, почте, должности и отделу. */
export function matches(c: Contact, q: string, deptName: (id: string) => string): boolean {
  if (!q) return true;
  const ids = c.departmentIds?.length ? c.departmentIds : c.department ? [c.department] : [];
  return [c.name, c.username, c.email, c.position, c.phone, ...ids.map(deptName)]
    .some((v) => String(v || '').toLowerCase().includes(q));
}

const byHeadThenName = (a: Contact, b: Contact) =>
  Number(Boolean(b.isDepartmentHead)) - Number(Boolean(a.isDepartmentHead))
  || contactName(a).localeCompare(contactName(b), 'ru')
  || String(a.id).localeCompare(String(b.id));

/** Группы для списка: отделы верхнего уровня, внутри — подразделы. Человек из
 *  нескольких отделов стоит в каждом. Отделы-«призраки» (есть у людей, нет в
 *  справочнике) — отдельными группами, чтобы никто не пропал. */
export function useGroups(contacts: Contact[], departments: Department[]): Group[] {
  return useMemo(() => {
    const meta = new Map(departments.map((d) => [d.id, d]));
    const members = new Map<string, Contact[]>();
    for (const c of contacts) {
      const ids = c.departmentIds?.length ? c.departmentIds : c.department ? [c.department] : [NO_DEPT];
      for (const id of ids) {
        const list = members.get(id) || [];
        if (!list.some((x) => x.id === c.id)) list.push(c);
        members.set(id, list);
      }
    }
    const order = (a: Department, b: Department) => (a.order ?? 999) - (b.order ?? 999)
      || a.name.localeCompare(b.name, 'ru')
      || String(a.id).localeCompare(String(b.id));
    const childrenOf = (id: string) => departments.filter((d) => d.parentId === id).sort(order);

    const groupFor = (id: string, name: string, color?: string): Group => {
      const subs = childrenOf(id)
        .map((d) => ({ id: d.id, name: d.name, color: d.color, members: (members.get(d.id) || []).sort(byHeadThenName) }))
        .filter((s) => s.members.length);
      const inSubs = new Set(subs.flatMap((s) => s.members.map((m) => m.id)));
      const direct = (members.get(id) || []).filter((m) => !inSubs.has(m.id)).sort(byHeadThenName);
      return { id, name, color, subs, members: direct, total: new Set([...inSubs, ...direct.map((m) => m.id)]).size };
    };

    const tops = departments.filter((d) => !d.parentId).sort(order).map((d) => groupFor(d.id, d.name, d.color));
    const ghosts = [...members.keys()]
      .filter((k) => k !== NO_DEPT && !meta.has(k))
      .sort((a, b) => a.localeCompare(b, 'ru'))
      .map((k) => groupFor(k, k));
    const none = members.get(NO_DEPT);
    const out = [...tops, ...ghosts].filter((g) => g.total > 0);
    if (none?.length) out.push({ id: NO_DEPT, name: 'Без отдела', subs: [], members: none.sort(byHeadThenName), total: none.length });
    return out;
  }, [contacts, departments]);
}
