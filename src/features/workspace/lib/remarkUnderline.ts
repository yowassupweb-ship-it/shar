/**
 * Подчёркивание в заметке. В Markdown его нет, поэтому понимаем три принятых в разных программах записи:
 *  - <u>текст</u> — HTML (GitHub, Obsidian, Typora); его ставит кнопка на панели;
 *  - __текст__ — как в Discord и мессенджерах (в обычном Markdown это жирный, но в Шаре жирный — **текст**);
 *  - ++текст++ — как в markdown-it и Joplin.
 * Просмотр не пропускает HTML как есть (безопасность), поэтому подчёркнутое становится отдельным узлом, который
 * рисуется тегом <u> (а в Word — подчёркнутым текстом). Остальной HTML по-прежнему показывается текстом.
 */

type Node = { type: string; value?: string; children?: Node[]; data?: Record<string, unknown>; position?: { start?: { offset?: number } } };

const OPEN = /^<u>$/i;
const CLOSE = /^<\/u>$/i;
const PLUS = /\+\+(?=\S)([^\n]*?\S)\+\+/g;

const node = (children: Node[]): Node => ({ type: 'underline', data: { hName: 'u' }, children });

/** ++текст++ внутри простого текста. */
function splitPlus(text: Node): Node[] {
  const value = text.value ?? '';
  if (!value.includes('++')) return [text];
  const out: Node[] = [];
  let at = 0;
  for (const m of value.matchAll(PLUS)) {
    const i = m.index ?? 0;
    if (i > at) out.push({ type: 'text', value: value.slice(at, i) });
    out.push(node([{ type: 'text', value: m[1] }]));
    at = i + m[0].length;
  }
  if (!out.length) return [text];
  if (at < value.length) out.push({ type: 'text', value: value.slice(at) });
  return out;
}

function walk(children: Node[], source: string): Node[] {
  const out: Node[] = [];
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (child.type === 'html' && OPEN.test(child.value?.trim() ?? '')) {
      const end = children.findIndex((n, j) => j > i && n.type === 'html' && CLOSE.test(n.value?.trim() ?? ''));
      if (end > i) {
        out.push(node(walk(children.slice(i + 1, end), source)));
        i = end;
        continue;
      }
    }
    if (child.type === 'text') { out.push(...splitPlus(child)); continue; }
    const start = child.position?.start?.offset;
    if (child.type === 'strong' && typeof start === 'number' && source.startsWith('__', start)) {
      out.push(node(walk(child.children ?? [], source)));
      continue;
    }
    // В коде разметка не действует.
    if (child.type === 'inlineCode' || child.type === 'code') { out.push(child); continue; }
    out.push(child.children ? { ...child, children: walk(child.children, source) } : child);
  }
  return out;
}

export default function remarkUnderline() {
  return (tree: Node, file?: { value?: unknown }) => {
    if (tree.children) tree.children = walk(tree.children, String(file?.value ?? ''));
  };
}
