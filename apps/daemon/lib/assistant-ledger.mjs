import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { ensurePrivateDirectorySync, secureDatabaseFilesSync } from "./file-permissions.mjs";

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  client_message_id TEXT UNIQUE,
  sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS messages_conversation_order
  ON messages (conversation_id, sequence, created_at, message_id);

CREATE UNIQUE INDEX IF NOT EXISTS messages_conversation_sequence
  ON messages (conversation_id, sequence);

CREATE TABLE IF NOT EXISTS intents (
  intent_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(message_id),
  conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  route TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS intents_message ON intents (message_id);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL UNIQUE REFERENCES intents(intent_id),
  conversation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('not_executable')),
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS tasks_conversation ON tasks (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS assistant_events (
  event_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  message_id TEXT REFERENCES messages(message_id),
  intent_id TEXT REFERENCES intents(intent_id),
  task_id TEXT REFERENCES tasks(task_id),
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS assistant_events_conversation
  ON assistant_events (conversation_id, occurred_at, event_id);
`;

function text(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function parseJson(value) {
  return JSON.parse(value);
}

function mapMessage(row) {
  return {
    messageId: row.message_id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    clientMessageId: row.client_message_id,
    sequence: row.sequence,
    createdAt: row.created_at
  };
}

function mapIntent(row) {
  if (!row) return null;
  return {
    intentId: row.intent_id,
    messageId: row.message_id,
    conversationId: row.conversation_id,
    kind: row.kind,
    route: row.route,
    status: row.status,
    payload: parseJson(row.payload_json),
    createdAt: row.created_at
  };
}

function mapTask(row) {
  if (!row) return null;
  return {
    taskId: row.task_id,
    intentId: row.intent_id,
    conversationId: row.conversation_id,
    status: row.status,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Small, synchronous SQLite-backed conversation ledger. Synchronous access is
 * intentional here: one transaction is the boundary for an accepted turn.
 */
export function createAssistantLedger({ path = ":memory:", clock = () => new Date() } = {}) {
  if (path !== ":memory:") ensurePrivateDirectorySync(dirname(path));
  const db = new DatabaseSync(path);
  if (path !== ":memory:") secureDatabaseFilesSync(path);
  let initialized = false;

  function initialize() {
    if (!initialized) {
      db.exec(SCHEMA);
      if (path !== ":memory:") secureDatabaseFilesSync(path);
      initialized = true;
    }
    return { path };
  }

  function now() {
    const value = clock();
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }

  function findByClientMessageId(clientMessageId) {
    const row = db.prepare("SELECT message_id FROM messages WHERE client_message_id = ?").get(clientMessageId);
    if (!row) return null;
    return getTurn(row.message_id);
  }

  function getTurn(messageId) {
    const user = db.prepare("SELECT * FROM messages WHERE message_id = ?").get(messageId);
    if (!user) return null;
    const assistant = db.prepare(
      "SELECT * FROM messages WHERE conversation_id = ? AND sequence = ? AND role = 'assistant'"
    ).get(user.conversation_id, user.sequence + 1);
    const intent = db.prepare("SELECT * FROM intents WHERE message_id = ?").get(user.message_id);
    const task = intent ? db.prepare("SELECT * FROM tasks WHERE intent_id = ?").get(intent.intent_id) : null;
    return {
      userMessage: mapMessage(user),
      assistantMessage: mapMessage(assistant),
      intent: mapIntent(intent),
      task: mapTask(task)
    };
  }

  function recordTurn(input = {}) {
    initialize();
    const conversationId = text(input.conversationId ?? "default", "conversationId");
    const clientMessageId = text(input.clientMessageId, "clientMessageId");
    const userText = text(input.userText ?? input.userContent, "userText");
    const assistantText = text(input.assistantText ?? input.assistantContent, "assistantText");
    const replay = findByClientMessageId(clientMessageId);
    if (replay) return { ...replay, replayed: true };

    const timestamp = now();
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const routedAction = input.skipTask !== true && (input.route === "orchestrator" || input.route === "worker" || input.route === "not_executable" || input.intentKind === "action" || input.intent?.kind === "action" || input.intent?.route === "not_executable");
    const intentInput = input.intent ?? (input.intentKind || input.route ? { kind: input.intentKind ?? "conversation", route: input.route ?? "companion" } : null);
    const hasIntent = Boolean(intentInput || routedAction);
    const intentId = hasIntent ? randomUUID() : null;
    const taskId = routedAction ? randomUUID() : null;

    db.exec("BEGIN IMMEDIATE");
    try {
      const nextSequence = db.prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM messages WHERE conversation_id = ?"
      ).get(conversationId).sequence;
      db.prepare(
        "INSERT INTO messages (message_id, conversation_id, role, content, client_message_id, sequence, created_at) VALUES (?, ?, 'user', ?, ?, ?, ?)"
      ).run(userMessageId, conversationId, userText, clientMessageId, nextSequence, timestamp);
      db.prepare(
        "INSERT INTO messages (message_id, conversation_id, role, content, client_message_id, sequence, created_at) VALUES (?, ?, 'assistant', ?, NULL, ?, ?)"
      ).run(assistantMessageId, conversationId, assistantText, nextSequence + 1, timestamp);

      if (hasIntent) {
        const kind = intentInput?.kind ?? "conversation";
        const route = intentInput?.route ?? input.route ?? (routedAction ? "orchestrator" : "companion");
        const payload = { ...intentInput, kind, route };
        const status = routedAction ? "not_executable" : "recorded";
        db.prepare(
          "INSERT INTO intents (intent_id, message_id, conversation_id, kind, route, status, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(intentId, userMessageId, conversationId, kind, route, status, JSON.stringify(payload), timestamp);
        if (taskId) {
          const title = input.taskTitle ?? userText;
          db.prepare(
            "INSERT INTO tasks (task_id, intent_id, conversation_id, status, title, created_at, updated_at) VALUES (?, ?, ?, 'not_executable', ?, ?, ?)"
          ).run(taskId, intentId, conversationId, title, timestamp, timestamp);
        }
      }

      const events = [
        [randomUUID(), "message.user_recorded", userMessageId, null, null, { role: "user", content: userText, clientMessageId }],
        [randomUUID(), "message.assistant_recorded", assistantMessageId, null, null, { role: "assistant", content: assistantText }]
      ];
      if (hasIntent) events.push([randomUUID(), "intent.recorded", userMessageId, intentId, null, { kind: intentInput?.kind ?? "conversation", route: intentInput?.route ?? input.route ?? "companion" }]);
      if (taskId) events.push([randomUUID(), "task.not_executable", userMessageId, intentId, taskId, { status: "not_executable" }]);
      const eventStmt = db.prepare(
        "INSERT INTO assistant_events (event_id, conversation_id, event_type, message_id, intent_id, task_id, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      );
      for (const [eventId, eventType, messageId, eventIntentId, eventTaskId, payload] of events) {
        eventStmt.run(eventId, conversationId, eventType, messageId, eventIntentId, eventTaskId, JSON.stringify(payload), timestamp);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
        const existing = findByClientMessageId(clientMessageId);
        if (existing) return { ...existing, replayed: true };
      }
      throw error;
    }
    return { ...getTurn(userMessageId), replayed: false };
  }

  /**
   * A message EV sends on its own, outside a user turn: work finished, work
   * stuck. `key` makes it idempotent, so the same update is never posted twice.
   */
  function recordUpdate({ conversationId = "default", key, content, taskId = null }) {
    initialize();
    text(conversationId, "conversationId");
    const clientMessageId = `update:${text(key, "key")}`;
    const body = text(content, "content");
    const existing = db.prepare("SELECT * FROM messages WHERE client_message_id = ?").get(clientMessageId);
    if (existing) return { ...mapMessage(existing), taskId, replayed: true };
    const timestamp = now();
    const messageId = randomUUID();
    db.exec("BEGIN IMMEDIATE");
    try {
      const sequence = db.prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM messages WHERE conversation_id = ?"
      ).get(conversationId).sequence;
      db.prepare(
        "INSERT INTO messages (message_id, conversation_id, role, content, client_message_id, sequence, created_at) VALUES (?, ?, 'assistant', ?, ?, ?, ?)"
      ).run(messageId, conversationId, body, clientMessageId, sequence, timestamp);
      db.prepare(
        "INSERT INTO assistant_events (event_id, conversation_id, event_type, message_id, intent_id, task_id, payload_json, occurred_at) VALUES (?, ?, 'message.update_recorded', ?, NULL, NULL, ?, ?)"
      ).run(randomUUID(), conversationId, messageId, JSON.stringify({ key, taskId }), timestamp);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { ...mapMessage(db.prepare("SELECT * FROM messages WHERE message_id = ?").get(messageId)), taskId, replayed: false };
  }

  function listUpdates(conversationId = "default") {
    initialize();
    return db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND role = 'assistant' AND client_message_id LIKE 'update:%' ORDER BY sequence ASC")
      .all(conversationId).map(mapMessage);
  }

  function listConversation(conversationId = "default") {
    initialize();
    text(conversationId, "conversationId");
    return db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY sequence ASC").all(conversationId).map(mapMessage);
  }

  function listTasks(conversationId = "default") {
    initialize();
    return db.prepare("SELECT * FROM tasks WHERE conversation_id = ? ORDER BY created_at ASC, task_id ASC").all(conversationId).map(mapTask);
  }

  function listTurns(conversationId = "default") {
    initialize();
    return db.prepare("SELECT message_id FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY sequence ASC")
      .all(conversationId)
      .map((row) => getTurn(row.message_id));
  }

  function close() { db.close(); }
  initialize();
  return {
    initialize,
    recordTurn,
    recordUpdate,
    listUpdates,
    listConversation,
    getConversation: listConversation,
    listTurns,
    listTasks,
    getTurn,
    findByClientMessageId,
    close
  };
}

export { SCHEMA as ASSISTANT_LEDGER_SCHEMA };
