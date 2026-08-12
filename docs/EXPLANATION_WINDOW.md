# EV Explanation Window and Capability Lab

Date: 2026-08-12  
Status: runnable, adapter-backed prototype

## What this system separates

The executor needs implementation context. The learner needs a different multi-turn context for questioning the result. EV keeps those conversations separate and synchronizes them through observable evidence.

```text
executor thread --produces--> pane + Git + tests + EV events
                                      |
                                      v read only
                              explainer thread
                                      |
                                      v hypotheses
registered adapter --> real run --> immutable experiment receipt --> Capability Lab
```

Explanation questions never enter the executor thread. The explainer cannot type into the pane, edit files, approve actions, launch processes, or use a generic experiment shell. Closing the browser window closes only the view: the Codex explanation thread ID, messages, evidence revisions, feedback, task binding, and experiment receipts remain in the append-only event ledger.

## The two modes in Window 2

`WHY?` opens `/explain.html?pane=<paneId>` in a browser window, not a terminal or tmux session.

**Explanation** answers questions from a separate read-only Codex thread. It shows a bounded direct answer, goal alignment, a selectable causal mechanism, material scenario paths, evidence status, and unknowns.

**Capability Lab** runs registered code adapters. It exposes bounded inputs and named normal, edge, load, and deliberate contract-failure scenarios. A run displays the actual trace, assertions, comparison, latency, throughput, resource/cost measurements, and a reproducible receipt. A failed assertion creates a regression-test proposal but does not edit the repository.

## Evidence and goal anchors

Before every explanation, `apps/daemon/lib/evidence.mjs` captures:

- pane identity, process, cwd, activity, and bounded recent visible output;
- project purpose from `.ev/project.md`, `README.md`, and other explicit project documents;
- the pane-bound task objective and acceptance criteria, when set in the UI;
- Git root, branch, head, status, recent commits, bounded tracked patches, and safe text from untracked files;
- recent correlated EV events and console lines resembling test/build/lint results;
- provenance, confidence, and known limitations.

The terminal capture is recent console text, not hidden thought, a complete transcript, or every change. Sensitive-looking paths are excluded and credential-shaped values are redacted. The browser receives only the public evidence projection; full bounded patches and terminal evidence go to the read-only explainer locally.

## Explanation mechanics

One user question causes one model turn:

```text
question + learner profile + fresh evidence
  -> read-only Codex mechanics model (JSON)
  -> deterministic parser/linker/budget normalizer
  -> selectable browser presentation
  -> append-only answer event
```

The model is not told to sacrifice reasoning depth for concision. It produces a typed mechanics artifact. `apps/daemon/lib/presentation.mjs` then enforces the display contract deterministically: at most 650 direct-answer characters, six mechanism steps, five scenarios, three limitations, and three follow-ups, with bounded fields and invalid scenario links removed. Malformed model output takes an explicit bounded fallback path.

The evidence vocabulary is:

- `observed`: direct current artifact or matching execution receipt;
- `derived`: deterministic calculation from observed values;
- `predicted`: code/contract analysis without a matching run;
- `unknown`: not established.

A scenario in the explanation is a mental model until an experiment receipt observes it.

## Capability specification and adapters

Projects declare executable understanding in `.ev/capabilities.json`. Each capability names:

- its objective and changed boundary;
- a typed pipeline;
- bounded controls;
- named scenarios;
- a registered adapter and exact authority.

Current adapters are deliberately narrow:

| Adapter | Authority | Real path exercised |
| --- | --- | --- |
| `presentation-pipeline` | `in-memory-read-only` | the actual explanation JSON parser, linker, fallback, and display-budget normalizer |
| `loopback-http` | `loopback-get-only` | bounded GET requests to allow-listed local `/api/*` paths |

There is no generic command adapter. An unsupported project or capability is shown as `missing adapter`; EV does not turn a language-model prediction into a fake interactive demo.

## The 10/10 acceptance contract

The full gate definitions live in [CAPABILITY_LAB_ACCEPTANCE.md](CAPABILITY_LAB_ACCEPTANCE.md). For each adapter-backed capability, persisted receipts must collectively prove:

1. explicit goal and criteria;
2. explicit changed capability;
3. typed mechanism;
4. manipulable controls/scenarios;
5. real adapter execution;
6. observed trace and evidence status;
7. baseline/contract versus candidate observation;
8. bounded load/resource metrics;
9. reproducible persisted receipt;
10. failed assertion converted to a regression proposal.

`Run 10/10 suite` executes a normal path, a load/stress path, and a deliberate contract-failure path. The failure is necessary to prove the learning loop; it is displayed as an expected failed assertion, not a runtime error.

## API surface

| Endpoint | Purpose |
| --- | --- |
| `GET /api/explain/context` | fresh public evidence for a pane |
| `POST /api/explain/task-context` | bind exact objective and acceptance criteria |
| `POST /api/explain/ask` | ask in the separate read-only thread |
| `GET /api/explain/sessions/:id` | reconstruct a durable conversation |
| `POST /api/explain/feedback` | tune explainer-only presentation preferences |
| `GET /api/capabilities` | load adapter support and acceptance state |
| `POST /api/experiments/run` | execute one bounded scenario |
| `POST /api/experiments/acceptance-suite` | execute the three-run acceptance suite |
| `GET /api/experiments/recent` | list persisted receipts |
| `GET /api/experiments/:id` | reconstruct one receipt |

## Use it

```bash
npm run prototype
```

Open `http://127.0.0.1:4317`, click `WHY?` on an executor pane, then:

1. set the current task objective and observable acceptance criteria;
2. ask for the smallest complete mechanism or test mechanics;
3. inspect steps and evidence status;
4. switch to **Capability Lab**;
5. change inputs or select an edge/load case and run it;
6. run the 10/10 suite and inspect the deliberate failure's regression proposal.

## Verification and honest limits

Automated tests cover evidence redaction, read-only session isolation, single-turn structured explanation, deterministic presentation budgets and fallback, task binding, capability validation, both real adapters, load measurements, missing-adapter behavior, receipt persistence, and 10/10 aggregation.

The 10/10 score applies only to capabilities backed by installed adapters. It does not mean EV can execute arbitrary auth, OCR, PDF, database, browser, or production-load behavior. Each such mechanism needs a purpose-built safe adapter and instrumentation. Loopback HTTP currently observes the request and response boundary; its internal route stage remains explicitly `predicted` until route spans are instrumented. JSONL is durable for this prototype but is not a transactional database.

The current environment exposed no connected in-app or extension browser during the final pass. JavaScript syntax, HTTP APIs, model output, persistence, adapter execution, and deterministic UI data contracts were verified, but browser layout, clicking, accessibility, and responsive behavior remain unobserved. The adapter-level 10/10 score intentionally does not erase that product-level limitation.
