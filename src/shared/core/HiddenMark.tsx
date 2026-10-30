import { EyeOff } from 'lucide-react';
import { useAgentBridge, type HiddenKind } from './agentBridge';

/**
 * Перечёркнутый глаз после названия: материал, файл или папка скрыты от агента «Ядра» (меню → «Скрыть от агента»).
 * Только у тех, у кого «Ядро» включено, — остальным это ничего не говорит.
 */
export function HiddenMark({ kind, id }: { kind: HiddenKind; id: string }) {
  const hidden = useAgentBridge((s) => s.available && (s.hidden[kind]?.includes(String(id)) ?? false));
  if (!hidden) return null;
  return (
    <span className="nx-agent-hidden" title="Скрыто от агента" aria-label="Скрыто от агента">
      <EyeOff size={13} aria-hidden="true" />
    </span>
  );
}
