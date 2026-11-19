import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { Connections } from "../lib/connections.mjs";
import { ModelRelay } from "../lib/model-relay.mjs";
import { ModelRoutes } from "../lib/model-routes.mjs";

/** A provider that answers 429 with a long reset to `limitedKey`, and 200 to any other key. */
async function provider(limitedKey) {
  const seen = [];
  const server = createServer(async (request, response) => {
    for await (const _ of request);
    const key = request.headers["x-api-key"] ?? String(request.headers.authorization ?? "").replace(/^Bearer /, "");
    seen.push(key);
    if (key === limitedKey) { response.writeHead(429, { "Retry-After": "3600" }); return response.end(); }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end("data: ok\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test("an agent whose account runs out mid-task never sees the limit: it carries on through the person's other account, and the switch is told", async () => {
  const upstream = await provider("first-key");
  const connections = await Connections.open({ env: {} });
  connections.save({ provider: "opencode-go", method: "key", credential: { type: "api_key", key: "second-key" } });
  const first = connections.save({ provider: "opencode-go", method: "key", credential: { type: "api_key", key: "first-key" } });
  const changes = [];
  const relay = await new ModelRelay({ connections, onRouteChange: (change) => changes.push(change) }).start();
  try {
    const model = { ...connections.models.getModel("opencode-go", "claude-haiku-5-5"), baseUrl: upstream.url };
    const grant = await relay.grant({ taskId: "t1", model });
    const call = () => fetch(`${grant.baseUrl}/v1/messages`, { method: "POST", headers: { "x-api-key": grant.token, "Content-Type": "application/json" }, body: JSON.stringify({ model: model.id }) });
    // The agent never sees the limit: the refused request goes out again on the other account.
    assert.equal((await call()).status, 200);
    assert.equal(connections.list().find((connection) => connection.id === first.id).status, "limited");
    // And the task stays there.
    assert.equal((await call()).status, 200);
    assert.deepEqual(upstream.seen, ["first-key", "second-key", "second-key"]);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].taskId, "t1");
  } finally { await relay.stop(); upstream.close(); }
});

test("when the subscription runs out and only a pay-per-token route is left, nothing is spent: the work waits for the reset", async () => {
  // One OpenCode key reaches both Go (a plan) and Zen (paid per token).
  const connections = await Connections.open({ env: { OPENCODE_API_KEY: "key" } });
  const routes = new ModelRoutes({ connections });
  const model = connections.models.getModel("opencode-go", "claude-haiku-5-5");
  assert.equal(routes.pick(model, "X").model.provider, "opencode-go");
  connections.limited(connections.serving("opencode-go"), 3_600_000);
  assert.ok(connections.usable(connections.serving("opencode")), "the paid route is there to be taken");
  assert.throws(() => routes.pick(model, "X"), (error) => error.wait?.reason === "limited" && error.wait.provider === "opencode-go");
});
