import { useEffect, useState } from 'react';
import { folderChain } from './api';

/**
 * Доступ, который файл или папка получает от папок выше: открыли папку — открыто и всё внутри неё.
 * userId → название папки, от которой пришло право (ближайшая к корню, где оно выдано).
 */
export interface InheritedAccess { view: Record<string, string>; edit: Record<string, string> }

const NONE: InheritedAccess = { view: {}, edit: {} };

/** `parentId` — папка, в которой лежит элемент: её саму и все её родительские папки. */
export async function inheritedAccess(parentId: string | null): Promise<InheritedAccess> {
  if (!parentId) return NONE;
  const out: InheritedAccess = { view: {}, edit: {} };
  for (const f of await folderChain(parentId)) {
    const edit = (f.editAccess || []).map(String);
    for (const id of (f.sharedWith || []).map(String).concat(edit)) if (!(id in out.view)) out.view[id] = f.name;
    for (const id of edit) if (!(id in out.edit)) out.edit[id] = f.name;
  }
  return out;
}

/** Пока грузится — пусто (спросим как раньше), как загрузится — перерисуем. */
export function useInheritedAccess(parentId: string | null): InheritedAccess {
  const [state, setState] = useState<{ at: string | null; data: InheritedAccess } | null>(null);
  useEffect(() => {
    let alive = true;
    void inheritedAccess(parentId).then((data) => { if (alive) setState({ at: parentId, data }); }).catch(() => {});
    return () => { alive = false; };
  }, [parentId]);
  return state && state.at === parentId ? state.data : NONE;
}
