import { create } from 'zustand';
import { realtime } from '@/shared/realtime/realtime';
import { useMail, type Box } from './api';

/**
 * Единичка на «Почте» в меню: непрочитанные во «Входящих» всех ящиков (спам и корзина не в счёт), как у
 * почтовых программ. Считает сервер; перечитываем при новом письме (mail_new), при смене флагов на почтовом
 * сервере (mail_changed), после переподключения сокета и когда письмо прочитали или перенесли здесь же —
 * счётчики ящиков в сторе почты меняются сразу, а события на свои правки сервер не шлёт.
 */
export const useMailBadge = create<{ unread: number }>(() => ({ unread: 0 }));

let timer = 0;

async function refresh(): Promise<void> {
  try {
    const res = await fetch('/api/mail/unread/total?inbox=true', { cache: 'no-store' });
    if (!res.ok) return;
    const unread = Number((await res.json())?.total) || 0;
    if (useMailBadge.getState().unread !== unread) useMailBadge.setState({ unread });
  } catch { /* нет связи — останется прежнее */ }
}

function soon(wait = 400): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void refresh(), wait);
}

const inboxUnread = (boxes: Box[]) => boxes.find((b) => b.role === 'inbox')?.unread;

/** Запустить счётчик (на всё время входа). Возвращает остановку. */
export function startMailBadge(): () => void {
  void refresh();
  const off = realtime.subscribe((event) => {
    const type = (event as { type?: string }).type;
    if (type === 'mail_new' || type === 'mail_changed' || type === 'resync') soon();
  });
  // Прочитали или вернули в непрочитанные здесь: число меняем сразу (сервер узнает о флаге чуть позже),
  // сверяемся с ним, когда правка точно дошла.
  const offBoxes = useMail.subscribe((s, prev) => {
    if (s.boxes === prev.boxes) return;
    const now = inboxUnread(s.boxes);
    const was = inboxUnread(prev.boxes);
    if (s.accountId === prev.accountId && now !== undefined && was !== undefined && now !== was) {
      useMailBadge.setState((b) => ({ unread: Math.max(0, b.unread + now - was) }));
    }
    soon(1500);
  });
  return () => {
    off();
    offBoxes();
    window.clearTimeout(timer);
    useMailBadge.setState({ unread: 0 });
  };
}
