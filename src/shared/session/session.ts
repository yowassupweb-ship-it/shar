import { useSyncExternalStore } from 'react';
import type { User } from '@/shared/types/chat';

/**
 * Сессия Шара v2.
 *
 * Правда — серверная кука `shar_session` (её проверяет middleware перед /api).
 * Кэш `myAccount` в localStorage нужен только для мгновенного старта: пока
 * идёт проверка, интерфейс уже поднят по кэшу; если сервер скажет «не вошёл»,
 * показываем экран входа. Сеть недоступна — остаёмся на кэше (офлайн-старт).
 *
 * Ключи localStorage общие со старым фронтом: на одном домене вход в любом
 * из приложений действует в обоих.
 */

export type SessionStatus = 'checking' | 'authenticated' | 'anonymous';

export interface SessionState {
  status: SessionStatus;
  me: User | null;
}

const ME_KEY = 'myAccount';

function readCached(): User | null {
  try {
    const raw = localStorage.getItem(ME_KEY);
    const me = raw ? (JSON.parse(raw) as User) : null;
    return me && me.id ? me : null;
  } catch {
    return null;
  }
}

function writeCached(user: { id: string | number; name?: string; username?: string; role?: string }) {
  try {
    const prev = readCached();
    const same = prev && String(prev.id) === String(user.id);
    localStorage.setItem(ME_KEY, JSON.stringify({
      ...(same ? prev : {}),
      id: user.id,
      name: user.name || user.username || (same ? prev?.name : '') || '',
    }));
    localStorage.setItem('isAuthenticated', 'true');
    if (user.username) localStorage.setItem('username', user.username);
    if (user.role) localStorage.setItem('userRole', user.role);
  } catch { /* приватный режим — живём без кэша */ }
}

function clearCached() {
  try {
    for (const k of [ME_KEY, 'isAuthenticated', 'username', 'userRole']) localStorage.removeItem(k);
  } catch { /* нечего чистить */ }
}

let state: SessionState = (() => {
  const me = typeof window === 'undefined' ? null : readCached();
  return { status: me ? 'authenticated' : 'checking', me };
})();

const listeners = new Set<() => void>();
function set(next: SessionState) {
  state = next;
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useSession(): SessionState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

interface SessionResponse {
  authenticated?: boolean;
  user?: { id: string | number; name?: string; username?: string; role?: string };
}

let verifying: Promise<void> | null = null;

/** Сверить кэш с сервером. Вызывается один раз при старте. */
export function verifySession(): Promise<void> {
  verifying ??= (async () => {
    try {
      const res = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store' });
      const data = (await res.json().catch(() => ({}))) as SessionResponse;
      if (data.authenticated && data.user) {
        const changed = !state.me || String(state.me.id) !== String(data.user.id);
        writeCached(data.user);
        set({ status: 'authenticated', me: changed ? readCached() : state.me });
      } else if (res.status === 401 || data.authenticated === false) {
        clearCached();
        set({ status: 'anonymous', me: null });
      } else if (!state.me) {
        set({ status: 'anonymous', me: null });
      }
    } catch {
      // Нет сети: с кэшем работаем дальше, без кэша — показываем вход.
      if (!state.me) set({ status: 'anonymous', me: null });
    } finally {
      verifying = null;
    }
  })();
  return verifying;
}

export class LoginError extends Error {}

export async function login(username: string, password: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.trim(), password }),
    });
  } catch {
    throw new LoginError('Нет связи с сервером');
  }
  if (res.status === 401) throw new LoginError('Неверный логин или пароль');
  if (res.status === 429) throw new LoginError('Слишком много попыток входа. Подождите несколько минут и попробуйте снова.');
  if (res.status === 503) throw new LoginError('Сервер сейчас недоступен. Попробуйте через минуту.');
  if (!res.ok) throw new LoginError(`Не удалось войти (код ${res.status}). Попробуйте ещё раз.`);
  const data = (await res.json().catch(() => ({}))) as SessionResponse;
  if (!data.user) throw new LoginError('Сервер не вернул пользователя');
  writeCached(data.user);
  set({ status: 'authenticated', me: readCached() });
}

export async function logout(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  } catch { /* выходим локально в любом случае */ }
  clearCached();
  set({ status: 'anonymous', me: null });
}

/** id вошедшего пользователя ('' — не вошёл). Для кода вне React. */
export function myId(): string {
  return state.me ? String(state.me.id) : '';
}

/** Текущий пользователь — для кода вне React. */
export function currentUser(): User | null {
  return state.me;
}

/** Обновить кэш профиля после правки (имя, аватар) — без повторной проверки сессии. */
export function patchCachedMe(patch: Partial<User>) {
  if (!state.me) return;
  const me = { ...state.me, ...patch } as User;
  try { localStorage.setItem(ME_KEY, JSON.stringify(me)); } catch { /* без кэша */ }
  set({ ...state, me });
}
