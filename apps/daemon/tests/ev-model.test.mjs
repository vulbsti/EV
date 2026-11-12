import test from "node:test";
import assert from "node:assert/strict";
import { callModel, parseModelJson } from "../lib/ev-model.mjs";
import { modelReply } from "./model-reply.mjs";

const ask = (fetchImpl) => callModel({ input: "hi", session: "test", code: "MAIN_AGENT_UNAVAILABLE", label: "main-agent", apiKey: "test", fetchImpl, retryDelaysMs: [0, 0], parse: (raw) => parseModelJson(raw, "unreadable") });

test("model calls retry provider blips and unreadable replies, but not client errors", async () => {
  const replies = [new Response("busy", { status: 503 }), modelReply("not json")];
  let calls = 0;
  const value = await ask(async () => (calls++ < replies.length ? replies[calls - 1] : modelReply(JSON.stringify({ answer: "Hi" }))));
  assert.equal(calls, 3);
  assert.equal(value.answer, "Hi");
  calls = 0;
  await assert.rejects(ask(async () => { calls++; return new Response("bad", { status: 400 }); }), (error) => error.code === "MAIN_AGENT_UNAVAILABLE");
  assert.equal(calls, 1);
});
