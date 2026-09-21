import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Future module contract under test:
//
//   const supervisor = await AssistantSupervisor.open({ statePath, artifactRoot });
//   await supervisor.createTask({ taskId, input });
//   const lease = await supervisor.leaseTask({ taskId, workerId });
//   await supervisor.startTask({ taskId, runId, fencingToken: lease.fencingToken });
//   await supervisor.completeTask({ taskId, runId, fencingToken, result, artifacts });
//   await supervisor.failTask({ taskId, runId, fencingToken, error });
//   await supervisor.cancelTask({ taskId, reason });
//   await supervisor.recover();
//   await supervisor.getTask(taskId);
//
// A lease returns { leaseId, fencingToken, workerId }. Every worker-owned
// transition requires the current fencingToken. State is durable at statePath;
// reopening the supervisor must recover the same task/run and event history.
// Artifact receipts are { artifactId, relativePath, sha256, bytes }. Completion
// must verify each receipt beneath artifactRoot before becoming terminal.
import { AssistantSupervisor } from "../lib/assistant-supervisor.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ev-assistant-supervisor-"));
  const artifactRoot = join(root, "artifacts");
  await mkdir(artifactRoot, { recursive: true });
  return {
    root,
    statePath: join(root, "supervisor-state.json"),
    artifactRoot,
    async close() {
      await rm(root, { recursive: true, force: true });
    }
  };
}

async function receiptFor(artifactRoot, relativePath, contents) {
  const absolutePath = join(artifactRoot, relativePath);
  await mkdir(join(absolutePath, ".."), { recursive: true });
  await writeFile(absolutePath, contents);
  const bytes = Buffer.byteLength(contents);
  const sha256 = createHash("sha256").update(contents).digest("hex");
  return { artifactId: relativePath, relativePath, sha256, bytes };
}

function staleToken(error) {
  return error?.code === "STALE_FENCING_TOKEN";
}

function invalidReceipt(error) {
  return error?.code === "ARTIFACT_RECEIPT_INVALID";
}

test("runs one durable task through leased, started, and completed with a verified artifact", async () => {
  const f = await fixture();
  try {
    const supervisor = await AssistantSupervisor.open(f);
    await supervisor.createTask({ taskId: "task-1", input: { prompt: "make report" } });
    const lease = await supervisor.leaseTask({ taskId: "task-1", workerId: "worker-a" });
    assert.equal(typeof lease.fencingToken, "string");
    await supervisor.startTask({ taskId: "task-1", runId: "run-1", fencingToken: lease.fencingToken });

    const artifact = await receiptFor(f.artifactRoot, "reports/result.txt", "verified output\n");
    const completed = await supervisor.completeTask({
      taskId: "task-1",
      runId: "run-1",
      fencingToken: lease.fencingToken,
      result: { summary: "done" },
      artifacts: [artifact]
    });

    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.artifacts, [artifact]);
    const task = await supervisor.getTask("task-1");
    assert.equal(task.status, "completed");
    assert.equal(task.run.runId, "run-1");
    assert.deepEqual(task.history.map((event) => event.type), ["created", "leased", "started", "completed"]);
  } finally {
    await f.close();
  }
});

test("rejects an unverified artifact receipt and keeps the run non-terminal", async () => {
  const f = await fixture();
  try {
    const supervisor = await AssistantSupervisor.open(f);
    await supervisor.createTask({ taskId: "task-receipt", input: { prompt: "write" } });
    const lease = await supervisor.leaseTask({ taskId: "task-receipt", workerId: "worker-a" });
    await supervisor.startTask({ taskId: "task-receipt", runId: "run-receipt", fencingToken: lease.fencingToken });
    const artifact = await receiptFor(f.artifactRoot, "result.txt", "actual\n");
    artifact.sha256 = "0".repeat(64);

    await assert.rejects(
      supervisor.completeTask({ taskId: "task-receipt", runId: "run-receipt", fencingToken: lease.fencingToken, artifacts: [artifact] }),
      invalidReceipt
    );
    assert.equal((await supervisor.getTask("task-receipt")).status, "running");
  } finally {
    await f.close();
  }
});

test("makes duplicate completion idempotent and exposes failed and cancelled terminal states", async () => {
  const f = await fixture();
  try {
    const supervisor = await AssistantSupervisor.open(f);
    await supervisor.createTask({ taskId: "task-done", input: {} });
    const doneLease = await supervisor.leaseTask({ taskId: "task-done", workerId: "worker-a" });
    await supervisor.startTask({ taskId: "task-done", runId: "run-done", fencingToken: doneLease.fencingToken });
    const first = await supervisor.completeTask({ taskId: "task-done", runId: "run-done", fencingToken: doneLease.fencingToken, result: { value: 1 }, artifacts: [] });
    const duplicate = await supervisor.completeTask({ taskId: "task-done", runId: "run-done", fencingToken: doneLease.fencingToken, result: { value: 1 }, artifacts: [] });
    assert.deepEqual(duplicate, first);
    assert.equal((await supervisor.getTask("task-done")).history.filter((event) => event.type === "completed").length, 1);

    await supervisor.createTask({ taskId: "task-failed", input: {} });
    const failedLease = await supervisor.leaseTask({ taskId: "task-failed", workerId: "worker-a" });
    await supervisor.startTask({ taskId: "task-failed", runId: "run-failed", fencingToken: failedLease.fencingToken });
    assert.equal((await supervisor.failTask({ taskId: "task-failed", runId: "run-failed", fencingToken: failedLease.fencingToken, error: { code: "WORKER_ERROR", message: "nope" } })).status, "failed");

    await supervisor.createTask({ taskId: "task-cancelled", input: {} });
    assert.equal((await supervisor.cancelTask({ taskId: "task-cancelled", reason: "user-requested" })).status, "cancelled");
  } finally {
    await f.close();
  }
});

test("recovers an in-flight run after restart and rejects the stale lease token", async () => {
  const f = await fixture();
  try {
    const firstSupervisor = await AssistantSupervisor.open(f);
    await firstSupervisor.createTask({ taskId: "task-restart", input: { prompt: "resume" } });
    const oldLease = await firstSupervisor.leaseTask({ taskId: "task-restart", workerId: "worker-old" });
    await firstSupervisor.startTask({ taskId: "task-restart", runId: "run-restart", fencingToken: oldLease.fencingToken });

    const restarted = await AssistantSupervisor.open(f);
    const recovered = await restarted.recover();
    assert.deepEqual(recovered, { recoveredTaskIds: ["task-restart"] });
    assert.equal((await restarted.getTask("task-restart")).status, "queued");

    const newLease = await restarted.leaseTask({ taskId: "task-restart", workerId: "worker-new" });
    assert.notEqual(newLease.fencingToken, oldLease.fencingToken);
    await assert.rejects(
      restarted.completeTask({ taskId: "task-restart", runId: "run-restart", fencingToken: oldLease.fencingToken, artifacts: [] }),
      staleToken
    );
    await restarted.startTask({ taskId: "task-restart", runId: "run-restart", fencingToken: newLease.fencingToken });
    assert.equal((await restarted.getTask("task-restart")).status, "running");

    // The state file is JSON so a restart cannot silently replace its durable
    // task/run record with an in-memory default.
    const persisted = JSON.parse(await readFile(f.statePath, "utf8"));
    assert.ok(persisted.tasks["task-restart"]);
  } finally {
    await f.close();
  }
});
