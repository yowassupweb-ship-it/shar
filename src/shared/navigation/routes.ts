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
  office: '/office',
  more: '/more',
  settings: '/settings',
  // Адреса инструментов совпадают со старыми — закладки и ссылки продолжают работать.
  admin: '/admin',
  utm: '/utm-generator',
  leads: '/site-leads',
  social: '/social',
  core: '/core',
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
  /** Событие календаря: день (YYYY-MM-DD) нужен, чтобы показать нужный период и открыть событие. */
  event: (eventId: string, day?: string) => `${paths.calendar}${q('event', eventId)}${day ? `&date=${encodeURIComponent(day)}` : ''}`,
  /** Письмо: ящик и папка, в которых оно лежит. */
  mail: (messageId: string, accountId?: string, folder?: string) =>
    `${paths.mail}${q('message', messageId)}${accountId ? `&account=${encodeURIComponent(accountId)}` : ''}${folder ? `&folder=${encodeURIComponent(folder)}` : ''}`,
  /** Раздел «Офис»: вид материалов (note | document | table | presentation) и/или открытый материал. */
  office: (kind?: string, id?: string) => {
    const qs = [kind ? `kind=${encodeURIComponent(kind)}` : '', id ? `id=${encodeURIComponent(id)}` : ''].filter(Boolean).join('&');
    return `${paths.office}${qs ? `?${qs}` : ''}`;
  },
};

/** Боевой адрес Шара. */
export const PUBLIC_ORIGIN = 'https://vokrug-sveta.shar-os.ru';

/**
 * Если ссылка ведёт в сам Шар (свой адрес или боевой, страница из `paths`), — путь внутри приложения, иначе null.
 * Такие ссылки из чата открываются на месте, а не в новой вкладке или внешнем браузере.
 */
export function internalPath(href: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const url = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin && url.origin !== PUBLIC_ORIGIN) return null;
    return (Object.values(paths) as string[]).includes(url.pathname) ? `${url.pathname}${url.search}${url.hash}` : null;
  } catch {
    return null;
  }
}

/**
 * Абсолютная ссылка — чтобы скопировать и отправить. В приложении для компьютера
 * интерфейс живёт на локальном 127.0.0.1:порт — ссылка с него никому, кроме
 * самого этого компьютера, не открылась бы, поэтому там берём боевой адрес.
 */
export const absolute = (path: string) => `${window.sharDesktop ? PUBLIC_ORIGIN : window.location.origin}${path}`;

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
