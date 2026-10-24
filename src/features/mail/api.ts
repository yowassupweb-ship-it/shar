import { create } from 'zustand';
import { realtime, type RealtimeEvent } from '@/shared/realtime/realtime';

/**
 * Почта нового Шара: данные.
 *
 * Письма забирает сервер — он держит соединение с ящиком (IDLE) и присылает в
 * сокет mail_new / mail_changed. Клиент ничего не опрашивает: перечитывает
 * папку по событию, при открытии папки и после переподключения сокета.
 */

export interface Account {
  id: string; name: string; email: string; signature?: string;
  imapHost?: string; imapPort?: number; smtpHost?: string; smtpPort?: number; username?: string; useSsl?: boolean;
}

export interface AccountForm {
  name: string; email: string; username: string; password: string;
  imapHost: string; imapPort: number; smtpHost: string; smtpPort: number; useSsl: boolean; signature: string;
}
/** Спецпапка (входящие, отправленные…) или папка, которую человек завёл сам (`folder`, с уровнем вложенности). */
export interface Box { role: 'inbox' | 'drafts' | 'sent' | 'junk' | 'trash' | 'archive' | 'folder'; folder: string; title: string; unread: number; depth?: number }
export interface Addr { addr: string; name?: string }
export interface MailAttachment { filename: string; contentType?: string; content_type?: string; size: number; url?: string }

export interface MailRow {
  id: string;
  folder: string;
  subject: string;
  fromAddr: string;
  fromName: string;
  toAddrs: Addr[];
  ccAddrs: Addr[];
  snippet?: string;
  attachments: MailAttachment[];
  isRead: boolean;
  isStarred: boolean;
  date: string;
  messageId?: string;
}

export interface MailFull extends MailRow { bodyText: string; bodyHtml: string }

type Phase = 'idle' | 'loading' | 'ready' | 'error';

interface State {
  accounts: Account[];
  accountsPhase: Phase;
  accountId: string | null;
  boxes: Box[];
  /** Список папок не пришёл: без этого экран молча показывал одни «Входящие». 'password' — пароль
   *  ящика нужно ввести заново (сервер не может его расшифровать), 'server' — почтовый сервер. */
  boxesError: false | 'password' | 'server';
  folder: string;
  lists: Record<string, MailRow[]>;
  listPhase: Record<string, Phase>;
  syncing: Record<string, boolean>;
  full: Record<string, MailFull>;
  search: string;
  found: MailRow[] | null;
}

export const useMail = create<State>(() => ({
  accounts: [], accountsPhase: 'idle', accountId: null, boxes: [], boxesError: false, folder: 'INBOX',
  lists: {}, listPhase: {}, syncing: {}, full: {}, search: '', found: null,
}));
const set = useMail.setState;
const get = useMail.getState;

/** id вошедшего пользователя — единый источник: shared/session. */
export { myId } from '@/shared/session/session';
import { myId } from '@/shared/session/session';

/** Ошибка запроса почты со статусом: 409 — пароль ящика нужно ввести заново. */
export class MailError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', ...init });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.detail || ''; } catch { /* не JSON */ }
    throw new MailError(detail || String(res.status), res.status);
  }
  return (await res.json()) as T;
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// ── Кэш: папка открывается мгновенно ────────────────────────────────────────

const cacheKey = (acc: string, folder: string) => `nxmail:v1:${acc}:${folder}`;
function readCache(acc: string, folder: string): MailRow[] | null {
  try { return JSON.parse(localStorage.getItem(cacheKey(acc, folder)) || 'null'); } catch { return null; }
}
function writeCache(acc: string, folder: string, rows: MailRow[]) {
  try { localStorage.setItem(cacheKey(acc, folder), JSON.stringify(rows.slice(0, 100))); } catch { /* переполнено */ }
}

// ── Загрузка ────────────────────────────────────────────────────────────────

export async function loadAccounts(): Promise<void> {
  set({ accountsPhase: get().accounts.length ? 'ready' : 'loading' });
  try {
    const accounts = await call<Account[]>(`/api/mail/accounts?userId=${encodeURIComponent(myId())}`);
    let accountId = get().accountId;
    try { accountId = accountId || localStorage.getItem('nxmail:account'); } catch { /* ignore */ }
    if (!accounts.some((a) => String(a.id) === accountId)) accountId = accounts[0] ? String(accounts[0].id) : null;
    set({ accounts, accountId, accountsPhase: 'ready' });
    listen();
  } catch {
    set({ accountsPhase: 'error' });
  }
}

/** Подключить ящик (или обновить настройки). Пароль при правке пустой — не менять. */
export async function saveAccount(id: string | null, form: AccountForm): Promise<Account> {
  const body: Record<string, unknown> = { ...form };
  if (id && !form.password) { delete body.password; body.skipPassword = true; }
  const saved = await call<Account>(id ? `/api/mail/accounts/${encodeURIComponent(id)}` : '/api/mail/accounts', json(id ? 'PUT' : 'POST', body));
  await loadAccounts();
  if (!id) { selectAccount(String(saved.id)); void loadBoxes(); }
  // Новый пароль (в том числе после «нужно ввести заново») — сразу перечитать папки и входящие.
  else if (id === get().accountId) { set({ boxesError: false }); void loadBoxes(true); void syncFolder('INBOX'); }
  return saved;
}

export async function removeAccount(id: string): Promise<void> {
  await call(`/api/mail/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const rest = get().accounts.filter((a) => String(a.id) !== id);
  set({ accounts: rest, accountId: get().accountId === id ? (rest[0] ? String(rest[0].id) : null) : get().accountId });
}

export function selectAccount(id: string) {
  try { localStorage.setItem('nxmail:account', id); } catch { /* ignore */ }
  set({ accountId: id, boxes: [], boxesError: false, lists: {}, listPhase: {}, full: {}, folder: 'INBOX', found: null, search: '' });
}

export async function loadBoxes(refresh = false): Promise<void> {
  const acc = get().accountId;
  if (!acc) return;
  try {
    const qs = new URLSearchParams({ accountId: acc, userId: myId(), ...(refresh ? { refresh: 'true' } : {}) });
    const boxes = await call<Box[]>(`/api/mail/mailboxes?${qs}`);
    if (get().accountId === acc) set({ boxes, boxesError: false });
  } catch (e) {
    // прежний список, если был, остаётся
    if (get().accountId === acc) set({ boxesError: e instanceof MailError && e.status === 409 ? 'password' : 'server' });
  }
}

export async function loadFolder(folder: string): Promise<void> {
  const acc = get().accountId;
  if (!acc) return;
  if (!get().lists[folder]) {
    const cached = readCache(acc, folder);
    set((s) => ({ lists: { ...s.lists, [folder]: cached || [] }, listPhase: { ...s.listPhase, [folder]: cached ? 'ready' : 'loading' } }));
  }
  try {
    const qs = new URLSearchParams({ accountId: acc, folder, limit: '150', light: 'true', userId: myId() });
    const rows = await call<MailRow[]>(`/api/mail/messages?${qs}`);
    if (get().accountId !== acc) return;
    set((s) => ({ lists: { ...s.lists, [folder]: rows }, listPhase: { ...s.listPhase, [folder]: 'ready' } }));
    writeCache(acc, folder, rows);
  } catch {
    set((s) => ({ listPhase: { ...s.listPhase, [folder]: (s.lists[folder]?.length ? 'ready' : 'error') } }));
  }
}

/** Забрать папку с почтового сервера и перечитать. Для входящих это страховка:
 *  их держит сервер сам. */
export async function syncFolder(folder: string): Promise<void> {
  const acc = get().accountId;
  if (!acc || get().syncing[folder]) return;
  set((s) => ({ syncing: { ...s.syncing, [folder]: true } }));
  try {
    await call('/api/mail/sync', json('POST', { accountId: acc, userId: myId(), folder })).catch(() => null);
    await loadFolder(folder);
  } finally {
    set((s) => ({ syncing: { ...s.syncing, [folder]: false } }));
  }
}

export function openFolder(folder: string) {
  set({ folder, found: null, search: '' });
  void loadFolder(folder).then(() => syncFolder(folder));
}

export async function openMessage(id: string): Promise<MailFull | null> {
  let full = get().full[id];
  if (!full) {
    try {
      full = await call<MailFull>(`/api/mail/messages/${encodeURIComponent(id)}`);
      set((s) => ({ full: { ...s.full, [id]: full! } }));
    } catch {
      return null;
    }
  }
  // Отметка «прочитано» откатится сама, если сервер не ответил; открытие письма от неё не зависит.
  if (!full.isRead) setFlags(id, { isRead: true }).catch(() => {});
  return full;
}

/** Подгрузить письма заранее (соседей открытого) — без отметки «прочитано»: при листании
 *  следующее письмо уже на месте и открывается без ожидания сервера. */
const prefetching = new Set<string>();
export function prefetchMessages(ids: string[]): void {
  for (const id of ids) {
    if (!id || get().full[id] || prefetching.has(id)) continue;
    prefetching.add(id);
    call<MailFull>(`/api/mail/messages/${encodeURIComponent(id)}`)
      .then((full) => set((s) => (s.full[id] ? s : { full: { ...s.full, [id]: full } })))
      .catch(() => { /* откроется обычным путём */ })
      .finally(() => prefetching.delete(id));
  }
}

export async function searchMail(q: string): Promise<void> {
  const acc = get().accountId;
  set({ search: q });
  if (!acc || !q.trim()) { set({ found: null }); return; }
  try {
    const qs = new URLSearchParams({ accountId: acc, folder: get().folder, limit: '100', light: 'true', search: q.trim(), userId: myId() });
    const rows = await call<MailRow[]>(`/api/mail/messages?${qs}`);
    if (get().search === q) set({ found: rows });
  } catch { /* останется прежний результат */ }
}

// ── Действия ────────────────────────────────────────────────────────────────

function patchRow(id: string, patch: Partial<MailRow>) {
  set((s) => {
    const lists: Record<string, MailRow[]> = {};
    for (const [f, rows] of Object.entries(s.lists)) lists[f] = rows.map((r) => (r.id === id ? { ...r, ...patch } : r));
    const full = s.full[id] ? { ...s.full, [id]: { ...s.full[id], ...patch } } : s.full;
    const found = s.found ? s.found.map((r) => (r.id === id ? { ...r, ...patch } : r)) : s.found;
    return { lists, full, found };
  });
}

function bumpUnread(folder: string, delta: number) {
  set((s) => ({ boxes: s.boxes.map((b) => (b.folder === folder ? { ...b, unread: Math.max(0, b.unread + delta) } : b)) }));
}

/** Прочитано / звезда: сразу на экране, затем на сервере (и на почтовом). */
export async function setFlags(id: string, flags: { isRead?: boolean; isStarred?: boolean }): Promise<void> {
  const row = Object.values(get().lists).flat().find((r) => r.id === id) || get().full[id];
  const before = row ? { isRead: row.isRead, isStarred: row.isStarred } : null;
  patchRow(id, flags);
  if (row && flags.isRead !== undefined && flags.isRead !== row.isRead) bumpUnread(row.folder, flags.isRead ? -1 : 1);
  try {
    await call(`/api/mail/messages/${encodeURIComponent(id)}`, json('PUT', flags));
  } catch (e) {
    if (before) {
      patchRow(id, before);
      if (row && flags.isRead !== undefined && flags.isRead !== before.isRead) bumpUnread(row.folder, flags.isRead ? 1 : -1);
    }
    throw e;
  }
}

/** В корзину / архив / спам / входящие — на почтовом сервере. */
export async function moveMessage(id: string, to: Box['role']): Promise<void> {
  const before = get().lists;
  const row = Object.values(before).flat().find((r) => r.id === id);
  set((s) => {
    const lists: Record<string, MailRow[]> = {};
    for (const [f, rows] of Object.entries(s.lists)) lists[f] = rows.filter((r) => r.id !== id);
    return { lists, found: s.found ? s.found.filter((r) => r.id !== id) : s.found };
  });
  if (row && !row.isRead) bumpUnread(row.folder, -1);
  try {
    await call(`/api/mail/messages/${encodeURIComponent(id)}/move`, json('POST', { to, userId: myId() }));
  } catch (e) {
    set({ lists: before });
    if (row && !row.isRead) bumpUnread(row.folder, 1);
    throw e;
  }
  void loadBoxes();
}

export interface Outgoing {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  bodyHtml: string;
  replyToMessageId?: string;
  attachments: { url: string; filename: string; size: number; mimeType?: string }[];
}

export async function sendMail(m: Outgoing): Promise<void> {
  const acc = get().accountId;
  if (!acc) throw new Error('Нет ящика');
  await call('/api/mail/send', json('POST', { ...m, accountId: acc, userId: myId() }));
  const sent = get().boxes.find((b) => b.role === 'sent');
  // Копия в «Отправленные» ложится на сервере фоном и придёт mail_changed.
  if (sent && get().folder === sent.folder) void loadFolder(sent.folder);
}

export async function recipients(q: string): Promise<Addr[]> {
  const acc = get().accountId;
  if (!acc) return [];
  try {
    return await call<Addr[]>(`/api/mail/recipients?accountId=${encodeURIComponent(acc)}&q=${encodeURIComponent(q)}`);
  } catch { return []; }
}

// ── Сокет ───────────────────────────────────────────────────────────────────

let listening = false;
const newListeners = new Set<(e: RealtimeEvent) => void>();
export function onNewMail(fn: (e: RealtimeEvent) => void): () => void {
  newListeners.add(fn);
  return () => { newListeners.delete(fn); };
}

function listen() {
  if (listening) return;
  listening = true;
  realtime.subscribe((e: RealtimeEvent) => {
    const acc = get().accountId;
    if (e.type === 'resync') {
      if (acc) { void syncFolder('INBOX'); void loadBoxes(); if (get().folder !== 'INBOX') void loadFolder(get().folder); }
      return;
    }
    if (e.type !== 'mail_new' && e.type !== 'mail_changed') return;
    if (!acc || String(e.accountId || '') !== acc) return;
    const folder = String(e.folder || 'INBOX');
    void loadFolder(folder);
    void loadBoxes();
    if (e.type === 'mail_new') for (const fn of newListeners) fn(e);
  });
}
