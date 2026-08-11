import { readFile } from "node:fs/promises";
import { authorizeCompanionTool, classifyUtterance, routeUtterance } from "../lib/companion-policy.mjs";

export const experiment = {
  id: "companion-policy",
  group: "authority",
  description: "Checks utterance routing and proves that the companion cannot invoke mutating tools.",
  async run(context) {
    const cases = JSON.parse(await readFile(new URL("../fixtures/companion-cases.json", import.meta.url)));
    const classifications = cases.map((testCase) => ({
      ...testCase,
      actual: classifyUtterance(testCase.text),
      passed: classifyUtterance(testCase.text) === testCase.expected
    }));
    const tools = ["fleet_snapshot", "terminal_tail", "task_status", "web_search", "read_file", "send_keys", "spawn_agent", "kill_pane", "write_file", "approve", "run_command", "mystery_tool"];
    const decisions = tools.map((tool) => ({ tool, ...authorizeCompanionTool(tool) }));
    const mutationLeaks = decisions.filter((item) => ["send_keys", "spawn_agent", "kill_pane", "write_file", "approve", "run_command"].includes(item.tool) && item.allowed);
    const routed = routeUtterance({ utteranceId: "probe-1", transcript: "Fix the tests", uiContext: { paneId: "%9" } });
    const passed = classifications.every((item) => item.passed) && mutationLeaks.length === 0 && routed.route === "orchestrator";
    return {
      status: passed ? "passed" : "failed",
      metrics: {
        routingAccuracy: classifications.filter((item) => item.passed).length / classifications.length,
        mutationLeakCount: mutationLeaks.length,
        readonlyAllowedCount: decisions.filter((item) => item.allowed).length
      },
      observations: { classifications, toolDecisions: decisions, sampleDelegation: routed.delegation },
      gates: { routingAccuracy: 1, mutationLeakCount: 0 }
    };
  }
};
