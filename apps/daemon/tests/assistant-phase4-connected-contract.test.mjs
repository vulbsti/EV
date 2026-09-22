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

test("Phase 4 product exposes one reviewed read-only GitHub responsibility", async () => {
  const [server, javascript, html] = await sources();
  assert.match(server, /GitHubPullRequestConnector/);
  assert.match(server, /StandingResponsibilityScheduler/);
  assert.match(server, /\/api\/assistant\/connections\/github\/verify/);
  assert.match(server, /\/api\/assistant\/responsibilities/);
  assert.match(server, /baseline_only/);
  assert.match(server, /prepare_only/);
  assert.match(javascript, /Verify read-only|verifyGitHubSource|read-only GitHub/i);
  assert.match(javascript, /comment, merge, push, label, publish, or message/);
  assert.match(html, /Standing responsibilities|responsibilities-panel/i);
});

test("Phase 4 result projection includes revision, failure, memory manifest, artifact, and revoke", async () => {
  const [server, javascript] = await sources();
  assert.match(server, /lastSourceRevision/);
  assert.match(server, /latestFailure/);
  assert.match(server, /updates/);
  assert.match(server, /contextManifestId/);
  assert.match(javascript, /sourceRevision/);
  assert.match(javascript, /contextManifestId/);
  assert.match(javascript, /Download verified prepared draft/);
  assert.match(javascript, /Prepared outcomes|responsibility-updates/);
  assert.match(javascript, /data-responsibility-action="revoke"/);
});
