import { uploadFileWithProgress } from '@/shared/api/uploadFile';
import { attachmentUrl } from '@/shared/ui/format';
import type { Kind } from '../types';
import { markdownToSnapshot } from './docSnapshot';
import { htmlToMarkdown } from './htmlToMarkdown';
import { parseCsv, readText } from './text';
import { bookFromBase64, bookToBase64, bytesToBase64, newBook } from './workbook';

export interface Imported { kind: Kind; title: string; content: string }

const stripExt = (name: string) => name.replace(/\.[^.]+$/, '');

async function uploadBlob(blob: Blob, name: string): Promise<string> {
  const result = await uploadFileWithProgress(new File([blob], name, { type: blob.type }), () => undefined);
  return attachmentUrl(result.url);
}

async function imageSize(blob: Blob): Promise<{ w: number; h: number } | null> {
  try {
    const bitmap = await createImageBitmap(blob);
    const size = { w: bitmap.width, h: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    // <img> терпимее к слегка испорченным файлам и понимает SVG; EMF/WMF из старых документов не рисует никто —
    // такая картинка встанет с размером по умолчанию.
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img.naturalWidth ? { w: img.naturalWidth, h: img.naturalHeight } : null;
    } catch {
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/** Ячейка CSV: число — числом, в том числе «15 000» и «9 500,50» (пробел — разделитель разрядов в русских выгрузках). */
function csvValue(cell: string): string | number {
  const compact = cell.trim().replace(/\s/g, ''); // \s в JS включает и неразрывные пробелы
  return compact !== '' && compact.length < 16 && /^-?\d+([.,]\d+)?$/.test(compact) ? Number(compact.replace(',', '.')) : cell;
}

/** dataURL страницы PDF → файл в хранилище Шара → короткая ссылка вместо мегабайт в презентации. */
async function uploadDataUrl(dataUrl: string): Promise<string> {
  const blob = await (await fetch(dataUrl)).blob();
  const result = await uploadFileWithProgress(new File([blob], 'page.jpg', { type: blob.type || 'image/jpeg' }), () => undefined);
  return attachmentUrl(result.url);
}

/** Что подходит в каждом разделе: в «Документах» — документы, в «Таблицах» — таблицы и так далее. */
export const IMPORT_RULES: Record<Kind | 'all', { accept: string; label: string; hint: string }> = {
  all: { accept: '.docx,.md,.markdown,.txt,.xlsx,.xlsm,.csv,.pdf', label: 'Импорт файла', hint: 'Word, Markdown, Excel, CSV, PDF — станет заметкой, документом, таблицей или презентацией по типу файла' },
  note: { accept: '.docx,.md,.markdown,.txt', label: 'Импорт заметки', hint: 'Markdown, текст или Word' },
  document: { accept: '.docx,.md,.markdown,.txt', label: 'Импорт документа', hint: 'Word (.docx), Markdown или текст' },
  table: { accept: '.xlsx,.xlsm,.csv', label: 'Импорт таблицы', hint: 'Excel (.xlsx) или CSV' },
  presentation: { accept: '.pdf', label: 'Импорт презентации', hint: 'PDF: каждая страница станет слайдом' },
};

/**
 * Файл с компьютера → новый материал по расширению: Word, Markdown и текст — документ (в разделе «Заметки» — заметка);
 * Excel и CSV — таблица; PDF — презентация (каждая страница — слайд). `scope` — раздел, из которого импортируют:
 * чужой тип файла там отклоняется понятной подсказкой. Бросает Error с текстом для человека.
 */
export async function importFile(file: File, onProgress?: (done: number, total: number) => void, scope: Kind | 'all' = 'all'): Promise<Imported> {
  const name = file.name.toLowerCase();
  const title = stripExt(file.name).slice(0, 200);
  const rule = IMPORT_RULES[scope];
  const ext = (name.match(/\.[^.]+$/) || [''])[0];
  if (!rule.accept.split(',').includes(ext)) throw new Error(`Здесь подходит: ${rule.hint}`);
  const asNote = scope === 'note';

  if (ext === '.docx') {
    const mammoth = await import('mammoth');
    // Картинки из Word — в хранилище Шара; размер едет в адресе (#ШxВ), его разберёт markdownToSnapshot.
    const convertImage = mammoth.images.imgElement(async (image) => {
      const blob = new Blob([await image.readAsArrayBuffer()], { type: image.contentType });
      const size = await imageSize(blob);
      const url = await uploadBlob(blob, `image.${(image.contentType.split('/')[1] || 'png').replace('jpeg', 'jpg')}`);
      return { src: size ? `${url}#${size.w}x${size.h}` : url };
    });
    const { value } = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() }, { convertImage });
    const markdown = htmlToMarkdown(value);
    return asNote ? { kind: 'note', title, content: markdown } : { kind: 'document', title, content: JSON.stringify(markdownToSnapshot(title, markdown)) };
  }
  if (/\.(md|markdown|txt)$/.test(name)) {
    const text = await readText(file);
    return asNote ? { kind: 'note', title, content: text } : { kind: 'document', title, content: JSON.stringify(markdownToSnapshot(title, text)) };
  }
  if (/\.(xlsx|xlsm)$/.test(name)) {
    const base64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
    try { await bookFromBase64(base64); } catch { throw new Error('Не удалось прочитать файл Excel'); }
    return { kind: 'table', title, content: base64 };
  }
  if (ext === '.csv') {
    const book = await newBook();
    const sheet = book.worksheets[0];
    for (const cells of parseCsv(await readText(file))) {
      sheet.addRow(cells.map(csvValue));
    }
    return { kind: 'table', title, content: await bookToBase64(book) };
  }
  if (ext === '.pdf') {
    const { pdfToDeck } = await import('../slides/importPdf');
    const deck = await pdfToDeck(file, uploadDataUrl, onProgress);
    return { kind: 'presentation', title, content: JSON.stringify(deck) };
  }
  throw new Error(`Подходят файлы: ${IMPORT_RULES.all.hint}`);
}

export const IMPORT_ACCEPT = IMPORT_RULES.all.accept;
