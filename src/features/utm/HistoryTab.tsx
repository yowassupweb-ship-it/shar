import { useCallback, useEffect, useMemo, useState } from 'react';
import { Select } from '@/shared/ui/Select';
import { Copy, ExternalLink, History, RotateCw, Trash2 } from 'lucide-react';
import { SearchField } from '@/shared/ui/SearchField';
import { askConfirm } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import { loadHistory, parseUtm, PLATFORMS, removeFromHistory, type TrackedLink } from './api';

const fmt = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

function Filter({ label, value, options, onChange, all }: { label: string; value: string; options: { id: string; name: string }[]; onChange: (v: string) => void; all: string }) {
  return (
    <label className="nx-label nutm-filter">
      {label}
      <Select label={label} value={value} onChange={onChange}
        groups={[{ options: [{ value: '', label: all }, ...options.map((o) => ({ value: o.id, label: o.name }))] }]} />
    </label>
  );
}

export default function HistoryTab() {
  const [items, setItems] = useState<TrackedLink[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [f, setF] = useState({ source: '', medium: '', campaign: '', platform: '' });

  const load = useCallback(async () => {
    try { setItems(await loadHistory()); setFailed(false); }
    catch { setFailed(true); setItems((cur) => cur ?? []); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const withUtm = useMemo(() => (items || []).map((it) => ({ it, utm: parseUtm(it.utmUrl) })), [items]);
  const uniq = (k: 'source' | 'medium' | 'campaign') =>
    Array.from(new Set(withUtm.map((x) => x.utm[k]).filter(Boolean))).sort().map((v) => ({ id: v, name: v }));

  const q = query.trim().toLowerCase();
  const list = withUtm.filter(({ it, utm }) =>
    (!q || [it.title, it.utmUrl, utm.campaign].some((v) => (v || '').toLowerCase().includes(q)))
    && (!f.source || utm.source === f.source) && (!f.medium || utm.medium === f.medium)
    && (!f.campaign || utm.campaign === f.campaign) && (!f.platform || it.platform === f.platform));
  const filtered = Boolean(q || f.source || f.medium || f.campaign || f.platform);

  const copy = async (url: string) => {
    try { await navigator.clipboard.writeText(url); showToast('Скопировано', 'success'); } catch { showToast('Не удалось скопировать', 'error'); }
  };
  const remove = async (it: TrackedLink) => {
    if (!(await askConfirm({ title: 'Удалить ссылку из истории?', text: it.title || it.utmUrl, confirm: 'Удалить', tone: 'danger' }))) return;
    try { await removeFromHistory(it.id); setItems((cur) => (cur || []).filter((x) => x.id !== it.id)); }
    catch { showToast('Не удалилось', 'error'); }
  };

  return (
    <>
      <div className="nutm-filters">
        <SearchField value={query} onChange={setQuery} placeholder="Название или ссылка" label="Поиск по истории" className="nutm-history-search" />
        <Filter label="utm_source" value={f.source} options={uniq('source')} all="Все" onChange={(v) => setF({ ...f, source: v })} />
        <Filter label="utm_medium" value={f.medium} options={uniq('medium')} all="Все" onChange={(v) => setF({ ...f, medium: v })} />
        <Filter label="utm_campaign" value={f.campaign} options={uniq('campaign')} all="Все" onChange={(v) => setF({ ...f, campaign: v })} />
        <Filter label="Площадка" value={f.platform} options={PLATFORMS} all="Все" onChange={(v) => setF({ ...f, platform: v })} />
      </div>

      <section className="nx-block">
        <div className="nx-block-head">
          <h2 className="nx-block-title">{items ? `${list.length} ${filtered ? 'найдено' : 'ссылок'}` : 'История'}</h2>
          <div className="nx-inline">
            {filtered && <button type="button" className="nx-ghost" onClick={() => { setQuery(''); setF({ source: '', medium: '', campaign: '', platform: '' }); }}>Сбросить фильтры</button>}
            <button type="button" className="nx-icon-btn" aria-label="Обновить" onClick={() => void load()}><RotateCw size={15} /></button>
          </div>
        </div>
        {failed && <p className="nx-error" role="alert">История не загрузилась — нет связи с сервером.</p>}
        {items === null ? (
          <div className="nx-group" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="nx-row"><span className="nx-skel nx-skel-line" style={{ width: `${70 - i * 10}%` }} /></div>)}</div>
        ) : list.length === 0 ? (
          <div className="nx-state">
            <History size={24} aria-hidden="true" />
            <h2>{filtered ? 'Ничего не нашлось' : 'История пуста'}</h2>
            <p>{filtered ? 'Попробуйте другие фильтры.' : 'Скопируйте ссылку в генераторе — она появится здесь.'}</p>
          </div>
        ) : (
          <div className="nx-group">
            {list.map(({ it, utm }) => (
              <div key={it.id} className="nx-row nutm-item">
                <span className="nx-row-text">
                  <span className="nx-row-label">
                    <span className="nx-tag">{PLATFORMS.find((p) => p.id === it.platform)?.name || 'Другое'}</span>
                    <span className="nutm-item-title">{it.title || 'Без названия'}</span>
                  </span>
                  <code className="nutm-url nutm-url-small">{it.utmUrl}</code>
                  <span className="nx-row-hint">
                    {[fmt(it.createdAt), ...(['source', 'medium', 'campaign', 'term', 'content'] as const).filter((k) => utm[k]).map((k) => `${k}: ${utm[k]}`)].join(' · ')}
                  </span>
                </span>
                <span className="nutm-visits" title="Визитов по ссылке"><b>{it.views || 0}</b><small>визитов</small></span>
                <span className="nx-row-actions">
                  <button type="button" className="nx-icon-btn" aria-label="Копировать" onClick={() => void copy(it.utmUrl)}><Copy size={15} /></button>
                  <a className="nx-icon-btn" href={it.utmUrl} target="_blank" rel="noopener noreferrer" aria-label="Открыть"><ExternalLink size={15} /></a>
                  <button type="button" className="nx-icon-btn" aria-label="Удалить" onClick={() => void remove(it)}><Trash2 size={15} /></button>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
