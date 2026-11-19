import { Editor } from '@tiptap/core';
import type { Step } from '@tiptap/pm/transform';
import type { Node } from '@tiptap/pm/model';
import { docExtensions } from '../editors/docSchema';
import { applyRemote, localOps, pmTransform } from './pmOps';
import type { LiveOp } from './channel';

/**
 * Проверка сведения (не для сборки, запускается вручную): как в канале (channel.ts take). У A одна пачка, у B —
 * пачка в пути (inflight) и набранное поверх неё (buffer). Сервер ставит A первым. B получает A: переносит inflight,
 * потом buffer, применяет перебазирование; затем его пачки уходят и A применяет их. Документы должны совпасть.
 */

function rnd(n: number) { return Math.floor(Math.random() * n); }

function randomEdit(ed: Editor): void {
  const size = ed.state.doc.content.size;
  const pos = 1 + rnd(Math.max(1, size - 2));
  const kind = rnd(6);
  const chain = ed.chain();
  try {
    if (kind <= 1) chain.insertContentAt(pos, String.fromCharCode(1072 + rnd(32)).repeat(1 + rnd(3))).run();
    else if (kind === 2 && size > 6) chain.deleteRange({ from: pos, to: Math.min(size - 1, pos + 1 + rnd(6)) }).run();
    else if (kind === 3) chain.setTextSelection(pos).splitBlock().run();
    else if (kind === 4) chain.setTextSelection({ from: pos, to: Math.min(size - 1, pos + 4) }).toggleBold().run();
    else chain.setTextSelection({ from: pos, to: Math.min(size - 1, pos + 3) }).setColor(rnd(2) ? '#ff0000' : '#0000ff').run();
  } catch { /* недопустимое место — пропуск */ }
}

function collect(ed: Editor, edits: number): LiveOp[] {
  const ops: LiveOp[] = [];
  const handler = ({ transaction }: { transaction: { docChanged: boolean; steps: Step[]; docs: Node[] } }) => {
    if (transaction.docChanged) ops.push(...localOps(transaction));
  };
  ed.on('transaction', handler as never);
  for (let i = 0; i < edits; i += 1) randomEdit(ed);
  ed.off('transaction', handler as never);
  return ops;
}

export function checkConvergence(runs = 300): { runs: number; ok: number; failures: string[] } {
  const base = '<p>Ульяновск – Тетюши – Болгар</p><p>Сбор группы в <strong>08:40</strong> у вокзала.</p><ul><li><p>Музей</p></li><li><p>Обед</p></li></ul>';
  const failures: string[] = [];
  let ok = 0;
  for (let i = 0; i < runs; i += 1) {
    const a = new Editor({ extensions: docExtensions(), content: base });
    const b = new Editor({ extensions: docExtensions(), content: base });
    try {
      const la = collect(a, 1 + rnd(3));
      const inflight = collect(b, 1 + rnd(3));
      const buffer = rnd(2) ? collect(b, 1 + rnd(2)) : [];
      // B получает A (раньше в порядке): переносит inflight, потом buffer — как channel.take.
      const [inflight2, r1] = pmTransform(inflight, la);
      const [buffer2, r2] = buffer.length ? pmTransform(buffer, r1) : [buffer, r1];
      applyRemote(b, r2);
      // A получает пачки B (уже от новой версии) как есть.
      applyRemote(a, inflight2);
      if (buffer2.length) applyRemote(a, buffer2);
      const da = JSON.stringify(a.getJSON());
      const db = JSON.stringify(b.getJSON());
      if (da === db) ok += 1;
      else if (failures.length < 5) failures.push(`${a.getText().slice(0, 80)} ≠ ${b.getText().slice(0, 80)}`);
    } catch (e) {
      if (failures.length < 5) failures.push(`ошибка: ${e instanceof Error ? e.message : e}`);
    } finally {
      a.destroy();
      b.destroy();
    }
  }
  return { runs, ok, failures };
}
