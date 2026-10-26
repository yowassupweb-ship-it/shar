import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { AlertCircle, ChevronLeft, History, MessageCircle, MessagesSquare, Plug, Plus, RefreshCw, Settings2, Trash2 } from 'lucide-react';
import { chatTitle, isGroupChat, useChatStore } from '@/features/chat';
import { paths } from '@/shared/navigation/routes';
import { askConfirm, Sheet } from '@/shared/ui/overlay';
import { Spinner } from '@/shared/ui/Spinner';
import { showToast } from '@/shared/ui/Toast';
import {
  addAccount, checkAccount, importStatus, listAccounts, removeAccount, routeSource, setDefaultChat, startImport,
  type ImportState, type Platform, type SocialAccount,
} from './api';
import DialogsTab from './DialogsTab';
import NotifySettings from './NotifySettings';
import './social.css';

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

/**
 * Модуль «Соцсети»: переписка с клиентами из ВКонтакте и MAX — отдельно от чатов Шара. Каждый клиент —
 * свой диалог со значком площадки, все площадки в одном списке. Две вкладки: «Диалоги» (личные и
 * беседы) и «Комментарии» (автор под постом). Подключения сообществ и ботов — за шестерёнкой.
 */
export default function SocialScreen() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'accounts' ? 'accounts' : params.get('tab') === 'comments' ? 'comments' : 'dialogs';
  const go = (next: Record<string, string>) => setParams(next, { replace: true });
  return (
    <div className="nx-page nsc-page" data-view={view}>
      <div className="nx-page-inner" data-wide="">
        <header className="nx-page-head">
          <button type="button" className="nx-icon-btn nx-page-back" aria-label={view === 'accounts' ? 'Назад к диалогам' : 'Назад в «Ещё»'}
            onClick={() => (view === 'accounts' ? go({}) : navigate(paths.more))}>
            <ChevronLeft size={20} />
          </button>
          <h1>{view === 'accounts' ? 'Настройки' : 'Соцсети'}</h1>
          {view !== 'accounts' && (
            <span className="nx-page-tools">
              <nav className="nx-segment" aria-label="Вкладки">
                <button type="button" aria-pressed={view === 'dialogs'} onClick={() => go({})}><MessagesSquare size={13} aria-hidden="true" /> Диалоги</button>
                <button type="button" aria-pressed={view === 'comments'} onClick={() => go({ tab: 'comments' })}><MessageCircle size={13} aria-hidden="true" /> Комментарии</button>
              </nav>
              <button type="button" className="nx-icon-btn" onClick={() => go({ view: 'accounts' })} aria-label="Настройки" title="Уведомления и подключения ВКонтакте и MAX"><Settings2 size={17} /></button>
            </span>
          )}
        </header>
        {view === 'accounts' ? <div className="nx-scroll-y nsc-accounts-wrap"><div className="nsc-accounts"><NotifySettings /><AccountsTab /></div></div> : <DialogsTab key={view} mode={view} />}
      </div>
    </div>
  );
}

function useChatOptions() {
  const chats = useChatStore((s) => s.chats);
  const users = useChatStore((s) => s.users);
  const me = useChatStore((s) => s.me);
  return useMemo(() => Object.values(chats)
    .filter((c) => isGroupChat(c))
    .map((c) => ({ id: String(c.id), title: chatTitle(c, me, users) }))
    .sort((a, b) => a.title.localeCompare(b.title, 'ru')), [chats, me, users]);
}

function ChatSelect({ value, fallbackTitle, empty, onChange }: { value: string | null; fallbackTitle?: string; empty: string; onChange: (id: string | null) => void }) {
  const options = useChatOptions();
  const missing = value && !options.some((o) => o.id === value);
  return (
    <select className="nx-field" value={value || ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{empty}</option>
      {missing && <option value={value!}>{fallbackTitle || 'Чат, в котором вас нет'}</option>}
      {options.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
    </select>
  );
}

function AccountsTab() {
  const [accounts, setAccounts] = useState<SocialAccount[] | null>(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    listAccounts().then((d) => { setAccounts(d.accounts); setError(''); }).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const replace = (a: SocialAccount) => setAccounts((list) => (list || []).map((x) => (x.id === a.id ? a : x)));
  const run = (id: string, p: Promise<{ account: SocialAccount }>) => {
    setBusy(id);
    p.then((r) => replace(r.account)).catch((e: Error) => showToast(e.message, 'error')).finally(() => setBusy(null));
  };
  const remove = async (a: SocialAccount) => {
    if (!(await askConfirm({ title: `Отключить ${a.title}?`, text: 'Сообщения и комментарии перестанут приходить в Шар. Карточки в чатах останутся.', confirm: 'Отключить', tone: 'danger' }))) return;
    removeAccount(a.id).then(load).catch((e: Error) => showToast(e.message, 'error'));
  };

  if (error) return <div className="nx-state" data-tone="danger" role="alert"><AlertCircle size={24} aria-hidden="true" /><p>{error}</p></div>;
  if (!accounts) return <div className="nx-state"><Spinner size={22} label="Загружаю" /></div>;
  return (
    <div className="nsc-accounts">
      <div><button type="button" className="nx-primary" onClick={() => setAdding(true)}><Plus size={15} aria-hidden="true" /> Подключить</button></div>
      {!accounts.length && <div className="nx-state"><Plug size={26} aria-hidden="true" /><p>Подключений пока нет. Подключите сообщество ВКонтакте или бота MAX — сообщения и комментарии клиентов начнут приходить в чаты Шара.</p></div>}
      {accounts.map((a) => (
        <section key={a.id} className="nsc-account" aria-label={a.title}>
          <div className="nsc-account-head">
            <h3>{a.title}</h3>
            <span className="nsc-muted">{a.platformLabel}{a.botUsername ? ` · @${a.botUsername}` : ''}</span>
            {a.status.ok === false ? <span className="nsc-badge" data-bad="" title={a.status.error}>Нет связи</span> : <span className="nsc-badge">Подключён</span>}
            <span className="nsc-tools">
              <button type="button" className="nx-icon-btn" disabled={busy === a.id} onClick={() => run(a.id, checkAccount(a.id))} aria-label="Проверить связь" title="Проверить связь и переподписаться"><RefreshCw size={15} /></button>
              <button type="button" className="nx-icon-btn" onClick={() => void remove(a)} aria-label="Отключить" title="Отключить"><Trash2 size={15} /></button>
            </span>
          </div>
          {a.status.ok === false && a.status.error && <p className="nsc-muted" role="alert">{a.status.error}</p>}
          {a.platform === 'vk' && <HistoryImport accountId={a.id} />}
          <div className="nsc-route">
            <div><b>Дублировать в чат Шара</b><span className="nsc-muted">Необязательно: уведомление со ссылкой на диалог в выбранный чат. Переписка всё равно в этом модуле.</span></div>
            <ChatSelect value={a.defaultChat?.id || null} fallbackTitle={a.defaultChat?.title} empty="Не дублировать" onChange={(id) => run(a.id, setDefaultChat(a.id, id))} />
          </div>
          {a.sources.length === 0 ? (
            <p className="nsc-muted">Источники появятся сами с первым сообщением или комментарием: личные сообщения, беседы, стена, фото, товары.</p>
          ) : a.sources.map((s) => (
            <div key={s.extChatId} className="nsc-route">
              <div><b>{s.title || 'Без названия'}</b><span className="nsc-muted">{s.typeLabel}{s.lastSeen ? ` · последнее ${fmt(s.lastSeen)}` : ''}</span></div>
              <ChatSelect value={s.chat?.id || null} fallbackTitle={s.chat?.title} empty="Как у подключения" onChange={(id) => run(a.id, routeSource(a.id, s.extChatId, id))} />
            </div>
          ))}
        </section>
      ))}
      {adding && <AddSheet onClose={() => setAdding(false)} onAdded={(a) => { setAccounts((l) => [...(l || []), a]); setAdding(false); }} />}
    </div>
  );
}

/** Подгрузка старой переписки сообщества: идёт в фоне, пока экран открыт — показываем, сколько уже загружено. */
function HistoryImport({ accountId }: { accountId: string }) {
  const [st, setSt] = useState<ImportState | null>(null);
  useEffect(() => { importStatus(accountId).then((r) => setSt(r.import)).catch(() => undefined); }, [accountId]);
  useEffect(() => {
    if (st?.state !== 'running') return undefined;
    const t = window.setInterval(() => { importStatus(accountId).then((r) => setSt(r.import)).catch(() => undefined); }, 2000);
    return () => window.clearInterval(t);
  }, [accountId, st?.state]);
  const run = () => startImport(accountId).then((r) => setSt(r.import)).catch((e: Error) => showToast(e.message, 'error'));
  const running = st?.state === 'running';
  return (
    <div className="nsc-route">
      <div>
        <b>История переписки</b>
        <span className="nsc-muted">
          {running ? `Загружаю… диалогов ${st!.dialogs}, сообщений ${st!.messages}`
            : st?.state === 'done' ? `Готово: диалогов ${st.dialogs}, новых сообщений ${st.messages}`
            : st?.state === 'error' ? st.error
            : 'Старые личные диалоги и беседы сообщества. Комментарии ВКонтакте задним числом не отдаёт — они приходят по мере появления.'}
        </span>
      </div>
      <button type="button" className="nx-ghost" disabled={running} onClick={() => void run()}>
        {running ? <Spinner size={14} label="Загружаю" /> : <History size={14} aria-hidden="true" />} {running ? 'Идёт…' : 'Подгрузить историю'}
      </button>
    </div>
  );
}

function AddSheet({ onClose, onAdded }: { onClose: () => void; onAdded: (a: SocialAccount) => void }) {
  const [platform, setPlatform] = useState<Platform>('vk');
  const [token, setToken] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const save = () => {
    setBusy(true);
    addAccount(platform, token.trim(), title.trim())
      .then((r) => { showToast('Подключено', 'success'); onAdded(r.account); })
      .catch((e: Error) => { showToast(e.message, 'error'); setBusy(false); });
  };
  return (
    <Sheet
      title="Подключить ВКонтакте или MAX"
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          <button type="button" className="nx-ghost" onClick={onClose}>Отмена</button>
          <button type="button" className="nx-primary" disabled={busy || !token.trim()} onClick={save}>{busy ? 'Проверяю…' : 'Подключить'}</button>
        </>
      )}
    >
      <div className="nsc-add">
        <div className="nx-segment" role="group" aria-label="Мессенджер">
          <button type="button" aria-pressed={platform === 'vk'} onClick={() => setPlatform('vk')}>ВКонтакте</button>
          <button type="button" aria-pressed={platform === 'max'} onClick={() => setPlatform('max')}>MAX</button>
        </div>
        {platform === 'vk' ? (
          <ol className="nsc-steps">
            <li>В сообществе: Управление → Сообщения — включите сообщения сообщества.</li>
            <li>Управление → Работа с API → Ключи доступа → Создать ключ с правами «Управление сообществом», «Сообщения сообщества», «Стена».</li>
            <li>Вставьте ключ ниже — адрес для событий ВКонтакте Шар настроит сам.</li>
          </ol>
        ) : (
          <ol className="nsc-steps">
            <li>На business.max.ru создайте бота организации и скопируйте токен.</li>
            <li>Добавьте бота в чаты и каналы, откуда нужны сообщения.</li>
          </ol>
        )}
        <label className="nx-label">{platform === 'vk' ? 'Ключ доступа сообщества' : 'Токен бота'}
          <input className="nx-field" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} placeholder={platform === 'vk' ? 'vk1.a.…' : 'Токен из кабинета MAX'} />
        </label>
        <label className="nx-label">Название в Шаре (необязательно)
          <input className="nx-field" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="По умолчанию — название сообщества" />
        </label>
      </div>
    </Sheet>
  );
}
