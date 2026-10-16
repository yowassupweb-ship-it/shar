import type { MouseEvent } from 'react';

/**
 * Скачать файл. В приложении — силами окна (диалог «Сохранить как» с этим именем): ссылка <a download> на
 * /api/uploads уходит редиректом на хранилище (другой домен), браузер игнорирует download, а Electron уводил
 * переход во внешний браузер. В браузере — обычная ссылка со скачиванием.
 */
export function downloadFile(url: string, name?: string): void {
  if (!url) return;
  const desktop = window.sharDesktop?.downloadFile;
  if (desktop) {
    void desktop(new URL(url, window.location.href).href, name || '');
    return;
  }
  const link = document.createElement('a');
  link.href = url;
  if (name) link.download = name;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
}

/** Для <a href download>: в приложении перехватывает клик и качает через окно; в браузере ссылка работает сама. */
export function downloadOnClick(url: string, name?: string) {
  return (event: MouseEvent<HTMLElement>) => {
    event.stopPropagation();
    if (!window.sharDesktop?.downloadFile) return;
    event.preventDefault();
    downloadFile(url, name);
  };
}
