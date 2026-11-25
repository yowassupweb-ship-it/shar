/**
 * Ссылки в формулах при вставке и удалении строк (столбцов), как в Excel: =A1*10 после вставки строки над первой
 * становится =A2*10, диапазон растягивается или сжимается, ссылка на удалённую ячейку — #REF!. Абсолютные ($A$1)
 * сдвигаются так же: «$» запрещает сдвиг только при копировании.
 *
 * Правят у себя все участники, применяя одну и ту же правку (sheet/ops.ts), поэтому формулы у всех одинаковые.
 */

const colIndex = (letters: string) => { let c = 0; for (const ch of letters.toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64); return c - 1; };
const colLetters = (c: number) => { let s = ''; let n = c + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

interface Shift { rows: boolean; start: number; delta: number }

/** Новое место одной координаты; null — строка (столбец) удалена. */
function movePoint(p: number, s: Shift): number | null {
  if (s.delta > 0) return p >= s.start ? p + s.delta : p;
  const end = s.start - s.delta;
  if (p < s.start) return p;
  if (p < end) return null;
  return p + s.delta;
}

/** Новые края диапазона [a, b]; null — удалён целиком. */
function moveSpan(a: number, b: number, s: Shift): [number, number] | null {
  if (s.delta > 0) return [a >= s.start ? a + s.delta : a, b >= s.start ? b + s.delta : b];
  const end = s.start - s.delta;
  const na = a < s.start ? a : a >= end ? a + s.delta : s.start;
  const nb = b < s.start ? b : b >= end ? b + s.delta : s.start - 1;
  return nb < na ? null : [na, nb];
}

const CELL = /^(\$?)([A-Z]{1,3})(\$?)(\d{1,7})$/i;

/**
 * Переписать формулу после сдвига строк/столбцов листа `target`. `own` — лист, где стоит формула: ссылки без имени
 * листа относятся к нему.
 */
export function shiftRefs(formula: string, own: string, target: string, rows: boolean, start: number, delta: number): string {
  const s: Shift = { rows, start, delta };
  const sameSheet = (prefix: string | undefined) => {
    if (!prefix) return own === target;
    const name = prefix.slice(0, -1).replace(/^'(.*)'$/, '$1').replace(/''/g, "'");
    return name.toLowerCase() === target.toLowerCase();
  };
  // Строки в кавычках не трогаем; ссылка — ячейка или диапазон, не часть имени функции (LOG10() и не имя листа.
  return formula.replace(/("(?:[^"]|"")*")|((?:'(?:[^']|'')+'|[A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё.]*)!)?(?<![\w.$])(\$?[A-Z]{1,3}\$?\d{1,7})(?::(\$?[A-Z]{1,3}\$?\d{1,7}))?(?![\w(!])/gi,
    (m, str: string | undefined, prefix: string | undefined, first: string, second: string | undefined) => {
      if (str || !sameSheet(prefix)) return m;
      const p = CELL.exec(first);
      const q = second ? CELL.exec(second) : null;
      if (!p) return m;
      const pre = prefix || '';
      const fmt = (x: RegExpExecArray, row: number, col: number) => `${x[1]}${colLetters(col)}${x[3]}${row + 1}`;
      const r1 = Number(p[4]) - 1; const c1 = colIndex(p[2]);
      if (!q) {
        const moved = movePoint(rows ? r1 : c1, s);
        if (moved === null) return `${pre}#REF!`;
        return pre + fmt(p, rows ? moved : r1, rows ? c1 : moved);
      }
      const r2 = Number(q[4]) - 1; const c2 = colIndex(q[2]);
      const span = moveSpan(rows ? Math.min(r1, r2) : Math.min(c1, c2), rows ? Math.max(r1, r2) : Math.max(c1, c2), s);
      if (!span) return `${pre}#REF!`;
      return rows
        ? `${pre}${fmt(p, span[0], c1)}:${fmt(q, span[1], c2)}`
        : `${pre}${fmt(p, r1, span[0])}:${fmt(q, r2, span[1])}`;
    });
}

/**
 * Переписать ссылки на лист target по перестановке строк (rows) или столбцов: индекс i → map(i). Нужен при
 * перетаскивании строк за номера: ссылки следуют за ячейками, как в Google (A2 → A4, если строка 2 уехала на 4-ю).
 */
export function remapRefs(formula: string, own: string, target: string, rows: boolean, map: (i: number) => number, breaks: number[] = []): string {
  // Диапазон после перестановки — от наименьшего до наибольшего нового индекса его строк. map кусочно-линейна, поэтому
  // достаточно концов диапазона и точек излома (breaks), попавших внутрь.
  const spanOf = (lo: number, hi: number) => { const xs = [lo, hi, ...breaks.filter((x) => x > lo && x < hi)].map(map); return [Math.min(...xs), Math.max(...xs)]; };
  const sameSheet = (prefix: string | undefined) => {
    if (!prefix) return own === target;
    const name = prefix.slice(0, -1).replace(/^'(.*)'$/, '$1').replace(/''/g, "'");
    return name.toLowerCase() === target.toLowerCase();
  };
  return formula.replace(/("(?:[^"]|"")*")|((?:'(?:[^']|'')+'|[A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё.]*)!)?(?<![\w.$])(\$?[A-Z]{1,3}\$?\d{1,7})(?::(\$?[A-Z]{1,3}\$?\d{1,7}))?(?![\w(!])/gi,
    (m, str: string | undefined, prefix: string | undefined, first: string, second: string | undefined) => {
      if (str || !sameSheet(prefix)) return m;
      const p = CELL.exec(first);
      const q = second ? CELL.exec(second) : null;
      if (!p) return m;
      const pre = prefix || '';
      const fmt = (x: RegExpExecArray, row: number, col: number) => `${x[1]}${colLetters(col)}${x[3]}${row + 1}`;
      const r1 = Number(p[4]) - 1; const c1 = colIndex(p[2]);
      if (!q) return pre + fmt(p, rows ? map(r1) : r1, rows ? c1 : map(c1));
      const r2 = Number(q[4]) - 1; const c2 = colIndex(q[2]);
      if (rows) { const [a, b] = spanOf(Math.min(r1, r2), Math.max(r1, r2)); return `${pre}${fmt(p, a, c1)}:${fmt(q, b, c2)}`; }
      const [a, b] = spanOf(Math.min(c1, c2), Math.max(c1, c2));
      return `${pre}${fmt(p, r1, a)}:${fmt(q, r2, b)}`;
    });
}
