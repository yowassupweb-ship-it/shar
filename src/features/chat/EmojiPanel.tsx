import { memo, useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import {
  Car, Cat, Clock, Dumbbell, Flag, GlassWater, Hand, Hash, Heart, Lightbulb, Plane, Plus, Search, Smile, Trash2,
  Users, UtensilsCrossed, X,
} from 'lucide-react';
import AnimatedSticker from '@/features/chat/bubbles/AnimatedSticker';
import { getAppleEmojiUrl } from '@/shared/emoji/appleEmoji';
import { EMOJI_CATEGORIES, QUICK_REACTIONS, searchEmoji, type EmojiItem } from '@/shared/emoji/emojiData';
import { askConfirm } from '@/shared/ui/overlay';
import { sendSticker, setPanel, useChatStore } from './store';
import { Spinner } from '@/shared/ui/Spinner';

/**
 * Эмодзи и стикеры — в боковой панели переписки (там же, где профиль).
 * На телефоне панель встаёт под полем ввода вместо клавиатуры.
 *
 * Эмодзи вставляется в поле ввода в позицию курсора (событие nx:insert-emoji
 * слушает композер), стикер уходит сразу. Наборы стикеров — те же, что в
 * старом чате (/api/stickers/sets).
 */

const RECENTS_KEY = 'nx:recent-emojis';

const ICONS: Record<string, ComponentType<{ size?: number }>> = {
  recent: Clock, smileys: Smile, hearts: Heart, gestures: Hand, people: Users, animals: Cat, food: UtensilsCrossed,
  drinks: GlassWater, sports: Dumbbell, travel: Plane, vehicles: Car, objects: Lightbulb, symbols: Hash, flags: Flag,
};

function readRecents(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]'); } catch { return []; }
}

const EmojiCell = memo(function EmojiCell({ item, onPick }: { item: EmojiItem; onPick: (v: string) => void }) {
  return (
    <button type="button" className="cxe-cell" title={item.k} aria-label={item.k || item.v} onClick={() => onPick(item.v)}>
      <img src={getAppleEmojiUrl(item.v)} alt="" loading="lazy" decoding="async" draggable={false} />
    </button>
  );
});

export function EmojiTab() {
  const [recents, setRecents] = useState<string[]>(readRecents);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState('recent');
  const scrollRef = useRef<HTMLDivElement>(null);

  const pick = useCallback((emoji: string) => {
    setRecents((prev) => {
      const next = [emoji, ...prev.filter((e) => e !== emoji)].slice(0, 32);
      try { localStorage.setItem(RECENTS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
    window.dispatchEvent(new CustomEvent('nx:insert-emoji', { detail: emoji }));
  }, []);

  const sections = useMemo(() => {
    const recent = (recents.length ? recents : QUICK_REACTIONS).map((v) => ({ v, k: '' }));
    return [{ id: 'recent', label: recents.length ? 'Недавние' : 'Быстрые', items: recent }, ...EMOJI_CATEGORIES];
  }, [recents]);
  const found = useMemo(() => (query.trim() ? searchEmoji(query).slice(0, 240) : null), [query]);

  // Подсветка текущего раздела на ленте категорий по мере прокрутки.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || found) return;
    const heads = el.querySelectorAll<HTMLElement>('[data-cat]');
    let current = 'recent';
    for (const h of Array.from(heads)) if (h.offsetTop - el.offsetTop <= el.scrollTop + 8) current = h.dataset.cat || current;
    setActive((a) => (a === current ? a : current));
  };

  const jump = (id: string) => {
    setQuery('');
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      const head = el?.querySelector<HTMLElement>(`[data-cat="${id}"]`);
      if (el && head) el.scrollTo({ top: head.offsetTop - el.offsetTop, behavior: 'smooth' });
    });
  };

  return (
    <>
      <div className="cxe-search">
        <label className="nx-field" data-variant="filter">
          <Search size={14} aria-hidden="true" />
          <span className="nx-sr">Поиск эмодзи</span>
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск эмодзи" />
          {query && (
            <button type="button" className="nx-icon-btn cxe-clear" onClick={() => setQuery('')} aria-label="Очистить поиск"><X size={14} /></button>
          )}
        </label>
      </div>
      <div ref={scrollRef} className="cxe-scroll nx-scroll-y" onScroll={onScroll}>
        {found ? (
          found.length ? (
            <div className="cxe-grid">{found.map((it, i) => <EmojiCell key={it.v + i} item={it} onPick={pick} />)}</div>
          ) : <p className="nx-hint cxe-empty">Ничего не нашлось</p>
        ) : sections.map((sec) => (
          <section key={sec.id} aria-label={sec.label}>
            <h3 className="cxe-head" data-cat={sec.id}>{sec.label}</h3>
            <div className="cxe-grid">{sec.items.map((it, i) => <EmojiCell key={it.v + i} item={it} onPick={pick} />)}</div>
          </section>
        ))}
      </div>
      {!found && (
        <nav className="cxe-cats" aria-label="Разделы эмодзи">
          {sections.map((sec) => {
            const Icon = ICONS[sec.id] || Smile;
            return (
              <button key={sec.id} type="button" className="cxe-cat" aria-pressed={active === sec.id} onClick={() => jump(sec.id)} title={sec.label} aria-label={sec.label}>
                <Icon size={16} />
              </button>
            );
          })}
        </nav>
      )}
    </>
  );
}

interface Sticker { file_id: string; emoji: string; url: string; is_animated?: boolean }
interface StickerSet { setName: string; title: string; thumbUrl: string | null; stickers?: Sticker[] }

function StickerTab({ chatId }: { chatId: string }) {
  const me = useChatStore((s) => s.me);
  const uid = me ? String(me.id) : '';
  const [sets, setSets] = useState<StickerSet[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [stickers, setStickers] = useState<Sticker[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const qs = uid ? `?userId=${encodeURIComponent(uid)}` : '';

  const loadSets = useCallback(async () => {
    try {
      const r = await fetch(`/api/stickers/sets${qs}`);
      const d = await r.json();
      const arr: StickerSet[] = Array.isArray(d) ? d : [];
      setSets(arr);
      return arr;
    } catch { setSets([]); return []; }
  }, [qs]);

  const open = useCallback(async (setName: string) => {
    setActive(setName);
    setStickers(null);
    try {
      const r = await fetch(`/api/stickers/sets/${encodeURIComponent(setName)}`);
      const d: StickerSet = await r.json();
      setStickers(d.stickers || []);
    } catch { setStickers([]); }
  }, []);

  useEffect(() => {
    void loadSets().then((arr) => { if (arr[0]) void open(arr[0].setName); });
  }, [loadSets, open]);

  const importSet = async () => {
    const slug = name.trim().replace(/^https?:\/\/t\.me\/addstickers\//, '');
    if (!slug) return;
    setImporting(true);
    setError('');
    try {
      const r = await fetch('/api/stickers/sets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setName: slug, ...(uid ? { userId: uid } : {}) }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.detail || 'Набор не найден. Проверьте название.'); return; }
      await loadSets();
      setName('');
      setAdding(false);
      void open(slug);
    } catch { setError('Не удалось добавить — нет связи с сервером.'); } finally { setImporting(false); }
  };

  const removeSet = async (setName: string, title: string) => {
    const ok = await askConfirm({ title: `Убрать набор «${title}»?`, confirm: 'Убрать', tone: 'danger' });
    if (!ok) return;
    await fetch(`/api/stickers/sets/${encodeURIComponent(setName)}${qs}`, { method: 'DELETE' }).catch(() => {});
    const arr = await loadSets();
    if (active === setName) { if (arr[0]) void open(arr[0].setName); else { setActive(null); setStickers([]); } }
  };

  const activeSet = sets?.find((s) => s.setName === active);

  return (
    <>
      <div className="cxe-sets" role="tablist" aria-label="Наборы стикеров">
        {(sets || []).map((s) => (
          <button key={s.setName} type="button" role="tab" aria-selected={active === s.setName} className="cxe-set" title={s.title} onClick={() => void open(s.setName)}>
            {s.thumbUrl
              ? (/\.tgs(\?|$)/.test(s.thumbUrl) ? <AnimatedSticker url={s.thumbUrl} size={26} loop playOnHover /> : <img src={s.thumbUrl} alt="" />)
              : <Smile size={18} />}
          </button>
        ))}
        <button type="button" className="cxe-set" aria-pressed={adding} onClick={() => setAdding((v) => !v)} title="Добавить набор" aria-label="Добавить набор">
          <Plus size={18} />
        </button>
      </div>
      {adding && (
        <form className="cxe-import" onSubmit={(e) => { e.preventDefault(); void importSet(); }}>
          <label className="nx-field" data-variant="filter">
            <span className="nx-sr">Название набора из Telegram</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Название или ссылка t.me/addstickers/…" autoFocus />
          </label>
          <button type="submit" className="nx-primary" disabled={importing || !name.trim()}>{importing ? 'Добавляю' : 'Добавить'}</button>
          {error && <p className="nx-error" role="alert">{error}</p>}
        </form>
      )}
      <div className="cxe-scroll nx-scroll-y">
        {sets === null || (active && stickers === null) ? (
          <div className="nx-state" aria-busy="true"><Spinner size={20} /></div>
        ) : !sets.length ? (
          <div className="nx-state"><h2>Наборов пока нет</h2><p>Добавьте набор из Telegram по названию.</p>
            <button type="button" className="nx-ghost" onClick={() => setAdding(true)}><Plus size={14} /> Добавить набор</button></div>
        ) : (
          <>
            {activeSet && (
              <div className="cxe-set-head">
                <h3 className="cxe-head">{activeSet.title}</h3>
                <button type="button" className="nx-icon-btn" onClick={() => void removeSet(activeSet.setName, activeSet.title)} aria-label={`Убрать набор ${activeSet.title}`}>
                  <Trash2 size={14} />
                </button>
              </div>
            )}
            <div className="cxe-stickers">
              {(stickers || []).map((s) => (
                <button key={s.file_id || s.url} type="button" className="cxe-sticker" title={s.emoji} onClick={() => sendSticker(chatId, s.url, s.emoji, active || '')}>
                  {s.is_animated ? <AnimatedSticker url={s.url} size={64} loop playOnHover /> : <img src={s.url} alt={s.emoji} loading="lazy" />}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}

export default function EmojiPanel({ chatId }: { chatId: string }) {
  const [tab, setTab] = useState<'emoji' | 'stickers'>('emoji');
  return (
    <aside className="cxp" aria-label="Эмодзи и стикеры">
      <header className="cxp-head">
        <div className="nx-segment" role="group" aria-label="Вид">
          <button type="button" aria-pressed={tab === 'emoji'} onClick={() => setTab('emoji')}>Эмодзи</button>
          <button type="button" aria-pressed={tab === 'stickers'} onClick={() => setTab('stickers')}>Стикеры</button>
        </div>
        <span className="cxp-spacer" />
        <button type="button" className="nx-icon-btn" onClick={() => setPanel(null)} aria-label="Закрыть панель">
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <div className="cxp-body cxe">
        {tab === 'emoji' ? <EmojiTab /> : <StickerTab chatId={chatId} />}
      </div>
    </aside>
  );
}
