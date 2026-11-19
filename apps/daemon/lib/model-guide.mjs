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
 * marked with how it is known, and what the person's own finished work
 * shows. Where the person's own evidence and the atlas disagree, theirs wins
 * for them; the guide shows both and EV weighs them.
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
   * Every model the person can reach that the guide knows something about:
   * the atlas's models, and the default model even when the atlas is silent
   * on it. { key, name, spec, record, claims, yours, speed }.
   */
  entries() {
    const fallback = this._default();
    const evidence = this.evidence();
    const seen = new Set();
    const out = [];
    const add = (record, entry) => {
      const key = modelKey(record.id);
      if (seen.has(key)) return;
      seen.add(key);
      const speed = this.routes.speed(record.provider, record.id);
      out.push({ key, name: entry?.name ?? record.name ?? record.id, spec: `${record.provider}/${record.id}`, record, claims: entry?.claims.filter((claim) => claim.state !== "dropped") ?? [], atlasUpdated: entry?.updated ?? null, yours: evidence.get(key) ?? null, speed });
    };
    if (fallback && this.routes.routes(fallback).length) add(fallback, this.atlas.find((entry) => entry.keys.includes(modelKey(fallback.id))));
    for (const entry of this.atlas) {
      const record = this._reachable(entry.keys, fallback?.provider);
      if (record) add(record, entry);
    }
    return out;
  }

  /** The guide as EV reads it: a few lines per model. */
  text() {
    const entries = this.entries();
    if (!entries.length) return "";
    return entries.map((entry) => {
      const cost = this._plan(entry.record.provider)
        ? `within the person's ${this.connections.providerName(entry.record.provider)} subscription (quota already paid for)`
        : entry.record.cost ? `${money(entry.record.cost.input)} in / ${money(entry.record.cost.output)} out per million tokens` : "price unknown";
      const context = entry.record.contextWindow ? `, reads up to ${Math.round(entry.record.contextWindow / 1000)}k tokens` : "";
      const lines = [`${entry.name} (name it as ${entry.spec}): ${cost}${context}.`];
      for (const claim of entry.claims) lines.push(`  - ${claim.text} (${STATES[claim.state] ?? claim.state})`);
      if (!entry.claims.length) lines.push("  - The atlas says nothing about it yet.");
      lines.push(entry.yours
        ? `  - In this person's own work: ${entry.yours.pieces} piece${entry.yours.pieces === 1 ? "" : "s"} delivered, ${entry.yours.rounds.toFixed(1)} review rounds on average${entry.yours.costUsd ? `, about ${money(entry.yours.costUsd / entry.yours.pieces)} each` : ""}.`
        : "  - Nothing from this person's own work yet.");
      return lines.join("\n");
    }).join("\n");
  }

  /** A model EV named: "provider/id", an id, or a name from the guide. The record, or null when the person cannot reach it. */
  resolve(name) {
    const wanted = String(name ?? "").trim();
    if (!wanted) return null;
    const entry = this.entries().find((candidate) => candidate.spec === wanted || candidate.key === modelKey(wanted) || candidate.name.toLowerCase() === wanted.toLowerCase());
    if (entry) return entry.record;
    if (wanted.includes("/")) {
      try { const record = modelSettings(this.env, wanted); if (this.routes.routes(record).length) return record; } catch {}
    }
    return this._reachable([modelKey(wanted)], this._default()?.provider);
  }

  /**
   * What the person's own finished work shows per model key: { pieces,
   * rounds, costUsd }. The model is the one the work's calls actually went
   * to; rounds come from its reviews.
   */
  evidence() {
    const found = new Map();
    if (!this.store) return found;
    const rows = this.store.db.prepare(`
      SELECT w.work_id AS id,
        (SELECT model FROM model_calls c WHERE c.work_id = w.work_id AND c.role = 'agent' GROUP BY model ORDER BY COUNT(*) DESC LIMIT 1) AS model,
        (SELECT SUM(cost_usd) FROM model_calls c WHERE c.work_id = w.work_id) AS cost,
        (SELECT MAX(CAST(json_extract(data_json, '$.round') AS INTEGER)) FROM events e WHERE e.work_id = w.work_id AND e.type = 'verifying') AS rounds
      FROM work w WHERE w.status = 'completed'`).all();
    for (const row of rows) {
      if (!row.model) continue;
      const key = modelKey(row.model);
      const entry = found.get(key) ?? { pieces: 0, totalRounds: 0, costUsd: 0 };
      entry.pieces++;
      entry.totalRounds += row.rounds ?? 1;
      entry.costUsd += row.cost ?? 0;
      found.set(key, entry);
    }
    for (const entry of found.values()) entry.rounds = entry.totalRounds / entry.pieces;
    return found;
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

