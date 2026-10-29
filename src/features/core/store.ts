import { create } from 'zustand';
import { coreApi, type SendPayload, type CoreCatalog, type CoreMessage, type CoreThread } from './api';

/**
 * Состояние «Ядра»: чаты и сообщения открытых чатов. Источник правды — сервер; живые события (сокет) и
 * ответы на запросы сливаются сюда одной функцией upsert, поэтому порядок прихода не важен.
 */
interface ThreadLog {
  messages: CoreMessage[];
  hasMore: boolean;
  loaded: boolean;
  loadingOlder: boolean;
}

interface State {
  catalog: CoreCatalog | null;
  /** 403 — «Ядро» человеку не включено; иначе текст ошибки загрузки. */
  denied: boolean;
  error: string;
  threads: CoreThread[] | null;
  archived: CoreThread[] | null;
  logs: Record<string, ThreadLog>;
}

export const useCore = create<State>(() => ({ catalog: null, denied: false, error: '', threads: null, archived: null, logs: {} }));

const byUpdated = (a: CoreThread, b: CoreThread) => b.updatedAt.localeCompare(a.updatedAt);
const byCreated = (a: CoreMessage, b: CoreMessage) => a.createdAt.localeCompare(b.createdAt);

function fail(cause: unknown) {
  const status = (cause as { status?: number }).status;
  useCore.setState(status === 403 ? { denied: true } : { error: cause instanceof Error ? cause.message : String(cause) });
}

export async function loadAll() {
  try {
    const [catalog, threads] = await Promise.all([coreApi.catalog(), coreApi.threads(false)]);
    useCore.setState({ catalog, threads, denied: false, error: '' });
  } catch (cause) { fail(cause); }
}

export async function loadArchived() {
  try { useCore.setState({ archived: await coreApi.threads(true) }); } catch (cause) { fail(cause); }
}

/** Чат пришёл с сервера (ответ или сокет): встаёт в свой список, из другого уходит (архив ↔ активные). */
export function upsertThread(thread: CoreThread) {
  useCore.setState((s) => {
    const strip = (list: CoreThread[] | null) => (list ? list.filter((t) => t.id !== thread.id) : list);
    const active = strip(s.threads);
    const archived = strip(s.archived);
    return thread.archived
      ? { threads: active, archived: archived ? [thread, ...archived].sort(byUpdated) : archived }
      : { threads: [thread, ...(active ?? [])].sort(byUpdated), archived };
  });
}

export function upsertMessage(message: CoreMessage) {
  useCore.setState((s) => {
    const log = s.logs[message.threadId];
    if (!log) return s; // чат не открывали — придёт целиком при открытии
    const rest = log.messages.filter((m) => m.id !== message.id);
    return { logs: { ...s.logs, [message.threadId]: { ...log, messages: [...rest, message].sort(byCreated) } } };
  });
}

export async function loadMessages(threadId: string) {
  const current = useCore.getState().logs[threadId];
  if (current?.loaded) return;
  try {
    const page = await coreApi.messages(threadId);
    useCore.setState((s) => {
      // Пока грузили, могли прийти живые сообщения — не теряем их.
      const live = (s.logs[threadId]?.messages ?? []).filter((m) => !page.messages.some((p) => p.id === m.id));
      return { logs: { ...s.logs, [threadId]: { messages: [...page.messages, ...live].sort(byCreated), hasMore: page.hasMore, loaded: true, loadingOlder: false } } };
    });
  } catch (cause) { fail(cause); }
}

export async function loadOlder(threadId: string) {
  const log = useCore.getState().logs[threadId];
  if (!log || !log.hasMore || log.loadingOlder || !log.messages.length) return;
  useCore.setState((s) => ({ logs: { ...s.logs, [threadId]: { ...log, loadingOlder: true } } }));
  try {
    const page = await coreApi.messages(threadId, log.messages[0].createdAt);
    useCore.setState((s) => {
      const now = s.logs[threadId] ?? log;
      const known = new Set(now.messages.map((m) => m.id));
      return { logs: { ...s.logs, [threadId]: { ...now, messages: [...page.messages.filter((m) => !known.has(m.id)), ...now.messages], hasMore: page.hasMore, loadingOlder: false } } };
    });
  } catch (cause) {
    useCore.setState((s) => ({ logs: { ...s.logs, [threadId]: { ...(s.logs[threadId] ?? log), loadingOlder: false } } }));
    fail(cause);
  }
}

/** Неотправленное — для «Повторить»: тот же id, сервер второй раз не запишет. */
const unsent = new Map<string, { threadId: string; payload: SendPayload; preview: Partial<CoreMessage['props']> }>();

export function retryMessage(id: string) {
  const item = unsent.get(id);
  if (item) void sendMessage(item.threadId, item.payload, item.preview);
}

/** Отправить: пузырь появляется сразу («отправляется…»), сервер подтверждает тем же id. */
export async function sendMessage(threadId: string, payload: SendPayload, preview: Partial<CoreMessage['props']> = {}) {
  unsent.set(payload.id, { threadId, payload, preview });
  const local: CoreMessage = {
    id: payload.id, threadId, role: 'user', actor: '', body: payload.body, status: 'done', createdAt: new Date().toISOString(),
    props: { ...preview }, local: 'sending',
  };
  useCore.setState((s) => {
    const log = s.logs[threadId] ?? { messages: [], hasMore: false, loaded: true, loadingOlder: false };
    return { logs: { ...s.logs, [threadId]: { ...log, messages: [...log.messages.filter((m) => m.id !== local.id), local] } } };
  });
  try {
    upsertMessage(await coreApi.send(threadId, payload));
    unsent.delete(payload.id);
    return true;
  } catch {
    upsertMessage({ ...local, local: 'failed' });
    return false;
  }
}

export async function createThread(title = '') {
  const thread = await coreApi.createThread(title);
  upsertThread(thread);
  useCore.setState((s) => ({ logs: { ...s.logs, [thread.id]: { messages: [], hasMore: false, loaded: true, loadingOlder: false } } }));
  return thread;
}

export async function patchThread(id: string, patch: { title?: string; archived?: boolean }) {
  upsertThread(await coreApi.patchThread(id, patch));
}
