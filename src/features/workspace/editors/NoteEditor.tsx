import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { Bold, CheckSquare, Plus, X, Code2, Eye, Heading2, ImagePlus, Italic, Link2, List, ListOrdered, Pencil, Quote, Smile } from 'lucide-react';
import { uploadFileWithProgress } from '@/shared/api/uploadFile';
import { renderTextWithEmoji } from '@/shared/emoji/emojiText';
import { SharEmojiPicker } from '@/shared/emoji/SharEmojiPicker';
import { askConfirm, Menu, type MenuAnchor } from '@/shared/ui/overlay';
import { merge3, shiftCaret } from '../lib/merge';
import { highlightMarkdown } from '../lib/mdHighlight';
import { cleanTabTitle, parseTabs, serializeTabs } from '../lib/noteTabs';
import { FindBar, findAll } from './FindBar';
import type { EditorProps } from './types';
import type { RemoteCursor } from '../useCursors';
import { Spinner } from '@/shared/ui/Spinner';
import { ScrollTable } from '@/shared/ui/ScrollTable';

/**
 * Заметка: Markdown с панелью форматирования и предпросмотром. Правка — в textarea (на телефоне это
 * единственное, что не воюет с экранной клавиатурой), предпросмотр — те же react-markdown + GFM, что и
 * в чатах. Картинку можно выбрать, перетащить или вставить из буфера — она уходит в хранилище файлов
 * Шара, а в текст ложится ссылка.
 */

/** Курсор в заметке: вкладка, начало и конец выделения в её тексте и направление выделения. */
type NoteCursor = { s: number; e: number; b: 0 | 1; t?: number };

/**
 * Зеркало текста с курсорами коллег: тот же текст тем же шрифтом (прозрачный), выделение — фоном цвета
 * человека, каретка — линией с флажком имени. Смещения коллеги относятся к его тексту; если он ещё не
 * сохранил последние правки, позиция может чуть отличаться — подрезаем по длине.
 */
function cursorMirror(text: string, cursors: RemoteCursor[]): React.ReactNode[] {
  const marks = cursors.flatMap((c) => {
    const p = c.pos as NoteCursor;
    if (typeof p.s !== 'number' || typeof p.e !== 'number') return [];
    const s = Math.max(0, Math.min(text.length, Math.min(p.s, p.e)));
    const e = Math.max(0, Math.min(text.length, Math.max(p.s, p.e)));
    return [{ c, s, e, at: p.b ? s : e }];
  });
  const cuts = [...new Set([0, text.length, ...marks.flatMap((m) => [m.s, m.e, m.at])])].sort((a, b) => a - b);
  const out: React.ReactNode[] = [];
  cuts.forEach((at, i) => {
    for (const m of marks) {
      if (m.at === at) {
        out.push(
          <span key={`c${m.c.userId}`} className="nws-ncaret" style={{ '--c': m.c.color } as React.CSSProperties}>
            <span key={m.c.movedAt} className="nws-cursor-flag">{m.c.name}</span>
          </span>,
        );
      }
    }
    const next = cuts[i + 1];
    if (next === undefined) return;
    const piece = text.slice(at, next);
    const over = marks.find((m) => m.s <= at && next <= m.e && m.s < m.e);
    out.push(over ? <span key={`s${at}`} className="nws-nsel" style={{ '--c': over.c.color } as React.CSSProperties}>{piece}</span> : piece);
  });
  return out;
}

type Wrap = { before: string; after?: string; placeholder?: string; line?: boolean };

/** Эмодзи в просмотре рисуются картинками Шара (как в чате), а не шрифтом системы: у разных систем они выглядят по-разному. */
const withEmoji = (children: React.ReactNode, key: string): React.ReactNode =>
  Array.isArray(children)
    ? children.map((child, i) => (typeof child === 'string' ? <span key={`${key}${i}`}>{renderTextWithEmoji(child, `${key}${i}`)}</span> : child))
    : typeof children === 'string' ? renderTextWithEmoji(children, key) : children;

const TOOLS: Array<{ id: string; label: string; icon: typeof Bold; wrap: Wrap }> = [
  { id: 'bold', label: 'Жирный', icon: Bold, wrap: { before: '**', after: '**', placeholder: 'жирный' } },
  { id: 'italic', label: 'Курсив', icon: Italic, wrap: { before: '*', after: '*', placeholder: 'курсив' } },
  { id: 'h2', label: 'Заголовок', icon: Heading2, wrap: { before: '## ', line: true, placeholder: 'Заголовок' } },
  { id: 'ul', label: 'Список', icon: List, wrap: { before: '- ', line: true, placeholder: 'пункт' } },
  { id: 'ol', label: 'Нумерованный список', icon: ListOrdered, wrap: { before: '1. ', line: true, placeholder: 'пункт' } },
  { id: 'task', label: 'Задача с галочкой', icon: CheckSquare, wrap: { before: '- [ ] ', line: true, placeholder: 'сделать' } },
  { id: 'quote', label: 'Цитата', icon: Quote, wrap: { before: '> ', line: true, placeholder: 'цитата' } },
  { id: 'code', label: 'Код', icon: Code2, wrap: { before: '`', after: '`', placeholder: 'код' } },
  { id: 'link', label: 'Ссылка', icon: Link2, wrap: { before: '[', after: '](https://)', placeholder: 'текст' } },
];

export function NoteEditor({ content, onContent, readOnly, loadKey, cursors = [], onCursor }: EditorProps) {
  // full — заметка целиком (все вкладки), text — открытая вкладка: с ней работают поле, просмотр, поиск и панель.
  const [full, setFull] = useState(content);
  const fullRef = useRef(full);
  fullRef.current = full;
  const tabs = useMemo(() => parseTabs(full), [full]);
  const [activeTab, setActiveTab] = useState(0);
  const tabIndex = Math.min(activeTab, tabs.length - 1);
  const tabRef = useRef(tabIndex);
  tabRef.current = tabIndex;
  const text = tabs[tabIndex].content;
  const [renaming, setRenaming] = useState<number | null>(null);
  const [mode, setMode] = useState<'edit' | 'preview'>(content.trim() ? 'preview' : 'edit');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [emojiAt, setEmojiAt] = useState<MenuAnchor | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const view = useRef<HTMLElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLDivElement>(null);
  const syntax = useRef<HTMLDivElement>(null);
  const mirror = useRef<HTMLDivElement>(null);

  // Поиск по тексту (Ctrl+F). В правке совпадения подсвечивает слой под полем ввода, в просмотре — подсветка страницы.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findIndex, setFindIndex] = useState(0);
  const [focusToken, setFocusToken] = useState(0);
  const [domRanges, setDomRanges] = useState<Range[]>([]);
  const editing = mode === 'edit' && !readOnly;
  const matches = useMemo(() => (findOpen && editing ? findAll(text, findQuery) : []), [findOpen, editing, text, findQuery]);
  const count = editing ? matches.length : domRanges.length;
  const current = count ? Math.min(findIndex, count - 1) : 0;

  // Общая точка с сессией: последний текст, который редактор отдал ей (onContent) или принял от неё.
  // Материал перечитали с сервера (чужая правка, конфликт) — берём присланное.
  const syncedRef = useRef(content);
  useEffect(() => { setFull(content); syncedRef.current = content; }, [loadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Коллега печатает в той же заметке: сессия сливает его правку с нашими и присылает итог — он вливается на месте,
  // без перезагрузки редактора и без прыжка курсора. Набранное, пока шло слияние, доливается поверх; не слилось —
  // берём присланное, а решение за сессией (баннер).
  useEffect(() => {
    if (content === syncedRef.current) return;
    const base = syncedRef.current;
    const own = fullRef.current;
    syncedRef.current = content;
    if (own === content) return;
    const merged = own === base ? { text: content, conflict: false } : merge3(base, own, content);
    const next = merged.conflict ? content : merged.text;
    const field = area.current;
    if (field && document.activeElement === field) {
      const tab = tabRef.current;
      const caret = shiftCaret(parseTabs(own)[tab]?.content ?? '', parseTabs(next)[tab]?.content ?? '', field.selectionStart);
      requestAnimationFrame(() => { if (area.current) area.current.setSelectionRange(caret, caret); });
    }
    fullRef.current = next;
    setFull(next);
    if (next !== content) { syncedRef.current = next; onContent(next); }
  }, [content]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = useCallback((nextFull: string) => {
    fullRef.current = nextFull;
    syncedRef.current = nextFull;
    setFull(nextFull);
    onContent(nextFull);
  }, [onContent]);
  /** Правка открытой вкладки: остальные вкладки остаются как были. */
  const change = useCallback((next: string) => {
    const all = parseTabs(fullRef.current);
    all[tabRef.current] = { ...all[tabRef.current], content: next };
    commit(serializeTabs(all));
  }, [commit]);

  // ── Вкладки (снизу, как листы таблицы) ──
  const addTab = () => {
    const all = parseTabs(fullRef.current);
    all.push({ title: `Вкладка ${all.length + 1}`, content: '' });
    commit(serializeTabs(all));
    setActiveTab(all.length - 1);
    setMode('edit');
  };
  const renameTab = (index: number, title: string | null) => {
    setRenaming(null);
    const all = parseTabs(fullRef.current);
    if (!title || !all[index] || title === all[index].title) return;
    all[index] = { ...all[index], title: cleanTabTitle(title) };
    commit(serializeTabs(all));
  };
  const removeTab = async (index: number) => {
    const all = parseTabs(fullRef.current);
    if (all.length <= 1) return;
    if (all[index].content.trim() && !(await askConfirm({ title: `Удалить вкладку «${all[index].title}» вместе с её текстом?`, confirm: 'Удалить', tone: 'danger' }))) return;
    all.splice(index, 1);
    commit(serializeTabs(all));
    // Удалили открытую — встаём на соседнюю справа (или на последнюю); удалили левее — открытая сдвигается на одну.
    const open = tabRef.current;
    setActiveTab(open > index ? open - 1 : open === index ? Math.min(index, all.length - 1) : open);
  };

  // Своя позиция — коллегам. В просмотре курсора нет (там нет и поля ввода).
  const reportCursor = () => {
    const field = area.current;
    if (!field || !onCursor) return;
    onCursor({ s: field.selectionStart, e: field.selectionEnd, b: field.selectionDirection === 'backward' ? 1 : 0, t: tabRef.current });
  };
  useEffect(() => { if (!editing) onCursor?.(null); }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps
  // Цветной Markdown под прозрачным текстом поля (правка).
  const coloured = useMemo(() => (editing ? highlightMarkdown(text) : null), [editing, text]);
  useLayoutEffect(() => { if (syntax.current && area.current) syntax.current.scrollTop = area.current.scrollTop; }, [coloured]);
  // Курсоры коллег — только тех, кто в той же вкладке.
  const cursorLayer = useMemo(() => {
    const here = cursors.filter((c) => ((c.pos as NoteCursor).t ?? 0) === tabIndex);
    return editing && here.length ? cursorMirror(text, here) : null;
  }, [editing, cursors, text, tabIndex]);
  useEffect(() => { reportCursor(); }, [tabIndex]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { if (mirror.current && area.current) mirror.current.scrollTop = area.current.scrollTop; }, [cursorLayer]);

  // Ctrl/⌘+F — по физической клавише: работает и в русской раскладке (там на ней «а»).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.code !== 'KeyF') return;
      if (!root.current || root.current.offsetParent === null || document.querySelector('.nsp')) return;
      e.preventDefault();
      const field = area.current;
      const picked = field && document.activeElement === field ? field.value.slice(field.selectionStart, field.selectionEnd) : (window.getSelection()?.toString() ?? '');
      if (picked && picked.length < 120 && !picked.includes('\n')) { setFindQuery(picked); setFindIndex(0); }
      setFindOpen(true);
      setFocusToken((n) => n + 1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => { setFindIndex(0); }, [findQuery]);

  // Просмотр: подсветка всех совпадений на странице и переход к текущему.
  useEffect(() => {
    const highlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    const HighlightCtor = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    if (!findOpen || editing || !view.current || !findQuery) { setDomRanges([]); highlights?.delete('nws-find'); highlights?.delete('nws-find-current'); return undefined; }
    const ranges: Range[] = [];
    const walker = document.createTreeWalker(view.current, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const [from, to] of findAll(node.nodeValue || '', findQuery)) {
        const range = document.createRange();
        range.setStart(node, from);
        range.setEnd(node, to);
        ranges.push(range);
      }
    }
    setDomRanges(ranges);
    if (highlights && HighlightCtor) highlights.set('nws-find', new HighlightCtor(...ranges));
    return () => { highlights?.delete('nws-find'); highlights?.delete('nws-find-current'); };
  }, [findOpen, editing, findQuery, text, mode]);

  useEffect(() => {
    const highlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    const HighlightCtor = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    if (editing || !findOpen || !domRanges.length) return;
    const range = domRanges[current];
    if (highlights && HighlightCtor) highlights.set('nws-find-current', new HighlightCtor(range));
    range.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [current, domRanges, editing, findOpen]);

  // Правка: текущее совпадение выводим в поле — слой подсветки и текст прокручиваются вместе.
  useEffect(() => {
    if (!findOpen || !editing || !matches.length) return;
    const mark = back.current?.querySelector<HTMLElement>('mark[data-current]');
    const field = area.current;
    if (!mark || !field) return;
    field.scrollTop = Math.max(0, mark.offsetTop - field.clientHeight / 3);
    if (back.current) back.current.scrollTop = field.scrollTop;
  }, [current, matches, findOpen, editing]);

  function closeFind() {
    setFindOpen(false);
    const field = area.current;
    if (editing && field && matches[current]) {
      const [from, to] = matches[current];
      requestAnimationFrame(() => { field.focus(); field.setSelectionRange(from, to); });
    }
  }
  const step = (delta: number) => { if (count) setFindIndex((current + delta + count) % count); };

  /** Оборачивает выделение (или строку) разметкой и возвращает курсор на место. */
  function apply(wrap: Wrap) {
    const el = area.current;
    if (!el || readOnly) return;
    const { selectionStart: from, selectionEnd: to, value } = el;
    let next: string;
    let caret: [number, number];
    if (wrap.line) {
      const start = value.lastIndexOf('\n', from - 1) + 1;
      const selected = value.slice(start, to) || wrap.placeholder || '';
      next = `${value.slice(0, start)}${wrap.before}${selected}${value.slice(to)}`;
      caret = [start + wrap.before.length, start + wrap.before.length + selected.length];
    } else {
      const selected = value.slice(from, to) || wrap.placeholder || '';
      next = `${value.slice(0, from)}${wrap.before}${selected}${wrap.after ?? ''}${value.slice(to)}`;
      caret = [from + wrap.before.length, from + wrap.before.length + selected.length];
    }
    change(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(caret[0], caret[1]); });
  }

  async function insertImages(list: FileList | File[]) {
    const images = Array.from(list).filter((f) => f.type.startsWith('image/'));
    if (!images.length || readOnly) return;
    setBusy(true);
    setError('');
    try {
      let inserted = '';
      for (const file of images) {
        const result = await uploadFileWithProgress(file, () => undefined);
        inserted += `\n![${file.name.replace(/\.[^.]+$/, '')}](${result.url})\n`;
      }
      const el = area.current;
      const at = el ? el.selectionEnd : text.length;
      change(`${text.slice(0, at)}${inserted}${text.slice(at)}`);
    } catch {
      setError('Не удалось загрузить картинку');
    } finally {
      setBusy(false);
    }
  }

  /** Эмодзи в позицию курсора; курсор встаёт после него, так что можно выбирать несколько подряд. */
  function insertEmoji(emoji: string) {
    const el = area.current;
    if (!el || readOnly) return;
    const at = el.selectionEnd ?? text.length;
    const next = `${text.slice(0, at)}${emoji}${text.slice(at)}`;
    change(next);
    requestAnimationFrame(() => { if (area.current) area.current.setSelectionRange(at + emoji.length, at + emoji.length); });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!(e.ctrlKey || e.metaKey)) return;
    const key = e.key.toLowerCase();
    if (key === 'b') { e.preventDefault(); apply(TOOLS[0].wrap); }
    if (key === 'i') { e.preventDefault(); apply(TOOLS[1].wrap); }
  }

  // Галочки в предпросмотре работают: клик переписывает «- [ ]» ↔ «- [x]» в исходнике.
  function toggleTask(index: number) {
    if (readOnly || index < 0) return;
    let n = -1;
    change(text.replace(/^(\s*[-*+]\s+)\[([ xX])\]/gm, (match, lead: string, mark: string) => {
      n += 1;
      return n === index ? `${lead}[${mark === ' ' ? 'x' : ' '}]` : match;
    }));
  }

  // Слой подсветки под полем ввода: тот же текст теми же шрифтами, цветом — только фон у совпадений.
  const backdrop = useMemo(() => {
    if (!findOpen || !editing || !matches.length) return null;
    const parts: React.ReactNode[] = [];
    let at = 0;
    matches.forEach(([from, to], i) => {
      parts.push(text.slice(at, from));
      parts.push(<mark key={i} data-current={i === current ? 'true' : undefined}>{text.slice(from, to)}</mark>);
      at = to;
    });
    parts.push(text.slice(at));
    return parts;
  }, [findOpen, editing, matches, text, current]);

  return (
    <div className="nws-note" ref={root}>
      <div className="nws-note-bar" role="toolbar" aria-label="Форматирование">
        <div className="nx-segment" role="group" aria-label="Режим">
          <button type="button" aria-pressed={mode === 'edit'} onClick={() => setMode('edit')} disabled={readOnly}><Pencil size={13} aria-hidden="true" /> Правка</button>
          <button type="button" aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}><Eye size={13} aria-hidden="true" /> Просмотр</button>
        </div>
        {!readOnly && mode === 'edit' && (
          <div className="nws-tools">
            {TOOLS.map(({ id, label, icon: Icon, wrap }) => (
              <button key={id} type="button" className="nx-icon-btn" title={label} aria-label={label} onClick={() => apply(wrap)}><Icon size={16} /></button>
            ))}
            <button type="button" className="nx-icon-btn" title="Картинка" aria-label="Вставить картинку" disabled={busy} onClick={() => files.current?.click()}><ImagePlus size={16} /></button>
            <button type="button" className="nx-icon-btn" title="Эмодзи" aria-label="Вставить эмодзи" aria-haspopup="dialog" aria-expanded={Boolean(emojiAt)} onClick={(e) => setEmojiAt(emojiAt ? null : { element: e.currentTarget, align: 'start' })}><Smile size={16} /></button>
            <input ref={files} type="file" accept="image/*" multiple hidden onChange={(e) => { if (e.target.files) void insertImages(e.target.files); e.target.value = ''; }} />
          </div>
        )}
        {busy && <span className="nws-hint"><Spinner size={14} label="Загружаю картинку" /></span>}
        {error && <span className="nws-error" role="alert">{error}</span>}
      </div>

      {emojiAt && (
        <Menu anchor={emojiAt} label="Эмодзи" onClose={() => setEmojiAt(null)}>
          <SharEmojiPicker onPick={insertEmoji} />
        </Menu>
      )}

      {findOpen && (
        <FindBar query={findQuery} onQuery={setFindQuery} count={count} index={current} onNext={() => step(1)} onPrev={() => step(-1)} onClose={closeFind} focusToken={focusToken} />
      )}

      {mode === 'edit' && !readOnly ? (
        <div className="nws-note-edit" data-syntax="true">
          <div className="nws-note-back nws-note-syntax" ref={syntax} aria-hidden="true">{coloured}{'\n'}</div>
          {backdrop && <div className="nws-note-back" ref={back} aria-hidden="true">{backdrop}{'\n'}</div>}
        <textarea
          ref={area}
          className="nws-note-text"
          value={text}
          onScroll={(e) => {
            if (back.current) back.current.scrollTop = e.currentTarget.scrollTop;
            if (syntax.current) syntax.current.scrollTop = e.currentTarget.scrollTop;
            if (mirror.current) mirror.current.scrollTop = e.currentTarget.scrollTop;
          }}
          onSelect={reportCursor}
          placeholder="Пишите. Markdown: **жирный**, # заголовок, - список, - [ ] задача"
          spellCheck
          onChange={(e) => change(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData.files);
            if (pasted.some((f) => f.type.startsWith('image/'))) { e.preventDefault(); void insertImages(pasted); }
          }}
          onDrop={(e) => {
            if (e.dataTransfer.files.length) { e.preventDefault(); void insertImages(e.dataTransfer.files); }
          }}
          aria-label="Текст заметки"
        />
          {cursorLayer && <div className="nws-note-back nws-note-cursors" ref={mirror} aria-hidden="true">{cursorLayer}{'\n'}</div>}
        </div>
      ) : (
        <article ref={view} className="nws-note-view nx-scroll-y">
          {text.trim() ? (
            <Markdown
              remarkPlugins={[remarkGfm, remarkBreaks]}
              components={{
                p: ({ children }) => <p>{withEmoji(children, 'p')}</p>,
                li: ({ children, ...rest }) => <li {...rest}>{withEmoji(children, 'li')}</li>,
                h1: ({ children }) => <h1>{withEmoji(children, 'h1')}</h1>,
                h2: ({ children }) => <h2>{withEmoji(children, 'h2')}</h2>,
                h3: ({ children }) => <h3>{withEmoji(children, 'h3')}</h3>,
                table: ({ children }) => <ScrollTable className="nws-md-table"><table>{children}</table></ScrollTable>,
                td: ({ children }) => <td>{withEmoji(children, 'td')}</td>,
                th: ({ children }) => <th>{withEmoji(children, 'th')}</th>,
                strong: ({ children }) => <strong>{withEmoji(children, 's')}</strong>,
                em: ({ children }) => <em>{withEmoji(children, 'e')}</em>,
                a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
                input: (props) => {
                  if (props.type !== 'checkbox') return <input {...props} />;
                  // Номер галочки берём из самой страницы в момент клика: счётчик при рендере в dev-режиме
                  // (двойной вызов компонентов) убегал и правил не ту строку.
                  return (
                    <input
                      type="checkbox"
                      checked={Boolean(props.checked)}
                      disabled={readOnly}
                      onChange={(e) => toggleTask(Array.from(view.current?.querySelectorAll('input[type="checkbox"]') ?? []).indexOf(e.currentTarget))}
                    />
                  );
                },
              }}
            >
              {text}
            </Markdown>
          ) : (
            <p className="nws-hint">Пусто. Переключитесь на «Правка» и напишите что-нибудь.</p>
          )}
        </article>
      )}
      {(tabs.length > 1 || !readOnly) && (
        <div className="nws-note-tabs" role="tablist" aria-label="Вкладки заметки">
          {tabs.map((tab, index) => (
            <div key={index} className="nws-note-tab" data-active={index === tabIndex || undefined}>
              {renaming === index ? (
                <input
                  className="nws-note-tab-name"
                  defaultValue={tab.title}
                  autoFocus
                  maxLength={80}
                  aria-label="Название вкладки"
                  onFocus={(e) => e.currentTarget.select()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') { e.currentTarget.value = tab.title; e.currentTarget.blur(); }
                  }}
                  onBlur={(e) => renameTab(index, e.currentTarget.value.trim())}
                />
              ) : (
                <button
                  type="button"
                  role="tab"
                  aria-selected={index === tabIndex}
                  onClick={() => setActiveTab(index)}
                  onDoubleClick={() => { if (!readOnly) setRenaming(index); }}
                  onKeyDown={(e) => { if (e.key === 'F2' && !readOnly) { e.preventDefault(); setRenaming(index); } }}
                  title={readOnly ? tab.title : `${tab.title}. Двойной щелчок или F2 — переименовать`}
                >
                  {tab.title}
                </button>
              )}
              {!readOnly && tabs.length > 1 && renaming !== index && (
                <button type="button" className="nws-note-tab-close" onClick={() => void removeTab(index)} aria-label={`Удалить вкладку «${tab.title}»`} title="Удалить вкладку"><X size={11} /></button>
              )}
            </div>
          ))}
          {!readOnly && <button type="button" className="nws-note-tab-add" onClick={addTab} aria-label="Добавить вкладку" title="Добавить вкладку"><Plus size={14} /></button>}
        </div>
      )}
    </div>
  );
}
