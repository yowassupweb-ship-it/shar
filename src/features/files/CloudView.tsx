import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { HiddenMark } from '@/shared/core/HiddenMark';
import { realtime } from '@/shared/realtime/realtime';
import { lazyComponent } from '@/shared/ui/lazy';
import {
  AlertCircle, ArrowUpDown, Check, Archive, ChevronDown, ChevronRight, ClipboardPaste, Copy, Download, Files, ExternalLink, Folder, FolderInput, FolderPlus, LayoutGrid, Link2, List,
  FileUp, Filter, History, Info, Mail, MoreHorizontal, Pencil, Pin, PinOff, RotateCw, Send, Trash2, Upload, Users, PenLine, X } from 'lucide-react';
import { showToast } from '@/shared/ui/Toast';
import { AgentMenuItems } from '@/shared/core/AgentMenuItems';
import { SearchField } from '@/shared/ui/SearchField';
import { useChatStore, displayName } from '@/features/chat';
import { useMailConnected, writeMail } from '@/features/mail';
import type { ViewerItem } from '@/shared/ui/ImageViewer';
import { thumbUrl } from '@/shared/ui/media';
import { Avatar } from '@/shared/ui/Avatar';
import { askConfirm, Menu, MenuItem, type MenuAnchor } from '@/shared/ui/overlay';
import {
  cachedFolder, createFolder, deleteItem, fetchImageDims, fileUrl, fmtBytes, fmtDate, fmtDateShort, kindOf, loadFolder, myId, patchFolderCache,
  moveFile, moveFolder, pinFolder, registerUpload, renameItem, replaceFileContent, setFolderColor, type CloudFile, type CloudFolder,
} from './api';
import { FileGlyph } from './FileGlyph';
import { FolderTile } from './FolderTile';
import { AccessSheet, MoveSheet, SendSheet } from './sheets';
import { PropertiesSheet } from './PropertiesSheet';
import { VersionsSheet } from './VersionsSheet';
import { useInheritedAccess } from './inherited';
import { copyFiles, duplicateAsFile, forgetHeld, heldFiles, uniqueName } from './clipboard';
import { absolute, links } from '@/shared/navigation/routes';
import { downloadFile, downloadMany } from '@/shared/platform/download';
import { recordVisit } from '@/features/spotlight';
import { canOpenInEditor, openInEditor, viewKindOf, type FileRef } from '@/features/workspace';
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
const FILTERS: Record<Filter, string> = { all: 'Все файлы', image: 'Фото', video: 'Видео', doc: 'Документы' };
type Target = { kind: 'file'; item: CloudFile } | { kind: 'folder'; item: CloudFolder };
interface Uploading { id: string; name: string; pct: number }

/** Тип перетаскивания «свой файл или папка внутри раздела»; чужие файлы с рабочего стола приходят как «Files». */
const DRAG_TYPE = 'application/x-shar-cloud-item';
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
  const [sheet, setSheet] = useState<{ type: 'move' | 'access' | 'send' | 'props' | 'versions'; target: Target } | null>(null);
  const [viewer, setViewer] = useState<{ items: ViewerItem[]; start: number } | null>(null);
  /** Документ во встроенном просмотре (PDF, Word, Excel, CSV, текст, HTML). */
  const [doc, setDoc] = useState<FileRef | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const users = useChatStore((s) => s.users);

  // Какая папка открыта сейчас. Ответ на запрос другой папки (корня, который грузился, пока из адреса разбиралась
  // цепочка ?file=…) приходит позже и без этой проверки затирал бы содержимое — в крошках одна папка, в окне другая.
  const openFolderId = useRef(folderId);
  openFolderId.current = folderId;
  const refresh = useCallback(async () => {
    try {
      const d = await loadFolder(folderId);
      if (openFolderId.current !== folderId) return;
      setData(d);
      setPhase('ready');
    } catch {
      if (openFolderId.current !== folderId) return;
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
  // Верхний фильтр («Фото», «Видео», «Документы») сужает и папки: остаются те, где такое лежит (с вложенными).
  const folders = useMemo(() => (data?.folders || []).filter((f) => {
    if (q && !f.name.toLowerCase().includes(q)) return false;
    return filter === 'all' || (f.kinds?.[filter] || 0) > 0;
  }), [data, q, filter]);
  const [sort, setSortState] = useState<SortId>(readSort);
  const [sortMenu, setSortMenu] = useState<MenuAnchor | null>(null);
  const [filterMenu, setFilterMenu] = useState<MenuAnchor | null>(null);
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

  // Разрешение фото под плиткой: сервер читает его из заголовка файла один раз и запоминает; здесь — только то, что на экране.
  const [dims, setDims] = useState<Record<string, [number, number]>>({});
  const missingDims = useMemo(() => images.filter((f) => !dims[f.id]).slice(0, 60).map((f) => f.id), [images, dims]);
  useEffect(() => {
    if (!missingDims.length) return undefined;
    let alive = true;
    void fetchImageDims(missingDims).then((got) => {
      if (!alive) return;
      // Что сервер не смог прочесть (svg, битый файл), помечаем нулём — второй раз не спрашиваем.
      setDims((cur) => ({ ...cur, ...Object.fromEntries(missingDims.map((id) => [id, [0, 0] as [number, number]])), ...got }));
    });
    return () => { alive = false; };
  }, [missingDims]);

  // ── Загрузка ──────────────────────────────────────────────────────────────
  const upload = async (list: FileList | File[], into: string | null = folderId) => {
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
          const saved = await registerUpload(f, res, into);
          // В открытую папку файл виден сразу; залитый в соседнюю — только в её кэше.
          if (into === folderId) setData((d) => (d ? { ...d, files: [saved, ...d.files] } : d));
          patchFolderCache(into, (d) => ({ ...d, files: [saved, ...d.files] }));
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
    // sub: у картинки — адрес для превью, у остальных пусто (значок формата берётся из имени).
    recordVisit({ id: f.id, kind: 'file', title: f.name, subtitle: 'Файл', sub: k === 'image' ? `img|${f.url}` : undefined, path: links.file(f.id) });
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

  // ── Выбор нескольких ──────────────────────────────────────────────────────
  // Галочка на плитке, Ctrl/Cmd+клик, Shift+клик — диапазон, Ctrl+A — всё в папке, Esc — снять. Пока что-то выбрано,
  // обычный клик не открывает, а выбирает. Скачать выбранное можно архивом или каждый файл отдельно.
  const [selected, setSelected] = useState<Record<string, 'file' | 'folder'>>({});
  const selectedCount = Object.keys(selected).length;
  const anchorRef = useRef<string | null>(null);
  const [downloadMenu, setDownloadMenu] = useState<MenuAnchor | null>(null);
  useEffect(() => { setSelected({}); anchorRef.current = null; }, [folderId]);

  const ordered = useMemo(() => [
    ...folders.map((f) => ({ id: f.id, kind: 'folder' as const })),
    ...files.map((f) => ({ id: f.id, kind: 'file' as const })),
  ], [folders, files]);

  const toggleSelect = (id: string, kind: 'file' | 'folder', range = false) => {
    setSelected((cur) => {
      const next = { ...cur };
      const from = anchorRef.current ? ordered.findIndex((x) => x.id === anchorRef.current) : -1;
      const to = ordered.findIndex((x) => x.id === id);
      if (range && from >= 0 && to >= 0) {
        for (const x of ordered.slice(Math.min(from, to), Math.max(from, to) + 1)) next[x.id] = x.kind;
      } else if (id in next) delete next[id]; else next[id] = kind;
      return next;
    });
    anchorRef.current = id;
  };
  /** Клик по плитке: при выборе — отметить, иначе открыть. */
  const pick = (e: React.MouseEvent | React.KeyboardEvent, id: string, kind: 'file' | 'folder', open: () => void) => {
    if (selectedCount > 0 || e.ctrlKey || e.metaKey || e.shiftKey) { e.preventDefault(); toggleSelect(id, kind, e.shiftKey); return; }
    open();
  };
  const checkBox = (id: string, kind: 'file' | 'folder', name: string) => (
    <button
      type="button"
      className="nf-check"
      role="checkbox"
      aria-checked={id in selected}
      aria-label={`Выбрать: ${name}`}
      onClick={(e) => { e.stopPropagation(); toggleSelect(id, kind, e.shiftKey); }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <Check size={12} strokeWidth={3} aria-hidden="true" />
    </button>
  );

  const selectedFiles = () => files.filter((f) => selected[f.id] === 'file');
  const selectedFolders = () => folders.filter((f) => selected[f.id] === 'folder');
  const downloadZip = () => {
    const fs = selectedFiles();
    const dirs = selectedFolders();
    const params = new URLSearchParams();
    if (fs.length) params.set('files', fs.map((f) => f.id).join(','));
    if (dirs.length) params.set('folders', dirs.map((f) => f.id).join(','));
    const name = dirs.length === 1 && !fs.length ? dirs[0].name : (here?.name || 'Файлы Шара');
    params.set('name', name);
    downloadFile(`/api/cloud/zip?${params.toString()}`, `${name}.zip`);
    showToast('Готовлю архив…', 'info');
  };
  const downloadSeparately = async () => {
    const list = selectedFiles();
    if (!list.length) return;
    const res = await downloadMany(list.map((f) => ({ url: fileUrl(f.url), name: f.name })));
    if (!res) return;
    showToast(res.failed ? `Скачано: ${res.saved}, не удалось: ${res.failed}` : `Скачано файлов: ${res.saved}`, res.failed ? 'error' : 'success');
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (e.key === 'Escape' && Object.keys(selectedRef.current).length) { setSelected({}); return; }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.code === 'KeyA' && !live.current.busy) {
        e.preventDefault();
        setSelected(Object.fromEntries(orderedRef.current.map((x) => [x.id, x.kind])));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const orderedRef = useRef(ordered);
  orderedRef.current = ordered;

  // ── Буфер обмена ──────────────────────────────────────────────────────────
  // Копировать: файл уходит в системный буфер (в приложении — как файл) и запоминается в разделе. Вставить: Ctrl+V,
  // «Вставить» в меню пустого места. Файлы из системного буфера (из Проводника, скриншот, скопированное здесь) грузятся
  // в открытую папку; скопированное в разделе, но недоступное системе (браузер), — делается копией.
  const [pasteMenu, setPasteMenu] = useState<MenuAnchor | null>(null);

  const copyFile = async (f: CloudFile) => {
    const how = await copyFiles([f]);
    showToast(how === 'system' ? 'Файл скопирован — вставьте его в папку, чат или Проводник'
      : how === 'image' ? 'Картинка скопирована' : 'Файл скопирован — вставьте его в нужную папку', 'success');
  };

  const pasteHeld = async () => {
    const list = heldFiles();
    if (!list.length) return;
    const taken = new Set((data?.files || []).map((x) => x.name));
    try {
      const copies: File[] = [];
      for (const f of list) {
        const name = uniqueName(f.name, taken);
        taken.add(name);
        copies.push(await duplicateAsFile(f, name));
      }
      await upload(copies);
    } catch { showToast('Не вставил — не удалось получить копию файла.', 'error'); }
  };

  /** Файлы из системного буфера: просим систему прислать их обычной вставкой (в приложении она приходит с файлами),
   *  не вышло — смотрим картинки через Clipboard API. */
  const readSystemClipboardFiles = async (): Promise<File[]> => {
    const got = await new Promise<File[]>((resolve) => {
      let timer = 0;
      const onPaste = (e: ClipboardEvent) => {
        window.clearTimeout(timer);
        const files = Array.from(e.clipboardData?.files || []);
        if (files.length) { e.preventDefault(); e.stopImmediatePropagation(); }
        resolve(files);
      };
      timer = window.setTimeout(() => { document.removeEventListener('paste', onPaste, true); resolve([]); }, 250);
      document.addEventListener('paste', onPaste, { capture: true, once: true });
      try { document.execCommand('paste'); } catch { /* запрещено — ждём таймер */ }
    });
    if (got.length) return got;
    try {
      const images: File[] = [];
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((x) => x.startsWith('image/'));
        if (type) images.push(new File([await item.getType(type)], `Изображение.${type.split('/')[1] || 'png'}`, { type }));
      }
      return images;
    } catch { return []; }
  };

  /** «Вставить» из меню: сперва скопированное в разделе, затем системный буфер. */
  const pasteFromMenu = async () => {
    if (heldFiles().length) { await pasteHeld(); return; }
    const files = await readSystemClipboardFiles();
    if (files.length) { void upload(files); return; }
    showToast('В буфере нет файлов. Скопируйте файл (Ctrl+C) и вставьте сюда.', 'info');
  };

  // ── Замена содержимого файла ──────────────────────────────────────────────
  // Файл остаётся тем же (id, ссылка, доступы), меняются байты; прежняя версия сохраняется в истории.
  const replaceInput = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<CloudFile | null>(null);
  const extOf = (name: string) => (name.includes('.') ? (name.split('.').pop() || '').toLowerCase() : '');

  const replaceWith = async (f: CloudFile, file: File) => {
    if (!file.size) { showToast('Пустой файл — заменять нечем.', 'error'); return; }
    const ok = await askConfirm({
      title: `Заменить «${f.name}»?`,
      text: `Новое содержимое: «${file.name}», ${fmtBytes(file.size)}. ${extOf(file.name) !== extOf(f.name) ? 'Расширение отличается от прежнего. ' : ''}Ссылка на файл не изменится, прежняя версия останется в истории версий.`,
      confirm: 'Заменить',
    });
    if (!ok) return;
    showToast('Заменяю файл…', 'info');
    try {
      const saved = await replaceFileContent(f.id, file);
      setData((d) => (d ? { ...d, files: d.files.map((x) => (x.id === saved.id ? { ...x, ...saved } : x)) } : d));
      patchFolderCache(folderId, (d) => ({ ...d, files: d.files.map((x) => (x.id === saved.id ? { ...x, ...saved } : x)) }));
      setDims((cur) => { const next = { ...cur }; delete next[f.id]; return next; });
      showToast('Файл заменён — прежняя версия в истории', 'success');
      void refresh();
    } catch {
      showToast('Не заменил — нет права на файл или нет связи с сервером.', 'error');
    }
  };

  const replaceFromClipboard = async (f: CloudFile) => {
    let files = await readSystemClipboardFiles();
    if (!files.length && heldFiles().length) {
      try { files = [await duplicateAsFile(heldFiles()[0], heldFiles()[0].name)]; } catch { files = []; }
    }
    if (!files.length) { showToast('В буфере нет файла. Скопируйте файл (Ctrl+C) и повторите.', 'info'); return; }
    await replaceWith(f, files[0]);
  };

  // Ctrl+V — файлы из системного буфера (или скопированное здесь). Поля ввода и открытые окна вставку не отдают.
  const hovered = useRef<string | null>(null);
  const live = useRef({ upload, pasteHeld, copyFile, replaceFromClipboard, files: [] as CloudFile[], busy: false });
  live.current = { upload, pasteHeld, copyFile, replaceFromClipboard, files: data?.files || [], busy: Boolean(sheet || doc || viewer || menu || renaming || creating) };
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (live.current.busy || el?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const files = Array.from(e.clipboardData?.files || []);
      if (files.length) { e.preventDefault(); void live.current.upload(files); return; }
      if (heldFiles().length) { e.preventDefault(); void live.current.pasteHeld(); }
    };
    // Скопировали что-то другое (текст в поле, ссылку) — прежний файл из раздела вставлять уже не надо.
    const onCopy = () => forgetHeld();
    // Ctrl+C — файл под фокусом, а без фокуса — тот, на который наведён курсор (выделения у раздела нет).
    const onKey = (e: KeyboardEvent) => {
      const replace = e.shiftKey && e.code === 'KeyV';
      if (!(e.ctrlKey || e.metaKey) || e.altKey || live.current.busy || (e.shiftKey ? !replace : e.code !== 'KeyC')) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest('input, textarea, select, [contenteditable="true"]') || window.getSelection()?.toString()) return;
      const id = el?.closest<HTMLElement>('[data-file-id]')?.dataset.fileId || hovered.current;
      const f = id ? live.current.files.find((x) => x.id === id) : undefined;
      if (!f) return;
      if (replace) {
        // Ctrl+Shift+V по файлу — заменить его содержимое файлом из буфера (только тем, кто может править).
        if (!canEdit(f)) return;
        e.preventDefault();
        void live.current.replaceFromClipboard(f);
        return;
      }
      e.preventDefault(); // без этого следом придёт обычное «copy» и сотрёт запомненное
      void live.current.copyFile(f);
    };
    document.addEventListener('paste', onPaste);
    document.addEventListener('copy', onCopy);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('paste', onPaste); document.removeEventListener('copy', onCopy); document.removeEventListener('keydown', onKey); };
  }, []);

  // ── Перетаскивание в папку ────────────────────────────────────────────────
  // Файл или папку можно взять и бросить на папку (плитку или строку) или на хлебную крошку — туда он и переедет.
  // Файлы с рабочего стола, брошенные на папку, загружаются прямо в неё.
  const dragged = useRef<Target | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);

  const moveInto = async (t: Target, dest: string | null, destName: string) => {
    const from = t.kind === 'file' ? t.item.folderId : t.item.parentId;
    if ((from || null) === dest || (t.kind === 'folder' && t.item.id === dest)) return;
    const before = data;
    setData((d) => (d ? { folders: d.folders.filter((f) => f.id !== t.item.id), files: d.files.filter((f) => f.id !== t.item.id) } : d));
    try {
      if (t.kind === 'file') await moveFile(t.item.id, dest); else await moveFolder(t.item.id, dest);
      showToast(`«${t.item.name}» — в «${destName}»`, 'success');
      void refresh();
    } catch {
      setData(before);
      showToast('Не переместил — нет прав на папку или нет связи с сервером.', 'error');
    }
  };

  const dragSource = (t: Target) => ({
    draggable: canEdit(t.item) && renaming !== t.item.id,
    onDragStart: (e: React.DragEvent) => {
      dragged.current = t;
      e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ kind: t.kind, id: t.item.id }));
      e.dataTransfer.effectAllowed = 'move';
    },
    onDragEnd: () => { dragged.current = null; setDropKey(null); },
  });

  /** Приёмник: папка (id) или корень (null). `key` — чем подсветить, чтобы одно место не мигало за другое. */
  const dropTarget = (dest: string | null, destName: string, key: string) => ({
    onDragOver: (e: React.DragEvent) => {
      const own = dragged.current;
      const files = e.dataTransfer.types.includes('Files');
      if (!files && !own) return;
      // На саму себя и в ту же папку не кладём: подсветка там только вводила бы в заблуждение.
      if (own && ((own.kind === 'folder' && own.item.id === dest) || (own.kind === 'file' ? own.item.folderId : own.item.parentId) === dest || (!(own.kind === 'file' ? own.item.folderId : own.item.parentId) && dest === null))) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = own ? 'move' : 'copy';
      if (dropKey !== key) setDropKey(key);
    },
    onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropKey((k) => (k === key ? null : k)); },
    onDrop: (e: React.DragEvent) => {
      const own = dragged.current;
      if (!own && !e.dataTransfer.files.length) return;
      e.preventDefault();
      e.stopPropagation();
      setDropKey(null);
      setDragging(false);
      dragged.current = null;
      if (own) void moveInto(own, dest, destName); else void upload(e.dataTransfer.files, dest);
    },
  });

  // Меню: ⋯, правый клик, долгое нажатие.
  const press = useRef({ timer: 0, fired: false, x: 0, y: 0 });
  const itemHandlers = (t: Target) => ({
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); setMenu({ target: t, anchor: { x: e.clientX, y: e.clientY } }); },
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
  ) : <span className="nf-name" title={t.item.name}>{t.item.name}<HiddenMark kind={t.kind === 'folder' ? 'cloud_folder' : 'file'} id={String(t.item.id)} /></span>);

  // Построчный вид — таблица: название, тип, размер, дата изменения, владелец. В сетке этих ячеек нет.
  const ownerCell = (ownerId: string) => {
    const u = users[String(ownerId)];
    return (
      <span className="nf-cell nf-c-owner">
        {String(ownerId) === myId() ? 'Вы' : u ? <><Avatar name={displayName(u)} seed={String(u.id)} src={u.avatar} person size={18} /><span>{displayName(u)}</span></> : '—'}
      </span>
    );
  };
  const listCells = (type: string, size: string, date: string, ownerId: string) => (
    <>
      <span className="nf-cell nf-c-type" title={type}>{type}</span>
      <span className="nf-cell nf-c-size">{size}</span>
      <span className="nf-cell nf-c-date">{date}</span>
      {ownerCell(ownerId)}
    </>
  );
  const plural = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'элемент' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'элемента' : 'элементов');

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
        {mode === 'list' && (
          <div className="nf-thead" aria-hidden="true">
            <span /><span>Название</span><span>Тип</span><span>Размер</span><span>Изменён</span><span>Владелец</span><span />
          </div>
        )}
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
                    data-drop={dropKey === `f:${f.id}` ? 'true' : undefined}
                    data-selected={f.id in selected ? 'true' : undefined}
                    style={f.color ? ({ '--folder': f.color } as CSSProperties) : undefined}
                    onClick={(e) => { if (renaming !== f.id) pick(e, f.id, 'folder', () => onOpenFolder(f)); }}
                    onKeyDown={(e) => { if (e.key === ' ') { e.preventDefault(); toggleSelect(f.id, 'folder'); } else if (e.key === 'Enter' && renaming !== f.id) pick(e, f.id, 'folder', () => onOpenFolder(f)); }}
                    {...itemHandlers(t)}
                    {...dragSource(t)}
                    {...dropTarget(f.id, f.name, `f:${f.id}`)}
                  >
                    {checkBox(f.id, 'folder', f.name)}
                    {mode === 'grid'
                      ? <FolderTile folder={f} />
                      : <span className="nf-thumb"><Folder size={22} aria-hidden="true" /></span>}
                    <span className="nf-text">
                      {nameOrInput(t)}
                      {mode === 'list' ? (
                        <span className="nf-badges">
                          {f.isPinned && <Pin size={11} aria-label="Закреплена" />}
                          {(f.sharedWith?.length || 0) > 0 && <><Users size={11} aria-hidden="true" /> {f.sharedWith!.length}</>}
                        </span>
                      ) : (
                        <span className="nf-meta">
                          {typeof f.fileCount === 'number' ? `${f.fileCount} ${f.fileCount === 1 ? 'файл' : f.fileCount < 5 && f.fileCount > 0 ? 'файла' : 'файлов'}` : fmtDate(f.updatedAt)}
                        </span>
                      )}
                    </span>
                    {mode === 'list' && listCells('Папка', typeof f.fileCount === 'number' ? `${f.fileCount} ${plural(f.fileCount)}` : '', fmtDate(f.updatedAt), f.ownerId)}
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
                    onMouseEnter={() => { hovered.current = f.id; }}
                    onMouseLeave={() => { if (hovered.current === f.id) hovered.current = null; }}
                    data-selected={f.id in selected ? 'true' : undefined}
                    onClick={(e) => { if (renaming !== f.id) pick(e, f.id, 'file', () => openFile(f)); }}
                    onKeyDown={(e) => { if (e.key === ' ') { e.preventDefault(); toggleSelect(f.id, 'file'); } else if (e.key === 'Enter' && renaming !== f.id) pick(e, f.id, 'file', () => openFile(f)); }}
                    {...itemHandlers(t)}
                    {...dragSource(t)}
                  >
                    {checkBox(f.id, 'file', f.name)}
                    <span className="nf-thumb" data-kind={k}>
                      {k === 'image'
                        ? <img src={thumbUrl(fileUrl(f.url), mode === 'grid' ? 320 : 64)} alt="" loading="lazy" decoding="async" draggable={false} />
                        : <FileGlyph name={f.name} kind={k} size={mode === 'grid' ? 'lg' : 'sm'} />}
                    </span>
                    <span className="nf-text">
                      {nameOrInput(t)}
                      {mode === 'grid' && (
                        <span className="nf-meta">
                          {[dims[f.id]?.[0] ? `${dims[f.id][0]}×${dims[f.id][1]}` : '', fmtBytes(f.size), fmtDateShort(f.createdAt)].filter(Boolean)
                            .map((part, i, all) => <span key={i} className="nf-meta-part">{part}{i < all.length - 1 ? ' ·' : ''}</span>)}
                          {owner && <span className="nf-owner" title={`Владелец: ${displayName(owner)}`}><Avatar name={displayName(owner)} seed={String(owner.id)} src={owner.avatar} person size={14} /></span>}
                        </span>
                      )}
                    </span>
                    {mode === 'list' && listCells(
                      [f.name.includes('.') ? (f.name.split('.').pop() || '').toUpperCase() : 'Файл', dims[f.id]?.[0] ? `${dims[f.id][0]}×${dims[f.id][1]}` : ''].filter(Boolean).join(' · '),
                      fmtBytes(f.size), fmtDate(f.updatedAt || f.createdAt), f.ownerId,
                    )}
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
        <nav className="nf-crumbs" aria-label="Путь">
          {trail.length > 0 && <button type="button" className="nf-crumb" data-drop={dropKey === 'root' ? 'true' : undefined} onClick={() => onCrumb(-1)} {...dropTarget(null, 'Мои файлы', 'root')}>Мои файлы</button>}
          {trail.map((f, i) => (
            <span key={f.id} className="nf-crumb-wrap">
              <ChevronRight size={14} aria-hidden="true" />
              <button type="button" className="nf-crumb" aria-current={i === trail.length - 1 ? 'page' : undefined} data-drop={dropKey === `f:${f.id}` ? 'true' : undefined} onClick={() => onCrumb(i)} {...dropTarget(f.id, f.name, `f:${f.id}`)}>{f.name}</button>
            </span>
          ))}
        </nav>
        {trail.length === 0 && lead}
        </div>
        <SearchField className="nf-search" value={query} onChange={setQuery} placeholder="Поиск в папке" />
        <div className="nf-tools">
          <button type="button" className="nx-ghost nf-act" aria-haspopup="menu" aria-expanded={Boolean(filterMenu)} title={`Показать: ${FILTERS[filter]}`} aria-label={`Тип файлов: ${FILTERS[filter]}`}
            onClick={(e) => setFilterMenu({ element: e.currentTarget, align: 'end' })}>
            <Filter size={15} aria-hidden="true" /><span className="nf-btn-label">{FILTERS[filter]}</span><ChevronDown size={13} aria-hidden="true" />
          </button>
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

      <div className="nf-scroll nx-scroll-y" onContextMenu={(e) => { e.preventDefault(); setPasteMenu({ x: e.clientX, y: e.clientY }); }}>{body}</div>

      {pasteMenu && (
        <Menu anchor={pasteMenu} label="Действия с папкой" onClose={() => setPasteMenu(null)}>
          <MenuItem icon={<ClipboardPaste size={16} />} onSelect={() => { setPasteMenu(null); void pasteFromMenu(); }}>Вставить</MenuItem>
          <MenuItem icon={<FolderPlus size={16} />} onSelect={() => { setPasteMenu(null); setCreating(true); }}>Новая папка</MenuItem>
          <MenuItem icon={<Upload size={16} />} onSelect={() => { setPasteMenu(null); fileInput.current?.click(); }}>Загрузить файлы</MenuItem>
        </Menu>
      )}

      {selectedCount > 0 && (
        <div className="nf-selbar" role="toolbar" aria-label="Выбранное">
          <span className="nf-selbar-count">Выбрано: {selectedCount}</span>
          <button type="button" className="nx-primary nf-selbar-btn" aria-haspopup="menu" aria-expanded={Boolean(downloadMenu)} onClick={(e) => setDownloadMenu({ element: e.currentTarget, align: 'start', side: 'above' })}>
            <Download size={15} aria-hidden="true" /> Скачать <ChevronDown size={13} aria-hidden="true" />
          </button>
          <button type="button" className="nx-ghost nf-selbar-btn" onClick={() => setSelected(Object.fromEntries(ordered.map((x) => [x.id, x.kind])))} disabled={selectedCount === ordered.length}>Выбрать все</button>
          <button type="button" className="nx-icon-btn" aria-label="Снять выбор" title="Снять выбор (Esc)" onClick={() => setSelected({})}><X size={16} aria-hidden="true" /></button>
        </div>
      )}
      {downloadMenu && (
        <Menu anchor={downloadMenu} label="Как скачать" onClose={() => setDownloadMenu(null)}>
          <MenuItem icon={<Archive size={16} />} onSelect={() => { setDownloadMenu(null); downloadZip(); }}>Одним архивом (.zip)</MenuItem>
          <MenuItem icon={<Files size={16} />} disabled={!selectedFiles().length} onSelect={() => { setDownloadMenu(null); void downloadSeparately(); }}>
            {selectedFiles().length ? `По отдельности (${selectedFiles().length})` : 'По отдельности — только файлы'}
          </MenuItem>
          {selectedFolders().length > 0 && selectedFiles().length > 0 && <p className="nx-hint nf-selbar-hint">Папки уходят только в архив.</p>}
        </Menu>
      )}

      {filterMenu && (
        <Menu anchor={filterMenu} label="Тип файлов" onClose={() => setFilterMenu(null)}>
          {(Object.keys(FILTERS) as Filter[]).map((id) => (
            <MenuItem key={id} icon={filter === id ? <Check size={15} /> : <span style={{ width: 15 }} />} onSelect={() => { setFilterMenu(null); setFilter(id); }}>{FILTERS[id]}</MenuItem>
          ))}
        </Menu>
      )}

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
          {canEdit(t.item) && (
            <>
              <AccessMenuItem target={t} onSelect={() => { setMenu(null); setSheet({ type: 'access', target: t }); }} />
              <div className="nx-menu-sep" />
            </>
          )}
          {t.kind === 'folder' ? (
            <MenuItem icon={<Folder size={16} />} onSelect={() => { setMenu(null); onOpenFolder(t.item); }}>Открыть</MenuItem>
          ) : (
            <>
              <MenuItem icon={<ExternalLink size={16} />} onSelect={() => { setMenu(null); openFile(t.item); }}>Открыть</MenuItem>
              {canOpenInEditor(t.item.name) && (
                <MenuItem icon={<PenLine size={16} />} onSelect={() => { const item = t.item; setMenu(null); void openInEditor({ url: fileUrl(item.url), name: item.name, size: item.size ?? undefined }); }}>Открыть в Шаре</MenuItem>
              )}
              <MenuItem icon={<Download size={16} />} onSelect={() => { setMenu(null); downloadFile(fileUrl(t.item.url), t.item.name); }}>Скачать</MenuItem>
            </>
          )}
          <MenuItem icon={<Send size={16} />} onSelect={() => { setMenu(null); setSheet({ type: 'send', target: t }); }}>Отправить в чат</MenuItem>
          {mailConnected && <MenuItem icon={<Mail size={16} />} onSelect={() => { setMenu(null); sendByMail(t); }}>Отправить по почте</MenuItem>}
          <MenuItem icon={<Link2 size={16} />} onSelect={() => { setMenu(null); void copyLink(t); }}>Копировать ссылку</MenuItem>
          {t.kind === 'file' && <MenuItem icon={<Copy size={16} />} onSelect={() => { const f = t.item as CloudFile; setMenu(null); void copyFile(f); }}>Копировать файл</MenuItem>}
          <MenuItem icon={<Info size={16} />} onSelect={() => { setMenu(null); setSheet({ type: 'props', target: t }); }}>Свойства</MenuItem>
          {t.kind === 'file' && <MenuItem icon={<History size={16} />} onSelect={() => { setMenu(null); setSheet({ type: 'versions', target: t }); }}>История версий</MenuItem>}
          {canEdit(t.item) && (
            <>
              <div className="nx-menu-sep" />
              <MenuItem icon={<Pencil size={16} />} onSelect={() => { setMenu(null); setRenaming(t.item.id); }}>Переименовать</MenuItem>
              <MenuItem icon={<FolderInput size={16} />} onSelect={() => { setMenu(null); setSheet({ type: 'move', target: t }); }}>Переместить</MenuItem>
              {t.kind === 'file' && (
                <>
                  <MenuItem icon={<ClipboardPaste size={16} />} onSelect={() => { const f = t.item as CloudFile; setMenu(null); void replaceFromClipboard(f); }}>Заменить из буфера</MenuItem>
                  <MenuItem icon={<FileUp size={16} />} onSelect={() => { replaceTarget.current = t.item as CloudFile; setMenu(null); replaceInput.current?.click(); }}>Заменить файлом…</MenuItem>
                </>
              )}
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
          <AgentMenuItems hiddenKind={t.kind === 'folder' ? 'cloud_folder' : 'file'} onDone={() => setMenu(null)}
            target={{ kind: t.kind === 'folder' ? 'folder' : 'file', title: t.item.name, id: String(t.item.id), url: t.kind === 'folder' ? links.folder(String(t.item.id)) : links.file(String(t.item.id)) }} />
        </Menu>
      )}

      {sheet?.type === 'move' && <MoveSheet item={sheet.target.item} kind={sheet.target.kind} onClose={() => setSheet(null)} onDone={() => { setSheet(null); void refresh(); }} />}
      {sheet?.type === 'versions' && sheet.target.kind === 'file' && (
        <VersionsSheet file={sheet.target.item as CloudFile} onClose={() => setSheet(null)} onChanged={() => void refresh()} />
      )}
      <input ref={replaceInput} type="file" hidden onChange={(e) => { const file = e.target.files?.[0]; const f = replaceTarget.current; e.target.value = ''; if (file && f) void replaceWith(f, file); }} />
      {sheet?.type === 'props' && <PropertiesSheet item={sheet.target.item} kind={sheet.target.kind} onClose={() => setSheet(null)} />}
      {sheet?.type === 'access' && <AccessSheet item={sheet.target.item} kind={sheet.target.kind} onClose={() => setSheet(null)} onDone={() => { setSheet(null); void refresh(); }} />}
      {sheet?.type === 'send' && (
        <SendSheet
          onClose={() => setSheet(null)}
          onDone={() => void refresh()}
          access={{ kind: sheet.target.kind, ownerId: String(sheet.target.item.ownerId), parentId: sheet.target.kind === 'file' ? sheet.target.item.folderId : sheet.target.item.parentId, sharedWith: sheet.target.item.sharedWith, editAccess: sheet.target.item.editAccess }}
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

/**
 * Первый пункт меню — «Доступ»: справа аватарки тех, кому открыто (до трёх), и их число. Считается и доступ от папок
 * выше, поэтому у файла в общей папке видно тех же людей, что у папки.
 */
function AccessMenuItem({ target, onSelect }: { target: Target; onSelect: () => void }) {
  const users = useChatStore((s) => s.users);
  const item = target.item;
  const inherited = useInheritedAccess(target.kind === 'file' ? (item as CloudFile).folderId : (item as CloudFolder).parentId);
  const ids = [...new Set([...(item.sharedWith || []), ...(item.editAccess || []), ...Object.keys(inherited.view)].map(String))].filter((id) => id !== String(item.ownerId));
  // dept:… — доступ целому отделу: человека-аватарки у него нет, но в число он входит.
  const people = ids.filter((id) => !id.startsWith('dept:'));
  const shown = people.map((id) => users[id]).filter(Boolean).slice(0, 3);
  return (
    <button type="button" role="menuitem" className="nx-menu-item nf-access-item" onClick={onSelect}>
      <Users size={16} />
      <span>Доступ</span>
      {ids.length > 0 && (
        <span className="nf-access-who" title={`Доступ открыт: ${ids.length}`}>
          <span className="nf-access-stack">
            {shown.map((u) => <Avatar key={u.id} name={displayName(u)} seed={String(u.id)} src={u.avatar} person size={20} />)}
          </span>
          <span className="nf-access-count">{ids.length}</span>
        </span>
      )}
    </button>
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
