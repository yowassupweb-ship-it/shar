import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { lazyComponent } from '@/shared/ui/lazy';
import { AlertCircle, ChevronLeft, ChevronRight, Download, MessageSquareText, RotateCw, Search, PenLine } from 'lucide-react';
import type { ViewerItem } from '@/shared/ui/ImageViewer';
import { SearchField } from '@/shared/ui/SearchField';
import { Avatar } from '@/shared/ui/Avatar';
import { thumbUrl } from '@/shared/ui/media';
import { CHAT_SOURCE, fileUrl, fmtBytes, fmtDate, kindOf, type ChatAttachment, type ChatFolder, type FilesSource } from './api';
import { FileGlyph } from './FileGlyph';
import { downloadOnClick } from '@/shared/platform/download';
import { canOpenInEditor, openInEditor, viewKindOf, type FileRef } from '@/features/workspace';
import { DocOverlay } from './DocOverlay';

const ImageViewer = lazyComponent(() => import('@/shared/ui/ImageViewer'));

/**
 * «Из чатов»: всё, что присылали в переписках. Без выбранного чата — список
 * чатов с числом вложений; внутри — фото сеткой, остальное списком. Из фото
 * можно вернуться к сообщению в чате.
 */

type Filter = 'all' | 'media' | 'docs';

/** Заголовок дня: «Сегодня», «Вчера», «2 ноября» (с годом, если не текущий). key — «ГГГГ-ММ-ДД» в местном времени. */
function dayTitle(key: string): string {
  const m = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return 'Без даты';
  const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const diff = Math.round((start.getTime() - day.getTime()) / 86400000);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Вчера';
  return day.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', ...(day.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}

export function ChatList({ lead, onOpen, onSwitch, source = CHAT_SOURCE }: { lead?: ReactNode; onOpen: (c: ChatFolder) => void; /** Переключить на «По дням» (вкладка «Агенты»). */ onSwitch?: () => void; source?: FilesSource }) {
  const [list, setList] = useState(source.cachedFolders);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>(() => (source.cachedFolders() ? 'ready' : 'loading'));
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    try { setList(await source.loadFolders()); setPhase('ready'); } catch { setPhase((p) => (p === 'ready' ? p : 'error')); }
  }, [source]);
  useEffect(() => {
    let alive = true;
    source.loadFolders().then((l) => { if (alive) { setList(l); setPhase('ready'); } }).catch(() => { if (alive) setPhase((p) => (p === 'ready' ? p : 'error')); });
    return () => { alive = false; };
  }, [source]);

  const q = query.trim().toLowerCase();
  const shown = (list || []).filter((c) => !q || c.chatName.toLowerCase().includes(q));

  return (
    <section className="nf-view">
      <header className="nf-bar">
        <div className="nf-left">
          <span className="nf-crumbs" />
          {lead}
        </div>
        <SearchField className="nf-search" value={query} onChange={setQuery} placeholder="Найти чат" />
        <div className="nf-tools">
          {onSwitch && (
            <div className="nx-segment" role="group" aria-label="Порядок">
              <button type="button" aria-pressed={false} onClick={onSwitch}>По дням</button>
              <button type="button" aria-pressed>По чатам</button>
            </div>
          )}
        </div>
      </header>
      <div className="nf-scroll nx-scroll-y">
        {!list && phase === 'loading' ? (
          <div aria-busy="true" aria-label="Загружаю чаты">
            {Array.from({ length: 8 }, (_, i) => <div key={i} className="nx-skel-row"><span className="nx-skel nx-skel-avatar" /><span className="nx-skel nx-skel-line" /></div>)}
          </div>
        ) : !list && phase === 'error' ? (
          <div className="nx-state" data-tone="danger" role="alert">
            <AlertCircle size={28} aria-hidden="true" />
            <h2>Не загрузил список</h2>
            <p>Сервер не ответил. Проверьте связь и повторите.</p>
            <button type="button" className="nx-ghost" onClick={() => void load()}><RotateCw size={14} aria-hidden="true" /> Повторить</button>
          </div>
        ) : !shown.length ? (
          <div className="nx-state">
            <MessageSquareText size={28} aria-hidden="true" />
            <h2>{q ? 'Такого чата нет' : source.emptyTitle}</h2>
            <p>{q ? 'Попробуйте другое название.' : source.emptyText}</p>
          </div>
        ) : (
          <div className="nf-rows">
            {shown.map((c) => (
              <button key={c.chatId} type="button" className="nf-row" onClick={() => onOpen(c)}>
                {source.icon ? <span className="nf-source-icon" aria-hidden="true">{source.icon}</span> : <Avatar name={c.chatName} seed={c.chatId} src={c.chatAvatar || undefined} person={!c.isGroup} size={36} />}
                <span className="nf-text">
                  <span className="nf-name">{c.chatName}</span>
                  <span className="nf-meta">{c.count} · {fmtDate(c.lastAt)}</span>
                </span>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export function ChatFiles({ lead, chat, onBack, onSwitch, days = false, source = CHAT_SOURCE }: {
  lead?: ReactNode; chat: { chatId: string; chatName: string }; onBack: () => void; source?: FilesSource;
  /** По дням: файлы всех чатов сразу, день за днём, свежие выше; onSwitch — перейти к списку чатов. */
  days?: boolean; onSwitch?: () => void;
}) {
  const [list, setList] = useState(() => source.cachedFiles(chat.chatId));
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>(() => (source.cachedFiles(chat.chatId) ? 'ready' : 'loading'));
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [viewer, setViewer] = useState<{ items: ViewerItem[]; start: number } | null>(null);
  /** Документ во встроенном просмотре (PDF, Word, Excel, CSV, текст, HTML). */
  const [doc, setDoc] = useState<FileRef | null>(null);

  const load = useCallback(async () => {
    try { setList(await source.loadFiles(chat.chatId)); setPhase('ready'); } catch { setPhase((p) => (p === 'ready' ? p : 'error')); }
  }, [chat.chatId, source]);
  useEffect(() => {
    let alive = true;
    source.loadFiles(chat.chatId).then((l) => { if (alive) { setList(l); setPhase('ready'); } }).catch(() => { if (alive) setPhase((p) => (p === 'ready' ? p : 'error')); });
    return () => { alive = false; };
  }, [chat.chatId, source]);

  const q = query.trim().toLowerCase();
  const { media, docs } = useMemo(() => {
    const all = (list || []).filter((a) => !q || a.filename.toLowerCase().includes(q) || a.authorName.toLowerCase().includes(q));
    const isMedia = (a: ChatAttachment) => { const k = kindOf(a.filename, a.fileType, a.mimeType); return k === 'image' || k === 'video'; };
    return { media: filter === 'docs' ? [] : all.filter(isMedia), docs: filter === 'media' ? [] : all.filter((a) => !isMedia(a)) };
  }, [list, q, filter]);
  const images = media.filter((a) => kindOf(a.filename, a.fileType, a.mimeType) === 'image');

  const openMedia = (a: ChatAttachment) => {
    if (kindOf(a.filename, a.fileType, a.mimeType) !== 'image') { window.open(fileUrl(a.url), '_blank', 'noopener'); return; }
    setViewer({
      items: images.map((x) => ({ url: fileUrl(x.url), name: x.filename, author: x.authorName, date: fmtDate(x.createdAt), messageId: x.messageId })),
      start: Math.max(0, images.indexOf(a)),
    });
  };

  // Пока открываем сам чат; прокрутку к сообщению добавим, когда чат научится ?msg=.
  const jump = (a?: ChatAttachment) => {
    source.openChat(a?.chatId || chat.chatId);
  };

  // «По дням»: день за днём, внутри — как обычно (фото сеткой, документы списком), свежее выше (сервер отдаёт по убыванию).
  const dayGroups = useMemo(() => {
    if (!days) return [];
    const groups = new Map<string, { media: ChatAttachment[]; docs: ChatAttachment[] }>();
    const put = (a: ChatAttachment, kind: 'media' | 'docs') => {
      const d = new Date(a.createdAt);
      const key = Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const group = groups.get(key) ?? { media: [], docs: [] };
      group[kind].push(a);
      groups.set(key, group);
    };
    media.forEach((a) => put(a, 'media'));
    docs.forEach((a) => put(a, 'docs'));
    return [...groups.entries()].sort((x, y) => y[0].localeCompare(x[0]));
  }, [days, media, docs]);

  const clock = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); };
  const mediaSection = (items: ChatAttachment[], heading: boolean) => (items.length > 0 && (
    <section aria-label="Фото и видео">
      {heading && <h3 className="nf-group">Фото и видео <span>{items.length}</span></h3>}
      <div className="nf-media">
        {items.map((a) => (
          <button key={a.messageId + a.url} type="button" className="nf-tile" onClick={() => openMedia(a)} aria-label={a.filename} title={`${a.filename} — ${a.authorName}${days ? ` · ${a.chatName} · ${clock(a.createdAt)}` : ''}`}>
            {kindOf(a.filename, a.fileType, a.mimeType) === 'image'
              ? <img src={thumbUrl(fileUrl(a.url), 200)} alt="" loading="lazy" decoding="async" draggable={false} />
              : <FileGlyph name={a.filename} kind="video" size="lg" />}
          </button>
        ))}
      </div>
    </section>
  ));
  const docsSection = (items: ChatAttachment[], heading: boolean) => (items.length > 0 && (
    <section aria-label="Документы">
      {heading && <h3 className="nf-group">Документы <span>{items.length}</span></h3>}
      <div className="nf-rows">
        {items.map((a) => (
          <div key={a.messageId + a.url} className="nf-row">
            <FileGlyph name={a.filename} kind={kindOf(a.filename, a.fileType, a.mimeType)} size="sm" />
            <a
              className="nf-text"
              href={fileUrl(a.url)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => {
                // Документ — во встроенном просмотре, остальное — скачать через приложение (не внешний браузер).
                if (viewKindOf(a.filename)) { e.preventDefault(); setDoc({ url: fileUrl(a.url), name: a.filename, size: a.size ?? undefined }); return; }
                downloadOnClick(fileUrl(a.url), a.filename)(e);
              }}
            >
              <span className="nf-name">{a.filename}</span>
              <span className="nf-meta">{(days ? [a.authorName, a.chatName, fmtBytes(a.size), clock(a.createdAt)] : [a.authorName, fmtBytes(a.size), fmtDate(a.createdAt)]).filter(Boolean).join(' · ')}</span>
            </a>
            <button type="button" className="nx-icon-btn" onClick={() => jump(a)} aria-label="Показать в чате" title="Показать в чате"><MessageSquareText size={16} /></button>
            {canOpenInEditor(a.filename) && (
              <button type="button" className="nx-icon-btn" onClick={() => void openInEditor({ url: fileUrl(a.url), name: a.filename, size: a.size ?? undefined })} aria-label={`Открыть в Шаре: ${a.filename}`} title="Открыть в Шаре — копия, исходный файл не изменится"><PenLine size={16} /></button>
            )}
            <a className="nx-icon-btn" href={fileUrl(a.url)} download={a.filename} onClick={downloadOnClick(fileUrl(a.url), a.filename)} aria-label="Скачать" title="Скачать"><Download size={16} /></a>
          </div>
        ))}
      </div>
    </section>
  ));

  return (
    <section className="nf-view">
      <header className="nf-bar">
        <div className="nf-left">
          <nav className="nf-crumbs" aria-label="Путь">
            {days ? <span className="nf-crumb" aria-current="page">{chat.chatName}</span> : (
              <>
                <button type="button" className="nf-crumb nf-crumb-back" onClick={onBack} aria-label="Все чаты"><ChevronLeft size={16} aria-hidden="true" /></button>
                <span className="nf-crumb" aria-current="page">{chat.chatName}</span>
              </>
            )}
          </nav>
          {lead}
        </div>
        <SearchField className="nf-search" value={query} onChange={setQuery} placeholder="Имя файла или автор" label="Поиск по файлам" />
        <div className="nf-tools">
          {days && onSwitch && (
            <div className="nx-segment" role="group" aria-label="Порядок">
              <button type="button" aria-pressed>По дням</button>
              <button type="button" aria-pressed={false} onClick={onSwitch}>По чатам</button>
            </div>
          )}
          <div className="nx-segment" role="group" aria-label="Тип">
            {([['all', 'Все'], ['media', 'Фото и видео'], ['docs', 'Документы']] as [Filter, string][]).map(([id, label]) => (
              <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>
            ))}
          </div>
        </div>
      </header>
      <div className="nf-scroll nx-scroll-y">
        {!list && phase === 'loading' ? (
          <div className="nf-items nf-grid nf-media" aria-busy="true">
            {Array.from({ length: 12 }, (_, i) => <span key={i} className="nx-skel nf-skel-thumb" />)}
          </div>
        ) : !list && phase === 'error' ? (
          <div className="nx-state" data-tone="danger" role="alert">
            <AlertCircle size={28} aria-hidden="true" />
            <h2>Не загрузил файлы чата</h2>
            <p>Сервер не ответил. Проверьте связь и повторите.</p>
            <button type="button" className="nx-ghost" onClick={() => void load()}><RotateCw size={14} aria-hidden="true" /> Повторить</button>
          </div>
        ) : !media.length && !docs.length ? (
          <div className="nx-state">
            <Search size={28} aria-hidden="true" />
            <h2>{q || filter !== 'all' ? 'Ничего не нашёл' : 'Файлов нет'}</h2>
            <p>{q || filter !== 'all' ? 'Попробуйте другой запрос или снимите фильтр.' : 'В этом чате ещё ничего не присылали.'}</p>
          </div>
        ) : (
          <>
            {!days && mediaSection(media, true)}
            {!days && docsSection(docs, true)}
            {days && dayGroups.map(([key, g]) => (
              <section key={key || 'unknown'} className="nf-day" aria-label={dayTitle(key)}>
                <h3 className="nf-group nf-day-title">{dayTitle(key)} <span>{g.media.length + g.docs.length}</span></h3>
                {mediaSection(g.media, false)}
                {docsSection(g.docs, false)}
              </section>
            ))}
          </>
        )}
      </div>
      {viewer && <ImageViewer items={viewer.items} start={viewer.start} onClose={() => setViewer(null)} onJump={(messageId) => { setViewer(null); jump(images.find((x) => x.messageId === messageId)); }} />}
      {doc && <DocOverlay file={doc} onClose={() => setDoc(null)} />}
    </section>
  );
}
