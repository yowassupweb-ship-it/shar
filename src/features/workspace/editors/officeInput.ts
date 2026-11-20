/** Адрес диапазона без имени листа: переход всегда относится к активному листу. */
export function parseSheetRange(value: string) {
  const match = /^\$?([A-Z]{1,3})\$?([1-9]\d{0,6})(?::\$?([A-Z]{1,3})\$?([1-9]\d{0,6}))?$/.exec(value.trim().toUpperCase());
  if (!match) return null;
  const column = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const r1 = Number(match[2]) - 1, r2 = Number(match[4] || match[2]) - 1;
  const c1 = column(match[1]), c2 = column(match[3] || match[1]);
  return { row: Math.min(r1, r2), col: Math.min(c1, c2), rows: Math.abs(r2 - r1) + 1, cols: Math.abs(c2 - c1) + 1 };
}

export function normalizeDocumentLink(value: string): string | null {
  const raw = value.trim();
  if (!raw || /\s/.test(raw)) return null;
  const scheme = /^[a-z][a-z\d+.-]*:/i.exec(raw)?.[0].toLowerCase();
  if (scheme && !['https:', 'http:', 'mailto:', 'tel:'].includes(scheme)) return null;
  const normalized = scheme ? raw : `https://${raw}`;
  try {
    const url = new URL(normalized);
    if (['https:', 'http:'].includes(url.protocol) ? !url.hostname || Boolean(url.username || url.password) : !url.pathname) return null;
    return normalized;
  } catch { return null; }
}
