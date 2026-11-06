import type { ReactNode } from 'react';
import {
  Bot, CalendarPlus, CheckSquare, FileText, Folder, MessageSquarePlus, MessagesSquare, PenSquare, Search, Settings, Users,
} from 'lucide-react';
import { useMail } from '@/features/mail/api';
import { createOffice, openSpotlight } from '@/features/spotlight';
import { KIND_LIST, KINDS } from '@/features/workspace/kinds';
import { useAgentBridge } from '@/shared/core/agentBridge';
import { navigate } from '@/shared/navigation/navigate';
import { requestIntent } from '@/shared/navigation/quickIntent';
import { paths } from '@/shared/navigation/routes';
import { Menu, MenuItem, type MenuAnchor } from '@/shared/ui/overlay';
import type { SectionId } from './sections';

/**
 * Быстрые действия по правому клику на раздел нижней полосы: не заходя в раздел — новая задача, новое событие, письмо,
 * заметка или документ. Правый клик по «Чатам» вне самих чатов меню не вызывает — он открывает окно быстрого чата
 * (AppShell), поэтому здесь у «Чатов» только действия создания.
 */
export default function SectionMenu({ id, anchor, onClose }: { id: SectionId; current?: SectionId | null; anchor: MenuAnchor; onClose: () => void }) {
  const agentOn = useAgentBridge((s) => s.available);

  const item = (icon: ReactNode, label: string, run: () => void) => (
    <MenuItem key={label} icon={icon} onSelect={() => { onClose(); run(); }}>{label}</MenuItem>
  );

  let body: ReactNode = null;
  if (id === 'chats') {
    body = (
      <>
        {item(<MessageSquarePlus size={15} />, 'Новый чат', () => requestIntent('new-chat', paths.chats))}
        {item(<Users size={15} />, 'Новая группа', () => requestIntent('new-group', paths.chats))}
      </>
    );
  } else if (id === 'tasks') {
    body = item(<CheckSquare size={15} />, 'Новая задача', () => requestIntent('new-task', paths.tasks));
  } else if (id === 'calendar') {
    body = item(<CalendarPlus size={15} />, 'Новое событие', () => requestIntent('new-event', paths.calendar));
  } else if (id === 'contacts') {
    body = item(<Search size={15} />, 'Найти человека', () => openSpotlight());
  } else if (id === 'mail') {
    body = item(<PenSquare size={15} />, 'Написать письмо', () => { useMail.setState({ pendingCompose: { to: [] } }); navigate(paths.mail); });
  } else if (id === 'files') {
    body = (
      <>
        {item(<Folder size={15} />, 'Мои файлы', () => navigate(paths.files))}
        {item(<MessagesSquare size={15} />, 'Файлы из чатов', () => navigate(`${paths.files}?chat=`))}
        {agentOn && item(<Bot size={15} />, 'Файлы агентов по дням', () => navigate(`${paths.files}?agent=`))}
      </>
    );
  } else if (id === 'office') {
    body = KIND_LIST.map((k) => item(<k.icon size={15} />, k.newLabel, () => { void createOffice(k.kind as keyof typeof KINDS); }));
  } else if (id === 'more') {
    body = (
      <>
        {item(<Search size={15} />, 'Поиск по Шару', () => openSpotlight())}
        {item(<Settings size={15} />, 'Настройки', () => navigate(paths.settings))}
        {item(<FileText size={15} />, 'Инструкция', () => navigate(paths.guide))}
      </>
    );
  }
  if (!body) return null;
  return <Menu anchor={anchor} label="Быстрые действия" onClose={onClose} compact>{body}</Menu>;
}
