import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { loadOverview, type Overview } from './api';

function Stat({ label, value, hint, tone }: { label: string; value: number | string; hint?: string; tone?: 'warn' }) {
  return (
    <div className="nad-stat" data-tone={tone}>
      <b>{typeof value === 'number' ? value.toLocaleString('ru-RU') : value}</b>
      <span>{label}</span>
      {hint && <small>{hint}</small>}
    </div>
  );
}

/** Сводка: сколько людей, сообщений, задач — и что требует внимания. */
export default function OverviewTab({ onOpen }: { onOpen: (tab: string) => void }) {
  const [data, setData] = useState<Overview | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try { setData(await loadOverview()); setFailed(false); } catch { setFailed(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (failed) return <p className="nx-error" role="alert">Сводка не загрузилась — нет связи или прав администратора.</p>;
  if (!data) return <div className="nx-group" aria-busy="true"><div className="nx-row"><span className="nx-skel nx-skel-line" style={{ width: '60%' }} /></div></div>;

  const { users } = data;
  const attention: { text: string; tab: string }[] = [];
  if (users.withoutPassword) attention.push({ text: `У ${users.withoutPassword} пользователей нет пароля — войти они не смогут`, tab: 'users' });
  if (users.legacyPasswords) attention.push({ text: `${users.legacyPasswords} паролей в старом формате — обновятся при следующем входе`, tab: 'users' });
  if (users.admins < 1) attention.push({ text: 'Нет ни одного активного администратора', tab: 'users' });

  return (
    <>
      <section className="nx-block">
        <div className="nx-block-head">
          <h2 className="nx-block-title">Люди</h2>
          <button type="button" className="nx-icon-btn" aria-label="Обновить" onClick={() => void load()}><RefreshCw size={15} /></button>
        </div>
        <div className="nad-stats">
          <Stat label="Онлайн" value={users.online} hint={`из ${users.active} активных`} />
          <Stat label="Администраторов" value={users.admins} />
          <Stat label="Отключено" value={users.disabled} />
          <Stat label="Устройств с пушами" value={data.pushDevices} />
        </div>
      </section>
      <section className="nx-block">
        <h2 className="nx-block-title">Активность</h2>
        <div className="nad-stats">
          <Stat label="Сообщений за сутки" value={data.chats.messagesDay} />
          <Stat label="Сообщений за неделю" value={data.chats.messagesWeek} />
          <Stat label="Чатов" value={data.chats.total} />
          <Stat label="Открытых задач" value={data.tasks.open} hint={`всего ${data.tasks.total}`} />
          <Stat label="Отделов" value={data.departments} />
          <Stat label="Почтовых ящиков" value={data.mailAccounts} />
        </div>
      </section>
      {attention.length > 0 && (
        <section className="nx-block">
          <h2 className="nx-block-title">Требует внимания</h2>
          <div className="nx-group">
            {attention.map((a) => (
              <button key={a.text} type="button" className="nx-row nad-attention" onClick={() => onOpen(a.tab)}>
                <span className="nx-row-text"><span className="nx-row-label">{a.text}</span></span>
              </button>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
