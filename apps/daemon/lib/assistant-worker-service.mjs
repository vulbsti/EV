import { constants } from "node:fs";
import { access, open, readFile, realpath } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePrivateDirectorySync, ensurePrivateFileSync } from "./file-permissions.mjs";

import { AssistantSupervisor } from "./assistant-supervisor.mjs";
import { reviewOpenClawReport } from "./ev-quality-gate.mjs";
import { OpenClawWorkerAdapter } from "./openclaw-worker-adapter.mjs";
import { validateOpenClawTaskReport } from "./openclaw-task-report.mjs";
import { executionPrompt, normalizeTaskPlan, planManagedTask, revisionPrompt } from "./ev-task-manager.mjs";
import { PiWorkerAdapter } from "./pi-worker-adapter.mjs";
import { ScopedWorkspace } from "./scoped-workspace.mjs";
import { renderBrief, renderReviews, renderTeam, sharedLayout, writeSharedFiles } from "./shared-workspace.mjs";
import { emptyUsage, exceededBudget, mergeUsage } from "./worker-usage.mjs";

// Worker failures that say nothing about the work itself. Workspace-only
// profiles have no external side effects, so one fresh attempt is safe.
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

function parseJsonObject(value) {
  const source = String(value ?? "").trim();
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  const candidate = fenced ?? (start >= 0 && end > start ? source.slice(start, end + 1) : "");
  try {
    const parsed = JSON.parse(candidate);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw codedError("R1_OUTPUT_INVALID", "The content worker returned malformed structured output");
  }
}

function boundedOutput(value, field, maxBytes = 64 * 1024) {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > maxBytes) {
    throw codedError("R1_OUTPUT_INVALID", `${field} must be non-empty bounded text`);
  }
  return value.trim();
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
    "extended-launch-brief-v1": Object.freeze({
      capability: "extended-launch-brief-v1",
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
    "r1-content-package-v1": Object.freeze({
      capability: "r1-content-package-v1",
      tools: Object.freeze([]),
      extensionPaths: Object.freeze([]),
      skillPaths: Object.freeze([]),
      requireContext: true,
      requireArtifact: true,
      structuredOutput: "r1-content-package-json",
      review: Object.freeze({ maxRounds: 2 }),
      timeoutMs: 180_000,
      // A real draft-review-revision pass currently lands around 20k tokens
      // because Pi reports the final turn with accumulated cached context.
      // Five live packages used 6.7k-11.8k tokens; 16k keeps measured
      // headroom for recovery variance without reopening tools or cost scope.
      budget: Object.freeze({ maxTotalTokens: 16_000, maxCostUsd: 0.03, maxToolCalls: 0 }),
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
    workerId = "ev-pi-worker-v1",
    profiles = createFixedCapabilityProfiles(),
    adapterFactory = null,
    planner = planManagedTask,
    reviewer = reviewOpenClawReport,
    maxConcurrentWorkers = Number(process.env.EV_MAX_WORKERS ?? 3),
    executable = process.env.EV_PI_EXECUTABLE ?? "pi",
    provider = process.env.EV_WORKER_PROVIDER ?? "opencode-go",
    model = process.env.EV_WORKER_MODEL ?? "deepseek-v4.1-flash",
    expectedVersion = process.env.EV_PI_VERSION ?? "0.84.4",
    timeoutMs = Number(process.env.EV_WORKER_TIMEOUT_MS ?? 120_000),
    settlementDelayMs = Number(process.env.EV_WORKER_SETTLEMENT_DELAY_MS ?? 0),
  }) {
    if (!supervisor) throw codedError("INVALID_SERVICE", "supervisor is required");
    if (typeof workerRoot !== "string" || !workerRoot) throw codedError("INVALID_SERVICE", "workerRoot is required");
    this.supervisor = supervisor;
    this.workerRoot = resolve(workerRoot);
    this.workspaceRoot = resolve(workspaceRoot);
    this.sessionRoot = resolve(sessionRoot);
    this.workerId = workerId;
    this.profiles = profiles;
    this.executable = executable;
    this.provider = provider;
    this.model = model;
    this.expectedVersion = expectedVersion;
    this.timeoutMs = timeoutMs;
    this.settlementDelayMs = Math.max(0, settlementDelayMs);
    this.activeRuns = new Map();
    this.planner = planner;
    this.reviewer = reviewer;
    this.maxConcurrentWorkers = Math.max(1, Math.min(8, Number(maxConcurrentWorkers) || 3));
    this.runningWorkers = 0;
    this.workerQueue = [];
    this.queueSequence = 0;
    this.started = false;
    this.stopping = false;
    this.adapterFactory = adapterFactory ?? (({ profile, task, workspacePath, sessionDir, contextPath }) => profile.capability === "openclaw-general-v1"
      ? new OpenClawWorkerAdapter({ taskId: task.taskId, workspacePath, sessionDir, timeoutMs: profile.timeoutMs })
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
    ensurePrivateDirectorySync(this.supervisor.artifactRoot);
    this.started = true;
    const recovery = await this.recover();
    const tasks = await this.supervisor.listTasks();
    const queued = tasks.filter((task) => task.status === "queued" && !recovery.recoveredTaskIds.includes(task.taskId));
    for (const task of queued) this._dispatch(task.taskId);
    return { recovery, taskIds: tasks.map((task) => task.taskId) };
  }

  /**
   * `layout: "shared"` starts a new goal with its own shared directory; a
   * `sharedWorkspace` puts this task on an existing goal (a child agent).
   * Either way the task works in `<goal>/tasks/<taskId>`. Without them the
   * task keeps the original one-directory-per-task layout.
   */
  async submitTask({ taskId, capability, prompt, workspace, context = null, artifact = null, metadata = null, layout = null, sharedWorkspace = null }) {
    if (this.stopping) throw codedError("WORKER_SERVICE_STOPPING", "The worker service is stopping");
    const id = safeTaskId(taskId);
    const profile = this._profile(capability);
    if (typeof prompt !== "string" || !prompt.trim()) throw codedError("INVALID_PROMPT", "prompt is required");
    let shared = null;
    if (sharedWorkspace) shared = relativePath(sharedWorkspace, "sharedWorkspace");
    else if (layout === "shared") shared = sharedLayout(id).shared;
    else if (layout !== null) throw codedError("INVALID_LAYOUT", "layout must be \"shared\" or omitted");
    const goal = shared ? shared.split("/").slice(0, -1).join("/") : null;
    const input = {
      capability: profile.capability, prompt,
      workspace: shared ? sharedLayout(goal, id).workspace : workspace ?? id,
      ...(shared ? { sharedWorkspace: shared } : {}),
      context, artifact, metadata
    };
    await this._prepareTaskInput(id, profile, input);
    const task = await this.supervisor.createTask({ taskId: id, input });
    this._dispatch(id);
    return task;
  }

  async cancelTask({ taskId, reason = "user-requested", commandId = null, expectedRevision = null }) {
    // Persist cancellation before touching the child process. This revokes the
    // fencing token so a late worker result cannot commit after cancellation.
    const command = commandId
      ? await this.supervisor.commandTask({ taskId, commandId, type: "cancel", expectedRevision, reason })
      : { replayed: false, task: await this.supervisor.cancelTask({ taskId, reason }) };
    const active = this.activeRuns.get(taskId);
    if (active) {
      active.cancelRequested = true;
      active.controller?.abort();
      this._pumpWorkers();
      if (active.run) await active.adapter.cancel(active.run, { reason });
    }
    await this._cancelChildren(taskId, reason);
    if (active) await active.promise;
    const task = await this.supervisor.getTask(taskId);
    return { ...task, replayed: command.replayed, task };
  }

  async _cancelChildren(taskId, reason) {
    const children = (await this.supervisor.listTasks()).filter((task) => task.input.metadata?.parentTaskId === taskId && !["completed", "failed", "cancelled"].includes(task.status));
    await Promise.all(children.map((task) => this.cancelTask({ taskId: task.taskId, reason })));
  }

  async recover() {
    // Calling supervisor.recover while this service owns a live run would
    // deliberately invalidate that run and start a duplicate. A same-process
    // recovery request is therefore a no-op; daemon startup has no active map.
    if (this.activeRuns.size) {
      return { recoveredTaskIds: [], skippedActiveTaskIds: [...this.activeRuns.keys()] };
    }
    const recovery = await this.supervisor.recover();
    for (const taskId of recovery.recoveredTaskIds) this._dispatch(taskId);
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

  _dispatch(taskId) {
    if (this.activeRuns.has(taskId)) return this.activeRuns.get(taskId).promise;
    const active = { taskId, run: null, runId: null, lease: null, adapter: null, cancelRequested: false, shutdownRequested: false, settlementTimer: null, releaseSettlement: null, promise: null };
    active.promise = this._execute(active).finally(() => {
      this.activeRuns.delete(taskId);
    });
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
    const total = active.plan?.budget?.maxTotalTokens && profile.capability === "openclaw-general-v1"
      ? { maxTotalTokens: active.plan.budget.maxTotalTokens, maxCostUsd: 0, maxToolCalls: -1 }
      : profile.budget;
    if (!total) return null;
    if (profile.capability !== "openclaw-general-v1") return total;
    return {
      maxTotalTokens: total.maxTotalTokens > 0 ? Math.max(1, total.maxTotalTokens - active.usage.budgetTokens) : 0,
      maxCostUsd: total.maxCostUsd > 0 ? Math.max(0.000001, total.maxCostUsd - active.usage.costUsd) : 0,
      maxToolCalls: total.maxToolCalls
    };
  }

  async _runWorker(active, prompt, { reuseCompleted = true, sessionId = active.runId } = {}) {
    if (active.isGeneral) await this._progress(active, { phase: "waiting", message: "Waiting for an available agent." });
    const release = await new Promise((resolve) => {
      this.workerQueue.push({ active, resolve, priority: this._priority(active), sequence: this.queueSequence++ });
      this._pumpWorkers();
    });
    if (!release) return { status: "cancelled" };
    let result;
    try {
      if (active.shutdownRequested || active.cancelRequested) return { status: "cancelled" };
      const budget = this._remainingBudget(active, active.profile);
      active.run = await active.adapter.start({ runId: active.runId, sessionId, prompt, reuseCompleted, budget });
      if (active.shutdownRequested || active.cancelRequested) await active.adapter.cancel(active.run, { reason: "stopped" });
      if (active.isGeneral && !active.shutdownRequested && !active.cancelRequested) await this._progress(active, { phase: "working", message: active.round > 1 ? "The agent is revising its work from EV's review." : "An agent is carrying out the request.", workerPid: active.run.child?.pid ?? null });
      result = await active.run.completion;
      await waitForWorkerExit(active.run);
    } catch (error) {
      if (active.run) { await active.adapter.cancel(active.run, { reason: "worker-interrupted" }); await waitForWorkerExit(active.run); }
      throw error;
    } finally { active.run = null; release(); }
    if (result?.usage) mergeUsage(active.usage, result.usage);
    return result;
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

  async _runManagedTask(active, task) {
    const request = task.input.metadata.sourceRequest;
    let plan = task.history.findLast((event) => event.type === "manager_plan")?.plan;
    if (!plan) {
      await this._progress(active, { phase: "planning", message: "Working out the goal and assignments." });
      active.controller = new AbortController();
      try { plan = normalizeTaskPlan(await this.planner({ taskId: task.taskId, request, context: task.input.context, signal: active.controller.signal }), request); }
      catch (error) {
        if (active.cancelRequested || active.shutdownRequested) throw error;
        plan = normalizeTaskPlan(null, request);
        plan.reason = "Planning unavailable; continuing with one execution agent.";
      } finally { active.controller = null; }
      await this._progress(active, { plan }, "manager_plan");
    }
    active.plan = normalizeTaskPlan(plan, request);
    const sharedPath = this._sharedPath(task);
    if (sharedPath) {
      await writeSharedFiles(sharedPath, {
        "BRIEF.md": renderBrief(active.plan, request),
        "CONTEXT.md": task.input.context ?? "",
        "REVIEW.md": renderReviews([])
      });
      await this._updateTeam(task);
    }
    if (!plan.subtasks.length) {
      await this._progress(active, { phase: "working", message: "An agent is carrying out the request." });
      return this._runWorker(active, executionPrompt({ request, plan: active.plan, sharedPath }));
    }
    await this._progress(active, { phase: "delegating", message: `${plan.subtasks.length} agents are working on independent parts of the goal.` });
    const children = await Promise.all(plan.subtasks.map(async (assignment, index) => {
      let previous = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (active.cancelRequested || active.shutdownRequested) return previous;
        const taskId = `${task.taskId}-child-${index + 1}${attempt ? "-retry" : ""}`;
        let child = await this.supervisor.getTask(taskId).catch(() => null);
        if (!child) {
          child = await this.submitTask({
            taskId, capability: "openclaw-general-v1",
            ...(task.input.sharedWorkspace ? { sharedWorkspace: task.input.sharedWorkspace } : { workspace: taskId }),
            context: `${task.input.context}\n\n# Assignment\n\n${assignment.instruction}`,
            prompt: executionPrompt({ request, plan: active.plan, sharedPath, assignment: `${assignment.instruction}${previous ? `\nPrevious attempt failed: ${previous.error?.message}. Its workspace is ${resolve(this.workspaceRoot, previous.input.workspace)}. Inspect that work before retrying; do not repeat completed external actions.` : ""}` }),
            metadata: { parentTaskId: task.taskId, title: assignment.title, conversationId: task.input.metadata.conversationId, sourceRequest: assignment.instruction, retryOf: previous?.taskId ?? null, attempt, verification: {} }
          });
          await this._updateTeam(task);
        } else if (child.status === "queued") this._dispatch(taskId);
        if (active.cancelRequested) await this.cancelTask({ taskId, reason: "parent-cancelled" });
        child = await this.waitForTask(taskId);
        await this._updateTeam(task);
        if (child.status !== "failed") return child;
        previous = child;
        if (!assignment.retrySafe) return child;
        if (attempt === 0) await this._progress(active, { childTaskId: child.taskId, message: `Retrying ${assignment.title}.`, code: child.error?.code }, "worker_retry");
      }
      return previous;
    }));
    if (active.cancelRequested || active.shutdownRequested) return { status: "cancelled" };
    await this._progress(active, { phase: "combining", message: "Combining the workers' results and checking the outcome." });
    const summaries = children.filter(Boolean).map((child) => ({
      taskId: child.taskId, title: child.input.metadata.title, status: child.status,
      workspacePath: resolve(this.workspaceRoot, child.input.workspace),
      report: child.result?.report ? {
        goal: child.result.report.goal, outcome: child.result.report.outcome, answer: child.result.report.answer.slice(0, 6_000),
        evidence: child.result.report.evidence.slice(0, 8), deliverables: child.result.report.deliverables,
        checks: child.result.report.checks.slice(0, 6), limitations: child.result.report.limitations.slice(0, 6)
      } : null,
      error: child.error
    }));
    active.children = children.filter(Boolean).map((child) => ({
      taskId: child.taskId, status: child.status, workspacePath: resolve(this.workspaceRoot, child.input.workspace),
      retryOf: child.input.metadata.retryOf, startedAt: child.run?.startedAt ?? null, finishedAt: child.updatedAt
    }));
    // Synthesis is a different stage from execution; never reuse an old answer
    // that was returned before these child results became available.
    return this._runWorker(active, executionPrompt({ request, plan: active.plan, children: summaries, sharedPath }), { reuseCompleted: false });
  }

  _sharedPath(task) {
    return task.input.sharedWorkspace ? resolve(this.workspaceRoot, relativePath(task.input.sharedWorkspace, "sharedWorkspace")) : null;
  }

  /** Rewrites TEAM.md from supervisor state, so it never drifts from the truth. */
  async _updateTeam(rootTask) {
    const sharedPath = this._sharedPath(rootTask);
    if (!sharedPath) return;
    const tasks = await this.supervisor.listTasks();
    const team = [rootTask, ...tasks.filter((item) => item.input.metadata?.parentTaskId === rootTask.taskId)].map((item) => {
      const current = tasks.find((candidate) => candidate.taskId === item.taskId) ?? item;
      return {
        taskId: current.taskId,
        title: current.input.metadata?.parentTaskId ? current.input.metadata.title : "Lead agent (combines and delivers)",
        status: current.status,
        retryOf: current.input.metadata?.retryOf ?? null,
        workspacePath: resolve(this.workspaceRoot, current.input.workspace),
        assignment: current.input.metadata?.parentTaskId ? current.input.metadata.sourceRequest : null,
        summary: current.result?.report ? `${current.result.report.outcome}: ${current.result.report.answer.slice(0, 280)}` : current.error?.message ?? null
      };
    });
    await writeSharedFiles(sharedPath, { "TEAM.md": renderTeam(team) }).catch(() => {});
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
      active.usage = emptyUsage();
      active.round = 1;
      active.isGeneral = profile.capability === "openclaw-general-v1";
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
      let result = active.isGeneral && task.input.metadata?.managerMode
        ? await this._runManagedTask(active, task)
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
      if (active.isGeneral) await this._cancelChildren(taskId, "parent-failed");
      if (lease && runId) {
        return await this.supervisor.failTask({
          taskId,
          runId,
          fencingToken: lease.fencingToken,
          error: { code: error.code ?? "WORKER_SERVICE_ERROR", message: error.message ?? "Worker service failed" },
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

  async _review(active, task, { request, brief, report, workspacePath, hostNotes = [], sessionPath = null }) {
    const round = active.round;
    const maxRounds = active.maxRounds;
    await this.supervisor.beginVerification({ taskId: task.taskId, runId: active.runId, fencingToken: active.lease.fencingToken, round });
    if (active.isGeneral) await this._progress(active, { phase: "checking", message: round > 1 ? `Reviewing the revised result (round ${round}).` : "Checking the result against the brief." });
    let review;
    try {
      review = await this.reviewer({
        taskId: task.taskId, request, brief, report, round, maxRounds, previousReviews: active.reviews, hostNotes,
        localRoots: [this.workspaceRoot, resolve(PROJECT_ROOT, "..")], sessionPath, workspacePath
      });
      review = { ...normalizeReviewShape(review), round };
    } catch {
      review = { verdict: "accept", pass: true, unavailable: true, round, criteria: [], missing: [], feedback: [], issues: [], caveats: ["EV's quality review was unavailable, so this result was not checked against the brief."], summary: "Review unavailable" };
    }
    active.reviews.push(review);
    await this._progress(active, { round, verdict: review.verdict, intentMatch: review.intentMatch ?? null, summary: review.summary, missing: review.missing, feedback: review.feedback, unavailable: Boolean(review.unavailable) }, "review");
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
      ? { maxTotalTokens: active.plan?.budget?.maxTotalTokens ?? 0, maxCostUsd: 0, maxToolCalls: -1 }
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
      if (profile.structuredOutput === "r1-content-package-json") await this._materializeR1StructuredOutput(task, result.text, workspacePath);
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

  async _inspectDeliverables(report, workspacePath) {
    const checks = [];
    const root = await realpath(workspacePath);
    for (const item of report.deliverables) {
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
   * revised result is reviewed again, up to the brief's review rounds and
   * token budget. Only an accepted result is delivered as completed. If the
   * rounds or budget run out first, the best result is delivered as partial
   * with exactly what is still missing.
   */
  async _finishGeneralResult(active, task, initial, workspacePath) {
    const request = task.input.metadata?.sourceRequest ?? "";
    const isChild = Boolean(task.input.metadata?.parentTaskId);
    active.plan ??= normalizeTaskPlan(null, request);
    active.reviews = [];
    active.maxRounds = isChild ? 1 : active.plan.budget.maxReviewRounds;
    const sharedPath = this._sharedPath(task);
    let result = initial;
    let best = null;
    let formatFixUsed = false;
    let stopReason = initial.stoppedAtBudget ? "budget" : null;
    for (;;) {
      let report = null;
      try { report = validateOpenClawTaskReport(result.text, { ...task.input.metadata?.verification, strictEvidence: false }); }
      catch (error) { if (error.code !== "TASK_REPORT_INVALID") throw error; }
      if (!report) {
        // Format, not quality: one chance to restate the result as a report.
        if (formatFixUsed || stopReason || active.cancelRequested || active.shutdownRequested) break;
        formatFixUsed = true;
        const repaired = await this._runWorker(active, revisionPrompt({ request, plan: active.plan, formatOnly: true, round: active.round, maxRounds: active.maxRounds, sharedPath }), { reuseCompleted: false });
        if (active.shutdownRequested || active.cancelRequested) throw codedError("STALE_FENCING_TOKEN", "Task was stopped");
        if (repaired.status === "budget_exceeded") stopReason = "budget";
        else if (repaired.status !== "completed") break;
        result = repaired;
        continue;
      }
      report.verification.childTasks = active.children ?? [];
      const deliverables = await this._inspectDeliverables(report, workspacePath);
      // Host observations go to the reviewer as evidence, not as hard rules.
      const hostNotes = [...report.verification.issues, ...deliverables.filter((item) => !item.verified).map((item) => `Declared deliverable ${item.path}: ${item.reason}.`)];
      let review = null;
      if (!isChild && report.outcome !== "blocked") {
        review = await this._review(active, task, {
          request, brief: active.plan, report, workspacePath, hostNotes,
          sessionPath: join(process.env.HOME ?? "", ".openclaw", "agents", "ev-worker", "sessions", `${task.taskId}.jsonl`)
        });
      }
      // A file the agent claims but that does not exist can never be
      // delivered, whatever the review says; that is integrity, not taste.
      const missingFiles = deliverables.filter((item) => !item.verified).map((item) => `Declared deliverable ${item.path}: ${item.reason}.`);
      const unresolved = [...new Set([...(review ? (review.pass ? [] : [...review.missing, ...review.feedback]) : report.verification.issues), ...missingFiles])];
      report.verification = {
        ...report.verification, deliverables, hostNotes,
        qualityGate: review ?? { pass: !hostNotes.length, skipped: true, issues: hostNotes, caveats: [], summary: isChild ? "Reviewed together with the combined result." : "Blocked results are delivered as reported." },
        reviews: active.reviews.map(({ round, verdict, intentMatch, summary, missing, feedback, unavailable }) => ({ round, verdict, intentMatch: intentMatch ?? null, summary, missing, feedback, unavailable: Boolean(unavailable) })),
        repairCount: active.round - 1,
        successCriteria: active.plan.successCriteria
      };
      best = { result, report, issues: unresolved };
      if (!unresolved.length || isChild || report.outcome === "blocked") break;
      if (stopReason || active.round >= active.maxRounds || this._budgetSpent(active)) {
        stopReason ??= active.round >= active.maxRounds ? "rounds" : "budget";
        break;
      }
      if (active.cancelRequested || active.shutdownRequested) throw codedError("STALE_FENCING_TOKEN", "Task was stopped");
      await this._sendBack(active, task);
      const revised = await this._runWorker(active, revisionPrompt({ request, plan: active.plan, review: review ?? { missing: hostNotes }, round: active.round - 1, maxRounds: active.maxRounds, sharedPath }), { reuseCompleted: false });
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
    if (best.issues.length && report.outcome === "completed") report.outcome = "partial";
    if (stopReason === "budget" && best.issues.length) best.issues.push("EV stopped revising because this task reached its budget.");
    report.verification.unresolvedIssues = best.issues;
    report.verification.stopReason = best.issues.length ? stopReason ?? "unfinished" : null;
    report.limitations = [...new Set([...report.limitations, ...(report.verification.qualityGate.caveats ?? []), ...best.issues])].slice(0, 14);
    return best;
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

  async _materializeR1StructuredOutput(task, text, workspacePath) {
    const value = parseJsonObject(text);
    const draft = boundedOutput(value.draft, "draft");
    const review = boundedOutput(value.review, "review");
    const final = boundedOutput(value.final, "final");
    await writeArtifact(workspacePath, "output/draft.md", Buffer.from(`${draft}\n`));
    await writeArtifact(workspacePath, "output/review.md", Buffer.from(`${review}\n`));
    await writeArtifact(workspacePath, "output/content-package.md", Buffer.from(`${final}\n`));
  }
}

export async function openAssistantWorkerService({ statePath, artifactRoot, workerRoot, ...options }) {
  const supervisor = await AssistantSupervisor.open({ statePath, artifactRoot });
  return new AssistantWorkerService({ supervisor, workerRoot, ...options });
}

export default AssistantWorkerService;
