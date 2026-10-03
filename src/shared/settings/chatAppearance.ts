/**
 * Оформление переписки в v2: фон (градиент или картинка), узор поверх фона,
 * форма и цвета пузырей. У светлой и тёмной темы — свои фон, узор и цвета.
 *
 * Ничего не выбрано — действуют токены дизайна (chat.css берёт `--user-*`
 * с запасным значением), поэтому пустое оформление = вид по умолчанию.
 */

export type ThemeKey = 'light' | 'dark';
export type BubbleShape = 'round' | 'classic' | 'square';

export interface ThemeLook {
  /** CSS-значение background: градиент или url(...) картинки. '' — без фона. */
  background: string;
  /** url узора (SVG с сервера). '' — без узора. */
  pattern: string;
  /** Свои пузыри. '' — цвет по умолчанию (акцент). */
  bubbleOut: string;
  /** Чужие пузыри. '' — по умолчанию (серый темы). */
  bubbleIn: string;
}

export interface ChatAppearance {
  light: ThemeLook;
  dark: ThemeLook;
  /** Размер плитки узора, % ширины ленты. */
  patternScale: number;
  /** Непрозрачность узора, 0…1. */
  patternOpacity: number;
  bubbleShape: BubbleShape;
  /** Непрозрачность пузырей, 0.5…1 — сквозь них виден фон. */
  bubbleOpacity: number;
}

export const PATTERN_SCALE = { min: 20, max: 200, fallback: 60 } as const;
export const BUBBLE_RADIUS: Record<BubbleShape, number> = { round: 18, classic: 12, square: 6 };

const EMPTY_LOOK: ThemeLook = { background: '', pattern: '', bubbleOut: '', bubbleIn: '' };

export const DEFAULT_APPEARANCE: ChatAppearance = {
  light: { ...EMPTY_LOOK },
  dark: { ...EMPTY_LOOK },
  patternScale: PATTERN_SCALE.fallback,
  patternOpacity: 0.5,
  bubbleShape: 'round',
  bubbleOpacity: 1,
};

const num = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const look = (v: unknown): ThemeLook => {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return { background: str(o.background), pattern: str(o.pattern), bubbleOut: str(o.bubbleOut), bubbleIn: str(o.bubbleIn) };
};

export function normalizeAppearance(v: unknown): ChatAppearance {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const shape = o.bubbleShape === 'classic' || o.bubbleShape === 'square' ? o.bubbleShape : 'round';
  return {
    light: look(o.light),
    dark: look(o.dark),
    patternScale: num(o.patternScale, PATTERN_SCALE.min, PATTERN_SCALE.max, PATTERN_SCALE.fallback),
    patternOpacity: num(o.patternOpacity, 0, 1, DEFAULT_APPEARANCE.patternOpacity),
    bubbleShape: shape,
    bubbleOpacity: num(o.bubbleOpacity, 0.5, 1, 1),
  };
}

// ── Цвет ───────────────────────────────────────────────────────────────────

function rgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Относительная яркость (WCAG). */
function luminance([r, g, b]: [number, number, number]) {
  const c = [r, g, b].map((x) => { const s = x / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** Текст на цветном пузыре: белый или почти чёрный — что контрастнее. */
export function textOn(hex: string): string {
  const c = rgb(hex);
  if (!c) return '#ffffff';
  const l = luminance(c);
  return (1.05 / (l + 0.05)) >= ((l + 0.05) / 0.05) ? '#ffffff' : '#1d1d1f';
}

const withAlpha = (hex: string, a: number) => {
  const c = rgb(hex);
  return c && a < 1 ? `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})` : hex;
};

/** CSS-переменные для темы. Ключи без значения не возвращаются — работает запасное из CSS. */
export function appearanceVars(a: ChatAppearance, theme: ThemeKey): Record<string, string> {
  const t = a[theme];
  const vars: Record<string, string> = {};
  if (t.background) vars['--user-chat-bg'] = t.background;
  if (t.pattern) {
    vars['--user-chat-pattern'] = `url("${t.pattern.replace(/"/g, '%22')}")`;
    vars['--user-chat-pattern-size'] = `${a.patternScale}%`;
    vars['--user-chat-pattern-opacity'] = String(a.patternOpacity);
  }
  if (t.bubbleOut) {
    vars['--user-bubble-out'] = withAlpha(t.bubbleOut, a.bubbleOpacity);
    vars['--user-on-bubble-out'] = textOn(t.bubbleOut);
  } else if (a.bubbleOpacity < 1) {
    vars['--user-bubble-out'] = `color-mix(in srgb, var(--accent-fill) ${Math.round(a.bubbleOpacity * 100)}%, transparent)`;
  }
  if (t.bubbleIn) {
    vars['--user-bubble-in'] = withAlpha(t.bubbleIn, a.bubbleOpacity);
    vars['--user-on-bubble-in'] = textOn(t.bubbleIn);
  } else if (a.bubbleOpacity < 1) {
    vars['--user-bubble-in'] = `color-mix(in srgb, var(--bubble-gray) ${Math.round(a.bubbleOpacity * 100)}%, transparent)`;
  }
  if (a.bubbleShape !== 'round') vars['--user-bubble-radius'] = `${BUBBLE_RADIUS[a.bubbleShape]}px`;
  return vars;
}

// ── Встроенные варианты ────────────────────────────────────────────────────

export interface Swatch { id: string; name: string; value: string }

/** Градиенты фона — свои у каждой темы (в тёмной светлый фон слепит). */
export const GRADIENTS: Record<ThemeKey, Swatch[]> = {
  light: [
    { id: 'l-sky', name: 'Небо', value: 'linear-gradient(160deg, #e0f2ff 0%, #f5f7ff 55%, #fdf2ff 100%)' },
    { id: 'l-mint', name: 'Мята', value: 'linear-gradient(160deg, #e6fbf3 0%, #f3fbf8 50%, #e8f4ff 100%)' },
    { id: 'l-peach', name: 'Персик', value: 'linear-gradient(160deg, #fff1e6 0%, #fff8f2 50%, #ffeef3 100%)' },
    { id: 'l-lavender', name: 'Лаванда', value: 'linear-gradient(160deg, #f1ecff 0%, #f8f5ff 50%, #eaf0ff 100%)' },
    { id: 'l-sand', name: 'Песок', value: 'linear-gradient(160deg, #faf5ea 0%, #fbf9f4 50%, #f1f5ee 100%)' },
    { id: 'l-aurora', name: 'Сияние', value: 'radial-gradient(120% 90% at 0% 0%, #dff6ff 0%, transparent 60%), radial-gradient(110% 90% at 100% 100%, #ffe6f4 0%, transparent 60%), #f7f7fb' },
  ],
  dark: [
    { id: 'd-graphite', name: 'Графит', value: 'linear-gradient(180deg, #0a0b10 0%, #11131b 52%, #1a1d28 100%)' },
    { id: 'd-night', name: 'Ночь', value: 'linear-gradient(160deg, #0b1020 0%, #111a33 55%, #1b1432 100%)' },
    { id: 'd-forest', name: 'Лес', value: 'linear-gradient(160deg, #07130f 0%, #0d1f19 55%, #10231f 100%)' },
    { id: 'd-wine', name: 'Вино', value: 'linear-gradient(160deg, #150a10 0%, #22101a 55%, #1c1224 100%)' },
    { id: 'd-ocean', name: 'Океан', value: 'linear-gradient(160deg, #06121a 0%, #0a1d2b 55%, #0d2433 100%)' },
    { id: 'd-aurora', name: 'Сияние', value: 'radial-gradient(120% 90% at 0% 0%, #10284a 0%, transparent 60%), radial-gradient(110% 90% at 100% 100%, #2a1340 0%, transparent 60%), #0c0d12' },
  ],
};

/** Цвета своих пузырей. Все дают текст с контрастом не ниже 4.5:1. */
export const BUBBLE_OUT_COLORS: Swatch[] = [
  { id: 'blue', name: 'Синий', value: '#0071e3' },
  { id: 'indigo', name: 'Индиго', value: '#4f46e5' },
  { id: 'violet', name: 'Фиолетовый', value: '#7c3aed' },
  { id: 'pink', name: 'Розовый', value: '#c2185b' },
  { id: 'orange', name: 'Оранжевый', value: '#c2410c' },
  { id: 'green', name: 'Зелёный', value: '#15803d' },
  { id: 'teal', name: 'Бирюзовый', value: '#0e7490' },
  { id: 'graphite', name: 'Графит', value: '#3a3a3c' },
];

export const BUBBLE_IN_COLORS: Record<ThemeKey, Swatch[]> = {
  light: [
    { id: 'white', name: 'Белый', value: '#ffffff' },
    { id: 'mist', name: 'Туман', value: '#eef2f7' },
    { id: 'cream', name: 'Сливки', value: '#fbf6ea' },
    { id: 'mint', name: 'Мята', value: '#e7f6ee' },
    { id: 'lilac', name: 'Сирень', value: '#f0ebfb' },
  ],
  dark: [
    { id: 'ink', name: 'Чернила', value: '#1f2937' },
    { id: 'slate', name: 'Сланец', value: '#2b2f3a' },
    { id: 'coal', name: 'Уголь', value: '#262628' },
    { id: 'pine', name: 'Хвоя', value: '#1c2b26' },
    { id: 'plum', name: 'Слива', value: '#2a2233' },
  ],
};

/** Картинка с сервера как фон: во всю ленту, без повторов. */
export const imageBackground = (url: string) => `url("${url.replace(/"/g, '%22')}") center / cover no-repeat`;
