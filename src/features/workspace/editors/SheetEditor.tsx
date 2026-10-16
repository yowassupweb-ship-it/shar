import { useEffect, useRef, useState } from 'react';
import type { Workbook as ExcelWorkbook } from 'exceljs';
import { createUniver, LocaleType, mergeLocales, type ICellData, type IWorkbookData } from '@univerjs/presets';
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import UniverPresetSheetsCoreRuRU from '@univerjs/preset-sheets-core/locales/ru-RU';
import { UniverSheetsFindReplacePreset } from '@univerjs/preset-sheets-find-replace';
import UniverPresetSheetsFindReplaceRuRU from '@univerjs/preset-sheets-find-replace/locales/ru-RU';
import { UniverSheetsHyperLinkPreset } from '@univerjs/preset-sheets-hyper-link';
import UniverPresetSheetsHyperLinkRuRU from '@univerjs/preset-sheets-hyper-link/locales/ru-RU';
import '@univerjs/preset-sheets-hyper-link/lib/index.css';
import '@univerjs/preset-sheets-core/lib/index.css';
import '@univerjs/preset-sheets-find-replace/lib/index.css';
import { hideMissingFonts, isDarkTheme, univerTheme, useUniverTheme } from '../lib/univerTheme';
import { applySnapshot, bookFromBase64, bookToBase64, excelToUniver } from '../lib/workbook';
import type { EditorProps } from './types';
import { Spinner } from '@/shared/ui/Spinner';

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
 * Таблица: Univer Sheets поверх книги xlsx. Формулы, форматирование ячеек, листы — как в Excel.
 * Правки складываются в книгу и уходят на сервер файлом xlsx. По ссылке «только просмотр» вместо
 * ленты и строки формул — чистый лист с вкладками.
 */
export default function SheetEditor({ content, onContent, readOnly, loadKey, visible = true }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const theme = useUniverTheme();
  const [book, setBook] = useState<ExcelWorkbook | null>(null);
  const [error, setError] = useState('');
  const sheetName = useRef('');
  const onContentRef = useRef(onContent);
  onContentRef.current = onContent;
  const contentRef = useRef(content);
  contentRef.current = content;

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
      locales: { [LocaleType.RU_RU]: mergeLocales(UniverPresetSheetsCoreRuRU, UniverPresetSheetsFindReplaceRuRU, UniverPresetSheetsHyperLinkRuRU) },
      darkMode: isDarkTheme(theme),
      theme: univerTheme(theme),
      // «Classic» держит функции в именованных группах; публичная ссылка на просмотр — читалка, а не
      // заблокированный редактор: ни ленты, ни строки формул, ни меню правки.
      presets: [UniverSheetsCorePreset({ container: mount, header: !readOnly, toolbar: !readOnly, formulaBar: !readOnly, contextMenu: !readOnly, menu: {}, ribbonType: 'classic' }), UniverSheetsFindReplacePreset(), UniverSheetsHyperLinkPreset()],
    });
    univerAPI.toggleDarkMode(isDarkTheme(theme));
    univerAPI.setTheme(univerTheme(theme));
    const workbook = univerAPI.createWorkbook(excelToUniver(book));
    hideMissingFonts(univer);
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

    let ready = false;
    const readyTimer = window.setTimeout(() => { ready = true; }, 250);
    let syncTimer = 0;
    let saving = false;
    let again = false;
    const flush = async () => {
      if (saving) { again = true; return; }
      saving = true;
      try {
        applySnapshot(book, workbook.getWorkbook().getSnapshot() as IWorkbookData);
        sheetName.current = workbook.getActiveSheet().getSheetName();
        onContentRef.current(await bookToBase64(book));
      } finally {
        saving = false;
        if (again) { again = false; void flush(); }
      }
    };
    const listener = workbook.onCommandExecuted((command) => {
      if (!ready || readOnly) return;
      // Выбор ячейки, фокус, прокрутка и пересчёт формул идут тем же командным каналом, но файл не меняют.
      if (!/^sheet\.(?:command|operation|mutation)\.(set-range-values|set-style|insert-|remove-|delete-|set-worksheet-name|move-range|hide-|show-|merge-|unmerge-|delta-column-width|delta-row-height|set-worksheet-col-width|set-worksheet-row-height|set-row-height|set-col-is-auto-width|set-row-is-auto-height|set-worksheet-row-is-auto-height|paste-col-width|set-col-auto-width)/.test(command.id)) return;
      window.clearTimeout(syncTimer);
      syncTimer = window.setTimeout(() => void flush(), 150);
    });
    return () => {
      window.clearTimeout(readyTimer);
      window.clearTimeout(syncTimer);
      listener.dispose();
      clicks.dispose();
      el.removeEventListener('pointerdown', onPointer, true);
      // Univer снимает свои React-деревья синхронно; внутри фазы рендера нашего компонента React на это жалуется.
      window.setTimeout(() => { univer.dispose(); mount.remove(); }, 0);
    };
  }, [book, readOnly, theme]);

  useEffect(() => { if (visible) window.dispatchEvent(new Event('resize')); }, [visible]);

  if (error) return <div className="nws-missing" role="alert">{error}</div>;
  return (
    <div className="nws-univer nws-univer-sheet" ref={host} aria-label="Редактор таблицы">
      {!book && <div className="nws-loading"><Spinner size={24} label="Открываю таблицу" /></div>}
    </div>
  );
}
