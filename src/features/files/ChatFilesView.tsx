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

export function ChatList({ lead, onOpen, source = CHAT_SOURCE }: { lead?: ReactNode; onOpen: (c: ChatFolder) => void; source?: FilesSource }) {
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
          {lead}
          <span className="nf-crumbs" />
        </div>
        <SearchField className="nf-search" value={query} onChange={setQuery} placeholder="Найти чат" />
        <div className="nf-tools" />
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

export function ChatFiles({ lead, chat, onBack, source = CHAT_SOURCE }: { lead?: ReactNode; chat: { chatId: string; chatName: string }; onBack: () => void; source?: FilesSource }) {
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
  const jump = () => {
    source.openChat(chat.chatId);
  };

  return (
    <section className="nf-view">
      <header className="nf-bar">
        <div className="nf-left">
          {lead}
          <nav className="nf-crumbs" aria-label="Путь">
            <button type="button" className="nf-crumb nf-crumb-back" onClick={onBack} aria-label="Все чаты"><ChevronLeft size={16} aria-hidden="true" /></button>
            <span className="nf-crumb" aria-current="page">{chat.chatName}</span>
          </nav>
        </div>
        <SearchField className="nf-search" value={query} onChange={setQuery} placeholder="Имя файла или автор" label="Поиск по файлам" />
        <div className="nf-tools">
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
            {media.length > 0 && (
              <section aria-label="Фото и видео">
                <h3 className="nf-group">Фото и видео <span>{media.length}</span></h3>
                <div className="nf-media">
                  {media.map((a) => (
                    <button key={a.messageId + a.url} type="button" className="nf-tile" onClick={() => openMedia(a)} aria-label={a.filename} title={`${a.filename} — ${a.authorName}`}>
                      {kindOf(a.filename, a.fileType, a.mimeType) === 'image'
                        ? <img src={thumbUrl(fileUrl(a.url), 200)} alt="" loading="lazy" decoding="async" draggable={false} />
                        : <FileGlyph name={a.filename} kind="video" size="lg" />}
                    </button>
                  ))}
                </div>
              </section>
            )}
            {docs.length > 0 && (
              <section aria-label="Документы">
                <h3 className="nf-group">Документы <span>{docs.length}</span></h3>
                <div className="nf-rows">
                  {docs.map((a) => (
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
                        <span className="nf-meta">{[a.authorName, fmtBytes(a.size), fmtDate(a.createdAt)].filter(Boolean).join(' · ')}</span>
                      </a>
                      <button type="button" className="nx-icon-btn" onClick={jump} aria-label="Показать в чате" title="Показать в чате"><MessageSquareText size={16} /></button>
                      {canOpenInEditor(a.filename) && (
                        <button type="button" className="nx-icon-btn" onClick={() => void openInEditor({ url: fileUrl(a.url), name: a.filename, size: a.size ?? undefined })} aria-label={`Открыть в Шаре: ${a.filename}`} title="Открыть в Шаре — копия, исходный файл не изменится"><PenLine size={16} /></button>
                      )}
                      <a className="nx-icon-btn" href={fileUrl(a.url)} download={a.filename} onClick={downloadOnClick(fileUrl(a.url), a.filename)} aria-label="Скачать" title="Скачать"><Download size={16} /></a>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
      {viewer && <ImageViewer items={viewer.items} start={viewer.start} onClose={() => setViewer(null)} onJump={() => { setViewer(null); jump(); }} />}
      {doc && <DocOverlay file={doc} onClose={() => setDoc(null)} />}
    </section>
  );
}
