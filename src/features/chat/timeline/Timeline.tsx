import { openReminderFromText } from '@/features/calendar';
import { plainFromMarkdown } from '@/features/chat/store';
import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { lazyComponent } from '@/shared/ui/lazy';
import {
  BellPlus,
  AlertCircle, ArrowDown, CheckCheck, Copy, CornerUpLeft, Forward, ImageDown, Pencil,
  Pin, PinOff, RotateCw, Trash2,
} from 'lucide-react';
import type { Message, User } from '@/shared/types/chat';
import { QUICK_REACTIONS } from '@/shared/emoji/emojiData';
import { getAppleEmojiUrl } from '@/shared/emoji/appleEmoji';
import { Avatar } from '@/shared/ui/Avatar';
import { attachmentUrl, formatDay, formatTime, dayKey } from '@/shared/ui/format';
import type { ViewerItem } from '@/shared/ui/ImageViewer';
import { askConfirm, Menu, MenuItem, Sheet } from '@/shared/ui/overlay';
import { isEdgeSwipeStart } from '@/shared/platform/viewport';
import {
  discardSend, isNotifications, loadLatest, loadOlder, markActiveRead, retrySend, setCompose, setSelection, toggleSelected,
  useChatStore, type ChatRow, type Msg, type Thread,
} from '../store';
import {
  copyImage, copySelectionOr, deleteMessage, editPoll, markVoiceListened, togglePin, toggleReaction, votePoll,
} from '../messageActions';
import ForwardSheet from '../ForwardSheet';
import { readerName } from './content';
import { MessageRow, type RowCtx } from './MessageRow';
import { Spinner } from '@/shared/ui/Spinner';
import { BubbleFocus, focusAnchor, focusShot, type FocusShot } from './BubbleFocus';
import { SectionIcon } from '@/shared/ui/SectionIcon';

const ImageViewer = lazyComponent(() => import('@/shared/ui/ImageViewer'));
const PollCreatorModal = lazyComponent(() => import('@/features/chat/polls/PollCreatorModal'));

/**
 * Лента переписки — перенос ChatTimelineV3.
 *
 * Прокрутка: открываемся внизу (или там, где остановились в прошлый раз),
 * подгрузка истории сверху не сдвигает взгляд, новые сообщения прилипают к
 * низу, только если человек и так был внизу.
 *
 * Жесты ловятся на контейнере по data-msg-id: долгое нажатие и правый клик —
 * меню, свайп влево — время у всех сообщений, свайп вправо по сообщению — ответ.
 * Во время жеста правим CSS-переменные напрямую, без перерисовки React.
 */

const EMPTY: Thread = { ids: [], byId: {}, hasMore: false, phase: 'idle', olderLoading: false };
const NEAR_BOTTOM = 96;
const LOAD_OLDER_AT = 320;
/** Окно отрисовки. В DOM — не больше MAX сообщений вокруг того, что на экране: при входе в чат последние
 *  WINDOW (или окрестность запомненного места), у края окна дорисовываем по STEP из памяти, с другого края
 *  столько же убираем; за историей на сервер идём, только дойдя до начала загруженного. Раньше лента держала
 *  в DOM всё загруженное — в большом чате вход в него и каждый кадр прокрутки дорожали с каждой страницей. */
const WINDOW = 30;
const STEP = 50;
const MAX = 200;
/** Окно сдвигаем заранее, за столько пикселей до его края, — чтобы дорисовка успевала до того, как край виден. */
const EDGE = 1200;
type Win = { start: string | null; end: string | null };
/** Окно по индексам; null — край загруженного (у нижнего края в окно попадают и новые сообщения). */
const span = (ids: string[], from: number, to: number): Win => ({
  start: from > 0 ? ids[from] : null,
  end: to < ids.length - 1 ? ids[Math.max(0, to)] : null,
});
const LONG_PRESS_MS = 450;
const SWIPE_TIME_MAX = 56;
const SWIPE_REPLY_MAX = 64;
const SWIPE_REPLY_AT = 48;
const scrollKey = (chatId: string) => `nx:scroll:${chatId}`;

/** Где остановились в каждом чате: в памяти — для мгновенного возврата, и в
 *  sessionStorage — на случай перезагрузки вкладки. Нет записи — открываемся внизу. */
const positions = new Map<string, { id: string; offset: number }>();
function savePosition(chatId: string, pos: { id: string; offset: number } | null) {
  if (pos) positions.set(chatId, pos); else positions.delete(chatId);
  try {
    if (pos) sessionStorage.setItem(scrollKey(chatId), JSON.stringify(pos));
    else sessionStorage.removeItem(scrollKey(chatId));
  } catch { /* ignore */ }
}
function readPosition(chatId: string): { id: string; offset: number } | null {
  const mem = positions.get(chatId);
  if (mem) return mem;
  try { return JSON.parse(sessionStorage.getItem(scrollKey(chatId)) || 'null'); } catch { return null; }
}

const INTERACTIVE = 'button, a, audio, video, input, textarea, select, [role="slider"], [data-interactive]';

type ReadInfo = { ts: number; label: string | null };

/** Верх строки в координатах содержимого ленты (offsetTop считается от ближайшей
 *  позиционированной обёртки — дня, — а не от ленты). */
function topIn(scroller: HTMLElement, el: HTMLElement): number {
  return el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

/** Первое сообщение, видимое вверху ленты, и его отступ от верха. Строки идут сверху вниз, поэтому
 *  ищем делением пополам: десяток замеров вместо замера каждой строки (в длинной переписке — сотни,
 *  и каждый заставлял браузер раскладывать скрытые дни). */
function firstVisibleRow(scroller: HTMLElement): { id: string; offset: number } | null {
  const rows = scroller.querySelectorAll<HTMLElement>('.cxm-row[data-msg-id]');
  if (!rows.length) return null;
  const top = scroller.getBoundingClientRect().top;
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].getBoundingClientRect().bottom > top) hi = mid; else lo = mid + 1;
  }
  const row = rows[lo];
  return { id: row.dataset.msgId || '', offset: row.getBoundingClientRect().top - top };
}

/** Отметить плашку даты, прилипшую к верху ленты (data-stuck): её прячет CSS, пока ленту не крутят.
 *  Прилипшая — та, что сдвинута со своего места в начале дня. */
function markStuckDay(scroller: HTMLElement) {
  let stuck: HTMLElement | null = null;
  for (const day of scroller.querySelectorAll<HTMLElement>('.cxm-day')) {
    const group = day.parentElement;
    if (!group) continue;
    // Плашка — первая в своём дне: на месте её верх = верх дня + её верхнее поле.
    const natural = group.getBoundingClientRect().top + (parseFloat(getComputedStyle(day).marginTop) || 0);
    const at = day.getBoundingClientRect().top;
    if (at - natural > 1) stuck = day;
    day.removeAttribute('data-stuck');
  }
  stuck?.setAttribute('data-stuck', '');
}

/** Для каждого собеседника — докуда он прочитал (время) и когда. */
function readMap(chat: ChatRow | undefined, thread: Thread, myId: string): Record<string, ReadInfo> {
  const out: Record<string, ReadInfo> = {};
  const markers = chat?.readMessagesByUser || {};
  const readAt = chat?.readAtByUser || {};
  for (const pid of (chat?.participantIds || []).map(String)) {
    if (pid === myId) continue;
    const marker = markers[pid];
    if (!marker) continue;
    const byMsg = thread.byId[marker];
    const ts = byMsg ? new Date(byMsg.createdAt).getTime() : new Date(marker).getTime();
    if (Number.isNaN(ts)) continue;
    const at = readAt[pid] ? new Date(readAt[pid]) : byMsg ? new Date(byMsg.createdAt) : new Date(ts);
    out[pid] = { ts, label: Number.isNaN(at.getTime()) ? null : formatTime(at.toISOString()) };
  }
  return out;
}

export default function Timeline({ chatId, chat, query = '', jumpTo: jumpRequest, onAvatar }: {
  chatId: string; chat?: ChatRow; query?: string; jumpTo?: { id: string; n: number } | null; onAvatar?: (userId: string) => void;
}) {
  const thread = useChatStore((s) => s.threads[chatId]) || EMPTY;
  const me = useChatStore((s) => s.me);
  const users = useChatStore((s) => s.users);
  const myId = String(me?.id ?? '');
  const isGroup = Boolean(chat?.isGroup) || (chat?.participantIds?.length ?? 0) > 2;
  const notificationsChat = Boolean(chat && isNotifications(chat));

  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const opened = useRef(false);
  const prevFirst = useRef<string | undefined>(undefined);
  const prevLast = useRef<string | undefined>(undefined);
  /** Сообщение вверху экрана и его отступ — чтобы после подгрузки истории оно осталось на месте. */
  const topAnchor = useRef<{ id: string; offset: number } | null>(null);
  /** Ключи, уже показанные на экране; для новых — момент, до которого идёт анимация появления. */
  const seen = useRef<Set<string> | null>(null);
  const freshUntil = useRef(new Map<string, number>());
  const [jump, setJump] = useState(false);
  const [missed, setMissed] = useState(0);
  const [mobile, setMobile] = useState(false);
  const [width, setWidth] = useState(0);
  const [menu, setMenu] = useState<{ msg: Msg; at: { x: number; y: number }; image: string | null } | null>(null);
  // Телефон: нажатое сообщение поверх размытой переписки (BubbleFocus). Живёт чуть дольше меню —
  // пока сообщение возвращается на место.
  const [focus, setFocus] = useState<{ shot: FocusShot; closing: boolean } | null>(null);
  useEffect(() => {
    if (!menu && focus && !focus.closing) setFocus({ ...focus, closing: true });
  }, [menu, focus]);
  // Убираем копию отдельным эффектом: раньше таймер жил в том же эффекте, что ставит closing, — смена focus
  // перезапускала эффект, очистка снимала таймер, и копия сообщения оставалась поверх ленты навсегда.
  const focusClosing = Boolean(focus?.closing);
  useEffect(() => {
    if (!focusClosing) return undefined;
    const t = window.setTimeout(() => setFocus((cur) => (cur?.closing ? null : cur)), 230);
    return () => window.clearTimeout(t);
  }, [focusClosing]);
  const [forwarding, setForwarding] = useState<Message[] | null>(null);
  const [pollEdit, setPollEdit] = useState<Msg | null>(null);
  const selection = useChatStore((s) => (s.selection?.chatId === chatId ? s.selection.ids : null));
  const selectedSet = useMemo(() => (selection ? new Set(selection) : null), [selection]);
  const [viewer, setViewer] = useState<{ items: ViewerItem[]; start: number } | null>(null);
  const [readersOf, setReadersOf] = useState<string | null>(null);

  const [win, setWin] = useState<Win>(() => {
    const ids = thread.ids;
    let at = -1;
    try { const saved = readPosition(chatId); at = saved ? ids.indexOf(saved.id) : -1; } catch { /* нет сохранённого места */ }
    return at >= 0 ? span(ids, at - 30, at + WINDOW) : span(ids, ids.length - WINDOW, ids.length - 1);
  });
  const range = useMemo(() => {
    const n = thread.ids.length;
    // Край окна пропал из загруженного (ленту перечитали) — встаём на последние сообщения.
    let a = win.start ? thread.ids.indexOf(win.start) : 0;
    let b = win.end ? thread.ids.indexOf(win.end) : n - 1;
    if (a < 0 || b < 0 || b < a) { a = Math.max(0, n - WINDOW); b = n - 1; }
    return { a, b, atEnd: b >= n - 1 };
  }, [thread.ids, win]);
  const shownIds = useMemo(() => (range.a === 0 && range.atEnd ? thread.ids : thread.ids.slice(range.a, range.b + 1)), [thread.ids, range]);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  // Сдвиг окна уже заказан (переход ещё не отрисован) — второй не заказываем. Положение на экране при сдвиге
  // держит якорение прокрутки браузера: вставка и удаление строк выше видимой не сдвигают то, что видно.
  const shifting = useRef(false);
  useEffect(() => { shifting.current = false; }, [win]);
  const pendingJump = useRef<string | null>(null);
  /** После перерисовки окна — к низу (кнопка «вниз», своё новое сообщение при окне в истории). */
  const bottomAfter = useRef(false);

  const firstId = shownIds[0];
  const lastId = thread.ids[thread.ids.length - 1];

  // Ширина колонки: размеры фото считаются от неё, а не от окна. Меряем до
  // первого кадра (layout-эффект): иначе первый кадр шёл с шириной по
  // умолчанию, затем настоящая меняла размер превью — адрес /api/thumbs
  // переключался, и фото при каждом входе в чат грузились и рисовались заново.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const mq = window.matchMedia('(max-width: 640px)');
    const onMq = () => setMobile(mq.matches);
    onMq();
    // Та же мера, что у ResizeObserver (contentRect — без внутренних отступов).
    const cs = getComputedStyle(el);
    setWidth(Math.round((el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) / 16) * 16);
    mq.addEventListener('change', onMq);
    // Ширина входит в общие настройки строк — её смена перерисовывает все сообщения ленты. Пока тянут край
    // окна или панели, раскладку ведёт CSS, а новую ширину строки получают, когда движение остановилось:
    // иначе каждые 16px шёл полный рендер ленты, и окно не поспевало за рамкой.
    let timer = 0;
    const ro = new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width / 16) * 16;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setWidth(next), 150);
    });
    ro.observe(el);
    return () => { mq.removeEventListener('change', onMq); ro.disconnect(); window.clearTimeout(timer); };
  }, []);

  const toBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  // ── Позиция прокрутки — до отрисовки кадра, чтобы не было прыжка ─────────
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!opened.current && thread.ids.length) {
      opened.current = true;
      let restored = false;
      try {
        const saved = readPosition(chatId);
        const anchor = saved && el.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(saved.id)}"]`);
        if (saved && anchor) {
          el.scrollTop = topIn(el, anchor) - saved.offset;
          restored = true;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
          setJump(!atBottom.current);
        }
      } catch { /* нет сохранённого места — открываемся внизу */ }
      if (!restored) toBottom();
      seen.current = new Set(thread.ids.map((id) => thread.byId[id]._key));
    } else if (firstId !== prevFirst.current && topAnchor.current) {
      // Дорисовали или убрали сверху (история, сдвиг окна) — верхнее видимое сообщение остаётся на месте.
      const a = topAnchor.current;
      const row = el.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(a.id)}"]`);
      if (row) el.scrollTop = topIn(el, row) - a.offset;
      topAnchor.current = null;
      // Пришла страница истории — лишнее снизу (за экраном) убираем.
      if (shownIds.length > MAX + STEP / 2) setWin((w) => ({ start: w.start, end: shownIds[MAX - 1] }));
    } else if (bottomAfter.current) {
      bottomAfter.current = false;
      toBottom();
    } else if (lastId && lastId !== prevLast.current) {
      const last = thread.byId[lastId];
      const mineNew = last && String(last.authorId) === myId;
      if (!range.atEnd) {
        // Окно в истории: своё сообщение — переносимся к низу, чужое — только счётчик на кнопке «вниз».
        if (mineNew) { bottomAfter.current = true; setWin(span(thread.ids, thread.ids.length - WINDOW, thread.ids.length - 1)); }
        else if (prevLast.current) setMissed((n) => n + 1);
      } else if (atBottom.current || mineNew) toBottom();
      else if (prevLast.current) setMissed((n) => n + 1);
    }
    prevFirst.current = firstId;
    prevLast.current = lastId;
  }, [firstId, lastId, thread.ids, thread.byId, myId, chatId, toBottom, shownIds, range.atEnd]);

  // Фото догружаются и меняют высоту — если были внизу, остаёмся внизу.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return undefined;
    const ro = new ResizeObserver(() => { if (atBottom.current) toBottom(); });
    // border-box: место под композер — это нижний отступ ленты, его рост
    // тоже должен докручивать ленту вниз.
    ro.observe(list, { box: 'border-box' });
    return () => ro.disconnect();
  }, [toBottom]);

  // Клавиатура (и поворот, и панель эмодзи) меняют высоту самого окна ленты, а
  // не её содержимого — наблюдатель выше этого не видит. Лента становилась ниже
  // при том же scrollTop, и низ последнего сообщения уходил под поле ввода.
  // Были внизу — остаёмся внизу; читали выше — то, что было у нижнего края,
  // остаётся у нижнего края (как в iMessage).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    let prev = el.clientHeight;
    const ro = new ResizeObserver(() => {
      const h = el.clientHeight;
      const delta = prev - h;
      prev = h;
      if (!delta) return;
      if (atBottom.current) toBottom();
      else el.scrollTop += delta;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [toBottom]);



  // Уйти «с низа» может только сам человек. Сдвиги прокрутки от догрузки фото,
  // истории и якорения браузера не должны снимать прилипание к последнему
  // сообщению — иначе лента переставала держаться внизу, а при подгрузке
  // истории «кидала» вверх.
  const userScrollAt = useRef(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const mark = () => { userScrollAt.current = Date.now(); };
    const onKey = (e: KeyboardEvent) => {
      if (['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '].includes(e.key)) mark();
    };
    el.addEventListener('wheel', mark, { passive: true });
    el.addEventListener('touchmove', mark, { passive: true });
    el.addEventListener('pointerdown', mark);
    el.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('wheel', mark);
      el.removeEventListener('touchmove', mark);
      el.removeEventListener('pointerdown', mark);
      el.removeEventListener('keydown', onKey);
    };
  }, []);

  // Позиция запоминается после каждой остановки прокрутки: при размонтировании
  // ленты сохранять уже поздно — React к тому времени отцепил ссылку на неё.
  const saveTimer = useRef(0);
  const scrollingTimer = useRef(0);
  const rememberPosition = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (atBottom.current) { savePosition(chatId, null); return; }
    const first = firstVisibleRow(el);
    if (first) savePosition(chatId, first);
  }, [chatId]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Пока ленту крутят, прилипшая дата видна (CSS по data-scrolling); через секунду покоя гаснет.
    // Атрибут ставим один раз за прокрутку, а не на каждое событие.
    if (!('scrolling' in el.dataset)) el.dataset.scrolling = '';
    window.clearTimeout(scrollingTimer.current);
    scrollingTimer.current = window.setTimeout(() => { markStuckDay(el); delete el.dataset.scrolling; }, 1000);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(rememberPosition, 150);
    const r = rangeRef.current;
    const bottom = r.atEnd && el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
    const byUser = Date.now() - userScrollAt.current < 600;
    if (bottom !== atBottom.current && (bottom || byUser)) {
      atBottom.current = bottom;
      setJump(!bottom);
      if (bottom) { setMissed(0); markActiveRead(); }
    }
    const t = useChatStore.getState().threads[chatId];
    const loading = Boolean(t?.olderLoading);
    // У края окна сначала дорисовываем уже загруженное из памяти — мгновенно, без сети; с другого края
    // столько же убираем. Верхнее видимое сообщение держим на месте (topAnchor).
    // Дорисовка — переходом React: рендер режется на куски и не держит прокрутку одной длинной задачей.
    if (t && el.scrollTop < EDGE && r.a > 0 && !shifting.current) {
      shifting.current = true;
      const from = r.a - STEP;
      startTransition(() => setWin(span(t.ids, from, Math.min(r.b, Math.max(from, 0) + MAX - 1))));
      return;
    }
    if (t && !r.atEnd && el.scrollHeight - el.scrollTop - el.clientHeight < EDGE && !shifting.current) {
      shifting.current = true;
      const to = r.b + STEP;
      startTransition(() => setWin(span(t.ids, Math.max(r.a, to - MAX + 1), to)));
      return;
    }
    if ((el.scrollTop < LOAD_OLDER_AT && t?.hasMore && t.phase === 'ready') || loading) {
      // Пока грузится история, держим актуальным верхнее видимое сообщение.
      const first = firstVisibleRow(el);
      if (first) topAnchor.current = first;
      if (!loading) void loadOlder(chatId);
    }
  }, [chatId, rememberPosition]);

  const jumpTo = useCallback((messageId: string) => {
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(messageId)}"]`);
    if (!el) {
      // Сообщение загружено, но за окном отрисовки — расширяем окно и прыгаем после кадра.
      const ids = useChatStore.getState().threads[chatId]?.ids || [];
      const at = ids.indexOf(messageId);
      if (at >= 0) { pendingJump.current = messageId; setWin(span(ids, at - 30, at + 30)); }
      return;
    }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.dataset.flash = 'true';
    window.setTimeout(() => { delete el.dataset.flash; }, 1400);
  }, [chatId]);

  useEffect(() => {
    const id = pendingJump.current;
    if (!id || !scrollRef.current?.querySelector(`[data-msg-id="${CSS.escape(id)}"]`)) return;
    pendingJump.current = null;
    jumpTo(id);
  }, [shownIds, jumpTo]);

  // Переход по запросу снаружи: поиск, закреплённое сообщение.
  useEffect(() => { if (jumpRequest) jumpTo(jumpRequest.id); }, [jumpRequest, jumpTo]);

  // ── Действия, стабильные для memo строк ─────────────────────────────────
  const ctxRef = useRef<RowCtx | null>(null);
  const usersMap = useMemo(() => new Map(Object.entries(users)), [users]);
  const ctx = useMemo<RowCtx>(() => ({
    myId,
    users,
    usersMap,
    isGroup,
    notificationsChat,
    mobile,
    columnWidth: width,
    query,
    onReply: (m) => setCompose(chatId, { replyToId: String(m.id) }),
    onReact: (m, emoji) => { void toggleReaction(chatId, String(m.id), emoji); },
    onVote: (id, opt) => { void votePoll(chatId, id, opt); },
    onVoiceListened: (id) => markVoiceListened(chatId, id),
    onOpenImage: (url) => {
      // Листаем все фото загруженной ленты, начиная с нажатого.
      const t = useChatStore.getState().threads[chatId];
      const items: ViewerItem[] = [];
      for (const id of t?.ids || []) {
        const m = t!.byId[id];
        for (const a of (m.attachments || []) as { url?: string; type?: string; name?: string; mimeType?: string }[]) {
          const u = attachmentUrl(a?.url);
          const image = a?.type === 'image' || String(a?.mimeType || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|heic)(\?|$)/i.test(String(a?.name || u));
          if (!u || !image) continue;
          items.push({
            url: u,
            name: a?.name,
            messageId: String(m.id),
            author: readerName(users[String(m.authorId)], m.authorName),
            date: `${formatDay(m.createdAt)}, ${formatTime(m.createdAt)}`,
          });
        }
      }
      const start = Math.max(0, items.findIndex((it) => it.url === url));
      setViewer({ items: items.length ? items : [{ url }], start: items.length ? start : 0 });
    },
    onJump: jumpTo,
    onAvatar,
    selected: selectedSet,
  }), [chatId, myId, users, usersMap, isGroup, notificationsChat, mobile, width, query, jumpTo, onAvatar, selectedSet]);
  ctxRef.current = ctx;

  // ── Жесты (делегирование на контейнер) ──────────────────────────────────
  const gesture = useRef({
    x: 0, y: 0, row: null as HTMLElement | null, msgId: '', mode: 'idle' as 'idle' | 'deciding' | 'time' | 'reply' | 'none',
    timer: 0, fired: false, dir: 1, ox: 0,
  });

  const msgFrom = (el: EventTarget | null): Msg | null => {
    const row = (el as HTMLElement | null)?.closest?.<HTMLElement>('[data-msg-id]');
    const id = row?.dataset.msgId;
    return id ? useChatStore.getState().threads[chatId]?.byId[id] ?? null : null;
  };

  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    const g = gesture.current;
    const target = e.target as HTMLElement;
    g.x = t.clientX; g.y = t.clientY; g.fired = false;
    g.row = target.closest<HTMLElement>('[data-msg-id]');
    g.msgId = g.row?.dataset.msgId || '';
    window.clearTimeout(g.timer);
    // У левого края палец ведёт жест «назад» (useEdgeBack), а не ответ.
    if (isEdgeSwipeStart(t.clientX)) { g.mode = 'none'; return; }
    g.mode = 'deciding';
    if (g.row && target.closest('.cxm-bubble') && !target.closest(INTERACTIVE)) {
      g.timer = window.setTimeout(() => {
        const msg = msgFrom(g.row);
        if (!msg) return;
        g.fired = true;
        g.mode = 'none';
        navigator.vibrate?.(8);
        const img = target.closest<HTMLImageElement>('img.cxm-photo');
        const bubble = target.closest<HTMLElement>('.cxm-bubble');
        const shot = g.row && bubble ? focusShot(g.row, bubble) : null;
        if (shot) setFocus({ shot, closing: false });
        setMenu({ msg, at: shot ? focusAnchor(shot) : { x: t.clientX, y: t.clientY }, image: img?.src ?? null });
      }, LONG_PRESS_MS);
    }
  };

  const onTouchMove = (e: TouchEvent) => {
    const g = gesture.current;
    const t = e.touches[0];
    const dx = t.clientX - g.x;
    const dy = t.clientY - g.y;
    if (Math.hypot(dx, dy) > 10) window.clearTimeout(g.timer);
    if (g.mode === 'deciding') {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      const horizontal = Math.abs(dx) > Math.abs(dy) * 1.3;
      // Ответ — свайпом в любую сторону: влево, как в Telegram, или вправо,
      // как в WhatsApp. Раньше работал только вправо, и привычный жест «не работал».
      g.mode = horizontal && g.row && !notificationsChat ? 'reply' : 'none';
      g.dir = dx > 0 ? 1 : -1;
      // Отсчёт — от точки, где жест распознан: иначе пузырь сразу прыгал на «мёртвую зону» в 10px.
      g.ox = t.clientX;
      if (g.mode === 'reply' && g.row) { g.row.dataset.dir = g.dir > 0 ? 'right' : 'left'; g.row.dataset.replying = 'true'; }
    }
    // Решили, что это ответ, — ленту больше не прокручиваем: иначе iOS
    // забирает жест себе, и пузырь дёргается по вертикали.
    if (g.mode === 'reply' && e.cancelable) e.preventDefault();
    if (g.mode === 'time') {
      listRef.current?.style.setProperty('--swipe', `${Math.max(-SWIPE_TIME_MAX, Math.min(0, dx))}px`);
    } else if (g.mode === 'reply' && g.row) {
      const pulled = Math.max(0, (t.clientX - g.ox) * g.dir);
      // За порогом — с сопротивлением, как резинка, а не упором в стену.
      const d = pulled <= SWIPE_REPLY_AT ? pulled : Math.min(SWIPE_REPLY_MAX, SWIPE_REPLY_AT + (pulled - SWIPE_REPLY_AT) * 0.35);
      g.row.style.setProperty('--reply', `${d * g.dir}px`);
      if (d >= SWIPE_REPLY_AT && g.row.dataset.replying !== 'armed') navigator.vibrate?.(6);
      g.row.dataset.replying = d >= SWIPE_REPLY_AT ? 'armed' : 'true';
    }
  };

  const onTouchEnd = (e: TouchEvent) => {
    const g = gesture.current;
    window.clearTimeout(g.timer);
    if (g.fired) { e.preventDefault(); g.fired = false; }
    if (g.mode === 'time') listRef.current?.style.setProperty('--swipe', '0px');
    if (g.mode === 'reply' && g.row) {
      const armed = g.row.dataset.replying === 'armed';
      g.row.style.setProperty('--reply', '0px');
      delete g.row.dataset.replying;
      delete g.row.dataset.dir;
      const msg = msgFrom(g.row);
      if (armed && msg) {
        setCompose(chatId, { replyToId: String(msg.id) });
        // Как в Telegram: после свайпа сразу печатаем ответ.
        document.querySelector<HTMLTextAreaElement>('.cxn-composer textarea')?.focus();
      }
    }
    listRef.current?.removeAttribute('data-gesture');
    g.mode = 'idle';
  };

  // Слушатели нативные: у React touchmove пассивный, а жесту ответа нужно
  // отменять прокрутку. Обработчики берём свежие из ref.
  const touch = useRef({ onTouchStart, onTouchMove, onTouchEnd });
  useEffect(() => { touch.current = { onTouchStart, onTouchMove, onTouchEnd }; });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const start = (e: TouchEvent) => touch.current.onTouchStart(e);
    const move = (e: TouchEvent) => touch.current.onTouchMove(e);
    const end = (e: TouchEvent) => touch.current.onTouchEnd(e);
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
    return () => {
      el.removeEventListener('touchstart', start);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', end);
    };
  }, []);

  const onContextMenu = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!target.closest('.cxm-bubble') || target.closest('a')) return;
    const msg = msgFrom(target);
    if (!msg || msg._status || selection) return;
    e.preventDefault();
    setMenu({ msg, at: { x: e.clientX, y: e.clientY }, image: target.closest<HTMLImageElement>('img.cxm-photo')?.src ?? null });
  };

  // Esc — выйти из режима выделения.
  useEffect(() => {
    if (!selection) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelection(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection]);

  // Выделение: двойной клик по сообщению начинает, дальше клики отмечают.
  const onClick = (e: React.MouseEvent) => {
    if (!selection) return;
    const target = e.target as HTMLElement;
    if (target.closest('a, audio, video, input')) return;
    const msg = msgFrom(target);
    if (!msg || msg._status) return;
    e.preventDefault();
    toggleSelected(chatId, String(msg.id));
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    if (selection || notificationsChat) return;
    const target = e.target as HTMLElement;
    if (target.closest(INTERACTIVE) || !target.closest('.cxm-bubble')) return;
    const msg = msgFrom(target);
    if (!msg || msg._status) return;
    window.getSelection()?.removeAllRanges();
    setSelection({ chatId, ids: [String(msg.id)] });
  };

  // ── Строки ────────────────────────────────────────────────────────────────
  const reads = useMemo(() => readMap(chat, thread, myId), [chat, thread, myId]);

  const rows = useMemo(() => {
    const msgs = shownIds.map((id) => thread.byId[id]).filter(Boolean);
    const isOwn = (m: Msg) => String(m.authorId) === myId && !notificationsChat && !m.isSystemMessage && !m.isDeleted;
    let lastOwn: Msg | undefined;
    let lastReadOwn: Msg | undefined;
    // Отметки «доставлено / прочитано» — по всей загруженной ленте, а рисуются, только если попали в окно.
    for (let i = thread.ids.length - 1; i >= 0; i--) {
      const m = thread.byId[thread.ids[i]];
      if (!m) continue;
      if (!isOwn(m)) continue;
      if (!lastOwn) lastOwn = m;
      const t = new Date(m.createdAt).getTime();
      if (!m._status && Object.values(reads).some((r) => r.ts >= t)) { lastReadOwn = m; break; }
    }
    // Сообщения одного дня — в своей группе: плашка даты прилипает к верху
    // только в пределах своего дня и вытесняется следующей, а не ложится
    // поверх неё.
    const days: ReactNode[] = [];
    let out: ReactNode[] = [];
    let dayStart = '';
    const closeDay = () => {
      if (out.length) days.push(<section key={`g${dayStart}`} className="cxm-daygroup">{out}</section>);
      out = [];
    };
    const seenKeys = seen.current;
    const before = range.a > 0 ? thread.byId[thread.ids[range.a - 1]] : undefined;
    const after = thread.byId[thread.ids[range.b + 1]];
    msgs.forEach((m, i) => {
      const prev = i ? msgs[i - 1] : before;
      const next = i < msgs.length - 1 ? msgs[i + 1] : after;
      if (!prev || dayKey(prev.createdAt) !== dayKey(m.createdAt)) {
        closeDay();
        dayStart = String(dayKey(m.createdAt));
        out.push(<div key={`d${dayKey(m.createdAt)}`} className="cxm-day"><span>{formatDay(m.createdAt)}</span></div>);
      }
      if (m.metadata?.isPinned && m.metadata?.pinnedBy) {
        out.push(<div key={`pin${m._key}`} className="cxm-system"><Pin size={12} /> {m.metadata.pinnedBy} закрепил(а) сообщение</div>);
      }
      // Анимация появления — только у сообщений, пришедших при открытом чате,
      // и держится, пока не доиграет, даже если лента перерисуется раньше.
      if (seenKeys && !seenKeys.has(m._key)) {
        seenKeys.add(m._key);
        if (!(m._status && String(m.authorId) === myId)) freshUntil.current.set(m._key, Date.now() + 400);
      }
      const fresh = (freshUntil.current.get(m._key) || 0) > Date.now();
      out.push(
        <MessageRow
          key={m._key}
          m={m}
          prev={prev}
          next={next}
          reply={m.replyToId ? thread.byId[m.replyToId] : undefined}
          enter={fresh}
          ctx={ctx}
        />,
      );
      if (lastReadOwn && m === lastReadOwn) {
        out.push(<ReadStatus key={`r${m._key}`} m={m} reads={reads} users={users} onOpen={() => setReadersOf(String(m.id))} />);
      }
      if (lastOwn && m === lastOwn && m !== lastReadOwn) {
        out.push(<SendStatus key={`s${m._key}`} m={m} />);
      }
    });
    closeDay();
    return days;
  }, [thread, shownIds, range, myId, notificationsChat, reads, users, ctx]);

  let content: ReactNode;
  if (!thread.ids.length && (thread.phase === 'loading' || thread.phase === 'idle')) {
    content = <div className="nx-state" aria-busy="true"><Spinner size={24} /><p>Загружаю сообщения</p></div>;
  } else if (!thread.ids.length && thread.phase === 'error') {
    content = (
      <div className="nx-state" data-tone="danger" role="alert">
        <AlertCircle size={28} aria-hidden="true" />
        <h2>Не загрузил переписку</h2>
        <p>Сервер не ответил. Проверьте связь и повторите.</p>
        <button type="button" className="nx-ghost" onClick={() => void loadLatest(chatId)}><RotateCw size={14} aria-hidden="true" /> Повторить</button>
      </div>
    );
  } else if (!thread.ids.length) {
    content = <div className="nx-state"><SectionIcon name="chats" size={56} /><h2>Сообщений пока нет</h2><p>Напишите первое — оно появится здесь.</p></div>;
  } else {
    content = (
      <>
        {thread.olderLoading && <div className="cxm-older" aria-busy="true"><Spinner size={16} label="Загружаю историю" /></div>}
        {!thread.hasMore && range.a === 0 && thread.phase === 'ready' && <div className="cxm-start">Начало переписки</div>}
        {rows}
      </>
    );
  }

  const menuMsg = menu?.msg;
  const menuMine = menuMsg && String(menuMsg.authorId) === myId && !notificationsChat;
  const menuPoll = menuMsg?.metadata?.poll as { question?: string; options?: { text: string; voters?: string[] }[]; multipleChoice?: boolean; isAnonymous?: boolean; allowRevote?: boolean } | undefined;
  const pollHasVotes = Boolean(menuPoll?.options?.some((o) => (o.voters || []).length));
  const myReactions = new Set(Object.entries(menuMsg?.metadata?.reactions || {}).filter(([, ids]) => (ids as string[]).map(String).includes(myId)).map(([e]) => e));

  return (
    <div className="cxn-scroll-wrap">
      <div
        ref={scrollRef}
        className="cxn-scroll cxm-scroll"
        onScroll={onScroll}
        onContextMenu={onContextMenu}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        role="log"
        aria-live="polite"
        aria-label="Сообщения"
      >
        <div ref={listRef} className="cxn-timeline cxm-list" data-group={isGroup ? 'true' : undefined} data-selecting={selection ? 'true' : undefined}>
          {content}
        </div>
      </div>
      {jump && (
        <button
          type="button"
          className="nx-icon-btn cxn-jump"
          onClick={() => {
            setMissed(0);
            if (rangeRef.current.atEnd) { toBottom(true); return; }
            // Окно в истории — рисуем последние сообщения и встаём вниз без долгой анимации через всю ленту.
            bottomAfter.current = true;
            const ids = useChatStore.getState().threads[chatId]?.ids || [];
            setWin(span(ids, ids.length - WINDOW, ids.length - 1));
          }}
          aria-label={missed ? `К новым сообщениям: ${missed}` : 'К последним сообщениям'}
        >
          <ArrowDown size={18} aria-hidden="true" />
          {missed > 0 && <span className="nx-count">{missed}</span>}
        </button>
      )}

      {focus && <BubbleFocus shot={focus.shot} closing={focus.closing} />}
      {menu && menuMsg && (
        <Menu anchor={menu.at} label="Действия с сообщением" onClose={() => setMenu(null)}>
          {!notificationsChat && (
            <div className="cxm-quick" role="group" aria-label="Реакции">
              {QUICK_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className="cxm-quick-btn"
                  aria-pressed={myReactions.has(emoji)}
                  aria-label={emoji}
                  onClick={() => { void toggleReaction(chatId, String(menuMsg.id), emoji); setMenu(null); }}
                >
                  <img src={getAppleEmojiUrl(emoji)} alt="" draggable={false} />
                </button>
              ))}
            </div>
          )}
          {!notificationsChat && (
            <MenuItem icon={<CornerUpLeft size={16} />} onSelect={() => { setCompose(chatId, { replyToId: String(menuMsg.id) }); setMenu(null); }}>Ответить</MenuItem>
          )}
          {!menuPoll && (
            <MenuItem icon={<CheckCheck size={16} />} onSelect={() => { setSelection({ chatId, ids: [String(menuMsg.id)] }); setMenu(null); }}>Выбрать</MenuItem>
          )}
          {!menuPoll && (
            <MenuItem icon={<Forward size={16} />} onSelect={() => { setForwarding([menuMsg]); setMenu(null); }}>Переслать</MenuItem>
          )}
          {!menuPoll && menuMsg.content && (
            <MenuItem icon={<Copy size={16} />} onSelect={() => { void copySelectionOr(menuMsg); setMenu(null); }}>Копировать</MenuItem>
          )}
          {!menuPoll && menuMsg.content && (
            <MenuItem icon={<BellPlus size={16} />} onSelect={() => { openReminderFromText(plainFromMarkdown(String(menuMsg.content || ''))); setMenu(null); }}>Напоминание…</MenuItem>
          )}
          {menu.image && (
            <MenuItem icon={<ImageDown size={16} />} onSelect={() => { void copyImage(menu.image!); setMenu(null); }}>Копировать картинку</MenuItem>
          )}
          {menuMine && ((menuMsg.content && !menuPoll) || (menuPoll && !pollHasVotes)) && (
            <MenuItem
              icon={<Pencil size={16} />}
              onSelect={() => {
                if (menuPoll) setPollEdit(menuMsg);
                else setCompose(chatId, { editingId: String(menuMsg.id) });
                setMenu(null);
              }}
            >
              Изменить
            </MenuItem>
          )}
          {!notificationsChat && (
            <MenuItem
              icon={menuMsg.metadata?.isPinned ? <PinOff size={16} /> : <Pin size={16} />}
              onSelect={() => { void togglePin(chatId, String(menuMsg.id)); setMenu(null); }}
            >
              {menuMsg.metadata?.isPinned ? 'Открепить' : 'Закрепить'}
            </MenuItem>
          )}
          {(menuMine || notificationsChat) && (
            <>
              <div className="nx-menu-sep" />
              <MenuItem
                icon={<Trash2 size={16} />}
                tone="danger"
                onSelect={() => {
                  setMenu(null);
                  void askConfirm({ title: 'Удалить сообщение?', text: 'Оно пропадёт у всех участников чата.', confirm: 'Удалить', tone: 'danger' })
                    .then((ok) => { if (ok) void deleteMessage(chatId, String(menuMsg.id)); });
                }}
              >
                Удалить
              </MenuItem>
            </>
          )}
        </Menu>
      )}

      {viewer && (
        <ImageViewer
          items={viewer.items}
          start={viewer.start}
          onClose={() => setViewer(null)}
          onJump={jumpTo}
          onCopy={(u) => void copyImage(u)}
        />
      )}

      {forwarding && <ForwardSheet messages={forwarding} onClose={() => setForwarding(null)} />}

      {pollEdit && (() => {
        const p = pollEdit.metadata?.poll as { question?: string; options?: { text: string }[]; multipleChoice?: boolean; isAnonymous?: boolean; allowRevote?: boolean };
        return (
          <PollCreatorModal
            isOpen
            onClose={() => setPollEdit(null)}
            editingPoll={{
              messageId: String(pollEdit.id),
              question: p?.question || '',
              options: (p?.options || []).map((o) => o.text),
              multipleChoice: Boolean(p?.multipleChoice),
              isAnonymous: Boolean(p?.isAnonymous),
              allowRevote: Boolean(p?.allowRevote),
            }}
            onCreate={(q, opts, multi, anon, revote) => {
              void editPoll(chatId, String(pollEdit.id), q, opts, multi, anon, revote);
              setPollEdit(null);
            }}
          />
        );
      })()}

      {readersOf && (
        <ReadersSheet
          m={thread.byId[readersOf]}
          reads={reads}
          users={users}
          onClose={() => setReadersOf(null)}
        />
      )}
    </div>
  );
}

// ── Статусы под последним своим сообщением (как в iMessage) ────────────────

function ReadStatus({ m, reads, users, onOpen }: { m: Msg; reads: Record<string, ReadInfo>; users: Record<string, User>; onOpen: () => void }) {
  const t = new Date(m.createdAt).getTime();
  const readers = Object.entries(reads).filter(([, r]) => r.ts >= t);
  const voice = (m.attachments || []).some((a: { type?: string }) => a?.type === 'voice') && m.metadata?.voiceListened;
  const verb = voice ? 'Прослушано' : 'Прочитано';
  const single = readers.length === 1 ? readers[0][1].label : null;
  return (
    <button type="button" className="cxm-status" onClick={onOpen}>
      <span className="cxm-status-people">
        {readers.slice(0, 3).map(([uid]) => (
          <Avatar key={uid} name={readerName(users[uid])} seed={uid} src={users[uid]?.avatar} person size={16} />
        ))}
      </span>
      <span key={single || 'many'}>{single ? `${verb} в ${single}` : verb}</span>
    </button>
  );
}

function SendStatus({ m }: { m: Msg }) {
  if (m._status === 'failed') {
    return (
      <div className="cxm-status" data-tone="danger" role="alert">
        <button type="button" className="cxm-status-link" onClick={() => retrySend(m.chatId, m.id)}>Не доставлено · отправить ещё раз</button>
        <button type="button" className="cxm-status-link" onClick={() => discardSend(m.chatId, m.id)}>Удалить</button>
      </div>
    );
  }
  const label = m._status === 'sending' ? 'Отправляется…' : m._pushDelivered ? 'Отправлено уведомление' : 'Отправлено';
  return (
    <div className="cxm-status" data-tone={m._status === 'sending' ? 'pending' : undefined}>
      <span key={label}>{label}</span>
    </div>
  );
}

function ReadersSheet({ m, reads, users, onClose }: {
  m?: Msg; reads: Record<string, ReadInfo>; users: Record<string, User>; onClose: () => void;
}) {
  if (!m) return null;
  const t = new Date(m.createdAt).getTime();
  const readers = Object.entries(reads).filter(([, r]) => r.ts >= t);
  return (
    <Sheet title="Прочитали" onClose={onClose}>
      {readers.length === 0 && <p className="nx-hint">Пока никто не прочитал.</p>}
      {readers.map(([uid, r]) => (
        <div key={uid} className="nx-pick" role="listitem">
          <Avatar name={readerName(users[uid])} seed={uid} src={users[uid]?.avatar} person size={36} />
          <span className="nx-pick-text">
            <span>{readerName(users[uid], 'Участник')}</span>
            {r.label && <span>в {r.label}</span>}
          </span>
        </div>
      ))}
    </Sheet>
  );
}

