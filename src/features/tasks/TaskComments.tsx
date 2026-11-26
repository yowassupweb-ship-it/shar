import { useEffect, useMemo, useState, type RefObject } from 'react';
import { ClipboardPaste, Copy, MessageSquarePlus, Scissors, TextSelect } from 'lucide-react';
import { Menu, MenuItem } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import type { CommentSource } from '@/features/workspace/useComments';
import type { Comment, CommentAnchor } from '@/features/workspace/types';

/**
 * Комментарии задачи — как у документов: ветки к выделенному тексту в панели справа (та же CommentsPanel),
 * прокомментированный текст подсвечен, щелчок по нему открывает ветку. Сервер — todos/comments.py.
 */

async function call<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.json !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).detail || ''; } catch { /* не JSON */ }
    throw new Error(typeof detail === 'string' && detail ? detail : 'Нет связи с сервером');
  }
  return (await res.json()) as T;
}

export function taskCommentSource(taskId: string | null): CommentSource {
  const base = `/api/todos/${encodeURIComponent(taskId || '')}/comments`;
  return {
    key: taskId,
    list: () => call<{ comments: Comment[]; ready: boolean }>(base, { cache: 'no-store' }),
    add: (body, anchor, parentId) => call<{ comment: Comment }>(base, { method: 'POST', json: { body, anchor: anchor ?? null, parentId: parentId ?? null } }).then((r) => r.comment),
    change: (id, patch) => call<{ comment: Comment }>(`${base}/${encodeURIComponent(id)}`, { method: 'PATCH', json: patch }).then((r) => r.comment),
    remove: (id) => call(`${base}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    isEvent: (e) => e.type === 'task_comments' && String(e.taskId) === taskId,
  };
}

const MAX_QUOTE = 300;
/** Невидимая метка пустой строки (shared/markdown/paragraphs.ts) — для поиска цитаты это пробел. */
const ZWSP = String.fromCharCode(0x200b);
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Выделенный в задаче текст — привязка нового комментария (или null, если выделено не здесь). */
export function selectionAnchor(root: HTMLElement | null): CommentAnchor | null {
  const sel = window.getSelection();
  if (!root || !sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const quote = squash(sel.toString()).slice(0, MAX_QUOTE);
  return quote ? { kind: 'text', quote } : null;
}

/**
 * Найти цитату в тексте страницы задачи. Сравниваем со сжатыми пробелами: выделение отдаёт переносы между абзацами,
 * а в DOM их нет — между блоками считаем пробел.
 */
export function findQuote(root: HTMLElement, quote: string): Range | null {
  const want = squash(quote);
  if (!want) return null;
  const map: Array<{ node: Text; offset: number }> = [];
  let text = '';
  let prevBlock: Element | null = null;
  // Текст и переносы <br>: перенос строки, как и граница блока, — пробел (так его отдаёт выделение).
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => {
      const el = n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement;
      if (el?.closest('textarea, input, [aria-hidden="true"]')) return NodeFilter.FILTER_REJECT;
      return n.nodeType === Node.TEXT_NODE || (n as Element).tagName === 'BR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  let last: Text | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType !== Node.TEXT_NODE) {
      if (last && text && !text.endsWith(' ')) { text += ' '; map.push({ node: last, offset: Math.max(0, last.data.length - 1) }); }
      continue;
    }
    const node = n as Text;
    const block = node.parentElement?.closest('p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th, div') ?? null;
    if (prevBlock && block !== prevBlock && text && !text.endsWith(' ')) { text += ' '; map.push({ node, offset: 0 }); }
    prevBlock = block;
    last = node;
    const value = node.data.split(ZWSP).join(' ');
    for (let i = 0; i < value.length; i += 1) {
      const ch = /\s/.test(value[i]) ? ' ' : value[i];
      if (ch === ' ' && (!text || text.endsWith(' '))) continue;
      text += ch;
      map.push({ node, offset: i });
    }
  }
  const at = text.indexOf(want);
  if (at < 0) return null;
  const start = map[at];
  const end = map[at + want.length - 1];
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset + 1);
  return range;
}

type HighlightRegistry = { set: (name: string, h: unknown) => void; delete: (name: string) => void };
const registry = (): HighlightRegistry | null => (typeof CSS !== 'undefined' && 'highlights' in CSS ? (CSS as unknown as { highlights: HighlightRegistry }).highlights : null);
const HighlightCtor = (): (new (...ranges: Range[]) => unknown) | null => (typeof window !== 'undefined' && 'Highlight' in window ? (window as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight : null);

/**
 * Подсветка прокомментированного текста (CSS Custom Highlight API — текст и редактор не меняются). Пересчёт — после
 * правки текста, смены режима и комментариев. Возвращает функцию: какая цитата под точкой экрана (для щелчка).
 */
export function useQuoteHighlights(root: RefObject<HTMLElement | null>, quotes: string[], version: unknown): (x: number, y: number) => string | null {
  const [ranges, setRanges] = useState<Array<{ quote: string; range: Range }>>([]);
  const key = quotes.join('\u0001');
  useEffect(() => {
    const reg = registry();
    const Ctor = HighlightCtor();
    const compute = () => {
      const el = root.current;
      if (!el) { setRanges([]); return; }
      const found = quotes.map((quote) => ({ quote, range: findQuote(el, quote) })).filter((x): x is { quote: string; range: Range } => Boolean(x.range));
      setRanges(found);
      if (reg && Ctor) {
        if (found.length) reg.set('ntd-comment', new Ctor(...found.map((f) => f.range)));
        else reg.delete('ntd-comment');
      }
    };
    // Текст редактора дорисовывается после рендера — считаем на следующем кадре и ещё раз чуть позже.
    const a = window.requestAnimationFrame(compute);
    const b = window.setTimeout(compute, 400);
    return () => { window.cancelAnimationFrame(a); window.clearTimeout(b); };
  }, [key, version, root]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => registry()?.delete('ntd-comment'), []);
  return useMemo(() => (x: number, y: number) => {
    for (const r of ranges) for (const rect of Array.from(r.range.getClientRects())) {
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return r.quote;
    }
    return null;
  }, [ranges]);
}

const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const kbd = (k: string) => (mac ? `⌘${k}` : `Ctrl+${k}`);

/**
 * Меню правого клика в тексте задачи — меню Шара, как у документов (DocContextMenu), а не системное: вырезать,
 * копировать, вставить, выделить всё и «Комментарий» к выделенному. Shift+ПКМ — по-прежнему системное (орфография).
 */
export function TaskTextMenu({ at, editable, root, onComment, onClose }: {
  at: { x: number; y: number }; editable: boolean; root: HTMLElement | null; onComment?: () => void; onClose: () => void;
}) {
  const sel = typeof window !== 'undefined' ? window.getSelection() : null;
  const has = Boolean(sel && !sel.isCollapsed && squash(sel.toString()));
  const run = (fn: () => void) => () => { onClose(); fn(); };
  const clip = (cmd: 'cut' | 'copy') => { if (!document.execCommand(cmd)) showToast(`Нажмите ${kbd(cmd === 'cut' ? 'X' : 'C')}`, 'info'); };
  const paste = async () => {
    // В приложении execCommand('paste') вставляет как Ctrl+V; в браузере он запрещён — берём текст из буфера.
    if (document.execCommand('paste')) return;
    try { const text = await navigator.clipboard.readText(); if (text) document.execCommand('insertText', false, text); } catch { showToast(`Нажмите ${kbd('V')}`, 'info'); }
  };
  const selectAll = () => {
    const target = (document.activeElement && root?.contains(document.activeElement) && (document.activeElement as HTMLElement).isContentEditable)
      ? document.activeElement : root?.querySelector('.nve-content, .ntd-read');
    if (!target) return;
    const range = document.createRange();
    range.selectNodeContents(target);
    const s = window.getSelection();
    s?.removeAllRanges();
    s?.addRange(range);
  };
  return (
    <Menu anchor={at} label="Действия с текстом" onClose={onClose}>
      {editable && <MenuItem icon={<Scissors size={16} />} disabled={!has} onSelect={run(() => clip('cut'))}>Вырезать <kbd className="nx-menu-kbd">{kbd('X')}</kbd></MenuItem>}
      <MenuItem icon={<Copy size={16} />} disabled={!has} onSelect={run(() => clip('copy'))}>Копировать <kbd className="nx-menu-kbd">{kbd('C')}</kbd></MenuItem>
      {editable && <MenuItem icon={<ClipboardPaste size={16} />} onSelect={run(() => void paste())}>Вставить <kbd className="nx-menu-kbd">{kbd('V')}</kbd></MenuItem>}
      <MenuItem icon={<TextSelect size={16} />} onSelect={run(selectAll)}>Выделить всё <kbd className="nx-menu-kbd">{kbd('A')}</kbd></MenuItem>
      {onComment && (
        <>
          <div className="nx-menu-sep" />
          <MenuItem icon={<MessageSquarePlus size={16} />} disabled={!has} onSelect={run(onComment)}>Комментарий <kbd className="nx-menu-kbd">{mac ? '⌥⌘M' : 'Ctrl+Alt+M'}</kbd></MenuItem>
        </>
      )}
    </Menu>
  );
}
