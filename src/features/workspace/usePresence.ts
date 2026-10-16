import { useEffect, useRef, useState } from 'react';
import { realtime } from '@/shared/realtime/realtime';
import { myId } from '@/shared/session/session';
import { workspaceApi } from './api';
import type { Viewer } from './types';

const BEAT_MS = 15_000;

/**
 * Присутствие, как в Google Docs: кто сейчас открыл этот материал и кто в нём печатает.
 * Входим при открытии, подтверждаем присутствие каждые 15 с (сервер забывает через 25 с), выходим при закрытии.
 * Состав приходит и по живому каналу (`workspace_presence`) — аватарки появляются и исчезают сразу.
 * `editing` — у человека есть несохранённые правки; смена флага отправляется немедленно.
 */
export function usePresence(itemId: string | null, editing: boolean): Viewer[] {
  const [viewers, setViewers] = useState<Viewer[]>([]);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const beat = useRef<(state: 'join' | 'beat' | 'leave') => void>(() => undefined);

  useEffect(() => {
    setViewers([]);
    if (!itemId) return undefined;
    let alive = true;
    const send = (state: 'join' | 'beat' | 'leave') => {
      workspaceApi.presence(itemId, state, editingRef.current).then((result) => { if (alive && state !== 'leave') setViewers(result.viewers); }).catch(() => undefined);
    };
    beat.current = send;
    send('join');
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') send('beat'); }, BEAT_MS);
    const onShow = () => { if (document.visibilityState === 'visible') send('beat'); };
    document.addEventListener('visibilitychange', onShow);
    const off = realtime.subscribe((event) => {
      const e = event as { type?: string; itemId?: string; viewers?: Viewer[] };
      if (e.type === 'workspace_presence' && String(e.itemId) === String(itemId) && Array.isArray(e.viewers)) setViewers(e.viewers);
    });
    // Закрыли окно или вкладку: сообщаем сразу, иначе аватарка висела бы ещё 25 секунд.
    const onHide = () => {
      try {
        void fetch(`/api/workspace/items/${encodeURIComponent(itemId)}/presence`, {
          method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 'leave', editing: false }),
        });
      } catch { /* закрывается — не критично */ }
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onShow);
      window.removeEventListener('pagehide', onHide);
      off();
      send('leave');
    };
  }, [itemId]);

  // Начал или закончил печатать — сообщаем сразу, не дожидаясь очередного «я здесь».
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (itemId) beat.current('beat');
  }, [editing, itemId]);

  const me = myId();
  return viewers.filter((v) => String(v.userId) !== me);
}
