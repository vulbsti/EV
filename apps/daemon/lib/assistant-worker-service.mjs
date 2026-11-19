import { constants } from "node:fs";
import { access, open, readFile, realpath, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePrivateDirectorySync, ensurePrivateFileSync } from "./file-permissions.mjs";

import { reviewOpenClawReport } from "./ev-quality-gate.mjs";
import { OpenClawWorkerAdapter, stopLeftoverRun } from "./openclaw-worker-adapter.mjs";
import { readTranscript } from "./openclaw-transcript.mjs";
import { validateOpenClawTaskReport } from "./openclaw-task-report.mjs";
import { continuationPrompt, executionPrompt, revisionPrompt, steeredPrompt, workBrief, wrapUpPrompt } from "./ev-work-prompts.mjs";
import { PiWorkerAdapter } from "./pi-worker-adapter.mjs";
import { ScopedWorkspace } from "./scoped-workspace.mjs";
import { renderBrief, renderReviews, sharedLayout, writeSharedFiles } from "./shared-workspace.mjs";
import { emptyUsage, exceededBudget, mergeUsage } from "./worker-usage.mjs";
import { StepMaker } from "./live-steps.mjs";

// A loop that has gone this many rounds without an accept is treated as stuck.
const ROUNDS_BEFORE_ASKING = 8;
// An agent that crashes or goes silent is restarted in its own session this
// many times in a row; after that the person is asked, and nothing is lost.
const RESTARTS_BEFORE_ASKING = 3;
// Worker failures that say nothing about the work itself. Workspace-only
// profiles have no external side effects, so one fresh attempt is safe.
const TRANSIENT_WORKER_CODES = new Set(["PI_PROCESS_EXIT", "PI_PROCESS_START", "PI_EMPTY_RESULT", "PI_STALLED"]);
// Admission order: finish work already under way before starting new work,
// and let what the user is waiting on go ahead of background preparation.
const PRIORITY = Object.freeze({ continuing: 0, interactive: 1, background: 2 });
// The "now" line follows the agent's newest step, at most this often so a
// burst of steps is one write; a change of phase goes out at once.
const NOW_EVERY_MS = 2_000;
// Steering waits this long for the agent's running step to finish before it
// cuts the step short (and tells the agent it may be half done).
const STEER_WAIT_MS = Number(process.env.EV_STEER_WAIT_MS ?? 120_000);
// Files EV writes into a work folder, and files that may hold secrets: never shown as a draft.
const NOT_DRAFTS = /(?:^|\/)(?:CONTEXT|BRIEF|REVIEW)\.md$|(?:^|\/)(?:\.|node_modules\/)|(?:^|\/)(?:\.env(?:\..*)?|\.ssh|[^/]*(?:secret|credential)[^/]*)(?:\/|$)|\.(?:pem|key|p12)$/i;
const DRAFT_BYTES = 256 * 1024;
// A step's output, as shown when opened: cut in the middle past this (Codex keeps 64 KB).
const OUTPUT_BYTES = 64 * 1024;

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function codedError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function clone(value) {
  return structuredClone(value);
}

/**
 * What the person is asked when work cannot get past a problem on its own.
 * Work never ends on a problem: it waits for their answer with everything
 * it made, and carries on in the same session.
 */
function problemQuestion(error) {
  if (error.code === "QUALITY_REVIEW_UNAVAILABLE") return "The work is finished, but my quality check couldn't run, so I've held the result back instead of handing it over unchecked. Shall I try again?";
  const reason = String(error.message ?? "it stopped unexpectedly").trim().replace(/[.!?]$/, "");
  return `The agent couldn't get past a problem (${reason}). Everything it made so far is kept. Shall it try again, or go about it differently?`;
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
    // The watchdog: an agent that shows no progress for this long is restarted.
    stallMs = Number(process.env.EV_WORKER_STALL_MS ?? 600_000),
    settlementDelayMs = Number(process.env.EV_WORKER_SETTLEMENT_DELAY_MS ?? 0),
    reviewHoldMs = (process.env.EV_REVIEW_HOLD_MS ?? "30000,120000").split(",").map(Number).filter((ms) => ms >= 0),
    // Every OpenClaw turn runs in a container (image EV_OPENCLAW_IMAGE, built
    // from docker/openclaw) that sees only its own task folder; see
    // openClawCommand. EV_OPENCLAW_SANDBOX=host runs agents uncontained, as
    // the person, and should only be used when asked for.
    openClawSandbox = process.env.EV_OPENCLAW_SANDBOX === "host" ? null : { image: process.env.EV_OPENCLAW_IMAGE || "ev-openclaw" },
    // How agents reach their model without a key (model-relay.mjs).
    relay = null,
    // What the agents' model account waits for, or null when it is usable
    // (the daemon passes workerAccountWait).
    accountWait = () => null
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
    this.stallMs = stallMs;
    this.settlementDelayMs = Math.max(0, settlementDelayMs);
    this.reviewHoldMs = reviewHoldMs;
    this.openClawSandbox = openClawSandbox;
    this.relay = relay;
    this.accountWait = accountWait;
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
        taskId: task.taskId, workspacePath, sessionDir, stallMs: this.stallMs, homeDir: this._home(task.taskId), relay: this.relay,
        sandbox: this.openClawSandbox && { ...this.openClawSandbox, mountRoot: task.input.sharedWorkspace ? resolve(this.workspaceRoot, dirname(task.input.sharedWorkspace)) : workspacePath }
      })
      : new PiWorkerAdapter({
      executable: this.executable,
      sessionDir,
      cwd: workspacePath,
      stallMs: this.stallMs,
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

  /**
   * Puts work on hold. The hold is stored before the agent is touched: that
   * revokes the run's fencing token, so nothing it hands in later can land.
   * Its session, workspace and files stay, ready to carry on.
   */
  async holdTask({ taskId, reason = "user-requested", commandId = null, expectedRevision = null }) {
    const command = commandId
      ? await this.supervisor.commandTask({ taskId, commandId, type: "hold", expectedRevision, reason })
      : { replayed: false, held: this.supervisor.hold(taskId, { reason }) };
    await this.stopRun(taskId);
    return { replayed: command.replayed, task: await this.supervisor.getTask(taskId) };
  }

  /** Ends the agent run of work already put on hold, and waits for it to wind down. */
  async stopRun(taskId) {
    const active = this.activeRuns.get(taskId);
    if (!active) return;
    active.stopRequested = true;
    active.controller?.abort();
    this._pumpWorkers();
    if (active.run) await active.adapter.stop(active.run);
    await active.promise;
  }

  /**
   * Passes something the person said to a piece of work. A running agent gets
   * it at its next step in the same session; waiting, held or delivered work
   * carries on with it.
   */
  async instructTask({ taskId, text, source = null }) {
    if (typeof text !== "string" || !text.trim()) throw codedError("INVALID_INSTRUCTION", "instruction text is required");
    const task = await this.supervisor.addInstruction({ taskId, text: text.trim().slice(0, 4_000), source });
    if (task.status === "queued") this.dispatch(taskId);
    return task;
  }

  /**
   * Brings what the person just said to a running agent now rather than when
   * its turn ends. An agent cannot be handed a message mid-run (GitHub issue
   * 27), so EV stops it and resumes the same session with the message:
   * "next" waits for the step it is in to finish (at most STEER_WAIT_MS),
   * "interrupt" stops it at once. Either way nothing is lost; a step cut
   * short is named to the agent as possibly half done. Returns whether a
   * running agent was reached; otherwise the message waits for its next turn.
   */
  steer(taskId, { mode = "next" } = {}) {
    const active = this.activeRuns.get(taskId);
    if (!active?.isGeneral || !active.run || active.stopRequested || active.shutdownRequested) return false;
    if (active.steering) {
      if (mode === "interrupt") this._steerStop(active);
      return true;
    }
    // "next" waits for the step under way when the message came, not for a
    // quiet moment: a busy agent may start its next step in the same read.
    const waitFor = active.maker?.running()?.id ?? null;
    active.steering = { mode, waitFor };
    if (mode === "interrupt" || !waitFor) this._steerStop(active);
    else {
      active.steering.timer = setTimeout(() => this._steerStop(active), STEER_WAIT_MS);
      active.steering.timer.unref?.();
    }
    return true;
  }

  _steerStop(active) {
    const steering = active.steering;
    if (!steering || steering.stopping || !active.run) return;
    clearTimeout(steering.timer);
    steering.stopping = true;
    const running = active.maker?.running();
    steering.cut = Boolean(running);
    if (running) this._steps(active, [{ ...running, label: `${running.label} (cut short to pass on your message)`, cut: true }]);
    active.adapter.stop(active.run, { steer: true }).catch(() => {});
  }

  /** Work on hold carries on as it was, replay-safe by the page's command id. */
  async carryOnTask({ taskId, commandId, expectedRevision = null }) {
    const command = await this.supervisor.commandTask({ taskId, commandId, type: "carry_on", expectedRevision });
    const task = await this.supervisor.getTask(taskId);
    if (task.status === "queued") this.dispatch(taskId);
    return { replayed: command.replayed, task };
  }

  /**
   * What an agent has made so far in its work folder: drafts, not reviewed,
   * read-only. EV's own files and anything that may hold a secret are left out.
   */
  async drafts(taskId) {
    const task = await this.supervisor.getTask(taskId);
    const root = resolve(this.workspaceRoot, relativePath(task.input.workspace, "workspace"));
    let workspace;
    try { workspace = await ScopedWorkspace.open(root); } catch { return []; }
    const files = [];
    const walk = async (dir, depth) => {
      if (depth > 4 || files.length >= 200) return;
      let entries = [];
      try { entries = await workspace.list(dir); } catch { return; }
      for (const entry of entries) {
        if (NOT_DRAFTS.test(entry.path)) continue;
        if (entry.type === "directory") await walk(entry.path, depth + 1);
        else if (entry.type === "file" && files.length < 200) {
          try { const info = await stat(join(workspace.root, entry.path)); files.push({ path: entry.path, bytes: info.size, modifiedAt: info.mtime.toISOString() }); } catch {}
        }
      }
    };
    await walk(".", 0);
    return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }

  /** One draft's text as it is now (up to DRAFT_BYTES), never anything outside the work folder. */
  async draft(taskId, path) {
    if (typeof path !== "string" || !path || NOT_DRAFTS.test(path)) throw codedError("DRAFT_NOT_FOUND", "No such draft");
    const task = await this.supervisor.getTask(taskId);
    const workspace = await ScopedWorkspace.open(resolve(this.workspaceRoot, relativePath(task.input.workspace, "workspace")));
    let info;
    try { info = await stat(join(workspace.root, relativePath(path, "path"))); } catch { throw codedError("DRAFT_NOT_FOUND", "No such draft"); }
    if (!info.isFile()) throw codedError("DRAFT_NOT_FOUND", "No such draft");
    const meta = { path, bytes: info.size, modifiedAt: info.mtime.toISOString(), reviewed: false };
    if (info.size > DRAFT_BYTES) return { ...meta, tooLarge: true };
    const bytes = Buffer.from(await workspace.read(path, { encoding: "latin1", maxBytes: DRAFT_BYTES }), "latin1");
    if (bytes.includes(0)) return { ...meta, binary: true };
    return { ...meta, text: bytes.toString("utf8") };
  }

  /**
   * What one step printed, read from the agent's own transcript when asked
   * (it is not copied into EV's store), cut in the middle to OUTPUT_BYTES.
   * Null when the transcript no longer has it.
   */
  stepOutput(taskId, stepId) {
    const result = this._transcriptEvents(taskId).find((event) => event?.message?.role === "toolResult" && event.message.toolCallId === stepId)?.message;
    if (!result) return null;
    const text = String(result.details?.aggregated ?? (result.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n"));
    const bytes = Buffer.from(text);
    if (bytes.length <= OUTPUT_BYTES) return { text, cut: 0 };
    const half = OUTPUT_BYTES / 2;
    return { text: `${bytes.subarray(0, half).toString("utf8")}\n… ${bytes.length - OUTPUT_BYTES} bytes cut …\n${bytes.subarray(bytes.length - half).toString("utf8")}`, cut: bytes.length - OUTPUT_BYTES };
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
    this._steps(active, pending.map((event) => ({ kind: "told", label: `Got your message: ${event.text}`.slice(0, 300), instruction: event.sequence })));
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
    // A run with no recorded end was live when EV died: its agent may still
    // be running. It is stopped before anything else takes over that work.
    for (const run of this.supervisor.liveRuns()) {
      await stopLeftoverRun(run).catch(() => {});
      this.supervisor.endRun(run.runId, "EV restarted");
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
      if (entry.run) await entry.adapter.stop(entry.run);
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
    const active = { taskId, run: null, runId: null, lease: null, adapter: null, stopRequested: false, shutdownRequested: false, settlementTimer: null, releaseSettlement: null, promise: null };
    active.promise = this._execute(active).finally(() => {
      this.activeRuns.delete(taskId);
      // Work put on hold and sent something again before its old run had
      // wound down is queued once more: it starts now, in the same session.
      if (active.lease && !this.stopping) this.supervisor.getTask(taskId).then((task) => { if (task.status === "queued") this.dispatch(taskId); }).catch(() => {});
    });
    // EV's main agent tells the person when work settles; a failing listener
    // must never affect the task itself.
    if (this.onTaskSettled) active.promise.then((task) => task && this.onTaskSettled(task)).catch(() => {});
    this.activeRuns.set(taskId, active);
    return active.promise;
  }

  _pumpWorkers() {
    this.workerQueue = this.workerQueue.filter((entry) => {
      if (!entry.active.stopRequested && !entry.active.shutdownRequested) return true;
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

  /**
   * One prompt to the agent. An agent that crashes or goes silent past the
   * stall limit is restarted in the same session, with its files, a few
   * times; if it still cannot get on, its last result goes back to the
   * caller, which puts the problem to the person.
   */
  async _runWorker(active, prompt, options = {}) {
    let result = await this._runSteerable(active, prompt, options);
    for (let restart = 1; active.isGeneral && ["failed", "stalled"].includes(result?.status) && restart <= RESTARTS_BEFORE_ASKING; restart++) {
      if (active.stopRequested || active.shutdownRequested) break;
      // The agent stopped because its model account is limited or signed
      // out: the work waits for the account, and that is not a restart.
      const wait = this.accountWait();
      if (wait) {
        await this._holdForAccount(active, wait, "the agent");
        restart--;
        result = await this._runSteerable(active, `You were interrupted while working on this. Check what is already in your workspace and carry on from where you left off.\n\n${prompt}`, { ...options, reuseCompleted: false, phase: "Carrying on now the account is back" });
        continue;
      }
      this._steps(active, [{ kind: "restarted", label: `The agent stopped (${result.message ?? result.status}), so it was restarted in the same session`, code: result.code ?? null }]);
      result = await this._runSteerable(active, `You were interrupted while working on this. Check what is already in your workspace and carry on from where you left off.\n\n${prompt}`, { ...options, reuseCompleted: false, phase: "Restarted in the same session; carrying on" });
    }
    return result;
  }

  /** One agent turn, resumed in the same session each time the person steers it. */
  async _runSteerable(active, prompt, options = {}) {
    let result = await this._runOnce(active, prompt, options);
    while (result?.status === "steered" && !active.stopRequested && !active.shutdownRequested) {
      const cut = Boolean(active.steering?.cut);
      active.steering = null;
      const instructions = await this._takeInstructions(active);
      const metadata = active.task.input.metadata ?? {};
      result = await this._runOnce(active, steeredPrompt({ request: metadata.sourceRequest ?? active.task.input.prompt, brief: active.brief ?? workBrief(metadata), instructions, cut }), { ...options, reuseCompleted: false, phase: "Taking your message into account" });
    }
    active.steering = null;
    return result;
  }

  /** One agent turn. `phase` is the "now" line once it is under way. */
  async _runOnce(active, prompt, { reuseCompleted = true, sessionId = active.runId, budget: budgetOverride = null, phase = "Working" } = {}) {
    if (active.isGeneral && this.runningWorkers >= this.maxConcurrentWorkers) await this._phase(active, "Waiting for an available agent");
    const release = await new Promise((resolve) => {
      this.workerQueue.push({ active, resolve, priority: this._priority(active), sequence: this.queueSequence++ });
      this._pumpWorkers();
    });
    if (!release) return { status: "stopped" };
    let result;
    // The run's own row: its process, its last sign of progress, how it ended.
    const runRow = randomUUID();
    let opened = false;
    let notedAt = 0;
    const onProgress = () => {
      if (!opened || Date.now() - notedAt < 2_000) return;
      notedAt = Date.now();
      try { this.supervisor.runProgress(runRow); } catch {}
    };
    // What the agent does, read from its transcript as it works: finished
    // steps go out at once, the step running now becomes the "now" line.
    const maker = new StepMaker({ runId: runRow });
    active.maker = maker;
    const onEvents = (events) => {
      const { done, running } = maker.add(events);
      const latest = running ?? done.at(-1);
      this._steps(active, done, latest && { text: latest.label, step: { id: latest.id, kind: latest.kind, startedAt: latest.startedAt, running: Boolean(running) }, model: maker.model });
      // Once the step steering waits for has finished, the message goes in; a
      // step the agent already began after it is the one cut short.
      if (active.steering && !maker.isOpen(active.steering.waitFor)) this._steerStop(active);
    };
    try {
      if (active.shutdownRequested || active.stopRequested) return { status: "stopped" };
      const budget = budgetOverride ?? this._remainingBudget(active, active.profile);
      active.run = await active.adapter.start({ runId: active.runId, sessionId, prompt, reuseCompleted: reuseCompleted && !active.reuseBlocked, budget, onProgress, onEvents });
      if (active.run.child?.pid) {
        this.supervisor.openRun({ runId: runRow, taskId: active.taskId, pid: active.run.child.pid, container: active.run.sandboxed ? active.run.containerName : null });
        opened = true;
      }
      if (active.shutdownRequested || active.stopRequested) await active.adapter.stop(active.run);
      if (active.isGeneral && !active.shutdownRequested && !active.stopRequested) await this._phase(active, phase);
      result = await active.run.completion;
      await waitForWorkerExit(active.run);
    } catch (error) {
      if (active.run) { await active.adapter.stop(active.run); await waitForWorkerExit(active.run); }
      throw error;
    } finally {
      if (opened) { try { this.supervisor.endRun(runRow, result ? `${result.status}${result.code ? ` (${result.code})` : ""}` : "interrupted"); } catch {} }
      clearTimeout(active.nowTimer);
      active.nowTimer = null;
      active.pendingNow = null;
      active.run = null;
      release();
    }
    if (result?.usage) {
      mergeUsage(active.usage, result.usage);
      if (active.isGeneral) await this._progress(active, { usage: { ...active.usage } }, "usage").catch(() => {});
    }
    if (active.isGeneral && result?.status === "budget_exceeded" && !active.wrappingUp && !active.stopRequested && !active.shutdownRequested) {
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
      const request = active.task.input.metadata?.sourceRequest ?? active.task.input.prompt;
      const total = active.brief?.budget?.maxTotalTokens || 0;
      const allowance = { maxTotalTokens: Math.max(40_000, Math.round(total * 0.03)), maxCostUsd: 0, maxToolCalls: -1 };
      const summary = await this._runWorker(active, wrapUpPrompt({ request, brief: active.brief ?? workBrief(active.task.input.metadata ?? {}) }), { reuseCompleted: false, budget: allowance, phase: "Reached its budget; writing up what it finished and what is left" });
      return summary.status === "completed" || summary.status === "budget_exceeded" ? summary.text || null : null;
    } finally { active.wrappingUp = false; }
  }

  /** One fresh attempt after a failure that says nothing about the work. */
  async _runWorkerWithRetry(active, prompt, options = {}) {
    const result = await this._runWorker(active, prompt, options);
    if (active.isGeneral || !TRANSIENT_WORKER_CODES.has(result?.code) || active.stopRequested || active.shutdownRequested) return result;
    this._steps(active, [{ kind: "restarted", label: "The worker stopped unexpectedly, so it is trying once more", code: result.code ?? null }]);
    return this._runWorker(active, `${prompt}\n\nA previous attempt at this task stopped unexpectedly. Check what is already in the workspace before continuing.`, { ...options, sessionId: `${active.runId}-retry` });
  }

  _progress(active, data, type) {
    return this.supervisor.recordProgress({ taskId: active.taskId, runId: active.runId, fencingToken: active.lease.fencingToken, type, data });
  }

  /**
   * A change of phase, as the "now" line, at once; the agent's first step
   * after it replaces it at once too. Like any write of this run, it fails
   * once the run is no longer current.
   */
  async _phase(active, text) {
    clearTimeout(active.nowTimer);
    active.nowTimer = null;
    active.pendingNow = null;
    active.nowAt = 0;
    this.supervisor.recordLive({ taskId: active.taskId, runId: active.runId, fencingToken: active.lease.fencingToken, now: { text } });
  }

  /**
   * Finished steps (stored at once) and the "now" line they suggest (at most
   * every NOW_EVERY_MS; a later one replaces one still waiting). A run that
   * is no longer current writes nothing, and the agent never waits for this.
   */
  _steps(active, steps = [], now = null) {
    const at = new Date().toISOString();
    const stamped = steps.map((step) => ({ id: step.id ?? randomUUID(), startedAt: step.startedAt ?? at, endedAt: step.endedAt ?? at, ...step }));
    let line = null;
    if (now) {
      const wait = (active.nowAt ?? 0) + NOW_EVERY_MS - Date.now();
      if (wait <= 0) { clearTimeout(active.nowTimer); active.nowTimer = null; active.pendingNow = null; active.nowAt = Date.now(); line = now; }
      else {
        active.pendingNow = now;
        if (!active.nowTimer) {
          active.nowTimer = setTimeout(() => { active.nowTimer = null; if (active.pendingNow) this._steps(active, [], active.pendingNow); }, wait);
          active.nowTimer.unref?.();
        }
      }
    }
    if (!stamped.length && !line) return;
    try { this.supervisor.recordLive({ taskId: active.taskId, runId: active.runId, fencingToken: active.lease?.fencingToken, steps: stamped, now: line }); }
    catch (error) { if (!["STALE_FENCING_TOKEN", "INVALID_TASK_TRANSITION", "TASK_NOT_FOUND"].includes(error.code)) throw error; }
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
    return this._runWorker(active, executionPrompt({ request, brief: active.brief, sharedPath }), { phase: "Starting on the work" });
  }

  /**
   * Carries on work that has run before, in the same session (keyed by task
   * id) with its own context and files: after the person answered its
   * question, after it was held or delivered and they came back to it, or
   * after EV restarted under it. Spend, rounds and reviews come from its
   * recorded events (see _restoreRunState).
   */
  async _carryOn(active, task) {
    const request = task.input.metadata.sourceRequest;
    active.brief = workBrief(task.input.metadata, this._appliedUpdates(task));
    // Where it stood before this run: waiting for an answer, resting, or interrupted.
    const stood = task.history.findLast((event) => ["input_needed", "held", "completed", "recovered", "interrupted"].includes(event.type))?.type;
    const asked = stood === "input_needed";
    const resting = stood === "held" || stood === "completed";
    // The person has just answered, so the stuck check starts over from here.
    if (asked || resting) active.askedAt = { reviews: active.reviews?.length ?? 0, round: active.round };
    const said = await this._takeInstructions(active);
    const prompt = continuationPrompt({ request, brief: active.brief, answers: asked ? said : [], instructions: asked || resting ? [] : said, cameBack: resting ? { after: stood, said } : null });
    // Only an interrupted run may hand in an answer it finished while EV was down.
    return this._runWorker(active, prompt, { reuseCompleted: !asked && !resting && !said.length, phase: asked ? "Carrying on with your answer" : resting ? "Picking this work back up" : "Carrying on where it left off" });
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
    if (spent) Object.assign(active.usage, spent);
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
      let result = active.isGeneral && task.history.some((event) => event.type === "started")
        ? await this._carryOn(active, task)
        : active.isGeneral && task.input.metadata?.briefed
          ? await this._runBriefed(active, task)
          : await this._runWorkerWithRetry(active, task.input.prompt, { phase: "Starting on the work" });
      if (active.shutdownRequested) return this.supervisor.getTask(taskId);
      // Stopped because it was put on hold: the hold already says so.
      if (result.status === "stopped") return await this.supervisor.getTask(taskId);
      // A general agent stopped at its budget keeps whatever it produced;
      // review decides whether that is usable.
      const stoppedAtBudget = result.status === "budget_exceeded" && active.isGeneral && result.text;
      if (result.status !== "completed" && !stoppedAtBudget) throw codedError(result.code ?? "WORKER_ERROR", result.message ?? "The agent stopped before finishing");
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
      // Held or restarted under it: nothing more to record.
      if (error?.code === "STALE_FENCING_TOKEN" || !lease || !runId) return this.supervisor.getTask(taskId).catch(() => null);
      // Its question, or a problem it could not get past: either way the
      // person is asked, and the work waits with everything it made.
      const question = error?.code === "NEEDS_INPUT" ? error.question : problemQuestion(error ?? {});
      this._steps(active, [{ kind: "asked", label: `Asked you: ${question}`.slice(0, 300) }]);
      return await this.supervisor.waitForInput({
        taskId, runId, fencingToken: lease.fencingToken, question,
        state: { answerSoFar: String(error?.answerSoFar ?? error?.heldAnswer ?? "").slice(0, 4_000), ...(error?.code === "NEEDS_INPUT" ? {} : { problem: error?.code ?? "WORKER_ERROR" }) }
      }).catch(() => this.supervisor.getTask(taskId));
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

  /**
   * Waits until the model account `wait` names may be usable again: its
   * reset time, or a minute when it waits for the person (a sign-in, an
   * account). Says so once on the work. Throws if the work is stopped.
   */
  async _holdForAccount(active, wait, who) {
    const message = wait.until ? `Waiting for ${who}'s model: the ${wait.providerName} account is limited until ${wait.until}.` : `Waiting for ${who}'s model: the ${wait.providerName} account ${wait.reason === "none" ? "is not connected" : "needs a new sign-in"}.`;
    if (message !== active.holding) await this._phase(active, message.replace(/\.$/, ""));
    active.holding = message;
    active.controller = new AbortController();
    try { await abortableDelay(wait.until ? Math.max(1_000, Date.parse(wait.until) - Date.now() + 500) : 60_000, active.controller.signal); }
    catch { throw codedError("STALE_FENCING_TOKEN", "Task was stopped"); }
    finally { active.controller = null; }
  }

  async _review(active, task, { request, brief, report, workspacePath, hostNotes = [], sessionEvents = [] }) {
    const round = active.round;
    await this.supervisor.beginVerification({ taskId: task.taskId, runId: active.runId, fencingToken: active.lease.fencingToken, round });
    if (active.isGeneral) await this._phase(active, round > 1 ? `Checking the revised result (round ${round})` : "Checking the result against the brief");
    // Fail closed: an unchecked result is never delivered as done. The
    // reviewer already retries provider blips; if it stays down, hold the
    // result and try again later before giving up on delivery.
    let review;
    for (let attempt = 0; ; attempt++) {
      try {
        review = await this.reviewer({
          taskId: task.taskId, request, brief, report, round, previousReviews: active.reviews, hostNotes, personal: task.input.metadata?.reviewerMemory ?? "",
          // Work reopened after delivery: what the person already has, so the change can be checked against it.
          delivered: task.result?.report?.answer ?? task.result?.text ?? null,
          localRoots: this._reviewRoots(task, workspacePath), sessionEvents, workspacePath
        });
        review = { ...normalizeReviewShape(review), round };
        break;
      } catch (error) {
        if (active.stopRequested || active.shutdownRequested) throw codedError("STALE_FENCING_TOKEN", "Task was stopped");
        // No account can reach the reviewer's model yet (limited, or waiting
        // for a sign-in): that is not the reviewer failing, so the result is
        // held for as long as it takes, checking again at the reset or every
        // minute, without counting towards giving up.
        if (error.wait) {
          attempt--;
          await this._holdForAccount(active, error.wait, "the review");
          continue;
        }
        if (attempt >= this.reviewHoldMs.length) {
          throw codedError("QUALITY_REVIEW_UNAVAILABLE", "The agent finished, but EV's quality check could not run, so the result was held back instead of delivered unchecked.", { heldAnswer: String(report.answer ?? "").slice(0, 6_000), cause: error.message });
        }
        await this._phase(active, "The quality check is unavailable; holding the result and trying again");
        active.controller = new AbortController();
        try { await abortableDelay(this.reviewHoldMs[attempt], active.controller.signal); }
        catch { throw codedError("STALE_FENCING_TOKEN", "Task was stopped"); }
        finally { active.controller = null; }
      }
    }
    active.reviews.push(review);
    await this._progress(active, { round, verdict: review.verdict, intentMatch: review.intentMatch ?? null, summary: review.summary, missing: review.missing, feedback: review.feedback, progress: review.progress ?? null, askPerson: review.askPerson || null, unavailable: Boolean(review.unavailable) }, "review");
    if (!review.unavailable) this._steps(active, [{ kind: "reviewed", label: review.verdict === "accept" ? "The review accepted it" : `The review sent it back${review.summary ? `: ${review.summary}` : ""}`.slice(0, 300), round, accepted: review.verdict === "accept" }]);
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
      if (active.round >= active.maxRounds || active.stopRequested || active.shutdownRequested) {
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
      const next = await this._runWorker(active, prompt, { reuseCompleted: false, phase: "Taking your new message into account" });
      if (active.shutdownRequested || active.stopRequested) throw codedError("STALE_FENCING_TOKEN", "Task was stopped");
      if (next.status === "budget_exceeded" && next.text) stopReason = "budget";
      else if (next.status !== "completed") throw codedError(next.code ?? "WORKER_ERROR", next.message ?? "The agent stopped before finishing");
      return next;
    };
    for (;;) {
      // Whatever the person said about this work while it ran goes to the
      // agent before its result is judged, in the same session.
      const instructions = stopReason ? [] : await this._takeInstructions(active);
      if (instructions.length) {
        result = await followUp(continuationPrompt({ request, brief: active.brief, instructions }));
        continue;
      }
      let report = null;
      try { report = validateOpenClawTaskReport(result.text, { ...task.input.metadata?.verification, strictEvidence: false }); }
      catch (error) { if (error.code !== "TASK_REPORT_INVALID") throw error; }
      if (report?.outcome === "needs_input") {
        if (active.stopRequested || active.shutdownRequested) throw codedError("STALE_FENCING_TOKEN", "Task was stopped");
        throw codedError("NEEDS_INPUT", report.question, { question: report.question, answerSoFar: report.answer });
      }
      if (!report) {
        // Format, not quality: one chance to restate the result as a report.
        if (formatFixUsed || stopReason || active.stopRequested || active.shutdownRequested) break;
        formatFixUsed = true;
        const repaired = await this._runWorker(active, revisionPrompt({ request, brief: active.brief, formatOnly: true, round: active.round, sharedPath }), { reuseCompleted: false, phase: "Restating its result in the form EV reads" });
        if (active.shutdownRequested || active.stopRequested) throw codedError("STALE_FENCING_TOKEN", "Task was stopped");
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
      if (active.stopRequested || active.shutdownRequested) throw codedError("STALE_FENCING_TOKEN", "Task was stopped");
      const question = this._stuckQuestion(active, review, unresolved);
      if (question) throw codedError("NEEDS_INPUT", question, { question, answerSoFar: report.answer });
      await this._sendBack(active, task);
      const revised = await this._runWorker(active, revisionPrompt({ request, brief: active.brief, review: review ?? { missing: hostNotes }, round: active.round - 1, sharedPath }), { reuseCompleted: false, phase: "Revising its work from the review" });
      if (active.shutdownRequested || active.stopRequested) throw codedError("STALE_FENCING_TOKEN", "Task was stopped");
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
