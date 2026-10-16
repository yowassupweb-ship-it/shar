/**
 * Разбор запроса и оценка совпадений для поиска.
 *  - регистр и «ё/е» не важны;
 *  - запрос, набранный не в той раскладке («xfns» вместо «чаты»), понимается: ищем и как есть, и переведённым;
 *  - выше всего — совпадение с начала названия, потом с начала слова, потом внутри; последним — «по буквам».
 */

const EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,./`";
const RU = 'йцукенгшщзхъфывапролджэячсмитьбю.ё';

const toRu = new Map([...EN].map((c, i) => [c, RU[i]]));
const toEn = new Map([...RU].map((c, i) => [c, EN[i]]));

export const norm = (text: string) => (text || '').toLowerCase().replace(/ё/g, 'е');

function swap(text: string, map: Map<string, string>): string {
  return [...text].map((c) => map.get(c) ?? c).join('');
}

/** Запрос и его версия в другой раскладке (если отличается и осмысленна). */
export function variants(query: string): string[] {
  const q = norm(query.trim());
  if (!q) return [];
  const out = [q];
  const hasLatin = /[a-z]/.test(q);
  const hasCyr = /[а-я]/.test(q);
  if (hasLatin && !hasCyr) out.push(norm(swap(q, toRu)));
  else if (hasCyr && !hasLatin) out.push(norm(swap(q, toEn)));
  return [...new Set(out)].filter((v) => v.length > 0);
}

function subsequence(text: string, query: string): boolean {
  let at = 0;
  for (const ch of text) { if (ch === query[at]) at += 1; if (at === query.length) return true; }
  return false;
}

/** 0 — не подходит; больше — лучше. */
export function scoreText(text: string, queries: string[]): number {
  const t = norm(text);
  if (!t) return 0;
  let best = 0;
  for (const q of queries) {
    let s = 0;
    if (t === q) s = 100;
    else if (t.startsWith(q)) s = 90;
    else if (t.split(/[\s\-_.,:;()[\]/]+/).some((w) => w.startsWith(q))) s = 75;
    else if (t.includes(q)) s = 55;
    else if (q.length >= 3 && q.length <= 24 && subsequence(t, q)) s = 20;
    if (q.includes(' ')) {
      const parts = q.split(/\s+/).filter(Boolean);
      if (parts.length > 1 && parts.every((p) => t.includes(p))) s = Math.max(s, 60);
    }
    best = Math.max(best, s);
  }
  return best;
}

export function relativeTime(ts: number, now = Date.now()): string {
  const min = Math.round((now - ts) / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} дн назад`;
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}
