import { useMemo, useState } from 'react';
import { Check, Search } from 'lucide-react';
import { Avatar } from '@/shared/ui/Avatar';
import { Sheet } from '@/shared/ui/overlay';
import { plural } from '@/shared/ui/format';
import { createChat } from './actions';
import { displayName, useChatStore } from './store';

/** Новый личный или групповой чат — перенос NewChatModal. */
export default function NewChatSheet({ group: initialGroup, onClose, onCreated }: {
  group: boolean; onClose: () => void; onCreated: (chatId: string) => void;
}) {
  const me = useChatStore((s) => s.me);
  const users = useChatStore((s) => s.users);
  const [group, setGroup] = useState(initialGroup);
  const [title, setTitle] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const people = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(users)
      .filter((u) => String(u.id) !== String(me?.id))
      .filter((u) => !q || [u.name, u.username, u.email].some((v) => String(v || '').toLowerCase().includes(q)))
      .sort((a, b) => displayName(a).localeCompare(displayName(b), 'ru'));
  }, [users, me, query]);

  const canCreate = selected.length > 0 && (!group || title.trim().length > 0) && !busy;

  const toggle = (id: string) => {
    setError('');
    if (group) setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
    else setSelected([id]);
  };

  const submit = async () => {
    if (!canCreate) return;
    setBusy(true);
    setError('');
    const id = await createChat(selected, group ? { title } : undefined);
    setBusy(false);
    if (id) onCreated(id);
    else setError('Чат не создался: сервер не ответил. Проверьте связь и повторите.');
  };

  return (
    <Sheet
      title={group ? 'Новая группа' : 'Новый чат'}
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          <button type="button" className="nx-ghost" onClick={onClose}>Отмена</button>
          <button type="button" className="nx-primary" disabled={!canCreate} onClick={() => void submit()}>
            {busy ? 'Создаю' : group ? 'Создать группу' : 'Начать чат'}
          </button>
        </>
      )}
    >
      <div className="cxs-controls">
        <div className="nx-segment" role="group" aria-label="Тип чата">
          <button type="button" aria-pressed={!group} onClick={() => { setGroup(false); setSelected((s) => s.slice(0, 1)); }}>Личный</button>
          <button type="button" aria-pressed={group} onClick={() => setGroup(true)}>Группа</button>
        </div>
        {group && (
          <label className="nx-field">
            <span className="nx-sr">Название группы</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Название группы" maxLength={120} />
          </label>
        )}
        <label className="nx-field" data-variant="filter">
          <Search size={15} aria-hidden="true" />
          <span className="nx-sr">Поиск сотрудника</span>
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск" autoFocus />
        </label>
        {group && selected.length > 0 && (
          <p className="nx-hint">Выбрано: {selected.length} {plural(selected.length, ['человек', 'человека', 'человек'])}</p>
        )}
      </div>
      {error && <p className="nx-error" role="alert">{error}</p>}
      <div role={group ? 'group' : 'radiogroup'} aria-label="Сотрудники">
        {people.length === 0 && <p className="nx-hint">Никого не нашлось.</p>}
        {people.map((u) => {
          const id = String(u.id);
          const on = selected.includes(id);
          return (
            <button
              key={id}
              type="button"
              role={group ? 'checkbox' : 'radio'}
              aria-checked={on}
              className="nx-pick"
              onClick={() => toggle(id)}
              onDoubleClick={() => { if (!group) void submit(); }}
            >
              <span className="nx-check">{on && <Check size={12} strokeWidth={3} aria-hidden="true" />}</span>
              <Avatar name={displayName(u)} seed={id} src={u.avatar} person online={u.isOnline} size={36} />
              <span className="nx-pick-text">
                <span>{displayName(u)}</span>
                {(u as { position?: string }).position && <span>{(u as { position?: string }).position}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}
