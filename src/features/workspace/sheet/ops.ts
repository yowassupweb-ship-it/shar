import type { LiveOp } from '../live/channel';
import { styleOf, type Book, type Cell, type Range, type Sheet, type Style, Styles } from './model';
import { shiftRefs } from './refs';
import { readFilters, writeFilters, type FilterColumn, type SheetFilter } from './filter';
import { readExtras, SET_EXTRA, shiftExtras, writeExtras, type ExtraKey, type SheetExtras } from './extras';

/** Дополнения листа (условия, флажки, заметки, объекты, группы, защита) — вслед за вставкой/удалением строк. */
function shiftSheetExtras(book: Book, sheetId: string, rows: boolean, start: number, delta: number) {
  const all = readExtras(book);
  if (!all[sheetId]) return;
  all[sheetId] = shiftExtras(all[sheetId], rows, start, delta);
  writeExtras(book, all);
}

/** Формулы всей книги — вслед за вставкой или удалением строк (столбцов) листа (sheet/refs.ts). */
function shiftFormulas(book: Book, target: Sheet, rows: boolean, start: number, delta: number) {
  for (const id of book.sheetOrder) {
    const own = book.sheets[id];
    if (!own) continue;
    for (const row of Object.values(own.cellData || {})) for (const cell of Object.values(row || {})) {
      if (cell?.f) cell.f = shiftRefs(String(cell.f), own.name, target.name, rows, start, delta);
    }
  }
}

/**
 * Правки листа — мутации в формате прежнего редактора (id и параметры мутаций Univer Sheets, без unitId), поэтому
 * их понимает общий перенос правок (live/sheetTransform.ts) и коллеги, открывшие таблицу в Univer.
 *
 * set-range-values: cellValue = {строка: {столбец: ячейка}}; null — очистить ячейку целиком; у ячейки меняются только
 * пришедшие поля (v, f, s, t…), значение null — убрать поле. Стиль в правке — само оформление (объект), не id.
 */

export const OP = {
  VALUES: 'sheet.mutation.set-range-values',
  INSERT_ROW: 'sheet.mutation.insert-row',
  INSERT_COL: 'sheet.mutation.insert-col',
  REMOVE_ROWS: 'sheet.mutation.remove-rows',
  REMOVE_COL: 'sheet.mutation.remove-col',
  COL_WIDTH: 'sheet.mutation.set-worksheet-col-width',
  ROW_HEIGHT: 'sheet.mutation.set-worksheet-row-height',
  ADD_MERGE: 'sheet.mutation.add-worksheet-merge',
  REMOVE_MERGE: 'sheet.mutation.remove-worksheet-merge',
  ROW_HIDDEN: 'sheet.mutation.set-row-hidden',
  ROW_VISIBLE: 'sheet.mutation.set-row-visible',
  COL_HIDDEN: 'sheet.mutation.set-col-hidden',
  COL_VISIBLE: 'sheet.mutation.set-col-visible',
  INSERT_SHEET: 'sheet.mutation.insert-sheet',
  REMOVE_SHEET: 'sheet.mutation.remove-sheet',
  RENAME_SHEET: 'sheet.mutation.set-worksheet-name',
  FREEZE: 'sheet.mutation.set-frozen',
  FILTER_RANGE: 'sheet.mutation.set-filter-range',
  FILTER_CRITERIA: 'sheet.mutation.set-filter-criteria',
  FILTER_REMOVE: 'sheet.mutation.remove-filter',
  GRIDLINES: 'sheet.mutation.toggle-gridlines',
  EXTRA: SET_EXTRA,
} as const;

type Matrix = Record<string, Record<string, Cell | null>>;
const FIELDS = ['v', 'f', 's', 't', 'p', 'si', 'custom'] as const;

const sheetOf = (book: Book, op: LiveOp) => book.sheets[String(op.params.subUnitId)] as Sheet | undefined;

/** Ячейка для правки: стиль — объектом (у коллег свой реестр стилей). */
export function wireCell(book: Book, cell: Cell | null | undefined): Cell | null {
  if (!cell) return null;
  const out: Cell = { ...cell };
  if (typeof out.s === 'string') out.s = (styleOf(book, out) as Cell['s']) ?? null;
  return out;
}

/** Обратная правка (для «Отменить»): снимается до применения прямой. null — отменить нечего. */
export function inverseOf(book: Book, op: LiveOp): LiveOp[] {
  const sheet = sheetOf(book, op);
  const p = op.params as Record<string, unknown>;
  switch (op.id) {
    case OP.VALUES: {
      if (!sheet) return [];
      const back: Matrix = {};
      for (const [r, cols] of Object.entries((p.cellValue as Matrix) || {})) {
        for (const [c, next] of Object.entries(cols || {})) {
          const prev = sheet.cellData?.[Number(r)]?.[Number(c)];
          let cell: Cell | null;
          if (!next || !prev) cell = prev ? wireCell(book, prev) : null;
          else {
            cell = {};
            for (const k of FIELDS) if (k in next) (cell as Record<string, unknown>)[k] = k === 's' ? (styleOf(book, prev) ?? null) : ((prev as Record<string, unknown>)[k] ?? null);
          }
          (back[r] ||= {})[c] = cell;
        }
      }
      return [{ id: OP.VALUES, params: { subUnitId: p.subUnitId, cellValue: back } }];
    }
    case OP.INSERT_ROW: return [{ id: OP.REMOVE_ROWS, params: { subUnitId: p.subUnitId, range: p.range } }];
    case OP.INSERT_COL: return [{ id: OP.REMOVE_COL, params: { subUnitId: p.subUnitId, range: p.range } }];
    case OP.REMOVE_ROWS:
    case OP.REMOVE_COL: {
      if (!sheet) return [];
      const range = p.range as Range;
      const rows = op.id === OP.REMOVE_ROWS;
      const insert: LiveOp = { id: rows ? OP.INSERT_ROW : OP.INSERT_COL, params: { subUnitId: p.subUnitId, range } };
      // Вернуть содержимое удалённых строк (столбцов).
      const back: Matrix = {};
      for (const [r, cols] of Object.entries(sheet.cellData || {})) {
        for (const [c, cell] of Object.entries(cols || {})) {
          const ri = Number(r); const ci = Number(c);
          const hit = rows ? ri >= range.startRow && ri <= range.endRow : ci >= range.startColumn && ci <= range.endColumn;
          if (hit && cell) (back[r] ||= {})[c] = wireCell(book, cell);
        }
      }
      const sizes: LiveOp[] = [];
      for (let i = rows ? range.startRow : range.startColumn; i <= (rows ? range.endRow : range.endColumn); i += 1) {
        const size = rows ? sheet.rowData?.[i]?.h : sheet.columnData?.[i]?.w;
        if (size) sizes.push(rows
          ? { id: OP.ROW_HEIGHT, params: { subUnitId: p.subUnitId, ranges: [{ startRow: i, endRow: i, startColumn: 0, endColumn: 0 }], rowHeight: size } }
          : { id: OP.COL_WIDTH, params: { subUnitId: p.subUnitId, ranges: [{ startRow: 0, endRow: 0, startColumn: i, endColumn: i }], colWidth: size } });
      }
      return [insert, ...(Object.keys(back).length ? [{ id: OP.VALUES, params: { subUnitId: p.subUnitId, cellValue: back } }] : []), ...sizes];
    }
    case OP.COL_WIDTH:
    case OP.ROW_HEIGHT: {
      if (!sheet) return [];
      const rows = op.id === OP.ROW_HEIGHT;
      const out: LiveOp[] = [];
      for (const r of (p.ranges as Range[]) || []) {
        for (let i = rows ? r.startRow : r.startColumn; i <= (rows ? r.endRow : r.endColumn); i += 1) {
          const prev = rows ? sheet.rowData?.[i]?.h : sheet.columnData?.[i]?.w;
          const one = rows ? { startRow: i, endRow: i, startColumn: 0, endColumn: 0 } : { startRow: 0, endRow: 0, startColumn: i, endColumn: i };
          out.push({ id: op.id, params: { subUnitId: p.subUnitId, ranges: [one], [rows ? 'rowHeight' : 'colWidth']: prev ?? (rows ? 24 : 88) } });
        }
      }
      return out;
    }
    case OP.ADD_MERGE: return [{ id: OP.REMOVE_MERGE, params: { subUnitId: p.subUnitId, ranges: p.ranges } }];
    case OP.REMOVE_MERGE: {
      if (!sheet) return [];
      const gone = (sheet.mergeData || []).filter((m) => ((p.ranges as Range[]) || []).some((r) => r.startRow <= m.endRow && m.startRow <= r.endRow && r.startColumn <= m.endColumn && m.startColumn <= r.endColumn));
      return gone.length ? [{ id: OP.ADD_MERGE, params: { subUnitId: p.subUnitId, ranges: gone } }] : [];
    }
    case OP.ROW_HIDDEN: return [{ id: OP.ROW_VISIBLE, params: { ...p } }];
    case OP.ROW_VISIBLE: return [{ id: OP.ROW_HIDDEN, params: { ...p } }];
    case OP.COL_HIDDEN: return [{ id: OP.COL_VISIBLE, params: { ...p } }];
    case OP.COL_VISIBLE: return [{ id: OP.COL_HIDDEN, params: { ...p } }];
    case OP.INSERT_SHEET: return [{ id: OP.REMOVE_SHEET, params: { subUnitId: (p.sheet as Sheet).id, subUnitName: (p.sheet as Sheet).name } }];
    case OP.REMOVE_SHEET: {
      if (!sheet) return [];
      const cellData: Matrix = {};
      for (const [r, cols] of Object.entries(sheet.cellData || {})) for (const [c, cell] of Object.entries(cols || {})) (cellData[r] ||= {})[c] = wireCell(book, cell);
      const extras = readExtras(book)[sheet.id] || {};
      return [{ id: OP.INSERT_SHEET, params: { index: book.sheetOrder.indexOf(sheet.id), sheet: { ...sheet, cellData } } },
        ...Object.entries(extras).map(([key, value]) => ({ id: OP.EXTRA, params: { subUnitId: sheet.id, key, value } }))];
    }
    case OP.RENAME_SHEET: return sheet ? [{ id: OP.RENAME_SHEET, params: { subUnitId: p.subUnitId, name: sheet.name, oldName: p.name } }] : [];
    case OP.FILTER_RANGE:
    case OP.FILTER_CRITERIA:
    case OP.FILTER_REMOVE: {
      // Обратная к любой правке фильтра — вернуть его целиком: диапазон и условия каждого столбца (или убрать, если не было).
      const prev = readFilters(book)[String(p.subUnitId)];
      if (!prev) return [{ id: OP.FILTER_REMOVE, params: { subUnitId: p.subUnitId } }];
      const back: LiveOp[] = [{ id: OP.FILTER_RANGE, params: { subUnitId: p.subUnitId, range: prev.ref, filteredOutRows: prev.cachedFilteredOut || [] } }];
      const cols = new Set<number>([...(prev.filterColumns || []).map((c) => c.colId), ...(op.id === OP.FILTER_CRITERIA ? [Number(p.col)] : [])]);
      for (const col of cols) back.push({ id: OP.FILTER_CRITERIA, params: { subUnitId: p.subUnitId, col, criteria: (prev.filterColumns || []).find((c) => c.colId === col) ?? null, filteredOutRows: prev.cachedFilteredOut || [] } });
      return back;
    }
    case OP.EXTRA: {
      const prev = readExtras(book)[String(p.subUnitId)]?.[p.key as ExtraKey];
      return [{ id: OP.EXTRA, params: { subUnitId: p.subUnitId, key: p.key, value: prev === undefined ? null : JSON.parse(JSON.stringify(prev)) } }];
    }
    case OP.GRIDLINES: return sheet ? [{ id: OP.GRIDLINES, params: { subUnitId: p.subUnitId, showGridlines: sheet.showGridlines === 0 ? 0 : 1 } }] : [];
    case OP.FREEZE: return sheet ? [{ id: OP.FREEZE, params: { subUnitId: p.subUnitId, ...(sheet.freeze || { startRow: -1, startColumn: -1, xSplit: 0, ySplit: 0 }) } }] : [];
    default: return [];
  }
}

/** Сдвиг ключей матрицы: всё начиная с `start` — на `delta` (отрицательный — удаление `-delta` штук). */
function shiftKeys<T>(obj: Record<number, T> | undefined, start: number, delta: number): Record<number, T> {
  const out: Record<number, T> = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const i = Number(k);
    if (i < start) out[i] = v;
    else if (delta < 0 && i < start - delta) continue;
    else out[i + delta] = v;
  }
  return out;
}

function shiftMerges(sheet: Sheet, rows: boolean, start: number, delta: number) {
  const [a, b] = rows ? ['startRow', 'endRow'] as const : ['startColumn', 'endColumn'] as const;
  const out: Range[] = [];
  for (const m of sheet.mergeData || []) {
    const r = { ...m };
    if (delta > 0) {
      if (r[a] >= start) r[a] += delta;
      if (r[b] >= start) r[b] += delta;
    } else {
      const lo = start; const hi = start - delta - 1;
      if (r[a] > hi) { r[a] += delta; r[b] += delta; } else if (r[b] >= lo) {
        // Удалённые строки внутри объединения — оно сжимается; удалено целиком — пропадает.
        const s = r[a] < lo ? r[a] : lo;
        const e = r[b] > hi ? r[b] + delta : lo - 1;
        if (e < s) continue;
        r[a] = s; r[b] = e;
      }
    }
    if (r.startRow === r.endRow && r.startColumn === r.endColumn) continue;
    out.push(r);
  }
  sheet.mergeData = out;
}

/** Применить правку к книге. false — правка неизвестна этому редактору (её покажет только перечитывание). */
export function applyOp(book: Book, styles: Styles, op: LiveOp): boolean {
  const p = op.params as Record<string, unknown>;
  const sheet = sheetOf(book, op);
  switch (op.id) {
    case OP.VALUES: {
      if (!sheet) return true;
      sheet.cellData ||= {};
      for (const [r, cols] of Object.entries((p.cellValue as Matrix) || {})) {
        for (const [c, next] of Object.entries(cols || {})) {
          const ri = Number(r); const ci = Number(c);
          if (!next) { if (sheet.cellData[ri]) delete sheet.cellData[ri][ci]; continue; }
          const cell: Record<string, unknown> = { ...(sheet.cellData[ri]?.[ci] || {}) };
          for (const k of FIELDS) {
            if (!(k in next)) continue;
            let val = (next as Record<string, unknown>)[k];
            if (k === 's' && val && typeof val === 'object') val = styles.ensure(val as Style);
            if (val === null || val === undefined) delete cell[k]; else cell[k] = val;
          }
          if (!Object.keys(cell).length) { if (sheet.cellData[ri]) delete sheet.cellData[ri][ci]; continue; }
          (sheet.cellData[ri] ||= {})[ci] = cell as Cell;
        }
      }
      return true;
    }
    case OP.INSERT_ROW:
    case OP.REMOVE_ROWS: {
      if (!sheet) return true;
      const range = p.range as Range;
      const count = range.endRow - range.startRow + 1;
      const delta = op.id === OP.INSERT_ROW ? count : -count;
      sheet.cellData = shiftKeys(sheet.cellData, range.startRow, delta);
      sheet.rowData = shiftKeys(sheet.rowData, range.startRow, delta);
      shiftMerges(sheet, true, range.startRow, delta);
      shiftFormulas(book, sheet, true, range.startRow, delta);
      shiftSheetExtras(book, sheet.id, true, range.startRow, delta);
      sheet.rowCount = Math.max(1, (sheet.rowCount || 100) + delta);
      const info = p.rowInfo as Record<string, { h?: number }> | undefined;
      if (info && delta > 0) for (const [k, v] of Object.entries(info)) if (v?.h) (sheet.rowData ||= {})[range.startRow + Number(k)] = { h: v.h };
      return true;
    }
    case OP.INSERT_COL:
    case OP.REMOVE_COL: {
      if (!sheet) return true;
      const range = p.range as Range;
      const count = range.endColumn - range.startColumn + 1;
      const delta = op.id === OP.INSERT_COL ? count : -count;
      const cells: Sheet['cellData'] = {};
      for (const [r, cols] of Object.entries(sheet.cellData || {})) cells[Number(r)] = shiftKeys(cols, range.startColumn, delta);
      sheet.cellData = cells;
      sheet.columnData = shiftKeys(sheet.columnData, range.startColumn, delta);
      shiftMerges(sheet, false, range.startColumn, delta);
      shiftFormulas(book, sheet, false, range.startColumn, delta);
      shiftSheetExtras(book, sheet.id, false, range.startColumn, delta);
      sheet.columnCount = Math.max(1, (sheet.columnCount || 26) + delta);
      return true;
    }
    case OP.COL_WIDTH:
    case OP.ROW_HEIGHT: {
      if (!sheet) return true;
      const rows = op.id === OP.ROW_HEIGHT;
      const size = (rows ? p.rowHeight : p.colWidth) as number | Record<string, number | null>;
      for (const r of (p.ranges as Range[]) || []) {
        const from = rows ? r.startRow : r.startColumn;
        const to = rows ? r.endRow : r.endColumn;
        for (let i = from; i <= to; i += 1) {
          const v = typeof size === 'number' ? size : (size?.[i] ?? size?.[i - from] ?? null);
          if (!v) continue;
          if (rows) (sheet.rowData ||= {})[i] = { ...(sheet.rowData?.[i] || {}), h: v };
          else (sheet.columnData ||= {})[i] = { ...(sheet.columnData?.[i] || {}), w: v };
        }
      }
      return true;
    }
    case OP.ADD_MERGE: {
      if (!sheet) return true;
      const add = (p.ranges as Range[]) || [];
      sheet.mergeData = [...(sheet.mergeData || []).filter((m) => !add.some((r) => r.startRow <= m.endRow && m.startRow <= r.endRow && r.startColumn <= m.endColumn && m.startColumn <= r.endColumn)), ...add];
      return true;
    }
    case OP.REMOVE_MERGE: {
      if (!sheet) return true;
      const rm = (p.ranges as Range[]) || [];
      sheet.mergeData = (sheet.mergeData || []).filter((m) => !rm.some((r) => r.startRow <= m.endRow && m.startRow <= r.endRow && r.startColumn <= m.endColumn && m.startColumn <= r.endColumn));
      return true;
    }
    case OP.ROW_HIDDEN: case OP.ROW_VISIBLE: case OP.COL_HIDDEN: case OP.COL_VISIBLE: {
      if (!sheet) return true;
      const rows = op.id === OP.ROW_HIDDEN || op.id === OP.ROW_VISIBLE;
      const hide = op.id === OP.ROW_HIDDEN || op.id === OP.COL_HIDDEN;
      for (const r of (p.ranges as Range[]) || []) {
        for (let i = rows ? r.startRow : r.startColumn; i <= (rows ? r.endRow : r.endColumn); i += 1) {
          const data = rows ? (sheet.rowData ||= {}) : (sheet.columnData ||= {});
          const cur = { ...(data[i] || {}) } as { hd?: number };
          if (hide) cur.hd = 1; else delete cur.hd;
          data[i] = cur;
        }
      }
      return true;
    }
    case OP.INSERT_SHEET: {
      const incoming = p.sheet as Sheet;
      if (!incoming?.id || book.sheets[incoming.id]) return true;
      const cellData: Sheet['cellData'] = {};
      for (const [r, cols] of Object.entries(incoming.cellData || {})) {
        for (const [c, cell] of Object.entries(cols || {})) {
          if (!cell) continue;
          const s = cell.s && typeof cell.s === 'object' ? styles.ensure(cell.s as Style) : (typeof cell.s === 'string' ? ((p.styles as Record<string, Style> | undefined)?.[cell.s] ? styles.ensure((p.styles as Record<string, Style>)[cell.s]) : cell.s) : null);
          (cellData[Number(r)] ||= {})[Number(c)] = { ...cell, ...(s ? { s } : { s: undefined }) };
        }
      }
      book.sheets[incoming.id] = { ...incoming, rowCount: incoming.rowCount || 100, columnCount: incoming.columnCount || 26, cellData } as Sheet;
      const at = Math.max(0, Math.min(book.sheetOrder.length, Number(p.index) || book.sheetOrder.length));
      book.sheetOrder.splice(at, 0, incoming.id);
      return true;
    }
    case OP.REMOVE_SHEET: {
      const id = String(p.subUnitId);
      delete book.sheets[id];
      book.sheetOrder = book.sheetOrder.filter((x) => x !== id);
      const all = readExtras(book);
      if (all[id]) { delete all[id]; writeExtras(book, all); }
      return true;
    }
    case OP.RENAME_SHEET: if (sheet) sheet.name = String(p.name || sheet.name); return true;
    case OP.FILTER_RANGE: {
      const all = readFilters(book);
      const id = String(p.subUnitId);
      const prev: SheetFilter | undefined = all[id];
      all[id] = { ref: p.range as Range, filterColumns: prev?.filterColumns || [], cachedFilteredOut: (p.filteredOutRows as number[] | undefined) ?? prev?.cachedFilteredOut ?? [] };
      writeFilters(book, all);
      return true;
    }
    case OP.FILTER_CRITERIA: {
      const all = readFilters(book);
      const f = all[String(p.subUnitId)];
      if (!f) return true;
      const col = Number(p.col);
      f.filterColumns = [...(f.filterColumns || []).filter((c) => c.colId !== col), ...(p.criteria ? [{ ...(p.criteria as FilterColumn), colId: col }] : [])];
      if (Array.isArray(p.filteredOutRows)) f.cachedFilteredOut = p.filteredOutRows as number[];
      writeFilters(book, all);
      return true;
    }
    case OP.FILTER_REMOVE: {
      const all = readFilters(book);
      delete all[String(p.subUnitId)];
      writeFilters(book, all);
      return true;
    }
    case OP.EXTRA: {
      const all = readExtras(book);
      const id = String(p.subUnitId);
      const cur: SheetExtras = { ...(all[id] || {}) };
      if (p.value === null || p.value === undefined) delete cur[p.key as ExtraKey]; else (cur as Record<string, unknown>)[String(p.key)] = p.value;
      all[id] = cur;
      writeExtras(book, all);
      return true;
    }
    case OP.GRIDLINES: if (sheet) sheet.showGridlines = Number(p.showGridlines) ? 1 : 0; return true;
    case OP.FREEZE: {
      if (!sheet) return true;
      const sr = Number(p.startRow); const sc = Number(p.startColumn);
      if (sr <= 0 && sc <= 0) delete sheet.freeze;
      else sheet.freeze = { startRow: Math.max(0, sr), startColumn: Math.max(0, sc), ySplit: Math.max(0, Number(p.ySplit ?? sr)), xSplit: Math.max(0, Number(p.xSplit ?? sc)) };
      return true;
    }
    default:
      return false;
  }
}
