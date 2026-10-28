import { useEffect, useState, type CSSProperties } from 'react';
import {
  ArrowLeft, AtSign, CalendarDays, Clock, Mail, Phone, Send, Shield, UserRound,
} from 'lucide-react';
import { useNavigate } from 'react-router';
import { links } from '@/shared/navigation/routes';
import { showToast } from '@/shared/ui/Toast';
import { Avatar } from '@/shared/ui/Avatar';
import { lastSeenText } from '@/shared/ui/format';
import { SectionIcon } from '@/shared/ui/SectionIcon';
import { Menu, MenuItem, type MenuAnchor } from '@/shared/ui/overlay';
import { contactName, readMe, type Contact, type Department } from './data';
import { Spinner } from '@/shared/ui/Spinner';
import { MailLink } from '@/features/mail/MailLink';

/**
 * Карточка сотрудника — правая область мастер-детали.
 *
 * Одно основное действие — «Написать» (заливка); остальное — ghost и значки
 * (доктрина §1.2). Задачи с человеком видят только админ и руководитель его
 * отдела — так же, как на старой странице.
 */

interface TodoList { id: string; name: string; color?: string; creatorId?: string; allowedUsers?: string[] }
interface Todo {
  id: string; title: string; completed?: boolean; archived?: boolean; status?: string; dueDate?: string;
  assignedToId?: string; assignedToIds?: string[]; assignedById?: string;
}

const STATUS: Record<string, { label: string; tone?: 'ok' | 'live' | 'warn' | 'danger' }> = {
  todo: { label: 'К выполнению' },
  'in-progress': { label: 'В работе', tone: 'live' },
  pending: { label: 'В ожидании', tone: 'warn' },
  review: { label: 'На проверке', tone: 'live' },
  stuck: { label: 'Застряла', tone: 'danger' },
  cancelled: { label: 'Отменена' },
};

const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const shortFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });

function safeDate(iso?: string, fmt = dateFmt): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : fmt.format(d);
}

/** Адрес личного чата с сотрудником (создаёт чат, если его ещё нет). */
async function chatUrlWith(contact: Contact): Promise<string | null> {
  const me = readMe();
  const myId = String(me?.id ?? '');
  if (!myId) return null;
  if (contact.id === myId) return links.chat(`favorites_${myId}`);
  const res = await fetch('/api/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ participantIds: [myId, contact.id], isGroup: false }),
  });
  if (!res.ok) throw new Error(String(res.status));
  const chat = (await res.json()) as { id?: string };
  if (!chat?.id) throw new Error('no chat id');
  return links.chat(chat.id);
}

export default function ContactDetail({ contact, departments, onBack }: {
  contact: Contact; departments: Department[]; onBack: () => void;
}) {
  const navigate = useNavigate();
  const me = readMe();
  const myId = String(me?.id ?? '');
  const name = contactName(contact);
  const [opening, setOpening] = useState(false);
  const [taskAnchor, setTaskAnchor] = useState<MenuAnchor | null>(null);
  const [lists, setLists] = useState<TodoList[] | null>(null);
  const [todos, setTodos] = useState<Todo[] | null>(null);

  const deptIds = contact.departmentIds?.length ? contact.departmentIds : contact.department ? [contact.department] : [];
  const depts = deptIds.map((id) => departments.find((d) => d.id === id) || { id, name: id } as Department);
  const canSeeTasks = me?.role === 'admin' || Boolean(me?.isDepartmentHead && me?.department && deptIds.includes(me.department));

  // Карточка пересоздаётся на каждого сотрудника (key в ContactsScreen) —
  // сбрасывать todos здесь не нужно.
  useEffect(() => {
    if (!canSeeTasks || !myId) return undefined;
    let alive = true;
    fetch(`/api/todos?userId=${encodeURIComponent(myId)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive) return;
        const all: Todo[] = Array.isArray(d?.todos) ? d.todos : [];
        setTodos(all.filter((t) => !t.archived && (
          t.assignedToId === contact.id || t.assignedToIds?.includes(contact.id) || t.assignedById === contact.id
        )));
      })
      .catch(() => { if (alive) setTodos([]); });
    return () => { alive = false; };
  }, [contact.id, canSeeTasks, myId]);

  const write = async () => {
    setOpening(true);
    try {
      const url = await chatUrlWith(contact);
      // Переход внутри каркаса — без перезагрузки: чаты и соединение уже живы.
      if (url) navigate(url); else setOpening(false);
    } catch {
      setOpening(false);
      showToast('Не открыл чат — нет связи с сервером. Попробуйте ещё раз.', 'error');
    }
  };

  const openTaskMenu = (el: HTMLElement) => {
    setTaskAnchor({ element: el, side: 'below' });
    if (lists) return;
    fetch('/api/todos', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const all: TodoList[] = Array.isArray(d?.lists) ? d.lists : [];
        setLists(all.filter((l) => l.creatorId === myId || l.allowedUsers?.includes(myId)));
      })
      .catch(() => setLists([]));
  };

  const createTask = (listId: string) => {
    const qs = new URLSearchParams({
      createTask: 'true', listId, assignTo: contact.id, assignToName: name,
      authorId: myId, authorName: me?.name || me?.username || '',
    });
    window.location.assign(`/todos?${qs}`); // задачи пока в текущей версии
  };

  const since = safeDate(contact.createdAt);
  const open = (todos || []).filter((t) => !t.completed);

  return (
    <section className="ctd" aria-label={`Сотрудник: ${name}`}>
      <header className="ctd-bar">
        <button type="button" className="nx-icon-btn ctd-back" onClick={onBack} aria-label="К списку контактов">
          <ArrowLeft size={20} aria-hidden="true" />
        </button>
      </header>

      <div className="ctd-scroll nx-scroll-y">
        <div className="ctd-column">
          <div className="ctd-hero">
            <Avatar name={name} seed={contact.id} src={contact.avatar} person online={Boolean(contact.isOnline)} size={96} />
            <h2>{name}</h2>
            {contact.position && <p className="ctd-position">{contact.position}</p>}
            <p className="ctd-presence" data-live={contact.isOnline ? 'true' : undefined}>
              {lastSeenText(contact.lastSeen, contact.isOnline) || 'Не в сети'}
            </p>
            {depts.length > 0 && (
              <div className="ctd-depts">
                {depts.map((d) => (
                  <span key={d.id} className="ctd-dept" style={d.color ? ({ '--dept': d.color } as CSSProperties) : undefined}>
                    <i aria-hidden="true" />{d.name}
                  </span>
                ))}
                {contact.isDepartmentHead && <span className="ctd-chip">Руководитель</span>}
              </div>
            )}
          </div>

          <div className="ctd-actions">
            <button type="button" className="nx-primary ctd-write" onClick={() => void write()} disabled={opening} aria-busy={opening || undefined}>
              {opening ? <Spinner size={16} /> : <SectionIcon name="chats" size={20} />}
              {opening ? 'Открываю чат' : contact.id === myId ? 'Избранное' : 'Написать'}
            </button>
            {contact.id !== myId && (
              <button
                type="button"
                className="nx-ghost"
                aria-haspopup="menu"
                aria-label="Поставить задачу"
                aria-expanded={Boolean(taskAnchor)}
                onClick={(e) => (taskAnchor ? setTaskAnchor(null) : openTaskMenu(e.currentTarget))}
              >
                <SectionIcon name="todo" size={20} />
                <span className="ctd-task-long">Поставить задачу</span>
                <span className="ctd-task-short" aria-hidden="true">Задача</span>
              </button>
            )}
            {contact.phone && (
              <a className="nx-icon-btn ctd-round" href={`tel:${contact.phone.replace(/[^\d+]/g, '')}`} aria-label={`Позвонить: ${contact.phone}`}>
                <Phone size={18} aria-hidden="true" />
              </a>
            )}
            {contact.email && (
              <MailLink email={contact.email} className="nx-icon-btn ctd-round" aria-label={`Написать письмо: ${contact.email}`}>
                <SectionIcon name="mail" size={22} />
              </MailLink>
            )}
          </div>

          <dl className="ctd-info">
            {contact.email && <Row icon={<Mail size={16} />} label="Почта"><MailLink email={contact.email} /></Row>}
            {contact.phone && <Row icon={<Phone size={16} />} label="Телефон"><a href={`tel:${contact.phone.replace(/[^\d+]/g, '')}`}>{contact.phone}</a></Row>}
            {contact.telegramUsername && (
              <Row icon={<Send size={16} />} label="Telegram">
                <a href={`https://t.me/${contact.telegramUsername.replace(/^@/, '')}`} target="_blank" rel="noopener noreferrer">@{contact.telegramUsername.replace(/^@/, '')}</a>
              </Row>
            )}
            {contact.username && <Row icon={<AtSign size={16} />} label="Логин">{contact.username}</Row>}
            {contact.workSchedule && <Row icon={<Clock size={16} />} label="График">{contact.workSchedule}</Row>}
            {contact.role === 'admin' && <Row icon={<Shield size={16} />} label="Доступ">Администратор</Row>}
            {since && <Row icon={<CalendarDays size={16} />} label="В Шаре">с {since}</Row>}
            {!contact.email && !contact.phone && !contact.telegramUsername && !contact.workSchedule && (
              <Row icon={<UserRound size={16} />} label="Контакты">Сотрудник ещё не указал почту и телефон</Row>
            )}
          </dl>

          {canSeeTasks && contact.id !== myId && (
            <section className="ctd-tasks" aria-label="Задачи">
              <h3>
                Задачи
                {todos && <span className="nx-count" data-muted="true">{open.length}</span>}
              </h3>
              {!todos ? (
                <div className="nx-skel-lines ctd-tasks-skel" aria-busy="true"><span className="nx-skel nx-skel-line" /><span className="nx-skel nx-skel-line" /></div>
              ) : !open.length ? (
                <p className="ctd-empty">Открытых задач с этим сотрудником нет.</p>
              ) : (
                <ul>
                  {open.slice(0, 20).map((t) => {
                    const st = STATUS[t.status || 'todo'] || STATUS.todo;
                    const due = safeDate(t.dueDate, shortFmt);
                    return (
                      <li key={t.id}>
                        <a className="ctd-task" href={`/todos?task=${encodeURIComponent(t.id)}`}>
                          <span className="ctd-task-title">{t.title}</span>
                          <span className="ctd-task-meta">
                            {due && <span>до {due}</span>}
                            <span className="ctd-chip" data-tone={st.tone}>{st.label}</span>
                          </span>
                        </a>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}
        </div>
      </div>

      {taskAnchor && (
        <Menu anchor={taskAnchor} label="Список для задачи" onClose={() => setTaskAnchor(null)}>
          <div className="nx-menu-note"><b>В какой список</b>Задача откроется с {name} исполнителем.</div>
          {lists === null ? (
            <div className="nx-menu-note" aria-busy="true"><Spinner size={14} /></div>
          ) : !lists.length ? (
            <div className="nx-menu-note">Нет списков, куда вы можете добавлять задачи.</div>
          ) : lists.map((l) => (
            <MenuItem
              key={l.id}
              icon={<span className="ctd-list-dot" style={{ '--dot': l.color || 'var(--note-gray)' } as CSSProperties} />}
              onSelect={() => { setTaskAnchor(null); createTask(l.id); }}
            >
              {l.name}
            </MenuItem>
          ))}
        </Menu>
      )}
    </section>
  );
}

function Row({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="ctd-row">
      <span className="ctd-row-icon" aria-hidden="true">{icon}</span>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
