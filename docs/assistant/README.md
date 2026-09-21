# EV — personal assistant direction

Date: 2026-09-21 · Status: active product direction; Phase 1 durable-conversation implementation underway

**EV is a persistent personal assistant whose continuing purpose is to understand you, help you pursue what matters to you, and become better at working with you through experience.**

Its personal model covers your goals, circumstances, intentions, knowledge, ways of thinking, preferences, and working patterns. A separate relationship model shapes EV's evolving character and approach to helping you. Searchable history, graphs, and indexes provide the evidence underneath these models.

The browser opens into one ongoing conversation. Work continues independently of that conversation and of the browser tab. Tasks, evidence, connections, memory, and permissions remain inspectable through an expanded view. Operating a fleet is no longer the user's job.

The long-term environment is EV's own isolated computer, connected to your host through limited SSH capabilities and to user-selected services through plugins. V1 includes one real connected standing responsibility and, when that workflow requires it, one narrowly brokered browser lane. Broad desktop operation, application installation/removal, and autonomous resource management remain later-version capabilities.

This direction supersedes the *future product direction* in `docs/PRODUCT_BLUEPRINT.md` and the prototyping-workbench proposal. Those documents remain historical evidence. The running root application now contains the first durable-conversation slice; the old terminal workstation is a separate developer view.

## Read the plan

| Document | What it decides |
| --- | --- |
| [Product and website specification](PRODUCT_SPEC.md) | Main chat, nonblocking interaction, task detail, artifacts, connections, memory controls, and UX acceptance criteria |
| [Personal understanding and evolving character](PERSONAL_MODEL.md) | What EV learns about you, how it prioritizes information, useful curiosity, a revisable theory of mind, and how its working personality adapts |
| [System specification](SYSTEM_SPEC.md) | Pi integration, durable supervisor, data model, concurrent work, recovery, sandbox, vault, connector and browser boundaries |
| [Communication flow review](COMMUNICATION_REVIEW.md) | Gaps and proposed contracts for EV's inbox, contextual worker updates, questions, replies, and task resumption |
| [Memory infrastructure and research](MEMORY_RESEARCH.md) | Evidence, retained history, indexing, graph organization, consolidation, revision, and deletion supporting the personal model |
| [EV's own computer and access model](COMPUTER_ENVIRONMENT.md) | Future desktop/browser/app autonomy, resource lifecycle, limited SSH host access, plugins, vault boundaries, and permission levels |
| [Build and migration plan](BUILD_PLAN.md) | What to reuse, implementation order, bounded research spikes, release gates, and first vertical slice |
| [Adaptive implementation and real-use test plan](EXECUTION_PLAN.md) | Phase-by-phase build, computer-use verification, real-task scorecards, lag diagnosis, and evidence-driven replanning |
| [Real-use evaluation log](EVALUATION_LOG.md) | Observed task performance, limitations, and decisions carried into later phases |
| [Interface concept](interface.html) | Interactive illustration with sample data: chat, background work, task detail, memory, connections, and artifact preview |

The interface concept is a design prototype. Its tasks, connection states, and results are illustrative; it does not run agents or connect accounts. Its Memory pane predates the richer personal-model revision and demonstrates only basic provenance/correction controls. The revised product and personal-model documents define the intended “Understanding you” experience.

## The central decisions

1. **One assistant, many durable tasks.** Conversation identity, task identity, and Pi session identity are separate. Opening another conversation does not reset EV's knowledge or stop work.
2. **Pi executes; EV manages.** Pi handles model/tool turns and session continuation inside an isolated runtime. EV owns task truth, scheduling, access, recovery, verification, and user communication.
3. **Understanding the person drives learning.** EV organizes experience around your goals and ways of working, revises its understanding, and adapts what it does and how it collaborates. History and indexes support this process.
4. **Access is granted outside the agent.** Secrets, connector authority, and authenticated browser control sit behind brokers. The model cannot enlarge its own permissions.
5. **Progress comes back through chat.** Results, meaningful changes, and decisions appear as attributed updates; detailed traces remain available when wanted.
6. **EV inhabits its own environment.** Its future work computer is broadly manageable by EV; access to the user's host and connected accounts remains separately scoped. Credential and permission authority stays outside the reach of the agent-controlled guest administrator.
7. **Autonomy starts with a standing responsibility.** A watched source, trigger, permitted preparation, action boundary, freshness rule, interruption threshold, budget, and expiry form one inspectable mandate. Proactivity is not inferred from personality or a vague request to “be proactive.”
8. **Optimize verified outcomes, not agent activity.** Measure time, cost, interruptions, retries, and context growth per useful completed responsibility. A faster reply or a busier worker is not automatically better assistance.

## The defining interaction

> You: Keep an eye on the launch tracker. Prepare a concise briefing when something material changes, and draft the next useful artifact. Ask before publishing or messaging anyone.
>
> Later, with the browser closed, the launch source changes.
>
> EV: The launch date moved and the call to action changed. I updated the storyboard draft and checked it against the current brief. Publishing is still waiting for your approval.
>
> You, while that work is active: Also compare the two headline options.

The standing responsibility observes only the selected source, applies a current brief and explicit collaboration guidance, prepares reversible work, verifies the artifact, and stops at the bound action limit. The independent headline request is still accepted while work runs. Restart, correction, approval, and result delivery all preserve their identities and receipts.

## Evidence and limits

The repository originally exposed a tmux workstation, rule-based companion routing, a JSONL event store, and an explanation/capability lab. Phase 1 replaced that default surface with one SQLite-backed conversation and honest `not_executable` task records. Phase 2 adds one bounded, supervised Pi-worker path for the exact launch-brief task, including replay-safe task commands, cancellation, restart recovery, verified artifacts, and reload-safe UI state. Phase 3 adds explicit, provenance-linked personal guidance with revision, stop-use, erase, and exact context manifests. Phase 4 adds one inspectable, expiring, revocable read-only GitHub PR responsibility. Its three-change connected canary, restart recovery, stale/no-data fault, injection boundary, and post-revocation source change are recorded in the evaluation log. This is one narrow alpha connector, not a general plugin or autonomous browser system.

Pi 0.84.4 was verified on this host on 2026-09-19. Its installed package is `@earendil-works/pi-coding-agent`; current upstream URLs redirect from `badlogic/pi-mono` to `earendil-works/pi`. No live Pi execution, sandbox escape tests, connector authentication, or memory benchmark was run for this planning task.

Muse's published product account informs the conversation design; its security account informs the separation of agent and authority. These are published descriptions, not independent verification of its implementation. [Muse product design](https://introducing.muse.ai/), [Muse security architecture](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse).

Instinct is a reference for the experience of delegating through messaging. The user reports using its WhatsApp interface; its public site describes connected apps/devices and text/call interaction. Its backend is unknown and is not assumed in this plan. [Instinct](https://instinct.com/).

## Concept validation

The interface was inspected in the browser at 360px, 736px, and 1024px widths, including light and dark appearances. Workspace expansion, task detail, pause, steering feedback, storyboard preview, memory correction, connection preview, and local message submission were exercised. The inline script passes a syntax check, document links resolve locally, and the final page reported no console errors. These checks validate the design concept only; live agents, connected accounts, accessibility conformance, and memory quality remain build-stage verification.
