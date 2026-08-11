import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function loadConfig(path) {
  if (!path) return {};
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

export async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

export async function appendJsonl(path, value) {
  await appendFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

export async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export async function writeText(path, value) {
  await writeFile(path, value, { mode: 0o600 });
}

export function redactError(error) {
  return String(error?.message ?? error)
    .replace(/(Bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key[=:]\s*)[^\s,]+/gi, "$1[REDACTED]");
}
