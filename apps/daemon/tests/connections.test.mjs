import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../lib/store.mjs";
import { Connections } from "../lib/connections.mjs";

async function open(env = { OPENCODE_API: "env-key" }) {
  const dataRoot = await mkdtemp(join(tmpdir(), "ev-connections-"));
  const store = openStore({ path: join(dataRoot, "ev.sqlite") });
  const connections = await Connections.open({ store, dataRoot, env });
  return { dataRoot, store, connections, close: async () => { store.close(); await rm(dataRoot, { recursive: true, force: true }); } };
}

test("a stored key wins over the environment, lives only in the 0600 secrets file, and reaches pi-ai", async () => {
  const { dataRoot, store, connections, close } = await open();
  try {
    assert.equal(connections.serving("opencode-go").method, "env");
    const saved = connections.save({ provider: "opencode-go", method: "key", credential: { type: "api_key", key: "stored-key-1234" }, label: "Work" });
    assert.equal(connections.serving("opencode-go").id, saved.id);
    assert.equal(saved.hint, "…1234");
    const file = join(dataRoot, "secrets", "credentials.json");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.match(readFileSync(file, "utf8"), /stored-key-1234/);
    assert.ok(!JSON.stringify(store.db.prepare("SELECT * FROM connections").all()).includes("stored-key-1234"));
    const auth = await connections.models.getAuth("opencode-go");
    assert.equal(auth.auth.apiKey, "stored-key-1234");
    connections.remove(saved.id);
    assert.equal((await connections.models.getAuth("opencode-go")).auth.apiKey, "env-key");
    assert.throws(() => connections.remove("env:opencode-go"), (error) => error.code === "CONNECTION_FROM_ENVIRONMENT");
  } finally { await close(); }
});

test("a limited or signed-out account is not called: the error says what it waits for, and since when", async () => {
  const { connections, close } = await open();
  try {
    let changes = 0;
    connections.onChange(() => changes++);
    const account = connections.forCall("opencode-go", "X");
    const limited = connections.limitHit(account, 60_000, "X");
    assert.equal(limited.code, "X");
    assert.equal(limited.wait.reason, "limited");
    assert.ok(Date.parse(limited.wait.until) > Date.now());
    // Limited again while limited: the same episode, nobody told twice.
    assert.equal(connections.limitHit(account, 60_000, "X").wait.since, limited.wait.since);
    assert.equal(changes, 1);
    connections.ready(connections.serving("opencode-go"));
    const refused = connections.refused(connections.serving("opencode-go"), "HTTP 401", "X");
    assert.equal(refused.wait.reason, "needs-sign-in");
    assert.throws(() => connections.forCall("opencode-go", "X"), (error) => error.wait?.reason === "needs-sign-in");
    assert.throws(() => connections.forCall("openai", "X"), (error) => error.wait?.reason === "none");
  } finally { await close(); }
});

test("subscription sign-in is offered where providers allow it, and never for a Claude subscription", async () => {
  const { connections, close } = await open({});
  try {
    const offered = Object.fromEntries(connections.providers().filter((provider) => provider.signIn).map((provider) => [provider.id, provider.signIn]));
    for (const id of ["openai", "github-copilot", "xai", "openrouter", "opencode", "opencode-go"]) assert.ok(offered[id], id);
    assert.equal(offered.anthropic, undefined);
    assert.equal(connections.deviceId(), connections.deviceId());
  } finally { await close(); }
});
