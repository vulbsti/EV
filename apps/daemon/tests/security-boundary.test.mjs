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

test("on the person's computer an agent reads the home, never its secrets or KenWise, and writes only what was granted", async () => {
  const home = await mkdtemp(join(tmpdir(), "ev-home-"));
  try {
    for (const dir of [".ssh", "proj/site", "docs", "kenwise/data/work/goal", "kenwise/apps"]) await mkdir(join(home, dir), { recursive: true });
    await writeFile(join(home, ".netrc"), "pw");
    await writeFile(join(home, ".bashrc"), "");
    await writeFile(join(home, "proj/site/.env"), "SECRET=1");
    const saved = new Map();
    const files = createFiles({ store: { setting: (key) => saved.get(key), saveSetting: (key, value) => saved.set(key, value) }, place: "local", home,
      privatePaths: [join(home, "kenwise/data")], programPaths: [join(home, "kenwise")] });
    const task = { taskId: "t1", input: { sharedWorkspace: "goal/shared" } };
    // Each --mount as docker reads it: one CSV record of key=value fields.
    const mounts = (files) => {
      const { args } = openClawCommand({ executable: "openclaw", args: ["agent"], sandbox: { image: "ev-openclaw", mountRoot: join(home, "kenwise/data/work/goal") }, files, cli: "docker",
        workspacePath: join(home, "kenwise/data/work/goal/tasks/t1"), sessionDir: "/ev/sessions/t1", homeDir: "/ev/homes/t1", runId: "run-1234567890ab", taskId: "t1" });
      return args.flatMap((arg, index) => args[index - 1] === "--mount" ? [Object.fromEntries(csv(arg).map((field) => field.includes("=") ? [field.slice(0, field.indexOf("=")), field.slice(field.indexOf("=") + 1)] : [field, true]))] : []);
    };
    const writable = (list) => list.filter((mount) => mount.type === "bind" && !mount.readonly).map((mount) => mount.dst);
    const before = mounts(files.forTask(task));
    assert.ok(before.some((mount) => mount.type === "bind" && mount.dst === home && mount.readonly), "the home is not shown read-only");
    for (const secret of [".ssh", "kenwise/data"]) assert.ok(before.some((mount) => mount.type === "tmpfs" && mount.dst === join(home, secret)), `${secret} is not hidden`);
    assert.ok(before.some((mount) => mount.src === "/dev/null" && mount.dst === join(home, ".netrc")), ".netrc is not hidden");
    assert.deepEqual(writable(before), [], "something of the machine is writable without a grant");
    assert.throws(() => files.grant({ folder: "~/.ssh", source: "settings" }), /hidden/);
    assert.throws(() => files.grant({ folder: "~/kenwise/apps", source: "settings" }), /KenWise itself/);
    assert.throws(() => files.grant({ folder: "~", source: "message:m1" }), /too wide/);
    files.grant({ folder: "~/proj/site", scope: "work", task, source: "message:m1" });
    const after = mounts(files.forTask(task));
    assert.deepEqual(writable(after), [join(home, "proj/site")], "the granted folder is not the one writable folder");
    assert.ok(after.some((mount) => mount.src === "/dev/null" && mount.dst === join(home, "proj/site/.env")), "a .env in a writable folder is not hidden");
    assert.deepEqual(writable(mounts(files.forTask({ taskId: "t2", input: {} }))), [], "a grant for one piece of work reached another");
    // The home granted with the person's own click: KenWise and what the shell runs at start stay read-only.
    files.grant({ folder: "~", source: "settings" });
    const wide = mounts(files.forTask(task));
    for (const path of [join(home, "kenwise"), join(home, ".bashrc")]) assert.ok(wide.some((mount) => mount.dst === path && mount.readonly), `${path} is writable under a home grant`);
    // A folder named to look like more mount fields stays one path.
    const trick = join(home, "proj/site/d,src=", "x", ".ssh,dst=");
    await mkdir(trick, { recursive: true });
    await writeFile(join(trick, ".env"), "planted");
    const planted = mounts(files.forTask(task)).find((mount) => mount.dst?.endsWith(".env") && mount.dst.includes("d,src="));
    assert.equal(planted?.dst, join(trick, ".env"), "a comma in a folder name changed a mount");
    assert.equal(planted.src, "/dev/null");
    assert.throws(() => openClawCommand({ executable: "openclaw", args: [], sandbox: { image: "i", mountRoot: "/w" }, files: files.forTask(task), cli: "podman", workspacePath: "/w", sessionDir: "/s", homeDir: "/h", runId: "run-1234567890ab", taskId: "t1" }), /cannot be started safely/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

/** Splits one CSV record the way docker reads --mount: quoted fields may hold commas, and "" is a quote. */
function csv(line) {
  const fields = [];
  let field = "", quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') { field += '"'; index++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { fields.push(field); field = ""; }
    else field += char;
  }
  return [...fields, field];
}

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
