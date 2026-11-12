// Checks the harness itself: the part of the stand-in that speaks in tool
// calls is driven here by a minimal loop of the kind EV1 has, built on EV's
// own model layer (pi-ai underneath), once per API shape, so a failing check
// is never the harness's own fault.
import assert from "node:assert/strict";
import { modelTurn, toolResult, userMessage } from "../../apps/daemon/lib/ev-model.mjs";
import { TOOLS } from "./protocol.mjs";
import { startStandIn } from "./stand-in.mjs";

const tools = [TOOLS.search.name, TOOLS.read.name, TOOLS.startWork.name, TOOLS.reply.name].map((name) => ({ name, description: name, parameters: { type: "object", properties: {} } }));

/** What EV would do for each tool; here, canned results. */
const run = { search: () => JSON.stringify({ hits: [{ id: "turn:41", text: "a hit" }] }), read: ({ id }) => `full text of ${id}`, start_work: ({ title }) => `started ${title}`, reply: () => "sent" };

export async function selfTest() {
  const standIn = await startStandIn({
    ev: async (turn) => {
      const found = await turn.search("cabin wifi");
      const opened = await turn.read(found.hits[0].id);
      const started = await turn.startWork({ title: "Trip", request: "Plan it." });
      return turn.reply(`${opened.text}; ${started.text}`);
    }
  });
  const quiet = console.log;
  console.log = () => {}; // the model layer logs every call
  try {
    // The three shapes as a custom endpoint, then EV's default model as the catalogue describes it
    // (a Responses model that is given its tools inside the input).
    const setups = [...["anthropic-messages", "openai-completions", "openai-responses"].map((api) => ({ EV_MODEL: `stand-in/${api}`, EV_MODEL_API: api })), {}];
    for (const setup of setups) {
      const env = { ...setup, EV_MODEL_URL: standIn.url };
      const api = setup.EV_MODEL_API ?? "default model";
      const context = { systemPrompt: "You are EV.", messages: [userMessage("what was the cabin wifi password?")], tools };
      const used = [];
      let said = null;
      for (let step = 0; step < 8 && said === null; step++) {
        const turn = await modelTurn({ context, env, apiKey: "self-test", session: "self-test", code: "SELF_TEST", label: "main-agent", retryDelaysMs: [] });
        context.messages.push(turn.message);
        if (!turn.toolCalls.length) { said = turn.text; break; }
        used.push(...turn.toolCalls.map((call) => call.name));
        const replyCall = turn.toolCalls.find((call) => call.name === TOOLS.reply.name);
        if (replyCall) { said = replyCall.arguments.text; break; }
        context.messages.push(...turn.toolCalls.map((call) => toolResult(call, run[call.name](call.arguments))));
      }
      assert.deepEqual(used, ["search", "read", "start_work", "reply"], `${api}: the scripted turn did not come through as the expected tool calls`);
      assert.equal(said, "full text of turn:41; started Trip", `${api}: tool results did not get back to the script`);
    }
    assert.equal(standIn.calls("ev").length, setups.length, "A request carrying a tool result was counted as a new turn");
    assert.match(standIn.calls("ev")[0].text, /cabin wifi password/, "The stand-in did not read what the model was shown");
    assert.deepEqual(standIn.errors, [], "The stand-in recorded script errors");
  } finally { console.log = quiet; await standIn.stop(); }
}

if (import.meta.url === `file://${process.argv[1]}`) { await selfTest(); console.log("The stand-in speaks all three tool-calling API shapes."); }
