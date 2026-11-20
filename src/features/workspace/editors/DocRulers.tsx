import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

/**
 * Линейки документа, как в Google Документах: сверху — ширина листа с полями слева и справа, слева — высота листа
 * с полями сверху и снизу и отступами колонтитулов. Серым — поля, белым — место для текста. Ползунки тянутся мышью
 * (шаг 0,25 см, с Alt — без шага); во время перетаскивания видна подсказка с размером и пунктир на листе.
 *
 * Размеры — в пикселях листа (как в снимке Univer: A4 = 794×1124 при 96 dpi); подписи — в сантиметрах от начала поля.
 */

export interface PageBox {
  width: number;
  height: number;
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
  /** Расстояние от верхнего края листа до верхнего колонтитула. */
  marginHeader: number;
  /** Расстояние от нижнего края листа до нижнего колонтитула. */
  marginFooter: number;
}

export type MarginKey = 'marginTop' | 'marginBottom' | 'marginLeft' | 'marginRight' | 'marginHeader' | 'marginFooter';

export const PX_PER_CM = 96 / 2.54;
const STEP = PX_PER_CM / 4;
const MIN_TEXT = 2 * PX_PER_CM; // меньше 2 см под текст не оставляем
export const cm = (px: number) => (px / PX_PER_CM).toLocaleString('ru-RU', { maximumFractionDigits: 2 });

const LABEL: Record<MarginKey, string> = {
  marginLeft: 'Поле слева', marginRight: 'Поле справа', marginTop: 'Поле сверху', marginBottom: 'Поле снизу',
  marginHeader: 'Верхний колонтитул', marginFooter: 'Нижний колонтитул',
};

/** Допустимое значение ползунка при текущих остальных полях. */
function clampMargin(page: PageBox, key: MarginKey, value: number): number {
  const v = Math.max(0, Math.round(value));
  switch (key) {
    case 'marginLeft': return Math.min(v, page.width - page.marginRight - MIN_TEXT);
    case 'marginRight': return Math.min(v, page.width - page.marginLeft - MIN_TEXT);
    case 'marginTop': return Math.max(Math.min(v, page.height - page.marginBottom - MIN_TEXT), page.marginHeader + 8);
    case 'marginBottom': return Math.max(Math.min(v, page.height - page.marginTop - MIN_TEXT), page.marginFooter + 8);
    case 'marginHeader': return Math.min(v, page.marginTop - 8);
    case 'marginFooter': return Math.min(v, page.marginBottom - 8);
    default: return v;
  }
}

/** zoom — масштаб листа на экране: сдвиг мыши в пикселях экрана переводим в пиксели листа. */
function useDrag(page: PageBox, onChange: (key: MarginKey, value: number, done: boolean) => void, zoom = 1) {
  const [drag, setDrag] = useState<{ key: MarginKey; value: number } | null>(null);
  const start = useRef({ pos: 0, value: 0 });
  const begin = (key: MarginKey, axis: 'x' | 'y', sign: 1 | -1) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    start.current = { pos: axis === 'x' ? e.clientX : e.clientY, value: page[key] };
    setDrag({ key, value: page[key] });
    const move = (ev: PointerEvent) => {
      const delta = (((axis === 'x' ? ev.clientX : ev.clientY) - start.current.pos) * sign) / zoom;
      const raw = start.current.value + delta;
      const snapped = ev.altKey ? raw : Math.round(raw / STEP) * STEP;
      const value = clampMargin(page, key, snapped);
      setDrag({ key, value });
      onChange(key, value, false);
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      const delta = (((axis === 'x' ? ev.clientX : ev.clientY) - start.current.pos) * sign) / zoom;
      const raw = start.current.value + delta;
      const value = clampMargin(page, key, ev.altKey ? raw : Math.round(raw / STEP) * STEP);
      setDrag(null);
      onChange(key, value, true);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  return { drag, begin };
}

/** Клавиатура на ползунке: стрелки — шаг 0,25 см, с Shift — 1 см. */
function keyNudge(page: PageBox, key: MarginKey, onChange: (key: MarginKey, value: number, done: boolean) => void, grow: string, shrink: string) {
  return (e: React.KeyboardEvent) => {
    const k = e.key === grow ? 1 : e.key === shrink ? -1 : 0;
    if (!k) return;
    e.preventDefault();
    onChange(key, clampMargin(page, key, page[key] + k * (e.shiftKey ? PX_PER_CM : STEP)), true);
  };
}

/** Деления и подписи: каждые 0,25 см черточка, каждый сантиметр — число (от начала поля, как в Google Документах). */
function ticks(length: number, origin: number) {
  const out: Array<{ at: number; kind: 'cm' | 'half' | 'quarter'; label?: number }> = [];
  const first = -Math.floor(origin / STEP);
  const last = Math.floor((length - origin) / STEP);
  for (let i = first; i <= last; i++) {
    const at = origin + i * STEP;
    if (at < 0 || at > length) continue;
    const kind = i % 4 === 0 ? 'cm' : i % 2 === 0 ? 'half' : 'quarter';
    out.push({ at, kind, label: kind === 'cm' && i !== 0 ? Math.abs(i / 4) : undefined });
  }
  return out;
}

export function HorizontalRuler({ page, readOnly, zoom = 1, onChange }: { page: PageBox; readOnly?: boolean; zoom?: number; onChange: (key: MarginKey, value: number, done: boolean) => void }) {
  const { drag, begin } = useDrag(page, onChange, zoom);
  const shown = drag ? { ...page, [drag.key]: drag.value } : page;
  return (
    <div className="fdoc-hruler" style={{ width: page.width }} aria-label="Линейка: поля слева и справа">
      <div className="fdoc-ruler-margin" style={{ left: 0, width: shown.marginLeft }} />
      <div className="fdoc-ruler-margin" style={{ right: 0, width: shown.marginRight }} />
      {ticks(page.width, shown.marginLeft).map((t) => (
        <span key={t.at} className="fdoc-tick" data-kind={t.kind} style={{ left: t.at }}>{t.label !== undefined && <b>{t.label}</b>}</span>
      ))}
      {!readOnly && (['marginLeft', 'marginRight'] as const).map((key) => (
        <button key={key} type="button" className="fdoc-handle" data-axis="x" data-active={drag?.key === key || undefined}
          style={key === 'marginLeft' ? { left: shown.marginLeft } : { left: page.width - shown.marginRight }}
          aria-label={`${LABEL[key]}: ${cm(shown[key])} см`} title={`${LABEL[key]}: ${cm(shown[key])} см`}
          onPointerDown={begin(key, 'x', key === 'marginLeft' ? 1 : -1)}
          onKeyDown={keyNudge(page, key, onChange, key === 'marginLeft' ? 'ArrowRight' : 'ArrowLeft', key === 'marginLeft' ? 'ArrowLeft' : 'ArrowRight')} />
      ))}
      {drag && (
        <>
          <span className="fdoc-guide" data-axis="x" style={{ left: drag.key === 'marginLeft' ? drag.value : page.width - drag.value }} />
          <span className="fdoc-ruler-tip" style={{ left: drag.key === 'marginLeft' ? drag.value : page.width - drag.value }}>{LABEL[drag.key]}: {cm(drag.value)} см</span>
        </>
      )}
    </div>
  );
}

export function VerticalRuler({ page, readOnly, hasHeader, hasFooter, zoom = 1, onChange }: {
  page: PageBox; readOnly?: boolean; hasHeader?: boolean; hasFooter?: boolean; zoom?: number; onChange: (key: MarginKey, value: number, done: boolean) => void;
}) {
  const { drag, begin } = useDrag(page, onChange, zoom);
  const shown = drag ? { ...page, [drag.key]: drag.value } : page;
  const at = (key: MarginKey) => (key === 'marginTop' || key === 'marginHeader' ? shown[key] : page.height - shown[key]);
  const keys: MarginKey[] = ['marginTop', 'marginBottom', ...(hasHeader ? ['marginHeader' as const] : []), ...(hasFooter ? ['marginFooter' as const] : [])];
  return (
    <div className="fdoc-vruler" style={{ height: page.height }} aria-label="Линейка: поля сверху и снизу, колонтитулы">
      <div className="fdoc-ruler-margin" style={{ top: 0, height: shown.marginTop }} />
      <div className="fdoc-ruler-margin" style={{ bottom: 0, height: shown.marginBottom }} />
      {ticks(page.height, shown.marginTop).map((t) => (
        <span key={t.at} className="fdoc-tick" data-kind={t.kind} style={{ top: t.at }}>{t.label !== undefined && <b>{t.label}</b>}</span>
      ))}
      {!readOnly && keys.map((key) => (
        <button key={key} type="button" className="fdoc-handle" data-axis="y" data-kind={key === 'marginHeader' || key === 'marginFooter' ? 'hf' : undefined}
          data-active={drag?.key === key || undefined} style={{ top: at(key) }}
          aria-label={`${LABEL[key]}: ${cm(shown[key])} см`} title={`${LABEL[key]}: ${cm(shown[key])} см`}
          onPointerDown={begin(key, 'y', key === 'marginTop' || key === 'marginHeader' ? 1 : -1)}
          onKeyDown={keyNudge(page, key, onChange, key === 'marginTop' || key === 'marginHeader' ? 'ArrowDown' : 'ArrowUp', key === 'marginTop' || key === 'marginHeader' ? 'ArrowUp' : 'ArrowDown')} />
      ))}
      {drag && (
        <>
          <span className="fdoc-guide" data-axis="y" style={{ top: at(drag.key) }} />
          <span className="fdoc-ruler-tip" data-axis="y" style={{ top: at(drag.key) }}>{LABEL[drag.key]}: {cm(drag.value)} см</span>
        </>
      )}
    </div>
  );
}
