import { getSchema, type Editor } from '@tiptap/core';
import { Mapping, Step } from '@tiptap/pm/transform';
import { docExtensions } from '../editors/docSchema';
import type { LiveChannel, LiveOp, Transform } from './channel';

/**
 * Быстрый редактор документов (TipTap/ProseMirror) в совместной правке — тем же каналом, что и Univer (channel.ts):
 * правка — шаг ProseMirror, сервер выстраивает шаги всех в один порядок и принимает пачку только от текущей версии.
 *
 * Сведение — перебазирование, как в prosemirror-collab: пришла чужая правка, а у нас есть неподтверждённые — свои
 * шаги откатываются (обратные шаги кладём к каждой правке в момент её создания), применяется чужое, затем свои —
 * заново, отображённые через карты (с «зеркалами» откат↔повтор, чтобы позиции не терялись). Так каждый клиент
 * проходит ровно общий порядок, и документы у всех совпадают — в том числе при оформлении на пересекающихся кусках
 * и переносе строки против удаления (проверка live/pmOps.check.ts). История отмены понимает такое перебазирование
 * (метка `rebased`): Ctrl+Z отменяет своё и там, где оно теперь.
 *
 * Правка из старого редактора (Univer) — другого вида: не применяем, а открываем документ заново (канал делает это
 * сам, если apply бросает). Univer-клиент так же поступает с нашими шагами (docOps.ts).
 */

export const PM_STEP = 'pm.step';
/**
 * Настройки страницы (поля, колонтитулы, размер): не шаг текста, а замена части documentStyle. С текстом не
 * конфликтует — при переносе проходит как есть; одновременные правки одного поля — побеждает последняя по порядку.
 */
export const PM_PAGE = 'pm.page';
const isPage = (op: LiveOp) => op.id === PM_PAGE;

let schemaCache: ReturnType<typeof getSchema> | null = null;
const schema = () => (schemaCache ??= getSchema(docExtensions()));

type Json = Record<string, unknown>;
/** Перебазирование, которое редактору надо применить вместо чужой правки. */
interface Rebase {
  steps: Json[];
  /** Пары «откат ↔ повтор» в шагах steps. */
  mirrors: Array<[number, number]>;
  /** Сколько своих шагов откатили (для истории отмены). */
  rebased: number;
  /** Свои правки после перебазирования (те же объекты, что ждут отправки): им редактор допишет обратные шаги. */
  fix: LiveOp[];
  /** Номера своих перенесённых шагов в steps (по порядку fix): такой шаг может не лечь — тогда он отбрасывается. */
  own: number[];
}

/** Mapping.setMirror есть в prosemirror-transform, но скрыт из типов TipTap. */
const mirror = (mapping: Mapping, a: number, b: number) => (mapping as unknown as { setMirror: (a: number, b: number) => void }).setMirror(a, b);

const stepJson = (op: LiveOp): Json[] => {
  const p = op.params as { step?: Json; steps?: Json[]; rebase?: Rebase };
  if (p.rebase) return p.rebase.steps;
  return Array.isArray(p.steps) ? p.steps : p.step ? [p.step] : [];
};

export const pmTransform: Transform = (local, remote) => {
  // Настройки страницы с текстом не пересекаются: переносим только шаги, страницу — как есть.
  if (local.some(isPage) || remote.some(isPage)) {
    const [l, r] = pmTransform(local.filter((op) => !isPage(op)), remote.filter((op) => !isPage(op)));
    return [[...l, ...local.filter(isPage)], [...r, ...remote.filter(isPage)]];
  }
  if (!local.length || !remote.length) return [local, remote];
  // Чужой вид (Univer) — не сводим: apply бросит, и канал откроет документ заново.
  if (local.some((op) => op.id !== PM_STEP) || remote.some((op) => op.id !== PM_STEP)) return [local, remote];
  const s = schema();
  // Отброшенные свои шаги (не легли после переноса) — пустые: ничего не откатывают и не повторяют.
  local = local.filter((op) => (op.params as { step?: Json | null }).step);
  if (!local.length) return [[], remote];
  const mine = local.map((op) => ({ step: Step.fromJSON(s, (op.params as { step: Json }).step), inv: (op.params as { inv?: Json }).inv }));
  if (mine.some((m) => !m.inv)) throw new Error('У своей правки нет обратного шага — документ откроется заново');
  const inverses = mine.map((m) => Step.fromJSON(s, m.inv!));

  const mapping = new Mapping();
  const steps: Json[] = [];
  const mirrors: Array<[number, number]> = [];
  let rebased = mine.length;
  const fix: LiveOp[] = [];
  const own: number[] = [];
  for (let i = inverses.length - 1; i >= 0; i -= 1) { mapping.appendMap(inverses[i].getMap()); steps.push(inverses[i].toJSON()); }
  // Чужое — как есть (если это уже перебазирование для буфера, переносим и его зеркала со сдвигом).
  for (const op of remote) {
    const re = (op.params as { rebase?: Rebase }).rebase;
    const offset = mapping.maps.length;
    for (const json of stepJson(op)) { mapping.appendMap(Step.fromJSON(s, json).getMap()); steps.push(json); }
    if (re) {
      for (const [a, b] of re.mirrors) { mirror(mapping, offset + a, offset + b); mirrors.push([offset + a, offset + b]); }
      rebased += re.rebased;
      fix.push(...re.fix);
      own.push(...re.own.map((i) => offset + i));
    }
  }
  // Свои — заново, через карты: откат своих более поздних шагов, чужое и уже перенесённые свои.
  const out: LiveOp[] = [];
  let mapFrom = mine.length;
  for (const m of mine) {
    const mapped = m.step.map(mapping.slice(mapFrom));
    mapFrom -= 1;
    if (!mapped) continue;
    mapping.appendMap(mapped.getMap());
    const at = mapping.maps.length - 1;
    mirror(mapping, mapFrom, at);
    mirrors.push([mapFrom, at]);
    own.push(steps.length);
    steps.push(mapped.toJSON());
    const op: LiveOp = { id: PM_STEP, params: { step: mapped.toJSON() } };
    out.push(op);
    fix.push(op);
  }
  return [out, [{ id: PM_STEP, params: { rebase: { steps, mirrors, rebased, fix, own } } }]];
};

const REMOTE = 'sharRemote';

/** Применить в редакторе чужие правки (или перебазирование). Бросает, если правка не ложится — канал откроет заново. */
export function applyRemote(editor: Editor, ops: LiveOp[], onPage?: (style: Record<string, unknown>) => void): void {
  if (editor.isDestroyed) return;
  for (const op of ops) if (isPage(op)) onPage?.((op.params as { style?: Record<string, unknown> }).style || {});
  ops = ops.filter((op) => !isPage(op));
  const tr = editor.state.tr;
  let rebased = 0;
  const mirrors: Array<[number, number]> = [];
  const placed: Array<{ op: LiveOp; at: number }> = [];
  for (const op of ops) {
    if (op.id !== PM_STEP) throw new Error('Правка из старого редактора — документ откроется заново');
    const re = (op.params as { rebase?: Rebase }).rebase;
    const steps = stepJson(op);
    const ownAt = new Map((re?.own ?? []).map((index, k) => [index, re!.fix[k]]));
    const where: number[] = []; // номер шага перебазирования → номер в транзакции (-1 — отброшен)
    steps.forEach((json, index) => {
      const result = tr.maybeStep(Step.fromJSON(editor.schema, json));
      const mineOp = ownAt.get(index);
      if (!result.failed) {
        where[index] = tr.steps.length - 1;
        if (mineOp) placed.push({ op: mineOp, at: where[index] });
        return;
      }
      // Свой шаг после переноса не лёг (кусок, где он был, коллега удалил): отбрасываем, как prosemirror-collab —
      // правка уйдёт пустой и ни у кого ничего не сделает. Чужой не лёг — открыть заново надёжнее, чем разойтись.
      if (!mineOp) throw new Error(`Чужой шаг не лёг: ${result.failed}`);
      where[index] = -1;
      (mineOp.params as Json).step = null;
      delete (mineOp.params as Json).inv;
    });
    if (re) {
      rebased += re.rebased;
      for (const [a, b] of re.mirrors) if (where[a] >= 0 && where[b] >= 0) mirrors.push([where[a], where[b]]);
    }
  }
  for (const [a, b] of mirrors) mirror(tr.mapping, a, b);
  // Своим перенесённым шагам — обратные шаги (на случай следующей чужой правки, пока они ещё не подтверждены).
  for (const { op, at } of placed) (op.params as Json).inv = tr.steps[at].invert(tr.docs[at]).toJSON();
  if (!tr.docChanged) return;
  tr.setMeta(REMOTE, true).setMeta('addToHistory', false);
  if (rebased) tr.setMeta('rebased', rebased);
  editor.view.dispatch(tr);
}

/** Свои шаги транзакции — правки для канала, с обратным шагом каждого. */
export function localOps(transaction: { steps: Step[]; docs: Array<import('@tiptap/pm/model').Node> }): LiveOp[] {
  return transaction.steps.map((step, i) => ({ id: PM_STEP, params: { step: step.toJSON(), inv: step.invert(transaction.docs[i]).toJSON() } }));
}

/** Подключить редактор к каналу: свои шаги — в канал, чужие — на место. */
/** Своя правка настроек страницы — в канал (коллеги увидят новые поля сразу). */
export function pageOp(style: Record<string, unknown>): LiveOp {
  return { id: PM_PAGE, params: { style } };
}

export function bindPm(editor: Editor, channel: LiveChannel, serialize: () => Promise<string>, onPage?: (style: Record<string, unknown>) => void): () => void {
  const onTransaction = ({ transaction }: { transaction: { docChanged: boolean; steps: Step[]; docs: Array<import('@tiptap/pm/model').Node>; getMeta: (key: string) => unknown } }) => {
    if (!transaction.docChanged || transaction.getMeta(REMOTE)) return;
    channel.local(localOps(transaction));
  };
  editor.on('transaction', onTransaction as never);
  const detach = channel.attach({ apply: (ops) => applyRemote(editor, ops, onPage), serialize });
  return () => { editor.off('transaction', onTransaction as never); detach(); };
}
