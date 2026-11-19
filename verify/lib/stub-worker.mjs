// What EV starts instead of OpenClaw during verification. It asks the stand-in
// what this agent turn should do, then behaves like the real runtime from EV's
// side: files appear in the workspace, the session transcript grows, and the
// final answer comes back as the JSON envelope EV reads.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const flag = (name) => { const at = args.indexOf(name); return at < 0 ? null : args[at + 1]; };
const home = process.env.HOME ?? "";
const cwd = process.cwd();
const taskId = flag("--session-id");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function listing(root, limit = 300) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 6 || found.length >= limit) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === "node_modules" || found.length >= limit) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1); else found.push(relative(root, path));
    }
  };
  walk(root, 0);
  return found;
}

/** The harness leaves the stand-in's address beside the data it started EV with. */
function standInUrl() {
  for (let dir = cwd; dir !== dirname(dir); dir = dirname(dir)) {
    const file = join(dir, ".ev-verify.json");
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")).url;
  }
  const file = join(home, ".ev-verify.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).url : null;
}

let provider = "opencode-go", model = "gpt-6-luna", config = {};
try { config = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8")); [provider, model] = config.agents.defaults.model.primary.split(/\/(.*)/); } catch {}

/**
 * One model call made the way OpenClaw makes it: to the base URL and with the
 * key its config names (a "${VAR}" key is read from the environment), in the
 * API shape the config gives. Returns the HTTP status.
 */
async function think(text) {
  const settings = config.models?.providers?.[provider] ?? {};
  const key = String(settings.apiKey ?? "").replace(/^\$\{(\w+)\}$/, (_, name) => process.env[name] ?? "");
  const api = settings.api ?? "openai-responses";
  const path = { "openai-completions": "/chat/completions", "anthropic-messages": "/v1/messages" }[api] ?? "/responses";
  const body = api === "openai-responses" ? { model, input: text, stream: true } : { model, max_tokens: 100, messages: [{ role: "user", content: text }], stream: true };
  const auth = api === "anthropic-messages" ? { "x-api-key": key } : { Authorization: `Bearer ${key}` };
  try {
    const reply = await fetch(`${String(settings.baseUrl ?? "").replace(/\/$/, "")}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...settings.headers, ...auth }, body: JSON.stringify(body) });
    await reply.text();
    return reply.status;
  } catch { return 0; }
}

function record(message, role = "assistant") {
  const path = join(home, ".openclaw", "agents", "ev-worker", "agent", "openclaw-agent.sqlite");
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA busy_timeout = 2000; CREATE TABLE IF NOT EXISTS transcript_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, event_json TEXT, event_zstd BLOB)");
    database.prepare("INSERT INTO transcript_events (session_id, event_json) VALUES (?, ?)").run(taskId, JSON.stringify({ type: "message", message: role === "assistant" ? { role, provider, model, ...message } : { role, ...message } }));
  } finally { database.close(); }
}

const url = standInUrl();
if (!url) { console.error("stub worker: no stand-in address found"); process.exit(70); }
const response = await fetch(`${url}/worker`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ taskId, prompt: flag("--message") ?? "", cwd, home, files: listing(cwd), homeFiles: listing(join(home, ".openclaw"), 200), pid: process.pid, env: process.env })
});
const plan = await response.json();
// An agent slow to stop: it keeps working through SIGTERM until it is killed.
if (plan.ignoresStop) process.on("SIGTERM", () => {});

if (plan.think) plan.thought = await think(plan.think);
for (const step of plan.steps ?? []) {
  if (step.waitMs) await sleep(step.waitMs);
  if (step.progress) record({ stopReason: "toolUse", content: [{ type: "text", text: step.progress }, { type: "toolCall", name: "exec" }], usage: step.usage ?? { input: 100, output: 20 } });
  // A real tool call ({ name, arguments }), and its result after `takesMs`.
  if (step.call) {
    const id = `call-${Math.random().toString(36).slice(2, 10)}`;
    record({ stopReason: "toolUse", content: [{ type: "toolCall", id, ...step.call }], usage: step.usage ?? { input: 100, output: 20 } });
    if (step.takesMs) await sleep(step.takesMs);
    record({ toolCallId: id, toolName: step.call.name, isError: Boolean(step.fails), content: [{ type: "text", text: step.output ?? "" }], details: { exitCode: step.fails ? 1 : 0 } }, "toolResult");
  }
}
for (const [path, contents] of Object.entries(plan.files ?? {})) {
  const target = path.startsWith("~/") ? join(home, path.slice(2)) : isAbsolute(path) ? path : join(cwd, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}
if (plan.hangMs) await sleep(plan.hangMs);
if (plan.exitCode) { console.error(plan.stderr ?? "stub worker: scripted failure"); process.exit(plan.exitCode); }
const usage = plan.usage ?? { input: 2000, output: 300 };
record({ stopReason: "stop", content: [{ type: "text", text: plan.text }], usage });
process.stdout.write(JSON.stringify({ payloads: [{ text: plan.text }], meta: { agentMeta: { provider, model, usage } } }));
