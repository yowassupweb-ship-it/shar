import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronLeft, ChevronRight, Copy, Download, ExternalLink, MessageSquareText, X } from 'lucide-react';
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
 *
 * Открывается в натуральном размере: маленькое фото не растягивается, большое вписывается в экран (не крупнее).
 * Кнопок масштаба нет: колесо, щипок, двойной клик, +/− и 1 (100%) / 0 (по экрану); проценты коротко всплывают
 * по центру. R — повернуть, Home/End — первое и последнее фото.
 *
 * Не мешает смотреть: шапка и стрелки прячутся, пока мышь стоит; лента внизу — тонкие полоски, миниатюрами
 * раскрывается при наведении.
 */

export interface ViewerItem {
  url: string;
  author?: string;
  date?: string;
  messageId?: string;
  name?: string;
}

// Масштаб view.scale — относительно «базового» размера на экране (натуральный, но не больше экрана).
const MIN = 0.1;
/** Поля вокруг большого фото, вписанного в экран. */
const FIT_MARGIN = 0.94;
const MAX = 16;
/** Сколько мышь может стоять, прежде чем шапка и стрелки уйдут. */
const IDLE_MS = 2200;
/** Сколько ждать оригинал, прежде чем показать превью. */
const SHOW_WAIT_MS = 300;

export default function ImageViewer({ items, start, onClose, onJump, onCopy }: {
  items: ViewerItem[];
  start: number;
  onClose: () => void;
  onJump?: (messageId: string) => void;
  /** Копирование картинки: false или ошибка — не вышло (кнопка покажет это сама). */
  onCopy?: (url: string) => void | boolean | Promise<void | boolean>;
}) {
  const [index, setIndex] = useState(() => Math.max(0, Math.min(start, items.length - 1)));
  const [fullLoaded, setFullLoaded] = useState(false);
  /** На экране оригинал (а не превью) — по нему считаем настоящий размер. */
  const fullRef = useRef(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const view = useRef({ scale: 1, x: 0, y: 0 });
  /** Во сколько раз базовый размер меньше натурального (1 — фото целиком помещается как есть). */
  const base = useRef(1);
  const [rotation, setRotation] = useState(0);
  const rotationRef = useRef(0);
  rotationRef.current = rotation;
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  // Мышь стоит — шапка и стрелки уходят, фото на весь экран; любое движение или клавиша — возвращаются.
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef(0);
  const wake = useCallback(() => {
    setIdle(false);
    window.clearTimeout(idleTimer.current);
    // На телефоне мыши нет — шапку (и крестик) не прячем: иначе выйти из просмотра было бы нечем.
    if (window.matchMedia('(pointer: coarse)').matches) return;
    idleTimer.current = window.setTimeout(() => setIdle(true), IDLE_MS);
  }, []);
  useEffect(() => { wake(); return () => window.clearTimeout(idleTimer.current); }, [wake]);
  const zoomAtRef = useRef<(next: number, cx: number, cy: number, animate?: boolean) => void>(() => undefined);
  const item = items[index];

  // Отбивка действий: кнопка сама показывает, что произошло (копируется → скопировано / не вышло), а короткая плашка сверху
  // говорит словами — масштаб, скачивание. Тосты Шара поверх просмотрщика не всегда видны, поэтому ответ — здесь же.
  const [copyState, setCopyState] = useState<'idle' | 'busy' | 'ok' | 'fail'>('idle');
  const [notice, setNotice] = useState('');
  const noticeTimer = useRef(0);
  const copyTimer = useRef(0);
  const say = useCallback((text: string, ms = 1500) => {
    setNotice(text);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(''), ms);
  }, []);
  useEffect(() => () => { window.clearTimeout(noticeTimer.current); window.clearTimeout(copyTimer.current); }, []);
  const copy = async () => {
    if (!onCopy || copyState === 'busy') return;
    setCopyState('busy');
    let ok = true;
    try { ok = (await onCopy(item.url)) !== false; } catch { ok = false; }
    setCopyState(ok ? 'ok' : 'fail');
    say(ok ? 'Картинка скопирована' : 'Не удалось скопировать', 1800);
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopyState('idle'), 1800);
  };

  const apply = useCallback((animate = false) => {
    const img = imgRef.current;
    if (!img) return;
    const { scale, x, y } = view.current;
    // Размер (превью → оригинал) меняется плавно, а не скачком; transform — плавно только по просьбе (жесты — сразу).
    img.style.transition = `${animate ? 'transform .22s cubic-bezier(.22,1,.36,1), ' : ''}width .2s ease, height .2s ease`;
    img.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale}) rotate(${rotationRef.current}deg)`;
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

  useEffect(() => { setFullLoaded(false); setNatural(null); setRotation(0); reset(false); }, [index, reset]);
  // Фото появляется, когда пришёл оригинал, — но не позже чем через SHOW_WAIT_MS: дальше показываем превью.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    setShown(false);
    const t = window.setTimeout(() => setShown(true), SHOW_WAIT_MS);
    return () => window.clearTimeout(t);
  }, [index]);
  useEffect(() => { if (fullLoaded) setShown(true); }, [fullLoaded]);
  useEffect(() => { apply(true); }, [rotation, apply]);

  // Фото — на весь экран, по большей стороне, которая упрётся первой (как в
  // «Фото» iOS): верхняя полоса и лента миниатюр лежат поверх, а не отнимают
  // высоту. Раньше картинка стояла в своём натуральном размере между ними —
  // превью 640px и небольшие фото не доставали ни до верха, ни до низа.
  const fit = useCallback(() => {
    const img = imgRef.current;
    const stage = stageRef.current;
    if (!img || !stage || !img.naturalWidth || !img.naturalHeight) return;
    // Натуральный размер настоящего файла (превью меньше — берём размер оригинала, когда он загрузится).
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    // Повёрнутое на 90° вписываем по переставленным сторонам.
    const turned = Math.abs(rotationRef.current % 180) === 90;
    const fitK = Math.min(stage.clientWidth / (turned ? nh : nw), stage.clientHeight / (turned ? nw : nh)) * FIT_MARGIN;
    // Не растягиваем: маленькое фото — как есть (100%), большое — по экрану. Это и есть масштаб 1 просмотрщика.
    // Пока на экране превью (оно меньше оригинала), вписываем его по экрану — настоящий размер узнаем у оригинала.
    // Превью уже́ запрошенной ширины — сервер не растягивал: это и есть настоящий размер, вписываем как оригинал
    // (иначе маленькое фото на долю секунды растягивалось на весь экран, а с оригиналом сжималось обратно).
    const asked = Number(/\/api\/thumbs\/(\d+)\//.exec(img.currentSrc || img.src)?.[1]) || 0;
    const whole = fullRef.current || (asked > 0 && nw < asked);
    const k = whole ? Math.min(1, fitK) : fitK;
    base.current = k;
    img.style.width = `${Math.floor(nw * k)}px`;
    img.style.height = `${Math.floor(nh * k)}px`;
  }, []);
  useEffect(() => { fit(); }, [rotation, fit]);
  /** 100% — настоящий размер, пиксель в пиксель; повторно — обратно по экрану. */
  const toggleActual = useCallback(() => {
    const r = stageRef.current?.getBoundingClientRect();
    if (!r) return;
    const actual = 1 / base.current;
    if (Math.abs(view.current.scale - actual) < 0.01) reset();
    else zoomAtRef.current(actual, r.left + r.width / 2, r.top + r.height / 2, true);
  }, [reset]);
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
    // Не больше экрана — картинка по центру, двигать её незачем.
    if (s <= 1) { v.x = 0; v.y = 0; }
    apply(animate);
    say(`${Math.round(s * base.current * 100)}%`, 900);
  }, [apply, say]);
  zoomAtRef.current = zoomAt;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      wake();
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === '+' || e.key === '=') { const r = stageRef.current?.getBoundingClientRect(); if (r) zoomAt(view.current.scale * 1.4, r.left + r.width / 2, r.top + r.height / 2, true); }
      else if (e.key === '-') { const r = stageRef.current?.getBoundingClientRect(); if (r) zoomAt(view.current.scale / 1.4, r.left + r.width / 2, r.top + r.height / 2, true); }
      else if (e.key === '0') reset();
      else if (e.key === '1') toggleActual();
      else if (e.key === 'r' || e.key === 'R' || e.key === 'к' || e.key === 'К') setRotation((d) => (d + 90) % 360);
      else if (e.key === 'Home') setIndex(0);
      else if (e.key === 'End') setIndex(items.length - 1);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [go, onClose, reset, zoomAt, toggleActual, items.length, wake]);

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
        img.style.transform = `translate3d(0, ${dy}px, 0) scale(${view.current.scale * (1 - Math.min(dy / 1600, 0.15))})`;
        setBackdrop(Math.max(0.2, 1 - dy / 500));
      } else {
        img.style.transition = 'none';
        img.style.transform = `translate3d(${dx}px, 0, 0) scale(${view.current.scale})`;
      }
    }
  };

  const onUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    pts.current.delete(e.pointerId);
    if (g.mode === 'pinch') {
      // Отпустили около 100% — ровно 100%; заметно меньше — оставляем, как просили.
      if (pts.current.size < 2) { g.mode = 'none'; if (Math.abs(view.current.scale - 1) <= 0.05) reset(); }
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
        if (view.current.scale !== 1) reset(); else zoomAt(base.current < 0.98 ? 1 / base.current : 2.5, e.clientX, e.clientY, true);
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
      apply(true); // вернуть на место, сохранив масштаб (в том числе меньше 100%)
    }
    g.mode = 'none';
  };

  useLayoutEffect(() => { apply(); }, [apply, index]);

  if (!item || typeof document === 'undefined') return null;
  const root = document.querySelector('.nx') || document.body;
  const preview = thumbUrl(item.url, 640);

  return createPortal(
    <div ref={rootRef} className="nxv" role="dialog" aria-modal="true" aria-label="Просмотр фото" data-idle={idle || undefined}
      onPointerMove={wake} onPointerDown={wake}>
      <header className="nxv-bar">
        <div className="nxv-meta">
          {(item.name || item.author) && <b title={item.name || item.author}>{item.name || item.author}</b>}
          <span>{[item.name ? item.author : '', item.date, natural ? `${natural.w}×${natural.h}` : '', items.length > 1 ? `${index + 1} из ${items.length}` : ''].filter(Boolean).join(' · ')}</span>
        </div>
        <div className="nxv-actions">
          {onJump && item.messageId && (
            <button type="button" className="nxv-btn" onClick={() => { onJump(item.messageId!); onClose(); }} aria-label="Перейти к сообщению" title="Перейти к сообщению">
              <MessageSquareText size={18} />
            </button>
          )}
          {onCopy && (
            <button type="button" className="nxv-btn" data-state={copyState === 'idle' ? undefined : copyState} disabled={copyState === 'busy'}
              onClick={() => void copy()} aria-label="Копировать картинку"
              title={copyState === 'ok' ? 'Скопировано' : copyState === 'fail' ? 'Не вышло — попробуйте ещё раз' : 'Копировать'}>
              {copyState === 'ok' ? <Check size={18} /> : copyState === 'fail' ? <X size={18} /> : <Copy size={18} />}
            </button>
          )}
          <a className="nxv-btn" href={item.url} download={item.name || true} onClick={(e) => { downloadOnClick(item.url, item.name)(e); say(window.sharDesktop?.downloadFile ? 'Сохранение…' : 'Скачивание началось', 1800); }} aria-label="Скачать" title="Скачать"><Download size={18} /></a>
          <a className="nxv-btn" href={item.url} target="_blank" rel="noopener noreferrer" aria-label="Открыть оригинал" title="Открыть оригинал"><ExternalLink size={18} /></a>
          <button ref={closeRef} type="button" className="nxv-btn" onClick={onClose} aria-label="Закрыть" title="Закрыть (Esc)"><X size={20} /></button>
        </div>
      </header>

      {notice && <div className="nxv-notice" role="status" aria-live="polite">{notice}</div>}

      <div
        ref={stageRef}
        className="nxv-stage"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onClick={(e) => {
          if (suppressClick.current) { suppressClick.current = false; return; }
          if (e.target === e.currentTarget && view.current.scale <= 1) onClose();
        }}
      >
        <img
          ref={imgRef}
          key={item.url}
          className="nxv-img"
          data-shown={shown || fullLoaded || undefined}
          src={fullLoaded || preview === item.url ? item.url : preview}
          alt={item.name || ''}
          draggable={false}
          onLoad={(e) => {
            fullRef.current = fullLoaded || preview === item.url;
            fit();
            if (fullRef.current) { setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight }); return; }
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
          {/* Лента — полоски (текущее фото — длиннее); наведение раскрывает миниатюры. */}
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
