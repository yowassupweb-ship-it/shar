import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { realtime } from '@/shared/realtime/realtime';
import { hueOf } from './PresenceStack';
import type { Viewer } from './types';

/** Позиция в материале. Понимает её только редактор того же вида; сервер передаёт как есть. */
export type CursorPos = Record<string, unknown>;

/** Курсор коллеги: кто, каким цветом рисовать, где стоит и когда двигался последний раз. */
export interface RemoteCursor { userId: string; name: string; color: string; pos: CursorPos; movedAt: number }

const SEND_MS = 80;
/** Курсор человека, которого нет в присутствии, держим столько после его последнего движения (вдруг он закрыл окно аварийно). */
const STALE_MS = 10 * 60_000;

export const cursorColor = (userId: string) => `hsl(${hueOf(userId)} 70% 50%)`;

/**
 * Курсоры, как в Google Docs: своя позиция уходит коллегам в этом же материале (по сокету, не чаще ~12 раз
 * в секунду), их позиции приходят сюда. Показываем только тех, кто сейчас в материале (присутствие), —
 * ушёл человек, исчез и его курсор. Вошёл новый — получает нашу позицию сразу, не дожидаясь движения.
 */
export function useCursors(itemId: string | null, viewers: Viewer[]) {
  const [positions, setPositions] = useState<Record<string, { pos: CursorPos; movedAt: number }>>({});
  const last = useRef<CursorPos | null>(null);
  const timer = useRef(0);
  const sentAt = useRef(0);

  const flush = useCallback(() => {
    timer.current = 0;
    sentAt.current = Date.now();
    if (itemId) realtime.send({ type: 'cursor', itemId, cursor: last.current });
  }, [itemId]);

  const send = useCallback((pos: CursorPos | null) => {
    if (JSON.stringify(pos) === JSON.stringify(last.current)) return;
    last.current = pos;
    if (timer.current) return;
    const wait = Math.max(0, SEND_MS - (Date.now() - sentAt.current));
    timer.current = window.setTimeout(flush, wait);
  }, [flush]);

  useEffect(() => {
    setPositions({});
    if (!itemId) return undefined;
    const off = realtime.subscribe((event) => {
      const e = event as { type?: string; itemId?: string; userId?: string; cursor?: CursorPos | null };
      if (e.type !== 'workspace_cursor' || String(e.itemId) !== String(itemId) || !e.userId) return;
      const uid = String(e.userId);
      setPositions((cur) => {
        const next = { ...cur };
        if (e.cursor) next[uid] = { pos: e.cursor, movedAt: Date.now() };
        else delete next[uid];
        return next;
      });
    });
    return () => {
      off();
      window.clearTimeout(timer.current);
      timer.current = 0;
      // Ушли из материала — убираем свой курсор у коллег сразу.
      if (last.current) realtime.send({ type: 'cursor', itemId, cursor: null });
      last.current = null;
    };
  }, [itemId]);

  // Новый человек в материале — пусть сразу увидит, где мы.
  const viewerKey = viewers.map((v) => v.userId).sort().join(',');
  const known = useRef('');
  useEffect(() => {
    const before = known.current.split(',').filter(Boolean);
    known.current = viewerKey;
    const joined = viewerKey.split(',').some((id) => id && !before.includes(id));
    if (joined && last.current && !timer.current) flush();
  }, [viewerKey, flush]);

  // Курсор держим, пока человек не закрыл материал (тогда приходит cursor: null), а не пока он в «присутствии»:
  // присутствие в Shar OS следует за вниманием — окно коллеги потеряло фокус или он отошёл, и он выпадал из списка.
  // У того, кто в этот момент двигался (и потому перечитывал присутствие), клетка коллеги пропадала. Имя помним с
  // последнего раза, когда человек был в списке; курсор без движения дольше STALE_MS и без присутствия — убираем.
  const names = useRef<Record<string, string>>({});
  viewers.forEach((v) => { names.current[String(v.userId)] = v.name; });
  const cursors = useMemo<RemoteCursor[]>(() => {
    const present = new Set(viewers.map((v) => String(v.userId)));
    const now = Date.now();
    return Object.entries(positions)
      .filter(([id, p]) => names.current[id] && (present.has(id) || now - p.movedAt < STALE_MS))
      .map(([id, p]) => ({ userId: id, name: names.current[id], color: cursorColor(id), pos: p.pos, movedAt: p.movedAt }));
  }, [viewers, positions]);

  return { cursors, send };
}
