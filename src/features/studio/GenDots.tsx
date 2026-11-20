import { useEffect, useRef } from 'react';

/**
 * «Идёт генерация»: поле из сотен точек, по которому бегут волны света — картинка как будто проявляется из шума.
 * Холст, а не сотни DOM-узлов: один кадр — один проход по массиву. Уважает «уменьшить движение» (тогда точки лишь мерцают
 * медленно). Цвета — из темы (акцент), поэтому выглядит своим и в светлой, и в тёмной.
 */
export function GenDots({ label = 'Создаю изображение', compact = false }: { label?: string; compact?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const css = getComputedStyle(canvas);
    const accent = css.getPropertyValue('--accent-color').trim() || '#3b82f6';
    const second = css.getPropertyValue('--gen-second').trim() || '#c026d3';
    let raf = 0;
    let w = 0;
    let h = 0;
    let dots: Array<{ x: number; y: number; seed: number; tint: number }> = [];

    const layout = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = canvas.getBoundingClientRect();
      w = r.width;
      h = r.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const step = compact ? 11 : 14;
      dots = [];
      for (let y = step / 2; y < h; y += step) {
        for (let x = step / 2; x < w; x += step) {
          dots.push({ x: x + (Math.random() - 0.5) * 3, y: y + (Math.random() - 0.5) * 3, seed: Math.random() * Math.PI * 2, tint: Math.random() });
        }
      }
    };

    const draw = (now: number) => {
      const t = now / 1000;
      ctx.clearRect(0, 0, w, h);
      const cx = w / 2;
      const cy = h / 2;
      for (const d of dots) {
        const dx = d.x - cx;
        const dy = d.y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        // Две волны: кольцо от центра и диагональная — их сумма даёт «живой» узор, а не ровную рябь.
        const ring = Math.sin(dist / 22 - t * 2.4);
        const diag = Math.sin((d.x + d.y) / 60 + t * 1.3 + d.seed * 0.4);
        const flick = Math.sin(t * 3 + d.seed * 5);
        const v = calm ? 0.35 + 0.25 * Math.sin(t * 0.6 + d.seed) : Math.max(0, (ring * 0.55 + diag * 0.35 + flick * 0.1 + 0.25));
        const size = 0.7 + v * 1.9;
        ctx.globalAlpha = 0.12 + Math.min(1, v) * 0.85;
        ctx.fillStyle = d.tint > 0.72 ? second : accent;
        ctx.beginPath();
        ctx.arc(d.x, d.y, size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(draw);
    };

    layout();
    raf = requestAnimationFrame(draw);
    const ro = new ResizeObserver(layout);
    ro.observe(canvas);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [compact]);

  return (
    <div className="nst-dots" data-compact={compact || undefined} role="status" aria-live="polite">
      <canvas ref={ref} aria-hidden="true" />
      {label && <span className="nst-dots-label">{label}</span>}
    </div>
  );
}
