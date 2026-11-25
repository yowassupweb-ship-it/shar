/**
 * Документ нового редактора (ProseMirror JSON) → снимок Univer, в котором документы хранятся. Обратная сторона
 * lib/univerHtml.ts: открыли (снимок → HTML → редактор), поправили, сохранили (редактор → снимок).
 *
 * Берём исходный снимок за основу и заменяем только тело: размер страницы, поля, колонтитулы, настройки остаются
 * как были. Стиль абзаца (межстрочный, отступы, id) приезжает из атрибута ps узла — то, чего редактор не меняет,
 * возвращается без изменений. Ссылки — как в документах Шара: диапазон прямо по тексту, без служебных символов.
 */

type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[]; text?: string; marks?: Array<{ type: string; attrs?: Record<string, unknown> }> };
type Ts = Record<string, unknown>;
type Snapshot = Record<string, unknown> & {
  body?: Record<string, unknown>;
  drawings?: Record<string, Record<string, unknown>>;
  drawingsOrder?: string[];
};

const HEADING_NAMED = [4, 5, 6, 7, 8];
const NAMED_LEVEL: Record<number, number> = { 2: 1, 3: 2, 4: 1, 5: 2, 6: 3, 7: 4, 8: 5 };
const ALIGN_CODE: Record<string, number> = { left: 1, center: 2, right: 3, justify: 4 };
const ALIGN_NAME: Record<number, string> = { 2: 'center', 3: 'right', 4: 'justify', 5: 'justify', 6: 'justify' };

const rid = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

function pt(size: unknown): number | undefined {
  const m = /^([\d.]+)\s*(pt|px)?$/i.exec(String(size ?? '').trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? Math.round((m[2]?.toLowerCase() === 'px' ? n * 0.75 : n) * 100) / 100 : undefined;
}

function styleOf(marks: Json['marks']): { ts: Ts; link?: string } {
  const ts: Ts = {};
  let link: string | undefined;
  for (const mark of marks || []) {
    const a = mark.attrs || {};
    switch (mark.type) {
      case 'bold': ts.bl = 1; break;
      case 'italic': ts.it = 1; break;
      case 'underline': ts.ul = { s: 1 }; break;
      case 'strike': ts.st = { s: 1 }; break;
      case 'subscript': ts.va = 2; break;
      case 'superscript': ts.va = 3; break;
      case 'link': if (a.href) link = String(a.href); break;
      case 'textStyle':
        if (a.color) ts.cl = { rgb: String(a.color) };
        if (a.backgroundColor) ts.bg = { rgb: String(a.backgroundColor) };
        if (a.fontFamily) ts.ff = String(a.fontFamily).replace(/^["']|["']$/g, '');
        if (pt(a.fontSize)) ts.fs = pt(a.fontSize);
        break;
      default: break;
    }
  }
  return { ts, link };
}

export function pmToUniver(doc: Json, base: Snapshot): Snapshot {
  let stream = '';
  const textRuns: Array<{ st: number; ed: number; ts: Ts }> = [];
  const paragraphs: Array<Record<string, unknown>> = [];
  const customRanges: Array<Record<string, unknown>> = [];
  const customBlocks: Array<{ startIndex: number; blockId: string }> = [];
  const tables: Array<{ startIndex: number; endIndex: number; tableId: string }> = [];
  const tableSource: Record<string, Record<string, unknown>> = {};
  const baseDrawings = base.drawings || {};
  const drawings: Record<string, Record<string, unknown>> = {};
  const unitId = String(base.id || '');
  let listCounter = 0;
  const paragraphIds = new Set<string>();

  const pushRun = (st: number, ed: number, ts: Ts) => {
    if (ed <= st || !Object.keys(ts).length) return;
    const last = textRuns[textRuns.length - 1];
    if (last && last.ed === st && JSON.stringify(last.ts) === JSON.stringify(ts)) { last.ed = ed; return; }
    textRuns.push({ st, ed, ts });
  };
  const pushLink = (st: number, ed: number, url: string) => {
    const last = customRanges[customRanges.length - 1] as { endIndex: number; properties: { url: string } } | undefined;
    if (last && last.endIndex === st - 1 && last.properties.url === url) { last.endIndex = ed - 1; return; }
    customRanges.push({ startIndex: st, endIndex: ed - 1, rangeId: rid('link').slice(0, 21), rangeType: 0, properties: { url } });
  };

  const inline = (nodes: Json[] = []) => {
    for (const node of nodes) {
      if (node.type === 'text' && node.text) {
        const { ts, link } = styleOf(node.marks);
        // Служебные символы потока Univer в тексте недопустимы — заменяем пробелом.
        // eslint-disable-next-line no-control-regex
        const text = node.text.replace(/[\r\n\f\v\b\x00-\x08\x0e-\x1f]/g, ' ');
        const st = stream.length;
        stream += text;
        pushRun(st, stream.length, ts);
        if (link) pushLink(st, stream.length, link);
      } else if (node.type === 'hardBreak') {
        stream += '\v';
      } else if (node.type === 'image') {
        const a = node.attrs || {};
        let id = typeof a.blockId === 'string' && a.blockId ? a.blockId : '';
        if (id && baseDrawings[id]) {
          const old = baseDrawings[id];
          const transform = (old.transform || {}) as Record<string, unknown>;
          const docTransform = (old.docTransform || {}) as Record<string, unknown>;
          const oldSize = (docTransform.size || {}) as Record<string, unknown>;
          const oldWidth = Number(transform.width || oldSize.width) || 400;
          const oldHeight = Number(transform.height || oldSize.height) || oldWidth * 0.66;
          const width = Number(a.width) > 0 ? Number(a.width) : oldWidth;
          const height = Number(a.height) > 0 ? Number(a.height) : Math.round(width * oldHeight / oldWidth);
          drawings[id] = { ...old, transform: { ...transform, width, height }, docTransform: { ...docTransform, size: { ...oldSize, width, height } } };
        } else {
          id = id || rid('img').slice(0, 10);
          const width = Number(a.width) || 400;
          const height = Number(a.height) > 0 ? Number(a.height) : Math.round(width * 0.66);
          drawings[id] = {
            drawingId: id, title: String(a.title || ''), description: String(a.alt || ''), imageSourceType: 'URL', source: String(a.src || ''),
            transform: { width, height, left: 0 },
            docTransform: { size: { width, height }, positionH: { relativeFrom: 0, posOffset: 0 }, positionV: { relativeFrom: 1, posOffset: 0 }, angle: 0 },
            layoutType: 0, drawingType: 0, unitId, subUnitId: unitId,
          };
        }
        customBlocks.push({ startIndex: stream.length, blockId: id });
        stream += '\b';
      }
    }
  };

  const paragraph = (node: Json, bullet?: { listId: string; listType: string; nestingLevel: number; startNumber?: number }) => {
    inline(node.content);
    const raw = { ...((node.attrs?.ps as Record<string, unknown> | null) || {}) };
    const previousId = String(raw.__id || '');
    const paragraphId = previousId && !paragraphIds.has(previousId) ? previousId : rid('para');
    paragraphIds.add(paragraphId);
    delete raw.__id;
    delete raw.__list;
    const style: Record<string, unknown> = raw;
    // Заголовок: прежний стиль, если он того же уровня; иначе — стандартный заголовок нужного уровня.
    if (node.type === 'heading') {
      const level = Number(node.attrs?.level) || 1;
      if (NAMED_LEVEL[Number(style.namedStyleType)] !== level) style.namedStyleType = HEADING_NAMED[Math.min(level, 5) - 1];
    } else if (NAMED_LEVEL[Number(style.namedStyleType)]) {
      delete style.namedStyleType;
    }
    // Выравнивание: выбрали в редакторе — его; сняли (по левому краю) — сбрасываем прежнее центрирование.
    const align = node.attrs?.textAlign ? String(node.attrs.textAlign) : '';
    if (align && align !== 'left') style.horizontalAlign = ALIGN_CODE[align];
    else if (ALIGN_NAME[Number(style.horizontalAlign)]) style.horizontalAlign = 1;
    const entry: Record<string, unknown> = { startIndex: stream.length, paragraphId, paragraphStyle: style };
    if (bullet) entry.bullet = bullet;
    paragraphs.push(entry);
    stream += '\r';
  };

  const list = (node: Json, level: number, listId: string) => {
    const kind = node.type === 'orderedList' ? 'ORDER_LIST' : node.type === 'taskList' ? 'CHECK_LIST' : 'BULLET_LIST';
    let first = true;
    for (const item of node.content || []) {
      const listType = kind === 'CHECK_LIST' && item.attrs?.checked ? 'CHECK_LIST_CHECKED' : kind;
      for (const child of item.content || []) {
        if (child.type === 'paragraph' || child.type === 'heading') {
          // Identity belongs to the current list, not the paragraph's imported list.
          paragraph(child, { listId, listType, nestingLevel: level,
            ...(first && kind === 'ORDER_LIST' ? { startNumber: Number(node.attrs?.start) || 1 } : {}),
          });
          first = false;
        } else if (child.type === 'bulletList' || child.type === 'orderedList' || child.type === 'taskList') {
          listCounter += 1;
          list(child, level + 1, `shar-list-${listCounter}`);
        } else {
          block(child);
        }
      }
    }
  };

  /**
   * Таблица в потоке Univer: «\x1A» строки «\x1B» ячейки «\x1C» абзацы «\x1D» «\x0E» «\x0F»; свойства — в tableSource
   * по id (строки и ячейки — по порядку, как в потоке). Прежние свойства (src) берём как были, меняем только то, что
   * правится здесь: объединение, ширину столбцов, заливку ячейки. Новые строки и ячейки — по образцу соседних.
   */
  const table = (node: Json) => {
    const src = { ...((node.attrs?.src as Record<string, unknown> | null) || {}) };
    let tableId = typeof src.tableId === 'string' && src.tableId && !tableSource[src.tableId] ? src.tableId : '';
    if (!tableId) tableId = rid('t').slice(0, 8);
    const rows = (node.content || []).filter((r) => r.type === 'tableRow');
    // Сетка столбцов: по самой «широкой» строке; ширины — из colwidth ячеек первой строки, где они заданы.
    let columns = 0;
    const widths: number[] = [];
    rows.forEach((row) => {
      let col = 0;
      for (const cell of row.content || []) {
        const span = Math.max(1, Number(cell.attrs?.colspan) || 1);
        const cw = Array.isArray(cell.attrs?.colwidth) ? (cell.attrs!.colwidth as unknown[]) : [];
        for (let k = 0; k < span; k += 1) if (!widths[col + k] && Number(cw[k]) > 0) widths[col + k] = Number(cw[k]);
        col += span;
      }
      columns = Math.max(columns, col);
    });
    const style = (base.documentStyle || {}) as { pageSize?: { width?: number }; marginLeft?: number; marginRight?: number };
    const content = Math.max(200, (style.pageSize?.width || 794) - (style.marginLeft ?? 72) - (style.marginRight ?? 72));
    const known = widths.filter((w) => w > 0);
    const rest = columns - known.length;
    const fallback = rest > 0 ? Math.max(40, (content - known.reduce((a, b) => a + b, 0)) / rest) : 0;
    const tableColumns = Array.from({ length: Math.max(1, columns) }, (_, i) => ({ size: { type: 1, width: { v: Math.round(widths[i] || fallback || content / Math.max(1, columns)) } } }));

    const startIndex = stream.length;
    stream += '\x1A';
    let lastRow: Record<string, unknown> | null = null;
    const tableRows = rows.map((row) => {
      stream += '\x1B';
      const rowSrc = { ...((row.attrs?.src as Record<string, unknown> | null) || lastRow || { trHeight: { val: { v: 30 }, hRule: 0 } }) };
      delete rowSrc.tableCells;
      lastRow = rowSrc;
      let lastCell: Record<string, unknown> = {};
      const tableCells = (row.content || []).map((cell) => {
        stream += '\x1C';
        const blocks = cell.content || [];
        const before = paragraphs.length;
        blocks.forEach(block);
        // В ячейке всегда хотя бы один абзац: поток ячейки должен кончаться «\r».
        if (paragraphs.length === before || stream[stream.length - 1] !== '\r') paragraph({ type: 'paragraph' });
        stream += '\x1D';
        const own = (cell.attrs?.src as Record<string, unknown> | null) || null;
        const cellSrc: Record<string, unknown> = { ...(own || lastCell) };
        const colspan = Math.max(1, Number(cell.attrs?.colspan) || 1);
        const rowspan = Math.max(1, Number(cell.attrs?.rowspan) || 1);
        if (colspan > 1) cellSrc.columnSpan = colspan; else delete cellSrc.columnSpan;
        if (rowspan > 1) cellSrc.rowSpan = rowspan; else delete cellSrc.rowSpan;
        const bg = cell.attrs?.background ? String(cell.attrs.background) : '';
        if (bg) cellSrc.backgroundColor = { rgb: bg }; else delete cellSrc.backgroundColor;
        delete cellSrc.size;
        if (own) lastCell = { ...own, backgroundColor: undefined };
        return JSON.parse(JSON.stringify(cellSrc)) as Record<string, unknown>;
      });
      stream += '\x0E';
      return { ...rowSrc, tableCells };
    });
    stream += '\x0F';
    tables.push({ startIndex, endIndex: stream.length, tableId });
    delete src.tableRows;
    delete src.tableColumns;
    tableSource[tableId] = {
      align: 0, indent: { v: 0 }, textWrap: 0,
      position: { positionH: { relativeFrom: 0, posOffset: 0 }, positionV: { relativeFrom: 0, posOffset: 0 } },
      dist: { distB: 0, distL: 0, distR: 0, distT: 0 },
      cellMargin: { start: { v: 10 }, end: { v: 10 }, top: { v: 5 }, bottom: { v: 5 } },
      size: { type: 0, width: { v: content } },
      ...src,
      tableId,
      tableRows,
      tableColumns,
    };
  };

  const block = (node: Json) => {
    switch (node.type) {
      case 'paragraph': case 'heading': paragraph(node); break;
      case 'bulletList': case 'orderedList': case 'taskList': listCounter += 1; list(node, 0, `shar-list-${listCounter}`); break;
      case 'horizontalRule': stream += '\f'; paragraph({ type: 'paragraph' }); break;
      case 'table': table(node); break;
      default: if (node.content) node.content.forEach(block);
    }
  };

  (doc.content || []).forEach(block);
  // Документ не кончается таблицей: после неё нужен абзац, куда можно поставить курсор (так и в Univer).
  if (!paragraphs.length || stream[stream.length - 1] === '') paragraph({ type: 'paragraph' });
  stream += '\n';
  const oldBreaks = (base.body?.sectionBreaks as Array<Record<string, unknown>> | undefined) || [];
  const sectionBreaks = [{ ...(oldBreaks[oldBreaks.length - 1] || { sectionId: rid('section') }), startIndex: stream.length - 1 }];

  const order = Object.keys(drawings);
  return {
    ...base,
    drawings,
    drawingsOrder: order,
    tableSource,
    body: {
      ...(base.body || {}),
      dataStream: stream,
      textRuns,
      paragraphs,
      sectionBreaks,
      customRanges,
      customBlocks,
      tables,
      // Позиции украшений после правки уже не те — Univer пересчитает свои, если понадобятся.
      customDecorations: [],
    },
  };
}
