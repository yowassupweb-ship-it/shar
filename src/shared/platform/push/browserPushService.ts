import { playBellStrike } from '@/shared/platform/push/sounds';
import { isUserAttending } from '@/shared/platform/push/userAttention';
import { realtime } from '@/shared/realtime/realtime';
import { navigate } from '@/shared/navigation/navigate';
import { fromLegacyUrl, links, paths } from '@/shared/navigation/routes';

type PollContext = {
  activeTab?: string;
  isChatOpen?: boolean;
  /** ID чата, открытого прямо сейчас (для точечного подавления дублей). */
  activeChatId?: string;
};

type StartOptions = {
  userId: string;
  userName?: string;
  getContext?: () => PollContext;
};

type ChatSnapshot = {
  unreadCount: number;
  lastMessageId: string;
  lastMessageKey?: string;
};

type CalendarReminderEvent = {
  id?: string;
  title?: string;
  date?: string;
  time?: string;
  remind?: boolean;
  type?: string;
  description?: string;
  createdBy?: string;
  assignedTo?: string;
  updatedAt?: string;
  /** Календарь нового Шара: за сколько минут напомнить (0 — в момент начала). */
  reminderMinutesBefore?: number | null;
};

type CalendarEventSnapshot = {
  author?: string;
  title: string;
  date: string;
  time: string;
  remind: boolean;
  type: string;
  description: string;
};

type LooseRecord = Record<string, unknown>;

// WebSocket is now the primary channel (see connectWs) — the backend broadcasts
// new_message / read_receipt / notifications_read etc. over /api/ws/{userId}. We react
// to those (debounced) instead of hammering /api/chats every 1.5s, which was ~37% of
// all server requests. The interval below is only a slow safety-net (visible tab only)
// to reconcile anything a missed event dropped — and to cover tasks/calendar, which
// have no WS event of their own.
const SAFETY_POLL_INTERVAL_MS = 30000;
const EVENT_POLL_DEBOUNCE_MS = 600;
const SEEN_LIMIT = 300;
const CALENDAR_REMINDER_WINDOW_MS = 60 * 60 * 1000; // 1 час (для пропущенных)
const CALENDAR_EVENT_START_WINDOW_MS = 30 * 1000; // ± 30 секунд - напоминание РОВНО в момент начала события

const isElectronRuntime = (): boolean => {
  if (typeof window !== 'undefined' && Boolean(window.sharDesktop?.showNotification || window.sharDesktop?.windowControls)) {
    return true;
  }
  if (typeof navigator === 'undefined') return false;
  return /electron/i.test(navigator.userAgent || '');
};


const PUBLIC_PUSH_KEY_ENDPOINT = '/api/push/subscriptions';

function asRecord(value: unknown): LooseRecord {
  return value && typeof value === 'object' ? value as LooseRecord : {};
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }

  return outputArray;
}

export class BrowserPushService {
  private userId: string | null = null;
  private userName: string | null = null;
  private timer: number | null = null;
  private running = false;
  private isPrimed = false;
  private getContext: (() => PollContext) | null = null;
  private inFlight = false;
  private visibilityHandler: (() => void) | null = null;
  private focusHandler: (() => void) | null = null;
  private unreadHintHandler: ((event: Event) => void) | null = null;
  private pageUnreadGoneHandler: (() => void) | null = null;
  /** What «Входящие» shows, broadcast by the open chat list; null when that list
   *  isn't mounted. The list knows local read marks the server's unreadCount lags
   *  behind — the raw server count put a phantom "1" on the app icon. */
  private pageUnreadCount: number | null = null;
  private realtimePokeUnsubscribe: (() => void) | null = null;
  /** Electron: keeps the main process told which chat is open and whether the
   *  person is actually typing, so its socket does not raise cards for that chat. */
  private desktopContextTimer: number | null = null;
  private desktopContextHandler: ((event: Event) => void) | null = null;
  private lastInputAt = 0;
  private lastDesktopContext = '';
  private swMessageHandler: ((event: MessageEvent) => void) | null = null;
  private pollCycleCounter = 0;
  private avatarCacheRefreshTimer: number | null = null;
  // App-wide WebSocket (same /api/ws/{userId} channel the chat page uses) — the
  // primary trigger for refreshes now, replacing the old 1.5s poll timer.
  private realtimeOff: (() => void) | null = null;
  private eventPollTimer: number | null = null;

  private seenTaskIds = new Set<string>();
  private chatSnapshots = new Map<string, ChatSnapshot>();
  private userAvatarCache = new Map<string, string>(); // userId → avatarUrl
  private eventVersions = new Map<string, string>();
  private calendarEventVersions = new Map<string, string>();
  private calendarEventSnapshots = new Map<string, CalendarEventSnapshot>();
  private firedCalendarReminders = new Set<string>();
  private notifiedEventVersions = new Set<string>();
  private shownKeys = new Set<string>();
  // chatIds recently notified by the SW web push (to avoid poll-path duplicates)
  private swPushedChatIds = new Set<string>();
  // When true, pollChats updates snapshots but never shows notifications.
  // Set on tab-visibility-restored to silently catch up without duplicating SW OS notifications.
  private silentCatchUpMode = false;
  /** Название/тип/аватар/«без звука» по чатам — заполняется опросом, нужен
   *  мгновенному пути: WS-событие несёт сообщение, но не описание чата. */
  private chatDisplayCache = new Map<string, { title: string; isGroup: boolean; avatar: string; mutedByServer: boolean }>();
  private chatUnreadTotal = 0;
  private taskUnreadTotal = 0;
  private mainRealtimeHandlesMessages = false;
  /** Bumped by stop(): a start() still awaiting when it was stopped must not come
   *  back to life with its own socket and poll next to the instance that replaced it. */
  private startToken = 0;

  async start(options: StartOptions): Promise<void> {
    if (!options.userId) return;

    this.stop();
    this.userId = options.userId;
    this.userName = options.userName ? String(options.userName) : null;
    this.getContext = options.getContext || null;
    const startToken = this.startToken;
    const mainRealtimeHandlesMessages = Boolean(await window.sharDesktop?.realtime?.register(this.userId));
    if (startToken !== this.startToken) return;
    this.mainRealtimeHandlesMessages = mainRealtimeHandlesMessages;

    this.restoreState();
    await this.ensurePermissionAndWorker();
    if (startToken !== this.startToken) return;

    // Listen for SW messages
    if ('serviceWorker' in navigator) {
      this.swMessageHandler = async (event: MessageEvent) => {
        // Re-subscribe after push key rotation
        if (event.data?.type === 'push-resubscribed' && event.data.subscription && this.userId) {
          try {
            await fetch(PUBLIC_PUSH_KEY_ENDPOINT, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                userId: this.userId,
                subscription: event.data.subscription,
                userAgent: navigator.userAgent,
                platform: navigator.platform,
              }),
            });
          } catch { /* ignore */ }
        }

        // Клик по уведомлению с разделом (не чатом): переход внутри приложения.
        // Чат открывает стор чатов — он сам слушает notification-navigate.
        if (event.data?.type === 'notification-navigate' && !event.data?.chatId && event.data?.tab) {
          const target = fromLegacyUrl(`/account?tab=${encodeURIComponent(String(event.data.tab))}`);
          if (target) navigate(target);
        }

        // SW pushed a web-push OS notification for this chat — suppress the next poll cycle
        // for that chatId so we don't show a duplicate browser notification
        if (event.data?.type === 'push-sync' && event.data?.chatId) {
          const isTabVisible = typeof document !== 'undefined' && document.visibilityState === 'visible';
          if (!isTabVisible) {
            const chatId = String(event.data.chatId);
            this.swPushedChatIds.add(chatId);
            setTimeout(() => this.swPushedChatIds.delete(chatId), 10000);
          }
        }
      };
      navigator.serviceWorker.addEventListener('message', this.swMessageHandler);
    }

    this.running = true;
    this.attachWakeHandlers();
    await this.refreshUserAvatarCache();
    if (startToken !== this.startToken) return;
    void this.syncMutedChatsToSW();
    await this.poll(true);

    if (!this.running || startToken !== this.startToken) return;

    // Primary channel: WebSocket. React to real events (debounced) instead of the
    // old 1.5s poll. The interval below is only a slow, visible-tab-only safety net.
    this.connectWs();
    this.timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void this.poll(false);
    }, SAFETY_POLL_INTERVAL_MS);

    // Refresh avatar cache every 5 minutes (300000ms) to pick up profile updates
    this.avatarCacheRefreshTimer = window.setInterval(() => {
      void this.refreshUserAvatarCache();
    }, 300000);
  }

  stop(): void {
    this.startToken += 1;
    this.running = false;
    this.isPrimed = false;
    this.inFlight = false;
    this.userName = null;
    this.mainRealtimeHandlesMessages = false;
    void window.sharDesktop?.realtime?.unregister?.();
    this.chatUnreadTotal = 0;
    this.taskUnreadTotal = 0;
    this.updateAppBadge(0);
    this.detachWakeHandlers();
    if (this.swMessageHandler !== null && 'serviceWorker' in navigator) {
      navigator.serviceWorker.removeEventListener('message', this.swMessageHandler);
      this.swMessageHandler = null;
    }
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    if (this.avatarCacheRefreshTimer !== null) {
      window.clearInterval(this.avatarCacheRefreshTimer);
      this.avatarCacheRefreshTimer = null;
    }
    this.disconnectWs();
    if (this.eventPollTimer !== null) { window.clearTimeout(this.eventPollTimer); this.eventPollTimer = null; }
  }

  // События берём из общего realtime-канала вкладки (shared/realtime) — своего
  // сокета у сервиса нет. После каждого (пере)подключения канал присылает
  // resync: один догоняющий опрос покрывает всё, что пришло, пока связи не было.
  private connectWs(): void {
    if (!this.userId || typeof window === 'undefined') return;
    this.disconnectWs();
    const stop = realtime.start(this.userId);
    const off = realtime.subscribe((event) => this.onRealtimeEvent(event as Record<string, unknown>));
    this.realtimeOff = () => { off(); stop(); };
  }

  private disconnectWs(): void {
    this.realtimeOff?.();
    this.realtimeOff = null;
  }

  private onRealtimeEvent(data: Record<string, unknown>): void {
    if (data.type === 'resync') { void this.poll(false); return; }
    const type = String(data?.type || '');
    if (!type || type === 'ping' || type === 'hello' || type === 'ack' || type === 'nack') return;
    // Instant in-app bell for a live «Колокольчик» notification (foreground only —
    // hidden tab is covered by the OS/web push). Done here, off the raw WS event,
    // rather than waiting on the debounced poll whose guards can drop it; the bell's
    // own debounce prevents a double-strike with the poll path.
    if (type === 'new_message' && typeof document !== 'undefined' && document.visibilityState === 'visible') {
      const msg = (data.message ?? {}) as Record<string, unknown>;
      const meta = (msg.metadata ?? {}) as Record<string, unknown>;
      if (String(meta.source || '') === 'manager') {
        try { playBellStrike(); } catch { /* audio unavailable */ }
      }
    }
    // Backend self-pushes this to all of *my* connected devices/tabs when a chat
    // is marked read anywhere — close the matching OS notification right here,
    // not just in test-chat-v3's own handler, since THIS service (not that page)
    // is the one guaranteed mounted regardless of which tab is open. Without this,
    // a chat read on the phone left its desktop notification sitting there
    // whenever the desktop wasn't currently on the messages tab.
    if (type === 'notifications_read' && data?.chatId) {
      const chatId = String(data.chatId);
      // Бейдж гасим сразу: событие само по себе и есть подтверждение
      // прочтения, ждать подтверждающего опроса незачем.
      this.applyUnreadHint(chatId, false);
      navigator.serviceWorker?.controller?.postMessage({ type: 'close-notifications', chatId });
      navigator.serviceWorker?.ready?.then((reg) => reg.active?.postMessage({ type: 'close-notifications', chatId })).catch(() => {});
    }
    // Уведомление — сразу из события, не дожидаясь дебаунса и перезагрузки
    // списка чатов: они и создавали заметную задержку между сообщением и
    // уведомлением. Опрос ниже всё равно идёт — за бейджем и снимками, а
    // повтор гасится общим ключом дедупликации.
    if (type === 'new_message' && data.chatId) {
      const chatId = String(data.chatId);
      const msg = asRecord(data.message);
      void this.notifyFromWsEvent(chatId, msg);

      // Бейдж — тоже сразу. Не поднимаем его для собственных сообщений и
      // для чата, который человек прямо сейчас смотрит: там прочтение
      // случится через мгновение, и единичка только мигнула бы впустую.
      const authorId = String(msg.authorId || msg.author_id || '').trim();
      const authorName = String(msg.authorName || msg.author_name || '').trim();
      const aliases = this.getUserIdentityAliases();
      const isOwn = (authorId && aliases.has(this.normalizeIdentity(authorId)))
        || (authorName && aliases.has(this.normalizeIdentity(authorName)));
      const isOpenAndWatched = isUserAttending() && (this.getContext?.() || {}).activeChatId === chatId;
      if (!isOwn && !isOpenAndWatched) this.applyUnreadHint(chatId, true);
    }

    // new_message / read_receipt / notifications_read / reaction / message_edited /
    // chat_created all change unread/badge/notifications — refresh (debounced).
    this.scheduleEventPoll();
  }

  /** Пересчитать бейдж по текущим снимкам и отрисовать его немедленно.
   *
   *  Бейдж обновлялся только в конце опроса, поэтому единичка появлялась и —
   *  что заметнее — гасла с задержкой в целый круг до сервера. Снимки у нас
   *  уже есть локально, так что при живом событии их можно поправить сразу, а
   *  опрос следом просто подтвердит результат. */
  private recomputeBadgeNow(): void {
    this.chatUnreadTotal = Array.from(this.chatSnapshots.values())
      .reduce((sum, snap) => sum + (snap.unreadCount > 0 ? 1 : 0), 0);
    this.updateAppBadge(this.pageUnreadCount ?? this.chatUnreadTotal);
  }

  /** Мгновенно пометить чат прочитанным/непрочитанным для бейджа. */
  private applyUnreadHint(chatId: string, unread: boolean): void {
    const snap = this.chatSnapshots.get(chatId);
    if (unread) {
      this.chatSnapshots.set(chatId, {
        ...(snap ?? { lastMessageId: '', lastMessageKey: '' }),
        unreadCount: Math.max(1, (snap?.unreadCount ?? 0) + 1),
      });
    } else {
      if (!snap || snap.unreadCount === 0) return;
      this.chatSnapshots.set(chatId, { ...snap, unreadCount: 0 });
    }
    this.recomputeBadgeNow();
  }

  /** Уведомление прямо из WS-события, не дожидаясь опроса.
   *
   *  Раньше любое сообщение сначала ждало дебаунс, а потом ещё и полной
   *  перезагрузки списка чатов — уведомление приходило заметно позже самого
   *  сообщения. Событие уже несёт и чат, и сообщение, так что показать можно
   *  сразу. Проверки повторяют те же, что в опросе: своё сообщение, открытый
   *  чат, «без звука». Ключ дедупликации берём тот же (`msg:<чат>:<id>`) —
   *  подоспевший следом опрос увидит его как показанный и не продублирует. */
  private async notifyFromWsEvent(chatId: string, msg: LooseRecord): Promise<void> {
    if (!this.isPrimed || this.silentCatchUpMode) return;

    const messageId = String(msg.id || msg.messageId || '').trim();
    if (!chatId || !messageId) return; // без id дедупликация невозможна — оставим опросу

    // The durable main-process channel owns native message cards in Electron.
    if (this.mainRealtimeHandlesMessages && isElectronRuntime()) return;

    const authorId = String(msg.authorId || msg.author_id || '').trim();
    const authorName = String(
      msg.authorName || msg.author_name || msg.senderName || msg.sender_name || ''
    ).trim() || 'Неизвестный отправитель';

    const aliases = this.getUserIdentityAliases();
    const isNotifChat = chatId.startsWith('notifications-') || chatId.startsWith('notifications_');
    if (!isNotifChat) {
      if (authorId && aliases.has(this.normalizeIdentity(authorId))) return;
      if (authorName && aliases.has(this.normalizeIdentity(authorName))) return;
    }

    const ctx = this.getContext?.() || {};
    if (isUserAttending() && ctx.activeChatId === chatId) return;

    const snippet = String(msg.content || '').trim() || 'Вложение';
    const isImportantMsg = snippet.startsWith('!');
    const display = this.chatDisplayCache.get(chatId);
    const isMutedLocally = (() => {
      if (!this.userId) return false;
      try { return localStorage.getItem(`chat_muted:${chatId}:${this.userId}`) === 'true'; } catch { return false; }
    })();
    if ((display?.mutedByServer || isMutedLocally) && !isImportantMsg) return;

    const isGroupChat = Boolean(display?.isGroup);
    const chatTitle = display?.title || '';
    const notifTitle = isNotifChat
      ? '🔔 Колокольчик'
      : (isGroupChat && chatTitle ? `${authorName} → ${chatTitle}` : authorName);

    await this.showNotification(notifTitle, snippet, {
      key: `msg:${chatId}:${messageId}`,
      messageId,
      tag: `chat-${chatId}`,
      url: links.chat(chatId),
      senderName: authorName,
      chatName: chatTitle || undefined,
      // A chat photo belongs to the conversation, not to its latest author.  Using
      // display.avatar here was the source of "someone else's" face in native
      // notifications.  Keep the same priority as the UI: actual user photo,
      // then a deterministic DiceBear avatar for this exact sender.
      avatar: this.resolveAuthorAvatar(authorId, authorName, msg),
      requireInteraction: true,
    });
  }

  // Coalesce a burst of WS events into a single refresh.
  private scheduleEventPoll(): void {
    if (!this.running || this.eventPollTimer !== null) return;
    this.eventPollTimer = window.setTimeout(() => {
      this.eventPollTimer = null;
      void this.poll(false);
    }, EVENT_POLL_DEBOUNCE_MS);
  }

  private async refreshUserAvatarCache(): Promise<void> {
    try {
      const users = await this.fetchJson<unknown[]>('/api/users');
      if (!Array.isArray(users)) return;
      for (const u of users) {
        const user = asRecord(u);
        const id = String(user.id || '').trim();
        const avatar = String(user.avatar || '').trim();
        if (id && avatar) this.userAvatarCache.set(id, avatar);
      }
      // Electron: message cards come from the main-process socket, and the
      // backend's new_message event carries no author photo — without this map
      // every card fell back to the DiceBear face.
      window.sharDesktop?.realtime?.setAvatars?.(Object.fromEntries(this.userAvatarCache));
    } catch {
      // non-critical
    }
  }

  private resolveAuthorAvatar(authorId: string, authorName: string, msg: LooseRecord): string {
    const realAvatar = String(
      this.userAvatarCache.get(authorId)
      || msg.authorAvatar
      || msg.author_avatar
      || ''
    ).trim();
    if (realAvatar) return realAvatar;

    // Match the normal Shar UI instead of falling back to Electron-only letters.
    const seed = authorName || authorId || 'user';
    return `https://api.dicebear.com/9.x/thumbs/svg?seed=${encodeURIComponent(seed)}&backgroundColor=b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf`;
  }

  private attachWakeHandlers(): void {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    this.detachWakeHandlers();

    this.visibilityHandler = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        // Tab just became visible. Silently update snapshots so we don't duplicate
        // any OS notifications the SW already showed while the tab was hidden.
        this.silentCatchUpMode = true;
        void this.poll(false).then(() => { this.silentCatchUpMode = false; });
      } else {
        void this.poll(false);
      }
    };

    this.focusHandler = () => {
      void this.poll(false);
    };

    // Лента чатов уже считает ровно то, что показывает бейдж (число чатов с
    // непрочитанным), и шлёт это локальным событием при каждом изменении —
    // включая прочтение прямо сейчас. Берём его как есть: это мгновенно и не
    // требует ни опроса, ни ответа сервера. Когда лента не смонтирована,
    // работает обычный путь через события WS и опрос.
    this.unreadHintHandler = (event: Event) => {
      const count = Number((event as CustomEvent).detail?.count);
      if (!Number.isFinite(count)) return;
      this.chatUnreadTotal = count;
      this.pageUnreadCount = count;
      this.updateAppBadge(count);
    };
    window.addEventListener('shar-unread-changed', this.unreadHintHandler);
    this.pageUnreadGoneHandler = () => { this.pageUnreadCount = null; };
    window.addEventListener('shar-unread-page-unmounted', this.pageUnreadGoneHandler);

    // Main-process notification delivery remains alive while Electron's renderer
    // is occluded.  When it wakes the renderer, reconcile immediately instead of
    // leaving the chat list stale until a focus/click or the slow safety poll.
    this.realtimePokeUnsubscribe = window.sharDesktop?.onRealtimePoke?.(() => {
      if (!this.running) return;
      void this.poll(false);
    }) || null;

    // Window focus as seen by the main process proved unreliable: cards kept
    // arriving for the chat being typed in.  Report what the page itself knows.
    if (window.sharDesktop?.realtime?.setContext) {
      this.desktopContextHandler = (event: Event) => {
        if (event.type === 'keydown' || event.type === 'pointerdown') {
          const now = Date.now();
          if (now - this.lastInputAt < 2000) return;
          this.lastInputAt = now;
        }
        this.reportDesktopContext();
      };
      for (const type of ['keydown', 'pointerdown', 'focus', 'blur']) {
        window.addEventListener(type, this.desktopContextHandler, true);
      }
      // Chat switches have no event of their own here — a cheap change check covers them.
      this.desktopContextTimer = window.setInterval(() => this.reportDesktopContext(), 1000);
      this.reportDesktopContext();
    }

    document.addEventListener('visibilitychange', this.visibilityHandler);
    window.addEventListener('focus', this.focusHandler);
    window.addEventListener('online', this.focusHandler);
  }

  private detachWakeHandlers(): void {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }

    if (this.focusHandler) {
      window.removeEventListener('focus', this.focusHandler);
      window.removeEventListener('online', this.focusHandler);
      this.focusHandler = null;
    }

    if (this.pageUnreadGoneHandler) {
      window.removeEventListener('shar-unread-page-unmounted', this.pageUnreadGoneHandler);
      this.pageUnreadGoneHandler = null;
    }

    if (this.unreadHintHandler) {
      window.removeEventListener('shar-unread-changed', this.unreadHintHandler);
      this.unreadHintHandler = null;
    }
    if (this.realtimePokeUnsubscribe) {
      this.realtimePokeUnsubscribe();
      this.realtimePokeUnsubscribe = null;
    }

    if (this.desktopContextHandler) {
      for (const type of ['keydown', 'pointerdown', 'focus', 'blur']) {
        window.removeEventListener(type, this.desktopContextHandler, true);
      }
      this.desktopContextHandler = null;
    }
    if (this.desktopContextTimer !== null) {
      window.clearInterval(this.desktopContextTimer);
      this.desktopContextTimer = null;
    }
    this.lastInputAt = 0;
    this.lastDesktopContext = '';
    window.sharDesktop?.realtime?.setContext?.({ activeChatId: '', focused: false, lastInputAt: 0 });
  }

  private reportDesktopContext(): void {
    const setContext = window.sharDesktop?.realtime?.setContext;
    if (!setContext) return;
    const ctx = this.getContext?.() || {};
    const payload = {
      activeChatId: ctx.activeChatId ? String(ctx.activeChatId) : '',
      focused: typeof document.hasFocus === 'function' ? document.hasFocus() : false,
      lastInputAt: this.lastInputAt,
    };
    const signature = `${payload.activeChatId}|${payload.focused}|${payload.lastInputAt}`;
    if (signature === this.lastDesktopContext) return;
    this.lastDesktopContext = signature;
    setContext(payload);
  }

  private normalizeIdentity(value: unknown): string {
    return String(value ?? '').trim().toLowerCase();
  }

  private getUserIdentityAliases(): Set<string> {
    const aliases = new Set<string>();
    const pushAlias = (value: unknown) => {
      const normalized = this.normalizeIdentity(value);
      if (normalized) aliases.add(normalized);
    };

    pushAlias(this.userId);
    pushAlias(this.userName);

    if (typeof window !== 'undefined') {
      pushAlias(localStorage.getItem('username'));
      try {
        const myAccountRaw = localStorage.getItem('myAccount');
        if (myAccountRaw) {
          const myAccount = JSON.parse(myAccountRaw);
          pushAlias(myAccount?.id);
          pushAlias(myAccount?.name);
          pushAlias(myAccount?.username);
        }
      } catch {
        // ignore malformed localStorage payloads
      }
    }

    return aliases;
  }

  private stateKey(suffix: string): string {
    return `push_state:${this.userId}:${suffix}`;
  }

  private restoreState() {
    if (!this.userId || typeof window === 'undefined') return;

    try {
      const tasksRaw = localStorage.getItem(this.stateKey('tasks'));
      if (tasksRaw) {
        const ids: string[] = JSON.parse(tasksRaw);
        this.seenTaskIds = new Set(ids.slice(0, SEEN_LIMIT));
      }

      const chatsRaw = localStorage.getItem(this.stateKey('chats'));
      if (chatsRaw) {
        const entries: [string, ChatSnapshot][] = JSON.parse(chatsRaw);
        this.chatSnapshots = new Map(entries);
      }

      const eventsRaw = localStorage.getItem(this.stateKey('events'));
      if (eventsRaw) {
        const entries: [string, string][] = JSON.parse(eventsRaw);
        this.eventVersions = new Map(entries);
      }

      const calendarRaw = localStorage.getItem(this.stateKey('calendar-reminders'));
      if (calendarRaw) {
        const keys: string[] = JSON.parse(calendarRaw);
        this.firedCalendarReminders = new Set(keys.slice(0, SEEN_LIMIT));
      }

      const calendarVersionsRaw = localStorage.getItem(this.stateKey('calendar-event-versions'));
      if (calendarVersionsRaw) {
        const entries: [string, string][] = JSON.parse(calendarVersionsRaw);
        this.calendarEventVersions = new Map(entries);
      }

      const eventNotifiedRaw = localStorage.getItem(this.stateKey('event-notified-versions'));
      if (eventNotifiedRaw) {
        const keys: string[] = JSON.parse(eventNotifiedRaw);
        this.notifiedEventVersions = new Set(keys.slice(0, SEEN_LIMIT));
      }

      const calendarSnapshotsRaw = localStorage.getItem(this.stateKey('calendar-event-snapshots'));
      if (calendarSnapshotsRaw) {
        const entries: [string, CalendarEventSnapshot][] = JSON.parse(calendarSnapshotsRaw);
        this.calendarEventSnapshots = new Map(entries);
      }
    } catch {
      this.seenTaskIds = new Set();
      this.chatSnapshots = new Map();
      this.eventVersions = new Map();
      this.calendarEventVersions = new Map();
      this.calendarEventSnapshots = new Map();
      this.firedCalendarReminders = new Set();
      this.notifiedEventVersions = new Set();
    }
  }

  private persistState() {
    if (!this.userId || typeof window === 'undefined') return;

    try {
      localStorage.setItem(this.stateKey('tasks'), JSON.stringify(Array.from(this.seenTaskIds).slice(0, SEEN_LIMIT)));
      localStorage.setItem(this.stateKey('chats'), JSON.stringify(Array.from(this.chatSnapshots.entries()).slice(0, SEEN_LIMIT)));
      localStorage.setItem(this.stateKey('events'), JSON.stringify(Array.from(this.eventVersions.entries()).slice(0, SEEN_LIMIT)));
      localStorage.setItem(this.stateKey('calendar-event-versions'), JSON.stringify(Array.from(this.calendarEventVersions.entries()).slice(0, SEEN_LIMIT)));
      localStorage.setItem(this.stateKey('calendar-event-snapshots'), JSON.stringify(Array.from(this.calendarEventSnapshots.entries()).slice(0, SEEN_LIMIT)));
      localStorage.setItem(this.stateKey('calendar-reminders'), JSON.stringify(Array.from(this.firedCalendarReminders).slice(0, SEEN_LIMIT)));
      localStorage.setItem(this.stateKey('event-notified-versions'), JSON.stringify(Array.from(this.notifiedEventVersions).slice(0, SEEN_LIMIT)));
    } catch {
      // ignore quota or serialization errors
    }
  }

  private updateAppBadge(count: number): void {
    if (typeof navigator === 'undefined') return;
    try {
      if (count > 0) {
        if ('setAppBadge' in navigator) (navigator as Navigator & { setAppBadge(n: number): Promise<void> }).setAppBadge(count).catch(() => {});
      } else {
        if ('clearAppBadge' in navigator) (navigator as Navigator & { clearAppBadge(): Promise<void> }).clearAppBadge().catch(() => {});
      }
    } catch { /* not supported */ }
    // Chromium's Badging API (above) doesn't reach the Windows taskbar icon for a bare
    // BrowserWindow the way it does for an installed PWA — main.cjs draws the actual
    // overlay icon natively, this just forwards the same count it already computed.
    try {
      (window as unknown as { sharDesktop?: { setBadgeCount?(n: number): void } }).sharDesktop?.setBadgeCount?.(count);
    } catch { /* not in Electron */ }
  }

  private claimEventVersionNotification(eventId: string, version: string): boolean {
    const normalizedEventId = String(eventId || '').trim();
    const normalizedVersion = String(version || '').trim();
    if (!normalizedEventId || !normalizedVersion) return true;

    const key = `${normalizedEventId}:${normalizedVersion}`;
    if (this.notifiedEventVersions.has(key)) return false;

    this.notifiedEventVersions.add(key);
    if (this.notifiedEventVersions.size > SEEN_LIMIT) {
      const oldest = this.notifiedEventVersions.values().next().value;
      if (oldest) this.notifiedEventVersions.delete(oldest);
    }
    return true;
  }

  private async ensurePermissionAndWorker(): Promise<void> {
    if (isElectronRuntime()) return;
    if (typeof window === 'undefined' || !('Notification' in window)) return;

    let registration: ServiceWorkerRegistration | null = null;

    // Never register in local dev — see PwaEnhancements.tsx for why (Turbopack's
    // dev bundle isn't content-hashed, so the SW's cache-first script/style
    // strategy would keep serving stale JS forever regardless of edits).
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
      try {
        await navigator.serviceWorker.register('/notifications-sw.js', { scope: '/' });
        registration = await navigator.serviceWorker.ready; // Wait for active SW — required on Android
      } catch {
        // ignore registration errors
      }
    }

    // Do NOT auto-request here — iOS Safari requires a real user gesture.
    // Permission is requested via the explicit UI button in ChatSidebar dropdown.
    
    if (Notification.permission === 'granted' && registration && this.userId) {
      await this.ensureWebPushSubscription(registration);
    }
  }

  private async ensureWebPushSubscription(registration: ServiceWorkerRegistration): Promise<void> {
    if (!this.userId || typeof window === 'undefined') return;
    if (!('PushManager' in window)) return;

    try {
      const pushMetaResponse = await fetch(PUBLIC_PUSH_KEY_ENDPOINT, { cache: 'no-store' });
      if (!pushMetaResponse.ok) return;
      const pushMeta = await pushMetaResponse.json();
      const publicKey = String(pushMeta?.publicKey || '');
      const configured = Boolean(pushMeta?.configured);
      if (!configured || !publicKey) return;

      let subscription = await registration.pushManager.getSubscription();

      // Force re-subscribe if: no subscription, expired, or key mismatch
      const needsRefresh = !subscription ||
        (subscription.expirationTime !== null && Date.now() > (subscription.expirationTime ?? Infinity));

      if (needsRefresh) {
        // Unsubscribe old one cleanly before creating new
        if (subscription) {
          try { await subscription.unsubscribe(); } catch { /* ignore */ }
        }
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey) as unknown as Uint8Array<ArrayBuffer>,
        });
      }

      // Send subscription to server — use toJSON() for proper serialization
      const subJson = typeof (subscription as any).toJSON === 'function'
        ? (subscription as any).toJSON()
        : subscription;

      await fetch(PUBLIC_PUSH_KEY_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: this.userId,
          subscription: subJson,
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
          platform: typeof navigator !== 'undefined' ? navigator.platform : '',
        }),
      });

    } catch {
      // non-critical: web push subscription failure doesn't break notifications
    }
  }

  private async poll(isInitial: boolean): Promise<void> {
    if (!this.running || !this.userId) return;
    if (this.inFlight) return;

    this.inFlight = true;
    this.pollCycleCounter++;
    const isBackgroundCycle = isInitial || this.pollCycleCounter % 2 === 0;

    try {
      await Promise.all([
        // Chats poll every cycle (1500ms) - critical for instant notifications
        this.pollChats(isInitial),
        // Tasks, events, calendar poll every 3rd cycle (4500ms) - less time-sensitive
        ...(isBackgroundCycle ? [
          this.pollTaskNotifications(isInitial),
          // События и напоминания о них рассылает сервер (_check_due_reminders,
          // _notify_calendar): отсюда их слало каждое открытое приложение —
          // одно событие давало по уведомлению с каждого устройства.
        ] : []),
      ]);

      if (isInitial) {
        this.isPrimed = true;
      }

      this.persistState();
      // Badge reflects unread chat messages only — task notifications accumulate
      // in notifications.json and can't reliably indicate "unseen" state.
      // While the chat list is open its count wins: overwriting it here with the
      // raw server snapshot is what kept a "1" on the icon with «Входящие» at 0.
      this.updateAppBadge(this.pageUnreadCount ?? this.chatUnreadTotal);
    } finally {
      this.inFlight = false;
    }
  }

  private async pollTaskNotifications(_isInitial: boolean): Promise<void> {
    const list = await this.fetchJson<unknown[]>(`/api/notifications?userId=${encodeURIComponent(this.userId || '')}`);
    if (!Array.isArray(list)) return;

    const unread = list.map(asRecord).filter((item) => item.read === false && item.id);
    this.taskUnreadTotal = unread.length;

    for (const item of unread) {
      const id = String(item.id);
      if (this.seenTaskIds.has(id)) continue;

      this.seenTaskIds.add(id);
      if (this.seenTaskIds.size > SEEN_LIMIT) {
        const oldest = this.seenTaskIds.values().next().value;
        if (oldest) this.seenTaskIds.delete(oldest);
      }

      // Task notifications are shown as in-app toasts — no native browser popup needed
    }
  }

  private async pollChats(isInitial: boolean): Promise<void> {
    const chats = await this.fetchJson<unknown[]>(`/api/chats?user_id=${encodeURIComponent(this.userId || '')}`);
    if (!Array.isArray(chats)) return;

    for (const chatItem of chats) {
      const chat = asRecord(chatItem);
      const chatId = String(chat?.id || '');
      if (!chatId) continue;

      const isFavoritesChat = Boolean(chat?.isFavoritesChat) || chatId.startsWith('favorites_');
      if (isFavoritesChat) continue;

      // Notification chats are handled as in-app toasts — skip native OS push to avoid duplicates
      const isNotificationsChat =
        Boolean(chat?.isNotificationsChat) ||
        Boolean(chat?.isSystemChat) ||
        chatId.startsWith('notifications-') ||
        chatId.startsWith('notifications_');
      if (isNotificationsChat) continue;


      const lastMessage = asRecord(chat?.lastMessage || chat?.last_message);
      const unreadCount = Number(chat?.unreadCount ?? chat?.unread_count ?? 0);
      const lastMessageId = String(lastMessage?.id || lastMessage?.messageId || lastMessage?.message_id || '');
      const lastAuthorId = String(
        lastMessage?.authorId
        || lastMessage?.author_id
        || lastMessage?.senderId
        || lastMessage?.sender_id
        || ''
      );
      const lastMessageCreatedAt = String(
        lastMessage?.createdAt
        || lastMessage?.created_at
        || lastMessage?.timestamp
        || chat?.updatedAt
        || chat?.updated_at
        || ''
      );
      const title = String(chat?.title || (chat?.isGroup ? 'Групповой чат' : 'Личные сообщения'));
      const snippet = String(lastMessage?.content || chat?.lastMessageContent || 'Новое сообщение');
      const authorName = String(
        lastMessage?.authorName
        || lastMessage?.author_name
        || lastMessage?.senderName
        || lastMessage?.sender_name
        || 'Неизвестный отправитель'
      );
      const lastMessageKey = lastMessageId || [
        chatId,
        lastMessageCreatedAt,
        lastAuthorId,
        snippet,
        unreadCount,
      ].join(':');
      // Keep author and chat avatars separate.  The display cache is used for
      // notification author cards as well, so putting chat.avatar here caused a
      // group/chat photo to be shown as the sender's portrait.
      const avatarCandidate = this.resolveAuthorAvatar(lastAuthorId, authorName, lastMessage);

      // Кэш для мгновенного пути заполняем ДО всех отсевов ниже: он нужен и по
      // тем чатам, о которых уведомление сейчас не показывается (в том числе
      // по «без звука» — иначе WS-путь не узнает, что чат заглушён).
      const participantCount = (asRecord(chat).participantIds || asRecord(chat).participant_ids) as unknown[] | undefined;
      const isGroupChat = Boolean(chat?.isGroup || chat?.is_group || (participantCount?.length ?? 0) > 2);
      this.chatDisplayCache.set(chatId, {
        title,
        isGroup: isGroupChat,
        avatar: avatarCandidate || '',
        mutedByServer: this.userId
          ? asRecord(chat?.mutedByUser || chat?.muted_by_user)[this.userId] === true
          : false,
      });

      const prev = this.chatSnapshots.get(chatId);
      const prevMessageKey = prev?.lastMessageKey || prev?.lastMessageId || '';
      this.chatSnapshots.set(chatId, { unreadCount, lastMessageId, lastMessageKey });

      if (isInitial || !this.isPrimed) continue;
      if (!prev) continue;
      if (unreadCount <= 0) continue;
      if (unreadCount <= prev.unreadCount && lastMessageKey === prevMessageKey) continue;

      // Manager/«Колокольчик» notifications are authored as the RECIPIENT (there's no Shar
      // user for the manager system), so the own-message suppression below would drop them
      // — bypass it for notifications chats.
      const isNotifChat = chatId.startsWith('notifications-') || chatId.startsWith('notifications_');
      if (!isNotifChat) {
        // Suppress notifications for own sent messages (check by ID and by name as fallback)
        const aliases = this.getUserIdentityAliases();
        if (lastAuthorId && aliases.has(this.normalizeIdentity(lastAuthorId))) continue;
        if (authorName && aliases.has(this.normalizeIdentity(authorName))) continue;
      }

      // Не «страница отрисовывается», а «человек смотрит»: перекрытое браузером
      // окно Chromium всё равно считает visible — см. lib/userAttention.
      const isPageVisible = isUserAttending();

      // When the tab is hidden, the backend's web push (service worker) handles OS notifications.
      // Showing a browser notification here would duplicate it, so we skip.
      // Also skip during silent catch-up (just returned to foreground after SW notified).
      //
      // Electron is the exception: ensurePermissionAndWorker() returns early there, so no
      // service worker is ever registered and no push subscription exists — there is nothing
      // to defer to. Closing the window only hides it (main.cjs turns close into hide(), the
      // renderer keeps running), so a hidden window in Electron is precisely when the native
      // notification is needed. Deferring there meant the desktop app went silent until you
      // opened it again, which is the opposite of what a background app should do.
      if ((!isPageVisible && !isElectronRuntime()) || this.silentCatchUpMode) continue;

      // Suppress notification only if user is ACTIVELY VIEWING THIS SPECIFIC CHAT.
      // "Actively" is the operative word: activeChatId only says which chat is
      // selected, and a selected chat stays selected after the window is hidden
      // to the tray. Without the visibility half of the condition, whatever chat
      // you happened to have open silenced itself for as long as the app sat in
      // the background — the one chat you're most likely to be written in.
      const ctx = this.getContext?.() || {};
      const isViewingThisChat = isPageVisible && ctx.activeChatId === chatId;
      if (isViewingThisChat) {
        console.log(`[BrowserPushService] пропуск: чат ${chatId} открыт и окно видно`);
        continue;
      }

      // SW already showed an OS web-push notification for this chat — skip to avoid duplicate
      if (this.swPushedChatIds.has(chatId)) {
        this.swPushedChatIds.delete(chatId);
        continue;
      }

      // User muted this chat — skip notification (snapshot is still updated above).
      // EXCEPTION: a message marked important with a leading '!' must reach everyone,
      // even those who muted the chat.
      const mutedByUser = asRecord(chat?.mutedByUser || chat?.muted_by_user);
      const isMutedByServer = this.userId ? mutedByUser[this.userId] === true : false;
      const isMutedLocally = (() => {
        if (!this.userId || !chatId) return false;
        try { return localStorage.getItem(`chat_muted:${chatId}:${this.userId}`) === 'true'; } catch { return false; }
      })();
      const isImportantMsg = String(snippet || '').trimStart().startsWith('!');
      if ((isMutedByServer || isMutedLocally) && !isImportantMsg) continue;

      // In-app bell for «Колокольчик» notifications while the tab is focused (we've
      // already skipped the hidden-tab case above, which the SW push covers).
      if (isNotifChat) { try { playBellStrike(); } catch { /* audio unavailable */ } }

      const notifTitle = isNotifChat ? '🔔 Колокольчик' : (isGroupChat && title ? `${authorName} → ${title}` : authorName);
      const notifBody = isGroupChat ? snippet : snippet;

      // In Electron, messages belong exclusively to the durable main-process
      // socket.  The poll is still vital for synchronizing chat snapshots and
      // the badge, but it must never create a second native card after that
      // socket has already shown one.  This was the remaining duplicate path:
      // WS → main process (fallback avatar), then the 600 ms poll → renderer
      // (real avatar).
      if (this.mainRealtimeHandlesMessages && isElectronRuntime()) continue;

      await this.showNotification(notifTitle, notifBody, {
        key: `msg:${chatId}:${lastMessageKey}`,
        messageId: lastMessageId || undefined,
        tag: `chat-${chatId}`,
        url: links.chat(chatId),
        senderName: authorName,
        chatName: title,
        avatar: avatarCandidate || undefined,
        requireInteraction: true,
      });
    }

    // Count of CHATS with unread messages, not the sum of unread messages — matches
    // how the badge reads elsewhere in the app (and how Telegram/etc. badge their icon).
    this.chatUnreadTotal = Array.from(this.chatSnapshots.values())
      .reduce((sum, snap) => sum + (snap.unreadCount > 0 ? 1 : 0), 0);
  }

  private async pollEvents(isInitial: boolean): Promise<void> {
    const payload = await this.fetchJson<unknown>(`/api/events?userId=${encodeURIComponent(this.userId || '')}`);
    const payloadRecord = asRecord(payload);
    const events = Array.isArray(payload) ? payload : Array.isArray(payloadRecord.events) ? payloadRecord.events : [];

    for (const eventItem of events) {
      const event = asRecord(eventItem);
      const eventId = String(event.id || '');
      if (!eventId) continue;

      const version = String(event.updatedAt || event.createdAt || '');
      const prevVersion = this.eventVersions.get(eventId);
      this.eventVersions.set(eventId, version || '');

      if (isInitial || !this.isPrimed) continue;
      if (!version) continue;
      if (prevVersion === version) continue;

      const isOwn = String(event.createdBy || '') === this.userId;
      if (isOwn) continue;
      if (!this.claimEventVersionNotification(eventId, version)) continue;

      const title = prevVersion ? 'Событие обновлено' : 'Новое событие';
      const body = String(event?.title || 'Изменение в календаре');

      await this.sendEventNotificationToNotificationsChat(event, title, body);

      await this.showNotification(title, body, {
        key: `event:${eventId}:${version}`,
        tag: `event-${eventId}`,
        url: paths.calendar,
      });
    }
  }

  private isCalendarEventRelevantToUser(event: CalendarReminderEvent): boolean {
    if (!this.userId) return false;

    const aliases = this.getUserIdentityAliases();
    const createdBy = this.normalizeIdentity(event?.createdBy);
    const assignedTo = this.normalizeIdentity(event?.assignedTo);

    if (createdBy && aliases.has(createdBy)) return true;
    if (assignedTo && aliases.has(assignedTo)) return true;
    // Календарь нового Шара: событием поделились со мной или со всеми.
    const shared = event as CalendarReminderEvent & { participants?: unknown; sharedWithAll?: unknown };
    if (shared.sharedWithAll === true || shared.sharedWithAll === 'true') return true;
    if (Array.isArray(shared.participants) && shared.participants.some((p) => aliases.has(this.normalizeIdentity(p)))) return true;

    if (!createdBy && !assignedTo) return true;

    return false;
  }

  private parseCalendarReminderDate(event: CalendarReminderEvent): Date | null {
    const dateRaw = String(event?.date || '').trim();
    if (!dateRaw) return null;

    const timeRaw = String(event?.time || '09:00').trim();
    const datePart = dateRaw.includes('T') ? dateRaw.split('T')[0] : dateRaw;
    
    // Парсим дату в формате YYYY-MM-DD
    const dateMatch = datePart.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!dateMatch) return null;
    
    const year = parseInt(dateMatch[1], 10);
    const month = parseInt(dateMatch[2], 10) - 1; // Месяцы в JavaScript 0-based
    const day = parseInt(dateMatch[3], 10);
    
    // Парсим время в формате HH:MM или HH:MM:SS
    const timeMatch = timeRaw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!timeMatch) return null;
    
    const hour = parseInt(timeMatch[1], 10);
    const minute = parseInt(timeMatch[2], 10);
    const second = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0;
    
    // Создаем Date объект в локальном часовом поясе. «За N минут» — раньше
    // начала на N минут; у старых записей поля нет — напоминаем к началу.
    const before = Number(event?.reminderMinutesBefore);
    const parsed = new Date(year, month, day, hour, minute - (Number.isFinite(before) && before > 0 ? before : 0), second);

    if (!Number.isFinite(parsed.getTime())) return null;
    return parsed;
  }

  private toCalendarEventSnapshot(event: CalendarReminderEvent): CalendarEventSnapshot {
    return {
      title: String(event?.title || '').trim(),
      date: String(event?.date || '').trim(),
      time: String(event?.time || '').trim(),
      remind: Boolean(event?.remind),
      type: String(event?.type || '').trim(),
      description: String(event?.description || '').trim(),
      author: String((event as { createdByName?: string })?.createdByName || '').trim(),
    };
  }

  private formatCalendarEventType(type: string): string {
    switch (type) {
      case 'work':
        return 'Работа';
      case 'meeting':
        return 'Встреча';
      case 'event':
        return 'Событие';
      case 'holiday':
        return 'Праздник';
      case 'task':
        return 'Задача';
      case 'tz':
        return 'ТЗ';
      default:
        return type || 'Не указан';
    }
  }

  /** «30 сентября, 14:00» — как человек говорит, а не 2026-09-30. */
  private humanCalendarWhen(date: string, time: string): string {
    const m = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return [date, time].filter(Boolean).join(', ');
    const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    const year = Number(m[1]) !== new Date().getFullYear() ? ` ${m[1]}` : '';
    return `${Number(m[3])} ${months[Number(m[2]) - 1]}${year}${time ? `, ${time}` : ', весь день'}`;
  }

  private buildCalendarEventDetailLines(snapshot: CalendarEventSnapshot): string[] {
    const lines: string[] = [];
    if (snapshot.date) lines.push(this.humanCalendarWhen(snapshot.date, snapshot.time));
    if (snapshot.description) {
      lines.push(snapshot.description.length > 200 ? `${snapshot.description.slice(0, 200)}…` : snapshot.description);
    }
    if (snapshot.author) lines.push(`Поделился(-ась): ${snapshot.author}`);
    return lines;
  }

  private buildCalendarEventChangeLines(prev: CalendarEventSnapshot, next: CalendarEventSnapshot): string[] {
    const lines: string[] = [];
    const pushChange = (label: string, before: string, after: string) => {
      if (before === after) return;
      lines.push(`${label}: ${before || '—'} → ${after || '—'}`);
    };

    pushChange('Название', prev.title, next.title);
    pushChange('Дата', prev.date, next.date);
    pushChange('Время', prev.time, next.time);
    pushChange('Тип', this.formatCalendarEventType(prev.type), this.formatCalendarEventType(next.type));
    pushChange('Напоминание', prev.remind ? 'включено' : 'выключено', next.remind ? 'включено' : 'выключено');
    pushChange('Описание', prev.description, next.description);

    return lines.length > 0 ? lines : ['Обновлены параметры события'];
  }

  private async pollCalendarReminders(isInitial: boolean): Promise<void> {
    const events = await this.fetchJson<CalendarReminderEvent[]>('/api/calendar-events');
    if (!Array.isArray(events)) return;

    const now = Date.now();
    
    for (const event of events) {
      if (!event?.id) continue;
      const eventId = String(event.id);
      const snapshot = this.toCalendarEventSnapshot(event);
      const prevSnapshot = this.calendarEventSnapshots.get(eventId);
      this.calendarEventSnapshots.set(eventId, snapshot);

      const isRelevant = this.isCalendarEventRelevantToUser(event);
      const version = String(
        event.updatedAt
          || `${event.date || ''}|${event.time || ''}|${event.title || ''}|${event.remind ? '1' : '0'}|${event.type || ''}|${event.description || ''}|${event.createdBy || ''}|${event.assignedTo || ''}`
      );
      const prevVersion = this.calendarEventVersions.get(eventId);
      this.calendarEventVersions.set(eventId, version);

      // «Новое событие» / «изменено» — новость для тех, с кем поделились, а не
      // для автора: он только что сам его создал. Напоминание автору — ниже.
      const creator = this.normalizeIdentity(event?.createdBy);
      const isOwn = Boolean(creator) && this.getUserIdentityAliases().has(creator);
      if (!isInitial && this.isPrimed && isRelevant && !isOwn && version && prevVersion !== version) {
        if (!this.claimEventVersionNotification(eventId, version)) {
          continue;
        }

        const title = prevVersion ? 'Событие обновлено' : 'Новое событие';
        const eventTitle = snapshot.title || 'Событие';
        const detailLines = prevVersion && prevSnapshot
          ? this.buildCalendarEventChangeLines(prevSnapshot, snapshot)
          : this.buildCalendarEventDetailLines(snapshot);
        const body = [`«${eventTitle}»`, ...detailLines].join('\n');
        const browserBody = detailLines.length > 0
          ? `${eventTitle} • ${detailLines[0]}`
          : eventTitle;

        await this.sendEventNotificationToNotificationsChat(event, title, body);
        await this.showNotification(title, browserBody, {
          key: `calendar-event:${eventId}:${version}`,
          tag: `calendar-event-${eventId}`,
          url: paths.calendar,
        });
        
        // После обновления/создания события проверяем, не нужно ли сразу показать напоминание
        // (если событие начинается прямо сейчас или скоро)
        if (event?.remind && isRelevant) {
          const reminderAt = this.parseCalendarReminderDate(event);
          if (reminderAt) {
            const now = Date.now();
            const reminderAtMs = reminderAt.getTime();
            const timeUntilEvent = reminderAtMs - now;
            const isImminentOrOngoing = Math.abs(timeUntilEvent) <= CALENDAR_EVENT_START_WINDOW_MS;
            
            if (isImminentOrOngoing) {
              const reminderKey = `calendar:${eventId}:${event.date || ''}:${event.time || '09:00'}`;
              
              if (!this.firedCalendarReminders.has(reminderKey)) {
                this.firedCalendarReminders.add(reminderKey);
                if (this.firedCalendarReminders.size > SEEN_LIMIT) {
                  const oldest = this.firedCalendarReminders.values().next().value;
                  if (oldest) this.firedCalendarReminders.delete(oldest);
                }
                
                const eventTitle = snapshot.title || 'Событие';
                const reminderDetailLines = this.buildCalendarEventDetailLines(snapshot)
                  .filter((line) => !line.startsWith('Описание:'));
                const reminderBody = [`«${eventTitle}»`, ...reminderDetailLines].join('\n');
                const browserReminderBody = reminderDetailLines.length > 0
                  ? `${eventTitle} • ${reminderDetailLines[0]}`
                  : eventTitle;

                await this.sendCalendarReminderToNotificationsChat(event, reminderBody);
                await this.showNotification('Напоминание о событии', browserReminderBody, {
                  key: `calendar-reminder:${reminderKey}`,
                  tag: `calendar-reminder-${eventId}`,
                  url: paths.calendar,
                  skipDedupe: true,
                });
                
                // Пропускаем дальнейшую обработку этого события, чтобы не было дубликата
                continue;
              }
            }
          }
        }
      }

      if (!event?.remind) continue;
      if (!isRelevant) continue;

      const reminderAt = this.parseCalendarReminderDate(event);
      if (!reminderAt) continue;

      const reminderAtMs = reminderAt.getTime();
      if (!Number.isFinite(reminderAtMs)) continue;

      // Проверяем, находимся ли мы в окне напоминания:
      // 1. В момент начала события (± 30 секунд)
      // 2. В течение 1 часа после события (если пропустили)
      const delta = now - reminderAtMs;
      const timeUntilEvent = reminderAtMs - now;
      
      // Допустимые окна:
      // - В момент начала: |timeUntilEvent| <= 30 секунд (ровно в момент начала)
      // - Пропущенное: delta > 30 секунд и delta < 1 час (для старых событий)
      const isAtEventStart = Math.abs(timeUntilEvent) <= CALENDAR_EVENT_START_WINDOW_MS; // ± 30 секунд от начала
      const isMissedRecent = delta > CALENDAR_EVENT_START_WINDOW_MS && delta <= CALENDAR_REMINDER_WINDOW_MS; // пропущено более 30 сек назад, но недавно (< 1 часа)
      const isInReminderWindow = isAtEventStart || isMissedRecent;
      
      if (!isInReminderWindow) continue;

      const reminderKey = `calendar:${eventId}:${event.date || ''}:${event.time || '09:00'}`;

      if (this.firedCalendarReminders.has(reminderKey)) continue;

      this.firedCalendarReminders.add(reminderKey);
      if (this.firedCalendarReminders.size > SEEN_LIMIT) {
        const oldest = this.firedCalendarReminders.values().next().value;
        if (oldest) this.firedCalendarReminders.delete(oldest);
      }

      const eventTitle = snapshot.title || 'Событие';
      const reminderDetailLines = this.buildCalendarEventDetailLines(snapshot)
        .filter((line) => !line.startsWith('Описание:'));
      const body = [`«${eventTitle}»`, ...reminderDetailLines].join('\n');
      const browserBody = reminderDetailLines.length > 0
        ? `${eventTitle} • ${reminderDetailLines[0]}`
        : eventTitle;

      await this.sendCalendarReminderToNotificationsChat(event, body);

      await this.showNotification('Напоминание о событии', browserBody, {
        key: `calendar-reminder:${reminderKey}`,
        tag: `calendar-reminder-${eventId}`,
        url: paths.calendar,
        skipDedupe: true,
      });
    }
  }

  private async sendCalendarReminderToNotificationsChat(
    event: CalendarReminderEvent,
    body: string
  ): Promise<void> {
    if (!this.userId) return;

    const eventTitle = event.title || 'Событие';
    await this.postNotificationToChat({
      content: `📅 ${eventTitle}\n${body}`,
      notificationType: 'event_reminder',
      linkedEventId: event?.id ? String(event.id) : null,
      linkedEventTitle: event.title || null,
    });
  }

  private async sendTaskNotificationToNotificationsChat(
    notification: LooseRecord,
    title: string,
    body: string
  ): Promise<void> {
    if (!this.userId) return;

    const linkedTaskId = notification?.todoId ? String(notification.todoId) : null;

    await this.postNotificationToChat({
      content: `${title}\n${body}`,
      notificationType: notification?.type || 'task_notification',
      linkedTaskId,
    });
  }

  private async sendEventNotificationToNotificationsChat(
    event: LooseRecord,
    title: string,
    body: string
  ): Promise<void> {
    if (!this.userId) return;

    const eventTitle = event?.title || 'Событие';
    const notificationTitle = title === 'Новое событие' ? `📅 ${eventTitle}` : `📝 ${eventTitle}`;
    await this.postNotificationToChat({
      content: `${notificationTitle}\n${body}`,
      notificationType: 'event_update',
      linkedEventId: event?.id ? String(event.id) : null,
      linkedEventTitle: event?.title || null,
    });
  }

  private async postNotificationToChat(payload: Record<string, unknown>): Promise<void> {
    if (!this.userId) return;

    try {
      const response = await fetch(`/api/chats/notifications/${encodeURIComponent(this.userId)}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        let details = '';
        try {
          details = await response.text();
        } catch {
          details = '';
        }
        console.warn('[BrowserPushService] Failed to save notification chat message', {
          status: response.status,
          statusText: response.statusText,
          details,
          userId: this.userId,
          payload,
        });
      }
    } catch (error) {
      console.warn('[BrowserPushService] Error sending notification chat message', {
        error,
        userId: this.userId,
        payload,
      });
    }
  }

  // Reads all muted chat IDs from localStorage and sends them to the SW.
  // Called on start so the SW can skip OS notifications for muted chats.
  private async syncMutedChatsToSW(): Promise<void> {
    if (!this.userId || !('serviceWorker' in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      if (!reg.active) return;
      const mutedChatIds: string[] = [];
      const prefix = 'chat_muted:';
      const suffix = `:${this.userId}`;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(prefix) && key.endsWith(suffix) && localStorage.getItem(key) === 'true') {
          const chatId = key.slice(prefix.length, key.length - suffix.length);
          if (chatId) mutedChatIds.push(chatId);
        }
      }
      reg.active.postMessage({ type: 'sync-muted-chats', userId: this.userId, mutedChatIds });
    } catch { /* non-critical */ }
  }

  // Notify the SW of a single mute state change (called from toggleMuteChat).
  notifySwMuteChange(chatId: string, muted: boolean): void {
    if (!this.userId || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.ready.then(reg => {
      reg.active?.postMessage({ type: 'mute-chat', userId: this.userId, chatId, muted });
    }).catch(() => {});
  }

  // Returns true if this tab successfully claimed the key (first to show this notification).
  // Uses localStorage so multiple open tabs don't each show the same notification.
  private tryClaimNotifKey(key: string): boolean {
    try {
      const lsKey = `shar_n:${key}`;
      if (localStorage.getItem(lsKey)) return false;
      localStorage.setItem(lsKey, String(Date.now()));
      // Auto-clean after 30s so the key doesn't accumulate
      setTimeout(() => { try { localStorage.removeItem(lsKey); } catch {} }, 30000);
      return true;
    } catch {
      return true; // localStorage unavailable — allow showing
    }
  }

  private async showNotification(
    title: string,
    body: string,
    options: {
      key: string;
      messageId?: string;
      tag: string;
      url: string;
      skipDedupe?: boolean;
      senderName?: string;
      subtitle?: string;
      chatName?: string;
      avatar?: string;
      badge?: number;
      requireInteraction?: boolean;
    }
  ): Promise<void> {
    console.log(`[BrowserPushService] 🔔 showNotification вызван: "${title}"`);
    console.log(`[BrowserPushService] Body: "${body}"`);
    console.log(`[BrowserPushService] Key: ${options.key}, Tag: ${options.tag}, SkipDedupe: ${options.skipDedupe}`);
    
    const dedupeKey = options.key;

    if (!options.skipDedupe) {
      if (this.shownKeys.has(dedupeKey)) {
        console.log(`[BrowserPushService] пропуск: ключ уже показан в этой сессии (${dedupeKey})`);
        return;
      }
      if (!this.tryClaimNotifKey(dedupeKey)) {
        console.log(`[BrowserPushService] пропуск: ключ занят другой вкладкой/окном через localStorage (${dedupeKey})`);
        this.shownKeys.add(dedupeKey);
        return;
      }
      this.shownKeys.add(dedupeKey);
    }

    const electronRuntime = isElectronRuntime();
    const hasElectronBridge = typeof window !== 'undefined' && Boolean(window.sharDesktop?.showNotification);

    if (electronRuntime && hasElectronBridge) {
      try {
        const kind = options.url.includes('tab=tasks')
          ? 'task'
          : options.url.includes('tab=calendar')
            ? 'event'
            : options.url.includes('tab=messages')
              ? 'message'
              : 'system';

        await window.sharDesktop!.showNotification({
          title,
          subtitle: options.subtitle || (kind === 'task' ? 'Задачи' : kind === 'event' ? 'Календарь' : kind === 'system' ? 'Shar OS' : 'Сообщения'),
          senderName: options.senderName || title,
          chatName: options.chatName,
          message: body,
          avatar: options.avatar,
          timestamp: Date.now(),
          badge: options.badge,
          chatId: options.url.includes('chat=') ? options.url.split('chat=')[1]?.split('&')[0] : undefined,
          messageId: options.messageId,
          url: options.url,
          kind,
        });
        console.log(`[BrowserPushService] отдано в Electron (окно ${typeof document !== 'undefined' ? document.visibilityState : '?'})`);
        return;
      } catch (err) {
        console.error('[BrowserPushService] Electron notification error:', err);
        return;
      }
    }

    if (electronRuntime && !hasElectronBridge) {
      console.warn('[BrowserPushService] пропуск: Electron есть, а моста sharDesktop.showNotification нет');
      return;
    }
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;

    const notificationOptions: NotificationOptions & {
      renotify?: boolean;
      requireInteraction?: boolean;
      timestamp?: number;
      vibrate?: number[];
    } = {
      body,
      tag: options.tag,
      icon: options.avatar
        ? (options.avatar.startsWith('http') ? options.avatar : `${typeof window !== 'undefined' ? window.location.origin : ''}${options.avatar}`)
        : '/favicon.png',
      badge: '/favicon.png',
      data: { url: options.url },
      silent: false,
      renotify: true,
      // По умолчанию TRUE: уведомление висит, пока его не закроют вручную или
      // пока чат не прочитают (тогда его снимает 'close-notifications' в
      // notifications-sw.js). Раньше здесь было false, и все уведомления, кроме
      // сообщений в чате, гасли сами — события и напоминания терялись.
      requireInteraction: options.requireInteraction ?? true,
      timestamp: Date.now(),
      vibrate: [200, 100, 200],
    };

    try {
      if ('serviceWorker' in navigator) {
        const registration = await navigator.serviceWorker.getRegistration();
        if (registration) {
          await registration.showNotification(title, notificationOptions);
          return;
        }
      }
      const notice = new Notification(title, notificationOptions);
      notice.onclick = () => {
        window.focus();
        navigate(options.url);
      };
    } catch (error) {
      console.error('[BrowserPushService] Notification error:', error);
    }
  }

  private async fetchJson<T>(url: string): Promise<T | null> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) return null;
      return (await response.json()) as T;
    } catch {
      return null;
    } finally {
      window.clearTimeout(timeout);
    }
  }
}
