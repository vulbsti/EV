import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantSupervisor } from "../lib/assistant-supervisor.mjs";
import { openStore } from "../lib/store.mjs";
import { AssistantWorkerService } from "../lib/assistant-worker-service.mjs";
import { taskUpdate } from "../lib/ev-main-agent.mjs";

const report = (answer = "Useful result", overrides = {}) => JSON.stringify({ goal: "Produce a report", outcome: "completed", answer, evidence: [], deliverables: [], checks: [], limitations: [], ...overrides });
const pass = async () => ({ pass: true, issues: [], caveats: [], summary: "Goal met" });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ev-manager-"));
  const store = openStore({ path: join(root, "ev.sqlite") });
  const supervisor = await AssistantSupervisor.open({ store, artifactRoot: join(root, "artifacts") });
  return { root, supervisor, options: { supervisor, workerRoot: root }, async close() { store.close(); await rm(root, { recursive: true, force: true }); } };
}
async function submit(service, taskId = "parent") {
  return service.submitTask({ taskId, capability: "openclaw-general-v1", context: "# User request\n\nProduce a report", prompt: "unused initial prompt", metadata: { briefed: true, sourceRequest: "Produce a report", conversationId: "test" } });
}
async function until(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.fail("Expected state was not reached");
}

test("minor concerns do not discard a useful result", async () => {
  const f = await fixture(); let starts = 0;
  const service = new AssistantWorkerService({ ...f.options,
    reviewer: async () => ({ pass: true, issues: [], caveats: ["An incidental detail is unconfirmed."], summary: "Useful" }),
    adapterFactory: async () => ({ async start() { starts++; return { completion: Promise.resolve({ status: "completed", text: report() }) }; }, async stop() {} })
  });
  try {
    await submit(service); const final = await service.waitForTask("parent");
    assert.equal(final.status, "completed"); assert.equal(final.result.report.outcome, "completed"); assert.equal(starts, 1);
    assert.match(final.result.report.limitations.join(" "), /incidental detail/);
  } finally { await service.shutdown(); await f.close(); }
});

test("an unavailable reviewer holds the result and retries; it never ships unchecked", async () => {
  for (const recovers of [false, true]) {
    const f = await fixture(); let reviews = 0;
    const service = new AssistantWorkerService({ ...f.options, reviewHoldMs: [0, 0],
      reviewer: async () => { reviews++; if (!recovers || reviews < 3) throw new Error("Unavailable"); return { verdict: "accept", summary: "Useful" }; },
      adapterFactory: async () => ({ async start() { return { completion: Promise.resolve({ status: "completed", text: report() }) }; }, async stop() {} })
    });
    try {
      await submit(service); const final = await service.waitForTask("parent");
      assert.equal(reviews, 3);
      if (recovers) assert.equal(final.status, "completed");
      else {
        // Held back and put to the person, never delivered unchecked and never lost.
        assert.equal(final.status, "waiting"); assert.equal(final.result, null);
        const asked = final.history.at(-1);
        assert.equal(asked.state.problem, "QUALITY_REVIEW_UNAVAILABLE"); assert.match(asked.state.answerSoFar, /Useful result/);
        assert.match(taskUpdate(final), /quality check couldn't run/);
      }
    } finally { await service.shutdown(); await f.close(); }
  }
});

test("EV sends review feedback back to the same agent until the result is accepted", async () => {
  const f = await fixture(); const prompts = []; let reviews = 0;
  const service = new AssistantWorkerService({ ...f.options,
    reviewer: async ({ round }) => { reviews++; return round < 2
      ? { verdict: "revise", missing: ["The comparison table"], feedback: ["Add a table comparing the three options"], summary: "Missing the table" }
      : { verdict: "accept", summary: "Meets the brief" }; },
    adapterFactory: async () => ({ async start({ prompt }) { prompts.push(prompt); return { completion: Promise.resolve({ status: "completed", text: report(`answer ${prompts.length}`) }) }; }, async stop() {} })
  });
  try {
    await submit(service); const final = await service.waitForTask("parent");
    assert.equal(final.status, "completed"); assert.equal(final.result.report.outcome, "completed");
    assert.equal(prompts.length, 2); assert.equal(reviews, 2);
    assert.match(prompts[1], /Add a table comparing the three options/);
    assert.match(final.result.report.answer, /answer 2/);
    assert.deepEqual(final.result.report.verification.reviews.map((review) => review.verdict), ["revise", "accept"]);
    assert.ok(final.history.some((event) => event.type === "revision_requested"));
  } finally { await service.shutdown(); await f.close(); }
});

test("a review loop that stops making progress asks the person instead of delivering half-done work", async () => {
  const f = await fixture(); let starts = 0;
  const service = new AssistantWorkerService({ ...f.options,
    reviewer: async ({ round }) => ({ verdict: "revise", missing: [`A requested part is missing (${round}).`], feedback: [], summary: "Incomplete", progress: "stalled" }),
    adapterFactory: async () => ({ async start() { starts++; return { completion: Promise.resolve({ status: "completed", text: report() }) }; }, async stop() {} })
  });
  try {
    await submit(service); const final = await service.waitForTask("parent");
    assert.equal(starts, 2); assert.equal(final.status, "waiting");
    assert.match(final.history.findLast((event) => event.type === "input_needed").question, /requested part/);
  } finally { await service.shutdown(); await f.close(); }
});

test("EV's brief reaches the agent and BRIEF.md, and EV tells the person what was done", async () => {
  const f = await fixture(); const prompts = []; const settled = [];
  const service = new AssistantWorkerService({ ...f.options,
    reviewer: async () => ({ verdict: "accept", summary: "Clear", handoff: "I compared both quotes and recommend B: same scope, two weeks sooner." }),
    onTaskSettled: (task) => settled.push(task),
    adapterFactory: async () => ({ async start({ prompt }) { prompts.push(prompt); return { completion: Promise.resolve({ status: "completed", text: report("Go with B") }) }; }, async stop() {} })
  });
  try {
    await service.submitTask({ taskId: "goal", capability: "openclaw-general-v1", layout: "shared", context: "# User request", prompt: "unused",
      metadata: { briefed: true, sourceRequest: "Compare the two kitchen quotes in quotes/ and recommend the better value", literalAsk: "which one should i go with", title: "Pick a quote", conversationId: "test" } });
    const final = await service.waitForTask("goal");
    const shared = join(f.root, "workspaces", "goal", "shared");
    const brief = await readFile(join(shared, "BRIEF.md"), "utf8");
    assert.match(brief, /recommend the better value/); assert.match(brief, /Review: until EV accepts/);
    assert.match(prompts[0], /recommend the better value/); assert.match(prompts[0], new RegExp(`${shared}/BRIEF.md`));
    await until(() => settled.length === 1);
    assert.match(taskUpdate(settled[0]), /"Pick a quote" is done\. I compared both quotes and recommend B/);
    assert.equal(final.status, "completed");
  } finally { await service.shutdown(); await f.close(); }
});
test("work already under way is admitted before new requests, and background work goes last", async () => {
  const f = await fixture(); const order = [];
  let releaseFirst;
  const service = new AssistantWorkerService({ ...f.options, maxConcurrentWorkers: 1, reviewer: pass, profiles: {
    ...(await import("../lib/assistant-worker-service.mjs")).createFixedCapabilityProfiles(),
    "plain-v1": { capability: "plain-v1", tools: [], extensionPaths: [], skillPaths: [], requireContext: false, requireArtifact: false, budget: null }
  }, adapterFactory: async ({ task }) => ({ async start() {
    order.push(task.taskId);
    if (task.taskId === "first") return { completion: new Promise((resolve) => { releaseFirst = () => resolve({ status: "completed", text: "ok" }); }) };
    return { completion: Promise.resolve({ status: "completed", text: "ok" }) };
  }, async stop() {} }) });
  try {
    await service.submitTask({ taskId: "first", capability: "plain-v1", prompt: "p" });
    await until(async () => order.length === 1);
    await service.submitTask({ taskId: "background", capability: "plain-v1", prompt: "p", metadata: { kind: "standing-prepared-output" } });
    await service.submitTask({ taskId: "interactive", capability: "plain-v1", prompt: "p" });
    await service.submitTask({ taskId: "child", capability: "plain-v1", prompt: "p", metadata: { parentTaskId: "elsewhere" } });
    await until(async () => service.workerQueue.length === 3);
    releaseFirst();
    await Promise.all(["background", "interactive", "child"].map((id) => service.waitForTask(id)));
    assert.deepEqual(order, ["first", "child", "interactive", "background"]);
  } finally { await service.shutdown(); await f.close(); }
});

test("a claimed file that does not exist is never delivered as done, even when the review accepts", async () => {
  const f = await fixture();
  const service = new AssistantWorkerService({ ...f.options, reviewer: pass,
    adapterFactory: async () => ({ async start() { return { completion: Promise.resolve({ status: "completed", text: report("Created it", { deliverables: [{ path: "missing.md" }] }) }) }; }, async stop() {} })
  });
  try {
    await submit(service); const final = await service.waitForTask("parent");
    assert.equal(final.status, "waiting"); assert.equal(final.artifacts.length, 0);
    assert.match(final.history.findLast((event) => event.type === "input_needed").question, /does not exist/);
  } finally { await service.shutdown(); await f.close(); }
});

test("an honest blocker is delivered without a forced post link or a correction loop", async () => {
  const f = await fixture(); let starts = 0;
  const service = new AssistantWorkerService({ ...f.options,
    reviewer: async () => { assert.fail("Blocked outcomes do not require a publication review"); },
    adapterFactory: async () => ({ async start() { starts++; return { completion: Promise.resolve({ status: "completed", text: report("Access denied; no posts verified", { outcome: "blocked" }) }) }; }, async stop() {} })
  });
  try {
    await service.submitTask({ taskId: "blocked", capability: "openclaw-general-v1", prompt: "Read posts", context: "Read posts", metadata: { sourceRequest: "Read @tibo posts", verification: { needsSources: true, expectedAccount: "tibo" } } });
    const final = await service.waitForTask("blocked");
    assert.equal(final.status, "completed"); assert.equal(final.result.report.outcome, "blocked"); assert.equal(starts, 1);
  } finally { await service.shutdown(); await f.close(); }
});

test("an agent that needs the person parks without a worker slot, survives a restart, and resumes in its session", async () => {
  const f = await fixture(); const prompts = []; const reviewedBriefs = [];
  const options = { ...f.options, reviewer: async ({ brief }) => { reviewedBriefs.push(brief); return pass(); },
    adapterFactory: async () => ({ async start({ prompt }) {
      prompts.push(prompt);
      const text = prompts.length === 1 ? report("Drafted both options", { outcome: "needs_input", question: "Which account should I post from?" }) : report("Posted from the work account");
      return { completion: Promise.resolve({ status: "completed", text }) };
    }, async stop() {} })
  };
  let service = new AssistantWorkerService(options);
  try {
    await submit(service);
    const parked = await service.waitForTask("parent");
    assert.equal(parked.status, "waiting"); assert.equal(parked.lease, null);
    assert.equal(parked.history.findLast((event) => event.type === "input_needed").question, "Which account should I post from?");
    assert.match(taskUpdate(parked), /Which account should I post from\?/);
    await service.shutdown();
    service = new AssistantWorkerService(options);
    await service.start();
    assert.equal((await f.supervisor.getTask("parent")).status, "waiting");
    await service.instructTask({ taskId: "parent", text: "Use the work account." });
    const final = await service.waitForTask("parent");
    assert.equal(final.status, "completed"); assert.match(final.result.report.answer, /work account/);
    assert.equal(prompts.length, 2); assert.match(prompts[1], /Use the work account/);
    assert.match(JSON.stringify(reviewedBriefs.at(-1)), /Use the work account/);
  } finally { await service.shutdown(); await f.close(); }
});

test("an instruction sent while an agent runs reaches it in the same task before review", async () => {
  const f = await fixture(); const prompts = []; let release;
  const service = new AssistantWorkerService({ ...f.options, reviewer: pass,
    adapterFactory: async () => ({ async start({ prompt }) {
      prompts.push(prompt);
      if (prompts.length === 1) return { completion: new Promise((resolve) => { release = () => resolve({ status: "completed", text: report("Formal draft") }); }) };
      return { completion: Promise.resolve({ status: "completed", text: report("Casual draft") }) };
    }, async stop() {} })
  });
  try {
    await submit(service);
    await until(() => Boolean(release));
    await service.instructTask({ taskId: "parent", text: "Make it casual." });
    release();
    const final = await service.waitForTask("parent");
    assert.equal(final.status, "completed"); assert.match(final.result.report.answer, /Casual/);
    assert.equal(prompts.length, 2); assert.match(prompts[1], /Make it casual/);
    // Telling delivered work something reopens it in the same session.
    await service.instructTask({ taskId: "parent", text: "Shorter, please." });
    const reopened = await service.waitForTask("parent");
    assert.equal(reopened.status, "completed"); assert.equal(prompts.length, 3); assert.match(prompts[2], /^The person came back[\s\S]*Shorter, please/);
  } finally { await service.shutdown(); await f.close(); }
});

test("an instruction sent while EV reviews reaches the agent before delivery, even when the review passes", async () => {
  const f = await fixture(); const prompts = []; let reviewing;
  const service = new AssistantWorkerService({ ...f.options,
    reviewer: async () => { if (!reviewing) await new Promise((resolve) => { reviewing = resolve; }); return pass(); },
    adapterFactory: async () => ({ async start({ prompt }) {
      prompts.push(prompt);
      return { completion: Promise.resolve({ status: "completed", text: report(prompts.length === 1 ? "Formal draft" : "Casual draft") }) };
    }, async stop() {} })
  });
  try {
    await submit(service);
    await until(() => Boolean(reviewing));
    await service.instructTask({ taskId: "parent", text: "Make it casual." });
    reviewing();
    const final = await service.waitForTask("parent");
    assert.equal(final.status, "completed"); assert.match(final.result.report.answer, /Casual/);
    assert.match(prompts[1], /Make it casual/);
  } finally { await service.shutdown(); await f.close(); }
});

test("a restart carries on the review loop: same round, earlier reviews and spend, and the rejected answer is not reused", async () => {
  const f = await fixture(); const reviews = []; const starts = [];
  const options = { ...f.options,
    reviewer: async ({ round, previousReviews }) => {
      reviews.push({ round, earlier: previousReviews.length });
      return reviews.length === 1 ? { verdict: "revise", missing: ["More detail"], feedback: ["Add detail"], summary: "Thin" } : pass();
    },
    adapterFactory: async () => ({
      async start({ reuseCompleted }) {
        starts.push({ reuseCompleted });
        // The second run (the revision) hangs until the daemon stops.
        if (starts.length === 2) return { completion: new Promise((resolve) => { this.halt = () => resolve({ status: "stopped" }); }) };
        return { completion: Promise.resolve({ status: "completed", text: report(`Answer ${starts.length}`), usage: { input: 1_000, output: 500 } }) };
      },
      async stop() { this.halt?.(); }
    })
  };
  let service = new AssistantWorkerService(options);
  try {
    await submit(service);
    await until(() => starts.length === 2);
    await service.shutdown();
    service = new AssistantWorkerService(options);
    await service.start();
    const final = await service.waitForTask("parent");
    assert.equal(final.status, "completed");
    assert.deepEqual(reviews, [{ round: 1, earlier: 0 }, { round: 2, earlier: 1 }]);
    assert.equal(starts[2].reuseCompleted, false);
    assert.equal(final.result.usage.budgetTokens, 3_000);
  } finally { await service.shutdown(); await f.close(); }
});

test("an agent that keeps dying is restarted in its session a few times, then the person is asked; nothing ends the work", async () => {
  const f = await fixture(); const prompts = [];
  const service = new AssistantWorkerService({ ...f.options, reviewer: pass,
    adapterFactory: async () => ({ async start({ prompt }) {
      prompts.push(prompt);
      return { completion: Promise.resolve(prompts.length < 6 ? { status: "stalled", code: "AGENT_STALLED", message: "The agent showed no progress for 1 s" } : { status: "completed", text: report("Finally done") }) };
    }, async stop() {} })
  });
  try {
    await submit(service);
    const asked = await service.waitForTask("parent");
    assert.equal(asked.status, "waiting"); assert.equal(prompts.length, 4);
    assert.ok(prompts.slice(1).every((prompt) => /^You were interrupted/.test(prompt)));
    assert.match(taskUpdate(asked), /no progress/);
    await service.instructTask({ taskId: "parent", text: "Try again." });
    const final = await service.waitForTask("parent");
    assert.equal(final.status, "completed"); assert.match(prompts.at(-1), /Answer to your question[\s\S]*Try again/);
  } finally { await service.shutdown(); await f.close(); }
});
