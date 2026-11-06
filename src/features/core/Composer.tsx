import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, CalendarDays, Check, Dumbbell, MoreHorizontal, ShieldCheck, CheckSquare, CornerDownRight, FileSpreadsheet, FileText, Folder, Forward, LayoutGrid, Mail, MessageCircle, MonitorUp,
  ListChecks, Paperclip, Plug, Presentation, Slash, StickyNote, User, X } from 'lucide-react';
import { CoreMini } from '@/shared/ui/CoreIcon';
import { clearAgentAttached, clearAgentForward, detachFromAgent, useAgentBridge, type AgentForward } from '@/shared/core/agentBridge';
import { navigate } from '@/shared/navigation/navigate';
import { Menu, MenuItem, type MenuAnchor } from '@/shared/ui/overlay';
import { paths } from '@/shared/navigation/routes';
import { Select, type SelectGroup } from '@/shared/ui/Select';
import { Sheet } from '@/shared/ui/overlay';
import { coreApi, type CoreAttachment, type CoreCatalog, type CoreContextItem, type CoreMessage } from './api';
import { formatBytes } from './parts';
import { BrandMark } from './brands';
import { useCore } from './store';
import { useWhere, type WhereItem } from './whereAmI';

export interface ComposerCommand { cmd: string; hint: string; admin?: boolean }

const CUSTOM_MODELS_KEY = 'nx:core:custom-models';
/** Агент (и модель) по умолчанию для новых чатов: «claude» или «claude:claude-opus-4-5». Правый клик по кнопке агента. */
const DEFAULT_AGENT_KEY = 'nx:core:default-agent';
const CUSTOM = '__custom';
/** Допустимое имя модели — то же правило, что у сервера (MessageBody.model). */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,58}$/;

/**
 * Модели агента для выбора. Каталог провайдера — одним списком, если он один; у GPT и Claude с несколькими поколениями —
 * группами по поколению (новые сверху: у GPT это модели режима «Работа» вроде 6.1 Sol и 6 Astra, ниже — прежние из «Чата»).
 * В конце — свои имена и «Другая модель…».
 */
function modelGroups(agent: { id: string; how?: string; models: Array<{ id: string; label: string }> }, own: string[]): SelectGroup[] {
  const option = (id: string, label: string) => ({ value: `${agent.id}:${id}`, label });
  const known = new Set(agent.models.map((m) => m.id));
  const generation = (id: string) => {
    const found = id.match(/(?:^|-)(?:gpt-)?(\d+)(?:[.-]\d+)?/i);
    return found ? Number(found[1]) : 0;
  };
  const gens = Array.from(new Set(agent.models.map((m) => generation(m.id))));
  const groups: SelectGroup[] = [];
  if (agent.id === 'codex' && gens.length > 1 && gens.every((g) => g > 0)) {
    for (const g of gens.sort((a, b) => b - a)) {
      groups.push({ label: `GPT-${g}${g === gens[0] ? ' · режим «Работа»' : ' · режим «Чат»'}`, options: agent.models.filter((m) => generation(m.id) === g).map((m) => option(m.id, m.label)) });
    }
  } else groups.push({ options: agent.models.map((m) => option(m.id, m.label)) });
  const mine = own.filter((id) => !known.has(id));
  if (mine.length) groups.push({ label: 'Свои', options: mine.map((id) => option(id, id)) });
  if (agent.how === 'login') groups.push({ options: [{ value: `${agent.id}:${CUSTOM}`, label: 'Другая модель…' }] });
  return groups;
}

export const COMMANDS: ComposerCommand[] = [
  { cmd: '/new', hint: 'Новый чат' },
  { cmd: '/rename', hint: 'Переименовать чат: /rename Название' },
  { cmd: '/archive', hint: 'Убрать чат в архив' },
  { cmd: '/compact', hint: 'Сжать контекст чата: /compact что важно сохранить' },
  { cmd: '/help', hint: 'Что умеет «Ядро»' },
  { cmd: '/demo', hint: 'Показать ответ агента (демо)', admin: true },
  { cmd: '/demo fail', hint: 'Демо: ответ не получился', admin: true },
  { cmd: '/demo limit', hint: 'Демо: упёрлись в лимит подписки', admin: true },
];

interface Draft { id: string; file: File; name: string; size: number; type: string; loaded: number; key?: string; error?: string }

export interface ComposerHandle {
  addFiles: (files: File[]) => void;
  focus: () => void;
  /** Отправить готовый текст (подсказка на пустом экране) — с тем же агентом и «где я», что выбраны в поле. */
  sendText: (text: string) => void;
}


export interface SendOptions { effort: string; plan?: boolean; model: string; context: CoreContextItem[]; forwarded: AgentForward[] }

const WHERE_ICON: Record<string, typeof FileText> = {
  document: FileText, note: StickyNote, table: FileSpreadsheet, presentation: Presentation, task: CheckSquare, chat: MessageCircle,
  person: User, file: Folder, mail: Mail, event: CalendarDays, section: LayoutGrid,
};

/** Пересланное из чатов: агент увидит только это — авторы, время, текст. Убрать — крестик. */
function ForwardCard({ items }: { items: AgentForward[] }) {
  const authors = [...new Set(items.map((i) => i.author))];
  return (
    <div className="ncore-forward" role="group" aria-label="Пересланные сообщения">
      <span className="ncore-forward-icon" aria-hidden="true"><Forward size={14} /></span>
      <span className="ncore-forward-body">
        <b>{items.length > 1 ? `Переслано сообщений: ${items.length}` : 'Пересланное сообщение'}</b>
        <span>{authors.slice(0, 3).join(', ')}{authors.length > 3 ? ` и ещё ${authors.length - 3}` : ''} — {items[items.length - 1].text || items[items.length - 1].files.join(', ')}</span>
      </span>
      <button type="button" className="nx-icon-btn" onClick={clearAgentForward} aria-label="Не пересылать" title="Не пересылать"><X size={14} /></button>
    </div>
  );
}

/** Плашки «где я»: что открыто у человека. Щелчок — зачеркнуть (агенту не уйдёт), ещё раз — вернуть. */
function WhereChips({ items, struck, onToggle }: { items: WhereItem[]; struck: Set<string>; onToggle: (key: string) => void }) {
  if (!items.length) return null;
  return (
    <div className="ncore-where" aria-label="Что агент увидит из открытого у вас">
      <span className="ncore-where-label" title="Агент знает, что у вас открыто. Лишнее — зачеркните щелчком."><MonitorUp size={12} aria-hidden="true" /> Видит</span>
      {items.map((item) => {
        const Icon = WHERE_ICON[item.kind] || LayoutGrid;
        const off = struck.has(item.key);
        return (
          <button key={item.key} type="button" className="ncore-where-chip" aria-pressed={!off} data-off={off || undefined} data-here={item.here || undefined}
            onClick={() => onToggle(item.key)} title={off ? 'Не уйдёт агенту — щёлкните, чтобы вернуть' : `${item.here ? 'Это окно. ' : ''}Щёлкните, чтобы агент этого не видел`}>
            <Icon size={12} aria-hidden="true" /><span>{item.title}</span>
          </button>
        );
      })}
    </div>
  );
}

const draftKey = (threadId: string | null) => `nx:core:draft:${threadId || 'new'}`;
const readDraft = (threadId: string | null) => { try { return localStorage.getItem(draftKey(threadId)) || ''; } catch { return ''; } };
const writeDraft = (threadId: string | null, text: string) => {
  try { if (text) localStorage.setItem(draftKey(threadId), text); else localStorage.removeItem(draftKey(threadId)); } catch { /* приватный режим */ }
};

/**
 * Поле ввода «Ядра» — как в MBOX, но в стиле Шара: пилюля с кнопкой отправки внутри. Enter — отправить,
 * Shift+Enter — новая строка, ↑ в пустом поле — прошлое сообщение, «/» — команды. Файлы: скрепка,
 * вставка из буфера, перетаскивание (на всю переписку — через addFiles). Черновик помнится по чату.
 */
export const Composer = forwardRef<ComposerHandle, {
  threadId: string | null;
  catalog: CoreCatalog | null;
  replyTo: CoreMessage | null;
  onCancelReply: () => void;
  history: string[];
  /** Агент этого чата (кто отвечал раньше): его и предлагаем, пока человек не выберет другого. */
  peer: string;
  onSend: (text: string, attachments: Array<Pick<CoreAttachment, 'name' | 'key' | 'size' | 'type'>>, options: SendOptions) => Promise<boolean>;
  onCommand: (cmd: string, arg: string) => boolean;
  /** Выбранные агент и модель («claude:claude-opus-4-5») — шапка чата показывает использование именно этой модели. */
  onSelect?: (value: string) => void;
}>(function Composer({ threadId, catalog, replyTo, onCancelReply, history, peer, onSend, onCommand, onSelect }, ref) {
  const [text, setText] = useState(() => readDraft(threadId));
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [effort, setEffort] = useState('');
  const [plan, setPlan] = useState(false);
  const [picked, setPicked] = useState('');
  // Модели, которых нет в каталоге аккаунта (например, из режима «Работа» ChatGPT, если Codex их не отдал): имя вводит человек,
  // список помнится на этом устройстве. Недоступную аккаунту модель провайдер отклонит — ошибка придёт в ответ.
  const [customOpen, setCustomOpen] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customs, setCustoms] = useState<Record<string, string[]>>(() => {
    try { return JSON.parse(localStorage.getItem(CUSTOM_MODELS_KEY) || '{}') as Record<string, string[]>; } catch { return {}; }
  });
  const [defaultAgent, setDefaultAgent] = useState(() => { try { return localStorage.getItem(DEFAULT_AGENT_KEY) || ''; } catch { return ''; } });
  const [agentMenu, setAgentMenu] = useState<{ anchor: MenuAnchor; id: string } | null>(null);
  const where = useWhere();
  const attached = useAgentBridge((s) => s.attached);
  const [more, setMore] = useState<MenuAnchor | null>(null);
  const effortOptions = [{ value: '', label: 'Обычно' }, ...(catalog?.efforts || []).filter((e) => e.id !== 'medium').map((e) => ({ value: e.id, label: e.label }))];
  const setMode = (mode: string) => {
    useCore.setState((st) => (st.catalog ? { catalog: { ...st.catalog, mode } } : st));
    void coreApi.setMode(mode).catch(() => undefined);
  };
  const forwarded = useAgentBridge((s) => s.pending);
  const [struck, setStruck] = useState<Set<string>>(() => new Set());
  const agents = catalog?.agents ?? [];
  // Выбор человека → агент чата → первый подключённый. «claude:opus» — агент и модель.
  const optionOf = (a: (typeof agents)[number]) => (a.models.length > 1 ? `${a.id}:${a.model || a.models[0].id}` : a.id);
  // Агент чата (кто отвечал) → агент по умолчанию (правый клик по кнопке агента) → первый подключённый.
  const peerAgent = agents.find((a) => a.id === peer);
  const def = defaultAgent && agents.some((a) => a.id === defaultAgent.split(':')[0]) ? defaultAgent : '';
  const base = peerAgent ?? agents.find((a) => a.id === def.split(':')[0]) ?? agents[0];
  const agentValue = picked || (peerAgent ? optionOf(peerAgent) : def || (base ? optionOf(base) : ''));
  const toggleDefault = (id: string) => {
    const a = agents.find((x) => x.id === id);
    if (!a) return;
    const isDefault = def.split(':')[0] === id;
    // Выбрана модель этого агента — запоминаем её вместе с агентом, иначе — модель агента по умолчанию.
    const next = isDefault ? '' : (agentValue.split(':')[0] === id ? agentValue : optionOf(a));
    setDefaultAgent(next);
    try { if (next) localStorage.setItem(DEFAULT_AGENT_KEY, next); else localStorage.removeItem(DEFAULT_AGENT_KEY); } catch { /* приватное окно — не запомним */ }
  };
  const agent = agents.find((a) => a.id === agentValue.split(':')[0]);
  useEffect(() => { onSelect?.(agentValue); }, [agentValue]); // eslint-disable-line react-hooks/exhaustive-deps
  const [historyPos, setHistoryPos] = useState(-1);
  const [highlight, setHighlight] = useState(0);
  /** Esc закрыл подсказки команд для этого текста — пока его не изменят, они не всплывают. */
  const [dismissed, setDismissed] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Другой чат — свой черновик.
  useEffect(() => { setText(readDraft(threadId)); setHistoryPos(-1); setDrafts([]); }, [threadId]);
  useEffect(() => { writeDraft(threadId, text); }, [threadId, text]);
  // Высота по содержимому (до 200px — дальше прокрутка внутри поля).
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(200, el.scrollHeight)}px`;
  }, [text]);
  useEffect(() => { if (replyTo) area.current?.focus(); }, [replyTo]);

  async function upload(draft: Draft) {
    const { uploadFileWithProgress } = await import('@/shared/api/uploadFile');
    try {
      const result = await uploadFileWithProgress(draft.file, (pct) => setDrafts((cur) => cur.map((d) => (d.id === draft.id ? { ...d, loaded: pct } : d))));
      setDrafts((cur) => cur.map((d) => (d.id === draft.id ? { ...d, loaded: 100, key: result.key } : d)));
    } catch (cause) {
      setDrafts((cur) => cur.map((d) => (d.id === draft.id ? { ...d, error: cause instanceof Error ? cause.message : 'не загрузилось' } : d)));
    }
  }

  function addFiles(files: File[]) {
    const room = Math.max(0, 10 - drafts.length);
    const next = files.slice(0, room).map((file): Draft => ({ id: crypto.randomUUID(), file, name: file.name, size: file.size, type: file.type, loaded: 0 }));
    if (!next.length) return;
    setDrafts((cur) => [...cur, ...next]);
    next.forEach((d) => void upload(d));
  }

  useImperativeHandle(ref, () => ({ addFiles, focus: () => area.current?.focus(), sendText: (value: string) => { void submit(value); } }));

  const slash = text.startsWith('/') && !text.includes('\n') ? text.toLowerCase() : '';
  // Набрана ровно команда — Enter её выполняет, а не подставляет соседнюю («/demo» ≠ «/demo fail»).
  const exact = COMMANDS.some((c) => c.cmd === slash.trim());
  const suggestions = useMemo(
    () => (slash && slash !== dismissed ? COMMANDS.filter((c) => (!c.admin || catalog?.demo) && c.cmd.startsWith(slash.split(' ')[0]) && c.cmd !== slash.trim()) : []),
    [slash, dismissed, catalog?.demo],
  );
  useEffect(() => { setHighlight(0); }, [slash]);

  const uploading = drafts.some((d) => !d.key && !d.error);
  const ready = drafts.filter((d) => d.key);
  const canSend = (text.trim() || ready.length || forwarded.length || attached.length) && !uploading;

  async function submit(override?: string) {
    const body = (override ?? text).trim();
    if (override === undefined ? !canSend : !body) return;
    // Команды чата выполняет сам интерфейс; /demo и неизвестные уходят на сервер как сообщение.
    if (body.startsWith('/')) {
      const [cmd, ...rest] = body.split(' ');
      if (onCommand(cmd.toLowerCase(), rest.join(' ').trim())) { setText(''); return; }
    }
    const files = ready.map((d) => ({ name: d.name, key: d.key!, size: d.size, type: d.type }));
    if (override === undefined) setText('');
    setDrafts((cur) => cur.filter((d) => !d.key));
    setHistoryPos(-1);
    const context = [
      ...attached.map(({ kind, title, id, url }) => ({ kind, title, id, url })),
      ...where.filter((w) => !struck.has(w.key) && !attached.some((a) => a.url === w.url)).map(({ kind, title, id, url }) => ({ kind, title, id, url })),
    ];
    clearAgentAttached();
    const sentForward = forwarded;
    clearAgentForward();
    // Не ушло — пузырь сам покажет «не отправлено — повторить».
    const planned = plan && agent?.id === 'kimi';
    setPlan(false); // план-режим — на один ответ: после плана человек сам решает, выполнять ли
    await onSend(body, files, { effort, plan: planned, model: agentValue, context, forwarded: sentForward });
  }

  function accept(cmd: string) {
    setText(cmd.endsWith('rename') ? `${cmd} ` : cmd);
    area.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (suggestions.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((i) => (i + 1) % suggestions.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((i) => (i - 1 + suggestions.length) % suggestions.length); return; }
      if (e.key === 'Escape') { e.preventDefault(); setDismissed(slash); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !exact && suggestions[highlight])) {
        e.preventDefault();
        accept(suggestions[highlight].cmd);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); return; }
    if (e.key === 'Escape' && replyTo) { e.preventDefault(); onCancelReply(); return; }
    // ↑ в пустом поле (или листая историю) — прошлые сообщения этого чата, ↓ — обратно.
    if (e.key === 'ArrowUp' && history.length && (!text || historyPos >= 0)) {
      e.preventDefault();
      const next = Math.min(history.length - 1, historyPos + 1);
      setHistoryPos(next);
      setText(history[next]);
      return;
    }
    if (e.key === 'ArrowDown' && historyPos >= 0) {
      e.preventDefault();
      const next = historyPos - 1;
      setHistoryPos(next);
      setText(next >= 0 ? history[next] : '');
    }
  }

  const noAgents = !agents.length;
  const toggleWhere = (key: string) => setStruck((cur) => { const next = new Set(cur); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  return (
    <div className="ncore-composer">
      {attached.length > 0 && (
        <div className="ncore-where" aria-label="Отправлено агенту">
          <span className="ncore-where-label"><CoreMini size={12} aria-hidden="true" /> Агенту</span>
          {attached.map((a) => (
            <span key={a.url} className="ncore-where-chip" data-pinned="">
              <span>{a.title}</span>
              <button type="button" onClick={() => detachFromAgent(a.url)} aria-label={`Не отправлять «${a.title}»`}><X size={11} /></button>
            </span>
          ))}
        </div>
      )}
      <WhereChips items={where} struck={struck} onToggle={toggleWhere} />
      {forwarded.length > 0 && <ForwardCard items={forwarded} />}
      {suggestions.length > 0 && (
        <div className="ncore-suggest" role="listbox" aria-label="Команды">
          {suggestions.map((s, i) => (
            <button key={s.cmd} type="button" role="option" aria-selected={i === highlight} data-active={i === highlight || undefined}
              onMouseDown={(e) => { e.preventDefault(); accept(s.cmd); }}>
              <Slash size={12} aria-hidden="true" /><b>{s.cmd.slice(1)}</b><em>{s.hint}</em>
            </button>
          ))}
        </div>
      )}
      {/* Одна рамка: что прикладываем, текст и панель — скрепка, кто отвечает, модель, усилие, отправка. */}
      <form className="ncore-box" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {replyTo && (
          <div className="ncore-reply-bar">
            <CornerDownRight size={13} aria-hidden="true" />
            <span>Ответ <b>{replyTo.role === 'agent' ? replyTo.actor || 'агенту' : 'себе'}</b>: {replyTo.body.slice(0, 180)}</span>
            <button type="button" className="nx-icon-btn" onClick={onCancelReply} aria-label="Отменить ответ" title="Отменить ответ (Esc)"><X size={14} /></button>
          </div>
        )}
        {drafts.length > 0 && (
          <div className="ncore-drafts">
            {drafts.map((d) => (
              <span key={d.id} className="ncore-draft" data-error={d.error ? '' : undefined} data-done={d.key ? '' : undefined} title={d.error || d.name}>
                <i style={{ width: `${d.key ? 100 : d.loaded}%` }} aria-hidden="true" />
                <Paperclip size={12} aria-hidden="true" />
                <span className="ncore-draft-name">{d.name}</span>
                <em>{d.error ? 'не загрузилось' : d.key ? formatBytes(d.size) : `${d.loaded}%`}</em>
                <button type="button" onClick={() => setDrafts((cur) => cur.filter((x) => x.id !== d.id))} aria-label={`Убрать ${d.name}`}><X size={12} /></button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={area}
          className="ncore-input"
          value={text}
          rows={1}
          placeholder={noAgents ? 'Сообщение сохранится в чате — агент ещё не подключён' : `Спросите ${agent?.name || 'агента'}…`}
          aria-label="Сообщение"
          spellCheck
          onChange={(e) => { setText(e.target.value); if (historyPos >= 0) setHistoryPos(-1); }}
          onKeyDown={onKeyDown}
          onPaste={(e) => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); addFiles(files); } }}
        />
        <div className="ncore-bar">
          <button type="button" className="ncore-tool" onClick={() => fileInput.current?.click()} aria-label="Приложить файл" title="Приложить файл — или вставьте из буфера, перетащите в переписку">
            <Paperclip size={16} />
          </button>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
          {noAgents ? (
            <a className="ncore-connect" href={`${paths.settings}?section=core`} title="Gemini — по ключу Google, Claude и GPT — вашей подпиской">
              <Plug size={13} aria-hidden="true" /> Подключить агента
            </a>
          ) : (
            <>
              {/* Кто отвечает — видно и переключается одним щелчком; модель — рядом, у выбранного. */}
              <span className="ncore-agents" role="radiogroup" aria-label="Кто отвечает">
                {agents.map((a) => (
                  <button key={a.id} type="button" role="radio" aria-checked={a.id === agent?.id} className="ncore-agent" data-offline={!a.online || undefined}
                    onContextMenu={(e) => { e.preventDefault(); setAgentMenu({ anchor: { x: e.clientX, y: e.clientY }, id: a.id }); }}
                    onClick={() => setPicked(optionOf(a))} title={a.online ? `Ответит ${a.name}` : `${a.name}: нода не на связи — ответ не придёт`}>
                    <BrandMark id={a.id} size={14} className="ncore-agent-logo" />
                    <span className="ncore-agent-name">{a.name}</span>
                  </button>
                ))}
              </span>
              {agent && (agent.models.length > 1 || agent.how === 'login') && (
                <Select className="ncore-picker" label={`Модель ${agent.name}`} value={agentValue}
                  onChange={(v) => { if (v === `${agent.id}:${CUSTOM}`) { setCustomName(''); setCustomOpen(true); } else setPicked(v); }}
                  groups={modelGroups(agent, customs[agent.id] ?? [])} />
              )}
            </>
          )}
          {agent?.id === 'kimi' && (
            <button type="button" className="ncore-tool ncore-plan" aria-pressed={plan} onClick={() => setPlan((v) => !v)}
              title="План-режим: Kimi только изучит задачу и предложит план — выполнять или нет, решаете вы">
              <ListChecks size={14} aria-hidden="true" /><span>План</span>
            </button>
          )}
          {/* Широко — нагрузка и режим разрешений на панели; узко — в «⋯» (контейнерный запрос в core.css). */}
          {!!catalog?.efforts.length && (
            <span className="ncore-effort ncore-wide" title="Нагрузка: как долго агент думает перед ответом">
              <Dumbbell size={14} aria-hidden="true" />
              <Select className="ncore-picker" label="Нагрузка: как долго думать перед ответом" value={effort} onChange={setEffort} placeholder="Обычно"
                groups={[{ options: effortOptions }]} />
            </span>
          )}
          {!noAgents && !!catalog?.modes?.length && (
            <span className="ncore-effort ncore-wide" title="Режим разрешений: что агент делает сам, а что — только с вашего «Разрешить»">
              <ShieldCheck size={14} aria-hidden="true" />
              <Select className="ncore-picker" label="Режим разрешений" value={catalog.mode || 'careful'} onChange={setMode}
                groups={[{ options: catalog.modes.map((m) => ({ value: m.id, label: m.label })) }]} />
            </span>
          )}
          <button type="button" className="ncore-tool ncore-more" aria-label="Ещё настройки ответа" title="Нагрузка, разрешения, подключить агента"
            onClick={(e) => setMore(more ? null : { element: e.currentTarget, align: 'end', side: 'above' })}>
            <MoreHorizontal size={16} />
          </button>
          {more && (
            <Menu anchor={more} label="Настройки ответа" onClose={() => setMore(null)} compact>
              <div className="nx-menu-label ncore-menu-label" role="presentation"><Dumbbell size={12} aria-hidden="true" />Нагрузка</div>
              {effortOptions.map((o) => (
                <MenuItem key={o.value || 'normal'} icon={effort === o.value ? <Check size={15} /> : <span className="ncore-menu-gap" />} onSelect={() => { setEffort(o.value); setMore(null); }}>{o.label}</MenuItem>
              ))}
              {!noAgents && !!catalog?.modes?.length && (<>
                <div className="nx-menu-label ncore-menu-label" role="presentation"><ShieldCheck size={12} aria-hidden="true" />Разрешения</div>
                {catalog.modes.map((m) => (
                  <MenuItem key={m.id} icon={(catalog.mode || 'careful') === m.id ? <Check size={15} /> : <span className="ncore-menu-gap" />} onSelect={() => { setMode(m.id); setMore(null); }}>{m.label}</MenuItem>
                ))}
              </>)}
              <div className="nx-menu-sep" />
              <MenuItem icon={<Plug size={15} />} onSelect={() => { setMore(null); navigate(`${paths.settings}?section=core`); }}>Подключить агента</MenuItem>
            </Menu>
          )}
          <button type="submit" className="ncore-send" disabled={!canSend} aria-label="Отправить" title={uploading ? 'Дождитесь загрузки файлов' : 'Отправить (Enter) · Shift+Enter — новая строка · / — команды'}>
            <ArrowUp size={16} strokeWidth={2.4} />
          </button>
        </div>
      </form>
      {agentMenu && (
        <Menu anchor={agentMenu.anchor} label="Агент" onClose={() => setAgentMenu(null)} compact>
          <MenuItem icon={def.split(':')[0] === agentMenu.id ? <Check size={15} /> : <span className="ncore-menu-gap" />}
            onSelect={() => { toggleDefault(agentMenu.id); setAgentMenu(null); }}>По умолчанию</MenuItem>
        </Menu>
      )}
      {customOpen && agent && (
        <Sheet title={`Другая модель ${agent.name}`} onClose={() => setCustomOpen(false)}
          footer={(<>
            <button type="button" className="nx-ghost" onClick={() => setCustomOpen(false)}>Отмена</button>
            <button type="button" className="nx-primary" disabled={!MODEL_NAME.test(customName.trim())} onClick={() => {
              const name = customName.trim();
              const next = { ...customs, [agent.id]: [name, ...(customs[agent.id] ?? []).filter((x) => x !== name)].slice(0, 6) };
              setCustoms(next);
              try { localStorage.setItem(CUSTOM_MODELS_KEY, JSON.stringify(next)); } catch { /* приватное окно — не запомним */ }
              setPicked(`${agent.id}:${name}`);
              setCustomOpen(false);
            }}>Выбрать</button>
          </>)}>
          <form className="ncore-custom" onSubmit={(e) => { e.preventDefault(); (e.currentTarget.querySelector('.nx-primary') as HTMLButtonElement | null)?.click(); }}>
            <p className="nx-note">
              Если нужной модели нет в списке — например, из режима «Работа» ChatGPT (GPT-6.1 Sol, GPT-6 Astra) — впишите её имя так, как его знает
              {agent.id === 'codex' ? ' Codex (`codex debug models`)' : ' провайдер'}. Недоступную вашему аккаунту модель провайдер отклонит, и ответ придёт с ошибкой.
            </p>
            <input className="nx-field" value={customName} autoFocus maxLength={58} placeholder="например, gpt-6.1-sol" aria-label="Имя модели"
              onChange={(e) => setCustomName(e.target.value)} />
          </form>
        </Sheet>
      )}
    </div>
  );
});
