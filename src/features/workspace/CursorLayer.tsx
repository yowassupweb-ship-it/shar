import type { CSSProperties } from 'react';

/** Курсор коллеги, уже переведённый в точки слоя: каретка и прямоугольники выделения (по строкам). */
export interface CursorShape {
  userId: string;
  name: string;
  color: string;
  movedAt: number;
  caret: { x: number; y: number; h: number } | null;
  boxes: Array<{ x: number; y: number; w: number; h: number }>;
}

/**
 * Чужие курсоры поверх текста, как в Google Docs: цветная каретка, флажок с именем (виден несколько секунд
 * после движения, потом сжимается в квадратик у каретки) и выделение цветом человека. Клики проходят насквозь.
 */
export function CursorLayer({ shapes, style }: { shapes: CursorShape[]; style?: CSSProperties }) {
  if (!shapes.length) return null;
  return (
    <div className="nws-cursors" style={style} aria-hidden="true">
      {shapes.map((s) => (
        <div key={s.userId} style={{ '--c': s.color } as CSSProperties}>
          {s.boxes.map((b, i) => <span key={i} className="nws-cursor-sel" style={{ left: b.x, top: b.y, width: b.w, height: b.h }} />)}
          {s.caret && (
            <span className="nws-cursor" style={{ left: s.caret.x, top: s.caret.y, height: s.caret.h }}>
              <span key={s.movedAt} className="nws-cursor-flag">{s.name}</span>
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
