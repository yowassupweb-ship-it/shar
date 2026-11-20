/**
 * Колонтитулы документа в формате Univer (snapshot.headers / snapshot.footers): чтение в простой текст с метками
 * полей и запись обратно. Номер страницы и число страниц — поля Univer (customRange FIELD, «PAGE» / «NUMPAGES»):
 * в тексте — служебные символы начала и конца диапазона вокруг закэшированного значения. Так прежний редактор и
 * экспорт видят те же поля.
 *
 * В редакторе поле показывается меткой: {стр} — номер страницы, {всего} — число страниц.
 */

export type SegKind = 'headers' | 'footers';
export const PAGE_TOKEN = '{стр}';
export const PAGES_TOKEN = '{всего}';

const START = '\u001f';
const END = '\u001e';

interface FieldRange { startIndex: number; endIndex: number; rangeType?: number; properties?: { fieldType?: string } }
interface Segment { headerId?: string; footerId?: string; body?: { dataStream?: string; customRanges?: FieldRange[]; textRuns?: unknown[] } }

/** Текст колонтитула с метками полей; переносы абзацев — \n. */
export function readSegment(snapshot: Record<string, unknown>, kind: SegKind, id?: string): string {
  if (!id) return '';
  const seg = (snapshot[kind] as Record<string, Segment> | undefined)?.[id];
  const body = seg?.body;
  const stream = String(body?.dataStream || '');
  const fields = (body?.customRanges || []).filter((r) => r.rangeType === 1 && r.properties?.fieldType);
  let out = '';
  for (let i = 0; i < stream.length; i += 1) {
    const field = fields.find((f) => f.startIndex === i);
    if (field) {
      out += field.properties!.fieldType === 'NUMPAGES' ? PAGES_TOKEN : field.properties!.fieldType === 'PAGE' ? PAGE_TOKEN : '';
      i = field.endIndex;
      continue;
    }
    const ch = stream[i];
    if (ch === '\r') out += '\n';
    else if (ch === START || ch === END || ch === '\n') continue;
    // eslint-disable-next-line no-control-regex
    else if (!/[\x00-\x08\x0b-\x1f]/.test(ch)) out += ch;
  }
  return out.replace(/\n+$/, '');
}

/** Есть ли у колонтитула оформление (жирный, цвет…), которое простая правка текста потеряет. */
export function segmentStyled(snapshot: Record<string, unknown>, kind: SegKind, id?: string): boolean {
  if (!id) return false;
  const runs = (snapshot[kind] as Record<string, Segment> | undefined)?.[id]?.body?.textRuns;
  return Array.isArray(runs) && runs.length > 0;
}

const rid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}`;

/** Собрать колонтитул Univer из текста с метками. pages — для закэшированного значения полей. */
export function buildSegment(kind: SegKind, id: string, text: string, pages: number): Segment {
  let stream = '';
  const customRanges: Array<Record<string, unknown>> = [];
  const paragraphs: Array<Record<string, unknown>> = [];
  const lines = text.replace(/\r/g, '').split('\n');
  lines.forEach((line, n) => {
    const parts = line.split(/(\{стр\}|\{всего\})/);
    for (const part of parts) {
      if (part === PAGE_TOKEN || part === PAGES_TOKEN) {
        const type = part === PAGE_TOKEN ? 'PAGE' : 'NUMPAGES';
        const cached = type === 'PAGE' ? '1' : String(pages);
        const start = stream.length;
        stream += `${START}${cached}${END}`;
        customRanges.push({
          startIndex: start, endIndex: stream.length - 1, rangeId: rid('field'), rangeType: 1, wholeEntity: false,
          properties: { fieldType: type, instruction: type, cachedResult: cached, sourceKind: 'complex' },
        });
      } else {
        // eslint-disable-next-line no-control-regex
        stream += part.replace(/[\x00-\x1f]/g, ' ');
      }
    }
    paragraphs.push({ startIndex: stream.length, paragraphId: rid('para'), paragraphStyle: {} });
    stream += '\r';
    void n;
  });
  stream += '\n';
  return {
    [kind === 'headers' ? 'headerId' : 'footerId']: id,
    body: { dataStream: stream, textRuns: [], customRanges, paragraphs, sectionBreaks: [{ startIndex: stream.length - 1 }] } as never,
  } as Segment;
}

export const newSegmentId = (kind: SegKind) => rid(kind === 'headers' ? 'header' : 'footer');

/** Показ на листе: метки — номером этой страницы и числом страниц. */
export const fillFields = (text: string, page: number, pages: number) => text.split(PAGE_TOKEN).join(String(page)).split(PAGES_TOKEN).join(String(pages));
