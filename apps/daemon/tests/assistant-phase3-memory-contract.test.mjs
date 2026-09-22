import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantMemoryStore } from "../lib/assistant-memory.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

async function productSources() {
  return Promise.all([
    readFile(resolve(projectRoot, "apps/daemon/server.mjs"), "utf8"),
    readFile(resolve(projectRoot, "apps/web/assistant.js"), "utf8"),
    readFile(resolve(projectRoot, "apps/web/assistant.html"), "utf8")
  ]);
}

async function withMemory(run, { now = "2026-09-21T00:00:00.000Z" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ev-phase3-memory-contract-"));
  let current = new Date(now);
  const memory = AssistantMemoryStore.open({
    path: join(root, "memory.sqlite"),
    clock: () => current
  });
  try {
    return await run(memory, (value) => { current = new Date(value); });
  } finally {
    memory.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function addSource(memory, sourceId, scope = "global") {
  return memory.addSource({
    sourceId,
    ownerId: "person-1",
    scope,
    sourceType: "conversation",
    sourceRef: `message:${sourceId}`
  });
}

test("Phase 3 server exposes bounded memory create/list/explain/correction controls", async () => {
  const [server] = await productSources();

  // This is intentionally a red contract until the memory store is wired to
  // the public assistant surface. It keeps the required user-facing boundary
  // visible while implementation work is in progress.
  assert.match(server, /\/api\/assistant\/memory/);
  assert.match(server, /POST.*memory|memory.*POST/s);
  assert.match(server, /GET.*memory|memory.*GET/s);
  assert.match(server, /explain/);
  assert.match(server, /correct/);
  assert.match(server, /stop[-_ ]?use/);
  assert.match(server, /erase/);
});
test("Phase 3 server exposes retrieval of the exact context manifest used by a task", async () => {
  const [server] = await productSources();
  assert.match(server, /context[-_ ]?manifest|contextManifest|manifests/);
  assert.match(server, /memoryRevision|eraseEpoch|claimRevisionIds/);
  assert.match(server, /GET.*manifest|manifest.*GET/s);
});

test("memory explanation includes current revision, source provenance, and scope", async () => {
  await withMemory(async (memory) => {
    await addSource(memory, "source-explain");
    const claim = memory.createClaim({
      claimId: "claim-explain",
      ownerId: "person-1",
      subject: "user",
      predicate: "working_style",
      value: "prefers concrete drafts",
      sourceIds: ["source-explain"]
    });

    // getClaim is the current storage-level explanation primitive. The public
    // API should expose the same evidence without leaking raw storage access.
    const explanation = memory.getClaim(claim.claimId);
    assert.equal(explanation.scope, "global");
    assert.equal(explanation.current.value, "prefers concrete drafts");
    assert.equal(explanation.current.status, "active");
    assert.deepEqual(explanation.sources.map((source) => source.sourceId), ["source-explain"]);
    assert.equal(explanation.revisions[0].sources[0].sourceRef, "message:source-explain");
  });
});

test("exact scope filtering excludes private claims and refuses an out-of-scope manifest", async () => {
  await withMemory(async (memory) => {
    await addSource(memory, "source-global", "global");
    await addSource(memory, "source-private", "project:private");
    memory.createClaim({ claimId: "claim-global", ownerId: "person-1", scope: "global", subject: "user", predicate: "goal", value: "ship", sourceIds: ["source-global"] });
    const privateClaim = memory.createClaim({ claimId: "claim-private", ownerId: "person-1", scope: "project:private", subject: "user", predicate: "secret", value: "do not leak", sourceIds: ["source-private"] });

    assert.deepEqual(memory.recall({ ownerId: "person-1", scope: "project:other" }).map((claim) => claim.claimId), ["claim-global"]);
    assert.throws(
      () => memory.buildContextManifest({ ownerId: "person-1", scope: "project:other", claimRevisionIds: [privateClaim.current.revisionId] }),
      (error) => error.code === "MEMORY_SCOPE_DENIED"
    );
  });
});

test("temporary stop-use expires without restoring an erased claim", async () => {
  await withMemory(async (memory, setNow) => {
    await addSource(memory, "source-temporary");
    const claim = memory.createClaim({ claimId: "claim-temporary", ownerId: "person-1", subject: "user", predicate: "mode", value: "deep work", sourceIds: ["source-temporary"] });

    // The current store accepts no expiry field, so this test documents a
    // required Phase 3 gap. A scoped temporary exception must be durable,
    // expire against the injected clock, and remain distinct from erase.
    memory.stopUse({ ownerId: "person-1", targetType: "claim", targetId: claim.claimId, expiresAt: "2026-09-21T01:00:00.000Z" });
    assert.deepEqual(memory.recall({ ownerId: "person-1" }), []);
    setNow("2026-09-21T01:01:00.000Z");
    assert.deepEqual(memory.recall({ ownerId: "person-1" }).map((item) => item.claimId), [claim.claimId]);
  });
});

test("Understanding you is a small, visible control in the default assistant surface", async () => {
  const [, javascript, html] = await productSources();
  assert.match(html, /Understanding you|understanding-you|understanding/);
  assert.match(javascript, /memory|understanding/);
  assert.match(javascript, /explain|correct|stop|erase/);
  assert.doesNotMatch(html, /memory-editor|raw-memory|sqlite/);
});
