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
  /** Агент сейчас отвечает в этом чате. */
  working?: boolean;
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
  rateLimit?: { provider?: string; wait_seconds?: number; resets_at?: number; used_percent?: number; detail?: string; status?: string };
  failed?: boolean;
  /** Вопрос агента: confirm — да/нет, choice — один вариант, multi — несколько. */
  ask?: { kind: 'confirm' | 'choice' | 'multi' | 'permission'; question?: string; approvalId?: string; tool?: string };
  actions?: CoreAction[];
  /** Что ответили на вопрос. */
  answered?: string;
  /** Кто отвечает: gemini | claude | codex. */
  provider?: string;
  replyTo?: { id: string; actor: string; text: string };
  attachments?: CoreAttachment[];
  context?: CoreContextItem[];
  forwarded?: Array<{ author: string; text: string; at: string; files: string[] }>;
  /** Служебная пометка для агента (ответ на разрешение) — человеку не показываем. */
  agentNote?: string;
}

/** Что открыто у человека — агенту («где я»). */
export interface CoreContextItem { kind: string; title: string; id?: string; url?: string }

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

/** Окно лимита подписки (Claude): five_hour, seven_day…; used — %, resetsAt — unix-секунды. */
export interface CoreLimit { type: string; used: number; resetsAt: number; status: string; overage?: boolean }

export interface CoreAgent { id: string; name: string; model: string; models: Array<{ id: string; label: string }>; online: boolean; limits?: CoreLimit[] }

export interface CoreCatalog {
  /** Подключённые агенты человека (Настройки → Ядро): первый — по умолчанию. */
  agents: CoreAgent[];
  models: Array<{ id: string; label: string }>;
  efforts: Array<{ id: string; label: string; hint?: string }>;
  /** Демо-ответ (/demo) — у админа, пока агентов нет. */
  demo: boolean;
  /** Режим разрешений человека и все режимы (permissions.py). */
  mode?: string;
  modes?: Array<{ id: string; label: string; hint: string }>;
}

export interface SendPayload {
  id: string;
  body: string;
  replyTo?: string;
  attachments?: Array<Pick<CoreAttachment, 'name' | 'key' | 'size' | 'type'>>;
  effort?: string;
  /** Агент и модель: «claude» или «claude:opus». */
  model?: string;
  context?: CoreContextItem[];
  /** Пересланное из чатов (только текст): «Переслать агенту». */
  forwarded?: Array<{ author: string; text: string; at: string; files: string[] }>;
}

// ── подключения (Настройки → Ядро) ───────────────────────────────────────────

export type ProviderId = 'gemini' | 'claude' | 'codex';

export interface CoreAccount {
  provider: ProviderId;
  label: string;
  vendor: string;
  /** key — по ключу (Gemini), login — вход в подписку на ноде. */
  how: 'key' | 'login';
  state: 'none' | 'pending' | 'ready';
  account: string;
  model: string;
  models: Array<{ id: string; label: string }>;
  keyHint: string;
  nodeOnline: boolean;
  error: string;
  login: { state?: 'starting' | 'waiting' | 'verifying'; url?: string; code?: string; message?: string; needsCode?: boolean };
  limits?: CoreLimit[];
}

export interface CoreUsageRow { userId: string; name?: string; provider: ProviderId; runs: number; inputTokens: number; cachedTokens: number; outputTokens: number; costUsd: number; lastDay: string }

export interface CoreAccounts {
  accounts: CoreAccount[];
  node: { online: boolean; clis: string[] };
  usage: CoreUsageRow[];
  /** Режим разрешений агента: auto | careful | ask. */
  mode: string;
  modes: Array<{ id: string; label: string; hint: string }>;
}

export interface CoreNote { id: string; text: string; tags: string[]; by: string; shared: boolean; mine: boolean; at: string }
export interface CoreSkill { name: string; description: string; enabled: boolean; uses: number; by: string; shared: boolean; mine: boolean; updatedAt: string; size: number }
export interface CoreMemory { profile: string; notes: CoreNote[]; skills: CoreSkill[]; canModerate: boolean }

/** Личный MCP-сервер агентов (секреты — только имена ключей). */
export interface CoreMcpServer { name: string; kind: 'http' | 'npm'; url: string; package: string; args: string[]; secretKeys: string[]; note: string; enabled: boolean; addedBy: string; updatedAt: string | null }

export interface CoreIntegration {
  service: string; label: string; kind: 'builtin' | 'custom'; baseUrl: string; docs: string; hint: string; configured: boolean;
  /** Кому открыт: id людей или «*» — всем. */
  access: string[];
  authType?: string; authName?: string;
  fields: Array<{ key: string; label: string; secret: boolean; optional: boolean; filled: boolean; value: string }>;
}

export interface CoreNode { id: string; name: string; start: string; online: boolean; enabled: boolean; lastSeen: string | null; users: number; createdAt: string;
  info: { version?: string; host?: string; clis?: Record<string, string>; running?: number } }

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

  accounts: () => call<CoreAccounts>('/api/core/accounts'),
  setGeminiKey: (key: string) => call<CoreAccounts>('/api/core/accounts/gemini', { method: 'PUT', json: { key } }),
  setModel: (provider: ProviderId, model: string) => call<CoreAccounts>(`/api/core/accounts/${provider}`, { method: 'PATCH', json: { model } }),
  login: (provider: ProviderId) => call<CoreAccounts>(`/api/core/accounts/${provider}/login`, { method: 'POST' }),
  loginCode: (provider: ProviderId, code: string) => call<CoreAccounts>(`/api/core/accounts/${provider}/login/code`, { method: 'POST', json: { code } }),
  cancelLogin: (provider: ProviderId) => call<CoreAccounts>(`/api/core/accounts/${provider}/login`, { method: 'DELETE' }),
  /** Спросить у провайдера текущие окна лимита подписки (пока только Claude); ответ придёт событием core_account. */
  checkLimits: (provider: ProviderId) => call<{ queued: boolean }>(`/api/core/accounts/${provider}/limits`, { method: 'POST' }),
  disconnect: (provider: ProviderId) => call<CoreAccounts>(`/api/core/accounts/${provider}`, { method: 'DELETE' }),
  setMode: (mode: string) => call<CoreAccounts>('/api/core/settings', { method: 'PUT', json: { mode } }),
  usage: (days = 30, all = false) => call<{ usage: CoreUsageRow[] }>(`/api/core/usage?days=${days}${all ? '&all=1' : ''}`),

  memory: () => call<CoreMemory>('/api/core/memory'),
  saveProfile: (text: string) => call<{ profile: string }>('/api/core/memory/profile', { method: 'PUT', json: { text } }),
  forgetNote: (id: string) => call<{ ok: boolean }>(`/api/core/memory/notes/${enc(id)}`, { method: 'DELETE' }),
  skill: (name: string) => call<{ skill: CoreSkill & { body: string } }>(`/api/core/memory/skills/${enc(name)}`).then((r) => r.skill),
  saveSkill: (name: string, patch: { description?: string; body?: string; enabled?: boolean; shared?: boolean }) =>
    call<{ skills: CoreSkill[] }>(`/api/core/memory/skills/${enc(name)}`, { method: 'PUT', json: patch }).then((r) => r.skills),
  deleteSkill: (name: string, shared = false) =>
    call<{ skills: CoreSkill[] }>(`/api/core/memory/skills/${enc(name)}${shared ? '?shared=1' : ''}`, { method: 'DELETE' }).then((r) => r.skills),

  integrations: () => call<{ integrations: CoreIntegration[]; authTypes: Record<string, string> }>('/api/core/integrations'),
  saveIntegration: (service: string, body: Partial<{ fields: Record<string, string>; label: string; base_url: string; auth_type: string; auth_name: string; notes: string; secret: string; access: string[] }>) =>
    call<{ integrations: CoreIntegration[] }>(`/api/core/integrations/${enc(service)}`, { method: 'PUT', json: body }).then((r) => r.integrations),
  deleteIntegration: (service: string) => call<{ integrations: CoreIntegration[] }>(`/api/core/integrations/${enc(service)}`, { method: 'DELETE' }).then((r) => r.integrations),
  testIntegration: (service: string) => call<{ ok: boolean; message: string }>(`/api/core/integrations/${enc(service)}/test`, { method: 'POST' }),

  myIntegrations: () => call<{ integrations: Array<{ service: string; label: string; hint: string; docs: string; kind: string }> }>('/api/core/integrations/mine').then((r) => r.integrations),
  mcpServers: () => call<{ servers: CoreMcpServer[] }>('/api/core/mcp-servers').then((r) => r.servers),
  saveMcpServer: (name: string, body: Partial<{ kind: 'http' | 'npm'; url: string; package: string; args: string[]; headers: Record<string, string>; env: Record<string, string>; enabled: boolean; note: string }>) =>
    call<{ servers: CoreMcpServer[] }>(`/api/core/mcp-servers/${enc(name)}`, { method: 'PUT', json: body }).then((r) => r.servers),
  deleteMcpServer: (name: string) => call<{ servers: CoreMcpServer[] }>(`/api/core/mcp-servers/${enc(name)}`, { method: 'DELETE' }).then((r) => r.servers),

  nodes: () => call<{ nodes: CoreNode[] }>('/api/core/nodes').then((r) => r.nodes),
  createNode: (name: string) => call<{ node: CoreNode; token: string; command: string }>('/api/core/nodes', { method: 'POST', json: { name } }),
  reissueNode: (id: string) => call<{ node: CoreNode; token: string; command: string }>(`/api/core/nodes/${enc(id)}/token`, { method: 'POST' }),
  deleteNode: (id: string) => call<{ ok: boolean }>(`/api/core/nodes/${enc(id)}`, { method: 'DELETE' }),
};
