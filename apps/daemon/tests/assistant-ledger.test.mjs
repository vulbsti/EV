import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantLedger } from "../lib/assistant-ledger.mjs";

async function withLedger(run) {
  const root = await mkdtemp(join(tmpdir(), "ev-assistant-ledger-"));
  const ledger = createAssistantLedger({ path: join(root, "assistant.sqlite") });
  try { return await run(ledger); } finally { ledger.close(); await rm(root, { recursive: true, force: true }); }
}

test("records an immutable user and assistant turn and reconstructs it in order", async () => {
  await withLedger(async (ledger) => {
    const turn = ledger.recordTurn({
      conversationId: "c1",
      clientMessageId: "client-1",
      userText: "What is happening?",
      assistantText: "I have recorded your question."
    });
    assert.equal(turn.replayed, false);
    assert.equal(turn.userMessage.role, "user");
    assert.equal(turn.assistantMessage.role, "assistant");
    assert.deepEqual(ledger.listConversation("c1").map(({ role, content }) => ({ role, content })), [
      { role: "user", content: "What is happening?" },
      { role: "assistant", content: "I have recorded your question." }
    ]);
  });
});

test("reconstructs turns with monotonic message sequences", async () => {
  await withLedger(async (ledger) => {
    ledger.recordTurn({ conversationId: "c1", clientMessageId: "ordered-1", userText: "first", assistantText: "first reply" });
    ledger.recordTurn({ conversationId: "c1", clientMessageId: "ordered-2", userText: "second", assistantText: "second reply" });
    ledger.recordTurn({ conversationId: "c1", clientMessageId: "ordered-3", userText: "third", assistantText: "third reply" });

    assert.deepEqual(ledger.listConversation("c1").map(({ sequence, role, clientMessageId }) => ({ sequence, role, clientMessageId })), [
      { sequence: 1, role: "user", clientMessageId: "ordered-1" },
      { sequence: 2, role: "assistant", clientMessageId: null },
      { sequence: 3, role: "user", clientMessageId: "ordered-2" },
      { sequence: 4, role: "assistant", clientMessageId: null },
      { sequence: 5, role: "user", clientMessageId: "ordered-3" },
      { sequence: 6, role: "assistant", clientMessageId: null }
    ]);
    assert.deepEqual(ledger.listTurns("c1").map(({ userMessage, assistantMessage }) => [
      userMessage.sequence,
      assistantMessage.sequence
    ]), [[1, 2], [3, 4], [5, 6]]);
  });
});

test("repeated client message id returns the original turn without appending a duplicate", async () => {
  await withLedger(async (ledger) => {
    const first = ledger.recordTurn({ conversationId: "c1", clientMessageId: "same", userText: "one", assistantText: "reply" });
    const second = ledger.recordTurn({ conversationId: "c1", clientMessageId: "same", userText: "changed", assistantText: "changed reply" });
    assert.equal(second.replayed, true);
    assert.equal(second.userMessage.messageId, first.userMessage.messageId);
    assert.equal(second.userMessage.content, "one");
    assert.equal(ledger.listConversation("c1").length, 2);
  });
});

test("repeated client message id replays the original turn after reopening the ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-assistant-ledger-reopen-"));
  const path = join(root, "assistant.sqlite");
  try {
    const firstLedger = createAssistantLedger({ path });
    const first = firstLedger.recordTurn({ conversationId: "c1", clientMessageId: "reopen-same", userText: "original", assistantText: "original reply" });
    firstLedger.close();

    const reopenedLedger = createAssistantLedger({ path });
    try {
      const replay = reopenedLedger.recordTurn({ conversationId: "c1", clientMessageId: "reopen-same", userText: "changed", assistantText: "changed reply" });
      assert.equal(replay.replayed, true);
      assert.equal(replay.userMessage.messageId, first.userMessage.messageId);
      assert.equal(replay.userMessage.content, "original");
      assert.deepEqual(reopenedLedger.listConversation("c1").map(({ role, content }) => ({ role, content })), [
        { role: "user", content: "original" },
        { role: "assistant", content: "original reply" }
      ]);
    } finally {
      reopenedLedger.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("separate ledger instances preserve ordered state across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-assistant-ledger-restart-"));
  const path = join(root, "assistant.sqlite");
  try {
    const firstLedger = createAssistantLedger({ path });
    firstLedger.recordTurn({ conversationId: "c1", clientMessageId: "restart-1", userText: "before restart", assistantText: "saved before restart" });
    firstLedger.close();

    const secondLedger = createAssistantLedger({ path });
    secondLedger.recordTurn({ conversationId: "c1", clientMessageId: "restart-2", userText: "after restart", assistantText: "saved after restart" });
    secondLedger.close();

    const finalLedger = createAssistantLedger({ path });
    try {
      assert.deepEqual(finalLedger.listConversation("c1").map(({ sequence, role, content }) => ({ sequence, role, content })), [
        { sequence: 1, role: "user", content: "before restart" },
        { sequence: 2, role: "assistant", content: "saved before restart" },
        { sequence: 3, role: "user", content: "after restart" },
        { sequence: 4, role: "assistant", content: "saved after restart" }
      ]);
      assert.equal(finalLedger.findByClientMessageId("restart-1").userMessage.content, "before restart");
      assert.equal(finalLedger.findByClientMessageId("restart-2").userMessage.content, "after restart");
    } finally {
      finalLedger.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("routed actions remain explicit not_executable tasks", async () => {
  await withLedger(async (ledger) => {
    const turn = ledger.recordTurn({
      conversationId: "c1",
      clientMessageId: "action-1",
      userText: "Start the research job",
      assistantText: "I recorded this request, but no worker can execute it yet.",
      intent: { kind: "action", route: "orchestrator", target: "research" }
    });
    assert.equal(turn.intent.status, "not_executable");
    assert.equal(turn.task.status, "not_executable");
    assert.equal(ledger.listTasks("c1")[0].status, "not_executable");
  });
});

test("the Phase 1 not_executable route creates a durable task and ordered turn", async () => {
  await withLedger(async (ledger) => {
    const turn = ledger.recordTurn({
      conversationId: "c1",
      clientMessageId: "phase1-action",
      userText: "Create a launch brief",
      assistantText: "I cannot execute background work yet.",
      intent: { kind: "delegated_reasoning", route: "not_executable" },
      route: "not_executable"
    });
    assert.equal(turn.task.status, "not_executable");
    assert.equal(ledger.listTurns("c1")[0].task.taskId, turn.task.taskId);
    assert.equal(ledger.findByClientMessageId("phase1-action").userMessage.content, "Create a launch brief");
  });
});

test("turn write is transactional when required input is invalid", async () => {
  await withLedger(async (ledger) => {
    assert.throws(() => ledger.recordTurn({ conversationId: "c1", clientMessageId: "bad", userText: "missing assistant" }), /assistantText/);
    assert.deepEqual(ledger.listConversation("c1"), []);
  });
});
