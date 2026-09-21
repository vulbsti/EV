# EV personal assistant — build and migration plan

Date: 2026-09-21 · Status: active sequence; Phase 1 durable-conversation slice implemented and under verification

Revised scope: [personal understanding and EV's evolving character](PERSONAL_MODEL.md) define the learning goal. [EV's own computer](COMPUTER_ENVIRONMENT.md) defines the long-term environment. V1 must prove that the combined system removes one continuing responsibility from the user's plate; it is not enough to ship chat, task, memory, connector, and security primitives separately. Mature adaptive personality and full computer/resource autonomy remain later capabilities.

## 1. Current state, verified in this checkout

Repository HEAD inspected: `aa40c9d` (`feat: add executable capability lab`). Existing untracked work included an EV rationale/HTML blueprint and prototyping-workbench documents; this plan leaves them intact.

| Existing code | Current behavior | Disposition |
| --- | --- | --- |
| `apps/web/assistant.*` | Default conversation surface with reload/restart persistence | Continue only durable intake/reconnect work; keep it free of terminal controls |
| `apps/web/index.html`, `app.js`, `styles.css` | Terminal wall and pane/session controls at `/workstation`; old queue removed | Retain only as an explicit developer view during migration |
| `apps/daemon/server.mjs` | Local HTTP service, tmux input/spawn, snapshots, explanation and lab APIs | Extract reusable HTTP/error patterns; new authenticated assistant API must not expose the old control routes |
| `apps/daemon/lib/assistant-intake.mjs` | Deterministic Phase 1 intake and truthful `not_executable` responses | Replace with a coordinator only after durable truth gates pass |
| `apps/daemon/lib/assistant-ledger.mjs` | SQLite messages, intents, tasks, assistant events, and client-ID idempotency | Add reconnect/outbox semantics before worker integration |
| `apps/daemon/lib/store.mjs` | Historical JSONL evidence for workstation/lab features | Retain as original audit evidence; do not use it as assistant task truth |
| `apps/daemon/lib/evidence.mjs`, `attention.mjs` | Evidence normalization, redaction, heuristic attention | Reuse after tests/review; heuristic pane activity never becomes task completion truth |
| `apps/daemon/lib/explainer.mjs`, `presentation.mjs` | Evidence-linked explanation and structured presentation | Optional “Explain this result” tool/detail view, outside the main product loop |
| `apps/daemon/lib/experiment-runner.mjs`, `lab/*` | Executable capability experiments, fixtures, receipts | Reuse the evidence-driven experiment pattern for Pi, memory, sandbox, and connectors |
| Installed Pi | `@earendil-works/pi-coding-agent` 0.84.4 | Pin and validate inside an isolated worker image |

The prototype documentation's historical test counts are not freshly executed results for this proposal. No application regression run is claimed; only planning artifacts and their interface concept are changed here.

## 2. What to stop building

Stop treating terminal navigation, fleet maps, the voice companion boundary, or a prototyping workbench as the main EV product. They can survive as optional capabilities if they help complete a user task.

Do not extend the existing `awaiting_orchestrator` queue as though it already supervises work. Do not relabel process activity as progress. Do not build a marketplace before one connector completes a real task reliably.

## 3. First vertical slice: launch stewardship

Build one connected standing responsibility, not only a prompted storyboard task. The recommended default is a selected Notion launch tracker or an equivalently bounded source chosen before implementation. Provider choice may change, but the acceptance journey may not be weakened into synthetic chat-only work.

1. Connect one selected source and persist an initial launch brief, source cursor/revision, project, and task.
2. User creates a responsibility: watch that source, prepare a concise briefing when a material launch fact changes, draft the next useful artifact, and ask before publishing or messaging anyone.
3. EV renders the mandate for review: watched resource, trigger/poll interval, freshness rule, permitted preparation, forbidden/approval-required effects, budget, notification destination, expiry, and no-data behavior.
4. While a Pi worker is active, the user asks for the launch status and immediately requests a headline comparison. Both messages remain usable and independently attributable.
5. With the browser closed, a real provider event or bounded reconciliation poll observes a changed launch date or call to action. Duplicate delivery of the same event creates no duplicate work.
6. EV wakes from the event, loads current task/person/relationship/capability revisions, treats connected content as untrusted evidence, and records whether to speak now, update quietly, ask, or defer.
7. A supervised Pi worker prepares a storyboard plus script against the new brief. It returns evidence and an artifact; the supervisor verifies required sections and applied brief/source revisions.
8. The user changes the reel length while it runs. Command delivery and application are distinct; an old artifact remains an earlier version.
9. EV posts one useful update and the verified draft. A publish/send action is blocked behind a trusted approval card bound to destination and payload.
10. Restart while work or an input request is pending, answer from an allowed conversation, and resume once from the correct checkpoint.
11. Correct one scoped preference, start a new conversation, and verify that the next draft uses the correction without leaking unrelated project context.
12. Revoke or expire the standing responsibility; later source events cannot start work or use its grant.

This slice proves durable intake, an executable attention policy, source synchronization, real supervised execution, steering, context reconstruction, explicit personal guidance, artifact verification, restart recovery, scoped authority, and conversational return. It does not claim mature theory-of-mind inference, general browser control, or broad computer autonomy.

## 4. Delivery stages and exit gates

Effort ranges below are planning estimates for one experienced full-time engineer with AI assistance. They are not calendar commitments. Provider compatibility, sandbox hardening, account approvals, and the memory experiments can widen them. Research can run alongside work that does not depend on its answer.

The stages below describe the architectural dependency order. [The adaptive implementation and real-use test plan](EXECUTION_PLAN.md) is the execution authority: it breaks these stages into smaller usable phases, requires computer-use and real-task evidence, and rewrites each next phase from the previous phase decision. If the two documents appear to conflict, do not implement the broader stage until the narrower execution-plan gate has passed.

Stages 0–4 define the initial personal alpha with fixed scoped execution. A connector and standing responsibility move into the critical path rather than arriving after an internally complete chat/task stack. Stages 5–7 are later releases. The richer person-learning research can proceed independently of the full computer capability.

| Stage | Indicative effort | Build | Exit evidence |
| --- | --- | --- | --- |
| 0. Contracts, model and boundary spikes | 4–7 working days | Pin Pi and candidate models; validate RPC; define responsibility/attention/mandate contracts; select the first source; prove isolated execution and credential boundary | Real isolated Pi run, matched model/harness receipts, steer/cancel/restart receipts, denied host/egress probes, selected workflow decision record |
| 1. Durable companion and responsibility | 5–8 days | Chat shell, messages/intents/tasks DB, inbox/outbox, resumable SSE, conversation checkpoint, standing-responsibility and attention-decision records | Two rapid inputs, source trigger and worker report are replayed without duplicate tasks/messages; mandate is inspectable and revocable |
| 2. Real managed execution and source observation | 7–12 days | Scheduler, Pi adapter, checkpoints, scoped workspaces, read path for the first connector, provider reconciliation, artifact verification, cancellation | Source change starts the launch-steward flow with a real Pi worker; restart, stale data, duplicate event and uncertain outcome are exercised |
| 3. Bound action and initial personal context | 7–12 days | Credential lifecycle, typed write/draft operation, deterministic grant checks, trusted approval UX, explicit goals/preferences/collaboration view, corrections and scoped context | A useful connected artifact is prepared from current source and person guidance; approval is bound to payload/destination; no token reaches worker/session/logs |
| 4. Personal alpha and narrow browser lane | 6–10 days | Complete the vertical slice; add a narrowly brokered authenticated-browser operation only if the first workflow cannot finish through the typed connector; outcome/attention dashboard for evaluation | Full launch-steward journey passes; browser lane, if present, passes takeover, injection, secret and egress tests; cost and interruption metrics are reported per verified outcome |
| 5. Later: broader browser and creative execution | 6–10 days for a bounded spike; release scope follows results | Expand EV-owned browser/work desktop, fixed supported creative tools and render jobs | Broader authenticated browser boundary tests; playable rendered reel with resource/cancel receipts |
| 6. Later: personal learning and initiative | Research and longitudinal pilot; estimate after initial comparison | Revisable person hypotheses, EV's learned working style, useful open questions, reflection, selected memory infrastructure | Better assistance in held-out situations, correction recovery, useful initiative, user feedback and rollback |
| 7. Later: self-managed computer | Separate architecture/compatibility spike; not estimated as a V1 feature | Broad work-guest control, install/remove applications, resource lifecycle, restricted SSH host bridge | Install/use/export/cleanup journey, concurrent resource leases, host-scope enforcement, recovery and vault/control isolation under guest root |

A dependable personal alpha is more likely a multi-week effort than a UI rewrite. Do not sum the low ends and present that as a release promise. A stage exits only with a user-visible increment toward the connected responsibility; infrastructure that has not entered that journey is incomplete stage work.

## 5. Stage 0 experiments

### Pi compatibility

Use a disposable task directory and test provider, with bounded spend. Capture package/model/provider versions. Test prompt acceptance versus completion, tool-result continuity, event framing, active steering, idle follow-up, clearing queues, abort, and retained-session restart. Confirm extension loading and tool restriction behavior.

Acceptance: replayable event/receipt bundle; no success inferred from exit code alone; no orphan child process after cancellation; clear account of what cannot be resumed. The installed CLI version is known, but these behaviors remain to be live-tested for EV.

### Model and harness outcome comparison

Compare at least one strong coordinator configuration and two task-worker configurations on the exact launch-steward fixtures. Hold tools, source data, brief, context budget, and objective checks constant. Include rapid-message routing, source-change interpretation, first-draft quality, tool use, long-trajectory recovery, stale-context correction, prompt injection, and escalation behavior.

Record all model calls involved in a useful outcome: main response, worker steps, compaction, retrieval, memory extraction, review/classification, retries, and post-turn work. Measure time and cost to verified outcome, correction count, unnecessary questions, approval precision, context bytes/tokens, cacheable-prefix stability, tool schemas advertised/discovered, and failure recovery. A fast first token or low per-token price is not the decision metric.

Test a small stable coordinator instruction/tool prefix plus task-relevant dynamic capability discovery against a full static catalog. A dynamic catalog wins only if whole-task cost and reliability improve; moving schema bytes into later discovery is not itself an optimization.

Acceptance: a versioned evaluation bundle identifies the selected coordinator/worker defaults, fallback conditions, context/compaction policy, known regressions, and maximum budgets. No architecture claim of model interchangeability is made.

### Sandbox and credential boundary

Choose the isolated EV appliance boundary and a fixed unprivileged work environment. Probe host-home access, symlink escape, raw networking, private IP/metadata destinations, DNS/redirect bypass, mounted sockets, fake-secret leakage, and injected plugin code. Reserve the later ability to place a broadly administered work guest beside protected control services; V1 does not need an autonomous desktop or guest root.

Acceptance: denied operations are blocked by runtime policy even with a deliberately uncooperative model/tool script. Credential setup works through a dedicated service and the worker receives only connection references. Do not onboard sensitive real accounts before this gate.

### First workflow and mandate

Select one repeated, currently valuable launch workflow before implementing general connector infrastructure. Default recommendation: a selected Notion launch tracker, with API polling or events as the source, a briefing and storyboard draft as reversible outputs, and publish/send actions outside the automatic boundary.

Write the concrete mandate fixture first: resource IDs, trigger, material-change rule, source freshness limit, prepared outputs, allowed operations, always-ask operations, maximum run/spend/interruptions, notification destination, expiry/review, and no-data behavior. Define provider reconciliation, stable object mapping, deduplication, echo suppression, and revocation behavior.

Acceptance: the same fixture drives mock, fault, and real-provider runs. If Notion is not the selected provider, replace it with one equally concrete bounded workflow rather than restoring an abstract “first connector later” milestone.

### Two research tracks: personal understanding and memory infrastructure

For infrastructure, an initial 5–8 working day spike can build a replay harness and compare B1/C1/C2; add temporal graphs for relevant cases. See [infrastructure protocol](MEMORY_RESEARCH.md#11-research-protocol).

For personal understanding, compare history-only, explicit person views, revisable contextual models, and relationship adaptation while holding retrieval constant. Test first-draft fit, next-action selection, prioritization, useful questions, temporary exceptions, and changing circumstances. See [personal-model protocol](PERSONAL_MODEL.md#11-research-must-test-understanding-not-just-recall). The target is evidence that EV understands and helps this person better, not merely that it retrieves more facts.

If no complex backend clearly improves utility, ship explicit personal understanding, source-linked observations, corrections, and scope/deletion first. The initial replay suite must include the launch-steward journey: changed source facts, a scoped style correction, an open commitment, and a later wake with no recent transcript. Keep the richer learning goal; defer autonomous inference/adaptation until evidence supports it. Selecting a simpler index does not reduce the product to search.

## 6. Proposed module layout

```text
apps/
  assistant-web/        conversation, work detail, memory, connections
  assistant-daemon/     API, auth, intake, coordinator, SSE
packages/
  contracts/           versioned commands, events, receipts, schemas
  store/               migrations, transactional projections, outbox
  supervisor/          scheduler, leases, budgets, checkpoints, recovery
  responsibilities/    watched sources, triggers, mandates, attention decisions
  pi-adapter/          RPC transport and normalized lifecycle
  personal-model/      person understanding, relationship policy, EV identity
  adaptation/          useful open questions, reflection, outcome-linked changes
  memory/              evidence, claims, indexes, context, consolidation
  environments/        work-computer inventory, jobs, leases, later app lifecycle
  host-bridge/         later restricted SSH transport and typed host capabilities
  policy/              deterministic mandates, capability checks, grants, action bindings
  connectors/          typed adapters and isolated worker launcher
  browser-broker/      profiles, snapshots/actions, secure takeover
  artifact-service/    access, verification, downloads, isolated previews
services/
  credential-broker/   vault access and scoped credential use
lab/
  assistant/           end-to-end and fault fixtures
  memory/              replay data, adapters, evaluation reports
```

This is a target layout. Create boundaries as implementation needs them; do not scaffold empty packages as apparent progress. Existing explanation/lab code can be called through narrow adapters after its assumptions are reviewed.

## 7. Suggested implementation tickets

Each ticket should produce observable behavior and evidence, rather than only a service skeleton.

| Ticket | Outcome | Depends on |
| --- | --- | --- |
| EV-01 | Versioned message/task/command/event/receipt, responsibility, mandate and attention-decision schemas | Product/system spec |
| EV-02 | Persistent messages, task/responsibility projections, idempotent inbox, transactional outbox and resumable cursor | EV-01 |
| EV-03 | Chat stays usable during task work; task and responsibility detail reflect authoritative events | EV-02 |
| EV-04 | Isolated Pi worker completes and returns a real file artifact under a measured model/context manifest | Pi/model/sandbox spikes, EV-01 |
| EV-05 | Supervisor leases, resumes, cancels, bounds and verifies work | EV-02, EV-04 |
| EV-06 | Brief revisions, input requests and command delivery/applied receipts | EV-05 |
| EV-07 | Verification, attention decision and attributed completion delivery | EV-03, EV-05 |
| EV-08 | First connector read path, object mapping, source cursor, reconciliation and duplicate suppression | Workflow/boundary spike, EV-02 |
| EV-09 | Standing responsibility wakes EV from a schedule/provider event and obeys freshness, budget, expiry and notification policy | EV-07, EV-08 |
| EV-10 | Explicit goals/person view and collaboration policy with source links, scoped corrections and context manifests | Personal-model and memory schemas, EV-02 |
| EV-11 | Secure connection, deterministic scoped action grant, trusted approval card, revocation and one real prepared/write operation | EV-05, EV-08 |
| EV-12 | Scope-filtered context, post-turn memory proposal, deletion/restore protocol and launch-steward replay cases | EV-10 |
| EV-13 | Complete launch-steward vertical slice and report cost/time/interruptions per verified outcome | EV-06–EV-12 |
| EV-14 | Early narrow authenticated-browser lane and safe takeover only if required by the selected workflow | EV-11, environment spike |
| EV-15 (later) | Broader EV-owned browser/desktop and Blender/video job with cancellation and playable output receipt | EV-05, EV-07, EV-14 |
| EV-16 (later) | Validated reflection/adaptation and longitudinal learned working style with independent reset | Both research tracks, EV-12, personal pilot |
| EV-17 (later) | Broader scheduled/event-driven initiative across several goals and sources | EV-09, EV-13, longitudinal attention evaluation |
| EV-18 (later) | Work-guest install/use/remove and quota/lease management | Strong control/work boundary, environment spike |
| EV-19 (later) | Restricted host SSH and scoped Obsidian/files/repository access | Host-side enforcement spike, EV-11 |

## 8. Migration and rollback

1. Add a product-direction pointer to the repository entrypoint while retaining historical docs.
2. Build the assistant inside an isolated environment alongside the existing prototype. Keep the user's browser as a client and host access as an external capability. Avoid connecting the gateway to unrestricted legacy tmux routes or mounting the host home.
3. Keep historical `awaiting_orchestrator` events in the original audit ledger. Do not import them as active assistant tasks or replay them as newly authorized work.
4. Import history/memory only from selected sources. The existence of a terminal capture is not consent to index every secret or personal detail in it.
5. Use one canonical owner/project/task mapping and validate import counts and references. Preserve the original event export under the retention policy.
6. The default entrypoint now points to the assistant; keep the developer workstation separate and remove it from normal product navigation before any remote or multi-user use.
7. Maintain DB migrations/backups and feature flags for new memory policies. Roll back bad derived memory by revision, without pretending a completed external action was rolled back.

## 9. Verification ladder

Keep these kinds of evidence separate in release notes:

- **Design:** prototype interactions and contract review.
- **Unit/integration:** state transitions, routing, idempotency, correction, deletion, permissions.
- **Runtime:** actual Pi tool work, resume, steering, process termination.
- **Security boundary:** denied host/network/credential access independent of model behavior.
- **Connector/provider:** real OAuth scope, destination checks, idempotency/reconciliation, revocation.
- **Browser:** desktop/mobile/keyboard flows, stream/reconnect, takeover and artifact isolation.
- **Memory quality:** held-out replay outcomes, ablations, latency/cost, known failure cases.
- **Personal understanding:** novel-situation assistance quality, changed priorities, useful initiative, contextual personality, correction recovery and user-assessed helpfulness.
- **Standing responsibility:** real source change, freshness/no-data behavior, attention decision, prepared artifact, correct approval stop, event deduplication, expiry and revocation.
- **Outcome economics:** total time, model/tool/provider cost, retries, context growth, questions and interruptions per verified useful result—not only first-token latency or worker utilization.
- **Model/harness fit:** matched workflow outcomes across coordinator/worker candidates, compaction, dynamic versus static tool exposure, prompt-injection handling, and fallback behavior.
- **Later computer autonomy:** install/use/remove, resource leases, GUI/video compatibility, restricted SSH, offline host behavior and recovery under guest administration.
- **Deployment:** restart, sleep/offline behavior, backups, restore, TLS/auth, monitoring.

The app is ready for daily personal use only when it reliably owns at least one repeated responsibility end to end, preserves it through restarts, stops at its mandate boundary, and communicates partial/uncertain results accurately.

## 10. Decisions still open

| Decision | Working assumption | When it must be resolved |
| --- | --- | --- |
| Always-on location | EV-owned isolated environment, local or remote; host computer is an external connection | Before promising unattended work through physical host sleep |
| Model/provider routing | Select defaults through matched EV outcome tests; retain fallback without assuming interchangeability | Stage 0 model/harness comparison |
| First workflow and connector | Default to a selected Notion launch tracker; replace only with an equally concrete repeated workflow | Stage 0 before general connector implementation |
| Vault implementation | Maintained OS secret store or secret-management component | Stage 0 |
| Memory backend | EV contracts with C1/C2 comparison; graph only if useful | Research decision gate |
| Personal-model representation | Readable person/relationship views plus evidence-linked hypotheses; evaluate deeper structure | Personal-understanding research, beyond the explicit V1 subset |
| Inference and personality adaptation | Explicit collaboration policy first; later contextual evolution with outcomes and correction | Before richer automatic learning is enabled |
| Narrow browser lane | Add one brokered authenticated path only if the selected V1 workflow needs it; no raw CDP/page JavaScript in the authenticated lane | Stage 0 workflow decision, implemented by Stage 4 if needed |
| Full computer stack | Later persistent work guest with broad app control and separate protected authority | Before broader desktop/resource autonomy release |
| Host bridge | Later dedicated SSH identity and host-side scope enforcement; no default host access | Before host integration release |
| Attention policy | Per-responsibility materiality, freshness, interruption budget, quiet hours, expiry and review date | EV-01/EV-09 before proactive delivery |
| Notification channel | Browser/in-app first; closed-browser work need not imply push notification in the first slice | Before closed-tab push expectations |
| Voice and WhatsApp | Later channels to the same assistant/task system | After the browser workflow is reliable |

The workflow, mandate, model defaults, and source freshness rules are no longer deferrable implementation details: they shape the first vertical slice. Decisions concerning actual credentials, provider retention, and external action scope must be settled before their dependent live integrations.
