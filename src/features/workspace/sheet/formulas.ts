import FormulaParser from 'fast-formula-parser';
import { setNumberFormatter, usedBounds, type Book, type Cell, type Sheet } from './model';

/**
 * Формулы своего редактора — движок fast-formula-parser (MIT, ~280 функций Excel). Значения формул считаются у
 * каждого на месте (как у прежнего редактора): по сети ходит сама формула, результат пишется в ячейку (v) — его же
 * сохраняет xlsx для Excel и Google Таблиц.
 *
 * Пересчёт — всех формул книги «по требованию»: ячейка считается при первом обращении, ссылки на другие формулы —
 * рекурсивно с памятью, круговая ссылка — ошибка #REF!. Русские имена функций (СУММ, ЕСЛИ…) переводятся в английские.
 */

type FP = {
  parse: (formula: string, position: { sheet: string; row: number; col: number }, allowArray?: boolean) => unknown;
};
type FPCtor = (new (config: Record<string, unknown>) => FP) & { SSF: { format: (pattern: string, value: number) => string } };
const Parser = FormulaParser as unknown as FPCtor;

/** Все функции движка (английские имена) — для подсказки при наборе формулы. */
let supported: string[] | null = null;
export function supportedFunctions(): string[] {
  if (!supported) {
    try { supported = ((new Parser({}) as unknown as { supportedFunctions: () => string[] }).supportedFunctions() || []).slice().sort(); } catch { supported = []; }
  }
  return supported;
}
setNumberFormatter(Parser.SSF);

/** Русские названия функций (как в русском Excel) → английские, понятные движку. */
export const RU_FUNCTIONS: Record<string, string> = {
  СУММ: 'SUM', СРЗНАЧ: 'AVERAGE', МИН: 'MIN', МАКС: 'MAX', СЧЁТ: 'COUNT', СЧЕТ: 'COUNT', СЧЁТЗ: 'COUNTA', СЧЕТЗ: 'COUNTA', ЕСЛИ: 'IF',
  СУММЕСЛИ: 'SUMIF', СЧЁТЕСЛИ: 'COUNTIF', СЧЕТЕСЛИ: 'COUNTIF', ОКРУГЛ: 'ROUND', ОКРУГЛВВЕРХ: 'ROUNDUP', ОКРУГЛВНИЗ: 'ROUNDDOWN',
  СЕГОДНЯ: 'TODAY', ТДАТА: 'NOW', ВПР: 'VLOOKUP', ГПР: 'HLOOKUP', ИНДЕКС: 'INDEX', И: 'AND', ИЛИ: 'OR', НЕ: 'NOT', ЕСЛИОШИБКА: 'IFERROR',
  СЦЕПИТЬ: 'CONCATENATE', ЛЕВСИМВ: 'LEFT', ПРАВСИМВ: 'RIGHT', ПСТР: 'MID', ДЛСТР: 'LEN', ТЕКСТ: 'TEXT', ABS: 'ABS', ОСТАТ: 'MOD',
  ГОД: 'YEAR', МЕСЯЦ: 'MONTH', ДЕНЬ: 'DAY', ДАТА: 'DATE', СТЕПЕНЬ: 'POWER', КОРЕНЬ: 'SQRT', ПРОИЗВЕД: 'PRODUCT', ЦЕЛОЕ: 'INT',
  ПРОПИСН: 'UPPER', СТРОЧН: 'LOWER', СЖПРОБЕЛЫ: 'TRIM', СУММПРОИЗВ: 'SUMPRODUCT', ДНЕЙ: 'DAYS', ЕПУСТО: 'ISBLANK', ЕЧИСЛО: 'ISNUMBER',
};
const ruToEn = (f: string) => f.replace(/("[^"]*")|([А-ЯЁA-Z][А-ЯЁA-Z.]*)\s*\(/gi, (m, str: string | undefined, name: string | undefined) => {
  if (str) return m;
  const en = RU_FUNCTIONS[(name || '').toUpperCase()];
  return en ? m.replace(name!, en) : m;
});

const isError = (v: unknown): v is { error?: string; toString: () => string } => Boolean(v && typeof v === 'object' && !Array.isArray(v) && 'error' in (v as object));

/** Значение формулы для ячейки: число, строка, логическое; ошибка — её текст (#DIV/0! …). */
function toCellValue(v: unknown): string | number | boolean | null {
  let x = v;
  while (Array.isArray(x)) x = x[0];
  if (x === undefined || x === null) return 0;
  if (isError(x)) return String(x.error || x.toString());
  if (typeof x === 'number' || typeof x === 'string' || typeof x === 'boolean') return x;
  return String(x);
}

/**
 * Пересчитать все формулы книги. Возвращает ячейки, у которых поменялось значение (`sheetId:row:col`), —
 * чтобы перерисовать только их.
 */
export function recalc(book: Book): Set<string> {
  const changed = new Set<string>();
  const byName = new Map<string, Sheet>();
  for (const id of book.sheetOrder) { const s = book.sheets[id] as Sheet | undefined; if (s) byName.set(s.name.toLowerCase(), s); }
  const bounds = new Map<string, { rows: number; cols: number }>();
  const boundsOf = (s: Sheet) => { let b = bounds.get(s.id); if (!b) { b = usedBounds(s); bounds.set(s.id, b); } return b; };
  const memo = new Map<string, unknown>();
  const visiting = new Set<string>();
  let current: Sheet | null = null;

  const valueOf = (sheet: Sheet, r: number, c: number): unknown => {
    const cell = sheet.cellData?.[r]?.[c];
    if (!cell) return undefined;
    if (cell.f) return evaluate(sheet, r, c, cell);
    return cell.v === null ? undefined : cell.v;
  };
  const sheetFor = (name: string | undefined) => (name ? byName.get(name.toLowerCase()) : current) ?? current;

  const parser = new Parser({
    onCell: (ref: { sheet?: string; row: number; col: number }) => {
      const s = sheetFor(ref.sheet);
      return s ? valueOf(s, ref.row - 1, ref.col - 1) : undefined;
    },
    onRange: (ref: { sheet?: string; from: { row: number; col: number }; to: { row: number; col: number } }) => {
      const s = sheetFor(ref.sheet);
      if (!s) return [[]];
      const b = boundsOf(s);
      // Целые столбцы (A:A) и строки — только до последней занятой ячейки, иначе миллион пустых строк.
      const toRow = Math.min(ref.to.row, Math.max(ref.from.row, b.rows));
      const toCol = Math.min(ref.to.col, Math.max(ref.from.col, b.cols));
      const out: unknown[][] = [];
      for (let r = ref.from.row; r <= toRow; r += 1) {
        const line: unknown[] = [];
        for (let c = ref.from.col; c <= toCol; c += 1) line.push(valueOf(s, r - 1, c - 1));
        out.push(line);
      }
      return out;
    },
  });

  function evaluate(sheet: Sheet, r: number, c: number, cell: Cell): unknown {
    const key = `${sheet.id}:${r}:${c}`;
    if (memo.has(key)) return memo.get(key);
    if (visiting.has(key)) return '#REF!';
    visiting.add(key);
    const prev = current;
    current = sheet;
    let value: unknown;
    try {
      const text = ruToEn(String(cell.f).replace(/^=/, ''));
      value = toCellValue(parser.parse(text, { sheet: sheet.name, row: r + 1, col: c + 1 }));
    } catch (e) {
      value = isError(e) ? String((e as { error?: string }).error || e) : '#ERROR!';
    } finally {
      current = prev;
      visiting.delete(key);
    }
    memo.set(key, value);
    return value;
  }

  for (const id of book.sheetOrder) {
    const sheet = book.sheets[id] as Sheet | undefined;
    if (!sheet) continue;
    for (const [rk, row] of Object.entries(sheet.cellData || {})) {
      for (const [ck, cell] of Object.entries(row || {})) {
        if (!cell?.f) continue;
        const r = Number(rk); const c = Number(ck);
        const v = evaluate(sheet, r, c, cell) as Cell['v'];
        if (cell.v !== v) {
          cell.v = v;
          cell.t = typeof v === 'number' ? 2 : typeof v === 'boolean' ? 3 : 1;
          changed.add(`${sheet.id}:${r}:${c}`);
        }
      }
    }
  }
  return changed;
}

/** Сдвинуть относительные ссылки формулы (при копировании и автозаполнении): A1 → B2 при сдвиге на (1, 1). */
export function shiftFormula(f: string, dr: number, dc: number): string {
  return f.replace(/("[^"]*")|(\$?)([A-Z]{1,3})(\$?)(\d{1,7})(?![\w(])/g, (m, str, colAbs: string, col: string, rowAbs: string, row: string) => {
    if (str) return m;
    let c = 0;
    for (const ch of col) c = c * 26 + (ch.charCodeAt(0) - 64);
    const nc = colAbs ? c : c + dc;
    const nr = rowAbs ? Number(row) : Number(row) + dr;
    if (nc < 1 || nr < 1) return '#REF!';
    let name = '';
    let n = nc;
    while (n > 0) { const k = (n - 1) % 26; name = String.fromCharCode(65 + k) + name; n = Math.floor((n - 1) / 26); }
    return `${colAbs}${name}${rowAbs}${nr}`;
  });
}

/**
 * Вычислитель формулы «на месте» без пересчёта книги — для условного форматирования («Своя формула»): ссылки
 * берут уже посчитанные значения ячеек (v). Один парсер на отрисовку.
 */
export function formulaEvaluator(book: Book): (sheet: Sheet, formula: string, row: number, col: number) => unknown {
  const byName = new Map<string, Sheet>();
  for (const id of book.sheetOrder) { const s = book.sheets[id] as Sheet | undefined; if (s) byName.set(s.name.toLowerCase(), s); }
  let current: Sheet | null = null;
  const sheetFor = (name: string | undefined) => (name ? byName.get(name.toLowerCase()) : current) ?? current;
  const value = (s: Sheet, r: number, c: number) => { const v = s.cellData?.[r]?.[c]?.v; return v === null ? undefined : v; };
  const parser = new Parser({
    onCell: (ref: { sheet?: string; row: number; col: number }) => { const s = sheetFor(ref.sheet); return s ? value(s, ref.row - 1, ref.col - 1) : undefined; },
    onRange: (ref: { sheet?: string; from: { row: number; col: number }; to: { row: number; col: number } }) => {
      const s = sheetFor(ref.sheet);
      if (!s) return [[]];
      const b = usedBounds(s);
      const out: unknown[][] = [];
      for (let r = ref.from.row; r <= Math.min(ref.to.row, Math.max(ref.from.row, b.rows)); r += 1) {
        const line: unknown[] = [];
        for (let c = ref.from.col; c <= Math.min(ref.to.col, Math.max(ref.from.col, b.cols)); c += 1) line.push(value(s, r - 1, c - 1));
        out.push(line);
      }
      return out;
    },
  });
  return (sheet, formula, row, col) => {
    current = sheet;
    try { return toCellValue(parser.parse(ruToEn(formula.replace(/^=/, '')), { sheet: sheet.name, row: row + 1, col: col + 1 })); } catch { return false; }
  };
}
