import type { User } from '@/shared/types/chat';
import { myId, patchCachedMe } from '@/shared/session/session';
import { useChatStore } from '@/features/chat';

/** Профиль как его отдаёт /api/users/{id} — с полями, которых нет в User. */
export type Profile = User & {
  username?: string;
  email?: string;
  phone?: string;
  personalPhone?: string;
  workSchedule?: string;
  position?: string;
  department?: string;
  visibleTabs?: Record<string, boolean>;
  visible_tabs?: Record<string, boolean>;
  chatSettings?: Record<string, unknown>;
};

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
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string; detail?: string }).error || (data as { detail?: string }).detail || `Ошибка ${res.status}`, res.status);
  return data as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const userUrl = () => `/api/users/${encodeURIComponent(myId())}`;

/** Профиль в справочнике людей и в кэше сессии — чтобы аватар и имя сменились везде сразу. */
function spread(profile: Partial<Profile>) {
  const id = myId();
  if (!id) return;
  useChatStore.setState((s) => ({ users: { ...s.users, [id]: { ...(s.users[id] || {}), ...profile } as User } }));
  patchCachedMe({ name: profile.name, avatar: profile.avatar } as Partial<User>);
}

export async function loadProfile(): Promise<Profile> {
  const p = await call<Profile>(userUrl());
  if (!p.visibleTabs && p.visible_tabs) p.visibleTabs = p.visible_tabs;
  return p;
}

export type ProfileFields = Pick<Profile, 'personalPhone' | 'phone' | 'workSchedule' | 'position' | 'department'>;

export async function saveProfile(fields: ProfileFields): Promise<Profile> {
  const p = await call<Profile>(userUrl(), json('PUT', fields));
  spread(p);
  return p;
}

export async function changePassword(password: string): Promise<void> {
  await call(userUrl(), json('PUT', { password }));
}

export async function uploadAvatar(file: File): Promise<string> {
  const form = new FormData();
  form.append('file', file);
  form.append('userId', myId());
  const { avatarUrl } = await call<{ avatarUrl: string }>('/api/avatars', { method: 'POST', body: form });
  spread({ avatar: avatarUrl });
  return avatarUrl;
}

export async function removeAvatar(): Promise<void> {
  await call(`/api/avatars?userId=${encodeURIComponent(myId())}`, { method: 'DELETE' });
  spread({ avatar: '' });
}

export async function saveVisibleTabs(visibleTabs: Record<string, boolean>): Promise<void> {
  try {
    await call(`${userUrl()}/navigation`, json('PUT', { visibleTabs }));
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 404) throw e;
    await call(userUrl(), json('PUT', { visibleTabs }));
  }
  spread({ visibleTabs } as Partial<Profile>);
}

// ── Устройства (серверные сессии) ──────────────────────────────────────────

export interface Device {
  id: string;
  device: string;
  userAgent: string;
  ip: string;
  createdAt: number;
  lastSeenAt: number;
  current: boolean;
}

export async function loadDevices(): Promise<Device[]> {
  const data = await call<{ devices?: Device[] }>('/api/auth/devices');
  return Array.isArray(data.devices) ? data.devices : [];
}

export const revokeDevice = (id: string) => call(`/api/auth/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const revokeOtherDevices = () => call('/api/auth/devices/revoke-others', { method: 'POST' });

// ── Ключи MCP ───────────────────────────────────────────────────────────────

/** Личный ключ MCP: самого ключа сервер не хранит и не отдаёт — только начало для узнавания. */
export interface McpKey { id: string; name: string; start: string; createdAt: string; lastUsedAt: string | null }

export const loadMcpKeys = () => call<{ keys: McpKey[] }>('/api/mcp/keys').then((r) => r.keys);
export const createMcpKey = (name: string) => call<{ key: McpKey; token: string }>('/api/mcp/keys', json('POST', { name }));
export const revokeMcpKey = (id: string) => call(`/api/mcp/keys/${encodeURIComponent(id)}`, { method: 'DELETE' });

// ── Пуши ───────────────────────────────────────────────────────────────────

export async function loadReactionPush(): Promise<boolean | null> {
  try {
    const p = await call<{ reactions?: boolean }>(`/api/push/prefs?userId=${encodeURIComponent(myId())}`);
    return typeof p.reactions === 'boolean' ? p.reactions : null;
  } catch { return null; }
}

export const saveReactionPush = (reactions: boolean) =>
  call('/api/push/prefs', json('POST', { userId: myId(), reactions }));

export const sendTestPush = () =>
  call<Record<string, unknown>>('/api/push/test', json('POST', {
    userId: myId(), title: 'Проверка Шара', body: 'Серверные уведомления работают', url: '/settings',
  }));

// ── Фоны и узоры переписки (картинки лежат на сервере) ─────────────────────

export interface ChatAsset { name: string; url: string; thumbnailUrl?: string }
export type ChatAssets = Record<'light' | 'dark', { backgrounds: ChatAsset[]; overlays: ChatAsset[] }>;

const assetName = (file: string) => file.replace(/\.[a-z0-9]+$/i, '').replace(/^(Gradient|Theme)=/i, '').trim();

export async function loadChatAssets(): Promise<ChatAssets> {
  const raw = await call<Partial<Record<'light' | 'dark', { backgrounds?: ChatAsset[]; overlays?: ChatAsset[] }>>>('/api/chat-backgrounds');
  const pick = (list?: ChatAsset[]) =>
    (Array.isArray(list) ? list : []).filter((a) => a?.url).map((a) => ({
      name: assetName(a.name || ''),
      url: a.url,
      thumbnailUrl: a.thumbnailUrl,
    }));
  return {
    light: { backgrounds: pick(raw.light?.backgrounds), overlays: pick(raw.light?.overlays) },
    dark: { backgrounds: pick(raw.dark?.backgrounds), overlays: pick(raw.dark?.overlays) },
  };
}
