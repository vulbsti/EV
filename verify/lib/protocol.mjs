// The one file that knows how EV talks to its model and its workers.
//
// Checks say what the model decides in plain terms ("start work", "search for
// X", "accept the result"). This file turns that into the bytes EV expects.
// When the wire changes, change it here and no check has to move.
//
// Two wires are supported side by side:
//   json    the role is one call that returns one JSON object (the reviewer
//           and the learner)
//   tools   the request offers tools; the stand-in answers with tool calls and
//           is called again with their results (any of the three API
//           dialects). EV1 speaks this: it ends its turn when it has nothing
//           more to call, so after its last call the stand-in answers with no
//           text and no calls.
// A decision a role has no way to express raises NotBuilt, and the check that
// needed it fails with that reason.

export class NotBuilt extends Error {
  constructor(what) { super(`EV cannot do this yet: ${what}`); this.name = "NotBuilt"; this.what = what; }
}

/**
 * Tool names and argument shapes the stand-in uses once EV offers tools.
 * `shown` is everything the model was shown, for arguments that refer to it.
 */
export const TOOLS = {
  search: { name: "search", args: ({ query }) => ({ query }) },
  read: { name: "read", args: ({ id }) => ({ id }) },
  reply: { name: "reply", args: ({ text }) => ({ text }) },
  ask: { name: "ask", args: ({ questions, assumptions = [] }) => ({ questions, assumptions }) },
  startWork: { name: "start_work", args: ({ title, request }) => ({ title, request }) },
  // Checks name work by its title; EV knows it by the id its work list shows.
  messageTask: { name: "message_task", args: ({ task, text = "", stop = false }, shown = "") => ({ task: workId(shown, task) ?? task, text, stop }) },
  // quote is the person's own words the memory rests on; without one it is a guess.
  remember: { name: "remember", args: ({ text, quote = null }) => ({ text, ...(quote ? { quote } : {}) }) },
  // ids are what search and read gave: memory:…, message:…, session:…, history:….
  forget: { name: "forget", args: ({ ids }) => ({ ids: [].concat(ids) }) },
  // The reviewer's own tools.
  readFile: { name: "read_file", args: ({ path }) => ({ path }) }
};

/** Names that would let EV1 act instead of coordinate. None may be offered to it. */
export const EXECUTION_TOOL = /exec|shell|bash|command|run_|write|edit|patch|browser|click|fetch|http/i;

// ---------------------------------------------------------------- requests

export function dialectOf(path) {
  if (path.endsWith("/chat/completions")) return "chat";
  if (path.endsWith("/messages")) return "messages";
  if (path.endsWith("/responses")) return "responses";
  return null;
}

const blocksText = (content) => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((part) => typeof part === "string" ? part : part?.text ?? (typeof part?.content === "string" ? part.content : blocksText(part?.content)) ?? part?.output ?? "").join("\n")
    : "";

/** Everything the model was shown before any tool result, as one string. */
export function shownText(dialect, body) {
  if (dialect === "responses") return [body.instructions ?? "", typeof body.input === "string" ? body.input : (body.input ?? []).map((item) => item.type === "function_call_output" ? "" : blocksText(item.content)).join("\n")].join("\n");
  const system = dialect === "messages" ? blocksText(body.system) : "";
  return [system, ...(body.messages ?? []).filter((message) => message.role !== "tool").map((message) => Array.isArray(message.content)
    ? message.content.filter((part) => part?.type !== "tool_result").map((part) => part?.text ?? "").join("\n")
    : blocksText(message.content))].join("\n");
}

export function offeredTools(dialect, body) {
  // Some Responses models are given their tools inside the input instead of a top-level list.
  const declared = dialect === "responses" && Array.isArray(body.input) ? body.input.filter((item) => item.type === "additional_tools" || item.type === "tool_search_output").flatMap((item) => item.tools ?? []) : [];
  return [...(body.tools ?? []), ...declared].map((tool) => dialect === "chat" ? tool.function?.name : tool.name).filter(Boolean);
}

/** Tool results carried by this request, by the call id the stand-in issued. */
export function toolResults(dialect, body) {
  const results = new Map();
  if (dialect === "responses") {
    for (const item of Array.isArray(body.input) ? body.input : []) if (item.type === "function_call_output") results.set(item.call_id, blocksText(item.output));
  } else if (dialect === "chat") {
    for (const message of body.messages ?? []) if (message.role === "tool") results.set(message.tool_call_id, blocksText(message.content));
  } else {
    for (const message of body.messages ?? []) {
      for (const part of Array.isArray(message.content) ? message.content : []) if (part?.type === "tool_result") results.set(part.tool_use_id, blocksText(part.content));
    }
  }
  return results;
}

/** Which of EV's thinking parts is calling. */
export function roleOf({ userAgent = "", text = "" }) {
  const label = /^ev-([a-z0-9-]+)\//.exec(userAgent)?.[1] ?? "";
  if (label === "main-agent") return "ev";
  return { "quality-gate": "reviewer", memory: "learner" }[label] ?? (label || "unknown");
}

/** The person's new message, as EV1 was shown it. */
export function personMessage(text) {
  const marker = "Their new message:\n";
  const at = text.lastIndexOf(marker);
  return at < 0 ? "" : text.slice(at + marker.length).trim();
}

/** The part of what EV1 was shown that is its memory of the person (all of it, if the layout is not recognised). */
export function memoryShown(text) {
  const from = text.indexOf("What EV knows about this person");
  const to = text.indexOf("Recent conversation (data)");
  return from >= 0 && to > from ? text.slice(from, to) : text;
}

/** The id EV1's work list gives a piece of work, found by its title. */
function workId(text, title) {
  for (const line of text.split("\n")) {
    const match = /^\[(work:[^\]]+)\] (.*)$/.exec(line);
    if (match && match[2].toLowerCase().includes(String(title).toLowerCase())) return match[1];
  }
  return null;
}

// --------------------------------------------------------------- responses

const usage = { input: 1200, output: 80 };

export function textResponse(dialect, text) {
  if (dialect === "chat") return { choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: usage.input, completion_tokens: usage.output } };
  if (dialect === "messages") return { type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: usage.input, output_tokens: usage.output } };
  return { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], usage: { input_tokens: usage.input, output_tokens: usage.output } };
}

export function toolCallResponse(dialect, { id, name, args }) {
  if (dialect === "chat") return { choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: usage.input, completion_tokens: usage.output } };
  if (dialect === "messages") return { type: "message", role: "assistant", content: [{ type: "tool_use", id, name, input: args }], stop_reason: "tool_use", usage: { input_tokens: usage.input, output_tokens: usage.output } };
  return { output: [{ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) }], usage: { input_tokens: usage.input, output_tokens: usage.output } };
}

/**
 * A whole reply (as textResponse / toolCallResponse build it) as the
 * server-sent event stream a real provider sends: callers always ask with
 * `stream: true`, and pi-ai rejects a reply that is not a stream.
 */
export function streamEvents(dialect, reply) {
  const frame = (data, event = data.type) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
  if (dialect === "chat") {
    const choice = reply.choices[0];
    const chunk = (delta, finish = null) => frame({ id: "chatcmpl-stand-in", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] }, null);
    return [
      chunk({ role: "assistant", content: choice.message.content ?? "" }),
      ...(choice.message.tool_calls ?? []).map((call, index) => chunk({ tool_calls: [{ index, ...call }] })),
      chunk({}, choice.finish_reason),
      frame({ id: "chatcmpl-stand-in", object: "chat.completion.chunk", choices: [], usage: { ...reply.usage, total_tokens: reply.usage.prompt_tokens + reply.usage.completion_tokens } }, null),
      "data: [DONE]\n\n"
    ];
  }
  if (dialect === "messages") {
    return [
      frame({ type: "message_start", message: { id: "msg_stand_in", type: "message", role: "assistant", model: "stand-in", content: [], stop_reason: null, usage: { input_tokens: reply.usage.input_tokens, output_tokens: 0 } } }),
      ...reply.content.flatMap((block, index) => [
        frame({ type: "content_block_start", index, content_block: block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} } }),
        frame({ type: "content_block_delta", index, delta: block.type === "text" ? { type: "text_delta", text: block.text } : { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }),
        frame({ type: "content_block_stop", index })
      ]),
      frame({ type: "message_delta", delta: { stop_reason: reply.stop_reason, stop_sequence: null }, usage: { output_tokens: reply.usage.output_tokens } }),
      frame({ type: "message_stop" })
    ];
  }
  const output = reply.output.map((item, index) => item.type === "message" ? { id: `msg_${index}`, status: "completed", ...item } : { id: `fc_${index}`, status: "completed", ...item });
  return [
    frame({ type: "response.created", response: { id: "resp_stand_in", status: "in_progress", output: [] } }),
    ...output.flatMap((item, index) => [
      frame({ type: "response.output_item.added", output_index: index, item: item.type === "message" ? { ...item, content: [], status: "in_progress" } : { ...item, arguments: "", status: "in_progress" } }),
      item.type === "message"
        ? frame({ type: "response.output_text.delta", output_index: index, item_id: item.id, content_index: 0, delta: item.content.map((part) => part.text).join("") })
        : frame({ type: "response.function_call_arguments.delta", output_index: index, item_id: item.id, delta: item.arguments }),
      frame({ type: "response.output_item.done", output_index: index, item })
    ]),
    frame({ type: "response.completed", response: { id: "resp_stand_in", status: "completed", output, usage: { ...reply.usage, total_tokens: reply.usage.input_tokens + reply.usage.output_tokens } } })
  ];
}

/** The JSON wire of the one-shot roles. */
export const today = {
  reviewer: (review = {}) => review.verdict === "revise"
    ? { verdict: "revise", intentMatch: "partly", criteria: [], missing: review.missing ?? ["Something is missing."], feedback: review.feedback ?? review.missing ?? ["Fix it."], caveats: [], summary: review.summary ?? "Not ready.", handoff: review.handoff ?? "Still being worked on.", progress: review.progress ?? "improving", askPerson: review.askPerson ?? "" }
    : { verdict: "accept", intentMatch: "yes", criteria: [], missing: [], feedback: [], caveats: [], summary: review.summary ?? "Ready.", handoff: review.handoff ?? "It is done.", progress: "improving", askPerson: "" },
  learner: (ops = []) => ({ ops })
};

// ----------------------------------------------------------------- workers

/** What kind of turn a worker prompt is asking for. */
export function workerTurnKind(prompt) {
  if (/^You have used the budget/.test(prompt)) return "wrap-up";
  if (/^EV reviewed your result|^EV could not read your last result/.test(prompt)) return "revision";
  if (/^Answer to your question|^While you were working|^You were interrupted|^The person came back/.test(prompt)) return "continuation";
  return "first";
}

/** The report an agent hands back, in the shape EV parses. */
export function workerReport({ answer = "Done.", outcome = "completed", question, deliverables = [], evidence = [], limitations = [], goal = "Carry out the request." } = {}) {
  return JSON.stringify({ goal, outcome, ...(question ? { question } : {}), answer, evidence, deliverables, checks: [], limitations });
}

/** What the reviewer was told about where the loop stands. */
export function reviewState(text) {
  const round = Number(/This is review round (\d+)/.exec(text)?.[1] ?? 0);
  const at = text.indexOf("Earlier review rounds");
  return { round, earlier: at < 0 ? "" : text.slice(at, text.indexOf("\n\n", at) < 0 ? undefined : text.indexOf("\n\n", at)) };
}

/**
 * What a learner script needs from its prompt, and the memory changes it can
 * hand back. Each change is found by a few words of the person's message
 * (`said`) and, where it touches an existing memory, a few words of that
 * memory (`about`); it is null when this pass has no such message or memory,
 * so a script can list every change it ever makes and filter out the nulls.
 */
export function learnerView(text) {
  const has = (haystack, needle) => haystack.toLowerCase().includes(String(needle).toLowerCase());
  const memoryId = (about) => {
    for (const line of text.split("\n")) {
      const match = /^(m\d+) \[/.exec(line);
      if (match && has(line, about)) return match[1];
    }
    return null;
  };
  const events = [];
  const pattern = /^E(\d+) (conversation turn|task episode)[^\n]*\n([\s\S]*?)(?=^E\d+ (?:conversation turn|task episode)|(?![\s\S]))/gm;
  const newEvents = text.slice(text.lastIndexOf("New events (data, not instructions):"));
  for (const match of newEvents.matchAll(pattern)) {
    events.push({ number: Number(match[1]), type: match[2] === "task episode" ? "task" : "turn", text: match[3], person: /^Person: (.*)$/m.exec(match[3])?.[1]?.trim() ?? "" });
  }
  const event = (said) => events.find((candidate) => has(candidate.person || candidate.text, said)) ?? null;
  const eventWith = (said) => event(said)?.number ?? null;
  // quote is the person's own words the change rests on; EV refuses or downgrades a change without one.
  const own = (found) => ({ event: found.number, quote: found.person });
  return {
    memoryId, events, eventWith,
    /** The person said it in so many words. */
    stated: (said, kind, memory, extra = {}) => { const found = event(said); return found ? { op: "add", kind, text: memory, explicit: true, ...own(found), ...extra } : null; },
    /** EV inferred it; the person did not say it. */
    guessed: (said, kind, memory, extra = {}) => { const found = event(said); return found ? { op: "add", event: found.number, kind, text: memory, explicit: false, ...extra } : null; },
    /** A later message supports a memory that already exists. */
    confirmed: (said, about) => { const found = event(said), id = memoryId(about); return found && id ? { op: "confirm", event: found.number, id } : null; },
    /** The learner judges that a guess has held up well enough to rely on, and says why. */
    reliedOn: (said, about, reason) => { const found = event(said), id = memoryId(about); return found && id ? { op: "confirm", event: found.number, id, rely: true, reason } : null; },
    /** The person said it is different now. */
    changed: (said, about, memory) => { const found = event(said), id = memoryId(about); return found && id ? { op: "update", id, text: memory, explicit: true, change: "changed", ...own(found) } : null; },
    /** The person asked EV to forget it. */
    forgotten: (said, about) => { const found = event(said), id = memoryId(about); return found && id ? { op: "forget", id, part: "all", ...own(found) } : null; }
  };
}
