import { constants } from "node:fs";
import { access, open, readFile, realpath } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePrivateDirectorySync, ensurePrivateFileSync } from "./file-permissions.mjs";

import { reviewOpenClawReport } from "./ev-quality-gate.mjs";
import { OpenClawWorkerAdapter } from "./openclaw-worker-adapter.mjs";
import { readTranscript } from "./openclaw-transcript.mjs";
import { validateOpenClawTaskReport } from "./openclaw-task-report.mjs";
import { continuationPrompt, executionPrompt, revisionPrompt, workBrief, wrapUpPrompt } from "./ev-work-prompts.mjs";
import { PiWorkerAdapter } from "./pi-worker-adapter.mjs";
import { ScopedWorkspace } from "./scoped-workspace.mjs";
import { renderBrief, renderReviews, sharedLayout, writeSharedFiles } from "./shared-workspace.mjs";
import { emptyUsage, exceededBudget, mergeUsage } from "./worker-usage.mjs";

// Worker failures that say nothing about the work itself. Workspace-only
// profiles have no external side effects, so one fresh attempt is safe.
// A loop that has gone this many rounds without an accept is treated as stuck.
const ROUNDS_BEFORE_ASKING = 8;
const TRANSIENT_WORKER_CODES = new Set(["PI_PROCESS_EXIT", "PI_PROCESS_START", "PI_EMPTY_RESULT", "PI_TIMEOUT"]);
// Admission order: finish work already under way before starting new work,
// and let what the user is waiting on go ahead of background preparation.
const PRIORITY = Object.freeze({ continuing: 0, interactive: 1, background: 2 });

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function codedError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function clone(value) {
  return structuredClone(value);
}

async function waitForWorkerExit(run) {
  if (!run?.child || run.child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => run.child.once("close", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000))
  ]);
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

function workerError(result) {
  return {
    code: result.code ?? "WORKER_ERROR",
    message: result.message ?? "Worker failed",
    ...(result.diagnosticsLog ? { diagnosticsLog: result.diagnosticsLog } : {})
  };
}

/** Accepts both the review shape and the older {pass, issues} verdict. */
function normalizeReviewShape(review) {
  const pass = review?.verdict ? review.verdict === "accept" : review?.pass !== false;
  const missing = review?.missing ?? (pass ? [] : review?.issues ?? []);
  return {
    ...review,
    verdict: pass ? "accept" : "revise",
    pass,
    criteria: review?.criteria ?? [],
    missing,
    feedback: review?.feedback ?? [],
    issues: pass ? [] : review?.issues ?? missing,
    caveats: review?.caveats ?? [],
    summary: review?.summary ?? ""
  };
}

function inside(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep));
}

function relativePath(value, field) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\") || value.startsWith("/")) {
    throw codedError("INVALID_PATH", `${field} must be a non-empty relative path`);
  }
  if (value.split("/").some((segment) => !segment || segment === "..")) {
    throw codedError("PATH_ESCAPE", `${field} must stay within its scope`);
  }
  return value;
}

function safeTaskId(taskId) {
  if (taskId === undefined) return `task-${randomUUID()}`;
  if (typeof taskId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId)) {
    throw codedError("INVALID_TASK_ID", "taskId must contain only letters, digits, dot, underscore, or hyphen");
  }
  return taskId;
}

export function createFixedCapabilityProfiles({ projectRoot = PROJECT_ROOT } = {}) {
  const extension = resolve(projectRoot, "apps/worker/scoped-tools-extension.mjs");
  const skill = resolve(projectRoot, "apps/worker/skills/extended-task/SKILL.md");
  return Object.freeze({
    "no-tools-v1": Object.freeze({
      capability: "no-tools-v1",
      tools: Object.freeze([]),
      extensionPaths: Object.freeze([]),
      skillPaths: Object.freeze([]),
      requireContext: false,
      requireArtifact: false,
      budget: Object.freeze({ maxTotalTokens: 8_000, maxCostUsd: 0.02, maxToolCalls: 0 }),
    }),
    "scoped-workspace-v1": Object.freeze({
      capability: "scoped-workspace-v1",
      tools: Object.freeze(["workspace_read", "workspace_write", "workspace_list", "workspace_grep", "workspace_run"]),
      extensionPaths: Object.freeze([extension]),
      skillPaths: Object.freeze([skill]),
      requireContext: true,
      requireArtifact: true,
      // Usage is summed over every model call (cache reads excluded), so a
      // multi-step tool run needs more headroom than one final-call figure.
      budget: Object.freeze({ maxTotalTokens: 60_000, maxCostUsd: 0.03, maxToolCalls: 24 }),
      review: Object.freeze({ maxRounds: 2 }),
    }),
    "standing-brief-v1": Object.freeze({
      capability: "standing-brief-v1",
      tools: Object.freeze(["workspace_read", "workspace_write", "workspace_list", "workspace_grep", "workspace_run"]),
      extensionPaths: Object.freeze([extension]),
      skillPaths: Object.freeze([skill]),
      requireContext: true,
      requireArtifact: true,
      // Usage is summed over every model call (cache reads excluded), so a
      // multi-step tool run needs more headroom than one final-call figure.
      budget: Object.freeze({ maxTotalTokens: 60_000, maxCostUsd: 0.03, maxToolCalls: 24 }),
      review: Object.freeze({ maxRounds: 2 }),
    }),
    "openclaw-general-v1": Object.freeze({
      capability: "openclaw-general-v1",
      tools: Object.freeze([]),
      extensionPaths: Object.freeze([]),
      skillPaths: Object.freeze([]),
      requireContext: true,
      requireArtifact: false,
      timeoutMs: 300_000,
      budget: Object.freeze({ maxTotalTokens: 0, maxCostUsd: 0, maxToolCalls: -1 }),
    }),
  });
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeArtifact(root, relativeName, contents) {
  const destination = resolve(root, relativeName);
  if (!inside(root, destination) || destination === root) throw codedError("PATH_ESCAPE", "artifact destination escapes the artifact root");
  ensurePrivateDirectorySync(dirname(destination));
  const handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await handle.writeFile(contents);
  } finally {
    await handle.close();
  }
  ensurePrivateFileSync(destination);
  return destination;
}

/** Owns the in-process lifecycle around AssistantSupervisor and PiWorkerAdapter. */
export class AssistantWorkerService {
  constructor({
    supervisor,
    workerRoot,
    workspaceRoot = join(workerRoot, "workspaces"),
    sessionRoot = join(workerRoot, "sessions"),
    homeRoot = join(workerRoot, "homes"),
    workerId = "ev-pi-worker-v1",
    profiles = createFixedCapabilityProfiles(),
    adapterFactory = null,
    reviewer = reviewOpenClawReport,
    maxConcurrentWorkers = Number(process.env.EV_MAX_WORKERS ?? 3),
    onTaskSettled = null,
    executable = process.env.EV_PI_EXECUTABLE ?? "pi",
    provider = process.env.EV_WORKER_PROVIDER ?? "opencode-go",
    model = process.env.EV_WORKER_MODEL ?? "deepseek-v4.1-flash",
    expectedVersion = process.env.EV_PI_VERSION ?? "0.84.4",
    timeoutMs = Number(process.env.EV_WORKER_TIMEOUT_MS ?? 120_000),
    settlementDelayMs = Number(process.env.EV_WORKER_SETTLEMENT_DELAY_MS ?? 0),
    reviewHoldMs = (process.env.EV_REVIEW_HOLD_MS ?? "30000,120000").split(",").map(Number).filter((ms) => ms >= 0),
    // Every OpenClaw turn runs in a container (image EV_OPENCLAW_IMAGE, built
    // from docker/openclaw) that sees only its own task folder; see
    // openClawCommand. EV_OPENCLAW_SANDBOX=host runs agents uncontained, as
    // the person, and should only be used when asked for.
    openClawSandbox = process.env.EV_OPENCLAW_SANDBOX === "host" ? null : { image: process.env.EV_OPENCLAW_IMAGE || "ev-openclaw" },
  }) {
    if (!supervisor) throw codedError("INVALID_SERVICE", "supervisor is required");
    if (typeof workerRoot !== "string" || !workerRoot) throw codedError("INVALID_SERVICE", "workerRoot is required");
    this.supervisor = supervisor;
    this.workerRoot = resolve(workerRoot);
    this.workspaceRoot = resolve(workspaceRoot);
    this.sessionRoot = resolve(sessionRoot);
    this.homeRoot = resolve(homeRoot);
    this.workerId = workerId;
    this.profiles = profiles;
    this.executable = executable;
    this.provider = provider;
    this.model = model;
    this.expectedVersion = expectedVersion;
    this.timeoutMs = timeoutMs;
    this.settlementDelayMs = Math.max(0, settlementDelayMs);
    this.reviewHoldMs = reviewHoldMs;
    this.openClawSandbox = openClawSandbox;
    this.activeRuns = new Map();
    this.reviewer = reviewer;
    this.maxConcurrentWorkers = Math.max(1, Math.min(8, Number(maxConcurrentWorkers) || 3));
    this.onTaskSettled = typeof onTaskSettled === "function" ? onTaskSettled : null;
    this.runningWorkers = 0;
    this.workerQueue = [];
    this.queueSequence = 0;
    this.started = false;
    this.stopping = false;
    this.adapterFactory = adapterFactory ?? (({ profile, task, workspacePath, sessionDir, contextPath }) => profile.capability === "openclaw-general-v1"
      ? new OpenClawWorkerAdapter({
        taskId: task.taskId, workspacePath, sessionDir, timeoutMs: profile.timeoutMs, homeDir: this._home(task.taskId),
        sandbox: this.openClawSandbox && { ...this.openClawSandbox, mountRoot: task.input.sharedWorkspace ? resolve(this.workspaceRoot, dirname(task.input.sharedWorkspace)) : workspacePath }
      })
      : new PiWorkerAdapter({
      executable: this.executable,
      sessionDir,
      cwd: workspacePath,
      timeoutMs: profile.timeoutMs ?? this.timeoutMs,
      provider: this.provider,
      model: this.model,
      expectedVersion: this.expectedVersion,
      tools: profile.tools,
      extensionPaths: profile.extensionPaths,
      skillPaths: profile.skillPaths,
      contextPaths: contextPath ? [contextPath] : [],
      env: { EV_WORKSPACE_ROOT: workspacePath, EV_TASK_ID: task.taskId },
      }));
  }

  async start() {
    if (this.started) return this.snapshot();
    ensurePrivateDirectorySync(this.workerRoot);
    ensurePrivateDirectorySync(this.workspaceRoot);
    ensurePrivateDirectorySync(this.sessionRoot);
    ensurePrivateDirectorySync(this.homeRoot);
    ensurePrivateDirectorySync(this.supervisor.artifactRoot);
    this.started = true;
    const recovery = await this.recover();
    const tasks = await this.supervisor.listTasks();
    const queued = tasks.filter((task) => task.status === "queued" && !recovery.recoveredTaskIds.includes(task.taskId));
    for (const task of queued) this.dispatch(task.taskId);
    return { recovery, taskIds: tasks.map((task) => task.taskId) };
  }

  /**
   * The input for new work, checked but not yet stored: the caller stores it
   * with `supervisor.insertTask` (in its own transaction if it likes) and then
   * calls `dispatch`. `layout: "shared"` gives the work a goal folder with a
   * shared directory EV writes the brief into; the agent works in
   * `<goal>/tasks/<taskId>`. Without it the task has one directory.
   */
  newTask({ taskId, capability, prompt, workspace, context = null, artifact = null, metadata = null, layout = null }) {
    if (this.stopping) throw codedError("WORKER_SERVICE_STOPPING", "The worker service is stopping");
    const id = safeTaskId(taskId);
    const profile = this._profile(capability);
    if (typeof prompt !== "string" || !prompt.trim()) throw codedError("INVALID_PROMPT", "prompt is required");
    if (layout !== null && layout !== "shared") throw codedError("INVALID_LAYOUT", "layout must be \"shared\" or omitted");
    const shared = layout === "shared" ? sharedLayout(id) : null;
    const input = {
      capability: profile.capability, prompt,
      workspace: shared ? shared.workspace : workspace ?? id,
      ...(shared ? { sharedWorkspace: shared.shared } : {}),
      context, artifact, metadata
    };
    relativePath(input.workspace, "workspace");
    if (context !== null && (typeof context !== "string" || Buffer.byteLength(context) > 64 * 1024)) throw codedError("INVALID_CONTEXT", "context must be text no larger than 64 KB");
    return { taskId: id, input };
  }

  async submitTask(spec) {
    const { taskId, input } = this.newTask(spec);
    await this._prepareTaskInput(taskId, this._profile(input.capability), input);
    const task = await this.supervisor.createTask({ taskId, input });
    this.dispatch(taskId);
    return task;
  }

  async cancelTask({ taskId, reason = "user-requested", commandId = null, expectedRevision = null }) {
    // Persist cancellation before touching the child process. This revokes the
    // fencing token so a late worker result cannot commit after cancellation.
    const command = commandId
      ? await this.supervisor.commandTask({ taskId, commandId, type: "cancel", expectedRevision, reason })
      : { replayed: false, task: await this.supervisor.cancelTask({ taskId, reason }) };
    await this.stopRun(taskId, reason);
    const task = await this.supervisor.getTask(taskId);
    return { ...task, replayed: command.replayed, task };
  }

  /** Ends the agent run of work already marked stopped, and waits for it to wind down. */
  async stopRun(taskId, reason = "user-requested") {
    const active = this.activeRuns.get(taskId);
    if (!active) return;
    active.cancelRequested = true;
    active.controller?.abort();
    this._pumpWorkers();
    if (active.run) await active.adapter.cancel(active.run, { reason });
    await active.promise;
  }

  /**
   * Passes something the person said to unfinished work. A running agent gets
   * it at its next step in the same session; a waiting one resumes with it.
   */
  async instructTask({ taskId, text, source = null }) {
    if (typeof text !== "string" || !text.trim()) throw codedError("INVALID_INSTRUCTION", "instruction text is required");
    const task = await this.supervisor.addInstruction({ taskId, text: text.trim().slice(0, 4_000), source });
    if (task.status === "queued") this.dispatch(taskId);
    return task;
  }

  async _hasPendingInstructions(active) {
    const task = await this.supervisor.getTask(active.taskId);
    const through = task.history.findLast((event) => event.type === "instructions_applied")?.through ?? 0;
    return task.history.some((event) => event.type === "instruction" && event.sequence > through);
  }

  /** Instructions recorded since the agent last saw any, marked as seen. */
  async _takeInstructions(active) {
    const task = await this.supervisor.getTask(active.taskId);
    const through = task.history.findLast((event) => event.type === "instructions_applied")?.through ?? 0;
    const pending = task.history.filter((event) => event.type === "instruction" && event.sequence > through);
    if (!pending.length) return [];
    await this._progress(active, { through: pending.at(-1).sequence, count: pending.length }, "instructions_applied");
    const texts = pending.map((event) => event.text);
    await this._addUpdates(active, task, texts);
    return texts;
  }

  /**
   * What the person said after the brief was written becomes part of it, so
   * the agent, BRIEF.md and the reviewer all judge against the same thing.
   */
  async _addUpdates(active, task, texts) {
    if (!active.brief || !texts.length) return;
    active.brief.updates = [...(active.brief.updates ?? []), ...texts];
    const sharedPath = this._sharedPath(task);
    if (sharedPath) await writeSharedFiles(sharedPath, { "BRIEF.md": renderBrief(active.brief) }).catch(() => {});
  }

  /** Updates already applied in earlier runs of this task (before a restart or a pause). */
  _appliedUpdates(task) {
    const through = task.history.findLast((event) => event.type === "instructions_applied")?.through ?? 0;
    return task.history.filter((event) => event.type === "instruction" && event.sequence <= through).map((event) => event.text);
  }

  async recover() {
    // Calling supervisor.recover while this service owns a live run would
    // deliberately invalidate that run and start a duplicate. A same-process
    // recovery request is therefore a no-op; daemon startup has no active map.
    if (this.activeRuns.size) {
      return { recoveredTaskIds: [], skippedActiveTaskIds: [...this.activeRuns.keys()] };
    }
    const recovery = await this.supervisor.recover();
    for (const taskId of recovery.recoveredTaskIds) this.dispatch(taskId);
    return recovery;
  }

  async waitForTask(taskId) {
    const active = this.activeRuns.get(taskId);
    if (active) await active.promise;
    return this.supervisor.getTask(taskId);
  }

  async snapshot() {
    return this.supervisor.snapshot();
  }

  async shutdown() {
    this.stopping = true;
    const active = [...this.activeRuns.values()];
    for (const entry of active) {
      entry.shutdownRequested = true;
      entry.controller?.abort();
      if (entry.lease) {
        await this.supervisor.requeueTask({
          taskId: entry.taskId,
          runId: entry.runId,
          fencingToken: entry.lease.fencingToken,
          reason: "daemon-shutdown"
        }).catch((error) => {
          if (error.code !== "STALE_FENCING_TOKEN" && error.code !== "INVALID_TASK_TRANSITION") throw error;
        });
      }
      if (entry.run) await entry.adapter.cancel(entry.run, { reason: "daemon-shutdown" });
      if (entry.releaseSettlement) {
        clearTimeout(entry.settlementTimer);
        entry.releaseSettlement();
      }
    }
    this._pumpWorkers();
    await Promise.allSettled(active.map((entry) => entry.promise));
  }

  /**
   * Each piece of work's agent has its own home, made with its workspace and
   * kept with it, so its session survives a restart and no other work can
   * read what it left there. It never sees the person's own home.
   */
  _home(taskId) {
    return join(this.homeRoot, safeTaskId(taskId));
  }

  _profile(capability) {
    const profile = this.profiles[capability];
    if (!profile) throw codedError("CAPABILITY_NOT_ALLOWED", `No fixed worker profile is registered for ${capability}`);
    return profile;
  }

  async _prepareTaskInput(taskId, profile, input) {
    relativePath(input.workspace, "workspace");
    const workspacePath = resolve(this.workspaceRoot, input.workspace);
    if (!inside(this.workspaceRoot, workspacePath)) throw codedError("PATH_ESCAPE", "workspace escapes worker root");
    ensurePrivateDirectorySync(workspacePath);
    if (input.context !== null && input.context !== undefined) {
      if (typeof input.context !== "string" || Buffer.byteLength(input.context) > 64 * 1024) {
        throw codedError("INVALID_CONTEXT", "context must be text no larger than 64 KB");
      }
      await writeArtifact(workspacePath, "CONTEXT.md", Buffer.from(input.context));
    }
    if (profile.requireContext && !(await pathExists(join(workspacePath, "CONTEXT.md")))) {
      throw codedError("CONTEXT_REQUIRED", "scoped worker tasks require workspace CONTEXT.md");
    }
    if (profile.requireArtifact && (!input.artifact || typeof input.artifact.sourcePath !== "string")) {
      throw codedError("ARTIFACT_REQUIRED", "scoped worker tasks require an artifact source path");
    }
    if (input.artifact) {
      relativePath(input.artifact.sourcePath, "artifact.sourcePath");
      if (input.artifact.relativePath) relativePath(input.artifact.relativePath, "artifact.relativePath");
    }
    return workspacePath;
  }

  /** Starts (or queues for a free agent) work that is stored and queued. */
  dispatch(taskId) {
    if (this.activeRuns.has(taskId)) return this.activeRuns.get(taskId).promise;
    const active = { taskId, run: null, runId: null, lease: null, adapter: null, cancelRequested: false, shutdownRequested: false, settlementTimer: null, releaseSettlement: null, promise: null };
    active.promise = this._execute(active).finally(() => {
      this.activeRuns.delete(taskId);
    });
    // EV's main agent tells the person when work settles; a failing listener
    // must never affect the task itself.
    if (this.onTaskSettled) active.promise.then((task) => task && this.onTaskSettled(task)).catch(() => {});
    this.activeRuns.set(taskId, active);
    return active.promise;
  }

  _pumpWorkers() {
    this.workerQueue = this.workerQueue.filter((entry) => {
      if (!entry.active.cancelRequested && !entry.active.shutdownRequested) return true;
      entry.resolve(null);
      return false;
    });
    this.workerQueue.sort((left, right) => left.priority - right.priority || left.sequence - right.sequence);
    while (this.runningWorkers < this.maxConcurrentWorkers && this.workerQueue.length) {
      const entry = this.workerQueue.shift();
      this.runningWorkers++;
      entry.resolve(() => { this.runningWorkers--; this._pumpWorkers(); });
    }
  }

  _priority(active) {
    const metadata = active.task?.input?.metadata ?? {};
    if (metadata.parentTaskId || active.round > 1) return PRIORITY.continuing;
    if (metadata.kind === "standing-prepared-output" || metadata.priority === "background") return PRIORITY.background;
    return PRIORITY.interactive;
  }

  /** The budget left for this task's next run, across all its rounds. */
  _remainingBudget(active, profile) {
    const total = active.brief?.budget?.maxTotalTokens && profile.capability === "openclaw-general-v1"
      ? { maxTotalTokens: active.brief.budget.maxTotalTokens, maxCostUsd: 0, maxToolCalls: -1 }
      : profile.budget;
    if (!total) return null;
    if (profile.capability !== "openclaw-general-v1") return total;
    return {
      maxTotalTokens: total.maxTotalTokens > 0 ? Math.max(1, total.maxTotalTokens - active.usage.budgetTokens) : 0,
      maxCostUsd: total.maxCostUsd > 0 ? Math.max(0.000001, total.maxCostUsd - active.usage.costUsd) : 0,
      maxToolCalls: total.maxToolCalls
    };
  }

  async _runWorker(active, prompt, { reuseCompleted = true, sessionId = active.runId, budget: budgetOverride = null } = {}) {
    if (active.isGeneral) await this._progress(active, { phase: "waiting", message: "Waiting for an available agent." });
    const release = await new Promise((resolve) => {
      this.workerQueue.push({ active, resolve, priority: this._priority(active), sequence: this.queueSequence++ });
      this._pumpWorkers();
    });
    if (!release) return { status: "cancelled" };
    let result;
    try {
      if (active.shutdownRequested || active.cancelRequested) return { status: "cancelled" };
      const budget = budgetOverride ?? this._remainingBudget(active, active.profile);
      active.run = await active.adapter.start({ runId: active.runId, sessionId, prompt, reuseCompleted: reuseCompleted && !active.reuseBlocked, budget });
      if (active.shutdownRequested || active.cancelRequested) await active.adapter.cancel(active.run, { reason: "stopped" });
      if (active.isGeneral && !active.shutdownRequested && !active.cancelRequested) await this._progress(active, { phase: "working", message: active.round > 1 ? "The agent is revising its work from EV's review." : "An agent is carrying out the request.", workerPid: active.run.child?.pid ?? null });
      result = await active.run.completion;
      await waitForWorkerExit(active.run);
    } catch (error) {
      if (active.run) { await active.adapter.cancel(active.run, { reason: "worker-interrupted" }); await waitForWorkerExit(active.run); }
      throw error;
    } finally { active.run = null; release(); }
    if (result?.usage) {
      mergeUsage(active.usage, result.usage);
      if (active.isGeneral) await this._progress(active, { usage: { ...active.usage } }, "usage").catch(() => {});
    }
    if (active.isGeneral && result?.status === "budget_exceeded" && !active.wrappingUp && !active.cancelRequested && !active.shutdownRequested) {
      return { ...result, text: (await this._wrapUp(active)) ?? result.text };
    }
    return result;
  }

  /**
   * An agent stopped at its budget gets one short turn, in the same session,
   * to say what it finished and what is left, so a stopped run still ends
   * with something the person can use.
   */
  async _wrapUp(active) {
    active.wrappingUp = true;
    try {
      await this._progress(active, { phase: "working", message: "The agent reached its budget; asking it to write up what it finished and what is left." });
      const request = active.task.input.metadata?.sourceRequest ?? active.task.input.prompt;
      const total = active.brief?.budget?.maxTotalTokens || 0;
      const allowance = { maxTotalTokens: Math.max(40_000, Math.round(total * 0.03)), maxCostUsd: 0, maxToolCalls: -1 };
      const summary = await this._runWorker(active, wrapUpPrompt({ request, brief: active.brief ?? workBrief(active.task.input.metadata ?? {}) }), { reuseCompleted: false, budget: allowance });
      return summary.status === "completed" || summary.status === "budget_exceeded" ? summary.text || null : null;
    } finally { active.wrappingUp = false; }
  }

  /** One fresh attempt after a failure that says nothing about the work. */
  async _runWorkerWithRetry(active, prompt, options = {}) {
    const result = await this._runWorker(active, prompt, options);
    if (active.isGeneral || !TRANSIENT_WORKER_CODES.has(result?.code) || active.cancelRequested || active.shutdownRequested) return result;
    await this._progress(active, { message: "The worker stopped unexpectedly; trying once more.", code: result.code }, "worker_retry");
    return this._runWorker(active, `${prompt}\n\nA previous attempt at this task stopped unexpectedly. Check what is already in the workspace before continuing.`, { ...options, sessionId: `${active.runId}-retry` });
  }

  _progress(active, data, type = "progress") {
    return this.supervisor.recordProgress({ taskId: active.taskId, runId: active.runId, fencingToken: active.lease.fencingToken, type, data });
  }

  /** Work EV briefed: the brief goes into the goal's shared folder, and one agent takes the whole job. */
  async _runBriefed(active, task) {
    const request = task.input.metadata.sourceRequest;
    active.brief = workBrief(task.input.metadata, this._appliedUpdates(task));
    const sharedPath = this._sharedPath(task);
    if (sharedPath) {
      await writeSharedFiles(sharedPath, {
        "BRIEF.md": renderBrief(active.brief),
        "CONTEXT.md": task.input.context ?? "",
        "REVIEW.md": renderReviews(active.reviews ?? [])
      });
    }
    await this._progress(active, { phase: "working", message: "An agent is carrying out the request." });
    return this._runWorker(active, executionPrompt({ request, brief: active.brief, sharedPath }));
  }

  /**
   * Carries on a task that waited for the person. The OpenClaw session is keyed
   * by task id, so the agent resumes with its own context and files.
   */
  async _resumeParked(active, task, parked) {
    const request = task.input.metadata.sourceRequest;
    // Recorded spend already includes what was spent before the pause.
    if (!active.restoredUsage) mergeUsage(active.usage, parked.state?.usage);
    active.round = parked.state?.round ?? active.round;
    // The person has just answered, so the stuck check starts over from here.
    active.reviews = parked.state?.reviews ?? [];
    active.askedAt = { reviews: active.reviews.length, round: active.round };
    active.lastUnresolved = null;
    active.brief = workBrief(task.input.metadata, this._appliedUpdates(task));
    const answers = await this._takeInstructions(active);
    await this._progress(active, { phase: "working", message: answers.length ? "The agent is carrying on with your answer." : "The agent is carrying on where it left off." });
    return this._runWorker(active, continuationPrompt({ request, brief: active.brief, answers }), { reuseCompleted: false });
  }

  /**
   * The only host folders the reviewer may read on the agent's say-so: the
   * folder the agent itself works in (its task folder, or the goal folder it
   * shares with sibling agents). Nothing the agent could not already read.
   */
  _reviewRoots(task, workspacePath) {
    return [task.input.sharedWorkspace ? resolve(this.workspaceRoot, dirname(task.input.sharedWorkspace)) : workspacePath].filter(Boolean);
  }

  _sharedPath(task) {
    return task.input.sharedWorkspace ? resolve(this.workspaceRoot, relativePath(task.input.sharedWorkspace, "sharedWorkspace")) : null;
  }

  /**
   * A restart carries on the same review loop: spend, rounds and earlier
   * reviews are rebuilt from the task's recorded events, so the token budget
   * stays a real safety stop and the reviewer never sees round 1 again.
   */
  _restoreRunState(active, task) {
    active.usage = emptyUsage();
    active.round = 1;
    if (!active.isGeneral) return;
    const spent = task.history.findLast((event) => event.type === "usage")?.usage;
    if (spent) { Object.assign(active.usage, spent); active.restoredUsage = true; }
    const reviews = task.history.filter((event) => event.type === "review");
    if (!reviews.length) return;
    active.reviews = reviews.map(({ round, verdict, intentMatch, summary, missing, feedback, progress, askPerson, unavailable }) => ({
      round, verdict, pass: verdict === "accept", intentMatch, summary, missing: missing ?? [], feedback: feedback ?? [], issues: verdict === "accept" ? [] : missing ?? [], progress, askPerson, unavailable
    }));
    active.round = Math.max(...reviews.map((event) => Number(event.round) || 1)) + 1;
    // The answer the reviewer last sent back must not be handed in again.
    active.reuseBlocked = reviews.at(-1).verdict !== "accept";
  }

  async _execute(active) {
    const { taskId } = active;
    let lease;
    let runId;
    try {
      const task = await this.supervisor.getTask(taskId);
      if (task.status !== "queued") return task;
      const profile = this._profile(task.input.capability);
      active.task = task;
      active.profile = profile;
      active.isGeneral = profile.capability === "openclaw-general-v1";
      this._restoreRunState(active, task);
      await this._prepareTaskInput(taskId, profile, task.input);
      lease = await this.supervisor.leaseTask({ taskId, workerId: this.workerId });
      runId = randomUUID();
      active.lease = lease;
      active.runId = runId;
      await this.supervisor.startTask({ taskId, runId, fencingToken: lease.fencingToken });
      if (active.shutdownRequested) {
        await this.supervisor.requeueTask({ taskId, runId, fencingToken: lease.fencingToken, reason: "daemon-shutdown" });
        return this.supervisor.getTask(taskId);
      }
      const workspacePath = resolve(this.workspaceRoot, relativePath(task.input.workspace, "workspace"));
      const sessionDir = join(this.sessionRoot, taskId);
      ensurePrivateDirectorySync(sessionDir);
      const contextPath = profile.requireContext ? join(workspacePath, "CONTEXT.md") : null;
      active.adapter = await this.adapterFactory({ profile, task, workspacePath, sessionDir, contextPath });
      const artifactBefore = await this._artifactDigest(task, workspacePath);
      const parked = active.isGeneral ? task.history.findLast((event) => event.type === "input_needed") : null;
      let result = parked
        ? await this._resumeParked(active, task, parked)
        : active.isGeneral && task.input.metadata?.briefed
          ? await this._runBriefed(active, task)
          : await this._runWorkerWithRetry(active, task.input.prompt);
      if (active.shutdownRequested) return this.supervisor.getTask(taskId);
      if (result.status === "cancelled") {
        return await this.supervisor.cancelTask({ taskId, reason: result.message ?? "worker-cancelled" });
      }
      // A general agent stopped at its budget keeps whatever it produced;
      // review decides whether that is usable. Other profiles fail closed.
      const stoppedAtBudget = result.status === "budget_exceeded" && active.isGeneral && result.text;
      if (result.status !== "completed" && !stoppedAtBudget) {
        return await this.supervisor.failTask({ taskId, runId, fencingToken: lease.fencingToken, error: workerError(result) });
      }
      const exceeded = active.isGeneral ? null : exceededBudget(active.usage, profile.budget);
      if (exceeded) {
        throw codedError("WORKER_BUDGET_EXCEEDED", "The worker exceeded its reviewed task budget", { totalTokens: active.usage.budgetTokens, totalCost: active.usage.costUsd, toolCalls: active.usage.toolCalls });
      }
      let report = null;
      let review = null;
      if (active.isGeneral) {
        ({ result, report } = await this._finishGeneralResult(active, task, { ...result, stoppedAtBudget: Boolean(stoppedAtBudget) }, workspacePath));
      } else {
        ({ result, review } = await this._reviewArtifactResult(active, task, result, workspacePath, artifactBefore));
      }
      if (this.settlementDelayMs > 0) {
        await new Promise((resolve) => {
          active.releaseSettlement = resolve;
          active.settlementTimer = setTimeout(resolve, this.settlementDelayMs);
          active.settlementTimer.unref?.();
        });
        active.releaseSettlement = null;
        active.settlementTimer = null;
        if (active.shutdownRequested) return this.supervisor.getTask(taskId);
      }
      const receipts = report ? await this._materializeReportedDeliverables(task, report, workspacePath) : await this._materializeArtifacts(task, workspacePath);
      return await this.supervisor.completeTask({
        taskId,
        runId,
        fencingToken: lease.fencingToken,
        result: { text: report?.answer ?? result.text, report, review, usage: { ...active.usage }, profile: profile.capability },
        artifacts: receipts,
      });
    } catch (error) {
      const current = await this.supervisor.getTask(taskId).catch(() => null);
      if (current?.status === "cancelled" || error?.code === "STALE_FENCING_TOKEN") return current;
      if (error?.code === "NEEDS_INPUT" && lease && runId) {
        return await this.supervisor.waitForInput({
          taskId, runId, fencingToken: lease.fencingToken, question: error.question,
          state: { usage: active.usage, round: active.round, reviews: active.reviews ?? [], answerSoFar: String(error.answerSoFar ?? "").slice(0, 4_000) }
        }).catch(() => this.supervisor.getTask(taskId));
      }
      if (lease && runId) {
        return await this.supervisor.failTask({
          taskId,
          runId,
          fencingToken: lease.fencingToken,
          error: { code: error.code ?? "WORKER_SERVICE_ERROR", message: error.message ?? "Worker service failed", ...(error.heldAnswer ? { heldAnswer: error.heldAnswer } : {}) },
        }).catch(() => this.supervisor.getTask(taskId));
      }
      return current ?? { taskId, status: "failed", error: { code: error.code ?? "WORKER_SERVICE_ERROR", message: error.message ?? "Worker service failed" } };
    }
  }

  async _artifactDigest(task, workspacePath) {
    const sourcePath = task.input.artifact?.sourcePath;
    if (!sourcePath) return null;
    try {
      const workspace = await ScopedWorkspace.open(workspacePath);
      return createHash("sha256").update(await workspace.read(sourcePath)).digest("hex");
    } catch { return null; }
  }

  async _review(active, task, { request, brief, report, workspacePath, hostNotes = [], sessionEvents = [] }) {
    const round = active.round;
    await this.supervisor.beginVerification({ taskId: task.taskId, runId: active.runId, fencingToken: active.lease.fencingToken, round });
    if (active.isGeneral) await this._progress(active, { phase: "checking", message: round > 1 ? `Reviewing the revised result (round ${round}).` : "Checking the result against the brief." });
    // Fail closed: an unchecked result is never delivered as done. The
    // reviewer already retries provider blips; if it stays down, hold the
    // result and try again later before giving up on delivery.
    let review;
    for (let attempt = 0; ; attempt++) {
      try {
        review = await this.reviewer({
          taskId: task.taskId, request, brief, report, round, previousReviews: active.reviews, hostNotes, personal: task.input.metadata?.reviewerMemory ?? "",
          localRoots: this._reviewRoots(task, workspacePath), sessionEvents, workspacePath
        });
        review = { ...normalizeReviewShape(review), round };
        break;
      } catch (error) {
        if (active.cancelRequested || active.shutdownRequested) throw codedError("STALE_FENCING_TOKEN", "Task was stopped");
        if (attempt >= this.reviewHoldMs.length) {
          throw codedError("QUALITY_REVIEW_UNAVAILABLE", "The agent finished, but EV's quality check could not run, so the result was held back instead of delivered unchecked.", { heldAnswer: String(report.answer ?? "").slice(0, 6_000), cause: error.message });
        }
        await this._progress(active, { phase: "checking", message: "EV's quality check is unavailable; holding the result and trying again.", code: error.code ?? null });
        active.controller = new AbortController();
        try { await abortableDelay(this.reviewHoldMs[attempt], active.controller.signal); }
        catch { throw codedError("STALE_FENCING_TOKEN", "Task was stopped"); }
        finally { active.controller = null; }
      }
    }
    active.reviews.push(review);
    await this._progress(active, { round, verdict: review.verdict, intentMatch: review.intentMatch ?? null, summary: review.summary, missing: review.missing, feedback: review.feedback, progress: review.progress ?? null, askPerson: review.askPerson || null, unavailable: Boolean(review.unavailable) }, "review");
    const sharedPath = this._sharedPath(task);
    if (sharedPath) await writeSharedFiles(sharedPath, { "REVIEW.md": renderReviews(active.reviews) }).catch(() => {});
    else if (workspacePath) await writeArtifact(workspacePath, "REVIEW.md", Buffer.from(renderReviews(active.reviews))).catch(() => {});
    return review;
  }

  async _sendBack(active, task) {
    active.round += 1;
    await this.supervisor.resumeAfterReview({ taskId: task.taskId, runId: active.runId, fencingToken: active.lease.fencingToken, round: active.round });
  }

  _budgetSpent(active) {
    const budget = active.isGeneral
      ? { maxTotalTokens: active.brief?.budget?.maxTotalTokens ?? 0, maxCostUsd: 0, maxToolCalls: -1 }
      : active.profile.budget;
    return Boolean(exceededBudget(active.usage, budget));
  }

  /**
   * Fixed-profile (Pi) tasks: EV reviews the produced file against the task's
   * brief and sends it back with the reviewer's feedback until it is accepted
   * or the review rounds run out. There are no structural checks; whether the
   * file is good is the reviewer's call.
   */
  async _reviewArtifactResult(active, task, initial, workspacePath, artifactBefore) {
    if (!this.reviewer || !task.input.artifact) return { result: initial, review: null };
    const profile = active.profile;
    const brief = task.input.brief ?? {
      intent: task.input.metadata?.title ?? task.input.prompt,
      goal: task.input.prompt,
      successCriteria: task.input.metadata?.successCriteria ?? [],
      qualityBar: task.input.metadata?.qualityBar ?? []
    };
    active.reviews = [];
    active.maxRounds = Math.max(1, profile.review?.maxRounds ?? 1);
    const request = task.input.metadata?.sourceRequest ?? task.input.prompt;
    let result = initial;
    let digestBefore = artifactBefore;
    let review = null;
    for (;;) {
      const hostNotes = [];
      let contents = "";
      try {
        contents = await (await ScopedWorkspace.open(workspacePath)).read(task.input.artifact.sourcePath);
        const digest = createHash("sha256").update(contents).digest("hex");
        if (digest === digestBefore) hostNotes.push(`The deliverable ${task.input.artifact.sourcePath} was not written or changed in this round.`);
        digestBefore = digest;
      } catch { hostNotes.push(`The required deliverable ${task.input.artifact.sourcePath} does not exist.`); }
      review = await this._review(active, task, {
        request, brief, workspacePath, hostNotes,
        report: { goal: brief.goal, outcome: contents ? "completed" : "blocked", answer: contents.slice(0, 12_000) || result.text || "", evidence: [], deliverables: [{ path: task.input.artifact.sourcePath, title: "Deliverable" }], checks: [], limitations: [] }
      });
      if (review.pass && contents) break;
      if (active.round >= active.maxRounds || active.cancelRequested || active.shutdownRequested) {
        if (!contents) throw codedError("DELIVERABLE_MISSING", "The worker did not produce its deliverable");
        if (!review.pass) throw codedError("QUALITY_NOT_REACHED", `EV's review did not accept the result: ${review.summary || review.missing.join("; ")}`.slice(0, 500));
        break;
      }
      await this._sendBack(active, task);
      result = await this._runWorkerWithRetry(active, [
        task.input.prompt,
        `EV reviewed your deliverable ${task.input.artifact.sourcePath} and it is not ready yet (round ${active.round - 1} of ${active.maxRounds}). REVIEW.md in your workspace has the details.`,
        review.missing.length ? `Missing:\n${review.missing.map((item) => `- ${item}`).join("\n")}` : "",
        review.feedback.length ? `What to change:\n${review.feedback.map((item) => `- ${item}`).join("\n")}` : "",
        "Revise the deliverable in place, keep what is already good, and check the finished file again."
      ].filter(Boolean).join("\n\n"), { sessionId: `${active.runId}-r${active.round}` });
      if (result.status !== "completed") throw codedError(result.code ?? "WORKER_ERROR", result.message ?? "The revision run failed");
    }
    return { result, review };
  }

  _transcriptEvents(taskId) {
    try { return readTranscript({ homeDir: this._home(taskId), sessionId: taskId }).events; }
    catch { return []; }
  }

  async _inspectDeliverables(report, workspacePath) {
    const checks = [];
    const root = await realpath(workspacePath);
    // Agents sometimes declare paths from the goal root (tasks/<id>/file.md)
    // rather than from their own task directory.
    const fromGoalRoot = `tasks/${basename(workspacePath)}/`;
    for (const item of report.deliverables) {
      if (item.path.startsWith(fromGoalRoot)) item.path = item.path.slice(fromGoalRoot.length);
      try {
        const path = resolve(workspacePath, item.path);
        const actual = await realpath(path);
        if (actual === root || /(?:^|\/)(?:\.env(?:\..*)?|\.ssh|[^/]*(?:secret|credential)[^/]*)(?:\/|$)|\.(?:pem|key|p12)$/i.test(actual)) throw new Error("not a reviewable deliverable");
        const handle = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.size > 20_000_000) throw new Error("not a file under 20 MB");
          const downloadable = inside(root, actual);
          checks.push({ path: item.path, verified: true, downloadable, bytes: info.size, ...(downloadable ? { sha256: createHash("sha256").update(await handle.readFile()).digest("hex") } : { existenceOnly: true }) });
        } finally { await handle.close(); }
      } catch (error) { checks.push({ path: item.path, verified: false, reason: error.code === "ENOENT" ? "File does not exist" : "File could not be verified in this task workspace" }); }
    }
    return checks;
  }

  /**
   * The review loop for general agents. EV reviews the agent's report against
   * the brief; when the reviewer asks for changes, its feedback goes back to
   * the same agent session (which keeps its context and files) and the
   * revised result is reviewed again, until the reviewer accepts it. Only an
   * accepted result is delivered as completed. When the loop is stuck (the
   * reviewer needs the person, or rounds stop making progress), the person is
   * asked instead of being handed half-done work, and the same session
   * carries on with their answer. The token budget is a safety stop: past it, the best result is
   * delivered as partial with exactly what is still missing.
   */
  async _finishGeneralResult(active, task, initial, workspacePath) {
    const request = task.input.metadata?.sourceRequest ?? "";
    active.brief ??= workBrief(task.input.metadata ?? {});
    active.reviews ??= [];
    active.askedAt ??= { reviews: 0, round: 1 };
    const sharedPath = this._sharedPath(task);
    let result = initial;
    let best = null;
    let formatFixUsed = false;
    let stopReason = initial.stoppedAtBudget ? "budget" : null;
    // One follow-up run in the same session; a budget stop keeps its text.
    const followUp = async (prompt) => {
      const next = await this._runWorker(active, prompt, { reuseCompleted: false });
      if (active.shutdownRequested || active.cancelRequested) throw codedError("STALE_FENCING_TOKEN", "Task was stopped");
      if (next.status === "budget_exceeded" && next.text) stopReason = "budget";
      else if (next.status !== "completed") throw codedError(next.code ?? "WORKER_ERROR", next.message ?? "The agent stopped before finishing");
      return next;
    };
    for (;;) {
      // Whatever the person said about this work while it ran goes to the
      // agent before its result is judged, in the same session.
      const instructions = stopReason ? [] : await this._takeInstructions(active);
      if (instructions.length) {
        await this._progress(active, { phase: "working", message: "The agent is taking your new instructions into account." });
        result = await followUp(continuationPrompt({ request, brief: active.brief, instructions }));
        continue;
      }
      let report = null;
      try { report = validateOpenClawTaskReport(result.text, { ...task.input.metadata?.verification, strictEvidence: false }); }
      catch (error) { if (error.code !== "TASK_REPORT_INVALID") throw error; }
      if (report?.outcome === "needs_input") {
        if (active.cancelRequested || active.shutdownRequested) throw codedError("STALE_FENCING_TOKEN", "Task was stopped");
        throw codedError("NEEDS_INPUT", report.question, { question: report.question, answerSoFar: report.answer });
      }
      if (!report) {
        // Format, not quality: one chance to restate the result as a report.
        if (formatFixUsed || stopReason || active.cancelRequested || active.shutdownRequested) break;
        formatFixUsed = true;
        const repaired = await this._runWorker(active, revisionPrompt({ request, brief: active.brief, formatOnly: true, round: active.round, sharedPath }), { reuseCompleted: false });
        if (active.shutdownRequested || active.cancelRequested) throw codedError("STALE_FENCING_TOKEN", "Task was stopped");
        if (repaired.status === "budget_exceeded") stopReason = "budget";
        else if (repaired.status !== "completed") break;
        result = repaired;
        continue;
      }
      const deliverables = await this._inspectDeliverables(report, workspacePath);
      // Host observations go to the reviewer as evidence, not as hard rules.
      const hostNotes = [...report.verification.issues, ...deliverables.filter((item) => !item.verified).map((item) => `Declared deliverable ${item.path}: ${item.reason}.`)];
      let review = null;
      if (report.outcome !== "blocked") {
        review = await this._review(active, task, {
          request, brief: active.brief, report, workspacePath, hostNotes,
          sessionEvents: this._transcriptEvents(task.taskId)
        });
      }
      // A file the agent claims but that does not exist can never be
      // delivered, whatever the review says; that is integrity, not taste.
      const missingFiles = deliverables.filter((item) => !item.verified).map((item) => `Declared deliverable ${item.path}: ${item.reason}.`);
      const unresolved = [...new Set([...(review ? (review.pass ? [] : [...review.missing, ...review.feedback]) : report.verification.issues), ...missingFiles])];
      report.verification = {
        ...report.verification, deliverables, hostNotes,
        qualityGate: review ?? { pass: !hostNotes.length, skipped: true, issues: hostNotes, caveats: [], summary: "Blocked results are delivered as reported." },
        reviews: active.reviews.map(({ round, verdict, intentMatch, summary, missing, feedback, unavailable }) => ({ round, verdict, intentMatch: intentMatch ?? null, summary, missing, feedback, unavailable: Boolean(unavailable) })),
        repairCount: active.round - 1
      };
      best = { result, report, issues: unresolved };
      if (!unresolved.length || report.outcome === "blocked") {
        // Something the person said while the review ran must reach the work
        // before it is delivered, even when the review passed.
        if (!stopReason && await this._hasPendingInstructions(active)) continue;
        break;
      }
      if (stopReason || this._budgetSpent(active)) {
        stopReason ??= "budget";
        break;
      }
      if (active.cancelRequested || active.shutdownRequested) throw codedError("STALE_FENCING_TOKEN", "Task was stopped");
      const question = this._stuckQuestion(active, review, unresolved);
      if (question) throw codedError("NEEDS_INPUT", question, { question, answerSoFar: report.answer });
      await this._sendBack(active, task);
      const revised = await this._runWorker(active, revisionPrompt({ request, brief: active.brief, review: review ?? { missing: hostNotes }, round: active.round - 1, sharedPath }), { reuseCompleted: false });
      if (active.shutdownRequested || active.cancelRequested) throw codedError("STALE_FENCING_TOKEN", "Task was stopped");
      if (revised.status === "budget_exceeded" && revised.text) { stopReason = "budget"; result = revised; continue; }
      if (revised.status !== "completed") {
        best.issues.push(`The revision round did not finish: ${revised.message ?? revised.status}.`);
        break;
      }
      result = revised;
    }
    if (!best) throw codedError("TASK_REPORT_INVALID", "The worker could not produce a usable task report after one correction.");
    const { report } = best;
    // A budget stop is unfinished work even when the reviewer liked the write-up.
    if (stopReason === "budget") best.issues.push("EV stopped this task because it reached its budget.");
    if (best.issues.length && report.outcome === "completed") report.outcome = "partial";
    report.verification.unresolvedIssues = best.issues;
    report.verification.stopReason = best.issues.length ? stopReason ?? "unfinished" : null;
    report.limitations = [...new Set([...report.limitations, ...(report.verification.qualityGate.caveats ?? []), ...best.issues])].slice(0, 14);
    return best;
  }

  /**
   * The question to put to the person when the review loop cannot finish on
   * its own: the reviewer says only they can unblock it, the last two rounds
   * made no progress, or it has gone on too long. Null while it is improving.
   */
  _stuckQuestion(active, review, unresolved) {
    if (review?.askPerson) return review.askPerson;
    const since = active.reviews.slice(active.askedAt.reviews);
    // Stalled: the reviewer says so twice running, or the open points did not change.
    const key = JSON.stringify(unresolved);
    const unchanged = active.lastUnresolved === key;
    active.lastUnresolved = key;
    const stalled = unchanged || (since.length >= 2 && since.slice(-2).every((item) => item.progress === "stalled"));
    if (!stalled && active.round - active.askedAt.round < ROUNDS_BEFORE_ASKING) return null;
    const open = unresolved.slice(0, 3).join("; ").slice(0, 400);
    return `I've gone back and forth with the agent and it isn't getting closer on: ${open}. Should I deliver it without those, or is there something that would help?`;
  }

  async _materializeReportedDeliverables(task, report, workspacePath) {
    const receipts = [];
    for (const [index, item] of report.deliverables.entries()) {
      const checked = report.verification.deliverables.find((check) => check.path === item.path);
      if (!checked?.verified || !checked.downloadable) continue;
      const contents = await readFile(resolve(workspacePath, item.path));
      if (createHash("sha256").update(contents).digest("hex") !== checked.sha256) {
        report.outcome = "partial";
        report.limitations.push(`Deliverable ${item.path} changed after verification.`);
        continue;
      }
      const relativeName = `${task.taskId}/${index + 1}-${basename(item.path)}`;
      await writeArtifact(this.supervisor.artifactRoot, relativeName, contents);
      receipts.push({ artifactId: randomUUID(), title: item.title || basename(item.path), relativePath: relativeName, sha256: checked.sha256, bytes: contents.length });
    }
    return receipts;
  }

  async _materializeArtifacts(task, workspacePath = resolve(this.workspaceRoot, relativePath(task.input.workspace, "workspace"))) {
    const spec = task.input.artifact;
    if (!spec) return [];
    const workspace = await ScopedWorkspace.open(workspacePath);
    const contents = Buffer.from(await workspace.read(spec.sourcePath));
    const relativeName = `${task.taskId}/${spec.relativePath ?? basename(spec.sourcePath)}`;
    relativePath(relativeName, "artifact destination");
    await writeArtifact(this.supervisor.artifactRoot, relativeName, contents);
    return [{ artifactId: randomUUID(), relativePath: relativeName, sha256: createHash("sha256").update(contents).digest("hex"), bytes: contents.byteLength }];
  }
}

export default AssistantWorkerService;
