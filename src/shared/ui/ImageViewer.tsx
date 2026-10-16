import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Copy, Download, ExternalLink, MessageSquareText, X } from 'lucide-react';
import { thumbUrl } from './media';
import { downloadOnClick } from '@/shared/platform/download';

/**
 * Просмотр фото на весь экран.
 *
 * Листается вся лента фото чата. Сначала мгновенно показываем превью (оно уже
 * в кэше после ленты), затем подменяем оригиналом. Зум — колесом к курсору,
 * двойным кликом/тапом и щипком; при зуме — перетаскивание. Без зума: свайп
 * вбок — соседнее фото, свайп вниз — закрыть. Клавиатура: ←/→, Esc, +/−/0.
 *
 * Жесты пишут transform прямо в DOM — без перерисовки React на каждый кадр.
 */

export interface ViewerItem {
  url: string;
  author?: string;
  date?: string;
  messageId?: string;
  name?: string;
}

const MIN = 1;
const MAX = 6;

export default function ImageViewer({ items, start, onClose, onJump, onCopy }: {
  items: ViewerItem[];
  start: number;
  onClose: () => void;
  onJump?: (messageId: string) => void;
  onCopy?: (url: string) => void;
}) {
  const [index, setIndex] = useState(() => Math.max(0, Math.min(start, items.length - 1)));
  const [fullLoaded, setFullLoaded] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const view = useRef({ scale: 1, x: 0, y: 0 });
  const item = items[index];

  const apply = useCallback((animate = false) => {
    const img = imgRef.current;
    if (!img) return;
    const { scale, x, y } = view.current;
    img.style.transition = animate ? 'transform .22s cubic-bezier(.22,1,.36,1)' : 'none';
    img.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
    img.style.cursor = scale > 1 ? 'grab' : 'zoom-in';
  }, []);

  const reset = useCallback((animate = true) => {
    view.current = { scale: 1, x: 0, y: 0 };
    apply(animate);
  }, [apply]);

  const go = useCallback((d: number) => {
    setIndex((i) => {
      const n = i + d;
      return n < 0 || n >= items.length ? i : n;
    });
  }, [items.length]);

  useEffect(() => { setFullLoaded(false); reset(false); }, [index, reset]);

  // Фото — на весь экран, по большей стороне, которая упрётся первой (как в
  // «Фото» iOS): верхняя полоса и лента миниатюр лежат поверх, а не отнимают
  // высоту. Раньше картинка стояла в своём натуральном размере между ними —
  // превью 640px и небольшие фото не доставали ни до верха, ни до низа.
  const fit = useCallback(() => {
    const img = imgRef.current;
    const stage = stageRef.current;
    if (!img || !stage || !img.naturalWidth || !img.naturalHeight) return;
    const k = Math.min(stage.clientWidth / img.naturalWidth, stage.clientHeight / img.naturalHeight);
    img.style.width = `${Math.floor(img.naturalWidth * k)}px`;
    img.style.height = `${Math.floor(img.naturalHeight * k)}px`;
  }, []);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const ro = new ResizeObserver(() => fit());
    ro.observe(stage);
    return () => ro.disconnect();
  }, [fit]);

  // Соседние оригиналы — заранее.
  useEffect(() => {
    for (const d of [1, -1]) {
      const nb = items[index + d];
      if (nb) { const im = new Image(); im.src = nb.url; }
    }
    stripRef.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [index, items]);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => prev?.focus?.();
  }, []);

  // Зум к точке: точка под курсором остаётся на месте.
  const zoomAt = useCallback((next: number, cx: number, cy: number, animate = false) => {
    const stage = stageRef.current;
    if (!stage) return;
    const r = stage.getBoundingClientRect();
    const px = cx - (r.left + r.width / 2);
    const py = cy - (r.top + r.height / 2);
    const v = view.current;
    const s = Math.max(MIN, Math.min(MAX, next));
    const k = s / v.scale;
    v.x = px - (px - v.x) * k;
    v.y = py - (py - v.y) * k;
    v.scale = s;
    if (s === 1) { v.x = 0; v.y = 0; }
    apply(animate);
  }, [apply]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === '+' || e.key === '=') { const r = stageRef.current?.getBoundingClientRect(); if (r) zoomAt(view.current.scale * 1.4, r.left + r.width / 2, r.top + r.height / 2, true); }
      else if (e.key === '-') { const r = stageRef.current?.getBoundingClientRect(); if (r) zoomAt(view.current.scale / 1.4, r.left + r.width / 2, r.top + r.height / 2, true); }
      else if (e.key === '0') reset();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [go, onClose, reset, zoomAt]);

  // Колесо — зум (без модификаторов тоже: прокручивать тут нечего).
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(view.current.scale * Math.exp(-e.deltaY * 0.0022), e.clientX, e.clientY);
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  // ── Указатели: перетаскивание, щипок, свайпы ──────────────────────────────
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({ sx: 0, sy: 0, vx: 0, vy: 0, mode: 'none' as 'none' | 'pan' | 'swipe' | 'pinch', pinchD: 0, pinchS: 1, t: 0, tapAt: 0 });

  // После перетаскивания браузер присылает click — он не должен закрывать просмотр.
  const suppressClick = useRef(false);
  const setBackdrop = (a: number) => rootRef.current?.style.setProperty('--viewer-bg', String(a));

  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, a')) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (pts.current.size === 2) {
      const [a, b] = Array.from(pts.current.values());
      g.mode = 'pinch';
      g.pinchD = Math.hypot(a.x - b.x, a.y - b.y);
      g.pinchS = view.current.scale;
      return;
    }
    g.sx = e.clientX; g.sy = e.clientY; g.vx = view.current.x; g.vy = view.current.y; g.t = performance.now();
    g.mode = view.current.scale > 1 ? 'pan' : 'swipe';
  };

  const onMove = (e: React.PointerEvent) => {
    if (!pts.current.has(e.pointerId)) return;
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    const img = imgRef.current;
    if (g.mode === 'pinch' && pts.current.size >= 2) {
      const [a, b] = Array.from(pts.current.values());
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt(g.pinchS * (d / (g.pinchD || d)), (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    const dx = e.clientX - g.sx;
    const dy = e.clientY - g.sy;
    if (g.mode === 'pan') {
      view.current.x = g.vx + dx;
      view.current.y = g.vy + dy;
      apply();
    } else if (g.mode === 'swipe' && img) {
      // Вниз — закрытие с затуханием фона; вбок — к соседнему фото.
      if (Math.abs(dy) > Math.abs(dx) && dy > 0) {
        img.style.transition = 'none';
        img.style.transform = `translate3d(0, ${dy}px, 0) scale(${1 - Math.min(dy / 1600, 0.15)})`;
        setBackdrop(Math.max(0.2, 1 - dy / 500));
      } else {
        img.style.transition = 'none';
        img.style.transform = `translate3d(${dx}px, 0, 0)`;
      }
    }
  };

  const onUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    pts.current.delete(e.pointerId);
    if (g.mode === 'pinch') {
      if (pts.current.size < 2) { g.mode = 'none'; if (view.current.scale <= 1.02) reset(); }
      return;
    }
    const dx = e.clientX - g.sx;
    const dy = e.clientY - g.sy;
    const dt = performance.now() - g.t;
    const moved = Math.hypot(dx, dy) > 8;
    suppressClick.current = moved;
    if (!moved) {
      // Тап: двойной — зум к точке / сброс.
      const now = performance.now();
      if (now - g.tapAt < 300) {
        g.tapAt = 0;
        if (view.current.scale > 1) reset(); else zoomAt(2.5, e.clientX, e.clientY, true);
      } else {
        g.tapAt = now;
      }
      g.mode = 'none';
      return;
    }
    if (g.mode === 'swipe') {
      const fast = dt < 250;
      if (dy > 120 || (fast && dy > 60 && Math.abs(dy) > Math.abs(dx))) { onClose(); return; }
      setBackdrop(1);
      if (Math.abs(dx) > Math.abs(dy) && (Math.abs(dx) > 80 || (fast && Math.abs(dx) > 40))) {
        const d = dx < 0 ? 1 : -1;
        if (items[index + d]) { go(d); return; }
      }
      reset();
    }
    g.mode = 'none';
  };

  useLayoutEffect(() => { apply(); }, [apply, index]);

  if (!item || typeof document === 'undefined') return null;
  const root = document.querySelector('.nx') || document.body;
  const preview = thumbUrl(item.url, 640);

  return createPortal(
    <div ref={rootRef} className="nxv" role="dialog" aria-modal="true" aria-label="Просмотр фото">
      <header className="nxv-bar">
        <div className="nxv-meta">
          {item.author && <b>{item.author}</b>}
          <span>{[item.date, items.length > 1 ? `${index + 1} из ${items.length}` : ''].filter(Boolean).join(' · ')}</span>
        </div>
        <div className="nxv-actions">
          {onJump && item.messageId && (
            <button type="button" className="nxv-btn" onClick={() => { onJump(item.messageId!); onClose(); }} aria-label="Перейти к сообщению" title="Перейти к сообщению">
              <MessageSquareText size={18} />
            </button>
          )}
          {onCopy && (
            <button type="button" className="nxv-btn" onClick={() => onCopy(item.url)} aria-label="Копировать картинку" title="Копировать">
              <Copy size={18} />
            </button>
          )}
          <a className="nxv-btn" href={item.url} download={item.name || true} onClick={downloadOnClick(item.url, item.name)} aria-label="Скачать" title="Скачать"><Download size={18} /></a>
          <a className="nxv-btn" href={item.url} target="_blank" rel="noopener noreferrer" aria-label="Открыть оригинал" title="Открыть оригинал"><ExternalLink size={18} /></a>
          <button ref={closeRef} type="button" className="nxv-btn" onClick={onClose} aria-label="Закрыть" title="Закрыть (Esc)"><X size={20} /></button>
        </div>
      </header>

      <div
        ref={stageRef}
        className="nxv-stage"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onClick={(e) => {
          if (suppressClick.current) { suppressClick.current = false; return; }
          if (e.target === e.currentTarget && view.current.scale === 1) onClose();
        }}
      >
        <img
          ref={imgRef}
          key={item.url}
          className="nxv-img"
          src={fullLoaded || preview === item.url ? item.url : preview}
          alt={item.name || ''}
          draggable={false}
          onLoad={() => {
            fit();
            if (fullLoaded || preview === item.url) return;
            // Превью на экране — грузим оригинал и подменяем без мигания.
            const full = new Image();
            full.onload = () => setFullLoaded(true);
            full.src = item.url;
          }}
        />
      </div>

      {items.length > 1 && (
        <>
          <button type="button" className="nxv-nav" data-dir="prev" disabled={index === 0} onClick={() => go(-1)} aria-label="Предыдущее фото"><ChevronLeft size={26} /></button>
          <button type="button" className="nxv-nav" data-dir="next" disabled={index === items.length - 1} onClick={() => go(1)} aria-label="Следующее фото"><ChevronRight size={26} /></button>
          <div ref={stripRef} className="nxv-strip" role="tablist" aria-label="Все фото">
            {items.map((it, i) => (
              <button
                key={`${it.url}-${i}`}
                type="button"
                className="nxv-thumb"
                aria-current={i === index ? 'true' : undefined}
                onClick={() => setIndex(i)}
                aria-label={`Фото ${i + 1}`}
              >
                <img src={thumbUrl(it.url, 64)} alt="" loading="lazy" draggable={false} />
              </button>
            ))}
          </div>
        </>
      )}
    </div>,
    root,
  );
}
