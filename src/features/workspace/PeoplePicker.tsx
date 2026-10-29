import { useId, useMemo, useRef, useState } from 'react';
import { Building2, X } from 'lucide-react';
import { useChatStore } from '@/features/chat';
import { useContacts } from '@/features/contacts/data';
import { Avatar } from '@/shared/ui/Avatar';
import { Select } from '@/shared/ui/Select';
import { myId } from '@/shared/session/session';

/** Кому выдать доступ: человек или отдел (с подразделами). */
export type PickTarget = { kind: 'user'; id: string; name: string } | { kind: 'department'; id: string; name: string };

type Option = PickTarget & { hint: string; avatar?: string; haystack: string; online?: boolean };

const MAX_PEOPLE = 8;
const MAX_DEPARTMENTS = 5;

const norm = (text: string) => text.toLowerCase().replace(/ё/g, 'е');

/** Люди и отделы для выбора и подписи: имя, должность, отдел, аватар — из контактов, иначе из чатов. */
export function usePeople() {
  const users = useChatStore((s) => s.users);
  const { contacts, departments } = useContacts();
  return useMemo(() => {
    const deptName = new Map(departments.map((d) => [d.id, d.name]));
    const byId = new Map<string, { name: string; hint: string; avatar?: string; online?: boolean; haystack: string }>();
    const contactById = new Map(contacts.map((c) => [String(c.id), c]));
    const ids = new Set([...Object.keys(users), ...contacts.map((c) => String(c.id))]);
    for (const id of ids) {
      const u = users[id];
      const c = contactById.get(id);
      const name = c?.name || u?.name || c?.username || u?.username || id;
      const dept = (c?.departmentIds ?? []).map((d) => deptName.get(d)).find(Boolean) || (c?.department ? deptName.get(c.department) || c.department : '');
      const hint = [c?.position, dept].filter(Boolean).join(' · ');
      byId.set(id, {
        name, hint, avatar: c?.avatar || u?.avatar, online: Boolean(u?.isOnline ?? c?.isOnline),
        haystack: norm([name, c?.username || u?.username, c?.email || u?.email, c?.position, dept].filter(Boolean).join(' ')),
      });
    }
    return { byId, departments };
  }, [users, contacts, departments]);
}

/** Человек в строке доступа: аватар, имя, должность и отдел. */
export function PersonLabel({ userId, name, hint }: { userId: string; name?: string; hint?: string }) {
  const { byId } = usePeople();
  const person = byId.get(userId);
  const shown = name || person?.name || userId;
  return (
    <span className="nws-person">
      <Avatar name={shown} seed={userId} src={person?.avatar} person size={32} online={person?.online} />
      <span className="nx-row-text">
        <span className="nx-row-label">{shown}</span>
        {(hint ?? person?.hint) && <span className="nx-row-hint">{hint ?? person?.hint}</span>}
      </span>
    </span>
  );
}

/**
 * Выбор, кому дать доступ, — как в Google Docs: поле с поиском по имени, логину, почте, должности и отделу (слова в
 * любом порядке, «ё» = «е»), подсказки с аватарками, несколько получателей «фишками», права и одна кнопка.
 * Клавиатура: стрелки — по подсказкам, Enter — добавить, Backspace в пустом поле — убрать последнего, Esc — закрыть.
 */
export function PeoplePicker({ excludeUsers, excludeDepartments, roles, defaultRole, submitLabel, busy, onSubmit }: {
  excludeUsers: string[];
  excludeDepartments: string[];
  roles: Array<{ value: string; label: string }>;
  defaultRole: string;
  submitLabel: (targets: PickTarget[]) => string;
  busy?: boolean;
  onSubmit: (targets: PickTarget[], role: string) => Promise<boolean | void> | void;
}) {
  const { byId, departments } = usePeople();
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<PickTarget[]>([]);
  const [role, setRole] = useState(defaultRole);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  const options = useMemo(() => {
    const skipUsers = new Set([...excludeUsers, ...picked.filter((p) => p.kind === 'user').map((p) => p.id), myId()]);
    const skipDepts = new Set([...excludeDepartments, ...picked.filter((p) => p.kind === 'department').map((p) => p.id)]);
    const terms = norm(query).split(/\s+/).filter(Boolean);
    const fits = (haystack: string) => terms.every((t) => haystack.includes(t));
    // Совпадение с началом имени — выше: «ан» — сначала Анна, потом Иванова.
    const rank = (o: Option) => (terms.length && norm(o.name).startsWith(terms[0]) ? 0 : 1);
    const people: Option[] = [...byId].filter(([id]) => !skipUsers.has(id))
      .map(([id, p]) => ({ kind: 'user' as const, id, name: p.name, hint: p.hint, avatar: p.avatar, online: p.online, haystack: p.haystack }))
      .filter((o) => fits(o.haystack))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'ru'))
      .slice(0, MAX_PEOPLE);
    const depts: Option[] = departments.filter((d) => !skipDepts.has(d.id))
      .map((d) => ({ kind: 'department' as const, id: d.id, name: d.name, hint: d.parentId ? 'Подотдел' : 'Отдел — со всеми подотделами', haystack: norm(d.name) }))
      .filter((o) => fits(o.haystack))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'ru'))
      .slice(0, terms.length ? MAX_DEPARTMENTS : 3);
    // Запрос — начало названия отдела («бухг», «марк»): отделы первыми.
    const deptsFirst = terms.length > 0 && depts.some((d) => norm(d.name).startsWith(terms.join(' ')));
    return { people, depts, deptsFirst, all: deptsFirst ? [...depts, ...people] : [...people, ...depts] };
  }, [byId, departments, query, picked, excludeUsers, excludeDepartments]);

  const add = (option: Option) => {
    setPicked((cur) => [...cur, option.kind === 'user' ? { kind: 'user', id: option.id, name: option.name } : { kind: 'department', id: option.id, name: option.name }]);
    setQuery('');
    setActive(0);
    // Подсказки закрываем: под ними права и кнопка; снова откроются, как только человек начнёт печатать.
    setOpen(false);
    input.current?.focus();
  };

  async function submit() {
    if (!picked.length || busy) return;
    const ok = await onSubmit(picked, role);
    if (ok !== false) { setPicked([]); setOpen(false); }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, options.all.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const option = options.all[active];
      if (open && query && option) add(option);
      else if (!query && picked.length) void submit();
      else if (option) add(option);
    } else if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); }
    else if (e.key === 'Backspace' && !query && picked.length) setPicked((cur) => cur.slice(0, -1));
  };

  const optionId = (index: number) => `${listId}-${index}`;
  const showList = open && options.all.length > 0;
  const renderOption = (option: Option, index: number) => (
    <li
      key={`${option.kind}:${option.id}`}
      id={optionId(index)}
      role="option"
      aria-selected={index === active}
      className="nws-picker-option"
      data-active={index === active || undefined}
      // mousedown, а не click: поле не теряет фокус, список не закрывается раньше выбора.
      onMouseDown={(e) => { e.preventDefault(); add(option); }}
      onMouseEnter={() => setActive(index)}
    >
      {option.kind === 'user'
        ? <Avatar name={option.name} seed={option.id} src={option.avatar} person size={32} online={option.online} />
        : <span className="nws-picker-dept" aria-hidden="true"><Building2 size={16} /></span>}
      <span className="nx-row-text">
        <span className="nx-row-label">{option.name}</span>
        {option.hint && <span className="nx-row-hint">{option.hint}</span>}
      </span>
    </li>
  );

  return (
    <div className="nws-picker">
      <div className="nws-picker-box">
      <div className="nws-picker-field" onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); input.current?.focus(); } }}>
        {picked.map((p) => (
          <span key={`${p.kind}:${p.id}`} className="nws-chip">
            {p.kind === 'user'
              ? <Avatar name={p.name} seed={p.id} src={byId.get(p.id)?.avatar} person size={20} />
              : <Building2 size={14} aria-hidden="true" />}
            <span className="nws-chip-name">{p.name}</span>
            <button type="button" className="nws-chip-x" aria-label={`Убрать: ${p.name}`} onClick={() => setPicked((cur) => cur.filter((x) => x !== p))}><X size={12} /></button>
          </span>
        ))}
        <input
          ref={input}
          className="nws-picker-input"
          value={query}
          placeholder={picked.length ? 'Ещё кого-нибудь…' : 'Добавьте людей или отделы'}
          role="combobox"
          aria-label="Кому дать доступ: имя, должность или отдел"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList ? optionId(active) : undefined}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(0); }}
          onFocus={() => { if (!picked.length) setOpen(true); }}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
      </div>
      {showList && (
        <ul id={listId} role="listbox" className="nws-picker-list" aria-label="Подсказки">
          {[options.deptsFirst ? 'depts' : 'people', options.deptsFirst ? 'people' : 'depts'].map((group, g) => {
            const list = group === 'people' ? options.people : options.depts;
            const offset = g === 0 ? 0 : (options.deptsFirst ? options.depts.length : options.people.length);
            return list.length > 0 && [
              <li key={`h-${group}`} role="presentation" className="nws-picker-group">{group === 'people' ? 'Люди' : 'Отделы'}</li>,
              ...list.map((o, i) => renderOption(o, offset + i)),
            ];
          })}
        </ul>
      )}
      </div>
      {open && query && !options.all.length && <p className="nws-picker-empty">Никого не нашли по «{query}» — попробуйте фамилию, должность или отдел.</p>}
      {picked.length > 0 && (
        <div className="nws-picker-actions">
          <Select className="nws-select" label="Права" value={role} onChange={setRole} groups={[{ options: roles }]} />
          <button type="button" className="nx-primary" disabled={busy} onClick={() => void submit()}>{submitLabel(picked)}</button>
        </div>
      )}
    </div>
  );
}
