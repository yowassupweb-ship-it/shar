import { lazy, Suspense, type ComponentProps, type ComponentType } from 'react';

/**
 * Компонент, код которого грузится при первом показе (просмотрщик, редактор
 * опроса). Ничего не рисует, пока чанк не пришёл, — как next/dynamic без SSR.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyComponent<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  const Lazy = lazy(load);
  return function LazyComponent(props: ComponentProps<T>) {
    return (
      <Suspense fallback={null}>
        <Lazy {...props} />
      </Suspense>
    );
  };
}
