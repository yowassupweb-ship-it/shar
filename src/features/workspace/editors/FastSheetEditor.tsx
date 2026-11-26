import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  ArrowDownAZ, ArrowUpZA, CopyPlus, Eye, EyeOff, Filter, Link2, ListChecks, Lock, NotebookPen, 
  Ungroup, Group as GroupIcon, Palette as PaletteIcon, ChevronsDownUp, Rows3, Columns3, PanelTop, PanelBottom, PanelLeft, PanelRight, Plus as PlusIcon,
  Shuffle, Scissors as SplitIcon, Space, CopyMinus, Tag, ArrowLeft, ArrowRight, List as ListIcon, Brackets, ArrowDownToLine, ArrowLeftToLine, ArrowRightToLine, ArrowUpToLine,
  ChevronLeft, ChevronRight, ClipboardPaste, Columns2, Copy, Eraser, Grid2x2, MoreHorizontal, MessageSquarePlus, Plus, Scissors, Square, TableCellsMerge,
  TableCellsSplit, Trash2, 
} from 'lucide-react';
import type { Workbook as ExcelWorkbook } from 'exceljs';
import {
  OAlignCenter, OAlignLeft, OAlignRight, OBold, OBorders, OChart, OChevronDown, OClearFormat, OComment, OCurrency, ODecimalDecrease, ODecimalIncrease, OFillColor, OFilter, OFontSizeMinus, OFontSizePlus,
  OFunctions, OInsertLink, OItalic, OMerge, OMoreVertical, OPaintFormat, OPercent, OPrint, ORedo, ORotate, OStrikethrough, OTextColor, OUndo,
  OVAlignBottom, OVAlignMiddle, OVAlignTop, OWrap,
} from '@/shared/ui/OfficeIcons';
import { Menu, MenuItem } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import { applySnapshot, bookFromBase64, bookToBase64, excelToUniver } from '../lib/workbook';
import type { LiveOp } from '../live/channel';
import { recalc, shiftFormula, supportedFunctions } from '../sheet/formulas';
import {
  a1, cellAt, colName, colWidth, displayText, editText, HEAD_H, HEAD_W, indexAt, inRange, mergeIndex, norm, offsets, parseA1, parseInput, parseRange,
  rangeA1, rowHeight, styleOf, Styles, usedBounds, type Book, type Cell, type Pos, type Range, type Sheet, type Style,
} from '../sheet/model';
import { applyOp, inverseOf, OP, wireCell } from '../sheet/ops';
import { remapRefs } from '../sheet/refs';
import { sharTarget } from '../../../shared/navigation/internalLinks';
import { LinkCard } from './LinkCard';
import { cellFont, drawSheet, FILTER_BTN, linkOf, readTheme, screenX, screenX2, screenY, screenY2, type BaseLayer } from '../sheet/draw';
import { canInsertRef, enclosingFunction, formulaRefs, refEndingAt, signatureOf, suggestFunctions, typingName } from '../sheet/formulaEdit';
import { dataRegion, filteredRows, readFilters, type FilterColumn } from '../sheet/filter';
import { FONTS, Palette, Pop } from './FastDocToolbar';
import { FindBar } from './FindBar';
import { FilterMenu } from './SheetFilterMenu';
import { BandingPanel, ChartPanel, CfPanel, DvPanel, NamesPanel, ProtectPanel, SHEET_SHORTCUTS } from './SheetPanels';
import { Sheet as Dialog } from '@/shared/ui/overlay';
import { DocLinkSheet } from './DocLinkSheet';
import { buildCf } from '../sheet/cf';
import { newId, readNames, sheetExtras, type ExtraKey, type Group, type SheetExtras, type SheetObject } from '../sheet/extras';
import { isChecked } from '../sheet/draw';
import { myId } from '@/shared/session/session';
import { uploadFileWithProgress } from '@/shared/api/uploadFile';
import { attachmentUrl } from '@/shared/ui/format';
import type { EditorProps } from './types';
import './fastDoc.css';
import './fastSheet.css';

/**
 * Свой редактор таблиц (бета) вместо Univer Sheets. Таблица — тот же xlsx: открывается через lib/workbook.ts в снимок
 * книги, правится здесь, сохраняется обратно файлом. Правки — мутации в формате прежнего редактора (sheet/ops.ts),
 * поэтому совместная правка идёт по тому же каналу и сводится тем же переносом, даже если коллега в Univer.
 *
 * Сетка рисуется обычными элементами страницы, только видимая часть: линии сетки — по линии на строку и столбец,
 * ячейки — только непустые. Закреплённые строки и столбцы — отдельными слоями, которые не уезжают при прокрутке.
 */

type SheetCursor = { sh: string; r1: number; c1: number; r2: number; c2: number };
interface Sel { anchor: Pos; focus: Pos }
interface Edit { row: number; col: number; text: string; bar?: boolean }
interface Step { forward: LiveOp[]; inverse: LiveOp[] }
type Clip = { tsv: string; range: Range; sheet: string; cells: Record<number, Record<number, Cell | null>>; cut: boolean };

const SAVE_IDLE_MS = 700;
const NO_CELLS: Array<{ sheet: string; cell: string }> = [];
const BORDER_W: Record<number, number> = { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 3, 8: 2, 9: 2, 10: 2, 11: 2, 12: 2, 13: 3 };
const BORDER_KIND: Record<number, string> = { 2: 'dotted', 3: 'dotted', 4: 'dashed', 7: 'double', 9: 'dashed' };
const SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48];

const lightness = (hex: string) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};

/** Оформление ячейки → CSS. Цвет текста помечается яркостью (data-ink): в тёмной теме чёрный подменяется цветом темы. */
function cellCss(style: Style | null): { css: CSSProperties; ink?: string; wrap: boolean; h?: string; v?: string } {
  const css: CSSProperties = {};
  if (!style) return { css, wrap: false };
  if (style.bl) css.fontWeight = 700;
  if (style.it) css.fontStyle = 'italic';
  const deco = [(style.ul as { s?: number } | undefined)?.s ? 'underline' : '', (style.st as { s?: number } | undefined)?.s ? 'line-through' : ''].filter(Boolean).join(' ');
  if (deco) css.textDecoration = deco;
  if (typeof style.fs === 'number') css.fontSize = `${style.fs}pt`;
  // Шрифта из файла может не быть в системе — запасной без засечек, как у Excel и Google.
  if (typeof style.ff === 'string' && style.ff) css.fontFamily = `"${style.ff.replace(/"/g, '')}", Arial, sans-serif`;
  const cl = (style.cl as { rgb?: string } | undefined)?.rgb;
  let ink: string | undefined;
  if (cl) { css.color = cl; const l = lightness(cl); ink = l === null ? undefined : l < 0.35 ? 'dark' : l > 0.85 ? 'light' : 'mid'; }
  const bg = (style.bg as { rgb?: string } | undefined)?.rgb;
  if (bg) {
    css.background = bg;
    // Светлая заливка без своего цвета текста: текст тёмный, иначе в тёмной теме он сливается с заливкой.
    const l = lightness(bg);
    if (!cl && l !== null) { css.color = l > 0.55 ? '#1f1f1f' : '#f1f1f1'; ink = 'fixed'; }
  }
  const bd = style.bd as Record<string, { s?: number; cl?: { rgb?: string } } | null> | undefined;
  if (bd) {
    // Цвет «авто» (не задан или чёрный) — цветом текста листа: в тёмной теме чёрные границы были тяжёлыми тёмными полосами.
    const auto = (c?: string) => (!c || /^#?0{6}$/.test(c) ? 'var(--sh-border-auto)' : c);
    const side = (k: string) => { const b = bd[k]; return b?.s ? `${BORDER_W[b.s] ?? 1}px ${BORDER_KIND[b.s] ?? 'solid'} ${auto(b.cl?.rgb)}` : undefined; };
    css.borderTop = side('t'); css.borderBottom = side('b'); css.borderLeft = side('l'); css.borderRight = side('r');
  }
  const h = ({ 1: 'left', 2: 'center', 3: 'right', 4: 'justify' } as Record<number, string>)[Number(style.ht)];
  const v = ({ 1: 'top', 2: 'middle', 3: 'bottom' } as Record<number, string>)[Number(style.vt)];
  return { css, ink, wrap: style.tb === 3, h, v };
}

/** Текст формулы с цветными ссылками (подложка поля правки: цвет — тот же, что у рамки на листе). */
function renderColored(text: string, refs: Array<{ start: number; end: number; color: string }>): ReactNode[] {
  if (!text.startsWith('=') || !refs.length) return [text];
  const out: ReactNode[] = [];
  let at = 0;
  refs.forEach((r, i) => {
    if (r.start > at) out.push(text.slice(at, r.start));
    out.push(<span key={i} style={{ color: r.color }}>{text.slice(r.start, r.end)}</span>);
    at = r.end;
  });
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** Разбор вставленного текста (TSV из Excel и Google Таблиц): кавычки, переводы строк внутри ячеек. */
function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const t = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  for (let i = 0; i < t.length; i += 1) {
    const ch = t[i];
    if (quoted) {
      if (ch === '"' && t[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === '\t') { row.push(cell); cell = ''; } else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}
const tsvCell = (s: string) => (/[\t\n"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

type StatKind = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'countNum';
type HeadHover = { kind: 'col' | 'row' | 'resize-col' | 'resize-row'; index: number } | null;
/** Сколько гаснет вспышка ячейки, изменённой агентом или коллегой. */
const FLASH_MS = 700;

/**
 * Фоновый поток сохранения (lib/sheetSave.worker.ts) — один на окно. null — не поднялся (тогда сохраняем по-старому).
 * Ответы сопоставляются по номеру запроса.
 */
let saveWorker: Worker | null | undefined;
let saveSeq = 0;
const saveWaits = new Map<number, { resolve: (v: string | null) => void }>();
function saveInWorker(doc: { key: string; content: string }, snapshot: unknown): Promise<string | null> {
  if (!doc.key) return Promise.resolve(null);
  if (saveWorker === undefined) {
    try {
      saveWorker = new Worker(new URL('../lib/sheetSave.worker.ts', import.meta.url), { type: 'module' });
      saveWorker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; content?: string }>) => {
        const wait = saveWaits.get(e.data.id);
        saveWaits.delete(e.data.id);
        wait?.resolve(e.data.ok && typeof e.data.content === 'string' ? e.data.content : null);
      };
      saveWorker.onerror = () => { for (const w of saveWaits.values()) w.resolve(null); saveWaits.clear(); saveWorker = null; };
    } catch { saveWorker = null; }
  }
  const worker = saveWorker;
  if (!worker) return Promise.resolve(null);
  saveSeq += 1;
  const id = saveSeq;
  return new Promise((resolve) => {
    saveWaits.set(id, { resolve });
    try { worker.postMessage({ id, key: doc.key, content: doc.content, snapshot }); } catch { saveWaits.delete(id); resolve(null); }
  });
}

/** Номер объекта по его тождеству — для ключа кэша холста. */
const objIds = new WeakMap<object, number>();
let objSeq = 0;
function objId(o: object | null | undefined): number {
  if (!o) return 0;
  let n = objIds.get(o);
  if (!n) { objSeq += 1; n = objSeq; objIds.set(o, n); }
  return n;
}

export default function FastSheetEditor({ content, onContent, readOnly, loadKey, cursors = [], onCursor, live, commentsBridge, commentCells = NO_CELLS, onAddComment, onCommentCell }: EditorProps) {
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  const book = useRef<Book | null>(null);
  const excel = useRef<ExcelWorkbook | null>(null);
  const styles = useRef<Styles | null>(null);
  const [error, setError] = useState('');
  const [sheetId, setSheetId] = useState('');
  const [sel, setSel] = useState<Sel>({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } });
  const [edit, setEdit] = useState<Edit | null>(null);
  const [, setScroll] = useState({ x: 0, y: 0 });
  const [view, setView] = useState({ w: 800, h: 600 });
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // Страница контекстного меню (вложенные — как в iOS/macOS); при каждом открытии — первая.
  const [menuPage, setMenuPage] = useState<'main' | 'paste' | 'insert' | 'delete' | 'more'>('main');
  useEffect(() => { if (menu) setMenuPage('main'); }, [menu]);
  const [pop, setPop] = useState<{ kind: string; at: DOMRect; trigger: HTMLElement } | null>(null);
  const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [find, setFind] = useState<{ open: boolean; query: string; index: number; replace?: boolean }>({ open: false, query: '', index: 0 });
  const [clipMark, setClipMark] = useState<Range | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  /** Масштаб листа (Ctrl+колесо и выпадающий список, как в Google): все размеры листа × zoom. */
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  const [panel, setPanel] = useState<null | 'cf' | 'dv' | 'protect' | 'banding' | 'names' | { chart: string }>(null);
  const [shortcuts, setShortcuts] = useState(false);
  const [customFmt, setCustomFmt] = useState('');
  const [borderStyle, setBorderStyle] = useState<{ color: string; s: number }>({ color: '#000000', s: 1 });
  const [sheetsMenu, setSheetsMenu] = useState<{ x: number; y: number } | null>(null);
  const dragTab = useRef<string | null>(null);
  const [selectedObject, setSelectedObject] = useState<string | null>(null);
  const [objDraft, setObjDraft] = useState<SheetObject | null>(null);
  const [listMenu, setListMenu] = useState<{ r: number; c: number; x: number; y: number; values: string[] } | null>(null);
  const [noteTip, setNoteTip] = useState<{ key: string; x: number; y: number } | null>(null);
  const [noteEdit, setNoteEdit] = useState<{ r: number; c: number; text: string } | null>(null);
  const [linkEdit, setLinkEdit] = useState<{ r: number; c: number; initial: string } | null>(null);
  // Какой показатель выделения виден в углу (как в Google: выбирается в списке, запоминается).
  const [statKind, setStatKind] = useState<StatKind>(() => { try { return (localStorage.getItem('fsh:stat') as StatKind) || 'sum'; } catch { return 'sum'; } });
  // Карточку ссылки закрыли (Esc) — для этой ячейки не показываем, пока не выберут другую.
  const [cardClosed, setCardClosed] = useState('');
  const imageInput = useRef<HTMLInputElement>(null);
  const pasteValues = useRef(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const barInput = useRef<HTMLInputElement>(null);
  /** Позиция каретки в правке (для подсказки функций и вставки ссылок щелчком). */
  const [caret, setCaret] = useState(0);
  // Подсказка из столбца погашена (стёрли символ) — до следующего набранного.
  const [autoOff, setAutoOff] = useState(false);
  const [suggestAt, setSuggestAt] = useState(0);
  const [suggestOff, setSuggestOff] = useState(false);
  /** «Копировать формат» (кисть): оформление, которое получит следующее выделение. */
  const [painter, setPainter] = useState<Style | null>(null);
  const undo = useRef<Step[]>([]);
  const redo = useRef<Step[]>([]);
  const clip = useRef<Clip | null>(null);
  const liveRef = useRef<{ local: (ops: LiveOp[]) => void } | null>(null);
  const unknownWarned = useRef(false);
  const saveTimer = useRef(0);
  const loaded = useRef<{ key: string; content: string }>({ key: '', content: '' });
  const onContentRef = useRef(onContent);
  onContentRef.current = onContent;
  const contentRef = useRef(content);
  contentRef.current = content;

  // ── Открытие: xlsx → книга ExcelJS → снимок (модель). Заново — при смене loadKey (перечитали с сервера). ──
  useEffect(() => {
    let alive = true;
    setError('');
    const opened = contentRef.current;
    bookFromBase64(opened).then((wb) => {
      if (!alive) return;
      const snap = excelToUniver(wb) as unknown as Book;
      excel.current = wb;
      // Фоновое сохранение держит свою копию книги — от того же содержимого, с которым открыли.
      loaded.current = { key: `${Date.now()}:${Math.random()}`, content: opened };
      book.current = snap;
      styles.current = new Styles(snap);
      recalc(snap);
      undo.current = []; redo.current = [];
      setSheetId((cur) => (cur && snap.sheets[cur] ? cur : snap.sheetOrder.find((id) => !snap.sheets[id]?.hidden) || snap.sheetOrder[0] || ''));
      bump();
    }).catch(() => { if (alive) setError('Не удалось открыть таблицу: файл повреждён или не xlsx.'); });
    return () => { alive = false; };
  }, [loadKey]);  

  const serialize = useCallback(async (): Promise<string> => {
    if (!book.current || !excel.current) return contentRef.current;
    // Сначала — в фоновом потоке (лист не замирает на время сборки xlsx); не вышло — как раньше, здесь.
    const viaWorker = await saveInWorker(loaded.current, book.current).catch(() => null);
    if (viaWorker !== null) return viaWorker;
    applySnapshot(excel.current, book.current as never);
    return bookToBase64(excel.current);
  }, []);

  const flush = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    void serialize().then((next) => { if (next !== contentRef.current) onContentRef.current(next); }).catch(() => showToast('Таблица не сохранилась — попробуйте ещё раз', 'error'));
  }, [serialize]);
  const scheduleSave = useCallback(() => { window.clearTimeout(saveTimer.current); saveTimer.current = window.setTimeout(flush, SAVE_IDLE_MS); }, [flush]);
  useEffect(() => {
    const onHide = () => { if (saveTimer.current) flush(); };
    window.addEventListener('beforeunload', onHide);
    return () => { window.removeEventListener('beforeunload', onHide); if (saveTimer.current) flush(); };
  }, [flush]);

  /** Правка: обратная — в историю, сама — в книгу, коллегам и на сохранение. */
  const commit = useCallback((ops: LiveOp[], history = true) => {
    const b = book.current; const st = styles.current;
    if (!b || !st || readOnly || !ops.length) return;
    // Защищённые диапазоны: правят владелец и выбранные люди; «только предупреждать» — правка проходит с подсказкой.
    const me = myId();
    for (const op of ops) {
      const sid = String(op.params.subUnitId || '');
      const list = sheetExtras(b, sid).protect || [];
      if (!list.length) continue;
      const touched: Range[] = [];
      if (op.id === OP.VALUES) for (const [r, cols] of Object.entries((op.params.cellValue as Record<string, Record<string, unknown>>) || {})) for (const c of Object.keys(cols || {})) touched.push({ startRow: Number(r), endRow: Number(r), startColumn: Number(c), endColumn: Number(c) });
      else if (op.params.range) touched.push(op.params.range as Range);
      const hit0 = list.find((p) => touched.some((t) => t.startRow <= p.range.endRow && p.range.startRow <= t.endRow && t.startColumn <= p.range.endColumn && p.range.startColumn <= t.endColumn));
      if (!hit0) continue;
      if (hit0.owner === me || hit0.editors.includes(me)) continue;
      if (hit0.warnOnly) { showToast(`Вы правите защищённый диапазон${hit0.description ? ` «${hit0.description}»` : ''}`, 'info'); continue; }
      showToast(`Диапазон защищён${hit0.description ? ` («${hit0.description}»)` : ''} — его правят только выбранные люди`, 'error');
      return;
    }
    const inverse: LiveOp[] = [];
    for (const op of ops) { inverse.unshift(...inverseOf(b, op)); applyOp(b, st, op); }
    recalc(b);
    if (history) { undo.current.push({ forward: ops, inverse }); if (undo.current.length > 200) undo.current.shift(); redo.current = []; }
    liveRef.current?.local(ops);
    scheduleSave();
    bump();
  }, [readOnly, scheduleSave]);

  const undoStep = useCallback((back: boolean) => {
    const from = back ? undo.current : redo.current;
    const to = back ? redo.current : undo.current;
    const step = from.pop();
    if (!step || !book.current || !styles.current) return;
    const ops = back ? step.inverse : step.forward;
    for (const op of ops) applyOp(book.current, styles.current, op);
    recalc(book.current);
    to.push(step);
    liveRef.current?.local(ops);
    scheduleSave();
    bump();
  }, [scheduleSave]);

  // ── Совместная правка: чужие правки — в книгу, свои — каналу. ──
  useEffect(() => {
    if (!live || !book.current) return undefined;
    const detach = live.attach({
      apply: (ops) => {
        const b = book.current; const st = styles.current;
        if (!b || !st) return;
        for (const op of ops) {
          if (!applyOp(b, st, op) && !unknownWarned.current) {
            unknownWarned.current = true;
            showToast('Коллега сделал правку, которую бета-редактор пока не показывает — откройте таблицу заново', 'info');
          }
        }
        recalc(b);
        // Чужие (агента, коллеги) изменённые ячейки коротко вспыхивают — видно, что и где поменялось.
        const now = performance.now();
        for (const op of ops) {
          if (op.id !== OP.VALUES || (op.params as { subUnitId?: string }).subUnitId !== sheetIdRef.current) continue;
          const cv = (op.params as { cellValue?: Record<string, Record<string, unknown>> }).cellValue || {};
          for (const [r, row] of Object.entries(cv)) for (const col of Object.keys(row || {})) if (flash.current.size < 4000) flash.current.set(`${r}:${col}`, now);
        }
        if (flash.current.size) redraw();
        // Чужая вставка или удаление строк сдвигает адреса — старая история отмены больше не точна.
        if (ops.some((op) => op.id !== OP.VALUES)) { undo.current = []; redo.current = []; }
        if (b.sheets[sheetIdRef.current] === undefined) setSheetId(b.sheetOrder[0] || '');
        bump();
      },
      serialize,
    });
    liveRef.current = { local: (ops) => live.local(ops) };
    return () => { liveRef.current = null; detach(); };
  }, [live, serialize, Boolean(book.current)]); // eslint-disable-line react-hooks/exhaustive-deps

  const b = book.current;
  const sheet = (b && sheetId ? b.sheets[sheetId] : null) as Sheet | null;
  const sheetIdRef = useRef(sheetId);
  sheetIdRef.current = sheetId;

  // ── Геометрия: смещения строк и столбцов, закрепление, объединения, отфильтрованные строки. ──
  const xs: SheetExtras = useMemo(() => (b && sheetId ? sheetExtras(b, sheetId) : {}), [b, sheetId, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const cfLookup = useMemo(() => (b && sheet ? buildCf(b, sheet, xs.cf) : null), [b, sheet, xs, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const setExtra = useCallback(<K extends ExtraKey>(key: K, value: SheetExtras[K] | null) => {
    commit([{ id: OP.EXTRA, params: { subUnitId: sheetIdRef.current, key, value: value ?? null } }]);
  }, [commit]);
  // Пересчёт — только при правках (version) и смене листа: прокрутка их не трогает (раньше считалось на каждый кадр).
  const geo = useMemo(() => {
    if (!sheet) return null;
    const filteredOut = new Set<number>();
    const res = b?.resources?.find((r) => r.name === 'SHEET_FILTER_PLUGIN');
    try { const data = res?.data ? JSON.parse(res.data) as Record<string, { cachedFilteredOut?: number[] }> : {}; for (const r of data[sheetId]?.cachedFilteredOut || []) filteredOut.add(r); } catch { /* без фильтра */ }
    const rows = Math.max(sheet.rowCount || 100, 100);
    const cols = Math.max(sheet.columnCount || 26, 26);
    const rowOffs = offsets(rows, (r) => (filteredOut.has(r) ? 0 : rowHeight(sheet, r)));
    const colOffs = offsets(cols, (c) => colWidth(sheet, c));
    const fr = sheet.freeze && sheet.freeze.ySplit > 0 ? Math.min(rows, sheet.freeze.startRow) : 0;
    const fc = sheet.freeze && sheet.freeze.xSplit > 0 ? Math.min(cols, sheet.freeze.startColumn) : 0;
    return { rows, cols, rowOffs, colOffs, fr, fc, fh: rowOffs[fr], fw: colOffs[fc], merges: mergeIndex(sheet) };
  }, [sheet, b, sheetId, version]); // eslint-disable-line react-hooks/exhaustive-deps

  // Размер окна сетки.
  useLayoutEffect(() => {
    const el = grid.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setView({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setView({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [Boolean(sheet)]); // eslint-disable-line react-hooks/exhaustive-deps

  const range = norm({ startRow: sel.anchor.row, startColumn: sel.anchor.col, endRow: sel.focus.row, endColumn: sel.focus.col });
  /** Диапазон, расширенный до целых объединений (как выделяют Excel и Google). */
  const expand = useCallback((r: Range): Range => {
    if (!geo) return r;
    const out = { ...r };
    let grew = true;
    let guard = 0;
    while (grew && guard < 20) {
      grew = false; guard += 1;
      for (const m of sheet?.mergeData || []) {
        if (m.startRow <= out.endRow && out.startRow <= m.endRow && m.startColumn <= out.endColumn && out.startColumn <= m.endColumn) {
          if (m.startRow < out.startRow) { out.startRow = m.startRow; grew = true; }
          if (m.endRow > out.endRow) { out.endRow = m.endRow; grew = true; }
          if (m.startColumn < out.startColumn) { out.startColumn = m.startColumn; grew = true; }
          if (m.endColumn > out.endColumn) { out.endColumn = m.endColumn; grew = true; }
        }
      }
    }
    return out;
  }, [geo, sheet]);
  const selRange = expand(range);

  // Своё выделение — коллегам.
  const onCursorRef = useRef(onCursor);
  onCursorRef.current = onCursor;
  useEffect(() => {
    if (!sheetId) return;
    onCursorRef.current?.({ sh: sheetId, r1: selRange.startRow, c1: selRange.startColumn, r2: selRange.endRow, c2: selRange.endColumn } as never);
  }, [sheetId, selRange.startRow, selRange.startColumn, selRange.endRow, selRange.endColumn]);

  // Выбрали ячейку с комментарием — показать ветку.
  const onCommentCellRef = useRef(onCommentCell);
  onCommentCellRef.current = onCommentCell;
  useEffect(() => {
    if (!sheet || edit) return;
    const name = a1(sel.anchor.row, sel.anchor.col);
    if (commentCells.some((m) => m.cell === name && (!m.sheet || m.sheet === sheet.name))) onCommentCellRef.current?.({ sheet: sheet.name, cell: name });
  }, [sel.anchor.row, sel.anchor.col, sheet?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Координаты: ячейка ↔ точка окна (с учётом закрепления) ──
  const hit = useCallback((clientX: number, clientY: number) => {
    const el = grid.current;
    if (!el || !geo) return null;
    const box = el.getBoundingClientRect();
    const z = zoomRef.current;
    const lx = (clientX - box.left) / z; const ly = (clientY - box.top) / z;
    const sx = lx - HEAD_W; const sy = ly - HEAD_H;
    const col = sx < 0 ? -1 : indexAt(geo.colOffs, sx < geo.fw ? sx : sx + el.scrollLeft / z);
    const row = sy < 0 ? -1 : indexAt(geo.rowOffs, sy < geo.fh ? sy : sy + el.scrollTop / z);
    return { row: Math.min(row, geo.rows - 1), col: Math.min(col, geo.cols - 1), lx, ly, sx, sy };
  }, [geo]);

  /** Прокрутить так, чтобы ячейка была видна. */
  const reveal = useCallback((r: number, c: number) => {
    const el = grid.current;
    if (!el || !geo) return;
    const z = zoomRef.current;
    const sl = el.scrollLeft / z; const st0 = el.scrollTop / z;
    if (c >= geo.fc) {
      const left = geo.colOffs[c] - geo.fw; const right = geo.colOffs[c + 1];
      const viewW = el.clientWidth / z - HEAD_W;
      if (left < sl) el.scrollLeft = left * z;
      else if (right > sl + viewW) el.scrollLeft = (right - viewW) * z;
    }
    if (r >= geo.fr) {
      const top = geo.rowOffs[r] - geo.fh; const bottom = geo.rowOffs[r + 1];
      const viewH = el.clientHeight / z - HEAD_H;
      if (top < st0) el.scrollTop = top * z;
      else if (bottom > st0 + viewH) el.scrollTop = (bottom - viewH) * z;
    }
  }, [geo]);

  // ── Правки ячеек ──
  const setCells = useCallback((cells: Record<number, Record<number, Cell | null>>, sid = sheetId) => {
    if (Object.keys(cells).length) commit([{ id: OP.VALUES, params: { subUnitId: sid, cellValue: cells } }]);
  }, [commit, sheetId]);

  /** Ввод в ячейку: значение, формула, формат числа из ввода (процент, дата). */
  const writeInput = useCallback((r: number, c: number, text: string) => {
    if (!b || !sheet) return;
    const dvRule = (sheetExtras(b, sheetIdRef.current).dv || []).find((x) => x.ranges.some((g0) => r >= g0.startRow && r <= g0.endRow && c >= g0.startColumn && c <= g0.endColumn));
    if (dvRule?.kind === 'list' && dvRule.strict && text && !(dvRule.values || []).includes(text)) { showToast('Можно выбрать только значение из списка', 'error'); return; }
    const parsed = parseInput(text);
    const prev = cellAt(sheet, r, c);
    const style = styleOf(b, prev);
    const next: Cell = { v: parsed.v ?? null, f: parsed.f ?? null, t: parsed.t ?? null } as Cell;
    if (parsed.pattern && !(style?.n as { pattern?: string } | undefined)?.pattern) next.s = { ...(style || {}), n: { pattern: parsed.pattern } } as Cell['s'];
    if (!prev && parsed.v === null && !parsed.f) return;
    setCells({ [r]: { [c]: next } });
  }, [b, sheet, setCells]);

  /** Ячейки выделения (в пределах данных листа: целый столбец не превращается в миллион правок). */
  const eachSelected = useCallback((fn: (r: number, c: number) => void, r0 = selRange) => {
    if (!sheet) return;
    const used = usedBounds(sheet);
    const lastRow = Math.min(r0.endRow, Math.max(r0.startRow, used.rows - 1, r0.startRow + 199));
    const lastCol = Math.min(r0.endColumn, Math.max(r0.startColumn, used.cols - 1, r0.startColumn + 49));
    for (let r = r0.startRow; r <= lastRow; r += 1) for (let c = r0.startColumn; c <= lastCol; c += 1) fn(r, c);
  }, [sheet, selRange]);

  /** Поменять оформление выделения: patch(стиль) → новый стиль. */
  const restyle = useCallback((patch: (s: Style) => Style) => {
    if (!b || !sheet) return;
    const cells: Record<number, Record<number, Cell | null>> = {};
    eachSelected((r, c) => {
      const prev = cellAt(sheet, r, c);
      const next = patch({ ...(styleOf(b, prev) || {}) } as Style);
      const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined && v !== null));
      (cells[r] ||= {})[c] = { s: (Object.keys(clean).length ? clean : null) as Cell['s'] };
    });
    setCells(cells);
  }, [b, sheet, eachSelected, setCells]);
  const anchorStyle = (b && sheet ? styleOf(b, cellAt(sheet, sel.anchor.row, sel.anchor.col)) : null) || ({} as Style);
  const toggle = (key: string, on: unknown) => restyle((s) => ({ ...s, [key]: anchorStyle[key] ? undefined : on }));

  const clearValues = useCallback(() => {
    if (!sheet) return;
    const cells: Record<number, Record<number, Cell | null>> = {};
    eachSelected((r, c) => { if (cellAt(sheet, r, c)?.v !== undefined || cellAt(sheet, r, c)?.f) (cells[r] ||= {})[c] = { v: null, f: null, p: null } as Cell; });
    setCells(cells);
  }, [sheet, eachSelected, setCells]);

  // ── Буфер обмена: TSV и HTML для других программ, свой — с оформлением и формулами ──
  const copy = useCallback((cut: boolean, data: DataTransfer | null) => {
    if (!b || !sheet) return;
    const r0 = selRange;
    const lines: string[] = [];
    const html: string[] = [];
    const cells: Clip['cells'] = {};
    for (let r = r0.startRow; r <= r0.endRow; r += 1) {
      const line: string[] = [];
      const tr: string[] = [];
      for (let c = r0.startColumn; c <= r0.endColumn; c += 1) {
        const cell = cellAt(sheet, r, c);
        const text = displayText(cell, styleOf(b, cell));
        line.push(tsvCell(text));
        tr.push(`<td>${esc(text)}</td>`);
        (cells[r - r0.startRow] ||= {})[c - r0.startColumn] = wireCell(b, cell);
      }
      lines.push(line.join('\t'));
      html.push(`<tr>${tr.join('')}</tr>`);
    }
    const tsv = lines.join('\n');
    clip.current = { tsv, range: r0, sheet: sheetId, cells, cut };
    setClipMark(r0);
    if (data) { data.setData('text/plain', tsv); data.setData('text/html', `<table>${html.join('')}</table>`); } else void navigator.clipboard?.writeText(tsv).catch(() => undefined);
  }, [b, sheet, selRange, sheetId]);

  const paste = useCallback((text: string, only?: 'values' | 'format' | 'transpose') => {
    if (!b || !sheet) return;
    const own = clip.current && clip.current.tsv === text.replace(/\r\n?/g, '\n').replace(/\n$/, '') ? clip.current : null;
    const at = selRange;
    const cells: Record<number, Record<number, Cell | null>> = {};
    if (own) {
      const dr = at.startRow - own.range.startRow; const dc = at.startColumn - own.range.startColumn;
      const h = own.range.endRow - own.range.startRow + 1; const w = own.range.endColumn - own.range.startColumn + 1;
      // Выделение больше скопированного и кратно ему — заполняем повтором (как в Excel).
      const reps = (n: number, k: number) => (n % k === 0 ? n / k : 1);
      const rr = reps(at.endRow - at.startRow + 1, h); const rc = reps(at.endColumn - at.startColumn + 1, w);
      if (only === 'transpose') {
        // Транспонировать: строки становятся столбцами (формулы — значениями, как у Google при переносе ссылок).
        for (let i = 0; i < h; i += 1) for (let j = 0; j < w; j += 1) {
          const src = own.cells[i]?.[j] ?? null;
          (cells[at.startRow + j] ||= {})[at.startColumn + i] = src ? { ...src, f: null } : { v: null, f: null, s: null } as Cell;
        }
        commit([{ id: OP.VALUES, params: { subUnitId: sheetId, cellValue: cells } }]);
        setSel({ anchor: { row: at.startRow, col: at.startColumn }, focus: { row: at.startRow + w - 1, col: at.startColumn + h - 1 } });
        return;
      }
      for (let i = 0; i < h * rr; i += 1) for (let j = 0; j < w * rc; j += 1) {
        const src = own.cells[i % h]?.[j % w] ?? null;
        let cell: Cell | null = src ? { ...src } : { v: null, f: null, s: null } as Cell;
        if (cell?.f) cell = { ...cell, f: shiftFormula(String(cell.f), dr + Math.floor(i / h) * h, dc + Math.floor(j / w) * w) };
        if (only === 'values') cell = { v: cell?.v ?? null, f: null } as Cell;
        if (only === 'format') cell = { s: cell?.s ?? null } as Cell;
        (cells[at.startRow + i] ||= {})[at.startColumn + j] = cell;
      }
      const ops: LiveOp[] = [{ id: OP.VALUES, params: { subUnitId: sheetId, cellValue: cells } }];
      if (own.cut && own.sheet === sheetId && only !== 'format') {
        // Вырезали — источник очищается (кроме того, что попало под вставку).
        const clear: Record<number, Record<number, Cell | null>> = {};
        for (let r = own.range.startRow; r <= own.range.endRow; r += 1) for (let c = own.range.startColumn; c <= own.range.endColumn; c += 1) {
          if (!cells[r]?.[c] && cellAt(sheet, r, c)) (clear[r] ||= {})[c] = null;
        }
        if (Object.keys(clear).length) ops.unshift({ id: OP.VALUES, params: { subUnitId: sheetId, cellValue: clear } });
        clip.current = null; setClipMark(null);
      }
      commit(ops);
      setSel({ anchor: { row: at.startRow, col: at.startColumn }, focus: { row: at.startRow + h * rr - 1, col: at.startColumn + w * rc - 1 } });
      return;
    }
    if (only === 'format' || only === 'transpose') return;
    const rows = parseTsv(text);
    rows.forEach((line, i) => line.forEach((value, j) => {
      const parsed = parseInput(value);
      (cells[at.startRow + i] ||= {})[at.startColumn + j] = { v: parsed.v ?? null, f: parsed.f ?? null, t: parsed.t ?? null } as Cell;
    }));
    setCells(cells);
    setSel({ anchor: { row: at.startRow, col: at.startColumn }, focus: { row: at.startRow + rows.length - 1, col: at.startColumn + Math.max(...rows.map((r) => r.length)) - 1 } });
  }, [b, sheet, selRange, sheetId, commit, setCells]);

  /**
   * Перенести ячейки (перетаскиванием рамки): значения, формулы и оформление уезжают на новое место, старое
   * очищается. Формулы внутри не сдвигаются — как в Google при переносе. Одна правка — один шаг отмены.
   */
  const moveCells = useCallback((from: Range, to: Range) => {
    if (!b || !sheet) return;
    const cells: Record<number, Record<number, Cell | null>> = {};
    for (let r = from.startRow; r <= from.endRow; r += 1) for (let c = from.startColumn; c <= from.endColumn; c += 1) {
      const cell = cellAt(sheet, r, c);
      (cells[to.startRow + r - from.startRow] ||= {})[to.startColumn + c - from.startColumn] = cell ? wireCell(b, cell) : null;
    }
    for (let r = from.startRow; r <= from.endRow; r += 1) for (let c = from.startColumn; c <= from.endColumn; c += 1) {
      if (cells[r]?.[c] === undefined) (cells[r] ||= {})[c] = null;
    }
    commit([{ id: OP.VALUES, params: { subUnitId: sheetId, cellValue: cells } }]);
    const dr = to.startRow - from.startRow; const dc = to.startColumn - from.startColumn;
    setSel((x) => ({ anchor: { row: x.anchor.row + dr, col: x.anchor.col + dc }, focus: { row: x.focus.row + dr, col: x.focus.col + dc } }));
  }, [b, sheet, sheetId, commit]);

  /**
   * Переставить выделенные целиком строки (столбцы) перед индексом at — как перетаскивание за номера в Google.
   * Собрано из обычных правок (удалить → вставить → записать ячейки и размеры), поэтому идёт к коллегам и
   * отменяется одним шагом. Ссылки формул на переставленные строки не переписываются — это пока отличие от Google.
   */
  const moveLines = useCallback((axis: 'row' | 'col', at: number) => {
    if (!b || !sheet || !geo) return;
    const rows = axis === 'row';
    const s0 = rows ? selRange.startRow : selRange.startColumn; const s1 = rows ? selRange.endRow : selRange.endColumn;
    const n = s1 - s0 + 1;
    if (at >= s0 && at <= s1 + 1) return;
    const dest = at > s1 ? at - n : at;
    // Куда уезжает каждая строка (столбец): блок — на новое место, те, что между, — сдвигаются на n.
    const map = (i: number) => (i >= s0 && i <= s1 ? dest + i - s0 : at > s1 && i > s1 && i < at ? i - n : at < s0 && i >= at && i < s0 ? i + n : i);
    const breaks = [s0, s1, s1 + 1, at - 1, at, s0 - 1];
    // Исходные формулы на старых местах: эта правка ничего не меняет, но её отмена идёт последней и возвращает формулы
    // ровно как были (иначе отмена удаления/вставки строк портила бы ссылки на них).
    const before: Record<string, Record<number, Record<number, Cell | null>>> = {};
    const cells: Record<number, Record<number, Cell | null>> = {};
    for (const [rk, row] of Object.entries(sheet.cellData || {})) {
      for (const [ck, cell] of Object.entries(row || {})) {
        const r = Number(rk); const c = Number(ck); const i = rows ? r : c;
        if (!cell || i < s0 || i > s1) continue;
        if (cell.f) ((before[sheetId] ||= {})[r] ||= {})[c] = { f: cell.f } as Cell;
        const nr = rows ? map(r) : r; const nc = rows ? c : map(c);
        const wired = wireCell(b, cell);
        (cells[nr] ||= {})[nc] = wired?.f ? { ...wired, f: remapRefs(String(wired.f), sheet.name, sheet.name, rows, map, breaks) } : wired;
      }
    }
    // Ссылки следуют за ячейками (как в Google): формулы книги, которые ссылаются на переставленные строки,
    // переписываются по той же перестановке (удаление строк иначе превратило бы их в #REF!).
    const otherSheets: LiveOp[] = [];
    for (const id of b.sheetOrder) {
      const own = b.sheets[id];
      if (!own) continue;
      const fixes: Record<number, Record<number, Cell | null>> = {};
      for (const [rk, row] of Object.entries(own.cellData || {})) {
        for (const [ck, cell] of Object.entries(row || {})) {
          if (!cell?.f) continue;
          const r = Number(rk); const c = Number(ck);
          if (id === sheetId && (rows ? r : c) >= s0 && (rows ? r : c) <= s1) continue;
          const f2 = remapRefs(String(cell.f), own.name, sheet.name, rows, map, breaks);
          // Даже не изменившуюся формулу записываем, если она ссылается на этот лист: удаление и вставка строк
          // по дороге сдвигают ссылки, и без записи она осталась бы испорченной.
          if (f2 === cell.f && id !== sheetId && !String(cell.f).toLowerCase().includes(sheet.name.toLowerCase())) continue;
          ((before[id] ||= {})[r] ||= {})[c] = { f: cell.f } as Cell;
          const nr = id === sheetId && rows ? map(r) : r; const nc = id === sheetId && !rows ? map(c) : c;
          (fixes[nr] ||= {})[nc] = { f: f2 } as Cell;
        }
      }
      if (!Object.keys(fixes).length) continue;
      if (id === sheetId) { for (const [r, row] of Object.entries(fixes)) for (const [c, cell] of Object.entries(row)) (cells[Number(r)] ||= {})[Number(c)] = cell; }
      else otherSheets.push({ id: OP.VALUES, params: { subUnitId: id, cellValue: fixes } });
    }
    const info: Record<string, { h?: number; w?: number }> = {};
    for (let i = s0; i <= s1; i += 1) {
      const size = rows ? sheet.rowData?.[i]?.h : sheet.columnData?.[i]?.w;
      if (size) info[i - s0] = rows ? { h: size } : { w: size };
    }
    const full = rows ? { startColumn: 0, endColumn: geo.cols - 1 } : { startRow: 0, endRow: geo.rows - 1 };
    const src = rows ? { startRow: s0, endRow: s1, ...full } : { startColumn: s0, endColumn: s1, ...full };
    const dst = rows ? { startRow: dest, endRow: dest + n - 1, ...full } : { startColumn: dest, endColumn: dest + n - 1, ...full };
    const ops: LiveOp[] = [
      ...Object.entries(before).map(([id, cellValue]) => ({ id: OP.VALUES, params: { subUnitId: id, cellValue } })),
      { id: rows ? OP.REMOVE_ROWS : OP.REMOVE_COL, params: { subUnitId: sheetId, range: src } },
      { id: rows ? OP.INSERT_ROW : OP.INSERT_COL, params: { subUnitId: sheetId, range: dst, ...(rows ? { rowInfo: info } : { colInfo: info }) } },
    ];
    if (Object.keys(cells).length) ops.push({ id: OP.VALUES, params: { subUnitId: sheetId, cellValue: cells } });
    ops.push(...otherSheets);
    commit(ops);
    setSel(rows
      ? { anchor: { row: dest, col: 0 }, focus: { row: dest + n - 1, col: geo.cols - 1 } }
      : { anchor: { row: 0, col: dest }, focus: { row: geo.rows - 1, col: dest + n - 1 } });
  }, [b, sheet, geo, selRange, sheetId, commit]);

  useEffect(() => {
    const focused = () => document.activeElement === grid.current;
    const onCopy = (e: ClipboardEvent) => { if (!focused()) return; e.preventDefault(); copy(false, e.clipboardData); };
    const onCut = (e: ClipboardEvent) => { if (!focused() || readOnly) return; e.preventDefault(); copy(true, e.clipboardData); };
    const onPaste = (e: ClipboardEvent) => {
      if (!focused() || readOnly) return;
      e.preventDefault();
      const only = pasteValues.current ? 'values' as const : undefined;
      pasteValues.current = false;
      paste(e.clipboardData?.getData('text/plain') || '', only);
    };
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPaste);
    return () => { document.removeEventListener('copy', onCopy); document.removeEventListener('cut', onCut); document.removeEventListener('paste', onPaste); };
  }, [copy, paste, readOnly]);

  // ── Структура: строки, столбцы, объединение, закрепление, листы ──
  const insertRows = (before: boolean) => {
    const at = before ? selRange.startRow : selRange.endRow + 1;
    const n = selRange.endRow - selRange.startRow + 1;
    commit([{ id: OP.INSERT_ROW, params: { subUnitId: sheetId, range: { startRow: at, endRow: at + n - 1, startColumn: 0, endColumn: (geo?.cols ?? 26) - 1 } } }]);
  };
  const insertCols = (before: boolean) => {
    const at = before ? selRange.startColumn : selRange.endColumn + 1;
    const n = selRange.endColumn - selRange.startColumn + 1;
    commit([{ id: OP.INSERT_COL, params: { subUnitId: sheetId, range: { startRow: 0, endRow: (geo?.rows ?? 100) - 1, startColumn: at, endColumn: at + n - 1 } } }]);
  };
  const removeRows = () => commit([{ id: OP.REMOVE_ROWS, params: { subUnitId: sheetId, range: { startRow: selRange.startRow, endRow: selRange.endRow, startColumn: 0, endColumn: (geo?.cols ?? 26) - 1 } } }]);
  const removeCols = () => commit([{ id: OP.REMOVE_COL, params: { subUnitId: sheetId, range: { startRow: 0, endRow: (geo?.rows ?? 100) - 1, startColumn: selRange.startColumn, endColumn: selRange.endColumn } } }]);
  const merged = Boolean(sheet?.mergeData?.some((m) => m.startRow <= selRange.endRow && selRange.startRow <= m.endRow && m.startColumn <= selRange.endColumn && selRange.startColumn <= m.endColumn));
  const toggleMerge = () => {
    if (merged) { commit([{ id: OP.REMOVE_MERGE, params: { subUnitId: sheetId, ranges: [selRange] } }]); return; }
    if (selRange.startRow === selRange.endRow && selRange.startColumn === selRange.endColumn) return;
    // Как в Excel: остаётся значение левой верхней ячейки, остальные очищаются.
    const clear: Record<number, Record<number, Cell | null>> = {};
    if (sheet) for (let r = selRange.startRow; r <= selRange.endRow; r += 1) for (let c = selRange.startColumn; c <= selRange.endColumn; c += 1) {
      if ((r !== selRange.startRow || c !== selRange.startColumn) && cellAt(sheet, r, c)?.v != null) (clear[r] ||= {})[c] = { v: null, f: null } as Cell;
    }
    commit([...(Object.keys(clear).length ? [{ id: OP.VALUES, params: { subUnitId: sheetId, cellValue: clear } }] : []), { id: OP.ADD_MERGE, params: { subUnitId: sheetId, ranges: [selRange] } }]);
  };
  const freezeHere = (kind: 'rows' | 'cols' | 'none') => {
    const r = kind === 'rows' ? sel.anchor.row + 1 : sheet?.freeze?.startRow ?? 0;
    const c = kind === 'cols' ? sel.anchor.col + 1 : sheet?.freeze?.startColumn ?? 0;
    const params = kind === 'none' ? { startRow: -1, startColumn: -1, xSplit: 0, ySplit: 0 }
      : { startRow: kind === 'rows' ? r : (sheet?.freeze?.ySplit ? r : -1), startColumn: kind === 'cols' ? c : (sheet?.freeze?.xSplit ? c : -1), ySplit: kind === 'rows' ? r : sheet?.freeze?.ySplit ?? 0, xSplit: kind === 'cols' ? c : sheet?.freeze?.xSplit ?? 0 };
    commit([{ id: OP.FREEZE, params: { subUnitId: sheetId, ...params } }]);
  };
  const addSheet = () => {
    if (!b) return;
    let n = b.sheetOrder.length + 1;
    const names = new Set(Object.values(b.sheets).map((s) => s.name));
    while (names.has(`Лист${n}`)) n += 1;
    const id = `sheet-${Date.now().toString(36)}`;
    commit([{ id: OP.INSERT_SHEET, params: { index: b.sheetOrder.length, sheet: { id, name: `Лист${n}`, rowCount: 100, columnCount: 26, cellData: {} } } }]);
    setSheetId(id);
  };
  const removeSheet = (id: string) => {
    if (!b || b.sheetOrder.length < 2) { showToast('В таблице должен остаться хотя бы один лист', 'info'); return; }
    commit([{ id: OP.REMOVE_SHEET, params: { subUnitId: id, subUnitName: b.sheets[id]?.name } }]);
    if (id === sheetId) setSheetId(b.sheetOrder.find((x) => x !== id) || '');
  };
  const renameSheet = (id: string, name: string) => {
    const clean = name.trim().slice(0, 31);
    if (!b || !clean || b.sheets[id]?.name === clean) return;
    if (Object.values(b.sheets).some((s) => s.id !== id && s.name === clean)) { showToast('Лист с таким названием уже есть', 'info'); return; }
    commit([{ id: OP.RENAME_SHEET, params: { subUnitId: id, name: clean, oldName: b.sheets[id]?.name } }]);
  };

  // Формат чисел: процент, рубли, знаки после запятой.
  const setPattern = (pattern: string | null) => restyle((s) => ({ ...s, n: pattern ? { pattern } : undefined }));
  const stepDecimals = (d: 1 | -1) => restyle((s) => {
    const pat = (s.n as { pattern?: string } | undefined)?.pattern || '0';
    const m = /0(\.0*)?/.exec(pat);
    const cur = m?.[1] ? m[1].length - 1 : 0;
    const next = Math.max(0, Math.min(10, cur + d));
    const body = next ? `0.${'0'.repeat(next)}` : '0';
    return { ...s, n: { pattern: m ? pat.replace(/0(\.0*)?/, body) : body } };
  });
  const sumBelow = () => {
    // Σ: в ячейку под выделением — СУММ выделенного столбца (или в активную ячейку — СУММ над ней).
    if (selRange.startRow === selRange.endRow) {
      let top = sel.anchor.row - 1;
      while (top >= 0 && typeof cellAt(sheet!, top, sel.anchor.col)?.v === 'number') top -= 1;
      if (top + 1 < sel.anchor.row) writeInput(sel.anchor.row, sel.anchor.col, `=SUM(${a1(top + 1, sel.anchor.col)}:${a1(sel.anchor.row - 1, sel.anchor.col)})`);
      else setEdit({ row: sel.anchor.row, col: sel.anchor.col, text: '=SUM()' });
      return;
    }
    const cells: Record<number, Record<number, Cell | null>> = {};
    for (let c = selRange.startColumn; c <= selRange.endColumn; c += 1) (cells[selRange.endRow + 1] ||= {})[c] = { f: `=SUM(${a1(selRange.startRow, c)}:${a1(selRange.endRow, c)})`, v: null } as Cell;
    setCells(cells);
  };

  // ── Правка ячейки ──
  const startEdit = (text?: string, bar = false) => {
    if (readOnly || !b || !sheet) return;
    const cell = cellAt(sheet, sel.anchor.row, sel.anchor.col);
    setEdit({ row: sel.anchor.row, col: sel.anchor.col, text: text ?? editText(cell, styleOf(b, cell)), bar });
  };
  const move = useCallback((dr: number, dc: number, extend = false, jump = false) => {
    if (!geo || !sheet) return;
    const from = extend ? sel.focus : sel.anchor;
    let r = from.row; let c = from.col;
    if (jump) {
      // Ctrl+стрелка: к краю блока данных.
      const filled = (rr: number, cc: number) => { const x = cellAt(sheet, rr, cc); return x && (x.v !== null && x.v !== undefined && x.v !== '' || x.f); };
      const step = () => { r += dr; c += dc; };
      const inside = () => r >= 0 && c >= 0 && r < geo.rows && c < geo.cols;
      step();
      if (inside() && filled(r, c) && filled(r - dr, c - dc)) { while (inside() && filled(r + dr, c + dc)) step(); } else { while (inside() && !filled(r, c)) step(); }
      if (!inside()) { r = Math.max(0, Math.min(geo.rows - 1, r)); c = Math.max(0, Math.min(geo.cols - 1, c)); }
    } else {
      // Шаг через объединение — сразу за его край.
      const m = geo.merges.get(`${r}:${c}`);
      if (m && !extend) { if (dr > 0) r = m.endRow; if (dc > 0) c = m.endColumn; if (dr < 0) r = m.startRow; if (dc < 0) c = m.startColumn; }
      r += dr; c += dc;
      // Скрытые строки и столбцы пропускаем.
      while (r > 0 && r < geo.rows - 1 && geo.rowOffs[r + 1] === geo.rowOffs[r]) r += dr || 1;
      while (c > 0 && c < geo.cols - 1 && geo.colOffs[c + 1] === geo.colOffs[c]) c += dc || 1;
      r = Math.max(0, Math.min(geo.rows - 1, r)); c = Math.max(0, Math.min(geo.cols - 1, c));
      const m2 = geo.merges.get(`${r}:${c}`);
      if (m2 && !extend) { r = m2.startRow; c = m2.startColumn; }
    }
    const next = { row: r, col: c };
    setSel((s) => (extend ? { anchor: s.anchor, focus: next } : { anchor: next, focus: next }));
    reveal(r, c);
  }, [geo, sheet, sel, reveal]);

  const finishEdit = (how: 'down' | 'up' | 'right' | 'left' | 'stay' | 'cancel', text?: string) => {
    const e = edit ? { ...edit, text: text ?? edit.text } : null;
    setEdit(null);
    grid.current?.focus({ preventScroll: true });
    if (!e || how === 'cancel') return;
    const cell = sheet ? cellAt(sheet, e.row, e.col) : undefined;
    if (e.text !== editText(cell, b ? styleOf(b, cell) : null)) writeInput(e.row, e.col, e.text);
    if (how === 'down') move(1, 0); else if (how === 'up') move(-1, 0); else if (how === 'right') move(0, 1); else if (how === 'left') move(0, -1);
  };

  // Ссылки в формулу мышью: в правке формулы щелчок по ячейке вставляет её адрес.
  const editField = () => (edit?.bar ? barInput.current : editor.current);
  const caretNow = () => editField()?.selectionStart ?? edit?.text.length ?? 0;
  const insertRef = (ref: string) => {
    if (!edit) return;
    const at = caretNow();
    const prev = refEndingAt(edit.text, at);
    const start = prev ? prev.start : at;
    const text = edit.text.slice(0, start) + ref + edit.text.slice(at);
    const pos = start + ref.length;
    setEdit({ ...edit, text });
    setCaret(pos);
    window.requestAnimationFrame(() => { const el = editField(); if (el) { el.focus(); el.setSelectionRange(pos, pos); } });
  };

  const objDraftRef = useRef(objDraft);
  objDraftRef.current = objDraft;
  const insertRefNow = useRef(insertRef);
  insertRefNow.current = insertRef;

  // ── Мышь: всё по координатам холста — ручки размера на границах заголовков, квадратик автозаполнения, стрелки фильтра ──
  type Drag = { kind: 'cells' | 'rows' | 'cols' | 'resize-col' | 'resize-row' | 'fill' | 'ref' | 'object' | 'move' | 'move-rows' | 'move-cols'; index?: number; start?: number; size?: number; from?: Pos;
    obj?: SheetObject; part?: 'move' | 'nw' | 'ne' | 'sw' | 'se'; cx?: number; cy?: number };
  const drag = useRef<Drag | null>(null);
  const headHover = useRef<HeadHover>(null);
  // Ячейки, только что изменённые не нами: «r:c» → когда (вспышка гаснет за FLASH_MS).
  const flash = useRef(new Map<string, number>());
  /**
   * Автопрокрутка при протягивании, как в Google: пока кнопка зажата за краем сетки, лист едет каждый кадр, даже
   * если мышь стоит; скорость растёт с расстоянием за край и со временем удержания. move — свежий обработчик
   * движения (эффект с ним пересоздаётся при каждом шаге выделения), им выделение догоняет прокрутку.
   */
  const auto = useRef<{ ptr: { x: number; y: number; shift: boolean } | null; raf: number; since: number; synthetic: boolean; move: ((e: MouseEvent) => void) | null }>({ ptr: null, raf: 0, since: 0, synthetic: false, move: null });
  const autoStep = useCallback((t: number) => {
    const a = auto.current; const el = grid.current; const d = drag.current; const p = a.ptr;
    const stop = () => { a.raf = 0; a.since = 0; };
    if (!el || !d || !p || d.kind === 'resize-col' || d.kind === 'resize-row' || d.kind === 'object') { stop(); return; }
    const z = zoomRef.current;
    const box = el.getBoundingClientRect();
    const top = box.top + HEAD_H * z + 2; const left = box.left + HEAD_W * z + 2; const bottom = box.bottom - 6; const right = box.right - 6;
    const oy = p.y > bottom ? p.y - bottom : p.y < top ? p.y - top : 0;
    const ox = p.x > right ? p.x - right : p.x < left ? p.x - left : 0;
    if (!ox && !oy) { stop(); return; }
    if (!a.since) a.since = t;
    const held = Math.min(3, (t - a.since) / 1000);
    const speed = (o: number) => Math.sign(o) * Math.min(300, (1 + Math.abs(o) * 0.15) * (1 + held * 2));
    if (oy) el.scrollTop += speed(oy);
    if (ox) el.scrollLeft += speed(ox);
    a.synthetic = true;
    try { a.move?.({ clientX: Math.min(Math.max(p.x, left), right), clientY: Math.min(Math.max(p.y, top), bottom), shiftKey: p.shift } as MouseEvent); } finally { a.synthetic = false; }
    a.raf = window.requestAnimationFrame(autoStep);
  }, []);
  const startAuto = useCallback(() => { if (!auto.current.raf) auto.current.raf = window.requestAnimationFrame(autoStep); }, [autoStep]);
  useEffect(() => () => { if (auto.current.raf) window.cancelAnimationFrame(auto.current.raf); }, []);
  const [guide, setGuide] = useState<{ axis: 'x' | 'y'; at: number } | null>(null);
  const [fillTo, setFillTo] = useState<Range | null>(null);
  // Куда переносим выделение, пока тянем его за рамку.
  const [moveTo, setMoveTo] = useState<Range | null>(null);
  // Куда встанут перетаскиваемые целиком строки (столбцы): индекс, перед которым вставить.
  const [dropAt, setDropAt] = useState<{ axis: 'row' | 'col'; at: number } | null>(null);
  const [filterMenu, setFilterMenu] = useState<{ col: number; x: number; y: number } | null>(null);

  /** Что под курсором: граница столбца/строки в заголовке (для изменения размера), квадратик заполнения, стрелка фильтра. */
  const handleAt = useCallback((clientX: number, clientY: number): { kind: 'resize-col' | 'resize-row' | 'fill' | 'filter' | 'unhide-col' | 'unhide-row' | 'group-row' | 'group-col' | 'move' | 'move-rows' | 'move-cols'; index: number; end?: number } | null => {
    const el = grid.current;
    if (!el || !geo) return null;
    const box = el.getBoundingClientRect();
    const z = zoomRef.current;
    const lx = (clientX - box.left) / z; const ly = (clientY - box.top) / z;
    const sx = el.scrollLeft / z; const sy = el.scrollTop / z;
    // Кнопки групп («−»/«+») — за концом группы в заголовке.
    if (lx >= 0 && lx < 14 && ly > HEAD_H) {
      const i = (xs.groups?.rows || []).findIndex((g0) => { const y2 = screenY2(geo, Math.min(g0.end, geo.rows - 1), sy); return ly >= y2 && ly <= y2 + 13; });
      if (i >= 0) return { kind: 'group-row', index: i };
    }
    if (ly >= 0 && ly < 14 && lx > HEAD_W) {
      const i = (xs.groups?.cols || []).findIndex((g0) => { const x2 = screenX2(geo, Math.min(g0.end, geo.cols - 1), sx); return lx >= x2 && lx <= x2 + 13; });
      if (i >= 0) return { kind: 'group-col', index: i };
    }
    const hiddenCol = (c: number) => c >= 0 && c < geo.cols && Boolean(sheet?.columnData?.[c]?.hd);
    const fullRows = selRange.startColumn === 0 && selRange.endColumn >= geo.cols - 1 && !(selRange.startRow === 0 && selRange.endRow >= geo.rows - 1);
    const fullCols = selRange.startRow === 0 && selRange.endRow >= geo.rows - 1 && !(selRange.startColumn === 0 && selRange.endColumn >= geo.cols - 1);
    const hiddenRow = (r: number) => r >= 0 && r < geo.rows && Boolean(sheet?.rowData?.[r]?.hd);
    if (ly >= 0 && ly < HEAD_H && lx > HEAD_W) {
      const h0 = hit(clientX, clientY);
      if (h0 && h0.col >= 0) {
        // Граница со скрытыми столбцами: справа от этого или слева (скрытые — подряд).
        for (const [edge, first] of [[screenX2(geo, h0.col, sx), h0.col + 1], [screenX(geo, h0.col, sx), -1]] as Array<[number, number]>) {
          if (Math.abs(lx - edge) > 6) continue;
          if (first >= 0 && hiddenCol(first)) { let end = first; while (hiddenCol(end + 1)) end += 1; return { kind: 'unhide-col', index: first, end }; }
          if (first < 0 && hiddenCol(h0.col - 1)) { let start = h0.col - 1; while (hiddenCol(start - 1)) start -= 1; return { kind: 'unhide-col', index: start, end: h0.col - 1 }; }
        }
        const right = screenX2(geo, h0.col, sx); const left = screenX(geo, h0.col, sx);
        if (Math.abs(lx - right) <= 4) return { kind: 'resize-col', index: h0.col };
        if (Math.abs(lx - left) <= 4 && h0.col > 0) return { kind: 'resize-col', index: h0.col - 1 };
        // Выделенные целиком столбцы перетаскиваются за заголовок — переставляются (как в Google).
        if (!readOnly && !edit && fullCols && h0.col >= selRange.startColumn && h0.col <= selRange.endColumn) return { kind: 'move-cols', index: h0.col };
      }
      return null;
    }
    if (lx >= 0 && lx < HEAD_W && ly > HEAD_H) {
      const h0 = hit(clientX, clientY);
      if (h0 && h0.row >= 0) {
        for (const [edge, first] of [[screenY2(geo, h0.row, sy), h0.row + 1], [screenY(geo, h0.row, sy), -1]] as Array<[number, number]>) {
          if (Math.abs(ly - edge) > 5) continue;
          if (first >= 0 && hiddenRow(first)) { let end = first; while (hiddenRow(end + 1)) end += 1; return { kind: 'unhide-row', index: first, end }; }
          if (first < 0 && hiddenRow(h0.row - 1)) { let start = h0.row - 1; while (hiddenRow(start - 1)) start -= 1; return { kind: 'unhide-row', index: start, end: h0.row - 1 }; }
        }
        const bottom = screenY2(geo, h0.row, sy); const top = screenY(geo, h0.row, sy);
        if (Math.abs(ly - bottom) <= 3) return { kind: 'resize-row', index: h0.row };
        if (Math.abs(ly - top) <= 3 && h0.row > 0) return { kind: 'resize-row', index: h0.row - 1 };
        // Выделенные целиком строки перетаскиваются за номера — переставляются (как в Google).
        if (!readOnly && !edit && fullRows && h0.row >= selRange.startRow && h0.row <= selRange.endRow) return { kind: 'move-rows', index: h0.row };
      }
      return null;
    }
    // Кнопка фильтра — в ячейке первой строки диапазона фильтра, у правого края (её рисует draw.ts).
    const f = b ? readFilters(b)[sheetId] : undefined;
    if (f) {
      const h0 = hit(clientX, clientY);
      if (h0 && h0.row === f.ref.startRow && h0.col >= f.ref.startColumn && h0.col <= f.ref.endColumn) {
        const right = screenX2(geo, h0.col, sx); const top = screenY(geo, h0.row, sy); const bottom = screenY2(geo, h0.row, sy);
        const by = top + Math.round((bottom - top - FILTER_BTN) / 2);
        if (lx >= right - FILTER_BTN - 4 && lx <= right - 2 && ly >= by - 1 && ly <= by + FILTER_BTN + 1) return { kind: 'filter', index: h0.col };
      }
    }
    if (!readOnly && !edit) {
      const fx = screenX2(geo, selRange.endColumn, sx); const fy = screenY2(geo, selRange.endRow, sy);
      if (Math.abs(lx - fx) <= 5 && Math.abs(ly - fy) <= 5) return { kind: 'fill', index: 0 };
      // Рамка выделения — за неё выделение можно перетащить (как в Google).
      const x1 = screenX(geo, selRange.startColumn, sx); const x2 = screenX2(geo, selRange.endColumn, sx);
      const y1 = screenY(geo, selRange.startRow, sy); const y2 = screenY2(geo, selRange.endRow, sy);
      const nearX = Math.abs(lx - x1) <= 3 || Math.abs(lx - x2) <= 3; const nearY = Math.abs(ly - y1) <= 3 || Math.abs(ly - y2) <= 3;
      const inX = lx >= x1 - 3 && lx <= x2 + 3; const inY = ly >= y1 - 3 && ly <= y2 + 3;
      if ((nearX && inY) || (nearY && inX)) return fullRows ? { kind: 'move-rows', index: selRange.startRow } : fullCols ? { kind: 'move-cols', index: selRange.startColumn } : { kind: 'move', index: 0 };
    }
    return null;
  }, [geo, hit, b, sheet, sheetId, readOnly, edit, selRange, xs]);

  const objectAt = (clientX: number, clientY: number): { obj: SheetObject; part: 'move' | 'nw' | 'ne' | 'sw' | 'se' } | null => {
    const el = grid.current;
    if (!el || !geo || !xs.objects?.length) return null;
    const box = el.getBoundingClientRect();
    const z = zoomRef.current;
    const lx = (clientX - box.left) / z; const ly = (clientY - box.top) / z;
    if (lx < HEAD_W || ly < HEAD_H) return null;
    for (const o of [...xs.objects].reverse()) {
      const ox = screenX(geo, Math.min(o.col, geo.cols - 1), el.scrollLeft / z) + o.dx; const oy = screenY(geo, Math.min(o.row, geo.rows - 1), el.scrollTop / z) + o.dy;
      if (selectedObject === o.id) {
        for (const [part, hx, hy] of [['nw', ox, oy], ['ne', ox + o.w, oy], ['sw', ox, oy + o.h], ['se', ox + o.w, oy + o.h]] as Array<['nw', number, number]>) {
          if (Math.abs(lx - hx) <= 6 && Math.abs(ly - hy) <= 6) return { obj: o, part };
        }
      }
      if (lx >= ox && lx <= ox + o.w && ly >= oy && ly <= oy + o.h) return { obj: o, part: 'move' };
    }
    return null;
  };

  const onHover = (e: React.MouseEvent) => {
    const oh = !drag.current ? objectAt(e.clientX, e.clientY) : null;
    if (oh && grid.current) { grid.current.style.cursor = oh.part === 'move' ? 'move' : oh.part === 'nw' || oh.part === 'se' ? 'nwse-resize' : 'nesw-resize'; return; }
    // Заметка — всплывает при наведении.
    if (!drag.current && xs.notes && geo) {
      const h0 = hit(e.clientX, e.clientY);
      const key = h0 && h0.row >= 0 && h0.col >= 0 ? `${h0.row}:${h0.col}` : '';
      if (key && xs.notes[key] && !noteEdit) {
        if (noteTip?.key !== key) {
          const box = grid.current!.getBoundingClientRect(); const z = zoomRef.current;
          setNoteTip({ key, x: box.left + screenX2(geo, h0!.col, grid.current!.scrollLeft / z) * z + 4, y: box.top + screenY(geo, h0!.row, grid.current!.scrollTop / z) * z });
        }
      } else if (noteTip) setNoteTip(null);
    }
    if (drag.current) return;
    const h = handleAt(e.clientX, e.clientY);
    const cursor = h?.kind === 'resize-col' ? 'col-resize' : h?.kind === 'resize-row' ? 'row-resize' : h?.kind === 'fill' ? 'crosshair' : h?.kind === 'move' || h?.kind === 'move-rows' || h?.kind === 'move-cols' ? 'grab'
      : h?.kind === 'filter' || h?.kind === 'unhide-col' || h?.kind === 'unhide-row' ? 'pointer' : painter ? 'copy' : '';
    if (grid.current && grid.current.style.cursor !== cursor) grid.current.style.cursor = cursor;
    // Подсветка заголовка под курсором и ручки ширины/высоты (как в Google) — только верхний слой холста.
    let next: HeadHover = null;
    if (h?.kind === 'resize-col') next = { kind: 'resize-col', index: h.index };
    else if (h?.kind === 'resize-row') next = { kind: 'resize-row', index: h.index };
    else if (geo && grid.current) {
      const box = grid.current.getBoundingClientRect(); const z = zoomRef.current;
      const lx = (e.clientX - box.left) / z; const ly = (e.clientY - box.top) / z;
      const h0 = (ly < HEAD_H && lx > HEAD_W) || (lx < HEAD_W && ly > HEAD_H) ? hit(e.clientX, e.clientY) : null;
      if (h0 && ly < HEAD_H && h0.col >= 0) next = { kind: 'col', index: h0.col };
      else if (h0 && lx < HEAD_W && h0.row >= 0) next = { kind: 'row', index: h0.row };
    }
    const cur = headHover.current;
    if (cur?.kind !== next?.kind || cur?.index !== next?.index) { headHover.current = next; redraw(); }
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button === 2) {
      const h = hit(e.clientX, e.clientY);
      if (h && h.row >= 0 && h.col >= 0 && !inRange(selRange, h.row, h.col)) setSel({ anchor: { row: h.row, col: h.col }, focus: { row: h.row, col: h.col } });
      return;
    }
    if (e.button !== 0) return;
    const h = hit(e.clientX, e.clientY);
    if (!h || !geo) return;
    // Картинка или диаграмма: выбрать, тянуть, растягивать за угол.
    const oh = objectAt(e.clientX, e.clientY);
    if (oh && !edit) {
      e.preventDefault();
      setSelectedObject(oh.obj.id);
      grid.current?.focus({ preventScroll: true });
      if (!readOnly) drag.current = { kind: 'object', obj: oh.obj, part: oh.part, cx: e.clientX, cy: e.clientY };
      return;
    }
    if (selectedObject) setSelectedObject(null);
    const handle = handleAt(e.clientX, e.clientY);
    if (handle && (handle.kind === 'group-row' || handle.kind === 'group-col') && !readOnly) {
      e.preventDefault();
      toggleGroup(handle.kind === 'group-row', handle.index);
      return;
    }
    if (handle?.kind === 'filter') { e.preventDefault(); setFilterMenu({ col: handle.index, x: e.clientX, y: e.clientY + 8 }); return; }
    if (handle && !readOnly && (handle.kind === 'resize-col' || handle.kind === 'resize-row')) {
      e.preventDefault();
      const cols = handle.kind === 'resize-col';
      drag.current = { kind: handle.kind, index: handle.index, start: cols ? e.clientX : e.clientY, size: cols ? colWidth(sheet!, handle.index) : rowHeight(sheet!, handle.index) };
      const box = grid.current!.getBoundingClientRect();
      setGuide({ axis: cols ? 'x' : 'y', at: cols ? e.clientX - box.left : e.clientY - box.top });
      return;
    }
    if (handle?.kind === 'fill') { e.preventDefault(); drag.current = { kind: 'fill' }; return; }
    if (handle?.kind === 'move-rows' || handle?.kind === 'move-cols') {
      e.preventDefault();
      drag.current = { kind: handle.kind };
      if (grid.current) grid.current.style.cursor = 'grabbing';
      return;
    }
    if (handle?.kind === 'move') {
      e.preventDefault();
      const h0 = hit(e.clientX, e.clientY);
      // Точка захвата — внутри выделения (у самой рамки щелчок может попасть в соседнюю ячейку).
      const from = { row: Math.min(selRange.endRow, Math.max(selRange.startRow, h0?.row ?? selRange.startRow)), col: Math.min(selRange.endColumn, Math.max(selRange.startColumn, h0?.col ?? selRange.startColumn)) };
      drag.current = { kind: 'move', from };
      setMoveTo(selRange);
      if (grid.current) grid.current.style.cursor = 'grabbing';
      return;
    }
    if (edit && h.row >= 0 && h.col >= 0 && canInsertRef(edit.text, caretNow())) {
      e.preventDefault();
      insertRef(a1(h.row, h.col));
      drag.current = { kind: 'ref', from: { row: h.row, col: h.col } };
      return;
    }
    if (handle && (handle.kind === 'unhide-col' || handle.kind === 'unhide-row') && !readOnly) {
      e.preventDefault();
      const cols = handle.kind === 'unhide-col';
      commit([{ id: cols ? OP.COL_VISIBLE : OP.ROW_VISIBLE, params: { subUnitId: sheetId, ranges: [cols ? { startRow: 0, endRow: 0, startColumn: handle.index, endColumn: handle.end ?? handle.index } : { startRow: handle.index, endRow: handle.end ?? handle.index, startColumn: 0, endColumn: 0 }] } }]);
      return;
    }
    if (edit) finishEdit('stay');
    e.preventDefault();
    grid.current?.focus({ preventScroll: true });
    if (h.row < 0 && h.col < 0) { setSel({ anchor: { row: 0, col: 0 }, focus: { row: geo.rows - 1, col: geo.cols - 1 } }); return; }
    if (h.row < 0) {
      setSel((s) => ({ anchor: e.shiftKey ? { row: 0, col: s.anchor.col } : { row: 0, col: h.col }, focus: { row: geo.rows - 1, col: h.col } }));
      drag.current = { kind: 'cols' };
      return;
    }
    if (h.col < 0) {
      setSel((s) => ({ anchor: e.shiftKey ? { row: s.anchor.row, col: 0 } : { row: h.row, col: 0 }, focus: { row: h.row, col: geo.cols - 1 } }));
      drag.current = { kind: 'rows' };
      return;
    }
    // Флажок — щелчок переключает; список — щелчок по стрелке открывает варианты (как в Google).
    const dvRule = (xs.dv || []).find((x) => x.ranges.some((g0) => h.row >= g0.startRow && h.row <= g0.endRow && h.col >= g0.startColumn && h.col <= g0.endColumn));
    if (dvRule && !readOnly && !e.shiftKey) {
      const cellRight = screenX2(geo, h.col, grid.current!.scrollLeft / zoom);
      if (dvRule.kind === 'checkbox') {
        e.preventDefault();
        setSel({ anchor: { row: h.row, col: h.col }, focus: { row: h.row, col: h.col } });
        setCells({ [h.row]: { [h.col]: { v: !isChecked(cellAt(sheet!, h.row, h.col)?.v), t: 3 } as Cell } });
        return;
      }
      if (dvRule.kind === 'list' && h.lx > cellRight - 22) {
        e.preventDefault();
        setSel({ anchor: { row: h.row, col: h.col }, focus: { row: h.row, col: h.col } });
        setListMenu({ r: h.row, c: h.col, x: e.clientX, y: e.clientY + 8, values: dvRule.values || [] });
        return;
      }
    }
    const m = geo.merges.get(`${h.row}:${h.col}`);
    const p = m ? { row: m.startRow, col: m.startColumn } : { row: h.row, col: h.col };
    if (e.shiftKey) setSel((s) => ({ anchor: s.anchor, focus: p })); else setSel({ anchor: p, focus: p });
    drag.current = { kind: 'cells' };
    // Ctrl+щелчок по ссылке — открыть её.
    if (e.ctrlKey || e.metaKey) {
      const cell = cellAt(sheet!, p.row, p.col);
      const text = String(cell?.v ?? '');
      const body = (cell?.p as { body?: { customRanges?: Array<{ properties?: { url?: string } }> } } | undefined)?.body;
      const url = body?.customRanges?.[0]?.properties?.url || (/^https?:\/\/\S+$/.test(text) ? text : '');
      if (url) window.open(url, '_blank', 'noopener');
    }
  };

  /**
   * Автозаполнение (квадратик в углу выделения), как в Excel: ряд чисел с шагом продолжается, одно число и текст
   * копируются, «Пункт 1» → «Пункт 2», дата — по дням, формулы сдвигают относительные ссылки. Оформление копируется.
   */
  const fill = useCallback((src: Range, to: Range) => {
    if (!b || !sheet) return;
    const down = to.endRow > src.endRow || to.startRow < src.startRow;
    const cells: Record<number, Record<number, Cell | null>> = {};
    const lines = down ? src.endColumn - src.startColumn + 1 : src.endRow - src.startRow + 1;
    for (let k = 0; k < lines; k += 1) {
      const seq: Array<{ cell: Cell | undefined; r: number; c: number }> = [];
      const n = down ? src.endRow - src.startRow + 1 : src.endColumn - src.startColumn + 1;
      for (let i = 0; i < n; i += 1) {
        const r = down ? src.startRow + i : src.startRow + k; const c = down ? src.startColumn + k : src.startColumn + i;
        seq.push({ cell: cellAt(sheet, r, c), r, c });
      }
      const nums = seq.map((x) => (typeof x.cell?.v === 'number' && !x.cell.f ? x.cell.v : null));
      const step = nums.length > 1 && nums.every((x) => x !== null) ? (nums[nums.length - 1]! - nums[0]!) / (nums.length - 1) : null;
      const isDate = (x: Cell | undefined) => /[dmy]/i.test(String((styleOf(b, x)?.n as { pattern?: string } | undefined)?.pattern || '').replace(/"[^"]*"/g, ''));
      const forward = down ? to.endRow > src.endRow : to.endColumn > src.endColumn;
      const total = down ? (forward ? to.endRow - src.endRow : src.startRow - to.startRow) : (forward ? to.endColumn - src.endColumn : src.startColumn - to.startColumn);
      for (let j = 1; j <= total; j += 1) {
        const idx = forward ? (j - 1) % n : n - 1 - ((j - 1) % n);
        const base = seq[idx];
        const r = down ? (forward ? src.endRow + j : src.startRow - j) : base.r;
        const c = down ? base.c : (forward ? src.endColumn + j : src.startColumn - j);
        const from = base.cell;
        let next: Cell = from ? wireCell(b, from) ?? {} : { v: null, f: null, s: null } as Cell;
        const lastNum = nums[forward ? n - 1 : 0];
        if (from?.f) next = { ...next, f: shiftFormula(String(from.f), r - base.r, c - base.c), v: null };
        else if (step !== null && lastNum !== null) next = { ...next, v: lastNum + (forward ? 1 : -1) * step * j, t: 2 };
        else if (n === 1 && typeof from?.v === 'number' && isDate(from)) next = { ...next, v: from.v + (forward ? j : -j), t: 2 };
        else if (typeof from?.v === 'string' && /\d+$/.test(from.v)) {
          const m = /^(.*?)(\d+)$/.exec(from.v)!;
          const num = Number(m[2]) + (forward ? 1 : -1) * Math.ceil(j / n) * (n === 1 ? 1 : 1);
          next = { ...next, v: `${m[1]}${Math.max(0, num)}`, t: 1 };
        }
        (cells[r] ||= {})[c] = next;
      }
    }
    setCells(cells);
    setSel({ anchor: { row: to.startRow, col: to.startColumn }, focus: { row: to.endRow, col: to.endColumn } });
  }, [b, sheet, setCells]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = drag.current;
      if (!d || !geo) return;
      if (d.kind === 'object' && d.obj) {
        const z = zoomRef.current;
        const dx = (e.clientX - (d.cx ?? 0)) / z; const dy = (e.clientY - (d.cy ?? 0)) / z;
        const o = d.obj;
        const absX = geo.colOffs[o.col] + o.dx; const absY = geo.rowOffs[o.row] + o.dy;
        let nx = absX; let ny = absY; let w = o.w; let hgt = o.h;
        if (d.part === 'move') { nx += dx; ny += dy; }
        else {
          const ratio = o.kind === 'image' && e.shiftKey === false ? o.w / o.h : 0;
          if (d.part === 'se' || d.part === 'ne') w = Math.max(40, o.w + dx); else { w = Math.max(40, o.w - dx); nx = absX + o.w - w; }
          if (d.part === 'se' || d.part === 'sw') hgt = Math.max(30, o.h + dy); else { hgt = Math.max(30, o.h - dy); ny = absY + o.h - hgt; }
          if (ratio) { hgt = Math.round(w / ratio); if (d.part === 'nw' || d.part === 'ne') ny = absY + o.h - hgt; }
        }
        nx = Math.max(0, nx); ny = Math.max(0, ny);
        const col = indexAt(geo.colOffs, nx); const row = indexAt(geo.rowOffs, ny);
        setObjDraft({ ...o, col, row, dx: Math.round(nx - geo.colOffs[col]), dy: Math.round(ny - geo.rowOffs[row]), w: Math.round(w), h: Math.round(hgt) });
        return;
      }
      if (d.kind === 'resize-col' || d.kind === 'resize-row') {
        const box = grid.current!.getBoundingClientRect();
        const cols = d.kind === 'resize-col';
        const min = (d.start ?? 0) - (d.size ?? 0) + (cols ? 16 : 12);
        const at = Math.max(min, cols ? e.clientX : e.clientY) - (cols ? box.left : box.top);
        setGuide({ axis: cols ? 'x' : 'y', at });
        return;
      }
      const h = hit(e.clientX, e.clientY);
      if (!h) return;
      if (d.kind === 'move-rows' || d.kind === 'move-cols') {
        const rows = d.kind === 'move-rows';
        const z = zoomRef.current; const box = grid.current!.getBoundingClientRect();
        const i = Math.max(0, rows ? h.row : h.col);
        // Вставить до или после строки под курсором — по тому, в какой половине она.
        const a0 = rows ? screenY(geo, i, grid.current!.scrollTop / z) : screenX(geo, i, grid.current!.scrollLeft / z);
        const a1 = rows ? screenY2(geo, i, grid.current!.scrollTop / z) : screenX2(geo, i, grid.current!.scrollLeft / z);
        const pos = rows ? (e.clientY - box.top) / z : (e.clientX - box.left) / z;
        const at = pos > (a0 + a1) / 2 ? i + 1 : i;
        const s0 = rows ? selRange.startRow : selRange.startColumn; const s1 = rows ? selRange.endRow : selRange.endColumn;
        const next = at >= s0 && at <= s1 + 1 ? null : { axis: rows ? 'row' as const : 'col' as const, at };
        setDropAt((x) => (x?.at === next?.at && x?.axis === next?.axis ? x : next));
      } else if (d.kind === 'move' && d.from) {
        const h1 = selRange.endRow - selRange.startRow; const w1 = selRange.endColumn - selRange.startColumn;
        const r = Math.max(0, Math.min(geo.rows - 1 - h1, selRange.startRow + Math.max(0, h.row) - d.from.row));
        const c = Math.max(0, Math.min(geo.cols - 1 - w1, selRange.startColumn + Math.max(0, h.col) - d.from.col));
        setMoveTo((m) => (m && m.startRow === r && m.startColumn === c ? m : { startRow: r, startColumn: c, endRow: r + h1, endColumn: c + w1 }));
      } else if (d.kind === 'fill') {
        // Тянем вниз/вверх или вбок — по тому, куда курсор ушёл дальше от выделения.
        const r = Math.max(0, h.row); const c = Math.max(0, h.col);
        const dr = r > selRange.endRow ? r - selRange.endRow : r < selRange.startRow ? r - selRange.startRow : 0;
        const dc = c > selRange.endColumn ? c - selRange.endColumn : c < selRange.startColumn ? c - selRange.startColumn : 0;
        if (!dr && !dc) setFillTo(null);
        else if (Math.abs(dr) >= Math.abs(dc)) setFillTo({ ...selRange, startRow: Math.min(selRange.startRow, r), endRow: Math.max(selRange.endRow, r) });
        else setFillTo({ ...selRange, startColumn: Math.min(selRange.startColumn, c), endColumn: Math.max(selRange.endColumn, c) });
      } else if (d.kind === 'ref' && d.from) {
        const r = Math.max(0, h.row); const c = Math.max(0, h.col);
        const ref = r === d.from.row && c === d.from.col ? a1(r, c) : rangeA1(norm({ startRow: d.from.row, startColumn: d.from.col, endRow: r, endColumn: c }));
        insertRefNow.current(ref);
      } else {
        // Тот же угол — тот же объект: иначе весь редактор перерисовывался на каждый пиксель движения мыши.
        const focus = d.kind === 'cols' ? { row: geo.rows - 1, col: Math.max(0, h.col) } : d.kind === 'rows' ? { row: Math.max(0, h.row), col: geo.cols - 1 } : { row: Math.max(0, h.row), col: Math.max(0, h.col) };
        setSel((s) => (s.focus.row === focus.row && s.focus.col === focus.col ? s : { anchor: s.anchor, focus }));
      }
      // Автопрокрутка у края — своим циклом по кадрам (см. autoStep), а не только на движение мыши.
      if (!auto.current.synthetic) { auto.current.ptr = { x: e.clientX, y: e.clientY, shift: e.shiftKey }; startAuto(); }
    };
    auto.current.move = onMove;
    const onUp = (e: MouseEvent) => {
      const d = drag.current;
      drag.current = null;
      if (!d) return;
      if (d.kind === 'object') {
        const draft = objDraftRef.current;
        setObjDraft(null);
        if (draft && d.obj && JSON.stringify(draft) !== JSON.stringify(d.obj)) setExtra('objects', (xs.objects || []).map((o) => (o.id === draft.id ? draft : o)));
        return;
      }
      if (d.kind === 'fill') { const to = fillTo; setFillTo(null); if (to) fill(selRange, to); return; }
      if (d.kind === 'move-rows' || d.kind === 'move-cols') {
        const to = dropAt; setDropAt(null);
        if (grid.current) grid.current.style.cursor = '';
        if (to) moveLines(to.axis, to.at);
        return;
      }
      if (d.kind === 'move') {
        const to = moveTo; setMoveTo(null);
        if (grid.current) grid.current.style.cursor = '';
        if (to && (to.startRow !== selRange.startRow || to.startColumn !== selRange.startColumn)) moveCells(selRange, to);
        return;
      }
      if (d.kind === 'cells' && painter) { const st = painter; setPainter(null); restyle(() => ({ ...st })); return; }
      if (!(d.kind === 'resize-col' || d.kind === 'resize-row')) return;
      setGuide(null);
      const rows = d.kind === 'resize-row';
      const size = Math.max(rows ? 12 : 16, Math.round((d.size ?? 0) + (rows ? e.clientY : e.clientX) - (d.start ?? 0)));
      // Меняли размер выделенных целиком столбцов — меняем у всех них.
      const idx = d.index ?? 0;
      const whole = rows ? selRange.startColumn === 0 && selRange.endColumn >= (geo?.cols ?? 1) - 1 && idx >= selRange.startRow && idx <= selRange.endRow
        : selRange.startRow === 0 && selRange.endRow >= (geo?.rows ?? 1) - 1 && idx >= selRange.startColumn && idx <= selRange.endColumn;
      const span = whole ? (rows ? [selRange.startRow, selRange.endRow] : [selRange.startColumn, selRange.endColumn]) : [idx, idx];
      const r = rows ? { startRow: span[0], endRow: span[1], startColumn: 0, endColumn: 0 } : { startRow: 0, endRow: 0, startColumn: span[0], endColumn: span[1] };
      if (size !== d.size) commit([{ id: rows ? OP.ROW_HEIGHT : OP.COL_WIDTH, params: { subUnitId: sheetId, ranges: [r], [rows ? 'rowHeight' : 'colWidth']: size } }]);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [geo, hit, commit, sheetId, selRange, fillTo, moveTo, moveCells, dropAt, moveLines, fill, painter, restyle, xs, setExtra, startAuto]);

  // ── Сортировка и фильтр ──
  /** Сортировать по столбцу активной ячейки: выделение (несколько строк) или блок данных вокруг; заголовок остаётся. */
  const sortBy = useCallback((desc: boolean, byCol?: number) => {
    if (!b || !sheet || readOnly) return;
    const f = readFilters(b)[sheetId];
    let area = selRange.endRow > selRange.startRow ? { ...selRange } : f ? { ...f.ref, startRow: f.ref.startRow + 1 } : dataRegion(sheet, sel.anchor.row, sel.anchor.col);
    if (selRange.endRow === selRange.startRow && !f) {
      // Первая строка блока — текст, а ниже есть числа или жирный шрифт: это заголовок, его не сортируем.
      const head = area.startRow;
      const isHead = [...Array(area.endColumn - area.startColumn + 1).keys()].some((i) => {
        const c = area.startColumn + i; const cell = cellAt(sheet, head, c);
        return Boolean(styleOf(b, cell)?.bl) || (typeof cell?.v === 'string' && typeof cellAt(sheet, head + 1, c)?.v === 'number');
      });
      if (isHead) area = { ...area, startRow: head + 1 };
    }
    if (area.endRow <= area.startRow) return;
    const key = byCol ?? sel.anchor.col;
    const rowsList: Array<{ r: number; v: unknown }> = [];
    for (let r = area.startRow; r <= area.endRow; r += 1) rowsList.push({ r, v: cellAt(sheet, r, key)?.v });
    const cmp = (x: unknown, y: unknown) => {
      const ex = x === null || x === undefined || x === ''; const ey = y === null || y === undefined || y === '';
      if (ex || ey) return ex === ey ? 0 : ex ? 1 : -1; // пустые — всегда в конце
      if (typeof x === 'number' && typeof y === 'number') return desc ? y - x : x - y;
      if (typeof x === 'number') return -1;
      if (typeof y === 'number') return 1;
      const t = String(x).localeCompare(String(y), 'ru', { numeric: true, sensitivity: 'base' });
      return desc ? -t : t;
    };
    const sorted = [...rowsList].sort((p, q) => cmp(p.v, q.v) || p.r - q.r);
    if (sorted.every((x, i) => x.r === rowsList[i].r)) return;
    const cells: Record<number, Record<number, Cell | null>> = {};
    sorted.forEach((from, i) => {
      const r = area.startRow + i;
      if (from.r === r) return;
      for (let c = area.startColumn; c <= area.endColumn; c += 1) {
        const cell = cellAt(sheet, from.r, c);
        const wire = cell ? wireCell(b, cell) : null;
        (cells[r] ||= {})[c] = wire?.f ? { ...wire, f: shiftFormula(String(wire.f), r - from.r, 0) } : (wire ?? { v: null, f: null, s: null } as Cell);
      }
    });
    setCells(cells);
  }, [b, sheet, readOnly, sheetId, selRange, sel.anchor.row, sel.anchor.col, setCells]);

  /** Фильтр: включить на выделении (или блоке данных вокруг) / выключить. */
  const toggleFilter = useCallback(() => {
    if (!b || !sheet || readOnly) return;
    if (readFilters(b)[sheetId]) { commit([{ id: OP.FILTER_REMOVE, params: { subUnitId: sheetId } }]); return; }
    const ref = selRange.endRow > selRange.startRow ? selRange : dataRegion(sheet, sel.anchor.row, sel.anchor.col);
    commit([{ id: OP.FILTER_RANGE, params: { subUnitId: sheetId, range: ref } }]);
  }, [b, sheet, readOnly, sheetId, selRange, sel.anchor.row, sel.anchor.col, commit]);

  const setFilterCriteria = useCallback((col: number, criteria: FilterColumn | null) => {
    if (!b || !sheet) return;
    const f = readFilters(b)[sheetId];
    if (!f) return;
    // Скрытые строки считаем здесь и отправляем вместе с условием — у всех одинаково, как у Univer (filteredOutRows).
    const nextCols = [...(f.filterColumns || []).filter((x) => x.colId !== col), ...(criteria ? [criteria] : [])];
    const out = filteredRows(b, sheet, { ...f, filterColumns: nextCols });
    commit([{ id: OP.FILTER_CRITERIA, params: { subUnitId: sheetId, col, criteria, filteredOutRows: out } }]);
  }, [b, sheet, sheetId, commit]);

  const onDoubleClick = (e: React.MouseEvent) => {
    const h = hit(e.clientX, e.clientY);
    const handle = handleAt(e.clientX, e.clientY);
    if (handle?.kind === 'fill' && sheet && b) {
      // Двойной щелчок по квадратику — заполнить вниз до конца соседнего столбца с данными.
      const side = selRange.startColumn > 0 ? selRange.startColumn - 1 : selRange.endColumn + 1;
      let last = selRange.endRow;
      while (cellAt(sheet, last + 1, side)?.v !== undefined && cellAt(sheet, last + 1, side)?.v !== null && cellAt(sheet, last + 1, side)?.v !== '') last += 1;
      if (last > selRange.endRow) fill(selRange, { ...selRange, endRow: last });
      return;
    }
    const oh = objectAt(e.clientX, e.clientY);
    if (oh?.obj.kind === 'chart') { setPanel({ chart: oh.obj.id }); return; }
    if (handle && (handle.kind === 'resize-col' || handle.kind === 'resize-row') && !readOnly) { autofit(handle.kind === 'resize-col', handle.index); return; }
    if (!h || h.row < 0 || h.col < 0 || handle) return;
    startEdit();
  };

  /** Ширина столбца (высота строки) по содержимому; выделены целиком несколько — у всех них. */
  const autofit = (cols: boolean, index: number) => {
    if (!b || !sheet || !geo) return;
    const whole = cols ? selRange.startRow === 0 && selRange.endRow >= geo.rows - 1 && index >= selRange.startColumn && index <= selRange.endColumn
      : selRange.startColumn === 0 && selRange.endColumn >= geo.cols - 1 && index >= selRange.startRow && index <= selRange.endRow;
    const [from, to] = whole ? (cols ? [selRange.startColumn, selRange.endColumn] : [selRange.startRow, selRange.endRow]) : [index, index];
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return;
    const used = usedBounds(sheet);
    const ops: LiveOp[] = [];
    for (let i = from; i <= to; i += 1) {
      let size = 0;
      if (cols) {
        for (let r = 0; r < Math.min(used.rows, 20000); r += 1) {
          const cell = cellAt(sheet, r, i);
          if (!cell || geo.merges.has(`${r}:${i}`)) continue;
          const st = styleOf(b, cell);
          const text = displayText(cell, st);
          if (!text || st?.tb === 3) continue;
          ctx.font = cellFont(st);
          for (const line of text.split('\n')) size = Math.max(size, ctx.measureText(line).width + 12);
        }
        size = Math.max(24, Math.ceil(size || 88));
      } else {
        for (let c = 0; c < used.cols; c += 1) {
          const cell = cellAt(sheet, i, c);
          if (!cell) continue;
          const st = styleOf(b, cell);
          const text = displayText(cell, st);
          if (!text) continue;
          const px = (typeof st?.fs === 'number' ? st.fs : 10) * (96 / 72);
          let lines = text.split('\n').length;
          if (st?.tb === 3) {
            ctx.font = cellFont(st);
            const w = colWidth(sheet, c) - 8;
            lines = text.split('\n').reduce((n, para) => n + Math.max(1, Math.ceil(ctx.measureText(para).width / Math.max(10, w))), 0);
          }
          size = Math.max(size, Math.ceil(lines * px * 1.25 + 8));
        }
        size = Math.max(21, size || 24);
      }
      const cur = cols ? colWidth(sheet, i) : rowHeight(sheet, i);
      if (size === cur) continue;
      const r = cols ? { startRow: 0, endRow: 0, startColumn: i, endColumn: i } : { startRow: i, endRow: i, startColumn: 0, endColumn: 0 };
      ops.push({ id: cols ? OP.COL_WIDTH : OP.ROW_HEIGHT, params: { subUnitId: sheetId, ranges: [r], [cols ? 'colWidth' : 'rowHeight']: size } });
    }
    commit(ops);
  };

  /** Скрыть выделенные строки (столбцы); показать — скрытые внутри выделения. */
  const setHidden = (cols: boolean, hide: boolean) => {
    const r = cols ? { startRow: 0, endRow: 0, startColumn: selRange.startColumn, endColumn: selRange.endColumn } : { startRow: selRange.startRow, endRow: selRange.endRow, startColumn: 0, endColumn: 0 };
    commit([{ id: cols ? (hide ? OP.COL_HIDDEN : OP.COL_VISIBLE) : (hide ? OP.ROW_HIDDEN : OP.ROW_VISIBLE), params: { subUnitId: sheetId, ranges: [r] } }]);
  };
  const hasHidden = (cols: boolean) => {
    if (!sheet) return false;
    for (let i = cols ? selRange.startColumn : selRange.startRow; i <= (cols ? selRange.endColumn : selRange.endRow); i += 1) {
      if (cols ? sheet.columnData?.[i]?.hd : sheet.rowData?.[i]?.hd) return true;
    }
    return false;
  };

  /** Группа строк (столбцов) из выделения; «−» сворачивает (прячет), «+» разворачивает. */
  const groupSel = (rows: boolean, on: boolean) => {
    const key = rows ? 'rows' : 'cols';
    const list: Group[] = [...(xs.groups?.[key] || [])];
    const a = rows ? selRange.startRow : selRange.startColumn; const z0 = rows ? selRange.endRow : selRange.endColumn;
    const next = on ? [...list.filter((g0) => g0.end < a || g0.start > z0), { start: a, end: z0 }].sort((x, y) => x.start - y.start)
      : list.filter((g0) => g0.end < a || g0.start > z0);
    const ops: LiveOp[] = [];
    // Снимаем группу — показываем её строки, если она была свёрнута.
    for (const g0 of list) if (!next.includes(g0) && g0.collapsed) ops.push({ id: rows ? OP.ROW_VISIBLE : OP.COL_VISIBLE, params: { subUnitId: sheetId, ranges: [rows ? { startRow: g0.start, endRow: g0.end, startColumn: 0, endColumn: 0 } : { startRow: 0, endRow: 0, startColumn: g0.start, endColumn: g0.end }] } });
    ops.push({ id: OP.EXTRA, params: { subUnitId: sheetId, key: 'groups', value: { ...(xs.groups || {}), [key]: next } } });
    commit(ops);
  };
  const toggleGroup = (rows: boolean, index: number) => {
    const key = rows ? 'rows' : 'cols';
    const list = [...(xs.groups?.[key] || [])];
    const g0 = list[index];
    if (!g0) return;
    const collapsed = !g0.collapsed;
    list[index] = { ...g0, collapsed: collapsed || undefined };
    const r = rows ? { startRow: g0.start, endRow: g0.end, startColumn: 0, endColumn: 0 } : { startRow: 0, endRow: 0, startColumn: g0.start, endColumn: g0.end };
    commit([
      { id: rows ? (collapsed ? OP.ROW_HIDDEN : OP.ROW_VISIBLE) : (collapsed ? OP.COL_HIDDEN : OP.COL_VISIBLE), params: { subUnitId: sheetId, ranges: [r] } },
      { id: OP.EXTRA, params: { subUnitId: sheetId, key: 'groups', value: { ...(xs.groups || {}), [key]: list } } },
    ]);
  };

  /** Вставить/удалить ячейки со сдвигом (как «Вставить ячейки → со сдвигом вправо/вниз»): переносим значения. */
  const shiftCells = (dir: 'right' | 'down' | 'left' | 'up') => {
    if (!b || !sheet) return;
    const used = usedBounds(sheet);
    const hgt = selRange.endRow - selRange.startRow + 1; const wid = selRange.endColumn - selRange.startColumn + 1;
    const cells: Record<number, Record<number, Cell | null>> = {};
    const put = (r: number, c: number, from: Cell | undefined) => { (cells[r] ||= {})[c] = from ? (wireCell(b, from) ?? null) : null; };
    if (dir === 'right' || dir === 'left') {
      const last = Math.max(used.cols, selRange.endColumn + 1) + wid;
      for (let r = selRange.startRow; r <= selRange.endRow; r += 1) {
        if (dir === 'right') for (let c = last; c >= selRange.startColumn; c -= 1) put(r, c, c - wid >= selRange.startColumn ? cellAt(sheet, r, c - wid) : undefined);
        else for (let c = selRange.startColumn; c <= last; c += 1) put(r, c, cellAt(sheet, r, c + wid));
      }
    } else {
      const last = Math.max(used.rows, selRange.endRow + 1) + hgt;
      for (let c = selRange.startColumn; c <= selRange.endColumn; c += 1) {
        if (dir === 'down') for (let r = last; r >= selRange.startRow; r -= 1) put(r, c, r - hgt >= selRange.startRow ? cellAt(sheet, r - hgt, c) : undefined);
        else for (let r = selRange.startRow; r <= last; r += 1) put(r, c, cellAt(sheet, r + hgt, c));
      }
    }
    setCells(cells);
  };

  /** Картинка поверх ячеек — с компьютера, у активной ячейки; крупная уменьшается до 480 px. */
  const insertImages = async (files: File[]) => {
    for (const file of files.filter((f) => f.type.startsWith('image/'))) {
      try {
        const up = await uploadFileWithProgress(file, () => undefined);
        const src = attachmentUrl(up.url);
        const size = await new Promise<{ w: number; h: number }>((res) => { const img = new Image(); img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight }); img.onerror = () => res({ w: 320, h: 200 }); img.src = src; });
        const k = Math.min(1, 480 / Math.max(1, size.w));
        const o: SheetObject = { id: newId('img'), kind: 'image', row: sel.anchor.row, col: sel.anchor.col, dx: 0, dy: 0, w: Math.round(size.w * k), h: Math.round(size.h * k), src, alt: file.name };
        setExtra('objects', [...(sheetExtras(book.current!, sheetIdRef.current).objects || []), o]);
        setSelectedObject(o.id);
      } catch { showToast('Картинка не загрузилась — проверьте соединение', 'error'); }
    }
  };
  /** Диаграмма по выделению (или блоку данных вокруг) — справа от данных; сразу открывается редактор диаграмм. */
  const insertChart = () => {
    if (!sheet) return;
    const range = selRange.endRow > selRange.startRow || selRange.endColumn > selRange.startColumn ? selRange : dataRegion(sheet, sel.anchor.row, sel.anchor.col);
    const o: SheetObject = { id: newId('ch'), kind: 'chart', row: range.startRow, col: range.endColumn + 2, dx: 0, dy: 0, w: 480, h: 300, chart: { type: 'column', range } };
    setExtra('objects', [...(xs.objects || []), o]);
    setSelectedObject(o.id);
    setPanel({ chart: o.id });
  };
  const removeObject = (id: string) => { setExtra('objects', (xs.objects || []).filter((o) => o.id !== id)); setSelectedObject(null); if (typeof panel === 'object' && panel?.chart === id) setPanel(null); };
  const setNote = (r: number, c: number, text: string) => {
    const notes = { ...(xs.notes || {}) };
    if (text.trim()) notes[`${r}:${c}`] = text; else delete notes[`${r}:${c}`];
    setExtra('notes', notes);
  };
  /** Ссылка в ячейке: текст остаётся, ссылка — на весь текст (как «Вставить ссылку» в Google). */
  const setLink = (r: number, c: number, url: string) => {
    if (!sheet) return;
    const cell = cellAt(sheet, r, c);
    const text = cell?.v !== null && cell?.v !== undefined && cell.v !== '' ? displayText(cell, b ? styleOf(b, cell) : null) : url;
    const p0 = url ? { id: newId('ln'), documentStyle: {}, body: { dataStream: `${text}\r\n`, customRanges: [{ startIndex: 0, endIndex: Math.max(0, text.length - 1), rangeId: newId('r'), rangeType: 0, properties: { url } }] } } : null;
    setCells({ [r]: { [c]: { v: text, t: 1, f: null, p: p0 } as unknown as Cell } });
  };
  /** «Удалить ссылку»: у оформленной ссылки снимается адрес, голый адрес в тексте помечается «не ссылка» (как в Google). */
  const unlinkCell = (r: number, c: number, rich: boolean) => {
    if (rich) setLink(r, c, '');
    const text = String(cellAt(sheet!, r, c)?.v ?? '').trim();
    if (/^https?:\/\/\S+$/i.test(text)) setExtra('nolink', { ...(xs.nolink || {}), [`${r}:${c}`]: 1 });
  };
  const insertCheckbox = () => {
    setExtra('dv', [...(xs.dv || []).map((x) => ({ ...x, ranges: x.ranges })), { id: newId('dv'), ranges: [selRange], kind: 'checkbox' }]);
  };
  const insertDropdown = () => { setPanel('dv'); };

  /** «Разделить текст на столбцы»: разделитель — запятая, точка с запятой, табуляция или пробел (как «Определять автоматически»). */
  const splitText = (sep?: string) => {
    if (!sheet || !b) return;
    const c0 = selRange.startColumn;
    const texts: Array<[number, string]> = [];
    for (let r = selRange.startRow; r <= Math.min(selRange.endRow, usedBounds(sheet).rows); r += 1) {
      const cell = cellAt(sheet, r, c0);
      if (typeof cell?.v === 'string' && cell.v) texts.push([r, cell.v]);
    }
    if (!texts.length) { showToast('В первом столбце выделения нет текста', 'info'); return; }
    const pick = sep ?? ([';', ',', '\t', '|'].find((x) => texts.every(([, t]) => t.includes(x))) || ' ');
    const cells: Record<number, Record<number, Cell | null>> = {};
    for (const [r, t] of texts) t.split(pick).forEach((part, i) => { const parsed = parseInput(part.trim()); (cells[r] ||= {})[c0 + i] = { v: parsed.v ?? null, f: parsed.f ?? null, t: parsed.t ?? null } as Cell; });
    setCells(cells);
  };
  /** Удалить повторяющиеся строки выделения (по всем столбцам выделения); оставшиеся сдвигаются вверх. */
  const removeDuplicates = () => {
    if (!sheet || !b) return;
    const last = Math.min(selRange.endRow, usedBounds(sheet).rows - 1);
    const seen = new Set<string>();
    const keep: number[] = [];
    for (let r = selRange.startRow; r <= last; r += 1) {
      const key = Array.from({ length: selRange.endColumn - selRange.startColumn + 1 }, (_, i) => String(cellAt(sheet, r, selRange.startColumn + i)?.v ?? '').trim().toLowerCase()).join('\u0001');
      if (seen.has(key)) continue;
      seen.add(key); keep.push(r);
    }
    const removed = last - selRange.startRow + 1 - keep.length;
    if (!removed) { showToast('Повторяющихся строк нет', 'info'); return; }
    const cells: Record<number, Record<number, Cell | null>> = {};
    for (let i = 0; i <= last - selRange.startRow; i += 1) {
      const from = keep[i];
      for (let c = selRange.startColumn; c <= selRange.endColumn; c += 1) (cells[selRange.startRow + i] ||= {})[c] = from === undefined ? null : (wireCell(b, cellAt(sheet, from, c)) ?? null);
    }
    setCells(cells);
    showToast(`Удалено повторов: ${removed}, осталось строк: ${keep.length}`, 'success');
  };
  const trimSpaces = () => {
    if (!sheet) return;
    const cells: Record<number, Record<number, Cell | null>> = {};
    let n = 0;
    eachSelected((r, c) => { const v = cellAt(sheet, r, c)?.v; if (typeof v === 'string') { const t = v.replace(/\s+/g, ' ').trim(); if (t !== v) { n += 1; (cells[r] ||= {})[c] = { v: t } as Cell; } } });
    setCells(cells);
    showToast(n ? `Исправлено ячеек: ${n}` : 'Лишних пробелов нет', n ? 'success' : 'info');
  };
  const shuffleRows = () => {
    if (!sheet || !b) return;
    const rowsList: number[] = [];
    for (let r = selRange.startRow; r <= Math.min(selRange.endRow, usedBounds(sheet).rows - 1); r += 1) rowsList.push(r);
    const order = [...rowsList];
    for (let i = order.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    const cells: Record<number, Record<number, Cell | null>> = {};
    rowsList.forEach((r, i) => { for (let c = selRange.startColumn; c <= selRange.endColumn; c += 1) (cells[r] ||= {})[c] = wireCell(b, cellAt(sheet, order[i], c)) ?? null; });
    setCells(cells);
  };
  const moveSheet = (id: string, dir: -1 | 1) => {
    if (!b) return;
    const from = b.sheetOrder.indexOf(id);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= b.sheetOrder.length) return;
    commit([{ id: OP.SHEET_ORDER, params: { subUnitId: id, fromOrder: from, toOrder: to } }]);
  };
  const setSheetHidden = (id: string, hidden: boolean) => {
    if (!b) return;
    if (hidden && b.sheetOrder.filter((x) => !b.sheets[x]?.hidden).length < 2) { showToast('Нельзя скрыть единственный видимый лист', 'info'); return; }
    commit([{ id: OP.SHEET_HIDDEN, params: { subUnitId: id, hidden: hidden ? 1 : 0 } }]);
    if (hidden && id === sheetId) setSheetId(b.sheetOrder.find((x) => x !== id && !b.sheets[x]?.hidden) || sheetId);
    if (!hidden) setSheetId(id);
  };

  /** Копия листа — рядом с ним, как «Создать копию» в Google. */
  const duplicateSheet = (id: string) => {
    if (!b) return;
    const src = b.sheets[id];
    if (!src) return;
    const names = new Set(Object.values(b.sheets).map((x) => x.name));
    let name = `Копия ${src.name}`.slice(0, 31);
    for (let n = 2; names.has(name); n += 1) name = `Копия ${src.name} ${n}`.slice(0, 31);
    const cellData: Record<number, Record<number, Cell | null>> = {};
    for (const [r, row] of Object.entries(src.cellData || {})) for (const [c, cell] of Object.entries(row || {})) (cellData[Number(r)] ||= {})[Number(c)] = wireCell(b, cell);
    const copy = JSON.parse(JSON.stringify({ ...src, cellData }));
    const nid = `sheet-${Date.now().toString(36)}`;
    commit([{ id: OP.INSERT_SHEET, params: { index: b.sheetOrder.indexOf(id) + 1, sheet: { ...copy, id: nid, name } } }]);
    setSheetId(nid);
  };

  // ── Клавиатура ──
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && !edit && sheet) { const url = linkOf(cellAt(sheet, sel.anchor.row, sel.anchor.col)); if (url) { const key = `${sheetId}:${sel.anchor.row}:${sel.anchor.col}`; if (cardClosed !== key) { setCardClosed(key); return; } } }
    if (edit || !geo) return;
    if (selectedObject) {
      if ((e.key === 'Delete' || e.key === 'Backspace') && !readOnly) { e.preventDefault(); removeObject(selectedObject); return; }
      if (e.key === 'Escape') { setSelectedObject(null); return; }
    }
    const dvHere = (xs.dv || []).find((x) => x.ranges.some((g0) => sel.anchor.row >= g0.startRow && sel.anchor.row <= g0.endRow && sel.anchor.col >= g0.startColumn && sel.anchor.col <= g0.endColumn));
    if (dvHere?.kind === 'checkbox' && e.key === ' ' && !e.ctrlKey && !e.shiftKey && !readOnly && sheet) {
      // Пробел — переключить все флажки выделения (как в Google).
      e.preventDefault();
      const on = !isChecked(cellAt(sheet, sel.anchor.row, sel.anchor.col)?.v);
      const cells: Record<number, Record<number, Cell | null>> = {};
      eachSelected((r, c) => { (cells[r] ||= {})[c] = { v: on, t: 3 } as Cell; });
      setCells(cells);
      return;
    }
    if (dvHere?.kind === 'list' && e.altKey && e.key === 'ArrowDown' && grid.current) {
      e.preventDefault();
      const box = grid.current.getBoundingClientRect();
      setListMenu({ r: sel.anchor.row, c: sel.anchor.col, x: box.left + screenX(geo, sel.anchor.col, grid.current.scrollLeft / zoom) * zoom, y: box.top + screenY2(geo, sel.anchor.row, grid.current.scrollTop / zoom) * zoom, values: dvHere.values || [] });
      return;
    }
    if (e.key === 'F2' && e.shiftKey && !readOnly) { e.preventDefault(); setNoteEdit({ r: sel.anchor.row, c: sel.anchor.col, text: xs.notes?.[`${sel.anchor.row}:${sel.anchor.col}`] || '' }); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'k' || e.key.toLowerCase() === 'л') && !readOnly && sheet) {
      e.preventDefault();
      const cell = cellAt(sheet, sel.anchor.row, sel.anchor.col);
      const url0 = ((cell?.p as { body?: { customRanges?: Array<{ properties?: { url?: string } }> } } | undefined)?.body?.customRanges?.[0]?.properties?.url) || '';
      setLinkEdit({ r: sel.anchor.row, c: sel.anchor.col, initial: url0 });
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === '/' || e.code === 'Slash')) { e.preventDefault(); setShortcuts(true); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+' || e.key === '-')) { e.preventDefault(); setZoom((z) => Math.max(0.5, Math.min(2, Math.round((z + (e.key === '-' ? -0.1 : 0.1)) * 10) / 10))); return; }
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (mod && !e.altKey) {
      const lower = k.toLowerCase();
      if (lower === 'z' || lower === 'я') { e.preventDefault(); undoStep(!e.shiftKey); return; }
      if (lower === 'y' || lower === 'н') { e.preventDefault(); undoStep(false); return; }
      if (lower === 'b' || lower === 'и') { e.preventDefault(); toggle('bl', 1); return; }
      if (lower === 'i' || lower === 'ш') { e.preventDefault(); toggle('it', 1); return; }
      if (lower === 'u' || lower === 'г') { e.preventDefault(); restyle((s) => ({ ...s, ul: anchorStyle.ul ? undefined : { s: 1 } })); return; }
      if (lower === 'a' || lower === 'ф') { e.preventDefault(); setSel({ anchor: { row: 0, col: 0 }, focus: { row: geo.rows - 1, col: geo.cols - 1 } }); return; }
      if (lower === 'f' || lower === 'а') { e.preventDefault(); setFind((f) => ({ ...f, open: true, replace: false })); return; }
      if (lower === 'h' || lower === 'р') { e.preventDefault(); setFind((f) => ({ ...f, open: true, replace: true })); return; }
      // Ctrl+D / Ctrl+R — заполнить выделение вниз / вправо первой строкой (столбцом), как в Excel.
      if ((lower === 'd' || lower === 'в') && selRange.endRow > selRange.startRow && !readOnly) { e.preventDefault(); fill({ ...selRange, endRow: selRange.startRow }, selRange); return; }
      if ((lower === 'r' || lower === 'к') && selRange.endColumn > selRange.startColumn && !readOnly) { e.preventDefault(); fill({ ...selRange, endColumn: selRange.startColumn }, selRange); return; }
      if (k === 'Home') { e.preventDefault(); setSel({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } }); reveal(0, 0); return; }
      if (k === 'End' && sheet) { e.preventDefault(); const u = usedBounds(sheet); const p0 = { row: Math.max(0, u.rows - 1), col: Math.max(0, u.cols - 1) }; setSel({ anchor: p0, focus: p0 }); reveal(p0.row, p0.col); return; }
      if (k === ' ') { e.preventDefault(); setSel((x) => ({ anchor: { row: 0, col: x.anchor.col }, focus: { row: geo.rows - 1, col: x.focus.col } })); return; }
      if (k === 'Backspace') { e.preventDefault(); reveal(sel.anchor.row, sel.anchor.col); return; }
      if (k === '\\') { e.preventDefault(); if (!readOnly) restyle(() => ({} as Style)); return; }
      if (!readOnly && (e.code === 'Semicolon' || k === ';' || k === 'ж')) {
        // Ctrl+; — сегодняшняя дата, Ctrl+Shift+; — текущее время.
        e.preventDefault();
        const now = new Date(); const p2 = (n: number) => String(n).padStart(2, '0');
        writeInput(sel.anchor.row, sel.anchor.col, e.shiftKey ? `${p2(now.getHours())}:${p2(now.getMinutes())}` : `${p2(now.getDate())}.${p2(now.getMonth() + 1)}.${now.getFullYear()}`);
        return;
      }
      if (e.shiftKey && !readOnly) {
        // Форматы чисел как в Google: Ctrl+Shift+1 число, 3 дата, 4 рубли, 5 процент; L/E/R — выравнивание.
        const fmt: Record<string, string> = { Digit1: '#,##0.00', Digit3: 'dd.mm.yyyy', Digit4: '#,##0.00 "₽"', Digit5: '0.00%' };
        if (fmt[e.code]) { e.preventDefault(); setPattern(fmt[e.code]); return; }
        const align: Record<string, number> = { KeyL: 1, KeyE: 2, KeyR: 3 };
        if (align[e.code]) { e.preventDefault(); const v = align[e.code]; restyle((x) => ({ ...x, ht: v })); return; }
        if (e.code === 'KeyV') { pasteValues.current = true; return; }
      }
    }
    if (!mod && e.shiftKey && k === ' ') { e.preventDefault(); setSel((x) => ({ anchor: { row: x.anchor.row, col: 0 }, focus: { row: x.focus.row, col: geo.cols - 1 } })); return; }
    if (mod && e.altKey && e.code === 'KeyM' && onAddComment) { e.preventDefault(); onAddComment(); return; }
    const arrows: Record<string, [number, number]> = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (arrows[k]) { e.preventDefault(); move(arrows[k][0], arrows[k][1], e.shiftKey, mod); return; }
    if (k === 'Tab') { e.preventDefault(); move(0, e.shiftKey ? -1 : 1); return; }
    if (k === 'Enter') { e.preventDefault(); if (e.shiftKey) move(-1, 0); else startEdit(); return; }
    if (k === 'F2') { e.preventDefault(); startEdit(); return; }
    if (k === 'PageDown' || k === 'PageUp') { e.preventDefault(); move(k === 'PageDown' ? 20 : -20, 0, e.shiftKey); return; }
    if (k === 'Home') { e.preventDefault(); move(0, -sel.anchor.col, e.shiftKey); return; }
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); if (!readOnly) clearValues(); return; }
    if (k === 'Escape') { clip.current = null; setClipMark(null); setPainter(null); return; }
    if (!mod && !e.altKey && k.length === 1 && !readOnly) { e.preventDefault(); startEdit(k); }
  };

  // Поле правки: фокус и каретка в конец.
  useEffect(() => {
    if (!edit || edit.bar) return;
    const el = editor.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, [edit?.row, edit?.col, Boolean(edit)]); // eslint-disable-line react-hooks/exhaustive-deps

  const acceptSuggestion = (name: string) => {
    if (!edit) return;
    const at = caretNow();
    const t = typingName(edit.text, at);
    if (!t) return;
    const text = `${edit.text.slice(0, t.start)}${name}(${edit.text.slice(at)}`;
    const pos = t.start + name.length + 1;
    setEdit({ ...edit, text });
    setCaret(pos);
    setSuggestAt(0);
    window.requestAnimationFrame(() => { const el = editField(); if (el) { el.focus(); el.setSelectionRange(pos, pos); } });
  };
  const onEditKey = (e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (suggestions.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setSuggestAt((i) => (i + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.ctrlKey && !e.altKey)) { e.preventDefault(); acceptSuggestion(suggestions[Math.min(suggestAt, suggestions.length - 1)].name); return; }
      if (e.key === 'Escape') { e.preventDefault(); setSuggestOff(true); return; }
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && edit && !readOnly) {
      // Ctrl+Enter — то же значение во всё выделение (формула — со сдвигом ссылок), как в Google.
      e.preventDefault();
      const x = edit;
      setEdit(null);
      grid.current?.focus({ preventScroll: true });
      const cells: Record<number, Record<number, Cell | null>> = {};
      eachSelected((r, c) => {
        const text = x.text.startsWith('=') ? shiftFormula(x.text, r - x.row, c - x.col) : x.text;
        const parsed = parseInput(text);
        (cells[r] ||= {})[c] = { v: parsed.v ?? null, f: parsed.f ?? null, t: parsed.t ?? null } as Cell;
      });
      setCells(cells);
      return;
    }
    if (e.key === 'Enter' && e.altKey) { e.preventDefault(); setEdit((x) => (x ? { ...x, text: `${x.text}\n` } : x)); return; }
    // Подсказка из столбца принимается тем же Enter/Tab, что и правка (как в Google).
    const withAuto = autoSuffix && edit ? autoFull : undefined;
    if (e.key === 'Enter') { e.preventDefault(); finishEdit(e.shiftKey ? 'up' : 'down', withAuto); return; }
    if (e.key === 'Tab') { e.preventDefault(); finishEdit(e.shiftKey ? 'left' : 'right', withAuto); return; }
    if (e.key === 'Escape') { e.preventDefault(); finishEdit('cancel'); }
  };

  const suggestions = useMemo(() => {
    if (!edit || suggestOff) return [];
    const t = typingName(edit.text, caret);
    return t && t.word.length >= 1 ? suggestFunctions(t.word, supportedFunctions()) : [];
  }, [edit, caret, suggestOff]);
  const hint = edit && !suggestions.length ? (() => { const f = enclosingFunction(edit.text, caret); return f ? signatureOf(f) : null; })() : null;
  const editRefs = useMemo(() => {
    if (!edit || !edit.text.startsWith('=') || !sheet) return [] as ReturnType<typeof formulaRefs>;
    return formulaRefs(edit.text).filter((r) => r.range && (!r.sheet || r.sheet.toLowerCase() === sheet.name.toLowerCase()));
  }, [edit, sheet]);
  useEffect(() => { setSuggestOff(false); setSuggestAt(0); }, [edit?.row, edit?.col]);

  // ── Поиск (Ctrl+F) ──
  const findHits = useMemo(() => {
    const q = find.query.trim().toLowerCase();
    if (!find.open || !q || !sheet || !b) return [] as Pos[];
    const out: Pos[] = [];
    for (const [r, row] of Object.entries(sheet.cellData || {})) for (const [c, cell] of Object.entries(row || {})) {
      if (displayText(cell, styleOf(b, cell)).toLowerCase().includes(q)) out.push({ row: Number(r), col: Number(c) });
    }
    return out.sort((x, y) => x.row - y.row || x.col - y.col);
  }, [find.open, find.query, sheet, b, undo.current.length]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Заменить найденное: в тексте ячеек (формулы и числа не трогаем), без учёта регистра — как в Google. */
  const replaceIn = (positions: Pos[], text: string) => {
    if (!b || !sheet || readOnly) return;
    const q = find.query.trim();
    if (!q) return;
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const cells: Record<number, Record<number, Cell | null>> = {};
    for (const p0 of positions) {
      const cell = cellAt(sheet, p0.row, p0.col);
      if (!cell || cell.f || typeof cell.v !== 'string') continue;
      const next = cell.v.replace(re, text);
      if (next !== cell.v) (cells[p0.row] ||= {})[p0.col] = { v: next, p: null } as Cell;
    }
    setCells(cells);
  };
  const replaceFind = {
    one: (text: string) => { const p0 = findHits[find.index]; if (p0) replaceIn([p0], text); },
    all: (text: string) => { replaceIn(findHits, text); },
  };
  const goFind = (i: number) => {
    if (!findHits.length) return;
    const k = ((i % findHits.length) + findHits.length) % findHits.length;
    const p = findHits[k];
    setFind((f) => ({ ...f, index: k }));
    setSel({ anchor: p, focus: p });
    reveal(p.row, p.col);
  };

  // ── Связь со строкой меню и панелью комментариев ──
  const commands = useMemo<Record<string, () => void>>(() => ({
    'univer.command.undo': () => undoStep(true),
    'univer.command.redo': () => undoStep(false),
    'univer.command.copy': () => copy(false, null),
    'univer.command.cut': () => copy(true, null),
    'univer.command.paste': () => { void navigator.clipboard?.readText().then((t) => paste(t)).catch(() => showToast('Нажмите Ctrl+V', 'info')); },
    'sheet.command.paste-value': () => { void navigator.clipboard?.readText().then((t) => paste(t, 'values')).catch(() => showToast('Нажмите Ctrl+V', 'info')); },
    'sheet.command.paste-format': () => { if (clip.current) paste(clip.current.tsv, 'format'); },
    'ui.operation.open-find-dialog': () => setFind((f) => ({ ...f, open: true, replace: true })),
    'sheet.command.set-range-bold': () => toggle('bl', 1),
    'sheet.command.set-range-italic': () => toggle('it', 1),
    'sheet.command.set-range-underline': () => restyle((s) => ({ ...s, ul: anchorStyle.ul ? undefined : { s: 1 } })),
    'sheet.command.set-range-stroke': () => restyle((s) => ({ ...s, st: anchorStyle.st ? undefined : { s: 1 } })),
    'sheet.command.set-range-font-increase': () => restyle((s) => ({ ...s, fs: Math.min(96, (Number(s.fs) || 11) + 1) })),
    'sheet.command.set-range-font-decrease': () => restyle((s) => ({ ...s, fs: Math.max(6, (Number(s.fs) || 11) - 1) })),
    'sheet.command.numfmt.set.percent': () => setPattern('0%'),
    'sheet.command.numfmt.set.currency': () => setPattern('#,##0.00 "₽"'),
    'sheet.command.numfmt.add.decimal.command': () => stepDecimals(1),
    'sheet.command.numfmt.subtract.decimal.command': () => stepDecimals(-1),
    'sheet.command.add-worksheet-merge-all': () => { if (!merged) toggleMerge(); },
    'sheet.command.remove-worksheet-merge': () => { if (merged) toggleMerge(); },
    'ui.command.clear-formatting': () => restyle(() => ({} as Style)),
    'shar.sheet.cf': () => setPanel('cf'),
    'shar.sheet.banding': () => setPanel('banding'),
    'shar.sheet.names': () => setPanel('names'),
    'shar.sheet.split': () => splitText(),
    'shar.sheet.dedupe': () => removeDuplicates(),
    'shar.sheet.trim': () => trimSpaces(),
    'shar.sheet.shuffle': () => shuffleRows(),
    'shar.sheet.shortcuts': () => setShortcuts(true),
    'shar.sheet.paste-transpose': () => { if (clip.current) paste(clip.current.tsv, 'transpose'); },
    'shar.sheet.dv': () => setPanel('dv'),
    'shar.sheet.chart': () => insertChart(),
    'shar.sheet.image': () => imageInput.current?.click(),
    'shar.sheet.checkbox': () => insertCheckbox(),
    'shar.sheet.dropdown': () => insertDropdown(),
    'shar.sheet.note': () => setNoteEdit({ r: sel.anchor.row, c: sel.anchor.col, text: xs.notes?.[`${sel.anchor.row}:${sel.anchor.col}`] || '' }),
    'shar.sheet.group-rows': () => groupSel(true, true),
    'shar.sheet.ungroup-rows': () => groupSel(true, false),
    'shar.sheet.group-cols': () => groupSel(false, true),
    'shar.sheet.ungroup-cols': () => groupSel(false, false),
    'shar.sheet.insert-cells-right': () => shiftCells('right'),
    'shar.sheet.insert-cells-down': () => shiftCells('down'),
    'shar.sheet.delete-cells-left': () => shiftCells('left'),
    'shar.sheet.delete-cells-up': () => shiftCells('up'),
    'shar.sheet.zoom-in': () => setZoom((z) => Math.min(2, Math.round((z + 0.1) * 10) / 10)),
    'shar.sheet.zoom-out': () => setZoom((z) => Math.max(0.5, Math.round((z - 0.1) * 10) / 10)),
    'sheet.command.add-range-protection-from-toolbar': () => setPanel('protect'),
    'sheet.operation.insert-hyper-link-toolbar': () => { if (sheet) { const cell = cellAt(sheet, sel.anchor.row, sel.anchor.col); setLinkEdit({ r: sel.anchor.row, c: sel.anchor.col, initial: ((cell?.p as { body?: { customRanges?: Array<{ properties?: { url?: string } }> } } | undefined)?.body?.customRanges?.[0]?.properties?.url) || '' }); } },
    'sheet.command.toggle-gridlines': () => { if (sheet) commit([{ id: OP.GRIDLINES, params: { subUnitId: sheetId, showGridlines: sheet.showGridlines === 0 ? 1 : 0 } }]); },
    'sheet.command.sort-range-asc': () => sortBy(false),
    'sheet.command.sort-range-desc': () => sortBy(true),
    'sheet.command.smart-toggle-filter': () => toggleFilter(),
    'sheet.command.clear-filter-criteria': () => { if (!b) return; const f = readFilters(b)[sheetId]; for (const c of f?.filterColumns || []) setFilterCriteria(c.colId, null); },
  }), [undoStep, copy, paste, restyle, anchorStyle, merged, sortBy, toggleFilter, setFilterCriteria, b, sheetId, sheet, commit, xs, sel, selRange]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!commentsBridge) return undefined;
    commentsBridge.current = {
      anchor: () => (sheet ? { kind: 'cell', sheet: sheet.name, cell: a1(sel.anchor.row, sel.anchor.col) } : null),
      jump: (anchor) => {
        if (anchor.kind !== 'cell' || !b) return;
        const target = Object.values(b.sheets).find((s) => s.name === anchor.sheet);
        if (target) setSheetId(target.id);
        const p = parseA1(anchor.cell);
        if (p) { setSel({ anchor: p, focus: p }); window.requestAnimationFrame(() => reveal(p.row, p.col)); }
      },
      exec: (id) => { const fn = commands[id]; if (!fn || readOnly) return false; fn(); return true; },
      has: (id) => Boolean(commands[id]),
    };
    return () => { commentsBridge.current = null; };
  }, [commentsBridge, commands, sheet, sel.anchor.row, sel.anchor.col, b, readOnly, reveal]);

  // ── Отрисовка на холсте (sheet/draw.ts): холст размером с окно прилипает к краю прокрутки, на каждый кадр
  // рисуются только видимые ячейки — без перестройки элементов страницы (DOM-сетка лагала на больших таблицах). ──
  const canvas = useRef<HTMLCanvasElement>(null);
  const editBoxEl = useRef<HTMLDivElement>(null);
  const linkCardEl = useRef<HTMLDivElement>(null);
  const placeLinkCardRef = useRef<() => void>(() => undefined);
  const editAt = useRef({ key: '', x: 0, y: 0 });
  // Кэш слоя ячеек: пока меняется только выделение, текст и заливки не перерисовываются (см. drawSheet).
  const baseLayer = useRef<BaseLayer | null>(null);
  const baseKey = useRef('');
  const assetTick = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const drawState = useRef<() => void>(() => undefined);
  drawState.current = () => {
    const el = grid.current; const cv = canvas.current;
    if (!el || !cv || !geo || !sheet || !b || !root.current) return;
    const dpr = window.devicePixelRatio || 1;
    const W = el.clientWidth; const H = el.clientHeight;
    // Размер холста — целым числом пикселей экрана, а на странице — ровно столько же (W·dpr / dpr): без растягивания.
    const bw = Math.round(W * dpr); const bh = Math.round(H * dpr);
    if (cv.width !== bw || cv.height !== bh) {
      cv.width = bw; cv.height = bh;
      cv.style.width = `${bw / dpr}px`; cv.style.height = `${bh / dpr}px`;
    }
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const filters = readFilters(b);
    const f = filters[sheetId];
    const anchorM = geo.merges.get(`${sel.anchor.row}:${sel.anchor.col}`);
    const z = zoomRef.current;
    const objects = (xs.objects || []).map((o) => (objDraft && objDraft.id === o.id ? objDraft : o));
    const theme = readTheme(root.current);
    // Всё, от чего зависят ячейки на холсте. Выделение, коллеги и подсветка ссылок формулы сюда не входят.
    const key = [objId(b), objId(sheet), objId(geo), objId(xs), objId(cfLookup), version, sheetId, el.scrollLeft, el.scrollTop, bw, bh, z, dpr,
      JSON.stringify(theme), objDraft ? JSON.stringify(objDraft) : '', selectedObject ?? '', assetTick.current].join('|');
    if (!baseLayer.current) baseLayer.current = { canvas: document.createElement('canvas'), fresh: false };
    baseLayer.current.fresh = key === baseKey.current;
    baseKey.current = key;
    drawSheet(ctx, {
      book: b, sheet, geo, theme, scrollX: el.scrollLeft / z, scrollY: el.scrollTop / z, width: W / z, height: H / z, dpr, zoom: z,
      cf: cfLookup, cfBlank: (xs.cf || []).filter((x) => x.kind === 'blank').flatMap((x) => x.ranges),
      dv: xs.dv, notes: xs.notes, noLinks: xs.nolink, objects, selectedObject, groups: xs.groups, banding: xs.banding, onAsset: () => { assetTick.current += 1; redraw(); },
      sel: fillTo ?? selRange, ghost: moveTo, dropAt, headHover: headHover.current, flash: flashNow(), active: anchorM ?? { startRow: sel.anchor.row, endRow: sel.anchor.row, startColumn: sel.anchor.col, endColumn: sel.anchor.col },
      clip: clipMark, marks: new Set(commentCells.filter((m) => !m.sheet || m.sheet === sheet.name).map((m) => m.cell)),
      peers: cursors.flatMap((cur) => {
        const p = cur.pos as SheetCursor | null;
        return p && p.sh === sheetId ? [{ name: cur.name, color: cur.color, range: norm({ startRow: p.r1, startColumn: p.c1, endRow: p.r2, endColumn: p.c2 }) }] : [];
      }),
      filter: f?.ref ?? null, filtered: new Set(f?.cachedFilteredOut || []), filterOn: new Set((f?.filterColumns || []).map((x) => x.colId)),
      // Во время правки рамку ячейки рисует само поле — двойная рамка давала торчащие уголки.
      hideActive: Boolean(edit && !edit.bar),
      refs: editRefs.map((r) => ({ range: r.range!, color: r.color })),
    }, baseLayer.current);
  };
  // После каждой перерисовки карточка ссылки встаёт под свою ячейку (см. placeLinkCard).
  useLayoutEffect(() => { placeLinkCardRef.current(); });
  // Вспышки на этот кадр (ячейка и яркость 0…1); пока есть — следующий кадр перерисуем (только верхний слой).
  const flashNow = () => {
    if (!flash.current.size) return undefined;
    const now = performance.now();
    const out: Array<[number, number, number]> = [];
    for (const [key, t] of flash.current) {
      const a = 1 - (now - t) / FLASH_MS;
      if (a <= 0) { flash.current.delete(key); continue; }
      const [r, col] = key.split(':').map(Number);
      out.push([r, col, a]);
    }
    if (flash.current.size) window.requestAnimationFrame(() => redraw());
    return out;
  };
  const frame = useRef(0);
  const redraw = useCallback(() => {
    if (frame.current) return;
    frame.current = window.requestAnimationFrame(() => { frame.current = 0; drawState.current(); });
  }, []);
  // Перерисовать после каждого рендера (правка, выделение, коллеги) — сам рендер холст не трогает.
  useEffect(() => { redraw(); });
  useEffect(() => {
    const el = grid.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom((z) => Math.max(0.5, Math.min(2, Math.round((z + (e.deltaY < 0 ? 0.1 : -0.1)) * 10) / 10)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [Boolean(sheet)]); // eslint-disable-line react-hooks/exhaustive-deps
  // Смена темы — перерисовать.
  useEffect(() => {
    const mo = new MutationObserver(redraw);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, [redraw]);

  // Сводка выделения (как в углу Google Таблиц): сумма, среднее, количество — только при смене выделения и правках.
  // Сумма выделения считается с отставанием (useDeferredValue) и только по заполненным ячейкам: при протягивании
  // по целым столбцам обход каждой ячейки на каждое движение мыши и давал лаг.
  const sumKey = useDeferredValue(`${selRange.startRow}:${selRange.startColumn}:${selRange.endRow}:${selRange.endColumn}`);
  const summaryText = useMemo(() => {
    const [sr, sc, er, ec] = sumKey.split(':').map(Number);
    if (!sheet || (sr === er && sc === ec)) return null;
    let sum = 0; let n = 0; let count = 0; let min = Infinity; let max = -Infinity;
    const data = sheet.cellData || {};
    for (const rk of Object.keys(data)) {
      const r = Number(rk);
      if (r < sr || r > er || !data[r]) continue;
      for (const ck of Object.keys(data[r])) {
        const c = Number(ck);
        if (c < sc || c > ec) continue;
        const v = data[r][c]?.v;
        if (v !== null && v !== undefined && v !== '') count += 1;
        if (typeof v === 'number') { sum += v; n += 1; if (v < min) min = v; if (v > max) max = v; }
      }
    }
    if (!count) return null;
    // Как в Google: числа с разрядами, без «хвоста» из двенадцати знаков.
    const f = (x: number) => Number(x.toPrecision(12)).toLocaleString('ru-RU', { maximumFractionDigits: 6 });
    const all: Array<[StatKind, string, string]> = n
      ? [['sum', 'Сумма', f(sum)], ['avg', 'Среднее', Number((sum / n).toFixed(2)).toLocaleString('ru-RU', { maximumFractionDigits: 2 })], ['min', 'Минимум', f(min)], ['max', 'Максимум', f(max)], ['count', 'Количество', f(count)], ['countNum', 'Количество чисел', f(n)]]
      : [['count', 'Количество', f(count)]];
    return all;
  }, [sheet, version, sumKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div className="nws-missing" role="alert">{error}</div>;
  if (!b || !sheet || !geo) return <div className="fsh-loading" aria-busy="true">Открываю таблицу…</div>;

  // ── Отрисовка видимой части ──
  const { rowOffs, colOffs, rows, cols } = geo;

  const editCell = edit ? cellAt(sheet, edit.row, edit.col) : undefined;
  const editLook = edit ? cellCss(styleOf(b, editCell)) : null;
  // Поле правки — в экранных координатах поверх холста (с учётом прокрутки и закрепления).
  // Ссылка в активной ячейке — карточка под ней (только одна ячейка выделена, без правки и меню).
  const linkCard = (() => {
    if (edit || menu || linkEdit || selRange.startRow !== selRange.endRow || selRange.startColumn !== selRange.endColumn) return null;
    const m = geo.merges.get(`${sel.anchor.row}:${sel.anchor.col}`);
    const r0 = m?.startRow ?? sel.anchor.row; const c0 = m?.startColumn ?? sel.anchor.col; const r1 = m?.endRow ?? sel.anchor.row;
    const cell = cellAt(sheet, r0, c0);
    const url = xs.nolink?.[`${r0}:${c0}`] ? null : linkOf(cell);
    if (!url || cardClosed === `${sheetId}:${r0}:${c0}`) return null;
    const rich = Boolean((cell?.p as { body?: { customRanges?: unknown[] } } | undefined)?.body?.customRanges?.length);
    return { url, r0, r1, c0, rich, inner: sharTarget(url) };
  })();
  /**
   * Карточку ссылки ставим под ячейку прямо из прокрутки, в том же кадре, что и холст (через перерисовку React она
   * отставала на кадр и дёргалась); ушла ячейка из вида — карточка прячется.
   */
  const placeLinkCard = () => {
    const card = linkCardEl.current; const el = grid.current;
    if (!card || !el || !linkCard) return;
    const z = zoomRef.current;
    const x = screenX(geo, linkCard.c0, el.scrollLeft / z); const y = screenY2(geo, linkCard.r1, el.scrollTop / z) + 6;
    const top = HEAD_H + (linkCard.r1 >= geo.fr ? geo.fh : 0); const left = HEAD_W + (linkCard.c0 >= geo.fc ? geo.fw : 0);
    const hidden = y - 6 <= top || y > el.clientHeight / z - 30 || x < left - 10;
    // Ячейка уехала влево под заголовки — карточка не вылезает за край сетки.
    const cx = Math.max(left + 4, Math.min(x, el.clientWidth / z - card.offsetWidth / z - 8));
    card.style.left = `${cx * z}px`; card.style.top = `${y * z}px`; card.style.visibility = hidden ? 'hidden' : '';
  };
  placeLinkCardRef.current = placeLinkCard;
  // Автодополнение по столбцу (как в Google): набранное — начало значения из этого же столбца → остаток бледным,
  // Enter/Tab принимают. Берётся ближайшее по строкам; числа, формулы и короткие совпадения не подсказываем.
  let autoFull = '';
  const autoSuffix = (() => {
    if (!edit || edit.bar || autoOff || !sheet || !b) return '';
    const typed = edit.text;
    if (!typed.trim() || typed.startsWith('=') || caret !== typed.length || typed.includes('\n')) return '';
    const low = typed.toLocaleLowerCase('ru');
    let best = ''; let bestDist = Infinity;
    const data = sheet.cellData || {};
    for (const rk of Object.keys(data)) {
      const r = Number(rk);
      if (r === edit.row) continue;
      const cell = data[r]?.[edit.col];
      if (!cell || cell.f || typeof cell.v !== 'string') continue;
      const v = cell.v;
      if (v.length <= typed.length || !v.toLocaleLowerCase('ru').startsWith(low)) continue;
      const dist = Math.abs(r - edit.row);
      if (dist < bestDist) { best = v; bestDist = dist; }
    }
    autoFull = best;
    return best ? best.slice(typed.length) : '';
  })();
  // Поле правки стоит на месте экрана, где правку начали, — при прокрутке оно не едет с ячейками (как в Google);
  // над ним тогда появляется адрес ячейки. Прокрутку запоминаем в момент открытия правки этой ячейки.
  const editKey = edit ? `${sheetId}:${edit.row}:${edit.col}` : '';
  if (editKey !== editAt.current.key) editAt.current = { key: editKey, x: grid.current?.scrollLeft ?? 0, y: grid.current?.scrollTop ?? 0 };
  const editMoved = Boolean(edit) && (Math.abs((grid.current?.scrollLeft ?? 0) - editAt.current.x) > 1 || Math.abs((grid.current?.scrollTop ?? 0) - editAt.current.y) > 1);
  const editBoxRaw = edit ? (() => {
    const m = geo.merges.get(`${edit.row}:${edit.col}`);
    const r0 = m?.startRow ?? edit.row; const c0 = m?.startColumn ?? edit.col; const r1 = m?.endRow ?? edit.row; const c1 = m?.endColumn ?? edit.col;
    const sx0 = editAt.current.x / zoom; const sy0 = editAt.current.y / zoom;
    const x = screenX(geo, c0, sx0); const y = screenY(geo, r0, sy0);
    return { x, y, w: screenX2(geo, c1, sx0) - x, h: screenY2(geo, r1, sy0) - y };
  })() : null;
  /**
   * Поле правки как в Google: ровно поверх ячейки (рамка — тенью снаружи, размер не меняет), текст на том же месте,
   * что и в ячейке (шрифт, кегль, отступы, вертикальное выравнивание); длинный текст растит поле вправо до края окна,
   * дальше — переносом вниз.
   */
  const editBoxStyle: CSSProperties | undefined = (() => {
    if (!edit) return undefined;
    const st = styleOf(b, editCell);
    const pt = typeof st?.fs === 'number' ? st.fs : 10;
    const lineH = Math.round(pt * (96 / 72) * 1.25);
    const vt = Number(st?.vt) || 3;
    const h = Math.max(12, (editBoxRaw?.h ?? 24) - 1);
    // Базовая линия текста — там же, где её рисует холст (draw.ts: низ — y+h−4, верх — y+2+кегль, середина — по центру
    // строки): иначе при входе в правку текст подпрыгивал. Внутри строки высотой lineH базовая линия Arial — на
    // (lineH − кегль)/2 + 0,905·кегль от её верха.
    const px = pt * (96 / 72);
    const rawH = editBoxRaw?.h ?? 24;
    const base = vt === 1 ? 2 + px : vt === 2 ? (rawH - lineH) / 2 + px : rawH - 4;
    // Не больше, чем помещается: иначе однострочное поле вырастало на пару пикселей вниз за пределы ячейки.
    const padTop = Math.max(0, Math.min(h - lineH, Math.round(base - (lineH - px) / 2 - 0.905 * px)));
    const css = editLook?.css || {};
    const viewW = (grid.current?.clientWidth ?? 800) / zoom;
    return {
      zoom, left: editBoxRaw?.x, top: editBoxRaw?.y,
      minWidth: (editBoxRaw?.w ?? 88) - 1, minHeight: h,
      maxWidth: Math.max((editBoxRaw?.w ?? 88) - 1, viewW - (editBoxRaw?.x ?? 0) - 4),
      fontFamily: css.fontFamily, fontSize: css.fontSize, fontWeight: css.fontWeight, fontStyle: css.fontStyle, textDecoration: css.textDecoration, color: css.color,
      background: css.background || undefined, textAlign: (editLook?.h as CSSProperties['textAlign']) || (typeof editCell?.v === 'number' && !edit.text.startsWith('=') ? 'right' : undefined),
      '--edit-line': `${lineH}px`, '--edit-pad-top': `${padTop}px`,
    } as CSSProperties;
  })();

  const btn = (key: string, title: string, active: boolean, icon: ReactNode, action: (e: React.MouseEvent<HTMLButtonElement>) => void, disabled = false) => (
    <button key={key} type="button" className="fdoc-btn" title={title} aria-label={title} aria-pressed={active} disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} onClick={action}>{icon}</button>
  );
  const open = (kind: string) => (e: React.MouseEvent<HTMLElement>) => { const trigger = e.currentTarget; setPop((p) => (p?.kind === kind ? null : { kind, at: trigger.getBoundingClientRect(), trigger })); };
  const close = () => setPop(null);
  const hAlign = Number(anchorStyle.ht) || 0;
  const vAlign = Number(anchorStyle.vt) || 0;
  // Размер по умолчанию — 10, как рисует сетка (и как у Google Таблиц).
  const fontSize = Number(anchorStyle.fs) || 10;
  const stepFont = (dir: number) => {
    const next = dir > 0 ? SIZES.find((n) => n > fontSize) ?? fontSize + 2 : [...SIZES].reverse().find((n) => n < fontSize) ?? Math.max(1, fontSize - 1);
    restyle((x) => ({ ...x, fs: next === 10 ? undefined : next }));
  };
  const nameBox = edit ? a1(edit.row, edit.col) : rangeA1(selRange);
  const anchorCell = cellAt(sheet, sel.anchor.row, sel.anchor.col);
  const barText = edit ? edit.text : editText(anchorCell, styleOf(b, anchorCell));

  const summary = summaryText;

  type BorderKind = 'all' | 'inner' | 'horizontal' | 'vertical' | 'outer' | 'left' | 'top' | 'right' | 'bottom' | 'none';
  const borderSet = (kind: BorderKind) => {
    const line = { s: borderStyle.s, cl: { rgb: borderStyle.color } };
    const cells: Record<number, Record<number, Cell | null>> = {};
    eachSelected((r, c) => {
      const prev = { ...(styleOf(b, cellAt(sheet, r, c)) || {}) } as Style;
      const bd: Record<string, unknown> = kind === 'none' ? {} : { ...((prev.bd as object) || {}) };
      if (kind === 'all') Object.assign(bd, { t: line, b: line, l: line, r: line });
      const top = r === selRange.startRow; const bottom = r === selRange.endRow; const left = c === selRange.startColumn; const right = c === selRange.endColumn;
      if (kind === 'outer') { if (top) bd.t = line; if (bottom) bd.b = line; if (left) bd.l = line; if (right) bd.r = line; }
      if (kind === 'inner' || kind === 'horizontal') { if (!top) bd.t = line; if (!bottom) bd.b = line; }
      if (kind === 'inner' || kind === 'vertical') { if (!left) bd.l = line; if (!right) bd.r = line; }
      if (kind === 'left' && left) bd.l = line;
      if (kind === 'right' && right) bd.r = line;
      if (kind === 'top' && top) bd.t = line;
      if (kind === 'bottom' && bottom) bd.b = line;
      const next = { ...prev, bd: Object.keys(bd).length ? bd : undefined };
      const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined));
      (cells[r] ||= {})[c] = { s: (Object.keys(clean).length ? clean : null) as Cell['s'] };
    });
    setCells(cells);
  };

  return (
    <div className="fsh" data-readonly={readOnly || undefined}>
      {!readOnly && (
        <div className="fdoc-bar-wrap">
          <div className="fdoc-bar fsh-bar" role="toolbar" aria-label="Оформление">
            {/* Порядок и значки — как у Google Таблиц; набор значков и вид кнопок — как у панели бета-документов. */}
            {btn('undo', 'Отменить (Ctrl+Z)', false, <OUndo size={18} />, () => undoStep(true), !undo.current.length)}
            {btn('redo', 'Повторить (Ctrl+Y)', false, <ORedo size={18} />, () => undoStep(false), !redo.current.length)}
            {btn('print', 'Печать (Ctrl+P)', false, <OPrint size={18} />, () => window.dispatchEvent(new Event('nx:print-item')))}
            {btn('paint', painter ? 'Копирование формата: выделите ячейки (Esc — отмена)' : 'Копировать форматирование', Boolean(painter), <OPaintFormat size={18} />, () => setPainter(painter ? null : { ...anchorStyle }))}
            <button type="button" className="fdoc-drop fdoc-drop-zoom" onMouseDown={(e) => e.preventDefault()} onClick={open('zoom')} aria-expanded={pop?.kind === 'zoom'} title="Масштаб (Ctrl+колесо)"><span>{Math.round(zoom * 100)}%</span><OChevronDown size={14} aria-hidden="true" /></button>
            <span className="fdoc-sep" />
            {btn('rub', 'Формат: рубли', false, <OCurrency size={18} />, () => setPattern('#,##0.00 "₽"'))}
            {btn('pct', 'Формат: проценты', false, <OPercent size={18} />, () => setPattern('0%'))}
            {btn('dec-', 'Уменьшить число знаков после запятой', false, <ODecimalDecrease size={18} />, () => stepDecimals(-1))}
            {btn('dec+', 'Увеличить число знаков после запятой', false, <ODecimalIncrease size={18} />, () => stepDecimals(1))}
            <button type="button" className="fdoc-drop" onMouseDown={(e) => e.preventDefault()} onClick={open('numfmt')} aria-expanded={pop?.kind === 'numfmt'} title="Другие форматы"><span>123</span><OChevronDown size={14} aria-hidden="true" /></button>
            <span className="fdoc-sep" />
            <button type="button" className="fdoc-drop fdoc-drop-font" onMouseDown={(e) => e.preventDefault()} onClick={open('font')} aria-expanded={pop?.kind === 'font'} title="Шрифт"><span style={{ fontFamily: String(anchorStyle.ff || 'Arial') }}>{String(anchorStyle.ff || 'Arial')}</span><OChevronDown size={14} aria-hidden="true" /></button>
            <span className="fdoc-sep" />
            <span className="fdoc-size" role="group" aria-label="Размер шрифта">
              {btn('sz-', 'Уменьшить размер шрифта', false, <OFontSizeMinus size={14} />, () => stepFont(-1))}
              <button type="button" className="fdoc-size-input fsh-size-btn" onMouseDown={(e) => e.preventDefault()} onClick={open('size')} aria-expanded={pop?.kind === 'size'} title="Размер шрифта">{fontSize}</button>
              {btn('sz+', 'Увеличить размер шрифта', false, <OFontSizePlus size={14} />, () => stepFont(1))}
            </span>
            <span className="fdoc-sep" />
            {btn('b', 'Полужирный (Ctrl+B)', Boolean(anchorStyle.bl), <OBold size={18} />, () => toggle('bl', 1))}
            {btn('i', 'Курсив (Ctrl+I)', Boolean(anchorStyle.it), <OItalic size={18} />, () => toggle('it', 1))}
            {btn('s', 'Зачёркнутый (Alt+Shift+5)', Boolean((anchorStyle.st as { s?: number } | undefined)?.s), <OStrikethrough size={18} />, () => restyle((s) => ({ ...s, st: anchorStyle.st ? undefined : { s: 1 } })))}
            <button type="button" className="fdoc-btn fdoc-color" title="Цвет текста" aria-label="Цвет текста" onMouseDown={(e) => e.preventDefault()} onClick={open('color')} aria-expanded={pop?.kind === 'color'}>
              <OTextColor size={18} style={{ '--swatch': (anchorStyle.cl as { rgb?: string } | undefined)?.rgb || 'currentColor' } as CSSProperties} />
            </button>
            <span className="fdoc-sep" />
            <button type="button" className="fdoc-btn fdoc-color" title="Цвет заливки" aria-label="Цвет заливки" onMouseDown={(e) => e.preventDefault()} onClick={open('fill')} aria-expanded={pop?.kind === 'fill'}>
              <OFillColor size={18} style={{ '--swatch': (anchorStyle.bg as { rgb?: string } | undefined)?.rgb || 'transparent' } as CSSProperties} />
            </button>
            <button type="button" className="fdoc-btn" title="Границы" aria-label="Границы" onMouseDown={(e) => e.preventDefault()} onClick={open('borders')} aria-expanded={pop?.kind === 'borders'}><OBorders size={18} /></button>
            {btn('merge', merged ? 'Отменить объединение' : 'Объединить ячейки', merged, <OMerge size={18} />, toggleMerge)}
            <span className="fdoc-sep" />
            <button type="button" className="fdoc-btn fdoc-btn-drop" title="Выравнивание по горизонтали" aria-label="Выравнивание по горизонтали" onMouseDown={(e) => e.preventDefault()} onClick={open('halign')} aria-expanded={pop?.kind === 'halign'}>
              {hAlign === 2 ? <OAlignCenter size={18} /> : hAlign === 3 ? <OAlignRight size={18} /> : <OAlignLeft size={18} />}<OChevronDown size={12} aria-hidden="true" />
            </button>
            <button type="button" className="fdoc-btn fdoc-btn-drop" title="Выравнивание по вертикали" aria-label="Выравнивание по вертикали" onMouseDown={(e) => e.preventDefault()} onClick={open('valign')} aria-expanded={pop?.kind === 'valign'}>
              {vAlign === 1 ? <OVAlignTop size={18} /> : vAlign === 2 ? <OVAlignMiddle size={18} /> : <OVAlignBottom size={18} />}<OChevronDown size={12} aria-hidden="true" />
            </button>
            <button type="button" className="fdoc-btn fdoc-btn-drop" title="Перенос текста" aria-label="Перенос текста" onMouseDown={(e) => e.preventDefault()} onClick={open('wrap')} aria-expanded={pop?.kind === 'wrap'}>
              <OWrap size={18} /><OChevronDown size={12} aria-hidden="true" />
            </button>
            <button type="button" className="fdoc-btn fdoc-btn-drop" title="Поворот текста" aria-label="Поворот текста" onMouseDown={(e) => e.preventDefault()} onClick={open('rotate')} aria-expanded={pop?.kind === 'rotate'}>
              <ORotate size={18} /><OChevronDown size={12} aria-hidden="true" />
            </button>
            <span className="fdoc-sep" />
            {btn('link', 'Вставить ссылку (Ctrl+K)', false, <OInsertLink size={18} />, () => commands['sheet.operation.insert-hyper-link-toolbar']())}
            {onAddComment && btn('comment', 'Комментарий (Ctrl+Alt+M)', false, <OComment size={18} />, () => onAddComment())}
            {btn('chart', 'Вставить диаграмму', false, <OChart size={18} />, insertChart)}
            <span className="fdoc-sep" />
            {(() => {
              // Кнопка «нажата», только если по столбцу выбранной ячейки фильтр что-то отсеивает: подсветка на любом
              // столбце листа с фильтром читалась как «здесь отфильтровано».
              const f = b ? readFilters(b)[sheetId] : undefined;
              const here = Boolean(f && sel.anchor.col >= f.ref.startColumn && sel.anchor.col <= f.ref.endColumn && (f.filterColumns || []).some((x) => x.colId === sel.anchor.col));
              return btn('filter', f ? 'Убрать фильтр' : 'Создать фильтр', here, <OFilter size={18} />, toggleFilter);
            })()}
            {btn('sum', 'Сумма (СУММ)', false, <OFunctions size={18} />, sumBelow)}
            <span className="fdoc-sep" />
            <button type="button" className="fdoc-btn" title="Ещё: закрепление, сортировка, условное форматирование…" aria-label="Ещё" onMouseDown={(e) => e.preventDefault()} onClick={open('more')} aria-expanded={pop?.kind === 'more'}><OMoreVertical size={18} /></button>
          </div>
        </div>
      )}

      <div className="fsh-formula">
        <input className="fsh-name" value={nameBox} aria-label="Адрес ячейки или диапазона" readOnly={Boolean(edit)}
          onChange={() => undefined}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            const named = b ? readNames(b)[e.currentTarget.value.trim()] : undefined;
            const r = parseRange((named ? named.slice(named.lastIndexOf('!') + 1).replace(/\$/g, '') : e.currentTarget.value).toUpperCase());
            if (!r) { showToast('Адрес вида A1, A1:C5 или имя диапазона', 'info'); return; }
            setSel({ anchor: { row: r.startRow, col: r.startColumn }, focus: { row: r.endRow, col: r.endColumn } });
            reveal(r.startRow, r.startColumn);
            grid.current?.focus();
          }}
          onFocus={(e) => e.currentTarget.select()} />
        <span className="fsh-fx" aria-hidden="true">fx</span>
        <input ref={barInput} className="fsh-bar-input" value={barText} readOnly={readOnly} aria-label="Содержимое ячейки"
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onFocus={() => { if (!edit && !readOnly) startEdit(undefined, true); }}
          onChange={(e) => setEdit((x) => (x ? { ...x, text: e.target.value, bar: true } : { row: sel.anchor.row, col: sel.anchor.col, text: e.target.value, bar: true }))}
          onKeyDown={onEditKey} />
      </div>

      {find.open && (
        <div className="fdoc-find-bar">
          <FindBar query={find.query} onQuery={(q) => setFind({ open: true, query: q, index: 0 })} count={findHits.length} index={find.index}
            onNext={() => goFind(find.index + 1)} onPrev={() => goFind(find.index - 1)} onClose={() => { setFind({ open: false, query: '', index: 0 }); grid.current?.focus(); }} focusToken={1}
            replace={readOnly ? undefined : replaceFind} replaceOpen={find.replace} />
        </div>
      )}

      <div className="fsh-gridwrap" ref={root}>
        <div ref={grid} className="fsh-grid" tabIndex={0} role="grid" aria-label={`Лист «${sheet.name}»`} aria-rowcount={rows} aria-colcount={cols}
          onScroll={(e) => { redraw(); placeLinkCard(); if (edit) { const el = e.currentTarget; setScroll({ x: el.scrollLeft, y: el.scrollTop }); } }}
          onMouseDown={onMouseDown} onMouseMove={onHover} onMouseLeave={() => { if (headHover.current) { headHover.current = null; redraw(); } }} onDoubleClick={onDoubleClick} onKeyDown={onKeyDown}
          onContextMenu={(e) => { if (e.shiftKey) return; e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}>
          <div className="fsh-sizer" style={{ width: (HEAD_W + colOffs[cols]) * zoom, height: (HEAD_H + rowOffs[rows]) * zoom }} />
        </div>
        {/* Холст — неподвижно поверх области прокрутки (не внутри неё): так он стоит ровно на пикселях экрана и не мылится. */}
        <canvas ref={canvas} className="fsh-canvas" aria-hidden="true" />
        {guide && <div className="fsh-guide" data-axis={guide.axis} style={guide.axis === 'x' ? { left: guide.at } : { top: guide.at }} />}
        {linkCard && (
          // Карточка ссылки под ячейкой, как в Google (общая с документами — LinkCard.tsx).
          <LinkCard cardRef={linkCardEl} url={linkCard.url} readOnly={readOnly}
            onEdit={() => setLinkEdit({ r: sel.anchor.row, c: sel.anchor.col, initial: linkCard.url })}
            onUnlink={() => unlinkCell(linkCard.r0, linkCard.c0, linkCard.rich)} />
        )}
        {edit && !edit.bar && editBoxRaw && (
          <div ref={editBoxEl} className="fsh-editbox" data-formula={edit.text.startsWith('=') || undefined} data-auto={autoSuffix ? '' : undefined}
            style={editBoxStyle}>
            {editMoved && <span className="fsh-edit-ref">{a1(edit.row, edit.col)}</span>}
            <div className="fsh-editmirror" aria-hidden="true">{autoSuffix ? <><span>{edit.text}</span><span className="fsh-ghost">{autoSuffix}</span></> : renderColored(edit.text, editRefs)}{'\u200b'}</div>
            <textarea ref={editor} className="fsh-editor" value={edit.text} spellCheck={false}
              onChange={(e) => { const grew = e.target.value.length > (edit?.text.length ?? 0); setEdit((x) => (x ? { ...x, text: e.target.value } : x)); setCaret(e.target.selectionStart); setSuggestOff(false); setSuggestAt(0); setAutoOff(!grew); }}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
              onKeyDown={onEditKey}
              onBlur={(e) => { if (!root.current?.contains(e.relatedTarget as Node) && !(e.relatedTarget as HTMLElement | null)?.closest('.fsh-formula')) finishEdit('stay'); }} />
            {(suggestions.length > 0 || hint) && (
              <div className="fsh-suggest" role="listbox" aria-label="Функции">
                {suggestions.map((f, i) => (
                  <button key={f.name} type="button" role="option" aria-selected={i === suggestAt} className="fsh-suggest-item"
                    onMouseDown={(ev) => ev.preventDefault()} onClick={() => acceptSuggestion(f.name)}>
                    <b>{f.name}</b>{f.about && <span>{f.about}</span>}
                  </button>
                ))}
                {suggestions.length > 0 && suggestions[Math.min(suggestAt, suggestions.length - 1)] && (
                  <div className="fsh-suggest-sig">{suggestions[Math.min(suggestAt, suggestions.length - 1)].signature}</div>
                )}
                {!suggestions.length && hint && <div className="fsh-suggest-sig">{hint}</div>}
              </div>
            )}
          </div>
        )}
        <input ref={imageInput} type="file" accept="image/*" multiple hidden onChange={(e) => { const f = [...(e.target.files || [])]; e.target.value = ''; void insertImages(f); }} />
        {noteTip && xs.notes?.[noteTip.key] && !noteEdit && (
          <div className="fsh-note" style={{ position: 'fixed', left: noteTip.x, top: noteTip.y }}>{xs.notes[noteTip.key]}</div>
        )}
        {noteEdit && geo && grid.current && (() => {
          const box = grid.current.getBoundingClientRect();
          const x = box.left + screenX2(geo, noteEdit.c, grid.current.scrollLeft / zoom) * zoom + 4;
          const y = box.top + screenY(geo, noteEdit.r, grid.current.scrollTop / zoom) * zoom;
          return (
            <textarea className="fsh-note fsh-note-edit" style={{ position: 'fixed', left: x, top: y }} autoFocus value={noteEdit.text} placeholder="Заметка"
              onChange={(e) => setNoteEdit({ ...noteEdit, text: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setNoteEdit(null); grid.current?.focus(); } if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.currentTarget.blur(); } }}
              onBlur={() => { const n = noteEdit; setNoteEdit(null); if ((xs.notes?.[`${n.r}:${n.c}`] || '') !== n.text) setNote(n.r, n.c, n.text); }} />
          );
        })()}
        {filterMenu && b && sheet && <FilterMenu {...filterMenu} book={b} sheet={sheet} onClose={() => setFilterMenu(null)} onApply={(col, criteria) => setFilterCriteria(col, criteria)} onSort={(desc, col) => sortBy(desc, col)} />}
        {panel === 'cf' && <CfPanel rules={xs.cf || []} selection={selRange} onChange={(next) => setExtra('cf', next.length ? next : null)} onClose={() => setPanel(null)} />}
        {panel === 'dv' && <DvPanel rules={xs.dv || []} selection={selRange} onChange={(next) => setExtra('dv', next.length ? next : null)} onClose={() => setPanel(null)} />}
        {panel === 'banding' && <BandingPanel list={xs.banding || []} selection={selRange} onChange={(next) => setExtra('banding', next.length ? next : null)} onClose={() => setPanel(null)} />}
        {panel === 'names' && b && sheet && <NamesPanel names={readNames(b)} sheetName={sheet.name} selection={selRange} onClose={() => setPanel(null)}
          onChange={(next) => commit([{ id: OP.NAMES, params: { names: next } }])}
          onGo={(ref) => { const bang = ref.lastIndexOf('!'); const nm = ref.slice(0, bang).replace(/^'(.*)'$/, '$1'); const target = Object.values(b.sheets).find((x) => x.name === nm); const r = parseRange(ref.slice(bang + 1).replace(/\$/g, '').toUpperCase()); if (target) setSheetId(target.id); if (r) { setSel({ anchor: { row: r.startRow, col: r.startColumn }, focus: { row: r.endRow, col: r.endColumn } }); window.requestAnimationFrame(() => reveal(r.startRow, r.startColumn)); } }} />}
        {panel === 'protect' && <ProtectPanel list={xs.protect || []} selection={selRange} onChange={(next) => setExtra('protect', next.length ? next : null)} onClose={() => setPanel(null)} />}
        {typeof panel === 'object' && panel?.chart && (() => {
          const o = (xs.objects || []).find((x) => x.id === panel.chart);
          if (!o?.chart) return null;
          return <ChartPanel key={o.id} spec={o.chart} onClose={() => setPanel(null)} onDelete={() => removeObject(o.id)}
            onChange={(spec) => setExtra('objects', (xs.objects || []).map((x) => (x.id === o.id ? { ...x, chart: spec } : x)))} />;
        })()}
      </div>

      {listMenu && (
        <Menu anchor={{ x: listMenu.x, y: listMenu.y }} label="Варианты" onClose={() => setListMenu(null)}>
          {listMenu.values.map((v) => <MenuItem key={v} onSelect={() => { setListMenu(null); writeInput(listMenu.r, listMenu.c, v); }}>{v}</MenuItem>)}
          {!listMenu.values.length && <MenuItem onSelect={() => { setListMenu(null); setPanel('dv'); }}>Добавить варианты…</MenuItem>}
        </Menu>
      )}
      {linkEdit && <DocLinkSheet initial={linkEdit.initial} onClose={() => setLinkEdit(null)} onApply={(url) => { setLink(linkEdit.r, linkEdit.c, url); setLinkEdit(null); grid.current?.focus(); }} />}

      <div className="fsh-tabs" role="tablist" aria-label="Листы">
        {!readOnly && <button type="button" className="fsh-tab-add" title="Добавить лист" aria-label="Добавить лист" onClick={addSheet}><Plus size={15} /></button>}
        <button type="button" className="fsh-tab-add" title="Все листы" aria-label="Все листы" onClick={(e) => setSheetsMenu({ x: e.clientX, y: e.clientY - 8 })}><ListIcon size={15} /></button>
        {b.sheetOrder.filter((id) => b.sheets[id] && !b.sheets[id].hidden).map((id) => (
          renaming === id ? (
            <input key={id} className="fsh-tab-input" defaultValue={b.sheets[id].name} autoFocus aria-label="Название листа"
              onBlur={(e) => { renameSheet(id, e.target.value); setRenaming(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null); }} />
          ) : (
            <button key={id} type="button" role="tab" className="fsh-tab" aria-selected={id === sheetId} draggable={!readOnly}
              onDragStart={(e) => { dragTab.current = id; e.dataTransfer.effectAllowed = 'move'; }}
              onDragOver={(e) => { if (dragTab.current && dragTab.current !== id) e.preventDefault(); }}
              onDrop={(e) => { e.preventDefault(); const from = dragTab.current; dragTab.current = null; if (!from || from === id || !b) return; commit([{ id: OP.SHEET_ORDER, params: { subUnitId: from, fromOrder: b.sheetOrder.indexOf(from), toOrder: b.sheetOrder.indexOf(id) } }]); }}
              style={b.sheets[id].tabColor ? ({ '--tab': b.sheets[id].tabColor } as CSSProperties) : undefined}
              onClick={() => { if (edit) finishEdit('stay'); setSheetId(id); setSel({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } }); grid.current?.scrollTo(0, 0); }}
              onDoubleClick={() => { if (!readOnly) setRenaming(id); }}
              onContextMenu={(e) => { e.preventDefault(); if (!readOnly) setTabMenu({ id, x: e.clientX, y: e.clientY }); }}>
              {b.sheets[id].name}
            </button>
          )
        ))}
        {summary && (() => {
          const shown = summary.find(([k]) => k === statKind) ?? summary[0];
          return (
            <button type="button" className="fsh-summary" onMouseDown={(e) => e.preventDefault()} onClick={open('stats')} aria-expanded={pop?.kind === 'stats'} title="Показатели выделения">
              {shown[1]}: {shown[2]}<OChevronDown size={12} aria-hidden="true" />
            </button>
          );
        })()}
      </div>

      {menu && (
        // Как контекстные меню iOS/macOS: на первой странице — частое (как у Google), редкое — на вложенных страницах.
        <Menu anchor={menu} label="Действия с ячейками" onClose={() => setMenu(null)}>
          {menuPage !== 'main' && <MenuItem icon={<ChevronLeft size={16} />} onSelect={() => setMenuPage('main')}><b>{({ paste: 'Специальная вставка', insert: 'Вставить ячейки', delete: 'Удалить ячейки', more: 'Ещё действия' } as Record<string, string>)[menuPage]}</b></MenuItem>}
          {menuPage !== 'main' && <div className="nx-menu-sep" />}
          {menuPage === 'main' && (
            <>
              {!readOnly && <MenuItem icon={<Scissors size={16} />} onSelect={() => { setMenu(null); copy(true, null); }}>Вырезать <kbd className="nx-menu-kbd">Ctrl+X</kbd></MenuItem>}
              <MenuItem icon={<Copy size={16} />} onSelect={() => { setMenu(null); copy(false, null); }}>Копировать <kbd className="nx-menu-kbd">Ctrl+C</kbd></MenuItem>
              {!readOnly && <MenuItem icon={<ClipboardPaste size={16} />} onSelect={() => { setMenu(null); commands['univer.command.paste'](); }}>Вставить <kbd className="nx-menu-kbd">Ctrl+V</kbd></MenuItem>}
              {!readOnly && <MenuItem icon={<ClipboardPaste size={16} />} onSelect={() => setMenuPage('paste')}>Специальная вставка<ChevronRight size={14} className="nx-menu-more" /></MenuItem>}
              {!readOnly && (
                <>
                  <div className="nx-menu-sep" />
                  <MenuItem icon={<ArrowUpToLine size={16} />} onSelect={() => { setMenu(null); insertRows(true); }}>Вставить строку выше</MenuItem>
                  <MenuItem icon={<ArrowLeftToLine size={16} />} onSelect={() => { setMenu(null); insertCols(true); }}>Вставить столбец слева</MenuItem>
                  <MenuItem icon={<PlusIcon size={16} />} onSelect={() => setMenuPage('insert')}>Вставить ячейки<ChevronRight size={14} className="nx-menu-more" /></MenuItem>
                  <div className="nx-menu-sep" />
                  <MenuItem icon={<Trash2 size={16} />} onSelect={() => { setMenu(null); removeRows(); }}>Удалить {selRange.endRow > selRange.startRow ? 'строки' : 'строку'}</MenuItem>
                  <MenuItem icon={<Columns2 size={16} />} onSelect={() => { setMenu(null); removeCols(); }}>Удалить {selRange.endColumn > selRange.startColumn ? 'столбцы' : 'столбец'}</MenuItem>
                  <MenuItem icon={<Trash2 size={16} />} onSelect={() => setMenuPage('delete')}>Удалить ячейки<ChevronRight size={14} className="nx-menu-more" /></MenuItem>
                  <div className="nx-menu-sep" />
                  <MenuItem icon={<Link2 size={16} />} onSelect={() => { setMenu(null); commands['sheet.operation.insert-hyper-link-toolbar'](); }}>Вставить ссылку <kbd className="nx-menu-kbd">Ctrl+K</kbd></MenuItem>
                  <MenuItem icon={<NotebookPen size={16} />} onSelect={() => { setMenu(null); setNoteEdit({ r: sel.anchor.row, c: sel.anchor.col, text: xs.notes?.[`${sel.anchor.row}:${sel.anchor.col}`] || '' }); }}>{xs.notes?.[`${sel.anchor.row}:${sel.anchor.col}`] ? 'Изменить заметку' : 'Вставить заметку'} <kbd className="nx-menu-kbd">Shift+F2</kbd></MenuItem>
                </>
              )}
              {onAddComment && <MenuItem icon={<MessageSquarePlus size={16} />} onSelect={() => { setMenu(null); onAddComment(); }}>Комментарий <kbd className="nx-menu-kbd">Ctrl+Alt+M</kbd></MenuItem>}
              {!readOnly && (
                <>
                  <div className="nx-menu-sep" />
                  <MenuItem icon={<MoreHorizontal size={16} />} onSelect={() => setMenuPage('more')}>Ещё действия<ChevronRight size={14} className="nx-menu-more" /></MenuItem>
                </>
              )}
            </>
          )}
          {menuPage === 'paste' && (
            <>
              <MenuItem icon={<ClipboardPaste size={16} />} onSelect={() => { setMenu(null); commands['sheet.command.paste-value'](); }}>Вставить только значения <kbd className="nx-menu-kbd">Ctrl+Shift+V</kbd></MenuItem>
              {clip.current && <MenuItem icon={<ClipboardPaste size={16} />} onSelect={() => { setMenu(null); commands['sheet.command.paste-format'](); }}>Вставить только формат</MenuItem>}
              {clip.current && <MenuItem icon={<ClipboardPaste size={16} />} onSelect={() => { setMenu(null); paste(clip.current!.tsv, 'transpose'); }}>Вставить транспонированно</MenuItem>}
            </>
          )}
          {menuPage === 'insert' && (
            <>
              <MenuItem icon={<ArrowDownToLine size={16} />} onSelect={() => { setMenu(null); insertRows(false); }}>Вставить строку ниже</MenuItem>
              <MenuItem icon={<ArrowRightToLine size={16} />} onSelect={() => { setMenu(null); insertCols(false); }}>Вставить столбец справа</MenuItem>
              <MenuItem icon={<ArrowRightToLine size={16} />} onSelect={() => { setMenu(null); shiftCells('right'); }}>Вставить ячейки со сдвигом вправо</MenuItem>
              <MenuItem icon={<ArrowDownToLine size={16} />} onSelect={() => { setMenu(null); shiftCells('down'); }}>Вставить ячейки со сдвигом вниз</MenuItem>
            </>
          )}
          {menuPage === 'delete' && (
            <>
              <MenuItem icon={<Trash2 size={16} />} onSelect={() => { setMenu(null); shiftCells('left'); }}>Удалить ячейки со сдвигом влево</MenuItem>
              <MenuItem icon={<Trash2 size={16} />} onSelect={() => { setMenu(null); shiftCells('up'); }}>Удалить ячейки со сдвигом вверх</MenuItem>
              <MenuItem icon={<Eraser size={16} />} onSelect={() => { setMenu(null); clearValues(); }}>Очистить содержимое <kbd className="nx-menu-kbd">Del</kbd></MenuItem>
            </>
          )}
          {menuPage === 'more' && (
            <>
              <MenuItem icon={<EyeOff size={16} />} onSelect={() => { setMenu(null); setHidden(false, true); }}>Скрыть {selRange.endRow > selRange.startRow ? `строки ${selRange.startRow + 1}–${selRange.endRow + 1}` : `строку ${selRange.startRow + 1}`}</MenuItem>
              <MenuItem icon={<EyeOff size={16} />} onSelect={() => { setMenu(null); setHidden(true, true); }}>Скрыть {selRange.endColumn > selRange.startColumn ? `столбцы ${colName(selRange.startColumn)}–${colName(selRange.endColumn)}` : `столбец ${colName(selRange.startColumn)}`}</MenuItem>
              {hasHidden(false) && <MenuItem icon={<Eye size={16} />} onSelect={() => { setMenu(null); setHidden(false, false); }}>Показать скрытые строки</MenuItem>}
              {hasHidden(true) && <MenuItem icon={<Eye size={16} />} onSelect={() => { setMenu(null); setHidden(true, false); }}>Показать скрытые столбцы</MenuItem>}
              <div className="nx-menu-sep" />
              <MenuItem icon={<ArrowDownAZ size={16} />} onSelect={() => { setMenu(null); sortBy(false); }}>Сортировать А → Я</MenuItem>
              <MenuItem icon={<ArrowUpZA size={16} />} onSelect={() => { setMenu(null); sortBy(true); }}>Сортировать Я → А</MenuItem>
              <MenuItem icon={<Filter size={16} />} onSelect={() => { setMenu(null); toggleFilter(); }}>{b && readFilters(b)[sheetId] ? 'Убрать фильтр' : 'Создать фильтр'}</MenuItem>
              <div className="nx-menu-sep" />
              <MenuItem icon={<ListChecks size={16} />} onSelect={() => { setMenu(null); setPanel('dv'); }}>Проверка данных…</MenuItem>
              <MenuItem icon={<PaletteIcon size={16} />} onSelect={() => { setMenu(null); setPanel('cf'); }}>Условное форматирование…</MenuItem>
              <MenuItem icon={<Lock size={16} />} onSelect={() => { setMenu(null); setPanel('protect'); }}>Защитить диапазон…</MenuItem>
              <MenuItem icon={<Brackets size={16} />} onSelect={() => { setMenu(null); setPanel('names'); }}>Именованные диапазоны…</MenuItem>
              <div className="nx-menu-sep" />
              <MenuItem icon={<GroupIcon size={16} />} onSelect={() => { setMenu(null); groupSel(true, true); }}>Сгруппировать строки {selRange.startRow + 1}–{selRange.endRow + 1}</MenuItem>
              {(xs.groups?.rows || []).some((g0) => g0.start <= selRange.endRow && selRange.startRow <= g0.end) && <MenuItem icon={<Ungroup size={16} />} onSelect={() => { setMenu(null); groupSel(true, false); }}>Разгруппировать строки</MenuItem>}
              <MenuItem icon={<ChevronsDownUp size={16} />} onSelect={() => { setMenu(null); groupSel(false, true); }}>Сгруппировать столбцы {colName(selRange.startColumn)}–{colName(selRange.endColumn)}</MenuItem>
              {(xs.groups?.cols || []).some((g0) => g0.start <= selRange.endColumn && selRange.startColumn <= g0.end) && <MenuItem icon={<Ungroup size={16} />} onSelect={() => { setMenu(null); groupSel(false, false); }}>Разгруппировать столбцы</MenuItem>}
              <div className="nx-menu-sep" />
              <MenuItem icon={<SplitIcon size={16} />} onSelect={() => { setMenu(null); splitText(); }}>Разделить текст на столбцы</MenuItem>
              <MenuItem icon={<CopyMinus size={16} />} onSelect={() => { setMenu(null); removeDuplicates(); }}>Удалить повторы</MenuItem>
              <MenuItem icon={<Space size={16} />} onSelect={() => { setMenu(null); trimSpaces(); }}>Удалить лишние пробелы</MenuItem>
              <MenuItem icon={<Shuffle size={16} />} onSelect={() => { setMenu(null); shuffleRows(); }}>Перемешать строки</MenuItem>
              <MenuItem icon={merged ? <TableCellsSplit size={16} /> : <TableCellsMerge size={16} />} onSelect={() => { setMenu(null); toggleMerge(); }}>{merged ? 'Отменить объединение' : 'Объединить ячейки'}</MenuItem>
            </>
          )}
        </Menu>
      )}
      {sheetsMenu && b && (
        <Menu anchor={{ x: sheetsMenu.x, y: sheetsMenu.y }} label="Все листы" onClose={() => setSheetsMenu(null)}>
          {b.sheetOrder.filter((id) => b.sheets[id]).map((id) => (
            <MenuItem key={id} icon={b.sheets[id].hidden ? <EyeOff size={16} /> : id === sheetId ? <Eye size={16} /> : <span className="ntd-menu-gap" />}
              onSelect={() => { setSheetsMenu(null); if (b.sheets[id].hidden) { if (!readOnly) setSheetHidden(id, false); } else { setSheetId(id); grid.current?.scrollTo(0, 0); } }}>
              {b.sheets[id].name}{b.sheets[id].hidden ? ' (скрыт — показать)' : ''}
            </MenuItem>
          ))}
        </Menu>
      )}
      {shortcuts && (
        <Dialog title="Быстрые клавиши" onClose={() => setShortcuts(false)}>
          <div className="fsh-shortcuts">
            {SHEET_SHORTCUTS.map(([k, v]) => <div key={k} className="fsh-shortcut"><kbd>{k}</kbd><span>{v}</span></div>)}
          </div>
        </Dialog>
      )}
      {tabMenu && (
        <Menu anchor={{ x: tabMenu.x, y: tabMenu.y }} label="Лист" onClose={() => setTabMenu(null)}>
          <MenuItem onSelect={() => { setRenaming(tabMenu.id); setTabMenu(null); }}>Переименовать</MenuItem>
          <MenuItem icon={<CopyPlus size={16} />} onSelect={() => { duplicateSheet(tabMenu.id); setTabMenu(null); }}>Создать копию</MenuItem>
          <MenuItem icon={<ArrowLeft size={16} />} onSelect={() => { moveSheet(tabMenu.id, -1); setTabMenu(null); }}>Переместить влево</MenuItem>
          <MenuItem icon={<ArrowRight size={16} />} onSelect={() => { moveSheet(tabMenu.id, 1); setTabMenu(null); }}>Переместить вправо</MenuItem>
          <MenuItem icon={<EyeOff size={16} />} onSelect={() => { setSheetHidden(tabMenu.id, true); setTabMenu(null); }}>Скрыть лист</MenuItem>
          <div className="nx-menu-label"><Tag size={13} /> Цвет ярлыка</div>
          <div className="fsh-tab-colors">
            {['', '#ea4335', '#ff6d01', '#fbbc04', '#34a853', '#46bdc6', '#4285f4', '#9334e6', '#9aa0a6'].map((c) => (
              <button key={c || 'none'} type="button" className="fsh-swatch" style={{ background: c || 'transparent' }} title={c ? c : 'Без цвета'}
                onClick={() => { commit([{ id: OP.TAB_COLOR, params: { subUnitId: tabMenu.id, color: c } }]); setTabMenu(null); }} />
            ))}
          </div>
          <MenuItem tone="danger" icon={<Trash2 size={16} />} onSelect={() => { removeSheet(tabMenu.id); setTabMenu(null); }}>Удалить лист</MenuItem>
        </Menu>
      )}

      {pop?.kind === 'color' && (
        <Pop anchor={pop.at} trigger={pop.trigger} onClose={close}>
          <Palette current={(anchorStyle.cl as { rgb?: string } | undefined)?.rgb || ''} resetLabel="Цвет по умолчанию" ResetIcon={OTextColor}
            onReset={() => { restyle((s) => ({ ...s, cl: undefined })); close(); }} onPick={(c) => { restyle((s) => ({ ...s, cl: { rgb: c } })); close(); }} />
        </Pop>
      )}
      {pop?.kind === 'fill' && (
        <Pop anchor={pop.at} trigger={pop.trigger} onClose={close}>
          <Palette current={(anchorStyle.bg as { rgb?: string } | undefined)?.rgb || ''} resetLabel="Без заливки" ResetIcon={OClearFormat}
            onReset={() => { restyle((s) => ({ ...s, bg: undefined })); close(); }} onPick={(c) => { restyle((s) => ({ ...s, bg: { rgb: c } })); close(); }} />
        </Pop>
      )}
      {pop?.kind === 'wrap' && (
        <Pop anchor={pop.at} trigger={pop.trigger} onClose={close} className="fdoc-pop-list">
          {([['Переливать в соседние', undefined], ['Переносить по словам', 3], ['Обрезать', 2]] as Array<[string, number | undefined]>).map(([label, v]) => (
            <button key={label} type="button" className="fdoc-pop-item" aria-selected={(anchorStyle.tb === 3 || anchorStyle.tb === 2 ? anchorStyle.tb : undefined) === v} onClick={() => { restyle((x) => ({ ...x, tb: v })); close(); }}>{label}</button>
          ))}
        </Pop>
      )}
      {pop?.kind === 'zoom' && (
        <Pop anchor={pop.at} trigger={pop.trigger} onClose={close} className="fdoc-pop-list fdoc-pop-sizes">
          {[0.5, 0.75, 0.9, 1, 1.25, 1.5, 2].map((z) => <button key={z} type="button" className="fdoc-pop-item" aria-selected={zoom === z} onClick={() => { setZoom(z); close(); }}>{Math.round(z * 100)}%</button>)}
        </Pop>
      )}
      {pop?.kind === 'rotate' && (
        <Pop anchor={pop.at} trigger={pop.trigger} onClose={close} className="fdoc-pop-list">
          {([['Без поворота', 0], ['Наклон вверх (45°)', 45], ['Наклон вниз (−45°)', -45], ['Повернуть вверх (90°)', 90], ['Повернуть вниз (−90°)', -90]] as Array<[string, number]>).map(([label, a]) => (
            <button key={label} type="button" className="fdoc-pop-item" aria-selected={(Number((anchorStyle.tr as { a?: number } | undefined)?.a) || 0) === a} onClick={() => { restyle((x) => ({ ...x, tr: a ? { a } : undefined })); close(); }}>{label}</button>
          ))}
        </Pop>
      )}
      {pop?.kind === 'font' && (
        <Pop anchor={pop.at} trigger={pop.trigger} onClose={close} className="fdoc-pop-list">
          <button type="button" className="fdoc-pop-item" aria-selected={!anchorStyle.ff} onClick={() => { restyle((x) => ({ ...x, ff: undefined })); close(); }}>По умолчанию</button>
          {FONTS.map((f) => <button key={f} type="button" className="fdoc-pop-item" aria-selected={anchorStyle.ff === f} style={{ fontFamily: f }} onClick={() => { restyle((x) => ({ ...x, ff: f })); close(); }}>{f}</button>)}
        </Pop>
      )}
      {pop?.kind === 'size' && (
        <Pop anchor={pop.at} trigger={pop.trigger} onClose={close} className="fdoc-pop-list fdoc-pop-sizes">
          {SIZES.map((n) => <button key={n} type="button" className="fdoc-pop-item" aria-selected={fontSize === n} onClick={() => { restyle((s) => ({ ...s, fs: n === 10 ? undefined : n })); close(); }}>{n}</button>)}
        </Pop>
      )}
      {pop?.kind === 'numfmt' && (
        <Pop anchor={pop.at} trigger={pop.trigger} onClose={close} className="fdoc-pop-list">
          {([['Автоматический', null], ['Число  1 234,56', '#,##0.00'], ['Целое  1 234', '#,##0'], ['Процент  12,5%', '0.0%'], ['Рубли  1 234,56 ₽', '#,##0.00 "₽"'],
            ['Дата  25.11.2026', 'dd.mm.yyyy'], ['Дата и время', 'dd.mm.yyyy hh:mm'], ['Время  14:30', 'hh:mm'], ['Дата словами', 'd mmmm yyyy'], ['Текст', '@']] as Array<[string, string | null]>).map(([label, pattern]) => (
            <button key={label} type="button" className="fdoc-pop-item" onClick={() => { setPattern(pattern); close(); }}>{label}</button>
          ))}
          <div className="fdoc-pop-sep" />
          <div className="fsh-fmt-custom">
            <input value={customFmt} placeholder={'Свой формат, например 0.0 "кг"'} aria-label="Свой формат чисел"
              onChange={(e) => setCustomFmt(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && customFmt.trim()) { setPattern(customFmt.trim()); close(); } }} />
            <span className="fsh-fmt-preview">{customFmt.trim() ? (() => { try { return displayText({ v: 1234.5678 } as Cell, { n: { pattern: customFmt.trim() } } as Style); } catch { return '—'; } })() : ''}</span>
            <button type="button" className="nx-primary" disabled={!customFmt.trim()} onClick={() => { setPattern(customFmt.trim()); close(); }}>Применить</button>
          </div>
        </Pop>
      )}
      {pop?.kind === 'borders' && (
        <Pop anchor={pop.at} trigger={pop.trigger} onClose={close} className="fdoc-pop-list">
          <div className="fsh-borders">
            {([['all', 'Все границы', <Grid2x2 key="a" size={16} />], ['inner', 'Внутренние', <PlusIcon key="b" size={16} />], ['horizontal', 'Горизонтальные внутри', <Rows3 key="c" size={16} />],
              ['vertical', 'Вертикальные внутри', <Columns3 key="d" size={16} />], ['outer', 'Внешние', <Square key="e" size={16} />], ['left', 'Слева', <PanelLeft key="f" size={16} />],
              ['top', 'Сверху', <PanelTop key="g" size={16} />], ['right', 'Справа', <PanelRight key="h" size={16} />], ['bottom', 'Снизу', <PanelBottom key="i" size={16} />],
              ['none', 'Без границ', <Eraser key="j" size={16} />]] as Array<[BorderKind, string, ReactNode]>).map(([k, label, icon]) => (
              <button key={k} type="button" className="fdoc-btn" title={label} aria-label={label} onClick={() => { borderSet(k); close(); }}>{icon}</button>
            ))}
          </div>
          <div className="fsh-borders-opts">
            <label title="Цвет границы"><input type="color" value={borderStyle.color} onChange={(e) => setBorderStyle({ ...borderStyle, color: e.target.value })} /></label>
            <select value={borderStyle.s} aria-label="Стиль границы" onChange={(e) => setBorderStyle({ ...borderStyle, s: Number(e.target.value) })}>
              <option value={1}>Тонкая</option><option value={8}>Средняя</option><option value={13}>Толстая</option>
              <option value={4}>Пунктир</option><option value={3}>Точки</option><option value={7}>Двойная</option>
            </select>
          </div>
        </Pop>
      )}
      {pop?.kind === 'stats' && summary && (
        <Pop anchor={pop.at} trigger={pop.trigger} onClose={close} className="fdoc-pop-list fsh-stats-pop">
          {summary.map(([k, label, value]) => (
            <button key={k} type="button" className="fdoc-pop-item fsh-stat" aria-selected={(summary.find(([x]) => x === statKind) ?? summary[0])[0] === k}
              onClick={() => { setStatKind(k); try { localStorage.setItem('fsh:stat', k); } catch { /* без памяти */ } close(); }}>
              <span>{label}</span><b>{value}</b>
            </button>
          ))}
        </Pop>
      )}
      {pop?.kind === 'halign' && (
        <Pop anchor={pop.at} trigger={pop.trigger} onClose={close} className="fdoc-pop-row">
          {([[1, 'По левому краю (Ctrl+Shift+L)', <OAlignLeft key="l" size={18} />], [2, 'По центру (Ctrl+Shift+E)', <OAlignCenter key="c" size={18} />], [3, 'По правому краю (Ctrl+Shift+R)', <OAlignRight key="r" size={18} />]] as Array<[number, string, ReactNode]>).map(([v, label, icon]) => (
            <button key={v} type="button" className="fdoc-btn" title={label} aria-label={label} aria-pressed={hAlign === v} onClick={() => { restyle((x) => ({ ...x, ht: hAlign === v ? undefined : v })); close(); }}>{icon}</button>
          ))}
        </Pop>
      )}
      {pop?.kind === 'valign' && (
        <Pop anchor={pop.at} trigger={pop.trigger} onClose={close} className="fdoc-pop-row">
          {([[1, 'По верхнему краю', <OVAlignTop key="t" size={18} />], [2, 'По середине', <OVAlignMiddle key="m" size={18} />], [3, 'По нижнему краю', <OVAlignBottom key="b" size={18} />]] as Array<[number, string, ReactNode]>).map(([v, label, icon]) => (
            <button key={v} type="button" className="fdoc-btn" title={label} aria-label={label} aria-pressed={(vAlign || 3) === v} onClick={() => { restyle((x) => ({ ...x, vt: v === 3 ? undefined : v })); close(); }}>{icon}</button>
          ))}
        </Pop>
      )}
      {pop?.kind === 'more' && (
        <Pop anchor={pop.at} trigger={pop.trigger} onClose={close} className="fdoc-pop-list">
          <button type="button" className="fdoc-pop-item" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setPop({ kind: 'freeze', at: r, trigger: pop.trigger }); }}>Закрепить…</button>
          <button type="button" className="fdoc-pop-item" onClick={() => { sortBy(false); close(); }}>Сортировать А → Я</button>
          <button type="button" className="fdoc-pop-item" onClick={() => { sortBy(true); close(); }}>Сортировать Я → А</button>
          <button type="button" className="fdoc-pop-item" onClick={() => { setPanel('cf'); close(); }}>Условное форматирование</button>
          <button type="button" className="fdoc-pop-item" onClick={() => { setPanel('banding'); close(); }}>Чередование цветов</button>
          <button type="button" className="fdoc-pop-item" onClick={() => { insertCheckbox(); close(); }}>Флажок</button>
          <button type="button" className="fdoc-pop-item" onClick={() => { imageInput.current?.click(); close(); }}>Изображение поверх ячеек</button>
          <button type="button" className="fdoc-pop-item" onClick={() => { restyle((s) => ({ ...s, ul: anchorStyle.ul ? undefined : { s: 1 } })); close(); }}>Подчёркнутый (Ctrl+U)</button>
          <button type="button" className="fdoc-pop-item" onClick={() => { restyle(() => ({} as Style)); close(); }}>Очистить форматирование (Ctrl+\)</button>
        </Pop>
      )}
      {pop?.kind === 'freeze' && (
        <Pop anchor={pop.at} trigger={pop.trigger} onClose={close} className="fdoc-pop-list">
          <button type="button" className="fdoc-pop-item" onClick={() => { freezeHere('rows'); close(); }}>Закрепить строки до {sel.anchor.row + 1}</button>
          <button type="button" className="fdoc-pop-item" onClick={() => { freezeHere('cols'); close(); }}>Закрепить столбцы до {colName(sel.anchor.col)}</button>
          <button type="button" className="fdoc-pop-item" disabled={!sheet.freeze} onClick={() => { freezeHere('none'); close(); }}>Снять закрепление</button>
        </Pop>
      )}
    </div>
  );
}
