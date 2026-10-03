import { Laptop } from 'lucide-react';
import { useTheme, type Palette } from './ThemeContext';

const OPTIONS: { id: Palette; label: string }[] = [
  { id: 'light', label: 'Светлая' },
  { id: 'gray', label: 'Серая' },
  { id: 'graphite', label: 'Графитовая' },
  { id: 'black', label: 'Чёрная' },
];

/** Выбор темы: Светлая → Серая → Графитовая → Чёрная, плюс «Как в системе». */
export function ThemePicker({ label = 'Тема' }: { label?: string }) {
  const { themePref, setThemePref } = useTheme();
  return (
    <div className="nx-theme-picker" role="group" aria-label={label}>
      {OPTIONS.map((o) => (
        <button key={o.id} type="button" className="nx-theme-opt" aria-pressed={themePref === o.id} onClick={() => setThemePref(o.id)}>
          <span className="nx-theme-swatch" data-palette={o.id} aria-hidden="true" />
          <span>{o.label}</span>
        </button>
      ))}
      <button type="button" className="nx-theme-opt" aria-pressed={themePref === 'system'} onClick={() => setThemePref('system')}>
        <span className="nx-theme-swatch" data-palette="system" aria-hidden="true"><Laptop size={12} /></span>
        <span>Как в системе</span>
      </button>
    </div>
  );
}
