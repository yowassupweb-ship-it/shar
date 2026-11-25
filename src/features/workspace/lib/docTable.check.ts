import { Editor } from '@tiptap/core';
import { docExtensions } from '../editors/docSchema';
import { univerToHtml } from './univerHtml';
import { pmToUniver } from './pmToUniver';

/**
 * Проверка таблиц в новом редакторе (не для сборки, запускается вручную в окне с Vite:
 * `await (await import('/src/features/workspace/lib/docTable.check.ts')).run()`).
 * Снимок Univer с таблицей → редактор → снимок: структура потока, свойства таблицы, строк и ячеек, объединение,
 * ширины столбцов и заливка должны вернуться; повторный круг — дать тот же снимок.
 */

type Snap = Record<string, unknown> & { body: { dataStream: string; tables: Array<{ startIndex: number; endIndex: number; tableId: string }>; paragraphs: Array<{ startIndex: number }> }; tableSource: Record<string, { tableRows: Array<{ tableCells: Array<Record<string, unknown>>; trHeight?: unknown }>; tableColumns: Array<{ size: { width: { v: number } } }>; cellMargin?: unknown }> };

function sample(): Snap {
  // До | таблица 2×2 (первая ячейка — два абзаца) | После
  const stream = 'До\r\x1A\x1B\x1Ca\rb\r\x1D\x1Cc\r\x1D\x0E\x1B\x1Cd\r\x1D\x1Ce\r\x1D\x0E\x0FПосле\r\n';
  const paragraphs: Array<{ startIndex: number; paragraphId: string; paragraphStyle: Record<string, unknown> }> = [];
  for (let i = 0; i < stream.length; i += 1) if (stream[i] === '\r') paragraphs.push({ startIndex: i, paragraphId: `p${i}`, paragraphStyle: {} });
  const start = stream.indexOf('\x1A');
  const end = stream.indexOf('\x0F') + 1;
  const cell = (extra: Record<string, unknown> = {}) => ({ margin: { start: { v: 7 }, end: { v: 7 }, top: { v: 3 }, bottom: { v: 3 } }, ...extra });
  return {
    id: 'doc1',
    documentStyle: { pageSize: { width: 794, height: 1124 }, marginLeft: 72, marginRight: 72 },
    body: { dataStream: stream, textRuns: [], paragraphs, customRanges: [], customBlocks: [], sectionBreaks: [{ startIndex: stream.length - 1 }], tables: [{ startIndex: start, endIndex: end, tableId: 'tbl1' }] },
    tableSource: {
      tbl1: {
        tableId: 'tbl1', align: 1, cellMargin: { start: { v: 7 }, end: { v: 7 }, top: { v: 3 }, bottom: { v: 3 } },
        tableColumns: [{ size: { type: 1, width: { v: 300 } } }, { size: { type: 1, width: { v: 350 } } }],
        tableRows: [
          { trHeight: { val: { v: 44 }, hRule: 1 }, tableCells: [cell({ backgroundColor: { rgb: '#ffe599' } }), cell()] },
          { trHeight: { val: { v: 30 }, hRule: 0 }, tableCells: [cell(), cell()] },
        ],
      },
    },
  } as unknown as Snap;
}

function roundtrip(snap: Snap): { html: string; next: Snap; json: unknown } {
  const el = document.createElement('div');
  const ed = new Editor({ element: el, extensions: docExtensions(), content: univerToHtml(snap as never, { editor: true }) });
  const json = ed.getJSON();
  const next = pmToUniver(json as never, snap as never) as unknown as Snap;
  ed.destroy();
  return { html: univerToHtml(snap as never, { editor: true }), next, json };
}

export function run(): { ok: boolean; problems: string[]; stream: string; stable: boolean } {
  const problems: string[] = [];
  const src = sample();
  const { next } = roundtrip(src);
  const t = next.body.tables?.[0];
  if (!t) problems.push('таблица пропала из body.tables');
  if (next.body.dataStream !== src.body.dataStream) problems.push(`поток другой: ${JSON.stringify(next.body.dataStream)}`);
  if (t && next.body.dataStream[t.startIndex] !== '\x1A') problems.push('startIndex не на начале таблицы');
  if (t && next.body.dataStream[t.endIndex - 1] !== '\x0F') problems.push('endIndex не сразу после конца таблицы');
  const ts = t ? next.tableSource?.[t.tableId] : undefined;
  if (!ts) problems.push('нет tableSource');
  else {
    if (t!.tableId !== 'tbl1') problems.push('id таблицы сменился');
    if (JSON.stringify(ts.tableColumns.map((c) => c.size.width.v)) !== '[300,350]') problems.push(`ширины столбцов: ${JSON.stringify(ts.tableColumns)}`);
    if (JSON.stringify(ts.tableRows[0].trHeight) !== JSON.stringify({ val: { v: 44 }, hRule: 1 })) problems.push('высота строки потерялась');
    if ((ts.tableRows[0].tableCells[0].backgroundColor as { rgb?: string } | undefined)?.rgb?.toLowerCase() !== '#ffe599' && !/255, 229, 153/.test(String((ts.tableRows[0].tableCells[0].backgroundColor as { rgb?: string } | undefined)?.rgb))) problems.push(`заливка: ${JSON.stringify(ts.tableRows[0].tableCells[0])}`);
    if (!ts.tableRows[1].tableCells[1].margin) problems.push('поля ячейки потерялись');
    if (JSON.stringify(ts.cellMargin) !== JSON.stringify(src.tableSource.tbl1.cellMargin)) problems.push('поля таблицы потерялись');
  }
  const paraCount = (next.body.paragraphs || []).length;
  if (paraCount !== src.body.paragraphs.length) problems.push(`абзацев ${paraCount}, было ${src.body.paragraphs.length}`);
  // Второй круг — то же самое (иначе каждое сохранение будет менять документ).
  const again = roundtrip(next).next;
  const strip = (s: Snap) => JSON.stringify({ ds: s.body.dataStream, t: s.body.tables, ts: s.tableSource });
  const stable = strip(again) === strip(next);
  if (!stable) problems.push('второй круг дал другой снимок');
  // Объединение: новая таблица 3×3, объединили две ячейки первой строки.
  const el = document.createElement('div');
  const ed = new Editor({ element: el, extensions: docExtensions(), content: '<p>x</p>' });
  ed.chain().setTextSelection(1).insertTable({ rows: 3, cols: 3, withHeaderRow: false }).run();
  let firstCell = -1;
  ed.state.doc.descendants((n, pos) => { if (firstCell < 0 && n.type.name === 'tableCell') firstCell = pos; });
  const second = firstCell + ed.state.doc.nodeAt(firstCell)!.nodeSize;
  ed.chain().setCellSelection({ anchorCell: firstCell, headCell: second }).mergeCells().run();
  const merged = pmToUniver(ed.getJSON() as never, { id: 'doc2', body: {} } as never) as unknown as Snap;
  ed.destroy();
  const mt = merged.body.tables?.[0];
  const mcells = mt ? merged.tableSource[mt.tableId].tableRows[0].tableCells : [];
  if (!mt) problems.push('новая таблица не сохранилась');
  else if (mcells.length !== 2 || mcells[0].columnSpan !== 2) problems.push(`объединение: ${JSON.stringify(mcells)}`);
  if (mt && merged.tableSource[mt.tableId].tableColumns.length !== 3) problems.push('у объединённой таблицы не 3 столбца');
  return { ok: problems.length === 0, problems, stream: JSON.stringify(next.body.dataStream), stable };
}
