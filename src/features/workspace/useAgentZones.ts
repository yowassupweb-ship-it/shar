import { useEffect, useState } from 'react';
import { realtime } from '@/shared/realtime/realtime';

/** Зона, где сейчас работает агент: цитата документа и подпись («Claude: переписываю оплату»). */
export interface AgentZone { id: string; label: string; quote: string; until: number; color?: string }

const AGENT_COLOR = '#7c5cff';

/**
 * Зоны агентов в открытом документе: при открытии — с сервера, дальше — событием workspace_zones (агент занял,
 * продлил, отпустил). Истёкшие убираем сами: агент мог упасть, не отпустив зону.
 */
export function useAgentZones(itemId: string | null, enabled: boolean): AgentZone[] {
  const [zones, setZones] = useState<AgentZone[]>([]);
  useEffect(() => {
    setZones([]);
    if (!itemId || !enabled) return undefined;
    let alive = true;
    const take = (list: unknown) => {
      if (!alive || !Array.isArray(list)) return;
      setZones((list as AgentZone[]).map((z) => ({ ...z, color: AGENT_COLOR })));
    };
    fetch(`/api/workspace/items/${encodeURIComponent(itemId)}/zones`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null)).then((j) => take(j?.zones)).catch(() => undefined);
    const off = realtime.subscribe((event) => {
      const e = event as { type?: string; itemId?: string; zones?: unknown };
      if (e.type === 'workspace_zones' && String(e.itemId) === String(itemId)) take(e.zones);
    });
    const timer = window.setInterval(() => {
      const now = Date.now() / 1000;
      setZones((cur) => (cur.some((z) => z.until <= now) ? cur.filter((z) => z.until > now) : cur));
    }, 2000);
    return () => { alive = false; off(); window.clearInterval(timer); };
  }, [itemId, enabled]);
  return zones;
}
