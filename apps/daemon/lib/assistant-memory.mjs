import { randomUUID } from "node:crypto";
import { codedError, parse } from "./store.mjs";

// Memory holds facts, evidence, revisions and context receipts only. It has
// no capability or tool-grant columns and cannot grant authority to a worker.
// A revision's status: active (used), candidate (a hypothesis or single-
// evidence lesson, shown to EV only as tentative), disputed (contradicted with
// no sign of a change), retired (no longer true or useful; kept as history).
export const MEMORY_KINDS = Object.freeze(["fact", "preference", "goal", "agreement", "state", "lesson"]);
const STATUSES = ["active", "candidate", "disputed", "retired"];

function required(value, name) {
  if (typeof value !== "string" || value.length === 0) throw codedError("INVALID_INPUT", `${name} must be a non-empty string`);
  return value;
}

function optionalText(value, name) {
  return value === undefined || value === null ? null : required(value, name);
}

function confidence(value) {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw codedError("INVALID_INPUT", "confidence must be between 0 and 1");
  return value;
}

function optionalTime(value, name) {
  if (value === undefined || value === null) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw codedError("INVALID_INPUT", `${name} must be a valid timestamp`);
  return parsed.toISOString();
}

function normalizeStopUseExpiry(expiresAt, action) {
  if (expiresAt === null || expiresAt === undefined) return null;
  if (action !== "stop_use" || typeof expiresAt !== "string" || expiresAt.trim() === "") throw codedError("INVALID_INPUT", "expiresAt must be a valid stop-use timestamp");
  return optionalTime(expiresAt, "expiresAt");
}

function memoryKind(value) {
  if (!MEMORY_KINDS.includes(value)) throw codedError("INVALID_INPUT", `kind must be one of ${MEMORY_KINDS.join(", ")}`);
  return value;
}

function memoryStatus(value) {
  if (!STATUSES.includes(value)) throw codedError("INVALID_INPUT", `status must be one of ${STATUSES.join(", ")}`);
  return value;
}

function allowedScope(requested, actual, excluded = []) {
  if (excluded.includes(actual)) return false;
  return actual === "global" || actual === requested;
}

function mapSource(row) {
  return { sourceId: row.source_id, ownerId: row.owner_id, scope: row.scope, sourceType: row.source_type, sourceRef: row.source_ref, metadata: parse(row.metadata_json, {}), createdAt: row.created_at };
}

function mapRevision(row) {
  if (!row) return null;
  return {
    revisionId: row.revision_id,
    claimId: row.claim_id,
    revision: row.revision_number,
    value: parse(row.value_json),
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
    sourceIds: parse(row.source_ids_json, []),
    claimRevisionIds: parse(row.claim_revision_ids_json, []),
    excludedScopes: parse(row.excluded_scopes_json, []),
    tokenBudget: row.token_budget,
    builtAt: row.built_at
  };
}

/** The readable text of a memory value: plain strings (manual guidance) or `{ text, ... }` (learned). */
export function memoryText(value) {
  if (typeof value === "string") return value;
  return typeof value?.text === "string" ? value.text : "";
}

/**
 * What EV knows about the person, in the store. A claim's evidence is a
 * source; a learned claim's source is the event it was learned from (same
 * id), so erase can follow it to the event and the message behind it.
 */
export class AssistantMemoryStore {
  static open({ store, clock = () => new Date() }) {
    return new AssistantMemoryStore({ store, clock });
  }

  constructor({ store, clock = () => new Date() }) {
    this.store = store;
    this.database = store.db;
    this.clock = clock;
  }

  close() {}

  _now() { return new Date(this.clock()).toISOString(); }

  _transaction(callback) { return this.store.tx(callback); }

  _nextMemoryRevision() { return this.store.bump("memory_revision"); }

  _currentEraseEpoch() { return this.store.counter("erase_epoch"); }

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
    const rows = this.database.prepare("SELECT scope, expires_at FROM memory_tombstones WHERE owner_id = ? AND target_type = ? AND target_id = ?").all(ownerId, targetType, targetId);
    const now = this._now();
    return rows.some((row) => (!row.expires_at || row.expires_at > now) && (row.scope === null || row.scope === scope || scope === null));
  }

  _claimTombstoned(claim, scope = claim.scope) {
    if (this._isTombstoned(claim.owner_id, "claim", claim.claim_id, scope)) return true;
    if (!claim.current_revision_id) return false;
    return this.database.prepare("SELECT source_id FROM memory_revision_sources WHERE revision_id = ?").all(claim.current_revision_id)
      .some((row) => this._isTombstoned(claim.owner_id, "source", row.source_id, scope));
  }

  _sourcesForRevision(revisionId) {
    return this.database.prepare("SELECT s.* FROM memory_sources s JOIN memory_revision_sources rs ON rs.source_id = s.source_id WHERE rs.revision_id = ? ORDER BY s.source_id")
      .all(revisionId).map(mapSource);
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

  addSource({ sourceId = randomUUID(), ownerId, scope = "global", sourceType = "unknown", sourceRef, metadata = {} }) {
    required(ownerId, "ownerId"); required(scope, "scope"); required(sourceType, "sourceType"); required(sourceRef, "sourceRef");
    this._transaction(() => {
      if (this._source(sourceId)) throw codedError("SOURCE_ALREADY_EXISTS", `Source ${sourceId} already exists`);
      this.database.prepare("INSERT INTO memory_sources (source_id, owner_id, scope, source_type, source_ref, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(sourceId, ownerId, scope, sourceType, sourceRef, JSON.stringify(metadata), this._now());
      this._nextMemoryRevision();
    });
    return mapSource(this._source(sourceId));
  }

  _insertRevision({ claimId, number, value, certainty, status, authorType, supersedes = null, validFrom = null, validUntil = null, expiresAt = null, reviewAfter = null, sources }) {
    const revisionId = randomUUID();
    this.database.prepare(`
      INSERT INTO memory_revisions (revision_id, claim_id, revision_number, value_json, confidence, status, author_type, supersedes_revision_id, memory_revision, created_at, valid_from, valid_until, expires_at, review_after)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(revisionId, claimId, number, JSON.stringify(value ?? null), certainty, status, authorType, supersedes, this._nextMemoryRevision(), this._now(),
      optionalTime(validFrom, "validFrom"), optionalTime(validUntil, "validUntil"), optionalTime(expiresAt, "expiresAt"), optionalTime(reviewAfter, "reviewAfter"));
    this.database.prepare("UPDATE memory_claims SET current_revision_id = ? WHERE claim_id = ?").run(revisionId, claimId);
    const link = this.database.prepare("INSERT INTO memory_revision_sources (revision_id, source_id) VALUES (?, ?)");
    for (const sourceId of sources) link.run(revisionId, sourceId);
  }

  createClaim({ claimId = randomUUID(), ownerId, scope = "global", kind = "agreement", subject, predicate, value, confidence: certainty = 1, sourceIds = [], authorType = "user", inferred = false, status: requestedStatus = null, validFrom = null, expiresAt = null, reviewAfter = null }) {
    required(ownerId, "ownerId"); required(scope, "scope"); required(subject, "subject"); required(predicate, "predicate");
    memoryKind(kind); confidence(certainty);
    const status = requestedStatus === null ? (inferred ? "candidate" : "active") : memoryStatus(requestedStatus);
    if (status === "retired") throw codedError("INVALID_INPUT", "A new claim cannot start retired");
    this._transaction(() => {
      if (this._claim(claimId)) throw codedError("CLAIM_ALREADY_EXISTS", `Claim ${claimId} already exists`);
      const sources = this._assertSources(ownerId, scope, sourceIds);
      this.database.prepare("INSERT INTO memory_claims (claim_id, owner_id, scope, kind, subject, predicate, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(claimId, ownerId, scope, kind, subject, predicate, this._now());
      this._insertRevision({ claimId, number: 1, value, certainty, status, authorType, validFrom, expiresAt, reviewAfter, sources });
    });
    return this._claimView(this._requireClaim(claimId));
  }

  correct({ claimId, expectedRevision, value, confidence: certainty = 1, sourceIds = [], authorType = "user", status = "active", validFrom = null, validUntil = null, expiresAt = null, reviewAfter = null }) {
    memoryStatus(status);
    const claim = this._requireClaim(claimId);
    if (this._claimTombstoned(claim)) throw codedError("MEMORY_ERASED", "Erased or stopped memory cannot be corrected");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw codedError("INVALID_INPUT", "expectedRevision must be a positive integer");
    confidence(certainty);
    this._transaction(() => {
      const current = this._requireClaim(claimId);
      const currentRevision = this._revision(current.current_revision_id);
      if (currentRevision.revision_number !== expectedRevision) throw codedError("REVISION_CONFLICT", `Expected revision ${expectedRevision}, current is ${currentRevision.revision_number}`);
      const sources = this._assertSources(current.owner_id, current.scope, sourceIds);
      this._insertRevision({ claimId, number: expectedRevision + 1, value, certainty, status, authorType, supersedes: currentRevision.revision_id, validFrom, validUntil, expiresAt, reviewAfter, sources });
    });
    return this._claimView(this._requireClaim(claimId));
  }

  _tombstone({ ownerId, targetType, targetId, action, scope = null, expiresAt = null }) {
    required(ownerId, "ownerId"); required(targetId, "targetId");
    if (!["claim", "source"].includes(targetType)) throw codedError("INVALID_INPUT", "targetType must be claim or source");
    if (!["stop_use", "erase"].includes(action)) throw codedError("INVALID_INPUT", "action must be stop_use or erase");
    const normalizedExpiresAt = normalizeStopUseExpiry(expiresAt, action);
    const target = targetType === "claim" ? this._requireClaim(targetId) : this._requireSource(targetId);
    if (target.owner_id !== ownerId) throw codedError("MEMORY_SCOPE_DENIED", "Memory belongs to another owner");
    const timestamp = this._now();
    return this._transaction(() => {
      const epoch = action === "erase" ? this.store.bump("erase_epoch") : this._currentEraseEpoch();
      const id = randomUUID();
      this.database.prepare("INSERT INTO memory_tombstones (tombstone_id, owner_id, target_type, target_id, action, scope, expires_at, erase_epoch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, ownerId, targetType, targetId, action, scope, normalizedExpiresAt, epoch, timestamp);
      if (action === "erase") this._redact(targetType === "source" ? [targetId] : this._evidenceSourceIds(targetId), targetType === "claim" ? targetId : null);
      this._nextMemoryRevision();
      return { tombstoneId: id, ownerId, targetType, targetId, action, scope, expiresAt: normalizedExpiresAt, eraseEpoch: epoch, createdAt: timestamp };
    });
  }

  /**
   * Erase removes the words, not just their use: the claim's every version,
   * and, following the links, the events it was learned from and the
   * messages those events recorded (so they cannot be read or re-learned).
   */
  _redact(sourceIds, claimId = null, keepRevisionId = null) {
    if (claimId) this.database.prepare("UPDATE memory_revisions SET value_json = 'null' WHERE claim_id = ? AND revision_id IS NOT ?").run(claimId, keepRevisionId);
    for (const sourceId of sourceIds) this.forgetEvent(sourceId);
    this.store.erased();
  }

  /**
   * Forgets the earlier versions of a claim and keeps the current one ("forget
   * where I used to work"): their words, and the events behind the claim.
   */
  eraseHistory({ ownerId, claimId }) {
    const claim = this._requireClaim(claimId);
    if (claim.owner_id !== ownerId) throw codedError("MEMORY_SCOPE_DENIED", "Memory belongs to another owner");
    this._transaction(() => {
      // The message that changed the claim usually names the old value too, so
      // every event behind the claim is erased; the current text stays.
      this._redact(this._evidenceSourceIds(claimId), claimId, claim.current_revision_id);
      this.store.bump("erase_epoch");
      this._nextMemoryRevision();
    });
    return this._claimView(this._requireClaim(claimId));
  }

  /** Removes one event's words and the message it recorded (a "forget ..." request often repeats them). */
  forgetEvent(eventId) {
    this._transaction(() => {
      this.store.eraseEvent(eventId);
      this.database.prepare("INSERT INTO learning (event_id, analysed_at) SELECT event_id, ? FROM events WHERE event_id = ? ON CONFLICT(event_id) DO UPDATE SET analysed_at = COALESCE(analysed_at, excluded.analysed_at)")
        .run(this._now(), eventId);
    });
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
    const rows = this.database.prepare("SELECT c.* FROM memory_claims c JOIN memory_revisions r ON r.revision_id = c.current_revision_id WHERE c.owner_id = ? ORDER BY r.created_at DESC, c.claim_id").all(ownerId);
    return rows.filter((claim) => {
      if (kinds && !kinds.includes(claim.kind)) return false;
      if (!allowedScope(scope, claim.scope, excludedScopes)) return false;
      if (this._claimTombstoned(claim, scope)) return false;
      const current = this._revision(claim.current_revision_id);
      if (!current || current.status === "retired" || (current.expires_at && current.expires_at <= now)) return false;
      if (!includeCandidates && current.status !== "active") return false;
      if (!queryText) return true;
      return `${claim.subject} ${claim.predicate} ${current.value_json}`.toLowerCase().includes(queryText);
    }).map((claim) => this._claimView(claim));
  }

  /** Ends a claim without replacing it ("I left that job", a lesson a later success disproved). History is kept. */
  retire({ claimId, expectedRevision, sourceIds = [], authorType = "user", reason = null }) {
    const current = this._revision(this._requireClaim(claimId).current_revision_id);
    const value = parse(current.value_json);
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
    return this.database.prepare("SELECT DISTINCT rs.source_id FROM memory_revision_sources rs JOIN memory_revisions r ON r.revision_id = rs.revision_id WHERE r.claim_id = ?")
      .all(claimId).map((row) => row.source_id);
  }

  link({ fromClaimId, toClaimId, type = "contradicts" }) {
    this._requireClaim(fromClaimId); this._requireClaim(toClaimId);
    this.database.prepare("INSERT OR IGNORE INTO memory_links (from_claim_id, to_claim_id, link_type, created_at) VALUES (?, ?, ?, ?)").run(fromClaimId, toClaimId, type, this._now());
  }

  links(claimId) {
    return this.database.prepare("SELECT * FROM memory_links WHERE from_claim_id = ? OR to_claim_id = ?").all(claimId, claimId)
      .map((row) => ({ fromClaimId: row.from_claim_id, toClaimId: row.to_claim_id, type: row.link_type }));
  }

  // -------------------------------------------------------------- learning

  /**
   * The events the learner reads: each conversation turn (the person's words
   * come from the message the event links to, so there is one copy of them)
   * and each settled piece of work. Each event becomes a source claims can
   * cite, under the event's own id.
   */
  _learnable(where, args) {
    return this.database.prepare(`
      SELECT e.event_id, e.type, e.at, e.conversation_id, e.data_json, u.content AS said, r.content AS reply
      FROM events e
      LEFT JOIN learning l ON l.event_id = e.event_id
      LEFT JOIN messages u ON e.type = 'turn' AND u.message_id = e.message_id
      LEFT JOIN messages r ON r.reply_to = u.message_id
      WHERE e.type IN ('turn', 'episode') AND ${where}
    `).all(...args).map((row) => {
      const data = parse(row.data_json, {});
      const content = data.erased ? { erased: true } : row.type === "turn" ? { userText: row.said, evReply: row.reply, action: data.action ?? null, recentWork: data.recentWork ?? "" } : data;
      return { eventId: row.event_id, conversationId: row.conversation_id, type: row.type, content, sourceId: row.event_id, createdAt: row.at };
    });
  }

  /** Records a settled piece of work for the learner, once per settled revision. */
  recordEpisode({ workId, revision, conversationId = null, content }) {
    this._transaction(() => {
      const seen = this.database.prepare("SELECT 1 FROM events WHERE type = 'episode' AND work_id = ? AND json_extract(data_json, '$.revision') = ?").get(workId, revision);
      if (!seen) this.store.event({ type: "episode", workId, conversationId, data: { ...content, revision } });
    });
  }

  /** Events not yet analysed, oldest first, skipping ones that failed too often. */
  pendingEvents({ ownerId, limit = 20, maxAttempts = 3 }) {
    const events = this._learnable("l.analysed_at IS NULL AND COALESCE(l.attempts, 0) < ? ORDER BY e.seq LIMIT ?", [maxAttempts, limit]);
    const source = this.database.prepare("INSERT OR IGNORE INTO memory_sources (source_id, owner_id, scope, source_type, source_ref, metadata_json, created_at) VALUES (?, ?, 'global', ?, ?, ?, ?)");
    for (const event of events) source.run(event.eventId, ownerId, event.type === "episode" ? "episode" : "conversation", `event:${event.eventId}`, JSON.stringify({ conversationId: event.conversationId }), event.createdAt);
    return events;
  }

  /** Already analysed events of a conversation up to `before`, newest last, as context for the next analysis. */
  priorEvents({ conversationId, before, limit = 4 }) {
    return this._learnable("l.analysed_at IS NOT NULL AND e.conversation_id IS ? AND e.at <= ? ORDER BY e.seq DESC LIMIT ?", [conversationId, before, limit]).reverse();
  }

  finishEvent({ eventId, error = null }) {
    this.database.prepare(`
      INSERT INTO learning (event_id, attempts, analysed_at, last_error) VALUES (?, 1, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET attempts = attempts + 1, analysed_at = COALESCE(excluded.analysed_at, analysed_at), last_error = excluded.last_error
    `).run(eventId, error ? null : this._now(), error ? String(error).slice(0, 500) : null);
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
      if (!allowedScope(scope, this._requireSource(sourceId).scope, excludedScopes)) throw codedError("MEMORY_SCOPE_DENIED", "Source is outside the context scope");
    }
    const builtAt = this._now();
    return this._transaction(() => {
      const memoryRevision = this.store.counter("memory_revision");
      const eraseEpoch = this._currentEraseEpoch();
      this.database.prepare(`
        INSERT INTO memory_context_manifests (manifest_id, owner_id, task_id, conversation_id, scope, memory_revision, erase_epoch, source_ids_json, claim_revision_ids_json, excluded_scopes_json, token_budget, built_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(manifestId, ownerId, taskId, conversationId, scope, memoryRevision, eraseEpoch, JSON.stringify(sources), JSON.stringify(claims), JSON.stringify(excludedScopes), tokenBudget, builtAt);
      return { manifestId, ownerId, taskId, conversationId, scope, memoryRevision, eraseEpoch, sourceIds: sources, claimRevisionIds: claims, excludedScopes, tokenBudget, builtAt };
    });
  }

  getContextManifest(manifestId) {
    return mapManifest(this.database.prepare("SELECT * FROM memory_context_manifests WHERE manifest_id = ?").get(required(manifestId, "manifestId")));
  }
}
