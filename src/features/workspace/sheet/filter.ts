import { displayText, styleOf, type Book, type Range, type Sheet } from './model';

/**
 * Фильтр листа — как у прежнего редактора: ресурс книги SHEET_FILTER_PLUGIN {id листа: {ref, filterColumns,
 * cachedFilteredOut}} (его же пишет и читает xlsx, lib/workbook.ts). Первая строка диапазона — заголовки со
 * стрелками, условия — по номеру столбца листа: список видимых значений (filters) или сравнения (customFilters).
 * Скрытые фильтром строки (cachedFilteredOut) пересчитываются при смене условий — как в Excel, не на каждую правку.
 */

export const FILTER_RESOURCE = 'SHEET_FILTER_PLUGIN';

export interface FilterColumn {
  colId: number;
  filters?: { blank?: true; filters?: string[] };
  customFilters?: { and?: 1; customFilters: Array<{ val: string | number; operator?: string }> };
}
export interface SheetFilter { ref: Range; filterColumns?: FilterColumn[]; cachedFilteredOut?: number[] }

export function readFilters(book: Book): Record<string, SheetFilter> {
  const res = book.resources?.find((r) => r.name === FILTER_RESOURCE);
  try { return res?.data ? JSON.parse(res.data) as Record<string, SheetFilter> : {}; } catch { return {}; }
}

export function writeFilters(book: Book, filters: Record<string, SheetFilter>) {
  const rest = (book.resources || []).filter((r) => r.name !== FILTER_RESOURCE);
  book.resources = Object.keys(filters).length ? [...rest, { name: FILTER_RESOURCE, data: JSON.stringify(filters) }] : rest;
}

const num = (v: unknown) => (typeof v === 'number' ? v : Number(String(v).replace(',', '.')));

function passesCustom(text: string, raw: unknown, rule: { val: string | number; operator?: string }): boolean {
  const op = rule.operator || 'equal';
  const a = num(raw); const b = num(rule.val);
  const numeric = Number.isFinite(a) && Number.isFinite(b) && raw !== '' && raw !== null && raw !== undefined;
  switch (op) {
    case 'greaterThan': return numeric && a > b;
    case 'greaterThanOrEqual': return numeric && a >= b;
    case 'lessThan': return numeric && a < b;
    case 'lessThanOrEqual': return numeric && a <= b;
    case 'notEqual': return !wildcard(String(rule.val)).test(text);
    default: return wildcard(String(rule.val)).test(text);
  }
}
/** «*» и «?» в условии — как в Excel. */
const wildcard = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');

/** Строки диапазона фильтра, которые условия прячут (номера строк листа). */
export function filteredRows(book: Book, sheet: Sheet, filter: SheetFilter): number[] {
  const out: number[] = [];
  const cols = (filter.filterColumns || []).filter((c) => c.filters || c.customFilters);
  if (!cols.length) return out;
  for (let r = filter.ref.startRow + 1; r <= filter.ref.endRow; r += 1) {
    const ok = cols.every((fc) => {
      const cell = sheet.cellData?.[r]?.[fc.colId];
      const text = displayText(cell, styleOf(book, cell));
      if (fc.filters) {
        if (!text) return Boolean(fc.filters.blank);
        return (fc.filters.filters || []).includes(text);
      }
      const rules = fc.customFilters!.customFilters || [];
      return fc.customFilters!.and ? rules.every((rule) => passesCustom(text, cell?.v, rule)) : rules.some((rule) => passesCustom(text, cell?.v, rule));
    });
    if (!ok) out.push(r);
  }
  return out;
}

/** Значения столбца в диапазоне фильтра (для списка галочек) — без повторов, по порядку. */
export function columnValues(book: Book, sheet: Sheet, filter: SheetFilter, col: number): { values: string[]; blank: boolean } {
  const seen = new Set<string>();
  let blank = false;
  for (let r = filter.ref.startRow + 1; r <= filter.ref.endRow; r += 1) {
    const cell = sheet.cellData?.[r]?.[col];
    const text = displayText(cell, styleOf(book, cell));
    if (!text) blank = true; else seen.add(text);
  }
  return { values: [...seen].sort((a, b) => a.localeCompare(b, 'ru', { numeric: true })), blank };
}

/** Сплошной блок данных вокруг ячейки (как «текущая область» Excel): для фильтра и сортировки без выделения. */
export function dataRegion(sheet: Sheet, row: number, col: number): Range {
  const filled = (r: number, c: number) => { const x = sheet.cellData?.[r]?.[c]; return Boolean(x && ((x.v !== null && x.v !== undefined && x.v !== '') || x.f)); };
  const r0 = { startRow: row, endRow: row, startColumn: col, endColumn: col };
  let grew = true;
  let guard = 0;
  while (grew && guard < 500) {
    grew = false; guard += 1;
    const rowHas = (r: number) => { for (let c = Math.max(0, r0.startColumn - 1); c <= r0.endColumn + 1; c += 1) if (filled(r, c)) return true; return false; };
    const colHas = (c: number) => { for (let r = Math.max(0, r0.startRow - 1); r <= r0.endRow + 1; r += 1) if (filled(r, c)) return true; return false; };
    if (r0.startRow > 0 && rowHas(r0.startRow - 1)) { r0.startRow -= 1; grew = true; }
    if (rowHas(r0.endRow + 1)) { r0.endRow += 1; grew = true; }
    if (r0.startColumn > 0 && colHas(r0.startColumn - 1)) { r0.startColumn -= 1; grew = true; }
    if (colHas(r0.endColumn + 1)) { r0.endColumn += 1; grew = true; }
  }
  return r0;
}
