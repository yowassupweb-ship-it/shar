import type { Cell, Workbook } from 'exceljs';
import { formatCell, formatGeneral } from './numFmt';

/**
 * Книга Excel для просмотра с оформлением: заливка, цвет и начертание шрифта, выравнивание, границы,
 * объединённые ячейки, ширина столбцов и высота строк, числовые форматы, скрытые строки и столбцы.
 * Раньше показывался только текст ячеек — цвета и жирность терялись.
 */

export type CssMap = Record<string, string>;
export interface Run { text: string; css?: CssMap }
export interface RichCell {
  /** Пусто — ячейка скрыта объединением. */
  hidden?: boolean;
  runs: Run[];
  css?: CssMap;
  colSpan?: number;
  rowSpan?: number;
  link?: string;
}
export interface SheetData {
  name: string;
  rows: RichCell[][];
  cols: number;
  /** Ширина столбцов, px. */
  widths: number[];
  /** Высота строк, px (undefined — по содержимому). */
  heights: Array<number | undefined>;
  truncated: boolean;
  /** Цвет вкладки листа. */
  tab?: string;
}

export const MAX_ROWS = 1000;
export const MAX_COLS = 60;

// ── Цвета ───────────────────────────────────────────────────────────────────

/** Тема Office 2013+ — если в книге не нашлась своя (порядок индексов theme: lt1, dk1, lt2, dk2, accent1–6, hlink, folHlink). */
const DEFAULT_THEME = ['FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47', '0563C1', '954F72'];

/** Стандартная палитра indexed-цветов Excel (0–63). */
const INDEXED = [
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080', '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
  '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF', '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696', '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
];

interface ColorLike { argb?: string; theme?: number; tint?: number; indexed?: number }

function hexToRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}
const toHex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

/** Оттенок Excel (tint): светлее/темнее через яркость в HSL — так же считает сам Excel. */
function applyTint(hex: string, tint: number): string {
  if (!tint) return hex;
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  let l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  const hue = (p: number, q: number, t0: number) => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  if (s === 0) return toHex(l * 255).repeat(3);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return `${toHex(hue(p, q, h + 1 / 3) * 255)}${toHex(hue(p, q, h) * 255)}${toHex(hue(p, q, h - 1 / 3) * 255)}`;
}

function resolveColor(color: ColorLike | undefined, theme: string[]): string | undefined {
  if (!color) return undefined;
  let hex: string | undefined;
  if (color.argb) hex = color.argb.length === 8 ? color.argb.slice(2) : color.argb;
  else if (typeof color.theme === 'number') hex = theme[color.theme];
  else if (typeof color.indexed === 'number') hex = INDEXED[color.indexed];
  if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return undefined;
  return `#${applyTint(hex, color.tint || 0)}`;
}

/** Цвета темы книги: xl/theme/theme1.xml из архива xlsx (публичный формат OOXML); не нашлось — стандартная тема. */
async function readTheme(buffer: ArrayBuffer): Promise<string[]> {
  try {
    const { unzipSync, strFromU8 } = await import('fflate');
    const files = unzipSync(new Uint8Array(buffer), { filter: (f) => f.name === 'xl/theme/theme1.xml' });
    const xml = files['xl/theme/theme1.xml'];
    if (!xml) return DEFAULT_THEME;
    const doc = new DOMParser().parseFromString(strFromU8(xml), 'application/xml');
    const scheme = doc.getElementsByTagName('a:clrScheme')[0];
    if (!scheme) return DEFAULT_THEME;
    const pick = (name: string) => {
      const node = scheme.getElementsByTagName(`a:${name}`)[0];
      const el = node?.firstElementChild;
      return el?.getAttribute('val') && el.tagName === 'a:srgbClr' ? el.getAttribute('val')! : el?.getAttribute('lastClr') || undefined;
    };
    const order = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
    return order.map((n, i) => pick(n) || DEFAULT_THEME[i]);
  } catch {
    return DEFAULT_THEME;
  }
}

// ── Стиль ячейки → CSS ──────────────────────────────────────────────────────

const BORDER_WIDTH: Record<string, [string, string]> = {
  thin: ['1px', 'solid'], hair: ['1px', 'dotted'], dotted: ['1px', 'dotted'], dashed: ['1px', 'dashed'], mediumDashed: ['2px', 'dashed'],
  dashDot: ['1px', 'dashed'], dashDotDot: ['1px', 'dashed'], slantDashDot: ['1px', 'dashed'], mediumDashDot: ['2px', 'dashed'],
  mediumDashDotDot: ['2px', 'dashed'], medium: ['2px', 'solid'], thick: ['3px', 'solid'], double: ['3px', 'double'],
};

const PT = 96 / 72;
/** Размер шрифта: у Excel по умолчанию 11 pt — это наши 13 px. */
const fontPx = (pt: number) => `${Math.round(pt * (13 / 11) * 10) / 10}px`;

interface FontLike { bold?: boolean; italic?: boolean; underline?: boolean | string; strike?: boolean; size?: number; color?: ColorLike; name?: string; vertAlign?: string }

function fontCss(font: FontLike | undefined, theme: string[]): CssMap {
  const css: CssMap = {};
  if (!font) return css;
  if (font.bold) css['font-weight'] = '700';
  if (font.italic) css['font-style'] = 'italic';
  const decorations = [font.underline ? 'underline' : '', font.strike ? 'line-through' : ''].filter(Boolean).join(' ');
  if (decorations) css['text-decoration'] = decorations;
  if (font.size && font.size !== 11) css['font-size'] = fontPx(font.size);
  const color = resolveColor(font.color, theme);
  if (color) css.color = color;
  if (font.vertAlign === 'superscript') { css['vertical-align'] = 'super'; css['font-size'] = '0.75em'; }
  if (font.vertAlign === 'subscript') { css['vertical-align'] = 'sub'; css['font-size'] = '0.75em'; }
  return css;
}

function cellCss(cell: Cell, theme: string[], isNumber: boolean, colStyle?: Partial<Cell['style']>): CssMap {
  const style = (Object.keys(cell.style || {}).length ? cell.style : colStyle) || {};
  const css: CssMap = { ...fontCss(style.font as FontLike | undefined, theme) };

  // Заливка: сплошная или градиент (берём первый цвет).
  const fill = style.fill as { type?: string; pattern?: string; fgColor?: ColorLike; bgColor?: ColorLike; stops?: Array<{ color: ColorLike }> } | undefined;
  if (fill) {
    let bg: string | undefined;
    if (fill.type === 'pattern' && fill.pattern && fill.pattern !== 'none') bg = resolveColor(fill.pattern === 'solid' ? fill.fgColor : (fill.fgColor || fill.bgColor), theme);
    else if (fill.type === 'gradient') bg = resolveColor(fill.stops?.[0]?.color, theme);
    if (bg) css.background = bg;
  }

  const al = style.alignment;
  const horizontal = al?.horizontal;
  if (horizontal === 'center' || horizontal === 'centerContinuous') css['text-align'] = 'center';
  else if (horizontal === 'right') css['text-align'] = 'right';
  else if (horizontal === 'left') css['text-align'] = 'left';
  else if (horizontal === 'justify') css['text-align'] = 'justify';
  else if (isNumber) css['text-align'] = 'right';
  if (al?.vertical === 'top') css['vertical-align'] = 'top';
  else if (al?.vertical === 'middle') css['vertical-align'] = 'middle';
  else css['vertical-align'] = 'bottom';
  if (al?.wrapText) { css['white-space'] = 'pre-wrap'; css['overflow-wrap'] = 'anywhere'; }
  if (al?.indent) css['padding-left'] = `${8 + al.indent * 9}px`;

  const border = style.border;
  if (border) {
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      const b = border[side];
      if (!b?.style) continue;
      const [width, line] = BORDER_WIDTH[b.style] || ['1px', 'solid'];
      css[`border-${side}`] = `${width} ${line} ${resolveColor(b.color as ColorLike, theme) || '#000'}`;
    }
  }
  return css;
}

const isHttp = (url: string) => /^(https?:|mailto:)/i.test(url);

// ── Значение ячейки ─────────────────────────────────────────────────────────

interface Rich { richText: Array<{ text: string; font?: FontLike }> }

function displayValue(cell: Cell): { text: string; isNumber: boolean } {
  let value: unknown = cell.value;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const obj = value as Record<string, unknown>;
    if ('result' in obj) value = obj.result;
    else if ('error' in obj) return { text: String(obj.error), isNumber: false };
    else if ('text' in obj) value = obj.text; // гиперссылка
    else if ('richText' in obj) return { text: (obj as unknown as Rich).richText.map((r) => r.text).join(''), isNumber: false };
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const obj = value as Record<string, unknown>;
    if ('error' in obj) return { text: String(obj.error), isNumber: false };
    value = obj.text ?? '';
  }
  if (value == null) return { text: '', isNumber: false };
  if (typeof value === 'boolean') return { text: value ? 'ИСТИНА' : 'ЛОЖЬ', isNumber: false };
  if (value instanceof Date) return { text: formatCell(value, cell.numFmt), isNumber: true };
  if (typeof value === 'number') return { text: cell.numFmt ? formatCell(value, cell.numFmt) : formatGeneral(value), isNumber: true };
  return { text: String(value), isNumber: false };
}

function cellRuns(cell: Cell, text: string, theme: string[]): Run[] {
  const value = cell.value as unknown;
  if (value && typeof value === 'object' && 'richText' in (value as object)) {
    return (value as Rich).richText.map((r) => ({ text: r.text, css: fontCss(r.font, theme) }));
  }
  return [{ text }];
}

function linkOf(cell: Cell): string | undefined {
  const value = cell.value as unknown;
  const url = value && typeof value === 'object' && 'hyperlink' in (value as object) ? String((value as { hyperlink?: unknown }).hyperlink || '') : '';
  return url && isHttp(url) ? url : undefined;
}

// ── Книга целиком ───────────────────────────────────────────────────────────

const colPx = (chars: number | undefined) => Math.round(((chars ?? 8.43) * 7 + 5));

export async function readWorkbook(buffer: ArrayBuffer): Promise<SheetData[]> {
  const [{ Workbook: WB }, theme] = await Promise.all([import('exceljs'), readTheme(buffer)]);
  const book: Workbook = new WB();
  await book.xlsx.load(buffer);
  return book.worksheets.filter((s) => s.state !== 'hidden' && s.state !== 'veryHidden').map((sheet) => {
    const rowCount = Math.min(sheet.rowCount, MAX_ROWS);
    const cols = Math.min(sheet.columnCount, MAX_COLS);
    const widths: number[] = [];
    const hiddenCol: boolean[] = [];
    for (let c = 1; c <= cols; c += 1) {
      const column = sheet.getColumn(c);
      hiddenCol[c] = Boolean(column.hidden);
      widths.push(hiddenCol[c] ? 0 : colPx(column.width));
    }

    // Объединения: границы каждой группы — по главной ячейке.
    const spans = new Map<string, { r1: number; c1: number; r2: number; c2: number }>();
    for (let r = 1; r <= rowCount; r += 1) {
      const row = sheet.getRow(r);
      for (let c = 1; c <= cols; c += 1) {
        const cell = row.getCell(c);
        if (!cell.isMerged) continue;
        const key = cell.master.address;
        const span = spans.get(key);
        if (span) { span.r2 = Math.max(span.r2, r); span.c2 = Math.max(span.c2, c); } else spans.set(key, { r1: r, c1: c, r2: r, c2: c });
      }
    }

    const rows: RichCell[][] = [];
    const heights: Array<number | undefined> = [];
    for (let r = 1; r <= rowCount; r += 1) {
      const row = sheet.getRow(r);
      heights.push(row.hidden ? 0 : row.height ? Math.round(row.height * PT) : undefined);
      const out: RichCell[] = [];
      for (let c = 1; c <= cols; c += 1) {
        const cell = row.getCell(c);
        if (hiddenCol[c] || row.hidden) { out.push({ hidden: true, runs: [] }); continue; }
        if (cell.isMerged && cell.master.address !== cell.address) { out.push({ hidden: true, runs: [] }); continue; }
        const { text, isNumber } = displayValue(cell);
        const rich: RichCell = { runs: cellRuns(cell, text, theme), css: cellCss(cell, theme, isNumber, sheet.getColumn(c).style) };
        const span = cell.isMerged ? spans.get(cell.address) : undefined;
        if (span) {
          const visible = (from: number, to: number, hidden: (i: number) => boolean) => { let n = 0; for (let i = from; i <= to; i += 1) if (!hidden(i)) n += 1; return n; };
          rich.colSpan = visible(span.c1, span.c2, (i) => hiddenCol[i]) || 1;
          rich.rowSpan = visible(span.r1, span.r2, (i) => Boolean(sheet.getRow(i).hidden)) || 1;
        }
        rich.link = linkOf(cell);
        out.push(rich);
      }
      rows.push(out);
    }
    const tabColor = resolveColor((sheet.properties?.tabColor as ColorLike | undefined), theme);
    return {
      name: sheet.name, rows, cols, widths, heights, tab: tabColor,
      truncated: sheet.rowCount > MAX_ROWS || sheet.columnCount > MAX_COLS,
    };
  });
}
