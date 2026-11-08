/**
 * Строки внутри абзаца. В Шаре одиночный перевод строки в тексте — это просто новая строка («Шаг 1⏎Шаг 2»), а не
 * пробел, как в строгом markdown. Редактор хранит такой абзац с «жёсткими переносами» (breaks: true при разборе), а
 * при записи tiptap-markdown ставит перед переносом обратную косую черту — это некрасиво в «Коде» и в диффах версий,
 * поэтому её убираем: текст остаётся ровно таким, как его писал человек. Блоки кода не трогаем.
 */
const BACKSLASH = String.fromCharCode(92);

export function unescapeBreaks(md: string): string {
  let fence = false;
  return md.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    return !fence && line.endsWith(BACKSLASH) && !line.endsWith(BACKSLASH + BACKSLASH) ? line.slice(0, -1) : line;
  }).join('\n');
}

const ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;

/** Пункты списка — подряд, без пустых строк между ними (tiptap-markdown разделяет ими пункты чек-листа). */
export function tightenLists(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let fence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const between = !fence && line === '' && i > 0 && i + 1 < lines.length && ITEM.test(lines[i - 1]) && ITEM.test(lines[i + 1]);
    if (!between) out.push(line);
  }
  return out.join('\n');
}
