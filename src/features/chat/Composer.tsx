import { useEffect, useMemo, useRef, useState } from 'react';
import { lazyComponent } from '@/shared/ui/lazy';
import {
  ArrowUp, BarChart3, CornerUpLeft, FileText, Forward, Keyboard, Mic, Paperclip, Pencil, Plus, Smile, Trash2, X,
} from 'lucide-react';
import { CoreMini } from '@/shared/ui/CoreIcon';
import { plural } from '@/shared/ui/format';
import { askConfirm, Menu, MenuItem, type MenuAnchor } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import { useLongPress } from '@/shared/ui/useLongPress';
import ForwardSheet from './ForwardSheet';
import RichInput, { type RichInputHandle } from './RichInput';
import { readDraft, writeDraft } from './drafts';
import { scheduleMessage, whenLabel } from './scheduled';
import { ScheduledBar, ScheduleMenu, SchedulePicker } from './ScheduledUi';
import { deleteMessage, editMessage, forwardMessages, forwardToAgentFrom } from './messageActions';
import { useAgentBridge } from '@/shared/core/agentBridge';
import {
  displayName, isGroupChat, notifyTyping, previewText, sendFiles, sendPoll, sendText, setCompose, uploadForLater, setForwardDraft, setPanel, setSelection,
  useChatStore, type Msg,
} from './store';
import TypingLine from './TypingLine';
import VoiceRecorder from './VoiceRecorder';

const MAX_FILES = 10;

const PollCreatorModal = lazyComponent(() => import('@/features/chat/polls/PollCreatorModal'));

/** Узкий сенсорный экран: панель эмодзи и клавиатура сменяют друг друга. */
const keyboardSwap = () => window.matchMedia('(max-width: 640px) and (pointer: coarse)').matches;

/**
 * Композер как в iMessage.
 *
 *   [+]  ( текст…                 ☺ )  [🎤 | ↑]
 *
 * «+» — файлы и опрос; смайлик открывает боковую панель эмодзи и стикеров;
 * справа микрофон, пока поле пустое, и синяя стрелка, когда есть что
 * отправить. Файлы можно вставить из буфера или перетащить — они встают
 * превью над полем, текст уходит подписью.
 *
 * Черновик — в draft_<chatId> (общий со старым интерфейсом). Во время
 * правки черновик не трогаем: отменили правку — вернулся недописанный текст.
 */
export default function Composer({ chatId, readOnly }: { chatId: string; readOnly: boolean }) {
  const compose = useChatStore((s) => s.compose[chatId]);
  const replyTo = useChatStore((s) => (compose?.replyToId ? s.threads[chatId]?.byId[compose.replyToId] : undefined));
  const editing = useChatStore((s) => (compose?.editingId ? s.threads[chatId]?.byId[compose.editingId] : undefined));
  const chat = useChatStore((s) => s.chats[chatId]);
  const users = useChatStore((s) => s.users);
  const agentOn = useAgentBridge((s) => s.available);
  const panel = useChatStore((s) => s.panel);
  const selection = useChatStore((s) => (s.selection?.chatId === chatId ? s.selection.ids : null));
  const forwardDraft = useChatStore((s) => s.forwardDraft[chatId]);
  const [forwarding, setForwarding] = useState<Msg[] | null>(null);
  const [text, setText] = useState(() => readDraft(chatId));
  const [files, setFiles] = useState<File[]>([]);
  const [recording, setRecording] = useState(false);
  const [plusAnchor, setPlusAnchor] = useState<MenuAnchor | null>(null);
  const [pollOpen, setPollOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [laterMenu, setLaterMenu] = useState<MenuAnchor | null>(null);
  const [laterPick, setLaterPick] = useState(false);
  const sendHold = useLongPress((x, y) => openLater({ x, y }));
  const ref = useRef<RichInputHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const coarse = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

  useEffect(() => {
    if (editing) return undefined;
    const t = window.setTimeout(() => writeDraft(chatId, text), 300);
    return () => window.clearTimeout(t);
  }, [chatId, text, editing]);

  // Ушли из чата раньше, чем сработал таймер (начали стирать и сразу переключились), — черновик пишем сразу,
  // иначе стёртое возвращалось бы из прежнего черновика.
  const live = useRef({ text, editing: Boolean(editing) });
  live.current = { text, editing: Boolean(editing) };
  useEffect(() => () => { if (!live.current.editing) writeDraft(chatId, live.current.text); }, [chatId]);

  const editingId = editing?.id;
  useEffect(() => {
    if (editingId) {
      const m = useChatStore.getState().threads[chatId]?.byId[editingId];
      setText(m?.content || '');
      requestAnimationFrame(() => ref.current?.caretToEnd());
    } else {
      setText(readDraft(chatId));
    }
  }, [editingId, chatId]);

  useEffect(() => { if (replyTo) ref.current?.focus(); }, [replyTo]);
  useEffect(() => { if (window.matchMedia?.('(pointer: fine)').matches) ref.current?.focus(); }, [chatId]);

  // Эмодзи из боковой панели — в позицию курсора, картинкой Apple (как в панели и в ленте).
  useEffect(() => {
    const onEmoji = (e: Event) => {
      const emoji = String((e as CustomEvent).detail || '');
      if (!emoji) return;
      ref.current?.insertEmoji(emoji);
      // На сенсорном экране фокус не отнимаем: панель стоит на месте клавиатуры.
    };
    window.addEventListener('nx:insert-emoji', onEmoji);
    return () => window.removeEventListener('nx:insert-emoji', onEmoji);
  }, []);

  // Ответ агента «Ядра» — в конец поля ввода открытого чата (insertIntoOpenChat). Во время правки не трогаем.
  useEffect(() => {
    if (readOnly || editingId) return undefined;
    const onInsert = (e: Event) => {
      const d = (e as CustomEvent<{ chatId: string; text: string; handled: boolean }>).detail;
      if (d.chatId !== chatId || !d.text) return;
      d.handled = true;
      setText((cur) => (cur.trim() ? `${cur.trimEnd()}

${d.text}` : d.text));
      requestAnimationFrame(() => ref.current?.caretToEnd());
    };
    window.addEventListener('nx:insert-text', onInsert);
    return () => window.removeEventListener('nx:insert-text', onInsert);
  }, [chatId, readOnly, editingId]);

  const previews = useMemo(() => files.map((f) => ({
    file: f,
    url: f.type.startsWith('image/') ? URL.createObjectURL(f) : null,
  })), [files]);
  useEffect(() => () => { previews.forEach((p) => p.url && URL.revokeObjectURL(p.url)); }, [previews]);

  if (readOnly) return null;

  const hasText = text.trim().length > 0;
  const forwardCount = forwardDraft?.length ?? 0;
  const canSend = hasText || files.length > 0 || forwardCount > 0;
  const cancel = () => setCompose(chatId, {});
  const addFiles = (list: FileList | File[] | null) => {
    const arr = Array.from(list || []).filter((f) => f.size > 0);
    if (!arr.length) return;
    // Больше 10 файлов в сообщение не уходит — лишние не теряем молча, а говорим, что их нужно отправить отдельно.
    const left = Math.max(0, MAX_FILES - files.length);
    if (arr.length > left) showToast(left ? `В одно сообщение — до ${MAX_FILES} файлов. Прикреплены первые ${left}, остальные отправьте следующим сообщением` : `В одно сообщение — до ${MAX_FILES} файлов. Отправьте эти и прикрепите остальные`, 'info');
    setFiles((prev) => [...prev, ...arr].slice(0, MAX_FILES));
  };

  const submit = () => {
    if (editing) {
      if (!hasText) return;
      void editMessage(chatId, String(editing.id), text);
      setText(readDraft(chatId));
      return;
    }
    if (!hasText && !files.length && !forwardCount) return;
    // Свои слова и файлы уходят после пересылаемых — в том же порядке, как их видно в композере.
    const ownText = text;
    const ownFiles = files;
    const sendOwn = () => {
      if (ownFiles.length) void sendFiles(chatId, ownFiles, ownText);
      else if (ownText.trim()) sendText(chatId, ownText);
    };
    if (forwardDraft?.length) {
      const pending = forwardDraft;
      setForwardDraft(chatId, null);
      void forwardMessages(chatId, pending).then((ok) => { if (ok) sendOwn(); else setForwardDraft(chatId, pending); });
    } else {
      sendOwn();
    }
    setFiles([]);
    setText('');
    writeDraft(chatId, '');
    notifyTyping(chatId, false);
  };

  // ── Отправить позже: правый щелчок / долгое нажатие на стрелке. Пересылку и правку не планируем. ──
  const canLater = canSend && !editing && !forwardCount;
  function openLater(anchor: MenuAnchor) { if (canLater) setLaterMenu(anchor); }
  async function scheduleAt(at: Date) {
    const ownText = text.trim();
    const ownFiles = files;
    const replyToId = compose?.replyToId;
    if (!ownText && !ownFiles.length) return;
    // Поле очищается сразу, как при обычной отправке; не вышло — текст и файлы возвращаются.
    setFiles([]);
    setText('');
    writeDraft(chatId, '');
    setCompose(chatId, {});
    notifyTyping(chatId, false);
    try {
      if (ownFiles.length) showToast('Загружаю файлы…', 'info');
      const attachments = ownFiles.length ? await uploadForLater(ownFiles) : undefined;
      const item = await scheduleMessage(chatId, at, { content: ownText, replyToId, attachments });
      showToast(`Сообщение уйдёт ${whenLabel(item.sendAt)}`, 'success');
    } catch (cause) {
      setText((cur) => cur || ownText);
      setFiles((cur) => (cur.length ? cur : ownFiles));
      showToast(cause instanceof Error && cause.message ? cause.message : 'Не удалось запланировать', 'error');
      throw cause;
    }
  }

  const editLast = () => {
    const st = useChatStore.getState();
    const t = st.threads[chatId];
    const my = String(st.me?.id ?? '');
    if (!t) return false;
    for (let i = t.ids.length - 1; i >= 0; i--) {
      const m = t.byId[t.ids[i]];
      if (String(m.authorId) === my && !m._status && m.content && !m.metadata?.poll) {
        setCompose(chatId, { editingId: String(m.id) });
        return true;
      }
    }
    return false;
  };

  // Пересылаемые сообщения — вложением над полем: кто написал и о чём, каждое можно убрать.
  const forwardTray = forwardCount > 0 ? (
    <div className="cxc-forward" role="group" aria-label="Пересылаемые сообщения">
      <div className="cxc-forward-head">
        <Forward size={14} aria-hidden="true" />
        <b>Пересылка: {forwardCount} {plural(forwardCount, ['сообщение', 'сообщения', 'сообщений'])}</b>
        <span>добавьте комментарий и отправьте</span>
        <button type="button" className="nx-icon-btn" onClick={() => setForwardDraft(chatId, null)} aria-label="Не пересылать"><X size={14} /></button>
      </div>
      <ul className="cxc-forward-list">
        {forwardDraft!.map((m) => (
          <li key={String(m.id)}>
            <span><b>{displayName(users[String(m.authorId)]) || m.authorName || 'Сообщение'}: </b>{previewText(m) || 'Вложение'}</span>
            <button type="button" className="nx-icon-btn" onClick={() => setForwardDraft(chatId, forwardDraft!.filter((x) => String(x.id) !== String(m.id)))} aria-label="Убрать из пересылки"><X size={12} /></button>
          </li>
        ))}
      </ul>
    </div>
  ) : null;

  const bar = editing ? (
    <div className="cxc-bar" data-kind="edit">
      <span className="cxc-bar-icon"><Pencil size={14} aria-hidden="true" /></span>
      <span className="cxc-bar-text"><b>Изменение: </b>{editing.content}</span>
      <button type="button" className="nx-icon-btn" onClick={cancel} aria-label="Отменить изменение"><X size={14} /></button>
    </div>
  ) : replyTo ? (
    <div className="cxc-bar" data-kind="reply">
      <span className="cxc-bar-icon"><CornerUpLeft size={14} aria-hidden="true" /></span>
      <span className="cxc-bar-text">
        <b>{displayName(users[String(replyTo.authorId)]) || replyTo.authorName}: </b>
        {previewText(replyTo) || 'Сообщение'}
      </span>
      <button type="button" className="nx-icon-btn" onClick={cancel} aria-label="Отменить ответ"><X size={14} /></button>
    </div>
  ) : null;

  if (selection) {
    const msgs = selection.map((id) => useChatStore.getState().threads[chatId]?.byId[id]).filter(Boolean) as Msg[];
    const myIdNow = String(useChatStore.getState().me?.id ?? '');
    const own = msgs.filter((m) => String(m.authorId) === myIdNow);
    return (
      <div className="cxn-composer">
        <div className="cxc-select" role="toolbar" aria-label="Выбранные сообщения">
          <button type="button" className="nx-ghost" onClick={() => setSelection(null)}>Отмена</button>
          <span className="cxc-select-count">Выбрано: {msgs.length}</span>
          <button type="button" className="nx-icon-btn" disabled={!msgs.length} onClick={() => setForwarding(msgs)} aria-label="Переслать выбранные">
            <Forward size={18} aria-hidden="true" />
          </button>
          {agentOn && (
            <button type="button" className="nx-icon-btn" disabled={!msgs.length} title="Переслать агенту — он увидит только эти сообщения"
              onClick={() => { forwardToAgentFrom(msgs, (m) => displayName(users[String(m.authorId)])); setSelection(null); }} aria-label="Переслать выбранные агенту">
              <CoreMini size={18} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="nx-icon-btn"
            disabled={!own.length}
            title={own.length < msgs.length ? 'Удалить можно только свои сообщения' : undefined}
            onClick={() => {
              void askConfirm({
                title: own.length > 1 ? `Удалить ${own.length} ${plural(own.length, ['сообщение', 'сообщения', 'сообщений'])}?` : 'Удалить сообщение?',
                text: own.length < msgs.length ? 'Чужие сообщения останутся — удалить можно только свои.' : 'Они пропадут у всех участников чата.',
                confirm: 'Удалить',
                tone: 'danger',
              }).then((ok) => {
                if (!ok) return;
                own.forEach((m) => { void deleteMessage(chatId, String(m.id)); });
                setSelection(null);
              });
            }}
            aria-label="Удалить выбранные"
          >
            <Trash2 size={18} aria-hidden="true" />
          </button>
        </div>
        {forwarding && <ForwardSheet messages={forwarding} onClose={() => setForwarding(null)} onDone={() => setSelection(null)} />}
      </div>
    );
  }

  return (
    <form
      className="cxn-composer"
      data-dragging={dragging ? 'true' : undefined}
      onSubmit={(e) => { e.preventDefault(); submit(); }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
    >
      <TypingLine chatId={chatId} />
      <ScheduledBar chatId={chatId} />
      {forwardTray}
      {bar}
      {files.length > 0 && (
        <div className="cxc-files" aria-label="Вложения к отправке">
          {previews.map((p, i) => (
            <span key={i} className="cxc-file">
              {p.url ? <img src={p.url} alt="" /> : <span className="cxc-file-doc"><FileText size={18} /><span>{p.file.name}</span></span>}
              <button type="button" className="cxc-file-x" onClick={() => setFiles((f) => f.filter((_, j) => j !== i))} aria-label={`Убрать ${p.file.name}`}>
                <X size={12} strokeWidth={3} />
              </button>
            </span>
          ))}
        </div>
      )}

      {recording ? (
        <VoiceRecorder chatId={chatId} onDone={() => setRecording(false)} />
      ) : (
        <div className="cxc-row">
          {!editing && (
            <button
              type="button"
              className="cxc-plus"
              aria-label="Прикрепить"
              aria-haspopup="menu"
              aria-expanded={Boolean(plusAnchor)}
              onClick={(e) => setPlusAnchor(plusAnchor ? null : { element: e.currentTarget, side: 'above' })}
            >
              <Plus size={20} strokeWidth={2.4} aria-hidden="true" />
            </button>
          )}
          <div className="cxn-field" data-has-text={canSend ? 'true' : undefined}>
            <label className="nx-sr" htmlFor="cxn-input">{editing ? 'Изменить сообщение' : 'Сообщение'}</label>
            <RichInput
              id="cxn-input"
              ref={ref}
              className="cxn-input"
              value={text}
              placeholder={editing ? 'Изменить сообщение' : files.length ? 'Подпись' : 'Сообщение'}
              // На телефоне Enter — перенос строки (отправка — синей кнопкой), и
              // клавиша должна называться «Ввод», а не обещать отправку.
              enterKeyHint={coarse ? undefined : editing ? 'done' : 'send'}
              onFocus={() => {
                // Панель эмодзи стоит на месте клавиатуры: поле ввода её сменяет.
                if (panel === 'emoji' && keyboardSwap()) setPanel(null);
              }}
              onChange={(value) => {
                setText(value);
                if (!editing) notifyTyping(chatId, value.trim().length > 0);
              }}
              onPasteFiles={addFiles}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && forwardCount && !editing) { e.preventDefault(); setForwardDraft(chatId, null); return; }
                if (e.key === 'Escape' && (editing || replyTo)) { e.preventDefault(); cancel(); return; }
                if (e.key === 'ArrowUp' && !text && !editing && !files.length && editLast()) { e.preventDefault(); return; }
                if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.nativeEvent.isComposing || coarse) return;
                e.preventDefault();
                submit();
              }}
            />
            <button
              type="button"
              className="cxc-in-btn"
              aria-label={panel === 'emoji' && keyboardSwap() ? 'Клавиатура' : 'Эмодзи и стикеры'}
              aria-pressed={panel === 'emoji'}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => {
                if (panel === 'emoji') {
                  setPanel(null);
                  // Обратно к клавиатуре — как в iMessage: смайлик сменяется ею.
                  if (keyboardSwap()) ref.current?.focus();
                  return;
                }
                // Телефон: панель встаёт вместо клавиатуры, а не над ней.
                if (keyboardSwap()) ref.current?.blur();
                setPanel('emoji');
              }}
            >
              {panel === 'emoji' && keyboardSwap()
                ? <Keyboard size={20} aria-hidden="true" />
                : <Smile size={20} aria-hidden="true" />}
            </button>
          </div>
          {canSend || editing ? (
            <button
              type="submit"
              className="cxn-send"
              disabled={!canSend}
              aria-label={editing ? 'Сохранить изменение' : 'Отправить'}
              title={canLater && !coarse ? 'Правый щелчок — отправить позже' : undefined}
              onPointerDown={(e) => e.preventDefault()}
              onContextMenu={(e) => { if (!canLater) return; e.preventDefault(); openLater({ element: e.currentTarget, align: 'end', side: 'above' }); }}
              {...sendHold}
            >
              <ArrowUp size={18} strokeWidth={2.6} aria-hidden="true" />
            </button>
          ) : (
            <button type="button" className="cxc-mic" aria-label="Записать голосовое" onClick={() => setRecording(true)}>
              <Mic size={20} aria-hidden="true" />
            </button>
          )}
        </div>
      )}

      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
      />

      {plusAnchor && (
        <Menu anchor={plusAnchor} label="Прикрепить" compact onClose={() => setPlusAnchor(null)}>
          <MenuItem icon={<Paperclip size={16} />} onSelect={() => { setPlusAnchor(null); fileInput.current?.click(); }}>Фото или файл</MenuItem>
          {chat && isGroupChat(chat) && (
            <MenuItem icon={<BarChart3 size={16} />} onSelect={() => { setPlusAnchor(null); setPollOpen(true); }}>Опрос</MenuItem>
          )}
        </Menu>
      )}

      {laterMenu && (
        <ScheduleMenu
          anchor={laterMenu}
          onClose={() => setLaterMenu(null)}
          onPick={(at) => { void scheduleAt(at).catch(() => {}); }}
          onCustom={() => setLaterPick(true)}
        />
      )}
      {laterPick && <SchedulePicker title="Отправить позже" onClose={() => setLaterPick(false)} onPick={scheduleAt} />}

      {pollOpen && (
        <PollCreatorModal
          isOpen
          onClose={() => setPollOpen(false)}
          onCreate={(question, options, multiple, anonymous, revote) => {
            sendPoll(chatId, question, options, multiple, anonymous, revote);
            setPollOpen(false);
          }}
        />
      )}
    </form>
  );
}
