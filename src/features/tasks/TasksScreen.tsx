import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { AlertCircle, CalendarDays, CalendarX, Check, ChevronRight, CircleCheck, Copy, ExternalLink, Flag, Plus, RotateCcw, RotateCw, Search, Trash2 } from 'lucide-react';
import { showToast } from '@/shared/ui/Toast';
import { displayName, useChatStore } from '@/features/chat';
import { useShellOptions } from '@/shared/shell/ShellContext';
import { Avatar } from '@/shared/ui/Avatar';
import { plural } from '@/shared/ui/format';
import { SearchField } from '@/shared/ui/SearchField';
import { SectionIcon } from '@/shared/ui/SectionIcon';
import { useLongPress } from '@/shared/ui/useLongPress';
import { askConfirm, Menu, MenuItem, type MenuAnchor } from '@/shared/ui/overlay';
import Splitter from '@/shared/ui/Splitter';
import {
  assigneesOf, createTask, deleteTask, isDone, loadTasks, myId, STATUSES, statusOf, type Status, taskMarkdown, updateTask, useTasks, type Task,
} from './api';
import { checklistProgress, plainSnippet } from './markdown';
import TaskDocument, { dueLabel } from './TaskDocument';
import { absolute, links } from '@/shared/navigation/routes';

/**
 * Раздел «Задачи» нового шара: мастер-деталь, как контакты. Слева — поиск,
 * «Мне / Поручил / Все» и задачи по статусам; справа — задача-документ.
 * На телефоне (≤640px) — одна область за раз. Адрес задачи — `?task=<id>`.
 */

const NARROW = '(max-width: 640px)';
const subscribeMedia = (cb: () => void) => {
  const mq = window.matchMedia(NARROW);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
};
const subscribeNoop = () => () => {};

function readTaskParam(): string | null {
  return typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('task');
}
function writeTaskParam(id: string | null, push: boolean) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set('task', id); else url.searchParams.delete('task');
  const state = { ntTask: id, ntPushed: Boolean(id) && (push || Boolean(window.history.state?.ntPushed)) };
  if (push) window.history.pushState(state, '', url); else window.history.replaceState(state, '', url);
}

const Row = memo(function Row({ t, active, onOpen, onMenu }: { t: Task; active: boolean; onOpen: (id: string) => void; onMenu: (t: Task, at: MenuAnchor) => void }) {
  const users = useChatStore((s) => s.users);
  const done = isDone(t);
  const due = dueLabel(t.dueDate);
  const md = taskMarkdown(t);
  const progress = checklistProgress(md);
  const snippet = plainSnippet(md);
  const press = useLongPress((x, y) => onMenu(t, { x, y }));
  const people = assigneesOf(t);
  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    void updateTask(t.id, { isCompleted: !done, completed: !done }).catch(() => showToast('Не сохранилось — нет связи с сервером.', 'error'));
  };
  return (
    <div role="button" tabIndex={0} className="ntl-row" data-task-id={t.id} aria-current={active ? 'true' : undefined} data-done={done ? 'true' : undefined} onClick={() => onOpen(t.id)} onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen(t.id);
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); onMenu(t, { element: e.currentTarget, align: 'start' }); }
      }}
      onContextMenu={(e) => { e.preventDefault(); onMenu(t, { x: e.clientX, y: e.clientY }); }}
      {...press}
    >
      <button type="button" className="ntl-check" onClick={toggle} aria-label={done ? 'Вернуть в работу' : 'Отметить выполненной'} aria-pressed={done}>
        {done && <Check size={12} strokeWidth={3} aria-hidden="true" />}
      </button>
      <span className="ntl-text">
        <span className="ntl-name">{t.title || 'Без названия'}</span>
        {snippet && <span className="ntl-snippet">{snippet}</span>}
        <span className="ntl-meta">
          {t.priority === 'high' && <span className="ntl-flag">Важно</span>}
          {due && <span data-tone={due.late && !done ? 'danger' : undefined}>{due.text}</span>}
          {progress.total > 0 && <span className="ntl-progress" style={{ '--p': `${Math.round((progress.done / progress.total) * 100)}%` } as CSSProperties}>{progress.done}/{progress.total}</span>}
        </span>
      </span>
      {people.length > 0 && (
        <span className="ntl-faces" aria-label={people.map((id) => displayName(users[id])).join(', ')}>
          {people.slice(0, 2).map((id) => <Avatar key={id} name={displayName(users[id]) || '?'} seed={id} src={users[id]?.avatar} person size={22} />)}
        </span>
      )}
    </div>
  );
});

export default function TasksScreen() {
  const mounted = useSyncExternalStore(subscribeNoop, () => true, () => false);
  const narrow = useSyncExternalStore(subscribeMedia, () => window.matchMedia(NARROW).matches, () => false);
  const tasks = useTasks((s) => s.tasks);
  const phase = useTasks((s) => s.phase);
  const [activeId, setActiveId] = useState<string | null>(readTaskParam);
  const [fresh, setFresh] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query.trim().toLowerCase());
  const [showDone, setShowDone] = useState(false);
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState<{ task: Task; anchor: MenuAnchor } | null>(null);
  const onMenu = useCallback((task: Task, anchor: MenuAnchor) => setMenu({ task, anchor }), []);
  const layoutRef = useRef<HTMLDivElement>(null);
  const me = myId();

  useEffect(() => { void loadTasks(); }, []);
  useEffect(() => {
    const onPop = () => setActiveId(readTaskParam());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);


  const open = useCallback((id: string) => {
    const cur = readTaskParam();
    if (cur === id) return;
    writeTaskParam(id, window.matchMedia(NARROW).matches && !cur);
    setActiveId(id);
  }, []);
  const back = useCallback(() => {
    if (window.history.state?.ntPushed) window.history.back();
    else { writeTaskParam(null, false); setActiveId(null); }
  }, []);

  const create = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const t = await createTask({});
      setFresh(t.id);
      open(t.id);
    } catch {
      showToast('Задача не создалась — нет связи с сервером.', 'error');
    } finally {
      setCreating(false);
    }
  };

  // Ушли с только что созданной задачи, так ничего и не написав, — убираем её,
  // чтобы не копились «пустышки» (как новая заметка в MBOX).
  useEffect(() => {
    if (!fresh || activeId === fresh) return undefined;
    const t = window.setTimeout(() => {
      const left = useTasks.getState().tasks[fresh];
      if (left && !left.title.trim() && !taskMarkdown(left).trim()) void deleteTask(fresh).catch(() => {});
      setFresh(null);
    }, 300);
    return () => window.clearTimeout(t);
  }, [activeId, fresh]);

  useShellOptions({
    navHidden: narrow && Boolean(activeId),
    onReselect: () => { if (readTaskParam()) back(); },
  });

  const visible = useMemo(() => Object.values(tasks).filter((t) => {
    const people = assigneesOf(t);
    // Только задачи, к которым человек имеет отношение: исполнитель, автор, кто поставил или делегировал.
    if (!people.includes(me) && ![t.assignedById, t.authorId, t.metadata?.delegatedById].some((id) => id && String(id) === me)) return false;
    if (deferred && !`${t.title} ${taskMarkdown(t)}`.toLowerCase().includes(deferred)) return false;
    return true;
  }), [tasks, me, deferred]);

  const groups = useMemo(() => {
    const byDue = (a: Task, b: Task) => (a.dueDate ? 0 : 1) - (b.dueDate ? 0 : 1)
      || String(a.dueDate || '').localeCompare(String(b.dueDate || ''))
      || String(b.createdAt).localeCompare(String(a.createdAt));
    const open = visible.filter((t) => !isDone(t));
    const out = STATUSES.map((s) => ({ ...s, items: open.filter((t) => statusOf(t) === s.id).sort(byDue) })).filter((g) => g.items.length);
    const done = visible.filter(isDone).sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
    return { open: out, done };
  }, [visible]);

  if (!mounted) return null;
  const active = activeId ? tasks[activeId] : undefined;
  const openCount = groups.open.reduce((n, g) => n + g.items.length, 0);

  let body;
  if (phase === 'loading' && !Object.keys(tasks).length) {
    body = (
      <div aria-busy="true" aria-label="Загружаю задачи">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="nx-skel-row"><span className="nx-skel ntl-skel-check" /><span className="nx-skel nx-skel-line" style={{ '--w': `${40 + ((i * 19) % 45)}%` } as CSSProperties} /></div>
        ))}
      </div>
    );
  } else if (phase === 'error' && !Object.keys(tasks).length) {
    body = (
      <div className="nx-state" data-tone="danger" role="alert">
        <AlertCircle size={28} aria-hidden="true" />
        <h2>Не загрузил задачи</h2>
        <p>Сервер не ответил. Проверьте связь и повторите.</p>
        <button type="button" className="nx-ghost" onClick={() => void loadTasks()}><RotateCw size={14} aria-hidden="true" /> Повторить</button>
      </div>
    );
  } else if (!visible.length) {
    body = (
      <div className="nx-state">
        {deferred ? <Search size={28} aria-hidden="true" /> : <SectionIcon name="todo" size={64} />}
        <h2>{deferred ? 'Ничего не нашёл' : 'Задач нет'}</h2>
        <p>{deferred ? 'Ищу по названию и тексту задачи.' : 'Новая задача — кнопка «Задача» сверху.'}</p>
      </div>
    );
  } else {
    body = (
      <>
        {groups.open.map((g) => (
          <section key={g.id} className="ntl-group" style={{ '--tone': g.tone } as CSSProperties} aria-label={g.label}>
            <h3 className="ntl-group-head"><i aria-hidden="true" />{g.label}<span>{g.items.length}</span></h3>
            {g.items.map((t) => <Row key={t.id} t={t} active={t.id === activeId} onOpen={open} onMenu={onMenu} />)}
          </section>
        ))}
        {groups.done.length > 0 && (
          <section className="ntl-group" aria-label="Выполненные">
            <button type="button" className="ntl-group-head ntl-done-toggle" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
              <ChevronRight size={14} aria-hidden="true" />Выполненные<span>{groups.done.length}</span>
            </button>
            {showDone && groups.done.slice(0, 200).map((t) => <Row key={t.id} t={t} active={t.id === activeId} onOpen={open} onMenu={onMenu} />)}
          </section>
        )}
      </>
    );
  }

  return (
    <div ref={layoutRef} className="ntn" data-pane={active ? 'detail' : 'list'}>
      <aside className="ntl" aria-label="Задачи">
        <header className="ntl-head">
          <div className="ntl-title">
            <h1>Задачи</h1>
            <span className="ntl-total">{openCount} {plural(openCount, ['открытая', 'открытых', 'открытых'])}</span>
            <button type="button" className="nx-primary ntl-new" onClick={() => void create()} disabled={creating}>
              <Plus size={16} aria-hidden="true" /> Задача
            </button>
          </div>
          <SearchField value={query} onChange={setQuery} placeholder="Поиск по задачам" />
        </header>
        <div className="ntl-list nx-scroll-y">{body}</div>
      </aside>

      {!narrow && (
        <Splitter containerRef={layoutRef} cssVar="--ntn-list" storageKey="nx:tasks-list-width" min={300} max={560} initial={380} label="Ширина списка задач" />
      )}

      {menu && <TaskMenu task={menu.task} anchor={menu.anchor} onClose={() => setMenu(null)} onOpen={open} onDeleted={(id) => { if (readTaskParam() === id) back(); }} />}

      {active ? (
        <TaskDocument key={active.id} task={active} onBack={back} onGone={back} />
      ) : (
        <section className="ntd ntd-none" aria-label="Задача">
          <div className="nx-state ntd-empty-state">
            <SectionIcon name="todo" size={72} />
            <h2>{activeId && phase !== 'ready' ? 'Загружаю задачу' : 'Выберите задачу'}</h2>
            <p>Задача — это документ: заголовок, описание и чек-лист в markdown. Сохраняется само.</p>
          </div>
        </section>
      )}
    </div>
  );
}


const isoDay = (plusDays: number) => { const d = new Date(); d.setDate(d.getDate() + plusDays); return d.toISOString().slice(0, 10); };

/** Контекстное меню задачи — как в macOS: действие, статусы, сроки, удаление в самом низу. */
function TaskMenu({ task, anchor, onClose, onOpen, onDeleted }: {
  task: Task; anchor: MenuAnchor; onClose: () => void; onOpen: (id: string) => void; onDeleted: (id: string) => void;
}) {
  const done = isDone(task);
  const status = statusOf(task);
  const apply = (patch: Partial<Task>) => {
    onClose();
    void updateTask(task.id, patch).catch(() => showToast('Не сохранилось — нет связи с сервером.', 'error'));
  };
  const remove = async () => {
    onClose();
    if (!(await askConfirm({ title: `Удалить «${task.title || 'Без названия'}»?`, text: 'Задача пропадёт у всех исполнителей. Вернуть не получится.', confirm: 'Удалить', tone: 'danger' }))) return;
    try { await deleteTask(task.id); onDeleted(task.id); } catch { showToast('Не удалил — нет прав или нет связи с сервером.', 'error'); }
  };
  const copyLink = async () => {
    onClose();
    try { await navigator.clipboard.writeText(absolute(links.task(task.id))); showToast('Ссылка скопирована', 'success'); } catch { showToast('Не удалось скопировать', 'error'); }
  };
  return (
    <Menu anchor={anchor} label={task.title || 'Задача'} onClose={onClose}>
      <MenuItem icon={<ExternalLink size={16} />} onSelect={() => { onClose(); onOpen(task.id); }}>Открыть</MenuItem>
      <MenuItem icon={done ? <RotateCcw size={16} /> : <CircleCheck size={16} />} onSelect={() => apply({ isCompleted: !done, completed: !done })}>
        {done ? 'Вернуть в работу' : 'Отметить выполненной'}
      </MenuItem>
      <div className="nx-menu-sep" />
      <div className="nx-menu-label">Статус</div>
      {STATUSES.map((st) => (
        <MenuItem
          key={st.id}
          icon={st.id === status ? <Check size={16} /> : <i className="ntd-dot" style={{ '--tone': st.tone, margin: '0 4px' } as CSSProperties} />}
          onSelect={() => apply({ status: st.id as Status })}
        >
          {st.label}
        </MenuItem>
      ))}
      <div className="nx-menu-sep" />
      <div className="nx-menu-label">Срок</div>
      <MenuItem icon={<CalendarDays size={16} />} onSelect={() => apply({ dueDate: isoDay(0) })}>Сегодня</MenuItem>
      <MenuItem icon={<CalendarDays size={16} />} onSelect={() => apply({ dueDate: isoDay(1) })}>Завтра</MenuItem>
      <MenuItem icon={<CalendarDays size={16} />} onSelect={() => apply({ dueDate: isoDay(7) })}>Через неделю</MenuItem>
      {task.dueDate && <MenuItem icon={<CalendarX size={16} />} onSelect={() => apply({ dueDate: null })}>Убрать срок</MenuItem>}
      <div className="nx-menu-sep" />
      <MenuItem icon={<Flag size={16} />} onSelect={() => apply({ priority: task.priority === 'high' ? 'medium' : 'high' })}>
        {task.priority === 'high' ? 'Снять «Важно»' : 'Пометить важной'}
      </MenuItem>
      <MenuItem icon={<Copy size={16} />} onSelect={() => void copyLink()}>Скопировать ссылку</MenuItem>
      <div className="nx-menu-sep" />
      <MenuItem icon={<Trash2 size={16} />} tone="danger" onSelect={() => void remove()}>Удалить</MenuItem>
    </Menu>
  );
}
