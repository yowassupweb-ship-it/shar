import { create } from 'zustand';

/**
 * Мост между разделами и «Ядром» без прямой зависимости фич друг от друга.
 *
 * Чаты: «Переслать агенту» кладёт сюда выбранные сообщения (только текст, автор, время, имена файлов) — «Ядро»
 * открывается и показывает их над полем ввода. Агенту чаты закрыты: он видит ровно то, что человек переслал сам.
 * «Офис» и «Файлы»: «Отправить агенту» прикрепляет материал или файл к следующему сообщению (плашкой над полем ввода);
 * «Скрыть от агента» — сервер не покажет его агентам ни в списках, ни по id (core_agents/hidden.py).
 */
export interface AgentForward { author: string; text: string; at: string; files: string[] }
/** Что прикреплено к сообщению агенту: материал, папка, файл — с внутренним адресом, по которому агент его найдёт. */
export interface AgentAttach { kind: string; title: string; id: string; url: string }
export type HiddenKind = 'office_item' | 'office_folder' | 'file' | 'cloud_folder';

interface State {
  /** «Ядро» человеку включено — показывать действия «Ядра» в меню. */
  available: boolean;
  pending: AgentForward[];
  attached: AgentAttach[];
  hidden: Record<HiddenKind, string[]>;
}

const EMPTY_HIDDEN: Record<HiddenKind, string[]> = { office_item: [], office_folder: [], file: [], cloud_folder: [] };

export const useAgentBridge = create<State>(() => ({ available: false, pending: [], attached: [], hidden: EMPTY_HIDDEN }));

export const setAgentAvailable = (available: boolean) => {
  if (useAgentBridge.getState().available !== available) useAgentBridge.setState({ available });
  if (available) void loadHidden();
};

/** Переслать агенту: добавить к уже пересланному (можно собрать из нескольких чатов) и позвать «Ядро». */
export function forwardToAgent(items: AgentForward[]) {
  if (!items.length) return;
  useAgentBridge.setState((s) => ({ pending: [...s.pending, ...items].slice(-50) }));
  window.dispatchEvent(new Event('shar:agent-forward'));
}

export const clearAgentForward = () => useAgentBridge.setState({ pending: [] });

/** Отправить агенту материал или файл: плашка над полем ввода «Ядра», панель открывается. */
export function sendToAgent(item: AgentAttach) {
  useAgentBridge.setState((s) => ({ attached: [...s.attached.filter((a) => a.url !== item.url), item].slice(-10) }));
  window.dispatchEvent(new Event('shar:agent-forward'));
}

export const detachFromAgent = (url: string) => useAgentBridge.setState((s) => ({ attached: s.attached.filter((a) => a.url !== url) }));
export const clearAgentAttached = () => useAgentBridge.setState({ attached: [] });

async function loadHidden() {
  try {
    const res = await fetch('/api/core/hidden', { cache: 'no-store' });
    if (res.ok) useAgentBridge.setState({ hidden: { ...EMPTY_HIDDEN, ...(await res.json()) } });
  } catch { /* нет связи — меню просто покажет «Скрыть» */ }
}

export const isHiddenFromAgent = (kind: HiddenKind, id: string) => useAgentBridge.getState().hidden[kind]?.includes(String(id)) ?? false;

/** Скрыть от агента или вернуть. Ошибка — исключением (меню покажет её). */
export async function setHiddenFromAgent(kind: HiddenKind, id: string, hidden: boolean): Promise<void> {
  const res = await fetch('/api/core/hidden', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, id: String(id), hidden }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || 'Не получилось');
  }
  useAgentBridge.setState({ hidden: { ...EMPTY_HIDDEN, ...(await res.json()) } });
}
