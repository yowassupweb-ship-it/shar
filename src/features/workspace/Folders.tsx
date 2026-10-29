import { useState, type ReactNode } from 'react';
import { ChevronRight, Folder as FolderIcon, FolderOpen, Users } from 'lucide-react';
import { useLongPress } from '@/shared/ui/useLongPress';
import type { MenuAnchor } from '@/shared/ui/overlay';
import type { Folder } from './types';
import { Highlight } from './lib/highlight';

/** Тип данных при перетаскивании строки материала (id материала). */
export const ITEM_DRAG = 'application/x-shar-item';

export const isItemDrag = (e: React.DragEvent) => e.dataTransfer.types.includes(ITEM_DRAG);

/** Тип данных при перетаскивании папки (id папки). */
export const FOLDER_DRAG = 'application/x-shar-folder';

export const isFolderDrag = (e: React.DragEvent) => e.dataTransfer.types.includes(FOLDER_DRAG);

/** Можно ли раскладывать в папке: своя или открытая с правом «Перемещение и редактирование». */
export const canArrange = (folder: Folder | undefined) => !folder?.role || folder.role === 'owner' || folder.role === 'move';

/** Как назвать право на открытую папку в строке и меню. */
export const FOLDER_ROLE_NOTE: Record<string, string> = { view: ' · только просмотр', edit: ' · редактирование', move: ' · перемещение и редактирование' };

/** Куда отпускают над строкой: перед ней, после неё или внутрь (только папка). */
export type DropZone = 'before' | 'after' | 'into';

/** Зона по высоте строки: верхняя четверть — «перед», нижняя — «после», середина — «внутрь» (если можно). */
export function zoneOf(e: React.DragEvent, allowInto: boolean): DropZone {
  const r = e.currentTarget.getBoundingClientRect();
  const y = (e.clientY - r.top) / Math.max(1, r.height);
  if (!allowInto) return y < 0.5 ? 'before' : 'after';
  return y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'into';
}

/**
 * Папка в списке «Офиса»: строка с числом материалов (со вложенными), по щелчку раскрывается. Папку можно тащить:
 * отпущенная у верхнего или нижнего края другой папки встаёт перед ней или после, в середине — внутрь. Материал,
 * отпущенный на папку, ложится в неё. Правый щелчок / долгое нажатие — меню. Новая папка сразу в режиме имени.
 */
export function FolderRow({ folder, count, empty, otherKinds, open, terms, editing, onToggle, onDropItem, onDropFolder, onMenu, onRename, children }: {
  folder: Folder;
  count: number;
  /** Поиск: слова для подсветки в названии. */
  terms?: string[];
  /** Нет ни материалов, ни вложенных папок — показываем подсказку. */
  empty: boolean;
  /** В разделе папка пуста, но в ней есть материалы других видов — «пусто» было бы неправдой. */
  otherKinds?: boolean;
  open: boolean;
  editing: boolean;
  onToggle: () => void;
  onDropItem: (itemId: string) => void;
  onDropFolder: (folderId: string, zone: DropZone) => void;
  onMenu: (anchor: MenuAnchor) => void;
  onRename: (title: string | null) => void;
  children: ReactNode;
}) {
  const [over, setOver] = useState<DropZone | null>(null);
  const press = useLongPress((x, y) => onMenu({ x, y }));
  const Icon = open ? FolderOpen : FolderIcon;
  // Чужая папка, открытая вам: раскладывать в ней можно с правом «Перемещение и редактирование», иначе — только владельцу.
  const own = !folder.role || folder.role === 'owner';
  const arrange = canArrange(folder);
  // Значок — только у верхней папки открытой ветки (вложенные открыты вместе с ней) и у своих, открытых напрямую.
  const sharedNote = own
    ? (folder.shares ? `Открыта: ${folder.shares}` : '')
    : (!folder.parentId ? `Открыта вам · ${folder.ownerName || 'коллега'}${FOLDER_ROLE_NOTE[folder.role || ''] || ''}` : '');
  return (
    <div className="nws-folder" data-open={open || undefined}>
      <div
        className="nws-folder-row"
        data-flip={`f${folder.id}`}
        data-over={over === 'into' || undefined}
        data-drop={over && over !== 'into' ? over : undefined}
        onDragOver={(e) => {
          const item = isItemDrag(e);
          if (!arrange || (!item && !isFolderDrag(e))) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'move';
          setOver(item ? 'into' : zoneOf(e, true));
        }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null); }}
        onDrop={(e) => {
          if (!arrange || (!isItemDrag(e) && !isFolderDrag(e))) return;
          e.preventDefault();
          e.stopPropagation();
          const zone = isItemDrag(e) ? 'into' : zoneOf(e, true);
          setOver(null);
          const item = e.dataTransfer.getData(ITEM_DRAG);
          const dragged = e.dataTransfer.getData(FOLDER_DRAG);
          if (item) onDropItem(item);
          else if (dragged && dragged !== folder.id) onDropFolder(dragged, zone);
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
            draggable={arrange}
            onDragStart={(e) => { e.dataTransfer.setData(FOLDER_DRAG, folder.id); e.dataTransfer.effectAllowed = 'move'; }}
            {...press}
          >
            <ChevronRight size={14} className="nws-folder-chevron" aria-hidden="true" />
            <Icon size={18} className="nws-folder-icon" aria-hidden="true" />
            <span className="nws-folder-title"><Highlight text={folder.title} terms={terms ?? []} /></span>
            {sharedNote && <span className="nws-folder-shared" title={sharedNote} aria-label={sharedNote}><Users size={13} aria-hidden="true" /></span>}
            <span className="nws-folder-count">{count || ''}</span>
          </button>
        )}
      </div>
      {open && (
        <div className="nws-folder-items">
          {children}
          {/* data-flip: подсказка переезжает вместе со строками, а не прыгает, пока выше раскрывают или сворачивают папку. */}
          {empty && (
            <p className="nws-folder-empty" data-flip={`e${folder.id}`}>
              {otherKinds ? 'Здесь только материалы других видов' : arrange ? 'Пусто — перетащите сюда материал или папку' : 'Папка пока пустая'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
