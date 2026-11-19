import { randomBytes, timingSafeEqual } from "node:crypto";
import { rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { retryAfterMs } from "./connections.mjs";

/**
 * How agents reach their model without ever holding a key.
 *
 * An agent's config points at this relay, with a task token as its "key".
 * The relay checks the token, takes the model the task was given, asks the
 * connections for the account's real auth (pi-ai refreshes a subscription
 * token under its lock, so EV stays the only refresher), and passes the
 * request on with that auth instead. The answer streams back untouched. The
 * relay does not translate between API shapes: the agent already speaks its
 * model's own one.
 *
 * The token is worthless anywhere else: it only works here, for that task's
 * model, while the task runs. What the provider answers is seen here too, so
 * an agent's usage limit or refused key marks the account just as EV's own
 * calls do.
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
  constructor({ connections, fetchImpl = fetch }) {
    this.connections = connections;
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
    const { model } = grant;
    let account;
    try { account = this.connections.forCall(model.provider, "AGENT_MODEL_UNAVAILABLE"); }
    catch (error) {
      const wait = error.wait ?? {};
      const seconds = wait.until ? Math.max(1, Math.ceil((Date.parse(wait.until) - Date.now()) / 1_000)) : 60;
      return this._error(response, wait.reason === "limited" ? 429 : 503, error.message, { "Retry-After": String(seconds) });
    }
    let resolved;
    try { resolved = await this.connections.models.getAuth(model); }
    catch (error) { this.connections.needsSignIn(account, error.message); return this._error(response, 401, `The ${model.provider} account needs a new sign-in`); }
    if (!resolved) return this._error(response, 503, `No account is connected for ${model.provider}`);
    const { apiKey, headers = {}, baseUrl } = resolved.auth;
    const upstream = `${(baseUrl ?? model.baseUrl).replace(/\/$/, "")}${url.pathname.slice("/relay".length)}${url.search}`;
    const forward = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !DROPPED.has(name)));
    const oauth = this.connections.serving(model.provider)?.method === "oauth";
    if (apiKey) Object.assign(forward, model.api === "anthropic-messages" && !oauth ? { "x-api-key": apiKey } : { authorization: `Bearer ${apiKey}` });
    Object.assign(forward, headers);
    const body = ["GET", "HEAD"].includes(request.method) ? undefined : Readable.toWeb(request);
    const answer = await this.fetch(upstream, { method: request.method, headers: forward, body, duplex: "half" });
    this._observe(account, answer);
    // fetch has already undone any compression, so its length no longer applies.
    const back = Object.fromEntries([...answer.headers].filter(([name]) => !["content-encoding", "content-length", "transfer-encoding", "connection"].includes(name)));
    response.writeHead(answer.status, back);
    if (!answer.body) return response.end();
    const stream = Readable.fromWeb(answer.body);
    request.on("close", () => { if (!response.writableFinished) stream.destroy(); });
    stream.on("error", () => response.destroy());
    stream.pipe(response);
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
