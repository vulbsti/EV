import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { ensurePrivateDirectorySync, secureDatabaseFilesSync } from "./file-permissions.mjs";

/**
 * Everything EV keeps, in one SQLite file. Large content (delivered files,
 * agent workspaces) lives in folders beside it, and the records here point at
 * it. Rules:
 *
 * - Ids are random. Nothing is identified by a title, a position or a time.
 * - Records link to where they came from: a message to the work it started,
 *   was sent into or reports on; a result to its work; an event to its
 *   conversation, work and message; a memory to the events it rests on.
 * - State and the event that explains it are written in one transaction.
 * - Erase follows those links, and then clears what SQLite keeps of the old
 *   bytes (secure_delete for free space, a truncating checkpoint for the WAL).
 * - One full-text index covers messages, work, results, memory and sessions
 *   imported from other tools, kept in step with them by triggers, so
 *   erasing a record erases its entry too.
 */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA secure_delete = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);

-- One line per thing that happened, in order. Never edited, except that erase blanks data_json.
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  conversation_id TEXT,
  work_id TEXT,
  message_id TEXT,
  responsibility_id TEXT,
  data_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS events_work ON events (work_id, seq);
CREATE INDEX IF NOT EXISTS events_message ON events (message_id);
CREATE INDEX IF NOT EXISTS events_type ON events (type, seq);
CREATE INDEX IF NOT EXISTS events_responsibility ON events (responsibility_id, seq);

CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  client_message_id TEXT UNIQUE,
  reply_to TEXT REFERENCES messages(message_id),
  work_id TEXT,
  intent_json TEXT,
  at TEXT NOT NULL,
  UNIQUE (conversation_id, seq)
);
CREATE INDEX IF NOT EXISTS messages_reply ON messages (reply_to);

-- One inbox per conversation: whatever needs EV's attention, saved on arrival
-- and handled in order. handled_at is set in the transaction that records
-- what EV did about it, so an item is handled exactly once across a crash.
CREATE TABLE IF NOT EXISTS inbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  message_id TEXT REFERENCES messages(message_id),
  at TEXT NOT NULL,
  handled_at TEXT
);
CREATE INDEX IF NOT EXISTS inbox_waiting ON inbox (conversation_id, seq) WHERE handled_at IS NULL;

CREATE TABLE IF NOT EXISTS work (
  work_id TEXT PRIMARY KEY,
  conversation_id TEXT,
  parent_id TEXT,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL,
  lease_id TEXT,
  fencing_token TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 0,
  worker_id TEXT,
  run_id TEXT,
  started_at TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS work_parent ON work (parent_id);

-- Each result a piece of work delivered, and the files that came with it (bytes under files/).
CREATE TABLE IF NOT EXISTS results (
  result_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES work(work_id),
  run_id TEXT,
  result_json TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS results_work ON results (work_id, at);
CREATE TABLE IF NOT EXISTS files (
  file_id TEXT PRIMARY KEY,
  result_id TEXT NOT NULL REFERENCES results(result_id),
  work_id TEXT NOT NULL REFERENCES work(work_id),
  title TEXT,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS files_result ON files (result_id);

-- Memory: a statement and its versions, resting on sources (an event's id, or a manual entry).
CREATE TABLE IF NOT EXISTS memory_sources (
  source_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_claims (
  claim_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  current_revision_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_revisions (
  revision_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES memory_claims(claim_id),
  revision_number INTEGER NOT NULL,
  value_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'candidate', 'disputed', 'retired')),
  author_type TEXT NOT NULL,
  supersedes_revision_id TEXT REFERENCES memory_revisions(revision_id),
  memory_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  valid_from TEXT,
  valid_until TEXT,
  expires_at TEXT,
  review_after TEXT,
  UNIQUE (claim_id, revision_number)
);
CREATE TABLE IF NOT EXISTS memory_revision_sources (
  revision_id TEXT NOT NULL REFERENCES memory_revisions(revision_id),
  source_id TEXT NOT NULL REFERENCES memory_sources(source_id),
  PRIMARY KEY (revision_id, source_id)
);
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
CREATE TABLE IF NOT EXISTS memory_links (
  from_claim_id TEXT NOT NULL REFERENCES memory_claims(claim_id),
  to_claim_id TEXT NOT NULL REFERENCES memory_claims(claim_id),
  link_type TEXT NOT NULL CHECK (link_type IN ('contradicts')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_claim_id, to_claim_id, link_type)
);
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
-- Which events the learner has read.
CREATE TABLE IF NOT EXISTS learning (
  event_id TEXT PRIMARY KEY REFERENCES events(event_id),
  analysed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

-- Standing work: a watched source, what was seen, and the work it prepared.
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
CREATE UNIQUE INDEX IF NOT EXISTS standing_active_resource ON standing_responsibilities (
  owner_id, json_extract(mandate_json, '$.resourceRef'), json_extract(mandate_json, '$.reportingDestination')
) WHERE status = 'active';
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
  reason TEXT,
  UNIQUE (responsibility_id, source_revision)
);
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

-- A session the person had in another tool (outside_sessions), and what was
-- said in it (outside_messages), written by the importers. source_id is the
-- tool's own id for the message, so importing again never adds it twice;
-- read_to is how many bytes of the file have been read.
CREATE TABLE IF NOT EXISTS outside_sessions (
  session_id TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  path TEXT NOT NULL,
  project TEXT,
  source_session_id TEXT,
  read_to INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT NOT NULL,
  UNIQUE (tool, path)
);
CREATE TABLE IF NOT EXISTS outside_messages (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES outside_sessions(session_id),
  source_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  at TEXT NOT NULL,
  UNIQUE (session_id, source_id),
  UNIQUE (session_id, seq)
);
CREATE INDEX IF NOT EXISTS outside_messages_source ON outside_messages (source_id);

-- One full-text index over what EV holds: every message, every piece of work
-- (its title and brief), every result, every version of every memory, every
-- imported message.
-- Triggers keep it in step with the records, so whatever changes or erases a
-- record changes or erases its entry too; secure-delete makes FTS5 drop the
-- old terms instead of leaving them in its segments.
CREATE TABLE IF NOT EXISTS search_refs (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  conversation_id TEXT,
  at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5 (body, tokenize = 'porter unicode61');
INSERT INTO search_index (search_index, rank) VALUES ('secure-delete', 1);

CREATE TRIGGER IF NOT EXISTS index_message AFTER INSERT ON messages BEGIN
  INSERT INTO search_refs (ref, conversation_id, at) VALUES ('message:' || new.message_id, new.conversation_id, new.at);
  INSERT INTO search_index (rowid, body) VALUES (last_insert_rowid(), new.content);
END;
CREATE TRIGGER IF NOT EXISTS reindex_message AFTER UPDATE OF content ON messages BEGIN
  DELETE FROM search_index WHERE rowid = (SELECT id FROM search_refs WHERE ref = 'message:' || new.message_id);
  INSERT INTO search_index (rowid, body) SELECT id, new.content FROM search_refs WHERE ref = 'message:' || new.message_id AND new.content <> '[forgotten]';
END;
CREATE TRIGGER IF NOT EXISTS index_outside_message AFTER INSERT ON outside_messages BEGIN
  INSERT INTO search_refs (ref, conversation_id, at) VALUES ('session:' || new.message_id, NULL, new.at);
  INSERT INTO search_index (rowid, body) VALUES (last_insert_rowid(), new.content);
END;
CREATE TRIGGER IF NOT EXISTS reindex_outside_message AFTER UPDATE OF content ON outside_messages BEGIN
  DELETE FROM search_index WHERE rowid = (SELECT id FROM search_refs WHERE ref = 'session:' || new.message_id);
  INSERT INTO search_index (rowid, body) SELECT id, new.content FROM search_refs WHERE ref = 'session:' || new.message_id AND new.content <> '[forgotten]';
END;
CREATE TRIGGER IF NOT EXISTS index_work AFTER INSERT ON work BEGIN
  INSERT INTO search_refs (ref, conversation_id, at) VALUES ('work:' || new.work_id, new.conversation_id, new.created_at);
  INSERT INTO search_index (rowid, body) VALUES (last_insert_rowid(), concat_ws(char(10), json_extract(new.input_json, '$.metadata.title'), json_extract(new.input_json, '$.metadata.sourceRequest')));
END;
CREATE TRIGGER IF NOT EXISTS index_result AFTER INSERT ON results BEGIN
  INSERT INTO search_refs (ref, conversation_id, at) VALUES ('result:' || new.result_id, (SELECT conversation_id FROM work WHERE work_id = new.work_id), new.at);
  INSERT INTO search_index (rowid, body) VALUES (last_insert_rowid(), concat_ws(char(10), (SELECT json_extract(input_json, '$.metadata.title') FROM work WHERE work_id = new.work_id), json_extract(new.result_json, '$.text')));
END;
CREATE TRIGGER IF NOT EXISTS index_memory AFTER INSERT ON memory_revisions BEGIN
  INSERT INTO search_refs (ref, conversation_id, at) VALUES ('memory:' || new.revision_id, NULL, new.created_at);
  INSERT INTO search_index (rowid, body) VALUES (last_insert_rowid(), CASE json_type(new.value_json) WHEN 'text' THEN json_extract(new.value_json, '$') WHEN 'object' THEN json_extract(new.value_json, '$.text') END);
END;
CREATE TRIGGER IF NOT EXISTS reindex_memory AFTER UPDATE OF value_json ON memory_revisions BEGIN
  DELETE FROM search_index WHERE rowid = (SELECT id FROM search_refs WHERE ref = 'memory:' || new.revision_id);
  INSERT INTO search_index (rowid, body) SELECT id, CASE json_type(new.value_json) WHEN 'text' THEN json_extract(new.value_json, '$') WHEN 'object' THEN json_extract(new.value_json, '$.text') END FROM search_refs WHERE ref = 'memory:' || new.revision_id;
END;
`;

const ERASED_TEXT = "[forgotten]";
const ERASED_DATA = JSON.stringify({ erased: true });

export function codedError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

export function parse(text, fallback = null) {
  return text === null || text === undefined ? fallback : JSON.parse(text);
}

function mapEvent(row) {
  return { eventId: row.event_id, seq: row.seq, type: row.type, at: row.at, conversationId: row.conversation_id, workId: row.work_id, messageId: row.message_id, responsibilityId: row.responsibility_id, data: parse(row.data_json, {}) };
}

function mapMessage(row) {
  if (!row) return null;
  return {
    messageId: row.message_id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    clientMessageId: row.client_message_id,
    replyTo: row.reply_to,
    taskId: row.work_id,
    intent: parse(row.intent_json),
    sequence: row.seq,
    createdAt: row.at
  };
}

/** Opens (or creates) EV's store. One connection per process. */
export function openStore({ path = ":memory:" } = {}) {
  const onDisk = path !== ":memory:";
  if (onDisk) ensurePrivateDirectorySync(dirname(path));
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  if (onDisk) secureDatabaseFilesSync(path);
  let depth = 0;
  let scrubAfterCommit = false;

  /** Runs `fn` in one transaction; nested calls join it as a savepoint. */
  function tx(fn) {
    if (depth) {
      const name = `s${depth++}`;
      db.exec(`SAVEPOINT ${name}`);
      try { const result = fn(); db.exec(`RELEASE ${name}`); return result; }
      catch (error) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); throw error; }
      finally { depth--; }
    }
    db.exec("BEGIN IMMEDIATE");
    depth = 1;
    let result;
    try { result = fn(); db.exec("COMMIT"); }
    catch (error) {
      scrubAfterCommit = false;
      try { db.exec("ROLLBACK"); } catch { /* keep the original error */ }
      throw error;
    } finally { depth = 0; }
    if (scrubAfterCommit) {
      scrubAfterCommit = false;
      // Erased bytes can still sit in the WAL; move every page home and empty it.
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    }
    return result;
  }

  const now = () => new Date().toISOString();

  function counter(key) {
    return db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? 0;
  }

  function bump(key) {
    db.prepare("INSERT INTO meta (key, value) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET value = value + 1").run(key);
    return counter(key);
  }

  /** Appends one event. Call it inside the transaction that changes the state it explains. */
  function event({ type, conversationId = null, workId = null, messageId = null, responsibilityId = null, data = {} }) {
    const eventId = randomUUID();
    const at = now();
    const { lastInsertRowid } = db.prepare("INSERT INTO events (event_id, type, at, conversation_id, work_id, message_id, responsibility_id, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(eventId, type, at, conversationId, workId, messageId, responsibilityId, JSON.stringify(data ?? {}));
    return { eventId, seq: Number(lastInsertRowid), at };
  }

  function events({ workId, responsibilityId }) {
    const [column, value] = workId ? ["work_id", workId] : ["responsibility_id", responsibilityId];
    return db.prepare(`SELECT * FROM events WHERE ${column} = ? ORDER BY seq`).all(value).map(mapEvent);
  }

  function getEvent(eventId) {
    const row = db.prepare("SELECT * FROM events WHERE event_id = ?").get(eventId);
    return row ? mapEvent(row) : null;
  }

  // ---------------------------------------------------------- conversations

  function nextSeq(conversationId) {
    return db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE conversation_id = ?").get(conversationId).seq;
  }

  function insertMessage({ conversationId, role, content, clientMessageId = null, replyTo = null, workId = null, intent = null }) {
    const messageId = randomUUID();
    db.prepare("INSERT INTO messages (message_id, conversation_id, seq, role, content, client_message_id, reply_to, work_id, intent_json, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(messageId, conversationId, nextSeq(conversationId), role, content, clientMessageId, replyTo, workId, intent === null ? null : JSON.stringify(intent), now());
    return messageId;
  }

  function getTurn(messageId) {
    const user = db.prepare("SELECT * FROM messages WHERE message_id = ?").get(messageId);
    if (!user) return null;
    const reply = db.prepare("SELECT * FROM messages WHERE reply_to = ?").get(messageId);
    const userMessage = mapMessage(user);
    return { userMessage, assistantMessage: mapMessage(reply), intent: userMessage.intent, workId: user.work_id };
  }

  // ------------------------------------------------------------------ inbox

  function mapItem(row) {
    if (!row) return null;
    return { itemId: row.item_id, conversationId: row.conversation_id, kind: row.kind, at: row.at, message: mapMessage(db.prepare("SELECT * FROM messages WHERE message_id = ?").get(row.message_id)) };
  }

  /**
   * Saves the person's message and puts it in its conversation's inbox, before
   * EV has read it. Sending the same clientMessageId again returns the saved one.
   */
  function receive({ conversationId, clientMessageId, text }) {
    return tx(() => {
      const existing = db.prepare("SELECT * FROM messages WHERE client_message_id = ? AND role = 'user'").get(clientMessageId);
      if (existing) return { message: mapMessage(existing), replayed: true };
      const messageId = insertMessage({ conversationId, role: "user", content: text, clientMessageId });
      db.prepare("INSERT INTO inbox (item_id, conversation_id, kind, message_id, at) VALUES (?, ?, 'message', ?, ?)").run(randomUUID(), conversationId, messageId, now());
      event({ type: "received", conversationId, messageId });
      return { message: mapMessage(db.prepare("SELECT * FROM messages WHERE message_id = ?").get(messageId)), replayed: false };
    });
  }

  /** The oldest item in this conversation's inbox that EV has not handled. */
  function nextItem(conversationId) {
    return mapItem(db.prepare("SELECT * FROM inbox WHERE conversation_id = ? AND handled_at IS NULL ORDER BY seq LIMIT 1").get(conversationId));
  }

  /** Conversations with something waiting in their inbox. */
  function waitingConversations() {
    return db.prepare("SELECT DISTINCT conversation_id FROM inbox WHERE handled_at IS NULL").all().map((row) => row.conversation_id);
  }

  /**
   * Records what EV did about an item and marks it handled, in one
   * transaction: its reply, the work the message started or was sent into,
   * and the "turn" event the learner reads. Call it inside the transaction
   * that starts or instructs that work, so neither can happen without the other.
   */
  function handled(itemId, { reply = null, workId = null, intent = null, data = {} } = {}) {
    return tx(() => {
      const row = db.prepare("SELECT * FROM inbox WHERE item_id = ?").get(itemId);
      if (!row) throw codedError("ITEM_NOT_FOUND", `Unknown inbox item: ${itemId}`);
      if (row.handled_at) throw codedError("ITEM_HANDLED", `Inbox item ${itemId} was already handled`);
      db.prepare("UPDATE inbox SET handled_at = ? WHERE item_id = ?").run(now(), itemId);
      if (row.message_id) db.prepare("UPDATE messages SET work_id = ?, intent_json = ? WHERE message_id = ?").run(workId, intent === null ? null : JSON.stringify(intent), row.message_id);
      if (reply) insertMessage({ conversationId: row.conversation_id, role: "assistant", content: reply, replyTo: row.message_id, workId });
      const { eventId } = event({ type: "turn", conversationId: row.conversation_id, workId, messageId: row.message_id, data });
      return { eventId };
    });
  }

  /** A message EV sends on its own (work finished, work stuck). `key` makes it idempotent. */
  function recordUpdate({ conversationId, key, content, workId = null }) {
    const clientMessageId = `update:${key}`;
    return tx(() => {
      const existing = db.prepare("SELECT * FROM messages WHERE client_message_id = ?").get(clientMessageId);
      if (existing) return { ...mapMessage(existing), replayed: true };
      const messageId = insertMessage({ conversationId, role: "assistant", content, clientMessageId, workId });
      event({ type: "update", conversationId, workId, messageId });
      return { ...mapMessage(db.prepare("SELECT * FROM messages WHERE message_id = ?").get(messageId)), replayed: false };
    });
  }

  function listMessages(conversationId) {
    return db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq").all(conversationId).map(mapMessage);
  }

  /** The person's messages and EV's replies to them, oldest first; `before` limits them to earlier messages. */
  function listTurns(conversationId, { before = Number.MAX_SAFE_INTEGER } = {}) {
    return db.prepare("SELECT message_id FROM messages WHERE conversation_id = ? AND role = 'user' AND seq < ? ORDER BY seq").all(conversationId, before).map((row) => getTurn(row.message_id));
  }

  // ------------------------------------------------------------------ erase

  /** Removes a message's words, and its reply's, and blanks every event about them. */
  function eraseMessage(messageId) {
    tx(() => {
      const ids = [messageId, ...db.prepare("SELECT message_id FROM messages WHERE reply_to = ?").all(messageId).map((row) => row.message_id)];
      for (const id of ids) {
        db.prepare("UPDATE messages SET content = ?, intent_json = NULL WHERE message_id = ?").run(ERASED_TEXT, id);
        db.prepare("UPDATE events SET data_json = ? WHERE message_id = ?").run(ERASED_DATA, id);
      }
      scrubAfterCommit = true;
    });
  }

  /** Blanks one event and follows its link to the message it records. */
  function eraseEvent(eventId) {
    tx(() => {
      const row = db.prepare("SELECT message_id FROM events WHERE event_id = ?").get(eventId);
      if (!row) return;
      db.prepare("UPDATE events SET data_json = ? WHERE event_id = ?").run(ERASED_DATA, eventId);
      if (row.message_id) eraseMessage(row.message_id);
      scrubAfterCommit = true;
    });
  }

  /** Marks that this transaction removed words, so the WAL is emptied after it commits. */
  function erased() { scrubAfterCommit = true; }

  // ----------------------------------------------------------------- search

  /**
   * The best matches for `query` across everything indexed, as
   * { ref, conversationId, at, excerpt }. A record is found by any of the
   * query's words (stemmed), ranked by how well it matches them all.
   */
  function search(query, { limit = 8, exclude = [] } = {}) {
    const words = [...new Set(String(query ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 24);
    if (!words.length) return [];
    return db.prepare(`
      SELECT r.ref, r.conversation_id, r.at, snippet(search_index, 0, '', '', '…', 40) AS excerpt
      FROM search_index JOIN search_refs r ON r.id = search_index.rowid
      WHERE search_index MATCH ? ORDER BY rank LIMIT ?
    `).all(words.map((word) => `"${word}"`).join(" OR "), limit + exclude.length)
      .filter((row) => !exclude.includes(row.ref)).slice(0, limit)
      .map((row) => ({ ref: row.ref, conversationId: row.conversation_id, at: row.at, excerpt: row.excerpt }));
  }

  return {
    db, path, tx, now, counter, bump, event, events, getEvent,
    receive, nextItem, waitingConversations, handled, recordUpdate, getTurn, listMessages, listTurns,
    eraseMessage, eraseEvent, erased, search,
    close: () => db.close()
  };
}
