import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import zlib from "node:zlib";

/**
 * OpenClaw (2026.10+) keeps each agent's session transcripts in a per-agent
 * SQLite store rather than JSONL files. EV only reads it: live usage and the
 * budget, the agent's final answer, and the reviewer's execution evidence.
 */
export function openClawStorePath(homeDir, agentId = "ev-worker") {
  return join(homeDir, ".openclaw", "agents", agentId, "agent", "openclaw-agent.sqlite");
}

function decode(row) {
  if (row.event_json) return JSON.parse(row.event_json);
  // Large events are stored zstd-compressed; Node 24 can read them.
  if (row.event_zstd && zlib.zstdDecompressSync) return JSON.parse(zlib.zstdDecompressSync(row.event_zstd).toString("utf8"));
  return null;
}

/** Transcript events for one session after `afterSeq`, oldest first. */
export function readTranscript({ homeDir, sessionId, afterSeq = 0 }) {
  const path = openClawStorePath(homeDir);
  if (!existsSync(path)) return { events: [], lastSeq: afterSeq };
  let database;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    database.exec("PRAGMA busy_timeout = 2000");
    const rows = database.prepare("SELECT seq, event_json, event_zstd FROM transcript_events WHERE session_id = ? AND seq > ? ORDER BY seq ASC").all(sessionId, afterSeq);
    const events = [];
    for (const row of rows) {
      try { const event = decode(row); if (event) events.push(event); } catch { /* skip an unreadable event */ }
    }
    return { events, lastSeq: rows.at(-1)?.seq ?? afterSeq };
  } catch (error) {
    // Not created yet, or mid-migration: nothing to read this time.
    if (/no such table|unable to open/i.test(error.message)) return { events: [], lastSeq: afterSeq };
    // Still held by a run that is shutting down: the caller decides whether to wait.
    if (/SQLITE_BUSY|database is locked/i.test(error.message)) return { events: [], lastSeq: afterSeq, busy: true };
    throw error;
  } finally { database?.close(); }
}
