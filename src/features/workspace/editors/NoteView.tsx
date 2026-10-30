import { memo, startTransition, useEffect, useMemo, useState } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkUnderline from '../lib/remarkUnderline';
import { rehypeSourceLinesFrom } from '../lib/viewPosition';

/**
 * Просмотр заметки кусками. Целиком большая заметка (perf-big-note — 120 тыс. знаков) разбиралась одним
 * синхронным вызовом react-markdown почти секунду: клик по строке в «Офисе» и переход «Правка → Просмотр» висели.
 * Теперь текст режется на блоки по пустым строкам, каждый — свой запомненный компонент:
 *  - правка пересобирает только изменённый блок;
 *  - открытие рисует начало (и место, к которому надо прокрутить) сразу, остальное — следующими кадрами.
 * Номера строк исходника (data-line) сдвинуты на начало блока — синхронная прокрутка правки и просмотра не ломается.
 */

const CHUNK_CHARS = 4000;
const FIRST_CHARS = 6000;

type Block = { text: string; offset: number; lines: number };

const FENCE = /^\s{0,3}(```|~~~)/;
// Продолжение предыдущего блока: отступ, пункт списка, цитата, строка таблицы — по пустой строке перед ними не режем.
const CONTINUES = /^(\s+\S|\s{0,3}([-*+]|\d+[.)])\s|\s{0,3}>|\s*\|)/;
// Ссылки-определения и сноски работают только внутри одного разбора — такую заметку рисуем целиком.
const DEFINITIONS = /^\s{0,3}\[[^\]]+\]:\s/m;

export function splitBlocks(text: string): Block[] {
  if (text.length <= FIRST_CHARS || DEFINITIONS.test(text)) return [{ text, offset: 0, lines: text.split('\n').length }];
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let start = 0;
  let size = 0;
  let fenced = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (FENCE.test(line)) fenced = !fenced;
    size += line.length + 1;
    const next = lines[i + 1];
    if (!fenced && size >= CHUNK_CHARS && line.trim() === '' && next !== undefined && next.trim() !== '' && !CONTINUES.test(next)) {
      blocks.push({ text: lines.slice(start, i + 1).join('\n'), offset: start, lines: i + 1 - start });
      start = i + 1;
      size = 0;
    }
  }
  if (start < lines.length) blocks.push({ text: lines.slice(start).join('\n'), offset: start, lines: lines.length - start });
  return blocks;
}

const REMARK = [remarkGfm, remarkBreaks, remarkUnderline];

const Chunk = memo(function Chunk({ text, offset, components }: { text: string; offset: number; components: Components }) {
  const rehype = useMemo(() => [rehypeSourceLinesFrom(offset)], [offset]);
  return <Markdown remarkPlugins={REMARK} rehypePlugins={rehype} components={components}>{text}</Markdown>;
});

/** Сколько блоков показать сразу: начало заметки и всё до строки revealLine (туда сейчас прокрутят). */
function firstCount(blocks: Block[], revealLine: number): number {
  let chars = 0;
  for (let i = 0; i < blocks.length; i += 1) {
    chars += blocks[i].text.length;
    const reaches = blocks[i].offset + blocks[i].lines >= revealLine;
    if (chars >= FIRST_CHARS && reaches) return i + 1;
  }
  return blocks.length;
}

export function NoteView({ text, components, revealLine = 0 }: { text: string; components: Components; revealLine?: number }) {
  const blocks = useMemo(() => splitBlocks(text), [text]);
  const [shown, setShown] = useState(() => firstCount(blocks, revealLine));
  const visible = Math.min(blocks.length, Math.max(shown, firstCount(blocks, revealLine)));
  // Остальное — следующими кадрами, не мешая вводу (переходом с низким приоритетом).
  useEffect(() => {
    if (visible >= blocks.length) return undefined;
    const timer = window.setTimeout(() => startTransition(() => setShown(visible + 2)), 16);
    return () => window.clearTimeout(timer);
  }, [visible, blocks.length]);
  return (
    <>
      {blocks.slice(0, visible).map((b) => <Chunk key={b.offset} text={b.text} offset={b.offset} components={components} />)}
    </>
  );
}
