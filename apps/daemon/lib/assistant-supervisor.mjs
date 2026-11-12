import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { ensurePrivateDirectorySync, securePrivateTreeSync } from "./file-permissions.mjs";
import { codedError, parse } from "./store.mjs";

// A run is live while the agent works and while EV reviews its result.
const ACTIVE_RUN_STATES = Object.freeze(["running", "verifying"]);
const TERMINAL = Object.freeze(["completed", "failed", "cancelled"]);

async function verifyReceipt(artifactRoot, receipt) {
  let handle;
  try {
    if (!receipt || typeof receipt.artifactId !== "string" || !receipt.artifactId ||
      typeof receipt.relativePath !== "string" || !receipt.relativePath ||
      typeof receipt.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(receipt.sha256) ||
      !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 0) throw new Error("bad receipt");
    const root = await realpath(artifactRoot);
    const requested = resolve(root, receipt.relativePath);
    if (requested !== root && !requested.startsWith(`${root}${sep}`)) throw new Error("outside artifact root");
    const absolute = await realpath(requested);
    if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) throw new Error("outside artifact root");
    handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size !== receipt.bytes) throw new Error("size mismatch");
    const contents = await handle.readFile();
    const digest = createHash("sha256").update(contents).digest("hex");
    if (digest !== receipt.sha256) throw new Error("hash mismatch");
    return contents;
  } catch {
    throw codedError("ARTIFACT_RECEIPT_INVALID", `Artifact receipt is invalid: ${receipt?.relativePath ?? "unknown"}`);
  } finally {
    await handle?.close();
  }
}

function receiptOf(row) {
  return { artifactId: row.file_id, ...(row.title ? { title: row.title } : {}), relativePath: row.path, sha256: row.sha256, bytes: row.bytes };
}

/**
 * The state of each piece of work, in the store: one row per work, every
 * change written with its event, each delivered result in its own row and its
 * files on disk under `artifactRoot`.
 */
export class AssistantSupervisor {
  static async open({ store, artifactRoot }) {
    ensurePrivateDirectorySync(artifactRoot);
    securePrivateTreeSync(artifactRoot);
    return new AssistantSupervisor({ store, artifactRoot });
  }

  constructor({ store, artifactRoot }) {
    this.store = store;
    this.db = store.db;
    this.artifactRoot = artifactRoot;
  }

  close() {}

  /** Writes the change and its event together, and moves the snapshot revision on. */
  _change(taskId, type, data, set = {}) {
    const { at } = this.store.event({ type, workId: taskId, data });
    const revision = this.store.bump("work");
    const columns = Object.keys(set);
    this.db.prepare(`UPDATE work SET ${[...columns.map((column) => `${column} = ?`), "updated_at = ?", "revision = ?"].join(", ")} WHERE work_id = ?`)
      .run(...columns.map((column) => set[column]), at, revision, taskId);
  }

  _row(taskId) {
    return this.db.prepare("SELECT * FROM work WHERE work_id = ?").get(taskId);
  }

  _requireRow(taskId) {
    const row = this._row(taskId);
    if (!row) throw codedError("TASK_NOT_FOUND", `Unknown task: ${taskId}`);
    return row;
  }

  _taskFromRow(row) {
    const result = this.db.prepare("SELECT * FROM results WHERE work_id = ? ORDER BY at DESC, rowid DESC LIMIT 1").get(row.work_id);
    return {
      taskId: row.work_id,
      input: parse(row.input_json),
      status: row.status,
      lease: row.lease_id ? { leaseId: row.lease_id, fencingToken: row.fencing_token, fencingGeneration: row.lease_generation, generation: row.lease_generation, workerId: row.worker_id } : null,
      run: row.run_id ? { runId: row.run_id, workerId: row.worker_id, startedAt: row.started_at } : null,
      result: result ? parse(result.result_json) : null,
      artifacts: result ? this.db.prepare("SELECT * FROM files WHERE result_id = ? ORDER BY rowid").all(result.result_id).map(receiptOf) : [],
      error: parse(row.error_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revision: row.revision,
      history: this.store.events({ workId: row.work_id }).map(({ eventId, seq, type, at, data }) => ({ eventId, sequence: seq, type, at, ...data }))
    };
  }

  _task(taskId) {
    return this._taskFromRow(this._requireRow(taskId));
  }

  _assertToken(row, fencingToken) {
    if (!row.fencing_token || row.fencing_token !== fencingToken) throw codedError("STALE_FENCING_TOKEN", "The worker lease is no longer current");
  }

  _assertRun(row, fencingToken, runId, what) {
    this._assertToken(row, fencingToken);
    if (!ACTIVE_RUN_STATES.includes(row.status) || row.run_id !== runId) throw codedError("INVALID_TASK_TRANSITION", `Only the current run can ${what}`);
  }

  async createTask({ taskId, input }) {
    if (typeof taskId !== "string" || !taskId) throw codedError("INVALID_TASK_ID", "taskId is required");
    const encoded = JSON.stringify(input ?? null);
    this.store.tx(() => {
      const existing = this._row(taskId);
      if (existing) {
        if (existing.input_json !== encoded) throw codedError("TASK_ALREADY_EXISTS", `Task ${taskId} already exists`);
        return;
      }
      const at = this.store.now();
      this.db.prepare("INSERT INTO work (work_id, conversation_id, parent_id, input_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)")
        .run(taskId, input?.metadata?.conversationId ?? null, input?.metadata?.parentTaskId ?? null, encoded, at, at);
      this._change(taskId, "created", {});
    });
    return this._task(taskId);
  }

  async leaseTask({ taskId, workerId }) {
    if (typeof workerId !== "string" || !workerId) throw codedError("INVALID_WORKER_ID", "workerId is required");
    return this.store.tx(() => {
      const row = this._requireRow(taskId);
      if (row.status !== "queued") throw codedError("TASK_NOT_QUEUED", `Task ${taskId} is ${row.status}`);
      const fencingGeneration = row.lease_generation + 1;
      const lease = { leaseId: randomUUID(), fencingToken: randomUUID(), fencingGeneration, generation: fencingGeneration, workerId };
      this._change(taskId, "leased", { workerId, leaseId: lease.leaseId, fencingGeneration }, {
        status: "leased", lease_id: lease.leaseId, fencing_token: lease.fencingToken, lease_generation: fencingGeneration, worker_id: workerId, run_id: null, started_at: null
      });
      return lease;
    });
  }

  async startTask({ taskId, runId, fencingToken }) {
    if (typeof runId !== "string" || !runId) throw codedError("INVALID_RUN_ID", "runId is required");
    this.store.tx(() => {
      const row = this._requireRow(taskId);
      this._assertToken(row, fencingToken);
      if (row.status === "running" && row.run_id === runId) return;
      if (row.status !== "leased") throw codedError("INVALID_TASK_TRANSITION", `Cannot start task in ${row.status}`);
      this._change(taskId, "started", { runId }, { status: "running", run_id: runId, started_at: this.store.now() });
    });
    return this._task(taskId);
  }

  /** The accepted result goes in its own row, however large; its files are verified on disk first. */
  async completeTask({ taskId, runId, fencingToken, result = null, artifacts = [] }) {
    if (!Array.isArray(artifacts)) throw codedError("INVALID_ARTIFACTS", "artifacts must be an array");
    const current = this._requireRow(taskId);
    this._assertToken(current, fencingToken);
    if (current.status === "completed" && current.run_id === runId) return this._taskFromRow(current);
    this._assertRun(current, fencingToken, runId, "complete");
    for (const receipt of artifacts) await verifyReceipt(this.artifactRoot, receipt);
    this.store.tx(() => {
      const row = this._requireRow(taskId);
      if (row.status === "completed" && row.run_id === runId) return;
      this._assertRun(row, fencingToken, runId, "complete");
      const resultId = randomUUID();
      this.db.prepare("INSERT INTO results (result_id, work_id, run_id, result_json, at) VALUES (?, ?, ?, ?, ?)").run(resultId, taskId, runId, JSON.stringify(result), this.store.now());
      const file = this.db.prepare("INSERT INTO files (file_id, result_id, work_id, title, path, sha256, bytes) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const receipt of artifacts) file.run(receipt.artifactId, resultId, taskId, receipt.title ?? null, receipt.relativePath, receipt.sha256, receipt.bytes);
      this._change(taskId, "completed", { runId, resultId }, { status: "completed" });
    });
    return this._task(taskId);
  }

  async failTask({ taskId, runId, fencingToken, error }) {
    const failure = error ?? { code: "WORKER_ERROR", message: "Worker failed" };
    this.store.tx(() => {
      this._assertRun(this._requireRow(taskId), fencingToken, runId, "fail");
      this._change(taskId, "failed", { runId, code: failure.code }, { status: "failed", error_json: JSON.stringify(failure) });
    });
    return this._task(taskId);
  }

  async recordProgress({ taskId, runId, fencingToken, type = "progress", data = {} }) {
    if (!["progress", "manager_plan", "worker_retry", "review", "usage", "instructions_applied"].includes(type)) throw codedError("INVALID_EVENT_TYPE", "Unsupported progress event");
    this.store.tx(() => {
      this._assertRun(this._requireRow(taskId), fencingToken, runId, "record progress");
      this._change(taskId, type, data);
    });
    return this._task(taskId);
  }

  /**
   * running -> verifying: the agent says it is done and EV is reviewing the
   * result against the brief. verifying -> running: the review asked for
   * another round and the same run goes back to work.
   */
  async beginVerification({ taskId, runId, fencingToken, round = 1 }) {
    return this._moveRun({ taskId, runId, fencingToken, from: "running", to: "verifying", event: "verifying", data: { round } });
  }

  async resumeAfterReview({ taskId, runId, fencingToken, round = 1 }) {
    return this._moveRun({ taskId, runId, fencingToken, from: "verifying", to: "running", event: "revision_requested", data: { round } });
  }

  _moveRun({ taskId, runId, fencingToken, from, to, event, data }) {
    this.store.tx(() => {
      const row = this._requireRow(taskId);
      this._assertToken(row, fencingToken);
      if (row.run_id !== runId) throw codedError("INVALID_TASK_TRANSITION", "Only the current run can change state");
      if (row.status === to) return;
      if (row.status !== from) throw codedError("INVALID_TASK_TRANSITION", `Cannot move task from ${row.status} to ${to}`);
      this._change(taskId, event, data, { status: to });
    });
    return this._task(taskId);
  }

  /**
   * running/verifying -> waiting: the agent needs something only the person
   * can give. The lease is released, so a waiting task holds no worker slot
   * and survives restarts as is; `state` is what the next run restores.
   */
  async waitForInput({ taskId, runId, fencingToken, question, state = {} }) {
    this.store.tx(() => {
      this._assertRun(this._requireRow(taskId), fencingToken, runId, "wait for input");
      this._change(taskId, "input_needed", { question, state }, { status: "waiting", lease_id: null, fencing_token: null, worker_id: null, run_id: null, started_at: null });
    });
    return this._task(taskId);
  }

  /**
   * Records something the person said about unfinished work. A running task
   * picks it up at its next step; a waiting task goes back to the queue.
   */
  async addInstruction({ taskId, text, source = null }) {
    this.store.tx(() => {
      const row = this._requireRow(taskId);
      if (TERMINAL.includes(row.status)) throw codedError("TASK_NOT_ACTIVE", `Task ${taskId} is ${row.status}`);
      this._change(taskId, "instruction", { text, source }, { status: row.status === "waiting" ? "queued" : row.status });
    });
    return this._task(taskId);
  }

  _cancel(taskId, data) {
    const row = this._requireRow(taskId);
    if (TERMINAL.includes(row.status)) return;
    this._change(taskId, "cancelled", data, { status: "cancelled", lease_id: null, fencing_token: null, worker_id: null });
  }

  async cancelTask({ taskId, reason }) {
    this.store.tx(() => this._cancel(taskId, { reason: reason ?? null }));
    return this._task(taskId);
  }

  /** A cancel the page sent, replay-safe by its command id. */
  async commandTask({ taskId, commandId, type, expectedRevision = null, reason = null }) {
    if (typeof commandId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(commandId)) throw codedError("INVALID_COMMAND_ID", "A safe commandId is required");
    if (type !== "cancel") throw codedError("UNSUPPORTED_TASK_COMMAND", `Unsupported task command: ${type}`);
    const replayed = this.store.tx(() => {
      const earlier = this.db.prepare("SELECT work_id FROM events WHERE type = 'command' AND json_extract(data_json, '$.commandId') = ?").get(commandId);
      if (earlier) {
        if (earlier.work_id !== taskId) throw codedError("COMMAND_ID_CONFLICT", "commandId was already used for another command");
        return true;
      }
      const row = this._requireRow(taskId);
      if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || row.revision !== expectedRevision)) {
        throw codedError("TASK_REVISION_CONFLICT", `Expected task revision ${expectedRevision}, found ${row.revision}`);
      }
      this.store.event({ type: "command", workId: taskId, data: { commandId, type, expectedRevision, reason } });
      this._cancel(taskId, { reason, commandId });
      return false;
    });
    return { replayed, task: this._task(taskId) };
  }

  async readArtifact(artifactId) {
    if (typeof artifactId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(artifactId)) throw codedError("INVALID_ARTIFACT_ID", "A safe artifact id is required");
    const row = this.db.prepare("SELECT f.* FROM files f JOIN work w ON w.work_id = f.work_id WHERE f.file_id = ? AND w.status = 'completed'").get(artifactId);
    if (!row) throw codedError("ARTIFACT_NOT_FOUND", `Unknown artifact: ${artifactId}`);
    const receipt = receiptOf(row);
    const contents = await verifyReceipt(this.artifactRoot, receipt);
    return { taskId: row.work_id, receipt, filename: basename(receipt.relativePath), contents };
  }

  /** After a restart, every run that was live goes back to the queue. */
  async recover() {
    const recoveredTaskIds = this.store.tx(() => this.db.prepare("SELECT * FROM work WHERE status IN ('leased', 'running', 'verifying') ORDER BY created_at, work_id").all().map((row) => {
      this._change(row.work_id, "recovered", { previousRunId: row.run_id ?? null }, { status: "queued", lease_id: null, fencing_token: null, worker_id: null });
      return row.work_id;
    }));
    return { recoveredTaskIds };
  }

  async requeueTask({ taskId, runId = null, fencingToken, reason = "interrupted" }) {
    this.store.tx(() => {
      const row = this._requireRow(taskId);
      this._assertToken(row, fencingToken);
      if (ACTIVE_RUN_STATES.includes(row.status) && runId && row.run_id !== runId) throw codedError("INVALID_TASK_TRANSITION", "Only the current run can be requeued");
      if (!["leased", ...ACTIVE_RUN_STATES].includes(row.status)) throw codedError("INVALID_TASK_TRANSITION", `Cannot requeue task in ${row.status}`);
      this._change(taskId, "interrupted", { previousRunId: row.run_id ?? null, reason }, { status: "queued", lease_id: null, fencing_token: null, worker_id: null, run_id: null, started_at: null });
    });
    return this._task(taskId);
  }

  async getTask(taskId) {
    return this._task(taskId);
  }

  /** All work, oldest first; `parentId` narrows it to the pieces under one goal. */
  async listTasks({ parentId = null } = {}) {
    const rows = parentId
      ? this.db.prepare("SELECT * FROM work WHERE parent_id = ? ORDER BY created_at, work_id").all(parentId)
      : this.db.prepare("SELECT * FROM work ORDER BY created_at, work_id").all();
    return rows.map((row) => this._taskFromRow(row));
  }

  async snapshot() {
    return { revision: this.store.counter("work"), tasks: await this.listTasks() };
  }
}
