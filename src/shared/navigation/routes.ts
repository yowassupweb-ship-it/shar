/**
 * Адреса Шара v2 — единственное место, где они записаны. Фичи строят ссылки
 * только через эти функции: переименование раздела не требует обхода кода.
 */

export const paths = {
  chats: '/chats',
  tasks: '/tasks',
  calendar: '/calendar',
  contacts: '/contacts',
  files: '/files',
  mail: '/mail',
  more: '/more',
  settings: '/settings',
  // Адреса инструментов совпадают со старыми — закладки и ссылки продолжают работать.
  admin: '/admin',
  utm: '/utm-generator',
  guide: '/how-to-shar',
  login: '/login',
} as const;

/** Адрес ведёт на страницу самого v2 (а не старого фронта). */
export const isAppPath = (href: string) => (Object.values(paths) as string[]).includes(href.split('?')[0]);

const q = (key: string, value: string) => `?${key}=${encodeURIComponent(value)}`;

export const links = {
  chat: (chatId: string) => `${paths.chats}${q('chat', chatId)}`,
  task: (taskId: string) => `${paths.tasks}${q('task', taskId)}`,
  file: (fileId: string) => `${paths.files}${q('file', fileId)}`,
  folder: (folderId: string) => `${paths.files}${q('folder', folderId)}`,
  contact: (userId: string) => `${paths.contacts}${q('user', userId)}`,
};

/** Публичный адрес Шара. В Electron интерфейс живёт на http://127.0.0.1:<порт> —
 *  ссылку с таким адресом никто, кроме автора, не откроет. */
const PUBLIC_ORIGIN = 'https://vokrug-sveta.shar-os.ru';

function publicOrigin(): string {
  const { origin, hostname } = window.location;
  const local = hostname === '127.0.0.1' || hostname === 'localhost';
  const desktop = Boolean((window as unknown as { sharDesktop?: unknown }).sharDesktop);
  return local && desktop ? PUBLIC_ORIGIN : origin;
}

/** Абсолютная ссылка — чтобы скопировать и отправить. */
export const absolute = (path: string) => `${publicOrigin()}${path}`;

/**
 * Адрес старого приложения (`/account?tab=…`, `/test-*-next`) → адрес v2.
 * Нужен для уведомлений и ссылок, которые сервер и Electron по-прежнему
 * присылают в старом формате. null — у v2 нет такого раздела.
 */
export function fromLegacyUrl(url: string): string | null {
  let u: URL;
  try { u = new URL(url, window.location.origin); } catch { return null; }
  const p = u.searchParams;
  if (p.get('chat')) return links.chat(p.get('chat')!);
  const byOldPath: Record<string, string> = {
    '/test-chat-next': paths.chats, '/test-tasks-next': paths.tasks, '/test-calendar-next': paths.calendar,
    '/test-contacts-next': paths.contacts, '/test-files-next': paths.files, '/test-mail-next': paths.mail,
    '/test-more-next': paths.more,
  };
  const byTab: Record<string, string> = {
    messages: paths.chats, tasks: paths.tasks, calendar: paths.calendar, contacts: paths.contacts,
    files: paths.files, mail: paths.mail, tools: paths.more,
  };
  const base = byOldPath[u.pathname] || (u.pathname === '/account' ? byTab[p.get('tab') || ''] : undefined)
    || (Object.values(paths) as string[]).find((x) => x === u.pathname);
  if (!base) return null;
  p.delete('tab');
  const rest = p.toString();
  return `${base}${rest ? `?${rest}` : ''}`;
}
