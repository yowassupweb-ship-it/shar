import { useMemo, useState } from 'react';
import { Check, Copy, ExternalLink, Link2, RotateCcw, X } from 'lucide-react';
import { showToast } from '@/shared/ui/Toast';
import { addToHistory, detectPlatform, EMPTY_PARAMS, normalizeUrl, titleFor, withUtm, type Preset, type UtmParams } from './api';

const FIELDS: { key: keyof UtmParams; label: string; placeholder: string; required?: boolean }[] = [
  { key: 'source', label: 'utm_source', placeholder: 'yandex', required: true },
  { key: 'medium', label: 'utm_medium', placeholder: 'cpc', required: true },
  { key: 'campaign', label: 'utm_campaign', placeholder: 'summer_sale' },
  { key: 'term', label: 'utm_term', placeholder: 'ключевое слово' },
  { key: 'content', label: 'utm_content', placeholder: 'banner_1' },
];

export default function GeneratorTab({ presets }: { presets: Preset[] }) {
  const [urls, setUrls] = useState('');
  const [params, setParams] = useState<UtmParams>(EMPTY_PARAMS);
  const [presetId, setPresetId] = useState<string | null>(null);
  const [copied, setCopied] = useState<'all' | number | null>(null);
  const [saving, setSaving] = useState(false);

  const lines = useMemo(() => urls.split('\n').map((s) => s.trim()).filter(Boolean), [urls]);
  const parsed = useMemo(() => lines.map((raw) => ({ raw, url: normalizeUrl(raw) })), [lines]);
  const valid = parsed.filter((p): p is { raw: string; url: string } => Boolean(p.url));
  const invalid = parsed.filter((p) => !p.url);
  const results = valid.map((p) => ({ original: p.url, utm: withUtm(p.url, params) }));
  const missing = FIELDS.filter((f) => f.required && !params[f.key].trim());

  const setParam = (k: keyof UtmParams, v: string) => {
    setParams((p) => ({ ...p, [k]: v }));
    if (k === 'source' || k === 'medium') setPresetId(null);
  };

  const apply = (p: Preset) => {
    setParams((cur) => ({ source: p.source, medium: p.medium, campaign: p.campaign || cur.campaign, term: p.term || cur.term, content: p.content || cur.content }));
    setPresetId(p.id);
  };

  const flash = (what: 'all' | number) => { setCopied(what); window.setTimeout(() => setCopied((c) => (c === what ? null : c)), 1800); };

  /** Копируем и сохраняем в историю — как раньше: история и есть журнал выданных ссылок. */
  const copy = async (which: 'all' | number) => {
    const picked = which === 'all' ? results : [results[which]];
    try { await navigator.clipboard.writeText(picked.map((r) => r.utm).join('\n')); }
    catch { showToast('Не удалось скопировать', 'error'); return; }
    flash(which);
    setSaving(true);
    const platform = detectPlatform(params.source, presetId);
    const outcomes = await Promise.allSettled(picked.map((r, i) => addToHistory({
      platform, postUrl: r.original, utmUrl: r.utm, clicks: 0, views: 0, conversions: 0,
      title: titleFor(r.original, params.campaign, which === 'all' ? i : which, results.length),
    })));
    setSaving(false);
    const ok = outcomes.filter((o) => o.status === 'fulfilled').length;
    if (ok === picked.length) showToast(picked.length === 1 ? 'Скопировано и сохранено в историю' : `Скопировано и сохранено: ${ok}`, 'success');
    else showToast(`Скопировано, но в историю сохранено ${ok} из ${picked.length}`, 'error');
  };

  const reset = () => { setUrls(''); setParams(EMPTY_PARAMS); setPresetId(null); };

  return (
    <div className="nutm-layout">
      <div className="nutm-form">
        {presets.length > 0 && (
          <section className="nx-block">
            <h2 className="nx-block-title">Пресеты</h2>
            <div className="nutm-presets" role="radiogroup" aria-label="Пресеты источников">
              {presets.map((p) => (
                <button key={p.id} type="button" role="radio" aria-checked={presetId === p.id} className="nutm-chip" title={p.description}
                  style={{ '--c': p.color } as React.CSSProperties} onClick={() => apply(p)}>
                  <i aria-hidden="true" /> {p.name}
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="nx-block">
          <h2 className="nx-block-title">Ссылки — по одной на строку</h2>
          <label className="nx-label">
            <span className="nx-sr">Ссылки</span>
            <textarea rows={Math.min(8, Math.max(3, lines.length + 1))} value={urls} placeholder={'https://vokrug-sveta.ru/tours/…\nhttps://…'}
              spellCheck={false} onChange={(e) => setUrls(e.target.value)} />
          </label>
          {invalid.length > 0 && <p className="nx-error">Не похоже на адрес: {invalid.map((p) => p.raw).slice(0, 3).join(', ')}{invalid.length > 3 ? '…' : ''}</p>}
        </section>

        <section className="nx-block">
          <h2 className="nx-block-title">Метки</h2>
          <div className="nx-group">
            {FIELDS.map((f) => (
              <div key={f.key} className="nx-row nutm-param">
                <label className="nutm-param-name" htmlFor={`nutm-${f.key}`}>{f.label}{f.required && <span aria-hidden="true"> *</span>}</label>
                <span className="nx-field" data-variant="filter">
                  <input id={`nutm-${f.key}`} value={params[f.key]} placeholder={f.placeholder} spellCheck={false} autoCapitalize="none"
                    onChange={(e) => setParam(f.key, e.target.value)} />
                  {params[f.key] && <button type="button" className="nx-search-clear" aria-label={`Очистить ${f.label}`} onClick={() => setParam(f.key, '')}><X size={13} /></button>}
                </span>
              </div>
            ))}
          </div>
          <div className="nx-actions">
            <button type="button" className="nx-ghost" onClick={reset}><RotateCcw size={14} aria-hidden="true" /> Очистить</button>
          </div>
        </section>
      </div>

      <section className="nx-block nutm-result" aria-live="polite">
        <div className="nx-block-head">
          <h2 className="nx-block-title">Результат{results.length > 1 ? ` · ${results.length}` : ''}</h2>
          {results.length > 0 && (
            <button type="button" className="nx-primary" disabled={saving} onClick={() => void copy('all')}>
              {copied === 'all' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
              {copied === 'all' ? 'Скопировано' : results.length > 1 ? 'Копировать все' : 'Копировать'}
            </button>
          )}
        </div>
        {results.length === 0 ? (
          <div className="nx-state nutm-empty">
            <Link2 size={24} aria-hidden="true" />
            <h2>Ссылка появится здесь</h2>
            <p>Вставьте адрес и выберите пресет или заполните метки — результат собирается сразу.</p>
          </div>
        ) : (
          <>
            {missing.length > 0 && <p className="nx-note">Обычно нужны {missing.map((f) => f.label).join(' и ')} — без них аналитика не поймёт источник.</p>}
            <div className="nx-group">
              {results.map((r, i) => (
                <div key={`${r.utm}-${i}`} className="nx-row nutm-link">
                  <code className="nutm-url">{r.utm}</code>
                  <span className="nx-row-actions">
                    <button type="button" className="nx-icon-btn" aria-label="Копировать ссылку" disabled={saving} onClick={() => void copy(i)}>
                      {copied === i ? <Check size={15} /> : <Copy size={15} />}
                    </button>
                    <a className="nx-icon-btn" href={r.utm} target="_blank" rel="noopener noreferrer" aria-label="Открыть ссылку"><ExternalLink size={15} /></a>
                  </span>
                </div>
              ))}
            </div>
            <p className="nx-note">Скопированные ссылки сохраняются в «Историю».</p>
          </>
        )}
      </section>
    </div>
  );
}
