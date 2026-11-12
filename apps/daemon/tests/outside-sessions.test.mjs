import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importSessions } from "../lib/outside-sessions.mjs";
import { openStore } from "../lib/store.mjs";

const line = (uuid, type, content, extra = {}) => `${JSON.stringify({ type, uuid, sessionId: "s-1", cwd: "/home/dev/shop", timestamp: "2026-11-01T10:00:00.000Z", message: { role: type, content }, ...extra })}\n`;

test("importing a Claude Code session again adds only what is new, by the session's own ids", () => {
  const root = mkdtempSync(join(tmpdir(), "ev-import-"));
  const store = openStore();
  try {
    const path = join(root, "s-1.jsonl");
    writeFileSync(path, [
      line("u1", "user", "The ticket is KESTREL-1."),
      line("a1", "assistant", [{ type: "text", text: "Looking." }, { type: "tool_use", id: "t1", name: "Grep", input: {} }]),
      line("u2", "user", [{ type: "tool_result", tool_use_id: "t1", content: "secret tool output" }]),
      line("m1", "user", "injected context", { isMeta: true }),
      line("a2", "assistant", [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Found it." }]),
      "{\"type\":\"something-new\"}\nnot json\n"
    ].join(""));
    const importAll = () => importSessions(store, { source: "claude-code", path: root }).added;
    assert.equal(importAll(), 3);
    assert.equal(importAll(), 0);
    appendFileSync(path, line("u3", "user", "Thanks.") + line("u1", "user", "The ticket is KESTREL-1.") + "{\"type\":\"user\",\"uu");
    assert.equal(importAll(), 1, "only the new message, not the repeated id or the half-written line");
    const said = store.db.prepare("SELECT content FROM outside_messages ORDER BY seq").all().map((row) => row.content);
    assert.deepEqual(said, ["The ticket is KESTREL-1.", "Looking.", "[after using Grep] Found it.", "Thanks."]);
    assert.equal(store.search("secret").length, 0);
    assert.equal(store.search("KESTREL").length, 1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
