import { create } from 'zustand';

/**
 * «Ядро» как выдвижная панель справа: открыта ли, какой ширины и какой чат в ней открыт.
 * Живёт над разделами (AppShell), поэтому переписка не пропадает при переходе между ними.
 * Всё помним на устройстве — панель открывается там же, где её закрыли.
 */

const KEY = 'nx:core-panel';
export const PANEL_MIN = 360;
export const PANEL_DEFAULT = 440;

interface Saved { open: boolean; width: number; thread: string | null }

function read(): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null') as Partial<Saved> | null;
    return { open: raw?.open === true, width: Number(raw?.width) || PANEL_DEFAULT, thread: typeof raw?.thread === 'string' ? raw.thread : null };
  } catch {
    return { open: false, width: PANEL_DEFAULT, thread: null };
  }
}

export const useCorePanel = create<Saved>(read);

useCorePanel.subscribe((s) => {
  try { localStorage.setItem(KEY, JSON.stringify({ open: s.open, width: s.width, thread: s.thread })); } catch { /* приватный режим */ }
});

export const toggleCorePanel = () => useCorePanel.setState((s) => ({ open: !s.open }));
export const closeCorePanel = () => useCorePanel.setState({ open: false });
export const setCorePanelThread = (thread: string | null) => useCorePanel.setState({ thread });

/** Ширина: не уже PANEL_MIN и не шире 60% окна — разделу слева должно остаться место. */
export function setCorePanelWidth(width: number) {
  const max = Math.max(PANEL_MIN, Math.round(window.innerWidth * 0.6));
  useCorePanel.setState({ width: Math.min(max, Math.max(PANEL_MIN, Math.round(width))) });
}
