import { create } from 'zustand';
import { realtime } from '@/shared/realtime/realtime';

/**
 * Единички инструментов: что ждёт человека в «Соцсетях» (диалоги без ответа — по настройкам
 * уведомлений модуля) и в «Заявках с сайта» (невзятые заявки — у кого есть приложение и у участников
 * чата заявок). Сумма идёт на значок приложения вместе с чатами и на «Ещё»; каждое число — на иконку
 * своего инструмента в «Ещё» и в нижнем меню. Сервер считает сам и без доступа отдаёт ноль.
 * Итог кладётся и в localStorage + событие `shar-tool-badges`: значок PWA ставит сервис пушей.
 */
export type ToolBadges = Record<string, number>;

export const useToolBadges = create<{ counts: ToolBadges }>(() => ({ counts: {} }));

export const toolBadgesTotal = (counts: ToolBadges) => Object.values(counts).reduce((a, b) => a + (b || 0), 0);

const SOURCES: { tool: string; url: string; events: string[] }[] = [
  { tool: 'social', url: '/api/social/waiting', events: ['social_changed', 'social_message'] },
  { tool: 'site-leads', url: '/api/leads/waiting', events: ['leads_changed'] },
];

const timers: Record<string, number> = {};

async function refresh(tool: string, url: string): Promise<void> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return;
    const total = Number((await res.json())?.total) || 0;
    const { counts } = useToolBadges.getState();
    if ((counts[tool] || 0) === total) return;
    const next = { ...counts, [tool]: total };
    useToolBadges.setState({ counts: next });
    try { localStorage.setItem('shar_tool_badges_total', String(toolBadgesTotal(next))); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent('shar-tool-badges', { detail: { count: toolBadgesTotal(next) } }));
  } catch { /* нет связи — останется прежнее */ }
}

function soon(tool: string, url: string): void {
  if (timers[tool]) return;
  timers[tool] = window.setTimeout(() => { delete timers[tool]; void refresh(tool, url); }, 300);
}

/** Запустить счётчики (на всё время входа). Возвращает остановку. */
export function startToolBadges(): () => void {
  for (const s of SOURCES) void refresh(s.tool, s.url);
  const off = realtime.subscribe((event) => {
    const type = (event as { type?: string }).type || '';
    for (const s of SOURCES) if (type === 'resync' || s.events.includes(type)) soon(s.tool, s.url);
  });
  return () => {
    off();
    for (const k of Object.keys(timers)) { window.clearTimeout(timers[k]); delete timers[k]; }
    useToolBadges.setState({ counts: {} });
    try { localStorage.removeItem('shar_tool_badges_total'); } catch { /* ignore */ }
  };
}
