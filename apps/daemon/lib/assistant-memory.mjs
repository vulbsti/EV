import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { ensurePrivateDirectorySync, secureDatabaseFilesSync } from "./file-permissions.mjs";

// This store deliberately contains facts, evidence, revisions, and context
// receipts only. It has no capability or tool-grant columns and cannot grant
// authority to a worker.
// A revision's status: active (used), candidate (a hypothesis or single-
// evidence lesson, shown to EV only as tentative), disputed (contradicted with
// no sign of a change), retired (no longer true or useful; kept as history).
const REVISIONS_TABLE = `CREATE TABLE IF NOT EXISTS memory_revisions (
  revision_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES memory_claims(claim_id),
  revision_number INTEGER NOT NULL,
  value_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'candidate', 'disputed', 'retired')),
  author_type TEXT NOT NULL,
  supersedes_revision_id TEXT,
  memory_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  valid_from TEXT,
  valid_until TEXT,
  expires_at TEXT,
  review_after TEXT,
  UNIQUE (claim_id, revision_number),
  FOREIGN KEY (supersedes_revision_id) REFERENCES memory_revisions(revision_id)
);
CREATE INDEX IF NOT EXISTS memory_revisions_claim_order
  ON memory_revisions(claim_id, revision_number DESC);`;

export const MEMORY_KINDS = Object.freeze(["fact", "preference", "goal", "agreement", "state", "lesson"]);
const STATUSES = ["active", "candidate", "disputed", "retired"];

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA secure_delete = ON;

CREATE TABLE IF NOT EXISTS memory_meta (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT INTO memory_meta (key, value) VALUES ('memory_revision', 0) ON CONFLICT(key) DO NOTHING;
INSERT INTO memory_meta (key, value) VALUES ('erase_epoch', 0) ON CONFLICT(key) DO NOTHING;

CREATE TABLE IF NOT EXISTS memory_sources (
  source_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  content_hash TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_sources_owner_scope ON memory_sources(owner_id, scope);

CREATE TABLE IF NOT EXISTS memory_claims (
  claim_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  current_revision_id TEXT,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'agreement',
  FOREIGN KEY (current_revision_id) REFERENCES memory_revisions(revision_id)
);
CREATE INDEX IF NOT EXISTS memory_claims_owner_scope ON memory_claims(owner_id, scope);

${REVISIONS_TABLE}

CREATE TABLE IF NOT EXISTS memory_revision_sources (
  revision_id TEXT NOT NULL REFERENCES memory_revisions(revision_id),
  source_id TEXT NOT NULL REFERENCES memory_sources(source_id),
  PRIMARY KEY (revision_id, source_id)
);

CREATE TABLE IF NOT EXISTS memory_proposals (
  proposal_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  value_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  source_ids_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
  proposed_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decision_reason TEXT,
  accepted_claim_id TEXT
);
CREATE INDEX IF NOT EXISTS memory_proposals_owner_status
  ON memory_proposals(owner_id, status, created_at);

CREATE TABLE IF NOT EXISTS memory_tombstones (
  tombstone_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('claim', 'source')),
  target_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('stop_use', 'erase')),
  scope TEXT,
  expires_at TEXT,
  erase_epoch INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_tombstones_target
  ON memory_tombstones(owner_id, target_type, target_id, action);

CREATE TABLE IF NOT EXISTS memory_links (
  from_claim_id TEXT NOT NULL REFERENCES memory_claims(claim_id),
  to_claim_id TEXT NOT NULL REFERENCES memory_claims(claim_id),
  link_type TEXT NOT NULL CHECK (link_type IN ('contradicts')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_claim_id, to_claim_id, link_type)
);

-- Every turn and settled task, append-only, so memory can be learned (and
-- re-learned after a crash) from what actually happened. A task event is
-- the episode record lessons cite.
CREATE TABLE IF NOT EXISTS memory_events (
  event_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  conversation_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('turn', 'task')),
  content_json TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES memory_sources(source_id),
  created_at TEXT NOT NULL,
  analysed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS memory_events_pending ON memory_events(owner_id, analysed_at, created_at);

CREATE TABLE IF NOT EXISTS memory_context_manifests (
  manifest_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  task_id TEXT,
  conversation_id TEXT,
  scope TEXT NOT NULL,
  memory_revision INTEGER NOT NULL,
  erase_epoch INTEGER NOT NULL,
  source_ids_json TEXT NOT NULL,
  claim_revision_ids_json TEXT NOT NULL,
  excluded_scopes_json TEXT NOT NULL,
  token_budget INTEGER NOT NULL,
  built_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_context_manifests_owner_time
  ON memory_context_manifests(owner_id, built_at);
`;

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function required(value, name) {
  if (typeof value !== "string" || value.length === 0) throw codedError("INVALID_INPUT", `${name} must be a non-empty string`);
  return value;
}

function optionalText(value, name) {
  if (value === undefined || value === null) return null;
  return required(value, name);
}

function clone(value) {
  return structuredClone(value);
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  return JSON.parse(value);
}

function json(value, name, maxBytes = 64_000) {
  const encoded = JSON.stringify(value ?? null);
  if (Buffer.byteLength(encoded) > maxBytes) throw codedError("PAYLOAD_TOO_LARGE", `${name} exceeds ${maxBytes} bytes`);
  return encoded;
}

function confidence(value) {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw codedError("INVALID_INPUT", "confidence must be between 0 and 1");
  return value;
}

function normalizeStopUseExpiry(expiresAt, action) {
  if (expiresAt === null || expiresAt === undefined) return null;
  if (action !== "stop_use" || typeof expiresAt !== "string" || expiresAt.trim() === "") {
    throw codedError("INVALID_INPUT", "expiresAt must be a valid stop-use timestamp");
  }
  const parsed = new Date(expiresAt);
  if (Number.isNaN(parsed.getTime())) throw codedError("INVALID_INPUT", "expiresAt must be a valid stop-use timestamp");
  return parsed.toISOString();
}

function allowedScope(requested, actual, excluded = []) {
  if (excluded.includes(actual)) return false;
  return actual === "global" || actual === requested;
}

function mapSource(row) {
  if (!row) return null;
  return {
    sourceId: row.source_id,
    ownerId: row.owner_id,
    scope: row.scope,
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    contentHash: row.content_hash,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at
  };
}

function mapRevision(row) {
  if (!row) return null;
  return {
    revisionId: row.revision_id,
    claimId: row.claim_id,
    revision: row.revision_number,
    value: parseJson(row.value_json),
    confidence: row.confidence,
    status: row.status,
    authorType: row.author_type,
    supersedesRevisionId: row.supersedes_revision_id,
    memoryRevision: row.memory_revision,
    createdAt: row.created_at,
    validFrom: row.valid_from ?? null,
    validUntil: row.valid_until ?? null,
    expiresAt: row.expires_at ?? null,
    reviewAfter: row.review_after ?? null
  };
}

function optionalTime(value, name) {
  if (value === undefined || value === null) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw codedError("INVALID_INPUT", `${name} must be a valid timestamp`);
  return parsed.toISOString();
}

function memoryKind(value) {
  if (!MEMORY_KINDS.includes(value)) throw codedError("INVALID_INPUT", `kind must be one of ${MEMORY_KINDS.join(", ")}`);
  return value;
}

function memoryStatus(value) {
  if (!STATUSES.includes(value)) throw codedError("INVALID_INPUT", `status must be one of ${STATUSES.join(", ")}`);
  return value;
}

function mapEvent(row) {
  if (!row) return null;
  return {
    eventId: row.event_id,
    ownerId: row.owner_id,
    conversationId: row.conversation_id,
    type: row.event_type,
    content: parseJson(row.content_json),
    sourceId: row.source_id,
    createdAt: row.created_at,
    analysedAt: row.analysed_at,
    attempts: row.attempts,
    lastError: row.last_error
  };
}

function mapProposal(row) {
  if (!row) return null;
  return {
    proposalId: row.proposal_id,
    ownerId: row.owner_id,
    scope: row.scope,
    subject: row.subject,
    predicate: row.predicate,
    value: parseJson(row.value_json),
    confidence: row.confidence,
    sourceIds: parseJson(row.source_ids_json, []),
    status: row.status,
    proposedBy: row.proposed_by,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decisionReason: row.decision_reason,
    acceptedClaimId: row.accepted_claim_id ?? null
  };
}

function mapManifest(row) {
  if (!row) return null;
  return {
    manifestId: row.manifest_id,
    ownerId: row.owner_id,
    taskId: row.task_id,
    conversationId: row.conversation_id,
    scope: row.scope,
    memoryRevision: row.memory_revision,
    eraseEpoch: row.erase_epoch,
    sourceIds: parseJson(row.source_ids_json, []),
    claimRevisionIds: parseJson(row.claim_revision_ids_json, []),
    excludedScopes: parseJson(row.excluded_scopes_json, []),
    tokenBudget: row.token_budget,
    builtAt: row.built_at
  };
}

// Databases from before memory kinds have a narrower status CHECK and no
// time fields. SQLite cannot alter a CHECK, so the table is rebuilt in place
// with every row kept.
function migrateRevisions(database) {
  const { sql } = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_revisions'").get();
  if (sql.includes("'retired'")) return;
  const columns = "revision_id, claim_id, revision_number, value_json, confidence, status, author_type, supersedes_revision_id, memory_revision, created_at";
  database.exec("PRAGMA foreign_keys = OFF");
  database.exec("BEGIN IMMEDIATE");
  try {
    // SQLite's documented rebuild order: copy into a new table, drop the old
    // one, then rename, so other tables' references keep naming memory_revisions.
    database.exec(REVISIONS_TABLE.split("CREATE INDEX")[0].replace("IF NOT EXISTS memory_revisions", "memory_revisions_new"));
    database.exec(`INSERT INTO memory_revisions_new (${columns}) SELECT ${columns} FROM memory_revisions`);
    database.exec("DROP TABLE memory_revisions");
    database.exec("ALTER TABLE memory_revisions_new RENAME TO memory_revisions");
    database.exec(REVISIONS_TABLE);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* preserve original */ }
    throw error;
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}

/** The readable text of a memory value: plain strings (manual guidance) or `{ text, ... }` (learned). */
export function memoryText(value) {
  if (typeof value === "string") return value;
  return typeof value?.text === "string" ? value.text : "";
}

/** Small, auditable SQLite memory boundary for Phase 3. */
export class AssistantMemoryStore {
  static open({ path = ":memory:", clock = () => new Date() } = {}) {
    if (path !== ":memory:") ensurePrivateDirectorySync(dirname(path));
    const database = new DatabaseSync(path);
    if (path !== ":memory:") secureDatabaseFilesSync(path);
    database.exec(SCHEMA);
    if (path !== ":memory:") secureDatabaseFilesSync(path);
    const tombstoneColumns = database.prepare("PRAGMA table_info(memory_tombstones)").all().map((column) => column.name);
    if (!tombstoneColumns.includes("expires_at")) database.exec("ALTER TABLE memory_tombstones ADD COLUMN expires_at TEXT");
    const proposalColumns = database.prepare("PRAGMA table_info(memory_proposals)").all().map((column) => column.name);
    if (!proposalColumns.includes("accepted_claim_id")) database.exec("ALTER TABLE memory_proposals ADD COLUMN accepted_claim_id TEXT");
    const claimColumns = database.prepare("PRAGMA table_info(memory_claims)").all().map((column) => column.name);
    if (!claimColumns.includes("kind")) database.exec("ALTER TABLE memory_claims ADD COLUMN kind TEXT NOT NULL DEFAULT 'agreement'");
    migrateRevisions(database);
    return new AssistantMemoryStore({ path, clock, database });
  }

  constructor({ path, clock, database }) {
    this.path = path;
    this.clock = clock;
    this.database = database;
  }

  close() {
    this.database.close();
  }

  _now() {
    const value = this.clock();
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
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

  _nextMemoryRevision() {
    const current = this.database.prepare("SELECT value FROM memory_meta WHERE key = 'memory_revision'").get().value;
    const next = current + 1;
    this.database.prepare("UPDATE memory_meta SET value = ? WHERE key = 'memory_revision'").run(next);
    return next;
  }

  _currentEraseEpoch() {
    return this.database.prepare("SELECT value FROM memory_meta WHERE key = 'erase_epoch'").get().value;
  }

  _bumpEraseEpoch() {
    const next = this._currentEraseEpoch() + 1;
    this.database.prepare("UPDATE memory_meta SET value = ? WHERE key = 'erase_epoch'").run(next);
    return next;
  }

  _source(sourceId) {
    return this.database.prepare("SELECT * FROM memory_sources WHERE source_id = ?").get(sourceId);
  }

  _claim(claimId) {
    return this.database.prepare("SELECT * FROM memory_claims WHERE claim_id = ?").get(claimId);
  }

  _revision(revisionId) {
    return this.database.prepare("SELECT * FROM memory_revisions WHERE revision_id = ?").get(revisionId);
  }

  _requireClaim(claimId) {
    const row = this._claim(required(claimId, "claimId"));
    if (!row) throw codedError("CLAIM_NOT_FOUND", `Unknown claim: ${claimId}`);
    return row;
  }

  _requireSource(sourceId) {
    const row = this._source(required(sourceId, "sourceId"));
    if (!row) throw codedError("SOURCE_NOT_FOUND", `Unknown source: ${sourceId}`);
    return row;
  }

  _assertSources(ownerId, scope, sourceIds) {
    const unique = [...new Set(sourceIds ?? [])];
    for (const sourceId of unique) {
      const source = this._requireSource(sourceId);
      if (source.owner_id !== ownerId) throw codedError("MEMORY_SCOPE_DENIED", "Source belongs to another owner");
      if (!(source.scope === "global" || source.scope === scope)) throw codedError("MEMORY_SCOPE_DENIED", "Source is outside the claim scope");
      if (this._isTombstoned(ownerId, "source", sourceId, scope)) throw codedError("MEMORY_SOURCE_UNAVAILABLE", "Source is stopped or erased");
    }
    return unique;
  }

  _isTombstoned(ownerId, targetType, targetId, scope = null) {
    const rows = this.database.prepare(
      "SELECT scope, expires_at FROM memory_tombstones WHERE owner_id = ? AND target_type = ? AND target_id = ?"
    ).all(ownerId, targetType, targetId);
    const now = this._now();
    return rows.some((row) => (!row.expires_at || row.expires_at > now) && (row.scope === null || row.scope === scope || scope === null));
  }

  _claimTombstoned(claim, scope = claim.scope) {
    if (this._isTombstoned(claim.owner_id, "claim", claim.claim_id, scope)) return true;
    const revision = claim.current_revision_id ? this._revision(claim.current_revision_id) : null;
    if (!revision) return false;
    const sourceIds = this.database.prepare("SELECT source_id FROM memory_revision_sources WHERE revision_id = ?")
      .all(revision.revision_id).map((row) => row.source_id);
    return sourceIds.some((sourceId) => this._isTombstoned(claim.owner_id, "source", sourceId, scope));
  }

  _sourcesForRevision(revisionId) {
    return this.database.prepare(`
      SELECT s.* FROM memory_sources s
      JOIN memory_revision_sources rs ON rs.source_id = s.source_id
      WHERE rs.revision_id = ? ORDER BY s.source_id
    `).all(revisionId).map(mapSource);
  }

  _claimView(claim) {
    const current = claim.current_revision_id ? this._revision(claim.current_revision_id) : null;
    const revisions = this.database.prepare("SELECT * FROM memory_revisions WHERE claim_id = ? ORDER BY revision_number ASC")
      .all(claim.claim_id).map((row) => ({ ...mapRevision(row), sources: this._sourcesForRevision(row.revision_id) }));
    const currentView = current ? { ...mapRevision(current), sources: this._sourcesForRevision(current.revision_id) } : null;
    return {
      claimId: claim.claim_id,
      ownerId: claim.owner_id,
      scope: claim.scope,
      kind: claim.kind,
      subject: claim.subject,
      predicate: claim.predicate,
      current: currentView,
      revisions,
      sources: currentView?.sources ?? []
    };
  }

  addSource({ sourceId = randomUUID(), ownerId, scope = "global", sourceType = "unknown", sourceRef, contentHash = null, metadata = {} }) {
    required(ownerId, "ownerId"); required(scope, "scope"); required(sourceType, "sourceType"); required(sourceRef, "sourceRef");
    const timestamp = this._now();
    this._transaction(() => {
      if (this._source(sourceId)) throw codedError("SOURCE_ALREADY_EXISTS", `Source ${sourceId} already exists`);
      this.database.prepare(`
        INSERT INTO memory_sources (source_id, owner_id, scope, source_type, source_ref, content_hash, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(sourceId, ownerId, scope, sourceType, sourceRef, contentHash, json(metadata, "source metadata"), timestamp);
      this._nextMemoryRevision();
    });
    return mapSource(this._source(sourceId));
  }

  _createClaimInTransaction({ claimId = randomUUID(), ownerId, scope = "global", kind = "agreement", subject, predicate, value, confidence: certainty = 1, sourceIds = [], authorType = "user", inferred = false, status: requestedStatus = null, validFrom = null, expiresAt = null, reviewAfter = null }) {
    required(ownerId, "ownerId"); required(scope, "scope"); required(subject, "subject"); required(predicate, "predicate");
    memoryKind(kind); confidence(certainty);
    const status = requestedStatus === null ? (inferred ? "candidate" : "active") : memoryStatus(requestedStatus);
    if (status === "retired") throw codedError("INVALID_INPUT", "A new claim cannot start retired");
    const timestamp = this._now();
    if (this._claim(claimId)) throw codedError("CLAIM_ALREADY_EXISTS", `Claim ${claimId} already exists`);
    const sources = this._assertSources(ownerId, scope, sourceIds);
    this.database.prepare(`
      INSERT INTO memory_claims (claim_id, owner_id, scope, subject, predicate, created_at, kind)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(claimId, ownerId, scope, subject, predicate, timestamp, kind);
    const memoryRevision = this._nextMemoryRevision();
    const revisionId = randomUUID();
    this.database.prepare(`
      INSERT INTO memory_revisions (revision_id, claim_id, revision_number, value_json, confidence, status, author_type, memory_revision, created_at, valid_from, expires_at, review_after)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(revisionId, claimId, json(value, "claim value"), certainty, status, authorType, memoryRevision, timestamp,
      optionalTime(validFrom, "validFrom"), optionalTime(expiresAt, "expiresAt"), optionalTime(reviewAfter, "reviewAfter"));
    this.database.prepare("UPDATE memory_claims SET current_revision_id = ? WHERE claim_id = ?").run(revisionId, claimId);
    const link = this.database.prepare("INSERT INTO memory_revision_sources (revision_id, source_id) VALUES (?, ?)");
    for (const sourceId of sources) link.run(revisionId, sourceId);
    return this._claimView(this._requireClaim(claimId));
  }

  createClaim(options) {
    const claimId = options.claimId ?? randomUUID();
    let claim;
    this._transaction(() => {
      claim = this._createClaimInTransaction({ ...options, claimId });
    });
    return claim;
  }

  propose({ proposalId = randomUUID(), ownerId, scope = "global", subject, predicate, value, confidence: certainty = 1, sourceIds = [], proposedBy = "worker" }) {
    required(ownerId, "ownerId"); required(scope, "scope"); required(subject, "subject"); required(predicate, "predicate");
    confidence(certainty);
    const sources = this._assertSources(ownerId, scope, sourceIds);
    const timestamp = this._now();
    this._transaction(() => {
      this.database.prepare(`
        INSERT INTO memory_proposals (proposal_id, owner_id, scope, subject, predicate, value_json, confidence, source_ids_json, status, proposed_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(proposalId, ownerId, scope, subject, predicate, json(value, "proposal value"), certainty, JSON.stringify(sources), proposedBy, timestamp);
    });
    return mapProposal(this.database.prepare("SELECT * FROM memory_proposals WHERE proposal_id = ?").get(proposalId));
  }

  getProposal(proposalId) {
    const row = this.database.prepare("SELECT * FROM memory_proposals WHERE proposal_id = ?").get(required(proposalId, "proposalId"));
    return mapProposal(row);
  }

  acceptProposal({ proposalId, authorType = "reviewer" }) {
    required(proposalId, "proposalId");
    let claim;
    this._transaction(() => {
      const proposal = this.database.prepare("SELECT * FROM memory_proposals WHERE proposal_id = ?").get(proposalId);
      if (!proposal) throw codedError("PROPOSAL_NOT_FOUND", `Unknown proposal: ${proposalId}`);
      if (proposal.status === "accepted") {
        if (!proposal.accepted_claim_id) throw codedError("PROPOSAL_INVALID", "Accepted proposal has no claim");
        claim = this._claimView(this._requireClaim(proposal.accepted_claim_id));
        return;
      }
      if (proposal.status !== "pending") throw codedError("PROPOSAL_NOT_PENDING", `Proposal is ${proposal.status}`);
      claim = this._createClaimInTransaction({
        ownerId: proposal.owner_id,
        scope: proposal.scope,
        subject: proposal.subject,
        predicate: proposal.predicate,
        value: parseJson(proposal.value_json),
        confidence: proposal.confidence,
        sourceIds: parseJson(proposal.source_ids_json, []),
        authorType,
        inferred: false
      });
      const timestamp = this._now();
      this.database.prepare("UPDATE memory_proposals SET status = 'accepted', decided_at = ?, accepted_claim_id = ? WHERE proposal_id = ? AND status = 'pending'").run(timestamp, claim.claimId, proposalId);
    });
    return claim;
  }

  rejectProposal({ proposalId, reason = null }) {
    required(proposalId, "proposalId");
    const timestamp = this._now();
    this._transaction(() => {
      const proposal = this.database.prepare("SELECT status FROM memory_proposals WHERE proposal_id = ?").get(proposalId);
      if (!proposal) throw codedError("PROPOSAL_NOT_FOUND", `Unknown proposal: ${proposalId}`);
      if (proposal.status !== "pending") throw codedError("PROPOSAL_NOT_PENDING", `Proposal is ${proposal.status}`);
      this.database.prepare("UPDATE memory_proposals SET status = 'rejected', decided_at = ?, decision_reason = ? WHERE proposal_id = ?").run(timestamp, reason, proposalId);
    });
    return this.getProposal(proposalId);
  }

  correct({ claimId, expectedRevision, value, confidence: certainty = 1, sourceIds = [], authorType = "user", status = "active", validFrom = null, validUntil = null, expiresAt = null, reviewAfter = null }) {
    memoryStatus(status);
    const claim = this._requireClaim(claimId);
    if (this._claimTombstoned(claim)) throw codedError("MEMORY_ERASED", "Erased or stopped memory cannot be corrected");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw codedError("INVALID_INPUT", "expectedRevision must be a positive integer");
    confidence(certainty);
    const timestamp = this._now();
    this._transaction(() => {
      const current = this._requireClaim(claimId);
      const currentRevision = this._revision(current.current_revision_id);
      if (currentRevision.revision_number !== expectedRevision) throw codedError("REVISION_CONFLICT", `Expected revision ${expectedRevision}, current is ${currentRevision.revision_number}`);
      const sources = this._assertSources(current.owner_id, current.scope, sourceIds);
      const memoryRevision = this._nextMemoryRevision();
      const revisionId = randomUUID();
      this.database.prepare(`
        INSERT INTO memory_revisions (revision_id, claim_id, revision_number, value_json, confidence, status, author_type, supersedes_revision_id, memory_revision, created_at, valid_from, valid_until, expires_at, review_after)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(revisionId, claimId, expectedRevision + 1, json(value, "claim value"), certainty, status, authorType, currentRevision.revision_id, memoryRevision, timestamp,
        optionalTime(validFrom, "validFrom"), optionalTime(validUntil, "validUntil"), optionalTime(expiresAt, "expiresAt"), optionalTime(reviewAfter, "reviewAfter"));
      this.database.prepare("UPDATE memory_claims SET current_revision_id = ? WHERE claim_id = ?").run(revisionId, claimId);
      const link = this.database.prepare("INSERT INTO memory_revision_sources (revision_id, source_id) VALUES (?, ?)");
      for (const sourceId of sources) link.run(revisionId, sourceId);
    });
    return this._claimView(this._requireClaim(claimId));
  }

  _tombstone({ ownerId, targetType, targetId, action, scope = null, expiresAt = null }) {
    required(ownerId, "ownerId"); required(targetId, "targetId");
    if (!['claim', 'source'].includes(targetType)) throw codedError("INVALID_INPUT", "targetType must be claim or source");
    if (!['stop_use', 'erase'].includes(action)) throw codedError("INVALID_INPUT", "action must be stop_use or erase");
    const normalizedExpiresAt = normalizeStopUseExpiry(expiresAt, action);
    const target = targetType === "claim" ? this._requireClaim(targetId) : this._requireSource(targetId);
    if (target.owner_id !== ownerId) throw codedError("MEMORY_SCOPE_DENIED", "Memory belongs to another owner");
    const timestamp = this._now();
    let tombstone;
    this._transaction(() => {
      const epoch = action === "erase" ? this._bumpEraseEpoch() : this._currentEraseEpoch();
      const id = randomUUID();
      this.database.prepare(`
        INSERT INTO memory_tombstones (tombstone_id, owner_id, target_type, target_id, action, scope, expires_at, erase_epoch, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, ownerId, targetType, targetId, action, scope, normalizedExpiresAt, epoch, timestamp);
      if (action === "erase") this._redact(targetType, targetId);
      this._nextMemoryRevision();
      tombstone = { tombstoneId: id, ownerId, targetType, targetId, action, scope, expiresAt: normalizedExpiresAt, eraseEpoch: epoch, createdAt: timestamp };
    });
    return tombstone;
  }

  /**
   * Erase removes the words, not just their use: every revision's value, an
   * accepted proposal's copy, and the recorded events the claim was learned
   * from (so they cannot be re-learned). Rows stay as non-content receipts.
   */
  _redact(targetType, targetId) {
    const sourceIds = targetType === "source" ? [targetId] : this.database.prepare(`
      SELECT DISTINCT rs.source_id FROM memory_revision_sources rs
      JOIN memory_revisions r ON r.revision_id = rs.revision_id WHERE r.claim_id = ?
    `).all(targetId).map((row) => row.source_id);
    if (targetType === "claim") {
      this.database.prepare("UPDATE memory_revisions SET value_json = 'null' WHERE claim_id = ?").run(targetId);
      this.database.prepare("UPDATE memory_proposals SET value_json = 'null' WHERE accepted_claim_id = ?").run(targetId);
    }
    const redactEvent = this.database.prepare("UPDATE memory_events SET content_json = '{\"erased\":true}', analysed_at = COALESCE(analysed_at, ?) WHERE source_id = ?");
    for (const sourceId of sourceIds) redactEvent.run(this._now(), sourceId);
  }

  stopUse({ ownerId, targetType, targetId, scope = null, expiresAt = null }) {
    return this._tombstone({ ownerId, targetType, targetId, scope, expiresAt, action: "stop_use" });
  }

  erase({ ownerId, targetType, targetId, scope = null }) {
    return this._tombstone({ ownerId, targetType, targetId, scope, action: "erase" });
  }

  getClaim(claimId) {
    const row = this._claim(claimId);
    return row ? this._claimView(row) : null;
  }

  /**
   * Claims usable now. Candidates (and disputed claims) only when asked for;
   * retired claims and expired passing state never. Newest change first, so
   * a correction to an old claim counts as recent.
   */
  recall({ ownerId, scope = "global", query = null, includeCandidates = false, excludedScopes = [], kinds = null } = {}) {
    required(ownerId, "ownerId"); required(scope, "scope");
    const queryText = query === null ? null : String(query).toLowerCase();
    const now = this._now();
    const rows = this.database.prepare(`
      SELECT c.* FROM memory_claims c JOIN memory_revisions r ON r.revision_id = c.current_revision_id
      WHERE c.owner_id = ? ORDER BY r.created_at DESC, c.claim_id
    `).all(ownerId);
    return rows.filter((claim) => {
      if (kinds && !kinds.includes(claim.kind)) return false;
      if (!allowedScope(scope, claim.scope, excludedScopes)) return false;
      if (this._claimTombstoned(claim, scope)) return false;
      const current = claim.current_revision_id ? this._revision(claim.current_revision_id) : null;
      if (!current || current.status === "retired" || (current.expires_at && current.expires_at <= now)) return false;
      if (!includeCandidates && current.status !== "active") return false;
      if (!queryText) return true;
      return `${claim.subject} ${claim.predicate} ${current.value_json}`.toLowerCase().includes(queryText);
    }).map((claim) => this._claimView(claim));
  }

  /** Ends a claim without replacing it ("I left that job", a lesson a later success disproved). History is kept. */
  retire({ claimId, expectedRevision, sourceIds = [], authorType = "user", reason = null }) {
    const current = this._revision(this._requireClaim(claimId).current_revision_id);
    const value = parseJson(current.value_json);
    const withReason = reason && value && typeof value === "object" ? { ...value, retiredBecause: String(reason).slice(0, 500) } : value;
    return this.correct({ claimId, expectedRevision, value: withReason, confidence: current.confidence, sourceIds, authorType, status: "retired", validUntil: this._now() });
  }

  /**
   * Adds supporting evidence to the current revision. Returns how many
   * distinct sources now support it; a source counted twice is still one.
   */
  addEvidence({ claimId, sourceId }) {
    const claim = this._requireClaim(claimId);
    this._transaction(() => {
      this._assertSources(claim.owner_id, claim.scope, [sourceId]);
      this.database.prepare("INSERT OR IGNORE INTO memory_revision_sources (revision_id, source_id) VALUES (?, ?)").run(claim.current_revision_id, sourceId);
      this._nextMemoryRevision();
    });
    return this._evidenceSourceIds(claimId).length;
  }

  /** Distinct sources behind any revision of a claim. */
  _evidenceSourceIds(claimId) {
    return this.database.prepare(`
      SELECT DISTINCT rs.source_id FROM memory_revision_sources rs
      JOIN memory_revisions r ON r.revision_id = rs.revision_id WHERE r.claim_id = ?
    `).all(claimId).map((row) => row.source_id);
  }

  link({ fromClaimId, toClaimId, type = "contradicts" }) {
    this._requireClaim(fromClaimId); this._requireClaim(toClaimId);
    this.database.prepare("INSERT OR IGNORE INTO memory_links (from_claim_id, to_claim_id, link_type, created_at) VALUES (?, ?, ?, ?)").run(fromClaimId, toClaimId, type, this._now());
  }

  links(claimId) {
    return this.database.prepare("SELECT * FROM memory_links WHERE from_claim_id = ? OR to_claim_id = ?").all(claimId, claimId)
      .map((row) => ({ fromClaimId: row.from_claim_id, toClaimId: row.to_claim_id, type: row.link_type }));
  }

  /**
   * Records one event (a conversation turn or a settled task) with the source
   * that claims learned from it will cite. Idempotent by eventId.
   */
  recordEvent({ eventId, ownerId, conversationId = null, type, content, scope = "global" }) {
    required(eventId, "eventId"); required(ownerId, "ownerId");
    if (!["turn", "task"].includes(type)) throw codedError("INVALID_INPUT", "type must be turn or task");
    const timestamp = this._now();
    this._transaction(() => {
      if (this.database.prepare("SELECT 1 FROM memory_events WHERE event_id = ?").get(eventId)) return;
      const sourceId = randomUUID();
      this.database.prepare(`
        INSERT INTO memory_sources (source_id, owner_id, scope, source_type, source_ref, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(sourceId, ownerId, scope, type === "task" ? "episode" : "conversation", `event:${eventId}`, json({ conversationId }, "source metadata"), timestamp);
      this.database.prepare(`
        INSERT INTO memory_events (event_id, owner_id, conversation_id, event_type, content_json, source_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(eventId, ownerId, conversationId, type, json(content, "event content"), sourceId, timestamp);
      this._nextMemoryRevision();
    });
    return this.getEvent(eventId);
  }

  getEvent(eventId) {
    return mapEvent(this.database.prepare("SELECT * FROM memory_events WHERE event_id = ?").get(eventId));
  }

  /** Events not yet analysed, oldest first, skipping ones that failed too often. */
  pendingEvents({ ownerId, limit = 20, maxAttempts = 3 }) {
    return this.database.prepare("SELECT * FROM memory_events WHERE owner_id = ? AND analysed_at IS NULL AND attempts < ? ORDER BY created_at, rowid LIMIT ?")
      .all(ownerId, maxAttempts, limit).map(mapEvent);
  }

  /** Already analysed events of a conversation before `before`, newest last, as context for the next analysis. */
  priorEvents({ ownerId, conversationId, before, limit = 4 }) {
    return this.database.prepare("SELECT * FROM memory_events WHERE owner_id = ? AND conversation_id IS ? AND analysed_at IS NOT NULL AND created_at <= ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(ownerId, conversationId, before, limit).map(mapEvent).reverse();
  }

  finishEvent({ eventId, error = null }) {
    if (error) this.database.prepare("UPDATE memory_events SET attempts = attempts + 1, last_error = ? WHERE event_id = ?").run(String(error).slice(0, 500), eventId);
    else this.database.prepare("UPDATE memory_events SET attempts = attempts + 1, analysed_at = ?, last_error = NULL WHERE event_id = ?").run(this._now(), eventId);
  }

  buildContextManifest({ manifestId = randomUUID(), ownerId, taskId = null, conversationId = null, scope = "global", claimRevisionIds = [], sourceIds = [], excludedScopes = [], tokenBudget = 0 }) {
    required(ownerId, "ownerId"); required(scope, "scope");
    optionalText(taskId, "taskId"); optionalText(conversationId, "conversationId");
    if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 0) throw codedError("INVALID_INPUT", "tokenBudget must be a non-negative integer");
    const claims = [];
    for (const revisionId of [...new Set(claimRevisionIds)]) {
      const revision = this._revision(required(revisionId, "claimRevisionId"));
      if (!revision) throw codedError("REVISION_NOT_FOUND", `Unknown revision: ${revisionId}`);
      const claim = this._requireClaim(revision.claim_id);
      if (claim.owner_id !== ownerId || !allowedScope(scope, claim.scope, excludedScopes)) throw codedError("MEMORY_SCOPE_DENIED", "Claim revision is outside the context scope");
      if (claim.current_revision_id !== revision.revision_id || this._claimTombstoned(claim, scope)) throw codedError("MEMORY_CONTEXT_STALE", "Claim revision is no longer current or is unavailable");
      if (revision.status !== "active") throw codedError("MEMORY_CONTEXT_CANDIDATE", "Candidate claims require review before context use");
      claims.push(revision.revision_id);
    }
    const sources = this._assertSources(ownerId, scope, [...new Set(sourceIds)]);
    for (const sourceId of sources) {
      const source = this._requireSource(sourceId);
      if (!allowedScope(scope, source.scope, excludedScopes)) throw codedError("MEMORY_SCOPE_DENIED", "Source is outside the context scope");
    }
    const timestamp = this._now();
    let manifest;
    this._transaction(() => {
      const memoryRevision = this.database.prepare("SELECT value FROM memory_meta WHERE key = 'memory_revision'").get().value;
      const eraseEpoch = this._currentEraseEpoch();
      this.database.prepare(`
        INSERT INTO memory_context_manifests (manifest_id, owner_id, task_id, conversation_id, scope, memory_revision, erase_epoch, source_ids_json, claim_revision_ids_json, excluded_scopes_json, token_budget, built_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(manifestId, ownerId, taskId, conversationId, scope, memoryRevision, eraseEpoch, JSON.stringify(sources), JSON.stringify(claims), JSON.stringify(excludedScopes), tokenBudget, timestamp);
      manifest = { manifestId, ownerId, taskId, conversationId, scope, memoryRevision, eraseEpoch, sourceIds: sources, claimRevisionIds: claims, excludedScopes, tokenBudget, builtAt: timestamp };
    });
    return clone(manifest);
  }

  getContextManifest(manifestId) {
    return mapManifest(this.database.prepare("SELECT * FROM memory_context_manifests WHERE manifest_id = ?").get(required(manifestId, "manifestId")));
  }

  listTombstones({ ownerId, targetType = null, targetId = null } = {}) {
    required(ownerId, "ownerId");
    const clauses = ["owner_id = ?"];
    const params = [ownerId];
    if (targetType !== null) { clauses.push("target_type = ?"); params.push(targetType); }
    if (targetId !== null) { clauses.push("target_id = ?"); params.push(targetId); }
    return this.database.prepare(`SELECT * FROM memory_tombstones WHERE ${clauses.join(" AND ")} ORDER BY created_at, tombstone_id`).all(...params)
      .map((row) => ({ tombstoneId: row.tombstone_id, ownerId: row.owner_id, targetType: row.target_type, targetId: row.target_id, action: row.action, scope: row.scope, expiresAt: row.expires_at, eraseEpoch: row.erase_epoch, createdAt: row.created_at }));
  }
}

export function createAssistantMemory(options = {}) {
  return AssistantMemoryStore.open(options);
}

export { SCHEMA as ASSISTANT_MEMORY_SCHEMA };
