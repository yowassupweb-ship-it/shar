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

const indentOf = (line: string) => line.length - line.trimStart().length;
const kindOf = (line: string) => (/^\s*\d+[.)]\s/.test(line) ? 'ol' : 'ul');

/** Пункт lines[at] продолжает тот же список, что ближайший пункт выше на том же отступе (а не начинает новый:
 *  «- …» сразу за «1. …» — это два списка, и пустая строка между ними должна остаться). */
function sameList(lines: string[], at: number): boolean {
  const indent = indentOf(lines[at]);
  for (let k = at - 1; k >= 0; k -= 1) {
    if (!ITEM.test(lines[k])) { if (lines[k].trim() === '') continue; return false; }
    if (indentOf(lines[k]) === indent) return kindOf(lines[k]) === kindOf(lines[at]);
    if (indentOf(lines[k]) < indent) return true; // вложенный пункт под родителем — тот же список
  }
  return false;
}

/** Пункты списка — подряд, без пустых строк между ними (tiptap-markdown разделяет ими пункты чек-листа). */
export function tightenLists(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let fence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const between = !fence && line === '' && i > 0 && i + 1 < lines.length && ITEM.test(lines[i - 1]) && ITEM.test(lines[i + 1]) && sameList(lines, i + 1);
    if (!between) out.push(line);
  }
  return out.join('\n');
}

/**
 * Пустые строки. В Шаре каждая пустая строка — свой зазор (две подряд — двойной), а markdown сводит любую пачку
 * пустых строк к одной границе абзацев: после правки в визуальном редакторе зазоры схлопывались. Поэтому на входе
 * каждая «лишняя» пустая строка становится абзацем-меткой (невидимый символ — в редакторе это пустая строка), а на
 * выходе метки и пустые абзацы, добавленные Enter-ом, превращаются обратно в пустые строки.
 */
const MARK = '​';
/** Метка пустой строки — её пишет пустой абзац редактора (extensions.ts). */
export const EMPTY_LINE_MARK = MARK;

/** Применить fn к тексту вне блоков кода (```): там пустые строки — часть кода. */
function outsideFences(md: string, fn: (chunk: string) => string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let buf: string[] = [];
  let fence = false;
  const flush = () => { if (buf.length) out.push(fn(buf.join('\n'))); buf = []; };
  for (const line of lines) {
    const toggle = /^\s*(```|~~~)/.test(line);
    if (!fence && toggle) { flush(); fence = true; out.push(line); continue; }
    if (fence) { out.push(line); if (toggle) fence = false; continue; }
    buf.push(line);
  }
  flush();
  return out.join('\n');
}

/** Пачки пустых строк: [индекс первой непустой до, число пустых]. Работает построчно — без хрупких регулярок. */
function mapBlankRuns(chunk: string, fn: (blanks: number) => string[]): string {
  const lines = chunk.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() !== '') { out.push(lines[i]); i += 1; continue; }
    let n = 0;
    while (i < lines.length && lines[i].trim() === '') { n += 1; i += 1; }
    // Пустые строки в начале и в конце текста не трогаем.
    if (out.length === 0 || i >= lines.length) out.push(...Array<string>(n).fill(''));
    else out.push(...fn(n));
  }
  return out.join('\n');
}

/** Markdown Шара → вход визуального редактора. */
export function toEditorMarkdown(md: string): string {
  return outsideFences(md.split(MARK).join(''), (chunk) => mapBlankRuns(chunk, (n) => {
    const res = [''];
    for (let k = 1; k < n; k += 1) res.push(MARK, '');
    return res;
  }));
}

/** Выход визуального редактора → markdown Шара. */
export function fromEditorMarkdown(md: string): string {
  const out = outsideFences(tightenLists(unescapeBreaks(md)), (chunk) => {
    // Пустой абзац (Enter на пустой строке) редактор пишет пустым блоком между двумя границами: 3 пустые строки
    // вместо одной. Каждый такой пустой абзац — одна пустая строка.
    const lines = mapBlankRuns(chunk, (n) => Array<string>(1 + Math.floor((n - 1) / 2)).fill('')).split('\n');
    // Абзац-метка вместе с границей перед ней — одна пустая строка.
    const res: string[] = [];
    for (const line of lines) {
      if (line === MARK && res.length && res[res.length - 1] === '') continue;
      res.push(line);
    }
    return res.join('\n');
  });
  return out.split(MARK).join('');
}
