# How EV runs work: EV1, the manager and OpenClaw

## Execution flow

Every user message goes to EV's **main agent** first (`ev-main-agent.mjs`, GPT-6-Luna). It reads the message with EV's reviewed guidance about the person, the recent conversation (including EV's own updates), and the work running or recently finished in this conversation, and decompresses it into what the person means. It then picks one action:

- **reply**: conversation that needs no work (a greeting, thanks, a question about EV or about results already shown). EV answers itself and no agent runs.
- **clarify**: something only the person can settle would change the outcome substantially. EV asks at most two short questions and waits. It asks one round at most: the next message is combined with the original ask, and anything still open becomes a stated assumption.
- **work**: EV settles its understanding (a self-contained request with references resolved, intent, the goal it serves, success criteria, the quality bar this person expects, assumptions and unknowns) and starts one durable parent task with it.

The planner then only decides how agents carry the work out (one executor or 2-3 parallel assignments, and how many review rounds it deserves); it cannot redefine the understanding. The resulting **brief** keeps the person's own words, EV's reading of them, and the plan. It is stored in the task history and written to the goal's shared `BRIEF.md`. If the main agent is unavailable, nothing is started: EV says its model did not answer, because work started without understanding the message is the half-baked work EV exists to avoid.

Each conversation has an inbox. `POST /api/assistant/messages` saves the message and returns it at once (`202 {message}`); EV handles the inbox one message at a time, in arrival order, so a quick follow-up is read with the first message and any work it started already in view. Its reply arrives in `GET /api/assistant/conversation` as a message whose `replyTo` is the person's message, and `thinking` is true while anything waits. Messages saved before a crash are handled on the next start.

When the work settles, EV posts an update to the conversation in its own voice: what was done (the reviewer's hand-off note), or what is still missing, or why it could not finish. The full result stays on the task card.

Ordinary requests use one executor. When assignments are independent, the manager starts two or three OpenClaw child tasks. It waits for the results, then runs the lead agent to combine them. Dependent edits stay with one executor; this is deliberately not a general task DAG framework.

### Shared workspace

Every agent on one goal works under one directory:

```text
data/work/workspaces/<goal>/
  shared/          written only by EV
    BRIEF.md       the mediator's brief
    CONTEXT.md     guidance, recent conversation, the request
    TEAM.md        every agent on the goal: assignment, status, directory, result
    REVIEW.md      every review round and its verdict
  tasks/<taskId>/  one agent's own working directory
```

Agents are told to read the shared files first, may read a teammate's directory, and write only in their own. EV serializes writes to `shared/` per goal and replaces files atomically, so an agent never reads a half-written brief. `TEAM.md` is regenerated from supervisor state whenever an agent is added or finishes.

### Admission control

At most `EV_MAX_WORKERS` (default three) supervised agent processes run at once, across all requests. Parents waiting for children do not hold a slot. Waiting runs are admitted in priority order: work already under way first (child agents and revision rounds), then new requests from the user, then background standing-responsibility preparation.

Each run is metered live. Adapters sum usage over every model call as the agent works (cache reads are tracked but not counted toward the token budget) and stop the agent as soon as it crosses its budget. General agents have a per-task token budget across all rounds (`EV_AGENT_TOKEN_BUDGET`, default 3,000,000); a run stopped at its budget keeps what it produced and goes to review. Fixed Pi profiles keep their per-run budgets and fail closed when they are crossed. OpenClaw's nested `sessions_spawn` remains disabled.

The manager persists its plan in the task event history and reuses it on restart. Deterministic child IDs let it retain completed children instead of duplicating work. A child that failed is retried once only if the plan marks its assignment safe to repeat. Fixed Pi profiles, which only touch their own workspace, get one fresh attempt after a process failure, timeout or empty result.

## Completion and review policy

Workers return a structured report: goal, outcome, answer, sources, deliverables, checks and limitations. An unreadable report gets one request to restate it in the required format; that is a format repair, not a quality judgement.

EV then **reviews** the result against the brief. The task moves to `verifying` while this happens. The reviewer judges intent (did it deliver what the person most likely wanted), each success criterion (met, partial or missing), the quality bar this person expects, and truth against the evidence EV gathers itself: bounded excerpts of files in the agent's own goal folder, exact quotes or JSON values, directory listings of that folder, completed command receipts from the agent's own log, and a few public web sources. Host findings such as a declared file that does not exist, or an exact quote that drops a link from its source, are given to the reviewer as observations rather than applied as fixed rules.

If the reviewer asks for changes, its "missing" and "feedback" lists go back to **the same agent session**, which keeps its context and files, and the task moves back to `running` for the next round. Rounds are not capped: this repeats until the reviewer accepts. When the loop stops making progress, or the reviewer says only the person can unblock it, EV asks the person (or answers from what it knows about them) instead of delivering half-done work. The task's token budget is the safety stop; past it, the best result is delivered as a clearly labelled partial result listing exactly what is still missing. Every round is recorded in the task history and in `REVIEW.md`, and a restart carries on the same loop: round, earlier reviews and spend are rebuilt from those records. Something the person says while a review runs reaches the agent before the result is delivered, even if the review passed. Only an accepted result is delivered as completed. A declared file that does not exist is never delivered, whatever the review says.

Standing-responsibility drafts still run on a fixed Pi profile. EV reviews the produced file against the task's brief and sends it back with the reviewer's feedback the same way; a file that is never accepted is not delivered and the task fails with `QUALITY_NOT_REACHED`.

Child agents are not reviewed one by one; their work is reviewed together as the lead agent's combined result. Blocked reports are delivered as reported. If the review service is unavailable, the result is held back and the review retried (`EV_REVIEW_HOLD_MS`); it is never delivered unchecked.

Worker stderr can carry credentials, so it never enters task state, the UI or a prompt. A redacted tail is written to a private `diagnostics-<run>.log` beside the task's session, and the failed task's error points to it.

## Context and authority

EV learns memory from every turn and settled task (see [memory types](MEMORY_TYPES.md)). Agents get the parts that apply to their work, the reviewer gets what this person has rejected before, and the exact memory revisions each task saw are recorded in a context manifest. CONTEXT.md holds the request, time, that memory and the recent conversation.

EV's own calls and OpenClaw use one model record (`EV_MODEL`, optionally `EV_OPENCLAW_MODEL` for agents): pi-ai's OpenCode Go catalogue gives its API shape and base URL, and EV's own calls go through pi-ai (`apps/daemon/lib/ev-model.mjs`). The key is `OPENCODE_API` from the repo-local .env. Keys pass through the child environment, not task configuration, so an agent with network access can still reach the key. Every task receives a separate provider session header and workspace. Each of EV's own model calls writes one `[model]` log line with its role, attempts, duration and tokens.

By default every OpenClaw run is a docker container (`npm run openclaw:image`) that mounts only its goal folder and its own home (`data/work/homes/<taskId>`), so no task can read another task's transcripts or files. On the host, agents get that same home instead of yours. `EV_OPENCLAW_SANDBOX=host` runs agents uncontained as the daemon user and should only be used when asked for.

The daemon listens on loopback only, rejects foreign Host and Origin headers, and requires a per-start token on every API call except `/api/health`. The browser gets it from the link the daemon prints at start; local tools send it as a bearer token from `data/api-token` (`EV_API_TOKEN` pins it).

Token budgets are enforced live but their defaults are not yet calibrated against real runs; OpenCode Go reports zero cost, so only tokens bind for OpenClaw. The current fan-out is one level of independent assignments.

## Run and verify

```bash
npm start
npm test
npm run qa        # scripted scenarios, see qa/README.md
npm run qa:arc    # simulated person over weeks, scored for drift
```

`npm test` covers the manager contract with deterministic fakes: parallel overlap and capacity, child retry, unavailable review, feedback reaching the same agent until acceptance, instructions during work and during review, restart of the review loop, the shared goal layout, admission order, cancellation, and a falsely claimed missing file. Whether EV understands the person is measured by the QA suite, not unit tests.

## Priority

The focus is now reliable goal execution and orchestration in unfamiliar environments. Keep the existing supervisor and simple parent/child flow, then build the assistant's conversation continuity, personal understanding, goals and taste on top of a manager the owner can use. Provider breadth and fine-grained process-status auditing are lower priority.
