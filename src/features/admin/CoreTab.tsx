import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy, ExternalLink, KeyRound, Loader2, Plug, Plus, RefreshCw, Server, Trash2, Users, Wifi, WifiOff } from 'lucide-react';
import { useChatStore } from '@/features/chat';
import { coreApi, formatTokens, type CoreIntegration, type CoreNode, type CoreUsageRow } from '@/features/core';
import { askConfirm, Sheet } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import { timeAgo } from './api';

/**
 * Админка → Ядро: ноды агентов, подключённые API компании (с выдачей по сотрудникам) и расход агентов по людям.
 * Нода ставится одной командой на сервер компании; ключи API хранятся зашифрованными, агенты их не видят.
 */

const fail = (cause: unknown) => showToast(cause instanceof Error ? cause.message : 'Не получилось', 'error');
const CLI_LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', browser: 'Браузер Obscura' };
const PROVIDER_LABEL: Record<string, string> = { gemini: 'Gemini', claude: 'Claude', codex: 'GPT' };

async function copy(text: string, what = 'Скопировано') {
  try { await navigator.clipboard.writeText(text); showToast(what, 'success'); } catch { showToast('Не удалось скопировать', 'error'); }
}

function Nodes() {
  const [nodes, setNodes] = useState<CoreNode[] | null>(null);
  const [fresh, setFresh] = useState<{ name: string; command: string } | null>(null);
  const [name, setName] = useState('');
  const load = useCallback(() => coreApi.nodes().then(setNodes).catch(fail), []);
  useEffect(() => { void load(); const t = window.setInterval(() => void load(), 15_000); return () => window.clearInterval(t); }, [load]);

  const create = async () => {
    try { const r = await coreApi.createNode(name.trim() || 'Нода'); setFresh({ name: r.node.name, command: r.command }); setName(''); await load(); } catch (cause) { fail(cause); }
  };
  const reissue = async (node: CoreNode) => {
    if (!(await askConfirm({ title: `Новый токен для «${node.name}»?`, text: 'Старый перестанет работать сразу — на ноде нужно будет запустить команду ещё раз.', confirm: 'Выпустить' }))) return;
    try { const r = await coreApi.reissueNode(node.id); setFresh({ name: r.node.name, command: r.command }); await load(); } catch (cause) { fail(cause); }
  };
  const remove = async (node: CoreNode) => {
    if (!(await askConfirm({ title: `Удалить ноду «${node.name}»?`, text: 'Вошедшим на ней сотрудникам придётся войти в Claude и GPT заново на другой ноде.', confirm: 'Удалить', tone: 'danger' }))) return;
    try { await coreApi.deleteNode(node.id); await load(); } catch (cause) { fail(cause); }
  };

  return (
    <section className="nad-block">
      <header className="nad-core-head">
        <h2><Server size={16} aria-hidden="true" /> Ноды агентов</h2>
        <form className="nad-core-new" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <label className="nx-field"><span className="nx-sr">Название ноды</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Название (например, office-1)" maxLength={60} /></label>
          <button type="submit" className="nx-primary"><Plus size={15} aria-hidden="true" /> Подключить ноду</button>
        </form>
      </header>
      <p className="nx-note">Нода — сервер компании (Ubuntu или Debian), где работают агенты сотрудников. Она сама звонит в Шар: белый адрес и доступ по SSH не нужны.</p>

      {fresh && (
        <div className="nad-core-fresh" aria-live="polite">
          <b><Check size={14} aria-hidden="true" /> Нода «{fresh.name}»: запустите на сервере под root</b>
          <div className="nad-core-cmd">
            <code>{fresh.command}</code>
            <button type="button" className="nx-icon-btn" onClick={() => void copy(fresh.command, 'Команда скопирована')} aria-label="Скопировать команду"><Copy size={16} /></button>
          </div>
          <p className="nx-note">Токен в команде показан один раз. Поставятся Node.js, Claude Code, Codex, Gemini CLI, браузер Obscura и служба shar-node; через минуту нода будет «на связи».</p>
          <button type="button" className="nx-ghost" onClick={() => setFresh(null)}>Готово</button>
        </div>
      )}

      {nodes === null ? <div className="nad-core-skel" /> : !nodes.length ? (
        <p className="nx-note">Нод пока нет — без ноды агенты не отвечают.</p>
      ) : (
        <div className="nad-core-nodes">
          {nodes.map((n) => (
            <article key={n.id} className="nad-core-node" data-online={n.online || undefined}>
              <span className="nad-core-node-icon" aria-hidden="true">{n.online ? <Wifi size={18} /> : <WifiOff size={18} />}</span>
              <span className="nad-core-node-main">
                <b>{n.name}</b>
                <span>{n.online ? 'на связи' : n.lastSeen ? `была ${timeAgo(n.lastSeen)}` : 'ещё не подключалась'}{n.info.host ? ` · ${n.info.host}` : ''}{n.info.version ? ` · агент ${n.info.version}` : ''}</span>
                <span className="nad-core-tags">
                  {Object.entries(n.info.clis || {}).map(([k, v]) => <span key={k} className="nad-core-tag" title={v}>{CLI_LABEL[k] || k}</span>)}
                  <span className="nad-core-tag" data-tone="people"><Users size={11} aria-hidden="true" /> {n.users}</span>
                  {!!n.info.running && <span className="nad-core-tag" data-tone="busy"><Loader2 size={11} className="nx-spin" aria-hidden="true" /> работает: {n.info.running}</span>}
                </span>
              </span>
              <span className="nad-core-node-actions">
                <button type="button" className="nx-icon-btn" onClick={() => void reissue(n)} title="Новый токен и команда установки" aria-label={`Новый токен для ${n.name}`}><RefreshCw size={16} /></button>
                <button type="button" className="nx-icon-btn" onClick={() => void remove(n)} title="Удалить" aria-label={`Удалить ${n.name}`}><Trash2 size={16} /></button>
              </span>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function AccessPicker({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const users = useChatStore((s) => s.users);
  const [query, setQuery] = useState('');
  const all = value.includes('*');
  const people = useMemo(() => Object.values(users).filter((u) => !query.trim() || `${u.name || ''} ${u.username || ''}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru')).slice(0, 80), [users, query]);
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value.filter((x) => x !== '*'), id]);
  return (
    <div className="nad-core-access">
      <label className="nad-core-all"><input type="checkbox" checked={all} onChange={(e) => onChange(e.target.checked ? ['*'] : [])} /> Открыть всем сотрудникам</label>
      {!all && (
        <>
          <label className="nx-field" data-variant="filter"><span className="nx-sr">Найти сотрудника</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Кому открыть" /></label>
          <div className="nad-core-people">
            {people.map((u) => (
              <label key={u.id} className="nad-core-person" data-on={value.includes(String(u.id)) || undefined}>
                <input type="checkbox" checked={value.includes(String(u.id))} onChange={() => toggle(String(u.id))} />
                {u.name || u.username}
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function IntegrationSheet({ item, onClose, onSaved }: { item: CoreIntegration | null; onClose: () => void; onSaved: (list: CoreIntegration[]) => void }) {
  const custom = !item || item.kind === 'custom';
  const [service, setService] = useState(item?.service || '');
  const [label, setLabel] = useState(item?.label || '');
  const [base, setBase] = useState(item?.baseUrl || '');
  const [authType, setAuthType] = useState(item?.authType || 'bearer');
  const [authName, setAuthName] = useState(item?.authName || '');
  const [notes, setNotes] = useState(item?.hint || '');
  const [fields, setFields] = useState<Record<string, string>>(() => Object.fromEntries((item?.fields || []).map((f) => [f.key, f.secret ? '' : f.value])));
  const [access, setAccess] = useState<string[]>(item?.access || []);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const body = custom
        ? { label, base_url: base, auth_type: authType, auth_name: authName, notes, secret: fields.secret || undefined, access }
        : { fields: Object.fromEntries(Object.entries(fields).filter(([, v]) => v.trim())), access };
      const list = await coreApi.saveIntegration(service.trim().toLowerCase(), body);
      const test = await coreApi.testIntegration(service.trim().toLowerCase()).catch(() => null);
      if (test) showToast(test.message, test.ok ? 'success' : 'error');
      onSaved(list);
    } catch (cause) { fail(cause); } finally { setBusy(false); }
  };
  return (
    <Sheet title={item ? item.label : 'Своё API'} onClose={onClose} busy={busy}
      footer={<button type="button" className="nx-primary" disabled={busy || !service.trim()} onClick={() => void save()}>{busy ? <Loader2 size={14} className="nx-spin" /> : <Check size={14} />} Сохранить и проверить</button>}>
      <div className="nad-core-form">
        {item?.hint && !custom && <p className="nx-note">{item.hint} {item.docs && <a href={item.docs} target="_blank" rel="noreferrer noopener">Документация <ExternalLink size={11} /></a>}</p>}
        {custom && (
          <>
            {!item && <label className="nad-core-lbl">Код сервиса<input className="nad-core-in" value={service} onChange={(e) => setService(e.target.value)} placeholder="crm, sms, 1c…" /></label>}
            <label className="nad-core-lbl">Название<input className="nad-core-in" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="RetailCRM" /></label>
            <label className="nad-core-lbl">Адрес API<input className="nad-core-in" value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://api.example.com/v1" /></label>
            <label className="nad-core-lbl">Вход
              <select className="nad-core-in" value={authType} onChange={(e) => setAuthType(e.target.value)}>
                <option value="bearer">Authorization: Bearer</option><option value="oauth">Authorization: OAuth (Яндекс)</option>
                <option value="header">Свой заголовок</option><option value="basic">Basic (логин:пароль)</option><option value="query">Параметр в адресе</option>
              </select>
            </label>
            {(authType === 'header' || authType === 'query') && <label className="nad-core-lbl">Имя заголовка или параметра<input className="nad-core-in" value={authName} onChange={(e) => setAuthName(e.target.value)} /></label>}
            <label className="nad-core-lbl">Что умеет (подсказка агенту)<textarea className="nad-core-in" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Пути, параметры, что важно знать" /></label>
          </>
        )}
        {(item?.fields || [{ key: 'secret', label: 'Ключ', secret: true, optional: false, filled: false, value: '' }]).map((f) => (
          <label key={f.key} className="nad-core-lbl">{f.label}{f.optional ? ' (необязательно)' : ''}
            <input className="nad-core-in" type={f.secret ? 'password' : 'text'} value={fields[f.key] || ''} autoComplete="off" spellCheck={false}
              placeholder={f.secret && f.filled ? 'сохранён — впишите, чтобы заменить' : ''} onChange={(e) => setFields((cur) => ({ ...cur, [f.key]: e.target.value }))} />
          </label>
        ))}
        <h3 className="nad-core-sub">Кому открыт</h3>
        <AccessPicker value={access} onChange={setAccess} />
      </div>
    </Sheet>
  );
}

function Integrations() {
  const [list, setList] = useState<CoreIntegration[] | null>(null);
  const [edit, setEdit] = useState<CoreIntegration | null | 'new'>(null);
  useEffect(() => { coreApi.integrations().then((r) => setList(r.integrations)).catch(fail); }, []);
  const remove = async (item: CoreIntegration) => {
    if (!(await askConfirm({ title: item.kind === 'custom' ? `Удалить «${item.label}»?` : `Стереть ключи «${item.label}»?`, confirm: 'Да', tone: 'danger' }))) return;
    try { setList(await coreApi.deleteIntegration(item.service)); } catch (cause) { fail(cause); }
  };
  return (
    <section className="nad-block">
      <header className="nad-core-head">
        <h2><Plug size={16} aria-hidden="true" /> Подключённые API</h2>
        <button type="button" className="nx-ghost" onClick={() => setEdit('new')}><Plus size={15} aria-hidden="true" /> Своё API</button>
      </header>
      <p className="nx-note">Агент зовёт API через Шар — ключей он не видит. Доступ выдаётся по сотрудникам: кому что нужно. Ключи можно прислать и агенту в чат — он подключит сам.</p>
      {list === null ? <div className="nad-core-skel" /> : (
        <div className="nad-core-apis">
          {list.map((i) => (
            <article key={i.service} className="nad-core-api" data-on={i.configured || undefined}>
              <span className="nad-core-api-icon" aria-hidden="true"><KeyRound size={16} /></span>
              <span className="nad-core-api-main">
                <b>{i.label}</b>
                <span>{i.configured ? (i.access.includes('*') ? 'открыт всем' : i.access.length ? `открыт: ${i.access.length} чел.` : 'подключён · пока никому не открыт') : 'не подключён'}</span>
              </span>
              <button type="button" className="nx-ghost" onClick={() => setEdit(i)}>{i.configured ? 'Настроить' : 'Подключить'}</button>
              {(i.configured || i.kind === 'custom') && <button type="button" className="nx-icon-btn" onClick={() => void remove(i)} aria-label={`Удалить ${i.label}`}><Trash2 size={15} /></button>}
            </article>
          ))}
        </div>
      )}
      {edit && <IntegrationSheet item={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={(next) => { setList(next); setEdit(null); }} />}
    </section>
  );
}

function CompanyUsage() {
  const [rows, setRows] = useState<Array<CoreUsageRow & { name?: string }> | null>(null);
  useEffect(() => { coreApi.usage(30, true).then((r) => setRows(r.usage)).catch(fail); }, []);
  const total = (rows || []).reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
  const cost = (rows || []).reduce((s, r) => s + r.costUsd, 0);
  return (
    <section className="nad-block">
      <header className="nad-core-head"><h2>Расход агентов за 30 дней</h2><span className="nad-core-total">{formatTokens(total)} токенов{cost ? ` · ≈ $${cost.toFixed(2)} за Gemini` : ''}</span></header>
      {rows === null ? <div className="nad-core-skel" /> : !rows.length ? <p className="nx-note">Агенты ещё не работали.</p> : (
        <table className="nad-core-table">
          <thead><tr><th>Сотрудник</th><th>Агент</th><th>Ответов</th><th>Токены</th><th>Цена</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.userId}:${r.provider}`}>
                <td>{r.name || r.userId}</td><td>{PROVIDER_LABEL[r.provider] || r.provider}</td><td>{r.runs}</td>
                <td>{formatTokens(r.inputTokens + r.outputTokens)}</td><td>{r.provider === 'gemini' ? (r.costUsd ? `$${r.costUsd.toFixed(2)}` : '—') : 'подписка'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export default function CoreTab() {
  return (
    <div className="nad-core">
      <Nodes />
      <Integrations />
      <CompanyUsage />
    </div>
  );
}
