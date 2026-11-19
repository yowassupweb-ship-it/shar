import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { FolderPlus, Plus, Settings2, Tag, Trash2, X } from 'lucide-react';
import { askConfirm, Sheet } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import { loadBoxes, loadFolder, openFolder, useMail } from './api';

/**
 * Свои папки с правилами — поток писем раскладывается сам, как фильтры Gmail. Письмо остаётся в ящике на почтовом
 * сервере; Шар показывает его в папке, чьё правило подошло, и убирает из «Входящих». Сервер: mail/folder_rules.py.
 */

export type RuleField = 'from' | 'subject' | 'to';
export interface SmartRule { id?: string; field: RuleField; text: string }
export interface SmartFolder { id: string; name: string; color: string; folder: string; rules: SmartRule[]; unread: number }

const FIELD_LABEL: Record<RuleField, string> = { from: 'Отправитель содержит', subject: 'Тема содержит', to: 'Получатель содержит' };
const FIELD_HINT: Record<RuleField, string> = { from: 'адрес, домен или имя: romashka.ru', subject: 'слово из темы: счёт', to: 'ваш адрес-псевдоним: sales@' };
const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6', '#64748b'];

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', ...init });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.detail || ''; } catch { /* не JSON */ }
    throw new Error(typeof detail === 'string' && detail ? detail : `Ошибка ${res.status}`);
  }
  return (await res.json()) as T;
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** Правила поменялись — «Входящие» и папки перечитываем: письма перераскладываются сразу. */
function refreshLists() {
  const st = useMail.getState();
  useMail.setState({ lists: {}, listPhase: {} });
  void loadBoxes();
  void loadFolder(st.folder);
}

export function MailFolders({ accountId, current }: { accountId: string | null; current: string }) {
  const [folders, setFolders] = useState<SmartFolder[]>([]);
  const [editing, setEditing] = useState<SmartFolder | 'new' | null>(null);
  const boxes = useMail((s) => s.boxes); // счётчики перечитываем вместе с ящиками

  const load = useCallback(async () => {
    if (!accountId) return;
    try { setFolders(await call<SmartFolder[]>(`/api/mail/smart-folders?accountId=${encodeURIComponent(accountId)}`)); } catch { /* список папок не обязателен */ }
  }, [accountId]);
  useEffect(() => { void load(); }, [load, boxes]);

  return (
    <section className="nmf" aria-label="Мои папки">
      <div className="nmf-head">
        <span>Мои папки</span>
        <button type="button" className="nx-icon-btn" onClick={() => setEditing('new')} aria-label="Новая папка с правилами" title="Новая папка с правилами"><FolderPlus size={15} /></button>
      </div>
      {folders.map((f) => (
        <div key={f.id} className="nmf-row" data-current={f.folder === current ? 'true' : undefined}>
          <button type="button" className="nmb-item" aria-current={f.folder === current ? 'true' : undefined} onClick={() => openFolder(f.folder)}
            title={f.rules.length ? f.rules.map((r) => `${FIELD_LABEL[r.field]} «${r.text}»`).join('\n') : 'Правил нет — папка пустая'}>
            <Tag size={16} aria-hidden="true" style={{ color: f.color } as CSSProperties} />
            <span>{f.name}</span>
            {f.unread > 0 && <span className="nmb-count">{f.unread}</span>}
          </button>
          <button type="button" className="nx-icon-btn nmf-gear" onClick={() => setEditing(f)} aria-label={`Правила папки «${f.name}»`} title="Правила"><Settings2 size={14} /></button>
        </div>
      ))}
      {!folders.length && <p className="nmf-empty">Заведите папку и правило — письма от клиента, счета или рассылки будут раскладываться сами.</p>}
      {editing && (
        <FolderSheet
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(id) => { setEditing(null); void load(); refreshLists(); if (id) openFolder(`custom:${id}`); }}
          onDeleted={(f) => { setEditing(null); void load(); refreshLists(); if (current === f.folder) openFolder('INBOX'); }}
        />
      )}
    </section>
  );
}

function FolderSheet({ initial, onClose, onSaved, onDeleted }: {
  initial: SmartFolder | null; onClose: () => void; onSaved: (id: string | null) => void; onDeleted: (f: SmartFolder) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [color, setColor] = useState(initial?.color ?? COLORS[0]);
  const [rules, setRules] = useState<SmartRule[]>(initial?.rules.length ? initial.rules : [{ field: 'from', text: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const patch = (i: number, next: Partial<SmartRule>) => setRules((all) => all.map((r, j) => (j === i ? { ...r, ...next } : r)));

  async function save() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      let id = initial?.id;
      if (!id) id = (await call<{ id: string }>('/api/mail/folders', json('POST', { name: name.trim(), color }))).id;
      await call(`/api/mail/smart-folders/${encodeURIComponent(id)}`, json('PUT', { name: name.trim(), color, rules: rules.filter((r) => r.text.trim()) }));
      showToast(initial ? 'Правила сохранены — письма разложены заново' : `Папка «${name.trim()}» создана`, 'success');
      onSaved(initial ? null : id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  async function remove() {
    if (!initial) return;
    if (!(await askConfirm({ title: `Удалить папку «${initial.name}»?`, text: 'Письма никуда не денутся — вернутся во «Входящие».', confirm: 'Удалить', tone: 'danger' }))) return;
    try {
      await call(`/api/mail/folders/${encodeURIComponent(initial.id)}`, { method: 'DELETE' });
      onDeleted(initial);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  return (
    <Sheet
      title={initial ? `Папка «${initial.name}»` : 'Новая папка'}
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          {initial && <button type="button" className="nx-ghost" onClick={() => void remove()}><Trash2 size={15} aria-hidden="true" /> Удалить</button>}
          <button type="button" className="nx-primary" disabled={!name.trim() || busy} onClick={() => void save()}>{initial ? 'Сохранить' : 'Создать'}</button>
        </>
      )}
    >
      <div className="nmf-form">
        <label className="nmf-field"><span>Название</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus placeholder="Бухгалтерия" onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} />
        </label>
        <div className="nmf-colors" role="radiogroup" aria-label="Цвет">
          {COLORS.map((c) => <button key={c} type="button" role="radio" aria-checked={c === color} aria-label={c} style={{ '--c': c } as CSSProperties} onClick={() => setColor(c)} />)}
        </div>
        <div className="nmf-rules">
          <b>Класть сюда письма, если</b>
          <p className="nmf-note">Хватит любого из правил. Подходящие письма уходят из «Входящих» и видны только здесь; на почтовом сервере они остаются на месте.</p>
          {rules.map((r, i) => (
            <div key={i} className="nmf-rule">
              <select value={r.field} onChange={(e) => patch(i, { field: e.target.value as RuleField })} aria-label="Что проверять">
                {(Object.keys(FIELD_LABEL) as RuleField[]).map((f) => <option key={f} value={f}>{FIELD_LABEL[f]}</option>)}
              </select>
              <input value={r.text} onChange={(e) => patch(i, { text: e.target.value })} maxLength={200} placeholder={FIELD_HINT[r.field]} aria-label="Текст правила" />
              <button type="button" className="nx-icon-btn" onClick={() => setRules((all) => all.filter((_, j) => j !== i))} aria-label="Убрать правило"><X size={14} /></button>
            </div>
          ))}
          <button type="button" className="nx-ghost nmf-add" onClick={() => setRules((all) => [...all, { field: 'from', text: '' }])}><Plus size={14} aria-hidden="true" /> Ещё правило</button>
        </div>
        {error && <p className="nmf-error" role="alert">{error}</p>}
      </div>
    </Sheet>
  );
}
