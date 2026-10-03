import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { createPortal } from 'react-dom';
import { Bell, CalendarDays, Check, Globe2, Lock, MapPin, Repeat, Trash2, Users, X } from 'lucide-react';
import { showToast } from '@/shared/ui/Toast';
import type { User } from '@/shared/types/chat';
import { displayName, useChatStore } from '@/features/chat';
import { DatePicker } from '@/shared/ui/DatePicker';
import { Avatar } from '@/shared/ui/Avatar';
import { Menu, MenuItem, Sheet, type MenuAnchor } from '@/shared/ui/overlay';
import { SearchField } from '@/shared/ui/SearchField';
import { createEvent, deleteEvent, isMine, leaveEvent, myId, updateEvent, type Draft, type Scope } from './api';
import {
  addDays, addMinutes, COLORS, colorVar, dayIso, dayLabel, hhmm, isRecurring, parseLocal, reminderLabel, REMINDERS, repeatOf,
  REPEATS, timeRange, type CalEvent,
} from './model';

/**
 * Редактор события — лист, как остальные формы нового Шара. Своё событие
 * правится, чужое (им поделились) — только просмотр и «убрать из календаря».
 */

// ── «Только это / все» для серий ────────────────────────────────────────────

interface ScopeRequest { kind: 'edit' | 'delete'; resolve: (s: Scope | null) => void }
const useScope = create<{ req: ScopeRequest | null }>(() => ({ req: null }));

/** Для повторяющегося события: к чему применить правку или удаление. */
export function askScope(kind: 'edit' | 'delete'): Promise<Scope | null> {
  return new Promise((resolve) => {
    useScope.getState().req?.resolve(null);
    useScope.setState({ req: { kind, resolve } });
  });
}

function closeScope(s: Scope | null) {
  const req = useScope.getState().req;
  useScope.setState({ req: null });
  req?.resolve(s);
}

export function ScopeHost() {
  const req = useScope((s) => s.req);
  useEffect(() => {
    if (!req) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeScope(null); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [req]);
  if (!req) return null;
  const root = document.querySelector<HTMLElement>('.nx') || document.body;
  const close = closeScope;
  const del = req.kind === 'delete';
  return createPortal(
    <div className="nx-scrim" onClick={(e) => { if (e.target === e.currentTarget) close(null); }}>
      <div className="nx-dialog" role="alertdialog" aria-modal="true" aria-labelledby="ncal-scope-title">
        <h2 id="ncal-scope-title">{del ? 'Удалить повторяющееся событие?' : 'Изменить повторяющееся событие?'}</h2>
        <p>{del ? 'Только это повторение или всю серию.' : 'Только это повторение, это и следующие или всю серию.'}</p>
        <div className="ncal-scope-actions">
          <button type="button" className="nx-primary" data-tone={del ? 'danger' : undefined} onClick={() => close('this')} autoFocus>Только это</button>
          {!del && <button type="button" className="nx-ghost" onClick={() => close('following')}>Это и следующие</button>}
          <button type="button" className="nx-ghost" data-tone={del ? 'danger' : undefined} onClick={() => close('all')}>Всю серию</button>
          <button type="button" className="nx-ghost" onClick={() => close(null)}>Отмена</button>
        </div>
      </div>
    </div>,
    root,
  );
}

// ── Редактор ────────────────────────────────────────────────────────────────

export type EditorState = { mode: 'new'; draft: Draft } | { mode: 'edit'; event: CalEvent };

export function newDraft(start: Date, end?: Date, allDay = false): Draft {
  return {
    title: '',
    start: `${dayIso(start)}T${hhmm(start)}:00`,
    end: `${dayIso(end || addMinutes(start, 60))}T${hhmm(end || addMinutes(start, 60))}:00`,
    allDay,
    color: 'blue',
    reminderMinutesBefore: allDay ? null : 15,
    recurrenceRule: null,
    participants: [],
    sharedWithAll: false,
  };
}

const draftOf = (e: CalEvent): Draft => ({
  title: e.title, description: e.description, start: e.start, end: e.end, allDay: e.allDay, location: e.location,
  color: e.color, reminderMinutesBefore: e.reminderMinutesBefore ?? null, recurrenceRule: e.recurrenceRule ?? null,
  participants: e.participants, sharedWithAll: e.sharedWithAll,
});

type ShareMode = 'me' | 'people' | 'all';
const shareModeOf = (d: Draft): ShareMode => (d.sharedWithAll ? 'all' : d.participants.some((p) => p !== myId()) ? 'people' : 'me');

const positionOf = (u: User) => String((u as User & { position?: string }).position || '');

function withDate(iso: string, day: string) { return `${day}${iso.slice(10)}`; }
function withTime(iso: string, time: string) { return `${iso.slice(0, 10)}T${time}:00`; }

export default function EventEditor({ state, onClose }: { state: EditorState; onClose: () => void }) {
  const original = state.mode === 'edit' ? state.event : null;
  const readOnly = Boolean(original && !isMine(original));
  const [d, setD] = useState<Draft>(() => (state.mode === 'new' ? state.draft : draftOf(state.event)));
  // Главное — текст: первая строка — название, дальше — заметка. Человек ставит
  // себе напоминание с заметкой; настройки — мелкие чипы под ним.
  const [text, setText] = useState(() => {
    const src = state.mode === 'new' ? state.draft : draftOf(state.event);
    return [src.title, src.description].filter((x) => x && x.trim()).join('\n');
  });
  const [share, setShare] = useState<ShareMode>(() => shareModeOf(state.mode === 'new' ? state.draft : draftOf(state.event)));
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<{ kind: 'repeat' | 'remind' | 'startDate' | 'endDate' | 'color' | 'share'; anchor: MenuAnchor } | null>(null);
  const [showPlace, setShowPlace] = useState(() => Boolean(state.mode === 'edit' && state.event.location));
  const [peopleQuery, setPeopleQuery] = useState('');
  const users = useChatStore((s) => s.users);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const me = myId();

  useEffect(() => {
    const el = textRef.current;
    if (readOnly || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [readOnly]);

  const set = (patch: Partial<Draft>) => setD((cur) => ({ ...cur, ...patch }));

  // Начало сдвигает конец на ту же длительность — как в «Календаре» macOS.
  const setStart = (start: string) => setD((cur) => {
    const dur = parseLocal(cur.end).getTime() - parseLocal(cur.start).getTime();
    const end = new Date(parseLocal(start).getTime() + Math.max(0, dur));
    return { ...cur, start, end: `${dayIso(end)}T${hhmm(end)}:00` };
  });

  const start = parseLocal(d.start);
  const end = parseLocal(d.end);
  const endBeforeStart = end < start;

  const people = useMemo(() => {
    const q = peopleQuery.trim().toLowerCase();
    return Object.values(users)
      .filter((u) => String(u.id) !== me)
      .filter((u) => !q || displayName(u).toLowerCase().includes(q) || String(positionOf(u)).toLowerCase().includes(q))
      .sort((a, b) => Number(d.participants.includes(String(b.id))) - Number(d.participants.includes(String(a.id)))
        || displayName(a).localeCompare(displayName(b), 'ru'));
  }, [users, peopleQuery, me, d.participants]);

  const togglePerson = (id: string) => set({
    participants: d.participants.includes(id) ? d.participants.filter((p) => p !== id) : [...d.participants, id],
  });

  const setShareMode = (m: ShareMode) => {
    setShare(m);
    set({ sharedWithAll: m === 'all', ...(m === 'me' ? { participants: [] } : {}) });
  };

  const save = async () => {
    if (busy || readOnly || endBeforeStart) return;
    const [first, ...rest] = text.trim().split('\n');
    const draft: Draft = {
      ...d,
      title: (first || '').trim() || 'Напоминание',
      description: rest.join('\n').trim() || undefined,
      // Весь день: храним с полуночи до полуночи дня окончания.
      ...(d.allDay ? { start: `${d.start.slice(0, 10)}T00:00:00`, end: `${d.end.slice(0, 10)}T00:00:00` } : {}),
      participants: share === 'people' ? d.participants.filter((p) => p !== me) : [],
      sharedWithAll: share === 'all',
    };
    setBusy(true);
    try {
      if (!original) {
        await createEvent(draft);
      } else {
        let scope: Scope = 'all';
        if (isRecurring(original) && original.masterId) {
          const picked = await askScope('edit');
          if (!picked) { setBusy(false); return; }
          scope = picked;
        }
        await updateEvent(original, draft, scope);
      }
      onClose();
    } catch {
      showToast('Не сохранилось — нет связи с сервером.', 'error');
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!original || busy) return;
    let scope: Scope = 'all';
    if (isRecurring(original) && original.masterId) {
      const picked = await askScope('delete');
      if (!picked) return;
      scope = picked;
    }
    setBusy(true);
    try { await deleteEvent(original, scope); onClose(); } catch { showToast('Не удалилось — нет связи с сервером.', 'error'); setBusy(false); }
  };

  const leave = async () => {
    if (!original || busy) return;
    setBusy(true);
    try { await leaveEvent(original); onClose(); } catch { showToast('Не получилось — нет связи с сервером.', 'error'); setBusy(false); }
  };

  if (readOnly && original) return <ReadOnly event={original} onClose={onClose} onLeave={leave} busy={busy} users={users} />;

  const pop = (kind: NonNullable<typeof menu>['kind']) => (e: React.MouseEvent<HTMLElement>) =>
    setMenu({ kind, anchor: { element: e.currentTarget, align: 'start' } });
  const repeat = repeatOf(d.recurrenceRule);
  const shareLabel = share === 'all' ? 'Все' : share === 'people'
    ? (d.participants.length ? `${d.participants.length} ${d.participants.length === 1 ? 'человек' : 'чел.'}` : 'Люди')
    : 'Только я';
  const ShareIcon = share === 'all' ? Globe2 : share === 'people' ? Users : Lock;

  const footer = (
    <>
      {original && (
        <button type="button" className="nx-ghost ncal-delete" data-tone="danger" onClick={() => void remove()} disabled={busy}>
          <Trash2 size={15} aria-hidden="true" /> Удалить
        </button>
      )}
      <span className="ncal-foot-gap" />
      <span className="ncal-foot-hint">Ctrl+Enter — сохранить</span>
      <button type="button" className="nx-ghost" onClick={onClose}>Отмена</button>
      <button type="button" className="nx-primary" onClick={() => void save()} disabled={busy || endBeforeStart}>
        {original ? 'Сохранить' : 'Добавить'}
      </button>
    </>
  );

  return (
    <Sheet title={original ? 'Напоминание' : 'Новое напоминание'} onClose={onClose} footer={footer} busy={busy}>
      <div className="ncal-form" onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); } }}>
        <textarea
          ref={textRef}
          className="ncal-note"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'О чём напомнить?\nПервая строка — название, дальше — заметка'}
          aria-label="Название и заметка"
          rows={5}
          style={{ '--ev': colorVar(d.color) } as React.CSSProperties}
        />

        {/* Когда — главная настройка, одной строкой. */}
        <div className="ncal-when" data-invalid={endBeforeStart ? 'true' : undefined}>
          <CalendarDays size={15} aria-hidden="true" />
          <button type="button" className="ncal-pill" onClick={pop('startDate')}>{dayLabel(start)}</button>
          {!d.allDay && (
            <>
              <input className="ncal-time" type="time" step={300} value={hhmm(start)} aria-label="Время начала"
                onChange={(e) => e.target.value && setStart(withTime(d.start, e.target.value))} />
              <span className="ncal-dash">–</span>
              {dayIso(end) !== dayIso(start) && <button type="button" className="ncal-pill" onClick={pop('endDate')}>{dayLabel(end)}</button>}
              <input className="ncal-time" type="time" step={300} value={hhmm(end)} aria-label="Время окончания"
                onChange={(e) => e.target.value && set({ end: withTime(d.end, e.target.value) })} />
            </>
          )}
          {d.allDay && dayIso(end) !== dayIso(start) && <><span className="ncal-dash">–</span><button type="button" className="ncal-pill" onClick={pop('endDate')}>{dayLabel(end)}</button></>}
          <button type="button" className="ncal-pill" aria-pressed={d.allDay} onClick={() => set({ allDay: !d.allDay })}>Весь день</button>
        </div>
        {endBeforeStart && <p className="ncal-error" role="alert">Конец раньше начала.</p>}

        <div className="ncal-chips" role="toolbar" aria-label="Настройки">
          <button type="button" className="ncal-pill" data-on={d.reminderMinutesBefore != null ? 'true' : undefined} onClick={pop('remind')} aria-haspopup="menu">
            <Bell size={14} aria-hidden="true" /> {reminderLabel(d.reminderMinutesBefore)}
          </button>
          <button type="button" className="ncal-pill" data-on={repeat.id !== 'none' ? 'true' : undefined} onClick={pop('repeat')} aria-haspopup="menu">
            <Repeat size={14} aria-hidden="true" /> {repeat.label}
          </button>
          <button type="button" className="ncal-pill" data-on={share !== 'me' ? 'true' : undefined} onClick={pop('share')} aria-haspopup="menu">
            <ShareIcon size={14} aria-hidden="true" /> {shareLabel}
          </button>
          <button type="button" className="ncal-pill" onClick={pop('color')} aria-haspopup="menu" aria-label="Цвет">
            <span className="ncal-dot" style={{ '--ev': colorVar(d.color) } as React.CSSProperties} /> Цвет
          </button>
          {!showPlace && (
            <button type="button" className="ncal-pill" onClick={() => setShowPlace(true)}><MapPin size={14} aria-hidden="true" /> Место</button>
          )}
        </div>

        {showPlace && (
          <label className="ncal-place">
            <MapPin size={15} aria-hidden="true" />
            <input className="ncal-inline-input" value={d.location || ''} onChange={(e) => set({ location: e.target.value })} placeholder="Место или ссылка на встречу" autoFocus={!d.location} />
          </label>
        )}

        {share === 'people' && (
          <section className="ncal-share" aria-label="С кем поделиться">
            {d.participants.length > 0 && (
              <div className="ncal-people-chosen">
                {d.participants.map((id) => (
                  <button key={id} type="button" className="ncal-person-chip" onClick={() => togglePerson(id)} aria-label={`Убрать: ${displayName(users[id]) || id}`}>
                    <Avatar name={displayName(users[id]) || '?'} seed={id} src={users[id]?.avatar} person size={18} />
                    <span>{displayName(users[id]) || 'Сотрудник'}</span>
                    <X size={12} aria-hidden="true" />
                  </button>
                ))}
              </div>
            )}
            <SearchField value={peopleQuery} onChange={setPeopleQuery} placeholder="С кем поделиться" label="С кем поделиться" />
            <div className="ncal-people nx-scroll-y" role="listbox" aria-multiselectable="true" aria-label="Сотрудники">
              {people.slice(0, 60).map((u) => {
                const id = String(u.id);
                const on = d.participants.includes(id);
                return (
                  <button key={id} type="button" role="option" aria-selected={on} className="nx-pick" onClick={() => togglePerson(id)}>
                    <Avatar name={displayName(u) || '?'} seed={id} src={u.avatar} person size={28} />
                    <span className="nx-pick-text"><span>{displayName(u)}</span>{positionOf(u) && <span>{positionOf(u)}</span>}</span>
                    <span className="nx-check" aria-hidden="true">{on && <Check size={12} strokeWidth={3} />}</span>
                  </button>
                );
              })}
            </div>
          </section>
        )}
        {share === 'all' && <p className="ncal-hint">Появится в календаре у всех сотрудников.</p>}
      </div>

      {menu?.kind === 'repeat' && (
        <Menu anchor={menu.anchor} label="Повтор" onClose={() => setMenu(null)} compact>
          {REPEATS.map((r) => (
            <MenuItem key={r.id} icon={repeat.id === r.id ? <Check size={14} /> : <span className="ncal-menu-pad" />} onSelect={() => { set({ recurrenceRule: r.rule }); setMenu(null); }}>{r.label}</MenuItem>
          ))}
        </Menu>
      )}
      {menu?.kind === 'remind' && (
        <Menu anchor={menu.anchor} label="Напоминание" onClose={() => setMenu(null)} compact>
          {REMINDERS.map((r) => (
            <MenuItem key={String(r.value)} icon={(d.reminderMinutesBefore ?? null) === r.value ? <Check size={14} /> : <span className="ncal-menu-pad" />} onSelect={() => { set({ reminderMinutesBefore: r.value }); setMenu(null); }}>{r.label}</MenuItem>
          ))}
        </Menu>
      )}
      {menu?.kind === 'share' && (
        <Menu anchor={menu.anchor} label="Кто видит" onClose={() => setMenu(null)} compact>
          <MenuItem icon={<Lock size={14} />} onSelect={() => { setShareMode('me'); setMenu(null); }}>Только я</MenuItem>
          <MenuItem icon={<Users size={14} />} onSelect={() => { setShareMode('people'); setMenu(null); }}>Выбранные люди…</MenuItem>
          <MenuItem icon={<Globe2 size={14} />} onSelect={() => { setShareMode('all'); setMenu(null); }}>Все сотрудники</MenuItem>
        </Menu>
      )}
      {menu?.kind === 'color' && (
        <Menu anchor={menu.anchor} label="Цвет" onClose={() => setMenu(null)} compact>
          <div className="ncal-menu-colors" role="radiogroup" aria-label="Цвет">
            {COLORS.map((c) => (
              <button key={c.id} type="button" role="radio" aria-checked={(d.color || 'blue') === c.id} aria-label={c.label} title={c.label}
                className="ncal-swatch" style={{ '--ev': colorVar(c.id) } as React.CSSProperties} onClick={() => { set({ color: c.id }); setMenu(null); }} />
            ))}
          </div>
        </Menu>
      )}
      {(menu?.kind === 'startDate' || menu?.kind === 'endDate') && (
        <DatePicker
          anchor={menu.anchor}
          value={menu.kind === 'startDate' ? d.start : d.end}
          onPick={(iso) => {
            if (!iso) return;
            if (menu.kind === 'startDate') setStart(withDate(d.start, iso));
            else set({ end: withDate(d.end, iso) });
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </Sheet>
  );
}

function ReadOnly({ event, onClose, onLeave, busy, users }: {
  event: CalEvent; onClose: () => void; onLeave: () => void; busy: boolean; users: Record<string, User>;
}) {
  const author = users[event.createdBy];
  const start = parseLocal(event.start);
  const canLeave = !event.sharedWithAll && event.participants.includes(myId());
  return (
    <Sheet
      title="Событие"
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          {canLeave && <button type="button" className="nx-ghost" data-tone="danger" onClick={onLeave} disabled={busy}>Убрать из моего календаря</button>}
          <span className="ncal-foot-gap" />
          <button type="button" className="nx-primary" onClick={onClose}>Готово</button>
        </>
      )}
    >
      <div className="ncal-read" style={{ '--ev': colorVar(event.color) } as React.CSSProperties}>
        <h3 className="ncal-read-title">{event.title || 'Без названия'}</h3>
        <p className="ncal-read-when">
          {dayLabel(start)}{event.allDay && !sameDayIso(event.start, event.end) ? ` – ${dayLabel(parseLocal(event.end))}` : ''} · {timeRange(event)}
        </p>
        {event.recurrenceRule && <p className="ncal-read-row"><Repeat size={14} aria-hidden="true" /> {repeatOf(event.recurrenceRule).label}</p>}
        {event.location && <p className="ncal-read-row"><MapPin size={14} aria-hidden="true" /> {event.location}</p>}
        {event.description && <p className="ncal-read-notes">{event.description}</p>}
        <p className="ncal-read-row ncal-read-author">
          <Avatar name={displayName(author) || event.createdByName || '?'} seed={event.createdBy} src={author?.avatar} person size={20} />
          {displayName(author) || event.createdByName || 'Сотрудник'} поделился(-ась) {event.sharedWithAll ? 'со всеми' : 'с вами'}
        </p>
      </div>
    </Sheet>
  );
}

const sameDayIso = (a: string, b: string) => a.slice(0, 10) === b.slice(0, 10);

// Для вида месяца и сетки: быстрое создание «на весь день» от дня.
export const allDayDraft = (day: Date) => newDraft(day, addDays(day, 0), true);
