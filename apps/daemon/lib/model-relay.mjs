import { randomBytes, timingSafeEqual } from "node:crypto";
import { rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { retryAfterMs } from "./connections.mjs";
import { ModelRoutes } from "./model-routes.mjs";
import { TailBuffer } from "./worker-usage.mjs";

/**
 * How agents reach their model without ever holding a key.
 *
 * An agent's config points at this relay, with a task token as its "key".
 * The relay checks the token, takes the model the task was given, picks the
 * best route to it now (model-routes.mjs: the same model at another
 * connected provider or account, in the same API shape, when the first one
 * is limited), asks the connections for that account's real auth (pi-ai refreshes a subscription
 * token under its lock, so EV stays the only refresher), and passes the
 * request on with that auth instead. The answer streams back untouched. The
 * relay does not translate between API shapes: the agent already speaks its
 * model's own one.
 *
 * The token is worthless anywhere else: it only works here, for that task's
 * model, while the task runs. What the provider answers is seen here too, so
 * an agent's usage limit or refused key marks the account just as EV's own
 * calls do. A task keeps its route while that account is usable; when it
 * stops being usable, the refused request goes out once more on the next
 * route before the agent sees anything, and the task stays there. Every
 * request leaves a row in the record of model calls, and a change of route
 * mid-task is told to `onRouteChange`, so the work's steps show it.
 *
 * On the host the relay is a loopback port. A container has no way to that
 * port, so each sandboxed run gets a socket file of its own, mounted into the
 * container, and a small forwarder inside it (see FORWARDER) turns a loopback
 * port there into that socket.
 */

// Headers that belong to one hop, or carry the agent's stand-in key.
const DROPPED = new Set(["host", "connection", "keep-alive", "transfer-encoding", "content-length", "authorization", "x-api-key", "proxy-authorization", "accept-encoding"]);
// A provider that keeps answering 429 this many times in a row is treated as a usage limit.
const LIMIT_AFTER_429S = 3;
const LONGEST_RETRY_MS = 30_000;

/** Run inside a container: forwards 127.0.0.1:<port> there to the relay's socket file. */
export const FORWARDER = `import net from "node:net";
const [socket, port] = process.argv.slice(2);
net.createServer((inside) => {
  const relay = net.connect(socket);
  inside.on("error", () => relay.destroy());
  relay.on("error", () => inside.destroy());
  inside.pipe(relay).pipe(inside);
}).listen(Number(port), "127.0.0.1");
`;

const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class ModelRelay {
  constructor({ connections, routes = new ModelRoutes({ connections }), fetchImpl = fetch, onRouteChange = null }) {
    this.connections = connections;
    this.routes = routes;
    this.onRouteChange = onRouteChange;
    this.fetch = fetchImpl;
    this.grants = new Map(); // token -> { taskId, model, socket }
    this.refusals = new Map(); // connection id -> 429s in a row
    this.server = createServer((request, response) => {
      this._handle(request, response).catch((error) => {
        if (!response.headersSent) this._error(response, 502, `EV's model relay failed: ${error.message}`);
        else response.destroy(error);
      });
    });
  }

  /** Starts the loopback listener. */
  async start({ host = "127.0.0.1", port = 0 } = {}) {
    await new Promise((resolve, reject) => { this.server.once("error", reject); this.server.listen(port, host, resolve); });
    this.url = `http://${host}:${this.server.address().port}`;
    return this;
  }

  /**
   * A grant for one run of one task: { token, baseUrl } for its config, and,
   * for a container, { socket } to mount and forward to. Revoke it when the
   * run ends.
   */
  async grant({ taskId, model, socket = false }) {
    const token = `ev-task-${randomBytes(24).toString("hex")}`;
    const grant = { taskId, model, token };
    if (socket) {
      grant.socket = join(tmpdir(), `ev-relay-${randomBytes(6).toString("hex")}.sock`);
      grant.listener = createServer((request, response) => this.server.emit("request", request, response));
      await new Promise((resolve, reject) => { grant.listener.once("error", reject); grant.listener.listen(grant.socket, resolve); });
    }
    this.grants.set(token, grant);
    return { token, baseUrl: `${this.url}/relay`, socket: grant.socket ?? null };
  }

  revoke(token) {
    const grant = this.grants.get(token);
    if (!grant) return;
    this.grants.delete(token);
    this.routes.unstick(token);
    if (grant.listener) { grant.listener.close(); grant.listener.closeAllConnections?.(); rmSync(grant.socket, { force: true }); }
  }

  async stop() {
    for (const token of [...this.grants.keys()]) this.revoke(token);
    this.server.closeAllConnections?.();
    await new Promise((resolve) => this.server.close(resolve));
  }

  _error(response, status, message, headers = {}) {
    response.writeHead(status, { "Content-Type": "application/json", ...headers });
    response.end(JSON.stringify({ error: { type: "ev_relay", message } }));
  }

  async _handle(request, response) {
    const url = new URL(request.url, "http://relay");
    if (!url.pathname.startsWith("/relay/")) return this._error(response, 404, "Not a relay path");
    const presented = String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "") || String(request.headers["x-api-key"] ?? "");
    const grant = [...this.grants.values()].find((candidate) => same(candidate.token, presented));
    if (!grant) return this._error(response, 401, "This task token is not valid (the task ended, or it was never EV's)");
    // Kept whole, so a request refused before any byte reached the agent can go out again on the next route.
    const body = ["GET", "HEAD"].includes(request.method) ? undefined : await bodyOf(request);
    let sent = await this._send(grant, request, url, body);
    if (sent.error) return this._error(response, ...sent.error);
    if (sent.answer.status === 429 || sent.answer.status === 401 || sent.answer.status === 403) {
      // The account was just marked as out of use: the agent never sees the limit when another route can take it.
      const now = this.connections.connectionsOf(sent.account.provider).find((connection) => connection.id === sent.account.id);
      const again = now && this.connections.usable(now) ? null : await this._send(grant, request, url, body);
      if (again && !again.error) { await sent.answer.body?.cancel().catch(() => {}); sent.record(); sent = again; }
    }
    const { answer, record, tail } = sent;
    // fetch has already undone any compression, so its length no longer applies.
    const back = Object.fromEntries([...answer.headers].filter(([name]) => !["content-encoding", "content-length", "transfer-encoding", "connection"].includes(name)));
    response.writeHead(answer.status, back);
    if (!answer.body) { record(); return response.end(); }
    response.on("close", record);
    const stream = Readable.fromWeb(answer.body);
    // The end of the answer carries its token counts: kept so the call's cost is known (the monthly cap counts it).
    stream.on("data", (chunk) => tail.push(chunk));
    request.on("close", () => { if (!response.writableFinished) stream.destroy(); });
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  }

  /**
   * Sends one request of a task on its route: { answer, account, record } or
   * { error: [status, message, headers] }. The task keeps its route while
   * that account stays usable (model-routes.mjs, `stick`), so a provider's
   * prompt cache is not thrown away mid-task.
   */
  async _send(grant, request, url, body) {
    let route;
    const subject = `work:${grant.taskId}`;
    try { route = this.routes.pick(grant.model, "AGENT_MODEL_UNAVAILABLE", { sameApi: true, stick: grant.token, subject }); }
    catch (error) {
      // A subscription ran out and only a paid route is left: weigh it once (limit-decision.mjs), then look again.
      if (error.paid && this.routes.decider?.open(subject, error.limited)) {
        await this.routes.decider.decide({ subject, limited: error.limited, paid: error.paid });
        return this._send(grant, request, url, body);
      }
      const wait = error.wait ?? {};
      const seconds = wait.until ? Math.max(1, Math.ceil((Date.parse(wait.until) - Date.now()) / 1_000)) : 60;
      return { error: [wait.reason === "limited" ? 429 : 503, error.message, { "Retry-After": String(seconds) }] };
    }
    const { model, connection: account } = route;
    if (route.instead) this.routes.decider?.switched({ subject, limited: route.instead, paid: route });
    this._noticeRoute(grant, route);
    let resolved;
    try { resolved = await this.connections.models.getAuth(model); }
    catch (error) { this.connections.needsSignIn(account, error.message); return { error: [401, `The ${model.provider} account needs a new sign-in`] }; }
    if (!resolved) return { error: [503, `No account is connected for ${model.provider}`] };
    const { apiKey, headers = {}, baseUrl } = resolved.auth;
    const upstream = `${(baseUrl ?? model.baseUrl).replace(/\/$/, "")}${url.pathname.slice("/relay".length)}${url.search}`;
    const forward = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !DROPPED.has(name)));
    if (apiKey) Object.assign(forward, model.api === "anthropic-messages" && account.method !== "oauth" ? { "x-api-key": apiKey } : { authorization: `Bearer ${apiKey}` });
    Object.assign(forward, headers);
    const started = Date.now();
    // Another provider may know the same model by another id ("openai/gpt-6-luna"): the one thing the relay rewrites.
    const answer = await this.fetch(upstream, { method: request.method, headers: forward, body: body && model.id !== grant.model.id ? renamed(body, model.id) : body });
    const firstByteMs = Date.now() - started;
    this._observe(account, answer);
    let recorded = false;
    const tail = new TailBuffer(64 * 1024);
    const record = () => {
      if (recorded) return;
      recorded = true;
      this.routes.record({ role: "agent", workId: grant.taskId, model, connectionId: account.id, outcome: answer.ok ? "ok" : answer.status === 429 ? "limited" : "rejected", status: answer.status, ms: Date.now() - started, firstByteMs, tokens: answer.ok ? tokensIn(tail.text()) : null });
    };
    return { answer, account, record, tail };
  }

  /** Tells onRouteChange when this task's requests start going out on another route. */
  _noticeRoute(grant, route) {
    const key = `${route.model.provider}/${route.model.id}/${route.connection.id}`;
    const from = grant.route;
    grant.route = { key, provider: route.model.provider, model: route.model.id, connectionId: route.connection.id };
    if (!from || from.key === key) return;
    try { this.onRouteChange?.({ taskId: grant.taskId, from, to: grant.route, why: this.connections.connectionsOf(from.provider).find((connection) => connection.id === from.connectionId) ?? { status: "removed" } }); } catch { /* telling never stops the agent */ }
  }

  /** What the provider's answer says about the account. */
  _observe(account, answer) {
    if (answer.status === 401 || answer.status === 403) return this.connections.needsSignIn(account, `The provider refused the account (HTTP ${answer.status})`);
    if (answer.status === 429) {
      const wait = retryAfterMs(answer.headers.get("retry-after"));
      const count = (this.refusals.get(account.id) ?? 0) + 1;
      this.refusals.set(account.id, count);
      if (wait > LONGEST_RETRY_MS || count >= LIMIT_AFTER_429S) { this.refusals.delete(account.id); this.connections.limited(account, wait); }
      return;
    }
    if (answer.ok) { this.refusals.delete(account.id); this.connections.ready(account); }
  }
}

/**
 * Token counts from the end of a provider's answer, in any of the three API
 * shapes (input_tokens / prompt_tokens, output_tokens / completion_tokens,
 * cached reads). The last count of each wins. Null when none is found.
 */
export function tokensIn(text) {
  const last = (names) => {
    let found = null;
    for (const name of names) for (const match of text.matchAll(new RegExp(`"${name}"\\s*:\\s*(\\d+)`, "g"))) found = Math.max(found ?? 0, Number(match[1]));
    return found;
  };
  const input = last(["input_tokens", "prompt_tokens"]);
  const output = last(["output_tokens", "completion_tokens"]);
  const cached = last(["cache_read_input_tokens", "cached_tokens"]) ?? 0;
  if (input === null && output === null) return null;
  // Anthropic counts cached reads apart from input; the OpenAI shapes count them inside it.
  const apart = /"cache_read_input_tokens"/.test(text);
  return { input: (input ?? 0) + (apart ? cached : 0), output: output ?? 0, cached };
}

async function bodyOf(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** A JSON request body with its model field set to `id`. Bodies that are not JSON pass as they were. */
function renamed(raw, id) {
  try {
    const value = JSON.parse(raw.toString("utf8"));
    if (value && typeof value === "object" && "model" in value) return JSON.stringify({ ...value, model: id });
  } catch {}
  return raw;
}
