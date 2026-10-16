/**
 * HTML (то, что отдаёт mammoth из .docx) → Markdown, который понимает редактор документов:
 * заголовки до 3-го уровня, жирный, курсив, списки, таблицы строками через « | », ссылки, картинки — отдельной строкой.
 */
export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const lines: string[] = [];

  const inline = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent || '').replace(/\s+/g, ' ');
    if (!(node instanceof HTMLElement)) return '';
    const inner = Array.from(node.childNodes).map(inline).join('');
    switch (node.tagName) {
      case 'STRONG': case 'B': return inner.trim() ? `**${inner.trim()}**` : inner;
      case 'EM': case 'I': return inner.trim() ? `*${inner.trim()}*` : inner;
      case 'BR': return ' ';
      case 'A': {
        const href = node.getAttribute('href') || '';
        return /^(https?:|mailto:)/i.test(href) && inner.trim() ? `[${inner.trim().replace(/[[\]]/g, '')}](${href.replace(/\)/g, '%29')})` : inner;
      }
      case 'IMG': {
        const src = node.getAttribute('src') || '';
        // Картинка — свой абзац: так её ставит и Word, и редактор (строчная картинка в отдельной строке).
        return src && !src.startsWith('data:') ? `\n![](${src})\n` : '';
      }
      default: return inner;
    }
  };

  const push = (text: string) => {
    for (const part of text.split('\n')) { const clean = part.trim(); if (clean) lines.push(clean, ''); }
  };

  const block = (node: Element, depth = 0) => {
    for (const child of Array.from(node.children)) {
      const tag = child.tagName;
      if (/^H[1-6]$/.test(tag)) push(`${'#'.repeat(Math.min(3, Number(tag[1])))} ${inline(child).trim()}`);
      else if (tag === 'P') push(inline(child));
      else if (tag === 'UL' || tag === 'OL') {
        Array.from(child.children).forEach((li, index) => {
          const nested = Array.from(li.children).filter((c) => c.tagName === 'UL' || c.tagName === 'OL');
          const text = Array.from(li.childNodes).filter((n) => !nested.includes(n as Element)).map(inline).join('').trim();
          if (text) lines.push(`${'  '.repeat(depth)}${tag === 'OL' ? `${index + 1}.` : '-'} ${text}`);
          nested.forEach((n) => block(n.parentElement as Element, depth + 1));
        });
        lines.push('');
      } else if (tag === 'TABLE') {
        for (const row of Array.from(child.querySelectorAll('tr'))) {
          const cells = Array.from(row.children).map((cell) => inline(cell).trim());
          lines.push(`| ${cells.join(' | ')} |`);
        }
        lines.push('');
      } else if (tag === 'DIV' || tag === 'SECTION' || tag === 'BLOCKQUOTE') block(child, depth);
      else push(inline(child));
    }
  };

  block(doc.body.firstElementChild as Element);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
