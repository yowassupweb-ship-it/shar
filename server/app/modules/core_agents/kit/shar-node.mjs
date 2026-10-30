#!/usr/bin/env node
// Нода «Ядра» Шара: личные агенты сотрудников (Claude Code, Codex, Gemini CLI) на сервере компании.
//
// Нода сама звонит в Шар — длинный опрос POST /api/core/node/poll (держит до 25 с, пока нет работы), так что ей не
// нужен белый адрес. Задачи:
//   run          ответить в чате «Ядра»: запустить CLI провайдера, поток событий → шаги, текст, ход работы, лимиты
//   login        войти в подписку человека (claude auth login / codex login --device-auth) в его личном каталоге
//   login_code   код со страницы входа Claude → в идущий вход
//   login_cancel / logout
// Каталог человека — <SHAR_NODE_HOME>/users/<id>: там его вход в подписки, сессии CLI и рабочая папка. Учётные данные
// подписок с ноды никуда не уходят. Инструменты Шара агент получает по MCP с ключом на один запуск (выдаёт Шар).
//
// Без зависимостей: Node.js 20+. Окружение: SHAR_URL, SHAR_NODE_TOKEN, SHAR_NODE_HOME (по умолчанию ~/shar-node),
// SHAR_NODE_PARALLEL (4), SHAR_NODE_SHARED_HOME=1 — для разработки: CLI работают под входом этой машины.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const VERSION = "1.0.0";
const SHAR_URL = String(process.env.SHAR_URL || "").replace(/\/+$/, "");
const TOKEN = String(process.env.SHAR_NODE_TOKEN || "");
const ROOT = process.env.SHAR_NODE_HOME || path.join(os.homedir(), "shar-node");
const SHARED_HOME = process.env.SHAR_NODE_SHARED_HOME === "1";
const PARALLEL = Math.max(1, Number(process.env.SHAR_NODE_PARALLEL) || 4);
const CLI = {
  claude: process.env.CLAUDE_COMMAND || "claude",
  codex: process.env.CODEX_COMMAND || "codex",
  gemini: process.env.GEMINI_COMMAND || "gemini",
};
const RUN_TIMEOUT_MS = 30 * 60_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
// Раздутая сессия дороже новой: каждый шаг пересылает весь контекст. Сначала сжимаем (/compact), потом — заново.
// Пороги — как у наблюдателей MBOX (scripts/chat-threads.mjs), проверены там на живых чатах.
const COMPACT_AT = 80_000;
const ROTATE_AT = 120_000;
const MAX_STEP_TEXT = 1500;
const MAX_STEP_INPUT = 1200;
const MAX_STEP_OUTPUT = 2500;
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

if (!SHAR_URL || !TOKEN) {
  console.error("Нужны SHAR_URL и SHAR_NODE_TOKEN (Админка → Ядро → Ноды)");
  process.exit(2);
}

// ── связь с Шаром ────────────────────────────────────────────────────────────

async function shar(pathname, body, timeoutMs = 40_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${SHAR_URL}${pathname}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`Шар ${res.status}: ${data.detail || data.error || res.statusText}`), { status: res.status });
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** События задачи копятся и уходят пачкой не чаще раза в 700 мс; итог (done/failed) — сразу. */
function reporter(job, onStop) {
  let queue = [];
  let timer = null;
  let sending = Promise.resolve();
  const flush = () => {
    timer = null;
    if (!queue.length) return sending;
    const events = queue;
    queue = [];
    sending = sending.then(async () => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          const res = await shar(`/api/core/node/jobs/${job.id}/events`, { events });
          if (res.stop) onStop?.();
          return;
        } catch (error) {
          if (error.status === 404) return onStop?.();
          await sleep(1000 * (attempt + 1));
        }
      }
      log(`задача ${job.id}: события не дошли до Шара`);
    });
    return sending;
  };
  return {
    send(event) {
      // Подряд идущий прогресс сливается: важно последнее состояние, а не каждый кадр.
      const last = queue[queue.length - 1];
      if (event.type === "progress" && last?.type === "progress") queue[queue.length - 1] = { ...last, ...event };
      else queue.push(event);
      if (event.type === "done" || event.type === "failed" || event.type === "login") return flush();
      if (!timer) timer = setTimeout(flush, 700);
      return sending;
    },
    flush,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clip = (value, limit) => {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};
const stringify = (value) => (typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 1));

// ── запуск CLI ───────────────────────────────────────────────────────────────

/** Аргумент для cmd.exe: на Windows CLI из npm — это .cmd, запускаются только через cmd. Аргументы у нас простые
 *  (флаги, пути, модели) — длинный текст и секреты идут через stdin и файлы, так что хватает кавычек. */
function winQuote(arg) {
  const value = String(arg);
  if (/[&|<>^%!"]/.test(value)) throw new Error(`Недопустимый аргумент CLI: ${value.slice(0, 40)}`);
  return value === "" || /[\s,;=()]/.test(value) ? `"${value}"` : value;
}

function run(command, args, { env, cwd, stdin = null, pty = false } = {}) {
  const options = { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true };
  if (process.platform === "win32") {
    const line = [command, ...args].map(winQuote).join(" ");
    const child = spawn("cmd.exe", ["/d", "/s", "/c", `"${line}"`], { ...options, windowsVerbatimArguments: true });
    if (stdin !== null) child.stdin.end(stdin);
    return child;
  }
  // Вход в CLI ждёт терминал: `script` даёт ему псевдотерминал без лишних зависимостей.
  const child = pty
    ? spawn("script", ["-qfec", [command, ...args].map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`).join(" "), "/dev/null"], options)
    : spawn(command, args, options);
  if (stdin !== null) child.stdin.end(stdin);
  return child;
}

/** Короткая команда целиком: { code, out }. */
function exec(command, args, opts = {}, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = run(command, args, opts);
    } catch (error) {
      return resolve({ code: -1, out: String(error.message || error) });
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: -1, out: String(error.message || error) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, out }); });
  });
}

const stripAnsi = (text) => String(text || "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\r/g, "");

async function detectClis() {
  const found = {};
  for (const [provider, command] of Object.entries(CLI)) {
    const res = await exec(command, ["--version"], {}, 30_000);
    const version = stripAnsi(res.out).trim().split("\n").pop();
    if (res.code === 0 && version) found[provider] = version.slice(0, 60);
  }
  browser = findObscura();
  return found;
}

// Браузер для агентов — Obscura (MCP по stdio): страницы, формы, скриншоты. Ставит его установщик ноды; нет — агенты
// работают без браузера (поиск и чтение страниц у CLI свои).
let browser = "";
function findObscura() {
  const candidates = [process.env.OBSCURA_COMMAND, "/opt/shar-node/bin/obscura"].filter(Boolean);
  return candidates.find((file) => { try { return fs.statSync(file).isFile(); } catch { return false; } }) || "";
}

// ── каталог человека ─────────────────────────────────────────────────────────

function userDirs(userId) {
  const safe = String(userId).replace(/[^A-Za-z0-9_-]/g, "_");
  const base = path.join(ROOT, "users", safe);
  const home = SHARED_HOME ? os.homedir() : path.join(base, "home");
  const dirs = { base, home, work: path.join(base, "work"), runs: path.join(base, "runs"), codexHome: SHARED_HOME ? path.join(os.homedir(), ".codex") : path.join(base, "home", ".codex") };
  for (const dir of [dirs.work, dirs.runs, ...(SHARED_HOME ? [] : [dirs.home, dirs.codexHome])]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dirs;
}

function userEnv(dirs) {
  if (SHARED_HOME) return {};
  return { HOME: dirs.home, USERPROFILE: dirs.home, CODEX_HOME: dirs.codexHome, XDG_CONFIG_HOME: path.join(dirs.home, ".config") };
}

/** Секреты запуска — в файлы с правами 600 в каталоге человека, а не в командную строку (её видно в ps). */
function secretFile(dirs, name, text) {
  const file = path.join(dirs.runs, name);
  fs.writeFileSync(file, text, { mode: 0o600 });
  return file;
}

// Сессии CLI по чатам: { "<провайдер>:<чат>": { id, context } } — чтобы продолжать разговор, а не начинать заново.
function sessionsFile(dirs) { return path.join(dirs.base, "sessions.json"); }
function readSessions(dirs) { try { return JSON.parse(fs.readFileSync(sessionsFile(dirs), "utf8")); } catch { return {}; } }
function saveSession(dirs, key, value) {
  const all = readSessions(dirs);
  if (value) all[key] = value; else delete all[key];
  fs.writeFileSync(sessionsFile(dirs), JSON.stringify(all), { mode: 0o600 });
}

// ── ответ в чате ─────────────────────────────────────────────────────────────

const running = new Map(); // id задачи → { child, stop() }

function absolute(url) {
  return /^https?:\/\//.test(url || "") ? url : `${SHAR_URL}${url || ""}`;
}

function promptText(job, resumed) {
  const parts = [];
  if (!resumed && job.history?.length) {
    parts.push("## Разговор до этого\n" + job.history.map((m) => `${m.role === "user" ? "Человек" : m.actor || "Агент"}: ${m.text}`).join("\n\n"));
  }
  if (job.attachments?.length) {
    parts.push("## Вложения (скачать по ссылке)\n" + job.attachments.map((a) => `- ${a.name} (${a.type || "файл"}, ${a.size || 0} байт): ${absolute(a.url)}`).join("\n"));
  }
  parts.push(job.prompt || "");
  return parts.filter(Boolean).join("\n\n");
}

/** Состояние ответа, общее для всех провайдеров: цепочка шагов, текст, ход работы, лимит. */
function newState() {
  // limits — все окна лимита подписки, что прислал провайдер за ход (пятичасовое, недельное): Шар показывает их в шапке чата.
  return { steps: [], text: "", partial: "", work: {}, rateLimit: null, limits: {}, sessionId: "", failure: "", authExpired: false, contextTokens: 0, model: "" };
}

function limitFromText(text) {
  const line = String(text || "").split(/\r?\n/).find((l) => /(usage|session|rate) limit|hit your .*limit|limit reached|quota|resource.exhausted|429/i.test(l));
  return line ? line.trim().slice(0, 300) : "";
}

/** Ошибка провайдера часто приходит JSON-ом ({"error": {"message": …}}) — человеку нужен только текст. */
function humanError(text) {
  const raw = String(text || "").trim();
  if (!raw.startsWith("{")) return raw;
  try {
    const data = JSON.parse(raw);
    return String(data.error?.message || data.message || data.error || raw);
  } catch {
    return raw;
  }
}

function authProblem(text) {
  return /not logged in|please (run )?.*login|invalid api key|authentication|unauthori[sz]ed|401|oauth token has expired|re-?authenticate/i.test(String(text || ""));
}

async function runJob(job) {
  const dirs = userDirs(job.userId);
  const report = reporter(job, () => entry.stop());
  const entry = { child: null, stopped: false, stop() { this.stopped = true; try { this.child?.kill(); } catch { /* уже нет */ } } };
  running.set(job.id, entry);
  const startedAt = Date.now();
  try {
    if (/^\/compact\b/.test(job.prompt || "")) return await compactCommand(job, dirs, report);
    const key = `${job.provider}:${job.threadId}`;
    let session = readSessions(dirs)[key] || (job.resume ? { id: job.resume, context: 0 } : null);
    if (session && job.provider === "claude" && session.context > COMPACT_AT) {
      report.send({ type: "progress", phase: "сжимает контекст" });
      const compacted = await compactClaude(dirs, session.id, "");
      session = compacted ? { id: compacted, context: 20_000 } : null;
    }
    if (session && session.context > ROTATE_AT) session = null;
    let state;
    try {
      state = await runProvider(job, dirs, session?.id || "", report, entry);
    } catch (error) {
      if (!session || entry.stopped || !/session|conversation|thread|not found|No such/i.test(String(error.message))) throw error;
      log(`задача ${job.id}: сессия ${session.id} потеряна — начинаю заново`);
      state = await runProvider(job, dirs, "", report, entry);
    }
    if (entry.stopped) return;
    if (state.sessionId) {
      saveSession(dirs, key, { id: state.sessionId, context: state.contextTokens || state.work.input_tokens || 0 });
      await report.send({ type: "session", id: state.sessionId });
    }
    state.work.duration_ms = state.work.duration_ms || Date.now() - startedAt;
    if (state.failure) {
      await report.send({ type: "failed", error: state.failure, body: state.failure, steps: state.steps, work: state.work,
                          rateLimit: state.rateLimit, authExpired: state.authExpired, model: state.model, limits: Object.values(state.limits) });
    } else {
      // Последняя реплика цепочки и есть ответ — второй раз под ответом её не показываем.
      const steps = state.steps.length && state.steps[state.steps.length - 1].kind === "text" && state.text.startsWith(state.steps[state.steps.length - 1].text.replace(/…$/, ""))
        ? state.steps.slice(0, -1) : state.steps;
      await report.send({ type: "done", body: state.text || "(агент ничего не ответил)", steps, work: state.work, rateLimit: state.rateLimit, model: state.model,
                          limits: Object.values(state.limits) });
    }
  } catch (error) {
    if (!entry.stopped) await report.send({ type: "failed", error: String(error.message || error).slice(0, 600) });
  } finally {
    running.delete(job.id);
    await report.flush();
  }
}

function runProvider(job, dirs, resumeId, report, entry) {
  if (job.provider === "claude") return runClaude(job, dirs, resumeId, report, entry);
  if (job.provider === "codex") return runCodex(job, dirs, resumeId, report, entry);
  if (job.provider === "gemini") return runGemini(job, dirs, resumeId, report, entry);
  throw new Error(`Неизвестный агент ${job.provider}`);
}

/** Общий разбор потока JSONL: строки → handle(event); код выхода и хвост вывода — в причину провала. */
function streamCli(command, args, opts, entry, handle, state) {
  return new Promise((resolve, reject) => {
    const child = run(command, args, opts);
    entry.child = child;
    let buffer = "";
    let tail = "";
    const timer = setTimeout(() => { state.failure = "Агент работал дольше 30 минут — остановлен"; child.kill(); }, RUN_TIMEOUT_MS);
    const feed = (line) => {
      const text = line.trim();
      if (!text.startsWith("{")) { if (text) tail = `${tail}\n${text}`.slice(-3000); return; }
      try { handle(JSON.parse(text)); } catch (error) { tail = `${tail}\n${text.slice(0, 300)}`.slice(-3000); }
    };
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      lines.forEach(feed);
    });
    child.stderr.on("data", (chunk) => { tail = `${tail}${chunk}`.slice(-3000); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (buffer) feed(buffer);
      if (entry.stopped) return resolve(state);
      const limit = limitFromText(tail) || limitFromText(state.failure);
      if (limit && !state.rateLimit) state.rateLimit = { provider: opts.provider, detail: limit, used_percent: 100 };
      if ((code !== 0 && !state.text) || state.failure) {
        const reason = humanError(state.failure) || stripAnsi(tail).trim().split("\n").slice(-4).join(" ") || `выход с кодом ${code}`;
        if (/session|conversation|thread/i.test(reason) && /not found|no such|does not exist|invalid/i.test(reason) && args.some((a) => /resume/.test(a))) {
          return reject(new Error(`session not found: ${reason}`));
        }
        state.authExpired = authProblem(reason);
        state.failure = limit ? `Исчерпан лимит подписки: ${limit}` : state.authExpired ? "Вход в подписку истёк — войдите заново в Настройки → Ядро" : clip(reason, 500);
      }
      resolve(state);
    });
  });
}

function addStep(state, step, report) {
  if (state.steps.length >= 400) return null;
  state.steps.push(step);
  report.send({ type: "progress", steps: state.steps });
  return step;
}

function toolLabel(name) {
  // mcp__shar__read_item → read_item: человеку не нужен служебный префикс сервера.
  return String(name || "?").replace(/^mcp__shar__/, "").replace(/^shar__/, "");
}

const HINTS = {
  list_items: "Поиск в «Офисе»", read_item: "Читает материал", edit_document: "Правит документ", update_document: "Дописывает документ",
  edit_note: "Правит заметку", update_note: "Пишет заметку", update_table: "Правит таблицу", create_document: "Создаёт документ",
  create_note: "Создаёт заметку", create_table: "Создаёт таблицу", calendar_list: "Смотрит календарь", calendar_create: "Создаёт событие",
  calendar_update: "Меняет событие", calendar_delete: "Удаляет событие", tasks_list: "Смотрит задачи", task_read: "Читает задачу",
  task_create: "Ставит задачу", task_update: "Меняет задачу", task_delete: "Удаляет задачу", files_list: "Смотрит «Файлы»",
  file_read: "Читает файл", file_write: "Кладёт файл", people_search: "Ищет сотрудника", memory_search: "Вспоминает",
  memory_add: "Запоминает", profile_note: "Учится у вас", skill_read: "Читает навык", skill_write: "Записывает навык",
  ask_user: "Спрашивает вас", WebSearch: "Ищет в интернете", WebFetch: "Читает страницу", web_search: "Ищет в интернете",
  google_web_search: "Ищет в интернете", web_fetch: "Читает страницу",
};

function hintOf(name, input) {
  const base = HINTS[name] || "";
  const obj = typeof input === "object" && input ? input : {};
  const what = obj.title || obj.query || obj.name || obj.url || obj.id || "";
  return [base, what ? clip(String(what), 48) : ""].filter(Boolean).join(" · ");
}

// ── Claude Code ──────────────────────────────────────────────────────────────

function claudeRateLimit(info) {
  const resetsAt = Number(info.resetsAt) || 0;
  return {
    provider: "Claude",
    used_percent: Math.round((Number(info.utilization) || 0) * 100),
    wait_seconds: resetsAt ? Math.max(0, resetsAt - Math.floor(Date.now() / 1000)) : 0,
    resets_at: resetsAt, // момент сброса (unix, с) — интерфейс показывает его, а не «сейчас + сколько было ждать»
    detail: `${info.rateLimitType === "seven_day" ? "недельное окно" : "пятичасовое окно"}${info.isUsingOverage ? ", идёт перерасход" : ""}`,
    status: String(info.status || ""),
  };
}

// ── личные MCP человека ─────────────────────────────────────────────────────
// Шар присылает их в задаче (job.extraMcp): http — адрес и заголовки, npm — пакет для npx, аргументы и переменные.
// Секреты живут только в файлах настроек запуска (права 600) и в окружении процесса — и удаляются после хода.

const extraMcp = (job) => (Array.isArray(job.extraMcp) ? job.extraMcp : []).filter((m) => /^[a-z][a-z0-9_-]{1,30}$/.test(m?.name || ""));

function claudeExtra(job) {
  return Object.fromEntries(extraMcp(job).map((m) => [m.name, m.type === "http"
    ? { type: "http", url: m.url, headers: m.headers || {} }
    : { type: "stdio", command: "npx", args: ["-y", m.package, ...(m.args || [])], env: m.env || {} }]));
}

function geminiExtra(job) {
  return Object.fromEntries(extraMcp(job).map((m) => [m.name, m.type === "http"
    ? { httpUrl: m.url, headers: m.headers || {}, timeout: 120_000, trust: true }
    : { command: "npx", args: ["-y", m.package, ...(m.args || [])], env: m.env || {}, timeout: 120_000, trust: true }]));
}

/** Codex: настройки флагами -c. Авторизация http — через переменную окружения (bearer_token_env_var): так секрет не
 *  попадает в командную строку. Массивы TOML (аргументы npm) на Windows через cmd.exe не передать — только на Linux. */
function codexExtra(job) {
  const flags = [];
  const env = {};
  for (const m of extraMcp(job)) {
    if (m.type === "http") {
      flags.push("-c", `mcp_servers.${m.name}.url=${m.url}`);
      const auth = Object.entries(m.headers || {}).find(([k]) => k.toLowerCase() === "authorization")?.[1] || "";
      const bearer = String(auth).replace(/^Bearer\s+/i, "");
      if (bearer) {
        const varName = `SHAR_MCP_${m.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
        env[varName] = bearer;
        flags.push("-c", `mcp_servers.${m.name}.bearer_token_env_var=${varName}`);
      }
    } else if (process.platform !== "win32") {
      flags.push("-c", `mcp_servers.${m.name}.command=npx`, "-c", `mcp_servers.${m.name}.args=${JSON.stringify(["-y", m.package, ...(m.args || [])])}`);
      for (const [k, v] of Object.entries(m.env || {})) flags.push("-c", `mcp_servers.${m.name}.env.${k}=${JSON.stringify(String(v))}`);
    }
  }
  return { flags, env };
}

function claudeFiles(job, dirs) {
  const mcp = secretFile(dirs, `mcp-${job.id}.json`, JSON.stringify({
    mcpServers: {
      shar: { type: "http", url: absolute(job.mcp.url), headers: { Authorization: `Bearer ${job.mcp.token}` } },
      ...(browser ? { browser: { type: "stdio", command: browser, args: ["mcp"] } } : {}),
      ...claudeExtra(job),
    },
  }));
  const system = secretFile(dirs, `system-${job.id}.md`, job.system || "");
  return { mcp, system };
}

function runClaude(job, dirs, resumeId, report, entry) {
  const files = claudeFiles(job, dirs);
  // Экономия контекста (замеры MBOX, claude 2.1.291): из встроенного — только веб и ToolSearch (описания полусотни
  // инструментов Шара грузятся по требованию, а не в каждый ход), без каталога slash-команд и навыков CLI (−10 тыс.:
  // наши навыки живут в Шаре), только MCP из --mcp-config.
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--input-format", "text", "--permission-mode", "bypassPermissions", "--setting-sources", "project",
    "--tools", "WebSearch,WebFetch,ToolSearch", "--disable-slash-commands", "--strict-mcp-config", "--mcp-config", files.mcp,
    "--append-system-prompt-file", files.system];
  if (job.model) args.push("--model", job.model);
  if (["low", "medium", "high"].includes(job.effort)) args.push("--effort", job.effort);
  if (resumeId) args.push("--resume", resumeId);
  const state = newState();
  state.model = job.model || "";
  const pending = new Map();
  report.send({ type: "progress", phase: "запускается" });
  const handle = (event) => {
    if (event.session_id) state.sessionId = String(event.session_id);
    if (event.type === "system" && event.subtype === "init") {
      state.model = event.model || state.model;
      report.send({ type: "progress", phase: "думает", model: state.model });
      return;
    }
    if (event.type === "rate_limit_event" && event.rate_limit_info) {
      const info = event.rate_limit_info;
      state.limits[info.rateLimitType || "five_hour"] = {
        type: String(info.rateLimitType || "five_hour"), used: Math.round((Number(info.utilization) || 0) * 100),
        resetsAt: Number(info.resetsAt) || 0, status: String(info.status || ""), overage: Boolean(info.isUsingOverage),
      };
      // Плашку показываем, когда окно почти выбрано или уже отказ — на половине окна это был бы шум.
      if (/reject|block|exceed/i.test(String(info.status || "")) || (Number(info.utilization) || 0) >= 0.8) {
        state.rateLimit = claudeRateLimit(info);
        report.send({ type: "progress", rateLimit: state.rateLimit });
      }
      return;
    }
    if (event.type === "stream_event") {
      // Текст ответа печатается на глазах: дельты текущего блока — в тело сообщения.
      const ev = event.event || {};
      if (ev.type === "content_block_start") state.partial = "";
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        state.partial += ev.delta.text || "";
        report.send({ type: "progress", body: state.partial, phase: "пишет" });
      }
      if (ev.type === "content_block_delta" && ev.delta?.type === "thinking_delta") report.send({ type: "progress", phase: "думает" });
      return;
    }
    if (event.type === "assistant" && event.message) {
      const usage = event.message.usage;
      if (usage) state.contextTokens = (Number(usage.input_tokens) || 0) + (Number(usage.cache_read_input_tokens) || 0) + (Number(usage.cache_creation_input_tokens) || 0);
      for (const block of event.message.content || []) {
        if (block.type === "text" && String(block.text || "").trim()) {
          state.text = String(block.text).trim();
          addStep(state, { kind: "text", text: clip(state.text, MAX_STEP_TEXT) }, report);
        }
        if (block.type === "tool_use") {
          const name = toolLabel(block.name);
          const step = addStep(state, { kind: "tool", name, hint: hintOf(name, block.input), input: clip(stringify(block.input), MAX_STEP_INPUT), at: Date.now() }, report);
          if (step && block.id) pending.set(block.id, step);
          report.send({ type: "progress", phase: HINTS[name]?.toLowerCase() || "работает", body: "" });
        }
      }
      return;
    }
    if (event.type === "user" && event.message) {
      for (const block of event.message.content || []) {
        if (block.type !== "tool_result") continue;
        const step = pending.get(block.tool_use_id);
        if (!step) continue;
        pending.delete(block.tool_use_id);
        const content = Array.isArray(block.content) ? block.content.map((p) => p.text || "").join("\n") : block.content;
        step.output = clip(content, MAX_STEP_OUTPUT);
        step.is_error = Boolean(block.is_error);
        step.ms = Date.now() - step.at;
        delete step.at;
        report.send({ type: "progress", steps: state.steps, phase: "думает" });
      }
      return;
    }
    if (event.type === "result") {
      state.text = String(event.result || state.text || "").trim();
      const u = event.usage || {};
      // total_cost_usd CLI считает по ценам API, а работает подписка — человеку эти доллары не показываем.
      state.work = {
        input_tokens: (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0),
        cached_input_tokens: Number(u.cache_read_input_tokens) || 0,
        output_tokens: Number(u.output_tokens) || 0,
        context_tokens: state.contextTokens,
        context_window: Math.max(0, ...Object.values(event.modelUsage || {}).map((m) => Number(m?.contextWindow) || 0)),
        duration_ms: Number(event.duration_ms) || 0,
        turns: Number(event.num_turns) || 0,
      };
      if (event.is_error) state.failure = state.text || String(event.subtype || "Claude вернул ошибку");
    }
  };
  return streamCli(CLI.claude, args, { cwd: dirs.work, env: userEnv(dirs), stdin: promptText(job, Boolean(resumeId)), provider: "Claude" }, entry, handle, state)
    .finally(() => { for (const f of Object.values(files)) fs.rmSync(f, { force: true }); });
}

/** /compact отдельным коротким запуском. Возвращает id сессии после сжатия или "" (тогда — новая сессия). */
async function compactClaude(dirs, sessionId, focus) {
  const command = focus ? `/compact ${focus}` : "/compact";
  const res = await exec(CLI.claude, ["-p", "--resume", sessionId, "--output-format", "json", "--setting-sources", "project", "--tools", ""],
    { cwd: dirs.work, env: userEnv(dirs), stdin: command }, 5 * 60_000);
  try {
    const data = JSON.parse(stripAnsi(res.out).trim().split("\n").pop() || "{}");
    return data.is_error ? "" : String(data.session_id || sessionId);
  } catch {
    return "";
  }
}

/** Ручное «/compact [что сохранить]» из чата. Claude сжимает сессию; Codex и Gemini — начинают новую с кратким итогом. */
async function compactCommand(job, dirs, report) {
  const key = `${job.provider}:${job.threadId}`;
  const session = readSessions(dirs)[key] || (job.resume ? { id: job.resume, context: 0 } : null);
  if (!session) return report.send({ type: "done", body: "В этом чате ещё нечего сжимать: разговор с агентом не начинался." });
  const focus = String(job.prompt).replace(/^\/compact\s*/, "").replace(/[^\p{L}\p{N} .,:;()_\/-]+/gu, " ").trim().slice(0, 300);
  report.send({ type: "progress", phase: "сжимает контекст" });
  if (job.provider === "claude") {
    const id = await compactClaude(dirs, session.id, focus);
    if (!id) return report.send({ type: "failed", error: "Сжать не удалось — сессия осталась как была. Если контекст слишком тяжёлый, начните новый чат." });
    saveSession(dirs, key, { id, context: 20_000 });
    await report.send({ type: "session", id });
    return report.send({ type: "done", body: `Контекст сжат${session.context ? `: было около ${Math.round(session.context / 1000)} тыс. токенов` : ""}. Нить разговора сохранена${focus ? `, с упором на: ${focus}` : ""}.`,
                         work: { context_tokens: 20_000 } });
  }
  saveSession(dirs, key, null);
  await report.send({ type: "session", id: "" });
  return report.send({ type: "done", body: "Начал разговор заново: следующий ответ получит последние сообщения чата, а не всю прежнюю сессию." });
}

// ── Codex (подписка ChatGPT) ─────────────────────────────────────────────────

function runCodex(job, dirs, resumeId, report, entry) {
  // Вся настройка — флагами: личный config.toml машины (модель по умолчанию, свои MCP) ноде не указ.
  // Ключ MCP — в переменной окружения запуска, во флагах только адрес.
  const config = ["-c", "approval_policy=never", "-c", "sandbox_mode=read-only", "-c", "model_reasoning_summary=auto",
    "-c", `mcp_servers.shar.url=${absolute(job.mcp.url)}`, "-c", "mcp_servers.shar.bearer_token_env_var=SHAR_MCP_TOKEN",
    "-c", "mcp_servers.shar.tool_timeout_sec=120",
    // Массив в TOML — с кавычками; через cmd.exe на Windows их не передать, поэтому браузер у Codex — только на Linux.
    ...(browser && process.platform !== "win32" ? ["-c", `mcp_servers.browser.command=${browser}`, "-c", 'mcp_servers.browser.args=["mcp"]'] : []),
    ...codexExtra(job).flags];
  const args = resumeId
    ? ["exec", "resume", "--json", "--skip-git-repo-check", "--ignore-user-config", ...config]
    : ["exec", "--json", "--skip-git-repo-check", "--ignore-user-config", ...config, "-C", dirs.work];
  if (job.model) args.push("-m", job.model);
  if (["low", "medium", "high"].includes(job.effort)) args.push("-c", `model_reasoning_effort=${job.effort}`);
  if (resumeId) args.push(resumeId);
  args.push("-");
  const state = newState();
  state.model = job.model || "";
  const pending = new Map();
  // У Codex нет отдельного системного промпта в exec: правила — в начале первого сообщения сессии.
  const prompt = resumeId ? promptText(job, true) : `${job.system}\n\n---\n\n${promptText(job, false)}`;
  report.send({ type: "progress", phase: "запускается" });
  const toolName = (item) => (item.tool ? String(item.tool) : item.type === "web_search" ? "web_search" : item.command ? "shell" : "");
  const handle = (event) => {
    if (!event.type && event.msg?.type) event = event.msg;
    if (event.type === "thread.started" && event.thread_id) { state.sessionId = String(event.thread_id); return; }
    if (event.type === "turn.started") { report.send({ type: "progress", phase: "думает" }); return; }
    if (event.type === "turn.completed") {
      const u = event.usage || {};
      state.work = {
        input_tokens: Number(u.input_tokens) || 0, cached_input_tokens: Number(u.cached_input_tokens) || 0,
        output_tokens: Number(u.output_tokens) || 0, thinking_tokens: Number(u.reasoning_output_tokens) || 0, turns: 1,
        context_tokens: Number(u.input_tokens) || 0,
      };
      state.contextTokens = state.work.context_tokens;
      return;
    }
    if ((event.type === "item.started" || event.type === "item.completed") && event.item) {
      const item = event.item;
      if (item.type === "agent_message" && event.type === "item.completed") {
        state.text = String(item.text || "").trim();
        if (state.text) addStep(state, { kind: "text", text: clip(state.text, MAX_STEP_TEXT) }, report);
        report.send({ type: "progress", body: state.text, phase: "пишет" });
        return;
      }
      if (item.type === "reasoning" && event.type === "item.completed") {
        const text = String(item.text || item.summary?.map?.((s) => s.text).join("\n") || "").replace(/\*\*/g, "").trim();
        if (text) addStep(state, { kind: "text", text: clip(text, MAX_STEP_TEXT) }, report);
        report.send({ type: "progress", phase: "думает" });
        return;
      }
      const name = toolName(item);
      if (!name) return;
      const key = String(item.id || item.call_id || "");
      const known = key ? pending.get(key) : null;
      if (event.type === "item.started" || !known) {
        const input = item.arguments ?? item.input ?? item.query ?? item.command ?? "";
        const step = known || addStep(state, { kind: "tool", name, hint: hintOf(name, typeof input === "object" ? input : { query: input }), input: clip(stringify(input), MAX_STEP_INPUT), at: Date.now() }, report);
        if (step && key && event.type === "item.started") pending.set(key, step);
        report.send({ type: "progress", phase: HINTS[name]?.toLowerCase() || "работает" });
        if (event.type === "item.started") return;
      }
      const step = known || state.steps[state.steps.length - 1];
      if (key) pending.delete(key);
      const result = item.result?.content ?? item.output ?? item.aggregated_output ?? item.error ?? item.status ?? "";
      step.output = clip(Array.isArray(result) ? result.map((p) => p.text || "").join("\n") : stringify(result), MAX_STEP_OUTPUT);
      step.is_error = Boolean(item.error || item.status === "failed");
      step.ms = step.at ? Date.now() - step.at : 0;
      delete step.at;
      report.send({ type: "progress", steps: state.steps, phase: "думает" });
      return;
    }
    if (event.type === "error" || event.type === "turn.failed") {
      state.failure = String(event.message || event.error?.message || event.error || "Codex вернул ошибку");
    }
  };
  return streamCli(CLI.codex, args, { cwd: dirs.work, env: { ...userEnv(dirs), SHAR_MCP_TOKEN: job.mcp.token, ...codexExtra(job).env }, stdin: prompt, provider: "GPT" }, entry, handle, state);
}

// ── Gemini CLI (ключ человека) ───────────────────────────────────────────────

function geminiSettings(job, dirs) {
  // Настройки запуска — отдельным файлом (системный уровень Gemini CLI): MCP Шара и ничего из личных настроек машины.
  return secretFile(dirs, `gemini-${job.id}.json`, JSON.stringify({
    mcpServers: {
      shar: { httpUrl: absolute(job.mcp.url), headers: { Authorization: `Bearer ${job.mcp.token}` }, timeout: 120_000, trust: true },
      ...(browser ? { browser: { command: browser, args: ["mcp"], timeout: 120_000, trust: true } } : {}),
      ...geminiExtra(job),
    },
    general: { disableAutoUpdate: true, checkpointing: { enabled: false } },
    security: { auth: { selectedType: "gemini-api-key" }, folderTrust: { enabled: false } },
    privacy: { usageStatisticsEnabled: false },
    tools: { core: ["google_web_search", "web_fetch"] },
  }));
}

function runGemini(job, dirs, resumeId, report, entry) {
  const settings = geminiSettings(job, dirs);
  const system = secretFile(dirs, `gemini-system-${job.id}.md`, job.system || "");
  const args = ["--output-format", "stream-json", "--approval-mode", "yolo", "--allowed-mcp-server-names", "shar", ...(browser ? ["browser"] : []), ...extraMcp(job).map((m) => m.name)];
  if (job.model) args.push("-m", job.model);
  if (resumeId) args.push("--resume", resumeId);
  args.push("-p", "");
  const state = newState();
  state.model = job.model || "";
  const pending = new Map();
  report.send({ type: "progress", phase: "запускается" });
  const handle = (event) => {
    if (event.session_id) state.sessionId = String(event.session_id);
    if (event.type === "init") { state.model = event.model || state.model; report.send({ type: "progress", phase: "думает", model: state.model }); return; }
    if (event.type === "message" && event.role === "assistant") {
      state.partial = event.delta ? `${state.partial}${event.content || ""}` : String(event.content || "");
      state.text = state.partial.trim();
      report.send({ type: "progress", body: state.partial, phase: "пишет" });
      return;
    }
    if (event.type === "message" && event.role === "user") return;
    if (event.type === "tool_use") {
      if (state.partial.trim()) addStep(state, { kind: "text", text: clip(state.partial.trim(), MAX_STEP_TEXT) }, report);
      state.partial = "";
      const name = toolLabel(String(event.tool_name || "").replace(/^shar__|^mcp_shar_/, ""));
      const step = addStep(state, { kind: "tool", name, hint: hintOf(name, event.parameters), input: clip(stringify(event.parameters), MAX_STEP_INPUT), at: Date.now() }, report);
      if (step && event.tool_id) pending.set(event.tool_id, step);
      report.send({ type: "progress", phase: HINTS[name]?.toLowerCase() || "работает", body: "" });
      return;
    }
    if (event.type === "tool_result") {
      const step = pending.get(event.tool_id);
      if (!step) return;
      pending.delete(event.tool_id);
      step.output = clip(event.output ?? event.error?.message ?? event.status, MAX_STEP_OUTPUT);
      step.is_error = event.status === "error";
      step.ms = Date.now() - step.at;
      delete step.at;
      report.send({ type: "progress", steps: state.steps, phase: "думает" });
      return;
    }
    if (event.type === "error") {
      if (/error|fatal/i.test(String(event.severity || "error"))) state.failure = String(event.message || "Gemini вернул ошибку");
      return;
    }
    if (event.type === "result") {
      const s = event.stats || {};
      state.work = {
        input_tokens: Number(s.input_tokens ?? s.input) || 0, cached_input_tokens: Number(s.cached ?? s.cached_input_tokens) || 0,
        output_tokens: Number(s.output_tokens ?? s.output) || 0, thinking_tokens: Number(s.thoughts ?? s.thinking_tokens) || 0,
        duration_ms: Number(s.duration_ms) || 0, turns: Number(s.tool_calls) || 0, context_tokens: Number(s.input_tokens ?? s.input) || 0,
      };
      state.contextTokens = state.work.context_tokens;
      if (event.status && event.status !== "success") state.failure = state.failure || String(event.error?.message || event.status);
    }
  };
  const env = { ...userEnv(dirs), GEMINI_API_KEY: job.apiKey || "", GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings, GEMINI_SYSTEM_MD: "", GEMINI_CLI_NO_RELAUNCH: "true" };
  // Правила Шара — в начале первого сообщения сессии: системный промпт Gemini CLI заменять целиком не нужно.
  const prompt = resumeId ? promptText(job, true) : `${job.system}\n\n---\n\n${promptText(job, false)}`;
  return streamCli(CLI.gemini, args, { cwd: dirs.work, env, stdin: prompt, provider: "Gemini" }, entry, handle, state)
    .finally(() => { fs.rmSync(settings, { force: true }); fs.rmSync(system, { force: true }); });
}

// ── вход в подписки ──────────────────────────────────────────────────────────

const logins = new Map(); // `${user}:${provider}` → { child, done }
const CLI_URL = /https:\/\/[^\s"'<>\x1b]+/;
const USER_CODE = /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,6})\b/;

async function accountOf(provider, dirs) {
  const env = userEnv(dirs);
  if (provider === "claude") {
    const res = await exec(CLI.claude, ["auth", "status"], { env, cwd: dirs.work }, 30_000);
    const text = stripAnsi(res.out);
    try {
      const data = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
      return { loggedIn: Boolean(data.loggedIn), account: String(data.email || data.orgName || data.authMethod || "") };
    } catch {
      return { loggedIn: res.code === 0 && !/not logged in|please log in/i.test(text), account: "" };
    }
  }
  const res = await exec(CLI.codex, ["login", "status"], { env, cwd: dirs.work }, 30_000);
  const text = stripAnsi(res.out).trim();
  const ok = res.code === 0 && !/not logged in/i.test(text);
  return { loggedIn: ok, account: ok ? text.split("\n")[0].slice(0, 120) : "" };
}

/** Какие модели доступны подписке человека — у самого провайдера, а не выдуманный список.
 *  Claude: /v1/models с его токеном подписки (OAuth); GPT: каталог Codex (`codex debug models`, видимые). */
async function modelsOf(provider, dirs) {
  try {
    if (provider === "claude") {
      const creds = JSON.parse(fs.readFileSync(path.join(dirs.home, ".claude", ".credentials.json"), "utf8"));
      const token = creds?.claudeAiOauth?.accessToken;
      if (!token) return [];
      const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
        headers: { Authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.data || []).map((m) => ({ id: String(m.id), label: String(m.display_name || m.id).replace(/^Claude\s+/, "") }));
    }
    if (provider === "codex") {
      const res = await exec(CLI.codex, ["debug", "models"], { env: userEnv(dirs), cwd: dirs.work }, 30_000);
      const data = JSON.parse(stripAnsi(res.out).slice(stripAnsi(res.out).indexOf("{")));
      return (data.models || []).filter((m) => m.visibility === "list").map((m) => ({ id: String(m.slug), label: String(m.display_name || m.slug) }));
    }
  } catch (error) {
    log(`модели ${provider}: ${error.message || error}`);
  }
  return [];
}

/** Проверка: вошёл ли человек и какие модели ему доступны (Шар просит после входа и раз в несколько часов). */
async function checkJob(job) {
  const dirs = userDirs(job.userId);
  const acc = await accountOf(job.provider, dirs);
  const models = acc.loggedIn ? await modelsOf(job.provider, dirs) : [];
  const limits = acc.loggedIn && job.limits && job.provider === "claude" ? await claudeLimits(dirs) : null;
  await reporter(job).send({ type: "account", loggedIn: acc.loggedIn, account: acc.account, models, ...(limits ? { limits } : {}) });
}

/**
 * Лимиты подписки Claude по кнопке «Проверить». Отдельного публичного способа узнать их нет — Claude Code присылает
 * rate_limit_event в ответ на любой запрос. Поэтому — самый дешёвый запрос: Haiku, одно слово, без инструментов и MCP.
 */
async function claudeLimits(dirs) {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--input-format", "text", "--model", "haiku",
    "--setting-sources", "project", "--tools", "", "--disable-slash-commands", "--strict-mcp-config", "--max-turns", "1"];
  const { out } = await exec(CLI.claude, args, { env: userEnv(dirs), cwd: dirs.work, stdin: "Ответь одним словом: ок" }, 90_000);
  const limits = {};
  for (const line of out.split("\n")) {
    if (!line.includes("rate_limit_event")) continue;
    try {
      const info = JSON.parse(line).rate_limit_info;
      if (!info) continue;
      limits[info.rateLimitType || "five_hour"] = {
        type: String(info.rateLimitType || "five_hour"), used: Math.round((Number(info.utilization) || 0) * 100),
        resetsAt: Number(info.resetsAt) || 0, status: String(info.status || ""), overage: Boolean(info.isUsingOverage),
      };
    } catch { /* строка не JSON */ }
  }
  return Object.values(limits);
}

async function loginJob(job) {
  const dirs = userDirs(job.userId);
  const report = reporter(job);
  const key = `${job.userId}:${job.provider}`;
  logins.get(key)?.child?.kill();
  if (SHARED_HOME) {
    // Разработка: вход общий с этой машиной — просто проверяем, что он есть.
    const acc = await accountOf(job.provider, dirs);
    return report.send(acc.loggedIn ? { type: "login", state: "done", account: acc.account, models: await modelsOf(job.provider, dirs) }
      : { type: "login", state: "failed", message: "На машине разработчика войдите в CLI вручную" });
  }
  const args = job.provider === "claude" ? ["auth", "login"] : ["login", "--device-auth"];
  const child = run(CLI[job.provider], args, { env: { ...userEnv(dirs), BROWSER: "true" }, cwd: dirs.work, pty: true });
  const session = { child, url: "", code: "", buffer: "" };
  logins.set(key, session);
  const timer = setTimeout(() => { child.kill(); report.send({ type: "login", state: "failed", message: "Время входа вышло (10 минут) — нажмите «Войти» ещё раз" }); }, LOGIN_TIMEOUT_MS);
  const onData = (chunk) => {
    session.buffer = `${session.buffer}${stripAnsi(chunk.toString("utf8"))}`.slice(-6000);
    const url = session.buffer.match(CLI_URL)?.[0]?.replace(/[).,]+$/, "");
    const code = job.provider === "codex" ? session.buffer.match(USER_CODE)?.[1] || "" : "";
    if ((url && url !== session.url) || (code && code !== session.code)) {
      session.url = url || session.url;
      session.code = code || session.code;
      report.send({ type: "login", state: "waiting", url: session.url, code: session.code, needsCode: job.provider === "claude",
                    message: job.provider === "claude" ? "Откройте ссылку, подтвердите вход и вставьте код со страницы" : "Откройте ссылку и введите код" });
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("close", async () => {
    clearTimeout(timer);
    if (logins.get(key) === session) logins.delete(key);
    if (session.cancelled) return;
    report.send({ type: "login", state: "verifying", message: "Проверяю вход…" });
    const acc = await accountOf(job.provider, dirs);
    await report.send(acc.loggedIn ? { type: "login", state: "done", account: acc.account, models: await modelsOf(job.provider, dirs) }
      : { type: "login", state: "failed", message: "Вход не завершён — нажмите «Войти» ещё раз и подтвердите его в браузере" });
  });
}

function loginCode(job) {
  const session = logins.get(`${job.userId}:${job.provider}`);
  if (session?.child?.stdin?.writable) session.child.stdin.write(`${String(job.code).trim()}\r`);
}

function loginCancel(job) {
  const session = logins.get(`${job.userId}:${job.provider}`);
  if (session) { session.cancelled = true; session.child.kill(); }
  return reporter(job).send({ type: "done" });
}

async function logoutJob(job) {
  const dirs = userDirs(job.userId);
  const report = reporter(job);
  if (!SHARED_HOME) {
    if (job.provider === "claude") await exec(CLI.claude, ["auth", "logout"], { env: userEnv(dirs), cwd: dirs.work });
    if (job.provider === "codex") await exec(CLI.codex, ["logout"], { env: userEnv(dirs), cwd: dirs.work });
  }
  await report.send({ type: "done" });
}

// ── главный цикл ─────────────────────────────────────────────────────────────

let clis = {};

function handleJob(job) {
  log(`задача ${job.id}: ${job.kind} ${job.provider} (человек ${job.userId})`);
  const work = job.kind === "run" ? runJob(job)
    : job.kind === "login" ? loginJob(job)
      : job.kind === "login_code" ? Promise.resolve(loginCode(job))
        : job.kind === "login_cancel" ? loginCancel(job)
          : job.kind === "logout" ? logoutJob(job)
            : job.kind === "check" ? checkJob(job)
            : Promise.resolve();
  work.catch((error) => log(`задача ${job.id}: ${error.message || error}`));
}

async function main() {
  fs.mkdirSync(path.join(ROOT, "users"), { recursive: true, mode: 0o700 });
  clis = await detectClis();
  log(`нода Шара ${VERSION}: ${SHAR_URL}, CLI: ${Object.entries(clis).map(([k, v]) => `${k} ${v}`).join(", ") || "нет"}`);
  setInterval(async () => { clis = await detectClis(); }, 10 * 60_000).unref();
  let failures = 0;
  for (;;) {
    try {
      const res = await shar("/api/core/node/poll", { version: VERSION, host: os.hostname(), clis: { ...clis, ...(browser ? { browser: "obscura" } : {}) }, running: [...running.keys()], wait: running.size < PARALLEL }, 45_000);
      failures = 0;
      for (const id of res.cancel || []) running.get(String(id))?.stop();
      for (const job of res.jobs || []) handleJob(job);
      if (running.size >= PARALLEL) await sleep(2000);
    } catch (error) {
      failures += 1;
      log(`Шар недоступен: ${error.message || error}`);
      if (error.status === 401) await sleep(60_000);
      await sleep(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)));
    }
  }
}

main();
