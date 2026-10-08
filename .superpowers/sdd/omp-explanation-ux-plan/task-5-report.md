
## Feed restart ordering

Coordinator feed sequencing now accepts a lower sequence only when the executor evidence revision changes (a restarted pair), while preserving stale rejection within the same revision. Added focused restart smoke.

Exact checks:

- `node --check tools/omp-capability-lab/coordinator.mjs` — passed.
- `node --test tools/omp-capability-lab/tests/coordinator-v2.test.mjs` — 5 passed.
## Final coordinator v2 lifecycle repair

Restored staged-manifest lookup and activation guards (`staged` required, manifest body injection rejected) before active-pair and evidence-revision checks. Restored the browser route shell's chat completion and manual-observation branch so activation, SSE/state/feed, chat, manual, run, cancellation, lookup, comparison, and outer error handling remain inside the authenticated route try/catch.

Exact checks:

- `node --check tools/omp-capability-lab/coordinator.mjs` — passed.
- `node --test tools/omp-capability-lab/tests/coordinator-v2.test.mjs` — 5 passed.
## Effective input execution

Runner options now receive `request.effectiveValues`, preserving starter/default precedence and matching the sanitized probe summary. Added an integration assertion that a starter-seeded value is passed to the executor when the client omits `values`.

Exact checks:

- `node --check tools/omp-capability-lab/coordinator.mjs` — passed.
- `node --test tools/omp-capability-lab/tests/coordinator-v2.test.mjs` — 5 passed.
## Final privacy and pair-affinity edge fixes

Expanded recursive public-key filtering to remove expected-outcome, expectation, coverage, stage, verdict, works/fails/success, and outcome aliases at every nested projection level. Private input token capture now walks bounded nested values and retains one-character and full-length strings, preventing suffix leakage. Explicit `load: null` is rejected; starter load is used only when the client omits the field. Chat block selectors are constrained to the selected section. Coordinator feed normalization now rejects empty pair IDs, and manifest affinity gates use strict null-aware pair equality.

Exact checks:

- `node --check tools/omp-capability-lab/coordinator.mjs` — passed.
- `node --test tools/omp-capability-lab/tests/coordinator-v2.test.mjs` — 5 passed.
## Final pair and token hardening

Private token redaction now retains complete bounded strings, including long-value suffixes. Feed ingestion rejects empty pair IDs; active manifest affinity checks are strict and null-aware, and the active-pair gate remains explicit. Added a chat integration test proving a block from another section is not accepted as context.

Exact checks:

- `node --check tools/omp-capability-lab/coordinator.mjs` — passed.
- `node --test tools/omp-capability-lab/tests/coordinator-v2.test.mjs` — 6 passed.
## Final review residuals

Hardened focused-state projections so `latestResult` is limited to the focused pair and current active manifest/revision. `stageManifest` now requires a safe configured target root or active pair before validation and returns a stable conflict instead of a reference error. Recursive public-key filtering now normalizes case and separators across pass/fail, expected/expectation, coverage, stage, verdict, works/fails/success, and outcome aliases. Private token collection preserves complete bounded canonical JSON/scalar values, while probe summaries retain their intentionally bounded display scalars. Absolute path redaction handles `=`-prefixed key/value paths and file URLs. Manual observation session failures consistently return HTTP 409 `manual_conflict`; public receipts always include bounded ISO `startedAt`; invalid observer statuses normalize to `invalid` (missing status to `unavailable`).

Exact checks:

- `node --check tools/omp-capability-lab/coordinator.mjs` — passed.
- `node --test tools/omp-capability-lab/tests/coordinator-v2.test.mjs` — 6 passed.
## Final P1 observation/public-state hardening

Scoped `latestResult` to the focused pair and active manifest revision/evidence revision, added canonical serialized JSON redaction in `publicData`, and normalized arbitrary observer statuses to the observation enum (`invalid` for unknown, `unavailable` when absent). Restored route delimiters while making manual-session conflicts stable 409 responses, retained `startedAt` in all public run receipts, and added a legacy-status projection smoke.

Exact checks:

- `node --check tools/omp-capability-lab/coordinator.mjs` — passed.
- `node --test tools/omp-capability-lab/tests/coordinator-v2.test.mjs` — 6 passed.
## Final P1 residuals

`latestResult` is now null unless an active manifest is present and bound to the focused pair with matching manifest/evidence revisions; staging a manifest clears the result. Private token capture now records complete canonical root and per-input JSON values without depth or collection truncation, within a bounded aggregate budget. Absolute-path redaction recognizes colon-delimited values. Added focused state and deep/129-entry JSON redaction smokes.

Exact checks:

- `node --check tools/omp-capability-lab/coordinator.mjs` — passed.
- `node --test tools/omp-capability-lab/tests/coordinator-v2.test.mjs` — 7 passed.
## Final residual hardening

Expanded private input-token capture to include complete bounded canonical values for direct, starter, effective, and legacy input containers, while retaining bounded aggregate memory. Added a closed-focused-pair state assertion and nested public projection assertions for forbidden status/expectation aliases; the focused coordinator suite remains green.

Exact checks:

- `node --check tools/omp-capability-lab/coordinator.mjs` — passed.
- `node --test tools/omp-capability-lab/tests/coordinator-v2.test.mjs` — 7 passed.
## Manual observation outcome projection

Public run projection now explicitly preserves `manualObservation.result` only for the approved `worked`, `did_not_work`, and `unclear` values, while continuing to apply recursive public-data filtering to notes and other fields. This prevents the generic forbidden `result` key filter from erasing the human observation outcome without reopening verdict fields elsewhere. Added a focused coordinator assertion.

Exact checks:

- `node --check tools/omp-capability-lab/coordinator.mjs` — passed.
- `node --test tools/omp-capability-lab/tests/coordinator-v2.test.mjs` — 7 passed.
