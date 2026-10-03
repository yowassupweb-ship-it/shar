import { useState, type FormEvent } from 'react';
import { Check } from 'lucide-react';
import { Sheet } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import { Switch } from '@/shared/ui/controls';
import { createUser, updateUser, type AdminUser, type Department, type UserDraft } from './api';

/** Отделы деревом: подразделы с отступом под своим отделом, выбор нескольких. */
function DepartmentPicker({ departments, selected, onChange }: {
  departments: Department[]; selected: string[]; onChange: (ids: string[]) => void;
}) {
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const tops = departments.filter((d) => !d.parentId);
  if (!tops.length) return <p className="nx-note">Отделов нет — создайте их на вкладке «Отделы».</p>;
  const item = (d: Department, child: boolean) => {
    const on = selected.includes(d.id);
    return (
      <button key={d.id} type="button" role="checkbox" aria-checked={on} className="nad-dept-pick" data-child={child ? 'true' : undefined} onClick={() => toggle(d.id)}>
        <span className="nx-check" data-on={on ? 'true' : undefined} aria-hidden="true">{on && <Check size={11} strokeWidth={3} />}</span>
        <span className="nx-dot" style={{ background: d.color || '#6b7280' }} aria-hidden="true" />
        <span className="nad-dept-name">{d.name}</span>
      </button>
    );
  };
  return (
    <div className="nad-dept-list" role="group" aria-label="Отделы">
      {tops.map((t) => [item(t, false), ...departments.filter((d) => d.parentId === t.id).map((d) => item(d, true))])}
    </div>
  );
}

export function randomPassword(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

const EMPTY: UserDraft = {
  username: '', name: '', email: '', password: '', role: 'user', position: '', department: '',
  departmentIds: [], phone: '', workSchedule: '', telegramId: '', canSeeAllTasks: false, isDepartmentHead: false,
};

export default function UserSheet({ user, departments, onClose, onSaved }: {
  user?: AdminUser; departments: Department[]; onClose: () => void; onSaved: () => void;
}) {
  const editing = Boolean(user);
  const [draft, setDraft] = useState<UserDraft>(() => user ? {
    ...EMPTY, ...user,
    departmentIds: user.departmentIds?.length ? user.departmentIds : user.department ? [user.department] : [],
  } : EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof UserDraft>(k: K, v: UserDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!draft.username?.trim()) { setError('Нужен логин'); return; }
    if (!editing && (draft.password || '').length < 8) { setError('Пароль — не короче 8 символов'); return; }
    setError(null);
    setBusy(true);
    const payload: Partial<UserDraft> = {
      ...draft,
      username: draft.username.trim(),
      department: draft.departmentIds?.[0] || '',
      enabledTools: user?.enabledTools || [],
    };
    // Пароль меняется только отдельным действием «Сбросить пароль».
    if (editing) delete payload.password;
    delete (payload as Partial<AdminUser>).isDisabled;
    // Роль в задачах как сущность больше не используется — не пишем её.
    delete (payload as Record<string, unknown>).todoRole;
    try {
      if (user) await updateUser(user.id, payload);
      else await createUser(payload as UserDraft);
      showToast(editing ? 'Пользователь сохранён' : 'Пользователь создан', 'success');
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не сохранилось');
      setBusy(false);
    }
  };

  const field = (k: 'username' | 'name' | 'email' | 'phone' | 'workSchedule' | 'position' | 'telegramId', label: string, type = 'text', placeholder?: string) => (
    <label className="nx-label">
      {label}
      <span className="nx-field">
        <input type={type} value={String(draft[k] || '')} placeholder={placeholder} onChange={(e) => set(k, e.target.value)}
          autoComplete="off" autoCapitalize={k === 'username' || k === 'email' ? 'none' : undefined} spellCheck={false} />
      </span>
    </label>
  );

  return (
    <Sheet
      title={editing ? `Пользователь: ${user!.name || user!.username}` : 'Новый пользователь'}
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          <button type="button" className="nx-ghost" onClick={onClose}>Отмена</button>
          <button type="button" className="nx-primary" disabled={busy} onClick={() => void submit()}>{busy ? 'Сохраняем…' : editing ? 'Сохранить' : 'Создать'}</button>
        </>
      )}
    >
      <form className="nx-form" onSubmit={submit} noValidate>
        <div className="nx-form-grid">
          {field('username', 'Логин *', 'text', 'ivanov')}
          {field('name', 'Имя', 'text', 'Иван Иванов')}
          {field('email', 'Почта', 'email', 'user@example.com')}
          {!editing && (
            <label className="nx-label">
              Пароль * (от 8 символов)
              <span className="nx-field">
                <input type="text" value={draft.password || ''} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" spellCheck={false} />
                <button type="button" className="nx-ghost" onClick={() => set('password', randomPassword())}>Придумать</button>
              </span>
            </label>
          )}
          {field('position', 'Должность', 'text', 'Менеджер проектов')}
          {field('phone', 'Телефон', 'tel', '+7 999 123-45-67')}
          {field('workSchedule', 'График работы', 'text', 'Пн–Пт 9:00–18:00')}
          {field('telegramId', 'Telegram ID')}
          <label className="nx-label">
            Роль
            <select value={draft.role} onChange={(e) => set('role', e.target.value as 'admin' | 'user')}>
              <option value="user">Пользователь</option>
              <option value="admin">Администратор</option>
            </select>
          </label>
        </div>

        <div className="nx-label">
          Отделы (можно несколько)
          <DepartmentPicker departments={departments} selected={draft.departmentIds || []} onChange={(ids) => set('departmentIds', ids)} />
        </div>

        <div className="nx-group">
          <div className="nx-row">
            <span className="nx-row-text"><span className="nx-row-label">Руководитель отдела</span><span className="nx-row-hint">Видит все задачи своего отдела</span></span>
            <Switch checked={Boolean(draft.isDepartmentHead)} onChange={(v) => set('isDepartmentHead', v)} label="Руководитель отдела" />
          </div>
          <div className="nx-row">
            <span className="nx-row-text"><span className="nx-row-label">Видит все задачи</span><span className="nx-row-hint">Задачи всей компании</span></span>
            <Switch checked={Boolean(draft.canSeeAllTasks)} onChange={(v) => set('canSeeAllTasks', v)} label="Видит все задачи" />
          </div>
        </div>
        {error && <p className="nx-error" role="alert">{error}</p>}
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}
