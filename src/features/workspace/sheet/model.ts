import type { ICellData, IStyleData, IWorkbookData } from '@univerjs/presets';

/**
 * Модель своего редактора таблиц — тот же JSON-снимок книги, что строит lib/workbook.ts из xlsx (формат снимка Univer,
 * только типы: сам Univer здесь не нужен). Так файл, оформление, объединения и фильтры переходят туда и обратно
 * готовым кодом, а правки по сети совпадают с правками прежнего редактора (live/sheetTransform.ts).
 *
 * Оформление ячейки: s — id стиля из book.styles. Стиль: bl/it — жирный/курсив, ul.s/st.s — подчёркнутый/зачёркнутый,
 * fs — кегль (pt), ff — шрифт, cl/bg — цвет текста и заливки ({rgb}), ht — по горизонтали (1 слева, 2 по центру,
 * 3 справа), vt — по вертикали (1 сверху, 2 по центру, 3 снизу), tb: 3 — перенос, bd — границы {t,b,l,r: {s, cl}},
 * n.pattern — формат числа.
 */

export type Cell = ICellData;
export type Style = IStyleData & Record<string, unknown>;
export interface Sheet {
  id: string;
  name: string;
  rowCount: number;
  columnCount: number;
  cellData: Record<number, Record<number, Cell>>;
  rowData?: Record<number, { h?: number; hd?: number }>;
  columnData?: Record<number, { w?: number; hd?: number }>;
  mergeData?: Range[];
  freeze?: { xSplit: number; ySplit: number; startRow: number; startColumn: number };
  tabColor?: string;
  hidden?: number;
  defaultColumnWidth?: number;
  defaultRowHeight?: number;
  [key: string]: unknown;
}
export type Book = Omit<IWorkbookData, 'sheets'> & { sheets: Record<string, Sheet> };
export interface Range { startRow: number; endRow: number; startColumn: number; endColumn: number }
export interface Pos { row: number; col: number }

export const COL_W = 88;
export const ROW_H = 24;
export const HEAD_W = 46;
export const HEAD_H = 24;

export function colName(c: number): string {
  let s = '';
  let n = c + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
export const a1 = (r: number, c: number) => `${colName(c)}${r + 1}`;

export function parseA1(text: string): Pos | null {
  const m = /^\$?([A-Z]{1,3})\$?(\d{1,7})$/i.exec(text.trim());
  if (!m) return null;
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(m[2]) - 1, col: col - 1 };
}

export function parseRange(text: string): Range | null {
  const [a, b] = text.split(':');
  const p = parseA1(a);
  const q = b ? parseA1(b) : p;
  if (!p || !q) return null;
  return norm({ startRow: p.row, startColumn: p.col, endRow: q.row, endColumn: q.col });
}

export const norm = (r: Range): Range => ({
  startRow: Math.min(r.startRow, r.endRow), endRow: Math.max(r.startRow, r.endRow),
  startColumn: Math.min(r.startColumn, r.endColumn), endColumn: Math.max(r.startColumn, r.endColumn),
});
export const rangeA1 = (r: Range) => (r.startRow === r.endRow && r.startColumn === r.endColumn ? a1(r.startRow, r.startColumn) : `${a1(r.startRow, r.startColumn)}:${a1(r.endRow, r.endColumn)}`);
export const inRange = (r: Range, row: number, col: number) => row >= r.startRow && row <= r.endRow && col >= r.startColumn && col <= r.endColumn;
export const overlaps = (a: Range, b: Range) => a.startRow <= b.endRow && b.startRow <= a.endRow && a.startColumn <= b.endColumn && b.startColumn <= a.endColumn;

export const cellAt = (sheet: Sheet, r: number, c: number): Cell | undefined => sheet.cellData?.[r]?.[c];

export function styleOf(book: Book, cell: Cell | undefined | null): Style | null {
  const s = cell?.s;
  if (!s) return null;
  if (typeof s === 'string') return (book.styles?.[s] as Style) ?? null;
  return s as Style;
}

/** Реестр стилей: одинаковое оформление — один id (как у workbook.ts: «s1», «s2»…). */
export class Styles {
  private ids = new Map<string, string>();
  private n = 0;
  constructor(private book: Book) {
    book.styles ||= {};
    for (const [id, style] of Object.entries(book.styles)) {
      if (style) this.ids.set(JSON.stringify(style), id);
      const k = Number(id.replace(/^\D+/, ''));
      if (Number.isFinite(k)) this.n = Math.max(this.n, k);
    }
  }
  /** id стиля; пустой стиль — null (ячейка без оформления). */
  ensure(style: Style | null | undefined): string | null {
    if (!style) return null;
    const clean = Object.fromEntries(Object.entries(style).filter(([, v]) => v !== undefined && v !== null)) as Style;
    if (!Object.keys(clean).length) return null;
    const key = JSON.stringify(clean);
    let id = this.ids.get(key);
    if (!id) {
      this.n += 1;
      id = `s${this.n}`;
      while (this.book.styles![id]) { this.n += 1; id = `s${this.n}`; }
      this.ids.set(key, id);
      this.book.styles![id] = clean;
    }
    return id;
  }
}

export const colWidth = (sheet: Sheet, c: number) => (sheet.columnData?.[c]?.hd ? 0 : sheet.columnData?.[c]?.w ?? sheet.defaultColumnWidth ?? COL_W);
export const rowHeight = (sheet: Sheet, r: number) => (sheet.rowData?.[r]?.hd ? 0 : sheet.rowData?.[r]?.h ?? sheet.defaultRowHeight ?? ROW_H);

/** Смещения строк или столбцов: offs[i] — начало i-го, offs[n] — общий размер. */
export function offsets(n: number, size: (i: number) => number): Float64Array {
  const out = new Float64Array(n + 1);
  for (let i = 0; i < n; i += 1) out[i + 1] = out[i] + size(i);
  return out;
}
/** Номер строки (столбца) по координате: последний i, у которого offs[i] <= x. */
export function indexAt(offs: Float64Array, x: number): number {
  let lo = 0;
  let hi = offs.length - 2;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offs[mid] <= x) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Объединения листа по ячейке: каждая ячейка внутри объединения → его диапазон. */
export function mergeIndex(sheet: Sheet): Map<string, Range> {
  const map = new Map<string, Range>();
  for (const m of sheet.mergeData || []) {
    for (let r = m.startRow; r <= m.endRow; r += 1) for (let c = m.startColumn; c <= m.endColumn; c += 1) map.set(`${r}:${c}`, m);
  }
  return map;
}

/** Последняя занятая строка и столбец (для «до конца данных» и границ диапазонов формул). */
export function usedBounds(sheet: Sheet): { rows: number; cols: number } {
  let rows = 0;
  let cols = 0;
  for (const [r, row] of Object.entries(sheet.cellData || {})) {
    for (const [c, cell] of Object.entries(row || {})) {
      if (cell && (cell.v !== undefined && cell.v !== null && cell.v !== '' || cell.f)) { rows = Math.max(rows, Number(r) + 1); cols = Math.max(cols, Number(c) + 1); }
    }
  }
  return { rows, cols };
}

// ── Значения: ввод человека → ячейка, ячейка → текст на экране ────────────────────────────────────────────────

export const CellType = { STRING: 1, NUMBER: 2, BOOLEAN: 3 } as const;

const EPOCH = Date.UTC(1899, 11, 30);
export const dateToSerial = (y: number, m: number, d: number, hh = 0, mm = 0) => (Date.UTC(y, m - 1, d, hh, mm) - EPOCH) / 86400000;

/** Разбор ввода: «=…» — формула, число (1 234,5 и 1234.5), процент, дата 25.11.2026, ИСТИНА/ЛОЖЬ, иначе текст. Апостроф — всегда текст. */
export function parseInput(raw: string): { v: string | number | boolean | null; f?: string; t?: number; pattern?: string } {
  const text = raw;
  if (text === '') return { v: null };
  if (text.startsWith("'")) return { v: text.slice(1), t: CellType.STRING };
  if (text.startsWith('=') && text.length > 1) return { v: null, f: text };
  const t = text.trim();
  const num = /^[-+]?(\d{1,3}([\u00A0\u202F\s]\d{3})+|\d+)([.,]\d+)?$/.exec(t);
  if (num) return { v: Number(t.replace(/[\u00A0\u202F\s]/g, '').replace(',', '.')), t: CellType.NUMBER };
  const pct = /^([-+]?\d+(?:[.,]\d+)?)\s*%$/.exec(t);
  if (pct) return { v: Number(pct[1].replace(',', '.')) / 100, t: CellType.NUMBER, pattern: pct[1].match(/[.,]/) ? '0.00%' : '0%' };
  const date = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(t);
  if (date) {
    const [d, m, y] = [Number(date[1]), Number(date[2]), Number(date[3])];
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const timed = date[4] !== undefined;
      return { v: dateToSerial(y, m, d, Number(date[4] || 0), Number(date[5] || 0)), t: CellType.NUMBER, pattern: timed ? 'dd.mm.yyyy hh:mm' : 'dd.mm.yyyy' };
    }
  }
  const up = t.toUpperCase();
  if (up === 'ИСТИНА' || up === 'TRUE') return { v: true, t: CellType.BOOLEAN };
  if (up === 'ЛОЖЬ' || up === 'FALSE') return { v: false, t: CellType.BOOLEAN };
  return { v: text, t: CellType.STRING };
}

/** Текст ячейки для правки: формула — как есть, число — без форматирования, с запятой. */
export function editText(cell: Cell | undefined, style: Style | null): string {
  if (!cell) return '';
  if (cell.f) return String(cell.f);
  const v = cell.v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'ИСТИНА' : 'ЛОЖЬ';
  if (typeof v === 'number') {
    const pattern = (style?.n as { pattern?: string } | undefined)?.pattern || '';
    if (/[dmy]/i.test(pattern.replace(/"[^"]*"|\[[^\]]*\]/g, ''))) {
      const ms = EPOCH + v * 86400000;
      const d = new Date(ms);
      const p = (n: number) => String(n).padStart(2, '0');
      const day = `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
      return d.getUTCHours() || d.getUTCMinutes() ? `${day} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` : day;
    }
    if (/%/.test(pattern)) return `${String(Math.round(v * 100 * 1e10) / 1e10).replace('.', ',')}%`;
    return String(v).replace('.', ',');
  }
  return String(v);
}

type Ssf = { format: (pattern: string, value: number) => string };
let ssf: Ssf | null = null;
/** Формат чисел Excel (SSF) — берётся у движка формул, когда тот загружен (formulas.ts). */
export function setNumberFormatter(f: Ssf) { ssf = f; }

/** Русская запись числа из вывода SSF: «1,234.50» → «1 234,50». */
const ruNumber = (s: string) => s.replace(/[,.]/g, (ch) => (ch === ',' ? ' ' : ','));

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const DAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

/** Дата по формату Excel (гггг, мм, дд, чч:мм:сс, ммм/мммм — месяц словом). «мм» после часов — минуты. */
export function formatDate(pattern: string, serial: number): string {
  const d = new Date(EPOCH + Math.round(serial * 86400000));
  const p2 = (n: number) => String(n).padStart(2, '0');
  const tokens = pattern.replace(/\[[^\]]*\]/g, '').match(/"[^"]*"|\\.|yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|AM\/PM|./gi) || [];
  let out = '';
  let afterHour = false;
  tokens.forEach((tok, i) => {
    const t = tok.toLowerCase();
    const nextIsSec = tokens.slice(i + 1).some((x) => /^s{1,2}$/i.test(x)) && !tokens.slice(i + 1).some((x) => /^[dy]/i.test(x));
    if (tok.startsWith('"')) out += tok.slice(1, -1);
    else if (tok.startsWith('\\')) out += tok.slice(1);
    else if (t === 'yyyy') out += d.getUTCFullYear();
    else if (t === 'yy') out += p2(d.getUTCFullYear() % 100);
    else if (t === 'mmmm') out += MONTHS[d.getUTCMonth()];
    else if (t === 'mmm') out += MONTHS_SHORT[d.getUTCMonth()];
    else if (t === 'mm' || t === 'm') out += (afterHour || nextIsSec) ? (t === 'mm' ? p2(d.getUTCMinutes()) : d.getUTCMinutes()) : (t === 'mm' ? p2(d.getUTCMonth() + 1) : d.getUTCMonth() + 1);
    else if (t === 'dddd') out += DAYS[d.getUTCDay()];
    else if (t === 'ddd') out += DAYS[d.getUTCDay()].slice(0, 2);
    else if (t === 'dd') out += p2(d.getUTCDate());
    else if (t === 'd') out += d.getUTCDate();
    else if (t === 'hh') { out += p2(d.getUTCHours()); afterHour = true; return; }
    else if (t === 'h') { out += d.getUTCHours(); afterHour = true; return; }
    else if (t === 'ss') out += p2(d.getUTCSeconds());
    else if (t === 's') out += d.getUTCSeconds();
    else out += tok;
    if (/[a-z]/i.test(t)) afterHour = false;
  });
  return out;
}

export function displayText(cell: Cell | undefined, style: Style | null): string {
  if (!cell) return '';
  const v = cell.v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'ИСТИНА' : 'ЛОЖЬ';
  if (typeof v === 'number') {
    const pattern = (style?.n as { pattern?: string } | undefined)?.pattern;
    if (pattern && /[dmyhs]/i.test(pattern.replace(/"[^"]*"|\[[^\]]*\]/g, ''))) return formatDate(pattern, v);
    if (pattern && pattern !== 'General' && ssf) {
      try { return ruNumber(ssf.format(pattern, v)); } catch { /* непонятный формат — как обычное число */ }
    }
    if (!Number.isFinite(v)) return String(v);
    const rounded = Math.abs(v) >= 1e11 || (Math.abs(v) < 1e-9 && v !== 0) ? v.toExponential(5) : String(Number(v.toPrecision(11)));
    return rounded.replace('.', ',');
  }
  return String(v).replace(/\r\n?/g, '\n');
}

/** Число справа, текст слева — если выравнивание не задано (как в Excel). */
export function autoAlign(cell: Cell | undefined): 'left' | 'right' | 'center' {
  if (!cell) return 'left';
  if (typeof cell.v === 'number') return 'right';
  if (typeof cell.v === 'boolean') return 'center';
  return 'left';
}
