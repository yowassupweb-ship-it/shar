import { useState, type ReactNode } from 'react';
import { Bold, ChartArea, ChartBar, ChartColumn, ChartLine, ChartPie, ChartScatter, Donut, Italic, Lock, Plus, Strikethrough, Trash2, Underline, X } from 'lucide-react';
import { displayName, useChatStore } from '@/features/chat';
import { myId } from '@/shared/session/session';
import { cfSummary } from '../sheet/cf';
import { CHART_COLORS } from '../sheet/chart';
import { newId, type Banding, type CfRule, type CfStyle, type ChartSpec, type DvRule, type Protection } from '../sheet/extras';
import { parseRange, rangeA1, type Range } from '../sheet/model';

/**
 * Боковые панели редактора таблиц — как в Google Таблицах: «Условное форматирование», «Проверка данных», «Редактор
 * диаграмм», «Защищённые листы и диапазоны». Панель правит копию правила и отдаёт готовый список правил целиком.
 */

const rangesText = (rs: Range[]) => rs.map(rangeA1).join(', ');
const parseRanges = (text: string): Range[] => text.split(/[,;]/).map((t) => parseRange(t.trim().toUpperCase())).filter((r): r is Range => Boolean(r));

function Shell({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <aside className="fsh-panel" aria-label={title}>
      <header className="fsh-panel-head">
        <h2>{title}</h2>
        <button type="button" className="nx-icon-btn" onClick={onClose} aria-label="Закрыть"><X size={16} /></button>
      </header>
      <div className="fsh-panel-body nx-scroll-y">{children}</div>
    </aside>
  );
}

const SWATCHES = ['#b7e1cd', '#fce8b2', '#f4c7c3', '#c9daf8', '#d9d2e9', '#ffffff', '#57bb8a', '#ffd666', '#e67c73', '#4285f4', '#000000', '#cc0000'];
function Swatches({ value, onPick, none }: { value?: string; onPick: (c?: string) => void; none?: string }) {
  return (
    <div className="fsh-swatches">
      {none && <button type="button" className="fsh-swatch fsh-swatch-none" aria-pressed={!value} title={none} onClick={() => onPick(undefined)} />}
      {SWATCHES.map((c) => <button key={c} type="button" className="fsh-swatch" style={{ background: c }} aria-pressed={value?.toLowerCase() === c} title={c} onClick={() => onPick(c)} />)}
      <label className="fsh-swatch fsh-swatch-custom" title="Свой цвет"><input type="color" value={value || '#ffffff'} onChange={(e) => onPick(e.target.value)} /></label>
    </div>
  );
}

// ── Условное форматирование ───────────────────────────────────────────────────────────────────────────────

const CONDITIONS: Array<{ id: string; label: string; kind: CfRule['kind']; op?: string; args: number }> = [
  { id: 'blank', label: 'Ячейка пуста', kind: 'blank', args: 0 },
  { id: 'notBlank', label: 'Ячейка не пуста', kind: 'notBlank', args: 0 },
  { id: 'contains', label: 'Текст содержит', kind: 'text', op: 'contains', args: 1 },
  { id: 'notContains', label: 'Текст не содержит', kind: 'text', op: 'notContains', args: 1 },
  { id: 'begins', label: 'Текст начинается с', kind: 'text', op: 'begins', args: 1 },
  { id: 'ends', label: 'Текст заканчивается на', kind: 'text', op: 'ends', args: 1 },
  { id: 'textEq', label: 'Текст в точности', kind: 'text', op: 'textEq', args: 1 },
  { id: 'dateEq', label: 'Дата', kind: 'cell', op: 'dateEq', args: 1 },
  { id: 'dateBefore', label: 'Дата до', kind: 'cell', op: 'dateBefore', args: 1 },
  { id: 'dateAfter', label: 'Дата после', kind: 'cell', op: 'dateAfter', args: 1 },
  { id: 'gt', label: 'Больше', kind: 'cell', op: 'gt', args: 1 },
  { id: 'gte', label: 'Больше или равно', kind: 'cell', op: 'gte', args: 1 },
  { id: 'lt', label: 'Меньше', kind: 'cell', op: 'lt', args: 1 },
  { id: 'lte', label: 'Меньше или равно', kind: 'cell', op: 'lte', args: 1 },
  { id: 'eq', label: 'Равно', kind: 'cell', op: 'eq', args: 1 },
  { id: 'ne', label: 'Не равно', kind: 'cell', op: 'ne', args: 1 },
  { id: 'between', label: 'Между', kind: 'cell', op: 'between', args: 2 },
  { id: 'notBetween', label: 'Не между', kind: 'cell', op: 'notBetween', args: 2 },
  { id: 'duplicate', label: 'Повторяющиеся значения', kind: 'duplicate', args: 0 },
  { id: 'unique', label: 'Уникальные значения', kind: 'unique', args: 0 },
  { id: 'formula', label: 'Ваша формула', kind: 'formula', args: 1 },
];
const condOf = (r: CfRule) => CONDITIONS.find((c) => c.kind === r.kind && (c.op ?? undefined) === (r.kind === 'cell' || r.kind === 'text' ? r.op : undefined))?.id ?? 'notBlank';

function StylePreview({ rule }: { rule: CfRule }) {
  if (rule.kind === 'scale' && rule.scale) {
    const s = rule.scale;
    return <span className="fsh-cf-preview" style={{ background: `linear-gradient(90deg, ${s.min.color}, ${s.mid?.color ?? s.max.color}, ${s.max.color})` }} />;
  }
  const st = rule.style || {};
  return <span className="fsh-cf-preview" style={{ background: st.bg || 'transparent', color: st.cl, fontWeight: st.bl ? 700 : 400, fontStyle: st.it ? 'italic' : undefined, textDecoration: [st.ul ? 'underline' : '', st.st ? 'line-through' : ''].join(' ').trim() || undefined }}>123</span>;
}

export function CfPanel({ rules, selection, onChange, onClose }: { rules: CfRule[]; selection: Range; onChange: (next: CfRule[]) => void; onClose: () => void }) {
  const [edit, setEdit] = useState<CfRule | null>(null);
  const [rangeText, setRangeText] = useState('');
  const startNew = () => {
    const rule: CfRule = { id: newId('cf'), ranges: [selection], kind: 'notBlank', style: { bg: '#b7e1cd' } };
    setRangeText(rangesText(rule.ranges)); setEdit(rule);
  };
  if (!edit) {
    return (
      <Shell title="Условное форматирование" onClose={onClose}>
        {rules.map((r) => (
          <div key={r.id} className="fsh-cf-item" role="button" tabIndex={0} onClick={() => { setRangeText(rangesText(r.ranges)); setEdit(JSON.parse(JSON.stringify(r))); }}>
            <StylePreview rule={r} />
            <span className="fsh-cf-text"><b>{cfSummary(r)}</b><span>{rangesText(r.ranges)}</span></span>
            <button type="button" className="nx-icon-btn" aria-label="Удалить правило" onClick={(e) => { e.stopPropagation(); onChange(rules.filter((x) => x.id !== r.id)); }}><Trash2 size={15} /></button>
          </div>
        ))}
        {!rules.length && <p className="fsh-panel-empty">Правил пока нет.</p>}
        <button type="button" className="nx-ghost fsh-panel-add" onClick={startNew}><Plus size={15} /> Добавить правило</button>
      </Shell>
    );
  }
  const cond = CONDITIONS.find((c) => c.id === condOf(edit))!;
  const st: CfStyle = edit.style || {};
  const setStyle = (patch: Partial<CfStyle>) => setEdit({ ...edit, style: Object.fromEntries(Object.entries({ ...st, ...patch }).filter(([, v]) => v !== undefined)) as CfStyle });
  const save = () => {
    const ranges = parseRanges(rangeText);
    if (!ranges.length) return;
    const rule = { ...edit, ranges };
    const exists = rules.some((x) => x.id === rule.id);
    onChange(exists ? rules.map((x) => (x.id === rule.id ? rule : x)) : [...rules, rule]);
    setEdit(null);
  };
  const scale = edit.kind === 'scale';
  return (
    <Shell title="Условное форматирование" onClose={onClose}>
      <div className="nx-segment fsh-panel-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={!scale} onClick={() => setEdit({ ...edit, kind: 'notBlank', scale: undefined, style: edit.style || { bg: '#b7e1cd' } })}>Один цвет</button>
        <button type="button" role="tab" aria-selected={scale} onClick={() => setEdit({ ...edit, kind: 'scale', scale: edit.scale || { min: { type: 'min', color: '#ffffff' }, max: { type: 'max', color: '#57bb8a' } } })}>Градиент</button>
      </div>
      <label className="fsh-field"><span>Применить к диапазону</span><input value={rangeText} onChange={(e) => setRangeText(e.target.value)} placeholder="A1:B10" /></label>
      {!scale ? (
        <>
          <label className="fsh-field"><span>Форматирование ячеек, если…</span>
            <select value={cond.id} onChange={(e) => { const c = CONDITIONS.find((x) => x.id === e.target.value)!; setEdit({ ...edit, kind: c.kind, op: c.op, values: (edit.values || []).slice(0, c.args) }); }}>
              {CONDITIONS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>
          {Array.from({ length: cond.args }, (_, i) => (
            <label key={i} className="fsh-field"><span>{cond.kind === 'formula' ? 'Формула (для левой верхней ячейки)' : cond.args === 2 ? (i ? 'и' : 'Значение') : 'Значение или формула'}</span>
              <input value={edit.values?.[i] ?? ''} placeholder={cond.kind === 'formula' ? '=A1>B1' : cond.op?.startsWith('date') ? 'today или 25.11.2026' : ''}
                onChange={(e) => { const v = [...(edit.values || [])]; v[i] = e.target.value; setEdit({ ...edit, values: v }); }} />
            </label>
          ))}
          <div className="fsh-field"><span>Стиль</span>
            <div className="fsh-cf-styles">
              <button type="button" aria-pressed={Boolean(st.bl)} onClick={() => setStyle({ bl: st.bl ? undefined : 1 })} title="Жирный"><Bold size={15} /></button>
              <button type="button" aria-pressed={Boolean(st.it)} onClick={() => setStyle({ it: st.it ? undefined : 1 })} title="Курсив"><Italic size={15} /></button>
              <button type="button" aria-pressed={Boolean(st.ul)} onClick={() => setStyle({ ul: st.ul ? undefined : 1 })} title="Подчёркнутый"><Underline size={15} /></button>
              <button type="button" aria-pressed={Boolean(st.st)} onClick={() => setStyle({ st: st.st ? undefined : 1 })} title="Зачёркнутый"><Strikethrough size={15} /></button>
              <StylePreview rule={edit} />
            </div>
          </div>
          <div className="fsh-field"><span>Цвет заливки</span><Swatches value={st.bg} none="Без заливки" onPick={(c) => setStyle({ bg: c })} /></div>
          <div className="fsh-field"><span>Цвет текста</span><Swatches value={st.cl} none="Обычный" onPick={(c) => setStyle({ cl: c })} /></div>
        </>
      ) : (
        <>
          {(['min', 'mid', 'max'] as const).map((k) => {
            const p = edit.scale?.[k];
            const label = k === 'min' ? 'Минимум' : k === 'mid' ? 'Середина' : 'Максимум';
            return (
              <div key={k} className="fsh-field"><span>{label}</span>
                <div className="fsh-scale-row">
                  <select value={p ? p.type : 'none'} onChange={(e) => {
                    const t = e.target.value;
                    const sc = { ...edit.scale! };
                    if (t === 'none') delete sc.mid; else sc[k] = { type: t as 'min', value: p?.value ?? (t === 'percentile' || t === 'percent' ? 50 : undefined), color: p?.color || (k === 'mid' ? '#ffd666' : k === 'min' ? '#ffffff' : '#57bb8a') };
                    setEdit({ ...edit, scale: sc });
                  }}>
                    {k === 'mid' && <option value="none">Нет</option>}
                    {k !== 'mid' && <option value={k}>{k === 'min' ? 'Минимальное значение' : 'Максимальное значение'}</option>}
                    <option value="num">Число</option><option value="percent">Процент</option><option value="percentile">Процентиль</option>
                  </select>
                  {p && (p.type === 'num' || p.type === 'percent' || p.type === 'percentile') && (
                    <input className="fsh-scale-num" value={p.value ?? ''} onChange={(e) => setEdit({ ...edit, scale: { ...edit.scale!, [k]: { ...p, value: Number(e.target.value.replace(',', '.')) || 0 } } })} />
                  )}
                  {p && <input type="color" value={p.color} onChange={(e) => setEdit({ ...edit, scale: { ...edit.scale!, [k]: { ...p, color: e.target.value } } })} />}
                </div>
              </div>
            );
          })}
          <StylePreview rule={edit} />
        </>
      )}
      <div className="fsh-panel-foot">
        <button type="button" className="nx-ghost" onClick={() => setEdit(null)}>Отмена</button>
        <button type="button" className="nx-primary" onClick={save}>Готово</button>
      </div>
    </Shell>
  );
}

// ── Проверка данных ───────────────────────────────────────────────────────────────────────────────────────

export function DvPanel({ rules, selection, onChange, onClose }: { rules: DvRule[]; selection: Range; onChange: (next: DvRule[]) => void; onClose: () => void }) {
  const [edit, setEdit] = useState<DvRule | null>(null);
  const [rangeText, setRangeText] = useState('');
  const [valuesText, setValuesText] = useState('');
  const open = (r: DvRule) => { setEdit(r); setRangeText(rangesText(r.ranges)); setValuesText((r.values || []).join('\n')); };
  if (!edit) {
    return (
      <Shell title="Проверка данных" onClose={onClose}>
        {rules.map((r) => (
          <div key={r.id} className="fsh-cf-item" role="button" tabIndex={0} onClick={() => open(JSON.parse(JSON.stringify(r)))}>
            <span className="fsh-cf-text"><b>{r.kind === 'checkbox' ? 'Флажок' : `Раскрывающийся список: ${(r.values || []).slice(0, 3).join(', ')}${(r.values || []).length > 3 ? '…' : ''}`}</b><span>{rangesText(r.ranges)}</span></span>
            <button type="button" className="nx-icon-btn" aria-label="Удалить правило" onClick={(e) => { e.stopPropagation(); onChange(rules.filter((x) => x.id !== r.id)); }}><Trash2 size={15} /></button>
          </div>
        ))}
        {!rules.length && <p className="fsh-panel-empty">Правил пока нет.</p>}
        <button type="button" className="nx-ghost fsh-panel-add" onClick={() => open({ id: newId('dv'), ranges: [selection], kind: 'list', values: ['Вариант 1', 'Вариант 2'], chips: true })}><Plus size={15} /> Добавить правило</button>
      </Shell>
    );
  }
  const save = () => {
    const ranges = parseRanges(rangeText);
    if (!ranges.length) return;
    const values = valuesText.split('\n').map((v) => v.trim()).filter(Boolean);
    const rule: DvRule = { ...edit, ranges, values: edit.kind === 'list' ? values : undefined };
    onChange(rules.some((x) => x.id === rule.id) ? rules.map((x) => (x.id === rule.id ? rule : x)) : [...rules, rule]);
    setEdit(null);
  };
  return (
    <Shell title="Проверка данных" onClose={onClose}>
      <label className="fsh-field"><span>Применить к диапазону</span><input value={rangeText} onChange={(e) => setRangeText(e.target.value)} /></label>
      <label className="fsh-field"><span>Критерии</span>
        <select value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value as DvRule['kind'] })}>
          <option value="list">Раскрывающийся список</option>
          <option value="checkbox">Флажок</option>
        </select>
      </label>
      {edit.kind === 'list' && (
        <>
          <label className="fsh-field"><span>Варианты — каждый с новой строки</span><textarea rows={6} value={valuesText} onChange={(e) => setValuesText(e.target.value)} /></label>
          <label className="fsh-check"><input type="checkbox" checked={edit.chips !== false} onChange={(e) => setEdit({ ...edit, chips: e.target.checked })} /> Показывать как чипы</label>
          <label className="fsh-check"><input type="checkbox" checked={Boolean(edit.strict)} onChange={(e) => setEdit({ ...edit, strict: e.target.checked })} /> Отклонять значения не из списка</label>
        </>
      )}
      <div className="fsh-panel-foot">
        <button type="button" className="nx-ghost" onClick={() => setEdit(null)}>Отмена</button>
        <button type="button" className="nx-primary" onClick={save}>Готово</button>
      </div>
    </Shell>
  );
}

// ── Редактор диаграмм ─────────────────────────────────────────────────────────────────────────────────────

const TYPES: Array<{ id: ChartSpec['type']; label: string; icon: ReactNode }> = [
  { id: 'column', label: 'Столбцы', icon: <ChartColumn size={18} /> }, { id: 'bar', label: 'Линейчатая', icon: <ChartBar size={18} /> },
  { id: 'line', label: 'График', icon: <ChartLine size={18} /> }, { id: 'area', label: 'С областями', icon: <ChartArea size={18} /> },
  { id: 'pie', label: 'Круговая', icon: <ChartPie size={18} /> }, { id: 'doughnut', label: 'Кольцевая', icon: <Donut size={18} /> },
  { id: 'scatter', label: 'Точечная', icon: <ChartScatter size={18} /> },
];

export function ChartPanel({ spec, onChange, onClose, onDelete }: { spec: ChartSpec; onChange: (next: ChartSpec) => void; onClose: () => void; onDelete: () => void }) {
  const [rangeText, setRangeText] = useState(rangeA1(spec.range));
  const colors = spec.colors?.length ? spec.colors : CHART_COLORS;
  return (
    <Shell title="Редактор диаграмм" onClose={onClose}>
      <div className="fsh-field"><span>Тип диаграммы</span>
        <div className="fsh-chart-types">
          {TYPES.map((t) => <button key={t.id} type="button" aria-pressed={spec.type === t.id} title={t.label} onClick={() => onChange({ ...spec, type: t.id })}>{t.icon}<span>{t.label}</span></button>)}
        </div>
      </div>
      <label className="fsh-field"><span>Диапазон данных</span>
        <input value={rangeText} onChange={(e) => setRangeText(e.target.value)} onBlur={() => { const r = parseRange(rangeText.toUpperCase()); if (r) onChange({ ...spec, range: r }); else setRangeText(rangeA1(spec.range)); }} />
      </label>
      <label className="fsh-field"><span>Название</span><input value={spec.title || ''} onChange={(e) => onChange({ ...spec, title: e.target.value || undefined })} placeholder="Без названия" /></label>
      <label className="fsh-check"><input type="checkbox" checked={spec.headers ?? true} onChange={(e) => onChange({ ...spec, headers: e.target.checked })} /> Первая строка — заголовки</label>
      <label className="fsh-check"><input type="checkbox" checked={spec.labels ?? true} onChange={(e) => onChange({ ...spec, labels: e.target.checked })} /> Первый столбец — подписи</label>
      <label className="fsh-check"><input type="checkbox" checked={Boolean(spec.byRows)} onChange={(e) => onChange({ ...spec, byRows: e.target.checked })} /> Ряды по строкам</label>
      {(spec.type === 'column' || spec.type === 'bar' || spec.type === 'area') && (
        <label className="fsh-check"><input type="checkbox" checked={Boolean(spec.stacked)} onChange={(e) => onChange({ ...spec, stacked: e.target.checked })} /> С накоплением</label>
      )}
      <label className="fsh-field"><span>Легенда</span>
        <select value={spec.legend ?? 'auto'} onChange={(e) => onChange({ ...spec, legend: e.target.value === 'auto' ? undefined : e.target.value as ChartSpec['legend'] })}>
          <option value="auto">Авто</option><option value="right">Справа</option><option value="bottom">Внизу</option><option value="none">Нет</option>
        </select>
      </label>
      <div className="fsh-field"><span>Цвета рядов</span>
        <div className="fsh-chart-colors">
          {colors.slice(0, 6).map((c, i) => <input key={i} type="color" value={c} onChange={(e) => { const next = [...colors]; next[i] = e.target.value; onChange({ ...spec, colors: next }); }} />)}
        </div>
      </div>
      <div className="fsh-panel-foot">
        <button type="button" className="nx-ghost fsh-danger" onClick={onDelete}><Trash2 size={15} /> Удалить диаграмму</button>
      </div>
    </Shell>
  );
}

// ── Защищённые диапазоны ──────────────────────────────────────────────────────────────────────────────────

export function ProtectPanel({ list, selection, onChange, onClose }: { list: Protection[]; selection: Range; onChange: (next: Protection[]) => void; onClose: () => void }) {
  const users = useChatStore((s) => s.users);
  const me = myId();
  const [edit, setEdit] = useState<Protection | null>(null);
  const [rangeText, setRangeText] = useState('');
  const [query, setQuery] = useState('');
  const open = (p: Protection) => { setEdit(p); setRangeText(rangeA1(p.range)); };
  if (!edit) {
    return (
      <Shell title="Защищённые диапазоны" onClose={onClose}>
        {list.map((p) => (
          <div key={p.id} className="fsh-cf-item" role="button" tabIndex={0} onClick={() => open(JSON.parse(JSON.stringify(p)))}>
            <Lock size={15} />
            <span className="fsh-cf-text"><b>{p.description || rangeA1(p.range)}</b><span>{rangeA1(p.range)} · {p.warnOnly ? 'только предупреждение' : `правят: ${[p.owner, ...p.editors].filter((v, i, a) => a.indexOf(v) === i).length}`}</span></span>
            {(p.owner === me) && <button type="button" className="nx-icon-btn" aria-label="Снять защиту" onClick={(e) => { e.stopPropagation(); onChange(list.filter((x) => x.id !== p.id)); }}><Trash2 size={15} /></button>}
          </div>
        ))}
        {!list.length && <p className="fsh-panel-empty">Защищённых диапазонов нет. Защищённый диапазон правят только выбранные люди.</p>}
        <button type="button" className="nx-ghost fsh-panel-add" onClick={() => open({ id: newId('pr'), range: selection, owner: me, editors: [] })}><Plus size={15} /> Защитить диапазон</button>
      </Shell>
    );
  }
  const mine = edit.owner === me;
  const people = Object.values(users).filter((u) => String(u.id) !== edit.owner && (!query || displayName(u).toLowerCase().includes(query.toLowerCase()))).slice(0, 60);
  const save = () => {
    const r = parseRange(rangeText.toUpperCase());
    if (!r) return;
    const p = { ...edit, range: r };
    onChange(list.some((x) => x.id === p.id) ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p]);
    setEdit(null);
  };
  return (
    <Shell title="Защищённые диапазоны" onClose={onClose}>
      <label className="fsh-field"><span>Описание</span><input value={edit.description || ''} disabled={!mine} onChange={(e) => setEdit({ ...edit, description: e.target.value })} placeholder="Например: «Итоги — не трогать»" /></label>
      <label className="fsh-field"><span>Диапазон</span><input value={rangeText} disabled={!mine} onChange={(e) => setRangeText(e.target.value)} /></label>
      <label className="fsh-check"><input type="checkbox" checked={Boolean(edit.warnOnly)} disabled={!mine} onChange={(e) => setEdit({ ...edit, warnOnly: e.target.checked })} /> Только предупреждать при правке</label>
      {!edit.warnOnly && (
        <div className="fsh-field"><span>Кто ещё может править (кроме вас)</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти сотрудника" />
          <div className="fsh-people">
            {people.map((u) => {
              const id = String(u.id);
              return (
                <label key={id} className="fsh-check"><input type="checkbox" disabled={!mine} checked={edit.editors.includes(id)}
                  onChange={(e) => setEdit({ ...edit, editors: e.target.checked ? [...edit.editors, id] : edit.editors.filter((x) => x !== id) })} /> {displayName(u)}</label>
              );
            })}
          </div>
        </div>
      )}
      <div className="fsh-panel-foot">
        <button type="button" className="nx-ghost" onClick={() => setEdit(null)}>{mine ? 'Отмена' : 'Назад'}</button>
        {mine && <button type="button" className="nx-primary" onClick={save}>Готово</button>}
      </div>
    </Shell>
  );
}

// ── Чередование цветов ────────────────────────────────────────────────────────────────────────────────────

const BAND_PRESETS: Array<{ header: string; odd: string; even: string }> = [
  { header: '#bdbdbd', odd: '#ffffff', even: '#f3f3f3' }, { header: '#5b95f9', odd: '#ffffff', even: '#e8f0fe' },
  { header: '#57bb8a', odd: '#ffffff', even: '#e7f9ef' }, { header: '#f7cb4d', odd: '#ffffff', even: '#fef8e3' },
  { header: '#e67c73', odd: '#ffffff', even: '#fce8e6' }, { header: '#8e7cc3', odd: '#ffffff', even: '#f3eef9' },
  { header: '#46bdc6', odd: '#ffffff', even: '#e4f7fb' }, { header: '#ff9e6b', odd: '#ffffff', even: '#fff0e8' },
];

export function BandingPanel({ list, selection, onChange, onClose }: { list: Banding[]; selection: Range; onChange: (next: Banding[]) => void; onClose: () => void }) {
  const current = list.find((x) => x.range.startRow <= selection.endRow && selection.startRow <= x.range.endRow && x.range.startColumn <= selection.endColumn && selection.startColumn <= x.range.endColumn);
  const [edit, setEdit] = useState<Banding>(() => (current ? { ...current } : { id: newId('band'), range: selection, header: BAND_PRESETS[1].header, odd: BAND_PRESETS[1].odd, even: BAND_PRESETS[1].even }));
  const [rangeText, setRangeText] = useState(rangeA1(edit.range));
  const apply = (next: Banding) => {
    const r = parseRange(rangeText.toUpperCase()) || next.range;
    const item = { ...next, range: r };
    setEdit(item);
    onChange(list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item]);
  };
  return (
    <Shell title="Чередование цветов" onClose={onClose}>
      <label className="fsh-field"><span>Применить к диапазону</span><input value={rangeText} onChange={(e) => setRangeText(e.target.value)} onBlur={() => apply(edit)} /></label>
      <label className="fsh-check"><input type="checkbox" checked={Boolean(edit.header)} onChange={(e) => apply({ ...edit, header: e.target.checked ? BAND_PRESETS[0].header : undefined })} /> Заголовок</label>
      <label className="fsh-check"><input type="checkbox" checked={Boolean(edit.footer)} onChange={(e) => apply({ ...edit, footer: e.target.checked ? (edit.header || '#bdbdbd') : undefined })} /> Нижний колонтитул</label>
      <div className="fsh-field"><span>Стили по умолчанию</span>
        <div className="fsh-band-presets">
          {BAND_PRESETS.map((p, i) => (
            <button key={i} type="button" className="fsh-band-preset" onClick={() => apply({ ...edit, header: edit.header ? p.header : undefined, footer: edit.footer ? p.header : undefined, odd: p.odd, even: p.even })}>
              <i style={{ background: p.header }} /><i style={{ background: p.odd }} /><i style={{ background: p.even }} />
            </button>
          ))}
        </div>
      </div>
      <div className="fsh-field"><span>Свои цвета</span>
        <div className="fsh-scale-row">
          {edit.header && <label title="Заголовок"><input type="color" value={edit.header} onChange={(e) => apply({ ...edit, header: e.target.value })} /></label>}
          <label title="Цвет 1"><input type="color" value={edit.odd} onChange={(e) => apply({ ...edit, odd: e.target.value })} /></label>
          <label title="Цвет 2"><input type="color" value={edit.even} onChange={(e) => apply({ ...edit, even: e.target.value })} /></label>
          {edit.footer && <label title="Колонтитул"><input type="color" value={edit.footer} onChange={(e) => apply({ ...edit, footer: e.target.value })} /></label>}
        </div>
      </div>
      <div className="fsh-panel-foot">
        {list.some((x) => x.id === edit.id) && <button type="button" className="nx-ghost fsh-danger" onClick={() => { onChange(list.filter((x) => x.id !== edit.id)); onClose(); }}><Trash2 size={15} /> Удалить чередование</button>}
        <button type="button" className="nx-primary" onClick={() => { apply(edit); onClose(); }}>Готово</button>
      </div>
    </Shell>
  );
}

// ── Именованные диапазоны ─────────────────────────────────────────────────────────────────────────────────

export function NamesPanel({ names, sheetName, selection, onChange, onClose, onGo }: {
  names: Record<string, string>; sheetName: string; selection: Range; onChange: (next: Record<string, string>) => void; onClose: () => void; onGo: (ref: string) => void;
}) {
  const [draft, setDraft] = useState<{ old?: string; name: string; ref: string } | null>(null);
  const quoted = (n: string) => (/^[\wА-Яа-яЁё.]+$/.test(n) ? n : `'${n.replace(/'/g, "''")}'`);
  const valid = (n: string) => /^[A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё.]*$/.test(n) && !/^[A-Z]{1,3}\d+$/i.test(n);
  if (!draft) {
    return (
      <Shell title="Именованные диапазоны" onClose={onClose}>
        {Object.entries(names).map(([n, ref]) => (
          <div key={n} className="fsh-cf-item" role="button" tabIndex={0} onClick={() => onGo(ref)}>
            <span className="fsh-cf-text"><b>{n}</b><span>{ref}</span></span>
            <button type="button" className="nx-ghost" onClick={(e) => { e.stopPropagation(); setDraft({ old: n, name: n, ref }); }}>Изменить</button>
            <button type="button" className="nx-icon-btn" aria-label="Удалить" onClick={(e) => { e.stopPropagation(); const next = { ...names }; delete next[n]; onChange(next); }}><Trash2 size={15} /></button>
          </div>
        ))}
        {!Object.keys(names).length && <p className="fsh-panel-empty">Именованных диапазонов нет. Имя можно использовать в формулах: =СУММ(Продажи).</p>}
        <button type="button" className="nx-ghost fsh-panel-add" onClick={() => setDraft({ name: '', ref: `${quoted(sheetName)}!${rangeA1(selection)}` })}><Plus size={15} /> Добавить диапазон</button>
      </Shell>
    );
  }
  const refPart = draft.ref.slice(draft.ref.lastIndexOf('!') + 1).replace(/\$/g, '').toUpperCase();
  const ok = valid(draft.name) && (!names[draft.name] || draft.old === draft.name) && Boolean(parseRange(refPart));
  return (
    <Shell title="Именованные диапазоны" onClose={onClose}>
      <label className="fsh-field"><span>Имя (без пробелов, не как адрес ячейки)</span><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value.trim() })} placeholder="Продажи" autoFocus /></label>
      <label className="fsh-field"><span>Диапазон</span><input value={draft.ref} onChange={(e) => setDraft({ ...draft, ref: e.target.value })} /></label>
      <div className="fsh-panel-foot">
        <button type="button" className="nx-ghost" onClick={() => setDraft(null)}>Отмена</button>
        <button type="button" className="nx-primary" disabled={!ok} onClick={() => { const next = { ...names }; if (draft.old) delete next[draft.old]; next[draft.name] = draft.ref; onChange(next); setDraft(null); }}>Готово</button>
      </div>
    </Shell>
  );
}

/** Справка по клавишам (Ctrl+/), как в Google Таблицах. */
export const SHEET_SHORTCUTS: Array<[string, string]> = [
  ['Ctrl+C / Ctrl+X / Ctrl+V', 'Копировать / вырезать / вставить'], ['Ctrl+Shift+V', 'Вставить только значения'], ['Ctrl+Z / Ctrl+Y', 'Отменить / повторить'],
  ['Ctrl+B / I / U', 'Жирный / курсив / подчёркнутый'], ['Ctrl+\\', 'Очистить форматирование'], ['Ctrl+Shift+L / E / R', 'Выровнять по левому краю / центру / правому'],
  ['Ctrl+Shift+1 / 3 / 4 / 5', 'Формат: число / дата / рубли / процент'], ['Ctrl+;  /  Ctrl+Shift+;', 'Сегодняшняя дата / текущее время'],
  ['Ctrl+Пробел / Shift+Пробел', 'Выделить столбец / строку'], ['Ctrl+A', 'Выделить всё'], ['Ctrl+стрелка', 'К краю данных'], ['Ctrl+Home / Ctrl+End', 'В начало / к последней ячейке'],
  ['Ctrl+D / Ctrl+R', 'Заполнить вниз / вправо'], ['Ctrl+Enter', 'Ввести во всё выделение'], ['Alt+Enter', 'Новая строка в ячейке'], ['F2 / Enter', 'Править ячейку'],
  ['Shift+F2', 'Заметка'], ['Ctrl+Alt+M', 'Комментарий'], ['Ctrl+K', 'Ссылка'], ['Ctrl+F / Ctrl+H', 'Найти / найти и заменить'],
  ['Ctrl+колесо, Ctrl+= / Ctrl+−', 'Масштаб'], ['Пробел (на флажке)', 'Переключить флажки'], ['Alt+↓ (на списке)', 'Открыть варианты'], ['Ctrl+/', 'Эта справка'],
];
