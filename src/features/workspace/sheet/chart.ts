import { displayText, styleOf, type Book, type Sheet } from './model';
import type { ChartSpec } from './extras';

/**
 * Диаграммы листа на холсте — из данных диапазона, как в Google Таблицах: ряды по столбцам (или строкам), первая
 * строка — названия рядов, первый столбец — подписи. Пересчитываются вместе с листом (рисуются на каждом кадре).
 */

export const CHART_COLORS = ['#4285f4', '#ea4335', '#fbbc04', '#34a853', '#ff6d01', '#46bdc6', '#7baaf7', '#f07b72', '#fcd04f', '#71c287'];

export interface ChartData { labels: string[]; series: Array<{ name: string; values: Array<number | null> }> }

export function chartData(book: Book, sheet: Sheet, spec: ChartSpec): ChartData {
  const r = spec.range;
  const text = (row: number, col: number) => { const c = sheet.cellData?.[row]?.[col]; return c ? displayText(c, styleOf(book, c)) : ''; };
  const val = (row: number, col: number) => { const v = sheet.cellData?.[row]?.[col]?.v; return typeof v === 'number' ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v.replace(',', '.'))) ? Number(v.replace(',', '.')) : null; };
  // Заголовки и подписи — по умолчанию угадываем: первая строка/столбец не числа.
  const headers = spec.headers ?? (val(r.startRow, r.endColumn) === null && text(r.startRow, r.endColumn) !== '');
  const labels = spec.labels ?? (r.endColumn > r.startColumn && val(r.startRow + (headers ? 1 : 0), r.startColumn) === null);
  const byRows = Boolean(spec.byRows);
  const out: ChartData = { labels: [], series: [] };
  const rows: number[] = []; const cols: number[] = [];
  for (let i = r.startRow + (headers ? 1 : 0); i <= r.endRow; i += 1) rows.push(i);
  for (let j = r.startColumn + (labels ? 1 : 0); j <= r.endColumn; j += 1) cols.push(j);
  const capRows = rows.slice(0, 500);
  if (!byRows) {
    out.labels = capRows.map((i, k) => (labels ? text(i, r.startColumn) : String(k + 1)));
    out.series = cols.map((j) => ({ name: headers ? text(r.startRow, j) : `Ряд ${j - r.startColumn + 1}`, values: capRows.map((i) => val(i, j)) }));
  } else {
    out.labels = cols.map((j, k) => (headers ? text(r.startRow, j) : String(k + 1)));
    out.series = capRows.map((i) => ({ name: labels ? text(i, r.startColumn) : `Ряд ${i - r.startRow + 1}`, values: cols.map((j) => val(i, j)) }));
  }
  return out;
}

/** Число на оси, как у Google в русской локали: 50 000, 1,5 млн, 0,25. */
const num = (x: number, digits = 2) => x.toLocaleString('ru-RU', { maximumFractionDigits: digits });
const fmt = (x: number) => (Math.abs(x) >= 1e6 ? `${num(x / 1e6, 1)} млн` : num(Number(x.toPrecision(6))));

/** Подпись не шире max — с многоточием (fillText с maxWidth сплющивал буквы). */
function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0; let hi = text.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ctx.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid; else hi = mid - 1; }
  return lo ? `${text.slice(0, lo).trimEnd()}…` : '';
}
function niceStep(range: number, ticks: number) {
  const raw = range / Math.max(1, ticks);
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
}

export function drawChart(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, spec: ChartSpec, data: ChartData, theme: { bg: string; text: string; grid: string; dark: boolean }) {
  const colors = spec.colors?.length ? spec.colors : CHART_COLORS;
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = theme.dark ? '#26272b' : '#ffffff'; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = theme.grid; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  const ink = theme.dark ? '#e8eaed' : '#202124'; const soft = theme.dark ? '#9aa0a6' : '#5f6368';
  const gridInk = theme.dark ? '#3c4043' : '#e0e3e7'; const axisInk = theme.dark ? '#5f6368' : '#bdc1c6';
  let top = y + 14;
  // Без своего названия — как у Google: из имён рядов («Цена и Дней»); пустая строка — без названия.
  const title = spec.title ?? (data.series.length ? (data.series.length > 1 ? `${data.series.slice(0, -1).map((x0) => x0.name).join(', ')} и ${data.series[data.series.length - 1].name}` : data.series[0].name) : '');
  if (title) { ctx.fillStyle = ink; ctx.font = '600 14px Inter, Arial, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(fit(ctx, title, w - 32), x + 16, top); top += 26; }
  const legend = spec.legend ?? (spec.type === 'pie' || spec.type === 'doughnut' ? 'right' : data.series.length > 1 ? 'bottom' : 'none');
  const pie = spec.type === 'pie' || spec.type === 'doughnut';
  const legendItems = pie ? data.labels : data.series.map((s) => s.name);
  let right = x + w - 12; let bottom = y + h - 10;
  ctx.font = '12px Inter, Arial, sans-serif'; ctx.textBaseline = 'middle';
  if (legend === 'right' && legendItems.length) {
    const lw = Math.min(w * 0.35, Math.max(...legendItems.map((t) => ctx.measureText(t).width)) + 26);
    legendItems.slice(0, 20).forEach((t, i) => {
      const ly = top + 8 + i * 18;
      ctx.fillStyle = colors[i % colors.length]; ctx.beginPath(); ctx.arc(right - lw + 6, ly, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = soft; ctx.textAlign = 'left'; ctx.fillText(fit(ctx, t, lw - 18), right - lw + 16, ly);
    });
    right -= lw + 8;
  } else if (legend === 'bottom' && legendItems.length) {
    let lx = x + 16; const ly = bottom - 8;
    legendItems.slice(0, 12).forEach((t, i) => {
      const tw = ctx.measureText(t).width;
      if (lx + tw + 24 > x + w) return;
      ctx.fillStyle = colors[i % colors.length]; ctx.beginPath(); ctx.arc(lx + 5, ly, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = soft; ctx.textAlign = 'left'; ctx.fillText(t, lx + 14, ly);
      lx += tw + 30;
    });
    bottom -= 26;
  }

  if (pie) {
    const vals = (data.series[0]?.values || []).map((v) => Math.max(0, v ?? 0));
    const total = vals.reduce((a, b) => a + b, 0) || 1;
    const cx = x + 12 + (right - x - 12) / 2; const cy = top + (bottom - top) / 2;
    const rad = Math.max(10, Math.min(right - x - 24, bottom - top) / 2 - 4);
    let a0 = -Math.PI / 2;
    vals.forEach((v, i) => {
      const a1 = a0 + (v / total) * Math.PI * 2;
      ctx.fillStyle = colors[i % colors.length]; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, rad, a0, a1); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = theme.dark ? '#26272b' : '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
      if (v / total > 0.05) {
        const mid = (a0 + a1) / 2;
        ctx.fillStyle = '#fff'; ctx.font = '600 11px Inter, Arial, sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(`${Math.round((v / total) * 1000) / 10}%`.replace('.', ','), cx + Math.cos(mid) * rad * (spec.type === 'doughnut' ? 0.78 : 0.62), cy + Math.sin(mid) * rad * (spec.type === 'doughnut' ? 0.78 : 0.62));
      }
      a0 = a1;
    });
    if (spec.type === 'doughnut') { ctx.fillStyle = theme.dark ? '#26272b' : '#fff'; ctx.beginPath(); ctx.arc(cx, cy, rad * 0.55, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
    return;
  }

  // Оси.
  const horizontal = spec.type === 'bar';
  const stacked = Boolean(spec.stacked) && (spec.type === 'column' || spec.type === 'bar' || spec.type === 'area');
  const n = data.labels.length;
  let lo = 0; let hi = 0;
  if (stacked) {
    for (let i = 0; i < n; i += 1) { let pos = 0; let neg = 0; for (const s of data.series) { const v = s.values[i] ?? 0; if (v >= 0) pos += v; else neg += v; } hi = Math.max(hi, pos); lo = Math.min(lo, neg); }
  } else for (const s of data.series) for (const v of s.values) if (v !== null) { hi = Math.max(hi, v); lo = Math.min(lo, v); }
  if (spec.type === 'scatter' || spec.type === 'line') { const all = data.series.flatMap((s) => s.values).filter((v): v is number => v !== null); if (all.length && Math.min(...all) > 0) lo = Math.min(...all) * 0.9; }
  if (hi === lo) hi = lo + 1;
  const step = niceStep(hi - lo, 5);
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  ctx.font = '11px Inter, Arial, sans-serif';
  const axisW = horizontal ? Math.min(w * 0.3, Math.max(20, ...data.labels.map((l) => ctx.measureText(l).width)) + 8) : Math.max(...[lo, hi, (lo + hi) / 2].map((v) => ctx.measureText(fmt(v)).width)) + 10;
  const left = x + 12 + axisW; const plotRight = right - 10;
  // Подписи категорий: влезают — прямо; тесно — наклоном (как у Google), длинные — с многоточием.
  const bandGuess = (plotRight - left) / Math.max(1, data.labels.length);
  const widest = Math.max(0, ...data.labels.map((l) => ctx.measureText(l).width));
  const tilt = !horizontal && widest > bandGuess - 6;
  const tiltMax = Math.min(110, h * 0.28);
  const labelH = horizontal ? 18 : tilt ? Math.min(tiltMax, widest) * 0.6 + 14 : 20;
  const plotTop = top + 6; const plotBottom = bottom - labelH;
  const pw = Math.max(10, plotRight - left); const ph = Math.max(10, plotBottom - plotTop);
  const scale = (v: number) => (v - lo) / (hi - lo);
  // Сетка и шкала.
  ctx.strokeStyle = gridInk; ctx.lineWidth = 1; ctx.fillStyle = soft;
  for (let v = lo; v <= hi + step / 2; v += step) {
    ctx.strokeStyle = Math.abs(v) < step / 1e6 ? axisInk : gridInk;
    if (horizontal) { const gx = left + scale(v) * pw; ctx.beginPath(); ctx.moveTo(gx + 0.5, plotTop); ctx.lineTo(gx + 0.5, plotBottom); ctx.stroke(); ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(fmt(v), gx, plotBottom + 4); }
    else { const gy = plotBottom - scale(v) * ph; ctx.beginPath(); ctx.moveTo(left, gy + 0.5); ctx.lineTo(plotRight, gy + 0.5); ctx.stroke(); ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(fmt(v), left - 6, gy); }
  }
  // Подписи категорий (через одну, если не влезают).
  const band = (horizontal ? ph : pw) / Math.max(1, n);
  const every = Math.max(1, Math.ceil((horizontal ? 14 : tilt ? 16 : 48) / Math.max(1, band)));
  ctx.fillStyle = soft;
  data.labels.forEach((l, i) => {
    if (i % every) return;
    if (horizontal) { ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(fit(ctx, l, axisW - 6), left - 6, plotTop + band * (i + 0.5)); return; }
    const cx0 = left + band * (i + 0.5);
    if (!tilt) { ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(fit(ctx, l, band * every - 4), cx0, plotBottom + 6); return; }
    ctx.save(); ctx.translate(cx0, plotBottom + 6); ctx.rotate(-Math.PI / 6);
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(fit(ctx, l, tiltMax), 0, 0); ctx.restore();
  });
  const zero = scale(Math.max(lo, Math.min(hi, 0)));
  const k = data.series.length || 1;
  if (spec.type === 'column' || spec.type === 'bar') {
    const inner = Math.min(band * 0.7, stacked ? 64 : 40 * k);
    const one = stacked ? inner : inner / k;
    for (let i = 0; i < n; i += 1) {
      let pos = 0; let neg = 0;
      data.series.forEach((s, si) => {
        const v = s.values[i]; if (v === null) return;
        let a: number; let b: number;
        if (stacked) { if (v >= 0) { a = scale(pos); pos += v; b = scale(pos); } else { a = scale(neg); neg += v; b = scale(neg); } } else { a = zero; b = scale(v); }
        ctx.fillStyle = colors[si % colors.length];
        const off = (band - inner) / 2 + (stacked ? 0 : si * one);
        // Столбцы со скруглённым концом (2px), как у Google.
        const rr = Math.min(2, (one - 1) / 2);
        ctx.beginPath();
        if (horizontal) ctx.roundRect(left + Math.min(a, b) * pw, plotTop + band * i + off, Math.abs(b - a) * pw, one - 1, v >= 0 ? [0, rr, rr, 0] : [rr, 0, 0, rr]);
        else ctx.roundRect(left + band * i + off, plotBottom - Math.max(a, b) * ph, one - 1, Math.abs(b - a) * ph, v >= 0 ? [rr, rr, 0, 0] : [0, 0, rr, rr]);
        ctx.fill();
      });
    }
  } else {
    const px = (i: number) => left + band * (i + 0.5);
    const base = new Array(n).fill(0);
    data.series.forEach((s, si) => {
      const color = colors[si % colors.length];
      const pts = s.values.map((v, i) => (v === null ? null : { x: px(i), y: plotBottom - scale(stacked ? (base[i] += v) : v) * ph }));
      if (spec.type === 'scatter') { ctx.fillStyle = color; for (const p of pts) if (p) { ctx.beginPath(); ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2); ctx.fill(); } return; }
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
      let started = false;
      for (const p of pts) { if (!p) { started = false; continue; } if (started) ctx.lineTo(p.x, p.y); else { ctx.moveTo(p.x, p.y); started = true; } }
      ctx.stroke();
      if (spec.type === 'area') {
        const valid = pts.filter((p): p is { x: number; y: number } => Boolean(p));
        if (valid.length) {
          ctx.globalAlpha = 0.25; ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(valid[0].x, plotBottom - zero * ph);
          for (const p of valid) ctx.lineTo(p.x, p.y);
          ctx.lineTo(valid[valid.length - 1].x, plotBottom - zero * ph); ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
        }
      }
    });
  }
  ctx.restore();
}
