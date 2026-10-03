import { createContext, useContext, useState, useEffect, ReactNode } from 'react';

/** Палитра: Светлая → Серая → Графитовая → Чёрная. */
export type Palette = 'light' | 'gray' | 'graphite' | 'black';
export const PALETTES: readonly Palette[] = ['light', 'gray', 'graphite', 'black'];
/** Семейство: всё, что не светлое, — тёмное (для внешнего вида чата, писем и т. п.). */
type Theme = 'light' | 'dark';
type ThemePref = Palette | 'system';

interface ThemeContextType {
  theme: Theme;            // семейство: light | dark
  palette: Palette;        // точная палитра (system уже разрешён)
  themePref: ThemePref;    // что выбрал пользователь
  toggleTheme: () => void; // светлая ↔ последняя тёмная
  setTheme: (theme: Theme) => void;
  setThemePref: (pref: ThemePref) => void;
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Старые значения: 'dark' — это теперь Графитовая. */
function normalize(raw: string | null): ThemePref | null {
  if (raw === 'dark') return 'graphite';
  return raw === 'system' || (PALETTES as readonly string[]).includes(raw || '') ? (raw as ThemePref) : null;
}

function loadThemePref(): ThemePref {
  if (typeof localStorage === 'undefined') return 'light';
  return normalize(localStorage.getItem('themePref')) || (localStorage.getItem('theme') === 'dark' ? 'graphite' : 'light');
}

function loadLastDark(): Palette {
  try {
    const p = localStorage.getItem('themeLastDark');
    return p === 'gray' || p === 'graphite' || p === 'black' ? p : 'graphite';
  } catch { return 'graphite'; }
}

function resolve(pref: ThemePref): Palette {
  return pref === 'system' ? (systemPrefersDark() ? loadLastDark() : 'light') : pref;
}

const familyOf = (p: Palette): Theme => (p === 'light' ? 'light' : 'dark');

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

// layout.tsx's inline <script> already reads localStorage and applies the
// `dark` class / data-theme attribute to <html> synchronously, before React
// even mounts — most of the app's dark-mode styling flows through CSS
// variables keyed off that class, so it's correct from the very first paint.
// This component's own React `theme` state used to always start at 'light'
// regardless (correcting only after a useEffect re-read localStorage), so
// anything reading `theme` directly — like inline `theme === 'dark' ? ... :
// ...` styling, rather than the CSS variables — showed the wrong colors
// until that effect caught up (and, worse, could stay stuck wrong after a
// hydration mismatch, since nothing else re-triggers that specific render).
// Reading the same already-correct class here immediately keeps the two
// mechanisms in sync from the start instead of racing each other.
function getInitialPalette(): Palette {
  if (typeof document === 'undefined') return 'light';
  const attr = document.documentElement.getAttribute('data-theme');
  return (PALETTES as readonly string[]).includes(attr || '') ? (attr as Palette) : document.documentElement.classList.contains('dark') ? 'graphite' : 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [palette, setPalette] = useState<Palette>(getInitialPalette);
  const [themePref, setThemePrefState] = useState<ThemePref>(loadThemePref);

  // Системная тема: следим за ОС (авторасписание iOS, пункт управления).
  useEffect(() => {
    if (themePref !== 'system' || !window.matchMedia) return undefined;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setPalette(resolve('system'));
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [themePref]);

  // Применяем к <html> и запоминаем. boot.js делает то же до React — без мигания.
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', palette);
    root.classList.toggle('dark', palette !== 'light');
    try {
      localStorage.setItem('theme', familyOf(palette));
      localStorage.setItem('themePref', themePref);
      if (palette !== 'light') localStorage.setItem('themeLastDark', palette);
    } catch { /* нет хранилища — тема на сессию */ }
  }, [palette, themePref]);

  // Тема, выбранная в другой вкладке.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== 'themePref') return;
      const pref = loadThemePref();
      setThemePrefState(pref);
      setPalette(resolve(pref));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setThemePref = (pref: ThemePref) => {
    setThemePrefState(pref);
    setPalette(resolve(pref));
  };
  const toggleTheme = () => setThemePref(palette === 'light' ? loadLastDark() : 'light');
  const setTheme = (t: Theme) => setThemePref(t === 'light' ? 'light' : loadLastDark());
  const theme = familyOf(palette);

  return (
    <ThemeContext.Provider value={{ theme, palette, themePref, toggleTheme, setTheme, setThemePref }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
