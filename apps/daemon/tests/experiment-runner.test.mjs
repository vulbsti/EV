import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EventStore } from "../lib/store.mjs";
import { createExperimentRunner } from "../lib/experiment-runner.mjs";
import { loadCapabilityManifest } from "../lib/capability-spec.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("loads and validates executable capability specifications", async () => {
  const manifest = await loadCapabilityManifest({ cwd: projectRoot, registeredAdapters: new Set(["presentation-pipeline", "loopback-http"]) });
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.capabilities.length, 2);
  assert.deepEqual(manifest.capabilities.map((capability) => capability.support), ["executable", "executable"]);
  assert.equal(manifest.capabilities[0].pipeline[0].id, "receive");
  assert.equal(manifest.capabilities[0].scenarios.some((scenario) => scenario.id === "contract-failure"), true);
});

test("presentation adapter reaches all ten acceptance gates with real edge and load runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-capability-runner-"));
  try {
    const store = new EventStore(join(root, "events.jsonl"));
    await store.initialize();
    await store.append("task.context.bound", { paneId: "%1", objective: "Make explanations mechanically testable.", acceptanceCriteria: ["Persist executable receipts."] }, "%1");
    const runner = createExperimentRunner({
      store,
      baseUrl: "http://127.0.0.1:4317",
      getPane: async (paneId) => ({ paneId, path: projectRoot })
    });
    const suite = await runner.runAcceptanceSuite({ paneId: "%1", capabilityId: "explainer-presentation" });
    assert.equal(suite.runs.length, 3);
    assert.equal(suite.acceptance.score, "10/10");
    assert.equal(suite.acceptance.complete, true);
    assert.equal(suite.runs.every((run) => run.acceptanceVersion === 2), true);
    assert.equal(suite.runs.every((run) => Boolean(run.evidenceRevision)), true);
    assert.equal(suite.runs.every((run) => run.goal.task.objective === "Make explanations mechanically testable."), true);
    const load = suite.runs.find((run) => run.scenario.id === "stress");
    assert.equal(load.inputs.iterations, 2000);
    assert.ok(load.metrics.throughputPerSecond > 0);
    assert.equal(load.gates.envelope, true);
    const failed = suite.runs.find((run) => run.scenario.id === "contract-failure");
    assert.equal(failed.status, "failed");
    assert.equal(failed.regressionProposal.status, "proposed_not_applied");
    assert.equal(failed.gates.learningLoop, true);
    assert.equal((await runner.get(failed.runId)).runId, failed.runId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loopback adapter executes bounded HTTP probes and reaches ten acceptance gates", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-http-runner-"));
  try {
    const store = new EventStore(join(root, "events.jsonl"));
    await store.initialize();
    await store.append("task.context.bound", { paneId: "%2", objective: "Measure local API behavior.", acceptanceCriteria: ["Observe bounded load."] }, "%2");
    const fakeFetch = async (url) => {
      const status = new URL(url).pathname === "/api/not-found" ? 404 : 200;
      const bytes = new TextEncoder().encode(JSON.stringify({ ok: status === 200 }));
      return { status, async arrayBuffer() { return bytes.buffer; } };
    };
    const runner = createExperimentRunner({
      store,
      baseUrl: "http://127.0.0.1:4317",
      fetchImpl: fakeFetch,
      getPane: async (paneId) => ({ paneId, path: projectRoot })
    });
    const suite = await runner.runAcceptanceSuite({ paneId: "%2", capabilityId: "ev-loopback-api" });
    assert.equal(suite.acceptance.score, "10/10");
    assert.equal(suite.runs.find((run) => run.scenario.id === "load").metrics.iterations, 100);
    assert.equal(suite.runs.find((run) => run.scenario.id === "contract-failure").assertions[0].passed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports missing adapters instead of pretending a capability is executable", async () => {
  const manifest = await loadCapabilityManifest({ cwd: projectRoot, registeredAdapters: new Set() });
  assert.equal(manifest.capabilities.every((capability) => capability.support === "missing_adapter"), true);
});
