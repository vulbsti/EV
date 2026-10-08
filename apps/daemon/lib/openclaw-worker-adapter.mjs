import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensurePrivateDirectorySync } from "./file-permissions.mjs";
import { publicUsage } from "./pi-worker-adapter.mjs";
import { TailBuffer, addCallUsage, emptyUsage, exceededBudget, writeDiagnosticsLog } from "./worker-usage.mjs";

const PROVIDER = "opencode-go";
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MODEL = "gpt-6-luna";

function stableSessionHeader(taskId) {
  const hex = createHash("sha256").update(taskId).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function openClawTaskConfig({ taskId, workspacePath }) {
  const port = 24000 + (createHash("sha256").update(`browser:${taskId}`).digest().readUInt16BE(0) % 18000);
  return {
    gateway: { port },
    browser: { enabled: true, headless: true, noSandbox: true },
    // EV owns child tasks and their lifecycle; nested OpenClaw sessions would
    // bypass the manager's worker limit, cancellation, and durable task state.
    tools: { deny: ["sessions_spawn"] },
    agents: {
      defaults: { workspace: workspacePath },
      list: [{ id: "ev-worker", workspace: workspacePath, model: `${PROVIDER}/${MODEL}` }]
    },
    models: {
      mode: "merge",
      providers: {
        [PROVIDER]: {
          baseUrl: "https://opencode.ai/zen/go/v1",
          apiKey: "${OPENCODE_API}",
          api: "openai-responses",
          headers: { "x-opencode-session": stableSessionHeader(taskId), "User-Agent": "ev-openclaw-prototype/0.1" },
          models: [{ id: MODEL, name: "GPT 6 Luna (OpenCode Go)", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272000, maxTokens: 16000 }]
        }
      }
    }
  };
}

export function parseOpenClawOutput(stdout) {
  let envelope;
  try { envelope = JSON.parse(stdout); }
  catch { return { status: "failed", code: "OPENCLAW_OUTPUT_INVALID", message: "OpenClaw did not return JSON" }; }
  const text = Array.isArray(envelope.payloads)
    ? envelope.payloads.map((payload) => payload?.text).filter((value) => typeof value === "string" && value.trim()).join("\n\n").trim()
    : "";
  if (!text) return { status: "failed", code: "OPENCLAW_EMPTY_RESULT", message: "OpenClaw returned no answer" };
  if (/^[45]\d\d\s|^error:/i.test(text) || envelope.meta?.aborted) {
    return { status: "failed", code: "OPENCLAW_PROVIDER_ERROR", message: text.slice(0, 500) };
  }
  const actual = envelope.meta?.agentMeta ?? {};
  if (actual.provider !== PROVIDER || actual.model !== MODEL) {
    return { status: "failed", code: "OPENCLAW_MODEL_MISMATCH", message: "OpenClaw did not use the selected OpenCode Go model" };
  }
  return { status: "completed", text, usage: actual.usage ?? null, events: [] };
}

async function completedSessionResult(sessionPath, afterBytes = 0) {
  const bytes = await readFile(sessionPath);
  if (bytes.length <= afterBytes) return null;
  const completeLines = bytes.subarray(afterBytes).toString("utf8").split("\n").slice(0, -1);
  for (const line of completeLines.reverse()) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const message = event?.message;
    if (event?.type !== "message" || message?.role !== "assistant" || message.stopReason !== "stop") continue;
    const answer = message.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
    if (!answer) continue;
    return parseOpenClawOutput(JSON.stringify({ payloads: [{ text: answer }], meta: { agentMeta: { provider: message.provider, model: message.model, usage: message.usage } } }));
  }
  return null;
}

/**
 * Reads session lines appended since the last call and adds their per-call
 * usage. OpenClaw writes the session file as it works, so this gives live
 * spend without waiting for the process to exit.
 */
async function accumulateSessionUsage(sessionPath, state) {
  const bytes = await readFile(sessionPath);
  if (bytes.length <= state.offset) return;
  const chunk = bytes.subarray(state.offset);
  const lastNewline = chunk.lastIndexOf(10);
  if (lastNewline < 0) return;
  state.offset += lastNewline + 1;
  for (const line of chunk.subarray(0, lastNewline).toString("utf8").split("\n")) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const message = event?.message;
    if (event?.type !== "message" || message?.role !== "assistant") continue;
    addCallUsage(state.usage, message.usage);
    state.usage.toolCalls += (message.content ?? []).filter((part) => part.type === "toolCall").length;
    const text = message.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
    if (text) state.lastText = text;
  }
}

function terminate(run, signal = "SIGTERM") {
  if (!run.child || run.child.exitCode !== null) return;
  try {
    if (process.platform !== "win32" && run.child.pid) process.kill(-run.child.pid, signal);
    else run.child.kill(signal);
  } catch {}
}

function workerEnvironment(configPath) {
  const allowed = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"];
  return {
    ...Object.fromEntries(allowed.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]])),
    OPENCODE_API: process.env.OPENCODE_API,
    OPENCLAW_CONFIG_PATH: configPath
  };
}

export class OpenClawWorkerAdapter {
  constructor({ taskId, workspacePath, sessionDir, timeoutMs = 300_000, executable = "openclaw" }) {
    this.taskId = taskId;
    this.workspacePath = workspacePath;
    this.sessionDir = sessionDir;
    this.timeoutMs = timeoutMs;
    this.executable = executable;
  }

  async start({ runId, prompt, reuseCompleted = true, budget = null, onUsage = null }) {
    if (!process.env.OPENCODE_API) {
      return { runId, completion: Promise.resolve({ status: "failed", code: "OPENCODE_KEY_MISSING", message: "OPENCODE_API is not configured" }) };
    }
    ensurePrivateDirectorySync(this.sessionDir);
    const configPath = join(this.sessionDir, "openclaw-task-config.json");
    await writeFile(configPath, JSON.stringify(openClawTaskConfig({ taskId: this.taskId, workspacePath: this.workspacePath })), { mode: 0o600 });
    const sessionPath = join(process.env.HOME, ".openclaw", "agents", "ev-worker", "sessions", `${this.taskId}.jsonl`);
    const initialSessionBytes = await stat(sessionPath).then((file) => file.size).catch(() => 0);
    if (reuseCompleted && initialSessionBytes) {
      const prior = await completedSessionResult(sessionPath).catch(() => null);
      if (prior?.status === "completed") return { runId, completion: Promise.resolve(prior) };
    }
    const child = spawn(this.executable, [
      "agent", "--local", "--agent", "ev-worker", "--session-id", this.taskId,
      "--message", prompt, "--json", "--timeout", String(Math.ceil(this.timeoutMs / 1000))
    ], {
      cwd: this.workspacePath,
      env: workerEnvironment(configPath),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
    const run = { runId, child, cancelled: false, timedOut: false, budgetExceeded: null };
    // The final answer is normally read from the session file; stdout is only a
    // fallback envelope. If it overflows, say so instead of failing to parse it.
    let stdout = "";
    let stdoutOverflow = false;
    child.stdout.on("data", (chunk) => {
      if (stdout.length + chunk.length <= MAX_STDOUT_BYTES) stdout += chunk;
      else stdoutOverflow = true;
    });
    const stderr = new TailBuffer();
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const live = { offset: initialSessionBytes, usage: emptyUsage(), lastText: null };
    const timer = setTimeout(() => {
      run.timedOut = true;
      terminate(run);
      setTimeout(() => terminate(run, "SIGKILL"), 2_000).unref?.();
    }, this.timeoutMs);
    timer.unref?.();
    run.completion = new Promise((resolve) => {
      let settled = false;
      const finish = async (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(sessionPoll);
        await accumulateSessionUsage(sessionPath, live).catch(() => {});
        const diagnosticsLog = value.status === "completed" ? null : await writeDiagnosticsLog(this.sessionDir, runId, stderr);
        resolve({ ...value, usage: publicUsage(live.usage), ...(diagnosticsLog ? { diagnosticsLog } : {}) });
      };
      let readingSession = false;
      const checkSession = async () => {
        if (settled || readingSession) return;
        readingSession = true;
        try {
          await accumulateSessionUsage(sessionPath, live);
          onUsage?.(structuredClone(live.usage));
          const exceeded = exceededBudget(live.usage, budget);
          if (exceeded) {
            run.budgetExceeded = exceeded;
            terminate(run);
            setTimeout(() => terminate(run, "SIGKILL"), 2_000).unref?.();
            return finish({ status: "budget_exceeded", code: "WORKER_BUDGET_EXCEEDED", message: `The agent reached its ${exceeded} budget and was stopped`, text: live.lastText });
          }
          const parsed = await completedSessionResult(sessionPath, initialSessionBytes);
          if (parsed) {
            finish(parsed);
            terminate(run);
            setTimeout(() => terminate(run, "SIGKILL"), 2_000).unref?.();
          }
        } catch (error) { if (error?.code !== "ENOENT") finish({ status: "failed", code: "OPENCLAW_SESSION_READ", message: "Could not inspect the OpenClaw session" }); }
        finally { readingSession = false; }
      };
      const sessionPoll = setInterval(() => { void checkSession(); }, 1_000);
      sessionPoll.unref?.();
      child.on("error", () => finish({ status: "failed", code: "OPENCLAW_PROCESS_START", message: "OpenClaw could not start" }));
      child.on("close", async (code) => {
        if (run.cancelled) return finish({ status: "cancelled", code: "OPENCLAW_CANCELLED", message: "OpenClaw task was cancelled" });
        if (run.timedOut) return finish({ status: "timed_out", code: "OPENCLAW_TIMEOUT", message: "OpenClaw exceeded the task time budget" });
        const sessionResult = await completedSessionResult(sessionPath, initialSessionBytes).catch(() => null);
        if (sessionResult) return finish(sessionResult);
        if (code !== 0) return finish({ status: "failed", code: "OPENCLAW_PROCESS_EXIT", message: `OpenClaw exited with code ${code}` });
        if (stdoutOverflow) return finish({ status: "failed", code: "OPENCLAW_OUTPUT_TOO_LARGE", message: "OpenClaw's output was too large to read and no session answer was found" });
        finish(parseOpenClawOutput(stdout));
      });
    });
    return run;
  }

  async cancel(run) {
    run.cancelled = true;
    terminate(run);
    setTimeout(() => terminate(run, "SIGKILL"), 2_000).unref?.();
    return { status: "cancelled" };
  }
}
