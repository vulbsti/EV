import { createHash } from "node:crypto";
import { Connections, retryAfterMs as readRetryAfter } from "./connections.mjs";
import { ModelRoutes } from "./model-routes.mjs";

/**
 * One way for EV's own model calls (main agent, reviewer, memory) to
 * reach a model, through pi-ai. Transient failures (429, 5xx, a model gone
 * silent, dropped connections) are retried with backoff, so one blip does not
 * turn a chat message into a task or skip a review. A failed, cut-off or empty
 * reply never comes back as text: it throws an error carrying the caller's
 * `code`.
 *
 * No call is cut short by EV: a reply may be as long as the model's own
 * output limit (`maxTokens` in its pi-ai record, asked for explicitly since an
 * OpenAI-compatible provider's own default can be far lower), and a call ends
 * only when the model falls silent (no bytes for `silenceMs`), however long it
 * keeps streaming. Reasoning models think for a long time and spend tokens
 * doing it; that is the work.
 *
 * EV_MODEL names the model as provider/model; a bare id means opencode-go.
 * pi-ai's catalogue gives each model its API shape, base URL and quirks.
 * EV_MODEL_URL sends the calls to another endpoint, and EV_MODEL_API
 * (openai-responses, openai-completions or anthropic-messages) says how it is
 * spoken to when the catalogue does not know the model.
 *
 * Calls go through the best route to the model (model-routes.mjs): the same
 * model at whichever connected provider and account serves it best now, with
 * that account's key or subscription token, never one pi-ai finds on its own.
 * A usage limit (429 once retries are spent, or a reset too far off to wait
 * out here) marks the account limited until its reset, and a refused key
 * (401, 403) marks it as needing a new sign-in; either way the call moves to
 * the next route. When no route is usable the error carries `wait` saying
 * what the work waits for.
 *
 * Each role can have its own model: EV_MODEL_<ROLE> (EV, REVIEWER, LEARNER,
 * and the roles later engines add, such as FILER, GROUPER, PORTRAIT) wins over
 * EV_MODEL for that role, so a cheap model can do cheap work. `modelFor` is
 * the one place that decides which model a role gets.
 *
 * Every call writes one log line (role, session, attempts, duration, tokens,
 * outcome) and one row in the record of model calls, so cost and failures of
 * EV's own thinking are visible and each route's speed is measured.
 */

const DEFAULT_MODEL = "opencode-go/gpt-6-luna";
const RETRY_DELAYS_MS = [1_000, 4_000];
/** How long a model may stay silent (no bytes at all, not even a keep-alive) before the call counts as failed. */
const SILENCE_MS = 90_000;
const APIS = ["anthropic-messages", "openai-completions", "openai-responses"];
// Longer than this, a Retry-After is a usage limit to wait out, not a blip to retry.
const LONGEST_RETRY_MS = 30_000;
// Until the daemon hands over its own (with the store and the secrets file), keys come from the environment only.
let connections = new Connections();
let routes = new ModelRoutes({ connections });
/** Makes every model call go through these connections. */
export function useConnections(next) { connections = next; routes = new ModelRoutes({ connections: next }); }
/** The routes (and the record of model calls) over the current connections. */
export const currentRoutes = () => routes;

const configError = (message) => Object.assign(new Error(message), { code: "MODEL_NOT_CONFIGURED" });

/** Which role each call label belongs to, for its EV_MODEL_<ROLE> setting. */
const ROLES = { "main-agent": "EV", "quality-gate": "REVIEWER", memory: "LEARNER" };

/** The model spec (provider/model) a role uses: its own setting, else EV_MODEL. */
export function modelFor(role, env = process.env) {
  const name = (ROLES[role] ?? String(role ?? "")).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return (name && env[`EV_MODEL_${name}`]) || env.EV_MODEL || DEFAULT_MODEL;
}

/** The model record (pi-ai's shape: id, provider, api, baseUrl, compat) that EV_MODEL names. */
export function modelSettings(env = process.env, spec = env.EV_MODEL || DEFAULT_MODEL) {
  const slash = spec.indexOf("/");
  const provider = slash < 0 ? "opencode-go" : spec.slice(0, slash);
  const id = slash < 0 ? spec : spec.slice(slash + 1);
  const known = connections.models.getModel(provider, id);
  const url = env.EV_MODEL_URL?.replace(/\/$/, "");
  if (!url) {
    if (known) return known;
    throw configError(connections.models.getProvider(provider) ? `${provider} has no model "${id}"` : `pi-ai does not know the provider "${provider}"; set EV_MODEL_URL and EV_MODEL_API to reach ${spec}`);
  }
  const api = env.EV_MODEL_API || known?.api;
  if (!APIS.includes(api)) throw configError(`EV_MODEL_API must be one of ${APIS.join(", ")}${api ? `, not "${api}"` : ` for ${spec}`}`);
  if (known && api === known.api) return { ...known, baseUrl: url };
  return { id, name: id, provider, api, baseUrl: url, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 32_000 };
}

function providerFor(model) {
  connections.ensureProvider(model.provider);
  return connections.models;
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
 * A fetch that hears every byte the provider sends: each one calls `heard`.
 * When `quiet` aborts, the body being read fails at once, whoever made it.
 */
function listening(fetchImpl, heard, quiet, seen) {
  return async (url, init) => {
    const response = await (fetchImpl ?? fetch)(url, init);
    heard();
    seen(response);
    if (!response.body) return response;
    const reader = response.body.getReader();
    let controller;
    const stop = () => { try { controller.error(quiet.reason); } catch {} reader.cancel(quiet.reason).catch(() => {}); };
    const body = new ReadableStream({
      start(c) { controller = c; if (quiet.aborted) stop(); else quiet.addEventListener("abort", stop, { once: true }); },
      async pull(c) {
        const { done, value } = await reader.read();
        heard();
        try { if (done) { quiet.removeEventListener("abort", stop); c.close(); } else c.enqueue(value); } catch { /* already failed */ }
      },
      cancel(reason) { quiet.removeEventListener("abort", stop); return reader.cancel(reason); }
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

/**
 * One model turn over a pi-ai context ({ systemPrompt?, messages, tools? }).
 * Returns { message, text, toolCalls, usage, value }: push `message` onto
 * context.messages, then a toolResult for each tool call, and call again.
 * `parse(text, message)` gives `value`; a reply it rejects is retried like a
 * provider blip. Throws an error with `code` once retries are spent.
 */
export async function modelTurn({ context, session, code, label, role = label, spec = null, apiKey, env = process.env, workId = null, ...rest }) {
  let asked;
  // `spec` (provider/model) overrides the role's model, as when a reviewer should not be the worker's model.
  try { asked = modelSettings(env, spec || modelFor(role, env)); } catch (error) { throw Object.assign(error, { code }); }
  // An explicit key (tests, the harness's self-test) bypasses the accounts.
  if (apiKey) return turnOn({ ...rest, context, session, code, label, apiKey, workId, model: asked, account: null });
  await connections.scanned;
  // Each pass marks one account limited or signed out, so this ends: on a reply, or when no route is left.
  for (;;) {
    // One turn of EV's stays on one route while it can (the provider's prompt cache).
    const { model, connection } = routes.pick(asked, code, { stick: session ? `${label}:${session}` : null });
    try { return await turnOn({ ...rest, context, session, code, label, workId, model, account: connection }); }
    catch (error) { if (!error.reroute) throw error; }
  }
}

const reroute = (connection) => Object.assign(new Error(`${connection.provider} can no longer be used for now`), { reroute: true });

/** One model turn through one route: `account` is its connection (null with an explicit key). */
async function turnOn({ context, parse = (text) => text, session, code, label, silenceMs = SILENCE_MS, apiKey, fetchImpl, signal, retryDelaysMs = RETRY_DELAYS_MS, workId, model, account }) {
  if (account?.method === "oauth") {
    // A subscription token that cannot be refreshed means signing in again.
    try { await providerFor(model).getAuth(model, { signal }); }
    catch (error) { connections.needsSignIn(account, error.message); throw reroute(account); }
  }
  const started = Date.now();
  let firstByteMs = null;
  const log = (outcome, attempts, extra = {}) => {
    const ms = Date.now() - started;
    logCall({ role: label, session, model: `${model.provider}/${model.id}`, attempts, ms, inputChars: chars(context.messages), outcome, ...extra });
    if (!apiKey) routes.record({ role: label, workId, model, connectionId: account?.id ?? null, outcome, status: extra.status ?? null, ms, firstByteMs, tokens: extra.tokens ?? null });
  };
  let failure;
  let attempt = 0;
  for (; attempt <= retryDelaysMs.length; attempt++) {
    if (attempt) {
      try { await pause(failure.retryAfterMs || retryDelaysMs[attempt - 1], signal); }
      catch (error) { log("aborted", attempt); throw error; }
    }
    let status = null, retryAfterMs = 0, resetMs = 0;
    // The call lives as long as the model keeps sending something.
    const quiet = new AbortController();
    let timer, ended = false;
    const heard = () => {
      clearTimeout(timer);
      if (!ended) timer = setTimeout(() => quiet.abort(new Error(`the model sent nothing for ${silenceMs / 1_000} s`)), silenceMs);
    };
    heard();
    let message;
    try {
      message = await providerFor(model).complete(model, context, {
        ...(apiKey ? { apiKey } : {}), sessionId: session, maxTokens: model.maxTokens, maxRetries: 0,
        signal: AbortSignal.any([quiet.signal, ...(signal ? [signal] : [])]),
        identity: { userAgent: { custom: `ev-${label}/0.2` } },
        // Seen here because the provider SDKs throw away the status of a failed reply.
        fetch: listening(fetchImpl, heard, quiet.signal, (response) => {
          status = response.status;
          firstByteMs = Date.now() - started;
          resetMs = readRetryAfter(response.headers?.get?.("retry-after"));
          retryAfterMs = Math.min(resetMs, LONGEST_RETRY_MS);
        })
      });
    } finally { ended = true; clearTimeout(timer); }
    if (signal?.aborted) { log("aborted", attempt + 1); throw signal.reason; }
    // input counts every prompt token, cached ones included (pi-ai splits them out).
    const usage = { input: (message.usage?.input ?? 0) + (message.usage?.cacheRead ?? 0) + (message.usage?.cacheWrite ?? 0), output: message.usage?.output ?? 0, cached: message.usage?.cacheRead ?? 0 };
    const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
    const toolCalls = message.content.filter((part) => part.type === "toolCall");
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      // Silence aborts too; only the caller's own signal ends the retries.
      const why = quiet.signal.aborted ? quiet.signal.reason.message : message.errorMessage ?? message.stopReason;
      failure = Object.assign(new Error(`${label} model call failed${status >= 400 ? ` (HTTP ${status})` : ""}: ${String(why).replace(/\s+/g, " ").slice(0, 300)}`), { code, status: status >= 400 ? status : null, retryAfterMs, resetMs });
      if (status >= 400 && !transient(status)) {
        log("rejected", attempt + 1, { status });
        if (account && (status === 401 || status === 403)) { connections.needsSignIn(account, why); throw reroute(account); }
        throw failure;
      }
      if (account && status === 429 && resetMs > LONGEST_RETRY_MS) { log("limited", attempt + 1, { status }); connections.limited(account, resetMs); throw reroute(account); }
      continue;
    }
    // With tools on offer, a turn may end with nothing left to say.
    if (message.stopReason === "length" || (!text && !toolCalls.length && !context.tools?.length)) {
      failure = Object.assign(new Error(message.stopReason === "length" ? `${label} reply was cut off at the model's output limit` : `${label} returned an empty reply`), { code });
      continue;
    }
    let value;
    try { value = parse(text, message); }
    catch (error) { failure = Object.assign(error, { code }); continue; }
    log("ok", attempt + 1, { tokens: usage });
    if (account) connections.ready(account);
    return { message, text, toolCalls, usage, value };
  }
  log("failed", attempt, { status: failure?.status ?? null, error: failure?.message?.slice(0, 200) ?? null });
  if (account && failure?.status === 429) { connections.limited(account, failure.resetMs); throw reroute(account); }
  throw failure;
}

/**
 * Tries a key with one tiny call to a model of its provider (EV's own model
 * when it is that provider's, so EV_MODEL_URL is honoured), the way a key is
 * checked when the person pastes it. Returns { ok, status, error }.
 */
export async function tryKey(providerId, key, { env = process.env, fetchImpl } = {}) {
  let model = null;
  try { model = modelSettings(env); } catch {}
  if (model?.provider !== providerId) {
    connections.ensureProvider(providerId);
    model = [...connections.models.getModels(providerId)].sort((a, b) => (a.cost?.input ?? 0) - (b.cost?.input ?? 0))[0] ?? null;
  }
  if (!model) return { ok: false, status: null, error: `EV knows no model of ${providerId} to try the key on` };
  let status = null;
  const message = await providerFor(model).complete(model, { messages: [userMessage("Reply with the word ok.")] }, {
    apiKey: key, maxTokens: 16, maxRetries: 0, signal: AbortSignal.timeout(60_000),
    identity: { userAgent: { custom: "ev-connection-test/0.2" } },
    fetch: async (url, init) => { const response = await (fetchImpl ?? fetch)(url, init); status = response.status; return response; }
  });
  if (message.stopReason !== "error" && message.stopReason !== "aborted") return { ok: true, status };
  return { ok: false, status, error: String(message.errorMessage ?? message.stopReason).replace(/\s+/g, " ").slice(0, 300) };
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
