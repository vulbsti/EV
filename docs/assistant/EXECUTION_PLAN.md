# EV adaptive implementation and real-use test plan

Date: 2026-09-21

Status: execution plan; Phase 0 passed, Phase 1 durable-conversation slice under verification

Owner model: one primary product owner, one implementation lane, at most one experimental branch at a time

This document turns the product and system specifications into a sequence that can actually be built, used, measured, and changed. It is deliberately not a fixed feature roadmap. Each phase ships the smallest usable increment, tests it through the real interface, uses it on representative personal work, identifies the first causal source of each failure, and rewrites the next phase before implementation begins.

The governing rule is:

> Build a thin slice, prove its mechanics, use it from the user's seat, inspect the durable receipts, score the outcome, and only then decide what to build next.

The architectural destination remains the connected launch-steward responsibility in [BUILD_PLAN.md](BUILD_PLAN.md). This plan controls how EV gets there without spending weeks on infrastructure that has not improved real assistance.

## 1. What counts as proof

Every tested claim must be labelled as one of these evidence classes. They are complementary, not interchangeable.

| Evidence class | What it proves | What it does not prove |
| --- | --- | --- |
| Contract test | A state transition, policy, or adapter behaves under controlled inputs | The product is understandable or useful |
| Fault test | A known failure is contained and recoverable | A normal task is high quality |
| Runtime receipt | A real worker, tool, connector, or process performed the recorded operation | The user received a useful result |
| Computer-use journey | A person can drive the actual UI through clicks, typing, reloads, interruption, and recovery | Backend truth unless checked separately |
| Provider receipt | The external system accepted, rejected, or returned a specific operation | EV interpreted it correctly or avoided duplicates |
| Outcome review | The result helped with a real task and reduced management burden | The result will generalize without more trials |
| Security probe | A forbidden operation is blocked outside model discretion | All possible attacks have been covered |

A phase cannot exit on unit tests alone. A screenshot cannot stand in for state or provider evidence. A worker process finishing cannot stand in for a verified useful outcome.

## 2. The per-phase learning loop

Each phase uses the same loop:

1. **Freeze the phase question.** State one product uncertainty and the minimum implementation needed to answer it.
2. **Freeze acceptance gates.** Define objective blockers and target metrics before seeing the results.
3. **Implement behind a flag.** Keep the previous passing slice runnable until the new gate passes.
4. **Run deterministic and fault tests.** Verify state, idempotency, recovery, permissions, and expected failure behavior.
5. **Run computer-use canaries.** Start from the actual browser entrypoint and operate only visible controls. Reload, interrupt, and recover where relevant.
6. **Run representative tasks.** Use current product-launch, content, and build-in-public work rather than invented assistant demos.
7. **Inspect both sides.** Compare what the UI claimed with task events, worker receipts, source revisions, external provider state, and artifacts.
8. **Score and classify lag.** Record quality, management burden, latency, cost, reliability, memory/context fit, personality fit, and safety.
9. **Write the phase decision.** Keep, change, remove, or defer each contested design choice. Define the next phase's exact delta.
10. **Freeze the revised next gate.** Do not carry a failed assumption forward because it was in the original roadmap.

The decision record is mandatory. A green automated suite with a poor real task result produces a design change, not a release.

## 3. Evidence bundle for every run

New assistant evaluation runs should be written beneath:

```text
artifacts/assistant-runs/<YYYY-MM-DD>/<run-id>/
  run.json
  events.jsonl
  context-manifest.json
  scorecard.md
  issues.md
  decision.md
  ui/
    journey.md
    before.png
    after.png
  receipts/
  artifacts/
```

`run.json` records the repository revision, feature flags, schema versions, models, provider and harness versions, task fixture, mandate revision, start/end time, token/tool/provider cost, and links to the other evidence. It records credential presence only, never values.

`context-manifest.json` records identifiers and revisions of the transcript window, task brief, person view, relationship policy, source evidence, memory items, capabilities, and mandate actually supplied to a model. Hidden reasoning is neither required nor stored.

`ui/journey.md` records each user-visible action and observed result. The computer-use operator must use the real UI for the tested behavior. Direct API calls can set up fixtures or inspect receipts, but cannot be reported as browser verification.

`scorecard.md` and `decision.md` use the templates in [templates/RUN_REPORT.md](templates/RUN_REPORT.md) and [templates/PHASE_DECISION.md](templates/PHASE_DECISION.md).

## 4. What EV is measured on

The primary unit is a **verified useful outcome**, not a message, model call, task process, or artifact file.

| Dimension | Measurement |
| --- | --- |
| Outcome success | Required result exists, matches the current brief, and passes its objective checks |
| Management burden | User questions, approvals, corrections, restarts, manual minutes, and times the user had to diagnose EV |
| Responsiveness | Time to accepted input, first useful update, blocked question, and verified result |
| Autonomy accuracy | Correct task/source/mandate selected; no invented completion, duplicate effect, or work after revocation |
| Context and memory | Correct revisions used; relevant guidance applied; stale, private, or conflicting context excluded |
| Assistance and personality | Concise, appropriately proactive, context-sensitive, honest about uncertainty, and consistent with explicit collaboration guidance |
| Reliability | Resume, idempotency, cancellation, uncertain-outcome handling, and no lost user messages |
| Safety | Deterministic authorization, token isolation, injection resistance, approval binding, and auditability |
| Economics | End-to-end elapsed time, model/tool/provider cost, retries, context growth, and compute per verified result |

Early target metrics are gates, not promises. Baselines may justify tightening them, never silently weakening them.

- Zero lost or duplicate user inputs in fixed concurrency and reconnect cases.
- Zero unauthorized, post-revocation, or duplicate consequential effects.
- One hundred percent pass on deterministic boundary, recovery, and fixture-based correction cases.
- At least four successful outcomes in five representative tasks before broadening the capability surface.
- No more than one avoidable clarification or correction on a well-specified task.
- Every completion claim links to an artifact, source/provider state, or explicit verification receipt.
- Acceptance feedback appears immediately in the UI; later latency targets are set from Phase 1 measurements.
- Cost and elapsed-time budgets are frozen per task class before a live model comparison.

## 5. Lag taxonomy

Every issue is assigned to the first causal layer supported by evidence. The repair targets that layer.

| Lag class | Typical evidence | Correct first response |
| --- | --- | --- |
| Product/routing | Correct user intent enters the wrong flow | Repair intent/state contract and add the utterance as a regression fixture |
| Model quality | Correct context and tools were supplied, but judgment or output is poor | Compare model/prompt/reviewer variants on the same run fixture |
| Context selection | The needed fact existed but the wrong revision or scope reached the model | Repair context assembly, conflict handling, or scope filters |
| Memory/person model | EV retained the wrong lesson, missed a durable preference, or overgeneralized | Revise evidence/proposal/correction policy and replay affected cases |
| Orchestration | Work is lost, duplicated, blocked silently, or cannot accept steering | Repair durable state, leases, inbox/outbox, command receipts, or recovery |
| Tool/connector | Correct operation fails at an adapter or provider boundary | Repair the adapter, reconciliation, credentials, or provider-specific retry logic |
| Verification | EV declares success without checking the meaningful outcome | Add objective checks and block completion until they run |
| Interaction/communication | The system works but the user must watch, decode, or repeatedly ask for status | Repair attention policy, updates, task detail, and conversational return |
| Latency/cost | The outcome is useful but too slow or expensive | Attribute model, context, tool, retry, wait, and verification costs before optimizing |
| Security/authority | A requested or attempted effect crosses the mandate | Block outside the model; repair grant, broker, or approval binding |

An infrastructure failure is not repaired by making the prompt more forceful. A model-quality failure is not hidden by adding a reviewer whose total cost and latency are omitted.

## 6. Phased build and test sequence

Effort ranges assume one experienced engineer with AI assistance. They are capacity estimates, not dates. A phase ends when its question is answered, even if the answer is to remove or defer the implementation.

### Phase 0 — baseline and evaluation harness

**Result:** passed after two evidence-led repairs. The exact safe attention utterance first exposed a negation-routing defect, then a split source of fleet truth. Both are repaired and covered by regression tests. `npm run assistant:phase0` now creates and validates the complete browser-canary bundle. Reload still loses the assistant reply, so durable conversation truth is the first Phase 1 blocker.

**Question:** What can the current prototype demonstrably do, and can future changes be compared with the same evidence format?

**Indicative effort:** 1–2 working days. The first baseline is recorded in [EVALUATION_LOG.md](EVALUATION_LOG.md).

**Implement**

- Add the assistant-run evidence schema, report templates, fixture IDs, and a script that validates required run fields and secret redaction.
- Preserve the current prototype as the baseline target.
- Turn every observed routing mistake into a fixed regression fixture.
- Define three task classes: read-only answer, local artifact, and connected standing responsibility.

**Computer-use canaries**

- Open the existing EV URL through computer use.
- Ask one read-only fleet question and compare the visible answer with the live fleet snapshot.
- Submit one action/reasoning request and observe whether a real result ever returns.
- Reload and confirm whether the task and response remain visible and correctly described.
- Exercise the attention item without sending terminal input.

**Exit gate**

- The current limitations are recorded without calling queued work completed.
- One command creates a complete run bundle and validates it.
- Browser observations, backend events, and automated tests are reported separately.
- Phase 1 gates are rewritten using measured current behavior.

**Branch condition:** If the existing web surface cannot be safely tested without exposing unrelated terminal content, use a seeded tmux fixture for repeatable runs and retain one real-fleet smoke test.

### Phase 1 — conversation intake and durable truth

**Status (2026-09-21):** core reliability accepted. Durable intake, same-ID retry, incremental reconnect, five restart/reload recoveries, and honest `not_executable` state passed. Narrow/mobile visual verification remains carried because the available computer-use surface cannot resize. Projection rebuild and failed outbox delivery move to Phase 2, where those mechanisms first exist; they are not being pre-built as unused abstractions.

**Question:** Can EV be a dependable conversation and task ledger before it can perform work?

**Indicative effort:** 3–5 working days.

**Implement**

- A minimal assistant shell with one ongoing chat and task detail, separate from the terminal wall.
- Transactional messages, intents, tasks, events, and idempotency keys in SQLite.
- Immediate saved/not-executable feedback, browser-owned pending retry, and resumable incremental reads.
- Honest capability states: a task that has no worker remains `not_executable`, never `working`.

**Deterministic and fault tests**

- Two rapid messages, repeated submit, stale client cursor, reconnect, daemon restart, and malformed cursor.
- Canonical ledger reconstruction produces the same visible conversation and task state.
- No browser client can mutate state through a replayed request.

**Computer-use journeys**

- Send two unrelated messages quickly; both appear once and stay independently attributable.
- Reload during the second message; conversation and task state recover.
- Use keyboard-only controls at desktop and narrow viewport widths.
- Simulate offline/reconnect and confirm no duplicate input or invented progress.

**Representative tasks**

- “What is EV currently able to do?” from authoritative capability state.
- “Track this launch question for later” as a durable but explicitly non-executing task.

**Exit gate**

- All fixed intake/reconnect cases pass with zero loss or duplication.
- Five consecutive computer-use runs recover correctly.
- The UI never implies execution that has not started.
- Phase 2 scope is revised from the observed interaction burden.

**Stop condition:** Do not integrate a model or connector while task truth and reconnect behavior are ambiguous.

### Phase 2 — one real supervised worker

**Status (2026-09-21):** bounded Phase 2 accepted. SQLite now owns transactional leases, fencing, commands, revisions, and task events across instances. The product conversation routes one exact reviewed capability to Pi with an explicit skill/extension, isolated workspace, scoped file tools, network-disabled command allowlist, reduced environment, budgets, process-group cancellation, receipt-bound downloads, and objective artifact checks. Computer use produced four verified completions and one intentional cancellation; concurrent chat, reload, download, cancellation, and a real `started -> interrupted -> started -> completed` graceful-restart path passed without duplicate cards or artifacts. Mobile visual verification remains unproven because the browser backend ignored viewport overrides.

**Question:** Can EV complete, verify, and return one bounded local task while chat remains usable?

**Indicative effort:** 4–7 working days.

**Implement**

- A pinned Pi adapter and one isolated worker workspace.
- Supervisor leases, budgets, lifecycle events, cancellation, checkpoints, artifact return, and objective verification.
- Separate worker reports from user messages; EV decides what is worth surfacing.
- A local-files-only task capability. No account connection and no broad host access.
- Reuse the Phase 1 command identity and recovery rules: stable request IDs, one durable lifecycle, and no second worker on replay.
- Add the smallest canonical worker-event/outbox representation needed for delivery and rebuild tests; do not introduce a general event platform.

**Deterministic and fault tests**

- Worker start failure, timeout, crash, daemon restart, duplicate completion, late event, cancel race, invalid artifact, and orphan cleanup.
- Matched model/harness runs on the same fixture with total cost, tool calls, context, retries, and verification included.

**Computer-use journeys**

- Ask EV to create a launch-status brief from a selected local fixture.
- While it works, ask for a headline comparison; neither request blocks the other.
- Steer the brief, close and reopen the browser, then cancel a separate run.
- Kill and restart the daemon mid-run and verify one recovery path, not two workers.

**Representative tasks**

1. Summarize the current EV product direction into a one-page decision brief.
2. Produce three headline options against a fixed product brief and explain the trade-offs.
3. Compare two launch-message drafts against explicit acceptance criteria.

**Exit gate**

- At least four of five task runs produce a verified useful artifact.
- The user can continue chatting throughout.
- No run requires terminal interpretation by the user.
- Completion, cancellation, and uncertainty are accurately reported.
- Selected coordinator/worker defaults and fallback triggers are recorded from matched evidence.

**Branch condition:** If failures are mainly model-quality failures, run a bounded model comparison. If they are lifecycle failures, keep one model and repair orchestration. Do not change both in the same experiment.

### Phase 3 — context, corrections, and personal fit

**Status (2026-09-22):** initial explicit-guidance slice accepted; broader personal-model depth remains later work. SQLite stores sources, active versus candidate claims, immutable revisions, proposals, scoped recall, stop-use, erase epochs, temporary expiry, and exact context manifests. The `Understanding you` UI passed add, explain, correction, persistence, and stop-use journeys. On the same fixture, the no-guidance brief was 685 words and the explicitly guided run was 247 words against an under-250-word instruction; their manifests respectively contain zero claims and the exact one claim/source revision used. A fresh conversation opened with no copied transcript yet retrieved the same reviewed global guidance and produced one verified task. Automated scope, deletion, stale-revision, proposal, and manifest tests pass. Richer conflict and temporary-exception UX remain open.

**Question:** Does explicit, provenance-linked personal context improve assistance without stale assumptions or cross-scope leakage?

**Indicative effort:** 4–7 working days.

**Implement**

- Explicit goals, active projects, preferences, collaboration guidance, and relationship-policy revisions.
- Context manifests and source-linked memory proposals/corrections.
- Conversation, project, and global scopes; conflict and recency rules.
- Post-task outcome notes without automatic self-modifying code or silent promotion of guesses to facts.

**Deterministic and fault tests**

- Correct, supersede, scope, delete, restore, conflicting evidence, temporary exception, and stale summary cases.
- Cross-project private fact exclusion and exact revision replay.

**Computer-use journeys**

- Correct a style preference in one task and verify the next relevant task uses it.
- Create a temporary exception and verify it expires or remains scoped.
- Start a new conversation and confirm shared guidance is available without copying the entire prior transcript.
- Inspect why a fact was used, change it, and rerun from the updated revision.

**Representative tasks**

- Draft a build-in-public update using the user's explicit voice and current launch priority.
- Reprioritize a content task after the user changes the week's main objective.
- Handle conflicting “concise globally” and “detailed for technical reviews” guidance correctly.

**Exit gate**

- All fixed correction and scope cases pass.
- Held-out task review shows a material first-draft improvement over transcript-only context.
- No deleted, superseded, or out-of-scope fact appears in the tested context manifests.
- The user can see and correct the influential guidance without editing raw storage.

**Branch condition:** If explicit structured views equal richer retrieval/graph variants, ship the simpler path and defer the graph. If personality changes do not improve outcomes, keep a stable collaboration policy and defer autonomous adaptation.

### Phase 4 — one read-only connected standing responsibility

**Status (2026-09-21):** provider-neutral core and local live canary complete; real connected alpha blocked on provider selection/authentication. The SQLite mandate/reconciliation boundary versions responsibilities, cursors and source revisions, suppresses duplicate/out-of-order events, reports stale/no-data states, treats connected text as untrusted data, revokes queued work, and hands material changes to one deterministic prepare-only worker task. Two local source revisions produced verified scoped artifacts, a repeated revision produced no task, and revocation blocked the later revision. This is readiness evidence, not the three-real-change exit gate.

**Question:** Can EV notice a meaningful external change while the browser is closed and prepare a useful, current result without taking consequential action?

**Indicative effort:** 5–8 working days after the selected connection is available.

**Implementation precondition:** Select one real repeated workflow and one provider. The working default is a chosen Notion launch tracker, but the provider is not frozen until its test workspace, scopes, and access method are confirmed. Start with a mock adapter using the same contract; then move to a limited real account or test workspace.

**Implement**

- Read-only connector, canonical object mapping, source revision/cursor, reconciliation, deduplication, and stale/no-data handling.
- Standing-responsibility mandate: resource, trigger, materiality, freshness, prepared output, budget, interruption rule, expiry, and revocation.
- Scheduler/event wake-up and attention decision.

**Deterministic and fault tests**

- Duplicate and out-of-order events, missed webhook recovered by poll, stale cursor, deleted source, rate limit, expired auth, injection in connected content, and responsibility revocation.

**Computer-use journeys**

- Connect the test source and review the rendered mandate.
- Create the standing responsibility, close EV, change the source in its normal interface, and return later.
- Verify one briefing and draft appear with the exact source revision.
- Repeat the same provider event and confirm no duplicate task or notification.
- Revoke the responsibility, change the source again, and confirm no work starts.

**Representative task**

> Watch this launch tracker. When the date, call to action, audience, or launch blocker materially changes, prepare a concise briefing and update the next storyboard draft. Do not publish or message anyone.

**Exit gate**

- Three real source changes produce three correctly attributed, non-duplicated outcomes.
- One stale/no-data run is reported honestly and does not build on invented current data.
- Closed-browser execution and later delivery survive a restart.
- No write scope or connector secret reaches the worker.
- User management burden is lower than manually checking and briefing the source.

**Stop condition:** If a standing responsibility is not used repeatedly or does not save user effort, do not add more connectors. Revisit the workflow and attention threshold.

### Phase 5 — bound action and trusted approval

**Question:** Can EV perform one reversible connected write exactly once, with approval bound to the reviewed payload and destination?

**Indicative effort:** 5–8 working days.

**Implement**

- Credential broker, typed write operation, deterministic grants, trusted approval UI, payload hash, destination binding, idempotency, reconciliation, revocation, and uncertain-outcome state.
- First scope is a draft/test object only. Publishing, sending messages, spending money, destructive edits, and account administration remain forbidden.

**Deterministic and security tests**

- Approve, deny, expire, replay, mutate after approval, wrong destination, revoke during execution, provider timeout after possible success, prompt injection, redirect, secret exfiltration, and duplicate delivery.

**Computer-use journeys**

- Review a prepared draft and its destination in a trusted card.
- Approve once and verify the external draft exists exactly once.
- Deny a second action and verify no provider effect.
- Change the payload after approval and confirm re-approval is required.
- Revoke the responsibility and verify later attempts are blocked outside the model.

**Exit gate**

- Zero unauthorized or duplicate effects across the fixed suite and at least five real test-workspace writes.
- Provider state, EV receipt, and UI status reconcile after success, denial, timeout, and restart.
- No raw credential appears in model context, worker filesystem, logs, or run artifacts.

### Phase 6 — narrow computer-use lane, only if evidence requires it

**Question:** Is browser/computer control necessary for the proven workflow, and can one missing operation be brokered safely enough to improve the outcome?

**Indicative effort:** 5–10 working days for one operation.

This phase is skipped when the typed connector completes the workflow. It is not a general desktop-automation milestone.

**Implement**

- One named browser operation in an EV-owned profile, with allowed origins, navigation rules, action schema, snapshots, takeover, redaction, budgets, and confirmation boundary.
- The worker receives semantic observations and bounded actions, not raw unrestricted browser debugging access or the credential store.

**Tests and computer-use journeys**

- Perform the exact missing workflow step through the visible site.
- Exercise login expiry, redirect, unexpected modal, DOM change, download, prompt injection, clipboard/screenshot sensitivity, takeover, cancel, and replay.
- Compare the browser lane with the connector/manual alternative on reliability, total time, cost, and management burden.

**Exit gate**

- The browser lane materially improves the verified outcome and is not merely more impressive.
- Forbidden origins, secrets, and actions remain blocked independent of model behavior.
- Failure returns a useful checkpoint or takeover request instead of blind repeated clicking.

**Removal condition:** Remove or disable the lane if connector coverage or manual approval is more dependable for the task.

### Phase 7 — seven-day personal alpha

**Question:** Does the combined system become something the user chooses to rely on, rather than another system to manage?

**Indicative effort:** Seven days of use after Phases 1–5 pass; Phase 6 is optional.

**Use, do not expand**

- Three to five recurring real tasks around a product launch, content production, and building in public.
- One primary conversation, one standing responsibility, one connector, and at most two concurrent workers.
- Daily task run reports and a short end-of-day burden/quality review.
- At least one correction, one interruption, one restart, one source change, one blocked question, one denied action, and one revocation during the week.

**Exit gate**

- At least 80% of representative tasks end in useful verified outcomes.
- The user reports net time or attention saved on the standing responsibility.
- No severity-one safety or truthfulness failure occurs.
- Repeated failure clusters have owners and causal evidence.
- The end-of-week decision names the single next bottleneck; it does not default to “add more tools.”

### Phase 8 — expand only the proven bottleneck

The next release is selected from Alpha evidence:

- More connector coverage only if unavailable source/action access blocked otherwise useful tasks.
- Better models or task-specific review only if correct context/tools reached the model and output quality remained the limiting factor.
- Richer memory/person modelling only if explicit context and corrections plateau in held-out tasks.
- Broader computer autonomy only if repeated useful workflows require it and the narrow lane is dependable.
- Better communication/attention before more autonomy if work succeeds but the user still has to watch and manage EV.

The Phase 8 decision includes measured benefit, added authority, new failure modes, and a rollback path.

## 7. Canonical real-task suite

These tasks remain stable enough to compare phases. Their source content can change; their success conditions do not.

| ID | Task | Setup and user action | Verified outcome | Primary failures caught |
| --- | --- | --- | --- | --- |
| T1 | Live status | Ask what EV is doing and what needs attention | Answer matches authoritative task/attention state | Hallucinated progress, terminal-wall burden |
| T2 | Launch brief | Request a one-page brief from a versioned local or connected source | Required sections cite current source revision | Bad context, weak artifact verification |
| T3 | Concurrent request | Request T2, then immediately request headline comparison | Both remain usable and attributable | Blocking conversation, lost input, context bleed |
| T4 | Correction reuse | Correct a scoped preference, then repeat a relevant task in a new conversation | Correct revision is applied, unrelated scopes excluded | Memory lag, stale summary, leakage |
| T5 | Blocked worker | Worker asks one necessary question while user starts another task | Question returns to chat; worker resumes once; other task continues | Paused-worker routing and duplicate continuation |
| T6 | Restart/recovery | Restart daemon during work or pending approval | One task resumes or becomes honestly non-resumable | Duplicate effects, false recovery |
| T7 | Source wake-up | Change the selected external source with EV closed | One fresh briefing/draft is delivered later | Event loss, dedupe, attention policy |
| T8 | Bound draft write | Approve a draft/test write after reviewing destination and payload | External object exists exactly once and reconciles | Approval binding, uncertain outcome |
| T9 | Revocation | Revoke the responsibility before another source change | No worker, credential use, or effect starts | Authority caching and post-revocation work |
| T10 | Browser exception | Perform only the connector-missing operation through a brokered UI | Correct effect or safe takeover with receipts | Injection, UI drift, blind retries |

## 8. Computer-use verification protocol

Computer-use testing is a release activity, not a final demo.

1. Start the intended release command in a clean test profile with seeded or explicitly selected data.
2. Record revision, feature flags, viewport, browser/profile, account class, and starting provider/source revision.
3. Open EV from the same entrypoint a user will use.
4. Drive the scenario by visible typing, clicks, reloads, navigation, and takeover. Do not use a backend call to impersonate the tested UI step.
5. Record the visible acceptance, updates, questions, errors, artifact, and final claim.
6. Independently inspect events, context manifest, worker receipt, artifact checks, and provider state.
7. Deliberately exercise one relevant interruption or failure.
8. Compare visible claims with durable truth. Any mismatch fails the run even when the desired side effect occurred.
9. Redact terminal captures, screenshots, URLs, and receipts before storing them. Never store credentials or private unrelated pane content.
10. Log the first causal lag, user burden, workaround, and suggested change in the run report.

For a real connected write, use a dedicated test workspace or clearly marked draft object until Phase 5 passes. Computer-use automation may approve an action only when the scenario explicitly tests that approval; it may never infer approval from the task request.

## 9. Phase decision and change control

At phase close, create `artifacts/assistant-runs/<date>/<phase>-decision/decision.md` from the template. It must include:

- passing and failing evidence, including unpleasant real-use findings;
- issue clusters by lag class and severity;
- observed user-management burden and outcome economics;
- decisions to keep, change, remove, or defer;
- the exact next thin slice and what is intentionally excluded;
- revised acceptance gates, frozen before next implementation;
- migrations, flags, and rollback needed to preserve the last passing slice.

Only these items are fixed across phases: durable truth, inspectable authority, provenance-linked context, one conversational return path, and honest uncertainty. Model choice, memory backend, provider, prompt shape, UI arrangement, polling strategy, reviewer topology, and computer-use scope remain empirical choices.

## 10. Feasibility constraints

Until the personal alpha passes:

- One standing responsibility, one provider, and one test workspace.
- At most two concurrent workers.
- Typed APIs before browser control; one browser operation before a broader desktop.
- Local source/artifact work before connected writes.
- Explicit personal guidance before inferred personality adaptation.
- No graph database unless the replay benchmark shows a material gain.
- No marketplace, plugin ecosystem, general SSH, autonomous app installation, money movement, public posting, or contact with third parties.
- No UI-polish phase that outruns execution truth, reconnect, correction, and approval behavior.
- No metric reported without its denominator, evidence class, and tested task class.

A plausible path to the seven-day alpha is roughly five to nine focused engineering weeks after Phase 0, depending on Pi compatibility, connector access, and sandbox/credential findings. That range is intentionally wider than a feature estimate because failed phase evidence changes the next implementation rather than being scheduled around.

## 11. Immediate next work

1. Freeze the Phase 1 SQLite schema and event/projection contract around the measured reload failure.
2. Build only durable intake, reply reconstruction, idempotent submit, historical-task cleanup, and honest `not_executable` state.
3. Exercise rapid input, reload, reconnect, daemon restart, and keyboard-only flows through computer use for five consecutive runs.
4. Select or integrate the first worker model only after those state and replay gates pass.

This ordering prevents the deleted `awaiting_orchestrator` seam from returning under a new label and ensures every later capability is judged by how much less management it requires from the user.
