/**
 * Переход внутри приложения из кода, который не является компонентом
 * (сторы, сервисы, обработчики уведомлений). Корень приложения регистрирует
 * навигатор роутера; до этого — обычный переход по адресу.
 */

type Navigator = (to: string, opts?: { replace?: boolean }) => void;

let current: Navigator | null = null;

export function setNavigator(nav: Navigator | null) {
  current = nav;
}

export function navigate(to: string, opts?: { replace?: boolean }) {
  if (/^https?:\/\//.test(to) && !to.startsWith(window.location.origin)) {
    window.location.assign(to);
    return;
  }
  if (current) current(to, opts);
  else if (opts?.replace) window.location.replace(to);
  else window.location.assign(to);
}
