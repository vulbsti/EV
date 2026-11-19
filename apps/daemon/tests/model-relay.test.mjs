import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connections } from "../lib/connections.mjs";
import { FORWARDER, ModelRelay } from "../lib/model-relay.mjs";

/** A provider that records what it was sent and answers with `status`. */
async function provider(status = 200, headers = {}) {
  const seen = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    seen.push({ path: request.url, auth: request.headers.authorization, body });
    response.writeHead(status, { "Content-Type": "text/event-stream", ...headers });
    response.end("data: one\n\ndata: two\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { seen, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => server.close() };
}

async function setup(status, headers) {
  const upstream = await provider(status, headers);
  const connections = await Connections.open({ env: { OPENCODE_API: "real-key" } });
  const model = { ...connections.models.getModel("opencode-go", "gpt-6-luna"), baseUrl: upstream.url };
  const relay = await new ModelRelay({ connections }).start();
  return { upstream, connections, model, relay, stop: async () => { await relay.stop(); upstream.close(); } };
}

const call = (url, token, path = "/responses") => fetch(`${url}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-6-luna", stream: true }) });

test("a token is refused once its run ends, and a made-up one never works", async () => {
  const { upstream, model, relay, stop } = await setup();
  try {
    const grant = await relay.grant({ taskId: "t1", model });
    relay.revoke(grant.token);
    assert.equal((await call(grant.baseUrl, grant.token)).status, 401);
    assert.equal((await call(grant.baseUrl, "real-key")).status, 401);
    assert.equal(upstream.seen.length, 0);
  } finally { await stop(); }
});

test("inside a container the relay is reached through its socket and the forwarder", async () => {
  const { upstream, model, relay, stop } = await setup();
  const dir = await mkdtemp(join(tmpdir(), "ev-forward-"));
  let child;
  try {
    const grant = await relay.grant({ taskId: "t1", model, socket: true });
    await writeFile(join(dir, "forward.mjs"), FORWARDER);
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    child = spawn(process.execPath, [join(dir, "forward.mjs"), grant.socket, String(port)], { stdio: "ignore" });
    let response;
    for (let attempt = 0; attempt < 50 && !response; attempt++) {
      try { response = await call(`http://127.0.0.1:${port}/relay`, grant.token); } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
    }
    assert.equal(response?.status, 200);
    assert.equal(upstream.seen[0].auth, "Bearer real-key");
  } finally { child?.kill(); await stop(); await rm(dir, { recursive: true, force: true }); }
});
