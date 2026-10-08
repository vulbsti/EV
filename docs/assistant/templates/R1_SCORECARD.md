# R1 first-assistant prototype scorecard

Complete one row per real task run. A fixture-only run can validate a contract but does not count toward the five personal-use outcomes.

## Run setup

- R1 run-set ID/date:
- EV commit and feature flags:
- Browser/profile and viewport:
- Coordinator / worker / reviewer model and versions:
- Project/source revisions selected:
- Manual baseline method and minutes for the same deliverable:
- Frozen task budget (time and cost):

## Five real tasks

| Run | Natural request and source | EV's interpreted objective / assumptions | Memory revision in manifest | Clarifications / corrections | Review defects and revisions (0–1) | Result usable? (user) | Manual minutes | EV user-management minutes | End-to-end time / cost | Artifact + evidence |
|---|---|---|---|---:|---|---|---:|---:|---|---|
| 1 |  |  |  |  |  |  |  |  |  |  |
| 2 |  |  |  |  |  |  |  |  |  |  |
| 3 |  |  |  |  |  |  |  |  |  |  |
| 4 |  |  |  |  |  |  |  |  |  |  |
| 5 |  |  |  |  |  |  |  |  |  |  |

“User-management minutes” includes briefing EV, answering questions, steering/correcting, checking status, handling failures, and retrieving the result. “Usable” means the user would publish/use the local draft after at most ordinary minor edits; record the user's reason in the run evidence.

## Required browser and receipt evidence

- [ ] All five tasks were submitted and observed through EV's normal browser UI; record journey paths/screenshots.
- [ ] At least one active-task reload showed one durable task and one final result.
- [ ] At least one correction or scoped preference was reused in a later task/new conversation.
- [ ] For every run, UI state agrees with durable message/task/revision events, context manifest, worker receipt, objective checks, artifact hash, and final review result.
- [ ] No external write occurred; no terminal/worker/model operation was needed from the user.
- [ ] Record coordinator, worker, memory, review, retry, and recovery latency/cost in the per-run evidence.
- [ ] Attach contract/fault test output and note any untested viewport/accessibility case.

## Gate decision

- Usable outcomes: ___ / 5 (required: at least 4 / 5)
- Runs with more than one avoidable question/correction: ___ (required: 0 on well-specified tasks)
- Seeded material review defects caught before delivery: ___ / ___
- Final artifacts still failing criteria but reported complete: ___ (required: 0)
- Lost inputs, duplicate tasks/results, false completion, scope violations, or external writes: ___ (required: 0)
- Total manual baseline minutes: ___ · total EV user-management minutes: ___ (EV must be lower)
- R1 browser journey and receipt bundle:
- First causal lag / evidence:

Decision: `PASS` / `REVISE AND RERUN` / `BLOCKED`

Next change justified by evidence:

Explicitly deferred work:
