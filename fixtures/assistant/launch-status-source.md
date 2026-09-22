# EV launch-status source fixture

## Product direction

EV is becoming one persistent personal assistant with a conversation-first interface. It should reduce the amount of task management the user performs, preserve truthful state across restarts, and use supervised background workers for bounded work.

## Completed foundation

- Durable SQLite conversation and task-intake ledger.
- Idempotent browser retry and incremental reconnect.
- Honest `not_executable` state when no worker capability exists.
- Five successful restart/reload recovery canaries.
- The terminal workstation remains available only as a developer view.

## Current Phase 2 result

One supervised Pi worker can prepare a local launch-status brief from this selected fixture. The worker receives an explicit reviewed extension and skill with workspace-scoped read, write, list, grep, and network-disabled allowlisted command tools. It cannot access arbitrary host paths or a general host shell. EV owns the workspace, verifies the artifact hash and required sections, and records completion.

The conversation shows authoritative queued, working, completed, failed, and cancelled task cards. Cancellation is persisted before the process is stopped. Verified artifacts download through receipt-bound IDs. A graceful daemon restart fences the old run, records an interrupted event, and starts exactly one replacement run. Four of five product journeys completed with verified artifacts; the fifth was intentionally cancelled and produced no artifact.

## Current Phase 3 scope

EV now has an initial SQLite memory boundary for explicit and proposed guidance, immutable revisions, evidence links, scope filtering, stop-use, erase, temporary expiry, and exact context manifests. The `Understanding you` panel lets the user add, inspect, correct, stop using, and erase guidance. Active global guidance is included in a task context package but cannot grant tools or authority.

## Explicit exclusions

- No connected accounts or external write actions.
- No silent promotion of inferred preferences; inferred claims remain candidates until reviewed.
- No general browser, desktop, terminal, credential, or host access for the worker.
- No claim of completion until the artifact passes objective checks.

## Launch concerns

- Phase 3 correction and stop-use passed computer-use verification; erase and project-scope journeys still need the same treatment.
- One matched comparison improved a 685-word transcript-only brief to 247 words with an explicit under-250-word guidance claim and exact context manifest.
- Narrow/mobile layout still needs visual verification on a resizable browser surface.
