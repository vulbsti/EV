import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { validateAssistantRunBundle } from "../lib/assistant-run-bundle.mjs";

const execFileAsync = promisify(execFile);

function metadata(runId = "phase0-demo") {
  return {
    runId,
    date: "2026-09-21",
    phase: "phase-0",
    taskId: "task-1",
    taskFixture: "fixtures/phase-0.json",
    repositoryRevision: "abc1234",
    featureFlags: {},
    schemaVersions: { events: 1, context: 1 },
    models: { assistant: "gpt-test" },
    provider: { name: "mock", version: "1" },
    harness: { name: "node-test", version: "1" },
    mandateRevision: "mandate-1",
    startedAt: "2026-09-21T10:00:00.000Z",
    endedAt: "2026-09-21T10:01:00.000Z",
    cost: { inputTokens: 10, outputTokens: 5, toolCalls: 1, providerUsd: 0 },
    links: { journey: "ui/journey.md", scorecard: "scorecard.md" },
    uiEvidence: { screenshots: { status: "omitted_privacy" } }
  };
}

async function makeBundle({ run = metadata(), events = '{"schemaVersion":1,"eventId":"evt-1","type":"run.started","occurredAt":"2026-09-21T10:00:00.000Z"}\n', files = {}, omit = [], dirs = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ev-assistant-run-"));
  const bundle = join(root, "artifacts", "assistant-runs", "2026-09-21", run.runId ?? "phase0-demo");
  await mkdir(join(bundle, "ui"), { recursive: true });
  for (const dir of ["receipts", "artifacts", ...dirs]) await mkdir(join(bundle, dir), { recursive: true });
  const contents = {
    "run.json": JSON.stringify(run, null, 2),
    "events.jsonl": events,
    "context-manifest.json": JSON.stringify({
      transcript: { revision: "t1" },
      taskBrief: { revision: "b1" },
      personView: { status: "not_applicable" },
      relationshipPolicy: { status: "not_applicable" },
      sourceEvidence: [],
      memoryItems: [],
      capabilities: [],
      mandate: { status: "not_applicable" }
    }),
    "scorecard.md": "# Scorecard\n\nOutcome: useful.\n",
    "issues.md": "# Issues\n\nNone observed.\n",
    "decision.md": "# Decision\n\nAdvance.\n",
    "ui/journey.md": "# Journey\n\n1. Typed a request.\n",
    ...files
  };
  for (const [path, content] of Object.entries(contents)) {
    if (!omit.includes(path)) {
      await mkdir(join(bundle, path, ".."), { recursive: true });
      await writeFile(join(bundle, path), content);
    }
  }
  return { root, bundle };
}

test("accepts a complete documented assistant-run bundle", async () => {
  const fixture = await makeBundle();
  try {
    const result = await validateAssistantRunBundle(fixture.bundle);
    assert.equal(result.valid, true, JSON.stringify(result.issues));
    assert.deepEqual(result.issues, []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("reports missing shape entries, malformed JSONL, and metadata omissions", async () => {
  const run = metadata();
  delete run.provider;
  const fixture = await makeBundle({ run, events: '{"okay":true}\nnot-json\n', omit: ["decision.md"], dirs: [] });
  await rm(join(fixture.bundle, "receipts"), { recursive: true, force: true });
  try {
    const result = await validateAssistantRunBundle(fixture.bundle);
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((item) => item.code === "missing-file" && item.path === "decision.md"));
    assert.ok(result.issues.some((item) => item.code === "invalid-jsonl" && item.line === 2));
    assert.ok(result.issues.some((item) => item.code === "metadata-provider"));
    assert.ok(result.issues.some((item) => item.code === "missing-directory" && item.path === "receipts"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("detects nested and mixed redaction leaks while omitting their values from diagnostics and CLI output", async () => {
  const fixture = await makeBundle({ files: { "issues.md": "provider api_key=super-secret-value [REDACTED]\n", "receipts/nested/provider.txt": "Authorization: Bearer another-super-secret-value\n" } });
  try {
    const result = await validateAssistantRunBundle(fixture.bundle);
    assert.equal(result.valid, false);
    const serialized = JSON.stringify(result);
    assert.match(serialized, /secret-like-value/);
    assert.ok(result.issues.filter((item) => item.code === "secret-like-value").length >= 2);
    assert.doesNotMatch(serialized, /super-secret-value/);

    const cli = await execFileAsync(process.execPath, ["scripts/validate-assistant-run.mjs", fixture.bundle], { cwd: process.cwd() }).catch((error) => error);
    assert.equal(cli.code, 1);
    assert.doesNotMatch(`${cli.stdout ?? ""}\n${cli.stderr ?? ""}`, /super-secret-value/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects incomplete manifests, malformed event envelopes, and links outside the bundle", async () => {
  const run = metadata();
  run.links = { journey: "../../outside.md", missing: "receipts/missing.json" };
  const fixture = await makeBundle({
    run,
    events: '{"type":"run.started","occurredAt":"not-a-date"}\n',
    files: { "context-manifest.json": JSON.stringify({ transcript: {} }) }
  });
  try {
    const result = await validateAssistantRunBundle(fixture.bundle);
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((item) => item.code === "unsafe-link"));
    assert.ok(result.issues.some((item) => item.code === "missing-link-target"));
    assert.ok(result.issues.some((item) => item.code === "manifest-section"));
    assert.ok(result.issues.some((item) => item.code === "event-schema"));
    assert.ok(result.issues.some((item) => item.code === "event-id"));
    assert.ok(result.issues.some((item) => item.code === "event-time"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects bundles outside the documented directory shape", async () => {
  const fixture = await makeBundle();
  const outside = join(fixture.root, "elsewhere");
  try {
    const result = await validateAssistantRunBundle(outside);
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((item) => item.code === "bundle-location"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
