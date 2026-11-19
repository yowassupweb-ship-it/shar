import { Editor } from '@tiptap/core';
import { docExtensions } from '../editors/docSchema';
import { univerToHtml } from './univerHtml';
import { pmToUniver } from './pmToUniver';

/**
 * Проверка без потерь: снимок → HTML → новый редактор → снимок. Сравнивает текст, оформление каждого символа,
 * стиль и список каждого абзаца, ссылки и картинки. Запускается из консоли разработчика на всех документах
 * (см. #704); в сборку для людей не попадает — импортируется только вручную.
 */

type Snap = Parameters<typeof pmToUniver>[1];
const KEYS = ['bl', 'it', 'ul', 'st', 'cl', 'bg', 'ff', 'fs', 'va'] as const;

function signature(ts: Record<string, unknown> | undefined): string {
  if (!ts) return '';
  const out: string[] = [];
  for (const k of KEYS) {
    const v = ts[k] as unknown;
    if (v == null) continue;
    if (k === 'ul' || k === 'st') { if ((v as { s?: number }).s) out.push(k); continue; }
    if (k === 'cl' || k === 'bg') { const rgb = String((v as { rgb?: string }).rgb || '').toLowerCase(); if (rgb && !(k === 'cl' && /^(#000000|rgb\(0,\s*0,\s*0\))$/.test(rgb))) out.push(`${k}=${rgb}`); continue; }
    if (k === 'fs') { if (Number(v) !== 11) out.push(`fs=${Number(v)}`); continue; }
    if (k === 'va') { if (Number(v) === 2 || Number(v) === 3) out.push(`va=${v}`); continue; }
    if (k === 'bl' || k === 'it') { if (v) out.push(k); continue; }
    if (k === 'ff') { out.push(`ff=${String(v).replace(/["'\s]/g, '').toLowerCase()}`); continue; }
    out.push(`${k}=${String(v)}`);
  }
  return out.join(',');
}

function perChar(snap: Snap): string[] {
  const body = (snap.body || {}) as { dataStream?: string; textRuns?: Array<{ st: number; ed: number; ts?: Record<string, unknown> }> };
  const stream = String(body.dataStream || '');
  const sig = new Array<string>(stream.length).fill('');
  for (const r of body.textRuns || []) for (let i = r.st; i < Math.min(r.ed, stream.length); i += 1) sig[i] = signature(r.ts);
  return sig;
}

export interface RoundtripReport { ok: boolean; problems: string[] }

export function roundtrip(snapshot: Snap): { back: Snap; report: RoundtripReport } {
  const html = univerToHtml(snapshot as never, { editor: true });
  const editor = new Editor({ extensions: docExtensions(), content: html, parseOptions: { preserveWhitespace: 'full' } });
  const back = pmToUniver(editor.getJSON() as never, snapshot);
  editor.destroy();

  const problems: string[] = [];
  const a = (snapshot.body || {}) as Record<string, unknown>;
  const b = (back.body || {}) as Record<string, unknown>;
  const sa = String(a.dataStream || '');
  const sb = String(b.dataStream || '');
  // Текст: служебные символы диапазонов (\x1F/\x1E) новый поток не пишет — сравниваем без них.
  // eslint-disable-next-line no-control-regex -- служебные символы потока Univer и ищем
  const clean = (s: string) => s.replace(/[\x1e\x1f]/g, '');
  if (clean(sa) !== sb) {
    let k = 0;
    const ca = clean(sa);
    while (k < ca.length && ca[k] === sb[k]) k += 1;
    problems.push(`текст расходится с ${k}: ${JSON.stringify(ca.slice(k, k + 30))} ≠ ${JSON.stringify(sb.slice(k, k + 30))}`);
  } else {
    const pa = perChar(snapshot).filter((_, i) => sa[i] !== '' && sa[i] !== '');
    const pb = perChar(back);
    let diff = 0;
    let first = -1;
    // Оформление на «\r» и «\n» Univer хранит, но не показывает — не сравниваем.
    for (let i = 0; i < sb.length; i += 1) if (sb[i] !== '\r' && sb[i] !== '\n' && pa[i] !== pb[i]) { diff += 1; if (first < 0) first = i; }
    if (diff) problems.push(`оформление расходится у ${diff} символов, первый ${first}: «${pa[first]}» ≠ «${pb[first]}» (${JSON.stringify(sb.slice(first, first + 20))})`);

    // Новый поток не пишет служебных символов диапазонов — позиции исходника пересчитываем без них.
    const shift: number[] = [];
    let removed = 0;
    for (let i = 0; i <= sa.length; i += 1) { shift[i] = i - removed; if (sa[i] === '' || sa[i] === '') removed += 1; }
    const pos = (s: Record<string, unknown>, i: number) => (s === a ? shift[i] ?? i : i);
    // Порядок абзацев в исходнике бывает не по позиции — сравниваем отсортированными.
    const paras = (s: Record<string, unknown>) => [...((s.paragraphs as Array<Record<string, unknown>>) || [])].sort((x, y) => Number(x.startIndex) - Number(y.startIndex)).map((p) => JSON.stringify([pos(s, Number(p.startIndex)), p.paragraphId, p.paragraphStyle || {}, (p.bullet as { listType?: string; nestingLevel?: number } | undefined)?.listType ?? null, (p.bullet as { nestingLevel?: number } | undefined)?.nestingLevel ?? null]));
    const xa = paras(a);
    const xb = paras(b);
    const bad = xa.findIndex((v, i) => v !== xb[i]);
    if (xa.length !== xb.length || bad >= 0) problems.push(`абзацы: ${xa.length} vs ${xb.length}; первый расходится ${bad}: ${xa[bad]} ≠ ${xb[bad]}`);

    const links = (s: Record<string, unknown>) => ((s.customRanges as Array<Record<string, unknown>>) || []).filter((r) => r.rangeType === 0)
      .map((r) => `${pos(s, Number(r.startIndex))}-${pos(s, Number(r.endIndex))}:${(r.properties as { url?: string })?.url}`).join('|');
    if (links(a) !== links(b)) problems.push(`ссылки: ${links(a).slice(0, 120)} ≠ ${links(b).slice(0, 120)}`);

    const blocks = (s: Record<string, unknown>) => ((s.customBlocks as Array<Record<string, unknown>>) || []).map((x) => `${pos(s, Number(x.startIndex))}:${x.blockId}`).join('|');
    if (blocks(a) !== blocks(b)) problems.push(`картинки: ${blocks(a)} ≠ ${blocks(b)}`);
  }
  return { back, report: { ok: !problems.length, problems } };
}
