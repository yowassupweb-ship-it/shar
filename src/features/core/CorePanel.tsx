import { lazy, Suspense, useEffect, useState, type CSSProperties, type PointerEvent } from 'react';
import { closeCorePanel, setCorePanelWidth, toggleCorePanel, useCorePanel } from './panel';

const CoreScreen = lazy(() => import('./CoreScreen'));

export const CORE_PANEL_ID = 'nx-core-panel';

/**
 * «Ядро» выдвижной панелью справа. Панель — вторая колонка каркаса (AppShell): выезжая, она не перекрывает
 * раздел, а сжимает его вместе с нижней полосой. Содержимое прижато к правому краю и не меняет ширину во время
 * выезда — поэтому оно въезжает справа налево, а не сжимается. На телефоне панель закрывает экран целиком.
 *
 * Экран «Ядра» грузится при первом открытии и дальше живёт свёрнутым — переписка не теряется.
 */
export default function CorePanel() {
  const open = useCorePanel((s) => s.open);
  const width = useCorePanel((s) => s.width);
  const [mounted, setMounted] = useState(open);
  const [resizing, setResizing] = useState(false);
  useEffect(() => { if (open) setMounted(true); }, [open]);

  // Ctrl/⌘+A — по физической клавише, как Ctrl+K у поиска (в русской раскладке там «ф»). В полях ввода
  // и в документах/таблицах Офиса это по-прежнему «выделить всё» — там панель не перехватывает.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.code !== 'KeyA' || e.repeat) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .nws-univer')) return;
      e.preventDefault();
      e.stopPropagation();
      toggleCorePanel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  function startResize(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    const sash = e.currentTarget;
    sash.setPointerCapture(e.pointerId);
    setResizing(true);
    const move = (ev: globalThis.PointerEvent) => setCorePanelWidth(window.innerWidth - ev.clientX);
    const up = () => {
      setResizing(false);
      sash.removeEventListener('pointermove', move);
      sash.removeEventListener('pointerup', up);
      sash.removeEventListener('pointercancel', up);
    };
    sash.addEventListener('pointermove', move);
    sash.addEventListener('pointerup', up);
    sash.addEventListener('pointercancel', up);
  }

  return (
    <aside
      id={CORE_PANEL_ID}
      className="nx-core-panel"
      aria-label="Ядро"
      data-open={open || undefined}
      data-resizing={resizing || undefined}
      inert={!open}
      style={{ '--nx-core-w': `${width}px` } as CSSProperties}
    >
      <div className="nx-core-sash" role="separator" aria-orientation="vertical" aria-label="Ширина Ядра" title="Потяните, чтобы изменить ширину" onPointerDown={startResize} />
      <div className="nx-core-panel-inner">
        {mounted && (
          <Suspense fallback={null}>
            <CoreScreen embedded onClose={closeCorePanel} />
          </Suspense>
        )}
      </div>
    </aside>
  );
}
