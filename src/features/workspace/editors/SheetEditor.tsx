import { useEffect, useRef, useState } from 'react';
import type { Workbook as ExcelWorkbook } from 'exceljs';
import { SHEET_TOOLBAR } from '../lib/toolbarLayout';
import { createUniver, ICommandService, LocaleType, mergeLocales, type ICellData, type IWorkbookData } from '@univerjs/presets';
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import UniverPresetSheetsCoreRuRU from '@univerjs/preset-sheets-core/locales/ru-RU';
import { UniverSheetsFindReplacePreset } from '@univerjs/preset-sheets-find-replace';
import UniverPresetSheetsFindReplaceRuRU from '@univerjs/preset-sheets-find-replace/locales/ru-RU';
import { UniverSheetsHyperLinkPreset } from '@univerjs/preset-sheets-hyper-link';
import UniverPresetSheetsHyperLinkRuRU from '@univerjs/preset-sheets-hyper-link/locales/ru-RU';
import { UniverSheetsFilterPreset } from '@univerjs/preset-sheets-filter';
import UniverPresetSheetsFilterRuRU from '@univerjs/preset-sheets-filter/locales/ru-RU';
import { UniverSheetsSortPreset } from '@univerjs/preset-sheets-sort';
import UniverPresetSheetsSortRuRU from '@univerjs/preset-sheets-sort/locales/ru-RU';
// Facade интерфейса (univerAPI.createMenu) — явно, как в DocEditor: на подключение его пресетами не полагаемся.
import '@univerjs/ui/facade';
import '@univerjs/preset-sheets-hyper-link/lib/index.css';
import '@univerjs/preset-sheets-filter/lib/index.css';
import '@univerjs/preset-sheets-sort/lib/index.css';
import '@univerjs/preset-sheets-core/lib/index.css';
import '@univerjs/preset-sheets-find-replace/lib/index.css';
import { IRenderManagerService } from '@univerjs/engine-render';
import { IEditorBridgeService, SheetSkeletonManagerService, genNormalSelectionStyle } from '@univerjs/sheets-ui';
import { ThemeService } from '@univerjs/core';
import { DARK_GRIDLINES, addWebFonts, relayoutOnHostResize, stepToolbarWidth, throttleWindowResize, hideMissingFonts, holdSheetFrame, isDarkTheme, polishFilterButtons, addLinkButton, keepEditorFill, keepFillColors, univerTheme, tagFindDialog, useUniverTheme } from '../lib/univerTheme';
import { applySnapshot, bookFromBase64, bookToBase64, excelToUniver } from '../lib/workbook';
import { retireMount, takeOverWhenRendered } from '../lib/univerSwap';
import type { EditorProps } from './types';
import type { CursorPos, RemoteCursor } from '../useCursors';
import { bindSheet, isSharedSheetMutation } from '../live/sheetOps';
import { Spinner } from '@/shared/ui/Spinner';


/** Курсор в таблице: лист и выделенный диапазон (строки и столбцы с нуля). */
type SheetCursor = { sh: string; r1: number; c1: number; r2: number; c2: number };

type Injector = { get: <T>(token: unknown) => T };

/** Рамка коллеги в точках слоя (слой — область ячеек без заголовков строк и столбцов). */
interface CellShape { userId: string; name: string; color: string; movedAt: number; x: number; y: number; w: number; h: number }
/** Толщина рамки выделения, px; SelectionMoveType.MOVING — мышь ещё тянет диапазон. */
const SELECTION_STROKE = 2;
const SELECTION_FILL = 'rgba(10, 132, 255, 0.12)';
const SELECTION_MOVING = 1;
const NO_CELLS: Array<{ sheet: string; cell: string }> = [];
interface CellMark { key: string; x: number; y: number; w: number; h: number }

/** «E3» → строка и столбец с нуля. */
function a1Index(cell: string): { row: number; col: number } | null {
  const m = /^([A-Z]{1,3})(\d{1,7})$/.exec(cell.toUpperCase());
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(m[2]) - 1, col: col - 1 };
}

type Bounds = { left: number; top: number; right: number; bottom: number };
type Viewport = { viewportScrollX: number; viewportScrollY: number };
type RenderUnit = {
  scene: { getAncestorScale: () => { scaleX: number; scaleY: number }; getViewport: (key: string) => Viewport | undefined };
  engine: { getCanvasElement: () => HTMLCanvasElement | null };
  with: <T>(token: unknown) => T;
};
type Skeleton = {
  rowHeaderWidthAndMarginLeft: number;
  columnHeaderHeightAndMarginTop: number;
  getCellWithCoordByIndex: (row: number, col: number) => { startX: number; startY: number; endX: number; endY: number; isMergedMainCell?: boolean; mergeInfo?: { startX: number; startY: number; endX: number; endY: number } };
};

/**
 * Чужие выделения → рамки поверх холста. Формула та же, что у всплывашек Univer (SheetCanvasPopManagerService):
 * координаты ячейки в листе минус прокрутка своей области (закреплённые строки/столбцы не прокручиваются), с учётом
 * масштаба листа и масштаба холста.
 */
function measureCells(injector: Injector, unitId: string, sheetId: string, freeze: { startRow: number; startColumn: number } | null, host: HTMLElement, cursors: RemoteCursor[], marked: Array<{ row: number; col: number; cell: string }>) {
  const render = injector.get<{ getRenderUnitById: (id: string) => RenderUnit | null }>(IRenderManagerService).getRenderUnitById(unitId);
  const canvas = render?.engine.getCanvasElement();
  const skeleton = render?.with<{ getSkeletonParam: (id: string) => { skeleton: Skeleton } | undefined }>(SheetSkeletonManagerService).getSkeletonParam(sheetId)?.skeleton;
  if (!render || !canvas || !skeleton) return null;
  const { scaleX, scaleY } = render.scene.getAncestorScale();
  const box = canvas.getBoundingClientRect();
  const adjust = box.width / (parseFloat(canvas.style.width) || box.width);
  const viewportOf = (row: number, col: number) => {
    const fr = freeze && (freeze.startRow > 0 || freeze.startColumn > 0) ? freeze : null;
    const top = fr && row < fr.startRow;
    const left = fr && col < fr.startColumn;
    return render.scene.getViewport(top && left ? 'viewMainLeftTop' : top ? 'viewMainTop' : left ? 'viewMainLeft' : 'viewMain');
  };
  const at = (row: number, col: number): Bounds | null => {
    const vp = viewportOf(row, col);
    if (!vp) return null;
    const cell = skeleton.getCellWithCoordByIndex(row, col);
    const c = cell.isMergedMainCell && cell.mergeInfo ? cell.mergeInfo : cell;
    return {
      left: (c.startX - vp.viewportScrollX) * adjust * scaleX + box.left,
      right: (c.endX - vp.viewportScrollX) * adjust * scaleX + box.left,
      top: (c.startY - vp.viewportScrollY) * adjust * scaleY + box.top,
      bottom: (c.endY - vp.viewportScrollY) * adjust * scaleY + box.top,
    };
  };
  // Слой начинается под заголовками: рамка ячейки, уехавшей под них при прокрутке, обрезается.
  const frame = {
    left: box.left + skeleton.rowHeaderWidthAndMarginLeft * adjust * scaleX,
    top: box.top + skeleton.columnHeaderHeightAndMarginTop * adjust * scaleY,
    right: box.right,
    bottom: box.bottom,
  };
  const shapes: CellShape[] = [];
  for (const c of cursors) {
    const p = c.pos as SheetCursor;
    if (p.sh !== sheetId || ![p.r1, p.c1, p.r2, p.c2].every((n) => Number.isInteger(n) && n >= 0)) continue;
    const a = at(Math.min(p.r1, p.r2), Math.min(p.c1, p.c2));
    const b = at(Math.max(p.r1, p.r2), Math.max(p.c1, p.c2));
    if (!a || !b) continue;
    shapes.push({ userId: c.userId, name: c.name, color: c.color, movedAt: c.movedAt, x: a.left - frame.left, y: a.top - frame.top, w: b.right - a.left, h: b.bottom - a.top });
  }
  const marks: CellMark[] = [];
  for (const m of marked) {
    const box2 = at(m.row, m.col);
    if (box2) marks.push({ key: m.cell, x: box2.left - frame.left, y: box2.top - frame.top, w: box2.right - box2.left, h: box2.bottom - box2.top });
  }
  const hostBox = host.getBoundingClientRect();
  return { shapes, marks, frame: { left: frame.left - hostBox.left, top: frame.top - hostBox.top, width: frame.right - frame.left, height: frame.bottom - frame.top } };
}

/** Адрес ссылки в ячейке: гиперссылка (своя или из Excel) или сам текст ячейки, если это адрес. */
function cellUrl(cell: ICellData | null | undefined): string | null {
  const ranges = (cell?.p?.body?.customRanges || []) as Array<{ rangeType?: number; properties?: { url?: unknown } }>;
  const link = ranges.find((range) => range.rangeType === 0 && typeof range.properties?.url === 'string');
  if (link) return String(link.properties!.url);
  const text = typeof cell?.v === 'string' ? cell.v.trim() : '';
  if (/^(https?:\/\/|mailto:)\S+$/i.test(text)) return text;
  if (/^www\.\S+\.\S+$/i.test(text)) return `https://${text}`;
  return null;
}

/**
 * Таблица: Univer Sheets поверх книги xlsx. Формулы, форматирование ячеек, фильтры и сортировка, листы — как в Excel.
 * Правки складываются в книгу и уходят на сервер файлом xlsx. Вместе с коллегами (live) каждая правка ещё и сразу
 * уходит им по сокету и применяется у них на месте (live/sheetOps.ts). По ссылке «только просмотр» вместо
 * ленты и строки формул — чистый лист с вкладками.
 */
export default function SheetEditor({ content, onContent, readOnly, loadKey, visible = true, cursors = [], onCursor, live, commentsBridge, commentCells = NO_CELLS, onAddComment, onCommentCell }: EditorProps) {
  const onAddCommentRef = useRef(onAddComment);
  onAddCommentRef.current = onAddComment;
  const onCommentCellRef = useRef(onCommentCell);
  onCommentCellRef.current = onCommentCell;
  const host = useRef<HTMLDivElement>(null);
  const theme = useUniverTheme();
  const [book, setBook] = useState<ExcelWorkbook | null>(null);
  const [error, setError] = useState('');
  const sheetName = useRef('');
  const onContentRef = useRef(onContent);
  onContentRef.current = onContent;
  const contentRef = useRef(content);
  contentRef.current = content;
  const onCursorRef = useRef(onCursor);
  onCursorRef.current = onCursor;
  const engine = useRef<{ injector: Injector; unitId: string; active: () => { sheetId: string; sheetName: string; freeze: { startRow: number; startColumn: number } | null } } | null>(null);
  const [overlay, setOverlay] = useState<ReturnType<typeof measureCells>>(null);

  // Книга собирается из xlsx при открытии и при каждой подмене с сервера.
  useEffect(() => {
    let alive = true;
    setBook(null);
    setError('');
    bookFromBase64(contentRef.current)
      .then((loaded) => { if (alive) setBook(loaded); })
      .catch(() => { if (alive) setError('Не удалось прочитать файл таблицы'); });
    return () => { alive = false; };
  }, [loadKey]);

  useEffect(() => {
    const el = host.current;
    if (!el || !book) return undefined;
    const mount = window.document.createElement('div');
    mount.className = 'nws-univer-mount';
    el.appendChild(mount);
    const { univer, univerAPI } = createUniver({
      locale: LocaleType.RU_RU,
      locales: { [LocaleType.RU_RU]: mergeLocales(UniverPresetSheetsCoreRuRU, UniverPresetSheetsFindReplaceRuRU, UniverPresetSheetsHyperLinkRuRU, UniverPresetSheetsFilterRuRU, UniverPresetSheetsSortRuRU) },
      darkMode: isDarkTheme(theme),
      theme: univerTheme(theme),
      // «Classic» держит функции в именованных группах; публичная ссылка на просмотр — читалка, а не
      // заблокированный редактор: ни ленты, ни строки формул, ни меню правки.
      presets: [UniverSheetsCorePreset({ container: mount, header: !readOnly, toolbar: !readOnly, formulaBar: !readOnly, contextMenu: !readOnly, menu: SHEET_TOOLBAR, ribbonType: 'simple' }), UniverSheetsFindReplacePreset(), UniverSheetsHyperLinkPreset(), UniverSheetsFilterPreset(), UniverSheetsSortPreset()],
    });
    // Ширина строки ленты — ступенями: Univer реже перемеряет кнопки, пока тянут окно (stepToolbarWidth).
    const stopToolbarStep = stepToolbarWidth(mount);
    // Протяжка окна: холст перерисовывается не на каждый кадр (throttleWindowResize).
    const stopResizeGate = throttleWindowResize();
    keepFillColors();
    univerAPI.toggleDarkMode(isDarkTheme(theme));
    univerAPI.setTheme(univerTheme(theme));
    const data = excelToUniver(book);
    // Линии сетки в тёмной теме Univer рисует почти цветом полотна — границ ячеек не видно; берём заметнее (в файл не пишется).
    if (isDarkTheme(theme)) Object.values(data.sheets ?? {}).forEach((sheet) => { (sheet as { gridlinesColor?: string }).gridlinesColor = DARK_GRIDLINES; });
    const workbook = univerAPI.createWorkbook(data);
    addWebFonts(univerAPI);
    hideMissingFonts(univer);
    const untagFind = tagFindDialog();
    const watchSheet = (update: () => void) => {
      const listeners = [univerAPI.addEvent(univerAPI.Event.SelectionChanged, update), univerAPI.addEvent(univerAPI.Event.CommandExecuted, update)];
      return () => listeners.forEach((listener) => listener.dispose());
    };
    const stopLinkButton = readOnly ? () => undefined : addLinkButton(univer, 'sheet', () => {
      const cell = workbook.getActiveSheet().getSelection()?.getActiveRange()?.getCellData();
      return Boolean(cell && (cell.p?.body?.customRanges || []).some((range: { rangeType?: number }) => range.rangeType === 0));
    }, watchSheet);
    const stopFilterPolish = polishFilterButtons(univer);
    // «Комментарий» в контекстном меню, как в Google: панель открывается с полем нового комментария к выделенному.
    if (onAddCommentRef.current) {
      univerAPI.createMenu({ id: 'nx.comment.add', title: 'Комментарий', tooltip: 'Комментарий (Ctrl+Alt+M)', action: () => onAddCommentRef.current?.() })
        .appendTo(['contextMenu.mainArea', 'contextMenu.others']);
    }
    // Комментарии: привязка — активная ячейка (у диапазона — его первая); переход — выбрать ячейку и её лист.
    const commandsOf = () => (univer as unknown as { __getInjector: () => Injector }).__getInjector().get<ICommandService>(ICommandService);
    if (commentsBridge) {
      commentsBridge.current = {
        anchor: () => {
          const sheet = workbook.getActiveSheet();
          const range = sheet.getSelection()?.getActiveRange();
          const cell = range?.getA1Notation().split(':')[0];
          return cell ? { kind: 'cell', sheet: sheet.getSheetName(), cell } : null;
        },
        jump: (anchor) => {
          if (anchor.kind !== 'cell') return;
          const target = anchor.sheet ? workbook.getSheetByName(anchor.sheet) : null;
          if (target) workbook.setActiveSheet(target);
          workbook.getActiveSheet().getRange(anchor.cell).activate();
        },
        has: (id) => commandsOf().hasCommand(id),
        exec: (id) => {
          if (!commandsOf().hasCommand(id)) return false;
          void commandsOf().executeCommand(id);
          return true;
        },
      };
    }
    const stopEditorFill = keepEditorFill(univer, IEditorBridgeService, (row, column) => workbook.getActiveSheet().getRange(row, column).getBackground() || undefined, (row, column) => typeof workbook.getActiveSheet().getRange(row, column).getValue() === 'number');
    workbook.setEditable(!readOnly);
    // Вход в правку ячейки: пустой белый кадр редактора закрываем снимком таблицы (holdSheetFrame).
    const editStart = univerAPI.addEvent(univerAPI.Event.BeforeSheetEditStart, () => holdSheetFrame());
    // Набранное в ячейке без Enter живёт только в поле правки: уход из таблицы (клик по списку Офиса, меню, другому
    // материалу, чату) молча его терял — человек видел текст, возвращался, а его нет. Как Excel и Google Таблицы,
    // клик мимо таблицы сначала принимает набранное. Всплывающие меню самого Univer (лента, цвета) — не мимо: там
    // оформляют текст ячейки, правку не закрываем.
    const commitEdit = () => {
      if (!readOnly && workbook.isCellEditing()) void workbook.endEditingAsync(true);
    };
    const onOutside = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target || el.contains(target) || target.closest?.('[class*="univer-"], [data-u-comp]')) return;
      commitEdit();
    };
    document.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('pagehide', commitEdit);

    // Ctrl+клик по ячейке со ссылкой (или просто с адресом) — открыть в браузере, как в Excel и Google Таблицах.
    // У события клика по ячейке нет признака Ctrl — запоминаем его по нажатию.
    let ctrlClick = false;
    const onPointer = (event: PointerEvent) => { ctrlClick = event.ctrlKey || event.metaKey; };
    el.addEventListener('pointerdown', onPointer, true);
    const clicks = univerAPI.addEvent(univerAPI.Event.CellClicked, (params) => {
      if (!ctrlClick) return;
      const url = cellUrl(workbook.getActiveSheet().getRange(params.row, params.column).getCellData());
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    });
    const initial = sheetName.current ? workbook.getSheetByName(sheetName.current) : null;
    if (initial) workbook.setActiveSheet(initial);

    // Своё выделение — коллегам (useCursors), как рамка ячейки в Google Таблицах. Смена листа — тоже выделение.
    const injector = (univer as unknown as { __getInjector: () => Injector }).__getInjector();
    engine.current = {
      injector,
      unitId: workbook.getId(),
      active: () => {
        const sheet = workbook.getActiveSheet();
        const freeze = sheet.getFreeze() as { startRow: number; startColumn: number } | null;
        return { sheetId: sheet.getSheetId(), sheetName: sheet.getSheetName(), freeze };
      },
    };
    // Редактор готов — посчитать уголки и рамки: первый пересчёт приходится на загрузку, когда считать ещё нечего.
    kickOverlay.current();
    // Рамка выделения — 2 px, как у рамки правки ячейки: в 1 px она терялась на сетке и цветных заливках. Ширина — поле
    // стиля выделения; выделение без нашего стиля (мышь, клавиши) переставляем тем же диапазоном со стилем. Пока мышь
    // тянет диапазон, не вмешиваемся — стиль ставится на отпускании.
    // Выделенный диапазон слегка заливаем акцентом — видно, что выделено, текст под заливкой читается.
    const thickStyle = { ...genNormalSelectionStyle(injector.get<ThemeService>(ThemeService)), strokeWidth: SELECTION_STROKE, fill: SELECTION_FILL };
    const thickSelections = workbook.onCommandExecuted((command) => {
      if (command.id !== 'sheet.operation.set-selections') return;
      const params = command.params as { unitId?: string; type?: number; selections?: Array<{ style?: { strokeWidth?: number } | null }> } | undefined;
      if (!params?.selections?.length || params.unitId !== workbook.getId() || params.type === SELECTION_MOVING) return;
      if (params.selections.every((s) => s.style?.strokeWidth === SELECTION_STROKE)) return;
      void commandsOf().executeCommand('sheet.operation.set-selections', { ...params, selections: params.selections.map((s) => ({ ...s, style: thickStyle })) });
    });
    // Фасадное событие SelectionChanged в этой сборке не приходит — слушаем саму операцию выделения (мышь, клавиши, смена листа).
    const anyCommand = workbook.onCommandExecuted(() => kickOverlay.current());
    const selections = workbook.onCommandExecuted((command) => {
      if (command.id !== 'sheet.operation.set-selections') return;
      const params = command.params as { unitId?: string; subUnitId?: string; selections?: Array<{ range: { startRow: number; startColumn: number; endRow: number; endColumn: number } }> } | undefined;
      if (!params || params.unitId !== workbook.getId() || !params.subUnitId) return;
      const r = params.selections?.[params.selections.length - 1]?.range;
      const pos: SheetCursor | null = r ? { sh: params.subUnitId, r1: r.startRow, c1: r.startColumn, r2: r.endRow, c2: r.endColumn } : null;
      onCursorRef.current?.(pos as CursorPos | null);
      // Выбрали ячейку с открытым комментарием (кликом или клавишами) — показать его ветку в панели.
      const moving = (command.params as { type?: number }).type === SELECTION_MOVING;
      if (r && !moving && onCommentCellRef.current) {
        const sheetName = workbook.getActiveSheet().getSheetName();
        const hit = marksRef.current.find((m) => { const at = a1Index(m.cell); return at && at.row === r.startRow && at.col === r.startColumn && (!m.sheet || m.sheet === sheetName); });
        if (hit) onCommentCellRef.current({ sheet: sheetName, cell: hit.cell });
      }
    });

    // Файл xlsx собирается из снимка, взятого синхронно (workbook.save() — вместе с фильтрами): совместная правка
    // сохраняет ровно ту версию, в которой редактор был в момент вызова.
    const serialize = () => {
      applySnapshot(book, workbook.save() as IWorkbookData);
      return bookToBase64(book);
    };
    let ready = false;
    let unbind: (() => void) | null = null;
    const readyTimer = window.setTimeout(() => {
      ready = true;
      // Правки при открытии (подгонка высот, пересчёт) у каждого свои — к коллегам уходит только набранное после.
      if (live && !readOnly) unbind = bindSheet(injector, workbook.getId(), live, serialize);
      else if (live) unbind = bindSheet(injector, workbook.getId(), live, async () => contentRef.current);
    }, 250);
    let syncTimer = 0;
    let saving = false;
    let again = false;
    const flush = async () => {
      if (saving) { again = true; return; }
      saving = true;
      try {
        sheetName.current = workbook.getActiveSheet().getSheetName();
        onContentRef.current(await serialize());
      } finally {
        saving = false;
        if (again) { again = false; void flush(); }
      }
    };
    const listener = workbook.onCommandExecuted((command) => {
      // Совместная правка: файл собирает канал — после паузы для базы и по запросу для скачивания (live/channel.ts).
      if (!ready || readOnly || live) return;
      // Выбор ячейки, фокус, прокрутка и пересчёт формул идут тем же командным каналом, но файл не меняют:
      // файл меняют только мутации листа (свои и пришедшие от коллег).
      if (command.type !== 2 /* CommandType.MUTATION */ || !isSharedSheetMutation(command.id)) return;
      window.clearTimeout(syncTimer);
      syncTimer = window.setTimeout(() => void flush(), 300);
    });
    const stopTakeOver = takeOverWhenRendered(univerAPI, el, mount);
    return () => {
      window.clearTimeout(readyTimer);
      document.removeEventListener('pointerdown', onOutside, true);
      window.removeEventListener('pagehide', commitEdit);
      // Редактор закрывают не кликом (клавиши, переход по ссылке): принять набранное, пока канал ещё подключён.
      if (ready && !readOnly && workbook.isCellEditing()) {
        // То же, что endEditingAsync(true), но синхронно: DeviceInputEventType.Keyboard = 4, KeyCode.ENTER = 13.
        try { commandsOf().syncExecuteCommand('sheet.operation.set-cell-edit-visible', { eventType: 4, keycode: 13, visible: false, unitId: workbook.getId() }); } catch { /* уже разобран */ }
      }
      unbind?.();
      // Редактор пересоздаётся (тема, просмотр ↔ правка): книга должна унести всё, включая правки коллег за последние мгновения.
      if (ready && !readOnly) { try { applySnapshot(book, workbook.save() as IWorkbookData); } catch { /* уже разобран */ } }
      window.clearTimeout(syncTimer);
      listener.dispose();
      clicks.dispose();
      selections.dispose();
      anyCommand.dispose();
      thickSelections.dispose();
      editStart.dispose();
      engine.current = null;
      el.removeEventListener('pointerdown', onPointer, true);
      // Univer снимает свои React-деревья синхронно; внутри фазы рендера нашего компонента React на это жалуется.
      untagFind();
      stopEditorFill();
      stopFilterPolish();
      if (commentsBridge) commentsBridge.current = null;
      stopLinkButton();
      stopToolbarStep();
      stopResizeGate();
      // Старый экземпляр остаётся поверх нового, пока тот не отрисуется (lib/univerSwap.ts) — без пустого листа.
      stopTakeOver();
      retireMount(mount, () => univer.dispose());
    };
  }, [book, readOnly, theme, live]);

  useEffect(() => { if (visible) window.dispatchEvent(new Event('resize')); }, [visible]);
  // Размер контейнера изменился без события окна (окно развернули, свернули боковую панель, отдельное окно растянули):
  // Univer пересчитывает холст по событию resize — даём его сами, иначе холст оставался прежнего размера.
  useEffect(() => {
    const el = host.current;
    if (!el) return undefined;
    return relayoutOnHostResize(el);
  }, []);

  // Рамки коллег и уголки комментариев следят за прокруткой, масштабом, шириной столбцов и сменой листа. Пересчитываем
  // не каждый кадр (раньше цикл крутился 60 раз в секунду всё время, пока в таблице был хоть один комментарий, и грузил
  // процессор), а по событию — любой команде Univer (прокрутка и масштаб тоже команды), смене размера окна, курсоров
  // или комментариев — и ещё 300 мс после него, пока доезжает плавная прокрутка. Состояние — только если сдвинулось.
  const cursorsRef = useRef(cursors);
  cursorsRef.current = cursors;
  const hasCursors = cursors.length > 0;
  const marksRef = useRef(commentCells);
  marksRef.current = commentCells;
  const hasMarks = commentCells.length > 0;
  const kickOverlay = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (!hasCursors && !hasMarks) { kickOverlay.current = () => undefined; setOverlay(null); return undefined; }
    let raf = 0;
    let until = 0;
    let last = '';
    const tick = () => {
      raf = 0;
      if (!document.hidden && engine.current && host.current) {
        let next: ReturnType<typeof measureCells> = null;
        try {
          const { sheetId, sheetName, freeze } = engine.current.active();
          const marked = marksRef.current.filter((m) => !m.sheet || m.sheet === sheetName).flatMap((m) => { const at = a1Index(m.cell); return at ? [{ ...at, cell: m.cell }] : []; });
          next = measureCells(engine.current.injector, engine.current.unitId, sheetId, freeze, host.current, cursorsRef.current, marked);
        } catch { next = null; /* редактор пересоздаётся — сервисов между dispose и новым экземпляром нет */ }
        const key = JSON.stringify(next);
        if (key !== last) { last = key; setOverlay(next); }
      }
      if (performance.now() < until) raf = requestAnimationFrame(tick);
    };
    const kick = () => { until = performance.now() + 300; if (!raf) raf = requestAnimationFrame(tick); };
    kickOverlay.current = kick;
    kick();
    window.addEventListener('resize', kick);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', kick); kickOverlay.current = () => undefined; };
  }, [hasCursors, hasMarks]);
  // Пришли новые курсоры или комментарии — пересчитать.
  useEffect(() => { kickOverlay.current(); }, [cursors, commentCells]);

  if (error) return <div className="nws-missing" role="alert">{error}</div>;
  return (
    <div className="nws-univer nws-univer-sheet" ref={host} aria-label="Редактор таблицы">
      {!book && <div className="nws-loading"><Spinner size={24} label="Открываю таблицу" /></div>}
      {overlay && (overlay.shapes.length > 0 || overlay.marks.length > 0) && (
        <div className="nws-cursors" style={overlay.frame} aria-hidden="true">
          {overlay.marks.map((m) => <span key={m.key} className="nws-cell-mark" style={{ left: m.x, top: m.y, width: m.w, height: m.h }} />)}
          {overlay.shapes.map((s) => (
            <span key={s.userId} className="nws-cell-cursor" data-below={s.y < 18 || undefined} style={{ '--c': s.color, left: s.x, top: s.y, width: s.w, height: s.h } as React.CSSProperties}>
              <span key={s.movedAt} className="nws-cursor-flag">{s.name}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
