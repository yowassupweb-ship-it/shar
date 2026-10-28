import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Menu, MenuItem, type MenuAnchor } from '@/shared/ui/overlay';

export interface BarItem {
  label: string;
  onSelect: () => void;
  /** Подсказка справа: сочетание клавиш. */
  hint?: string;
  icon?: ReactNode;
  tone?: 'danger';
  disabled?: boolean;
}
export interface BarMenu {
  id: string;
  label: string;
  items: Array<BarItem | 'sep'>;
}

/** Наведение открывает меню не сразу: курсор, идущий через строку к ленте, его не раскрывает. Нажатие — сразу. */
const OPEN_DELAY = 350;
const CLOSE_DELAY = 350;

/**
 * Строка меню под названием, как в Google Документах и Таблицах: «Файл, Правка, Вид, Вставка, Формат…».
 * Меню открывается наведением (и нажатием), соседние — переходом по строке; увели курсор и с меню, и со строки —
 * закрывается. menus — функция: меню собирается в момент показа, чтобы доступность команд редактора была свежей.
 */
export function MenuBar({ menus: build, onDownloadAnchor }: { menus: () => BarMenu[]; onDownloadAnchor?: (el: HTMLElement | null) => void }) {
  const menus = build();
  const [open, setOpen] = useState<{ id: string; anchor: MenuAnchor } | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const bar = useRef<HTMLElement>(null);
  const openTimer = useRef(0);
  const current = menus.find((m) => m.id === open?.id);

  const show = (id: string) => {
    const el = buttons.current.get(id);
    if (!el) return;
    onDownloadAnchor?.(el);
    setOpen((cur) => (cur?.id === id ? cur : { id, anchor: { element: el, align: 'start' } }));
  };

  // Пока меню открыто, следим за курсором: ушёл и со строки, и с самого меню — закрываем с небольшой задержкой,
  // чтобы диагональный путь от названия к пункту меню не закрывал его.
  useEffect(() => {
    if (!open) return undefined;
    let closeTimer = 0;
    const onMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      const target = event.target as Element | null;
      const inside = Boolean(target && (bar.current?.contains(target) || target.closest('[role="menu"]')));
      if (inside) { window.clearTimeout(closeTimer); closeTimer = 0; return; }
      if (!closeTimer) closeTimer = window.setTimeout(() => setOpen(null), CLOSE_DELAY);
    };
    document.addEventListener('pointermove', onMove);
    return () => { document.removeEventListener('pointermove', onMove); window.clearTimeout(closeTimer); };
  }, [open]);
  useEffect(() => () => window.clearTimeout(openTimer.current), []);

  return (
    <nav ref={bar} className="nws-bar" aria-label="Меню материала" role="menubar">
      {menus.map((menu) => (
        <button
          key={menu.id}
          ref={(el) => { if (el) buttons.current.set(menu.id, el); else buttons.current.delete(menu.id); }}
          type="button"
          role="menuitem"
          className="nws-bar-btn"
          aria-haspopup="menu"
          aria-expanded={open?.id === menu.id}
          onClick={() => { window.clearTimeout(openTimer.current); if (open?.id === menu.id) setOpen(null); else show(menu.id); }}
          onPointerEnter={(e) => {
            if (e.pointerType === 'touch') return;
            window.clearTimeout(openTimer.current);
            if (open) show(menu.id);
            else openTimer.current = window.setTimeout(() => show(menu.id), OPEN_DELAY);
          }}
          onPointerLeave={() => window.clearTimeout(openTimer.current)}
        >
          {menu.label}
        </button>
      ))}
      {open && current && (
        <Menu anchor={open.anchor} label={current.label} onClose={() => setOpen(null)} minWidth={240}>
          {current.items.map((item, index) => (item === 'sep'
            ? <div key={`sep-${index}`} className="nx-menu-sep" />
            : (
              <MenuItem key={item.label} icon={item.icon} tone={item.tone} disabled={item.disabled} onSelect={() => { setOpen(null); item.onSelect(); }}>
                <span className="nws-bar-item">{item.label}{item.hint && <kbd className="nws-bar-hint">{item.hint}</kbd>}</span>
              </MenuItem>
            )))}
        </Menu>
      )}
    </nav>
  );
}
