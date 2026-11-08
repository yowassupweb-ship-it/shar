/**
 * Построчное форматирование markdown: списки, задачи, цитата, заголовки на ВСЕХ строках выделения.
 * Чистая функция над текстом — ею пользуются редакторы без своей истории правок (заметки). Панель задач правит
 * textarea через execCommand и держит ту же логику у себя (tasks/MarkdownToolbar).
 *
 * Повторное нажатие снимает разметку, если она уже на всех непустых строках; чужая разметка строки (другой
 * тип списка, заголовок) заменяется. Пустые строки внутри выделения не трогаем.
 */

export type LineAction = 'h0' | 'h1' | 'h2' | 'h3' | 'ul' | 'ol' | 'task' | 'quote';

const PREFIX = /^(\s*)(?:#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+|>\s?)?/;
const HAS: Record<'ul' | 'ol' | 'task' | 'quote', RegExp> = {
  ul: /^\s*[-*+]\s+(?!\[[ xX]\])/,
  ol: /^\s*\d+[.)]\s+/,
  task: /^\s*[-*+]\s+\[[ xX]\]\s+/,
  quote: /^\s*>/,
};

export interface LineEdit { next: string; from: number; to: number }

/** Маркер по тексту, которым инструмент отмечен в панели («- », «1. », «## »…). */
export function actionOfMarker(before: string): LineAction | null {
  const map: Record<string, LineAction> = { '- ': 'ul', '1. ': 'ol', '- [ ] ': 'task', '> ': 'quote', '# ': 'h1', '## ': 'h2', '### ': 'h3' };
  return map[before] ?? null;
}

export function formatLines(value: string, selStart: number, selEnd: number, action: LineAction, placeholder = ''): LineEdit {
  // Выделение, закончившееся сразу после перевода строки, следующую строку не захватывает.
  const last = selEnd > selStart && value[selEnd - 1] === '\n' ? selEnd - 1 : selEnd;
  const start = value.lastIndexOf('\n', selStart - 1) + 1;
  const endBreak = value.indexOf('\n', last);
  const end = endBreak < 0 ? value.length : endBreak;
  const block = value.slice(start, end).split('\n');
  const empty = block.length === 1 && !block[0].trim();
  const lines = empty && placeholder ? [placeholder] : block;
  const nonEmpty = lines.filter((l) => l.trim());
  const level = action.startsWith('h') ? Number(action.slice(1)) : -1;
  const removing = level < 0 && nonEmpty.length > 0 && nonEmpty.every((l) => HAS[action as keyof typeof HAS].test(l));
  let n = 0;
  const out = lines.map((line) => {
    if (!line.trim() && lines.length > 1) return line;
    const [prefix, indent] = line.match(PREFIX) ?? ['', ''];
    const body = line.slice(prefix.length);
    if (level >= 0) return level ? `${'#'.repeat(level)} ${body}` : `${indent}${body}`;
    if (removing) return `${indent}${body}`;
    n += 1;
    const marker = action === 'ul' ? '- ' : action === 'ol' ? `${n}. ` : action === 'task' ? '- [ ] ' : '> ';
    return `${indent}${marker}${body}`;
  });
  const text = out.join('\n');
  return { next: `${value.slice(0, start)}${text}${value.slice(end)}`, from: start, to: start + text.length };
}
