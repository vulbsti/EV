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
import { executionPrompt, normalizeTaskPlan, planManagedTask } from "./ev-task-manager.mjs";
import { PiWorkerAdapter } from "./pi-worker-adapter.mjs";
import { ScopedWorkspace } from "./scoped-workspace.mjs";

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
      budget: Object.freeze({ maxTotalTokens: 12_000, maxCostUsd: 0.03, maxToolCalls: 24 }),
    }),
    "extended-launch-brief-v1": Object.freeze({
      capability: "extended-launch-brief-v1",
      tools: Object.freeze(["workspace_read", "workspace_write", "workspace_list", "workspace_grep", "workspace_run"]),
      extensionPaths: Object.freeze([extension]),
      skillPaths: Object.freeze([skill]),
      requireContext: true,
      requireArtifact: true,
      budget: Object.freeze({ maxTotalTokens: 12_000, maxCostUsd: 0.03, maxToolCalls: 24 }),
    }),
    "standing-brief-v1": Object.freeze({
      capability: "standing-brief-v1",
      tools: Object.freeze(["workspace_read", "workspace_write", "workspace_list", "workspace_grep", "workspace_run"]),
      extensionPaths: Object.freeze([extension]),
      skillPaths: Object.freeze([skill]),
      requireContext: true,
      requireArtifact: true,
      budget: Object.freeze({ maxTotalTokens: 12_000, maxCostUsd: 0.03, maxToolCalls: 24 }),
    }),
    "r1-content-package-v1": Object.freeze({
      capability: "r1-content-package-v1",
      tools: Object.freeze([]),
      extensionPaths: Object.freeze([]),
      skillPaths: Object.freeze([]),
      requireContext: true,
      requireArtifact: true,
      structuredOutput: "r1-content-package-json",
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
    maxConcurrentWorkers = 3,
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

  async submitTask({ taskId, capability, prompt, workspace, context = null, artifact = null, metadata = null }) {
    if (this.stopping) throw codedError("WORKER_SERVICE_STOPPING", "The worker service is stopping");
    const id = safeTaskId(taskId);
    const profile = this._profile(capability);
    if (typeof prompt !== "string" || !prompt.trim()) throw codedError("INVALID_PROMPT", "prompt is required");
    const input = { capability: profile.capability, prompt, workspace: workspace ?? id, context, artifact, metadata };
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
    while (this.runningWorkers < this.maxConcurrentWorkers && this.workerQueue.length) {
      const entry = this.workerQueue.shift();
      this.runningWorkers++;
      entry.resolve(() => { this.runningWorkers--; this._pumpWorkers(); });
    }
  }

  async _runWorker(active, prompt, { reuseCompleted = true } = {}) {
    if (active.isGeneral) await this._progress(active, { phase: "waiting", message: "Waiting for an available agent." });
    const release = await new Promise((resolve) => { this.workerQueue.push({ active, resolve }); this._pumpWorkers(); });
    if (!release) return { status: "cancelled" };
    try {
      if (active.shutdownRequested || active.cancelRequested) return { status: "cancelled" };
      active.run = await active.adapter.start({ runId: active.runId, sessionId: active.runId, prompt, reuseCompleted });
      if (active.shutdownRequested || active.cancelRequested) await active.adapter.cancel(active.run, { reason: "stopped" });
      if (active.isGeneral && !active.shutdownRequested && !active.cancelRequested) await this._progress(active, { phase: "working", message: "An agent is carrying out the request.", workerPid: active.run.child?.pid ?? null });
      const result = await active.run.completion;
      await waitForWorkerExit(active.run);
      return result;
    } catch (error) {
      if (active.run) { await active.adapter.cancel(active.run, { reason: "worker-interrupted" }); await waitForWorkerExit(active.run); }
      throw error;
    } finally { active.run = null; release(); }
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
    active.plan = plan;
    if (!plan.subtasks.length) {
      await this._progress(active, { phase: "working", message: "An agent is carrying out the request." });
      return this._runWorker(active, executionPrompt({ request, plan }));
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
            taskId, capability: "openclaw-general-v1", workspace: taskId,
            context: `${task.input.context}\n\n# Assignment\n\n${assignment.instruction}`,
            prompt: executionPrompt({ request, plan, assignment: `${assignment.instruction}${previous ? `\nPrevious attempt failed: ${previous.error?.message}. Its workspace is ${resolve(this.workspaceRoot, previous.input.workspace)}. Inspect that work before retrying; do not repeat completed external actions.` : ""}` }),
            metadata: { parentTaskId: task.taskId, title: assignment.title, conversationId: task.input.metadata.conversationId, sourceRequest: assignment.instruction, retryOf: previous?.taskId ?? null, attempt, verification: {} }
          });
        } else if (child.status === "queued") this._dispatch(taskId);
        if (active.cancelRequested) await this.cancelTask({ taskId, reason: "parent-cancelled" });
        child = await this.waitForTask(taskId);
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
    return this._runWorker(active, executionPrompt({ request, plan, children: summaries }), { reuseCompleted: false });
  }

  async _execute(active) {
    const { taskId } = active;
    let lease;
    let runId;
    try {
      const task = await this.supervisor.getTask(taskId);
      if (task.status !== "queued") return task;
      const profile = this._profile(task.input.capability);
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
      let result = profile.capability === "openclaw-general-v1" && task.input.metadata?.managerMode
        ? await this._runManagedTask(active, task)
        : await this._runWorker(active, task.input.prompt);
      if (active.shutdownRequested) return this.supervisor.getTask(taskId);
      if (result.status === "cancelled") {
        return await this.supervisor.cancelTask({ taskId, reason: result.message ?? "worker-cancelled" });
      }
      if (result.status !== "completed") {
        return await this.supervisor.failTask({ taskId, runId, fencingToken: lease.fencingToken, error: { code: result.code ?? "WORKER_ERROR", message: result.message ?? "Worker failed" } });
      }
      const totalTokens = Number(result.usage?.totalTokens ?? 0);
      const totalCost = Number(result.usage?.cost?.total ?? 0);
      const toolCalls = (result.events ?? []).filter((event) => event.type === "tool_execution_start").length;
      if ((profile.budget.maxTotalTokens && totalTokens > profile.budget.maxTotalTokens) ||
          (profile.budget.maxCostUsd && totalCost > profile.budget.maxCostUsd) ||
          (profile.budget.maxToolCalls >= 0 && toolCalls > profile.budget.maxToolCalls)) {
        throw codedError("WORKER_BUDGET_EXCEEDED", "The worker exceeded its reviewed task budget", { totalTokens, totalCost, toolCalls });
      }
      if (profile.structuredOutput === "r1-content-package-json") {
        await this._materializeR1StructuredOutput(task, result.text, workspacePath);
      }
      let report = null;
      if (profile.capability === "openclaw-general-v1") {
        ({ result, report } = await this._finishGeneralResult(active, task, result, workspacePath));
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
      const receipts = report ? await this._materializeReportedDeliverables(task, report, workspacePath) : await this._materializeArtifacts(task, result);
      return await this.supervisor.completeTask({
        taskId,
        runId,
        fencingToken: lease.fencingToken,
        result: { text: report?.answer ?? result.text, report, usage: result.usage ?? null, profile: profile.capability },
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

  async _finishGeneralResult(active, task, initial, workspacePath) {
    const request = task.input.metadata?.sourceRequest ?? "";
    let result = initial;
    let best = null;
    for (let attempt = 0; attempt <= 1; attempt++) {
      let report = null;
      let issues = [];
      let quality = { pass: true, issues: [], caveats: [], skipped: true, summary: "Report structure and declared files checked." };
      try { report = validateOpenClawTaskReport(result.text, { ...task.input.metadata?.verification, strictEvidence: false }); }
      catch (error) { if (error.code !== "TASK_REPORT_INVALID") throw error; issues = [error.message]; }
      if (report) {
        report.verification.childTasks = active.children ?? [];
        const deliverables = await this._inspectDeliverables(report, workspacePath);
        issues = [...report.verification.issues, ...deliverables.filter((item) => !item.verified).map((item) => `Declared deliverable ${item.path}: ${item.reason}.`)];
        if (!task.input.metadata?.parentTaskId && report.outcome !== "blocked") {
          await this._progress(active, { phase: "checking", message: "Checking the result against the goal." });
          try {
            quality = await this.reviewer({
              taskId: task.taskId, request: `${request}\n\nSuccess criteria: ${JSON.stringify(active.plan?.successCriteria ?? [])}`, report,
              localRoots: [this.workspaceRoot, resolve(PROJECT_ROOT, "..")],
              sessionPath: join(process.env.HOME, ".openclaw", "agents", "ev-worker", "sessions", `${task.taskId}.jsonl`),
              workspacePath
            });
          } catch { quality = { pass: true, issues: [], caveats: ["The separate result review was unavailable; agent checks and file checks are shown."], summary: "Review unavailable", unavailable: true }; }
          if (!quality.pass) issues.push(...(quality.issues?.length ? quality.issues : [quality.summary]));
        }
        report.verification = { ...report.verification, qualityGate: quality, deliverables, repairCount: attempt, successCriteria: active.plan?.successCriteria ?? [] };
        best = { result, report, issues };
      }
      if (!issues.length || attempt === 1) break;
      const prompt = [
        "Correct these material gaps using your tools. Preserve successful work and supported coverage. Return a complete replacement JSON task report with goal, outcome, answer, evidence, deliverables, checks, limitations. If a criterion cannot be achieved, return an honest partial or blocked result instead of inventing support.",
        `Original request:\n${request}`, `Issues:\n${JSON.stringify(issues)}`,
        ...(best ? [`Previous useful result:\n${JSON.stringify(best.report)}`] : [])
      ].join("\n\n");
      const repaired = await this._runWorker(active, prompt, { reuseCompleted: false });
      if (active.shutdownRequested || active.cancelRequested) throw codedError("STALE_FENCING_TOKEN", "Task was stopped");
      if (repaired.status !== "completed") {
        if (!best) throw codedError(repaired.code ?? "WORKER_ERROR", repaired.message ?? "Worker could not produce a report");
        best.issues.push(`Correction attempt did not finish: ${repaired.message ?? repaired.status}.`);
        break;
      }
      result = repaired;
    }
    if (!best) throw codedError("TASK_REPORT_INVALID", "The worker could not produce a usable task report after one correction.");
    const { report } = best;
    if (best.issues.length && report.outcome === "completed") report.outcome = "partial";
    report.verification.unresolvedIssues = best.issues;
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

  async _materializeArtifacts(task, result) {
    const spec = task.input.artifact;
    if (!spec) return [];
    const workspacePath = resolve(this.workspaceRoot, relativePath(task.input.workspace, "workspace"));
    const workspace = await ScopedWorkspace.open(workspacePath);
    const contents = Buffer.from(await workspace.read(spec.sourcePath));
    if (task.input.capability === "extended-launch-brief-v1") {
      const text = contents.toString("utf8");
      const requiredHeadings = ["## Current state", "## Evidence", "## Risks", "## Next actions"];
      const missing = requiredHeadings.filter((heading) => !text.includes(heading));
      const usedTools = [...new Set((result.events ?? [])
        .filter((event) => event.type?.startsWith("tool_execution"))
        .map((event) => event.toolName ?? event.tool_name ?? event.name)
        .filter(Boolean))];
      const requiredTools = ["workspace_read", "workspace_write", "workspace_run"];
      if (contents.byteLength < 240 || missing.length || requiredTools.some((tool) => !usedTools.includes(tool))) {
        throw codedError("EXTENDED_ARTIFACT_INVALID", "The brief is missing required structure or scoped-tool receipts", { missing, usedTools });
      }
    }
    if (task.input.capability === "standing-brief-v1") {
      const text = contents.toString("utf8");
      const requiredHeadings = ["## Source change", "## Impact", "## Prepared response", "## Evidence"];
      const missing = requiredHeadings.filter((heading) => !text.includes(heading));
      const usedTools = [...new Set((result.events ?? [])
        .filter((event) => event.type?.startsWith("tool_execution"))
        .map((event) => event.toolName ?? event.tool_name ?? event.name)
        .filter(Boolean))];
      if (contents.byteLength < 200 || missing.length || !usedTools.includes("workspace_read") || !usedTools.includes("workspace_write")) {
        throw codedError("STANDING_ARTIFACT_INVALID", "The standing brief is missing required structure or scoped-tool receipts", { missing, usedTools });
      }
    }
    if (task.input.capability === "r1-content-package-v1") {
      const text = contents.toString("utf8");
      const requiredHeadings = [
        "## Interpreted brief",
        "## Build-in-public post",
        "## Short reel outline",
        "## Review and revision receipt",
        "## Assumptions"
      ];
      const missing = requiredHeadings.filter((heading) => !text.includes(heading));
      let draft;
      let review;
      try {
        [draft, review] = await Promise.all([
          workspace.read("output/draft.md").then((value) => Buffer.from(value)),
          workspace.read("output/review.md").then((value) => Buffer.from(value))
        ]);
      } catch {
        throw codedError("R1_ARTIFACT_INVALID", "The content package is missing its draft or review receipt");
      }
      const reviewText = review.toString("utf8");
      const missingReview = ["## Issues found", "## Revision decisions"].filter((heading) => !reviewText.includes(heading));
      const unchanged = createHash("sha256").update(draft).digest("hex") === createHash("sha256").update(contents).digest("hex");
      if (contents.byteLength < 500 || draft.byteLength < 300 || review.byteLength < 160 || missing.length || missingReview.length || unchanged) {
        throw codedError("R1_ARTIFACT_INVALID", "The content package did not prove a complete draft-review-revision cycle", {
          missing,
          missingReview,
          unchanged
        });
      }
    }
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
