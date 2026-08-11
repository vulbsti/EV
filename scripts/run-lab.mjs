#!/usr/bin/env node
import { cpus, hostname, platform, release } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs, asList, asNumber } from "../lab/lib/cli.mjs";
import { appendJsonl, ensureDir, loadConfig, redactError, writeJson } from "../lab/lib/io.mjs";
import { summarizeNumbers } from "../lab/lib/stats.mjs";

import { experiment as companionPolicy } from "../lab/experiments/companion-policy.mjs";
import { experiment as delegationContract } from "../lab/experiments/delegation-contract.mjs";
import { experiment as tmuxObservation } from "../lab/experiments/tmux-observation.mjs";
import { experiment as resilience } from "../lab/experiments/resilience.mjs";
import { experiment as costModel } from "../lab/experiments/cost-model.mjs";
import { experiment as openrouterDiscovery } from "../lab/experiments/openrouter-discovery.mjs";
import { experiment as openrouterTts } from "../lab/experiments/openrouter-tts.mjs";
import { experiment as openrouterStt } from "../lab/experiments/openrouter-stt.mjs";
import { experiment as openrouterRoundtrip } from "../lab/experiments/openrouter-roundtrip.mjs";
import { experiment as xaiRealtime } from "../lab/experiments/xai-realtime.mjs";

const registry = [companionPolicy, delegationContract, tmuxObservation, resilience, costModel, openrouterDiscovery, openrouterTts, openrouterStt, openrouterRoundtrip, xaiRealtime];
const args = parseArgs(process.argv.slice(2));

if (args.list) {
  for (const experiment of registry) console.log(`${experiment.id.padEnd(25)} ${experiment.group.padEnd(12)} ${experiment.description}`);
  process.exit(0);
}

const fileConfig = await loadConfig(args.config);
const config = {
  concurrency: 4,
  tmuxSamples: 3,
  tmuxCaptureLines: 80,
  requestTimeoutMs: 30_000,
  ...fileConfig,
  xai: { ...(fileConfig.xai ?? {}) },
  openrouter: { ...(fileConfig.openrouter ?? {}) }
};
const mode = args.mode === "live" ? "live" : "mock";
const profile = args.profile ?? "full";
const selectedIds = new Set(asList(args.experiments));
const quickIds = new Set(["companion-policy", "delegation-contract", "tmux-observation", "resilience", "cost-model"]);
const selected = registry.filter((experiment) =>
  (!selectedIds.size || selectedIds.has(experiment.id)) && (profile !== "quick" || quickIds.has(experiment.id))
);
if (!selected.length) throw new Error("No experiments selected. Run with --list to see IDs.");
const repeat = Math.min(100, Math.floor(asNumber(args.repeat, 1)));
const jobs = selected.flatMap((experiment) => Array.from({ length: repeat }, (_, index) => ({ experiment, repetition: index + 1 })));

const startedAt = new Date();
const runId = `${startedAt.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const runDir = resolve(args.out ?? join("artifacts", "lab", runId));
await ensureDir(runDir);
const resultPath = join(runDir, "results.jsonl");
const context = { args, config, mode, profile, runId, runDir };
const concurrency = Math.min(jobs.length, asNumber(args.concurrency, config.concurrency));
let cursor = 0;
const results = [];

console.log(`EV lab ${runId}: ${selected.length} experiments x ${repeat} repetition(s), mode=${mode}, concurrency=${concurrency}`);

async function execute({ experiment, repetition }) {
  const started = performance.now();
  const base = {
    schemaVersion: 1,
    runId,
    experimentId: experiment.id,
    caseId: `repeat-${repetition}`,
    repetition,
    group: experiment.group,
    mode,
    startedAt: new Date().toISOString()
  };
  let result;
  try {
    result = await experiment.run(context);
  } catch (error) {
    result = { status: "failed", error: redactError(error), metrics: {} };
  }
  const record = { ...base, ...result, durationMs: performance.now() - started, finishedAt: new Date().toISOString() };
  await appendJsonl(resultPath, record);
  results.push(record);
  console.log(`${record.status.toUpperCase().padEnd(8)} ${experiment.id}${record.skipReason ? ` — ${record.skipReason}` : ""}`);
}

async function worker() {
  while (cursor < jobs.length) {
    const job = jobs[cursor++];
    await execute(job);
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
results.sort((a, b) => a.experimentId.localeCompare(b.experimentId) || a.repetition - b.repetition);
const counts = Object.groupBy(results, (result) => result.status);
const byExperiment = Object.groupBy(results, (result) => result.experimentId);
const aggregates = Object.fromEntries(Object.entries(byExperiment).map(([experimentId, records]) => {
  const metricKeys = [...new Set(records.flatMap((record) => Object.keys(record.metrics ?? {})))];
  const numericMetrics = Object.fromEntries(metricKeys.map((key) => [key, summarizeNumbers(records.map((record) => record.metrics?.[key]))]).filter(([, value]) => value.count));
  return [experimentId, {
    passed: records.filter((record) => record.status === "passed").length,
    failed: records.filter((record) => record.status === "failed").length,
    skipped: records.filter((record) => record.status === "skipped").length,
    numericMetrics
  }];
}));
const summary = {
  schemaVersion: 1,
  runId,
  mode,
  profile,
  repeat,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  environment: { hostname: hostname(), platform: platform(), release: release(), node: process.version, cpuCount: cpus().length },
  providerCredentialsPresent: { xai: Boolean(process.env.XAI_API_KEY), openrouter: Boolean(process.env.OPENROUTER_API_KEY), openai: Boolean(process.env.OPENAI_API_KEY) },
  counts: { passed: counts.passed?.length ?? 0, failed: counts.failed?.length ?? 0, skipped: counts.skipped?.length ?? 0 },
  aggregates,
  results: results.map(({ observations, ...result }) => result)
};
await writeJson(join(runDir, "summary.json"), summary);
console.log(`Evidence: ${runDir}`);
process.exitCode = summary.counts.failed ? 1 : 0;
