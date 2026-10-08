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

test("EV's own updates join the conversation in order and are posted once", async () => {
  await withLedger(async (ledger) => {
    ledger.recordTurn({ conversationId: "c1", clientMessageId: "client-1", userText: "Research flights", assistantText: "On it." });
    ledger.recordUpdate({ conversationId: "c1", key: "settled:task-1:4", content: "Flights are done." });
    assert.equal(ledger.recordUpdate({ conversationId: "c1", key: "settled:task-1:4", content: "Flights are done." }).replayed, true);
    ledger.recordTurn({ conversationId: "c1", clientMessageId: "client-2", userText: "Thanks", assistantText: "Anytime." });
    assert.deepEqual(ledger.listConversation("c1").map(({ content }) => content), ["Research flights", "On it.", "Flights are done.", "Thanks", "Anytime."]);
    assert.equal(ledger.getTurn(ledger.findByClientMessageId("client-2").userMessage.messageId).assistantMessage.content, "Anytime.");
    assert.deepEqual(ledger.listUpdates("c1").map(({ content }) => content), ["Flights are done."]);
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

test("turn write is transactional when required input is invalid", async () => {
  await withLedger(async (ledger) => {
    assert.throws(() => ledger.recordTurn({ conversationId: "c1", clientMessageId: "bad", userText: "missing assistant" }), /assistantText/);
    assert.deepEqual(ledger.listConversation("c1"), []);
  });
});
