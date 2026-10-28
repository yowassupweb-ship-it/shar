import { useEffect, useRef, useState } from 'react';
import { DocSelectionManagerService } from '@univerjs/docs';
import { DocCanvasPopManagerService } from '@univerjs/docs-ui';
import { IRenderManagerService } from '@univerjs/engine-render';
import { createUniver, IImageIoService, LocaleType, mergeLocales, type IDocumentData } from '@univerjs/presets';
import { UniverDocsCorePreset } from '@univerjs/preset-docs-core';
import UniverPresetDocsCoreRuRU from '@univerjs/preset-docs-core/locales/ru-RU';
import { UniverFindReplacePlugin } from '@univerjs/find-replace';
import FindReplaceRuRU from '@univerjs/find-replace/locale/ru-RU';
import { UniverDocsFindReplacePlugin } from '@univerjs/docs-find-replace';
import { UniverDocsDrawingPlugin, UniverDocsDrawingUIPlugin, UniverDrawingPlugin, UniverDrawingUIPlugin } from '@univerjs/preset-docs-drawing';
import UniverPresetDocsDrawingRuRU from '@univerjs/preset-docs-drawing/locales/ru-RU';
import { UniverDocsHyperLinkPreset } from '@univerjs/preset-docs-hyper-link';
import UniverPresetDocsHyperLinkRuRU from '@univerjs/preset-docs-hyper-link/locales/ru-RU';
import '@univerjs/preset-docs-hyper-link/lib/index.css';
import '@univerjs/preset-docs-core/lib/index.css';
import '@univerjs/preset-docs-drawing/lib/index.css';
import '@univerjs/find-replace/lib/index.css';
import { UploadingImageIoService, uploadPastedImages } from '../lib/imageIo';
import { SharEmojiPicker } from '@/shared/emoji/SharEmojiPicker';
import { emptySnapshot, ensureDrawingResource, fingerprint, localizeImages, parseSnapshot, type DocSnapshot } from '../lib/docSnapshot';
import { addLinkButton, disableBlockHandle, hideMissingFonts, isDarkTheme, overrideComponent, styleDocSurface, univerTheme, tagFindDialog, useUniverTheme } from '../lib/univerTheme';
import type { EditorProps } from './types';
import { CursorLayer, type CursorShape } from '../CursorLayer';
import { bindDoc } from '../live/docOps';
import type { CursorPos, RemoteCursor } from '../useCursors';

/** Курсор в документе: смещения в тексте, раздел (основной текст или колонтитул) и направление выделения. */
type DocCursor = { s: number; e: number; seg: string; pg: number; b: 0 | 1 };

type Injector = { get: <T>(token: unknown) => T };

/** Чужие курсоры → точки слоя поверх холста. Univer сам учитывает прокрутку и масштаб (getRangeBounds). */
function measureCursors(injector: Injector, unitId: string, host: HTMLElement, cursors: RemoteCursor[]) {
  const render = injector.get<{ getRenderUnitById: (id: string) => { engine: { getCanvasElement: () => HTMLCanvasElement | null } } | null }>(IRenderManagerService).getRenderUnitById(unitId);
  const canvas = render?.engine.getCanvasElement();
  if (!canvas) return null;
  const pop = injector.get<{ getRangeBounds: (range: unknown, unitId: string) => Array<{ left: number; right: number; top: number; bottom: number }> | undefined }>(DocCanvasPopManagerService);
  const hostBox = host.getBoundingClientRect();
  const box = canvas.getBoundingClientRect();
  const shapes: CursorShape[] = [];
  for (const c of cursors) {
    const p = c.pos as DocCursor;
    if (typeof p.s !== 'number' || typeof p.e !== 'number') continue;
    const collapsed = p.s === p.e;
    let rects: Array<{ left: number; right: number; top: number; bottom: number }> | undefined;
    let caretRects: typeof rects;
    try {
      const base = { segmentId: p.seg || '', segmentPage: p.pg >= 0 ? p.pg : undefined };
      rects = collapsed ? undefined : pop.getRangeBounds({ ...base, startOffset: p.s, endOffset: p.e, collapsed: false }, unitId);
      if (collapsed) caretRects = pop.getRangeBounds({ ...base, startOffset: p.s, endOffset: p.s, collapsed: true }, unitId);
    } catch { continue; /* документ у нас короче — коллега печатает то, что ещё не сохранено */ }
    // У выделения каретка — на его краю со стороны движения: свёрнутый курсор на границе абзаца Univer
    // ставит уже на следующую строку.
    const edge = rects?.length ? (p.b ? rects[0] : rects[rects.length - 1]) : undefined;
    const caret = edge ? { ...edge, left: p.b ? edge.left : edge.right } : caretRects?.[0];
    shapes.push({
      userId: c.userId, name: c.name, color: c.color, movedAt: c.movedAt,
      caret: caret ? { x: caret.left - box.left, y: caret.top - box.top, h: Math.max(12, caret.bottom - caret.top) } : null,
      boxes: (rects ?? []).map((r) => ({ x: r.left - box.left, y: r.top - box.top, w: r.right - r.left, h: r.bottom - r.top })),
    });
  }
  return { shapes, frame: { left: box.left - hostBox.left, top: box.top - hostBox.top, width: box.width, height: box.height } };
}

/**
 * Документ с листами A4: Univer Docs в «традиционной» раскладке (поля, разрывы страниц), как в Word и
 * Google Docs. Правка отдаёт снимок целиком, сервер хранит его как есть. Загружается отдельным куском —
 * Univer тяжёлый, и остальной Шар ради него не ждёт.
 */
export default function DocEditor({ content, onContent, readOnly, loadKey, visible = true, cursors = [], onCursor, live }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const theme = useUniverTheme();
  const initial = useRef<DocSnapshot>(parseSnapshot(content) ?? emptySnapshot());
  const lastPrint = useRef(fingerprint(initial.current));
  const onContentRef = useRef(onContent);
  onContentRef.current = onContent;
  const [broken, setBroken] = useState(false);
  const onCursorRef = useRef(onCursor);
  onCursorRef.current = onCursor;
  const engine = useRef<{ injector: Injector; unitId: string } | null>(null);
  const [overlay, setOverlay] = useState<ReturnType<typeof measureCursors>>(null);

  // Новая версия с сервера: пересобираем редактор из неё.
  useEffect(() => {
    const next = parseSnapshot(content);
    setBroken(!next && Boolean(content.trim()));
    initial.current = next ?? emptySnapshot();
    lastPrint.current = fingerprint(initial.current);
  }, [loadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = host.current;
    if (!el) return undefined;
    // Свой узел на каждый экземпляр: Univer размонтирует деревья не сразу, и очистка общего контейнера
    // до этого давала «removeChild: узел не является потомком».
    const mount = window.document.createElement('div');
    mount.className = 'nws-univer-mount';
    el.appendChild(mount);
    const { univer, univerAPI } = createUniver({
      locale: LocaleType.RU_RU,
      locales: { [LocaleType.RU_RU]: mergeLocales(UniverPresetDocsCoreRuRU, UniverPresetDocsDrawingRuRU, UniverPresetDocsHyperLinkRuRU, FindReplaceRuRU) },
      darkMode: isDarkTheme(theme),
      theme: univerTheme(theme),
      presets: [
        UniverDocsCorePreset({ container: mount, ribbonType: 'classic', toc: false, header: !readOnly, toolbar: !readOnly, contextMenu: !readOnly }),
        // Картинки: то же, что UniverDocsDrawingPreset, но вставленный файл уходит на сервер, а не в снимок base64.
        { plugins: [[UniverDrawingPlugin, { override: [[IImageIoService, { useClass: UploadingImageIoService }]] }], UniverDrawingUIPlugin, UniverDocsDrawingPlugin, UniverDocsDrawingUIPlugin] },
        // Ссылки: клик — карточка ссылки, Ctrl+клик — открыть в браузере (в приложении — в системном).
        UniverDocsHyperLinkPreset(),
      ],
    });
    // Поиск по документу (Ctrl+F): официальные плагины Univer. Регистрируем до создания документа.
    univer.registerPlugin(UniverFindReplacePlugin);
    univer.registerPlugin(UniverDocsFindReplacePlugin);
    // Ctrl+F: когда фокус внутри документа, поиск открывает сам Univer; из любого другого места страницы
    // (название, шапка, пустое поле вокруг) открываем его здесь, а не отдаём системному поиску.
    const onFindKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.code !== 'KeyF') return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('.nws-univer, [data-u-comp="find-replace-dialog"]')) return;
      event.preventDefault();
      void univerAPI.executeCommand('ui.operation.open-find-dialog');
    };
    window.addEventListener('keydown', onFindKey);
    // «Вставка → Эмодзи»: выбор из набора Шара (те же эмодзи, что в чате) вместо встроенного набора Univer.
    // Univer вызывает компонент с onChange(emoji) и сам вставляет выбранное в позицию курсора.
    const restoreEmoji = overrideComponent(
      univer,
      'ui.emoji-picker',
      () => (
        <div className="nem-host">
          <SharEmojiPicker
            autoFocus={false}
            onPick={(emoji) => {
              // Вставляем сами, а не через onChange панели Univer: так видно, получилось ли (нет выделения — не получилось).
              void univerAPI.executeCommand('doc.command.insert-special-character', { value: emoji });
            }}
          />
        </div>
      ),
    );
    const stopPasteUpload = uploadPastedImages(univer);
    univerAPI.toggleDarkMode(isDarkTheme(theme));
    if (!readOnly) addLinkButton(univerAPI, 'doc');
    univerAPI.setTheme(univerTheme(theme));
    const doc = univerAPI.createDocument(ensureDrawingResource(structuredClone(initial.current)) as unknown as IDocumentData);
    styleDocSurface(univer, doc.getId(), initial.current.documentStyle?.documentFlavor === 2);
    disableBlockHandle(univer, doc.getId());
    hideMissingFonts(univer);
    const untagFind = tagFindDialog();
    if (readOnly) void doc.getPermission().setReadOnly();

    // Своя позиция — коллегам (useCursors). Берём активный диапазон выделения.
    const injector = (univer as unknown as { __getInjector: () => Injector }).__getInjector();
    const unitId = doc.getId();
    engine.current = { injector, unitId };
    const selectionSub = injector.get<{ textSelection$: { subscribe: (fn: (p: { unitId: string; textRanges?: Array<{ startOffset: number; endOffset: number; segmentId?: string; segmentPage?: number; direction?: string; isActive?: boolean }> }) => void) => { unsubscribe: () => void } } }>(DocSelectionManagerService)
      .textSelection$.subscribe((p) => {
        if (p.unitId !== unitId) return;
        const r = p.textRanges?.find((x) => x.isActive) ?? p.textRanges?.[0];
        const pos: DocCursor | null = r ? { s: r.startOffset, e: r.endOffset, seg: r.segmentId || '', pg: r.segmentPage ?? -1, b: r.direction === 'backward' ? 1 : 0 } : null;
        onCursorRef.current?.(pos as CursorPos | null);
      });

    // Правки текста, форматирования и полей страницы идут мутациями; мутация без реальной разницы
    // (фокус, выделение) отсеивается сравнением с сохранённым отпечатком.
    let ready = false;
    let unbind: (() => void) | null = null;
    const serialize = async () => JSON.stringify(localizeImages(doc.save() as unknown as DocSnapshot));
    const readyTimer = window.setTimeout(() => {
      ready = true;
      // Совместная правка: свои правки — коллегам сразу, их правки — сюда на место (live/docOps.ts).
      if (live) unbind = bindDoc(injector, unitId, live, serialize);
    }, 300);
    let syncTimer = 0;
    const subscription = univerAPI.addEvent(univerAPI.Event.CommandExecuted, (event) => {
      // Совместная правка: снимок собирает канал — после паузы для базы и по запросу для скачивания.
      if (!ready || readOnly || live || !event.id.startsWith('doc.mutation.')) return;
      window.clearTimeout(syncTimer);
      syncTimer = window.setTimeout(() => {
        const snapshot = localizeImages(doc.save() as unknown as DocSnapshot);
        const print = fingerprint(snapshot);
        if (print === lastPrint.current) return;
        lastPrint.current = print;
        onContentRef.current(JSON.stringify(snapshot));
      }, 250);
    });

    return () => {
      window.removeEventListener('keydown', onFindKey);
      restoreEmoji();
      stopPasteUpload();
      window.clearTimeout(readyTimer);
      window.clearTimeout(syncTimer);
      unbind?.();
      // Пересоздание (тема, просмотр ↔ правка) открывает документ из initial — пусть в нём будет всё, что уже есть.
      if (ready) { try { initial.current = localizeImages(doc.save() as unknown as DocSnapshot); } catch { /* уже разобран */ } }
      subscription.dispose();
      selectionSub.unsubscribe();
      engine.current = null;
      // Univer снимает свои React-деревья синхронно; внутри фазы рендера нашего компонента React на это жалуется.
      untagFind();
      window.setTimeout(() => { univer.dispose(); mount.remove(); }, 0);
    };
  }, [loadKey, readOnly, theme, live]);

  useEffect(() => { if (visible) window.dispatchEvent(new Event('resize')); }, [visible]);

  // Чужие курсоры следят за прокруткой, масштабом и раскладкой: пересчитываем каждый кадр, пока они есть,
  // а состояние меняем, только если что-то сдвинулось.
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
      let next: ReturnType<typeof measureCursors> = null;
      // Редактор пересоздаётся (новая версия, смена темы) — между dispose и новым экземпляром сервисов нет.
      try { next = measureCursors(engine.current.injector, engine.current.unitId, host.current, cursorsRef.current); } catch { return; }
      const key = JSON.stringify(next);
      if (key !== last) { last = key; setOverlay(next); }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hasCursors]);

  if (broken) return <div className="nws-missing" role="alert">Не удалось прочитать содержимое документа: файл повреждён.</div>;
  return (
    <div className="nws-univer nws-univer-doc" ref={host} aria-label="Редактор документа">
      {overlay && <CursorLayer shapes={overlay.shapes} style={overlay.frame} />}
    </div>
  );
}
