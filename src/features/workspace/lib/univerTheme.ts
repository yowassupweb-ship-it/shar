import { useEffect, useState } from 'react';
import { DocParagraphMenuService } from '@univerjs/docs-ui';
import { ComponentManager, IFontService } from '@univerjs/ui';
import { BehaviorSubject } from 'rxjs';
import { DocSelectionManagerService } from '@univerjs/docs';
import { IUniverInstanceService, UniverInstanceType } from '@univerjs/core';
import { IMenuManagerService, MenuItemType, RibbonStartGroup } from '@univerjs/ui';
import { Background, Border, Font, IRenderManagerService, Rect, UniverRenderingContext2D } from '@univerjs/engine-render';
import { DOCS_NORMAL_EDITOR_UNIT_ID_KEY } from '@univerjs/core';
import { IEditorBridgeService } from '@univerjs/sheets-ui';
import { defaultTheme, type Theme } from '@univerjs/themes';

/**
 * Univer рисует на собственном canvas, поэтому токенов Шара ему недостаточно: тему интерфейса
 * (light | gray | graphite | black) переводим в его палитру и следим за её сменой.
 */
/** Univer рисуется тёмным только в Графите и Чёрной; Серая — светлая тема. */
export const isDarkTheme = (theme: string) => theme === 'graphite' || theme === 'black';
/** Цвет линий сетки в тёмных темах: Univer инвертирует цвета холста (255 − канал): на полотне эта линия выходит графитово-серой, #4b5057. */
export const DARK_GRIDLINES = '#b4afa8';

/**
 * Палитра Apple для интерфейса Univer (лента, меню, строка состояния): его утилиты — hover gray-100, разделители
 * gray-200, текст gray-900, акцент primary-* — берут цвета из темы. Синий — системный синий Apple, его 600 — акцент
 * Шара (--accent-fill); серые — нейтральные системные серые macOS, без синевы стандартной темы Univer.
 */
const APPLE_BLUE = { 50: '#eef5ff', 100: '#dbeaff', 200: '#b3d4ff', 300: '#80b8ff', 400: '#409aff', 500: '#0a84ff', 600: '#0071e3', 700: '#0062c4', 800: '#004f9e', 900: '#003a75' };
const APPLE_GRAY = { 0: '#ffffff', 50: '#f5f5f7', 100: '#ebebef', 200: '#e1e1e6', 300: '#d2d2d7', 400: '#aeaeb2', 500: '#8e8e93', 600: '#6e6e73', 700: '#48484a', 800: '#2c2c2e', 900: '#1d1d1f', 1000: '#000000' };

export function univerTheme(theme: string): Theme {
  const base: Theme = { ...defaultTheme, primary: { ...defaultTheme.primary, ...APPLE_BLUE }, gray: { ...defaultTheme.gray, ...APPLE_GRAY } };
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

/** Чисто белый цвет (заливка «по умолчанию» в импортированных таблицах). */
function isWhite(color: unknown): boolean {
  if (typeof color === 'string' && /^white$/i.test(color.trim())) return true;
  const rgb = parseColor(color);
  return Boolean(rgb && rgb[0] === 255 && rgb[1] === 255 && rgb[2] === 255);
}

/** Граница «чернилами»: чёрная или почти чёрная (так рисуют границы Excel и Google по умолчанию). */
function isInk(color: unknown): boolean {
  const rgb = parseColor(color);
  return !rgb || (rgb[0] + rgb[1] + rgb[2]) / 3 < 64;
}
/** Цвет такой границы на экране в тёмной теме — уже готовый, без инверсии: чуть светлее линий сетки (#4b5057). */
const DARK_BORDER = '#62676f';

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
  // Белая заливка (её ставят импортированные таблицы «на всякий случай») в тёмной теме инвертировалась в чисто чёрную —
  // ячейки выходили чёрными плашками темнее листа. Не рисуем её вовсе: ячейка как незакрашенная.
  ctx._canvasColorService = keepWhite
    ? { getRenderColor: (color: string) => (isPainted(color) ? color : isWhite(color) ? 'rgba(0, 0, 0, 0)' : service.getRenderColor(color)) }
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

  // Границы ячеек: в файлах они почти всегда чёрные, и тёмная инверсия делала их почти белыми — сетка из ярких линий
  // резала глаз. В тёмной теме тёмные границы рисуем приглушённым серым, чуть заметнее линий сетки; цветные — как были.
  const border = Border.prototype as unknown as { draw: (ctx: CanvasCtx, ...rest: unknown[]) => void };
  const drawBorders = border.draw;
  border.draw = function patched(this: unknown, ctx: CanvasCtx, ...rest: unknown[]) {
    const service = ctx._canvasColorService;
    if (!service || !isDarkTheme(currentTheme())) return drawBorders.call(this, ctx, ...rest);
    ctx._canvasColorService = { getRenderColor: (color: string) => (isInk(color) ? DARK_BORDER : service.getRenderColor(color)) };
    try { return drawBorders.call(this, ctx, ...rest); } finally { ctx._canvasColorService = service; }
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

/** В ячейке число без явного выравнивания стоит у правого края, а редактор по умолчанию рисовал его слева (текст «переезжал»
 *  при входе в правку) — ставим выравнивание вправо и редактору. */
type EditState = { row: number; column: number; documentLayoutObject?: { horizontalAlign?: number; documentModel?: { getSnapshot?: () => { body?: { paragraphs?: Array<{ paragraphStyle?: { horizontalAlign?: number } }> } } } } } | null;
const ALIGN_UNSPECIFIED = 0;
const ALIGN_RIGHT = 3;
function alignNumberRight(state: EditState, isNumber?: (row: number, column: number) => boolean) {
  const layout = state?.documentLayoutObject;
  if (!state || !layout || !isNumber || layout.horizontalAlign !== ALIGN_UNSPECIFIED) return;
  try { if (!isNumber(state.row, state.column)) return; } catch { return; }
  layout.horizontalAlign = ALIGN_RIGHT;
  for (const paragraph of layout.documentModel?.getSnapshot?.()?.body?.paragraphs || []) {
    paragraph.paragraphStyle = { ...paragraph.paragraphStyle, horizontalAlign: ALIGN_RIGHT };
  }
}

/** Сколько кадров держать снимок: по записи экрана редактор рисует текст к ~50 мс, число у правого края — к ~80 мс. Дольше — вход в правку кажется
 *  медленным (было 7 кадров, ~115 мс). */
const HOLD_FRAMES = 5;

/**
 * Вход в правку ячейки: Univer сразу убирает текст из ячейки и открывает пустой белый редактор, а текст рисует в нём
 * через пару кадров, а число сначала слева и лишь потом справа — ячейка на миг пустела («мигала белым»). На эти кадры
 * кладём поверх таблицы её снимок за мгновение до правки и прячем редактор: видно прежнюю ячейку, затем сразу готовый редактор.
 */
export function holdSheetFrame() {
  // Холстов несколько (строка формул, редактор ячейки) — сама таблица на самом большом.
  const canvas = [...document.querySelectorAll<HTMLCanvasElement>('.nws-univer-sheet canvas[data-u-comp="render-canvas"]')]
    .sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!canvas?.width || !canvas.height) return;
  const box = canvas.getBoundingClientRect();
  const still = document.createElement('canvas');
  still.width = canvas.width;
  still.height = canvas.height;
  try { still.getContext('2d')?.drawImage(canvas, 0, 0); } catch { return; }
  // Фон холста прозрачный: снимок без подложки ложился сглаженным текстом на тот же текст под ним — буквы жирнели.
  let under = 'transparent';
  for (let el: HTMLElement | null = canvas; el && under === 'transparent'; el = el.parentElement) {
    const color = getComputedStyle(el).backgroundColor;
    if (color && color !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(color)) under = color;
  }
  Object.assign(still.style, {
    position: 'fixed', left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`,
    zIndex: '1100', pointerEvents: 'none', background: under,
  });
  document.body.appendChild(still);
  // Редактор ячейки (в раскладке таблицы) лежит выше снимка — на эти кадры прячем и его.
  const editors = [...document.querySelectorAll<HTMLElement>('.nws-univer-sheet [data-u-comp="workbench-layout"] [data-u-comp="editor"]')];
  for (const el of editors) el.style.visibility = 'hidden';
  let left = HOLD_FRAMES;
  const tick = () => {
    if (--left > 0) { window.requestAnimationFrame(tick); return; }
    still.remove();
    for (const el of editors) el.style.visibility = '';
  };
  window.requestAnimationFrame(tick);
}

/** Подписка на правку ячейки: покрашенная — рисуем редактор без инверсии. Возвращает отписку. */
export function keepEditorFill(univer: unknown, cellFill?: (row: number, column: number) => string | undefined, isNumber?: (row: number, column: number) => boolean): () => void {
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
    alignNumberRight((state ?? null) as EditState, isNumber);
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

// ── Кнопки фильтра ──────────────────────────────────────────────────────────────────────────────────────
// Кнопку Univer рисует на холсте белой плашкой с воронкой цвета primary.600; в тёмной теме холст инвертирует цвета,
// и плашка становилась чёрным квадратом на цветной шапке. Рисуем её как есть (светлая плашка с синей воронкой — читается
// на любой заливке), с акцентом Шара. Класс кнопки наружу не экспортируется — берём его у первой созданной кнопки.
const FILTER_ACCENT = '#0a66d6';
const FILTER_HOVER = '#e6eefb';
type FilterShape = { _themeService?: { getColorFromTheme: (key: string) => string }; _draw: (ctx: CanvasCtx) => void; __polished?: boolean };
type SceneLike = { getAllObjects?: () => unknown[]; makeDirty?: (dirty?: boolean) => void };

export function polishFilterButtons(univer: unknown): () => void {
  const injector = (univer as { __getInjector: () => { get: <T>(token: unknown) => T } }).__getInjector();
  const renders = injector.get<IRenderManagerService>(IRenderManagerService);
  let done = false;
  const patch = () => {
    if (done) return;
    try {
      for (const [, render] of (renders as unknown as { getRenderAll: () => Map<string, { scene?: SceneLike }> }).getRenderAll()) {
        const scene = render.scene;
        const shape = (scene?.getAllObjects?.() || []).find((o) => /^SheetsFilterButtonShape/.test((o as { constructor?: { name?: string } })?.constructor?.name || '')) as FilterShape | undefined;
        if (!shape) continue;
        const proto = Object.getPrototypeOf(shape) as FilterShape;
        if (!proto.__polished) {
          proto.__polished = true;
          const draw = proto._draw;
          proto._draw = function polished(this: FilterShape, ctx: CanvasCtx) {
            const theme = this._themeService;
            if (!theme) return draw.call(this, ctx);
            const original = theme.getColorFromTheme;
            theme.getColorFromTheme = (key: string) => (key === 'primary.600' ? FILTER_ACCENT : key === 'gray.50' ? FILTER_HOVER : original.call(theme, key));
            try { return withoutInversion(ctx, () => draw.call(this, ctx)); } finally { delete (theme as { getColorFromTheme?: unknown }).getColorFromTheme; }
          };
        }
        done = true;
        scene?.makeDirty?.(true);
      }
    } catch { /* сцена ещё не создана — попробуем при следующей операции */ }
  };
  const timer = window.setInterval(() => { patch(); if (done) window.clearInterval(timer); }, 400);
  return () => window.clearInterval(timer);
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
/** Обводка листа в светлой теме: системный разделитель Apple, едва заметный на #f5f5f7. */
const PAGE_STROKE_LIGHT = '#dcdce1';

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
    // Светлая тема — как Pages: белый лист на фоне окна (#f5f5f7) с тонкой системной обводкой вместо серой рамки Univer.
    const shownWorkspace = dark ? (modern ? shownPage : cssColor('--bg-sunken')) : (modern ? undefined : cssColor('--bg-color'));
    const page = forDarkCanvas(shownPage);
    const pageStroke = dark || modern ? undefined : PAGE_STROKE_LIGHT;
    const original = background.setFillColors.bind(background);
    // Подложку вокруг листа даёт CSS-фон холста (ниже), а свою заливку Univer рисует прозрачной:
    // пересчёт цветов тёмной темы давал ей чуть другой оттенок, и от левого края листа вниз шла граница.
    background.setFillColors = (fill, pageFill, stroke) => original(shownWorkspace ? 'transparent' : fill, page ?? pageFill, pageStroke ?? stroke, 'transparent');
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

/** Высота парящей ленты с её отступами (office-apple.css) и зазор от неё до листа, экранные px. */
const TOOLBAR_SPACE = 56;
const TOOLBAR_GAP = 14;

/**
 * Лента документа парит над листом (office-apple.css), и в начале документа верх листа уходил под неё. Своего отступа
 * сверху у Univer нет в настройках: сдвигаем лист отступом компонентов отрисовки (pageMarginTop основного слоя и фона;
 * свойство открыто в типах engine-render, но ведёт его Univer — решение владельца от 2026-10-28). Побочно растёт и
 * промежуток между листами: Univer берёт его из того же отступа.
 */
export function reserveToolbarSpace(univer: unknown, unitId: string, onCommand: (listener: (id: string) => void) => () => void): () => void {
  const injector = (univer as { __getInjector: () => { get: <T>(token: unknown) => T } }).__getInjector();
  type Layer = { pageMarginTop?: number; makeDirty?: (dirty?: boolean) => void; getParentScale?: () => { scaleY?: number } };
  let tries = 0;
  const apply = () => {
    let unit: { components?: Map<string, Layer> } | null;
    try { unit = injector.get<IRenderManagerService>(IRenderManagerService).getRenderUnitById(unitId) as unknown as typeof unit; } catch { return; }
    const layers = [unit?.components?.get('__Document_Render_Main__'), unit?.components?.get('__Document_Render_Background__')];
    if (layers.some((layer) => typeof layer?.pageMarginTop !== 'number')) { if (tries++ < 60) window.requestAnimationFrame(apply); return; }
    // Отступ — в единицах документа и растёт с масштабом, а лента — нет: делим на масштаб, чтобы зазор был одинаковым.
    let scale = 1;
    try { scale = Number(layers[0]!.getParentScale?.().scaleY) || 1; } catch { /* масштаб по умолчанию */ }
    const margin = Math.round((TOOLBAR_SPACE + TOOLBAR_GAP) / scale);
    if (layers.every((layer) => layer!.pageMarginTop === margin)) return;
    for (const layer of layers) { layer!.pageMarginTop = margin; layer!.makeDirty?.(true); }
    // Размер сцены и прокрутку Univer пересчитывает по событию resize.
    window.dispatchEvent(new Event('resize'));
  };
  apply();
  // Масштаб сменили — пересчитать отступ под новый.
  return onCommand((id) => { if (/zoom/i.test(id)) window.requestAnimationFrame(apply); });
}

/**
 * Лист прокручивается под парящую ленту, и карточка ссылки (rect-popup Univer) у ссылки, уехавшей под ленту, висела
 * над шапкой документа. Пока карточка целиком выше нижнего края ленты, прячем её; ссылка снова видна — карточка
 * возвращается. Следим, только пока карточка есть на странице. Возвращает отписку.
 */
export function hidePopupsUnderToolbar(host: HTMLElement): () => void {
  let raf = 0;
  const check = () => {
    raf = 0;
    const popups = document.querySelectorAll<HTMLElement>('[data-u-comp="rect-popup"]');
    if (!popups.length) return;
    const bar = host.querySelector('[data-u-comp="ribbon-toolbar"]')?.getBoundingClientRect();
    const limit = bar?.height ? bar.bottom : host.getBoundingClientRect().top;
    for (const popup of popups) {
      const hidden = popup.getBoundingClientRect().bottom <= limit + 1;
      popup.style.visibility = hidden ? 'hidden' : '';
    }
    raf = window.requestAnimationFrame(check);
  };
  const start = () => { if (!raf) raf = window.requestAnimationFrame(check); };
  // Следим только за добавлением карточки: проверять весь документ на каждое изменение страницы (каждое нажатие клавиши
  // в документе меняет DOM) было лишней работой. Цикл кадров сам идёт, пока карточка на странице.
  const POPUP = '[data-u-comp="rect-popup"]';
  const observer = new MutationObserver((records) => {
    if (raf) return;
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element && (node.matches(POPUP) || node.querySelector(POPUP))) { start(); return; }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  start();
  return () => { observer.disconnect(); if (raf) window.cancelAnimationFrame(raf); };
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

/**
 * Веб-шрифты для документов и таблиц: Inter (шрифт интерфейса Шара) и Roboto. Файлы — с Google Fonts, ссылка в
 * index.html; в список Univer добавляются его штатным univerAPI.addFonts. Холст рисует текст тем шрифтом, что уже
 * загружен, и не перерисовывается, когда шрифт догрузится, — поэтому начертания грузим заранее, при загрузке редактора.
 */
const WEB_FONTS = [
  { value: 'Inter', label: 'Inter', category: 'sans-serif' as const },
  { value: 'Roboto', label: 'Roboto', category: 'sans-serif' as const },
];
const WEB_FONT_NAMES = new Set(WEB_FONTS.map((font) => font.value));
if (typeof document !== 'undefined' && document.fonts) {
  for (const font of WEB_FONTS) {
    for (const face of ['400', '700', 'italic 400', 'italic 700']) void document.fonts.load(`${face} 16px "${font.value}"`).catch(() => undefined);
  }
}

/** Добавить веб-шрифты в список шрифтов редактора. */
export function addWebFonts(univerAPI: { addFonts?: (fonts: typeof WEB_FONTS) => void }) {
  try { univerAPI.addFonts?.(WEB_FONTS); } catch { /* старый facade без addFonts — остаются системные */ }
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
    // Веб-шрифты в системе не установлены и могут ещё грузиться — их не проверяем.
    const present = all.filter((font) => WEB_FONT_NAMES.has(font.value) || (!SYMBOL_FONTS.test(font.value) && isInstalled(font.value)));
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
    // Ищем окно поиска, только когда на странице добавилось что-то с ним (а не на каждое изменение страницы).
    const FIND = '[data-u-comp="find-replace-dialog"]';
    findObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element && (node.matches(FIND) || node.querySelector(FIND))) { tag(); return; }
        }
      }
    });
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

/**
 * Холст Univer пересчитывает размер по событию resize окна. Контейнер редактора меняется и без него (свернули список,
 * открыли комментарии) — тогда событие даём сами. Но когда тянут само окно, Univer уже получил настоящее событие,
 * и наше, синтетическое, на каждом кадре заставляло его перестраивать холст второй раз — тянуть окно было тяжело.
 * Поэтому своё событие шлём, только если окно в этом кадре размер не меняло. Возвращает отписку.
 */
/** Когда окно последний раз само меняло размер (ставят relayoutOnHostResize и привратник throttleWindowResize). */
let windowResizedAt = 0;

export function relayoutOnHostResize(el: HTMLElement): () => void {
  if (typeof ResizeObserver === 'undefined') return () => undefined;
  let raf = 0;
  const onWindow = (event: Event) => { if (event.isTrusted) windowResizedAt = performance.now(); };
  window.addEventListener('resize', onWindow);
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      if (performance.now() - windowResizedAt < 100) return;
      window.dispatchEvent(new Event('resize'));
    });
  });
  observer.observe(el);
  return () => { cancelAnimationFrame(raf); observer.disconnect(); window.removeEventListener('resize', onWindow); };
}

/** Шаг ширины строки ленты, px: примерно одна кнопка. */
const TOOLBAR_STEP = 48;

/**
 * Лента Univer на каждое изменение своей ширины заново меряет все кнопки (getBoundingClientRect каждой — это
 * принудительная раскладка всей страницы), чтобы решить, что убрать в «⋮». Пока тянут окно, это шло каждый кадр и
 * было главной тратой времени. Ширину строки ленты меняем ступенями (по кнопке): мерить ей приходится в разы реже.
 * Капсула по центру строки, так что ступени не видны. Возвращает отписку.
 */
export function stepToolbarWidth(host: HTMLElement): () => void {
  if (typeof ResizeObserver === 'undefined') return () => undefined;
  let observer: ResizeObserver | null = null;
  let tries = 0;
  let raf = 0;
  const attach = () => {
    const bar = host.querySelector<HTMLElement>('[data-u-comp="headerbar"]');
    const row = bar?.querySelector<HTMLElement>(':scope > div:has(> [data-u-comp="ribbon-toolbar"])');
    if (!bar || !row) { if (tries++ < 120) raf = requestAnimationFrame(attach); return; }
    observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (!width) return;
      // Поля строки по бокам — 16 px (office-apple.css).
      const stepped = Math.max(TOOLBAR_STEP, Math.floor((width - 32) / TOOLBAR_STEP) * TOOLBAR_STEP);
      if (row.style.width !== `${stepped}px`) {
        row.style.width = `${stepped}px`;
        row.style.marginInline = 'auto';
      }
    });
    observer.observe(bar);
  };
  attach();
  return () => { cancelAnimationFrame(raf); observer?.disconnect(); };
}

/** Не чаще одного resize окна для холстов Univer за это время, мс, пока окно тянут. */
const RESIZE_EVERY = 80;
let resizeGate: { users: number; stop: () => void } | null = null;

/**
 * Univer на каждое событие resize окна заново раскладывает и рисует холст документа или таблицы (в профиле это
 * основная доля времени протяжки окна), а пока окно тянут, событие приходит каждый кадр. Пока открыт хоть один
 * редактор, настоящие события resize до остальных слушателей пропускаем не чаще раза в RESIZE_EVERY мс и всегда —
 * последнее, по окончании протяжки. Раскладку страницы браузер делает сам и без них; реже перерисовывается только
 * холст. Возвращает отписку (общий привратник снимается с последним редактором).
 */
export function throttleWindowResize(): () => void {
  if (!resizeGate) {
    let last = 0;
    let timer = 0;
    let passing = false;
    const pass = () => {
      timer = 0;
      last = performance.now();
      passing = true;
      try { window.dispatchEvent(new Event('resize')); } finally { passing = false; }
    };
    // В фазе захвата на самом window — раньше слушателей Univer (они без capture).
    const gate = (event: Event) => {
      if (passing || !event.isTrusted) return;
      windowResizedAt = performance.now();
      event.stopImmediatePropagation();
      const wait = RESIZE_EVERY - (performance.now() - last);
      window.clearTimeout(timer);
      if (wait <= 0) pass();
      else timer = window.setTimeout(pass, wait);
    };
    window.addEventListener('resize', gate, true);
    resizeGate = { users: 0, stop: () => { window.removeEventListener('resize', gate, true); window.clearTimeout(timer); } };
  }
  resizeGate.users += 1;
  return () => {
    if (!resizeGate) return;
    resizeGate.users -= 1;
    if (resizeGate.users <= 0) { resizeGate.stop(); resizeGate = null; }
  };
}
