import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

/**
 * Линейки как в Google Документах.
 *
 * Сверху — полоса на всю ширину под панелью; в ней дорожка шириной с лист: серое — поля, белое — место под текст,
 * деления каждые 0,25 см, числа — сантиметры от начала поля. Граница серого и белого тянется — это поле листа.
 * Синие маркеры — отступы абзаца, где курсор: слева треугольник (отступ слева) и прямоугольник над ним (красная строка),
 * справа треугольник (отступ справа). Слева — вертикальная линейка у края окна, по одной на лист: поля сверху и снизу.
 *
 * Размеры — в пикселях листа (A4 = 794×1124 при 96 dpi), отступы абзаца — в pt (как в стиле абзаца Univer).
 */

export interface PageBox {
  width: number;
  height: number;
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
  marginHeader: number;
  marginFooter: number;
}
export type MarginKey = 'marginTop' | 'marginBottom' | 'marginLeft' | 'marginRight' | 'marginHeader' | 'marginFooter';
/** Отступы абзаца в pt: слева, красная строка (относительно левого), справа. */
export interface Indents { start: number; firstLine: number; end: number }
export type IndentKey = keyof Indents;

export const PX_PER_CM = 96 / 2.54;
const PX_PER_PT = 96 / 72;
const STEP = PX_PER_CM / 4;
const MIN_TEXT = 2 * PX_PER_CM;
export const cm = (px: number) => (px / PX_PER_CM).toLocaleString('ru-RU', { maximumFractionDigits: 2 });

const LABEL: Record<MarginKey | IndentKey, string> = {
  marginLeft: 'Поле слева', marginRight: 'Поле справа', marginTop: 'Поле сверху', marginBottom: 'Поле снизу',
  marginHeader: 'Верхний колонтитул', marginFooter: 'Нижний колонтитул',
  start: 'Отступ слева', firstLine: 'Отступ первой строки', end: 'Отступ справа',
};

function clampMargin(page: PageBox, key: MarginKey, value: number): number {
  const v = Math.max(0, Math.round(value));
  switch (key) {
    case 'marginLeft': return Math.min(v, page.width - page.marginRight - MIN_TEXT);
    case 'marginRight': return Math.min(v, page.width - page.marginLeft - MIN_TEXT);
    case 'marginTop': return Math.max(Math.min(v, page.height - page.marginBottom - MIN_TEXT), page.marginHeader + 8);
    case 'marginBottom': return Math.max(Math.min(v, page.height - page.marginTop - MIN_TEXT), page.marginFooter + 8);
    default: return v;
  }
}

/** Перетаскивание: сдвиг мыши (в пикселях экрана, с учётом масштаба) → новое значение с шагом 0,25 см (Alt — без шага). */
function drag(e: ReactPointerEvent<HTMLElement>, axis: 'x' | 'y', zoom: number, start: number, step: number,
  apply: (raw: number) => number, onMove: (value: number) => void, onDone: (value: number) => void) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const el = e.currentTarget;
  el.setPointerCapture(e.pointerId);
  const from = axis === 'x' ? e.clientX : e.clientY;
  const calc = (ev: PointerEvent) => {
    const raw = start + ((axis === 'x' ? ev.clientX : ev.clientY) - from) / zoom;
    return apply(ev.altKey ? raw : Math.round(raw / step) * step);
  };
  const move = (ev: PointerEvent) => onMove(calc(ev));
  const up = (ev: PointerEvent) => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    onDone(calc(ev));
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

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

export function HorizontalRuler({ page, zoom = 1, readOnly, indents, onMargin, onIndent }: {
  page: PageBox; zoom?: number; readOnly?: boolean; indents: Indents | null;
  onMargin: (key: MarginKey, value: number, done: boolean) => void;
  onIndent: (key: IndentKey, value: number, done: boolean) => void;
}) {
  const [live, setLive] = useState<{ key: MarginKey | IndentKey; value: number } | null>(null);
  const shown = { ...page, ...(live && live.key.startsWith('margin') ? { [live.key]: live.value } : {}) } as PageBox;
  const ind = indents ? { ...indents, ...(live && !live.key.startsWith('margin') ? { [live.key]: live.value } : {}) } as Indents : null;
  const left = shown.marginLeft;
  const right = page.width - shown.marginRight;
  // Положения маркеров отступов в пикселях листа.
  const at = ind ? {
    start: left + ind.start * PX_PER_PT,
    firstLine: left + (ind.start + ind.firstLine) * PX_PER_PT,
    end: right - ind.end * PX_PER_PT,
  } : null;
  const margin = (key: 'marginLeft' | 'marginRight') => (e: ReactPointerEvent<HTMLElement>) => drag(e, 'x', zoom, page[key], STEP,
    (raw) => clampMargin(page, key, key === 'marginLeft' ? raw : raw), (v) => { setLive({ key, value: v }); onMargin(key, v, false); },
    (v) => { setLive(null); onMargin(key, v, true); });
  // Отступ: тянем маркер, значение — в pt от поля (у красной строки — от левого отступа). Шаг — 0,25 см.
  const indent = (key: IndentKey) => (e: ReactPointerEvent<HTMLElement>) => {
    if (!indents) return;
    const width = (page.width - page.marginLeft - page.marginRight) / PX_PER_PT;
    const sign = key === 'end' ? -1 : 1;
    drag(e, 'x', zoom * sign, indents[key] * PX_PER_PT, STEP, (raw) => {
      const pt = raw / PX_PER_PT;
      if (key === 'firstLine') return Math.round(Math.max(-indents.start, Math.min(width - indents.end - indents.start - 30, pt)));
      if (key === 'start') return Math.round(Math.max(0, Math.min(width - indents.end - 30, pt)));
      return Math.round(Math.max(0, Math.min(width - indents.start - 30, pt)));
    }, (v) => { setLive({ key, value: v }); onIndent(key, v, false); }, (v) => { setLive(null); onIndent(key, v, true); });
  };
  const tipAt = live ? (live.key === 'marginLeft' ? left : live.key === 'marginRight' ? right : at ? at[live.key as IndentKey] : 0) : 0;
  const tipVal = live ? (live.key.startsWith('margin') ? live.value : live.value * PX_PER_PT) : 0;

  return (
    <div className="fdoc-hruler" style={{ width: page.width }} aria-label="Линейка">
      <div className="fdoc-ruler-margin" style={{ left: 0, width: left }} />
      <div className="fdoc-ruler-margin" style={{ right: 0, width: shown.marginRight }} />
      {ticks(page.width, left).map((t) => (
        <span key={t.at} className="fdoc-tick" data-kind={t.kind} style={{ left: t.at }}>{t.label !== undefined && <b>{t.label}</b>}</span>
      ))}
      {!readOnly && (
        <>
          <span className="fdoc-mgrip" style={{ left }} title={`${LABEL.marginLeft}: ${cm(left)} см`} onPointerDown={margin('marginLeft')} />
          <span className="fdoc-mgrip" style={{ left: right }} title={`${LABEL.marginRight}: ${cm(shown.marginRight)} см`} onPointerDown={margin('marginRight')} />
        </>
      )}
      {at && !readOnly && (
        <>
          <span className="fdoc-ind fdoc-ind-first" style={{ left: at.firstLine }} title={LABEL.firstLine} onPointerDown={indent('firstLine')} />
          <span className="fdoc-ind fdoc-ind-start" style={{ left: at.start }} title={LABEL.start} onPointerDown={indent('start')} />
          <span className="fdoc-ind fdoc-ind-end" style={{ left: at.end }} title={LABEL.end} onPointerDown={indent('end')} />
        </>
      )}
      {live && (
        <>
          <span className="fdoc-guide" data-axis="x" style={{ left: tipAt }} />
          <span className="fdoc-ruler-tip" style={{ left: tipAt }}>{LABEL[live.key]}: {cm(tipVal)} см</span>
        </>
      )}
    </div>
  );
}

/** Вертикальная линейка одного листа: поля сверху и снизу. */
export function VerticalRuler({ page, zoom = 1, readOnly, onMargin }: {
  page: PageBox; zoom?: number; readOnly?: boolean; onMargin: (key: MarginKey, value: number, done: boolean) => void;
}) {
  const [live, setLive] = useState<{ key: MarginKey; value: number } | null>(null);
  const shown = live ? { ...page, [live.key]: live.value } : page;
  const top = shown.marginTop;
  const bottom = page.height - shown.marginBottom;
  const grip = (key: 'marginTop' | 'marginBottom') => (e: ReactPointerEvent<HTMLElement>) => drag(e, 'y', key === 'marginTop' ? zoom : -zoom, page[key], STEP,
    (raw) => clampMargin(page, key, raw), (v) => { setLive({ key, value: v }); onMargin(key, v, false); }, (v) => { setLive(null); onMargin(key, v, true); });
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} className="fdoc-vruler" style={{ height: page.height }} aria-hidden="true">
      <div className="fdoc-ruler-margin" style={{ top: 0, height: top }} />
      <div className="fdoc-ruler-margin" style={{ bottom: 0, height: shown.marginBottom }} />
      {ticks(page.height, top).map((t) => (
        <span key={t.at} className="fdoc-tick" data-kind={t.kind} style={{ top: t.at }}>{t.label !== undefined && <b>{t.label}</b>}</span>
      ))}
      {!readOnly && (
        <>
          <span className="fdoc-mgrip" data-axis="y" style={{ top }} title={`${LABEL.marginTop}: ${cm(top)} см`} onPointerDown={grip('marginTop')} />
          <span className="fdoc-mgrip" data-axis="y" style={{ top: bottom }} title={`${LABEL.marginBottom}: ${cm(shown.marginBottom)} см`} onPointerDown={grip('marginBottom')} />
        </>
      )}
      {live && <span className="fdoc-ruler-tip" data-axis="y" style={{ top: live.key === 'marginTop' ? top : bottom }}>{LABEL[live.key]}: {cm(live.value)} см</span>}
    </div>
  );
}
