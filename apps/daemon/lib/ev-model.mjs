import { createHash } from "node:crypto";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";

/**
 * One way for EV's own model calls (main agent, planner, reviewer, memory) to
 * reach a model, through pi-ai. Transient failures (429, 5xx, timeouts,
 * dropped connections) are retried with backoff, so one blip does not turn a
 * chat message into a task or skip a review. A failed, cut-off or empty
 * reply never comes back as text: it throws an error carrying the caller's
 * `code`.
 *
 * EV_MODEL names the model as provider/model; a bare id means opencode-go,
 * whose catalogue gives its API shape, base URL and quirks. EV_MODEL_URL
 * sends the calls to another endpoint, and EV_MODEL_API (openai-responses,
 * openai-completions or anthropic-messages) says how it is spoken to when the
 * catalogue does not know the model. The key is OPENCODE_API, passed
 * explicitly, so pi-ai never looks up keys or credentials of its own.
 *
 * Every call writes one log line (role, session, attempts, duration, tokens,
 * outcome), so cost and failures of EV's own thinking are visible.
 */

const DEFAULT_MODEL = "opencode-go/gpt-6-luna";
const RETRY_DELAYS_MS = [1_000, 4_000];
const APIS = { "anthropic-messages": anthropicMessagesApi, "openai-completions": openAICompletionsApi, "openai-responses": openAIResponsesApi };
const opencodeGo = opencodeGoProvider();
const models = createModels();
models.setProvider(opencodeGo);

const configError = (message) => Object.assign(new Error(message), { code: "MODEL_NOT_CONFIGURED" });

/** The model record (pi-ai's shape: id, provider, api, baseUrl, compat) that EV_MODEL names. */
export function modelSettings(env = process.env, spec = env.EV_MODEL || DEFAULT_MODEL) {
  const slash = spec.indexOf("/");
  const provider = slash < 0 ? "opencode-go" : spec.slice(0, slash);
  const id = slash < 0 ? spec : spec.slice(slash + 1);
  const known = provider === "opencode-go" ? opencodeGo.getModels().find((model) => model.id === id) : null;
  const url = env.EV_MODEL_URL?.replace(/\/$/, "");
  if (!url) {
    if (known) return known;
    throw configError(provider === "opencode-go" ? `opencode-go has no model "${id}"` : `EV knows the opencode-go catalogue only; set EV_MODEL_URL and EV_MODEL_API to reach ${spec}`);
  }
  const api = env.EV_MODEL_API || known?.api;
  if (!APIS[api]) throw configError(`EV_MODEL_API must be one of ${Object.keys(APIS).join(", ")}${api ? `, not "${api}"` : ` for ${spec}`}`);
  if (known && api === known.api) return { ...known, baseUrl: url };
  return { id, name: id, provider, api, baseUrl: url, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 32_000 };
}

function providerFor(model) {
  if (!models.getProvider(model.provider)) {
    models.setProvider(createProvider({
      id: model.provider, auth: { apiKey: { name: model.provider, resolve: async () => ({ auth: {} }) } }, models: [],
      api: Object.fromEntries(Object.entries(APIS).map(([api, make]) => [api, make()]))
    }));
  }
  return models;
}

export function sessionHeader(seed) {
  const hex = createHash("sha256").update(seed).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** A user turn, for the start of a context. */
export const userMessage = (text) => ({ role: "user", content: text, timestamp: Date.now() });

/** What a tool returned, to push after the assistant message that called it. */
export const toolResult = (call, text, isError = false) => ({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: String(text) }], isError, timestamp: Date.now() });

function logCall(entry) {
  console.log(`[model] ${JSON.stringify({ at: new Date().toISOString(), ...entry })}`);
}

const transient = (status) => status === 408 || status === 409 || status === 429 || status >= 500;
const pause = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});
const chars = (messages) => messages.reduce((sum, message) => sum + (typeof message.content === "string" ? message.content.length : JSON.stringify(message.content ?? "").length), 0);

/**
 * One model turn over a pi-ai context ({ systemPrompt?, messages, tools? }).
 * Returns { message, text, toolCalls, usage, value }: push `message` onto
 * context.messages, then a toolResult for each tool call, and call again.
 * `parse(text, message)` gives `value`; a reply it rejects is retried like a
 * provider blip. Throws an error with `code` once retries are spent.
 */
export async function modelTurn({ context, parse = (text) => text, session, code, label, maxOutputTokens = 4_000, timeoutMs = 45_000, apiKey = process.env.OPENCODE_API, fetchImpl, signal, retryDelaysMs = RETRY_DELAYS_MS, env = process.env }) {
  if (!apiKey) throw Object.assign(new Error("The model key (OPENCODE_API) is not configured"), { code });
  let model;
  try { model = modelSettings(env); } catch (error) { throw Object.assign(error, { code }); }
  const started = Date.now();
  const log = (outcome, attempts, extra = {}) => logCall({ role: label, session, model: `${model.provider}/${model.id}`, attempts, ms: Date.now() - started, inputChars: chars(context.messages), outcome, ...extra });
  let failure;
  let attempt = 0;
  for (; attempt <= retryDelaysMs.length; attempt++) {
    if (attempt) {
      try { await pause(failure.retryAfterMs || retryDelaysMs[attempt - 1], signal); }
      catch (error) { log("aborted", attempt); throw error; }
    }
    let status = null, retryAfterMs = 0;
    const message = await providerFor(model).complete(model, context, {
      apiKey, sessionId: session, maxTokens: maxOutputTokens, maxRetries: 0,
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
      identity: { userAgent: { custom: `ev-${label}/0.2` } },
      // Seen here because the provider SDKs throw away the status of a failed reply.
      fetch: async (url, init) => {
        const response = await (fetchImpl ?? fetch)(url, init);
        status = response.status;
        const retryAfter = Number(response.headers?.get?.("retry-after"));
        if (retryAfter > 0) retryAfterMs = Math.min(retryAfter * 1_000, 30_000);
        return response;
      }
    });
    if (signal?.aborted) { log("aborted", attempt + 1); throw signal.reason; }
    // input counts every prompt token, cached ones included (pi-ai splits them out).
    const usage = { input: (message.usage?.input ?? 0) + (message.usage?.cacheRead ?? 0) + (message.usage?.cacheWrite ?? 0), output: message.usage?.output ?? 0, cached: message.usage?.cacheRead ?? 0 };
    const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
    const toolCalls = message.content.filter((part) => part.type === "toolCall");
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      // A timeout aborts too; only the caller's own signal ends the retries.
      failure = Object.assign(new Error(`${label} model call failed${status >= 400 ? ` (HTTP ${status})` : ""}: ${String(message.errorMessage ?? message.stopReason).replace(/\s+/g, " ").slice(0, 300)}`), { code, status: status >= 400 ? status : null, retryAfterMs });
      if (status >= 400 && !transient(status)) { log("rejected", attempt + 1, { status }); throw failure; }
      continue;
    }
    if (message.stopReason === "length" || (!text && !toolCalls.length)) {
      failure = Object.assign(new Error(message.stopReason === "length" ? `${label} reply was cut off at ${maxOutputTokens} tokens` : `${label} returned an empty reply`), { code });
      continue;
    }
    let value;
    try { value = parse(text, message); }
    catch (error) { failure = Object.assign(error, { code }); continue; }
    log("ok", attempt + 1, { tokens: usage });
    return { message, text, toolCalls, usage, value };
  }
  log("failed", attempt, { status: failure?.status ?? null, error: failure?.message?.slice(0, 200) ?? null });
  throw failure;
}

/** Text in, `parse(text)` out: one user message and no tools. */
export async function callModel({ input, ...options }) {
  return (await modelTurn({ ...options, context: { messages: [userMessage(input)] } })).value;
}

/** The first JSON object in a model's text, fenced or not. */
export function parseModelJson(raw, message) {
  try {
    const value = JSON.parse(raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {}
  throw new Error(message);
}
