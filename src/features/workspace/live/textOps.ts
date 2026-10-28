import { transformLists, type LiveOp, type Transform } from './channel';

/**
 * Заметка в совместной правке: текст Markdown, правка — классическая текстовая операция (как в ot.js):
 * число > 0 — пропустить столько символов, строка — вставить, число < 0 — удалить. Операция покрывает текст
 * целиком, поэтому перенос двух одновременных правок однозначен; при вставке в одно место первой встаёт та,
 * что раньше в общем порядке.
 */

type Part = number | string;
export const TEXT_OP = 'note.text';

function push(out: Part[], part: Part) {
  if (part === 0 || part === '') return;
  const last = out[out.length - 1];
  if (typeof part === 'string' && typeof last === 'string') out[out.length - 1] = last + part;
  else if (typeof part === 'number' && typeof last === 'number' && (part > 0) === (last > 0)) out[out.length - 1] = last + part;
  else out.push(part);
}

/** Разница двух текстов одной правкой: общее начало и общий конец остаются, середина заменяется. */
export function diffText(before: string, after: string): Part[] | null {
  if (before === after) return null;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end += 1;
  const out: Part[] = [];
  push(out, start);
  push(out, -(before.length - start - end));
  push(out, after.slice(start, after.length - end));
  push(out, end);
  return out;
}

export function applyText(text: string, op: Part[]): string {
  let at = 0;
  let out = '';
  for (const part of op) {
    if (typeof part === 'string') out += part;
    else if (part > 0) { out += text.slice(at, at + part); at += part; } else at -= part;
  }
  if (at !== text.length) throw new Error('note op does not match text');
  return out;
}

/** a и b сделаны от одного текста; возвращает [a', b']: apply(apply(t, a), b') === apply(apply(t, b), a'). Вставка a — первой. */
function transformParts(a: Part[], b: Part[]): [Part[], Part[]] {
  const a1: Part[] = [];
  const b1: Part[] = [];
  let i = 0;
  let j = 0;
  let x = a[i++];
  let y = b[j++];
  while (x !== undefined || y !== undefined) {
    if (typeof x === 'string') { push(a1, x); push(b1, x.length); x = a[i++]; continue; }
    if (typeof y === 'string') { push(a1, y.length); push(b1, y); y = b[j++]; continue; }
    if (x === undefined || y === undefined) throw new Error('note ops of different length');
    if (x > 0 && y > 0) {
      const m = Math.min(x, y);
      push(a1, m); push(b1, m);
      x -= m; y -= m;
    } else if (x < 0 && y < 0) {
      const m = Math.min(-x, -y);
      x += m; y += m;
    } else if (x < 0) {
      const m = Math.min(-x, y as number);
      push(a1, -m);
      x += m; y = (y as number) - m;
    } else {
      const m = Math.min(x, -(y as number));
      push(b1, -m);
      x -= m; y = (y as number) + m;
    }
    if (x === 0) x = a[i++];
    if (y === 0) y = b[j++];
  }
  return [a1, b1];
}

/** Перенос одной правки через одну: [a', b'], вставка a — первой. */
export function transformText(a: Part[], b: Part[]): [Part[], Part[]] {
  return transformParts(a, b);
}

const partsOf = (op: LiveOp) => op.params.o as Part[];

function pair(l: LiveOp, r: LiveOp): [LiveOp | null, LiveOp | null] {
  // r раньше в общем порядке — её вставка встаёт первой.
  const [r2, l2] = transformParts(partsOf(r), partsOf(l));
  return [{ id: TEXT_OP, params: { o: l2 } }, { id: TEXT_OP, params: { o: r2 } }];
}

export const textTransform: Transform = (local, remote) => transformLists(local, remote, pair);
