import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { getAppleEmojiUrl } from './appleEmoji';
import { EMOJI_CATEGORIES, QUICK_REACTIONS, searchEmoji, type EmojiItem } from './emojiData';
import './emojiPicker.css';

/**
 * Выбор эмодзи Шара — те же картинки и те же наборы, что в чате (shared/emoji). Нужен везде, где эмодзи выбирают
 * вне самого чата: в «Офисе» (заметки, документы). Недавние общие с чатом: выбрал в одном месте — виден в другом.
 */

const RECENTS_KEY = 'nx:recent-emojis';

const readRecents = (): string[] => {
  try { return JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]'); } catch { return []; }
};

const Cell = memo(function Cell({ item, onPick }: { item: EmojiItem; onPick: (value: string) => void }) {
  const url = getAppleEmojiUrl(item.v);
  return (
    <button type="button" className="nem-cell" title={item.k} aria-label={item.k || item.v} onClick={() => onPick(item.v)}>
      {url ? <img src={url} alt="" loading="lazy" decoding="async" draggable={false} /> : <span>{item.v}</span>}
    </button>
  );
});

export function SharEmojiPicker({ onPick, autoFocus = true }: { onPick: (emoji: string) => void; autoFocus?: boolean }) {
  const [recents, setRecents] = useState<string[]>(readRecents);
  const [query, setQuery] = useState('');
  const scroll = useRef<HTMLDivElement>(null);

  const pick = useCallback((emoji: string) => {
    setRecents((prev) => {
      const next = [emoji, ...prev.filter((e) => e !== emoji)].slice(0, 32);
      try { localStorage.setItem(RECENTS_KEY, JSON.stringify(next)); } catch { /* без памяти */ }
      return next;
    });
    onPick(emoji);
  }, [onPick]);

  const sections = useMemo(() => {
    const recent = (recents.length ? recents : QUICK_REACTIONS).map((v) => ({ v, k: '' }));
    return [{ id: 'recent', label: recents.length ? 'Недавние' : 'Быстрые', items: recent }, ...EMOJI_CATEGORIES];
  }, [recents]);
  const found = useMemo(() => (query.trim() ? searchEmoji(query).slice(0, 240) : null), [query]);

  const jump = (id: string) => scroll.current?.querySelector<HTMLElement>(`[data-section="${id}"]`)?.scrollIntoView({ block: 'start' });

  return (
    <div className="nem" role="dialog" aria-label="Эмодзи" onMouseDown={(e) => { if ((e.target as HTMLElement).tagName !== 'INPUT') e.preventDefault(); }}>
      <label className="nem-search">
        <Search size={14} aria-hidden="true" />
        <span className="nx-sr">Поиск эмодзи</span>
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти эмодзи" autoFocus={autoFocus} />
      </label>
      {!found && (
        <div className="nem-tabs" role="tablist" aria-label="Категории">
          {sections.map((s) => (
            <button key={s.id} type="button" role="tab" title={s.label} onClick={() => jump(s.id)}>
              <img src={getAppleEmojiUrl(s.items[0]?.v ?? '')} alt="" draggable={false} />
            </button>
          ))}
        </div>
      )}
      <div className="nem-scroll nx-scroll-y" ref={scroll}>
        {found ? (
          found.length ? <div className="nem-grid">{found.map((item) => <Cell key={item.v} item={item} onPick={pick} />)}</div> : <p className="nem-empty">Ничего не нашлось.</p>
        ) : sections.map((section) => (
          <section key={section.id} data-section={section.id}>
            <h3>{section.label}</h3>
            <div className="nem-grid">{section.items.map((item) => <Cell key={item.v} item={item} onPick={pick} />)}</div>
          </section>
        ))}
      </div>
    </div>
  );
}
