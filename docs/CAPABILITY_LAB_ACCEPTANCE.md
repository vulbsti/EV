# EV Capability Lab acceptance contract

Date: 2026-08-12  
Scope: capabilities backed by an installed, executable EV adapter

EV earns the 10/10 designation for a capability only when every gate below is demonstrated by a reproducible run. Unsupported capabilities must identify the missing adapter and remain unscored.

| Gate | Required evidence |
| --- | --- |
| 1. Goal | Project purpose, current task objective, and acceptance criteria are explicit. |
| 2. Capability | The changed user-facing capability and its before/after boundary are identified. |
| 3. Mechanism | A typed input -> pipeline -> state -> output graph is available without requiring prose. |
| 4. Manipulation | The user can vary meaningful inputs and select normal or edge scenarios. |
| 5. Execution | Experiments execute real supported code, not model-predicted outcomes. |
| 6. Observation | Pipeline stages, outputs, decisions, errors, and epistemic status are captured. |
| 7. Comparison | A declared baseline or contract and the observed candidate are evaluated from the same fixture. |
| 8. Envelope | Latency, throughput, errors, memory, limits, and relevant costs are measured under bounded load. |
| 9. Reproduction | Inputs, adapter version, evidence revision, assertions, trace, and metrics persist in an immutable receipt. |
| 10. Learning loop | A failed assertion produces a concrete regression-test proposal without mutating the executor. |

## Safety contract

- Experiments run only through registered adapters.
- Every adapter declares its authority, target boundary, resource ceilings, and cleanup behavior.
- Loopback HTTP probes cannot contact non-loopback hosts.
- In-memory probes cannot write files or use the network.
- Concurrency, iterations, response bytes, and timeouts are bounded server-side.
- Experiment results distinguish `observed`, `derived`, `predicted`, and `unknown` facts.

## Presentation contract

The default view shows the goal, selected scenario, pipeline, result, and failing stage. Details, evidence, metrics, comparison, and regression proposals are revealed on selection. Narrative explanation is optional and question-driven.

The adapter acceptance score covers executable capability mechanics. It does not by itself certify browser layout, accessibility, or visual usability; those require a connected real-browser pass.

## Adapter contract

A project declares capabilities in `.ev/capabilities.json`. EV validates the manifest and runs only adapter identifiers registered by the daemon. The initial adapters are:

- `presentation-pipeline`: exercises EV's real explanation-presentation normalization code in memory;
- `loopback-http`: exercises bounded HTTP behavior against the local EV daemon.

File/PDF/OCR, authentication, database, queue, browser, and agent-workflow adapters use the same contract but remain unsupported until their executable adapters are installed.
