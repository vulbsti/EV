# EV developer workstation prototype

Date: 2026-08-11  
Status: runnable localhost control panel with a separate evidence-synchronized explanation window; orchestrator execution is the next layer

## Workstation model

The browser is no longer organized as an overview page. The useful unit is a live terminal surface, so the center of the screen is a dense wall of every current tmux pane. Each surface shows its latest output and provides command input without requiring a detail click.

```text
session and view filters | live terminal wall                    | attention inbox
                         | pane output + command input             | permissions/review
                         | multi-select and broadcast              |
                         | focused full-screen terminal            |
```

The daemon captures 72 terminal lines from all panes concurrently every 1.2 seconds. It removes terminal escape codes, compares hashes to determine which panes are changing, and scans the newest output for permission, confirmation, input, review, and failure signals. Panes requiring the user are sorted first, highlighted red, placed in the attention inbox, and surfaced through an attention popup. Optional desktop notifications can be enabled from the top bar.

## Direct control

Every terminal card has:

- live output;
- a selection checkbox for multi-pane operations;
- an inline command input and Send action;
- a Ctrl-C control;
- a focus button opening a large terminal surface.

Focus mode adds Ctrl-C, Ctrl-D, Tab, Up, Down, and arbitrary command entry. Selecting multiple panes opens a broadcast dock which can send the same command, Enter, or Ctrl-C to all selected panes.

Control is executed with argument-safe `tmux send-keys` calls:

```text
browser command
  -> POST /api/panes/:id/input
  -> validate pane and input size
  -> tmux send-keys -l <literal text>
  -> optional tmux send-keys Enter
  -> append redacted control event
  -> refresh affected output
```

The new-runtime dialog can create a pane in an existing window, a window in an existing session, or an entirely new tmux session. It accepts a working directory and optional initial command. Spawn events are also added to the ledger.

## Attention mechanics

The current detector is deterministic and inspectable. It searches recent terminal output for signals such as:

- permission or approval required;
- “Do you want to proceed?” and `[y/N]` confirmation prompts;
- “Press Enter” or waiting-for-input messages;
- explicit review requests;
- fatal errors, panics, failed tests, and failed builds.

An attention card displays the exact matching line and exposes No, Yes, Enter, and Focus controls. Because the detector reads terminal text, it can still produce false positives or miss a tool-specific full-screen prompt. Agent-specific structured adapters will eventually replace or corroborate these heuristics.

## Orchestrator position

The old non-executing orchestrator panel and its `awaiting_orchestrator` queue were removed when the durable assistant surface became the default route. They were misleading seams rather than useful task execution. The workstation now remains only for direct developer inspection and terminal control at `/workstation`.

This creates the correct next integration seam:

```text
user controls terminals directly today
              +
orchestrator sees normalized fleet, terminal activity and attention
              -> later plans, launches and supervises managed agents
```

Voice APIs remain in the daemon for prior experiments but have been removed from the active workstation UI.

## Explanation window

Every terminal card and focused terminal has a `WHY?` action. It opens a separate browser window bound to that pane. Explanation questions run in a dedicated read-only Codex thread and never enter the executor context. Before each question, the daemon refreshes project-purpose documents, bounded recent console text, Git, diff, validation-signal, and event-ledger evidence and assigns it a revision.

Each question uses one deep Codex turn to produce a typed mechanics model. A deterministic local parser/linker applies hard display budgets and produces the direct answer, goal alignment, selectable causal steps, and normal/edge-case paths. Compactness is therefore a presentation operation rather than a restriction on the model's investigation.

The same window has a Capability Lab. Projects declare typed mechanisms, controls, scenarios, and authority-scoped adapters in `.ev/capabilities.json`. Supported scenarios execute real code and return traces, assertions, comparisons, load/resource/cost metrics, immutable receipts, and regression proposals. Unsupported behavior is labelled `missing adapter` rather than simulated by the language model.

The conversation survives browser and daemon restarts because EV records the explanation session, Codex thread ID, questions, structured answers, evidence revisions, and feedback as events. Question-derived interests weakly tune later explanations; explicit teaching feedback has stronger visible weight. See [EXPLANATION_WINDOW.md](EXPLANATION_WINDOW.md) for the exact mechanics, safety boundary, tests, and current limitations.

## Start it

```bash
npm run prototype
```

Open `http://127.0.0.1:4317/workstation`. The root URL is now the personal-assistant conversation.

The server binds to `127.0.0.1`. There is no authentication, so do not expose it directly to a network.

## Control API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/control-snapshot` | fleet, live tails, activity and attention in one request |
| `GET /api/fleet` | normalized session and pane metadata |
| `GET /api/panes/:id/tail` | larger read-only pane capture |
| `POST /api/panes/:id/input` | send literal text with optional Enter |
| `POST /api/panes/:id/key` | send an allow-listed terminal key |
| `POST /api/tmux/spawn` | create a pane, window, or session |
| `GET /api/explain/context` | bounded public evidence summary for one pane |
| `GET /api/explain/sessions/:id` | reconstruct a multi-turn explanation session |
| `POST /api/explain/ask` | ask from fresh evidence in the separate read-only thread |
| `POST /api/explain/feedback` | update the visible explainer-only teaching profile |
| `POST /api/explain/task-context` | bind the pane's exact objective and acceptance criteria |
| `GET /api/capabilities` | list executable capabilities and acceptance state |
| `POST /api/experiments/run` | run one bounded adapter scenario |
| `POST /api/experiments/acceptance-suite` | run normal, load, and contract-failure acceptance scenarios |
| `GET /api/experiments/recent` | list persisted experiment receipts |
| `GET /api/experiments/:id` | reconstruct one experiment receipt |

## Verified behavior

- Rendered 16 real panes simultaneously at 1920×1080, with five columns by default and 3–6-column density controls.
- Captured all terminal tails concurrently while keeping the page responsive.
- Created a temporary tmux session through the HTTP API, sent a literal command, observed `EV_CONTROL_SMOKE_OK` in its captured output, sent Ctrl-C, and removed the test session.
- Created a session, split a second pane, and created a new window through the three spawn modes; all returned real tmux IDs.
- Printed `Agent paused: Do you want to proceed? [y/N]` in a temporary pane. The detector returned one critical `Confirmation requested` item with the exact evidence and the browser promoted it to the top of the terminal wall and attention inbox.
- Removed all temporary sessions after testing; the original fleet returned to 3 sessions and 16 panes.
- Persisted redacted `pane.input_sent`, `pane.key_sent`, and `pane.spawned` ledger events.
- Passed all 20 automated policy, delegation, attention, evidence-redaction, explainer-isolation, presentation-budget, capability-adapter, task-binding, web-contract, resilience, and statistics tests.
- Loaded the complete control surface in headless Chrome with no JavaScript console errors.
- Created a real Codex app-server explanation thread, resumed the same multi-turn thread after a daemon restart, attached a new evidence revision, persisted the answer, and applied explainer-only visual feedback.

## Remaining limitations

- Terminal surfaces are high-frequency tmux captures, not full VT emulators. Mouse-mode TUIs, exact cursor placement, colors, and alternate-screen interaction need an xterm.js plus tmux-control-mode transport.
- Attention detection is heuristic; Codex app-server and Claude hook/ACP signals should become higher-confidence evidence.
- Direct command broadcast is powerful. There is no role-based access, per-pane adoption, or confirmation tier yet.
- The developer workstation has no assistant intake or task queue. Those concerns moved to the root assistant surface.
- The root assistant records unavailable work as `not_executable` and routes only the reviewed local launch-brief request to the supervised worker. Other capabilities remain unavailable by design.
- Generic panes do not yet expose structured executor plans, tool calls, or authoritative test results; explanations label tmux-derived facts as heuristic.
- Explanation answers currently complete over one HTTP request rather than streaming deltas to the browser.
- Executable understanding is adapter-scoped. Arbitrary auth, OCR, PDF, browser, database, or production-load behavior remains unsupported until a purpose-built adapter is registered.
- Remote access and multi-user authentication are not implemented.
