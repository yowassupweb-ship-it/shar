import { CommandType, ICommandService, IUndoRedoService, JSONX, type IMutationInfo, type JSONXActions } from '@univerjs/core';
import { DocSelectionManagerService, DocStateChangeManagerService, RichTextEditingMutation, transformDocumentTextRanges } from '@univerjs/docs';
import { transformLists, type LiveChannel, type LiveOp, type Transform } from './channel';

/**
 * Документ (Univer Docs) в совместной правке. Всё, что меняет документ — текст, оформление, картинки, колонтитулы, —
 * идёт одной мутацией `doc.mutation.rich-text-editing` с действиями JSONX (ot-json1 + TextX). У них есть
 * преобразование (transform), его и используем: одновременные правки в разных местах и даже в одном месте сходятся
 * у всех одинаково.
 */

const TEXT = RichTextEditingMutation.id;

type Injector = { get: <T>(token: unknown) => T };
type UndoStacks = { _undoStacks: Map<string, Array<{ undoMutations: IMutationInfo[]; redoMutations: IMutationInfo[] }>>; _redoStacks: Map<string, unknown[]> };

const actionsOf = (op: LiveOp) => op.params.actions as JSONXActions;

/** Пара правок: наша (`l`, ещё не в общем порядке) и чужая (`r`, раньше в порядке). При вставке в одно место чужая — первой. */
function pair(l: LiveOp, r: LiveOp): [LiveOp | null, LiveOp | null] {
  if (l.id !== TEXT || r.id !== TEXT) return [l, r];
  const la = actionsOf(l);
  const ra = actionsOf(r);
  const l2 = JSONX.transform(la, ra, 'right') as JSONXActions | null;
  const r2 = JSONX.transform(ra, la, 'left') as JSONXActions | null;
  return [
    l2 == null || JSONX.isNoop(l2) ? null : { id: TEXT, params: { ...l.params, actions: l2 } },
    r2 == null || JSONX.isNoop(r2) ? null : { id: TEXT, params: { ...r.params, actions: r2 } },
  ];
}

export const docTransform: Transform = (local, remote) => transformLists(local, remote, pair);

/** Из мутации — только то, что нужно другим: действия и раздел (основной текст или колонтитул). */
function toWire(params: Record<string, unknown>): LiveOp['params'] {
  return { actions: params.actions, segmentId: params.segmentId || '' };
}

/**
 * Подключить документ к каналу. Свои мутации уходят в канал; чужие применяются как «пришедшие извне»
 * (fromCollab): без записи в свою историю отмены и без переноса выделения на место чужой правки. Своё выделение
 * и своя история отмены переносятся через чужую правку — Ctrl+Z отменяет только своё и там, где оно теперь.
 */
export function bindDoc(injector: Injector, unitId: string, channel: LiveChannel, serialize: () => Promise<string>): () => void {
  const commands = injector.get<ICommandService>(ICommandService);
  const selection = injector.get<DocSelectionManagerService>(DocSelectionManagerService);
  const changes = injector.get<DocStateChangeManagerService>(DocStateChangeManagerService);
  const history = injector.get<IUndoRedoService>(IUndoRedoService) as unknown as Partial<UndoStacks>;

  const sub = commands.onCommandExecuted((command, options) => {
    if (command.type !== CommandType.MUTATION || command.id !== TEXT) return;
    if (options?.fromCollab || options?.onlyLocal) return;
    const params = command.params as Record<string, unknown> | undefined;
    if (!params || params.unitId !== unitId || !params.actions || JSONX.isNoop(params.actions as JSONXActions)) return;
    channel.local([{ id: TEXT, params: toWire(params) }]);
  });

  /**
   * Чужая правка `remote` пришла поверх нашей истории. Переносим через неё всё, что отменяет и возвращает наше:
   * сначала набор, который Univer ещё копит (он станет одним шагом отмены, как обычно), потом записи стека — от
   * верхней к нижней (каждая описана от состояния после записей выше). Раскладку страницы, запомненную в истории,
   * убираем: после чужой правки она устарела, Univer пересчитает её по действиям.
   */
  const step = (params: Record<string, unknown>, r: JSONXActions): JSONXActions | null => {
    const mine = params.actions as JSONXActions;
    params.actions = (JSONX.transform(mine, r, 'right') as JSONXActions | null) ?? [];
    if (Array.isArray(params.textRanges)) params.textRanges = transformDocumentTextRanges(r, params.textRanges, 'left');
    delete params.layoutState;
    return JSONX.transform(r, mine, 'left') as JSONXActions | null;
  };
  const redoStep = (params: Record<string, unknown>, r: JSONXActions) => {
    params.actions = (JSONX.transform(params.actions as JSONXActions, r, 'right') as JSONXActions | null) ?? [];
    if (Array.isArray(params.textRanges)) params.textRanges = transformDocumentTextRanges(r, params.textRanges, 'left');
    delete params.layoutState;
  };
  type CachedState = { undoState: Record<string, unknown>; redoState: Record<string, unknown> };
  const shiftHistory = (remote: JSONXActions) => {
    let r: JSONXActions | null = remote;
    try {
      const cache = (changes as unknown as { getStateCache: (id: string) => { history: CachedState[]; collaboration: unknown[] } }).getStateCache(unitId);
      for (let i = cache.history.length - 1; i >= 0 && r; i -= 1) {
        const state = cache.history[i];
        const next: JSONXActions | null = step(state.undoState, r);
        if (next) redoStep(state.redoState, next);
        r = next;
      }
    } catch { /* в этой сборке набор не копится — всё уже в стеке */ }
    const undo = history._undoStacks?.get(unitId);
    for (let i = (undo?.length ?? 0) - 1; i >= 0 && r; i -= 1) {
      const item = undo![i];
      let next: JSONXActions | null = r;
      for (const m of item.undoMutations) {
        if (!next) break;
        if (m.id === TEXT) next = step(m.params as Record<string, unknown>, next);
      }
      // Повтор (redo) записи применяется к состоянию после её отмены — там чужая правка уже `next`.
      if (next) for (const m of item.redoMutations) if (m.id === TEXT) redoStep(m.params as Record<string, unknown>, next);
      r = next;
    }
    // Стек «вернуть» после чужой правки устарел целиком: он описан от состояния до неё.
    const redo = history._redoStacks?.get(unitId);
    if (redo) redo.length = 0;
  };

  const apply = (ops: LiveOp[]) => {
    for (const op of ops) {
      if (op.id !== TEXT) continue;
      const actions = op.params.actions as JSONXActions;
      const info = selection.getSelectionInfo();
      if (info?.textRanges?.length) {
        selection.replaceSelectionInfoWithoutRefresh({ ...info, textRanges: transformDocumentTextRanges(actions, [...info.textRanges], 'left') });
      }
      commands.syncExecuteCommand(TEXT, {
        unitId, actions, segmentId: op.params.segmentId || '', textRanges: null, isSync: true, noHistory: true, debounce: false,
      }, { onlyLocal: true, fromCollab: true });
      shiftHistory(actions);
      if (info?.textRanges?.length) selection.refreshSelection(undefined, info.isEditing);
    }
  };

  const detach = channel.attach({ apply, serialize });
  return () => { sub.dispose(); detach(); };
}
