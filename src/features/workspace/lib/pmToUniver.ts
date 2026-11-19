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
  const baseDrawings = base.drawings || {};
  const drawings: Record<string, Record<string, unknown>> = {};
  const unitId = String(base.id || '');
  let listCounter = 0;

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
          drawings[id] = baseDrawings[id];
        } else {
          id = id || rid('img').slice(0, 10);
          const width = Number(a.width) || 400;
          const height = Math.round(width * 0.66);
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

  const paragraph = (node: Json, bullet?: { listId: string; listType: string; nestingLevel: number }) => {
    inline(node.content);
    const raw = { ...((node.attrs?.ps as Record<string, unknown> | null) || {}) };
    const paragraphId = String(raw.__id || rid('para'));
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
    for (const item of node.content || []) {
      const listType = kind === 'CHECK_LIST' && item.attrs?.checked ? 'CHECK_LIST_CHECKED' : kind;
      for (const child of item.content || []) {
        if (child.type === 'paragraph' || child.type === 'heading') {
          const ps = (child.attrs?.ps as Record<string, unknown> | null) || {};
          paragraph(child, { listId: String(ps.__list || listId), listType, nestingLevel: level });
        } else if (child.type === 'bulletList' || child.type === 'orderedList' || child.type === 'taskList') {
          list(child, level + 1, listId);
        } else {
          block(child);
        }
      }
    }
  };

  const block = (node: Json) => {
    switch (node.type) {
      case 'paragraph': case 'heading': paragraph(node); break;
      case 'bulletList': case 'orderedList': case 'taskList': listCounter += 1; list(node, 0, `l${listCounter}`); break;
      case 'horizontalRule': stream += '\f'; paragraph({ type: 'paragraph' }); break;
      default: if (node.content) node.content.forEach(block);
    }
  };

  (doc.content || []).forEach(block);
  if (!paragraphs.length) paragraph({ type: 'paragraph' });
  stream += '\n';
  const oldBreaks = (base.body?.sectionBreaks as Array<Record<string, unknown>> | undefined) || [];
  const sectionBreaks = [{ ...(oldBreaks[oldBreaks.length - 1] || { sectionId: rid('section') }), startIndex: stream.length - 1 }];

  const order = Object.keys(drawings);
  return {
    ...base,
    drawings,
    drawingsOrder: order,
    body: {
      ...(base.body || {}),
      dataStream: stream,
      textRuns,
      paragraphs,
      sectionBreaks,
      customRanges,
      customBlocks,
      tables: [],
      // Позиции украшений после правки уже не те — Univer пересчитает свои, если понадобятся.
      customDecorations: [],
    },
  };
}
