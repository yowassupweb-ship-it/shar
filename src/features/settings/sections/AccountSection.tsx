import { useState, type FormEvent } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { showToast } from '@/shared/ui/Toast';
import { changePassword, type Profile } from '../api';
import { Group, Row } from '@/shared/ui/controls';

const MIN_LENGTH = 6;

export default function AccountSection({ profile }: { profile: Profile }) {
  const [changing, setChanging] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const next = String(form.get('password') || '');
    const repeat = String(form.get('repeat') || '');
    if (next.length < MIN_LENGTH) { setError(`Пароль короче ${MIN_LENGTH} символов`); return; }
    if (next !== repeat) { setError('Пароли не совпадают'); return; }
    setError(null);
    setBusy(true);
    try {
      await changePassword(next);
      setChanging(false);
      showToast('Пароль изменён', 'success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Пароль не изменился');
    } finally { setBusy(false); }
  };

  return (
    <>
      <Group title="Вход">
        <Row label="Логин"><span className="nx-value">{profile.username || '—'}</span></Row>
        {!changing && (
          <Row label="Пароль" hint="Для входа на всех устройствах">
            <button type="button" className="nx-ghost" onClick={() => { setChanging(true); setError(null); }}>Сменить</button>
          </Row>
        )}
      </Group>

      {changing && (
        <form className="nx-block" onSubmit={submit} noValidate>
          <h2 className="nx-block-title">Новый пароль</h2>
          <div className="nx-group">
            <Row label="Пароль" htmlFor="nst-password">
              <span className="nx-field" data-variant="filter">
                <input id="nst-password" name="password" type={reveal ? 'text' : 'password'} autoComplete="new-password" autoFocus />
                <button type="button" className="nst-reveal" aria-label={reveal ? 'Скрыть пароль' : 'Показать пароль'} onClick={() => setReveal((v) => !v)}>
                  {reveal ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </span>
            </Row>
            <Row label="Ещё раз" htmlFor="nst-repeat">
              <span className="nx-field" data-variant="filter">
                <input id="nst-repeat" name="repeat" type={reveal ? 'text' : 'password'} autoComplete="new-password" />
              </span>
            </Row>
          </div>
          {error && <p className="nx-error" role="alert">{error}</p>}
          <div className="nx-actions">
            <button type="button" className="nx-ghost" onClick={() => setChanging(false)}>Отмена</button>
            <button type="submit" className="nx-primary" disabled={busy}>{busy ? 'Сохраняем…' : 'Сменить пароль'}</button>
          </div>
        </form>
      )}
    </>
  );
}
