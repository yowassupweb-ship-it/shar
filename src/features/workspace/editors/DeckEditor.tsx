import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Moveable from 'react-moveable';
import {
  AlignCenter, AlignLeft, AlignRight, ArrowDownToLine, ArrowUpToLine, Bold, ChevronLeft, ChevronRight, Circle, Copy, Download,
  Image as ImageIcon, Italic, Link2, List, Maximize, Minimize2, Minus, NotebookPen, Palette, Paintbrush, Play, Plus, Printer, Redo2, Replace,
  Scan, Square, SquareDashed, Trash2, Type, Underline, Undo2, X,
} from 'lucide-react';
import { uploadFileWithProgress } from '@/shared/api/uploadFile';
import { Spinner } from '@/shared/ui/Spinner';
import { attachmentUrl } from '@/shared/ui/format';
import { Menu, MenuItem, Sheet, type MenuAnchor } from '@/shared/ui/overlay';
import {
  LAYOUTS, THEMES, cleanHtml, cloneSlide, deckSize, newSlide, parseDeck, serializeDeck, uid,
  type Deck, type LayoutId, type ShapeElement, type Slide, type SlideElement, type TextStyle,
} from '../slides/deck';
import { ElementContent, SlideView, boxStyle } from '../slides/SlideView';
import { exportPptx } from '../slides/exportPptx';
import type { EditorProps } from './types';

/** Миниатюра вписывается в рамку 112×120 по форме слайда. */
const THUMB_W = 112;
const THUMB_H = 120;
const HISTORY_LIMIT = 60;

/** Картинка → файл не больше 1600 px по длинной стороне, чтобы презентация оставалась лёгкой, и загрузка в хранилище Шара. */
async function uploadImage(file: File, onProgress: (percent: number) => void): Promise<{ src: string; w: number; h: number }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const png = file.type === 'image/png';
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, png ? 'image/png' : 'image/jpeg', 0.86));
  if (!blob) throw new Error('canvas');
  const upload = await uploadFileWithProgress(new File([blob], png ? 'slide.png' : 'slide.jpg', { type: blob.type }), onProgress);
  return { src: attachmentUrl(upload.url), w: canvas.width, h: canvas.height };
}

type MenuState = { kind: 'layout' | 'shape' | 'theme' | 'export' | 'thumb' | 'font'; anchor: MenuAnchor; index?: number };

/** Шрифты для текста на слайде: есть на Windows и macOS (Inter — шрифт интерфейса Шара). Пустое значение — шрифт темы. */
const FONTS: Array<{ name: string; value: string }> = [
  { name: 'Шрифт темы', value: '' },
  { name: 'Inter', value: "Inter, 'Segoe UI', Arial, sans-serif" },
  { name: 'Arial', value: 'Arial, Helvetica, sans-serif' },
  { name: 'Segoe UI', value: "'Segoe UI', 'Helvetica Neue', Arial, sans-serif" },
  { name: 'Calibri', value: 'Calibri, Carlito, Arial, sans-serif' },
  { name: 'Verdana', value: 'Verdana, Geneva, sans-serif' },
  { name: 'Trebuchet MS', value: "'Trebuchet MS', Arial, sans-serif" },
  { name: 'Georgia', value: "Georgia, 'Times New Roman', serif" },
  { name: 'Times New Roman', value: "'Times New Roman', Times, serif" },
  { name: 'Cambria', value: "Cambria, Georgia, serif" },
  { name: 'Courier New', value: "'Courier New', Courier, monospace" },
];
const fontName = (family?: string) => FONTS.find((item) => item.value && item.value === family)?.name || (family ? family.split(',')[0].replace(/['"]/g, '').trim() : 'Шрифт темы');

/**
 * Редактор презентаций в духе Google Презентаций: миниатюры слева, слайд с перетаскиваемыми блоками в центре,
 * панель оформления сверху, заметки докладчика снизу. Колода — JSON (тема и слайды 960×540), правка уходит
 * сессии целиком.
 */
export default function DeckEditor({ content, onContent, readOnly, loadKey, title = 'Презентация' }: EditorProps) {
  const [deck, setDeck] = useState<Deck>(() => parseDeck(content));
  const [current, setCurrent] = useState(0);
  const [selected, setSelectedOne] = useState<string | null>(null);
  /** Остальные выделенные элементы (Shift+клик, рамка, Ctrl+A) — как в Figma: двигаются, дублируются и удаляются вместе. */
  const [extra, setExtra] = useState<string[]>([]);
  const setSelected = (id: string | null) => { setSelectedOne(id); setExtra([]); };
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  /** Заметки докладчика: по умолчанию скрыты (занимали место под слайдом), выбор запоминается. */
  const [notesOpen, setNotesOpen] = useState(() => { try { return localStorage.getItem('nx:deck-notes') === '1'; } catch { return false; } });
  const toggleNotes = () => setNotesOpen((open) => { try { localStorage.setItem('nx:deck-notes', open ? '0' : '1'); } catch { /* без хранилища — на сессию */ } return !open; });
  /** Зажат пробел (вне правки текста) — холст двигается мышью. */
  const [panReady, setPanReady] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState('');
  /** Загрузка картинки: null — нет, иначе проценты. Без индикатора казалось, что картинка не вставилась, а потом она «вдруг» появлялась. */
  const [uploading, setUploading] = useState<number | null>(null);
  const [show, setShow] = useState<number | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [urlPrompt, setUrlPrompt] = useState(false);
  const [urlValue, setUrlValue] = useState('');
  const [fitK, setFitK] = useState(0.6);
  const [zoom, setZoom] = useState(1);
  const k = fitK * zoom;
  const moveableRef = useRef<Moveable | null>(null);
  const pastRef = useRef<string[]>([]);
  const futureRef = useRef<string[]>([]);
  const lastSent = useRef(serializeDeck(parseDeck(content)));
  const stageRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const dragFrom = useRef<number | null>(null);
  const replaceRef = useRef<string | null>(null);
  const onContentRef = useRef(onContent);
  onContentRef.current = onContent;
  const [, setTick] = useState(0);

  const size = deckSize(deck);
  const SLIDE_W = size.w;
  const SLIDE_H = size.h;
  const slide = deck.slides[Math.min(current, deck.slides.length - 1)];
  const element = slide?.elements.find((item) => item.id === selected) || null;
  /** Все выделенные элементы текущего слайда (основной — первым). */
  const ids = selected ? [selected, ...extra.filter((id) => id !== selected)] : [];
  const group = ids.length > 1;
  const theme = deck.theme;

  // Материал перечитали с сервера — открываем присланное.
  useEffect(() => {
    const next = parseDeck(content);
    lastSent.current = serializeDeck(next);
    pastRef.current = [];
    futureRef.current = [];
    setDeck(next);
    setCurrent((value) => Math.min(value, next.slides.length - 1));
    setSelected(null);
    setEditing(null);
  }, [loadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Любое изменение колоды уходит сессии (она сама склеивает и сохраняет).
  const serialized = useMemo(() => serializeDeck(deck), [deck]);
  useEffect(() => {
    if (readOnly || serialized === lastSent.current) return;
    lastSent.current = serialized;
    onContentRef.current(serialized);
  }, [serialized, readOnly]);

  // ── Правка модели с историей ───────────────────────────────────────────────
  const commit = useCallback((change: (draft: Deck) => void) => {
    if (readOnly) return;
    setDeck((previous) => {
      const draft = JSON.parse(serializeDeck(previous)) as Deck;
      change(draft);
      pastRef.current = [...pastRef.current.slice(-HISTORY_LIMIT + 1), serializeDeck(previous)];
      futureRef.current = [];
      return draft;
    });
  }, [readOnly]);
  const updateSlide = (change: (target: Slide) => void) => commit((draft) => { const target = draft.slides[current]; if (target) change(target); });
  const updateElement = (id: string, change: (target: SlideElement) => void) => updateSlide((target) => { const found = target.elements.find((item) => item.id === id); if (found) change(found); });

  function undo() {
    const previous = pastRef.current.pop();
    if (!previous) return;
    futureRef.current.push(serializeDeck(deck));
    setDeck(parseDeck(previous));
    setTick((v) => v + 1);
  }
  function redo() {
    const next = futureRef.current.pop();
    if (!next) return;
    pastRef.current.push(serializeDeck(deck));
    setDeck(parseDeck(next));
    setTick((v) => v + 1);
  }

  // ── Размер холста: слайд вписывается в доступное место ────────────────────
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    // offsetWidth/offsetHeight, а не client*: при приближении появляются полосы прокрутки, client* уменьшается,
    // слайд вписывался мельче, полосы пропадали — и масштаб дрожал по кругу.
    const fit = () => {
      const next = Math.max(0.1, Math.min((stage.offsetWidth - 32) / SLIDE_W, (stage.offsetHeight - 32) / SLIDE_H));
      setFitK((cur) => (Math.abs(cur - next) < 0.0005 ? cur : next));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [SLIDE_W, SLIDE_H]);

  useLayoutEffect(() => { moveableRef.current?.updateRect(); }, [k]);
  useEffect(() => { setZoom(1); }, [current]);

  // Пробел зажат — курсор «рука», холст двигается мышью (как в Figma). В полях ввода пробел — просто пробел.
  useEffect(() => {
    const typing = (target: EventTarget | null) => { const node = target as HTMLElement | null; return Boolean(node && (/^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName) || node.isContentEditable)); };
    const down = (event: KeyboardEvent) => { if (event.code === 'Space' && !editing && !typing(event.target) && show === null) { event.preventDefault(); setPanReady(true); } };
    const up = (event: KeyboardEvent) => { if (event.code === 'Space') setPanReady(false); };
    const blur = () => setPanReady(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); };
  }, [editing, show]);

  // Ctrl + колесо / щипок на тачпаде — приближение слайда.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const onWheel = (event: WheelEvent) => {
      if (editing || !event.ctrlKey) return;
      event.preventDefault();
      setZoom((value) => Math.min(4, Math.max(0.25, value * Math.exp(-event.deltaY * 0.01))));
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [editing]);

  // ── Действия ───────────────────────────────────────────────────────────────
  function addSlide(layout: LayoutId, at = current + 1) {
    const next = newSlide(layout, deck.theme, size);
    commit((draft) => { draft.slides.splice(at, 0, next); });
    setCurrent(at);
    setSelected(null);
    setMenu(null);
  }

  function addElement(created: SlideElement) {
    updateSlide((target) => { target.elements.push(created); });
    setSelected(created.id);
  }

  const addText = () => addElement({ id: uid(), type: 'text', x: 280, y: 220, w: 400, h: 90, html: 'Текст', style: { fontSize: deck.theme.bodySize, align: 'left', valign: 'top' } });

  function addShape(shape: ShapeElement['shape']) {
    setMenu(null);
    addElement({
      id: uid(), type: 'shape', shape, x: 360, y: 200, w: 240, h: shape === 'line' ? 20 : 140,
      fill: shape === 'line' ? undefined : `${deck.theme.accent}33`, stroke: deck.theme.accent, strokeWidth: shape === 'line' ? 3 : 1.5,
      html: '', style: { align: 'center', valign: 'middle' },
    });
  }

  /** Вставить картинку: по центру, вписанной в 600×380; replaceId — заменить картинку выбранного блока, сохранив место. */
  async function addImage(file: File | undefined, replaceId: string | null = null, at?: { x: number; y: number }) {
    if (!file || !file.type.startsWith('image/')) return;
    setUploading(0);
    try {
      const { src, w, h } = await uploadImage(file, setUploading);
      placeImage(src, w, h, replaceId, at);
    } catch { setError('Не получилось вставить картинку: нужен PNG, JPEG, WebP или GIF.'); }
    setUploading(null);
    if (imageInput.current) imageInput.current.value = '';
    replaceRef.current = null;
  }

  function placeImage(src: string, w: number, h: number, replaceId: string | null = null, at?: { x: number; y: number }) {
    if (replaceId) { updateElement(replaceId, (item) => { if (item.type === 'image') item.src = src; }); return; }
    const scale = Math.min(1, 600 / w, 380 / h);
    const width = Math.round(w * scale);
    const height = Math.round(h * scale);
    const x = at ? Math.round(Math.min(Math.max(at.x - width / 2, 0), SLIDE_W - width)) : Math.round((SLIDE_W - width) / 2);
    const y = at ? Math.round(Math.min(Math.max(at.y - height / 2, 0), SLIDE_H - height)) : Math.round((SLIDE_H - height) / 2);
    addElement({ id: uid(), type: 'image', src, x, y, w: width, h: height, fit: 'cover' });
  }

  function addImageByUrl() {
    const url = urlValue.trim();
    if (!/^https?:\/\//i.test(url)) { setError('Нужна ссылка вида https://…'); return; }
    const probe = new Image();
    probe.onload = () => placeImage(url, probe.naturalWidth || 600, probe.naturalHeight || 400);
    probe.onerror = () => setError('Картинка по ссылке не открылась.');
    probe.src = url;
    setUrlPrompt(false);
    setUrlValue('');
  }

  function imageToBackground() {
    if (!element || element.type !== 'image') return;
    updateSlide((target) => {
      const index = target.elements.findIndex((item) => item.id === element.id);
      if (index < 0) return;
      const [item] = target.elements.splice(index, 1);
      Object.assign(item, { x: 0, y: 0, w: SLIDE_W, h: SLIDE_H, fit: 'cover' });
      target.elements.unshift(item);
    });
  }

  function imageNaturalRatio() {
    if (!element || element.type !== 'image') return;
    const probe = new Image();
    const id = element.id;
    probe.onload = () => updateElement(id, (item) => { if (probe.naturalWidth) item.h = Math.round(item.w * probe.naturalHeight / probe.naturalWidth); });
    probe.src = element.src;
  }

  function removeSelected() {
    if (!ids.length) return;
    const gone = new Set(ids);
    updateSlide((target) => { target.elements = target.elements.filter((item) => !gone.has(item.id)); });
    setSelected(null);
  }

  /** Дублировать выделенное (одно или группу): копии смещаются на 16px и становятся новым выделением. */
  function duplicateSelected() {
    if (!ids.length) return;
    const copies = slide.elements.filter((item) => ids.includes(item.id)).map((item) => ({ ...JSON.parse(JSON.stringify(item)), id: uid(), x: item.x + 16, y: item.y + 16 }) as SlideElement);
    updateSlide((target) => { target.elements.push(...copies); });
    setSelectedOne(copies[0]?.id ?? null);
    setExtra(copies.slice(1).map((item) => item.id));
  }

  /** Сдвинуть выделенное (стрелки): вся группа разом, одним шагом истории. */
  function nudgeSelected(dx: number, dy: number) {
    const moving = new Set(ids);
    updateSlide((target) => { for (const item of target.elements) if (moving.has(item.id)) { item.x += dx; item.y += dy; } });
  }

  function layer(direction: 'front' | 'back') {
    if (!selected) return;
    updateSlide((target) => {
      const index = target.elements.findIndex((item) => item.id === selected);
      if (index < 0) return;
      const [item] = target.elements.splice(index, 1);
      if (direction === 'front') target.elements.push(item); else target.elements.unshift(item);
    });
  }

  /** Стиль текста — всем выделенным текстовым блокам и фигурам (у группы — разом). */
  function setStyle(patch: Partial<TextStyle>) {
    if (!element || element.type === 'image') return;
    const styled = new Set(ids);
    updateSlide((target) => {
      for (const item of target.elements) {
        if (!styled.has(item.id) || item.type === 'image') continue;
        const next = { ...(item.style || {}), ...patch };
        if (patch.fontFamily === undefined && 'fontFamily' in patch) delete next.fontFamily;
        item.style = next;
      }
    });
  }

  /** Жирный/курсив/подчёркивание: внутри правки текста — к выделенному фрагменту, иначе — ко всему блоку. */
  function format(command: 'bold' | 'italic' | 'underline') {
    if (editing) { document.execCommand(command); return; }
    if (!element || element.type === 'image') return;
    if (command === 'bold') setStyle({ bold: !element.style?.bold });
    else if (command === 'italic') setStyle({ italic: !element.style?.italic });
    else updateElement(element.id, (target) => { if (target.type !== 'image') target.html = /^<u>[\s\S]*<\/u>$/.test(target.html || '') ? (target.html || '').replace(/^<u>|<\/u>$/g, '') : `<u>${target.html || ''}</u>`; });
  }

  function color(value: string) {
    if (editing) { document.execCommand('foreColor', false, value); return; }
    setStyle({ color: value });
  }

  function toggleList() {
    if (editing) { document.execCommand('insertUnorderedList'); return; }
    if (!element || element.type === 'image') return;
    updateElement(element.id, (target) => {
      if (target.type === 'image') return;
      const html = target.html || '';
      target.html = /^\s*<ul>/.test(html)
        ? html.replace(/<\/?ul>/g, '').replace(/<li>/g, '<div>').replace(/<\/li>/g, '</div>')
        : `<ul>${(html.split(/<br\s*\/?>|<\/div>|<\/p>/).map((part) => part.replace(/<\/?(div|p)>/g, '').trim()).filter(Boolean).map((part) => `<li>${part}</li>`).join('')) || '<li></li>'}</ul>`;
    });
  }

  function finishEditing() {
    const id = editing;
    const node = editorRef.current;
    setEditing(null);
    if (!id || !node) return;
    const html = cleanHtml(node.innerHTML);
    updateElement(id, (target) => { if (target.type !== 'image') target.html = html; });
  }

  function moveSlide(from: number, to: number) {
    if (from === to || to < 0 || to >= deck.slides.length) return;
    commit((draft) => { const [item] = draft.slides.splice(from, 1); draft.slides.splice(to, 0, item); });
    setCurrent(to);
  }

  function deleteSlide(index: number) {
    if (deck.slides.length <= 1) return;
    commit((draft) => { draft.slides.splice(index, 1); });
    setCurrent((value) => Math.max(0, Math.min(value >= index ? value - 1 : value, deck.slides.length - 2)));
    setSelected(null);
  }

  function duplicateSlide(index: number) {
    commit((draft) => { draft.slides.splice(index + 1, 0, cloneSlide(draft.slides[index])); });
    setCurrent(index + 1);
  }

  function printPdf() {
    setMenu(null);
    const pages = deck.slides.map((item) => renderToStaticMarkup(<div className="page"><SlideView slide={item} theme={deck.theme} k={1} size={size} /></div>)).join('');
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:${SLIDE_W}px ${SLIDE_H}px;margin:0}html,body{margin:0}.page{width:${SLIDE_W}px;height:${SLIDE_H}px;overflow:hidden;break-after:page;page-break-after:always}ul,ol{margin:0;padding-left:1.2em}p{margin:0}</style></head><body>${pages}</body></html>`;
    frame.onload = () => { frame.contentWindow?.focus(); frame.contentWindow?.print(); window.setTimeout(() => frame.remove(), 60_000); };
    document.body.append(frame);
  }

  // ── Клавиатура ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (show !== null || readOnly) return undefined;
    const onKey = (event: KeyboardEvent) => {
      const typing = editing || /^(INPUT|TEXTAREA|SELECT)$/.test((event.target as HTMLElement)?.tagName || '') || (event.target as HTMLElement)?.isContentEditable;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 'z' && !typing) { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
      if (mod && event.key.toLowerCase() === 'y' && !typing) { event.preventDefault(); redo(); return; }
      if (typing) { if (event.key === 'Escape' && editing) finishEditing(); return; }
      if (!stageRef.current?.closest('.nws-deck')?.contains(document.activeElement) && document.activeElement !== document.body) return;
      if ((event.key === 'Delete' || event.key === 'Backspace') && ids.length) { event.preventDefault(); removeSelected(); return; }
      if (mod && event.key.toLowerCase() === 'd' && selected) { event.preventDefault(); duplicateSelected(); return; }
      if (event.key === 'Escape') { setSelected(null); return; }
      if (mod && event.key.toLowerCase() === 'a') { event.preventDefault(); const all = slide.elements.map((item) => item.id); setSelectedOne(all[0] ?? null); setExtra(all.slice(1)); return; }
      if (selected && event.key.startsWith('Arrow')) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
        const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
        nudgeSelected(dx, dy);
        return;
      }
      if (!selected && (event.key === 'PageDown' || event.key === 'ArrowDown')) { event.preventDefault(); setCurrent((v) => Math.min(v + 1, deck.slides.length - 1)); }
      if (!selected && (event.key === 'PageUp' || event.key === 'ArrowUp')) { event.preventDefault(); setCurrent((v) => Math.max(v - 1, 0)); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Ctrl+V с картинкой в буфере — на текущий слайд (в правке текста вставляется текст).
  useEffect(() => {
    if (show !== null || readOnly) return undefined;
    const onPaste = (event: ClipboardEvent) => {
      if (editing || /^(INPUT|TEXTAREA)$/.test((event.target as HTMLElement)?.tagName || '')) return;
      const file = [...(event.clipboardData?.files || [])].find((item) => item.type.startsWith('image/'));
      if (!file) return;
      event.preventDefault();
      void addImage(file);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  // ── Показ ──────────────────────────────────────────────────────────────────
  const showRef = useRef<HTMLDivElement>(null);
  /** Размер экрана показа: слайд считается заново после перехода в полноэкранный режим и при любом ресайзе —
   *  раньше брался размер окна в момент запуска, и после разворота на весь экран слайд оставался маленьким. */
  const [showSize, setShowSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    if (show === null) return undefined;
    const measure = () => setShowSize({ w: window.innerWidth, h: window.innerHeight });
    measure();
    window.addEventListener('resize', measure);
    document.addEventListener('fullscreenchange', measure);
    return () => { window.removeEventListener('resize', measure); document.removeEventListener('fullscreenchange', measure); };
  }, [show === null]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (show === null) return undefined;
    const last = deck.slides.length - 1;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setShow(null); return; }
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(event.key)) { event.preventDefault(); setShow((v) => Math.min((v ?? 0) + 1, last)); }
      if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(event.key)) { event.preventDefault(); setShow((v) => Math.max((v ?? 0) - 1, 0)); }
    };
    window.addEventListener('keydown', onKey);
    // В приложении весь экран включает само окно (HTML-fullscreen в окне без рамки не срабатывает), в браузере — страница.
    const desktop = window.sharDesktop?.windowControls?.setFullScreen;
    if (desktop) void desktop(true);
    else void showRef.current?.requestFullscreen?.().catch(() => undefined);
    const onFull = () => { if (!desktop && !document.fullscreenElement) setShow(null); };
    document.addEventListener('fullscreenchange', onFull);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFull);
      if (desktop) void desktop(false);
      else if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, [show === null, deck.slides.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const target = selected && !editing && !readOnly ? surfaceRef.current?.querySelector<HTMLElement>(`[data-el="${selected}"]`) || null : null;
  const targets = group && !editing && !readOnly && surfaceRef.current
    ? ids.map((id) => surfaceRef.current!.querySelector<HTMLElement>(`[data-el="${id}"]`)).filter((node): node is HTMLElement => Boolean(node))
    : [];
  const idsKey = ids.join(',');
  const guides = useMemo(() => (surfaceRef.current ? [...surfaceRef.current.querySelectorAll<HTMLElement>('[data-el]')].filter((node) => !ids.includes(node.dataset.el || '')) : []), [idsKey, slide, k]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Холст как в Figma: с зажатым пробелом или средней кнопкой мыши слайд двигается вместе с полотном
   * (когда он крупнее окна — при приближении). Захват — в фазе погружения, чтобы клик не выделял элементы.
   */
  function startPan(e: React.MouseEvent<HTMLDivElement>) {
    const stage = stageRef.current;
    if (!stage || !(e.button === 1 || (e.button === 0 && panReady))) return;
    e.preventDefault();
    e.stopPropagation();
    const start = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop };
    stage.dataset.panning = 'true';
    const move = (ev: MouseEvent) => { stage.scrollLeft = start.left - (ev.clientX - start.x); stage.scrollTop = start.top - (ev.clientY - start.y); };
    const up = () => { delete stage.dataset.panning; window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  /** Рамка выделения от пустого места (на слайде или вокруг него): все задетые элементы; с Shift — добавить к выделенным. */
  function startMarquee(e: React.MouseEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    finishEditing();
    const surface = surfaceRef.current;
    if (!surface || readOnly) { setSelected(null); return; }
    const box = surface.getBoundingClientRect();
    const at = (ev: { clientX: number; clientY: number }) => ({ x: (ev.clientX - box.left) / k, y: (ev.clientY - box.top) / k });
    const from = at(e);
    const keep = e.shiftKey ? ids : [];
    let rect = { x0: from.x, y0: from.y, x1: from.x, y1: from.y };
    let moved = false;
    const move = (ev: MouseEvent) => {
      const to = at(ev);
      rect = { ...rect, x1: to.x, y1: to.y };
      if (!moved && Math.hypot((to.x - from.x) * k, (to.y - from.y) * k) < 4) return;
      moved = true;
      setMarquee(rect);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setMarquee(null);
      if (!moved) { if (!keep.length) setSelected(null); return; }
      const [left, right] = [Math.min(rect.x0, rect.x1), Math.max(rect.x0, rect.x1)];
      const [top, bottom] = [Math.min(rect.y0, rect.y1), Math.max(rect.y0, rect.y1)];
      const hit = slide.elements.filter((item) => item.x < right && item.x + item.w > left && item.y < bottom && item.y + item.h > top).map((item) => item.id);
      const next = [...keep, ...hit.filter((id) => !keep.includes(id))];
      setSelectedOne(next[0] ?? null);
      setExtra(next.slice(1));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  /** Конец перетаскивания группы: позиции всех узлов — в модель одним шагом истории. */
  function commitGroupMove(nodes: HTMLElement[]) {
    const placed = new Map(nodes.map((node) => [node.dataset.el || '', { x: Math.round(parseFloat(node.style.left) / k), y: Math.round(parseFloat(node.style.top) / k) }]));
    updateSlide((draft) => { for (const item of draft.elements) { const at = placed.get(item.id); if (at) { item.x = at.x; item.y = at.y; } } });
  }

  if (!slide) return null;
  const textual = element && element.type !== 'image' ? element : null;
  const fontSize = textual?.style?.fontSize || (textual?.role === 'title' ? theme.titleSize : theme.bodySize);

  const open = (kind: MenuState['kind'], el: HTMLElement, index?: number) => setMenu({ kind, anchor: { element: el, align: 'start' }, index });
  const swatch = (label: string, value: string, onChange: (next: string) => void, icon: ReactNode) => (
    <label className="nws-deck-swatch" title={label}>{icon}<i style={{ background: value }} /><input type="color" value={value.slice(0, 7)} onChange={(e) => onChange(e.target.value)} aria-label={label} /></label>
  );
  const btn = (key: string, label: string, icon: ReactNode, run: (e: React.MouseEvent<HTMLButtonElement>) => void, opts: { on?: boolean; disabled?: boolean } = {}) => (
    <button key={key} type="button" className="nx-icon-btn" title={label} aria-label={label} aria-pressed={opts.on} disabled={opts.disabled} onMouseDown={(e) => e.preventDefault()} onClick={run}>{icon}</button>
  );
  const sep = (key: string) => <i key={key} className="nws-deck-sep" aria-hidden="true" />;
  const notesButton = (
    <button type="button" className="nx-icon-btn nws-deck-notes-btn" data-on={notesOpen || undefined} data-has={slide?.notes?.trim() ? true : undefined} aria-pressed={notesOpen} onClick={toggleNotes} title={notesOpen ? 'Скрыть заметки докладчика' : 'Заметки докладчика'} aria-label="Заметки докладчика">
      <NotebookPen size={16} />
    </button>
  );
  // Масштаб — в панели инструментов, а не поверх слайда: в углу он закрывал край слайда.
  const zoomBar = (
    <div className="nws-deck-zoom" role="group" aria-label="Масштаб слайда">
      <button type="button" onClick={() => setZoom((v) => Math.max(0.25, v / 1.25))} title="Отдалить" aria-label="Отдалить"><Minus size={13} /></button>
      <span>{Math.round(k * 100)}%</span>
      <button type="button" onClick={() => setZoom((v) => Math.min(4, v * 1.25))} title="Приблизить (Ctrl + колесо; двигать — пробел + мышь)" aria-label="Приблизить"><Plus size={13} /></button>
      <button type="button" className={zoom === 1 ? 'is-on' : undefined} onClick={() => setZoom(1)} title="Вписать слайд в окно">По размеру</button>
    </div>
  );

  return (
    <div className="nws-deck" data-readonly={readOnly || undefined}>
      {!readOnly && (
        <div className="nws-deck-bar" role="toolbar" aria-label="Презентация">
          {/* Панель всегда в одну строку: инструменты выделенного прокручиваются, правая группа закреплена —
              иначе при выделении панель переносилась на две строки и холст под ней прыгал. */}
          <div className="nws-deck-tools" onWheel={(e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY; }}>
          {btn('undo', 'Отменить (Ctrl+Z)', <Undo2 size={16} />, undo, { disabled: !pastRef.current.length })}
          {btn('redo', 'Повторить (Ctrl+Shift+Z)', <Redo2 size={16} />, redo, { disabled: !futureRef.current.length })}
          {sep('s1')}
          {btn('slide', 'Новый слайд', <Plus size={16} />, (e) => open('layout', e.currentTarget))}
          {btn('text', 'Текстовый блок', <Type size={16} />, addText)}
          {btn('shape', 'Фигура', <Square size={16} />, (e) => open('shape', e.currentTarget))}
          {btn('image', 'Картинка с компьютера (или Ctrl+V, перетащите файл на слайд)', <ImageIcon size={16} />, () => { replaceRef.current = null; imageInput.current?.click(); })}
          {btn('image-url', 'Картинка по ссылке', <Link2 size={16} />, () => setUrlPrompt(true))}
          {textual && (
            <>
              {sep('s2')}
              <button type="button" className="nws-deck-font" title="Шрифт" aria-haspopup="menu" aria-expanded={menu?.kind === 'font'} style={{ fontFamily: textual.style?.fontFamily || theme.fontFamily }} onClick={(e) => open('font', e.currentTarget)}>
                {fontName(textual.style?.fontFamily)}
              </button>
              {btn('smaller', 'Меньше шрифт', <Minus size={16} />, () => setStyle({ fontSize: Math.max(8, fontSize - 2) }))}
              <input className="nws-deck-size" type="number" min={8} max={160} value={fontSize} onChange={(e) => setStyle({ fontSize: Math.max(8, Math.min(160, Number(e.target.value) || fontSize)) })} aria-label="Размер шрифта" />
              {btn('bigger', 'Больше шрифт', <Plus size={16} />, () => setStyle({ fontSize: Math.min(160, fontSize + 2) }))}
              {btn('bold', 'Жирный (Ctrl+B)', <Bold size={16} />, () => format('bold'), { on: Boolean(textual.style?.bold) })}
              {btn('italic', 'Курсив (Ctrl+I)', <Italic size={16} />, () => format('italic'), { on: Boolean(textual.style?.italic) })}
              {btn('underline', 'Подчёркнутый', <Underline size={16} />, () => format('underline'))}
              {swatch('Цвет текста', textual.style?.color || theme.text, color, <Palette size={16} />)}
              {btn('left', 'По левому краю', <AlignLeft size={16} />, () => setStyle({ align: 'left' }), { on: (textual.style?.align || 'left') === 'left' })}
              {btn('center', 'По центру', <AlignCenter size={16} />, () => setStyle({ align: 'center' }), { on: textual.style?.align === 'center' })}
              {btn('right', 'По правому краю', <AlignRight size={16} />, () => setStyle({ align: 'right' }), { on: textual.style?.align === 'right' })}
              {btn('list', 'Список', <List size={16} />, toggleList)}
              {element?.type === 'shape' && element.shape !== 'line' && swatch('Заливка', element.fill || '#ffffff', (value) => updateElement(element.id, (item) => { if (item.type === 'shape') item.fill = value; }), <Square size={16} />)}
            </>
          )}
          {element?.type === 'image' && (
            <>
              {sep('s3')}
              {btn('replace', 'Заменить картинку', <Replace size={16} />, () => { replaceRef.current = element.id; imageInput.current?.click(); })}
              {btn('cover', 'Заполнить рамку (лишнее обрезается)', <Maximize size={16} />, () => updateElement(element.id, (item) => { if (item.type === 'image') item.fit = 'cover'; }), { on: (element.fit || 'cover') === 'cover' })}
              {btn('contain', 'Вписать целиком', <Minimize2 size={16} />, () => updateElement(element.id, (item) => { if (item.type === 'image') item.fit = 'contain'; }), { on: element.fit === 'contain' })}
              {btn('ratio', 'Вернуть исходные пропорции', <Scan size={16} />, imageNaturalRatio)}
              {btn('background', 'На весь слайд, под текст', <SquareDashed size={16} />, imageToBackground)}
              {btn('round', 'Скруглить углы', <Square size={16} />, () => updateElement(element.id, (item) => { if (item.type === 'image') item.radius = item.radius ? 0 : 16; }), { on: Boolean(element.radius) })}
              <label className="nws-deck-opacity" title="Прозрачность"><input type="range" min={10} max={100} step={5} value={Math.round((element.opacity ?? 1) * 100)} onChange={(e) => updateElement(element.id, (item) => { if (item.type === 'image') item.opacity = Number(e.target.value) / 100; })} aria-label="Непрозрачность" /></label>
            </>
          )}
          {sep('s4')}
          {group && <span className="nws-deck-count">Выбрано: {ids.length}</span>}
          {element ? (
            <>
              {!group && btn('front', 'На передний план', <ArrowUpToLine size={16} />, () => layer('front'))}
              {!group && btn('back', 'На задний план', <ArrowDownToLine size={16} />, () => layer('back'))}
              {btn('duplicate', 'Дублировать (Ctrl+D)', <Copy size={16} />, duplicateSelected)}
              {btn('delete', 'Удалить (Delete)', <Trash2 size={16} />, removeSelected)}
            </>
          ) : (
            <>
              {btn('theme', 'Тема презентации', <Palette size={16} />, (e) => open('theme', e.currentTarget))}
              {swatch('Фон этого слайда', slide.background || theme.background, (value) => updateSlide((item) => { item.background = value; }), <Paintbrush size={16} />)}
            </>
          )}
          </div>
          <div className="nws-deck-fixed">
          {zoomBar}
          {notesButton}
          {btn('export', 'Скачать: PowerPoint или PDF', <Download size={16} />, (e) => open('export', e.currentTarget))}
          {btn('play', 'Показ на весь экран', <Play size={16} />, () => { finishEditing(); setShow(current); })}
          </div>
          <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => void addImage(e.target.files?.[0], replaceRef.current)} />
        </div>
      )}
      {readOnly && (
        <div className="nws-deck-bar" role="toolbar" aria-label="Презентация">
          <span className="nws-grow" />
          {zoomBar}
          {notesButton}
          {btn('export', 'Скачать: PowerPoint или PDF', <Download size={16} />, (e) => open('export', e.currentTarget))}
          {btn('play', 'Показ на весь экран', <Play size={16} />, () => setShow(current))}
        </div>
      )}
      {error && <div className="nws-banner" role="alert">{error}<button type="button" className="nx-icon-btn" onClick={() => setError('')} aria-label="Скрыть"><X size={14} /></button></div>}

      <div className="nws-deck-body">
        <ol className="nws-deck-thumbs" aria-label="Слайды">
          {deck.slides.map((item, index) => (
            <li
              key={item.id}
              className={['nws-deck-thumb', index === current ? 'is-current' : ''].filter(Boolean).join(' ')}
              draggable={!readOnly}
              onDragStart={() => { dragFrom.current = index; }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => { if (dragFrom.current !== null) moveSlide(dragFrom.current, index); dragFrom.current = null; }}
              onClick={() => { finishEditing(); setCurrent(index); setSelected(null); }}
              onContextMenu={(e) => { if (readOnly) return; e.preventDefault(); setMenu({ kind: 'thumb', anchor: { x: e.clientX, y: e.clientY }, index }); }}
            >
              <span className="nws-deck-thumb-no">{index + 1}</span>
              <div className="nws-deck-thumb-frame"><SlideView slide={item} theme={theme} k={Math.min(THUMB_W / SLIDE_W, THUMB_H / SLIDE_H)} size={size} /></div>
            </li>
          ))}
          {!readOnly && <li className="nws-deck-thumb-add"><button type="button" className="nx-ghost" onClick={(e) => open('layout', e.currentTarget)}><Plus size={14} /> Слайд</button></li>}
        </ol>

        <div className="nws-deck-main">
          {uploading !== null && (
            <div className="nws-deck-upload" role="status" aria-live="polite">
              <Spinner size={16} />
              <span>{uploading > 0 ? `Загружаю картинку… ${uploading}%` : 'Готовлю картинку…'}</span>
              <i style={{ '--progress': `${uploading}%` } as CSSProperties} aria-hidden="true" />
            </div>
          )}
          <div className="nws-deck-stage" ref={stageRef} data-pan={panReady || undefined} onMouseDownCapture={startPan} onMouseDown={(e) => { if (e.target === e.currentTarget) startMarquee(e); }} onDoubleClick={(e) => { if (e.target === e.currentTarget) setZoom(1); }}>
            <div
              ref={surfaceRef}
              className="nws-deck-surface"
              style={{ width: SLIDE_W * k, height: SLIDE_H * k, background: slide.background || theme.background }}
              onMouseDown={(e) => { if (e.target === e.currentTarget) startMarquee(e); }}
              onDragOver={(e) => { if (!readOnly && [...e.dataTransfer.items].some((item) => item.kind === 'file')) e.preventDefault(); }}
              onDrop={(e) => {
                if (readOnly) return;
                const file = [...e.dataTransfer.files].find((item) => item.type.startsWith('image/'));
                if (!file) return;
                e.preventDefault();
                const box = e.currentTarget.getBoundingClientRect();
                void addImage(file, null, { x: (e.clientX - box.left) / k, y: (e.clientY - box.top) / k });
              }}
            >
              {slide.elements.map((item) => {
                const isEditing = editing === item.id;
                const style: CSSProperties = { ...boxStyle(item, k), cursor: readOnly ? 'default' : isEditing ? 'text' : 'move' };
                return (
                  <div
                    key={item.id}
                    data-el={item.id}
                    className={['nws-deck-el', ids.includes(item.id) ? 'is-selected' : '', isEditing ? 'is-editing' : ''].filter(Boolean).join(' ')}
                    style={style}
                    onMouseDown={(e) => {
                      // Ctrl+клик по ссылке в тексте — открыть её (как в документах и таблицах), а не выделять блок.
                      const link = (e.ctrlKey || e.metaKey) && !isEditing ? (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href]') : null;
                      if (link) { e.preventDefault(); e.stopPropagation(); window.open(link.href, '_blank', 'noopener,noreferrer'); return; }
                      if (readOnly || isEditing || e.button !== 0) return;
                      if (editing) finishEditing();
                      e.stopPropagation();
                      if (e.shiftKey) {
                        // Shift+клик — добавить к выделению или убрать из него (как в Figma).
                        if (!selected) { setSelected(item.id); return; }
                        if (item.id === selected) { const [next, ...rest] = extra; setSelectedOne(next ?? null); setExtra(rest); return; }
                        setExtra((list) => (list.includes(item.id) ? list.filter((id) => id !== item.id) : [...list, item.id]));
                        return;
                      }
                      // Клик по элементу группы оставляет группу — её можно тащить целиком.
                      if (!ids.includes(item.id)) setSelected(item.id);
                    }}
                    onDoubleClick={() => { if (!readOnly && item.type !== 'image') { setSelected(item.id); setEditing(item.id); } }}
                  >
                    <ElementContent element={item} theme={theme} k={k}>
                      {isEditing && item.type !== 'image' ? (
                        <div
                          ref={(node) => { editorRef.current = node; if (node && document.activeElement !== node) { node.innerHTML = cleanHtml(item.html || ''); node.focus(); document.getSelection()?.selectAllChildren(node); document.getSelection()?.collapseToEnd(); } }}
                          className="slide-text nws-deck-editable"
                          contentEditable
                          suppressContentEditableWarning
                          onBlur={finishEditing}
                        />
                      ) : undefined}
                    </ElementContent>
                  </div>
                );
              })}
              {marquee && (
                <div
                  className="nws-deck-marquee"
                  style={{ left: Math.min(marquee.x0, marquee.x1) * k, top: Math.min(marquee.y0, marquee.y1) * k, width: Math.abs(marquee.x1 - marquee.x0) * k, height: Math.abs(marquee.y1 - marquee.y0) * k }}
                />
              )}
              {targets.length > 1 && (
                <Moveable
                  ref={moveableRef}
                  target={targets}
                  draggable
                  snappable
                  elementGuidelines={guides}
                  snapThreshold={6}
                  isDisplaySnapDigit={false}
                  origin={false}
                  throttleDrag={0}
                  onDragGroup={({ events }) => { for (const ev of events) { ev.target.style.left = `${ev.left}px`; ev.target.style.top = `${ev.top}px`; } }}
                  onDragGroupEnd={({ targets: nodes, isDrag }) => { if (isDrag) commitGroupMove(nodes as HTMLElement[]); }}
                />
              )}
              {target && !group && (
                <Moveable
                  ref={moveableRef}
                  target={target}
                  draggable
                  resizable
                  keepRatio={element?.type === 'image'}
                  snappable
                  elementGuidelines={guides}
                  snapThreshold={6}
                  isDisplaySnapDigit={false}
                  origin={false}
                  throttleDrag={0}
                  onDrag={({ target: node, left, top }) => { node.style.left = `${left}px`; node.style.top = `${top}px`; }}
                  onDragEnd={({ target: node, isDrag }) => { if (isDrag && selected) updateElement(selected, (item) => { item.x = Math.round(parseFloat(node.style.left) / k); item.y = Math.round(parseFloat(node.style.top) / k); }); }}
                  onResize={({ target: node, width, height, drag }) => { node.style.width = `${width}px`; node.style.height = `${height}px`; node.style.left = `${drag.left}px`; node.style.top = `${drag.top}px`; }}
                  onResizeEnd={({ target: node }) => { if (selected) updateElement(selected, (item) => { item.x = Math.round(parseFloat(node.style.left) / k); item.y = Math.round(parseFloat(node.style.top) / k); item.w = Math.max(10, Math.round(parseFloat(node.style.width) / k)); item.h = Math.max(10, Math.round(parseFloat(node.style.height) / k)); }); }}
                />
              )}
            </div>
          </div>
          {notesOpen && <textarea
            className="nws-deck-notes"
            value={slide.notes || ''}
            readOnly={readOnly}
            onChange={(e) => { const value = e.target.value; commit((draft) => { draft.slides[current].notes = value; }); }}
            placeholder="Заметки докладчика к этому слайду"
            aria-label="Заметки докладчика"
          />}
        </div>
      </div>

      {menu?.kind === 'layout' && (
        <Menu anchor={menu.anchor} label="Макет слайда" onClose={() => setMenu(null)}>
          <div className="nws-deck-layouts">
            {LAYOUTS.map((layoutItem) => (
              <button key={layoutItem.id} type="button" role="menuitem" className="nx-menu-item" onClick={() => addSlide(layoutItem.id)}>
                <span className="nws-deck-layout-preview"><SlideView slide={newSlide(layoutItem.id, theme, size)} theme={theme} k={72 / SLIDE_W} size={size} /></span>
                <span>{layoutItem.name}</span>
              </button>
            ))}
          </div>
        </Menu>
      )}
      {menu?.kind === 'font' && (
        <Menu anchor={menu.anchor} label="Шрифт" onClose={() => setMenu(null)}>
          {FONTS.map((font) => (
            <button
              key={font.name}
              type="button"
              role="menuitemradio"
              aria-checked={(textual?.style?.fontFamily || '') === font.value}
              className="nx-menu-item"
              style={{ fontFamily: font.value || theme.fontFamily }}
              onClick={() => { setStyle({ fontFamily: font.value || undefined }); setMenu(null); }}
            >
              {font.name}
            </button>
          ))}
        </Menu>
      )}
      {menu?.kind === 'shape' && (
        <Menu anchor={menu.anchor} label="Фигура" onClose={() => setMenu(null)}>
          <MenuItem icon={<Square size={15} />} onSelect={() => addShape('rect')}>Прямоугольник</MenuItem>
          <MenuItem icon={<Square size={15} />} onSelect={() => addShape('round')}>Скруглённый</MenuItem>
          <MenuItem icon={<Circle size={15} />} onSelect={() => addShape('ellipse')}>Овал</MenuItem>
          <MenuItem icon={<Minus size={15} />} onSelect={() => addShape('line')}>Линия</MenuItem>
        </Menu>
      )}
      {menu?.kind === 'theme' && (
        <Menu anchor={menu.anchor} label="Тема презентации" onClose={() => setMenu(null)}>
          {THEMES.map((item) => (
            <button key={item.name} type="button" role="menuitemradio" aria-checked={theme.name === item.name} className="nx-menu-item" onClick={() => { commit((draft) => { draft.theme = { ...item }; }); setMenu(null); }}>
              <span className="nws-deck-theme-chip" style={{ background: item.background, borderColor: item.accent, color: item.text }}>Аа</span>
              <span>{item.name}</span>
            </button>
          ))}
          <label className="nws-deck-accent"><span>Акцент</span><input type="color" value={theme.accent} onChange={(e) => commit((draft) => { draft.theme.accent = e.target.value; })} /></label>
        </Menu>
      )}
      {menu?.kind === 'export' && (
        <Menu anchor={menu.anchor} label="Скачать" onClose={() => setMenu(null)}>
          <MenuItem icon={<Download size={15} />} onSelect={() => { setMenu(null); void exportPptx(deck, title).catch(() => setError('Не удалось собрать PPTX')); }}>PowerPoint (.pptx)</MenuItem>
          <MenuItem icon={<Printer size={15} />} onSelect={printPdf}>PDF (через печать)</MenuItem>
        </Menu>
      )}
      {menu?.kind === 'thumb' && menu.index !== undefined && (
        <Menu anchor={menu.anchor} label="Слайд" onClose={() => setMenu(null)}>
          <MenuItem icon={<Copy size={15} />} onSelect={() => { const i = menu.index!; setMenu(null); duplicateSlide(i); }}>Дублировать слайд</MenuItem>
          <MenuItem icon={<ChevronLeft size={15} />} onSelect={() => { const i = menu.index!; setMenu(null); moveSlide(i, i - 1); }}>Выше</MenuItem>
          <MenuItem icon={<ChevronRight size={15} />} onSelect={() => { const i = menu.index!; setMenu(null); moveSlide(i, i + 1); }}>Ниже</MenuItem>
          <MenuItem icon={<Trash2 size={15} />} tone="danger" disabled={deck.slides.length <= 1} onSelect={() => { const i = menu.index!; setMenu(null); deleteSlide(i); }}>Удалить слайд</MenuItem>
        </Menu>
      )}
      {urlPrompt && (
        <Sheet
          title="Картинка по ссылке"
          onClose={() => setUrlPrompt(false)}
          footer={<><button type="button" className="nx-ghost" onClick={() => setUrlPrompt(false)}>Отмена</button><button type="button" className="nx-primary" disabled={!urlValue.trim()} onClick={addImageByUrl}>Вставить</button></>}
        >
          <label className="nx-field"><input autoFocus value={urlValue} placeholder="https://…" onChange={(e) => setUrlValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addImageByUrl(); }} /></label>
        </Sheet>
      )}
      {show !== null && (
        <div
          className="nws-show"
          ref={showRef}
          onClick={(e) => {
            // На показе ссылка открывается обычным кликом (и не перелистывает слайд).
            const link = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
            if (link) { e.preventDefault(); window.open(link.href, '_blank', 'noopener,noreferrer'); return; }
            setShow((v) => Math.min((v ?? 0) + 1, deck.slides.length - 1));
          }}
        >
          <div className="nws-show-stage">
            <SlideView slide={deck.slides[show] || deck.slides[0]} theme={theme} k={Math.min(showSize.w / SLIDE_W, showSize.h / SLIDE_H)} size={size} />
          </div>
          <div className="nws-show-bar" onClick={(e) => e.stopPropagation()}>
            <button type="button" onClick={() => setShow((v) => Math.max((v ?? 0) - 1, 0))} aria-label="Назад"><ChevronLeft size={18} /></button>
            <span>{show + 1} / {deck.slides.length}</span>
            <button type="button" onClick={() => setShow((v) => Math.min((v ?? 0) + 1, deck.slides.length - 1))} aria-label="Вперёд"><ChevronRight size={18} /></button>
            <button type="button" onClick={() => { setShow(null); if (document.fullscreenElement) void document.exitFullscreen(); }} aria-label="Закрыть показ"><X size={18} /></button>
          </div>
        </div>
      )}
    </div>
  );
}
