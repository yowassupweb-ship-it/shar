/**
 * Один realtime-канал на вкладку.
 *
 * Сервер шлёт события в /api/ws/{userId}. Раньше каждый экран открывал свой
 * сокет и сам решал, жив ли он; экран чатов «лечил» свой сокет перезапросами,
 * когда замечал, что сервис уведомлений событие уже получил. Здесь проще:
 *
 *  - один сокет с переподключением (1 → 2 → 4 … 30 с, с разбросом); все
 *    потребители — стор чатов, задачи, почта, сервис уведомлений — подписаны
 *    на него, своих сокетов ни у кого нет;
 *  - после каждого переподключения подписчики получают `resync` — один
 *    догоняющий запрос вместо опроса по таймеру;
 *  - «мёртвое» соединение (NAT, смена сети) ловит таймер тишины: сервер пингует
 *    раз в 20 с, 45 с тишины — переподключаемся.
 */

export type RealtimeEvent = { type: string; chatId?: string; [key: string]: unknown };
export type RealtimeStatus = 'connecting' | 'open' | 'down';

type EventListener = (event: RealtimeEvent) => void;
type StatusListener = (status: RealtimeStatus) => void;

const SILENCE_LIMIT_MS = 45000;
const STALE_ON_WAKE_MS = 30000;
const BACKOFF_MAX_MS = 30000;
/** Повтор после отказа сервера (1008) — не раньше, чем через столько: частый круг «отказ → переподключение» нагружал бы сервер. */
const UNAUTHORIZED_RETRY_MS = 15000;

function socketUrl(userId: string): string {
  const path = `/api/ws/${encodeURIComponent(userId)}`;
  const https = window.location.protocol === 'https:';
  // Всегда свой origin: в проде /api/ws отдаёт nginx, в dev — прокси Vite
  // (vite.config.ts), в Electron — локальный сервер встроенного клиента, который
  // пробрасывает сокет на бэкенд с кукой сессии и родным Origin. Прямое подключение
  // на домен бэкенда из Electron несёт Origin http://127.0.0.1:… и без куки: сервер
  // отвечает отказом (origin/session), и реалтайм молча не работает.
  return `${https ? 'wss:' : 'ws:'}//${window.location.host}${path}`;
}

const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

/** Кадр сокета → событие. Текстовый и бинарный кадр (UTF-8 JSON) равноправны. */
function parseFrame(data: unknown): RealtimeEvent | null {
  let text: string;
  if (typeof data === 'string') text = data;
  else if (data instanceof ArrayBuffer && decoder) text = decoder.decode(data);
  else return null;
  try {
    const event = JSON.parse(text) as RealtimeEvent;
    return event && typeof event.type === 'string' && event.type ? event : null;
  } catch {
    return null;
  }
}

class RealtimeClient {
  private userId: string | null = null;
  private ws: WebSocket | null = null;
  private refs = 0;
  private status: RealtimeStatus = 'down';
  private backoff = 1000;
  private reconnectTimer: number | null = null;
  private silenceTimer: number | null = null;
  private lastEventAt = 0;
  private hadConnection = false;
  private events = new Set<EventListener>();
  /** Что умеет сервер этого соединения (кадр hello). Пусто — старый сервер. */
  private features = new Set<string>();
  private statuses = new Set<StatusListener>();
  /** Номер последнего события этого соединения (см. checkSeq). */
  private lastSeq: number | null = null;
  private lastGapAt = 0;
  /** Подписка на события, принятые главным процессом Electron (см. start). */
  private offDesktop: (() => void) | null = null;

  start(userId: string): () => void {
    if (this.userId && this.userId !== userId) this.teardown();
    this.userId = userId;
    this.refs += 1;
    if (this.refs === 1) {
      window.addEventListener('shar:session-ready', this.onWake);
      window.addEventListener('online', this.onWake);
      window.addEventListener('focus', this.onWake);
      document.addEventListener('visibilitychange', this.onWake);
      // Electron: у главного процесса свой прямой сокет, и он узнаёт о сообщении
      // раньше и надёжнее, чем страница через локальный сервер. Новые сообщения
      // берём и оттуда; повтор по тому же id стор отсеивает (seenMessage).
      const desktop = (window as unknown as { sharDesktop?: { onRealtimeEvent?: (cb: (e: RealtimeEvent) => void) => () => void } }).sharDesktop;
      this.offDesktop = desktop?.onRealtimeEvent?.((event) => {
        if (event && event.type === 'new_message') this.emit(event);
      }) ?? null;
      this.connect();
    }
    return () => {
      this.refs -= 1;
      if (this.refs <= 0) this.teardown();
    };
  }

  subscribe(fn: EventListener): () => void {
    this.events.add(fn);
    return () => { this.events.delete(fn); };
  }

  /** Сервер этого соединения принимает кадры такого типа (send, typing, read). */
  supports(feature: string): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.features.has(feature);
  }

  /** Кадр в сокет. false — отправить некуда (нет соединения или сервер не умеет). */
  send(frame: { type: string } & Record<string, unknown>): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.features.has(frame.type)) return false;
    try { ws.send(JSON.stringify(frame)); return true; } catch { return false; }
  }

  onStatus(fn: StatusListener): () => void {
    this.statuses.add(fn);
    fn(this.status);
    return () => { this.statuses.delete(fn); };
  }

  private setStatus(next: RealtimeStatus) {
    if (this.status === next) return;
    this.status = next;
    for (const fn of this.statuses) fn(next);
  }

  private emit(event: RealtimeEvent) {
    for (const fn of this.events) {
      try { fn(event); } catch (err) { console.error('[realtime] listener failed', err); }
    }
  }

  private connect() {
    if (!this.userId) return;
    if (this.reconnectTimer !== null) { window.clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.setStatus('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(socketUrl(this.userId));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.lastSeq = null; // нумерация — своя у каждого соединения
    // Прокси десктопа (или любой посредник) может отдать текстовый кадр как
    // бинарный. С Blob пришлось бы ждать асинхронного чтения и терять порядок
    // кадров, ArrayBuffer декодируется сразу.
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.backoff = 1000;
      this.touch();
      this.setStatus('open');
      // Первое подключение тоже догоняет: между загрузкой истории и открытием
      // сокета могло что-то прийти.
      this.emit({ type: 'resync', initial: !this.hadConnection });
      this.hadConnection = true;
    };

    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      const event = parseFrame(e.data);
      // Живым считаем только сокет, чьи кадры мы понимаем. Раньше таймер
      // тишины сбрасывался до разбора: сокет, приносивший нечитаемые кадры,
      // выглядел здоровым вечно, а все события пропадали.
      if (!event) return;
      this.touch();
      this.checkSeq(event);
      if (event.type === 'ping') return;
      if (event.type === 'hello') {
        this.features = new Set(Array.isArray(event.features) ? (event.features as string[]) : []);
      }
      this.emit(event);
    };

    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.features = new Set();
      this.clearSilence();
      this.setStatus('down');
      // 1008 — сервер не признал сессию. Это разлогин, а не обрыв:
      // Корень приложения перепроверит сессию и покажет вход (app/AppRoot.tsx),
      // после восстановления придёт session-ready.
      if (e.code === 1008) {
        window.dispatchEvent(new Event('shar:ws-unauthorized'));
        // Если вход на самом деле жив (сервер отказал по другой причине — например, по Origin
        // за посредником), проверка сессии ничего не меняет, и сокет молчал до следующего фокуса
        // окна: открытый чат не получал ни сообщений, ни «прочитано». Пробуем снова сами, но
        // редко и всё реже — истёкший вход тем временем уведёт на экран входа и снимет подписку.
        this.backoff = Math.max(this.backoff, UNAUTHORIZED_RETRY_MS);
        if (this.refs > 0) this.scheduleReconnect();
        return;
      }
      if (this.refs > 0) this.scheduleReconnect();
    };

    ws.onerror = () => { /* за ошибкой всегда следует close */ };
  }

  /** Сервер нумерует события пользователя; приветствие и пинг несут номер
   *  последнего. Пропуск (номер прыгнул, пинг знает больше, чем пришло) —
   *  событие потерялось по дороге: одна догрузка вместо тихого расхождения. */
  private checkSeq(event: RealtimeEvent) {
    const seq = typeof event.seq === 'number' ? event.seq : NaN;
    if (!Number.isFinite(seq)) return;
    if (event.type === 'hello') { this.lastSeq = seq; return; }
    const last = this.lastSeq;
    if (last === null) { this.lastSeq = seq; return; }
    if (event.type === 'ping') {
      if (seq > last) { this.lastSeq = seq; this.gapResync(); }
      return;
    }
    if (seq > last + 1) this.gapResync();
    if (seq > last) this.lastSeq = seq;
  }

  private gapResync() {
    // Пачка пропусков подряд — одна догрузка.
    const now = Date.now();
    if (now - this.lastGapAt < 3000) return;
    this.lastGapAt = now;
    console.warn('[realtime] пропуск событий — догружаю');
    this.emit({ type: 'resync', gap: true });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== null) return;
    const delay = this.backoff + Math.random() * 400;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private touch() {
    this.lastEventAt = Date.now();
    this.clearSilence();
    this.silenceTimer = window.setTimeout(() => this.forceReconnect(), SILENCE_LIMIT_MS);
  }

  private clearSilence() {
    if (this.silenceTimer !== null) { window.clearTimeout(this.silenceTimer); this.silenceTimer = null; }
  }

  /** Сокет, похоже, мёртв, хотя выглядит живым (пуш пришёл, а событие нет) —
   *  пересоздать соединение. */
  heal() {
    if (this.refs > 0) this.forceReconnect();
  }

  private forceReconnect() {
    this.backoff = 1000;
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close(); // onclose → быстрое переподключение
      return;
    }
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      this.ws = null;
      this.connect();
    }
  }

  private onWake = () => {
    if (document.visibilityState === 'hidden') return;
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      this.backoff = 1000;
      this.connect();
    } else if (ws.readyState === WebSocket.OPEN && Date.now() - this.lastEventAt > STALE_ON_WAKE_MS) {
      this.forceReconnect();
    }
  };

  private teardown() {
    this.offDesktop?.(); this.offDesktop = null;
    window.removeEventListener('shar:session-ready', this.onWake);
    window.removeEventListener('online', this.onWake);
    window.removeEventListener('focus', this.onWake);
    document.removeEventListener('visibilitychange', this.onWake);
    if (this.reconnectTimer !== null) { window.clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.clearSilence();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.refs = 0;
    this.hadConnection = false;
    this.setStatus('down');
  }
}

export const realtime = new RealtimeClient();
