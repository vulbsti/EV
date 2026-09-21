import { performance } from "node:perf_hooks";
import { normalizePresentation, PRESENTATION_LIMITS } from "./presentation.mjs";

const MAX_RESPONSE_BYTES = 64 * 1024;

function round(value, places = 3) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function percentile(values, quantile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))];
}

function latencySummary(values) {
  return {
    minMs: round(Math.min(...values)),
    p50Ms: round(percentile(values, 0.5)),
    p95Ms: round(percentile(values, 0.95)),
    p99Ms: round(percentile(values, 0.99)),
    maxMs: round(Math.max(...values))
  };
}

async function runPool(total, concurrency, operation) {
  let cursor = 0;
  const values = new Array(total);
  const workers = Array.from({ length: Math.min(total, Math.max(1, concurrency)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= total) return;
      values[index] = await operation(index);
      if (index % 100 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
  });
  await Promise.all(workers);
  return values;
}

function buildCompilerOutput(inputs) {
  const answer = "A".repeat(inputs.answerChars);
  const mechanism = Array.from({ length: inputs.stepCount }, (_, index) => ({
    id: `step-${index + 1}`,
    title: `Pipeline step ${index + 1}`,
    detail: `This is the observable mechanical behavior of pipeline step ${index + 1}. `.repeat(index % 3 + 1),
    input: index ? `state-${index}` : "learner question and evidence",
    output: `state-${index + 1}`,
    evidence: `fixture:step-${index + 1}`,
    status: "observed"
  }));
  const scenarios = Array.from({ length: inputs.scenarioCount }, (_, index) => ({
    id: index ? `edge-${index}` : "normal",
    label: index ? `Edge ${index}` : "Normal path",
    trigger: index ? `edge condition ${index}` : "valid compiler output",
    path: inputs.invalidPaths ? ["step-1", `missing-${index}`] : mechanism.map((step) => step.id),
    outcome: index ? `edge outcome ${index}` : "a bounded interactive explanation",
    status: "predicted"
  }));
  const value = {
    project: { goal: "Make active agent work mechanically understandable.", alignment: "aligned", impact: "The presentation remains inspectable without showing the full mechanics at once." },
    answer,
    mechanism,
    scenarios,
    limits: Array.from({ length: 7 }, (_, index) => `uncertainty ${index + 1}`),
    followUps: Array.from({ length: 7 }, (_, index) => `Inspect step ${index + 1}?`)
  };
  const source = JSON.stringify(value);
  if (inputs.format === "fenced") return `\`\`\`json\n${source}\n\`\`\``;
  if (inputs.format === "malformed") return source.slice(0, Math.max(1, Math.floor(source.length * 0.42)));
  return source;
}

export async function runPresentationPipeline({ inputs }) {
  const source = buildCompilerOutput(inputs);
  const trace = [];
  const evidence = { revision: "experiment", target: { command: "presentation-pipeline" }, project: { summary: "EV interactive explainer" } };
  const sample = normalizePresentation(source, {
    evidence,
    fallback: "Compiler output could not be parsed.",
    onTrace: (event) => trace.push({ ...event, occurredAtMs: round(performance.now()) })
  });
  const memoryBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  const runs = await runPool(inputs.iterations, inputs.concurrency, async () => {
    const runStarted = performance.now();
    const result = normalizePresentation(source, { evidence, fallback: "Compiler output could not be parsed." });
    return { durationMs: performance.now() - runStarted, result };
  });
  const totalMs = performance.now() - started;
  const memoryAfter = process.memoryUsage().heapUsed;
  const durations = runs.map((run) => run.durationMs);
  const diagnostics = sample.diagnostics;
  const presentation = sample.presentation;
  const assertions = [
    { id: "answer-budget", label: "Answer stays within the hard budget", passed: presentation.answer.length <= PRESENTATION_LIMITS.answerChars, actual: presentation.answer.length, expected: `<= ${PRESENTATION_LIMITS.answerChars}`, status: "observed" },
    { id: "step-budget", label: "Step collection is bounded", passed: presentation.mechanism.length <= PRESENTATION_LIMITS.mechanismSteps, actual: presentation.mechanism.length, expected: `<= ${PRESENTATION_LIMITS.mechanismSteps}`, status: "observed" },
    { id: "scenario-budget", label: "Scenario collection is bounded", passed: presentation.scenarios.length <= PRESENTATION_LIMITS.scenarios, actual: presentation.scenarios.length, expected: `<= ${PRESENTATION_LIMITS.scenarios}`, status: "observed" },
    { id: "path-integrity", label: "Invalid scenario references are removed", passed: presentation.scenarios.every((scenario) => scenario.path.every((id) => presentation.mechanism.some((step) => step.id === id))), actual: diagnostics.invalidPathReferences, expected: "no invalid references in output", status: "observed" },
    { id: "fallback-contract", label: "Fallback behavior matches the experiment contract", passed: diagnostics.fallbackUsed === inputs.expectedFallback, actual: diagnostics.fallbackUsed, expected: inputs.expectedFallback, status: "observed" }
  ];
  const passed = assertions.filter((assertion) => assertion.passed).length;
  return {
    executedRealCode: true,
    adapterVersion: 1,
    status: passed === assertions.length ? "passed" : "failed",
    summary: diagnostics.fallbackUsed
      ? "The real parser rejected the input and executed its bounded fallback path."
      : "The real presentation normalizer parsed, bounded, linked, and produced the interactive model.",
    trace,
    output: { presentation, diagnostics },
    assertions,
    comparison: {
      mode: "raw-vs-bounded",
      baseline: { answerChars: inputs.answerChars, steps: inputs.stepCount, scenarios: inputs.scenarioCount },
      candidate: { answerChars: presentation.answer.length, steps: presentation.mechanism.length, scenarios: presentation.scenarios.length },
      delta: {
        answerChars: presentation.answer.length - inputs.answerChars,
        steps: presentation.mechanism.length - inputs.stepCount,
        scenarios: presentation.scenarios.length - inputs.scenarioCount
      }
    },
    metrics: {
      iterations: inputs.iterations,
      concurrency: inputs.concurrency,
      totalMs: round(totalMs),
      throughputPerSecond: round(inputs.iterations / Math.max(totalMs / 1000, 0.000001), 1),
      errorRate: 0,
      assertionFailureRate: round((assertions.length - passed) / assertions.length, 4),
      latency: latencySummary(durations),
      heapDeltaBytes: memoryAfter - memoryBefore
    },
    cost: { externalApiUsd: 0, modelTokens: 0, computeMs: round(totalMs), status: "derived" }
  };
}

function assertLoopback(baseUrl) {
  const url = new URL(baseUrl);
  if (!new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(url.hostname)) throw Object.assign(new Error("HTTP experiments are restricted to loopback"), { statusCode: 403 });
  return url;
}

export async function runLoopbackHttp({ inputs, baseUrl, fetchImpl = fetch }) {
  const base = assertLoopback(baseUrl);
  const target = new URL(inputs.path, base);
  if (target.origin !== base.origin || !target.pathname.startsWith("/api/")) throw Object.assign(new Error("HTTP experiment target is outside the allowed API boundary"), { statusCode: 403 });
  const trace = [
    { stage: "prepare", status: "observed", detail: "Validated a GET-only loopback target.", data: { target: target.pathname } },
    { stage: "request", status: "observed", detail: "Issued bounded requests to the live local daemon.", data: { iterations: inputs.iterations, concurrency: inputs.concurrency } }
  ];
  const memoryBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  const responses = await runPool(inputs.iterations, inputs.concurrency, async () => {
    const requestStarted = performance.now();
    try {
      const response = await fetchImpl(target, { method: "GET", cache: "no-store", signal: AbortSignal.timeout(inputs.timeoutMs) });
      const body = new Uint8Array(await response.arrayBuffer());
      return {
        ok: true,
        status: response.status,
        bytes: Math.min(body.length, MAX_RESPONSE_BYTES),
        truncated: body.length > MAX_RESPONSE_BYTES,
        durationMs: performance.now() - requestStarted
      };
    } catch (error) {
      return { ok: false, status: 0, bytes: 0, truncated: false, durationMs: performance.now() - requestStarted, error: error.message };
    }
  });
  const totalMs = performance.now() - started;
  const memoryAfter = process.memoryUsage().heapUsed;
  const statuses = Object.fromEntries(Object.entries(Object.groupBy(responses, (response) => String(response.status))).map(([status, values]) => [status, values.length]));
  const matching = responses.filter((response) => response.status === Number(inputs.expectedStatus)).length;
  const errors = responses.filter((response) => !response.ok).length;
  trace.push(
    { stage: "route", status: "predicted", detail: "The selected daemon route handled each request; internal route spans are not instrumented yet.", data: { path: target.pathname } },
    { stage: "receive", status: "observed", detail: "Captured response status, size, timeout, and latency.", data: { statuses, errors } },
    { stage: "assert", status: "derived", detail: "Compared observed statuses with the declared contract.", data: { matching, total: responses.length } }
  );
  const assertions = [
    { id: "status-contract", label: "Every response matches the expected status", passed: matching === responses.length, actual: statuses, expected: inputs.expectedStatus, status: "observed" },
    { id: "transport", label: "No request timed out or failed transport", passed: errors === 0, actual: errors, expected: 0, status: "observed" },
    { id: "response-boundary", label: "Responses stay inside the capture limit", passed: responses.every((response) => !response.truncated), actual: Math.max(...responses.map((response) => response.bytes)), expected: `<= ${MAX_RESPONSE_BYTES} bytes`, status: "observed" }
  ];
  const durations = responses.map((response) => response.durationMs);
  return {
    executedRealCode: true,
    adapterVersion: 1,
    status: assertions.every((assertion) => assertion.passed) ? "passed" : "failed",
    summary: `${matching}/${responses.length} live responses matched HTTP ${inputs.expectedStatus}.`,
    trace,
    output: { target: target.pathname, statuses, sample: responses[0] },
    assertions,
    comparison: {
      mode: "contract-vs-observed",
      baseline: { expectedStatus: inputs.expectedStatus, expectedCount: responses.length },
      candidate: { statuses, matching },
      delta: { mismatches: responses.length - matching }
    },
    metrics: {
      iterations: inputs.iterations,
      concurrency: inputs.concurrency,
      totalMs: round(totalMs),
      throughputPerSecond: round(inputs.iterations / Math.max(totalMs / 1000, 0.000001), 1),
      errorRate: round(errors / responses.length, 4),
      assertionFailureRate: round(assertions.filter((assertion) => !assertion.passed).length / assertions.length, 4),
      latency: latencySummary(durations),
      heapDeltaBytes: memoryAfter - memoryBefore,
      responseBytes: responses.reduce((total, response) => total + response.bytes, 0)
    },
    cost: { externalApiUsd: 0, modelTokens: 0, computeMs: round(totalMs), status: "derived" }
  };
}

export function experimentAdapterRegistry({ baseUrl, fetchImpl = fetch } = {}) {
  return new Map([
    ["presentation-pipeline", { authority: "in-memory-read-only", run: (context) => runPresentationPipeline(context) }],
    ["loopback-http", { authority: "loopback-get-only", run: (context) => runLoopbackHttp({ ...context, baseUrl, fetchImpl }) }]
  ]);
}
