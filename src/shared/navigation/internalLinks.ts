import { isAppPath } from './routes';
import { navigate } from './navigate';

/**
 * Ссылки на сам Шар открываются внутри приложения, а не во внешнем браузере. Адрес в тексте — это «домен + путь»,
 * и домен у Шара меняется (рабочий, тестовый, локальный сервер Shar OS, прежний адрес): сохранённая когда-то ссылка
 * в таблице, заметке или чате не должна из-за этого уводить из окна. Поэтому ссылка считается «нашей» по пути
 * (раздел приложения или материал по токену), а домен — любой из семейства Шара или текущий.
 */
const SHAR_HOSTS = /(^|\.)shar-os\.ru$/i;
const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])$/i;
/** Материалы по ссылке без входа: /n/<токен>, /d/…, /t/…, /p/… (routes.tsx). */
const SHARED_PAGE = /^\/(n|d|t|p)\/[^/]+\/?$/;

/** Путь внутри приложения для ссылки на Шар (с запросом и якорем) или null, если ссылка чужая. */
export function sharTarget(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw, window.location.href); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const ours = url.origin === window.location.origin || SHAR_HOSTS.test(url.hostname) || LOCAL_HOSTS.test(url.hostname);
  if (!ours) return null;
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (!isAppPath(path) && !SHARED_PAGE.test(url.pathname)) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Включить для всего приложения: нажатие по ссылке (в том числе target=_blank) и window.open с адресом Шара —
 * переход внутри окна. Вызов вернёт отключение.
 */
export function installInternalLinks(): () => void {
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!anchor || anchor.hasAttribute('download') || anchor.dataset.external !== undefined) return;
    const target = sharTarget(anchor.getAttribute('href'));
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    navigate(target);
  };
  const nativeOpen = window.open;
  window.open = function open(this: Window, url?: string | URL, ...rest: [string?, string?]) {
    const target = typeof url === 'string' || url instanceof URL ? sharTarget(String(url)) : null;
    if (target) { navigate(target); return null; }
    return nativeOpen.call(this, url, ...rest);
  } as typeof window.open;
  document.addEventListener('click', onClick, true);
  return () => {
    document.removeEventListener('click', onClick, true);
    if (window.open !== nativeOpen) window.open = nativeOpen;
  };
}
