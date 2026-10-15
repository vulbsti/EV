import { createHash } from "node:crypto";

/**
 * One way for EV's own model calls (main agent, planner, reviewer) to reach
 * OpenCode Go. Transient provider failures (429, 5xx, timeouts, dropped
 * connections) are retried with backoff, so one blip does not turn a chat
 * message into a task or skip a review.
 *
 * EV_MODEL picks the model and EV_MODEL_API how it is spoken to:
 * "responses" (OpenAI Responses), "chat" (Chat Completions) or "messages"
 * (Anthropic Messages), matching what OpenCode Go serves for that model.
 */

const BASE_URL = "https://opencode.ai/zen/go/v1";
const RETRY_DELAYS_MS = [1_000, 4_000];

export function modelSettings(env = process.env) {
  return { model: env.EV_MODEL || "gpt-6-luna", api: env.EV_MODEL_API || "responses" };
}

export function sessionHeader(seed) {
  const hex = createHash("sha256").update(seed).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function request(api, model, input, maxOutputTokens) {
  if (api === "chat") return { path: "/chat/completions", body: { model, messages: [{ role: "user", content: input }], max_tokens: maxOutputTokens } };
  if (api === "messages") return { path: "/messages", body: { model, messages: [{ role: "user", content: input }], max_tokens: maxOutputTokens } };
  return { path: "/responses", body: { model, input, max_output_tokens: maxOutputTokens } };
}

function outputText(api, body) {
  if (api === "chat") return String(body?.choices?.[0]?.message?.content ?? "").trim();
  if (api === "messages") return (body?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
  return (body?.output ?? []).filter((item) => item.type === "message" && item.role === "assistant")
    .flatMap((item) => item.content ?? []).filter((part) => part.type === "output_text").map((part) => part.text).join("\n").trim();
}

const transient = (status) => status === 408 || status === 409 || status === 429 || status >= 500;
const pause = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

/**
 * Returns `parse(text)`. A reply `parse` rejects is retried like a provider
 * blip. Throws an error with `code` once retries are spent.
 */
export async function callModel({ parse = (text) => text, input, session, code, label, maxOutputTokens = 4_000, timeoutMs = 45_000, apiKey = process.env.OPENCODE_API, fetchImpl = fetch, signal, retryDelaysMs = RETRY_DELAYS_MS, env = process.env }) {
  if (!apiKey) throw Object.assign(new Error("OpenCode Go is not configured"), { code });
  const { model, api } = modelSettings(env);
  const { path, body } = request(api, model, input, maxOutputTokens);
  let failure;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    if (attempt) await pause(Number(failure?.retryAfterMs) || retryDelaysMs[attempt - 1], signal);
    let response;
    try {
      response = await fetchImpl(`${BASE_URL}${path}`, {
        method: "POST", signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
        headers: { Authorization: `Bearer ${apiKey}`, "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json", "x-opencode-session": session, "User-Agent": `ev-${label}/0.2` },
        body: JSON.stringify(body)
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      failure = Object.assign(new Error(`${label} could not reach the model: ${error.message}`), { code });
      continue;
    }
    if (response.ok) {
      const text = outputText(api, await response.json().catch(() => null));
      try { return parse(text); }
      catch (error) { failure = Object.assign(error, { code }); continue; }
    }
    failure = Object.assign(new Error(`${label} returned HTTP ${response.status}`), { code, status: response.status });
    const retryAfter = Number(response.headers?.get?.("retry-after"));
    if (retryAfter > 0) failure.retryAfterMs = Math.min(retryAfter * 1_000, 30_000);
    if (!transient(response.status)) throw failure;
  }
  throw failure;
}

/** The first JSON object in a model's text, fenced or not. */
export function parseModelJson(raw, message) {
  try {
    const value = JSON.parse(raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {}
  throw new Error(message);
}
