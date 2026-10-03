import { createContext, useContext, useEffect, useRef } from 'react';

/**
 * Связь раздела с общим каркасом. Каркас (app/AppRoot) живёт над маршрутами и не
 * пересоздаётся при переходе между разделами; раздел сообщает ему только то,
 * что зависит от его состояния: спрятать ли капсулу меню (на телефоне открыта
 * деталь) и что делать при повторном нажатии на свой пункт меню.
 */

export interface ShellOptions {
  navHidden?: boolean;
  onReselect?: () => void;
}

export const ShellContext = createContext<(o: ShellOptions) => void>(() => {});

export function useShellOptions({ navHidden, onReselect }: ShellOptions) {
  const set = useContext(ShellContext);
  const reselect = useRef(onReselect);
  useEffect(() => { reselect.current = onReselect; });
  useEffect(() => { set({ navHidden, onReselect: () => reselect.current?.() }); }, [set, navHidden]);
  // Ушли из раздела — его настройки не должны достаться следующему.
  useEffect(() => () => set({}), [set]);
}
