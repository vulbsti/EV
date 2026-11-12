import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { codedError } from "./store.mjs";

/**
 * Brings sessions the person had in other tools into EV's store, where the
 * same search and read find them. One small reader per tool turns the new
 * lines of a session file into what was said; everything else here is shared.
 *
 * Imported text is information, never an instruction and never a fact about
 * the person: it is written to its own tables and reaches EV only through
 * search and read. A message is identified by the tool's own id for it, so
 * importing again adds nothing that is already there; each session file
 * remembers how far it has been read, so a grown file is read from there on.
 * Session files are assumed to be appended to, one JSON object per line.
 */

const MAX_TEXT = 32_000;

/**
 * Claude Code: ~/.claude/projects/<encoded project path>/<session id>.jsonl.
 * Keeps what the person typed and what the assistant wrote as text. Tool
 * calls and their results are bulky, so a tool call leaves only its name, as
 * a note on the assistant's next words; thinking, tool output, attachments,
 * injected context (isMeta), compaction summaries and subagent lines are
 * skipped, as is any line it does not recognise.
 */
function readClaudeCode(lines) {
  let project = null;
  let sourceSessionId = null;
  const said = [];
  let used = [];
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== "object") continue;
    if (!project && typeof row.cwd === "string") project = row.cwd;
    if (!sourceSessionId && typeof row.sessionId === "string") sourceSessionId = row.sessionId;
    if ((row.type !== "user" && row.type !== "assistant") || typeof row.uuid !== "string") continue;
    if (row.isMeta || row.isSidechain || row.isCompactSummary) continue;
    const content = row.message?.content;
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
    const text = blocks.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text.trim()).filter(Boolean).join("\n\n");
    if (text) {
      const names = [...new Set(used)];
      const note = row.type === "assistant" && names.length ? `[after using ${names.slice(0, 5).join(", ")}${names.length > 5 ? ` and ${names.length - 5} more tools` : ""}] ` : "";
      said.push({ id: row.uuid, role: row.type, text: note + text, at: row.timestamp });
      used = [];
    }
    if (row.type === "assistant") used.push(...blocks.filter((block) => block?.type === "tool_use" && typeof block.name === "string").map((block) => block.name));
  }
  return { project, sourceSessionId, said };
}

/** The tools EV can import from: a name for people and a reader for its session files. */
const READERS = {
  "claude-code": { name: "Claude Code", read: readClaudeCode }
};

/** The name of a tool, as people know it. */
export const toolName = (tool) => READERS[tool]?.name ?? tool;

/** Session files under a folder; a session's own folder (subagents, tool output) is skipped. */
function sessionFiles(dir, depth = 0) {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const files = entries.filter((entry) => entry.isFile() && extname(entry.name) === ".jsonl").map((entry) => entry.name);
  const folders = depth < 6 ? entries.filter((entry) => entry.isDirectory() && !files.includes(`${entry.name}.jsonl`)) : [];
  return [...files.map((name) => join(dir, name)), ...folders.flatMap((entry) => sessionFiles(join(dir, entry.name), depth + 1))];
}

/** The whole lines of `file` after byte `from`, and where they end. */
function newLines(file, from, size) {
  const buffer = Buffer.alloc(size - from);
  const fd = openSync(file, "r");
  try { readSync(fd, buffer, 0, buffer.length, from); } finally { closeSync(fd); }
  const end = buffer.lastIndexOf(10) + 1;
  return { lines: buffer.subarray(0, end).toString("utf8").split("\n"), readTo: from + end };
}

function importFile(store, tool, reader, file) {
  const { db } = store;
  const known = db.prepare("SELECT * FROM outside_sessions WHERE tool = ? AND path = ?").get(tool, file);
  const size = statSync(file).size;
  // A file shorter than what was read was rewritten: read it again, the ids keep it from doubling.
  const from = known && known.read_to <= size ? known.read_to : 0;
  const { lines, readTo } = newLines(file, from, size);
  const { project, sourceSessionId, said } = reader.read(lines);
  return store.tx(() => {
    const sessionId = known?.session_id ?? randomUUID();
    const at = store.now();
    if (!known) {
      db.prepare("INSERT INTO outside_sessions (session_id, tool, path, project, source_session_id, imported_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(sessionId, tool, file, project ?? basename(dirname(file)), sourceSessionId, at);
    }
    const seen = db.prepare("SELECT 1 FROM outside_messages m JOIN outside_sessions s ON s.session_id = m.session_id WHERE m.source_id = ? AND s.tool = ?");
    const insert = db.prepare("INSERT INTO outside_messages (message_id, session_id, source_id, seq, role, content, at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    let seq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM outside_messages WHERE session_id = ?").get(sessionId).seq;
    let added = 0;
    for (const { id, role, text, at: time } of said) {
      // The same message can sit in two files (a resumed session copies its history).
      if (seen.get(id, tool)) continue;
      const when = typeof time === "string" && !Number.isNaN(Date.parse(time)) ? new Date(time).toISOString() : at;
      insert.run(randomUUID(), sessionId, id, ++seq, role, text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}… [cut]` : text, when);
      added++;
    }
    db.prepare("UPDATE outside_sessions SET read_to = ?, imported_at = ? WHERE session_id = ?").run(readTo, at, sessionId);
    if (added) store.event({ type: "imported", data: { session: sessionId, tool, added } });
    const row = db.prepare("SELECT project FROM outside_sessions WHERE session_id = ?").get(sessionId);
    return { session: sessionId, path: file, project: row.project, added };
  });
}

/**
 * Imports the session at `path`, or every session under it if it is a
 * folder, from the tool `source`. Returns what each file added.
 */
export function importSessions(store, { source, path }) {
  const reader = READERS[source];
  if (!reader) throw Object.assign(codedError("UNKNOWN_SOURCE", `EV cannot import from "${source}"; it knows ${Object.keys(READERS).join(", ")}`), { statusCode: 400 });
  if (typeof path !== "string" || !isAbsolute(path)) throw Object.assign(codedError("INVALID_PATH", "path must be an absolute path on this machine"), { statusCode: 400 });
  let stat;
  try { stat = statSync(path); } catch { throw Object.assign(codedError("INVALID_PATH", `Nothing is at ${path}`), { statusCode: 400 }); }
  const files = stat.isDirectory() ? sessionFiles(path) : [path];
  const sessions = files.map((file) => importFile(store, source, reader, file));
  return { source, sessions, added: sessions.reduce((sum, session) => sum + session.added, 0) };
}
