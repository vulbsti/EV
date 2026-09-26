# EV manager + OpenClaw proof of concept

## Execution flow

A user message creates one durable parent task. GPT-6-Luna turns the request and EV's explicit guidance into a goal and observable success criteria. Ordinary requests use one executor. When assignments are independent, the manager starts two or three OpenClaw child tasks, each with a separate workspace and provider session. It waits for the results, then runs a parent executor to combine them and check the combined outcome. Dependent edits stay with one executor; this is deliberately not a general task DAG framework.

The supervisor is the owner of task state, leases, cancellation and restart recovery. The manager persists its plan in the existing task event history and reuses it on restart. Deterministic child IDs let it retain completed children instead of duplicating work. A child that failed is retried once only if the plan marks its assignment safe to repeat. Failed children and retries are visible under their parent in the same conversation. The parent can preserve successful work and disclose an incomplete contribution.

At most three supervised executor processes run at once, across all requests. Parents waiting for children do not occupy an execution slot. OpenClaw's nested `sessions_spawn` is disabled because those sessions would bypass EV's durable child state and cancellation. File, shell, browser and other ordinary execution tools remain OpenClaw's responsibility. No provider catalog or additional model integration was introduced.

## Completion and review policy

Workers return a structured report: goal, outcome, answer, sources, deliverables, checks and limitations. The outcome is completed, partial or blocked. An execution crash or a report that remains unusable after one format correction is a task failure; an honest blocker or useful incomplete result remains visible.

EV checks declared files. Files inside the task workspace are checked for file type, size and content hash, copied into the supervisor artifact store, and served through receipt-bound downloads. A declared changed file outside that workspace receives an existence check rather than a downloadable copy. These checks establish file presence and integrity, not the quality of the file.

For a useful root result, a separate Luna call checks the requested outcome and material errors against selected evidence. EV reads bounded local file excerpts, exact quotes or JSON values, directory state, completed command receipts, and a few public web sources. A review pass is limited evidence, not authoritative truth. Children are checked for usable reports and files; they are reviewed together in the parent outcome.

Only a material gap triggers one correction: a wrong requested identity/task, a missing central outcome presented as completed, or a central claim contradicted by an observed source. Minor wording and peripheral process details with no practical impact are ignored. User-relevant source and corroboration limits are caveats. If a material gap remains after that correction, EV returns the useful report as a clearly labelled partial result with unresolved issues. A review service failure also becomes a visible caveat, rather than discarding completed work. Blocked reports are preserved without forcing a citation to information the worker could not obtain.

## Context and authority

EV selects up to eight active, explicit global guidance claims from its revisioned memory store and records their exact revisions in a context manifest. It writes the request, time and guidance to CONTEXT.md. The worker uses that context and direct inspection; automatic taste learning and a personal understanding model are not implemented.

OpenClaw uses `opencode-go/gpt-6-luna` at `https://opencode.ai/zen/go/v1`, with `OPENCODE_API` from the repo-local .env. Keys pass through the child environment, not task configuration. Every task receives a separate provider session header and workspace.

A task workspace is a directory, not an OS sandbox. The worker acts with the daemon user's host permissions and the authority in the user's request. Source review is bounded, web fetching covers a small allowlist, and token/cost accounting is not a hard task budget. The current fan-out is one level of independent assignments; dynamic delegation, dependency graphs, external-action reconciliation and a personal assistant conversation policy remain beyond this proof of concept.

## Run and verify

```bash
npm run prototype
npm test
npm run assistant:manager-check -- --interrupt-child
```

Open http://127.0.0.1:4317. The last command submits three real requests through EV: fix an unfamiliar Python fixture, implement two CSV reporters in parallel and combine their outputs, and research the public @tibo timeline. It interrupts only its own retry-safe acceptance child. It records requests, task histories, results and an independent local test rerun under ignored data/manager-check/.

The deterministic manager tests cover parallel overlap and capacity, one child failure/retry, minor and unavailable review, material partial delivery, parent cancellation including workers waiting for capacity, restart with a completed child, and a falsely claimed missing file. These are manager contract checks; live results and manual use establish the broader product evidence.

## Priority

The focus is now reliable goal execution and orchestration in unfamiliar environments. Keep the existing supervisor and simple parent/child flow, then build the assistant's conversation continuity, personal understanding, goals and taste on top of a manager the owner can use. Provider breadth, fine-grained process-status auditing, and the older terminal/workstation subsystems are lower priority.
