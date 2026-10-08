# The Prototyping Workbench — design

Date: 2026-08-15
Status: design approved, not yet implemented
Supersedes the framing (not the machinery) of `docs/EXPLANATION_WINDOW.md`

## The thesis

Every agent harness that exists assumes the destination is known. Its unit of work
is a task, its success metric is completion, its shape is convergent: intent, code,
review, merge. Abandoned work is waste and context dies with the branch.

Prototyping inverts every one of those.

| | Codebase harness | This |
| --- | --- | --- |
| Unit of work | a task | **a question** |
| Success | it is done | **uncertainty resolved**, including "no" |
| Artifact | code | **a finding** |
| Shape | linear, convergent | **a tree, divergent** |
| Deletion | failure | **the normal case** |

This is a harness for the phase before commitment: constant experiments,
iterations and combinations, before finalising, if ever.

## The interaction thesis

The map does not exist to explain anything. It exists to make asking cheap.

Boredom is what happens when the cost of following a tangent exceeds its expected
payoff. Point at a node and say "why this" — five words instead of a paragraph of
re-established context. Drop the cost of a question by an order of magnitude and
curiosity becomes affordable; wandering stops being a distraction and becomes the
working mode.

The mechanism is deixis — the ability to point and be understood — and it is a data
structure, not a prompt. This is also why screen-reading and computer-use are the
wrong tools: vision is a lossy workaround for not having a shared model.

## Moments of use

Three snapshot moments. Live monitoring is explicitly out of scope; it removes
incremental layout under a mutating graph, the hardest problem in this space.

| Moment | Substrate | Lens |
| --- | --- | --- |
| Review what an agent built | the whole system | **delta** |
| Orient in an unfamiliar system | the whole system | **whole** (no overlay) |
| Decide what to build next | the whole system | **tension** |

One substrate, three lenses.

## Core model

The one structural idea: **everything references map node IDs.** Traces, findings,
git deltas, evidence status and chat scope. The map is not a view over the data; it
is the coordinate system the data is expressed in.

### Types

**`SystemModel`** — `.ev/map.json`, committed to git. 25–40 nodes, each with a stable
`id`, a plain-language name (`"Evidence Capture"`, not `evidence.mjs`), a one-line
purpose, **pinned x/y**, cited files and symbols, and edges. Authored by an agent
pass, freely hand-editable.

Regeneration **may not move existing nodes.** New nodes fill reserved gaps; removed
nodes leave a marked ghost slot. This constraint preserves spatial memory across
weeks and is a hard requirement, not a preference.

**`Question`** — the unit of work. Text, `scope: [nodeId]`, status
(`open` / `answered` / `dead`), parent. Questions form a tree, because that is what
wandering produces.

**`Experiment`** — belongs to a Question. Carries a design before it carries a result.

**`Trace`** — an execution as an ordered walk over node IDs with per-node timing and
status. This is the join that makes the map behavioural rather than structural.

**`Finding`** — the durable artifact. Cites its experiments, records the tier it was
established at, and **survives deletion of the branch that produced it.**

### Layers

| Layer | Source | Changes |
| --- | --- | --- |
| Substrate — nodes, positions, edges | `map.json` | rarely, deliberately |
| Paint — delta / tension / evidence | git + ledger + receipts | per session |
| Motion — traces | experiment runs | per run |
| Scope — selection | the cursor | constantly |

### Altitudes

Exactly two. System level (~25 nodes) and *inside* a node (5–10 sub-nodes with real
file and symbol citations). Not infinite zoom. Two levels keep the top stable and
legible while giving curiosity somewhere specific to land.

## The fidelity ladder

| Tier | Cost | Answers | Evidence status |
| --- | --- | --- | --- |
| **sketch rig** | minutes | is the shape right | `derived` |
| **throwaway branch** | hours | does it work with nothing faked | `observed` |
| **sweep** | minutes, needs a real path | where it breaks, at what load | `observed at limits` |

A question starts at the cheapest tier that could answer it and escalates only if the
answer matters. Most ideas die at tier 1 for two minutes of cost.

Pure model-predicted outcomes are **not** a tier. The agent may state a prediction, and
the map renders that claim in its weakest visual state until a rig confirms it.
Speculation is fine; speculation that looks like data is not.

**The tier an answer was established at is the evidence status painted on the map.**
The fidelity ladder and the `observed / derived / predicted / unknown` vocabulary are
the same axis. This is load-bearing: the visual is a direct readout of work done, not
a reporting layer that must be kept in sync.

## Visual language

Roughly five pre-attentive channels exist. Spend them all at once and none work.
Channels are assigned permanently; lenses are modes, not layers.

| Channel | Owns |
| --- | --- |
| Position | identity, frozen |
| Size (area) | scale of the node, capped ~4:1 |
| Fill / texture | **evidence status** — always on, every lens |
| Hue | the active lens, exclusively (`whole` has no hue) |
| Motion | traces only |

### Evidence status

- `observed` — solid fill
- `derived` — hatched
- `predicted` — thin outline, hollow
- `unknown` — dashed outline

Not a colour. A hollow shape among solid ones reads as a hole in the fabric,
pre-attentively, without a legend — and hollow carries the right connotation:
not "bad", but "not yet real".

Consequence: a fresh map is almost entirely hollow and **fills in as experiments run.**
Watching certainty accumulate is an intrinsic motivation loop arriving as a structural
consequence rather than as bolted-on gamification.

### Delta lens

Contrast by subtraction — dim everything else rather than highlighting what changed.
Three bands: touched, one-hop neighbours (blast radius), and everything else dimmed
toward background. The neighbours band matters because agents break things adjacent
to what they edited, which a diff cannot show.

**Touched and still hollow is the highest-value state in the product:** the agent
wrote this and nobody ran it. On the delta lens it is the loudest thing on screen.

### Tension lens

Computed from fan-in, hollowness weighted by fan-in, edges with no failure path ever
traced, and git churn. Rendered as a warm glow on the ground beneath the node, so it
never fights the fill encoding.

**Top five only.** A continuous ramp across 30 nodes colours everything slightly and
makes nothing salient.

### Motion

A pulse traverses the path over ~1.2s, leaving the route lit. Dwell time is real
per-node timing, so slowness is felt before it is read. **On failure the pulse stops.**
Arrest is more legible than a colour change and puts the eye on the problem.

After a trace, touched nodes become solid. The loop closes visually.

### Two deliberate calls

**Edges are faint by default**, brightening only for the hovered or selected node.
Structure at rest, detail on demand.

**Flat 2D plan view, not isometric.** Isometry costs occlusion, awkward hit-testing,
cramped labels and a depth axis that encodes nothing. What made the reference image
good is separable from its axonometry and is all retained: restricted near-monochrome
palette, grid ground, persistent left index rail, standing right-hand panel, generous
whitespace.

### Navigation

Keyboard-first, because the thesis is cost-of-a-question. Arrow keys move spatially
between nodes; `/` enters the index rail; `?` asks about the focused node; `Enter`
goes inside; `Esc` comes out.

### Bait

The agent may place a small unobtrusive marker on nodes where it has a non-obvious
observation waiting. It never speaks unprompted; it leaves something worth clicking.
Serendipity does not occur unless it is manufactured.

## Question and experiment lifecycle

```
   notice ──▶ question ──▶ claim ──▶ experiment design ──▶ run ──▶ finding
      ▲                                     │                        │
      └──────── wander ◀── child question ◀─┘                        ▼
                                              accept-at-tier · escalate · kill
```

### Deciding the problem

Three sources: you noticed something; the tension lens ranked it; the agent nominated
it. **The agent proposes and never selects.** Problem selection is the skill being
trained, and an agent choosing its own problems produces motion without direction.

A proposal is rejected unless it is a claim at risk rather than a topic.

- Rejected: *"Evidence capture might be slow."*
- Accepted: *"Evidence capture exceeds 200ms on repos over 5k files, which would make
  WHY? feel laggy."*

### Deciding the experiment

The agent drafts; the human approves or edits. Six fields:

| Field | |
| --- | --- |
| Claim | the falsifiable statement |
| Tier | plus why this is the cheapest tier that could settle it |
| Manipulated | what varies |
| Observed | node IDs and metrics |
| **Decision rule** | written **before** the run |
| Cost | minutes and tokens, estimated up front |

The decision rule is pre-registration borrowed from experimental science. Its entire
job is to prevent generous reading of a result you are invested in.

Proposals are ranked by **expected information gain per minute**: hollowness filled ×
how load-bearing those nodes are ÷ estimated cost. A heuristic, not a science, but
computable from data already present and a defensible answer to "which of these six
ideas do I chase".

### Escalation is a gate

Exactly three outcomes, no fourth:

- **accept at this tier** — the node paints hatched, not solid. Never later confused
  about how sure you were.
- **escalate** — requires a stated reason; the only valid one is that the answer
  matters enough to pay for certainty.
- **kill** — the idea is dead, the finding survives, the code does not.

Most things should stop at tier 1. That is the system working.

### Wandering

A child question can be spawned and the parent abandoned at any point; the parent
stays `open`, not failed. A question carries its scope as node IDs, so clicking it
later restores map, lens, traces and visual state exactly. **Resumability is what
converts wandering from losing your place into a working mode.**

### Findings and anti-rot

A finding records the claim as stated before the run, verdict, tier, receipts, node
IDs, and **surprise** — whether it matched expectation. Refutations are the highest
value entries and are marked as such.

**Findings decay.** Each cites a git range; when those files change the finding is
marked *may be stale* and its paint weakens toward hollow. Certainty expires on its
own, with no curation chore.

**Deletion is normal and lossless.** Cut the branch, keep the finding. The Ledger is
the only permanent artifact.

## Branching

A branch is tier-dependent, and mostly is not a branch:

| Tier | What exists | Git |
| --- | --- | --- |
| sketch | `.ev/sketches/<question-id>/`, gitignored | none |
| branch | worktree at `.worktree/exp-<question-id>-<slug>` | real branch |
| sweep | nothing; runs against HEAD | none |

A four-minute experiment cannot afford a branch-create/checkout/cleanup cycle. Only
tier 2 touches git.

### Operations

- **fork** — from anything, one key
- **cut** — delete code, keep finding, one key
- **promote** — usually the *finding*, which becomes a spec; sketch code is disposable
  by design. Only tier 2 occasionally yields code worth cherry-picking.
- **compare** — two branches answering the same question, traced onto the same map and
  superimposed. Only possible because both traces speak node IDs; the divergence point
  is visibly where the lit paths fork. This is the operation that directly serves
  "which of my two ideas is better" and is treated as a headline feature.
- **resume** — reattach with full visual and question state
- **inventory** — what is alive, stale, or untouched

## The Ledger

| | Scratch | Ledger |
| --- | --- | --- |
| Contains | live per-node conversation, hypotheses | findings + receipts |
| Lifetime | the session | permanent, in git |
| Entry | automatic | **only on explicit keystroke** |

This is "memory that only contains what I ask it to", solved by construction rather
than curation. Nothing is auto-promoted.

Storage is append-only JSONL (existing `store.mjs`) plus a **generated** `.ev/findings.md`
that is readable, diffable and portable into a PR doc. Generated, never hand-edited.

## The agent

Every turn receives a context envelope built deterministically from UI state. The
model never guesses what was meant.

```js
{ focus:      nodeId | [nodeIds],
  level:      "system" | "inside",
  lens:       "whole" | "delta" | "tension",
  lastTrace:  traceId | null,
  question:   openQuestionId | null,
  findings:   [...touching focus],
  evidence:   "observed" | "derived" | "predicted" | "unknown",
  cites:      [files, symbols] }
```

Three authorities, extending the separation already built:

| Thread | May write |
| --- | --- |
| Explainer (read-only) | nothing |
| Experimenter | only `.ev/sketches/<id>/` or its own `exp-*` worktree |
| Executor | the real repo — and never sees explanation questions |

## Reuse and cuts

**Reuse — most of the machinery already exists:**

- `apps/daemon/lib/evidence.mjs` — capture, redaction, provenance vocabulary
- `apps/daemon/lib/experiment-runner.mjs`, `experiment-adapters.mjs`, receipts — this
  is the Rig
- `apps/daemon/lib/presentation.mjs` — keep the principle (deterministic budgets,
  explicit fallback on malformed model output), retarget output to map annotations
- `apps/daemon/lib/store.mjs`, worktrees, `codex-app-server.mjs` thread isolation
- `.ev/capabilities.json` — becomes the adapter registry, scoped to node IDs

**Cut or demote:**

- `apps/web/explain.html` as the primary surface — becomes the right rail, scoped by
  the envelope. Same machinery, demoted from protagonist.
- The 10/10 acceptance contract — a completeness rubric for a finished capability.
  Prototyping does not finish things; organising around a completeness score fights
  divergent work. Optional per-capability check, not the goal.

**Park:** tmux fleet control, attention detection and the voice companion are *EV
Mission Control* — live orchestration, the moment explicitly not chosen. The repo
currently holds two products sharing a daemon. Naming the seam now is far cheaper than
discovering it at 8,000 lines.

## Failure modes

1. **The map is wrong.** Every node cites files; a validator checks the paths exist and
   flags nodes whose citations are all deleted. Hand-editable and git-diffable, so
   correction is a one-line edit.
2. **Layout death.** Reserved grid space, ghost slots, and a rare explicit
   human-approved re-lay out. Never an automatic reshuffle.
3. **Sketch rigs lie.** The credibility risk that kills the product. Hatched never
   silently becomes solid; the rig must **declare its own fakes** in the receipt; every
   tier-1 finding displays `stubbed: X, Y, Z` beside its number. A rig that cannot
   enumerate what it faked cannot produce a finding.
4. **Traces do not bind to nodes.** File-path lookup from node citations (stack frame →
   file → node) covers most cases. Unresolved frames render as **off-map time**, which
   turns the failure into a metric: off-map time measures how bad the map is.
5. **The agent nominates badly.** Proposals must be claims at risk; the human always
   selects; the Ledger records nomination-to-outcome so hit rate is visible.
6. **Sludge.** Decay, `inventory`, surprise marking.
7. **It becomes a beautiful thing nobody uses.** The realest risk given this repo's
   history. Only defence is a vertical slice running on this repo within a week, at
   tier 1 only.

## Scope

| v1 | Deferred |
| --- | --- |
| `map.json` + validator, hand-editable | tension lens (needs history) |
| flat 2D renderer, pinned positions, index rail | `compare` (needs tier 2) |
| keyboard navigation | *inside* level |
| `whole` + `delta` lenses | tier-2 worktrees, tier-3 sweeps |
| evidence fill encoding | bait markers |
| right rail scoped by envelope | |
| tier-1 sketch rigs, trace binding, animation | |
| Ledger, explicit promote, `findings.md` | |

## Verification

Unit and integration coverage follows existing repo discipline (node test runner, no
dependencies): map validation, deterministic envelope construction, trace-to-node
binding, decay computation, ledger promotion, receipt reproducibility, presentation
budgets.

The product-level acceptance test is behavioural, deliberately replacing the 10/10
rubric:

> Within one week of use on this repo: at least **5 questions resolved at tier 1**, at
> least **1 escalated**, at least **1 killed**, and at least **1 finding that
> surprised you**.

If nothing is ever killed, the tool is not cheap enough to fail in. If nothing ever
surprises, it is a viewer rather than an instrument.

**Carried-forward limit:** `EXPLANATION_WINDOW.md` records that browser layout and
interaction went unverified in the last pass. For a text panel that was tolerable. For
a map-primary product the visual encoding *is* the product, and visual verification is
mandatory.
