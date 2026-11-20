import type { CSSProperties } from 'react';
import { KINDS } from './kinds';
import type { Kind } from './types';

/**
 * Значок материала «Офиса» — один на весь Шар: тот же рисунок и та же цветная подложка вида (заметка — жёлтая,
 * документ — синяя, таблица — зелёная, презентация — оранжевая), что в самом «Офисе». size — сторона плашки.
 */
export function KindIcon({ kind, size = 32 }: { kind: Kind | string; size?: number }) {
  const info = KINDS[kind as Kind];
  if (!info) return null;
  const Icon = info.icon;
  const style = { '--a': info.tint[0], '--b': info.tint[1], width: size, height: size, borderRadius: Math.round(size * 0.28) } as CSSProperties;
  return (
    <span className="nws-kind-icon" style={style} aria-hidden="true">
      <Icon size={Math.round(size * 0.6)} style={{ width: Math.round(size * 0.6), height: Math.round(size * 0.6) }} />
    </span>
  );
}
