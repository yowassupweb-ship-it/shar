import { listenIntent } from '@/shared/navigation/quickIntent';
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import {
  AlertCircle, CalendarDays, CalendarX, Check, ChevronRight, CircleCheck, CircleDot, Copy, ExternalLink, Flag, FolderClosed, FolderPlus, FolderTree, Inbox, ListTree,
  MoreHorizontal, Plus, RotateCcw, RotateCw, Search, Trash2, Users,
} from 'lucide-react';
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
  assigneesOf, canAddToFolder, canManageFolder, deleteTask, isDone, isDraft, loadTasks, myId, newDraft, relevantLists, STATUSES, statusOf, type Status, taskMarkdown, updateTask, useTasks, type Task, type TaskList,
} from './api';
import { FolderMenu, FolderSheet, FolderShareSheet } from './Folders';
import { checklistProgress, plainSnippet } from './markdown';
import TaskDocument, { dueLabel } from './TaskDocument';
import { parseDue } from './due';
import { absolute, links } from '@/shared/navigation/routes';

/**
 * Раздел «Задачи» нового шара: мастер-деталь, как контакты. Слева — поиск и задачи деревом по папкам (как в
 * «Документах»), по статусам или по людям, обычным или компактным списком; задачу перетаскивают между группами.
 * Справа — задача-документ. Новая задача — черновик, пока её не создали.
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

const Row = memo(function Row({ t, active, onOpen, onMenu, depth = 0, showStatus = true, onDropBefore }: {
  t: Task; active: boolean; onOpen: (id: string) => void; onMenu: (t: Task, at: MenuAnchor) => void; depth?: number;
  /** Статус в строке — кроме вида «по статусам», где он уже в заголовке группы. */
  showStatus?: boolean;
  /** Ручной порядок: задачу бросили на эту строку — встать перед ней. */
  onDropBefore?: (dragId: string, beforeId: string) => void;
}) {
  const [over, setOver] = useState(false);
  const statusInfo = STATUSES.find((x) => x.id === statusOf(t));
  const users = useChatStore((s) => s.users);
  const done = isDone(t);
  const draft = isDraft(t.id);
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
    <div role="button" tabIndex={0} className="ntl-row" data-task-id={t.id} aria-current={active ? 'true' : undefined} data-done={done ? 'true' : undefined}
      data-draft={draft || undefined} data-drop-before={over || undefined} style={depth ? ({ '--depth': depth } as CSSProperties) : undefined}
      draggable={!draft}
      onDragStart={(e) => { e.dataTransfer.setData(DRAG_TYPE, t.id); e.dataTransfer.effectAllowed = 'move'; }}
      onDragOver={onDropBefore ? (e) => { if (!e.dataTransfer.types.includes(DRAG_TYPE)) return; e.preventDefault(); if (!over) setOver(true); } : undefined}
      onDragLeave={onDropBefore ? () => setOver(false) : undefined}
      onDrop={onDropBefore ? (e) => {
        setOver(false);
        const id = e.dataTransfer.getData(DRAG_TYPE);
        if (!id || id === t.id) return;
        e.preventDefault(); e.stopPropagation();
        onDropBefore(id, t.id);
      } : undefined}
      onClick={() => onOpen(t.id)} onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen(t.id);
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); onMenu(t, { element: e.currentTarget, align: 'start' }); }
      }}
      onContextMenu={(e) => { e.preventDefault(); onMenu(t, { x: e.clientX, y: e.clientY }); }}
      {...press}
    >
      <button type="button" className="ntl-check" onClick={toggle} aria-label={done ? 'Вернуть в работу' : 'Отметить выполненной'} aria-pressed={done} disabled={draft}>
        {done && <Check size={12} strokeWidth={3} aria-hidden="true" />}
      </button>
      <span className="ntl-text">
        <span className="ntl-name">{t.title || (draft ? 'Новая задача' : 'Без названия')}</span>
        {snippet && <span className="ntl-snippet">{snippet}</span>}
        <span className="ntl-meta">
          {draft && <span className="ntl-draft">Черновик</span>}
          {!draft && showStatus && statusInfo && !done && <span className="ntl-status" style={{ '--tone': statusInfo.tone } as CSSProperties}><i aria-hidden="true" />{statusInfo.label}</span>}
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

/** Перетаскивание задачи: в папку, в статус, к человеку (группы списка — цели сброса). */
const DRAG_TYPE = 'application/x-shar-task';
const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

type Grouping = 'folder' | 'status' | 'people';
const GROUPINGS: { id: Grouping; label: string; icon: typeof FolderTree }[] = [
  { id: 'folder', label: 'По папкам', icon: FolderTree },
  { id: 'status', label: 'По статусам', icon: CircleDot },
  { id: 'people', label: 'По людям', icon: Users },
];
const readPref = (key: string, fallback: string) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
const writePref = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* без памяти */ } };

/** Группа списка: папка, статус или человек. drop — что сделать с задачей, брошенной на заголовок. */
interface Group {
  key: string; label: string; tone?: string; items: Task[];
  /** Выполненные этой группы (по папкам и по людям — у каждой свои, свёрнуты). */
  done?: Task[];
  folder?: TaskList; person?: string; status?: Status;
  icon?: ReactNode;
}

export default function TasksScreen() {
  const mounted = useSyncExternalStore(subscribeNoop, () => true, () => false);
  const narrow = useSyncExternalStore(subscribeMedia, () => window.matchMedia(NARROW).matches, () => false);
  const tasks = useTasks((s) => s.tasks);
  const phase = useTasks((s) => s.phase);
  const users = useChatStore((s) => s.users);
  const [activeId, setActiveId] = useState<string | null>(readTaskParam);
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query.trim().toLowerCase());
  const [showDone, setShowDone] = useState(false);
  // Раскрытые «Выполненные» внутри групп (по умолчанию свёрнуты) — на время сеанса.
  const [openDone, setOpenDone] = useState<Set<string>>(() => new Set());
  const toggleDone = (key: string) => setOpenDone((cur) => { const next = new Set(cur); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const [menu, setMenu] = useState<{ task: Task; anchor: MenuAnchor } | null>(null);
  const onMenu = useCallback((task: Task, anchor: MenuAnchor) => setMenu({ task, anchor }), []);
  const layoutRef = useRef<HTMLDivElement>(null);
  const me = myId();
  const allLists = useTasks((s) => s.lists);
  // Вид списка: группировка (папки — деревом, как в «Документах»; статусы; люди) и плотность — помним на устройстве.
  const [grouping, setGroupingState] = useState<Grouping>(() => { const v = readPref('nx:tasks-grouping', 'folder'); return (GROUPINGS.some((g) => g.id === v) ? v : 'folder') as Grouping; });
  const setGrouping = (g: Grouping) => { setGroupingState(g); writePref('nx:tasks-grouping', g); };
  const [compact, setCompactState] = useState(() => readPref('nx:tasks-compact', '0') === '1');
  const toggleCompact = () => setCompactState((c) => { writePref('nx:tasks-compact', c ? '0' : '1'); return !c; });
  // Свёрнутые группы — по ключу «вид:группа».
  const [collapsed, setCollapsed] = useState<Set<string>>(() => { try { return new Set(JSON.parse(readPref('nx:tasks-collapsed', '[]')) as string[]); } catch { return new Set(); } });
  const toggleGroup = (key: string) => setCollapsed((cur) => {
    const next = new Set(cur);
    if (next.has(key)) next.delete(key); else next.add(key);
    writePref('nx:tasks-collapsed', JSON.stringify([...next]));
    return next;
  });
  const [viewMenu, setViewMenu] = useState<MenuAnchor | null>(null);
  const [folderSheet, setFolderSheet] = useState<{ list?: TaskList } | null>(null);
  const [shareList, setShareList] = useState<TaskList | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ list: TaskList; anchor: MenuAnchor } | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);

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

  // Новая задача — черновик (см. api.ts newDraft): у исполнителей она появится только после «Создать».
  const create = (init: Partial<Task> = {}) => {
    const t = newDraft(init);
    open(t.id);
  };
  const createRef = useRef(create);
  createRef.current = create;
  useEffect(() => listenIntent(['new-task'], () => { createRef.current(); }), []);

  // Ушли с пустого черновика — убираем его: пустышки не копятся. С текстом черновик остаётся в группе «Черновики».
  const prevActive = useRef<string | null>(activeId);
  useEffect(() => {
    const prev = prevActive.current;
    prevActive.current = activeId;
    if (!prev || prev === activeId || !isDraft(prev)) return;
    const left = useTasks.getState().tasks[prev];
    if (left && !left.title.trim() && !taskMarkdown(left).trim()) void deleteTask(prev);
  }, [activeId]);

  useShellOptions({
    navHidden: narrow && Boolean(activeId),
    onReselect: () => { if (readTaskParam()) back(); },
  });

  const folders = useMemo(() => relevantLists(allLists, tasks), [allLists, tasks]);
  const folderIds = useMemo(() => new Set(folders.map((l) => l.id)), [folders]);
  // Папки, открытые мне, показывают все свои задачи; остальное — только то, к чему я имею отношение.
  const sharedIds = useMemo(() => new Set(allLists.filter((l) => l.sharedLevel).map((l) => l.id)), [allLists]);
  const base = useMemo(() => Object.values(tasks).filter((t) => {
    const people = assigneesOf(t);
    const mine = people.includes(me) || [t.assignedById, t.authorId, t.metadata?.delegatedById].some((id) => id && String(id) === me);
    if (!mine && !(t.listId && sharedIds.has(String(t.listId)))) return false;
    if (deferred && !`${t.title} ${taskMarkdown(t)}`.toLowerCase().includes(deferred)) return false;
    return true;
  }), [tasks, me, deferred, sharedIds]);

  const groups = useMemo(() => {
    // Порядок: сначала расставленные вручную (taskOrder), затем по важности, сроку и свежести.
    const ord = (t: Task) => Number(t.taskOrder) || 0;
    const byDue = (a: Task, b: Task) => {
      const oa = ord(a); const ob = ord(b);
      if (oa || ob) return (oa ? 0 : 1) - (ob ? 0 : 1) || oa - ob;
      return PRIORITY_RANK[a.priority || 'medium'] - PRIORITY_RANK[b.priority || 'medium']
        || (a.dueDate ? 0 : 1) - (b.dueDate ? 0 : 1)
        || String(a.dueDate || '').localeCompare(String(b.dueDate || ''))
        || String(b.createdAt).localeCompare(String(a.createdAt));
    };
    const drafts = base.filter((t) => isDraft(t.id)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const open = base.filter((t) => !isDone(t) && !isDraft(t.id));
    const done = base.filter((t) => isDone(t) && !isDraft(t.id)).sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
    let out: Group[] = [];
    if (grouping === 'status') {
      out = STATUSES.map((s) => ({ key: `status:${s.id}`, label: s.label, tone: s.tone, status: s.id, items: open.filter((t) => statusOf(t) === s.id).sort(byDue) })).filter((g) => g.items.length);
    } else if (grouping === 'people') {
      const ids = new Set<string>();
      for (const t of [...open, ...done]) for (const id of assigneesOf(t)) ids.add(id);
      const name = (id: string) => (id === me ? 'Я' : displayName(users[id]) || 'Сотрудник');
      out = [...ids].sort((a, b) => Number(b === me) - Number(a === me) || name(a).localeCompare(name(b), 'ru')).map((id) => ({
        key: `person:${id}`, label: name(id), person: id,
        icon: <Avatar name={displayName(users[id]) || "?"} seed={id} src={users[id]?.avatar} person size={22} />,
        items: open.filter((t) => assigneesOf(t).includes(id)).sort(byDue),
        done: done.filter((t) => assigneesOf(t).includes(id)),
      }));
      const nobody = open.filter((t) => !assigneesOf(t).length);
      const nobodyDone = done.filter((t) => !assigneesOf(t).length);
      if (nobody.length || nobodyDone.length) out.push({ key: 'person:', label: 'Без исполнителя', person: '', items: nobody.sort(byDue), done: nobodyDone });
    } else {
      // Папки деревом: каждая папка — ветка (даже пустая — в неё можно бросить задачу), внутри — этапы по статусам и срокам.
      out = folders.map((l) => ({
        key: `folder:${l.id}`, label: l.name, tone: l.color || 'var(--note-gray)', folder: l,
        items: open.filter((t) => String(t.listId) === l.id).sort(byDue),
        done: done.filter((t) => String(t.listId) === l.id),
      })).filter((g) => !deferred || g.items.length || g.done.length);
      const outside = (t: Task) => !t.listId || !folderIds.has(String(t.listId));
      out.push({ key: 'folder:', label: 'Без папки', items: open.filter(outside).sort(byDue), done: done.filter(outside) });
    }
    // Общий список выполненных — только по статусам; по папкам и людям они у каждой группы свои.
    return { drafts, open: out, done: grouping === 'status' ? done : [], openCount: open.length };
  }, [base, grouping, folders, folderIds, users, me, deferred]);

  // Брошенная на группу задача: в папку, в статус или к человеку (снимаем с того, у кого была в этой группировке).
  const dropOn = (g: Group, taskId: string, from?: string) => {
    const t = useTasks.getState().tasks[taskId];
    if (!t) return;
    const fail = () => showToast('Не перенеслось — нет прав или нет связи с сервером.', 'error');
    if (g.folder || g.key === 'folder:') {
      if (g.folder && !canAddToFolder(g.folder)) { showToast('В эту папку вам можно только смотреть.', 'info'); return; }
      const listId = g.folder ? g.folder.id : null;
      if (String(t.listId || '') !== String(listId || '')) void updateTask(t.id, { listId }).catch(fail);
    } else if (g.status) {
      if (statusOf(t) !== g.status) void updateTask(t.id, { status: g.status }).catch(fail);
    } else if (g.person !== undefined) {
      const cur = assigneesOf(t);
      const source = from?.startsWith('person:') ? from.slice(7) : '';
      let next = cur.filter((id) => id !== source);
      if (g.person && !next.includes(g.person)) next = [...next, g.person];
      if (!g.person) next = cur.filter((id) => id !== source);
      if (next.join() !== cur.join()) void updateTask(t.id, { assignedToIds: next, assignedToId: next[0] || null }).catch(fail);
    }
  };
  // Ручной порядок внутри группы: задача встаёт перед той, на которую её бросили; группе раздаём taskOrder заново
  // (шаг 1024 — пишем только тем, у кого он поменялся). Пришла из другой группы — сначала переносим и в эту группу.
  const reorder = (g: Group, dragId: string, beforeId: string) => {
    const dragged = useTasks.getState().tasks[dragId];
    if (!dragged) return;
    if (!g.items.some((t) => t.id === dragId)) dropOn(g, dragId, dragFrom.current);
    const list = g.items.filter((t) => t.id !== dragId);
    const at = list.findIndex((t) => t.id === beforeId);
    list.splice(at < 0 ? list.length : at, 0, dragged);
    list.forEach((t, i) => {
      const next = (i + 1) * 1024;
      if (Number(t.taskOrder) !== next) {
        void updateTask(t.id, { taskOrder: next }).catch(() => showToast('Порядок не сохранился — нет связи с сервером.', 'error'));
      }
    });
  };
  const dragFrom = useRef<string | undefined>(undefined);
  const dropProps = (g: Group) => ({
    onDragOver: (e: React.DragEvent) => { if (!e.dataTransfer.types.includes(DRAG_TYPE)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dropKey !== g.key) setDropKey(g.key); },
    onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropKey((k) => (k === g.key ? null : k)); },
    onDrop: (e: React.DragEvent) => { const id = e.dataTransfer.getData(DRAG_TYPE); setDropKey(null); if (id) { e.preventDefault(); dropOn(g, id, dragFrom.current); } },
    onDragStartCapture: () => { dragFrom.current = g.key; },
    onDragEndCapture: () => { dragFrom.current = undefined; setDropKey(null); },
  });

  if (!mounted) return null;
  const active = activeId ? tasks[activeId] : undefined;

  const groupBlock = (g: Group) => {
    const key = `${grouping}:${g.key}`;
    const shut = collapsed.has(key) && !deferred;
    const isFolder = Boolean(g.folder);
    return (
      <section key={g.key} className="ntl-group" data-tree={grouping === 'folder' || undefined} data-drop={dropKey === g.key || undefined}
        style={g.tone ? ({ '--tone': g.tone } as CSSProperties) : undefined} aria-label={g.label} {...dropProps(g)}>
        <div className="ntl-group-head" role="button" tabIndex={0} aria-expanded={!shut}
          onClick={() => toggleGroup(key)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleGroup(key); } }}
          onContextMenu={g.folder ? (e) => { e.preventDefault(); setFolderMenu({ list: g.folder!, anchor: { x: e.clientX, y: e.clientY } }); } : undefined}>
          <ChevronRight size={14} className="ntl-caret" aria-hidden="true" />
          {g.icon ?? (grouping === 'folder' ? (isFolder ? <FolderClosed size={15} className="ntl-folder-icon" aria-hidden="true" /> : <Inbox size={15} className="ntl-folder-icon" aria-hidden="true" />) : <i aria-hidden="true" />)}
          <span className="ntl-group-name">{g.label}</span>
          {g.folder?.sharedLevel && <Users size={12} className="ntl-shared" aria-label="Общая папка" />}
          <span className="ntl-count">{g.items.length}</span>
          {(isFolder || g.key === 'folder:') && (!g.folder || canAddToFolder(g.folder)) && (
            <button type="button" className="ntl-head-btn" title="Новая задача здесь" aria-label={`Новая задача в «${g.label}»`}
              onClick={(e) => { e.stopPropagation(); create({ listId: g.folder?.id ?? null }); }}><Plus size={14} aria-hidden="true" /></button>
          )}
          {g.folder && canManageFolder(g.folder) && (
            <button type="button" className="ntl-head-btn" aria-label={`Действия с папкой «${g.label}»`}
              onClick={(e) => { e.stopPropagation(); setFolderMenu({ list: g.folder!, anchor: { element: e.currentTarget, align: 'end' } }); }}><MoreHorizontal size={14} aria-hidden="true" /></button>
          )}
        </div>
        {!shut && (
          <div className="ntl-group-items">
            {g.items.map((t) => <Row key={t.id} t={t} active={t.id === activeId} onOpen={open} onMenu={onMenu} showStatus={grouping !== 'status'} onDropBefore={(d, b) => reorder(g, d, b)} />)}
            {Boolean(g.done?.length) && (() => {
              const doneKey = `${key}:done`;
              const shown = openDone.has(doneKey);
              return (
                <div className="ntl-subgroup">
                  <button type="button" className="ntl-done-toggle ntl-sub-head" aria-expanded={shown} onClick={() => toggleDone(doneKey)}>
                    <ChevronRight size={13} className="ntl-caret" aria-hidden="true" /><span className="ntl-group-name">Выполненные</span><span className="ntl-count">{g.done!.length}</span>
                  </button>
                  {shown && <div className="ntl-group-items">{g.done!.slice(0, 200).map((t) => <Row key={t.id} t={t} active={t.id === activeId} onOpen={open} onMenu={onMenu} showStatus={false} />)}</div>}
                </div>
              );
            })()}
            {!g.items.length && !g.done?.length && grouping === 'folder' && <p className="ntl-folder-empty">{isFolder ? 'Пусто — перетащите сюда задачу или нажмите +' : 'Все задачи разложены по папкам'}</p>}
          </div>
        )}
      </section>
    );
  };

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
  } else if (!base.length && grouping !== 'folder') {
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
        {groups.drafts.length > 0 && (
          <section className="ntl-group" aria-label="Черновики">
            <div className="ntl-group-head ntl-group-static"><i aria-hidden="true" style={{ background: 'var(--text-muted)' }} /><span className="ntl-group-name">Черновики — видите только вы</span><span className="ntl-count">{groups.drafts.length}</span></div>
            <div className="ntl-group-items">{groups.drafts.map((t) => <Row key={t.id} t={t} active={t.id === activeId} onOpen={open} onMenu={onMenu} />)}</div>
          </section>
        )}
        {groups.open.map(groupBlock)}
        {groups.done.length > 0 && (
          <section className="ntl-group" aria-label="Выполненные">
            <button type="button" className="ntl-group-head ntl-done-toggle" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
              <ChevronRight size={14} className="ntl-caret" aria-hidden="true" /><span className="ntl-group-name">Выполненные</span><span className="ntl-count">{groups.done.length}</span>
            </button>
            {showDone && <div className="ntl-group-items">{groups.done.slice(0, 200).map((t) => <Row key={t.id} t={t} active={t.id === activeId} onOpen={open} onMenu={onMenu} />)}</div>}
          </section>
        )}
      </>
    );
  }

  const GroupIcon = GROUPINGS.find((g) => g.id === grouping)!.icon;
  return (
    <div ref={layoutRef} className="ntn" data-pane={active ? 'detail' : 'list'}>
      <aside className="ntl" aria-label="Задачи" data-density={compact ? 'compact' : undefined}>
        <header className="ntl-head">
          <div className="ntl-title">
            <h1>Задачи</h1>
            <span className="ntl-total">{groups.openCount} {plural(groups.openCount, ['открытая', 'открытых', 'открытых'])}</span>
            <button type="button" className="nx-primary ntl-new" onClick={() => create()}>
              <Plus size={16} aria-hidden="true" /> Задача
            </button>
          </div>
          <div className="ntl-tools">
            {/* Новая папка — первой: на виду, сколько бы папок ни было. Папка — это и проект: большая задача из этапов. */}
            <button type="button" className="nx-ghost ntl-tool" title="Новая папка (проект из нескольких задач)" aria-label="Новая папка" onClick={() => setFolderSheet({})}>
              <FolderPlus size={16} aria-hidden="true" />
            </button>
            <SearchField value={query} onChange={setQuery} placeholder="Поиск по задачам" />
            <button type="button" className="nx-ghost ntl-tool" title={`Группировка: ${GROUPINGS.find((g) => g.id === grouping)!.label.toLowerCase()}`} aria-label="Группировка" aria-haspopup="menu"
              onClick={(e) => setViewMenu({ element: e.currentTarget, align: 'end' })}>
              <GroupIcon size={16} aria-hidden="true" />
            </button>
            <button type="button" className="nx-ghost ntl-tool" aria-pressed={compact} title={compact ? 'Обычный список' : 'Компактный список деревом'} aria-label={compact ? 'Обычный список' : 'Компактный список деревом'} onClick={toggleCompact}>
              <ListTree size={16} aria-hidden="true" />
            </button>
          </div>
        </header>
        <div className="ntl-list nx-scroll-y">{body}</div>
      </aside>

      {!narrow && (
        <Splitter containerRef={layoutRef} cssVar="--ntn-list" storageKey="nx:tasks-list-width" min={260} max={560} initial={380} label="Ширина списка задач" />
      )}

      {viewMenu && (
        <Menu anchor={viewMenu} label="Группировка" onClose={() => setViewMenu(null)}>
          {GROUPINGS.map((g) => (
            <MenuItem key={g.id} icon={g.id === grouping ? <Check size={16} /> : <g.icon size={16} />} onSelect={() => { setViewMenu(null); setGrouping(g.id); }}>{g.label}</MenuItem>
          ))}
        </Menu>
      )}
      {folderMenu && (
        <FolderMenu list={folderMenu.list} anchor={folderMenu.anchor} onClose={() => setFolderMenu(null)}
          onRename={(l) => setFolderSheet({ list: l })} onShare={(l) => setShareList(l)} onDeleted={() => undefined} />
      )}
      {folderSheet && <FolderSheet list={folderSheet.list} onClose={() => setFolderSheet(null)} onSaved={() => { if (grouping !== 'folder') setGrouping('folder'); }} />}
      {shareList && <FolderShareSheet list={shareList} onClose={() => setShareList(null)} />}

      {menu && <TaskMenu task={menu.task} anchor={menu.anchor} onClose={() => setMenu(null)} onOpen={open} onDeleted={(id) => { if (readTaskParam() === id) back(); }} />}

      {active ? (
        <TaskDocument key={active.id} task={active} onBack={back} onGone={back} onCreated={(id) => { writeTaskParam(id, false); setActiveId(id); }} />
      ) : (
        <section className="ntd ntd-none" aria-label="Задача">
          <div className="nx-state ntd-empty-state">
            <SectionIcon name="todo" size={72} />
            <h2>{activeId && phase !== 'ready' ? 'Загружаю задачу' : 'Выберите задачу'}</h2>
            <p>Задача — это документ: заголовок, описание и чек-лист. Большая задача из этапов — папка с задачами внутри.</p>
          </div>
        </section>
      )}
    </div>
  );
}

/** Новый день срока с прежним временем (если оно было): «Завтра» не должно сбрасывать «18:00». */
const withDueTime = (t: Task, day: string) => { const time = parseDue(t.dueDate)?.time; return time ? `${day}T${time}:00` : day; };
// Местная дата, не UTC: toISOString ночью давал вчерашний день.
const isoDay = (plusDays: number) => { const d = new Date(); d.setDate(d.getDate() + plusDays); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

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
      <MenuItem icon={<CalendarDays size={16} />} onSelect={() => apply({ dueDate: withDueTime(task, isoDay(0)) })}>Сегодня</MenuItem>
      <MenuItem icon={<CalendarDays size={16} />} onSelect={() => apply({ dueDate: withDueTime(task, isoDay(1)) })}>Завтра</MenuItem>
      <MenuItem icon={<CalendarDays size={16} />} onSelect={() => apply({ dueDate: withDueTime(task, isoDay(7)) })}>Через неделю</MenuItem>
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
