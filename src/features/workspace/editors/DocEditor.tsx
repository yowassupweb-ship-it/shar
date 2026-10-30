import { useEffect, useRef, useState } from 'react';
import { DocSelectionManagerService, UniverDocsLayoutWorkerPlugin, UniverDocsPlugin } from '@univerjs/docs';
import { DocCanvasPopManagerService, UniverDocsUIPlugin } from '@univerjs/docs-ui';
import { IRenderManagerService, UniverRenderEnginePlugin } from '@univerjs/engine-render';
import { UniverNetworkPlugin } from '@univerjs/network';
import { UniverUIPlugin } from '@univerjs/ui';
import '@univerjs/network/facade';
import { DOC_TOOLBAR } from '../lib/toolbarLayout';
import { createUniver, ICommandService, IImageIoService, LocaleType, mergeLocales, type IDocumentData, type IPresetPlugin } from '@univerjs/presets';
import UniverPresetDocsCoreRuRU from '@univerjs/preset-docs-core/locales/ru-RU';
import { UniverFindReplacePlugin } from '@univerjs/find-replace';
import FindReplaceRuRU from '@univerjs/find-replace/locale/ru-RU';
import { UniverDocsFindReplacePlugin } from '@univerjs/docs-find-replace';
import { UniverDocsDrawingPlugin, UniverDocsDrawingUIPlugin, UniverDrawingPlugin, UniverDrawingUIPlugin } from '@univerjs/preset-docs-drawing';
import UniverPresetDocsDrawingRuRU from '@univerjs/preset-docs-drawing/locales/ru-RU';
import { UniverDocsHyperLinkPreset } from '@univerjs/preset-docs-hyper-link';
import UniverPresetDocsHyperLinkRuRU from '@univerjs/preset-docs-hyper-link/locales/ru-RU';
// Facade интерфейса (univerAPI.createMenu и др.) пресет документов сам не подключает: без этого импорта метод
// появлялся, только если раньше в той же сборке загрузилась таблица.
import '@univerjs/ui/facade';
import '@univerjs/docs-ui/facade';
import '@univerjs/preset-docs-hyper-link/lib/index.css';
import '@univerjs/preset-docs-core/lib/index.css';
import '@univerjs/preset-docs-drawing/lib/index.css';
import '@univerjs/find-replace/lib/index.css';
import { UploadingImageIoService, uploadPastedImages } from '../lib/imageIo';
import { SharEmojiPicker } from '@/shared/emoji/SharEmojiPicker';
import { emptySnapshot, ensureDrawingResource, fingerprint, localizeImages, parseSnapshot, type DocSnapshot } from '../lib/docSnapshot';
import { addLinkButton, addWebFonts, docsLayoutFonts, loadLayoutFonts, relayoutOnHostResize, stepToolbarWidth, throttleWindowResize, disableBlockHandle, reserveToolbarSpace, hidePopupsUnderToolbar, docLinkProbe, hideMissingFonts, isDarkTheme, overrideComponent, styleDocSurface, univerTheme, tagFindDialog, useUniverTheme } from '../lib/univerTheme';
import { retireMount, takeOverWhenRendered } from '../lib/univerSwap';
import type { EditorProps } from './types';
import { CursorLayer, type CursorShape } from '../CursorLayer';
import { bindDoc } from '../live/docOps';
import type { CursorPos, RemoteCursor } from '../useCursors';


/** Курсор в документе: смещения в тексте, раздел (основной текст или колонтитул) и направление выделения. */
type DocCursor = { s: number; e: number; seg: string; pg: number; b: 0 | 1 };

type Injector = { get: <T>(token: unknown) => T };
const NO_QUOTES: string[] = [];

/**
 * Где в тексте документа цитаты комментариев. Цитату при сохранении нормализуют (управляющие символы → пробел,
 * пробелы склеены, обрезано по краям — DocEditor.anchor): ищем её в так же нормализованном тексте и переводим
 * найденное обратно в смещения исходного. Берём первое вхождение — как и переход к ветке (jump).
 */
function findQuotes(stream: string, quotes: string[]): Array<{ quote: string; s: number; e: number }> {
  if (!quotes.length || !stream) return [];
  let flat = '';
  const at: number[] = [];
  let space = true;
  for (let i = 0; i < stream.length; i += 1) {
    const ch = stream.charCodeAt(i) < 32 || /\s/.test(stream[i]) ? ' ' : stream[i];
    if (ch === ' ') { if (space) continue; space = true; } else space = false;
    flat += ch;
    at.push(i);
  }
  const out: Array<{ quote: string; s: number; e: number }> = [];
  for (const quote of quotes) {
    const i = quote ? flat.indexOf(quote) : -1;
    if (i >= 0) out.push({ quote, s: at[i], e: at[i + quote.length - 1] + 1 });
  }
  return out;
}

/** Чужие курсоры → точки слоя поверх холста. Univer сам учитывает прокрутку и масштаб (getRangeBounds). */
function measureCursors(injector: Injector, unitId: string, host: HTMLElement, cursors: RemoteCursor[], quotes: Array<{ s: number; e: number }> = []) {
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
  // Прокомментированный текст — подложкой, как в Google Docs.
  const marks: Array<{ x: number; y: number; w: number; h: number }> = [];
  for (const q of quotes) {
    let rects: Array<{ left: number; right: number; top: number; bottom: number }> | undefined;
    try { rects = pop.getRangeBounds({ segmentId: '', startOffset: q.s, endOffset: q.e, collapsed: false }, unitId); } catch { rects = undefined; }
    for (const r of rects ?? []) marks.push({ x: r.left - box.left, y: r.top - box.top, w: r.right - r.left, h: r.bottom - r.top });
  }
  return { shapes, marks, frame: { left: box.left - hostBox.left, top: box.top - hostBox.top, width: box.width, height: box.height } };
}

/**
 * Документ с листами A4: Univer Docs в «традиционной» раскладке (поля, разрывы страниц), как в Word и
 * Google Docs. Правка отдаёт снимок целиком, сервер хранит его как есть. Загружается отдельным куском —
 * Univer тяжёлый, и остальной Шар ради него не ждёт.
 */
/** Шрифты для раскладки в воркере: ItemView ждёт их вместе с кодом редактора (под тем же скелетоном). */
export const layoutFontsReady = loadLayoutFonts;

export default function DocEditor({ content, onContent, readOnly, loadKey, visible = true, cursors = [], onCursor, live, commentsBridge, onAddComment, commentQuotes = NO_QUOTES, onCommentQuote }: EditorProps) {
  const onCommentQuoteRef = useRef(onCommentQuote);
  onCommentQuoteRef.current = onCommentQuote;
  const quotesRef = useRef(commentQuotes);
  quotesRef.current = commentQuotes;
  /** Где сейчас цитаты в тексте (считает слой отметок) — по ним курсор в прокомментированном тексте открывает ветку. */
  const quoteSpots = useRef<Array<{ quote: string; s: number; e: number }>>([]);
  const streamRef = useRef<() => string>(() => '');
  const onAddCommentRef = useRef(onAddComment);
  onAddCommentRef.current = onAddComment;
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
    const layoutFonts = docsLayoutFonts();
    const { univer, univerAPI } = createUniver({
      locale: LocaleType.RU_RU,
      locales: { [LocaleType.RU_RU]: mergeLocales(UniverPresetDocsCoreRuRU, UniverPresetDocsDrawingRuRU, UniverPresetDocsHyperLinkRuRU, FindReplaceRuRU) },
      darkMode: isDarkTheme(theme),
      theme: univerTheme(theme),
      presets: [
        // То же, что UniverDocsCorePreset, но без движка формул: документу он не нужен, а это ~2,5 МБ кода, которые
        // грузились и выполнялись при открытии каждого документа.
        { plugins: [
          UniverNetworkPlugin, UniverDocsPlugin,
          // Раскладка (строки, страницы) — в отдельном потоке и только изменённого: иначе каждая буква пересчитывала
          // весь документ в основном потоке, и на слабом ПК печать отставала на секунду. Нужны те же веб-шрифты, что
          // у холста; пока их нет — раскладка по-старому, в основном потоке.
          ...(layoutFonts ? [[UniverDocsLayoutWorkerPlugin, {
            workerFactory: () => new Worker(new URL('../lib/docsLayout.worker.ts', import.meta.url), { type: 'module' }),
            fontFaces: layoutFonts,
          }] as IPresetPlugin] : []),
          UniverRenderEnginePlugin,
          [UniverUIPlugin, { container: mount, ribbonType: 'simple', menu: DOC_TOOLBAR, header: !readOnly, toolbar: !readOnly, contextMenu: !readOnly }],
          [UniverDocsUIPlugin, { toc: false }],
        ] },
        // Картинки: то же, что UniverDocsDrawingPreset, но вставленный файл уходит на сервер, а не в снимок base64.
        { plugins: [[UniverDrawingPlugin, { override: [[IImageIoService, { useClass: UploadingImageIoService }]] }], UniverDrawingUIPlugin, UniverDocsDrawingPlugin, UniverDocsDrawingUIPlugin] },
        // Ссылки: клик — карточка ссылки, Ctrl+клик — открыть в браузере (в приложении — в системном).
        UniverDocsHyperLinkPreset(),
      ],
    });
    // Ширина строки ленты — ступенями: Univer реже перемеряет кнопки, пока тянут окно (stepToolbarWidth).
    const stopToolbarStep = stepToolbarWidth(mount);
    // Протяжка окна: холст перерисовывается не на каждый кадр (throttleWindowResize).
    const stopResizeGate = throttleWindowResize();
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
    univerAPI.setTheme(univerTheme(theme));
    const doc = univerAPI.createDocument(ensureDrawingResource(structuredClone(initial.current)) as unknown as IDocumentData);
    styleDocSurface(univer, doc.getId(), initial.current.documentStyle?.documentFlavor === 2);
    disableBlockHandle(univer, doc.getId());
    // Парящая лента — только у редактора с лентой и у документа с листами.
    const stopToolbarSpace = !readOnly && initial.current.documentStyle?.documentFlavor !== 2
      ? reserveToolbarSpace(univer, doc.getId(), (listener) => {
        const sub = univerAPI.addEvent(univerAPI.Event.CommandExecuted, (event) => listener(event.id));
        return () => sub.dispose();
      })
      : () => undefined;
    // Карточка ссылки, уехавшей под парящую ленту, не висит над шапкой.
    const stopPopupGuard = readOnly ? () => undefined : hidePopupsUnderToolbar(el);
    addWebFonts(univerAPI);
    hideMissingFonts(univer);
    const untagFind = tagFindDialog();
    const probe = docLinkProbe(univer);
    const stopLinkButton = readOnly ? () => undefined : addLinkButton(univer, 'doc', probe.isActive, probe.watch);
    if (readOnly) void doc.getPermission().setReadOnly();

    // Своя позиция — коллегам (useCursors). Берём активный диапазон выделения.
    const injector = (univer as unknown as { __getInjector: () => Injector }).__getInjector();
    const unitId = doc.getId();
    let lastRange: { s: number; e: number } | null = null;
    // «Комментарий» в контекстном меню, как в Google: панель открывается с полем нового комментария к выделенному.
    if (onAddCommentRef.current) {
      univerAPI.createMenu({ id: 'nx.comment.add', title: 'Комментарий', tooltip: 'Комментарий (Ctrl+Alt+M)', action: () => onAddCommentRef.current?.() })
        .appendTo(['contextMenu.mainArea', 'contextMenu.others']);
    }
    engine.current = { injector, unitId };
    kickCursors.current();
    const anyCommand = univerAPI.addEvent(univerAPI.Event.CommandExecuted, () => kickCursors.current());
    // Прокрутка документа — не команда: без этого чужой курсор и подсветка комментариев стояли на месте экрана и
    // «ехали» за прокруткой. Слушаем главный вид Univer (колесо, полоса прокрутки, клавиши, касание); вид появляется
    // не сразу после создания документа — ждём его по кадрам.
    let scrollSub: { unsubscribe: () => void } | null = null;
    let scrollTries = 0;
    let scrollWait = 0;
    const watchScroll = () => {
      scrollWait = 0;
      try {
        const unit = injector.get<IRenderManagerService>(IRenderManagerService).getRenderUnitById(unitId) as unknown as
          { scene?: { getViewport: (key: string) => { onScrollAfter$: { subscribeEvent: (fn: () => void) => { unsubscribe: () => void } } } | undefined } } | null;
        const viewport = unit?.scene?.getViewport('viewMain');
        // Только subscribeEvent: emitEvent Univer оповещает своих подписчиков, обычный subscribe из rxjs молчит.
        if (viewport) { scrollSub = viewport.onScrollAfter$.subscribeEvent(() => kickCursors.current()); return; }
      } catch { /* редактор ещё не готов */ }
      if (scrollTries++ < 60) scrollWait = requestAnimationFrame(watchScroll);
    };
    watchScroll();
    const selectionSub = injector.get<{ textSelection$: { subscribe: (fn: (p: { unitId: string; textRanges?: Array<{ startOffset: number; endOffset: number; segmentId?: string; segmentPage?: number; direction?: string; isActive?: boolean }> }) => void) => { unsubscribe: () => void } } }>(DocSelectionManagerService)
      .textSelection$.subscribe((p) => {
        if (p.unitId !== unitId) return;
        const r = p.textRanges?.find((x) => x.isActive) ?? p.textRanges?.[0];
        const pos: DocCursor | null = r ? { s: r.startOffset, e: r.endOffset, seg: r.segmentId || '', pg: r.segmentPage ?? -1, b: r.direction === 'backward' ? 1 : 0 } : null;
        onCursorRef.current?.(pos as CursorPos | null);
        if (r && r.startOffset !== r.endOffset) lastRange = { s: Math.min(r.startOffset, r.endOffset), e: Math.max(r.startOffset, r.endOffset) };
        else if (r) lastRange = null;
        // Курсор встал в прокомментированный текст — показать ветку (как клик по подсвеченному тексту в Google Docs).
        if (r && r.startOffset === r.endOffset && !r.segmentId && onCommentQuoteRef.current) {
          const hit = quoteSpots.current.find((q) => r.startOffset >= q.s && r.startOffset <= q.e);
          if (hit) onCommentQuoteRef.current(hit.quote);
        }
      });

    // Комментарии: привязка — выделенный текст (последнее непустое выделение, пока курсор не поставили в другое место);
    // переход к ветке — найти цитату в тексте и выделить её.
    const streamOf = () => String((doc as unknown as { getDocumentDataModel: () => { getSnapshot: () => { body?: { dataStream?: string } } } }).getDocumentDataModel().getSnapshot()?.body?.dataStream || '');
    streamRef.current = streamOf;
    if (commentsBridge) {
      commentsBridge.current = {
        anchor: () => {
          if (!lastRange) return null;
          const quote = [...streamOf().slice(lastRange.s, lastRange.e)].map((ch) => (ch.charCodeAt(0) < 32 ? ' ' : ch)).join('').replace(/\s+/g, ' ').trim().slice(0, 300);
          return quote ? { kind: 'text', quote } : null;
        },
        jump: (anchor) => {
          if (anchor.kind !== 'text') return;
          const at = streamOf().indexOf(anchor.quote);
          if (at < 0) return;
          try {
            injector.get<DocSelectionManagerService>(DocSelectionManagerService).replaceDocRanges([{ startOffset: at, endOffset: at + anchor.quote.length }], { unitId, subUnitId: unitId }, true);
          } catch { /* документ уже разобран */ }
        },
        has: (id) => injector.get<ICommandService>(ICommandService).hasCommand(id),
        exec: (id) => {
          const commands = injector.get<ICommandService>(ICommandService);
          if (!commands.hasCommand(id)) return false;
          void commands.executeCommand(id);
          return true;
        },
      };
    }

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

    const stopTakeOver = takeOverWhenRendered(univerAPI, el, mount);
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
      anyCommand.dispose();
      cancelAnimationFrame(scrollWait);
      scrollSub?.unsubscribe();
      selectionSub.unsubscribe();
      if (commentsBridge) commentsBridge.current = null;
      engine.current = null;
      // Univer снимает свои React-деревья синхронно; внутри фазы рендера нашего компонента React на это жалуется.
      untagFind();
      stopLinkButton();
      stopToolbarSpace();
      stopPopupGuard();
      stopToolbarStep();
      stopResizeGate();
      // Старый экземпляр остаётся поверх нового, пока тот не отрисуется (lib/univerSwap.ts) — без пустого листа.
      stopTakeOver();
      retireMount(mount, () => univer.dispose());
    };
  }, [loadKey, readOnly, theme, live]);

  useEffect(() => { if (visible) window.dispatchEvent(new Event('resize')); }, [visible]);
  // Размер контейнера изменился без события окна (окно развернули, свернули боковую панель, отдельное окно растянули):
  // Univer пересчитывает холст по событию resize — даём его сами, иначе холст оставался прежнего размера.
  useEffect(() => {
    const el = host.current;
    if (!el) return undefined;
    return relayoutOnHostResize(el);
  }, []);

  // Чужие курсоры следят за прокруткой, масштабом и раскладкой. Пересчитываем по событию — любой команде Univer (правка,
  // прокрутка, масштаб), смене размера окна или самих курсоров — и ещё 300 мс после него, а не каждый кадр, пока коллеги
  // в документе (тот цикл всё время грузил процессор). Состояние меняем, только если что-то сдвинулось.
  const cursorsRef = useRef(cursors);
  cursorsRef.current = cursors;
  const hasCursors = cursors.length > 0;
  const hasQuotes = commentQuotes.length > 0;
  const kickCursors = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (!hasCursors && !hasQuotes) { kickCursors.current = () => undefined; quoteSpots.current = []; setOverlay(null); return undefined; }
    let raf = 0;
    let until = 0;
    let last = '';
    const tick = () => {
      raf = 0;
      if (!document.hidden && engine.current && host.current) {
        let next: ReturnType<typeof measureCursors> = null;
        // Редактор пересоздаётся (новая версия, смена темы) — между dispose и новым экземпляром сервисов нет.
        try {
          let stream = '';
          try { stream = streamRef.current(); } catch { stream = ''; }
          quoteSpots.current = findQuotes(stream, quotesRef.current);
          next = measureCursors(engine.current.injector, engine.current.unitId, host.current, cursorsRef.current, quoteSpots.current);
        } catch { next = null; }
        const key = JSON.stringify(next);
        if (key !== last) { last = key; setOverlay(next); }
      }
      if (performance.now() < until) raf = requestAnimationFrame(tick);
    };
    const kick = () => { until = performance.now() + 300; if (!raf) raf = requestAnimationFrame(tick); };
    kickCursors.current = kick;
    kick();
    window.addEventListener('resize', kick);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', kick); kickCursors.current = () => undefined; };
  }, [hasCursors, hasQuotes]);
  useEffect(() => { kickCursors.current(); }, [cursors, commentQuotes]);

  if (broken) return <div className="nws-missing" role="alert">Не удалось прочитать содержимое документа: файл повреждён.</div>;
  return (
    <div className="nws-univer nws-univer-doc" ref={host} aria-label="Редактор документа">
      {overlay && overlay.marks.length > 0 && (
        <div className="nws-text-marks" style={overlay.frame} aria-hidden="true">
          {overlay.marks.map((m, i) => <span key={i} style={{ left: m.x, top: m.y, width: m.w, height: m.h }} />)}
        </div>
      )}
      {overlay && <CursorLayer shapes={overlay.shapes} style={overlay.frame} />}
    </div>
  );
}
