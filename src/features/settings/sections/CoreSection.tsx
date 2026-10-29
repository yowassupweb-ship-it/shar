import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BookOpen, Brain, Building2, Check, Copy, ExternalLink, Gauge, KeyRound, Loader2, LogIn, Plug, Server, ShieldAlert, ShieldCheck, ShieldQuestion,
  Sparkles, Trash2, Unplug, X,
} from 'lucide-react';
import { coreApi, formatTokens, type CoreAccount, type CoreAccounts, type CoreMemory, type ProviderId } from '@/features/core';
import { realtime } from '@/shared/realtime/realtime';
import { askConfirm } from '@/shared/ui/overlay';
import { Select } from '@/shared/ui/Select';
import { Switch } from '@/shared/ui/controls';
import { showToast } from '@/shared/ui/Toast';

/**
 * Настройки → Ядро: свои агенты, режим разрешений, расход и что агент знает о человеке.
 *
 * Один человек — один Gemini, один Claude, один GPT. Gemini — по ключу Google (вставил — работает), Claude и GPT —
 * подписка человека: вход идёт на ноде компании, здесь только ссылка и код. Всё обновляется живыми событиями.
 */

const BRAND: Record<ProviderId, { mark: string; pitch: string }> = {
  gemini: { mark: 'G', pitch: 'Ключ Google AI Studio или Google Cloud. Платите Google по расходу; у Flash-Lite есть бесплатный уровень.' },
  claude: { mark: 'C', pitch: 'Ваша подписка Claude (Pro или Max). Вход — один раз, по ссылке; дальше работает само.' },
  codex: { mark: 'O', pitch: 'Ваша подписка ChatGPT (Plus, Pro, Business). Вход — по ссылке и коду.' },
};

const MODE_ICON = { auto: ShieldAlert, careful: ShieldCheck, ask: ShieldQuestion } as const;

const fail = (cause: unknown) => showToast(cause instanceof Error ? cause.message : 'Не получилось', 'error');

async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); showToast('Скопировано', 'success'); } catch { showToast('Не удалось скопировать', 'error'); }
}

function Mark({ provider, size = 44 }: { provider: ProviderId; size?: number }) {
  const b = BRAND[provider];
  return (
    <span className="nst-core-mark" style={{ width: size, height: size }} aria-hidden="true">
      {b.mark}
    </span>
  );
}

function StatusPill({ account }: { account: CoreAccount }) {
  if (account.state === 'ready') {
    return <span className="nst-core-pill" data-tone={account.how === 'login' && !account.nodeOnline ? 'warn' : 'ok'}>
      {account.how === 'login' && !account.nodeOnline ? 'Нода не на связи' : 'Подключён'}
    </span>;
  }
  if (account.state === 'pending' || account.login.state) return <span className="nst-core-pill" data-tone="busy"><Loader2 size={11} className="nx-spin" aria-hidden="true" /> Вход…</span>;
  return <span className="nst-core-pill">Не подключён</span>;
}

/** Ход входа в подписку: ссылка → (код Codex) → у Claude — вставить код со страницы. */
function LoginFlow({ account, onChange }: { account: CoreAccount; onChange: (next: CoreAccounts) => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const login = account.login;
  const send = async () => {
    if (!code.trim()) return;
    setBusy(true);
    try { onChange(await coreApi.loginCode(account.provider, code.trim())); setCode(''); } catch (cause) { fail(cause); } finally { setBusy(false); }
  };
  return (
    <div className="nst-core-flow" aria-live="polite">
      <ol>
        <li data-done={login.url ? '' : undefined}>
          <b>Нода готовит вход</b>
          {!login.url && <span className="nst-core-wait"><Loader2 size={13} className="nx-spin" aria-hidden="true" /> {login.message || 'секунду…'}</span>}
        </li>
        {login.url && (
          <li>
            <b>Откройте страницу входа и подтвердите</b>
            <span className="nst-core-flow-row">
              <a className="nx-primary" href={login.url} target="_blank" rel="noreferrer noopener"><ExternalLink size={14} aria-hidden="true" /> Открыть вход {account.label}</a>
              <button type="button" className="nx-icon-btn" onClick={() => void copy(login.url!)} aria-label="Скопировать ссылку" title="Скопировать ссылку"><Copy size={15} /></button>
            </span>
            {login.code && (
              <span className="nst-core-code" title="Введите этот код на странице входа">
                {login.code}
                <button type="button" className="nx-icon-btn" onClick={() => void copy(login.code!)} aria-label="Скопировать код"><Copy size={14} /></button>
              </span>
            )}
          </li>
        )}
        {login.url && login.needsCode && (
          <li>
            <b>Вставьте код, который показала страница</b>
            <form className="nst-core-flow-row" onSubmit={(e) => { e.preventDefault(); void send(); }}>
              <label className="nx-field nst-core-input">
                <span className="nx-sr">Код со страницы входа</span>
                <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Код со страницы" autoComplete="off" spellCheck={false} />
              </label>
              <button type="submit" className="nx-primary" disabled={!code.trim() || busy}>{busy ? <Loader2 size={14} className="nx-spin" /> : <Check size={14} />} Готово</button>
            </form>
          </li>
        )}
        {login.state === 'verifying' && <li><b>Проверяю вход</b><span className="nst-core-wait"><Loader2 size={13} className="nx-spin" aria-hidden="true" /> {login.message}</span></li>}
      </ol>
      <button type="button" className="nx-ghost" onClick={() => coreApi.cancelLogin(account.provider).then(onChange).catch(fail)}><X size={14} aria-hidden="true" /> Отменить вход</button>
    </div>
  );
}

function AgentCard({ account, nodeOnline, onChange }: { account: CoreAccount; nodeOnline: boolean; onChange: (next: CoreAccounts) => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = account.state === 'ready';
  const logging = Boolean(account.login.state);

  const run = async (fn: () => Promise<CoreAccounts>) => {
    setBusy(true);
    try { onChange(await fn()); } catch (cause) { fail(cause); } finally { setBusy(false); }
  };
  const saveKey = async () => {
    if (key.trim().length < 20) return;
    await run(() => coreApi.setGeminiKey(key.trim()));
    setKey('');
  };
  const disconnect = async () => {
    const ok = await askConfirm({
      title: `Отключить ${account.label}?`,
      text: account.how === 'key' ? 'Ключ сотрётся из Шара. Агент перестанет отвечать, пока вы не вставите ключ снова.' : 'На ноде будет выполнен выход из вашей подписки.',
      confirm: 'Отключить', tone: 'danger',
    });
    if (ok) await run(() => coreApi.disconnect(account.provider));
  };

  return (
    <article className="nst-core-card" data-state={ready ? 'ready' : logging ? 'busy' : 'off'}>
      <header className="nst-core-card-head">
        <Mark provider={account.provider} />
        <span className="nst-core-card-title">
          <b>{account.label}</b>
          <span>{account.vendor}</span>
        </span>
        <StatusPill account={account} />
      </header>

      {ready ? (
        <div className="nst-core-card-body">
          <p className="nst-core-who">{account.how === 'key' ? <KeyRound size={13} aria-hidden="true" /> : <LogIn size={13} aria-hidden="true" />} {account.account || 'вход выполнен'}</p>
          {account.models.length > 1 && (
            <Select className="nst-core-model" label={`Модель ${account.label} по умолчанию`} value={account.model}
              onChange={(model) => void run(() => coreApi.setModel(account.provider, model))}
              groups={[{ options: account.models.map((m) => ({ value: m.id, label: m.label })) }]} />
          )}
        </div>
      ) : logging ? (
        <LoginFlow account={account} onChange={onChange} />
      ) : (
        <div className="nst-core-card-body">
          <p className="nst-core-pitch">{BRAND[account.provider].pitch}</p>
          {account.error && <p className="nst-core-error" role="alert">{account.error}</p>}
        </div>
      )}

      <footer className="nst-core-card-foot">
        {account.how === 'key' && !ready && (
          <form className="nst-core-key" onSubmit={(e) => { e.preventDefault(); void saveKey(); }}>
            <label className="nx-field nst-core-input">
              <KeyRound size={15} aria-hidden="true" />
              <span className="nx-sr">Ключ Google для Gemini</span>
              <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Вставьте ключ AIza…" autoComplete="off" spellCheck={false} />
            </label>
            <button type="submit" className="nx-primary" disabled={key.trim().length < 20 || busy}>
              {busy ? <Loader2 size={14} className="nx-spin" aria-hidden="true" /> : <Plug size={14} aria-hidden="true" />} Подключить
            </button>
          </form>
        )}
        {account.how === 'key' && !ready && (
          <a className="nst-core-help" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer noopener">Где взять ключ — Google AI Studio <ExternalLink size={11} aria-hidden="true" /></a>
        )}
        {account.how === 'login' && !ready && !logging && (
          <button type="button" className="nx-primary" disabled={busy || !nodeOnline} onClick={() => void run(() => coreApi.login(account.provider))}
            title={nodeOnline ? undefined : 'Нода агентов не на связи — её запускает администратор'}>
            {busy ? <Loader2 size={14} className="nx-spin" aria-hidden="true" /> : <LogIn size={14} aria-hidden="true" />} Войти в {account.label}
          </button>
        )}
        {ready && (
          <button type="button" className="nx-ghost nst-core-off" disabled={busy} onClick={() => void disconnect()}><Unplug size={14} aria-hidden="true" /> Отключить</button>
        )}
      </footer>
    </article>
  );
}

function Usage({ data }: { data: CoreAccounts }) {
  const rows = data.usage;
  const max = Math.max(1, ...rows.map((r) => r.inputTokens + r.outputTokens));
  if (!rows.length) return <p className="nx-note">За 30 дней агенты ещё не работали.</p>;
  return (
    <div className="nst-core-usage">
      {rows.map((r) => {
        const total = r.inputTokens + r.outputTokens;
        const label = data.accounts.find((a) => a.provider === r.provider)?.label || r.provider;
        return (
          <div key={r.provider} className="nst-core-usage-row">
            <Mark provider={r.provider} size={28} />
            <span className="nst-core-usage-main">
              <span className="nst-core-usage-top"><b>{label}</b><span>{r.runs} {r.runs % 10 === 1 && r.runs % 100 !== 11 ? 'ответ' : 'ответов'}</span></span>
              <i className="nst-core-bar"><i style={{ width: `${Math.max(2, Math.round((total / max) * 100))}%`, }} /></i>
              <span className="nst-core-usage-sub">
                {formatTokens(total)} токенов · из кэша {formatTokens(r.cachedTokens)}
                {r.provider === 'gemini' ? (r.costUsd ? ` · ≈ $${r.costUsd.toFixed(2)}` : ' · цену считает Google') : ' · по подписке'}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function MemoryBlock() {
  const [memory, setMemory] = useState<CoreMemory | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [tab, setTab] = useState<'profile' | 'notes' | 'skills'>('profile');
  const load = useCallback(() => coreApi.memory().then(setMemory).catch(fail), []);
  useEffect(() => { void load(); }, [load]);
  if (!memory) return <div className="nx-group" aria-busy="true"><div className="nx-row"><span className="nx-skel nx-skel-line" style={{ width: '50%' }} /></div></div>;

  const saveProfile = async () => {
    if (draft === null) return;
    try { await coreApi.saveProfile(draft); setDraft(null); await load(); showToast('Профиль сохранён', 'success'); } catch (cause) { fail(cause); }
  };
  const mine = memory.notes.filter((n) => !n.shared);
  const company = memory.notes.filter((n) => n.shared);

  return (
    <div className="nst-core-memory">
      <nav className="nx-segment" aria-label="Что знает агент">
        <button type="button" aria-pressed={tab === 'profile'} onClick={() => setTab('profile')}><Brain size={13} aria-hidden="true" /> Обо мне</button>
        <button type="button" aria-pressed={tab === 'notes'} onClick={() => setTab('notes')}><BookOpen size={13} aria-hidden="true" /> Память · {memory.notes.length}</button>
        <button type="button" aria-pressed={tab === 'skills'} onClick={() => setTab('skills')}><Sparkles size={13} aria-hidden="true" /> Навыки · {memory.skills.length}</button>
      </nav>

      {tab === 'profile' && (
        <div className="nst-core-profile">
          <p className="nx-note">Агент ведёт это сам: как вы работаете, что поправляли за ним, ваши «всегда» и «никогда». Можно дописать или поправить — он прочитает в начале каждого ответа.</p>
          <textarea className="nst-core-textarea" value={draft ?? memory.profile} onChange={(e) => setDraft(e.target.value)} rows={9}
            placeholder={'## Кто\n- Менеджер по турам в Карелию\n\n## Стиль\n- Коротко, таблицами'} spellCheck />
          {draft !== null && draft !== memory.profile && (
            <div className="nx-actions">
              <button type="button" className="nx-ghost" onClick={() => setDraft(null)}>Отменить</button>
              <button type="button" className="nx-primary" onClick={() => void saveProfile()}><Check size={14} aria-hidden="true" /> Сохранить</button>
            </div>
          )}
        </div>
      )}

      {tab === 'notes' && (
        <div className="nst-core-notes">
          {!memory.notes.length && <p className="nx-note">Пока пусто. Агент запоминает решения, договорённости и «где что лежит» — сам или когда вы попросите.</p>}
          {[{ title: 'Моя', list: mine, icon: Brain }, { title: 'Общая для компании', list: company, icon: Building2 }].filter((g) => g.list.length).map((g) => (
            <section key={g.title} className="nx-block">
              <h3 className="nx-block-title"><g.icon size={12} aria-hidden="true" /> {g.title}</h3>
              <div className="nx-group">
                {g.list.map((n) => (
                  <div key={n.id} className="nx-row nst-core-note">
                    <span className="nx-row-text">
                      <span className="nx-row-label">{n.text}</span>
                      <span className="nx-row-hint">{n.tags.map((t) => `#${t}`).join(' ')} {n.by ? `· ${n.by}` : ''} · {new Date(n.at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}</span>
                    </span>
                    {(n.mine || memory.canModerate) && (
                      <button type="button" className="nx-icon-btn" aria-label="Забыть" title="Забыть"
                        onClick={() => coreApi.forgetNote(n.id).then(load).catch(fail)}><Trash2 size={15} /></button>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {tab === 'skills' && (
        <div className="nst-core-skills">
          {!memory.skills.length && <p className="nx-note">Навыков пока нет. Когда задача повторяется или вы объясняете, как её делать, агент записывает себе навык — и дальше делает так же.</p>}
          {!!memory.skills.length && (
            <div className="nx-group">
              {memory.skills.map((s) => (
                <div key={`${s.shared}:${s.name}`} className="nx-row">
                  <span className="nst-core-skill-icon" data-shared={s.shared || undefined} aria-hidden="true">{s.shared ? <Building2 size={15} /> : <Sparkles size={15} />}</span>
                  <span className="nx-row-text">
                    <span className="nx-row-label">{s.name}{s.shared && <span className="nst-badge">общий</span>}</span>
                    <span className="nx-row-hint">{s.description}{s.uses ? ` · применён ${s.uses} раз` : ''}</span>
                  </span>
                  {(!s.shared || s.mine || memory.canModerate) && (
                    <span className="nx-row-actions">
                      <Switch checked={s.enabled} label={`Навык ${s.name} включён`}
                        onChange={(on) => coreApi.saveSkill(s.name, { enabled: on, shared: s.shared }).then(load).catch(fail)} />
                      <button type="button" className="nx-icon-btn" aria-label={`Удалить навык ${s.name}`} title="Удалить"
                        onClick={() => void askConfirm({ title: `Удалить навык «${s.name}»?`, confirm: 'Удалить', tone: 'danger' })
                          .then((ok) => { if (ok) coreApi.deleteSkill(s.name, s.shared).then(load).catch(fail); })}><Trash2 size={15} /></button>
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function CoreSection() {
  const [data, setData] = useState<CoreAccounts | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => coreApi.accounts().then((d) => { setData(d); setError(''); }).catch((e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить')), []);
  useEffect(() => { void load(); }, [load]);
  // Ход входа на ноде и готовность — живыми событиями, без опроса.
  useEffect(() => realtime.subscribe((event) => {
    const e = event as { type?: string; account?: CoreAccount };
    if (e.type === 'core_account' && e.account) {
      setData((cur) => (cur ? { ...cur, accounts: cur.accounts.map((a) => (a.provider === e.account!.provider ? e.account! : a)) } : cur));
    }
  }), []);

  const ready = useMemo(() => data?.accounts.filter((a) => a.state === 'ready') ?? [], [data]);
  if (error) return <p className="nx-note" role="alert">{error}</p>;
  if (!data) return <div className="nst-core-grid" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="nst-core-card nst-core-skel" />)}</div>;

  const setMode = (mode: string) => coreApi.setMode(mode).then(setData).catch(fail);

  return (
    <>
      <section className="nst-core-hero">
        <div>
          <h2>Ваш агент в Шаре</h2>
          <p>
            Документы, таблицы, задачи, календарь, файлы — он работает с вашими правами, видит, что у вас открыто, и учится
            вашей манере. Подключите одного или всех: в чате «Ядра» выберете, кто ответит.
          </p>
        </div>
        <span className="nst-core-node" data-online={data.node.online || undefined}>
          <Server size={13} aria-hidden="true" />
          {data.node.online ? 'Нода на связи' : 'Нода не на связи'}
        </span>
      </section>

      <div className="nst-core-grid">
        {data.accounts.map((a) => <AgentCard key={a.provider} account={a} nodeOnline={data.node.online && data.node.clis.includes(a.provider)} onChange={setData} />)}
      </div>
      {!ready.length && <p className="nx-note nst-core-tip"><Plug size={12} aria-hidden="true" /> Ключ или вход можно прислать и самому агенту в чат — он подключит сам.</p>}

      <section className="nx-block">
        <h2 className="nx-block-title">Когда агент спрашивает разрешения</h2>
        <div className="nst-core-modes" role="radiogroup" aria-label="Режим разрешений">
          {data.modes.map((m) => {
            const Icon = MODE_ICON[m.id as keyof typeof MODE_ICON] || ShieldCheck;
            return (
              <button key={m.id} type="button" role="radio" aria-checked={data.mode === m.id} className="nst-core-mode" data-mode={m.id} onClick={() => void setMode(m.id)}>
                <Icon size={20} aria-hidden="true" />
                <b>{m.label}</b>
                <span>{m.hint}</span>
              </button>
            );
          })}
        </div>
        <p className="nx-note">Правило держит сервер: без вашего «Разрешить» агент не сможет сделать то, что режим требует согласовать.</p>
      </section>

      <section className="nx-block">
        <h2 className="nx-block-title"><Gauge size={12} aria-hidden="true" /> Расход за 30 дней</h2>
        <Usage data={data} />
      </section>

      <section className="nx-block">
        <h2 className="nx-block-title">Что агент знает о вас</h2>
        <MemoryBlock />
      </section>
    </>
  );
}
