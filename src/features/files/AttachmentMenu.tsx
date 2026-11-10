import { useCallback, useState, type ReactNode } from 'react';
import { Download, Eye, FolderInput, PenLine } from 'lucide-react';
import { canOpenInEditor, openInEditor, viewKindOf } from '@/features/workspace';
import { downloadFile } from '@/shared/platform/download';
import { Menu, MenuItem, type MenuAnchor } from '@/shared/ui/overlay';
import { DocOverlay } from './DocOverlay';
import { SaveToFilesSheet } from './SaveToFilesSheet';

/** Вложение письма или чата: откуда взять и как называется. */
export interface AttachmentFile { url: string; name: string; size?: number; mimeType?: string }

/**
 * Что можно сделать с вложением — одно меню для почты и чатов: посмотреть, открыть копию в редакторе Шара, сохранить
 * в «Файлы» (с выбором папки) или на устройство. Открывается кликом по карточке и правой кнопкой.
 *
 * `onView` — свой просмотр (в чате он открывается в боковой панели); без него документ открывается поверх раздела.
 * Использование: `const att = useAttachmentMenu(file); … onClick={(e) => att.open({ element: e.currentTarget })} … {att.node}`.
 */
export function useAttachmentMenu(file: AttachmentFile, opts: { onView?: () => void } = {}): { open: (anchor: MenuAnchor) => void; node: ReactNode } {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const [saving, setSaving] = useState(false);
  const [viewing, setViewing] = useState(false);
  const [opening, setOpening] = useState(false);
  const close = useCallback(() => setAnchor(null), []);

  const viewable = viewKindOf(file.name) !== null;
  const editable = canOpenInEditor(file.name);

  const node = (
    <>
      {anchor && (
        <Menu anchor={anchor} label={`Вложение ${file.name}`} onClose={close}>
          {viewable && (
            <MenuItem icon={<Eye size={16} />} onSelect={() => { close(); if (opts.onView) opts.onView(); else setViewing(true); }}>Просмотр</MenuItem>
          )}
          {editable && (
            <MenuItem
              icon={<PenLine size={16} />}
              disabled={opening}
              onSelect={() => { close(); setOpening(true); void openInEditor({ url: file.url, name: file.name, size: file.size }).finally(() => setOpening(false)); }}
            >
              Открыть копию в редакторе
            </MenuItem>
          )}
          <MenuItem icon={<FolderInput size={16} />} onSelect={() => { close(); setSaving(true); }}>Сохранить в Файлы…</MenuItem>
          <MenuItem icon={<Download size={16} />} onSelect={() => { close(); downloadFile(file.url, file.name); }}>Сохранить на устройство</MenuItem>
        </Menu>
      )}
      {saving && <SaveToFilesSheet source={{ url: file.url, name: file.name, mimeType: file.mimeType }} onClose={() => setSaving(false)} />}
      {viewing && <DocOverlay file={{ url: file.url, name: file.name, size: file.size }} onClose={() => setViewing(false)} />}
    </>
  );

  return { open: setAnchor, node };
}
