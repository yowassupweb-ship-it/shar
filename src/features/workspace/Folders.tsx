import { useState, type ReactNode } from 'react';
import { ChevronRight, Folder as FolderIcon, FolderOpen } from 'lucide-react';
import { useLongPress } from '@/shared/ui/useLongPress';
import type { MenuAnchor } from '@/shared/ui/overlay';
import type { Folder } from './types';

/** Тип данных при перетаскивании строки материала (id материала). */
export const ITEM_DRAG = 'application/x-shar-item';

export const isItemDrag = (e: React.DragEvent) => e.dataTransfer.types.includes(ITEM_DRAG);

/** Тип данных при перетаскивании папки (id папки). */
export const FOLDER_DRAG = 'application/x-shar-folder';

export const isFolderDrag = (e: React.DragEvent) => e.dataTransfer.types.includes(FOLDER_DRAG);

/**
 * Папка в списке «Офиса»: строка с числом материалов, по щелчку раскрывается. На неё можно перетащить строку
 * материала или другую папку (папку саму тоже можно тащить); правый щелчок / долгое нажатие — меню
 * (переименовать, вложенная папка, удалить). Новая папка сразу в режиме имени.
 */
export function FolderRow({ folder, count, empty, open, editing, onToggle, onDropItem, onDropFolder, onMenu, onRename, children }: {
  folder: Folder;
  count: number;
  /** Нет ни материалов, ни вложенных папок — показываем подсказку. */
  empty: boolean;
  open: boolean;
  editing: boolean;
  onToggle: () => void;
  onDropItem: (itemId: string) => void;
  onDropFolder: (folderId: string) => void;
  onMenu: (anchor: MenuAnchor) => void;
  onRename: (title: string | null) => void;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  const press = useLongPress((x, y) => onMenu({ x, y }));
  const Icon = open ? FolderOpen : FolderIcon;
  return (
    <div className="nws-folder" data-open={open || undefined}>
      <div
        className="nws-folder-row"
        data-over={over || undefined}
        onDragOver={(e) => { if (!isItemDrag(e) && !isFolderDrag(e)) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          if (!isItemDrag(e) && !isFolderDrag(e)) return;
          e.preventDefault();
          e.stopPropagation();
          setOver(false);
          const item = e.dataTransfer.getData(ITEM_DRAG);
          const dragged = e.dataTransfer.getData(FOLDER_DRAG);
          if (item) onDropItem(item);
          else if (dragged && dragged !== folder.id) onDropFolder(dragged);
        }}
        onContextMenu={(e) => { e.preventDefault(); onMenu({ x: e.clientX, y: e.clientY }); }}
      >
        {editing ? (
          <span className="nws-folder-toggle">
            <ChevronRight size={14} className="nws-folder-chevron" aria-hidden="true" />
            <Icon size={18} className="nws-folder-icon" aria-hidden="true" />
            <input
              className="nws-folder-name"
              defaultValue={folder.title}
              autoFocus
              maxLength={120}
              aria-label="Название папки"
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') { e.currentTarget.value = folder.title; e.currentTarget.blur(); }
              }}
              onBlur={(e) => { const v = e.currentTarget.value.trim(); onRename(v && v !== folder.title ? v : null); }}
            />
          </span>
        ) : (
          <button
            type="button"
            className="nws-folder-toggle"
            aria-expanded={open}
            onClick={onToggle}
            draggable
            onDragStart={(e) => { e.dataTransfer.setData(FOLDER_DRAG, folder.id); e.dataTransfer.effectAllowed = 'move'; }}
            {...press}
          >
            <ChevronRight size={14} className="nws-folder-chevron" aria-hidden="true" />
            <Icon size={18} className="nws-folder-icon" aria-hidden="true" />
            <span className="nws-folder-title">{folder.title}</span>
            <span className="nws-folder-count">{count || ''}</span>
          </button>
        )}
      </div>
      {open && (
        <div className="nws-folder-items">
          {children}
          {empty && <p className="nws-folder-empty">Перетащите сюда документы, заметки, таблицы или другую папку</p>}
        </div>
      )}
    </div>
  );
}
