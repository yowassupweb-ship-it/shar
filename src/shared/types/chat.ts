export interface User {
  id: string;
  name?: string;
  username?: string;
  email?: string;
  role: 'admin' | 'user';
  lastSeen?: string;
  isOnline?: boolean;
  shortId?: string;
  avatar?: string;
}

export interface CallInfo {
  type: 'voice' | 'video';
  direction: 'incoming' | 'outgoing';
  status: 'completed' | 'missed' | 'declined';
  duration?: number; // в секундах (только для completed)
  timestamp: Date;
}

export type MessageReactions = Record<string, string[]>;

export interface Message {
  id: string;
  chatId: string;
  authorId: string;
  authorName: string;
  content: string;
  mentions: string[];
  replyToId?: string;
  createdAt: string;
  updatedAt?: string;
  isEdited: boolean;
  isDeleted?: boolean;
  attachments?: any[];
  isSystemMessage?: boolean;
  linkedChatId?: string;
  linkedMessageId?: string;
  linkedTaskId?: string;
  linkedPostId?: string;
  linkedEventId?: string;
  notificationType?: string;
  callInfo?: CallInfo; // информация о звонке
  // Информация о пересылке
  forwardedFromUserId?: string;
  forwardedFromUsername?: string;
  forwardedFromMessageId?: string;
  /** Set locally (never persisted) when the optimistic send/retry POST failed. */
  _failed?: boolean;
  /** Set locally (never persisted) when the backend confirms at least one
      recipient's device actually received an OS push notification for this
      message (see the WS 'push_delivered' event) — a step between "sent to
      server" and "read", distinct from both. */
  _pushDelivered?: boolean;
  metadata?: {
    taskTitle?: string;
    postTitle?: string;
    fromUserName?: string;
    forwardedFromUserId?: string;
    forwardedFromUsername?: string;
    forwardedFromMessageId?: string;
    linkedEventId?: string;
    linkedEventTitle?: string;
    oldStatus?: string;
    newStatus?: string;
    executorName?: string;
    isPinned?: boolean;
    pinnedBy?: string;
    pinnedAt?: string;
    pinnedMessageId?: string;
    preview?: string;
    reactions?: MessageReactions;
    /** Опрос в сообщении (создаётся PollCreatorModal, рисуется PollBubble). */
    poll?: Record<string, unknown>;
    /** Голосовое прослушано получателем (снимает точку «не прослушано»). */
    voiceListened?: boolean;
    /** Стикер: адрес, эмодзи и набор. */
    sticker?: { url: string; emoji?: string; setName?: string };
    /** Нонс отправки: по нему бэкенд узнаёт повтор и не создаёт второй копии,
     *  а клиент сопоставляет эхо по сокету со своим оптимистичным сообщением. */
    clientNonce?: string;
    /** Источник «колокольчика» — уведомления из внешней менеджерки. */
    source?: string;
    /** Системное событие (создание группы, вход/выход участника). */
    systemEvent?: string;
    callStatus?: string;
    callAction?: string;
    callMode?: string;
  };
}

export interface Chat {
  id: string;
  title?: string;
  avatar?: string;
  isGroup: boolean;
  isNotificationsChat?: boolean;
  isSystemChat?: boolean;
  isFavoritesChat?: boolean;
  participantIds: string[];
  creatorId?: string;
  createdAt: string;
  readMessagesByUser?: Record<string, string>;
  pinnedByUser?: Record<string, boolean>;
  pinnedOrderByUser?: Record<string, number>;
  archivedByUser?: Record<string, boolean>;
  mutedByUser?: Record<string, boolean>;
  isArchivedForUser?: boolean;
  discussionStatus?: string;
  todoStatus?: string;
  todoId?: string;
  lastMessage?: Message;
  unreadCount?: number;
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority?: string;
  dueDate?: string;
  assignedTo?: string | string[];
  authorId?: string;
  createdAt: string;
  assignedById?: string;
  assignedToId?: string;
  assignedToIds?: string[];
}
