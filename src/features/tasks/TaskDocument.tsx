import { createPortal } from 'react-dom';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import {
  AlertCircle, ArrowLeft, Bot, CalendarDays, Check, ChevronDown, Cloud, Eye, FileText, Flag, FolderClosed, FolderPlus, MessageSquare, History, Link2, MoreHorizontal, Paperclip, Pencil,
  Repeat, Search, Trash2, UserPlus,
} from 'lucide-react';
import { showToast } from '@/shared/ui/Toast';
import { displayName, useChatStore } from '@/features/chat';
import { Avatar } from '@/shared/ui/Avatar';
import { askConfirm, Menu, MenuItem, Sheet, type MenuAnchor } from '@/shared/ui/overlay';
import {
  assigneesOf, canAddToFolder, chainOf, chainOwnerOf, customerOf, deleteTask, setChain, setOpenTask, shownAssignees, useTaskStream, isDraft, publishDraft, relevantLists, isDone, myId, PRIORITIES, saveText, STATUSES, statusOf, taskMarkdown, updateTask, useTasks,
  type Priority, type Status, type Task,
} from './api';
import { renderMarkdown, toggleTaskLine } from './markdown';
import { daysId, daysOf, repeatIdOf, repeatLabel, repeatTimeOf, syncTaskRepeat, TASK_REPEATS, WEEKDAYS } from './repeat';
import { DatePicker } from '@/shared/ui/DatePicker';
import { parseDue } from './due';
import { TaskVersionsSheet } from './VersionsSheet';
import { FolderSheet } from './Folders';
import { CommentsPanel } from '@/features/workspace/CommentsPanel';
import { useCommentSource } from '@/features/workspace/useComments';
import type { CommentAnchor } from '@/features/workspace/types';
import { recordVisit } from '@/features/spotlight';
import { links } from '@/shared/navigation/routes';
import { findQuote, selectionAnchor, taskCommentSource, TaskTextMenu, useQuoteHighlights } from './TaskComments';
// Визуальный редактор (TipTap) — отдельным куском: список задач открывается без него.
const VisualEditor = lazy(() => import('@/shared/markdown/VisualEditor').then((m) => ({ default: m.VisualEditor })));
import { AgentReports, AgentSheet } from './AgentTask';
import { taskAgent, type TaskAgent } from './api';
import { useAgentBridge } from '@/shared/core/agentBridge';
import { Spinner } from '@/shared/ui/Spinner';
import { AttachmentList, AttachPicker, attachmentsOf, LinkSheet, newId, type Attachment } from './attachments';

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
  const due = parseDue(iso);
  if (!due) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(due.day.getFullYear(), due.day.getMonth(), due.day.getDate());
  const diff = Math.round((day.getTime() - today.getTime()) / 86400000);
  const date = diff === 0 ? 'Сегодня' : diff === 1 ? 'Завтра' : diff === -1 ? 'Вчера' : dateFmt.format(due.day);
  // Со временем задача просрочена, как только оно прошло; без времени — когда кончился день срока.
  const late = diff < 0 || (diff === 0 && Boolean(due.time) && due.day.getTime() < now.getTime());
  return { text: due.time ? `${date}, ${due.time}` : date, late };
}

/** Сколько длится уезд панели комментариев (tasks.css, ntd-cm-close). */
const CM_CLOSE_MS = 230;

export default function TaskDocument({ task, onBack, onGone, onCreated }: {
  task: Task;
  onBack: () => void;
  onGone: () => void;
  /** Черновик стал задачей: новый id (адрес и выбор в списке переезжают на него). */
  onCreated?: (id: string) => void;
}) {
  const draft = isDraft(task.id);
  const [publishing, setPublishing] = useState(false);
  const initial = useMemo(() => {
    const md = taskMarkdown(task);
    return { title: task.title || '', md };
    // Документ живёт, пока открыта эта задача: чужие правки текста подхватываем ниже.
  }, [task.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [title, setTitle] = useState(initial.title);
  const [md, setMd] = useState(initial.md);
  // Два режима: просмотр и «Правка» (визуальный редактор, без разметки). Хранится по-прежнему markdown.
  const [mode, setMode] = useState<'preview' | 'visual'>(() => (initial.title || initial.md.trim() ? 'preview' : 'visual'));
  const editing = mode !== 'preview';
  const switchMode = (next: 'preview' | 'visual') => {
    if (next === mode) return;
    if (editing) void save();
    setMode(next);
  };
  const [state, setState] = useState<SaveState>('saved');
  const saved = useRef(initial);
  const latest = useRef(initial);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const [menu, setMenu] = useState<{ kind: 'status' | 'priority' | 'list' | 'more' | 'date' | 'repeat' | 'attach'; anchor: MenuAnchor } | null>(null);
  const [attachSheet, setAttachSheet] = useState<'office' | 'cloud' | 'link' | null>(null);
  const [uploading, setUploading] = useState(0);
  const filePick = useRef<HTMLInputElement>(null);
  const [people, setPeople] = useState<'assignees' | 'customer' | 'owner' | null>(null);
  const [versions, setVersions] = useState(false);
  const [newFolder, setNewFolder] = useState(false);

  // ── Комментарии, как в документах: панель справа (открыта/закрыта — помним), ветки к выделенному тексту ──
  const [cmOpen, setCmOpenState] = useState(() => { try { return localStorage.getItem('nx:task-comments') === '1'; } catch { return false; } });
  const setCmOpen = (v: boolean) => { setCmOpenState(v); try { localStorage.setItem('nx:task-comments', v ? '1' : '0'); } catch { /* без памяти */ } };
  // Закрытие — тоже плавное: панель ещё CM_CLOSE_MS на экране с пометкой «закрывается» (уезжает), потом убирается.
  const [cmMounted, setCmMounted] = useState(cmOpen);
  useEffect(() => {
    if (cmOpen) { setCmMounted(true); return undefined; }
    const t = window.setTimeout(() => setCmMounted(false), CM_CLOSE_MS);
    return () => window.clearTimeout(t);
  }, [cmOpen]);
  const commentSource = useMemo(() => taskCommentSource(draft ? null : task.id), [draft, task.id]);
  const comments = useCommentSource(commentSource);
  const [cmFocus, setCmFocus] = useState(0);
  const [cmThread, setCmThread] = useState<{ sheet: string; cell: string; quote?: string; tick: number } | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const [textMenu, setTextMenu] = useState<{ x: number; y: number } | null>(null);
  // Привязка — последнее выделение в тексте задачи: в поле комментария фокус уходит из текста, и выделение гаснет.
  const lastAnchor = useRef<CommentAnchor | null>(null);
  useEffect(() => {
    const onSel = () => {
      const sel = window.getSelection();
      const el = pageRef.current;
      if (!el || !sel || !sel.rangeCount || !el.contains(sel.getRangeAt(0).commonAncestorContainer)) return;
      lastAnchor.current = selectionAnchor(el);
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, []);
  const getCommentAnchor = useCallback(() => lastAnchor.current, []);
  const startComment = useCallback(() => {
    if (draft) { showToast('Комментарии — после создания задачи', 'info'); return; }
    lastAnchor.current = selectionAnchor(pageRef.current) ?? lastAnchor.current;
    setCmOpen(true);
    setCmFocus((n) => n + 1);
  }, [draft]);
  const quotes = useMemo(() => comments.open.map((t) => (t.root.anchor && 'kind' in t.root.anchor && t.root.anchor.kind === 'text' ? t.root.anchor.quote : '')).filter(Boolean), [comments.open]);
  const quoteAt = useQuoteHighlights(pageRef, quotes, `${md}${mode}${title}`);
  const jumpToQuote = (anchor: CommentAnchor) => {
    if (anchor.kind !== 'text' || !pageRef.current) return;
    const range = findQuote(pageRef.current, anchor.quote);
    if (!range) { showToast('Этого текста в задаче больше нет', 'info'); return; }
    (range.startContainer.parentElement)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  };
  // Щелчок по подсвеченному тексту — открыть его ветку.
  const onPageClick = (e: React.MouseEvent) => {
    const quote = quoteAt(e.clientX, e.clientY);
    if (!quote) return;
    setCmOpen(true);
    setCmThread({ sheet: '', cell: '', quote, tick: Date.now() });
  };
  const assigneeHover = useHoverCard();
  // Поручение агенту «Ядра»: чип показываем, если «Ядро» человеку включено.
  const agentOn = useAgentBridge((s) => s.available);
  const [agentSheet, setAgentSheet] = useState<TaskAgent | null>(null);
  const [agentVersion, setAgentVersion] = useState(0);
  const openAgent = () => { taskAgent(task.id).then(setAgentSheet).catch(() => showToast('Не удалось открыть настройки агента — нет связи с сервером.', 'error')); };
  const users = useChatStore((s) => s.users);
  const allLists = useTasks((s) => s.lists);
  // Открытая задача: её новые комментарии сразу прочитаны (api.ts, task_comments).
  useEffect(() => { setOpenTask(task.id); return () => setOpenTask(null); }, [task.id]);
  // «Где я» для агента «Ядра» (core/whereAmI): открытая задача — с id, чтобы «здесь», «в этой задаче» значило её,
  // и агент правил её task_update (текст идёт открывшим потоком, на глазах).
  const visitTitle = task.title || '';
  useEffect(() => {
    if (isDraft(task.id) || !visitTitle) return;
    recordVisit({ id: task.id, kind: 'task', title: visitTitle, subtitle: 'Задача', path: links.task(task.id) });
  }, [task.id, visitTitle]);
  const tasksById = useTasks((s) => s.tasks);
  // Только «свои» списки: созданные мной, открытые мне, или где есть мои задачи.
  const lists = useMemo(() => relevantLists(allLists, tasksById, task.listId), [allLists, tasksById, task.listId]);

  // Папка открыта мне только на просмотр, а в самой задаче я не участвую — править нельзя (сервер тоже не даст).
  const viewOnly = allLists.find((l) => l.id === task.listId)?.sharedLevel === 'view'
    && !assigneesOf(task).includes(myId()) && ![task.authorId, task.assignedById].some((id) => id && String(id) === myId());

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

  // Агент пишет эту задачу — показываем его текст по ходу (только в просмотре и без своих несохранённых правок).
  const streamRaw = useTaskStream((st) => st.byId[task.id]);
  const stream = streamRaw && !editing && latest.current.md === saved.current.md && latest.current.title === saved.current.title ? streamRaw : undefined;

  const finishEditing = useCallback(() => { void save(); setMode('preview'); }, [save]);

  // «Создать»: черновик уходит на сервер одним запросом — исполнители получают задачу сразу целиком.
  const publish = useCallback(async () => {
    if (!draft || publishing) return;
    const cur = latest.current;
    if (!cur.title.trim() && !cur.md.trim()) { showToast('Напишите, что нужно сделать', 'info'); titleRef.current?.focus(); return; }
    setPublishing(true);
    try {
      await saveText(task.id, cur.title.trim(), cur.md);
      saved.current = cur;
      const created = await publishDraft(task.id);
      const rep = repeatIdOf(created);
      if (rep !== 'none') syncTaskRepeat(created, rep).catch(() => showToast('Календарь не обновился — нет связи с сервером.', 'error'));
      onCreated?.(created.id);
    } catch {
      showToast('Задача не создалась — нет связи с сервером. Черновик сохранён.', 'error');
      setPublishing(false);
    }
  }, [draft, publishing, task.id, onCreated]);

  // Ctrl+S — сохранить сейчас; Esc в правке — «Готово» (если не открыт лист или меню).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && draft) { e.preventDefault(); void publish(); }
      if ((e.ctrlKey || e.metaKey) && e.altKey && e.code === 'KeyM') { e.preventDefault(); startComment(); }
      if (e.key === 'Escape' && mode !== 'preview' && !document.querySelector('.nx-scrim, .nx-menu')) { e.preventDefault(); finishEditing(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save, mode, finishEditing, draft, publish, startComment]);

  // В правке — фокус в заголовок.
  useEffect(() => {
    if (mode === 'preview') return;
    titleRef.current?.focus();
  }, [mode, task.id]);

  // Высота заголовка по содержимому — страница прокручивается целиком, как документ.
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [title, mode]);

  // Успех видно по самой задаче — всплывашки только об ошибках, иначе их сыпалось по штуке на клик.
  const patch = async (p: Partial<Task>) => {
    try { await updateTask(task.id, p); } catch { showToast('Не сохранилось — нет связи с сервером.', 'error'); }
  };

  /** Вернуть версию из истории: текст в редакторе и в базе — как в версии (сервер положил прежнее состояние в историю). */
  const restoreVersion = async (t: string, body: string) => {
    saved.current = { title: t, md: body };
    latest.current = { title: t, md: body };
    setTitle(t);
    setMd(body);
    await saveText(task.id, t.trim(), body);
    setState('saved');
  };

  const remove = async () => {
    if ((title.trim() || md.trim()) && !(await askConfirm(draft
      ? { title: 'Удалить черновик?', text: 'Задача ещё не создана — никто, кроме вас, её не видел.', confirm: 'Удалить', tone: 'danger' }
      : { title: 'Удалить задачу?', text: 'Она пропадёт у всех исполнителей. Вернуть не получится.', confirm: 'Удалить', tone: 'danger' }))) return;
    try { await deleteTask(task.id); onGone(); } catch { showToast('Не удалил — нет прав или нет связи с сервером.', 'error'); }
  };

  // Enter или ↓ в заголовке — в начало текста.
  const onTitleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.key === 'Enter' && !e.nativeEvent.isComposing) || e.key === 'ArrowDown') {
      e.preventDefault();
      const el = e.currentTarget.closest('.ntd-page')?.querySelector<HTMLElement>('.nve-content');
      el?.focus();
    }
  };

  // ── Вложения: материалы «Офиса», файлы из «Файлов», файлы с компьютера, ссылки ──
  const attachments = attachmentsOf(task.metadata);
  const setAttachments = (next: Attachment[]) => patch({ metadata: { ...(useTasks.getState().tasks[task.id]?.metadata || task.metadata || {}), attachments: next } });
  const attach = (a: Attachment) => {
    const current = attachmentsOf(useTasks.getState().tasks[task.id]?.metadata);
    const same = current.some((x) => (x.type === 'office' && a.type === 'office' && x.itemId === a.itemId) || (x.type === 'cloud' && a.type === 'cloud' && x.fileId === a.fileId));
    if (!same) void setAttachments([...current, a]);
  };
  const detach = (id: string) => void setAttachments(attachmentsOf(useTasks.getState().tasks[task.id]?.metadata).filter((a) => a.id !== id));
  // Свой закрытый материал прикрепили к задаче с исполнителями — предложить открыть им, иначе вложение у них не откроется.
  const pickOffice = async (a: Attachment, hit?: { isOwner?: boolean; accessLevel?: string; title: string }) => {
    setAttachSheet(null);
    attach(a);
    const others = assigneesOf(task).filter((id) => id !== myId());
    if (a.type !== 'office' || !hit?.isOwner || hit.accessLevel === 'all' || !others.length) return;
    const ok = await askConfirm({ title: `Открыть «${hit.title || 'материал'}» исполнителям?`, text: 'Сейчас он виден только вам — исполнители не смогут его открыть. Они получат право смотреть и править.', confirm: 'Открыть' });
    if (!ok) return;
    try {
      for (const userId of others) {
        const res = await fetch(`/api/workspace/items/${encodeURIComponent(a.itemId)}/shares`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, role: 'edit' }) });
        if (!res.ok) throw new Error(String(res.status));
      }
      showToast('Исполнители получили доступ', 'success');
    } catch { showToast('Доступ не выдался — откройте материал и поделитесь им вручную.', 'error'); }
  };
  const uploadFiles = async (files: File[]) => {
    if (!files.length) return;
    const { uploadFileWithProgress } = await import('@/shared/api/uploadFile');
    setUploading((n) => n + files.length);
    for (const file of files) {
      try {
        const res = await uploadFileWithProgress(file, () => {});
        attach({ id: newId(), type: 'file', url: res.url, name: file.name, size: file.size });
      } catch { showToast(`«${file.name}» не загрузился — проверьте связь.`, 'error'); } finally { setUploading((n) => n - 1); }
    }
  };
  const attachTools = [
    { key: 'office', title: 'Прикрепить документ из «Офиса»', icon: <FileText size={16} />, onClick: () => setAttachSheet('office') },
    { key: 'cloud', title: 'Прикрепить файл из «Файлов»', icon: <Cloud size={16} />, onClick: () => setAttachSheet('cloud') },
    { key: 'upload', title: 'Прикрепить файл с компьютера', icon: <Paperclip size={16} />, onClick: () => filePick.current?.click() },
    { key: 'link', title: 'Прикрепить ссылку', icon: <Link2 size={16} />, onClick: () => setAttachSheet('link') },
  ];

  const repeat = repeatIdOf(task);
  const repeatTime = repeatTimeOf(task);
  // Повтор: пометка в задаче (правило и своё время) + серия сроков в календаре на месяц вперёд.
  const setRepeat = async (id: string, time: string = repeatTime) => {
    const metadata = { ...(useTasks.getState().tasks[task.id]?.metadata || task.metadata || {}), repeat: id === 'none' ? null : id, repeatTime: id === 'none' || !time ? null : time };
    try {
      await patch({ metadata });
      if (!draft) await syncTaskRepeat({ ...task, metadata }, id);
    } catch {
      showToast('Повтор не сохранился — нет связи с сервером.', 'error');
    }
  };

  const status = statusOf(task);
  const statusInfo = STATUSES.find((s) => s.id === status) || STATUSES[1];
  const done = isDone(task);
  // Задача «себе» — без исполнителя: заказчик и так виден, исполнитель подразумевается тот же (api.shownAssignees).
  const assignees = shownAssignees(task);
  // Этап цепочки — у него ответственный: своя роль цепочки (не исполнитель), по умолчанию заказчик.
  // Цепочка из одного этапа (остаток после разборки) — не цепочка: у такой задачи обычный «Исполнитель».
  const chainRef = chainOf(task);
  const chain = chainRef && Object.values(tasksById).some((t) => t.id !== task.id && chainOf(t)?.id === chainRef.id) ? chainRef : null;
  const owner = chain ? chainOwnerOf(task) : '';
  const ownerIsDefault = Boolean(chain) && !chain?.owner;
  const due = dueLabel(task.dueDate);
  const list = lists.find((l) => l.id === task.listId);
  const priority = PRIORITIES.find((p) => p.id === (task.priority || 'medium'))!;
  const customer = task.assignedById ? users[String(task.assignedById)] : undefined;
  const open = (kind: 'status' | 'priority' | 'list' | 'more' | 'date' | 'repeat' | 'attach') => (e: React.MouseEvent<HTMLButtonElement>) => setMenu({ kind, anchor: { element: e.currentTarget, align: kind === 'more' ? 'end' : 'start' } });

  return (
    <div className="ntd-shell" data-comments={cmOpen && !draft ? 'true' : undefined}>
    <section className="ntd" aria-label={title || 'Задача'}>
      <header className="ntd-bar">
        <button type="button" className="nx-icon-btn ntd-back" onClick={onBack} aria-label="К списку задач"><ArrowLeft size={20} aria-hidden="true" /></button>
        {/* Два режима: просмотр · правка (визуально, без разметки). Esc в правке — назад к просмотру. */}
        <div className="nx-segment ntd-modes" role="group" aria-label="Режим">
          <button type="button" aria-pressed={mode === 'preview'} onClick={() => switchMode('preview')}><Eye size={14} aria-hidden="true" /> Просмотр</button>
          <button type="button" aria-pressed={mode === 'visual'} disabled={viewOnly} title={viewOnly ? 'Папка открыта вам только на просмотр' : 'Правка как в обычном редакторе'} onClick={() => switchMode('visual')}><Pencil size={14} aria-hidden="true" /> Правка</button>
        </div>
        {draft ? (
          <span className="ntd-draft-bar">
            <span className="ntd-draft-note" title="Исполнители увидят задачу и получат уведомление только после «Создать»">Черновик — видите только вы</span>
            <button type="button" className="nx-primary ntd-create" onClick={() => void publish()} disabled={publishing} title="Создать задачу (Ctrl+Enter)">
              {publishing ? <Spinner size={14} /> : <Check size={15} aria-hidden="true" />} Создать
            </button>
          </span>
        ) : (
        <span className="ntd-save" aria-live="polite">
          {state === 'error' ? <span data-tone="danger"><AlertCircle size={13} aria-hidden="true" /> Не сохранилось — Ctrl+S</span>
            : state === 'saving' || state === 'pending' ? <span><Spinner size={13} /> Сохраняю</span>
              : <span><Check size={13} aria-hidden="true" /> Сохранено</span>}
        </span>
        )}
        {!draft && (
          <button type="button" className="nx-icon-btn ntd-cm-btn" aria-pressed={cmOpen} onClick={() => setCmOpen(!cmOpen)}
            title={cmOpen ? 'Скрыть комментарии' : 'Комментарии (выделите текст и Ctrl+Alt+M)'} aria-label="Комментарии">
            <MessageSquare size={18} aria-hidden="true" />
            {comments.open.length > 0 && <span className="ntd-cm-count">{comments.open.length}</span>}
          </button>
        )}
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
          {customer ? (String(customer.id) === myId() ? 'Я' : displayName(customer)) : 'не указан'}
        </button>
        {/* У этапа цепочки на месте исполнителя — ответственный за этап (своя роль цепочки, исполнитель в данных не трогается). */}
        {!chain && <button type="button" className="ntd-chip" onClick={() => setPeople('assignees')} aria-label="Исполнители" {...assigneeHover.bind}>
          <span className="ntd-chip-label">Исполнитель</span>
          {assignees.length ? (
            <span className="ntd-faces">
              {assignees.slice(0, 3).map((id) => { const u = users[id]; return <Avatar key={id} name={displayName(u) || '?'} seed={id} src={u?.avatar} person size={20} />; })}
            </span>
          ) : <UserPlus size={14} aria-hidden="true" />}
          {assignees.length === 1 ? (assignees[0] === myId() ? 'Я' : displayName(users[assignees[0]]) || 'Исполнитель') : assignees.length ? `${assignees.length} исполнителя` : 'Исполнитель'}
        </button>}
        {chain && (
          // Ответственный за этап цепочки — своя роль цепочки: кто ведёт этот этап и получит «Ваша очередь».
          <button type="button" className="ntd-chip" onClick={() => setPeople('owner')} aria-label="Ответственный за этап" title="Кто ведёт этот этап цепочки. По умолчанию — заказчик задачи">
            <span className="ntd-chip-label">Ответственный</span>
            {owner ? <span className={`ntd-faces${ownerIsDefault ? ' ntd-implicit' : ''}`}><Avatar name={displayName(users[owner]) || '?'} seed={owner} src={users[owner]?.avatar} person size={20} /></span> : <UserPlus size={14} aria-hidden="true" />}
            {owner ? `${owner === myId() ? 'Я' : displayName(users[owner]) || 'Сотрудник'}${ownerIsDefault ? ' (заказчик)' : ''}` : 'не указан'}
          </button>
        )}
        <button type="button" className="ntd-chip" data-tone={due?.late && !done ? 'danger' : undefined} onClick={open('date')} aria-haspopup="menu">
          <CalendarDays size={14} aria-hidden="true" />
          {due ? due.text : 'Срок'}
        </button>
        <button type="button" className="ntd-chip" data-on={repeat !== 'none' ? 'true' : undefined} onClick={open('repeat')} aria-haspopup="menu" title="Повторять задачу — сроки на месяц вперёд в календаре">
          <Repeat size={14} aria-hidden="true" />{repeat !== 'none' ? repeatLabel(repeat, repeatTime) : 'Повтор'}
        </button>
        <button type="button" className="ntd-chip" data-priority={task.priority || 'medium'} onClick={open('priority')} aria-haspopup="menu">
          <Flag size={14} aria-hidden="true" />{priority.label}
        </button>
        {(
          <button type="button" className="ntd-chip" onClick={open('list')} aria-haspopup="menu" style={list?.color ? ({ '--tone': list.color } as CSSProperties) : undefined}>
            <FolderClosed size={14} aria-hidden="true" />{list?.name || 'Без папки'}
          </button>
        )}
        {agentOn && !draft && (
          <button type="button" className="ntd-chip" onClick={openAgent} title="Поручить задачу агенту: проснётся по сроку, выполнит и отчитается здесь">
            <Bot size={14} aria-hidden="true" />Агент
          </button>
        )}
        <button type="button" className="ntd-chip" onClick={open('attach')} aria-haspopup="menu">
          {uploading > 0 ? <Spinner size={13} /> : <Paperclip size={14} aria-hidden="true" />}{uploading > 0 ? 'Загружаю…' : 'Прикрепить'}
        </button>
      </div>

      <AttachmentList items={attachments} onRemove={detach} />
      {agentOn && !draft && <AgentReports task={task} version={agentVersion} onOpen={openAgent} />}
      <input ref={filePick} type="file" multiple hidden onChange={(e) => { void uploadFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />

      <div className="ntd-scroll nx-scroll-y" ref={pageRef} onClick={onPageClick}
        onContextMenu={(e) => {
          // Своё меню — только над текстом; Shift+ПКМ — системное (подсказки орфографии).
          if (e.shiftKey || !(e.target as HTMLElement).closest('.ntd-read, .nve-content')) return;
          e.preventDefault();
          setTextMenu({ x: e.clientX, y: e.clientY });
        }}>
        {editing ? (
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
            <Suspense fallback={<div className="nx-state"><Spinner size={20} label="Загружаю редактор" /></div>}>
              <VisualEditor
                value={md}
                onChange={setMd}
                onBlur={() => void save()}
                placeholder="Подробности, чек-лист, ссылки. Картинку можно вставить из буфера. Сохраняется само."
                uploadImage={async (file) => (await (await import('@/shared/api/uploadFile')).uploadFileWithProgress(file, () => {})).url}
                extraTools={attachTools}
              />
            </Suspense>
          </div>
        ) : (
          <article className="ntd-page ntd-read" onDoubleClick={() => { if (!viewOnly) setMode('visual'); }} data-streaming={stream ? 'true' : undefined}>
            {stream && <div className="ntd-stream" role="status"><i aria-hidden="true" />{stream.agent} пишет…</div>}
            <h1 className="ntd-title-view" data-done={done ? 'true' : undefined}>{(stream && stream.title) || title || 'Без названия'}</h1>
            {stream
              ? <div className="ntd-md">{renderMarkdown(stream.md)}<span className="ntd-stream-caret" aria-hidden="true" /></div>
              : md.trim()
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
          <div className="nx-menu-sep" />
          {/* По дням недели: щелчок по дню включает/выключает его, меню не закрывается. */}
          <div className="nx-menu-label">По дням недели</div>
          <div className="ntd-weekdays" role="group" aria-label="Дни недели">
            {WEEKDAYS.map((d) => {
              const on = daysOf(repeat).includes(d.code);
              return (
                <button key={d.code} type="button" className="ntd-weekday" aria-pressed={on} title={`По ${d.plural}`}
                  onClick={() => { const cur = daysOf(repeat); void setRepeat(daysId(on ? cur.filter((c) => c !== d.code) : [...cur, d.code])); }}>{d.short}</button>
              );
            })}
          </div>
          <label className="ntd-repeat-time">
            <span>Время</span>
            <input type="time" value={repeatTime} disabled={repeat === 'none'} onChange={(e) => { if (repeat !== 'none') void setRepeat(repeat, e.target.value); }} />
            {repeatTime && <button type="button" className="nx-ghost" onClick={() => void setRepeat(repeat, '')}>Убрать</button>}
          </label>
        </Menu>
      )}
      {menu?.kind === 'date' && (
        <DatePicker withTime anchor={menu.anchor} value={task.dueDate ? String(task.dueDate) : null} onPick={(iso) => {
          void patch({ dueDate: iso }).then(() => {
            // Повторяющаяся задача: серия в календаре идёт от нового срока.
            if (repeat !== 'none' && !draft) syncTaskRepeat({ ...task, dueDate: iso }, repeat).catch(() => showToast('Календарь не обновился — нет связи с сервером.', 'error'));
          });
        }} onClose={() => setMenu(null)} />
      )}
      {menu?.kind === 'list' && (
        <Menu anchor={menu.anchor} label="Папка" onClose={() => setMenu(null)}>
          <MenuItem icon={!task.listId ? <Check size={16} /> : <span className="ntd-menu-gap" />} onSelect={() => { setMenu(null); void patch({ listId: null }); }}>Без папки</MenuItem>
          {lists.filter((l) => canAddToFolder(l) || l.id === task.listId).map((l) => (
            <MenuItem key={l.id} icon={l.id === task.listId ? <Check size={16} /> : <i className="ntd-dot" style={{ '--tone': l.color || 'var(--note-gray)' } as CSSProperties} />} onSelect={() => { setMenu(null); void patch({ listId: l.id }); }}>{l.name}</MenuItem>
          ))}
          <div className="nx-menu-sep" />
          <MenuItem icon={<FolderPlus size={16} />} onSelect={() => { setMenu(null); setNewFolder(true); }}>Новая папка…</MenuItem>
        </Menu>
      )}
      {menu?.kind === 'attach' && (
        <Menu anchor={menu.anchor} label="Прикрепить" onClose={() => setMenu(null)}>
          {attachTools.map((t) => (
            <MenuItem key={t.key} icon={t.icon} onSelect={() => { setMenu(null); t.onClick(); }}>{t.title.replace('Прикрепить ', '').replace(/^./, (c) => c.toUpperCase())}</MenuItem>
          ))}
        </Menu>
      )}
      {(attachSheet === 'office' || attachSheet === 'cloud') && (
        <AttachPicker source={attachSheet} onClose={() => setAttachSheet(null)} onPick={(a, hit) => void pickOffice(a, hit)} />
      )}
      {attachSheet === 'link' && <LinkSheet onClose={() => setAttachSheet(null)} onAdd={(a) => { setAttachSheet(null); attach(a); }} />}
      {menu?.kind === 'more' && (
        <Menu anchor={menu.anchor} label="Задача" onClose={() => setMenu(null)}>
          {!draft && <MenuItem icon={<History size={16} />} onSelect={() => { setMenu(null); void save(); setVersions(true); }}>История версий…</MenuItem>}
          {!draft && <div className="nx-menu-sep" />}
          <MenuItem icon={<Trash2 size={16} />} tone="danger" onSelect={() => { setMenu(null); void remove(); }}>{draft ? 'Удалить черновик' : 'Удалить задачу'}</MenuItem>
        </Menu>
      )}
      {assigneeHover.at && assignees.length > 0 && <PeopleHoverCard ids={assignees} at={assigneeHover.at} />}
      {newFolder && <FolderSheet onClose={() => setNewFolder(false)} onSaved={(l) => { setNewFolder(false); void patch({ listId: l.id }); }} />}
      {agentSheet && <AgentSheet task={task} state={agentSheet} onClose={() => setAgentSheet(null)} onChanged={() => setAgentVersion((v) => v + 1)} />}
      {versions && <TaskVersionsSheet taskId={task.id} canRestore={!viewOnly} onClose={() => setVersions(false)} onRestore={restoreVersion} />}
      {people === 'assignees' && <PeopleSheet title="Исполнители" selected={assignees} onClose={() => setPeople(null)} onSave={(ids) => { setPeople(null); void patch({ assignedToIds: ids, assignedToId: ids[0] || null }); }} />}
      {people === 'owner' && chain && (
        <PeopleSheet
          title="Ответственный за этап"
          single
          selected={owner ? [owner] : []}
          onClose={() => setPeople(null)}
          onSave={(ids) => {
            setPeople(null);
            const next = ids[0] && ids[0] !== customerOf(task) ? ids[0] : undefined; // заказчик — значение по умолчанию
            void setChain(task.id, { ...chain, owner: next }).catch(() => showToast('Не сохранилось — нет связи с сервером.', 'error'));
          }}
        />
      )}
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
      {cmMounted && !draft && (
        <CommentsPanel comments={comments} kind="task" canModerate={String(task.authorId || '') === myId()} getAnchor={getCommentAnchor}
          onJump={jumpToQuote} focusTick={cmFocus} focusCell={cmThread} onClose={() => setCmOpen(false)} closing={!cmOpen} />
      )}
      {textMenu && <TaskTextMenu at={textMenu} editable={editing && !viewOnly} root={pageRef.current} onComment={draft ? undefined : startComment} onClose={() => setTextMenu(null)} />}
    </div>
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
      // Уже выбранные — наверху (по выбору на момент открытия: список не прыгает, пока человек щёлкает), потом я, потом по имени.
      .sort((a, b) => Number(selected.includes(String(b.id))) - Number(selected.includes(String(a.id)))
        || Number(String(b.id) === me) - Number(String(a.id) === me) || displayName(a).localeCompare(displayName(b), 'ru'));
  }, [users, query, me, selected]);
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

/** Подсказка по наведению: через секунду под кнопкой — карточка; уходит, когда курсор ушёл. */
function useHoverCard(delay = 1000) {
  const [at, setAt] = useState<DOMRect | null>(null);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const bind = {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      const el = e.currentTarget;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setAt(el.getBoundingClientRect()), delay);
    },
    onMouseLeave: () => { window.clearTimeout(timer.current); setAt(null); },
    onMouseDown: () => { window.clearTimeout(timer.current); setAt(null); },
  };
  return { at, bind };
}

/** Все исполнители задачи: аватар и имя (на кнопке помещаются только три лица). */
function PeopleHoverCard({ ids, at }: { ids: string[]; at: DOMRect }) {
  const users = useChatStore((s) => s.users);
  const me = myId();
  return createPortal(
    <div className="ntd-hovercard" role="tooltip" style={{ left: Math.max(8, Math.min(at.left, window.innerWidth - 268)), top: at.bottom + 6 }}>
      <div className="ntd-hovercard-head">Исполнители · {ids.length}</div>
      {ids.map((id) => {
        const u = users[id];
        const name = displayName(u) || 'Сотрудник';
        return (
          <div key={id} className="ntd-hovercard-row">
            <Avatar name={name} seed={id} src={u?.avatar} person size={24} />
            <span>{id === me ? `${name} (я)` : name}</span>
          </div>
        );
      })}
    </div>,
    document.querySelector('.nx') || document.body,
  );
}
