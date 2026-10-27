import { useEffect, useMemo, useState } from 'react';
import { Check, Folder } from 'lucide-react';
import { Sheet } from '@/shared/ui/overlay';
import { Switch } from '@/shared/ui/controls';
import { Select } from '@/shared/ui/Select';
import { showToast } from '@/shared/ui/Toast';
import { createMcpKey, loadOfficeFolders, updateMcpKey, type McpAccess, type McpKey, type McpKind, type McpScope, type OfficeFolder } from '../api';

export const ACCESS: Array<{ value: McpAccess; label: string; hint: string }> = [
  { value: 'read', label: 'Только читать', hint: 'Находит и читает материалы, ничего не меняет.' },
  { value: 'edit', label: 'Читать и править', hint: 'Ещё правит то, что уже есть: текст, ячейки, названия. Перед каждой правкой сохраняется версия.' },
  { value: 'create', label: 'Править и создавать', hint: 'Ещё создаёт заметки, документы, таблицы и папки, раскладывает материалы по папкам.' },
];

export const KINDS: Array<{ value: McpKind; label: string }> = [
  { value: 'note', label: 'Заметки' }, { value: 'document', label: 'Документы' },
  { value: 'table', label: 'Таблицы' }, { value: 'presentation', label: 'Презентации (только чтение)' },
];

const EXPIRY = [
  { value: '', label: 'Без срока' }, { value: '30', label: '30 дней' }, { value: '90', label: '90 дней' }, { value: '365', label: 'Год' },
];

/** Папки деревом: отмеченная открывает и всё, что в неё вложено, — вложенные показаны отмеченными «через родителя». */
function FolderPicker({ folders, selected, onChange }: { folders: OfficeFolder[]; selected: string[]; onChange: (ids: string[]) => void }) {
  const tree = useMemo(() => {
    const known = new Set(folders.map((f) => f.id));
    const children = new Map<string | null, OfficeFolder[]>();
    for (const f of folders) {
      const parent = f.parentId && known.has(f.parentId) ? f.parentId : null;
      children.set(parent, [...(children.get(parent) || []), f]);
    }
    const rows: Array<{ folder: OfficeFolder; depth: number; viaParent: boolean }> = [];
    const walk = (parent: string | null, depth: number, inherited: boolean) => {
      for (const f of (children.get(parent) || []).sort((a, b) => a.title.localeCompare(b.title, 'ru'))) {
        rows.push({ folder: f, depth, viaParent: inherited });
        walk(f.id, depth + 1, inherited || selected.includes(f.id));
      }
    };
    walk(null, 0, false);
    return rows;
  }, [folders, selected]);
  if (!folders.length) return <p className="nx-note">Папок пока нет — создайте их в «Офисе».</p>;
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <div className="nst-mcp-folders" role="group" aria-label="Папки, открытые агенту">
      {tree.map(({ folder, depth, viaParent }) => {
        const on = viaParent || selected.includes(folder.id);
        return (
          <button key={folder.id} type="button" role="checkbox" aria-checked={on} disabled={viaParent} className="nst-mcp-folder"
            style={{ paddingLeft: `${8 + depth * 18}px` }} onClick={() => toggle(folder.id)}
            title={viaParent ? 'Открыта вместе с папкой выше' : undefined}>
            <span className="nx-check" aria-hidden="true">{on && <Check size={11} strokeWidth={3} />}</span>
            <Folder size={15} className="nst-mcp-folder-icon" aria-hidden="true" />
            <span className="nst-mcp-folder-name">{folder.title}</span>
            {folder.role && folder.role !== 'owner' && <span className="nst-mcp-folder-note">открыта вам</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Выпуск ключа или смена его доступа. Ключ при смене доступа тот же — агенту ничего перенастраивать не нужно. */
export default function McpKeySheet({ edit, onClose, onCreated, onSaved }: {
  edit?: McpKey;
  onClose: () => void;
  onCreated?: (key: McpKey, token: string) => void;
  onSaved?: (key: McpKey) => void;
}) {
  const [name, setName] = useState(edit?.name ?? '');
  const [access, setAccess] = useState<McpAccess>(edit?.scope.access ?? 'read');
  const [kinds, setKinds] = useState<McpKind[]>(edit?.scope.kinds ?? ['note', 'document', 'table', 'presentation']);
  const [whole, setWhole] = useState(edit ? edit.scope.folders === null : true);
  const [picked, setPicked] = useState<string[]>(edit?.scope.folders ?? []);
  const [shared, setShared] = useState(edit?.scope.shared ?? true);
  const [expiry, setExpiry] = useState('');
  const [folders, setFolders] = useState<OfficeFolder[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { loadOfficeFolders().then(setFolders).catch(() => setFolders([])); }, []);

  const problem = !kinds.length ? 'Отметьте хотя бы один вид материалов'
    : !whole && !picked.length ? 'Отметьте хотя бы одну папку или откройте весь «Офис»' : '';

  const save = async () => {
    if (problem) { showToast(problem, 'error'); return; }
    const scope: McpScope = { access, kinds, folders: whole ? null : picked, shared };
    setBusy(true);
    try {
      if (edit) onSaved?.(await updateMcpKey(edit.id, { name: name.trim(), scope }));
      else {
        const { key, token } = await createMcpKey(name.trim(), scope, expiry ? Number(expiry) : null);
        onCreated?.(key, token);
      }
    } catch (e) { showToast(e instanceof Error ? e.message : 'Не сохранилось', 'error'); setBusy(false); }
  };

  const toggleKind = (kind: McpKind) => setKinds((cur) => (cur.includes(kind) ? cur.filter((k) => k !== kind) : [...cur, kind]));

  return (
    <Sheet
      title={edit ? `Доступ ключа «${edit.name}»` : 'Новый ключ MCP'}
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          <button type="button" className="nx-ghost" onClick={onClose}>Отмена</button>
          <button type="button" className="nx-primary" disabled={busy || Boolean(problem)} title={problem || undefined} onClick={() => void save()}>
            {busy ? 'Сохраняю…' : edit ? 'Сохранить доступ' : 'Выпустить ключ'}
          </button>
        </>
      )}
    >
      <div className="nst-mcp-form">
        <label className="nx-label">Название
          <input className="nx-field" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Например, «Claude на ноутбуке»" autoFocus={!edit} />
        </label>

        <section className="nst-mcp-part" aria-labelledby="mcp-access">
          <h3 id="mcp-access">Что агенту можно</h3>
          <div className="nx-group" role="radiogroup" aria-labelledby="mcp-access">
            {ACCESS.map((a) => (
              <button key={a.value} type="button" role="radio" aria-checked={access === a.value} className="nx-row nst-mcp-choice" onClick={() => setAccess(a.value)}>
                <span className="nst-mcp-radio" aria-hidden="true" />
                <span className="nx-row-text"><span className="nx-row-label">{a.label}</span><span className="nx-row-hint">{a.hint}</span></span>
              </button>
            ))}
          </div>
        </section>

        <section className="nst-mcp-part" aria-labelledby="mcp-kinds">
          <h3 id="mcp-kinds">Какие материалы</h3>
          <div className="nst-mcp-kinds" role="group" aria-labelledby="mcp-kinds">
            {KINDS.map((k) => {
              const on = kinds.includes(k.value);
              return (
                <button key={k.value} type="button" role="checkbox" aria-checked={on} className="nst-mcp-kind" onClick={() => toggleKind(k.value)}>
                  <span className="nx-check" aria-hidden="true">{on && <Check size={11} strokeWidth={3} />}</span>{k.label}
                </button>
              );
            })}
          </div>
        </section>

        <section className="nst-mcp-part" aria-labelledby="mcp-where">
          <h3 id="mcp-where">Где</h3>
          <div className="nx-segment" role="group" aria-labelledby="mcp-where">
            <button type="button" aria-pressed={whole} onClick={() => setWhole(true)}>Весь «Офис»</button>
            <button type="button" aria-pressed={!whole} onClick={() => setWhole(false)}>Только выбранные папки</button>
          </div>
          {!whole && (folders === null ? <p className="nx-note">Загружаю папки…</p> : <FolderPicker folders={folders} selected={picked} onChange={setPicked} />)}
          {!whole && <p className="nx-note">Вложенные папки открываются вместе с родительской. Создавать новое агент сможет только внутри выбранных папок.</p>}
        </section>

        <div className="nx-group">
          <div className="nx-row">
            <span className="nx-row-text">
              <span className="nx-row-label">Чужие материалы</span>
              <span className="nx-row-hint">Те, которыми с вами поделились коллеги. Выключено — агент видит только ваши собственные.</span>
            </span>
            <Switch checked={shared} onChange={setShared} label="Чужие материалы" />
          </div>
          {!edit && (
            <div className="nx-row">
              <span className="nx-row-text"><span className="nx-row-label">Срок действия</span><span className="nx-row-hint">После срока ключ перестанет работать сам.</span></span>
              <Select value={expiry} onChange={setExpiry} groups={[{ options: EXPIRY }]} label="Срок действия" />
            </div>
          )}
        </div>
        {edit && <p className="nx-note">Ключ остаётся тем же: агент сразу работает с новым доступом, перенастраивать его не нужно.</p>}
      </div>
    </Sheet>
  );
}
