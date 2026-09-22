import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScopedWorkspace, SCOPED_WORKSPACE_LIMITS } from "../lib/scoped-workspace.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ev-scoped-workspace-"));
  const outside = await mkdtemp(join(tmpdir(), "ev-scoped-outside-"));
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "hello.txt"), "hello workspace\n");
  await writeFile(join(outside, "secret.txt"), "outside secret\n");
  return {
    root,
    outside,
    async close() {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    },
  };
}

test("reads, writes, lists, and greps only workspace-relative files", async () => {
  const f = await fixture();
  try {
    const workspace = await ScopedWorkspace.open(f.root);
    assert.equal(await workspace.read("hello.txt"), "hello workspace\n");
    assert.deepEqual(await workspace.write("nested/result.txt", "needle\nsecond\n"), { path: "nested/result.txt", bytes: 14 });
    assert.deepEqual((await workspace.list("nested")).map((entry) => entry.path), ["nested/result.txt"]);
    assert.deepEqual(await workspace.grep("needle"), [{ path: "nested/result.txt", line: 1, text: "needle" }]);
    assert.equal(await readFile(join(f.root, "nested/result.txt"), "utf8"), "needle\nsecond\n");
  } finally {
    await f.close();
  }
});

test("denies absolute paths, traversal, and symlinks that escape the workspace", async () => {
  const f = await fixture();
  try {
    await symlink(join(f.outside, "secret.txt"), join(f.root, "outside-file"));
    await symlink(f.outside, join(f.root, "outside-dir"));
    const workspace = await ScopedWorkspace.open(f.root);
    await assert.rejects(workspace.read("../outside/secret.txt"), { code: "PATH_ESCAPE" });
    await assert.rejects(workspace.read(join(f.outside, "secret.txt")), { code: "PATH_ESCAPE" });
    await assert.rejects(workspace.read("outside-file"), { code: "PATH_ESCAPE" });
    await assert.rejects(workspace.read("outside-dir/secret.txt"), { code: "PATH_ESCAPE" });
    await assert.rejects(workspace.write("outside-file", "overwrite"), { code: "PATH_ESCAPE" });
  } finally {
    await f.close();
  }
});

test("enforces bounded file I/O and rejects command injection arguments", async () => {
  const f = await fixture();
  try {
    const workspace = await ScopedWorkspace.open(f.root, { maxWriteBytes: 8 });
    await assert.rejects(workspace.write("too-large.txt", "123456789"), { code: "IO_TOO_LARGE" });
    await assert.rejects(workspace.run("sh", ["-c", "echo unsafe"]), { code: "COMMAND_DENIED" });
    await assert.rejects(workspace.run("printf", ["ok; touch escaped"]), { code: "ARGUMENT_DENIED" });
    await assert.rejects(workspace.run("printf", ["../outside"]), { code: "ARGUMENT_DENIED" });
  } finally {
    await f.close();
  }
});

test("runs a harmless allowlisted command with bounded output and process cleanup", async () => {
  const f = await fixture();
  try {
    const workspace = await ScopedWorkspace.open(f.root, { maxCommandTimeoutMs: 5_000 });
    const result = await workspace.run("printf", ["hello-scoped-workspace"]);
    assert.equal(result.stdout, "hello-scoped-workspace");
    assert.equal(result.stderr, "");
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(typeof result.sandboxed, "boolean");
    assert.equal(result.limits.maxOutputBytes, SCOPED_WORKSPACE_LIMITS.maxCommandOutputBytes);
  } finally {
    await f.close();
  }
});

test("times out commands and bounds combined stdout/stderr", async () => {
  const f = await fixture();
  try {
    const workspace = await ScopedWorkspace.open(f.root, { maxCommandTimeoutMs: 500, maxCommandOutputBytes: 32 });
    const timeout = await workspace.run("sleep", ["2"], { timeoutMs: 50 });
    assert.equal(timeout.timedOut, true);
    await assert.rejects(workspace.run("printf", ["123456789012345678901234567890123456789"]), { code: "OUTPUT_TOO_LARGE" });
  } finally {
    await f.close();
  }
});
