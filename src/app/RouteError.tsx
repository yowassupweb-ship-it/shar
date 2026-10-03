import { useEffect, useMemo } from 'react';
import { useRouteError } from 'react-router';
import { RotateCw } from 'lucide-react';
import { reportClientError } from '@/shared/platform/telemetry';

/**
 * Сбой раздела. Без этого экрана любая ошибка рендера оставляла пустую
 * страницу до Ctrl+F5.
 *
 * Устаревшие куски сборки после выката (чанк больше не существует) лечатся
 * одной автоматической перезагрузкой; в остальных случаях — понятный текст и
 * кнопки: попробовать снова (без перезагрузки) или перезагрузить.
 */
const RELOAD_KEY = 'nx:error-reload-at';

export default function RouteError() {
  const raw = useRouteError();
  const error = useMemo(() => (raw instanceof Error ? raw : new Error(String(raw))), [raw]);

  useEffect(() => {
    console.error('[shar] section crashed:', error);
    reportClientError('react', error, { boundary: 'shar-v2-route' });
  }, [error]);

  useEffect(() => {
    const stale = /ChunkLoadError|Loading chunk|dynamically imported module|Importing a module script failed/i.test(`${error.name} ${error.message}`);
    if (!stale) return;
    try {
      const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
      if (Date.now() - last < 15000) return; // уже перезагружались — не зацикливаемся
      sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    } catch { /* нет хранилища — перезагрузим один раз всё равно */ }
    window.location.reload();
  }, [error]);

  return (
    <div className="nx-state" role="alert">
      <RotateCw size={28} aria-hidden="true" />
      <h2>Раздел не открылся</h2>
      <p>Что-то сломалось при отрисовке — данные на месте. Попробуйте ещё раз; если не поможет — перезагрузите страницу.</p>
      <div className="nx-dialog-actions" style={{ justifyContent: 'center', marginTop: 0 }}>
        <button type="button" className="nx-ghost" onClick={() => window.history.go(0)}>Попробовать снова</button>
        <button type="button" className="nx-primary" onClick={() => window.location.reload()}>Перезагрузить</button>
      </div>
    </div>
  );
}
