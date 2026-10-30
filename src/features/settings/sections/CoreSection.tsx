import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BookOpen, Brain, Building2, Check, Copy, ExternalLink, Gauge, KeyRound, Loader2, LogIn, Plug, Server, ShieldAlert, ShieldCheck, ShieldQuestion,
  Sparkles, Trash2, Unplug, X,
} from 'lucide-react';
import { BrandMark, coreApi, formatTokens, type CoreAccount, type CoreAccounts, type CoreMcpServer, type CoreMemory, type ProviderId } from '@/features/core';
import { realtime } from '@/shared/realtime/realtime';
import { askConfirm } from '@/shared/ui/overlay';
import { Select } from '@/shared/ui/Select';
import { Switch } from '@/shared/ui/controls';
import { showToast } from '@/shared/ui/Toast';

/**
 * Настройки → Ядро: свои агенты, режим разрешений, расход и что агент знает о человеке.
 *
 * Один человек — один Gemini, один Claude, один GPT, один Kimi. Gemini — по ключу Google (вставил — работает), остальные —
 * подписка человека: вход идёт на ноде компании, здесь только ссылка и код. Всё обновляется живыми событиями.
 */

const PITCH: Record<ProviderId, string> = {
  gemini: 'Ключ Google AI Studio или Google Cloud — вставили, и работает. Платите Google по расходу.',
  claude: 'Ваша подписка Claude (Pro или Max): один раз войти по ссылке.',
  codex: 'Ваша подписка ChatGPT (Plus, Pro, Business): войти по ссылке и коду.',
  kimi: 'Ваша подписка Kimi Code (Moonshot AI): войти по ссылке и коду.',
};

const MODE_ICON = { auto: ShieldAlert, careful: ShieldCheck, ask: ShieldQuestion } as const;

const fail = (cause: unknown) => showToast(cause instanceof Error ? cause.message : 'Не получилось', 'error');

async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); showToast('Скопировано', 'success'); } catch { showToast('Не удалось скопировать', 'error'); }
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

/** Учётная запись словами: «Logged in using ChatGPT» от Codex — «вход через ChatGPT». */
function accountText(account: CoreAccount): string {
  const raw = account.account || '';
  const via = raw.match(/logged in using (.+)/i);
  if (via) return `вход через ${via[1]}`;
  return raw || 'вход выполнен';
}

/**
 * Агент — строкой на всю ширину: знак, имя и одна строка пояснения слева; статус, модель и действие справа.
 * Ключ Gemini и шаги входа в подписку — второй строкой внутри той же строки.
 */
function AgentRow({ account, nodeOnline, onChange }: { account: CoreAccount; nodeOnline: boolean; onChange: (next: CoreAccounts) => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
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
    setKeyOpen(false);
  };
  const disconnect = async () => {
    const ok = await askConfirm({
      title: `Отключить ${account.label}?`,
      text: account.how === 'key' ? 'Ключ сотрётся из Шара. Агент перестанет отвечать, пока вы не вставите ключ снова.' : 'На ноде будет выполнен выход из вашей подписки.',
      confirm: 'Отключить', tone: 'danger',
    });
    if (ok) await run(() => coreApi.disconnect(account.provider));
  };
  const realModels = account.models.filter((m) => m.id);

  return (
    <article className="nst-core-agent" data-state={ready ? 'ready' : logging ? 'busy' : 'off'}>
      <div className="nst-core-agent-row">
        <span className="nst-core-logo" aria-hidden="true"><BrandMark id={account.provider} size={20} /></span>
        <span className="nst-core-agent-main">
          <b>{account.label} <StatusPill account={account} /></b>
          <span>{ready ? accountText(account) : PITCH[account.provider]}</span>
          {account.error && <span className="nst-core-error" role="alert">{account.error}</span>}
        </span>
        <span className="nst-core-agent-side">
          {ready && realModels.length > 1 && (
            <Select className="nst-core-model" label={`Модель ${account.label} по умолчанию`} value={account.model}
              onChange={(model) => void run(() => coreApi.setModel(account.provider, model))}
              groups={[{ options: realModels.map((m) => ({ value: m.id, label: m.label })) }]} />
          )}
          {ready && (
            <button type="button" className="nx-icon-btn" disabled={busy} onClick={() => void disconnect()} aria-label={`Отключить ${account.label}`} title="Отключить">
              <Unplug size={16} />
            </button>
          )}
          {!ready && !logging && account.how === 'key' && !keyOpen && (
            <button type="button" className="nx-ghost" onClick={() => setKeyOpen(true)}><KeyRound size={14} aria-hidden="true" /> Вставить ключ</button>
          )}
          {!ready && !logging && account.how === 'login' && (
            <button type="button" className="nx-ghost" disabled={busy || !nodeOnline} onClick={() => void run(() => coreApi.login(account.provider))}
              title={nodeOnline ? undefined : 'Нода агентов не на связи — её запускает администратор'}>
              {busy ? <Loader2 size={14} className="nx-spin" aria-hidden="true" /> : <LogIn size={14} aria-hidden="true" />} Войти
            </button>
          )}
        </span>
      </div>
      {!ready && account.how === 'key' && keyOpen && (
        <form className="nst-core-agent-extra nst-core-key" onSubmit={(e) => { e.preventDefault(); void saveKey(); }}>
          <label className="nx-field nst-core-input">
            <span className="nx-sr">Ключ Google для Gemini</span>
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="AIza…" autoComplete="off" spellCheck={false} autoFocus />
          </label>
          <button type="submit" className="nx-primary" disabled={key.trim().length < 20 || busy}>
            {busy ? <Loader2 size={14} className="nx-spin" aria-hidden="true" /> : <Plug size={14} aria-hidden="true" />} Подключить
          </button>
          <button type="button" className="nx-icon-btn" onClick={() => { setKeyOpen(false); setKey(''); }} aria-label="Отмена"><X size={16} /></button>
          <a className="nst-core-help" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer noopener">Где взять ключ — Google AI Studio <ExternalLink size={11} aria-hidden="true" /></a>
        </form>
      )}
      {logging && <div className="nst-core-agent-extra"><LoginFlow account={account} onChange={onChange} /></div>}
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
            <span className="nst-core-logo" data-size="s" aria-hidden="true"><BrandMark id={r.provider} size={15} /></span>
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

/** API компании, открытые человеку: агент зовёт их через Шар, ключей не видит. Выдаёт администратор. */
function ApisBlock() {
  const [list, setList] = useState<Array<{ service: string; label: string; hint: string; docs: string }> | null>(null);
  useEffect(() => { coreApi.myIntegrations().then(setList).catch(() => setList([])); }, []);
  if (list === null) return <div className="nst-core-agents nst-core-skel" aria-busy="true" />;
  if (!list.length) return <p className="nx-note">Вам пока не открыт ни один API компании. Метрику, Топвизор, Вордстат и другие открывает администратор (Админка → Ядро).</p>;
  return (
    <div className="nst-core-agents">
      {list.map((i) => (
        <div key={i.service} className="nst-core-agent">
          <div className="nst-core-agent-row">
            <span className="nst-core-logo" aria-hidden="true"><Plug size={17} /></span>
            <span className="nst-core-agent-main"><b>{i.label}</b><span>{i.hint}</span></span>
            {i.docs && <a className="nx-icon-btn" href={i.docs} target="_blank" rel="noreferrer noopener" aria-label={`Документация ${i.label}`} title="Документация"><ExternalLink size={15} /></a>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Личные MCP-серверы: подключаются к каждому запуску агента. Добавить — здесь или попросить агента («поставь MCP …»). */
function McpBlock() {
  const [list, setList] = useState<CoreMcpServer[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', kind: 'http' as 'http' | 'npm', target: '', secretName: '', secret: '' });
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => coreApi.mcpServers().then(setList).catch(() => setList([])), []);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setBusy(true);
    try {
      const secrets = form.secretName.trim() && form.secret ? { [form.secretName.trim()]: form.secret } : undefined;
      const body = form.kind === 'http'
        ? { kind: 'http' as const, url: form.target.trim(), headers: secrets }
        : { kind: 'npm' as const, package: form.target.trim(), env: secrets };
      setList(await coreApi.saveMcpServer(form.name.trim().toLowerCase(), body));
      setAdding(false);
      setForm({ name: '', kind: 'http', target: '', secretName: '', secret: '' });
    } catch (cause) { fail(cause); } finally { setBusy(false); }
  };
  const remove = async (name: string) => {
    if (!(await askConfirm({ title: `Удалить MCP «${name}»?`, confirm: 'Удалить', tone: 'danger' }))) return;
    try { setList(await coreApi.deleteMcpServer(name)); } catch (cause) { fail(cause); }
  };

  return (
    <div className="nst-core-tools">
      {list && list.length > 0 && (
        <div className="nst-core-agents">
          {list.map((m) => (
            <div key={m.name} className="nst-core-agent" data-state={m.enabled ? 'ready' : 'off'}>
              <div className="nst-core-agent-row">
                <span className="nst-core-logo" aria-hidden="true"><Server size={16} /></span>
                <span className="nst-core-agent-main">
                  <b>{m.name}</b>
                  <span>{m.kind === 'http' ? m.url : `npm: ${m.package}${m.args.length ? ` ${m.args.join(' ')}` : ''}`}{m.secretKeys.length ? ` · секреты: ${m.secretKeys.join(', ')}` : ''}{m.addedBy ? ` · добавил ${m.addedBy}` : ''}</span>
                </span>
                <span className="nst-core-agent-side">
                  <Switch checked={m.enabled} label={`MCP ${m.name} включён`} onChange={(on) => coreApi.saveMcpServer(m.name, { enabled: on }).then(setList).catch(fail)} />
                  <button type="button" className="nx-icon-btn" onClick={() => void remove(m.name)} aria-label={`Удалить ${m.name}`} title="Удалить"><Trash2 size={15} /></button>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
      {list !== null && !list.length && !adding && (
        <p className="nx-note">Своих MCP пока нет. Попросите агента: «поставь MCP GitHub» — он подключит сам; или добавьте здесь.</p>
      )}
      {adding ? (
        <form className="nst-core-mcp-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <nav className="nx-segment" aria-label="Вид MCP">
            <button type="button" aria-pressed={form.kind === 'http'} onClick={() => setForm({ ...form, kind: 'http' })}>По адресу</button>
            <button type="button" aria-pressed={form.kind === 'npm'} onClick={() => setForm({ ...form, kind: 'npm' })}>npm-пакет</button>
          </nav>
          <label className="nx-field"><span className="nx-sr">Имя</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Имя латиницей: github" /></label>
          <label className="nx-field"><span className="nx-sr">{form.kind === 'http' ? 'Адрес' : 'Пакет'}</span>
            <input value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} placeholder={form.kind === 'http' ? 'https://…/mcp' : '@modelcontextprotocol/server-github'} spellCheck={false} />
          </label>
          <div className="nst-core-mcp-secret">
            <label className="nx-field"><span className="nx-sr">Имя секрета</span>
              <input value={form.secretName} onChange={(e) => setForm({ ...form, secretName: e.target.value })} placeholder={form.kind === 'http' ? 'Authorization' : 'GITHUB_TOKEN'} spellCheck={false} />
            </label>
            <label className="nx-field"><span className="nx-sr">Значение секрета</span>
              <input type="password" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} placeholder={form.kind === 'http' ? 'Bearer …' : 'значение'} autoComplete="off" />
            </label>
          </div>
          <div className="nx-actions">
            <button type="button" className="nx-ghost" onClick={() => setAdding(false)}>Отмена</button>
            <button type="submit" className="nx-primary" disabled={busy || !form.name.trim() || !form.target.trim()}><Check size={14} aria-hidden="true" /> Подключить</button>
          </div>
        </form>
      ) : (
        <button type="button" className="nx-ghost nst-core-add" onClick={() => setAdding(true)}><Server size={14} aria-hidden="true" /> Добавить MCP</button>
      )}
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
  if (!data) return <div className="nst-core-agents" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="nst-core-agent nst-core-skel" />)}</div>;

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

      <div className="nst-core-agents">
        {data.accounts.map((a) => <AgentRow key={a.provider} account={a} nodeOnline={data.node.online && data.node.clis.includes(a.provider)} onChange={setData} />)}
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
        <h2 className="nx-block-title nst-core-title"><Gauge size={12} aria-hidden="true" /> Расход за 30 дней</h2>
        <Usage data={data} />
      </section>

      <section className="nx-block">
        <h2 className="nx-block-title nst-core-title"><Plug size={12} aria-hidden="true" /> Доступные API</h2>
        <ApisBlock />
      </section>

      <section className="nx-block">
        <h2 className="nx-block-title nst-core-title"><Server size={12} aria-hidden="true" /> MCP-серверы</h2>
        <p className="nx-note">Свои инструменты для агента: GitHub, Notion, базы — любой MCP по адресу или из npm. Подключаются к каждому его запуску; секреты хранятся зашифрованными.</p>
        <McpBlock />
      </section>

      <section className="nx-block">
        <h2 className="nx-block-title">Что агент знает о вас</h2>
        <MemoryBlock />
      </section>
    </>
  );
}
