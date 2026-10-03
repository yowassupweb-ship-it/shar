/**
 * Разрешение на уведомления и подписка Web Push.
 *
 * Запрашивается только по нажатию — iOS Safari без жеста пользователя не
 * покажет запрос. На iPhone уведомления работают лишь у установленного
 * приложения (экран «Домой»), в обычной вкладке Safari — нет.
 */

export type NotificationState = 'default' | 'granted' | 'denied' | 'unsupported';

export function notificationState(): NotificationState {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export function isIosBrowserTab(): boolean {
  if (typeof window === 'undefined') return false;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
    || window.matchMedia('(display-mode: standalone)').matches;
  return ios && !standalone;
}

function base64ToBytes(b64: string): Uint8Array {
  const padding = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function subscribePush(userId: string) {
  // В разработке сервис-воркер не регистрируем (см. PwaEnhancements).
  if (!import.meta.env.PROD || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
  await navigator.serviceWorker.register('/notifications-sw.js', { scope: '/' });
  const reg = await navigator.serviceWorker.ready;
  const res = await fetch('/api/push/subscriptions', { cache: 'no-store' });
  if (!res.ok) return;
  const meta = await res.json();
  if (!meta?.configured || !meta?.publicKey) return;
  const key = base64ToBytes(meta.publicKey);
  let sub = await reg.pushManager.getSubscription();
  // Ключ сменился — старая подписка молча перестаёт получать пуши. Переподписываем.
  if (sub) {
    try {
      const existing = sub.options?.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey as ArrayBuffer) : null;
      const same = existing && existing.length === key.length && existing.every((v, i) => v === key[i]);
      if (!same) { await sub.unsubscribe(); sub = null; }
    } catch { /* сравнить не вышло — оставляем как есть */ }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource });
  await fetch('/api/push/subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, subscription: sub.toJSON(), userAgent: navigator.userAgent }),
  });
}

export async function requestNotifications(userId: string): Promise<NotificationState> {
  if (notificationState() === 'unsupported') return 'unsupported';
  try {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      try { await subscribePush(userId); } catch { /* разрешение есть, подписка догонит при следующем запуске */ }
    }
    return permission;
  } catch {
    return notificationState();
  }
}
