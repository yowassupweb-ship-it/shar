import { Avatar } from '@/shared/ui/Avatar';
import type { Platform } from './api';
import { PlatformMark } from './PlatformMark';

/** Фото собеседника с площадки (нет фото — рисованный аватар по имени) и значок площадки в углу. */
export function SocialAvatar({ platform, name, seed, src, size = 36 }: { platform: Platform; name: string; seed: string; src?: string; size?: number }) {
  return (
    <span className="nsd-avatar" style={{ width: size, height: size }}>
      <Avatar name={name} seed={seed} src={src || undefined} person size={size} />
      <span className="nsd-avatar-mark"><PlatformMark platform={platform} size={Math.max(16, Math.round(size * 0.46))} /></span>
    </span>
  );
}
