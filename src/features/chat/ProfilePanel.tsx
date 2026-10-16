import { useEffect, useMemo, useState, type ChangeEvent, type CSSProperties } from 'react';
import { lazyComponent } from '@/shared/ui/lazy';
import {
  Bell, BellOff, Camera, Check, Copy, Eye, Image as ImageIcon, Link as LinkIcon, MessageCircle, Search, UserMinus, UserPlus, Video, X,
} from 'lucide-react';
import type { User } from '@/shared/types/chat';
import LinkPreview from '@/features/chat/bubbles/LinkPreview';
import type { ViewerItem } from '@/shared/ui/ImageViewer';
import { thumbUrl } from '@/shared/ui/media';
import { copyImage } from './messageActions';
import { showToast } from '@/shared/ui/Toast';
import { getDepartmentColor, getDepartmentName } from '@/shared/lib/departmentColors';
import { Avatar } from '@/shared/ui/Avatar';
import { attachmentUrl, lastSeenText, plural } from '@/shared/ui/format';
import { askConfirm } from '@/shared/ui/overlay';
import { createChat, toggleMute } from './actions';
import { FileCard } from './timeline/content';
import { absolute, links as routeLinks } from '@/shared/navigation/routes';
import {
  chatTitle, displayName, isFavorites, isGroupChat, isMuted, isNotifications, loadChats, openChat, otherParticipant, setPanel,
  useChatStore,
} from './store';
import { Spinner } from '@/shared/ui/Spinner';

const ImageViewer = lazyComponent(() => import('@/shared/ui/ImageViewer'));

/**
 * Профиль в боковой панели — перенос ChatProfile.
 *
 * Фото во всю ширину; для группы — смена фото (создателю) и ссылка-приглашение;
 * для личного — должность и отдел. Действия: почта, задача, звук, архив,
 * удаление. Вкладки «Медиа / Файлы / Ссылки» — со всей истории чата
 * (/api/cloud/attachments), а не только с загруженной части ленты; ссылки ещё
 * и из загруженных сообщений, чтобы свежие появлялись сразу. «Участники» —
 * с добавлением и исключением для создателя группы.
 */

type Person = User & { position?: string; phone?: string; department?: string };
type Entry = { messageId: string; createdAt: string; url: string; filename?: string; fileType?: string; size?: number };
type Tab = 'media' | 'files' | 'links' | 'members';

/** Ячейка медиа: пока грузится — подложка, не загрузилась — значок вместо битой картинки. */
function MediaThumb({ src, onOpen }: { src: string; onOpen: () => void }) {
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  return (
    <button type="button" className="cxf-thumb" data-state={state} onClick={onOpen} aria-label="Открыть фото" disabled={state === 'error'}>
      {state !== 'error' && (
        <img src={src} alt="" loading="lazy" decoding="async" onLoad={() => setState('ok')} onError={() => setState('error')} />
      )}
      {state === 'error' && <ImageIcon size={20} aria-hidden="true" />}
    </button>
  );
}

export default function ProfilePanel({ chatId, onSearch, onJump, onPerson }: {
  chatId: string; onSearch: () => void; onJump: (messageId: string) => void; onPerson: (userId: string) => void;
}) {
  const chat = useChatStore((s) => s.chats[chatId]);
  const me = useChatStore((s) => s.me);
  const users = useChatStore((s) => s.users);
  const thread = useChatStore((s) => s.threads[chatId]);
  const uid = String(me?.id ?? '');

  const group = Boolean(chat && isGroupChat(chat));
  const favorites = Boolean(chat && isFavorites(chat));
  const notifications = Boolean(chat && isNotifications(chat));
  const other = chat && !group ? (otherParticipant(chat, me, users) as Person | undefined) : undefined;
  const title = chat ? chatTitle(chat, me, users) : 'Чат';
  const muted = Boolean(chat && isMuted(chat, uid));
  const canManage = group && String(chat?.creatorId ?? '') === uid;
  const photo = attachmentUrl(chat?.avatar || other?.avatar || '');

  const [tab, setTab] = useState<Tab>(group ? 'members' : 'media');
  const [media, setMedia] = useState<Entry[] | null>(null);
  const [files, setFiles] = useState<Entry[]>([]);
  const [serverLinks, setServerLinks] = useState<Entry[]>([]);
  const [query, setQuery] = useState('');
  const [viewer, setViewer] = useState<{ items: ViewerItem[]; start: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addQuery, setAddQuery] = useState('');
  const [memberQuery, setMemberQuery] = useState('');

  // Вложения всей истории чата — одним запросом.
  useEffect(() => {
    if (!uid) return undefined;
    let cancelled = false;
    setMedia(null);
    fetch(`/api/cloud/attachments?userId=${encodeURIComponent(uid)}&chatId=${encodeURIComponent(chatId)}&limit=500`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Entry[]) => {
        if (cancelled) return;
        const m: Entry[] = []; const f: Entry[] = []; const l: Entry[] = [];
        for (const r of Array.isArray(rows) ? rows : []) {
          if (r.fileType === 'link') l.push(r);
          else if (r.fileType === 'image' || r.fileType === 'video') m.push({ ...r, url: attachmentUrl(r.url) });
          else f.push({ ...r, url: attachmentUrl(r.url) });
        }
        setMedia(m); setFiles(f); setServerLinks(l);
      })
      .catch(() => { if (!cancelled) setMedia([]); });
    return () => { cancelled = true; };
  }, [chatId, uid]);

  // Ссылки: с сервера + из загруженных сообщений (свежие появляются сразу).
  const links = useMemo(() => {
    const re = /(https?:\/\/[^\s<>"']+)/g;
    const local: Entry[] = [];
    for (const id of thread?.ids || []) {
      const m = thread!.byId[id];
      for (const url of m.content?.match(re) || []) local.push({ messageId: String(m.id), createdAt: m.createdAt, url, fileType: 'link' });
    }
    const seen = new Set<string>();
    return [...serverLinks, ...local]
      .filter((e) => { const k = `${e.messageId}:${e.url}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [serverLinks, thread]);
  const q = query.trim().toLowerCase();
  const shownLinks = useMemo(() => (q ? links.filter((l) => l.url.toLowerCase().includes(q)) : links), [links, q]);
  const shownFiles = useMemo(() => (q ? files.filter((f) => String(f.filename || f.url).toLowerCase().includes(q)) : files), [files, q]);

  const members = useMemo(() => {
    const list = (chat?.participantIds || []).map((id) => users[String(id)]).filter(Boolean) as Person[];
    return list.sort((a, b) => Number(Boolean(b.isOnline)) - Number(Boolean(a.isOnline)) || displayName(a).localeCompare(displayName(b), 'ru'));
  }, [chat, users]);
  // Поиск по участникам: имя, логин, должность, отдел, почта.
  const shownMembers = useMemo(() => {
    const mq = memberQuery.trim().toLowerCase();
    if (!mq) return members;
    return members.filter((u) => [displayName(u), u.username, u.position, u.email, u.department && getDepartmentName(u.department)]
      .some((v) => String(v || '').toLowerCase().includes(mq)));
  }, [members, memberQuery]);
  const candidates = useMemo(() => {
    const inChat = new Set((chat?.participantIds || []).map(String));
    const q = addQuery.trim().toLowerCase();
    return Object.values(users)
      .filter((u) => !inChat.has(String(u.id)))
      .filter((u) => !q || displayName(u).toLowerCase().includes(q))
      .sort((a, b) => displayName(a).localeCompare(displayName(b), 'ru'));
  }, [chat, users, addQuery]);

  const writeTo = async (userId: string) => {
    setBusy(`write:${userId}`);
    const id = await createChat([userId]);
    setBusy(null);
    if (!id) { showToast('Чат не открылся — нет связи с сервером', 'error'); return; }
    const url = new URL(window.location.href);
    url.searchParams.set('chat', id);
    window.history.replaceState({ nxChat: id }, '', url);
    openChat(id);
  };

  const addMember = async (userId: string) => {
    setBusy(`add:${userId}`);
    try {
      const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/participants`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }),
      });
      if (!res.ok) throw new Error(String(res.status));
      await loadChats();
    } catch { showToast('Не удалось добавить участника', 'error'); } finally { setBusy(null); }
  };

  const removeMember = async (u: Person) => {
    const ok = await askConfirm({ title: `Исключить ${displayName(u)} из группы?`, confirm: 'Исключить', tone: 'danger' });
    if (!ok) return;
    setBusy(`rm:${u.id}`);
    try {
      const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/participants/${encodeURIComponent(String(u.id))}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(String(res.status));
      await loadChats();
    } catch { showToast('Не удалось исключить участника', 'error'); } finally { setBusy(null); }
  };

  const changePhoto = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy('photo');
    try {
      const form = new FormData();
      form.append('file', file);
      const up = await fetch('/api/upload', { method: 'POST', body: form });
      const data = await up.json();
      if (!up.ok || !data?.url) throw new Error('upload');
      const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ avatar: data.url }),
      });
      if (!res.ok) throw new Error(String(res.status));
      await loadChats();
    } catch { showToast('Фото группы не обновилось', 'error'); } finally { setBusy(null); }
  };

  const copyInvite = async () => {
    const url = absolute(routeLinks.chat(chatId));
    try { await navigator.clipboard.writeText(url); setCopied(true); window.setTimeout(() => setCopied(false), 1800); }
    catch { showToast('Не удалось скопировать ссылку', 'error'); }
  };

  const dept = other?.department;
  const deptColor = dept ? getDepartmentColor(dept) : undefined;
  const n = members.length;
  const subtitle = group ? `${n} ${plural(n, ['участник', 'участника', 'участников'])}` : other ? lastSeenText(other.lastSeen, other.isOnline) : '';
  const kind = favorites ? 'favorites' : notifications ? 'notifications' : undefined;

  const tabs: { id: Tab; label: string; count?: number }[] = [
    ...(group ? [{ id: 'members' as Tab, label: 'Участники', count: n }] : []),
    { id: 'media', label: 'Медиа', count: media?.length },
    { id: 'files', label: 'Файлы', count: files.length },
    { id: 'links', label: 'Ссылки', count: links.length },
  ];

  const jump = (id: string) => { onJump(id); if (window.matchMedia('(max-width: 640px)').matches) setPanel(null); };

  return (
    <aside className="cxp" aria-label="Профиль">
      <header className="cxp-head">
        <h2>{group ? 'Группа' : 'Профиль'}</h2>
        <button type="button" className="nx-icon-btn" onClick={() => setPanel(null)} aria-label="Закрыть панель"><X size={16} /></button>
      </header>
      <div className="cxp-body nx-scroll-y cxf">
        {/* Круглое фото по центру, как в «Контактах» iOS: не зависит от ширины
            панели — ничего не обрезается и не растягивается. Нажатие — фото целиком. */}
        <div className="cxf-photo" data-kind={kind}>
          <span className="cxf-photo-frame">
            {/* Тот же Avatar, что в шапке и списке: фото → рисованный аватар →
                инициалы. Раньше здесь грузилась картинка напрямую, и при битом фото
                профиль показывал инициалы, а шапка — рисованный аватар. */}
            <button
              type="button"
              className="cxf-photo-btn"
              disabled={!photo}
              onClick={() => { if (photo) setViewer({ items: [{ url: photo, author: title }], start: 0 }); }}
              aria-label={photo ? 'Открыть фото' : title}
            >
              <Avatar name={title} seed={chatId} src={chat?.avatar || other?.avatar} person={Boolean(chat && !group && !kind)} kind={kind} size={128} />
            </button>
            {canManage && (
              <label className="cxf-photo-edit" title="Сменить фото группы">
                {busy === 'photo' ? <Spinner size={16} /> : <Camera size={16} />}
                <span className="nx-sr">Сменить фото группы</span>
                <input type="file" accept="image/*" hidden disabled={busy === 'photo'} onChange={(e) => void changePhoto(e)} />
              </label>
            )}
          </span>
        </div>

        <div className="cxf-hero">
          <h3>{title}</h3>
          {subtitle && <p data-live={other?.isOnline ? 'true' : undefined}>{subtitle}</p>}
          {other?.position && <p>{other.position}</p>}
          {dept && deptColor && (
            <span className="cxf-dept" style={{ '--dept': deptColor } as CSSProperties}><i />{getDepartmentName(dept)}</span>
          )}
          {group && (
            <button type="button" className="nx-ghost cxf-invite" onClick={() => void copyInvite()} title="Скопировать ссылку-приглашение в группу">
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? 'Скопировано' : 'Ссылка-приглашение'}
            </button>
          )}
        </div>

        <div className="cxf-actions">
          <button type="button" className="cxf-action" onClick={onSearch}>
            <span className="cxf-action-icon"><Search size={18} /></span><span>Поиск</span>
          </button>
          {!favorites && (
            <button type="button" className="cxf-action" aria-pressed={muted} onClick={() => void toggleMute(chatId)} aria-label={muted ? 'Включить звук' : 'Выключить звук'}>
              <span className="cxf-action-icon">{muted ? <BellOff size={18} /> : <Bell size={18} />}</span><span>{muted ? 'Без звука' : 'Звук'}</span>
            </button>
          )}
        </div>

        {other && (other.email || other.phone) && (
          <dl className="cxf-info">
            {other.email && (<><dt>Почта</dt><dd><a href={`mailto:${other.email}`}>{other.email}</a></dd></>)}
            {other.phone && (<><dt>Телефон</dt><dd><a href={`tel:${other.phone}`}>{other.phone}</a></dd></>)}
          </dl>
        )}

        <div className="nx-segment cxf-tabs" role="tablist" aria-label="Содержимое чата">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>
              <span className="cxf-tab-label">{t.label}</span>
              {typeof t.count === 'number' && t.count > 0 ? <span className="cxf-tab-count">{t.count}</span> : null}
            </button>
          ))}
        </div>

        {tab === 'media' && (
          media === null ? (
            <div className="cxf-media" aria-busy="true" aria-label="Загружаю медиа">
              {Array.from({ length: 9 }, (_, i) => <div key={i} className="cxf-media-cell nx-skel" />)}
            </div>
          )
            : !media.length ? <div className="nx-state"><ImageIcon size={28} /><p>Фото и видео пока нет</p></div>
              : (
                <div className="cxf-media">
                  {media.map((m, i) => (
                    <div key={`${m.messageId}-${i}`} className="cxf-media-cell">
                      {m.fileType === 'image' ? (
                        <MediaThumb src={thumbUrl(m.url, 160)} onOpen={() => {
                          const imgs = media.filter((x) => x.fileType === 'image');
                          setViewer({
                            items: imgs.map((x) => ({ url: x.url, messageId: x.messageId, name: x.filename, date: new Date(x.createdAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) })),
                            start: Math.max(0, imgs.findIndex((x) => x.url === m.url)),
                          });
                        }} />
                      ) : (
                        <button type="button" className="cxf-thumb" data-state="ok" onClick={() => jump(m.messageId)} aria-label="Видео — перейти к сообщению"><Video size={22} /></button>
                      )}
                      <button type="button" className="cxf-jump" onClick={() => jump(m.messageId)} aria-label="Перейти к сообщению"><Eye size={13} /></button>
                    </div>
                  ))}
                </div>
              )
        )}

        {(tab === 'files' || tab === 'links') && (
          <label className="nx-field cxf-link-search" data-variant="filter">
            <Search size={14} aria-hidden="true" />
            <span className="nx-sr">{tab === 'files' ? 'Поиск по файлам' : 'Поиск по ссылкам'}</span>
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tab === 'files' ? 'Поиск по файлам' : 'Поиск по ссылкам'} />
          </label>
        )}

        {tab === 'files' && (
          !shownFiles.length ? <div className="nx-state"><p>{q ? 'Ничего не найдено' : 'Файлов пока нет'}</p></div> : (
            <div className="cxf-list">
              {shownFiles.map((f, i) => (
                <div key={`${f.messageId}-${i}`} className="cxf-file">
                  <FileCard att={{ url: f.url, name: f.filename, size: f.size }} />
                  <button type="button" className="nx-icon-btn" onClick={() => jump(f.messageId)} aria-label="Перейти к сообщению"><Eye size={16} /></button>
                </div>
              ))}
            </div>
          )
        )}

        {tab === 'links' && (
          <>
            {!shownLinks.length ? <div className="nx-state"><LinkIcon size={28} /><p>{q ? 'Ничего не найдено' : 'Ссылок пока нет'}</p></div> : (
              <div className="cxf-list">
                {shownLinks.map((l, i) => (
                  <div key={`${l.messageId}-${i}`} className="cxf-link">
                    <div className="cxf-link-row">
                      <a href={l.url} target="_blank" rel="noopener noreferrer"><LinkIcon size={16} /><span>{l.url}</span></a>
                      <button type="button" className="nx-icon-btn" onClick={() => jump(l.messageId)} aria-label="Перейти к сообщению"><Eye size={16} /></button>
                    </div>
                    <span className="cxf-link-date">{new Date(l.createdAt).toLocaleDateString('ru-RU')}</span>
                    <LinkPreview url={l.url} />
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {tab === 'members' && group && (
          <section className="cxf-members" aria-label="Участники">
            {members.length > 3 && (
              <label className="nx-field cxf-member-search" data-variant="filter">
                <Search size={14} aria-hidden="true" />
                <span className="nx-sr">Поиск по участникам</span>
                <input
                  type="search"
                  value={memberQuery}
                  onChange={(e) => setMemberQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape') setMemberQuery(''); }}
                  placeholder={`Поиск среди ${n} ${plural(n, ['участника', 'участников', 'участников'])}`}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
            )}
            {memberQuery.trim() && !shownMembers.length && <p className="nx-hint cxf-member-empty">Никого не нашёл — попробуйте имя, должность или отдел.</p>}
            {canManage && !memberQuery.trim() && (
              <button type="button" className="cxf-member cxf-add" onClick={() => setAdding((v) => !v)} aria-expanded={adding}>
                <span className="cxf-add-icon"><UserPlus size={16} /></span>
                <span className="nx-pick-text"><span>Добавить участника</span></span>
              </button>
            )}
            {adding && (
              <div className="cxf-add-box">
                <label className="nx-field" data-variant="filter">
                  <Search size={14} aria-hidden="true" />
                  <span className="nx-sr">Кого добавить</span>
                  <input type="search" value={addQuery} onChange={(e) => setAddQuery(e.target.value)} placeholder="Кого добавить" autoFocus />
                </label>
                <div className="cxf-add-list nx-scroll-y">
                  {candidates.length === 0 && <p className="nx-hint">Все уже в группе.</p>}
                  {candidates.map((u) => (
                    <button key={u.id} type="button" className="nx-pick" disabled={busy === `add:${u.id}`} onClick={() => void addMember(String(u.id))}>
                      <Avatar name={displayName(u)} seed={String(u.id)} src={u.avatar} person size={28} />
                      <span className="nx-pick-text"><span>{displayName(u)}</span></span>
                      {busy === `add:${u.id}` ? <Spinner size={14} /> : <UserPlus size={14} />}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {shownMembers.map((u) => {
              const id = String(u.id);
              const color = u.department ? getDepartmentColor(u.department) : undefined;
              return (
                <div key={id} className="cxf-member">
                  <button type="button" className="cxf-member-open" onClick={() => onPerson(id)} aria-label={`Профиль: ${displayName(u)}`}>
                    <Avatar name={displayName(u)} seed={id} src={u.avatar} person online={Boolean(u.isOnline)} size={34} />
                    <span className="nx-pick-text">
                      <span>{displayName(u)}{id === uid ? ' (вы)' : ''}</span>
                      {u.department && color
                        ? <span className="cxf-dept-line" style={{ '--dept': color } as CSSProperties}><i />{getDepartmentName(u.department)}</span>
                        : <span>{u.position || lastSeenText(u.lastSeen, u.isOnline)}</span>}
                    </span>
                  </button>
                  {id !== uid && (
                    <button type="button" className="nx-icon-btn" disabled={busy === `write:${id}`} onClick={() => void writeTo(id)} aria-label={`Написать ${displayName(u)}`}>
                      {busy === `write:${id}` ? <Spinner size={16} /> : <MessageCircle size={16} />}
                    </button>
                  )}
                  {canManage && id !== uid && (
                    <button type="button" className="nx-icon-btn cxf-remove" disabled={busy === `rm:${id}`} onClick={() => void removeMember(u)} aria-label={`Исключить ${displayName(u)}`}>
                      <UserMinus size={16} />
                    </button>
                  )}
                </div>
              );
            })}
          </section>
        )}
      </div>
      {viewer && <ImageViewer items={viewer.items} start={viewer.start} onClose={() => setViewer(null)} onJump={jump} onCopy={(u) => void copyImage(u)} />}
    </aside>
  );
}
