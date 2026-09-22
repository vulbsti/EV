import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { ensurePrivateDirectorySync, secureDatabaseFilesSync } from "./file-permissions.mjs";

// This store deliberately contains facts, evidence, revisions, and context
// receipts only. It has no capability or tool-grant columns and cannot grant
// authority to a worker.
const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

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
  FOREIGN KEY (current_revision_id) REFERENCES memory_revisions(revision_id)
);
CREATE INDEX IF NOT EXISTS memory_claims_owner_scope ON memory_claims(owner_id, scope);

CREATE TABLE IF NOT EXISTS memory_revisions (
  revision_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES memory_claims(claim_id),
  revision_number INTEGER NOT NULL,
  value_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'candidate')),
  author_type TEXT NOT NULL,
  supersedes_revision_id TEXT,
  memory_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (claim_id, revision_number),
  FOREIGN KEY (supersedes_revision_id) REFERENCES memory_revisions(revision_id)
);
CREATE INDEX IF NOT EXISTS memory_revisions_claim_order
  ON memory_revisions(claim_id, revision_number DESC);

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
    createdAt: row.created_at
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

  _createClaimInTransaction({ claimId = randomUUID(), ownerId, scope = "global", subject, predicate, value, confidence: certainty = 1, sourceIds = [], authorType = "user", inferred = false }) {
    required(ownerId, "ownerId"); required(scope, "scope"); required(subject, "subject"); required(predicate, "predicate");
    confidence(certainty);
    const status = inferred ? "candidate" : "active";
    const timestamp = this._now();
    if (this._claim(claimId)) throw codedError("CLAIM_ALREADY_EXISTS", `Claim ${claimId} already exists`);
    const sources = this._assertSources(ownerId, scope, sourceIds);
    this.database.prepare(`
      INSERT INTO memory_claims (claim_id, owner_id, scope, subject, predicate, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(claimId, ownerId, scope, subject, predicate, timestamp);
    const memoryRevision = this._nextMemoryRevision();
    const revisionId = randomUUID();
    this.database.prepare(`
      INSERT INTO memory_revisions (revision_id, claim_id, revision_number, value_json, confidence, status, author_type, memory_revision, created_at)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
    `).run(revisionId, claimId, json(value, "claim value"), certainty, status, authorType, memoryRevision, timestamp);
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

  correct({ claimId, expectedRevision, value, confidence: certainty = 1, sourceIds = [], authorType = "user" }) {
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
        INSERT INTO memory_revisions (revision_id, claim_id, revision_number, value_json, confidence, status, author_type, supersedes_revision_id, memory_revision, created_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
      `).run(revisionId, claimId, expectedRevision + 1, json(value, "claim value"), certainty, authorType, currentRevision.revision_id, memoryRevision, timestamp);
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
      this._nextMemoryRevision();
      tombstone = { tombstoneId: id, ownerId, targetType, targetId, action, scope, expiresAt: normalizedExpiresAt, eraseEpoch: epoch, createdAt: timestamp };
    });
    return tombstone;
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

  recall({ ownerId, scope = "global", query = null, includeCandidates = false, excludedScopes = [] } = {}) {
    required(ownerId, "ownerId"); required(scope, "scope");
    const queryText = query === null ? null : String(query).toLowerCase();
    const rows = this.database.prepare("SELECT * FROM memory_claims WHERE owner_id = ? ORDER BY created_at, claim_id").all(ownerId);
    return rows.filter((claim) => {
      if (!allowedScope(scope, claim.scope, excludedScopes)) return false;
      if (this._claimTombstoned(claim, scope)) return false;
      const current = claim.current_revision_id ? this._revision(claim.current_revision_id) : null;
      if (!current || (!includeCandidates && current.status !== "active")) return false;
      if (!queryText) return true;
      return `${claim.subject} ${claim.predicate} ${current.value_json}`.toLowerCase().includes(queryText);
    }).map((claim) => this._claimView(claim));
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
