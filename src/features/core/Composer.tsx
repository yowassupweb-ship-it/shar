import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, CalendarDays, CheckSquare, CornerDownRight, FileSpreadsheet, FileText, Folder, Forward, LayoutGrid, Mail, MessageCircle, MonitorUp,
  Paperclip, Plug, Plus, Presentation, Slash, StickyNote, User, X } from 'lucide-react';
import { clearAgentForward, useAgentBridge, type AgentForward } from '@/shared/core/agentBridge';
import { paths } from '@/shared/navigation/routes';
import { Select } from '@/shared/ui/Select';
import type { CoreAttachment, CoreCatalog, CoreContextItem, CoreMessage } from './api';
import { formatBytes } from './parts';
import { useWhere, type WhereItem } from './whereAmI';

export interface ComposerCommand { cmd: string; hint: string; admin?: boolean }

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

/** Знак агента — тот же, что в Настройки → Ядро: буква, без логотипов. */
const AGENT_MARK: Record<string, string> = { gemini: 'G', claude: 'C', codex: 'O' };

export interface SendOptions { effort: string; model: string; context: CoreContextItem[]; forwarded: AgentForward[] }

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
}>(function Composer({ threadId, catalog, replyTo, onCancelReply, history, peer, onSend, onCommand }, ref) {
  const [text, setText] = useState(() => readDraft(threadId));
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [effort, setEffort] = useState('');
  const [picked, setPicked] = useState('');
  const where = useWhere();
  const forwarded = useAgentBridge((s) => s.pending);
  const [struck, setStruck] = useState<Set<string>>(() => new Set());
  const agents = catalog?.agents ?? [];
  // Выбор человека → агент чата → первый подключённый. «claude:opus» — агент и модель.
  const optionOf = (a: (typeof agents)[number]) => (a.models.length > 1 ? `${a.id}:${a.model || a.models[0].id}` : a.id);
  const base = agents.find((a) => a.id === peer) ?? agents[0];
  const agentValue = picked || (base ? optionOf(base) : '');
  const agent = agents.find((a) => a.id === agentValue.split(':')[0]);
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
  const canSend = (text.trim() || ready.length || forwarded.length) && !uploading;

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
    const context = where.filter((w) => !struck.has(w.key)).map(({ kind, title, id, url }) => ({ kind, title, id, url }));
    const sentForward = forwarded;
    clearAgentForward();
    // Не ушло — пузырь сам покажет «не отправлено — повторить».
    await onSend(body, files, { effort, model: agentValue, context, forwarded: sentForward });
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
                    onClick={() => setPicked(optionOf(a))} title={a.online ? `Ответит ${a.name}` : `${a.name}: нода не на связи — ответ не придёт`}>
                    <span className="ncore-agent-mark" aria-hidden="true">{AGENT_MARK[a.id] || a.name[0]}</span>
                    <span className="ncore-agent-name">{a.name}</span>
                  </button>
                ))}
                <a className="ncore-tool" href={`${paths.settings}?section=core`} title="Подключить ещё агента" aria-label="Подключить ещё агента"><Plus size={15} /></a>
              </span>
              {agent && agent.models.length > 1 && (
                <Select className="ncore-picker" label={`Модель ${agent.name}`} value={agentValue} onChange={setPicked}
                  groups={[{ options: agent.models.map((m) => ({ value: `${agent.id}:${m.id}`, label: m.label })) }]} />
              )}
            </>
          )}
          {!!catalog?.efforts.length && (
            <Select className="ncore-picker" label="Как долго думать перед ответом" value={effort} onChange={setEffort} placeholder="Обычно"
              groups={[{ options: [{ value: '', label: 'Обычно' }, ...catalog.efforts.filter((e) => e.id !== 'medium').map((e) => ({ value: e.id, label: e.label }))] }]} />
          )}
          <button type="submit" className="ncore-send" disabled={!canSend} aria-label="Отправить" title={uploading ? 'Дождитесь загрузки файлов' : 'Отправить (Enter) · Shift+Enter — новая строка · / — команды'}>
            <ArrowUp size={16} strokeWidth={2.4} />
          </button>
        </div>
      </form>
    </div>
  );
});
