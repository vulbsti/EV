# EV Orchestrator Design Rationale: from tmux wall to harness-agnostic mission control

**Date:** 2026-09-08
**Audience:** Engineers joining EV, reviewers of the three prototype cuts
**Companion to:** `docs/PRODUCT_BLUEPRINT.md`, `docs/EXPERIMENT_PLAN.md`, `docs/PROTOTYPE.md`, `docs/EXPLANATION_WINDOW.md`, `docs/CAPABILITY_LAB_ACCEPTANCE.md`, `.ev/capabilities.json`, `tools/omp-capability-lab/` (worktree spike)

## 1. What this document is

This is the mental model behind EV, not the build manual. It explains why three prototype cuts exist in one linear history, what each one proved, what the author is actually reaching for (a ChatGPT-desktop-like ambient orchestrator over every agent and session, harness- and model-agnostic, with a hover-to-explain visual system), and which decisions cascade from that goal. Specs and code are authoritative where details conflict. This is not a tutorial, not API reference, not a promise that every blueprint milestone is built.

## 2. The starting situation

One machine, too many agents. At blueprint inspection time: tmux 3.4, 3 sessions, 16 live panes (13 `claude`, 2 `node`, 1 `bash`), work spread across repos and Claude-created git worktrees, Codex CLI 0.147.0, Node 22, no auth, no task truth outside terminal scrollback.

Three commits, one lineage (not three forks):

- `0c85bd7` (`main`, 2026-08-11, root, +3089 lines, 45 files): localhost tmux control workstation + experiment-first voice/authority lab. Browser polls daemon; daemon shells out to tmux; orchestrator queues but never executes.
- `36b5a3d` (2026-08-12, +1810/−8, 19 files): isolated interactive explanation window. Adds `WHY?` popup, `evidence.mjs`, two-turn Codex explainer inside `explainer.mjs`, `codex-app-server.mjs` stdio client, `.agents/skills/explain-live-work/SKILL.md`, `EXPLANATION_WINDOW.md` v1.
- `aa40c9d` (`interactive-explainer` HEAD, 2026-08-12, +1663/−418, 23 files): executable capability lab. Adds `.ev/capabilities.json`, `presentation.mjs`, `experiment-adapters.mjs`, `experiment-runner.mjs`, `capability-spec.mjs`, `CAPABILITY_LAB_ACCEPTANCE.md`, `explain.js` v2 with lab mode.
- `.worktree/omp-capability-lab` (`feat/omp-capability-lab`, still based at `0c85bd7` + unstaged spike): generic manifest-driven probe core. Untracked `tools/omp-capability-lab/` (`manifest.mjs` schema v2, `snapshot.mjs`, `runner.mjs` with `prlimit` sandboxing, `feed.mjs`, `rpc-agent.mjs`, `calibration.mjs`, `coordinator.mjs` + OMP `extension.js`, `bin/omp-live.mjs`, `bin/demo.mjs`, `bin/fake-explainer.mjs`, web workbench, fixture pipeline, three skills), plus `M package.json` (adds `omp:live`, `capability:demo`, `capability:fixture`) and `M .gitignore` (adds `.worktree/`).

The deepest structural fact: every cut keeps the same sentence — *the companion converses and observes; the orchestrator reasons and decides; policy authorizes; adapters execute; the event ledger proves what happened* — and each cut moves one clause from prose into running code.

## 3. What success looks like

1. **Every live pane appears within two seconds, including panes EV did not create.** Arbitrary tmux state is first-class; managed sessions are a subset, never the whole world.
2. **No unmanaged pane is ever mutated by observation.** Read-only is enforced by argv boundaries and tool gateways, not by prompt text.
3. **A spoken action creates exactly one durable task even under retry.** Utterance IDs are idempotency keys; delegation envelopes freeze UI context at speech-start.
4. **Understanding never contaminates execution.** Explanation threads cannot type, approve, spawn, or message the executor; executable learning happens only through registered, authority-declared adapters with persisted receipts.
5. **Status is never fabricated.** Cards carry source + confidence (`structured` / `hook` / `process` / `heuristic`); progress comes from plans and checkpoints, never a smoothed percent over terminal bytes.

These five pull in different directions — that tension is §4.

## 4. The design tensions

| Pull toward A | Pull toward B |
|---|---|
| Observe everything now (poll `capture-pane` every 1.2 s, 72 lines, whole wall live) | Never disturb unmanaged panes (600 ms cache, literal `-l` input, explicit adoption before control) |
| Conversational voice that feels instant (duplex S2S, barge-in, spoken progress) | Exact, auditable action (frozen context, idempotent envelopes, non-voice confirmation for high risk) |
| Deep mechanical explanation (unbounded investigation turn, full evidence to model) | Bounded selectable UI (650-char answer, 6 steps, 5 scenarios, progressive disclosure) |
| Universal fallback today (terminal heuristics work on any pane) | Structured truth tomorrow (Codex app-server / Claude hooks / ACP with confidence labels) |
| One daemon that does all (simplest prototype: `server.mjs` + JSONL) | Adapter-first core that survives any harness (tmux / Codex / Claude / AoE / MCP / containers) |
| Replaceable voice models (OpenRouter chained STT→LLM→TTS, per-stage policy gates) | Natural low-latency voice (Grok S2S, sub-second first audio, single-vendor lock-in) |
| Executable understanding everywhere (generic shell would prove anything) | Honest `missing adapter` where no safe adapter exists (never simulate a run with prose) |
| Ambient always-on companion (zero-friction summon, background convos) | Push-to-summon + explicit grants (hotkey, 200-line caps, per-message attachments, revocable permissions) |

## 5. The central insight

> When you look at the fleet from the terminal's point of view you see bytes; when you look at it from the task's point of view you see obligations — and the product lives in the gap between those two views.

Everything cascades from that reframing: the terminal wall proves bytes can be shown; the explanation window proves obligations can be narrated without touching bytes; the capability lab proves narration can be checked against real runs; the OMP worktree spike proves checks can be generic probes over snapshots rather than two hard-coded demos. The requested visual system is the same insight turned into interface: a hoverable map where every node answers "why is this here?" in one sentence and expands to rationale, evidence, and runnable edge cases on demand.

## 6. The decisions, in causal order

### 6.1 Treat tmux as the universal observation baseline, not a manager's namespace

**Alternative considered:** Build on Agent of Empires' managed sessions (or NTM's named sessions) as the fleet primitive.

**Why tmux-direct:** The machine already had 16 panes across 3 sessions that no manager created. `lab/lib/tmux.mjs` normalizes stable IDs (`$session`, `@window`, `%pane`) from `list-panes -a -F`; `controlSnapshot()` concurrently runs `capture-pane -p -e -t <id> -S -<lines>` per pane behind a 600 ms shared-promise cache, strips controls, hashes the last 30 lines for `steady`/`working`/`attention`, and degrades a single failed capture to an empty tail rather than failing the wall. AoE/NTM become optional adapters later, never the identity.

**Trade-off accepted:** Polling + heuristics instead of event-driven control-mode streams and structured protocols; full-screen/cursor/mouse fidelity and per-pane error markers deferred to xterm.js + `tmux -CC` work.

### 6.2 Enforce the voice authority boundary in code, not in prompts

**Alternative considered:** One voice agent with shell/tmux tools and a system prompt saying "be careful, ask before destructive actions."

**Why gateway denial:** `lab/lib/companion-policy.mjs` classifies every utterance (action > reasoning > query > conversation; "stop that agent" is `action`, not a fifth mode) and the tool gateway allows exactly `fleet_snapshot`, `terminal_tail`, `task_status`, `web_search`, `read_file` while returning `delegate_to_orchestrator` for `send_keys`, `spawn_agent`, `kill_pane`, `write_file`, `approve`, `run_command`. `EXPERIMENT_PLAN.md` states it plainly: denial is enforced by the tool gateway even if a model attempts the call. The delegation envelope (`schemaVersion`, `utteranceId`, exact `transcript`, cloned `uiContext`, frozen `observedState`, `requestedAt`) plus `task.delegated` ledger events make "exactly once" testable (`delegation-contract.mjs`: transcript equality, frozen context, dedupe, correlation).

**Trade-off accepted:** The v1 daemon queue never executes; `GET /api/tasks` always reads `awaiting_orchestrator`. Feels like a dead end in the UI, but it is the correct seam: execution arrives later through adapters, never by widening the companion.

### 6.3 Run the lab before building the product

**Alternative considered:** Scaffold the TypeScript monorepo (`apps/web`, `apps/daemon`, `packages/*`) and full voice UI immediately per blueprint §6/§14.

**Why experiments first:** The risky questions were measurement questions, not drawing questions: pane-ID stability, companion zero-leak rate, exact-once delegation, STT WER on the user's voice, first-audio/end-to-end P50/P95, barge-in, cost per minute. `scripts/run-lab.mjs` (worker pool, default 4; quick profile = 5 credential-free modules) writes `results.jsonl` + `summary.json` with `passed`/`failed`/`skipped` (missing key = skip, never false-pass), hashing terminal bytes without persisting text. First run: 100% ID stability, discovery 5.28 ms median / 8.12 ms P95, 80-line capture 20.59/30.13 ms, 196,681 bytes hashed. Credentialed follow-up proved transport only: Grok TTS 83,712-byte MP3 (first byte 1,670 ms, total 2,801 ms), round trip 3,122 ms at 8.33% WER ("EV" → "Evie"), Opus/WebM transcribed in 1,132 ms vs MP3 664 ms.

**Trade-off accepted:** Slower visible product; voice transport choice (chained OpenRouter vs Grok S2S vs hybrid) stays open until the 7 build gates in `EXPERIMENT_PLAN.md` are met with the user's own corpus (≥30 STT utterances across noise/accent/jargon/interruptions, ≥20 short + ≥10 long TTS replies with blind listening).

### 6.4 Separate the learner's context from the executor's context entirely

**Alternative considered:** Answer "why?" inside the same agent session (follow-up in the doing thread), cheapest to build.

**Why a second window + second thread:** `WHY?` (`apps/web/app.js#openExplainer`, popup `/explain.html?pane=<id>`, pane-keyed `localStorage`) opens a read-only browser view whose daemon service (`createExplainer({store,codex,getPane})`) captures fresh evidence on every ask (`captureExplanationEvidence`: pane facts, project docs, Git branch/head/status/bounded patch, validation-signal heuristics, correlated ledger events, provenance/limitations, SHA-256 `revision`) and talks to a dedicated Codex app-server thread (`codex-app-server.mjs`: stdio JSON-RPC, `thread/start` with `sandbox: read-only` + `approvalPolicy: never`, `turn/start` with `networkAccess: false`, resume after restart, `-32601` rejection of server tool requests). At `36b5a3d` one question costs two turns (investigation brief, then JSON presentation compiler); at `aa40c9d` it collapses to one `formatMechanicsTurn`. Either way the browser gets only `publicEvidence()` (no full patch/tail/excerpts), feedback tunes only the explainer profile, and closing the popup changes nothing in the pane. Sessions/questions/answers/revisions persist as JSONL events and survive both browser and daemon restarts.

**Trade-off accepted:** Double model cost at `36b5a3d`, no token streaming to the browser, global (not per-user/project) learner profile, prototype-grade JSONL instead of SQLite WAL.

### 6.5 Make compactness a deterministic presentation operation, not a reasoning limit

**Alternative considered:** Instruct the model to "be concise, 3–5 steps" and render whatever it returns.

**Why local budgets:** The model is told not to sacrifice investigation depth; `normalizePresentation()` (inside `explainer.mjs` at `36b5a3d`, extracted to `presentation.mjs` v2 at `aa40c9d`) parses direct/fenced/salvaged JSON, sanitizes/dedupes step IDs, drops invalid scenario path references, defaults bad epistemic status to `unknown`, synthesizes fallback mechanism/scenario, and enforces answer ≤650 chars, ≤6 steps, ≤5 scenarios (v2 also ≤3 limitations/follow-ups, title 90, detail 480, input/output 220, evidence 280). Truncation is deterministic with ellipsis and disclosed in diagnostics. Vocabulary evolves here: `36b5a3d` SKILL + `EPISTEMIC_STATUS` are `observed|inferred|unknown`; `aa40c9d` adds `derived|predicted` (keeping `inferred` for compat) so adapter traces can say `route: predicted` honestly until route spans are instrumented. [Correction folded in from branch review: earlier summaries that described `36b5a3d` as single-turn or four-term are wrong; both corrections are recorded here.]

**Trade-off accepted:** A second normalization layer to maintain; model output that ignores the schema still renders, but only through the bounded fallback — verbosity can never break the UI.

### 6.6 Allow execution only through declared adapters, and say `missing adapter` otherwise

**Alternative considered:** A generic shell/command adapter so any capability can "run."

**Why narrow adapters:** `.ev/capabilities.json` declares exactly two capabilities (`explainer-presentation` → `presentation-pipeline` @ `in-memory-read-only`; `ev-loopback-api` → `loopback-http` @ `loopback-get-only`), each with pipeline, typed controls (select/range/boolean/text), and named scenarios including `stress`/`load` and deliberate `contract-failure`. `capability-spec.mjs` validates the manifest (≤30 caps/stages/scenarios, ≤20 controls, safe IDs, default→override→submitted precedence with coercion); `experiment-adapters.mjs` runs the real normalizer in-memory or real `GET`-only loopback fetches (`127.0.0.1`/`localhost`/IPv6 only, `/api/` prefix, 64 KiB cap, `AbortSignal.timeout`); `experiment-runner.mjs` (≤3 concurrent runs) persists `experiment.started/completed/failed` receipts and turns every failed assertion into a `proposed_not_applied` regression proposal. `runAcceptanceSuite` runs `normal → stress/load → contract-failure` so the 10/10 gates (`CAPABILITY_LAB_ACCEPTANCE.md`: goal, capability, mechanism, manipulation, execution, observation, comparison, envelope, reproduction, learning loop) are collective across receipts, never claimed from one run. Anything else returns 501 `missing_adapter` — the model never simulates a run.

**Trade-off accepted:** Adapter-level 10/10 explicitly does not certify browser layout, accessibility, or unsupported domains (auth, OCR, PDF, DB, browser, prod load); each needs its own purpose-built adapter + instrumentation.

### 6.7 Generalize probes into manifest + snapshot + runner (the worktree direction)

**Alternative considered:** Keep adding hard-coded capability IDs inside the daemon forever.

**Why the spike:** `tools/omp-capability-lab/lib/manifest.mjs` (schema v2: trace points, typed inputs incl. `file`, observers over `exit/stdout/stderr/http-status/http-json/file-text/file-json/trace-jsonl`, starters that seed inputs/questions/hypotheses but must not claim verdicts, budgets, evidence/manifest revisions with SHA-256 freshness), `snapshot.mjs` (disposable linked-worktree snapshots from `git ls-files -co`, symlink-safe copies, mutation detection, dependency-link disclosure), `runner.mjs` (sanitized `HOME`/`TMP`/`PATH`, `prlimit` caps, `command`/`http`/`manual-browser` adapters, bounded trace parsing, observer collection, redaction, load aggregation with saturation detection, cancellation), `feed.mjs` + `rpc-agent.mjs` (bounded redacted executor facts keyed by cwd+`TMUX_PANE`; JSONL RPC with v2 negotiation, restricted host tools: glob/search/read + `publish_explanation` + `propose_manifest`), `coordinator.mjs` + `extension.js` + `bin/omp-live.mjs` (loopback coordinator, fragment-token→HttpOnly cookie, separate browser/executor tokens, `--explain-only` linked-worktree guard, `xdg-open`), and `calibrate-explainer` skill (last-five-conversations only, independent profile/skill proposals, per-artifact SHA-256 + separate confirmations + atomic `0600` writes; ordinary chat never writes calibration). Reports state the honesty up front: bounded local processes are not a hostile-code sandbox.

**Trade-off accepted:** The spike duplicates the daemon lab's center while its edge stays OMP-specific; convergence (executor-agnostic core + thin harness pairing adapters) is designed but not yet merged. Carrying two labs is the cost of finding the harness-agnostic seam without breaking the running prototype.

### 6.8 Treat the hoverable visual map as the primary interface, not a diagram page

**Alternative considered:** A static architecture page with boxes for daemon/browser/orchestrator/voice.

**Why hover-to-explain:** The user's ask is explicit — not blocks, but a living surface where hovering any component summons an agent that already holds the codebase and explains that component's mechanics, evidence, and edge behavior. Concretely: fleet map (default) + terminal wall (drill-down) + task graph (causality) over one dataset; agent cards showing provider/model, step N/M, last meaningful event, confidence badge; hover expands to rationale + last tool + next step + diff/validation; attention inbox merges approvals/blocked/failed/voice-confirmations with risk/scope/expiry and one-click allow/deny; every node links to its evidence revision and runnable scenarios. ChatGPT desktop validates the grammar (hotkey summon, always-on-top companion, ephemeral per-message attachments with provenance, push-to-talk default, voice-in-chat with transcript as artifact); Granola/Wispr/Flow validate the restraint (narrow jobs, PTT, private-by-default, no silent Level-4 actions).

**Trade-off accepted:** The richest UI is also the most to keep honest — every hover answer must carry its evidence status and every spoken result must land as text, or the map becomes another fabricated dashboard.

## 7. How cross-compatibility works

### 7.1 Cross-harness (the orchestrator is harness-agnostic)

Daemon owns task/run truth; adapters own runtime mechanics. Priority: tmux observer (universal fallback, `process`/`heuristic` confidence) → tmux managed (argv-safe spawn/input) → Codex app-server (stdio/Unix socket, `structured`) → Claude ACP-first/hooks-second/process-last (`hook` confidence) → generic CLI → optional AoE HTTP API. Never depend on one manager's namespace. Status provenance travels with every card; low confidence is displayed, not hidden.

### 7.2 Cross-model (the voice is model-agnostic)

Default: chained OpenRouter STT → companion/orchestrator → TTS (explicit transcripts feed envelopes + audit; each stage replaceable; policy gates between stages; whisper-class STT ~$0.006/min, token-billed transcribers higher, TTS per-char). Experiment: Grok S2S over `wss://api.x.ai/v1/realtime` with ephemeral browser tokens (sub-second first audio, natural barge-in/VAD, $0.08/min audio + text-input on `think-fast-2.0`). Benchmark only: OpenAI Realtime (`gpt-realtime-2.1`, $32/$64 per 1M audio in/out) — transport, never the brain. Consumer ChatGPT voice itself is not an embeddable API.

### 7.3 Cross-environment (local-first, remote later)

`127.0.0.1` bind, no auth, JSONL ledger today; SQLite WAL + migrations, `systemd --user` supervision, snapshot-then-delta WebSockets, Tailscale-or-reverse-proxy remote with strong auth/session-expiry/CSRF later. Daemon restart reconciles first; never kills unknown panes because persisted state disagrees. Panic control interrupts only EV-managed runtimes.

## 8. End-to-end data flow

### 8.1 Before (speak or click)

Push-to-talk (or `Option+Space`-style summon in the future desktop shell). Utterance carries a frozen context snapshot (`utteranceId`, exact transcript, focused project/task/runtime, selected pane IDs, mode, `capturedAt`) so "this pane" cannot resolve against a selection that changed mid-transcription. Companion classifies: conversation/query answered read-only aloud; reasoning/action/control frozen into a delegation envelope with idempotency key.

### 8.2 During (orchestrate, with evidence)

Orchestrator receives → classifies → clarifies only material unknowns → plans (tasks, deps, criteria, budgets, verifiers) → policy authorizes (observe auto; managed work after explicit request; elevated/external explicit, some non-voice-only) → scheduler launches via adapters (worktree-per-editing-run, file reservations, concurrency caps, timeouts) → events project to fleet/task views → attention rules surface questions/stalls/errors/conflicts → verifier (tests/static/diff/separate reviewer, never "ask the implementer if it worked") → task receipt persisted → companion speaks the short verified result.

### 8.3 After (understand, prove, learn)

`WHY?` → fresh evidence + revision → isolated thread → bounded presentation → selectable causal path → Capability Lab: vary controls, pick normal/edge/load/contract-failure, run real adapter, read trace/assertions/comparison/latency/cost, keep the immutable receipt, convert the deliberate failure into a regression proposal. Calendar the corpus work: real-voice WER/intent, P50/P95 first-audio and end-to-end, interruption, disconnect/stale-context/mic-denial UX, monthly cost from observed minutes/chars/tokens/retries.

### 8.4 What's worth noticing

The same envelope shape appears at every layer: voice utterance, delegation, task, run, experiment receipt — all carry identity, frozen inputs, evidence revision, and provenance. That repetition is the design: any claim in the UI can be walked back to the exact snapshot that produced it. And the one question the system refuses to answer with prose — "what happens if I run it?" — is always answered with a receipt or an explicit `missing adapter`.

## 9. How the author/user stays in control

Opt-in vs required: observation is automatic; adoption of an unmanaged pane, managed spawn, and any elevated/external action require explicit request or confirmation. Owned by caller vs framework: daemon owns side effects and truth; orchestrator owns planning; adapters own mechanics; companion owns conversation and nothing else. Narrowly constrained: literal `-l` text vs allow-listed keys, argv arrays with validated absolute cwd, loopback-only GET, in-memory-only presentation runs, bounded iterations/concurrency/bytes/timeouts server-side. Voice can propose, read risk, and narrate; only visible cards (and never ambiguous utterances alone) dispose high-risk actions. Barge-in stops speech, never agents, unless "cancel/interrupt" names a resolved target.

## 10. Maintaining the system without restricting future work

What the design enforces: read-only companion gateway; exact authority equality before any run; `missing_adapter` instead of simulation; deterministic budgets; redaction + bounded capture; JSONL-first persistence with revision hashing; worktree-per-run isolation in the generic runner.

What requires discipline: label every new status with source + confidence; add a structured adapter before trusting a new agent family; never compute progress from terminal activity; keep starters hypothesis-only (no pre-claimed verdicts); keep calibration separately confirmed and hash-checked.

Review checklist: does this change add a tool without a gateway entry? a run without an adapter? a claim without an evidence status? a percent without a plan? a voice action without a frozen context + confirmation tier? a probe without a manifest revision? If yes, it does not ship.

When in doubt, default to the observable boundary: show the bytes, narrate the obligation, prove the run, keep the receipt.

## 11. Key insights

### 11.1 Terminal bytes are not agent state

`capture-pane` sees output; only protocols (Codex turns, Claude hooks/ACP) or explicit plans/checkpoints know working vs blocked vs done. **Lesson:** split `structured`/`hook` from `process`/`heuristic` everywhere, or the wall lies.

### 11.2 The envelope is the product

Utterance ID → delegation → task → run → receipt is one repeated shape with frozen context + provenance. **Lesson:** idempotency and traceability are not features; they are the object being built.

### 11.3 Density belongs in the compiler, not the model

Unbounded investigation plus deterministic local budgets (650/6/5/3/3) beats "please be concise" every time. **Lesson:** let the model think, then compile selectably.

### 11.4 A failed assertion is a successful experiment

The deliberate `contract-failure` scenario exists to prove the learning loop; its receipt (`failed`, `proposed_not_applied`) is the most valuable artifact in the suite. **Lesson:** design the failure path first, or the lab can only ever say "pass."

### 11.5 Transport is not the brain

Realtime/S2S/STT/TTS move audio; the SDK/session/ledger/policy/tools do everything else (memory, handoffs, guardrails, budgets, audit, rehydration). Consumer voice UIs are not APIs. **Lesson:** buy or borrow the mouth and ears; build the conscience.

### 11.6 Ambient must be earned, never assumed

ChatGPT desktop, Wispr, Granola converge: push-to-summon, ephemeral declared snapshots, PTT default, one-convo-at-a-time, visible listening state, narrow allowlists, interrupt budget ~2–4/day, activity log one tap away. **Lesson:** start at passive-summary/drafted-approval (Level 2/3); silent autonomy (Level 4) is a trust balance that must stay positive, not a launch flag.

### 11.7 Honest `unknown` is a feature

`observed`/`derived`/`predicted`/`unknown` (and the `36b5a3d` predecessor `observed`/`inferred`/`unknown`) keep scenario cards from becoming fake demos and keep route internals `predicted` until instrumented. **Lesson:** the vocabulary of uncertainty is load-bearing UI, not documentation garnish.

## 12. What this leaves open

- Voice transport selection (chained vs duplex vs hybrid) pending the user's own corpus + latency/cost distributions — explicitly not decided here.
- Full VT emulation (xterm.js + control-mode streaming), alternate-screen/mouse/color fidelity, per-pane error surfacing.
- Structured Claude adapter (ACP first, hooks second), AoE-as-adapter spike verdict, NTM/remote/container adapters.
- SQLite WAL migration, projection cursors/snapshots, `systemd --user` supervision, snapshot-then-delta sockets.
- Desktop shell (global hotkey, always-on-top companion, Appshot-style snapshots, folder grants) and mobile/PWA + push for completions.
- Barge-in semantics, disconnect/reconnect rehydration, session rollover past 60-min ceilings, audio-loop cost budgeting.
- Merging the daemon lab and the OMP-spike generic core into one executor-agnostic runner + thin pairing adapters.
- None of these are blockers to the current prototype's claims; each has a named next experiment or spike.

## 13. How to read this alongside the specs

Reviewers: §3 → §5 → §6 (causal chain) → §11, then `EXPERIMENT_PLAN.md` gates and `CAPABILITY_LAB_ACCEPTANCE.md` 10/10. Implementers: §8 flow → `PROTOTYPE.md` endpoints → `EXPLANATION_WINDOW.md` evidence/thread contracts → `.ev/capabilities.json` + `tools/omp-capability-lab/lib/manifest.mjs` for probe authoring. Voice work: §7.2 + `lab/lib/providers/*` + the Desktop/Ecosystem research reports. Visual work: §6.8 + the blueprint HTML companion (`docs/EV_BLUEPRINT.html`), which renders this rationale as hoverable drafting sheets: problem ledger, insight, layered stack, swim-lane flow, compatibility matrix, file anatomy, edge cards, risk cards, decision cards, rollout timeline, footprint.
