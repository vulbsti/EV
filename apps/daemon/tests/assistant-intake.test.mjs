import test from "node:test";
import assert from "node:assert/strict";
import { planAssistantTurn } from "../lib/assistant-intake.mjs";

const fleet = {
  sessions: [{ sessionId: "$1" }],
  panes: [{ paneId: "%2", command: "omp", attention: { required: true, label: "Review requested" } }]
};

test("answers read-only attention questions from the enriched fleet", () => {
  const turn = planAssistantTurn({
    clientMessageId: "message-1",
    transcript: "Summarize which EV terminal currently needs attention. Do not send any commands or change any terminal.",
    fleet
  });
  assert.equal(turn.route, "assistant");
  assert.match(turn.response, /%2 \(omp\).*Review requested/);
  assert.equal(turn.task, null);
});

test("records requested work as not executable without inventing a queue or worker", () => {
  const turn = planAssistantTurn({ clientMessageId: "message-2", transcript: "Create a launch brief", fleet });
  assert.equal(turn.route, "not_executable");
  assert.equal(turn.task.status, "not_executable");
  assert.match(turn.response, /cannot execute background work yet/i);
  assert.doesNotMatch(turn.response, /working|queued|handed.*orchestrator/i);
});

test("treats the Phase 1 tracking fixture as honest not-executable work", () => {
  const turn = planAssistantTurn({ clientMessageId: "message-3", transcript: "Track this launch question for later", fleet });
  assert.equal(turn.classification, "action");
  assert.equal(turn.route, "not_executable");
  assert.equal(turn.task.status, "not_executable");
});
