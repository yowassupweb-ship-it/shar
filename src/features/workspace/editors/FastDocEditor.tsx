import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import { Extension } from '@tiptap/core';
import { Minus, MoveHorizontal, Plus } from 'lucide-react';
import { uploadFileWithProgress } from '@/shared/api/uploadFile';
import { attachmentUrl } from '@/shared/ui/format';
import { showToast } from '@/shared/ui/Toast';
import { emptySnapshot, parseSnapshot, type DocSnapshot } from '../lib/docSnapshot';
import { univerToHtml } from '../lib/univerHtml';
import { pmToUniver } from '../lib/pmToUniver';
import { docExtensions } from './docSchema';
import { docOverlayPlugin, overlayRanges, setOverlay, type OverlayCursor, type OverlayZone } from './docOverlay';
import { docFindPlugin, findKey, findState } from './docFind';
import { docPagesPlugin, pagesRelayout } from './docPages';
import { DocContextMenu } from './DocContextMenu';
import { DocInsertPicker } from './UniverDocMenu';
import { FindBar } from './FindBar';
import { HorizontalRuler, VerticalRuler, type MarginKey, type PageBox } from './DocRulers';
import { PageSetupSheet } from './PageSetupSheet';
import { FastDocToolbar } from './FastDocToolbar';
import type { EditorProps } from './types';
import './fastDoc.css';

/**
 * Свой редактор документов (TipTap/ProseMirror) вместо Univer. Текст — обычная страница браузера: набор без задержек,
 * выделение и копирование всего документа работают как везде. Лист той же ширины и с теми же полями; страницы отмечены
 * линиями поверх, без перекладки текста по страницам (её делают печать и .docx).
 *
 * Как в Google Документах: линейки сверху и слева (поля и колонтитулы тянутся ползунками), «Параметры страницы»,
 * поиск (Ctrl+F), все команды строки меню (Правка, Вставка, Формат) — через commentsBridge.exec, теми же именами, что
 * у прежнего редактора, поэтому строка меню одна на оба.
 *
 * Хранение прежнее — снимок Univer: открытие lib/univerHtml.ts, сохранение lib/pmToUniver.ts. Совместная правка —
 * шагами ProseMirror (live/pmOps.ts), настройки страницы — отдельной правкой pm.page.
 */

const SAVE_IDLE_MS = 400;

type DocStyle = {
  marginTop?: number; marginBottom?: number; marginLeft?: number; marginRight?: number; marginHeader?: number; marginFooter?: number;
  pageSize?: { width?: number; height?: number }; defaultHeaderId?: string; defaultFooterId?: string;
};

function htmlOf(snapshot: DocSnapshot): string {
  return univerToHtml(snapshot as never, { editor: true });
}

/** Текст колонтитула из снимка (показываем его на листе как в Google Документах; правка — в следующей версии). */
function segmentText(snapshot: DocSnapshot, kind: 'headers' | 'footers', id?: string): string {
  if (!id) return '';
  const seg = (snapshot as unknown as Record<string, Record<string, { body?: { dataStream?: string } }>>)[kind]?.[id];
  // eslint-disable-next-line no-control-regex
  return String(seg?.body?.dataStream || '').replace(/\r\n?$/, '').replace(/\r/g, '\n').replace(/[\x00-\x08\x0b-\x1f]/g, '').trim();
}

function pageOf(style: DocStyle): PageBox {
  return {
    width: style.pageSize?.width || 794,
    height: style.pageSize?.height || 1124,
    marginTop: style.marginTop ?? 72,
    marginBottom: style.marginBottom ?? 72,
    marginLeft: style.marginLeft ?? 72,
    marginRight: style.marginRight ?? 72,
    marginHeader: style.marginHeader ?? 30,
    marginFooter: style.marginFooter ?? 30,
  };
}

async function uploadPicture(file: File): Promise<string | null> {
  try {
    const uploaded = await uploadFileWithProgress(file, () => undefined);
    return attachmentUrl(uploaded.url);
  } catch {
    showToast('Картинка не загрузилась — проверьте соединение и вставьте ещё раз', 'error');
    return null;
  }
}

// Масштаб листа: «по ширине» (лист не шире окна, но не крупнее 100%) или выбранный вручную; помним на устройстве.
const ZOOM_KEY = 'fdoc:zoom';
const ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 2];
function readZoom(): number | 'fit' {
  try { const v = localStorage.getItem(ZOOM_KEY); return !v || v === 'fit' ? 'fit' : Math.min(2, Math.max(0.5, Number(v) || 1)); } catch { return 'fit'; }
}
const plural = (n: number, forms: [string, string, string]) => forms[n % 10 === 1 && n % 100 !== 11 ? 0 : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 1 : 2];

/** Промежуток между листами (в пикселях листа), как в Google Документах. */
const PAGE_GAP = 16;

const NO_QUOTES: string[] = [];
const NO_ZONES: OverlayZone[] = [];
/** Своя позиция для коллег: позиции ProseMirror (pm: 1 — чтобы прежний редактор не путал их со своими смещениями). */
type PmCursor = { pm: 1; from: number; to: number };
const isPmCursor = (p: unknown): p is PmCursor => Boolean(p && typeof p === 'object' && (p as PmCursor).pm === 1 && Number.isInteger((p as PmCursor).from) && Number.isInteger((p as PmCursor).to));

export default function FastDocEditor({ content, onContent, readOnly, loadKey, live, cursors = [], onCursor, commentsBridge, onAddComment, commentQuotes = NO_QUOTES, onCommentQuote, agentZones = NO_ZONES }: EditorProps) {
  const base = useRef<DocSnapshot>(parseSnapshot(content) ?? emptySnapshot());
  const [broken, setBroken] = useState(() => !parseSnapshot(content) && Boolean(content.trim()));
  const [docStyle, setDocStyle] = useState<DocStyle>(() => (base.current.documentStyle || {}) as DocStyle);
  const lastSaved = useRef(content);
  const timer = useRef(0);
  const onContentRef = useRef(onContent);
  onContentRef.current = onContent;

  const flush = useCallback((ed: Editor | null) => {
    window.clearTimeout(timer.current);
    if (!ed || ed.isDestroyed) return;
    const next = JSON.stringify(pmToUniver(ed.getJSON() as never, base.current as never));
    if (next === lastSaved.current) return;
    lastSaved.current = next;
    onContentRef.current(next);
  }, []);

  const insertPictures = useRef<(files: File[]) => void>(() => undefined);
  const openFind = useRef<() => void>(() => undefined);

  // Слой поверх текста (цитаты, курсоры коллег, зоны агентов) и поиск — плагинами внутри расширения: подключаются
  // один раз вместе с редактором (registerPlugin в эффекте добавлял их дважды — «different instances of a keyed plugin»).
  const blockedAt = useRef(0);
  const [pages, setPages] = useState(1);
  const extensions = useMemo(() => [...docExtensions(), Extension.create({
    name: 'sharDocLayers',
    addProseMirrorPlugins: () => [
      docOverlayPlugin((zone) => {
        if (Date.now() - blockedAt.current < 2500) return;
        blockedAt.current = Date.now();
        showToast(`${zone.label} — здесь сейчас работает агент. Правьте другую часть документа, зона освободится сама`, 'info');
      }),
      docFindPlugin(),
      docPagesPlugin((n) => setPages(n)),
    ],
  })], []);

  const editor = useEditor({
    extensions,
    content: htmlOf(base.current),
    editable: !readOnly,
    parseOptions: { preserveWhitespace: 'full' },
    // Перерисовка React на каждую букву не нужна: панель читает состояние сама (useEditorState).
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: 'fdoc-content', 'aria-label': 'Текст документа', spellcheck: 'true' },
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
        if (!files.length || readOnly) return false;
        event.preventDefault();
        insertPictures.current(files);
        return true;
      },
      handleDrop: (_view, event) => {
        const files = [...((event as DragEvent).dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
        if (!files.length || readOnly) return false;
        event.preventDefault();
        insertPictures.current(files);
        return true;
      },
      // Ссылка: обычный клик ставит курсор, Ctrl+клик открывает (как в Google Docs).
      handleClick: (_view, _pos, event) => {
        const link = (event.target as HTMLElement | null)?.closest('a[href]') as HTMLAnchorElement | null;
        if (link && (event.ctrlKey || event.metaKey)) { window.open(link.href, '_blank', 'noopener'); return true; }
        return false;
      },
      handleKeyDown: (_view, event) => {
        // Ctrl+F — свой поиск по документу (по физической клавише: работает в любой раскладке).
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.code === 'KeyF') { event.preventDefault(); openFind.current(); return true; }
        return false;
      },
    },
    onUpdate: ({ editor: ed }) => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => flush(ed), SAVE_IDLE_MS);
    },
    onBlur: ({ editor: ed }) => flush(ed),
  });

  insertPictures.current = (files: File[]) => {
    void (async () => {
      for (const file of files) {
        const src = await uploadPicture(file);
        if (src && editor && !editor.isDestroyed) editor.chain().focus().setImage({ src, alt: file.name.replace(/\.[^.]+$/, '') }).run();
      }
    })();
  };
  const pictureInput = useRef<HTMLInputElement>(null);

  const remote = useMemo<OverlayCursor[]>(() => cursors.flatMap((c) => (isPmCursor(c.pos) ? [{ userId: c.userId, name: c.name, color: c.color, from: c.pos.from, to: c.pos.to, movedAt: c.movedAt }] : [])), [cursors]);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.view.dispatch(setOverlay(editor.state, { quotes: commentQuotes, cursors: remote, zones: agentZones }));
  }, [editor, commentQuotes, remote, agentZones, loadKey]);

  // ── Поиск ────────────────────────────────────────────────────────────────────
  const [find, setFind] = useState<{ open: boolean; token: number }>({ open: false, token: 0 });
  const findInfo = useEditorState({ editor, selector: ({ editor: e }) => (e ? (({ query, matches, index }) => ({ query, count: matches.length, index }))(findState(e.state)) : { query: '', count: 0, index: 0 }) });
  const setFindMeta = useCallback((meta: { query?: string; index?: number }) => {
    if (!editor || editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta(findKey, meta));
    const st = findState(editor.state);
    const hit = st.matches[st.index];
    if (hit) {
      const dom = editor.view.domAtPos(hit.from);
      const el = (dom.node.nodeType === 1 ? dom.node : dom.node.parentElement) as HTMLElement | null;
      el?.scrollIntoView({ block: 'center' });
    }
  }, [editor]);
  openFind.current = () => {
    const sel = editor && !editor.state.selection.empty ? editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, ' ').slice(0, 100) : '';
    setFind((f) => ({ open: true, token: f.token + 1 }));
    if (sel) setFindMeta({ query: sel });
  };
  const stepFind = (d: 1 | -1) => {
    if (!findInfo?.count) return;
    setFindMeta({ index: (findInfo.index + d + findInfo.count) % findInfo.count });
  };
  const closeFind = () => { setFind((f) => ({ ...f, open: false })); setFindMeta({ query: '' }); editor?.commands.focus(); };

  // ── Страница: поля, колонтитулы, размер ─────────────────────────────────────
  const page = useMemo(() => pageOf(docStyle), [docStyle]);
  const headerText = segmentText(base.current, 'headers', docStyle.defaultHeaderId);
  const footerText = segmentText(base.current, 'footers', docStyle.defaultFooterId);
  const liveRef = useRef(live);
  liveRef.current = live;
  const applyStyle = useCallback((patch: Partial<DocStyle>, done: boolean) => {
    const next = { ...(base.current.documentStyle || {}), ...patch } as DocStyle;
    base.current = { ...base.current, documentStyle: next } as DocSnapshot;
    setDocStyle(next);
    if (!done) return;
    // Совместная правка: коллеги получат новые поля сразу (pm.page); без неё — обычное сохранение снимка.
    const channel = liveRef.current;
    if (channel) void import('../live/pmOps').then(({ pageOp }) => channel.local([pageOp(patch as Record<string, unknown>)]));
    else flush(editor);
  }, [editor, flush]);
  const onMargin = useCallback((key: MarginKey, value: number, done: boolean) => applyStyle({ [key]: value }, done), [applyStyle]);
  const [pageSetup, setPageSetup] = useState(false);

  // ── Масштаб и строка состояния ──────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  const [zoomPick, setZoomPick] = useState<number | 'fit'>(readZoom);
  const [room, setRoom] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setRoom(el.clientWidth));
    ro.observe(el);
    setRoom(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  // Поля прокрутки и вертикальная линейка — 72 px; «по ширине» не уменьшает меньше 50% и не увеличивает больше 100%.
  const zoom = zoomPick === 'fit' ? (room ? Math.max(0.5, Math.min(1, (room - 72) / page.width)) : 1) : zoomPick;
  const pickZoom = (z: number | 'fit') => { setZoomPick(z); try { localStorage.setItem(ZOOM_KEY, String(z)); } catch { /* без памяти */ } };
  // Ctrl+колесо (и щипок на тачпаде) — масштаб листа, а не всего окна, как в Google Документах.
  const zoomNow = useRef(zoom);
  zoomNow.current = zoom;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const next = Math.round(Math.min(2, Math.max(0.5, zoomNow.current * Math.exp(-e.deltaY * 0.0015))) * 100) / 100;
      if (next !== zoomNow.current) { zoomNow.current = next; pickZoom(next); }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const stepZoom = (d: 1 | -1) => {
    const cur = zoom;
    const next = d > 0 ? ZOOMS.find((z) => z > cur + 0.001) : [...ZOOMS].reverse().find((z) => z < cur - 0.001);
    if (next) pickZoom(next);
  };
  // ── Листы: пересчёт разбивки после паузы в наборе, смены полей, масштаба, ширины окна, шрифтов и картинок ─────
  const geometry = useRef({ pageHeight: 1124, marginTop: 72, marginBottom: 72, gap: PAGE_GAP, zoom: 1 });
  geometry.current = { pageHeight: page.height, marginTop: page.marginTop, marginBottom: page.marginBottom, gap: PAGE_GAP, zoom };
  const relayout = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (!editor) return undefined;
    let t = 0;
    let raf = 0;
    const run = () => { if (editor.isDestroyed) return; try { pagesRelayout(editor.view, geometry.current); } catch { /* вид ещё не готов */ } };
    const soon = (ms = 250) => { window.clearTimeout(t); t = window.setTimeout(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(run); }, ms); };
    relayout.current = () => soon(0);
    const onUpdate = () => soon();
    editor.on('update', onUpdate);
    const onImg = (e: Event) => { if ((e.target as HTMLElement)?.tagName === 'IMG') soon(50); };
    // Вид редактора появляется, когда смонтирован EditorContent, — подключаемся к нему, как только он есть.
    let dom: HTMLElement | null = null;
    let wait = 0;
    const attach = () => {
      try { dom = editor.view.dom as HTMLElement; } catch { wait = requestAnimationFrame(attach); return; }
      dom.addEventListener('load', onImg, true);
      soon(0);
    };
    attach();
    void document.fonts?.ready.then(() => soon(0));
    return () => {
      window.clearTimeout(t); cancelAnimationFrame(raf); cancelAnimationFrame(wait);
      editor.off('update', onUpdate); dom?.removeEventListener('load', onImg, true); relayout.current = () => undefined;
    };
  }, [editor, loadKey]);
  useEffect(() => { relayout.current(); }, [page, zoom, room]);

  // Линейка слева — у листа, где курсор (как в Google Документах).
  const [caretPage, setCaretPage] = useState(0);
  useEffect(() => {
    if (!editor) return undefined;
    const onSel = () => {
      if (editor.isDestroyed) return;
      try {
        const c = editor.view.coordsAtPos(editor.state.selection.head);
        const top = (editor.view.dom as HTMLElement).getBoundingClientRect().top;
        const y = (c.top - top) / (geometry.current.zoom || 1) + geometry.current.marginTop;
        setCaretPage(Math.max(0, Math.floor(y / (geometry.current.pageHeight + PAGE_GAP))));
      } catch { /* ещё не разложено */ }
    };
    editor.on('selectionUpdate', onSel);
    return () => { editor.off('selectionUpdate', onSel); };
  }, [editor]);

  // Слова и страницы — после паузы в наборе, а не на каждую букву (большой документ — десятки тысяч знаков).
  const [stats, setStats] = useState({ words: 0, chars: 0, pages: 1 });
  useEffect(() => {
    if (!editor) return undefined;
    let t = 0;
    const count = () => {
      if (editor.isDestroyed) return;
      const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, ' ', ' ');
      const words = (text.match(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu) || []).length;
      setStats({ words, chars: text.replace(/\s/g, '').length, pages: 1 });
    };
    const soon = () => { window.clearTimeout(t); t = window.setTimeout(count, 400); };
    count();
    editor.on('update', soon);
    return () => { window.clearTimeout(t); editor.off('update', soon); };
  }, [editor, page.height, loadKey]);

  // ── Эмодзи, символы, меню ПКМ ───────────────────────────────────────────────
  const [picker, setPicker] = useState<{ kind: 'emoji' | 'symbol'; at: { x: number; y: number } } | null>(null);
  const insertText = useCallback((text: string) => {
    if (!editor || editor.isDestroyed || readOnly) return false;
    editor.chain().focus().insertContent(text.replace(/\r?\n/g, ' ')).run();
    return true;
  }, [editor, readOnly]);
  // Своё контекстное меню (в стиле Шара) вместо меню браузера; Shift+ПКМ — системное (там подсказки орфографии).
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);

  // Своя позиция — коллегам; курсор в прокомментированном тексте — открыть ветку (только при настоящем движении).
  const onCursorRef = useRef(onCursor);
  onCursorRef.current = onCursor;
  const onQuoteRef = useRef(onCommentQuote);
  onQuoteRef.current = onCommentQuote;
  useEffect(() => {
    if (!editor) return undefined;
    let lastCaret: number | null = null;
    const onSelection = () => {
      const { from, to, empty } = editor.state.selection;
      onCursorRef.current?.(editor.isFocused ? ({ pm: 1, from, to } as PmCursor) : null);
      const caret = empty ? from : null;
      if (caret !== null && caret !== lastCaret && onQuoteRef.current) {
        const hit = overlayRanges(editor.state)?.quotes.find((q) => caret >= q.from && caret <= q.to);
        if (hit) onQuoteRef.current(hit.quote);
      }
      lastCaret = caret;
    };
    const onBlurCursor = () => onCursorRef.current?.(null);
    editor.on('selectionUpdate', onSelection);
    editor.on('focus', onSelection);
    editor.on('blur', onBlurCursor);
    return () => { editor.off('selectionUpdate', onSelection); editor.off('focus', onSelection); editor.off('blur', onBlurCursor); };
  }, [editor]);

  // Команды строки меню — те же имена, что у прежнего редактора (Univer), чтобы меню «Правка / Вставка / Формат» было одно.
  const commands = useMemo<Record<string, () => void>>(() => {
    if (!editor) return {} as Record<string, () => void>;
    const run = (fn: (c: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) => () => { fn(editor.chain().focus()).run(); };
    const clip = (cmd: 'cut' | 'copy' | 'paste') => () => { editor.commands.focus(); if (!document.execCommand(cmd)) showToast(`Нажмите Ctrl+${cmd === 'cut' ? 'X' : cmd === 'copy' ? 'C' : 'V'}`, 'info'); };
    const link = () => {
      const prev = String(editor.getAttributes('link').href || '');
      const url = window.prompt('Адрес ссылки (пусто — убрать)', prev || 'https://');
      if (url === null) return;
      if (!url.trim() || url.trim() === 'https://') editor.chain().focus().extendMarkRange('link').unsetLink().run();
      else editor.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run();
    };
    const pickAt = (kind: 'emoji' | 'symbol') => () => {
      const r = document.querySelector('.nws-bar')?.getBoundingClientRect();
      setPicker({ kind, at: { x: (r?.left ?? 200) + 120, y: (r?.bottom ?? 80) + 6 } });
    };
    return {
      'univer.command.undo': run((c) => c.undo()),
      'univer.command.redo': run((c) => c.redo()),
      'univer.command.cut': clip('cut'),
      'univer.command.copy': clip('copy'),
      'univer.command.paste': clip('paste'),
      'ui.operation.open-find-dialog': () => openFind.current(),
      'doc.command.set-inline-format-bold': run((c) => c.toggleBold()),
      'doc.command.set-inline-format-italic': run((c) => c.toggleItalic()),
      'doc.command.set-inline-format-underline': run((c) => c.toggleUnderline()),
      'doc.command.set-inline-format-strikethrough': run((c) => c.toggleStrike()),
      'doc.command.set-inline-format-superscript': run((c) => c.toggleMark('superscript')),
      'doc.command.set-inline-format-subscript': run((c) => c.toggleMark('subscript')),
      'doc.command.order-list': run((c) => c.toggleOrderedList()),
      'doc.command.bullet-list': run((c) => c.toggleBulletList()),
      'doc.command.check-list': run((c) => c.toggleTaskList()),
      'ui.command.clear-formatting': run((c) => c.unsetAllMarks()),
      'doc.operation.show-hyper-link-edit-popup': link,
      'doc.command.insert-float-image': () => pictureInput.current?.click(),
      'docs.operation.insert-section-break': run((c) => c.setHorizontalRule()),
      'docs.operation.open-page-setting': () => setPageSetup(true),
      'shar.insert.emoji': pickAt('emoji'),
      'shar.insert.symbol': pickAt('symbol'),
    } as Record<string, () => void>;
  }, [editor]);

  // Связь с панелью комментариев и строкой меню: цитата нового комментария, переход к ветке, команды редактора.
  useEffect(() => {
    if (!commentsBridge || !editor) return undefined;
    commentsBridge.current = {
      anchor: () => {
        const { from, to } = editor.state.selection;
        const quote = editor.state.doc.textBetween(from, to, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
        return quote ? { kind: 'text', quote } : null;
      },
      jump: (anchor) => {
        if (anchor.kind !== 'text') return;
        const hit = overlayRanges(editor.state)?.quotes.find((q) => q.quote === anchor.quote);
        if (!hit) return;
        editor.chain().focus().setTextSelection({ from: hit.from, to: hit.to }).scrollIntoView().run();
      },
      exec: (id) => { const fn = commands[id]; if (!fn || readOnly) return false; fn(); return true; },
      has: (id) => Boolean(commands[id]),
      insertText,
      pick: (kind, at) => setPicker({ kind, at }),
    };
    return () => { commentsBridge.current = null; };
  }, [commentsBridge, editor, commands, insertText, readOnly]);

  // Новая версия с сервера (правка коллеги, агент, возврат из истории): открываем её, если человек сейчас ничего не ждёт сохранения.
  const firstLoad = useRef(true);
  useEffect(() => {
    if (firstLoad.current) { firstLoad.current = false; return; }
    const next = parseSnapshot(content);
    setBroken(!next && Boolean(content.trim()));
    if (!next || !editor || editor.isDestroyed) return;
    base.current = next;
    setDocStyle((next.documentStyle || {}) as DocStyle);
    lastSaved.current = content;
    const { from, to } = editor.state.selection;
    editor.commands.setContent(htmlOf(next), { emitUpdate: false, parseOptions: { preserveWhitespace: 'full' } });
    const size = editor.state.doc.content.size;
    editor.commands.setTextSelection({ from: Math.min(from, size), to: Math.min(to, size) });
  }, [loadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { editor?.setEditable(!readOnly); }, [editor, readOnly]);

  // Совместная правка шагами ProseMirror (live/pmOps.ts): свои шаги — коллегам сразу, их — сюда на место.
  // Снимок для базы канал просит сам, когда у него нет неподтверждённых правок.
  useEffect(() => {
    if (!editor || !live) return undefined;
    let unbind: (() => void) | null = null;
    let cancelled = false;
    void import('../live/pmOps').then(({ bindPm }) => {
      if (cancelled || editor.isDestroyed) return;
      unbind = bindPm(editor, live, async () => JSON.stringify(pmToUniver(editor.getJSON() as never, base.current as never)),
        (style) => applyStyle(style as Partial<DocStyle>, false));
    });
    return () => { cancelled = true; unbind?.(); };
  }, [editor, live, loadKey, applyStyle]);

  // Ушли из документа или закрыли окно — несохранённое уходит сразу, без ожидания паузы.
  useEffect(() => {
    const onHide = () => flush(editor);
    window.addEventListener('beforeunload', onHide);
    return () => { window.removeEventListener('beforeunload', onHide); flush(editor); };
  }, [editor, flush]);

  const pageStyle = useMemo(() => ({
    '--fdoc-w': `${page.width}px`,
    '--fdoc-h': `${page.height}px`,
    minHeight: pages * (page.height + PAGE_GAP) - PAGE_GAP,
    paddingTop: page.marginTop, paddingBottom: 0, paddingLeft: page.marginLeft, paddingRight: page.marginRight,
  }) as React.CSSProperties, [page, pages]);

  if (broken) return <div className="nws-missing" role="alert">Не удалось прочитать содержимое документа: файл повреждён.</div>;

  return (
    <div className="fdoc" data-readonly={readOnly ? 'true' : undefined}>
      {!readOnly && editor && <FastDocToolbar editor={editor} onPicture={() => pictureInput.current?.click()} onPick={(kind, at) => setPicker({ kind, at })}
        onLink={() => commands['doc.operation.show-hyper-link-edit-popup']?.()} />}
      <input ref={pictureInput} type="file" accept="image/*" hidden onChange={(e) => { const f = [...(e.target.files || [])]; e.target.value = ''; if (f.length) insertPictures.current(f); }} />
      {find.open && (
        <div className="fdoc-find-bar">
          <FindBar query={findInfo?.query ?? ''} onQuery={(q) => setFindMeta({ query: q })} count={findInfo?.count ?? 0} index={findInfo?.index ?? 0}
            onNext={() => stepFind(1)} onPrev={() => stepFind(-1)} onClose={closeFind} focusToken={find.token} />
        </div>
      )}
      <div ref={scrollRef} className="fdoc-scroll nx-scroll-y">
        <div className="fdoc-hruler-row" style={{ width: page.width, zoom }}>
          <HorizontalRuler page={page} readOnly={readOnly} zoom={zoom} onChange={onMargin} />
        </div>
        <div className="fdoc-stage" style={{ width: page.width, zoom }}>
          <div className="fdoc-vruler-col" style={{ top: Math.min(caretPage, pages - 1) * (page.height + PAGE_GAP) }}>
            <VerticalRuler page={page} readOnly={readOnly} hasHeader hasFooter zoom={zoom} onChange={onMargin} />
          </div>
          <div className="fdoc-page" style={pageStyle} onContextMenu={(e) => { if (e.shiftKey || !editor) return; e.preventDefault(); setMenuAt({ x: e.clientX, y: e.clientY }); }}>
            {/* Листы — подложки с промежутком; текст идёт поверх, распорки (docPages.ts) переносят его на следующий лист. */}
            {Array.from({ length: pages }, (_, i) => (
              <div key={i} className="fdoc-sheet" style={{ top: i * (page.height + PAGE_GAP), height: page.height }} aria-hidden="true">
                {headerText && <div className="fdoc-hf" data-kind="header" style={{ top: page.marginHeader, left: page.marginLeft, right: page.marginRight }}>{headerText}</div>}
                {footerText && <div className="fdoc-hf" data-kind="footer" style={{ bottom: page.marginFooter, left: page.marginLeft, right: page.marginRight }}>{footerText}</div>}
              </div>
            ))}
            <EditorContent editor={editor} className="fdoc-flow" />
          </div>
        </div>
        {menuAt && editor && <DocContextMenu editor={editor} at={menuAt} readOnly={readOnly} onClose={() => setMenuAt(null)} onAddComment={onAddComment} />}
      </div>
      <footer className="fdoc-status" aria-label="Строка состояния">
        <span>Страница {Math.min(caretPage + 1, pages)} из {pages}</span>
        <span className="fdoc-status-dot" aria-hidden="true" />
        <span title={`Знаков без пробелов: ${stats.chars.toLocaleString('ru-RU')}`}>{stats.words.toLocaleString('ru-RU')} {plural(stats.words, ['слово', 'слова', 'слов'])}</span>
        <span className="fdoc-status-gap" />
        <div className="fdoc-zoom" role="group" aria-label="Масштаб">
          <button type="button" className="fdoc-zbtn" onClick={() => stepZoom(-1)} disabled={zoom <= ZOOMS[0] + 0.001} aria-label="Уменьшить" title="Уменьшить"><Minus size={14} /></button>
          <input type="range" className="fdoc-zrange" min={50} max={200} step={5} value={Math.round(zoom * 100)} aria-label="Масштаб листа"
            onChange={(e) => pickZoom(Number(e.target.value) / 100)} />
          <button type="button" className="fdoc-zbtn" onClick={() => stepZoom(1)} disabled={zoom >= ZOOMS[ZOOMS.length - 1] - 0.001} aria-label="Увеличить" title="Увеличить"><Plus size={14} /></button>
          <button type="button" className="fdoc-zpct" data-fit={zoomPick === 'fit' || undefined} onClick={() => pickZoom(zoomPick === 'fit' ? 1 : 'fit')}
            title={zoomPick === 'fit' ? 'По ширине окна — нажмите для 100%' : 'Нажмите: по ширине окна'}>
            {zoomPick === 'fit' && <MoveHorizontal size={13} aria-hidden="true" />}{Math.round(zoom * 100)}%
          </button>
        </div>
      </footer>
      {picker && <DocInsertPicker kind={picker.kind} at={picker.at} onPick={(v) => insertText(v)} onClose={() => setPicker(null)} />}
      {pageSetup && <PageSetupSheet page={page} onClose={() => setPageSetup(false)}
        onApply={(next) => applyStyle({ pageSize: { width: next.width, height: next.height }, marginTop: next.marginTop, marginBottom: next.marginBottom,
          marginLeft: next.marginLeft, marginRight: next.marginRight, marginHeader: next.marginHeader, marginFooter: next.marginFooter }, true)} />}
    </div>
  );
}

