import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { realtime } from '@/shared/realtime/realtime';
import { lazyComponent } from '@/shared/ui/lazy';
import {
  AlertCircle, ArrowUpDown, Check, ChevronRight, Copy, Download, ExternalLink, Folder, FolderInput, FolderPlus, LayoutGrid, Link2, List,
  Mail, MoreHorizontal, Pencil, Pin, PinOff, RotateCw, Send, Trash2, Upload, Users,
} from 'lucide-react';
import { showToast } from '@/shared/ui/Toast';
import { SearchField } from '@/shared/ui/SearchField';
import { useChatStore, displayName } from '@/features/chat';
import { useMailConnected, writeMail } from '@/features/mail';
import type { ViewerItem } from '@/shared/ui/ImageViewer';
import { thumbUrl } from '@/shared/ui/media';
import { Avatar } from '@/shared/ui/Avatar';
import { askConfirm, Menu, MenuItem, type MenuAnchor } from '@/shared/ui/overlay';
import {
  cachedFolder, createFolder, deleteItem, fileUrl, fmtBytes, fmtDate, kindOf, loadFolder, myId, patchFolderCache,
  pinFolder, registerUpload, renameItem, setFolderColor, type CloudFile, type CloudFolder,
} from './api';
import { FileGlyph } from './FileGlyph';
import { FolderTile } from './FolderTile';
import { AccessSheet, MoveSheet, SendSheet } from './sheets';
import { absolute, links } from '@/shared/navigation/routes';
import { downloadFile } from '@/shared/platform/download';
import { viewKindOf, type FileRef } from '@/features/workspace';
import { DocOverlay } from './DocOverlay';

const ImageViewer = lazyComponent(() => import('@/shared/ui/ImageViewer'));

/**
 * «Мои файлы»: папки и файлы облака. Сетка или список, поиск по текущей
 * папке, загрузка кнопкой и перетаскиванием, действия — меню по ⋯, правому
 * клику и долгому нажатию. Менять и удалять может владелец и те, кому дали
 * редактирование; остальным — открыть, скачать, отправить.
 */

type Mode = 'grid' | 'list';
type Filter = 'all' | 'image' | 'video' | 'doc';
type Target = { kind: 'file'; item: CloudFile } | { kind: 'folder'; item: CloudFolder };
interface Uploading { id: string; name: string; pct: number }

const MODE_KEY = 'nx:files-mode';
const LONG_PRESS = 450;
const FOLDER_COLORS = ['#ff6b6b', '#ff9f43', '#f6c945', '#52c878', '#45c6c8', '#5a9cff', '#a783ff', '#9298a3'];

function readMode(): Mode {
  try { return localStorage.getItem(MODE_KEY) === 'list' ? 'list' : 'grid'; } catch { return 'grid'; }
}

const canEdit = (it: { ownerId: string; editAccess?: string[] }) =>
  String(it.ownerId) === myId() || (it.editAccess || []).map(String).includes(myId());

type SortId = 'new' | 'old' | 'name' | 'nameDesc' | 'big' | 'small';
const SORT_KEY = 'nf:sort';
const byName = (a: CloudFile, b: CloudFile) => a.name.localeCompare(b.name, 'ru', { numeric: true, sensitivity: 'base' });
const byNewest = (a: CloudFile, b: CloudFile) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
/** Сортировка файлов в папке; выбранную помним на этом устройстве. */
const SORTS: Record<SortId, { label: string; short: string; compare: (a: CloudFile, b: CloudFile) => number }> = {
  new: { label: 'Сначала новые', short: 'Новые', compare: byNewest },
  old: { label: 'Сначала старые', short: 'Старые', compare: (a, b) => -byNewest(a, b) },
  name: { label: 'По имени, А → Я', short: 'Имя А–Я', compare: (a, b) => byName(a, b) || byNewest(a, b) },
  nameDesc: { label: 'По имени, Я → А', short: 'Имя Я–А', compare: (a, b) => -byName(a, b) || byNewest(a, b) },
  big: { label: 'Сначала большие', short: 'Большие', compare: (a, b) => (b.size || 0) - (a.size || 0) || byNewest(a, b) },
  small: { label: 'Сначала маленькие', short: 'Маленькие', compare: (a, b) => (a.size || 0) - (b.size || 0) || byNewest(a, b) },
};
function readSort(): SortId {
  try { const v = localStorage.getItem(SORT_KEY); if (v && v in SORTS) return v as SortId; } catch { /* нет хранилища */ }
  return 'new';
}

export default function CloudView({ lead, trail, onOpenFolder, onCrumb, highlightId }: {
  lead?: ReactNode;
  trail: CloudFolder[];
  onOpenFolder: (f: CloudFolder) => void;
  onCrumb: (index: number) => void;
  highlightId?: string | null;
}) {
  const folderId = trail[trail.length - 1]?.id ?? null;
  const here = trail[trail.length - 1];
  const [data, setData] = useState(() => cachedFolder(folderId));
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>(() => (cachedFolder(folderId) ? 'ready' : 'loading'));
  const [mode, setMode] = useState<Mode>(readMode);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<{ target: Target; anchor: MenuAnchor } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [uploads, setUploads] = useState<Uploading[]>([]);
  const [dragging, setDragging] = useState(false);
  const [sheet, setSheet] = useState<{ type: 'move' | 'access' | 'send'; target: Target } | null>(null);
  const [viewer, setViewer] = useState<{ items: ViewerItem[]; start: number } | null>(null);
  /** Документ во встроенном просмотре (PDF, Word, Excel, CSV, текст, HTML). */
  const [doc, setDoc] = useState<FileRef | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const users = useChatStore((s) => s.users);

  const refresh = useCallback(async () => {
    try {
      const d = await loadFolder(folderId);
      setData(d);
      setPhase('ready');
    } catch {
      setPhase((p) => (p === 'ready' ? p : 'error'));
    }
  }, [folderId]);

  useEffect(() => {
    setData(cachedFolder(folderId));
    setPhase(cachedFolder(folderId) ? 'ready' : 'loading');
    setQuery('');
    void refresh();
  }, [folderId, refresh]);

  // Живое обновление: другой человек (или другое устройство) добавил, переименовал, перенёс или удалил файл —
  // открытая папка перечитывается сама, без ручного обновления страницы. Событие приходит без данных.
  useEffect(() => {
    let timer = 0;
    const off = realtime.subscribe((event) => {
      if (event.type !== 'cloud_changed') return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(), 350);
    });
    const onFocus = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => { off(); window.clearTimeout(timer); window.removeEventListener('focus', onFocus); };
  }, [refresh]);

  useEffect(() => { try { localStorage.setItem(MODE_KEY, mode); } catch { /* ignore */ } }, [mode]);

  // Файл по ссылке: прокрутить к нему и подсветить.
  useEffect(() => {
    if (!highlightId || !data) return;
    const el = document.querySelector<HTMLElement>(`[data-file-id="${CSS.escape(highlightId)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.dataset.flash = 'true';
    const t = window.setTimeout(() => { delete el.dataset.flash; }, 1600);
    return () => window.clearTimeout(t);
  }, [highlightId, data]);

  const q = query.trim().toLowerCase();
  const folders = useMemo(() => (data?.folders || []).filter((f) => !q || f.name.toLowerCase().includes(q)), [data, q]);
  const [sort, setSortState] = useState<SortId>(readSort);
  const [sortMenu, setSortMenu] = useState<MenuAnchor | null>(null);
  const setSort = (next: SortId) => { setSortState(next); try { localStorage.setItem(SORT_KEY, next); } catch { /* приватный режим — не запомним */ } };
  const files = useMemo(() => (data?.files || []).filter((f) => {
    if (q && !f.name.toLowerCase().includes(q)) return false;
    const k = kindOf(f.name, f.fileType, f.mimeType);
    if (filter === 'image') return k === 'image';
    if (filter === 'video') return k === 'video';
    if (filter === 'doc') return k !== 'image' && k !== 'video';
    return true;
  }).sort(SORTS[sort].compare), [data, q, filter, sort]);
  const images = useMemo(() => files.filter((f) => kindOf(f.name, f.fileType, f.mimeType) === 'image'), [files]);

  // ── Загрузка ──────────────────────────────────────────────────────────────
  const upload = async (list: FileList | File[]) => {
    const arr = Array.from(list).filter((f) => f.size > 0);
    if (!arr.length) return;
    const { uploadFileWithProgress } = await import('@/shared/api/uploadFile');
    const items = arr.map((f) => ({ id: crypto.randomUUID(), name: f.name, pct: 0 }));
    setUploads((u) => [...u, ...items]);
    let failed = 0;
    // По два файла за раз: большие фото с телефона не забивают сеть и память разом.
    const queue = arr.map((f, i) => ({ f, id: items[i].id }));
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const { f, id } = job;
        try {
          const res = await uploadFileWithProgress(f, (pct) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, pct } : x))));
          const saved = await registerUpload(f, res, folderId);
          setData((d) => (d ? { ...d, files: [saved, ...d.files] } : d));
          patchFolderCache(folderId, (d) => ({ ...d, files: [saved, ...d.files] }));
        } catch {
          failed++;
        } finally {
          setUploads((u) => u.filter((x) => x.id !== id));
        }
      }
    };
    await Promise.all([worker(), worker()]);
    if (failed) showToast(`Не загрузилось файлов: ${failed}. Проверьте связь и попробуйте ещё раз.`, 'error');
    void refresh();
  };

  // ── Действия ──────────────────────────────────────────────────────────────
  const commitRename = async (t: Target, name: string) => {
    setRenaming(null);
    const clean = name.trim();
    if (!clean || clean === t.item.name) return;
    const apply = (n: string) => setData((d) => (d ? {
      folders: d.folders.map((f) => (t.kind === 'folder' && f.id === t.item.id ? { ...f, name: n } : f)),
      files: d.files.map((f) => (t.kind === 'file' && f.id === t.item.id ? { ...f, name: n } : f)),
    } : d));
    apply(clean);
    try { await renameItem(t.kind, t.item.id, clean); void refresh(); } catch { apply(t.item.name); showToast('Не переименовал — нет связи с сервером.', 'error'); }
  };

  const commitCreate = async (name: string) => {
    setCreating(false);
    const clean = name.trim();
    if (!clean) return;
    try {
      const f = await createFolder(clean, folderId);
      setData((d) => (d ? { ...d, folders: [...d.folders, f] } : d));
      void refresh();
    } catch { showToast('Папка не создалась — нет связи с сервером.', 'error'); }
  };

  const remove = async (t: Target) => {
    const ok = await askConfirm({
      title: t.kind === 'folder' ? `Удалить папку «${t.item.name}»?` : `Удалить «${t.item.name}»?`,
      text: t.kind === 'folder' ? 'Папка удалится вместе со всем содержимым. Вернуть не получится.' : 'Файл пропадёт у всех, кому он открыт. Вернуть не получится.',
      confirm: 'Удалить',
      tone: 'danger',
    });
    if (!ok) return;
    const before = data;
    setData((d) => (d ? { folders: d.folders.filter((f) => f.id !== t.item.id), files: d.files.filter((f) => f.id !== t.item.id) } : d));
    try { await deleteItem(t.kind, t.item.id); void refresh(); } catch { setData(before); showToast('Не удалил — нет прав или нет связи с сервером.', 'error'); }
  };

  const togglePin = async (f: CloudFolder) => {
    setData((d) => (d ? { ...d, folders: d.folders.map((x) => (x.id === f.id ? { ...x, isPinned: !f.isPinned } : x)) } : d));
    await pinFolder(f.id, !f.isPinned);
    void refresh();
  };

  const recolor = async (f: CloudFolder, color: string | null) => {
    setData((d) => (d ? { ...d, folders: d.folders.map((x) => (x.id === f.id ? { ...x, color } : x)) } : d));
    await setFolderColor(f.id, color);
  };

  const openFile = (f: CloudFile) => {
    const k = kindOf(f.name, f.fileType, f.mimeType);
    if (k === 'image') {
      const items = images.map((x) => ({ url: fileUrl(x.url), name: x.name, date: fmtDate(x.createdAt) }));
      setViewer({ items, start: Math.max(0, images.findIndex((x) => x.id === f.id)) });
      return;
    }
    // Документы — во встроенном просмотре, остальное — скачать (не внешний браузер с адресом 127.0.0.1).
    if (viewKindOf(f.name)) { setDoc({ url: fileUrl(f.url), name: f.name, size: f.size }); return; }
    downloadFile(fileUrl(f.url), f.name);
  };

  const copyLink = async (t: Target) => {
    const url = absolute(t.kind === 'folder' ? links.folder(t.item.id) : links.file(t.item.id));
    try { await navigator.clipboard.writeText(url); showToast('Ссылка скопирована', 'success'); } catch { showToast('Не удалось скопировать ссылку', 'error'); }
  };

  const mailConnected = useMailConnected();
  const sendByMail = (t: Target) => {
    const url = absolute(t.kind === 'folder' ? links.folder(t.item.id) : links.file(t.item.id));
    writeMail({ subject: t.item.name, body: `${t.item.name}
${url}` });
  };

  // Меню: ⋯, правый клик, долгое нажатие.
  const press = useRef({ timer: 0, fired: false, x: 0, y: 0 });
  const itemHandlers = (t: Target) => ({
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); setMenu({ target: t, anchor: { x: e.clientX, y: e.clientY } }); },
    onTouchStart: (e: React.TouchEvent) => {
      const touch = e.touches[0];
      press.current = { ...press.current, fired: false, x: touch.clientX, y: touch.clientY };
      window.clearTimeout(press.current.timer);
      press.current.timer = window.setTimeout(() => {
        press.current.fired = true;
        navigator.vibrate?.(8);
        setMenu({ target: t, anchor: { x: touch.clientX, y: touch.clientY } });
      }, LONG_PRESS);
    },
    onTouchMove: (e: React.TouchEvent) => {
      const touch = e.touches[0];
      if (Math.hypot(touch.clientX - press.current.x, touch.clientY - press.current.y) > 8) window.clearTimeout(press.current.timer);
    },
    onTouchEnd: (e: React.TouchEvent) => { window.clearTimeout(press.current.timer); if (press.current.fired) e.preventDefault(); },
  });

  const moreBtn = (t: Target) => (
    <button
      type="button"
      className="nx-icon-btn nf-more"
      aria-label={`Действия: ${t.item.name}`}
      aria-haspopup="menu"
      onClick={(e) => { e.stopPropagation(); setMenu({ target: t, anchor: { element: e.currentTarget, align: 'end' } }); }}
    >
      <MoreHorizontal size={16} aria-hidden="true" />
    </button>
  );

  const nameOrInput = (t: Target) => (renaming === t.item.id ? (
    <InlineName initial={t.item.name} onCommit={(n) => void commitRename(t, n)} onCancel={() => setRenaming(null)} />
  ) : <span className="nf-name" title={t.item.name}>{t.item.name}</span>);

  // ── Разметка ──────────────────────────────────────────────────────────────
  let body: ReactNode;
  if (!data && phase === 'loading') {
    body = (
      <div className={`nf-items nf-${mode}`} aria-busy="true" aria-label="Загружаю файлы">
        {Array.from({ length: 8 }, (_, i) => <div key={i} className="nf-item nf-skel"><span className="nx-skel nf-skel-thumb" /><span className="nx-skel nx-skel-line" /></div>)}
      </div>
    );
  } else if (!data && phase === 'error') {
    body = (
      <div className="nx-state" data-tone="danger" role="alert">
        <AlertCircle size={28} aria-hidden="true" />
        <h2>Не загрузил файлы</h2>
        <p>Сервер не ответил. Проверьте связь и повторите.</p>
        <button type="button" className="nx-ghost" onClick={() => void refresh()}><RotateCw size={14} aria-hidden="true" /> Повторить</button>
      </div>
    );
  } else if (!folders.length && !files.length && !creating && !uploads.length) {
    body = (
      <div className="nx-state nf-empty">
        <Upload size={30} aria-hidden="true" />
        <h2>{q || filter !== 'all' ? 'Ничего не нашёл' : 'Папка пуста'}</h2>
        <p>{q || filter !== 'all' ? 'Попробуйте другой запрос или снимите фильтр.' : 'Перетащите сюда файлы или нажмите «Загрузить».'}</p>
        {q || filter !== 'all'
          ? <button type="button" className="nx-ghost" onClick={() => { setQuery(''); setFilter('all'); }}>Сбросить</button>
          : <button type="button" className="nx-primary" onClick={() => fileInput.current?.click()}><Upload size={16} aria-hidden="true" /> Загрузить</button>}
      </div>
    );
  } else {
    body = (
      <>
        {(folders.length > 0 || creating) && (
          <section aria-label="Папки">
            <h3 className="nf-group">Папки</h3>
            <div className={`nf-items nf-${mode}`}>
              {creating && (
                <div className="nf-item nf-folder" data-editing="true">
                  {mode === 'grid'
                    ? <span className="nft"><span className="nft-empty">Пусто</span></span>
                    : <span className="nf-thumb"><Folder size={22} aria-hidden="true" /></span>}
                  <InlineName initial="Новая папка" onCommit={(n) => void commitCreate(n)} onCancel={() => setCreating(false)} />
                </div>
              )}
              {folders.map((f) => {
                const t: Target = { kind: 'folder', item: f };
                return (
                  <div
                    key={f.id}
                    role="button"
                    tabIndex={0}
                    className="nf-item nf-folder"
                    style={f.color ? ({ '--folder': f.color } as CSSProperties) : undefined}
                    onClick={() => { if (renaming !== f.id) onOpenFolder(f); }}
                    onKeyDown={(e) => { if (e.key === 'Enter' && renaming !== f.id) onOpenFolder(f); }}
                    {...itemHandlers(t)}
                  >
                    {mode === 'grid'
                      ? <FolderTile folder={f} />
                      : <span className="nf-thumb"><Folder size={22} aria-hidden="true" /></span>}
                    <span className="nf-text">
                      {nameOrInput(t)}
                      <span className="nf-meta">
                        {mode === 'list' && f.isPinned && <Pin size={11} aria-hidden="true" />}
                        {typeof f.fileCount === 'number' ? `${f.fileCount} ${f.fileCount === 1 ? 'файл' : f.fileCount < 5 && f.fileCount > 0 ? 'файла' : 'файлов'}` : fmtDate(f.updatedAt)}
                        {mode === 'list' && (f.sharedWith?.length || 0) > 0 && <><Users size={11} aria-hidden="true" /> {f.sharedWith!.length}</>}
                      </span>
                    </span>
                    {moreBtn(t)}
                  </div>
                );
              })}
            </div>
          </section>
        )}
        {(files.length > 0 || uploads.length > 0) && (
          <section aria-label="Файлы">
            <h3 className="nf-group">Файлы</h3>
            <div className={`nf-items nf-${mode}`}>
              {uploads.map((u) => (
                <div key={u.id} className="nf-item nf-uploading" aria-busy="true">
                  <span className="nf-thumb"><Upload size={mode === 'grid' ? 28 : 18} aria-hidden="true" /></span>
                  <span className="nf-text">
                    <span className="nf-name">{u.name}</span>
                    <span className="nf-progress" role="progressbar" aria-valuenow={u.pct} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${u.pct}%` }} /></span>
                  </span>
                </div>
              ))}
              {files.map((f) => {
                const t: Target = { kind: 'file', item: f };
                const k = kindOf(f.name, f.fileType, f.mimeType);
                const owner = String(f.ownerId) !== myId() ? users[String(f.ownerId)] : undefined;
                return (
                  <div
                    key={f.id}
                    role="button"
                    tabIndex={0}
                    className="nf-item nf-file"
                    data-file-id={f.id}
                    onClick={() => { if (renaming !== f.id) openFile(f); }}
                    onKeyDown={(e) => { if (e.key === 'Enter' && renaming !== f.id) openFile(f); }}
                    {...itemHandlers(t)}
                  >
                    <span className="nf-thumb" data-kind={k}>
                      {k === 'image'
                        ? <img src={thumbUrl(fileUrl(f.url), mode === 'grid' ? 320 : 64)} alt="" loading="lazy" decoding="async" draggable={false} />
                        : <FileGlyph name={f.name} kind={k} size={mode === 'grid' ? 'lg' : 'sm'} />}
                    </span>
                    <span className="nf-text">
                      {nameOrInput(t)}
                      <span className="nf-meta">
                        {[fmtBytes(f.size), fmtDate(f.createdAt)].filter(Boolean).join(' · ')}
                        {owner && <span className="nf-owner" title={`Владелец: ${displayName(owner)}`}><Avatar name={displayName(owner)} seed={String(owner.id)} src={owner.avatar} person size={14} /></span>}
                      </span>
                    </span>
                    {moreBtn(t)}
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </>
    );
  }

  const t = menu?.target;
  return (
    <section
      className="nf-view"
      data-dragging={dragging ? 'true' : undefined}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={(e) => { e.preventDefault(); setDragging(false); void upload(e.dataTransfer.files); }}
    >
      <header className="nf-bar">
        <div className="nf-left">
        {lead}
        <nav className="nf-crumbs" aria-label="Путь">
          {trail.length > 0 && <button type="button" className="nf-crumb" onClick={() => onCrumb(-1)}>Мои файлы</button>}
          {trail.map((f, i) => (
            <span key={f.id} className="nf-crumb-wrap">
              <ChevronRight size={14} aria-hidden="true" />
              <button type="button" className="nf-crumb" aria-current={i === trail.length - 1 ? 'page' : undefined} onClick={() => onCrumb(i)}>{f.name}</button>
            </span>
          ))}
        </nav>
        </div>
        <SearchField className="nf-search" value={query} onChange={setQuery} placeholder="Поиск в папке" />
        <div className="nf-tools">
          <div className="nx-segment" role="group" aria-label="Тип файлов">
            {([['all', 'Все'], ['image', 'Фото'], ['video', 'Видео'], ['doc', 'Документы']] as [Filter, string][]).map(([id, label]) => (
              <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>
            ))}
          </div>
          <button type="button" className="nx-ghost nf-act" aria-haspopup="menu" aria-expanded={Boolean(sortMenu)} title={`Сортировка: ${SORTS[sort].label}`} aria-label={`Сортировка: ${SORTS[sort].label}`}
            onClick={(e) => setSortMenu({ element: e.currentTarget, align: 'end' })}><ArrowUpDown size={15} aria-hidden="true" /><span className="nf-btn-label">{SORTS[sort].short}</span></button>
          <div className="nx-segment" role="group" aria-label="Вид">
            <button type="button" aria-pressed={mode === 'grid'} onClick={() => setMode('grid')} aria-label="Сеткой"><LayoutGrid size={14} /></button>
            <button type="button" aria-pressed={mode === 'list'} onClick={() => setMode('list')} aria-label="Списком"><List size={14} /></button>
          </div>
          <button type="button" className="nx-ghost nf-act" onClick={() => setCreating(true)} disabled={creating} aria-label="Новая папка"><FolderPlus size={15} aria-hidden="true" /><span className="nf-btn-label">Новая папка</span></button>
          <button type="button" className="nx-primary nf-act" onClick={() => fileInput.current?.click()} aria-label="Загрузить"><Upload size={15} aria-hidden="true" /><span className="nf-btn-label">Загрузить</span></button>
        </div>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { if (e.target.files) void upload(e.target.files); e.target.value = ''; }} />
      </header>

      <div className="nf-scroll nx-scroll-y">{body}</div>

      {sortMenu && (
        <Menu anchor={sortMenu} label="Сортировка файлов" onClose={() => setSortMenu(null)}>
          {(Object.keys(SORTS) as SortId[]).map((id) => (
            <MenuItem key={id} icon={sort === id ? <Check size={15} /> : <span style={{ width: 15 }} />} onSelect={() => { setSortMenu(null); setSort(id); }}>{SORTS[id].label}</MenuItem>
          ))}
        </Menu>
      )}

      {dragging && (
        <div className="nf-drop" aria-hidden="true">
          <Upload size={28} />
          <span>Отпустите, чтобы загрузить в «{here?.name || 'Мои файлы'}»</span>
        </div>
      )}

      {menu && t && (
        <Menu anchor={menu.anchor} label={t.item.name} onClose={() => setMenu(null)}>
          {t.kind === 'folder' ? (
            <MenuItem icon={<Folder size={16} />} onSelect={() => { setMenu(null); onOpenFolder(t.item); }}>Открыть</MenuItem>
          ) : (
            <>
              <MenuItem icon={<ExternalLink size={16} />} onSelect={() => { setMenu(null); openFile(t.item); }}>Открыть</MenuItem>
              <MenuItem icon={<Download size={16} />} onSelect={() => { setMenu(null); downloadFile(fileUrl(t.item.url), t.item.name); }}>Скачать</MenuItem>
            </>
          )}
          <MenuItem icon={<Send size={16} />} onSelect={() => { setMenu(null); setSheet({ type: 'send', target: t }); }}>Отправить в чат</MenuItem>
          {mailConnected && <MenuItem icon={<Mail size={16} />} onSelect={() => { setMenu(null); sendByMail(t); }}>Отправить по почте</MenuItem>}
          <MenuItem icon={<Link2 size={16} />} onSelect={() => { setMenu(null); void copyLink(t); }}>Копировать ссылку</MenuItem>
          {canEdit(t.item) && (
            <>
              <div className="nx-menu-sep" />
              <MenuItem icon={<Pencil size={16} />} onSelect={() => { setMenu(null); setRenaming(t.item.id); }}>Переименовать</MenuItem>
              <MenuItem icon={<FolderInput size={16} />} onSelect={() => { setMenu(null); setSheet({ type: 'move', target: t }); }}>Переместить</MenuItem>
              <MenuItem icon={<Users size={16} />} onSelect={() => { setMenu(null); setSheet({ type: 'access', target: t }); }}>Доступ</MenuItem>
              {t.kind === 'folder' && (
                <>
                  <MenuItem icon={t.item.isPinned ? <PinOff size={16} /> : <Pin size={16} />} onSelect={() => { setMenu(null); void togglePin(t.item as CloudFolder); }}>
                    {t.item.isPinned ? 'Открепить' : 'Закрепить'}
                  </MenuItem>
                  <div className="nf-colors" role="group" aria-label="Цвет папки">
                    <button type="button" className="nf-color" data-none="true" aria-label="Без цвета" aria-pressed={!t.item.color} onClick={() => { setMenu(null); void recolor(t.item as CloudFolder, null); }} />
                    {FOLDER_COLORS.map((c) => (
                      <button key={c} type="button" className="nf-color" style={{ '--c': c } as CSSProperties} aria-label={`Цвет ${c}`} aria-pressed={t.item.color === c} onClick={() => { setMenu(null); void recolor(t.item as CloudFolder, c); }} />
                    ))}
                  </div>
                </>
              )}
              <div className="nx-menu-sep" />
              <MenuItem icon={<Trash2 size={16} />} tone="danger" onSelect={() => { setMenu(null); void remove(t); }}>Удалить</MenuItem>
            </>
          )}
          {!canEdit(t.item) && t.kind === 'file' && (
            <MenuItem icon={<Copy size={16} />} onSelect={() => { setMenu(null); void navigator.clipboard.writeText(t.item.name).catch(() => {}); }}>Копировать имя</MenuItem>
          )}
        </Menu>
      )}

      {sheet?.type === 'move' && <MoveSheet item={sheet.target.item} kind={sheet.target.kind} onClose={() => setSheet(null)} onDone={() => { setSheet(null); void refresh(); }} />}
      {sheet?.type === 'access' && <AccessSheet item={sheet.target.item} kind={sheet.target.kind} onClose={() => setSheet(null)} onDone={() => { setSheet(null); void refresh(); }} />}
      {sheet?.type === 'send' && (
        <SendSheet
          onClose={() => setSheet(null)}
          item={sheet.target.kind === 'file'
            ? { id: sheet.target.item.id, name: sheet.target.item.name, url: fileUrl(sheet.target.item.url), fileType: kindOf(sheet.target.item.name, sheet.target.item.fileType, sheet.target.item.mimeType) === 'image' ? 'image' : sheet.target.item.fileType, preview: kindOf(sheet.target.item.name, sheet.target.item.fileType) === 'image' ? fileUrl(sheet.target.item.url) : undefined }
            : { id: sheet.target.item.id, name: sheet.target.item.name, url: links.folder(sheet.target.item.id), fileType: 'folder', isFolder: true }}
        />
      )}
      {viewer && <ImageViewer items={viewer.items} start={viewer.start} onClose={() => setViewer(null)} />}
      {doc && <DocOverlay file={doc} onClose={() => setDoc(null)} />}
    </section>
  );
}

/** Имя в режиме правки: Enter — сохранить, Esc — отменить, уход фокуса — сохранить. */
function InlineName({ initial, onCommit, onCancel }: { initial: string; onCommit: (name: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Выделяем имя без расширения — как в Finder.
    const dot = initial.lastIndexOf('.');
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(ref.current?.value || ''); else onCancel();
  };
  return (
    <input
      ref={ref}
      className="nf-rename"
      defaultValue={initial}
      aria-label="Имя"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
}
