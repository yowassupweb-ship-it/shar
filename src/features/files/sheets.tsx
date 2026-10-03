import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Folder, Loader2, Search } from 'lucide-react';
import { showToast } from '@/shared/ui/Toast';
import { chatTitle, displayName, isFavorites, isNotifications, useChatStore } from '@/features/chat';
import { Avatar } from '@/shared/ui/Avatar';
import { Sheet } from '@/shared/ui/overlay';
import {
  loadFolder, moveFile, moveFolder, myId, saveAccess, shareToChat, type CloudFile, type CloudFolder,
} from './api';

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
        <div className="nx-state" aria-busy="true"><Loader2 size={20} className="nx-spin" aria-hidden="true" /></div>
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
  const [view, setView] = useState<Set<string>>(() => new Set((item.sharedWith || []).map(String)));
  const [edit, setEdit] = useState<Set<string>>(() => new Set((item.editAccess || []).map(String)));
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  const people = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(users)
      .filter((u) => String(u.id) !== me && String(u.id) !== String(item.ownerId))
      .filter((u) => !q || displayName(u).toLowerCase().includes(q))
      .sort((a, b) => Number(view.has(String(b.id))) - Number(view.has(String(a.id))) || displayName(a).localeCompare(displayName(b), 'ru'));
  }, [users, query, me, item.ownerId, view]);

  // Три шага по нажатию: нет доступа → просмотр → редактирование → нет.
  const cycle = (id: string) => {
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
          const level = edit.has(id) && view.has(id) ? 'edit' : view.has(id) ? 'view' : null;
          return (
            <button key={id} type="button" className="nx-pick" aria-pressed={Boolean(level)} onClick={() => cycle(id)}>
              <Avatar name={displayName(u)} seed={id} src={u.avatar} person size={32} />
              <span className="nx-pick-text"><span>{displayName(u)}</span></span>
              {level && <span className="nfs-level" data-level={level}>{level === 'edit' ? 'Редактирование' : 'Просмотр'}</span>}
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}

// ── Отправить в чат ─────────────────────────────────────────────────────────

export function SendSheet({ item, onClose }: {
  item: { id: string; name: string; url: string; fileType: string; isFolder?: boolean; preview?: string };
  onClose: () => void;
}) {
  const chats = useChatStore((s) => s.chats);
  const users = useChatStore((s) => s.users);
  const me = useChatStore((s) => s.me);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(chats)
      .filter((c) => !isNotifications(c))
      .map((c) => ({ c, title: chatTitle(c, me, users) }))
      .filter(({ title }) => !q || title.toLowerCase().includes(q))
      .sort((a, b) => Number(isFavorites(b.c)) - Number(isFavorites(a.c))
        || String(b.c.lastMessage?.createdAt || '').localeCompare(String(a.c.lastMessage?.createdAt || '')));
  }, [chats, users, me, query]);

  const send = async (chatId: string, title: string) => {
    setBusy(chatId);
    try {
      await shareToChat(chatId, item);
      showToast(`Отправлено в «${title}»`, 'success');
      onClose();
    } catch {
      showToast('Не отправилось — нет связи с сервером.', 'error');
      setBusy(null);
    }
  };

  return (
    <Sheet title={`Отправить «${item.name}»`} onClose={onClose} busy={Boolean(busy)}>
      <label className="nx-field" data-variant="filter">
        <Search size={14} aria-hidden="true" />
        <span className="nx-sr">Найти чат</span>
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти чат" autoComplete="off" autoFocus />
      </label>
      <div className="nfs-people">
        {list.map(({ c, title }) => (
          <button key={c.id} type="button" className="nx-pick" disabled={Boolean(busy)} onClick={() => void send(c.id, title)}>
            <Avatar name={title} seed={c.id} src={c.avatar} kind={isFavorites(c) ? 'favorites' : undefined} person={!c.isGroup} size={32} />
            <span className="nx-pick-text"><span>{title}</span></span>
            {busy === c.id && <Loader2 size={16} className="nx-spin" aria-hidden="true" />}
          </button>
        ))}
      </div>
    </Sheet>
  );
}
