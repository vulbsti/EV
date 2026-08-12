import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { captureExplanationEvidence, publicEvidence, redactEvidence } from "../lib/evidence.mjs";

const execFileAsync = promisify(execFile);

test("redacts credentials from evidence text", () => {
  const redacted = redactEvidence("Authorization: Bearer abc.def\napi_key=topsecret\nhttps://me:password@example.com");
  assert.doesNotMatch(redacted, /abc\.def|topsecret|:password@/);
  assert.match(redacted, /\[REDACTED\]/);
});

test("captures Git effects while withholding sensitive paths and raw patches from the public view", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-evidence-"));
  try {
    await execFileAsync("git", ["-C", root, "init", "-q"]);
    await execFileAsync("git", ["-C", root, "config", "user.email", "ev@example.test"]);
    await execFileAsync("git", ["-C", root, "config", "user.name", "EV Test"]);
    await writeFile(join(root, "README.md"), "# Evidence Test Project\n\nThis project makes active agent work understandable from observable effects.\n");
    await writeFile(join(root, "feature.js"), "export const api_key = 'initial';\n");
    await execFileAsync("git", ["-C", root, "add", "README.md", "feature.js"]);
    await execFileAsync("git", ["-C", root, "commit", "-qm", "initial"]);
    await writeFile(join(root, "feature.js"), "export const api_key = 'topsecret';\nexport const ready = true;\n");
    await writeFile(join(root, "new-feature.js"), "export const newBehavior = 'visible';\n");
    await writeFile(join(root, ".env.local"), "PASSWORD=do-not-leak\n");
    const experimentReceipt = {
      runId: "experiment-proof",
      paneId: "%1",
      capabilityId: "parser",
      capabilityTitle: "Parser",
      adapter: "presentation-pipeline",
      adapterVersion: 1,
      authority: "in-memory-read-only",
      scenario: { id: "stress", label: "Stress" },
      inputs: { iterations: 100 },
      completedAt: "2026-08-12T00:00:00.000Z",
      status: "passed",
      summary: "Real path completed.",
      trace: [{ stage: "parse", status: "observed", detail: "Parsed." }],
      output: { omitted: "large internal output" },
      assertions: [{ id: "bounded", passed: true, actual: 6, expected: "<= 6" }],
      comparison: { baseline: { steps: 10 }, candidate: { steps: 6 } },
      metrics: { iterations: 100, throughputPerSecond: 1000 },
      cost: { externalApiUsd: 0 },
      regressionProposal: null,
      gates: { execution: true }
    };

    const evidence = await captureExplanationEvidence({
      pane: { paneId: "%1", sessionName: "test", command: "codex", path: root, activity: "working", tail: "npm test\n10 tests passed" },
      store: {
        async recent() { return []; },
        async recentExperimentRuns() { return [experimentReceipt]; }
      }
    });
    assert.equal(evidence.workspace.repository, true);
    assert.equal(evidence.workspace.changes.some((change) => change.path === "feature.js"), true);
    assert.equal(evidence.workspace.changes.some((change) => change.path === "[sensitive path redacted]"), true);
    assert.doesNotMatch(evidence.workspace.patch, /topsecret|do-not-leak/);
    assert.match(evidence.workspace.patch, /\[REDACTED\]/);
    assert.match(evidence.workspace.patch, /new-feature\.js[\s\S]*newBehavior/);
    assert.deepEqual(evidence.validationSignals, ["npm test", "10 tests passed"]);
    assert.equal(evidence.project.name, "Evidence Test Project");
    assert.match(evidence.project.summary, /active agent work understandable/);
    assert.match(evidence.project.sources.find((source) => source.path === "README.md").excerpt, /observable effects/);
    assert.match(evidence.limitations[0], /bounded recent console capture/);
    assert.equal(evidence.experimentReceipts[0].runId, "experiment-proof");
    assert.equal(evidence.experimentReceipts[0].metrics.iterations, 100);
    assert.equal("output" in evidence.experimentReceipts[0], false, "large adapter output must stay out of explainer evidence");

    const visible = publicEvidence(evidence);
    assert.equal("patch" in visible.workspace, false);
    assert.equal("terminalTail" in visible, false);
    assert.equal("excerpt" in visible.project.sources[0], false);
    assert.deepEqual(visible.project.sourcePaths, ["README.md"]);
    assert.match(visible.terminalPreview, /10 tests passed/);

    await new Promise((resolve) => setTimeout(resolve, 2));
    const recaptured = await captureExplanationEvidence({
      pane: { paneId: "%1", sessionName: "test", command: "codex", path: root, activity: "working", tail: "npm test\n10 tests passed" },
      store: { async recent() { return []; }, async recentExperimentRuns() { return [experimentReceipt]; } }
    });
    assert.equal(recaptured.revision, evidence.revision, "capture time alone must not change the evidence revision");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
