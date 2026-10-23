import { useEffect, useState } from 'react';
import { CalendarClock, Clock, Paperclip, Send, Trash2 } from 'lucide-react';
import { renderTextWithEmoji } from '@/shared/emoji/emojiText';
import { plural } from '@/shared/ui/format';
import { askConfirm, Menu, MenuItem, Sheet, type MenuAnchor } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import {
  cancelScheduled, loadScheduled, quickTimes, rescheduleMessage, sendScheduledNow, useScheduled, whenLabel, type Scheduled,
} from './scheduled';

const pad = (n: number) => String(n).padStart(2, '0');
const dateValue = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeValue = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Меню «Отправить позже» у кнопки отправки: быстрые варианты и «Выбрать дату и время…». */
export function ScheduleMenu({ anchor, onPick, onCustom, onClose }: {
  anchor: MenuAnchor; onPick: (at: Date) => void; onCustom: () => void; onClose: () => void;
}) {
  return (
    <Menu anchor={anchor} label="Отправить позже" onClose={onClose}>
      <div className="nx-menu-label">Отправить позже</div>
      {quickTimes().map((q) => (
        <MenuItem key={q.label} icon={<Clock size={16} />} onSelect={() => { onClose(); onPick(q.at); }}>{q.label}</MenuItem>
      ))}
      <div className="nx-menu-sep" />
      <MenuItem icon={<CalendarClock size={16} />} onSelect={() => { onClose(); onCustom(); }}>Выбрать дату и время…</MenuItem>
    </Menu>
  );
}

/** Своя дата и время: системные поля — на телефоне это родные барабаны iOS/Android. */
export function SchedulePicker({ title, initial, onPick, onClose }: {
  title: string; initial?: Date; onPick: (at: Date) => void | Promise<void>; onClose: () => void;
}) {
  const start = initial ?? quickTimes()[0].at;
  const [date, setDate] = useState(dateValue(start));
  const [time, setTime] = useState(timeValue(start));
  const [busy, setBusy] = useState(false);
  const at = new Date(`${date}T${time || '00:00'}`);
  const valid = !Number.isNaN(at.getTime()) && at.getTime() > Date.now() - 60_000;
  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try { await onPick(at); onClose(); } catch { setBusy(false); }
  };
  return (
    <Sheet
      title={title}
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          <button type="button" className="nx-ghost" onClick={onClose}>Отмена</button>
          <button type="button" className="nx-primary" disabled={!valid || busy} onClick={() => void save()}>{busy ? 'Сохраняю…' : 'Запланировать'}</button>
        </>
      )}
    >
      <div className="cxs-pick">
        <label className="nx-field">
          <input type="date" value={date} min={dateValue(new Date())} onChange={(e) => setDate(e.target.value)} aria-label="Дата" />
        </label>
        <label className="nx-field">
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Время" />
        </label>
      </div>
      <p className="cxs-pick-hint">{valid ? `Уйдёт ${whenLabel(at.toISOString())}` : 'Это время уже прошло'}</p>
    </Sheet>
  );
}

/**
 * Полоска над полем ввода: «2 запланированных · ближайшее завтра в 9:00». По нажатию — список: отправить
 * сейчас, перенести, удалить. Пустой чат без запланированных полоски не показывает.
 */
export function ScheduledBar({ chatId }: { chatId: string }) {
  const items = useScheduled((s) => s.byChat[chatId]);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (!useScheduled.getState().byChat[chatId]) void loadScheduled(chatId); }, [chatId]);
  useEffect(() => { if (open && !items?.length) setOpen(false); }, [open, items]);
  if (!items?.length) return null;
  return (
    <>
      <button type="button" className="cxs-bar" onClick={() => setOpen(true)}>
        <Clock size={14} aria-hidden="true" />
        <span>{items.length} {plural(items.length, ['запланированное', 'запланированных', 'запланированных'])} · {whenLabel(items[0].sendAt)}</span>
      </button>
      {open && <ScheduledSheet items={items} onClose={() => setOpen(false)} />}
    </>
  );
}

function ScheduledSheet({ items, onClose }: { items: Scheduled[]; onClose: () => void }) {
  const [menu, setMenu] = useState<{ item: Scheduled; anchor: MenuAnchor } | null>(null);
  const [moving, setMoving] = useState<Scheduled | null>(null);
  const run = async (fn: () => Promise<unknown>, fail: string) => {
    try { await fn(); } catch (cause) { showToast(cause instanceof Error && cause.message ? cause.message : fail, 'error'); }
  };
  return (
    <Sheet title="Запланированные" onClose={onClose}>
      <ul className="cxs-list">
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="cxs-item"
              onClick={(e) => setMenu({ item, anchor: { element: e.currentTarget, align: 'end' } })}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ item, anchor: { x: e.clientX, y: e.clientY } }); }}
            >
              <span className="cxs-when"><Clock size={13} aria-hidden="true" /> {whenLabel(item.sendAt)}</span>
              <span className="cxs-text">
                {item.attachments?.length ? <span className="cxs-files"><Paperclip size={13} aria-hidden="true" /> {item.attachments.length} {plural(item.attachments.length, ['файл', 'файла', 'файлов'])}</span> : null}
                {item.content ? renderTextWithEmoji(item.content, `s-${item.id}`, '1em') : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {menu && (
        <Menu anchor={menu.anchor} label="Запланированное" onClose={() => setMenu(null)}>
          <MenuItem icon={<Send size={15} />} onSelect={() => { const { item } = menu; setMenu(null); void run(() => sendScheduledNow(item), 'Не удалось отправить'); }}>Отправить сейчас</MenuItem>
          <MenuItem icon={<CalendarClock size={15} />} onSelect={() => { const { item } = menu; setMenu(null); setMoving(item); }}>Изменить время</MenuItem>
          <MenuItem
            icon={<Trash2 size={15} />}
            tone="danger"
            onSelect={() => {
              const { item } = menu;
              setMenu(null);
              void askConfirm({ title: 'Отменить отправку?', text: 'Сообщение не уйдёт и будет удалено.', confirm: 'Удалить', tone: 'danger' })
                .then((ok) => { if (ok) void run(() => cancelScheduled(item), 'Не удалось удалить'); });
            }}
          >
            Удалить
          </MenuItem>
        </Menu>
      )}
      {moving && (
        <SchedulePicker
          title="Перенести отправку"
          initial={new Date(moving.sendAt)}
          onClose={() => setMoving(null)}
          onPick={async (at) => {
            try { await rescheduleMessage(moving, at); } catch (cause) {
              showToast(cause instanceof Error && cause.message ? cause.message : 'Не удалось перенести', 'error');
              throw cause;
            }
          }}
        />
      )}
    </Sheet>
  );
}
