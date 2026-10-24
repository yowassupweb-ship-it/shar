import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { Palette as PaletteIcon, PinOff, Settings, type LucideIcon } from 'lucide-react';
import { PALETTES, useTheme } from '@/shared/theme/ThemeContext';
import { Avatar } from '@/shared/ui/Avatar';
import { Menu, MenuItem, type MenuAnchor } from '@/shared/ui/overlay';
import { useViewportSync } from '@/shared/platform/viewport';
import { isTabVisible } from '@/shared/navigation/visibility';
import { paths } from '@/shared/navigation/routes';
import { navigate } from '@/shared/navigation/navigate';
import ToastContainer from '@/shared/ui/Toast';
import { SECTIONS, type SectionId } from './sections';
import './shell.css';

/**
 * Каркас нового шара: область раздела и навигация по разделам.
 *
 * Навигация одна, раскладки две:
 *  - десктоп — нижняя полоса во всю ширину (строка под содержимым);
 *  - телефон (≤640px) — парящая капсула над содержимым (доктрина §12).
 *    Раздел, открывший «деталь» (переписку, задачу), прячет капсулу через
 *    `navHidden`: на телефоне одна область за раз.
 *
 * Прокручиваемые области раздела оставляют снизу место под капсулу —
 * `padding-bottom: var(--nx-nav-space)`; когда капсула скрыта, оно равно нулю.
 *
 * На телефоне корень привязан к видимой области над клавиатурой
 * (useViewportSync); пока клавиатура открыта, капсула тоже прячется.
 */

export interface AppShellProps {
  section: SectionId;
  children: ReactNode;
  /** Счётчики на пунктах меню (непрочитанные чаты, письма). */
  badges?: Partial<Record<SectionId, number>>;
  /** Какие разделы пользователь показывает в меню (visibleTabs из профиля). */
  visibleTabs?: Record<string, boolean>;
  /** Спрятать капсулу на телефоне — раздел показывает деталь. */
  navHidden?: boolean;
  /** Переход внутри того же раздела: повторный тап по активному пункту. */
  onReselect?: () => void;
  /** Кто вошёл — аватар в правом углу меню. */
  account?: { id: string; name: string; avatar?: string; subtitle?: string };
  /** Инструменты, вынесенные в меню (из «Ещё»), — со своими единичками. */
  navTools?: NavTool[];
  /** Плитку инструмента перетащили из «Ещё» на меню. */
  onNavToolDrop?: (id: string) => void;
  /** «Убрать из меню» — правый щелчок по инструменту. */
  onNavToolRemove?: (id: string) => void;
}

export interface NavTool { id: string; label: string; href: string; icon: LucideIcon; tint: [string, string]; count: number }

/** Тот же тип данных, что кладёт плитка «Ещё» при перетаскивании (features/more/navTools). */
const NAV_TOOL_DRAG = 'application/x-shar-tool';

/** Аватар в углу меню и его всплывающее меню — как в старой нижней полосе. */
function AccountButton({ account }: { account: NonNullable<AppShellProps['account']> }) {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const { palette, toggleTheme } = useTheme();
  const nextPalette = PALETTES[(PALETTES.indexOf(palette) + 1) % PALETTES.length];
  const nextPaletteName = { light: 'Светлая', gray: 'Серая', graphite: 'Графитовая', black: 'Чёрная' }[nextPalette];
  return (
    <>
      <button
        type="button"
        className="nx-account"
        aria-label={`Аккаунт: ${account.name}`}
        aria-haspopup="menu"
        aria-expanded={Boolean(anchor)}
        onClick={(e) => setAnchor(anchor ? null : { element: e.currentTarget, align: 'end', side: 'above' })}
      >
        <Avatar name={account.name} seed={account.id} src={account.avatar} person online size={30} />
      </button>
      {anchor && (
        <Menu anchor={anchor} label="Аккаунт" onClose={() => setAnchor(null)}>
          <div className="nx-account-card">
            <Avatar name={account.name} seed={account.id} src={account.avatar} person online size={40} />
            <span className="nx-account-text">
              <b>{account.name}</b>
              {account.subtitle && <span>{account.subtitle}</span>}
            </span>
          </div>
          <div className="nx-menu-sep" />
          <MenuItem icon={<PaletteIcon size={16} />} onSelect={() => { toggleTheme(); setAnchor(null); }}>
            Следующая тема: {nextPaletteName}
          </MenuItem>
          <MenuItem icon={<Settings size={16} />} onSelect={() => { setAnchor(null); navigate(paths.settings); }}>
            Настройки
          </MenuItem>
        </Menu>
      )}
    </>
  );
}

function NavIcon({ icon }: { icon: string }) {
  return (
    <span className="nx-nav-icon" aria-hidden="true">
      <img src={`/icons/nav-v2/${icon}.png?v=6`} alt="" draggable={false} />
    </span>
  );
}

const Nav = memo(function Nav({ section, badges, visibleTabs, onReselect, account, navTools, onNavToolDrop, onNavToolRemove }: Omit<AppShellProps, 'children' | 'navHidden'>) {
  const listRef = useRef<HTMLUListElement>(null);
  // Подписи не влезают (узкое окно, много разделов) — только иконки, подпись у открытого раздела.
  // Раньше полоса молча прокручивалась, и крайний пункт («Ещё») уезжал под аватар. Ширину полосы
  // с подписями запоминаем, чтобы вернуть их, как только место появится, без дрожания туда-обратно.
  const [compact, setCompact] = useState(false);
  const fullWidth = useRef(0);
  const [dropping, setDropping] = useState(false);
  const [toolMenu, setToolMenu] = useState<{ id: string; anchor: MenuAnchor } | null>(null);
  const { pathname } = useLocation();

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === 'undefined') return undefined;
    const check = () => {
      if (window.matchMedia('(max-width: 640px)').matches) { setCompact(false); return; } // телефон листает капсулу
      setCompact((was) => {
        if (!was && list.scrollWidth > list.clientWidth + 1) { fullWidth.current = list.scrollWidth; return true; }
        if (was && list.clientWidth >= fullWidth.current) return false;
        return was;
      });
    };
    const ro = new ResizeObserver(check);
    ro.observe(list);
    check();
    return () => ro.disconnect();
  }, [visibleTabs, navTools?.length]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;

    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey || list.scrollWidth <= list.clientWidth) return;
      // Горизонтальный жест трекпада браузер уже обрабатывает сам.
      if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;

      let delta = event.deltaY;
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
        const styles = window.getComputedStyle(list);
        const lineHeight = Number.parseFloat(styles.lineHeight);
        const fontSize = Number.parseFloat(styles.fontSize);
        delta *= Number.isFinite(lineHeight) ? lineHeight : fontSize;
      }
      if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= list.clientWidth;

      const previous = list.scrollLeft;
      const limit = list.scrollWidth - list.clientWidth;
      list.scrollLeft = Math.max(0, Math.min(limit, previous + delta));

      // На краях ленты вертикальная прокрутка страницы остаётся доступной.
      if (list.scrollLeft !== previous) event.preventDefault();
    };

    list.addEventListener('wheel', handleWheel, { passive: false });
    return () => list.removeEventListener('wheel', handleWheel);
  }, []);

  // На телефоне лента пунктов листается: активный пункт должен быть виден.
  useEffect(() => {
    // Только своя лента: scrollIntoView прокрутил бы ещё и родителей.
    const list = listRef.current;
    const active = list?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!list || !active || list.scrollWidth <= list.clientWidth) return;
    const delta = active.getBoundingClientRect().left - list.getBoundingClientRect().left;
    list.scrollLeft += delta - (list.clientWidth - active.offsetWidth) / 2;
  }, [section]);

  return (
    <nav
      className="nx-nav"
      aria-label="Разделы"
      data-compact={compact ? 'true' : undefined}
      data-drop={dropping ? 'true' : undefined}
      onDragOver={(e) => { if (onNavToolDrop && e.dataTransfer.types.includes(NAV_TOOL_DRAG)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDropping(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false); }}
      onDrop={(e) => {
        setDropping(false);
        const id = e.dataTransfer.getData(NAV_TOOL_DRAG);
        if (id && onNavToolDrop) { e.preventDefault(); onNavToolDrop(id); }
      }}
    >
      <ul ref={listRef} className="nx-nav-list">
        {/* Открытый сейчас раздел виден, даже если скрыт, — иначе не понять, где ты. */}
        {SECTIONS.filter((s) => s.id === section || isTabVisible(visibleTabs, s.id)).map((s) => {
          const active = s.id === section;
          const count = badges?.[s.id] || 0;
          return (
            <li key={s.id} data-section={s.id}>
              <Link
                to={s.href}
                className="nx-nav-item"
                title={compact ? s.label : undefined}
                aria-label={compact ? s.label : undefined}
                aria-current={active ? 'page' : undefined}
                onClick={(e) => {
                  // Повторное нажатие — только на самой странице раздела; из вложенной
                  // (настройки внутри «Ещё») пункт ведёт обратно в раздел.
                  if (!active || window.location.pathname !== s.href) return;
                  e.preventDefault();
                  onReselect?.();
                }}
              >
                <NavIcon icon={s.icon} />
                <span className="nx-nav-label">{s.label}</span>
                {count > 0 && (
                  <span className="nx-count nx-nav-badge" aria-label={`Непрочитанных: ${count}`}>
                    {count > 99 ? '99+' : count}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
        {(navTools || []).map((t) => {
          const active = pathname === t.href;
          return (
            <li key={`tool-${t.id}`} data-tool={t.id}>
              <Link
                to={t.href}
                className="nx-nav-item"
                title={compact ? t.label : undefined}
                aria-label={compact ? t.label : undefined}
                aria-current={active ? 'page' : undefined}
                onContextMenu={(e) => { if (!onNavToolRemove) return; e.preventDefault(); setToolMenu({ id: t.id, anchor: { x: e.clientX, y: e.clientY } }); }}
              >
                <span className="nx-nav-icon nx-nav-tool" style={{ '--a': t.tint[0], '--b': t.tint[1] } as CSSProperties} aria-hidden="true"><t.icon size={13} /></span>
                <span className="nx-nav-label">{t.label}</span>
                {t.count > 0 && (
                  <span className="nx-count nx-nav-badge" aria-label={`Ждут внимания: ${t.count}`}>{t.count > 99 ? '99+' : t.count}</span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
      {toolMenu && (
        <Menu anchor={toolMenu.anchor} label="Инструмент в меню" onClose={() => setToolMenu(null)}>
          <MenuItem icon={<PinOff size={16} />} onSelect={() => { const id = toolMenu.id; setToolMenu(null); onNavToolRemove?.(id); }}>Убрать из меню</MenuItem>
        </Menu>
      )}
      {account && <AccountButton account={account} />}
    </nav>
  );
});

export default function AppShell({ section, children, badges, visibleTabs, navHidden, onReselect, account, navTools, onNavToolDrop, onNavToolRemove }: AppShellProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  useViewportSync(rootRef);
  return (
    <div ref={rootRef} className="nx nx-app" data-nav-hidden={navHidden ? 'true' : undefined}>
      <main className="nx-app-main">{children}</main>
      <Nav section={section} badges={badges} visibleTabs={visibleTabs} onReselect={onReselect} account={account}
        navTools={navTools} onNavToolDrop={onNavToolDrop} onNavToolRemove={onNavToolRemove} />
      {/* Внутри корня .nx — там живут токены, на которых держится Toast. */}
      <ToastContainer />
    </div>
  );
}
