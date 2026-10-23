import { create } from 'zustand';
import { realtime } from '@/shared/realtime/realtime';
import { showToast } from '@/shared/ui/Toast';
import type { OutAttachment } from './store';

/**
 * Отложенная отправка (правый щелчок / долгое нажатие на кнопке отправки). Сообщение лежит на сервере
 * и уходит в назначенное время само — даже если приложение закрыто. Здесь — свои запланированные по чатам:
 * грузятся при открытии чата, обновляются по событию scheduled_changed (с любого своего устройства).
 */

export interface Scheduled {
  id: string;
  chatId: string;
  sendAt: string;
  content: string;
  replyToId?: string;
  attachments?: OutAttachment[];
}

interface State { byChat: Record<string, Scheduled[] | undefined> }

export const useScheduled = create<State>(() => ({ byChat: {} }));

async function call<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    cache: 'no-store',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = String((await res.json())?.detail || ''); } catch { /* не JSON */ }
    throw new Error(detail || 'Не удалось — проверьте связь');
  }
  return (await res.json()) as T;
}

const put = (chatId: string, items: Scheduled[]) =>
  useScheduled.setState((s) => ({ byChat: { ...s.byChat, [chatId]: items } }));

export async function loadScheduled(chatId: string) {
  listen();
  try {
    const { items } = await call<{ items: Scheduled[] }>(`/api/chats/${encodeURIComponent(chatId)}/scheduled`);
    put(chatId, items);
  } catch { /* старый сервер без отложенной отправки — просто ничего не показываем */ }
}

export async function scheduleMessage(chatId: string, sendAt: Date, message: { content: string; replyToId?: string; attachments?: OutAttachment[] }) {
  const { item } = await call<{ item: Scheduled }>(`/api/chats/${encodeURIComponent(chatId)}/scheduled`, 'POST', { sendAt: sendAt.toISOString(), message });
  put(chatId, [...(useScheduled.getState().byChat[chatId] || []).filter((x) => x.id !== item.id), item].sort((a, b) => a.sendAt.localeCompare(b.sendAt)));
  return item;
}

export async function rescheduleMessage(item: Scheduled, sendAt: Date) {
  const { item: next } = await call<{ item: Scheduled }>(`/api/scheduled/${encodeURIComponent(item.id)}`, 'PATCH', { sendAt: sendAt.toISOString() });
  put(item.chatId, (useScheduled.getState().byChat[item.chatId] || []).map((x) => (x.id === next.id ? next : x)).sort((a, b) => a.sendAt.localeCompare(b.sendAt)));
}

export async function cancelScheduled(item: Scheduled) {
  await call(`/api/scheduled/${encodeURIComponent(item.id)}`, 'DELETE');
  put(item.chatId, (useScheduled.getState().byChat[item.chatId] || []).filter((x) => x.id !== item.id));
}

export async function sendScheduledNow(item: Scheduled) {
  await call(`/api/scheduled/${encodeURIComponent(item.id)}/send`, 'POST');
  put(item.chatId, (useScheduled.getState().byChat[item.chatId] || []).filter((x) => x.id !== item.id));
}

let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  realtime.subscribe((event) => {
    const e = event as { type?: string; chatId?: string; reason?: string };
    if (!e.chatId) return;
    if (e.type === 'scheduled_changed' && useScheduled.getState().byChat[e.chatId]) void loadScheduled(e.chatId);
    if (e.type === 'scheduled_failed') showToast(`Запланированное сообщение не отправлено${e.reason ? `: ${e.reason}` : ''}`, 'error');
  });
}

// ── Время ──────────────────────────────────────────────────────────────────

const at = (days: number, hour: number) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d; };

/** Быстрые варианты, как в Telegram и Gmail: только те, что ещё впереди и не повторяют друг друга. */
export function quickTimes(now = new Date()): Array<{ label: string; at: Date }> {
  const out: Array<{ label: string; at: Date }> = [{ label: 'Через час', at: new Date(now.getTime() + 3600_000) }];
  if (now.getHours() < 17) out.push({ label: 'Сегодня в 18:00', at: at(0, 18) });
  out.push({ label: 'Завтра в 9:00', at: at(1, 9) });
  const toMonday = (8 - now.getDay()) % 7 || 7;
  if (toMonday > 1) out.push({ label: 'В понедельник в 9:00', at: at(toMonday, 9) });
  return out;
}

/** «сегодня в 18:00», «завтра в 9:00», «24 окт. в 9:00». */
export function whenLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86400_000);
  if (diff === 0) return `сегодня в ${time}`;
  if (diff === 1) return `завтра в ${time}`;
  const date = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
  return `${date} в ${time}`;
}
