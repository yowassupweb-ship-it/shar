import { useEffect, useState, type FormEvent } from 'react';
import { Select } from '@/shared/ui/Select';
import { Bell, Mail, Trash2 } from 'lucide-react';
import { askConfirm } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import { Group, Row, Switch } from '@/shared/ui/controls';
import {
  addEmailRule, deleteEmailRule, loadChatOptions, loadEmailRules, loadSystemSettings, saveSystemSettings, testTelegram,
  type ChatOption, type EmailRule, type SystemSettings,
} from './api';

/** Письма с адресов (или доменов) → в выбранный чат. */
function EmailRules() {
  const [rules, setRules] = useState<EmailRule[] | null>(null);
  const [chats, setChats] = useState<ChatOption[]>([]);
  const [draft, setDraft] = useState({ emailPattern: '', chatId: '', keyword: '', description: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void Promise.all([loadEmailRules().catch(() => []), loadChatOptions().catch(() => [])]).then(([r, c]) => { setRules(r); setChats(c); });
  }, []);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft.emailPattern.trim() || !draft.chatId) return;
    setBusy(true);
    try {
      const rule = await addEmailRule({ ...draft, emailPattern: draft.emailPattern.trim().toLowerCase(), keyword: draft.keyword.trim() });
      setRules((cur) => [...(cur || []), rule]);
      setDraft({ emailPattern: '', chatId: '', keyword: '', description: '' });
      showToast('Правило добавлено', 'success');
    } catch (err) { showToast(err instanceof Error ? err.message : 'Не добавилось', 'error'); }
    finally { setBusy(false); }
  };

  const remove = async (r: EmailRule) => {
    if (!(await askConfirm({ title: 'Удалить правило?', text: `${r.emailPattern} → ${r.chatTitle || r.chatId}`, confirm: 'Удалить', tone: 'danger' }))) return;
    try { await deleteEmailRule(r.id); setRules((cur) => (cur || []).filter((x) => x.id !== r.id)); }
    catch { showToast('Не удалилось', 'error'); }
  };

  return (
    <section className="nx-block">
      <h2 className="nx-block-title">Письма → чат (реестр отзывов)</h2>
      <div className="nx-group">
        {rules === null ? (
          <div className="nx-row"><span className="nx-skel nx-skel-line" style={{ width: '50%' }} /></div>
        ) : rules.length === 0 ? (
          <div className="nx-row"><span className="nx-row-hint">Правил пока нет</span></div>
        ) : rules.map((r) => (
          <div key={r.id} className="nx-row">
            <Mail size={15} aria-hidden="true" className="nad-muted" />
            <span className="nx-row-text">
              <span className="nx-row-label"><code>{r.emailPattern}</code>{r.keyword && <span className="nx-tag">«{r.keyword}»</span>}</span>
              <span className="nx-row-hint">→ {r.chatTitle || r.chatId}{r.description ? ` · ${r.description}` : ''}</span>
            </span>
            <button type="button" className="nx-icon-btn" aria-label={`Удалить правило ${r.emailPattern}`} onClick={() => void remove(r)}><Trash2 size={15} /></button>
          </div>
        ))}
      </div>
      <form className="nx-form nad-rule-form" onSubmit={add}>
        <div className="nx-form-grid">
          <label className="nx-label">Адрес или домен
            <span className="nx-field"><input value={draft.emailPattern} placeholder="noreply@otzovik.com или @domain.com" onChange={(e) => setDraft({ ...draft, emailPattern: e.target.value })} /></span>
          </label>
          <label className="nx-label">Чат
            <Select label="Чат" placeholder="Выберите чат" value={draft.chatId} onChange={(v) => setDraft({ ...draft, chatId: v })}
              groups={[{ options: chats.map((c) => ({ value: String(c.id), label: c.title })) }]} />
          </label>
          <label className="nx-label">Слово в теме или тексте (необязательно)
            <span className="nx-field"><input value={draft.keyword} placeholder="отзыв" onChange={(e) => setDraft({ ...draft, keyword: e.target.value })} /></span>
          </label>
          <label className="nx-label">Описание (необязательно)
            <span className="nx-field"><input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></span>
          </label>
        </div>
        <div className="nx-actions">
          <button type="submit" className="nx-primary" disabled={busy || !draft.emailPattern.trim() || !draft.chatId}>{busy ? 'Добавляем…' : 'Добавить правило'}</button>
        </div>
      </form>
    </section>
  );
}

/** Проверка карточек уведомлений Шара для компьютера (только в Electron). */
function DesktopNotificationTest() {
  const desk = window.sharDesktop;
  if (!desk?.showNotification) return null;
  const show = async (kind: 'task' | 'message' | 'event', label: string) => {
    try {
      await desk.showNotification({
        title: kind === 'task' ? 'Тестовая задача' : kind === 'event' ? 'Тестовое событие' : 'Администратор',
        senderName: 'Администратор', message: `Тестовое уведомление: ${label}`, timestamp: Date.now(), kind, url: '/chats',
      });
      showToast(`Уведомление «${label}» показано`, 'success');
    } catch { showToast('Уведомление не показалось', 'error'); }
  };
  return (
    <Group title="Уведомления Шара для компьютера" note="Показываются только вам, на этом компьютере.">
      <Row label="Показать тестовое" hint="Проверка вида карточек">
        <div className="nx-inline">
          <button type="button" className="nx-ghost" onClick={() => void show('message', 'сообщение')}><Bell size={14} aria-hidden="true" /> Сообщение</button>
          <button type="button" className="nx-ghost" onClick={() => void show('task', 'задача')}>Задача</button>
          <button type="button" className="nx-ghost" onClick={() => void show('event', 'событие')}>Событие</button>
        </div>
      </Row>
    </Group>
  );
}

export default function SettingsTab() {
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState('');
  const [proxy, setProxy] = useState('');
  const [chatId, setChatId] = useState('');

  useEffect(() => {
    void loadSystemSettings().then((s) => { setSettings(s); setChatId(s.telegramChatId); }).catch(() => setFailed(true));
  }, []);

  if (failed) return <p className="nx-error" role="alert">Настройки не загрузились — нет связи или прав администратора.</p>;
  if (!settings) return <div className="nx-group" aria-busy="true"><div className="nx-row"><span className="nx-skel nx-skel-line" style={{ width: '60%' }} /></div></div>;

  const apply = async (patch: Parameters<typeof saveSystemSettings>[0], done = 'Сохранено') => {
    setBusy(true);
    try { setSettings(await saveSystemSettings(patch)); showToast(done, 'success'); return true; }
    catch (e) { showToast(e instanceof Error ? e.message : 'Не сохранилось', 'error'); return false; }
    finally { setBusy(false); }
  };

  const saveTelegram = async () => {
    const patch: Parameters<typeof saveSystemSettings>[0] = { telegramChatId: chatId };
    if (token.trim()) patch.telegramBotToken = token.trim();
    if (proxy.trim()) patch.telegramProxy = proxy.trim();
    if (await apply(patch)) { setToken(''); setProxy(''); }
  };

  const check = async () => {
    try { const r = await testTelegram(); showToast(r.ok ? 'Сообщение отправлено' : 'Telegram не принял сообщение', r.ok ? 'success' : 'error'); }
    catch (e) { showToast(e instanceof Error ? e.message : 'Не отправилось', 'error'); }
  };

  const secret = (label: string, id: string, value: string, set: (v: string) => void, current: string, isSet: boolean, key: 'telegramBotToken' | 'telegramProxy') => (
    <Row label={label} hint={isSet ? `Задан: ${current}` : 'Не задан'} htmlFor={id}>
      <span className="nx-inline">
        <span className="nx-field" data-variant="filter">
          <input id={id} type="password" value={value} placeholder={isSet ? 'Новое значение' : ''} autoComplete="off" spellCheck={false} onChange={(e) => set(e.target.value)} />
        </span>
        {isSet && <button type="button" className="nx-ghost" disabled={busy} onClick={() => void apply({ [key]: null }, 'Стёрто')}>Стереть</button>}
      </span>
    </Row>
  );

  return (
    <>
      <Group title="Telegram" note="Секреты наружу не отдаются: видна только маска. Пустое поле — не менять.">
        {secret('Токен бота', 'nad-tg-token', token, setToken, settings.telegramBotToken, settings.telegramBotTokenSet, 'telegramBotToken')}
        <Row label="Chat ID" htmlFor="nad-tg-chat">
          <span className="nx-field" data-variant="filter"><input id="nad-tg-chat" value={chatId} spellCheck={false} autoComplete="off" onChange={(e) => setChatId(e.target.value)} /></span>
        </Row>
        {secret('Прокси', 'nad-tg-proxy', proxy, setProxy, settings.telegramProxy, settings.telegramProxySet, 'telegramProxy')}
        <Row label="Уведомления в Telegram"><Switch checked={settings.telegramNotifications} label="Уведомления в Telegram" onChange={(v) => void apply({ telegramNotifications: v })} /></Row>
        <Row label="Сообщать об ошибках"><Switch checked={settings.errorNotification} label="Сообщать об ошибках" onChange={(v) => void apply({ errorNotification: v })} /></Row>
      </Group>
      <div className="nx-actions">
        <button type="button" className="nx-ghost" disabled={busy || !settings.telegramBotTokenSet} onClick={() => void check()}>Отправить пробное</button>
        <button type="button" className="nx-primary" disabled={busy} onClick={() => void saveTelegram()}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
      </div>
      <EmailRules />
      <DesktopNotificationTest />
    </>
  );
}
