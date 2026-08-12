# EV Mission Control — experiment-first workspace

EV is a browser-based tmux control workstation and emerging orchestrator for terminal agents. The repository contains a runnable control prototype plus the experiment lab used to validate its underlying assumptions.

A first localhost prototype is now runnable:

```bash
npm run prototype
```

Open `http://127.0.0.1:4317`. The workstation shows all terminal tails at once, detects attention prompts, sends commands and keys, broadcasts to selected panes, launches tmux runtimes, and maintains an orchestrator handoff queue. See [the prototype guide](docs/PROTOTYPE.md) for exact mechanics and limitations.

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
