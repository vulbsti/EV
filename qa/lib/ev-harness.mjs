// Shared plumbing for QA runners: start an isolated EV server, talk to its API,
// wait for work to settle.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const projectRoot = resolve(import.meta.dirname, "../..");
// Work with no agent on it: delivered, or on hold with everything it made.
export const RESTING = new Set(["completed", "held"]);
// A task waiting for the person's answer is settled from the harness's point of
// view: nothing more happens until someone replies.
export const SETTLED = new Set([...RESTING, "waiting"]);

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
// The daemon requires a per-start token on API calls; QA pins one per process.
const apiToken = process.env.EV_API_TOKEN || `qa-${randomUUID()}`;
const authHeaders = { Authorization: `Bearer ${apiToken}` };

export async function startServer(dataDir, logPath, { timeOffsetMs = 0, env = {} } = {}) {
  const port = await freePort();
  await mkdir(dataDir, { recursive: true });
  const preload = timeOffsetMs ? ["--import", join(projectRoot, "qa/lib/shift-clock.mjs")] : [];
  const child = spawn(process.execPath, [...preload, join(projectRoot, "apps/daemon/server.mjs")], {
    cwd: projectRoot,
    env: { ...process.env, ...env, EV_API_TOKEN: apiToken, EV_DATA_DIR: dataDir, EV_PORT: String(port), EV_HOST: "127.0.0.1", EV_QA_TIME_OFFSET_MS: String(timeOffsetMs) },
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
  const response = await fetch(`${baseUrl}${path}`, body === undefined ? { headers: authHeaders } : {
    method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${value?.error ?? ""}`);
  return value;
}

export const tasksIn = async (baseUrl, conversationId) => (await api(baseUrl, `/api/assistant/tasks?conversationId=${encodeURIComponent(conversationId)}`)).tasks;
export const memoryOf = async (baseUrl) => (await api(baseUrl, "/api/assistant/memory")).claims;
export const conversationOf = async (baseUrl, conversationId, after = 0) => (await api(baseUrl, `/api/assistant/conversation?conversationId=${encodeURIComponent(conversationId)}&after=${after}`)).messages;

/**
 * Sends one message and waits for EV's reply to it. EV saves the message and
 * acknowledges it at once; the reply arrives in the conversation.
 */
export async function say(baseUrl, conversationId, clientMessageId, text, timeoutMs = 300_000) {
  const { message } = await api(baseUrl, "/api/assistant/messages", { clientMessageId, conversationId, text });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const reply = (await conversationOf(baseUrl, conversationId)).find((candidate) => candidate.replyTo === message.messageId);
    if (reply) return reply;
    if (Date.now() > deadline) throw new Error(`EV did not answer "${text.slice(0, 60)}" within ${timeoutMs} ms`);
    await new Promise((done) => setTimeout(done, 250));
  }
}

export async function settle(baseUrl, conversationId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tasks = await tasksIn(baseUrl, conversationId);
    if (tasks.every((task) => SETTLED.has(task.status))) return { tasks, timedOut: false };
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
  const reply = await say(baseUrl, conversationId, clientMessageId, text);
  const settled = await settle(baseUrl, conversationId, timeoutMs);
  const later = (await conversationOf(baseUrl, conversationId, reply?.sequence ?? 0))
    .filter((message) => message.role === "assistant").map((message) => message.content);
  const started = settled.tasks.filter((task) => !before.has(task.taskId) && !task.parentTaskId);
  return { reply: reply?.content ?? null, later, started, timedOut: settled.timedOut };
}

/** A claim's words: a plain string (entered by hand) or the text of a learned value. */
export const claimText = (value) => typeof value === "string" ? value : typeof value?.text === "string" ? value.text : "";

/** Memory as the scorecards and judges read it: the words, with the kind, state and status that change their meaning. */
export const memoryView = (claims) => claims.map((claim) => ({ claimId: claim.claimId, scope: claim.scope, kind: claim.kind, value: claimText(claim.current?.value), state: claim.current?.value?.state ?? null, status: claim.current?.status, revision: claim.current?.revision, author: claim.current?.authorType }));

/** One line per claim, for a scorecard or a judge. */
export const memoryLine = (claim) => `- [${[claim.kind ?? claim.scope, claim.state, claim.status === "active" ? null : claim.status].filter(Boolean).join(", ")}] ${claim.value}`;
