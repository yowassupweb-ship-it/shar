import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { Folder as FolderIcon, FolderInput, FolderMinus, FolderPlus, FolderUp, Globe2, LayoutGrid, Lock, MonitorUp, Pencil, Pin, Plus, Send, Trash2, Upload, Users } from 'lucide-react';
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
import { isWorkspaceEvent } from './live';
import { readPlace, writePlace } from './lib/officeMemory';
import { canSticky, dragNoteOut, forgetSticky, openSticky } from './lib/sticky';
import type { Folder, Item, Kind } from './types';
import { FOLDER_DRAG, FolderRow, isFolderDrag, isItemDrag, ITEM_DRAG } from './Folders';

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

function ItemRow({ item, active, path, onOpen, onMenu }: { item: Item; active: boolean; path?: string; onOpen: () => void; onMenu: (anchor: MenuAnchor) => void }) {
  const info = KINDS[item.kind];
  const press = useLongPress((x, y) => onMenu({ x, y }));
  const AccessIcon = item.accessLevel === 'all' ? Globe2 : Lock;
  const mine = item.ownerId === myId();
  return (
    <button
      type="button"
      className="nws-row"
      aria-current={active ? 'true' : undefined}
      data-color={item.kind === 'note' ? item.meta.color || undefined : undefined}
      onClick={onOpen}
      // Заметку можно вытащить за пределы окна — она станет окном на рабочем столе (только в приложении для компьютера).
      // Строку можно перетащить в папку; заметку — ещё и за пределы окна: она станет окном на рабочем столе.
      draggable
      onDragStart={(e) => { e.dataTransfer.setData(ITEM_DRAG, item.id); e.dataTransfer.setData('text/plain', item.title || info.untitled); e.dataTransfer.effectAllowed = 'copyMove'; }}
      onDragEnd={(e) => { if (canSticky(item.kind)) dragNoteOut(e, item.id); }}
      onContextMenu={(e) => { e.preventDefault(); onMenu({ x: e.clientX, y: e.clientY }); }}
      {...press}
    >
      <span className="nws-kind-icon" style={{ '--a': info.tint[0], '--b': info.tint[1] } as React.CSSProperties} aria-hidden="true"><info.icon size={16} /></span>
      <span className="nws-row-text">
        <span className="nws-row-title">{item.isNew && <span className="nws-new">Новое</span>}{item.title || info.untitled}</span>
        {path && <span className="nws-row-path"><FolderIcon size={11} aria-hidden="true" />{path}</span>}
        <span className="nws-row-snippet">{item.kind === 'note' ? plainSnippet(item.snippet) : item.snippet}</span>
      </span>
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

  const [items, setItems] = useState<Item[] | null>(null);
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
      const [list, folderList] = await Promise.all([workspaceApi.list(filter === 'all' ? null : filter, query), workspaceApi.folders().catch(() => null)]);
      if (mine !== reqId.current) return;
      setItems(list);
      if (folderList) setFolders(folderList);
      setError('');
    } catch (cause) {
      if (mine === reqId.current) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить');
    }
  }, [filter, query]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), query ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [load, query]);

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
      if (!isWorkspaceEvent(event)) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), 250);
    });
    return () => { off(); window.clearTimeout(timer); };
  }, [load]);

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
  // В поиске список плоский; иначе материал из папки показывается только в своей папке (новое — ещё и сверху).
  const foldered = useMemo(() => {
    const known = new Set(folders.map((f) => f.id));
    return (i: Item) => !query && Boolean(i.folderId && known.has(i.folderId));
  }, [folders, query]);
  const fresh = useMemo(() => (items || []).filter((i) => i.isNew), [items]);
  const pinned = useMemo(() => (items || []).filter((i) => i.pinned && !i.isNew && !foldered(i)), [items, foldered]);
  const rest = useMemo(() => (items || []).filter((i) => !i.pinned && !i.isNew && !foldered(i)), [items, foldered]);
  const byFolder = useMemo(() => {
    const map = new Map<string, Item[]>();
    for (const i of items || []) if (foldered(i) && !i.isNew) map.set(i.folderId!, [...(map.get(i.folderId!) || []), i]);
    return map;
  }, [items, foldered]);
  // Дерево папок: вложенные по родителю (родитель пропал — папка наверху) и путь «Родитель / Папка» для меню.
  const childFolders = useMemo(() => {
    const known = new Set(folders.map((f) => f.id));
    const map = new Map<string | null, Folder[]>();
    for (const f of folders) {
      const parent = f.parentId && known.has(f.parentId) ? f.parentId : null;
      map.set(parent, [...(map.get(parent) || []), f]);
    }
    return map;
  }, [folders]);
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
  // Разделы — фильтры по одному дереву: в «Доках» видна папка, где (с вложенными) есть документы, а совсем пустая —
  // во всех разделах, чтобы в неё было что положить. Свой вид считаем по загруженным строкам (переносы видны сразу),
  // остальные виды — по счётчикам сервера.
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
  const shownInSection = (f: Folder) => {
    if (filter === 'all') return true;
    const s = folderStats.get(f.id);
    return !s || s.here > 0 || s.total === 0;
  };
  const visibleChildren = (parent: string | null) => (childFolders.get(parent) || []).filter(shownInSection);
  // В поиске: папки, чьё название подходит (щелчок — открыть её на месте в дереве).
  const matchedFolders = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? folders.filter((f) => f.title.toLowerCase().includes(q)) : [];
  }, [folders, query]);
  const revealFolder = (f: Folder) => {
    const byId = new Map(folders.map((x) => [x.id, x]));
    const chain: string[] = [];
    for (let cur: Folder | undefined = f; cur && chain.length < 64; cur = cur.parentId ? byId.get(cur.parentId) : undefined) chain.push(cur.id);
    setOpenFolders((cur) => { const next = new Set(cur); chain.forEach((id) => next.add(id)); writeOpenFolders(next); return next; });
    setQuery('');
  };

  /** Папка folderId — это ancestorId или лежит внутри неё (туда ancestorId класть нельзя). */
  const isWithin = (folderId: string, ancestorId: string) => {
    const byId = new Map(folders.map((f) => [f.id, f]));
    for (let cur: string | null | undefined = folderId, steps = 0; cur && steps < 64; cur = byId.get(cur)?.parentId, steps += 1) {
      if (cur === ancestorId) return true;
    }
    return false;
  };

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

  /** Переложить папку в другую (null — наверх): сразу в списке, потом на сервер. */
  async function moveFolder(folderId: string, parentId: string | null) {
    const folder = folders.find((f) => f.id === folderId);
    if (!folder || (folder.parentId || null) === parentId) return;
    if (parentId && isWithin(parentId, folderId)) { showToast('Папку нельзя положить в саму себя или во вложенную в неё', 'error'); return; }
    setFolders((cur) => cur.map((f) => (f.id === folderId ? { ...f, parentId } : f)));
    if (parentId) toggleFolder(parentId, true);
    try { setFolders(await workspaceApi.moveFolder(folderId, parentId)); } catch (cause) { showToast(cause instanceof Error ? cause.message : 'Не удалось переместить папку', 'error'); void load(); }
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
  const importing = busy.startsWith('import');
  const importRule = IMPORT_RULES[filter];

  const renderRow = (item: Item) => (
    <ItemRow
      key={item.id}
      item={item}
      active={item.id === openId}
      path={query && item.folderId ? folderPath.get(item.folderId) : undefined}
      onOpen={() => select(item.id, filter === 'all' ? 'all' : item.kind)}
      onMenu={(anchor) => setRowMenu({ item, anchor })}
    />
  );

  const renderFolder = (f: Folder): ReactNode => {
    const subs = visibleChildren(f.id);
    const own = byFolder.get(f.id) || [];
    return (
      <FolderRow
        key={f.id}
        folder={f}
        count={own.length}
        empty={!own.length && !subs.length}
        open={openFolders.has(f.id)}
        editing={editingFolder === f.id}
        onToggle={() => toggleFolder(f.id)}
        onDropItem={(id) => void moveToFolder(id, f.id)}
        onDropFolder={(id) => void moveFolder(id, f.id)}
        onMenu={(anchor) => setFolderMenu({ folder: f, anchor })}
        onRename={(title) => void renameFolder(f, title)}
      >
        {subs.map(renderFolder)}
        {own.map(renderRow)}
      </FolderRow>
    );
  };

  return (
    <div className="nws" ref={layoutRef} data-open={openId ? 'true' : undefined}>
      <aside
        className={`nws-list${dropping ? ' is-dropping' : ''}`}
        aria-label="Материалы"
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true); } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false); }}
        onDrop={(e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); setDropping(false); void importPicked(e.dataTransfer.files[0]); }}
      >
        <header className="nws-list-head">
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
            else if (folderId) void moveFolder(folderId, null);
          }}
        >
          {items === null && !error && <div className="nws-loading"><Spinner size={22} label="Загружаю" /></div>}
          {error && <p className="nws-hint nws-error" role="alert">{error} <button type="button" className="nx-ghost" onClick={() => void load()}>Повторить</button></p>}
          {fresh.length > 0 && <h2 className="nws-group">Новые для вас</h2>}
          {fresh.map(renderRow)}
          {pinned.length > 0 && <h2 className="nws-group">Закреплённые</h2>}
          {pinned.map(renderRow)}
          {!query && visibleChildren(null).length > 0 && <h2 className="nws-group">Папки</h2>}
          {!query && visibleChildren(null).map(renderFolder)}
          {matchedFolders.length > 0 && <h2 className="nws-group">Папки</h2>}
          {matchedFolders.map((f) => (
            <button key={f.id} type="button" className="nws-row nws-folder-hit" onClick={() => revealFolder(f)}>
              <span className="nws-kind-icon nws-folder-hit-icon" aria-hidden="true"><FolderIcon size={16} /></span>
              <span className="nws-row-text">
                <span className="nws-row-title">{f.title}</span>
                {f.parentId && <span className="nws-row-snippet">{folderPath.get(f.parentId)}</span>}
              </span>
            </button>
          ))}
          {(pinned.length > 0 || fresh.length > 0 || matchedFolders.length > 0 || (!query && visibleChildren(null).length > 0)) && rest.length > 0 && <h2 className="nws-group">{query ? 'Материалы' : 'Остальные'}</h2>}
          {rest.map(renderRow)}
          {items !== null && !items.length && !error && (
            <div className="nws-empty-list">
              <p>{query ? 'Ничего не нашлось.' : filter === 'all' ? 'Здесь появятся ваши заметки, документы, таблицы и презентации.' : KINDS[filter].empty}</p>
              {!query && (
                <div className="nws-empty-actions">
                  <button type="button" className="nx-primary" onClick={() => void createItem(filter === 'all' ? 'document' : filter)}><Plus size={14} aria-hidden="true" /> {filter === 'all' ? 'Новый документ' : KINDS[filter].newLabel}</button>
                  <button type="button" className="nx-ghost" disabled={importing} onClick={() => fileInput.current?.click()}><Upload size={14} aria-hidden="true" /> {importRule.label}</button>
                </div>
              )}
            </div>
          )}
        </div>
      </aside>

      {!narrow && <Splitter containerRef={layoutRef} cssVar="--nws-list" storageKey="nx:office-list-width" min={280} max={620} initial={340} maxRatio={0.5} label="Ширина списка материалов" />}

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
          <MenuItem icon={<Pencil size={15} />} onSelect={() => { const f = folderMenu.folder; setFolderMenu(null); setEditingFolder(f.id); }}>Переименовать</MenuItem>
          <MenuItem icon={<FolderPlus size={15} />} onSelect={() => { const f = folderMenu.folder; setFolderMenu(null); void newFolder(undefined, f.id); }}>Новая папка внутри</MenuItem>
          {folderMenu.folder.parentId && (
            <MenuItem icon={<FolderUp size={15} />} onSelect={() => { const f = folderMenu.folder; setFolderMenu(null); void moveFolder(f.id, null); }}>Вынести на верхний уровень</MenuItem>
          )}
          <MenuItem icon={<Trash2 size={15} />} tone="danger" onSelect={() => { const f = folderMenu.folder; setFolderMenu(null); void removeFolder(f); }}>Удалить папку</MenuItem>
        </Menu>
      )}
      {moveMenu && (
        <Menu anchor={moveMenu.anchor} label="В папку" onClose={() => setMoveMenu(null)}>
          {[...folders].sort((a, b) => (folderPath.get(a.id) || '').localeCompare(folderPath.get(b.id) || '', 'ru')).map((f) => (
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
            <MenuItem icon={<MonitorUp size={15} />} onSelect={() => { const i = rowMenu.item; setRowMenu(null); void openSticky(i.id); }}>На рабочий стол</MenuItem>
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
