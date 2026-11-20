import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import { Extension } from '@tiptap/core';
import { redoDepth, undoDepth } from '@tiptap/pm/history';
import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, Baseline, Bold, Highlighter, ImagePlus, Italic, Link as LinkIcon, List, ListChecks,
  ListOrdered, Omega, Redo2, RemoveFormatting, Smile, Strikethrough, Underline as UnderlineIcon, Undo2,
} from 'lucide-react';
import { uploadFileWithProgress } from '@/shared/api/uploadFile';
import { attachmentUrl } from '@/shared/ui/format';
import { showToast } from '@/shared/ui/Toast';
import { emptySnapshot, parseSnapshot, type DocSnapshot } from '../lib/docSnapshot';
import { univerToHtml } from '../lib/univerHtml';
import { pmToUniver } from '../lib/pmToUniver';
import { docExtensions } from './docSchema';
import { docOverlayPlugin, overlayRanges, setOverlay, type OverlayCursor, type OverlayZone } from './docOverlay';
import { docFindPlugin, findKey, findState } from './docFind';
import { DocContextMenu } from './DocContextMenu';
import { DocInsertPicker } from './UniverDocMenu';
import { FindBar } from './FindBar';
import { HorizontalRuler, VerticalRuler, type MarginKey, type PageBox } from './DocRulers';
import { PageSetupSheet } from './PageSetupSheet';
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
const SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48];
const STYLES = [
  { value: 'p', label: 'Обычный текст' },
  { value: '1', label: 'Заголовок 1' },
  { value: '2', label: 'Заголовок 2' },
  { value: '3', label: 'Заголовок 3' },
];

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
  const extensions = useMemo(() => [...docExtensions(), Extension.create({
    name: 'sharDocLayers',
    addProseMirrorPlugins: () => [
      docOverlayPlugin((zone) => {
        if (Date.now() - blockedAt.current < 2500) return;
        blockedAt.current = Date.now();
        showToast(`${zone.label} — здесь сейчас работает агент. Правьте другую часть документа, зона освободится сама`, 'info');
      }),
      docFindPlugin(),
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
    paddingTop: page.marginTop, paddingBottom: page.marginBottom, paddingLeft: page.marginLeft, paddingRight: page.marginRight,
  }) as React.CSSProperties, [page]);

  if (broken) return <div className="nws-missing" role="alert">Не удалось прочитать содержимое документа: файл повреждён.</div>;

  return (
    <div className="fdoc" data-readonly={readOnly ? 'true' : undefined}>
      {!readOnly && editor && <Toolbar editor={editor} onPicture={() => pictureInput.current?.click()} onPick={(kind, at) => setPicker({ kind, at })} />}
      <input ref={pictureInput} type="file" accept="image/*" hidden onChange={(e) => { const f = [...(e.target.files || [])]; e.target.value = ''; if (f.length) insertPictures.current(f); }} />
      {find.open && (
        <div className="fdoc-find-bar">
          <FindBar query={findInfo?.query ?? ''} onQuery={(q) => setFindMeta({ query: q })} count={findInfo?.count ?? 0} index={findInfo?.index ?? 0}
            onNext={() => stepFind(1)} onPrev={() => stepFind(-1)} onClose={closeFind} focusToken={find.token} />
        </div>
      )}
      <div className="fdoc-scroll nx-scroll-y">
        <div className="fdoc-hruler-row" style={{ width: page.width }}>
          <HorizontalRuler page={page} readOnly={readOnly} onChange={onMargin} />
        </div>
        <div className="fdoc-stage" style={{ width: page.width }}>
          <div className="fdoc-vruler-col">
            <VerticalRuler page={page} readOnly={readOnly} hasHeader hasFooter onChange={onMargin} />
          </div>
          <div className="fdoc-page" style={pageStyle} onContextMenu={(e) => { if (e.shiftKey || !editor) return; e.preventDefault(); setMenuAt({ x: e.clientX, y: e.clientY }); }}>
            {headerText && <div className="fdoc-hf" data-kind="header" style={{ top: page.marginHeader, left: page.marginLeft, right: page.marginRight }} title="Верхний колонтитул">{headerText}</div>}
            <EditorContent editor={editor} />
            {footerText && <div className="fdoc-hf" data-kind="footer" style={{ bottom: page.marginFooter, left: page.marginLeft, right: page.marginRight }} title="Нижний колонтитул">{footerText}</div>}
          </div>
        </div>
        {menuAt && editor && <DocContextMenu editor={editor} at={menuAt} readOnly={readOnly} onClose={() => setMenuAt(null)} onAddComment={onAddComment} />}
      </div>
      {picker && <DocInsertPicker kind={picker.kind} at={picker.at} onPick={(v) => insertText(v)} onClose={() => setPicker(null)} />}
      {pageSetup && <PageSetupSheet page={page} onClose={() => setPageSetup(false)}
        onApply={(next) => applyStyle({ pageSize: { width: next.width, height: next.height }, marginTop: next.marginTop, marginBottom: next.marginBottom,
          marginLeft: next.marginLeft, marginRight: next.marginRight, marginHeader: next.marginHeader, marginFooter: next.marginFooter }, true)} />}
    </div>
  );
}

function Toolbar({ editor, onPicture, onPick }: { editor: Editor; onPicture: () => void; onPick: (kind: 'emoji' | 'symbol', at: { x: number; y: number }) => void }) {
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'), italic: e.isActive('italic'), underline: e.isActive('underline'), strike: e.isActive('strike'),
      bullet: e.isActive('bulletList'), ordered: e.isActive('orderedList'), task: e.isActive('taskList'), link: e.isActive('link'),
      align: (['center', 'right', 'justify'] as const).find((a) => e.isActive({ textAlign: a })) ?? 'left',
      style: e.isActive('heading', { level: 1 }) ? '1' : e.isActive('heading', { level: 2 }) ? '2' : e.isActive('heading', { level: 3 }) ? '3' : 'p',
      size: String(e.getAttributes('textStyle').fontSize || '').replace(/pt$/, ''),
      color: String(e.getAttributes('textStyle').color || '#000000'),
      // Глубина истории — дёшево; e.can().undo() прогонял команду вхолостую на каждую букву.
      canUndo: undoDepth(e.state) > 0, canRedo: redoDepth(e.state) > 0,
    }),
  });
  const run = (fn: (c: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) => fn(editor.chain().focus()).run();
  const btn = (key: string, title: string, active: boolean, icon: React.ReactNode, action: (e: React.MouseEvent<HTMLButtonElement>) => void, disabled = false) => (
    <button key={key} type="button" className="fdoc-btn" title={title} aria-label={title} aria-pressed={active} disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} onClick={action}>{icon}</button>
  );
  const below = (e: React.MouseEvent<HTMLButtonElement>) => { const r = e.currentTarget.getBoundingClientRect(); return { x: r.left, y: r.bottom + 6 }; };
  const setLink = () => {
    const prev = String(editor.getAttributes('link').href || '');
    const url = window.prompt('Адрес ссылки (пусто — убрать)', prev || 'https://');
    if (url === null) return;
    if (!url.trim() || url.trim() === 'https://') run((c) => c.extendMarkRange('link').unsetLink());
    else run((c) => c.extendMarkRange('link').setLink({ href: url.trim() }));
  };

  return (
    <div className="fdoc-bar-wrap">
      <div className="fdoc-bar" role="toolbar" aria-label="Оформление">
        {btn('undo', 'Отменить (Ctrl+Z)', false, <Undo2 size={16} />, () => run((c) => c.undo()), !st.canUndo)}
        {btn('redo', 'Повторить (Ctrl+Y)', false, <Redo2 size={16} />, () => run((c) => c.redo()), !st.canRedo)}
        <span className="fdoc-sep" />
        <select className="fdoc-select" value={st.style} aria-label="Стиль абзаца" onChange={(e) => {
          const v = e.target.value;
          run((c) => (v === 'p' ? c.setParagraph() : c.setHeading({ level: Number(v) as 1 | 2 | 3 })));
        }}>
          {STYLES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select className="fdoc-select fdoc-size" value={SIZES.includes(Number(st.size)) ? st.size : ''} aria-label="Размер шрифта" onChange={(e) => {
          const v = e.target.value;
          run((c) => (v ? c.setFontSize(`${v}pt`) : c.unsetFontSize()));
        }}>
          <option value="">{st.size && !SIZES.includes(Number(st.size)) ? st.size : '11'}</option>
          {SIZES.map((n) => <option key={n} value={String(n)}>{n}</option>)}
        </select>
        <span className="fdoc-sep" />
        {btn('b', 'Жирный (Ctrl+B)', st.bold, <Bold size={16} />, () => run((c) => c.toggleBold()))}
        {btn('i', 'Курсив (Ctrl+I)', st.italic, <Italic size={16} />, () => run((c) => c.toggleItalic()))}
        {btn('u', 'Подчёркнутый (Ctrl+U)', st.underline, <UnderlineIcon size={16} />, () => run((c) => c.toggleUnderline()))}
        {btn('s', 'Зачёркнутый', st.strike, <Strikethrough size={16} />, () => run((c) => c.toggleStrike()))}
        <label className="fdoc-btn fdoc-color" title="Цвет текста" onMouseDown={(e) => e.preventDefault()}>
          <Baseline size={16} style={{ color: st.color }} />
          <input type="color" value={/^#[0-9a-f]{6}$/i.test(st.color) ? st.color : '#000000'} aria-label="Цвет текста"
            onChange={(e) => run((c) => c.setColor(e.target.value))} />
        </label>
        <label className="fdoc-btn fdoc-color" title="Цвет выделения" onMouseDown={(e) => e.preventDefault()}>
          <Highlighter size={16} />
          <input type="color" defaultValue="#fff59d" aria-label="Цвет выделения" onChange={(e) => run((c) => c.setBackgroundColor(e.target.value))} />
        </label>
        {btn('clear', 'Очистить оформление (Ctrl+\\)', false, <RemoveFormatting size={16} />, () => run((c) => c.unsetAllMarks()))}
        <span className="fdoc-sep" />
        {btn('al', 'По левому краю', st.align === 'left', <AlignLeft size={16} />, () => run((c) => c.setTextAlign('left')))}
        {btn('ac', 'По центру', st.align === 'center', <AlignCenter size={16} />, () => run((c) => c.setTextAlign('center')))}
        {btn('ar', 'По правому краю', st.align === 'right', <AlignRight size={16} />, () => run((c) => c.setTextAlign('right')))}
        {btn('aj', 'По ширине', st.align === 'justify', <AlignJustify size={16} />, () => run((c) => c.setTextAlign('justify')))}
        <span className="fdoc-sep" />
        {btn('ul', 'Маркированный список', st.bullet, <List size={16} />, () => run((c) => c.toggleBulletList()))}
        {btn('ol', 'Нумерованный список', st.ordered, <ListOrdered size={16} />, () => run((c) => c.toggleOrderedList()))}
        {btn('tl', 'Чек-лист', st.task, <ListChecks size={16} />, () => run((c) => c.toggleTaskList()))}
        <span className="fdoc-sep" />
        {btn('link', 'Ссылка (Ctrl+клик — открыть)', st.link, <LinkIcon size={16} />, setLink)}
        {btn('img', 'Картинка', false, <ImagePlus size={16} />, onPicture)}
        {btn('emoji', 'Эмодзи', false, <Smile size={16} />, (e) => onPick('emoji', below(e)))}
        {btn('sym', 'Специальные символы', false, <Omega size={16} />, (e) => onPick('symbol', below(e)))}
      </div>
    </div>
  );
}
