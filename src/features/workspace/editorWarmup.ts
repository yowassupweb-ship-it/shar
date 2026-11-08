import type { Kind } from './types';

/**
 * Прогрев тяжёлых редакторов. Univer (документ, таблица) — несколько мегабайт кода, и его разбор стоит от секунды
 * (обычный ПК) до 3–4 с (слабый) при первом открытии материала; прогретый открывается за единицы миллисекунд.
 * Заметка и презентация лёгкие, им прогрев не нужен.
 *
 * Прогревает два места: список «Офиса» (как только показан) и всё приложение (warmEditorsInBackground — чтобы
 * ссылка на документ из чата или первое открытие «Офиса» тоже не были холодными). Сам разбор — длинная задача,
 * поэтому ждём паузы без ввода и берём по одному редактору за простой.
 */

const warmed = new Set<string>();

export function preloadEditor(kind: Kind): void {
  if (warmed.has(kind)) return;
  if (kind === 'document') {
    warmed.add(kind);
    void import('./editors/DocEditor');
  } else if (kind === 'table') {
    warmed.add(kind);
    // Разбор таблицы (xlsx → Univer) нужен exceljs; раньше он начинал грузиться только после редактора — цепочкой.
    void import('./editors/SheetEditor');
    void import('exceljs');
  }
}

/** Прогреть перечисленные виды по одному, в паузах ввода. Возвращает отмену. */
export function startEditorWarmup(kinds: Kind[], firstDelay = 1500): () => void {
  const queue = kinds.filter((kind) => !warmed.has(kind));
  if (!queue.length) return () => undefined;
  let handle = 0;
  let cancelled = false;
  const idle = (fn: () => void) => (typeof window.requestIdleCallback === 'function'
    ? window.requestIdleCallback(fn, { timeout: 4000 })
    : window.setTimeout(fn, 1500));
  // Разбор — одна длинная задача: если человек в этот момент печатает или тянет строку, она заметна.
  // Поэтому ждём паузы — 2 секунды без нажатий и движения колеса.
  let lastInput = performance.now();
  const onInput = () => { lastInput = performance.now(); };
  const events = ['keydown', 'pointerdown', 'wheel'] as const;
  events.forEach((type) => window.addEventListener(type, onInput, { passive: true, capture: true }));
  const next = () => {
    if (cancelled) return;
    if (document.visibilityState === 'hidden' || performance.now() - lastInput < 2000) { handle = window.setTimeout(next, 700); return; }
    const kind = queue.shift();
    if (!kind) return;
    handle = idle(() => { if (!cancelled) { preloadEditor(kind); handle = window.setTimeout(next, 1200); } });
  };
  handle = window.setTimeout(next, firstDelay);
  return () => {
    events.forEach((type) => window.removeEventListener(type, onInput, { capture: true }));
    cancelled = true;
    window.clearTimeout(handle);
    if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(handle);
  };
}

/**
 * Прогрев на уровне приложения, через несколько секунд после входа — когда главный экран уже нарисован.
 * Не греем на телефоне (узкий экран: редакторов там почти нет, а память дорога) и при включённой экономии трафика.
 */
export function warmEditorsInBackground(): () => void {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (connection?.saveData || window.matchMedia('(max-width: 640px)').matches) return () => undefined;
  // Сам экран «Офиса» с просмотром материала (его куски тоже грузились уже после клика) — вместе с первым прогревом.
  const stop = startEditorWarmup(['document', 'table'], 8000);
  const screen = window.setTimeout(() => { void import('./OfficeScreen'); }, 7000);
  return () => { stop(); window.clearTimeout(screen); };
}
