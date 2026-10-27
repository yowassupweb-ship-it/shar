import type { ReactNode } from 'react';

/**
 * Слова поиска — по тем же правилам, что на сервере (store.search_terms): без окончаний, чтобы «казани» нашло «Казань»,
 * а «туры» — «тур». По ним же подсвечиваются совпадения в названиях, папках и кусках текста.
 */
export function searchTerms(query: string): string[] {
  const terms: string[] = [];
  for (const word of (query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []).slice(0, 8)) {
    const stem = /^\d+$/.test(word) || word.length <= 4 ? word : word.length > 6 ? word.slice(0, -2) : word.slice(0, -1);
    if (!terms.includes(stem)) terms.push(stem);
  }
  return terms;
}

/** Подходит ли текст: каждое слово запроса где-то в нём (в любом порядке). */
export const matchesAll = (text: string, terms: string[]) => {
  const lower = text.toLowerCase();
  return terms.length > 0 && terms.every((t) => lower.includes(t));
};

/** Текст с подсвеченными словами поиска. */
export function Highlight({ text, terms }: { text: string; terms: string[] }): ReactNode {
  if (!terms.length || !text) return text;
  const pattern = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'giu');
  const parts = text.split(pattern);
  return parts.map((part, i) => (i % 2 === 1 ? <mark key={i} className="nws-hit">{part}</mark> : part));
}
