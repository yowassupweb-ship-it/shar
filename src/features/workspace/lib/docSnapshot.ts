/**
 * Снимок документа (формат Univer Docs) без Univer: из Markdown получается готовый снимок с листами A4,
 * из снимка — Markdown и чистый текст (экспорт, печать).
 *
 * Поток данных в снимке: абзацы разделены «\r», в конце «\r\n». textRuns размечают участки (st..ed)
 * стилем ts: bl — жирный, it — курсив, fs — кегль. Размеры заголовков и отступы подобраны под A4 при 96 dpi.
 */

export const PAGE = { width: 794, height: 1124, margin: 72 };
const HEADING_SIZE: Record<number, number> = { 1: 28, 2: 22, 3: 18 };

const rid = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 11)}${Date.now().toString(36)}`;

interface Run { start: number; end: number; bold: boolean; italic: boolean; code: boolean; link?: string }
interface Para { text: string; runs: Run[]; heading?: number; list?: boolean; blank?: boolean; image?: { url: string; w: number; h: number } }

/** Ширина текста на странице: картинка шире неё уменьшается пропорционально. */
const CONTENT_WIDTH = PAGE.width - 2 * PAGE.margin;
/** Числа из перечислений Univer (импортировать их нельзя — снимок собирается и в основном бандле, без Univer). */
const HYPERLINK = 0; // CustomRangeType.HYPERLINK
const INLINE = 0; // PositionedObjectLayoutType.INLINE
const DRAWING_IMAGE = 0; // DrawingTypeEnum.DRAWING_IMAGE

/** Строка-картинка: ![подпись](адрес) — адрес может нести размер «#ШxВ» (его ставит импорт Word). */
function parseImage(line: string): Para['image'] | null {
  const match = line.trim().match(/^!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/);
  if (!match) return null;
  const [url, size] = match[1].split('#');
  const [w0, h0] = (size?.match(/^(\d+)x(\d+)$/)?.slice(1) ?? ['320', '240']).map(Number);
  const scale = Math.min(1, CONTENT_WIDTH / (w0 || 1));
  return { url, w: Math.round(w0 * scale), h: Math.round(h0 * scale) };
}

export interface TextRun { st: number; ed: number; ts: { bl?: number; it?: number; fs?: number; ff?: string } }
export interface DocSnapshot {
  id: string;
  title?: string;
  body: {
    dataStream: string;
    textRuns?: TextRun[];
    paragraphs?: Array<{ startIndex: number; paragraphId?: string; paragraphStyle?: Record<string, unknown> }>;
    sectionBreaks?: Array<{ sectionId: string; startIndex: number }>;
    [key: string]: unknown;
  };
  documentStyle?: Record<string, unknown>;
  [key: string]: unknown;
}

export function emptySnapshot(title = ''): DocSnapshot {
  return {
    id: rid('doc'),
    locale: 'ruRU',
    title,
    tableSource: {},
    drawings: {},
    drawingsOrder: [],
    headers: {},
    footers: {},
    notes: {},
    noteSettings: {},
    body: {
      dataStream: '\r\n',
      textRuns: [],
      customBlocks: [],
      tables: [],
      columnGroups: [],
      blockRanges: [],
      customRanges: [],
      customDecorations: [],
      paragraphs: [{ startIndex: 0, paragraphId: rid('para'), paragraphStyle: { lineSpacing: 1.15 } }],
      sectionBreaks: [{ sectionId: rid('section'), startIndex: 1 }],
    },
    documentStyle: {
      pageSize: { width: PAGE.width, height: PAGE.height },
      documentFlavor: 1,
      marginTop: PAGE.margin,
      marginBottom: PAGE.margin,
      marginRight: PAGE.margin,
      marginLeft: PAGE.margin,
      autoHyphenation: 1,
      doNotHyphenateCaps: 0,
      consecutiveHyphenLimit: 2,
      defaultHeaderId: '',
      defaultFooterId: '',
      evenPageHeaderId: '',
      evenPageFooterId: '',
      firstPageHeaderId: '',
      firstPageFooterId: '',
      evenAndOddHeaders: 0,
      useFirstPageHeaderFooter: 0,
      marginHeader: 30,
      marginFooter: 30,
    },
    settings: {},
  };
}

/** Inline-разметка: **жирный**, *курсив*, `код`, [ссылка](адрес) → чистый текст и участки со стилем. */
function parseInline(source: string): { text: string; runs: Run[] } {
  let text = '';
  const runs: Run[] = [];
  // \X — экранированный символ, остаётся текстом (импорт экранирует «3*», «KZN_03» и т. п.).
  const pattern = /\\([\\`*_[\]|#>+\-.)!])|\[((?:\\.|[^\]\n\\])+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\*\*((?:\\.|[^*\\])+)\*\*|__((?:\\.|[^_\\])+)__|\*((?:\\.|[^*\n\\])+)\*|_((?:\\.|[^_\n\\])+)_|`([^`\n]+)`/g;
  let last = 0;
  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0;
    text += source.slice(last, index);
    last = index + match[0].length;
    if (match[1] !== undefined) { text += match[1]; continue; }
    if (match[2] !== undefined) {
      // Внутри текста ссылки разметку тоже понимаем: [**жирная ссылка**](…).
      const inner = parseInline(match[2]);
      const start = text.length;
      text += inner.text;
      runs.push(...inner.runs.map((run) => ({ ...run, start: run.start + start, end: run.end + start })));
      runs.push({ start, end: text.length, bold: false, italic: false, code: false, link: match[3] });
      continue;
    }
    const code = match[8];
    if (code !== undefined) {
      const start = text.length;
      text += code;
      runs.push({ start, end: text.length, bold: false, italic: false, code: true });
      continue;
    }
    // Жирный и курсив вкладываются друг в друга (_**жирный курсив**_): внутренность разбираем так же.
    const bold = match[4] ?? match[5];
    const inner = parseInline((bold ?? match[6] ?? match[7]) as string);
    const start = text.length;
    text += inner.text;
    runs.push(...inner.runs.map((run) => ({ ...run, start: run.start + start, end: run.end + start })));
    runs.push({ start, end: text.length, bold: bold !== undefined, italic: bold === undefined, code: false });
  }
  return { text: text + source.slice(last), runs };
}

const shift = (runs: Run[], by: number): Run[] => runs.map((run) => ({ ...run, start: run.start + by, end: run.end + by }));

/** Строки Markdown → абзацы. Таблицы Markdown превращаются в строки через « | ». */
export function parseMarkdown(markdown: string): Para[] {
  const paragraphs: Para[] = [];
  for (const raw of String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { paragraphs.push({ text: '', runs: [], blank: true }); continue; }
    if (/^\s*\|?[\s:-]+\|[\s|:-]*$/.test(line)) continue;
    const image = parseImage(line);
    if (image) { paragraphs.push({ text: '\b', runs: [], image }); continue; }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) { paragraphs.push({ ...parseInline(heading[2]), heading: heading[1].length }); continue; }
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) { const inline = parseInline(bullet[2]); paragraphs.push({ text: `• ${inline.text}`, runs: shift(inline.runs, 2), list: true }); continue; }
    const numbered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (numbered) {
      const inline = parseInline(numbered[3]);
      const label = `${numbered[2]}. `;
      paragraphs.push({ text: label + inline.text, runs: shift(inline.runs, label.length), list: true });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.trim());
      paragraphs.push(parseInline(cells.join('  |  ')));
      continue;
    }
    paragraphs.push(parseInline(line.trim()));
  }
  // Подряд идущие пустые строки схлопываем: между абзацами достаточно одного интервала.
  return paragraphs.filter((item, index, all) => !(item.blank && (index === 0 || all[index - 1].blank)));
}

function buildBody(markdown: string) {
  const paragraphs = parseMarkdown(markdown);
  if (!paragraphs.length || paragraphs.every((item) => item.blank)) paragraphs.splice(0, paragraphs.length, { text: '', runs: [] });
  let stream = '';
  const paragraphList: NonNullable<DocSnapshot['body']['paragraphs']> = [];
  const textRuns: TextRun[] = [];
  const customRanges: Array<Record<string, unknown>> = [];
  const customBlocks: Array<{ startIndex: number; blockId: string }> = [];
  const drawings: Record<string, Record<string, unknown>> = {};
  for (const item of paragraphs) {
    const offset = stream.length;
    stream += item.text;
    if (item.image) {
      // Строчная картинка: символ «\b» в потоке + блок + описание рисунка (та же форма, что сохраняет сам Univer).
      const id = rid('img');
      const { url, w, h } = item.image;
      customBlocks.push({ startIndex: offset, blockId: id });
      drawings[id] = {
        drawingId: id, title: '', description: '', imageSourceType: 'URL', source: url,
        transform: { width: w, height: h, left: 0 },
        docTransform: { size: { width: w, height: h }, positionH: { relativeFrom: 0, posOffset: 0 }, positionV: { relativeFrom: 1, posOffset: 0 }, angle: 0 },
        layoutType: INLINE, drawingType: DRAWING_IMAGE,
      };
    }
    if (item.heading) textRuns.push({ st: offset, ed: offset + item.text.length, ts: { bl: 1, fs: HEADING_SIZE[item.heading] } });
    for (const run of item.runs) {
      if (run.link) {
        if (run.end > run.start) customRanges.push({ startIndex: offset + run.start, endIndex: offset + run.end - 1, rangeId: rid('link'), rangeType: HYPERLINK, properties: { url: run.link } });
        continue;
      }
      const ts: TextRun['ts'] = {};
      if (run.bold) ts.bl = 1;
      if (run.italic) ts.it = 1;
      if (run.code) ts.ff = 'Courier New';
      if (Object.keys(ts).length && run.end > run.start) textRuns.push({ st: offset + run.start, ed: offset + run.end, ts });
    }
    const paragraphStyle: Record<string, unknown> = { lineSpacing: 1.15 };
    if (item.heading) paragraphStyle.spaceAbove = { v: item.heading === 1 ? 18 : 12 };
    paragraphList.push({ startIndex: stream.length, paragraphId: rid('para'), paragraphStyle });
    stream += '\r';
  }
  return { stream, paragraphList, textRuns, customRanges, customBlocks, drawings };
}

export function markdownToSnapshot(title: string, markdown: string): DocSnapshot {
  const snapshot = emptySnapshot(title);
  const { stream, paragraphList, textRuns, customRanges, customBlocks, drawings } = buildBody(markdown);
  snapshot.body.dataStream = `${stream}\n`;
  snapshot.body.paragraphs = paragraphList;
  snapshot.body.textRuns = textRuns;
  if (customRanges.length) snapshot.body.customRanges = customRanges;
  if (customBlocks.length) {
    snapshot.body.customBlocks = customBlocks;
    for (const drawing of Object.values(drawings)) Object.assign(drawing, { unitId: snapshot.id, subUnitId: snapshot.id });
    snapshot.drawings = drawings;
    snapshot.drawingsOrder = Object.keys(drawings);
    ensureDrawingResource(snapshot);
  }
  snapshot.body.sectionBreaks = [{ sectionId: rid('section'), startIndex: stream.length }];
  return snapshot;
}

function paragraphsOf(snapshot: DocSnapshot) {
  const stream = String(snapshot.body?.dataStream || '');
  const starts = (snapshot.body?.paragraphs || []).map((item) => item.startIndex).sort((a, b) => a - b);
  const result: Array<{ from: number; to: number; text: string }> = [];
  let from = 0;
  for (const end of starts) {
    result.push({ from, to: end, text: stream.slice(from, end) });
    from = end + 1;
  }
  return result;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

/** Markdown со структурой, которую понимает редактор: заголовки по кеглю, жирный, курсив. */
export function snapshotToMarkdown(snapshot: DocSnapshot, { images = false }: { images?: boolean } = {}): string {
  const runs = snapshot.body?.textRuns || [];
  // Картинки (управляющий символ BS в тексте + блок + рисунок) — строкой ![](адрес); только там, где Markdown дальше рисуется (печать, HTML).
  const blocks = images ? (snapshot.body?.customBlocks as Array<{ startIndex: number; blockId: string }> | undefined) || [] : [];
  const drawings = (snapshot.drawings || {}) as Record<string, { source?: unknown }>;
  const lines = paragraphsOf(snapshot).map((item) => {
    const inside = runs.filter((run) => run.ed > item.from && run.st < item.to);
    const size = inside.reduce((max, run) => Math.max(max, Number(run.ts?.fs) || 0), 0);
    const heading = size >= HEADING_SIZE[1] ? 1 : size >= HEADING_SIZE[2] ? 2 : size >= HEADING_SIZE[3] ? 3 : 0;
    const cuts = [...new Set([item.from, item.to, ...inside.flatMap((run) => [Math.max(run.st, item.from), Math.min(run.ed, item.to)])])].sort((a, b) => a - b);
    let out = '';
    for (let index = 0; index < cuts.length - 1; index += 1) {
      const from = cuts[index];
      const to = cuts[index + 1];
      let piece = item.text.slice(from - item.from, to - item.from);
      if (!piece) continue;
      const covering = inside.filter((run) => run.st <= from && run.ed >= to);
      if (!heading && piece.trim()) {
        if (covering.some((run) => run.ts?.bl)) piece = `**${piece}**`;
        if (covering.some((run) => run.ts?.it)) piece = `*${piece}*`;
      }
      out += piece;
    }
    out = out.replace(CONTROL, '');
    const pictures = blocks
      .filter((block) => block.startIndex >= item.from && block.startIndex < item.to)
      .map((block) => drawings[block.blockId]?.source)
      .filter((source): source is string => typeof source === 'string' && Boolean(source))
      .map((source) => `![](${source})`);
    if (pictures.length) out = [out.trim(), ...pictures].filter(Boolean).join('\n\n');
    return heading && out.trim() ? `${'#'.repeat(heading)} ${out}` : out;
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Снимок собран как положено: размер страницы, разрыв раздела и единственный «\n» — в самом конце потока. */
function isWellFormed(value: DocSnapshot): boolean {
  const stream = value.body.dataStream;
  const page = value.documentStyle?.pageSize as { width?: number; height?: number } | undefined;
  return Boolean(page?.width && page?.height) && Boolean(value.body.sectionBreaks?.length) && stream.indexOf('\n') === stream.length - 1;
}

/**
 * Документ, записанный не нашим редактором (интеграция, API, старая версия), может прийти «голым»: без размера
 * страницы, без разрыва раздела, с «\r\n» между абзацами. Univer такой снимок не раскладывает — страница уезжает,
 * текст пропадает из виду. Достраиваем снимок: сохраняем текст и абзацы, форматирование заменяем стандартным.
 */
function repairSnapshot(value: DocSnapshot): DocSnapshot {
  const lines = String(value.body.dataStream).replace(/\r\n|\r|\n/g, '\n').replace(/\n+$/, '').split('\n');
  const repaired = emptySnapshot(value.title || '');
  if (value.id) repaired.id = value.id;
  const stream = lines.join('\r');
  repaired.body.dataStream = `${stream}\r\n`;
  let at = 0;
  repaired.body.paragraphs = lines.map((line) => {
    const paragraph = { startIndex: at + line.length, paragraphId: rid('para'), paragraphStyle: { lineSpacing: 1.15 } };
    at += line.length + 1;
    return paragraph;
  });
  repaired.body.sectionBreaks = [{ sectionId: rid('section'), startIndex: stream.length + 1 }];
  return repaired;
}

export function parseSnapshot(content: string): DocSnapshot | null {
  try {
    const value = JSON.parse(content) as DocSnapshot;
    if (!value || typeof value !== 'object' || typeof value.body?.dataStream !== 'string') return null;
    return isWellFormed(value) ? value : repairSnapshot(value);
  } catch {
    return null;
  }
}

/**
 * Картинки, загруженные в Шар, храним относительной ссылкой (/api/uploads/…). Вставка из буфера обмена проходит
 * через HTML и получает адрес вместе с хостом — у Electron это 127.0.0.1:<порт>, который у коллег не откроется.
 */
export function localizeImages(snapshot: DocSnapshot): DocSnapshot {
  const localize = (drawings: Record<string, { source?: unknown }> | undefined) => {
    for (const drawing of Object.values(drawings || {})) {
      if (typeof drawing?.source !== 'string') continue;
      const match = drawing.source.match(/^https?:\/\/[^/]+(\/api\/uploads\/[^?#]+)/i);
      if (match) drawing.source = match[1];
    }
  };
  localize(snapshot.drawings as Record<string, { source?: unknown }> | undefined);
  // Univer читает картинки из ресурса плагина, а не из drawings, — там ссылки правим тоже.
  const resource = resourcesOf(snapshot).find((item) => item.name === DRAWING_RESOURCE);
  if (resource?.data) {
    try {
      const value = JSON.parse(resource.data) as { data?: Record<string, { source?: unknown }> };
      localize(value.data);
      resource.data = JSON.stringify(value);
    } catch { /* ресурс не наш — оставляем как есть */ }
  }
  return snapshot;
}

const DRAWING_RESOURCE = 'DOC_DRAWING_PLUGIN';
type Resource = { name: string; data: string };
const resourcesOf = (snapshot: DocSnapshot) => (Array.isArray(snapshot.resources) ? snapshot.resources as Resource[] : []);

/**
 * Картинки документа Univer поднимает из ресурса плагина рисунков; без него drawings молча игнорируются.
 * Снимок, собранный не редактором (импорт Word и Markdown, API), ресурса не имеет — достраиваем его из drawings.
 */
export function ensureDrawingResource(snapshot: DocSnapshot): DocSnapshot {
  const drawings = snapshot.drawings as Record<string, unknown> | undefined;
  if (!drawings || !Object.keys(drawings).length) return snapshot;
  const resources = resourcesOf(snapshot);
  if (resources.some((item) => item.name === DRAWING_RESOURCE && item.data)) return snapshot;
  const order = Array.isArray(snapshot.drawingsOrder) ? snapshot.drawingsOrder : Object.keys(drawings);
  snapshot.resources = [...resources.filter((item) => item.name !== DRAWING_RESOURCE), { name: DRAWING_RESOURCE, data: JSON.stringify({ data: drawings, order }) }];
  return snapshot;
}

/** Отпечаток содержимого: текст, разметка, картинки и поля страницы. Служебные поля Univer (id абзацев) в него не входят.
 *  Картинки (drawings) — отдельно от текста: их перенос и смена размера текста не меняют, но сохраняться должны. */
export function fingerprint(snapshot: DocSnapshot | null): string {
  if (!snapshot) return '';
  const body = snapshot.body;
  return JSON.stringify([body.dataStream, body.textRuns, body.paragraphs?.map((item) => [item.startIndex, item.paragraphStyle]), body.tables, body.customBlocks, snapshot.drawings, snapshot.drawingsOrder, snapshot.documentStyle]);
}
