#!/usr/bin/env node
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { createPhase0RunBundle } from "../apps/daemon/lib/phase0-run.mjs";

const execFileAsync = promisify(execFile);

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const cwd = process.cwd();
const date = option("--date", new Date().toISOString().slice(0, 10));
const runId = option("--run-id", "phase0-b0-routing");
const eventsPath = resolve(cwd, option("--events", "data/events.jsonl"));
const outputRoot = resolve(cwd, option("--output-root", "."));
const { stdout } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd });

try {
  const result = await createPhase0RunBundle({
    eventsPath,
    outputRoot,
    date,
    runId,
    repositoryRevision: stdout.trim()
  });
  console.log(`Created and validated Phase 0 run bundle: ${result.bundlePath}`);
  console.log(`Corrected browser result: ${result.browserReceipt.correctedReply}`);
  console.log(`Reply persisted after reload: ${result.browserReceipt.reloadReplyPersisted}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
