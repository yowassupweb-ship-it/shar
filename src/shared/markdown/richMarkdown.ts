/**
 * Что в markdown визуальный редактор (VisualEditor, TipTap) показать не сможет и потеряет при сохранении: таблицы,
 * HTML (в том числе <u> подчёркивания), сноски, ссылки-определения. Такие заметки правятся в Markdown — тогда всё
 * остаётся как есть. Возвращает, что нашлось (для подсказки), или null. Внутри блоков кода не смотрим: там это просто
 * текст.
 */
export function richMarkdown(md: string): string | null {
  let fence = false;
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    // Таблица GFM: строка с «|» и под ней разделитель «|---|---|».
    if (line.includes('|') && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(lines[i + 1] || '')) return 'таблица';
    if (/<\/?[a-z][a-z0-9-]*(\s[^>]*)?>/i.test(line.replace(/`[^`]*`/g, ''))) return 'HTML-разметка';
    if (/\[\^[^\]]+\]/.test(line)) return 'сноски';
    if (/^\s{0,3}\[[^\]]+\]:\s+\S/.test(line)) return 'ссылки-определения';
  }
  return null;
}
