import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { ArrowUpRight, PanelBottom, PanelBottomClose, Pin, PinOff, Search } from 'lucide-react';
import { showToast } from '@/shared/ui/Toast';
import { ThemePicker } from '@/shared/theme/ThemePicker';
import { useChatStore } from '@/features/chat';
import { Menu, MenuItem, type MenuAnchor } from '@/shared/ui/overlay';
import { SearchField } from '@/shared/ui/SearchField';
import { useLongPress } from '@/shared/ui/useLongPress';
import { availableTools, type Account, type Tool } from './tools';
import { addNavTool, NAV_TOOL_DRAG, removeNavTool } from './navTools';
import { useToolBadges } from './toolBadges';
import { navigate } from '@/shared/navigation/navigate';
import { openSpotlight } from '@/features/spotlight';
import { toggleCorePanel } from '@/features/core/panel';
import { myId } from '@/shared/session/session';

/**
 * Раздел «Ещё» нового Шара — инструменты и настройки приложения.
 *
 * Как Launchpad: иконки-плашки, закреплённые наверху, поиск сразу в фокусе
 * на компьютере (набрал — Enter — открыл первый найденный). Закрепить —
 * правым щелчком или долгим нажатием; закрепления те же, что в текущей
 * версии (user.pinnedTools на сервере). Инструмент можно вынести в нижнее
 * меню — перетащить плитку на меню или пунктом «В нижнее меню» (user.navTools);
 * там он висит со своей единичкой (невзятые заявки, диалоги без ответа).
 */

const subscribeNoop = () => () => {};

type Desktop = { appVersion?: string; openExternal?: (url: string) => Promise<unknown> };
const desktop = (): Desktop | undefined => (window as unknown as { sharDesktop?: Desktop }).sharDesktop;

function openTool(t: Tool) {
  if (t.id === 'spotlight') { openSpotlight(); return; }
  // «Ядро» выезжает панелью справа, раздел «Ещё» остаётся на месте.
  if (t.id === 'core') { toggleCorePanel(); return; }
  if (t.external) {
    const d = desktop();
    if (d?.openExternal) void d.openExternal(t.href);
    else window.open(t.href, '_blank', 'noopener,noreferrer');
    return;
  }
  navigate(t.href);
}

function ToolTile({ t, pinned, count, onMenu }: { t: Tool; pinned: boolean; count: number; onMenu: (t: Tool, at: MenuAnchor) => void }) {
  const Icon = t.icon;
  const press = useLongPress((x, y) => onMenu(t, { x, y }));
  // Тянуть на нижнее меню можно только то, что открывается внутри Шара.
  const draggable = !t.external && t.href.startsWith('/');
  return (
    <a
      className="nmo-tile"
      href={t.href}
      target={t.external ? '_blank' : undefined}
      rel={t.external ? 'noopener noreferrer' : undefined}
      data-no-route={t.id === 'core' ? '' : undefined}
      onClick={(e) => { e.preventDefault(); openTool(t); }}
      onContextMenu={(e) => { e.preventDefault(); onMenu(t, { x: e.clientX, y: e.clientY }); }}
      onKeyDown={(e) => {
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); onMenu(t, { element: e.currentTarget, align: 'start' }); }
      }}
      title={t.hint}
      data-pinned={pinned ? 'true' : undefined}
      draggable={draggable}
      onDragStart={draggable ? (e) => { e.dataTransfer.setData(NAV_TOOL_DRAG, t.id); e.dataTransfer.effectAllowed = 'copy'; } : undefined}
      {...press}
    >
      <span className="nmo-icon" style={{ '--a': t.tint[0], '--b': t.tint[1] } as CSSProperties} aria-hidden="true">
        <Icon size={30} strokeWidth={1.8} />
        {t.external && <ArrowUpRight className="nmo-ext" size={12} strokeWidth={2.6} />}
        {count > 0 && <span className="nx-count nmo-badge" aria-label={`Ждут внимания: ${count}`}>{count > 99 ? '99+' : count}</span>}
      </span>
      <span className="nmo-name">{t.name}</span>
    </a>
  );
}

export default function MoreScreen() {
  const mounted = useSyncExternalStore(subscribeNoop, () => true, () => false);
  const cached = useChatStore((s) => s.users[myId()]) as (Account & object) | undefined;
  const [account, setAccount] = useState<Account | null>(null);
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<{ tool: Tool; anchor: MenuAnchor } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Права и закрепления — свежие с сервера; до ответа — из кэша пользователей.
  useEffect(() => {
    const id = myId();
    if (!id) return;
    fetch(`/api/users/${encodeURIComponent(id)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((u: Account | null) => { if (u) setAccount(u); })
      .catch(() => { /* останется кэш */ });
  }, []);

  // На компьютере поиск сразу в фокусе — как Spotlight в Launchpad.
  useEffect(() => {
    if (window.matchMedia('(pointer: fine)').matches) searchRef.current?.focus({ preventScroll: true });
  }, []);

  const user = account || cached || null;
  const counts = useToolBadges((s) => s.counts);
  const navIds = (cached as { navTools?: string[] } | undefined)?.navTools || [];
  const tools = useMemo(() => availableTools(user), [user]);
  const pinnedIds = useMemo(() => (user?.pinnedTools || []).filter((id) => tools.some((t) => t.id === id)), [user, tools]);

  const q = query.trim().toLowerCase();
  const found = useMemo(
    () => (q ? tools.filter((t) => `${t.name} ${t.hint}`.toLowerCase().includes(q)) : tools),
    [tools, q],
  );
  const pinned = q ? [] : pinnedIds.map((id) => tools.find((t) => t.id === id)!).filter(Boolean);
  const rest = q ? found : found.filter((t) => !pinnedIds.includes(t.id));

  const setPinned = useCallback(async (ids: string[]) => {
    const before = account;
    setAccount((a) => ({ ...(a || cached || {}), pinnedTools: ids }));
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(myId())}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinnedTools: ids }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setAccount(before);
      showToast('Не сохранилось — нет связи с сервером.', 'error');
    }
  }, [account, cached]);

  if (!mounted) return null;

  const version = desktop()?.appVersion;
  const menuPinned = menu ? pinnedIds.includes(menu.tool.id) : false;

  return (
    <div className="nmo nx-scroll-y">
      <div className="nmo-inner">
        <header className="nmo-head">
          <h1>Ещё</h1>
          <SearchField
            ref={searchRef}
            value={query}
            onChange={setQuery}
            placeholder="Найти инструмент"
            label="Найти инструмент"
            onKeyDown={(e) => { if (e.key === 'Enter' && found[0]) { e.preventDefault(); openTool(found[0]); } }}
          />
        </header>

        {pinned.length > 0 && (
          <section className="nmo-section" aria-labelledby="nmo-pinned">
            <h2 id="nmo-pinned">Закреплённые</h2>
            <div className="nmo-grid">
              {pinned.map((t) => <ToolTile key={t.id} t={t} pinned count={counts[t.id] || 0} onMenu={(tool, anchor) => setMenu({ tool, anchor })} />)}
            </div>
          </section>
        )}

        <section className="nmo-section" aria-labelledby="nmo-tools">
          <h2 id="nmo-tools">{q ? 'Найдено' : 'Инструменты'}</h2>
          {rest.length === 0 ? (
            <div className="nx-state nmo-empty">
              <Search size={24} aria-hidden="true" />
              <p>{q ? 'Такого инструмента нет — или он вам не выдан.' : 'Все ваши инструменты закреплены наверху.'}</p>
            </div>
          ) : (
            <div className="nmo-grid">
              {rest.map((t) => <ToolTile key={t.id} t={t} pinned={pinnedIds.includes(t.id)} count={counts[t.id] || 0} onMenu={(tool, anchor) => setMenu({ tool, anchor })} />)}
            </div>
          )}
          {!q && <p className="nmo-tip">Правый щелчок или долгое нажатие — закрепить наверху или вынести в нижнее меню. На компьютере плитку можно просто перетащить на меню.</p>}
        </section>

        {!q && (
          <section className="nmo-section" aria-labelledby="nmo-app">
            <h2 id="nmo-app">Приложение</h2>
            <div className="nmo-group">
              <div className="nmo-row">
                <span className="nmo-row-label">Оформление</span>
                <ThemePicker label="Оформление" />
              </div>
              {version && (
                <div className="nmo-row">
                  <span className="nmo-row-label">Шар для компьютера</span>
                  <span className="nmo-row-value">версия {version} · обновляется сама</span>
                </div>
              )}
            </div>
          </section>
        )}
      </div>

      {menu && (
        <Menu anchor={menu.anchor} label={menu.tool.name} onClose={() => setMenu(null)} compact>
          <MenuItem icon={<ArrowUpRight size={16} />} onSelect={() => { setMenu(null); openTool(menu.tool); }}>Открыть</MenuItem>
          {menuPinned ? (
            <MenuItem icon={<PinOff size={16} />} onSelect={() => { setMenu(null); void setPinned(pinnedIds.filter((id) => id !== menu.tool.id)); }}>Открепить</MenuItem>
          ) : (
            <MenuItem icon={<Pin size={16} />} onSelect={() => { setMenu(null); void setPinned([...pinnedIds, menu.tool.id]); }}>Закрепить наверху</MenuItem>
          )}
          {!menu.tool.external && menu.tool.href.startsWith('/') && (navIds.includes(menu.tool.id) ? (
            <MenuItem icon={<PanelBottomClose size={16} />} onSelect={() => { setMenu(null); void removeNavTool(menu.tool.id); }}>Убрать из нижнего меню</MenuItem>
          ) : (
            <MenuItem icon={<PanelBottom size={16} />} onSelect={() => { setMenu(null); void addNavTool(menu.tool.id); }}>В нижнее меню</MenuItem>
          ))}
        </Menu>
      )}
    </div>
  );
}
