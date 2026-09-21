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

test("routes only the reviewed launch-status fixture request to the Phase 2 worker", () => {
  const turn = planAssistantTurn({
    clientMessageId: "message-worker-1",
    transcript: "Create a one-page launch-status brief from the selected local fixture.",
    fleet
  });
  assert.equal(turn.route, "worker");
  assert.equal(turn.capability, "extended-launch-brief-v1");
  assert.equal(turn.task.status, "queued");
  assert.match(turn.response, /background while we keep talking/i);
});

test("does not broaden the reviewed worker route to similar arbitrary work", () => {
  const turn = planAssistantTurn({ clientMessageId: "message-worker-2", transcript: "Create a one-page strategy brief from my home directory", fleet });
  assert.equal(turn.route, "not_executable");
});

test("treats the Phase 1 tracking fixture as honest not-executable work", () => {
  const turn = planAssistantTurn({ clientMessageId: "message-3", transcript: "Track this launch question for later", fleet });
  assert.equal(turn.classification, "action");
  assert.equal(turn.route, "not_executable");
  assert.equal(turn.task.status, "not_executable");
});
