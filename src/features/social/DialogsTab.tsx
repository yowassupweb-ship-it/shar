import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { AlertCircle, ArrowLeft, ArrowUpRight, CornerDownRight, MessageSquare, MessagesSquare, Paperclip, Send, X } from 'lucide-react';
import { uploadFileWithProgress } from '@/shared/api/uploadFile';
import { links } from '@/shared/navigation/routes';
import { realtime } from '@/shared/realtime/realtime';
import { SearchField } from '@/shared/ui/SearchField';
import { Spinner } from '@/shared/ui/Spinner';
import { showToast } from '@/shared/ui/Toast';
import { listDialogs, loadDialog, sendToDialog, type DialogMessage, type OutFile, type Platform, type SocialDialog } from './api';
import { PlatformMark } from './PlatformMark';

const NARROW = '(max-width: 760px)';
const subscribeNarrow = (cb: () => void) => {
  const mq = window.matchMedia(NARROW);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
};

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
            <PlatformMark platform={d.platform} size={34} />
            <span className="nsd-row-text">
              <span className="nsd-row-top"><b>{d.title || d.clientName}</b><time>{when(d.lastAt)}</time></span>
              <span className="nsd-row-src">{mode === 'comments' ? (d.context ? `Пост: ${d.context}` : d.sourceTitle) : `${KIND_LABEL[d.kind]}${d.kind === 'group' && d.sourceTitle && d.sourceTitle !== d.title ? ` · ${d.sourceTitle}` : ''}`}</span>
              <span className="nsd-row-last">{d.lastDir === 'out' && <span className="nsd-you">Вы: </span>}{d.lastText}</span>
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
  const input = useRef<HTMLTextAreaElement>(null);
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
  // Поле растёт под текст, до шести строк.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const pick = (list: FileList | null) => {
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

  const send = () => {
    const body = text.trim();
    const ready = files.filter((f) => f.file).map((f) => f.file!);
    if ((!body && !ready.length) || busy || uploading) return;
    setBusy(true);
    sendToDialog(id, body, ready)
      .then(() => { setText(''); setFiles([]); onSent(); return loadDialog(id).then(setData); })
      .catch((e: Error) => showToast(e.message, 'error'))
      .finally(() => setBusy(false));
  };

  if (error) return <section className="nsd-thread"><div className="nx-state" data-tone="danger" role="alert"><AlertCircle size={24} aria-hidden="true" /><p>{error}</p></div></section>;
  if (!data) return <section className="nsd-thread"><div className="nx-state"><Spinner size={22} label="Открываю диалог" /></div></section>;
  const d = data.dialog;
  const group = d.kind === 'group';
  // Файлы — в личные и беседы: в комментарии ВКонтакте сообщество из Шара вложения не прикрепит.
  const canAttach = d.kind !== 'comments' && (d.platform === 'vk' || d.platform === 'max');
  return (
    <section className="nsd-thread" aria-label={`Диалог: ${d.title}`}>
      <header className="nsd-head">
        {onBack && <button type="button" className="nx-icon-btn" onClick={onBack} aria-label="К списку диалогов"><ArrowLeft size={18} /></button>}
        <PlatformMark platform={d.platform} size={36} />
        <div className="nsd-head-text">
          <b>{d.title}{d.clientUsername && d.kind !== 'group' ? <span> · @{d.clientUsername}</span> : null}</b>
          <span>{d.platformLabel} · {KIND_LABEL[d.kind]}{d.kind !== 'private' && d.kind !== 'business' && d.sourceTitle ? ` · ${d.sourceTitle}` : ''}{d.account && !d.sourceTitle.startsWith(d.account) ? ` · ${d.account}` : ''}</span>
        </div>
        <span className="nsd-head-links">
          {d.link && <a href={d.link} target="_blank" rel="noopener noreferrer">Открыть в {d.platformLabel}<ArrowUpRight size={13} aria-hidden="true" /></a>}
          {d.chatId && <button type="button" onClick={() => navigate(links.chat(d.chatId!))}><MessageSquare size={13} aria-hidden="true" /> Чат</button>}
        </span>
      </header>
      {d.kind === 'comments' && d.context && <div className="nsd-context"><CornerDownRight size={13} aria-hidden="true" /><span>Пост: {d.context}</span></div>}
      <div className="nsd-messages nx-scroll-y" ref={scroller}>
        {data.messages.map((m: DialogMessage, i) => {
          const prev = data.messages[i - 1];
          const showName = m.direction === 'out' ? prev?.direction !== 'out' || prev?.authorUserId !== m.authorUserId : group && (prev?.direction !== 'in' || prev?.authorName !== m.authorName);
          return (
            <div key={m.id} className="nsd-msg" data-dir={m.direction}>
              {showName && <span className="nsd-msg-name">{m.direction === 'out' ? m.authorName || 'Сотрудник' : m.authorName}</span>}
              <div className="nsd-bubble">
                {m.text && <span className="nsd-msg-text">{m.text}</span>}
                {m.media.length > 0 && <span className="nsd-msg-media">{m.media.join(' · ')}{m.link ? <> — <a href={m.link} target="_blank" rel="noopener noreferrer">открыть</a></> : null}</span>}
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
        <div className="nsd-composer">
          {canAttach && (
            <>
              <input ref={picker} type="file" multiple hidden onChange={(e) => pick(e.target.files)} />
              <button type="button" className="nx-icon-btn" onClick={() => picker.current?.click()} disabled={files.length >= 10}
                aria-label="Прикрепить фото или файл" title="Фото или файл — до 10 за раз"><Paperclip size={18} /></button>
            </>
          )}
          <textarea
            ref={input}
            className="nx-field"
            rows={1}
            maxLength={4000}
            value={text}
            placeholder={`Ответ клиенту в ${d.platformLabel}`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
          />
          <button type="button" className="nx-primary-round" onClick={send} disabled={busy || uploading || (!text.trim() && !files.some((f) => f.file))} aria-label="Отправить клиенту"><Send size={16} /></button>
        </div>
        </div>
      ) : (
        <p className="nsd-noreply">Сюда {d.platformLabel} не даёт ответить из Шара — ответьте на сайте по ссылке «Открыть в {d.platformLabel}».</p>
      )}
    </section>
  );
}
