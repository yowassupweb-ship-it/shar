import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, MessageSquarePlus, MoreHorizontal, RotateCcw, Table2, TextQuote, X } from 'lucide-react';
import { Avatar } from '@/shared/ui/Avatar';
import { askConfirm, Menu, MenuItem, type MenuAnchor } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import { myId } from '@/shared/session/session';
import type { Comment, CommentAnchor } from './types';
import type { Thread, useComments } from './useComments';

type Comments = ReturnType<typeof useComments>;

function when(iso: string): string {
  const date = new Date(iso);
  const min = Math.round((Date.now() - date.getTime()) / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} ч назад`;
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const isAnchor = (value: Comment['anchor']): value is CommentAnchor => Boolean(value && 'kind' in value);

/** К чему привязана ветка: цитата из текста или ячейка листа. По нажатию редактор переходит к месту. */
function AnchorChip({ anchor, onJump }: { anchor: CommentAnchor; onJump?: () => void }) {
  const isCell = anchor.kind === 'cell';
  const text = anchor.kind === 'cell' ? `${anchor.sheet ? `${anchor.sheet} · ` : ''}${anchor.cell}` : anchor.quote;
  if (!text) return null;
  const body = (
    <>
      {isCell ? <Table2 size={12} aria-hidden="true" /> : <TextQuote size={12} aria-hidden="true" />}
      <span>{text}</span>
    </>
  );
  return onJump
    ? <button type="button" className="nws-cm-anchor" data-kind={anchor.kind} onClick={onJump} title="Перейти к месту">{body}</button>
    : <span className="nws-cm-anchor" data-kind={anchor.kind}>{body}</span>;
}

/** Поле ввода: Ctrl/⌘+Enter отправляет, Esc отменяет. Растёт по тексту. */
function Composer({ placeholder, submit, onCancel, autoFocus, busyLabel = 'Отправить', initial = '' }: {
  placeholder: string; submit: (text: string) => Promise<void>; onCancel?: () => void; autoFocus?: boolean; busyLabel?: string; initial?: string;
}) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (autoFocus) area.current?.focus(); }, [autoFocus]);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);
  const send = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    try { await submit(value); setText(''); } catch (cause) { showToast(cause instanceof Error ? cause.message : 'Не отправилось', 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="nws-cm-composer">
      <textarea
        ref={area}
        value={text}
        rows={1}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); }
          if (e.key === 'Escape' && onCancel) { e.preventDefault(); onCancel(); }
        }}
      />
      {(text.trim() || onCancel) && (
        <div className="nws-cm-composer-actions">
          {onCancel && <button type="button" className="nx-ghost" onClick={onCancel}>Отмена</button>}
          <button type="button" className="nx-primary" disabled={!text.trim() || busy} onClick={() => void send()}>{busyLabel}</button>
        </div>
      )}
    </div>
  );
}

function Message({ comment, canModerate, onEdit, onDelete, editing, onDoneEdit }: {
  comment: Comment; canModerate: boolean; onEdit: () => void; onDelete: () => void; editing: boolean; onDoneEdit: (text: string | null) => Promise<void>;
}) {
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const mine = comment.authorId === myId();
  return (
    <div className="nws-cm-msg">
      <Avatar name={comment.authorName} seed={comment.authorId} src={comment.authorAvatar || undefined} person size={28} />
      <div className="nws-cm-msg-body">
        <div className="nws-cm-msg-head">
          <b>{comment.authorName || 'Без имени'}</b>
          <time dateTime={comment.createdAt} title={new Date(comment.createdAt).toLocaleString('ru-RU')}>{when(comment.createdAt)}</time>
          {comment.updatedAt !== comment.createdAt && <span className="nws-cm-edited">изм.</span>}
          {(mine || canModerate) && (
            <button type="button" className="nws-cm-more" aria-label="Действия с комментарием" onClick={(e) => setMenu({ element: e.currentTarget, align: 'end' })}><MoreHorizontal size={15} /></button>
          )}
        </div>
        {editing
          ? <Composer placeholder="Комментарий" initial={comment.body} autoFocus busyLabel="Сохранить" submit={(text) => onDoneEdit(text)} onCancel={() => void onDoneEdit(null)} />
          : <p className="nws-cm-text">{comment.body}</p>}
      </div>
      {menu && (
        <Menu anchor={menu} label="Действия с комментарием" onClose={() => setMenu(null)} compact>
          {mine && <MenuItem onSelect={() => { setMenu(null); onEdit(); }}>Изменить</MenuItem>}
          <MenuItem tone="danger" onSelect={() => { setMenu(null); onDelete(); }}>Удалить</MenuItem>
        </Menu>
      )}
    </div>
  );
}

function ThreadCard({ thread, comments, canModerate, active, onJump, onActivate }: {
  thread: Thread; comments: Comments; canModerate: boolean; active: boolean; onJump?: (anchor: CommentAnchor) => void; onActivate: () => void;
}) {
  const { root, replies } = thread;
  const [replying, setReplying] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const anchor = isAnchor(root.anchor) ? root.anchor : null;

  const remove = async (comment: Comment) => {
    const isRoot = !comment.parentId;
    const ok = await askConfirm({
      title: isRoot ? 'Удалить комментарий?' : 'Удалить ответ?',
      text: isRoot && replies.length ? 'Вместе с ним удалятся и все ответы.' : undefined,
      confirm: 'Удалить', tone: 'danger',
    });
    if (!ok) return;
    try { await comments.remove(comment.id); } catch (cause) { showToast(cause instanceof Error ? cause.message : 'Не удалось удалить', 'error'); }
  };
  const toggleResolved = async () => {
    try { await comments.change(root.id, { resolved: !root.resolved }); } catch (cause) { showToast(cause instanceof Error ? cause.message : 'Не получилось', 'error'); }
  };
  const finishEdit = (comment: Comment) => async (text: string | null) => {
    if (text !== null && text !== comment.body) await comments.change(comment.id, { body: text });
    setEditingId(null);
  };

  return (
    <article className="nws-cm-thread" data-thread={root.id} data-resolved={root.resolved || undefined} data-active={active || undefined} onClick={onActivate}>
      {anchor && <AnchorChip anchor={anchor} onJump={onJump ? () => onJump(anchor) : undefined} />}
      <div className="nws-cm-resolve-row">
        <Message comment={root} canModerate={canModerate} editing={editingId === root.id} onEdit={() => setEditingId(root.id)} onDelete={() => void remove(root)} onDoneEdit={finishEdit(root)} />
        <button type="button" className="nws-cm-resolve" aria-label={root.resolved ? 'Открыть снова' : 'Решено'} title={root.resolved ? 'Открыть снова' : 'Решено'} onClick={(e) => { e.stopPropagation(); void toggleResolved(); }}>
          {root.resolved ? <RotateCcw size={15} /> : <Check size={16} />}
        </button>
      </div>
      {root.resolved && root.resolvedByName && <p className="nws-cm-resolved-note">Решено: {root.resolvedByName}</p>}
      {replies.map((reply) => (
        <Message key={reply.id} comment={reply} canModerate={canModerate} editing={editingId === reply.id} onEdit={() => setEditingId(reply.id)} onDelete={() => void remove(reply)} onDoneEdit={finishEdit(reply)} />
      ))}
      {replying
        ? <Composer placeholder="Ответить" autoFocus busyLabel="Ответить" onCancel={() => setReplying(false)} submit={async (text) => { await comments.add(text, null, root.id); setReplying(false); }} />
        : <button type="button" className="nws-cm-reply" onClick={(e) => { e.stopPropagation(); setReplying(true); }}>Ответить</button>}
    </article>
  );
}

/**
 * Панель комментариев документа и таблицы, как в Google Docs: новый комментарий к выделенному тексту или ячейке,
 * ветки с ответами, «Решено» убирает ветку в архив, у каждой — переход к месту в материале.
 */
export function CommentsPanel({ comments, canModerate, getAnchor, onJump, onClose, kind, focusTick = 0, focusCell = null }: {
  comments: Comments; canModerate: boolean; kind: 'document' | 'table';
  getAnchor: () => CommentAnchor | null; onJump?: (anchor: CommentAnchor) => void; onClose: () => void;
  /** Меняется — поставить курсор в поле нового комментария. */
  focusTick?: number;
  /** Выбрали ячейку (таблица) или прокомментированный текст (документ, quote) — ветка становится активной и прокручивается
   *  в вид (tick — каждый выбор). */
  focusCell?: { sheet: string; cell: string; quote?: string; tick: number } | null;
}) {
  const newBox = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focusTick) newBox.current?.querySelector('textarea')?.focus(); }, [focusTick]);
  const [tab, setTab] = useState<'open' | 'resolved'>('open');
  const [anchor, setAnchor] = useState<CommentAnchor | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const resolved = useMemo(() => comments.threads.filter((t) => t.root.resolved), [comments.threads]);
  const shown = tab === 'open' ? comments.open : resolved;
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusCell) return;
    const thread = comments.open.find((t) => {
      const at = t.root.anchor;
      if (!isAnchor(at)) return false;
      if (focusCell.quote) return at.kind === 'text' && at.quote === focusCell.quote;
      return at.kind === 'cell' && at.cell === focusCell.cell && (!at.sheet || !focusCell.sheet || at.sheet === focusCell.sheet);
    });
    if (!thread) return;
    setTab('open');
    setActiveId(thread.root.id);
    window.requestAnimationFrame(() => list.current?.querySelector(`[data-thread="${CSS.escape(thread.root.id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }, [focusCell]); // eslint-disable-line react-hooks/exhaustive-deps

  // Привязку читаем у редактора, пока панель открыта: выделили текст или ячейку — она тут же в поле нового комментария.
  useEffect(() => {
    const read = () => {
      let next: CommentAnchor | null = null;
      try { next = getAnchor(); } catch { /* редактор пересоздаётся */ }
      setAnchor((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
    };
    read();
    const timer = window.setInterval(read, 500);
    return () => window.clearInterval(timer);
  }, [getAnchor]);

  return (
    <aside className="nws-cm" aria-label="Комментарии">
      <header className="nws-cm-head">
        <h2>Комментарии</h2>
        <button type="button" className="nx-icon-btn" onClick={onClose} aria-label="Закрыть комментарии"><X size={16} /></button>
      </header>
      {!comments.ready ? (
        <p className="nws-cm-empty">Комментарии появятся после обновления сервера Шара.</p>
      ) : (
        <>
          <div className="nws-cm-new" ref={newBox}>
            {anchor
              ? <AnchorChip anchor={anchor} />
              : <p className="nws-cm-hint">{kind === 'table' ? 'Выберите ячейку, чтобы прокомментировать её' : 'Выделите текст, чтобы прокомментировать его'}</p>}
            <Composer placeholder="Добавить комментарий" busyLabel="Комментировать" submit={async (text) => { await comments.add(text, anchor); setTab('open'); }} />
          </div>
          <div className="nx-segment nws-cm-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'open'} onClick={() => setTab('open')}>Открытые{comments.open.length ? ` · ${comments.open.length}` : ''}</button>
            <button type="button" role="tab" aria-selected={tab === 'resolved'} onClick={() => setTab('resolved')}>Решённые{resolved.length ? ` · ${resolved.length}` : ''}</button>
          </div>
          <div className="nws-cm-list nx-scroll-y" ref={list}>
            {!comments.loaded && <p className="nws-cm-empty">Загружаю…</p>}
            {comments.loaded && !shown.length && (
              <div className="nws-cm-empty">
                <MessageSquarePlus size={22} aria-hidden="true" />
                <p>{tab === 'open' ? 'Открытых комментариев нет' : 'Решённых комментариев нет'}</p>
              </div>
            )}
            {shown.map((thread) => (
              <ThreadCard key={thread.root.id} thread={thread} comments={comments} canModerate={canModerate} active={activeId === thread.root.id}
                onActivate={() => setActiveId(thread.root.id)} onJump={onJump} />
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
