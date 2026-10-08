// Shared plumbing for QA runners: start an isolated EV server, talk to its API,
// wait for work to settle.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const projectRoot = resolve(import.meta.dirname, "../..");
export const TERMINAL = new Set(["completed", "failed", "cancelled", "not_executable"]);

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

/**
 * Starts EV with its own data directory. timeOffsetMs shifts the server's clock
 * (QA-only preload) so simulated days can pass between sessions.
 */
export async function startServer(dataDir, logPath, { timeOffsetMs = 0, env = {} } = {}) {
  const port = await freePort();
  await mkdir(dataDir, { recursive: true });
  const preload = timeOffsetMs ? ["--import", join(projectRoot, "qa/lib/shift-clock.mjs")] : [];
  const child = spawn(process.execPath, [...preload, join(projectRoot, "apps/daemon/server.mjs")], {
    cwd: projectRoot,
    env: { ...process.env, ...env, EV_DATA_DIR: dataDir, EV_PORT: String(port), EV_HOST: "127.0.0.1", EV_QA_TIME_OFFSET_MS: String(timeOffsetMs) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  child.stdout.on("data", (chunk) => { log += chunk; });
  child.stderr.on("data", (chunk) => { log += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) break;
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) {
        return { baseUrl, async stop() { child.kill("SIGTERM"); await new Promise((done) => child.once("close", done)); await writeFile(logPath, log); } };
      }
    } catch {}
    await new Promise((done) => setTimeout(done, 200));
  }
  child.kill("SIGKILL");
  await writeFile(logPath, log);
  throw new Error(`EV server did not start; see ${logPath}`);
}

export async function api(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}${path}`, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${value?.error ?? ""}`);
  return value;
}

export const tasksIn = async (baseUrl, conversationId) => (await api(baseUrl, `/api/assistant/tasks?conversationId=${encodeURIComponent(conversationId)}`)).tasks;
export const memoryOf = async (baseUrl) => (await api(baseUrl, "/api/assistant/memory")).claims;
export const conversationOf = async (baseUrl, conversationId, after = 0) => (await api(baseUrl, `/api/assistant/conversation?conversationId=${encodeURIComponent(conversationId)}&after=${after}`)).messages;

export async function settle(baseUrl, conversationId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tasks = await tasksIn(baseUrl, conversationId);
    if (tasks.every((task) => TERMINAL.has(task.status))) return { tasks, timedOut: false };
    await new Promise((done) => setTimeout(done, 2_000));
  }
  return { tasks: await tasksIn(baseUrl, conversationId), timedOut: true };
}

/**
 * Sends one message, waits for any work it started, and returns everything EV
 * said in response: the immediate reply plus updates posted when work settled.
 */
export async function converse(baseUrl, conversationId, clientMessageId, text, timeoutMs) {
  const before = new Set((await tasksIn(baseUrl, conversationId)).map((task) => task.taskId));
  const turn = await api(baseUrl, "/api/assistant/messages", { clientMessageId, conversationId, text });
  const reply = turn.messages?.find((message) => message.role === "assistant") ?? turn.messages?.at(-1);
  const settled = await settle(baseUrl, conversationId, timeoutMs);
  const later = (await conversationOf(baseUrl, conversationId, reply?.sequence ?? 0))
    .filter((message) => message.role === "assistant").map((message) => message.content);
  const started = settled.tasks.filter((task) => !before.has(task.taskId) && !task.parentTaskId);
  return { reply: reply?.content ?? null, later, started, timedOut: settled.timedOut };
}

export const memoryView = (claims) => claims.map((claim) => ({ claimId: claim.claimId, scope: claim.scope, value: claim.current?.value, revision: claim.current?.revision, author: claim.current?.authorType }));
