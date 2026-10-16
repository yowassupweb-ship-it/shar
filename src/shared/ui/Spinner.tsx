import type { CSSProperties } from 'react';

const BARS = [0, 1, 2, 3, 4, 5, 6, 7];

/**
 * Индикатор загрузки как в macOS и iOS: восемь палочек по кругу, яркость бежит по часовой стрелке.
 * Цвет — цвет текста вокруг (в кнопке — как надпись, в пустом состоянии — приглушённый).
 * label — для экранного диктора, когда рядом нет текста; без него спиннер скрыт от диктора как украшение.
 */
export function Spinner({ size = 20, label, className }: { size?: number; label?: string; className?: string }) {
  return (
    <span
      className={className ? `nx-spinner ${className}` : 'nx-spinner'}
      style={{ '--spinner-size': `${size}px` } as CSSProperties}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {BARS.map((i) => <i key={i} style={{ '--i': i } as CSSProperties} />)}
    </span>
  );
}
