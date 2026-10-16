import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useSearchParams } from 'react-router';
import { Globe2, LayoutGrid, Lock, MonitorUp, Pin, Plus, Send, Trash2, Upload, Users } from 'lucide-react';
import { useShellOptions } from '@/shared/shell/ShellContext';
import { realtime } from '@/shared/realtime/realtime';
import { SearchField } from '@/shared/ui/SearchField';
import Splitter from '@/shared/ui/Splitter';
import { askConfirm, Menu, MenuItem, type MenuAnchor } from '@/shared/ui/overlay';
import { SendToChatSheet } from './SendToChatSheet';
import { showToast } from '@/shared/ui/Toast';
import { myId } from '@/shared/session/session';
import { useLongPress } from '@/shared/ui/useLongPress';
import { workspaceApi } from './api';
import { initialContent, ItemView } from './ItemView';
import { KIND_LIST, KINDS } from './kinds';
import { IMPORT_RULES, importFile } from './lib/importFile';
import { isWorkspaceEvent } from './live';
import { readPlace, writePlace } from './lib/officeMemory';
import { canSticky, dragNoteOut, forgetSticky, openSticky } from './lib/sticky';
import type { Item, Kind } from './types';
import { Spinner } from '@/shared/ui/Spinner';
import './workspace.css';

/**
 * «Офис» — заметки, документы, таблицы и презентации в одном месте. Слева список (поиск, виды,
 * закреплённое сверху), справа открытый материал. Адрес — источник правды: ?kind=&id=, ссылкой можно
 * поделиться, «назад» работает. На телефоне список и материал — два экрана.
 */

const NARROW = '(max-width: 899px)';
const subscribeMedia = (cb: () => void) => {
  const mq = window.matchMedia(NARROW);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
};

function since(iso: string): string {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} ч`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} дн`;
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function ItemRow({ item, active, onOpen, onMenu }: { item: Item; active: boolean; onOpen: () => void; onMenu: (anchor: MenuAnchor) => void }) {
  const info = KINDS[item.kind];
  const press = useLongPress((x, y) => onMenu({ x, y }));
  const AccessIcon = item.accessLevel === 'all' ? Globe2 : Lock;
  const mine = item.ownerId === myId();
  return (
    <button
      type="button"
      className="nws-row"
      aria-current={active ? 'true' : undefined}
      data-color={item.kind === 'note' ? item.meta.color || undefined : undefined}
      onClick={onOpen}
      // Заметку можно вытащить за пределы окна — она станет окном на рабочем столе (только в приложении для компьютера).
      draggable={canSticky(item.kind)}
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', item.title || info.untitled); e.dataTransfer.effectAllowed = 'copyMove'; }}
      onDragEnd={(e) => dragNoteOut(e, item.id)}
      onContextMenu={(e) => { e.preventDefault(); onMenu({ x: e.clientX, y: e.clientY }); }}
      {...press}
    >
      <span className="nws-kind-icon" style={{ '--a': info.tint[0], '--b': info.tint[1] } as React.CSSProperties} aria-hidden="true"><info.icon size={16} /></span>
      <span className="nws-row-text">
        <span className="nws-row-title">{item.title || info.untitled}</span>
        <span className="nws-row-snippet">{item.snippet}</span>
      </span>
      <span className="nws-row-meta">
        <span>{since(item.updatedAt)}</span>
        <span className="nws-row-flags">
          {item.pinned && <Pin size={11} aria-label="Закреплено" />}
          {!mine ? <Users size={11} aria-label={`Владелец: ${item.ownerName}`} /> : <AccessIcon size={11} aria-label={item.accessLevel === 'all' ? 'Видят все' : 'Личное'} />}
        </span>
      </span>
    </button>
  );
}

export default function OfficeScreen() {
  const [params, setParams] = useSearchParams();
  // Вернулись в «Офис» из другого раздела без адреса — открываем там, где были (вид, материал, поиск).
  const place = useRef(readPlace());
  const restored = useRef(false);
  const kindParam = params.get('kind');
  const filter: Kind | 'all' = kindParam && kindParam in KINDS ? (kindParam as Kind) : 'all';
  const openId = params.get('id');
  const narrow = useSyncExternalStore(subscribeMedia, () => window.matchMedia(NARROW).matches, () => false);

  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState(() => (!new URLSearchParams(window.location.search).toString() ? place.current?.query ?? '' : ''));
  const [busy, setBusy] = useState('');
  const [create, setCreate] = useState<MenuAnchor | null>(null);
  const [rowMenu, setRowMenu] = useState<{ item: Item; anchor: MenuAnchor } | null>(null);
  const [sendItem, setSendItem] = useState<Item | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const reqId = useRef(0);
  const layoutRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const saved = place.current;
    if (saved?.search && !params.toString()) setParams(new URLSearchParams(saved.search), { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Список вернулся — прокручиваем туда, где остановились (один раз).
  const scrolled = useRef(false);
  useEffect(() => {
    if (scrolled.current || items === null) return;
    scrolled.current = true;
    const top = place.current?.listScroll;
    if (top && rowsRef.current) rowsRef.current.scrollTop = top;
  }, [items]);

  // Запоминаем место при каждой смене адреса и поиска; прокрутку списка — при уходе из раздела.
  useEffect(() => {
    if (!restored.current) return;
    writePlace({ search: params.toString(), query });
  }, [params, query]);
  useEffect(() => () => {
    writePlace({ listScroll: rowsRef.current?.scrollTop ?? 0 });
  }, []);

  // На телефоне открытый материал занимает весь экран: капсулу меню убираем.
  useShellOptions({ navHidden: narrow && Boolean(openId), onReselect: () => setParams(filter === 'all' ? {} : { kind: filter }) });

  const load = useCallback(async () => {
    const mine = ++reqId.current;
    try {
      const list = await workspaceApi.list(filter === 'all' ? null : filter, query);
      if (mine !== reqId.current) return;
      setItems(list);
      setError('');
    } catch (cause) {
      if (mine === reqId.current) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить');
    }
  }, [filter, query]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), query ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [load, query]);

  // Вернулись в окно — список мог измениться (коллега поделился, правил с другого устройства).
  useEffect(() => {
    const onFocus = () => { if (document.visibilityState === 'visible') void load(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => { window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus); };
  }, [load]);

  // Коллега открыл материал, убрал доступ, удалил или переименовал — список обновляется сам, без перезагрузки страницы.
  useEffect(() => {
    let timer = 0;
    const off = realtime.subscribe((event) => {
      if (!isWorkspaceEvent(event)) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), 250);
    });
    return () => { off(); window.clearTimeout(timer); };
  }, [load]);

  const select = (id: string | null, kind: Kind | 'all' = filter, replace = false) => {
    const next: Record<string, string> = {};
    if (kind !== 'all') next.kind = kind;
    if (id) next.id = id;
    setParams(next, { replace });
  };

  async function createItem(kind: Kind) {
    setCreate(null);
    setBusy(`new:${kind}`);
    try {
      const item = await workspaceApi.create({ kind, title: '', content: await initialContent(kind) });
      select(item.id, filter === 'all' ? 'all' : kind);
      void load();
    } catch (cause) { showToast(cause instanceof Error ? cause.message : 'Не удалось создать', 'error'); } finally { setBusy(''); }
  }

  const [dropping, setDropping] = useState(false);

  async function importPicked(file: File | undefined) {
    if (!file) return;
    setBusy('import');
    try {
      const imported = await importFile(file, (done, total) => setBusy(`import:${done}/${total}`), filter);
      const item = await workspaceApi.create({ kind: imported.kind, title: imported.title, content: imported.content });
      showToast(`Импортировано: ${KINDS[imported.kind].plural.toLowerCase()}`, 'success');
      select(item.id, filter === 'all' ? 'all' : imported.kind);
      void load();
    } catch (cause) { showToast(cause instanceof Error ? cause.message : 'Не удалось импортировать', 'error'); } finally {
      setBusy('');
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function togglePin(item: Item) {
    try { await workspaceApi.patch(item.id, { pinned: !item.pinned }); void load(); } catch (cause) { showToast(cause instanceof Error ? cause.message : 'Не получилось', 'error'); }
  }

  async function removeItem(item: Item) {
    const ok = await askConfirm({ title: `Удалить «${item.title || KINDS[item.kind].untitled}»?`, text: 'Это нельзя отменить.', confirm: 'Удалить', tone: 'danger' });
    if (!ok) return;
    try {
      await workspaceApi.remove(item.id);
      forgetSticky(item.id);
      if (openId === item.id) select(null);
      void load();
    } catch (cause) { showToast(cause instanceof Error ? cause.message : 'Не удалось удалить', 'error'); }
  }

  const pinned = useMemo(() => (items || []).filter((i) => i.pinned), [items]);
  const rest = useMemo(() => (items || []).filter((i) => !i.pinned), [items]);
  const importing = busy.startsWith('import');
  const importRule = IMPORT_RULES[filter];

  const renderRow = (item: Item) => (
    <ItemRow key={item.id} item={item} active={item.id === openId} onOpen={() => select(item.id, filter === 'all' ? 'all' : item.kind)} onMenu={(anchor) => setRowMenu({ item, anchor })} />
  );

  return (
    <div className="nws" ref={layoutRef} data-open={openId ? 'true' : undefined}>
      <aside
        className={`nws-list${dropping ? ' is-dropping' : ''}`}
        aria-label="Материалы"
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true); } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false); }}
        onDrop={(e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); setDropping(false); void importPicked(e.dataTransfer.files[0]); }}
      >
        <header className="nws-list-head">
          <button type="button" className="nx-ghost nws-import" disabled={importing} title={`${importRule.label}: ${importRule.hint}`} aria-label={importRule.label} onClick={() => fileInput.current?.click()}>
            <Upload size={15} aria-hidden="true" /> Импорт
          </button>
          <button type="button" className="nx-primary" aria-haspopup="menu" aria-expanded={Boolean(create)} disabled={Boolean(busy) && !importing} onClick={(e) => setCreate({ element: e.currentTarget, align: 'end' })}>
            <Plus size={15} aria-hidden="true" /> Создать
          </button>
          <input ref={fileInput} type="file" accept={importRule.accept} hidden onChange={(e) => void importPicked(e.target.files?.[0])} />
        </header>

        <div className="nws-kinds" role="group" aria-label="Вид материалов">
          <button type="button" aria-pressed={filter === 'all'} onClick={() => select(null, 'all')}><LayoutGrid size={16} aria-hidden="true" /><span>Все</span></button>
          {KIND_LIST.map((k) => (
            <button key={k.kind} type="button" aria-pressed={filter === k.kind} onClick={() => select(null, k.kind)} style={{ '--a': k.tint[0], '--b': k.tint[1] } as React.CSSProperties}>
              <k.icon size={16} aria-hidden="true" /><span>{k.short}</span>
            </button>
          ))}
        </div>

        <SearchField value={query} onChange={setQuery} placeholder="Найти по названию и тексту" />
        {importing && <p className="nws-hint" role="status">{busy.includes('/') ? `Читаю PDF: ${busy.split(':')[1]}` : 'Импортирую…'}</p>}

        <div className="nws-rows nx-scroll-y" ref={rowsRef}>
          {items === null && !error && <div className="nws-loading"><Spinner size={22} label="Загружаю" /></div>}
          {error && <p className="nws-hint nws-error" role="alert">{error} <button type="button" className="nx-ghost" onClick={() => void load()}>Повторить</button></p>}
          {pinned.length > 0 && <h2 className="nws-group">Закреплённые</h2>}
          {pinned.map(renderRow)}
          {pinned.length > 0 && rest.length > 0 && <h2 className="nws-group">Остальные</h2>}
          {rest.map(renderRow)}
          {items !== null && !items.length && !error && (
            <div className="nws-empty-list">
              <p>{query ? 'Ничего не нашлось.' : filter === 'all' ? 'Здесь появятся ваши заметки, документы, таблицы и презентации.' : KINDS[filter].empty}</p>
              {!query && (
                <div className="nws-empty-actions">
                  <button type="button" className="nx-primary" onClick={() => void createItem(filter === 'all' ? 'document' : filter)}><Plus size={14} aria-hidden="true" /> {filter === 'all' ? 'Новый документ' : KINDS[filter].newLabel}</button>
                  <button type="button" className="nx-ghost" disabled={importing} onClick={() => fileInput.current?.click()}><Upload size={14} aria-hidden="true" /> {importRule.label}</button>
                </div>
              )}
            </div>
          )}
        </div>
      </aside>

      {!narrow && <Splitter containerRef={layoutRef} cssVar="--nws-list" storageKey="nx:office-list-width" min={280} max={620} initial={340} maxRatio={0.5} label="Ширина списка материалов" />}

      <section className="nws-pane">
        {openId ? (
          <ItemView
            key={openId}
            source={{ id: openId }}
            onBack={narrow ? () => select(null) : undefined}
            onChanged={() => void load()}
            onDeleted={() => { select(null); void load(); }}
            onOpen={(id, kind) => select(id, filter === 'all' ? 'all' : kind)}
          />
        ) : (
          <div className="nws-welcome">
            <h2>Что создаём?</h2>
            <div className="nws-tiles">
              {KIND_LIST.map((k) => (
                <button key={k.kind} type="button" className="nws-tile" disabled={Boolean(busy)} onClick={() => void createItem(k.kind)} style={{ '--a': k.tint[0], '--b': k.tint[1] } as React.CSSProperties}>
                  <span className="nws-tile-icon" aria-hidden="true"><k.icon size={26} /></span>
                  <b>{k.newLabel.replace('Новая ', '').replace('Новый ', '').replace(/^./, (c) => c.toUpperCase())}</b>
                </button>
              ))}
            </div>
            <button type="button" className="nx-ghost nws-welcome-import" disabled={importing} onClick={() => fileInput.current?.click()}><Upload size={15} aria-hidden="true" /> {importRule.label}</button>
            <p className="nws-hint">{importRule.hint}. Поделиться материалом можно с человеком или целым отделом — он сразу появится у них в «Офисе».</p>
          </div>
        )}
      </section>

      {create && (
        <Menu anchor={create} label="Создать" onClose={() => setCreate(null)}>
          {KIND_LIST.map((k) => <MenuItem key={k.kind} icon={<k.icon size={16} />} onSelect={() => void createItem(k.kind)}>{k.newLabel}</MenuItem>)}
        </Menu>
      )}
      {rowMenu && (
        <Menu anchor={rowMenu.anchor} label="Действия" onClose={() => setRowMenu(null)}>
          <MenuItem onSelect={() => { const i = rowMenu.item; setRowMenu(null); select(i.id, filter === 'all' ? 'all' : i.kind); }}>Открыть</MenuItem>
          <MenuItem icon={<Send size={15} />} onSelect={() => { const i = rowMenu.item; setRowMenu(null); setSendItem(i); }}>Отправить в чат</MenuItem>
          {canSticky(rowMenu.item.kind) && (
            <MenuItem icon={<MonitorUp size={15} />} onSelect={() => { const i = rowMenu.item; setRowMenu(null); void openSticky(i.id); }}>На рабочий стол</MenuItem>
          )}
          {rowMenu.item.isOwner && (
            <MenuItem icon={<Pin size={15} />} onSelect={() => { const i = rowMenu.item; setRowMenu(null); void togglePin(i); }}>{rowMenu.item.pinned ? 'Открепить' : 'Закрепить сверху'}</MenuItem>
          )}
          {rowMenu.item.isOwner && (
            <MenuItem icon={<Trash2 size={15} />} tone="danger" onSelect={() => { const i = rowMenu.item; setRowMenu(null); void removeItem(i); }}>Удалить</MenuItem>
          )}
        </Menu>
      )}
      {sendItem && <SendToChatSheet item={sendItem} onClose={() => setSendItem(null)} />}
    </div>
  );
}
