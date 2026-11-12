// Checks the harness itself. EV has no tool-calling loop yet, so the part of
// the stand-in that speaks in tool calls is driven here by a minimal loop of
// the kind EV1 will have, once per API dialect. It also documents, in running
// code, what the stand-in expects from that loop.
import assert from "node:assert/strict";
import { TOOLS } from "./protocol.mjs";
import { startStandIn } from "./stand-in.mjs";

const toolNames = [TOOLS.search.name, TOOLS.read.name, TOOLS.startWork.name, TOOLS.reply.name];

/** What EV would do for each tool; here, canned results. */
const run = { search: () => JSON.stringify({ hits: [{ id: "turn:41", text: "a hit" }] }), read: ({ id }) => `full text of ${id}`, start_work: ({ title }) => `started ${title}`, reply: () => "sent" };

const wire = {
  messages: {
    path: "/v1/messages",
    first: (text) => ({ system: "You are EV.", tools: toolNames.map((name) => ({ name, input_schema: { type: "object" } })), messages: [{ role: "user", content: text }] }),
    calls: (reply) => reply.content.filter((part) => part.type === "tool_use").map((part) => ({ id: part.id, name: part.name, args: part.input })),
    text: (reply) => reply.content.filter((part) => part.type === "text").map((part) => part.text).join(""),
    extend: (body, reply, results) => { body.messages.push({ role: "assistant", content: reply.content }, { role: "user", content: results.map(({ id, output }) => ({ type: "tool_result", tool_use_id: id, content: output })) }); }
  },
  chat: {
    path: "/v1/chat/completions",
    first: (text) => ({ tools: toolNames.map((name) => ({ type: "function", function: { name, parameters: { type: "object" } } })), messages: [{ role: "system", content: "You are EV." }, { role: "user", content: text }] }),
    calls: (reply) => (reply.choices[0].message.tool_calls ?? []).map((call) => ({ id: call.id, name: call.function.name, args: JSON.parse(call.function.arguments) })),
    text: (reply) => reply.choices[0].message.content ?? "",
    extend: (body, reply, results) => { body.messages.push(reply.choices[0].message, ...results.map(({ id, output }) => ({ role: "tool", tool_call_id: id, content: output }))); }
  },
  responses: {
    path: "/v1/responses",
    first: (text) => ({ instructions: "You are EV.", tools: toolNames.map((name) => ({ type: "function", name, parameters: { type: "object" } })), input: [{ role: "user", content: text }] }),
    calls: (reply) => reply.output.filter((item) => item.type === "function_call").map((item) => ({ id: item.call_id, name: item.name, args: JSON.parse(item.arguments) })),
    text: (reply) => reply.output.filter((item) => item.type === "message").flatMap((item) => item.content).map((part) => part.text).join(""),
    extend: (body, reply, results) => { body.input.push(...reply.output, ...results.map(({ id, output }) => ({ type: "function_call_output", call_id: id, output }))); }
  }
};

export async function selfTest() {
  const standIn = await startStandIn({
    ev: async (turn) => {
      const found = await turn.search("cabin wifi");
      const opened = await turn.read(found.hits[0].id);
      const started = await turn.startWork({ title: "Trip", request: "Plan it." });
      return turn.reply(`${opened.text}; ${started.text}`);
    }
  });
  try {
    for (const [dialect, api] of Object.entries(wire)) {
      const body = api.first("what was the cabin wifi password?");
      const used = [];
      let said = null;
      for (let step = 0; step < 8 && said === null; step++) {
        const response = await fetch(`${standIn.url}${api.path}`, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "ev-main-agent/0.2" }, body: JSON.stringify(body) });
        const reply = await response.json();
        const calls = api.calls(reply);
        if (!calls.length) { said = api.text(reply); break; }
        used.push(...calls.map((call) => call.name));
        const replyCall = calls.find((call) => call.name === TOOLS.reply.name);
        if (replyCall) { said = replyCall.args.text; break; }
        api.extend(body, reply, calls.map((call) => ({ id: call.id, output: run[call.name](call.args) })));
      }
      assert.deepEqual(used, ["search", "read", "start_work", "reply"], `${dialect}: the scripted turn did not come through as the expected tool calls`);
      assert.equal(said, "full text of turn:41; started Trip", `${dialect}: tool results did not get back to the script`);
    }
    assert.equal(standIn.calls("ev").length, 3, "A request carrying a tool result was counted as a new turn");
    assert.match(standIn.calls("ev")[0].text, /cabin wifi password/, "The stand-in did not read what the model was shown");
    assert.deepEqual(standIn.errors, [], "The stand-in recorded script errors");
  } finally { await standIn.stop(); }
}

if (import.meta.url === `file://${process.argv[1]}`) { await selfTest(); console.log("The stand-in speaks all three tool-calling dialects."); }
