import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { modelSettings } from "./ev-model.mjs";
import { ensurePrivateDirectorySync } from "./file-permissions.mjs";
import { publicUsage } from "./pi-worker-adapter.mjs";
import { readTranscript } from "./openclaw-transcript.mjs";
import { TailBuffer, addCallUsage, emptyUsage, exceededBudget, writeDiagnosticsLog } from "./worker-usage.mjs";

const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
// OpenClaw has a clock of its own per turn (600 s unless told otherwise). EV
// watches progress instead (stallMs), so that clock is set out of the way.
const OPENCLAW_TURN_SECONDS = 7 * 24 * 60 * 60;
// Agents use the model EV_MODEL names (its API shape and base URL come from
// the same record as EV's own calls); EV_OPENCLAW_MODEL picks a different one.
const workerModel = () => modelSettings(process.env, process.env.EV_OPENCLAW_MODEL || undefined);

// Key-free web search. The ev-openclaw image bakes the DuckDuckGo plugin in;
// on the host, EV_OPENCLAW_SEARCH_PLUGIN names an npm-installed copy
// (npm i --prefix <dir> @openclaw/duckduckgo-plugin, then
// <dir>/node_modules/@openclaw/duckduckgo-plugin).
const IMAGE_SEARCH_PLUGIN = "/usr/local/lib/node_modules/@openclaw/duckduckgo-plugin";
export function searchPluginPath(sandbox, env = process.env) {
  if (sandbox) return IMAGE_SEARCH_PLUGIN;
  const path = env.EV_OPENCLAW_SEARCH_PLUGIN;
  return path && existsSync(path) ? path : null;
}

function stableSessionHeader(taskId) {
  const hex = createHash("sha256").update(taskId).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function openClawTaskConfig({ taskId, workspacePath, searchPlugin = null }) {
  const model = workerModel();
  const primary = `${model.provider}/${model.id}`;
  const port = 24000 + (createHash("sha256").update(`browser:${taskId}`).digest().readUInt16BE(0) % 18000);
  return {
    gateway: { port },
    browser: { enabled: true, headless: true, noSandbox: true },
    // EV owns child tasks and their lifecycle; nested OpenClaw sessions would
    // bypass the manager's worker limit, holds, and durable task state.
    tools: { deny: ["sessions_spawn"], ...(searchPlugin ? { web: { search: { provider: "duckduckgo" } } } : {}) },
    // A plugin loaded by path has no install record; allow names it as trusted.
    ...(searchPlugin ? { plugins: { load: { paths: [searchPlugin] }, entries: { duckduckgo: { enabled: true } }, allow: ["duckduckgo"] } } : {}),
    agents: {
      defaults: {
        workspace: workspacePath,
        // Long tool loops stay affordable: old, large tool results are trimmed
        // and then cleared (the last three turns are kept whole), and context
        // is checked before each model call inside a turn.
        contextPruning: { mode: "cache-ttl", ttl: "5m" },
        compaction: { midTurnPrecheck: { enabled: true } },
        model: { primary }
      },
      entries: { "ev-worker": { workspace: workspacePath, model: { primary } } }
    },
    models: {
      mode: "merge",
      providers: {
        [model.provider]: {
          baseUrl: model.baseUrl,
          apiKey: "${OPENCODE_API}",
          api: model.api,
          headers: { "x-opencode-session": stableSessionHeader(taskId), "User-Agent": "ev-openclaw-prototype/0.1" },
          models: [{ id: model.id, name: model.name ?? model.id, reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272000, maxTokens: 16000, ...(model.api.startsWith("openai") ? { compat: { supportsPromptCacheKey: true } } : {}) }]
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
  const model = workerModel();
  if (actual.provider !== model.provider || actual.model !== model.id) {
    return { status: "failed", code: "OPENCLAW_MODEL_MISMATCH", message: "OpenClaw did not use the selected model" };
  }
  return { status: "completed", text, usage: actual.usage ?? null, events: [] };
}

/** The agent's last finished answer among these transcript events, if any. */
function completedResult(events) {
  for (const event of [...events].reverse()) {
    const message = event?.message;
    if (event?.type !== "message" || message?.role !== "assistant" || message.stopReason !== "stop") continue;
    const answer = message.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
    if (!answer) continue;
    return parseOpenClawOutput(JSON.stringify({ payloads: [{ text: answer }], meta: { agentMeta: { provider: message.provider, model: message.model, usage: message.usage } } }));
  }
  return null;
}

/**
 * Reads transcript events written since the last call and adds their
 * per-call usage. OpenClaw records the transcript as it works, so this gives
 * live spend without waiting for the process to exit.
 */
function accumulateUsage(events, state) {
  for (const event of events) {
    const message = event?.message;
    if (event?.type !== "message" || message?.role !== "assistant") continue;
    addCallUsage(state.usage, message.usage);
    state.usage.toolCalls += (message.content ?? []).filter((part) => part.type === "toolCall").length;
    const text = message.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
    if (text) state.lastText = text;
  }
}

/**
 * The command that runs one OpenClaw turn. With a sandbox it runs inside a
 * container that sees only the goal's directory, this task's config and its
 * own home, under CPU, memory and process caps, as the person's
 * own user (so files it writes stay theirs) and never as root on the host.
 * Paths are mounted at the same absolute location, so prompts stay valid.
 */
export function openClawCommand({ executable, args, sandbox, workspacePath, sessionDir, homeDir, runId, taskId, containerName = `ev-openclaw-${runId.slice(0, 12)}` }) {
  if (!sandbox) return { command: executable, args };
  const mounts = [...new Set([sandbox.mountRoot, homeDir])].flatMap((path) => ["-v", `${path}:${path}`]);
  return {
    command: "docker",
    args: [
      "run", "--rm", "--init", "--name", containerName, "--label", `ev.task=${taskId}`,
      "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      "--cpus", String(sandbox.cpus ?? 2), "--memory", sandbox.memory ?? "4g", "--pids-limit", "1024", "--shm-size", "1g",
      "--security-opt", "no-new-privileges", "--cap-drop", "ALL",
      ...mounts, "-v", `${sessionDir}:${sessionDir}:ro`, "-w", workspacePath,
      "-e", `HOME=${homeDir}`, "-e", "OPENCODE_API", "-e", "OPENCLAW_CONFIG_PATH",
      sandbox.image, executable, ...args
    ]
  };
}

/** Removes containers left by an earlier run of this task (a crash or restart). */
export function removeTaskContainers(taskId) {
  return new Promise((resolve) => {
    const list = spawn("docker", ["ps", "-aq", "--filter", `label=ev.task=${taskId}`], { stdio: ["ignore", "pipe", "ignore"] });
    let ids = "";
    list.stdout.on("data", (chunk) => { ids += chunk; });
    list.on("error", () => resolve());
    list.on("close", () => {
      const found = ids.split(/\s+/).filter(Boolean);
      if (!found.length) return resolve();
      spawn("docker", ["rm", "-f", ...found], { stdio: "ignore" }).on("close", () => resolve()).on("error", () => resolve());
    });
  });
}

function terminate(run, signal = "SIGTERM") {
  // A finished run leaves containers alone: the task's next run (a wrap-up
  // or revision) may already have started under the same label.
  if (!run.child || run.child.exitCode !== null || run.child.signalCode !== null) return;
  // Signals reach the docker client, not necessarily the container.
  if (run.sandboxed && signal === "SIGKILL") spawn("docker", ["rm", "-f", run.containerName], { stdio: "ignore" }).on("error", () => {});
  try {
    if (process.platform !== "win32" && run.child.pid) process.kill(-run.child.pid, signal);
    else run.child.kill(signal);
  } catch {}
}

/** The command line of a live process, or null when there is none. */
function commandLine(pid) {
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " "); } catch {}
  try { return execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { return null; }
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };

/**
 * Stops what a run left behind when EV died under it: its process group (only
 * if that pid still belongs to this work's agent, since a pid can be reused)
 * and its container. Resolves once the process is gone.
 */
export async function stopLeftoverRun({ taskId, pid, container }) {
  if (container) await new Promise((resolve) => spawn("docker", ["rm", "-f", container], { stdio: "ignore" }).on("close", resolve).on("error", resolve));
  if (!pid || !commandLine(pid)?.includes(taskId)) return;
  for (const target of [-pid, pid]) { try { process.kill(target, "SIGKILL"); } catch {} }
  for (let waited = 0; alive(pid) && waited < 5_000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
}

function workerEnvironment(configPath, homeDir) {
  const allowed = ["PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"];
  return {
    ...Object.fromEntries(allowed.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]])),
    HOME: homeDir,
    OPENCODE_API: process.env.OPENCODE_API,
    OPENCLAW_CONFIG_PATH: configPath
  };
}

export class OpenClawWorkerAdapter {
  /**
   * stallMs is the watchdog: an agent whose session shows nothing new for
   * that long is stopped and reported as stalled. One that keeps making
   * progress is never stopped for taking long.
   */
  constructor({ taskId, workspacePath, sessionDir, homeDir, stallMs = 600_000, executable = "openclaw", sandbox = null }) {
    this.taskId = taskId;
    this.homeDir = homeDir;
    this.sandbox = sandbox;
    this.workspacePath = workspacePath;
    this.sessionDir = sessionDir;
    this.stallMs = stallMs;
    this.executable = executable;
  }

  async start({ runId, prompt, reuseCompleted = true, budget = null, onUsage = null, onProgress = null }) {
    if (!process.env.OPENCODE_API) {
      return { runId, completion: Promise.resolve({ status: "failed", code: "OPENCODE_KEY_MISSING", message: "OPENCODE_API is not configured" }) };
    }
    ensurePrivateDirectorySync(this.sessionDir);
    const configPath = join(this.sessionDir, "openclaw-task-config.json");
    await writeFile(configPath, JSON.stringify(openClawTaskConfig({ taskId: this.taskId, workspacePath: this.workspacePath, searchPlugin: searchPluginPath(this.sandbox) })), { mode: 0o600 });
    const transcript = (afterSeq) => readTranscript({ homeDir: this.homeDir, sessionId: this.taskId, afterSeq });
    const earlier = transcript(0);
    if (reuseCompleted && earlier.events.length) {
      const prior = completedResult(earlier.events);
      if (prior?.status === "completed") return { runId, completion: Promise.resolve(prior) };
    }
    ensurePrivateDirectorySync(this.homeDir);
    if (this.sandbox) await removeTaskContainers(this.taskId);
    // Each start gets its own container name: runs of one task can share a run id.
    const containerName = `ev-openclaw-${runId.slice(0, 12)}-${randomBytes(3).toString("hex")}`;
    const { command, args } = openClawCommand({
      containerName, executable: this.executable, sandbox: this.sandbox, workspacePath: this.workspacePath, sessionDir: this.sessionDir, homeDir: this.homeDir, runId, taskId: this.taskId,
      args: ["agent", "--local", "--agent", "ev-worker", "--session-id", this.taskId, "--message", prompt, "--json", "--timeout", String(OPENCLAW_TURN_SECONDS)]
    });
    const child = spawn(command, args, {
      cwd: this.workspacePath,
      env: workerEnvironment(configPath, this.homeDir),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
    const run = { runId, child, stopped: false, budgetExceeded: null, taskId: this.taskId, sandboxed: Boolean(this.sandbox), containerName };
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
    // Only this turn's events count: usage, and the answer it finished with.
    // Anything new in the session is a sign of progress.
    const live = { seq: earlier.lastSeq, usage: emptyUsage(), lastText: null, events: [], progressAt: Date.now() };
    const readNew = () => {
      const { events, lastSeq } = transcript(live.seq);
      live.seq = lastSeq;
      live.events.push(...events);
      accumulateUsage(events, live);
      if (events.length) { live.progressAt = Date.now(); onProgress?.(); }
    };
    run.completion = new Promise((resolve) => {
      let settled = false;
      const finish = async (value) => {
        if (settled) return;
        settled = true;
        clearInterval(sessionPoll);
        try { readNew(); } catch {}
        const diagnosticsLog = value.status === "completed" ? null : await writeDiagnosticsLog(this.sessionDir, runId, stderr);
        resolve({ ...value, usage: publicUsage(live.usage), ...(diagnosticsLog ? { diagnosticsLog } : {}) });
      };
      let readingSession = false;
      const checkSession = async () => {
        if (settled || readingSession) return;
        readingSession = true;
        try {
          readNew();
          onUsage?.(structuredClone(live.usage));
          const exceeded = exceededBudget(live.usage, budget);
          if (exceeded) {
            run.budgetExceeded = exceeded;
            terminate(run);
            setTimeout(() => terminate(run, "SIGKILL"), 2_000).unref?.();
            return finish({ status: "budget_exceeded", code: "WORKER_BUDGET_EXCEEDED", message: `The agent reached its ${exceeded} budget and was stopped`, text: live.lastText });
          }
          const parsed = completedResult(live.events);
          if (parsed) {
            finish(parsed);
            terminate(run);
            setTimeout(() => terminate(run, "SIGKILL"), 2_000).unref?.();
          } else if (Date.now() - live.progressAt > this.stallMs) {
            terminate(run);
            setTimeout(() => terminate(run, "SIGKILL"), 2_000).unref?.();
            return finish({ status: "stalled", code: "AGENT_STALLED", message: `The agent showed no progress for ${Math.round(this.stallMs / 1000)} s` });
          }
        } catch { finish({ status: "failed", code: "OPENCLAW_SESSION_READ", message: "Could not inspect the OpenClaw session" }); }
        finally { readingSession = false; }
      };
      const sessionPoll = setInterval(() => { void checkSession(); }, Math.min(1_000, Math.max(100, this.stallMs / 4)));
      sessionPoll.unref?.();
      child.on("error", () => finish({ status: "failed", code: "OPENCLAW_PROCESS_START", message: "OpenClaw could not start" }));
      child.on("close", async (code) => {
        if (run.stopped) return finish({ status: "stopped", code: "OPENCLAW_STOPPED", message: "The agent was stopped" });
        let sessionResult = null;
        try { readNew(); sessionResult = completedResult(live.events); } catch {}
        if (sessionResult) return finish(sessionResult);
        if (code !== 0) return finish({ status: "failed", code: "OPENCLAW_PROCESS_EXIT", message: `OpenClaw exited with code ${code}` });
        if (stdoutOverflow) return finish({ status: "failed", code: "OPENCLAW_OUTPUT_TOO_LARGE", message: "OpenClaw's output was too large to read and no session answer was found" });
        finish(parseOpenClawOutput(stdout));
      });
    });
    return run;
  }

  async stop(run) {
    run.stopped = true;
    terminate(run);
    setTimeout(() => terminate(run, "SIGKILL"), 2_000).unref?.();
  }
}
