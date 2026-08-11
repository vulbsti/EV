import test from "node:test";
import assert from "node:assert/strict";
import { authorizeCompanionTool, classifyUtterance, routeUtterance } from "../lib/companion-policy.mjs";

test("voice companion cannot execute mutating tools", () => {
  for (const tool of ["send_keys", "spawn_agent", "kill_pane", "write_file", "approve", "run_command"]) {
    assert.deepEqual(authorizeCompanionTool(tool), { allowed: false, disposition: "delegate_to_orchestrator" });
  }
});

test("read-only observations remain local to the companion", () => {
  for (const tool of ["fleet_snapshot", "terminal_tail", "task_status", "web_search", "read_file"]) {
    assert.equal(authorizeCompanionTool(tool).allowed, true);
  }
});

test("action and deeper reasoning are delegated with exact transcript and frozen context", () => {
  assert.equal(classifyUtterance("Fix the failing tests"), "action");
  assert.equal(classifyUtterance("Investigate why tests are flaky"), "delegated_reasoning");
  const context = { pane: "%4" };
  const routed = routeUtterance({ utteranceId: "u1", transcript: "Fix it", uiContext: context });
  context.pane = "%9";
  assert.equal(routed.route, "orchestrator");
  assert.equal(routed.delegation.transcript, "Fix it");
  assert.equal(routed.delegation.uiContext.pane, "%4");
});
