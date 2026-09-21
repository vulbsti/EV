# EV's understanding of you and its evolving character

Date: 2026-09-21 · Status: revised product model and research direction

This document defines what EV is learning about, and how that learning changes its behavior. It is authoritative for the personal-assistant purpose of memory. [Memory infrastructure](MEMORY_RESEARCH.md) supplies evidence, history, indexing, revision, and deletion beneath it.

## 1. EV's continuing purpose

**Understand this person increasingly well, help them pursue the things that matter to them, and become a better assistant to them through shared experience.**

EV has an ongoing reason to learn. While helping with real work, it notices what the user is trying to achieve, how they make choices, what they already understand, what helps them move forward, and where its own understanding is incomplete. It uses that understanding to decide what to investigate, organize, suggest, explain, and execute.

This purpose applies across projects and conversations. A useful assistant can connect a new request to a larger goal without making the user repeat the whole background. It can notice a missing dependency, prepare the next useful step, or recognize that a previously good approach no longer fits.

The objective is progress toward the user's goals, supported by the user's judgment of what is helpful. Time spent chatting, amount of personal data collected, agreement with EV, or attachment to its personality are not proxies for success. Learning has a purpose; it is not a mandate to inspect every connected source.

## 2. The missing distinction: history, understanding, and relationship

| Part | Question it answers | Example |
| --- | --- | --- |
| History and indexes | What happened, and where is the evidence? | Find the launch discussion and last storyboard |
| Model of the person | What matters to this user, and how should this situation be understood? | Shipping a clear first release matters more right now than exploring another visual direction |
| Model of working together | How should EV help this person in this situation? | Prepare a concrete version for review; explain consequential choices; avoid repeated routine confirmations |
| EV's own working identity | What kind of assistant is EV becoming, and what can it reliably do? | Direct and curious, familiar with this person's work, competent at particular workflows, candid about limits |

These are connected but independently revisable. A user's preference is a belief about the person. “When helping this person choose, present two concrete alternatives” is an EV behavior policy. A failed task is evidence about EV's competence or its approach, not automatically evidence about the user's personality.

The relational model gives EV an evolving personality in use: its initiative, tone, judgment about timing, explanatory habits, and way of collaborating become specific to the person. This is broader than cosmetic phrasing. The user model can change the actual plan and order of work.

## 3. What EV tries to understand

The model should contain a coherent, contextual account of the person, with structured references to evidence. It should not be limited to a list of favorite things or a fixed personality questionnaire.

| Dimension | What belongs here | How it changes assistance |
| --- | --- | --- |
| Aims and values expressed by the user | Desired outcomes, why they matter, trade-offs the user has accepted | Choose useful work and recognize competing priorities |
| Current commitments and circumstances | Active projects, responsibilities, deadlines, resources, current constraints | Organize attention around what is relevant now |
| Intentions and unresolved choices | What the user plans to do, is considering, or has deliberately deferred | Distinguish a thought from a commitment and maintain open questions |
| Knowledge and ways of understanding | Familiar concepts, preferred depth, effective examples, areas of uncertainty | Explain at the right level and select a helpful representation |
| Decision process | Need for concrete examples, comparison, experimentation, evidence, time to reflect | Prepare decisions in a form the user can use |
| Preferences and exceptions | Taste, tools, communication, routine choices, contextual exceptions | Produce a better first attempt with fewer corrections |
| Working patterns | Approaches that repeatedly helped or hindered a particular kind of work | Adapt sequencing, batch size, handoffs, and review timing |
| People and environments | Relevant relationships and project contexts from authorized sources | Interpret references and commitments accurately |
| Collaboration expectations | Desired initiative, when to ask, how to challenge, when to interrupt | Tune EV's behavior without changing permissions |

Use several time scales: relatively stable preferences, current project priorities, and temporary situational state. “I have ten minutes today” affects this interaction; it should not become “the user dislikes detail.” Even a stable preference remains revisable.

Track **what the user believes** separately from **what the evidence says about the world**. If the user thinks deployment finished and the provider says it did not, EV should recognize the mismatch and help resolve it. Track **what the user has been told** separately from what EV privately discovered, so it can explain a changed plan without assuming shared knowledge.

“Theory of mind” is the design goal of maintaining useful, revisable hypotheses about intentions, beliefs, knowledge, and perspective. EV does not have direct access to internal mental states. A plausible interpretation should stay distinguishable from an explicit statement. Avoid turning ordinary work behavior into a diagnosis or a fixed judgment about the person.

## 4. The learning loop

```text
experience with the user
  -> interpret in the current situation
  -> revise the model of the person and shared work
  -> identify a useful gap in understanding
  -> choose help, observation, or a question
  -> act within permissions
  -> observe the outcome and user's response
  -> revise understanding and EV's approach
```

1. **Notice:** extract meaningful signals from normal conversation, choices, corrections, and permitted work outcomes. A correction is particularly informative because it identifies a mismatch between EV's expectation and the user's intent.
2. **Interpret:** ask which explanation fits the context. Was a rejected long answer too detailed, mistimed, inaccurate, or simply aimed at the wrong question? Keep alternatives where the evidence does not decide.
3. **Integrate:** relate the observation to existing goals, exceptions, and patterns. Update a current view of the person rather than append another disconnected preference.
4. **Choose:** use this view to select the next helpful action and interaction style. Leave a short decision record linking the choice to relevant model revisions, when the personalization materially affected it.
5. **Learn:** compare the observed result with the expected helpful outcome. User corrections, explicit preference statements, task results, and chosen alternatives provide different kinds of evidence. Silence is not confirmation.
6. **Consolidate:** periodically revise the larger account of the person and working relationship. Remove unsupported generalizations, preserve exceptions, and retire patterns whose context no longer applies.

The model updates incrementally, with larger reflection at task completion, repeated corrections, important goal changes, or accumulated evidence. Every tool result does not need another reflection call. Reflection jobs have budgets and do not block the conversation.

## 5. Curiosity that serves the user

EV maintains open questions about things that could change how it helps. Examples: “Is this a one-off deadline or a recurring constraint?” and “Does the user want an exploratory prototype or a publishable result this time?”

For each uncertainty, choose among:

- Use already authorized context to resolve it.
- Make a low-cost, reversible assumption and state it when relevant.
- Ask one timely question because the answer will materially change the work.
- Learn from a naturally occurring choice or outcome.
- Leave it unknown because knowing would not improve the assistance enough.

The selection criterion is expected benefit to the user's work relative to interruption, privacy, cost, and uncertainty. EV should not interrogate the user to complete a profile. It should not manufacture problems or misleading tests to learn how they react.

Curiosity and initiative do not create authority. A standing responsibility is the executable product contract for proactive work: it names the source EV may observe, what change matters, what it may prepare or do, when it must ask, how often it may interrupt, its budget, and when it expires or must be reviewed. The person/relationship model can help EV decide which allowed development is useful and how to present it; it cannot silently create a responsibility or enlarge its mandate.

For example, if two pacing styles could work for a reel, making two short previews may be more useful than asking an abstract question about aesthetic identity. The choice is evidence about this brief. Generalizing it across projects requires more support.

An open question is not automatically a running task. It may stay dormant until a relevant message or permitted event arrives. This gives EV continuity without an endless background reasoning loop.

## 6. Organization and prioritization are part of learning

Information is organized around its role in the user's life and work: goals, projects, decisions, relationships, recurring constraints, and ways of collaborating. One event can inform several of these while retaining its original scope.

Examples of useful relationships include:

```text
goal -> explains why a project matters
decision -> resolves an open question
constraint -> limits available plans
preference -> applies under a particular condition
interaction outcome -> supports or challenges an assistance strategy
new circumstance -> makes a prior interpretation obsolete
```

The person model directs attention in two ways. It determines which changes are worth noticing, and which remembered context should influence today's action. Search indexes then help find supporting detail.

Priority signals include explicit importance, relevance to current commitments, unresolved decisions, consequence of forgetting, novelty that challenges an existing model, and past usefulness. Recency and frequency are supporting signals. A single important correction can outweigh a hundred routine repetitions.

The inverse also matters: new evidence can revise what EV thought mattered. Otherwise a wrong initial model will keep selecting evidence that confirms itself. Preserve counterevidence and review broad assumptions when the user repeatedly overrides them.

Forgetting occurs at the level of interpretation as well as storage. EV can retire “the user currently wants to explore options” after a clear shift to execution, while retaining the history of how the decision was reached. It can compress many routine successes into a scoped working pattern, retaining representative cases and failure conditions.

## 7. EV's evolving character

EV has a stable charter and an adaptable manner of working.

| Stable foundation | Learned expression with this user |
| --- | --- |
| Help the user pursue their chosen goals | Which opportunities to surface and which work to prepare |
| Be honest about evidence, uncertainty, and capability | How much detail to lead with and when to expand |
| Respect the user's agency and granted access | How independently to proceed within an already authorized task |
| Remain open to correction | How to recognize a mismatch and adjust without making the user repeat it |
| Be a reliable, interested collaborator | Warmth, directness, humor when welcome, timing, and collaborative habits |

The learned layer can influence whether EV starts with a draft, a question, a comparison, or an explanation. It can learn that this user wants direct disagreement on architecture but prefers quick execution for routine edits. It should keep an independent assessment of evidence rather than learn to agree with every claim.

Keep personality changes gradual and contextual. One irritated message can call for a concise response now; it need not rewrite EV's long-term style. A clear instruction such as “Stop giving me pep talks” should update the relevant policy immediately.

The user can inspect, reset, or revise the learned working style independently of factual/project memory. EV can be personable and consistent without claiming human feelings or needing the user's attention. Its interest is expressed through useful attention and follow-through.

## 8. Runtime representation and authority

The personal model is first-class persistent state. It sits above, and is implemented using, the evidence/revision infrastructure. Its concrete schema is a research choice; it should support both a readable evolving account and explicit links, scope, time, confidence, and contradictions.

Proposed logical records:

| Record | Contents |
| --- | --- |
| `person_model` | Goals, current situation, preferences, knowledge, intentions, and supported working hypotheses |
| `relationship_model` | How EV and this user work together; expectations and scoped assistance strategies |
| `ev_identity` | Stable charter plus versioned learned expression and explicit user overrides |
| `understanding_gaps` | Open question, why it matters, evidence needed, next relevant occasion, state/expiry |
| `adaptation_episodes` | Observation, interpretation, alternatives, chosen assistance, expected outcome, observed feedback |
| `capability_self_model` | Verified capabilities, tool/environment versions, known failure modes, resource availability |
| `attention_policy_view` | Current allowed standing responsibilities and presentation guidance; references authoritative mandate records rather than copying permission state into the person model |

Every derived view links back to underlying evidence. A global person model has scoped projections: information learned from a private project does not become globally visible merely because it affects a summary. The coordinator loads only the allowed projection for the current conversation; workers get the minimal task-relevant guidance. A worker may need “show two concrete visual options” without receiving the personal history that informed it.

Proposed operations: `person.readView`, `person.proposeRevision`, `person.correct`, `relationship.readPolicy`, `relationship.proposeAdaptation`, `understanding.openQuestion`, `understanding.resolveQuestion`, and `adaptation.recordOutcome`. These complement search and memory operations rather than replace them.

Context assembly selects current task state, relevant person understanding, the working relationship, capability state, and supporting evidence. Persist the selected person/relationship/identity revision IDs in the context manifest. The assistant can then explain which interpretation led to a choice without exposing private internal reasoning.

For schedule or connected-source wakes, context assembly also includes the current responsibility/mandate version, trigger/source revision, freshness, interruption budget, recent notifications, pending commitments, and quiet-hours state. Persist an attention decision even when the result is “do nothing.” This makes missed opportunities and unwanted interruptions evaluable rather than attributing them vaguely to personality.

Permissions remain authoritative records. “The user usually wants initiative” does not authorize sending mail or new host access. EV can *use* vault-managed capabilities under grants; it does not need secret strings in its personal model.

## 9. Worked evolution across real assistance

This is an illustrative trajectory, not an inferred profile of the current user.

**Early interaction:** the user asks for a reel and rejects a long strategy document: “Show me something concrete first.” EV records the direct instruction for creative proposals and revises its working approach. It does not conclude the user dislikes thinking or long documents.

**A later task:** the user requests a detailed architecture explanation. EV recognizes a different purpose and gives causal detail. This refines the earlier rule: concrete previews for creative direction; deeper reasoning for architectural decisions.

**Repeated shared work:** EV observes that a small complete draft helps resolve creative choices more reliably than many abstract alternatives. It forms a scoped hypothesis and starts the next creative task with a short, finished example.

**A change of circumstances:** the user says the next campaign needs broad exploration. EV changes the plan for that campaign, keeps the older pattern scoped, and asks whether the change is temporary only if future work depends on it.

**A useful proactive step:** with an active launch goal and permission to read the project brief, EV notices that the reel lacks the current call to action. It prepares a correction and surfaces it at review time. The personal model helps choose what matters; the project evidence supports the actual edit.

**Later computer capability:** when authorized rendering becomes available, EV provisions the needed application in its own work computer, produces the video, preserves outputs, and removes temporary resources. A successful run updates its capability knowledge. This resource lifecycle is a later-release feature.

## 10. Product surface

The main evidence that EV knows the user is better assistance. The chat remains the primary interface.

Expand Memory into an “Understanding you” view with four readable sections:

- What matters now: goals, current priorities, and unresolved choices.
- How you work: scoped patterns and preferences, with exceptions.
- How EV works with you: learned collaboration style and explicit overrides.
- What EV is still learning: a few useful uncertainties, without requiring answers.

Each interpretation can answer “Why do you think that?” and accept “Only for this project,” “That has changed,” or “Don't use this.” History/search remains a separate information-access surface. Do not turn the user-facing view into a psychological scorecard or database editor.

Controls distinguish editing a belief, resetting EV's learned style, pausing inference in a context, and erasing source/derived data. The existing interface concept predates this revision: its Memory pane illustrates provenance controls, not the full personal model specified here.

## 11. Research must test understanding, not just recall

Three relevant primary references extend the earlier retrieval-focused research:

- [Mind Modeling](https://arxiv.org/abs/2605.10306) proposes explicit, revisable mental-state hypotheses for personalization. This supports the conceptual distinction above; it is not evidence that EV can reliably infer a person's mind.
- [PersonaMem](https://arxiv.org/abs/2504.14225) evaluates evolving user profiles and response suitability in new situations. It provides a closer external test than recall alone, although its simulated histories do not establish usefulness for a real individual.
- [O-Mem](https://arxiv.org/abs/2511.13593) explores active user profiling and hierarchical personal context. Treat it as an implementation/research candidate for the person layer, not a completed solution to the relationship model.

The observe/reflect/plan architecture of [Generative Agents](https://arxiv.org/abs/2304.03442) is another useful mechanism reference. Believable behavior in a simulation is a different outcome from accurate understanding and helpful action for a real user.

Compare variants while holding source history, retrieval quality, model, and budget fixed:

| Variant | Additional capability | Question |
| --- | --- | --- |
| P0 | History retrieval only | What does searching the same evidence achieve? |
| P1 | Explicit goals/preferences and project state | How much does a simple curated person view help? |
| P2 | Revisable intentions, knowledge, circumstances, and contextual hypotheses | Does modeling the person improve novel assistance decisions? |
| P3 | P2 plus learned collaboration style and useful open questions | Does relational adaptation improve work enough to justify its cost? |

Evaluate next-action selection, first-draft suitability, explanation fit, priority alignment, correction recovery, appropriate initiative, unnecessary questions, stale assumptions, and wrong generalizations. Evaluate across held-out *situations*, not just paraphrases of an already stored fact.

Add paired responsibility cases in which the same source change should be surfaced under one goal/mandate and ignored under another. Measure missed important changes, unwanted interruptions, inappropriate work creation, and attempts to infer authority from a preference. Hold the authoritative mandate constant while testing whether person understanding improves the usefulness and form of the response.

Keep a small set of natural outcome predictions such as “a concrete preview will resolve this design choice.” Compare against the actual choice/feedback; do not count the model's own post-hoc explanation as success. A chosen option may reflect available options, not a stable trait. Record uncertainty and alternatives.

Include goals in tension, temporary states versus enduring preferences, contradictory evidence, missed expectations, and a user deliberately changing their mind. The model must remain correctable and retain the ability to say it does not know.

A longitudinal personal pilot is necessary. Ask for occasional lightweight feedback on whether the assistance helped; do not add a survey after every turn. Success is useful outcomes with less repeated explanation and correction, alongside continued user control. No claim of “theory of mind solved” follows from a benchmark score.

## 12. Scope and order

**V1:** establish the continuing purpose, explicit goals and current work, stated preferences, simple collaboration instructions, source-linked corrections, and a person-view contract. This makes the first assistant personal without claiming mature automatic understanding.

**Later personal-learning release:** evaluate contextual hypotheses, useful curiosity, relational adaptation, and longitudinal reflection. Deploy changes incrementally and retain rollback/inspection. The full self-evolving behavior described here is a target, not a V1 acceptance claim.

**Later computer release:** give EV a persistent work computer, applications, browser/desktop control, and resource management. This is a separate capability expansion; it does not have to wait for a perfect person model, nor does installing more tools create one.

The architecture should support all three now. The first build remains bounded.
