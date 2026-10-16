import { useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';

/** Строка поиска внутри материала (Ctrl+F). Сама ничего не ищет: показывает запрос, счётчик и кнопки. */
export function FindBar({ query, onQuery, count, index, onNext, onPrev, onClose, focusToken }: {
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
}) {
  const input = useRef<HTMLInputElement>(null);
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
      <button type="button" className="nx-icon-btn" onClick={onClose} aria-label="Закрыть поиск" title="Закрыть (Esc)"><X size={15} /></button>
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
