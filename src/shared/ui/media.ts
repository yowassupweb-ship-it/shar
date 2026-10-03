/**
 * Картинки: адреса превью и запомненные пропорции.
 *
 * В ленте — уменьшенная копия под реальный размер на экране (с учётом
 * плотности пикселей), в просмотре — оригинал. Пропорции загруженных фото
 * запоминаются между сеансами: при повторном открытии чата место под фото
 * сразу нужного размера, лента не прыгает.
 */

const WIDTHS = [320, 640, 1280];
const UPLOAD_RE = /\/api\/uploads\/([^/?#]+)/;

/** Превью для показа шириной cssWidth. Не наш файл (внешний, data:) — как есть. */
export function thumbUrl(url: string, cssWidth: number): string {
  const m = url.match(UPLOAD_RE);
  if (!m) return url;
  const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
  const need = cssWidth * dpr;
  const w = WIDTHS.find((x) => x >= need) || WIDTHS[WIDTHS.length - 1];
  // v=2: браузеры сутки помнили битое перенаправление старого /api/thumbs —
  // новый адрес их кэш не задевает.
  return `/api/thumbs/${w}/${m[1]}?v=2`;
}

// ── Пропорции ───────────────────────────────────────────────────────────────

const KEY = 'nx:img-ratios';
const LIMIT = 800;
let ratios: Map<string, number> | null = null;
let saveTimer = 0;

function load(): Map<string, number> {
  if (ratios) return ratios;
  ratios = new Map();
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]') as [string, number][];
    for (const [k, v] of raw) ratios.set(k, v);
  } catch { /* ignore */ }
  return ratios;
}

const keyOf = (url: string) => url.match(UPLOAD_RE)?.[1] || url.slice(0, 200);

export function knownRatio(url: string): number | undefined {
  return load().get(keyOf(url));
}

export function rememberRatio(url: string, ratio: number) {
  if (!(ratio > 0) || !Number.isFinite(ratio)) return;
  const map = load();
  const k = keyOf(url);
  if (map.get(k) === ratio) return;
  map.delete(k);
  map.set(k, ratio);
  while (map.size > LIMIT) map.delete(map.keys().next().value as string);
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(Array.from(map.entries()))); } catch { /* ignore */ }
  }, 500);
}
