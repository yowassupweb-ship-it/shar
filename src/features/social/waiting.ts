import { create } from 'zustand';
import { realtime } from '@/shared/realtime/realtime';

/**
 * Сколько диалогов «Соцсетей» ждут ответа — для значка непрочитанных на логотипе (вместе с чатами)
 * и на «Ещё». Сервер считает только вкладки, уведомления которых положены этому человеку, без
 * доступа к модулю — ноль. Обновляется по событиям модуля (новое сообщение, чей-то ответ).
 * Число кладётся и в localStorage + событие `shar-social-waiting`: значок PWA ставит сервис пушей.
 */
export const useSocialWaiting = create<{ total: number }>(() => ({ total: 0 }));

let timer: number | null = null;

async function refresh(): Promise<void> {
  try {
    const res = await fetch('/api/social/waiting', { cache: 'no-store' });
    if (!res.ok) return;
    const total = Number((await res.json())?.total) || 0;
    if (total === useSocialWaiting.getState().total) return;
    useSocialWaiting.setState({ total });
    try { localStorage.setItem('shar_social_waiting', String(total)); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent('shar-social-waiting', { detail: { count: total } }));
  } catch { /* нет связи — останется прежнее */ }
}

function soon(): void {
  if (timer !== null) return;
  timer = window.setTimeout(() => { timer = null; void refresh(); }, 300);
}

/** Запустить счётчик (на всё время входа). Возвращает остановку. */
export function startSocialWaiting(): () => void {
  void refresh();
  const off = realtime.subscribe((event) => {
    const type = (event as { type?: string }).type;
    if (type === 'social_changed' || type === 'social_message' || type === 'resync') soon();
  });
  return () => {
    off();
    if (timer !== null) { window.clearTimeout(timer); timer = null; }
    useSocialWaiting.setState({ total: 0 });
    try { localStorage.removeItem('shar_social_waiting'); } catch { /* ignore */ }
  };
}
