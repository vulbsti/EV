# EV pre-build experiment plan

Date: 2026-08-11  
Status: executable baseline; local experiments run without provider credentials, live voice measurements pending keys and labelled audio

## Why this lab comes before the product

The highest-risk questions are not whether a dashboard can be drawn. They are whether arbitrary terminal activity can be observed reliably, whether a conversational voice layer can remain genuinely read-only, whether delegation is exact and understandable, and whether voice latency, transcription accuracy, interruption behavior, and cost are acceptable in real use.

The lab therefore tests contracts, transports, and failure modes independently. It produces JSONL rather than conclusions hidden in chat. A full UI or orchestrator should not be selected until these measurements exist.

## Refined architecture under test

```text
Browser microphone
  |
  +-- chained candidate: OpenRouter STT -> transcript
  |
  +-- duplex candidate: xAI Grok Voice -> transcript/events/audio
  |
  v
Read-only conversation companion
  |-- casual conversation -> companion response
  |-- fleet/task/web query -> read-only tools -> companion response
  `-- deeper reasoning, mutation, or control
         -> immutable delegation envelope
         -> durable orchestrator
         -> policy / approval / agent execution
         -> correlated result with provenance
  |
  v
OpenRouter TTS or selected duplex provider -> browser speaker
```

This separation is an authority boundary, not merely a prompt. The companion runtime is only issued read capabilities. Its mutating tool names are denied even if a model attempts to call them. The orchestrator owns reasoning that can affect work and all state-changing actions.

## Evidence contract

Every automated experiment appends one record to `results.jsonl` with:

- schema and run IDs, experiment and group IDs, mode, timestamps, duration, and status;
- provider and exact model when applicable;
- raw measurements and declared gates;
- observations needed to reproduce the conclusion;
- artifact paths and a redacted error when applicable.

Statuses are `passed`, `failed`, or `skipped`. A missing key is a skip, never a false pass. Runner-level `summary.json` records the host, Node version, credential presence as booleans, and outcome counts. Raw pane contents and credentials are excluded by default.

## Experiment matrix

| ID | Question | Measurements | Initial gate | Mode |
| --- | --- | --- | --- | --- |
| `tmux-observation` | Can EV discover arbitrary panes quickly and capture useful tails without mutation? | sessions/panes, discovery median/P95, capture median/P95, stable pane IDs, bytes | ≥99% ID stability over samples; no raw content stored | local |
| `companion-policy` | Does the companion route requests correctly and lack mutation authority? | labelled routing accuracy, allowed/denied tool matrix, mutation leaks | 100% fixture accuracy; zero mutation leaks | local |
| `delegation-contract` | Can speech intent cross to the orchestrator exactly once with context and provenance? | transcript equality, frozen UI context, dedupe, result correlation | all contract checks pass | local |
| `resilience` | Are retry and cancellation bounded and visible? | attempts, recovery, AbortSignal behavior | retry bounded; cancellation observed | local/mock |
| `openrouter-discovery` | Which STT/TTS models actually exist now and what metadata/prices do they report? | model IDs, architectures, prices, request latency | at least one candidate per modality | network |
| `openrouter-stt` | Is transcription accurate enough on our terms and accents? | latency, input bytes, transcript, provider usage, WER | collect ≥30 labelled utterances before setting a threshold | live |
| `openrouter-tts` | Is reply synthesis fast and natural enough? | first response byte, total latency, bytes, media type, cost metadata | collect ≥20 short and ≥10 long replies; blind-listen comparison | live |
| `openrouter-roundtrip` | Does the complete chained transport preserve text within an acceptable delay? | TTS first byte/total, STT latency, end-to-end latency, WER | establish distributions over repeated phrases before integration | live |
| `xai-realtime` | Does Grok Voice work through ephemeral browser-safe credentials and its documented event protocol? | token latency, socket/response latency, first audio, bytes, event types, transcript | returned audio plus complete response event | live |
| browser audio probe | Does the target browser/microphone behave predictably? | permission latency, actual sample rate, constraints, RMS level, chunk jitter, bytes | test each real browser/headset combination | manual |
| `cost-model` | What is knowable without inventing comparisons? | xAI minute scenarios and explicit unknowns | no synthetic GPT/OpenRouter per-minute number | local |

## Voice corpus to collect

One clean sample is not enough. Collect at least 30 labelled utterances per serious STT candidate across:

- quiet room, keyboard noise, fan noise, and speech from the side;
- short commands, project names, paths, pane IDs, technical jargon, and long explanations;
- natural Indian English plus any other expected accents;
- false starts, corrections, pauses, and interruption phrases;
- high-risk controls such as stop, delete, approve, deploy, and “do not execute.”

Each sample needs a verbatim reference transcript, speaker/environment tag, recording-device tag, browser metrics JSON, and the original audio. Score word error rate and, separately, intent accuracy. A transcript can have a low WER but reverse a crucial negation; high-risk intent errors must be reviewed manually.

## Parallel execution without contaminating results

`run-lab.mjs` runs independent experiments with a bounded worker pool (default four). Provider experiments do not depend on tmux experiments. The OpenRouter STT and TTS probes are separate so either can be evaluated or replaced. Do not parallelize repeated latency calls so aggressively that rate limits become the thing being measured; use parallelism across feature groups, then serial repetitions inside a provider benchmark.

Examples:

```bash
npm run lab:quick
node scripts/run-lab.mjs --mode live --concurrency 3 \
  --experiments openrouter-discovery,openrouter-tts,xai-realtime \
  --config lab/config.local.json
```

## Decision gates before building the integrated product

Proceed from experiments to a walking skeleton only when:

1. terminal discovery and observation survive pane churn, full-screen apps, alternate screens, worktrees, and pane exits;
2. mutation attempts from the companion are blocked at the capability layer in every test;
3. duplicate transcripts cannot produce duplicate actions, and every spoken result can be traced to an orchestrator task/result;
4. real STT accuracy and intent-confusion data exist for the user's voice and environment;
5. first-audio, end-to-end, and interruption latency are measured at median and P95 over repeated runs;
6. the monthly cost model uses observed minutes, characters, tokens, retries, and provider-reported usage;
7. disconnect, timeout, stale-context, microphone denial, and orchestrator-unavailable behavior are understandable to the user.

Choose the transport after these gates. Likely outcomes are not limited to one provider: a chained OpenRouter path may win for control and replaceability, while Grok Voice may win for conversational latency. The companion/orchestrator boundary remains the same in either case.

## Current provider facts to verify during live testing

- xAI currently documents `grok-voice-think-fast-1.0` at $0.05/audio minute and `grok-voice-think-fast-2.0` at $0.08/audio minute, plus text-input charges. It documents REST STT at $0.10/hour, streaming STT at $0.20/hour, and TTS at $15/million characters. Pin the tested model because `grok-voice-latest` can move.
- xAI documents browser-safe ephemeral tokens and an OpenAI-Realtime-compatible WebSocket flow. Compatibility must still be proven event by event; the lab records every event type it sees.
- OpenRouter documents dedicated OpenAI-compatible STT and TTS endpoints and a models API. The suite discovers current candidates rather than treating an example slug as permanent.
- OpenAI's current `gpt-realtime-2.1` page lists separate text and audio token prices. A fair per-minute comparison requires observed token use, so this lab refuses to manufacture one.

Sources: [xAI pricing](https://docs.x.ai/developers/pricing#voice-api-pricing), [xAI speech-to-speech](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech), [xAI ephemeral tokens](https://docs.x.ai/developers/model-capabilities/audio/ephemeral-tokens), [OpenRouter STT](https://openrouter.ai/docs/guides/overview/multimodal/stt), [OpenRouter TTS](https://openrouter.ai/docs/guides/overview/multimodal/tts), and [OpenAI GPT Realtime 2.1](https://developers.openai.com/api/docs/models/gpt-realtime-2.1).

## Known gaps in this first suite

- The xAI automated probe currently sends text and validates response audio/events. A PCM microphone round trip and barge-in test should be added after the basic live handshake succeeds.
- Listening-quality scoring is necessarily human; the browser probe collects material but does not pretend to judge naturalness.
- The current delegation classifier is a deterministic contract fixture, not a final natural-language router. Its purpose is to prove authority behavior and establish labelled cases.
- tmux observation currently samples inventory and pane-tail metadata. Control-mode event-loss and high-churn soak tests are the next terminal experiments.
- No provider claim is counted as working until the live result record passes with the exact model and date.

## Initial run results

The first local parallel run on 2026-08-11 passed all five credential-free experiments. It observed 3 tmux sessions and 16 panes; stable pane IDs remained at 100% across three samples. Fleet discovery was 5.28 ms median and 8.12 ms P95. Capturing metadata for 80 tail lines across every pane was 20.59 ms median and 30.13 ms P95. The experiment hashed 196,681 captured bytes but persisted none of the terminal text.

The companion policy, delegation contract, retry/cancellation, and conservative cost-model experiments passed. The five unit tests also passed.

A live-mode discovery run reached OpenRouter's public models API without credentials and found 14 current transcription candidates and 19 current speech-output candidates. Among them were `x-ai/grok-stt-1.0`, `openai/whisper-1`, `deepgram/nova-3`, `x-ai/grok-voice-tts-1.0`, `hexgrad/kokoro-82m`, and `google/gemini-3.1-flash-tts-preview`. This proves discovery only—not quality, availability to the account, voice selection, or a successful billable inference.

In the initial run, the OpenRouter STT, TTS, round-trip, and xAI Realtime inference probes correctly skipped because no `OPENROUTER_API_KEY` or `XAI_API_KEY` was present. OpenRouter was subsequently tested as recorded below; xAI Realtime remains intentionally deferred. Evidence is stored under `artifacts/lab/` and can be summarized with `npm run lab:summarize`.

### OpenRouter credentialed follow-up

After the repository `.env` became available, a credentialed run used `x-ai/grok-voice-tts-1.0` with the `eve` voice and `x-ai/grok-stt-1.0`. TTS returned a valid 5.232-second MP3: first response byte arrived in 1,670 ms and the complete 83,712-byte file arrived in 2,801 ms.

The chained round trip synthesized a 4.968-second, 79,488-byte MP3 and transcribed it. TTS took 2,430 ms, STT took 692 ms, and the complete sequential round trip took 3,122 ms. The reference began “EV can observe agents”; STT returned “Evie can observe agents,” with the remainder correct. That is one word substitution over twelve reference words, or 8.33% WER. OpenRouter reported the STT portion as 4.968 seconds and $0.000138. This single synthetic-voice sample proves transport compatibility, not expected human-voice accuracy.

The prototype endpoint was also tested with Opus/WebM—the exact format emitted by its browser recorder. Grok STT correctly returned “EV mission control voice output is connected.” from a 30,462-byte, 3.096-second file in 1,132 ms. A separate MP3 request returned the same transcript in 664 ms and reported $0.000086 STT cost.
