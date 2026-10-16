import type { Cell, CellValue, Workbook as ExcelWorkbook } from 'exceljs';
import type { ICellData, IStyleData, IWorkbookData } from '@univerjs/presets';

/**
 * Таблица хранится файлом xlsx (в base64): так её открывают Excel и Google Таблицы, а сервер ничего в ней
 * не разбирает. В редакторе её показывает Univer, поэтому на входе книга ExcelJS переводится в снимок
 * Univer, а правки возвращаются обратно в ту же книгу — формулы, значения и ширины столбцов.
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
  await book.xlsx.load(base64ToBytes(base64).buffer);
  if (!book.worksheets.length) book.addWorksheet('Лист1');
  return book;
}

export async function bookToBase64(book: ExcelWorkbook): Promise<string> {
  return bytesToBase64(new Uint8Array(await book.xlsx.writeBuffer()));
}

export async function emptyTableContent(): Promise<string> {
  return bookToBase64(await newBook());
}

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

/** Формат числа как стиль Univer: одинаковые форматы — один стиль на всю книгу. */
type StyleBook = { styles: Record<string, IStyleData>; ids: Map<string, string> };
function styleFor(book: StyleBook, pattern: string): string {
  let id = book.ids.get(pattern);
  if (!id) {
    id = `numfmt-${book.ids.size + 1}`;
    book.ids.set(pattern, id);
    book.styles[id] = { n: { pattern } };
  }
  return id;
}

/** Текст ячейки со ссылкой во всю длину — в формате богатого текста Univer (rangeType 0 = HYPERLINK). */
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

/** Ссылка из ячейки Univer (если она одна на ячейку) — для записи обратно гиперссылкой xlsx. */
function cellLink(cell: ICellData): { text: string; hyperlink: string } | null {
  const body = cell.p?.body as { dataStream?: string; customRanges?: Array<{ rangeType?: number; properties?: { url?: unknown } }> } | undefined;
  const links = (body?.customRanges || []).filter((range) => range.rangeType === 0 && typeof range.properties?.url === 'string');
  if (links.length !== 1) return null;
  const text = String(body?.dataStream ?? cell.v ?? '').replace(/\r?\n$/, '').replace(/\r/g, '\n');
  return { text, hyperlink: String(links[0].properties!.url) };
}

function valueToCell(value: CellValue, format: string | undefined, book: StyleBook): ICellData | null {
  if (value === null || value === undefined) return null;
  const numberFormat = format && format !== 'General' ? format : undefined;
  if (typeof value === 'number') return numberFormat ? { v: value, s: styleFor(book, numberFormat) } : { v: value };
  if (typeof value === 'string' || typeof value === 'boolean') return { v: value };
  if (value instanceof Date) return { v: toSerial(value), t: NUMBER, s: styleFor(book, datePattern(value, format)) };
  if (typeof value === 'object' && 'formula' in value) {
    const formula = String(value.formula || '');
    const result = value.result;
    const f = formula.startsWith('=') ? formula : `=${formula}`;
    if (result instanceof Date) return { f, v: toSerial(result), t: NUMBER, s: styleFor(book, datePattern(result, format)) };
    return {
      f,
      v: typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean' ? result : null,
      ...(numberFormat && typeof result === 'number' ? { s: styleFor(book, numberFormat) } : {}),
    };
  }
  if (typeof value === 'object' && 'richText' in value) return { v: value.richText.map((part) => part.text).join('') };
  if (typeof value === 'object' && 'hyperlink' in value && typeof value.hyperlink === 'string' && value.hyperlink) {
    // Гиперссылка Excel → ссылка Univer (текст ячейки с диапазоном-ссылкой): кликабельна и открывается Ctrl+кликом.
    const text = String(('text' in value && value.text) || value.hyperlink);
    return { v: text, p: linkParagraph(text, value.hyperlink) };
  }
  if (typeof value === 'object' && 'text' in value) return { v: String(value.text || '') };
  return { v: String(value) };
}

export function excelToUniver(book: ExcelWorkbook): Partial<IWorkbookData> {
  const sheets: IWorkbookData['sheets'] = {};
  const styleBook: StyleBook = { styles: {}, ids: new Map() };
  const sheetOrder: string[] = [];
  for (const [index, sheet] of book.worksheets.entries()) {
    const id = `sheet-${index + 1}`;
    sheetOrder.push(id);
    const cellData: Record<number, Record<number, ICellData>> = {};
    const columnData: Record<number, { w: number }> = {};
    (sheet.columns || []).forEach((column, columnIndex) => {
      if (typeof column.width === 'number') columnData[columnIndex] = { w: Math.round(column.width * 7.5) };
    });
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
        const next = valueToCell(cell.value, cell.numFmt, styleBook);
        if (!next) return;
        (cellData[rowNumber - 1] ||= {})[columnNumber - 1] = next;
      });
    });
    sheets[id] = {
      id,
      name: sheet.name,
      rowCount: Math.max(100, sheet.rowCount + 20),
      columnCount: Math.max(26, sheet.columnCount + 8),
      cellData,
      columnData,
    };
  }
  return {
    id: `shar-${crypto.randomUUID()}`,
    name: 'Шар',
    appVersion: '1.0.2',
    // LocaleType.RU_RU: значение импортировать нельзя — Univer попал бы в основной бандл вместе с чатом.
    locale: 'ruRU' as unknown as IWorkbookData['locale'],
    styles: styleBook.styles,
    sheetOrder,
    sheets,
  };
}

/** Переносит правки из снимка Univer обратно в книгу ExcelJS. */
export function applySnapshot(book: ExcelWorkbook, snapshot: IWorkbookData) {
  for (const sheetId of snapshot.sheetOrder) {
    const source = snapshot.sheets[sheetId];
    if (!source?.name) continue;
    const target = book.getWorksheet(source.name) ?? book.addWorksheet(source.name);
    target.eachRow({ includeEmpty: false }, (row) => row.eachCell({ includeEmpty: false }, (cell) => { cell.value = null; }));
    for (const [rowKey, columns] of Object.entries(source.cellData || {})) {
      for (const [columnKey, cell] of Object.entries((columns || {}) as Record<string, ICellData>)) {
        const targetCell = target.getCell(Number(rowKey) + 1, Number(columnKey) + 1);
        // Формат числа (дата, деньги, проценты) — обратно в ячейку, иначе Excel покажет дату числом 46311.
        const style = typeof cell.s === 'string' ? snapshot.styles?.[cell.s] : cell.s;
        const pattern = style && typeof style === 'object' ? (style as IStyleData).n?.pattern : undefined;
        if (pattern) targetCell.numFmt = pattern;
        if (cell.f) targetCell.value = { formula: cell.f.replace(/^=/, ''), result: cell.v as string | number | boolean | undefined };
        else {
          const link = cellLink(cell);
          targetCell.value = (link ?? cell.v ?? null) as CellValue;
        }
      }
    }
    for (const [columnKey, column] of Object.entries(source.columnData || {})) {
      const width = (column as { w?: unknown }).w;
      if (typeof width === 'number' && Number.isFinite(width)) target.getColumn(Number(columnKey) + 1).width = Math.max(0.1, width / 7.5);
    }
  }
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
