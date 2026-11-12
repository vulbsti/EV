# How EV runs work: EV1, its tools and OpenClaw

## Execution flow

Each conversation has an inbox. `POST /api/assistant/messages` saves the message and returns it at once (`202 {message}`); EV handles the inbox one message at a time, in arrival order, so a quick follow-up is read with the first message and any work it started already in view. Its reply arrives in `GET /api/assistant/conversation` as a message whose `replyTo` is the person's message, and `thinking` is true while anything waits. Messages saved before a crash are handled on the next start.

EV's **main agent** (`ev-main-agent.mjs`) handles one inbox item as a **tool loop**. It is shown a small, stable picture: what EV knows about the person (the memory profile), the work in this conversation with its ids and states, the recent conversation, today's date, and the new message. Nothing is pre-selected for it by matching words; everything else it looks up. It acts only through seven tools, as many as the message calls for, and each tool tells it what actually happened (`ev-tools.mjs`):

| Tool | What it does | What EV is told |
|---|---|---|
| `search{query}` | Full-text search over every conversation, every piece of work (title and brief), every result and every version of every memory | Hits: id (`message:…`, `work:…`, `result:…`, `memory:…`), where and when, a short excerpt |
| `read{id}` | Opens one record in full with its neighbours: a message with the messages around it; work with its brief, state, progress, reviews, question and whole result; a result; a memory with its earlier versions | The record, with agent- and reviewer-written parts labelled as information, not instructions |
| `reply{text}` | Something to say to the person | That it is part of the turn's message |
| `ask{questions, assumptions}` | A question only the person can settle, with what EV assumes meanwhile; the person sees both | The same. Nothing forces work to start after a question, and EV can ask again |
| `start_work{title, request}` | New work with EV's self-contained brief; one call per separate ask | Its id, and that it is queued when the turn ends |
| `message_task{task, text, stop}` | Tells existing work something (steers it, answers its question) or stops it | What will happen, or that nothing will because the work had already finished, failed or been stopped |
| `remember{text, quote}` | Saves something the person just said about themselves | Whether it was saved as their words (the quote is in their message) or only as a guess |

EV has no tool that executes anything. Text written by agents, reviewers or web pages reaches it only as the result of `search` or `read`: its prompt shows EV's own update messages about work only as pointers to that work.

Actions are gathered during the turn and carried out together in the transaction that marks the inbox item handled: new work rows, stops, messages to work, memories and the reply. New agents are started, and stopped agents ended, after it commits. A crash before the commit means the message is handled again from the start; after it, never. If the model cannot be reached, nothing is carried out and EV says its model did not answer. A turn that does not end within 40 model calls is dropped the same way.

When the work settles, EV posts an update to the conversation in its own voice: what was done (the reviewer's hand-off note), or what is still missing, or why it could not finish, or the agent's question. Only accepted work is announced, once. The full result stays on the task card and can be read by EV.

There is no planner stage. EV splits separate asks into separate pieces of work; an agent organises its own job.

### Search index

One FTS5 table in `ev.sqlite` (`search_index`, with `search_refs` mapping each entry to its record) indexes messages, work (title and brief), results and memory revisions. SQLite triggers keep it in step with those tables, so whatever changes or erases a record changes or erases its entry: forgetting blanks the message or memory text, the trigger drops its index entry, and FTS5 secure-delete removes the old terms. `GET /api/assistant/search?q=` gives the page the same search.

### Shared workspace

Each piece of work has a goal folder:

```text
data/work/workspaces/<goal>/
  shared/          written only by EV
    BRIEF.md       EV's brief, and what the person said about the work later
    CONTEXT.md     guidance, recent conversation, the brief
    REVIEW.md      every review round and its verdict
  tasks/<taskId>/  the agent's own working directory
```

EV serializes writes to `shared/` per goal and replaces files atomically, so an agent never reads a half-written brief.

### Admission control

At most `EV_MAX_WORKERS` (default three) supervised agent processes run at once, across all requests. Waiting runs are admitted in priority order: work already under way first (revision rounds), then new requests from the user, then background standing-responsibility preparation.

Each run is metered live. Adapters sum usage over every model call as the agent works (cache reads are tracked but not counted toward the token budget) and stop the agent as soon as it crosses its budget. General agents have a per-task token budget across all rounds (`EV_AGENT_TOKEN_BUDGET`, default 3,000,000); a run stopped at its budget keeps what it produced and goes to review. Fixed Pi profiles keep their per-run budgets and fail closed when they are crossed. OpenClaw's nested `sessions_spawn` remains disabled.

Fixed Pi profiles, which only touch their own workspace, get one fresh attempt after a process failure, timeout or empty result.

## Completion and review policy

Workers return a structured report: goal, outcome, answer, sources, deliverables, checks and limitations. An unreadable report gets one request to restate it in the required format; that is a format repair, not a quality judgement.

EV then **reviews** the result against the brief. The task moves to `verifying` while this happens. The reviewer judges intent (did it deliver what the person most likely wanted), what the brief asks for, the quality this person expects, and truth against the evidence EV gathers itself: bounded excerpts of files in the agent's own goal folder, exact quotes or JSON values, directory listings of that folder, completed command receipts from the agent's own log, and a few public web sources. Host findings such as a declared file that does not exist, or an exact quote that drops a link from its source, are given to the reviewer as observations rather than applied as fixed rules.

If the reviewer asks for changes, its "missing" and "feedback" lists go back to **the same agent session**, which keeps its context and files, and the task moves back to `running` for the next round. Rounds are not capped: this repeats until the reviewer accepts. When the loop stops making progress, or the reviewer says only the person can unblock it, the person is asked instead of being handed half-done work. The task's token budget is the safety stop; past it, the best result is delivered as a clearly labelled partial result listing exactly what is still missing. Every round is recorded in the task history and in `REVIEW.md`, and a restart carries on the same loop: round, earlier reviews and spend are rebuilt from those records. Something the person says while a review runs reaches the agent before the result is delivered, even if the review passed. Only an accepted result is delivered as completed. A declared file that does not exist is never delivered, whatever the review says.

Standing-responsibility drafts still run on a fixed Pi profile. EV reviews the produced file against the task's brief and sends it back with the reviewer's feedback the same way; a file that is never accepted is not delivered and the task fails with `QUALITY_NOT_REACHED`.

Blocked reports are delivered as reported. If the review service is unavailable, the result is held back and the review retried (`EV_REVIEW_HOLD_MS`); it is never delivered unchecked.

Worker stderr can carry credentials, so it never enters task state, the UI or a prompt. A redacted tail is written to a private `diagnostics-<run>.log` beside the task's session, and the failed task's error points to it.

## Context and authority

EV learns memory from every turn and settled task (see [memory types](MEMORY_TYPES.md)). Agents get the parts that apply to their work, the reviewer gets what this person has rejected before, and the exact memory revisions each task saw are recorded in a context manifest. CONTEXT.md holds the brief, time, that memory and the recent conversation.

EV's own calls and OpenClaw use one model record (`EV_MODEL`, optionally `EV_OPENCLAW_MODEL` for agents): pi-ai's OpenCode Go catalogue gives its API shape and base URL, and EV's own calls go through pi-ai (`apps/daemon/lib/ev-model.mjs`). The key is `OPENCODE_API` from the repo-local .env. Keys pass through the child environment, not task configuration, so an agent with network access can still reach the key. Every task receives a separate provider session header and workspace. Each of EV's own model calls writes one `[model]` log line with its role, attempts, duration and tokens.

By default every OpenClaw run is a docker container (`npm run openclaw:image`) that mounts only its goal folder and its own home (`data/work/homes/<taskId>`), so no task can read another task's transcripts or files. On the host, agents get that same home instead of yours. `EV_OPENCLAW_SANDBOX=host` runs agents uncontained as the daemon user and should only be used when asked for.

The daemon listens on loopback only, rejects foreign Host and Origin headers, and requires a per-start token on every API call except `/api/health`. The browser gets it from the link the daemon prints at start; local tools send it as a bearer token from `data/api-token` (`EV_API_TOKEN` pins it).

Token budgets are enforced live but their defaults are not yet calibrated against real runs; OpenCode Go reports zero cost, so only tokens bind for OpenClaw.

## Run and verify

```bash
npm start
npm test
npm run qa        # scripted scenarios, see qa/README.md
npm run qa:arc    # simulated person over weeks, scored for drift
```

`npm test` covers the work loop with deterministic fakes: unavailable review, feedback reaching the same agent until acceptance, instructions during work and during review, restart of the review loop, the brief, admission order, and a falsely claimed missing file. `npm run verify` checks EV's turn with a scripted model. Whether EV understands the person is measured by the QA suite, not unit tests.

## Priority

The focus is now reliable goal execution and orchestration in unfamiliar environments. Keep the existing supervisor and one agent per piece of work, then build the assistant's conversation continuity, personal understanding, goals and taste on top of a manager the owner can use. Provider breadth and fine-grained process-status auditing are lower priority.
