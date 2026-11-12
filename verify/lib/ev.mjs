// Starts an isolated EV for one check and drives it the way a person's browser
// would: over the HTTP API, with a blank data directory, a scripted model and
// a scripted agent runtime. Nothing here imports EV's code, so the checks keep
// working while its insides are rebuilt.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { NotBuilt } from "./protocol.mjs";
import { startStandIn } from "./stand-in.mjs";

export const projectRoot = resolve(import.meta.dirname, "../..");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const TOKEN = "verify-token";
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const DONE = new Set(["completed", "failed", "cancelled", "not_executable"]);

async function freePort() {
  return new Promise((done, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => done(port)); });
  });
}

/**
 * script scripts the model and the workers (see stand-in.mjs). env adds to
 * EV's environment. Returns the handle the checks use.
 */
export async function startEV({ script = {}, env = {}, keep = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ev-verify-"));
  const dataDir = join(root, "data");
  const home = join(root, "home");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  const standIn = await startStandIn(script);
  writeFileSync(join(root, ".ev-verify.json"), JSON.stringify({ url: standIn.url }));
  let child = null;
  let baseUrl = null;
  let log = "";
  let messageSeq = 0;

  async function boot() {
    const port = await freePort();
    child = spawn(process.execPath, [join(projectRoot, "apps/daemon/server.mjs")], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PATH: `${join(projectRoot, "verify/lib/bin")}:${process.env.PATH}`,
        HOME: home,
        EV_DATA_DIR: dataDir, EV_HOST: "127.0.0.1", EV_PORT: String(port),
        EV_MODEL_URL: standIn.url, OPENCODE_API: "verify-stand-in-key", EV_API_TOKEN: TOKEN,
        EV_OPENCLAW_SANDBOX: "host", EV_REVIEW_HOLD_MS: "100", EV_STANDING_POLL_MS: "3600000",
        NODE_NO_WARNINGS: "1",
        ...env
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const started = child;
    started.stdout.on("data", (chunk) => { log += chunk; });
    started.stderr.on("data", (chunk) => { log += chunk; });
    baseUrl = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (started.exitCode !== null) break;
      try { if ((await fetch(`${baseUrl}/api/health`)).ok) return; } catch {}
      await sleep(100);
    }
    throw new Error(`EV did not start.\n${log.slice(-2_000)}`);
  }

  async function halt(signal) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise((done) => child.once("close", done));
    child.kill(signal);
    if (signal !== "SIGKILL") setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    await closed;
  }

  async function api(path, body) {
    const response = await fetch(`${baseUrl}${path}`, body === undefined ? { headers: AUTH } : { method: "POST", headers: { "Content-Type": "application/json", ...AUTH }, body: JSON.stringify(body) });
    const value = await response.json().catch(() => null);
    return { status: response.status, ok: response.ok, value };
  }
  async function get(path) {
    const { ok, status, value } = await api(path);
    if (!ok) throw new Error(`GET ${path} returned ${status}: ${value?.error ?? ""}`);
    return value;
  }
  /** For surfaces that do not exist yet: a missing route is "not built", not a crash. */
  async function planned(what, path, body) {
    const { ok, status, value } = await api(path, body);
    if (status === 404 || status === 405) throw new NotBuilt(`${what} (no ${body === undefined ? "GET" : "POST"} ${path.split("?")[0]})`);
    if (!ok) throw new Error(`${path} returned ${status}: ${value?.error ?? ""}`);
    return value;
  }

  const ev = {
    root, dataDir, home, standIn,
    get baseUrl() { return baseUrl; },
    get log() { return log; },
    api,
    /** The link a person opens: it signs the browser in, then shows the conversation. */
    pageUrl: (conversation = "main") => `${baseUrl}/?token=${TOKEN}&conversation=${encodeURIComponent(conversation)}`,

    /** Sends a message and waits for EV's immediate answer. */
    async say(text, { conversation = "main", id = `m${++messageSeq}-${Date.now().toString(36)}` } = {}) {
      const { ok, status, value } = await api("/api/assistant/messages", { clientMessageId: id, conversationId: conversation, text });
      const reply = value?.messages?.find((message) => message.role === "assistant") ?? null;
      return { ok, status, id, reply: reply?.content ?? null, taskId: value?.task?.taskId ?? reply?.taskId ?? null, raw: value };
    },
    /** Sends a message without waiting; the promise settles when EV answers. */
    send(text, options) { return ev.say(text, options); },

    async conversation(conversation = "main") { return (await get(`/api/assistant/conversation?conversationId=${encodeURIComponent(conversation)}`)).messages; },
    async tasks(conversation = "main") { return (await get(`/api/assistant/tasks?conversationId=${encodeURIComponent(conversation)}`)).tasks; },
    /** Root tasks only: what the person asked for, not the helpers under them. */
    async work(conversation = "main") { return (await ev.tasks(conversation)).filter((task) => !task.parentTaskId); },
    async task(taskId, conversation = "main") { return (await ev.tasks(conversation)).find((task) => task.taskId === taskId) ?? null; },
    async memory() { return (await get("/api/assistant/memory")).claims; },
    /** Everything EV has said in the conversation: immediate replies, results, questions. */
    async fromEV(conversation = "main") { return (await ev.conversation(conversation)).filter((message) => message.role === "assistant"); },

    /** Polls until probe() returns something truthy; fails with `what` after the timeout. */
    async until(what, probe, { timeout = 15_000, every = 100 } = {}) {
      const deadline = Date.now() + timeout;
      let last;
      for (;;) {
        try { last = await probe(); if (last) return last; } catch (error) { if (error instanceof NotBuilt) throw error; last = error; }
        if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${what}${last instanceof Error ? ` (${last.message})` : ""}`);
        await sleep(every);
      }
    },
    /** Waits until every task in the conversation has finished or is waiting for the person. */
    async settled(conversation = "main", options) {
      return ev.until("the work to settle", async () => {
        const tasks = await ev.tasks(conversation);
        return tasks.length && tasks.every((task) => DONE.has(task.status) || task.status === "waiting") ? tasks : null;
      }, options);
    },
    /** Waits until the learner has nothing left to read, so memory can be inspected. */
    async learned({ quietMs = 400, timeout = 10_000 } = {}) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const before = standIn.calls("learner").length;
        await sleep(quietMs);
        if (standIn.calls("learner").length === before || Date.now() > deadline) return;
      }
    },

    /** Stops EV the way a crash would (or cleanly) and starts it again on the same data. */
    async restart({ crash = true } = {}) { await halt(crash ? "SIGKILL" : "SIGTERM"); await boot(); },
    async crash() { await halt("SIGKILL"); },
    async start() { await boot(); },

    /** Files under EV's data and home directories whose bytes contain `text`. */
    filesContaining(text) {
      const needle = Buffer.from(text, "utf8");
      const found = [];
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) walk(path);
          else if (entry.isFile() && statSync(path).size < 64 * 1024 * 1024 && readFileSync(path).includes(needle)) found.push(path.slice(root.length + 1));
        }
      };
      walk(dataDir); walk(home);
      return found;
    },

    // ----- surfaces the plan adds; each says "not built" until its route exists
    /** Imports a session recorded by another tool into EV's store. */
    importSession({ source, path }) { return planned("importing outside sessions", "/api/assistant/import", { source, path }); },
    /** The dated history EV keeps of what happened, oldest first. */
    async timeline() { return (await planned("the memory timeline", "/api/assistant/timeline")).lines; },
    /** The same search EV1 and the agents use, as the person's own page would call it. */
    async search(query) { return (await planned("search over everything EV holds", `/api/assistant/search?q=${encodeURIComponent(query)}`)).hits; },

    async stop() {
      await halt("SIGTERM");
      await standIn.stop();
      if (!keep) rmSync(root, { recursive: true, force: true });
    }
  };
  await boot();
  return ev;
}

export function fixture(name) { return join(dirname(import.meta.dirname), "fixtures", name); }
