/**
 * Документ Univer (снимок) → HTML без потерь того, что люди реально делают в документах: абзацы и заголовки,
 * списки (маркированные, нумерованные, чек-листы, вложенность), выравнивание, жирный, курсив, подчёркнутый,
 * зачёркнутый, цвет и фон текста, кегль, верхний/нижний индекс, ссылки, картинки, таблицы, разрывы страниц.
 *
 * Зачем: 1) «Копировать весь документ» — в буфер уходит текст из модели, а не то, что успел разложить холст;
 * 2) переезд документов на новый редактор (TipTap/ProseMirror понимает этот HTML напрямую).
 *
 * Поток Univer (body.dataStream) — текст со служебными символами: «\r» — конец абзаца, «\n» — конец раздела,
 * «\x1A…\x0F» — таблица (строки «\x1B…\x0E», ячейки «\x1C…\x1D»), «\x1F…\x1E» — границы ссылки и прочих
 * диапазонов, «\b» — встроенный объект (картинка), «\f» — разрыв страницы. Оформление символов — в textRuns
 * (полуинтервалы [st, ed)), абзаца — в paragraphs (startIndex указывает на его «\r»).
 */

interface Ts {
  bl?: number; it?: number; fs?: number; ff?: string; va?: number;
  ul?: { s?: number }; st?: { s?: number };
  cl?: { rgb?: string | null }; bg?: { rgb?: string | null };
}
interface Run { st: number; ed: number; ts?: Ts }
interface Para {
  startIndex: number;
  paragraphId?: string;
  paragraphStyle?: { namedStyleType?: number; horizontalAlign?: number; headingId?: string } & Record<string, unknown>;
  bullet?: { listId: string; listType?: string; nestingLevel?: number; startNumber?: number };
}
interface Range { startIndex: number; endIndex: number; rangeType: number; properties?: { url?: string } }
interface Block { startIndex: number; blockId: string }
interface Snapshot {
  body?: { dataStream?: string; textRuns?: Run[]; paragraphs?: Para[]; customRanges?: Range[]; customBlocks?: Block[] };
  lists?: Record<string, { listType?: string }>;
  drawings?: Record<string, { source?: unknown; title?: string; description?: string; transform?: { width?: number; height?: number } }>;
}

const NAMED_TAG: Record<number, string> = { 2: 'h1', 3: 'h2', 4: 'h1', 5: 'h2', 6: 'h3', 7: 'h4', 8: 'h5' };
const ALIGN: Record<number, string> = { 2: 'center', 3: 'right', 4: 'justify', 5: 'justify', 6: 'justify' };
const HYPERLINK = 0;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const safeUrl = (u: string) => (/^(https?:|mailto:|tel:|\/)/i.test(u.trim()) ? u.trim() : '');
const color = (c?: string | null) => (c && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i.test(c.trim()) ? c.trim() : '');

function listKind(snapshot: Snapshot, b: NonNullable<Para['bullet']>): 'ul' | 'ol' | 'task' {
  const type = String(b.listType || snapshot.lists?.[b.listId]?.listType || b.listId || '').toUpperCase();
  if (type.includes('CHECK')) return 'task';
  return type.includes('ORDER') ? 'ol' : 'ul';
}

function inlineHtml(text: string, ts: Ts | undefined): string {
  let html = esc(text).replace(/\t/g, '&emsp;').replace(/\v/g, '<br>');
  if (!ts) return html;
  const css: string[] = [];
  const cl = color(ts.cl?.rgb);
  const bg = color(ts.bg?.rgb);
  if (cl && cl.toLowerCase() !== '#000000' && cl.toLowerCase() !== 'rgb(0,0,0)') css.push(`color:${cl}`);
  if (bg) css.push(`background-color:${bg}`);
  // Кавычки в списке шрифтов — одинарные: двойные закрыли бы атрибут style.
  if (ts.ff) css.push(`font-family:${esc(ts.ff.replace(/;/g, '').replace(/"/g, "'"))}`);
  if (ts.fs && ts.fs !== 11) css.push(`font-size:${Math.round(ts.fs * 100) / 100}pt`);
  if (css.length) html = `<span style="${css.join(';')}">${html}</span>`;
  if (ts.va === 2) html = `<sub>${html}</sub>`;
  if (ts.va === 3) html = `<sup>${html}</sup>`;
  if (ts.st?.s) html = `<s>${html}</s>`;
  if (ts.ul?.s) html = `<u>${html}</u>`;
  if (ts.it) html = `<em>${html}</em>`;
  if (ts.bl) html = `<strong>${html}</strong>`;
  return html;
}

export interface UniverHtmlOptions {
  /** Картинка: адрес из рисунка; null — пропустить. По умолчанию — source рисунка как есть. */
  image?: (source: string) => string | null;
  /** Для нового редактора: стиль абзаца целиком (data-ps) и id картинки (data-block-id) — чтобы сохранить без потерь. */
  editor?: boolean;
}

export function univerToHtml(snapshot: Snapshot, options: UniverHtmlOptions = {}): string {
  return convert(snapshot, options);
}

function convert(snapshot: Snapshot, options: UniverHtmlOptions): string {
  const body = snapshot.body;
  const stream = String(body?.dataStream || '');
  if (!stream) return '';
  const paraAt = new Map((body?.paragraphs || []).map((p) => [p.startIndex, p]));
  const links = (body?.customRanges || []).filter((r) => r.rangeType === HYPERLINK && r.properties?.url);
  const blockAt = new Map((body?.customBlocks || []).map((b) => [b.startIndex, b.blockId]));
  const imageOf = options.image ?? ((source: string) => source);

  // Оформление каждого символа. Фрагменты могут перекрываться — как и в Univer (engine-render getTextRun), побеждает
  // тот, что стоит в списке позже.
  const styles = new Array<Ts | undefined>(stream.length);
  for (const run of body?.textRuns || []) for (let i = Math.max(0, run.st); i < Math.min(run.ed, stream.length); i += 1) styles[i] = run.ts;
  const styleAt = (i: number): Ts | undefined => styles[i];
  const linkAt = (i: number) => links.find((r) => r.startIndex <= i && i <= r.endIndex);

  // Строим абзацы и таблицы; списки сворачиваем после.
  type Item = { kind: 'para'; tag: string; align: string; html: string; ps?: string; bullet?: { kind: 'ul' | 'ol' | 'task'; level: number; id?: string; start?: number; checked?: boolean } }
    | { kind: 'raw'; html: string };
  const out: Item[] = [];
  // Стек таблиц: каждая — строки → ячейки → HTML абзацев внутри.
  const tables: Array<{ rows: string[][]; cell: Item[] | null }> = [];
  let inline = '';
  let pending = '';
  let pendingTs: Ts | undefined;
  let pendingLink: string | undefined;

  const flushText = () => {
    if (!pending) return;
    let html = inlineHtml(pending, pendingTs);
    if (pendingLink) html = `<a href="${esc(pendingLink)}">${html}</a>`;
    inline += html;
    pending = '';
  };
  const sink = (): Item[] => tables[tables.length - 1]?.cell ?? out;
  const endParagraph = (index: number) => {
    flushText();
    const p = paraAt.get(index);
    const tag = NAMED_TAG[p?.paragraphStyle?.namedStyleType ?? 0] ?? 'p';
    const align = ALIGN[p?.paragraphStyle?.horizontalAlign ?? 0] ?? '';
    const bullet = p?.bullet ? {
      id: p.bullet.listId, start: p.bullet.startNumber, kind: listKind(snapshot, p.bullet), level: Math.max(0, Math.min(8, p.bullet.nestingLevel ?? 0)),
      checked: String(p.bullet.listType || '').toUpperCase() === 'CHECK_LIST_CHECKED',
    } : undefined;
    const ps = options.editor && p ? esc(JSON.stringify({ ...(p.paragraphStyle || {}), __id: p.paragraphId, __list: p.bullet?.listId })) : undefined;
    sink().push({ kind: 'para', tag: bullet ? 'p' : tag, align, html: inline, bullet, ps });
    inline = '';
  };

  for (let i = 0; i < stream.length; i += 1) {
    const ch = stream[i];
    switch (ch) {
      case '\r': endParagraph(i); continue;
      case '\n': case '\0': flushText(); continue;
      case '\x1F': case '\x1E': case '\x10': case '\x11': case '\x12': case '\x13': case '\x14': case '\x15': flushText(); continue;
      case '\f': flushText(); if (inline) endParagraph(-1); sink().push({ kind: 'raw', html: '<hr data-page-break="true">' }); continue;
      case '\b': {
        flushText();
        const id = blockAt.get(i);
        const drawing = id ? snapshot.drawings?.[id] : undefined;
        const src = typeof drawing?.source === 'string' ? imageOf(drawing.source) : null;
        if (src) {
          const w = drawing?.transform?.width;
          const h = drawing?.transform?.height;
          inline += `<img src="${esc(src)}" alt="${esc(String(drawing?.description || drawing?.title || ''))}"${w ? ` width="${Math.round(w)}"` : ''}${h ? ` height="${Math.round(h)}"` : ''}${options.editor ? ` data-block-id="${esc(id!)}"` : ''}>`;
        }
        continue;
      }
      case '\x1A': flushText(); tables.push({ rows: [], cell: null }); continue;
      case '\x1B': tables[tables.length - 1]?.rows.push([]); continue;
      case '\x1C': { const t = tables[tables.length - 1]; if (t) t.cell = []; continue; }
      case '\x1D': {
        const t = tables[tables.length - 1];
        if (t?.cell) { flushText(); if (inline) endParagraph(-1); t.rows[t.rows.length - 1]?.push(renderBlocks(t.cell)); t.cell = null; }
        continue;
      }
      case '\x0E': continue;
      case '\x0F': {
        const t = tables.pop();
        if (t) {
          const html = `<table><tbody>${t.rows.map((r) => `<tr>${r.map((c) => `<td>${c || '<p></p>'}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
          sink().push({ kind: 'raw', html });
        }
        continue;
      }
      default: {
        const ts = styleAt(i);
        const link = linkAt(i)?.properties?.url;
        const url = link ? safeUrl(link) || undefined : undefined;
        if (ts !== pendingTs || url !== pendingLink) { flushText(); pendingTs = ts; pendingLink = url; }
        pending += ch;
      }
    }
  }
  flushText();
  if (inline) endParagraph(-1);
  return renderBlocks(out);
}

/** Абзацы → HTML, подряд идущие пункты списка — в ul/ol с вложенностью по nestingLevel. */
function renderBlocks(items: Array<{ kind: 'para'; tag: string; align: string; html: string; ps?: string; bullet?: { kind: 'ul' | 'ol' | 'task'; level: number; id?: string; start?: number; checked?: boolean } } | { kind: 'raw'; html: string }>): string {
  let html = '';
  const open: Array<{ kind: 'ul' | 'ol' | 'task'; level: number; id?: string }> = [];
  const closeTo = (level: number) => {
    while (open.length && open[open.length - 1].level > level) html += `</li></${tagOf(open.pop()!.kind)}>`;
  };
  const tagOf = (k: 'ul' | 'ol' | 'task') => (k === 'ol' ? 'ol' : 'ul');
  const openTag = (k: 'ul' | 'ol' | 'task') => (k === 'task' ? '<ul data-type="taskList">' : `<${tagOf(k)}>`);
  const liTag = (k: 'ul' | 'ol' | 'task', checked?: boolean) => (k === 'task' ? `<li data-type="taskItem" data-checked="${checked ? 'true' : 'false'}">` : '<li>');
  const attrs = (item: { align: string; ps?: string }) => `${item.align ? ` style="text-align:${item.align}"` : ''}${item.ps ? ` data-ps="${item.ps}"` : ''}`;
  for (const item of items) {
    if (item.kind === 'para' && item.bullet) {
      const { kind, level, id, start } = item.bullet;
      closeTo(level);
      const top = open[open.length - 1];
      if (top && top.level === level && (top.kind !== kind || top.id !== id)) { html += `</li></${tagOf(open.pop()!.kind)}>`; }
      const cur = open[open.length - 1];
      if (!cur || cur.level < level) {
        html += kind === 'ol' && Number.isInteger(start) ? `<ol start="${start}">` : openTag(kind);
        open.push({ kind, level, id });
      } else {
        html += '</li>';
      }
      html += `${liTag(kind, item.bullet.checked)}<p${attrs(item)}>${item.html}</p>`;
      continue;
    }
    closeTo(-1);
    if (item.kind === 'raw') { html += item.html; continue; }
    html += `<${item.tag}${attrs(item)}>${item.html}</${item.tag}>`;
  }
  closeTo(-1);
  return html;
}

/** Обычный текст документа: абзацы — строками, таблица — ячейки через табуляцию, без служебных символов. */
export function univerToText(snapshot: Snapshot): string {
  const stream = String(snapshot.body?.dataStream || '');
  let out = '';
  for (const ch of stream) {
    if (ch === '\r' || ch === '\x0E' || ch === '\f') out += '\n';
    else if (ch === '\x1D') out += '\t';
    else if (ch === '\t' || ch >= ' ') out += ch;
  }
  return out.replace(/\t\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
