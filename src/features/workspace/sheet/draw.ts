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
  bg: string; text: string; link: string; grid: string; head: string; headText: string; headOn: string; headFull: string; sel: string; selFill: string; borderAuto: string; frozenLine: string; dark: boolean;
}
export interface Peer { name: string; color: string; range: Range }
export interface DrawState {
  book: Book; sheet: Sheet; geo: Geo; theme: Theme;
  scrollX: number; scrollY: number; width: number; height: number; dpr: number;
  sel: Range; active: Range; clip: Range | null; peers: Peer[]; marks: Set<string>;
  filter: Range | null; filtered: Set<number>; hideActive?: boolean;
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
    headOn: v('--sh-head-on', '#d3e3fd'), headFull: v('--sh-head-full', '#0b57d0'), sel: v('--sh-sel', '#1a73e8'), selFill: v('--sh-sel-fill', 'rgba(26,115,232,.1)'),
    borderAuto: v('--sh-border-auto', '#000'), frozenLine: v('--sh-head-text', '#5f6368'), dark: (lightness(bg) ?? 1) < 0.4,
  };
}

/** Экранная x начала столбца c (и аналогично строки). */
export const screenX = (g: Geo, c: number, scrollX: number) => HEAD_W + g.colOffs[c] - (c >= g.fc ? scrollX : 0);
export const screenY = (g: Geo, r: number, scrollY: number) => HEAD_H + g.rowOffs[r] - (r >= g.fr ? scrollY : 0);

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
  if (r1 < r0 || c1 < c0 || clip[2] <= 0 || clip[3] <= 0) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(clip[0], clip[1], clip[2], clip[3]);
  ctx.clip();
  ctx.fillStyle = theme.bg;
  ctx.fillRect(clip[0], clip[1], clip[2], clip[3]);
  const X = (c: number) => screenX(g, c, s.scrollX);
  const Y = (r: number) => screenY(g, r, s.scrollY);

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
    const w = X(c2 + 1) - x; const h = Y(r2 + 1) - y;
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
    ctx.fillRect(x, y, X(m.endColumn + 1) - x, Y(m.endRow + 1) - y);
  }

  // Чередование цветов — под сеткой и под своей заливкой ячеек.
  for (const bd of s.banding || []) {
    const rr0 = Math.max(r0, bd.range.startRow); const rr1 = Math.min(r1, bd.range.endRow);
    const cc0 = Math.max(c0, bd.range.startColumn); const cc1 = Math.min(c1, bd.range.endColumn);
    if (rr1 < rr0 || cc1 < cc0) continue;
    const x0 = X(cc0); const x1 = X(cc1 + 1);
    for (let r = rr0; r <= rr1; r += 1) {
      const rel = r - bd.range.startRow;
      const color = bd.header && rel === 0 ? bd.header : bd.footer && r === bd.range.endRow ? bd.footer : (rel - (bd.header ? 1 : 0)) % 2 === 0 ? bd.odd : bd.even;
      ctx.fillStyle = color;
      ctx.fillRect(x0, Y(r), x1 - x0, Y(r + 1) - Y(r));
    }
  }

  // Сетка (у листа её можно выключить — «Вид → Сетка», как в Google).
  if ((sheet as { showGridlines?: number }).showGridlines !== 0) {
    ctx.fillStyle = theme.grid;
    const top = Y(r0); const bottom = Y(r1 + 1); const left = X(c0); const right = X(c1 + 1);
    for (let r = r0; r <= r1 + 1; r += 1) { if (r <= r1 && g.rowOffs[r + 1] === g.rowOffs[r]) continue; ctx.fillRect(left, Y(r) - 1, right - left, 1); }
    for (let c = c0; c <= c1 + 1; c += 1) { if (c <= c1 && g.colOffs[c + 1] === g.colOffs[c]) continue; ctx.fillRect(X(c) - 1, top, 1, bottom - top); }
  }
  for (const m of seenMerge) {
    const x = X(m.startColumn); const y = Y(m.startRow);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(x, y, X(m.endColumn + 1) - x - 1, Y(m.endRow + 1) - y - 1);
  }
  for (const d of drawn) {
    const bg = (d.style?.bg as { rgb?: string } | undefined)?.rgb;
    if (bg) { ctx.fillStyle = bg; ctx.fillRect(d.x - 1, d.y - 1, d.w + 1, d.h + 1); }
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
    const link = linkOf(d.cell);
    if (link && !(st?.cl as { rgb?: string } | undefined)?.rgb) color = theme.link;
    ctx.fillStyle = color;
    const h = ({ 1: 'left', 2: 'center', 3: 'right', 4: 'left' } as Record<number, 'left' | 'center' | 'right'>)[Number(st?.ht)] || autoAlign(d.cell);
    const v = ({ 1: 'top', 2: 'middle', 3: 'bottom' } as Record<number, string>)[Number(st?.vt)] || 'bottom';
    const size = (typeof st?.fs === 'number' ? st.fs : 10) * (96 / 72);
    const lineH = Math.round(size * 1.25);
    const wrap = st?.tb === 3;
    const pad = 4;
    // Переливание текста вправо в пустые ячейки (без переноса, по левому краю).
    let clipW = d.w;
    if (!wrap && st?.tb !== 2 && h === 'left' && !g.merges.has(`${d.r}:${d.c}`)) {
      const need = ctx.measureText(text).width + pad * 2;
      let cc = d.c + 1;
      while (clipW < need && cc < g.cols) {
        const nb = sheet.cellData?.[d.r]?.[cc];
        if ((nb && nb.v !== null && nb.v !== undefined && nb.v !== '') || g.merges.has(`${d.r}:${cc}`)) break;
        clipW += g.colOffs[cc + 1] - g.colOffs[cc];
        cc += 1;
      }
    }
    const lines = wrap ? wrapLines(ctx, text, d.w - pad * 2) : text.split('\n');
    const blockH = lines.length * lineH;
    let y = v === 'top' ? d.y + 2 + size : v === 'middle' ? d.y + (d.h - blockH) / 2 + size : d.y + d.h - 4 - (lines.length - 1) * lineH;
    ctx.save();
    ctx.beginPath();
    ctx.rect(d.x, d.y, clipW, d.h);
    ctx.clip();
    if (bg) { ctx.fillStyle = bg; ctx.fillRect(d.x, d.y, d.w, d.h); ctx.fillStyle = color; }
    else if (clipW > d.w) { ctx.fillStyle = theme.bg; ctx.fillRect(d.x + d.w, d.y, clipW - d.w - 1, d.h - 1); ctx.fillStyle = color; }
    ctx.textAlign = h;
    const x = h === 'left' ? d.x + pad : h === 'center' ? d.x + d.w / 2 : d.x + d.w - pad;
    const under = (st?.ul as { s?: number } | undefined)?.s || Boolean(link);
    const strike = (st?.st as { s?: number } | undefined)?.s;
    const parts = !wrap ? richParts(d.cell, text) : null;
    if (parts) {
      // Богатый текст — частями: каждая своим шрифтом и цветом, выравнивание по общей ширине.
      const widths = parts.map((part) => { ctx.font = cellFont({ ...(st || {}), ...part.ts } as Style); return ctx.measureText(part.text).width; });
      const total = widths.reduce((a, b2) => a + b2, 0);
      let px = h === 'left' ? d.x + pad : h === 'center' ? d.x + (d.w - total) / 2 : d.x + d.w - pad - total;
      ctx.textAlign = 'left';
      parts.forEach((part, i) => {
        const ts = { ...(st || {}), ...part.ts } as Style;
        ctx.font = cellFont(ts);
        const pc = (part.ts.cl as { rgb?: string } | undefined)?.rgb;
        ctx.fillStyle = pc ? (theme.dark && !bg && (lightness(pc) ?? 1) < 0.35 ? theme.text : pc) : color;
        ctx.fillText(part.text, px, y);
        if ((ts.ul as { s?: number } | undefined)?.s) ctx.fillRect(px, y + 2, widths[i], 1);
        if ((ts.st as { s?: number } | undefined)?.s) ctx.fillRect(px, y - size * 0.32, widths[i], 1);
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
        if (under) ctx.fillRect(lx, y + 2, wpx, 1);
        if (strike) ctx.fillRect(lx, y - size * 0.32, wpx, 1);
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
      const xr = X(c + 1) - 1; const y = Y(r);
      ctx.beginPath(); ctx.moveTo(xr - 6, y); ctx.lineTo(xr, y); ctx.lineTo(xr, y + 6); ctx.closePath(); ctx.fill();
    }
  }
  // Уголки комментариев.
  if (s.marks.size) {
    ctx.fillStyle = '#ff9f0a';
    for (let r = r0; r <= r1; r += 1) for (let c = c0; c <= c1; c += 1) {
      if (!s.marks.has(a1(r, c))) continue;
      const xr = X(c + 1) - 1; const y = Y(r);
      ctx.beginPath(); ctx.moveTo(xr - 8, y); ctx.lineTo(xr, y); ctx.lineTo(xr, y + 8); ctx.closePath(); ctx.fill();
    }
  }
  ctx.restore();
}

/** Прямоугольник диапазона на экране. */
function rangeRect(s: DrawState, r: Range): [number, number, number, number] {
  const x = screenX(s.geo, r.startColumn, s.scrollX); const y = screenY(s.geo, r.startRow, s.scrollY);
  const x2 = screenX(s.geo, Math.min(r.endColumn + 1, s.geo.cols), s.scrollX); const y2 = screenY(s.geo, Math.min(r.endRow + 1, s.geo.rows), s.scrollY);
  return [x, y, Math.max(0, x2 - x), Math.max(0, y2 - y)];
}

export function drawSheet(ctx: CanvasRenderingContext2D, s: DrawState) {
  const { geo: g, theme, width: W, height: H } = s;
  const z = s.zoom || 1;
  ctx.setTransform(s.dpr * z, 0, 0, s.dpr * z, 0, 0);
  ctx.clearRect(0, 0, W, H);
  // Видимые строки и столбцы тела.
  const r0 = Math.max(g.fr, indexAt(g.rowOffs, s.scrollY + g.fh));
  const r1 = Math.min(g.rows - 1, indexAt(g.rowOffs, s.scrollY + H - HEAD_H) + 1);
  const c0 = Math.max(g.fc, indexAt(g.colOffs, s.scrollX + g.fw));
  const c1 = Math.min(g.cols - 1, indexAt(g.colOffs, s.scrollX + W - HEAD_W) + 1);
  const bodyX = HEAD_W + g.fw; const bodyY = HEAD_H + g.fh;
  drawRegion(ctx, s, r0, r1, c0, c1, [bodyX, bodyY, W - bodyX, H - bodyY]);
  if (g.fr) drawRegion(ctx, s, 0, g.fr - 1, c0, c1, [bodyX, HEAD_H, W - bodyX, g.fh]);
  if (g.fc) drawRegion(ctx, s, r0, r1, 0, g.fc - 1, [HEAD_W, bodyY, g.fw, H - bodyY]);
  if (g.fr && g.fc) drawRegion(ctx, s, 0, g.fr - 1, 0, g.fc - 1, [HEAD_W, HEAD_H, g.fw, g.fh]);
  // Черта закрепления.
  ctx.fillStyle = theme.frozenLine;
  if (g.fr) ctx.fillRect(HEAD_W, bodyY - 1, W - HEAD_W, 2);
  if (g.fc) ctx.fillRect(bodyX - 1, HEAD_H, 2, H - HEAD_H);

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
        else { ctx.fillStyle = theme.grid; ctx.fillRect(ox, oy, o.w, o.h); }
      } else if (o.kind === 'chart' && o.chart) {
        drawChart(ctx, ox, oy, o.w, o.h, o.chart, chartData(s.book, s.sheet, o.chart), theme);
      }
      if (s.selectedObject === o.id) {
        ctx.strokeStyle = theme.sel; ctx.lineWidth = 2; ctx.strokeRect(ox - 1, oy - 1, o.w + 2, o.h + 2);
        ctx.fillStyle = theme.bg;
        for (const [hx, hy] of [[ox, oy], [ox + o.w, oy], [ox, oy + o.h], [ox + o.w, oy + o.h]]) { ctx.fillRect(hx - 4, hy - 4, 8, 8); ctx.strokeRect(hx - 4, hy - 4, 8, 8); }
      }
    }
    ctx.restore();
  }

  // Выделение, коллеги, буфер — поверх ячеек, под заголовками.
  ctx.save();
  ctx.beginPath();
  ctx.rect(HEAD_W, HEAD_H, W - HEAD_W, H - HEAD_H);
  ctx.clip();
  for (const p of s.peers) {
    const [x, y, w, h] = rangeRect(s, p.range);
    ctx.strokeStyle = p.color; ctx.lineWidth = 2; ctx.strokeRect(x, y, w - 1, h - 1);
    ctx.font = '600 10px Inter, Arial, sans-serif';
    const tw = ctx.measureText(p.name).width + 10;
    ctx.fillStyle = p.color; ctx.fillRect(x - 1, y - 15, tw, 14);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.fillText(p.name, x + 4, y - 4);
  }
  if (s.clip) {
    const [x, y, w, h] = rangeRect(s, s.clip);
    ctx.strokeStyle = theme.sel; ctx.lineWidth = 2; ctx.setLineDash([5, 3]); ctx.strokeRect(x, y, w - 1, h - 1); ctx.setLineDash([]);
  }
  {
    const [x, y, w, h] = rangeRect(s, s.sel);
    ctx.fillStyle = theme.selFill; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = theme.sel; ctx.lineWidth = 1; ctx.strokeRect(x - 0.5, y - 0.5, w, h);
    if (!s.hideActive) {
      const [ax, ay, aw, ah] = rangeRect(s, s.active);
      ctx.lineWidth = 2; ctx.strokeRect(ax - 1, ay - 1, aw + 1, ah + 1);
      // Квадратик автозаполнения — в правом нижнем углу выделения.
      ctx.fillStyle = theme.sel; ctx.fillRect(x + w - 4, y + h - 4, 7, 7);
      ctx.fillStyle = theme.bg; ctx.fillRect(x + w - 4, y + h - 5, 7, 1); ctx.fillRect(x + w - 5, y + h - 4, 1, 7);
    }
  }
  for (const ref of s.refs || []) {
    const [x, y, w, h] = rangeRect(s, ref.range);
    ctx.globalAlpha = 0.12; ctx.fillStyle = ref.color; ctx.fillRect(x, y, w, h); ctx.globalAlpha = 1;
    ctx.strokeStyle = ref.color; ctx.lineWidth = 2; ctx.setLineDash([]); ctx.strokeRect(x - 1, y - 1, w + 1, h + 1);
  }
  ctx.restore();

  // Заголовки столбцов.
  const full = { cols: s.sel.startRow === 0 && s.sel.endRow >= g.rows - 1, rows: s.sel.startColumn === 0 && s.sel.endColumn >= g.cols - 1 };
  const colHead = (c: number) => {
    const x = screenX(g, c, s.scrollX); const w = g.colOffs[c + 1] - g.colOffs[c];
    if (!w) return;
    const on = c >= s.sel.startColumn && c <= s.sel.endColumn;
    ctx.fillStyle = on ? (full.cols ? theme.headFull : theme.headOn) : theme.head; ctx.fillRect(x, 0, w, HEAD_H);
    ctx.fillStyle = theme.grid; ctx.fillRect(x + w - 1, 0, 1, HEAD_H);
    ctx.fillStyle = on && full.cols ? '#fff' : on ? theme.text : theme.headText;
    ctx.font = `${on ? '600 ' : ''}11px Inter, Arial, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(colName(c), x + w / 2, HEAD_H / 2 + 1);
    if (s.filter && c >= s.filter.startColumn && c <= s.filter.endColumn) {
      // Стрелка фильтра — в заголовке столбца (щелчок открывает список).
      const fx = x + w - 14; const fy = HEAD_H / 2;
      ctx.fillStyle = theme.sel; ctx.beginPath(); ctx.moveTo(fx - 4, fy - 2); ctx.lineTo(fx + 4, fy - 2); ctx.lineTo(fx, fy + 3); ctx.closePath(); ctx.fill();
    }
  };
  ctx.save(); ctx.beginPath(); ctx.rect(bodyX, 0, W - bodyX, HEAD_H); ctx.clip();
  ctx.fillStyle = theme.head; ctx.fillRect(bodyX, 0, W - bodyX, HEAD_H);
  for (let c = c0; c <= c1; c += 1) colHead(c);
  ctx.restore();
  for (let c = 0; c < g.fc; c += 1) colHead(c);
  // Номера строк.
  const rowHead = (r: number) => {
    const y = screenY(g, r, s.scrollY); const h = g.rowOffs[r + 1] - g.rowOffs[r];
    if (!h) return;
    const on = r >= s.sel.startRow && r <= s.sel.endRow;
    ctx.fillStyle = on ? (full.rows ? theme.headFull : theme.headOn) : theme.head; ctx.fillRect(0, y, HEAD_W, h);
    ctx.fillStyle = theme.grid; ctx.fillRect(0, y + h - 1, HEAD_W, 1);
    ctx.fillStyle = on && full.rows ? '#fff' : on ? theme.text : s.filtered.size && s.filter && r > s.filter.startRow && r <= s.filter.endRow ? theme.sel : theme.headText;
    ctx.font = `${on ? '600 ' : ''}11px Inter, Arial, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(r + 1), HEAD_W / 2, y + h / 2 + 1);
  };
  ctx.save(); ctx.beginPath(); ctx.rect(0, bodyY, HEAD_W, H - bodyY); ctx.clip();
  ctx.fillStyle = theme.head; ctx.fillRect(0, bodyY, HEAD_W, H - bodyY);
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
    ctx.fillStyle = theme.head; ctx.fillRect(bx, by, 10, 10); ctx.strokeRect(bx + 0.5, by + 0.5, 9, 9);
    ctx.beginPath(); ctx.moveTo(bx + 2.5, by + 5); ctx.lineTo(bx + 7.5, by + 5); if (plus) { ctx.moveTo(bx + 5, by + 2.5); ctx.lineTo(bx + 5, by + 7.5); } ctx.stroke();
  };
  for (const gr of s.groups?.rows || []) {
    const y1 = screenY(g, gr.start, s.scrollY); const y2 = screenY(g, Math.min(gr.end + 1, g.rows), s.scrollY);
    if (y2 < HEAD_H || y1 > H) continue;
    if (!gr.collapsed) { ctx.beginPath(); ctx.moveTo(3.5, Math.max(HEAD_H, y1 + 3)); ctx.lineTo(3.5, y2); ctx.lineTo(8, y2); ctx.stroke(); }
    if (y2 >= HEAD_H) box(1, y2 + 2, Boolean(gr.collapsed));
  }
  for (const gr of s.groups?.cols || []) {
    const x1 = screenX(g, gr.start, s.scrollX); const x2 = screenX(g, Math.min(gr.end + 1, g.cols), s.scrollX);
    if (x2 < HEAD_W || x1 > W) continue;
    if (!gr.collapsed) { ctx.beginPath(); ctx.moveTo(Math.max(HEAD_W, x1 + 3), 3.5); ctx.lineTo(x2, 3.5); ctx.lineTo(x2, 8); ctx.stroke(); }
    if (x2 >= HEAD_W) box(x2 + 2, 1, Boolean(gr.collapsed));
  }
  ctx.fillStyle = theme.grid;
  ctx.fillRect(HEAD_W - 1, 0, 1, H);
  ctx.fillRect(0, HEAD_H - 1, W, 1);
  ctx.fillStyle = theme.head; ctx.fillRect(0, 0, HEAD_W - 1, HEAD_H - 1);
  ctx.textBaseline = 'alphabetic';
}
