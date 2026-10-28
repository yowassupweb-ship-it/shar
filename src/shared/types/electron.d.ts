export interface NotificationData {
  senderName?: string;
  title?: string;
  subtitle?: string;
  chatName?: string;
  message: string;
  avatar?: string;
  timestamp?: string | number;
  badge?: number;
  chatId?: string;
  messageId?: string;
  url?: string;
  kind?: 'message' | 'task' | 'event' | 'system';
}

export interface WindowControls {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<boolean>;
  /** Окно на весь экран (показ презентации); в старых сборках приложения может не быть. */
  setFullScreen?: (on: boolean) => Promise<boolean>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  reload: () => Promise<void>;
  zoomIn: () => Promise<void>;
  zoomOut: () => Promise<void>;
  setZoom: (factor: number) => Promise<number | void>;
  getZoom: () => Promise<number>;
  onMaximizedChanged: (callback: (isMaximized: boolean) => void) => () => void;
}

export interface UpdaterStatus {
  /** downloading — идёт тихая загрузка; downloaded — готово; installing — перезапуск; updated — только что обновились. */
  state: 'downloading' | 'downloaded' | 'installing' | 'updated' | 'error';
  version?: string;
  percent?: number;
  message?: string;
}

export interface SharDesktop {
  platform: string;
  appVersion?: string;
  assets: {
    logoSrc: string;
  };
  openExternal: (url: string) => Promise<void>;
  /** Скачать файл окном «Сохранить как» (в старых сборках приложения может не быть). */
  downloadFile?: (url: string, name: string) => Promise<void>;
  /** Число чатов с непрочитанным — на кнопку приложения в панели задач и в трей. */
  setBadgeCount?: (count: number) => void;
  /** Громкость сигнала карточек уведомлений (их звук играет главный процесс). */
  notifications?: { setVolume: (volume: number) => void; getVolume: () => Promise<number> };
  windowControls: WindowControls;
  startup?: {
    get: () => Promise<{ supported: boolean; openAtLogin: boolean; preferred?: boolean }>;
    set: (openAtLogin: boolean) => Promise<{ supported: boolean; openAtLogin: boolean; preferred?: boolean }>;
  };
  showNotification: (data: NotificationData) => Promise<void>;
  onOpenChat: (callback: (chatId: string) => void) => () => void;
  onOpenRoute: (callback: (url: string) => void) => () => void;
  /** Новые сообщения, принятые главным процессом по прямому сокету. */
  onRealtimeEvent?: (callback: (event: { type: string; chatId?: string; [key: string]: unknown }) => void) => () => void;
  onRealtimePoke: (callback: (data: { chatId?: string | null; at?: number }) => void) => () => void;
  realtime?: {
    register: (userId: string) => Promise<boolean>;
    unregister: () => Promise<boolean>;
    setContext?: (ctx: { activeChatId: string; focused: boolean; lastInputAt: number }) => void;
    setAvatars?: (avatars: Record<string, string>) => void;
    setMutedChats?: (ids: string[]) => void;
  };
  /** Заметки на рабочем столе: отдельные окна (desktop/electron/sticky-notes.cjs). */
  sticky?: {
    /** kind — вид материала (note | document | table), width/height — размер окна (по умолчанию свой у каждого вида). */
    open: (noteId: string, point?: { x: number; y: number } | null, opts?: { kind?: string; width?: number; height?: number } | null) => Promise<{ ok: boolean }>;
    /** Это окно теперь показывает другой материал. focusedExisting — он уже открыт в другом окне, показано то. */
    switchTo: (noteId: string, kind?: string) => Promise<{ ok: boolean; focusedExisting?: boolean }>;
    close: (noteId?: string) => Promise<unknown>;
    forget: (noteId: string) => Promise<unknown>;
    setOnTop: (value?: boolean) => Promise<boolean>;
    minimize: () => Promise<unknown>;
    state: () => Promise<{ id: string; onTop: boolean; open: string[] }>;
    /** Показать главное окно; с адресом — открыть в нём этот раздел (например /office?kind=note&id=5). */
    focusMain: (url?: string) => Promise<unknown>;
  };
  call?: {
    onIslandUpdate?: (callback: (data: { state: string | null; callerName?: string } | null) => void) => () => void;
    islandAction: (action: 'answer' | 'reject' | 'hangup' | 'restore') => void;
  };
  updater?: {
    onStatus: (callback: (data: UpdaterStatus) => void) => () => void;
    install: () => Promise<void>;
  };
}

declare global {
  interface Window {
    sharDesktop?: SharDesktop;
  }
}

export {};
