import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronRight, Folder, FolderOpen, HardDrive, MoreHorizontal } from 'lucide-react';
import { displayName, useChatStore } from '@/features/chat';
import { realtime } from '@/shared/realtime/realtime';
import { Avatar } from '@/shared/ui/Avatar';
import { SearchField } from '@/shared/ui/SearchField';
import type { MenuAnchor } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import { cachedFolder, folderChain, loadFolder, moveFile, moveFolder, prefetchFolder, type CloudFolder } from './api';

/**
 * Дерево папок «Файлов» сбоку — как дерево в «Офисе»: корень «Мои файлы», папки раскрываются стрелкой (значок открытой и
 * закрытой папки), вложенные подгружаются при раскрытии (и заранее — при наведении). Текущая папка подсвечена, путь к ней
 * раскрыт сам. У папки — то же меню действий, что у плитки (ПКМ или «⋯»), и аватарки тех, кому она открыта.
 * Сверху — поиск по папкам (по всем, не только раскрытым). На папку дерева можно бросить файл или папку из списка справа.
 */

const OPEN_KEY = 'nf:tree-open';
const DRAG_TYPE = 'application/x-shar-cloud-item';
/** Одна аватарка и кружок «+N» с остальными: строка дерева узкая, ряд из трёх лиц теснил названия. */
const MAX_FACES = 1;

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
  const [open, setOpen] = useState<Set<string>>(readOpen);
  const [children, setChildren] = useState<Record<string, CloudFolder[]>>((): Record<string, CloudFolder[]> => {
    const root = cachedFolder(null);
    return root ? { '': root.folders } : {};
  });
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const load = useCallback(async (id: string | null) => {
    try {
      const d = await loadFolder(id);
      setChildren((cur) => ({ ...cur, [id || '']: d.folders }));
    } catch { /* нет связи — оставим, что было */ }
  }, []);

  useEffect(() => { void load(null); }, [load]);
  useEffect(() => {
    if (!trail.length) return;
    setOpen((cur) => {
      const next = new Set(cur);
      trail.slice(0, -1).forEach((f) => next.add(f.id));
      return next;
    });
  }, [trail]);
  useEffect(() => {
    open.forEach((id) => { if (!(id in children)) void load(id); });
    try { localStorage.setItem(OPEN_KEY, JSON.stringify([...open].slice(-200))); } catch { /* без памяти */ }
  }, [open, children, load]);

  useEffect(() => {
    let timer = 0;
    return realtime.subscribe((event) => {
      if (event.type !== 'cloud_changed') return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { void load(null); open.forEach((id) => void load(id)); }, 500);
    });
  }, [load, open]);

  const toggle = useCallback((id: string) => setOpen((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }), []);

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

  return (
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
  );
}

/** Аватарки тех, кому папка открыта: до трёх, остальные — «+N». */
function Faces({ ids }: { ids: string[] }) {
  const users = useChatStore((s) => s.users);
  if (!ids.length) return null;
  const shown = ids.filter((id) => !id.startsWith('dept:')).map((id) => users[id]).filter(Boolean).slice(0, MAX_FACES);
  const more = ids.length - shown.length;
  return (
    <span className="nftr-faces" title={`Открыта: ${ids.length}`}>
      {shown.map((u) => <Avatar key={u.id} name={displayName(u)} seed={String(u.id)} src={u.avatar} person size={16} />)}
      {more > 0 && <span className="nftr-more-faces">+{more}</span>}
    </span>
  );
}

function Row({ folder, path, depth, isOpen, leaf, current, dropOn, onToggle, onOpen, onMenu, dropProps }: {
  folder: CloudFolder; path: CloudFolder[]; depth: number; isOpen: boolean; leaf: boolean; current: string | null; dropOn: string | null;
  onToggle?: (id: string) => void; onOpen: (path: CloudFolder[]) => void; onMenu?: MenuOpener;
  dropProps?: (dest: CloudFolder | null, key: string) => Record<string, unknown>;
}) {
  const shared = [...new Set([...(folder.sharedWith || []), ...(folder.editAccess || [])].map(String))].filter((id) => id !== String(folder.ownerId));
  const Icon = isOpen ? FolderOpen : Folder;
  return (
    <div
      className="nftr-row"
      role="button"
      tabIndex={0}
      aria-current={current === folder.id ? 'page' : undefined}
      aria-expanded={leaf || !onToggle ? undefined : isOpen}
      data-drop={dropOn === `f:${folder.id}` ? 'true' : undefined}
      style={{ '--depth': depth, '--folder': folder.color || undefined } as React.CSSProperties}
      onClick={() => onOpen(path)}
      onMouseEnter={() => prefetchFolder(folder.id)}
      onContextMenu={(e) => { if (!onMenu) return; e.preventDefault(); onMenu(folder, { x: e.clientX, y: e.clientY }, path); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen(path);
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
      <span className="nftr-label" title={folder.name}>{folder.name}</span>
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
  if (!list) return parent ? <div className="nftr-loading" style={{ '--depth': depth } as React.CSSProperties}>…</div> : null;
  if (!list.length) return null;
  return (
    <>
      {list.map((f) => {
        const isOpen = open.has(f.id);
        const known = childrenOf[f.id];
        const leaf = known !== undefined && known.length === 0;
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
