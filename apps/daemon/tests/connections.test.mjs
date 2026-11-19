import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
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

test("a Claude subscription sign-in is never offered (Anthropic's terms forbid it in other apps)", async () => {
  const { connections, close } = await open({});
  try {
    assert.equal(connections.providers().find((provider) => provider.id === "anthropic").signIn, null);
  } finally { await close(); }
});
