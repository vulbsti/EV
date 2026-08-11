# EV control workstation prototype

Date: 2026-08-11  
Status: runnable localhost control panel; orchestrator execution is the next layer

## Workstation model

The browser is no longer organized as an overview page. The useful unit is a live terminal surface, so the center of the screen is a dense wall of every current tmux pane. Each surface shows its latest output and provides command input without requiring a detail click.

```text
session and view filters | live terminal wall                    | attention inbox
                         | pane output + command input             | permissions/review
                         | multi-select and broadcast              | orchestrator queue
                         | focused full-screen terminal            | event ledger
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

The orchestrator is deliberately secondary in this UI. Its panel receives a typed request plus the focused or singly selected pane as context. It can answer simple fleet queries and create durable handoffs, but it does not yet execute them. Recent handoffs and raw event-ledger entries are visible without leaving the workstation.

This creates the correct next integration seam:

```text
user controls terminals directly today
              +
orchestrator sees normalized fleet, terminal activity and attention
              -> later plans, launches and supervises managed agents
```

Voice APIs remain in the daemon for prior experiments but have been removed from the active workstation UI.

## Start it

```bash
npm run prototype
```

Open `http://127.0.0.1:4317`.

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
| `GET /api/tasks` | durable orchestrator handoffs |
| `GET /api/events` | append-only control and orchestration ledger |
| `POST /api/companion` | fleet query or orchestrator handoff |

## Verified behavior

- Rendered 16 real panes simultaneously at 1920×1080, with five columns by default and 3–6-column density controls.
- Captured all terminal tails concurrently while keeping the page responsive.
- Created a temporary tmux session through the HTTP API, sent a literal command, observed `EV_CONTROL_SMOKE_OK` in its captured output, sent Ctrl-C, and removed the test session.
- Created a session, split a second pane, and created a new window through the three spawn modes; all returned real tmux IDs.
- Printed `Agent paused: Do you want to proceed? [y/N]` in a temporary pane. The detector returned one critical `Confirmation requested` item with the exact evidence and the browser promoted it to the top of the terminal wall and attention inbox.
- Removed all temporary sessions after testing; the original fleet returned to 3 sessions and 16 panes.
- Persisted redacted `pane.input_sent`, `pane.key_sent`, and `pane.spawned` ledger events.
- Passed all nine automated policy, delegation, attention, redaction, resilience, and statistics tests.
- Loaded the complete control surface in headless Chrome with no JavaScript console errors.

## Remaining limitations

- Terminal surfaces are high-frequency tmux captures, not full VT emulators. Mouse-mode TUIs, exact cursor placement, colors, and alternate-screen interaction need an xterm.js plus tmux-control-mode transport.
- Attention detection is heuristic; Codex app-server and Claude hook/ACP signals should become higher-confidence evidence.
- Direct command broadcast is powerful. There is no role-based access, per-pane adoption, or confirmation tier yet.
- The orchestrator queues work but does not yet spawn, supervise, verify, or stop agents.
- Task state is append-only and currently remains `awaiting_orchestrator`.
- Remote access and multi-user authentication are not implemented.
