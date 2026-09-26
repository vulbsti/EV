# Task 6 — Pure adaptive browser view model

Create `tools/omp-capability-lab/web/view-model.mjs` with pure exports and focused tests in `tools/omp-capability-lab/tests/explanation-view.test.mjs`. Do not edit index.html/app.js/styles.css in this task.

Exports:
- `deriveReadiness(data)`: safety precedence offline → missing/closed pair → missing/current explanation → missing manifest → explain-only → stale manifest → staged manifest → ready. Generic copy; never scenarios or source-specific terms.
- `normalizeExplanation(value)`/`deriveExplanationSections(data)`: only validated sections/blocks, preserve investigator order; primary open, supporting/technical native details; never synthesize flow/table/stage/fallback claim.
- `deriveProbeDraft(manifest, starterId, priorDraft)`: blank defaults; starter seeds source values/questions; later edits custom and survive refresh; files summarize basename/UTF-8 bytes/digest only; expose limitations.
- `summarizeProbeInputs` with bounded safe values and starter/default/custom mode.
- `deriveExecutionSummary(run)`: orchestration headline from executionStatus only. Completed with observed item => `Observation captured`; completed without => exact `Execution completed; no observer captured a result`; show exit/HTTP/manual facts without verdicts.
- `deriveObservationDocument(run, explanation, manifest)`: `{ observed, unavailable, unknowns, traceOverlay }`, link observer/trace to declared trace points/explanation items, preserve claim status, chronological evidence if no flow.
- `deriveComparison(runs)`: authored question/starter provenance/input summaries/execution state/observer facts/duration/load/revisions; no winner or hypothesis verdict.

Every export accepts partial/null data, bounds values, returns honest empty states without throwing, and never emits class/pass/fail/scenario language. Tests defend these observable copy/state contracts. Skip formatter/linter/project-wide suites. No commit. Report at `.superpowers/sdd/omp-explanation-ux-plan/task-6-report.md`.
