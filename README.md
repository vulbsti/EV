# EV — personal assistant prototype

EV's current proof of concept is one conversation with a working task manager: it turns a request into a goal, runs one OpenClaw executor or up to three independent child assignments, combines their results, and returns completed, partial, or blocked outcomes inline. OpenClaw and the manager use OpenCode Go `gpt-6-luna`. See the [prototype architecture and limits](docs/assistant/OPENCLAW_POC.md).

Run it with Node.js 22+, OpenClaw installed, and `OPENCODE_API` set in the local `.env`:

```bash
npm run prototype
```

Open `http://127.0.0.1:4317`. The conversation and parent/child tasks are durable in SQLite. At most three supervised workers run at once. Completed children survive restart; cancelling a parent stops its active and waiting children. A failed child is retried once only when its assignment was planned as safe to repeat. Minor review concerns do not block delivery; relevant caveats accompany the answer, and unresolved material gaps remain visible as partial results. Produced files are checked and downloadable. The older Pi canaries remain available for development.

To exercise the manager through the running server with real workers, a disposable local fixture, public X research, parallel programs, and one interrupted child:

```bash
npm run assistant:manager-check -- --interrupt-child
```

The script opens no external write flow. Results and verification receipts stay under ignored `data/manager-check/`; it prints the conversation URL. `npm test` covers worker capacity, retry, partial delivery, cancellation, and recovery with deterministic fixtures.

`Understanding you` exposes source-linked memory controls. Explicit global guidance can be inspected, corrected, stopped, or erased and is recorded in the context manifest for later tasks. Automatic learning of taste and goals is not implemented yet.

`Responsibilities` exposes the first connected alpha: one read-only GitHub pull request with an inspectable, expiring, revocable mandate. EV establishes the current revision as a baseline, polls while the browser is closed, prepares a verified draft only after a material change, and shows recent outcomes with their exact provider revisions. The connector cannot comment, merge, push, label, publish, or message anyone.

The previous tmux control surface remains available at `http://127.0.0.1:4317/workstation` as a developer view. Its non-executing orchestrator queue has been removed rather than carried into the assistant. See [the prototype guide](docs/PROTOTYPE.md) for its remaining terminal-control mechanics and limitations.

Each terminal also has a `WHY?` action that opens a second, read-only [Explanation Window and Capability Lab](docs/EXPLANATION_WINDOW.md). It anchors questions in the project and current task, builds a typed mechanics model from current pane/Git/test/event evidence, and deterministically compiles it into a bounded selectable causal path. Registered adapters then let the learner manipulate inputs and execute supported normal, edge, load, and failure scenarios with traces, metrics, persisted receipts, and regression proposals. The multi-turn Codex conversation remains separate and never sends explanation questions back to the executor.

The current voice hypothesis is:

```text
microphone -> STT / speech-to-speech transport -> read-only voice companion
                                                     |
                       simple conversation/query ----+
                                                     |
                       reasoning or action -> orchestrator -> controlled tools
                                                     |
speaker <- TTS / speech-to-speech response <----------+
```

The voice companion can observe fleet state, terminal tails, task state, files, and the web. It cannot type into panes, launch agents, write files, approve actions, or run commands. Those requests become correlated delegation envelopes for the orchestrator.

## Run the lab

No third-party packages are required. Node.js 22 or newer and tmux are sufficient for local experiments.

```bash
npm test
npm run lab:quick
npm run lab -- --list
npm run lab -- --mode mock --experiments companion-policy,tmux-observation
npm run lab:live -- --experiments xai-realtime --repeat 20 --concurrency 1
```

To recreate and validate the first real browser-canary evidence bundle from the local event ledger:

```bash
npm run assistant:phase0
npm run validate:assistant-run -- artifacts/assistant-runs/2026-09-21/phase0-b0-routing
```

The run deliberately omits screenshots when the live terminal wall contains unrelated private content; it retains the computer-use journey and correlated event receipts instead.

The original no-tool canary is retained as the narrow lifecycle baseline. The extended canary loads one reviewed skill and extension with workspace-scoped read/write/list/grep and a network-disabled command allowlist:

```bash
npm run assistant:phase2-canary
npm run assistant:phase2-extended
```

Outputs and retained Pi sessions stay under ignored `data/assistant-worker/`. The product route is intentionally exact: `Create a one-page launch-status brief from the selected local fixture.`

Phase 4 keeps the local reconciliation canary and adds a real read-only GitHub canary plus explicit stale/no-data faults:

```bash
npm run assistant:phase4-local
npm run assistant:phase4-github
npm run assistant:phase4-faults
```

The GitHub canary defaults to PR #2 and may be pointed at another reviewed pull request with `EV_GITHUB_CANARY_RESOURCE=github://owner/repo/pulls/number`. It uses the trusted host-side `gh` credential store; that connector credential is not copied into Pi's environment, workspace, prompt, metadata, or artifact. Recognizable secret-like strings in pull-request content are redacted before the source snapshot reaches Pi, but this is defense in depth rather than a universal secret detector.

Each run creates private-permission JSON/JSONL evidence under `artifacts/lab/<run-id>/`. Terminal capture stores sizes, timing, line counts, and hashes—not raw terminal contents.

For the manual browser microphone probe:

```bash
npm run lab:browser
```

Open `http://127.0.0.1:4177`, record the displayed reference phrase, and export both the WebM and JSON. Convert if needed with ffmpeg, then use it as a labelled STT input:

```bash
ffmpeg -i recording.webm -ar 16000 -ac 1 recording.wav
OPENROUTER_API_KEY=... OPENROUTER_STT_MODEL=openai/whisper-1 \
  npm run lab:live -- --experiments openrouter-stt --audio recording.wav \
  --reference "EV can observe agents without allowing its voice companion to mutate terminals."
```

Live probes are opt-in and self-skip if credentials or required model choices are absent. Use `--repeat N` for distributions; keep provider repetitions at `--concurrency 1` unless rate-limit behavior is what you intend to measure. Copy `lab/config.example.json`, adjust it, and pass `--config your-config.json`. For xAI, set `XAI_API_KEY`; for OpenRouter set `OPENROUTER_API_KEY`, plus an explicit billable `OPENROUTER_TTS_MODEL` for TTS. Secrets are never written to evidence.

See [the experiment plan](docs/EXPERIMENT_PLAN.md) for hypotheses, measurements, and build gates, and [the product blueprint](docs/PRODUCT_BLUEPRINT.md) for the overall architecture.
