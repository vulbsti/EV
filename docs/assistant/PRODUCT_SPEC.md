# EV personal assistant — product and website specification

Date: 2026-09-21 · Status: proposed · Companion: [system specification](SYSTEM_SPEC.md)

## 1. Product promise

EV is a personal assistant that learns to understand you and work with you. Its continuing goal is to help you pursue what matters to you, using a growing understanding of your priorities, knowledge, preferences, intentions, and ways of working. Tell it what you want, add another request whenever you like, change direction, and receive results without supervising every worker.

Success is measured by completed useful work, preserved context, correct steering, and fewer interruptions. Agent count, terminal density, and exposed runtime configuration are not product goals.

The first release is a single-owner assistant, accessed through an authenticated browser, with a runtime isolated from the user's personal workspace. Its fixed initial environment may be hosted locally or remotely. The long-term home is EV's own computer, including a browser, desktop, and managed applications; those full computer capabilities are beyond V1. Background work requires its runtime to remain available; closing the browser alone must not stop work.

## 2. Experience principles

- The conversation is home. Returning to EV should feel like returning to the same assistant.
- EV learns what matters to you and how to help. Its understanding influences priorities, actions, questions, and collaboration style, as described in [personal model](PERSONAL_MODEL.md).
- EV stays curious about useful gaps in its understanding, resolving them through authorized context and normal work or a timely question. It does not require the user to fill out a personality profile.
- Sending a message never waits for an unrelated task or for another message's answer to finish.
- EV resolves project and task references using current work and history. It asks only when a consequential ambiguity remains.
- Plans, agents, runs, and tools are managed internally. The user can inspect them without needing to understand them.
- Results are useful objects: a storyboard, document, video, calendar change, tested patch, or concise answer with supporting evidence.
- Remembering is observable and correctable. EV can explain the source of a remembered preference and accept a correction.
- A remembered preference cannot grant permission. Access and consent have independent controls.
- Updates earn attention. Routine retries and token streams stay out of the main conversation.
- Proactivity is represented by inspectable standing responsibilities, not inferred from a personality preference or an unrestricted instruction to “keep an eye on everything.”

Muse describes a main conversation with concurrent background work, optional side chats, editable memory, and structured controls. EV adopts these interaction principles in its own browser design. [Source](https://introducing.muse.ai/).

## 3. Information architecture

### Default: conversation

The collapsed shell has only:

1. EV identity and a short status such as “Working on 2 things.” Clicking it opens Work.
2. One readable message stream.
3. An always-available composer with attachments and, later, push-to-talk.
4. A quiet “Open workspace” control and account/settings access.

A new user sees a brief introduction and can give EV a real task immediately. Connect an app when a task needs it; do not force a plugin checklist before the first conversation.

The stream uses discrete message bubbles or bounded message groups so interleaved requests and updates stay readable. Every background update carries a human task title. Related incremental updates can edit a task card, but substantive new results receive a new message. If the user has scrolled upward, retain their position and show an unread marker.

### Expanded: conversation plus work

Desktop expansion adds a collapsible left sidebar with Conversation, Work, Projects, and History. Connections, Understanding you, and Settings live in its lower section. Selecting a task or artifact opens a detail panel beside the conversation, or a full detail route on smaller screens.

The first Work view contains “Needs you,” “In progress,” and “Recently finished.” It is a list of outcomes, not a graph of workers. A task can be associated with a project but does not require one.

The task detail includes:

- Objective and latest verified state, with update time.
- Current step, next step, and blocker when known.
- Deliverables and their verification state.
- Plan milestones, not invented percentage completion.
- Pause, resume, cancel, and a “Tell EV about this task” composer shortcut.
- Collapsed activity, permissions used, and worker/run detail for inspection.

A standing responsibility detail adds the watched source, trigger, freshness/staleness policy, permitted preparation and actions, approval boundary, reporting destination, interruption threshold, budget, expiry, and recent runs. It is an ordinary durable product object, not hidden prompt text.

History searches conversations, tasks, decisions, and artifacts with source links. Optional topic conversations are organizational views over the same assistant identity. A clearly marked private conversation has explicit memory and access rules; “new chat” alone is not a privacy boundary.

### Routes

| Route | Purpose |
| --- | --- |
| `/` | Ongoing main conversation |
| `/c/:id` | Optional focused conversation, with visible scope |
| `/work` | Tasks by attention and state |
| `/work/:taskId` | Task, milestones, outputs, and activity |
| `/projects/:projectId` | Project brief, files, decisions, and tasks |
| `/history` | Searchable retained conversation/work history |
| `/connections` | Connect, inspect permissions, repair, or disconnect apps |
| `/memory` | Understanding you: priorities, ways of working, EV's collaboration style, uncertainty, sources and correction |
| `/settings` | Notifications, storage, providers, budgets, and access |

Routes are specifications, not endpoints already implemented in the current app. Terminal and experiment views belong under an optional developer area, excluded from normal navigation.

## 4. Message behavior

Every message is saved with an idempotency key before its work begins. “Received” means saved; “Working” means an execution lease actually exists. EV must not claim a task has started just because it has been queued.

One message can contain several intents. Each intent receives a stable request ID and links to the resulting task, query, clarification, or steering command.

| Intent | Example | Behavior |
| --- | --- | --- |
| Conversation | “Help me think through this idea.” | Discuss; create work only if needed |
| Status | “What's happening with the launch?” | Read current task state; say when it was checked |
| New work | “Also design a reel.” | Create an independent task and acknowledge its scope |
| Steering | “Make that version more playful.” | Resolve target and revise its brief; record delivery to the worker |
| Priority | “Do the reel first.” | Change scheduler priority; explain any resource dependency |
| Control | “Stop the reel.” | Stop that task and its children, leaving other work running |
| Memory correction | “That style was only for this client.” | Narrow the preference and invalidate broader derived claims |
| Access | “Use my Notion workspace.” | Open the appropriate connection/grant flow |

The initial design favors immediate deterministic receipt and a short EV acknowledgment. Long reasoning is delegated. Independent input can be routed while another response streams. Related directives are ordered so “make a reel” followed by “make it 20 seconds” updates the same task before a conflicting artifact is committed.

Use explicit reference chips when helpful: “For: Launch reel.” The default composer still accepts plain language. When “stop that” refers plausibly to several consequential tasks, show a short choice among the named tasks; unaffected work continues.

## 5. Required end-to-end journeys

### A. Two successive requests

1. The website-launch task already exists.
2. User sends “What's the update on the launch?”
3. Before EV finishes answering, user sends “Also design a new reel for it.”
4. Both inputs immediately appear as received. The status query reads the launch task projection.
5. The reel brief links to the launch project and its approved messaging. Missing format can use a stated reversible draft assumption; a missing external publishing destination does not block storyboarding.
6. EV launches an isolated Pi run for the reel and can answer other questions.
7. The worker returns a storyboard artifact. EV verifies required sections and opens the preview from the message.
8. Rendering and publication are separate deliverables. A storyboard is never reported as an exported video.

### B. Steering while work runs

“Use Blender for the product shot, keep the same script” revises the task, preserves the script, and requests the Blender capability. If Blender is unavailable, EV can finish the script and report that rendering is waiting. The UI distinguishes “Change sent” from “Change applied.”

### C. Return after closing the browser

The daemon continues working. On reconnect, the browser replays messages and task changes after its last event cursor. It shows one result per deliverable, without replaying every intermediate status. If the host was asleep, EV states that execution paused and resumed rather than claiming continuous activity.

### D. A new conversation knows previous work

“Use the visual direction we settled on last week” resolves the earlier decision, opens its evidence if asked, and applies it in the new task. It excludes private or unrelated project data. Uncertainty about which visual direction produces a focused clarification.

### E. A task needs permission

EV prepares the concrete action first, such as a publishable Notion document. A trusted approval card shows destination, action, affected content, and scope. Editing the payload invalidates approval. Already authorized in-scope actions proceed without repetitive prompts.

### F. A remembered preference changes

User says, “I prefer concise updates except when we are discussing architecture.” EV stores the exception rather than overwriting everything as “concise.” Later, it uses that scoped preference and can show the source conversation. An inferred preference stays visibly tentative until supported.

### G. Understanding changes the assistance

After the user has repeatedly asked to see creative work before discussing it abstractly, EV brings a small concrete preview to the next creative brief. When the user asks an architectural question, it can instead explain in depth. If the user changes goals or circumstances, EV revises its approach rather than applying an old preference everywhere. V1 supports explicit instructions; this fuller learned adaptation belongs to a later evaluated release.

### H. A standing responsibility completes useful work

1. User connects one selected launch source and says what EV should watch, prepare, and never do without approval.
2. EV shows a structured responsibility card: source, trigger, permitted preparation, consequential-action boundary, freshness rule, budget, reporting destination, and expiry/review date.
3. A schedule or normalized source event wakes EV while the browser is closed. A new event ID and source revision prevent duplicate work.
4. EV compares the change with current task truth and the latest explicit person/working-style guidance. It does not treat source content as instructions.
5. A supervised worker prepares the next useful artifact and verifies its required fields. If the source is stale or unavailable, EV reports that instead of relying on old data.
6. EV records an attention decision: notify now, update quietly, batch for a digest, ask a question, or take no action. The decision cites the responsibility, evidence, and current task/person revisions.
7. A draft or reversible in-scope change may proceed under the mandate. Publishing, sending, purchasing, deletion, or a changed destination requires the bound approval flow.
8. Restart, duplicate event delivery, a concurrent unrelated request, and mandate revocation do not duplicate the artifact or let stale work escape its scope.

## 6. Visual direction

Use a calm reading surface, generous spacing, restrained color, and a compact EV identity. Default theme follows the browser with accessible light and dark palettes. A distinctive wordmark and a small presence indicator are sufficient; an animated avatar is optional and deferred.

The conversation column is roughly 680–760 CSS pixels wide on large screens. Expansion should retain the reading width where possible rather than squeeze it between permanent dashboards. On mobile, task and artifact detail become navigable full-width views with a clear return to conversation.

Use one accent for focus and selected state. Status always has text; color alone does not convey blocked, running, or complete. Artifact previews receive more space than metadata. Empty space is intentional: no initial wall of tasks, terminals, graphs, metrics, or suggested prompts.

The [interactive concept](interface.html) illustrates these states with sample content. The final application must bind them to real events and clearly show stale/offline data.

## 7. Artifacts and evidence

Messages can contain document, image, video, link, code-change, or interactive preview cards. Each card has a name, version, originating task, and a verification label appropriate to the output. Download and open are direct actions.

Generated HTML runs on a separate origin in a restricted frame. It cannot read EV credentials, storage, or APIs. External links and script/network permissions are separately controlled. A beautiful preview is not permission to execute arbitrary code in the assistant's origin.

Task evidence is a concise receipt: what changed, where it lives, what was checked, and what remains incomplete. Detailed tool traces are optional. Hidden model reasoning is not part of the product's activity log.

## 8. Connections and access UX

The app directory presents useful actions, not protocol names: “Find notes,” “Create a document,” “Render a scene.” A connection page shows provider, account/workspace, approved operations, data scopes, expiry/health, and revocation.

Connecting an account and granting authority to use it are distinct. OAuth scopes may be coarse; EV should still constrain tool operations and destinations. Plugin installation cannot silently enable additional credentials or operations.

Examples:

- **Notion:** select allowed pages/workspaces; search/read; create drafts; controlled publication/update.
- **Google Workspace:** select the account and service scopes; inspect documents/calendar/mail; grant individual write operations separately.
- **Obsidian:** select a vault/folder or approved bridge; define read/write and learning scope separately.
- **Blender, later release:** run inside EV's work computer; specify input/output locations and resource limits.
- **Browser/computer, later release:** use EV's own desktop and applications; watch, take over, then explicitly hand control back.
- **Host through SSH, later release:** connect a specific machine with limited paths/operations. Sharing an export folder does not grant the rest of the host.

Permission presets are Disconnected, Observe, Prepare, Act within scope, and Manage EV's computer, applied separately to each resource. Existing in-scope grants should avoid repeated prompts. Managing EV's computer does not grant authority over connected accounts or the user's host.

Passwords and API tokens are entered into a secure connection form served by the credential service, never into an agent-authored chat form. The conversation only receives a connection reference and health state. No secret preview or “show token” action appears in agent-visible content.

## 9. Understanding you

The normal interaction is conversational: “Remember this for the launch,” “Why did you assume that?” and “That's not how I work.” EV's understanding becomes visible mainly through better help. The supporting view lets the user inspect and change that understanding.

Group it into What matters now, How you work, How EV works with you, and What EV is still learning. Include current goals, intentions, knowledge assumptions, contextual preferences, and EV's learned working style. Each interpretation shows its scope, source, and whether it is explicit, observed, or inferred. Project/history search remains separately available. Avoid presenting the person as a collection of psychological scores.

Allow “only in this situation,” “this has changed,” “ask me less,” and “reset how you've learned to work with me.” Resetting EV's collaboration style need not remove project history. Pausing inference in a conversation does not stop its authorized task execution. The model and research are specified in [personal model](PERSONAL_MODEL.md).

Distinguish three actions with clear copy:

- **Stop using:** remove from active context; retain source/history for possible recovery.
- **Correct:** create a revision and refresh dependent summaries.
- **Erase:** remove selected source content and its derived copies under the deletion policy; disclose backup/provider retention limits.

An instruction to forget is treated as a real memory operation. EV must not rediscover and re-promote erased content on the next consolidation pass. See the deletion mechanism in [memory research](MEMORY_RESEARCH.md).

## 10. Attention and notifications

Notify for completion, a material blocker, a decision needed, or a material change relevant to an active commitment. Group related low-urgency updates. Keep failures actionable: say whether EV can retry, needs access, or needs the user's choice.

Per-task controls: important updates, completion only, or silent. Global controls: quiet hours, digest, optional browser push, and temporary mute. Critical approval requests remain visible in-app; push delivery requires browser permission and may be unavailable.

A task owns its notification destination. Starting another chat does not scatter identical updates across all chats. The main conversation has an unread work indicator; notification IDs prevent duplication across devices.

Proactivity uses explicit goals, standing responsibilities, watched sources, due dates, and finite budgets. It does not continuously read every connected account or spawn speculative projects. Suggestions do not become commitments until authorized.

For each responsibility, attention policy is executable data rather than tone guidance:

- what counts as a material change, a blocker, or an expiring commitment;
- when to prepare silently versus notify immediately or include in a digest;
- which source freshness and confidence are required;
- maximum interruption, run, provider, and spend budgets;
- quiet hours, reporting destination, expiry, and next review time.

Record whether an expected important change was missed and whether a notification was unwanted. Optimize for useful completed work and fewer unnecessary interruptions, not message count.

## 11. Release acceptance criteria

1. Two messages can be accepted within one second of each other while a worker is active; neither is lost or merged into the wrong task.
2. A status query returns stored authoritative state with freshness, and initiates investigation only when needed.
3. A second task can run while the first is waiting for a user decision.
4. Steering visibly moves from received to delivered/applied or reports inability to apply.
5. Closing/reopening the browser preserves work and produces no duplicate result messages.
6. An unrelated new chat can recall an allowed prior decision and open its provenance.
7. A private project never appears in another project's context without an authorized scope expansion.
8. A correction affects the next relevant answer; stale summaries do not override it.
9. Failed tools, unknown external outcomes, and partial artifacts are not labeled complete.
10. Core flows work by keyboard, at 360px width, and with a screen reader. Streaming updates do not overwhelm live regions.
11. A user can complete the main flows without seeing a terminal, worker ID, model selector, or graph.
12. One connected standing responsibility observes a real source, produces a verified useful artifact while the browser is closed, and stops at the correct approval boundary.
13. Replayed triggers, restart, stale source data, and revoked mandates cause no duplicate or out-of-scope effects.
14. Every proactive message has a persisted attention decision and can answer why it was surfaced now.

## 12. Scope boundaries

The first release includes text chat, attachments, durable tasks, scoped Pi execution, one useful connector, one standing responsibility, explicit goals/preferences and collaboration instructions, source-linked corrections, artifact delivery, and a bound approval flow. It establishes person/relationship and environment contracts without claiming mature self-evolution or a fully autonomous computer.

An early bounded browser lane may be added for the first workflow if its API cannot finish the job; it is not general desktop authority. Later releases add richer personal understanding and learned personality, broader initiative, and a full EV-owned computer with general browser/desktop use, application install/remove, video workflows, resource management, and restricted SSH host access. These are explicit roadmap capabilities, not first-release requirements. Voice, messaging channels, and a broad marketplace follow independently. [Computer architecture and staging](COMPUTER_ENVIRONMENT.md).
