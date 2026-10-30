/**
 * Позиция «относительно текста» при переключении заметки между правкой (textarea) и просмотром (отрендеренный
 * Markdown). Раньше переключение сбрасывало прокрутку: оказываешься в начале, а не там, где читал или писал.
 *
 * Привязка — к строке исходного текста: правка знает её по высоте строк (мерим на невидимой копии поля),
 * просмотр — по data-line, который rehypeSourceLines кладёт на каждый элемент из позиции в исходнике.
 */

type HastNode = { type?: string; position?: { start?: { line?: number } }; properties?: Record<string, unknown>; children?: HastNode[] };

/** rehype-плагин: у каждого элемента страницы — номер строки исходника (data-line, с единицы). */
export function rehypeSourceLines() {
  return rehypeSourceLinesFrom(0)();
}

/** То же для куска текста, который начинается не с первой строки: offset — сколько строк исходника выше куска. */
export function rehypeSourceLinesFrom(offset: number) {
  return () => (tree: HastNode) => {
    const walk = (node: HastNode) => {
      const line = node.position?.start?.line;
      if (node.type === 'element' && line) node.properties = { ...node.properties, dataLine: line + offset };
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}

/** Смещения начал строк текста. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/** Невидимая копия поля: те же шрифт и ширина — по ней узнаём, на какой высоте начинается строка с таким смещением. */
function makeMirror(area: HTMLTextAreaElement) {
  const style = getComputedStyle(area);
  const box = document.createElement('div');
  for (const key of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent',
    'textTransform', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderLeftWidth', 'borderRightWidth', 'tabSize'] as const) {
    (box.style as unknown as Record<string, string>)[key] = style[key];
  }
  Object.assign(box.style, {
    position: 'absolute', visibility: 'hidden', left: '-99999px', top: '0', boxSizing: 'border-box',
    width: `${area.clientWidth + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)}px`,
    whiteSpace: 'pre-wrap', overflowWrap: 'break-word',
  });
  document.body.appendChild(box);
  const text = document.createTextNode('');
  const marker = document.createElement('span');
  marker.textContent = '​';
  box.append(text, marker);
  return {
    /** Высота (в координатах прокрутки поля), на которой начинается текст с этого смещения. */
    yAt(value: string, offset: number) {
      text.data = value.slice(0, offset);
      return marker.offsetTop;
    },
    dispose() { box.remove(); },
  };
}

/** Номер (с нуля) первой строки исходного текста, которая сейчас у верхнего края поля. */
export function topLineOfField(area: HTMLTextAreaElement): number {
  const value = area.value;
  const starts = lineStarts(value);
  const mirror = makeMirror(area);
  try {
    let lo = 0;
    let hi = starts.length - 1;
    // Последняя строка, начало которой не ниже верхнего края (с запасом в пару пикселей на округление).
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (mirror.yAt(value, starts[mid]) <= area.scrollTop + 2) lo = mid; else hi = mid - 1;
    }
    return lo;
  } finally { mirror.dispose(); }
}

/** Прокрутить поле так, чтобы строка (с нуля) оказалась у верхнего края; курсор — в её начало. */
export function showLineInField(area: HTMLTextAreaElement, line: number, moveCaret = true) {
  const value = area.value;
  const starts = lineStarts(value);
  const at = starts[Math.min(Math.max(0, line), starts.length - 1)];
  const mirror = makeMirror(area);
  try { area.scrollTop = mirror.yAt(value, at); } finally { mirror.dispose(); }
  if (moveCaret) area.setSelectionRange(at, at);
}

const lineOf = (el: Element) => Number((el as HTMLElement).dataset.line) || 0;

/**
 * Строка исходника (с нуля) у верхнего края просмотра: самый поздний начавшийся выше края видимый элемент, а если край
 * пришёлся на промежуток между абзацами (элемента под ним нет) — первый видимый ниже.
 */
export function topLineOfView(view: HTMLElement): number {
  const top = view.getBoundingClientRect().top;
  let above = -1;
  let below = 0;
  for (const el of Array.from(view.querySelectorAll('[data-line]'))) {
    const rect = el.getBoundingClientRect();
    if (rect.bottom <= top + 1) continue;       // уже прокручен выше края
    const line = lineOf(el) - 1;
    if (rect.top <= top + 6) { above = Math.max(above, line); continue; }
    below = line;                                // первый элемент ниже края; дальше только ниже
    break;
  }
  return above >= 0 ? above : below;
}

/** Прокрутить просмотр так, чтобы элемент с этой строкой исходника (с нуля) оказался у верхнего края. */
export function showLineInView(view: HTMLElement, line: number) {
  const wanted = line + 1;
  let target: Element | null = null;
  for (const el of Array.from(view.querySelectorAll('[data-line]'))) {
    const n = lineOf(el);
    if (n <= wanted) target = el; else break;
  }
  if (!target) { view.scrollTop = 0; return; }
  const offset = target.getBoundingClientRect().top - view.getBoundingClientRect().top;
  view.scrollTop += offset - 4;
}
