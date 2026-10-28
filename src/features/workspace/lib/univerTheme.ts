import { useEffect, useState } from 'react';
import { DocParagraphMenuService } from '@univerjs/docs-ui';
import { ComponentManager, IFontService } from '@univerjs/ui';
import { BehaviorSubject } from 'rxjs';
import { DocSelectionManagerService } from '@univerjs/docs';
import { IUniverInstanceService, UniverInstanceType } from '@univerjs/core';
import { IMenuManagerService, MenuItemType, RibbonStartGroup } from '@univerjs/ui';
import { Background, Font, IRenderManagerService, Rect, UniverRenderingContext2D } from '@univerjs/engine-render';
import { DOCS_NORMAL_EDITOR_UNIT_ID_KEY } from '@univerjs/core';
import { IEditorBridgeService } from '@univerjs/sheets-ui';
import { defaultTheme, type Theme } from '@univerjs/themes';

/**
 * Univer рисует на собственном canvas, поэтому токенов Шара ему недостаточно: тему интерфейса
 * (light | gray | graphite | black) переводим в его палитру и следим за её сменой.
 */
/** Univer рисуется тёмным только в Графите и Чёрной; Серая — светлая тема. */
export const isDarkTheme = (theme: string) => theme === 'graphite' || theme === 'black';

export function univerTheme(theme: string): Theme {
  const base = defaultTheme;
  if (!isDarkTheme(theme)) return base;
  if (theme === 'black') {
    return { ...base, gray: { ...base.gray, 700: '#17181b', 800: '#101013', 900: '#0b0b0d' } };
  }
  return {
    ...base,
    // Контур активного диапазона берёт .600 универсальной палитры: небесный тон остаётся
    // заметным на графитовом полотне, не превращая таблицу в неоновую сетку.
    primary: { ...base.primary, 400: '#237ed0', 500: '#3194ee', 600: '#52adff', 700: '#8cc9ff', 800: '#b9ddff', 900: '#e3f1ff' },
    gray: {
      ...base.gray,
      0: '#f5f5f7', 50: '#eceef1', 100: '#dce0e5', 200: '#c5cad2', 300: '#9ba3ae', 400: '#7b838e',
      500: '#5e6670', 600: '#454b53', 700: '#34383e', 800: '#2a2b2f', 900: '#242529',
    },
  };
}

// ── Закрашенные ячейки в тёмной теме ─────────────────────────────────────────
// Univer в тёмной теме инвертирует каждый цвет холста: жёлтая заливка темнеет до оливковой, а текст автора
// на ней становится белым. Покрашенную ячейку автор раскрашивал под светлый лист — поэтому и заливку, и текст
// в ней рисуем как есть, одинаково в светлой и тёмной теме. Темнеют только непокрашенные ячейки.
// Чистый белый считаем «не покрашено»: в импортированных таблицах им часто залито всё подряд.
type Rgb = [number, number, number];

function parseColor(color: unknown): Rgb | null {
  if (typeof color !== 'string') return null;
  const hex = color.trim().match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (hex) {
    const full = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    const value = parseInt(full, 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  }
  const rgb = color.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

/** Ячейка закрашена настоящим цветом (не пусто и не белая заливка по умолчанию). */
function isPainted(fill: unknown): boolean {
  if (typeof fill !== 'string' || !fill || /^(transparent|white|auto)$/i.test(fill.trim())) return false;
  const rgb = parseColor(fill);
  return !rgb || !(rgb[0] === 255 && rgb[1] === 255 && rgb[2] === 255);
}

type ColorService = { getRenderColor: (color: string) => string };
type CanvasCtx = { _canvasColorService?: ColorService };
type CellFont = { style?: { bg?: { rgb?: string } } } | undefined;
type Patched = { __keepFills?: boolean };

/** Выполнить отрисовку с отключённой тёмной инверсией цветов (белая заливка по-прежнему темнеет). */
function withoutInversion<T>(ctx: CanvasCtx, draw: () => T, keepWhite = false): T {
  const service = ctx._canvasColorService;
  if (!service) return draw();
  ctx._canvasColorService = keepWhite
    ? { getRenderColor: (color: string) => (isPainted(color) ? color : service.getRenderColor(color)) }
    : undefined;
  try { return draw(); } finally { ctx._canvasColorService = service; }
}

/** Один раз на страницу: подменяем отрисовку заливки и текста ячеек у Univer (см. выше). Светлой темы не касается. */
export function keepFillColors() {
  const font = Font.prototype as unknown as Patched & { _renderFontEachCell: (...args: unknown[]) => boolean };
  if (font.__keepFills) return;
  font.__keepFills = true;
  const renderCell = font._renderFontEachCell;
  font._renderFontEachCell = function patched(this: unknown, ...args: unknown[]) {
    const [renderCtx, row, col, matrix, cached] = args as [
      { ctx?: CanvasCtx } | undefined, number, number, { getValue?: (r: number, c: number) => CellFont } | undefined, CellFont,
    ];
    const ctx = renderCtx?.ctx;
    const fill = (cached ?? matrix?.getValue?.(row, col))?.style?.bg?.rgb;
    if (ctx && isPainted(fill)) return withoutInversion(ctx, () => renderCell.apply(this, args));
    return renderCell.apply(this, args);
  };

  const background = Background.prototype as unknown as { draw: (ctx: CanvasCtx, ...rest: unknown[]) => void };
  const drawFills = background.draw;
  background.draw = function patched(this: unknown, ctx: CanvasCtx, ...rest: unknown[]) {
    return withoutInversion(ctx, () => drawFills.call(this, ctx, ...rest), true);
  };
}

// Редактор ячейки — отдельный холст Univer: пока правишь покрашенную ячейку, на нём заливка и текст тоже рисуются
// как есть (иначе ячейка в режиме правки вдруг «тускнела»). Холст редактора лежит в [data-u-comp="editor"];
// цвета инвертируются в сеттерах fillStyle/strokeStyle контекста — на время правки такой ячейки они пропускают
// цвет без изменений.
let plainEditor = false;
let contextPatched = false;
type ColorSetterOwner = { canvas?: HTMLCanvasElement; _context?: { fillStyle: unknown; strokeStyle: unknown } };

function patchEditorContext() {
  if (contextPatched) return;
  contextPatched = true;
  const proto = UniverRenderingContext2D.prototype as object;
  for (const key of ['fillStyle', 'strokeStyle'] as const) {
    const original = Object.getOwnPropertyDescriptor(proto, key);
    if (!original?.set) continue;
    Object.defineProperty(proto, key, {
      ...original,
      set(this: ColorSetterOwner, value: unknown) {
        if (plainEditor && this._context && this.canvas?.closest?.('[data-u-comp="editor"]')) { this._context[key] = value; return; }
        original.set!.call(this, value);
      },
    });
  }
}

/** Подписка на правку ячейки: покрашенная — рисуем редактор без инверсии. Возвращает отписку. */
export function keepEditorFill(univer: unknown, cellFill?: (row: number, column: number) => string | undefined): () => void {
  patchEditorContext();
  const injector = (univer as { __getInjector: () => { get: <T>(token: unknown) => T } }).__getInjector();
  const bridge = injector.get<IEditorBridgeService>(IEditorBridgeService);
  const renders = injector.get<IRenderManagerService>(IRenderManagerService);
  let editing = false;
  const sub = bridge.currentEditCellState$.subscribe((state) => {
    // Заливка в первом событии правки ещё не известна (приходит вторым): берём её у самой ячейки, чтобы переключить
    // цвета до первой отрисовки редактора, а не перерисовывать его уже после (это тоже было видно как мигание).
    let fill: unknown = state?.documentLayoutObject?.fill;
    if (!fill && state && cellFill) { try { fill = cellFill(state.row, state.column); } catch { fill = undefined; } }
    const painted = isPainted(fill);
    const started = Boolean(state) && !editing;
    editing = Boolean(state);
    if (painted !== plainEditor) {
      plainEditor = painted;
      // Правка уже идёт и нарисована в прежних цветах — перерисовать; при входе в правку рисовать ещё нечего.
      if (!started) { try { (renders.getRenderUnitById(DOCS_NORMAL_EDITOR_UNIT_ID_KEY) as unknown as { scene?: { makeDirty: (dirty?: boolean) => void } } | null)?.scene?.makeDirty(true); } catch { /* редактор ещё не создан */ } }
    }
  });
  return () => { sub.unsubscribe(); plainEditor = false; };
}

const currentTheme = () => document.documentElement.dataset.theme || 'light';

/** Тема интерфейса: редакторы Univer пересобираются при её смене. */
export function useUniverTheme(): string {
  const [theme, setTheme] = useState(currentTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

type DocBackground = { setFillColors?: (...colors: Array<string | undefined>) => void; render?: (ctx: unknown, bounds?: unknown) => unknown; _noMarginMarks?: boolean };

/** Скругление углов листа, px документа (масштабируется вместе с ним). */
const PAGE_RADIUS = 6;

// Токены темы объявлены на корне приложения (.nx), а не на <html>: оттуда и читаем, иначе цвета пустые
// и документ остаётся чёрным (так было в графитовой теме).
const cssColor = (name: string) => getComputedStyle(document.querySelector('.nx') ?? document.documentElement).getPropertyValue(name).trim() || undefined;

/**
 * В тёмной теме Univer перекрашивает цвета холста фильтром «инверсия + поворот оттенка на 180°». Чтобы на экране
 * вышел нужный цвет, отдаём ему обратный: поворот на 180° сам себе обратен, поэтому достаточно 255 − (поворот цвета).
 */
function forDarkCanvas(color: string | undefined) {
  const match = color?.match(/^#([0-9a-f]{6})$/i);
  if (!match) return color;
  const value = parseInt(match[1], 16);
  const [r, g, b] = [16, 8, 0].map((shift) => (value >> shift) & 255);
  const rotated = [-0.574 * r + 1.43 * g + 0.144 * b, 0.426 * r + 0.43 * g + 0.144 * b, 0.426 * r + 1.43 * g - 0.856 * b];
  return `#${rotated.map((c) => Math.round(255 - Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Слой фона листа: убираем «уголки» по краям полей (Word-рамка поверх документа выглядит мусором) и красим
 * полотно под тему. В тёмной теме Univer по умолчанию заливает документ чисто чёрным — берём цвета карточки
 * и «утопленного» фона интерфейса.
 */
export function styleDocSurface(univer: unknown, unitId: string, modern: boolean) {
  const injector = (univer as { __getInjector: () => { get: <T>(token: unknown) => T } }).__getInjector();
  let tries = 0;
  const apply = () => {
    let unit: { components?: Map<string, DocBackground> } | null;
    // Документ закрыли раньше, чем появился его фон: редактор разобран — красить нечего.
    try { unit = injector.get<IRenderManagerService>(IRenderManagerService).getRenderUnitById(unitId) as unknown as typeof unit; } catch { return; }
    const background = unit?.components?.get('__Document_Render_Background__');
    if (!background?.setFillColors) { if (tries++ < 60) window.requestAnimationFrame(apply); return; }
    if (background._noMarginMarks) return;
    const dark = isDarkTheme(currentTheme());
    const shownPage = dark ? cssColor('--container-bg') : undefined;
    const shownWorkspace = dark ? (modern ? shownPage : cssColor('--bg-sunken')) : undefined;
    const page = forDarkCanvas(shownPage);
    const original = background.setFillColors.bind(background);
    // Подложку вокруг листа в тёмной теме даёт CSS-фон холста (ниже), а свою заливку Univer рисует прозрачной:
    // пересчёт цветов тёмной темы давал ей чуть другой оттенок, и от левого края листа вниз шла граница.
    background.setFillColors = (fill, pageFill, stroke) => original(shownWorkspace ? 'transparent' : fill, page ?? pageFill, stroke, 'transparent');
    background._noMarginMarks = true;
    background.setFillColors(undefined, undefined, undefined);
    // Углы листа: Univer рисует страницу через Rect.drawWith без радиуса, хотя Rect его умеет. На время отрисовки
    // фона листа подставляем радиус прямоугольнику страницы (его отличает zIndex 3 и обводка 1px).
    // Оборачиваем render: это вход отрисовки компонента (draw он зовёт не напрямую).
    const draw = background.render?.bind(background);
    if (draw) {
      background.render = (ctx, bounds) => {
        const drawWith = Rect.drawWith;
        Rect.drawWith = ((c: unknown, props: { zIndex?: number; strokeWidth?: number; radius?: number }) =>
          drawWith.call(Rect, c as never, (props?.zIndex === 3 && props.strokeWidth === 1 ? { ...props, radius: PAGE_RADIUS } : props) as never)) as typeof Rect.drawWith;
        try { return draw(ctx, bounds); } finally { Rect.drawWith = drawWith; }
      };
    }
    if (shownWorkspace) {
      const canvas = document.querySelector<HTMLCanvasElement>(`canvas[id*="${unitId}"]`);
      if (canvas) canvas.style.backgroundColor = shownWorkspace;
    }
  };
  apply();
}

/**
 * Убираем «ручку блока» (значок T с точками слева от абзаца): она сама выезжает к абзацу под курсором,
 * съезжает на соседние строки и закрывает текст. Всё, что она умеет (заголовки, списки, цвет), есть на панели.
 */
export function disableBlockHandle(univer: unknown, unitId: string) {
  const injector = (univer as { __getInjector: () => { get: <T>(token: unknown) => T } }).__getInjector();
  type Menu = { showParagraphMenu: (paragraph?: unknown) => void; hideParagraphMenu: (force?: boolean) => void };
  let tries = 0;
  const apply = () => {
    // Сервис ручки живёт на уровне отрисовки документа и появляется не сразу после создания.
    let unit: { with?: <T>(token: unknown) => T } | null;
    // Документ закрыли раньше, чем сервис появился: редактор разобран.
    try { unit = injector.get<IRenderManagerService>(IRenderManagerService).getRenderUnitById(unitId) as unknown as typeof unit; } catch { return; }
    let service: Menu | null = null;
    try { service = unit?.with?.<Menu>(DocParagraphMenuService) ?? null; } catch { service = null; }
    if (!service) { if (tries++ < 60) window.requestAnimationFrame(apply); return; }
    service.showParagraphMenu = () => undefined;
    service.hideParagraphMenu(true);
  };
  apply();
}

/** Шрифты-символы: в списке их названия рисуются кракозябрами, а в документе они не нужны. */
const SYMBOL_FONTS = /wingdings|webdings|symbol|dingbats/i;

/** Имена, которые Windows подменяет настоящими: рисуются ровно как они. */
const ALIASES: Record<string, string> = { helvetica: 'Arial', courier: 'Courier New', times: 'Times New Roman', 'ms sans serif': 'Microsoft Sans Serif' };

let measure: CanvasRenderingContext2D | null | undefined;
const known = new Map<string, boolean>();

/**
 * Есть ли шрифт на этом компьютере. Браузер прямого ответа не даёт (document.fonts.check для неизвестного
 * шрифта отвечает «да»), поэтому меряем: если текст шрифтом «Имя, запасной» занимает не столько же места, сколько
 * запасным, — шрифт нашёлся. Три разных запасных — чтобы шрифт, совпавший с одним из них, не ускользнул.
 */
function isInstalled(name: string): boolean {
  const cached = known.get(name);
  if (cached !== undefined) return cached;
  if (measure === undefined) measure = document.createElement('canvas').getContext('2d');
  const ctx = measure;
  let found = false;
  if (ctx) {
    const sample = 'mmmmmmmmmmlliWÖжЩ@#0123';
    for (const fallback of ['monospace', 'serif', 'sans-serif']) {
      ctx.font = `72px ${fallback}`;
      const base = ctx.measureText(sample).width;
      ctx.font = `72px "${name.replace(/"/g, '')}", ${fallback}`;
      if (ctx.measureText(sample).width !== base) { found = true; break; }
    }
  } else {
    found = true; // проверить нечем — не прячем ничего
  }
  // Windows подставляет Arial вместо Helvetica и так далее: «найденный» шрифт, который рисуется ровно как
  // настоящий, в списке лишний — человек увидел бы два одинаковых пункта.
  const twin = ALIASES[name.toLowerCase()];
  if (found && twin && ctx) {
    const width = (font: string) => { ctx.font = `72px "${font}", monospace`; return ctx.measureText('mmmmmmmmmmlliWÖжЩ@#0123').width; };
    if (width(name) === width(twin)) found = false;
  }
  known.set(name, found);
  return found;
}

/**
 * Список шрифтов в панели — только те, что есть на этом компьютере (и не символьные). Univer сам лишь
 * помечает отсутствующие подсказкой; мы убираем их из списка совсем, чтобы не было пунктов, которые в документе
 * нарисуются чужим шрифтом. Список формируется не сразу, поэтому ждём сервис несколько кадров.
 */
export function hideMissingFonts(univer: unknown) {
  const injector = (univer as { __getInjector: () => { get: <T>(token: unknown) => T } }).__getInjector();
  let tries = 0;
  const apply = () => {
    let service: { getFonts: () => Array<{ value: string }>; fonts$: { next: (list: unknown[]) => void } } | null = null;
    try { service = injector.get(IFontService); } catch { service = null; }
    if (!service) { if (tries++ < 60) window.requestAnimationFrame(apply); return; }
    const all = service.getFonts();
    const present = all.filter((font) => !SYMBOL_FONTS.test(font.value) && isInstalled(font.value));
    // Если ни один не нашёлся (нестандартная среда), оставляем список как есть, а не опустошаем его.
    if (present.length && present.length < all.length) service.fonts$.next(present);
  };
  apply();
}

/** Класс на внешней карточке окна поиска Univer (Ctrl+F): по нему её красят токены и стили Шара. */
export const FIND_CARD = 'nx-univer-find';

let findWatchers = 0;
let findObserver: MutationObserver | null = null;
/**
 * Пометить карточку окна поиска Univer классом FIND_CARD. Univer рисует её в body своими утилитами, без
 * своего класса; раньше её находили селектором div:has(> .univer-contents > [find-replace-dialog]) — его
 * браузер проверял на каждом div всего приложения при каждом пересчёте стилей (в чатах тоже). Наблюдаем,
 * только пока открыт хоть один редактор Univer. Возвращает отписку.
 */
export function tagFindDialog(): () => void {
  findWatchers += 1;
  if (!findObserver) {
    const tag = () => {
      for (const dialog of document.querySelectorAll('[data-u-comp="find-replace-dialog"]')) {
        const card = dialog.parentElement?.classList.contains('univer-contents') ? dialog.parentElement.parentElement : null;
        if (card && !card.classList.contains(FIND_CARD)) card.classList.add(FIND_CARD);
      }
    };
    findObserver = new MutationObserver(tag);
    findObserver.observe(document.body, { childList: true, subtree: true });
    tag();
  }
  return () => {
    findWatchers -= 1;
    if (findWatchers <= 0 && findObserver) { findObserver.disconnect(); findObserver = null; findWatchers = 0; }
  };
}

/**
 * Подменить встроенный компонент Univer своим (например выбор эмодзи — на выбор эмодзи Шара). Univer вызывает его
 * с теми же свойствами, что и свой. Любой сбой подмены не должен ронять редактор: тогда остаётся встроенный.
 * Возвращает отмену подмены.
 */
export function overrideComponent(univer: unknown, name: string, component: unknown): () => void {
  try {
    const injector = (univer as { __getInjector: () => { get: <T>(token: unknown) => T } }).__getInjector();
    const manager = injector.get<{ register: (key: string, value: unknown, options?: { override?: boolean }) => { dispose: () => void } }>(ComponentManager);
    const handle = manager.register(name, component, { override: true });
    return () => handle.dispose();
  } catch {
    return () => undefined;
  }
}

/** Стоит ли выделение документа на ссылке (для кнопки «Ссылка») и как следить за выделением. */
export function docLinkProbe(univer: unknown) {
  const injector = (univer as { __getInjector: () => { get: <T>(token: unknown) => T } }).__getInjector();
  const selection = injector.get<DocSelectionManagerService>(DocSelectionManagerService);
  const instances = injector.get<IUniverInstanceService>(IUniverInstanceService);
  return {
    isActive: () => {
      const range = selection.getTextRanges()?.[0];
      const doc = instances.getCurrentUnitOfType(UniverInstanceType.UNIVER_DOC) as unknown as { getBody?: () => { customRanges?: Array<{ rangeType?: number; startIndex: number; endIndex: number }> } | undefined } | null;
      if (!range || !doc?.getBody) return false;
      const from = range.startOffset ?? 0;
      const to = range.endOffset ?? from;
      return (doc.getBody()?.customRanges || []).some((c) => c.rangeType === 0 && c.startIndex <= to && c.endIndex >= from);
    },
    watch: (update: () => void) => {
      const sub = selection.textSelection$.subscribe(update);
      return () => sub.unsubscribe();
    },
  };
}

/**
 * Кнопка «Ссылка» на главной вкладке ленты. В Univer инструмент ссылок лежит только на «Вставке» — для таблицы и
 * документа, где ссылки правят постоянно, он нужен под рукой (то же действие, что у Ctrl+K). Кнопка подсвечивается,
 * когда выделение стоит на ссылке: isActive пересчитывается на каждое событие watch (смена выделения, правка).
 */
export function addLinkButton(
  univer: unknown,
  kind: 'sheet' | 'doc',
  isActive: () => boolean,
  watch: (update: () => void) => () => void,
): () => void {
  const injector = (univer as { __getInjector: () => { get: <T>(token: unknown) => T } }).__getInjector();
  const menus = injector.get<IMenuManagerService>(IMenuManagerService);
  const active$ = new BehaviorSubject(false);
  const update = () => { try { const next = isActive(); if (next !== active$.value) active$.next(next); } catch { /* выделения ещё нет */ } };
  const id = `nx.link.${kind}`;
  menus.mergeMenu({
    [RibbonStartGroup.FORMAT]: {
      [id]: {
        order: 99,
        menuItemFactory: () => ({
          id,
          type: MenuItemType.BUTTON,
          icon: 'LinkIcon',
          title: 'Ссылка',
          tooltip: 'Ссылка (Ctrl+K)',
          commandId: kind === 'sheet' ? 'sheet.operation.insert-hyper-link-toolbar' : 'doc.operation.show-hyper-link-edit-popup',
          activated$: active$.asObservable(),
        }),
      },
    },
  } as never);
  const stop = watch(update);
  update();
  return () => { stop(); active$.complete(); };
}
