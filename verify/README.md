# Verify: does EV behave the way we intend?

EV is being rebuilt in steps (one store, a queue per conversation, search and tools, outside sessions, resumable work, memory over time). This folder states, for each step, what a person should be able to notice when it is done, and checks it. A model working on a step runs the checks, reads what fails, changes EV, and runs them again until they hold.

```bash
npm run verify                  # everything, about 20 seconds, no key, no network
npm run verify -- --task 4      # one step's checks
npm run verify -- Q-02 S-01     # named checks
npm run verify -- --accept      # record today's result as the baseline
```

[BEHAVIOURS.md](BEHAVIOURS.md) is the readable list: the goal of each step and every expected behaviour, marked with whether it holds today. It is generated from the checks, so it cannot drift from them.

## Two layers

| | `npm run verify` | `npm run qa`, `npm run qa:arc` |
|---|---|---|
| Model | Scripted stand-in | Real model |
| Answers | Does the plumbing do the right thing once the model has decided? | Does a real model decide well, given that plumbing? |
| Speed | Seconds, the same result every run | Minutes, graded by judgement |
| Used | After every change | Before calling a step done |

Each group of checks ends with `live:` lines naming the QA scenarios that cover the part only a real model can show. Levels 8 and 9 in `qa/scenarios/` were written for this plan.

## Judgement, not rules

EV is meant to understand what the person means, so almost nothing it does may be a fixed flow. "Stop" can mean one task out of three, a pause, a change of direction, or nothing to do with the work. A request can be new work, or belong in old work that already has the context. A check that said "stop stops the work" would pass on a system built the wrong way. So every line here is one of three kinds:

- **A guarantee**: true whatever EV decides. Nothing is lost, forgotten means gone, a restart changes nothing, only finished work reaches the person. These are the only things the code is allowed to fix.
- **An option**: something EV is able to do once it has judged what the person means. The check plays EV's decision with the scripted model and verifies that exactly that happens and nothing else. Where it matters the check is a contrast: the same message is read two ways and must lead to two outcomes, which a rule keyed on the words cannot do (D-01 to D-05).
- **Judgement**: whether EV picks the right option. Only a real model can show that, so it lives in the QA suite as pairs (level 9): nearly the same words in two situations where the right action differs. A pair counts only when both halves pass.

When a behaviour turns out to depend on what the person meant, it is not a guarantee: write it as an option here and as a pair there.

## Reading the result

```
Task 4  One conversation, one thing at a time  3/7
  ✓ Q-02  Two messages sent in quick succession are handled in order: ...
  ✗ Q-01  A message is saved the moment it arrives, before EV has decided anything about it.
        The message was not in the conversation while EV was still deciding
  ○ T-01  EV1 can search everything EV holds before it answers.
        not built: EV1 has no "search" tool yet
```

- ✓ holds.
- ✗ fails: EV has the feature but the behaviour is wrong. The line under it says what a person would have seen.
- ○ not built: EV lacks the capability the check needs (a tool, a route). It turns into ✓ or ✗ by itself once the capability exists.
- · open: no check can be written until a decision is made. The line says which.

The exit code is 0 unless something that held in `baseline.json` no longer holds, or a check itself broke. So a half-finished step does not fail the run, and a regression always does. `--strict` fails on anything that is not ✓.

## Working on a step

1. Read the step's goal and behaviours in BEHAVIOURS.md.
2. `npm run verify -- --task N` and pick a failing line.
3. `npm run verify -- X-00 --verbose` shows EV's own log for that check; `--keep` leaves its data directory behind to look at.
4. Change EV. Run the step's checks again, then the whole suite once.
5. When more lines hold than before, `npm run verify -- --accept` and commit the new baseline and BEHAVIOURS.md with the change.
6. Run the `live:` scenarios with a real model before calling the step done.

Do not change a check to make it pass. A check changes only when the intended behaviour changes, and that is the person's call. If EV's wire format changes (a prompt layout, a tool name), change `lib/protocol.mjs`, not the checks.

## How it works

Every check starts its own EV: a temporary data directory, a temporary home, a free port. It talks to EV only over the HTTP API, the way the page does, and imports none of EV's code, so the checks survive the rebuild.

- **Stand-in model** (`lib/stand-in.mjs`). `EV_MODEL_URL` points EV's model calls at a local server. A check scripts each role (EV1, reviewer, learner) with a plain function: "EV1 searches for this, then replies with what it found". EV1 is scripted as tool calls (in the Anthropic Messages, Chat Completions and Responses shapes); the reviewer and the learner answer with one JSON object per call. It answers every model call as a server-sent event stream, the way a real provider does (EV's model layer, pi-ai, always asks for one). With only `EV_MODEL_URL` set, EV keeps the API shape its default model has in pi-ai's catalogue. If a script asks for something EV does not offer yet, the check reports "not built".
- **Stand-in agents** (`lib/bin/openclaw`, `lib/stub-worker.mjs`). An `openclaw` earlier on the `PATH` asks the stand-in what the agent should do: write files, report, ask a question, burn tokens, hang, crash. It writes the transcript where EV reads it.
- **`lib/protocol.mjs`** is the only file that knows what EV's prompts, tool calls and reports look like.
- **`lib/ev.mjs`** starts, crashes and restarts EV and reads what the person could see: the conversation, the work, the memory page, the files on disk.
- **`lib/browser.mjs`** opens the real page for the two checks about what is on screen.
- **`lib/self-test.mjs`** runs first and proves the stand-in's tool-calling side in all three shapes with a minimal loop over EV's own model layer (`modelTurn` in `apps/daemon/lib/ev-model.mjs`), so a "not built" is never the harness's own fault.

## What the checks assume about work not built yet

A check has to name something. These names are the smallest contract; if the build picks different ones, change them in `lib/protocol.mjs` or `lib/ev.mjs` in the same change.

| Thing | Assumed |
|---|---|
| EV1's tools | `search{query}`, `read{id}`, `reply{text}`, `ask{questions, assumptions}`, `start_work{title, request}`, `message_task{task, text, stop}`, `remember{text, quote}`, `forget{ids}` |
| Reviewer's tool | `read_file{path}` |
| Learner's judgement | A `confirm` with `rely: true` and a `reason` says a guess can now be relied on. A plain `confirm` only adds evidence |
| Import | `POST /api/assistant/import {source, path}` |
| Timeline | `GET /api/assistant/timeline` gives `{lines: [{text, events}]}`, oldest first, each line listing the events it summarises |
| Search for the page | `GET /api/assistant/search?q=` gives `{hits}` |
| Stalled agent | `EV_WORKER_STALL_MS` sets how long without progress counts as stuck |
| Page | Marks "EV is thinking" with `aria-busy="true"` |

Settings EV already has that the harness relies on: `EV_MODEL_URL`, `EV_DATA_DIR`, `EV_API_TOKEN`, `EV_OPENCLAW_SANDBOX=host`, `EV_REVIEW_HOLD_MS`, `EV_AGENT_TOKEN_BUDGET`, and finding `openclaw` on the `PATH`.

## Adding a check

Add an entry to the step's file in `checks/`:

```js
{
  id: "Q-08",
  expect: "One sentence a person could confirm by using EV.",
  async run({ start, assert }) {
    const ev = await start({ script: { ev: (turn) => turn.reply("hello") } });
    const { reply } = await ev.say("hi");
    assert.equal(reply, "hello", "What the person saw instead");
  }
}
```

Keep to behaviour a person would notice. Do not assert on table names, function names or prompt wording. Do not write a check that ties particular words to a particular action: script what EV decides, and where the words could be read another way, script that reading too.

## What this cannot tell you

- Whether a real model's judgement is good: that is `npm run qa` and `npm run qa:arc`.
- Whether real OpenClaw and Docker behave: the agents here are stand-ins. One real task on the test server covers that.
- Anything about reaching the person when the tab is closed, until the channel is chosen (N-01, N-02).
