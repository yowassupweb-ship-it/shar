/**
 * Разница двух состояний материала для истории версий: построчно (что добавлено, что убрано), а в заменённой строке —
 * по словам, чтобы было видно, что именно поправили. Без зависимостей: наибольшая общая подпоследовательность по
 * середине (общие начало и конец отрезаются сразу), с потолком на размер — огромные правки показываются блоком.
 */

export type DiffPart = { text: string; changed: boolean };
export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string; parts?: DiffPart[] };

const MAX_CELLS = 4_000_000;

/** Пары (i, j) совпадающих элементов a и b по наибольшей общей подпоследовательности. */
function lcs<T>(a: T[], b: T[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  if (!n || !m || n * m > MAX_CELLS) return [];
  const w = m + 1;
  const table = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * w + j] = a[i] === b[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i += 1; j += 1; } else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) i += 1; else j += 1;
  }
  return pairs;
}

function words(line: string): string[] {
  return line.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
}

/** Замена строки на строку: какие слова старой убраны, какие в новой появились. */
function wordDiff(before: string, after: string): { del: DiffPart[]; add: DiffPart[] } {
  const a = words(before);
  const b = words(after);
  const pairs = lcs(a, b);
  const keepA = new Set(pairs.map(([i]) => i));
  const keepB = new Set(pairs.map(([, j]) => j));
  const join = (tokens: string[], keep: Set<number>) => tokens.reduce<DiffPart[]>((out, text, i) => {
    const changed = !keep.has(i);
    const last = out[out.length - 1];
    if (last && last.changed === changed) last.text += text; else out.push({ text, changed });
    return out;
  }, []);
  return { del: join(a, keepA), add: join(b, keepB) };
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const pairs = lcs(midA, midB);

  const out: DiffLine[] = a.slice(0, start).map((text) => ({ kind: 'same', text }));
  let i = 0;
  let j = 0;
  const flush = (toI: number, toJ: number) => {
    const removed = midA.slice(i, toI);
    const added = midB.slice(j, toJ);
    // Строка на строку — подсветка по словам; иначе — просто убрано и добавлено.
    if (removed.length === added.length && removed.length <= 20) {
      const del: DiffLine[] = [];
      const add: DiffLine[] = [];
      removed.forEach((text, k) => {
        const parts = wordDiff(text, added[k]);
        del.push({ kind: 'del', text, parts: parts.del });
        add.push({ kind: 'add', text: added[k], parts: parts.add });
      });
      out.push(...del, ...add);
    } else {
      out.push(...removed.map((text) => ({ kind: 'del' as const, text })), ...added.map((text) => ({ kind: 'add' as const, text })));
    }
  };
  for (const [pi, pj] of pairs) {
    flush(pi, pj);
    out.push({ kind: 'same', text: midA[pi] });
    i = pi + 1;
    j = pj + 1;
  }
  flush(midA.length, midB.length);
  out.push(...a.slice(endA).map((text) => ({ kind: 'same' as const, text })));
  return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  return lines.reduce((s, l) => ({ added: s.added + (l.kind === 'add' ? 1 : 0), removed: s.removed + (l.kind === 'del' ? 1 : 0) }), { added: 0, removed: 0 });
}

/** Ячейки таблицы: что поменялось, добавилось и убралось (по листам). */
export type CellChange = { sheet: string; ref: string; before: string; after: string };

export function diffCells(before: Map<string, string>, after: Map<string, string>): CellChange[] {
  const keys = [...new Set([...before.keys(), ...after.keys()])];
  const changes: CellChange[] = [];
  for (const key of keys) {
    const was = before.get(key) ?? '';
    const now = after.get(key) ?? '';
    if (was === now) continue;
    const [sheet, ref] = key.split('!');
    changes.push({ sheet, ref, before: was, after: now });
  }
  const order = (ref: string) => { const m = ref.match(/^([A-Z]+)(\d+)$/); return m ? Number(m[2]) * 1000 + m[1].split('').reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) : 0; };
  return changes.sort((x, y) => x.sheet.localeCompare(y.sheet, 'ru') || order(x.ref) - order(y.ref));
}
