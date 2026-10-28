import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { ChevronsDownUp, ChevronsUpDown, Folder as FolderIcon, FolderInput, FolderMinus, FolderPlus, FolderUp, Globe2, UserPlus, LayoutGrid, Lock, MonitorUp, PanelLeftClose, PanelLeftOpen, Pencil, Pin, Plus, Send, Trash2, Upload, Users } from 'lucide-react';
import { useShellOptions } from '@/shared/shell/ShellContext';
import { realtime } from '@/shared/realtime/realtime';
import { SearchField } from '@/shared/ui/SearchField';
import Splitter from '@/shared/ui/Splitter';
import { askConfirm, Menu, MenuItem, type MenuAnchor } from '@/shared/ui/overlay';
import { SendToChatSheet } from './SendToChatSheet';
import { showToast } from '@/shared/ui/Toast';
import { myId } from '@/shared/session/session';
import { useLongPress } from '@/shared/ui/useLongPress';
import { workspaceApi } from './api';
import { initialContent, ItemView } from './ItemView';
import { KIND_LIST, KINDS } from './kinds';
import { IMPORT_RULES, importFile } from './lib/importFile';
import { Highlight, matchesAll, searchTerms } from './lib/highlight';
import { isWorkspaceEvent } from './live';
import { readPlace, writePlace } from './lib/officeMemory';
import { canSticky, dragNoteOut, forgetSticky, openSticky, stickyLabel } from './lib/sticky';
import type { Folder, Item, Kind, Viewer } from './types';
import { FOLDER_DRAG, FolderRow, isFolderDrag, isItemDrag, ITEM_DRAG, zoneOf, type DropZone } from './Folders';
import { PresenceStack } from './PresenceStack';
import { FolderShareDialog } from './FolderShareDialog';
import { useDragAutoScroll, useFlip } from './lib/listMotion';

const OPEN_FOLDERS_KEY = 'shar.office.open-folders';
function readOpenFolders(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(OPEN_FOLDERS_KEY) || '[]') as string[]); } catch { return new Set(); }
}
function writeOpenFolders(ids: Set<string>) {
  try { localStorage.setItem(OPEN_FOLDERS_KEY, JSON.stringify([...ids])); } catch { /* приватный режим */ }
}
import { Spinner } from '@/shared/ui/Spinner';
import './workspace.css';

/**
 * «Офис» — заметки, документы, таблицы и презентации в одном месте. Слева список (поиск, виды,
 * закреплённое сверху), справа открытый материал. Адрес — источник правды: ?kind=&id=, ссылкой можно
 * поделиться, «назад» работает. На телефоне список и материал — два экрана.
 */

const NARROW = '(max-width: 899px)';
const LIST_FOLDED_KEY = 'nx:office-list-folded';
const subscribeMedia = (cb: () => void) => {
  const mq = window.matchMedia(NARROW);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
};

function since(iso: string): string {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} ч`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} дн`;
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

/** Строка списка — без Markdown-разметки: сервер отдаёт начало текста заметки как есть, с #, **, | и ссылками. */
function plainSnippet(text: string) {
  return text
    .replace(/<!-- shar-tab: (.*?) -->/g, ' $1: ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(^|\s)(?:[-*+] \[[ xX]\]|#{1,6}|>|[-*+]|\d+[.)])\s+/g, '$1')
    .replace(/\|?\s*:?-{3,}:?\s*(?=\||$)/g, ' ')
    .replace(/\s*\|\s*/g, ' · ')
    .replace(/(\*\*|__|~~|`+)/g, '')
    .replace(/(^|[\s(])[*_](\S)/g, '$1$2')
    .replace(/(\S)[*_](?=[\s.,;:!?)]|$)/g, '$1')
    .replace(/(?:\s*·\s*)+/g, ' · ')
    .replace(/^\s*·\s*|\s*·\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function ItemRow({ item, active, terms, snippet, onOpen, onMenu }: {
  item: Item; active: boolean;
  /** Поиск: слова для подсветки и кусок текста у совпадения (вместо начала материала). */
  terms?: string[]; snippet?: string;
  onOpen: () => void; onMenu: (anchor: MenuAnchor) => void;
}) {
  const info = KINDS[item.kind];
  const press = useLongPress((x, y) => onMenu({ x, y }));
  const AccessIcon = item.accessLevel === 'all' ? Globe2 : Lock;
  const mine = item.ownerId === myId();
  return (
    <button
      type="button"
      className="nws-row"
      data-flip={`i${item.id}`}
      aria-current={active ? 'true' : undefined}
      data-color={item.kind === 'note' ? item.meta.color || undefined : undefined}
      onClick={onOpen}
      // Заметку можно вытащить за пределы окна — она станет окном на рабочем столе (только в приложении для компьютера).
      // Строку можно перетащить в папку; заметку — ещё и за пределы окна: она станет окном на рабочем столе.
      draggable
      onDragStart={(e) => { e.dataTransfer.setData(ITEM_DRAG, item.id); e.dataTransfer.setData('text/plain', item.title || info.untitled); e.dataTransfer.effectAllowed = 'copyMove'; }}
      onDragEnd={(e) => { if (canSticky(item.kind)) dragNoteOut(e, item.id, item.kind); }}
      onContextMenu={(e) => { e.preventDefault(); onMenu({ x: e.clientX, y: e.clientY }); }}
      {...press}
    >
      <span className="nws-kind-icon" style={{ '--a': info.tint[0], '--b': info.tint[1] } as React.CSSProperties} aria-hidden="true"><info.icon size={16} /></span>
      <span className="nws-row-text">
        <span className="nws-row-title">{item.isNew && <span className="nws-new">Новое</span>}<Highlight text={item.title || info.untitled} terms={terms ?? []} /></span>
        <span className="nws-row-snippet" data-hit={snippet ? 'true' : undefined}>
          <Highlight text={item.kind === 'note' ? plainSnippet(snippet || item.snippet) : (snippet || item.snippet)} terms={terms ?? []} />
        </span>
      </span>
      {item.viewers && item.viewers.length > 0 && <span className="nws-row-presence"><PresenceStack viewers={item.viewers} size={20} /></span>}
      <span className="nws-row-meta">
        <span>{since(item.updatedAt)}</span>
        <span className="nws-row-flags">
          {item.pinned && <Pin size={11} aria-label="Закреплено" />}
          {!mine ? <Users size={11} aria-label={`Владелец: ${item.ownerName}`} /> : <AccessIcon size={11} aria-label={item.accessLevel === 'all' ? 'Видят все' : 'Личное'} />}
        </span>
      </span>
    </button>
  );
}

export default function OfficeScreen() {
  const [params, setParams] = useSearchParams();
  // Вернулись в «Офис» из другого раздела без адреса — открываем там, где были (вид, материал, поиск).
  const place = useRef(readPlace());
  const restored = useRef(false);
  const kindParam = params.get('kind');
  const filter: Kind | 'all' = kindParam && kindParam in KINDS ? (kindParam as Kind) : 'all';
  const openId = params.get('id');
  const narrow = useSyncExternalStore(subscribeMedia, () => window.matchMedia(NARROW).matches, () => false);

  // Список материалов можно убрать (крупный масштаб, широкая таблица): остаётся узкая полоска с «развернуть» и
  // «создать». Положение помнится; Ctrl+\ — свернуть или развернуть. На телефоне список и материал и так раздельно.
  const [listFolded, setListFolded] = useState(() => { try { return localStorage.getItem(LIST_FOLDED_KEY) === '1'; } catch { return false; } });
  const toggleList = useCallback(() => setListFolded((was) => {
    try { localStorage.setItem(LIST_FOLDED_KEY, was ? '0' : '1'); } catch { /* приватное окно — просто не запомним */ }
    return !was;
  }), []);
  const folded = listFolded && !narrow;
  useEffect(() => {
    // Холсты документа и таблицы пересчитывают размер по resize окна — сообщаем, когда ширина доехала.
    const timer = window.setTimeout(() => window.dispatchEvent(new Event('resize')), 300);
    return () => window.clearTimeout(timer);
  }, [folded]);
  useEffect(() => {
    if (narrow) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.code === 'Backslash') { event.preventDefault(); toggleList(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [narrow, toggleList]);

  // Грузим все виды разом: разделы — фильтр по одному списку, и переключение между ними не ждёт сервера.
  const [allItems, setItems] = useState<Item[] | null>(null);
  const items = useMemo(() => (allItems && filter !== 'all' ? allItems.filter((i) => i.kind === filter) : allItems), [allItems, filter]);
  const [error, setError] = useState('');
  const [query, setQuery] = useState(() => (!new URLSearchParams(window.location.search).toString() ? place.current?.query ?? '' : ''));
  const [busy, setBusy] = useState('');
  const [create, setCreate] = useState<MenuAnchor | null>(null);
  const [rowMenu, setRowMenu] = useState<{ item: Item; anchor: MenuAnchor } | null>(null);
  // Папки — личные. Какие раскрыты, помним на этом устройстве.
  const [folders, setFolders] = useState<Folder[]>([]);
  const [openFolders, setOpenFolders] = useState<Set<string>>(readOpenFolders);
  const [editingFolder, setEditingFolder] = useState<string | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ folder: Folder; anchor: MenuAnchor } | null>(null);
  const [moveMenu, setMoveMenu] = useState<{ item: Item; anchor: MenuAnchor } | null>(null);
  const [shareFolder, setShareFolder] = useState<Folder | null>(null);
  const [rootOver, setRootOver] = useState(false);
  const [sendItem, setSendItem] = useState<Item | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const reqId = useRef(0);
  const layoutRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const saved = place.current;
    if (saved?.search && !params.toString()) setParams(new URLSearchParams(saved.search), { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Список вернулся — прокручиваем туда, где остановились (один раз).
  const scrolled = useRef(false);
  useEffect(() => {
    if (scrolled.current || items === null) return;
    scrolled.current = true;
    const top = place.current?.listScroll;
    if (top && rowsRef.current) rowsRef.current.scrollTop = top;
  }, [items]);

  // Запоминаем место при каждой смене адреса и поиска; прокрутку списка — при уходе из раздела.
  useEffect(() => {
    if (!restored.current) return;
    writePlace({ search: params.toString(), query });
  }, [params, query]);
  useEffect(() => () => {
    writePlace({ listScroll: rowsRef.current?.scrollTop ?? 0 });
  }, []);

  // На телефоне открытый материал занимает весь экран: капсулу меню убираем.
  useShellOptions({ navHidden: narrow && Boolean(openId), onReselect: () => setParams(filter === 'all' ? {} : { kind: filter }) });

  const load = useCallback(async () => {
    const mine = ++reqId.current;
    try {
      // Папки грузим вместе со списком; старый сервер без папок — просто без них.
      const [list, folderList] = await Promise.all([workspaceApi.list(null, '', false, 1000), workspaceApi.folders().catch(() => null)]);
      if (mine !== reqId.current) return;
      setItems(list);
      if (folderList) setFolders(folderList);
      setError('');
    } catch (cause) {
      if (mine === reqId.current) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Поиск — поверх полного списка: сервер отдаёт найденное по порядку (лучшее — выше) с куском текста у совпадения,
  // а дерево папок остаётся на месте — в нём видно только найденное. Пока печатают, список не пропадает.
  const terms = useMemo(() => searchTerms(query), [query]);
  const [hits, setHits] = useState<{ order: Map<string, number>; snippet: Map<string, string> } | null>(null);
  const searchId = useRef(0);
  useEffect(() => {
    if (!terms.length) { setHits(null); return undefined; }
    const mine = ++searchId.current;
    const timer = window.setTimeout(() => {
      workspaceApi.list(null, query, false, 500)
        .then((found) => {
          if (mine !== searchId.current) return;
          setHits({ order: new Map(found.map((i, n) => [i.id, n])), snippet: new Map(found.map((i) => [i.id, i.snippet || ''])) });
        })
        .catch(() => { if (mine === searchId.current) setHits({ order: new Map(), snippet: new Map() }); });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [query, terms]);
  const searching = terms.length > 0;

  // Вернулись в окно — список мог измениться (коллега поделился, правил с другого устройства).
  useEffect(() => {
    const onFocus = () => { if (document.visibilityState === 'visible') void load(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => { window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus); };
  }, [load]);

  // Коллега открыл материал, убрал доступ, удалил или переименовал — список обновляется сам, без перезагрузки страницы.
  useEffect(() => {
    let timer = 0;
    const off = realtime.subscribe((event) => {
      const e = event as { type?: string; itemId?: string; viewers?: Viewer[] };
      if (e.type === 'workspace_presence_list' && e.itemId) {
        const me = myId();
        const viewers = (e.viewers || []).filter((v) => String(v.userId) !== me);
        setItems((cur) => cur?.map((i) => (i.id === e.itemId ? { ...i, viewers } : i)) ?? cur);
        return;
      }
      // Раскладка изменилась на другом устройстве (или у коллеги в общей папке) — перестраиваемся, строки «переезжают».
      if (!isWorkspaceEvent(event) && e.type !== 'workspace_folders') return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), 250);
    });
    return () => { off(); window.clearTimeout(timer); };
  }, [load]);

  // Присутствие истекает молча (закрыли вкладку без «ухода») — раз в 30 с сверяем аватарки на строках.
  const itemIds = useMemo(() => (items || []).map((i) => i.id).join(','), [items]);
  useEffect(() => {
    if (!itemIds) return undefined;
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      workspaceApi.listPresence(itemIds.split(',')).then((map) => {
        setItems((cur) => cur?.map((i) => {
          const next = map[i.id] || [];
          return (i.viewers?.length || 0) === next.length && (i.viewers || []).every((v, k) => v.userId === next[k]?.userId && v.editing === next[k]?.editing) ? i : { ...i, viewers: next };
        }) ?? cur);
      }).catch(() => undefined);
    };
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, [itemIds]);

  const select = (id: string | null, kind: Kind | 'all' = filter, replace = false) => {
    const next: Record<string, string> = {};
    if (kind !== 'all') next.kind = kind;
    if (id) next.id = id;
    setParams(next, { replace });
  };

  async function createItem(kind: Kind) {
    setCreate(null);
    setBusy(`new:${kind}`);
    try {
      const item = await workspaceApi.create({ kind, title: '', content: await initialContent(kind) });
      select(item.id, filter === 'all' ? 'all' : kind);
      void load();
    } catch (cause) { showToast(cause instanceof Error ? cause.message : 'Не удалось создать', 'error'); } finally { setBusy(''); }
  }

  const [dropping, setDropping] = useState(false);

  async function importPicked(file: File | undefined) {
    if (!file) return;
    setBusy('import');
    try {
      const imported = await importFile(file, (done, total) => setBusy(`import:${done}/${total}`), filter);
      const item = await workspaceApi.create({ kind: imported.kind, title: imported.title, content: imported.content });
      showToast(`Импортировано: ${KINDS[imported.kind].plural.toLowerCase()}`, 'success');
      select(item.id, filter === 'all' ? 'all' : imported.kind);
      void load();
    } catch (cause) { showToast(cause instanceof Error ? cause.message : 'Не удалось импортировать', 'error'); } finally {
      setBusy('');
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function togglePin(item: Item) {
    try { await workspaceApi.patch(item.id, { pinned: !item.pinned }); void load(); } catch (cause) { showToast(cause instanceof Error ? cause.message : 'Не получилось', 'error'); }
  }

  async function removeItem(item: Item) {
    const ok = await askConfirm({ title: `Удалить «${item.title || KINDS[item.kind].untitled}»?`, text: 'Это нельзя отменить.', confirm: 'Удалить', tone: 'danger' });
    if (!ok) return;
    try {
      await workspaceApi.remove(item.id);
      forgetSticky(item.id);
      if (openId === item.id) select(null);
      void load();
    } catch (cause) { showToast(cause instanceof Error ? cause.message : 'Не удалось удалить', 'error'); }
  }

  // Открыл новое — бейдж снимается сразу (сервер отметил это при открытии), строка встанет на место при обновлении.
  useEffect(() => {
    if (openId) setItems((cur) => (cur?.some((i) => i.id === openId && i.isNew) ? cur.map((i) => (i.id === openId ? { ...i, isNew: false } : i)) : cur));
  }, [openId, items]);
  // Материал из папки показывается в своей папке (новое — ещё и сверху), и в поиске тоже: дерево не рассыпается.
  const foldered = useMemo(() => {
    const known = new Set(folders.map((f) => f.id));
    return (i: Item) => Boolean(i.folderId && known.has(i.folderId));
  }, [folders]);
  // Дерево папок: вложенные по родителю (родитель пропал — папка наверху) и путь «Родитель / Папка» для меню.
  const childFolders = useMemo(() => {
    const known = new Set(folders.map((f) => f.id));
    const map = new Map<string | null, Folder[]>();
    for (const f of folders) {
      const parent = f.parentId && known.has(f.parentId) ? f.parentId : null;
      map.set(parent, [...(map.get(parent) || []), f]);
    }
    const rank = (f: Folder) => (f.position ?? Number.POSITIVE_INFINITY);
    for (const list of map.values()) list.sort((a, b) => (rank(a) - rank(b)) || a.title.localeCompare(b.title, 'ru'));
    return map;
  }, [folders]);
  // Что видно в поиске: найденное сервером и всё содержимое папок, подошедших по названию (с вложенными);
  // папка видна, если подошла сама, лежит в подошедшей или в ней (глубже) есть найденное.
  const search = useMemo(() => {
    if (!searching) return null;
    const named = new Set<string>();
    const addTree = (id: string) => { if (named.has(id)) return; named.add(id); (childFolders.get(id) || []).forEach((c) => addTree(c.id)); };
    folders.filter((f) => matchesAll(f.title, terms)).forEach((f) => addTree(f.id));
    const shown = (items || []).filter((i) => hits?.order.has(i.id) || (i.folderId && named.has(i.folderId)));
    const parents = new Map(folders.map((f) => [f.id, f.parentId || null]));
    const visible = new Set(named);
    for (const i of shown) {
      for (let id: string | null | undefined = i.folderId, guard = 0; id && guard < 64; id = parents.get(id), guard += 1) visible.add(id);
    }
    return { shown: new Set(shown.map((i) => i.id)), visible, named, count: shown.length + named.size };
  }, [searching, folders, childFolders, terms, items, hits]);
  const listed = useMemo(() => (search ? (items || []).filter((i) => search.shown.has(i.id)) : items || []), [items, search]);
  const byRank = (a: Item, b: Item) => (hits?.order.get(a.id) ?? 1e6) - (hits?.order.get(b.id) ?? 1e6);
  const fresh = useMemo(() => (search ? [] : listed.filter((i) => i.isNew)), [listed, search]);
  const pinned = useMemo(() => (search ? [] : listed.filter((i) => i.pinned && !i.isNew && !foldered(i))), [listed, foldered, search]);
  // Вне папок — ручной порядок: ещё не расставленные (новые) сверху, как пришли с сервера (свежие выше), за ними — расставленные.
  // В поиске — по совпадению: лучшее выше.
  const rest = useMemo(() => {
    if (search) return listed.filter((i) => !foldered(i)).sort(byRank);
    const loose = listed.filter((i) => !i.pinned && !i.isNew && !foldered(i));
    const placed = loose.filter((i) => i.rootPosition != null).sort((a, b) => (a.rootPosition ?? 0) - (b.rootPosition ?? 0));
    return [...loose.filter((i) => i.rootPosition == null), ...placed];
  }, [listed, foldered, search]); // eslint-disable-line react-hooks/exhaustive-deps
  const byFolder = useMemo(() => {
    const map = new Map<string, Item[]>();
    for (const i of listed) if (foldered(i) && (search || !i.isNew)) map.set(i.folderId!, [...(map.get(i.folderId!) || []), i]);
    // Ручной порядок; ещё не расставленные — в конце, свежие выше. В поиске — найденное по совпадению.
    const rank = (i: Item) => (i.folderPosition ?? Number.POSITIVE_INFINITY);
    for (const list of map.values()) list.sort(search ? byRank : (a, b) => (rank(a) - rank(b)) || b.updatedAt.localeCompare(a.updatedAt));
    return map;
  }, [listed, foldered, search]); // eslint-disable-line react-hooks/exhaustive-deps
  const folderPath = useMemo(() => {
    const byId = new Map(folders.map((f) => [f.id, f]));
    const path = (f: Folder, seen = new Set<string>()): string => {
      const parent = f.parentId ? byId.get(f.parentId) : undefined;
      if (!parent || seen.has(parent.id)) return f.title;
      seen.add(f.id);
      return `${path(parent, seen)} / ${f.title}`;
    };
    return new Map(folders.map((f) => [f.id, path(f)]));
  }, [folders]);
  // Разделы — фильтры по одному дереву: папки видны во всех разделах (дерево не прыгает при переключении), в папках —
  // только материалы раздела. Свой вид считаем по загруженным строкам (переносы видны сразу), остальные виды — по
  // счётчикам сервера: так папка с одними таблицами в «Доках» не называется пустой.
  const folderStats = useMemo(() => {
    const stats = new Map<string, { here: number; total: number }>();
    const walk = (f: Folder): { here: number; total: number } => {
      const own = byFolder.get(f.id)?.length ?? 0;
      const others = Object.entries(f.counts || {}).reduce((sum, [kind, n]) => sum + (filter === 'all' || kind === filter ? 0 : n || 0), 0);
      const acc = { here: own, total: own + others };
      for (const child of childFolders.get(f.id) || []) {
        const c = walk(child);
        acc.here += c.here;
        acc.total += c.total;
      }
      stats.set(f.id, acc);
      return acc;
    };
    for (const root of childFolders.get(null) || []) walk(root);
    return stats;
  }, [childFolders, byFolder, filter]);
  const visibleChildren = (parent: string | null) => (childFolders.get(parent) || []).filter((f) => !search || search.visible.has(f.id));
  // В поиске папки с найденным раскрыты сами (свернуть можно, но это не трогает обычное раскрытие).
  const [searchClosed, setSearchClosed] = useState<Set<string>>(() => new Set());
  useEffect(() => { setSearchClosed(new Set()); }, [query]);
  const isOpen = (id: string) => (search ? !searchClosed.has(id) : openFolders.has(id));
  const toggleOpen = (id: string) => {
    if (!search) { toggleFolder(id); return; }
    setSearchClosed((cur) => { const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  };

  /** Папка folderId — это ancestorId или лежит внутри неё (туда ancestorId класть нельзя). */
  const isWithin = (folderId: string, ancestorId: string) => {
    const byId = new Map(folders.map((f) => [f.id, f]));
    for (let cur: string | null | undefined = folderId, steps = 0; cur && steps < 64; cur = byId.get(cur)?.parentId, steps += 1) {
      if (cur === ancestorId) return true;
    }
    return false;
  };

  // Блок «Папки» целиком можно свернуть — список материалов тогда сразу под рукой. Помним на этом устройстве.
  const [foldersHidden, setFoldersHidden] = useState(() => { try { return localStorage.getItem('nws:folders-hidden') === '1'; } catch { return false; } });
  const toggleFoldersBlock = () => setFoldersHidden((cur) => {
    try { localStorage.setItem('nws:folders-hidden', cur ? '0' : '1'); } catch { /* приватный режим — просто не запомним */ }
    return !cur;
  });

  const toggleFolder = (id: string, open?: boolean) => setOpenFolders((cur) => {
    const next = new Set(cur);
    if (open ?? !next.has(id)) next.add(id); else next.delete(id);
    writeOpenFolders(next);
    return next;
  });

  /** Положить в папку (или вынуть — null): сразу в списке, потом на сервер; не вышло — перечитываем. */
  async function moveToFolder(itemId: string, folderId: string | null) {
    const item = items?.find((i) => i.id === itemId);
    if (!item || (item.folderId || null) === folderId) return;
    setItems((cur) => cur?.map((i) => (i.id === itemId ? { ...i, folderId } : i)) ?? cur);
    if (folderId) toggleFolder(folderId, true);
    try { await workspaceApi.placeItem(itemId, folderId); } catch (cause) { showToast(cause instanceof Error ? cause.message : 'Не удалось переместить', 'error'); void load(); }
  }

  /** Поставить папку на уровень parentId (null — верхний) на место index (по умолчанию — в конец): сразу в списке, потом на сервер. */
  async function placeFolder(folderId: string, parentId: string | null, index?: number) {
    if (parentId && isWithin(parentId, folderId)) { showToast('Папку нельзя положить в саму себя или во вложенную в неё', 'error'); return; }
    const ids = (childFolders.get(parentId) || []).map((f) => f.id).filter((id) => id !== folderId);
    ids.splice(index === undefined ? ids.length : Math.max(0, Math.min(index, ids.length)), 0, folderId);
    setFolders((cur) => cur.map((f) => { const p = ids.indexOf(f.id); return p >= 0 ? { ...f, parentId, position: p } : f; }));
    if (parentId) toggleFolder(parentId, true);
    try { setFolders(await workspaceApi.orderFolders(parentId, ids)); } catch (cause) { showToast(cause instanceof Error ? cause.message : 'Не удалось переместить папку', 'error'); void load(); }
  }

  /** Папку отпустили на другую: перед ней, после неё (на её уровне) или внутрь (в конец). */
  function dropFolderOn(target: Folder, folderId: string, zone: DropZone) {
    if (zone === 'into') { void placeFolder(folderId, target.id); return; }
    const parent = target.parentId && folders.some((f) => f.id === target.parentId) ? target.parentId : null;
    const siblings = (childFolders.get(parent) || []).map((f) => f.id).filter((id) => id !== folderId);
    void placeFolder(folderId, parent, siblings.indexOf(target.id) + (zone === 'after' ? 1 : 0));
  }

  /** Материал отпустили на другой в папке (folderId) или вне папок (null): встаёт перед ним или после — и переезжает
   *  туда, если был не здесь. */
  async function dropItemOn(folderId: string | null, target: Item, itemId: string, zone: DropZone) {
    if (itemId === target.id) return;
    const ids = (folderId ? byFolder.get(folderId) || [] : rest).map((i) => i.id).filter((id) => id !== itemId);
    ids.splice(ids.indexOf(target.id) + (zone === 'after' ? 1 : 0), 0, itemId);
    setItems((cur) => cur?.map((i) => {
      const p = ids.indexOf(i.id);
      if (p < 0) return i;
      return folderId ? { ...i, folderId, folderPosition: p } : { ...i, folderId: null, rootPosition: p };
    }) ?? cur);
    try {
      await (folderId ? workspaceApi.orderItems(folderId, ids) : workspaceApi.orderRoot(ids));
    } catch (cause) { showToast(cause instanceof Error ? cause.message : 'Не удалось переместить', 'error'); void load(); }
  }

  async function newFolder(thenPlace?: Item, parentId: string | null = null) {
    try {
      const { folder, folders: list } = await workspaceApi.createFolder('Новая папка', parentId);
      setFolders(list);
      setEditingFolder(folder.id);
      if (parentId) toggleFolder(parentId, true);
      toggleFolder(folder.id, true);
      if (thenPlace) void moveToFolder(thenPlace.id, folder.id);
    } catch (cause) { showToast(cause instanceof Error ? cause.message : 'Не удалось создать папку', 'error'); }
  }

  async function renameFolder(folder: Folder, title: string | null) {
    setEditingFolder(null);
    if (!title) return;
    setFolders((cur) => cur.map((f) => (f.id === folder.id ? { ...f, title } : f)));
    try { setFolders(await workspaceApi.renameFolder(folder.id, title)); } catch (cause) { showToast(cause instanceof Error ? cause.message : 'Не удалось переименовать', 'error'); }
  }

  async function removeFolder(folder: Folder) {
    const full = (byFolder.get(folder.id)?.length ?? 0) + (childFolders.get(folder.id)?.length ?? 0) > 0;
    const where = folder.parentId ? 'в папку уровнем выше' : 'в общий список, вложенные папки — наверх';
    const ok = await askConfirm({ title: `Удалить папку «${folder.title}»?`, text: full ? `Её содержимое переместится ${where}.` : undefined, confirm: 'Удалить', tone: 'danger' });
    if (!ok) return;
    try {
      setFolders(await workspaceApi.deleteFolder(folder.id));
      setItems((cur) => cur?.map((i) => (i.folderId === folder.id ? { ...i, folderId: folder.parentId } : i)) ?? cur);
    } catch (cause) { showToast(cause instanceof Error ? cause.message : 'Не удалось удалить папку', 'error'); }
  }
  useFlip(rowsRef, [items, folders, openFolders], `${filter}:${query}`);
  useDragAutoScroll(rowsRef);
  const importing = busy.startsWith('import');
  const importRule = IMPORT_RULES[filter];

  const renderRow = (item: Item) => (
    <ItemRow
      key={item.id}
      item={item}
      active={item.id === openId}
      terms={search ? terms : undefined}
      snippet={search ? hits?.snippet.get(item.id) : undefined}
      onOpen={() => select(item.id, filter === 'all' ? 'all' : item.kind)}
      onMenu={(anchor) => setRowMenu({ item, anchor })}
    />
  );

  // Строка материала в папке и вне папок — ещё и цель: отпущенный материал встаёт перед ней или после.
  const [slotOver, setSlotOver] = useState<{ id: string; zone: DropZone } | null>(null);
  const ownFolder = (id: string | null) => { if (!id) return true; const f = folders.find((x) => x.id === id); return !f?.role || f.role === 'owner'; };
  // В поиске перестановка выключена: показан не весь порядок, вставать «между» найденным бессмысленно.
  const renderSlot = (folderId: string | null) => (item: Item) => (search || !ownFolder(folderId) ? renderRow(item) : (
    <div
      key={item.id}
      className="nws-row-slot"
      data-drop={slotOver?.id === item.id ? slotOver.zone : undefined}
      onDragOver={(e) => { if (!isItemDrag(e)) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; setSlotOver({ id: item.id, zone: zoneOf(e, false) }); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setSlotOver((cur) => (cur?.id === item.id ? null : cur)); }}
      onDrop={(e) => {
        if (!isItemDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setSlotOver(null);
        const id = e.dataTransfer.getData(ITEM_DRAG);
        if (id) void dropItemOn(folderId, item, id, zoneOf(e, false));
      }}
    >
      {renderRow(item)}
    </div>
  ));

  const renderFolder = (f: Folder): ReactNode => {
    const subs = visibleChildren(f.id);
    const own = byFolder.get(f.id) || [];
    return (
      <FolderRow
        key={f.id}
        folder={f}
        count={folderStats.get(f.id)?.here ?? own.length}
        empty={!search && !own.length && !subs.length}
        otherKinds={(folderStats.get(f.id)?.total ?? 0) > 0}
        open={isOpen(f.id)}
        terms={search ? terms : undefined}
        editing={editingFolder === f.id}
        onToggle={() => toggleOpen(f.id)}
        onDropItem={(id) => void moveToFolder(id, f.id)}
        onDropFolder={(id, zone) => dropFolderOn(f, id, zone)}
        onMenu={(anchor) => setFolderMenu({ folder: f, anchor })}
        onRename={(title) => void renameFolder(f, title)}
      >
        {subs.map(renderFolder)}
        {own.map(renderSlot(f.id))}
      </FolderRow>
    );
  };

  return (
    <div className="nws" ref={layoutRef} data-open={openId ? 'true' : undefined} data-list={folded ? 'folded' : undefined}>
      <aside
        className={`nws-list${dropping ? ' is-dropping' : ''}`}
        aria-label="Материалы"
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true); } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false); }}
        onDrop={(e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); setDropping(false); void importPicked(e.dataTransfer.files[0]); }}
      >
        {folded && (
          <div className="nws-rail">
            <button type="button" className="nws-rail-btn" onClick={toggleList} title="Показать список материалов (Ctrl+\)" aria-label="Показать список материалов">
              <PanelLeftOpen size={18} aria-hidden="true" />
            </button>
            <button type="button" className="nws-rail-btn" aria-haspopup="menu" aria-expanded={Boolean(create)} disabled={Boolean(busy)} title="Создать" aria-label="Создать" onClick={(e) => setCreate({ element: e.currentTarget, align: 'start' })}>
              <Plus size={18} aria-hidden="true" />
            </button>
          </div>
        )}
        <header className="nws-list-head">
          {!narrow && (
            <button type="button" className="nws-fold" onClick={toggleList} title="Скрыть список материалов (Ctrl+\)" aria-label="Скрыть список материалов">
              <PanelLeftClose size={17} aria-hidden="true" />
            </button>
          )}
          <button type="button" className="nx-ghost nws-import" disabled={importing} title={`${importRule.label}: ${importRule.hint}`} aria-label={importRule.label} onClick={() => fileInput.current?.click()}>
            <Upload size={15} aria-hidden="true" /> Импорт
          </button>
          <button type="button" className="nx-primary" aria-haspopup="menu" aria-expanded={Boolean(create)} disabled={Boolean(busy) && !importing} onClick={(e) => setCreate({ element: e.currentTarget, align: 'end' })}>
            <Plus size={15} aria-hidden="true" /> Создать
          </button>
          <input ref={fileInput} type="file" accept={importRule.accept} hidden onChange={(e) => void importPicked(e.target.files?.[0])} />
        </header>

        <div className="nws-kinds" role="group" aria-label="Вид материалов">
          <button type="button" aria-pressed={filter === 'all'} onClick={() => select(null, 'all')}><LayoutGrid size={16} aria-hidden="true" /><span>Все</span></button>
          {KIND_LIST.map((k) => (
            <button key={k.kind} type="button" aria-pressed={filter === k.kind} onClick={() => select(null, k.kind)} style={{ '--a': k.tint[0], '--b': k.tint[1] } as React.CSSProperties}>
              <k.icon size={16} aria-hidden="true" /><span>{k.short}</span>
            </button>
          ))}
        </div>

        <SearchField value={query} onChange={setQuery} placeholder="Найти по названию и тексту" />
        {importing && <p className="nws-hint" role="status">{busy.includes('/') ? `Читаю PDF: ${busy.split(':')[1]}` : 'Импортирую…'}</p>}

        <div
          className="nws-rows nx-scroll-y"
          ref={rowsRef}
          data-over={rootOver || undefined}
          // Отпустили строку мимо папок — материал выходит из своей папки, папка — на верхний уровень.
          onDragOver={(e) => { if (!isItemDrag(e) && !isFolderDrag(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setRootOver(true); }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setRootOver(false); }}
          onDrop={(e) => {
            if (!isItemDrag(e) && !isFolderDrag(e)) return;
            e.preventDefault();
            setRootOver(false);
            const id = e.dataTransfer.getData(ITEM_DRAG);
            const folderId = e.dataTransfer.getData(FOLDER_DRAG);
            if (id) void moveToFolder(id, null);
            else if (folderId) void placeFolder(folderId, null);
          }}
        >
          {items === null && !error && <div className="nws-loading"><Spinner size={22} label="Загружаю" /></div>}
          {error && <p className="nws-hint nws-error" role="alert">{error} <button type="button" className="nx-ghost" onClick={() => void load()}>Повторить</button></p>}
          {/* data-flip у заголовков групп: при раскрытии папок они переезжают вместе со строками, а не прыгают. */}
          {fresh.length > 0 && <h2 className="nws-group" data-flip="g-new">Новые для вас</h2>}
          {fresh.map(renderRow)}
          {pinned.length > 0 && <h2 className="nws-group" data-flip="g-pinned">Закреплённые</h2>}
          {pinned.map(renderRow)}
          {search && (
            <p className="nws-search-state" role="status">
              {!hits ? <><Spinner size={13} /> Ищу…</> : search.count ? `Найдено: ${search.count}` : 'Ничего не нашлось — попробуйте другие слова.'}
            </p>
          )}
          {visibleChildren(null).length > 0 && (
            <div className="nws-group-row" data-flip="g-folders">
              <h2 className="nws-group">Папки{(foldersHidden && !search) && <span className="nws-group-count"> · {visibleChildren(null).length}</span>}</h2>
              {!search && (
                <button type="button" className="nws-group-btn" onClick={toggleFoldersBlock} aria-expanded={!foldersHidden}>
                  {foldersHidden ? <ChevronsUpDown size={14} aria-hidden="true" /> : <ChevronsDownUp size={14} aria-hidden="true" />}
                  {foldersHidden ? 'Показать' : 'Свернуть'}
                </button>
              )}
            </div>
          )}
          {(search || !foldersHidden) && visibleChildren(null).map(renderFolder)}
          {(pinned.length > 0 || fresh.length > 0 || visibleChildren(null).length > 0) && rest.length > 0 && <h2 className="nws-group" data-flip="g-rest">{search ? 'Вне папок' : 'Остальные'}</h2>}
          {rest.map(renderSlot(null))}
          {items !== null && !items.length && !error && !search && (
            <div className="nws-empty-list">
              <p>{filter === 'all' ? 'Здесь появятся ваши заметки, документы, таблицы и презентации.' : KINDS[filter].empty}</p>
              {(
                <div className="nws-empty-actions">
                  <button type="button" className="nx-primary" onClick={() => void createItem(filter === 'all' ? 'document' : filter)}><Plus size={14} aria-hidden="true" /> {filter === 'all' ? 'Новый документ' : KINDS[filter].newLabel}</button>
                  <button type="button" className="nx-ghost" disabled={importing} onClick={() => fileInput.current?.click()}><Upload size={14} aria-hidden="true" /> {importRule.label}</button>
                </div>
              )}
            </div>
          )}
        </div>
      </aside>

      {!narrow && !folded && <Splitter containerRef={layoutRef} cssVar="--nws-list" storageKey="nx:office-list-width" min={280} max={620} initial={340} maxRatio={0.5} label="Ширина списка материалов" />}

      <section className="nws-pane">
        {openId ? (
          <ItemView
            key={openId}
            source={{ id: openId }}
            onBack={narrow ? () => select(null) : undefined}
            onChanged={() => void load()}
            onDeleted={() => { select(null); void load(); }}
            onOpen={(id, kind) => select(id, filter === 'all' ? 'all' : kind)}
          />
        ) : (
          <div className="nws-welcome">
            <h2>Что создаём?</h2>
            <div className="nws-tiles">
              {KIND_LIST.map((k) => (
                <button key={k.kind} type="button" className="nws-tile" disabled={Boolean(busy)} onClick={() => void createItem(k.kind)} style={{ '--a': k.tint[0], '--b': k.tint[1] } as React.CSSProperties}>
                  <span className="nws-tile-icon" aria-hidden="true"><k.icon size={26} /></span>
                  <b>{k.newLabel.replace('Новая ', '').replace('Новый ', '').replace(/^./, (c) => c.toUpperCase())}</b>
                </button>
              ))}
            </div>
            <button type="button" className="nx-ghost nws-welcome-import" disabled={importing} onClick={() => fileInput.current?.click()}><Upload size={15} aria-hidden="true" /> {importRule.label}</button>
            <p className="nws-hint">{importRule.hint}. Поделиться материалом можно с человеком или целым отделом — он сразу появится у них в «Офисе».</p>
          </div>
        )}
      </section>

      {create && (
        <Menu anchor={create} label="Создать" onClose={() => setCreate(null)}>
          {KIND_LIST.map((k) => <MenuItem key={k.kind} icon={<k.icon size={16} />} onSelect={() => void createItem(k.kind)}>{k.newLabel}</MenuItem>)}
          <div className="nx-menu-sep" />
          <MenuItem icon={<FolderPlus size={16} />} onSelect={() => { setCreate(null); void newFolder(); }}>Папку</MenuItem>
        </Menu>
      )}
      {folderMenu && (
        <Menu anchor={folderMenu.anchor} label="Папка" onClose={() => setFolderMenu(null)}>
          {folderMenu.folder.role && folderMenu.folder.role !== 'owner' ? (
            <MenuItem icon={<Users size={15} />} disabled onSelect={() => undefined}>
              Открыта вам · {folderMenu.folder.ownerName || 'коллега'}{folderMenu.folder.role === 'view' ? ' · только просмотр' : ''}
            </MenuItem>
          ) : (<>
          <MenuItem icon={<UserPlus size={15} />} onSelect={() => { const f = folderMenu.folder; setFolderMenu(null); setShareFolder(f); }}>Доступ…</MenuItem>
          <MenuItem icon={<Pencil size={15} />} onSelect={() => { const f = folderMenu.folder; setFolderMenu(null); setEditingFolder(f.id); }}>Переименовать</MenuItem>
          <MenuItem icon={<FolderPlus size={15} />} onSelect={() => { const f = folderMenu.folder; setFolderMenu(null); void newFolder(undefined, f.id); }}>Новая папка внутри</MenuItem>
          {folderMenu.folder.parentId && (
            <MenuItem icon={<FolderUp size={15} />} onSelect={() => { const f = folderMenu.folder; setFolderMenu(null); void placeFolder(f.id, null); }}>Вынести на верхний уровень</MenuItem>
          )}
          <MenuItem icon={<Trash2 size={15} />} tone="danger" onSelect={() => { const f = folderMenu.folder; setFolderMenu(null); void removeFolder(f); }}>Удалить папку</MenuItem>
          </>)}
        </Menu>
      )}
      {shareFolder && <FolderShareDialog folder={shareFolder} onClose={() => setShareFolder(null)} onChanged={() => void load()} />}
      {moveMenu && (
        <Menu anchor={moveMenu.anchor} label="В папку" onClose={() => setMoveMenu(null)}>
          {folders.filter((f) => !f.role || f.role === 'owner').sort((a, b) => (folderPath.get(a.id) || '').localeCompare(folderPath.get(b.id) || '', 'ru')).map((f) => (
            <MenuItem key={f.id} icon={<FolderIcon size={15} />} disabled={moveMenu.item.folderId === f.id} onSelect={() => { const i = moveMenu.item; setMoveMenu(null); void moveToFolder(i.id, f.id); }}>{folderPath.get(f.id) || f.title}</MenuItem>
          ))}
          {moveMenu.item.folderId && <MenuItem icon={<FolderMinus size={15} />} onSelect={() => { const i = moveMenu.item; setMoveMenu(null); void moveToFolder(i.id, null); }}>Вынуть из папки</MenuItem>}
          <MenuItem icon={<FolderPlus size={15} />} onSelect={() => { const i = moveMenu.item; setMoveMenu(null); void newFolder(i); }}>Новая папка…</MenuItem>
        </Menu>
      )}
      {rowMenu && (
        <Menu anchor={rowMenu.anchor} label="Действия" onClose={() => setRowMenu(null)}>
          <MenuItem onSelect={() => { const i = rowMenu.item; setRowMenu(null); select(i.id, filter === 'all' ? 'all' : i.kind); }}>Открыть</MenuItem>
          <MenuItem icon={<Send size={15} />} onSelect={() => { const i = rowMenu.item; setRowMenu(null); setSendItem(i); }}>Отправить в чат</MenuItem>
          <MenuItem icon={<FolderInput size={15} />} onSelect={() => { const { item, anchor } = rowMenu; setRowMenu(null); setMoveMenu({ item, anchor }); }}>Переместить в папку…</MenuItem>
          {canSticky(rowMenu.item.kind) && (
            <MenuItem icon={<MonitorUp size={15} />} onSelect={() => { const i = rowMenu.item; setRowMenu(null); void openSticky(i.id, null, { kind: i.kind }); }}>{stickyLabel(rowMenu.item.kind)}</MenuItem>
          )}
          {rowMenu.item.isOwner && (
            <MenuItem icon={<Pin size={15} />} onSelect={() => { const i = rowMenu.item; setRowMenu(null); void togglePin(i); }}>{rowMenu.item.pinned ? 'Открепить' : 'Закрепить сверху'}</MenuItem>
          )}
          {rowMenu.item.isOwner && (
            <MenuItem icon={<Trash2 size={15} />} tone="danger" onSelect={() => { const i = rowMenu.item; setRowMenu(null); void removeItem(i); }}>Удалить</MenuItem>
          )}
        </Menu>
      )}
      {sendItem && <SendToChatSheet item={sendItem} onClose={() => setSendItem(null)} />}
    </div>
  );
}
