import { useState } from 'react';
import { Check, Pencil, Plus, Trash2 } from 'lucide-react';
import { Sheet, askConfirm } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import { PRESET_COLORS, resetPresets, savePresets, type Preset } from './api';

const EMPTY: Omit<Preset, 'id'> = { name: '', source: '', medium: '', campaign: '', term: '', content: '', description: '', color: PRESET_COLORS[0] };

function PresetSheet({ preset, onClose, onSave }: { preset?: Preset; onClose: () => void; onSave: (p: Preset) => void }) {
  const [d, setD] = useState<Omit<Preset, 'id'>>(preset ? { ...EMPTY, ...preset } : EMPTY);
  const [error, setError] = useState<string | null>(null);
  const field = (k: 'name' | 'source' | 'medium' | 'campaign' | 'term' | 'content' | 'description', label: string, placeholder?: string) => (
    <label className="nx-label">
      {label}
      <span className="nx-field"><input value={String(d[k] || '')} placeholder={placeholder} spellCheck={false} onChange={(e) => setD({ ...d, [k]: e.target.value })} /></span>
    </label>
  );
  const submit = () => {
    if (!d.name.trim() || !d.source.trim() || !d.medium.trim()) { setError('Нужны название, source и medium'); return; }
    const clean = (v?: string) => (v?.trim() ? v.trim() : undefined);
    onSave({
      id: preset?.id || `custom-${Date.now()}`, name: d.name.trim(), source: d.source.trim(), medium: d.medium.trim(),
      campaign: clean(d.campaign), term: clean(d.term), content: clean(d.content), description: d.description.trim(), color: d.color,
    });
  };
  return (
    <Sheet title={preset ? `Пресет: ${preset.name}` : 'Новый пресет'} onClose={onClose}
      footer={<><button type="button" className="nx-ghost" onClick={onClose}>Отмена</button><button type="button" className="nx-primary" onClick={submit}>Сохранить</button></>}>
      <form className="nx-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="nx-form-grid">
          {field('name', 'Название *', 'Яндекс')}
          {field('description', 'Описание', 'Яндекс Директ')}
          {field('source', 'utm_source *', 'yandex')}
          {field('medium', 'utm_medium *', 'cpc')}
          {field('campaign', 'utm_campaign')}
          {field('term', 'utm_term')}
          {field('content', 'utm_content')}
        </div>
        <div className="nx-label">
          Цвет
          <div className="nx-colors" role="radiogroup" aria-label="Цвет пресета" style={{ justifyContent: 'flex-start' }}>
            {PRESET_COLORS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={d.color === c} aria-label={c} className="nx-color" style={{ background: c }} onClick={() => setD({ ...d, color: c })}>
                {d.color === c && <Check size={13} strokeWidth={3} aria-hidden="true" />}
              </button>
            ))}
          </div>
        </div>
        {error && <p className="nx-error" role="alert">{error}</p>}
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}

export default function PresetsTab({ presets, onChange }: { presets: Preset[] | null; onChange: (p: Preset[]) => void }) {
  const [sheet, setSheet] = useState<{ preset?: Preset } | null>(null);

  const persist = async (next: Preset[]) => {
    const before = presets;
    onChange(next);
    try { await savePresets(next); } catch { if (before) onChange(before); showToast('Пресеты не сохранились', 'error'); }
  };

  const save = (p: Preset) => {
    const list = presets || [];
    void persist(list.some((x) => x.id === p.id) ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p]);
    setSheet(null);
  };

  const remove = async (p: Preset) => {
    if (!(await askConfirm({ title: `Удалить пресет «${p.name}»?`, confirm: 'Удалить', tone: 'danger' }))) return;
    void persist((presets || []).filter((x) => x.id !== p.id));
  };

  const reset = async () => {
    if (!(await askConfirm({ title: 'Вернуть стандартные пресеты?', text: 'Свои пресеты удалятся.', confirm: 'Вернуть', tone: 'danger' }))) return;
    try { onChange(await resetPresets()); showToast('Пресеты сброшены', 'success'); } catch { showToast('Не получилось', 'error'); }
  };

  return (
    <section className="nx-block">
      <div className="nx-block-head">
        <h2 className="nx-block-title">Пресеты источников — общие для всех</h2>
        <div className="nx-inline">
          <button type="button" className="nx-ghost" onClick={() => void reset()}>Стандартные</button>
          <button type="button" className="nx-primary" onClick={() => setSheet({})}><Plus size={14} aria-hidden="true" /> Пресет</button>
        </div>
      </div>
      <div className="nx-group">
        {presets === null ? (
          <div className="nx-row"><span className="nx-skel nx-skel-line" style={{ width: '50%' }} /></div>
        ) : presets.map((p) => (
          <div key={p.id} className="nx-row">
            <span className="nx-dot" style={{ background: p.color }} aria-hidden="true" />
            <span className="nx-row-text">
              <span className="nx-row-label">{p.name}</span>
              <span className="nx-row-hint">{[`${p.source} / ${p.medium}`, p.campaign, p.description].filter(Boolean).join(' · ')}</span>
            </span>
            <span className="nx-row-actions">
              <button type="button" className="nx-icon-btn" aria-label={`Изменить: ${p.name}`} onClick={() => setSheet({ preset: p })}><Pencil size={15} /></button>
              <button type="button" className="nx-icon-btn" aria-label={`Удалить: ${p.name}`} onClick={() => void remove(p)}><Trash2 size={15} /></button>
            </span>
          </div>
        ))}
      </div>
      {sheet && <PresetSheet preset={sheet.preset} onClose={() => setSheet(null)} onSave={save} />}
    </section>
  );
}
