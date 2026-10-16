import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { getAppleEmojiUrl } from '@/shared/emoji/appleEmoji';
import { EMOJI_RUN_REGEX } from '@/shared/emoji/emojiText';

/**
 * Поле ввода сообщения с эмодзи Apple.
 *
 * В обычном <textarea> эмодзи рисуются шрифтом системы (Segoe UI Emoji, Noto…) —
 * вставленный из панели смайлик выглядел не так, как выбранный: панель, ленты и
 * превью показывают картинки Apple. Здесь поле — contenteditable, а каждый эмодзи
 * в нём — нередактируемый span: настоящий символ (он и уходит в сообщение), но
 * прозрачный, с PNG Apple поверх. То же происходит с эмодзи, введёнными с
 * клавиатуры ОС или вставленными из буфера.
 *
 * Значение — обычная строка (с \n); наружу отдаём её, а не HTML.
 */

export interface RichInputHandle {
  focus(): void;
  blur(): void;
  insertEmoji(emoji: string): void;
  insertText(text: string): void;
  caretToEnd(): void;
}

interface Props {
  id?: string;
  value: string;
  placeholder?: string;
  className?: string;
  enterKeyHint?: 'send' | 'done';
  onChange: (value: string) => void;
  onFocus?: () => void;
  onPasteFiles?: (files: File[]) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
}

const EMOJI_CLASS = 'nxr-emoji';
const ZERO_WIDTH = String.fromCharCode(0x200b);

function emojiSpan(emoji: string, url: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = EMOJI_CLASS;
  span.contentEditable = 'false';
  span.textContent = emoji;
  span.style.backgroundImage = `url('${url}')`;
  return span;
}

/** Текст поля: \n из <br>/<div>, эмодзи-span — его символ. */
function serialize(root: Node): string {
  let out = '';
  const walk = (node: Node, first: boolean) => {
    node.childNodes.forEach((child, i) => {
      if (child.nodeType === Node.TEXT_NODE) { out += child.textContent || ''; return; }
      if (!(child instanceof HTMLElement)) return;
      if (child.tagName === 'BR') { out += '\n'; return; }
      if (child.classList.contains(EMOJI_CLASS)) { out += child.textContent || ''; return; }
      // Браузеры оборачивают строки в <div>: перенос — перед ним, кроме самой первой.
      const block = child.tagName === 'DIV' || child.tagName === 'P';
      if (block && !(first && i === 0) && out && !out.endsWith('\n')) out += '\n';
      walk(child, false);
    });
  };
  walk(root, true);
  return out.split(ZERO_WIDTH).join('');
}

/** Заполнить поле строкой: текст и эмодзи-картинки. */
function render(root: HTMLElement, value: string) {
  root.textContent = '';
  EMOJI_RUN_REGEX.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = EMOJI_RUN_REGEX.exec(value)) !== null) {
    const url = getAppleEmojiUrl(m[0]);
    if (!url) continue;
    if (m.index > last) root.appendChild(document.createTextNode(value.slice(last, m.index)));
    root.appendChild(emojiSpan(m[0], url));
    last = m.index + m[0].length;
  }
  if (last < value.length) root.appendChild(document.createTextNode(value.slice(last)));
}

/** Позиция курсора в «строковых» единицах serialize(). */
function caretOffset(root: HTMLElement): number | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !root.contains(sel.anchorNode)) return null;
  const range = sel.getRangeAt(0).cloneRange();
  const pre = document.createRange();
  pre.selectNodeContents(root);
  pre.setEnd(range.endContainer, range.endOffset);
  const frag = pre.cloneContents();
  const holder = document.createElement('div');
  holder.appendChild(frag);
  return serialize(holder).length;
}

function placeCaret(root: HTMLElement, offset: number) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  let remaining = offset;
  let done = false;
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (done) return;
      if (child.nodeType === Node.TEXT_NODE) {
        const len = (child.textContent || '').length;
        if (remaining <= len) { range.setStart(child, remaining); done = true; return; }
        remaining -= len;
      } else if (child instanceof HTMLElement && child.classList.contains(EMOJI_CLASS)) {
        const len = (child.textContent || '').length;
        if (remaining <= len) { range.setStartAfter(child); done = true; return; }
        remaining -= len;
      } else if (child instanceof HTMLElement && child.tagName === 'BR') {
        if (remaining <= 1) { range.setStartAfter(child); done = true; return; }
        remaining -= 1;
      } else {
        walk(child);
      }
    }
  };
  walk(root);
  if (!done) { range.selectNodeContents(root); range.collapse(false); }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

const hasEmojiText = (root: HTMLElement): boolean => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if ((n.parentElement && n.parentElement.classList.contains(EMOJI_CLASS))) continue;
    EMOJI_RUN_REGEX.lastIndex = 0;
    const text = n.textContent || '';
    let m: RegExpExecArray | null;
    while ((m = EMOJI_RUN_REGEX.exec(text)) !== null) if (getAppleEmojiUrl(m[0])) return true;
  }
  return false;
};

/** Текст из HTML буфера обмена — когда text/plain нет. */
function htmlText(html: string): string {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  doc.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, tr').forEach((el) => el.append('\n'));
  return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

const RichInput = forwardRef<RichInputHandle, Props>(function RichInput(
  { id, value, placeholder, className, enterKeyHint, onChange, onFocus, onPasteFiles, onKeyDown }, handle,
) {
  const ref = useRef<HTMLDivElement>(null);
  const emitted = useRef<string | null>(null);

  const setEmpty = (el: HTMLElement, text: string) => el.setAttribute('data-empty', text.length ? 'false' : 'true');

  const emit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const text = serialize(el);
    setEmpty(el, text);
    emitted.current = text;
    onChange(text);
  }, [onChange]);

  // Внешнее значение (черновик, правка, очистка после отправки) — перерисовать поле.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || value === emitted.current) return;
    render(el, value);
    setEmpty(el, value);
    emitted.current = value;
  }, [value]);

  /** Эмодзи, набранные «живьём», заменяем картинками, сохранив курсор. */
  const decorate = useCallback(() => {
    const el = ref.current;
    if (!el || !hasEmojiText(el)) return;
    const offset = caretOffset(el);
    render(el, serialize(el));
    if (offset !== null) placeCaret(el, offset);
  }, []);

  const insertNode = useCallback((node: Node) => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    if (sel && sel.rangeCount && el.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      el.appendChild(node);
      placeCaret(el, serialize(el).length);
    }
    emit();
  }, [emit]);

  useImperativeHandle(handle, () => ({
    focus: () => ref.current?.focus(),
    blur: () => ref.current?.blur(),
    caretToEnd: () => { const el = ref.current; if (el) { el.focus(); placeCaret(el, serialize(el).length); } },
    insertText: (text: string) => insertNode(document.createTextNode(text)),
    insertEmoji: (emoji: string) => {
      const url = getAppleEmojiUrl(emoji);
      insertNode(url ? emojiSpan(emoji, url) : document.createTextNode(emoji));
    },
  }), [insertNode]);

  // Пустое поле браузеры любят «чинить» остатками <br> — подчищаем, чтобы placeholder вернулся.
  useEffect(() => {
    const el = ref.current;
    if (el) setEmpty(el, value);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      id={id}
      ref={ref}
      className={className}
      role="textbox"
      aria-multiline="true"
      aria-label={placeholder}
      contentEditable="true"
      suppressContentEditableWarning
      spellCheck
      data-placeholder={placeholder}
      data-empty="true"
      enterKeyHint={enterKeyHint}
      onFocus={onFocus}
      onInput={() => {
        const el = ref.current;
        if (el && serialize(el) === '' && el.innerHTML !== '') el.innerHTML = '';
        decorate();
        emit();
      }}
      onPaste={(e) => {
        e.preventDefault();
        const data = e.clipboardData;
        // Только текст: HTML из буфера (шрифты, цвета, ссылки) в сообщение не нужен. Без text/plain
        // (бывает при копировании со страниц) — текст из HTML.
        const text = data.getData('text/plain') || htmlText(data.getData('text/html'));
        const files = Array.from(data.files || []);
        // iOS кладёт большой скопированный текст в буфер ещё и файлом — тогда он уходил во вложения
        // (или терялся), и вставить длинный текст в поле было нельзя. Текстовые «файлы» при тексте не берём.
        const real = text ? files.filter((f) => !/^text\//.test(f.type) && f.type !== '') : files;
        if (real.length) { onPasteFiles?.(real); return; }
        if (!text) return;
        // execCommand на длинном тексте в contenteditable тормозит до зависания (особенно на iPhone) —
        // большой текст вставляем узлом напрямую; короткий — как раньше, с отменой по Ctrl+Z.
        if (text.length < 2000 && document.execCommand('insertText', false, text)) return;
        insertNode(document.createTextNode(text.replace(/\r\n?/g, '\n')));
      }}
      onDrop={(e) => { if (e.dataTransfer.files.length) e.preventDefault(); }}
      onKeyDown={onKeyDown}
    />
  );
});

export default RichInput;
