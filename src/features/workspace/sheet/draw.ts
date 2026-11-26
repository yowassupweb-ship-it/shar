import type { CfLookup } from './cf';
import { chartData, drawChart } from './chart';
import type { Banding, DvRule, Group, SheetObject } from './extras';
import { a1, autoAlign, colName, displayText, HEAD_H, HEAD_W, indexAt, styleOf, type Book, type Range, type Sheet, type Style } from './model';

/**
 * Отрисовка листа на холсте (как у Google Таблиц): холст размером с окно прилипает к краю области прокрутки, а на
 * каждый кадр прокрутки рисуются только видимые ячейки. Никакой перестройки элементов страницы — прокрутка ровная
 * на любых размерах таблицы.
 *
 * Координаты: столбец c на экране — HEAD_W + colOffs[c] − (c ≥ закреплённых ? scrollX : 0); строки так же.
 */

export interface Geo {
  rows: number; cols: number; rowOffs: Float64Array; colOffs: Float64Array;
  fr: number; fc: number; fh: number; fw: number; merges: Map<string, Range>;
}
export interface Theme {
  bg: string; text: string; link: string; grid: string; head: string; headText: string; headOn: string; headHover: string; headFull: string; sel: string; selFill: string; borderAuto: string; frozenLine: string; dark: boolean;
}
export interface Peer { name: string; color: string; range: Range }
export interface DrawState {
  book: Book; sheet: Sheet; geo: Geo; theme: Theme;
  scrollX: number; scrollY: number; width: number; height: number; dpr: number;
  sel: Range; active: Range; clip: Range | null; peers: Peer[]; marks: Set<string>;
  filter: Range | null; filtered: Set<number>; hideActive?: boolean;
  /** Куда переносится выделение при перетаскивании за рамку. */
  ghost?: Range | null;
  /** Заголовок под курсором или ручка ширины/высоты — подсветить. */
  headHover?: { kind: 'col' | 'row' | 'resize-col' | 'resize-row'; index: number } | null;
  /** Ячейки «r:c», где адрес в тексте — не ссылка. */
  noLinks?: Record<string, 1>;
  /** Куда встанут перетаскиваемые строки (столбцы) — линия перед индексом at. */
  dropAt?: { axis: 'row' | 'col'; at: number } | null;
  /** Столбцы фильтра с заданным условием — их кнопка залита. */
  filterOn?: Set<number>;
  /** Ссылки правимой формулы — цветные рамки на листе (как в Google Таблицах). */
  refs?: Array<{ range: Range; color: string }>;
  /** Условное форматирование листа (sheet/cf.ts). */
  cf?: CfLookup | null;
  /** Диапазоны правил «ячейка пуста» — их пустые ячейки тоже красятся. */
  cfBlank?: Range[];
  /** Флажки и списки, заметки, объекты (картинки, диаграммы), группы строк/столбцов. */
  dv?: DvRule[]; notes?: Record<string, string>; objects?: SheetObject[]; selectedObject?: string | null;
  groups?: { rows?: Group[]; cols?: Group[] };
  /** Чередование цветов строк (как в Google). */
  banding?: Banding[];
  /** Масштаб (1 = 100%): ширина, высота и прокрутка приходят уже в единицах листа. */
  zoom?: number;
  /** Картинка догрузилась — перерисовать. */
  onAsset?: () => void;
}

const BORDER_W: Record<number, number> = { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 3, 8: 2, 9: 2, 10: 2, 11: 2, 12: 2, 13: 3 };
const DASH: Record<number, number[]> = { 2: [1, 1], 3: [1, 2], 4: [3, 2], 9: [4, 2] };

const lightness = (hex: string) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};

export function readTheme(el: Element): Theme {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const bg = v('--sh-bg', '#fff');
  return {
    bg, text: v('--sh-text', '#1f1f1f'), link: (lightness(bg) ?? 1) < 0.4 ? '#8ab4f8' : '#1155cc', grid: v('--sh-grid', '#e2e3e3'), head: v('--sh-head', '#f8f9fa'), headText: v('--sh-head-text', '#5f6368'),
    headOn: v('--sh-head-on', '#d3e3fd'), headHover: v('--sh-head-hover', '#e8eaed'), headFull: v('--sh-head-full', '#0b57d0'), sel: v('--sh-sel', '#1a73e8'), selFill: v('--sh-sel-fill', 'rgba(26,115,232,.1)'),
    borderAuto: v('--sh-border-auto', '#000'), frozenLine: v('--sh-head-text', '#5f6368'), dark: (lightness(bg) ?? 1) < 0.4,
  };
}

/** Экранная x начала столбца c (и аналогично строки). */
export const screenX = (g: Geo, c: number, scrollX: number) => HEAD_W + g.colOffs[c] - (c >= g.fc ? scrollX : 0);
export const screenY = (g: Geo, r: number, scrollY: number) => HEAD_H + g.rowOffs[r] - (r >= g.fr ? scrollY : 0);
/**
 * Правый край столбца и нижний край строки. Нельзя брать «левый край следующего»: у последней закреплённой строки
 * следующая уже прокручивается, и высота ячейки уходит в минус — закреплённая строка пропадала при прокрутке.
 */
export const screenX2 = (g: Geo, c: number, scrollX: number) => HEAD_W + g.colOffs[c + 1] - (c >= g.fc ? scrollX : 0);
export const screenY2 = (g: Geo, r: number, scrollY: number) => HEAD_H + g.rowOffs[r + 1] - (r >= g.fr ? scrollY : 0);

export function cellFont(style: Style | null): string {
  const size = typeof style?.fs === 'number' ? style.fs : 10;
  const family = typeof style?.ff === 'string' && style.ff ? `"${style.ff.replace(/"/g, '')}", Arial, sans-serif` : 'Arial, sans-serif';
  return `${style?.it ? 'italic ' : ''}${style?.bl ? '700 ' : ''}${size}pt ${family}`;
}

/** Адрес ссылки в ячейке: гиперссылка (своя или из Excel) или сам текст, если это адрес. */
export function linkOf(cell: { v?: unknown; p?: unknown } | undefined): string | null {
  const ranges = ((cell?.p as { body?: { customRanges?: Array<{ properties?: { url?: unknown } }> } } | undefined)?.body?.customRanges) || [];
  const url = ranges.find((r) => typeof r.properties?.url === 'string')?.properties?.url as string | undefined;
  if (url) return url;
  const text = typeof cell?.v === 'string' ? cell.v.trim() : '';
  return /^https?:\/\/\S+$/i.test(text) ? text : null;
}

/** Части текста с разным оформлением (богатый текст ячейки): [текст, оформление поверх стиля ячейки]. */
function richParts(cell: { p?: unknown } | undefined, text: string): Array<{ text: string; ts: Style }> | null {
  const body = (cell?.p as { body?: { textRuns?: Array<{ st: number; ed: number; ts?: Style }> } } | undefined)?.body;
  const runs = (body?.textRuns || []).filter((r) => r.ts && Object.keys(r.ts).length).sort((a, b) => a.st - b.st);
  if (!runs.length || text.includes('\n')) return null;
  const out: Array<{ text: string; ts: Style }> = [];
  let at = 0;
  for (const r of runs) {
    if (r.st > at) out.push({ text: text.slice(at, r.st), ts: {} as Style });
    if (r.ed > r.st) out.push({ text: text.slice(Math.max(r.st, at), r.ed), ts: r.ts as Style });
    at = Math.max(at, r.ed);
  }
  if (at < text.length) out.push({ text: text.slice(at), ts: {} as Style });
  return out.filter((x) => x.text);
}

const dvAt = (rules: DvRule[] | undefined, r: number, c: number) => {
  if (!rules) return null;
  for (const rule of rules) for (const x of rule.ranges) if (r >= x.startRow && r <= x.endRow && c >= x.startColumn && c <= x.endColumn) return rule;
  return null;
};
export const isChecked = (v: unknown) => v === true || v === 1 || (typeof v === 'string' && ['TRUE', 'ИСТИНА', '1'].includes(v.toUpperCase()));

const images = new Map<string, HTMLImageElement>();
function imageOf(src: string, onLoad?: () => void): HTMLImageElement | null {
  let img = images.get(src);
  if (!img) {
    img = new Image();
    img.decoding = 'async';
    img.onload = () => onLoad?.();
    img.src = src;
    images.set(src, img);
  }
  return img.complete && img.naturalWidth ? img : null;
}

/**
 * Прямоугольник по пикселям экрана: при дробном масштабе (например, 125% Windows × масштаб окна) линии в 1 px и края
 * заливок иначе ложатся между пикселями и мылятся. Сетка — ровно 1 пиксель экрана, как у Google Таблиц.
 */
function snapRect(ctx: CanvasRenderingContext2D, k: number, x: number, y: number, w: number, h: number) {
  const x0 = Math.round(x * k); const y0 = Math.round(y * k);
  const x1 = Math.round((x + w) * k); const y1 = Math.round((y + h) * k);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
  ctx.restore();
}

/** Перенос строк по словам под ширину. */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const next = line + word;
      if (line && ctx.measureText(next).width > width) { out.push(line.trimEnd()); line = word.trimStart(); } else line = next;
    }
    out.push(line);
  }
  return out;
}

/** Нарисовать область листа: строки r0..r1, столбцы c0..c1, обрезанную прямоугольником clip. */
function drawRegion(ctx: CanvasRenderingContext2D, s: DrawState, r0: number, r1: number, c0: number, c1: number, clip: [number, number, number, number]) {
  const { geo: g, sheet, book, theme } = s;
  const k = s.dpr * (s.zoom || 1);
  const fr = (x: number, y: number, w: number, h: number) => snapRect(ctx, k, x, y, w, h);
  if (r1 < r0 || c1 < c0 || clip[2] <= 0 || clip[3] <= 0) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(clip[0], clip[1], clip[2], clip[3]);
  ctx.clip();
  ctx.fillStyle = theme.bg;
  fr(clip[0], clip[1], clip[2], clip[3]);
  const X = (c: number) => screenX(g, c, s.scrollX);
  const Y = (r: number) => screenY(g, r, s.scrollY);
  const X2 = (c: number) => screenX2(g, c, s.scrollX);
  const Y2 = (r: number) => screenY2(g, r, s.scrollY);

  // Заливки (под сеткой нет — сетку заливка закрывает, как в Excel).
  const drawn: Array<{ r: number; c: number; x: number; y: number; w: number; h: number; cell: NonNullable<Sheet['cellData'][number][number]>; style: Style | null }> = [];
  const seenMerge = new Set<Range>();
  const seenCell = new Set<string>();
  const visit = (r: number, c: number, force = false) => {
    if (seenCell.has(`${r}:${c}`)) return;
    seenCell.add(`${r}:${c}`);
    let rr = r; let cc = c; let r2 = r; let c2 = c;
    const m = g.merges.get(`${r}:${c}`);
    if (m) { if (seenMerge.has(m)) return; seenMerge.add(m); rr = m.startRow; cc = m.startColumn; r2 = m.endRow; c2 = m.endColumn; }
    const cell = sheet.cellData?.[rr]?.[cc] ?? (force ? {} : undefined);
    if (!cell) return;
    const x = X(cc); const y = Y(rr);
    const w = X2(c2) - x; const h = Y2(r2) - y;
    if (w <= 0 || h <= 0) return;
    let style = styleOf(book, cell);
    // Условное форматирование — поверх своего оформления ячейки.
    const hit = s.cf?.(rr, cc, cell) ?? null;
    if (hit) {
      const add: Record<string, unknown> = {};
      const st0 = hit.style || {};
      const bgc = hit.fill || st0.bg;
      if (bgc) add.bg = { rgb: bgc };
      if (st0.cl) add.cl = { rgb: st0.cl };
      if (st0.bl) add.bl = 1;
      if (st0.it) add.it = 1;
      if (st0.ul) add.ul = { s: 1 };
      if (st0.st) add.st = { s: 1 };
      style = { ...(style || {}), ...add } as Style;
    }
    // Тёмная тема: явная белая заливка (так красят «без заливки» в Excel) — как фон листа, а не белое пятно.
    if (theme.dark) { const rgb = (style?.bg as { rgb?: string } | undefined)?.rgb; if (rgb && (lightness(rgb) ?? 0) >= 0.97) style = { ...style, bg: undefined } as Style; }
    drawn.push({ r: rr, c: cc, x, y, w, h, cell, style });
  };
  for (let r = r0; r <= r1; r += 1) {
    if (g.rowOffs[r + 1] === g.rowOffs[r]) continue;
    const row = sheet.cellData?.[r];
    if (row) for (const k of Object.keys(row)) { const c = Number(k); if (c >= c0 && c <= c1) visit(r, c); }
  }
  for (const m of sheet.mergeData || []) if (m.startRow <= r1 && r0 <= m.endRow && m.startColumn <= c1 && c0 <= m.endColumn) visit(m.startRow, m.startColumn);
  // Пустые ячейки, которые всё равно рисуются: флажки, заметки, правило «ячейка пуста».
  const forceRanges: Range[] = [...(s.dv || []).flatMap((x) => x.ranges)];
  let budget = 20000;
  const forceIn = (x: Range) => {
    for (let r = Math.max(r0, x.startRow); r <= Math.min(r1, x.endRow) && budget > 0; r += 1) {
      if (g.rowOffs[r + 1] === g.rowOffs[r]) continue;
      for (let c = Math.max(c0, x.startColumn); c <= Math.min(c1, x.endColumn) && budget > 0; c += 1) { budget -= 1; visit(r, c, true); }
    }
  };
  for (const x of forceRanges) forceIn(x);
  for (const x of s.cfBlank || []) forceIn(x);
  for (const key of Object.keys(s.notes || {})) { const [r, c] = key.split(':').map(Number); if (r >= r0 && r <= r1 && c >= c0 && c <= c1) visit(r, c, true); }
  // Объединённые — на фоне листа (поверх сетки внутри них).
  for (const m of seenMerge) {
    const x = X(m.startColumn); const y = Y(m.startRow);
    ctx.fillStyle = theme.bg;
    fr(x, y, X2(m.endColumn) - x, Y2(m.endRow) - y);
  }

  // Чередование цветов — под сеткой и под своей заливкой ячеек.
  for (const bd of s.banding || []) {
    const rr0 = Math.max(r0, bd.range.startRow); const rr1 = Math.min(r1, bd.range.endRow);
    const cc0 = Math.max(c0, bd.range.startColumn); const cc1 = Math.min(c1, bd.range.endColumn);
    if (rr1 < rr0 || cc1 < cc0) continue;
    const x0 = X(cc0); const x1 = X2(cc1);
    for (let r = rr0; r <= rr1; r += 1) {
      const rel = r - bd.range.startRow;
      const color = bd.header && rel === 0 ? bd.header : bd.footer && r === bd.range.endRow ? bd.footer : (rel - (bd.header ? 1 : 0)) % 2 === 0 ? bd.odd : bd.even;
      ctx.fillStyle = color;
      fr(x0, Y(r), x1 - x0, Y2(r) - Y(r));
    }
  }

  // Сетка (у листа её можно выключить — «Вид → Сетка», как в Google).
  if ((sheet as { showGridlines?: number }).showGridlines !== 0) {
    ctx.fillStyle = theme.grid;
    const top = Y(r0); const bottom = Y2(r1); const left = X(c0); const right = X2(c1);
    for (let r = r0; r <= r1 + 1; r += 1) { if (r <= r1 && g.rowOffs[r + 1] === g.rowOffs[r]) continue; fr(left, (r <= r1 ? Y(r) : bottom) - 1, right - left, 1); }
    for (let c = c0; c <= c1 + 1; c += 1) { if (c <= c1 && g.colOffs[c + 1] === g.colOffs[c]) continue; fr((c <= c1 ? X(c) : right) - 1, top, 1, bottom - top); }
  }
  for (const m of seenMerge) {
    const x = X(m.startColumn); const y = Y(m.startRow);
    ctx.fillStyle = theme.bg;
    fr(x, y, X2(m.endColumn) - x - 1, Y2(m.endRow) - y - 1);
  }
  for (const d of drawn) {
    const bg = (d.style?.bg as { rgb?: string } | undefined)?.rgb;
    if (bg) { ctx.fillStyle = bg; fr(d.x - 1, d.y - 1, d.w + 1, d.h + 1); }
  }

  // Текст.
  ctx.textBaseline = 'alphabetic';
  for (const d of drawn) {
    const rule = dvAt(s.dv, d.r, d.c);
    if (rule?.kind === 'checkbox') {
      // Флажок как в Google: квадрат по центру ячейки, отмеченный — залит цветом.
      const sz = 14; const bx = d.x + (d.w - sz) / 2; const by = d.y + (d.h - sz) / 2;
      const on = isChecked(d.cell.v);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = on ? theme.sel : theme.headText;
      ctx.fillStyle = on ? theme.sel : 'transparent';
      ctx.beginPath(); ctx.roundRect(bx, by, sz, sz, 2); if (on) ctx.fill(); ctx.stroke();
      if (on) { ctx.strokeStyle = theme.bg; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(bx + 3, by + 7); ctx.lineTo(bx + 6, by + 10); ctx.lineTo(bx + 11, by + 4); ctx.stroke(); }
      continue;
    }
    if (rule?.kind === 'list') {
      // Раскрывающийся список: стрелка справа; значение — «чипом», как в Google.
      const ax = d.x + d.w - 12; const ay = d.y + d.h / 2;
      ctx.fillStyle = theme.headText; ctx.beginPath(); ctx.moveTo(ax - 4, ay - 2); ctx.lineTo(ax + 4, ay - 2); ctx.lineTo(ax, ay + 3); ctx.closePath(); ctx.fill();
      const t = displayText(d.cell, d.style);
      if (t && rule.chips !== false) {
        ctx.font = cellFont(d.style);
        const tw = Math.min(ctx.measureText(t).width + 14, d.w - 22);
        ctx.fillStyle = theme.dark ? '#3c4043' : '#e8eaed';
        ctx.beginPath(); ctx.roundRect(d.x + 3, d.y + Math.max(2, (d.h - 18) / 2), tw, Math.min(18, d.h - 4), 9); ctx.fill();
        ctx.save(); ctx.beginPath(); ctx.rect(d.x + 3, d.y, tw - 4, d.h); ctx.clip();
        ctx.fillStyle = theme.text; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(t, d.x + 10, d.y + d.h / 2 + 1);
        ctx.restore(); ctx.textBaseline = 'alphabetic';
        continue;
      }
    }
    const text = displayText(d.cell, d.style);
    if (!text) continue;
    const st = d.style;
    const angle = Number((st?.tr as { a?: number } | undefined)?.a) || 0;
    if (angle && angle !== 255 && st?.tb !== 3) {
      // Повёрнутый текст: вокруг середины ячейки.
      ctx.save();
      ctx.beginPath(); ctx.rect(d.x, d.y, d.w, d.h); ctx.clip();
      ctx.font = cellFont(st);
      ctx.fillStyle = (st?.cl as { rgb?: string } | undefined)?.rgb || theme.text;
      ctx.translate(d.x + d.w / 2, d.y + d.h / 2);
      ctx.rotate((-angle * Math.PI) / 180);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, 0, 0);
      ctx.restore();
      continue;
    }
    ctx.font = cellFont(st);
    const bg = (st?.bg as { rgb?: string } | undefined)?.rgb;
    let color = (st?.cl as { rgb?: string } | undefined)?.rgb || '';
    const bgL = bg ? lightness(bg) : null;
    if (!color) color = bg && bgL !== null ? (bgL > 0.55 ? '#1f1f1f' : '#f1f1f1') : theme.text;
    else if (theme.dark && !bg) { const l = lightness(color); if (l !== null && l < 0.35) color = theme.text; }
    const link = s.noLinks?.[`${d.r}:${d.c}`] ? null : linkOf(d.cell);
    if (link && !(st?.cl as { rgb?: string } | undefined)?.rgb) color = theme.link;
    ctx.fillStyle = color;
    const h = ({ 1: 'left', 2: 'center', 3: 'right', 4: 'left' } as Record<number, 'left' | 'center' | 'right'>)[Number(st?.ht)] || autoAlign(d.cell);
    const v = ({ 1: 'top', 2: 'middle', 3: 'bottom' } as Record<number, string>)[Number(st?.vt)] || 'bottom';
    const size = (typeof st?.fs === 'number' ? st.fs : 10) * (96 / 72);
    const lineH = Math.round(size * 1.25);
    const wrap = st?.tb === 3;
    const pad = 4;
    // В ячейке с кнопкой фильтра место под кнопку не занимается текстом (как в Google — текст не наезжает).
    const reserve = s.filter && d.r === s.filter.startRow && d.c >= s.filter.startColumn && d.c <= s.filter.endColumn ? FILTER_BTN + 6 : 0;
    const tw = Math.max(0, d.w - reserve);
    // Переливание текста вправо в пустые ячейки (без переноса, по левому краю).
    let clipW = tw;
    if (!reserve && !wrap && st?.tb !== 2 && h === 'left' && !g.merges.has(`${d.r}:${d.c}`)) {
      const need = ctx.measureText(text).width + pad * 2;
      let cc = d.c + 1;
      while (clipW < need && cc < g.cols) {
        const nb = sheet.cellData?.[d.r]?.[cc];
        if ((nb && nb.v !== null && nb.v !== undefined && nb.v !== '') || g.merges.has(`${d.r}:${cc}`)) break;
        clipW += g.colOffs[cc + 1] - g.colOffs[cc];
        cc += 1;
      }
    }
    const lines = wrap ? wrapLines(ctx, text, tw - pad * 2) : text.split('\n');
    const blockH = lines.length * lineH;
    let y = v === 'top' ? d.y + 2 + size : v === 'middle' ? d.y + (d.h - blockH) / 2 + size : d.y + d.h - 4 - (lines.length - 1) * lineH;
    ctx.save();
    ctx.beginPath();
    ctx.rect(d.x, d.y, clipW, d.h);
    ctx.clip();
    if (bg) { ctx.fillStyle = bg; fr(d.x, d.y, d.w, d.h); ctx.fillStyle = color; }
    else if (clipW > d.w) { ctx.fillStyle = theme.bg; fr(d.x + d.w, d.y, clipW - d.w - 1, d.h - 1); ctx.fillStyle = color; }
    ctx.textAlign = h;
    const x = h === 'left' ? d.x + pad : h === 'center' ? d.x + tw / 2 : d.x + tw - pad;
    const under = (st?.ul as { s?: number } | undefined)?.s || Boolean(link);
    const strike = (st?.st as { s?: number } | undefined)?.s;
    const parts = !wrap ? richParts(d.cell, text) : null;
    if (parts) {
      // Богатый текст — частями: каждая своим шрифтом и цветом, выравнивание по общей ширине.
      const widths = parts.map((part) => { ctx.font = cellFont({ ...(st || {}), ...part.ts } as Style); return ctx.measureText(part.text).width; });
      const total = widths.reduce((a, b2) => a + b2, 0);
      let px = h === 'left' ? d.x + pad : h === 'center' ? d.x + (tw - total) / 2 : d.x + tw - pad - total;
      ctx.textAlign = 'left';
      parts.forEach((part, i) => {
        const ts = { ...(st || {}), ...part.ts } as Style;
        ctx.font = cellFont(ts);
        const pc = (part.ts.cl as { rgb?: string } | undefined)?.rgb;
        ctx.fillStyle = pc ? (theme.dark && !bg && (lightness(pc) ?? 1) < 0.35 ? theme.text : pc) : color;
        ctx.fillText(part.text, px, y);
        if ((ts.ul as { s?: number } | undefined)?.s) fr(px, y + 2, widths[i], 1);
        if ((ts.st as { s?: number } | undefined)?.s) fr(px, y - size * 0.32, widths[i], 1);
        px += widths[i];
      });
      ctx.restore();
      continue;
    }
    for (const line of lines) {
      ctx.fillText(line, x, y);
      if (under || strike) {
        const wpx = ctx.measureText(line).width;
        const lx = h === 'left' ? x : h === 'center' ? x - wpx / 2 : x - wpx;
        if (under) fr(lx, y + 2, wpx, 1);
        if (strike) fr(lx, y - size * 0.32, wpx, 1);
      }
      y += lineH;
    }
    ctx.restore();
  }

  // Границы ячеек.
  for (const d of drawn) {
    const bd = d.style?.bd as Record<string, { s?: number; cl?: { rgb?: string } } | null> | undefined;
    if (!bd) continue;
    for (const side of ['t', 'b', 'l', 'r'] as const) {
      const b = bd[side];
      if (!b?.s) continue;
      const rgb = b.cl?.rgb;
      ctx.strokeStyle = !rgb || /^#?0{6}$/.test(rgb) ? theme.borderAuto : rgb;
      const lw = BORDER_W[b.s] ?? 1;
      ctx.lineWidth = lw;
      ctx.setLineDash(DASH[b.s] || []);
      ctx.beginPath();
      const o = lw % 2 ? 0.5 : 0;
      if (side === 't') { ctx.moveTo(d.x - 1, d.y - 1 + o); ctx.lineTo(d.x + d.w, d.y - 1 + o); }
      if (side === 'b') { ctx.moveTo(d.x - 1, d.y + d.h - 1 + o); ctx.lineTo(d.x + d.w, d.y + d.h - 1 + o); }
      if (side === 'l') { ctx.moveTo(d.x - 1 + o, d.y - 1); ctx.lineTo(d.x - 1 + o, d.y + d.h); }
      if (side === 'r') { ctx.moveTo(d.x + d.w - 1 + o, d.y - 1); ctx.lineTo(d.x + d.w - 1 + o, d.y + d.h); }
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);

  // Заметки — тёмный уголок.
  if (s.notes) {
    ctx.fillStyle = theme.dark ? '#e8eaed' : '#202124';
    for (const key of Object.keys(s.notes)) {
      const [r, c] = key.split(':').map(Number);
      if (r < r0 || r > r1 || c < c0 || c > c1) continue;
      const xr = X2(c) - 1; const y = Y(r);
      ctx.beginPath(); ctx.moveTo(xr - 6, y); ctx.lineTo(xr, y); ctx.lineTo(xr, y + 6); ctx.closePath(); ctx.fill();
    }
  }
  // Уголки комментариев.
  if (s.marks.size) {
    ctx.fillStyle = '#ff9f0a';
    for (let r = r0; r <= r1; r += 1) for (let c = c0; c <= c1; c += 1) {
      if (!s.marks.has(a1(r, c))) continue;
      const xr = X2(c) - 1; const y = Y(r);
      ctx.beginPath(); ctx.moveTo(xr - 8, y); ctx.lineTo(xr, y); ctx.lineTo(xr, y + 8); ctx.closePath(); ctx.fill();
    }
  }
  ctx.restore();
}

const sameCell = (a: Range, b: Range) => a.startRow === b.startRow && a.endRow === b.endRow && a.startColumn === b.startColumn && a.endColumn === b.endColumn;

type PanePart = { x: number; y: number; w: number; h: number; clip: [number, number, number, number]; first: boolean; last: boolean };

/**
 * Куски диапазона по областям закрепления (до 4), каждый — со своей областью обрезки. Край на разрезе уводится за
 * область, чтобы рамки посередине выделения не было (как в Google).
 */
function paneParts(s: DrawState, r: Range): PanePart[] {
  const g = s.geo;
  const bodyX = HEAD_W + g.fw; const bodyY = HEAD_H + g.fh;
  // Область, что начинается у самого края листа (без прокрутки), пускает рамку на 3px в заголовок — иначе номера
  // строк и буквы столбцов срезали край выделения первой строки/столбца.
  const topEdge = g.fr > 0 || s.scrollY <= 0 ? 3 : 0; const leftEdge = g.fc > 0 || s.scrollX <= 0 ? 3 : 0;
  const rowPanes: Array<[number, number, number, number]> = [[0, g.fr - 1, HEAD_H - 3, g.fh + 3], [g.fr, g.rows - 1, bodyY - (g.fr ? 0 : topEdge), s.height - bodyY + (g.fr ? 0 : topEdge)]];
  const colPanes: Array<[number, number, number, number]> = [[0, g.fc - 1, HEAD_W - 3, g.fw + 3], [g.fc, g.cols - 1, bodyX - (g.fc ? 0 : leftEdge), s.width - bodyX + (g.fc ? 0 : leftEdge)]];
  const out: PanePart[] = [];
  for (const [ra, rb, py, ph] of rowPanes) {
    const r0 = Math.max(ra, r.startRow); const r1 = Math.min(rb, r.endRow);
    if (r1 < r0 || ph <= 0) continue;
    for (const [ca, cb, px, pw] of colPanes) {
      const c0 = Math.max(ca, r.startColumn); const c1 = Math.min(cb, r.endColumn);
      if (c1 < c0 || pw <= 0) continue;
      let x = screenX(g, c0, s.scrollX); let y = screenY(g, r0, s.scrollY);
      let x2 = screenX2(g, c1, s.scrollX); let y2 = screenY2(g, r1, s.scrollY);
      if (r0 > r.startRow) y -= 4;
      if (r1 < r.endRow) y2 += 4;
      if (c0 > r.startColumn) x -= 4;
      if (c1 < r.endColumn) x2 += 4;
      if (x2 <= x || y2 <= y) continue;
      out.push({ x, y, w: x2 - x, h: y2 - y, clip: [px, py, pw, ph], first: r0 === r.startRow && c0 === r.startColumn, last: r1 === r.endRow && c1 === r.endColumn });
    }
  }
  return out;
}

/** Тёмный ли цвет (#rrggbb или rgb()) — по относительной яркости. */
function isDarkColor(color: string): boolean {
  const hex = color.replace('#', '');
  let r = 255; let g = 255; let b = 255;
  if (/^[0-9a-f]{6,8}$/i.test(hex)) { const h = hex.length === 8 ? hex.slice(2) : hex; r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16); }
  else { const m = color.match(/(\d+)\D+(\d+)\D+(\d+)/); if (m) { r = Number(m[1]); g = Number(m[2]); b = Number(m[3]); } }
  return 0.299 * r + 0.587 * g + 0.114 * b < 140;
}

/** Размер кнопки фильтра в ячейке (по нему же щелчок в редакторе). */
export const FILTER_BTN = 14;

/** Слой ячеек, который можно не перерисовывать, пока меняется только выделение (см. drawSheet). */
export type BaseLayer = { canvas: HTMLCanvasElement; fresh: boolean };

/**
 * Нарисовать лист. С base ячейки, картинки и черта закрепления рисуются в отдельный холст; если он ещё свеж
 * (поменялось только выделение, коллеги или подсветка ссылок), он просто копируется — текст ячеек не перерисовывается.
 * Это и убирает лаг при протягивании выделения по большой таблице.
 */
export function drawSheet(ctx: CanvasRenderingContext2D, s: DrawState, base?: BaseLayer) {
  const { geo: g, width: W, height: H } = s;
  const z = s.zoom || 1;
  const k = s.dpr * z;
  const fr = (x: number, y: number, w: number, h: number) => snapRect(ctx, k, x, y, w, h);
  // Видимые строки и столбцы тела.
  const r0 = Math.max(g.fr, indexAt(g.rowOffs, s.scrollY + g.fh));
  const r1 = Math.min(g.rows - 1, indexAt(g.rowOffs, s.scrollY + H - HEAD_H) + 1);
  const c0 = Math.max(g.fc, indexAt(g.colOffs, s.scrollX + g.fw));
  const c1 = Math.min(g.cols - 1, indexAt(g.colOffs, s.scrollX + W - HEAD_W) + 1);
  if (base) {
    const bctx = base.canvas.getContext('2d');
    if (bctx && !base.fresh) {
      if (base.canvas.width !== ctx.canvas.width || base.canvas.height !== ctx.canvas.height) { base.canvas.width = ctx.canvas.width; base.canvas.height = ctx.canvas.height; }
      drawCells(bctx, s, r0, r1, c0, c1);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    if (bctx) ctx.drawImage(base.canvas, 0, 0);
    ctx.setTransform(s.dpr * z, 0, 0, s.dpr * z, 0, 0);
  } else {
    drawCells(ctx, s, r0, r1, c0, c1);
  }
  drawOverlay(ctx, s, r0, r1, c0, c1, fr);
}

/** Ячейки всех областей закрепления, черта закрепления, картинки и диаграммы. */
function drawCells(ctx: CanvasRenderingContext2D, s: DrawState, r0: number, r1: number, c0: number, c1: number) {
  const { geo: g, theme, width: W, height: H } = s;
  const z = s.zoom || 1;
  const k = s.dpr * z;
  const fr = (x: number, y: number, w: number, h: number) => snapRect(ctx, k, x, y, w, h);
  ctx.setTransform(s.dpr * z, 0, 0, s.dpr * z, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const bodyX = HEAD_W + g.fw; const bodyY = HEAD_H + g.fh;
  drawRegion(ctx, s, r0, r1, c0, c1, [bodyX, bodyY, W - bodyX, H - bodyY]);
  if (g.fr) drawRegion(ctx, s, 0, g.fr - 1, c0, c1, [bodyX, HEAD_H, W - bodyX, g.fh]);
  if (g.fc) drawRegion(ctx, s, r0, r1, 0, g.fc - 1, [HEAD_W, bodyY, g.fw, H - bodyY]);
  if (g.fr && g.fc) drawRegion(ctx, s, 0, g.fr - 1, 0, g.fc - 1, [HEAD_W, HEAD_H, g.fw, g.fh]);
  // Черта закрепления.
  ctx.fillStyle = theme.frozenLine;
  if (g.fr) fr(HEAD_W, bodyY - 1, W - HEAD_W, 2);
  if (g.fc) fr(bodyX - 1, HEAD_H, 2, H - HEAD_H);

  // Картинки и диаграммы — поверх ячеек.
  if (s.objects?.length) {
    ctx.save();
    ctx.beginPath(); ctx.rect(HEAD_W, HEAD_H, W - HEAD_W, H - HEAD_H); ctx.clip();
    for (const o of s.objects) {
      const ox = screenX(g, Math.min(o.col, g.cols - 1), s.scrollX) + o.dx; const oy = screenY(g, Math.min(o.row, g.rows - 1), s.scrollY) + o.dy;
      if (ox > W || oy > H || ox + o.w < 0 || oy + o.h < 0) continue;
      if (o.kind === 'image' && o.src) {
        const img = imageOf(o.src, s.onAsset);
        if (img) ctx.drawImage(img, ox, oy, o.w, o.h);
        else { ctx.fillStyle = theme.grid; fr(ox, oy, o.w, o.h); }
      } else if (o.kind === 'chart' && o.chart) {
        drawChart(ctx, ox, oy, o.w, o.h, o.chart, chartData(s.book, s.sheet, o.chart), theme);
      }
      if (s.selectedObject === o.id) {
        ctx.strokeStyle = theme.sel; ctx.lineWidth = 2; ctx.strokeRect(ox - 1, oy - 1, o.w + 2, o.h + 2);
        ctx.fillStyle = theme.bg;
        for (const [hx, hy] of [[ox, oy], [ox + o.w, oy], [ox, oy + o.h], [ox + o.w, oy + o.h]]) { fr(hx - 4, hy - 4, 8, 8); ctx.strokeRect(hx - 4, hy - 4, 8, 8); }
      }
    }
    ctx.restore();
  }
}

/** Выделение, коллеги, значки фильтра и заголовки — дёшево, рисуется на каждый кадр. */
function drawOverlay(ctx: CanvasRenderingContext2D, s: DrawState, r0: number, r1: number, c0: number, c1: number, fr: (x: number, y: number, w: number, h: number) => void) {
  const { geo: g, theme, width: W, height: H } = s;
  const bodyX = HEAD_W + g.fw; const bodyY = HEAD_H + g.fh;
  // Заголовки столбцов.
  const full = { cols: s.sel.startRow === 0 && s.sel.endRow >= g.rows - 1, rows: s.sel.startColumn === 0 && s.sel.endColumn >= g.cols - 1 };
  const colHead = (c: number) => {
    const x = screenX(g, c, s.scrollX); const w = g.colOffs[c + 1] - g.colOffs[c];
    if (!w) return;
    const on = c >= s.sel.startColumn && c <= s.sel.endColumn;
    const hov = s.headHover?.kind === 'col' && s.headHover.index === c;
    ctx.fillStyle = on ? (full.cols ? theme.headFull : theme.headOn) : hov ? theme.headHover : theme.head; fr(x, 0, w, HEAD_H);
    ctx.fillStyle = theme.grid; fr(x + w - 1, 0, 1, HEAD_H);
    ctx.fillStyle = on && full.cols ? '#fff' : on ? theme.text : theme.headText;
    ctx.font = `${on ? '600 ' : ''}11px Inter, Arial, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(colName(c), x + w / 2, HEAD_H / 2 + 1);
  };
  ctx.save(); ctx.beginPath(); ctx.rect(bodyX, 0, W - bodyX, HEAD_H); ctx.clip();
  ctx.fillStyle = theme.head; fr(bodyX, 0, W - bodyX, HEAD_H);
  for (let c = c0; c <= c1; c += 1) colHead(c);
  ctx.restore();
  for (let c = 0; c < g.fc; c += 1) colHead(c);
  // Номера строк.
  const rowHead = (r: number) => {
    const y = screenY(g, r, s.scrollY); const h = g.rowOffs[r + 1] - g.rowOffs[r];
    if (!h) return;
    const on = r >= s.sel.startRow && r <= s.sel.endRow;
    const hov = s.headHover?.kind === 'row' && s.headHover.index === r;
    ctx.fillStyle = on ? (full.rows ? theme.headFull : theme.headOn) : hov ? theme.headHover : theme.head; fr(0, y, HEAD_W, h);
    ctx.fillStyle = theme.grid; fr(0, y + h - 1, HEAD_W, 1);
    ctx.fillStyle = on && full.rows ? '#fff' : on ? theme.text : s.filtered.size && s.filter && r > s.filter.startRow && r <= s.filter.endRow ? theme.sel : theme.headText;
    ctx.font = `${on ? '600 ' : ''}11px Inter, Arial, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(r + 1), HEAD_W / 2, y + h / 2 + 1);
  };
  ctx.save(); ctx.beginPath(); ctx.rect(0, bodyY, HEAD_W, H - bodyY); ctx.clip();
  ctx.fillStyle = theme.head; fr(0, bodyY, HEAD_W, H - bodyY);
  for (let r = r0; r <= r1; r += 1) rowHead(r);
  ctx.restore();
  for (let r = 0; r < g.fr; r += 1) rowHead(r);
  // Скрытые строки и столбцы — отметка на границе в заголовке (щелчок по ней их показывает).
  const hiddenCol = (c: number) => c >= 0 && c < g.cols && g.colOffs[c + 1] === g.colOffs[c] && Boolean(s.sheet.columnData?.[c]?.hd);
  const hiddenRow = (r: number) => r >= 0 && r < g.rows && g.rowOffs[r + 1] === g.rowOffs[r] && Boolean(s.sheet.rowData?.[r]?.hd);
  ctx.fillStyle = theme.headText;
  for (let c = 0; c <= c1 + 1; c += 1) {
    if (c > 0 && c < c0 && c >= g.fc) continue;
    if (hiddenCol(c) && !hiddenCol(c - 1)) {
      const x = screenX(g, c, s.scrollX);
      if (x > HEAD_W) { ctx.beginPath(); ctx.moveTo(x - 6, 6); ctx.lineTo(x - 2, HEAD_H / 2); ctx.lineTo(x - 6, HEAD_H - 6); ctx.moveTo(x + 6, 6); ctx.lineTo(x + 2, HEAD_H / 2); ctx.lineTo(x + 6, HEAD_H - 6); ctx.fill(); }
    }
  }
  for (let r = 0; r <= r1 + 1; r += 1) {
    if (r > 0 && r < r0 && r >= g.fr) continue;
    if (hiddenRow(r) && !hiddenRow(r - 1)) {
      const y = screenY(g, r, s.scrollY);
      if (y > HEAD_H) { ctx.beginPath(); ctx.moveTo(12, y - 6); ctx.lineTo(HEAD_W / 2, y - 2); ctx.lineTo(HEAD_W - 12, y - 6); ctx.moveTo(12, y + 6); ctx.lineTo(HEAD_W / 2, y + 2); ctx.lineTo(HEAD_W - 12, y + 6); ctx.fill(); }
    }
  }
  // Группы строк/столбцов: скобка вдоль заголовка и кнопка «−»/«+» за концом группы (как в Google).
  ctx.strokeStyle = theme.headText; ctx.lineWidth = 1;
  const box = (bx: number, by: number, plus: boolean) => {
    ctx.fillStyle = theme.head; fr(bx, by, 10, 10); ctx.strokeRect(bx + 0.5, by + 0.5, 9, 9);
    ctx.beginPath(); ctx.moveTo(bx + 2.5, by + 5); ctx.lineTo(bx + 7.5, by + 5); if (plus) { ctx.moveTo(bx + 5, by + 2.5); ctx.lineTo(bx + 5, by + 7.5); } ctx.stroke();
  };
  for (const gr of s.groups?.rows || []) {
    const y1 = screenY(g, gr.start, s.scrollY); const y2 = screenY2(g, Math.min(gr.end, g.rows - 1), s.scrollY);
    if (y2 < HEAD_H || y1 > H) continue;
    if (!gr.collapsed) { ctx.beginPath(); ctx.moveTo(3.5, Math.max(HEAD_H, y1 + 3)); ctx.lineTo(3.5, y2); ctx.lineTo(8, y2); ctx.stroke(); }
    if (y2 >= HEAD_H) box(1, y2 + 2, Boolean(gr.collapsed));
  }
  for (const gr of s.groups?.cols || []) {
    const x1 = screenX(g, gr.start, s.scrollX); const x2 = screenX2(g, Math.min(gr.end, g.cols - 1), s.scrollX);
    if (x2 < HEAD_W || x1 > W) continue;
    if (!gr.collapsed) { ctx.beginPath(); ctx.moveTo(Math.max(HEAD_W, x1 + 3), 3.5); ctx.lineTo(x2, 3.5); ctx.lineTo(x2, 8); ctx.stroke(); }
    if (x2 >= HEAD_W) box(x2 + 2, 1, Boolean(gr.collapsed));
  }
  // Ручка ширины столбца / высоты строки под курсором — синяя полоска на границе в заголовке (как в Google).
  if (s.headHover?.kind === 'resize-col') { const bx = screenX2(g, s.headHover.index, s.scrollX); if (bx > HEAD_W) { ctx.fillStyle = theme.sel; fr(bx - 3, 3, 4, HEAD_H - 6); } }
  if (s.headHover?.kind === 'resize-row') { const by = screenY2(g, s.headHover.index, s.scrollY); if (by > HEAD_H) { ctx.fillStyle = theme.sel; fr(4, by - 3, HEAD_W - 8, 4); } }
  ctx.fillStyle = theme.grid;
  fr(HEAD_W - 1, 0, 1, H);
  fr(0, HEAD_H - 1, W, 1);
  ctx.fillStyle = theme.head; fr(0, 0, HEAD_W - 1, HEAD_H - 1);
  ctx.textBaseline = 'alphabetic';

  // Выделение, коллеги, буфер — поверх ячеек и после заголовков (у края листа рамка заходит на заголовок, как в Google). Рисуются по областям закрепления: строка, уехавшая
  // под закреплённую, не должна вылезать поверх неё.
  const round = (rx: number, ry: number, rw: number, rh: number, r: number) => { ctx.beginPath(); ctx.roundRect(rx, ry, rw, rh, r); };
  /**
   * Рамка вокруг ячеек x..x+w: кольцо толщиной t снаружи ячейки, скруглён только внешний край. Внутренний край прямой
   * и совпадает с ячейкой — иначе из-под скругления торчали квадратные углы ячейки и сетки.
   */
  const ring = (x: number, y: number, w: number, h: number, t: number, color: string) => {
    ctx.beginPath();
    ctx.roundRect(x - t, y - t, w + t * 2 - 1, h + t * 2 - 1, t + 1);
    ctx.rect(x, y, w - 1, h - 1);
    ctx.fillStyle = color; ctx.fill('evenodd');
  };
  const inPanes = (range: Range, fn: (p: PanePart) => void) => {
    for (const p of paneParts(s, range)) { ctx.save(); ctx.beginPath(); ctx.rect(p.clip[0], p.clip[1], p.clip[2], p.clip[3]); ctx.clip(); fn(p); ctx.restore(); }
  };
  for (const peer of s.peers) {
    inPanes(peer.range, ({ x, y, w, h, first }) => {
      ctx.strokeStyle = peer.color; ctx.lineWidth = 2; ctx.strokeRect(x, y, w - 1, h - 1);
      if (!first) return;
      ctx.font = '600 10px Inter, Arial, sans-serif';
      const tw = ctx.measureText(peer.name).width + 10;
      ctx.fillStyle = peer.color; fr(x - 1, y - 15, tw, 14);
      ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.fillText(peer.name, x + 4, y - 4);
    });
  }
  if (s.clip) {
    inPanes(s.clip, ({ x, y, w, h }) => { ctx.strokeStyle = theme.sel; ctx.lineWidth = 2; ctx.setLineDash([5, 3]); ctx.strokeRect(x, y, w - 1, h - 1); ctx.setLineDash([]); });
  }
  // Углы рамки чуть скруглены (2px): острые углы выглядят грубо.
  const single = s.sel.startRow === s.sel.endRow && s.sel.startColumn === s.sel.endColumn;
  inPanes(s.sel, ({ x, y, w, h }) => {
    if (!single) {
      // Активная ячейка внутри выделения не подкрашивается — как в Google.
      const a = s.active;
      const ax = screenX(g, a.startColumn, s.scrollX); const ay = screenY(g, a.startRow, s.scrollY);
      ctx.beginPath(); ctx.rect(x, y, w - 1, h - 1);
      if (!s.hideActive) ctx.rect(ax, ay, screenX2(g, a.endColumn, s.scrollX) - ax - 1, screenY2(g, a.endRow, s.scrollY) - ay - 1);
      ctx.fillStyle = theme.selFill; ctx.fill('evenodd');
    }
    ring(x, y, w, h, 1, theme.sel);
  });
  if (!s.hideActive) {
    // Толстая рамка — только у одной выбранной ячейки; внутри диапазона активная лишь не подкрашена (как в Google).
    if (single || sameCell(s.sel, s.active)) inPanes(s.active, ({ x, y, w, h }) => ring(x, y, w, h, 2, theme.sel));
    // Квадратик автозаполнения — в правом нижнем углу выделения, поверх рамки активной ячейки.
    inPanes(s.sel, ({ x, y, w, h, last }) => {
      if (!last) return;
      ctx.fillStyle = theme.sel; ctx.strokeStyle = theme.bg; ctx.lineWidth = 1;
      round(x + w - 4.5, y + h - 4.5, 7, 7, 1.5); ctx.fill(); ctx.stroke();
    });
  }
  if (s.ghost) {
    // Место, куда встанут перетаскиваемые ячейки, — толстая полупрозрачная рамка.
    inPanes(s.ghost, ({ x, y, w, h }) => { ctx.globalAlpha = 0.6; ring(x, y, w, h, 3, theme.sel); ctx.globalAlpha = 1; });
  }
  if (s.dropAt) {
    const { axis, at } = s.dropAt;
    ctx.fillStyle = theme.sel;
    if (axis === 'row') { const y = at >= g.rows ? screenY2(g, g.rows - 1, s.scrollY) : screenY(g, at, s.scrollY); fr(HEAD_W, y - 2, W - HEAD_W, 3); }
    else { const x = at >= g.cols ? screenX2(g, g.cols - 1, s.scrollX) : screenX(g, at, s.scrollX); fr(x - 2, HEAD_H, 3, H - HEAD_H); }
  }
  for (const ref of s.refs || []) {
    inPanes(ref.range, ({ x, y, w, h }) => {
      ctx.globalAlpha = 0.12; ctx.fillStyle = ref.color; fr(x, y, w, h); ctx.globalAlpha = 1;
      ctx.strokeStyle = ref.color; ctx.lineWidth = 2; ctx.setLineDash([]); ctx.strokeRect(x - 1, y - 1, w + 1, h + 1);
    });
  }

  // Кнопки фильтра — в ячейках первой строки диапазона фильтра, у правого края (как в Google Таблицах).
  if (s.filter) {
    const row = s.filter.startRow;
    for (let c = s.filter.startColumn; c <= s.filter.endColumn; c += 1) {
      if (g.colOffs[c + 1] === g.colOffs[c]) continue;
      const on = s.filterOn?.has(c);
      inPanes({ startRow: row, endRow: row, startColumn: c, endColumn: c }, ({ x, y, w, h }) => {
        const bx = x + w - FILTER_BTN - 4; const by = y + Math.round((h - FILTER_BTN) / 2);
        // Без рамки, как в Google: серые полоски; если по столбцу задано условие — залитый кружок-подложка.
        if (on) { ctx.fillStyle = theme.sel; round(bx, by, FILTER_BTN, FILTER_BTN, FILTER_BTN / 2); ctx.fill(); }
        // Цвет полосок — от заливки ячейки: на тёмной шапке белые, на светлой синие (иначе значок терялся).
        const cellBg = (styleOf(s.book, s.sheet.cellData?.[row]?.[c] ?? undefined)?.bg as { rgb?: string } | undefined)?.rgb;
        // Как в Google: на белой ячейке значок зелёный, на цветной светлой — тёмный, на тёмной — белый.
        const hex = (cellBg || '').replace('#', '').toLowerCase();
        const white = !cellBg || hex === 'ffffff' || hex === 'ffffffff';
        const dark = white ? theme.dark : isDarkColor(cellBg!);
        ctx.fillStyle = on ? '#fff' : dark ? '#ffffff' : white ? '#188038' : '#202124';
        const cx = bx + FILTER_BTN / 2; const cy = by + FILTER_BTN / 2;
        for (const [dy, len] of [[-3.5, 10], [0, 6], [3.5, 2]] as const) fr(cx - len / 2, cy + dy - 0.75, len, 1.5);
      });
    }
  }

}
