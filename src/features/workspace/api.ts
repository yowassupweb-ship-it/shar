import type { Folder, Item, Kind, LinkEntry, SharedItem, SharesState, VersionRow, VersionsState, Viewer } from './types';

export class WorkspaceError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const headers: Record<string, string> = { ...(rest.headers as Record<string, string> | undefined) };
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store', ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body });
  } catch {
    throw new WorkspaceError(0, 'Нет связи с сервером');
  }
  if (!res.ok) {
    let message = res.statusText || String(res.status);
    try {
      const data = await res.json();
      message = data.detail || data.error || message;
    } catch { /* тело не JSON */ }
    // Общий «Not Found» без пояснения — это маршрут, которого на сервере нет: бэкенд старее клиента.
    // Осмысленные 404 («Материал не найден», «Ссылка не найдена…») приходят с собственным текстом.
    if ((res.status === 404 || res.status === 405) && (message === 'Not Found' || message === 'Method Not Allowed')) {
      message = 'На сервере ещё нет раздела «Офис» — нужно обновить бэкенд Шара.';
    }
    throw new WorkspaceError(res.status, typeof message === 'string' ? message : JSON.stringify(message));
  }
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

export interface SharedResult { mode: 'view' | 'edit'; item: SharedItem }

export const workspaceApi = {
  list: (kind: Kind | null, q = '', templates = false) => {
    const qs = new URLSearchParams();
    if (kind) qs.set('kind', kind);
    if (q.trim()) qs.set('q', q.trim());
    if (templates) qs.set('templates', '1');
    return call<{ items: Item[] }>(`/api/workspace/items?${qs}`).then((r) => r.items);
  },
  get: (id: string) => call<{ item: Item }>(`/api/workspace/items/${enc(id)}`).then((r) => r.item),
  create: (body: { kind: Kind; title?: string; content?: string; meta?: Record<string, unknown>; templateId?: string }) =>
    call<{ item: Item }>('/api/workspace/items', { method: 'POST', json: body }).then((r) => r.item),
  patch: (id: string, body: Record<string, unknown>) =>
    call<{ item: Item }>(`/api/workspace/items/${enc(id)}`, { method: 'PATCH', json: body }).then((r) => r.item),
  remove: (id: string) => call<{ ok: boolean }>(`/api/workspace/items/${enc(id)}`, { method: 'DELETE' }),

  folders: () => call<{ folders: Folder[] }>('/api/workspace/folders').then((r) => r.folders),
  createFolder: (title: string) => call<{ folder: Folder; folders: Folder[] }>('/api/workspace/folders', { method: 'POST', json: { title } }),
  renameFolder: (id: string, title: string) =>
    call<{ folders: Folder[] }>(`/api/workspace/folders/${enc(id)}`, { method: 'PATCH', json: { title } }).then((r) => r.folders),
  deleteFolder: (id: string) => call<{ folders: Folder[] }>(`/api/workspace/folders/${enc(id)}`, { method: 'DELETE' }).then((r) => r.folders),
  /** Положить материал в свою папку или вынуть (null). */
  placeItem: (id: string, folderId: string | null) =>
    call<{ folderId: string | null }>(`/api/workspace/items/${enc(id)}/folder`, { method: 'PUT', json: { folderId } }),

  shares: (id: string) => call<SharesState>(`/api/workspace/items/${enc(id)}/shares`),
  /** Выдать (или забрать, role = null) доступ человеку либо целому отделу. */
  setShare: (id: string, target: { userId: string } | { departmentId: string }, role: 'view' | 'edit' | null) =>
    call<SharesState>(`/api/workspace/items/${enc(id)}/shares`, { method: 'PUT', json: { ...target, role } }),
  links: (id: string) => call<{ links: LinkEntry[] }>(`/api/workspace/items/${enc(id)}/links`).then((r) => r.links),
  createLink: (id: string, mode: 'view' | 'edit', regenerate = false) =>
    call<{ link: LinkEntry; links: LinkEntry[] }>(`/api/workspace/items/${enc(id)}/links`, { method: 'POST', json: { mode, regenerate } }),
  revokeLink: (id: string, mode: 'view' | 'edit') =>
    call<{ links: LinkEntry[] }>(`/api/workspace/items/${enc(id)}/links/${mode}`, { method: 'DELETE' }).then((r) => r.links),

  versions: (id: string) => call<VersionsState>(`/api/workspace/items/${enc(id)}/versions`),
  version: (id: string, versionId: string) =>
    call<{ version: VersionRow & { content: string } }>(`/api/workspace/items/${enc(id)}/versions/${enc(versionId)}`).then((r) => r.version),
  /** Сохранить текущее состояние как версию (с названием или без). */
  saveVersion: (id: string, label: string) => call<VersionsState>(`/api/workspace/items/${enc(id)}/versions`, { method: 'POST', json: { label } }),
  restoreVersion: (id: string, versionId: string) =>
    call<{ item: Item }>(`/api/workspace/items/${enc(id)}/versions/${enc(versionId)}/restore`, { method: 'POST' }).then((r) => r.item),
  presence: (id: string, state: 'join' | 'beat' | 'leave', editing: boolean) =>
    call<{ viewers: Viewer[] }>(`/api/workspace/items/${enc(id)}/presence`, { method: 'POST', json: { state, editing } }),

  // По ссылке, без входа.
  shared: (token: string) => call<SharedResult>(`/api/share/workspace/${enc(token)}`),
  saveShared: (token: string, body: { title?: string; content?: string; baseUpdatedAt?: string }) =>
    call<SharedResult>(`/api/share/workspace/${enc(token)}`, { method: 'PATCH', json: body }),
};
