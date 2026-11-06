// Поддельный `claude` для проверки тёплых процессов: тот же протокол stream-json, но без подписки и модели.
// Пишет в журнал (FAKE_CLAUDE_LOG): запуск, каждый ход (с проверкой ключа MCP из --mcp-config), выход.
const fs = require("fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.999 (Fake Claude Code)"); process.exit(0); }
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ""; };
const log = (o) => fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ t: Date.now(), pid: process.pid, ...o }) + "\n");
const mode = arg("--input-format");
const resume = arg("--resume");
const sid = resume || `sess-${process.pid}`;
const startupMs = Number(process.env.FAKE_STARTUP_MS || 0);
const turnMs = Number(process.env.FAKE_TURN_MS || 200);
let mcp = { url: "", token: "" };
try {
  const cfg = JSON.parse(fs.readFileSync(arg("--mcp-config"), "utf8")).mcpServers.shar;
  mcp = { url: cfg.url, token: String(cfg.headers.Authorization).replace(/^Bearer /, "") };
} catch { /* без MCP */ }
log({ ev: "spawn", mode, resume, model: arg("--model"), effort: arg("--effort"), token: mcp.token });
const out = (o) => console.log(JSON.stringify({ session_id: sid, ...o }));
let turn = 0;
let first = true;
let alive = Date.now();

async function answer(text) {
  turn += 1;
  let status = 0;
  try { status = (await fetch(mcp.url, { method: "POST", headers: { Authorization: `Bearer ${mcp.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) })).status; } catch { status = -1; }
  log({ ev: "turn", turn, mcpStatus: status, text: text.slice(0, 80) });
  if (first) { out({ type: "system", subtype: "init", model: "fake-model" }); first = false; }
  await new Promise((r) => setTimeout(r, turnMs));
  const reply = `ответ ${turn} на «${text.replace(/^\[Сейчас:[^\]]*\]\s*/, "").slice(0, 30)}»`;
  out({ type: "stream_event", event: { type: "content_block_start" } });
  out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: reply } } });
  out({ type: "assistant", message: { content: [{ type: "text", text: reply }], usage: { input_tokens: 10, output_tokens: 5 } } });
  out({ type: "result", result: reply, usage: { input_tokens: 10, output_tokens: 5 }, duration_ms: turnMs, num_turns: 1 });
}

process.on("SIGTERM", () => { log({ ev: "exit", why: "SIGTERM" }); process.exit(0); });
process.on("exit", () => log({ ev: "exit" }));

setTimeout(() => {
  let buf = "";
  let chain = Promise.resolve();
  process.stdin.on("data", (d) => {
    buf += d;
    if (mode !== "stream-json") return;
    const lines = buf.split("\n"); buf = lines.pop();
    for (const l of lines) {
      if (!l.trim()) continue;
      const msg = JSON.parse(l);
      const text = (msg.message?.content || []).map((c) => c.text || "").join(" ");
      chain = chain.then(() => answer(text));
    }
  });
  process.stdin.on("end", () => {
    if (mode !== "stream-json") answer(buf).then(() => process.exit(0)); else chain.then(() => process.exit(0));
  });
}, startupMs);
