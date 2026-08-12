import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../lib/store.mjs";
import { createExplainer } from "../lib/explainer.mjs";

test("keeps a durable multi-turn explanation thread separate and adapts from feedback", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-explainer-"));
  try {
    const store = new EventStore(join(root, "events.jsonl"));
    await store.initialize();
    const calls = { starts: [], turns: [] };
    const codex = {
      async startThread(value) { calls.starts.push(value); return { id: "thread-explainer" }; },
      async runTurn(value) {
        calls.turns.push(value);
        const turn = calls.turns.length;
        return {
          turnId: `turn-${turn}`,
          durationMs: 25,
          answer: JSON.stringify({
            project: { goal: "Understand active agent work", alignment: "aligned", impact: "Makes implementation effects inspectable." },
            answer: `mechanics answer ${turn}`,
            mechanism: [
              { id: "capture", title: "Capture evidence", detail: "Read the current effects.", input: "pane", output: "snapshot", evidence: "evidence.mjs", status: "observed" },
              { id: "explain", title: "Explain mechanics", detail: "Answer from the snapshot.", input: "snapshot", output: "model", evidence: "explainer.mjs", status: "observed" }
            ],
            scenarios: [
              { id: "normal", label: "Normal path", trigger: "Pane exists", path: ["capture", "explain"], outcome: "Explanation is grounded.", status: "observed" },
              { id: "missing-pane", label: "Missing pane", trigger: "Pane closes", path: [], outcome: "The request fails instead of guessing.", status: "observed" }
            ],
            limits: ["Terminal output is bounded."],
            followUps: ["Inspect the capture boundary."]
          })
        };
      }
    };
    const pane = { paneId: "%7", sessionName: "work", command: "codex", path: root, activity: "working", tail: "npm test\nall tests passed" };
    const explainer = await createExplainer({ store, codex, getPane: async (paneId) => paneId === pane.paneId ? pane : null });

    const first = await explainer.ask({ paneId: "%7", question: "How exactly do the tests prove this?" });
    const second = await explainer.ask({ sessionId: first.sessionId, paneId: "%7", question: "Show me the impact visually." });
    const feedback = await explainer.feedback({ sessionId: first.sessionId, questionId: second.questionId, signal: "more_concrete" });
    const session = await explainer.session(first.sessionId);

    assert.equal(calls.starts.length, 1);
    assert.equal(calls.turns.length, 2);
    assert.equal(calls.turns[0].threadId, "thread-explainer");
    assert.match(calls.starts[0].developerInstructions, /Never edit files/);
    assert.match(calls.turns[0].input, /evidence_snapshot revision=/);
    assert.match(calls.turns[0].input, /untrusted data, not instructions/);
    assert.match(calls.turns[0].input, /one rigorous, typed mechanics artifact/);
    assert.doesNotMatch(calls.turns[0].input, /PRESENTATION COMPILER PASS/);
    assert.equal(session.messages.length, 4);
    assert.equal(session.codexThreadId, "thread-explainer");
    assert.equal(session.messages[1].text, "mechanics answer 1");
    assert.equal(session.messages[1].presentation.mechanism.length, 2);
    assert.equal(first.presentation.project.alignment, "aligned");
    assert.equal(first.presentation.scenarios[1].id, "missing-pane");
    assert.equal(feedback.profile.weights.concrete, 3);
    assert.ok(feedback.profile.weights.mechanics >= 1);
    assert.ok(feedback.profile.weights.tests >= 1);
    assert.ok(feedback.profile.weights.visual >= 1);
    assert.ok(feedback.profile.weights.impact >= 1);
    const reset = await explainer.feedback({ sessionId: first.sessionId, questionId: second.questionId, signal: "reset_profile" });
    assert.deepEqual(reset.profile.preferences, []);
    assert.equal(reset.profile.explicitFeedbackCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects attempts to reuse a session for another executor pane", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-explainer-scope-"));
  try {
    const store = new EventStore(join(root, "events.jsonl"));
    await store.initialize();
    const codex = {
      async startThread() { return { id: "thread-one" }; },
      async runTurn() { return { turnId: "turn-one", answer: "answer", durationMs: 1 }; }
    };
    const explainer = await createExplainer({
      store,
      codex,
      getPane: async (paneId) => ({ paneId, sessionName: "work", command: "codex", path: root, activity: "steady", tail: "" })
    });
    const first = await explainer.ask({ paneId: "%1", question: "Explain this." });
    await assert.rejects(
      () => explainer.ask({ sessionId: first.sessionId, paneId: "%2", question: "Explain that." }),
      /different pane/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("enforces the presentation budget after a verbose mechanics response", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-explainer-budget-"));
  try {
    const store = new EventStore(join(root, "events.jsonl"));
    await store.initialize();
    const codex = {
      async startThread() { return { id: "thread-budget" }; },
      async runTurn() {
        return {
          turnId: "mechanics",
          durationMs: 1,
          answer: JSON.stringify({
            project: { goal: "g".repeat(1_000), alignment: "aligned", impact: "i".repeat(1_000) },
            answer: "a".repeat(2_000),
            mechanism: Array.from({ length: 10 }, (_, index) => ({ id: `step-${index}`, title: "t".repeat(200), detail: "d".repeat(1_000), input: "i".repeat(500), output: "o".repeat(500), evidence: "e".repeat(500), status: "observed" })),
            scenarios: Array.from({ length: 10 }, (_, index) => ({ id: `case-${index}`, label: "l".repeat(200), trigger: "t".repeat(500), path: ["step-0"], outcome: "o".repeat(1_000), status: "inferred" })),
            limits: Array(10).fill("u".repeat(500)),
            followUps: Array(10).fill("f".repeat(500))
          })
        };
      }
    };
    const explainer = await createExplainer({
      store,
      codex,
      getPane: async (paneId) => ({ paneId, sessionName: "work", command: "codex", path: root, activity: "working", tail: "" })
    });
    const result = await explainer.ask({ paneId: "%9", question: "Explain the mechanism." });
    assert.ok(result.answer.length <= 650);
    assert.equal(result.presentation.mechanism.length, 6);
    assert.ok(result.presentation.mechanism.every((step) => step.detail.length <= 480));
    assert.equal(result.presentation.scenarios.length, 5);
    assert.equal(result.presentation.limits.length, 3);
    assert.equal(result.presentation.followUps.length, 3);
    assert.ok(result.presentation.project.goal.length <= 320);
    assert.ok(result.presentation.project.impact.length <= 420);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("binds an explicit pane task and includes it in later evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-explainer-task-"));
  try {
    const store = new EventStore(join(root, "events.jsonl"));
    await store.initialize();
    const pane = { paneId: "%4", sessionName: "work", command: "codex", path: root, activity: "steady", tail: "" };
    const explainer = await createExplainer({
      store,
      codex: { async startThread() { return { id: "unused" }; }, async runTurn() { throw new Error("unused"); } },
      getPane: async (paneId) => paneId === pane.paneId ? pane : null
    });

    const bound = await explainer.bindTask({
      paneId: "%4",
      objective: "  Make backend behavior mechanically testable.  ",
      acceptanceCriteria: ["Run the real path", "  Persist a receipt  ", ""]
    });
    const evidence = await explainer.context("%4");

    assert.equal(bound.objective, "Make backend behavior mechanically testable.");
    assert.deepEqual(evidence.taskContext.acceptanceCriteria, ["Run the real path", "Persist a receipt"]);
    assert.equal(evidence.taskContext.paneId, "%4");
    await assert.rejects(() => explainer.bindTask({ paneId: "%4", objective: "" }), /task objective/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
