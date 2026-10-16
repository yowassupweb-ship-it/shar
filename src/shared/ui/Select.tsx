import { useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Menu, MenuItem, type MenuAnchor } from './overlay';

export interface SelectOption { value: string; label: string; /** Вложенный пункт (подотдел) — со сдвигом. */ indent?: boolean }
export interface SelectGroup { label?: string; options: SelectOption[] }

/**
 * Выпадающий список в стиле Шара вместо системного <select>: то же стеклянное меню, что и везде, галочка у выбранного,
 * заголовки групп, управление с клавиатуры (↑ ↓ Enter Esc). Список не уже своей кнопки.
 * `placeholder` показывается, пока значение не выбрано (пустая строка).
 */
export function Select({ value, onChange, groups, label, placeholder, className, disabled }: {
  value: string;
  onChange: (value: string) => void;
  groups: SelectGroup[];
  /** Название поля для скринридера и для меню. */
  label: string;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  const [anchor, setAnchor] = useState<(MenuAnchor & { element: HTMLElement }) | null>(null);
  const current = groups.flatMap((g) => g.options).find((o) => o.value === value);

  return (
    <>
      <button
        type="button"
        className={`nx-select${className ? ` ${className}` : ''}`}
        data-empty={current ? undefined : 'true'}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={Boolean(anchor)}
        disabled={disabled}
        onClick={(e) => setAnchor(anchor ? null : { element: e.currentTarget, align: 'start' })}
      >
        <span className="nx-select-value">{current?.label ?? placeholder ?? ''}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {anchor && (
        <Menu anchor={anchor} label={label} onClose={() => setAnchor(null)} minWidth={anchor.element.getBoundingClientRect().width}>
          {groups.map((group, i) => (
            <div key={group.label ?? i} role="presentation">
              {group.label && <div className="nx-menu-label" role="presentation">{group.label}</div>}
              {group.options.map((o) => (
                <MenuItem
                  key={o.value}
                  icon={o.value === value ? <Check size={15} /> : <span className="nx-menu-blank" aria-hidden="true" />}
                  onSelect={() => { setAnchor(null); if (o.value !== value) onChange(o.value); }}
                >
                  <span style={o.indent ? { paddingLeft: 12 } : undefined}>{o.label}</span>
                </MenuItem>
              ))}
            </div>
          ))}
        </Menu>
      )}
    </>
  );
}
