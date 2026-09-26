import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("the default product surface delegates general tasks and keeps results inline", async () => {
  const [html, javascript, server] = await Promise.all([
    readFile(resolve(projectRoot, "apps/web/assistant.html"), "utf8"),
    readFile(resolve(projectRoot, "apps/web/assistant.js"), "utf8"),
    readFile(resolve(projectRoot, "apps/daemon/server.mjs"), "utf8")
  ]);

  for (const id of ["conversation", "messages", "message-input", "message-submit", "connection-status"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(javascript, /\/api\/assistant\/conversation/);
  assert.match(javascript, /\/api\/assistant\/messages/);
  assert.match(javascript, /clientMessageId/);
  assert.match(javascript, /data-message-status/);
  assert.match(javascript, /localStorage/);
  assert.match(javascript, /retryPending/);
  assert.match(javascript, /synchronize/);
  assert.match(javascript, /after=\$\{after\}/);
  assert.match(javascript, /revision = Math\.max\(revision, body\.revision\)/);
  assert.match(javascript, /data-message-status=.*unconfirmed/);
  assert.match(javascript, /Interpreted as:/);
  assert.match(javascript, /Success criteria and boundaries/);
  assert.match(javascript, /Context manifest:/);
  assert.match(javascript, /Open reviewed content package/);
  assert.match(javascript, /task-report/);
  assert.match(server, /url\.searchParams\.get\("preview"\) === "1"/);
  assert.match(server, /r1-content-package-v1/);
  assert.match(server, /isR1ContentRequest/);
  assert.match(server, /openclaw-general-v1/);
  assert.match(server, /contextManifestId/);
  assert.match(server, /clientMessageId belongs to different message text/);
  assert.match(server, /Honcho-derived context is disabled until provider retention/);
  assert.doesNotMatch(server, /createHonchoDerivedMemoryAdapter/);
  assert.match(html, /give the work to an OpenClaw agent/);

  assert.doesNotMatch(html, /terminal-wall|broadcast-dock|spawn-dialog|orchestrator-input|task-list/);
  assert.doesNotMatch(javascript, /\/api\/companion|\/api\/tasks|\/api\/events/);
  assert.match(server, /url\.pathname === "\/" \? "assistant\.html"/);
  assert.match(server, /url\.pathname === "\/workstation" \? "index\.html"/);
  assert.doesNotMatch(server, /url\.pathname === "\/api\/companion"/);
});
