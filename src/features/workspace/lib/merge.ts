/**
 * Трёхстороннее слияние текста: общая основа (то, что было на сервере, когда человек начал печатать),
 * его правки и правки коллеги. Нужно заметкам: пока двое печатают в одной заметке, чужое попадает в текст
 * само, без вопросов «чью версию оставить». Идём по строкам; если двое тронули одну и ту же строку —
 * пробуем слить уже по символам (разные места одного абзаца сливаются). Совсем одно и то же место — конфликт.
 */

interface Hunk { a0: number; a1: number; repl: string[] }

const MAX_CELLS = 2_500_000;

/** Различия основы и новой версии: диапазоны основы [a0, a1) и чем они заменены. */
function diffHunks(base: string[], next: string[]): Hunk[] {
  let start = 0;
  while (start < base.length && start < next.length && base[start] === next[start]) start += 1;
  let endBase = base.length;
  let endNext = next.length;
  while (endBase > start && endNext > start && base[endBase - 1] === next[endNext - 1]) { endBase -= 1; endNext -= 1; }
  const A = base.slice(start, endBase);
  const B = next.slice(start, endNext);
  if (!A.length && !B.length) return [];
  if (!A.length || !B.length || A.length * B.length > MAX_CELLS) return [{ a0: start, a1: endBase, repl: B }];

  const w = B.length + 1;
  const table = new Uint32Array((A.length + 1) * w);
  for (let i = A.length - 1; i >= 0; i -= 1) {
    for (let j = B.length - 1; j >= 0; j -= 1) {
      table[i * w + j] = A[i] === B[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
    }
  }
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let open: Hunk | null = null;
  const close = () => { if (open) { hunks.push(open); open = null; } };
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) { close(); i += 1; j += 1; continue; }
    open ||= { a0: start + i, a1: start + i, repl: [] };
    if (j < B.length && (i === A.length || table[i * w + j + 1] >= table[(i + 1) * w + j])) { open.repl.push(B[j]); j += 1; } else { open.a1 = start + i + 1; i += 1; }
  }
  close();
  return hunks;
}

const overlaps = (x: Hunk, y: Hunk) => (x.a0 < y.a1 && y.a0 < x.a1) || (x.a0 === y.a0 && x.a1 === x.a0 && y.a1 === y.a0) || (x.a0 === y.a0 && x.a0 !== x.a1 && y.a0 !== y.a1);

function applyInside(base: string[], hunks: Hunk[], lo: number, hi: number): string[] {
  const out: string[] = [];
  let pos = lo;
  for (const h of hunks) { out.push(...base.slice(pos, h.a0), ...h.repl); pos = h.a1; }
  out.push(...base.slice(pos, hi));
  return out;
}

function mergeTokens(base: string[], a: string[], b: string[], fallback: ((x: string, y: string, z: string) => string | null) | null): string[] | null {
  const ha = diffHunks(base, a);
  const hb = diffHunks(base, b);
  const out: string[] = [];
  let pos = 0;
  let ia = 0;
  let ib = 0;
  while (ia < ha.length || ib < hb.length) {
    const x = ha[ia];
    const y = hb[ib];
    const first = !y || (x && x.a0 <= y.a0) ? x : y;
    const other = first === x ? y : x;
    if (!other || !overlaps(first, other)) {
      out.push(...base.slice(pos, first.a0), ...first.repl);
      pos = first.a1;
      if (first === x) ia += 1; else ib += 1;
      continue;
    }
    // Правки пересеклись: собираем всё, что цепляется друг за друга, в один участок.
    const lo = Math.min(first.a0, other.a0);
    let hi = Math.max(first.a1, other.a1);
    const clusterA: Hunk[] = [first === x ? first : other];
    const clusterB: Hunk[] = [first === x ? other : first];
    ia += 1;
    ib += 1;
    for (;;) {
      if (ia < ha.length && ha[ia].a0 < hi) { clusterA.push(ha[ia]); hi = Math.max(hi, ha[ia].a1); ia += 1; continue; }
      if (ib < hb.length && hb[ib].a0 < hi) { clusterB.push(hb[ib]); hi = Math.max(hi, hb[ib].a1); ib += 1; continue; }
      break;
    }
    out.push(...base.slice(pos, lo));
    const mine = applyInside(base, clusterA, lo, hi);
    const theirs = applyInside(base, clusterB, lo, hi);
    if (mine.join('') === theirs.join('')) out.push(...mine);
    else if (!clusterA.length) out.push(...theirs);
    else if (!clusterB.length) out.push(...mine);
    else {
      const merged = fallback ? fallback(base.slice(lo, hi).join(''), mine.join(''), theirs.join('')) : null;
      if (merged === null) return null;
      out.push(merged);
    }
    pos = hi;
  }
  out.push(...base.slice(pos));
  return out;
}

const lines = (text: string) => text.split(/(?<=\n)/);

/** Слить правки `mine` и `theirs`, сделанные от общей основы `base`. conflict — не получилось, решает человек. */
export function merge3(base: string, mine: string, theirs: string): { text: string; conflict: boolean } {
  if (mine === theirs) return { text: mine, conflict: false };
  if (base === mine) return { text: theirs, conflict: false };
  if (base === theirs) return { text: mine, conflict: false };
  const byChars = (x: string, y: string, z: string) => {
    const merged = mergeTokens([...x], [...y], [...z], null);
    return merged ? merged.join('') : null;
  };
  const merged = mergeTokens(lines(base), lines(mine), lines(theirs), byChars);
  return merged ? { text: merged.join(''), conflict: false } : { text: mine, conflict: true };
}

/**
 * Куда сместить курсор, когда текст вокруг изменили извне: общее начало и общий конец старого и нового текста
 * остаются на месте, курсор внутри изменённого куска переезжает в его начало.
 */
export function shiftCaret(oldText: string, newText: string, caret: number): number {
  let prefix = 0;
  while (prefix < oldText.length && prefix < newText.length && oldText[prefix] === newText[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldText.length - prefix && suffix < newText.length - prefix && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) suffix += 1;
  if (caret <= prefix) return caret;
  if (caret >= oldText.length - suffix) return caret + (newText.length - oldText.length);
  return prefix;
}
