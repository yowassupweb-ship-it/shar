import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { base64ToBytes, bookFromBase64, cellText } from './workbook';

// Бумага для печати: белый лист и тёмный текст независимо от темы интерфейса. Значения — цвета бумаги, не интерфейса.
const PAPER_CSS = `
@page { size: A4; margin: 20mm 18mm; }
* { box-sizing: border-box; }
body { margin: 0; color: #202124; background: #fff; font: 11pt/1.55 Inter, "Segoe UI", system-ui, sans-serif; }
h1, h2, h3, h4 { line-height: 1.25; margin: 1.2em 0 .4em; break-after: avoid; }
h1 { font-size: 20pt; } h2 { font-size: 15pt; } h3 { font-size: 12.5pt; }
p { margin: 0 0 .7em; } ul, ol { margin: 0 0 .8em; padding-left: 1.4em; }
table { border-collapse: collapse; margin: 0 0 1em; width: 100%; } th, td { border: 1px solid #cfd3d8; padding: 4px 8px; text-align: left; vertical-align: top; }
pre, code { font-family: Consolas, monospace; font-size: 9.5pt; } pre { padding: 8px 10px; background: #f3f4f6; border-radius: 4px; white-space: pre-wrap; }
blockquote { margin: 0 0 .8em; padding-left: 12px; border-left: 3px solid #cfd3d8; color: #5f6368; }
a { color: #0b57d0; } img { max-width: 100%; }
`;

const escape = (text: string) => text.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] as string);

export function markdownHtml(title: string, markdown: string): string {
  const body = renderToStaticMarkup(<article><Markdown remarkPlugins={[remarkGfm, remarkBreaks]}>{markdown}</Markdown></article>);
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${escape(title)}</title><style>${PAPER_CSS}</style></head><body><h1>${escape(title)}</h1>${body}</body></html>`;
}

/** Таблица на бумаге: все листы подряд, у каждого — заголовок с именем (если листов несколько). Широкая — альбомом. */
export async function workbookHtml(title: string, base64: string): Promise<string> {
  const book = await bookFromBase64(base64);
  let widest = 0;
  const sheets = book.worksheets.map((sheet) => {
    const rows: string[] = [];
    const cols = sheet.actualColumnCount;
    widest = Math.max(widest, cols);
    sheet.eachRow({ includeEmpty: true }, (row) => {
      const cells: string[] = [];
      for (let c = 1; c <= cols; c += 1) cells.push(`<td>${escape(cellText(row.getCell(c)))}</td>`);
      rows.push(`<tr>${cells.join('')}</tr>`);
    });
    if (!rows.length) return '';
    return `${book.worksheets.length > 1 ? `<h2>${escape(sheet.name)}</h2>` : ''}<table>${rows.join('')}</table>`;
  }).join('');
  const page = widest > 6 ? '@page { size: A4 landscape; margin: 12mm; }' : '';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${escape(title)}</title><style>${PAPER_CSS}${page} table { font-size: 9.5pt; } td { white-space: pre-wrap; }</style></head><body><h1>${escape(title)}</h1>${sheets || '<p>Таблица пустая.</p>'}</body></html>`;
}

/** Печать (и «Сохранить как PDF» из окна печати): материал рисуется в скрытом фрейме на белом листе. */
export function printHtml(html: string) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  frame.srcdoc = html;
  frame.onload = () => {
    const win = frame.contentWindow;
    if (!win) { frame.remove(); return; }
    win.addEventListener('afterprint', () => frame.remove());
    window.setTimeout(() => { win.focus(); win.print(); }, 150);
    window.setTimeout(() => frame.remove(), 5 * 60_000);
  };
  document.body.appendChild(frame);
}

export function downloadBlob(fileName: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const downloadText = (fileName: string, mime: string, text: string) => downloadBlob(fileName, new Blob([text], { type: `${mime};charset=utf-8` }));

export const downloadBase64 = (fileName: string, mime: string, base64: string) => downloadBlob(fileName, new Blob([base64ToBytes(base64)], { type: mime }));

export const safeFileName = (title: string) => (title || 'материал').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'материал';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
