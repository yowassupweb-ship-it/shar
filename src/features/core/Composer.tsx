import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, CornerDownRight, Paperclip, Slash, X } from 'lucide-react';
import { Select } from '@/shared/ui/Select';
import type { CoreAttachment, CoreCatalog, CoreMessage } from './api';
import { formatBytes } from './parts';

export interface ComposerCommand { cmd: string; hint: string; admin?: boolean }

export const COMMANDS: ComposerCommand[] = [
  { cmd: '/new', hint: 'Новый чат' },
  { cmd: '/rename', hint: 'Переименовать чат: /rename Название' },
  { cmd: '/archive', hint: 'Убрать чат в архив' },
  { cmd: '/help', hint: 'Что умеет «Ядро»' },
  { cmd: '/demo', hint: 'Показать ответ агента (демо)', admin: true },
  { cmd: '/demo fail', hint: 'Демо: ответ не получился', admin: true },
  { cmd: '/demo limit', hint: 'Демо: упёрлись в лимит подписки', admin: true },
];

interface Draft { id: string; file: File; name: string; size: number; type: string; loaded: number; key?: string; error?: string }

export interface ComposerHandle { addFiles: (files: File[]) => void; focus: () => void }

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
  onSend: (text: string, attachments: Array<Pick<CoreAttachment, 'name' | 'key' | 'size' | 'type'>>, effort: string) => Promise<boolean>;
  onCommand: (cmd: string, arg: string) => boolean;
}>(function Composer({ threadId, catalog, replyTo, onCancelReply, history, onSend, onCommand }, ref) {
  const [text, setText] = useState(() => readDraft(threadId));
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [effort, setEffort] = useState('');
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

  useImperativeHandle(ref, () => ({ addFiles, focus: () => area.current?.focus() }));

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
  const canSend = (text.trim() || ready.length) && !uploading;

  async function submit() {
    const body = text.trim();
    if (!canSend) return;
    // Команды чата выполняет сам интерфейс; /demo и неизвестные уходят на сервер как сообщение.
    if (body.startsWith('/')) {
      const [cmd, ...rest] = body.split(' ');
      if (onCommand(cmd.toLowerCase(), rest.join(' ').trim())) { setText(''); return; }
    }
    const files = ready.map((d) => ({ name: d.name, key: d.key!, size: d.size, type: d.type }));
    setText('');
    setDrafts((cur) => cur.filter((d) => !d.key));
    setHistoryPos(-1);
    // Не ушло — пузырь сам покажет «не отправлено — повторить».
    await onSend(body, files, effort);
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

  const noAgents = !catalog?.agents.length;
  return (
    <div className="ncore-composer">
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
      <form className="ncore-field" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <button type="button" className="ncore-attach" onClick={() => fileInput.current?.click()} aria-label="Приложить файл" title="Приложить файл — или вставьте из буфера, перетащите в переписку">
          <Paperclip size={17} />
        </button>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
        <textarea
          ref={area}
          className="ncore-input"
          value={text}
          rows={1}
          placeholder="Сообщение для Ядра…"
          aria-label="Сообщение"
          spellCheck
          onChange={(e) => { setText(e.target.value); if (historyPos >= 0) setHistoryPos(-1); }}
          onKeyDown={onKeyDown}
          onPaste={(e) => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); addFiles(files); } }}
        />
        <button type="submit" className="ncore-send" disabled={!canSend} aria-label="Отправить" title={uploading ? 'Дождитесь загрузки файлов' : 'Отправить (Enter)'}>
          <ArrowUp size={16} strokeWidth={2.4} />
        </button>
      </form>
      <div className="ncore-under">
        <span className="ncore-who" title={noAgents ? 'Агентов подключим позже — сейчас сообщения сохраняются в чате' : undefined}>
          {noAgents ? 'Агенты не подключены' : `Ответит: ${catalog?.agents[0]?.name}`}
        </span>
        {!!catalog?.efforts.length && (
          <Select className="ncore-picker" label="Как долго думать перед ответом" value={effort} onChange={setEffort} placeholder="Обычно"
            groups={[{ options: [{ value: '', label: 'Как обычно' }, ...catalog.efforts.map((e) => ({ value: e.id, label: e.label }))] }]} />
        )}
        <span className="ncore-keys" aria-hidden="true"><kbd>/</kbd> команды · <kbd>Shift</kbd>+<kbd>Enter</kbd> новая строка</span>
      </div>
    </div>
  );
});
