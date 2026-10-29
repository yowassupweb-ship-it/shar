import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import {
  AArrowDown, AArrowUp, ArrowDownAZ, ArrowUpDown, ArrowUpZA, Bold, BookOpen, Pencil, ClipboardPaste, Columns2, Eraser, Filter, FilterX, Grid3x3, Hash, Italic, Keyboard, List, ListChecks, ListOrdered, Maximize, Minimize, MessageSquarePlus, Minus, PanelTop, Percent, Redo2, RefreshCw, RussianRuble, Scissors, Search, Settings2, Sigma, Strikethrough, Subscript, Superscript, Table, TableCellsMerge, TableCellsSplit, Underline, Undo2,
  AlertCircle, ArrowLeft, Check, Copy, Download, FilePlus, Globe2, History, Link2, Lock, Mail, MessageSquare, Star, MoreHorizontal, Pin, PinOff, MonitorUp, Printer, Send, Share2, Trash2, Upload, Users,
} from 'lucide-react';
import { useMailConnected, writeMail } from '@/features/mail';
import { recordVisit } from '@/features/spotlight/history';
import { absolute, links, paths } from '@/shared/navigation/routes';
import { navigate } from '@/shared/navigation/navigate';
import { askConfirm, Menu, MenuItem, type MenuAnchor } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import { workspaceApi } from './api';
import { KINDS } from './kinds';
import { NoteEditor } from './editors/NoteEditor';
import type { CommentsBridge, EditorProps } from './editors/types';
import { downloadBase64, downloadBlob, downloadText, markdownHtml, printHtml, safeFileName, workbookHtml, XLSX_MIME } from './lib/exportDoc';
import { markdownToSnapshot, parseSnapshot, snapshotToMarkdown } from './lib/docSnapshot';
import { tabsAsSections } from './lib/noteTabs';
import { IMPORT_RULES, importFile } from './lib/importFile';
import { canSticky, forgetSticky, openSticky, stickyLabel } from './lib/sticky';
import { PresenceStack } from './PresenceStack';
import { CommentsPanel } from './CommentsPanel';
import { MenuBar, type BarMenu } from './MenuBar';
import { SendToChatSheet } from './SendToChatSheet';
import { usePresence } from './usePresence';
import { useComments } from './useComments';
import { useCursors } from './useCursors';
import { VersionsSheet } from './VersionsSheet';
import { ShareDialog } from './ShareDialog';
import { useItemSession, type Source } from './useItemSession';
import type { AccessLevel, AccessMode, Kind, NoteColor } from './types';
import { Spinner } from '@/shared/ui/Spinner';

// Univer и редактор слайдов тяжёлые: грузятся отдельными кусками, когда нужны.
const DocEditor = lazy(() => import('./editors/DocEditor'));
const SheetEditor = lazy(() => import('./editors/SheetEditor'));
const DeckEditor = lazy(() => import('./editors/DeckEditor'));

const EDITORS: Record<Kind, ComponentType<EditorProps>> = {
  note: NoteEditor,
  document: DocEditor,
  table: SheetEditor,
  presentation: DeckEditor,
};

export const NOTE_COLORS: Array<{ value: NoteColor; label: string }> = [
  { value: 'default', label: 'Без метки' }, { value: 'red', label: 'Красная' }, { value: 'orange', label: 'Оранжевая' },
  { value: 'yellow', label: 'Жёлтая' }, { value: 'green', label: 'Зелёная' }, { value: 'cyan', label: 'Бирюзовая' },
  { value: 'blue', label: 'Синяя' }, { value: 'purple', label: 'Фиолетовая' }, { value: 'gray', label: 'Серая' },
];

const ACCESS_ICON = { private: Lock, all: Globe2 } as const;

/**
 * Один материал целиком: шапка (название, состояние сохранения, доступ, «Поделиться», меню) и редактор своего вида.
 * Работает и после входа (по id), и по ссылке (по токену) — тогда без меню владельца.
 */
export function ItemView({ source, onBack, onChanged, onDeleted, onOpen, windowControls }: {
  source: Source;
  /** Кнопки окна (поверх всех окон, свернуть, закрыть) — для отдельного окна материала: ставятся в конец шапки. */
  windowControls?: React.ReactNode;
  onBack?: () => void;
  /** Название, закрепление или доступ изменились — список обновит строку. */
  onChanged?: () => void;
  onDeleted?: () => void;
  /** Создана копия — открыть её. */
  onOpen?: (id: string, kind: Kind) => void;
}) {
  const session = useItemSession(source);
  const { item, status, state, error, conflict, loadKey } = session;
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [downloadMenu, setDownloadMenu] = useState<MenuAnchor | null>(null);
  const [uploadMenu, setUploadMenu] = useState<MenuAnchor | null>(null);
  const [importing, setImporting] = useState(false);
  const [share, setShare] = useState(false);
  // Кому открыт материал: свои доступы, отделы и пришедшие от папки выше — чтобы подпись не говорила «Только я» при чужом доступе.
  const [reach, setReach] = useState<{ count: number; names: string[] } | null>(null);
  const [sendToChat, setSendToChat] = useState(false);
  const mailConnected = useMailConnected();
  const [versionsOpen, setVersionsOpen] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);
  const importMode = useRef<'replace' | 'append'>('replace');
  const shared = 'token' in source;
  const reachId = !shared && item?.isOwner && (item.accessLevel ?? 'private') === 'private' ? item.id : null;
  useEffect(() => {
    if (!reachId) { setReach(null); return; }
    let live = true;
    void workspaceApi.shares(reachId).then((state) => {
      if (!live) return;
      const names = new Set<string>();
      for (const entry of state.shares) names.add(entry.name);
      for (const entry of state.departments) names.add(entry.name);
      for (const entry of state.inherited ?? []) names.add(entry.name);
      setReach({ count: names.size, names: [...names] });
    }).catch(() => { if (live) setReach(null); });
    return () => { live = false; };
  }, [reachId, share]);
  // Присутствие: кто ещё в материале и кто печатает (по ссылке без входа — не показываем).
  const viewers = usePresence('token' in source ? null : String(source.id), state === 'pending' || state === 'saving');
  // Курсоры коллег, как в Google Docs.
  const { cursors, send: sendCursor } = useCursors('token' in source ? null : String(source.id), viewers);

  // Комментарии (документ и таблица, не по ссылке): панель справа, привязка — к выделению или ячейке редактора.
  const commentable = !shared && item && (item.kind === 'document' || item.kind === 'table');
  const comments = useComments(commentable ? item.id : null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const commentsBridge = useRef<CommentsBridge | null>(null);
  const fileMenuAnchor = useRef<HTMLElement | null>(null);
  const titleRef = useRef<HTMLInputElement>(null); // кнопка «Файл» — от неё открывается «Скачать…»
  const getCommentAnchor = useCallback(() => commentsBridge.current?.anchor() ?? null, []);
  const jumpToComment = useCallback((anchor: Parameters<CommentsBridge['jump']>[0]) => commentsBridge.current?.jump(anchor), []);
  useEffect(() => { setCommentsOpen(false); }, [item?.id]);
  // «Вид → Полный экран». Встроенный режим Univer — HTML requestFullscreen, в окне Shar OS без рамки он не срабатывает:
  // в приложении окно само разворачивается на весь экран (как показ презентации), а материал занимает всё окно поверх
  // списка и меню (data-fullscreen); в браузере — requestFullscreen самого материала. Выход — тот же пункт или Esc.
  const itemRef = useRef<HTMLDivElement>(null);
  const [fullScreen, setFullScreen] = useState(false);
  useEffect(() => { setFullScreen(false); }, [item?.id]);
  useEffect(() => {
    if (!fullScreen) return undefined;
    const desktop = window.sharDesktop?.windowControls?.setFullScreen;
    if (desktop) void desktop(true);
    else void itemRef.current?.requestFullscreen?.().catch(() => setFullScreen(false));
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) setFullScreen(false); };
    const onChange = () => { if (!desktop && !document.fullscreenElement) setFullScreen(false); };
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onChange);
      if (desktop) void desktop(false);
      else if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, [fullScreen]);
  // Новый комментарий (контекстное меню, «Вставка → Комментарий», Ctrl+Alt+M): панель и сразу поле ввода.
  const [commentFocus, setCommentFocus] = useState(0);
  const addComment = useCallback(() => { setCommentsOpen(true); setCommentFocus((n) => n + 1); }, []);
  // Таблица: выбрали ячейку с комментарием — панель открывается на его ветке.
  // Документ: курсор встал в прокомментированный текст — то же для его цитаты.
  const [commentCell, setCommentCell] = useState<{ sheet: string; cell: string; quote?: string; tick: number } | null>(null);
  const showCellComment = useCallback((cell: { sheet: string; cell: string }) => { setCommentsOpen(true); setCommentCell({ ...cell, tick: Date.now() }); }, []);
  const showQuoteComment = useCallback((quote: string) => { setCommentsOpen(true); setCommentCell({ sheet: '', cell: '', quote, tick: Date.now() }); }, []);
  useEffect(() => {
    if (!commentable) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.altKey && event.code === 'KeyM') { event.preventDefault(); addComment(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [commentable, addComment]);
  // Таблица: ячейки с открытыми ветками — отметка-уголок на листе.
  const commentQuotes = useMemo(() => comments.open.flatMap((t) => (t.root.anchor && 'kind' in t.root.anchor && t.root.anchor.kind === 'text' && t.root.anchor.quote ? [t.root.anchor.quote] : [])), [comments.open]);
  const commentCells = useMemo(() => comments.open.flatMap((t) => (t.root.anchor && 'kind' in t.root.anchor && t.root.anchor.kind === 'cell' ? [{ sheet: t.root.anchor.sheet, cell: t.root.anchor.cell }] : [])), [comments.open]);

  // История посещений для поиска: открытый материал попадает в «Недавние».
  const visitTitle = useRef('');
  visitTitle.current = item?.title || '';
  const visitId = !shared && status === 'ready' && item ? item.id : null;
  const visitKind = item?.kind;
  useEffect(() => {
    if (!visitId || !visitKind) return;
    recordVisit({ id: visitId, kind: 'office', sub: visitKind, title: visitTitle.current || KINDS[visitKind].untitled, subtitle: KINDS[visitKind].plural, path: links.office(visitKind, visitId) });
  }, [visitId, visitKind]);

  // Отдельное окно материала: название документа — заголовок окна (в панели задач окна не называются все «Шар»).
  const windowTitle = windowControls && item ? item.title || KINDS[item.kind].untitled : '';
  useEffect(() => {
    if (!windowTitle) return undefined;
    const previous = document.title;
    document.title = windowTitle;
    return () => { document.title = previous; };
  }, [windowTitle]);

  // Ctrl+P печатает открытый материал, а не всё окно приложения. В фазе захвата — раньше, чем редактор
  // (Univer) успеет забрать сочетание себе. Сама печать — ниже, после загрузки материала (printRef).
  const printRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.code !== 'KeyP' || !printRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      printRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  if (status === 'loading') return <div className="nws-loading"><Spinner size={24} label="Открываю" /></div>;
  if (status === 'missing') return <div className="nws-missing" role="alert">{shared ? 'Ссылка не открывается: её отозвали или материал удалён.' : 'Материал не найден или нет доступа.'}</div>;
  if (status === 'error' || !item) return <div className="nws-missing" role="alert">{error || 'Не удалось открыть.'} <button type="button" className="nx-ghost" onClick={() => void session.reload()}>Повторить</button></div>;

  const info = KINDS[item.kind];
  const Editor = EDITORS[item.kind];
  const readOnly = !item.canEdit;
  const accessLevel: AccessLevel = item.accessLevel ?? 'private';
  const AccessIcon = ACCESS_ICON[accessLevel];

  async function patch(fields: Record<string, unknown>) {
    try { await session.patchFields(fields); onChanged?.(); } catch (cause) { showToast(cause instanceof Error ? cause.message : 'Не удалось изменить', 'error'); }
  }

  async function remove() {
    const ok = await askConfirm({ title: `Удалить «${item!.title || info.untitled}»?`, text: 'Он пропадёт у всех, у кого есть доступ, и 30 дней полежит в корзине — оттуда его можно вернуть.', confirm: 'Удалить', tone: 'danger' });
    if (!ok || 'token' in source) return;
    try { await workspaceApi.remove(source.id); forgetSticky(source.id); onDeleted?.(); } catch (cause) { showToast(cause instanceof Error ? cause.message : 'Не удалось удалить', 'error'); }
  }

  async function duplicate() {
    try {
      await session.refreshContent();
      const created = await workspaceApi.create({ kind: item!.kind, title: `${item!.title || info.untitled} (копия)`, content: session.getContent(), meta: item!.meta });
      showToast('Копия создана', 'success');
      onOpen?.(created.id, created.kind);
      onChanged?.();
    } catch (cause) { showToast(cause instanceof Error ? cause.message : 'Не удалось создать копию', 'error'); }
  }

  const name = safeFileName(item.title || info.untitled);
  const markdown = (withImages = false) => {
    const content = session.getContent();
    if (item.kind === 'note') return tabsAsSections(content); // вкладки — разделами с заголовком
    const snapshot = parseSnapshot(content);
    return snapshot ? snapshotToMarkdown(snapshot, { images: withImages }) : '';
  };

  /** Печать (и «Сохранить как PDF» в окне печати): документ и заметка — с картинками, таблица — все листы. */
  const canPrint = item.kind === 'document' || item.kind === 'note' || item.kind === 'table';
  async function print() {
    const title = item!.title || info.untitled;
    await session.refreshContent();
    if (item!.kind === 'table') {
      try { printHtml(await workbookHtml(title, session.getContent())); } catch { showToast('Не удалось подготовить таблицу к печати', 'error'); }
      return;
    }
    printHtml(markdownHtml(title, markdown(true)));
  }
  printRef.current = canPrint ? () => void print() : null;

  async function downloadDocx() {
    try {
      await session.refreshContent();
      const { markdownToDocx } = await import('./lib/exportDocx');
      downloadBlob(`${name}.docx`, await markdownToDocx(item!.title || info.untitled, markdown()));
    } catch { showToast('Не удалось собрать файл Word', 'error'); }
  }

  /** Таблица → CSV (первый лист, разделитель «;» и BOM — так его без плясок открывает русский Excel). */
  async function downloadCsv() {
    try {
      await session.refreshContent();
      const { bookFromBase64 } = await import('./lib/workbook');
      const sheet = (await bookFromBase64(session.getContent())).worksheets[0];
      const quote = (value: unknown) => {
        const text = value && typeof value === 'object' && 'result' in value ? String((value as { result: unknown }).result ?? '')
          : value && typeof value === 'object' && 'richText' in value ? (value as { richText: Array<{ text: string }> }).richText.map((p) => p.text).join('')
          : value instanceof Date ? value.toISOString() : String(value ?? '');
        return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
      };
      const lines: string[] = [];
      sheet?.eachRow({ includeEmpty: true }, (row) => {
        const cells: string[] = [];
        for (let c = 1; c <= sheet.columnCount; c += 1) cells.push(quote(row.getCell(c).value));
        lines.push(cells.join(';'));
      });
      downloadText(`${name}.csv`, 'text/csv', `\uFEFF${lines.join('\r\n')}`);
    } catch { showToast('Не удалось собрать CSV', 'error'); }
  }

  /** Текст без разметки Markdown — для «.txt»: заголовки, выделение и ссылки остаются словами. */
  const plainText = () => markdown()
    .replace(/^#{1,6}\s+/gm, '').replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, '$1').replace(/(\*\*|__|~~|`)/g, '').replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|$)/g, '$1$2');

  function pickImport(mode: 'replace' | 'append') {
    importMode.current = mode;
    importInput.current?.click();
  }

  /** Файл с компьютера → в открытый материал: заменить содержимое или дописать в конец (для таблицы — только заменить). */
  async function importInto(file: File | undefined) {
    if (importInput.current) importInput.current.value = '';
    if (!file || !item) return;
    try {
      if (item.kind === 'presentation') { await importSlides(file); return; }
      const imported = await importFile(file, undefined, item.kind);
      await session.refreshContent();
      // У заметки — исходная строка: markdown() превращает её вкладки в разделы, а дописать нужно в последнюю вкладку.
      const current = item.kind === 'table' || item.kind === 'note' ? session.getContent() : markdown();
      const empty = item.kind !== 'table' && !current.trim();
      if (importMode.current === 'append' && item.kind !== 'table' && !empty) {
        const added = item.kind === 'note' ? imported.content : snapshotToMarkdown(parseSnapshot(imported.content) ?? { } as never);
        const joined = `${current.trimEnd()}

${added}`;
        session.replaceContent(item.kind === 'note' ? joined : JSON.stringify(markdownToSnapshot(item.title || '', joined)));
      } else {
        if (!empty && !(await askConfirm({ title: 'Заменить содержимое?', text: `Текущее содержимое будет заменено файлом «${file.name}».`, confirm: 'Заменить', tone: 'danger' }))) return;
        session.replaceContent(imported.content, item.title.trim() ? undefined : imported.title);
      }
      showToast('Файл импортирован', 'success');
    } catch (cause) { showToast(cause instanceof Error ? cause.message : 'Не удалось импортировать', 'error'); }
  }

  /** PowerPoint или PDF → в открытую презентацию: заменить её или добавить слайды в конец. Слайды другого размера
   *  вписываются в размер этой презентации, свой фон сохраняют. */
  async function importSlides(file: File) {
    if (importMode.current === 'replace'
      && !(await askConfirm({ title: 'Заменить презентацию?', text: `Все слайды будут заменены слайдами из «${file.name}».`, confirm: 'Заменить', tone: 'danger' }))) return;
    setImporting(true);
    try {
      const imported = await importFile(file, undefined, 'presentation');
      if (importMode.current === 'replace') {
        session.replaceContent(imported.content, item!.title.trim() ? undefined : imported.title);
      } else {
        const { deckSize, parseDeck, serializeDeck } = await import('./slides/deck');
        const current = parseDeck(session.getContent());
        const incoming = parseDeck(imported.content);
        const to = deckSize(current);
        const from = deckSize(incoming);
        const k = Math.min(to.w / from.w, to.h / from.h);
        const dx = Math.round((to.w - from.w * k) / 2);
        const dy = Math.round((to.h - from.h * k) / 2);
        current.slides.push(...incoming.slides.map((slide) => ({
          ...slide,
          background: slide.background || incoming.theme.background,
          elements: slide.elements.map((el) => ({
            ...el, x: Math.round(el.x * k) + dx, y: Math.round(el.y * k) + dy, w: Math.round(el.w * k), h: Math.round(el.h * k),
            ...(el.type !== 'image' && el.style?.fontSize ? { style: { ...el.style, fontSize: Math.max(8, Math.round(el.style.fontSize * k)) } } : {}),
          })),
        })) as typeof current.slides);
        session.replaceContent(serializeDeck(current));
      }
      showToast(importMode.current === 'replace' ? 'Презентация загружена' : 'Слайды добавлены в конец', 'success');
    } catch (cause) { showToast(cause instanceof Error ? cause.message : 'Не удалось загрузить', 'error'); } finally { setImporting(false); }
  }

  /** Через подключённую почту: тема — название, в тексте ссылка; адресата выбирают в письме. */
  function sendByMail() {
    const title = item!.title || KINDS[item!.kind].untitled;
    writeMail({ subject: title, body: `${title}
${absolute(links.office(item!.kind, item!.id))}` });
  }

  // Строка меню, как в Google Документах и Таблицах. Команды правки и форматирования выполняет сам редактор.
  const editorDo = (commandId: string) => () => {
    if (!commentsBridge.current?.exec(commandId)) showToast('Эта команда здесь пока недоступна', 'info');
  };
  const barMenus = (): BarMenu[] => {
    const isDoc = item.kind === 'document';
    const mac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
    const mod = mac ? '⌘' : 'Ctrl+';
    const can = (id: string) => Boolean(commentsBridge.current?.has(id));
    // Пункт-команда редактора: недоступная в этой сборке или в режиме просмотра — серая, как у Google.
    const cmd = (label: string, id: string, icon: React.ReactNode = <span className="nws-bar-noicon" />, hint?: string) => ({ label, icon, hint, onSelect: editorDo(id), disabled: readOnly || !can(id) });
    const comment = { label: 'Комментарий', onSelect: addComment, icon: <MessageSquarePlus size={15} />, hint: mac ? '⌥⌘M' : 'Ctrl+Alt+M' };
    const menus: BarMenu[] = [
      { id: 'file', label: 'Файл', items: [
        { label: 'Поделиться…', onSelect: () => setShare(true), icon: <Share2 size={15} /> },
        { label: 'Отправить в чат', onSelect: () => setSendToChat(true), icon: <Send size={15} /> },
        ...(mailConnected ? [{ label: 'Отправить по почте', onSelect: sendByMail, icon: <Mail size={15} /> }] : []),
        { label: 'Скопировать ссылку', onSelect: () => void copyLink(), icon: <Link2 size={15} /> },
        'sep',
        ...(!readOnly ? [{ label: 'Переименовать', onSelect: () => { titleRef.current?.focus(); titleRef.current?.select(); }, icon: <Pencil size={15} /> }] : []),
        { label: 'Создать копию', onSelect: () => void duplicate(), icon: <Copy size={15} /> },
        { label: 'Скачать…', onSelect: () => { if (fileMenuAnchor.current) setDownloadMenu({ element: fileMenuAnchor.current, align: 'start' }); }, icon: <Download size={15} /> },
        ...(!readOnly ? [{ label: 'Импортировать (заменить)…', onSelect: () => pickImport('replace'), icon: <Upload size={15} /> }] : []),
        ...(!readOnly && isDoc ? [{ label: 'Добавить из файла в конец…', onSelect: () => pickImport('append'), icon: <FilePlus size={15} /> }] : []),
        'sep',
        { label: 'История версий', onSelect: () => setVersionsOpen(true), icon: <History size={15} /> },
        ...(canSticky(item.kind) ? [{ label: stickyLabel(item.kind), onSelect: () => void openSticky(item.id, null, { kind: item.kind }), icon: <MonitorUp size={15} /> }] : []),
        ...(canPrint ? ['sep' as const, { label: 'Печать', onSelect: () => void print(), hint: `${mod}P`, icon: <Printer size={15} /> }] : []),
        ...(item.isOwner || item.canDelete ? ['sep' as const, { label: 'Удалить', onSelect: () => void remove(), tone: 'danger' as const, icon: <Trash2 size={15} /> }] : []),
      ] },
      { id: 'edit', label: 'Правка', items: [
        cmd('Отменить', 'univer.command.undo', <Undo2 size={15} />, `${mod}Z`),
        cmd('Повторить', 'univer.command.redo', <Redo2 size={15} />, mac ? '⇧⌘Z' : 'Ctrl+Y'),
        'sep',
        cmd('Вырезать', 'univer.command.cut', <Scissors size={15} />, `${mod}X`),
        cmd('Скопировать', 'univer.command.copy', <Copy size={15} />, `${mod}C`),
        cmd('Вставить', 'univer.command.paste', <ClipboardPaste size={15} />, `${mod}V`),
        ...(isDoc ? [] : [
          cmd('Вставить только значения', 'sheet.command.paste-value', <ClipboardPaste size={15} />, mac ? '⇧⌘V' : 'Ctrl+Shift+V'),
          cmd('Вставить только формат', 'sheet.command.paste-format', <ClipboardPaste size={15} />),
        ]),
        'sep',
        cmd('Найти и заменить', 'ui.operation.open-find-dialog', <Search size={15} />, `${mod}H`),
      ] },
      { id: 'view', label: 'Вид', items: [
        { label: commentsOpen ? 'Скрыть комментарии' : 'Комментарии', onSelect: () => setCommentsOpen((v) => !v), icon: <MessageSquare size={15} /> },
        ...(isDoc ? [] : [cmd('Сетка', 'sheet.command.toggle-gridlines', <Grid3x3 size={15} />)]),
        'sep',
        fullScreen
          ? { label: 'Выйти из полноэкранного режима', onSelect: () => setFullScreen(false), icon: <Minimize size={15} />, hint: 'Esc' }
          : { label: 'Полный экран', onSelect: () => setFullScreen(true), icon: <Maximize size={15} /> },
      ] },
      { id: 'insert', label: 'Вставка', items: isDoc ? [
        cmd('Таблица', 'doc.operation.create-table', <Table size={15} />),
        cmd('Горизонтальная линия', 'doc.command.horizontal-line', <Minus size={15} />),
        cmd('Разрыв колонки', 'docs.operation.insert-column-break', <Columns2 size={15} />),
        cmd('Колонтитулы', 'doc.command.open-header-footer-panel', <PanelTop size={15} />),
        'sep',
        cmd('Ссылка', 'doc.operation.show-hyper-link-edit-popup', <Link2 size={15} />, `${mod}K`),
        'sep',
        comment,
      ] : [
        cmd('Функция', 'formula-ui.operation.more-functions', <Sigma size={15} />),
        cmd('Ссылка', 'sheet.operation.insert-hyper-link-toolbar', <Link2 size={15} />, `${mod}K`),
        'sep',
        comment,
      ] },
      { id: 'format', label: 'Формат', items: isDoc ? [
        cmd('Жирный', 'doc.command.set-inline-format-bold', <Bold size={15} />, `${mod}B`),
        cmd('Курсив', 'doc.command.set-inline-format-italic', <Italic size={15} />, `${mod}I`),
        cmd('Подчёркнутый', 'doc.command.set-inline-format-underline', <Underline size={15} />, `${mod}U`),
        cmd('Зачёркнутый', 'doc.command.set-inline-format-strikethrough', <Strikethrough size={15} />),
        cmd('Надстрочный', 'doc.command.set-inline-format-superscript', <Superscript size={15} />),
        cmd('Подстрочный', 'doc.command.set-inline-format-subscript', <Subscript size={15} />),
        'sep',
        cmd('Нумерованный список', 'doc.command.order-list', <ListOrdered size={15} />),
        cmd('Маркированный список', 'doc.command.bullet-list', <List size={15} />),
        cmd('Список задач', 'doc.command.check-list', <ListChecks size={15} />),
        'sep',
        cmd('Параметры страницы', 'docs.operation.open-page-setting', <Settings2 size={15} />),
        'sep',
        cmd('Очистить форматирование', 'ui.command.clear-formatting', <Eraser size={15} />, `${mod}\\`),
      ] : [
        cmd('Числа…', 'sheet.operation.open.numfmt.panel', <Hash size={15} />),
        cmd('Процент', 'sheet.command.numfmt.set.percent', <Percent size={15} />),
        cmd('Валюта', 'sheet.command.numfmt.set.currency', <RussianRuble size={15} />),
        cmd('Увеличить число знаков', 'sheet.command.numfmt.add.decimal.command'),
        cmd('Уменьшить число знаков', 'sheet.command.numfmt.subtract.decimal.command'),
        'sep',
        cmd('Жирный', 'sheet.command.set-range-bold', <Bold size={15} />, `${mod}B`),
        cmd('Курсив', 'sheet.command.set-range-italic', <Italic size={15} />, `${mod}I`),
        cmd('Подчёркнутый', 'sheet.command.set-range-underline', <Underline size={15} />, `${mod}U`),
        cmd('Зачёркнутый', 'sheet.command.set-range-stroke', <Strikethrough size={15} />),
        'sep',
        cmd('Увеличить размер шрифта', 'sheet.command.set-range-font-increase', <AArrowUp size={15} />),
        cmd('Уменьшить размер шрифта', 'sheet.command.set-range-font-decrease', <AArrowDown size={15} />),
        'sep',
        cmd('Объединить ячейки', 'sheet.command.add-worksheet-merge-all', <TableCellsMerge size={15} />),
        cmd('Отменить объединение', 'sheet.command.remove-worksheet-merge', <TableCellsSplit size={15} />),
        'sep',
        cmd('Очистить форматирование', 'ui.command.clear-formatting', <Eraser size={15} />, `${mod}\\`),
      ] },
    ];
    if (!isDoc) {
      menus.push({ id: 'data', label: 'Данные', items: [
        cmd('Сортировать A → Я', 'sheet.command.sort-range-asc', <ArrowDownAZ size={15} />),
        cmd('Сортировать Я → A', 'sheet.command.sort-range-desc', <ArrowUpZA size={15} />),
        cmd('Расширенная сортировка…', 'sheet.command.sort-range-custom', <ArrowUpDown size={15} />),
        'sep',
        cmd('Создать или удалить фильтр', 'sheet.command.smart-toggle-filter', <Filter size={15} />),
        cmd('Сбросить условия фильтра', 'sheet.command.clear-filter-criteria', <FilterX size={15} />),
        cmd('Пересчитать фильтр', 'sheet.command.re-calc-filter', <RefreshCw size={15} />),
        'sep',
        cmd('Защитить диапазон', 'sheet.command.add-range-protection-from-toolbar', <Lock size={15} />),
      ] });
    }
    menus.push({ id: 'tools', label: 'Инструменты', items: [
      { ...cmd('Поиск по функциям', 'ui.operation.open-feature-search', <Search size={15} />), disabled: !can('ui.operation.open-feature-search') },
      { ...cmd('Быстрые клавиши', 'base-ui.operation.toggle-shortcut-panel', <Keyboard size={15} />), disabled: !can('base-ui.operation.toggle-shortcut-panel') },
    ] });
    menus.push({ id: 'help', label: 'Справка', items: [
      { label: 'Инструкция по Шару', onSelect: () => navigate(paths.guide), icon: <BookOpen size={15} /> },
    ] });
    return menus;
  };

  async function copyLink() {
    try { await navigator.clipboard.writeText(absolute(links.office(item!.kind, item!.id))); showToast('Ссылка скопирована', 'success'); } catch { showToast('Не удалось скопировать', 'error'); }
  }

  const status_ = (() => {
    if (readOnly) return <span className="nws-save">Только просмотр</span>;
    if (state === 'error') return <span className="nws-save is-error" role="alert"><AlertCircle size={13} aria-hidden="true" /> {error || 'Не сохранилось'}</span>;
    if (state === 'saving') return <span className="nws-save is-busy">Сохраняю…</span>;
    if (state === 'pending') return <span className="nws-save is-busy">Есть несохранённые правки</span>;
    return <span className="nws-save" title="Сохранено"><Check size={13} aria-hidden="true" /> <span className="nws-label">Сохранено</span></span>;
  })();

  return (
    <div className="nws-item" ref={itemRef} data-kind={item.kind} data-layout={commentable ? 'gdocs' : undefined} data-fullscreen={fullScreen ? 'true' : undefined}>
      <header className="nws-head" data-layout={commentable ? 'gdocs' : undefined}>
        {onBack && <button type="button" className="nx-icon-btn nws-back" onClick={onBack} aria-label="К списку"><ArrowLeft size={18} /></button>}
        <span className="nws-kind-icon" style={{ '--a': info.tint[0], '--b': info.tint[1] } as React.CSSProperties} aria-hidden="true"><info.icon size={commentable ? 20 : 16} /></span>
        {/* Документ и таблица — как в Google: название, звёздочка и статус в первой строке, под ними строка меню. */}
        {commentable ? (
          <div className="nws-head-main">
            <div className="nws-head-titlerow">
              <input ref={titleRef} className="nws-title" value={item.title} readOnly={readOnly} placeholder={info.untitled} maxLength={200}
                onChange={(e) => session.setTitle(e.target.value)} onBlur={() => onChanged?.()} aria-label="Название" />
              {item.isOwner && (
                <button type="button" className="nws-star" aria-pressed={item.pinned} title={item.pinned ? 'Открепить' : 'Закрепить сверху'} aria-label={item.pinned ? 'Открепить' : 'Закрепить сверху'}
                  onClick={() => void patch({ pinned: !item.pinned })}><Star size={16} /></button>
              )}
              {status_}
            </div>
            <MenuBar menus={barMenus} onDownloadAnchor={(el) => { fileMenuAnchor.current = el; }} />
          </div>
        ) : (
          <input
            className="nws-title"
            value={item.title}
            readOnly={readOnly}
            placeholder={info.untitled}
            maxLength={200}
            onChange={(e) => session.setTitle(e.target.value)}
            onBlur={() => onChanged?.()}
            aria-label="Название"
          />
        )}
        {/* В окне материала название не растягивается (свободное место — «ручка» окна), поэтому кнопки прижимаем к правому краю распоркой. */}
        {windowControls && <span className="nws-sticky-fill" aria-hidden="true" />}
        <PresenceStack viewers={viewers} ownTips />
        {!commentable && status_}
        {!shared && item.isOwner && !commentable && (
          <button type="button" className="nws-access" onClick={() => setShare(true)} title={accessLevel === 'all' ? 'Видят все в Шаре' : reach?.count ? `Доступ: ${reach.names.join(', ')}` : 'Видите только вы и те, кому выдан доступ'}>
            {accessLevel === 'private' && reach?.count ? <Users size={13} aria-hidden="true" /> : <AccessIcon size={13} aria-hidden="true" />} <span className="nws-label">{accessLevel === 'all' ? 'Все в Шаре' : reach?.count ? `Доступ: ${reach.count}` : 'Только я'}</span>
          </button>
        )}
        {!shared && !item.isOwner && item.ownerName && <span className="nws-owner" title="Владелец"><Users size={13} aria-hidden="true" /> {item.ownerName}</span>}
        {!shared && (
          <button type="button" className="nx-icon-btn" aria-label="История версий" title="История версий" onClick={() => setVersionsOpen(true)}>
            <History size={17} />
          </button>
        )}
        {commentable && (
          <button type="button" className="nx-icon-btn nws-comment-btn" aria-label="Комментарии" title="Комментарии" aria-pressed={commentsOpen} onClick={() => setCommentsOpen((v) => !v)}>
            <MessageSquare size={17} />
            {comments.open.length > 0 && <span className="nws-comment-count" aria-hidden="true">{comments.open.length}</span>}
          </button>
        )}
        {canPrint && !commentable && (
          <button type="button" className="nx-icon-btn" aria-label="Печать" title="Печать (Ctrl+P)" onClick={() => void print()}>
            <Printer size={17} />
          </button>
        )}
        {item.kind !== 'presentation' && !commentable && (
          <button type="button" className="nx-icon-btn" aria-label="Скачать" title="Скачать" aria-haspopup="menu" aria-expanded={Boolean(downloadMenu)} onClick={(e) => setDownloadMenu({ element: e.currentTarget, align: 'end' })}>
            <Download size={17} />
          </button>
        )}
        {/* Скачать презентацию — в панели слайдов; здесь — загрузить её из PowerPoint или PDF. */}
        {item.kind === 'presentation' && !shared && !readOnly && (
          <button type="button" className="nx-ghost nws-upload-btn" aria-haspopup="menu" aria-expanded={Boolean(uploadMenu)} disabled={importing}
            title="Загрузить из PowerPoint (.pptx) или PDF" onClick={(e) => setUploadMenu({ element: e.currentTarget, align: 'end' })}>
            {importing ? <Spinner size={14} label="Загружаю" /> : <Upload size={15} aria-hidden="true" />} <span className="nws-label">{importing ? 'Загружаю…' : 'Загрузить'}</span>
          </button>
        )}
        {!shared && (
          <button type="button" className="nx-primary nws-share-btn" onClick={() => setShare(true)} title="Поделиться"><Share2 size={14} aria-hidden="true" /> <span>Поделиться</span></button>
        )}
        {!shared && !commentable && (
          <button type="button" className="nx-icon-btn" aria-label="Ещё" aria-haspopup="menu" aria-expanded={Boolean(menu)} onClick={(e) => setMenu({ element: e.currentTarget, align: 'end' })}>
            <MoreHorizontal size={18} />
          </button>
        )}
        {windowControls}
      </header>

      {conflict && (
        <div className="nws-banner" role="alert">
          Пока вы правили, материал изменил кто-то другой.
          <button type="button" className="nx-ghost" onClick={() => void session.resolveConflict(false)}>Взять чужую версию</button>
          <button type="button" className="nx-primary" onClick={() => void session.resolveConflict(true)}>Оставить мою</button>
        </div>
      )}

      <div className="nws-main">
        <div className="nws-editor">
          <Suspense fallback={<div className="nws-loading"><Spinner size={24} label="Загружаю редактор" /></div>}>
            <Editor content={item.content} onContent={session.setContent} readOnly={readOnly} loadKey={loadKey} title={item.title} visible cursors={cursors} onCursor={sendCursor} live={session.live} commentsBridge={commentsBridge} commentCells={commentCells} onAddComment={commentable ? addComment : undefined} onCommentCell={commentable ? showCellComment : undefined} commentQuotes={commentQuotes} onCommentQuote={commentable ? showQuoteComment : undefined} />
          </Suspense>
        </div>
        {commentable && commentsOpen && (
          <CommentsPanel comments={comments} kind={item.kind as 'document' | 'table'} canModerate={item.isOwner} getAnchor={getCommentAnchor} onJump={jumpToComment} focusTick={commentFocus} focusCell={commentCell} onClose={() => setCommentsOpen(false)} />
        )}
      </div>

      {!shared && (
        <input ref={importInput} type="file" accept={IMPORT_RULES[item.kind].accept} hidden onChange={(e) => void importInto(e.target.files?.[0])} />
      )}

      {uploadMenu && (
        <Menu anchor={uploadMenu} label="Загрузить презентацию" onClose={() => setUploadMenu(null)}>
          <MenuItem icon={<FilePlus size={15} />} onSelect={() => { setUploadMenu(null); pickImport('append'); }}>Добавить слайды из файла…</MenuItem>
          <MenuItem icon={<Upload size={15} />} onSelect={() => { setUploadMenu(null); pickImport('replace'); }}>Заменить презентацию файлом…</MenuItem>
        </Menu>
      )}

      {downloadMenu && (
        <Menu anchor={downloadMenu} label="Скачать" onClose={() => setDownloadMenu(null)}>
          {(item.kind === 'document' || item.kind === 'note') && (
            <>
              <MenuItem icon={<Download size={15} />} onSelect={() => { setDownloadMenu(null); void downloadDocx(); }}>Word (.docx)</MenuItem>
              <MenuItem icon={<Printer size={15} />} onSelect={() => { setDownloadMenu(null); void print(); }}>PDF (через печать)</MenuItem>
              <MenuItem icon={<Download size={15} />} onSelect={() => { setDownloadMenu(null); downloadText(`${name}.md`, 'text/markdown', markdown()); }}>Markdown (.md)</MenuItem>
              <MenuItem icon={<Download size={15} />} onSelect={() => { setDownloadMenu(null); downloadText(`${name}.txt`, 'text/plain', plainText()); }}>Текст (.txt)</MenuItem>
              <MenuItem icon={<Download size={15} />} onSelect={() => { setDownloadMenu(null); downloadText(`${name}.html`, 'text/html', markdownHtml(item.title || info.untitled, markdown(true))); }}>Веб-страница (.html)</MenuItem>
            </>
          )}
          {item.kind === 'table' && (
            <>
              <MenuItem icon={<Download size={15} />} onSelect={() => { setDownloadMenu(null); void session.refreshContent().then(() => downloadBase64(`${name}.xlsx`, XLSX_MIME, session.getContent())); }}>Excel (.xlsx)</MenuItem>
              <MenuItem icon={<Download size={15} />} onSelect={() => { setDownloadMenu(null); void downloadCsv(); }}>CSV (.csv)</MenuItem>
            </>
          )}
        </Menu>
      )}

      {menu && !shared && (
        <Menu anchor={menu} label="Действия с материалом" onClose={() => setMenu(null)}>
          {item.isOwner && (
            <MenuItem icon={item.pinned ? <PinOff size={15} /> : <Pin size={15} />} onSelect={() => { setMenu(null); void patch({ pinned: !item.pinned }); }}>
              {item.pinned ? 'Открепить' : 'Закрепить сверху'}
            </MenuItem>
          )}
          <MenuItem icon={<Send size={15} />} onSelect={() => { setMenu(null); setSendToChat(true); }}>Отправить в чат</MenuItem>
          {mailConnected && <MenuItem icon={<Mail size={15} />} onSelect={() => { setMenu(null); sendByMail(); }}>Отправить по почте</MenuItem>}
          {canSticky(item.kind) && <MenuItem icon={<MonitorUp size={15} />} onSelect={() => { setMenu(null); void openSticky(item.id, null, { kind: item.kind }); }}>{stickyLabel(item.kind)}</MenuItem>}
          <MenuItem icon={<Link2 size={15} />} onSelect={() => { setMenu(null); void copyLink(); }}>Скопировать ссылку на материал</MenuItem>
          <MenuItem icon={<Copy size={15} />} onSelect={() => { setMenu(null); void duplicate(); }}>Сделать копию</MenuItem>
          {!readOnly && (
            <>
              <MenuItem icon={<Upload size={15} />} onSelect={() => { setMenu(null); pickImport('replace'); }}>Импорт из файла (заменить)…</MenuItem>
              {item.kind !== 'table' && <MenuItem icon={<FilePlus size={15} />} onSelect={() => { setMenu(null); pickImport('append'); }}>{item.kind === 'presentation' ? 'Добавить слайды из файла…' : 'Добавить из файла в конец…'}</MenuItem>}
            </>
          )}
          {item.kind === 'note' && !readOnly && (
            <div className="nws-colors" role="group" aria-label="Цвет метки">
              {NOTE_COLORS.map((c) => (
                <button key={c.value} type="button" className="nws-swatch" data-color={c.value} aria-pressed={(item.meta.color || 'default') === c.value} title={c.label} aria-label={c.label}
                  onClick={() => { setMenu(null); void patch({ meta: { color: c.value } }); }} />
              ))}
            </div>
          )}
          {item.isOwner && <MenuItem icon={<Trash2 size={15} />} tone="danger" onSelect={() => { setMenu(null); void remove(); }}>Удалить</MenuItem>}
        </Menu>
      )}

      {versionsOpen && !shared && (
        <VersionsSheet itemId={item.id} kind={item.kind} currentContent={session.getContent} onClose={() => setVersionsOpen(false)} onRestored={() => { void session.reload(); onChanged?.(); }} />
      )}

      {sendToChat && !shared && (
        <SendToChatSheet
          item={{ id: item.id, kind: item.kind, title: item.title, isOwner: item.isOwner, accessLevel, accessMode: (item.accessMode ?? 'edit') as AccessMode }}
          onClose={() => setSendToChat(false)}
        />
      )}

      {share && !shared && (
        <ShareDialog
          item={{ id: item.id, kind: item.kind, title: item.title, accessLevel, accessMode: (item.accessMode ?? 'edit') as AccessMode, isOwner: item.isOwner, canEdit: item.canEdit }}
          onClose={() => setShare(false)}
          onChanged={() => {
            // Подтягиваем только поля доступа: перезагрузка пересобрала бы редактор под руками.
            void session.patchFields({}).catch(() => undefined);
            onChanged?.();
          }}
        />
      )}
    </div>
  );
}

/** Начальное содержимое нового материала. Таблица собирается асинхронно (exceljs грузится по требованию). */
export async function initialContent(kind: Kind): Promise<string> {
  if (kind === 'document') return JSON.stringify(markdownToSnapshot('', ''));
  if (kind === 'table') return (await import('./lib/workbook')).emptyTableContent();
  if (kind === 'presentation') {
    const { newDeck, serializeDeck } = await import('./slides/deck');
    return serializeDeck(newDeck());
  }
  return '';
}
