import type { Book, Range } from './model';

/**
 * Дополнения листа, которых нет в модели ячеек: условное форматирование, проверка данных (флажки, списки), заметки,
 * картинки и диаграммы, группы строк/столбцов, защищённые диапазоны. Лежат ресурсами книги (book.resources, как фильтр)
 * по id листа; в xlsx — своей частью файла (xl/shar/extras.json) и, где у формата есть своё, ещё и им (lib/workbookExtras.ts).
 *
 * Правка — одна мутация «заменить дополнение листа целиком» (shar.mutation.set-extra): просто для отмены и совместной
 * правки. При вставке/удалении строк и столбцов диапазоны сдвигаются у всех одинаково (shiftExtras).
 */

export const SET_EXTRA = 'shar.mutation.set-extra';

export interface CfStyle { bg?: string; cl?: string; bl?: 1; it?: 1; ul?: 1; st?: 1 }
export interface CfPoint { type: 'min' | 'max' | 'num' | 'percent' | 'percentile'; value?: number; color: string }
export interface CfRule {
  id: string;
  ranges: Range[];
  kind: 'cell' | 'text' | 'blank' | 'notBlank' | 'formula' | 'scale' | 'duplicate' | 'unique';
  /** cell: gt gte lt lte eq ne between notBetween; text: contains notContains begins ends textEq; date: dateBefore dateAfter dateEq */
  op?: string;
  values?: string[];
  style?: CfStyle;
  scale?: { min: CfPoint; mid?: CfPoint; max: CfPoint };
}
export interface DvRule { id: string; ranges: Range[]; kind: 'checkbox' | 'list'; values?: string[]; strict?: boolean; chips?: boolean }
export interface SheetObject {
  id: string; kind: 'image' | 'chart';
  /** Левый верхний угол — ячейка и сдвиг в ней (px), размер — px (при масштабе 100%). */
  row: number; col: number; dx: number; dy: number; w: number; h: number;
  src?: string; alt?: string;
  chart?: ChartSpec;
}
export interface ChartSpec {
  type: 'column' | 'bar' | 'line' | 'area' | 'pie' | 'doughnut' | 'scatter';
  range: Range;
  title?: string;
  /** Первая строка — названия рядов, первый столбец — подписи по оси X. */
  headers?: boolean; labels?: boolean;
  /** Ряды — по столбцам (как Google по умолчанию) или по строкам. */
  byRows?: boolean;
  stacked?: boolean; legend?: 'right' | 'bottom' | 'none';
  colors?: string[];
}
export interface Group { start: number; end: number; collapsed?: boolean }
/** Чередование цветов (как в Google): строка заголовка, цвета нечётных и чётных строк, иногда — строка итогов. */
export interface Banding { id: string; range: Range; header?: string; odd: string; even: string; footer?: string }
export interface Protection { id: string; range: Range; owner: string; editors: string[]; description?: string; warnOnly?: boolean }

export interface SheetExtras {
  cf?: CfRule[];
  dv?: DvRule[];
  notes?: Record<string, string>;
  objects?: SheetObject[];
  groups?: { rows?: Group[]; cols?: Group[] };
  protect?: Protection[];
  banding?: Banding[];
  /** Правила условного форматирования из Excel, которых редактор не показывает (значки, гистограммы) — пишутся обратно как были. */
  cfNative?: unknown[];
  /** Масштаб листа у этого файла (как в Google — у каждого листа свой). */
  zoom?: number;
}
export type ExtraKey = keyof SheetExtras;

export const EXTRAS_RESOURCE = 'SHAR_SHEET_EXTRAS';

export function readExtras(book: Book): Record<string, SheetExtras> {
  const res = book.resources?.find((r) => r.name === EXTRAS_RESOURCE);
  try { return res?.data ? JSON.parse(res.data) as Record<string, SheetExtras> : {}; } catch { return {}; }
}
export function writeExtras(book: Book, all: Record<string, SheetExtras>) {
  const rest = (book.resources || []).filter((r) => r.name !== EXTRAS_RESOURCE);
  const clean = Object.fromEntries(Object.entries(all).filter(([, v]) => v && Object.values(v).some((x) => x !== undefined && (!Array.isArray(x) || x.length) && (typeof x !== 'object' || Object.keys(x).length))));
  book.resources = Object.keys(clean).length ? [...rest, { name: EXTRAS_RESOURCE, data: JSON.stringify(clean) }] : rest;
}
export const sheetExtras = (book: Book, sheetId: string): SheetExtras => readExtras(book)[sheetId] || {};

export const newId = (p: string) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ── Сдвиг при вставке/удалении строк и столбцов ──────────────────────────────────────────────────────────────

function shiftSpan(a: number, b: number, start: number, delta: number): [number, number] | null {
  if (delta > 0) return [a >= start ? a + delta : a, b >= start ? b + delta : b];
  const end = start - delta;
  const na = a < start ? a : a >= end ? a + delta : start;
  const nb = b < start ? b : b >= end ? b + delta : start - 1;
  return nb < na ? null : [na, nb];
}
function shiftRange(r: Range, rows: boolean, start: number, delta: number): Range | null {
  const s = rows ? shiftSpan(r.startRow, r.endRow, start, delta) : shiftSpan(r.startColumn, r.endColumn, start, delta);
  if (!s) return null;
  return rows ? { ...r, startRow: s[0], endRow: s[1] } : { ...r, startColumn: s[0], endColumn: s[1] };
}
const shiftRanges = (list: Range[], rows: boolean, start: number, delta: number) => list.map((r) => shiftRange(r, rows, start, delta)).filter((r): r is Range => Boolean(r));

/** Дополнения листа после вставки (delta > 0) или удаления (delta < 0) строк/столбцов начиная с start. */
export function shiftExtras(x: SheetExtras, rows: boolean, start: number, delta: number): SheetExtras {
  const out: SheetExtras = { ...x };
  if (x.cf) out.cf = x.cf.map((r) => ({ ...r, ranges: shiftRanges(r.ranges, rows, start, delta) })).filter((r) => r.ranges.length);
  if (x.dv) out.dv = x.dv.map((r) => ({ ...r, ranges: shiftRanges(r.ranges, rows, start, delta) })).filter((r) => r.ranges.length);
  if (x.banding) out.banding = x.banding.map((bd) => { const range = shiftRange(bd.range, rows, start, delta); return range ? { ...bd, range } : null; }).filter((bd): bd is Banding => Boolean(bd));
  if (x.protect) out.protect = x.protect.map((p) => { const range = shiftRange(p.range, rows, start, delta); return range ? { ...p, range } : null; }).filter((p): p is Protection => Boolean(p));
  if (x.notes) {
    const notes: Record<string, string> = {};
    for (const [key, text] of Object.entries(x.notes)) {
      const [r, c] = key.split(':').map(Number);
      const p = rows ? r : c;
      let np = p;
      if (delta > 0 && p >= start) np = p + delta;
      if (delta < 0) { if (p >= start && p < start - delta) continue; if (p >= start - delta) np = p + delta; }
      notes[rows ? `${np}:${c}` : `${r}:${np}`] = text;
    }
    out.notes = notes;
  }
  if (x.objects) {
    out.objects = x.objects.map((o) => {
      const p = rows ? o.row : o.col;
      let np = p;
      if (delta > 0 && p >= start) np = p + delta;
      if (delta < 0 && p >= start) np = Math.max(start, p + delta);
      const chart = o.chart ? { ...o.chart, range: shiftRange(o.chart.range, rows, start, delta) ?? o.chart.range } : undefined;
      return rows ? { ...o, row: np, chart } : { ...o, col: np, chart };
    });
  }
  if (x.groups) {
    const key = rows ? 'rows' : 'cols';
    const list = x.groups[key];
    if (list) out.groups = { ...x.groups, [key]: list.map((g) => { const s = shiftSpan(g.start, g.end, start, delta); return s ? { ...g, start: s[0], end: s[1] } : null; }).filter((g): g is Group => Boolean(g)) };
  }
  return out;
}

// ── Именованные диапазоны (на всю книгу): имя → «Лист!A1:B5» ──────────────────────────────────────────────
export const NAMES_RESOURCE = 'SHAR_NAMED_RANGES';
export const SET_NAMES = 'shar.mutation.set-names';
export function readNames(book: Book): Record<string, string> {
  const res = book.resources?.find((r) => r.name === NAMES_RESOURCE);
  try { return res?.data ? JSON.parse(res.data) as Record<string, string> : {}; } catch { return {}; }
}
export function writeNames(book: Book, names: Record<string, string>) {
  const rest = (book.resources || []).filter((r) => r.name !== NAMES_RESOURCE);
  book.resources = Object.keys(names).length ? [...rest, { name: NAMES_RESOURCE, data: JSON.stringify(names) }] : rest;
}

export const inAny = (ranges: Range[], r: number, c: number) => ranges.some((x) => r >= x.startRow && r <= x.endRow && c >= x.startColumn && c <= x.endColumn);
