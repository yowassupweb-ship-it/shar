import { useEffect, useState } from 'react';
import { BellRing, Monitor, Smartphone } from 'lucide-react';
import { Spinner } from '@/shared/ui/Spinner';
import { showToast } from '@/shared/ui/Toast';
import { loadNotify, saveNotify, type NotifyPerson, type NotifyRule, type NotifySettings as Settings } from './api';

/**
 * Уведомления модуля: кому (отдельно «Диалоги» и «Комментарии» — например, комментарии SMM, диалоги
 * менеджерам) и куда (на компьютере — Shar OS и вкладка браузера; пуш — телефон и закрытое
 * приложение). Выбрать можно только тех, у кого есть доступ к модулю. Дублирование в чат Шара —
 * в подключениях, у каждого источника.
 */
export default function NotifySettings() {
  const [data, setData] = useState<{ settings: Settings; people: NotifyPerson[] } | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadNotify().then((d) => { setData(d); setDraft(d.settings); }).catch((e: Error) => showToast(e.message, 'error'));
  }, []);

  if (!data || !draft) return <section className="nsc-account"><Spinner size={20} label="Загружаю настройки" /></section>;

  const dirty = JSON.stringify(draft) !== JSON.stringify(data.settings);
  const setRule = (kind: 'dialogs' | 'comments', rule: NotifyRule) => setDraft({ ...draft, [kind]: rule });
  const save = () => {
    setBusy(true);
    saveNotify(draft)
      .then((r) => { setData({ ...data, settings: r.settings }); setDraft(r.settings); showToast('Сохранено', 'success'); })
      .catch((e: Error) => showToast(e.message, 'error'))
      .finally(() => setBusy(false));
  };

  return (
    <section className="nsc-account" aria-label="Уведомления">
      <div className="nsc-account-head">
        <BellRing size={17} aria-hidden="true" />
        <h3>Уведомления</h3>
        <span className="nsc-tools">
          {dirty && <button type="button" className="nx-ghost" onClick={() => setDraft(data.settings)} disabled={busy}>Отменить</button>}
          <button type="button" className="nx-primary" onClick={save} disabled={!dirty || busy}>{busy ? 'Сохраняю…' : 'Сохранить'}</button>
        </span>
      </div>

      <div className="nsn-where">
        <span className="nsn-label">Куда</span>
        <label className="nsn-check">
          <input type="checkbox" checked={draft.desktop} onChange={(e) => setDraft({ ...draft, desktop: e.target.checked })} />
          <Monitor size={15} aria-hidden="true" />
          <span><b>На компьютере</b><small>Shar OS и открытая вкладка браузера — всплывающее уведомление</small></span>
        </label>
        <label className="nsn-check">
          <input type="checkbox" checked={draft.push} onChange={(e) => setDraft({ ...draft, push: e.target.checked })} />
          <Smartphone size={15} aria-hidden="true" />
          <span><b>Пуш</b><small>Телефон и закрытое приложение — тем, у кого Шар сейчас не открыт</small></span>
        </label>
      </div>

      <Who title="Диалоги" hint="Личные сообщения и беседы" rule={draft.dialogs} people={data.people} onChange={(r) => setRule('dialogs', r)} />
      <Who title="Комментарии" hint="Комментарии под постами" rule={draft.comments} people={data.people} onChange={(r) => setRule('comments', r)} />
      <p className="nsc-muted">Значок непрочитанных на логотипе считает диалоги, которые ждут ответа, — только во вкладках, уведомления которых вам приходят. Дублирование в чат Шара настраивается ниже, у подключений.</p>
    </section>
  );
}

function Who({ title, hint, rule, people, onChange }: {
  title: string; hint: string; rule: NotifyRule; people: NotifyPerson[]; onChange: (r: NotifyRule) => void;
}) {
  const chosen = new Set(rule.users);
  const toggle = (id: string) => onChange({ ...rule, users: chosen.has(id) ? rule.users.filter((u) => u !== id) : [...rule.users, id] });
  return (
    <div className="nsn-who">
      <div className="nsn-who-head">
        <span><b>{title}</b><small>{hint}</small></span>
        <div className="nx-segment" role="group" aria-label={`Кому: ${title}`}>
          <button type="button" aria-pressed={rule.to === 'all'} onClick={() => onChange({ ...rule, to: 'all' })}>Всем с доступом</button>
          <button type="button" aria-pressed={rule.to === 'selected'} onClick={() => onChange({ ...rule, to: 'selected' })}>Выбранным</button>
        </div>
      </div>
      {rule.to === 'selected' && (
        people.length ? (
          <div className="nsn-people">
            {people.map((p) => (
              <label key={p.id} className="nsn-person">
                <input type="checkbox" checked={chosen.has(p.id)} onChange={() => toggle(p.id)} />
                <span>{p.name}</span>
                {p.admin && <small>админ</small>}
              </label>
            ))}
          </div>
        ) : <p className="nsc-muted">Доступ к модулю ещё никому не выдан (Админка → пользователь → доступ).</p>
      )}
      {rule.to === 'selected' && rule.users.length === 0 && people.length > 0 && <p className="nsn-warn">Никто не выбран — уведомлений по этой вкладке не будет.</p>}
    </div>
  );
}
