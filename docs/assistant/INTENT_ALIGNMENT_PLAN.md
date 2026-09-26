# EV: from vague requests to personally useful outcomes

Date: 2026-09-26. Status: proposed architecture and implementation plan, grounded in the current checkout. No runtime implementation is included in this change.

## 1. Product aim and the central design decision

EV should let an ordinary person express an incomplete intention, help them discover the parts they cannot yet articulate, and carry the work through to a result they would endorse. OpenClaw supplies execution capabilities. EV owns the continuing relationship between the person's intention, the delegated work, the result, and what is learned afterward.

The target loop is:

```text
User message, reference, correction, or authorized background event
  → reconstruct relevant conversation, goals, artifacts, and personal context
  → form a provisional interpretation and identify consequential uncertainty
  → inspect the situation; ask, preview, or make a reversible assumption
  → define the intended outcome and how it will be judged
  → delegate a versioned brief to OpenClaw
  ↔ answer worker questions, apply user changes, inspect intermediate results
  → inspect the actual outcome; revise within budget when needed
  → deliver the artifact and important remaining choices
  → learn from attributed feedback and carry the work forward
```

Memory, domain judgment, and execution are different dependencies. Knowing that a person likes energetic videos does not teach an agent editing rhythm. Editing competence does not establish which emotional direction this person wants. Both must enter the brief and the review.

Alignment is the product objective. Model and tool competence still constrain what EV can deliver. “Understands without being told” should mean calibrated inference from context, with inexpensive ways to correct it—not an assertion that EV knows an unstated desire with certainty.

EV is also a conversational assistant. A complaint, question, exploration, correction, or answer to a pending question must not automatically become a fresh execution task.

## 2. What Muse suggests, and what it does not establish

The useful reference is the continuity of the experience. Muse's design account describes a main conversation, side chats, remembered context, concurrent background work, goals, editable memory, artifacts, and selective notifications. A staff example connects school email, calendar entries, supplies, and an approaching deadline. These are vendor descriptions and examples, not independent validation of its internal memory or intent inference. [Muse design account](https://introducing.muse.ai/)

Public user reports describe inbox triage and reply drafts, social comments, app crash/review monitoring, selective news and price alerts, and organizing an existing content corpus for later writing. These are self-reported uses, not reproduced experiments. [Firsthand use report](https://www.reddit.com/r/accelerate/comments/1wlo138/anyone_can_now_have_their_own_jarvis_my_head_is/)

A contrasting travel-advisor report describes useful quote research followed by repeated requests for already supplied information, missed spreadsheet entries, repeated mistakes despite corrections, login friction, and disappointing social media assets. It is one anecdote, not a prevalence estimate. It is nevertheless a useful source of EV test cases: memory must change subsequent behavior, and delegation must reduce checking effort. [Firsthand failure report](https://www.reddit.com/r/MetaAI/comments/1wpdcdd/it_was_great_until_it_wasnt/)

Meta also describes per-person virtual computers, separate permission enforcement, credential protection, and user controls. Those claims motivate a distinct execution-authority boundary; they do not prove that EV needs the same proprietary implementation. [Meta introduction](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)

EV's opportunity is to make interpretation, craft review, and correction retention work together. A background agent and a memory tab alone do not establish that experience.

## 3. Walk through the intended experience

### “Edit this video, make it more K-pop, that anime style which looks good”

EV first resolves “this”: the supplied asset or the artifact being discussed. It inspects the footage, audio, existing edit, intended audience, and any relevant examples. If no video is accessible, requesting the source is a necessary dependency, not a preference questionnaire.

It then distinguishes possible meanings. The user could want a live-action performance edit with stylized graphics, a fully animated transformation, or the feeling of an anime opening. These imply substantially different work and expense. Past examples may resolve this; otherwise EV can show two small treatments or ask a concrete question. It should not silently turn a person into an animated character because the word “anime” appeared.

For an illustrative live-action interpretation, EV might propose a short test segment with performance-led cuts, a build toward a musical accent, controlled speed changes, graphic impact frames, and a coherent palette. These are candidate creative choices, not a universal definition of K-pop or anime. The actual footage and references determine the treatment.

The delegated brief carries the experience to produce: which moment matters, what should remain recognizable, where energy rises, what must be preserved, and which references govern rhythm versus color versus typography. EV can produce an 8–12 second test before committing the whole edit. It can choose a reversible default when confidence is adequate; preview approval is not a mandatory gate for every task.

Review inspects the rendered sequence and audio timing, not only an edit script or file hash. It asks whether the central action remains readable, the edit has progression, effects serve the intended emotion, and the result fits this user's relevant examples. Technical checks separately verify export, sync, legibility, and missing media.

If the user says “the rhythm is good, the effects are childish,” EV preserves the rhythm and revises the effects. It records a scoped observation about the compared versions. It does not learn “dislikes animation” or “hates effects.” A later preference hypothesis needs evidence beyond the assistant's own interpretation.

### “The website looks trash”

This is useful dissatisfaction with an unspecified cause. EV should inspect the page and the conversation that produced it before asking the user to become a designer.

It might find weak hierarchy, generic imagery, inconsistent spacing, or a visual tone unsuited to the intended audience. Those are observations and hypotheses, not established reasons for the user's reaction. EV can say, for example: “The page gives everything equal emphasis and feels generic. I'll try stronger typography and fewer competing elements.” If two plausible directions differ materially, it can show two concrete hero treatments with plain-language descriptions.

The user can respond “the second, but less formal.” EV translates that reaction into specific changes, preserves functionality and approved content, compares rendered results, and saves the preference with the artifact and project scope. The interaction gradually helps the user name what they want without imposing a design vocabulary or a long intake form.

## 4. The ideal system, with clear ownership

| Component | Owns | Produces |
| --- | --- | --- |
| EV conversation controller | Meaning of the current exchange; unresolved questions; what the user has seen | A response, clarification, task revision, new brief, or authorized background decision |
| Context builder | Relevant current state and permitted memory, with exact sources and versions | Bounded context package and manifest |
| Personal understanding | Goals, scoped preferences, collaboration patterns, exceptions and uncertainty | Revisable claims and evidence-backed views |
| Intent brief | Original request, intended experience, constraints, assumptions and success criteria | Versioned contract used by both executor and reviewer |
| Task manager and supervisor | Decomposition, task truth, retries, cancellation and recovery | Durable assignments, progress and outcome state |
| OpenClaw | Tool use, investigation, production and local verification | Artifacts, questions, observations and completion reports |
| Outcome reviewer | Fit to the brief, technical correctness, craft and personal fit | Acceptance evidence or actionable revision requests |
| Learning jobs | Attributed feedback extraction, reconciliation and consolidation | Proposed or scoped memory changes with provenance |
| Authority enforcement | Allowed resources/actions, grants, revocation and spending | Enforced decisions independently of inferred preferences |

These are logical responsibilities. Initially they can live in the current daemon and SQLite stores. They do not each need a service or an always-running agent. One EV decision call can select the conversation action and compile the brief. Separate calls are useful where a new observation or independent review adds value.

Keep EV's supervisor as the task authority and OpenClaw as the executor in the first implementation. The existing explicit parent/child ownership should remain; enabling a second independent delegation hierarchy would create cancellation and recovery ambiguity.

### The memory model

| Layer | Example | Update rule |
| --- | --- | --- |
| Source episodes | User message, selected preview, rejected artifact, completed task | Preserve attribution and provenance under retention policy |
| Goals and projects | Launch a portfolio; exploring a travel channel | Distinguish proposed, active, paused, achieved and abandoned; never infer commitment from brainstorming alone |
| Preferences and taste | Prefers restrained typography for client work | Store conditions, exceptions, examples and counterexamples |
| Collaboration preferences | Show a small concrete draft when aesthetic language is vague | Scoped guidance; never an action permission |
| Working task state | Current brief, version being edited, pending answer, protected content | Changes immediately as the task proceeds |
| Capability knowledge | A particular render workflow has succeeded under these conditions | Execution evidence; keep separate from beliefs about the person |

Use the existing source/claim/revision system underneath this. Add typed projections and relations for goals, projects, taste examples and feedback rather than a new graph database as the first dependency.

A reusable claim needs: owner; subject and type; scope; content; source references; explicit versus inferred status; supporting and contradictory evidence; applicability conditions; validity/review times; sensitivity; revision; and derivation links. Confidence is an evidence aid, not a calibrated probability merely because a model emitted a number.

Taste examples need actual artifact versions and relevant regions or time ranges, the user's exact reaction, and a description of which dimension changed. “Liked version B” may mean its pacing, lower cost, or suitability for this audience; it does not establish that every attribute of B is preferred.

Learning runs after meaningful turns, corrections, choices, goal changes or outcomes—not after every tool call. The flow is: record observation → extract candidate meaning → compare with existing evidence → add a scoped claim, exception, supersession or unresolved conflict → refresh affected views. Consolidation jobs use idempotent event IDs and compare-and-swap revisions so duplicate or concurrent runs cannot silently overwrite corrections.

Explicit statements and corrections apply immediately in the appropriate scope. Low-risk inferred preferences can quietly influence reversible choices as tentative hypotheses. Broader or sensitive interpretations remain inactive unless adequately supported and appropriate to use. Do not ask the user to approve every routine memory extraction. Do not treat silence, a successful render, or the worker's self-review as user approval.

Retrieval begins with owner/access/scope filters, then current task and conversation references, active goal/project context, relevant explicit constraints, selected examples, and useful uncertain hypotheses. Start with structured queries and lexical retrieval; add embeddings only when measured recall failures justify them. Store what was actually supplied, including source/artifact revisions, not just memory IDs. Preserve reasons for consequential personalization without exposing hidden reasoning.

Current instructions take precedence over older preferences. Current project exceptions take precedence over general style. Actual task status comes from the supervisor. Conflicting evidence stays visible to the interpreter. A user changing their mind is normal revision, not a prediction failure to argue away.

### The intent brief

The execution plan should be derived from a richer brief, not replace it. A proposed `IntentBrief` contains:

```text
briefId, revision, ownerId, conversationId, taskId, sourceMessageIds
originalRequest, goalId/projectId, resolvedArtifactRefs
desiredOutcome, purpose/audience, intendedExperience
deliverables, mustPreserve, explicitConstraints, nonGoals
relevantPreferences[{claimRevisionId, application, uncertainty}]
references[{artifactVersion, region/timeRange, role}]
assumptions[{statement, evidenceRefs, impact, reversibility}]
openQuestions[{decisionAffected, options, recommendedDefault}]
acceptanceCriteria[{criterionId, requirement, evidenceMethod, priority}]
authorityRef, budget, checkpointPolicy, contextManifestId
```

Only include relevant fields for simple tasks. Preserve the original words alongside the interpretation so a reviewer can detect drift. Do not allow an inferred style preference to override an explicit request. A worker can propose a different implementation after inspecting reality, but a changed goal or permission requires EV to reconcile it with the user request.

The decision to ask is based on the cost of being wrong, cost of rework, available evidence and usefulness of a preview. Low confidence on a cheap reversible choice can justify action. High confidence never substitutes for authorization of a consequential action.

### Bidirectional communication

Add a small versioned protocol using the existing durable event/command machinery:

| Direction | Message | Meaning |
| --- | --- | --- |
| EV → worker | `assign`, `revise_brief`, `answer`, `cancel` | Start work or change its governing context |
| Worker → EV | `accepted`, `progress`, `needs_input`, `checkpoint`, `result`, `blocked` | Acknowledge context, expose uncertainty, or return evidence |
| EV → worker | `request_revision` | Concrete mismatch, affected artifact, protected content, and required evidence |
| Worker → EV | `applied` | A particular answer or brief revision is now governing execution |

Each envelope carries message ID, task/run ID, brief revision, parent/correlation ID, sequence, and payload version. Worker events are authenticated and attributable to a run; retrieved content cannot spoof a command. Delivery is replayable and deduplicated. Receipt is distinct from application.

An input request records the actual question, the decision it blocks, available options, EV's permitted default, and a resumable checkpoint. EV first tries to answer from authorized context. It asks the user only if the unresolved choice matters. Unrelated tasks continue. An ambiguous “yes” must be resolved to the right outstanding question.

For the current CLI adapter, begin with a structured `needs_input`/`checkpoint` terminal report: persist the checkpoint, release the process slot, then resume the task session with the answer and current brief. Live mid-turn interaction is a later adapter capability unless verified with the installed runtime. Do not equate appending an answer to a log with OpenClaw actually using it.

A user correction increments the brief revision. At a safe checkpoint, EV can continue the session with the changed brief; if necessary it cancels the old run and starts from the saved artifact. Old results remain useful evidence, but cannot be accepted against a superseded brief without reconciliation. Changes and revocations must be checked before another action boundary. Restarts preserve pending questions, answers, applied revisions and delivery state.

Completion is evaluated separately at three levels: the worker stopped successfully; the artifact satisfies observed criteria; the user considers it useful. Keep those meanings distinct. Delivering a draft need not wait for user feedback, but must not label personal fit as user-validated.

### Review and communication quality

Every task needs an appropriate evidence method. A website needs browser interaction and rendered views. A video needs temporal and audio review, with frame-level checks as supporting evidence. Documents need page/layout inspection. Code needs checks matched to behavior. Metadata and a worker's description cannot stand in for viewing the result.

Keep four judgments separate: technical validity, fulfillment of the user's purpose, domain craft, and personal fit. A critic can suggest a better direction, but it cannot objectively certify taste. Reviews should identify artifact locations, the criterion being missed, and concrete changes while protecting already approved work. Bound iteration by time, cost and expected improvement; preserve the best useful version when review fails or the budget ends.

Chat presents a concise interpretation when useful, actual previews, changes that matter, and the final result. Routine worker logs stay secondary. A background event should trigger a notification only for a meaningful result, material plan change, blocker, or required choice. Inferred goals do not create recurring jobs; scheduled initiative requires an explicit mandate.

## 5. What exists in the current checkout

Audit basis: HEAD `0dbc330` plus existing uncommitted manager/OpenClaw changes. This working tree is materially ahead of the older roadmap and memory notes. The following observations concern inspected source unless otherwise specified.

| Area | Existing implementation | Remaining gap |
| --- | --- | --- |
| Intake | `server.mjs:createAssistantTurn` defaults to an OpenClaw action for each message; old R1/fixture paths are environment-gated | Conversational interpretation, follow-up binding, clarification and memory corrections through chat |
| Conversation | `assistant-ledger.mjs` persists paired user/acknowledgment turns; UI joins tasks and reports | Context construction does not load prior turns/results; general unsolicited assistant turns and checkpoints need support |
| Context | `server.mjs:ensureGeneralTask` selects the last eight active global claims and writes `CONTEXT.md` | Task relevance, scoped project/goal retrieval, artifact references, uncertainties and conversation continuity |
| Planning | `ev-task-manager.mjs` generates goal, success criteria and optional independent assignments | Purpose, examples, assumptions, preservation constraints and versioned intent contract |
| Orchestration | `assistant-worker-service.mjs` persists plans; supports one-level fan-out, synthesis, bounded retry and recovery | Iterative brief changes, questions, answer/application receipts and resumable input checkpoints |
| Task authority | `assistant-supervisor.mjs` owns durable tasks, leases, events and cancellation; command API accepts cancellation | Extend existing contracts for revision and input, without another competing task store |
| Memory | `assistant-memory.mjs` stores sources, claims, revisions, proposals, corrections, scopes, tombstones and manifests | Ordinary-chat learning, reconciliation, goals, taste examples and evaluated retrieval |
| Review | `ev-quality-gate.mjs` reads bounded textual evidence and command receipts; root work gets a separate model review and one repair opportunity | Direct personal-context input, domain rubrics, multimodal inspection and acceptance by brief revision |
| OpenClaw | `openclaw-worker-adapter.mjs` creates task sessions/workspaces and parses terminal results; nested spawning is denied | Event/question bridge; current model configuration declares text input only |
| User surface | `assistant.js` shows concurrent tasks, child state, results, downloads, cancellation and manually entered memory | Reference uploads, usable media/website previews, reply-to-artifact and lightweight preference comparisons |
| Background work | Existing GitHub standing-responsibility implementation | General goal-linked authorized initiative and shared conversation controller wakeups |
| Consumer boundary | Server uses `default-person`; workers run with daemon-user host access | Identity/tenant isolation, enforced grants, credential custody, resource limits and genuine sandboxing before broad distribution |

Particularly consequential findings:

1. `ensureGeneralTask` does not reconstruct conversation or completed results. “Make that less flashy” therefore lacks the prior artifact/decision context through the EV path. This is a source-derived limitation; no live failure prompt was submitted in this audit.
2. The newer manager already implements decomposition and combined delivery. Replacing it or planning fan-out from scratch would waste useful work.
3. Memory changes currently affect future context packages. The UI says so explicitly. Running OpenClaw sessions are not refreshed when memory changes.
4. `erase()` currently writes a tombstone; it does not physically purge source/revision content, exported context, worker sessions or derived copies. The proposed product must distinguish stop-use from complete erasure and implement the latter before promising it.
5. The review API receives request/criteria/report and observed evidence, not a dedicated personal-context package. Binary sources are not reviewable there. Its current checks cannot establish video or visual-design quality.
6. `PERSONAL_MODEL.md`, `MEMORY_RESEARCH.md` and `COMMUNICATION_REVIEW.md` already describe much of the desired conceptual foundation. Reuse these principles; this plan supplies the current implementation bridge and sequence. Older phase completion labels are not proof these broader behaviors exist.

### Verification performed for this review

- Fresh `npm test`: 150 passed, zero failed, zero skipped. These are existing contract/unit tests, not validation of inferred intent or creative quality.
- Read the saved manager acceptance evidence in `data/manager-check/2026-09-26T07-28-56-854Z/`: local Python checks passed, artifact download hashes matched, and generated Python/Node reporters produced the expected 53.00 total. These are prior run receipts inspected now, not newly executed live runs.
- Inspected current intake, ledger, memory, manager, supervisor, worker adapter, quality gate and browser client source. No fresh provider, browser or video acceptance run was performed.

## 6. Build sequence

These work packages address the current request. They do not silently reopen older rollout phases or claim that consumer release requirements are already met.

| Package | Concrete changes | Exit evidence |
| --- | --- | --- |
| A — Conversation continuity | Add a context builder and EV conversation controller; extend ledger to arbitrary assistant/event turns; join recent dialogue to current tasks and artifact versions; classify new work, follow-up, question, correction and input answer | After restart, “make the second one less formal” edits the intended artifact, preserves the other output and creates no unrelated task; a question receives a conversational answer |
| B — Intent and steering | Add `IntentBrief`, references, assumptions and criteria; manager consumes it; implement durable input/answer/revision messages and safe checkpoint resume | One consequential ambiguity resolved with a concrete choice; worker acknowledges the exact answer/brief; late old-revision result is reconciled; duplicate answers do not duplicate actions |
| C — Explicit goals and taste | Extend existing memory with scoped goals, feedback episodes, taste examples and derivation links; support ordinary-chat corrections; retrieve by task/project relevance | A stated preference changes the next applicable task; a project exception wins; a paused goal produces no work; every material personalization links to evidence |
| D — One complete craft workflow | First build website inspection, two small visual directions when needed, artifact comparison, browser checks and personalized critique; support uploads/previews and protected edits | Vague dissatisfaction becomes a visibly better functioning page; user accepts a useful direction with limited steering; next task reuses appropriate feedback |
| E — Quiet learning | Add asynchronous extraction/reconciliation jobs, uncertainty, counterevidence, scope/time handling, memory revisions and retry-safe consolidation | New held-out task benefits from previous feedback; no generalization from silence; correction defeats inferred preference; failed learning job leaves the delivered result intact |
| F — Video capability | Add media ingestion, reference roles, source inspection, short treatments, audio/temporal review, versioned edit artifacts and the tools needed to render | The K-pop/anime request produces an actual reviewed video; pacing survives an effects correction; output is judged by the user, not only by export checks |
| G — Long-term assistance and consumer rollout | Reuse standing responsibilities for authorized goal-linked triggers; add consumer identity, isolation, enforced authority, cost limits and retention/deletion operations | Resumption across days, meaningful notifications, revocation, cross-user isolation and restart/retry tests; measured reduction in user management |

Dependencies: A enables reliable reference resolution; B carries intent through execution; C supplies explicit personalization; A–D form the first usable slice. E uses the observations that slice produces. F shares its brief, feedback and review contracts. Consumer isolation/authority work can begin alongside A–D but gates use by additional people; goal-based proactive expansion should follow evidence of useful reactive assistance.

Why website first: it gives fast observable previews and revision cycles and exercises almost the entire alignment loop with fewer media-production dependencies. It is a recommended first proving ground, not a limitation on EV's general execution path. The video scenario remains an explicit acceptance target.

### Suggested code boundaries

Preserve and extend the current modules. Introduce `assistant-context.mjs` for context assembly, `assistant-conversation.mjs` for conversational decisions, `intent-brief.mjs` for validation/versioning, `assistant-learning.mjs` for background reconciliation, and small workflow-specific inspection/rubric modules. Names are proposals, not existing files.

Extend `assistant-ledger.mjs` for flexible turns, event intake and delivery identities; `assistant-memory.mjs` for typed projections and derivation; `assistant-supervisor.mjs` for brief/input state; `assistant-worker-service.mjs` for checkpoints and revised execution; `openclaw-worker-adapter.mjs` for the transport bridge; `ev-quality-gate.mjs` for criterion-specific evidence. Update `server.mjs` and `assistant.js` for artifact-linked conversation, previews and corrective feedback.

Use backward-compatible SQLite migrations and explicit schema versions. Existing tasks without a brief retain their legacy execution semantics; do not reinterpret running work during migration. Build manifests with actual consumed context, check current revisions before dispatch, and reject stale memory jobs. Extend current task events/commands and use a transactional outbox for cross-store delivery where atomic updates are otherwise impossible. A new message queue service is not needed for the first slice.

Durable acceptance comes before dispatch: persist the user message and intended action, enqueue execution idempotently, then acknowledge it. Worker completion produces an EV event; the conversation controller decides what to say and what to learn. This allows the same logical assistant to wake for user messages and task events without a permanently open model call.

## 7. How to prove this is alignment, rather than more machinery

Create a small replay corpus of roughly 20 multi-turn scenarios, including actual artifacts and explicit feedback. Keep the user's unspoken preference as evaluation information—not secretly inserted into the model context. Include cold starts and changed preferences, not only favorable history.

Compare: the current manager; manager plus conversation continuity; plus explicit scoped memory; plus learned hypotheses. Hold execution tools, model and practical budget comparable. This reveals whether improvement comes from continuity, examples, inference or extra compute.

Measure first-result usefulness, necessary user corrections, user minutes spent managing/rechecking, time to a usable artifact, unsupported assumptions, wrong scope generalizations, question usefulness, latency and total cost. Human judgments must include the actual artifact. A model critic score cannot establish that the owner likes the result.

Required cases include:

- Vague request with no history, with relevant history, and with misleading old history.
- Two concurrent tasks and ambiguous “that”; two pending questions and ambiguous “yes.”
- Current instruction conflicting with an old preference; one-project exception; changed or paused goal.
- “I dislike this version” without a reason; positive feedback limited to pacing; silence after delivery.
- User correction during execution; restart while waiting for an answer; duplicate completion/answer delivery.
- Worker discovers the brief is infeasible; reviewer unavailable; budget exhausted with useful partial work.
- Malicious text in a reference; another user's material; stop-use/erase while a worker or learning job is active.
- Website that looks better but breaks a form; video that exports correctly but has poor pacing or audio.

Proposed first-slice gate: all deterministic routing/revision/recovery cases pass, no authority or scope violations in the suite, and the user rates at least 4 of 5 real artifacts useful with no more than one major directional correction each. Also demonstrate lower management time than the same tasks under the current manager. These are pilot thresholds to calibrate, not claims of statistical generalization. Follow with a week of actual use and inspect recurring mismatches.

## 8. Immediate checkpoint

Verified foundation: a working local manager architecture, durable task/memory primitives, 150 passing existing tests, and saved live execution evidence. Unverified product claim: EV understands a person's vague request better over time and produces creative work they prefer with less supervision.

The next useful implementation is the A–D slice: one continuing conversation can identify the artifact, form a clear provisional brief, resolve a consequential aesthetic choice, delegate and review a website revision, and remember a scoped correction that improves the next request. Build automatic consolidation and the video workflow against that demonstrated loop. Keep provider catalogs, an unrestricted agent hierarchy, a new graph database and broad personality profiling outside the first slice.
