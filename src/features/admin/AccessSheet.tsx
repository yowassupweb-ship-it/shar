import { useState } from 'react';
import { Sheet } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import { Switch } from '@/shared/ui/controls';
import { GRANTABLE_TOOLS } from '@/features/more';
import { setUserTools, type AdminUser } from './api';

/** Какие инструменты открыты пользователю (стандартные видят все, админские — только админ). */
export default function AccessSheet({ user, onClose, onSaved }: { user: AdminUser; onClose: () => void; onSaved: () => void }) {
  const [tools, setTools] = useState<string[]>(user.enabledTools || []);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await setUserTools(user.id, tools);
      showToast('Доступ обновлён', 'success');
      onSaved();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не сохранилось', 'error');
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={`Инструменты: ${user.name || user.username}`}
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          <button type="button" className="nx-ghost" onClick={onClose}>Отмена</button>
          <button type="button" className="nx-primary" disabled={busy} onClick={() => void save()}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
        </>
      )}
    >
      <div className="nx-group">
        {GRANTABLE_TOOLS.map((t) => {
          const on = tools.includes(t.id);
          return (
            <div key={t.id} className="nx-row">
              <span className="nx-row-text"><span className="nx-row-label">{t.name}</span><span className="nx-row-hint">{t.hint}</span></span>
              <Switch checked={on} label={t.name} onChange={(v) => setTools((cur) => (v ? [...cur, t.id] : cur.filter((x) => x !== t.id)))} />
            </div>
          );
        })}
      </div>
      <p className="nx-note">Инструкция и настройки доступны всем, админка — только администраторам.</p>
    </Sheet>
  );
}
