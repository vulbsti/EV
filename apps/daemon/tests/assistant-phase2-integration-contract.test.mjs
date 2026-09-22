import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

async function sources() {
  return Promise.all([
    readFile(resolve(projectRoot, "apps/daemon/server.mjs"), "utf8"),
    readFile(resolve(projectRoot, "apps/web/assistant.js"), "utf8"),
    readFile(resolve(projectRoot, "apps/web/assistant.html"), "utf8")
  ]);
}

test("Phase 2 exposes a separate authoritative task snapshot and event cursor", async () => {
  const [server, javascript] = await sources();
  assert.match(server, /\/api\/assistant\/tasks/);
  assert.match(server, /after/);
  assert.match(server, /snapshot|revision/);
  assert.match(server, /history|events|task_events/);
  assert.match(javascript, /\/api\/assistant\/tasks/);
  assert.match(javascript, /after/);
  assert.match(javascript, /taskId/);
  assert.match(javascript, /queued/);
  assert.match(javascript, /working|running/);
  assert.match(javascript, /completed/);
  assert.match(javascript, /failed/);
  assert.match(javascript, /cancelled|canceled/);
});

test("Phase 2 cancellation uses a replay-safe command envelope", async () => {
  const [server, javascript] = await sources();
  assert.match(server, /commands/);
  assert.match(server, /commandId/);
  assert.match(server, /expectedVersion|expectedRevision/);
  assert.match(server, /cancel/);
  assert.match(javascript, /commands/);
  assert.match(javascript, /commandId/);
  assert.match(javascript, /cancel/);
});

test("Phase 2 artifact delivery is receipt-bound and path-safe", async () => {
  const [server, javascript] = await sources();
  assert.match(server, /\/api\/assistant\/artifacts/);
  assert.match(server, /artifactRoot/);
  assert.match(server, /realpath|relativePath/);
  assert.match(server, /startsWith|sep/);
  assert.match(javascript, /artifact/);
  assert.match(javascript, /download|href/);
});

test("the assistant renders one inline task card instead of a second task dashboard", async () => {
  const [, javascript, html] = await sources();
  assert.match(html, /task-status|task-card|task-artifact/);
  assert.match(javascript, /data-task-id/);
  assert.match(javascript, /taskStatus|task\.status/);
  assert.match(javascript, /task-status|task-card/);
  assert.doesNotMatch(html, /task-list|dashboard|terminal-wall/);
});
