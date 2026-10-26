import { useChatStore } from '@/features/chat';
import { myId } from '@/shared/session/session';
import { showToast } from '@/shared/ui/Toast';

/**
 * Инструменты в нижнем меню (Заявки, Соцсети…) — поле пользователя navTools на сервере,
 * общее для всех его устройств. Меняется перетаскиванием плитки из «Ещё» на меню, пунктом меню
 * плитки или правым щелчком по инструменту в самом меню.
 */
export const NAV_TOOL_DRAG = 'application/x-shar-tool';

export function navToolIds(): string[] {
  const me = useChatStore.getState().users[myId()] as { navTools?: string[] } | undefined;
  return Array.isArray(me?.navTools) ? me!.navTools! : [];
}

export async function setNavTools(ids: string[]): Promise<void> {
  const id = myId();
  if (!id) return;
  const prev = navToolIds();
  const next = [...new Set(ids)];
  const patch = (list: string[]) => useChatStore.setState((s) => ({ users: { ...s.users, [id]: { ...s.users[id], navTools: list } } }));
  patch(next);
  try {
    const res = await fetch(`/api/users/${encodeURIComponent(id)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ navTools: next }),
    });
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    patch(prev);
    showToast('Не удалось сохранить нижнее меню', 'error');
  }
}

export const addNavTool = (toolId: string) => setNavTools([...navToolIds().filter((x) => x !== toolId), toolId]);
export const removeNavTool = (toolId: string) => setNavTools(navToolIds().filter((x) => x !== toolId));
