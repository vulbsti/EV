import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    statePath: join(root, "supervisor-state.sqlite"),
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

    const snapshot = await restarted.snapshot();
    assert.ok(snapshot.revision >= 6);
    assert.ok(snapshot.tasks.some((task) => task.taskId === "task-restart"));
  } finally {
    await f.close();
  }
});

test("serializes competing leases across two supervisor instances", async () => {
  const f = await fixture();
  try {
    const first = await AssistantSupervisor.open(f);
    const second = await AssistantSupervisor.open(f);
    await first.createTask({ taskId: "task-concurrent", input: { prompt: "one lease" } });

    const attempts = await Promise.allSettled([
      first.leaseTask({ taskId: "task-concurrent", workerId: "worker-a" }),
      second.leaseTask({ taskId: "task-concurrent", workerId: "worker-b" })
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((attempt) => attempt.status === "rejected" && attempt.reason.code === "TASK_NOT_QUEUED").length, 1);

    const task = await first.getTask("task-concurrent");
    assert.equal(task.status, "leased");
    assert.equal(task.lease.workerId, "worker-a");
    assert.equal(task.history.filter((event) => event.type === "leased").length, 1);
    assert.ok(task.history.every((event, index, history) => index === 0 || event.sequence > history[index - 1].sequence));
    const snapshot = await second.snapshot();
    assert.equal(snapshot.revision, task.revision);
  } finally {
    await f.close();
  }
});

test("exposes a monotonic snapshot revision and ordered task events for reconnect", async () => {
  const f = await fixture();
  try {
    const supervisor = await AssistantSupervisor.open(f);
    const before = await supervisor.getSnapshot();
    assert.equal(before.tasks.length, 0);

    await supervisor.createTask({ taskId: "task-snapshot", input: { capability: "launch-status-brief-v1" } });
    const lease = await supervisor.leaseTask({ taskId: "task-snapshot", workerId: "worker-snapshot" });
    await supervisor.startTask({ taskId: "task-snapshot", runId: "run-snapshot", fencingToken: lease.fencingToken });

    const after = await supervisor.snapshot();
    assert.ok(after.revision > before.revision);
    const task = after.tasks.find((candidate) => candidate.taskId === "task-snapshot");
    assert.ok(task, "snapshot must include the task projection");
    assert.deepEqual(task.history.map((event) => event.type), ["created", "leased", "started"]);
    assert.ok(task.history.every((event, index, events) => index === 0 || event.sequence > events[index - 1].sequence));
    assert.ok(task.revision <= after.revision);
  } finally {
    await f.close();
  }
});

test("makes cancellation idempotent and fences a late worker completion", async () => {
  const f = await fixture();
  try {
    const supervisor = await AssistantSupervisor.open(f);
    await supervisor.createTask({ taskId: "task-cancel-race", input: { capability: "launch-status-brief-v1" } });
    const lease = await supervisor.leaseTask({ taskId: "task-cancel-race", workerId: "worker-cancel" });
    await supervisor.startTask({ taskId: "task-cancel-race", runId: "run-cancel", fencingToken: lease.fencingToken });

    const cancelled = await supervisor.cancelTask({ taskId: "task-cancel-race", reason: "user-requested" });
    const duplicate = await supervisor.cancelTask({ taskId: "task-cancel-race", reason: "retry-of-user-request" });
    assert.equal(cancelled.status, "cancelled");
    assert.deepEqual(duplicate, cancelled);
    assert.equal(cancelled.history.filter((event) => event.type === "cancelled").length, 1);
    await assert.rejects(
      supervisor.completeTask({ taskId: "task-cancel-race", runId: "run-cancel", fencingToken: lease.fencingToken, artifacts: [] }),
      staleToken
    );
  } finally {
    await f.close();
  }
});

test("rejects artifact receipts that traverse or resolve through a symlink", async () => {
  const f = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "ev-supervisor-artifact-outside-"));
  try {
    const supervisor = await AssistantSupervisor.open(f);
    await supervisor.createTask({ taskId: "task-artifact-path", input: {} });
    const lease = await supervisor.leaseTask({ taskId: "task-artifact-path", workerId: "worker-artifact" });
    await supervisor.startTask({ taskId: "task-artifact-path", runId: "run-artifact", fencingToken: lease.fencingToken });
    await writeFile(join(outside, "secret.txt"), "secret\n");
    const traversal = { artifactId: "escape", relativePath: "../escape.txt", sha256: "0".repeat(64), bytes: 0 };
    const symlink = join(f.artifactRoot, "linked.txt");
    const { symlink: createSymlink } = await import("node:fs/promises");
    await createSymlink(join(outside, "secret.txt"), symlink);
    const linked = { artifactId: "linked", relativePath: "linked.txt", sha256: "0".repeat(64), bytes: 7 };

    await assert.rejects(
      supervisor.completeTask({ taskId: "task-artifact-path", runId: "run-artifact", fencingToken: lease.fencingToken, artifacts: [traversal] }),
      invalidReceipt
    );
    await assert.rejects(
      supervisor.completeTask({ taskId: "task-artifact-path", runId: "run-artifact", fencingToken: lease.fencingToken, artifacts: [linked] }),
      invalidReceipt
    );
    assert.equal((await supervisor.getTask("task-artifact-path")).status, "running");
  } finally {
    await f.close();
    await rm(outside, { recursive: true, force: true });
  }
});

test("persists replay-safe cancel commands and rejects stale task revisions", async () => {
  const f = await fixture();
  try {
    const supervisor = await AssistantSupervisor.open(f);
    const created = await supervisor.createTask({ taskId: "task-command", input: {} });
    await assert.rejects(
      supervisor.commandTask({ taskId: "task-command", commandId: "cancel-stale", type: "cancel", expectedRevision: created.revision + 1 }),
      (error) => error?.code === "TASK_REVISION_CONFLICT"
    );
    const first = await supervisor.commandTask({ taskId: "task-command", commandId: "cancel-1", type: "cancel", expectedRevision: created.revision });
    const replay = await supervisor.commandTask({ taskId: "task-command", commandId: "cancel-1", type: "cancel", expectedRevision: created.revision });
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.task.status, "cancelled");
    assert.equal(replay.task.history.filter((event) => event.type === "cancelled").length, 1);
  } finally {
    await f.close();
  }
});

test("reads only a completed artifact by its verified receipt id", async () => {
  const f = await fixture();
  try {
    const supervisor = await AssistantSupervisor.open(f);
    await supervisor.createTask({ taskId: "task-download", input: {} });
    const lease = await supervisor.leaseTask({ taskId: "task-download", workerId: "worker-a" });
    await supervisor.startTask({ taskId: "task-download", runId: "run-download", fencingToken: lease.fencingToken });
    const receipt = await receiptFor(f.artifactRoot, "task-download/brief.md", "verified brief\n");
    receipt.artifactId = "artifact-download";
    await supervisor.completeTask({ taskId: "task-download", runId: "run-download", fencingToken: lease.fencingToken, artifacts: [receipt] });
    const artifact = await supervisor.readArtifact("artifact-download");
    assert.equal(artifact.taskId, "task-download");
    assert.equal(artifact.filename, "brief.md");
    assert.equal(artifact.contents.toString("utf8"), "verified brief\n");
    await assert.rejects(supervisor.readArtifact("missing"), (error) => error?.code === "ARTIFACT_NOT_FOUND");
  } finally {
    await f.close();
  }
});
