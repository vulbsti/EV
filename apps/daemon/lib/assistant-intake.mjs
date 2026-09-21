import { routeUtterance } from "../../../lab/lib/companion-policy.mjs";

function describeFleet(fleet) {
  const commandCounts = Object.entries(Object.groupBy(fleet.panes, (pane) => pane.command))
    .map(([command, panes]) => `${panes.length} ${command}`)
    .join(", ");
  return `I can see ${fleet.panes.length} panes across ${fleet.sessions.length} tmux sessions: ${commandCounts || "no running panes"}.`;
}

function describeAttention(fleet) {
  const panes = fleet.panes.filter((pane) => pane.attention?.required);
  if (!panes.length) return "No terminal panes currently need your attention.";
  const summaries = panes.map((pane) => `${pane.paneId} (${pane.command})${pane.attention?.label ? ` — ${pane.attention.label}` : ""}`);
  return `${panes.length} terminal pane${panes.length === 1 ? "" : "s"} currently need${panes.length === 1 ? "s" : ""} your attention: ${summaries.join("; ")}.`;
}

/**
 * Produce the smallest truthful Phase 1 turn. This is deliberately not an
 * agent loop: executable work remains not_executable until a real worker and
 * supervisor exist.
 */
export function planAssistantTurn({ clientMessageId, transcript, fleet }) {
  const route = routeUtterance({
    utteranceId: clientMessageId,
    transcript,
    observedState: { sessionCount: fleet.sessions.length, paneCount: fleet.panes.length }
  });

  if (route.route === "orchestrator") {
    return {
      classification: route.kind,
      route: "not_executable",
      response: "I saved this request, but this EV build cannot execute background work yet. I marked it not executable instead of pretending it is running.",
      task: { status: "not_executable", reason: "No supervised worker is installed." }
    };
  }

  const lower = transcript.toLowerCase();
  let response;
  if (/\battention\b/.test(lower)) response = describeAttention(fleet);
  else if (/\b(pane|terminal|agent|running|status|session)\b/.test(lower)) response = describeFleet(fleet);
  else if (/\b(hello|hi|hey)\b/.test(lower)) response = "Hello. I can keep this conversation durable and answer read-only questions about the local EV fleet.";
  else response = "I can currently preserve this conversation and answer read-only EV fleet questions. Background work is not enabled yet.";

  return { classification: route.kind, route: "assistant", response, task: null };
}
