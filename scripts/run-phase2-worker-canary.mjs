#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AssistantSupervisor } from "../apps/daemon/lib/assistant-supervisor.mjs";
import { PiWorkerAdapter } from "../apps/daemon/lib/pi-worker-adapter.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const taskId = `phase2-canary-${Date.now()}`;
const runId = randomUUID();
const workerRoot = join(projectRoot, "data", "assistant-worker");
const artifactRoot = join(workerRoot, "artifacts");
const sessionDir = join(workerRoot, "sessions");
const workspace = join(workerRoot, "workspaces", taskId);
const sourcePath = join(projectRoot, "fixtures", "assistant", "launch-status-source.md");
await mkdir(workspace, { recursive: true });

const source = await readFile(sourcePath, "utf8");
if (Buffer.byteLength(source) > 32_000) throw new Error("The canary source exceeds its 32 KB input budget");

const supervisor = await AssistantSupervisor.open({
  statePath: join(workerRoot, "supervisor-state.sqlite"),
  artifactRoot
});
await supervisor.createTask({ taskId, input: { capability: "launch-status-brief-v1", source: "fixtures/assistant/launch-status-source.md" } });
const lease = await supervisor.leaseTask({ taskId, workerId: "pi-local-brief-v1" });
await supervisor.startTask({ taskId, runId, fencingToken: lease.fencingToken });

const adapter = new PiWorkerAdapter({
  executable: process.env.EV_PI_EXECUTABLE ?? "pi",
  sessionDir,
  cwd: workspace,
  timeoutMs: Number(process.env.EV_WORKER_TIMEOUT_MS ?? 120_000),
  provider: process.env.EV_WORKER_PROVIDER ?? "opencode-go",
  model: process.env.EV_WORKER_MODEL ?? "deepseek-v4.1-flash",
  expectedVersion: process.env.EV_PI_VERSION ?? "0.84.4"
});

const prompt = `You are a bounded EV worker. Produce a concise one-page Markdown launch-status brief using only the source text and run context below. Do not claim external facts or actions. Use exactly these H2 headings: Current state, Evidence, Risks, Next actions. Return only the Markdown brief.\n\nRUN CONTEXT\nThis brief is being produced by the first live Phase 2 worker canary. The no-tool Pi adapter, durable supervisor lifecycle, EV-owned artifact write, and hash verification are active for this run. Do not list building that canary path as a future action. Browser lifecycle integration, cancellation, and daemon-restart recovery are still pending.\n\nSOURCE\n${source}`;
let result;
try {
  const run = await adapter.start({ runId, sessionId: runId, prompt });
  result = await run.completion;
} catch (error) {
  result = { status: "failed", code: error.code ?? "PI_START_FAILED", message: "Pi worker could not start with the pinned runtime" };
}
if (result.status !== "completed") {
  await supervisor.failTask({ taskId, runId, fencingToken: lease.fencingToken, error: { code: result.code, message: result.message } });
  console.error(JSON.stringify({ taskId, runId, status: "failed", code: result.code }));
  process.exitCode = 1;
} else {
  const required = ["## Current state", "## Evidence", "## Risks", "## Next actions"];
  const missing = required.filter((heading) => !result.text.includes(heading));
  if (missing.length || result.text.length < 240 || !/canary/i.test(result.text)) {
    await supervisor.failTask({ taskId, runId, fencingToken: lease.fencingToken, error: { code: "ARTIFACT_CONTENT_INVALID", message: `Missing required brief structure: ${missing.join(", ")}` } });
    console.error(JSON.stringify({ taskId, runId, status: "failed", code: "ARTIFACT_CONTENT_INVALID", missing }));
    process.exitCode = 1;
  } else {
    const relativePath = join(taskId, "launch-status-brief.md");
    const absolutePath = join(artifactRoot, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, `${result.text.trim()}\n`, { mode: 0o600 });
    const contents = await readFile(absolutePath);
    const receipt = {
      artifactId: randomUUID(),
      relativePath,
      sha256: createHash("sha256").update(contents).digest("hex"),
      bytes: contents.length
    };
    const completed = await supervisor.completeTask({
      taskId,
      runId,
      fencingToken: lease.fencingToken,
      result: { summary: "Verified launch-status brief", usage: result.usage },
      artifacts: [receipt]
    });
    console.log(JSON.stringify({
      taskId,
      runId,
      status: completed.status,
      artifact: receipt,
      worker: { piVersion: adapter.expectedVersion, provider: adapter.provider, model: adapter.model, tools: [] },
      usage: result.usage
    }, null, 2));
  }
}
supervisor.close();
