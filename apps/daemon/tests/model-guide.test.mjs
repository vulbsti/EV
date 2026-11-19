import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ATLAS_DIR, loadAtlas } from "../lib/model-guide.mjs";

test("every line of the shipped model atlas is read: each claim says how it is known and where from", () => {
  const files = readdirSync(ATLAS_DIR).filter((file) => file.endsWith(".md") && file !== "README.md");
  const atlas = loadAtlas();
  assert.equal(atlas.length, files.length, "an atlas file has no header");
  for (const file of files) {
    const written = readFileSync(join(ATLAS_DIR, file), "utf8").split("---").slice(2).join("---").split("\n").filter((line) => line.trim().startsWith("-")).length;
    const entry = atlas.find((candidate) => candidate.file === file);
    assert.equal(entry.claims.length, written, `${file}: a claim does not end with [state: source, date]`);
    for (const claim of entry.claims) assert.ok(claim.source, `${file}: "${claim.text}" says how it is known but not where from`);
  }
});

test("what the weekly analysis learns rests on real work: \"relied on\" needs work over more than one week, and every change can be undone", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { openStore } = await import("../lib/store.mjs");
  const { Connections } = await import("../lib/connections.mjs");
  const { ModelRoutes } = await import("../lib/model-routes.mjs");
  const { ModelGuide } = await import("../lib/model-guide.mjs");
  const { ModelLearning } = await import("../lib/model-learning.mjs");
  const root = await mkdtemp(join(tmpdir(), "ev-guide-"));
  try {
    const store = openStore({ path: join(root, "ev.sqlite") });
    const connections = await Connections.open({ store, env: { OPENCODE_API_KEY: "key" } });
    const routes = new ModelRoutes({ connections });
    const guide = new ModelGuide({ routes, store, atlas: [] });
    const now = Date.parse("2026-11-19T12:00:00Z");
    // Three pieces of finished work, all in one week.
    for (const [id, at] of [["w1", "2026-11-17T10:00:00Z"], ["w2", "2026-11-18T10:00:00Z"], ["w3", "2026-11-18T15:00:00Z"]]) {
      store.db.prepare("INSERT INTO work (work_id, input_json, status, created_at, updated_at) VALUES (?, ?, 'completed', ?, ?)").run(id, JSON.stringify({ metadata: { title: "Design" } }), at, at);
      routes.record({ role: "agent", workId: id, model: connections.models.getModel("opencode-go", "claude-haiku-5-5"), outcome: "ok" });
    }
    let answer = { claims: [{ id: null, model: "claude-haiku-5-5", text: "Good at your design work.", state: "relied_on", evidence: ["work:w1", "work:w2", "work:w3", "work:made-up"], change: "Design now goes to Haiku." }], retire: [] };
    const learning = new ModelLearning({ store, guide, now: () => now, log: () => {}, call: async () => answer });
    const [change] = await learning.run();
    const [claim] = learning.claims("claude-haiku-5-5");
    assert.equal(claim.state, "seen", "three pieces in one week were taken as relied on");
    assert.deepEqual(claim.evidence, ["work:w1", "work:w2", "work:w3"], "a claim rests on work that does not exist");
    answer = { claims: [], retire: [{ id: claim.id, change: "Not any more." }] };
    const [retired] = await learning.run();
    assert.equal(learning.claims("claude-haiku-5-5").length, 0);
    learning.undo(retired);
    assert.equal(learning.claims("claude-haiku-5-5")[0].text, "Good at your design work.");
    learning.undo(change);
    assert.equal(learning.claims("claude-haiku-5-5").length, 0);
    store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
