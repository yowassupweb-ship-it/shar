import type { CSSProperties } from 'react';

/**
 * Значок папки в деревьях (задачи, «Офис», «Файлы») — три состояния, как в Finder:
 * раскрыта — открытая папка; закрыта и в ней что-то есть — с заливкой и листом внутри; пустая — один контур.
 * Цвет — currentColor (цвет папки задаёт родитель), заливка — тот же цвет, прозрачнее. Рисунок — в духе lucide
 * (сетка 24, линия 2), чтобы стоять рядом с остальными значками.
 */
const BODY = 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z';
const OPEN = 'm6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2';
const OPEN_FLAP = 'M4 20h14.45a2 2 0 0 0 1.95-1.5l1.54-6A2 2 0 0 0 20 10H9.24a2 2 0 0 0-1.74 1.1L4 18Z';
const FILL = 'color-mix(in srgb, currentColor 24%, transparent)';

export default function FolderGlyph({ open = false, empty = false, size = 18, className, style }: {
  open?: boolean; empty?: boolean; size?: number; className?: string; style?: CSSProperties;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      className={className} style={style} aria-hidden="true" data-state={open ? 'open' : empty ? 'empty' : 'full'}>
      {open ? (
        <>
          {!empty && <path d={OPEN_FLAP} fill={FILL} stroke="none" />}
          <path d={OPEN} />
        </>
      ) : empty ? (
        <path d={BODY} />
      ) : (
        <>
          <path d={BODY} fill={FILL} />
          {/* Лист внутри: край выглядывает над передней стенкой. */}
          <path d="M6 10V8.5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1V10" />
          <path d="M2 10h20" />
        </>
      )}
    </svg>
  );
}
