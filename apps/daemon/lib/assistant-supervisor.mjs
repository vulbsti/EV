import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { ensurePrivateDirectorySync, secureDatabaseFilesSync, securePrivateTreeSync } from "./file-permissions.mjs";

function clone(value) {
  return structuredClone(value);
}

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function bounded(value, name) {
  const encoded = JSON.stringify(value ?? null);
  if (Buffer.byteLength(encoded) > 64_000) throw codedError("PAYLOAD_TOO_LARGE", `${name} exceeds 64 KB`);
  return JSON.parse(encoded);
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  return JSON.parse(value);
}

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

/** Durable, transactional owner for assistant task state. */
export class AssistantSupervisor {
  static async open({ statePath, artifactRoot }) {
    ensurePrivateDirectorySync(dirname(statePath));
    ensurePrivateDirectorySync(artifactRoot);
    securePrivateTreeSync(artifactRoot);
    const database = new DatabaseSync(statePath);
    secureDatabaseFilesSync(statePath);
    database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    database.exec(`
      CREATE TABLE IF NOT EXISTS supervisor_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO supervisor_meta (key, value) VALUES ('revision', 0) ON CONFLICT(key) DO NOTHING;
      INSERT INTO supervisor_meta (key, value) VALUES ('event_sequence', 0) ON CONFLICT(key) DO NOTHING;
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        input_json TEXT NOT NULL,
        status TEXT NOT NULL,
        lease_id TEXT,
        fencing_token TEXT,
        lease_generation INTEGER NOT NULL DEFAULT 0,
        worker_id TEXT,
        run_id TEXT,
        started_at TEXT,
        result_json TEXT,
        artifacts_json TEXT NOT NULL DEFAULT '[]',
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS task_events (
        task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        at TEXT NOT NULL,
        data_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (task_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS task_events_task_order ON task_events(task_id, sequence);
      CREATE INDEX IF NOT EXISTS tasks_created_order ON tasks(created_at, task_id);
      CREATE TABLE IF NOT EXISTS task_commands (
        command_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        expected_revision INTEGER,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_commands_task_order ON task_commands(task_id, created_at, command_id);
    `);
    secureDatabaseFilesSync(statePath);
    return new AssistantSupervisor({ statePath, artifactRoot, database });
  }

  constructor({ statePath, artifactRoot, database }) {
    this.statePath = statePath;
    this.artifactRoot = artifactRoot;
    this.database = database;
  }

  close() {
    this.database.close();
  }

  _transaction(callback) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    }
  }

  _nextRevision() {
    const revision = this.database.prepare("SELECT value FROM supervisor_meta WHERE key = 'revision'").get().value + 1;
    this.database.prepare("UPDATE supervisor_meta SET value = ? WHERE key = 'revision'").run(revision);
    return revision;
  }

  _addEvent(taskId, type, data = {}) {
    const sequence = this.database.prepare("SELECT value FROM supervisor_meta WHERE key = 'event_sequence'").get().value + 1;
    this.database.prepare("UPDATE supervisor_meta SET value = ? WHERE key = 'event_sequence'").run(sequence);
    const at = new Date().toISOString();
    this.database.prepare(`INSERT INTO task_events (task_id, sequence, event_id, type, at, data_json) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(taskId, sequence, randomUUID(), type, at, JSON.stringify(data));
    return at;
  }

  _row(taskId) {
    return this.database.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId);
  }

  _requireRow(taskId) {
    const row = this._row(taskId);
    if (!row) throw codedError("TASK_NOT_FOUND", `Unknown task: ${taskId}`);
    return row;
  }

  _events(taskId) {
    return this.database.prepare("SELECT sequence, event_id, type, at, data_json FROM task_events WHERE task_id = ? ORDER BY sequence ASC")
      .all(taskId).map((event) => ({ eventId: event.event_id, sequence: event.sequence, type: event.type, at: event.at, ...parseJson(event.data_json, {}) }));
  }

  _taskFromRow(row) {
    return {
      taskId: row.task_id,
      input: parseJson(row.input_json),
      status: row.status,
      lease: row.lease_id ? { leaseId: row.lease_id, fencingToken: row.fencing_token, fencingGeneration: row.lease_generation, generation: row.lease_generation, workerId: row.worker_id } : null,
      run: row.run_id ? { runId: row.run_id, workerId: row.worker_id, startedAt: row.started_at } : null,
      result: parseJson(row.result_json),
      artifacts: parseJson(row.artifacts_json, []),
      error: parseJson(row.error_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revision: row.revision,
      history: this._events(row.task_id)
    };
  }

  _task(taskId) {
    return this._taskFromRow(this._requireRow(taskId));
  }

  _assertToken(row, fencingToken) {
    if (!row.fencing_token || row.fencing_token !== fencingToken) throw codedError("STALE_FENCING_TOKEN", "The worker lease is no longer current");
  }

  async createTask({ taskId, input }) {
    if (typeof taskId !== "string" || !taskId) throw codedError("INVALID_TASK_ID", "taskId is required");
    const safeInput = bounded(input, "task input");
    const encodedInput = JSON.stringify(safeInput);
    this._transaction(() => {
      const existing = this._row(taskId);
      if (existing) {
        if (existing.input_json !== encodedInput) throw codedError("TASK_ALREADY_EXISTS", `Task ${taskId} already exists`);
        return;
      }
      const timestamp = new Date().toISOString();
      this.database.prepare("INSERT INTO tasks (task_id, input_json, status, created_at, updated_at, revision) VALUES (?, ?, 'queued', ?, ?, 0)")
        .run(taskId, encodedInput, timestamp, timestamp);
      const revision = this._nextRevision();
      const eventAt = this._addEvent(taskId, "created");
      this.database.prepare("UPDATE tasks SET updated_at = ?, revision = ? WHERE task_id = ?").run(eventAt, revision, taskId);
    });
    return clone(this._task(taskId));
  }

  async leaseTask({ taskId, workerId }) {
    if (typeof workerId !== "string" || !workerId) throw codedError("INVALID_WORKER_ID", "workerId is required");
    const lease = this._transaction(() => {
      const row = this._requireRow(taskId);
      if (row.status !== "queued") throw codedError("TASK_NOT_QUEUED", `Task ${taskId} is ${row.status}`);
      const fencingGeneration = row.lease_generation + 1;
      const value = { leaseId: randomUUID(), fencingToken: randomUUID(), fencingGeneration, generation: fencingGeneration, workerId };
      const revision = this._nextRevision();
      const eventAt = this._addEvent(taskId, "leased", { workerId, leaseId: value.leaseId, fencingGeneration });
      this.database.prepare("UPDATE tasks SET status = 'leased', lease_id = ?, fencing_token = ?, lease_generation = ?, worker_id = ?, run_id = NULL, started_at = NULL, updated_at = ?, revision = ? WHERE task_id = ?")
        .run(value.leaseId, value.fencingToken, fencingGeneration, workerId, eventAt, revision, taskId);
      return value;
    });
    return clone(lease);
  }

  async startTask({ taskId, runId, fencingToken }) {
    if (typeof runId !== "string" || !runId) throw codedError("INVALID_RUN_ID", "runId is required");
    this._transaction(() => {
      const row = this._requireRow(taskId);
      this._assertToken(row, fencingToken);
      if (row.status === "running" && row.run_id === runId) return;
      if (row.status !== "leased") throw codedError("INVALID_TASK_TRANSITION", `Cannot start task in ${row.status}`);
      const revision = this._nextRevision();
      const startedAt = this._addEvent(taskId, "started", { runId });
      this.database.prepare("UPDATE tasks SET status = 'running', run_id = ?, started_at = ?, updated_at = ?, revision = ? WHERE task_id = ?")
        .run(runId, startedAt, startedAt, revision, taskId);
    });
    return clone(this._task(taskId));
  }

  async completeTask({ taskId, runId, fencingToken, result = null, artifacts = [] }) {
    const safeResult = bounded(result, "task result");
    const safeArtifacts = bounded(artifacts, "task artifacts");
    if (!Array.isArray(safeArtifacts)) throw codedError("INVALID_ARTIFACTS", "artifacts must be an array");
    const current = this._requireRow(taskId);
    this._assertToken(current, fencingToken);
    if (current.status === "completed" && current.run_id === runId) return clone(this._taskFromRow(current));
    if (current.status !== "running" || current.run_id !== runId) throw codedError("INVALID_TASK_TRANSITION", "Only the current running task can complete");
    for (const receipt of safeArtifacts) await verifyReceipt(this.artifactRoot, receipt);
    this._transaction(() => {
      const row = this._requireRow(taskId);
      this._assertToken(row, fencingToken);
      if (row.status === "completed" && row.run_id === runId) return;
      if (row.status !== "running" || row.run_id !== runId) throw codedError("INVALID_TASK_TRANSITION", "Only the current running task can complete");
      const revision = this._nextRevision();
      const eventAt = this._addEvent(taskId, "completed", { runId });
      this.database.prepare("UPDATE tasks SET status = 'completed', result_json = ?, artifacts_json = ?, updated_at = ?, revision = ? WHERE task_id = ?")
        .run(JSON.stringify(safeResult), JSON.stringify(safeArtifacts), eventAt, revision, taskId);
    });
    return clone(this._task(taskId));
  }

  async failTask({ taskId, runId, fencingToken, error }) {
    const safeError = bounded(error ?? { code: "WORKER_ERROR", message: "Worker failed" }, "task error");
    this._transaction(() => {
      const row = this._requireRow(taskId);
      this._assertToken(row, fencingToken);
      if (row.status !== "running" || row.run_id !== runId) throw codedError("INVALID_TASK_TRANSITION", "Only the current running task can fail");
      const revision = this._nextRevision();
      const eventAt = this._addEvent(taskId, "failed", { runId, code: safeError.code });
      this.database.prepare("UPDATE tasks SET status = 'failed', error_json = ?, updated_at = ?, revision = ? WHERE task_id = ?")
        .run(JSON.stringify(safeError), eventAt, revision, taskId);
    });
    return clone(this._task(taskId));
  }

  async cancelTask({ taskId, reason }) {
    const safeReason = bounded(reason ?? null, "cancel reason");
    this._transaction(() => {
      const row = this._requireRow(taskId);
      if (["completed", "failed", "cancelled"].includes(row.status)) return;
      const revision = this._nextRevision();
      const eventAt = this._addEvent(taskId, "cancelled", { reason: safeReason });
      this.database.prepare("UPDATE tasks SET status = 'cancelled', lease_id = NULL, fencing_token = NULL, worker_id = NULL, updated_at = ?, revision = ? WHERE task_id = ?")
        .run(eventAt, revision, taskId);
    });
    return clone(this._task(taskId));
  }

  async commandTask({ taskId, commandId, type, expectedRevision = null, reason = null }) {
    if (typeof commandId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(commandId)) {
      throw codedError("INVALID_COMMAND_ID", "A safe commandId is required");
    }
    if (type !== "cancel") throw codedError("UNSUPPORTED_TASK_COMMAND", `Unsupported task command: ${type}`);
    const safeReason = bounded(reason, "cancel reason");
    const replayed = this._transaction(() => {
      const existing = this.database.prepare("SELECT * FROM task_commands WHERE command_id = ?").get(commandId);
      if (existing) {
        if (existing.task_id !== taskId || existing.type !== type) throw codedError("COMMAND_ID_CONFLICT", "commandId was already used for another command");
        return true;
      }
      const row = this._requireRow(taskId);
      if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || row.revision !== expectedRevision)) {
        throw codedError("TASK_REVISION_CONFLICT", `Expected task revision ${expectedRevision}, found ${row.revision}`);
      }
      const timestamp = new Date().toISOString();
      this.database.prepare("INSERT INTO task_commands (command_id, task_id, type, expected_revision, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(commandId, taskId, type, expectedRevision, JSON.stringify({ reason: safeReason }), timestamp);
      if (!["completed", "failed", "cancelled"].includes(row.status)) {
        const revision = this._nextRevision();
        const eventAt = this._addEvent(taskId, "cancelled", { reason: safeReason, commandId });
        this.database.prepare("UPDATE tasks SET status = 'cancelled', lease_id = NULL, fencing_token = NULL, worker_id = NULL, updated_at = ?, revision = ? WHERE task_id = ?")
          .run(eventAt, revision, taskId);
      }
      return false;
    });
    return { replayed, task: clone(this._task(taskId)) };
  }

  async readArtifact(artifactId) {
    if (typeof artifactId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(artifactId)) {
      throw codedError("INVALID_ARTIFACT_ID", "A safe artifact id is required");
    }
    const rows = this.database.prepare("SELECT task_id, artifacts_json FROM tasks WHERE status = 'completed'").all();
    for (const row of rows) {
      const receipt = parseJson(row.artifacts_json, []).find((candidate) => candidate.artifactId === artifactId);
      if (!receipt) continue;
      const contents = await verifyReceipt(this.artifactRoot, receipt);
      return { taskId: row.task_id, receipt: clone(receipt), filename: basename(receipt.relativePath), contents };
    }
    throw codedError("ARTIFACT_NOT_FOUND", `Unknown artifact: ${artifactId}`);
  }

  async recover() {
    const recoveredTaskIds = this._transaction(() => {
      const rows = this.database.prepare("SELECT * FROM tasks WHERE status IN ('leased', 'running') ORDER BY created_at ASC, task_id ASC").all();
      const ids = [];
      for (const row of rows) {
        const revision = this._nextRevision();
        const eventAt = this._addEvent(row.task_id, "recovered", { previousRunId: row.run_id ?? null });
        this.database.prepare("UPDATE tasks SET status = 'queued', lease_id = NULL, fencing_token = NULL, worker_id = NULL, updated_at = ?, revision = ? WHERE task_id = ?")
          .run(eventAt, revision, row.task_id);
        ids.push(row.task_id);
      }
      return ids;
    });
    return { recoveredTaskIds };
  }

  async requeueTask({ taskId, runId = null, fencingToken, reason = "interrupted" }) {
    const safeReason = bounded(reason, "requeue reason");
    this._transaction(() => {
      const row = this._requireRow(taskId);
      this._assertToken(row, fencingToken);
      if (row.status === "running" && runId && row.run_id !== runId) {
        throw codedError("INVALID_TASK_TRANSITION", "Only the current run can be requeued");
      }
      if (!["leased", "running"].includes(row.status)) throw codedError("INVALID_TASK_TRANSITION", `Cannot requeue task in ${row.status}`);
      const revision = this._nextRevision();
      const eventAt = this._addEvent(taskId, "interrupted", { previousRunId: row.run_id ?? null, reason: safeReason });
      this.database.prepare("UPDATE tasks SET status = 'queued', lease_id = NULL, fencing_token = NULL, worker_id = NULL, run_id = NULL, started_at = NULL, updated_at = ?, revision = ? WHERE task_id = ?")
        .run(eventAt, revision, taskId);
    });
    return clone(this._task(taskId));
  }

  async getTask(taskId) {
    return clone(this._task(taskId));
  }

  async listTasks() {
    return clone(this.database.prepare("SELECT * FROM tasks ORDER BY created_at ASC, task_id ASC").all().map((row) => this._taskFromRow(row)));
  }

  async snapshot() {
    const revision = this.database.prepare("SELECT value FROM supervisor_meta WHERE key = 'revision'").get().value;
    const tasks = this.database.prepare("SELECT * FROM tasks ORDER BY created_at ASC, task_id ASC").all().map((row) => this._taskFromRow(row));
    return clone({ revision, tasks });
  }

  async getSnapshot() {
    return this.snapshot();
  }
}
