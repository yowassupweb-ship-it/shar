import type { Department } from '@/shared/types/user';
import { myId } from '@/shared/session/session';

export type { Department };

export interface AdminUser {
  id: string;
  name?: string;
  username?: string;
  email?: string;
  role: 'admin' | 'user';
  position?: string;
  department?: string;
  departmentIds?: string[];
  phone?: string;
  workSchedule?: string;
  enabledTools?: string[];
  canSeeAllTasks?: boolean;
  isDepartmentHead?: boolean;
  telegramId?: string;
  isDisabled?: boolean;
  avatar?: string;
  createdAt?: string;
}

export class ApiError extends Error {
  constructor(message: string, readonly status = 0) { super(message); }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store', credentials: 'include', ...init });
  } catch {
    throw new ApiError('Нет связи с сервером');
  }
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(String(data.error || data.detail || `Ошибка ${res.status}`), res.status);
  return data as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const enc = encodeURIComponent;

// ── Пользователи ───────────────────────────────────────────────────────────

/** С отключёнными — админ видит всех. Паролей сервер не отдаёт. */
export async function loadUsers(): Promise<AdminUser[]> {
  const data = await call<AdminUser[]>('/api/users?include_disabled=true');
  return Array.isArray(data) ? data.map((u) => ({ ...u, id: String(u.id) })) : [];
}

export async function loadMe(): Promise<AdminUser | null> {
  try { return await call<AdminUser>(`/api/users/${enc(myId())}`); } catch { return null; }
}

export type UserDraft = Omit<AdminUser, 'id' | 'createdAt'> & { password?: string };

export const createUser = (draft: UserDraft) => call<AdminUser>('/api/users', json('POST', draft));
export const updateUser = (id: string, patch: Partial<UserDraft>) => call<AdminUser>(`/api/users/${enc(id)}`, json('PUT', patch));
export const deleteUser = (id: string) => call(`/api/users/${enc(id)}`, { method: 'DELETE' });
export interface AdminSession { id: string; device?: string; userAgent?: string; ip?: string; createdAt?: number; lastSeenAt?: number }
export const loadUserSessions = async (id: string) =>
  (await call<{ devices?: AdminSession[] }>(`/api/admin/users/${enc(id)}/sessions`)).devices || [];
export const revokeUserSessions = (id: string) => call<{ revoked: number }>(`/api/admin/users/${enc(id)}/sessions`, { method: 'DELETE' });
/** Новый временный пароль — показывается один раз, в базе остаётся только хеш. */
export const resetUserPassword = (id: string) => call<{ password: string }>(`/api/admin/users/${enc(id)}/reset-password`, { method: 'POST' });
export const setUserTools = (id: string, enabledTools: string[]) => call(`/api/users/${enc(id)}`, json('PUT', { enabledTools }));

// ── Отделы ─────────────────────────────────────────────────────────────────

export async function loadDepartments(): Promise<Department[]> {
  const data = await call<{ departments?: Department[] }>('/api/departments');
  return Array.isArray(data.departments) ? data.departments.map((d) => ({ ...d, id: String(d.id), parentId: d.parentId ? String(d.parentId) : null })) : [];
}

export const createDepartment = (d: { name: string; color: string; parentId?: string }) => call<Department>('/api/departments', json('POST', d));
export const updateDepartment = (id: string, patch: { name?: string; color?: string }) => call(`/api/departments?id=${enc(id)}`, json('PUT', patch));
export const deleteDepartment = (id: string) => call(`/api/departments?id=${enc(id)}`, { method: 'DELETE' });

export async function loadRequestDepartments(): Promise<string[]> {
  const data = await call<{ departmentIds?: unknown[] }>('/api/request-departments');
  return Array.isArray(data.departmentIds) ? data.departmentIds.map(String) : [];
}

export async function saveRequestDepartments(ids: string[]): Promise<string[]> {
  const data = await call<{ departmentIds?: unknown[] }>('/api/request-departments', json('PUT', { departmentIds: ids }));
  return Array.isArray(data.departmentIds) ? data.departmentIds.map(String) : ids;
}

// ── Сервер ─────────────────────────────────────────────────────────────────

export interface SystemStatus {
  memory: { total: number; available: number; used: number; swapTotal: number; swapUsed: number };
  disk: { total: number; used: number; free: number };
  uptimeSeconds: number;
  loadAverage: number[];
  services: Record<string, string>;
  commit: string;
  journal: string;
  actions?: string[];
  database?: { kind?: string; name?: string; version?: string; sizeBytes?: number; connections?: number; topTables?: { name: string; rows: number }[]; error?: string };
  storage?: { enabled?: boolean; bucket?: string; endpoint?: string; region?: string; error?: string; localUploads?: { path: string; sizeBytes: number; files: number } };
  redis?: { connected?: boolean; version?: string; usedMemoryBytes?: number; clients?: number; uptimeDays?: number; error?: string };
  error?: string;
}

export const loadSystemStatus = () => call<SystemStatus>('/api/admin/system');
export const runSystemAction = (action: string) => call<{ output?: string; exitCode?: number }>(`/api/admin/system/${enc(action)}`, { method: 'POST' });

// ── Ошибки клиентов ────────────────────────────────────────────────────────

export interface ClientError {
  ts: string;
  kind: string;
  message: string;
  stack?: string | null;
  url?: string;
  userId?: string | null;
  userName?: string | null;
  userAgent?: string;
  appVersion?: string | null;
  extra?: Record<string, unknown> | null;
}

export async function loadClientErrors(): Promise<{ errors: ClientError[]; retentionDays: number }> {
  const data = await call<{ errors?: ClientError[]; retentionDays?: number }>('/api/admin/errors?limit=300');
  return { errors: Array.isArray(data.errors) ? data.errors : [], retentionDays: data.retentionDays || 3 };
}

export const clearClientErrors = () => call('/api/admin/errors', { method: 'DELETE' });

// ── Системные настройки ────────────────────────────────────────────────────

export interface SystemSettings {
  telegramBotToken: string;
  telegramBotTokenSet: boolean;
  telegramProxy: string;
  telegramProxySet: boolean;
  telegramChatId: string;
  telegramNotifications: boolean;
  errorNotification: boolean;
}

export const loadSystemSettings = () => call<SystemSettings>('/api/admin/settings');
/** Секреты: пустое значение — не менять, null — стереть. */
export const saveSystemSettings = (patch: Partial<Record<keyof SystemSettings, string | boolean | null>>) =>
  call<SystemSettings>('/api/admin/settings', json('PUT', patch));
export const testTelegram = () => call<{ ok: boolean }>('/api/admin/settings/test-telegram', { method: 'POST' });

// ── Обзор и журнал ─────────────────────────────────────────────────────────

export interface Overview {
  users: { total: number; active: number; disabled: number; admins: number; online: number; withoutPassword: number; legacyPasswords: number };
  chats: { total: number; messagesDay: number; messagesWeek: number };
  tasks: { open: number; total: number };
  departments: number;
  mailAccounts: number;
  pushDevices: number;
}
export const loadOverview = () => call<Overview>('/api/admin/overview');

export interface AuditEntry { id: number; at: string; actorName?: string; action: string; target?: string | null; details: Record<string, unknown> }
export const loadAudit = async () => (await call<{ entries?: AuditEntry[] }>('/api/admin/audit?limit=200')).entries || [];

// ── Письма → чат ───────────────────────────────────────────────────────────

export interface EmailRule { id: string; emailPattern: string; chatId: string; chatTitle?: string; description?: string; keyword?: string }
export interface ChatOption { id: string; title: string }

export async function loadEmailRules(): Promise<EmailRule[]> {
  const data = await call<EmailRule[]>('/api/email-chat-rules');
  return Array.isArray(data) ? data : [];
}

export async function loadChatOptions(): Promise<ChatOption[]> {
  const data = await call<Record<string, unknown>[]>('/api/chats');
  return (Array.isArray(data) ? data : [])
    .filter((c) => !c.isFavoritesChat && !c.isNotificationsChat)
    .map((c) => ({ id: String(c.id), title: String(c.title || c.displayTitle || c.id) }));
}

export const addEmailRule = (r: { emailPattern: string; chatId: string; description: string; keyword: string }) =>
  call<EmailRule>('/api/email-chat-rules', json('POST', r));
export const deleteEmailRule = (id: string) => call(`/api/email-chat-rules/${enc(id)}`, { method: 'DELETE' });

// ── Форматирование ─────────────────────────────────────────────────────────

export function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null || bytes < 0) return '—';
  if (bytes === 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function timeAgo(ts: string | number): string {
  const t = typeof ts === 'number' ? ts : new Date(ts).getTime();
  if (Number.isNaN(t)) return '';
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return 'только что';
  if (m < 60) return `${m} мин назад`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.floor(h / 24)} дн назад`;
}
