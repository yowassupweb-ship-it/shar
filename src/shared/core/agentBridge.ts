import { create } from 'zustand';

/**
 * Мост между разделами и «Ядром» без прямой зависимости фич друг от друга.
 *
 * Чаты: «Переслать агенту» кладёт сюда выбранные сообщения (только текст, автор, время, имена файлов) — «Ядро»
 * открывается и показывает их над полем ввода. Агенту чаты закрыты: он видит ровно то, что человек переслал сам.
 */
export interface AgentForward { author: string; text: string; at: string; files: string[] }

interface State {
  /** «Ядро» человеку включено — показывать «Переслать агенту». */
  available: boolean;
  pending: AgentForward[];
}

export const useAgentBridge = create<State>(() => ({ available: false, pending: [] }));

export const setAgentAvailable = (available: boolean) => {
  if (useAgentBridge.getState().available !== available) useAgentBridge.setState({ available });
};

/** Переслать агенту: добавить к уже пересланному (можно собрать из нескольких чатов) и позвать «Ядро». */
export function forwardToAgent(items: AgentForward[]) {
  if (!items.length) return;
  useAgentBridge.setState((s) => ({ pending: [...s.pending, ...items].slice(-50) }));
  window.dispatchEvent(new Event('shar:agent-forward'));
}

export const clearAgentForward = () => useAgentBridge.setState({ pending: [] });
