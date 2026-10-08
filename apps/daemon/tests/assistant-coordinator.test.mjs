import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AssistantCoordinator, isR1ContentRequest, parseCoordinatorPlan } from "../lib/assistant-coordinator.mjs";

const request = "Turn my rough launch notes into a build-in-public post and a short reel outline.";
const valid = {
  title: "Share the launch learning",
  objective: "Explain what changed and why it matters without overstating progress.",
  deliverables: ["Build-in-public post", "Short reel outline"],
  successCriteria: ["Use one clear angle", "Do not invent metrics", "Review and revise the first draft"],
  assumptions: ["Prepare only; do not publish"]
};

test("recognizes natural R1 requests without an exact magic sentence", () => {
  for (const text of [
    request,
    "Help me shape this idea into a post for building in public.",
    "Draft a reel script about what we learned from the launch."
  ]) assert.equal(isR1ContentRequest(text), true, text);
  assert.equal(isR1ContentRequest("What is the status of the daemon?"), false);
});

test("parses a bounded plan and ignores model attempts to grant another capability", () => {
  const plan = parseCoordinatorPlan(JSON.stringify({ ...valid, title: "A".repeat(180), capability: "unrestricted-shell", authority: "publish" }), request);
  assert.equal(plan.capability, "r1-content-package-v1");
  assert.equal(plan.authority, "prepare_only");
  assert.equal(plan.plannerMode, "model");
  assert.equal(plan.title.length, 120);
  assert.match(plan.title, /…$/);
  assert.deepEqual(plan.deliverables, valid.deliverables);
});

test("uses the live-shaped adapter result and includes reviewed context in the prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-r1-coordinator-"));
  let prompt = "";
  const coordinator = new AssistantCoordinator({ root, adapterFactory: () => ({
    async start(input) {
      prompt = input.prompt;
      return { completion: Promise.resolve({ status: "completed", text: `\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``, usage: { totalTokens: 2_000, cost: { total: 0.001 } } }) };
    }
  }) });
  try {
    const plan = await coordinator.plan({
      clientMessageId: "message-1",
      conversationId: "default",
      request,
      explicitGuidance: ["Keep posts concise."],
      derivedMemory: { text: "The user rejected exaggerated launch claims." }
    });
    assert.equal(plan.title, valid.title);
    assert.match(prompt, /Keep posts concise/);
    assert.match(prompt, /rejected exaggerated launch claims/);
    assert.match(prompt, /Return JSON only/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("falls back honestly when the coordinator is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-r1-coordinator-"));
  const coordinator = new AssistantCoordinator({ root, adapterFactory: () => ({
    async start() { throw Object.assign(new Error("offline"), { code: "MODEL_OFFLINE" }); }
  }) });
  try {
    const plan = await coordinator.plan({ clientMessageId: "message-2", conversationId: "default", request });
    assert.equal(plan.plannerMode, "fallback");
    assert.match(plan.assumptions.join(" "), /MODEL_OFFLINE/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bounds coordinator guidance and falls back when its own budget is exceeded", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-r1-coordinator-"));
  let prompt = "";
  const coordinator = new AssistantCoordinator({ root, adapterFactory: () => ({
    async start(input) {
      prompt = input.prompt;
      return {
        completion: Promise.resolve({
          status: "completed",
          text: JSON.stringify(valid),
          usage: { totalTokens: 6_001, cost: { total: 0.001 } }
        })
      };
    }
  }) });
  try {
    const guidance = Array.from({ length: 9 }, (_, index) => `${index === 8 ? "NINTH-SENTINEL" : `guidance-${index}`} ${"x".repeat(990)}`);
    const plan = await coordinator.plan({ clientMessageId: "message-budget", conversationId: "default", request, explicitGuidance: guidance });
    assert.equal(plan.plannerMode, "fallback");
    assert.match(plan.assumptions.join(" "), /coordinator-budget-exceeded/);
    assert.doesNotMatch(prompt, /NINTH-SENTINEL/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("falls back when a completed coordinator omits its usage receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-r1-coordinator-"));
  const coordinator = new AssistantCoordinator({ root, adapterFactory: () => ({
    async start() { return { completion: Promise.resolve({ status: "completed", text: JSON.stringify(valid) }) }; }
  }) });
  try {
    const plan = await coordinator.plan({ clientMessageId: "message-no-usage", conversationId: "default", request });
    assert.equal(plan.plannerMode, "fallback");
    assert.match(plan.assumptions.join(" "), /coordinator-usage-missing/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
