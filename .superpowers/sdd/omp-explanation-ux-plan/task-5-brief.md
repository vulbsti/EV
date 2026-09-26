# Task 5 — Coordinator v2 run lifecycle and projections

Migrate `tools/omp-capability-lab/coordinator.mjs` to consume schema-v2 manifests/runners and expose the full observation-first coordinator contract. Task 2 already owns explanation validation/chat safety in this file; preserve it while integrating the manifest/runner APIs. Do not edit runner/manifest/web/demo except focused coordinator tests.

Required request:
`POST /api/runs` accepts only manifestId, manifestRevision, evidenceRevision, mode single|load, starterId?, values, question?, hypothesis?, load? `{concurrency,iterations,durationMs}`. Reject client runId, scenarioId, assertions, expected outcomes, unknown top-level fields, and load settings in single mode. Require exact active manifest/evidence revisions; validate values/precedence/type/file content before queueing. Validate load against manifest/global caps.

Lifecycle/public contract:
- Build private stable inputs digest and bounded public probe summary before queueing; never echo raw values/file content. Summaries: bounded scalar number/boolean/enum, Unicode codepoint count for text, UTF-8 serialized byte count for JSON, snapshot basename, content basename+bytes, sensitive filename withheld. Determine default/starter/custom from effective-value digest.
- Queue a schema-v2 receipt with coordinator-owned probe; emit queued then a coordinator-owned running transition immediately before executor; merge exactly one terminal runner receipt into existing record, retaining probe/question/hypothesis/revisions. Async throw is runner_error; synchronous validation rejects before queue.
- Consistent public projection for state/SSE/run lookup/compare/cancel/manual. Receipt fields: executionStatus, mode, probe, observations, traceEvents, measurements, excerpts, mutations, artifacts, limitations, manualObservation; no pass/fail/assertions/scenario/class/expectation aliases. Completed includes exit/nonzero/HTTP 4xx/5xx; no observer headline is truthful.
- Manual observation outcomes worked/did_not_work/unclear. Cancellation and stale/explain-only/missing manifest gates are explicit and cannot imply a run.
- Add `/web/view-model.mjs` static route later? Leave that to Task 6 if needed; this task may serve it only if route integration is required.
- Preserve loopback/auth, executor feed, redaction, private paths/artifacts, exact origin, no-store, calibration, compare and chat context safety from Task 2.

Write detailed report at `.superpowers/sdd/omp-explanation-ux-plan/task-5-report.md`; no commit, formatter, linter, or project-wide suite.
