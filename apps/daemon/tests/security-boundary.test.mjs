import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { AssistantMemoryStore } from "../lib/assistant-memory.mjs";
import { AssistantSupervisor } from "../lib/assistant-supervisor.mjs";
import { assertLoopbackHost, PRIVATE_MODES, securePrivateTreeSync } from "../lib/file-permissions.mjs";
import { localRequestRejection } from "../lib/local-request-guard.mjs";
import { openClawCommand } from "../lib/openclaw-worker-adapter.mjs";

async function mode(path) {
  return (await stat(path)).mode & 0o777;
}

test("private data startup corrects existing directory, database, session, and artifact modes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-security-boundary-"));
  const workerRoot = join(root, "worker");
  const artifactRoot = join(workerRoot, "artifacts");
  const sessionRoot = join(workerRoot, "sessions");
  const statePath = join(workerRoot, "supervisor.sqlite");
  const memoryPath = join(root, "memory.sqlite");
  try {
    await mkdir(workerRoot, { recursive: true, mode: 0o755 });
    const initialSupervisor = await AssistantSupervisor.open({ statePath, artifactRoot });
    initialSupervisor.close();
    const initialMemory = AssistantMemoryStore.open({ path: memoryPath });
    initialMemory.close();
    await chmod(root, 0o755);
    await chmod(workerRoot, 0o755);
    await chmod(artifactRoot, 0o755);
    await chmod(statePath, 0o644);
    await chmod(memoryPath, 0o644);

    const supervisor = await AssistantSupervisor.open({ statePath, artifactRoot });
    assert.equal(await mode(workerRoot), PRIVATE_MODES.directory);
    assert.equal(await mode(artifactRoot), PRIVATE_MODES.directory);
    assert.equal(await mode(statePath), PRIVATE_MODES.file);
    supervisor.close();

    const memory = AssistantMemoryStore.open({ path: memoryPath });
    assert.equal(await mode(memoryPath), PRIVATE_MODES.file);
    memory.close();

    await writeFile(join(artifactRoot, "old.md"), "private", { mode: 0o644 });
    await mkdir(sessionRoot, { recursive: true, mode: 0o755 });
    await writeFile(join(sessionRoot, "old.json"), "private", { mode: 0o644 });
    securePrivateTreeSync(workerRoot);
    assert.equal(await mode(sessionRoot), PRIVATE_MODES.directory);
    assert.equal(await mode(join(sessionRoot, "old.json")), PRIVATE_MODES.file);
    assert.equal(await mode(join(artifactRoot, "old.md")), PRIVATE_MODES.file);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unauthenticated daemon host validation fails closed for non-loopback binds", () => {
  assert.equal(assertLoopbackHost("127.0.0.1"), "127.0.0.1");
  assert.equal(assertLoopbackHost("::1"), "::1");
  assert.equal(assertLoopbackHost("127.42.0.9"), "127.42.0.9");
  assert.throws(() => assertLoopbackHost("0.0.0.0"), { code: "EV_HOST_NOT_LOOPBACK" });
  assert.throws(() => assertLoopbackHost("localhost"), { code: "EV_HOST_NOT_LOOPBACK" });
  assert.throws(() => assertLoopbackHost("192.168.1.10"), { code: "EV_HOST_NOT_LOOPBACK" });
});

test("local request guard admits only this daemon's loopback Host and Origin", () => {
  const port = 4317;
  for (const host of ["127.0.0.1:4317", "localhost:4317", "[::1]:4317"]) assert.equal(localRequestRejection({ host, port }), null, host);
  assert.equal(localRequestRejection({ host: "127.0.0.1:4317", origin: "http://localhost:4317", port }), null);
  const rejected = [
    { host: undefined },
    { host: "a b" },
    { host: "attacker.example:4317" },
    { host: "127.0.0.1" },
    { host: "127.0.0.1:9999" },
    { host: "127.0.0.1:4317", origin: "https://evil.example" },
    { host: "127.0.0.1:4317", origin: "null" },
    { host: "127.0.0.1:4317", origin: "http://127.0.0.1:5000" }
  ];
  for (const request of rejected) assert.ok(localRequestRejection({ ...request, port }), JSON.stringify(request));
});

test("a sandboxed OpenClaw worker mounts only its goal, its config and an EV-owned home", () => {
  const { command, args } = openClawCommand({
    executable: "openclaw", args: ["agent"], sandbox: { image: "ev-openclaw", mountRoot: "/ev/workspaces/goal" },
    workspacePath: "/ev/workspaces/goal/tasks/t1", sessionDir: "/ev/sessions/t1", homeDir: "/ev/openclaw-home", runId: "run-1234567890ab", taskId: "t1"
  });
  assert.equal(command, "docker");
  const mounts = args.flatMap((arg, index) => args[index - 1] === "-v" ? [arg] : []);
  assert.deepEqual(mounts, ["/ev/workspaces/goal:/ev/workspaces/goal", "/ev/openclaw-home:/ev/openclaw-home", "/ev/sessions/t1:/ev/sessions/t1:ro"]);
  for (const flag of ["--cap-drop", "--memory", "--pids-limit", "--cpus"]) assert.ok(args.includes(flag), flag);
  assert.ok(!args.includes("--privileged") && !args.some((arg) => arg.includes("docker.sock")));
});
