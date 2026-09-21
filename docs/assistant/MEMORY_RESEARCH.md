# EV memory infrastructure — supporting personal understanding

Date: 2026-09-21 · Status: revised infrastructure proposal; experiments not yet run

Read [EV's understanding of you and evolving character](PERSONAL_MODEL.md) first. That document defines the purpose and subject of learning. This document defines the evidence, storage, organization, and recall mechanisms that support it. Its backend comparisons do not select or validate a model of the person by themselves.

## 1. What “memory” must mean for EV

EV is learning about a particular person and how to help them. Its current understanding of that person's goals, intentions, knowledge, circumstances, and ways of working determines which information matters and which assistance to attempt. Experience can then change that understanding and EV's working style.

The infrastructure must support this learning as well as locating past chats, work, and artifacts. Organizing a large archive is one responsibility. Maintaining a coherent, revisable understanding of the person and relationship is a higher-level responsibility with its own model and evaluation.

Storing messages and retrieving similar chunks does not establish those behaviors. Neither does adding a graph. The system needs explicit rules for what enters memory, how claims change, what is promoted, when a procedure is trusted, and what is forgotten.

Retrieval remains necessary: a finite model context cannot contain all retained history. Embeddings, text indexes, and graph traversal are useful ways to find evidence. The proposed change is to make retrieval one stage in a managed memory lifecycle, rather than treat retrieval as the entire memory system.

“Learns and evolves” means the person's changing circumstances and shared experience alter EV's understanding, information priorities, assistance strategies, and contextual personality. It also includes learning tested procedures. These changes can happen through persistent state and policy revisions without changing model weights. Mature mental-state inference and adaptation remain research targets; evidence management alone does not establish them.

## 2. Research findings and what to borrow

Sources were checked on 2026-09-19. The table separates published mechanisms from EV's proposed use. Reported benchmark wins are not directly comparable across models, context budgets, dataset variants, judges, and ingestion costs. No source is a demonstrated complete solution to EV's combined task, safety, and memory requirements.

| Primary source | Published idea relevant here | Proposed use in EV | Limit or question |
| --- | --- | --- | --- |
| [MemGPT](https://arxiv.org/abs/2310.08560) | Manage several memory tiers around a bounded model context | Explicit context budget, stable core context, recall tools, archival access | Context management alone does not establish truth or forgetting policy |
| [Zep temporal graph](https://arxiv.org/abs/2501.13956) / [Graphiti](https://github.com/getzep/graphiti) | Evolving relationships with temporal provenance | Valid-time and recorded-time fields, entity links, historical queries | Entity merges and automated contradiction handling need EV-specific tests |
| [A-MEM](https://arxiv.org/abs/2502.12110) | Generate atomic notes and contextual links; evolve existing note representations | Candidate associations and revision proposals | Similarity is not evidence of causality; broad autonomous rewrites can drift |
| [Hindsight](https://arxiv.org/abs/2512.12818) / [implementation](https://github.com/vectorize-io/hindsight) | Distinguish facts, experiences, observations, and beliefs; retain/recall/reflect operations | Strong candidate for a reusable memory backend behind EV's contracts | EV still needs permission separation, deletion, task state, and promotion policy |
| [EverMemOS](https://arxiv.org/abs/2601.02163) | Episode formation, thematic consolidation, and reconstructive recall | Test episode-to-project/theme summaries and temporary future-relevant signals | Consolidated narratives must preserve exceptions and source links |
| [Mastra Observational Memory](https://mastra.ai/docs/memory/observational-memory) / [research](https://mastra.ai/research/observational-memory) | Background observation and reflection compress growing histories into an observation log | A strong text-based consolidation baseline and stable context block | Lost source detail and stale compressed claims must be measured; no need to replace Pi with Mastra |
| [Mem0](https://arxiv.org/abs/2504.19413) | Extract and update durable conversational memory efficiently | Include a practical extract/update baseline | Efficient recall does not by itself prove safe belief revision or procedural learning |
| [MemoryBank](https://arxiv.org/abs/2305.10250) | Memory retention and reinforcement inspired by forgetting | Compare time-sensitive retention schedules against utility-based retention | Retrieval frequency can amplify a false memory; biological decay is a hypothesis, not a default truth rule |
| [LongMemEval](https://arxiv.org/abs/2410.10813) | Tests extraction, cross-session reasoning, temporal reasoning, updates, and abstention | External benchmark alongside EV-specific behavioral evaluations | Conversational QA does not cover task recovery, access boundaries, or successful actions |

The newer [Hindsight Memory-PRM preprint](https://arxiv.org/abs/2608.29605) explores learning memory-operation utility from auditable traces and interventions. Track it as a later research candidate, distinct from the Hindsight product above. It does not justify deploying an online self-modifying memory policy before EV has reliable evaluation traces.

**Infrastructure recommendation:** define EV-owned evidence, revision, scope, deletion, and context contracts beneath the person/relationship model. Evaluate a lean EV implementation against Hindsight and a text-observation baseline; add Graphiti for a targeted temporal/relational comparison. Choose a backend from infrastructure results and evaluate personal understanding separately. Do not install several memory platforms and synchronize their competing truth stores.

## 3. State beneath the personal assistant

These are logical responsibilities. Person and relationship views can share the same evidence/revision store; they do not require duplicate independent truth databases.

| Kind | Contents | Update authority | Lifetime |
| --- | --- | --- | --- |
| Source history | User messages, selected tool receipts, artifact versions, external source snapshots | Ingestion; source retention/deletion policy | Retained under explicit policy, never treated as automatically true |
| Person model | Goals, current circumstances, intentions, knowledge, preferences, and contextual working hypotheses | Personal-model service, explicit user correction, evidence-backed reflection | Persistent, scoped, and revisable across conversations |
| Relationship and EV identity | How EV should work with this person; stable charter, learned style, and explicit overrides | Validated adaptation episodes and user instructions | Stable foundation with contextual evolution and independent reset |
| Working state | Current brief, relevant recent turns, plan, next action, tool results | Supervisor and worker checkpoints | Active run and recovery window |
| Episodic memory | Bounded experiences: request, context, action, observed outcome | Memory service from cited events | Durable, with layered summaries |
| Semantic memory | Scoped facts, preferences, relationships, decisions, hypotheses | Validated memory revisions | Until superseded, archived, or erased |
| Prospective state | Commitments, due dates, scheduled follow-ups, dependencies | Task/scheduler transaction | Until resolved/cancelled; never forgotten through ranking decay |
| Standing responsibilities | Watched resources, triggers, mandate versions, attention budgets, expiry/review and notification policy | Responsibility/policy service and explicit user decisions | Until paused, revoked or expired; never recreated from a memory inference |
| Procedural memory | Reusable instructions, preconditions, checks, known failure modes | Evidence-based promotion and regression checks | Versioned; revalidated when tools/environments change |

Prospective state lives in the task database, even if memory links to it. “Remind me next Friday” must not depend on a similarity search recalling the phrase. Pi's saved session is a continuation record, not the entire personal memory of EV.

The main assistant uses a current scoped person view and a collaboration policy, including what matters now and how to help. These are richer than a preferences summary. Project context remains scoped. A worker receives only relevant guidance and evidence; it need not receive the personal history that informed a collaboration strategy.

## 4. Evidence and claim model

Every memory claim has a stable identity and immutable ordinary revisions:

```ts
type MemoryRevision = {
  id: string; memoryId: string; revision: number;
  ownerId: string; scopeIds: string[];
  kind: 'fact' | 'preference' | 'decision' | 'hypothesis' | 'procedure';
  subjectId: string; predicate: string; valueRef: string;
  qualifiers: Record<string, unknown>; // project, audience, situation, exceptions
  epistemicStatus: 'explicit' | 'observed' | 'inferred';
  lifecycle: 'candidate' | 'active' | 'disputed' | 'superseded' | 'archived' | 'erased';
  validFrom?: string; validUntil?: string;
  recordedAt: string; recordedUntil?: string;
  sourceRefs: SourceSpanRef[];
  derivedFrom: string[]; contradicts: string[]; supersedes?: string;
  confidenceBand: 'low' | 'medium' | 'high'; // model score is not calibrated probability
  importance: number; // context/retention priority, never permission or truth
  lastVerifiedAt?: string; reviewAfter?: string;
  sensitivity: string; retentionClass: string; pinned: boolean;
};
```

Source references include message/tool/artifact IDs, the relevant span or structured result field, observation time, author, and trust class. Separate “the user said X,” “a document says X,” and “the tool verified X.” An assistant's earlier output is not independent confirmation of its own claim.

Track world-valid time separately from recording time. “I switched projects last month” is recorded today but applies to an earlier period. A time query can therefore ask either “what was true then?” or “what did EV know then?” Missing dates remain unknown, not invented.

Authority is domain-dependent. The user's current explicit preference wins over a stylistic inference. A live provider receipt wins over a memory about whether an external publication exists. A new web page does not override a user instruction. Duplicate or copied sources do not count as independent support.

## 5. Memory formation lifecycle

```text
scoped event -> source record -> candidate extraction -> evidence validation
  -> entity resolution -> scoped conflict check -> revision commit
  -> index update -> consolidated views -> task-specific context
  -> observed usefulness / correction / new evidence -> later revision
```

### A. Capture

Capture user messages, meaningful task decisions, selected outcomes, and explicit feedback. Preserve enough original source to reconstruct a claim; do not ingest every terminal token or entire connected account by default. No passwords, tokens, authentication codes, or hidden model reasoning enter general memory.

### B. Extract candidates

Use a constrained schema to propose atomic claims, scope, time, and cited source spans. Include a “not worth remembering” outcome. External content is untrusted evidence and cannot install behavior rules merely by saying “remember this.”

Candidates with missing evidence or unverifiable entity references are rejected or quarantined. Extraction cost runs asynchronously except for explicit corrections/remember commands that need immediate consistency.

### C. Resolve and reconcile

Resolve people/projects from canonical IDs and aliases within scope. Preserve ambiguous entities separately; a shared name is not enough to merge them. Entity merge and unmerge are versioned operations with affected references.

Compare the candidate with current claims for the same subject, predicate, scope, and relevant time. Distinguish a true contradiction from an exception, a time change, a different project, or an uncertain observation. Record unresolved disagreement rather than forcing a single confident narrative.

### D. Commit and promote

An explicit user instruction such as “Remember that my launch updates should be short” may enter active memory with its cited scope. An inferred pattern enters as a hypothesis. Repeated independent evidence and useful outcomes may justify promotion; frequency alone does not.

Use transaction/version checks so parallel agents cannot overwrite a correction with an older extraction. Explicit correction or erasure updates a high-priority overlay and increments the context/erase version immediately. Context construction consults that overlay before any stale summary or index.

### E. Consolidate

At an episode boundary, summarize the request, decisions, tested outcome, unresolved questions, and reusable lessons. Periodically synthesize project/entity/topic views from those episodes and active claims. Trigger on meaningful changes or context pressure, not just a nightly timer.

Each summary stores its coverage range, underlying claim/source IDs, omitted detail categories, and a version. Validate preservation of active commitments, explicit exceptions, corrections, and contradictory evidence. Rebuild affected summaries when a dependency changes. A summary-of-summary chain without original evidence access is insufficient.

### F. Learn from use

Record which memory items were actually used in a decision and whether the user corrected the result, the task succeeded, or a verified procedure failed. This can improve selection priorities. Self-generated citations or repeated retrieval do not increase truth confidence by themselves.

Test controlled removal of a memory in offline replay to estimate whether it helped. Correlation between recall and task success is weaker than a matched comparison; do not present it as causal learning.

## 6. Indexing and graph structure

Use a common canonical record model with rebuildable indexes:

- Exact entity/alias index for people, projects, files, and external object IDs.
- Lexical/full-text search for names, decisions, phrases, and identifiers.
- Optional semantic index for conceptual similarity; isolate scopes before candidate selection.
- Temporal index for valid/recorded intervals and deadlines.
- Typed graph edges for relationships and evidence dependencies.

Graph edge families remain distinguishable:

| Family | Example | Meaning |
| --- | --- | --- |
| Association | `related_to`, `mentions` | Useful navigation; no causal implication |
| Evidence | `supported_by`, `contradicted_by`, `derived_from` | Why a claim exists and what invalidates it |
| Time/revision | `supersedes`, `valid_during` | What changed and when |
| Work structure | `belongs_to`, `depends_on`, `produced` | Project/task/artifact relationships |
| Outcome hypothesis | `may_contribute_to` | An explicitly uncertain possible cause, with alternatives/evidence |

Do not silently equate similarity links with causation. Bound traversal by edge types, scope, relevance, and hop count. The graph is a reasoning/navigation structure, not a license to put every reachable personal fact into a prompt.

Start with relational node/edge tables. Compare a dedicated temporal graph backend only if multi-hop recall or update handling improves enough to offset another service, deletion integration, and operational complexity.

## 7. Context construction

For each conversation or worker turn:

1. Resolve identity, allowed scope, task revision, and the context budget.
2. Load nonnegotiable current instructions and explicit correction/erasure overlays.
3. Load the relevant task checkpoint and live commitments from the supervisor.
4. Add the allowed person/relationship view and project context, preserving explicit exceptions, current priorities, relevant knowledge assumptions, and uncertainty.
5. Use the person model's goals and open questions to identify relevant evidence, then retrieve by entity, lexical, temporal, semantic, and typed relationship paths appropriate to the query.
6. Rerank for relevance, current validity, source quality, novelty, and cost; deduplicate copied evidence.
7. Include contradiction/uncertainty markers and source references. Expand original evidence if the summary cannot support the decision.
8. Save a context manifest with versions and chosen references so the answer is explainable and reproducible within retained data.

For a schedule or connected-source wake, also load the current responsibility/mandate version, trigger and source revisions, source freshness, recent attention decisions/notifications, quiet-hours state, and remaining interruption/run/spend budgets. Memory can supply why the work matters and how to help; it cannot supply missing recurring authority.

Keep post-turn memory work off the visible-reply critical path where possible. Record its own model/provider, input evidence range, cost, latency, and commit result. A visible response, memory extraction, consolidation, and durable run settlement are separate outcomes; failure of a background memory proposal must not retroactively turn a delivered task result into a failed task.

A useful prioritization hypothesis is relevance + task importance + evidence quality + freshness + demonstrated usefulness − duplication − context cost. Weights are learned/tuned offline; they are not a scientific law. Permission and scope are hard filters, never terms that a high relevance score can overcome.

No fixed number of “last messages” defines EV's memory. Recent turns help local conversation; the current task, explicit constraints, relevant older decisions, and source evidence determine the rest.

New chats build a fresh working context from shared authorized state. Resuming a task additionally restores its precise checkpoint and pending action registry. These are different operations.

## 8. Worked example: evolving a creative preference

1. During a launch reel, you say “Keep this one monochrome.” Store a task-specific instruction with a source; do not infer a global aesthetic.
2. In several later unrelated briefs, you independently ask for minimal layouts. Propose “often prefers minimal layouts” as an inferred, limited hypothesis with those evidence links.
3. You say “Minimal for product launches, but colorful for travel.” Create scoped active preferences and retire the overly broad hypothesis. Refresh affected summaries.
4. A new travel-reel task receives the colorful preference and the relevant examples. The old monochrome launch is not injected as a general rule.
5. EV successfully renders a vertical video twice using the same validated export recipe. It proposes a reusable procedure with Blender/version, inputs, format checks, and failure cases. It does not generalize the visual style into that procedure.
6. Blender changes or the recipe fails. Mark the procedure for review and use a known working version or ask for help; do not keep treating it as established competence.

This example separates personal knowledge, scoped decisions, and learned execution skill.

## 9. Forgetting, compaction, and deletion

These are separate operations:

| Operation | Changes | Does not imply |
| --- | --- | --- |
| Working-context compaction | Replace active detail with a cited bounded representation | Source destruction or permanent forgetting |
| Memory consolidation | Reorganize episodes/claims into reusable views and lessons | Erasing conflicts or rewriting historical evidence |
| Retrieval demotion/archive | Remove low-value/stale material from normal context | Inability to recover it under retention policy |
| Semantic supersession | Prefer an updated scoped claim while retaining history | The older claim was false at every time |
| Erasure | Delete specified content and its derived copies/index entries | Immediate deletion from an external provider's independent logs |

Retain active commitments, pinned facts, user corrections, and current consent records until explicitly resolved or expired under their own rules. Temporary observations should have review/expiry times. Rarely used but important information must not decay merely because it was not retrieved.

Begin with explainable retention classes and storage budgets, not arbitrary exponential forgetting. Evaluate age/utility-based demotion and periodic review against a no-decay baseline. Protect against popularity loops where a commonly recalled mistaken claim becomes increasingly dominant.

### Erasure protocol

1. Resolve the deletion target and scope. Unambiguous “forget my old address” executes; if it could delete valuable task artifacts/history unexpectedly, show the concrete scope choice.
2. Immediately block the selected content from context with a tombstone and increment `erase_epoch`.
3. Traverse derivation links to claims, summaries, graph edges, embeddings, caches, exported memory files, and source payloads included in the deletion scope.
4. Invalidate active context packages and queued consolidation jobs. Workers using stale epochs must refresh before their next action/model call; terminate/restart sessions if necessary to avoid stale memory reuse.
5. Remove/rebuild derived material, compact affected stores, and record a minimal non-content deletion receipt. Pending ingestion must check the tombstone before committing.
6. Apply the deletion manifest during any restore, before the restored system serves queries. Expire encrypted backups under the disclosed schedule; use envelope-key destruction only where the storage design actually supports it.
7. Verify that recall, history, index rebuild, consolidation, and restoration do not resurrect the material. Report completion and any external-provider retention limits.

“Stop using” may preserve original messages. “Erase” needs source removal/redaction too; otherwise re-ingestion can recreate the memory. The UI must not present these as the same promise. Content sent to an external model cannot be unsent; choose provider retention settings deliberately.

## 10. Procedural learning and bounded evolution

A learned procedure includes its purpose, input schema, preconditions, allowed tools, expected outputs, objective checks, successful and failed examples, environment/version bounds, and provenance.

Promotion path: candidate lesson -> replay on representative fixtures -> compare to current procedure -> review authority/scope -> activate version -> monitor -> retire/rollback when evidence changes.

Allow the assistant to improve templates, task decomposition, retrieval policy candidates, and reusable scoped recipes. Do not let consolidation modify the system's authorization rules, safety boundary, connector code, or global system instructions. Installation or execution of new code follows the ordinary capability process.

An initial success suggests a candidate procedure. High-impact actions require stronger repeatability evidence. Memory is not a mechanism for turning accidental past authorization into permanent access.

## 11. Research protocol

This is the infrastructure track. Run it alongside the [personal-understanding evaluation](PERSONAL_MODEL.md#11-research-must-test-understanding-not-just-recall), which holds evidence access constant and tests whether an evolving person/relationship model improves assistance. A retrieval backend can pass this track while the personal model fails. Report both independently, then evaluate the integrated assistant.

### Questions to answer

R1. Which representation improves future useful behavior under the same model and context budget?

R2. Does a graph materially improve entity/time/multi-hop tasks beyond good source-linked observations?

R3. Does consolidation preserve corrections, exceptions, rare important facts, and active commitments?

R4. Which retention policy reduces cost/noise without losing important context or increasing false beliefs?

R5. Can outcome-derived procedures improve repeat task completion without broadening authority?

R6. Can the entire memory lifecycle honor privacy scope and erasure under concurrency and restore?

### Candidate systems

| ID | Configuration | Purpose |
| --- | --- | --- |
| B0 | Recent context only | Lower-bound baseline |
| B1 | Rolling summary plus retained source access | Simple baseline worth beating |
| B2 | Hybrid retrieval over retained episodes | Measures value of indexing alone |
| C1 | Source-linked observation log + explicit corrections + task state | Lean EV candidate, inspired by observational memory |
| C2 | Hindsight behind the same EV contracts | Reuse candidate for richer structured memory |
| C3 | Temporal graph variant, using Graphiti where compatible | Test the incremental value of time and relationship traversal |

Use the same answer model, task set, inference budget, available source history, and test split. Count ingestion, consolidation, recall, and answer cost. Compare C3 against the best simpler candidate; do not add graph complexity just because it is available. EverMemOS/A-MEM mechanisms can be targeted ablations or later adapters after the first comparison.

### Evaluation corpus

Create a consented/redacted personal-work replay set, plus synthetic adversarial fixtures. Keep development histories separate from held-out people/projects. Feed histories chronologically; future information cannot leak into earlier queries.

Include at least these scenarios:

- Preference change with a project-specific exception.
- Same name referring to two people/projects; mistaken merge and unmerge.
- Old task carried across a new chat, browser close, and daemon restart.
- Rare important fact surrounded by repetitive low-value chatter.
- An assistant's invented claim repeated by another assistant.
- Copied sources falsely appearing independent.
- External prompt injection trying to install permanent instructions.
- Corrected belief while a stale consolidation job is committing.
- Erasure racing with a running worker, reindexing, and restore.
- A successful and a failing procedure on different software versions.
- Data in a private scope that must be absent from another task's retrieval.
- Long inactivity followed by a due commitment.

Run an external LongMemEval evaluation with documented variant/split and per-category outcomes. Use it as a complement to these action and governance cases, not the only score.

### Metrics and decision gates

Measure factual/temporal accuracy, correct abstention, preference compliance, source support, contradiction resolution, inappropriate promotion, scope leakage, erasure resurrection, procedure success, task continuity, p50/p95 latency, total cost, and storage growth.

Report full assistant cost separately from answer-model cost: context construction, retrieval, summarization/compaction, extraction, consolidation, verification, retries, and any review/classifier calls. Include context bytes/tokens and whether the stable instruction/tool prefix was preserved. An optimization must improve cost or latency per verified useful outcome without regressing correction, scope, or commitment preservation.

Proposed initial release gates, to calibrate on the dev set and then freeze:

- Zero known scope leaks, unauthorized promotion of permissions, or erased-memory resurrection in the fixed adversarial suite.
- Every promoted claim and procedure has valid evidence links; missing citations fail schema validation.
- All explicit correction/exception cases pass before autonomous consolidation is enabled.
- Better downstream utility than B1 under a matched budget, with uncertainty intervals and per-category regressions reported.
- No material loss of rare important facts or active commitments under the chosen compaction policy.
- Procedural promotion improves held-out task success or reduces cost at equal success, without granting broader access.

A zero observed failure rate in a finite suite is a release gate, not proof of universal security. Use paired evaluations, repeat stochastic cases, record model/prompt/version hashes, and manually review disputed judgments. Publish negative results too.

### Deliverables of the research spike

1. Dataset manifest and consent/redaction rules.
2. Replay runner with common memory adapter contract.
3. Raw per-case receipts, costs, and context manifests.
4. Ablations: no graph, no consolidation, no utility feedback, no decay.
5. Selected backend and documented failure modes.
6. A decision record for retention, correction, and deletion semantics.

This document establishes a concrete architecture hypothesis and research plan. It does not claim these memory behaviors have already been achieved.
