import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATTENTION_PROMPT, COUNT_PROMPT, createPhase0RunBundle } from "../lib/phase0-run.mjs";

function event(eventId, type, correlationId, occurredAt, payload) {
  return { schemaVersion: 1, eventId, type, correlationId, occurredAt, payload };
}

test("creates a valid Phase 0 bundle from the complete browser-canary event sequence", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-phase0-run-"));
  const eventsPath = join(root, "events.jsonl");
  const events = [
    event("e1", "voice.utterance", "baseline", "2026-09-21T05:29:21.619Z", { transcript: ATTENTION_PROMPT, classification: "action", route: "orchestrator" }),
    event("e2", "task.delegated", "baseline", "2026-09-21T05:29:21.620Z", { taskId: "task-old" }),
    event("e3", "companion.reply", "baseline", "2026-09-21T05:29:21.621Z", { response: "Queued but not executable." }),
    event("e4", "voice.utterance", "count", "2026-09-21T05:29:55.030Z", { transcript: COUNT_PROMPT, classification: "read_query", route: "companion" }),
    event("e5", "companion.reply", "count", "2026-09-21T05:29:55.031Z", { response: "I can see 25 panes across 3 tmux sessions." }),
    event("e6", "voice.utterance", "intermediate", "2026-09-21T05:44:02.862Z", { transcript: ATTENTION_PROMPT, classification: "read_query", route: "companion" }),
    event("e7", "companion.reply", "intermediate", "2026-09-21T05:44:02.863Z", { response: "No terminal panes currently need your attention." }),
    event("e8", "voice.utterance", "corrected", "2026-09-21T05:44:30.257Z", { transcript: ATTENTION_PROMPT, classification: "read_query", route: "companion" }),
    event("e9", "companion.reply", "corrected", "2026-09-21T05:44:30.258Z", { response: "1 terminal pane currently needs your attention: %2 (omp) — Review requested." })
  ];
  await writeFile(eventsPath, `${events.map((item) => JSON.stringify(item)).join("\n")}\n`);

  try {
    const result = await createPhase0RunBundle({
      eventsPath,
      outputRoot: root,
      date: "2026-09-21",
      runId: "phase0-test",
      repositoryRevision: "abc1234"
    });
    assert.equal(result.validation.valid, true);
    assert.equal(result.browserReceipt.delegatedTaskForCorrectedRun, false);
    assert.equal(result.browserReceipt.reloadReplyPersisted, false);
    const receipt = JSON.parse(await readFile(join(result.bundlePath, "receipts", "browser-verification.json"), "utf8"));
    assert.equal(receipt.correctedAttentionCorrelationId, "corrected");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to manufacture a bundle without a corrected attention result", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-phase0-incomplete-"));
  const eventsPath = join(root, "events.jsonl");
  const events = [
    event("e1", "voice.utterance", "count", "2026-09-21T05:29:55.030Z", { transcript: COUNT_PROMPT, classification: "read_query", route: "companion" }),
    event("e2", "companion.reply", "count", "2026-09-21T05:29:55.031Z", { response: "I can see 1 pane across 1 tmux session." })
  ];
  await writeFile(eventsPath, `${events.map((item) => JSON.stringify(item)).join("\n")}\n`);

  try {
    await assert.rejects(
      createPhase0RunBundle({ eventsPath, outputRoot: root, date: "2026-09-21", repositoryRevision: "abc1234" }),
      /baseline attention-query misroute/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
