import { useState, type FormEvent } from 'react';
import { Mail, Pencil, Plus, Trash2 } from 'lucide-react';
import { askConfirm, Sheet } from '@/shared/ui/overlay';
import { Switch } from '@/shared/ui/controls';
import { showToast } from '@/shared/ui/Toast';
import { removeAccount, saveAccount, syncFolder, useMail, type Account, type AccountForm } from './api';

/** Почтовые сервисы: хосты подставляются по домену адреса. */
const PRESETS: { match: RegExp; imapHost: string; smtpHost: string; smtpPort: number; hint?: string }[] = [
  { match: /@(yandex\.(ru|com)|ya\.ru)$/i, imapHost: 'imap.yandex.ru', smtpHost: 'smtp.yandex.ru', smtpPort: 465, hint: 'Для Яндекса нужен пароль приложения (Почта → Безопасность).' },
  { match: /@(mail|inbox|list|bk)\.ru$/i, imapHost: 'imap.mail.ru', smtpHost: 'smtp.mail.ru', smtpPort: 465, hint: 'Для Mail.ru нужен пароль для внешнего приложения.' },
  { match: /@gmail\.com$/i, imapHost: 'imap.gmail.com', smtpHost: 'smtp.gmail.com', smtpPort: 465, hint: 'Для Gmail нужен пароль приложения (двухфакторная защита обязательна).' },
  { match: /@(outlook|hotmail|live)\.[a-z.]+$/i, imapHost: 'outlook.office365.com', smtpHost: 'smtp.office365.com', smtpPort: 587 },
];

const EMPTY: AccountForm = { name: '', email: '', username: '', password: '', imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 465, useSsl: true, signature: '' };

function AccountForm({ account, onDone, onCancel }: { account?: Account; onDone: () => void; onCancel: () => void }) {
  const [form, setForm] = useState<AccountForm>(() => account ? {
    ...EMPTY, name: account.name, email: account.email, username: account.username || account.email,
    imapHost: account.imapHost || '', imapPort: account.imapPort || 993, smtpHost: account.smtpHost || '', smtpPort: account.smtpPort || 465,
    useSsl: account.useSsl !== false, signature: account.signature || '',
  } : EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preset = PRESETS.find((p) => p.match.test(form.email));
  const set = <K extends keyof AccountForm>(k: K, v: AccountForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const onEmail = (email: string) => setForm((f) => {
    const p = PRESETS.find((x) => x.match.test(email));
    const next = { ...f, email, username: !f.username || f.username === f.email ? email : f.username };
    if (p && !account) Object.assign(next, { imapHost: p.imapHost, smtpHost: p.smtpHost, smtpPort: p.smtpPort, imapPort: 993 });
    return next;
  });

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!form.email.includes('@')) { setError('Укажите адрес почты'); return; }
    if (!account && !form.password) { setError('Нужен пароль'); return; }
    if (!form.imapHost || !form.smtpHost) { setError('Укажите серверы входящей и исходящей почты'); return; }
    setBusy(true); setError(null);
    try {
      const saved = await saveAccount(account ? String(account.id) : null, { ...form, name: form.name.trim() || form.email, username: form.username.trim() || form.email });
      showToast(account ? 'Ящик сохранён' : 'Ящик подключён — загружаю письма', 'success');
      if (!account) void syncFolder('INBOX');
      void saved;
      onDone();
    } catch (err) {
      const m = err instanceof Error ? err.message : '';
      setError(/^\d+$/.test(m) ? `Не сохранилось (${m})` : m || 'Не сохранилось');
      setBusy(false);
    }
  };

  const text = (k: 'name' | 'username' | 'imapHost' | 'smtpHost', label: string, ph?: string) => (
    <label className="nx-label">{label}
      <span className="nx-field"><input value={form[k]} placeholder={ph} onChange={(e) => set(k, e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} /></span>
    </label>
  );

  return (
    <form className="nx-form" onSubmit={submit} noValidate>
      <label className="nx-label">Адрес почты
        <span className="nx-field"><input type="email" value={form.email} onChange={(e) => onEmail(e.target.value)} placeholder="name@company.ru" autoComplete="off" autoCapitalize="none" spellCheck={false} autoFocus /></span>
      </label>
      <label className="nx-label">{account ? 'Новый пароль (пусто — не менять)' : 'Пароль'}
        <span className="nx-field"><input type="password" value={form.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" /></span>
      </label>
      {preset?.hint && <p className="nx-note">{preset.hint}</p>}
      {text('name', 'Название ящика', 'Рабочая почта')}
      <div className="nx-form-grid">
        {text('imapHost', 'Входящая почта (IMAP)', 'imap.example.ru')}
        <label className="nx-label">Порт
          <span className="nx-field"><input type="number" value={form.imapPort} onChange={(e) => set('imapPort', Number(e.target.value) || 993)} /></span>
        </label>
        {text('smtpHost', 'Исходящая почта (SMTP)', 'smtp.example.ru')}
        <label className="nx-label">Порт
          <span className="nx-field"><input type="number" value={form.smtpPort} onChange={(e) => set('smtpPort', Number(e.target.value) || 465)} /></span>
        </label>
      </div>
      {text('username', 'Логин на почтовом сервере', 'обычно совпадает с адресом')}
      <div className="nx-group"><div className="nx-row">
        <span className="nx-row-text"><span className="nx-row-label">Защищённое соединение (SSL)</span></span>
        <Switch checked={form.useSsl} onChange={(v) => set('useSsl', v)} label="SSL" />
      </div></div>
      <label className="nx-label">Подпись в письмах
        <span className="nx-field"><textarea rows={3} value={form.signature} onChange={(e) => set('signature', e.target.value)} /></span>
      </label>
      {error && <p className="nx-error" role="alert">{error}</p>}
      <div className="nx-dialog-actions">
        <button type="button" className="nx-ghost" onClick={onCancel}>Отмена</button>
        <button type="submit" className="nx-primary" disabled={busy}>{busy ? 'Проверяем…' : account ? 'Сохранить' : 'Подключить'}</button>
      </div>
    </form>
  );
}

/** Ящики: список с правкой и удалением, подключение нового. */
export default function AccountSheet({ onClose, startAdding }: { onClose: () => void; startAdding?: boolean }) {
  const accounts = useMail((s) => s.accounts);
  const [mode, setMode] = useState<{ kind: 'list' } | { kind: 'form'; account?: Account }>(startAdding || !accounts.length ? { kind: 'form' } : { kind: 'list' });

  const del = async (a: Account) => {
    const ok = await askConfirm({ title: `Отключить ${a.email}?`, text: 'Письма из Шара исчезнут, на почтовом сервере они останутся.', confirm: 'Отключить', tone: 'danger' });
    if (!ok) return;
    try { await removeAccount(String(a.id)); showToast('Ящик отключён', 'success'); } catch { showToast('Не получилось отключить ящик', 'error'); }
  };

  return (
    <Sheet title={mode.kind === 'form' ? (mode.account ? 'Настройки ящика' : 'Подключить ящик') : 'Почтовые ящики'} onClose={onClose}>
      {mode.kind === 'form' ? (
        <AccountForm account={mode.account} onCancel={() => (accounts.length ? setMode({ kind: 'list' }) : onClose())} onDone={() => (accounts.length > 1 || mode.account ? setMode({ kind: 'list' }) : onClose())} />
      ) : (
        <div className="nx-form">
          <div className="nx-group">
            {accounts.map((a) => (
              <div key={a.id} className="nx-row">
                <Mail size={16} aria-hidden="true" />
                <span className="nx-row-text"><span className="nx-row-label">{a.email}</span><span className="nx-row-hint">{a.name !== a.email ? a.name : a.imapHost}</span></span>
                <button type="button" className="nx-icon-btn" aria-label={`Настроить ${a.email}`} onClick={() => setMode({ kind: 'form', account: a })}><Pencil size={15} /></button>
                <button type="button" className="nx-icon-btn" aria-label={`Отключить ${a.email}`} onClick={() => void del(a)}><Trash2 size={15} /></button>
              </div>
            ))}
          </div>
          <button type="button" className="nx-ghost" onClick={() => setMode({ kind: 'form' })}><Plus size={14} /> Подключить ещё ящик</button>
        </div>
      )}
    </Sheet>
  );
}
