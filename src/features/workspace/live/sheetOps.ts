import { CommandType, ICommandService, IUndoRedoService, IUniverInstanceService, type IMutationInfo, type Workbook } from '@univerjs/core';
import type { LiveChannel, LiveOp } from './channel';
import { applyShift, isSharedSheetMutation, shiftOf, type Matrix } from './sheetTransform';

// Перенос правок — в sheetTransform.ts (без Univer: им пользуется и свой редактор таблиц).
export { isSharedSheetMutation, sheetTransform } from './sheetTransform';

/** В мутациях бывают ObjectMatrix и прочие классы — в канал уходит их обычный JSON. */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, v) => (v && typeof v === 'object' && typeof (v as { getMatrix?: unknown }).getMatrix === 'function' ? (v as { getMatrix: () => unknown }).getMatrix() : v)));
}

type Injector = { get: <T>(token: unknown) => T };
type UndoStacks = { _undoStacks: Map<string, Array<{ undoMutations: IMutationInfo[]; redoMutations: IMutationInfo[] }>>; _redoStacks: Map<string, unknown[]> };

/**
 * Подключить книгу к каналу. Свои мутации — в канал, чужие — в книгу как пришедшие извне (fromCollab, onlyLocal):
 * без своей истории отмены. История отмены сдвигается вслед за чужими вставками и удалениями строк и столбцов.
 */
export function bindSheet(injector: Injector, unitId: string, channel: LiveChannel, serialize: () => Promise<string>): () => void {
  const commands = injector.get<ICommandService>(ICommandService);
  const history = injector.get<IUndoRedoService>(IUndoRedoService) as unknown as Partial<UndoStacks>;

  const sub = commands.onCommandExecuted((command, options) => {
    if (command.type !== CommandType.MUTATION || !isSharedSheetMutation(command.id)) return;
    if (options?.fromCollab || options?.onlyLocal) return;
    const params = command.params as Record<string, unknown> | undefined;
    if (!params || (params.unitId && params.unitId !== unitId)) return;
    const { unitId: _unit, trigger: _trigger, ...rest } = params;
    const wire = plain(rest) as Record<string, unknown>;
    // Номер стиля есть только в реестре этой книги — коллегам уходит само оформление.
    if (wire.cellValue && typeof wire.cellValue === 'object') {
      const styles = injector.get<IUniverInstanceService>(IUniverInstanceService).getUnit<Workbook>(unitId)?.getStyles();
      for (const cols of Object.values(wire.cellValue as Matrix)) {
        for (const cell of Object.values(cols || {})) {
          if (cell && typeof cell.s === 'string') cell.s = (styles?.get(cell.s) as Record<string, unknown> | undefined) ?? null;
        }
      }
    }
    channel.local([{ id: command.id, params: wire }]);
  });

  const shiftHistory = (op: LiveOp) => {
    const by = shiftOf(op);
    if (by) {
      for (const item of history._undoStacks?.get(unitId) ?? []) {
        for (const list of [item.undoMutations, item.redoMutations]) {
          for (let i = list.length - 1; i >= 0; i -= 1) {
            const step = list[i];
            const moved = applyShift({ id: step.id, params: step.params as Record<string, unknown> }, by, true);
            if (moved) list[i] = { ...step, params: { ...moved.params, unitId } };
            else list.splice(i, 1);
          }
        }
      }
    }
    const redo = history._redoStacks?.get(unitId);
    if (redo) redo.length = 0;
  };

  const apply = (ops: LiveOp[]) => {
    for (const op of ops) {
      // Правки своего редактора таблиц, которых нет в Univer (условия, флажки, заметки, объекты…), — пропускаем:
      // они лежат в файле и видны после перечитывания.
      if (!commands.hasCommand(op.id)) { shiftHistory(op); continue; }
      commands.syncExecuteCommand(op.id, { ...op.params, unitId }, { onlyLocal: true, fromCollab: true });
      shiftHistory(op);
    }
  };

  const detach = channel.attach({ apply, serialize });
  return () => { sub.dispose(); detach(); };
}
