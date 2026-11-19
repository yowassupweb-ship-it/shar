import { memo, useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, Building2, Mail, Pencil, Phone, Send, StickyNote, Trash2, UserPlus, Users, X } from 'lucide-react';
import { Avatar } from '@/shared/ui/Avatar';
import { Group } from '@/shared/ui/controls';
import { Sheet } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import { myId } from '@/shared/session/session';
import { PeoplePicker, PersonLabel, type PickTarget } from '@/features/workspace/PeoplePicker';
import { MailLink } from '@/features/mail';
import {
  EMPTY_DRAFT, personalApi, personalTitle,
  type PersonalContact, type PersonalDraft, type PersonalShares, type ShareRole,
} from './personal';

/** «Мои контакты»: строка списка, карточка, окно правки и окно доступа (как «Поделиться» у документа). */

const ROLES: Array<{ value: ShareRole; label: string }> = [
  { value: 'view', label: 'Просмотр' },
  { value: 'edit', label: 'Редактирование' },
];
const ROLE_LABEL: Record<ShareRole, string> = { view: 'Просмотр', edit: 'Редактирование' };

export const PersonalRow = memo(function PersonalRow({ c, active, onOpen }: { c: PersonalContact; active: boolean; onOpen: (id: string) => void }) {
  const title = personalTitle(c);
  const sub = [c.name ? c.company : '', c.position].filter(Boolean).join(' · ') || c.phone || c.email || '';
  return (
    <button type="button" className="ctl-row" data-contact-id={c.id} aria-current={active ? 'true' : undefined} onClick={() => onOpen(c.id)}>
      <Avatar name={title} seed={`pc${c.id}`} person size={40} />
      <span className="ctl-row-text">
        <span className="ctl-row-name">{title}</span>
        <span className="ctl-row-sub">{sub}</span>
      </span>
      {!c.mine ? <span className="ctl-head-chip" title={`Открыл(а): ${c.ownerName}`}>{c.role === 'edit' ? 'Правка' : 'Просмотр'}</span>
        : c.shared > 0 ? <span className="pc-shared" title="Есть общий доступ"><Users size={14} aria-hidden="true" />{c.shared}</span> : null}
    </button>
  );
});

function Field({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="ctd-row">
      <span className="ctd-row-icon" aria-hidden="true">{icon}</span>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function PersonalDetail({ contact, onBack, onEdit, onShare, onDelete }: {
  contact: PersonalContact; onBack: () => void; onEdit: () => void; onShare: () => void; onDelete: () => void;
}) {
  const title = personalTitle(contact);
  const canEdit = contact.role !== 'view';
  const tg = contact.telegram.replace(/^@/, '');
  return (
    <section className="ctd" aria-label={`Контакт: ${title}`}>
      <header className="ctd-bar">
        <button type="button" className="nx-icon-btn ctd-back" onClick={onBack} aria-label="К списку контактов"><ArrowLeft size={20} aria-hidden="true" /></button>
      </header>
      <div className="ctd-scroll nx-scroll-y">
        <div className="ctd-column">
          <div className="ctd-hero">
            <Avatar name={title} seed={`pc${contact.id}`} person size={96} />
            <h2>{title}</h2>
            {contact.name && contact.company && <p className="ctd-position">{contact.company}</p>}
            {contact.position && <p className="ctd-presence">{contact.position}</p>}
            {!contact.mine && <p className="ctd-presence">Открыл(а) {contact.ownerName || 'коллега'} · {ROLE_LABEL[contact.role === 'edit' ? 'edit' : 'view'].toLowerCase()}</p>}
          </div>
          <div className="ctd-actions">
            {canEdit && <button type="button" className="nx-ghost" onClick={onEdit}><Pencil size={16} aria-hidden="true" /> Изменить</button>}
            {contact.mine && <button type="button" className="nx-primary" onClick={onShare}><UserPlus size={16} aria-hidden="true" /> Поделиться</button>}
            {contact.phone && <a className="nx-icon-btn ctd-round" href={`tel:${contact.phone.replace(/[^\d+]/g, '')}`} aria-label={`Позвонить: ${contact.phone}`}><Phone size={18} aria-hidden="true" /></a>}
            {contact.mine && <button type="button" className="nx-icon-btn ctd-round" onClick={onDelete} aria-label="Удалить контакт"><Trash2 size={18} aria-hidden="true" /></button>}
          </div>
          <dl className="ctd-info">
            {contact.phone && <Field icon={<Phone size={16} />} label="Телефон"><a href={`tel:${contact.phone.replace(/[^\d+]/g, '')}`}>{contact.phone}</a></Field>}
            {contact.email && <Field icon={<Mail size={16} />} label="Почта"><MailLink email={contact.email} /></Field>}
            {tg && <Field icon={<Send size={16} />} label="Telegram"><a href={`https://t.me/${tg}`} target="_blank" rel="noopener noreferrer">@{tg}</a></Field>}
            {contact.company && contact.name && <Field icon={<Building2 size={16} />} label="Организация">{contact.company}</Field>}
            {contact.note && <Field icon={<StickyNote size={16} />} label="Заметка"><span className="pc-note">{contact.note}</span></Field>}
            {!contact.phone && !contact.email && !tg && !contact.note && <Field icon={<Users size={16} />} label="Данные">Добавьте телефон или почту — кнопка «Изменить».</Field>}
          </dl>
        </div>
      </div>
    </section>
  );
}

/** Создание и правка. initial = null — новый контакт. */
export function PersonalEditor({ initial, onSaved, onClose }: { initial: PersonalContact | null; onSaved: (saved: PersonalContact) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<PersonalDraft>(() => (initial ? {
    name: initial.name, company: initial.company, position: initial.position, phone: initial.phone, email: initial.email, telegram: initial.telegram, note: initial.note,
  } : EMPTY_DRAFT));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (key: keyof PersonalDraft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft((d) => ({ ...d, [key]: e.target.value }));
  const valid = Boolean(draft.name.trim() || draft.company.trim());

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError('');
    try {
      const saved = initial ? await personalApi.update(initial.id, draft) : await personalApi.create(draft);
      onSaved(saved);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={initial ? 'Изменить контакт' : 'Новый контакт'}
      onClose={onClose}
      busy={busy}
      footer={<button type="button" className="nx-primary" disabled={!valid || busy} onClick={() => void submit()}>{initial ? 'Сохранить' : 'Добавить'}</button>}
    >
      <form className="pc-form" onSubmit={(e) => void submit(e)}>
        <label><span>Имя</span><input value={draft.name} onChange={set('name')} maxLength={200} autoFocus autoComplete="off" placeholder="Иван Петров" /></label>
        <label><span>Организация</span><input value={draft.company} onChange={set('company')} maxLength={200} autoComplete="off" placeholder="ООО «Ромашка»" /></label>
        <label><span>Должность</span><input value={draft.position} onChange={set('position')} maxLength={200} autoComplete="off" /></label>
        <label><span>Телефон</span><input value={draft.phone} onChange={set('phone')} maxLength={100} inputMode="tel" autoComplete="off" /></label>
        <label><span>Почта</span><input value={draft.email} onChange={set('email')} maxLength={200} inputMode="email" autoComplete="off" /></label>
        <label><span>Telegram</span><input value={draft.telegram} onChange={set('telegram')} maxLength={100} autoComplete="off" placeholder="@username" /></label>
        <label><span>Заметка</span><textarea value={draft.note} onChange={set('note')} maxLength={5000} rows={4} /></label>
        {!valid && <p className="pc-hint">Нужно имя или организация.</p>}
        {error && <p className="pc-error" role="alert">{error}</p>}
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}

/** Доступ к контакту: человек или отдел, просмотр или редактирование. Видит тот, с кем поделились. */
export function PersonalShareSheet({ contact, onClose, onChanged }: { contact: PersonalContact; onClose: () => void; onChanged: (count: number) => void }) {
  const [state, setState] = useState<PersonalShares>({ shares: [], departments: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fail = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));
  const apply = (next: PersonalShares) => { setState(next); onChanged(next.shares.length + next.departments.length); };

  useEffect(() => { personalApi.shares(contact.id).then(setState).catch(fail); }, [contact.id]);

  async function setShare(target: { userId: string } | { departmentId: string }, role: ShareRole | null) {
    setError('');
    try { apply(await personalApi.setShare(contact.id, target, role)); } catch (cause) { fail(cause); }
  }

  async function give(targets: PickTarget[], role: string): Promise<boolean> {
    setBusy(true);
    setError('');
    const done: string[] = [];
    try {
      for (const target of targets) {
        apply(await personalApi.setShare(contact.id, target.kind === 'department' ? { departmentId: target.id } : { userId: target.id }, role as ShareRole));
        done.push(target.name);
      }
      showToast(`Контакт открыт: ${done.join(', ')}`, 'success');
      return true;
    } catch (cause) {
      fail(cause);
      if (done.length) showToast(`Успели открыть: ${done.join(', ')}`, 'info');
      return false;
    } finally { setBusy(false); }
  }

  return (
    <Sheet title={`Доступ к контакту: ${personalTitle(contact)}`} onClose={onClose}>
      <div className="nws-share">
        <Group title="Открыть контакт" note="Видят только те, кому вы открыли. «Редактирование» — могут менять данные; удалить контакт и управлять доступом можете только вы.">
          <PeoplePicker
            excludeUsers={state.shares.map((s) => s.userId)}
            excludeDepartments={state.departments.map((d) => d.departmentId)}
            roles={ROLES}
            defaultRole="view"
            busy={busy}
            submitLabel={() => 'Открыть'}
            onSubmit={give}
          />
        </Group>
        <Group title="У кого есть доступ">
          <div className="nx-row">
            <PersonLabel userId={myId()} />
            <span className="nx-row-hint">Владелец</span>
          </div>
          {state.departments.map((d) => (
            <div key={d.departmentId} className="nx-row">
              <span className="nws-person">
                <span className="nws-picker-dept" aria-hidden="true"><Building2 size={16} /></span>
                <span className="nx-row-text"><span className="nx-row-label">{d.name}</span><span className="nx-row-hint">Отдел · {d.members} чел.</span></span>
              </span>
              <div className="nx-row-control">
                <select className="nws-select" value={d.role} onChange={(e) => void setShare({ departmentId: d.departmentId }, e.target.value as ShareRole)} aria-label={`Права отдела: ${d.name}`}>
                  {ROLES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <button type="button" className="nx-icon-btn" onClick={() => void setShare({ departmentId: d.departmentId }, null)} aria-label={`Закрыть доступ отделу: ${d.name}`}><X size={15} /></button>
              </div>
            </div>
          ))}
          {state.shares.map((s) => (
            <div key={s.userId} className="nx-row">
              <PersonLabel userId={s.userId} name={s.name} />
              <div className="nx-row-control">
                <select className="nws-select" value={s.role} onChange={(e) => void setShare({ userId: s.userId }, e.target.value as ShareRole)} aria-label={`Права: ${s.name}`}>
                  {ROLES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <button type="button" className="nx-icon-btn" onClick={() => void setShare({ userId: s.userId }, null)} aria-label={`Закрыть доступ: ${s.name}`}><X size={15} /></button>
              </div>
            </div>
          ))}
        </Group>
        {error && <p className="nws-error" role="alert">{error}</p>}
      </div>
    </Sheet>
  );
}
