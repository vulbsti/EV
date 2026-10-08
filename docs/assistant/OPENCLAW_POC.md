# EV manager + OpenClaw proof of concept

## Execution flow

Every user message goes to EV's **main agent** first (`ev-main-agent.mjs`, GPT-6-Luna). It reads the message with EV's reviewed guidance about the person, the recent conversation (including EV's own updates), and the work running or recently finished in this conversation, and decompresses it into what the person means. It then picks one action:

- **reply**: conversation that needs no work (a greeting, thanks, a question about EV or about results already shown). EV answers itself and no agent runs.
- **clarify**: something only the person can settle would change the outcome substantially. EV asks at most two short questions and waits. It asks one round at most: the next message is combined with the original ask, and anything still open becomes a stated assumption.
- **work**: EV settles its understanding (a self-contained request with references resolved, intent, the goal it serves, success criteria, the quality bar this person expects, assumptions and unknowns) and starts one durable parent task with it.

The planner then only decides how agents carry the work out (one executor or 2-3 parallel assignments, and how many review rounds it deserves); it cannot redefine the understanding. The resulting **brief** keeps the person's own words, EV's reading of them, and the plan. It is stored in the task history and written to the goal's shared `BRIEF.md`. If the main agent is unavailable, the message goes straight to the planner, which writes the whole brief as before.

When the work settles, EV posts an update to the conversation in its own voice: what was done (the reviewer's hand-off note), or what is still missing, or why it could not finish. The full result stays on the task card.

Ordinary requests use one executor. When assignments are independent, the manager starts two or three OpenClaw child tasks. It waits for the results, then runs the lead agent to combine them. Dependent edits stay with one executor; this is deliberately not a general task DAG framework.

### Shared workspace

Every agent on one goal works under one directory:

```text
data/assistant-worker/workspaces/<goal>/
  shared/          written only by EV
    BRIEF.md       the mediator's brief
    CONTEXT.md     guidance, recent conversation, the request
    TEAM.md        every agent on the goal: assignment, status, directory, result
    REVIEW.md      every review round and its verdict
  tasks/<taskId>/  one agent's own working directory
```

Agents are told to read the shared files first, may read a teammate's directory, and write only in their own. EV serializes writes to `shared/` per goal and replaces files atomically, so an agent never reads a half-written brief. `TEAM.md` is regenerated from supervisor state whenever an agent is added or finishes. Tasks created before this layout keep their old one-directory-per-task workspace.

### Admission control

At most `EV_MAX_WORKERS` (default three) supervised agent processes run at once, across all requests. Parents waiting for children do not hold a slot. Waiting runs are admitted in priority order: work already under way first (child agents and revision rounds), then new requests from the user, then background standing-responsibility preparation.

Each run is metered live. Adapters sum usage over every model call as the agent works (cache reads are tracked but not counted toward the token budget) and stop the agent as soon as it crosses its budget. General agents have a per-task token budget across all rounds (`EV_AGENT_TOKEN_BUDGET`, default 3,000,000); a run stopped at its budget keeps what it produced and goes to review. Fixed Pi profiles keep their per-run budgets and fail closed when they are crossed. OpenClaw's nested `sessions_spawn` remains disabled.

The manager persists its plan in the task event history and reuses it on restart. Deterministic child IDs let it retain completed children instead of duplicating work. A child that failed is retried once only if the plan marks its assignment safe to repeat. Fixed Pi profiles, which only touch their own workspace, get one fresh attempt after a process failure, timeout or empty result.

## Completion and review policy

Workers return a structured report: goal, outcome, answer, sources, deliverables, checks and limitations. An unreadable report gets one request to restate it in the required format; that is a format repair, not a quality judgement.

EV then **reviews** the result against the brief. The task moves to `verifying` while this happens. The reviewer judges intent (did it deliver what the person most likely wanted), each success criterion (met, partial or missing), the quality bar this person expects, and truth against the evidence EV gathers itself: bounded local file excerpts, exact quotes or JSON values, directory and Git state, completed command receipts from the agent's own log, and a few public web sources. Host findings such as a declared file that does not exist, or an exact quote that drops a link from its source, are given to the reviewer as observations rather than applied as fixed rules.

If the reviewer asks for changes, its "missing" and "feedback" lists go back to **the same agent session**, which keeps its context and files, and the task moves back to `running` for the next round. This repeats until the reviewer accepts, the brief's review rounds run out (one to five, default three), or the task's budget is spent. Every round is recorded in the task history and in `REVIEW.md`. Only an accepted result is delivered as completed. Otherwise the best result is delivered as a clearly labelled partial result listing exactly what is still missing and why EV stopped. A declared file that does not exist is never delivered, whatever the review says.

Fixed Pi profiles (the launch brief, standing-responsibility drafts and the R1 content package) no longer check headings or tool receipts. EV reviews the produced file against the task's brief and sends it back with the reviewer's feedback the same way; a file that is never accepted is not delivered and the task fails with `QUALITY_NOT_REACHED`.

Child agents are not reviewed one by one; their work is reviewed together as the lead agent's combined result. Blocked reports are delivered as reported. If the review service is unavailable, the result is shown with a visible "not reviewed" caveat rather than discarded.

Worker stderr can carry credentials, so it never enters task state, the UI or a prompt. A redacted tail is written to a private `diagnostics-<run>.log` beside the task's session, and the failed task's error points to it.

## Context and authority

EV selects up to eight active, explicit global guidance claims from its revisioned memory store and records their exact revisions in a context manifest. It writes the request, time and guidance to CONTEXT.md. The worker uses that context and direct inspection; automatic taste learning and a personal understanding model are not implemented.

OpenClaw uses `opencode-go/gpt-6-luna` at `https://opencode.ai/zen/go/v1`, with `OPENCODE_API` from the repo-local .env. Keys pass through the child environment, not task configuration. Every task receives a separate provider session header and workspace.

A task workspace is a directory, not an OS sandbox. The worker acts with the daemon user's host permissions and the authority in the user's request. Source review is bounded and web fetching covers a small allowlist. Token budgets are enforced live but their defaults are not yet calibrated against real runs; OpenCode Go reports zero cost, so only tokens bind for OpenClaw. The current fan-out is one level of independent assignments; dynamic delegation, dependency graphs, external-action reconciliation and a personal assistant conversation policy remain beyond this proof of concept.

## Run and verify

```bash
npm run prototype
npm test
npm run assistant:manager-check -- --interrupt-child
```

Open http://127.0.0.1:4317. The last command submits three real requests through EV: fix an unfamiliar Python fixture, implement two CSV reporters in parallel and combine their outputs, and research the public @tibo timeline. It interrupts only its own retry-safe acceptance child. It records requests, task histories, results and an independent local test rerun under ignored data/manager-check/.

The deterministic manager tests cover parallel overlap and capacity, one child failure/retry, minor and unavailable review, feedback reaching the same agent until acceptance, partial delivery when review rounds run out, the shared goal layout, admission order, parent cancellation including workers waiting for capacity, restart with a completed child, and a falsely claimed missing file. These are manager contract checks; live results and manual use establish the broader product evidence.

## Priority

The focus is now reliable goal execution and orchestration in unfamiliar environments. Keep the existing supervisor and simple parent/child flow, then build the assistant's conversation continuity, personal understanding, goals and taste on top of a manager the owner can use. Provider breadth, fine-grained process-status auditing, and the older terminal/workstation subsystems are lower priority.
