/**
 * Текстовые файлы из чата и с диска: кодировка и CSV. Русский Excel сохраняет CSV в Windows-1251, Блокнот и
 * выгрузки старых систем — тоже; прочитанные как UTF-8, такие файлы превращались в «�����».
 */

/** Байты → текст: UTF-16 по метке, UTF-8 (с меткой или без), иначе Windows-1251. */
export function decodeText(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1251').decode(bytes);
  }
}

export async function readText(blob: Blob): Promise<string> {
  return decodeText(await blob.arrayBuffer());
}

/** Разбор CSV: разделитель определяется по первой строке (; , или табуляция), кавычки и переносы внутри кавычек понимаются. */
export function parseCsv(text: string): string[][] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // метка порядка байтов (BOM)
  const first = source.split(/\r?\n/, 1)[0] || '';
  const delimiter = [';', '\t', ','].map((d) => [d, first.split(d).length] as const).sort((x, y) => y[1] - x[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') { if (source[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false; } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
