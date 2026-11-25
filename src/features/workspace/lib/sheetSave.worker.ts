/**
 * Сохранение своей таблицы в фоне: перенос снимка в книгу ExcelJS и сборка xlsx занимают десятки–сотни миллисекунд
 * и раньше шли в главном потоке через 0,7 с после каждой правки — лист на это время замирал. Поток держит свою копию
 * книги: загружает её из содержимого, с которым таблицу открыли (key), и при каждом сохранении применяет снимок —
 * ровно как делал главный поток.
 */
import type { Workbook as ExcelWorkbook } from 'exceljs';
import { applySnapshot, bookFromBase64, bookToBase64 } from './workbook';

type SaveRequest = { id: number; key: string; content: string; snapshot: unknown };

let current: { key: string; book: ExcelWorkbook } | null = null;

self.onmessage = async (event: MessageEvent<SaveRequest>) => {
  const { id, key, content, snapshot } = event.data;
  try {
    if (!current || current.key !== key) current = { key, book: await bookFromBase64(content) };
    applySnapshot(current.book, snapshot as never);
    const out = await bookToBase64(current.book);
    (self as unknown as Worker).postMessage({ id, ok: true, content: out });
  } catch (error) {
    current = null;
    (self as unknown as Worker).postMessage({ id, ok: false, error: String(error) });
  }
};
