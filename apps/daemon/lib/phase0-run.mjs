import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateAssistantRunBundle } from "./assistant-run-bundle.mjs";

export const COUNT_PROMPT = "How many terminal panes and tmux sessions are currently running?";
export const ATTENTION_PROMPT = "Summarize which EV terminal currently needs attention. Do not send any commands or change any terminal.";

function utterancesMatching(events, transcript) {
  return events.filter((event) => event.type === "voice.utterance" && event.payload?.transcript === transcript);
}

function companionReply(events, correlationId) {
  return events.find((event) => event.type === "companion.reply" && event.correlationId === correlationId);
}

function delegated(events, correlationId) {
  return events.some((event) => event.type === "task.delegated" && event.correlationId === correlationId);
}

function requireEvent(event, message) {
  if (!event) throw new Error(message);
  return event;
}

function selectCanaryEvidence(events) {
  const countRun = requireEvent(
    utterancesMatching(events, COUNT_PROMPT).find((event) => event.payload?.classification === "read_query"),
    "No successful read-only count canary was found in the event ledger."
  );
  const countReply = requireEvent(companionReply(events, countRun.correlationId), "The count canary has no companion reply.");

  const attentionRuns = utterancesMatching(events, ATTENTION_PROMPT);
  const baseline = requireEvent(
    attentionRuns.find((event) => event.payload?.classification === "action" && delegated(events, event.correlationId)),
    "No baseline attention-query misroute was found in the event ledger."
  );
  const correctedCandidates = attentionRuns.filter(
    (event) => event.payload?.classification === "read_query" && !delegated(events, event.correlationId)
  );
  const finalRun = requireEvent(
    [...correctedCandidates].reverse().find((event) => /needs your attention:/i.test(companionReply(events, event.correlationId)?.payload?.response ?? "")),
    "No corrected attention-query result naming an attention target was found in the event ledger."
  );
  const finalReply = requireEvent(companionReply(events, finalRun.correlationId), "The corrected attention canary has no companion reply.");
  const intermediate = correctedCandidates.find((event) => /No terminal panes currently need your attention\./i.test(companionReply(events, event.correlationId)?.payload?.response ?? ""));

  const correlationIds = [baseline.correlationId, countRun.correlationId, intermediate?.correlationId, finalRun.correlationId].filter(Boolean);
  const selectedEvents = events.filter((event) => correlationIds.includes(event.correlationId));
  const startedAt = selectedEvents.map((event) => event.occurredAt).sort()[0];
  const endedAt = selectedEvents.map((event) => event.occurredAt).sort().at(-1);

  return {
    baseline,
    countRun,
    countReply,
    intermediate,
    finalRun,
    finalReply,
    selectedEvents,
    startedAt,
    endedAt
  };
}

function contextManifest(evidence) {
  return {
    transcript: {
      revision: evidence.finalRun.eventId,
      includedUtterances: [COUNT_PROMPT, ATTENTION_PROMPT]
    },
    taskBrief: {
      revision: "phase0-browser-canaries-v1",
      scope: "Read-only fleet count, attention summary, reload, and attention-popover dismissal."
    },
    personView: { status: "not_applicable_no_model_call" },
    relationshipPolicy: { status: "not_applicable_no_model_call" },
    sourceEvidence: evidence.selectedEvents.map((event) => ({ eventId: event.eventId, type: event.type })),
    memoryItems: [],
    capabilities: [
      { id: "fleet-read", revision: "companion-policy-v1" },
      { id: "attention-summary", revision: "control-snapshot-v1" }
    ],
    mandate: { status: "read_only_browser_canary" }
  };
}

function runMetadata({ runId, date, repositoryRevision, evidence }) {
  return {
    runId,
    date,
    phase: "phase-0",
    taskFixture: "live-browser-canaries:b0.1-b0.3",
    repositoryRevision,
    candidateState: "working-tree",
    featureFlags: { companion: true, orchestratorExecution: false },
    schemaVersions: { events: 1, contextManifest: 1, assistantRun: 1 },
    models: { assistant: "none_rule_based_phase0" },
    provider: { name: "local_ev_daemon", version: "prototype" },
    harness: { name: "computer_use_plus_event_ledger", version: 1 },
    mandateRevision: "phase0-read-only-browser-canary-v1",
    startedAt: evidence.startedAt,
    endedAt: evidence.endedAt,
    cost: { modelTokens: 0, externalApiUsd: 0, terminalCommandsSentByCanary: 0 },
    links: {
      events: "events.jsonl",
      context: "context-manifest.json",
      journey: "ui/journey.md",
      scorecard: "scorecard.md",
      issues: "issues.md",
      decision: "decision.md",
      browserReceipt: "receipts/browser-verification.json"
    },
    uiEvidence: {
      method: "computer_use_accessibility_tree",
      screenshots: {
        status: "omitted_privacy",
        reason: "The live terminal wall contained unrelated terminal content; textual UI observations and event receipts were retained instead."
      }
    }
  };
}

function journeyMarkdown(evidence) {
  const intermediateReply = evidence.intermediate ? companionReply(evidence.selectedEvents, evidence.intermediate.correlationId)?.payload?.response : "Not observed";
  return `# Phase 0 browser journey

Environment: live EV workstation at \`http://127.0.0.1:4317/\`, operated through computer use.

Screenshots were deliberately omitted because the terminal wall contained unrelated private terminal content.

| Step | Visible action | Visible result | Assessment |
| --- | --- | --- | --- |
| 1 | Submitted the fleet-count question | ${evidence.countReply.payload.response} | Passed; read-only route and no delegated task. |
| 2 | Submitted the attention-summary question on the baseline | EV queued a task as \`awaiting_orchestrator\` and disclosed that it would not execute automatically. | Failed routing; safe but added management burden. |
| 3 | Repeated the attention question after the negation-routing repair | ${intermediateReply} | Failed truthfulness: the companion read raw fleet data while the UI used enriched attention state. |
| 4 | Repeated the same question after unifying the data source | ${evidence.finalReply.payload.response} | Passed; read-only route, correct attention target, and no delegated task. |
| 5 | Reloaded the real page | The latest reply disappeared; the historical baseline queue item remained visible. | Failed reply persistence; carry into Phase 1. |
| 6 | Opened and dismissed the attention item | The popover closed. | Passed interaction safety; no terminal input or control request was sent. |

The failed observations are retained because they identify two different causal defects: intent parsing and a split source of fleet truth.
`;
}

function scorecardMarkdown(evidence) {
  return `# Phase 0 scorecard

| Dimension | Result | Evidence |
| --- | --- | --- |
| Read-only fleet count | Pass | \`${evidence.countRun.correlationId}\` returned \`${evidence.countReply.payload.response}\`. |
| Read-only attention summary | Pass after two repairs | \`${evidence.finalRun.correlationId}\` returned \`${evidence.finalReply.payload.response}\`. |
| Routing safety | Pass on fixed fixture | Final attention request classified \`read_query\`; no \`task.delegated\` event shares its correlation ID. |
| Terminal mutation | Pass | Zero terminal commands were sent by the canary; popover dismissal was UI-local. |
| Reload durability | Fail | The current companion reply disappeared after page reload. |
| User management burden | Partial | The current query is answered directly, but the old baseline queue item remains and replies are not durable. |
| Model/provider cost | Not applicable | Phase 0 companion behavior is deterministic and rule based. |

Decision: pass Phase 0 with the reload/durable-conversation gap promoted to the first Phase 1 blocker.
`;
}

function issuesMarkdown(evidence) {
  return `# Phase 0 issues

## Repaired in this run

1. **Negated action words were treated as requested actions.** Baseline event \`${evidence.baseline.eventId}\` classified the safe attention summary as \`action\`. The policy now removes explicit negated action clauses before action-keyword matching, with regression fixtures for both browser utterances.
2. **The companion and visible UI used different fleet representations.** The first routing-fixed run reported no attention items. The companion endpoint now receives \`controlSnapshot(72)\`, the same enriched state used by the UI.

## Still open

1. Companion replies are not reconstructed after reload.
2. The historical misrouted task remains \`awaiting_orchestrator\`; there is no cancellation or archival flow in the prototype.
3. There is no durable conversation intake, executing assistant worker, connector boundary, person model, or context manifest at runtime yet.
4. This run intentionally omitted screenshots for privacy; accessibility-tree observations and matching event receipts are the retained UI evidence.
`;
}

function decisionMarkdown() {
  return `# Phase 0 decision

Decision date: 2026-09-21

Decision: **advance narrowly to Phase 1**.

Phase 0 now has a validated evidence-bundle command, deterministic routing fixtures, and an actual browser-to-daemon-to-ledger canary. The rerun proved the safe attention request can be answered without queuing or touching a terminal. It also exposed the next first-order defect: the answer is transient across reload, while an obsolete queued task remains durable.

## Revised Phase 1

- **Product question:** Can EV preserve one conversation and truthful task state through rapid input, reload, reconnect, and daemon restart?
- **Smallest implementation delta:** SQLite-backed messages, intents, tasks, and events; idempotent submit; resumable projection; immediate accepted/rejected state; explicit \`not_executable\` when no worker exists.
- **Explicit exclusions:** no model router, Pi worker, connector, memory/person model, scheduled autonomy, or consequential external action.
- **Required computer-use journeys:** two rapid unrelated messages, reload during the second, offline/reconnect, keyboard-only use, and historical-task cleanup visibility.
- **Frozen exit gate:** zero lost or duplicated inputs; five consecutive reload/reconnect journeys; no state that implies work started when no worker exists; latest assistant reply survives reload.
- **Stop condition:** do not add a model or worker while durable truth and replay remain ambiguous.
`;
}

/** Create and validate the concrete Phase 0 browser-canary evidence bundle. */
export async function createPhase0RunBundle({
  eventsPath,
  outputRoot,
  date,
  runId = "phase0-b0-routing",
  repositoryRevision
}) {
  const source = await readFile(eventsPath, "utf8");
  const events = source
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`Invalid event JSON at line ${index + 1}.`);
      }
    });
  const evidence = selectCanaryEvidence(events);
  const bundlePath = resolve(outputRoot, "artifacts", "assistant-runs", date, runId);
  await mkdir(join(bundlePath, "ui"), { recursive: true });
  await mkdir(join(bundlePath, "receipts"), { recursive: true });
  await mkdir(join(bundlePath, "artifacts"), { recursive: true });

  const browserReceipt = {
    schemaVersion: 1,
    method: "computer_use_accessibility_tree",
    countCorrelationId: evidence.countRun.correlationId,
    baselineAttentionCorrelationId: evidence.baseline.correlationId,
    intermediateAttentionCorrelationId: evidence.intermediate?.correlationId ?? null,
    correctedAttentionCorrelationId: evidence.finalRun.correlationId,
    correctedClassification: evidence.finalRun.payload.classification,
    correctedRoute: evidence.finalRun.payload.route,
    correctedReply: evidence.finalReply.payload.response,
    delegatedTaskForCorrectedRun: delegated(events, evidence.finalRun.correlationId),
    reloadReplyPersisted: false,
    attentionPopoverDismissed: true,
    terminalControlSent: false,
    screenshots: "omitted_privacy"
  };

  const files = {
    "run.json": `${JSON.stringify(runMetadata({ runId, date, repositoryRevision, evidence }), null, 2)}\n`,
    "events.jsonl": `${evidence.selectedEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "context-manifest.json": `${JSON.stringify(contextManifest(evidence), null, 2)}\n`,
    "scorecard.md": scorecardMarkdown(evidence),
    "issues.md": issuesMarkdown(evidence),
    "decision.md": decisionMarkdown(),
    "ui/journey.md": journeyMarkdown(evidence),
    "receipts/browser-verification.json": `${JSON.stringify(browserReceipt, null, 2)}\n`
  };
  for (const [relativePath, content] of Object.entries(files)) {
    await writeFile(join(bundlePath, relativePath), content, "utf8");
  }

  const validation = await validateAssistantRunBundle(bundlePath);
  if (!validation.valid) {
    const codes = validation.issues.map((item) => `${item.code}${item.path ? `:${item.path}` : ""}`).join(", ");
    throw new Error(`Generated Phase 0 bundle failed validation: ${codes}`);
  }
  return { bundlePath, validation, browserReceipt, evidence };
}
