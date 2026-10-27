import { CommandType, ICommandService, IUndoRedoService, IUniverInstanceService, type IMutationInfo, type Workbook } from '@univerjs/core';
import { transformLists, type LiveChannel, type LiveOp, type Transform } from './channel';

/**
 * Таблица (Univer Sheets) в совместной правке. Правки — мутации листа: значения и оформление ячеек
 * (set-range-values), вставка и удаление строк и столбцов, ширины, объединения, фильтр, листы.
 *
 * Перенос (transform) — по смыслу таблицы:
 *  - двое изменили одну ячейку — побеждает более поздняя в общем порядке (как в Google Таблицах), разные ячейки и
 *    даже разные свойства одной ячейки (значение у одного, заливка у другого) сохраняются оба;
 *  - коллега вставил или удалил строки (столбцы) — наши адреса ячеек и диапазоны сдвигаются вслед, правки в
 *    удалённых строках пропадают вместе с ними;
 *  - лист удалён — правки на нём пропадают.
 */

type Axis = 'row' | 'col';
interface Shift { sheet: string; axis: Axis; kind: 'insert' | 'remove'; start: number; count: number }
interface Range { startRow: number; endRow: number; startColumn: number; endColumn: number; [key: string]: unknown }
type Matrix = Record<string, Record<string, Record<string, unknown> | null>>;

const VALUES = 'sheet.mutation.set-range-values';
const REMOVE_SHEET = 'sheet.mutation.remove-sheet';
const STRUCTURAL: Record<string, { axis: Axis; kind: 'insert' | 'remove' }> = {
  'sheet.mutation.insert-row': { axis: 'row', kind: 'insert' },
  'sheet.mutation.insert-col': { axis: 'col', kind: 'insert' },
  'sheet.mutation.remove-rows': { axis: 'row', kind: 'remove' },
  'sheet.mutation.remove-col': { axis: 'col', kind: 'remove' },
};

/** Мутации, которые меняют файл и нужны остальным. Пересчёт формул, фильтра и служебные метки у каждого свои. */
const LOCAL_ONLY = new Set([
  'sheet.mutation.data-validation-formula-mark-dirty', 'sheet.mutation.mark-dirty-filter-change', 'sheet.mutation.empty',
  'sheet.mutation.re-calc-filter', 'sheet.mutation.set-worksheet-row-auto-height',
]);
export function isSharedSheetMutation(id: string): boolean {
  if (LOCAL_ONLY.has(id)) return false;
  return id.startsWith('sheet.mutation.') || id.startsWith('sheets.mutation.') || id === 'formula.mutation.set-defined-name' || id === 'formula.mutation.remove-defined-name';
}

function shiftOf(op: LiveOp): Shift | null {
  const kind = STRUCTURAL[op.id];
  const range = op.params.range as Range | undefined;
  if (!kind || !range) return null;
  const start = kind.axis === 'row' ? range.startRow : range.startColumn;
  const end = kind.axis === 'row' ? range.endRow : range.endColumn;
  return { sheet: String(op.params.subUnitId), ...kind, start, count: end - start + 1 };
}

/**
 * Новое место индекса после сдвига. null — строка (столбец) удалена.
 * stay: индекс — место вставки, сделанной раньше в общем порядке, чем `by` (при равенстве она остаётся первой).
 */
function moveIndex(p: number, by: Shift, stay = false): number | null {
  if (by.kind === 'insert') return p > by.start || (p === by.start && !stay) ? p + by.count : p;
  if (p < by.start) return p;
  if (p < by.start + by.count) return null;
  return p - by.count;
}

/**
 * Место своей вставки после чужого сдвига. Вставка строго внутри строк, которые коллега удалил, пропадает (null):
 * удаление с той стороны тогда расширяется на неё (moveRange) — так у всех одинаково, в каком бы порядке ни пришло.
 */
function moveInsertPoint(p: number, by: Shift, stay: boolean): number | null {
  if (by.kind === 'insert') return moveIndex(p, by, stay);
  if (p <= by.start) return p;
  if (p >= by.start + by.count) return p - by.count;
  return null;
}

/** Диапазон после сдвига: вставка внутри — расширяет, удаление — обрезает; удалён целиком — null. */
function moveRange(range: Range, by: Shift): Range | null {
  const [a, b] = by.axis === 'row' ? ['startRow', 'endRow'] as const : ['startColumn', 'endColumn'] as const;
  const s = range[a];
  const e = range[b];
  if (by.kind === 'insert') {
    return { ...range, [a]: s >= by.start ? s + by.count : s, [b]: e >= by.start ? e + by.count : e };
  }
  const lo = by.start;
  const hi = by.start + by.count - 1;
  if (s >= lo && e <= hi) return null;
  const removedBefore = (p: number) => Math.max(0, Math.min(p, hi + 1) - lo);
  const ns = s < lo ? s : s > hi ? s - by.count : lo;
  const ne = e - removedBefore(e + 1);
  return { ...range, [a]: ns, [b]: Math.max(ns, ne) };
}

function moveMatrix(matrix: Matrix, by: Shift): Matrix {
  const out: Matrix = {};
  for (const [rk, cols] of Object.entries(matrix || {})) {
    const r = by.axis === 'row' ? moveIndex(Number(rk), by) : Number(rk);
    if (r === null || !cols) continue;
    for (const [ck, cell] of Object.entries(cols)) {
      const c = by.axis === 'col' ? moveIndex(Number(ck), by) : Number(ck);
      if (c === null) continue;
      (out[r] ||= {})[c] = cell;
    }
  }
  return out;
}

/** Объект «индекс → значение» (высоты строк, ширины столбцов) после сдвига. */
function moveKeyed(values: Record<string, unknown>, by: Shift): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const k = moveIndex(Number(key), by);
    if (k !== null) out[k] = value;
  }
  return out;
}

/** Правка `op` после сдвига `by` (сделанного раньше в общем порядке, если byFirst). null — правке не осталось места. */
function applyShift(op: LiveOp, by: Shift, byFirst: boolean): LiveOp | null {
  if (String(op.params.subUnitId) !== by.sheet) return op;
  const p: Record<string, unknown> = { ...op.params };
  const own = STRUCTURAL[op.id];
  if (own && own.axis === by.axis && p.range) {
    const range = p.range as Range;
    const [a, b] = by.axis === 'row' ? ['startRow', 'endRow'] as const : ['startColumn', 'endColumn'] as const;
    if (own.kind === 'insert') {
      // Своя вставка: сдвигается только место, сами вставленные строки остаются целиком.
      const at = moveInsertPoint(range[a], by, !byFirst);
      if (at === null) return null;
      p.range = { ...range, [a]: at, [b]: at + (range[b] - range[a]) };
    } else {
      const moved = moveRange(range, by);
      if (!moved) return null;
      p.range = moved;
    }
    return { id: op.id, params: p };
  }
  if (p.cellValue && typeof p.cellValue === 'object') p.cellValue = moveMatrix(p.cellValue as Matrix, by);
  if (p.range && typeof p.range === 'object' && !Array.isArray(p.range)) {
    const moved = moveRange(p.range as Range, by);
    if (!moved) return null;
    p.range = moved;
  }
  for (const key of ['ranges', 'range'] as const) {
    if (Array.isArray(p[key])) {
      const list = (p[key] as Range[]).map((r) => moveRange(r, by)).filter((r): r is Range => r !== null);
      if (!list.length) return null;
      p[key] = list;
    }
  }
  if (by.axis === 'row' && p.rowHeight && typeof p.rowHeight === 'object') p.rowHeight = moveKeyed(p.rowHeight as Record<string, unknown>, by);
  if (by.axis === 'row' && p.autoHeightInfo && typeof p.autoHeightInfo === 'object') p.autoHeightInfo = moveKeyed(p.autoHeightInfo as Record<string, unknown>, by);
  if (by.axis === 'col' && p.colWidth && typeof p.colWidth === 'object') p.colWidth = moveKeyed(p.colWidth as Record<string, unknown>, by);
  if (by.axis === 'col' && typeof p.col === 'number') {
    const col = moveIndex(p.col, by);
    if (col === null) return null;
    p.col = col;
  }
  return { id: op.id, params: p };
}

type Cell = Record<string, unknown>;

/** Оформление ячейки в правке — объект свойств (номера стилей переводятся в объекты ещё при отправке). */
const styleOf = (cell: Cell) => (cell.s && typeof cell.s === 'object' ? cell.s as Record<string, unknown> : null);

/**
 * Две записи одних ячеек: `l` (наша, позже в общем порядке) и `r` (чужая, раньше). Univer применяет запись так:
 * null — ячейка удаляется целиком, иначе ключи сливаются (оформление — по отдельным свойствам). Поэтому:
 *  - мы очищаем ячейку — чужая запись в неё не нужна;
 *  - коллега очистил её раньше — очистка побеждает и нашу правку этой ячейки (у сервера наша придёт после
 *    очистки, у нас очистка — после нашей; без этого правила вышло бы по-разному);
 *  - оба правят — из чужой убираем то, что перекрывает наша: значения ключей и свойства оформления.
 */
function cellsPair(l: LiveOp, r: LiveOp): [LiveOp | null, LiveOp | null] {
  if (String(l.params.subUnitId) !== String(r.params.subUnitId)) return [l, r];
  const mine = (l.params.cellValue || {}) as Matrix;
  const theirs = (r.params.cellValue || {}) as Matrix;
  const outL: Matrix = {};
  const outR: Matrix = {};
  let anyL = false;
  let anyR = false;
  const rows = new Set([...Object.keys(mine), ...Object.keys(theirs)]);
  for (const rk of rows) {
    const cols = new Set([...Object.keys(mine[rk] || {}), ...Object.keys(theirs[rk] || {})]);
    for (const ck of cols) {
      const inL = Boolean(mine[rk]) && ck in mine[rk];
      const inR = Boolean(theirs[rk]) && ck in theirs[rk];
      const a = inL ? mine[rk][ck] : undefined;
      const b = inR ? theirs[rk][ck] : undefined;
      let keepL: Cell | null | undefined = a;
      let keepR: Cell | null | undefined = b;
      if (inL && inR) {
        if (a === null) keepR = undefined;
        else if (b === null) keepL = undefined;
        else if (a && b) {
          const rest: Cell = {};
          for (const [key, value] of Object.entries(b)) {
            if (key === 's' && styleOf(a) && styleOf(b)) {
              const left = styleOf(a)!;
              const props = Object.entries(styleOf(b)!).filter(([prop]) => !(prop in left));
              if (props.length) rest.s = Object.fromEntries(props);
            } else if (!(key in a)) rest[key] = value;
          }
          keepR = Object.keys(rest).length ? rest : undefined;
        }
      }
      if (inL && keepL !== undefined) { (outL[rk] ||= {})[ck] = keepL; anyL = true; }
      if (inR && keepR !== undefined) { (outR[rk] ||= {})[ck] = keepR; anyR = true; }
    }
  }
  return [
    anyL ? { id: l.id, params: { ...l.params, cellValue: outL } } : null,
    anyR ? { id: r.id, params: { ...r.params, cellValue: outR } } : null,
  ];
}

function pair(l: LiveOp, r: LiveOp): [LiveOp | null, LiveOp | null] {
  if (r.id === REMOVE_SHEET && String(l.params.subUnitId) === String(r.params.subUnitId)) return [null, r];
  if (l.id === REMOVE_SHEET && String(r.params.subUnitId) === String(l.params.subUnitId)) return [l, null];
  const rs = shiftOf(r);
  const ls = shiftOf(l);
  if (rs || ls) {
    const l2 = rs ? applyShift(l, rs, true) : l;
    const r2 = ls ? applyShift(r, ls, false) : r;
    return [l2, r2];
  }
  if (l.id === VALUES && r.id === VALUES) return cellsPair(l, r);
  return [l, r];
}

export const sheetTransform: Transform = (local, remote) => transformLists(local, remote, pair);

/** В мутациях бывают ObjectMatrix и прочие классы — в канал уходит их обычный JSON. */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, v) => (v && typeof v === 'object' && typeof (v as { getMatrix?: unknown }).getMatrix === 'function' ? (v as { getMatrix: () => unknown }).getMatrix() : v)));
}

type Injector = { get: <T>(token: unknown) => T };
type UndoStacks = { _undoStacks: Map<string, Array<{ undoMutations: IMutationInfo[]; redoMutations: IMutationInfo[] }>>; _redoStacks: Map<string, unknown[]> };

/**
 * Подключить книгу к каналу. Свои мутации — в канал, чужие — в книгу как пришедшие извне (fromCollab, onlyLocal):
 * без своей истории отмены. История отмены сдвигается вслед за чужими вставками и удалениями строк и столбцов.
 */
export function bindSheet(injector: Injector, unitId: string, channel: LiveChannel, serialize: () => Promise<string>): () => void {
  const commands = injector.get<ICommandService>(ICommandService);
  const history = injector.get<IUndoRedoService>(IUndoRedoService) as unknown as Partial<UndoStacks>;

  const sub = commands.onCommandExecuted((command, options) => {
    if (command.type !== CommandType.MUTATION || !isSharedSheetMutation(command.id)) return;
    if (options?.fromCollab || options?.onlyLocal) return;
    const params = command.params as Record<string, unknown> | undefined;
    if (!params || (params.unitId && params.unitId !== unitId)) return;
    const { unitId: _unit, trigger: _trigger, ...rest } = params;
    const wire = plain(rest) as Record<string, unknown>;
    // Номер стиля есть только в реестре этой книги — коллегам уходит само оформление.
    if (wire.cellValue && typeof wire.cellValue === 'object') {
      const styles = injector.get<IUniverInstanceService>(IUniverInstanceService).getUnit<Workbook>(unitId)?.getStyles();
      for (const cols of Object.values(wire.cellValue as Matrix)) {
        for (const cell of Object.values(cols || {})) {
          if (cell && typeof cell.s === 'string') cell.s = (styles?.get(cell.s) as Record<string, unknown> | undefined) ?? null;
        }
      }
    }
    channel.local([{ id: command.id, params: wire }]);
  });

  const shiftHistory = (op: LiveOp) => {
    const by = shiftOf(op);
    if (by) {
      for (const item of history._undoStacks?.get(unitId) ?? []) {
        for (const list of [item.undoMutations, item.redoMutations]) {
          for (let i = list.length - 1; i >= 0; i -= 1) {
            const step = list[i];
            const moved = applyShift({ id: step.id, params: step.params as Record<string, unknown> }, by, true);
            if (moved) list[i] = { ...step, params: { ...moved.params, unitId } };
            else list.splice(i, 1);
          }
        }
      }
    }
    const redo = history._redoStacks?.get(unitId);
    if (redo) redo.length = 0;
  };

  const apply = (ops: LiveOp[]) => {
    for (const op of ops) {
      commands.syncExecuteCommand(op.id, { ...op.params, unitId }, { onlyLocal: true, fromCollab: true });
      shiftHistory(op);
    }
  };

  const detach = channel.attach({ apply, serialize });
  return () => { sub.dispose(); detach(); };
}
