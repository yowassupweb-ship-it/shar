import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Eye, EyeOff, Loader2, TriangleAlert } from 'lucide-react';
import SharMark from '@/shared/ui/SharMark';
import { login, LoginError } from '@/shared/session/session';
import './login.css';

/**
 * Вход в Шар. Сессия — HttpOnly-кука, которую выдаёт сервер; пароль в браузере не хранится.
 *
 * Что здесь есть сверх двух полей:
 *  - пароль можно показать — на телефоне опечатки в скрытом поле частая причина «неверный пароль»;
 *  - предупреждение о Caps Lock;
 *  - понятный ответ на «слишком много попыток» и «сервер недоступен»;
 *  - после ошибки фокус возвращается в поле пароля, а само поле очищается.
 */
export default function LoginScreen() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [caps, setCaps] = useState(false);
  const password = useRef<HTMLInputElement>(null);
  const username = useRef<HTMLInputElement>(null);

  useEffect(() => { username.current?.focus(); }, []);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // Значения берём из формы, а не из состояния: автозаполнение браузера
    // не всегда вызывает onChange.
    const form = new FormData(e.currentTarget);
    const name = String(form.get('username') || '').trim();
    const pass = String(form.get('password') || '');
    if (!name || !pass) {
      setError(!name ? 'Введите логин' : 'Введите пароль');
      (name ? password : username).current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await login(name, pass);
    } catch (err) {
      setError(err instanceof LoginError ? err.message : 'Не удалось войти');
      setBusy(false);
      if (password.current) { password.current.value = ''; password.current.focus(); }
    }
  };

  const watchCaps = (e: KeyboardEvent<HTMLInputElement>) => setCaps(e.getModifierState?.('CapsLock') ?? false);

  return (
    <main className="nx nx-login">
      <div className="nx-login-glow" aria-hidden="true" />
      <form className="nx-login-card" onSubmit={submit} noValidate aria-busy={busy}>
        <div className="nx-login-brand">
          <SharMark size={56} />
          <h1>Шар</h1>
          <p>Рабочий мессенджер команды</p>
        </div>

        <label className="nx-login-label">
          <span>Логин</span>
          <span className="nx-field">
            <input ref={username} name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={busy} />
          </span>
        </label>

        <label className="nx-login-label">
          <span>Пароль</span>
          <span className="nx-field nx-login-pass">
            <input
              ref={password}
              name="password"
              type={shown ? 'text' : 'password'}
              autoComplete="current-password"
              disabled={busy}
              onKeyUp={watchCaps}
              onKeyDown={watchCaps}
              onBlur={() => setCaps(false)}
            />
            <button
              type="button"
              className="nx-icon-btn nx-login-eye"
              aria-label={shown ? 'Скрыть пароль' : 'Показать пароль'}
              aria-pressed={shown}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => setShown((v) => !v)}
              tabIndex={-1}
            >
              {shown ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
            </button>
          </span>
          {caps && <small className="nx-login-hint"><TriangleAlert size={12} aria-hidden="true" /> Включён Caps Lock</small>}
        </label>

        {error && <p className="nx-error nx-login-error" role="alert">{error}</p>}

        <button type="submit" className="nx-primary nx-login-submit" disabled={busy}>
          {busy ? <><Loader2 size={16} className="nx-spin" aria-hidden="true" /> Входим…</> : 'Войти'}
        </button>
        <p className="nx-login-foot">Забыли пароль? Попросите администратора выдать новый.</p>
      </form>
    </main>
  );
}
