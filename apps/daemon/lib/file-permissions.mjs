import { chmodSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { isIP } from "node:net";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function modeOf(path) {
  return lstatSync(path).mode & 0o777;
}

function rejectUnsupported(path, stat, expectedType) {
  if (stat.isSymbolicLink()) throw Object.assign(new Error(`Refusing symlink in private path: ${path}`), { code: "PRIVATE_PATH_SYMLINK" });
  if (expectedType === "directory" && !stat.isDirectory()) throw Object.assign(new Error(`Private path is not a directory: ${path}`), { code: "PRIVATE_PATH_NOT_DIRECTORY" });
  if (expectedType === "file" && !stat.isFile()) throw Object.assign(new Error(`Private path is not a regular file: ${path}`), { code: "PRIVATE_PATH_NOT_FILE" });
}

export function ensurePrivateDirectorySync(path) {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const stat = lstatSync(path);
  rejectUnsupported(path, stat, "directory");
  if (modeOf(path) !== PRIVATE_DIRECTORY_MODE) chmodSync(path, PRIVATE_DIRECTORY_MODE);
  if (modeOf(path) !== PRIVATE_DIRECTORY_MODE) throw Object.assign(new Error(`Could not secure private directory: ${path}`), { code: "PRIVATE_PATH_MODE" });
  return path;
}

export function ensurePrivateFileSync(path) {
  const stat = lstatSync(path);
  rejectUnsupported(path, stat, "file");
  if (modeOf(path) !== PRIVATE_FILE_MODE) chmodSync(path, PRIVATE_FILE_MODE);
  if (modeOf(path) !== PRIVATE_FILE_MODE) throw Object.assign(new Error(`Could not secure private file: ${path}`), { code: "PRIVATE_PATH_MODE" });
  return path;
}

/** Correct and verify all existing descendants of a private data tree. */
export function securePrivateTreeSync(root) {
  ensurePrivateDirectorySync(root);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const child = `${root}/${entry.name}`;
    if (entry.isDirectory()) securePrivateTreeSync(child);
    else if (entry.isFile()) ensurePrivateFileSync(child);
    else rejectUnsupported(child, lstatSync(child));
  }
  return root;
}

export function secureDatabaseFilesSync(path) {
  ensurePrivateFileSync(path);
  for (const suffix of ["-wal", "-shm"]) {
    try { ensurePrivateFileSync(`${path}${suffix}`); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return path;
}

export function assertLoopbackHost(host) {
  const value = String(host ?? "").trim();
  const normalized = value.replace(/^\[|\]$/g, "");
  if (isIP(normalized) === 4 && normalized.startsWith("127.")) return value;
  if (normalized === "::1") return value;
  throw Object.assign(new Error(`EV_HOST must be a loopback address for unauthenticated APIs: ${value || "<empty>"}`), { code: "EV_HOST_NOT_LOOPBACK" });
}

export const PRIVATE_MODES = Object.freeze({ directory: PRIVATE_DIRECTORY_MODE, file: PRIVATE_FILE_MODE });
