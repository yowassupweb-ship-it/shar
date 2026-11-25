import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  AlignVerticalJustifyCenter, ArrowDownAZ, ArrowUpZA, Filter, AlignVerticalJustifyEnd, AlignVerticalJustifyStart, ArrowDownToLine, ArrowLeftToLine, ArrowRightToLine, ArrowUpToLine,
  ClipboardPaste, Columns2, Copy, Eraser, Grid2x2, MessageSquarePlus, Percent, Plus, RussianRuble, Scissors, Sigma, Snowflake, Square, TableCellsMerge,
  TableCellsSplit, Trash2, WrapText,
} from 'lucide-react';
import type { Workbook as ExcelWorkbook } from 'exceljs';
import {
  OAlignCenter, OAlignLeft, OAlignRight, OBold, OChevronDown, OClearFormat, OHighlightColor, OItalic, ORedo, OStrikethrough, OTextColor, OUnderline, OUndo,
} from '@/shared/ui/OfficeIcons';
import { Menu, MenuItem } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import { applySnapshot, bookFromBase64, bookToBase64, excelToUniver } from '../lib/workbook';
import type { LiveOp } from '../live/channel';
import { recalc, shiftFormula } from '../sheet/formulas';
import {
  a1, cellAt, colName, colWidth, displayText, editText, HEAD_H, HEAD_W, indexAt, inRange, mergeIndex, norm, offsets, parseA1, parseInput, parseRange,
  rangeA1, rowHeight, styleOf, Styles, usedBounds, type Book, type Cell, type Pos, type Range, type Sheet, type Style,
} from '../sheet/model';
import { applyOp, inverseOf, OP, wireCell } from '../sheet/ops';
import { drawSheet, readTheme, screenX, screenY } from '../sheet/draw';
import { dataRegion, filteredRows, readFilters, type FilterColumn } from '../sheet/filter';
import { Palette, Pop } from './FastDocToolbar';
import { FindBar } from './FindBar';
import { FilterMenu } from './SheetFilterMenu';
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

export default function FastSheetEditor({ content, onContent, readOnly, loadKey, cursors = [], onCursor, live, commentsBridge, commentCells = NO_CELLS, onAddComment, onCommentCell }: EditorProps) {
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  const book = useRef<Book | null>(null);
  const excel = useRef<ExcelWorkbook | null>(null);
  const styles = useRef<Styles | null>(null);
  const [error, setError] = useState('');
  const [sheetId, setSheetId] = useState('');
  const [sel, setSel] = useState<Sel>({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } });
  const [edit, setEdit] = useState<Edit | null>(null);
  const [scroll, setScroll] = useState({ x: 0, y: 0 });
  const [view, setView] = useState({ w: 800, h: 600 });
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [pop, setPop] = useState<{ kind: string; at: DOMRect; trigger: HTMLElement } | null>(null);
  const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [find, setFind] = useState<{ open: boolean; query: string; index: number }>({ open: false, query: '', index: 0 });
  const [clipMark, setClipMark] = useState<Range | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const undo = useRef<Step[]>([]);
  const redo = useRef<Step[]>([]);
  const clip = useRef<Clip | null>(null);
  const liveRef = useRef<{ local: (ops: LiveOp[]) => void } | null>(null);
  const unknownWarned = useRef(false);
  const saveTimer = useRef(0);
  const onContentRef = useRef(onContent);
  onContentRef.current = onContent;
  const contentRef = useRef(content);
  contentRef.current = content;

  // ── Открытие: xlsx → книга ExcelJS → снимок (модель). Заново — при смене loadKey (перечитали с сервера). ──
  useEffect(() => {
    let alive = true;
    setError('');
    bookFromBase64(contentRef.current).then((wb) => {
      if (!alive) return;
      const snap = excelToUniver(wb) as unknown as Book;
      excel.current = wb;
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
    const lx = clientX - box.left; const ly = clientY - box.top;
    const sx = lx - HEAD_W; const sy = ly - HEAD_H;
    const col = sx < 0 ? -1 : indexAt(geo.colOffs, sx < geo.fw ? sx : sx + el.scrollLeft);
    const row = sy < 0 ? -1 : indexAt(geo.rowOffs, sy < geo.fh ? sy : sy + el.scrollTop);
    return { row: Math.min(row, geo.rows - 1), col: Math.min(col, geo.cols - 1), lx, ly, sx, sy };
  }, [geo]);

  /** Прокрутить так, чтобы ячейка была видна. */
  const reveal = useCallback((r: number, c: number) => {
    const el = grid.current;
    if (!el || !geo) return;
    if (c >= geo.fc) {
      const left = geo.colOffs[c] - geo.fw; const right = geo.colOffs[c + 1];
      const viewW = el.clientWidth - HEAD_W;
      if (left < el.scrollLeft) el.scrollLeft = left;
      else if (right > el.scrollLeft + viewW) el.scrollLeft = right - viewW;
    }
    if (r >= geo.fr) {
      const top = geo.rowOffs[r] - geo.fh; const bottom = geo.rowOffs[r + 1];
      const viewH = el.clientHeight - HEAD_H;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (bottom > el.scrollTop + viewH) el.scrollTop = bottom - viewH;
    }
  }, [geo]);

  // ── Правки ячеек ──
  const setCells = useCallback((cells: Record<number, Record<number, Cell | null>>, sid = sheetId) => {
    if (Object.keys(cells).length) commit([{ id: OP.VALUES, params: { subUnitId: sid, cellValue: cells } }]);
  }, [commit, sheetId]);

  /** Ввод в ячейку: значение, формула, формат числа из ввода (процент, дата). */
  const writeInput = useCallback((r: number, c: number, text: string) => {
    if (!b || !sheet) return;
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

  const paste = useCallback((text: string, only?: 'values' | 'format') => {
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
    if (only === 'format') return;
    const rows = parseTsv(text);
    rows.forEach((line, i) => line.forEach((value, j) => {
      const parsed = parseInput(value);
      (cells[at.startRow + i] ||= {})[at.startColumn + j] = { v: parsed.v ?? null, f: parsed.f ?? null, t: parsed.t ?? null } as Cell;
    }));
    setCells(cells);
    setSel({ anchor: { row: at.startRow, col: at.startColumn }, focus: { row: at.startRow + rows.length - 1, col: at.startColumn + Math.max(...rows.map((r) => r.length)) - 1 } });
  }, [b, sheet, selRange, sheetId, commit, setCells]);

  useEffect(() => {
    const focused = () => document.activeElement === grid.current;
    const onCopy = (e: ClipboardEvent) => { if (!focused()) return; e.preventDefault(); copy(false, e.clipboardData); };
    const onCut = (e: ClipboardEvent) => { if (!focused() || readOnly) return; e.preventDefault(); copy(true, e.clipboardData); };
    const onPaste = (e: ClipboardEvent) => { if (!focused() || readOnly) return; e.preventDefault(); paste(e.clipboardData?.getData('text/plain') || ''); };
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

  const finishEdit = (how: 'down' | 'up' | 'right' | 'left' | 'stay' | 'cancel') => {
    const e = edit;
    setEdit(null);
    grid.current?.focus({ preventScroll: true });
    if (!e || how === 'cancel') return;
    const cell = sheet ? cellAt(sheet, e.row, e.col) : undefined;
    if (e.text !== editText(cell, b ? styleOf(b, cell) : null)) writeInput(e.row, e.col, e.text);
    if (how === 'down') move(1, 0); else if (how === 'up') move(-1, 0); else if (how === 'right') move(0, 1); else if (how === 'left') move(0, -1);
  };

  // Ссылки в формулу мышью: в правке формулы щелчок по ячейке вставляет её адрес.
  const insertRef = (text: string) => {
    setEdit((e) => (e ? { ...e, text: e.text + text } : e));
    window.requestAnimationFrame(() => { const el = editor.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
  };

  // ── Мышь: всё по координатам холста — ручки размера на границах заголовков, квадратик автозаполнения, стрелки фильтра ──
  type Drag = { kind: 'cells' | 'rows' | 'cols' | 'resize-col' | 'resize-row' | 'fill'; index?: number; start?: number; size?: number };
  const drag = useRef<Drag | null>(null);
  const [guide, setGuide] = useState<{ axis: 'x' | 'y'; at: number } | null>(null);
  const [fillTo, setFillTo] = useState<Range | null>(null);
  const [filterMenu, setFilterMenu] = useState<{ col: number; x: number; y: number } | null>(null);

  /** Что под курсором: граница столбца/строки в заголовке (для изменения размера), квадратик заполнения, стрелка фильтра. */
  const handleAt = useCallback((clientX: number, clientY: number): { kind: 'resize-col' | 'resize-row' | 'fill' | 'filter'; index: number } | null => {
    const el = grid.current;
    if (!el || !geo) return null;
    const box = el.getBoundingClientRect();
    const lx = clientX - box.left; const ly = clientY - box.top;
    const sx = el.scrollLeft; const sy = el.scrollTop;
    if (ly >= 0 && ly < HEAD_H && lx > HEAD_W) {
      const h0 = hit(clientX, clientY);
      if (h0 && h0.col >= 0) {
        const right = screenX(geo, h0.col + 1, sx); const left = screenX(geo, h0.col, sx);
        if (Math.abs(lx - right) <= 4) return { kind: 'resize-col', index: h0.col };
        if (Math.abs(lx - left) <= 4 && h0.col > 0) return { kind: 'resize-col', index: h0.col - 1 };
        const f = b ? readFilters(b)[sheetId] : undefined;
        if (f && h0.col >= f.ref.startColumn && h0.col <= f.ref.endColumn && lx > right - 24) return { kind: 'filter', index: h0.col };
      }
      return null;
    }
    if (lx >= 0 && lx < HEAD_W && ly > HEAD_H) {
      const h0 = hit(clientX, clientY);
      if (h0 && h0.row >= 0) {
        const bottom = screenY(geo, h0.row + 1, sy); const top = screenY(geo, h0.row, sy);
        if (Math.abs(ly - bottom) <= 3) return { kind: 'resize-row', index: h0.row };
        if (Math.abs(ly - top) <= 3 && h0.row > 0) return { kind: 'resize-row', index: h0.row - 1 };
      }
      return null;
    }
    if (!readOnly && !edit) {
      const fx = screenX(geo, selRange.endColumn + 1, sx); const fy = screenY(geo, selRange.endRow + 1, sy);
      if (Math.abs(lx - fx) <= 5 && Math.abs(ly - fy) <= 5) return { kind: 'fill', index: 0 };
    }
    return null;
  }, [geo, hit, b, sheetId, readOnly, edit, selRange]);

  const onHover = (e: React.MouseEvent) => {
    if (drag.current) return;
    const h = handleAt(e.clientX, e.clientY);
    const cursor = h?.kind === 'resize-col' ? 'col-resize' : h?.kind === 'resize-row' ? 'row-resize' : h?.kind === 'fill' ? 'crosshair' : h?.kind === 'filter' ? 'pointer' : '';
    if (grid.current && grid.current.style.cursor !== cursor) grid.current.style.cursor = cursor;
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
    const handle = handleAt(e.clientX, e.clientY);
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
    if (edit && edit.text.startsWith('=') && h.row >= 0 && h.col >= 0) { e.preventDefault(); insertRef(a1(h.row, h.col)); return; }
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
      if (d.kind === 'fill') {
        // Тянем вниз/вверх или вбок — по тому, куда курсор ушёл дальше от выделения.
        const r = Math.max(0, h.row); const c = Math.max(0, h.col);
        const dr = r > selRange.endRow ? r - selRange.endRow : r < selRange.startRow ? r - selRange.startRow : 0;
        const dc = c > selRange.endColumn ? c - selRange.endColumn : c < selRange.startColumn ? c - selRange.startColumn : 0;
        if (!dr && !dc) setFillTo(null);
        else if (Math.abs(dr) >= Math.abs(dc)) setFillTo({ ...selRange, startRow: Math.min(selRange.startRow, r), endRow: Math.max(selRange.endRow, r) });
        else setFillTo({ ...selRange, startColumn: Math.min(selRange.startColumn, c), endColumn: Math.max(selRange.endColumn, c) });
      } else if (d.kind === 'cols') setSel((s) => ({ anchor: s.anchor, focus: { row: geo.rows - 1, col: Math.max(0, h.col) } }));
      else if (d.kind === 'rows') setSel((s) => ({ anchor: s.anchor, focus: { row: Math.max(0, h.row), col: geo.cols - 1 } }));
      else setSel((s) => ({ anchor: s.anchor, focus: { row: Math.max(0, h.row), col: Math.max(0, h.col) } }));
      // Автопрокрутка у края.
      const el = grid.current;
      if (el) {
        const box = el.getBoundingClientRect();
        if (e.clientY > box.bottom - 20) el.scrollTop += 20; else if (e.clientY < box.top + HEAD_H + 10 && el.scrollTop > 0) el.scrollTop -= 20;
        if (e.clientX > box.right - 20) el.scrollLeft += 20; else if (e.clientX < box.left + HEAD_W + 10 && el.scrollLeft > 0) el.scrollLeft -= 20;
      }
    };
    const onUp = (e: MouseEvent) => {
      const d = drag.current;
      drag.current = null;
      if (!d) return;
      if (d.kind === 'fill') { const to = fillTo; setFillTo(null); if (to) fill(selRange, to); return; }
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
  }, [geo, hit, commit, sheetId, selRange, fillTo, fill]);

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
    if (!h || h.row < 0 || h.col < 0 || handle) return;
    startEdit();
  };

  // ── Клавиатура ──
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (edit || !geo) return;
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
      if (lower === 'f' || lower === 'а') { e.preventDefault(); setFind((f) => ({ ...f, open: true })); return; }
      // Ctrl+D / Ctrl+R — заполнить выделение вниз / вправо первой строкой (столбцом), как в Excel.
      if ((lower === 'd' || lower === 'в') && selRange.endRow > selRange.startRow && !readOnly) { e.preventDefault(); fill({ ...selRange, endRow: selRange.startRow }, selRange); return; }
      if ((lower === 'r' || lower === 'к') && selRange.endColumn > selRange.startColumn && !readOnly) { e.preventDefault(); fill({ ...selRange, endColumn: selRange.startColumn }, selRange); return; }
      if (k === 'Home') { e.preventDefault(); setSel({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } }); reveal(0, 0); return; }
    }
    if (mod && e.altKey && e.code === 'KeyM' && onAddComment) { e.preventDefault(); onAddComment(); return; }
    const arrows: Record<string, [number, number]> = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (arrows[k]) { e.preventDefault(); move(arrows[k][0], arrows[k][1], e.shiftKey, mod); return; }
    if (k === 'Tab') { e.preventDefault(); move(0, e.shiftKey ? -1 : 1); return; }
    if (k === 'Enter') { e.preventDefault(); if (e.shiftKey) move(-1, 0); else startEdit(); return; }
    if (k === 'F2') { e.preventDefault(); startEdit(); return; }
    if (k === 'PageDown' || k === 'PageUp') { e.preventDefault(); move(k === 'PageDown' ? 20 : -20, 0, e.shiftKey); return; }
    if (k === 'Home') { e.preventDefault(); move(0, -sel.anchor.col, e.shiftKey); return; }
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); if (!readOnly) clearValues(); return; }
    if (k === 'Escape') { clip.current = null; setClipMark(null); return; }
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

  const onEditKey = (e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (e.key === 'Enter' && e.altKey) { e.preventDefault(); setEdit((x) => (x ? { ...x, text: `${x.text}\n` } : x)); return; }
    if (e.key === 'Enter') { e.preventDefault(); finishEdit(e.shiftKey ? 'up' : 'down'); return; }
    if (e.key === 'Tab') { e.preventDefault(); finishEdit(e.shiftKey ? 'left' : 'right'); return; }
    if (e.key === 'Escape') { e.preventDefault(); finishEdit('cancel'); }
  };

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
    'ui.operation.open-find-dialog': () => setFind((f) => ({ ...f, open: true })),
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
    'sheet.command.sort-range-asc': () => sortBy(false),
    'sheet.command.sort-range-desc': () => sortBy(true),
    'sheet.command.smart-toggle-filter': () => toggleFilter(),
    'sheet.command.clear-filter-criteria': () => { if (!b) return; const f = readFilters(b)[sheetId]; for (const c of f?.filterColumns || []) setFilterCriteria(c.colId, null); },
  }), [undoStep, copy, paste, restyle, anchorStyle, merged, sortBy, toggleFilter, setFilterCriteria, b, sheetId]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const root = useRef<HTMLDivElement>(null);
  const drawState = useRef<() => void>(() => undefined);
  drawState.current = () => {
    const el = grid.current; const cv = canvas.current;
    if (!el || !cv || !geo || !sheet || !b || !root.current) return;
    const dpr = window.devicePixelRatio || 1;
    const W = el.clientWidth; const H = el.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      cv.style.width = `${W}px`; cv.style.height = `${H}px`;
    }
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const filters = readFilters(b);
    const f = filters[sheetId];
    const anchorM = geo.merges.get(`${sel.anchor.row}:${sel.anchor.col}`);
    drawSheet(ctx, {
      book: b, sheet, geo, theme: readTheme(root.current), scrollX: el.scrollLeft, scrollY: el.scrollTop, width: W, height: H, dpr,
      sel: fillTo ?? selRange, active: anchorM ?? { startRow: sel.anchor.row, endRow: sel.anchor.row, startColumn: sel.anchor.col, endColumn: sel.anchor.col },
      clip: clipMark, marks: new Set(commentCells.filter((m) => !m.sheet || m.sheet === sheet.name).map((m) => m.cell)),
      peers: cursors.flatMap((cur) => {
        const p = cur.pos as SheetCursor | null;
        return p && p.sh === sheetId ? [{ name: cur.name, color: cur.color, range: norm({ startRow: p.r1, startColumn: p.c1, endRow: p.r2, endColumn: p.c2 }) }] : [];
      }),
      filter: f?.ref ?? null, filtered: new Set(f?.cachedFilteredOut || []),
    });
  };
  const frame = useRef(0);
  const redraw = useCallback(() => {
    if (frame.current) return;
    frame.current = window.requestAnimationFrame(() => { frame.current = 0; drawState.current(); });
  }, []);
  // Перерисовать после каждого рендера (правка, выделение, коллеги) — сам рендер холст не трогает.
  useEffect(() => { redraw(); });
  // Смена темы — перерисовать.
  useEffect(() => {
    const mo = new MutationObserver(redraw);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, [redraw]);

  // Сводка выделения (как в углу Google Таблиц): сумма, среднее, количество — только при смене выделения и правках.
  const summaryText = useMemo(() => {
    if (!sheet || (selRange.startRow === selRange.endRow && selRange.startColumn === selRange.endColumn)) return null;
    let sum = 0; let n = 0; let count = 0;
    eachSelected((r, c) => { const v = cellAt(sheet, r, c)?.v; if (v !== null && v !== undefined && v !== '') count += 1; if (typeof v === 'number') { sum += v; n += 1; } });
    if (!count) return null;
    const f = (x: number) => String(Number(x.toPrecision(12))).replace('.', ',');
    return n ? `Сумма: ${f(sum)} · Среднее: ${f(sum / n)} · Количество: ${count}` : `Количество: ${count}`;
  }, [sheet, version, selRange.startRow, selRange.endRow, selRange.startColumn, selRange.endColumn]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div className="nws-missing" role="alert">{error}</div>;
  if (!b || !sheet || !geo) return <div className="fsh-loading" aria-busy="true">Открываю таблицу…</div>;

  // ── Отрисовка видимой части ──
  const { rowOffs, colOffs, rows, cols } = geo;

  const editCell = edit ? cellAt(sheet, edit.row, edit.col) : undefined;
  const editLook = edit ? cellCss(styleOf(b, editCell)) : null;
  // Поле правки — в экранных координатах поверх холста (с учётом прокрутки и закрепления).
  const editBox = edit ? (() => {
    const m = geo.merges.get(`${edit.row}:${edit.col}`);
    const r0 = m?.startRow ?? edit.row; const c0 = m?.startColumn ?? edit.col; const r1 = m?.endRow ?? edit.row; const c1 = m?.endColumn ?? edit.col;
    const x = screenX(geo, c0, scroll.x); const y = screenY(geo, r0, scroll.y);
    return { x, y, w: screenX(geo, c1 + 1, scroll.x) - x, h: screenY(geo, r1 + 1, scroll.y) - y };
  })() : null;

  const btn = (key: string, title: string, active: boolean, icon: ReactNode, action: (e: React.MouseEvent<HTMLButtonElement>) => void, disabled = false) => (
    <button key={key} type="button" className="fdoc-btn" title={title} aria-label={title} aria-pressed={active} disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} onClick={action}>{icon}</button>
  );
  const open = (kind: string) => (e: React.MouseEvent<HTMLElement>) => { const trigger = e.currentTarget; setPop((p) => (p?.kind === kind ? null : { kind, at: trigger.getBoundingClientRect(), trigger })); };
  const close = () => setPop(null);
  const hAlign = Number(anchorStyle.ht) || 0;
  const vAlign = Number(anchorStyle.vt) || 0;
  const fontSize = Number(anchorStyle.fs) || 11;
  const nameBox = edit ? a1(edit.row, edit.col) : rangeA1(selRange);
  const anchorCell = cellAt(sheet, sel.anchor.row, sel.anchor.col);
  const barText = edit ? edit.text : editText(anchorCell, styleOf(b, anchorCell));

  const summary = summaryText;

  const borderSet = (kind: 'all' | 'outer' | 'none') => {
    const line = { s: 1, cl: { rgb: '#000000' } };
    const cells: Record<number, Record<number, Cell | null>> = {};
    eachSelected((r, c) => {
      const prev = { ...(styleOf(b, cellAt(sheet, r, c)) || {}) } as Style;
      const bd: Record<string, unknown> = kind === 'none' ? {} : { ...((prev.bd as object) || {}) };
      if (kind === 'all') Object.assign(bd, { t: line, b: line, l: line, r: line });
      if (kind === 'outer') {
        if (r === selRange.startRow) bd.t = line;
        if (r === selRange.endRow) bd.b = line;
        if (c === selRange.startColumn) bd.l = line;
        if (c === selRange.endColumn) bd.r = line;
      }
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
            {btn('undo', 'Отменить (Ctrl+Z)', false, <OUndo size={18} />, () => undoStep(true), !undo.current.length)}
            {btn('redo', 'Повторить (Ctrl+Y)', false, <ORedo size={18} />, () => undoStep(false), !redo.current.length)}
            <span className="fdoc-sep" />
            {btn('rub', 'Формат: рубли', false, <RussianRuble size={16} strokeWidth={1.75} />, () => setPattern('#,##0.00 "₽"'))}
            {btn('pct', 'Формат: проценты', false, <Percent size={16} strokeWidth={1.75} />, () => setPattern('0%'))}
            {btn('dec-', 'Уменьшить число знаков после запятой', false, <span className="fsh-txt-btn">.0</span>, () => stepDecimals(-1))}
            {btn('dec+', 'Увеличить число знаков после запятой', false, <span className="fsh-txt-btn">.00</span>, () => stepDecimals(1))}
            <button type="button" className="fdoc-drop" onMouseDown={(e) => e.preventDefault()} onClick={open('numfmt')} title="Формат чисел"><span>123</span><OChevronDown size={14} aria-hidden="true" /></button>
            <span className="fdoc-sep" />
            <button type="button" className="fdoc-drop" onMouseDown={(e) => e.preventDefault()} onClick={open('size')} title="Размер шрифта"><span>{fontSize}</span><OChevronDown size={14} aria-hidden="true" /></button>
            <span className="fdoc-sep" />
            {btn('b', 'Полужирный (Ctrl+B)', Boolean(anchorStyle.bl), <OBold size={18} />, () => toggle('bl', 1))}
            {btn('i', 'Курсив (Ctrl+I)', Boolean(anchorStyle.it), <OItalic size={18} />, () => toggle('it', 1))}
            {btn('u', 'Подчёркнутый (Ctrl+U)', Boolean((anchorStyle.ul as { s?: number } | undefined)?.s), <OUnderline size={18} />, () => restyle((s) => ({ ...s, ul: anchorStyle.ul ? undefined : { s: 1 } })))}
            {btn('s', 'Зачёркнутый', Boolean((anchorStyle.st as { s?: number } | undefined)?.s), <OStrikethrough size={18} />, () => restyle((s) => ({ ...s, st: anchorStyle.st ? undefined : { s: 1 } })))}
            <button type="button" className="fdoc-btn fdoc-color" title="Цвет текста" aria-label="Цвет текста" onMouseDown={(e) => e.preventDefault()} onClick={open('color')}>
              <OTextColor size={18} style={{ '--swatch': (anchorStyle.cl as { rgb?: string } | undefined)?.rgb || 'currentColor' } as CSSProperties} />
            </button>
            <button type="button" className="fdoc-btn fdoc-color" title="Цвет заливки" aria-label="Цвет заливки" onMouseDown={(e) => e.preventDefault()} onClick={open('fill')}>
              <OHighlightColor size={18} style={{ '--swatch': (anchorStyle.bg as { rgb?: string } | undefined)?.rgb || 'transparent' } as CSSProperties} />
            </button>
            <span className="fdoc-sep" />
            <button type="button" className="fdoc-btn" title="Границы" aria-label="Границы" onMouseDown={(e) => e.preventDefault()} onClick={open('borders')}><Grid2x2 size={16} strokeWidth={1.75} /></button>
            {btn('merge', merged ? 'Отменить объединение' : 'Объединить ячейки', merged, merged ? <TableCellsSplit size={16} strokeWidth={1.75} /> : <TableCellsMerge size={16} strokeWidth={1.75} />, toggleMerge)}
            <span className="fdoc-sep" />
            {btn('al', 'По левому краю', hAlign === 1, <OAlignLeft size={18} />, () => restyle((s) => ({ ...s, ht: hAlign === 1 ? undefined : 1 })))}
            {btn('ac', 'По центру', hAlign === 2, <OAlignCenter size={18} />, () => restyle((s) => ({ ...s, ht: hAlign === 2 ? undefined : 2 })))}
            {btn('ar', 'По правому краю', hAlign === 3, <OAlignRight size={18} />, () => restyle((s) => ({ ...s, ht: hAlign === 3 ? undefined : 3 })))}
            {btn('vt', 'По верхнему краю', vAlign === 1, <AlignVerticalJustifyStart size={16} strokeWidth={1.75} />, () => restyle((s) => ({ ...s, vt: vAlign === 1 ? undefined : 1 })))}
            {btn('vm', 'По середине', vAlign === 2, <AlignVerticalJustifyCenter size={16} strokeWidth={1.75} />, () => restyle((s) => ({ ...s, vt: vAlign === 2 ? undefined : 2 })))}
            {btn('vb', 'По нижнему краю', vAlign === 3, <AlignVerticalJustifyEnd size={16} strokeWidth={1.75} />, () => restyle((s) => ({ ...s, vt: vAlign === 3 ? undefined : 3 })))}
            {btn('wrap', 'Переносить по словам', anchorStyle.tb === 3, <WrapText size={16} strokeWidth={1.75} />, () => restyle((s) => ({ ...s, tb: s.tb === 3 ? undefined : 3 })))}
            <span className="fdoc-sep" />
            {btn('sort', 'Сортировать А → Я по столбцу', false, <ArrowDownAZ size={16} strokeWidth={1.75} />, () => sortBy(false))}
            {btn('filter', b && readFilters(b)[sheetId] ? 'Убрать фильтр' : 'Фильтр', Boolean(b && readFilters(b)[sheetId]), <Filter size={16} strokeWidth={1.75} />, toggleFilter)}
            {btn('sum', 'Сумма (СУММ)', false, <Sigma size={16} strokeWidth={1.75} />, sumBelow)}
            {btn('freeze', 'Закрепить', Boolean(sheet.freeze), <Snowflake size={16} strokeWidth={1.75} />, open('freeze'))}
            {btn('clear', 'Очистить форматирование', false, <OClearFormat size={18} />, () => restyle(() => ({} as Style)))}
          </div>
        </div>
      )}

      <div className="fsh-formula">
        <input className="fsh-name" value={nameBox} aria-label="Адрес ячейки или диапазона" readOnly={Boolean(edit)}
          onChange={() => undefined}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            const r = parseRange(e.currentTarget.value.toUpperCase());
            if (!r) { showToast('Адрес вида A1 или A1:C5', 'info'); return; }
            setSel({ anchor: { row: r.startRow, col: r.startColumn }, focus: { row: r.endRow, col: r.endColumn } });
            reveal(r.startRow, r.startColumn);
            grid.current?.focus();
          }}
          onFocus={(e) => e.currentTarget.select()} />
        <span className="fsh-fx" aria-hidden="true">fx</span>
        <input className="fsh-bar-input" value={barText} readOnly={readOnly} aria-label="Содержимое ячейки"
          onFocus={() => { if (!edit && !readOnly) startEdit(undefined, true); }}
          onChange={(e) => setEdit((x) => (x ? { ...x, text: e.target.value, bar: true } : { row: sel.anchor.row, col: sel.anchor.col, text: e.target.value, bar: true }))}
          onKeyDown={onEditKey} />
      </div>

      {find.open && (
        <div className="fdoc-find-bar">
          <FindBar query={find.query} onQuery={(q) => setFind({ open: true, query: q, index: 0 })} count={findHits.length} index={find.index}
            onNext={() => goFind(find.index + 1)} onPrev={() => goFind(find.index - 1)} onClose={() => { setFind({ open: false, query: '', index: 0 }); grid.current?.focus(); }} focusToken={1} />
        </div>
      )}

      <div className="fsh-gridwrap" ref={root}>
        <div ref={grid} className="fsh-grid" tabIndex={0} role="grid" aria-label={`Лист «${sheet.name}»`} aria-rowcount={rows} aria-colcount={cols}
          onScroll={(e) => { redraw(); if (edit) { const el = e.currentTarget; setScroll({ x: el.scrollLeft, y: el.scrollTop }); } }}
          onMouseDown={onMouseDown} onMouseMove={onHover} onDoubleClick={onDoubleClick} onKeyDown={onKeyDown}
          onContextMenu={(e) => { if (e.shiftKey) return; e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}>
          <canvas ref={canvas} className="fsh-canvas" aria-hidden="true" />
          <div className="fsh-sizer" style={{ width: HEAD_W + colOffs[cols], height: HEAD_H + rowOffs[rows], marginTop: -view.h }} />
        </div>
        {guide && <div className="fsh-guide" data-axis={guide.axis} style={guide.axis === 'x' ? { left: guide.at } : { top: guide.at }} />}
        {edit && !edit.bar && editBox && (
          <textarea ref={editor} className="fsh-editor" value={edit.text} spellCheck={false}
            style={{ left: editBox.x, top: editBox.y, minWidth: editBox.w, minHeight: editBox.h, ...editLook?.css, background: editLook?.css.background || undefined, textAlign: (editLook?.h as CSSProperties['textAlign']) || undefined }}
            onChange={(e) => setEdit((x) => (x ? { ...x, text: e.target.value } : x))}
            onKeyDown={onEditKey}
            onBlur={(e) => { if (!root.current?.contains(e.relatedTarget as Node) && !(e.relatedTarget as HTMLElement | null)?.closest('.fsh-formula')) finishEdit('stay'); }} />
        )}
        {filterMenu && b && sheet && <FilterMenu {...filterMenu} book={b} sheet={sheet} onClose={() => setFilterMenu(null)} onApply={(col, criteria) => setFilterCriteria(col, criteria)} onSort={(desc, col) => sortBy(desc, col)} />}
      </div>

      <div className="fsh-tabs" role="tablist" aria-label="Листы">
        {!readOnly && <button type="button" className="fsh-tab-add" title="Добавить лист" aria-label="Добавить лист" onClick={addSheet}><Plus size={15} /></button>}
        {b.sheetOrder.filter((id) => b.sheets[id] && !b.sheets[id].hidden).map((id) => (
          renaming === id ? (
            <input key={id} className="fsh-tab-input" defaultValue={b.sheets[id].name} autoFocus aria-label="Название листа"
              onBlur={(e) => { renameSheet(id, e.target.value); setRenaming(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null); }} />
          ) : (
            <button key={id} type="button" role="tab" className="fsh-tab" aria-selected={id === sheetId}
              style={b.sheets[id].tabColor ? ({ '--tab': b.sheets[id].tabColor } as CSSProperties) : undefined}
              onClick={() => { if (edit) finishEdit('stay'); setSheetId(id); setSel({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } }); grid.current?.scrollTo(0, 0); }}
              onDoubleClick={() => { if (!readOnly) setRenaming(id); }}
              onContextMenu={(e) => { e.preventDefault(); if (!readOnly) setTabMenu({ id, x: e.clientX, y: e.clientY }); }}>
              {b.sheets[id].name}
            </button>
          )
        ))}
        {summary && <span className="fsh-summary">{summary}</span>}
      </div>

      {menu && (
        <Menu anchor={menu} label="Действия с ячейками" onClose={() => setMenu(null)}>
          {!readOnly && <MenuItem icon={<Scissors size={16} />} onSelect={() => { setMenu(null); copy(true, null); }}>Вырезать <kbd className="nx-menu-kbd">Ctrl+X</kbd></MenuItem>}
          <MenuItem icon={<Copy size={16} />} onSelect={() => { setMenu(null); copy(false, null); }}>Копировать <kbd className="nx-menu-kbd">Ctrl+C</kbd></MenuItem>
          {!readOnly && <MenuItem icon={<ClipboardPaste size={16} />} onSelect={() => { setMenu(null); commands['univer.command.paste'](); }}>Вставить <kbd className="nx-menu-kbd">Ctrl+V</kbd></MenuItem>}
          {!readOnly && (
            <>
              <div className="nx-menu-sep" />
              <MenuItem icon={<ArrowUpToLine size={16} />} onSelect={() => { setMenu(null); insertRows(true); }}>Вставить строку выше</MenuItem>
              <MenuItem icon={<ArrowDownToLine size={16} />} onSelect={() => { setMenu(null); insertRows(false); }}>Вставить строку ниже</MenuItem>
              <MenuItem icon={<ArrowLeftToLine size={16} />} onSelect={() => { setMenu(null); insertCols(true); }}>Вставить столбец слева</MenuItem>
              <MenuItem icon={<ArrowRightToLine size={16} />} onSelect={() => { setMenu(null); insertCols(false); }}>Вставить столбец справа</MenuItem>
              <MenuItem icon={<Trash2 size={16} />} onSelect={() => { setMenu(null); removeRows(); }}>Удалить {selRange.endRow > selRange.startRow ? 'строки' : 'строку'}</MenuItem>
              <MenuItem icon={<Columns2 size={16} />} onSelect={() => { setMenu(null); removeCols(); }}>Удалить {selRange.endColumn > selRange.startColumn ? 'столбцы' : 'столбец'}</MenuItem>
              <div className="nx-menu-sep" />
              <MenuItem icon={<ArrowDownAZ size={16} />} onSelect={() => { setMenu(null); sortBy(false); }}>Сортировать А → Я</MenuItem>
              <MenuItem icon={<ArrowUpZA size={16} />} onSelect={() => { setMenu(null); sortBy(true); }}>Сортировать Я → А</MenuItem>
              <MenuItem icon={<Filter size={16} />} onSelect={() => { setMenu(null); toggleFilter(); }}>{b && readFilters(b)[sheetId] ? 'Убрать фильтр' : 'Создать фильтр'}</MenuItem>
              <div className="nx-menu-sep" />
              <MenuItem icon={<Eraser size={16} />} onSelect={() => { setMenu(null); clearValues(); }}>Очистить содержимое <kbd className="nx-menu-kbd">Del</kbd></MenuItem>
              <MenuItem icon={merged ? <TableCellsSplit size={16} /> : <TableCellsMerge size={16} />} onSelect={() => { setMenu(null); toggleMerge(); }}>{merged ? 'Отменить объединение' : 'Объединить ячейки'}</MenuItem>
            </>
          )}
          {onAddComment && (
            <>
              <div className="nx-menu-sep" />
              <MenuItem icon={<MessageSquarePlus size={16} />} onSelect={() => { setMenu(null); onAddComment(); }}>Комментарий <kbd className="nx-menu-kbd">Ctrl+Alt+M</kbd></MenuItem>
            </>
          )}
        </Menu>
      )}
      {tabMenu && (
        <Menu anchor={{ x: tabMenu.x, y: tabMenu.y }} label="Лист" onClose={() => setTabMenu(null)}>
          <MenuItem onSelect={() => { setRenaming(tabMenu.id); setTabMenu(null); }}>Переименовать</MenuItem>
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
      {pop?.kind === 'size' && (
        <Pop anchor={pop.at} trigger={pop.trigger} onClose={close} className="fdoc-pop-list fdoc-pop-sizes">
          {SIZES.map((n) => <button key={n} type="button" className="fdoc-pop-item" aria-selected={fontSize === n} onClick={() => { restyle((s) => ({ ...s, fs: n === 11 ? undefined : n })); close(); }}>{n}</button>)}
        </Pop>
      )}
      {pop?.kind === 'numfmt' && (
        <Pop anchor={pop.at} trigger={pop.trigger} onClose={close} className="fdoc-pop-list">
          {([['Автоматический', null], ['Число  1 234,56', '#,##0.00'], ['Целое  1 234', '#,##0'], ['Процент  12,5%', '0.0%'], ['Рубли  1 234,56 ₽', '#,##0.00 "₽"'],
            ['Дата  25.11.2026', 'dd.mm.yyyy'], ['Дата и время', 'dd.mm.yyyy hh:mm'], ['Время  14:30', 'hh:mm'], ['Дата словами', 'd mmmm yyyy'], ['Текст', '@']] as Array<[string, string | null]>).map(([label, pattern]) => (
            <button key={label} type="button" className="fdoc-pop-item" onClick={() => { setPattern(pattern); close(); }}>{label}</button>
          ))}
        </Pop>
      )}
      {pop?.kind === 'borders' && (
        <Pop anchor={pop.at} trigger={pop.trigger} onClose={close} className="fdoc-pop-list">
          <button type="button" className="fdoc-pop-item" onClick={() => { borderSet('all'); close(); }}><Grid2x2 size={15} /> Все границы</button>
          <button type="button" className="fdoc-pop-item" onClick={() => { borderSet('outer'); close(); }}><Square size={15} /> Внешние границы</button>
          <button type="button" className="fdoc-pop-item" onClick={() => { borderSet('none'); close(); }}><Eraser size={15} /> Без границ</button>
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
