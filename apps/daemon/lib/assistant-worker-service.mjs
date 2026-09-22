import { constants } from "node:fs";
import { access, open } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePrivateDirectorySync, ensurePrivateFileSync } from "./file-permissions.mjs";

import { AssistantSupervisor } from "./assistant-supervisor.mjs";
import { PiWorkerAdapter } from "./pi-worker-adapter.mjs";
import { ScopedWorkspace } from "./scoped-workspace.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function codedError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function clone(value) {
  return structuredClone(value);
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
    this.started = false;
    this.stopping = false;
    this.adapterFactory = adapterFactory ?? (({ profile, task, workspacePath, sessionDir, contextPath }) => new PiWorkerAdapter({
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
      if (active.run) await active.adapter.cancel(active.run, { reason });
      await active.promise;
    }
    const task = await this.supervisor.getTask(taskId);
    return { ...task, replayed: command.replayed, task };
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

  async _execute(active) {
    const { taskId } = active;
    let lease;
    let runId;
    try {
      const task = await this.supervisor.getTask(taskId);
      if (task.status !== "queued") return task;
      const profile = this._profile(task.input.capability);
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
      active.run = await active.adapter.start({ runId, sessionId: runId, prompt: task.input.prompt });
      if (active.shutdownRequested) await active.adapter.cancel(active.run, { reason: "daemon-shutdown" });
      if (active.cancelRequested) await active.adapter.cancel(active.run, { reason: "user-requested" });
      const result = await active.run.completion;
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
      const receipts = await this._materializeArtifacts(task, result);
      return await this.supervisor.completeTask({
        taskId,
        runId,
        fencingToken: lease.fencingToken,
        result: { text: result.text, usage: result.usage ?? null, profile: profile.capability },
        artifacts: receipts,
      });
    } catch (error) {
      const current = await this.supervisor.getTask(taskId).catch(() => null);
      if (current?.status === "cancelled" || error?.code === "STALE_FENCING_TOKEN") return current;
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
