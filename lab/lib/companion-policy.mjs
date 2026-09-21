const READ_ONLY_TOOLS = new Set(["fleet_snapshot", "terminal_tail", "task_status", "web_search", "read_file"]);
const MUTATING_TOOLS = new Set(["send_keys", "spawn_agent", "kill_pane", "write_file", "approve", "run_command"]);

const ACTION_PATTERNS = /\b(fix|build|create|track|change|edit|run|execute|deploy|commit|push|spawn|stop|kill|approve|delete|send)\b/i;
const DEEP_PATTERNS = /\b(analy[sz]e|investigate|reason|decide|compare|plan|root cause|why (?:is|does|did))\b/i;
const QUERY_PATTERNS = /\b(status|what|which|show|tell me|how many|read|look up|search)\b/i;

// An explicit negative imperative is a constraint on the request, not an
// action request. Strip only that clause before checking action keywords so a
// real action earlier in the utterance still delegates.
const NEGATED_ACTION_CLAUSE = /\b(?:do\s+not|don't|dont|never)\b[^.!?;]*(?=$|[.!?;])/gi;

export function classifyUtterance(text) {
  const actionableText = text.replace(NEGATED_ACTION_CLAUSE, " ");
  if (ACTION_PATTERNS.test(actionableText)) return "action";
  if (DEEP_PATTERNS.test(text)) return "delegated_reasoning";
  if (QUERY_PATTERNS.test(text)) return "read_query";
  return "conversation";
}

export function authorizeCompanionTool(tool) {
  if (READ_ONLY_TOOLS.has(tool)) return { allowed: true, disposition: "execute_readonly" };
  if (MUTATING_TOOLS.has(tool)) return { allowed: false, disposition: "delegate_to_orchestrator" };
  return { allowed: false, disposition: "deny_unknown_tool" };
}

export function routeUtterance({ utteranceId, transcript, uiContext = {}, observedState = {} }) {
  const kind = classifyUtterance(transcript);
  const delegated = kind === "action" || kind === "delegated_reasoning";
  return {
    utteranceId,
    kind,
    route: delegated ? "orchestrator" : "companion",
    delegation: delegated ? {
      schemaVersion: 1,
      utteranceId,
      transcript,
      uiContext: structuredClone(uiContext),
      observedState: structuredClone(observedState),
      requestedAt: new Date().toISOString()
    } : null
  };
}
