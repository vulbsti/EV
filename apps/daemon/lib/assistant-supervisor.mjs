import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

function clone(value) {
  return structuredClone(value);
}

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function bounded(value, name) {
  const encoded = JSON.stringify(value ?? null);
  if (Buffer.byteLength(encoded) > 64_000) throw codedError("PAYLOAD_TOO_LARGE", `${name} exceeds 64 KB`);
  return JSON.parse(encoded);
}

function requireTask(state, taskId) {
  const task = state.tasks[taskId];
  if (!task) throw codedError("TASK_NOT_FOUND", `Unknown task: ${taskId}`);
  return task;
}

function addEvent(task, type, data = {}) {
  task.history.push({ eventId: randomUUID(), type, at: new Date().toISOString(), ...data });
  task.updatedAt = task.history.at(-1).at;
}

async function verifyReceipt(artifactRoot, receipt) {
  let handle;
  try {
    if (!receipt || typeof receipt.artifactId !== "string" || !receipt.artifactId || typeof receipt.relativePath !== "string" || !receipt.relativePath || typeof receipt.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(receipt.sha256) || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 0) throw new Error("bad receipt");
    const root = await realpath(artifactRoot);
    const requested = resolve(root, receipt.relativePath);
    if (requested !== root && !requested.startsWith(`${root}${sep}`)) throw new Error("outside artifact root");
    const absolute = await realpath(requested);
    if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) throw new Error("outside artifact root");
    handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size !== receipt.bytes) throw new Error("size mismatch");
    const contents = await handle.readFile();
    const digest = createHash("sha256").update(contents).digest("hex");
    if (digest !== receipt.sha256) throw new Error("hash mismatch");
  } catch {
    throw codedError("ARTIFACT_RECEIPT_INVALID", `Artifact receipt is invalid: ${receipt?.relativePath ?? "unknown"}`);
  } finally {
    await handle?.close();
  }
}

export class AssistantSupervisor {
  static async open({ statePath, artifactRoot }) {
    await mkdir(dirname(statePath), { recursive: true });
    await mkdir(artifactRoot, { recursive: true });
    let state = { schemaVersion: 1, tasks: {} };
    try { state = JSON.parse(await readFile(statePath, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const supervisor = new AssistantSupervisor({ statePath, artifactRoot, state });
    await supervisor.persist();
    return supervisor;
  }

  constructor({ statePath, artifactRoot, state }) {
    this.statePath = statePath;
    this.artifactRoot = artifactRoot;
    this.state = state;
  }

  async persist() {
    const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.statePath);
  }

  async createTask({ taskId, input }) {
    if (this.state.tasks[taskId]) return clone(this.state.tasks[taskId]);
    const timestamp = new Date().toISOString();
    const task = { taskId, input: bounded(input, "task input"), status: "queued", lease: null, run: null, result: null, artifacts: [], error: null, createdAt: timestamp, updatedAt: timestamp, history: [] };
    addEvent(task, "created");
    this.state.tasks[taskId] = task;
    await this.persist();
    return clone(task);
  }

  async leaseTask({ taskId, workerId }) {
    const task = requireTask(this.state, taskId);
    if (task.status !== "queued") throw codedError("TASK_NOT_QUEUED", `Task ${taskId} is ${task.status}`);
    const lease = { leaseId: randomUUID(), fencingToken: randomUUID(), workerId };
    task.lease = lease;
    task.status = "leased";
    addEvent(task, "leased", { workerId, leaseId: lease.leaseId });
    await this.persist();
    return clone(lease);
  }

  assertToken(task, fencingToken) {
    if (!task.lease || task.lease.fencingToken !== fencingToken) throw codedError("STALE_FENCING_TOKEN", "The worker lease is no longer current");
  }

  async startTask({ taskId, runId, fencingToken }) {
    const task = requireTask(this.state, taskId);
    this.assertToken(task, fencingToken);
    if (task.status === "running" && task.run?.runId === runId) return clone(task);
    if (task.status !== "leased" && task.status !== "queued") throw codedError("INVALID_TASK_TRANSITION", `Cannot start task in ${task.status}`);
    task.run = { runId, workerId: task.lease.workerId, startedAt: new Date().toISOString() };
    task.status = "running";
    addEvent(task, "started", { runId });
    await this.persist();
    return clone(task);
  }

  async completeTask({ taskId, runId, fencingToken, result = null, artifacts = [] }) {
    const task = requireTask(this.state, taskId);
    if (task.status === "completed" && task.run?.runId === runId && task.lease?.fencingToken === fencingToken) return clone(task);
    this.assertToken(task, fencingToken);
    if (task.status !== "running" || task.run?.runId !== runId) throw codedError("INVALID_TASK_TRANSITION", "Only the current running task can complete");
    for (const receipt of artifacts) await verifyReceipt(this.artifactRoot, receipt);
    task.status = "completed";
    task.result = bounded(result, "task result");
    task.artifacts = clone(artifacts);
    addEvent(task, "completed", { runId });
    await this.persist();
    return clone(task);
  }

  async failTask({ taskId, runId, fencingToken, error }) {
    const task = requireTask(this.state, taskId);
    this.assertToken(task, fencingToken);
    if (task.status !== "running" || task.run?.runId !== runId) throw codedError("INVALID_TASK_TRANSITION", "Only the current running task can fail");
    task.status = "failed";
    task.error = bounded(error ?? { code: "WORKER_ERROR", message: "Worker failed" }, "task error");
    addEvent(task, "failed", { runId, code: task.error.code });
    await this.persist();
    return clone(task);
  }

  async cancelTask({ taskId, reason }) {
    const task = requireTask(this.state, taskId);
    if (["completed", "failed", "cancelled"].includes(task.status)) return clone(task);
    task.status = "cancelled";
    task.lease = null;
    addEvent(task, "cancelled", { reason });
    await this.persist();
    return clone(task);
  }

  async recover() {
    const recoveredTaskIds = [];
    for (const task of Object.values(this.state.tasks)) {
      if (!['leased', 'running'].includes(task.status)) continue;
      task.status = "queued";
      task.lease = null;
      addEvent(task, "recovered", { previousRunId: task.run?.runId ?? null });
      recoveredTaskIds.push(task.taskId);
    }
    if (recoveredTaskIds.length) await this.persist();
    return { recoveredTaskIds };
  }

  async getTask(taskId) {
    return clone(requireTask(this.state, taskId));
  }

  async listTasks() {
    return clone(Object.values(this.state.tasks).sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  }
}
