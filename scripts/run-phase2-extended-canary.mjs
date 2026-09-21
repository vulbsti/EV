#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AssistantSupervisor } from "../apps/daemon/lib/assistant-supervisor.mjs";
import { PiWorkerAdapter } from "../apps/daemon/lib/pi-worker-adapter.mjs";
import { ScopedWorkspace } from "../apps/daemon/lib/scoped-workspace.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const taskId = `phase2-extended-${Date.now()}`;
const runId = randomUUID();
const workerRoot = join(projectRoot, "data", "assistant-worker");
const artifactRoot = join(workerRoot, "artifacts");
const workspaceRoot = join(workerRoot, "workspaces", taskId);
const sessionDir = join(workerRoot, "sessions");
await mkdir(join(workspaceRoot, "inputs"), { recursive: true, mode: 0o700 });
await mkdir(join(workspaceRoot, "output"), { recursive: true, mode: 0o700 });

const source = await readFile(join(projectRoot, "fixtures", "assistant", "launch-status-source.md"), "utf8");
await writeFile(join(workspaceRoot, "inputs", "source.md"), source, { mode: 0o600 });
await writeFile(join(workspaceRoot, "CONTEXT.md"), `# Task context\n\nCapability: extended-launch-brief-v1\nTask: ${taskId}\nAllowed root: this workspace only\nRequired output: output/launch-status-brief.md\nRequired headings: Current state, Evidence, Risks, Next actions\n`, { mode: 0o600 });

const supervisor = await AssistantSupervisor.open({ statePath: join(workerRoot, "supervisor-state.sqlite"), artifactRoot });
await supervisor.createTask({ taskId, input: { capability: "extended-launch-brief-v1", contextRevision: "fixture-v1", workspace: taskId } });
const lease = await supervisor.leaseTask({ taskId, workerId: "pi-scoped-workspace-v1" });
await supervisor.startTask({ taskId, runId, fencingToken: lease.fencingToken });

const toolNames = ["workspace_read", "workspace_write", "workspace_list", "workspace_grep", "workspace_run"];
const adapter = new PiWorkerAdapter({
  executable: process.env.EV_PI_EXECUTABLE ?? "pi",
  sessionDir,
  cwd: workspaceRoot,
  timeoutMs: Number(process.env.EV_WORKER_TIMEOUT_MS ?? 120_000),
  provider: process.env.EV_WORKER_PROVIDER ?? "opencode-go",
  model: process.env.EV_WORKER_MODEL ?? "deepseek-v4.1-flash",
  expectedVersion: process.env.EV_PI_VERSION ?? "0.84.4",
  tools: toolNames,
  extensionPaths: [join(projectRoot, "apps", "worker", "scoped-tools-extension.mjs")],
  skillPaths: [join(projectRoot, "apps", "worker", "skills", "extended-task", "SKILL.md")],
  contextPaths: [join(workspaceRoot, "CONTEXT.md")],
  env: { EV_WORKSPACE_ROOT: workspaceRoot }
});

let result;
try {
  const run = await adapter.start({
    runId,
    sessionId: runId,
    prompt: "Read CONTEXT.md and inputs/source.md using workspace tools. Create the required one-page Markdown brief at output/launch-status-brief.md. Then use workspace_run with wc to verify its byte size, read the finished file, and report the checks."
  });
  result = await run.completion;
} catch (error) {
  result = { status: "failed", code: error.code ?? "PI_START_FAILED", message: "Scoped Pi worker could not start" };
}

if (result.status !== "completed") {
  await supervisor.failTask({ taskId, runId, fencingToken: lease.fencingToken, error: { code: result.code, message: result.message } });
  console.error(JSON.stringify({ taskId, runId, status: "failed", code: result.code }));
  process.exitCode = 1;
} else {
  const workspace = await ScopedWorkspace.open(workspaceRoot);
  const brief = await workspace.read("output/launch-status-brief.md");
  const required = ["## Current state", "## Evidence", "## Risks", "## Next actions"];
  const missing = required.filter((heading) => !brief.includes(heading));
  const toolEvents = result.events.filter((event) => event.type?.startsWith("tool_execution"));
  const usedTools = [...new Set(toolEvents.map((event) => event.toolName ?? event.tool_name ?? event.name).filter(Boolean))];
  if (missing.length || brief.length < 240 || !usedTools.includes("workspace_read") || !usedTools.includes("workspace_write") || !usedTools.includes("workspace_run")) {
    await supervisor.failTask({ taskId, runId, fencingToken: lease.fencingToken, error: { code: "EXTENDED_ARTIFACT_INVALID", message: "Required structure or scoped tool receipts were missing" } });
    console.error(JSON.stringify({ taskId, runId, status: "failed", code: "EXTENDED_ARTIFACT_INVALID", missing, usedTools }));
    process.exitCode = 1;
  } else {
    const relativePath = join(taskId, "launch-status-brief.md");
    const absolutePath = join(artifactRoot, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
    await writeFile(absolutePath, brief, { mode: 0o600 });
    const contents = await readFile(absolutePath);
    const receipt = { artifactId: randomUUID(), relativePath, sha256: createHash("sha256").update(contents).digest("hex"), bytes: contents.length };
    const completed = await supervisor.completeTask({
      taskId, runId, fencingToken: lease.fencingToken,
      result: { summary: "Verified extended launch-status brief", usedTools, usage: result.usage, contextRevision: "fixture-v1" },
      artifacts: [receipt]
    });
    console.log(JSON.stringify({
      taskId, runId, status: completed.status, artifact: receipt,
      worker: { piVersion: adapter.expectedVersion, provider: adapter.provider, model: adapter.model, tools: toolNames, extension: "scoped-tools-extension-v1", skill: "extended-task-v1" },
      usedTools, usage: result.usage
    }, null, 2));
  }
}

supervisor.close();
