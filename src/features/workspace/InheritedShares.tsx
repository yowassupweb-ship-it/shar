import { Building2 } from 'lucide-react';
import type { InheritedShare } from './types';

/** Доступ, пришедший от папки выше: человек уже видит материал, хоть выдан он не здесь. Снимается в той папке. */
export function InheritedShares({ entries }: { entries: InheritedShare[] }) {
  return (
    <>
      {entries.map((entry) => (
        <div key={`${entry.kind}:${entry.id}:${entry.folderId}`} className="nx-row">
          <span className="nx-row-text">
            <span className="nx-row-label">
              {entry.kind === 'department' && <Building2 size={14} aria-hidden="true" className="nws-dept-icon" />}
              {entry.kind === 'department' ? ` ${entry.name}` : entry.name || entry.id}
            </span>
            <span className="nx-row-hint">
              {entry.kind === 'department' ? `Отдел · ${entry.members ?? 0} чел. · ` : ''}через папку «{entry.folderTitle}»
            </span>
          </span>
          <span className="nx-row-hint">{entry.role === 'move' ? 'Перемещает и правит' : entry.role === 'edit' ? 'Правит' : 'Читает'}</span>
        </div>
      ))}
    </>
  );
}
