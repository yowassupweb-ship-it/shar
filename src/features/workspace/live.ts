import { realtime } from '@/shared/realtime/realtime';
import { showToast } from '@/shared/ui/Toast';
import { KINDS } from './kinds';
import type { Kind } from './types';

/**
 * Живая сторона «Офиса»: сервер присылает `workspace_changed`, когда кому-то открыли материал, убрали доступ,
 * удалили или переименовали его. Здесь — всё, что нужно от события вне самого раздела: уведомление «вам открыли».
 * Сам раздел подписывается отдельно и перечитывает список.
 */
export interface WorkspaceEvent {
  type: 'workspace_changed';
  reason: 'shared' | 'changed';
  itemId: string;
  kind: Kind;
  title: string;
  by: string;
}

export const isWorkspaceEvent = (event: { type?: string }): event is WorkspaceEvent => event.type === 'workspace_changed';

/** Один раз на приложение (AppRoot): тост «Вам открыли доступ». Возвращает отписку. */
export function startWorkspaceToasts(): () => void {
  return realtime.subscribe((event) => {
    if (!isWorkspaceEvent(event) || event.reason !== 'shared') return;
    const info = KINDS[event.kind];
    if (!info) return;
    const title = event.title || info.untitled;
    showToast(`${event.by || 'Коллега'} открыл(а) вам ${info.accusative}: «${title}». Она уже в «Офисе»`, 'info');
  });
}
