import { constants } from "node:fs";
import {
  access,
  lstat,
  open,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// These defaults are deliberately small. Callers can lower them, but cannot
// raise them beyond the hard caps in this module.
export const SCOPED_WORKSPACE_LIMITS = Object.freeze({
  maxReadBytes: 1 * 1024 * 1024,
  maxWriteBytes: 1 * 1024 * 1024,
  maxListEntries: 2_000,
  maxGrepMatches: 500,
  maxGrepBytes: 1 * 1024 * 1024,
  maxCommandOutputBytes: 256 * 1024,
  maxCommandTimeoutMs: 30_000,
  maxCommandArgs: 64,
  maxCommandArgBytes: 8 * 1024,
  maxCommandArgTotalBytes: 32 * 1024,
});

const COMMANDS = new Set([
  "cat", "date", "echo", "false", "grep", "head", "ls", "node",
  "printf", "pwd", "sleep", "sort", "tail", "tr", "true", "uniq", "wc",
]);
const FILE_READING_COMMANDS = new Set(["cat", "grep", "head", "ls", "sort", "tail", "uniq", "wc"]);
const DANGEROUS_ARGUMENTS = new Set([
  "-c", "--command", "-e", "--eval", "--exec", "--require", "-r",
  "--inspect", "--inspect-brk", "--experimental-loader", "--import",
]);
const SHELL_SYNTAX = /[\u0000\u0009\u000a\u000d;|&`<>]/;

function error(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function numberLimit(value, name, hardCap, fallback) {
  const chosen = value ?? fallback;
  if (!Number.isSafeInteger(chosen) || chosen < 1 || chosen > hardCap) {
    throw error("INVALID_LIMIT", `${name} must be an integer between 1 and ${hardCap}`);
  }
  return chosen;
}

function isInside(root, candidate) {
  const comparison = relative(root, candidate);
  return comparison === "" || (comparison !== ".." && !comparison.startsWith(`..${sep}`) && !isAbsolute(comparison));
}

function assertRelativePath(value, field = "path") {
  if (typeof value !== "string" || value.length === 0) throw error("INVALID_PATH", `${field} must be a non-empty relative path`);
  if (value.includes("\0") || value.includes("\\")) throw error("INVALID_PATH", `${field} contains a forbidden character`);
  if (isAbsolute(value)) throw error("PATH_ESCAPE", `${field} must not be absolute`);
  const segments = value.split("/");
  if (segments.some((segment) => segment === "..")) throw error("PATH_ESCAPE", `${field} traversal is denied`);
  return value;
}

function assertText(value, field) {
  if (!(typeof value === "string" || Buffer.isBuffer(value) || value instanceof Uint8Array)) {
    throw error("INVALID_INPUT", `${field} must be text or bytes`);
  }
  return Buffer.from(value);
}

async function pathRealpathInside(root, relativePath, { allowMissing = false } = {}) {
  assertRelativePath(relativePath);
  const lexical = resolve(root, relativePath);
  if (!isInside(root, lexical)) throw error("PATH_ESCAPE", "path escapes the workspace");
  try {
    const actual = await realpath(lexical);
    if (!isInside(root, actual)) throw error("PATH_ESCAPE", "symlink escapes the workspace");
    return { lexical, actual };
  } catch (caught) {
    if (caught?.code !== "ENOENT" || !allowMissing) throw caught;
    const parent = await pathRealpathInside(root, dirname(relative(root, lexical) || "."), { allowMissing: false });
    return { lexical, actual: lexical, parent: parent.actual };
  }
}

async function safeExistingPath(root, relativePath) {
  const resolvedPath = await pathRealpathInside(root, relativePath);
  const metadata = await lstat(resolvedPath.actual);
  if (metadata.isSymbolicLink()) throw error("PATH_ESCAPE", "symlink paths are denied");
  return { ...resolvedPath, metadata };
}

async function safeWritePath(root, relativePath) {
  const resolvedPath = await pathRealpathInside(root, relativePath, { allowMissing: true });
  const parent = await realpath(dirname(resolvedPath.lexical));
  if (!isInside(root, parent)) throw error("PATH_ESCAPE", "parent escapes the workspace");
  try {
    const existing = await lstat(resolvedPath.lexical);
    if (existing.isSymbolicLink()) throw error("PATH_ESCAPE", "symlink writes are denied");
    if (existing.isDirectory()) throw error("NOT_A_FILE", "cannot write a directory");
  } catch (caught) {
    if (caught?.code !== "ENOENT") throw caught;
  }
  return resolvedPath.lexical;
}

async function findBubblewrap() {
  for (const candidate of ["/usr/bin/bwrap", "/bin/bwrap"]) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue to the next conventional location.
    }
  }
  return null;
}

function commandPathLooksUnsafe(argument) {
  if (isAbsolute(argument)) return true;
  if (argument.split("/").some((segment) => segment === "..")) return true;
  // Reject absolute paths hidden in common option forms, such as
  // --output=/tmp/out, while permitting ordinary workspace-relative args.
  return /=(\/|[A-Za-z]:[\\/])/.test(argument);
}

function assertCommand(command, args) {
  if (typeof command !== "string" || !/^[a-z][a-z0-9_-]*$/.test(command) || !COMMANDS.has(command)) {
    throw error("COMMAND_DENIED", `command is not in the allowlist: ${command}`);
  }
  if (!Array.isArray(args) || args.length > SCOPED_WORKSPACE_LIMITS.maxCommandArgs) {
    throw error("INVALID_COMMAND", `command accepts at most ${SCOPED_WORKSPACE_LIMITS.maxCommandArgs} arguments`);
  }
  let totalBytes = 0;
  for (const argument of args) {
    if (typeof argument !== "string") throw error("INVALID_COMMAND", "command arguments must be strings");
    const bytes = Buffer.byteLength(argument);
    totalBytes += bytes;
    if (bytes > SCOPED_WORKSPACE_LIMITS.maxCommandArgBytes || totalBytes > SCOPED_WORKSPACE_LIMITS.maxCommandArgTotalBytes) {
      throw error("INVALID_COMMAND", "command arguments exceed the configured size limit");
    }
    if (SHELL_SYNTAX.test(argument) || DANGEROUS_ARGUMENTS.has(argument) || commandPathLooksUnsafe(argument)) {
      throw error("ARGUMENT_DENIED", `unsafe command argument denied: ${argument}`);
    }
  }
}

async function readBoundedFile(absolute, maxBytes) {
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw error("NOT_A_FILE", "path is not a regular file");
    if (metadata.size > maxBytes) throw error("IO_TOO_LARGE", `file exceeds ${maxBytes} bytes`);
    // Read maxBytes + 1 at most. The stat check above is only an early
    // rejection; a file can grow between stat and read.
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw error("IO_TOO_LARGE", `file exceeds ${maxBytes} bytes`);
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function collectFiles(start, maxEntries) {
  const files = [];
  const pending = [start];
  let seenEntries = 0;
  while (pending.length) {
    const current = pending.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      seenEntries += 1;
      if (seenEntries > maxEntries) throw error("IO_TOO_LARGE", `directory exceeds ${maxEntries} entries`);
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) files.push(absolute);
      // Symlinks are intentionally neither followed nor read.
    }
  }
  return files;
}

function normalizeGrepArguments(patternOrOptions, maybeOptions) {
  if (patternOrOptions && typeof patternOrOptions === "object" && !Buffer.isBuffer(patternOrOptions)) {
    return { ...patternOrOptions };
  }
  return { ...(maybeOptions ?? {}), pattern: patternOrOptions };
}

export class ScopedWorkspace {
  static async open(root, options = {}) {
    if (typeof root !== "string" || root.length === 0) throw error("INVALID_WORKSPACE", "workspace root is required");
    const actualRoot = await realpath(root);
    const metadata = await stat(actualRoot);
    if (!metadata.isDirectory()) throw error("INVALID_WORKSPACE", "workspace root must be a directory");
    return new ScopedWorkspace(actualRoot, options);
  }

  constructor(root, options = {}) {
    this.root = root;
    this.limits = Object.freeze({
      maxReadBytes: numberLimit(options.maxReadBytes, "maxReadBytes", SCOPED_WORKSPACE_LIMITS.maxReadBytes, SCOPED_WORKSPACE_LIMITS.maxReadBytes),
      maxWriteBytes: numberLimit(options.maxWriteBytes, "maxWriteBytes", SCOPED_WORKSPACE_LIMITS.maxWriteBytes, SCOPED_WORKSPACE_LIMITS.maxWriteBytes),
      maxListEntries: numberLimit(options.maxListEntries, "maxListEntries", SCOPED_WORKSPACE_LIMITS.maxListEntries, SCOPED_WORKSPACE_LIMITS.maxListEntries),
      maxGrepMatches: numberLimit(options.maxGrepMatches, "maxGrepMatches", SCOPED_WORKSPACE_LIMITS.maxGrepMatches, SCOPED_WORKSPACE_LIMITS.maxGrepMatches),
      maxGrepBytes: numberLimit(options.maxGrepBytes, "maxGrepBytes", SCOPED_WORKSPACE_LIMITS.maxGrepBytes, SCOPED_WORKSPACE_LIMITS.maxGrepBytes),
      maxCommandOutputBytes: numberLimit(options.maxCommandOutputBytes, "maxCommandOutputBytes", SCOPED_WORKSPACE_LIMITS.maxCommandOutputBytes, SCOPED_WORKSPACE_LIMITS.maxCommandOutputBytes),
      maxCommandTimeoutMs: numberLimit(options.maxCommandTimeoutMs, "maxCommandTimeoutMs", SCOPED_WORKSPACE_LIMITS.maxCommandTimeoutMs, SCOPED_WORKSPACE_LIMITS.maxCommandTimeoutMs),
      maxCommandArgs: numberLimit(options.maxCommandArgs, "maxCommandArgs", SCOPED_WORKSPACE_LIMITS.maxCommandArgs, SCOPED_WORKSPACE_LIMITS.maxCommandArgs),
      maxCommandArgBytes: numberLimit(options.maxCommandArgBytes, "maxCommandArgBytes", SCOPED_WORKSPACE_LIMITS.maxCommandArgBytes, SCOPED_WORKSPACE_LIMITS.maxCommandArgBytes),
      maxCommandArgTotalBytes: numberLimit(options.maxCommandArgTotalBytes, "maxCommandArgTotalBytes", SCOPED_WORKSPACE_LIMITS.maxCommandArgTotalBytes, SCOPED_WORKSPACE_LIMITS.maxCommandArgTotalBytes),
    });
  }

  async read(relativePath, options = {}) {
    const file = await safeExistingPath(this.root, relativePath);
    const maxBytes = numberLimit(options.maxBytes, "maxBytes", this.limits.maxReadBytes, this.limits.maxReadBytes);
    const contents = await readBoundedFile(file.actual, maxBytes);
    return contents.toString(options.encoding ?? "utf8");
  }

  async write(relativePath, value) {
    const contents = assertText(value, "contents");
    if (contents.byteLength > this.limits.maxWriteBytes) throw error("IO_TOO_LARGE", `write exceeds ${this.limits.maxWriteBytes} bytes`);
    const absolute = await safeWritePath(this.root, relativePath);
    const handle = await open(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      await handle.writeFile(contents);
    } finally {
      await handle.close();
    }
    return { path: relativePath, bytes: contents.byteLength };
  }

  async list(relativePath = ".") {
    const directory = await safeExistingPath(this.root, relativePath);
    if (!directory.metadata.isDirectory()) throw error("NOT_A_DIRECTORY", "list path is not a directory");
    const entries = await readdir(directory.actual, { withFileTypes: true });
    if (entries.length > this.limits.maxListEntries) throw error("IO_TOO_LARGE", `directory exceeds ${this.limits.maxListEntries} entries`);
    return entries.map((entry) => ({
      name: entry.name,
      path: relative(this.root, join(directory.actual, entry.name)) || ".",
      type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",
    })).sort((a, b) => a.path.localeCompare(b.path));
  }

  async grep(patternOrOptions, maybeOptions) {
    const options = normalizeGrepArguments(patternOrOptions, maybeOptions);
    if (typeof options.pattern !== "string" || options.pattern.length === 0) throw error("INVALID_PATTERN", "grep pattern must be a non-empty string");
    const startPath = options.path ?? ".";
    const target = await safeExistingPath(this.root, startPath);
    const files = target.metadata.isDirectory() ? await collectFiles(target.actual, this.limits.maxListEntries) : [target.actual];
    const regex = options.regex ? new RegExp(options.pattern, options.flags ?? "") : null;
    const results = [];
    let scannedBytes = 0;
    for (const absolute of files) {
      const contents = await readBoundedFile(absolute, this.limits.maxGrepBytes);
      scannedBytes += contents.byteLength;
      if (scannedBytes > this.limits.maxGrepBytes) throw error("IO_TOO_LARGE", `grep input exceeds ${this.limits.maxGrepBytes} bytes`);
      const lines = contents.toString("utf8").split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if ((regex ? regex.test(lines[index]) : lines[index].includes(options.pattern))) {
          results.push({ path: relative(this.root, absolute), line: index + 1, text: lines[index] });
          if (results.length >= this.limits.maxGrepMatches) return results;
          if (regex?.global) regex.lastIndex = 0;
        }
      }
    }
    return results;
  }

  async run(commandOrOptions, maybeArgs = [], maybeOptions = {}) {
    const options = commandOrOptions && typeof commandOrOptions === "object"
      ? commandOrOptions
      : { ...maybeOptions, command: commandOrOptions, args: maybeArgs };
    const command = options.command;
    const args = options.args ?? [];
    assertCommand(command, args);
    if (args.length > this.limits.maxCommandArgs) throw error("INVALID_COMMAND", "command has too many arguments");
    const timeoutMs = numberLimit(options.timeoutMs, "timeoutMs", this.limits.maxCommandTimeoutMs, this.limits.maxCommandTimeoutMs);
    const maxOutputBytes = numberLimit(options.maxOutputBytes, "maxOutputBytes", this.limits.maxCommandOutputBytes, this.limits.maxCommandOutputBytes);
    const bwrap = await findBubblewrap();
    if (!bwrap && (command === "node" || FILE_READING_COMMANDS.has(command))) {
      throw error("SANDBOX_UNAVAILABLE", `${command} execution requires bubblewrap`);
    }
    const runtimePaths = ["/usr", "/usr/local", "/bin", "/sbin", "/lib", "/lib64", "/etc"];
    const commandArgs = bwrap
      ? ["--die-with-parent", "--unshare-net", "--unshare-pid", "--new-session", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", ...runtimePaths.flatMap((path) => ["--ro-bind", path, path]), "--bind", this.root, "/workspace", "--chdir", "/workspace", "--", command, ...args]
      : args;
    const executable = bwrap ?? command;
    const environment = {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: "/workspace/.home",
      TMPDIR: "/tmp",
      LANG: "C",
      LC_ALL: "C",
    };
    const child = spawn(executable, commandArgs, {
      cwd: bwrap ? this.root : this.root,
      env: environment,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = { stdout: [], stderr: [], bytes: 0 };
    let overflow = false;
    const append = (field, chunk) => {
      output.bytes += chunk.byteLength;
      if (output.bytes > maxOutputBytes) overflow = true;
      else output[field].push(chunk);
      if (overflow) terminate();
    };
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    let terminated = false;
    const terminate = () => {
      if (terminated || child.exitCode !== null) return;
      terminated = true;
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
      setTimeout(() => {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      }, 200).unref();
    };
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    timer.unref();
    const [status] = await once(child, "close").catch((caught) => {
      clearTimeout(timer);
      throw caught;
    });
    clearTimeout(timer);
    if (overflow) throw error("OUTPUT_TOO_LARGE", `command output exceeds ${maxOutputBytes} bytes`, { command, maxOutputBytes });
    return {
      command,
      args: [...args],
      stdout: Buffer.concat(output.stdout).toString("utf8"),
      stderr: Buffer.concat(output.stderr).toString("utf8"),
      exitCode: status,
      timedOut,
      sandboxed: Boolean(bwrap),
      limits: { timeoutMs, maxOutputBytes },
    };
  }
}

export async function createScopedWorkspace(root, options = {}) {
  return ScopedWorkspace.open(root, options);
}

export const openScopedWorkspace = createScopedWorkspace;

export default ScopedWorkspace;
