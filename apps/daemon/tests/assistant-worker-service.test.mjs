import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AssistantSupervisor } from "../lib/assistant-supervisor.mjs";
import { AssistantWorkerService, createFixedCapabilityProfiles } from "../lib/assistant-worker-service.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ev-worker-service-"));
  const workerRoot = join(root, "worker");
  const workspaceRoot = join(workerRoot, "workspaces");
  const artifactRoot = join(workerRoot, "artifacts");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(artifactRoot, { recursive: true });
  const supervisor = await AssistantSupervisor.open({ statePath: join(workerRoot, "state.sqlite"), artifactRoot });
  return {
    root, workerRoot, workspaceRoot, artifactRoot, supervisor,
    async close() { supervisor.close(); await rm(root, { recursive: true, force: true }); }
  };
}

function fakeAdapterFactory({ calls, delay = 0 } = {}) {
  return async ({ task, workspacePath }) => ({
    async start({ runId }) {
      calls?.push({ type: "start", taskId: task.taskId, runId });
      let resolveCompletion;
      const completion = new Promise((resolve) => { resolveCompletion = resolve; });
      const run = { completion, resolveCompletion, cancelled: false };
      const timer = setTimeout(async () => {
        await writeFile(join(workspacePath, "output.md"), "## Verified output\n", { mode: 0o600 });
        resolveCompletion({ status: "completed", text: "done", events: [] });
      }, delay);
      run.cancelTimer = timer;
      return run;
    },
    async cancel(run) {
      calls?.push({ type: "cancel", taskId: task.taskId });
      clearTimeout(run.cancelTimer);
      run.cancelled = true;
      run.resolveCompletion({ status: "cancelled", code: "PI_CANCELLED", message: "cancelled" });
      return { status: "cancelled" };
    }
  });
}

test("submits a fixed scoped task, owns its run, and completes only after artifact materialization", async () => {
  const f = await fixture();
  const calls = [];
  try {
    const workspace = join(f.workspaceRoot, "task-1");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "CONTEXT.md"), "Capability: test\n", { mode: 0o600 });
    const service = new AssistantWorkerService({
      supervisor: f.supervisor,
      workerRoot: f.workerRoot,
      workspaceRoot: f.workspaceRoot,
      profiles: createFixedCapabilityProfiles({ projectRoot: process.cwd() }),
      adapterFactory: fakeAdapterFactory({ calls }),
    });
    const submitted = await service.submitTask({
      taskId: "task-1",
      capability: "scoped-workspace-v1",
      prompt: "make the output",
      workspace: "task-1",
      artifact: { sourcePath: "output.md", relativePath: "brief.md" },
    });
    assert.equal(submitted.status, "queued");
    const completed = await service.waitForTask("task-1");
    assert.equal(completed.status, "completed");
    assert.equal(completed.artifacts.length, 1);
    assert.equal(calls.filter((call) => call.type === "start").length, 1);
    assert.equal(service.activeRuns.size, 0);
    assert.deepEqual(completed.history.map((event) => event.type), ["created", "leased", "started", "completed"]);
  } finally { await f.close(); }
});

test("persists cancellation before stopping an active adapter and prevents late completion", async () => {
  const f = await fixture();
  const calls = [];
  try {
    const service = new AssistantWorkerService({
      supervisor: f.supervisor,
      workerRoot: f.workerRoot,
      workspaceRoot: f.workspaceRoot,
      adapterFactory: fakeAdapterFactory({ calls, delay: 10_000 }),
    });
    await service.submitTask({ taskId: "cancel-1", capability: "no-tools-v1", prompt: "hang" });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await f.supervisor.getTask("cancel-1")).status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal((await f.supervisor.getTask("cancel-1")).status, "running");
    const cancelled = await service.cancelTask({ taskId: "cancel-1", reason: "user-requested" });
    assert.equal(cancelled.status, "cancelled");
    const final = await service.waitForTask("cancel-1");
    assert.equal(final.status, "cancelled");
    assert.equal(calls.filter((call) => call.type === "cancel").length, 1);
    assert.deepEqual(final.history.map((event) => event.type), ["created", "leased", "started", "cancelled"]);
  } finally { await f.close(); }
});

test("recovers persisted in-flight work on service startup exactly once", async () => {
  const f = await fixture();
  const calls = [];
  try {
    await f.supervisor.createTask({ taskId: "recover-1", input: { capability: "no-tools-v1", prompt: "resume", workspace: "recover-1" } });
    const lease = await f.supervisor.leaseTask({ taskId: "recover-1", workerId: "old-worker" });
    await f.supervisor.startTask({ taskId: "recover-1", runId: "old-run", fencingToken: lease.fencingToken });
    const service = new AssistantWorkerService({
      supervisor: f.supervisor,
      workerRoot: f.workerRoot,
      workspaceRoot: f.workspaceRoot,
      adapterFactory: fakeAdapterFactory({ calls }),
    });
    await service.start();
    const recovered = await service.waitForTask("recover-1");
    assert.equal(recovered.status, "completed");
    assert.equal(calls.filter((call) => call.type === "start").length, 1);
    assert.equal(recovered.history.filter((event) => event.type === "recovered").length, 1);
  } finally { await f.close(); }
});

test("graceful daemon shutdown fences the old run and resumes one queued replacement", async () => {
  const f = await fixture();
  const firstCalls = [];
  const secondCalls = [];
  try {
    const first = new AssistantWorkerService({
      supervisor: f.supervisor,
      workerRoot: f.workerRoot,
      workspaceRoot: f.workspaceRoot,
      adapterFactory: fakeAdapterFactory({ calls: firstCalls, delay: 10_000 })
    });
    await first.submitTask({ taskId: "restart-1", capability: "no-tools-v1", prompt: "resume after restart" });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await f.supervisor.getTask("restart-1")).status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await first.shutdown();
    const queued = await f.supervisor.getTask("restart-1");
    assert.equal(queued.status, "queued");
    assert.deepEqual(queued.history.map((event) => event.type), ["created", "leased", "started", "interrupted"]);

    const second = new AssistantWorkerService({
      supervisor: f.supervisor,
      workerRoot: f.workerRoot,
      workspaceRoot: f.workspaceRoot,
      adapterFactory: fakeAdapterFactory({ calls: secondCalls })
    });
    await second.start();
    const completed = await second.waitForTask("restart-1");
    assert.equal(completed.status, "completed");
    assert.equal(firstCalls.filter((call) => call.type === "start").length, 1);
    assert.equal(firstCalls.filter((call) => call.type === "cancel").length, 1);
    assert.equal(secondCalls.filter((call) => call.type === "start").length, 1);
  } finally { await f.close(); }
});

test("rejects capabilities outside the fixed profile registry", async () => {
  const f = await fixture();
  try {
    const service = new AssistantWorkerService({ supervisor: f.supervisor, workerRoot: f.workerRoot, workspaceRoot: f.workspaceRoot });
    await assert.rejects(service.submitTask({ taskId: "bad-1", capability: "host-shell", prompt: "escape" }), (error) => error?.code === "CAPABILITY_NOT_ALLOWED");
  } finally { await f.close(); }
});

test("fails closed when a completed model response exceeds its reviewed budget", async () => {
  const f = await fixture();
  try {
    const profiles = {
      "tiny-budget-v1": {
        capability: "tiny-budget-v1",
        tools: [], extensionPaths: [], skillPaths: [], requireContext: false, requireArtifact: false,
        budget: { maxTotalTokens: 1, maxCostUsd: 1, maxToolCalls: 0 }
      }
    };
    const service = new AssistantWorkerService({
      supervisor: f.supervisor,
      workerRoot: f.workerRoot,
      workspaceRoot: f.workspaceRoot,
      profiles,
      adapterFactory: async () => ({
        async start() { return { completion: Promise.resolve({ status: "completed", text: "too expensive", usage: { totalTokens: 2, cost: { total: 0 } }, events: [] }) }; },
        async cancel() { return { status: "already_stopped" }; }
      })
    });
    await service.submitTask({ taskId: "budget-1", capability: "tiny-budget-v1", prompt: "bounded" });
    const failed = await service.waitForTask("budget-1");
    assert.equal(failed.status, "failed");
    assert.equal(failed.error.code, "WORKER_BUDGET_EXCEEDED");
    assert.deepEqual(failed.artifacts, []);
  } finally { await f.close(); }
});
