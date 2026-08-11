import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function run(command, args = [], options = {}) {
  const started = performance.now();
  const result = await execFileAsync(command, args, {
    timeout: options.timeoutMs ?? 10_000,
    maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
    encoding: "utf8",
    env: options.env ?? process.env
  });
  return { ...result, durationMs: performance.now() - started };
}
