import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openClawTaskConfig, parseOpenClawOutput } from "../lib/openclaw-worker-adapter.mjs";
import { validateOpenClawTaskReport } from "../lib/openclaw-task-report.mjs";
import { reviewOpenClawReport } from "../lib/ev-quality-gate.mjs";

test("parallel tasks use distinct OpenCode sessions without storing the API key", () => {
  const first = openClawTaskConfig({ taskId: "agent-one", workspacePath: "/tmp/agent-one" });
  const second = openClawTaskConfig({ taskId: "agent-two", workspacePath: "/tmp/agent-two" });
  const provider = first.models.providers["opencode-go"];
  assert.equal(provider.apiKey, "${OPENCODE_API}");
  assert.equal(provider.api, "openai-responses");
  assert.notEqual(provider.headers["x-opencode-session"], second.models.providers["opencode-go"].headers["x-opencode-session"]);
  assert.equal(first.agents.list[0].model, "opencode-go/gpt-6-luna");
  assert.equal(second.agents.list[0].workspace, "/tmp/agent-two");
  assert.deepEqual(first.tools.deny, ["sessions_spawn"]);
});

test("a provider error cannot pass as a completed OpenClaw task", () => {
  const result = parseOpenClawOutput(JSON.stringify({ payloads: [{ text: "400 Request is missing x-opencode-session" }], meta: { agentMeta: { provider: "opencode-go", model: "gpt-6-luna" } } }));
  assert.equal(result.status, "failed");
  assert.equal(result.code, "OPENCLAW_PROVIDER_ERROR");
});

test("a valid JSON report may contain code fences inside its answer", () => {
  const answer = 'Working program:\n```python\nprint("hello")\n```';
  const raw = JSON.stringify({ goal: "Create code", answer, outcome: "completed" });
  assert.equal(validateOpenClawTaskReport(raw).answer, answer);
  assert.equal(validateOpenClawTaskReport(`\`\`\`json\n${raw}\n\`\`\``).answer, answer);
});

test("X research requires a direct post link for the requested account", () => {
  const report = { goal: "Find @tibo's latest posts", answer: "A post was found.", evidence: [{ url: "https://x.com/tibo/status/123", title: "Post", supports: "Direct post" }], checks: ["Opened the post"], limitations: [] };
  assert.equal(validateOpenClawTaskReport(JSON.stringify(report), { needsSources: true, expectedAccount: "tibo" }).evidence.length, 1);
  assert.throws(() => validateOpenClawTaskReport(JSON.stringify({ ...report, evidence: [{ url: "https://x.com/other/status/123" }] }), { needsSources: true, expectedAccount: "tibo" }), (error) => error.code === "TASK_EVIDENCE_MISSING");
  assert.throws(() => validateOpenClawTaskReport(JSON.stringify({ ...report, evidence: [] }), { needsSources: true }), (error) => error.code === "TASK_EVIDENCE_MISSING");
  const inline = validateOpenClawTaskReport(JSON.stringify({ ...report, answer: "See https://x.com/tibo/status/123", evidence: [{ url: "https://x.com/tibo" }] }), { needsSources: true, expectedAccount: "tibo" });
  assert.equal(inline.evidence[0].url, "https://x.com/tibo/status/123");
});

test("independent review checks source text and can reject an incomplete answer", async () => {
  let reviewedInput = "";
  const fetchImpl = async (url, options) => {
    if (url === "https://opencode.ai/docs/go/") {
      return new Response("<html><body>Your client should send x-opencode-session for each conversation.</body></html>", { status: 200 });
    }
    assert.equal(url, "https://opencode.ai/zen/go/v1/responses");
    reviewedInput = JSON.parse(options.body).input;
    return Response.json({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"pass":false,"issues":["Missing session header"],"summary":"Incomplete"}' }] }] });
  };
  const verdict = await reviewOpenClawReport({
    taskId: "agent-review",
    request: "What headers does OpenCode Go require?",
    report: { answer: "I found the endpoint.", evidence: [{ url: "https://opencode.ai/docs/go/" }] },
    apiKey: "test-only",
    fetchImpl
  });
  assert.equal(verdict.pass, false);
  assert.deepEqual(verdict.issues, ["Missing session header"]);
  assert.match(reviewedInput, /x-opencode-session/);
});

test("exact X quotes fail when they omit a link from the post payload", async () => {
  const verdict = await reviewOpenClawReport({
    taskId: "agent-exact-x",
    request: "Give the exact text of @tibo's post",
    report: { answer: "Que faites-vous encore ici ?", evidence: [{ url: "https://x.com/tibo/status/1951196640309563807" }] },
    apiKey: "test-only",
    fetchImpl: async (url) => {
      assert.equal(url, "https://x.com/tibo/status/1951196640309563807");
      return new Response('<html><body>full_text:"Que faites-vous encore ici ? https://t.co/07YYB4H7fU"</body></html>', { status: 200 });
    }
  });
  assert.equal(verdict.pass, false);
  assert.match(verdict.issues[0], /07YYB4H7fU/);
});

test("local project evidence reaches review with verified excerpts and bounded audit values", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-local-review-"));
  try {
    const audit = join(root, "audit.json");
    const note = join(root, "README.md");
    await mkdir(join(root, "EmptyProject"));
    await writeFile(audit, JSON.stringify({ projectRoots: ["Alpha", "Beta"], status: "gateway unavailable", hidden: "SECRET_SHOULD_NOT_LEAK" }));
    await writeFile(note, "Alpha is a draft app.\n");
    const report = validateOpenClawTaskReport(JSON.stringify({
      goal: "Summarize local projects", answer: "Alpha is a draft app; Beta also exists.",
      evidence: [
        { url: pathToFileURL(root).href, title: "Projects directory" },
        { url: pathToFileURL(audit).href, title: "Audit", jsonPointers: ["/projectRoots"] },
        { url: pathToFileURL(note).href, title: "Alpha README", quotes: ["Alpha is a draft app."] }
      ]
    }));
    assert.equal(report.evidence.length, 3);
    let reviewedInput = "";
    const result = await reviewOpenClawReport({
      taskId: "local-projects", request: "Brief update on my projects", report, apiKey: "test-only", localRoots: [root],
      fetchImpl: async (url, options) => {
        assert.equal(url, "https://opencode.ai/zen/go/v1/responses");
        reviewedInput = JSON.parse(options.body).input;
        return Response.json({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"pass":true,"issues":[],"summary":"Supported"}' }] }] });
      }
    });
    assert.equal(result.pass, true);
    assert.match(reviewedInput, /"pointer":"\/projectRoots","verified":true/);
    assert.match(reviewedInput, /Alpha.*Beta/);
    assert.match(reviewedInput, /"name":"EmptyProject","visibleCount":0/);
    assert.match(reviewedInput, /"verified":true/);
    assert.match(reviewedInput, /Alpha is a draft app/);
    assert.doesNotMatch(reviewedInput, /SECRET_SHOULD_NOT_LEAK/);
    assert.equal(result.sourceObservations.filter((source) => source.state === "inspected").length, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unverified local quotes do not become reviewer observations", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-local-review-"));
  try {
    const note = join(root, "README.md");
    await writeFile(note, "Only the real fact is here.\n");
    let reviewedInput = "";
    await reviewOpenClawReport({
      taskId: "local-false-quote", request: "What does the file say?", apiKey: "test-only", localRoots: [root],
      report: validateOpenClawTaskReport(JSON.stringify({ goal: "Read a file", answer: "Invented fact", evidence: [{ url: pathToFileURL(note).href, quotes: ["Invented fact"] }] })),
      fetchImpl: async (url, options) => {
        reviewedInput = JSON.parse(options.body).input;
        return Response.json({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"pass":false,"issues":["Unsupported"],"summary":"Unsupported"}' }] }] });
      }
    });
    assert.match(reviewedInput, /"verified":false/);
    assert.doesNotMatch(reviewedInput, /"text":"Invented fact"/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("review sees executed test results from the OpenClaw session without raw output", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-session-review-"));
  try {
    const sessionPath = join(root, "session.jsonl");
    await writeFile(sessionPath, [
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec", arguments: { command: "npm test", workdir: root } }] } },
      { type: "message", message: { role: "toolResult", toolName: "exec", toolCallId: "call-1", isError: false, details: { exitCode: 0 }, content: [{ type: "text", text: "api_key=SHOULD_NOT_LEAK\nℹ tests 139\nℹ pass 139\nℹ fail 0\n" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call-2", name: "exec", arguments: { command: "npm run check && npm run build", workdir: root } }] } },
      { type: "message", message: { role: "toolResult", toolName: "exec", toolCallId: "call-2", details: { status: "running", sessionId: "build-1" }, content: [{ type: "text", text: "Command still running" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call-3", name: "process", arguments: { action: "poll", sessionId: "build-1" } }] } },
      { type: "message", message: { role: "toolResult", toolName: "process", toolCallId: "call-3", isError: false, details: { status: "completed", sessionId: "build-1", exitCode: 0, aggregated: "built in 2s\nProcess exited with code 0" }, content: [{ type: "text", text: "Process exited with code 0" }] } }
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    let reviewedInput = "";
    const result = await reviewOpenClawReport({
      taskId: "executed-tests", request: "Which tests work?", sessionPath, apiKey: "test-only",
      report: { goal: "Check tests", answer: "139 tests passed", evidence: [] },
      fetchImpl: async (url, options) => {
        reviewedInput = JSON.parse(options.body).input;
        return Response.json({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"pass":true,"issues":[],"summary":"Supported"}' }] }] });
      }
    });
    assert.match(reviewedInput, /"command":"npm test"/);
    assert.match(reviewedInput, /"exitCode":0/);
    assert.match(reviewedInput, /ℹ pass 139/);
    assert.match(reviewedInput, /npm run check && npm run build/);
    assert.match(reviewedInput, /built in 2s/);
    assert.doesNotMatch(reviewedInput, /SHOULD_NOT_LEAK/);
    assert.equal(result.executionObservations.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("review stays within selected evidence instead of expanding project scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-project-root-"));
  try {
    await mkdir(join(root, "Alpha"));
    await mkdir(join(root, ".agents"));
    let reviewedInput = "";
    const result = await reviewOpenClawReport({
      taskId: "project-inventory", request: "Give me an update on all projects", apiKey: "test-only",
      report: { goal: "Inventory projects", answer: "Alpha exists.", evidence: [] },
      localRoots: [root], projectRootPath: root,
      fetchImpl: async (url, options) => {
        reviewedInput = JSON.parse(options.body).input;
        return Response.json({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"pass":true,"issues":[],"summary":"Supported"}' }] }] });
      }
    });
    assert.doesNotMatch(reviewedInput, /"entries":\["Alpha"\]/);
    assert.doesNotMatch(reviewedInput, /"hiddenEntries":\[".agents"\]/);
    assert.equal(result.sourceObservations.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
