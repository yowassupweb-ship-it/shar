import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Eye, Folder, Link2, Pencil, Search } from 'lucide-react';
import { showToast } from '@/shared/ui/Toast';
import { chatTitle, displayName, isFavorites, isGroupChat, isNotifications, useChatStore } from '@/features/chat';
import { Avatar } from '@/shared/ui/Avatar';
import { Sheet } from '@/shared/ui/overlay';
import {
  loadFolder, moveFile, moveFolder, myId, saveAccess, shareToChat, type CloudFile, type CloudFolder,
} from './api';
import { Spinner } from '@/shared/ui/Spinner';
import { useInheritedAccess } from './inherited';

/**
 * Листы раздела «Файлы»: переместить, доступ, отправить в чат. Люди и чаты —
 * из общего стора (NxRoot держит его между разделами), без своих запросов.
 */

// ── Переместить ─────────────────────────────────────────────────────────────

export function MoveSheet({ item, kind, onClose, onDone }: {
  item: CloudFile | CloudFolder; kind: 'file' | 'folder'; onClose: () => void; onDone: () => void;
}) {
  const [trail, setTrail] = useState<CloudFolder[]>([]);
  const [loaded, setLoaded] = useState<{ at: string | null; folders: CloudFolder[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const here = trail[trail.length - 1]?.id ?? null;
  const from = kind === 'file' ? (item as CloudFile).folderId : (item as CloudFolder).parentId;

  useEffect(() => {
    let alive = true;
    loadFolder(here)
      // Папку нельзя положить саму в себя — её и не показываем.
      .then((d) => { if (alive) setLoaded({ at: here, folders: d.folders.filter((f) => f.id !== item.id) }); })
      .catch(() => { if (alive) setLoaded({ at: here, folders: [] }); });
    return () => { alive = false; };
  }, [here, item.id]);

  const folders = loaded && loaded.at === here ? loaded.folders : null;

  const move = async () => {
    setBusy(true);
    try {
      if (kind === 'file') await moveFile(item.id, here);
      else await moveFolder(item.id, here);
      showToast(`Перемещено в «${trail[trail.length - 1]?.name || 'Мои файлы'}»`, 'success');
      onDone();
    } catch {
      showToast('Не переместил — нет связи с сервером. Попробуйте ещё раз.', 'error');
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={`Переместить «${item.name}»`}
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          <button type="button" className="nx-ghost" onClick={onClose}>Отмена</button>
          <button type="button" className="nx-primary" disabled={busy || here === from} onClick={() => void move()}>
            {busy ? 'Перемещаю' : 'Переместить сюда'}
          </button>
        </>
      )}
    >
      <div className="nfs-trail">
        <button type="button" className="nx-icon-btn" disabled={!trail.length} onClick={() => setTrail((t) => t.slice(0, -1))} aria-label="Назад">
          <ChevronLeft size={16} />
        </button>
        <span>{trail.map((f) => f.name).join(' / ') || 'Мои файлы'}</span>
      </div>
      {folders === null ? (
        <div className="nx-state" aria-busy="true"><Spinner size={20} /></div>
      ) : !folders.length ? (
        <p className="nx-hint">Здесь нет вложенных папок — можно переместить прямо сюда.</p>
      ) : folders.map((f) => (
        <button key={f.id} type="button" className="nx-pick" onClick={() => setTrail((t) => [...t, f])}>
          <Folder size={18} aria-hidden="true" style={f.color ? { color: f.color } : undefined} />
          <span className="nx-pick-text"><span>{f.name}</span></span>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      ))}
    </Sheet>
  );
}

// ── Доступ ──────────────────────────────────────────────────────────────────

export function AccessSheet({ item, kind, onClose, onDone }: {
  item: CloudFile | CloudFolder; kind: 'file' | 'folder'; onClose: () => void; onDone: () => void;
}) {
  const users = useChatStore((s) => s.users);
  const me = myId();
  const inherited = useInheritedAccess(kind === 'file' ? (item as CloudFile).folderId : (item as CloudFolder).parentId);
  const [view, setView] = useState<Set<string>>(() => new Set((item.sharedWith || []).map(String)));
  const [edit, setEdit] = useState<Set<string>>(() => new Set((item.editAccess || []).map(String)));
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  const people = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(users)
      .filter((u) => String(u.id) !== me && String(u.id) !== String(item.ownerId))
      .filter((u) => !q || displayName(u).toLowerCase().includes(q))
      // Сверху все, у кого доступ есть — свой или от папки, — потом остальные; внутри групп по алфавиту.
      .sort((a, b) => Number(view.has(String(b.id)) || String(b.id) in inherited.view) - Number(view.has(String(a.id)) || String(a.id) in inherited.view)
        || displayName(a).localeCompare(displayName(b), 'ru'));
  }, [users, query, me, item.ownerId, view, inherited]);

  // Три шага по нажатию: нет доступа → просмотр → редактирование → нет.
  const cycle = (id: string) => {
    if (id in inherited.view) return; // доступ от папки снимается в самой папке
    const v = new Set(view);
    const e = new Set(edit);
    if (!v.has(id)) v.add(id);
    else if (!e.has(id)) e.add(id);
    else { v.delete(id); e.delete(id); }
    setView(v);
    setEdit(e);
  };

  const save = async () => {
    setBusy(true);
    try {
      await saveAccess(kind, item.id, Array.from(view), Array.from(edit).filter((id) => view.has(id)));
      showToast(view.size ? `Доступ открыт: ${view.size}` : 'Доступ закрыт', 'success');
      onDone();
    } catch {
      showToast('Доступ не сохранился — нет связи с сервером.', 'error');
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={`Доступ к «${item.name}»`}
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          <button type="button" className="nx-ghost" onClick={onClose}>Отмена</button>
          <button type="button" className="nx-primary" disabled={busy} onClick={() => void save()}>{busy ? 'Сохраняю' : 'Сохранить'}</button>
        </>
      )}
    >
      <p className="nx-hint">Нажмите на человека: просмотр → редактирование → без доступа.</p>
      <label className="nx-field" data-variant="filter">
        <Search size={14} aria-hidden="true" />
        <span className="nx-sr">Найти сотрудника</span>
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти сотрудника" autoComplete="off" />
      </label>
      <div className="nfs-people">
        {people.map((u) => {
          const id = String(u.id);
          const via = inherited.view[id];
          const level = id in inherited.edit || (edit.has(id) && view.has(id)) ? 'edit' : via || view.has(id) ? 'view' : null;
          return (
            <button key={id} type="button" className="nx-pick" aria-pressed={Boolean(level)} disabled={Boolean(via)} title={via ? `Доступ от папки «${inherited.edit[id] || via}» — меняется в ней` : undefined} onClick={() => cycle(id)}>
              <Avatar name={displayName(u)} seed={id} src={u.avatar} person size={32} />
              <span className="nx-pick-text"><span>{displayName(u)}</span>{via && <small>от папки «{inherited.edit[id] || via}»</small>}</span>
              {level && <span className="nfs-level" data-level={level}>{level === 'edit' ? 'Редактирование' : 'Просмотр'}</span>}
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}

// ── Отправить в чат ─────────────────────────────────────────────────────────

type Choice = 'none' | 'view' | 'edit';

/**
 * «Отправить в чат» — как у документов: выбираем чат, затем — давать ли его участникам доступ к файлу или папке и какой
 * (просмотр или правка). Доступ выдаётся каждому участнику отдельно и никогда не понижается (кто уже может править,
 * правку не теряет). Не владелец выдавать доступ не может — ему просто уходит карточка. Если всем в чате и так можно
 * править, вопрос про доступ не задаём. Папка открывается вместе со всем вложенным.
 */
export function SendSheet({ item, access, onClose, onDone }: {
  item: { id: string; name: string; url: string; fileType: string; isFolder?: boolean; preview?: string };
  /** parentId — папка, где лежит элемент: её доступ действует и на него. */
  access: { kind: 'file' | 'folder'; ownerId: string; parentId?: string | null; sharedWith?: string[]; editAccess?: string[] };
  onClose: () => void;
  onDone?: () => void;
}) {
  const chats = useChatStore((s) => s.chats);
  const users = useChatStore((s) => s.users);
  const me = useChatStore((s) => s.me);
  const [query, setQuery] = useState('');
  const [chatId, setChatId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(chats)
      .filter((c) => !isNotifications(c))
      .map((c) => ({ c, title: chatTitle(c, me, users) }))
      .filter(({ title }) => !q || title.toLowerCase().includes(q))
      .sort((a, b) => Number(isFavorites(b.c)) - Number(isFavorites(a.c))
        || String(b.c.lastMessage?.createdAt || '').localeCompare(String(a.c.lastMessage?.createdAt || '')));
  }, [chats, users, me, query]);

  const chat = chatId ? chats[chatId] : undefined;
  const chatName = chat ? chatTitle(chat, me, users) : '';
  const others = useMemo(() => (chat?.participantIds || []).map(String).filter((id) => id !== myId()), [chat]);
  const isOwner = String(access.ownerId) === myId();
  const what = item.isFolder ? 'папке' : 'файлу';

  // Кто из участников чата уже имеет доступ: берём свежие списки с сервера (пока лист был открыт, их могли поменять),
  // до ответа — то, что было на экране. Спрашиваем только про тех, кому доступа ещё не хватает.
  const [fresh, setFresh] = useState<{ sharedWith?: string[]; editAccess?: string[] } | null>(null);
  useEffect(() => {
    if (!chatId) return undefined;
    let alive = true;
    void currentAccess(access.kind, item.id).then((a) => { if (alive) setFresh(a); });
    return () => { alive = false; };
  }, [chatId, access.kind, item.id]);
  const inherited = useInheritedAccess(access.parentId ?? null);
  const editors = new Set([...(fresh?.editAccess || access.editAccess || []).map(String), ...Object.keys(inherited.edit)]);
  const viewers = new Set([...(fresh?.sharedWith || access.sharedWith || []).map(String), ...editors, ...Object.keys(inherited.view)]);
  const noView = others.filter((id) => !viewers.has(id));
  const noEdit = others.filter((id) => !editors.has(id));
  /** Доступ имеет смысл спрашивать, только если его можно выдать и кому-то его не хватает. */
  const canGrant = isOwner && noEdit.length > 0;
  /** Просмотр уже есть у всех — предлагать его выдать незачем, остаётся только повысить до правки. */
  const viewDone = noView.length === 0;

  async function send(choice: Choice) {
    if (!chatId) return;
    setBusy(true);
    setError('');
    try {
      if (choice !== 'none' && canGrant) {
        // Свежие списки доступа: пока лист был открыт, их могли поменять — не затираем чужие правки.
        const fresh = await currentAccess(access.kind, item.id);
        const view = new Set((fresh?.sharedWith || access.sharedWith || []).map(String));
        const edit = new Set((fresh?.editAccess || access.editAccess || []).map(String));
        for (const id of others) {
          if (edit.has(id)) continue; // правка уже есть — не понижаем
          view.add(id);
          if (choice === 'edit') edit.add(id);
        }
        await saveAccess(access.kind, item.id, Array.from(view), Array.from(edit).filter((id) => view.has(id)));
      }
      await shareToChat(chatId, item);
      showToast(`Отправлено в «${chatName}»${choice === 'none' || !canGrant ? '' : choice === 'edit' ? ': участники могут править' : ': участники могут смотреть'}`, 'success');
      onDone?.();
      onClose();
    } catch {
      setError('Не отправилось — нет связи с сервером. Попробуйте ещё раз.');
      setBusy(false);
    }
  }

  // Шаг 1 — выбор чата.
  if (!chatId) {
    return (
      <Sheet title={`Отправить «${item.name}»`} onClose={onClose}>
        <label className="nx-field" data-variant="filter">
          <Search size={14} aria-hidden="true" />
          <span className="nx-sr">Найти чат</span>
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти чат" autoComplete="off" autoFocus />
        </label>
        <div className="nfs-people">
          {list.map(({ c, title }) => (
            <button key={c.id} type="button" className="nx-pick" onClick={() => setChatId(String(c.id))}>
              <Avatar name={title} seed={c.id} src={c.avatar} kind={isFavorites(c) ? 'favorites' : undefined} person={!c.isGroup} size={32} />
              <span className="nx-pick-text"><span>{title}</span></span>
            </button>
          ))}
        </div>
      </Sheet>
    );
  }

  // Шаг 2 — доступ.
  const group = chat ? isGroupChat(chat) : false;
  return (
    <Sheet title={`Отправить в «${chatName}»`} onClose={onClose} busy={busy}>
      <div className="nfs-send">
        {canGrant ? (
          <>
            <p className="nfs-send-note">
              {viewDone
                ? <>{group ? 'У всех участников чата' : 'У собеседника'} уже есть просмотр {what} «{item.name}». Можно дать и редактирование.</>
                : <>Дать {group ? 'участникам чата' : 'собеседнику'} доступ к {what} «{item.name}»? Без доступа он не откроет {item.isFolder ? 'её' : 'его'} по карточке.
                  {group && noView.length < others.length && <> Доступ уже есть у {others.length - noView.length} из {others.length}.</>}</>}
            </p>
            <div className="nfs-send-options">
              {!viewDone && (
                <button type="button" className="nx-pick" disabled={busy} onClick={() => void send('view')}>
                  <Eye size={18} aria-hidden="true" /><span className="nx-pick-text"><span>Дать просмотр</span><small>Смогут смотреть и скачивать, но не менять</small></span>
                </button>
              )}
              <button type="button" className="nx-pick" disabled={busy} onClick={() => void send('edit')}>
                <Pencil size={18} aria-hidden="true" /><span className="nx-pick-text"><span>Дать редактирование</span><small>Смогут смотреть и менять</small></span>
              </button>
              <button type="button" className="nx-pick" disabled={busy} onClick={() => void send('none')}>
                <Link2 size={18} aria-hidden="true" /><span className="nx-pick-text"><span>{viewDone ? 'Оставить как есть' : 'Только карточка, без доступа'}</span><small>{viewDone ? 'Уйдёт карточка, права не меняются' : 'Откроется у тех, у кого доступ уже есть'}</small></span>
              </button>
            </div>
          </>
        ) : (
          <p className="nfs-send-note">
            {!isOwner ? 'Доступом управляет владелец, поэтому уйдёт только карточка.'
              : others.length === 0 ? (chat && isFavorites(chat) ? 'В «Избранное» вы пишете себе: уйдёт карточка, давать доступ некому.' : 'В этом чате нет других участников — уйдёт карточка.')
                : 'У всех в этом чате уже есть право править — доступ не меняем, уйдёт карточка.'}
          </p>
        )}
        {error && <p className="nfs-send-note nfs-send-error" role="alert">{error}</p>}
        <div className="nfs-send-actions">
          {!canGrant && <button type="button" className="nx-primary" disabled={busy} onClick={() => void send('none')}>{busy ? 'Отправляю…' : 'Отправить'}</button>}
          <button type="button" className="nx-ghost" disabled={busy} onClick={() => setChatId(null)}>Выбрать другой чат</button>
        </div>
      </div>
    </Sheet>
  );
}

/** Актуальные списки доступа файла или папки с сервера (null — не получилось, берём то, что было на экране). */
async function currentAccess(kind: 'file' | 'folder', id: string): Promise<{ sharedWith?: string[]; editAccess?: string[] } | null> {
  try {
    const res = await fetch(`/api/cloud/${kind === 'file' ? 'files' : 'folders'}/${encodeURIComponent(id)}`, { cache: 'no-store' });
    return res.ok ? ((await res.json()) as { sharedWith?: string[]; editAccess?: string[] }) : null;
  } catch { return null; }
}
