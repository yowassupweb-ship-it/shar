import { create } from 'zustand';
import { isAppPath } from './routes';
import { navigate } from './navigate';

/**
 * Ссылки на сам Шар открываются внутри приложения, а не во внешнем браузере. Адрес в тексте — это «домен + путь»,
 * и домен у Шара меняется (рабочий, тестовый, локальный сервер Shar OS, прежний адрес): сохранённая когда-то ссылка
 * в таблице, заметке или чате не должна из-за этого уводить из окна. Поэтому ссылка считается «нашей» по пути
 * (раздел приложения или материал по токену), а домен — любой из семейства Шара или текущий.
 *
 * Ссылка на материал «Офиса» спрашивает, куда открыть (здесь, вместо того, что на экране, или в новом окне): у обычной ссылки
 * — при Ctrl/⌘+клике, у ссылок, которые открывает редактор документа или таблицы, — всегда.
 */
const SHAR_HOSTS = /(^|\.)shar-os\.ru$/i;
const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])$/i;
/** Материалы по ссылке без входа: /n/<токен>, /d/…, /t/…, /p/… (routes.tsx). */
const SHARED_PAGE = /^\/(n|d|t|p)\/[^/]+\/?$/;
/** Виды материалов, которые умеют жить в отдельном окне (desktop/electron/sticky-notes.cjs). */
const WINDOWED = new Set(['note', 'document', 'table']);

// Настоящий window.open — до подмены: «в новом окне» в браузере — это обычная новая вкладка.
const nativeOpen = typeof window === 'undefined' ? null : window.open.bind(window);

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

/** Материал «Офиса» по пути /office?kind=…&id=…; вида в ссылке может не быть. */
export function officeItemOf(path: string): { id: string; kind: string | null } | null {
  try {
    const url = new URL(path, window.location.origin);
    const id = url.searchParams.get('id');
    if (url.pathname !== '/office' || !id) return null;
    return { id, kind: url.searchParams.get('kind') };
  } catch { return null; }
}

/**
 * Куда вести ссылку на Шар. В основном окне — переход в нём (router по умолчанию); окно материала на рабочем столе
 * подставляет свой: простой клик открывает ссылку в главном окне, «здесь» — показывает материал в этом же окне.
 */
export interface LinkRouter { here: (path: string) => void; plain?: (path: string) => void }
let router: LinkRouter = { here: (path) => navigate(path) };
export function setLinkRouter(next: LinkRouter | null) { router = next ?? { here: (path) => navigate(path) }; }
/** Открыть здесь, вместо того, что на экране (для окна выбора и для обычного клика). */
export function openHere(path: string) { router.here(path); }

/** Куда спросили открыть ссылку (покажет LinkChooserHost). */
export const useLinkChooser = create<{ pending: { path: string; at: { x: number; y: number } } | null }>(() => ({ pending: null }));

let lastPointer = { x: 0, y: 0, ctrl: false };

/** Окно, в котором материал можно открыть отдельно, — только приложение для компьютера. */
const canWindow = () => Boolean(window.sharDesktop?.sticky);

/**
 * Открыть ссылку на Шар. choose — спросить («здесь» или «в новом окне»), если это материал, который умеет отдельное
 * окно. Вернёт false, если ссылка не наша (открывайте как обычную).
 */
export function openSharLink(raw: string, opts: { choose?: boolean; at?: { x: number; y: number } } = {}): boolean {
  const target = sharTarget(raw);
  if (!target) return false;
  const item = officeItemOf(target);
  if (opts.choose && item && (canWindow() ? (item.kind === null || WINDOWED.has(item.kind)) : true)) {
    useLinkChooser.setState({ pending: { path: target, at: opts.at ?? { x: lastPointer.x, y: lastPointer.y } } });
    return true;
  }
  (router.plain ?? router.here)(target);
  return true;
}

/** Материал по ссылке — в новом окне: окно Shar OS (документ, таблица, заметка) или новая вкладка в браузере. */
export async function openInNewWindow(path: string): Promise<void> {
  const item = officeItemOf(path);
  const sticky = window.sharDesktop?.sticky;
  if (item && sticky) {
    let kind = item.kind;
    if (!kind || !WINDOWED.has(kind)) {
      // В ссылке нет вида — узнаём у сервера, чтобы окно открылось нужного размера.
      try {
        const found = await fetch(`/api/workspace/items/${encodeURIComponent(item.id)}`, { cache: 'no-store' }).then((r) => r.json());
        kind = String(found?.item?.kind || '');
      } catch { kind = null; }
    }
    if (kind && WINDOWED.has(kind)) { await sticky.open(item.id, null, { kind }); return; }
    navigate(path);
    return;
  }
  nativeOpen?.(new URL(path, window.location.origin).toString(), '_blank', 'noopener');
}

/**
 * Включить для всего приложения: нажатие по ссылке (в том числе target=_blank) и window.open с адресом Шара —
 * переход внутри окна. Вызов вернёт отключение.
 */
export function installInternalLinks(): () => void {
  const onPointer = (event: PointerEvent) => { lastPointer = { x: event.clientX, y: event.clientY, ctrl: event.ctrlKey || event.metaKey }; };
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.shiftKey || event.altKey) return;
    const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!anchor || anchor.hasAttribute('download') || anchor.dataset.external !== undefined) return;
    const target = sharTarget(anchor.getAttribute('href'));
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    const withCtrl = event.ctrlKey || event.metaKey;
    openSharLink(target, { choose: withCtrl, at: { x: event.clientX, y: event.clientY } });
  };
  const open = window.open;
  window.open = function patched(this: Window, url?: string | URL, ...rest: [string?, string?]) {
    if (typeof url === 'string' || url instanceof URL) {
      // Ссылку на материал открывает редактор (кнопка «Открыть» у ссылки в документе, Ctrl+клик по ячейке таблицы) —
      // спрашиваем «куда»: здесь, вместо текущего, или в новом окне. Остальные ссылки на Шар идут сразу.
      if (openSharLink(String(url), { choose: true })) return null;
    }
    return open.call(this, url, ...rest);
  } as typeof window.open;
  document.addEventListener('pointerdown', onPointer, true);
  document.addEventListener('click', onClick, true);
  return () => {
    document.removeEventListener('pointerdown', onPointer, true);
    document.removeEventListener('click', onClick, true);
    if (window.open !== open) window.open = open;
  };
}
