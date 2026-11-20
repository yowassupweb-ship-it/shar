import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Replace, X } from 'lucide-react';

/** Строка поиска внутри материала (Ctrl+F). Сама ничего не ищет: показывает запрос, счётчик и кнопки. */
export function FindBar({ query, onQuery, count, index, onNext, onPrev, onClose, focusToken, replace, replaceOpen }: {
  query: string;
  onQuery: (next: string) => void;
  count: number;
  /** Номер текущего совпадения, с нуля. */
  index: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  /** Меняется при каждом новом Ctrl+F: поле снова получает фокус и выделяется. */
  focusToken: number;
  /** Замена (документ): текущее совпадение или все. Нет — строка только ищет. */
  replace?: { one: (text: string) => void; all: (text: string) => void };
  /** Открыть сразу с полем замены (Ctrl+H, «Найти и заменить»). */
  replaceOpen?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [withReplace, setWithReplace] = useState(Boolean(replaceOpen));
  const [to, setTo] = useState('');
  useEffect(() => { if (replaceOpen) setWithReplace(true); }, [replaceOpen, focusToken]);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, [focusToken]);

  return (
    <div className="nws-find" role="search" aria-label="Поиск в тексте">
      <input
        ref={input}
        value={query}
        placeholder="Найти в тексте"
        aria-label="Найти в тексте"
        spellCheck={false}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) onPrev(); else onNext(); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
          // F3 / Ctrl+G — следующее совпадение, как в привычных редакторах; по клавише, а не по символу — работает в любой раскладке.
          else if (e.code === 'F3' || ((e.ctrlKey || e.metaKey) && e.code === 'KeyG')) { e.preventDefault(); if (e.shiftKey) onPrev(); else onNext(); }
        }}
      />
      <span className="nws-find-count" role="status" aria-live="polite">
        {query ? (count ? `${index + 1} из ${count}` : 'Нет совпадений') : ''}
      </span>
      <button type="button" className="nx-icon-btn" onClick={onPrev} disabled={!count} aria-label="Предыдущее совпадение" title="Предыдущее (Shift+Enter)"><ChevronUp size={15} /></button>
      <button type="button" className="nx-icon-btn" onClick={onNext} disabled={!count} aria-label="Следующее совпадение" title="Следующее (Enter)"><ChevronDown size={15} /></button>
      {replace && (
        <button type="button" className="nx-icon-btn" aria-pressed={withReplace} onClick={() => setWithReplace((v) => !v)} aria-label="Заменить" title="Найти и заменить (Ctrl+H)"><Replace size={15} /></button>
      )}
      <button type="button" className="nx-icon-btn" onClick={onClose} aria-label="Закрыть поиск" title="Закрыть (Esc)"><X size={15} /></button>
      {replace && withReplace && (
        <div className="nws-find-replace">
          <input value={to} placeholder="Заменить на" aria-label="Заменить на" spellCheck={false} onChange={(e) => setTo(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter') { e.preventDefault(); if (count) replace.one(to); }
              else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
            }} />
          <button type="button" className="nx-ghost nws-find-btn" disabled={!count} onClick={() => replace.one(to)}>Заменить</button>
          <button type="button" className="nx-ghost nws-find-btn" disabled={!count} onClick={() => replace.all(to)}>Заменить все</button>
        </div>
      )}
    </div>
  );
}

/** Границы всех совпадений без учёта регистра и «ё/е». */
export function findAll(text: string, query: string): Array<[number, number]> {
  const q = query.toLowerCase().replace(/ё/g, 'е');
  if (!q) return [];
  const hay = text.toLowerCase().replace(/ё/g, 'е');
  const out: Array<[number, number]> = [];
  for (let at = hay.indexOf(q); at >= 0 && out.length < 5000; at = hay.indexOf(q, at + q.length)) out.push([at, at + q.length]);
  return out;
}
