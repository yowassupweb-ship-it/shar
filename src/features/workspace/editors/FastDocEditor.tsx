import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import { redoDepth, undoDepth } from '@tiptap/pm/history';
import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, Baseline, Bold, Highlighter, ImagePlus, Italic, Link as LinkIcon, List, ListChecks,
  ListOrdered, Redo2, RemoveFormatting, Strikethrough, Underline as UnderlineIcon, Undo2,
} from 'lucide-react';
import { uploadFileWithProgress } from '@/shared/api/uploadFile';
import { attachmentUrl } from '@/shared/ui/format';
import { showToast } from '@/shared/ui/Toast';
import { emptySnapshot, parseSnapshot, type DocSnapshot } from '../lib/docSnapshot';
import { univerToHtml } from '../lib/univerHtml';
import { pmToUniver } from '../lib/pmToUniver';
import { docExtensions } from './docSchema';
import { docOverlayPlugin, overlayRanges, setOverlay, type OverlayCursor, type OverlayZone } from './docOverlay';
import { DocContextMenu } from './DocContextMenu';
import type { EditorProps } from './types';
import './fastDoc.css';

/**
 * Быстрый редактор документов (вариант Б, #704): TipTap/ProseMirror вместо Univer. Текст — обычная страница браузера:
 * набор без задержек, выделение и копирование всего документа работают как везде. Лист A4 той же ширины и с теми же
 * полями; страницы отмечены линиями поверх, без перекладки текста по страницам (её делают печать и .docx).
 *
 * Хранение прежнее — снимок Univer: открытие lib/univerHtml.ts, сохранение lib/pmToUniver.ts (проверено на всех
 * документах без потерь). Сессия открывает документ без канала Univer: правка уходит целиком после паузы, правки
 * коллег приходят новой версией (loadKey).
 */

const SAVE_IDLE_MS = 400;
const SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48];
const STYLES = [
  { value: 'p', label: 'Обычный текст' },
  { value: '1', label: 'Заголовок 1' },
  { value: '2', label: 'Заголовок 2' },
  { value: '3', label: 'Заголовок 3' },
];

function htmlOf(snapshot: DocSnapshot): string {
  return univerToHtml(snapshot as never, { editor: true });
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

  const editor = useEditor({
    extensions: docExtensions(),
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

  // Слой поверх текста: цитаты комментариев, курсоры коллег, зоны агентов (editors/docOverlay.ts).
  const blockedAt = useRef(0);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.registerPlugin(docOverlayPlugin((zone) => {
      if (Date.now() - blockedAt.current < 2500) return;
      blockedAt.current = Date.now();
      showToast(`${zone.label} — здесь сейчас работает агент. Правьте другую часть документа, зона освободится сама`, 'info');
    }));
  }, [editor]);
  const remote = useMemo<OverlayCursor[]>(() => cursors.flatMap((c) => (isPmCursor(c.pos) ? [{ userId: c.userId, name: c.name, color: c.color, from: c.pos.from, to: c.pos.to, movedAt: c.movedAt }] : [])), [cursors]);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.view.dispatch(setOverlay(editor.state, { quotes: commentQuotes, cursors: remote, zones: agentZones }));
  }, [editor, commentQuotes, remote, agentZones, loadKey]);

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

  // Связь с панелью комментариев: выделенный текст — цитата нового комментария; переход к ветке — выделить её цитату.
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
      exec: () => false,
      has: () => false,
    };
    return () => { commentsBridge.current = null; };
  }, [commentsBridge, editor]);

  // Своё контекстное меню (в стиле Шара) вместо меню браузера; Shift+ПКМ — системное (там подсказки орфографии).
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);

  // Новая версия с сервера (правка коллеги, агент, возврат из истории): открываем её, если человек сейчас ничего не ждёт сохранения.
  const firstLoad = useRef(true);
  useEffect(() => {
    if (firstLoad.current) { firstLoad.current = false; return; }
    const next = parseSnapshot(content);
    setBroken(!next && Boolean(content.trim()));
    if (!next || !editor || editor.isDestroyed) return;
    base.current = next;
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
      unbind = bindPm(editor, live, async () => JSON.stringify(pmToUniver(editor.getJSON() as never, base.current as never)));
    });
    return () => { cancelled = true; unbind?.(); };
  }, [editor, live, loadKey]);

  // Ушли из документа или закрыли окно — несохранённое уходит сразу, без ожидания паузы.
  useEffect(() => {
    const onHide = () => flush(editor);
    window.addEventListener('beforeunload', onHide);
    return () => { window.removeEventListener('beforeunload', onHide); flush(editor); };
  }, [editor, flush]);

  const page = (base.current.documentStyle || {}) as { marginTop?: number; marginBottom?: number; marginLeft?: number; marginRight?: number; pageSize?: { width?: number; height?: number } };
  const pageStyle = useMemo(() => ({
    '--fdoc-w': `${page.pageSize?.width || 794}px`,
    '--fdoc-h': `${page.pageSize?.height || 1124}px`,
    paddingTop: page.marginTop ?? 72, paddingBottom: page.marginBottom ?? 72, paddingLeft: page.marginLeft ?? 72, paddingRight: page.marginRight ?? 72,
  }) as React.CSSProperties, [page.pageSize?.width, page.pageSize?.height, page.marginTop, page.marginBottom, page.marginLeft, page.marginRight]);

  if (broken) return <div className="nws-missing" role="alert">Не удалось прочитать содержимое документа: файл повреждён.</div>;

  return (
    <div className="fdoc" data-readonly={readOnly ? 'true' : undefined}>
      {!readOnly && editor && <Toolbar editor={editor} onPicture={(files) => insertPictures.current(files)} />}
      <div className="fdoc-scroll nx-scroll-y">
        <div className="fdoc-page" style={pageStyle} onContextMenu={(e) => { if (e.shiftKey || !editor) return; e.preventDefault(); setMenuAt({ x: e.clientX, y: e.clientY }); }}>
          <EditorContent editor={editor} />
        </div>
        {menuAt && editor && <DocContextMenu editor={editor} at={menuAt} readOnly={readOnly} onClose={() => setMenuAt(null)} onAddComment={onAddComment} />}
      </div>
    </div>
  );
}

function Toolbar({ editor, onPicture }: { editor: Editor; onPicture: (files: File[]) => void }) {
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
  const file = useRef<HTMLInputElement>(null);
  const run = (fn: (c: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) => fn(editor.chain().focus()).run();
  const btn = (key: string, title: string, active: boolean, icon: React.ReactNode, action: () => void, disabled = false) => (
    <button key={key} type="button" className="fdoc-btn" title={title} aria-label={title} aria-pressed={active} disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} onClick={action}>{icon}</button>
  );
  const setLink = () => {
    const prev = String(editor.getAttributes('link').href || '');
    const url = window.prompt('Адрес ссылки (пусто — убрать)', prev || 'https://');
    if (url === null) return;
    if (!url.trim() || url.trim() === 'https://') run((c) => c.extendMarkRange('link').unsetLink());
    else run((c) => c.extendMarkRange('link').setLink({ href: url.trim() }));
  };

  return (
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
      {btn('clear', 'Очистить оформление', false, <RemoveFormatting size={16} />, () => run((c) => c.unsetAllMarks()))}
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
      {btn('img', 'Картинка', false, <ImagePlus size={16} />, () => file.current?.click())}
      <input ref={file} type="file" accept="image/*" hidden onChange={(e) => { const f = [...(e.target.files || [])]; e.target.value = ''; if (f.length) onPicture(f); }} />
    </div>
  );
}
