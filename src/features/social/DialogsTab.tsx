import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { AlertCircle, ArrowLeft, ArrowUp, ArrowUpRight, CheckCircle2, Circle, CornerDownRight, Mail, MessageSquare, MessagesSquare, Paperclip, Plus, Smile, X } from 'lucide-react';
import RichInput, { type RichInputHandle } from '@/features/chat/RichInput';
import { uploadFileWithProgress } from '@/shared/api/uploadFile';
import { links, paths } from '@/shared/navigation/routes';
import { realtime } from '@/shared/realtime/realtime';
import { SearchField } from '@/shared/ui/SearchField';
import { Sheet } from '@/shared/ui/overlay';
import { Spinner } from '@/shared/ui/Spinner';
import { showToast } from '@/shared/ui/Toast';
import { listDialogs, loadDialog, markHandled, sendToDialog, writePrivate, type DialogMessage, type OutFile, type Platform, type SocialDialog } from './api';
import { Linkified } from './Linkified';
import { SocialAvatar } from './SocialAvatar';

// Панель эмодзи — та же, что в чате (без стикеров: их во ВКонтакте и MAX из Шара не отправить).
const EmojiTab = lazy(() => import('@/features/chat/EmojiPanel').then((m) => ({ default: m.EmojiTab })));

const NARROW = '(max-width: 760px)';
const subscribeNarrow = (cb: () => void) => {
  const mq = window.matchMedia(NARROW);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
};

const PICTURE_LABELS = new Set(['Фото', 'Стикер', 'Граффити']);

const KIND_LABEL: Record<SocialDialog['kind'], string> = { private: 'Личные сообщения', business: 'Личные сообщения', group: 'Беседа', comments: 'Комментарии' };

function when(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

const timeOf = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '');

/**
 * Диалоги с клиентами — все площадки в одной системе: слева список (ВКонтакте и MAX вместе, свежие
 * сверху, «ждёт ответа» — точкой), справа переписка и ответ. Две вкладки раздела — один экран в двух
 * режимах: «Диалоги» (личные и беседы) и «Комментарии» (автор под постом). Открытый диалог — в адресе (?dialog=…),
 * на него ведёт ссылка из карточки в чате. Новое сообщение или чужой ответ приходят событием
 * social_changed — список и открытый диалог обновляются сами.
 */
export default function DialogsTab({ mode }: { mode: 'dialogs' | 'comments' }) {
  const [params, setParams] = useSearchParams();
  const openId = params.get('dialog');
  const narrow = useSyncExternalStore(subscribeNarrow, () => window.matchMedia(NARROW).matches, () => false);
  const [waitingOnly, setWaitingOnly] = useState(false);
  const [platform, setPlatform] = useState<Platform | ''>('');
  const [q, setQ] = useState('');
  const [list, setList] = useState<Awaited<ReturnType<typeof listDialogs>> | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0); // social_changed по открытому диалогу

  const load = useCallback(() => {
    listDialogs(mode, { waiting: waitingOnly, platform, q }).then((d) => { setList(d); setError(''); }).catch((e: Error) => setError(e.message));
  }, [mode, waitingOnly, platform, q]);
  useEffect(() => { const t = window.setTimeout(load, q ? 250 : 0); return () => window.clearTimeout(t); }, [load, q]);
  useEffect(() => realtime.subscribe((event) => {
    const e = event as { type?: string; dialogId?: string };
    if (e.type !== 'social_changed') return;
    load();
    if (e.dialogId && e.dialogId === openId) setTick((n) => n + 1);
  }), [load, openId]);

  const open = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('dialog', id); else next.delete('dialog');
    setParams(next, { replace: !narrow });
  };

  const listPane = (
    <aside className="nsd-list" aria-label={mode === 'comments' ? 'Комментарии' : 'Диалоги'}>
      <div className="nsd-filters">
        <div className="nx-segment" role="group" aria-label="Какие диалоги">
          <button type="button" aria-pressed={!waitingOnly} onClick={() => setWaitingOnly(false)}>Все</button>
          <button type="button" aria-pressed={waitingOnly} onClick={() => setWaitingOnly(true)}>
            Ждут ответа{list && list.waiting[mode] > 0 && <span className="nsd-count">{list.waiting[mode]}</span>}
          </button>
        </div>
        <div className="nx-segment" role="group" aria-label="Площадка">
          <button type="button" aria-pressed={platform === ''} onClick={() => setPlatform('')}>Все</button>
          <button type="button" aria-pressed={platform === 'vk'} onClick={() => setPlatform('vk')}>ВК</button>
          <button type="button" aria-pressed={platform === 'max'} onClick={() => setPlatform('max')}>MAX</button>
        </div>
        <SearchField value={q} onChange={setQ} placeholder={mode === 'comments' ? 'Автор, текст, пост' : 'Клиент, текст'} label="Поиск" />
      </div>
      <div className="nsd-rows nx-scroll-y">
        {error ? (
          <div className="nx-state" data-tone="danger" role="alert"><AlertCircle size={22} aria-hidden="true" /><p>{error}</p></div>
        ) : !list ? (
          <div className="nx-state"><Spinner size={20} label="Загружаю диалоги" /></div>
        ) : !list.dialogs.length ? (
          <div className="nx-state"><MessagesSquare size={24} aria-hidden="true" /><p>{q ? 'Ничего не нашлось.' : waitingOnly ? 'Все ответы даны.' : mode === 'comments' ? 'Комментариев пока нет — они появятся с первым комментарием под постом.' : 'Диалогов пока нет — они появятся с первым сообщением клиента.'}</p></div>
        ) : list.dialogs.map((d) => (
          <button key={d.id} type="button" className="nsd-row" aria-current={d.id === openId ? 'true' : undefined} data-waiting={d.waiting ? 'true' : undefined} onClick={() => open(d.id)}>
            <SocialAvatar platform={d.platform} name={d.title || d.clientName} seed={d.id} src={d.avatar} size={38} />
            <span className="nsd-row-text">
              <span className="nsd-row-top"><b>{d.title || d.clientName}</b><time>{when(d.lastAt)}</time></span>
              <span className="nsd-row-src">{mode === 'comments' ? (d.context ? `Пост: ${d.context}` : d.sourceTitle) : `${KIND_LABEL[d.kind]}${d.kind === 'group' && d.sourceTitle && d.sourceTitle !== d.title ? ` · ${d.sourceTitle}` : ''}`}</span>
              <span className="nsd-row-last">{d.lastDir === 'out' && <span className="nsd-you">Вы: </span>}{d.lastDir === 'in' && d.handled && <span className="nsd-you">Ответ дан · </span>}{d.lastText}</span>
            </span>
            {d.waiting && <span className="nsd-dot" aria-label="Ждёт ответа" />}
          </button>
        ))}
      </div>
    </aside>
  );

  const threadPane = openId
    ? <Thread key={openId} id={openId} tick={tick} onBack={narrow ? () => open(null) : undefined} onSent={load} />
    : <section className="nsd-thread"><div className="nx-state"><MessagesSquare size={36} aria-hidden="true" /><h2>{mode === 'comments' ? 'Выберите комментарий' : 'Выберите диалог'}</h2><p>{mode === 'comments' ? 'Здесь комментарии автора под постом и ответ — прямо в ветку под его комментарием.' : 'Здесь вся переписка с клиентом и ответ — во ВКонтакте или MAX, откуда он написал.'}</p></div></section>;

  return (
    <div className="nsd" data-narrow={narrow ? 'true' : undefined}>
      {(!narrow || !openId) && listPane}
      {(!narrow || openId) && threadPane}
    </div>
  );
}

function Thread({ id, tick, onBack, onSent }: { id: string; tick: number; onBack?: () => void; onSent: () => void }) {
  const navigate = useNavigate();
  const [data, setData] = useState<Awaited<ReturnType<typeof loadDialog>> | null>(null);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<RichInputHandle>(null);
  const [emoji, setEmoji] = useState(false);
  const [privateOpen, setPrivateOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const picker = useRef<HTMLInputElement>(null);
  // Вложения: сначала грузятся в Шар (с прогрессом), в ответ уходят уже загруженные.
  const [files, setFiles] = useState<{ key: string; name: string; type: string; progress: number; file?: OutFile; error?: boolean }[]>([]);
  const uploading = files.some((f) => !f.file && !f.error);

  useEffect(() => {
    loadDialog(id).then((d) => { setData(d); setError(''); }).catch((e: Error) => setError(e.message));
  }, [id, tick]);
  // Новое сообщение — к низу переписки.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [data?.messages.length]);
  // Эмодзи из панели — в поле, в место курсора.
  useEffect(() => {
    const onEmoji = (e: Event) => input.current?.insertEmoji(String((e as CustomEvent).detail || ''));
    window.addEventListener('nx:insert-emoji', onEmoji);
    return () => window.removeEventListener('nx:insert-emoji', onEmoji);
  }, []);

  const pick = (list: FileList | File[] | null) => {
    const picked = Array.from(list || []).slice(0, Math.max(0, 10 - files.length));
    for (const f of picked) {
      const key = `${f.name}-${f.size}-${Math.random().toString(36).slice(2)}`;
      setFiles((prev) => [...prev, { key, name: f.name, type: f.type || 'application/octet-stream', progress: 0 }]);
      uploadFileWithProgress(f, (p) => setFiles((prev) => prev.map((x) => (x.key === key ? { ...x, progress: p } : x))))
        .then((r) => setFiles((prev) => prev.map((x) => (x.key === key ? { ...x, progress: 100, file: { url: r.url, name: f.name, type: f.type || 'application/octet-stream' } } : x))))
        .catch(() => setFiles((prev) => prev.map((x) => (x.key === key ? { ...x, error: true } : x))));
    }
    if (picker.current) picker.current.value = '';
  };

  const toggleHandled = () => {
    if (!data) return;
    markHandled(id, !data.dialog.handled)
      .then(({ dialog }) => { setData((cur) => (cur ? { ...cur, dialog } : cur)); onSent(); })
      .catch((e: Error) => showToast(e.message, 'error'));
  };

  const send = () => {
    const body = text.trim();
    const ready = files.filter((f) => f.file).map((f) => f.file!);
    if ((!body && !ready.length) || busy || uploading) return;
    setBusy(true);
    sendToDialog(id, body, ready)
      .then(() => { setText(''); setFiles([]); setEmoji(false); onSent(); return loadDialog(id).then(setData); })
      .catch((e: Error) => showToast(e.message, 'error'))
      .finally(() => setBusy(false));
  };

  if (error) return <section className="nsd-thread"><div className="nx-state" data-tone="danger" role="alert"><AlertCircle size={24} aria-hidden="true" /><p>{error}</p></div></section>;
  if (!data) return <section className="nsd-thread"><div className="nx-state"><Spinner size={22} label="Открываю диалог" /></div></section>;
  const d = data.dialog;
  const group = d.kind === 'group';
  // Файлы — в личные и беседы: в комментарии ВКонтакте сообщество из Шара вложения не прикрепит.
  const canAttach = d.kind !== 'comments' && (d.platform === 'vk' || d.platform === 'max');
  const canSend = !busy && !uploading && (Boolean(text.trim()) || files.some((f) => f.file));
  const hasFiles = (e: React.DragEvent) => canAttach && data.canReply && Array.from(e.dataTransfer.types).includes('Files');
  return (
    <section
      className="nsd-thread"
      aria-label={`Диалог: ${d.title}`}
      onDragOver={(e) => { if (!hasFiles(e)) return; e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(e) => { if (!hasFiles(e)) return; e.preventDefault(); setDragging(false); pick(e.dataTransfer.files); }}
    >
      <header className="nsd-head">
        {onBack && <button type="button" className="nx-icon-btn" onClick={onBack} aria-label="К списку диалогов"><ArrowLeft size={18} /></button>}
        <SocialAvatar platform={d.platform} name={d.title || d.clientName} seed={d.id} src={d.avatar} size={40} />
        <div className="nsd-head-text">
          <b>{d.title}{d.clientUsername && d.kind !== 'group' ? <span> · @{d.clientUsername}</span> : null}</b>
          <span>{d.platformLabel} · {KIND_LABEL[d.kind]}{d.kind !== 'private' && d.kind !== 'business' && d.sourceTitle ? ` · ${d.sourceTitle}` : ''}{d.account && !d.sourceTitle.startsWith(d.account) ? ` · ${d.account}` : ''}</span>
        </div>
        <span className="nsd-head-links">
          {data.canPrivate && <button type="button" onClick={() => setPrivateOpen(true)}><Mail size={13} aria-hidden="true" /> Написать в ЛС</button>}
          {d.lastDir === 'in' && (
            <button type="button" onClick={toggleHandled} aria-pressed={d.handled} title="Ответили не из Шара — убрать из «Ждут ответа»">
              {d.handled ? <CheckCircle2 size={13} aria-hidden="true" /> : <Circle size={13} aria-hidden="true" />} Ответ дан
            </button>
          )}
          {d.link && <a href={d.link} target="_blank" rel="noopener noreferrer">Открыть в {d.platformLabel}<ArrowUpRight size={13} aria-hidden="true" /></a>}
          {d.chatId && <button type="button" onClick={() => navigate(links.chat(d.chatId!))}><MessageSquare size={13} aria-hidden="true" /> Чат</button>}
        </span>
      </header>
      {privateOpen && (
        <PrivateSheet dialog={d} onClose={() => setPrivateOpen(false)}
          onSent={(dialogId) => { setPrivateOpen(false); onSent(); showToast('Сообщение ушло в личные', 'success'); navigate(`${paths.social}?dialog=${encodeURIComponent(dialogId)}`); }} />
      )}
      {d.kind === 'comments' && d.context && <div className="nsd-context"><CornerDownRight size={13} aria-hidden="true" /><span>Пост: {d.context}</span></div>}
      <div className="nsd-messages nx-scroll-y" ref={scroller}>
        {data.messages.map((m: DialogMessage, i) => {
          const prev = data.messages[i - 1];
          const showName = m.direction === 'out' ? prev?.direction !== 'out' || prev?.authorUserId !== m.authorUserId : group && (prev?.direction !== 'in' || prev?.authorName !== m.authorName);
          return (
            <div key={m.id} className="nsd-msg" data-dir={m.direction}>
              {showName && <span className="nsd-msg-name">{m.direction === 'out' ? m.authorName || 'Сотрудник' : m.authorName}</span>}
              <div className="nsd-bubble">
                {m.images?.length > 0 && (
                  <span className="nsd-msg-images">
                    {m.images.map((src) => (
                      <a key={src} href={src} target="_blank" rel="noopener noreferrer"><img src={src} alt="Вложение" loading="lazy" referrerPolicy="no-referrer" /></a>
                    ))}
                  </span>
                )}
                {m.text && <span className="nsd-msg-text"><Linkified text={m.text} /></span>}
                {m.media.length > 0 && <span className="nsd-msg-media">{(m.images?.length ? m.media.filter((x) => !PICTURE_LABELS.has(x)) : m.media).join(' · ')}{m.link ? <> — <a href={m.link} target="_blank" rel="noopener noreferrer">открыть</a></> : null}</span>}
                <time>{timeOf(m.at)}</time>
              </div>
            </div>
          );
        })}
      </div>
      {data.canReply ? (
        <div className="nsd-composer-wrap">
        {files.length > 0 && (
          <div className="nsd-files">
            {files.map((f) => (
              <span key={f.key} className="nsd-file" data-error={f.error ? 'true' : undefined}>
                <Paperclip size={12} aria-hidden="true" />
                <span>{f.name}</span>
                {!f.file && !f.error && <small>{f.progress}%</small>}
                {f.error && <small>не загрузился</small>}
                <button type="button" onClick={() => setFiles((prev) => prev.filter((x) => x.key !== f.key))} aria-label={`Убрать ${f.name}`}><X size={12} /></button>
              </span>
            ))}
          </div>
        )}
        {emoji && (
          <div className="nsd-emoji cxe">
            <Suspense fallback={<div className="nx-state"><Spinner size={18} label="Загружаю эмодзи" /></div>}><EmojiTab /></Suspense>
          </div>
        )}
        <div className="nsd-composer cxc-row" data-dragging={dragging ? 'true' : undefined}>
          {canAttach && (
            <>
              <input ref={picker} type="file" multiple hidden onChange={(e) => pick(e.target.files)} />
              <button type="button" className="cxc-plus" onClick={() => picker.current?.click()} disabled={files.length >= 10}
                aria-label="Прикрепить фото или файл" title="Фото или файл — до 10 за раз"><Plus size={20} strokeWidth={2.4} aria-hidden="true" /></button>
            </>
          )}
          <div className="cxn-field" data-has-text={canSend ? 'true' : undefined}>
            <label className="nx-sr" htmlFor="nsd-input">Ответ клиенту</label>
            <RichInput
              id="nsd-input"
              ref={input}
              className="cxn-input"
              value={text}
              placeholder={files.length ? 'Подпись' : `Ответ в ${d.platformLabel}`}
              enterKeyHint={coarse ? undefined : 'send'}
              onChange={(value) => setText(value.slice(0, 4000))}
              onPasteFiles={canAttach ? pick : undefined}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && emoji) { e.preventDefault(); setEmoji(false); return; }
                if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.nativeEvent.isComposing || coarse) return;
                e.preventDefault();
                send();
              }}
            />
            <button type="button" className="cxc-in-btn" aria-label="Эмодзи" aria-pressed={emoji}
              onPointerDown={(e) => e.preventDefault()} onClick={() => setEmoji((v) => !v)}>
              <Smile size={20} aria-hidden="true" />
            </button>
          </div>
          <button type="button" className="cxn-send" onClick={send} disabled={!canSend} aria-label="Отправить клиенту"
            onPointerDown={(e) => e.preventDefault()}>
            {busy ? <Spinner size={16} label="Отправляю" /> : <ArrowUp size={18} strokeWidth={2.6} aria-hidden="true" />}
          </button>
        </div>
        </div>
      ) : (
        <p className="nsd-noreply">Сюда {d.platformLabel} не даёт ответить из Шара — ответьте на сайте по ссылке «Открыть в {d.platformLabel}».</p>
      )}
    </section>
  );
}

/** Личное сообщение автору комментария от имени сообщества. ВКонтакте пропустит его, только если человек
 *  разрешил сообщения от сообщества или уже писал ему, — иначе покажем причину. */
function PrivateSheet({ dialog, onClose, onSent }: { dialog: SocialDialog; onClose: () => void; onSent: (dialogId: string) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    writePrivate(dialog.id, text.trim())
      .then((r) => onSent(r.dialogId))
      .catch((e: Error) => { showToast(e.message, 'error'); setBusy(false); });
  };
  return (
    <Sheet
      title={`В личные: ${dialog.clientName || dialog.title}`}
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          <button type="button" className="nx-ghost" onClick={onClose}>Отмена</button>
          <button type="button" className="nx-primary" disabled={busy || !text.trim()} onClick={send}>{busy ? 'Отправляю…' : 'Отправить в личные'}</button>
        </>
      )}
    >
      <div className="cxs-social-reply">
        {dialog.lastText && <blockquote>{dialog.lastText}</blockquote>}
        <textarea
          className="nx-field"
          rows={5}
          maxLength={4000}
          value={text}
          autoFocus
          placeholder="Текст сообщения"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); }}
        />
        <p className="cxs-social-hint">Уйдёт в личные сообщения {dialog.platformLabel} от имени {dialog.account || 'сообщества'}. Комментарий будет отмечен как отвеченный. Ctrl+Enter — отправить.</p>
      </div>
    </Sheet>
  );
}
