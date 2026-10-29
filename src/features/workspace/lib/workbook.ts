import type { Cell, CellValue, Workbook as ExcelWorkbook, Worksheet } from 'exceljs';
import type { ICellData, IStyleData, IWorkbookData } from '@univerjs/presets';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

/**
 * Таблица хранится файлом xlsx (в base64): так её открывают Excel и Google Таблицы, а сервер ничего в ней
 * не разбирает. В редакторе её показывает Univer, поэтому на входе книга ExcelJS переводится в снимок
 * Univer, а правки возвращаются обратно в ту же книгу.
 *
 * Переносится всё, что видно глазами: значения, формулы, форматы чисел, шрифт, заливка, границы, выравнивание,
 * перенос строк, объединённые ячейки, высоты строк и ширины столбцов, скрытые строки и столбцы, закрепление,
 * цвет ярлыка листа, фильтр с условиями по столбцам и сортировка. Чего ExcelJS не понимает (условия фильтра,
 * сортировка), читается и пишется прямо в XML файла. Оформление, которого Univer не показывает (цвета темы с
 * оттенками, условное форматирование), в файле не теряется: ячейка, которую не меняли, сохраняется как была.
 *
 * Номера листов Univer должны совпадать у всех, кто правит таблицу вместе (правки ссылаются на лист по номеру),
 * поэтому номера хранятся в самом файле — в его свойствах (docProps/custom.xml, свойство SharSheetIds).
 */

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ── то, чего нет в модели ExcelJS: номера листов, фильтры с условиями, сортировка ─────────────────────────

/** Фильтр листа в понятиях Univer (IAutoFilter): диапазон и условия по столбцам (colId — номер столбца листа). */
export interface SheetFilter {
  ref: { startRow: number; endRow: number; startColumn: number; endColumn: number };
  filterColumns?: FilterColumn[];
  cachedFilteredOut?: number[];
}
interface FilterColumn {
  colId: number;
  filters?: { blank?: true; filters?: string[] };
  customFilters?: { and?: 1; customFilters: Array<{ val: string | number; operator?: string }> };
}

interface BookExtras {
  /** Номер листа Univer по имени листа. */
  sheetIds: Map<string, string>;
  /** Фильтры листов по имени (для записи условий в XML). */
  filters: Map<string, SheetFilter>;
  /** Сортировка листа (XML <sortState> как в файле) — Excel показывает по ней стрелку сортировки. */
  sorts: Map<string, string>;
  /** Отпечаток оформления ячейки «лист!строка:столбец» на момент чтения/записи: не изменилось — не трогаем. */
  styleKeys: Map<string, string>;
}

const extras = new WeakMap<ExcelWorkbook, BookExtras>();

function extrasOf(book: ExcelWorkbook): BookExtras {
  let found = extras.get(book);
  if (!found) {
    found = { sheetIds: new Map(), filters: new Map(), sorts: new Map(), styleKeys: new Map() };
    extras.set(book, found);
  }
  return found;
}

const CUSTOM_PROPS = 'docProps/custom.xml';
const SHEET_IDS_PROP = 'SharSheetIds';

function parseXml(text: string): Document {
  return new DOMParser().parseFromString(text, 'application/xml');
}

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Имя листа → путь его XML в архиве (по workbook.xml и его связям). */
function sheetPaths(files: Record<string, Uint8Array>): Map<string, string> {
  const out = new Map<string, string>();
  const wb = files['xl/workbook.xml'];
  const rels = files['xl/_rels/workbook.xml.rels'];
  if (!wb || !rels) return out;
  const targets = new Map<string, string>();
  for (const rel of Array.from(parseXml(strFromU8(rels)).getElementsByTagName('Relationship'))) {
    const target = rel.getAttribute('Target') || '';
    targets.set(rel.getAttribute('Id') || '', target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }
  for (const sheet of Array.from(parseXml(strFromU8(wb)).getElementsByTagName('sheet'))) {
    const rid = sheet.getAttribute('r:id') || sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || '';
    const path = targets.get(rid);
    if (path) out.set(sheet.getAttribute('name') || '', path);
  }
  return out;
}

const AUTOFILTER_RE = /<autoFilter\b[^>]*?(?:\/>|>[\s\S]*?<\/autoFilter>)/;
const SORTSTATE_RE = /<sortState\b[^>]*?(?:\/>|>[\s\S]*?<\/sortState>)/;

function decodeRef(ref: string): SheetFilter['ref'] | null {
  const m = /^\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/i.exec(ref.trim());
  if (!m) return null;
  const col = (letters: string) => letters.toUpperCase().split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const r1 = Number(m[2]) - 1;
  const c1 = col(m[1]);
  return { startRow: r1, startColumn: c1, endRow: m[4] ? Number(m[4]) - 1 : r1, endColumn: m[3] ? col(m[3]) : c1 };
}

function columnName(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const encodeRef = (r: SheetFilter['ref']) => `${columnName(r.startColumn)}${r.startRow + 1}:${columnName(r.endColumn)}${r.endRow + 1}`;

/** <autoFilter> из файла → фильтр Univer (условия по значениям и пользовательские условия). */
function readAutoFilter(xml: string): SheetFilter | null {
  const doc = parseXml(xml);
  const root = doc.documentElement;
  const ref = decodeRef(root.getAttribute('ref') || '');
  if (!ref) return null;
  const columns: FilterColumn[] = [];
  for (const fc of Array.from(root.getElementsByTagName('filterColumn'))) {
    const colId = ref.startColumn + Number(fc.getAttribute('colId') || 0);
    const column: FilterColumn = { colId };
    const filters = fc.getElementsByTagName('filters')[0];
    if (filters) {
      const values = Array.from(filters.getElementsByTagName('filter')).map((f) => f.getAttribute('val') || '');
      column.filters = { ...(filters.getAttribute('blank') === '1' || filters.getAttribute('blank') === 'true' ? { blank: true as const } : {}), filters: values };
    }
    const custom = fc.getElementsByTagName('customFilters')[0];
    if (custom) {
      const list = Array.from(custom.getElementsByTagName('customFilter')).slice(0, 2).map((f) => {
        const raw = f.getAttribute('val') || '';
        const num = raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw;
        return { val: num, ...(f.getAttribute('operator') ? { operator: f.getAttribute('operator')! } : {}) };
      });
      if (list.length) column.customFilters = { ...(custom.getAttribute('and') === '1' || custom.getAttribute('and') === 'true' ? { and: 1 as const } : {}), customFilters: list };
    }
    if (column.filters || column.customFilters) columns.push(column);
  }
  return { ref, filterColumns: columns };
}

/** Фильтр Univer → <autoFilter> файла. */
function writeAutoFilter(filter: SheetFilter): string {
  const ref = encodeRef(filter.ref);
  const columns = (filter.filterColumns || []).map((column) => {
    const colId = column.colId - filter.ref.startColumn;
    if (colId < 0) return '';
    let inner = '';
    if (column.filters) {
      const values = (column.filters.filters || []).map((v) => `<filter val="${escapeXml(String(v))}"/>`).join('');
      inner = `<filters${column.filters.blank ? ' blank="1"' : ''}>${values}</filters>`;
    } else if (column.customFilters?.customFilters?.length) {
      const list = column.customFilters.customFilters.map((f) => `<customFilter${f.operator && f.operator !== 'equal' ? ` operator="${f.operator}"` : ''} val="${escapeXml(String(f.val))}"/>`).join('');
      inner = `<customFilters${column.customFilters.and ? ' and="1"' : ''}>${list}</customFilters>`;
    }
    return inner ? `<filterColumn colId="${colId}">${inner}</filterColumn>` : '';
  }).join('');
  return columns ? `<autoFilter ref="${ref}">${columns}</autoFilter>` : `<autoFilter ref="${ref}"/>`;
}

function readSheetIds(files: Record<string, Uint8Array>): Map<string, string> {
  const out = new Map<string, string>();
  const custom = files[CUSTOM_PROPS];
  if (!custom) return out;
  for (const prop of Array.from(parseXml(strFromU8(custom)).getElementsByTagName('property'))) {
    if (prop.getAttribute('name') !== SHEET_IDS_PROP) continue;
    try {
      const map = JSON.parse(prop.textContent || '{}') as Record<string, string>;
      for (const [name, id] of Object.entries(map)) if (typeof id === 'string' && id) out.set(name, id);
    } catch { /* чужое значение — номера листов возьмём по порядку */ }
  }
  return out;
}

/** Дописать в архив, собранный ExcelJS, то, чего он не умеет: условия фильтров, сортировку, номера листов. */
function finishZip(bytes: Uint8Array, state: { sheetIds: Map<string, string>; filters: Map<string, SheetFilter>; sorts: Map<string, string> }): Uint8Array {
  const files = unzipSync(bytes);
  const paths = sheetPaths(files);
  for (const [name, path] of paths) {
    const filter = state.filters.get(name);
    const sort = state.sorts.get(name);
    if (!filter && !sort) continue;
    const file = files[path];
    if (!file) continue;
    let xml = strFromU8(file);
    if (filter) {
      const element = writeAutoFilter(filter);
      xml = AUTOFILTER_RE.test(xml) ? xml.replace(AUTOFILTER_RE, element) : xml;
    }
    if (sort && AUTOFILTER_RE.test(xml) && !SORTSTATE_RE.test(xml)) {
      // Порядок элементов листа в OOXML: <autoFilter> и сразу за ним <sortState>.
      xml = xml.replace(AUTOFILTER_RE, (found) => found + sort);
    }
    files[path] = strToU8(xml);
  }
  if (state.sheetIds.size) {
    const value = escapeXml(JSON.stringify(Object.fromEntries(state.sheetIds)));
    files[CUSTOM_PROPS] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
      + `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="${SHEET_IDS_PROP}"><vt:lpwstr>${value}</vt:lpwstr></property></Properties>`);
    const types = files['[Content_Types].xml'] ? strFromU8(files['[Content_Types].xml']) : '';
    if (types && !types.includes('/docProps/custom.xml')) {
      files['[Content_Types].xml'] = strToU8(types.replace('</Types>', '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>'));
    }
    const rels = files['_rels/.rels'] ? strFromU8(files['_rels/.rels']) : '';
    if (rels && !rels.includes('docProps/custom.xml')) {
      files['_rels/.rels'] = strToU8(rels.replace('</Relationships>', '<Relationship Id="rIdSharCustom" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/></Relationships>'));
    }
  }
  return zipSync(files);
}

// ── книга ───────────────────────────────────────────────────────────────────

export async function newBook(): Promise<ExcelWorkbook> {
  const { Workbook } = await import('exceljs');
  const book = new Workbook();
  book.addWorksheet('Лист1');
  return book;
}

export async function bookFromBase64(base64: string): Promise<ExcelWorkbook> {
  if (!base64.trim()) return newBook();
  const { Workbook } = await import('exceljs');
  const book = new Workbook();
  const bytes = base64ToBytes(base64);
  await book.xlsx.load(bytes.buffer);
  if (!book.worksheets.length) book.addWorksheet('Лист1');
  // Условия фильтров, сортировка и номера листов — прямо из XML: ExcelJS их не читает.
  try {
    const files = unzipSync(bytes, { filter: (f) => f.name === CUSTOM_PROPS || f.name.startsWith('xl/worksheets/sheet') || f.name === 'xl/workbook.xml' || f.name === 'xl/_rels/workbook.xml.rels' });
    const ex = extrasOf(book);
    ex.sheetIds = readSheetIds(files);
    for (const [name, path] of sheetPaths(files)) {
      const file = files[path];
      if (!file) continue;
      const xml = strFromU8(file);
      const auto = AUTOFILTER_RE.exec(xml)?.[0];
      const filter = auto ? readAutoFilter(auto) : null;
      if (filter) ex.filters.set(name, filter);
      const sort = SORTSTATE_RE.exec(xml)?.[0];
      if (sort) ex.sorts.set(name, sort);
    }
  } catch { /* не zip или повреждён — ExcelJS прочитал, остального просто нет */ }
  return book;
}

/**
 * Книга → xlsx в base64. Всё, что попадает в файл, снимается синхронно в момент вызова: книгу можно менять
 * дальше, пока файл собирается (ExcelJS тоже берёт свою модель сразу).
 */
export async function bookToBase64(book: ExcelWorkbook): Promise<string> {
  const ex = extrasOf(book);
  const state = { sheetIds: new Map(ex.sheetIds), filters: new Map(ex.filters), sorts: new Map(ex.sorts) };
  const raw = new Uint8Array(await book.xlsx.writeBuffer());
  try { return bytesToBase64(finishZip(raw, state)); } catch { return bytesToBase64(raw); }
}

export async function emptyTableContent(): Promise<string> {
  return bookToBase64(await newBook());
}

// ── оформление: ExcelJS ↔ Univer ─────────────────────────────────────────────

// Даты в Excel — числа (дни от 30.12.1899) с форматом ячейки. ExcelJS отдаёт их объектом Date (в UTC);
// строкой ISO они попадали в редактор текстом «2026-10-16T00:00:00.000Z» и переставали быть датами.
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const NUMBER = 2; // CellValueType.NUMBER — импортировать нельзя: модуль грузится и без Univer
const toSerial = (date: Date) => (date.getTime() - EXCEL_EPOCH) / 86_400_000;
const isDateFormat = (format: string) => /[dmyhs]/i.test(format.replace(/"[^"]*"|\[[^\]]*\]|\./g, ''));
// Встроенные форматы 14 и 22 («краткая дата по системе») ExcelJS отдаёт американскими строками, а русский Excel
// показывает их как 16.10.2026 — так и показываем.
const SYSTEM_DATE: Record<string, string> = { 'mm-dd-yy': 'dd.mm.yyyy', 'm/d/yy': 'dd.mm.yyyy', 'm/d/yy h:mm': 'dd.mm.yyyy hh:mm', 'm/d/yy hh:mm': 'dd.mm.yyyy hh:mm' };
const datePattern = (date: Date, format?: string) => (format && SYSTEM_DATE[format]) || (format && isDateFormat(format) ? format
  : date.getUTCHours() || date.getUTCMinutes() ? 'dd.mm.yyyy hh:mm' : 'dd.mm.yyyy');

// Цвета темы Office по умолчанию (порядок ExcelJS: lt1, dk1, lt2, dk2, accent1…6, ссылка, посещённая ссылка).
const THEME = ['FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47', '0563C1', '954F72'];
// Старая палитра Excel (indexed).
const INDEXED = ('000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF 000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF '
  + '800000 008000 000080 808000 800080 008080 C0C0C0 808080 9999FF 993366 FFFFCC CCFFFF 660066 FF8080 0066CC CCCCFF '
  + '000080 FF00FF FFFF00 00FFFF 800080 800000 008080 0000FF 00CCFF CCFFFF CCFFCC FFFF99 99CCFF FF99CC CC99FF FFCC99 '
  + '3366FF 33CCCC 99CC00 FFCC00 FF9900 FF6600 666699 969696 003366 339966 003300 333300 993300 993366 333399 333333 000000 FFFFFF').split(' ');

type ExcelColor = { argb?: string; theme?: number; tint?: number; indexed?: number };

function excelColor(color: ExcelColor | undefined): string | null {
  if (!color) return null;
  let hex: string | null = null;
  if (typeof color.argb === 'string' && /^[0-9a-f]{6,8}$/i.test(color.argb)) hex = color.argb.slice(-6);
  else if (typeof color.theme === 'number') hex = THEME[color.theme] ?? null;
  else if (typeof color.indexed === 'number') hex = INDEXED[color.indexed] ?? null;
  if (!hex) return null;
  const tint = typeof color.tint === 'number' ? color.tint : 0;
  if (tint) {
    const ch = [0, 2, 4].map((i) => parseInt(hex!.slice(i, i + 2), 16)).map((c) => Math.round(tint < 0 ? c * (1 + tint) : c + (255 - c) * tint));
    hex = ch.map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0')).join('');
  }
  return `#${hex.toUpperCase()}`;
}

function univerColor(value: unknown): { argb: string } | undefined {
  const rgb = (value as { rgb?: string } | undefined)?.rgb;
  if (!rgb) return undefined;
  const hex = /^#?([0-9a-f]{6})$/i.exec(rgb)?.[1];
  if (hex) return { argb: `FF${hex.toUpperCase()}` };
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(rgb);
  return m ? { argb: `FF${[m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('').toUpperCase()}` } : undefined;
}

const BORDER_STYLES = ['', 'thin', 'hair', 'dotted', 'dashed', 'dashDot', 'dashDotDot', 'double', 'medium', 'mediumDashed', 'mediumDashDot', 'mediumDashDotDot', 'slantDashDot', 'thick'];
const H_ALIGN: Record<string, number> = { left: 1, center: 2, right: 3, justify: 4, distributed: 6, centerContinuous: 2, fill: 1 };
const H_ALIGN_BACK = ['', 'left', 'center', 'right', 'justify', 'justify', 'distributed'];
const V_ALIGN: Record<string, number> = { top: 1, middle: 2, bottom: 3, justify: 2, distributed: 2 };
const V_ALIGN_BACK = ['', 'top', 'middle', 'bottom'];
const WRAP = 3; // WrapStrategy.WRAP
const BORDER_SIDES = [['top', 't'], ['bottom', 'b'], ['left', 'l'], ['right', 'r']] as const;

type ExcelStyle = Partial<Cell['style']>;

/** Оформление ячейки Excel → стиль Univer (только то, что задано явно). */
function styleFromExcel(style: ExcelStyle | undefined, numberPattern: string | undefined): IStyleData | null {
  const out: Record<string, unknown> = {};
  const font = style?.font;
  if (font) {
    if (font.name) out.ff = font.name;
    if (typeof font.size === 'number') out.fs = font.size;
    if (font.bold) out.bl = 1;
    if (font.italic) out.it = 1;
    if (font.underline && font.underline !== 'none') out.ul = { s: 1 };
    if (font.strike) out.st = { s: 1 };
    const color = excelColor(font.color as ExcelColor | undefined);
    if (color && color !== '#000000') out.cl = { rgb: color };
  }
  const fill = style?.fill as { type?: string; pattern?: string; fgColor?: ExcelColor; bgColor?: ExcelColor } | undefined;
  if (fill?.type === 'pattern' && fill.pattern && fill.pattern !== 'none') {
    const color = excelColor(fill.fgColor) ?? excelColor(fill.bgColor);
    if (color) out.bg = { rgb: color };
  }
  const align = style?.alignment;
  if (align) {
    if (align.horizontal && H_ALIGN[align.horizontal]) out.ht = H_ALIGN[align.horizontal];
    if (align.vertical && V_ALIGN[align.vertical]) out.vt = V_ALIGN[align.vertical];
    if (align.wrapText) out.tb = WRAP;
    if (typeof align.textRotation === 'number' && align.textRotation) out.tr = { a: align.textRotation };
  }
  const border = style?.border;
  if (border) {
    const bd: Record<string, unknown> = {};
    for (const [side, key] of BORDER_SIDES) {
      const b = border[side] as { style?: string; color?: ExcelColor } | undefined;
      const s = b?.style ? BORDER_STYLES.indexOf(b.style) : -1;
      if (s > 0) bd[key] = { s, cl: { rgb: excelColor(b!.color) ?? '#000000' } };
    }
    if (Object.keys(bd).length) out.bd = bd;
  }
  if (numberPattern) out.n = { pattern: numberPattern };
  return Object.keys(out).length ? (out as IStyleData) : null;
}

/** Стиль Univer → оформление ячейки ExcelJS. */
function styleToExcel(style: IStyleData | null): ExcelStyle {
  const out: ExcelStyle = {};
  if (!style) return out;
  const s = style as Record<string, unknown>;
  const font: Record<string, unknown> = {};
  if (s.ff) font.name = s.ff;
  if (typeof s.fs === 'number') font.size = s.fs;
  if (s.bl) font.bold = true;
  if (s.it) font.italic = true;
  if ((s.ul as { s?: number } | undefined)?.s) font.underline = true;
  if ((s.st as { s?: number } | undefined)?.s) font.strike = true;
  const color = univerColor(s.cl);
  if (color) font.color = color;
  if (Object.keys(font).length) out.font = font as ExcelStyle['font'];
  const bg = univerColor(s.bg);
  if (bg) out.fill = { type: 'pattern', pattern: 'solid', fgColor: bg };
  const alignment: Record<string, unknown> = {};
  if (typeof s.ht === 'number' && H_ALIGN_BACK[s.ht]) alignment.horizontal = H_ALIGN_BACK[s.ht];
  if (typeof s.vt === 'number' && V_ALIGN_BACK[s.vt]) alignment.vertical = V_ALIGN_BACK[s.vt];
  if (s.tb === WRAP) alignment.wrapText = true;
  const rot = (s.tr as { a?: number } | undefined)?.a;
  if (typeof rot === 'number' && rot) alignment.textRotation = rot;
  if (Object.keys(alignment).length) out.alignment = alignment as ExcelStyle['alignment'];
  const bd = s.bd as Record<string, { s?: number; cl?: unknown } | null> | undefined;
  if (bd) {
    const border: Record<string, unknown> = {};
    for (const [side, key] of BORDER_SIDES) {
      const b = bd[key];
      if (b && b.s && BORDER_STYLES[b.s]) border[side] = { style: BORDER_STYLES[b.s], ...(univerColor(b.cl) ? { color: univerColor(b.cl) } : {}) };
    }
    if (Object.keys(border).length) out.border = border as ExcelStyle['border'];
  }
  const pattern = (s.n as { pattern?: string } | undefined)?.pattern;
  if (pattern) out.numFmt = pattern;
  return out;
}

/** Реестр стилей книги Univer: одинаковое оформление — один стиль; номера по порядку (у всех одинаковые). */
type StyleBook = { styles: Record<string, IStyleData>; ids: Map<string, string> };
function styleId(book: StyleBook, style: IStyleData): string {
  const key = JSON.stringify(style);
  let id = book.ids.get(key);
  if (!id) {
    id = `s${book.ids.size + 1}`;
    book.ids.set(key, id);
    book.styles[id] = style;
  }
  return id;
}

const styleKey = (style: IStyleData | null | undefined) => (style ? JSON.stringify(style) : '');

/** Текст со ссылкой или с разным оформлением частей — в формате богатого текста Univer. */
function linkParagraph(text: string, url: string): ICellData['p'] {
  return {
    id: `link-${Math.random().toString(36).slice(2, 10)}`,
    documentStyle: {},
    body: {
      dataStream: `${text}\r\n`,
      customRanges: [{ startIndex: 0, endIndex: Math.max(0, text.length - 1), rangeId: `l${Math.random().toString(36).slice(2, 10)}`, rangeType: 0, properties: { url } }],
    },
  } as unknown as ICellData['p'];
}

function richParagraph(parts: Array<{ text: string; font?: ExcelStyle['font'] }>): ICellData['p'] {
  let at = 0;
  const textRuns: Array<{ st: number; ed: number; ts: Record<string, unknown> }> = [];
  for (const part of parts) {
    const ts = styleFromExcel({ font: part.font }, undefined) as Record<string, unknown> | null;
    if (ts && part.text.length) textRuns.push({ st: at, ed: at + part.text.length, ts });
    at += part.text.length;
  }
  const text = parts.map((p) => p.text).join('');
  return { id: `rt-${Math.random().toString(36).slice(2, 10)}`, documentStyle: {}, body: { dataStream: `${text.replace(/\n/g, '\r')}\r\n`, textRuns, paragraphs: [{ startIndex: text.length }] } } as unknown as ICellData['p'];
}

/** Ссылка из ячейки Univer (если она одна на ячейку) — для записи обратно гиперссылкой xlsx. */
function cellLink(cell: ICellData): { text: string; hyperlink: string } | null {
  const body = cell.p?.body as { dataStream?: string; customRanges?: Array<{ rangeType?: number; properties?: { url?: unknown } }> } | undefined;
  const links = (body?.customRanges || []).filter((range) => range.rangeType === 0 && typeof range.properties?.url === 'string');
  if (links.length !== 1) return null;
  const text = String(body?.dataStream ?? cell.v ?? '').replace(/\r?\n$/, '').replace(/\r/g, '\n');
  return { text, hyperlink: String(links[0].properties!.url) };
}

/** Значение ячейки Excel → значение Univer (без оформления). numberPattern — формат числа для стиля. */
function valueToCell(value: CellValue, format: string | undefined): { cell: ICellData; pattern?: string } | null {
  if (value === null || value === undefined) return null;
  const numberFormat = format && format !== 'General' ? format : undefined;
  if (typeof value === 'number') return { cell: { v: value }, pattern: numberFormat };
  if (typeof value === 'string' || typeof value === 'boolean') return { cell: { v: value }, pattern: numberFormat };
  if (value instanceof Date) return { cell: { v: toSerial(value), t: NUMBER }, pattern: datePattern(value, format) };
  if (typeof value === 'object' && 'formula' in value) {
    const formula = String(value.formula || '');
    const result = value.result;
    const f = formula.startsWith('=') ? formula : `=${formula}`;
    if (result instanceof Date) return { cell: { f, v: toSerial(result), t: NUMBER }, pattern: datePattern(result, format) };
    return { cell: { f, v: typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean' ? result : null }, pattern: numberFormat };
  }
  if (typeof value === 'object' && 'sharedFormula' in value) {
    const result = (value as { result?: unknown }).result;
    return { cell: { v: typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean' ? result : null }, pattern: numberFormat };
  }
  if (typeof value === 'object' && 'richText' in value) {
    const parts = value.richText.map((part) => ({ text: part.text, font: part.font }));
    const text = parts.map((p) => p.text).join('');
    return { cell: parts.some((p) => p.font && Object.keys(p.font).length) ? { v: text, p: richParagraph(parts) } : { v: text }, pattern: numberFormat };
  }
  if (typeof value === 'object' && 'hyperlink' in value && typeof value.hyperlink === 'string' && value.hyperlink) {
    // Гиперссылка Excel → ссылка Univer (текст ячейки с диапазоном-ссылкой): кликабельна и открывается Ctrl+кликом.
    const text = String(('text' in value && value.text) || value.hyperlink);
    return { cell: { v: text, p: linkParagraph(text, value.hyperlink) } };
  }
  if (typeof value === 'object' && 'error' in value) return { cell: { v: String((value as { error: unknown }).error) } };
  if (typeof value === 'object' && 'text' in value) return { cell: { v: String(value.text || '') } };
  return { cell: { v: String(value) } };
}

const MERGE = 1; // ValueType.Merge
const ptToPx = (pt: number) => Math.round((pt * 96) / 72);
const pxToPt = (px: number) => Math.round(((px * 72) / 96) * 100) / 100;
const charsToPx = (chars: number) => Math.round(chars * 7.5);
const pxToChars = (px: number) => Math.max(0.1, px / 7.5);

type MergeMap = Record<string, { model?: { top: number; left: number; bottom: number; right: number }; top?: number; left?: number; bottom?: number; right?: number }>;
function mergesOf(sheet: Worksheet): Array<{ top: number; left: number; bottom: number; right: number }> {
  const raw = (sheet as unknown as { _merges?: MergeMap })._merges || {};
  return Object.values(raw).filter(Boolean).map((m) => m.model ?? { top: m.top!, left: m.left!, bottom: m.bottom!, right: m.right! });
}

const FILTER_RESOURCE = 'SHEET_FILTER_PLUGIN';

export function excelToUniver(book: ExcelWorkbook): Partial<IWorkbookData> {
  const ex = extrasOf(book);
  const sheets: IWorkbookData['sheets'] = {};
  const styleBook: StyleBook = { styles: {}, ids: new Map() };
  const sheetOrder: string[] = [];
  const filters: Record<string, SheetFilter> = {};
  const used = new Set<string>();
  const ids = new Map<string, string>();
  // Стиль ячейки: ExcelJS отдаёт ячейкам с одинаковым оформлением один и тот же объект стиля. Перевод, ключ и id
  // считаем раз на объект и формат числа, а не на каждую ячейку (раньше — два JSON.stringify на ячейку: на больших
  // таблицах это заметная доля открытия).
  const styleCache = new Map<unknown, Map<string, { style: IStyleData | null; key: string; id: string }>>();
  const convertStyle = (raw: ExcelStyle | undefined, pattern: string | undefined) => {
    let byPattern = styleCache.get(raw);
    if (!byPattern) { byPattern = new Map(); styleCache.set(raw, byPattern); }
    const p = pattern ?? '';
    let hit = byPattern.get(p);
    if (!hit) {
      const style = styleFromExcel(raw, pattern);
      hit = { style, key: styleKey(style), id: style ? styleId(styleBook, style) : '' };
      byPattern.set(p, hit);
    }
    return hit;
  };
  for (const [index, sheet] of book.worksheets.entries()) {
    let id = ex.sheetIds.get(sheet.name) || `sheet-${index + 1}`;
    if (used.has(id)) id = `sheet-${index + 1}-${used.size}`;
    used.add(id);
    ids.set(sheet.name, id);
    sheetOrder.push(id);

    const cellData: Record<number, Record<number, ICellData>> = {};
    const rowData: Record<number, { h?: number; hd?: number }> = {};
    const columnData: Record<number, { w?: number; hd?: number }> = {};
    (sheet.columns || []).forEach((column, columnIndex) => {
      const data: { w?: number; hd?: number } = {};
      if (typeof column.width === 'number') data.w = charsToPx(column.width);
      if (column.hidden) data.hd = 1;
      if (Object.keys(data).length) columnData[columnIndex] = data;
    });

    // Фильтр: строки, скрытые фильтром с условиями, — это «отфильтрованные», а не скрытые вручную.
    const filter = ex.filters.get(sheet.name) ?? (() => {
      const ref = typeof sheet.autoFilter === 'string' ? decodeRef(sheet.autoFilter) : null;
      return ref ? { ref, filterColumns: [] } : null;
    })();
    const filtering = Boolean(filter?.filterColumns?.length);
    const filteredOut: number[] = [];

    sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const r = rowNumber - 1;
      const data: { h?: number; hd?: number } = {};
      if (typeof row.height === 'number' && row.height > 0) data.h = ptToPx(row.height);
      if (row.hidden) {
        if (filtering && filter && r > filter.ref.startRow && r <= filter.ref.endRow) filteredOut.push(r);
        else data.hd = 1;
      }
      if (Object.keys(data).length) rowData[r] = data;
      row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
        const c = columnNumber - 1;
        const isSlave = cell.type === MERGE && cell.master && cell.master.address !== cell.address;
        // Ячейки внутри объединения ExcelJS отдают значение главной — его берём только у главной, иначе
        // текст объединённой шапки повторялся в каждой ячейке.
        // Общая формула (одна на столбец, протянутая вниз): у каждой ячейки берём её собственный вид.
        const value = cell.value && typeof cell.value === 'object' && 'sharedFormula' in cell.value && cell.formula
          ? ({ formula: cell.formula, result: (cell.value as { result?: unknown }).result } as CellValue) : cell.value;
        const parsed = isSlave ? null : valueToCell(value, cell.numFmt);
        const { style, key, id: sid } = convertStyle(cell.style, parsed?.pattern);
        const out: ICellData = parsed ? { ...parsed.cell } : {};
        if (sid) out.s = sid;
        ex.styleKeys.set(`${sheet.name}!${r}:${c}`, key);
        if (!parsed && !style) return;
        (cellData[r] ||= {})[c] = out;
      });
    });

    if (filter) {
      filters[id] = { ref: filter.ref, filterColumns: filter.filterColumns || [], ...(filteredOut.length ? { cachedFilteredOut: filteredOut } : {}) };
    }

    const view = (sheet.views || [])[0] as { state?: string; xSplit?: number; ySplit?: number; showGridLines?: boolean } | undefined;
    const xSplit = view?.state === 'frozen' ? view.xSplit || 0 : 0;
    const ySplit = view?.state === 'frozen' ? view.ySplit || 0 : 0;
    const props = sheet.properties as { tabColor?: ExcelColor; defaultRowHeight?: number } | undefined;
    const tab = excelColor(props?.tabColor);
    sheets[id] = {
      id,
      name: sheet.name,
      rowCount: Math.max(100, sheet.rowCount + 20),
      columnCount: Math.max(26, sheet.columnCount + 8),
      cellData,
      rowData,
      columnData,
      mergeData: mergesOf(sheet).map((m) => ({ startRow: m.top - 1, startColumn: m.left - 1, endRow: m.bottom - 1, endColumn: m.right - 1 })),
      ...(xSplit || ySplit ? { freeze: { xSplit, ySplit, startRow: ySplit, startColumn: xSplit } } : {}),
      ...(tab ? { tabColor: tab } : {}),
      ...(sheet.state === 'hidden' || sheet.state === 'veryHidden' ? { hidden: 1 } : {}),
      // Сетка всегда видна: у файла из Excel она часто выключена, и тогда пустые ячейки вообще без границ — в Шаре так не нужно.
    } as IWorkbookData['sheets'][string];
  }
  ex.sheetIds = ids;
  return {
    id: `shar-${crypto.randomUUID()}`,
    name: 'Шар',
    appVersion: '1.0.4',
    // LocaleType.RU_RU: значение импортировать нельзя — Univer попал бы в основной бандл вместе с чатом.
    locale: 'ruRU' as unknown as IWorkbookData['locale'],
    styles: styleBook.styles,
    sheetOrder,
    sheets,
    resources: Object.keys(filters).length ? [{ name: FILTER_RESOURCE, data: JSON.stringify(filters) }] : [],
  };
}

/** Переносит правки из снимка Univer (workbook.save(): вместе с фильтрами) обратно в книгу ExcelJS. */
export function applySnapshot(book: ExcelWorkbook, snapshot: IWorkbookData) {
  const ex = extrasOf(book);
  const filterData = (() => {
    const found = (snapshot.resources || []).find((r) => r.name === FILTER_RESOURCE);
    try { return found?.data ? JSON.parse(found.data) as Record<string, SheetFilter> : {}; } catch { return {}; }
  })();
  const nameById = new Map([...ex.sheetIds].map(([name, id]) => [id, name]));
  const kept = new Set<Worksheet>();
  const nextIds = new Map<string, string>();
  const nextFilters = new Map<string, SheetFilter>();
  const nextSorts = new Map<string, string>();

  snapshot.sheetOrder.forEach((sheetId, order) => {
    const source = snapshot.sheets[sheetId];
    if (!source?.name) return;
    const before = nameById.get(sheetId);
    let target = (before && book.getWorksheet(before)) || book.getWorksheet(source.name);
    if (target && kept.has(target)) target = undefined;
    if (!target) target = book.addWorksheet(source.name);
    if (target.name !== source.name) { try { target.name = source.name; } catch { /* имя занято другим листом */ } }
    (target as unknown as { orderNo: number }).orderNo = order;
    kept.add(target);
    nextIds.set(target.name, sheetId);
    const sort = before ? ex.sorts.get(before) : undefined;
    if (sort) nextSorts.set(target.name, sort);
    writeSheet(target, source, snapshot, ex, before ?? source.name);
    if (before && before !== target.name) {
      for (const key of [...ex.styleKeys.keys()]) if (key.startsWith(`${before}!`)) { ex.styleKeys.set(`${target.name}!${key.slice(before.length + 1)}`, ex.styleKeys.get(key)!); ex.styleKeys.delete(key); }
    }

    // Фильтр: диапазон — в ExcelJS, условия — в XML при записи; отфильтрованные строки в файле скрыты, как у Excel.
    const filter = filterData[sheetId];
    if (filter?.ref) {
      target.autoFilter = encodeRef(filter.ref);
      nextFilters.set(target.name, filter);
      for (const r of filter.cachedFilteredOut || []) target.getRow(r + 1).hidden = true;
    } else {
      (target as unknown as { autoFilter?: unknown }).autoFilter = undefined;
    }
    target.state = (source as { hidden?: number }).hidden ? 'hidden' : 'visible';
  });
  for (const ws of book.worksheets) if (!kept.has(ws)) book.removeWorksheet(ws.id);
  ex.sheetIds = nextIds;
  ex.filters = nextFilters;
  ex.sorts = nextSorts;
}

/** Текст ячейки rich text (поле `p`): абзацы — переводами строки, служебные знаки Univer убраны. */
export function richCellText(cell: ICellData): string | null {
  const stream = cell.p?.body?.dataStream;
  if (typeof stream !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const text = stream.replace(/\r\n$/, '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  return text.trim() ? text : null;
}

function writeSheet(target: Worksheet, source: IWorkbookData['sheets'][string], snapshot: IWorkbookData, ex: BookExtras, previousName: string) {
  const name = target.name;
  const resolve = (s: unknown): IStyleData | null => {
    const style = typeof s === 'string' ? snapshot.styles?.[s] : s;
    return style && typeof style === 'object' && Object.keys(style).length ? (style as IStyleData) : null;
  };
  // Стиль ячейки почти всегда — номер из реестра книги: его отпечаток считаем один раз на стиль.
  const keyById = new Map<string, string>();
  const keyOf = (s: unknown, style: IStyleData | null) => {
    if (typeof s !== 'string') return styleKey(style);
    let key = keyById.get(s);
    if (key === undefined) { key = styleKey(style); keyById.set(s, key); }
    return key;
  };

  // Объединения: снимаем только исчезнувшие и добавляем новые — снятие сбрасывает оформление ячеек внутри.
  const wanted = (source.mergeData || []).map((m) => ({ top: m.startRow + 1, left: m.startColumn + 1, bottom: m.endRow + 1, right: m.endColumn + 1 }));
  const mkey = (m: { top: number; left: number; bottom: number; right: number }) => `${m.top},${m.left},${m.bottom},${m.right}`;
  const wantedKeys = new Set(wanted.map(mkey));
  const existing = mergesOf(target);
  const existingKeys = new Set(existing.map(mkey));
  for (const m of existing) if (!wantedKeys.has(mkey(m))) target.unMergeCells(m.top, m.left, m.bottom, m.right);
  const slaves = new Set<string>();
  for (const m of wanted) {
    for (let r = m.top; r <= m.bottom; r += 1) for (let c = m.left; c <= m.right; c += 1) if (r !== m.top || c !== m.left) slaves.add(`${r - 1}:${c - 1}`);
  }

  // Значения и оформление. Что есть в файле, но исчезло в Univer, — очищается.
  const seen = new Set<string>();
  const cells = (source.cellData || {}) as Record<string, Record<string, ICellData>>;
  for (const [rowKey, columns] of Object.entries(cells)) {
    for (const [columnKey, cell] of Object.entries(columns || {})) {
      if (!cell) continue;
      const r = Number(rowKey);
      const c = Number(columnKey);
      const key = `${r}:${c}`;
      seen.add(key);
      const targetCell = target.getCell(r + 1, c + 1);
      const style = resolve(cell.s);
      const sk = keyOf(cell.s, style);
      const before = ex.styleKeys.get(`${previousName}!${key}`) ?? '';
      if (sk !== before) targetCell.style = styleToExcel(style) as Cell['style'];
      ex.styleKeys.set(`${name}!${key}`, sk);
      if (slaves.has(key) || targetCell.type === MERGE) continue;
      if (cell.f) targetCell.value = { formula: cell.f.replace(/^=/, ''), result: cell.v as string | number | boolean | undefined } as CellValue;
      else {
        const link = cellLink(cell);
        // Текст с оформлением внутри (вставка, набор в оформленной ячейке) Univer держит в `p` без `v`: без этого
        // ячейка уходила в файл пустой и текст пропадал после переоткрытия. Пишем текст; оформление ячейки — её стиль.
        targetCell.value = (link ?? cell.v ?? richCellText(cell) ?? null) as CellValue;
      }
    }
  }
  target.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      const key = `${rowNumber - 1}:${columnNumber - 1}`;
      if (seen.has(key)) return;
      if (cell.type !== MERGE) cell.value = null;
      const before = ex.styleKeys.get(`${previousName}!${key}`) ?? '';
      if (before) cell.style = {} as Cell['style'];
      ex.styleKeys.set(`${name}!${key}`, '');
    });
  });
  for (const m of wanted) {
    if (existingKeys.has(mkey(m))) continue;
    for (const key of slaves) {
      const [r, c] = key.split(':').map(Number);
      if (r + 1 >= m.top && r + 1 <= m.bottom && c + 1 >= m.left && c + 1 <= m.right) target.getCell(r + 1, c + 1).value = null;
    }
    try { target.mergeCellsWithoutStyle(m.top, m.left, m.bottom, m.right); } catch { /* пересекается со старым объединением — оставляем как есть */ }
  }

  // Строки: высота и скрытие.
  const rows = (source.rowData || {}) as Record<string, { h?: number; hd?: number; ia?: number }>;
  target.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const data = rows[rowNumber - 1];
    if (!data?.hd && row.hidden) row.hidden = false;
  });
  for (const [rowKey, data] of Object.entries(rows)) {
    if (!data) continue;
    const row = target.getRow(Number(rowKey) + 1);
    if (typeof data.h === 'number' && Number.isFinite(data.h) && data.ia !== 1) row.height = pxToPt(data.h);
    if (data.hd) row.hidden = true;
  }
  // Столбцы: ширина и скрытие.
  const columns = (source.columnData || {}) as Record<string, { w?: number; hd?: number }>;
  for (const [columnKey, column] of Object.entries(columns)) {
    if (!column) continue;
    const col = target.getColumn(Number(columnKey) + 1);
    if (typeof column.w === 'number' && Number.isFinite(column.w)) col.width = pxToChars(column.w);
    col.hidden = Boolean(column.hd);
  }
  (target.columns || []).forEach((col, index) => { if (col.hidden && !columns[index]?.hd) col.hidden = false; });

  // Закрепление строк и столбцов, сетка, цвет ярлыка.
  const freeze = (source as { freeze?: { xSplit?: number; ySplit?: number } }).freeze;
  const showGridLines = (source as { showGridlines?: number }).showGridlines !== 0;
  const xSplit = freeze?.xSplit || 0;
  const ySplit = freeze?.ySplit || 0;
  target.views = [xSplit || ySplit ? { state: 'frozen', xSplit, ySplit, showGridLines } : { state: 'normal', showGridLines }];
  const tab = (source as { tabColor?: string }).tabColor;
  const tabArgb = tab ? univerColor({ rgb: tab }) : undefined;
  target.properties.tabColor = tabArgb as Worksheet['properties']['tabColor'];
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Значение ячейки как в Excel: дата — «16.10.2026» (ExcelJS отдаёт её Date, и .text превращался в «Fri Oct 16…»). */
export function cellText(cell: Cell): string {
  const value = cell.value;
  const date = value instanceof Date ? value
    : value && typeof value === 'object' && 'result' in value && value.result instanceof Date ? value.result : null;
  if (!date) return cell.text || '';
  const time = date.getUTCHours() || date.getUTCMinutes() ? ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}` : '';
  return `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${date.getUTCFullYear()}${time}`;
}
