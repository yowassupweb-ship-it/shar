import { memo, useCallback, useEffect, useState } from 'react';
import { ChevronRight, Folder, HardDrive } from 'lucide-react';
import { realtime } from '@/shared/realtime/realtime';
import { cachedFolder, loadFolder, moveFile, moveFolder, type CloudFolder } from './api';
import { showToast } from '@/shared/ui/Toast';

/**
 * Дерево папок «Файлов» сбоку — как дерево в «Офисе»: корень «Мои файлы», папки раскрываются стрелкой, вложенные
 * подгружаются при раскрытии (и берутся из кэша раздела, если уже были открыты). Текущая папка подсвечена, путь к ней
 * раскрыт сам. Клик — открыть папку; на папку дерева можно бросить файл или папку из списка справа.
 */

const OPEN_KEY = 'nf:tree-open';
const DRAG_TYPE = 'application/x-shar-cloud-item';

function readOpen(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || '[]') as string[]); } catch { return new Set(); }
}

export function FolderTree({ trail, onOpen, onMoved }: {
  /** Цепочка от корня до открытой папки. */
  trail: CloudFolder[];
  /** Открыть папку: путь от корня до неё (пустой — корень). */
  onOpen: (path: CloudFolder[]) => void;
  /** Что-то перенесли в папку дерева — открытая папка должна перечитаться. */
  onMoved?: () => void;
}) {
  const [open, setOpen] = useState<Set<string>>(readOpen);
  const [children, setChildren] = useState<Record<string, CloudFolder[]>>((): Record<string, CloudFolder[]> => {
    const root = cachedFolder(null);
    return root ? { '': root.folders } : {};
  });
  const [dropOn, setDropOn] = useState<string | null>(null);

  const load = useCallback(async (id: string | null) => {
    try {
      const d = await loadFolder(id);
      setChildren((cur) => ({ ...cur, [id || '']: d.folders }));
    } catch { /* нет связи — оставим, что было */ }
  }, []);

  // Корень и раскрытые папки — при открытии; путь к текущей папке раскрываем сам.
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

  // Другой человек или вкладка поменяли папки — перечитываем то, что видно.
  useEffect(() => {
    let timer = 0;
    return realtime.subscribe((event) => {
      if (event.type !== 'cloud_changed') return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { void load(null); open.forEach((id) => void load(id)); }, 500);
    });
  }, [load, open]);

  const toggle = (id: string) => setOpen((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

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
      <Level parent="" path={[]} depth={1} childrenOf={children} open={open} current={current} dropOn={dropOn} onToggle={toggle} onOpen={onOpen} dropProps={dropProps} />
    </nav>
  );
}

const Level = memo(function Level({ parent, path, depth, childrenOf, open, current, dropOn, onToggle, onOpen, dropProps }: {
  parent: string; path: CloudFolder[]; depth: number; childrenOf: Record<string, CloudFolder[]>; open: Set<string>; current: string | null;
  dropOn: string | null; onToggle: (id: string) => void; onOpen: (path: CloudFolder[]) => void;
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
            <div
              className="nftr-row"
              role="button"
              tabIndex={0}
              aria-current={current === f.id ? 'page' : undefined}
              aria-expanded={leaf ? undefined : isOpen}
              data-drop={dropOn === `f:${f.id}` ? 'true' : undefined}
              style={{ '--depth': depth, '--folder': f.color || undefined } as React.CSSProperties}
              onClick={() => onOpen(here)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onOpen(here);
                else if (e.key === 'ArrowRight' && !isOpen) onToggle(f.id);
                else if (e.key === 'ArrowLeft' && isOpen) onToggle(f.id);
              }}
              {...dropProps(f, `f:${f.id}`)}
            >
              <button
                type="button"
                className="nftr-twist"
                aria-label={isOpen ? `Свернуть «${f.name}»` : `Раскрыть «${f.name}»`}
                tabIndex={-1}
                disabled={leaf}
                onClick={(e) => { e.stopPropagation(); onToggle(f.id); }}
              >
                {!leaf && <ChevronRight size={14} aria-hidden="true" data-open={isOpen ? 'true' : undefined} />}
              </button>
              <Folder size={16} aria-hidden="true" className="nftr-ico" />
              <span className="nftr-label" title={f.name}>{f.name}</span>
            </div>
            {isOpen && <Level parent={f.id} path={here} depth={depth + 1} childrenOf={childrenOf} open={open} current={current} dropOn={dropOn} onToggle={onToggle} onOpen={onOpen} dropProps={dropProps} />}
          </div>
        );
      })}
    </>
  );
});
