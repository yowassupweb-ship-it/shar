import { memo, useState, type CSSProperties } from 'react';
import { Inbox, Mic } from 'lucide-react';
import { initials, tintFor } from './format';

/**
 * Аватар человека: фото → рисованный DiceBear по имени → инициалы. Так же,
 * как везде в старом интерфейсе: у человека без фото не буквы, а картинка.
 * Групповой чат без фото — инициалы на цвете категории (доктрина §4.4).
 * Служебные чаты рисуются значком: Избранное, Уведомления, Заявка.
 * Точка «в сети» и значок активной голосовой комнаты — поверх, в углу.
 */

export type AvatarKind = 'favorites' | 'notifications' | 'request';

const DICEBEAR_COLORS = ['b6e3f4', 'c0aede', 'd1d4f9', 'ffd5dc', 'ffdfbf'] as const;

export function dicebearUrl(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  const color = DICEBEAR_COLORS[Math.abs(hash) % DICEBEAR_COLORS.length];

  // The Thumbs style draws a separate body over its background. Different random
  // colors make that boundary look like a broken crop near the edge of the circle.
  // A shared deterministic color keeps the face varied while the avatar stays solid.
  return `https://api.dicebear.com/9.x/thumbs/svg?seed=${encodeURIComponent(seed)}&backgroundColor=${color}&shapeColor=${color}`;
}

export const Avatar = memo(function Avatar({
  name, seed, src, person, size, kind, online, room,
}: {
  name: string;
  seed: string;
  src?: string;
  /** Это человек (или личный чат) — без фото рисуем DiceBear по имени. */
  person?: boolean;
  size?: number;
  kind?: AvatarKind;
  online?: boolean;
  room?: boolean;
}) {
  const [broken, setBroken] = useState<string[]>([]);
  const style = { '--tint': tintFor(seed), ...(size ? { '--size': `${size}px` } : {}) } as CSSProperties;
  const px = size || 40;
  const glyph = Math.round(px * 0.45);

  let face;
  // Служебные чаты — объёмными иконками (как в меню), а не значком на заливке.
  if (kind === 'favorites') face = <img className="nx-avatar-glyph" src="/icons/nav-v2/izb.png?v=5" alt="" draggable={false} />;
  else if (kind === 'notifications') face = <img className="nx-avatar-glyph" src="/icons/nav-v2/uved.png?v=5" alt="" draggable={false} />;
  else if (kind === 'request') face = <Inbox size={glyph} />;
  else {
    const candidates = [src, person ? dicebearUrl(name || seed) : undefined].filter((u): u is string => Boolean(u) && !broken.includes(u as string));
    const url = candidates[0];
    face = url
      ? <img src={url} alt="" loading="lazy" decoding="async" onError={() => setBroken((b) => [...b, url])} />
      : initials(name);
  }

  return (
    <span className="nx-avatar" style={style} data-kind={kind} data-shape={kind === 'request' ? 'square' : undefined} aria-hidden="true">
      {face}
      {room ? (
        <span className="nx-presence" data-kind="room" title="Идёт голосовая комната"><Mic size={9} /></span>
      ) : online ? (
        <span className="nx-presence" title="В сети" />
      ) : null}
    </span>
  );
});
