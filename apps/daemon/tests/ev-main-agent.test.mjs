import test from "node:test";
import assert from "node:assert/strict";
import { understandMessage } from "../lib/ev-main-agent.mjs";

const answering = (value) => async () => ({ ok: true, json: async () => ({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(value) }] }] }) });

test("EV asks at most one round of questions, then works with what it assumed", async () => {
  const decision = { action: "clarify", message: "Quick check:", questions: ["Live-action edit or fully animated?"], request: "Edit the video in a K-pop anime style" };
  const first = await understandMessage({ message: "make it more kpop anime", apiKey: "test", fetchImpl: answering(decision) });
  assert.equal(first.action, "clarify");
  assert.deepEqual(first.questions, ["Live-action edit or fully animated?"]);
  const second = await understandMessage({ message: "whatever looks good", alreadyAsked: true, apiKey: "test", fetchImpl: answering(decision) });
  assert.equal(second.action, "work");
  assert.deepEqual(second.questions, []);
  assert.match(second.assumptions.join(" "), /Live-action edit or fully animated/);
});
