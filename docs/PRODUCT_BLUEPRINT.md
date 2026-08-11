# EV Mission Control: Product and Implementation Blueprint

Date: 2026-08-11  
Status: architecture and delivery plan; pre-build experiment lab implemented, integrated product not yet started

## 1. What is being built

This is a local-first, browser-based mission control for terminal agents. It has five connected responsibilities:

1. **Fleet awareness:** show every tmux session, window, pane, terminal job, and recognized agent on the machine.
2. **Navigation:** move from a high-level fleet map to a project, task, agent, live terminal, diff, or event timeline without losing context.
3. **Voice companion:** accept natural speech, converse naturally, read results aloud, and translate actionable utterances into explicit task requests.
4. **Orchestration:** plan, delegate, launch, steer, interrupt, verify, and summarize work through a controlled harness.
5. **Durable accountability:** record what was requested, which runtime did it, what changed, what evidence was produced, and why a task is considered complete.

The target is not merely a web terminal multiplexer. It is a control plane where terminals are one runtime surface, tasks are the durable unit of work, and voice is the primary human interface.

### The product contract

- It can observe all existing tmux panes without requiring them to be relaunched.
- Existing, unmanaged panes begin in read-only mode. The user can explicitly adopt one before EV sends input to it.
- New agents are launched through managed adapters with an explicit working directory, task, permissions, and resource budget.
- Voice can request work, inspect work, steer work, and hear results, but the voice model never receives unrestricted shell or tmux access.
- The orchestrator is an agent running in an optimized harness, but task truth lives in the daemon's database and state machine, not only in the orchestrator's conversation context.
- “Running” means a process is active. It does not mean the work is correct. Completion requires evidence and, where appropriate, verification.

### Explicit non-goals for the first release

- Replacing tmux.
- Treating terminal text scraping as perfectly reliable semantic agent state.
- Letting an always-listening browser microphone silently perform high-risk actions.
- Fully autonomous publishing, deployment, merging, purchasing, or destructive actions.
- Supporting every terminal agent with equal semantic depth on day one.
- Storing unlimited raw terminal output, audio, or secrets.

## 2. Current machine baseline

The workspace `/home/vulbsti/proj/ev` is not a Git repository. It now contains this blueprint and a dependency-free experiment lab; the integrated product has not been scaffolded.

At inspection time, the host had:

- tmux 3.4;
- 3 tmux sessions and 16 live panes;
- 13 panes whose current process was `claude`, 2 running `node`, and 1 running `bash`;
- work spread across ordinary repositories and Claude-created git worktrees;
- Codex CLI 0.147.0;
- Node.js 22.22.0 and npm 11.10.1.

The installed Codex app-server schema was generated and inspected locally. It already exposes structured thread, turn, goal, token-usage, command-output, file-change, reasoning-summary, approval, and user-input events. That makes a structured Codex adapter practical on this machine without screen scraping.

This baseline creates an important requirement: EV must reconcile arbitrary existing tmux state first, then offer richer semantics for sessions it launches itself.

## 3. Feasibility and the voice boundary

The complete system is feasible, but the voice provider and the authority boundary are separate decisions. The durable design is a natural voice companion subagent with read-only capabilities, paired with an orchestrator that owns deeper reasoning and every state-changing action.

Test two interchangeable transports before selecting one:

- a chained OpenRouter speech-to-text → companion/orchestrator → text-to-speech path, which offers explicit transcripts and replaceable models; and
- xAI Grok Voice speech-to-speech, which may provide more natural latency and is currently priced for economical experimentation.

OpenAI Realtime remains a compatibility and quality benchmark, not the default test provider. The consumer ChatGPT voice interface itself is not an embeddable proxy API.

Sources: [xAI speech-to-speech](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech), [xAI voice pricing](https://docs.x.ai/developers/pricing#voice-api-pricing), [OpenRouter STT](https://openrouter.ai/docs/guides/overview/multimodal/stt), [OpenRouter TTS](https://openrouter.ai/docs/guides/overview/multimodal/tts), and [OpenAI GPT Realtime](https://developers.openai.com/api/docs/models/gpt-realtime-2.1).

### Recommended provider-neutral split

Use a low-latency voice transport as the conversational shell, but make the durable orchestrator the sole authority for task execution.

```text
Microphone -> OpenRouter STT or Grok Voice -> read-only companion
                                                |
             casual conversation / read query -+
                                                |
             deeper reasoning or action -> immutable delegation envelope
                                                |
                                                v
                                      durable orchestrator
                                      policy + controlled tools
                                      correlated result/event
                                                |
Speaker <- OpenRouter TTS or Grok Voice <--------+
```

The voice companion may chat, search the web, read files, inspect fleet/task state, ask for clarification, and narrate normalized status. It is not issued shell, tmux-input, write, spawn, approval, or destructive capabilities. Denial is enforced by the tool gateway, not left to prompting.

This preserves the conversational feel while keeping the requested “voice → text → orchestrator → action → result → voice” authority boundary.

### Voice modes

Every utterance is classified into one of four modes:

| Mode | Example | Behavior |
| --- | --- | --- |
| Conversation | “I am not sure how to approach this.” | Companion replies; no task is created. |
| Query | “Which agents need me?” | Companion uses read-only state and speaks the answer. |
| Reasoning | “Investigate why those tests keep becoming flaky.” | Delegate transcript and frozen context to the orchestrator. |
| Action | “Have a Codex agent fix the failing API tests.” | Delegate to policy/orchestration and create a durable task. |
| Control | “Stop that agent” or “approve the patch.” | Resolve the referenced target, assess risk, and require confirmation when necessary. |

Default interaction should be push-to-talk or an explicitly opened hands-free session with voice activity detection. A wake word and persistent background listening are later features. Browsers also cannot be relied on to speak unsolicited results after a tab has been closed or fully suspended; use a push notification and speak after the user reopens the app.

## 4. Research and reusable ideas

Several current projects solve meaningful parts of this problem. None combines arbitrary-pane observation, a durable orchestrator, and a voice companion exactly as required.

| Project | Useful ideas | Gap relative to EV |
| --- | --- | --- |
| [Agent of Empires](https://github.com/agent-of-empires/agent-of-empires) | Mature tmux persistence, browser/PWA dashboard, structured Agent Client Protocol views, status detection, diffs, worktrees, sandboxing, and an HTTP API. | Primarily manages its own namespaced sessions rather than presenting every arbitrary pane as a first-class object; no voice-first orchestrator. |
| [NTM](https://github.com/Dicklesworthstone/ntm) | Treats tmux as a control plane and adds REST/WebSocket/OpenAPI surfaces, policies, approvals, checkpoints, timelines, and audit logs. | Large opinionated ecosystem; concepts are more reusable than the whole system for this product. Review its license before any source reuse. |
| [agtx](https://github.com/fynnfluegge/agtx) | Task lifecycle, worktree-per-task isolation, an orchestrator controlling the board via MCP, phase-specific agents, and conflict checks. | TUI-first and its experimental orchestration relies partly on pane/idle signals; not a universal browser fleet view. |
| [xterm.js](https://github.com/xtermjs/xterm.js) | Proven browser terminal renderer that supports tmux and full-screen terminal programs. | Renderer only; it does not provide task or agent semantics. |
| [Codex App Server](https://developers.openai.com/codex/app-server) | Rich-client protocol for threads, turns, streamed items, commands, file changes, goals, usage, user questions, and approvals. | Codex-specific; it needs to sit behind EV's common runtime adapter. |
| [OpenAI Realtime voice](https://developers.openai.com/api/docs/guides/voice-agents) | WebRTC voice, natural turn taking, barge-in, tools, handoffs, and browser SDK helpers. | Voice transport and model, not a durable job orchestrator. |

### Reuse decision

Do not begin by copying an entire orchestrator or terminal dashboard into this repository. Start with a two-day integration spike:

1. run Agent of Empires against representative managed sessions;
2. test whether its HTTP/plugin surfaces can be used as an optional managed-session adapter;
3. validate direct observation and streaming of the existing non-AoE sessions using tmux control mode;
4. compare the cost of extending AoE's core model with the cost of maintaining a thin independent tmux adapter.

The default architectural recommendation is a small independent EV control plane with pluggable adapters. It can integrate with AoE when installed, while direct tmux observation remains the universal baseline. This avoids making EV's core identity depend on one manager's namespacing and lets future adapters cover NTM, remote hosts, containers, or other agent protocols.

Patterns and compatible components should be reused where they save risk, particularly terminal rendering, structured agent protocols, status hooks, worktree handling, and approval UX. Source reuse must follow each project's license.

## 5. User experience and navigation

### Global shell

The browser should have four persistent regions:

```text
+--------------------------------------------------------------------------------+
| EV / host health / search / attention count / global voice orb                 |
+------------------+-------------------------------------------+-----------------+
| Fleet            | Main workspace                            | Companion       |
| Projects         | overview, task graph, agent or terminal   | transcript      |
| Tasks            |                                           | approvals       |
| Sessions         |                                           | spoken results  |
| Timeline         |                                           | current context |
+------------------+-------------------------------------------+-----------------+
| command palette / shortcuts / connection and recording state                   |
+--------------------------------------------------------------------------------+
```

The primary routes are:

- `/overview`: all hosts, projects, sessions, agents, and the attention queue;
- `/project/:id`: project tasks, branches/worktrees, diffs, and related runtimes;
- `/task/:id`: objective, plan, child runs, timeline, artifacts, and completion evidence;
- `/runtime/:id`: structured agent activity when available;
- `/terminal/:paneId`: exact live terminal and safe input controls;
- `/timeline`: chronological and filterable event ledger;
- `/approvals`: pending and historical decisions;
- `/settings`: adapters, permissions, voice, storage, models, and resource limits.

### Overview views

Offer three switchable representations of the same data:

1. **Fleet map:** grouped by project/session, optimized for status and attention.
2. **Terminal wall:** resizable live pane thumbnails; click to focus without attaching a native tmux client.
3. **Task graph:** goal → tasks → runs → agents → artifacts, optimized for causality and progress.

Each agent/runtime card should show:

- provider and model when known;
- task and current step;
- project, cwd, branch/worktree, session/window/pane;
- status, elapsed time, last meaningful event, and last output time;
- progress only when backed by a plan or explicit checkpoints;
- status source and confidence: `structured`, `hook`, `process`, or `heuristic`;
- tokens/cost when the adapter reports them;
- changed files, diff size, validation status, and whether attention is required.

Never display a fabricated percentage derived from terminal activity. Use step counts, explicit agent plans, or qualitative states such as `planning`, `working`, `waiting`, and `verifying`.

### Context-aware voice

Spoken references such as “this pane,” “the stuck one,” or “send that to the backend agent” must be resolved using the UI selection at the instant speech begins. Each utterance carries a context snapshot:

```json
{
  "utteranceId": "utt_...",
  "transcript": "send this to the backend agent",
  "focusedProjectId": "project_...",
  "focusedTaskId": "task_...",
  "focusedRuntimeId": "runtime_...",
  "selectedPaneIds": ["%16"],
  "mode": "action",
  "capturedAt": "..."
}
```

This avoids resolving “this” against a UI selection that changed during transcription.

## 6. System architecture

```text
                       OpenRouter STT/TTS or xAI Grok Voice
                      audio transport, ephemeral auth where supported
                                         ^
                                         |
+---------------- Browser/PWA ----------------+   HTTPS/WebSocket   +--------------------+
| Fleet map, task graph, terminal wall        | <----------------> | EV local daemon    |
| xterm.js terminal, command palette          |                    |                    |
| voice session, transcript, companion rail   |                    | API/auth gateway   |
+---------------------------------------------+                    | event projector    |
                                                                   | policy/approvals   |
                                                                   | read-only companion|
                                                                   | task service       |
                                                                   | orchestrator host  |
                                                                   | adapter registry   |
                                                                   +---------+----------+
                                                                             |
                      +----------------------+----------------+---------------+--------------+
                      |                      |                |                              |
                tmux control           Codex app-server    Claude ACP/hooks              optional AoE API
                all existing panes     structured runs     structured/fallback           managed sessions
                      |                      |                |                              |
                      +----------------------+----------------+------------------------------+
                                                                             |
                                                               SQLite event and state store
```

### Recommended stack

Use a TypeScript monorepo for the first implementation:

```text
apps/web                 React + Vite browser/PWA
apps/daemon              Node.js local service, REST/WebSocket, supervisor entrypoint
packages/protocol        versioned messages, event types, and generated schemas
packages/tmux-adapter    discovery, control-mode parser, terminal streaming
packages/codex-adapter   app-server lifecycle and event normalization
packages/claude-adapter  ACP/hooks/process fallback
packages/orchestrator    task state machine, tools, scheduling, verification
packages/policy          risk classification and approval rules
packages/store           SQLite migrations, append-only events, projections
packages/voice           provider adapters, companion gateway, delegation envelopes
```

Suggested technologies:

- React, TypeScript, Vite, and a PWA shell;
- xterm.js for focused raw terminals;
- React Flow or a lightweight canvas layer for the task graph;
- Fastify or Hono for the local HTTP API;
- WebSocket for fleet/event/terminal updates;
- SQLite in WAL mode with explicit migrations;
- Zod or generated JSON Schema for every daemon/browser and adapter boundary;
- browser Web Audio APIs plus provider-specific OpenRouter/xAI adapters;
- `systemd --user` on this Linux host so the daemon survives terminal and browser restarts.

Node is appropriate for an initial fleet of tens of panes and keeps the web, Realtime, and orchestration types in one language. A Rust/Go tmux bridge can replace the TypeScript implementation later if profiling shows terminal fanout or VT processing is the bottleneck.

### Why the orchestrator should not live only in a tmux pane

The orchestrator can be represented in the UI like any other agent and can optionally have a tmux inspection pane, but its primary lifecycle should be supervised by the daemon. For Codex, run app-server over stdio or a local Unix socket. This provides structured progress, interrupts, steering, approvals, and resumable threads.

The database owns task and run state. The orchestrator owns planning decisions. Adapters own runtime mechanics. That separation allows any one component to restart without losing the real state of work.

## 7. Canonical data model

The hierarchy is:

```text
Host
  -> Project
      -> Task
          -> Run
              -> Runtime/Agent
                  -> tmux session/window/pane or structured process
              -> Events
              -> Artifacts
              -> Approvals
```

### Core entities

- **Host:** machine identity, capabilities, health, tmux socket, and daemon version.
- **Project:** root directory, repository identity, default branch, policy profile, and allowed paths.
- **Task:** durable user objective, acceptance criteria, priority, dependencies, and lifecycle status.
- **Run:** one attempt to execute a task; includes prompt, adapter, model, cwd, branch/worktree, budgets, timestamps, and outcome.
- **Runtime:** a live or historical agent/process instance with capabilities and native identifiers.
- **Pane:** tmux session/window/pane identity and observed process metadata.
- **Event:** append-only fact with source, correlation IDs, typed payload, and timestamp.
- **Approval:** requested action, risk, rationale, decision, actor, scope, and expiry.
- **Artifact:** diff, commit, file, report, test result, log excerpt, screenshot, or external URL.
- **Conversation:** companion transcript and task links, separate from agent execution histories.

### Task lifecycle

```text
captured -> queued -> planning -> ready -> running -> waiting/blocking
                                      \-> verifying -> review -> completed
                                      \-> failed / cancelled
```

Pane/process state remains separate:

```text
discovered -> observed -> adopted/managed -> active -> exited/lost
```

A task can be `waiting` while its pane is alive. A task can be `failed` even if its agent process is still emitting output. Keeping these models separate prevents common dashboard lies.

### Event ledger

Every meaningful transition is appended before projections update. Minimum event fields:

```text
id, sequence, occurred_at, received_at, type,
host_id, project_id, task_id, run_id, runtime_id, pane_id,
source, source_event_id, correlation_id, causation_id,
confidence, redaction_state, payload_json
```

Build current-state tables as projections from this ledger. The timeline, audit trail, crash recovery, and “what happened while I was away?” summaries all read from the same source.

Raw terminal bytes should have bounded retention and separate storage. Durable semantic events and short redacted excerpts are more valuable than an unlimited transcript of every ANSI sequence.

## 8. Adapter model

All runtimes implement a capability-based contract rather than pretending every agent has the same controls.

```ts
interface RuntimeAdapter {
  readonly kind: string;
  discover(): AsyncIterable<RuntimeObservation>;
  capabilities(handle: RuntimeHandle): Promise<RuntimeCapabilities>;
  launch(spec: LaunchSpec): Promise<RuntimeHandle>;
  send(handle: RuntimeHandle, input: RuntimeInput): Promise<void>;
  steer?(handle: RuntimeHandle, input: RuntimeInput): Promise<void>;
  interrupt?(handle: RuntimeHandle): Promise<void>;
  terminate?(handle: RuntimeHandle): Promise<void>;
  snapshot(handle: RuntimeHandle): Promise<RuntimeSnapshot>;
  events(handle: RuntimeHandle): AsyncIterable<RuntimeEvent>;
}
```

### Adapter priority

1. **tmux observer:** discovers every session/window/pane and streams a best-effort terminal view. It is always available when tmux is available.
2. **tmux managed:** creates EV-owned sessions/windows/panes, sends literal input, resizes, interrupts, and records ownership.
3. **Codex app-server:** first-class structured threads, turns, streamed messages, plans, commands, file changes, questions, goals, usage, and approvals.
4. **Claude structured adapter:** use Agent Client Protocol or supported hooks when available; fall back to tmux/process/pane heuristics.
5. **Generic CLI adapter:** launch and observe arbitrary commands without claiming semantic progress.
6. **AoE adapter:** optional integration with Agent of Empires' managed-session HTTP API.

### Tmux implementation details

Use stable tmux IDs (`$session`, `@window`, `%pane`) as native identity. Names and indexes are mutable labels.

For initial discovery:

- `list-sessions`, `list-windows -a`, and `list-panes -a` with explicit formats;
- collect cwd, command, PID, active/dead state, dimensions, title, activity time, and attached-client state;
- seed a terminal from `capture-pane` with escape sequences and bounded scrollback.

For live observation, use tmux control mode (`tmux -CC`) and parse `%output`, layout, session, window, and subscription notifications. Use one controlled attachment per session initially. Avoid `pipe-pane` for universal discovery because it modifies pane configuration and may conflict with a user's existing setup.

For managed launch, prefer tmux's working-directory option and argv-based process creation:

```text
tmux new-window -t <session> -c <absolute-cwd> -- <agent> <args...>
```

Do not construct `bash -lc "cd ... && codex ..."` from user-controlled strings. If an interactive CLI requires prompt entry, launch the process first, then send literal text and Enter as separate operations.

### Status provenance

Normalize runtime status but retain where it came from:

| Source | Confidence | Examples |
| --- | --- | --- |
| Structured protocol | High | turn started/completed, approval requested, explicit plan step |
| Agent hook | High/medium | Claude stop, permission prompt, notification hook |
| Process/tmux fact | Medium | process exited, pane dead, no attached client |
| Terminal heuristic | Low | prompt pattern, unchanged pane, known spinner text |

The UI must surface low-confidence state instead of silently presenting it as fact.

## 9. Orchestrator design

The orchestrator is a planner and supervisor operating through narrow, typed tools. The daemon performs all side effects.

### Control loop

1. **Receive:** persist the intent and UI context.
2. **Classify:** conversation, query, action, or control; calculate risk and ambiguity.
3. **Clarify:** ask only for missing choices that materially change execution.
4. **Plan:** create tasks, dependencies, acceptance criteria, agent choices, budgets, and verification steps.
5. **Authorize:** policy engine determines automatic, user-confirmed, or denied actions.
6. **Execute:** scheduler launches or steers runtimes through adapters.
7. **Monitor:** events update the ledger; attention rules detect questions, stalls, errors, conflicts, and budget pressure.
8. **Verify:** inspect diffs/artifacts, run tests or a reviewer, and compare against acceptance criteria.
9. **Report:** persist a task receipt and notify the companion.

### Initial tool surface

- `fleet_list` and `runtime_inspect`;
- `task_create`, `task_update`, `task_link`, and `task_cancel`;
- `runtime_launch`, `runtime_send`, `runtime_steer`, and `runtime_interrupt`;
- `terminal_tail` with strict byte/line limits;
- `git_status`, `git_diff_summary`, and `artifact_read`;
- `verification_run` from an allowlisted command profile;
- `approval_request`;
- `result_publish_to_companion`.

There is no unrestricted “run any shell” tool in the orchestrator's default profile. A project may define approved task runners. A separate elevated tool can exist behind explicit user confirmation and auditing.

### Scheduling and isolation

- Default to one git worktree/branch per editing agent.
- Reserve files or warn about overlapping change scopes before two agents edit the same tree.
- Enforce global and per-project concurrency limits.
- Choose the adapter/agent from task shape and capabilities, not only a hard-coded favorite.
- Give every run a timeout, token/cost budget when available, output quota, and maximum retry count.
- A verifier must not merely ask the implementing agent whether it succeeded. Use tests, static checks, diffs, or a separate review run.

### Task receipt

Every terminal outcome should produce a concise receipt:

```text
Objective
Run and agent identity
Working directory and branch/worktree
Actions taken
Files/artifacts changed
Validation performed and results
Open risks or follow-ups
Token/time/cost usage when known
Reason for completed/failed/cancelled status
```

This is the durable answer to “what work did each agent and pane do?”

## 10. Voice companion implementation

### Browser session

Keep the browser transport behind a small provider interface: start/stop, transcript events, audio deltas, interruption, and usage. OpenRouter STT/TTS goes through the local daemon. For xAI WebSocket use a short-lived ephemeral token minted by the daemon; a standard provider key never enters browser storage. Pin exact models during measurements because `latest` aliases can change.

The voice agent receives only:

- a compact persona and interaction policy;
- current user-visible context;
- normalized fleet/task summaries;
- read-only tools for fleet/task/terminal/file inspection and web search;
- the result/event messages the daemon explicitly hands back.

The companion has no submit, cancel, terminal-input, agent-spawn, file-write, or approval capability. Instead it emits a delegation envelope containing an utterance ID, exact transcript, frozen visible context, normalized observed state, and timestamp. Only the orchestrator can interpret that envelope into a task or control action. Utterance IDs are idempotency keys so retries cannot execute work twice.

### Conversation behavior

- Acknowledge a long task immediately: “I created task T-42 and assigned a Codex run in the API worktree.”
- Do not fill several minutes of execution with speculative narration.
- Let the user continue chatting while tasks run.
- Deliver completion as a short spoken result, with detailed evidence visible in the task view.
- Barge-in stops voice output only. It does not cancel an agent unless the user explicitly says to cancel or interrupt it.
- Maintain a visible transcript and show exactly which utterance created or changed a task.

### Approvals by voice

Low-risk, reversible actions may accept a spoken confirmation when the target is unambiguous. High-risk actions require a visible confirmation card and a click/keyboard confirmation; voice can read the request and explain the risk but is not the only authorization factor.

## 11. Security and trust boundaries

### Default policy tiers

| Tier | Examples | Default |
| --- | --- | --- |
| Observe | list panes, read status, navigate, summarize bounded output | automatic |
| Local managed work | create task, spawn agent in allowed root, edit isolated worktree, run allowlisted tests | allowed after an explicit user task request |
| Elevated local | control an existing unmanaged pane, broad network access, escape sandbox, install dependencies | confirmation or project policy |
| External/destructive | push, publish, deploy, send messages, delete data, kill unrelated sessions | explicit confirmation; some require non-voice confirmation |

### Mandatory safeguards

- Bind locally by default; use Tailscale or an authenticated reverse proxy for remote access.
- Never expose the tmux socket, app-server socket, or OpenAI API key to the browser.
- Authenticate terminal WebSockets and apply per-session authorization.
- Use exact argv execution and validated absolute paths.
- Restrict managed cwd values to configured project roots.
- Redact obvious secrets from summaries, events, notifications, and model context.
- Store no raw microphone audio by default; make transcript retention configurable.
- Rate-limit commands, prompt sends, session creation, and voice tool calls.
- Make destructive operations idempotent where possible and record causation IDs.
- Separate `observe`, `control`, and `admin` capabilities.
- On daemon restart, reconcile first; never kill or relaunch an unknown pane merely because persisted state disagrees.

## 12. Reliability and observability

- Run the daemon under `systemd --user` with restart-on-failure.
- Use SQLite WAL, transactional event append + projection updates, and versioned migrations.
- Assign idempotency keys to task creation and runtime launch.
- Reconcile tmux, app-server workers, and database state at startup.
- Apply bounded WebSocket queues and snapshot-then-delta reconnect semantics.
- Use monotonic per-source sequence numbers and deduplicate native events.
- Maintain adapter health, last event time, reconnect count, dropped-byte count, and parser errors.
- Add a “truth inspector” that shows the raw source facts behind a card's derived status.
- Preserve a panic control that disables new orchestration and interrupts only EV-managed runtimes; never make “kill all tmux” the default panic behavior.

## 13. API outline

Initial HTTP resources:

```text
GET    /api/health
GET    /api/snapshot
GET    /api/projects
GET    /api/tasks
POST   /api/tasks
GET    /api/tasks/:id
POST   /api/tasks/:id/cancel
GET    /api/runtimes
GET    /api/runtimes/:id
POST   /api/runtimes/:id/adopt
POST   /api/runtimes/:id/input
POST   /api/runtimes/:id/interrupt
POST   /api/runtimes/launch
GET    /api/approvals
POST   /api/approvals/:id/decision
POST   /api/voice/session
POST   /api/voice/intent
GET    /api/events
```

WebSocket channels:

```text
/ws/events                  normalized fleet/task/event deltas
/ws/terminal/:paneId        terminal seed, live bytes, resize, optional input
/ws/runtime/:runtimeId      structured agent events
/ws/companion               transcripts, acknowledgements, results, notifications
```

Use one versioned envelope for all pushed messages:

```json
{
  "version": 1,
  "sequence": 1234,
  "type": "runtime.status.changed",
  "correlationId": "task_...",
  "occurredAt": "...",
  "payload": {}
}
```

## 14. Delivery plan

The sequence deliberately proves the risky integration seams before polishing the complete interface.

### Milestone -1 — Evidence and provider lab (current)

- Run the independent tmux, companion-policy, delegation, failure, browser-audio, STT, TTS, Grok Voice, and cost probes in `scripts/run-lab.mjs`.
- Collect a labelled real-voice corpus and measure WER plus intent accuracy.
- Measure median/P95 first-audio and end-to-end latency, disconnects, interruption, and provider-reported usage.
- Use exact model IDs and dated evidence; do not count documentation claims as successful integrations.
- Select chained, duplex, or hybrid transport only after the experimental gates in `EXPERIMENT_PLAN.md` are met.

Exit criteria: the companion capability boundary and exact-once delegation tests pass; real voice/provider data is sufficient to choose the first transport; tmux observation is proven non-mutating.

### Milestone 0 — Integration spike and walking skeleton (2–4 days after evidence gates)

- Initialize the TypeScript monorepo and local daemon.
- Inventory the live tmux sessions/windows/panes using stable IDs.
- Persist a snapshot and normalized events in SQLite.
- Render a minimal browser fleet list.
- Prove terminal seeding + live tmux control-mode output on an existing Claude pane without changing it.
- Start a Codex app-server thread and render structured turn/item events.
- Establish the selected browser voice transport with a read-only companion fleet query and orchestrator handoff.
- Evaluate Agent of Empires as an optional adapter and record the fork/integration decision.

Exit criteria: one browser page shows the current 16-pane fleet, can open one live read-only pane, can show one structured Codex run, and can answer “what is running?” by voice.

### Milestone 1 — Reliable bird's-eye dashboard (4–7 days)

- Full session/window/pane reconciliation.
- Fleet map, terminal wall, project grouping, search, filters, and keyboard navigation.
- xterm focused view with resize, reconnect, copy, bounded scrollback, and truth inspector.
- Process metadata, git repo/worktree/branch detection, last activity, and confidence-labelled status.
- Event timeline and attention queue.
- Daemon supervision and snapshot/delta reconnect.

Exit criteria: leaving the browser, restarting the daemon, or creating/killing/renaming tmux panes does not corrupt the dashboard and never alters unmanaged panes.

### Milestone 2 — Safe terminal and agent control (4–7 days)

- Explicit adoption of unmanaged panes.
- EV-managed tmux session/window/pane creation.
- Literal input, resize, interrupt, and managed termination.
- Project root allowlists, argv-safe launches, policy tiers, approval cards, and audit events.
- Worktree-per-editing-run support and collision warnings.
- Command palette for launch, send, focus, interrupt, and cancel.

Exit criteria: a user can launch a new agent in a selected directory, observe it, send a follow-up, and stop only that managed runtime with a complete audit trail.

### Milestone 3 — Structured agent adapters (5–10 days)

- Productionize the Codex app-server adapter with generated version-matched schemas.
- Normalize plans, messages, commands, file changes, questions, goals, usage, approvals, and results.
- Add Claude ACP/hooks integration and retain tmux fallback.
- Add adapter capability discovery and status provenance.
- Show diffs, changed files, test evidence, and task receipts.

Exit criteria: managed Codex and Claude runs show meaningful activity cards and approvals without depending on terminal regexes; unsupported agents degrade honestly to raw-terminal mode.

### Milestone 4 — Durable orchestrator (7–12 days)

- Task/dependency model, scheduler, budgets, retries, cancellation, and recovery.
- Orchestrator thread under the daemon with narrow tools.
- Task planning, delegation, steering, verification, result synthesis, and receipts.
- Concurrency/resource controls and worktree/file conflict handling.
- “Needs attention,” “possibly stalled,” and “active on a bad premise” checkpoints.
- Independent verifier path for risky or code-changing tasks.

Exit criteria: one user objective can be decomposed into parallel runs, monitored, verified, and summarized after an orchestrator or daemon restart without losing causality.

### Milestone 5 — Full voice companion (4–7 days)

- Conversation/query/action/control routing.
- Context-bound utterances and visible transcript/task linkage.
- Natural acknowledgement, barge-in, status queries, steering, cancellation, and spoken completion.
- Voice persona/preferences, compact companion memory, and notification policy.
- Voice approval rules and non-voice confirmation for high-risk actions.
- Usage limits and cost visibility.

Exit criteria: the core lifecycle can be completed hands-free for ordinary local work while high-risk actions still stop at a visible approval boundary.

### Milestone 6 — Hardening and remote use (5–10 days)

- Tailscale/private-network access, strong auth, session expiry, and CSRF/origin protections.
- PWA installability and mobile layouts.
- Push notifications for waiting/completed/error states.
- Fault injection for tmux restarts, daemon restarts, network loss, malformed output, duplicate events, and adapter crashes.
- Unit, contract, integration, and real-browser Playwright tests.
- Resource profiling and retention/backup controls.

Exit criteria: the app can be safely used from a trusted remote device, recovers from expected failures, and has reproducible end-to-end tests.

### Realistic duration

A convincing proof of concept is about one focused week. A dependable single-user MVP is roughly 4–6 weeks. The full v1 above is roughly 6–9 weeks for one experienced developer working full time with agent assistance. “Vibe coding” can shorten scaffolding and UI iteration, but terminal correctness, recovery, permissions, and voice authorization still require deliberate tests.

## 15. First sprint backlog

Execute these in order after approving this blueprint:

1. Initialize Git, pnpm workspaces, TypeScript, lint/test/build commands, and an architectural decision log.
2. Define `Host`, `Project`, `Task`, `Run`, `Runtime`, `Pane`, `Event`, and `Approval` schemas.
3. Implement read-only tmux inventory with fixtures from the current machine.
4. Implement a control-mode parser with golden tests for `%output`, layout, session, and disconnect messages.
5. Build SQLite event append, projections, and startup reconciliation.
6. Build `/api/snapshot`, `/ws/events`, and the first overview cards.
7. Prove terminal seed/live handoff without lost or duplicated output.
8. Generate Codex app-server TypeScript schemas during build and implement a minimal adapter.
9. Add the Realtime session endpoint and a voice-only read query.
10. Run the spike exit test against existing `labs`, `none`, and `remote-cli-session` sessions.
11. Record whether Agent of Empires is an adapter, a source donor, or intentionally not used.
12. Only then finalize the visual system and expand write controls.

## 16. Acceptance tests for the overall objective

The system is successful when all of the following are demonstrably true:

- Every live tmux pane appears within two seconds, including panes not created by EV.
- A pane rename, split, close, or session switch updates without page refresh.
- Clicking a card opens a live terminal and a clear breadcrumb back to its task/project.
- Managed Codex events render as structured plan/tool/diff/approval activity.
- Low-confidence Claude/generic status is labelled as heuristic.
- A spoken action creates exactly one durable task even if the network retries.
- The voice companion acknowledges immediately and later speaks a verified result.
- Saying “stop this agent” cannot stop the wrong pane if UI context changed during transcription.
- High-risk actions cannot be approved only by an ambiguous utterance.
- Parallel editing runs do not silently share one working tree.
- Restarting the browser, daemon, orchestrator, or adapter does not lose task history.
- No unmanaged pane is killed, resized, or written to during read-only observation.
- Each completed task has a receipt with changes, evidence, and remaining risks.

## 17. Principal risks and mitigations

| Risk | Consequence | Mitigation |
| --- | --- | --- |
| Screen scraping misclassifies an agent | False progress or missed attention | Prefer protocols/hooks; label heuristic confidence; show raw facts. |
| Terminal stream fanout or backpressure | Memory growth and frozen panes | Bounded queues, pane pause/resume, snapshots, dropped-byte metrics. |
| Two agents edit the same tree | Mixed diffs and lost attribution | Worktree per run, file reservations, conflict detection. |
| Orchestrator context drifts from reality | Wrong delegation or completion | Database is authoritative; re-read typed state; require verification evidence. |
| Voice mishears a target or destructive verb | Wrong action | Freeze UI context, repeat target, risk gate, non-voice confirmation. |
| Browser closes before completion | No spoken result | Push notification; speak on re-entry; optional desktop/mobile shell later. |
| Raw logs leak secrets | Sensitive data enters DB/model/UI | Bounded capture, redaction, retention controls, never send raw fleet output by default. |
| Upstream protocol changes | Adapter breakage | Generate schemas from installed tool version; adapter contract tests and capability negotiation. |
| A giant fork becomes hard to maintain | Slow upgrades and merge conflicts | Adapter-first core; isolate optional integrations; decide reuse after a spike. |

## 18. Recommended decision

Run the evidence lab and collect real voice data before starting the adapter-first TypeScript walking skeleton. Treat direct tmux discovery as the non-negotiable universal layer, Codex app-server as the first rich agent layer, Claude ACP/hooks as the second, and SQLite events as the source of truth. Choose OpenRouter chaining, Grok Voice, or a hybrid only from measured accuracy, intent safety, latency, interruption, reliability, and cost.

The most important architectural rule is this:

> The companion converses and observes; the orchestrator reasons and decides; policy authorizes; adapters execute; and the event ledger proves what happened.

That division produces the intuitive companion experience without turning a conversational model into an unaudited root shell.
