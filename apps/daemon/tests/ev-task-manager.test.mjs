import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantSupervisor } from "../lib/assistant-supervisor.mjs";
import { AssistantWorkerService } from "../lib/assistant-worker-service.mjs";
import { normalizeTaskPlan } from "../lib/ev-task-manager.mjs";
import { taskUpdate } from "../lib/ev-main-agent.mjs";

const plan = { goal: "Produce a combined report", successCriteria: ["Both assignments are covered"], subtasks: [
  { title: "Research", instruction: "Research the requested topic", retrySafe: true },
  { title: "Inspect", instruction: "Inspect the requested system", retrySafe: true }
] };
const report = (answer = "Useful result", overrides = {}) => JSON.stringify({ goal: "Produce a report", outcome: "completed", answer, evidence: [], deliverables: [], checks: [], limitations: [], ...overrides });
const pass = async () => ({ pass: true, issues: [], caveats: [], summary: "Goal met" });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ev-manager-"));
  const supervisor = await AssistantSupervisor.open({ statePath: join(root, "state.sqlite"), artifactRoot: join(root, "artifacts") });
  return { root, supervisor, options: { supervisor, workerRoot: root }, async close() { supervisor.close(); await rm(root, { recursive: true, force: true }); } };
}
async function submit(service, taskId = "parent") {
  return service.submitTask({ taskId, capability: "openclaw-general-v1", context: "# User request\n\nProduce a report", prompt: "unused initial prompt", metadata: { managerMode: true, sourceRequest: "Produce a report", conversationId: "test" } });
}
async function until(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.fail("Expected state was not reached");
}

test("one parent runs independent children concurrently, retries a failed child, and delivers one checked artifact", async () => {
  const f = await fixture();
  const starts = [];
  let running = 0, peak = 0, plans = 0;
  const service = new AssistantWorkerService({ ...f.options, maxConcurrentWorkers: 2,
    planner: async () => { plans++; return plan; }, reviewer: pass,
    adapterFactory: async ({ task, workspacePath }) => ({
      async start({ prompt }) {
        starts.push({ taskId: task.taskId, workspacePath, prompt }); running++; peak = Math.max(peak, running);
        return { completion: new Promise((resolve) => setTimeout(async () => {
          running--;
          if (task.taskId === "parent-child-2") return resolve({ status: "failed", code: "OPENCLAW_PROCESS_EXIT", message: "Temporary failure" });
          if (task.taskId === "parent") {
            assert.match(prompt, /parent-child-1/); assert.match(prompt, /parent-child-2-retry/);
            await writeFile(join(workspacePath, "combined.md"), "Both assignments were combined.\n");
          }
          resolve({ status: "completed", text: report(task.taskId, task.taskId === "parent" ? { deliverables: [{ path: "combined.md", title: "Combined report" }] } : {}) });
        }, 25)) };
      }, async cancel() {}
    })
  });
  try {
    await submit(service);
    const final = await service.waitForTask("parent");
    assert.equal(final.status, "completed"); assert.equal(final.result.report.outcome, "completed");
    assert.equal(peak, 2); assert.equal(plans, 1);
    assert.equal(starts.length, 4); assert.equal(new Set(starts.map((start) => start.workspacePath)).size, 4);
    assert.equal((await f.supervisor.getTask("parent-child-2")).status, "failed");
    assert.equal((await f.supervisor.getTask("parent-child-2-retry")).status, "completed");
    assert.equal(final.history.filter((event) => event.type === "worker_retry").length, 1);
    assert.equal(final.artifacts.length, 1);
    assert.equal(final.result.report.verification.deliverables[0].verified, true);
    assert.equal((await f.supervisor.readArtifact(final.artifacts[0].artifactId)).contents.toString(), "Both assignments were combined.\n");
  } finally { await service.shutdown(); await f.close(); }
});

test("minor concerns and an unavailable reviewer do not discard a useful result", async () => {
  for (const unavailable of [false, true]) {
    const f = await fixture(); let starts = 0;
    const service = new AssistantWorkerService({ ...f.options, planner: async () => normalizeTaskPlan(null, "Do work"),
      reviewer: async () => { if (unavailable) throw new Error("Unavailable"); return { pass: true, issues: [], caveats: ["An incidental detail is unconfirmed."], summary: "Useful" }; },
      adapterFactory: async () => ({ async start() { starts++; return { completion: Promise.resolve({ status: "completed", text: report() }) }; }, async cancel() {} })
    });
    try {
      await submit(service); const final = await service.waitForTask("parent");
      assert.equal(final.status, "completed"); assert.equal(final.result.report.outcome, "completed"); assert.equal(starts, 1);
      assert.match(final.result.report.limitations.join(" "), unavailable ? /review was unavailable/ : /incidental detail/);
    } finally { await service.shutdown(); await f.close(); }
  }
});

test("EV sends review feedback back to the same agent until the result is accepted", async () => {
  const f = await fixture(); const prompts = []; let reviews = 0;
  const service = new AssistantWorkerService({ ...f.options, planner: async () => normalizeTaskPlan(null, "Do work"),
    reviewer: async ({ round }) => { reviews++; return round < 2
      ? { verdict: "revise", missing: ["The comparison table"], feedback: ["Add a table comparing the three options"], summary: "Missing the table" }
      : { verdict: "accept", summary: "Meets the brief" }; },
    adapterFactory: async () => ({ async start({ prompt }) { prompts.push(prompt); return { completion: Promise.resolve({ status: "completed", text: report(`answer ${prompts.length}`) }) }; }, async cancel() {} })
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

test("a result review never accepts is delivered only as partial, with what is still missing", async () => {
  const f = await fixture(); let starts = 0;
  const service = new AssistantWorkerService({ ...f.options, planner: async () => normalizeTaskPlan({ reviewRounds: 3 }, "Do work"),
    reviewer: async () => ({ verdict: "revise", missing: ["A requested part is missing."], feedback: [], summary: "Incomplete" }),
    adapterFactory: async () => ({ async start() { starts++; return { completion: Promise.resolve({ status: "completed", text: report() }) }; }, async cancel() {} })
  });
  try {
    await submit(service); const final = await service.waitForTask("parent");
    assert.equal(starts, 3); assert.equal(final.status, "completed"); assert.equal(final.result.report.outcome, "partial");
    assert.equal(final.result.report.verification.stopReason, "rounds");
    assert.match(final.result.report.answer, /Useful result/); assert.match(final.result.report.limitations.join(" "), /requested part/);
  } finally { await service.shutdown(); await f.close(); }
});

test("agents on one goal share a brief and team board, each working in its own directory", async () => {
  const f = await fixture(); const seen = [];
  const service = new AssistantWorkerService({ ...f.options, planner: async () => plan, reviewer: pass,
    adapterFactory: async ({ task, workspacePath }) => ({ async start({ prompt }) {
      seen.push({ taskId: task.taskId, workspacePath, prompt });
      return { completion: Promise.resolve({ status: "completed", text: report(task.taskId) }) };
    }, async cancel() {} })
  });
  try {
    await service.submitTask({ taskId: "goal", capability: "openclaw-general-v1", layout: "shared", context: "# User request\n\nProduce a report", prompt: "unused", metadata: { managerMode: true, sourceRequest: "Produce a report", conversationId: "test" } });
    const final = await service.waitForTask("goal");
    assert.equal(final.status, "completed");
    const shared = join(f.root, "workspaces", "goal", "shared");
    assert.match(await readFile(join(shared, "BRIEF.md"), "utf8"), /Both assignments are covered/);
    const team = await readFile(join(shared, "TEAM.md"), "utf8");
    assert.match(team, /goal-child-1/); assert.match(team, /goal-child-2/);
    for (const item of seen) {
      assert.equal(item.workspacePath, join(f.root, "workspaces", "goal", "tasks", item.taskId));
      assert.match(item.prompt, new RegExp(`${shared}/BRIEF.md`));
    }
  } finally { await service.shutdown(); await f.close(); }
});

test("EV's settled reading of the ask reaches the agents unchanged, and EV tells the person what was done", async () => {
  const f = await fixture(); const prompts = []; const settled = []; let plannerSaw = null;
  const understanding = { request: "Compare the two quotes in quotes/ and recommend one", literalAsk: "which one should i go with", title: "Pick a quote",
    intent: "Choose the better-value quote for the kitchen job", servesGoal: "Renovate the kitchen this spring", successCriteria: ["Names one quote and why"], qualityBar: ["Short, plain answer"], assumptions: ["Price and timeline matter most"], unknowns: [] };
  const service = new AssistantWorkerService({ ...f.options,
    planner: async (input) => { plannerSaw = input.understanding; return { goal: "Recommend a quote", intent: "Something else entirely", reviewRounds: 2, subtasks: [] }; },
    reviewer: async () => ({ verdict: "accept", summary: "Clear", handoff: "I compared both quotes and recommend B: same scope, two weeks sooner." }),
    onTaskSettled: (task) => settled.push(task),
    adapterFactory: async () => ({ async start({ prompt }) { prompts.push(prompt); return { completion: Promise.resolve({ status: "completed", text: report("Go with B") }) }; }, async cancel() {} })
  });
  try {
    await service.submitTask({ taskId: "goal", capability: "openclaw-general-v1", layout: "shared", context: "# User request", prompt: "unused",
      metadata: { managerMode: true, sourceRequest: understanding.request, understanding, title: understanding.title, conversationId: "test" } });
    const final = await service.waitForTask("goal");
    assert.equal(plannerSaw.intent, understanding.intent);
    const brief = await readFile(join(f.root, "workspaces", "goal", "shared", "BRIEF.md"), "utf8");
    assert.match(brief, /which one should i go with/); assert.match(brief, /better-value quote/); assert.doesNotMatch(brief, /Something else entirely/);
    assert.match(brief, /Review rounds: up to 2/);
    assert.match(prompts[0], /better-value quote/);
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
  }, async cancel() {} }) });
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

test("cancelling a parent stops both an active child and a child waiting for capacity", async () => {
  const f = await fixture(); const cancelled = [];
  const service = new AssistantWorkerService({ ...f.options, planner: async () => plan, reviewer: pass, maxConcurrentWorkers: 1,
    adapterFactory: async ({ task }) => ({
      async start() { let finish; return { completion: new Promise((resolve) => { finish = resolve; }), finish: (result) => finish(result) }; },
      async cancel(run) { cancelled.push(task.taskId); run.finish({ status: "cancelled" }); }
    })
  });
  try {
    await submit(service);
    await until(async () => (await f.supervisor.listTasks()).length === 3 && service.runningWorkers === 1 && service.workerQueue.length === 1);
    await service.cancelTask({ taskId: "parent", reason: "user-requested" });
    assert.deepEqual((await f.supervisor.listTasks()).map((task) => task.status), ["cancelled", "cancelled", "cancelled"]);
    assert.equal(cancelled.length, 1); assert.equal(service.runningWorkers, 0); assert.equal(service.workerQueue.length, 0);
  } finally { await service.shutdown(); await f.close(); }
});

test("restart preserves the plan and completed child, then resumes interrupted work and combines it", async () => {
  const f = await fixture(); const starts = [];
  const first = new AssistantWorkerService({ ...f.options, planner: async () => plan, reviewer: pass,
    adapterFactory: async ({ task }) => ({
      async start() {
        starts.push(task.taskId);
        if (task.taskId === "parent-child-1") return { completion: Promise.resolve({ status: "completed", text: report("first child") }) };
        let finish; return { completion: new Promise((resolve) => { finish = resolve; }), finish: (value) => finish(value) };
      }, async cancel(run) { run.finish({ status: "cancelled" }); }
    })
  });
  let second;
  try {
    await submit(first);
    await until(async () => (await f.supervisor.getTask("parent-child-1").catch(() => null))?.status === "completed");
    await first.shutdown();
    second = new AssistantWorkerService({ ...f.options, planner: async () => { assert.fail("A saved plan must be reused"); }, reviewer: pass,
      adapterFactory: async ({ task }) => ({ async start() { starts.push(task.taskId); return { completion: Promise.resolve({ status: "completed", text: report(task.taskId) }) }; }, async cancel() {} })
    });
    await second.start(); const final = await second.waitForTask("parent");
    assert.equal(final.status, "completed");
    assert.equal(starts.filter((id) => id === "parent-child-1").length, 1);
    assert.equal(starts.filter((id) => id === "parent-child-2").length, 2);
    assert.equal(final.history.filter((event) => event.type === "manager_plan").length, 1);
  } finally { await second?.shutdown(); await f.close(); }
});

test("a claimed file that does not exist cannot be delivered as a completed outcome", async () => {
  const f = await fixture();
  const service = new AssistantWorkerService({ ...f.options, planner: async () => normalizeTaskPlan(null, "Create a file"), reviewer: pass,
    adapterFactory: async () => ({ async start() { return { completion: Promise.resolve({ status: "completed", text: report("Created it", { deliverables: [{ path: "missing.md" }] }) }) }; }, async cancel() {} })
  });
  try {
    await submit(service); const final = await service.waitForTask("parent");
    assert.equal(final.result.report.outcome, "partial"); assert.equal(final.artifacts.length, 0);
    assert.match(final.result.report.limitations.join(" "), /does not exist/);
  } finally { await service.shutdown(); await f.close(); }
});

test("an assignment with uncertain side effects is not automatically repeated after a crash", async () => {
  const f = await fixture(); const starts = [];
  const service = new AssistantWorkerService({ ...f.options, reviewer: pass,
    planner: async () => ({ ...plan, subtasks: plan.subtasks.map((task) => ({ ...task, retrySafe: false })) }),
    adapterFactory: async ({ task }) => ({ async start() {
      starts.push(task.taskId);
      return { completion: Promise.resolve(task.taskId.endsWith("child-2") ? { status: "failed", code: "OPENCLAW_PROCESS_EXIT", message: "Unknown action outcome" } : { status: "completed", text: report("Successful contribution retained", task.taskId === "parent" ? { outcome: "partial" } : {}) }) };
    }, async cancel() {} })
  });
  try {
    await submit(service); const final = await service.waitForTask("parent");
    assert.equal(starts.length, 3); assert.equal(starts.some((id) => id.endsWith("retry")), false);
    assert.equal(final.result.report.outcome, "partial"); assert.equal(final.result.report.verification.childTasks[1].status, "failed");
  } finally { await service.shutdown(); await f.close(); }
});

test("an honest blocker is delivered without a forced post link or a correction loop", async () => {
  const f = await fixture(); let starts = 0;
  const service = new AssistantWorkerService({ ...f.options,
    reviewer: async () => { assert.fail("Blocked outcomes do not require a publication review"); },
    adapterFactory: async () => ({ async start() { starts++; return { completion: Promise.resolve({ status: "completed", text: report("Access denied; no posts verified", { outcome: "blocked" }) }) }; }, async cancel() {} })
  });
  try {
    await service.submitTask({ taskId: "blocked", capability: "openclaw-general-v1", prompt: "Read posts", context: "Read posts", metadata: { sourceRequest: "Read @tibo posts", verification: { needsSources: true, expectedAccount: "tibo" } } });
    const final = await service.waitForTask("blocked");
    assert.equal(final.status, "completed"); assert.equal(final.result.report.outcome, "blocked"); assert.equal(starts, 1);
  } finally { await service.shutdown(); await f.close(); }
});
