import { Avatar } from '@/shared/ui/Avatar';
import type { Viewer } from './types';

const MAX_SHOWN = 4;

/** Цвет кольца у человека постоянный (по его id): коллега в разных материалах узнаётся по одному цвету. */
export function hueOf(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

/**
 * Кто сейчас в материале — стопка аватарок в шапке, как в Google Docs. Тот, кто печатает, подсвечен
 * пульсирующим кольцом; подсказка называет имя и что человек делает.
 */
export function PresenceStack({ viewers, size = 26, ownTips = false }: { viewers: Viewer[]; size?: number; /** Имя у каждого аватара — своей быстрой подсказкой (шапка материала), без нативной на всю стопку. */ ownTips?: boolean }) {
  if (!viewers.length) return null;
  const shown = viewers.slice(0, MAX_SHOWN);
  const more = viewers.length - shown.length;
  const label = viewers.map((v) => `${v.name} — ${v.editing ? 'печатает' : 'смотрит'}`).join('\n');
  return (
    <span className="nws-presence" role="group" aria-label={`Сейчас в материале: ${viewers.map((v) => v.name).join(', ')}`} title={ownTips ? undefined : label}>
      {shown.map((v) => (
        <span key={v.userId} className="nws-presence-one" data-editing={v.editing || undefined} data-tip={ownTips ? `${v.name} — ${v.editing ? 'печатает' : 'смотрит'}` : undefined} style={{ '--ring': `hsl(${hueOf(String(v.userId))} 70% 60%)` } as React.CSSProperties}>
          <Avatar name={v.name} seed={String(v.userId)} src={v.avatar || undefined} person size={size} />
        </span>
      ))}
      {more > 0 && <span className="nws-presence-more">+{more}</span>}
    </span>
  );
}
