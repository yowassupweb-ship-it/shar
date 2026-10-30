import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Archive, ArchiveRestore, ArrowDown, Atom, BarChart3, ChevronLeft, Lock, MessageSquarePlus, Pencil, Search, X } from 'lucide-react';
import { ForwardSheet } from '@/features/chat';
import { realtime } from '@/shared/realtime/realtime';
import { paths } from '@/shared/navigation/routes';
import { Spinner } from '@/shared/ui/Spinner';
import { showToast } from '@/shared/ui/Toast';
import { dayKey, formatDay, formatListTime, plural } from '@/shared/ui/format';
import { coreApi, type CoreLimit, type CoreMessage, type CoreThread } from './api';
import { ChatStats, LimitBadges } from './ChatStats';
import { Composer, COMMANDS, type ComposerHandle, type SendOptions } from './Composer';
import { MessageItem, type MessageHandlers } from './MessageItem';
import { formatTokens } from './parts';
import { setCorePanelThread, useCorePanel } from './panel';
import {
  createThread, loadAll, loadArchived, loadMessages, loadOlder, patchThread, retryMessage, sendMessage, upsertMessage, upsertThread, useCore,
} from './store';
import './core.css';

const EMPTY: CoreMessage[] = [];
/** Сколько последних сообщений на экране сразу и на сколько окно растёт при прокрутке вверх. */
const WINDOW = 60;
const WINDOW_STEP = 40;

function useNarrow() {
  const query = '(max-width: 760px)';
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

/**
 * «Ядро» — чат с личными агентами человека (Gemini, Claude, GPT — Настройки → Ядро), работающими на ноде компании:
 * треды, сообщения, вложения, ответы, команды, цепочка шагов и ход работы на глазах. Агент видит, что у человека
 * открыто (плашки «где я» над полем ввода). Включено админам; остальным — когда админ выдаст инструмент.
 *
 * Два места: страница /core и выдвижная панель справа (embedded, CorePanel). В панели всегда узкая раскладка
 * (список или переписка), а открытый чат хранится в панели, а не в адресе — иначе он менял бы адрес раздела слева.
 */
export default function CoreScreen({ embedded = false, onClose }: { embedded?: boolean; onClose?: () => void } = {}) {
  const [params, setParams] = useSearchParams();
  const panelThread = useCorePanel((s) => s.thread);
  const threadId = embedded ? panelThread : params.get('thread');
  const denied = useCore((s) => s.denied);
  const error = useCore((s) => s.error);
  const threads = useCore((s) => s.threads);
  const narrowScreen = useNarrow();
  const narrow = embedded || narrowScreen;
  const navigate = useNavigate();
  const leave = embedded && onClose ? onClose : () => navigate(paths.more);

  useEffect(() => { void loadAll(); }, []);
  // Живые события: ответы агентов, свои сообщения с других устройств, переименования и архив.
  useEffect(() => realtime.subscribe((event) => {
    const e = event as { type?: string; message?: CoreMessage; thread?: CoreThread };
    if (e.type === 'core_message' && e.message) upsertMessage(e.message);
    if (e.type === 'core_thread' && e.thread) upsertThread(e.thread);
    // Подключение изменилось (модели, лимиты подписки) — каталог агентов обновляется на месте.
    const acc = (event as { type?: string; account?: { provider: string; state: string; limits?: CoreLimit[]; models?: Array<{ id: string; label: string }>; model?: string } }).account;
    if (event.type === 'core_account' && acc) {
      useCore.setState((s) => {
        if (!s.catalog) return s;
        const known = s.catalog.agents.some((a) => a.id === acc.provider);
        if (!known || acc.state !== 'ready') { void loadAll(); return s; }
        return { catalog: { ...s.catalog, agents: s.catalog.agents.map((a) => (a.id === acc.provider
          ? { ...a, limits: acc.limits ?? a.limits, models: acc.models?.length ? acc.models : a.models, model: acc.model || a.model } : a)) } };
      });
    }
  }), []);

  // Узко (панель, телефон) — одно из двух: список чатов или разговор. Открыли «Ядро» — сразу разговор (последний
  // чат или новый с подсказками), список — по «назад»: начать спрашивать не должно стоить лишнего щелчка.
  const [listOpen, setListOpen] = useState(false);
  const select = useCallback((id: string | null) => {
    if (embedded) setCorePanelThread(id);
    else setParams(id ? { thread: id } : {}, { replace: false });
    setListOpen(false);
  }, [embedded, setParams]);

  if (denied) {
    return (
      <div className="ncore ncore-locked">
        <Lock size={36} strokeWidth={1.5} aria-hidden="true" />
        <h2>«Ядро» вам пока не включено</h2>
        <p>Это чат с агентами Шара. Сейчас он доступен администраторам — включить его вам может администратор.</p>
        <button type="button" className="nx-ghost" onClick={leave}>{embedded ? 'Закрыть' : 'Вернуться в «Ещё»'}</button>
      </div>
    );
  }
  if (!threads) {
    return <div className="ncore ncore-loading">{error ? <p className="ncore-error" role="alert">{error}</p> : <Spinner size={24} label="Загружаю" />}</div>;
  }
  const showList = !narrow || listOpen;
  const showChat = !narrow || !listOpen;
  return (
    <div className="ncore" data-narrow={narrow || undefined}>
      {showList && <ThreadList activeId={threadId} onSelect={select} onBack={leave} embedded={embedded} />}
      {showChat && <Conversation key={threadId || 'new'} threadId={threadId} onSelect={select} narrow={narrow} onList={() => setListOpen(true)} />}
    </div>
  );
}

// ── Список чатов ─────────────────────────────────────────────────────────────

function ThreadList({ activeId, onSelect, onBack, embedded }: { activeId: string | null; onSelect: (id: string | null) => void; onBack: () => void; embedded: boolean }) {
  const threads = useCore((s) => s.threads) ?? [];
  const archived = useCore((s) => s.archived);
  const [showArchive, setShowArchive] = useState(false);
  const [query, setQuery] = useState('');
  useEffect(() => { if (showArchive && !archived) void loadArchived(); }, [showArchive, archived]);
  const list = (showArchive ? archived ?? [] : threads).filter((t) => !query.trim() || t.title.toLowerCase().includes(query.trim().toLowerCase()));

  async function newChat() {
    try { onSelect((await createThread()).id); } catch (cause) { showToast(cause instanceof Error ? cause.message : 'Не удалось создать чат', 'error'); }
  }

  return (
    <aside className="ncore-list" aria-label="Чаты Ядра">
      <header className="ncore-list-head">
        {!embedded && <button type="button" className="nx-icon-btn ncore-back" onClick={onBack} aria-label="Назад в «Ещё»"><ChevronLeft size={20} /></button>}
        <span className="ncore-brand"><Atom size={20} aria-hidden="true" /> Ядро</span>
        <button type="button" className="nx-icon-btn" onClick={() => void newChat()} aria-label="Новый чат" title="Новый чат"><MessageSquarePlus size={18} /></button>
        {embedded && <button type="button" className="nx-icon-btn" onClick={onBack} aria-label="Закрыть Ядро" title="Закрыть"><X size={18} /></button>}
      </header>
      <label className="ncore-search">
        <Search size={14} aria-hidden="true" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти чат" aria-label="Найти чат по названию" />
      </label>
      <nav className="nx-segment ncore-tabs" aria-label="Какие чаты">
        <button type="button" aria-pressed={!showArchive} onClick={() => setShowArchive(false)}>Чаты</button>
        <button type="button" aria-pressed={showArchive} onClick={() => setShowArchive(true)}>Архив</button>
      </nav>
      <div className="ncore-threads nx-scroll-y">
        {showArchive && !archived && <div className="ncore-loading"><Spinner size={18} label="Загружаю" /></div>}
        {list.map((t) => (
          <button key={t.id} type="button" className="ncore-thread" aria-current={t.id === activeId || undefined} onClick={() => onSelect(t.id)}>
            <span className="ncore-thread-top">
              <b>{t.title}</b>
              {t.working ? <span className="ncore-thread-live" title="Агент отвечает" aria-label="Агент отвечает" /> : <time>{formatListTime(t.updatedAt)}</time>}
            </span>
            <span className="ncore-thread-sub">
              {t.lastText ? `${t.lastRole === 'user' ? 'Вы: ' : ''}${t.lastText}` : 'Пока без сообщений'}
            </span>
          </button>
        ))}
        {!list.length && (showArchive ? archived : true) && (
          <p className="ncore-list-empty">{query ? 'Ничего не нашлось' : showArchive ? 'В архиве пусто' : 'Чатов пока нет — начните новый'}</p>
        )}
      </div>
    </aside>
  );
}

// ── Переписка ────────────────────────────────────────────────────────────────

/** С чего начать — на пустом экране чата. Щелчок отправляет сразу. */
const STARTERS = [
  'Что у меня сегодня — встречи и задачи?',
  'Какие задачи горят на этой неделе?',
  'Разбери документ, который у меня открыт, и предложи правки',
  'Найди в «Файлах» последний прайс и перескажи коротко',
];

const HELP = [
  '«Ядро» — ваш агент в Шаре: документы, таблицы, задачи, календарь, файлы. Агента подключают в Настройки → Ядро.',
  'Агент видит, что у вас открыто, — плашки над полем ввода; лишнее зачеркните щелчком. Он запоминает, как вы работаете, и пишет себе навыки.',
  'Команды: /new — новый чат, /rename Название — переименовать, /archive — в архив, /compact — сжать длинный разговор, /help — эта подсказка.',
  'Ответ агента — правой кнопкой: переслать в чат, скопировать, ответить.',
  'Enter — отправить, Shift+Enter — новая строка, ↑ в пустом поле — прошлое сообщение. Файл можно перетащить в переписку или вставить из буфера.',
].join('\n');

function Conversation({ threadId, onSelect, narrow, onList }: { threadId: string | null; onSelect: (id: string | null) => void; narrow: boolean; onList: () => void }) {
  const catalog = useCore((s) => s.catalog);
  const thread = useCore((s) => [...(s.threads ?? []), ...(s.archived ?? [])].find((t) => t.id === threadId) ?? null);
  const log = useCore((s) => (threadId ? s.logs[threadId] : undefined));
  const messages = log?.messages ?? EMPTY;
  const [replyTo, setReplyTo] = useState<CoreMessage | null>(null);
  const [forwarding, setForwarding] = useState<CoreMessage | null>(null);
  const [showStats, setShowStats] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [farFromBottom, setFarFromBottom] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const atBottom = useRef(true);

  useEffect(() => { if (threadId) void loadMessages(threadId); }, [threadId]);
  // Неизвестный чат в адресе (удалён, чужой) — назад к списку.
  useEffect(() => {
    if (threadId && !thread && useCore.getState().threads && !useCore.getState().archived) void loadArchived();
  }, [threadId, thread]);

  // Окно ленты: на экране — последние сообщения, выше — дорисовываются по мере прокрутки (длинный разговор не тормозит).
  const [windowSize, setWindowSize] = useState(WINDOW);
  useEffect(() => { setWindowSize(WINDOW); }, [threadId]);
  const shown = messages.length > windowSize ? messages.slice(messages.length - windowSize) : messages;

  // Якорь прокрутки — как в чатах Шара. Внизу — держимся низа (ответ печатается, панель меняет ширину, догрузилась
  // картинка). Читаем выше — то сообщение, что было у верха окна, остаётся на том же месте при любой перестройке.
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const toBottom = useCallback(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; }, []);
  const restore = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    if (atBottom.current) { toBottom(); return; }
    const saved = anchor.current;
    const row = saved && el.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(saved.id)}"]`);
    if (saved && row) el.scrollTop = row.offsetTop - saved.offset;
  }, [toBottom]);
  const remember = () => {
    const el = scroller.current;
    if (!el) return;
    const rows = el.querySelectorAll<HTMLElement>('[data-msg-id]');
    for (const row of rows) {
      if (row.offsetTop + row.offsetHeight > el.scrollTop) { anchor.current = { id: row.dataset.msgId!, offset: row.offsetTop - el.scrollTop }; return; }
    }
  };

  useLayoutEffect(() => { restore(); }, [shown, restore]);
  // Высота содержимого (печать ответа, картинки, ширина панели) и самого окна ленты (поле ввода растёт) — без рывков.
  useEffect(() => {
    const el = scroller.current;
    const inner = el?.firstElementChild;
    if (!el || !inner) return undefined;
    const ro = new ResizeObserver(() => restore());
    ro.observe(inner);
    ro.observe(el);
    return () => ro.disconnect();
  }, [restore, threadId]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottom.current = gap < 80;
    setFarFromBottom(gap > 600);
    remember();
    if (el.scrollTop < 200) {
      if (shown.length < messages.length) setWindowSize((n) => n + WINDOW_STEP);
      else if (threadId && log?.hasMore && !log.loadingOlder) void loadOlder(threadId);
    }
  };

  const history = useMemo(() => messages.filter((m) => m.role === 'user' && m.body).map((m) => m.body).reverse().slice(0, 30), [messages]);

  async function ensureThread(): Promise<string | null> {
    if (threadId) return threadId;
    try {
      const created = await createThread();
      onSelect(created.id);
      return created.id;
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : 'Не удалось создать чат', 'error');
      return null;
    }
  }

  async function send(text: string, attachments: Array<{ name: string; key: string; size: number; type: string }>, options: SendOptions) {
    const id = await ensureThread();
    if (!id) return false;
    atBottom.current = true;
    const quoted = replyTo;
    setReplyTo(null);
    return sendMessage(id, {
      id: crypto.randomUUID().replace(/-/g, ''), body: text, replyTo: quoted?.id, attachments,
      effort: options.effort || undefined, model: options.model || undefined, context: options.context,
      forwarded: options.forwarded.length ? options.forwarded : undefined,
    }, {
      forwarded: options.forwarded.length ? options.forwarded : undefined,
      attachments: attachments.map((a) => ({ ...a, url: '' })),
      replyTo: quoted ? { id: quoted.id, actor: quoted.role === 'agent' ? quoted.actor : '', text: quoted.body.slice(0, 300) } : undefined,
    });
  }

  function systemNote(text: string) {
    if (!threadId) return;
    upsertMessage({ id: `local-${Date.now()}`, threadId, role: 'system', actor: '', body: text, props: {}, status: 'done', createdAt: new Date().toISOString() });
  }

  function onCommand(cmd: string, arg: string): boolean {
    const known = COMMANDS.some((c) => c.cmd === cmd);
    if (!known) return false;
    if (cmd === '/new') { void createThread().then((t) => onSelect(t.id)).catch(() => showToast('Не удалось создать чат', 'error')); return true; }
    if (cmd === '/help') { if (threadId) systemNote(HELP); else showToast(HELP, 'info'); return true; }
    if (cmd === '/rename') {
      if (!threadId) return true;
      if (arg) void patchThread(threadId, { title: arg }); else setRenaming(true);
      return true;
    }
    if (cmd === '/archive') { if (threadId) void patchThread(threadId, { archived: true }).then(() => onSelect(null)); return true; }
    return false; // /demo — сообщение на сервер
  }

  const handlers = useMemo<MessageHandlers>(() => ({
    reply: (m) => { setReplyTo(m); composer.current?.focus(); },
    answer: (m, value) => { atBottom.current = true; coreApi.answer(m.id, value).then(upsertMessage).catch((cause) => showToast(cause instanceof Error ? cause.message : 'Не получилось', 'error')); },
    cancel: (m) => { coreApi.cancel(m.id).then(upsertMessage).catch((cause) => showToast(cause instanceof Error ? cause.message : 'Не получилось', 'error')); },
    retry: (m) => retryMessage(m.id),
    forward: (m) => setForwarding(m),
    jump: (id) => {
      const row = scroller.current?.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(id)}"]`);
      if (!row) { showToast('Это сообщение выше — прокрутите историю', 'info'); return; }
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row.dataset.flash = '';
      window.setTimeout(() => { delete row.dataset.flash; }, 1400);
    },
  }), []);

  const contextLoad = thread?.lastWork?.context_tokens && thread.lastWork.context_window
    ? { tokens: thread.lastWork.context_tokens, share: thread.lastWork.context_tokens / thread.lastWork.context_window } : null;

  let lastDay = 0;
  return (
    <section
      className="ncore-chat"
      data-dropping={dropping || undefined}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false); }}
      onDrop={(e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); setDropping(false); composer.current?.addFiles([...e.dataTransfer.files]); }}
    >
      <header className="ncore-chat-head">
        {narrow && <button type="button" className="nx-icon-btn" onClick={onList} aria-label="Все чаты" title="Все чаты"><ChevronLeft size={20} /></button>}
        {renaming && thread ? (
          <input className="ncore-rename" autoFocus defaultValue={thread.title} maxLength={120} aria-label="Название чата"
            onBlur={(e) => { const v = e.currentTarget.value.trim(); setRenaming(false); if (v && v !== thread.title) void patchThread(thread.id, { title: v }); }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.currentTarget.value = thread.title; e.currentTarget.blur(); } }} />
        ) : (
          <button type="button" className="ncore-chat-title" onDoubleClick={() => thread && setRenaming(true)} title={thread ? 'Двойной щелчок — переименовать' : undefined}>
            <b>{thread?.title || 'Новый чат'}</b>
            {thread && <span>{thread.messages} {plural(thread.messages, ['сообщение', 'сообщения', 'сообщений'])}{thread.archived ? ' · в архиве' : ''}</span>}
          </button>
        )}
        <span className="ncore-chat-tools">
          {(() => {
            const shown = catalog?.agents.find((a) => a.id === (thread?.peer || '')) ?? catalog?.agents.find((a) => a.limits?.length);
            return shown ? <LimitBadges limits={shown.limits} agent={shown.name} /> : null;
          })()}
          {contextLoad && (
            <button type="button" className="ncore-context" data-heavy={contextLoad.share >= 0.6 || undefined} onClick={() => setShowStats((v) => !v)}
              title={`Контекст чата: ${formatTokens(contextLoad.tokens)} токенов — столько агент перечитывает на каждом шаге.${contextLoad.share >= 0.6 ? ' Для новой темы лучше начать новый чат.' : ''}`}>
              <i><i style={{ width: `${Math.min(100, Math.round(contextLoad.share * 100))}%` }} /></i>
              {formatTokens(contextLoad.tokens)}
            </button>
          )}
          {thread && (
            <button type="button" className="nx-icon-btn" aria-pressed={showStats} onClick={() => setShowStats((v) => !v)} aria-label="Статистика чата" title="Статистика чата">
              <BarChart3 size={16} />
            </button>
          )}
          {thread && <button type="button" className="nx-icon-btn" onClick={() => setRenaming(true)} aria-label="Переименовать чат" title="Переименовать"><Pencil size={16} /></button>}
          {thread && (
            <button type="button" className="nx-icon-btn" onClick={() => void patchThread(thread.id, { archived: !thread.archived }).then(() => { if (!thread.archived) onSelect(null); })}
              aria-label={thread.archived ? 'Вернуть из архива' : 'Убрать в архив'} title={thread.archived ? 'Вернуть из архива' : 'Убрать в архив'}>
              {thread.archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}
            </button>
          )}
        </span>
      </header>

      {showStats && <ChatStats thread={thread} messages={messages} />}
      <div className="ncore-log nx-scroll-y" ref={scroller} onScroll={onScroll} role="log" aria-label="Сообщения">
        <div className="ncore-log-inner">
          {log?.loadingOlder && <div className="ncore-older"><Spinner size={16} label="Загружаю историю" /></div>}
          {threadId && !log?.loaded && <div className="ncore-loading"><Spinner size={22} label="Загружаю" /></div>}
          {(!threadId || (log?.loaded && !messages.length)) && (
            <div className="ncore-empty">
              <span className="ncore-empty-mark" aria-hidden="true"><Atom size={34} strokeWidth={1.6} /></span>
              <h2>{threadId ? 'Новый чат' : 'Ядро'}</h2>
              {catalog?.agents.length ? (
                <>
                  <p>{catalog.agents.map((a) => a.name).join(', ')} {catalog.agents.length > 1 ? 'работают' : 'работает'} с вашими правами: документы, таблицы, задачи, календарь, файлы. Видит, что у вас открыто, — лишнее зачеркните над полем ввода.</p>
                  <div className="ncore-starters">
                    {STARTERS.map((s) => <button key={s} type="button" className="ncore-starter" onClick={() => composer.current?.sendText(s)}>{s}</button>)}
                  </div>
                </>
              ) : (
                <p>Подключите своего агента — Gemini по ключу Google или Claude и GPT вашей подпиской — в <a href={`${paths.settings}?section=core`}>Настройки → Ядро</a>. Пока сообщения сохраняются здесь.</p>
              )}
              {catalog?.demo && !catalog.agents.length && <p className="ncore-empty-hint">Чтобы посмотреть, как будет выглядеть ответ агента, отправьте <code>/demo</code>.</p>}
            </div>
          )}
          {shown.map((m, i) => {
            const day = dayKey(m.createdAt);
            const sep = day !== lastDay;
            lastDay = day;
            const quote = Boolean(m.props.replyTo && shown[i - 1]?.id !== m.props.replyTo.id);
            return (
              <div key={m.id}>
                {sep && <div className="ncore-day"><span>{formatDay(m.createdAt)}</span></div>}
                <MessageItem message={m} quote={quote} h={handlers} />
              </div>
            );
          })}
        </div>
      </div>
      {farFromBottom && (
        <button type="button" className="ncore-to-bottom" onClick={() => { atBottom.current = true; const el = scroller.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); }} aria-label="К последним сообщениям">
          <ArrowDown size={18} />
        </button>
      )}
      {dropping && <div className="ncore-drop" aria-hidden="true">Отпустите, чтобы приложить файлы</div>}
      <Composer ref={composer} threadId={threadId} catalog={catalog} replyTo={replyTo} onCancelReply={() => setReplyTo(null)}
        history={history} peer={thread?.peer || ''} onSend={send} onCommand={onCommand} />
      {forwarding && <ForwardSheet text={forwarding.body} onClose={() => setForwarding(null)} />}
    </section>
  );
}
