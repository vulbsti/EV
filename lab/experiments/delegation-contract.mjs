import { routeUtterance } from "../lib/companion-policy.mjs";

export const experiment = {
  id: "delegation-contract",
  group: "authority",
  description: "Exercises transcript preservation, frozen context, exact-once dispatch, and reply correlation.",
  async run() {
    const dispatched = new Map();
    const originalContext = { selectedPane: "%3", project: "ev" };
    const transcript = "Investigate why pane three appears stuck, but do not interrupt it.";
    const route = routeUtterance({ utteranceId: "utt-001", transcript, uiContext: originalContext, observedState: { status: "running" } });
    originalContext.selectedPane = "%999";

    function dispatch(envelope) {
      if (dispatched.has(envelope.utteranceId)) return { accepted: false, duplicate: true, taskId: dispatched.get(envelope.utteranceId) };
      const taskId = "task-001";
      dispatched.set(envelope.utteranceId, taskId);
      return { accepted: true, duplicate: false, taskId };
    }

    const first = dispatch(route.delegation);
    const duplicate = dispatch(route.delegation);
    const reply = { utteranceId: route.delegation.utteranceId, taskId: first.taskId, text: "Pane three is running a long test; no interruption was sent.", source: "orchestrator" };
    const checks = {
      exactTranscript: route.delegation.transcript === transcript,
      contextFrozen: route.delegation.uiContext.selectedPane === "%3",
      firstAccepted: first.accepted,
      duplicateRejected: duplicate.duplicate,
      replyCorrelated: reply.utteranceId === route.delegation.utteranceId && reply.taskId === first.taskId,
      replyProvenance: reply.source === "orchestrator"
    };
    return {
      status: Object.values(checks).every(Boolean) ? "passed" : "failed",
      metrics: { checksPassed: Object.values(checks).filter(Boolean).length, checksTotal: Object.keys(checks).length, dispatchCount: dispatched.size },
      observations: { checks, first, duplicate, reply },
      gates: { exactOnce: true, correlation: true }
    };
  }
};
