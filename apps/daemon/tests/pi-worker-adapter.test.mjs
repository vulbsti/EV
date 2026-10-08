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

async function fixture(mode = "success", adapterOptions = {}) {
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
    adapter: new PiWorkerAdapter({ executable: fake, sessionDir, cwd: workspaceDir, timeoutMs: 500, ...adapterOptions, env: { FAKE_PI_MODE: mode, ...(adapterOptions.env ?? {}) } }),
    async close() { await rm(root, { recursive: true, force: true }); }
  };
}

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

test("loads only an explicit scoped tool, extension, skill, and context bundle", async () => {
  const f = await fixture("success", {
    tools: ["workspace_read", "workspace_write"],
    extensionPaths: ["./scoped-extension.mjs"],
    skillPaths: ["./task-skill"],
    contextPaths: ["./CONTEXT.md"]
  });
  try {
    const run = await f.adapter.start({ runId: "run-scoped", prompt: "work inside the workspace" });
    await run.completion;
    const args = JSON.parse(await readFile(f.argvPath, "utf8"));
    assert.ok(args.includes("--no-builtin-tools"));
    assert.equal(args[args.indexOf("--tools") + 1], "workspace_read,workspace_write");
    assert.ok(args.includes("--no-extensions") && args.includes("--extension"));
    assert.ok(args.includes("--no-skills") && args.includes("--skill"));
    assert.ok(args.includes("--no-context-files") && args.includes("--append-system-prompt"));
    assert.ok(!args.includes("--no-tools"));
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

test("stops a run as soon as its summed usage crosses the budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-pi-budget-"));
  try {
    const fake = join(root, "fake-pi.mjs");
    await writeFile(fake, `
const usage = { input: 400, output: 200, cacheRead: 5000, cost: { total: 0.001 } };
for (let call = 1; call <= 50; call++) {
  process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", usage, content: [{ type: "text", text: "step " + call }] } }) + "\\n");
  await new Promise((resolve) => setTimeout(resolve, 20));
}
`, "utf8");
    const adapter = new PiWorkerAdapter({ executable: fake, sessionDir: join(root, "sessions"), cwd: root, timeoutMs: 5_000 });
    const run = await adapter.start({ runId: "run-budget", prompt: "loop", budget: { maxTotalTokens: 1_500, maxCostUsd: 0, maxToolCalls: -1 } });
    const result = await run.completion;
    assert.equal(result.status, "budget_exceeded");
    assert.equal(result.code, "WORKER_BUDGET_EXCEEDED");
    // Three calls of 600 counted tokens each cross 1,500; cache reads are not counted.
    assert.equal(result.usage.calls, 3);
    assert.equal(result.usage.totalTokens, 1_800);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("keeps a redacted stderr tail in a private diagnostics file, never in the result", async () => {
  const f = await fixture("nonzero");
  try {
    const run = await f.adapter.start({ runId: "run-diag", sessionId: "session-diag", prompt: "fail" });
    const result = await run.completion;
    assert.equal(result.status, "failed");
    const log = await readFile(result.diagnosticsLog, "utf8");
    assert.match(log, /password=\[REDACTED\]/);
    assert.doesNotMatch(log, /test-secret-value/);
  } finally { await f.close(); }
});
