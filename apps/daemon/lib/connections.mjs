import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { opencodeConsoleOAuth } from "./opencode-console.mjs";
import { ensurePrivateDirectorySync, ensurePrivateFileSync } from "./file-permissions.mjs";

/**
 * How EV signs in to the providers that serve its models.
 *
 * A connection is one account at one provider: a key the person pasted, a
 * subscription they signed in to, or a key found in EV's environment. A
 * provider can hold several, and one is active. Each has a status that
 * changes what EV does: ready is used, limited is skipped until its time,
 * needs-sign-in is skipped until the person acts. A server blip is not a
 * status; the model layer retries those.
 *
 * What is not secret (provider, label, status, a hint) lives in EV's store,
 * with an event for every change of status. Keys and tokens live in one
 * file, secrets/credentials.json under the data directory, readable only by
 * the person's own user. That file is never indexed, never mounted into an
 * agent's container, and never sent to the page. pi-ai reads it through the
 * CredentialStore adapter below, so its sign-in and token refresh (under a
 * lock, so a rotated token is never refreshed twice) work unchanged.
 *
 * A key in the environment is found, not stored: it shows as a connection
 * that cannot be edited, and a stored connection for the same provider wins
 * over it. A failed refresh never falls back to the environment.
 */

const APIS = { "anthropic-messages": anthropicMessagesApi, "openai-completions": openAICompletionsApi, "openai-responses": openAIResponsesApi };
// Subscription sign-ins EV does not offer: Anthropic's terms forbid using a
// Claude subscription in another app, and ChatGPT's own sign-in already
// covers what the Codex one reaches.
const NO_SIGN_IN = new Set(["anthropic", "openai-codex", "radius"]);
// EV's old name for the OpenCode key, still read.
const LEGACY_KEY = "OPENCODE_API";
const LIMIT_FALLBACK_MS = 15 * 60_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS connections (
  connection_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT,
  method TEXT NOT NULL CHECK (method IN ('key', 'oauth', 'env')),
  active INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'limited', 'needs-sign-in')),
  status_since TEXT NOT NULL,
  until TEXT,
  message TEXT,
  hint TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS connections_provider ON connections (provider);
`;

const coded = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

/** The secrets file: { connectionId: pi-ai Credential }, written whole and atomically, 0600. */
class SecretsFile {
  constructor(path) { this.path = path; this.memory = path ? null : {}; }
  readAll() {
    if (this.memory) return this.memory;
    if (!existsSync(this.path)) return {};
    ensurePrivateFileSync(this.path);
    return JSON.parse(readFileSync(this.path, "utf8"));
  }
  get(id) { return this.readAll()[id]; }
  set(id, credential) {
    const all = { ...this.readAll() };
    if (credential === undefined) delete all[id]; else all[id] = credential;
    if (this.memory) { this.memory = all; return; }
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}

const hintOf = (credential) => credential?.type === "oauth" ? (credential.email ?? credential.accountId ?? "signed in") : credential?.key ? `…${credential.key.slice(-4)}` : null;

export class Connections {
  /**
   * store: EV's store (omit for a throwaway, in-memory set, as in tests).
   * dataRoot: where secrets/ goes. env: the environment keys are found in.
   */
  constructor({ store = null, dataRoot = null, env = process.env } = {}) {
    this.store = store;
    this.env = env;
    this.rows = new Map(); // without a store
    this.listeners = new Set();
    this.locks = new Map();
    if (store) store.db.exec(SCHEMA);
    this.secrets = new SecretsFile(dataRoot ? join(ensurePrivateDirectorySync(join(dataRoot, "secrets")), "credentials.json") : null);
    this.deviceIdPath = dataRoot ? join(dataRoot, "secrets", "device-id") : null;
    const self = this;
    // pi-ai's view: one credential per provider, the one EV would use now.
    this.credentials = {
      async read(providerId) { const connection = self.serving(providerId); return connection?.method === "env" ? undefined : connection ? self.secrets.get(connection.id) : undefined; },
      async list() { return self._stored().map((connection) => ({ providerId: connection.provider, type: connection.method === "oauth" ? "oauth" : "api_key" })); },
      async modify(providerId, change) {
        return self._locked(providerId, async () => {
          const connection = self.serving(providerId);
          const stored = connection && connection.method !== "env" ? connection : null;
          const next = await change(stored ? self.secrets.get(stored.id) : undefined);
          if (next !== undefined && stored) self.secrets.set(stored.id, next);
          return next ?? (stored ? self.secrets.get(stored.id) : undefined);
        });
      },
      async delete(providerId) { const connection = self.serving(providerId); if (connection && connection.method !== "env") self.remove(connection.id); }
    };
    this.authContext = {
      env: async (name) => self._env(name),
      fileExists: async (path) => existsSync(path.startsWith("~") ? join(homedir(), path.slice(1)) : path)
    };
    this.models = builtinModels({ credentials: this.credentials, authContext: this.authContext });
    // pi-ai has no OpenCode sign-in; an OpenCode account reaches Zen and Go.
    for (const id of ["opencode", "opencode-go"]) {
      const provider = this.models.getProvider(id);
      if (provider) this.models.setProvider({ ...provider, auth: { ...provider.auth, oauth: opencodeConsoleOAuth } });
    }
    // The person's own endpoints (Ollama, LM Studio, any compatible server), each a provider of its own.
    this.ownEndpoints = new Map();
    for (const endpoint of [].concat(store?.setting("endpoints") ?? [])) this._registerEndpoint(endpoint);
    this.envSources = new Map();
    /** Settles once the environment has been looked through for keys. */
    this.scanned = this._scan();
  }

  /** Opens the connections and looks through the environment for keys. */
  static async open(options) { const connections = new Connections(options); await connections.scanned; return connections; }

  /** Which providers have a key in the environment, and where it was found (pi-ai's own lookup, per provider). */
  async _scan() {
    const signal = AbortSignal.timeout(10_000);
    await Promise.all(this.models.getProviders().map(async (provider) => {
      const auth = provider.auth.apiKey;
      // An own endpoint resolves without a key ("none"); that is not a key found in the environment.
      if (!auth || this.isOwn(provider.id)) return;
      try {
        const found = auth.check ? await auth.check({ ctx: this.authContext, signal }) : await auth.resolve({ ctx: this.authContext, signal });
        if (!found) return;
        const source = found.source === "OPENCODE_API_KEY" && !this.env.OPENCODE_API_KEY ? LEGACY_KEY : found.source ?? "environment";
        this.envSources.set(provider.id, source);
      } catch {}
    }));
  }

  _env(name) {
    const value = this.env[name];
    if (value) return value;
    return name === "OPENCODE_API_KEY" ? this.env[LEGACY_KEY] || undefined : undefined;
  }

  async _locked(key, fn) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    this.locks.set(key, run.catch(() => {}));
    return run;
  }

  // ------------------------------------------------------------- providers

  /**
   * A provider pi-ai does not know (EV_MODEL_URL with a provider/model of
   * its own) is spoken to in the shape `api`, with a stored key or EV's old
   * OPENCODE_API.
   */
  ensureProvider(id) {
    if (this.models.getProvider(id)) return;
    this.models.setProvider(Object.assign(createProvider({
      id, name: id, models: [],
      auth: { apiKey: { name: `${id} key`, resolve: async ({ credential }) => {
        const key = credential?.key ?? this._env(LEGACY_KEY);
        return key ? { auth: { apiKey: key }, source: credential?.key ? "stored" : LEGACY_KEY } : undefined;
      } } },
      api: Object.fromEntries(Object.entries(APIS).map(([api, make]) => [api, make()]))
    }), { custom: true }));
  }

  // ------------------------------------------------------- own endpoints

  /** Whether a provider is one of the person's own endpoints: already paid for (it runs on their machine or server). */
  isOwn(providerId) { return this.ownEndpoints.has(providerId); }

  endpoint(providerId) { return this.ownEndpoints.get(providerId) ?? null; }

  /**
   * Adds the person's own endpoint as a provider with one model: its address,
   * the API shape it speaks, and the model as the server names it. Its account
   * is saved separately, once a call through it has worked.
   */
  addEndpoint({ name, baseUrl, api, model }) {
    const label = String(name ?? "").trim().slice(0, 60);
    const url = String(baseUrl ?? "").trim().replace(/\/+$/, "");
    const modelId = String(model ?? "").trim().slice(0, 200);
    if (!label) throw coded("ENDPOINT_NAME_MISSING", "Give it a name", { statusCode: 400 });
    if (!/^https?:\/\/[^\s/]+/i.test(url)) throw coded("ENDPOINT_ADDRESS", "The address must start with http:// or https://", { statusCode: 400 });
    if (!APIS[api]) throw coded("ENDPOINT_API", `How it is spoken to must be one of ${Object.keys(APIS).join(", ")}`, { statusCode: 400 });
    if (!modelId) throw coded("ENDPOINT_MODEL_MISSING", "Name the model as the server names it", { statusCode: 400 });
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "endpoint";
    let id = `own-${slug}`;
    for (let n = 2; this.models.getProvider(id); n++) id = `own-${slug}-${n}`;
    const endpoint = { id, name: label, baseUrl: url, api, model: modelId };
    this._registerEndpoint(endpoint);
    this._saveEndpoints();
    return endpoint;
  }

  /** Forgets an endpoint (once its last account is removed). */
  removeEndpoint(providerId) {
    if (!this.ownEndpoints.delete(providerId)) return;
    this.models.deleteProvider(providerId);
    this._saveEndpoints();
  }

  _saveEndpoints() { this.store?.saveSetting("endpoints", [...this.ownEndpoints.values()]); }

  _registerEndpoint(endpoint) {
    if (!endpoint?.id || !APIS[endpoint.api]) return;
    this.ownEndpoints.set(endpoint.id, endpoint);
    const record = { id: endpoint.model, name: endpoint.model, provider: endpoint.id, api: endpoint.api, baseUrl: endpoint.baseUrl, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 32_000 };
    this.models.setProvider(Object.assign(createProvider({
      id: endpoint.id, name: endpoint.name, models: [record],
      // A local server often needs no key; the person may still give one.
      auth: { apiKey: { name: `${endpoint.name} key`, resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key || "none" }, source: "stored" }) } },
      api: { [endpoint.api]: APIS[endpoint.api]() }
    }), { custom: true, own: true }));
  }

  /** Every provider EV can sign in to, and how. */
  providers() {
    // The person's own endpoints are added from their own form, not chosen from this list.
    return this.models.getProviders().filter((provider) => !this.isOwn(provider.id)).map((provider) => ({
      id: provider.id,
      name: provider.name ?? provider.id,
      key: Boolean(provider.auth.apiKey),
      signIn: provider.auth.oauth && !NO_SIGN_IN.has(provider.id) ? (provider.auth.oauth.loginLabel ?? `Sign in with ${provider.auth.oauth.name}`) : null,
      connected: this.connectionsOf(provider.id).length > 0
    }));
  }

  providerName(id) { return this.models.getProvider(id)?.name ?? id; }

  /** Where in the environment this provider's key was found, if it was. */
  envKeys(providerId) {
    if (this.isOwn(providerId)) return [];
    if (this.envSources.has(providerId)) return [this.envSources.get(providerId)];
    // A provider of EV's own (EV_MODEL_URL) takes EV's old key.
    return this.models.getProvider(providerId)?.custom && this.env[LEGACY_KEY] ? [LEGACY_KEY] : [];
  }

  // ----------------------------------------------------------- connections

  _now() { return new Date().toISOString(); }

  _row(row) {
    return row && { id: row.connection_id, provider: row.provider, label: row.label, method: row.method, active: Boolean(row.active), status: row.status, since: row.status_since, until: row.until, message: row.message, hint: row.hint, createdAt: row.created_at };
  }

  _all(providerId = null) {
    if (!this.store) return [...this.rows.values()].filter((row) => !providerId || row.provider === providerId).map((row) => this._row(row));
    const rows = providerId
      ? this.store.db.prepare("SELECT * FROM connections WHERE provider = ? ORDER BY created_at, connection_id").all(providerId)
      : this.store.db.prepare("SELECT * FROM connections ORDER BY created_at, connection_id").all();
    return rows.map((row) => this._row(row));
  }

  _get(id) {
    return this._row(this.store ? this.store.db.prepare("SELECT * FROM connections WHERE connection_id = ?").get(id) : this.rows.get(id));
  }

  /** Inserts a whole row, or changes some columns of an existing one. */
  _put(row) {
    const { connection_id: id, ...fields } = row;
    if (!this.store) { this.rows.set(id, { ...this.rows.get(id), ...row }); return; }
    const columns = Object.keys(fields);
    const exists = this.store.db.prepare("SELECT 1 FROM connections WHERE connection_id = ?").get(id);
    if (exists) this.store.db.prepare(`UPDATE connections SET ${columns.map((name) => `${name} = ?`).join(", ")} WHERE connection_id = ?`).run(...columns.map((name) => fields[name]), id);
    else this.store.db.prepare(`INSERT INTO connections (connection_id, ${columns.join(", ")}) VALUES (?${", ?".repeat(columns.length)})`).run(id, ...columns.map((name) => fields[name]));
  }

  _stored(providerId = null) { return this._all(providerId).filter((connection) => connection.method !== "env"); }

  /** The row that carries an environment key's status, made when first needed. */
  _envConnection(providerId) {
    const names = this.envKeys(providerId);
    if (!names.length) return null;
    const id = `env:${providerId}`;
    if (!this._get(id)) this._put({ connection_id: id, provider: providerId, label: null, method: "env", active: 0, status: "ready", status_since: this._now(), until: null, message: null, hint: null, created_at: this._now() });
    return { ...this._get(id), source: names.join(", ") };
  }

  /** A provider's connections: the stored ones, then the one from the environment. */
  connectionsOf(providerId) {
    const env = this._envConnection(providerId);
    return [...this._stored(providerId), ...(env ? [env] : [])];
  }

  /** Every connection, for the settings screen. Never carries a secret. */
  list() {
    const providers = new Set([...this._stored().map((connection) => connection.provider), ...this.models.getProviders().map((provider) => provider.id)]);
    return [...providers].flatMap((providerId) => this.connectionsOf(providerId)).map((connection) => ({ ...connection, providerName: this.providerName(connection.provider), ...(this.isOwn(connection.provider) ? { endpoint: this.endpoint(connection.provider) } : {}) }));
  }

  /**
   * The connection EV uses for this provider now: the active stored one, else
   * the one from the environment. When that one is limited or needs a sign-in
   * and another account of the same provider is usable, that one serves
   * instead, so a second account carries on where the first ran out.
   */
  serving(providerId) {
    const stored = this._stored(providerId);
    const env = stored.length ? null : this._envConnection(providerId);
    const preferred = stored.find((connection) => connection.active) ?? stored[0] ?? env;
    if (!preferred || this.usable(preferred)) return preferred;
    return stored.find((connection) => this.usable(connection)) ?? preferred;
  }

  usable(connection, now = Date.now()) {
    return connection.status === "ready" || (connection.status === "limited" && (!connection.until || Date.parse(connection.until) <= now));
  }

  /**
   * The connection a call to this provider goes through, or an error with
   * `wait` saying what it waits for: { reason: "limited" | "needs-sign-in" |
   * "none", provider, connectionId, until, since }.
   */
  forCall(providerId, code) {
    this.ensureProvider(providerId);
    const connection = this.serving(providerId);
    const name = this.providerName(providerId);
    if (!connection) throw coded(code, `No account is connected for ${name}`, { wait: { reason: "none", provider: providerId, providerName: name, connectionId: null, until: null, since: null } });
    if (this.usable(connection)) return connection;
    const wait = { reason: connection.status, provider: providerId, providerName: name, connectionId: connection.id, label: connection.label, until: connection.status === "limited" ? connection.until : null, since: connection.since, message: connection.message };
    throw coded(code, connection.status === "limited" ? `${name} is limited until ${connection.until}` : `${name} needs a new sign-in: ${connection.message ?? ""}`, { wait });
  }

  _setStatus(connection, { status, until = null, message = null }) {
    const current = this._get(connection.id);
    if (!current) return null;
    const changed = current.status !== status;
    const since = changed ? this._now() : current.since;
    const write = () => {
      this._put({ connection_id: current.id, status, status_since: since, until, message });
      if (changed && this.store) this.store.event({ type: "connection", data: { connectionId: current.id, provider: current.provider, status, until, message } });
    };
    if (this.store) this.store.tx(write); else write();
    if (changed) this._changed();
    return this._get(current.id);
  }

  /** The provider said this account's usage is used up. `retryAfterMs` comes from its answer, when it gave one. */
  limited(connection, retryAfterMs = null) {
    return this._setStatus(connection, { status: "limited", until: new Date(Date.now() + (retryAfterMs || LIMIT_FALLBACK_MS)).toISOString(), message: "Usage limit reached" });
  }

  /** The provider stopped accepting this account's key or token. */
  needsSignIn(connection, message) {
    return this._setStatus(connection, { status: "needs-sign-in", until: null, message: String(message ?? "The provider refused the key").slice(0, 300) });
  }

  /** A call through this account worked. */
  ready(connection) {
    if (connection.status === "ready") return connection;
    return this._setStatus(connection, { status: "ready" });
  }

  /** Saves a stored connection and makes it the provider's active one. */
  save({ provider, method, credential, label = null }) {
    const id = `conn_${randomUUID().slice(0, 8)}`;
    this.secrets.set(id, credential);
    const write = () => {
      for (const other of this._stored(provider)) this._put({ connection_id: other.id, active: 0 });
      this._put({ connection_id: id, provider, label, method, active: 1, status: "ready", status_since: this._now(), until: null, message: null, hint: hintOf(credential), created_at: this._now() });
      if (this.store) this.store.event({ type: "connection", data: { connectionId: id, provider, status: "added", method } });
    };
    if (this.store) this.store.tx(write); else write();
    this._changed();
    return this._get(id);
  }

  remove(id) {
    const connection = this._get(id);
    if (!connection) throw coded("CONNECTION_NOT_FOUND", `Unknown connection: ${id}`);
    if (connection.method === "env") throw coded("CONNECTION_FROM_ENVIRONMENT", `This account comes from ${this.envKeys(connection.provider).join(", ") || "the environment"}; change it there`);
    const write = () => {
      this.store?.db.prepare("DELETE FROM connections WHERE connection_id = ?").run(id);
      this.rows.delete(id);
      const [next] = this._stored(connection.provider);
      if (connection.active && next) this._put({ connection_id: next.id, active: 1 });
      this.store?.event({ type: "connection", data: { connectionId: id, provider: connection.provider, status: "removed" } });
    };
    if (this.store) this.store.tx(write); else write();
    this.secrets.set(id, undefined);
    if (this.isOwn(connection.provider) && !this._stored(connection.provider).length) this.removeEndpoint(connection.provider);
    this._changed();
  }

  update(id, { active, label }) {
    const connection = this._get(id);
    if (!connection) throw coded("CONNECTION_NOT_FOUND", `Unknown connection: ${id}`);
    if (connection.method === "env") throw coded("CONNECTION_FROM_ENVIRONMENT", "An account from the environment is changed there");
    const write = () => {
      if (active) for (const other of this._stored(connection.provider)) this._put({ connection_id: other.id, active: other.id === id ? 1 : 0 });
      if (typeof label === "string") this._put({ connection_id: id, label: label.trim().slice(0, 80) || null });
    };
    if (this.store) this.store.tx(write); else write();
    this._changed();
    return this._get(id);
  }

  /** A stable id for this installation, which some sign-ins (ChatGPT) require. */
  deviceId() {
    if (!this.deviceIdPath) return (this._deviceId ??= randomUUID());
    if (!existsSync(this.deviceIdPath)) writeFileSync(this.deviceIdPath, randomUUID(), { mode: 0o600 });
    return readFileSync(this.deviceIdPath, "utf8").trim();
  }

  /** Called whenever a connection is added, removed or changes status, so waiting work can go on. */
  onChange(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  _changed() { for (const listener of this.listeners) { try { listener(); } catch {} } }
}

/** A Retry-After header as milliseconds: seconds, or an HTTP date. */
export function retryAfterMs(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? 0 : Math.max(0, at - Date.now());
}
