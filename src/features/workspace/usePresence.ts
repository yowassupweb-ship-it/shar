import { useEffect, useRef, useState } from 'react';
import { realtime } from '@/shared/realtime/realtime';
import { isReadingNow, subscribeAttention } from '@/shared/platform/push/userAttention';
import { myId } from '@/shared/session/session';
import { workspaceApi } from './api';
import type { Viewer } from './types';

const BEAT_MS = 15_000;

/**
 * Присутствие, как в Google Docs: кто сейчас открыл этот материал и кто в нём печатает.
 * Входим при открытии, подтверждаем присутствие каждые 15 с (сервер забывает через 25 с), выходим при закрытии.
 * Состав приходит и по живому каналу (`workspace_presence`) — аватарки появляются и исчезают сразу.
 * `editing` — у человека есть несохранённые правки; смена флага отправляется немедленно.
 *
 * В материале — пока окно перед глазами (isReadingNow). Shar OS при закрытии прячет окно в трей, а страница там
 * остаётся «visible»: по одной видимости человек «сидел» в документе часами. Спрятал или свернул окно — выходим
 * сразу, вернулся — входим снова.
 */
export function usePresence(itemId: string | null, editing: boolean): Viewer[] {
  const [viewers, setViewers] = useState<Viewer[]>([]);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const beat = useRef<(state: 'join' | 'beat' | 'leave') => void>(() => undefined);
  const here = useRef(false);

  useEffect(() => {
    setViewers([]);
    if (!itemId) return undefined;
    let alive = true;
    const send = (state: 'join' | 'beat' | 'leave') => {
      here.current = state !== 'leave';
      workspaceApi.presence(itemId, state, editingRef.current).then((result) => { if (alive && state !== 'leave') setViewers(result.viewers); }).catch(() => undefined);
    };
    beat.current = send;
    if (isReadingNow()) send('join');
    const timer = window.setInterval(() => { if (isReadingNow()) send('beat'); }, BEAT_MS);
    const onAttention = () => {
      const now = isReadingNow();
      if (now !== here.current) send(now ? 'beat' : 'leave');
    };
    const offAttention = subscribeAttention(onAttention);
    document.addEventListener('visibilitychange', onAttention);
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
      offAttention();
      document.removeEventListener('visibilitychange', onAttention);
      window.removeEventListener('pagehide', onHide);
      off();
      send('leave');
    };
  }, [itemId]);

  // Начал или закончил печатать — сообщаем сразу, не дожидаясь очередного «я здесь».
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (itemId && here.current) beat.current('beat');
  }, [editing, itemId]);

  const me = myId();
  return viewers.filter((v) => String(v.userId) !== me);
}
