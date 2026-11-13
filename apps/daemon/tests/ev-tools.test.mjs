import test from "node:test";
import assert from "node:assert/strict";
import { AssistantMemoryStore, memoryText } from "../lib/assistant-memory.mjs";
import { createTurn } from "../lib/ev-tools.mjs";
import { openStore } from "../lib/store.mjs";

// One of EV's turns over the next message in the inbox, with nothing but the store behind it.
function turnOn(store, memory, text, id) {
  store.receive({ conversationId: "c1", clientMessageId: id, text });
  return createTurn({ store, memory, supervisor: {}, workers: {}, ownerId: "person-1", item: store.nextItem("c1"), newWork: null });
}

test("forget, through EV's tool, erases what EV names from the store, memory and search, and says what it erased", async () => {
  const store = openStore();
  const memory = AssistantMemoryStore.open({ store });
  const first = turnOn(store, memory, "my gym locker code is 4471", "m1");
  await first.run("remember", { text: "Gym locker code is 4471.", quote: "my gym locker code is 4471" });
  first.commit({ reply: "Noted." });
  assert.ok(store.search("4471").length >= 2, "the code is not where the test expects it");

  const second = turnOn(store, memory, "forget my locker code, I shouldn't have told you", "m2");
  const { hits } = JSON.parse(await second.run("search", { query: "4471" }));
  const outcome = JSON.parse(await second.run("forget", { ids: [...hits.map((hit) => hit.id), "work:nothing-here"] }));
  assert.equal(outcome.erased.length, hits.length);
  assert.match(outcome.erased.find((line) => line.startsWith("memory:")), /Gym locker code is 4471/);
  assert.deepEqual(outcome.not_erased.map((entry) => entry.id), ["work:nothing-here"]);
  // Nothing is erased until the turn commits.
  assert.ok(store.search("4471").length >= 2);
  second.commit({ reply: "Done, it's gone." });

  assert.deepEqual(store.search("4471"), []);
  assert.deepEqual(store.search("locker"), [], "the request that repeated it is erased too");
  assert.ok(!store.listMessages("c1").some((message) => message.content.includes("4471")));
  assert.equal(store.listMessages("c1").at(-1).content, "Done, it's gone.");
  assert.ok(!memory.recall({ ownerId: "person-1", includeCandidates: true }).some((claim) => memoryText(claim.current.value).includes("4471")));
  assert.ok(!store.db.prepare("SELECT value_json FROM memory_revisions").all().some((row) => row.value_json.includes("4471")));
  store.close();
});
