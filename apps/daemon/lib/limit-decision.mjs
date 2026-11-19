import { callModel, parseModelJson, sessionHeader } from "./ev-model.mjs";
import { clock } from "./local-time.mjs";

/**
 * When a subscription runs out: switch to a route paid per token, or wait for
 * the reset (GitHub issue 21).
 *
 * The facts are code: when the limited account is usable again (a reset
 * time, or not until the person signs in again), what the paid route costs,
 * how much this piece of work has used so far, and what has been spent on
 * paid routes this month against the person's cap. Whether it is worth paying
 * is meaning (is the person waiting on this, is it background work, is the
 * reset near), so with the default setting a model weighs it, once per piece
 * of work and limit, and says why.
 *
 * The person's setting (limit_choice):
 *   decide  (default) the model weighs the facts above
 *   wait    prefer waiting for the subscription (a subscription that needs a
 *           new sign-in does not come back by itself, so that is not waited on)
 *   switch  always switch, within the cap
 *   ask     never switch until the person says so (POST /setup/limit/allow)
 * A monthly cap on paid spend (monthly_cap_usd) is never crossed without the
 * person saying so, whatever the setting. A switch is told once, with what it
 * costs; a wait is told once by the inbox, with when it resumes.
 */

export const LIMIT_CHOICES = ["decide", "wait", "switch", "ask"];
const DECISION_MAX = 500;
// The weighing's own model call. It happens exactly when a subscription has run
// out, often the one that serves EV, so it may itself use a paid route: a few
// hundred tokens, within the cap like any other paid call, and not told as a switch.
export const WEIGHING = "limit-decision";

const INSTRUCTIONS = `One of the person's subscriptions has hit its usage limit in the middle of something. You decide whether to carry on now through a route that is paid per token, or wait for the subscription.

Weigh what it costs against what waiting costs the person. Someone waiting on an answer, a reset hours away and a cheap option point to switching. Background work, a reset that is near, or an expensive option for a large job point to waiting. A subscription that needs a new sign-in only comes back when the person acts, so waiting may last until they next look. Spending their money is theirs to allow: when in doubt about a large spend, wait.

Answer with one JSON object: {"choice": "switch" or "wait", "why": "one sentence for the person"}.`;

const clip = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const money = (value) => `$${Number(value ?? 0).toFixed(value >= 1 ? 2 : 3)}`;

export class LimitDecision {
  constructor({ store, routes, call = callModel, onSwitch = null, now = () => Date.now(), log = console.error }) {
    this.store = store;
    this.routes = routes;
    this.connections = routes.connections;
    this.call = call;
    this.onSwitch = onSwitch;
    this.now = now;
    this.log = log;
    this.decisions = new Map(); // subject|connection id|since -> { choice, why }
    this.pending = new Map();
    routes.decider = this;
  }

  // -------------------------------------------------------------- setting

  setting() {
    const saved = this.store.setting("limit") ?? {};
    return { choice: LIMIT_CHOICES.includes(saved.choice) ? saved.choice : "decide", monthlyCapUsd: Number(saved.monthlyCapUsd) > 0 ? Number(saved.monthlyCapUsd) : null, allowed: saved.allowed ?? null };
  }

  save({ choice, monthlyCapUsd }) {
    const current = this.setting();
    const next = { ...current, ...(LIMIT_CHOICES.includes(choice) ? { choice } : {}), ...(monthlyCapUsd !== undefined ? { monthlyCapUsd: Number(monthlyCapUsd) > 0 ? Number(monthlyCapUsd) : null } : {}) };
    if (choice !== undefined && !LIMIT_CHOICES.includes(choice)) throw Object.assign(new Error(`choice must be one of ${LIMIT_CHOICES.join(", ")}`), { statusCode: 400, code: "INVALID_LIMIT_CHOICE" });
    this.store.saveSetting("limit", next);
    return this.view();
  }

  /** The person says paid routes may be used, for now: until every account limited at this moment is usable again. */
  allow() {
    const out = this.connections.list().filter((connection) => !this.connections.usable(connection)).map((connection) => connection.id);
    this.store.saveSetting("limit", { ...this.setting(), allowed: { at: new Date(this.now()).toISOString(), connections: out } });
    this.connections._changed();
    return this.view();
  }

  _allowedFor(connectionId) {
    const allowed = this.setting().allowed;
    return Boolean(allowed?.connections?.includes(connectionId));
  }

  /** Whether the person's say-so is still in force: some account it was given for is still out of use. */
  allowedNow() {
    const allowed = this.setting().allowed;
    if (!allowed?.connections?.length) return false;
    return this.connections.list().some((connection) => allowed.connections.includes(connection.id) && !this.connections.usable(connection));
  }

  /** Paid spend this calendar month (UTC), from the record of model calls. */
  spentThisMonth() {
    const start = new Date(this.now());
    const month = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1)).toISOString();
    const rows = this.routes.store ? this.routes.store.db.prepare("SELECT provider, connection_id, SUM(cost_usd) AS cost FROM model_calls WHERE at >= ? AND cost_usd > 0 GROUP BY provider, connection_id").all(month) : [];
    return rows.filter((row) => !this.routes.isSubscription(row.provider, row.connection_id)).reduce((sum, row) => sum + row.cost, 0);
  }

  /** Whether the cap allows paying more now. */
  underCap() {
    const { monthlyCapUsd } = this.setting();
    return monthlyCapUsd === null || this.spentThisMonth() < monthlyCapUsd;
  }

  view() {
    const { choice, monthlyCapUsd, allowed } = this.setting();
    // Accounts out of use now: what a say-so (allow) would be for.
    const outNow = this.connections.list().filter((connection) => !this.connections.usable(connection)).map((connection) => this.connections.providerName(connection.provider));
    return { choice, monthlyCapUsd, spentThisMonthUsd: Number(this.spentThisMonth().toFixed(4)), allowed, allowedNow: this.allowedNow(), outNow };
  }

  // ------------------------------------------------------------ deciding

  _key(subject, limited) { return `${subject}|${limited.id}|${limited.since}`; }

  /**
   * Called by the routes, synchronously: may this subject move from the
   * limited subscription to this paid route now? Only a decision already made
   * (or the person's allowance) says yes; `decide` makes one.
   */
  allows(subject, limited, paid) {
    if (this._allowedFor(limited.id)) return true;
    if (!this.underCap()) return false;
    if (subject === `role:${WEIGHING}`) return true;
    const { choice } = this.setting();
    if (choice === "switch") return true;
    if (choice === "ask") return false;
    if (choice === "wait") return limited.status === "needs-sign-in";
    return this.decisions.get(this._key(subject, limited))?.choice === "switch";
  }

  /** Whether `decide` has something to weigh for this subject and limit. */
  open(subject, limited) {
    return this.setting().choice === "decide" && this.underCap() && !this.decisions.has(this._key(subject, limited));
  }

  /**
   * Weighs switching against waiting for one subject ("turn:<conversation>",
   * "work:<id>", or a background role) and one limit. Resolves to
   * { choice, why }. A failed weighing waits: nothing is spent unasked.
   */
  async decide({ subject, limited, paid, personWaiting = false, title = null, conversationId = null }) {
    const key = this._key(subject, limited);
    if (this.decisions.has(key)) return this.decisions.get(key);
    if (this.pending.has(key)) return this.pending.get(key);
    const work = subject.startsWith("work:") ? this._work(subject.slice(5)) : null;
    const facts = {
      what: personWaiting ? "The person sent a message and is waiting for the reply." : work ? `A piece of work: "${work.title}", started ${work.startedAt}; the person ${work.told ? `has said something about it ${work.told} time(s) since` : "has not asked about it since"}.` : `Background upkeep (${title ?? subject}); nobody is waiting on it.`,
      limited: { account: `${this.connections.providerName(limited.provider)}${limited.label ? ` (${limited.label})` : ""}`, usableAgain: limited.status === "limited" ? limited.until : "only after the person signs in again" },
      paidOption: { provider: this.connections.providerName(paid.model.provider), model: paid.model.id, perMillionTokens: { input: paid.model.cost?.input ?? null, output: paid.model.cost?.output ?? null } },
      tokensUsedSoFar: work?.tokens ?? null,
      paidSpendThisMonthUsd: Number(this.spentThisMonth().toFixed(4)),
      monthlyCapUsd: this.setting().monthlyCapUsd,
      now: new Date(this.now()).toISOString()
    };
    const ask = (spec) => this.call({
      input: `${INSTRUCTIONS}\n\nFacts (data):\n${JSON.stringify(facts)}`, label: WEIGHING, code: "LIMIT_DECISION_UNAVAILABLE", spec,
      session: sessionHeader(`limit:${key}`), noSwitch: true, parse: (raw) => parseModelJson(raw, "The limit decision did not answer with JSON")
    });
    // EV's own model first; when it has no usable route at all, the paid option's model weighs it.
    const run = ask(null).catch((error) => { if (!error.wait) throw error; return ask(`${paid.model.provider}/${paid.model.id}`); }).then((answer) => ({ choice: answer.choice === "switch" ? "switch" : "wait", why: clip(answer.why, 300) || null }))
      .catch((error) => { this.log(`Could not weigh switching against waiting: ${error.message}`); return { choice: "wait", why: "I could not weigh it, so I am not spending anything without you." }; })
      .then((decision) => {
        this.pending.delete(key);
        this.decisions.set(key, decision);
        if (this.decisions.size > DECISION_MAX) this.decisions.delete(this.decisions.keys().next().value);
        // What was decided shows as a line on the work, not as a state of it.
        const at = new Date(this.now()).toISOString();
        const label = decision.choice === "switch"
          ? `Carrying on through ${this.connections.providerName(paid.model.provider)}, paid per token, while ${this.connections.providerName(limited.provider)} is out of use${decision.why ? `: ${decision.why}` : ""}`
          : `Waiting for ${this.connections.providerName(limited.provider)} rather than paying for ${this.connections.providerName(paid.model.provider)}${decision.why ? `: ${decision.why}` : ""}`;
        this.store.tx(() => this.store.event(work
          ? { type: "step", workId: subject.slice(5), data: { id: `limit:${at}`, kind: "route", label: clip(label, 300), startedAt: at, endedAt: at } }
          : { type: "limit_decision", conversationId, data: { subject, connectionId: limited.id, ...decision, paid: `${paid.model.provider}/${paid.model.id}` } }));
        return decision;
      });
    this.pending.set(key, run);
    return run;
  }

  /** Tells the person once that work moved to a paid route, and why. */
  switched({ subject, limited, paid, conversationId = null }) {
    const decision = this.decisions.get(this._key(subject, limited));
    const work = subject.startsWith("work:") ? this._work(subject.slice(5)) : null;
    const until = limited.status === "limited" ? `until about ${clock(limited.until, this.now())}` : "until it is signed in again";
    const what = work ? `"${work.title}" carries` : "my replies carry";
    const content = `My ${this.connections.providerName(limited.provider)} account is out of use ${until}, so ${what} on through ${this.connections.providerName(paid.model.provider)}, paid per token (${money(paid.model.cost?.input)} in / ${money(paid.model.cost?.output)} out per million; ${money(this.spentThisMonth())} spent this month${this.setting().monthlyCapUsd ? ` of your ${money(this.setting().monthlyCapUsd)} cap` : ""}).${decision?.why ? ` ${decision.why}` : ""}`;
    try { this.onSwitch?.({ conversationId: conversationId ?? work?.conversationId ?? "default", key: `switch:${this._key(subject, limited)}`, content }); } catch {}
  }

  _work(workId) {
    const row = this.store.db.prepare("SELECT input_json, created_at, conversation_id FROM work WHERE work_id = ?").get(workId);
    if (!row) return null;
    let metadata = {};
    try { metadata = JSON.parse(row.input_json)?.metadata ?? {}; } catch {}
    const told = this.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = 'instruction'").get(workId).n;
    const tokens = this.routes.store?.db.prepare("SELECT SUM(COALESCE(input, 0) + COALESCE(output, 0)) AS n FROM model_calls WHERE work_id = ?").get(workId).n ?? null;
    return { title: clip(metadata.title, 140) || "untitled", startedAt: row.created_at, told, tokens, conversationId: metadata.conversationId ?? row.conversation_id ?? "default" };
  }
}
