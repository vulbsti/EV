import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { redactEvidence } from "./evidence.mjs";

/**
 * Usage accounting shared by the worker adapters.
 *
 * Agent runtimes report usage per model call, so a run's spend is the sum over
 * every assistant message, not the last one. Cache reads are tracked but not
 * counted toward the token budget: they re-read context that was already paid
 * for and would otherwise make long tool-using runs look many times larger
 * than the work they did. Cost is always the provider-reported total.
 */
export function emptyUsage() {
  return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, budgetTokens: 0, costUsd: 0, toolCalls: 0 };
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function addCallUsage(total, usage) {
  if (!usage || typeof usage !== "object") return total;
  const input = number(usage.input);
  const output = number(usage.output);
  const cacheRead = number(usage.cacheRead);
  const cacheWrite = number(usage.cacheWrite);
  // Some runtimes only report totalTokens. Without a breakdown, count all of it.
  const counted = input || output || cacheWrite ? input + output + cacheWrite : number(usage.totalTokens);
  total.calls += 1;
  total.input += input;
  total.output += output;
  total.cacheRead += cacheRead;
  total.cacheWrite += cacheWrite;
  total.budgetTokens += counted;
  total.costUsd += number(usage.cost?.total ?? usage.cost);
  return total;
}

export function mergeUsage(target, extra) {
  if (!extra) return target;
  // Adapters report summed usage; anything else is treated as one call.
  if (extra.budgetTokens === undefined) return addCallUsage(target, extra);
  for (const key of Object.keys(emptyUsage())) target[key] += number(extra[key]);
  return target;
}

/** Returns the exceeded dimension, or null while the run is within budget. */
export function exceededBudget(usage, budget) {
  if (!budget) return null;
  if (budget.maxTotalTokens > 0 && usage.budgetTokens > budget.maxTotalTokens) return "tokens";
  if (budget.maxCostUsd > 0 && usage.costUsd > budget.maxCostUsd) return "cost";
  if (Number.isInteger(budget.maxToolCalls) && budget.maxToolCalls >= 0 && usage.toolCalls > budget.maxToolCalls) return "tool calls";
  return null;
}

/** Keeps the last `maxBytes` of a stream in memory. */
export class TailBuffer {
  constructor(maxBytes = 16 * 1024) {
    this.maxBytes = maxBytes;
    this.chunks = [];
    this.bytes = 0;
    this.totalBytes = 0;
  }

  push(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    this.chunks.push(buffer);
    this.bytes += buffer.length;
    this.totalBytes += buffer.length;
    while (this.bytes > this.maxBytes && this.chunks.length > 1) this.bytes -= this.chunks.shift().length;
  }

  text() {
    const joined = Buffer.concat(this.chunks);
    return joined.subarray(Math.max(0, joined.length - this.maxBytes)).toString("utf8");
  }
}

/**
 * Worker stderr can carry credentials or provider internals, so it never goes
 * into task state, the UI, or a model prompt. A redacted tail is kept in a
 * private file beside the task's session so a failure can still be diagnosed.
 */
export async function writeDiagnosticsLog(sessionDir, runId, tail) {
  if (!sessionDir || !tail?.totalBytes) return null;
  const path = join(sessionDir, `diagnostics-${String(runId).replace(/[^A-Za-z0-9._-]/g, "_")}.log`);
  try {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await handle.writeFile(`${redactEvidence(tail.text())}\n`); } finally { await handle.close(); }
    return path;
  } catch {
    return null;
  }
}
