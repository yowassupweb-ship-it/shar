import { useState } from 'react';
import { Select } from '@/shared/ui/Select';
import { Sheet } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import './birthdays.css';
import { clearMyBirthday, MONTHS_GEN, saveMyBirthday, useBirthdays } from './store';

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const daysIn = (month: number, year: number | null) => new Date(year || 2000, month, 0).getDate();

/** Свой день рождения: день и месяц обязательны, год — по желанию (без него коллеги не видят возраст). */
export function BirthdaySheet({ onClose }: { onClose: () => void }) {
  const mine = useBirthdays((s) => s.mine);
  const [day, setDay] = useState(String(mine?.day ?? ''));
  const [month, setMonth] = useState(String(mine?.month ?? ''));
  const [year, setYear] = useState(mine?.year ? String(mine.year) : '');
  const [busy, setBusy] = useState(false);

  const y = /^\d{4}$/.test(year) ? Number(year) : null;
  const max = month ? daysIn(Number(month), y) : 31;
  const ready = Boolean(day && month) && Number(day) <= max && (!year || y !== null);

  async function save() {
    if (!ready) return;
    setBusy(true);
    try {
      await saveMyBirthday(Number(day), Number(month), y);
      showToast(`День рождения: ${day} ${MONTHS_GEN[Number(month) - 1]}`, 'success');
      onClose();
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : 'Не удалось сохранить', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    try { await clearMyBirthday(); onClose(); } catch { showToast('Не удалось убрать', 'error'); } finally { setBusy(false); }
  }

  return (
    <Sheet
      title="Ваш день рождения"
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          {mine && <button type="button" className="nx-ghost" onClick={() => void clear()} disabled={busy}>Убрать</button>}
          <button type="button" className="nx-primary" onClick={() => void save()} disabled={!ready || busy}>Сохранить</button>
        </>
      )}
    >
      <p className="nbd-note">Коллеги увидят его в календаре, а в этот день всем придёт напоминание поздравить вас.</p>
      <div className="nbd-row">
        <Select label="День" placeholder="День" value={day} onChange={setDay}
          groups={[{ options: Array.from({ length: max }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })) }]} />
        <Select label="Месяц" placeholder="Месяц" value={month} onChange={(m) => { setMonth(m); if (Number(day) > daysIn(Number(m), y)) setDay(''); }}
          groups={[{ options: MONTHS.map((label, i) => ({ value: String(i + 1), label })) }]} />
        <label className="nx-field nbd-year">
          <input inputMode="numeric" maxLength={4} placeholder="Год (необязательно)" value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, ''))} aria-label="Год рождения" />
        </label>
      </div>
    </Sheet>
  );
}
