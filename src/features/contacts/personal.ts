import { useCallback, useEffect, useState } from 'react';

/**
 * Личные контакты: записная книжка человека с доступом «как у документов» — видит владелец и те, кому он открыл
 * (людям и отделам; просмотр или редактирование). Сервер: server/app/modules/contacts.
 */

/** Контактное лицо организации: бухгалтер, директор, менеджер — у каждого свои телефон и почта. */
export interface ContactPerson {
  name: string;
  position: string;
  phone: string;
  email: string;
  telegram: string;
  note: string;
}
export const EMPTY_PERSON: ContactPerson = { name: '', position: '', phone: '', email: '', telegram: '', note: '' };

export interface PersonalContact {
  id: string;
  name: string;
  company: string;
  position: string;
  phone: string;
  email: string;
  telegram: string;
  note: string;
  /** Сайт с протоколом (сервер дописывает https://). */
  website: string;
  /** Фото: /api/avatars/pc<id>_… или пусто. */
  avatar: string;
  persons: ContactPerson[];
  ownerId: string;
  ownerName: string;
  /** Мой контакт (я владелец). */
  mine: boolean;
  role: 'owner' | 'edit' | 'view';
  /** Сколько людей и отделов имеют доступ (только у владельца). */
  shared: number;
  updatedAt: string;
}

export type PersonalDraft = Pick<PersonalContact, 'name' | 'company' | 'position' | 'phone' | 'email' | 'telegram' | 'note' | 'website' | 'persons'>;
export const EMPTY_DRAFT: PersonalDraft = { name: '', company: '', position: '', phone: '', email: '', telegram: '', note: '', website: '', persons: [] };

/** Сайт без протокола и хвостового слеша — для подписи ссылки. */
export function siteLabel(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
}

/** Всё, по чему ищется контакт: поля карточки и контактных лиц. */
export function personalHaystack(c: PersonalContact): string {
  return [c.name, c.company, c.position, c.phone, c.email, c.telegram, c.note, c.website,
    ...(c.persons || []).flatMap((x) => [x.name, x.position, x.phone, x.email, x.telegram])].join('\n').toLowerCase();
}

export type ShareRole = 'view' | 'edit';
export interface PersonalShares {
  shares: Array<{ userId: string; name: string; role: ShareRole }>;
  departments: Array<{ departmentId: string; name: string; role: ShareRole; members: number }>;
}

export function personalTitle(c: Pick<PersonalContact, 'name' | 'company'>): string {
  return c.name || c.company || 'Без имени';
}

async function call<T>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url, {
      cache: 'no-store', ...rest,
      headers: json !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
  } catch { throw new Error('Нет связи с сервером'); }
  if (!res.ok) {
    let message = res.statusText || String(res.status);
    try { const d = await res.json(); message = typeof d.detail === 'string' ? d.detail : message; } catch { /* тело не JSON */ }
    if (message === 'Not Found') message = 'На сервере ещё нет личных контактов — нужно обновить бэкенд Шара.';
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const personalApi = {
  list: () => call<{ contacts: PersonalContact[]; ready: boolean }>('/api/contacts/personal'),
  create: (draft: PersonalDraft) => call<PersonalContact>('/api/contacts/personal', { method: 'POST', json: draft }),
  update: (id: string, draft: Partial<PersonalDraft>) => call<PersonalContact>(`/api/contacts/personal/${encodeURIComponent(id)}`, { method: 'PATCH', json: draft }),
  setAvatar: (id: string, file: Blob) => {
    const form = new FormData();
    form.append('file', file, 'avatar');
    return call<PersonalContact>(`/api/contacts/personal/${encodeURIComponent(id)}/avatar`, { method: 'POST', body: form });
  },
  dropAvatar: (id: string) => call<PersonalContact>(`/api/contacts/personal/${encodeURIComponent(id)}/avatar`, { method: 'DELETE' }),
  remove: (id: string) => call<{ ok: boolean }>(`/api/contacts/personal/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  shares: (id: string) => call<PersonalShares>(`/api/contacts/personal/${encodeURIComponent(id)}/shares`),
  setShare: (id: string, target: { userId: string } | { departmentId: string }, role: ShareRole | null) =>
    call<PersonalShares>(`/api/contacts/personal/${encodeURIComponent(id)}/shares`, { method: 'PUT', json: { ...target, role } }),
};

export type PersonalPhase = 'idle' | 'loading' | 'ready' | 'error';

/** Личные контакты; грузятся, когда раздел включён (enabled), и обновляются при возврате на вкладку. */
export function usePersonalContacts(enabled: boolean) {
  const [contacts, setContacts] = useState<PersonalContact[]>([]);
  const [ready, setReady] = useState(true);
  const [phase, setPhase] = useState<PersonalPhase>('idle');
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try {
      const res = await personalApi.list();
      setContacts(res.contacts);
      setReady(res.ready);
      setPhase('ready');
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase((p) => (p === 'ready' ? p : 'error'));
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    setPhase((p) => (p === 'ready' ? p : 'loading'));
    void reload();
    const onVisible = () => { if (document.visibilityState === 'visible') void reload(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [enabled, reload]);

  return { contacts, ready, phase, error, reload, setContacts };
}
