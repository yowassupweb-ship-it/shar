import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { Clock, CornerDownLeft, FileText, RefreshCw, Search, Shield, Trash2, X, Zap } from 'lucide-react';
import {
  chatTitle, isFavorites, isGroupChat, isNotifications, lastActivity, otherParticipant, requestJump, useChatStore,
} from '@/features/chat';
import { useTasks, loadTasks } from '@/features/tasks/api';
import { KIND_LIST, KINDS } from '@/features/workspace/kinds';
import { workspaceApi } from '@/features/workspace/api';
import { navigate } from '@/shared/navigation/navigate';
import { links, paths } from '@/shared/navigation/routes';
import { myId } from '@/shared/session/session';
import { Avatar } from '@/shared/ui/Avatar';
import { SectionIcon, type SectionIconName } from '@/shared/ui/SectionIcon';
import { showToast } from '@/shared/ui/Toast';
import { clearVisits, forgetVisit, getVisits, onVisitsChanged, type Visit } from './history';
import { norm, relativeTime, scoreText, variants } from './engine';
import './spotlight.css';

/**
 * Поиск «как Spotlight»: одно окно на всё приложение. Ctrl/⌘+K (в любой раскладке) или кнопка в шапке.
 * Пока поле пустое — недавние места (история посещений) и быстрые действия. Когда печатаем — чаты, люди,
 * материалы «Офиса», задачи, файлы и сообщения из всех чатов; запрос в неверной раскладке тоже находит.
 */

export const useSpotlight = create<{ open: boolean }>(() => ({ open: false }));
export const openSpotlight = () => useSpotlight.setState({ open: true });
export const closeSpotlight = () => useSpotlight.setState({ open: false });

interface Result {
  key: string;
  group: string;
  title: string;
  subtitle?: string;
  icon: ReactNode;
  score: number;
  run: () => void;
  /** Можно убрать из истории (только записи истории). */
  forget?: () => void;
}

/** Ответ /api/search: всё, что нельзя целиком держать на клиенте, — только то, что человеку доступно. */
interface Remote {
  messages: Array<{ id: string; chatId: string; authorName: string; createdAt: string; snippet: string }>;
  items: Array<{ id: string; kind: keyof typeof KINDS; title: string; snippet: string; updatedAt: string; ownerName: string }>;
  files: Array<{ id: string; name: string; folderId: string | null; size: number | null; mimeType: string; updatedAt: string }>;
  attachments: Array<{ messageId: string; chatId: string; authorName: string; createdAt: string; name: string; url: string; size: number | null }>;
  events: Array<{ id: string; title: string; snippet: string; startDate: string; endDate: string }>;
  mail: Array<{ id: string; accountId: string; folder: string; subject: string; from: string; date: string; snippet: string }>;
}
const EMPTY: Remote = { messages: [], items: [], files: [], attachments: [], events: [], mail: [] };

const GROUP_ORDER = ['Недавние', 'Быстрые действия', 'Чаты', 'Люди', 'Офис', 'Задачи', 'События', 'Файлы', 'Письма', 'Сообщения'];
const GROUP_LIMIT: Record<string, number> = { Недавние: 7, 'Быстрые действия': 6, Чаты: 5, Люди: 4, Офис: 6, Задачи: 5, События: 4, Файлы: 6, Письма: 5, Сообщения: 8 };
/** Группы, где в подписи тоже подсвечиваем найденное (там совпало внутри текста). */
const SNIPPET_GROUPS = new Set(['Сообщения', 'Офис', 'События', 'Письма']);

/** Склеить ответы на запрос в двух раскладках, не повторяя одно и то же. */
function mergeRemote(answers: Remote[]): Remote {
  const uniq = <T,>(rows: T[], key: (r: T) => string) => {
    const seen = new Set<string>();
    return rows.filter((r) => { const k = key(r); if (seen.has(k)) return false; seen.add(k); return true; });
  };
  const pick = <T,>(rows: (a: Remote) => T[], key: (r: T) => string) => uniq(answers.flatMap(rows), key);
  return {
    messages: pick((a) => a.messages, (m) => m.id),
    items: pick((a) => a.items, (i) => i.id),
    files: pick((a) => a.files, (f) => f.id),
    attachments: pick((a) => a.attachments, (x) => `${x.messageId}:${x.url}`),
    events: pick((a) => a.events, (e) => e.id),
    mail: pick((a) => a.mail, (m) => m.id),
  };
}

const fileSize = (n: number | null) => (n == null ? '' : n < 1024 ? `${n} Б` : n < 1048576 ? `${Math.round(n / 1024)} КБ` : `${(n / 1048576).toFixed(1)} МБ`);
const dayOf = (iso: string) => (iso || '').slice(0, 10);
const dateLabel = (iso: string) => {
  const t = Date.parse((iso || '').replace(' ', 'T'));
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
};

function goToChat(chatId: string) {
  if (window.location.pathname === paths.chats) window.dispatchEvent(new CustomEvent('nx:open-chat', { detail: chatId }));
  else navigate(links.chat(chatId));
}

function Highlight({ text, queries }: { text: string; queries: string[] }) {
  const lower = norm(text);
  for (const q of queries) {
    const at = lower.indexOf(q);
    if (at >= 0) return <>{text.slice(0, at)}<mark>{text.slice(at, at + q.length)}</mark>{text.slice(at + q.length)}</>;
  }
  return <>{text}</>;
}

/** Значок раздела — та же объёмная картинка, что в нижнем меню, а не контурная иконка. */
const sec = (name: SectionIconName) => <SectionIcon name={name} size={26} />;

const VISIT_ICON: Record<string, ReactNode> = {
  chat: sec('chats'), task: sec('todo'), file: sec('files'), person: sec('contacts'),
};

function kindIcon(kind: keyof typeof KINDS): ReactNode {
  const info = KINDS[kind];
  return <span className="nsp-kind" style={{ '--a': info.tint[0], '--b': info.tint[1] } as React.CSSProperties}><info.icon size={15} /></span>;
}

interface Action { id: string; title: string; subtitle: string; words: string; icon: ReactNode; run: () => void }

async function createOffice(kind: keyof typeof KINDS) {
  try {
    const { initialContent } = await import('@/features/workspace/ItemView');
    const item = await workspaceApi.create({ kind, title: '', content: await initialContent(kind) });
    navigate(links.office(kind, item.id));
  } catch (cause) { showToast(cause instanceof Error ? cause.message : 'Не удалось создать', 'error'); }
}

function buildActions(isAdmin: boolean): Action[] {
  const go = (path: string) => () => navigate(path);
  const sections: Action[] = [
    { id: 'go-chats', title: 'Чаты', subtitle: 'Перейти в раздел', words: 'chats messages сообщения переписка', icon: sec('chats'), run: go(paths.chats) },
    { id: 'go-tasks', title: 'Задачи', subtitle: 'Перейти в раздел', words: 'tasks todo дела', icon: sec('todo'), run: go(paths.tasks) },
    { id: 'go-calendar', title: 'Календарь', subtitle: 'Перейти в раздел', words: 'calendar события встречи', icon: sec('calendar'), run: go(paths.calendar) },
    { id: 'go-contacts', title: 'Контакты', subtitle: 'Перейти в раздел', words: 'contacts люди сотрудники', icon: sec('contacts'), run: go(paths.contacts) },
    { id: 'go-files', title: 'Файлы', subtitle: 'Перейти в раздел', words: 'files облако диск', icon: sec('files'), run: go(paths.files) },
    { id: 'go-mail', title: 'Почта', subtitle: 'Перейти в раздел', words: 'mail email письма', icon: sec('mail'), run: go(paths.mail) },
    { id: 'go-office', title: 'Офис', subtitle: 'Заметки, документы, таблицы, презентации', words: 'office docs документы', icon: sec('office'), run: go(paths.office) },
    { id: 'go-settings', title: 'Настройки', subtitle: 'Профиль, уведомления, внешний вид', words: 'settings параметры тема звук', icon: sec('menu'), run: go(paths.settings) },
    { id: 'go-guide', title: 'Инструкция', subtitle: 'Как работать в Шаре', words: 'guide help помощь справка', icon: <FileText size={16} />, run: go(paths.guide) },
  ];
  if (isAdmin) sections.push({ id: 'go-admin', title: 'Админка', subtitle: 'Пользователи, права, система', words: 'admin администрирование', icon: <Shield size={16} />, run: go(paths.admin) });
  const create: Action[] = KIND_LIST.map((k) => ({
    id: `new-${k.kind}`, title: k.newLabel, subtitle: 'Создать и открыть в «Офисе»', words: `new create создать ${k.kind} ${k.plural}`, icon: kindIcon(k.kind), run: () => { void createOffice(k.kind); },
  }));
  const desk = window.sharDesktop;
  const extra: Action[] = desk ? [{ id: 'reload', title: 'Перезагрузить окно', subtitle: 'Обновить интерфейс', words: 'reload refresh обновить перезапустить', icon: <RefreshCw size={16} />, run: () => desk.windowControls.reload?.() }] : [];
  return [...create, ...sections, ...extra];
}

export function SpotlightHost() {
  const open = useSpotlight((s) => s.open);

  // Ctrl/⌘+K — по физической клавише, поэтому работает и в русской раскладке (там на этой клавише «л»).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyK') {
        e.preventDefault();
        e.stopPropagation();
        useSpotlight.setState((s) => ({ open: !s.open }));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  if (!open) return null;
  const root = document.querySelector<HTMLElement>('.nx') || document.body;
  return createPortal(<SpotlightDialog />, root);
}

function SpotlightDialog() {
  const chats = useChatStore((s) => s.chats);
  const me = useChatStore((s) => s.me);
  const users = useChatStore((s) => s.users);
  const tasks = useTasks((s) => s.tasks);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [remote, setRemote] = useState<Remote>(EMPTY);
  const [searching, setSearching] = useState(false);
  const [visits, setVisits] = useState<Visit[]>(getVisits);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const queries = useMemo(() => variants(query), [query]);
  const isAdmin = me?.role === 'admin';
  const actions = useMemo(() => buildActions(Boolean(isAdmin)), [isAdmin]);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => onVisitsChanged(() => setVisits(getVisits())), []);
  useEffect(() => { void loadTasks().catch(() => undefined); }, []);

  // Сообщения, материалы, файлы, события и письма — с сервера: на клиенте целиком их нет, а права проверяет сервер.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) { setRemote(EMPTY); setSearching(false); return undefined; }
    setSearching(true);
    const ctrl = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const answers = await Promise.all(variants(trimmed).slice(0, 2).map(async (q) => {
          const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=12`, { signal: ctrl.signal, cache: 'no-store' });
          return res.ok ? ((await res.json()) as Remote) : EMPTY;
        }));
        setRemote(mergeRemote(answers));
      } catch { /* запрос отменён новым вводом */ } finally { if (!ctrl.signal.aborted) setSearching(false); }
    }, 220);
    return () => { window.clearTimeout(timer); ctrl.abort(); };
  }, [query]);

  const close = closeSpotlight;
  const visited = useMemo(() => new Map(visits.map((v) => [v.key, v])), [visits]);
  /** Недавний заход поднимает результат выше: до +8 баллов, быстро затухает. */
  const recencyBonus = useCallback((key: string) => {
    const v = visited.get(key);
    if (!v) return 0;
    const days = (Date.now() - v.ts) / 86_400_000;
    return Math.max(1, Math.round(8 - days));
  }, [visited]);

  const results = useMemo<Result[]>(() => {
    const out: Result[] = [];
    // Чат — аватаркой собеседника или группы, как в списке чатов; человек — своей.
    const chatIcon = (chatId: string): ReactNode | undefined => {
      const c = chats[chatId];
      if (!c) return undefined;
      if (isNotifications(c)) return sec('uved');
      if (isFavorites(c)) return sec('izb');
      const other = isGroupChat(c) ? undefined : otherParticipant(c, me, users);
      return <Avatar name={chatTitle(c, me, users)} seed={String(c.id)} src={c.avatar || other?.avatar} person={!isGroupChat(c)} size={28} />;
    };
    const personIcon = (userId: string): ReactNode | undefined => {
      const u = users[userId];
      return u ? <Avatar name={u.name || u.username || ''} seed={String(u.id)} src={u.avatar} person size={28} /> : undefined;
    };
    const open = (fn: () => void) => () => { close(); fn(); };

    if (!queries.length) {
      for (const v of visits.slice(0, GROUP_LIMIT['Недавние'])) {
        out.push({
          key: v.key, group: 'Недавние', title: v.title, subtitle: `${v.subtitle ? `${v.subtitle} · ` : ''}${relativeTime(v.ts)}`, score: 1000 - out.length,
          icon: v.kind === 'office' && v.sub && v.sub in KINDS ? kindIcon(v.sub as keyof typeof KINDS)
            : v.kind === 'chat' ? chatIcon(v.key.slice(5)) ?? VISIT_ICON.chat
              : v.kind === 'person' ? personIcon(v.key.slice(7)) ?? VISIT_ICON.person : VISIT_ICON[v.kind],
          run: open(() => { if (v.kind === 'chat') goToChat(v.key.slice(5)); else navigate(v.path); }),
          forget: () => forgetVisit(v.key),
        });
      }
      actions.forEach((a, i) => out.push({ key: a.id, group: 'Быстрые действия', title: a.title, subtitle: a.subtitle, icon: a.icon, score: 500 - i, run: open(a.run) }));
      return out;
    }

    for (const a of actions) {
      const s = Math.max(scoreText(a.title, queries), scoreText(a.words, queries) * 0.8);
      if (s >= 55) out.push({ key: a.id, group: 'Быстрые действия', title: a.title, subtitle: a.subtitle, icon: a.icon, score: s + 5, run: open(a.run) });
    }

    for (const c of Object.values(chats)) {
      if (isNotifications(c)) continue;
      const title = chatTitle(c, me, users);
      const s = scoreText(title, queries);
      if (!s) continue;
      out.push({
        key: `chat:${c.id}`, group: 'Чаты', title, subtitle: isGroupChat(c) ? 'Групповой чат' : isFavorites(c) ? 'Личные заметки' : 'Личный чат', score: s + recencyBonus(`chat:${c.id}`) + Math.min(5, lastActivity(c) / 1e13),
        icon: chatIcon(String(c.id)),
        run: open(() => goToChat(String(c.id))),
      });
    }

    for (const raw of Object.values(users)) {
      const u = raw as typeof raw & { phone?: string; position?: string };
      if (String(u.id) === myId()) continue;
      const name = u.name || u.username || '';
      const s = Math.max(scoreText(name, queries), scoreText(u.username || '', queries) * 0.9, scoreText(u.email || '', queries) * 0.7, scoreText(u.phone || '', queries) * 0.7);
      if (!s) continue;
      out.push({
        key: `person:${u.id}`, group: 'Люди', title: name || String(u.id), subtitle: [u.position, u.email].filter(Boolean).join(' · ') || 'Сотрудник', score: s + recencyBonus(`person:${u.id}`),
        icon: <Avatar name={name} seed={String(u.id)} src={u.avatar} person size={28} />,
        run: open(() => navigate(links.contact(String(u.id)))),
      });
    }

    const seenItems = new Set<string>();
    for (const item of remote.items) {
      seenItems.add(item.id);
      const s = Math.max(scoreText(item.title || KINDS[item.kind].untitled, queries), 40);
      out.push({
        key: `office:${item.id}`, group: 'Офис', title: item.title || KINDS[item.kind].untitled, subtitle: `${KINDS[item.kind].accusative.replace(/^./, (c) => c.toUpperCase())}${item.snippet ? ` · ${item.snippet}` : ''}`,
        icon: kindIcon(item.kind), score: s + recencyBonus(`office:${item.id}`), run: open(() => navigate(links.office(item.kind, item.id))),
      });
    }
    for (const v of visits) {
      if (v.kind !== 'office' || seenItems.has(v.key.slice(7))) continue;
      const s = scoreText(v.title, queries);
      if (s) out.push({ key: v.key, group: 'Офис', title: v.title, subtitle: 'Недавно открывали', icon: v.sub && v.sub in KINDS ? kindIcon(v.sub as keyof typeof KINDS) : <FileText size={16} />, score: s + 3, run: open(() => navigate(v.path)) });
    }

    for (const t of Object.values(tasks)) {
      if (t.archived) continue;
      const s = Math.max(scoreText(t.title, queries), scoreText(t.description || '', queries) * 0.5);
      if (!s) continue;
      out.push({
        key: `task:${t.id}`, group: 'Задачи', title: t.title, subtitle: t.completed || t.isCompleted ? 'Выполнена' : t.dueDate ? `до ${new Date(t.dueDate).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}` : 'Задача',
        icon: sec('todo'), score: s + recencyBonus(`task:${t.id}`), run: open(() => navigate(links.task(t.id))),
      });
    }

    for (const t of remote.events) {
      out.push({
        key: `event:${t.id}`, group: 'События', title: t.title || 'Событие', subtitle: [dateLabel(t.startDate), t.snippet].filter(Boolean).join(' · '),
        icon: sec('calendar'), score: Math.max(scoreText(t.title, queries), 40) + recencyBonus(`event:${t.id}`),
        run: open(() => navigate(links.event(t.id, dayOf(t.startDate)))),
      });
    }

    for (const f of remote.files) {
      out.push({
        key: `file:${f.id}`, group: 'Файлы', title: f.name, subtitle: ['Файл в облаке', fileSize(f.size)].filter(Boolean).join(' · '),
        icon: sec('files'), score: Math.max(scoreText(f.name, queries), 40) + recencyBonus(`file:${f.id}`), run: open(() => navigate(links.file(f.id))),
      });
    }
    for (const a of remote.attachments) {
      const chat = chats[a.chatId];
      const where = chat ? chatTitle(chat, me, users) : 'чат';
      out.push({
        key: `att:${a.messageId}:${a.url}`, group: 'Файлы', title: a.name, subtitle: ['Вложение', where, a.authorName, fileSize(a.size)].filter(Boolean).join(' · '),
        icon: chatIcon(a.chatId) ?? sec('files'), score: Math.max(scoreText(a.name, queries), 40) - 1, run: open(() => { requestJump(a.chatId, a.messageId); goToChat(a.chatId); }),
      });
    }

    for (const m of remote.mail) {
      out.push({
        key: `mail:${m.id}`, group: 'Письма', title: m.subject || '(без темы)', subtitle: [m.from, dateLabel(m.date), m.snippet].filter(Boolean).join(' · '),
        icon: sec('mail'), score: Math.max(scoreText(m.subject, queries), 40) + recencyBonus(`mail:${m.id}`),
        run: open(() => navigate(links.mail(m.id, m.accountId, m.folder))),
      });
    }

    for (const m of remote.messages) {
      const chat = chats[m.chatId];
      const where = chat ? chatTitle(chat, me, users) : 'чат';
      out.push({
        key: `msg:${m.id}`, group: 'Сообщения', title: m.snippet, subtitle: `${m.authorName ? `${m.authorName} · ` : ''}${where} · ${relativeTime(new Date(m.createdAt.replace(' ', 'T') + 'Z').getTime())}`,
        icon: chatIcon(m.chatId) ?? sec('chats'), score: 30, run: open(() => { requestJump(m.chatId, m.id); goToChat(m.chatId); }),
      });
    }

    const byGroup = new Map<string, Result[]>();
    for (const r of out) byGroup.set(r.group, [...(byGroup.get(r.group) || []), r]);
    const ordered: Result[] = [];
    for (const group of GROUP_ORDER) {
      const rows = (byGroup.get(group) || []).sort((a, b) => b.score - a.score).slice(0, GROUP_LIMIT[group]);
      ordered.push(...rows);
    }
    return ordered;
  }, [queries, visits, actions, chats, me, users, tasks, remote, recencyBonus, close]);

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => { setActive((i) => Math.min(i, Math.max(0, results.length - 1))); }, [results.length]);
  useEffect(() => { listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [active, results]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (results.length ? (i + 1) % results.length : 0)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (results.length ? (i - 1 + results.length) % results.length : 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); results[active]?.run(); }
    else if (e.key === 'Tab') { e.preventDefault(); setActive((i) => (results.length ? (i + (e.shiftKey ? -1 : 1) + results.length) % results.length : 0)); }
  };

  let lastGroup = '';
  return (
    <div className="nx-scrim nsp-scrim" data-kind="spotlight" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="nsp" role="dialog" aria-modal="true" aria-label="Поиск по Шару" onKeyDown={onKeyDown}>
        <div className="nsp-field">
          <Search size={18} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Искать по чатам, людям, документам, задачам, файлам, письмам…"
            role="combobox"
            aria-expanded="true"
            aria-controls="nsp-list"
            aria-activedescendant={results[active] ? `nsp-${active}` : undefined}
            autoComplete="off"
            spellCheck={false}
          />
          {query && <button type="button" className="nx-icon-btn" aria-label="Очистить" onClick={() => { setQuery(''); inputRef.current?.focus(); }}><X size={15} /></button>}
          <kbd>Esc</kbd>
        </div>

        <div className="nsp-list nx-scroll-y" id="nsp-list" role="listbox" ref={listRef}>
          {results.map((r, i) => {
            const header = r.group !== lastGroup;
            lastGroup = r.group;
            return (
              <div key={r.key} role="presentation">
                {header && (
                  <div className="nsp-group" role="presentation">
                    {r.group === 'Недавние' ? <Clock size={12} aria-hidden="true" /> : r.group === 'Быстрые действия' ? <Zap size={12} aria-hidden="true" /> : null}
                    {r.group}
                    {r.group === 'Недавние' && <button type="button" className="nsp-clear" onClick={() => clearVisits()}><Trash2 size={11} aria-hidden="true" /> Очистить</button>}
                  </div>
                )}
                <div
                  id={`nsp-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className="nsp-row"
                  onMouseMove={() => { if (i !== active) setActive(i); }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={r.run}
                >
                  <span className="nsp-icon" aria-hidden="true">{r.icon}</span>
                  <span className="nsp-text">
                    <span className="nsp-title"><Highlight text={r.title} queries={queries} /></span>
                    {r.subtitle && <span className="nsp-sub"><Highlight text={r.subtitle} queries={SNIPPET_GROUPS.has(r.group) ? queries : []} /></span>}
                  </span>
                  {r.forget && i === active && (
                    <button type="button" className="nx-icon-btn nsp-forget" aria-label="Убрать из истории" title="Убрать из истории" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); r.forget?.(); }}><X size={14} /></button>
                  )}
                  {i === active && !r.forget && <CornerDownLeft size={14} className="nsp-enter" aria-hidden="true" />}
                </div>
              </div>
            );
          })}
          {!results.length && (
            <p className="nsp-empty" role="status">
              {searching ? 'Ищу…' : query.trim().length < 2 && queries.length ? 'Продолжайте печатать…' : queries.length ? 'Ничего не нашлось. Проверьте написание — раскладку я уже учёл.' : 'Здесь появятся места, где вы были, и быстрые действия.'}
            </p>
          )}
          {searching && results.length > 0 && <p className="nsp-more" role="status">Ищу в сообщениях, файлах, письмах и событиях…</p>}
        </div>

        <div className="nsp-foot" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> выбрать</span>
          <span><kbd>Enter</kbd> открыть</span>
          <span><kbd>Ctrl</kbd><kbd>K</kbd> закрыть</span>
        </div>
      </div>
    </div>
  );
}
