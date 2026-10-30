/**
 * Данные раздела «Файлы»: облако пользователя (папки и файлы), вложения
 * чатов и списки ссылок. Те же эндпоинты, что у старого FilesBoard, — данные
 * общие, новая страница их только показывает иначе.
 *
 * Содержимое папок держим в памяти между переходами: «назад» по папкам и
 * возврат в раздел — мгновенные, сеть только сверяет.
 */

export interface CloudFolder {
  id: string;
  name: string;
  parentId: string | null;
  ownerId: string;
  sharedWith?: string[];
  editAccess?: string[];
  createdAt: string;
  updatedAt: string;
  isPinned?: boolean;
  sortOrder?: number;
  color?: string | null;
  fileCount?: number;
  previewFiles?: { url: string; fileType: string; name: string }[];
}

export interface CloudFile {
  id: string;
  name: string;
  folderId: string | null;
  ownerId: string;
  url: string;
  size: number;
  mimeType?: string;
  fileType: string;
  sharedWith?: string[];
  editAccess?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ChatFolder {
  chatId: string;
  chatName: string;
  count: number;
  lastAt: string | null;
  isGroup?: boolean;
  chatAvatar?: string | null;
}

export interface ChatAttachment {
  messageId: string;
  chatId: string;
  authorId: string;
  authorName: string;
  chatName: string;
  url: string;
  filename: string;
  fileType: string;
  mimeType?: string;
  size: number | null;
  createdAt: string;
}

export type Kind = 'image' | 'video' | 'audio' | 'doc' | 'sheet' | 'slides' | 'pdf' | 'archive' | 'code' | 'file';

/** id вошедшего пользователя — единый источник: shared/session. */
export { myId } from '@/shared/session/session';
import { myId } from '@/shared/session/session';

/** Адрес вложения — через прокси загрузок, как в ленте чата. */
export function fileUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith('/api/') || url.startsWith('blob:') || url.startsWith('data:')) return url;
  const m = url.match(/\/uploads\/([^?#]+)/i);
  return m ? `/api/uploads/${m[1]}` : url;
}

export function kindOf(name: string, fileType?: string, mime?: string): Kind {
  const t = (fileType || '').toLowerCase();
  const m = (mime || '').toLowerCase();
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (t === 'image' || m.startsWith('image/') || /^(png|jpe?g|gif|webp|avif|heic|bmp|svg)$/.test(ext)) return 'image';
  if (t === 'video' || m.startsWith('video/') || /^(mp4|mov|webm|mkv|avi)$/.test(ext)) return 'video';
  if (m.startsWith('audio/') || /^(mp3|wav|ogg|m4a|aac|flac|opus)$/.test(ext)) return 'audio';
  if (ext === 'pdf' || m === 'application/pdf') return 'pdf';
  if (/^(xlsx?|csv|ods|numbers)$/.test(ext)) return 'sheet';
  if (/^(pptx?|odp|key)$/.test(ext)) return 'slides';
  if (/^(docx?|odt|rtf|txt|md|pages)$/.test(ext)) return 'doc';
  if (/^(zip|rar|7z|tar|gz)$/.test(ext)) return 'archive';
  if (/^(js|ts|tsx|jsx|py|json|html|css|sql|sh|yml|yaml|xml)$/.test(ext)) return 'code';
  return 'file';
}

export function fmtBytes(b?: number | null): string {
  if (!b) return '';
  if (b < 1024) return `${b} Б`;
  if (b < 1048576) return `${(b / 1024).toFixed(0)} КБ`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} МБ`;
  return `${(b / 1073741824).toFixed(1)} ГБ`;
}

const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
export function fmtDate(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : dateFmt.format(d);
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as T;
}

// ── Облако ──────────────────────────────────────────────────────────────────

const folderCache = new Map<string, { folders: CloudFolder[]; files: CloudFile[] }>();
const ROOT = '__root__';

export function cachedFolder(folderId: string | null) {
  return folderCache.get(folderId || ROOT) || null;
}

const byPinOrderName = (a: CloudFolder, b: CloudFolder) =>
  Number(Boolean(b.isPinned)) - Number(Boolean(a.isPinned))
  || (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
  || a.name.localeCompare(b.name, 'ru')
  || a.id.localeCompare(b.id);

export async function loadFolder(folderId: string | null) {
  const uid = myId();
  const q = folderId ? `&parentId=${encodeURIComponent(folderId)}` : '';
  const qf = folderId ? `&folderId=${encodeURIComponent(folderId)}` : '';
  const [folders, files] = await Promise.all([
    fetch(`/api/cloud/folders?userId=${encodeURIComponent(uid)}${q}`, { cache: 'no-store' }).then((r) => json<CloudFolder[]>(r)),
    fetch(`/api/cloud/files?userId=${encodeURIComponent(uid)}${qf}`, { cache: 'no-store' }).then((r) => json<CloudFile[]>(r)),
  ]);
  const data = {
    folders: (Array.isArray(folders) ? folders : []).sort(byPinOrderName),
    files: (Array.isArray(files) ? files : []).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)),
  };
  folderCache.set(folderId || ROOT, data);
  return data;
}

export function patchFolderCache(folderId: string | null, fn: (d: { folders: CloudFolder[]; files: CloudFile[] }) => { folders: CloudFolder[]; files: CloudFile[] }) {
  const key = folderId || ROOT;
  const cur = folderCache.get(key);
  if (cur) folderCache.set(key, fn(cur));
}

export async function getFolder(id: string): Promise<CloudFolder | null> {
  try { return await json<CloudFolder>(await fetch(`/api/cloud/folders/${encodeURIComponent(id)}`, { cache: 'no-store' })); } catch { return null; }
}

export async function getFile(id: string): Promise<CloudFile | null> {
  try { return await json<CloudFile>(await fetch(`/api/cloud/files/${encodeURIComponent(id)}`, { cache: 'no-store' })); } catch { return null; }
}

/** Цепочка папок от корня до id — для хлебных крошек при открытии по ссылке. */
export async function folderChain(id: string): Promise<CloudFolder[]> {
  const chain: CloudFolder[] = [];
  let cur: string | null = id;
  for (let i = 0; cur && i < 12; i++) {
    const f = await getFolder(cur);
    if (!f) break;
    chain.unshift(f);
    cur = f.parentId;
  }
  return chain;
}

const q = () => `userId=${encodeURIComponent(myId())}`;
const put = (url: string, body: unknown) => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export async function createFolder(name: string, parentId: string | null): Promise<CloudFolder> {
  return json<CloudFolder>(await fetch(`/api/cloud/folders?${q()}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, parentId }),
  }));
}

export async function renameItem(kind: 'file' | 'folder', id: string, name: string) {
  const res = await put(`/api/cloud/${kind === 'file' ? 'files' : 'folders'}/${encodeURIComponent(id)}?${q()}`, { name });
  if (!res.ok) throw new Error(String(res.status));
}

export async function deleteItem(kind: 'file' | 'folder', id: string) {
  const res = await fetch(`/api/cloud/${kind === 'file' ? 'files' : 'folders'}/${encodeURIComponent(id)}?${q()}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(String(res.status));
}

export async function moveFile(id: string, folderId: string | null) {
  const res = await put(`/api/cloud/files/${encodeURIComponent(id)}?${q()}`, { folderId, moveToRoot: folderId === null });
  if (!res.ok) throw new Error(String(res.status));
}

export async function moveFolder(id: string, parentId: string | null) {
  const res = await put(`/api/cloud/folders/${encodeURIComponent(id)}?${q()}`, { parentId });
  if (!res.ok) throw new Error(String(res.status));
}

export async function setFolderColor(id: string, color: string | null) {
  await put(`/api/cloud/folders/${encodeURIComponent(id)}?${q()}`, { color }).catch(() => {});
}

export async function pinFolder(id: string, pinned: boolean) {
  await fetch(`/api/cloud/folders/${encodeURIComponent(id)}/pin?${q()}&pinned=${pinned}`, { method: 'PATCH' }).catch(() => {});
}

export async function saveAccess(kind: 'file' | 'folder', id: string, sharedWith: string[], editAccess: string[]) {
  const res = await put(`/api/cloud/${kind === 'file' ? 'files' : 'folders'}/${encodeURIComponent(id)}/access?${q()}`, { sharedWith, editAccess });
  if (!res.ok) throw new Error(String(res.status));
}

export async function registerUpload(file: File, uploaded: { url: string; key?: string; size?: number }, folderId: string | null): Promise<CloudFile> {
  const k = kindOf(file.name, '', file.type);
  return json<CloudFile>(await fetch(`/api/cloud/files?${q()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: file.name, url: uploaded.url, s3Key: uploaded.key, size: uploaded.size || file.size,
      mimeType: file.type, fileType: k === 'image' || k === 'video' ? k : 'file', folderId,
    }),
  }));
}

// ── Из чатов ────────────────────────────────────────────────────────────────

let chatFoldersCache: ChatFolder[] | null = null;
export const cachedChatFolders = () => chatFoldersCache;

export async function loadChatFolders(): Promise<ChatFolder[]> {
  const list = await json<ChatFolder[]>(await fetch(`/api/cloud/chat-folders?${q()}`, { cache: 'no-store' }));
  chatFoldersCache = (Array.isArray(list) ? list : [])
    .sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')) || a.chatId.localeCompare(b.chatId));
  return chatFoldersCache;
}

const chatFilesCache = new Map<string, ChatAttachment[]>();
export const cachedChatFiles = (chatId: string) => chatFilesCache.get(chatId) || null;

export async function loadChatFiles(chatId: string): Promise<ChatAttachment[]> {
  const list = await json<ChatAttachment[]>(await fetch(`/api/cloud/attachments?${q()}&chatId=${encodeURIComponent(chatId)}&limit=500`, { cache: 'no-store' }));
  const out = (Array.isArray(list) ? list : []).filter((a) => a.fileType !== 'link')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  chatFilesCache.set(chatId, out);
  return out;
}


// ── Отправка в чат ──────────────────────────────────────────────────────────

/** Карточка файла или папки в чате — формат старого FilesBoard (isSharedItem),
 *  плюс itemId: карточка в новом чате открывает файл прямо в разделе. */
export async function shareToChat(chatId: string, item: { id: string; name: string; url: string; fileType: string; isFolder?: boolean; preview?: string }) {
  const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      authorId: myId(),
      content: item.name,
      mentions: [],
      metadata: {
        isSharedItem: true,
        itemId: item.id,
        sharedFileUrl: item.url,
        sharedFileName: item.name,
        sharedFileType: item.isFolder ? 'folder' : item.fileType || 'file',
        sharedFilePreview: item.preview || null,
      },
    }),
  });
  if (!res.ok) throw new Error(String(res.status));
}

// ── Источники для «Из чатов» и «Агенты»: одинаковый вид, разные данные ─────────────────────────────

/** Откуда раздел берёт папки-чаты и их вложения: переписки Шара или чаты с агентами «Ядра». */
export interface FilesSource {
  loadFolders: () => Promise<ChatFolder[]>;
  cachedFolders: () => ChatFolder[] | null;
  loadFiles: (chatId: string) => Promise<ChatAttachment[]>;
  cachedFiles: (chatId: string) => ChatAttachment[] | null;
  /** «Показать в чате». */
  openChat: (chatId: string) => void;
  emptyTitle: string;
  emptyText: string;
  /** Значок вместо аватара чата. */
  icon?: import('react').ReactNode;
}

export const CHAT_SOURCE: FilesSource = {
  loadFolders: loadChatFolders,
  cachedFolders: cachedChatFolders,
  loadFiles: loadChatFiles,
  cachedFiles: cachedChatFiles,
  openChat: (chatId) => { window.dispatchEvent(new CustomEvent('nx:open-chat', { detail: chatId })); },
  emptyTitle: 'В чатах пока нет файлов',
  emptyText: 'Здесь соберутся фото и документы, которые присылали в переписках.',
};

let agentFoldersCache: ChatFolder[] | null = null;
const agentFilesCache = new Map<string, ChatAttachment[]>();

/** Чаты «Ядра» с вложениями: что прислал человек и что сделали агенты (картинки). */
export async function loadAgentFolders(): Promise<ChatFolder[]> {
  const list = await json<ChatFolder[]>(await fetch('/api/core/files/chats', { cache: 'no-store' }));
  agentFoldersCache = Array.isArray(list) ? list : [];
  return agentFoldersCache;
}

export async function loadAgentFiles(threadId: string): Promise<ChatAttachment[]> {
  const list = await json<ChatAttachment[]>(await fetch(`/api/core/files?threadId=${encodeURIComponent(threadId)}`, { cache: 'no-store' }));
  const out = Array.isArray(list) ? list : [];
  agentFilesCache.set(threadId, out);
  return out;
}

export const AGENT_SOURCE: Omit<FilesSource, 'icon' | 'openChat'> = {
  loadFolders: loadAgentFolders,
  cachedFolders: () => agentFoldersCache,
  loadFiles: loadAgentFiles,
  cachedFiles: (id) => agentFilesCache.get(id) || null,
  emptyTitle: 'У агентов пока нет файлов',
  emptyText: 'Здесь соберутся вложения из чатов «Ядра» и всё, что сделали агенты, — например, картинки.',
};
