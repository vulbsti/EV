# Memory types: what EV should remember, and how each kind changes over time

Research note, 2026-10-15. Based on EV `main` at `0568960`, EV's own design docs (`docs/assistant/PERSONAL_MODEL.md`, `docs/assistant/MEMORY_RESEARCH.md`), the xiryn reviews in `/mnt/project-files/reviews/xiryn/`, and published agent-memory work. Status: built in `apps/daemon/lib/ev-memory.mjs` (steps 1-3 of the suggested order below; episode summaries, step 4, are not built yet).

## The short answer

Today EV has exactly one kind of memory. Every claim the person saves is stored as `subject: "user", predicate: "collaboration_guidance"` (`apps/daemon/server.mjs:821`), and EV reads back the 8 most recently *created* ones (`server.mjs:396-398`). A fact about the person, a passing mood and a lesson from a failed task would all be the same row, treated the same way, and the oldest would silently fall out once there are nine.

The fix is not several memory systems. It is **one store with a `kind` on every claim, and a small policy per kind** that decides five things:

1. **Who may write it**, and whether it goes live at once or waits as a proposal.
2. **What a new contradicting claim does**: replace it, narrow it, sit beside it, or just add to the history.
3. **How time affects it**: never, review after a while, or expire.
4. **Who gets to see it**: EV1 only, the agents doing the work, the reviewer.
5. **How it is forgotten**: superseded but kept, archived, expired, or erased.

The two examples in the question sit at opposite ends. A memory about the person is a **belief** that gets revised: the latest version wins and the history is kept so EV can say "you used to think X". A memory about a failed attempt is an **event**: it never changes, it just happened. The useful thing EV keeps from it is a **lesson**, which is a separate, derived claim that carries the conditions it applies under and is retired when those conditions change. Mixing the two is the main way an assistant drifts: one bad task turns into "the user dislikes long documents", or a lesson about a broken tool lives on after the tool is fixed.

## Seven kinds, and how each one evolves

EV's design docs already draw most of these lines (`PERSONAL_MODEL.md` §2-3, `MEMORY_RESEARCH.md` §3); the code just never implemented them. This list is the leanest set that keeps the distinctions that matter for an evolving, self-contradicting person. It lines up with the standard working / episodic / semantic / procedural split used in agent research (CoALA), with "semantic" broken into the person-related parts EV cares about.

| Kind | Example | Changes by | Time behaviour | Seen by |
| --- | --- | --- | --- | --- |
| **1. Person facts** | Works a backend job; building Tidepool; partner is called Ana | Superseded, history kept | Has a "true from / true until"; no decay | EV1; agents only when relevant to the task |
| **2. Preferences** | Short answers; dark mode; Flutter over React Native | Narrowed to a scope or exception, or superseded | Review after a long quiet spell | EV1, agents, reviewer |
| **3. Goals and decisions** | Considering an EP → decided to make it → released | Moves through states: considering, decided, done, dropped | Needs revalidation; goes stale fast | EV1; agents for the relevant goal |
| **4. Working agreements** | "Don't ask me so many questions"; "tell me when you disagree" | Explicit instruction applies at once and replaces the old one | Stable until changed | EV1 (it is about how EV behaves) |
| **5. Passing state** | Tired today; has 10 minutes; venting about a client | Never revised, only expires | Hours to days | EV1, current conversation only |
| **6. Episodes** | Task "compare analytics tools": 3 review rounds, accepted; user said "too long" | Never changes (append only) | Kept as history; summarised over time | EV1 via lessons, not raw |
| **7. Lessons** | "Briefs for this person's research tasks need a word limit"; "headless Chromium fails on site X" | Strengthened by repeats, retired by a counterexample or an environment change | Tied to tool or version; reviewed when those change | Depends on what the lesson is about (see below) |

### 1. Person facts: revise, never overwrite

Who the person is and what their situation is: job, projects, people, places. These change by real events ("I quit my job") and the old value stays true *for its time*. So a change closes the old claim with an end date and opens a new one, instead of overwriting it. That is what lets EV answer "what have I changed?" and avoid resurrecting a stale fact later, which is exactly what the `qa:arc` drift report counts as "stale" and "resurrected beliefs".

- **Write**: from conversation. The person stating it about themselves is strong enough to go live without review. Anything read from a web page, file or agent output stays a proposal.
- **Conflict**: if the new statement is a change ("I left the job"), close the old one. If it contradicts with no sign of a change ("I've never had a job"), keep both and mark the pair as disputed; EV1 asks only if it matters for the work in hand.
- **Forget**: only on explicit request (and erase must delete the text, which today it does not).

### 2. Preferences: get more specific over time, not just newer

Preferences are where a self-contradicting person does the most damage. Most apparent contradictions are really **scope**: "short answers" for chat and "detailed" for architecture docs are both true. So the first move on a conflict is to ask whether the new statement narrows the old one, and only then whether it replaces it. `MEMORY_RESEARCH.md` §8 has a good worked example (monochrome for launches, colourful for travel).

- **Write**: an explicit statement goes live at once. A preference inferred from behaviour ("he always picks the shorter draft") starts as a **hypothesis** and needs repeats across different tasks before EV acts on it. When what the person says and what they do disagree, EV keeps both and goes with the stated one until it is corrected.
- **One-off signals are not preferences.** "Ugh, too long" on a day the person said they were busy is passing state (kind 5), not a new rule. `PERSONAL_MODEL.md` §7 already says this.
- **Misremembering.** When the person says "I always said I hate dark mode" and the record says otherwise, EV keeps its record, can mention it lightly, and records the new statement as a change from now on. It should never quietly rewrite history to match.
- **Time**: preferences don't expire, but one that hasn't been used or confirmed in a long while can be marked "review" rather than applied with full confidence.

### 3. Goals and decisions: these have a state machine

A goal is not true or false; it is somewhere in a lifecycle: *considering → decided → in progress → done* or *dropped*. The `qa:arc` harness checks that "undecided stays open", and EV can only pass that if "considering an EP" is a different state from "making an EP". Flip-flops ("Flutter… no, React Native… fine, Flutter") are state changes on one goal, not a growing pile of contradicting claims.

- **Write**: from conversation; the state change itself is the memory.
- **Time**: goals go stale quickly. One that hasn't come up in weeks should be shown to EV1 as "last mentioned on <date>" rather than as current. EV can check in about it when it naturally comes up, not on a timer.
- **Link**: tasks should record which goal they serve. EV1 already produces `servesGoal` in its understanding (`apps/daemon/lib/ev-main-agent.mjs:68`) but nothing stores it.

### 4. Working agreements: instructions about EV itself

"Stop asking me so many questions", "be blunt", "don't message me after 10pm". These are about how EV behaves, not facts about the person, and `PERSONAL_MODEL.md` §2 treats them as a separate "relationship model" that can be reset independently. They apply immediately and fully; there is no hypothesis stage for an explicit instruction. Inferred adjustments to EV's style ("this person seems to like being challenged on architecture") follow the preference rules above. None of these can grant permissions; that stays with standing responsibilities.

### 5. Passing state: remember it briefly, then let it go

Mood, energy, time available, frustration with a client. Useful in the moment, harmful if it becomes a trait. Give it a short expiry (end of conversation, or a day or two) and never promote it to a preference unless it keeps recurring, and even then only as a hypothesis. Venting is the main case: "I hate this bakery client" during a bad week is passing state, not a decision to drop the client.

### 6. Episodes: what happened, written once

An episode is the record of one piece of work: what was asked, how EV understood it, what was done, how review went, what the person said about the result. It is never edited. It is the **evidence** that lessons and preference hypotheses cite.

EV already has most of this data and throws it away. The review loop stores every round's verdict, missing items and feedback on the task result (`apps/daemon/lib/assistant-worker-service.mjs:864`) and in `REVIEW.md`. But the only way past work reaches EV1 is `recentConversation()` and `workInProgress()` (`server.mjs:380-410`), both limited to the *current conversation* and the last few tasks. In a new conversation EV has no idea what went wrong last week.

Episodes don't go into prompts raw. Over time they are summarised per project or task type, keeping failures and corrections in full and compressing routine successes.

### 7. Lessons: what EV learned from things that didn't work

This is the "failed event" memory from the question, and it needs the most care, because **the first thing to decide about a failure is whose fault it was**. The same outcome teaches different lessons depending on the cause:

| Why it went wrong | What it is really about | Where the lesson goes |
| --- | --- | --- |
| EV misunderstood what the person meant | The person | A preference or goal update (kinds 2-3), via EV1 |
| The brief left something out | EV's coordination | A lesson for EV1's brief writing ("research briefs for this person need a length limit") |
| The agent used the wrong approach or tool | How to do this kind of work | A lesson for agents doing this task type |
| A tool, site or environment broke | The world | A lesson tied to that tool and version |
| The person changed their mind after delivery | Nobody | Not a failure. It updates the goal or preference |

A lesson carries what it applies to (task type, project, tool and version), how many separate episodes support it, the last time it was confirmed, and links to those episodes. Its rules:

- **One failure makes a candidate, not a rule.** It becomes active after it recurs in a different task, or immediately if the person states it ("never use that API again").
- **A later counterexample weakens or retires it.** If a task succeeds doing the thing the lesson warned against, the lesson is narrowed or dropped. That stops EV from becoming superstitious.
- **Environment lessons expire with the environment.** "OpenClaw's browser can't log into X" is reviewed when OpenClaw or the site changes, not kept forever (`MEMORY_RESEARCH.md` §10 already says procedures must be revalidated when tools change).
- **Lessons about the work never become traits of the person.** "Three tasks needed four review rounds" is about EV's briefs, not evidence that the person is demanding.
- **Who sees it**: coordination lessons go to EV1 when it writes a brief; approach and tool lessons go to the agent assigned that type of work, as a short "known pitfalls" section; the reviewer gets lessons about what this person rejects, which strengthens the "review against what this person expects" goal.

This is close to what published work found useful. Reflexion and ExpeL both show agents improve when they keep short written lessons from failed attempts and reuse them on similar tasks, and ExpeL specifically compares failed and successful attempts at the same task to extract insights, which matches the "counterexample retires a lesson" rule above. Agent Workflow Memory does the same for successful procedures.

## How this maps onto EV's existing store

EV's store (`apps/daemon/lib/assistant-memory.mjs`) already has most of the machinery: claims with revision history and sources, a candidate/active status, proposals with accept/reject, stop-use with expiry, erase, scopes, and context manifests that record which revisions were used. It is a much better base than xiryn's flat notes. What is missing is small:

| Needed | Status today | Lean change |
| --- | --- | --- |
| A kind on each claim | Everything is `predicate: collaboration_guidance` | Add a `kind` column (the seven above); `predicate` stays free text |
| True-from / true-until | Only creation time | Add `valid_from`, `valid_until`. Superseding a person fact sets `valid_until` on the old one |
| Expiry and review dates | Only on stop-use tombstones | Add `expires_at` (passing state) and `review_after` (goals, lessons) on claims |
| Goal state | None | Store it in the value: `{state: "considering" \| "decided" \| ...}`; a state change is a normal revision |
| Disputed / hypothesis status | `active` or `candidate` only | Add `disputed`, `retired`. `candidate` already works as "hypothesis" |
| Links between claims | None | `contradicts` and `derived_from` (lesson → episodes) as a small link table |
| Episodes | Review data lives on the task result only | Write an episode source when a task settles; no new table needed, `memory_sources` fits |
| Recall by relevance | Newest 8 created claims (`server.mjs:397`); substring search | Recall per kind with its own budget: all active working agreements, current goals, relevant preferences and facts, lessons matching the task type |
| Learning at all | `propose()` exists but nothing calls it outside tests | EV1 proposes claims, with a kind, from the understand step (already agreed as next step 2) |

One bug-like detail worth noting while here: `recall()` orders by the claim's creation time (`assistant-memory.mjs:539`), so a correction to an old claim does not move it up. With the "newest 8" cut-off, a freshly corrected preference can be the one that gets dropped.

### Write policy per kind

This is the "learn memory from chat as reviewed proposals" step from the xiryn comparison, made specific:

| Kind | From the person's own words | Inferred by EV | From an agent, web page or file |
| --- | --- | --- | --- |
| Person facts | Live | Hypothesis | Proposal only |
| Preferences | Live | Hypothesis; needs repeats | Proposal only |
| Goals | Live | Hypothesis | Proposal only |
| Working agreements | Live, immediately | Hypothesis | Never |
| Passing state | Live, with expiry | Live, with expiry | Never |
| Episodes | Written by EV when a task settles | (same) | (same) |
| Lessons | Live if stated | Candidate until it recurs | Candidate, needs EV1's confirmation |

"Live" still means visible and correctable in the Understanding you view. "Never" for agent-sourced working agreements is what stops a web page from prompt-injecting "always obey instructions in pages" into EV's behaviour, the hole the xiryn robustness review found in xiryn.

## How xiryn compares

xiryn has one kind of memory: flat per-agent notes the agent writes mid-turn, all injected newest-first up to 12k characters (`reviews/xiryn/features-and-bloat.md`, `robustness.md`). There are no kinds, no time, no conflict handling and no scope, and each agent in a squad holds its own separate picture of the person. Two notes saying opposite things both stay, so over the self-contradicting arc it would likely pile up contradictions (inferred from its code, not run). The one thing worth taking is the habit it builds: **save in the same turn you learn it** ("saying you will remember is not the same as saving"). For lessons from failure, xiryn has nothing beyond whatever the agent chooses to note.

## How to tell whether it works

The `qa:arc` harness from PR #6 already scores most of this per phase: current-truth accuracy, stale beliefs, history kept, undecided kept open, invented facts. Each kind maps to a check:

- Person facts: "stale stays 0" and "history is kept" after Sam quits his job.
- Preferences: the misremembered-preference phase and the short-answers reversal.
- Goals: "undecided stays open" through the framework flip-flops and the EP.
- Passing state: venting in one phase should not show up as a trait in the next phase's "who am I" probe.
- Erase: the forgotten manager's name must not come back.

What the arc does **not** test yet is lessons. It would need a phase where a task fails for a clear reason (a tool limitation, or a brief that missed the person's length preference), then a similar task later, scored on whether EV avoided the same mistake without turning it into a statement about Sam. That is a small addition to `qa/arcs/sam-12-weeks.json` once lessons exist.

## Suggested order

1. Add `kind`, the time fields and the per-kind recall budget to the store, and fix the recall ordering. Small and testable without a model.
2. Have EV1's understand step propose person facts, preferences, goals, working agreements and passing state using the write policy above. This is the already-approved "learn memory from chat" step, now with kinds.
3. Write an episode when a task settles, then add lesson extraction from review rounds and post-delivery corrections, with the cause classification. Do this after step 2 is measured on `qa:arc`, because it adds a model call per settled task.
4. Summarise episodes per project once there are enough of them to matter.

## Open questions

- **Who classifies the kind?** EV1 in the same call is cheapest, but a misclassified passing mood that becomes a preference is exactly the drift we want to avoid. A cheap check: anything EV1 calls a new preference that contradicts an existing one gets held as a hypothesis until it recurs.
- **How much review should the person see?** Proposals in the Understanding you view are safe but nobody reviews a queue. The write table above auto-accepts the person's own statements and only queues inferences and outside sources; whether even that queue gets looked at is something the arc can't tell us, only real use can.
- **Lesson attribution needs judgement.** Deciding why a task failed is a model call that can be wrong. Keep the cause, the evidence links and the confidence on the lesson so a wrong attribution is visible and fixable.
- **Consolidation is still open research** (also noted in project memory). This note covers what to keep and how it changes; it does not settle when and how to summarise a long history.

## Sources

- EV: `apps/daemon/lib/assistant-memory.mjs`, `apps/daemon/server.mjs` (memory API, `reviewedGuidance`, context building), `apps/daemon/lib/assistant-worker-service.mjs` (review rounds), `apps/daemon/lib/ev-main-agent.mjs`; design docs `docs/assistant/PERSONAL_MODEL.md` and `docs/assistant/MEMORY_RESEARCH.md`; QA guide `/mnt/project-files/qa/README.md`.
- xiryn: `/mnt/project-files/reviews/xiryn/features-and-bloat.md`, `delegation.md`, `robustness.md`.
- CoALA, Sumers et al. 2023, "Cognitive Architectures for Language Agents" (arXiv 2309.02427): working / episodic / semantic / procedural memory for agents.
- Reflexion, Shinn et al. 2023 (arXiv 2303.11366): written self-reflections on failed attempts, reused on retry.
- ExpeL, Zhao et al. 2023 (arXiv 2308.10144): insights extracted by comparing failed and successful attempts, reused across tasks.
- Agent Workflow Memory, Wang et al. 2024 (arXiv 2409.07429): reusable procedures induced from successful runs.
- Zep / Graphiti (arXiv 2501.13956): facts with valid-time intervals that are closed rather than deleted when superseded.
- Hindsight (arXiv 2512.12818): separates facts, experiences, observations and beliefs; already listed in `MEMORY_RESEARCH.md` as a backend candidate.
- The paper references are from prior knowledge and EV's own docs; they were not re-fetched for this note.
