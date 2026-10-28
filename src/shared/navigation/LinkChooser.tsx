import { AppWindow, CornerDownRight } from 'lucide-react';
import { Menu, MenuItem } from '@/shared/ui/overlay';
import { openHere, openInNewWindow, useLinkChooser } from './internalLinks';

/**
 * «Куда открыть?» — после Ctrl/⌘+клика по ссылке на материал Шара: здесь, вместо того, что на экране
 * (документ вместо таблицы), или в новом окне. Монтируется один раз в корне приложения.
 */
export default function LinkChooserHost() {
  const pending = useLinkChooser((s) => s.pending);
  if (!pending) return null;
  const close = () => useLinkChooser.setState({ pending: null });
  return (
    <Menu anchor={pending.at} label="Куда открыть ссылку" onClose={close}>
      <MenuItem icon={<CornerDownRight size={16} />} onSelect={() => { close(); openHere(pending.path); }}>Открыть здесь, вместо текущего</MenuItem>
      <MenuItem icon={<AppWindow size={16} />} onSelect={() => { close(); void openInNewWindow(pending.path); }}>Открыть в новом окне</MenuItem>
    </Menu>
  );
}
