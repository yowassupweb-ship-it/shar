import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { BirthdaySheet } from './BirthdaySheet';
import { loadBirthdays, useBirthdays } from './store';

const HIDE_KEY = 'shar.birthday-banner.hidden-until';
const HIDE_DAYS = 14;

function hiddenNow() {
  try { return Number(localStorage.getItem(HIDE_KEY) || 0) > Date.now(); } catch { return false; }
}

/**
 * Плашка «Укажите свой день рождения» между шапкой и списком чатов — пока он не указан.
 * Крестик прячет её на две недели (на этом устройстве), потом она вернётся.
 */
export function BirthdayBanner() {
  const { loaded, mine, unsupported } = useBirthdays();
  const [hidden, setHidden] = useState(hiddenNow);
  const [open, setOpen] = useState(false);
  useEffect(() => { void loadBirthdays(); }, []);

  if (!loaded || unsupported || mine || hidden) return open ? <BirthdaySheet onClose={() => setOpen(false)} /> : null;
  return (
    <>
      <div className="nbd-banner">
        <button type="button" className="nbd-banner-main" onClick={() => setOpen(true)}>
          <span className="nbd-banner-icon" aria-hidden="true">🎂</span>
          <span className="nbd-banner-text"><b>Укажите свой день рождения</b><span>Коллеги смогут вас поздравить</span></span>
        </button>
        <button
          type="button"
          className="nx-icon-btn nbd-banner-close"
          aria-label="Скрыть"
          title="Скрыть на две недели"
          onClick={() => {
            try { localStorage.setItem(HIDE_KEY, String(Date.now() + HIDE_DAYS * 86400000)); } catch { /* приватный режим */ }
            setHidden(true);
          }}
        >
          <X size={14} />
        </button>
      </div>
      {open && <BirthdaySheet onClose={() => setOpen(false)} />}
    </>
  );
}
