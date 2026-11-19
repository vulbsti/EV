/**
 * Which account serves a model: the half of the router that is facts.
 *
 * EV decides which model suits a piece of work (that is meaning). This file
 * decides how to reach it, which is a calculation: the same model is often
 * served by several providers the person is connected to (Haiku 5.5 through
 * OpenCode Go and through OpenRouter, say), and each provider can hold
 * several accounts. A route is one provider's record of the model, reached
 * through that provider's account.
 *
 * Routes are ranked in code:
 *   1. Usable before not: a limited account is skipped until its reset, one
 *      that needs a new sign-in until the person acts.
 *   2. Subscription quota before paying per token, because quota that is not
 *      used is wasted. A route counts as a subscription when it was signed in
 *      to (OAuth) or its provider sells a plan rather than tokens.
 *   3. Then speed for the price: the measured time per thousand output
 *      tokens on this person's own recent calls, times the catalogue price.
 *      A route with no calls yet takes the middle of the known ones, so it
 *      is neither favoured nor shut out.
 *   4. Ties keep the provider that was asked for, then the catalogue's order.
 *
 * The ranking chooses a route when a piece of work (or one turn of EV's)
 * starts, and that route is kept while its account stays usable: moving a
 * task to another provider because a measured median shifted would throw
 * away the provider's prompt cache. Speed for the price decides the next
 * task's route, not the next request's.
 *
 * When the subscription that would have served is limited, moving to a
 * route that is paid per token is not taken here: whether to spend money or
 * wait for the reset is the limit decision (GitHub issue 21), so until that
 * is built the work waits. Another subscription, or another account, is
 * taken at once.
 *
 * Every model call, EV's own and agents' through the relay, leaves one row in
 * model_calls: which route, how it ended, how long it took, tokens and cost
 * where known. That record is what the speed comes from, and later the
 * evidence the router learns from. It holds no text of the call.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS model_calls (
  call_id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  role TEXT NOT NULL,
  work_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  connection_id TEXT,
  outcome TEXT NOT NULL,
  status INTEGER,
  ms INTEGER,
  first_byte_ms INTEGER,
  input INTEGER,
  output INTEGER,
  cached INTEGER,
  cost_usd REAL
);
CREATE INDEX IF NOT EXISTS model_calls_route ON model_calls (provider, model, call_id);
CREATE INDEX IF NOT EXISTS model_calls_work ON model_calls (work_id);
`;

// Providers that sell a plan with a usage window rather than tokens, even when signed in to with a key.
export const PLAN_PROVIDERS = new Set([
  "opencode-go", "github-copilot", "openai-codex", "kimi-coding", "zai-coding-cn",
  "qwen-token-plan", "qwen-token-plan-cn", "qwen-token-plan-individual", "qwen-token-plan-individual-cn",
  "xiaomi-token-plan-ams", "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp"
]);
// How many tasks and turns keep their route at once; the oldest is let go first.
const STICKY_MAX = 1_000;
// How many recent calls of a route its speed is measured over.
const SPEED_WINDOW = 30;
// Output tokens weigh this much less than input in the price: agents' calls are mostly prompt.
const INPUT_SHARE = 0.75;

/** One name for a model across providers: "openai/gpt-6-luna" and "gpt-6-luna", "claude-haiku-5.5" and "claude-haiku-5-5". */
export const modelKey = (id) => String(id ?? "").split("/").at(-1).toLowerCase().replace(/\./g, "-");

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const routeKey = (route) => `${route.model.provider}/${route.model.id}/${route.connection.id}`;
const price = (model) => (model.cost?.input ?? 0) * INPUT_SHARE + (model.cost?.output ?? 0) * (1 - INPUT_SHARE);

export class ModelRoutes {
  constructor({ connections }) {
    this.connections = connections;
    this.store = connections.store;
    this.memoryCalls = []; // without a store
    this.sticky = new Map(); // task or turn -> the route key it is on
    if (this.store) this.store.db.exec(SCHEMA);
  }

  // ------------------------------------------------------------ the record

  /** Saves one model call. Never throws: a call is not failed by its record. */
  record({ role, workId = null, model, connectionId = null, outcome, status = null, ms = null, firstByteMs = null, tokens = null }) {
    try {
      const cost = tokens && model.cost ? ((tokens.input - (tokens.cached ?? 0)) * (model.cost.input ?? 0) + (tokens.cached ?? 0) * (model.cost.cacheRead ?? 0) + tokens.output * (model.cost.output ?? 0)) / 1e6 : null;
      const row = { at: new Date().toISOString(), role: String(role ?? "unknown"), work_id: workId, provider: model.provider, model: model.id, connection_id: connectionId, outcome, status, ms, first_byte_ms: firstByteMs, input: tokens?.input ?? null, output: tokens?.output ?? null, cached: tokens?.cached ?? null, cost_usd: cost };
      if (!this.store) { this.memoryCalls.push({ call_id: this.memoryCalls.length + 1, ...row }); return; }
      const columns = Object.keys(row);
      this.store.db.prepare(`INSERT INTO model_calls (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...columns.map((name) => row[name]));
    } catch { /* the record is never worth a failed call */ }
  }

  /** Recent calls, newest first: of one route, of one piece of work, or all. */
  calls({ provider = null, model = null, workId = null, limit = 50 } = {}) {
    if (!this.store) {
      return this.memoryCalls.filter((row) => (!provider || row.provider === provider) && (!model || row.model === model) && (!workId || row.work_id === workId)).slice(-limit).reverse();
    }
    const where = [], args = [];
    if (provider) { where.push("provider = ?"); args.push(provider); }
    if (model) { where.push("model = ?"); args.push(model); }
    if (workId) { where.push("work_id = ?"); args.push(workId); }
    return this.store.db.prepare(`SELECT * FROM model_calls ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY call_id DESC LIMIT ?`).all(...args, limit);
  }

  /**
   * How fast a route has been on this person's recent calls: { msPerKToken,
   * firstByteMs, calls }. msPerKToken comes from EV's own calls, which know
   * their tokens; firstByteMs from every call, agents' too.
   */
  speed(provider, modelId) {
    const recent = this.calls({ provider, model: modelId, limit: SPEED_WINDOW }).filter((row) => row.outcome === "ok");
    const perK = recent.filter((row) => row.output > 0 && row.ms > 0).map((row) => (row.ms - (row.first_byte_ms ?? 0)) / row.output * 1000);
    return { msPerKToken: median(perK), firstByteMs: median(recent.map((row) => row.first_byte_ms).filter((value) => value > 0)), calls: recent.length };
  }

  // ------------------------------------------------------------ the routes

  /**
   * Every route to `model` through an account the person has: the record
   * asked for first (it may carry its own base URL), then the same model at
   * every other connected provider. `sameApi` keeps only routes spoken to in
   * the same API shape, for agents, whose requests the relay passes through
   * untranslated.
   */
  routes(model, { sameApi = false } = {}) {
    const key = modelKey(model.id);
    const found = [model];
    for (const provider of this.connections.models.getProviders()) {
      if (provider.id === model.provider || !this.connections.connectionsOf(provider.id).length) continue;
      for (const other of this.connections.models.getModels(provider.id)) {
        if (modelKey(other.id) === key && (!sameApi || other.api === model.api)) found.push(other);
      }
    }
    return found.map((record) => {
      const connection = this.connections.serving(record.provider);
      return connection && { model: record, connection, subscription: connection.method === "oauth" || PLAN_PROVIDERS.has(record.provider) };
    }).filter(Boolean);
  }

  /** Routes in the order they would be used. Each carries `usable` and `rank` (lower is better). */
  ranked(model, options = {}) {
    const routes = this.routes(model, options).map((route) => ({ ...route, usable: this.connections.usable(route.connection), speed: this.speed(route.model.provider, route.model.id) }));
    const known = median(routes.map((route) => route.speed.msPerKToken).filter((value) => value != null)) ?? 1;
    for (const route of routes) {
      const time = route.speed.msPerKToken ?? known;
      route.rank = route.subscription ? time : time * (1 + price(route.model));
    }
    return routes.map((route, index) => ({ route, index })).sort((a, b) =>
      (b.route.usable - a.route.usable) || (b.route.subscription - a.route.subscription) || (a.route.rank - b.route.rank) || (a.index - b.index)
    ).map(({ route }) => route);
  }

  /**
   * The route a call to `model` goes through now, or the error the caller
   * throws, with `wait` saying what it waits for (the account that frees up
   * soonest). With `stick` (a task's or a turn's id), the route chosen the
   * first time is kept for as long as its account is usable.
   */
  pick(model, code, { stick = null, ...options } = {}) {
    this.connections.ensureProvider(model.provider);
    if (stick && this.sticky.has(stick)) {
      const kept = this.routes(model, options).find((route) => routeKey(route) === this.sticky.get(stick));
      if (kept && this.connections.usable(kept.connection)) return kept;
    }
    const chosen = this._choose(model, code, options);
    if (stick) {
      this.sticky.delete(stick);
      this.sticky.set(stick, routeKey(chosen));
      if (this.sticky.size > STICKY_MAX) this.sticky.delete(this.sticky.keys().next().value);
    }
    return chosen;
  }

  /** Lets a finished task's route go. */
  unstick(stick) { this.sticky.delete(stick); }

  _choose(model, code, options) {
    const ranked = this.ranked(model, options);
    const best = ranked[0];
    const paidInstead = best && !best.subscription && ranked.some((route) => route.subscription && !route.usable);
    if (best?.usable && !paidInstead) return best;
    const waits = [];
    for (const provider of new Set([model.provider, ...this.routes(model, options).map((route) => route.model.provider)])) {
      try { this.connections.forCall(provider, code); } catch (error) { waits.push(error); }
    }
    const resets = (error) => error.wait?.until ? Date.parse(error.wait.until) : Number.POSITIVE_INFINITY;
    throw waits.sort((a, b) => resets(a) - resets(b))[0] ?? Object.assign(new Error(`${model.provider}/${model.id} cannot be reached`), { code });
  }
}
