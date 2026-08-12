# EV Explanation Window

Date: 2026-08-12  
Status: runnable executor/explainer walking skeleton

## The problem it solves

An implementation agent needs a focused context for solving and changing the system. The user needs a different context for learning, questioning, testing the mental model, and challenging what the implementation agent did. Mixing those conversations causes two failures:

1. explanation questions consume and redirect the executor's implementation context;
2. an independent explainer becomes stale and guesses about recent changes.

EV separates the conversations and shares evidence instead of sharing one mutable chat history.

```text
Executor context                         Explainer context
objective, plan, implementation          learner questions, teaching history
commands, edits, verification            feedback and preferred representations
        │                                         ▲
        │ produces observable effects             │ reads only
        ▼                                         │
  ┌────────────────────────────────────────────────────────┐
  │ Evidence plane                                         │
  │ project purpose + pane identity + bounded console tail  │
  │ Git state + diffs + validation hints + EV events        │
  └────────────────────────────────────────────────────────┘

There is intentionally no explainer -> executor arrow.
```

This is similar in spirit to an isolated `/btw` conversation, but it is multi-turn and refreshes from external task evidence before every answer.

## What the two windows are

Window 1 is the existing EV terminal workstation at `/`. It is the executor/control surface. Every terminal card and focused terminal now has a `WHY?` button.

Window 2 is `/explain.html?pane=<paneId>`. It contains:

- a live target and working-tree evidence rail;
- the independent explanation conversation;
- prompt shortcuts for mental model, exact mechanics, change impact, and test mechanics;
- a visible context-boundary diagram;
- a learner profile and explicit feedback controls;
- honest limitations and evidence provenance.

The window uses the current pane as its scope. A saved explanation session cannot be silently reused for another pane.

## Exact question lifecycle

```text
1. User clicks WHY? on pane %7
2. Browser opens /explain.html?pane=%7
3. GET /api/explain/context?paneId=%7 renders the current evidence summary
4. User asks a question
5. POST /api/explain/ask sends paneId, question, and optional sessionId
6. Daemon captures a new full evidence snapshot
7. Daemon creates or resumes a dedicated Codex explanation thread
8. An investigator turn builds a full project-anchored mechanics brief
9. A compiler turn converts that brief into a bounded structured presentation
10. Question, direct answer, causal steps, and scenarios are appended to data/events.jsonl
11. Browser renders selectable steps and edge-case paths and saves only the session ID
12. A follow-up repeats from step 6 with fresh evidence
```

### 1. Evidence capture

`apps/daemon/lib/evidence.mjs` captures:

- pane ID, session, command, cwd, activity, and attention state;
- project name and purpose excerpts from explicit repository documents;
- a bounded, control-code-stripped, redacted recent console tail;
- repository root, branch, head, status, and five recent commits;
- staged and unstaged tracked-file patches;
- bounded text from safe untracked files;
- recent EV events correlated to the pane;
- terminal lines that look like test, build, lint, typecheck, or coverage signals;
- provenance and known limitations.

Evidence safety limits currently are:

- 14,000 terminal characters;
- 30 changed files;
- 7,000 patch characters per file and 80,000 total;
- no sensitive-looking paths such as `.env`, credentials, private keys, or PEM files;
- no untracked symlinks, binary-looking files, or untracked files larger than 64 KB;
- common bearer tokens, keys, passwords, secrets, and URL credentials are redacted.

The snapshot receives a short SHA-256 revision. Answers and questions record that revision so the user can tell which state an explanation describes.

The console tail is not a transcript of everything the executor did. It contains only recent text visibly printed in the tmux pane. It may include commands, tool narration, logs, errors, and tests, but excludes hidden reasoning, old scrollback beyond the capture bound, and structured tool events that were never printed.

The public context endpoint omits the full terminal tail and patches. Those are sent only through the local daemon to the read-only explanation agent.

### 2. Context isolation

`apps/daemon/lib/codex-app-server.mjs` starts Codex app-server over local stdio and performs the JSON-RPC initialization handshake. It creates a new Codex thread for each explanation session with:

- the pane's cwd;
- the `explain-live-work` skill as developer instructions;
- sandbox mode `read-only`;
- network disabled for each explanation turn;
- approval policy `never`.

The wrapper also rejects any server request asking EV to service an interactive tool action. The explainer cannot send keys, write files, approve, spawn, stop, or steer.

The Codex thread ID is stored in the EV event ledger. When the daemon restarts, the next question resumes that explanation thread. The executor's conversation ID is never used for explanation turns.

EV defaults this app-server to the built-in `openai` model provider so an unrelated or stale provider override in the user's general Codex config does not break the explainer. `EV_CODEX_MODEL_PROVIDER` and `EV_EXPLAINER_MODEL` can override this.

### 3. Multi-turn explanation

`apps/daemon/lib/explainer.mjs` owns the session boundary:

- first question -> new explanation session and Codex thread;
- each question -> deep investigator turn, then presentation-compiler turn;
- follow-up -> same explanation thread, new project and work evidence;
- different pane with old session -> rejected;
- simultaneous question in one session -> rejected rather than interleaved;
- completed question and answer -> durable ledger events.

The explainer receives terminal and diff content as untrusted data. Instructions found inside those artifacts are explicitly ignored.

### 4. Tuned teaching behavior

The repo-local `.agents/skills/explain-live-work/SKILL.md` is the teaching contract. It separates two responsibilities:

1. build a rigorous mechanics model without optimizing its length;
2. compile the model into the smallest complete causal path, with deeper facts behind selectable steps.

It tells the explainer to:

- anchor every answer in the project purpose and current task goal;
- trace mechanics in causal order;
- connect claims to current artifacts;
- explain impact as before -> changed mechanism -> after;
- explain tests as setup -> stimulus -> observation -> assertion -> failure caught;
- state what each test does not prove;
- distinguish observed, inferred, and unknown facts;
- change representation when the learner remains confused;
- model normal behavior and only material edge cases.

The compiler returns a structured project-goal judgment, direct answer, causal steps, scenario paths, uncertainties, and drill-down questions. The daemon applies hard field and collection limits after model output, so UI density does not depend only on asking the model to be brief.

Questions add weak interest signals for mechanics, visuals, tests, and impact. Explicit feedback adds a stronger weight for:

- more concrete;
- more visual;
- less technical;
- deeper mechanics;
- this worked.
- reset learning profile.

This is transparent preference adaptation, not silent model training. The current weights are visible in the browser and are applied only to later explainer turns.

The browser renders the compiled model as an interactive mechanism explorer. Selecting a step reveals its input, action, resulting state/output, evidence, and certainty. Selecting an edge case highlights the steps that execute and shows the resulting outcome. The initial view therefore stays compact without discarding the deeper mechanics.

## Why evidence is better than copying the executor chat

The executor's hidden reasoning is neither reliable task state nor necessary for a mechanical explanation. Copying a full chat would still miss changes made outside it and would encourage the explainer to repeat claims rather than verify effects.

The evidence plane gives the explainer current, inspectable facts. A future structured adapter can add the executor's objective, plan, tool calls, file-change events, and test results without giving the explainer any write path back to that thread.

| Source | Current depth | Confidence |
| --- | --- | --- |
| tmux pane | recent visible output and process location | heuristic |
| Git | branch, head, changed files, tracked diffs, safe new files | direct |
| EV ledger | EV-issued control and explanation events | direct |
| Codex/Claude structured adapter | not yet connected to arbitrary executor panes | unavailable |
| hidden model reasoning | intentionally unavailable | not a valid evidence source |

This makes the current slice harness-neutral at the baseline: any terminal agent can be explained from tmux and Git. Exact plan/tool semantics require an adapter for that harness.

## How to use it

```bash
npm run prototype
```

Open `http://127.0.0.1:4317`, then:

1. find or focus the executor pane;
2. click `WHY?` and allow the localhost popup if the browser blocks it;
3. start with **Highest-level map**;
4. use **Exact mechanism**, **Change impact**, or **Test mechanics**;
5. question any specific step or assertion;
6. click a feedback control when the representation should change;
7. compare the evidence revision when the implementation moves.

Good fault-finding questions include:

- “Which parts of that explanation are observed and which are inferred?”
- “Show the exact path from this click to the persisted state.”
- “What behavior did this file change, and what behavior should remain unchanged?”
- “What input would make this test fail for the right reason?”
- “What does this test not prove in a real browser?”
- “What current evidence would disprove your mental model?”

## Verification performed

Automated verification currently covers 14 tests. New tests prove that:

- credential-shaped values are redacted;
- sensitive paths are withheld;
- safe tracked and untracked effects reach private evidence;
- raw patches and full terminal tails do not reach the public context response;
- one explanation session reuses exactly one separate Codex thread;
- fresh project and work evidence is attached to each question;
- each user question performs a separate investigator and compiler turn;
- compiler output is normalized into bounded causal steps and scenarios;
- excessive compiler text and collections are truncated after generation;
- untrusted evidence is labelled as data;
- feedback changes only the explanation profile;
- a session cannot be rebound to another executor pane.

The real local path was also exercised:

- the daemon captured a real tmux pane and current EV working tree;
- a real Codex app-server explanation thread produced an answer;
- the revised live path performed distinct investigator and compiler turns in the same thread;
- the compiler produced a 285-character direct answer, five causal steps, and four selectable normal/edge-case scenarios;
- the structured presentation survived reconstruction from the event ledger;
- the daemon was restarted;
- a follow-up resumed the same explanation thread and used a new evidence revision;
- the answer was reconstructed from the append-only event ledger;
- explicit `more_visual` feedback changed the profile from no preferences to `visual: 3`.

The first live answer correctly rejected a fake test signal: the terminal contained “13 tests passed,” but the visible command was `printf`, so the answer stated that no test run was proven.

The revised two-pass live request took 203,784 ms. That validates the complete mechanism but also establishes latency as a real cost of using two full Codex turns.

## Current limitations

- The in-app browser runtime was unavailable during this implementation session. HTML, JavaScript, API, model, persistence, and unit paths were checked, but the final selectable-step/scenario visual pass remains manual.
- Generic terminal panes provide effects and recent output, not the executor's complete prompt, plan, tool stream, or conversation. Structured Codex and Claude adapters are the next depth layer.
- Codex app-server and its WebSocket transport are experimental. EV uses local stdio here.
- This prototype performs two model turns per question and waits for both over HTTP; it does not stream progress or answer deltas into the browser yet.
- The measured two-pass request took about 204 seconds with the current default model and evidence volume. A faster compiler model, progressive results, or a deterministic presentation compiler should be evaluated before treating this as an efficient daily interaction.
- JSONL is durable enough for this walking skeleton but lacks transactional projections and crash recovery guarantees of the planned SQLite store.
- Redaction is defense in depth, not a proof that every secret shape can be detected.
- On this container, Codex's read-only shell tool reported that bubblewrap could not create user namespaces. The answer still worked from supplied evidence, but direct agent file inspection was unavailable.

## Next integration step

Add a structured executor adapter and bind its run ID to the pane. Normalize these read-only events into the evidence plane:

```text
objective
plan and current step
tool call + result
file change
test command + exit status + structured report
approval/question
completion receipt
```

That closes the remaining “implementation context” gap without merging the two conversations. The executor still receives no explanation traffic; the explainer simply gains higher-confidence observations.
