import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { modelFor, modelSettings } from "./ev-model.mjs";
import { PLAN_PROVIDERS, modelKey } from "./model-routes.mjs";
import { workerModel } from "./openclaw-worker-adapter.mjs";

/**
 * The model guide: what EV reads when it chooses the model for a piece of
 * work. This is the half of the router that is judgement; which account
 * reaches the chosen model is code (model-routes.mjs).
 *
 * The guide covers the models the person can reach. For each it gives what
 * the catalogue says (price, context), how fast it has been for them, the
 * central atlas's claims (knowledge/models/, shipped with KenWise), each
 * marked with how it is known, and what the person's own work and words
 * show (model-learning.mjs: seen, relied on, said). Where the person's own
 * evidence and the atlas disagree, theirs wins for them; the guide shows both
 * and EV weighs them. Models in their subscriptions that nothing is known
 * about are named in one line, so EV can still try them.
 *
 * EV names a first and a second choice with one line of reason each
 * (start_work's `model`). The choice and its reasons are saved with the
 * work. The agent runs on the first choice while a route to it is usable,
 * else on the second. The reviewer uses its own model, or the work's other
 * choice when its own is the one that did the work: a second opinion catches
 * more than a model grading itself.
 */

export const ATLAS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../knowledge/models");
const CLAIM = /^-\s+(.+?)\s*\[(reported|tested|dropped|past)(?::\s*([^\]]*))?\]\s*$/;
const STATES = { reported: "reported, not checked", tested: "tested centrally" };
const PERSONAL = { said: "the person said so", seen: "seen in their own work, few cases", relied_on: "relied on: holds across weeks of their work" };

/** The atlas: one entry per file, { name, keys, updated, claims: [{ text, state, source }] }. */
export function loadAtlas(dir = ATLAS_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((file) => file.endsWith(".md") && file !== "README.md").flatMap((file) => {
    const text = readFileSync(join(dir, file), "utf8");
    const head = /^---\n([\s\S]*?)\n---\n?/.exec(text);
    if (!head) return [];
    const field = (name) => new RegExp(`^${name}:\\s*(.+)$`, "m").exec(head[1])?.[1].trim() ?? null;
    const keys = (field("models") ?? file.replace(/\.md$/, "")).split(",").map((key) => modelKey(key.trim())).filter(Boolean);
    const claims = text.slice(head[0].length).split("\n").map((line) => CLAIM.exec(line.trim())).filter(Boolean).map(([, claim, state, source]) => ({ text: claim, state, source: source?.trim() ?? null }));
    return [{ file, name: field("name") ?? keys[0], keys, updated: field("updated"), claims }];
  });
}

const money = (value) => value >= 1 ? `$${value.toFixed(value % 1 ? 2 : 0)}` : `$${Number(value.toFixed(3))}`;

export class ModelGuide {
  constructor({ routes, store = routes.store, atlas = loadAtlas(), env = process.env }) {
    this.routes = routes;
    this.connections = routes.connections;
    this.store = store;
    this.atlas = atlas;
    this.env = env;
  }

  /** The default model for agents, as a record, or null when it cannot be named. */
  _default() { try { return workerModel(); } catch { return null; } }

  /** Whether this provider's account is a subscription (quota already paid for), not pay per token. */
  _plan(providerId) { return PLAN_PROVIDERS.has(providerId) || this.connections.serving(providerId)?.method === "oauth"; }

  /**
   * A catalogue record for one of these model keys at a provider the person
   * is connected to: a subscription first, then the default's provider, then
   * the cheapest.
   */
  _reachable(keys, prefer = null) {
    const wanted = new Set([].concat(keys));
    const found = this.connections.models.getProviders()
      .filter((provider) => this.connections.connectionsOf(provider.id).length)
      .flatMap((provider) => this.connections.models.getModels(provider.id).filter((model) => wanted.has(modelKey(model.id))));
    const price = (model) => (model.cost?.input ?? 0) + (model.cost?.output ?? 0);
    return found.sort((a, b) => (this._plan(b.provider) - this._plan(a.provider)) || ((b.provider === prefer) - (a.provider === prefer)) || (price(a) - price(b)))[0] ?? null;
  }

  /**
   * Which models EV may choose from. EV_MODELS (a comma list, such as
   * "claude-haiku-5-5, muse-spark-1-3-contributor") keeps EV to those; a
   * model the person switched off (setting models_off) is never offered. A
   * model left out is not shown to EV and cannot be named.
   */
  allowed(record) {
    const key = modelKey(record.id);
    const only = String(this.env.EV_MODELS ?? "").split(",").map((name) => modelKey(name.trim())).filter(Boolean);
    if (only.length && !only.includes(key)) return false;
    return !this.off().includes(key);
  }

  /** Models the person switched off, by key. */
  off() { return [].concat(this.store?.setting?.("models_off") ?? []); }

  /** Switches a model off ("don't use this model") or back on. */
  setOff(name, off) {
    const key = modelKey(name);
    if (!key) throw Object.assign(new Error("Name the model"), { statusCode: 400, code: "MODEL_MISSING" });
    const next = this.off().filter((item) => item !== key);
    if (off) next.push(key);
    this.store.saveSetting("models_off", next);
    return { off: next };
  }

  /**
   * Every model the person can reach that the guide knows something about:
   * the atlas's models, the default model, and any model their own work or
   * notes speak of. { key, name, spec, record, claims (atlas), personal,
   * speed }.
   */
  entries() {
    const fallback = this._default();
    const seen = new Set();
    const out = [];
    const add = (record, entry) => {
      const key = modelKey(record.id);
      if (seen.has(key) || !this.allowed(record)) return;
      seen.add(key);
      out.push({
        key, name: entry?.name ?? record.name ?? record.id, spec: `${record.provider}/${record.id}`, record, subscription: this._plan(record.provider),
        claims: entry?.claims.filter((claim) => claim.state !== "dropped") ?? [], atlasUpdated: entry?.updated ?? null,
        personal: this.personal?.claims(key) ?? [], speed: this.routes.speed(record.provider, record.id)
      });
    };
    if (fallback && this.routes.routes(fallback).length) add(fallback, this.atlas.find((entry) => entry.keys.includes(modelKey(fallback.id))));
    for (const entry of this.atlas) {
      const record = this._reachable(entry.keys, fallback?.provider);
      if (record) add(record, entry);
    }
    for (const key of new Set((this.personal?.claims() ?? []).map((claim) => claim.model).filter(Boolean))) {
      const record = this._reachable([key], fallback?.provider);
      if (record) add(record, null);
    }
    return out;
  }

  /** Models inside the person's subscriptions that the guide knows nothing about yet: { key, spec, name }. */
  unknown() {
    const listed = new Set(this.entries().map((entry) => entry.key));
    const found = new Map();
    for (const provider of this.connections.models.getProviders()) {
      if (!this.connections.connectionsOf(provider.id).length || !this._plan(provider.id)) continue;
      for (const record of this.connections.models.getModels(provider.id)) {
        const key = modelKey(record.id);
        if (!listed.has(key) && !found.has(key) && this.allowed(record)) found.set(key, { key, spec: `${record.provider}/${record.id}`, name: record.name ?? record.id });
      }
    }
    return [...found.values()];
  }

  /** The guide as EV reads it: a few lines per model. */
  text() {
    const entries = this.entries();
    if (!entries.length) return "";
    const general = (this.personal?.claims(null) ?? []).map((claim) => `- ${claim.text} (${PERSONAL[claim.state]})`);
    const models = entries.map((entry) => {
      const cost = entry.subscription
        ? `within the person's ${this.connections.providerName(entry.record.provider)} subscription (quota already paid for)`
        : entry.record.cost ? `${money(entry.record.cost.input)} in / ${money(entry.record.cost.output)} out per million tokens` : "price unknown";
      const context = entry.record.contextWindow ? `, reads up to ${Math.round(entry.record.contextWindow / 1000)}k tokens` : "";
      const lines = [`${entry.name} (name it as ${entry.spec}): ${cost}${context}.`];
      for (const claim of entry.personal) lines.push(`  - ${claim.text} (${PERSONAL[claim.state]})`);
      for (const claim of entry.claims) lines.push(`  - ${claim.text} (atlas, ${STATES[claim.state] ?? claim.state})`);
      if (!entry.claims.length && !entry.personal.length) lines.push("  - Nothing known about it yet.");
      else if (!entry.personal.length) lines.push("  - Nothing from this person's own work yet.");
      return lines.join("\n");
    });
    const unknown = this.unknown();
    return [
      ...(general.length ? [`What this person has said or shown about choosing models:\n${general.join("\n")}`] : []),
      ...models,
      ...(unknown.length ? [`Also within their subscriptions, with nothing known yet: ${unknown.map((item) => item.spec).join(", ")}.`] : [])
    ].join("\n");
  }

  /** A model EV named: "provider/id", an id, or a name from the guide. The record, or null when the person cannot reach it or it is not allowed. */
  resolve(name) {
    const wanted = String(name ?? "").trim();
    if (!wanted) return null;
    const entry = this.entries().find((candidate) => candidate.spec === wanted || candidate.key === modelKey(wanted) || candidate.name.toLowerCase() === wanted.toLowerCase());
    if (entry) return entry.record;
    let record = null;
    if (wanted.includes("/")) {
      try { const named = modelSettings(this.env, wanted); if (this.routes.routes(named).length) record = named; } catch {}
    }
    record ??= this._reachable([modelKey(wanted)], this._default()?.provider);
    return record && this.allowed(record) ? record : null;
  }

  // -------------------------------------------------------- for the work

  /** EV's choice saved with a piece of work, or null. */
  choice(task) { return task?.input?.metadata?.model ?? null; }

  /** The model a piece of work's agent runs on: EV's first choice while a route to it is usable, else its second. */
  forWork(task) {
    const choice = this.choice(task);
    const records = [choice?.first, choice?.second].filter(Boolean).flatMap((pick) => { try { return [modelSettings(this.env, pick.spec)]; } catch { return []; } });
    for (const record of records) {
      try { this.routes.pick(record, "AGENT_MODEL_UNAVAILABLE", { sameApi: true }); return record; } catch {}
    }
    return records[0] ?? this._default() ?? workerModel();
  }

  /** The reviewer's model: its own, unless that is the one that did the work and EV named another. Null means its own. */
  forReview(task, worked) {
    const own = modelFor("quality-gate", this.env);
    if (!worked || modelKey(own) !== modelKey(worked.id)) return null;
    const choice = this.choice(task);
    const other = [choice?.first, choice?.second].find((pick) => pick && modelKey(pick.spec) !== modelKey(worked.id));
    return other?.spec ?? null;
  }
}

