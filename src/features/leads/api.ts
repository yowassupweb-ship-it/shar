/**
 * Заявки с сайтов (corp/school.vs-travel.ru). Сайт передаёт заявку на сервер Шара, та ложится в
 * приложение «Заявки с сайта» и карточкой — в чат, выбранный для сайта. Здесь — запросы приложения
 * и действий карточки («Беру», «Готово», «Вернуть»).
 */

export type LeadStatus = 'new' | 'work' | 'done';

export interface LeadFields {
  name?: string; phone?: string; email?: string; comment?: string; date?: string; count?: string; where?: string;
  question?: string; contact?: string; organization?: string; tour?: string; text?: string;
}

export interface Lead {
  id: string;
  kind: 'callback' | 'question' | 'custom' | 'review';
  site: 'corp' | 'school';
  kindLabel: string;
  siteLabel: string;
  fields: LeadFields;
  tour: { id: string; title: string } | null;
  tours: string | null;
  page: string;
  pageName: string | null;
  createdAt: string;
  status: LeadStatus;
  assigneeId: string | null;
  assigneeName: string | null;
  chatId: string | null;
  messageId: string | null;
}

/** Карточка заявки в чате (metadata.card сообщения). */
export interface LeadCardData {
  kind: 'lead';
  leadId: string;
  type: string;
  site: string;
  title: string;
  phone?: string | null;
  email?: string | null;
  rows: [string, string][];
  links: { label: string; url: string }[];
  status: LeadStatus;
  assigneeId?: string | null;
  assigneeName?: string | null;
}

export interface LeadSettings {
  routes: Record<'corp' | 'school', string | null>;
  chats: Record<'corp' | 'school', { id: string; title?: string } | null>;
  sites: Record<'corp' | 'school', string>;
}

export const SITE_URLS: Record<Lead['site'], string> = { corp: 'https://corp.vs-travel.ru', school: 'https://school.vs-travel.ru' };

export const STATUS_LABEL: Record<LeadStatus, string> = { new: 'Новая', work: 'В работе', done: 'Закрыта' };

async function call<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    cache: 'no-store',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = String((await res.json())?.detail || ''); } catch { /* не JSON */ }
    throw new Error(detail || 'Не удалось — проверьте связь');
  }
  return (await res.json()) as T;
}

export function listLeads(filter: { status?: LeadStatus | ''; site?: Lead['site'] | ''; q?: string }) {
  const qs = new URLSearchParams();
  if (filter.status) qs.set('status', filter.status);
  if (filter.site) qs.set('site', filter.site);
  if (filter.q?.trim()) qs.set('q', filter.q.trim());
  return call<{ leads: Lead[]; counts: Record<LeadStatus, number> }>(`/api/leads?${qs}`);
}

export const changeLead = (id: string, change: { take?: boolean; status?: LeadStatus; assigneeId?: string | null }) =>
  call<{ lead: Lead }>(`/api/leads/${encodeURIComponent(id)}`, 'PATCH', change);

export const loadLeadSettings = () => call<LeadSettings>('/api/leads/settings');
export const saveLeadSettings = (routes: LeadSettings['routes']) => call<LeadSettings>('/api/leads/settings', 'PUT', { routes });
