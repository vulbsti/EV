import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import { promisify } from "node:util";
import { ensurePrivateDirectorySync, securePrivateTreeSync } from "./file-permissions.mjs";
import { TailBuffer, addCallUsage, emptyUsage, exceededBudget, writeDiagnosticsLog } from "./worker-usage.mjs";

const execFileAsync = promisify(execFile);
const MAX_RETAINED_EVENTS = 400;

/** Summed run usage, shaped so existing `usage.totalTokens` / `usage.cost.total` readers keep working. */
export function publicUsage(usage) {
  return { ...usage, totalTokens: usage.budgetTokens, cost: { total: usage.costUsd } };
}

function assistantText(event) {
  if (event?.type !== "message_end" || event.message?.role !== "assistant") return null;
  return event.message.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim() || null;
}

function workerEnvironment(overrides) {
  const allowed = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "PI_CODING_AGENT_DIR"];
  return { ...Object.fromEntries(allowed.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]])), ...overrides };
}

function terminateProcess(run, signal = "SIGTERM") {
  if (!run.child || run.child.exitCode !== null) return;
  try {
    if (process.platform !== "win32" && run.child.pid) process.kill(-run.child.pid, signal);
    else run.child.kill(signal);
  } catch {}
}

export class PiWorkerAdapter {
  constructor({
    executable = "pi",
    sessionDir,
    cwd,
    timeoutMs = 120_000,
    provider = "opencode-go",
    model = "deepseek-v4.1-flash",
    expectedVersion = null,
    tools = [],
    extensionPaths = [],
    skillPaths = [],
    contextPaths = [],
    env = {}
  }) {
    this.executable = executable;
    this.sessionDir = sessionDir;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.provider = provider;
    this.model = model;
    this.expectedVersion = expectedVersion;
    this.tools = [...tools];
    this.extensionPaths = extensionPaths.map((path) => resolve(path));
    this.skillPaths = skillPaths.map((path) => resolve(path));
    this.contextPaths = contextPaths.map((path) => resolve(path));
    this.env = env;
  }

  async start({ runId, sessionId = runId, prompt, budget = null, onUsage = null }) {
    ensurePrivateDirectorySync(this.sessionDir);
    securePrivateTreeSync(this.sessionDir);
    const command = extname(this.executable) === ".mjs" ? process.execPath : this.executable;
    const prefixArgs = command === process.execPath ? [this.executable] : [];
    if (this.expectedVersion) {
      const { stdout } = await execFileAsync(command, [...prefixArgs, "--version"], { cwd: this.cwd, env: workerEnvironment(this.env), timeout: 5_000 });
      if (!stdout.split(/\s+/).includes(this.expectedVersion)) throw Object.assign(new Error(`Expected Pi ${this.expectedVersion}`), { code: "PI_VERSION_MISMATCH" });
    }
    const argv = [
      "--mode", "json",
      ...(this.provider ? ["--provider", this.provider] : []),
      ...(this.model ? ["--model", this.model] : []),
      "--session-dir", this.sessionDir,
      "--session-id", sessionId,
      ...(this.tools.length ? ["--no-builtin-tools", "--tools", this.tools.join(",")] : ["--no-tools"]),
      "--no-extensions",
      ...this.extensionPaths.flatMap((path) => ["--extension", path]),
      "--no-skills",
      ...this.skillPaths.flatMap((path) => ["--skill", path]),
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      ...this.contextPaths.flatMap((path) => ["--append-system-prompt", path]),
      "--no-approve",
      "--print", "--", prompt
    ];
    const commandArgs = [...prefixArgs, ...argv];
    const useParentDeathSignal = process.platform === "linux" && existsSync("/usr/bin/setpriv");
    const spawnCommand = useParentDeathSignal ? "/usr/bin/setpriv" : command;
    const spawnArgs = useParentDeathSignal ? ["--pdeathsig", "SIGTERM", "--no-new-privs", "--", command, ...commandArgs] : commandArgs;
    const child = spawn(spawnCommand, spawnArgs, {
      cwd: this.cwd,
      env: workerEnvironment(this.env),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
    const run = { runId, sessionId, argv: [...argv.slice(0, -1), "[prompt omitted]"], child, cancelled: false, timedOut: false, budgetExceeded: null };
    // Parse the JSONL stream as it arrives instead of buffering all of stdout:
    // long runs never lose their final message to a size cap, and usage is
    // known while the run is still going, so the budget can stop it early.
    const usage = emptyUsage();
    const events = [];
    let finalText = null;
    let pending = "";
    const stderr = new TailBuffer();
    const stop = () => {
      terminateProcess(run);
      const escalation = setTimeout(() => terminateProcess(run, "SIGKILL"), 2_000);
      escalation.unref?.();
    };
    const handleLine = (line) => {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { return; }
      events.push(event);
      if (events.length > MAX_RETAINED_EVENTS) events.splice(0, events.length - MAX_RETAINED_EVENTS);
      if (event.type === "tool_execution_start") usage.toolCalls += 1;
      if (event.type === "message_end" && event.message?.role === "assistant") {
        addCallUsage(usage, event.message.usage);
        finalText = assistantText(event) ?? finalText;
        onUsage?.(structuredClone(usage));
      }
      const exceeded = run.budgetExceeded ? null : exceededBudget(usage, budget);
      if (exceeded) {
        run.budgetExceeded = exceeded;
        stop();
      }
    };
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) handleLine(line);
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const timer = setTimeout(() => {
      run.timedOut = true;
      stop();
    }, this.timeoutMs);
    timer.unref?.();
    run.completion = new Promise((resolve) => {
      let settled = false;
      const finish = async (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const diagnosticsLog = value.status === "completed" ? null : await writeDiagnosticsLog(this.sessionDir, runId, stderr);
        resolve({ ...value, usage: publicUsage(usage), ...(diagnosticsLog ? { diagnosticsLog } : {}) });
      };
      child.on("error", () => finish({ status: run.cancelled ? "cancelled" : "failed", code: "PI_PROCESS_START", message: "Pi worker could not start", events: [] }));
      child.on("close", (code, signal) => {
        handleLine(pending);
        pending = "";
        if (run.cancelled) return finish({ status: "cancelled", code: "PI_CANCELLED", message: "Pi worker was cancelled", events });
        if (run.budgetExceeded) return finish({ status: "budget_exceeded", code: "WORKER_BUDGET_EXCEEDED", message: `The worker reached its ${run.budgetExceeded} budget and was stopped`, text: finalText, events });
        if (run.timedOut) return finish({ status: "timed_out", code: "PI_TIMEOUT", message: "Pi worker exceeded its time budget", events });
        if (code !== 0) return finish({ status: "failed", code: "PI_PROCESS_EXIT", message: `Pi worker failed with exit code ${code ?? signal ?? "unknown"}`, events });
        if (!finalText) return finish({ status: "failed", code: "PI_EMPTY_RESULT", message: "Pi worker returned no final assistant text", events });
        finish({ status: "completed", text: finalText, events });
      });
    });
    return run;
  }

  async cancel(run, { reason = "cancelled" } = {}) {
    if (!run.child || run.child.exitCode !== null) return { status: "already_stopped", reason };
    run.cancelled = true;
    terminateProcess(run);
    const escalation = setTimeout(() => terminateProcess(run, "SIGKILL"), 2_000);
    escalation.unref?.();
    return { status: "cancelled", reason };
  }
}
