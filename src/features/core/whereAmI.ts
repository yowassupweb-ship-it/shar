import { useEffect, useState } from 'react';
import { windowVisit } from '@/features/spotlight';
import { myId } from '@/shared/session/session';

/**
 * «Где человек сейчас» для агента «Ядра»: раздел и то, что открыто, — в каждом окне Шара (главное окно, окна
 * документов и заметок в Shar OS, вкладки браузера). Окна одного адреса делят localStorage: каждое раз в несколько
 * секунд пишет туда своё «что на экране», поле ввода «Ядра» собирает живые записи всех окон в плашки. Плашку можно
 * зачеркнуть — тогда агенту она не уйдёт.
 *
 * Что открыто, окно узнаёт из истории посещений (recordVisit: чат, задача, материал «Офиса», человек, инструмент) —
 * если её адрес совпадает с текущим; иначе — только раздел.
 */

export interface WhereItem {
  /** Ключ плашки (по адресу): по нему помнится, что зачёркнуто. */
  key: string;
  kind: string;
  title: string;
  id?: string;
  url: string;
  /** Окно сейчас в фокусе (то, где человек печатает, — первым). */
  here: boolean;
}

const SECTIONS: Record<string, string> = {
  '/tasks': 'Задачи', '/calendar': 'Календарь', '/contacts': 'Люди', '/files': 'Файлы',
  '/office': 'Офис', '/more': 'Ещё', '/settings': 'Настройки', '/admin': 'Админка', '/site-leads': 'Заявки с сайта',
  '/core': 'Ядро',
};
const FRESH_MS = 15_000;
const BEAT_MS = 5_000;
const prefix = () => `nx:core:where:${myId() || 'anon'}:`;

function windowId(): string {
  try {
    const known = sessionStorage.getItem('nx:core:window');
    if (known) return known;
    const id = crypto.randomUUID().slice(0, 8);
    sessionStorage.setItem('nx:core:window', id);
    return id;
  } catch { return 'main'; }
}

/** Что на экране этого окна: открытое (если адрес совпадает с последним посещением) или раздел. */
function snapshot(): Omit<WhereItem, 'here'> | null {
  const { pathname, search } = window.location;
  // Переписки (чаты, почта, соцсети) агенту закрыты совсем — даже то, что человек сейчас в них. Нужное он пересылает сам.
  if (pathname === '/core' || pathname === '/login' || /^\/(chats|mail|social)/.test(pathname)) return null;
  const visit = windowVisit();
  if (visit) {
    const target = new URL(visit.path, window.location.origin);
    const current = new URLSearchParams(search);
    // Адрес в истории бывает полнее адреса окна («Офис» пишет ?kind=document&id=…, а окно открыто как ?id=…):
    // недостающий в окне параметр не мешает, но id — если он есть — обязан совпасть.
    const same = target.pathname === pathname
      && (!target.searchParams.has('id') || current.get('id') === target.searchParams.get('id'))
      && [...target.searchParams].every(([k, v]) => !current.has(k) || current.get(k) === v);
    if (same) {
      const kind = visit.kind === 'office' ? visit.sub || 'document' : visit.kind === 'tool' ? 'section' : visit.kind;
      return { key: visit.path, kind, title: visit.title, id: visit.id, url: visit.path };
    }
  }
  const section = SECTIONS[pathname];
  return section ? { key: pathname, kind: 'section', title: section, url: pathname } : null;
}

let started = false;

/** Запускается один раз в каждом окне (AppRoot): пишет своё «что на экране» и убирает запись при закрытии. */
export function startWhereAmI() {
  if (started) return;
  started = true;
  const id = windowId();
  const write = () => {
    const item = snapshot();
    try {
      if (item) localStorage.setItem(prefix() + id, JSON.stringify({ ...item, at: Date.now(), focus: document.hasFocus() }));
      else localStorage.removeItem(prefix() + id);
    } catch { /* нет хранилища — агент просто не узнает, где человек */ }
  };
  write();
  window.setInterval(write, BEAT_MS);
  for (const event of ['shar:window-visit', 'popstate', 'focus', 'blur']) window.addEventListener(event, write);
  // Переходы внутри приложения (pushState) событий не дают — смотрим адрес чаще, чем пульс, но дёшево.
  let last = window.location.href;
  window.setInterval(() => { if (window.location.href !== last) { last = window.location.href; write(); } }, 700);
  window.addEventListener('pagehide', () => { try { localStorage.removeItem(prefix() + id); } catch { /* ignore */ } });
}

export function readWhere(): WhereItem[] {
  const out: WhereItem[] = [];
  const now = Date.now();
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key?.startsWith(prefix())) continue;
      const entry = JSON.parse(localStorage.getItem(key) || 'null') as (WhereItem & { at: number; focus: boolean }) | null;
      if (!entry || now - entry.at > FRESH_MS) { if (entry) localStorage.removeItem(key); continue; }
      const known = out.find((x) => x.key === entry.key);
      if (known) { known.here = known.here || entry.focus; continue; }
      out.push({ key: entry.key, kind: entry.kind, title: entry.title, id: entry.id, url: entry.url, here: entry.focus });
    }
  } catch { /* ignore */ }
  // Открытое важнее раздела, окно в фокусе — первым.
  return out.sort((a, b) => Number(b.here) - Number(a.here) || Number(b.kind !== 'section') - Number(a.kind !== 'section')).slice(0, 8);
}

/** Плашки «где я» для поля ввода: обновляются, пока поле на экране. */
export function useWhere(): WhereItem[] {
  const [items, setItems] = useState<WhereItem[]>(readWhere);
  useEffect(() => {
    const refresh = () => setItems((prev) => {
      const next = readWhere();
      return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
    });
    const timer = window.setInterval(refresh, 2000);
    window.addEventListener('storage', refresh);
    window.addEventListener('shar:window-visit', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('storage', refresh); window.removeEventListener('shar:window-visit', refresh); };
  }, []);
  return items;
}
