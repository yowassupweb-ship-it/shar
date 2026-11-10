import { create } from 'zustand';

/**
 * Открыто ли окно поиска по Шару. Хранилище вынесено из Spotlight.tsx в отдельный маленький модуль: при горячей
 * перезагрузке (dev) правка большого компонента пересоздавала бы хранилище, и кнопка в заголовке с Ctrl+K переключали
 * бы уже не то, что слушает окно, — поиск «не включался» до обновления страницы.
 */
export const useSpotlight = create<{ open: boolean }>(() => ({ open: false }));
export const openSpotlight = () => useSpotlight.setState({ open: true });
export const closeSpotlight = () => useSpotlight.setState({ open: false });
