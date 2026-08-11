import { randomUUID } from "node:crypto";
import { routeUtterance } from "../../../lab/lib/companion-policy.mjs";

function describeFleet(fleet) {
  const commandCounts = Object.entries(Object.groupBy(fleet.panes, (pane) => pane.command))
    .map(([command, panes]) => `${panes.length} ${command}`)
    .join(", ");
  return `I can see ${fleet.panes.length} panes across ${fleet.sessions.length} tmux sessions: ${commandCounts || "no running panes"}.`;
}

function describeSelectedPane(fleet, paneId) {
  const pane = fleet.panes.find((candidate) => candidate.paneId === paneId);
  if (!pane) return null;
  return `Pane ${pane.paneId} is running ${pane.command} in ${pane.path}. It is ${pane.active ? "the active pane in its window" : "not the active pane in its window"}.`;
}

export async function handleCompanion({ transcript, selectedPaneId, fleet, store }) {
  const utteranceId = randomUUID();
  const route = routeUtterance({
    utteranceId,
    transcript,
    uiContext: { selectedPaneId },
    observedState: {
      sessionCount: fleet.sessions.length,
      paneCount: fleet.panes.length,
      selectedPane: fleet.panes.find((pane) => pane.paneId === selectedPaneId) ?? null
    }
  });
  await store.append("voice.utterance", { utteranceId, transcript, selectedPaneId, classification: route.kind, route: route.route }, utteranceId);

  if (route.route === "orchestrator") {
    const taskId = `task-${randomUUID().slice(0, 8)}`;
    await store.append("task.delegated", {
      taskId,
      utteranceId,
      transcript: route.delegation.transcript,
      selectedPaneId: route.delegation.uiContext.selectedPaneId,
      envelope: route.delegation
    }, utteranceId);
    const response = `I created ${taskId} and handed the request to the orchestrator queue. This prototype will not execute it automatically.`;
    await store.append("companion.reply", { utteranceId, taskId, response, source: "companion" }, utteranceId);
    return { utteranceId, taskId, classification: route.kind, route: route.route, response };
  }

  const lower = transcript.toLowerCase();
  let response;
  if (/\b(pane|terminal|agent|running|status|session)\b/.test(lower)) {
    response = selectedPaneId && /\b(this|that|selected|current|pane)\b/.test(lower)
      ? describeSelectedPane(fleet, selectedPaneId) ?? describeFleet(fleet)
      : describeFleet(fleet);
  } else if (/\b(hello|hi|hey)\b/.test(lower)) {
    response = `Hello. I am watching ${fleet.panes.length} terminal panes and I can answer read-only fleet questions.`;
  } else {
    response = "I can discuss the fleet and inspect read-only state. Requests requiring reasoning or action will be handed to the orchestrator.";
  }
  await store.append("companion.reply", { utteranceId, response, source: "companion" }, utteranceId);
  return { utteranceId, classification: route.kind, route: route.route, response };
}
