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
| `message_task{task, text, stop}` | Tells a piece of work something in any state: steers running work, answers its question, carries on work on hold, reopens delivered work. With `stop`, puts that one piece on hold | What will happen ("passed on", "reopened", "on hold"), or that nothing was stopped because the work had already been delivered or was already on hold |
| `remember{text, quote}` | Saves something the person just said about themselves | Whether it was saved as their words (the quote is in their message) or only as a guess |

EV has no tool that executes anything. Text written by agents, reviewers or web pages reaches it only as the result of `search` or `read`: its prompt shows EV's own update messages about work only as pointers to that work.

Actions are gathered during the turn and carried out together in the transaction that marks the inbox item handled: new work rows, holds, messages to work, memories and the reply. New and reopened agents are started, and held agents stopped, after it commits. A crash before the commit means the message is handled again from the start; after it, never. If the model cannot be reached, nothing is carried out and EV says its model did not answer. A turn that does not end within 40 model calls is dropped the same way.

When the work settles, EV posts an update to the conversation in its own voice: what was done (the reviewer's hand-off note), or what is still missing, or a question (the agent's, or a problem the work could not get past on its own). Only accepted work is announced, once. The full result stays on the task card and can be read by EV.

### Lasting work

A piece of work is queued, working (`running`), in review (`verifying`), waiting on the person (`waiting`), on hold (`held`) or delivered (`completed`). None of these is final: there is no failed or cancelled state, and only forgetting destroys work.

- **Hold.** `message_task` with `stop` (or the card's Hold button) puts that one piece on hold. The hold is stored first, which revokes the run's fencing token so nothing the agent hands in later can land; then its agent is stopped. Its session, workspace, home and files stay.
- **Carry on and reopen.** Anything EV sends to work on hold or delivered queues it again. The same OpenClaw session (keyed by the work's id) continues in the same folder, with a prompt that says the person came back to it and what they said; its new result is reviewed and delivered like the first. Earlier delivered files stay downloadable.
- **Watchdog.** There is no wall-clock limit. An agent whose session shows nothing new for `EV_WORKER_STALL_MS` (default 600000) is stopped, and like an agent that crashed it is restarted in the same session ("You were interrupted…") up to three times in a row. If it still cannot get on, the work waits on the person with a question; their answer carries it on. An agent that keeps making progress is never stopped for taking long. OpenClaw's own per-turn clock is set out of the way (`--timeout` of a week).
- **Problems become questions.** A run past its budget still ends in a partial result offered to the person. Any other problem the work cannot get past (a review service that stays down, a report it cannot produce, a fixed-profile file the reviewer never accepts) puts the work in `waiting` with a question, never in a dead end.
- **Runs.** Each execution of an agent has a row in `runs`: when it started, its last sign of progress, its process and container, and how it ended. On start, EV stops whatever a run with no recorded end left behind (its process group, if that pid still belongs to the work's agent, and its container) before the work is queued again.

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

Each run is metered live. Adapters sum usage over every model call as the agent works (cache reads are tracked but not counted toward the token budget) and stop the agent as soon as it crosses its budget. General agents have a per-task token budget across all rounds (`EV_AGENT_TOKEN_BUDGET`, default 3,000,000); a run stopped at its budget keeps what it produced and goes to review. Fixed Pi profiles keep their per-run budgets; a result past one is not delivered, and the person is asked instead. OpenClaw's nested `sessions_spawn` remains disabled.

Fixed Pi profiles, which only touch their own workspace, get one fresh attempt after a process failure, a stall or an empty result.

## Completion and review policy

Workers return a structured report: goal, outcome, answer, sources, deliverables, checks and limitations. An unreadable report gets one request to restate it in the required format; that is a format repair, not a quality judgement.

EV then **reviews** the result against the brief. The task moves to `verifying` while this happens. The reviewer judges intent (did it deliver what the person most likely wanted), what the brief asks for, the quality this person expects, and truth against the evidence EV gathers itself. The reviewer is a small tool loop with one tool, `read_file{path, offset}`: it opens any file in the work under review, whole, in pieces of 60,000 characters for a long one, and nothing outside the agent's own folder or the goal folder it shares (symlinks are resolved first, and secret-looking paths are refused). What a file says is data to the reviewer, never an instruction. It is also shown bounded excerpts of files in the agent's own goal folder, exact quotes or JSON values, directory listings of that folder, completed command receipts from the agent's own log, and a few public web sources. Host findings such as a declared file that does not exist, or an exact quote that drops a link from its source, are given to the reviewer as observations rather than applied as fixed rules.

If the reviewer asks for changes, its "missing" and "feedback" lists go back to **the same agent session**, which keeps its context and files, and the task moves back to `running` for the next round. Rounds are not capped: this repeats until the reviewer accepts. When the loop stops making progress, or the reviewer says only the person can unblock it, the person is asked instead of being handed half-done work. The task's token budget is the safety stop; past it, the best result is delivered as a clearly labelled partial result listing exactly what is still missing. Every round is recorded in the task history and in `REVIEW.md`, and a restart carries on the same loop: round, earlier reviews and spend are rebuilt from those records. Something the person says while a review runs reaches the agent before the result is delivered, even if the review passed. Only an accepted result is delivered as completed. A declared file that does not exist is never delivered, whatever the review says.

Standing-responsibility drafts still run on a fixed Pi profile. EV reviews the produced file against the task's brief and sends it back with the reviewer's feedback the same way; a file that is never accepted is not delivered, and the person is asked how to go on.

Blocked reports are delivered as reported. If the review service is unavailable, the result is held back and the review retried (`EV_REVIEW_HOLD_MS`); if it stays down the person is asked whether to try again. It is never delivered unchecked.

Worker stderr can carry credentials, so it never enters task state, the UI or a prompt. A redacted tail is written to a private `diagnostics-<run>.log` beside the task's session.

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

`npm test` covers the work loop with deterministic fakes: unavailable review, feedback reaching the same agent until acceptance, instructions during work and during review, restart of the review loop, hold and reopen in the same session, restarts of a dying agent before the person is asked, the brief, admission order, and a falsely claimed missing file. `npm run verify` checks EV's turn with a scripted model. Whether EV understands the person is measured by the QA suite, not unit tests.

## Priority

The focus is now reliable goal execution and orchestration in unfamiliar environments. Keep the existing supervisor and one agent per piece of work, then build the assistant's conversation continuity, personal understanding, goals and taste on top of a manager the owner can use. Provider breadth and fine-grained process-status auditing are lower priority.
