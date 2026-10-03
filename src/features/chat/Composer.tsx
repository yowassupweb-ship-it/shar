import { useEffect, useMemo, useRef, useState } from 'react';
import { lazyComponent } from '@/shared/ui/lazy';
import {
  ArrowUp, BarChart3, CornerUpLeft, FileText, Forward, Keyboard, Mic, Paperclip, Pencil, Plus, Smile, Trash2, X,
} from 'lucide-react';
import { plural } from '@/shared/ui/format';
import { askConfirm, Menu, MenuItem, type MenuAnchor } from '@/shared/ui/overlay';
import ForwardSheet from './ForwardSheet';
import RichInput, { type RichInputHandle } from './RichInput';
import { readDraft, writeDraft } from './drafts';
import { deleteMessage, editMessage } from './messageActions';
import {
  displayName, isGroupChat, notifyTyping, previewText, sendFiles, sendPoll, sendText, setCompose, setPanel, setSelection,
  useChatStore, type Msg,
} from './store';
import TypingLine from './TypingLine';
import VoiceRecorder from './VoiceRecorder';

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
  const panel = useChatStore((s) => s.panel);
  const selection = useChatStore((s) => (s.selection?.chatId === chatId ? s.selection.ids : null));
  const [forwarding, setForwarding] = useState<Msg[] | null>(null);
  const [text, setText] = useState(() => readDraft(chatId));
  const [files, setFiles] = useState<File[]>([]);
  const [recording, setRecording] = useState(false);
  const [plusAnchor, setPlusAnchor] = useState<MenuAnchor | null>(null);
  const [pollOpen, setPollOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<RichInputHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const coarse = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

  useEffect(() => {
    if (editing) return undefined;
    const t = window.setTimeout(() => writeDraft(chatId, text), 300);
    return () => window.clearTimeout(t);
  }, [chatId, text, editing]);

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

  const previews = useMemo(() => files.map((f) => ({
    file: f,
    url: f.type.startsWith('image/') ? URL.createObjectURL(f) : null,
  })), [files]);
  useEffect(() => () => { previews.forEach((p) => p.url && URL.revokeObjectURL(p.url)); }, [previews]);

  if (readOnly) return null;

  const hasText = text.trim().length > 0;
  const canSend = hasText || files.length > 0;
  const cancel = () => setCompose(chatId, {});
  const addFiles = (list: FileList | File[] | null) => {
    const arr = Array.from(list || []).filter((f) => f.size > 0);
    if (arr.length) setFiles((prev) => [...prev, ...arr].slice(0, 10));
  };

  const submit = () => {
    if (editing) {
      if (!hasText) return;
      void editMessage(chatId, String(editing.id), text);
      setText(readDraft(chatId));
      return;
    }
    if (files.length) {
      void sendFiles(chatId, files, text);
      setFiles([]);
    } else if (hasText) {
      sendText(chatId, text);
    } else {
      return;
    }
    setText('');
    writeDraft(chatId, '');
    notifyTyping(chatId, false);
  };

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
              onPointerDown={(e) => e.preventDefault()}
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
