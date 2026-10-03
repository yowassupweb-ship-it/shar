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
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  reload: () => Promise<void>;
  zoomIn: () => Promise<void>;
  zoomOut: () => Promise<void>;
  setZoom: (factor: number) => Promise<number | void>;
  getZoom: () => Promise<number>;
  onMaximizedChanged: (callback: (isMaximized: boolean) => void) => () => void;
}

export interface SharDesktop {
  platform: string;
  appVersion?: string;
  assets: {
    logoSrc: string;
  };
  openExternal: (url: string) => Promise<void>;
  windowControls: WindowControls;
  startup?: {
    get: () => Promise<{ supported: boolean; openAtLogin: boolean; preferred?: boolean }>;
    set: (openAtLogin: boolean) => Promise<{ supported: boolean; openAtLogin: boolean; preferred?: boolean }>;
  };
  showNotification: (data: NotificationData) => Promise<void>;
  onOpenChat: (callback: (chatId: string) => void) => () => void;
  onOpenRoute: (callback: (url: string) => void) => () => void;
  onRealtimePoke: (callback: (data: { chatId?: string | null; at?: number }) => void) => () => void;
  realtime?: {
    register: (userId: string) => Promise<boolean>;
    unregister: () => Promise<boolean>;
    setContext?: (ctx: { activeChatId: string; focused: boolean; lastInputAt: number }) => void;
    setAvatars?: (avatars: Record<string, string>) => void;
  };
  call?: {
    onIslandUpdate?: (callback: (data: { state: string | null; callerName?: string } | null) => void) => () => void;
    islandAction: (action: 'answer' | 'reject' | 'hangup' | 'restore') => void;
  };
  updater?: {
    onStatus: (callback: (data: { state: 'downloading' | 'downloaded'; version?: string; percent?: number }) => void) => () => void;
    install: () => Promise<void>;
  };
}

declare global {
  interface Window {
    sharDesktop?: SharDesktop;
  }
}

export {};
