import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { ensurePrivateDirectorySync, secureDatabaseFilesSync } from "./file-permissions.mjs";

/**
 * Provider-neutral Phase 4 boundary.
 *
 * This store owns the authority and reconciliation decision, not a provider
 * session or a worker process. Connected content is persisted as untrusted
 * data. A material change can create a queued, prepare-only task receipt;
 * execution is deliberately left to the task/worker service.
 */

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS standing_meta (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT INTO standing_meta (key, value) VALUES ('revision', 0)
  ON CONFLICT(key) DO NOTHING;

CREATE TABLE IF NOT EXISTS standing_responsibilities (
  responsibility_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
  mandate_version INTEGER NOT NULL,
  mandate_json TEXT NOT NULL,
  last_source_revision TEXT,
  last_cursor TEXT,
  last_material_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  revoke_reason TEXT,
  revision INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS standing_observations (
  observation_id TEXT PRIMARY KEY,
  responsibility_id TEXT NOT NULL REFERENCES standing_responsibilities(responsibility_id),
  mandate_version INTEGER NOT NULL,
  source_revision TEXT NOT NULL,
  cursor TEXT,
  state TEXT NOT NULL CHECK (state IN ('fresh', 'unchanged', 'stale', 'no_data', 'out_of_order', 'duplicate', 'conflict', 'revoked')),
  material_change INTEGER NOT NULL CHECK (material_change IN (0, 1)),
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  material_hash TEXT,
  observed_at TEXT,
  received_at TEXT NOT NULL,
  reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS standing_observation_source
  ON standing_observations(responsibility_id, source_revision);
CREATE INDEX IF NOT EXISTS standing_observation_order
  ON standing_observations(responsibility_id, received_at, observation_id);

CREATE TABLE IF NOT EXISTS standing_prepared_tasks (
  task_id TEXT PRIMARY KEY,
  responsibility_id TEXT NOT NULL REFERENCES standing_responsibilities(responsibility_id),
  observation_id TEXT NOT NULL REFERENCES standing_observations(observation_id),
  mandate_version INTEGER NOT NULL,
  source_revision TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'revoked', 'consumed')),
  input_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  supervisor_task_id TEXT,
  consumed_at TEXT,
  submission_confirmed_at TEXT,
  UNIQUE (responsibility_id, source_revision)
);
CREATE INDEX IF NOT EXISTS standing_task_order
  ON standing_prepared_tasks(responsibility_id, created_at, task_id);

CREATE TABLE IF NOT EXISTS standing_events (
  event_id TEXT PRIMARY KEY,
  responsibility_id TEXT NOT NULL REFERENCES standing_responsibilities(responsibility_id),
  type TEXT NOT NULL,
  data_json TEXT NOT NULL,
  at TEXT NOT NULL,
  revision INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS standing_event_order
  ON standing_events(responsibility_id, revision, event_id);
CREATE UNIQUE INDEX IF NOT EXISTS standing_active_resource
  ON standing_responsibilities(
    owner_id,
    json_extract(mandate_json, '$.resourceRef'),
    json_extract(mandate_json, '$.reportingDestination')
  ) WHERE status = 'active';
`;

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function clone(value) {
  return structuredClone(value);
}

function json(value, name, maxBytes = 128_000) {
  let encoded;
  try { encoded = JSON.stringify(value ?? null); } catch { throw codedError("INVALID_INPUT", `${name} must be JSON-serializable`); }
  if (Buffer.byteLength(encoded) > maxBytes) throw codedError("PAYLOAD_TOO_LARGE", `${name} exceeds ${maxBytes} bytes`);
  return encoded;
}

function parse(value, fallback = null) {
  return value === null || value === undefined ? fallback : JSON.parse(value);
}

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw codedError("INVALID_INPUT", `${name} must be a non-empty string`);
  return value;
}

function iso(value, name) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw codedError("INVALID_INPUT", `${name} must be an ISO timestamp`);
  return date.toISOString();
}

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function hash(value) {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function valueAt(payload, path) {
  if (!path) return payload;
  return path.split(".").reduce((value, segment) => {
    if (value === null || value === undefined) return undefined;
    return value[segment];
  }, payload);
}

function materialHash(payload, fields) {
  if (!Array.isArray(fields) || fields.length === 0) return hash(payload);
  return hash(Object.fromEntries(fields.map((field) => [field, valueAt(payload, field)])));
}

function revisionNumber(value) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) {
    try { return BigInt(value); } catch { return null; }
  }
  return null;
}

function timestampRevision(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d+):[a-f0-9]{8,64}$/i);
  if (!match) return null;
  try { return BigInt(match[1]); } catch { return null; }
}

function compareRevision(incoming, current) {
  if (incoming === current) return 0;
  const a = revisionNumber(incoming);
  const b = revisionNumber(current);
  if (a !== null && b !== null) return a < b ? -1 : 1;
  const timestampA = timestampRevision(incoming);
  const timestampB = timestampRevision(current);
  if (timestampA !== null && timestampB !== null && timestampA !== timestampB) return timestampA < timestampB ? -1 : 1;
  return null;
}

function mandateShape(mandate) {
  if (!mandate || typeof mandate !== "object" || Array.isArray(mandate)) throw codedError("INVALID_MANDATE", "mandate must be an object");
  const resourceRef = requiredText(mandate.resourceRef, "mandate.resourceRef");
  const freshnessMs = mandate.freshnessMs === undefined ? 15 * 60_000 : mandate.freshnessMs;
  if (!Number.isSafeInteger(freshnessMs) || freshnessMs < 0) throw codedError("INVALID_MANDATE", "mandate.freshnessMs must be a non-negative integer");
  const materialFields = mandate.materialFields ?? [];
  if (!Array.isArray(materialFields) || materialFields.some((field) => typeof field !== "string" || !field)) throw codedError("INVALID_MANDATE", "mandate.materialFields must be strings");
  const preparedOutput = mandate.preparedOutput ?? {};
  if (!preparedOutput || typeof preparedOutput !== "object" || Array.isArray(preparedOutput)) throw codedError("INVALID_MANDATE", "mandate.preparedOutput must be an object");
  const instructions = requiredText(preparedOutput.instructions ?? "Prepare a concise briefing from the source data.", "mandate.preparedOutput.instructions");
  const approvalBoundary = mandate.approvalBoundary ?? "prepare_only";
  if (approvalBoundary !== "prepare_only") throw codedError("INVALID_MANDATE", "Phase 4 only permits prepare_only responsibilities");
  const result = {
    resourceRef,
    trigger: mandate.trigger ?? { kind: "poll" },
    materialFields: [...materialFields],
    freshnessMs,
    preparedOutput: { ...preparedOutput, instructions },
    approvalBoundary,
    connector: mandate.connector ?? null,
    initialObservation: mandate.initialObservation === "baseline_only" ? "baseline_only" : "prepare",
    attentionRule: mandate.attentionRule ?? "material_change_prepare_quietly",
    budget: mandate.budget ?? null,
    expiresAt: mandate.expiresAt ? iso(mandate.expiresAt, "mandate.expiresAt") : null,
    reportingDestination: mandate.reportingDestination ?? "conversation"
  };
  return result;
}

function mapResponsibility(row, events = []) {
  if (!row) return null;
  return {
    responsibilityId: row.responsibility_id,
    ownerId: row.owner_id,
    status: row.status,
    mandateVersion: row.mandate_version,
    mandate: parse(row.mandate_json),
    lastSourceRevision: row.last_source_revision,
    lastCursor: row.last_cursor,
    lastMaterialHash: row.last_material_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
    revokeReason: row.revoke_reason,
    revision: row.revision,
    events
  };
}

function mapObservation(row) {
  if (!row) return null;
  return {
    observationId: row.observation_id,
    responsibilityId: row.responsibility_id,
    mandateVersion: row.mandate_version,
    sourceRevision: row.source_revision,
    cursor: row.cursor,
    state: row.state,
    materialChange: Boolean(row.material_change),
    payload: parse(row.payload_json),
    payloadHash: row.payload_hash,
    materialHash: row.material_hash,
    observedAt: row.observed_at,
    receivedAt: row.received_at,
    reason: row.reason
  };
}

function mapTask(row) {
  if (!row) return null;
  return {
    taskId: row.task_id,
    responsibilityId: row.responsibility_id,
    observationId: row.observation_id,
    mandateVersion: row.mandate_version,
    sourceRevision: row.source_revision,
    status: row.status,
    input: parse(row.input_json),
    createdAt: row.created_at,
    supervisorTaskId: row.supervisor_task_id ?? null,
    consumedAt: row.consumed_at ?? null,
    submissionConfirmedAt: row.submission_confirmed_at ?? null
  };
}

/** Durable mandate/reconciliation boundary for one read-only standing source. */
export class StandingResponsibilityStore {
  static open({ path = ":memory:", clock = () => new Date() } = {}) {
    if (path !== ":memory:") ensurePrivateDirectorySync(dirname(path));
    const database = new DatabaseSync(path);
    if (path !== ":memory:") secureDatabaseFilesSync(path);
    database.exec(SCHEMA);
    if (path !== ":memory:") secureDatabaseFilesSync(path);
    // Additive migration for ledgers created before supervisor task links
    // existed. No historical receipt is rewritten by this migration.
    const columns = database.prepare("PRAGMA table_info(standing_prepared_tasks)").all().map((column) => column.name);
    if (!columns.includes("supervisor_task_id")) database.exec("ALTER TABLE standing_prepared_tasks ADD COLUMN supervisor_task_id TEXT");
    if (!columns.includes("consumed_at")) database.exec("ALTER TABLE standing_prepared_tasks ADD COLUMN consumed_at TEXT");
    if (!columns.includes("submission_confirmed_at")) database.exec("ALTER TABLE standing_prepared_tasks ADD COLUMN submission_confirmed_at TEXT");
    return new StandingResponsibilityStore({ path, clock, database });
  }

  constructor({ path, clock, database }) {
    this.path = path;
    this.clock = clock;
    this.database = database;
  }

  close() { this.database.close(); }

  _now() {
    const value = this.clock();
    return value instanceof Date ? value.toISOString() : iso(value, "clock");
  }

  _transaction(callback) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* preserve original */ }
      throw error;
    }
  }

  _nextRevision() {
    const current = this.database.prepare("SELECT value FROM standing_meta WHERE key = 'revision'").get().value;
    const next = current + 1;
    this.database.prepare("UPDATE standing_meta SET value = ? WHERE key = 'revision'").run(next);
    return next;
  }

  _event(responsibilityId, type, data) {
    const at = this._now();
    const revision = this._nextRevision();
    this.database.prepare("INSERT INTO standing_events (event_id, responsibility_id, type, data_json, at, revision) VALUES (?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), responsibilityId, type, json(data, "event"), at, revision);
    return { at, revision };
  }

  _events(responsibilityId) {
    return this.database.prepare("SELECT * FROM standing_events WHERE responsibility_id = ? ORDER BY revision ASC")
      .all(responsibilityId).map((row) => ({ eventId: row.event_id, type: row.type, data: parse(row.data_json, {}), at: row.at, revision: row.revision }));
  }

  _row(responsibilityId) {
    return this.database.prepare("SELECT * FROM standing_responsibilities WHERE responsibility_id = ?").get(responsibilityId);
  }

  _require(responsibilityId) {
    const row = this._row(responsibilityId);
    if (!row) throw codedError("RESPONSIBILITY_NOT_FOUND", `Unknown responsibility: ${responsibilityId}`);
    return row;
  }

  _expireRowIfDue(row, now = this._now()) {
    if (!row || row.status !== "active") return row;
    const expiresAt = parse(row.mandate_json)?.expiresAt;
    if (!expiresAt || new Date(expiresAt).getTime() > new Date(now).getTime()) return row;
    const event = this._event(row.responsibility_id, "expired", {
      mandateVersion: row.mandate_version,
      expiresAt
    });
    this.database.prepare("UPDATE standing_responsibilities SET status = 'expired', updated_at = ?, revision = ? WHERE responsibility_id = ? AND status = 'active'")
      .run(now, event.revision, row.responsibility_id);
    this.database.prepare("UPDATE standing_prepared_tasks SET status = 'revoked' WHERE responsibility_id = ? AND status = 'queued'")
      .run(row.responsibility_id);
    return this._row(row.responsibility_id);
  }

  _expireDueResponsibilities() {
    const now = this._now();
    this._transaction(() => {
      for (const row of this.database.prepare("SELECT * FROM standing_responsibilities WHERE status = 'active'").all()) {
        this._expireRowIfDue(row, now);
      }
    });
  }

  async createResponsibility({ responsibilityId = randomUUID(), ownerId, mandate }) {
    requiredText(ownerId, "ownerId");
    const normalized = mandateShape(mandate);
    const now = this._now();
    try {
      this._transaction(() => {
        if (this._row(responsibilityId)) throw codedError("RESPONSIBILITY_EXISTS", `Responsibility ${responsibilityId} already exists`);
        const revision = this._nextRevision();
        this.database.prepare(`INSERT INTO standing_responsibilities
          (responsibility_id, owner_id, status, mandate_version, mandate_json, created_at, updated_at, revision)
          VALUES (?, ?, 'active', 1, ?, ?, ?, ?)`)
          .run(responsibilityId, ownerId, json(normalized, "mandate"), now, now, revision);
        this.database.prepare("INSERT INTO standing_events (event_id, responsibility_id, type, data_json, at, revision) VALUES (?, ?, ?, ?, ?, ?)")
          .run(randomUUID(), responsibilityId, "created", "{}", now, revision);
        this._expireRowIfDue(this._row(responsibilityId), now);
      });
    } catch (error) {
      if (error?.code === "SQLITE_CONSTRAINT_UNIQUE" || /standing_active_resource/.test(String(error?.message ?? ""))) {
        throw codedError("RESPONSIBILITY_SCOPE_EXISTS", "An active responsibility already watches this resource for this destination");
      }
      throw error;
    }
    return this.getResponsibility(responsibilityId);
  }

  async reviseMandate({ responsibilityId, expectedVersion, mandate }) {
    const normalized = mandateShape(mandate);
    const result = this._transaction(() => {
      const row = this._expireRowIfDue(this._require(responsibilityId));
      if (row.status !== "active") throw codedError("RESPONSIBILITY_NOT_ACTIVE", `Responsibility is ${row.status}`);
      if (expectedVersion !== undefined && row.mandate_version !== expectedVersion) throw codedError("MANDATE_VERSION_CONFLICT", `Expected mandate version ${expectedVersion}, found ${row.mandate_version}`);
      const nextVersion = row.mandate_version + 1;
      const event = this._event(responsibilityId, "mandate_revised", { fromVersion: row.mandate_version, toVersion: nextVersion });
      this.database.prepare("UPDATE standing_responsibilities SET mandate_version = ?, mandate_json = ?, updated_at = ?, revision = ? WHERE responsibility_id = ?")
        .run(nextVersion, json(normalized, "mandate"), event.at, event.revision, responsibilityId);
      this.database.prepare("UPDATE standing_prepared_tasks SET status = 'revoked' WHERE responsibility_id = ? AND status = 'queued' AND mandate_version <> ?")
        .run(responsibilityId, nextVersion);
      this._expireRowIfDue(this._row(responsibilityId), event.at);
      return nextVersion;
    });
    return this.getResponsibility(responsibilityId);
  }

  async revokeResponsibility({ responsibilityId, reason = "revoked by user" }) {
    const safeReason = requiredText(reason, "reason");
    this._transaction(() => {
      const row = this._require(responsibilityId);
      if (row.status === "revoked") return;
      const now = this._now();
      const event = this._event(responsibilityId, "revoked", { reason: safeReason, mandateVersion: row.mandate_version });
      this.database.prepare("UPDATE standing_responsibilities SET status = 'revoked', revoked_at = ?, revoke_reason = ?, updated_at = ?, revision = ? WHERE responsibility_id = ?")
        .run(now, safeReason, event.at, event.revision, responsibilityId);
      this.database.prepare("UPDATE standing_prepared_tasks SET status = 'revoked' WHERE responsibility_id = ? AND (status = 'queued' OR (status = 'consumed' AND submission_confirmed_at IS NULL))")
        .run(responsibilityId);
    });
    return this.getResponsibility(responsibilityId);
  }

  async observe({ responsibilityId, observation }) {
    const result = this._transaction(() => {
      const receivedAt = this._now();
      const row = this._expireRowIfDue(this._require(responsibilityId), receivedAt);
      if (row.status === "expired") throw codedError("RESPONSIBILITY_EXPIRED", `Responsibility expired at ${parse(row.mandate_json)?.expiresAt}`);
      const mandate = parse(row.mandate_json);
      const sourceRevision = String(observation?.sourceRevision ?? "state:no-data");
      const cursor = observation?.cursor === undefined || observation?.cursor === null ? null : String(observation.cursor);
      const payload = observation?.payload ?? null;
      const payloadJson = json(payload, "source payload");
      const payloadHash = hash(payload);
      const observedAt = observation?.observedAt ? iso(observation.observedAt, "observation.observedAt") : null;
      const explicitState = observation?.state ?? (observation?.noData ? "no_data" : "fresh");
      if (!["fresh", "stale", "no_data"].includes(explicitState)) throw codedError("INVALID_OBSERVATION", "state must be fresh, stale, or no_data");

      const existing = this.database.prepare("SELECT * FROM standing_observations WHERE responsibility_id = ? AND source_revision = ?")
        .get(responsibilityId, sourceRevision);
      if (existing) {
        return { observation: mapObservation(existing), task: this.database.prepare("SELECT * FROM standing_prepared_tasks WHERE responsibility_id = ? AND source_revision = ?").get(responsibilityId, sourceRevision) ? mapTask(this.database.prepare("SELECT * FROM standing_prepared_tasks WHERE responsibility_id = ? AND source_revision = ?").get(responsibilityId, sourceRevision)) : null, deduped: true };
      }

      let state = explicitState;
      let reason = null;
      let isMaterial = false;
      const incomingMaterialHash = explicitState === "fresh" ? materialHash(payload, mandate.materialFields) : null;
      const comparison = row.last_source_revision === null ? null : compareRevision(sourceRevision, row.last_source_revision);
      if (row.status !== "active") {
        state = "revoked";
        reason = `responsibility is ${row.status}`;
      } else if (explicitState === "fresh" && observedAt && (new Date(receivedAt).getTime() - new Date(observedAt).getTime()) > mandate.freshnessMs) {
        state = "stale";
        reason = "source observation exceeded freshness window";
      } else if (explicitState === "fresh" && comparison === -1) {
        state = "out_of_order";
        reason = "source revision is older than the accepted revision";
      } else if (explicitState === "fresh") {
        if (row.last_source_revision === null && mandate.initialObservation === "baseline_only") {
          isMaterial = false;
          state = "unchanged";
          reason = "baseline established without preparing work";
        } else if (row.last_source_revision === null || row.last_material_hash !== incomingMaterialHash) {
          isMaterial = true;
          state = "fresh";
          reason = "material change";
        } else {
          state = "unchanged";
          reason = "material fields unchanged";
        }
      }

      const observationId = randomUUID();
      const revision = this._nextRevision();
      this.database.prepare(`INSERT INTO standing_observations
        (observation_id, responsibility_id, mandate_version, source_revision, cursor, state, material_change,
         payload_json, payload_hash, material_hash, observed_at, received_at, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(observationId, responsibilityId, row.mandate_version, sourceRevision, cursor, state, isMaterial ? 1 : 0,
          payloadJson, payloadHash, incomingMaterialHash, observedAt, receivedAt, reason);
      this.database.prepare("INSERT INTO standing_events (event_id, responsibility_id, type, data_json, at, revision) VALUES (?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), responsibilityId, "observed", json({ observationId, sourceRevision, state, materialChange: isMaterial }, "event"), receivedAt, revision);

      let task = null;
      if (isMaterial && state === "fresh") {
        const taskId = `prepare-${randomUUID()}`;
        const input = {
          kind: "standing-prepared-output",
          action: "prepare_only",
          instructions: mandate.preparedOutput.instructions,
          output: mandate.preparedOutput,
          authority: { responsibilityId, mandateVersion: row.mandate_version, approvalBoundary: "prepare_only" },
          source: {
            resourceRef: mandate.resourceRef,
            sourceRevision,
            cursor,
            observedAt,
            trust: "untrusted-data",
            payload
          }
        };
        this.database.prepare(`INSERT INTO standing_prepared_tasks
          (task_id, responsibility_id, observation_id, mandate_version, source_revision, status, input_json, created_at)
          VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`)
          .run(taskId, responsibilityId, observationId, row.mandate_version, sourceRevision, json(input, "prepared task input"), receivedAt);
        task = mapTask(this.database.prepare("SELECT * FROM standing_prepared_tasks WHERE task_id = ?").get(taskId));
      }

      if (state === "fresh" || state === "unchanged") {
        this.database.prepare(`UPDATE standing_responsibilities
          SET last_source_revision = ?, last_cursor = ?, last_material_hash = ?, updated_at = ?, revision = ?
          WHERE responsibility_id = ?`)
          .run(sourceRevision, cursor, incomingMaterialHash ?? row.last_material_hash, receivedAt, revision, responsibilityId);
      }
      return { observation: mapObservation(this.database.prepare("SELECT * FROM standing_observations WHERE observation_id = ?").get(observationId)), task, deduped: false };
    });
    return clone(result);
  }

  async getResponsibility(responsibilityId) {
    const row = this._expireDueAndGet(responsibilityId);
    return clone(mapResponsibility(row, this._events(responsibilityId)));
  }

  _expireDueAndGet(responsibilityId) {
    let row;
    this._transaction(() => {
      row = this._expireRowIfDue(this._require(responsibilityId));
    });
    return row;
  }

  /**
   * Enumerate durable responsibilities for a scheduler or UI projection.
   * Filtering happens in the authority store so a wake scheduler never has
   * to discover or infer responsibilities from memory or conversation text.
   */
  async listResponsibilities({ status = null } = {}) {
    if (status !== null && !["active", "revoked", "expired"].includes(status)) {
      throw codedError("INVALID_INPUT", "status must be active, revoked, or expired");
    }
    this._expireDueResponsibilities();
    const rows = status
      ? this.database.prepare("SELECT * FROM standing_responsibilities WHERE status = ? ORDER BY created_at ASC, responsibility_id ASC").all(status)
      : this.database.prepare("SELECT * FROM standing_responsibilities ORDER BY created_at ASC, responsibility_id ASC").all();
    return clone(rows.map((row) => mapResponsibility(row, this._events(row.responsibility_id))));
  }

  async getObservation(observationId) {
    const row = this.database.prepare("SELECT * FROM standing_observations WHERE observation_id = ?").get(observationId);
    return clone(mapObservation(row));
  }

  async listObservations({ responsibilityId = null, limit = 20 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw codedError("INVALID_INPUT", "limit must be between 1 and 200");
    const rows = responsibilityId
      ? this.database.prepare("SELECT * FROM standing_observations WHERE responsibility_id = ? ORDER BY received_at DESC, observation_id DESC LIMIT ?").all(responsibilityId, limit)
      : this.database.prepare("SELECT * FROM standing_observations ORDER BY received_at DESC, observation_id DESC LIMIT ?").all(limit);
    return clone(rows.map(mapObservation));
  }

  async recordWakeFailure({ responsibilityId, error }) {
    requiredText(responsibilityId, "responsibilityId");
    const code = typeof error?.code === "string" && error.code.length <= 128 ? error.code : "STANDING_WAKE_FAILED";
    const message = typeof error?.message === "string" ? error.message.slice(0, 1000) : "Standing responsibility check failed";
    let event;
    this._transaction(() => {
      this._require(responsibilityId);
      event = this._event(responsibilityId, "wake_failed", { code, message });
    });
    return clone(event);
  }

  async getPreparedTask(taskId) {
    this._expireDueResponsibilities();
    return clone(mapTask(this.database.prepare("SELECT * FROM standing_prepared_tasks WHERE task_id = ?").get(taskId)));
  }

  /**
   * Record that a queued standing receipt was handed to the supervisor.
   *
   * Submission and this ledger transaction are intentionally separate
   * databases. The runner therefore uses a deterministic supervisor task id;
   * if it dies after submission, retrying is an idempotent supervisor create
   * and this method completes the durable link on the next tick.
   */
  async consumePreparedTask({ taskId, supervisorTaskId }) {
    requiredText(taskId, "taskId");
    requiredText(supervisorTaskId, "supervisorTaskId");
    return clone(this._transaction(() => {
      const row = this.database.prepare("SELECT * FROM standing_prepared_tasks WHERE task_id = ?").get(taskId);
      if (!row) throw codedError("PREPARED_TASK_NOT_FOUND", `Unknown prepared task: ${taskId}`);
      if (row.status === "consumed") {
        if (row.supervisor_task_id !== supervisorTaskId) throw codedError("PREPARED_TASK_LINK_CONFLICT", "Prepared task is linked to another supervisor task");
        if (row.submission_confirmed_at) return mapTask(row);
      }
      const now = this._now();
      const responsibility = this._expireRowIfDue(this._require(row.responsibility_id), now);
      if (responsibility.status !== "active" || row.mandate_version !== responsibility.mandate_version) {
        if (row.status === "queued") {
          this.database.prepare("UPDATE standing_prepared_tasks SET status = 'revoked' WHERE task_id = ? AND status = 'queued'").run(taskId);
        }
        throw codedError("PREPARED_TASK_AUTHORITY_REVOKED", "Prepared task is no longer authorized by its current responsibility mandate");
      }
      if (row.status === "consumed") return mapTask(row);
      if (row.status !== "queued") throw codedError("PREPARED_TASK_NOT_CONSUMABLE", `Prepared task is ${row.status}`);
      const event = this._event(row.responsibility_id, "prepared_task_consumed", { taskId, supervisorTaskId, previousStatus: row.status });
      this.database.prepare("UPDATE standing_prepared_tasks SET status = 'consumed', supervisor_task_id = ?, consumed_at = ? WHERE task_id = ?")
        .run(supervisorTaskId, now, taskId);
      return mapTask(this.database.prepare("SELECT * FROM standing_prepared_tasks WHERE task_id = ?").get(taskId));
    }));
  }

  async confirmPreparedTaskSubmission({ taskId, supervisorTaskId }) {
    requiredText(taskId, "taskId");
    requiredText(supervisorTaskId, "supervisorTaskId");
    return clone(this._transaction(() => {
      const row = this.database.prepare("SELECT * FROM standing_prepared_tasks WHERE task_id = ?").get(taskId);
      if (!row) throw codedError("PREPARED_TASK_NOT_FOUND", `Unknown prepared task: ${taskId}`);
      const responsibility = this._expireRowIfDue(this._require(row.responsibility_id));
      if (responsibility.status !== "active" || row.mandate_version !== responsibility.mandate_version || row.status === "revoked") {
        throw codedError("PREPARED_TASK_AUTHORITY_REVOKED", "Prepared task authority was revoked before submission was confirmed");
      }
      if (row.status !== "consumed" || row.supervisor_task_id !== supervisorTaskId) {
        throw codedError("PREPARED_TASK_LINK_CONFLICT", "Prepared task is not reserved for this supervisor task");
      }
      if (!row.submission_confirmed_at) {
        this.database.prepare("UPDATE standing_prepared_tasks SET submission_confirmed_at = ? WHERE task_id = ? AND submission_confirmed_at IS NULL")
          .run(this._now(), taskId);
      }
      return mapTask(this.database.prepare("SELECT * FROM standing_prepared_tasks WHERE task_id = ?").get(taskId));
    }));
  }

  async listPreparedTasks({ responsibilityId = null, status = null } = {}) {
    this._expireDueResponsibilities();
    const clauses = [];
    const args = [];
    if (responsibilityId) { clauses.push("responsibility_id = ?"); args.push(responsibilityId); }
    if (status) { clauses.push("status = ?"); args.push(status); }
    const query = `SELECT * FROM standing_prepared_tasks${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at ASC, task_id ASC`;
    return clone(this.database.prepare(query).all(...args).map(mapTask));
  }
}

export default StandingResponsibilityStore;
