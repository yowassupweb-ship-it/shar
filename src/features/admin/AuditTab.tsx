import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { loadAudit, timeAgo, type AuditEntry } from './api';

const LABELS: Record<string, string> = {
  'user.created': 'Создан пользователь',
  'user.updated': 'Изменён пользователь',
  'user.deleted': 'Удалён пользователь',
  'user.password_reset': 'Сброшен пароль',
  'user.sessions_revoked': 'Завершены сеансы',
  'system.action': 'Действие на сервере',
  'settings.updated': 'Изменены настройки',
  'errors.cleared': 'Очищен журнал ошибок',
};

/** Кто и что менял в админке. */
export default function AuditTab() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try { setEntries(await loadAudit()); setFailed(false); } catch { setFailed(true); setEntries((e) => e ?? []); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <section className="nx-block">
      <div className="nx-block-head">
        <h2 className="nx-block-title">Журнал действий</h2>
        <button type="button" className="nx-icon-btn" aria-label="Обновить" onClick={() => void load()}><RefreshCw size={15} /></button>
      </div>
      {failed && <p className="nx-error" role="alert">Журнал не загрузился.</p>}
      {entries === null ? (
        <div className="nx-group" aria-busy="true"><div className="nx-row"><span className="nx-skel nx-skel-line" style={{ width: '60%' }} /></div></div>
      ) : entries.length === 0 ? (
        <div className="nx-state"><h2>Пока пусто</h2><p>Здесь появятся действия администраторов.</p></div>
      ) : (
        <div className="nx-group">
          {entries.map((e) => (
            <div key={e.id} className="nx-row">
              <span className="nx-row-text">
                <span className="nx-row-label">{LABELS[e.action] || e.action}{e.target ? <code className="nad-target">{e.target}</code> : null}</span>
                <span className="nx-row-hint">
                  {[e.actorName, timeAgo(e.at), Object.keys(e.details).length ? JSON.stringify(e.details) : ''].filter(Boolean).join(' · ')}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
