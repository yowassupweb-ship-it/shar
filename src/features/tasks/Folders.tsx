import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Check, FolderPlus, Lock, MoreHorizontal, Palette, Pencil, Search, Share2, Trash2, Users } from 'lucide-react';
import { displayName, useChatStore } from '@/features/chat';
import { Avatar } from '@/shared/ui/Avatar';
import { askConfirm, Menu, MenuItem, Sheet, type MenuAnchor } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import { useLongPress } from '@/shared/ui/useLongPress';
import {
  canManageFolder, createFolder, deleteFolder, FOLDER_COLORS, folderShares, folderTaskCount, myId, saveFolderShares, updateFolder,
  type FolderShare, type TaskList,
} from './api';

/**
 * Папки задач: полоса над списком (Все · папки · Без папки), окно «Новая папка / Переименовать», окно «Доступ».
 * Папка — «список» задач на сервере. Кто её открыл другому, тот видит все её задачи (view) или ещё и правит (edit).
 */

export type FolderFilter = 'all' | 'none' | string;

export function FolderBar({ lists, counts, selected, onSelect, onNew, onAction }: {
  lists: TaskList[];
  counts: Record<string, number>;
  selected: FolderFilter;
  onSelect: (id: FolderFilter) => void;
  onNew: () => void;
  onAction: (list: TaskList, anchor: MenuAnchor) => void;
}) {
  return (
    <div className="ntf" role="tablist" aria-label="Папки задач">
      <button type="button" role="tab" className="ntf-chip" aria-selected={selected === 'all'} onClick={() => onSelect('all')}>Все<span>{counts.all || 0}</span></button>
      {lists.map((l) => <FolderChip key={l.id} list={l} count={counts[l.id] || 0} selected={selected === l.id} onSelect={onSelect} onAction={onAction} />)}
      {(counts.none || 0) > 0 && lists.length > 0 && (
        <button type="button" role="tab" className="ntf-chip" aria-selected={selected === 'none'} onClick={() => onSelect('none')}>Без папки<span>{counts.none}</span></button>
      )}
      <button type="button" className="ntf-add" onClick={onNew} aria-label="Новая папка" title="Новая папка"><FolderPlus size={15} aria-hidden="true" /></button>
    </div>
  );
}

function FolderChip({ list, count, selected, onSelect, onAction }: {
  list: TaskList; count: number; selected: boolean; onSelect: (id: FolderFilter) => void; onAction: (list: TaskList, anchor: MenuAnchor) => void;
}) {
  const press = useLongPress((x, y) => onAction(list, { x, y }));
  const mine = canManageFolder(list);
  const shared = Boolean(list.sharedLevel);
  return (
    <span className="ntf-wrap" data-selected={selected ? 'true' : undefined}>
      <button
        type="button" role="tab" className="ntf-chip" aria-selected={selected} style={{ '--tone': list.color || 'var(--note-gray)' } as CSSProperties}
        onClick={() => onSelect(list.id)}
        onContextMenu={(e) => { e.preventDefault(); onAction(list, { x: e.clientX, y: e.clientY }); }}
        title={shared ? `Открыта вам: ${list.sharedLevel === 'edit' ? 'можно править' : 'только просмотр'}` : undefined}
        {...press}
      >
        <i className="ntf-dot" aria-hidden="true" />{list.name}{shared && <Users size={11} aria-label="Общая папка" />}<span>{count}</span>
      </button>
      {mine && (
        <button type="button" className="ntf-more" aria-label={`Действия с папкой «${list.name}»`} onClick={(e) => onAction(list, { element: e.currentTarget, align: 'start' })}>
          <MoreHorizontal size={14} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

/** Меню папки: переименовать, цвет, доступ, удалить (только создателю и админу). */
export function FolderMenu({ list, anchor, onClose, onRename, onShare, onDeleted }: {
  list: TaskList; anchor: MenuAnchor; onClose: () => void; onRename: (l: TaskList) => void; onShare: (l: TaskList) => void; onDeleted: (id: string) => void;
}) {
  const remove = async () => {
    onClose();
    let tasks = 0;
    try { tasks = await folderTaskCount(list.id); } catch { /* счётчик — подсказка, без него удаляем по подтверждению */ }
    const text = tasks
      ? `В папке ${tasks} задач: они останутся у исполнителей, но уже без папки. Тем, кому папка открыта, они пропадут.`
      : 'Папка пустая.';
    if (!await askConfirm({ title: `Удалить папку «${list.name}»?`, text, confirm: 'Удалить', tone: 'danger' })) return;
    try { await deleteFolder(list.id); onDeleted(list.id); } catch { showToast('Папка не удалилась — нет связи с сервером.', 'error'); }
  };
  return (
    <Menu anchor={anchor} label={list.name} onClose={onClose}>
      <MenuItem icon={<Pencil size={16} />} onSelect={() => { onClose(); onRename(list); }}>Переименовать…</MenuItem>
      <MenuItem icon={<Share2 size={16} />} onSelect={() => { onClose(); onShare(list); }}>Доступ…</MenuItem>
      <div className="nx-menu-sep" />
      <div className="nx-menu-label"><Palette size={12} aria-hidden="true" /> Цвет</div>
      <div className="ntf-colors" role="radiogroup" aria-label="Цвет папки">
        {FOLDER_COLORS.map((c) => (
          <button key={c} type="button" role="radio" aria-checked={(list.color || '').toLowerCase() === c} aria-label={c} className="ntf-color" style={{ '--tone': c } as CSSProperties}
            onClick={() => { onClose(); void updateFolder(list.id, { color: c }).catch(() => showToast('Цвет не сохранился — нет связи с сервером.', 'error')); }}>
            {(list.color || '').toLowerCase() === c && <Check size={12} strokeWidth={3} aria-hidden="true" />}
          </button>
        ))}
      </div>
      <div className="nx-menu-sep" />
      <MenuItem icon={<Trash2 size={16} />} tone="danger" onSelect={() => void remove()}>Удалить папку</MenuItem>
    </Menu>
  );
}

/** Создать папку (list не задан) или переименовать. */
export function FolderSheet({ list, onClose, onSaved }: { list?: TaskList; onClose: () => void; onSaved: (l: TaskList) => void }) {
  const [name, setName] = useState(list?.name || '');
  const [color, setColor] = useState(list?.color || FOLDER_COLORS[0]);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const title = name.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      if (list) { await updateFolder(list.id, { name: title, color }); onSaved({ ...list, name: title, color }); } else onSaved(await createFolder(title, color));
      onClose();
    } catch {
      showToast('Папка не сохранилась — нет связи с сервером.', 'error');
      setBusy(false);
    }
  };
  return (
    <Sheet
      title={list ? 'Папка' : 'Новая папка'}
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          <button type="button" className="nx-ghost" onClick={onClose}>Отмена</button>
          <button type="button" className="nx-primary" disabled={!name.trim() || busy} onClick={() => void save()}>{list ? 'Сохранить' : 'Создать'}</button>
        </>
      )}
    >
      <label className="nx-field">
        <span className="nx-sr">Название папки</span>
        <input value={name} maxLength={80} placeholder="Например, «SEO»" autoFocus autoComplete="off" onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} />
      </label>
      <div className="ntf-colors ntf-colors-sheet" role="radiogroup" aria-label="Цвет папки">
        {FOLDER_COLORS.map((c) => (
          <button key={c} type="button" role="radio" aria-checked={color.toLowerCase() === c} aria-label={c} className="ntf-color" style={{ '--tone': c } as CSSProperties} onClick={() => setColor(c)}>
            {color.toLowerCase() === c && <Check size={12} strokeWidth={3} aria-hidden="true" />}
          </button>
        ))}
      </div>
      {!list && <p className="nx-hint"><Lock size={12} aria-hidden="true" /> Новая папка личная. Открыть её коллегам можно в меню папки → «Доступ».</p>}
    </Sheet>
  );
}

/** Доступ к папке: каждому — нет / просмотр / правка. Открытому человеку видны все задачи папки. */
export function FolderShareSheet({ list, onClose }: { list: TaskList; onClose: () => void }) {
  const users = useChatStore((s) => s.users);
  const [shares, setShares] = useState<Record<string, FolderShare['level']> | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const me = myId();

  useEffect(() => {
    folderShares(list.id)
      .then((d) => setShares(Object.fromEntries(d.shares.map((s) => [s.userId, s.level]))))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Не удалось загрузить доступ'));
  }, [list.id]);

  const people = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(users)
      .filter((u) => String(u.id) !== me && (!q || displayName(u).toLowerCase().includes(q)))
      .sort((a, b) => Number(Boolean(shares?.[String(b.id)])) - Number(Boolean(shares?.[String(a.id)])) || displayName(a).localeCompare(displayName(b), 'ru'));
  }, [users, query, me, shares]);

  const set = (id: string, level: FolderShare['level'] | '') => setShares((cur) => {
    const next = { ...(cur || {}) };
    if (level) next[id] = level; else delete next[id];
    return next;
  });

  const save = async () => {
    if (!shares || busy) return;
    setBusy(true);
    try {
      await saveFolderShares(list.id, Object.entries(shares).map(([userId, level]) => ({ userId, level })));
      showToast('Доступ сохранён', 'success');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не сохранилось');
      setBusy(false);
    }
  };
  const count = shares ? Object.keys(shares).length : 0;
  return (
    <Sheet
      title={`Доступ к папке «${list.name}»`}
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          <button type="button" className="nx-ghost" onClick={onClose}>Отмена</button>
          <button type="button" className="nx-primary" disabled={!shares || busy} onClick={() => void save()}>Готово{count ? ` · ${count}` : ''}</button>
        </>
      )}
    >
      <p className="nx-hint">Кому открыта папка, тот видит все её задачи. «Просмотр» — только читать, «Правка» — ещё менять задачи и добавлять свои.</p>
      <label className="nx-field" data-variant="filter">
        <Search size={14} aria-hidden="true" />
        <span className="nx-sr">Найти сотрудника</span>
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти сотрудника" autoComplete="off" />
      </label>
      {error && <p className="nx-hint ntf-error" role="alert">{error}</p>}
      <div className="ntd-people">
        {people.map((u) => {
          const id = String(u.id);
          const level = shares?.[id] || '';
          return (
            <div key={id} className="nx-pick ntf-person">
              <Avatar name={displayName(u)} seed={id} src={u.avatar} person size={32} />
              <span className="nx-pick-text"><span>{displayName(u)}</span></span>
              <div className="nx-segment ntf-level" role="group" aria-label={`Доступ: ${displayName(u)}`}>
                <button type="button" aria-pressed={level === ''} onClick={() => set(id, '')}>Нет</button>
                <button type="button" aria-pressed={level === 'view'} onClick={() => set(id, 'view')}>Просмотр</button>
                <button type="button" aria-pressed={level === 'edit'} onClick={() => set(id, 'edit')}>Правка</button>
              </div>
            </div>
          );
        })}
      </div>
    </Sheet>
  );
}
