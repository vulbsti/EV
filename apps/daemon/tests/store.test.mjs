import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../lib/store.mjs";

test("a message is saved once, linked to its work, and survives reopening the store", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-store-"));
  const path = join(root, "ev.sqlite");
  try {
    const store = openStore({ path });
    const turn = store.recordTurn({ conversationId: "c1", clientMessageId: "m1", userText: "write a poem", assistantText: "On it.", workId: "w1" });
    assert.equal(store.recordTurn({ conversationId: "c1", clientMessageId: "m1", userText: "write a poem", assistantText: "Again?" }).replayed, true);
    store.recordUpdate({ conversationId: "c1", key: "done:w1", content: "The poem is done.", workId: "w1" });
    store.recordUpdate({ conversationId: "c1", key: "done:w1", content: "The poem is done.", workId: "w1" });
    store.close();

    const reopened = openStore({ path });
    const messages = reopened.listMessages("c1");
    assert.deepEqual(messages.map((message) => [message.role, message.content, message.taskId]), [
      ["user", "write a poem", "w1"], ["assistant", "On it.", "w1"], ["assistant", "The poem is done.", "w1"]
    ]);
    assert.equal(reopened.findTurn("m1").assistantMessage.replyTo, turn.userMessage.messageId);
    reopened.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
