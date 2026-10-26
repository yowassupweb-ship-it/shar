import { useEffect, useState } from 'react';
import { DocParagraphMenuService } from '@univerjs/docs-ui';
import { ComponentManager, IFontService } from '@univerjs/ui';
import { IRenderManagerService, Rect } from '@univerjs/engine-render';
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
    const unit = injector.get<IRenderManagerService>(IRenderManagerService).getRenderUnitById(unitId) as unknown as { components?: Map<string, DocBackground> } | null;
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
    const unit = injector.get<IRenderManagerService>(IRenderManagerService).getRenderUnitById(unitId) as unknown as { with?: <T>(token: unknown) => T } | null;
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
