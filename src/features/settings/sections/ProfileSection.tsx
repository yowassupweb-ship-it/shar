import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Camera, Trash2 } from 'lucide-react';
import { Avatar } from '@/shared/ui/Avatar';
import { askConfirm } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import { removeAvatar, saveProfile, uploadAvatar, type Profile, type ProfileFields } from '../api';
import { Group, Row } from '@/shared/ui/controls';
import { BirthdaySheet } from '@/features/birthdays/BirthdaySheet';
import { formatBirthday, loadBirthdays, useBirthdays } from '@/features/birthdays/store';

const FIELDS: { key: keyof ProfileFields; label: string; type: string; autoComplete?: string }[] = [
  { key: 'position', label: 'Должность', type: 'text', autoComplete: 'organization-title' },
  { key: 'department', label: 'Отдел', type: 'text' },
  { key: 'phone', label: 'Рабочий телефон', type: 'tel', autoComplete: 'tel' },
  { key: 'personalPhone', label: 'Личный телефон', type: 'tel', autoComplete: 'tel' },
  { key: 'workSchedule', label: 'График работы', type: 'text' },
];

/** День рождения — отдельной записью (не поле профиля): правится в своём окне, видят все в календаре. */
function BirthdayRow() {
  const { mine, unsupported } = useBirthdays();
  const [open, setOpen] = useState(false);
  useEffect(() => { void loadBirthdays(); }, []);
  if (unsupported) return null;
  return (
    <Row label="День рождения">
      <button type="button" className="nx-ghost" onClick={() => setOpen(true)}>{mine ? formatBirthday(mine) : 'Указать'}</button>
      {open && <BirthdaySheet onClose={() => setOpen(false)} />}
    </Row>
  );
}

const MAX_AVATAR = 5 * 1024 * 1024;

export default function ProfileSection({ profile, onChange }: { profile: Profile; onChange: (p: Profile) => void }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<'save' | 'avatar' | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const pickAvatar = async (file: File) => {
    if (!file.type.startsWith('image/')) { showToast('Нужна картинка: JPG, PNG или WebP', 'error'); return; }
    if (file.size > MAX_AVATAR) { showToast('Фото больше 5 МБ — выберите поменьше', 'error'); return; }
    setBusy('avatar');
    try {
      const avatar = await uploadAvatar(file);
      onChange({ ...profile, avatar });
      showToast('Фото обновлено', 'success');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Фото не загрузилось', 'error');
    } finally { setBusy(null); }
  };

  const dropAvatar = async () => {
    if (!(await askConfirm({ title: 'Удалить фото профиля?', confirm: 'Удалить', tone: 'danger' }))) return;
    setBusy('avatar');
    try {
      await removeAvatar();
      onChange({ ...profile, avatar: '' });
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Фото не удалилось', 'error');
    } finally { setBusy(null); }
  };

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const fields = Object.fromEntries(FIELDS.map((f) => [f.key, String(form.get(f.key) || '').trim()])) as ProfileFields;
    setBusy('save');
    try {
      onChange(await saveProfile(fields));
      setEditing(false);
      showToast('Профиль сохранён', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Не сохранилось', 'error');
    } finally { setBusy(null); }
  };

  return (
    <>
      <div className="nst-hero">
        <Avatar name={profile.name || ''} seed={String(profile.id)} src={profile.avatar} person size={72} />
        <div className="nst-hero-text">
          <b>{profile.name || profile.username}</b>
          <span>{[profile.position, profile.department].filter(Boolean).join(' · ') || profile.email || profile.username}</span>
        </div>
        <div className="nst-hero-actions">
          <button type="button" className="nx-ghost" disabled={busy === 'avatar'} onClick={() => fileRef.current?.click()}>
            <Camera size={15} aria-hidden="true" /> {busy === 'avatar' ? 'Загружаем…' : 'Сменить фото'}
          </button>
          {profile.avatar && (
            <button type="button" className="nx-icon-btn" aria-label="Удалить фото" disabled={busy === 'avatar'} onClick={dropAvatar}>
              <Trash2 size={16} />
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => { const f = e.target.files?.[0]; e.currentTarget.value = ''; if (f) void pickAvatar(f); }}
          />
        </div>
      </div>

      {editing ? (
        <form onSubmit={submit} className="nx-block">
          <div className="nx-group">
            {FIELDS.map((f) => (
              <Row key={f.key} label={f.label} htmlFor={`nst-${f.key}`}>
                <span className="nx-field" data-variant="filter">
                  <input id={`nst-${f.key}`} name={f.key} type={f.type} defaultValue={profile[f.key] || ''} autoComplete={f.autoComplete} />
                </span>
              </Row>
            ))}
          </div>
          <div className="nx-actions">
            <button type="button" className="nx-ghost" onClick={() => setEditing(false)}>Отмена</button>
            <button type="submit" className="nx-primary" disabled={busy === 'save'}>{busy === 'save' ? 'Сохраняем…' : 'Сохранить'}</button>
          </div>
        </form>
      ) : (
        <Group title="О себе">
          <Row label="Имя"><span className="nx-value">{profile.name || '—'}</span></Row>
          {profile.email && <Row label="Почта"><span className="nx-value">{profile.email}</span></Row>}
          {FIELDS.map((f) => (
            <Row key={f.key} label={f.label}><span className="nx-value">{profile[f.key] || '—'}</span></Row>
          ))}
          <BirthdayRow />
          <div className="nx-row nx-row-end">
            <button type="button" className="nx-ghost" onClick={() => setEditing(true)}>Изменить</button>
          </div>
        </Group>
      )}
    </>
  );
}
