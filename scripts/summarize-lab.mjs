#!/usr/bin/env node
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "../lab/lib/cli.mjs";

const args = parseArgs(process.argv.slice(2));
const base = resolve(args.dir ?? join("artifacts", "lab"));
let target = args.run ? resolve(args.run) : null;
if (!target) {
  const entries = await readdir(base);
  const directories = [];
  for (const entry of entries) {
    const path = join(base, entry);
    if ((await stat(path)).isDirectory()) directories.push(path);
  }
  target = directories.sort().at(-1);
}
if (!target) throw new Error("No lab run found.");
const summary = JSON.parse(await readFile(join(target, "summary.json"), "utf8"));
console.log(`# EV lab run ${summary.runId}\n`);
console.log(`Mode: ${summary.mode}; passed: ${summary.counts.passed}; failed: ${summary.counts.failed}; skipped: ${summary.counts.skipped}\n`);
for (const result of summary.results) {
  console.log(`- ${result.status.toUpperCase()}: ${result.experimentId}${result.skipReason ? ` — ${result.skipReason}` : ""}`);
}
if (summary.repeat > 1) {
  console.log("\nRepeated-run aggregates:");
  for (const [experimentId, aggregate] of Object.entries(summary.aggregates ?? {})) {
    console.log(`- ${experimentId}: ${aggregate.passed} passed, ${aggregate.failed} failed, ${aggregate.skipped} skipped`);
  }
}
console.log(`\nEvidence directory: ${target}`);
