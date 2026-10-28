import { useEffect, useRef, useState } from 'react';
import type { Workbook as ExcelWorkbook } from 'exceljs';
import { createUniver, LocaleType, mergeLocales, type ICellData, type IWorkbookData } from '@univerjs/presets';
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
import '@univerjs/preset-sheets-hyper-link/lib/index.css';
import '@univerjs/preset-sheets-filter/lib/index.css';
import '@univerjs/preset-sheets-sort/lib/index.css';
import '@univerjs/preset-sheets-core/lib/index.css';
import '@univerjs/preset-sheets-find-replace/lib/index.css';
import { IRenderManagerService } from '@univerjs/engine-render';
import { SheetSkeletonManagerService } from '@univerjs/sheets-ui';
import { hideMissingFonts, isDarkTheme, keepTextOnFill, univerTheme, tagFindDialog, useUniverTheme } from '../lib/univerTheme';
import { applySnapshot, bookFromBase64, bookToBase64, excelToUniver } from '../lib/workbook';
import type { EditorProps } from './types';
import type { CursorPos, RemoteCursor } from '../useCursors';
import { bindSheet, isSharedSheetMutation } from '../live/sheetOps';
import { Spinner } from '@/shared/ui/Spinner';

/** Курсор в таблице: лист и выделенный диапазон (строки и столбцы с нуля). */
type SheetCursor = { sh: string; r1: number; c1: number; r2: number; c2: number };

type Injector = { get: <T>(token: unknown) => T };

/** Рамка коллеги в точках слоя (слой — область ячеек без заголовков строк и столбцов). */
interface CellShape { userId: string; name: string; color: string; movedAt: number; x: number; y: number; w: number; h: number }

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
function measureCells(injector: Injector, unitId: string, sheetId: string, freeze: { startRow: number; startColumn: number } | null, host: HTMLElement, cursors: RemoteCursor[]) {
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
  const hostBox = host.getBoundingClientRect();
  return { shapes, frame: { left: frame.left - hostBox.left, top: frame.top - hostBox.top, width: frame.right - frame.left, height: frame.bottom - frame.top } };
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
export default function SheetEditor({ content, onContent, readOnly, loadKey, visible = true, cursors = [], onCursor, live }: EditorProps) {
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
  const engine = useRef<{ injector: Injector; unitId: string; active: () => { sheetId: string; freeze: { startRow: number; startColumn: number } | null } } | null>(null);
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
      presets: [UniverSheetsCorePreset({ container: mount, header: !readOnly, toolbar: !readOnly, formulaBar: !readOnly, contextMenu: !readOnly, menu: {}, ribbonType: 'classic' }), UniverSheetsFindReplacePreset(), UniverSheetsHyperLinkPreset(), UniverSheetsFilterPreset(), UniverSheetsSortPreset()],
    });
    keepTextOnFill();
    univerAPI.toggleDarkMode(isDarkTheme(theme));
    univerAPI.setTheme(univerTheme(theme));
    const workbook = univerAPI.createWorkbook(excelToUniver(book));
    hideMissingFonts(univer);
    const untagFind = tagFindDialog();
    workbook.setEditable(!readOnly);

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
        return { sheetId: sheet.getSheetId(), freeze };
      },
    };
    // Фасадное событие SelectionChanged в этой сборке не приходит — слушаем саму операцию выделения (мышь, клавиши, смена листа).
    const selections = workbook.onCommandExecuted((command) => {
      if (command.id !== 'sheet.operation.set-selections') return;
      const params = command.params as { unitId?: string; subUnitId?: string; selections?: Array<{ range: { startRow: number; startColumn: number; endRow: number; endColumn: number } }> } | undefined;
      if (!params || params.unitId !== workbook.getId() || !params.subUnitId) return;
      const r = params.selections?.[params.selections.length - 1]?.range;
      const pos: SheetCursor | null = r ? { sh: params.subUnitId, r1: r.startRow, c1: r.startColumn, r2: r.endRow, c2: r.endColumn } : null;
      onCursorRef.current?.(pos as CursorPos | null);
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
    return () => {
      window.clearTimeout(readyTimer);
      unbind?.();
      // Редактор пересоздаётся (тема, просмотр ↔ правка): книга должна унести всё, включая правки коллег за последние мгновения.
      if (ready && !readOnly) { try { applySnapshot(book, workbook.save() as IWorkbookData); } catch { /* уже разобран */ } }
      window.clearTimeout(syncTimer);
      listener.dispose();
      clicks.dispose();
      selections.dispose();
      engine.current = null;
      el.removeEventListener('pointerdown', onPointer, true);
      // Univer снимает свои React-деревья синхронно; внутри фазы рендера нашего компонента React на это жалуется.
      untagFind();
      window.setTimeout(() => { univer.dispose(); mount.remove(); }, 0);
    };
  }, [book, readOnly, theme, live]);

  useEffect(() => { if (visible) window.dispatchEvent(new Event('resize')); }, [visible]);

  // Рамки коллег следят за прокруткой, масштабом и шириной столбцов: пересчёт каждый кадр, пока они есть
  // (как в документе), состояние — только если что-то сдвинулось.
  const cursorsRef = useRef(cursors);
  cursorsRef.current = cursors;
  const hasCursors = cursors.length > 0;
  useEffect(() => {
    if (!hasCursors) { setOverlay(null); return undefined; }
    let raf = 0;
    let last = '';
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (document.hidden || !engine.current || !host.current) return;
      let next: ReturnType<typeof measureCells> = null;
      try {
        const { sheetId, freeze } = engine.current.active();
        next = measureCells(engine.current.injector, engine.current.unitId, sheetId, freeze, host.current, cursorsRef.current);
      } catch { return; /* редактор пересоздаётся — сервисов между dispose и новым экземпляром нет */ }
      const key = JSON.stringify(next);
      if (key !== last) { last = key; setOverlay(next); }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hasCursors]);

  if (error) return <div className="nws-missing" role="alert">{error}</div>;
  return (
    <div className="nws-univer nws-univer-sheet" ref={host} aria-label="Редактор таблицы">
      {!book && <div className="nws-loading"><Spinner size={24} label="Открываю таблицу" /></div>}
      {overlay && overlay.shapes.length > 0 && (
        <div className="nws-cursors" style={overlay.frame} aria-hidden="true">
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
