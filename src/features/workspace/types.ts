/** Материалы рабочего пространства: заметки, документы, таблицы, презентации. */

export type Kind = 'note' | 'document' | 'table' | 'presentation';
export type AccessLevel = 'private' | 'all';
export type AccessMode = 'edit' | 'view';
export type Role = 'owner' | 'edit' | 'view';

export type NoteColor = 'default' | 'red' | 'orange' | 'yellow' | 'green' | 'cyan' | 'blue' | 'purple' | 'gray';

export interface Item {
  id: string;
  kind: Kind;
  title: string;
  pinned: boolean;
  isTemplate: boolean;
  /** Служебные поля вида: у заметки — цветная метка. */
  meta: { color?: NoteColor } & Record<string, unknown>;
  ownerId: string;
  ownerName: string;
  accessLevel: AccessLevel;
  accessMode: AccessMode;
  createdAt: string;
  updatedAt: string;
  sizeBytes: number;
  snippet: string;
  /** Права текущего человека (считает сервер). */
  isOwner: boolean;
  canEdit: boolean;
  role: Role | null;
  /** Только у карточки (GET /items/{id}); в списке содержимого нет. */
  content?: string;
  /** Материал ещё не открывали (выделяется в списке). */
  isNew?: boolean;
  /** Своя папка, куда человек положил материал; у каждого своя раскладка. */
  folderId?: string | null;
}

/** Папка «Офиса» — личная: раскладывает материалы только для её владельца. Папки вкладываются друг в друга. */
export interface Folder { id: string; parentId: string | null; title: string; createdAt: string }

export interface ShareEntry { userId: string; role: 'view' | 'edit'; name: string }
/** Доступ, выданный отделу: его сотрудники (и подразделов) получают материал в свой «Офис» сразу. */
export interface DeptShareEntry { departmentId: string; role: 'view' | 'edit'; name: string; members: number }
export interface SharesState { shares: ShareEntry[]; departments: DeptShareEntry[] }
export interface LinkEntry { token: string; mode: 'view' | 'edit'; createdAt: string; lastUsedAt: string | null }

/** Материал, открытый по ссылке: без прав на другие материалы и без владельца. */
export interface SharedItem {
  id: string;
  kind: Kind;
  title: string;
  content: string;
  meta: Item['meta'];
  updatedAt: string;
}

/** Кто сейчас в материале (присутствие, как в Google Docs). */
export interface Viewer { userId: string; name: string; avatar: string; editing: boolean }

/** Строка истории версий: состояние материала до очередной правки и кто его сохранил. */
export interface VersionRow { id: string; title: string; label: string; size: number; createdAt: string; savedBy: string; savedByName: string }
export interface VersionsState {
  versions: VersionRow[];
  /** Нынешнее состояние: когда и кем сохранено последний раз. */
  current: { updatedAt: string; title: string; savedBy: string; savedByName: string };
  canRestore: boolean;
}
