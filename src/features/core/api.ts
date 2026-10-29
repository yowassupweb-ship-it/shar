/** «Ядро» — чат с агентами. Сервер: server/app/modules/core_chat/router.py. */

export interface CoreThread {
  id: string;
  title: string;
  customTitle: boolean;
  peer: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  messages: number;
  lastText: string;
  lastRole: string;
  lastWork: CoreWork | null;
}

/** Шаг работы агента: вызов инструмента (с аргументами и результатом) или реплика между шагами. */
export interface CoreStep {
  kind: 'tool' | 'text';
  name?: string;
  hint?: string;
  input?: string;
  output?: string;
  is_error?: boolean;
  ms?: number;
  text?: string;
}

/** Сколько стоила работа: токены, время, загрузка контекста. Денег нет намеренно — агенты работают по подписке. */
export interface CoreWork {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  total_tokens?: number;
  duration_ms?: number;
  turns?: number;
  context_tokens?: number;
  context_window?: number;
}

export interface CoreAttachment { name: string; key: string; url: string; size: number; type: string }
export interface CoreAction { label: string; value: string }

export interface CoreProps {
  steps?: CoreStep[];
  /** Что агент делает прямо сейчас — строка у «думает…». */
  phase?: string;
  reasoning?: string[];
  model?: string;
  effort?: string;
  work?: CoreWork;
  rateLimit?: { provider?: string; wait_seconds?: number; used_percent?: number; detail?: string };
  failed?: boolean;
  /** Вопрос агента: confirm — да/нет, choice — один вариант, multi — несколько. */
  ask?: { kind: 'confirm' | 'choice' | 'multi' };
  actions?: CoreAction[];
  /** Что ответили на вопрос. */
  answered?: string;
  replyTo?: { id: string; actor: string; text: string };
  attachments?: CoreAttachment[];
  context?: Array<{ kind: string; title: string; id?: string }>;
}

export type CoreStatus = 'queued' | 'working' | 'done' | 'failed' | 'cancelled';

export interface CoreMessage {
  id: string;
  threadId: string;
  role: 'user' | 'agent' | 'system';
  actor: string;
  body: string;
  props: CoreProps;
  status: CoreStatus;
  createdAt: string;
  /** Только у своих, ещё не подтверждённых сервером. */
  local?: 'sending' | 'failed';
}

export interface CoreCatalog {
  agents: Array<{ id: string; name: string }>;
  models: Array<{ id: string; label: string }>;
  efforts: Array<{ id: string; label: string; hint?: string }>;
  /** Демо-ответ (/demo) — у админа, пока агентов нет. */
  demo: boolean;
}

export interface SendPayload {
  id: string;
  body: string;
  replyTo?: string;
  attachments?: Array<Pick<CoreAttachment, 'name' | 'key' | 'size' | 'type'>>;
  effort?: string;
  model?: string;
}

export class CoreError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const headers: Record<string, string> = { ...(rest.headers as Record<string, string> | undefined) };
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store', ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body });
  } catch {
    throw new CoreError(0, 'Нет связи с сервером');
  }
  if (!res.ok) {
    let message = res.statusText || String(res.status);
    try {
      const data = await res.json();
      message = data.detail || data.error || message;
    } catch { /* тело не JSON */ }
    if ((res.status === 404 || res.status === 405) && (message === 'Not Found' || message === 'Method Not Allowed')) {
      message = 'На сервере ещё нет «Ядра» — нужно обновить бэкенд Шара.';
    }
    throw new CoreError(res.status, typeof message === 'string' ? message : JSON.stringify(message));
  }
  return res.json() as Promise<T>;
}

const enc = encodeURIComponent;

export const coreApi = {
  catalog: () => call<CoreCatalog>('/api/core/catalog'),
  threads: (archived = false) => call<{ threads: CoreThread[] }>(`/api/core/threads?archived=${archived}`).then((r) => r.threads),
  createThread: (title = '') => call<{ thread: CoreThread }>('/api/core/threads', { method: 'POST', json: { title } }).then((r) => r.thread),
  patchThread: (id: string, patch: { title?: string; archived?: boolean }) =>
    call<{ thread: CoreThread }>(`/api/core/threads/${enc(id)}`, { method: 'PATCH', json: patch }).then((r) => r.thread),
  messages: (threadId: string, before?: string) =>
    call<{ messages: CoreMessage[]; hasMore: boolean }>(`/api/core/threads/${enc(threadId)}/messages${before ? `?before=${enc(before)}` : ''}`),
  send: (threadId: string, payload: SendPayload) =>
    call<{ message: CoreMessage }>(`/api/core/threads/${enc(threadId)}/messages`, { method: 'POST', json: payload }).then((r) => r.message),
  answer: (messageId: string, value: string) =>
    call<{ message: CoreMessage }>(`/api/core/messages/${enc(messageId)}/answer`, { method: 'POST', json: { value } }).then((r) => r.message),
  cancel: (messageId: string) => call<{ message: CoreMessage }>(`/api/core/messages/${enc(messageId)}/cancel`, { method: 'POST' }).then((r) => r.message),
};
