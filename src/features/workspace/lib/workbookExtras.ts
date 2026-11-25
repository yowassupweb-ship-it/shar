import type { Worksheet } from 'exceljs';
import type { CfRule, DvRule, Group, SheetExtras } from '../sheet/extras';
import type { Range } from '../sheet/model';

/**
 * Дополнения листа (sheet/extras.ts) ↔ xlsx. Целиком они лежат своей частью файла (xl/shar/extras.json — её пишет
 * lib/workbook.ts), а то, что умеет сам формат, ещё и родными средствами, — чтобы Excel и Google Таблицы видели
 * условное форматирование, списки, заметки и группы. Файл из Excel без нашей части читается из родных структур.
 */

const col = (c: number) => { let s = ''; let n = c + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const a1 = (r: number, c: number) => `${col(c)}${r + 1}`;
const ref = (r: Range) => (r.startRow === r.endRow && r.startColumn === r.endColumn ? a1(r.startRow, r.startColumn) : `${a1(r.startRow, r.startColumn)}:${a1(r.endRow, r.endColumn)}`);
function parseCell(text: string): { row: number; col: number } | null {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)$/i.exec(text.trim());
  if (!m) return null;
  let c = 0;
  for (const ch of m[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(m[2]) - 1, col: c - 1 };
}
function parseRef(text: string): Range | null {
  const [a, b] = text.split(':');
  const p = parseCell(a); const q = b ? parseCell(b) : p;
  if (!p || !q) return null;
  return { startRow: Math.min(p.row, q.row), endRow: Math.max(p.row, q.row), startColumn: Math.min(p.col, q.col), endColumn: Math.max(p.col, q.col) };
}
const argb = (hex?: string) => (hex && /^#?[0-9a-f]{6}$/i.test(hex) ? { argb: `FF${hex.replace('#', '').toUpperCase()}` } : undefined);
const hexOf = (c?: { argb?: string } | null) => (c?.argb && /^[0-9a-f]{8}$/i.test(c.argb) ? `#${c.argb.slice(2)}` : undefined);
const quote = (s: string) => `"${String(s).replace(/"/g, '""')}"`;

// ── Условное форматирование ───────────────────────────────────────────────────────────────────────────────

const CELL_OPS: Record<string, string> = { gt: 'greaterThan', gte: 'greaterThanOrEqual', lt: 'lessThan', lte: 'lessThanOrEqual', eq: 'equal', ne: 'notEqual', between: 'between', notBetween: 'notBetween' };
const CELL_OPS_BACK = Object.fromEntries(Object.entries(CELL_OPS).map(([k, v]) => [v, k]));

function cfToExcel(rule: CfRule, priority: number): Record<string, unknown> | null {
  const first = rule.ranges[0];
  if (!first) return null;
  const tl = a1(first.startRow, first.startColumn);
  const style: Record<string, unknown> = {};
  const s = rule.style || {};
  if (s.bg) style.fill = { type: 'pattern', pattern: 'solid', bgColor: argb(s.bg) };
  const font: Record<string, unknown> = {};
  if (s.cl) font.color = argb(s.cl);
  if (s.bl) font.bold = true;
  if (s.it) font.italic = true;
  if (s.ul) font.underline = true;
  if (s.st) font.strike = true;
  if (Object.keys(font).length) style.font = font;
  const v = (rule.values || []).map((x) => (x.startsWith('=') ? x.slice(1) : /^-?\d+([.,]\d+)?$/.test(x.trim()) ? x.trim().replace(',', '.') : quote(x)));
  const text = (rule.values || [])[0] ?? '';
  switch (rule.kind) {
    case 'cell': return { type: 'cellIs', operator: CELL_OPS[rule.op || 'gt'], formulae: v.slice(0, rule.op === 'between' || rule.op === 'notBetween' ? 2 : 1), style, priority };
    case 'text':
      if (rule.op === 'contains') return { type: 'containsText', operator: 'containsText', text, formulae: [`NOT(ISERROR(SEARCH(${quote(text)},${tl})))`], style, priority };
      if (rule.op === 'notContains') return { type: 'expression', formulae: [`ISERROR(SEARCH(${quote(text)},${tl}))`], style, priority };
      if (rule.op === 'begins') return { type: 'expression', formulae: [`LEFT(${tl},LEN(${quote(text)}))=${quote(text)}`], style, priority };
      if (rule.op === 'ends') return { type: 'expression', formulae: [`RIGHT(${tl},LEN(${quote(text)}))=${quote(text)}`], style, priority };
      return { type: 'expression', formulae: [`EXACT(${tl},${quote(text)})`], style, priority };
    case 'blank': return { type: 'containsText', operator: 'containsBlanks', formulae: [`LEN(TRIM(${tl}))=0`], style, priority };
    case 'notBlank': return { type: 'containsText', operator: 'notContainsBlanks', formulae: [`LEN(TRIM(${tl}))>0`], style, priority };
    case 'formula': return { type: 'expression', formulae: [String(text).replace(/^=/, '')], style, priority };
    case 'duplicate': case 'unique': {
      const all = ref({ ...first }).replace(/([A-Z]+)(\d+)/g, '$$$1$$$2');
      return { type: 'expression', formulae: [`COUNTIF(${all},${tl})${rule.kind === 'duplicate' ? '>1' : '=1'}`], style, priority };
    }
    case 'scale': {
      const sc = rule.scale;
      if (!sc) return null;
      const pts = [sc.min, ...(sc.mid ? [sc.mid] : []), sc.max];
      return { type: 'colorScale', cfvo: pts.map((p) => ({ type: p.type, ...(p.value !== undefined ? { value: p.value } : {}) })), color: pts.map((p) => argb(p.color)), priority };
    }
    default: return null;
  }
}

function cfFromExcel(cf: { ref: string; rules: Array<Record<string, unknown>> }, n: number, unknown: unknown[]): CfRule[] {
  const ranges = cf.ref.split(/\s+/).map(parseRef).filter((r): r is Range => Boolean(r));
  if (!ranges.length) return [];
  const out: CfRule[] = [];
  cf.rules.forEach((rule, i) => {
    const style = (rule.style || {}) as { fill?: { bgColor?: { argb?: string }; fgColor?: { argb?: string } }; font?: { color?: { argb?: string }; bold?: boolean; italic?: boolean; underline?: unknown; strike?: boolean } };
    const st = {
      ...(hexOf(style.fill?.bgColor) || hexOf(style.fill?.fgColor) ? { bg: hexOf(style.fill?.bgColor) || hexOf(style.fill?.fgColor) } : {}),
      ...(hexOf(style.font?.color) ? { cl: hexOf(style.font?.color) } : {}),
      ...(style.font?.bold ? { bl: 1 as const } : {}), ...(style.font?.italic ? { it: 1 as const } : {}),
      ...(style.font?.underline ? { ul: 1 as const } : {}), ...(style.font?.strike ? { st: 1 as const } : {}),
    };
    const id = `x${n}-${i}`;
    const formulae = ((rule.formulae as unknown[]) || []).map((f) => String(f));
    const val = (f: string) => (/^".*"$/.test(f) ? f.slice(1, -1).replace(/""/g, '"') : /^-?\d+(\.\d+)?$/.test(f) ? f : `=${f}`);
    if (rule.type === 'cellIs') out.push({ id, ranges, kind: 'cell', op: CELL_OPS_BACK[String(rule.operator)] || 'eq', values: formulae.map(val), style: st });
    else if (rule.type === 'containsText' && rule.operator === 'containsBlanks') out.push({ id, ranges, kind: 'blank', style: st });
    else if (rule.type === 'containsText' && rule.operator === 'notContainsBlanks') out.push({ id, ranges, kind: 'notBlank', style: st });
    else if (rule.type === 'containsText') out.push({ id, ranges, kind: 'text', op: 'contains', values: [String(rule.text ?? '')], style: st });
    else if (rule.type === 'expression' && formulae[0]) out.push({ id, ranges, kind: 'formula', values: [`=${formulae[0]}`], style: st });
    else if (rule.type === 'colorScale') {
      const cfvo = (rule.cfvo as Array<{ type: string; value?: number }>) || [];
      const colors = ((rule.color as Array<{ argb?: string }>) || []).map((c) => hexOf(c) || '#ffffff');
      const pt = (i2: number) => ({ type: (['min', 'max', 'num', 'percent', 'percentile'].includes(cfvo[i2]?.type) ? cfvo[i2].type : i2 === 0 ? 'min' : 'max') as 'min', value: cfvo[i2]?.value, color: colors[i2] || '#ffffff' });
      if (cfvo.length >= 2) out.push({ id, ranges, kind: 'scale', scale: cfvo.length >= 3 ? { min: pt(0), mid: pt(1), max: pt(2) } : { min: pt(0), max: pt(1) } });
    } else unknown.push({ ref: cf.ref, rules: [rule] });
  });
  return out;
}

// ── Проверка данных: выпадающий список и флажок ───────────────────────────────────────────────────────────

const CHECK_VALUES = ['TRUE,FALSE', 'ИСТИНА,ЛОЖЬ'];

function dvFromExcel(model: Record<string, { type?: string; formulae?: unknown[] }>): DvRule[] {
  const groups = new Map<string, { kind: 'checkbox' | 'list'; values?: string[]; cells: Array<{ row: number; col: number }> }>();
  for (const [address, v] of Object.entries(model || {})) {
    if (v?.type !== 'list' || !v.formulae?.length) continue;
    const raw = String(v.formulae[0]);
    const list = /^".*"$/.test(raw) ? raw.slice(1, -1).split(',').map((x) => x.trim()) : null;
    if (!list) continue; // список из диапазона ячеек — пока только значения
    const kind = CHECK_VALUES.includes(list.join(',').toUpperCase()) ? 'checkbox' : 'list';
    const key = `${kind}|${list.join(',')}`;
    const cells = address.split(/\s+/).flatMap((part) => {
      const r = parseRef(part.replace(/^range:/, ''));
      if (!r) return [];
      const out: Array<{ row: number; col: number }> = [];
      for (let rr = r.startRow; rr <= r.endRow && out.length < 100000; rr += 1) for (let cc = r.startColumn; cc <= r.endColumn; cc += 1) out.push({ row: rr, col: cc });
      return out;
    });
    const g = groups.get(key) || { kind, values: kind === 'list' ? list : undefined, cells: [] };
    g.cells.push(...cells);
    groups.set(key, g);
  }
  let n = 0;
  return [...groups.values()].map((g) => {
    // Ячейки подряд в столбце — одним диапазоном.
    const byCol = new Map<number, number[]>();
    for (const c of g.cells) byCol.set(c.col, [...(byCol.get(c.col) || []), c.row]);
    const ranges: Range[] = [];
    for (const [c, rowsList] of byCol) {
      rowsList.sort((x, y) => x - y);
      let s = rowsList[0]; let prev = s;
      for (const r of rowsList.slice(1).concat([Infinity])) {
        if (r === prev + 1) { prev = r; continue; }
        ranges.push({ startRow: s, endRow: prev, startColumn: c, endColumn: c });
        s = r; prev = r;
      }
    }
    n += 1;
    return { id: `x-dv${n}`, ranges, kind: g.kind, values: g.values };
  });
}

// ── Лист целиком ──────────────────────────────────────────────────────────────────────────────────────────

/** Дополнения из родных структур xlsx (файл без нашей части — из Excel или Google). */
export function extrasFromWorksheet(ws: Worksheet): SheetExtras {
  const out: SheetExtras = {};
  const cfs = (ws as unknown as { conditionalFormattings?: Array<{ ref: string; rules: Array<Record<string, unknown>> }> }).conditionalFormattings || [];
  const unknown: unknown[] = [];
  const cf = cfs.flatMap((x, i) => cfFromExcel(x, i, unknown));
  if (cf.length) out.cf = cf;
  if (unknown.length) out.cfNative = JSON.parse(JSON.stringify(unknown));
  const dvModel = (ws as unknown as { dataValidations?: { model?: Record<string, { type?: string; formulae?: unknown[] }> } }).dataValidations?.model;
  const dv = dvModel ? dvFromExcel(dvModel) : [];
  if (dv.length) out.dv = dv;
  const notes: Record<string, string> = {};
  const rowsOl: number[] = [];
  ws.eachRow({ includeEmpty: true }, (row, n) => {
    if (row.outlineLevel) rowsOl[n - 1] = row.outlineLevel;
    row.eachCell({ includeEmpty: false }, (cell, c) => {
      const note = cell.note as unknown;
      const text = typeof note === 'string' ? note : (note as { texts?: Array<{ text?: string }> } | undefined)?.texts?.map((t) => t.text || '').join('');
      if (text) notes[`${n - 1}:${c - 1}`] = text;
    });
  });
  if (Object.keys(notes).length) out.notes = notes;
  const toGroups = (levels: number[], hidden: (i: number) => boolean): Group[] => {
    const groups: Group[] = [];
    let start = -1;
    for (let i = 0; i <= levels.length; i += 1) {
      const on = (levels[i] || 0) > 0;
      if (on && start < 0) start = i;
      if (!on && start >= 0) { groups.push({ start, end: i - 1, collapsed: hidden(start) || undefined }); start = -1; }
    }
    return groups;
  };
  const rowGroups = toGroups(rowsOl, (i) => Boolean(ws.getRow(i + 1).hidden));
  const colsOl = (ws.columns || []).map((c) => c?.outlineLevel || 0);
  const colGroups = toGroups(colsOl, (i) => Boolean(ws.getColumn(i + 1).hidden));
  if (rowGroups.length || colGroups.length) out.groups = { ...(rowGroups.length ? { rows: rowGroups } : {}), ...(colGroups.length ? { cols: colGroups } : {}) };
  return out;
}

/** Записать дополнения в родные структуры листа (условия, списки, заметки, уровни групп). */
export function extrasToWorksheet(ws: Worksheet, x: SheetExtras) {
  const target = ws as unknown as { conditionalFormattings: unknown[]; dataValidations: { model: Record<string, unknown> } };
  target.conditionalFormattings = ((x.cf || []).map((rule, i) => {
    const r = cfToExcel(rule, i + 1);
    return r ? { ref: rule.ranges.map(ref).join(' '), rules: [r] } : null;
  }).filter(Boolean) as unknown[]).concat(x.cfNative || []);
  const dv: Record<string, unknown> = {};
  for (const rule of x.dv || []) {
    const formulae = [rule.kind === 'checkbox' ? '"TRUE,FALSE"' : `"${(rule.values || []).map((v) => v.replace(/[",]/g, ' ')).join(',')}"`];
    for (const r of rule.ranges) dv[ref(r)] = { type: 'list', allowBlank: true, formulae, showErrorMessage: Boolean(rule.strict) };
  }
  // ExcelJS пишет адрес как есть: «A1:A10» он понимает как диапазон (sqref).
  target.dataValidations.model = dv;
  ws.eachRow({ includeEmpty: false }, (row) => row.eachCell({ includeEmpty: false }, (cell) => { if (cell.note) (cell as unknown as { note: unknown }).note = undefined; }));
  for (const [key, text] of Object.entries(x.notes || {})) {
    const [r, c] = key.split(':').map(Number);
    if (text) ws.getCell(r + 1, c + 1).note = text;
  }
  for (const g of x.groups?.rows || []) for (let r = g.start; r <= g.end; r += 1) ws.getRow(r + 1).outlineLevel = 1;
  for (const g of x.groups?.cols || []) for (let c = g.start; c <= g.end; c += 1) ws.getColumn(c + 1).outlineLevel = 1;
}
