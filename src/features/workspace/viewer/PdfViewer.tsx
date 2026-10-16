import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Minus, Plus, Search, X } from 'lucide-react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { Spinner } from '@/shared/ui/Spinner';
import 'pdfjs-dist/web/pdf_viewer.css';

/**
 * Просмотр PDF: непрерывная лента страниц, как в Chrome и Acrobat.
 *  - чёткость: холст рисуется в физических пикселях экрана (devicePixelRatio), а не в CSS-пикселях;
 *  - живой текст: поверх холста слой текста pdf.js — выделяется и копируется;
 *  - быстро на больших файлах: рисуются только видимые страницы ±1 экран, остальные освобождаются;
 *  - масштаб: «по ширине» (подстраивается под панель при её растягивании), кнопки ±, Ctrl + колесо;
 *  - поиск по тексту с подсветкой и переходом между страницами.
 */

type Pdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsPromise: Promise<Pdfjs> | null = null;
function loadPdfjs(): Promise<Pdfjs> {
  pdfjsPromise ||= import('pdfjs-dist/legacy/build/pdf.mjs').then((mod) => {
    mod.GlobalWorkerOptions.workerSrc = workerUrl;
    return mod;
  });
  return pdfjsPromise;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;
const GAP = 12;
const MAX_CANVAS_PIXELS = 16_000_000;

interface PageSize { w: number; h: number }

const PageView = memo(function PageView({ doc, number, size, scale, near, query, pdfjs }: {
  doc: PDFDocumentProxy; number: number; size: PageSize; scale: number; near: boolean; query: string; pdfjs: Pdfjs;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const renderedFor = useRef('');

  // Рисуем, когда страница рядом с экраном; уехала далеко — освобождаем память холста.
  useEffect(() => {
    const canvas = canvasRef.current;
    const textLayer = textRef.current;
    if (!canvas || !textLayer) return undefined;
    if (!near) {
      canvas.width = 0; canvas.height = 0;
      textLayer.replaceChildren();
      renderedFor.current = '';
      return undefined;
    }
    const key = `${scale.toFixed(3)}:${window.devicePixelRatio}`;
    if (renderedFor.current === key) return undefined;
    let cancelled = false;
    let task: RenderTask | null = null;
    // Небольшая задержка: при быстрой прокрутке и протяжке масштаба не рисуем то, что тут же устареет.
    const timer = window.setTimeout(async () => {
      try {
        const page = await doc.getPage(number);
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        let ratio = Math.min(window.devicePixelRatio || 1, 3);
        const pixels = viewport.width * viewport.height * ratio * ratio;
        if (pixels > MAX_CANVAS_PIXELS) ratio *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
        const fresh = document.createElement('canvas');
        fresh.width = Math.max(1, Math.floor(viewport.width * ratio));
        fresh.height = Math.max(1, Math.floor(viewport.height * ratio));
        const context = fresh.getContext('2d', { alpha: false });
        if (!context) return;
        task = page.render({ canvasContext: context, viewport, canvas: fresh, transform: [ratio, 0, 0, ratio, 0, 0], background: '#ffffff' } as Parameters<typeof page.render>[0]);
        await task.promise;
        if (cancelled) return;
        // Подменяем содержимое одним кадром, чтобы не мигала белая страница между масштабами.
        canvas.width = fresh.width;
        canvas.height = fresh.height;
        canvas.getContext('2d')?.drawImage(fresh, 0, 0);
        renderedFor.current = key;
        textLayer.replaceChildren();
        textLayer.style.setProperty('--scale-factor', String(scale));
        textLayer.style.setProperty('--total-scale-factor', String(scale));
        const layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: textLayer, viewport });
        await layer.render();
        if (!cancelled) highlight(textLayer, query);
      } catch (error) {
        if ((error as { name?: string })?.name !== 'RenderingCancelledException') console.warn('[pdf] page render failed', number, error);
      }
    }, 60);
    return () => { cancelled = true; window.clearTimeout(timer); task?.cancel(); };
  }, [doc, number, scale, near, pdfjs]); // eslint-disable-line react-hooks/exhaustive-deps

  // Подсветка найденного: слой текста уже нарисован — просто помечаем подходящие фрагменты.
  useEffect(() => { if (textRef.current) highlight(textRef.current, query); }, [query]);

  return (
    <div className="npv-page" data-page={number} style={{ width: size.w * scale, height: size.h * scale }}>
      <canvas ref={canvasRef} className="npv-canvas" />
      <div ref={textRef} className="textLayer npv-text" />
    </div>
  );
});

function highlight(layer: HTMLElement, query: string) {
  const needle = query.trim().toLowerCase();
  for (const span of layer.querySelectorAll<HTMLElement>('span')) {
    span.classList.toggle('npv-hit', Boolean(needle) && (span.textContent || '').toLowerCase().includes(needle));
  }
}

export default function PdfViewer({ url, name }: { url: string; name: string }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [pdfjs, setPdfjs] = useState<Pdfjs | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<number | null>(0);
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState<'fit' | number>('fit');
  const [current, setCurrent] = useState(1);
  const [near, setNear] = useState<Set<number>>(() => new Set([1, 2]));
  const [query, setQuery] = useState('');
  const [findOpen, setFindOpen] = useState(false);
  const [hits, setHits] = useState<number[]>([]);
  const [hitIndex, setHitIndex] = useState(0);
  const texts = useRef<string[]>([]);

  // Загрузка: файл целиком в память — pdf.js нужны диапазоны байт, а вложения отдаёт обычный GET.
  useEffect(() => {
    let alive = true;
    let loaded: PDFDocumentProxy | null = null;
    let task: { destroy: () => Promise<void> } | null = null;
    setError(''); setDoc(null); setSizes([]); setProgress(0);
    (async () => {
      try {
        const lib = await loadPdfjs();
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`Файл не открылся (${res.status})`);
        const total = Number(res.headers.get('content-length')) || 0;
        let data: Uint8Array;
        if (res.body && total) {
          const reader = res.body.getReader();
          const chunks: Uint8Array[] = [];
          let got = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            got += value.length;
            if (alive) setProgress(Math.min(0.99, got / total));
          }
          data = new Uint8Array(got);
          let at = 0;
          for (const chunk of chunks) { data.set(chunk, at); at += chunk.length; }
        } else {
          data = new Uint8Array(await res.arrayBuffer());
        }
        if (!alive) return;
        const loading = lib.getDocument({ data });
        task = loading;
        loaded = await loading.promise;
        if (!alive) { void loading.destroy(); return; }
        // Размеры всех страниц нужны сразу: без них лента «прыгает», пока страницы подгружаются.
        const list: PageSize[] = [];
        for (let n = 1; n <= loaded.numPages; n += 1) {
          const viewport = (await loaded.getPage(n)).getViewport({ scale: 1 });
          list.push({ w: viewport.width, h: viewport.height });
          if (n === 1 && alive) { setPdfjs(lib); setDoc(loaded); setSizes([...list]); setProgress(null); }
        }
        if (alive) setSizes(list);
      } catch (cause) {
        if (alive) setError(cause instanceof Error && cause.message ? cause.message : 'Не удалось открыть PDF');
      }
    })();
    return () => { alive = false; void task?.destroy(); };
  }, [url]);

  // Ширина панели → масштаб «по ширине» подстраивается при растягивании.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [doc]);

  const baseWidth = sizes[0]?.w || 612;
  const fitScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, (width - GAP * 2) / baseWidth));
  const scale = zoom === 'fit' ? fitScale : zoom;

  // Какие страницы рядом с экраном и какая сейчас главная.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !sizes.length) return undefined;
    const update = () => {
      const top = el.scrollTop;
      const bottom = top + el.clientHeight;
      let y = GAP;
      const visible = new Set<number>();
      let main = 1;
      let mainSet = false;
      sizes.forEach((size, index) => {
        const h = size.h * scale;
        const pageTop = y;
        const pageBottom = y + h;
        if (pageBottom > top - el.clientHeight && pageTop < bottom + el.clientHeight) visible.add(index + 1);
        if (!mainSet && pageBottom > top + el.clientHeight * 0.35) { main = index + 1; mainSet = true; }
        y = pageBottom + GAP;
      });
      setNear((prev) => (prev.size === visible.size && [...visible].every((n) => prev.has(n)) ? prev : visible));
      setCurrent(main);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    return () => el.removeEventListener('scroll', update);
  }, [sizes, scale]);

  const goTo = useCallback((page: number, smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    const clamped = Math.max(1, Math.min(sizes.length, page));
    let y = GAP;
    for (let i = 0; i < clamped - 1; i += 1) y += sizes[i].h * scale + GAP;
    el.scrollTo({ top: y - GAP, behavior: smooth ? 'smooth' : 'auto' });
  }, [sizes, scale]);

  // Масштаб относительно центра окна: страница не «уезжает» из-под взгляда.
  const zoomBy = useCallback((factor: number) => {
    const el = scroller.current;
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale * factor));
    if (el) {
      const ratio = next / scale;
      const centerY = el.scrollTop + el.clientHeight / 2;
      const centerX = el.scrollLeft + el.clientWidth / 2;
      requestAnimationFrame(() => { el.scrollTop = centerY * ratio - el.clientHeight / 2; el.scrollLeft = centerX * ratio - el.clientWidth / 2; });
    }
    setZoom(next);
  }, [scale]);

  // Ctrl + колесо / щипок на тачпаде.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomBy(Math.exp(-event.deltaY * 0.01));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomBy, doc]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if ((event.target as HTMLElement).tagName === 'INPUT') return;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && (event.key === '+' || event.key === '=')) { event.preventDefault(); zoomBy(1.2); }
    else if (mod && event.key === '-') { event.preventDefault(); zoomBy(1 / 1.2); }
    else if (mod && event.key === '0') { event.preventDefault(); setZoom('fit'); }
    else if (mod && event.key.toLowerCase() === 'f') { event.preventDefault(); setFindOpen(true); }
    else if (event.key === 'Home') { event.preventDefault(); goTo(1); }
    else if (event.key === 'End') { event.preventDefault(); goTo(sizes.length); }
  };

  // ── Поиск ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!doc || !query.trim()) { setHits([]); setHitIndex(0); return undefined; }
    let alive = true;
    const timer = window.setTimeout(async () => {
      const needle = query.trim().toLowerCase();
      const found: number[] = [];
      for (let n = 1; n <= doc.numPages; n += 1) {
        if (texts.current[n] === undefined) {
          const content = await (await doc.getPage(n)).getTextContent();
          texts.current[n] = content.items.map((item) => ('str' in item ? item.str : '')).join(' ').toLowerCase();
        }
        if (!alive) return;
        if (texts.current[n].includes(needle)) found.push(n);
      }
      setHits(found);
      setHitIndex(0);
      if (found.length) goTo(found[0]);
    }, 250);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [query, doc]); // eslint-disable-line react-hooks/exhaustive-deps

  const step = (delta: number) => {
    if (!hits.length) return;
    const next = (hitIndex + delta + hits.length) % hits.length;
    setHitIndex(next);
    goTo(hits[next]);
  };

  const percent = useMemo(() => Math.round(scale * 100), [scale]);

  if (error) return <div className="npv-state" role="alert">{error}</div>;
  if (!doc || !pdfjs) {
    return <div className="npv-state"><Spinner size={24} label={`Открываю «${name}»`} />{progress ? <span aria-hidden="true">{Math.round(progress * 100)}%</span> : null}</div>;
  }

  return (
    <div className="npv" onKeyDown={onKeyDown}>
      <div className="npv-bar" role="toolbar" aria-label="Просмотр PDF">
        <button type="button" className="nx-icon-btn" onClick={() => goTo(current - 1, true)} disabled={current <= 1} aria-label="Предыдущая страница" title="Предыдущая страница"><ChevronLeft size={16} /></button>
        <label className="npv-page-input">
          <input
            key={current}
            type="number"
            min={1}
            max={sizes.length}
            defaultValue={current}
            aria-label="Номер страницы"
            onKeyDown={(e) => { if (e.key === 'Enter') { goTo(Number((e.target as HTMLInputElement).value) || 1); (e.target as HTMLInputElement).blur(); } }}
            onBlur={(e) => { const n = Number(e.target.value); if (n && n !== current) goTo(n); }}
          />
          <span>из {doc.numPages}</span>
        </label>
        <button type="button" className="nx-icon-btn" onClick={() => goTo(current + 1, true)} disabled={current >= sizes.length} aria-label="Следующая страница" title="Следующая страница"><ChevronRight size={16} /></button>
        <span className="npv-sep" aria-hidden="true" />
        <button type="button" className="nx-icon-btn" onClick={() => zoomBy(1 / 1.2)} aria-label="Уменьшить" title="Уменьшить (Ctrl + −)"><Minus size={16} /></button>
        <button type="button" className="npv-zoom" aria-pressed={zoom === 'fit'} onClick={() => setZoom('fit')} title="По ширине панели (Ctrl + 0)">{percent}%</button>
        <button type="button" className="nx-icon-btn" onClick={() => zoomBy(1.2)} aria-label="Увеличить" title="Увеличить (Ctrl + +)"><Plus size={16} /></button>
        <span className="npv-grow" />
        <button type="button" className="nx-icon-btn" onClick={() => setFindOpen((v) => !v)} aria-pressed={findOpen} aria-label="Поиск по документу" title="Поиск (Ctrl + F)"><Search size={16} /></button>
      </div>
      {findOpen && (
        <div className="npv-find">
          <input
            autoFocus
            value={query}
            placeholder="Найти в документе"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') step(e.shiftKey ? -1 : 1); if (e.key === 'Escape') { setFindOpen(false); setQuery(''); } }}
            aria-label="Найти в документе"
          />
          <span>{query.trim() ? (hits.length ? `стр. ${hits[hitIndex]} · ${hitIndex + 1}/${hits.length}` : 'не найдено') : ''}</span>
          <button type="button" className="nx-icon-btn" onClick={() => step(-1)} disabled={!hits.length} aria-label="Назад"><ChevronLeft size={15} /></button>
          <button type="button" className="nx-icon-btn" onClick={() => step(1)} disabled={!hits.length} aria-label="Далее"><ChevronRight size={15} /></button>
          <button type="button" className="nx-icon-btn" onClick={() => { setFindOpen(false); setQuery(''); }} aria-label="Закрыть поиск"><X size={15} /></button>
        </div>
      )}
      <div ref={scroller} className="npv-scroll" tabIndex={0} aria-label={`Страницы документа ${name}`}>
        <div className="npv-pages" style={{ gap: GAP, padding: GAP }}>
          {sizes.map((size, index) => (
            <PageView key={index} doc={doc} number={index + 1} size={size} scale={scale} near={near.has(index + 1)} query={query} pdfjs={pdfjs} />
          ))}
        </div>
      </div>
    </div>
  );
}
