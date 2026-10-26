import { useMemo, useState, type CSSProperties } from 'react';
import { ChevronLeft, ChevronRight, MapPin, Repeat, Users } from 'lucide-react';
import { isMine } from './api';
import { Chip } from './TimeGrid';
import {
  addDays, byStart, colorVar, dayIso, monthGrid, MONTHS, onDay, parseLocal, sameDay, startOfDay, startOfMonth, timeRange,
  WEEKDAYS, type CalEvent,
} from './model';
import { dayTitle, useWorkdays } from './workdays';

/**
 * Месяц: большой (основной вид) и маленький (боковая панель), плюс список
 * событий дня. Большой месяц на телефоне — точки вместо строк, как в iOS.
 */

const MAX_CHIPS = 3;

export function MonthView({ anchor, events, selected, compact, onSelect, onOpenDay, onCreate, onOpen, onMoveToDay, onMenu, onDelete }: {
  anchor: Date;
  events: CalEvent[];
  selected: Date;
  compact: boolean;
  onSelect: (d: Date) => void;
  onOpenDay: (d: Date) => void;
  onCreate: (d: Date) => void;
  onOpen: (e: CalEvent) => void;
  onMoveToDay: (e: CalEvent, day: Date) => void;
  onMenu?: (e: CalEvent, at: { x: number; y: number }) => void;
  onDelete?: (e: CalEvent) => void;
}) {
  const days = useMemo(() => monthGrid(anchor), [anchor]);
  const perDay = useMemo(() => days.map((d) => events.filter((e) => onDay(e, d)).sort(byStart)), [days, events]);
  const [dropDay, setDropDay] = useState<number | null>(null);
  const today = new Date();
  const month = anchor.getMonth();
  // Нерабочие дни — по производственному календарю (переносы, праздники), а не просто сб/вс.
  const kindOf = useWorkdays(days.map((d) => d.getFullYear()));

  return (
    <div className="ncal-month" data-compact={compact ? 'true' : undefined} style={{ '--weeks': days.length / 7 } as CSSProperties}>
      <div className="ncal-month-wd" aria-hidden="true">
        {WEEKDAYS.map((w, i) => <span key={w} data-weekend={i >= 5 ? 'true' : undefined}>{w}</span>)}
      </div>
      <div className="ncal-month-grid" role="grid" aria-label={`${MONTHS[month]} ${anchor.getFullYear()}`}>
        {days.map((d, i) => {
          const list = perDay[i];
          const extra = list.length - MAX_CHIPS;
          const kind = kindOf(d);
          return (
            <div
              key={d.getTime()}
              role="gridcell"
              className="ncal-cell"
              data-out={d.getMonth() !== month ? 'true' : undefined}
              data-weekend={kind.off ? 'true' : undefined}
              data-short={kind.short ? 'true' : undefined}
              data-workday={kind.workWeekend ? 'true' : undefined}
              title={dayTitle(kind)}
              data-today={sameDay(d, today) ? 'true' : undefined}
              data-selected={sameDay(d, selected) ? 'true' : undefined}
              data-drop={dropDay === i ? 'true' : undefined}
              aria-selected={sameDay(d, selected)}
              onClick={() => onSelect(d)}
              onDoubleClick={() => onCreate(d)}
              onDragOver={(e) => { if (e.dataTransfer.types.includes('text/x-ncal')) { e.preventDefault(); setDropDay(i); } }}
              onDragLeave={() => setDropDay((cur) => (cur === i ? null : cur))}
              onDrop={(e) => {
                setDropDay(null);
                const id = e.dataTransfer.getData('text/x-ncal');
                const ev = events.find((x) => x.id === id);
                if (ev) onMoveToDay(ev, d);
              }}
            >
              <button type="button" className="ncal-cell-num" onClick={(e) => { e.stopPropagation(); onOpenDay(d); }}
                aria-label={d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}>
                {d.getDate() === 1 && !compact ? `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3).toLowerCase()}` : d.getDate()}
              </button>
              {!compact && (kind.name || kind.short || kind.workWeekend) && (
                <span className="ncal-cell-note">{kind.name || (kind.short ? 'сокр.' : 'рабочий')}</span>
              )}
              {compact ? (
                list.length > 0 && (
                  <span className="ncal-dots" aria-label={`${list.length} событ.`}>
                    {list.slice(0, 3).map((e) => <i key={e.id} style={{ '--ev': colorVar(e.color) } as CSSProperties} />)}
                  </span>
                )
              ) : (
                <div className="ncal-cell-events">
                  {list.slice(0, extra > 0 ? MAX_CHIPS - 1 : MAX_CHIPS).map((e) => <Chip key={e.id} e={e} onOpen={onOpen} draggable={isMine(e)} onMenu={onMenu} onDelete={onDelete} />)}
                  {extra > 0 && (
                    <button type="button" className="ncal-more" onClick={(e) => { e.stopPropagation(); onOpenDay(d); }}>
                      ещё {extra + 1}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function MiniMonth({ month, selected, events, onMonth, onPick }: {
  month: Date; selected: Date; events: CalEvent[]; onMonth: (d: Date) => void; onPick: (d: Date) => void;
}) {
  const days = useMemo(() => monthGrid(month), [month]);
  const busy = useMemo(() => {
    const set = new Set<string>();
    for (const d of days) if (events.some((e) => onDay(e, d))) set.add(dayIso(d));
    return set;
  }, [days, events]);
  const today = new Date();
  const kindOf = useWorkdays(days.map((d) => d.getFullYear()));
  const step = (n: number) => onMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));
  return (
    <div className="ncal-mini">
      <div className="ncal-mini-head">
        <b>{MONTHS[month.getMonth()]} {month.getFullYear()}</b>
        <button type="button" className="nx-icon-btn" onClick={() => step(-1)} aria-label="Предыдущий месяц"><ChevronLeft size={15} /></button>
        <button type="button" className="nx-icon-btn" onClick={() => step(1)} aria-label="Следующий месяц"><ChevronRight size={15} /></button>
      </div>
      <div className="ncal-mini-grid" role="grid">
        {WEEKDAYS.map((w, i) => <span key={w} className="ncal-mini-wd" data-weekend={i >= 5 ? 'true' : undefined}>{w.slice(0, 1)}</span>)}
        {days.map((d) => (
          <button
            key={d.getTime()}
            type="button"
            className="ncal-mini-day"
            data-out={d.getMonth() !== month.getMonth() ? 'true' : undefined}
            data-today={sameDay(d, today) ? 'true' : undefined}
            data-off={kindOf(d).off ? 'true' : undefined}
            title={dayTitle(kindOf(d))}
            data-busy={busy.has(dayIso(d)) ? 'true' : undefined}
            aria-pressed={sameDay(d, selected)}
            onClick={() => onPick(d)}
          >
            {d.getDate()}
          </button>
        ))}
      </div>
    </div>
  );
}

export function DayAgenda({ day, events, onOpen, onCreate, title, onMenu }: {
  day: Date; events: CalEvent[]; onOpen: (e: CalEvent) => void; onCreate: () => void; title?: string;
  onMenu?: (e: CalEvent, at: { x: number; y: number }) => void;
}) {
  const list = useMemo(() => events.filter((e) => onDay(e, day)).sort(byStart), [events, day]);
  const today = startOfDay(new Date());
  const note = dayTitle(useWorkdays([day.getFullYear()])(day));
  const heading = title || (sameDay(day, today) ? 'Сегодня' : sameDay(day, addDays(today, 1)) ? 'Завтра'
    : day.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }));
  return (
    <section className="ncal-agenda" aria-label={heading}>
      <h3 className="ncal-agenda-head">{heading}{note && <span className="ncal-agenda-note">{note}</span>}</h3>
      {list.length === 0 ? (
        <button type="button" className="ncal-agenda-empty" onClick={onCreate}>Свободный день — добавить событие</button>
      ) : (
        <ul>
          {list.map((e) => (
            <li key={e.id}>
              <button type="button" className="ncal-agenda-row" style={{ '--ev': colorVar(e.color) } as CSSProperties} onClick={() => onOpen(e)}
                onContextMenu={(ev) => { if (!onMenu) return; ev.preventDefault(); onMenu(e, { x: ev.clientX, y: ev.clientY }); }}>
                <span className="ncal-agenda-time">{e.allDay ? 'весь день' : timeRange(e).replace('–', '\n')}</span>
                <span className="ncal-agenda-text">
                  <span className="ncal-agenda-title">
                    {e.title || 'Без названия'}
                    {e.masterId && <Repeat size={11} aria-hidden="true" />}
                    {(e.sharedWithAll || e.participants.length > 0) && <Users size={11} aria-hidden="true" />}
                  </span>
                  {e.location && <span className="ncal-agenda-place"><MapPin size={11} aria-hidden="true" /> {e.location}</span>}
                  {!isMine(e) && e.createdByName && <span className="ncal-agenda-place">от {e.createdByName}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export { parseLocal, startOfMonth };
