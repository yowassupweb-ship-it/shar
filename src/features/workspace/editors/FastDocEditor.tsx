import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import { Extension, getMarkRange } from '@tiptap/core';
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
import { HorizontalRuler, VerticalRuler, type IndentKey, type Indents, type MarginKey, type PageBox } from './DocRulers';
import { PageSetupSheet } from './PageSetupSheet';
import { FastDocToolbar, Palette, Pop } from './FastDocToolbar';
import { OClearFormat } from '@/shared/ui/OfficeIcons';
import { DocNavigation } from './DocNavigation';
import { DocLinkSheet } from './DocLinkSheet';
import { LinkCard } from './LinkCard';
import { buildSegment, fillFields, newSegmentId, PAGE_TOKEN, PAGES_TOKEN, readSegment, segmentStyled, type SegKind } from './docHeaderFooter';
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
  const serialized = useRef<{ doc: Editor['state']['doc']; base: DocSnapshot } | null>(null);
  const timer = useRef(0);
  const onContentRef = useRef(onContent);
  onContentRef.current = onContent;

  const flush = useCallback((ed: Editor | null) => {
    window.clearTimeout(timer.current);
    if (!ed || ed.isDestroyed) return;
    if (serialized.current?.doc === ed.state.doc && serialized.current.base === base.current) return;
    const next = JSON.stringify(pmToUniver(ed.getJSON() as never, base.current as never));
    serialized.current = { doc: ed.state.doc, base: base.current };
    if (next === lastSaved.current) return;
    lastSaved.current = next;
    onContentRef.current(next);
  }, []);

  const insertPictures = useRef<(files: File[]) => void>(() => undefined);
  const openFind = useRef<(withReplace?: boolean) => void>(() => undefined);

  // Слой поверх текста (цитаты, курсоры коллег, зоны агентов) и поиск — плагинами внутри расширения: подключаются
  // один раз вместе с редактором (registerPlugin в эффекте добавлял их дважды — «different instances of a keyed plugin»).
  const blockedAt = useRef(0);
  const [pages, setPages] = useState(1);
  const pagesRef = useRef(1);
  pagesRef.current = pages;
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
      attributes: { class: 'fdoc-content', role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Текст документа', spellcheck: 'true' },
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
        // Physical digit keys also work with Russian layout and shifted symbols.
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && !readOnly) {
          const ed = editor;
          if (ed && ['Digit7', 'Digit8', 'Digit9'].includes(event.code)) {
            event.preventDefault();
            if (event.code === 'Digit7') ed.commands.toggleOrderedList();
            else if (event.code === 'Digit8') ed.commands.toggleBulletList();
            else ed.commands.toggleTaskList();
            return true;
          }
        }
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.code === 'KeyK' && !readOnly) {
          event.preventDefault();
          setLinkEdit({ initial: String(_view.state.selection.$from.marks().find((mark) => mark.type.name === 'link')?.attrs.href || ''), from: _view.state.selection.from, to: _view.state.selection.to });
          return true;
        }
        // Ctrl+F — свой поиск по документу (по физической клавише: работает в любой раскладке).
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.code === 'KeyF') { event.preventDefault(); openFind.current(); return true; }
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.code === 'KeyH') { event.preventDefault(); openFind.current(true); return true; }
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
  const [find, setFind] = useState<{ open: boolean; token: number; replace?: boolean }>({ open: false, token: 0 });
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
  openFind.current = (withReplace = false) => {
    const sel = editor && !editor.state.selection.empty ? editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, ' ').slice(0, 100) : '';
    setFind((f) => ({ open: true, token: f.token + 1, replace: withReplace }));
    if (sel) setFindMeta({ query: sel });
  };
  const stepFind = (d: 1 | -1) => {
    if (!findInfo?.count) return;
    setFindMeta({ index: (findInfo.index + d + findInfo.count) % findInfo.count });
  };
  // Замена: текущее совпадение (курсор переходит к следующему) или все сразу — одной правкой (одним Ctrl+Z).
  const replaceFind = useMemo(() => ({
    one: (text: string) => {
      if (!editor || readOnly) return;
      const st = findState(editor.state);
      const hit = st.matches[st.index];
      if (!hit) return;
      editor.view.dispatch(text ? editor.state.tr.insertText(text, hit.from, hit.to) : editor.state.tr.delete(hit.from, hit.to));
      setFindMeta({ index: st.index });
    },
    all: (text: string) => {
      if (!editor || readOnly) return;
      const st = findState(editor.state);
      if (!st.matches.length) return;
      const tr = editor.state.tr;
      for (const m of [...st.matches].reverse()) { if (text) tr.insertText(text, m.from, m.to); else tr.delete(m.from, m.to); }
      editor.view.dispatch(tr);
      showToast(`Заменено: ${st.matches.length}`, 'success');
    },
  }), [editor, readOnly, setFindMeta]);
  const closeFind = () => { setFind((f) => ({ ...f, open: false })); setFindMeta({ query: '' }); editor?.commands.focus(); };

  // ── Страница: поля, колонтитулы, размер ─────────────────────────────────────
  const page = useMemo(() => pageOf(docStyle), [docStyle]);
  const [segTick, setSegTick] = useState(0);
  const headerText = useMemo(() => readSegment(base.current as never, 'headers', docStyle.defaultHeaderId), [docStyle.defaultHeaderId, segTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const footerText = useMemo(() => readSegment(base.current as never, 'footers', docStyle.defaultFooterId), [docStyle.defaultFooterId, segTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const liveRef = useRef(live);
  liveRef.current = live;
  // __seg в правке страницы — колонтитул целиком (pm.page): у коллег он меняется сразу, как и поля.
  const applyStyle = useCallback((patch: Partial<DocStyle> & { __seg?: { kind: SegKind; id: string; segment: unknown } }, done: boolean) => {
    const { __seg, ...style } = patch;
    if (__seg) {
      const segs = { ...((base.current as unknown as Record<string, Record<string, unknown>>)[__seg.kind] || {}) };
      segs[__seg.id] = __seg.segment;
      base.current = { ...base.current, [__seg.kind]: segs } as DocSnapshot;
      setSegTick((n) => n + 1);
    }
    const next = { ...(base.current.documentStyle || {}), ...style } as DocStyle;
    base.current = { ...base.current, documentStyle: next } as DocSnapshot;
    setDocStyle(next);
    if (!done) return;
    // Совместная правка: коллеги получат новые поля сразу (pm.page); без неё — обычное сохранение снимка.
    const channel = liveRef.current;
    if (channel) void import('../live/pmOps').then(({ pageOp }) => channel.local([pageOp(patch as Record<string, unknown>)]));
    else flush(editor);
  }, [editor, flush]);
  const onMargin = useCallback((key: MarginKey, value: number, done: boolean) => applyStyle({ [key]: value }, done), [applyStyle]);

  // ── Колонтитулы: двойной щелчок по полю листа сверху/снизу (как в Google) — правка; номер страницы — полем Univer.
  const startHfRef = useRef<(kind: SegKind, page?: number) => void>(() => undefined);
  const [hfEdit, setHfEdit] = useState<{ kind: SegKind; page: number; text: string } | null>(null);
  const startHf = useCallback((kind: SegKind, pageIndex = 0) => {
    if (readOnly) return;
    const id = kind === 'headers' ? docStyle.defaultHeaderId : docStyle.defaultFooterId;
    if (segmentStyled(base.current as never, kind, id)) showToast('У колонтитула было оформление — после правки здесь он станет обычным текстом', 'info');
    setHfEdit({ kind, page: pageIndex, text: readSegment(base.current as never, kind, id) });
  }, [readOnly, docStyle.defaultHeaderId, docStyle.defaultFooterId]);
  startHfRef.current = startHf;
  const saveHf = useCallback((kind: SegKind, text: string) => {
    const idKey = kind === 'headers' ? 'defaultHeaderId' : 'defaultFooterId';
    const cur = (base.current.documentStyle as DocStyle | undefined)?.[idKey];
    const clean = text.replace(/\s+$/, '');
    if (!clean) {
      // Пустой колонтитул — убираем совсем (как «Удалить колонтитул» в Google).
      if (cur) applyStyle({ [idKey]: '' }, true);
      return;
    }
    const id = cur || newSegmentId(kind);
    applyStyle({ [idKey]: id, __seg: { kind, id, segment: buildSegment(kind, id, clean, pagesRef.current) } }, true);
  }, [applyStyle]);

  // Отступы абзаца, где курсор (pt) — для синих маркеров на линейке; перетаскивание меняет стиль абзацев выделения.
  const indents = useEditorState({
    editor,
    selector: ({ editor: e }): Indents | null => {
      if (!e) return null;
      const ps = (e.state.selection.$from.parent.attrs.ps as Record<string, unknown> | null) || {};
      const v = (x: unknown) => Number(typeof x === 'object' && x ? (x as { v?: number }).v : x) || 0;
      return { start: v(ps.indentStart), firstLine: v(ps.indentFirstLine), end: v(ps.indentEnd) };
    },
    equalityFn: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  });
  const onIndent = useCallback((key: IndentKey, value: number, done: boolean) => {
    if (!done || !editor || readOnly) return;
    const field = key === 'start' ? 'indentStart' : key === 'firstLine' ? 'indentFirstLine' : 'indentEnd';
    const { state } = editor;
    const tr = state.tr;
    state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
      if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return true;
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, ps: { ...((node.attrs.ps as Record<string, unknown>) || {}), [field]: { v: value } } });
      return false;
    });
    if (tr.docChanged) editor.view.dispatch(tr);
    editor.commands.focus();
  }, [editor, readOnly]);
  const [pageSetup, setPageSetup] = useState(false);
  const [linkEdit, setLinkEdit] = useState<{ initial: string; from: number; to: number } | null>(null);
  const linkOpen = linkEdit !== null;
  useEffect(() => {
    if (!editor || !linkOpen) return;
    const mapSelection = ({ transaction }: { transaction: import('@tiptap/pm/state').Transaction }) => {
      if (transaction.docChanged) setLinkEdit((current) => current ? { ...current, from: transaction.mapping.map(current.from), to: transaction.mapping.map(current.to) } : null);
    };
    editor.on('transaction', mapSelection);
    return () => { editor.off('transaction', mapSelection); };
  }, [editor, linkOpen]);

  // ── Масштаб и строка состояния ──────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);

  // ── Карточка ссылки (как в Google Документах): курсор в ссылке — под её началом превью, адрес, копировать,
  // изменить, убрать; ссылка на материал Шара — «Открыть» и «В новом окне». Общая с таблицами (LinkCard.tsx). ──
  const [docLink, setDocLink] = useState<{ url: string; from: number; key: string } | null>(null);
  const [docLinkClosed, setDocLinkClosed] = useState('');
  const docLinkEl = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!editor) return undefined;
    const update = () => {
      const { selection } = editor.state;
      const type = editor.schema.marks.link;
      const range = type ? getMarkRange(selection.$from, type) : undefined;
      const href = range ? String(editor.getAttributes('link').href || '') : '';
      // Выделение шире ссылки — карточка не нужна (как у Google).
      if (!range || !href || selection.to > range.to || selection.from < range.from) { setDocLink(null); return; }
      const key = `${href}@${range.from}`;
      setDocLink((cur) => (cur && cur.key === key ? cur : { url: href, from: range.from, key }));
    };
    editor.on('selectionUpdate', update);
    editor.on('update', update);
    return () => { editor.off('selectionUpdate', update); editor.off('update', update); };
  }, [editor]);
  const placeDocLink = useCallback(() => {
    const card = docLinkEl.current; const view = editor?.view; const box = scrollRef.current?.getBoundingClientRect();
    if (!card || !view || !docLink || !box) return;
    let start: { left: number; bottom: number }; let caret: { bottom: number };
    try { start = view.coordsAtPos(docLink.from); caret = view.coordsAtPos(view.state.selection.from); } catch { card.style.visibility = 'hidden'; return; }
    const top = Math.max(caret.bottom, start.bottom) + 6;
    const left = Math.max(box.left + 8, Math.min(start.left, box.right - card.offsetWidth - 12));
    card.style.left = `${left}px`; card.style.top = `${top}px`;
    card.style.visibility = top < box.top || top > box.bottom - 40 ? 'hidden' : '';
  }, [editor, docLink]);
  useLayoutEffect(() => { placeDocLink(); });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !docLink) return undefined;
    el.addEventListener('scroll', placeDocLink, { passive: true });
    window.addEventListener('resize', placeDocLink);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && docLink) setDocLinkClosed(docLink.key); };
    window.addEventListener('keydown', onKey);
    return () => { el.removeEventListener('scroll', placeDocLink); window.removeEventListener('resize', placeDocLink); window.removeEventListener('keydown', onKey); };
  }, [docLink, placeDocLink]);
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
  }, []);

  // ── Листы: пересчёт разбивки после паузы в наборе, смены полей, масштаба, ширины окна, шрифтов и картинок ─────
  const geometry = useRef({ pageHeight: 1124, marginTop: 72, marginBottom: 72, gap: PAGE_GAP, zoom: 1 });
  geometry.current = { pageHeight: page.height, marginTop: page.marginTop, marginBottom: page.marginBottom, gap: PAGE_GAP, zoom };
  const relayout = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (!editor) return undefined;
    let t = 0;
    let raf = 0;
    let disposed = false;
    const run = () => { if (disposed || editor.isDestroyed) return; try { pagesRelayout(editor.view, geometry.current); } catch { /* вид ещё не готов */ } };
    const soon = (ms = 250) => { if (disposed) return; window.clearTimeout(t); t = window.setTimeout(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(run); }, ms); };
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
      disposed = true;
      window.clearTimeout(t); cancelAnimationFrame(raf); cancelAnimationFrame(wait);
      editor.off('update', onUpdate); dom?.removeEventListener('load', onImg, true); relayout.current = () => undefined;
    };
  }, [editor, loadKey]);
  useEffect(() => { relayout.current(); }, [page, zoom, room]);


  // ── Эмодзи, символы, меню ПКМ ───────────────────────────────────────────────
  const [picker, setPicker] = useState<{ kind: 'emoji' | 'symbol'; at: { x: number; y: number } } | null>(null);
  const insertText = useCallback((text: string) => {
    if (!editor || editor.isDestroyed || readOnly) return false;
    editor.chain().focus().insertContent(text.replace(/\r?\n/g, ' ')).run();
    return true;
  }, [editor, readOnly]);
  // Своё контекстное меню (в стиле Шара) вместо меню браузера; Shift+ПКМ — системное (там подсказки орфографии).
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [cellColorAt, setCellColorAt] = useState<{ x: number; y: number } | null>(null);

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
      const { from, to } = editor.state.selection;
      setLinkEdit({ initial: prev, from, to });
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
      'ui.operation.open-find-dialog': () => openFind.current(true),
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
      // Горизонтальная линия — как у Univer: пустой абзац с нижней границей, курсор — в новый абзац под ней.
      'doc.command.horizontal-line': () => {
        const { $from } = editor.state.selection;
        const at = $from.after(1);
        editor.chain().focus().insertContentAt(at, [
          { type: 'paragraph', attrs: { ps: { borderBottom: { padding: 5, color: { rgb: '#CDD0D8' }, width: 1, dashStyle: 0 } } } },
          { type: 'paragraph' },
        ]).setTextSelection(at + 3).run();
      },
      // Таблица: «Вставка → Таблица» без выбора размера — 3×3, как быстрый вариант; размер выбирается кнопкой в панели.
      'doc.operation.create-table': run((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: false })),
      'doc.command.table-insert-row-above': run((c) => c.addRowBefore()),
      'doc.command.table-insert-row-bellow': run((c) => c.addRowAfter()),
      'doc.command.table-insert-column-left': run((c) => c.addColumnBefore()),
      'doc.command.table-insert-column-right': run((c) => c.addColumnAfter()),
      'doc.table.delete-rows': run((c) => c.deleteRow()),
      'doc.table.delete-columns': run((c) => c.deleteColumn()),
      'doc.table.delete-table': run((c) => c.deleteTable()),
      'docs.operation.open-page-setting': () => setPageSetup(true),
      'doc.command.open-header-footer-panel': () => startHfRef.current('headers'),
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
    setLinkEdit(null);
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
        onLink={() => commands['doc.operation.show-hyper-link-edit-popup']?.()}
        zoom={{ value: zoom, fit: zoomPick === 'fit', pick: pickZoom, options: ZOOMS }} />}
      <input ref={pictureInput} type="file" accept="image/*" hidden onChange={(e) => { const f = [...(e.target.files || [])]; e.target.value = ''; if (f.length) insertPictures.current(f); }} />
      {find.open && (
        <div className="fdoc-find-bar">
          <FindBar query={findInfo?.query ?? ''} onQuery={(q) => setFindMeta({ query: q })} count={findInfo?.count ?? 0} index={findInfo?.index ?? 0}
            onNext={() => stepFind(1)} onPrev={() => stepFind(-1)} onClose={closeFind} focusToken={find.token}
            replace={readOnly ? undefined : replaceFind} replaceOpen={find.replace} />
        </div>
      )}
      <div ref={scrollRef} className="fdoc-scroll nx-scroll-y">
        {/* Линейка сверху — полоса на всю ширину (как в Google Документах), дорожка — шириной с лист, по центру. */}
        <div className="fdoc-hruler-row">
          <div className="fdoc-hruler-track" style={{ width: page.width * zoom }}>
            <HorizontalRuler page={page} zoom={zoom} readOnly={readOnly} indents={readOnly ? null : indents ?? null} onMargin={onMargin} onIndent={onIndent} />
          </div>
        </div>
        <div className="fdoc-body">
          {/* Вертикальные линейки — у левого края окна, по одной на лист; едут вместе с листами. */}
          <div className="fdoc-vcol" aria-hidden="true">
            {Array.from({ length: pages }, (_, i) => (
              <div key={i} className="fdoc-vslot" style={{ top: i * (page.height + PAGE_GAP) * zoom }}>
                <VerticalRuler page={page} zoom={zoom} readOnly={readOnly} onMargin={onMargin} />
              </div>
            ))}
          </div>
          <div className="fdoc-stage" style={{ width: page.width, zoom }}>
            <div className="fdoc-page" style={pageStyle} onContextMenu={(e) => { if (e.shiftKey || !editor) return; e.preventDefault(); setMenuAt({ x: e.clientX, y: e.clientY }); }}>
              {/* Листы — подложки с промежутком; текст идёт поверх, распорки (docPages.ts) переносят его на следующий лист. */}
              {Array.from({ length: pages }, (_, i) => (
                <div key={i} className="fdoc-sheet" style={{ top: i * (page.height + PAGE_GAP), height: page.height }}>
                  {/* Поле сверху и снизу — двойной щелчок открывает правку колонтитула. */}
                  <div className="fdoc-hf-zone" style={{ top: 0, height: page.marginTop }} onDoubleClick={() => startHf('headers', i)} title={readOnly ? undefined : 'Двойной щелчок — верхний колонтитул'} />
                  <div className="fdoc-hf-zone" style={{ bottom: 0, height: page.marginBottom }} onDoubleClick={() => startHf('footers', i)} title={readOnly ? undefined : 'Двойной щелчок — нижний колонтитул'} />
                  {headerText && !(hfEdit?.kind === 'headers' && hfEdit.page === i) && <div className="fdoc-hf" data-kind="header" style={{ top: page.marginHeader, left: page.marginLeft, right: page.marginRight }}>{fillFields(headerText, i + 1, pages)}</div>}
                  {footerText && !(hfEdit?.kind === 'footers' && hfEdit.page === i) && <div className="fdoc-hf" data-kind="footer" style={{ bottom: page.marginFooter, left: page.marginLeft, right: page.marginRight }}>{fillFields(footerText, i + 1, pages)}</div>}
                  {hfEdit && hfEdit.page === i && (
                    <HfEditor kind={hfEdit.kind} text={hfEdit.text} page={page}
                      onChange={(text) => setHfEdit((h) => (h ? { ...h, text } : h))}
                      onDone={(text) => { saveHf(hfEdit.kind, text); setHfEdit(null); editor?.commands.focus(); }}
                      onRemove={() => { saveHf(hfEdit.kind, ''); setHfEdit(null); }} />
                  )}
                </div>
              ))}
              <EditorContent editor={editor} className="fdoc-flow" />
            </div>
          </div>
        </div>
        {menuAt && editor && <DocContextMenu editor={editor} at={menuAt} readOnly={readOnly} onClose={() => setMenuAt(null)} onAddComment={onAddComment}
          onLink={() => commands['doc.operation.show-hyper-link-edit-popup']?.()} onCellColor={() => setCellColorAt(menuAt)} />}
        {cellColorAt && editor && (
          <Pop anchor={new DOMRect(cellColorAt.x, cellColorAt.y, 0, 0)} trigger={editor.view.dom} onClose={() => setCellColorAt(null)}>
            <Palette current={String(editor.getAttributes('tableCell').background || '')} resetLabel="Без заливки" ResetIcon={OClearFormat}
              onReset={() => { editor.chain().focus().setCellAttribute('background', null).run(); setCellColorAt(null); }}
              onPick={(c) => { editor.chain().focus().setCellAttribute('background', c).run(); setCellColorAt(null); }} />
          </Pop>
        )}
      </div>
      {/* Структура, страницы, слова, поиск — полосой под листом (внизу окна), чтобы верх был одной панелью. */}
      {editor && <DocNavigation editor={editor} pages={pages} onFind={() => openFind.current()} />}
      {picker && <DocInsertPicker kind={picker.kind} at={picker.at} onPick={(v) => insertText(v)} onClose={() => setPicker(null)} />}
      {docLink && editor && docLinkClosed !== docLink.key && !linkEdit && (
        <LinkCard cardRef={docLinkEl} url={docLink.url} readOnly={readOnly} style={{ position: 'fixed', zIndex: 60 }}
          onEdit={() => commands['doc.operation.show-hyper-link-edit-popup']?.()}
          onUnlink={() => { editor.chain().focus().extendMarkRange('link').unsetLink().run(); }} />
      )}
      {linkEdit && editor && <DocLinkSheet initial={linkEdit.initial} onClose={() => setLinkEdit(null)} onApply={(url) => {
        if (!readOnly && !editor.isDestroyed) {
          const chain = editor.chain().focus().setTextSelection({ from: Math.min(linkEdit.from, editor.state.doc.content.size), to: Math.min(linkEdit.to, editor.state.doc.content.size) }).extendMarkRange('link');
          if (url && !linkEdit.initial && linkEdit.from === linkEdit.to) chain.insertContent({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] }).run();
          else if (url) chain.setLink({ href: url }).run(); else chain.unsetLink().run();
        }
        setLinkEdit(null);
      }} />}
      {pageSetup && <PageSetupSheet page={page} onClose={() => setPageSetup(false)}
        onApply={(next) => applyStyle({ pageSize: { width: next.width, height: next.height }, marginTop: next.marginTop, marginBottom: next.marginBottom,
          marginLeft: next.marginLeft, marginRight: next.marginRight, marginHeader: next.marginHeader, marginFooter: next.marginFooter }, true)} />}
    </div>
  );
}

/** Правка колонтитула прямо на листе (как в Google Документах): текст, номер страницы, число страниц. */
function HfEditor({ kind, text, page, onChange, onDone, onRemove }: {
  kind: SegKind; text: string; page: PageBox; onChange: (text: string) => void; onDone: (text: string) => void; onRemove: () => void;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(text);
  useEffect(() => { area.current?.focus(); area.current?.setSelectionRange(value.length, value.length); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const insert = (token: string) => {
    const el = area.current;
    if (!el) return;
    const a = el.selectionStart;
    const b = el.selectionEnd;
    const next = value.slice(0, a) + token + value.slice(b);
    setValue(next);
    onChange(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + token.length, a + token.length); });
  };
  const header = kind === 'headers';
  const pos = header ? { top: page.marginHeader } : { bottom: page.marginFooter };
  return (
    <div className="fdoc-hf-edit" data-kind={header ? 'header' : 'footer'} style={{ ...pos, left: page.marginLeft, right: page.marginRight }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onDone(value); }}>
      <textarea ref={area} className="fdoc-hf-input" value={value} rows={Math.max(1, value.split('\n').length)} placeholder={header ? 'Верхний колонтитул' : 'Нижний колонтитул'}
        onChange={(e) => { setValue(e.target.value); onChange(e.target.value); }}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onDone(value); } }} />
      <div className="fdoc-hf-bar" data-kind={header ? 'header' : 'footer'}>
        <span className="fdoc-hf-label">{header ? 'Верхний колонтитул' : 'Нижний колонтитул'}</span>
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insert(PAGE_TOKEN)}>Номер страницы</button>
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insert(PAGES_TOKEN)}>Число страниц</button>
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={onRemove}>Удалить</button>
        <button type="button" className="fdoc-hf-done" onMouseDown={(e) => e.preventDefault()} onClick={() => onDone(value)}>Готово</button>
      </div>
    </div>
  );
}
