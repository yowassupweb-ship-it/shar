import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import {
  AlertCircle, ArrowLeft, CalendarDays, Check, ChevronDown, Eye, Flag, FolderClosed, Loader2, MoreHorizontal, Pencil,
  Repeat, Search, Trash2, UserPlus,
} from 'lucide-react';
import { showToast } from '@/shared/ui/Toast';
import { displayName, useChatStore } from '@/features/chat';
import { Avatar } from '@/shared/ui/Avatar';
import { askConfirm, Menu, MenuItem, Sheet, type MenuAnchor } from '@/shared/ui/overlay';
import {
  assigneesOf, deleteTask, relevantLists, isDone, myId, PRIORITIES, saveText, STATUSES, statusOf, taskMarkdown, updateTask, useTasks,
  type Priority, type Status, type Task,
} from './api';
import { renderMarkdown, toggleTaskLine } from './markdown';
import { repeatIdOf, repeatLabel, syncTaskRepeat, TASK_REPEATS } from './repeat';
import { DatePicker } from '@/shared/ui/DatePicker';
import { continueList, MarkdownToolbar, markdownShortcut, replaceRange } from './MarkdownToolbar';

/**
 * Задача — документ, как заметка MBOX: первая строка — крупный заголовок,
 * дальше markdown с панелью форматирования. Два режима — «Просмотр» (чек-лист
 * кликается прямо в тексте) и «Правка»; пустая задача сразу в правке.
 * Сохраняется само через 700 мс после последней правки и при уходе.
 * Сверху — свойства задачи: статус, исполнители, срок, важность, список.
 */

const SAVE_DELAY = 700;
type SaveState = 'saved' | 'pending' | 'saving' | 'error';

const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
export function dueLabel(iso?: string | null): { text: string; late: boolean } | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((day.getTime() - today.getTime()) / 86400000);
  const text = diff === 0 ? 'Сегодня' : diff === 1 ? 'Завтра' : diff === -1 ? 'Вчера' : dateFmt.format(d);
  return { text, late: diff < 0 };
}

export default function TaskDocument({ task, onBack, onGone }: {
  task: Task;
  onBack: () => void;
  onGone: () => void;
}) {
  const initial = useMemo(() => {
    const md = taskMarkdown(task);
    return { title: task.title || '', md };
    // Документ живёт, пока открыта эта задача: чужие правки текста подхватываем ниже.
  }, [task.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [title, setTitle] = useState(initial.title);
  const [md, setMd] = useState(initial.md);
  const [mode, setMode] = useState<'edit' | 'preview'>(() => (initial.title || initial.md.trim() ? 'preview' : 'edit'));
  const [state, setState] = useState<SaveState>('saved');
  const saved = useRef(initial);
  const latest = useRef(initial);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [menu, setMenu] = useState<{ kind: 'status' | 'priority' | 'list' | 'more' | 'date' | 'repeat'; anchor: MenuAnchor } | null>(null);
  const [people, setPeople] = useState<'assignees' | 'customer' | null>(null);
  const users = useChatStore((s) => s.users);
  const allLists = useTasks((s) => s.lists);
  const tasksById = useTasks((s) => s.tasks);
  // Только «свои» списки: созданные мной, открытые мне, или где есть мои задачи.
  const lists = useMemo(() => relevantLists(allLists, tasksById, task.listId), [allLists, tasksById, task.listId]);

  useEffect(() => { latest.current = { title, md }; }, [title, md]);

  const save = useCallback(async () => {
    const cur = latest.current;
    if (cur.title === saved.current.title && cur.md === saved.current.md) { setState('saved'); return; }
    setState('saving');
    try {
      await saveText(task.id, cur.title.trim(), cur.md);
      saved.current = cur;
      setState(latest.current === cur ? 'saved' : 'pending');
    } catch {
      setState('error');
    }
  }, [task.id]);

  // Автосохранение.
  useEffect(() => {
    if (title === saved.current.title && md === saved.current.md) return undefined;
    setState('pending');
    const t = window.setTimeout(() => void save(), SAVE_DELAY);
    return () => window.clearTimeout(t);
  }, [title, md, save]);

  // Уход с задачи: досохранить. Пустую новую убирает экран списка — при
  // смене задачи, а не здесь: StrictMode вызывает эту очистку сразу после
  // монтирования, и новая задача удалялась бы на глазах.
  useEffect(() => () => {
    const cur = latest.current;
    if (cur.title !== saved.current.title || cur.md !== saved.current.md) void saveText(task.id, cur.title.trim(), cur.md).catch(() => {});
  }, [task.id]);

  // Чужая правка текста (коллега, старый экран): без своих несохранённых — берём.
  const remoteMd = taskMarkdown(task);
  useEffect(() => {
    const mine = latest.current.title !== saved.current.title || latest.current.md !== saved.current.md;
    if (mine) return;
    if (task.title === saved.current.title && remoteMd === saved.current.md) return;
    saved.current = { title: task.title || '', md: remoteMd };
    setTitle(task.title || '');
    setMd(remoteMd);
  }, [task.title, remoteMd]);

  const finishEditing = useCallback(() => { void save(); setMode('preview'); }, [save]);

  // Ctrl+S — сохранить сейчас; Esc в правке — «Готово» (если не открыт лист или меню).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
      if (e.key === 'Escape' && mode === 'edit' && !document.querySelector('.nx-scrim, .nx-menu')) { e.preventDefault(); finishEditing(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save, mode, finishEditing]);

  // В правке — фокус в заголовок (пустой) или в текст.
  useEffect(() => {
    if (mode !== 'edit') return;
    (latest.current.title ? bodyRef.current : titleRef.current)?.focus();
  }, [mode, task.id]);

  // Высота полей по содержимому — страница прокручивается целиком, как документ.
  useEffect(() => {
    for (const el of [titleRef.current, bodyRef.current]) {
      if (!el) continue;
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [title, md, mode]);

  // Успех видно по самой задаче — всплывашки только об ошибках, иначе их сыпалось по штуке на клик.
  const patch = async (p: Partial<Task>) => {
    try { await updateTask(task.id, p); } catch { showToast('Не сохранилось — нет связи с сервером.', 'error'); }
  };

  const remove = async () => {
    if ((title.trim() || md.trim()) && !(await askConfirm({ title: 'Удалить задачу?', text: 'Она пропадёт у всех исполнителей. Вернуть не получится.', confirm: 'Удалить', tone: 'danger' }))) return;
    try { await deleteTask(task.id); onGone(); } catch { showToast('Не удалил — нет прав или нет связи с сервером.', 'error'); }
  };

  // Картинка из буфера или выбором → загрузка → ![имя](адрес).
  const insertImages = async (files: File[]) => {
    const el = bodyRef.current;
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (!el || !images.length) return;
    const { uploadFileWithProgress } = await import('@/shared/api/uploadFile');
    for (const file of images) {
      const name = (file.name && file.name !== 'image.png' ? file.name : `картинка.${(file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`);
      const placeholder = `![Загрузка ${name}…]()`;
      const at = el.selectionStart;
      replaceRange(el, at, el.selectionEnd, `${placeholder}\n`, at + placeholder.length + 1, at + placeholder.length + 1);
      try {
        const res = await uploadFileWithProgress(file, () => {});
        const i = el.value.indexOf(placeholder);
        const mdImg = `![${name.replace(/\.[a-z0-9]+$/i, '')}](${res.url})`;
        if (i >= 0) replaceRange(el, i, i + placeholder.length, mdImg, i + mdImg.length, i + mdImg.length);
      } catch {
        const i = el.value.indexOf(placeholder);
        if (i >= 0) replaceRange(el, i, i + placeholder.length + 1, '', i, i);
        showToast('Картинка не загрузилась — проверьте связь.', 'error');
      }
    }
  };

  const onTitleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.key === 'Enter' && !e.nativeEvent.isComposing) || e.key === 'ArrowDown') {
      e.preventDefault();
      const el = bodyRef.current;
      el?.focus();
      el?.setSelectionRange(0, 0);
    }
  };
  const onBodyKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (markdownShortcut(e) || continueList(e)) return;
    const el = e.currentTarget;
    if ((e.key === 'Backspace' || e.key === 'ArrowUp') && el.selectionStart === 0 && el.selectionEnd === 0) {
      e.preventDefault();
      const t = titleRef.current;
      t?.focus();
      t?.setSelectionRange(t.value.length, t.value.length);
    }
  };

  const repeat = repeatIdOf(task);
  // Повтор: пометка в задаче + серия сроков в календаре на месяц вперёд.
  const setRepeat = async (id: string) => {
    try {
      await patch({ metadata: { ...(task.metadata || {}), repeat: id === 'none' ? null : id } });
      await syncTaskRepeat({ ...task, metadata: { ...(task.metadata || {}), repeat: id } }, id);
    } catch {
      showToast('Повтор не сохранился — нет связи с сервером.', 'error');
    }
  };

  const status = statusOf(task);
  const statusInfo = STATUSES.find((s) => s.id === status) || STATUSES[1];
  const done = isDone(task);
  const assignees = assigneesOf(task);
  const due = dueLabel(task.dueDate);
  const list = lists.find((l) => l.id === task.listId);
  const priority = PRIORITIES.find((p) => p.id === (task.priority || 'medium'))!;
  const customer = task.assignedById ? users[String(task.assignedById)] : undefined;
  const open = (kind: 'status' | 'priority' | 'list' | 'more' | 'date' | 'repeat') => (e: React.MouseEvent<HTMLButtonElement>) => setMenu({ kind, anchor: { element: e.currentTarget, align: kind === 'more' ? 'end' : 'start' } });

  return (
    <section className="ntd" aria-label={title || 'Задача'}>
      <header className="ntd-bar">
        <button type="button" className="nx-icon-btn ntd-back" onClick={onBack} aria-label="К списку задач"><ArrowLeft size={20} aria-hidden="true" /></button>
        {/* Одна кнопка режима, как «Править / Готово» в iOS: всегда видно, в каком режиме
            документ и как из него выйти. Esc в правке — тоже «Готово». */}
        {mode === 'preview' ? (
          <button type="button" className="nx-ghost ntd-mode" onClick={() => setMode('edit')}>
            <Pencil size={15} aria-hidden="true" /> Редактировать
          </button>
        ) : (
          <button type="button" className="nx-primary ntd-mode" onClick={finishEditing}>
            <Eye size={15} aria-hidden="true" /> Готово
          </button>
        )}
        <span className="ntd-save" aria-live="polite">
          {state === 'error' ? <span data-tone="danger"><AlertCircle size={13} aria-hidden="true" /> Не сохранилось — Ctrl+S</span>
            : state === 'saving' || state === 'pending' ? <span><Loader2 size={13} className="nx-spin" aria-hidden="true" /> Сохраняю</span>
              : <span><Check size={13} aria-hidden="true" /> Сохранено</span>}
        </span>
        <button type="button" className="nx-icon-btn" onClick={open('more')} aria-label="Ещё действия" aria-haspopup="menu"><MoreHorizontal size={18} /></button>
      </header>

      <div className="ntd-props" role="group" aria-label="Свойства задачи">
        <button type="button" className="ntd-chip" data-done={done ? 'true' : undefined} onClick={() => void patch({ isCompleted: !done, completed: !done })}>
          <span className="ntd-done-box" aria-hidden="true">{done && <Check size={12} strokeWidth={3} />}</span>
          {done ? 'Выполнена' : 'Выполнить'}
        </button>
        <button type="button" className="ntd-chip" style={{ '--tone': statusInfo.tone } as CSSProperties} onClick={open('status')} aria-haspopup="menu">
          <i className="ntd-dot" aria-hidden="true" />{statusInfo.label}<ChevronDown size={13} aria-hidden="true" />
        </button>
        <button type="button" className="ntd-chip" onClick={() => setPeople('customer')} aria-label="Заказчик">
          {customer ? <Avatar name={displayName(customer)} seed={String(customer.id)} src={customer.avatar} person size={20} /> : <UserPlus size={14} aria-hidden="true" />}
          <span className="ntd-chip-label">Заказчик</span>
          {customer ? (String(customer.id) === myId() ? 'я' : displayName(customer)) : 'не указан'}
        </button>
        <button type="button" className="ntd-chip" onClick={() => setPeople('assignees')} aria-label="Исполнители">
          <span className="ntd-chip-label">Исполнитель</span>
          {assignees.length ? (
            <span className="ntd-faces">
              {assignees.slice(0, 3).map((id) => { const u = users[id]; return <Avatar key={id} name={displayName(u) || '?'} seed={id} src={u?.avatar} person size={20} />; })}
            </span>
          ) : <UserPlus size={14} aria-hidden="true" />}
          {assignees.length === 1 ? (assignees[0] === myId() ? 'Мне' : displayName(users[assignees[0]]) || 'Исполнитель') : assignees.length ? `${assignees.length} исполнителя` : 'Исполнитель'}
        </button>
        <button type="button" className="ntd-chip" data-tone={due?.late && !done ? 'danger' : undefined} onClick={open('date')} aria-haspopup="menu">
          <CalendarDays size={14} aria-hidden="true" />
          {due ? due.text : 'Срок'}
        </button>
        <button type="button" className="ntd-chip" data-on={repeat !== 'none' ? 'true' : undefined} onClick={open('repeat')} aria-haspopup="menu" title="Повторять задачу — сроки на месяц вперёд в календаре">
          <Repeat size={14} aria-hidden="true" />{repeat !== 'none' ? repeatLabel(repeat) : 'Повтор'}
        </button>
        <button type="button" className="ntd-chip" data-priority={task.priority || 'medium'} onClick={open('priority')} aria-haspopup="menu">
          <Flag size={14} aria-hidden="true" />{priority.label}
        </button>
        {lists.length > 0 && (
          <button type="button" className="ntd-chip" onClick={open('list')} aria-haspopup="menu" style={list?.color ? ({ '--tone': list.color } as CSSProperties) : undefined}>
            <FolderClosed size={14} aria-hidden="true" />{list?.name || 'Без списка'}
          </button>
        )}
      </div>

      {mode === 'edit' && <MarkdownToolbar targetRef={bodyRef} onPickImages={(f) => void insertImages(f)} />}

      <div className="ntd-scroll nx-scroll-y">
        {mode === 'edit' ? (
          <div className="ntd-page">
            <textarea
              ref={titleRef}
              className="ntd-title"
              rows={1}
              value={title}
              onChange={(e) => setTitle(e.target.value.replace(/\n/g, ' '))}
              onKeyDown={onTitleKey}
              onBlur={() => void save()}
              placeholder="Что нужно сделать"
              aria-label="Заголовок задачи"
            />
            <textarea
              ref={bodyRef}
              className="ntd-body"
              value={md}
              onChange={(e) => setMd(e.target.value)}
              onKeyDown={onBodyKey}
              onBlur={() => void save()}
              onPaste={(e) => { const files = [...e.clipboardData.files]; if (files.some((f) => f.type.startsWith('image/'))) { e.preventDefault(); void insertImages(files); } }}
              onDrop={(e) => { const files = [...e.dataTransfer.files]; if (files.some((f) => f.type.startsWith('image/'))) { e.preventDefault(); void insertImages(files); } }}
              placeholder={'Подробности, чек-лист, ссылки. Панель сверху или Ctrl+B, Ctrl+Shift+9 — чек-лист. Картинку можно вставить из буфера. Сохраняется само.'}
              aria-label="Текст задачи"
            />
          </div>
        ) : (
          <article className="ntd-page ntd-read" onDoubleClick={() => setMode('edit')}>
            <h1 className="ntd-title-view" data-done={done ? 'true' : undefined}>{title || 'Без названия'}</h1>
            {md.trim()
              ? <div className="ntd-md">{renderMarkdown(md, { onToggleTask: (line) => setMd((cur) => toggleTaskLine(cur, line)) })}</div>
              : <p className="ntd-empty">Описания нет. Двойной клик или «Правка» — добавить подробности и чек-лист.</p>}
          </article>
        )}
      </div>

      {menu?.kind === 'status' && (
        <Menu anchor={menu.anchor} label="Статус" onClose={() => setMenu(null)}>
          {STATUSES.map((s) => (
            <MenuItem key={s.id} icon={s.id === status ? <Check size={16} /> : <i className="ntd-dot" style={{ '--tone': s.tone } as CSSProperties} />} onSelect={() => { setMenu(null); void patch({ status: s.id as Status }); }}>{s.label}</MenuItem>
          ))}
        </Menu>
      )}
      {menu?.kind === 'priority' && (
        <Menu anchor={menu.anchor} label="Важность" onClose={() => setMenu(null)}>
          {PRIORITIES.map((p) => (
            <MenuItem key={p.id} icon={p.id === (task.priority || 'medium') ? <Check size={16} /> : <span className="ntd-menu-gap" />} onSelect={() => { setMenu(null); void patch({ priority: p.id as Priority }); }}>{p.label}</MenuItem>
          ))}
        </Menu>
      )}
      {menu?.kind === 'repeat' && (
        <Menu anchor={menu.anchor} label="Повтор" onClose={() => setMenu(null)}>
          {TASK_REPEATS.map((r) => (
            <MenuItem key={r.id} icon={r.id === repeat ? <Check size={16} /> : <span className="ntd-menu-gap" />} onSelect={() => { setMenu(null); void setRepeat(r.id); }}>{r.label}</MenuItem>
          ))}
        </Menu>
      )}
      {menu?.kind === 'date' && (
        <DatePicker anchor={menu.anchor} value={task.dueDate ? String(task.dueDate) : null} onPick={(iso) => {
          void patch({ dueDate: iso }).then(() => {
            // Повторяющаяся задача: серия в календаре идёт от нового срока.
            if (repeat !== 'none') syncTaskRepeat({ ...task, dueDate: iso }, repeat).catch(() => showToast('Календарь не обновился — нет связи с сервером.', 'error'));
          });
        }} onClose={() => setMenu(null)} />
      )}
      {menu?.kind === 'list' && (
        <Menu anchor={menu.anchor} label="Список" onClose={() => setMenu(null)}>
          {lists.map((l) => (
            <MenuItem key={l.id} icon={l.id === task.listId ? <Check size={16} /> : <i className="ntd-dot" style={{ '--tone': l.color || 'var(--note-gray)' } as CSSProperties} />} onSelect={() => { setMenu(null); void patch({ listId: l.id }); }}>{l.name}</MenuItem>
          ))}
        </Menu>
      )}
      {menu?.kind === 'more' && (
        <Menu anchor={menu.anchor} label="Задача" onClose={() => setMenu(null)}>
          <MenuItem icon={<Trash2 size={16} />} tone="danger" onSelect={() => { setMenu(null); void remove(); }}>Удалить задачу</MenuItem>
        </Menu>
      )}
      {people === 'assignees' && <PeopleSheet title="Исполнители" selected={assignees} onClose={() => setPeople(null)} onSave={(ids) => { setPeople(null); void patch({ assignedToIds: ids, assignedToId: ids[0] || null }); }} />}
      {people === 'customer' && (
        <PeopleSheet
          title="Заказчик"
          single
          selected={task.assignedById ? [String(task.assignedById)] : []}
          onClose={() => setPeople(null)}
          onSave={(ids) => { setPeople(null); const u = users[ids[0]]; void patch({ assignedById: ids[0] || null, assignedBy: u ? displayName(u) : null }); }}
        />
      )}
    </section>
  );
}

/** Выбор людей: исполнители — несколько, заказчик — один (выбор сразу сохраняется). */
function PeopleSheet({ title, single, selected, onClose, onSave }: { title: string; single?: boolean; selected: string[]; onClose: () => void; onSave: (ids: string[]) => void }) {
  const users = useChatStore((s) => s.users);
  const [pick, setPick] = useState<string[]>(selected);
  const [query, setQuery] = useState('');
  const me = myId();
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(users)
      .filter((u) => !q || displayName(u).toLowerCase().includes(q))
      .sort((a, b) => Number(String(b.id) === me) - Number(String(a.id) === me) || displayName(a).localeCompare(displayName(b), 'ru'));
  }, [users, query, me]);
  const toggle = (id: string) => {
    if (single) { onSave([id]); return; }
    setPick((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  };
  return (
    <Sheet
      title={title}
      onClose={onClose}
      footer={single ? undefined : (
        <>
          <button type="button" className="nx-ghost" onClick={onClose}>Отмена</button>
          <button type="button" className="nx-primary" onClick={() => onSave(pick)}>Готово{pick.length ? ` · ${pick.length}` : ''}</button>
        </>
      )}
    >
      <label className="nx-field" data-variant="filter">
        <Search size={14} aria-hidden="true" />
        <span className="nx-sr">Найти сотрудника</span>
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти сотрудника" autoComplete="off" autoFocus />
      </label>
      <div className="ntd-people">
        {list.map((u) => {
          const id = String(u.id);
          return (
            <button key={id} type="button" className="nx-pick" aria-pressed={pick.includes(id)} onClick={() => toggle(id)}>
              <Avatar name={displayName(u)} seed={id} src={u.avatar} person size={32} />
              <span className="nx-pick-text"><span>{id === me ? `${displayName(u)} (я)` : displayName(u)}</span></span>
              {pick.includes(id) && <Check size={16} className="ntd-picked" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}
