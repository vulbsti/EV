import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantMemoryStore } from "../lib/assistant-memory.mjs";

async function withMemory(run) {
  const root = await mkdtemp(join(tmpdir(), "ev-assistant-memory-"));
  const memory = AssistantMemoryStore.open({ path: join(root, "memory.sqlite") });
  try { return await run(memory); } finally { memory.close(); await rm(root, { recursive: true, force: true }); }
}

async function source(memory, sourceId, scope = "global") {
  return memory.addSource({ sourceId, ownerId: "person-1", scope, sourceType: "conversation", sourceRef: `message:${sourceId}` });
}

test("explicit claims are active while inferred claims remain quarantined", async () => {
  await withMemory(async (memory) => {
    await source(memory, "src-explicit");
    await source(memory, "src-inferred");
    const explicit = memory.createClaim({ claimId: "claim-explicit", ownerId: "person-1", subject: "user", predicate: "goal", value: "ship EV", sourceIds: ["src-explicit"] });
    const inferred = memory.createClaim({ claimId: "claim-inferred", ownerId: "person-1", subject: "user", predicate: "style", value: "concise", sourceIds: ["src-inferred"], inferred: true, authorType: "worker" });
    assert.equal(explicit.current.status, "active");
    assert.equal(inferred.current.status, "candidate");
    assert.deepEqual(memory.recall({ ownerId: "person-1" }).map((claim) => claim.claimId), ["claim-explicit"]);
    assert.deepEqual(memory.recall({ ownerId: "person-1", includeCandidates: true }).map((claim) => claim.claimId), ["claim-explicit", "claim-inferred"]);
  });
});

test("correction is compare-and-swap and preserves immutable revision history", async () => {
  await withMemory(async (memory) => {
    await source(memory, "src-correction");
    const first = memory.createClaim({ claimId: "claim-correction", ownerId: "person-1", subject: "user", predicate: "priority", value: "quality", sourceIds: ["src-correction"] });
    const corrected = memory.correct({ claimId: "claim-correction", expectedRevision: 1, value: "shipping", sourceIds: ["src-correction"] });
    assert.equal(corrected.current.revision, 2);
    assert.equal(corrected.revisions.length, 2);
    assert.equal(corrected.revisions[0].value, "quality");
    assert.equal(corrected.revisions[0].supersedesRevisionId, null);
    assert.throws(() => memory.correct({ claimId: "claim-correction", expectedRevision: 1, value: "stale", sourceIds: ["src-correction"] }), (error) => error.code === "REVISION_CONFLICT");
    assert.equal(memory.getClaim(first.claimId).current.value, "shipping");
  });
});

test("scope and provenance prevent private claims from entering another context", async () => {
  await withMemory(async (memory) => {
    await source(memory, "src-global", "global");
    await source(memory, "src-private", "project:private");
    memory.createClaim({ claimId: "claim-global", ownerId: "person-1", scope: "global", subject: "user", predicate: "goal", value: "ship", sourceIds: ["src-global"] });
    memory.createClaim({ claimId: "claim-private", ownerId: "person-1", scope: "project:private", subject: "user", predicate: "secret", value: "hidden", sourceIds: ["src-private"] });
    assert.deepEqual(memory.recall({ ownerId: "person-1", scope: "project:other" }).map((claim) => claim.claimId), ["claim-global"]);
    assert.deepEqual(memory.recall({ ownerId: "person-1", scope: "project:private", excludedScopes: ["project:private"] }).map((claim) => claim.claimId), ["claim-global"]);
    const privateClaim = memory.getClaim("claim-private");
    assert.throws(() => memory.buildContextManifest({ ownerId: "person-1", scope: "project:other", claimRevisionIds: [privateClaim.current.revisionId] }), (error) => error.code === "MEMORY_SCOPE_DENIED");
  });
});

test("stop-use is distinct from erase and erased claims cannot be resurrected", async () => {
  await withMemory(async (memory) => {
    await source(memory, "src-stop");
    const claim = memory.createClaim({ claimId: "claim-stop", ownerId: "person-1", subject: "user", predicate: "routine", value: "review", sourceIds: ["src-stop"] });
    memory.stopUse({ ownerId: "person-1", targetType: "claim", targetId: "claim-stop" });
    assert.deepEqual(memory.recall({ ownerId: "person-1" }), []);
    assert.equal(memory.getClaim("claim-stop").current.value, "review");
    memory.erase({ ownerId: "person-1", targetType: "claim", targetId: "claim-stop" });
    const tombstones = memory.listTombstones({ ownerId: "person-1", targetId: "claim-stop" });
    assert.deepEqual(tombstones.map((item) => item.action), ["stop_use", "erase"]);
    assert.throws(() => memory.correct({ claimId: claim.claimId, expectedRevision: 1, value: "resurrected" }), (error) => error.code === "MEMORY_ERASED");
    assert.deepEqual(memory.recall({ ownerId: "person-1", includeCandidates: true }), []);
  });
});

test("context manifest records exact revisions and erase epoch", async () => {
  await withMemory(async (memory) => {
    await source(memory, "src-context", "global");
    const claim = memory.createClaim({ claimId: "claim-context", ownerId: "person-1", subject: "user", predicate: "preference", value: "concrete drafts", sourceIds: ["src-context"] });
    const manifest = memory.buildContextManifest({ ownerId: "person-1", taskId: "task-1", conversationId: "conversation-1", scope: "project:ev", claimRevisionIds: [claim.current.revisionId], sourceIds: ["src-context"], tokenBudget: 500 });
    assert.equal(manifest.taskId, "task-1");
    assert.deepEqual(manifest.claimRevisionIds, [claim.current.revisionId]);
    assert.deepEqual(memory.getContextManifest(manifest.manifestId), manifest);
    memory.correct({ claimId: claim.claimId, expectedRevision: 1, value: "concrete examples", sourceIds: ["src-context"] });
    assert.throws(() => memory.buildContextManifest({ ownerId: "person-1", scope: "project:ev", claimRevisionIds: [claim.revisions[0].revisionId] }), (error) => error.code === "MEMORY_CONTEXT_STALE");
  });
});

test("memory proposals do not become active until accepted", async () => {
  await withMemory(async (memory) => {
    await source(memory, "src-proposal");
    const proposal = memory.propose({ proposalId: "proposal-1", ownerId: "person-1", subject: "user", predicate: "style", value: "direct", sourceIds: ["src-proposal"] });
    assert.equal(proposal.status, "pending");
    assert.deepEqual(memory.recall({ ownerId: "person-1" }), []);
    const claim = memory.acceptProposal({ proposalId: proposal.proposalId });
    assert.equal(claim.current.status, "active");
    assert.equal(memory.getProposal("proposal-1").status, "accepted");
    assert.deepEqual(memory.recall({ ownerId: "person-1" }).map((item) => item.claimId), [claim.claimId]);
  });
});

test("temporary stop-use expiries are normalized and invalid values are rejected", async () => {
  await withMemory(async (memory) => {
    await source(memory, "src-expiry");
    const claim = memory.createClaim({ claimId: "claim-expiry", ownerId: "person-1", subject: "user", predicate: "mode", value: "focused", sourceIds: ["src-expiry"] });
    const tombstone = memory.stopUse({ ownerId: "person-1", targetType: "claim", targetId: claim.claimId, expiresAt: "2026-09-21 01:00:00+00:00" });
    assert.equal(tombstone.expiresAt, "2026-09-21T01:00:00.000Z");
    assert.throws(
      () => memory.stopUse({ ownerId: "person-1", targetType: "claim", targetId: claim.claimId, expiresAt: 123 }),
      (error) => error.code === "INVALID_INPUT"
    );
    assert.throws(
      () => memory.stopUse({ ownerId: "person-1", targetType: "claim", targetId: claim.claimId, expiresAt: "not-a-date" }),
      (error) => error.code === "INVALID_INPUT"
    );
  });
});

test("proposal acceptance is idempotent across store instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-assistant-memory-proposal-"));
  const path = join(root, "memory.sqlite");
  const first = AssistantMemoryStore.open({ path });
  const second = AssistantMemoryStore.open({ path });
  try {
    await source(first, "src-concurrent-proposal");
    const proposal = first.propose({ proposalId: "proposal-concurrent", ownerId: "person-1", subject: "user", predicate: "style", value: "direct", sourceIds: ["src-concurrent-proposal"] });
    const firstClaim = first.acceptProposal({ proposalId: proposal.proposalId, authorType: "reviewer-a" });
    const secondClaim = second.acceptProposal({ proposalId: proposal.proposalId, authorType: "reviewer-b" });
    assert.equal(secondClaim.claimId, firstClaim.claimId);
    assert.equal(secondClaim.current.authorType, "reviewer-a");
    assert.equal(first.recall({ ownerId: "person-1" }).length, 1);
    assert.equal(second.getProposal(proposal.proposalId).acceptedClaimId, firstClaim.claimId);
  } finally {
    first.close();
    second.close();
    await rm(root, { recursive: true, force: true });
  }
});
