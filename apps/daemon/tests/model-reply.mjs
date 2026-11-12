// What a provider sends back for one model call, for tests that stand in for
// it through fetchImpl: an OpenAI Responses event stream carrying `text`.
export function modelReply(text) {
  const item = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const events = [
    { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [], status: "in_progress" } },
    { type: "response.output_text.delta", output_index: 0, item_id: "msg_1", content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_1", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } }
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}

/** The text a model call showed the model. */
export const shownInput = (init) => JSON.parse(init.body).input.map((item) => typeof item.content === "string" ? item.content : (item.content ?? []).map((part) => part.text ?? "").join("")).join("\n");
