import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../lib/store.mjs";

test("a message is saved on arrival, survives reopening, and is handled once with what it started", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-store-"));
  const path = join(root, "ev.sqlite");
  try {
    const store = openStore({ path });
    const { message } = store.receive({ conversationId: "c1", clientMessageId: "m1", text: "write a poem" });
    assert.equal(store.receive({ conversationId: "c1", clientMessageId: "m1", text: "write a poem" }).replayed, true);
    store.close();

    // As after a crash: the message is still waiting, and a turn that fails takes nothing with it.
    const reopened = openStore({ path });
    const item = reopened.nextItem("c1");
    assert.equal(item.message.messageId, message.messageId);
    assert.deepEqual(reopened.waitingConversations(), ["c1"]);
    assert.throws(() => reopened.tx(() => { reopened.handled(item.itemId, { reply: "On it.", workId: "w1" }); throw new Error("crash before the work was created"); }));
    assert.equal(reopened.nextItem("c1").itemId, item.itemId);
    reopened.handled(item.itemId, { reply: "On it.", workId: "w1" });
    assert.throws(() => reopened.handled(item.itemId, { reply: "Again?" }), { code: "ITEM_HANDLED" });
    assert.equal(reopened.nextItem("c1"), null);
    reopened.recordUpdate({ conversationId: "c1", key: "done:w1", content: "The poem is done.", workId: "w1" });
    reopened.recordUpdate({ conversationId: "c1", key: "done:w1", content: "The poem is done.", workId: "w1" });
    const messages = reopened.listMessages("c1");
    assert.deepEqual(messages.map((entry) => [entry.role, entry.content, entry.taskId]), [
      ["user", "write a poem", "w1"], ["assistant", "On it.", "w1"], ["assistant", "The poem is done.", "w1"]
    ]);
    assert.equal(messages[1].replyTo, message.messageId);
    reopened.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("one search finds what was said in any conversation, and erasing a message takes it out of the index", () => {
  const store = openStore();
  const { message } = store.receive({ conversationId: "travel", clientMessageId: "t1", text: "for Kyoto I've settled on the hotel Sakura-no-Yado" });
  store.receive({ conversationId: "main", clientMessageId: "t2", text: "which hotels did I look at?" });
  const hits = store.search("hotel Kyoto");
  assert.equal(hits[0].ref, `message:${message.messageId}`);
  assert.equal(hits[0].conversationId, "travel");
  assert.match(hits[0].excerpt, /Sakura-no-Yado/);
  store.eraseMessage(message.messageId);
  assert.deepEqual(store.search("Kyoto Sakura"), []);
  store.close();
});
