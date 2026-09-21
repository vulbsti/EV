import test from "node:test";
import assert from "node:assert/strict";
import { handleCompanion } from "../lib/companion.mjs";

function fixture() {
  const events = [];
  return {
    events,
    store: { async append(type, payload, correlationId) { events.push({ type, payload, correlationId }); } },
    fleet: {
      sessions: [{ sessionId: "$1", name: "labs" }],
      panes: [
        {
          paneId: "%1",
          sessionName: "labs",
          command: "codex",
          path: "/work/api",
          active: true,
          attention: { required: true, label: "Review requested" }
        },
        { paneId: "%2", sessionName: "labs", command: "node", path: "/work/web", active: false }
      ]
    }
  };
}

test("read query is answered from real fleet data without creating a task", async () => {
  const { events, store, fleet } = fixture();
  const result = await handleCompanion({ transcript: "Which agents are running?", selectedPaneId: null, fleet, store });
  assert.equal(result.route, "companion");
  assert.match(result.response, /2 panes across 1 tmux sessions/);
  assert.equal(events.some((event) => event.type === "task.delegated"), false);
});

test("browser-tested read-only summary with negated commands stays local", async () => {
  const { events, store, fleet } = fixture();
  const result = await handleCompanion({
    transcript: "Summarize which EV terminal currently needs attention. Do not send any commands or change any terminal.",
    selectedPaneId: null,
    fleet,
    store
  });
  assert.equal(result.classification, "read_query");
  assert.equal(result.route, "companion");
  assert.equal(result.response, "1 terminal pane currently needs your attention: %1 (codex) — Review requested.");
  assert.equal(events.some((event) => event.type === "task.delegated"), false);
});

test("reasoning request freezes selected pane and creates an orchestrator handoff", async () => {
  const { events, store, fleet } = fixture();
  const result = await handleCompanion({ transcript: "Investigate why this agent is stuck", selectedPaneId: "%1", fleet, store });
  assert.equal(result.route, "orchestrator");
  assert.match(result.taskId, /^task-/);
  const delegated = events.find((event) => event.type === "task.delegated");
  assert.equal(delegated.payload.selectedPaneId, "%1");
  assert.equal(delegated.payload.transcript, "Investigate why this agent is stuck");
});
