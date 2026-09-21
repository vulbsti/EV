import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PiWorkerAdapter } from "../lib/pi-worker-adapter.mjs";

/*
 * The executable below is deliberately not Pi. It is a deterministic JSONL
 * stand-in, so this suite cannot make a provider/network call. The adapter's
 * subprocess contract is intentionally small:
 *
 *   const run = await adapter.start({ runId, sessionId, prompt });
 *   const result = await run.completion;
 *   await adapter.cancel(run);
 *
 * `run.argv` is retained by the adapter for receipt/debugging; the fake also
 * records it so the restrictive launch boundary is directly asserted.
 */

async function fixture(mode = "success", { expectedVersion = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ev-pi-adapter-"));
  const sessionDir = join(root, "sessions");
  const workspaceDir = join(root, "workspace");
  const argvPath = join(root, "argv.json");
  const fake = join(root, "fake-pi.mjs");
  await mkdir(sessionDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(fake, `
import { writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
await writeFile(${JSON.stringify(argvPath)}, JSON.stringify(args));
if (args.includes("--version")) { process.stdout.write("0.84.4\\n"); process.exit(0); }
const mode = process.env.FAKE_PI_MODE || "success";
if (mode === "stderr-secret") process.stderr.write("Authorization: Bearer test-secret-value\\n");
if (mode === "nonzero") { process.stderr.write("provider password=test-secret-value\\n"); process.exit(17); }
if (mode === "hang") { await new Promise(() => setInterval(() => {}, 1000)); }
process.stdout.write(JSON.stringify({ type: "session", version: 3, id: "fake-session" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Verified local brief" }] } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "Verified local brief" }] }] }) + "\\n");
`, "utf8");
  await chmod(fake, 0o755);
  return {
    root, sessionDir, workspaceDir, argvPath, fake,
    adapter: new PiWorkerAdapter({ executable: fake, sessionDir, cwd: workspaceDir, timeoutMs: 500, expectedVersion, env: { FAKE_PI_MODE: mode } }),
    async close() { await rm(root, { recursive: true, force: true }); }
  };
}

test("launches with restrictive flags and stable session identity", async () => {
  const f = await fixture();
  try {
    const run = await f.adapter.start({ runId: "run-1", sessionId: "session-1", prompt: "make the brief" });
    const result = await run.completion;
    assert.equal(result.status, "completed");
    assert.equal(result.text, "Verified local brief");
    const args = JSON.parse(await readFile(f.argvPath, "utf8"));
    assert.ok(args.includes("--mode") && args[args.indexOf("--mode") + 1] === "json");
    assert.ok(args.includes("--no-tools"));
    assert.ok(args.includes("--no-extensions"));
    assert.ok(args.includes("--no-skills"));
    assert.ok(args.includes("--no-context-files"));
    assert.ok(args.includes("--session-dir") && args[args.indexOf("--session-dir") + 1] === f.sessionDir);
    assert.ok(args.includes("--session-id") && args[args.indexOf("--session-id") + 1] === "session-1");
    assert.ok(args.includes("make the brief"));
    assert.ok(!args.includes("--approve"));
    assert.ok(!args.includes("--session"));
  } finally { await f.close(); }
});

test("extracts only the final assistant text from JSONL events", async () => {
  const f = await fixture();
  try {
    const run = await f.adapter.start({ runId: "run-final", sessionId: "session-final", prompt: "brief" });
    const result = await run.completion;
    assert.equal(result.text, "Verified local brief");
    assert.equal(result.status, "completed");
    assert.equal(result.events.some((event) => event.type === "agent_end"), true);
  } finally { await f.close(); }
});

test("refuses to start when the installed Pi version does not match the pin", async () => {
  const f = await fixture("success", { expectedVersion: "9.9.9" });
  try {
    await assert.rejects(
      f.adapter.start({ runId: "run-version", sessionId: "session-version", prompt: "brief" }),
      (error) => error?.code === "PI_VERSION_MISMATCH"
    );
  } finally { await f.close(); }
});

test("times out and supports cancellation without leaking child stderr", async () => {
  const f = await fixture("hang");
  try {
    const run = await f.adapter.start({ runId: "run-timeout", sessionId: "session-timeout", prompt: "hang" });
    const result = await run.completion;
    assert.equal(result.status, "timed_out");
    assert.doesNotMatch(JSON.stringify(result), /test-secret-value|Authorization|Bearer/);
  } finally { await f.close(); }

  const c = await fixture("hang");
  try {
    const run = await c.adapter.start({ runId: "run-cancel", sessionId: "session-cancel", prompt: "cancel" });
    const cancelled = await c.adapter.cancel(run, { reason: "user-requested" });
    assert.equal(cancelled.status, "cancelled");
    const result = await run.completion;
    assert.equal(result.status, "cancelled");
  } finally { await c.close(); }
});

test("normalizes nonzero exit and redacts raw stderr and credential-like values", async () => {
  const f = await fixture("nonzero");
  try {
    const run = await f.adapter.start({ runId: "run-error", sessionId: "session-error", prompt: "fail" });
    const result = await run.completion;
    assert.equal(result.status, "failed");
    assert.equal(result.code, "PI_PROCESS_EXIT");
    assert.doesNotMatch(JSON.stringify(result), /test-secret-value|provider password|stderr/);
    assert.match(result.message, /Pi worker failed|exit/i);
  } finally { await f.close(); }
});
