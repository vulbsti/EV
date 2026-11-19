import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { AssistantSupervisor } from "../lib/assistant-supervisor.mjs";
import { openStore } from "../lib/store.mjs";
import { assertLoopbackHost, PRIVATE_MODES, securePrivateTreeSync } from "../lib/file-permissions.mjs";
import { localRequestRejection } from "../lib/local-request-guard.mjs";
import { openClawCommand } from "../lib/openclaw-worker-adapter.mjs";
import { createFiles } from "../lib/place.mjs";

async function mode(path) {
  return (await stat(path)).mode & 0o777;
}

test("private data startup corrects existing directory, database, session, and artifact modes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-security-boundary-"));
  const workerRoot = join(root, "work");
  const artifactRoot = join(root, "files");
  const sessionRoot = join(workerRoot, "sessions");
  const path = join(root, "ev.sqlite");
  try {
    await mkdir(workerRoot, { recursive: true, mode: 0o755 });
    const initial = openStore({ path });
    await AssistantSupervisor.open({ store: initial, artifactRoot });
    initial.close();
    await chmod(root, 0o755);
    await chmod(artifactRoot, 0o755);
    await chmod(path, 0o644);

    const store = openStore({ path });
    await AssistantSupervisor.open({ store, artifactRoot });
    assert.equal(await mode(root), PRIVATE_MODES.directory);
    assert.equal(await mode(artifactRoot), PRIVATE_MODES.directory);
    assert.equal(await mode(path), PRIVATE_MODES.file);
    store.close();

    await writeFile(join(artifactRoot, "old.md"), "private", { mode: 0o644 });
    await mkdir(sessionRoot, { recursive: true, mode: 0o755 });
    await writeFile(join(sessionRoot, "old.json"), "private", { mode: 0o644 });
    securePrivateTreeSync(workerRoot);
    securePrivateTreeSync(artifactRoot);
    assert.equal(await mode(workerRoot), PRIVATE_MODES.directory);
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

test("a sandboxed OpenClaw worker mounts only its goal, its config and its own home", () => {
  const { command, args } = openClawCommand({
    executable: "openclaw", args: ["agent"], sandbox: { image: "ev-openclaw", mountRoot: "/ev/workspaces/goal" },
    workspacePath: "/ev/workspaces/goal/tasks/t1", sessionDir: "/ev/sessions/t1", homeDir: "/ev/homes/t1", runId: "run-1234567890ab", taskId: "t1"
  });
  assert.equal(command, "docker");
  const mounts = args.flatMap((arg, index) => args[index - 1] === "-v" ? [arg] : []);
  assert.deepEqual(mounts, ["/ev/workspaces/goal:/ev/workspaces/goal", "/ev/homes/t1:/ev/homes/t1", "/ev/sessions/t1:/ev/sessions/t1:ro"]);
  for (const flag of ["--cap-drop", "--memory", "--pids-limit", "--cpus"]) assert.ok(args.includes(flag), flag);
  assert.ok(!args.includes("--privileged") && !args.some((arg) => arg.includes("docker.sock")));
});

test("on the person's computer an agent reads the home, never its secrets or KenWise's data, and writes only what was granted", async () => {
  const home = await mkdtemp(join(tmpdir(), "ev-home-"));
  try {
    for (const dir of [".ssh", "proj/site", "docs", "kenwise/data/work/goal"]) await mkdir(join(home, dir), { recursive: true });
    await writeFile(join(home, ".netrc"), "pw");
    await writeFile(join(home, "proj/site/.env"), "SECRET=1");
    const saved = new Map();
    const files = createFiles({ store: { setting: (key) => saved.get(key), saveSetting: (key, value) => saved.set(key, value) }, place: "local", home, privatePaths: [join(home, "kenwise/data")] });
    const task = { taskId: "t1", input: { sharedWorkspace: "goal/shared" } };
    const mounts = (files) => {
      const { args } = openClawCommand({ executable: "openclaw", args: ["agent"], sandbox: { image: "ev-openclaw", mountRoot: join(home, "kenwise/data/work/goal") }, files, cli: "docker",
        workspacePath: join(home, "kenwise/data/work/goal/tasks/t1"), sessionDir: "/ev/sessions/t1", homeDir: "/ev/homes/t1", runId: "run-1234567890ab", taskId: "t1" });
      return args.flatMap((arg, index) => args[index - 1] === "--mount" ? [arg] : []);
    };
    const before = mounts(files.forTask(task));
    assert.ok(before.includes(`type=bind,src=${home},dst=${home},readonly`), "the home is not shown read-only");
    for (const secret of [".ssh", "kenwise/data"]) assert.ok(before.some((mount) => mount.startsWith("type=tmpfs") && mount.includes(`dst=${join(home, secret)},`)), `${secret} is not hidden`);
    assert.ok(before.includes(`type=bind,src=/dev/null,dst=${join(home, ".netrc")},readonly`), ".netrc is not hidden");
    assert.ok(!before.some((mount) => mount.startsWith("type=bind") && !mount.endsWith(",readonly")), "something of the machine is writable without a grant");
    assert.throws(() => files.grant({ folder: "~/.ssh", source: "settings" }), /hidden/);
    assert.throws(() => files.grant({ folder: "~/kenwise/data/work", source: "settings" }), /KenWise's own data/);
    files.grant({ folder: "~/proj/site", scope: "work", task, source: "settings" });
    const after = mounts(files.forTask(task));
    assert.ok(after.includes(`type=bind,src=${join(home, "proj/site")},dst=${join(home, "proj/site")}`), "the granted folder is not writable");
    assert.ok(after.includes(`type=bind,src=/dev/null,dst=${join(home, "proj/site/.env")},readonly`), "a .env in a writable folder is not hidden");
    assert.ok(!mounts(files.forTask({ taskId: "t2", input: {} })).some((mount) => mount.includes("proj/site,dst") && !mount.endsWith("readonly")), "a grant for one piece of work reached another");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a sandboxed worker gets the model relay's socket and no key in its environment", () => {
  const { args } = openClawCommand({
    executable: "openclaw", args: ["agent"], sandbox: { image: "ev-openclaw", mountRoot: "/ev/workspaces/goal" },
    workspacePath: "/ev/workspaces/goal/tasks/t1", sessionDir: "/ev/sessions/t1", homeDir: "/ev/homes/t1", runId: "run-1234567890ab", taskId: "t1", relaySocket: "/tmp/ev-relay-abc.sock"
  });
  const mounts = args.flatMap((arg, index) => args[index - 1] === "-v" ? [arg] : []);
  assert.ok(mounts.includes("/tmp/ev-relay-abc.sock:/tmp/ev-relay-abc.sock"));
  const passed = args.flatMap((arg, index) => args[index - 1] === "-e" ? [arg] : []);
  assert.deepEqual(passed.map((entry) => entry.split("=")[0]).sort(), ["HOME", "OPENCLAW_CONFIG_PATH"]);
  const image = args.indexOf("ev-openclaw");
  assert.deepEqual(args.slice(image + 1, image + 3), ["sh", "-c"]);
  assert.deepEqual(args.slice(-2), ["openclaw", "agent"]);
});
