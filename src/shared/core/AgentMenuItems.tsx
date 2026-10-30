import { EyeOff } from 'lucide-react';
import { CoreIcon } from '@/shared/ui/CoreIcon';
import { MenuItem } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import { sendToAgent, setHiddenFromAgent, useAgentBridge, type AgentAttach, type HiddenKind } from './agentBridge';

/**
 * Действия «Ядра» в правом меню материала, папки или файла — только тем, кому «Ядро» включено. Знак — атом «Ядра».
 * «Отправить агенту» прикрепляет к следующему сообщению; «Скрыть от агента» — сервер перестаёт показывать его агентам
 * (у папки — со всем вложенным). Скрытое отправить агенту нельзя.
 */
export function AgentMenuItems({ target, hiddenKind, onDone }: { target: AgentAttach; hiddenKind: HiddenKind; onDone: () => void }) {
  const available = useAgentBridge((s) => s.available);
  const hidden = useAgentBridge((s) => s.hidden[hiddenKind]?.includes(String(target.id)) ?? false);
  if (!available) return null;
  const toggle = () => {
    onDone();
    setHiddenFromAgent(hiddenKind, target.id, !hidden)
      .then(() => showToast(hidden ? `«${target.title}» снова видно агенту` : `«${target.title}» скрыто от агента${hiddenKind.endsWith('folder') ? ' — со всем, что внутри' : ''}`, 'success'))
      .catch((cause) => showToast(cause instanceof Error ? cause.message : 'Не получилось', 'error'));
  };
  return (
    <>
      <div className="nx-menu-sep" />
      {!hidden && <MenuItem icon={<CoreIcon size={15} />} onSelect={() => { onDone(); sendToAgent(target); }}>Отправить агенту</MenuItem>}
      <MenuItem icon={hidden ? <CoreIcon size={15} /> : <EyeOff size={15} />} onSelect={toggle}>{hidden ? 'Показать агенту' : 'Скрыть от агента'}</MenuItem>
    </>
  );
}
