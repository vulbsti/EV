# EV launch-status source fixture

## Product direction

EV is becoming one persistent personal assistant with a conversation-first interface. It should reduce the amount of task management the user performs, preserve truthful state across restarts, and use supervised background workers for bounded work.

## Completed foundation

- Durable SQLite conversation and task-intake ledger.
- Idempotent browser retry and incremental reconnect.
- Honest `not_executable` state when no worker capability exists.
- Five successful restart/reload recovery canaries.
- The terminal workstation remains available only as a developer view.

## Current Phase 2 scope

Add one supervised Pi worker that can prepare a local launch-status brief from this selected fixture. The worker receives no shell or filesystem tools. EV owns the workspace, writes the returned text, verifies the artifact hash and required sections, and records completion.

## Explicit exclusions

- No connected accounts or external write actions.
- No personal memory or inferred preferences.
- No general browser, desktop, terminal, or host access for the worker.
- No claim of completion until the artifact passes objective checks.

## Launch concerns

- Worker lifecycle is not yet visible in the main conversation UI.
- Cancellation and daemon-restart recovery need end-to-end browser verification.
- Narrow/mobile layout still needs visual verification on a resizable browser surface.
