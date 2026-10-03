import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Check, Pencil, Plus, RotateCw, Trash2, X } from 'lucide-react';
import { askConfirm } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import {
  createDepartment, deleteDepartment, loadDepartments, loadRequestDepartments, saveRequestDepartments, updateDepartment,
  type Department,
} from './api';

const DEFAULT_COLOR = '#6b7280';

/** Добавление отдела или подраздела: цвет + название одной строкой. */
function AddRow({ placeholder, initialColor = DEFAULT_COLOR, onAdd, onCancel, autoFocus }: {
  placeholder: string; initialColor?: string; onAdd: (name: string, color: string) => Promise<boolean>; onCancel?: () => void; autoFocus?: boolean;
}) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(initialColor);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    if (await onAdd(name.trim(), color)) { setName(''); setColor(initialColor); }
    setBusy(false);
  };
  return (
    <form className="nx-row nad-dept-add" onSubmit={submit}>
      <input type="color" className="nad-color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Цвет" />
      <span className="nx-field" data-variant="filter">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholder} aria-label={placeholder} autoFocus={autoFocus}
          onKeyDown={(e) => { if (e.key === 'Escape') onCancel?.(); }} />
      </span>
      <button type="submit" className="nx-primary" disabled={busy || !name.trim()}><Plus size={14} aria-hidden="true" /> Добавить</button>
      {onCancel && <button type="button" className="nx-icon-btn" aria-label="Отмена" onClick={onCancel}><X size={15} /></button>}
    </form>
  );
}

export default function DepartmentsTab() {
  const [departments, setDepartments] = useState<Department[] | null>(null);
  const [requestIds, setRequestIds] = useState<string[]>([]);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [addingSub, setAddingSub] = useState<string | null>(null);
  const [savingRequests, setSavingRequests] = useState(false);

  const load = useCallback(async () => {
    try {
      const [d, r] = await Promise.all([loadDepartments(), loadRequestDepartments().catch(() => [])]);
      setDepartments(d);
      setRequestIds(r);
    } catch { setDepartments((prev) => prev ?? []); showToast('Отделы не загрузились', 'error'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const add = async (name: string, color: string, parentId?: string) => {
    try {
      const d = await createDepartment({ name, color, ...(parentId ? { parentId } : {}) });
      setDepartments((cur) => [...(cur || []), { ...d, id: String(d.id), parentId: d.parentId ? String(d.parentId) : null }]);
      if (parentId) setAddingSub(null);
      return true;
    } catch (e) { showToast(e instanceof Error ? e.message : 'Не добавился', 'error'); return false; }
  };

  const patch = async (d: Department, p: { name?: string; color?: string }) => {
    const before = departments;
    setDepartments((cur) => (cur || []).map((x) => (x.id === d.id ? { ...x, ...p } : x)));
    try { await updateDepartment(d.id, p); } catch (e) { setDepartments(before); showToast(e instanceof Error ? e.message : 'Не сохранилось', 'error'); }
  };

  const remove = async (d: Department) => {
    const kids = (departments || []).filter((x) => x.parentId === d.id).length;
    if (!(await askConfirm({ title: `Удалить «${d.name}»?`, text: kids ? `У отдела ${kids} подразд. — проверьте, куда они денутся.` : 'Сотрудники останутся, но без этого отдела.', confirm: 'Удалить', tone: 'danger' }))) return;
    try { await deleteDepartment(d.id); setDepartments((cur) => (cur || []).filter((x) => x.id !== d.id)); }
    catch (e) { showToast(e instanceof Error ? e.message : 'Не удалился', 'error'); }
  };

  const toggleRequest = async (id: string) => {
    const next = requestIds.includes(id) ? requestIds.filter((x) => x !== id) : [...requestIds, id];
    const before = requestIds;
    setRequestIds(next);
    setSavingRequests(true);
    try { setRequestIds(await saveRequestDepartments(next)); } catch { setRequestIds(before); showToast('Не сохранилось', 'error'); }
    finally { setSavingRequests(false); }
  };

  if (departments === null) {
    return <div className="nx-group" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="nx-row"><span className="nx-skel nx-skel-line" style={{ width: `${60 - i * 10}%` }} /></div>)}</div>;
  }

  const tops = departments.filter((d) => !d.parentId);
  const ordered = tops.flatMap((t) => [t, ...departments.filter((d) => d.parentId === t.id)]);

  const row = (d: Department) => {
    const child = Boolean(d.parentId);
    const isEditing = editing?.id === d.id;
    return (
      <div key={d.id} className="nx-row nad-dept" data-child={child ? 'true' : undefined}>
        <input type="color" className="nad-color" value={d.color || DEFAULT_COLOR} aria-label={`Цвет: ${d.name}`}
          onChange={(e) => setDepartments((cur) => (cur || []).map((x) => (x.id === d.id ? { ...x, color: e.target.value } : x)))}
          onBlur={(e) => void patch(d, { color: e.target.value })} />
        {isEditing ? (
          <form className="nad-dept-edit" onSubmit={(e) => { e.preventDefault(); if (editing.name.trim()) void patch(d, { name: editing.name.trim() }); setEditing(null); }}>
            <span className="nx-field" data-variant="filter">
              <input value={editing.name} autoFocus aria-label="Название отдела" onChange={(e) => setEditing({ id: d.id, name: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null); }} />
            </span>
            <button type="submit" className="nx-icon-btn" aria-label="Сохранить"><Check size={16} /></button>
            <button type="button" className="nx-icon-btn" aria-label="Отмена" onClick={() => setEditing(null)}><X size={16} /></button>
          </form>
        ) : (
          <span className="nx-row-text"><span className="nx-row-label">{d.name}</span></span>
        )}
        {!isEditing && (
          <span className="nx-row-actions">
            {!child && (
              <button type="button" className="nx-ghost nad-sub-btn" onClick={() => setAddingSub(d.id)}><Plus size={13} aria-hidden="true" /> Подраздел</button>
            )}
            <button type="button" className="nx-icon-btn" aria-label={`Переименовать: ${d.name}`} onClick={() => setEditing({ id: d.id, name: d.name })}><Pencil size={15} /></button>
            <button type="button" className="nx-icon-btn" aria-label={`Удалить: ${d.name}`} onClick={() => void remove(d)}><Trash2 size={15} /></button>
          </span>
        )}
      </div>
    );
  };

  return (
    <>
      <section className="nx-block">
        <div className="nx-block-head">
          <h2 className="nx-block-title">Отделы и подразделы</h2>
          <button type="button" className="nx-icon-btn" aria-label="Обновить" onClick={() => void load()}><RotateCw size={15} /></button>
        </div>
        <div className="nx-group">
          {tops.map((t) => (
            <div key={t.id} className="nad-dept-block">
              {row(t)}
              {departments.filter((d) => d.parentId === t.id).map(row)}
              {addingSub === t.id && (
                <AddRow placeholder={`Подраздел в «${t.name}»`} initialColor={t.color || DEFAULT_COLOR} autoFocus
                  onAdd={(name, color) => add(name, color, t.id)} onCancel={() => setAddingSub(null)} />
              )}
            </div>
          ))}
          <AddRow placeholder="Новый отдел" onAdd={(name, color) => add(name, color)} />
        </div>
      </section>

      <section className="nx-block">
        <h2 className="nx-block-title">Отделы для заявок</h2>
        {ordered.length === 0 ? (
          <p className="nx-note">Сначала добавьте отделы.</p>
        ) : (
          <div className="nx-group" role="group" aria-label="Отделы для заявок" aria-busy={savingRequests || undefined}>
            {ordered.map((d) => {
              const on = requestIds.includes(d.id);
              return (
                <button key={d.id} type="button" role="checkbox" aria-checked={on} className="nx-row nad-request" data-child={d.parentId ? 'true' : undefined}
                  disabled={savingRequests} onClick={() => void toggleRequest(d.id)}>
                  <span className="nx-dot" style={{ background: d.color || DEFAULT_COLOR }} aria-hidden="true" />
                  <span className="nx-row-text"><span className="nx-row-label">{d.name}</span></span>
                  <span className="nx-check" aria-hidden="true">{on && <Check size={12} strokeWidth={3} />}</span>
                </button>
              );
            })}
          </div>
        )}
        <p className="nx-note">Отмеченные отделы можно выбрать при создании заявки; все их сотрудники попадают в чат заявки.</p>
      </section>
    </>
  );
}
