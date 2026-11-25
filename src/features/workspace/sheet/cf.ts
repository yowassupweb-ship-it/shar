import { formulaEvaluator, shiftFormula } from './formulas';
import { displayText, styleOf, type Book, type Cell, type Range, type Sheet } from './model';
import type { CfPoint, CfRule, CfStyle } from './extras';

/**
 * Условное форматирование как в Google Таблицах: правила по порядку, у ячейки — оформление первого подходящего
 * правила «один цвет» и цвет первой подходящей шкалы. Подготовка (минимумы/максимумы шкал, повторы) — раз на правку.
 */

export interface CfHit { style?: CfStyle; fill?: string }
export type CfLookup = (r: number, c: number, cell: Cell | undefined) => CfHit | null;

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.replace(',', '.').replace(/\s/g, '')))) return Number(v.replace(',', '.').replace(/\s/g, ''));
  return null;
};
const parseVal = (s: string | undefined): number | string => { const n = num(s ?? ''); return n === null ? (s ?? '') : n; };

function hexToRgb(h: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(h) || ['', 'ffffff'];
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as [number, number, number];
}
const mix = (a: string, b: string, t: number) => {
  const [x, y] = [hexToRgb(a), hexToRgb(b)];
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * Math.max(0, Math.min(1, t))).toString(16).padStart(2, '0')).join('')}`;
};

function inRanges(ranges: Range[], r: number, c: number) {
  for (const x of ranges) if (r >= x.startRow && r <= x.endRow && c >= x.startColumn && c <= x.endColumn) return x;
  return null;
}

/** Числа правила (для шкал и повторов) — по всем его диапазонам, не дальше данных листа. */
function valuesOf(sheet: Sheet, ranges: Range[]): unknown[] {
  const out: unknown[] = [];
  for (const x of ranges) {
    for (const [rk, row] of Object.entries(sheet.cellData || {})) {
      const r = Number(rk);
      if (r < x.startRow || r > x.endRow) continue;
      for (const [ck, cell] of Object.entries(row || {})) {
        const c = Number(ck);
        if (c >= x.startColumn && c <= x.endColumn && cell?.v !== null && cell?.v !== undefined && cell.v !== '') out.push(cell.v);
      }
    }
  }
  return out;
}

function pointValue(p: CfPoint, nums: number[]): number {
  if (!nums.length) return 0;
  const min = Math.min(...nums); const max = Math.max(...nums);
  if (p.type === 'min') return min;
  if (p.type === 'max') return max;
  if (p.type === 'num') return p.value ?? 0;
  if (p.type === 'percent') return min + ((max - min) * (p.value ?? 50)) / 100;
  const sorted = [...nums].sort((a, b) => a - b);
  const k = Math.max(0, Math.min(sorted.length - 1, Math.round(((p.value ?? 50) / 100) * (sorted.length - 1))));
  return sorted[k];
}

const EPOCH = Date.UTC(1899, 11, 30);
const todaySerial = () => { const d = new Date(); return (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - EPOCH) / 86400000; };

export function buildCf(book: Book, sheet: Sheet, rules: CfRule[] | undefined): CfLookup | null {
  if (!rules?.length) return null;
  const evalF = rules.some((r) => r.kind === 'formula') ? formulaEvaluator(book) : null;
  const prepared = rules.map((rule) => {
    if (rule.kind === 'scale' && rule.scale) {
      const nums = valuesOf(sheet, rule.ranges).map(num).filter((x): x is number => x !== null);
      return { rule, lo: pointValue(rule.scale.min, nums), mid: rule.scale.mid ? pointValue(rule.scale.mid, nums) : null, hi: pointValue(rule.scale.max, nums) };
    }
    if (rule.kind === 'duplicate' || rule.kind === 'unique') {
      const counts = new Map<string, number>();
      for (const v of valuesOf(sheet, rule.ranges)) { const k = String(v).toLowerCase(); counts.set(k, (counts.get(k) || 0) + 1); }
      return { rule, counts };
    }
    return { rule };
  });

  const matches = (p: (typeof prepared)[number], r: number, c: number, cell: Cell | undefined, at: Range): boolean => {
    const { rule } = p;
    const v = cell?.v;
    const empty = v === null || v === undefined || v === '';
    const text = cell ? displayText(cell, styleOf(book, cell)) : '';
    const vals = rule.values || [];
    switch (rule.kind) {
      case 'blank': return empty;
      case 'notBlank': return !empty;
      case 'duplicate': case 'unique': {
        if (empty) return false;
        const n = (p as { counts: Map<string, number> }).counts.get(String(v).toLowerCase()) || 0;
        return rule.kind === 'duplicate' ? n > 1 : n === 1;
      }
      case 'text': {
        if (empty) return rule.op === 'notContains';
        const t = text.toLowerCase(); const q = (vals[0] || '').toLowerCase();
        if (rule.op === 'contains') return t.includes(q);
        if (rule.op === 'notContains') return !t.includes(q);
        if (rule.op === 'begins') return t.startsWith(q);
        if (rule.op === 'ends') return t.endsWith(q);
        return t === q;
      }
      case 'cell': {
        if (empty) return false;
        const op = rule.op || 'gt';
        if (op === 'dateBefore' || op === 'dateAfter' || op === 'dateEq') {
          const n = num(v); if (n === null) return false;
          const ref = vals[0] === 'today' || !vals[0] ? todaySerial() : num(vals[0]) ?? todaySerial();
          return op === 'dateBefore' ? Math.floor(n) < ref : op === 'dateAfter' ? Math.floor(n) > ref : Math.floor(n) === ref;
        }
        const a = parseVal(vals[0]); const b = parseVal(vals[1]);
        const x = num(v);
        const cmp = (y: number | string) => (typeof y === 'number' && x !== null ? x - y : String(text).localeCompare(String(y), 'ru', { sensitivity: 'base' }));
        if (op === 'gt') return cmp(a) > 0;
        if (op === 'gte') return cmp(a) >= 0;
        if (op === 'lt') return cmp(a) < 0;
        if (op === 'lte') return cmp(a) <= 0;
        if (op === 'eq') return cmp(a) === 0;
        if (op === 'ne') return cmp(a) !== 0;
        if (op === 'between' || op === 'notBetween') { const inside = cmp(a) >= 0 && cmp(b) <= 0; return op === 'between' ? inside : !inside; }
        return false;
      }
      case 'formula': {
        const f = vals[0];
        if (!f || !evalF) return false;
        // Формула пишется для левой верхней ячейки диапазона и сдвигается, как при копировании.
        const shifted = shiftFormula(f.startsWith('=') ? f : `=${f}`, r - at.startRow, c - at.startColumn);
        const out = evalF(sheet, shifted, r, c);
        return out === true || (typeof out === 'number' && out !== 0) || (typeof out === 'string' && out.toUpperCase() === 'TRUE');
      }
      default: return false;
    }
  };

  return (r, c, cell) => {
    let style: CfStyle | undefined;
    let fill: string | undefined;
    for (const p of prepared) {
      const at = inRanges(p.rule.ranges, r, c);
      if (!at) continue;
      if (p.rule.kind === 'scale') {
        if (fill) continue;
        const x = num(cell?.v);
        if (x === null || !p.rule.scale) continue;
        const { lo, hi, mid } = p as { lo: number; hi: number; mid: number | null };
        const sc = p.rule.scale;
        if (mid !== null && sc.mid) fill = x <= mid ? mix(sc.min.color, sc.mid.color, (x - lo) / ((mid - lo) || 1)) : mix(sc.mid.color, sc.max.color, (x - mid) / ((hi - mid) || 1));
        else fill = mix(sc.min.color, sc.max.color, (x - lo) / ((hi - lo) || 1));
        continue;
      }
      if (style) continue;
      if (matches(p, r, c, cell, at)) style = p.rule.style || {};
    }
    return style || fill ? { style, fill } : null;
  };
}

/** Описание правила по-русски — для списка правил на панели. */
export function cfSummary(rule: CfRule): string {
  const v = rule.values || [];
  const OPS: Record<string, string> = {
    gt: 'Больше', gte: 'Больше или равно', lt: 'Меньше', lte: 'Меньше или равно', eq: 'Равно', ne: 'Не равно', between: 'Между', notBetween: 'Не между',
    contains: 'Текст содержит', notContains: 'Текст не содержит', begins: 'Текст начинается с', ends: 'Текст заканчивается на', textEq: 'Текст в точности',
    dateBefore: 'Дата до', dateAfter: 'Дата после', dateEq: 'Дата',
  };
  if (rule.kind === 'scale') return 'Цветовая шкала';
  if (rule.kind === 'blank') return 'Ячейка пуста';
  if (rule.kind === 'notBlank') return 'Ячейка не пуста';
  if (rule.kind === 'duplicate') return 'Повторяющиеся значения';
  if (rule.kind === 'unique') return 'Уникальные значения';
  if (rule.kind === 'formula') return `Своя формула: ${v[0] || ''}`;
  const op = OPS[rule.op || 'gt'] || '';
  if (rule.op === 'between' || rule.op === 'notBetween') return `${op} ${v[0] ?? ''} и ${v[1] ?? ''}`;
  if (rule.op?.startsWith('date')) return `${op} ${v[0] === 'today' || !v[0] ? 'сегодня' : v[0]}`;
  return `${op} ${v[0] ?? ''}`;
}
