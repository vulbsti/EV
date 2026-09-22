# R1 first-assistant prototype evaluation

Date: 2026-09-22

Candidate: `codex/r1-first-assistant`, based on `1874953`

Operator: Luna computer-use agents against the normal EV browser UI, with separate receipt inspection

Machine-readable receipt snapshot: [R1_RECEIPTS_2026-09-22.json](evidence/R1_RECEIPTS_2026-09-22.json)

Authority: local prepare-only content packages; no publishing, messaging, account mutation, or standing-responsibility change

## Outcome

The R1 implementation and technical acceptance gate passed. Five consecutive final-version browser tasks completed as one durable task and one reviewed artifact each. A sixth task survived a graceful daemon restart as one recovered result. This establishes a testable first-assistant prototype for one narrow task family; it does not establish broader autonomy or the owner's subjective long-term usefulness.

Honcho was not configured during these runs. EV therefore used its authoritative explicit, revisioned memory store and exact context manifests. Honcho integration is deferred until provider retention can honor EV's stop-use and erase controls; no dormant adapter is shipped in R1.

## Five browser runs

| Run | Conversation | Coordinator | Worker time | Worker tokens / cost | Post words | Memory revision | Browser result |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| 1 | `r1-luna-v3-1` | bounded fallback | 33 s | 8,243 / $0.00439 | 155 | `768dba15…` | Completed, artifact present, reload produced one result |
| 2 | `r1-luna-v3-2` | model | 40 s | 10,512 / $0.00558 | 180 | `768dba15…` | Completed, artifact present, reload produced one result |
| 3 | `r1-luna-v3-3` | model | 43 s | 11,235 / $0.00601 | 206 | `768dba15…` | Completed, preserved memory-versus-permission boundary, one result after reload |
| 4 | `r1-luna-v3-4` | model | 42 s | 11,790 / $0.00632 | 148 | `d8a38561…` | Completed and previewed; corrected under-180, candid-first-person guidance was visibly applied |
| 5 | `r1-luna-v3-5` | model | 24 s | 6,731 / $0.00324 | 133 | `d8a38561…` | Completed, one result after reload, broader-autonomy claim remained excluded |

The browser-observed end-to-end times were approximately 27-85 seconds across the five final runs. The slower middle runs overlapped and preceded the in-flight request guard; the final guarded runs completed in approximately 31-50 seconds. Every request was accepted without a clarification or steering turn.

## Artifact and review evidence

Every run produced all three private workspace records: `draft.md`, `review.md`, and `content-package.md`. In all five cases:

- the draft and final SHA-256 differed;
- the review contained `## Issues found` and `## Revision decisions`;
- the final artifact contained `Interpreted brief`, `Build-in-public post`, `Short reel outline`, `Review and revision receipt`, and `Assumptions`;
- the receipt-bound artifact endpoint returned the recorded SHA-256 and byte length;
- no external action capability or tool was available to the R1 worker.

The review and revision receipt come from the same bounded model response. The host verifies schema, required headings, minimum content, budget, and that draft and final hashes differ; it does not claim an independent critic proved the editorial judgment.

Run 4 was inspected through the inline browser preview. Its 148-word first-person post was below corrected revision 2's 180-word limit, retained the narrow prototype and evidence boundaries, and its review named concrete fixes. The artifact did not print the revision identifier, but the task's manifest contains the exact selected revision and the browser memory UI showed global revision 2.

## Fault and recovery evidence

- Concurrent same-ID test: two simultaneous message submissions returned HTTP 201 and 200, one was marked replayed, both referenced the same task, and exactly one coordinator session was created.
- Graceful restart: `r1-luna-v3-restart-2` recorded `created -> leased(1) -> started -> interrupted -> leased(2) -> started -> completed`. The browser showed a transient offline state, reconnected to the same task, previewed one artifact, and reconstructed one result after reload.
- The recovery run used 10,259 tokens and cost $0.00526. The 16,000-token no-tools profile cap was selected from the measured 6,731-12,262-token range; its $0.03 and zero-tool boundaries remain unchanged.
- The coordinator accepts a result only with a usage receipt at or below 6,000 tokens and $0.01, and its prompt selects at most eight guidance items / 8,000 guidance characters. Together with the worker, these are post-run acceptance thresholds of 22,000 tokens and $0.04, not a provider-side hard generation ceiling. The table reports worker usage because the earlier browser receipts did not persist coordinator usage.
- Inline Markdown preview returns `Content-Disposition: inline`, remains receipt-bound, and gives the browser a usable inspection path. One Chrome automation surface still returned `ERR_BLOCKED_BY_CLIENT`; a second Luna surface opened and inspected the same product path successfully.

## Repairs driven by failed live runs

The first implementation was not accepted. Three browser runs exposed a 40-call file-tool loop that rewrote and recounted finished files until timeout. That skill/tool loop was deleted. R1 now makes one no-tools structured model call over a host-built context envelope; the trusted host materializes and deterministically verifies draft, review, final, receipts, and budgets.

A later restart run completed generation at 12,262 tokens but failed the initial 12,000-token cap. The cap was raised to 16,000 using the observed distribution, without adding tools or increasing the $0.03 cost boundary. The repeated restart canary then completed.

## Decision and remaining product evidence

**R1 implementation and technical acceptance: PASS.** The branch now contains a browser-testable first assistant for one bounded prepare-only content workflow.

**Owner usefulness and time-saved claim: not yet asserted.** The owner has not personally rated these five drafts or recorded a manual creation-time baseline. The runs show one-submit/no-steering operation and usable reviewed output by operator inspection, but Phase 5 stays paused until the owner uses this prototype on current work and confirms it is preferable to their existing process.

Deferred by evidence: OpenClaw, self-hosted Honcho, a generalized planner, more task families, broad browser/computer control, new connectors, publishing, and external writes.
