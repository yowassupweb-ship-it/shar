import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Folder, FolderOpen, HardDrive, MoreHorizontal, Users } from 'lucide-react';
import { displayName, useChatStore } from '@/features/chat';
import { realtime } from '@/shared/realtime/realtime';
import { SearchField } from '@/shared/ui/SearchField';
import type { MenuAnchor } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import { cachedFolder, folderChain, loadFolder, moveFile, moveFolder, prefetchFolder, renameItem, sharedPeople, type CloudFolder } from './api';

/**
 * Дерево папок «Файлов» сбоку — как дерево в «Офисе»: корень «Мои файлы», папки раскрываются стрелкой (значок открытой и
 * закрытой папки), вложенные подгружаются при раскрытии (и заранее — при наведении). Текущая папка подсвечена, путь к ней
 * раскрыт сам. У папки — то же меню действий, что у плитки (ПКМ или «⋯»), и аватарки тех, кому она открыта.
 * Сверху — поиск по папкам (по всем, не только раскрытым). На папку дерева можно бросить файл или папку из списка справа.
 */

// v2: прежний ключ копил раскрытыми всех предков каждой посещённой папки — дерево «само» раскрывалось целиком.
const OPEN_KEY = 'nf:tree-open-v2';
const DRAG_TYPE = 'application/x-shar-cloud-item';

function readOpen(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || '[]') as string[]); } catch { return new Set(); }
}

type MenuOpener = (folder: CloudFolder, anchor: MenuAnchor, path: CloudFolder[]) => void;

export function FolderTree({ trail, onOpen, onMoved, onMenu }: {
  /** Цепочка от корня до открытой папки. */
  trail: CloudFolder[];
  /** Открыть папку: путь от корня до неё (пустой — корень). */
  onOpen: (path: CloudFolder[]) => void;
  /** Что-то перенесли в папку дерева — открытая папка должна перечитаться. */
  onMoved?: () => void;
  /** Меню действий папки — то же, что у плитки справа. */
  onMenu?: MenuOpener;
}) {
  // Раскрытое руками (запоминается) и свёрнутое руками из пути к открытой папке (на время работы).
  const [userOpen, setUserOpen] = useState<Set<string>>(readOpen);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [children, setChildren] = useState<Record<string, CloudFolder[]>>((): Record<string, CloudFolder[]> => {
    const root = cachedFolder(null);
    return root ? { '': root.folders } : {};
  });
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const asked = useRef(new Set<string>());
  const [retryTick, setRetryTick] = useState(0);
  const load = useCallback(async (id: string | null) => {
    try {
      const d = await loadFolder(id);
      setChildren((cur) => ({ ...cur, [id || '']: d.folders }));
    } catch {
      // Нет связи — оставим, что было, и попробуем ещё раз через несколько секунд (а не по кругу без паузы).
      window.setTimeout(() => { if (id) asked.current.delete(id); setRetryTick((n) => n + 1); }, 4000);
    }
  }, []);

  useEffect(() => { void load(null); }, [load]);
  // Видно раскрытым: раскрытое руками + путь к открытой папке (его не запоминаем — иначе со временем раскрывалось всё).
  const open = useMemo(() => {
    const next = new Set(userOpen);
    trail.slice(0, -1).forEach((f) => { if (!collapsed.has(f.id)) next.add(f.id); });
    return next;
  }, [userOpen, collapsed, trail]);
  // Подпапки раскрытого — по одному запросу; не загрузилось — повтор через паузу (load), а не шквал запросов.
  useEffect(() => {
    open.forEach((id) => { if (!(id in children) && !asked.current.has(id)) { asked.current.add(id); void load(id); } });
  }, [open, children, load, retryTick]);
  useEffect(() => {
    try { localStorage.setItem(OPEN_KEY, JSON.stringify([...userOpen].slice(-200))); } catch { /* без памяти */ }
  }, [userOpen]);

  useEffect(() => {
    let timer = 0;
    return realtime.subscribe((event) => {
      if (event.type !== 'cloud_changed') return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { void load(null); open.forEach((id) => void load(id)); }, 500);
    });
  }, [load, open]);

  const openRef = useRef(open);
  openRef.current = open;
  const toggle = useCallback((id: string) => {
    const closing = openRef.current.has(id);
    asked.current.delete(id); // раскрыли снова — попробуем загрузить ещё раз
    setUserOpen((cur) => { const next = new Set(cur); if (closing) next.delete(id); else next.add(id); return next; });
    setCollapsed((cur) => { const next = new Set(cur); if (closing) next.add(id); else next.delete(id); return next; });
  }, []);

  const current = trail[trail.length - 1]?.id ?? null;

  const drop = async (e: React.DragEvent, dest: CloudFolder | null) => {
    setDropOn(null);
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (!raw) return;
    e.preventDefault();
    try {
      const { kind, id } = JSON.parse(raw) as { kind: 'file' | 'folder'; id: string };
      if (kind === 'folder' && id === dest?.id) return;
      if (kind === 'file') await moveFile(id, dest?.id ?? null); else await moveFolder(id, dest?.id ?? null);
      showToast(`Перемещено в «${dest?.name || 'Мои файлы'}»`, 'success');
      void load(dest?.id ?? null);
      onMoved?.();
    } catch {
      showToast('Не переместил — нет прав на папку или нет связи с сервером.', 'error');
    }
  };
  const dropProps = (dest: CloudFolder | null, key: string) => ({
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dropOn !== key) setDropOn(key); } },
    onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOn((k) => (k === key ? null : k)); },
    onDrop: (e: React.DragEvent) => void drop(e, dest),
  });

  const renameApi = useMemo(() => ({
    id: renamingId,
    start: setRenamingId,
    commit: (folder: CloudFolder, name: string | null) => {
      setRenamingId(null);
      if (!name) return;
      const apply = (n: string) => setChildren((cur) => Object.fromEntries(Object.entries(cur).map(([k, list]) => [k, list.map((f) => (f.id === folder.id ? { ...f, name: n } : f))])));
      apply(name);
      renameItem('folder', folder.id, name).catch(() => { apply(folder.name); showToast('Не переименовал — нет связи с сервером.', 'error'); });
    },
  }), [renamingId]);

  return (
    <RenameCtx.Provider value={renameApi}>
    <nav className="nftr" aria-label="Папки">
      <SearchField className="nftr-search" value={query} onChange={setQuery} placeholder="Найти папку" />
      {query.trim().length >= 2 ? (
        <TreeSearch query={query.trim()} onOpen={onOpen} onMenu={onMenu} current={current} />
      ) : (
        <>
          <button
            type="button"
            className="nftr-row"
            aria-current={current === null ? 'page' : undefined}
            data-drop={dropOn === 'root' ? 'true' : undefined}
            style={{ '--depth': 0 } as React.CSSProperties}
            onClick={() => onOpen([])}
            {...dropProps(null, 'root')}
          >
            <span className="nftr-twist" aria-hidden="true" />
            <HardDrive size={16} aria-hidden="true" />
            <span className="nftr-label">Мои файлы</span>
          </button>
          <Level parent="" path={[]} depth={1} childrenOf={children} open={open} current={current} dropOn={dropOn} onToggle={toggle} onOpen={onOpen} onMenu={onMenu} dropProps={dropProps} />
        </>
      )}
    </nav>
    </RenameCtx.Provider>
  );
}

/** Переименование в дереве (F2 на строке): какая папка сейчас в поле ввода и что делать с новым именем. */
const RenameCtx = createContext<{ id: string | null; start: (id: string) => void; commit: (folder: CloudFolder, name: string | null) => void }>({
  id: null, start: () => undefined, commit: () => undefined,
});

function TreeRename({ folder }: { folder: CloudFolder }) {
  const { commit } = useContext(RenameCtx);
  return (
    <input
      className="nftr-rename"
      defaultValue={folder.name}
      autoFocus
      maxLength={200}
      aria-label="Новое имя папки"
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') { e.currentTarget.value = folder.name; e.currentTarget.blur(); }
      }}
      onBlur={(e) => { const v = e.currentTarget.value.trim(); commit(folder, v && v !== folder.name ? v : null); }}
    />
  );
}

/** Кому папка открыта — тихо: значок «люди» и число, как в дереве Офиса. Имена — в подсказке при наведении. */
function Faces({ ids }: { ids: string[] }) {
  const users = useChatStore((s) => s.users);
  if (!ids.length) return null;
  const names = ids.map((id) => (id.startsWith('dept:') ? 'отдел' : users[id] ? displayName(users[id]) : '')).filter(Boolean);
  return (
    <span className="nftr-shared" title={`Открыта: ${names.join(', ') || ids.length}`} aria-label={`Общий доступ: ${ids.length}`}>
      <Users size={12} aria-hidden="true" />{ids.length}
    </span>
  );
}

function Row({ folder, path, depth, isOpen, leaf, current, dropOn, onToggle, onOpen, onMenu, dropProps }: {
  folder: CloudFolder; path: CloudFolder[]; depth: number; isOpen: boolean; leaf: boolean; current: string | null; dropOn: string | null;
  onToggle?: (id: string) => void; onOpen: (path: CloudFolder[]) => void; onMenu?: MenuOpener;
  dropProps?: (dest: CloudFolder | null, key: string) => Record<string, unknown>;
}) {
  const shared = [...new Set([...sharedPeople(folder), ...(folder.editAccess || []).map(String)])].filter((id) => !id.startsWith('dept:') && id !== String(folder.ownerId));
  const Icon = isOpen ? FolderOpen : Folder;
  const rename = useContext(RenameCtx);
  const renaming = rename.id === folder.id;
  return (
    <div
      className="nftr-row"
      role="button"
      tabIndex={0}
      aria-current={current === folder.id ? 'page' : undefined}
      aria-expanded={leaf || !onToggle ? undefined : isOpen}
      data-drop={dropOn === `f:${folder.id}` ? 'true' : undefined}
      style={{ '--depth': depth, '--folder': folder.color || undefined } as React.CSSProperties}
      onClick={() => { if (!renaming) onOpen(path); }}
      onMouseEnter={() => prefetchFolder(folder.id)}
      onContextMenu={(e) => { if (!onMenu) return; e.preventDefault(); onMenu(folder, { x: e.clientX, y: e.clientY }, path); }}
      onKeyDown={(e) => {
        if (renaming) return;
        if (e.key === 'F2') { e.preventDefault(); rename.start(folder.id); }
        else if (e.key === 'Enter') onOpen(path);
        else if (e.key === 'ArrowRight' && !isOpen) onToggle?.(folder.id);
        else if (e.key === 'ArrowLeft' && isOpen) onToggle?.(folder.id);
      }}
      {...(dropProps ? dropProps(folder, `f:${folder.id}`) : {})}
    >
      {onToggle ? (
        <button type="button" className="nftr-twist" aria-label={isOpen ? `Свернуть «${folder.name}»` : `Раскрыть «${folder.name}»`} tabIndex={-1} disabled={leaf}
          onClick={(e) => { e.stopPropagation(); onToggle(folder.id); }}>
          {!leaf && <ChevronRight size={14} aria-hidden="true" data-open={isOpen ? 'true' : undefined} />}
        </button>
      ) : <span className="nftr-twist" aria-hidden="true" />}
      <Icon size={16} aria-hidden="true" className="nftr-ico" />
      {renaming ? <TreeRename folder={folder} /> : <span className="nftr-label" title={folder.name}>{folder.name}</span>}
      <Faces ids={shared} />
      {onMenu && (
        <button type="button" className="nftr-menu" aria-label={`Действия с папкой «${folder.name}»`} aria-haspopup="menu"
          onClick={(e) => { e.stopPropagation(); onMenu(folder, { element: e.currentTarget, align: 'start' }, path); }}>
          <MoreHorizontal size={15} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

const Level = memo(function Level({ parent, path, depth, childrenOf, open, current, dropOn, onToggle, onOpen, onMenu, dropProps }: {
  parent: string; path: CloudFolder[]; depth: number; childrenOf: Record<string, CloudFolder[]>; open: Set<string>; current: string | null;
  dropOn: string | null; onToggle: (id: string) => void; onOpen: (path: CloudFolder[]) => void; onMenu?: MenuOpener;
  dropProps: (dest: CloudFolder | null, key: string) => Record<string, unknown>;
}) {
  const list = childrenOf[parent];
  // Пока подпапки грузятся — ничего: строка «…» под каждой раскрытой папкой дёргала дерево при каждой загрузке.
  if (!list) return null;
  if (!list.length) return null;
  return (
    <>
      {list.map((f) => {
        const isOpen = open.has(f.id);
        const known = childrenOf[f.id];
        // Стрелка — только у папок с подпапками: знаем список — по нему, ещё нет — по признаку с сервера.
        const leaf = known !== undefined ? known.length === 0
          : f.hasFolders !== undefined ? !f.hasFolders : !(f.previewFiles || []).some((p) => p.fileType === 'folder');
        const here = [...path, f];
        return (
          <div key={f.id} role="group">
            <Row folder={f} path={here} depth={depth} isOpen={isOpen && !leaf} leaf={leaf} current={current} dropOn={dropOn}
              onToggle={onToggle} onOpen={onOpen} onMenu={onMenu} dropProps={dropProps} />
            {isOpen && <Level parent={f.id} path={here} depth={depth + 1} childrenOf={childrenOf} open={open} current={current} dropOn={dropOn} onToggle={onToggle} onOpen={onOpen} onMenu={onMenu} dropProps={dropProps} />}
          </div>
        );
      })}
    </>
  );
});

/** Поиск по всем папкам (сервер видит и нераскрытые, и вложенные в открытые вам): клик открывает папку с её путём. */
function TreeSearch({ query, onOpen, onMenu, current }: { query: string; onOpen: (path: CloudFolder[]) => void; onMenu?: MenuOpener; current: string | null }) {
  const [found, setFound] = useState<CloudFolder[] | null>(null);
  useEffect(() => {
    let alive = true;
    setFound(null);
    const timer = window.setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(query)}&limit=30`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : { folders: [] }))
        .then((j: { folders?: Array<{ id: string; name: string; parentId: string | null; color?: string | null }> }) => {
          if (alive) setFound((j.folders || []).map((f) => ({ id: f.id, name: f.name, parentId: f.parentId, color: f.color, ownerId: '', createdAt: '', updatedAt: '' })));
        })
        .catch(() => { if (alive) setFound([]); });
    }, 200);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [query]);
  const openFound = useCallback(async (f: CloudFolder) => { onOpen(await folderChain(f.id)); }, [onOpen]);
  const menuFound = useMemo<MenuOpener | undefined>(() => (onMenu ? (folder, anchor) => {
    void folderChain(folder.id).then((chain) => onMenu(chain[chain.length - 1] || folder, anchor, chain));
  } : undefined), [onMenu]);
  if (found === null) return <div className="nftr-loading" style={{ '--depth': 0 } as React.CSSProperties}>Ищу…</div>;
  if (!found.length) return <p className="nftr-empty">Папок «{query}» не нашлось</p>;
  return (
    <>
      {found.map((f) => (
        <Row key={f.id} folder={f} path={[f]} depth={0} isOpen={false} leaf current={current} dropOn={null}
          onOpen={() => void openFound(f)} onMenu={menuFound} />
      ))}
    </>
  );
}
