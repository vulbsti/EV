// The simulated user and the judge are model calls separate from EV. They use
// the same OpenCode Go responses API EV uses unless overridden.
const DEFAULT_URL = "https://opencode.ai/zen/go/v1/responses";

export function modelConfig() {
  return {
    url: process.env.EV_QA_MODEL_URL ?? DEFAULT_URL,
    model: process.env.EV_QA_MODEL ?? "gpt-6-luna",
    apiKey: process.env.EV_QA_API_KEY ?? process.env.OPENCODE_API ?? null
  };
}

export async function askModelJson(input, { maxOutputTokens = 3_000, timeoutMs = 90_000 } = {}) {
  const { url, model, apiKey } = modelConfig();
  if (!apiKey) throw new Error("Set OPENCODE_API (or EV_QA_API_KEY) for the simulated user and judge");
  const response = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "User-Agent": "ev-qa/0.1" },
    body: JSON.stringify({ model, input, max_output_tokens: maxOutputTokens })
  });
  if (!response.ok) throw new Error(`QA model returned HTTP ${response.status}`);
  const body = await response.json();
  const raw = body.output?.filter((item) => item.type === "message" && item.role === "assistant")
    .flatMap((item) => item.content ?? []).filter((part) => part.type === "output_text").map((part) => part.text).join("\n") ?? "";
  const candidate = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  try { return JSON.parse(candidate); }
  catch { throw new Error(`QA model returned unreadable JSON: ${raw.slice(0, 200)}`); }
}
