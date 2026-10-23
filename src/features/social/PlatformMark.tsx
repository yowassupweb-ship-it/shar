import type { Platform } from './api';

const MARK: Record<Platform, { src: string; label: string }> = {
  vk: { src: '/icons/social/vk.png', label: 'ВКонтакте' },
  max: { src: '/icons/social/max.png', label: 'MAX' },
  telegram: { src: '/icons/social/tg.png', label: 'Telegram' },
};

/** Значок площадки (те же, что на корпоративном сайте): у каждого диалога — своя, а список общий. */
export function PlatformMark({ platform, size = 18 }: { platform: Platform; size?: number }) {
  const mark = MARK[platform] || MARK.vk;
  return <img className="nsd-mark" src={mark.src} alt={mark.label} title={mark.label} width={size} height={size} draggable={false} />;
}
