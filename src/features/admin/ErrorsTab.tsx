import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, RefreshCw, Trash2 } from 'lucide-react';
import { SearchField } from '@/shared/ui/SearchField';
import { askConfirm } from '@/shared/ui/overlay';
import { clearClientErrors, loadClientErrors, timeAgo, type ClientError } from './api';

/** Короткое «что за устройство» из userAgent — чтобы список читался глазами. */
function device(ua?: string): string {
  if (!ua) return '';
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  const br = /Electron/.test(ua) ? 'Шар для ПК' : /CriOS|Chrome/.test(ua) ? 'Chrome' : /Firefox/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : '';
  return [os, br].filter(Boolean).join(' · ');
}

const KIND_TONE: Record<string, string> = { error: 'danger', server: 'danger', unhandledrejection: 'warn', react: 'accent', health: 'accent', manual: 'accent' };

export default function ErrorsTab() {
  const [errors, setErrors] = useState<ClientError[] | null>(null);
  const [retention, setRetention] = useState(3);
  const [loadedAt, setLoadedAt] = useState(0);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await loadClientErrors();
      setErrors(r.errors);
      setRetention(r.retentionDays);
      setLoadedAt(Date.now());
      setFailed(false);
    } catch { setFailed(true); setErrors((e) => e ?? []); }
  }, []);
  useEffect(() => {
    void load();
    const onFocus = () => { void load(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const clear = async () => {
    if (!(await askConfirm({ title: 'Очистить журнал ошибок?', text: 'Записи удалятся у всех.', confirm: 'Очистить', tone: 'danger' }))) return;
    try { await clearClientErrors(); void load(); } catch { setFailed(true); }
  };

  const q = query.trim().toLowerCase();
  const list = useMemo(() => (errors || []).filter((e) => !q || `${e.message} ${e.userName || ''} ${e.url || ''} ${e.kind}`.toLowerCase().includes(q)), [errors, q]);
  const toggle = (key: string) => setOpen((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  return (
    <section className="nx-block">
      <div className="nad-toolbar">
        <SearchField value={query} onChange={setQuery} placeholder="Текст, пользователь, адрес" label="Поиск по ошибкам" className="nad-search" />
        <div className="nad-toolbar-actions">
          <span className="nx-note">{list.length} · хранятся ~{retention} дн{loadedAt ? ` · обновлено ${timeAgo(loadedAt)}` : ''}</span>
          <button type="button" className="nx-icon-btn" aria-label="Обновить" onClick={() => void load()}><RefreshCw size={15} /></button>
          <button type="button" className="nx-icon-btn" aria-label="Очистить журнал" disabled={!errors?.length} onClick={() => void clear()}><Trash2 size={15} /></button>
        </div>
      </div>
      {failed && <p className="nx-error" role="alert">Список не загрузился — нет связи с сервером.</p>}
      {errors === null ? (
        <div className="nx-group" aria-busy="true"><div className="nx-row"><span className="nx-skel nx-skel-line" style={{ width: '70%' }} /></div></div>
      ) : list.length === 0 ? (
        <div className="nx-state"><h2>{errors.length ? 'Ничего не нашлось' : 'Ошибок нет'}</h2><p>Сюда автоматически попадают сбои со всех устройств и сервера.</p></div>
      ) : (
        <div className="nx-group">
          {list.map((e, i) => {
            const key = `${e.ts}-${i}`;
            const expandable = Boolean(e.stack || (e.extra && Object.keys(e.extra).length));
            const isOpen = open.has(key);
            return (
              <div key={key} className="nad-error">
                <button type="button" className="nx-row nad-error-head" aria-expanded={expandable ? isOpen : undefined} disabled={!expandable} onClick={() => toggle(key)}>
                  <span className="nad-chevron" aria-hidden="true">{expandable ? (isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : null}</span>
                  <span className="nx-row-text">
                    <span className="nx-row-label"><span className="nx-tag" data-tone={KIND_TONE[e.kind]}>{e.kind}</span> <span className="nad-error-msg">{e.message}</span></span>
                    <span className="nx-row-hint">
                      {[e.userName, timeAgo(e.ts), device(e.userAgent), e.extra?.viewport ? String(e.extra.viewport) : '', e.extra?.standalone ? 'PWA' : '', e.appVersion ? `v${e.appVersion}` : '']
                        .filter(Boolean).join(' · ')}
                    </span>
                    {e.url && <span className="nx-row-hint nad-error-url">{e.url}</span>}
                  </span>
                </button>
                {isOpen && (
                  <div className="nad-error-body">
                    {e.stack && <pre>{e.stack}</pre>}
                    {e.extra && Object.keys(e.extra).length > 0 && <pre>{JSON.stringify(e.extra, null, 2)}</pre>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
