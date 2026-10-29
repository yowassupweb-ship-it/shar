import { paths } from '@/shared/navigation/routes';

/**
 * Статистика разделов для админки (server/app/modules/usage): заходы в раздел и время в нём. Время идёт, только
 * пока вкладка видна, окно в фокусе и человек не простаивает дольше 5 минут. Накопленное уходит раз в 30 секунд
 * и при закрытии страницы (sendBeacon). Сбой отправки не ломает ничего — посылка просто повторится.
 */

const TICK_MS = 5_000;
const FLUSH_MS = 30_000;
const IDLE_MS = 5 * 60_000;

/** Раздел по адресу: ключ из paths (chats, office, leads…), для неизвестного — первый сегмент. */
export function sectionKey(pathname: string): string {
  const hit = (Object.entries(paths) as Array<[string, string]>).find(([, href]) => pathname === href || pathname.startsWith(`${href}/`));
  if (hit) return hit[0] === 'login' ? '' : hit[0];
  return (pathname.split('/')[1] || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32);
}

let current = '';
let lastInput = Date.now();
let lastTick = Date.now();
const pending = new Map<string, { visits: number; seconds: number }>();

function add(section: string, visits: number, seconds: number) {
  if (!section) return;
  const cur = pending.get(section) ?? { visits: 0, seconds: 0 };
  cur.visits += visits;
  cur.seconds += seconds;
  pending.set(section, cur);
}

function tick() {
  const now = Date.now();
  const dt = (now - lastTick) / 1000;
  lastTick = now;
  // Таймер мог «спать» (свёрнутое окно, сон ноутбука) — больше одного интервала за раз не засчитываем.
  if (current && document.visibilityState === 'visible' && document.hasFocus() && now - lastInput < IDLE_MS) add(current, 0, Math.min(dt, TICK_MS / 1000 * 2));
}

function take() {
  const items = [...pending.entries()]
    .map(([section, v]) => ({ section, visits: v.visits, seconds: Math.round(v.seconds) }))
    .filter((i) => i.visits || i.seconds);
  pending.clear();
  return items;
}

function flush(beacon = false) {
  tick();
  const items = take();
  if (!items.length) return;
  const body = JSON.stringify({ items });
  if (beacon && navigator.sendBeacon?.('/api/usage/beat', body)) return;
  void fetch('/api/usage/beat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {
    // Не ушло — вернём в очередь, уйдёт со следующей посылкой.
    for (const i of items) add(i.section, i.visits, i.seconds);
  });
}

/** Человек перешёл в раздел (вызывается при смене адреса). */
export function trackSection(pathname: string) {
  const key = sectionKey(pathname);
  tick();
  if (key && key !== current) add(key, 1, 0);
  current = key;
}

/** Запуск один раз на приложение (AppRoot). Возвращает остановку. */
export function startUsageTracker(): () => void {
  const onInput = () => { lastInput = Date.now(); };
  const onHide = () => { if (document.visibilityState === 'hidden') flush(true); };
  const events = ['pointerdown', 'keydown', 'wheel', 'pointermove', 'touchstart'] as const;
  events.forEach((type) => window.addEventListener(type, onInput, { passive: true, capture: true }));
  document.addEventListener('visibilitychange', onHide);
  const onPageHide = () => flush(true);
  window.addEventListener('pagehide', onPageHide);
  lastTick = Date.now();
  const ticker = window.setInterval(tick, TICK_MS);
  const flusher = window.setInterval(() => flush(), FLUSH_MS);
  return () => {
    flush(true);
    events.forEach((type) => window.removeEventListener(type, onInput, { capture: true }));
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', onPageHide);
    window.clearInterval(ticker);
    window.clearInterval(flusher);
  };
}
