# Prototyping Workbench v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the v1 vertical slice of the Prototyping Workbench — a stable spatial map of this repo, painted with evidence status and branch delta, with tier-1 sketch rigs whose traces animate onto the map and whose findings persist in a Ledger.

**Architecture:** A new `apps/daemon/lib/workbench/` module tree of small pure functions (map validation, trace binding, evidence status, delta, envelope, ledger) plus one impure runner (sketch rigs, child-process isolated). The daemon exposes them under `/api/workbench/*`. A new browser surface at `apps/web/map.html` renders an SVG map from `.ev/map.json`, with pure encoding logic factored into `apps/web/lib/` so it is testable under `node --test`.

**Tech Stack:** Node.js >= 22, ESM `.mjs`, zero runtime dependencies, `node:test` + `node:assert/strict`, plain HTML/CSS/JS with inline SVG. No framework, no bundler.

## Global Constraints

- **No new npm dependencies.** The repo is dependency-free and stays that way.
- **Node >= 22**, ESM only, `.mjs` extension on every source file.
- **Factory pattern:** modules export `createX({ deps })` returning a plain object of functions, matching `createExplainer` / `createExperimentRunner`.
- **HTTP errors:** `throw Object.assign(new Error("message"), { statusCode: 4xx })`.
- **Event ledger:** all persistence via `store.append(type, payload, correlationId)` on the existing `EventStore`. No new database.
- **Tests** live in `apps/daemon/tests/*.test.mjs` and are picked up by the existing `npm test` glob.
- **Pure-first:** filesystem, git, and child processes are injected as parameters so every module has a dependency-free unit test.
- **Node IDs are the coordinate system.** Traces, findings, deltas, and evidence status all key on `nodeId`.
- **Commit after every task.** No `Co-Authored-By` trailers (user preference).

---

## File Structure

**New — daemon:**

| File | Responsibility |
| --- | --- |
| `apps/daemon/lib/workbench/git.mjs` | changed files and HEAD for a git range |
| `apps/daemon/lib/workbench/map-model.mjs` | load + validate `.ev/map.json` |
| `apps/daemon/lib/workbench/trace-binding.mjs` | file path → nodeId; frames → walk + off-map |
| `apps/daemon/lib/workbench/ledger.mjs` | findings: promote, query, staleness, markdown |
| `apps/daemon/lib/workbench/evidence-status.mjs` | findings → per-node observed/derived/predicted/unknown |
| `apps/daemon/lib/workbench/lens-delta.mjs` | changed files → touched / neighbors / untouched |
| `apps/daemon/lib/workbench/envelope.mjs` | UI state → deterministic agent context envelope |
| `apps/daemon/lib/workbench/sketch-rig.mjs` | run `.ev/sketches/<id>/rig.mjs` in a child process |
| `apps/daemon/lib/workbench/index.mjs` | `createWorkbench({...})` façade the server calls |

**New — web:**

| File | Responsibility |
| --- | --- |
| `apps/web/lib/encoding.mjs` | pure: status → fill, delta band → opacity, node geometry |
| `apps/web/map.html` | the workbench surface |
| `apps/web/map.css` | palette, hatch patterns, rail layout |
| `apps/web/map.js` | fetch, render SVG, keyboard nav, trace animation |

**New — data:** `.ev/map.json` (committed), `.ev/sketches/` (gitignored), `.ev/findings.md` (generated).

**Modified:** `lab/lib/process.mjs` (add `cwd`), `apps/daemon/server.mjs` (routes), `.gitignore`.

---

### Task 1: Give `run()` a working directory, and add a git helper

`lab/lib/process.mjs` currently drops `options.cwd`, so every git call would run against the daemon's cwd rather than the target repo.

**Files:**
- Modify: `lab/lib/process.mjs:6-15`
- Create: `apps/daemon/lib/workbench/git.mjs`
- Test: `apps/daemon/tests/workbench-git.test.mjs`

**Interfaces:**
- Consumes: `run(command, args, options)` from `lab/lib/process.mjs`
- Produces:
  - `createGit({ runImpl = run })` → `{ head(cwd), changedFiles(cwd, base) }`
  - `head(cwd)` → `Promise<string>` (40-char sha)
  - `changedFiles(cwd, base)` → `Promise<string[]>` of repo-relative POSIX paths, sorted, deduped; includes uncommitted and untracked changes

- [ ] **Step 1: Write the failing test**

```js
// apps/daemon/tests/workbench-git.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createGit } from "../lib/workbench/git.mjs";

function fakeRun(responses) {
  const calls = [];
  return {
    calls,
    impl: async (command, args, options) => {
      calls.push({ command, args, cwd: options?.cwd });
      const key = args.join(" ");
      if (!(key in responses)) throw new Error(`unexpected git call: ${key}`);
      return { stdout: responses[key], stderr: "", durationMs: 1 };
    }
  };
}

test("head returns the trimmed sha and runs in the given cwd", async () => {
  const { calls, impl } = fakeRun({ "rev-parse HEAD": "abc123\n" });
  const git = createGit({ runImpl: impl });
  assert.equal(await git.head("/work/repo"), "abc123");
  assert.equal(calls[0].cwd, "/work/repo");
});

test("changedFiles merges committed, uncommitted, and untracked paths", async () => {
  const { impl } = fakeRun({
    "diff --name-only main...HEAD": "src/a.mjs\nsrc/b.mjs\n",
    "diff --name-only HEAD": "src/b.mjs\n",
    "ls-files --others --exclude-standard": "src/c.mjs\n"
  });
  const git = createGit({ runImpl: impl });
  assert.deepEqual(await git.changedFiles("/work/repo", "main"), ["src/a.mjs", "src/b.mjs", "src/c.mjs"]);
});

test("changedFiles returns an empty list when git fails", async () => {
  const git = createGit({ runImpl: async () => { throw new Error("not a git repository"); } });
  assert.deepEqual(await git.changedFiles("/tmp/nope", "main"), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/daemon/tests/workbench-git.test.mjs`
Expected: FAIL — `Cannot find module '../lib/workbench/git.mjs'`

- [ ] **Step 3: Add `cwd` passthrough**

In `lab/lib/process.mjs`, inside the `execFileAsync` options object, add one line after `encoding: "utf8",`:

```js
    cwd: options.cwd ?? process.cwd(),
```

- [ ] **Step 4: Write the git helper**

```js
// apps/daemon/lib/workbench/git.mjs
import { run } from "../../../../lab/lib/process.mjs";

export function createGit({ runImpl = run } = {}) {
  async function git(cwd, args) {
    const result = await runImpl("git", args, { cwd, timeoutMs: 10_000 });
    return result.stdout;
  }

  async function head(cwd) {
    return (await git(cwd, ["rev-parse", "HEAD"])).trim();
  }

  async function changedFiles(cwd, base) {
    const queries = [
      ["diff", "--name-only", `${base}...HEAD`],
      ["diff", "--name-only", "HEAD"],
      ["ls-files", "--others", "--exclude-standard"]
    ];
    const paths = new Set();
    for (const args of queries) {
      let stdout;
      try { stdout = await git(cwd, args); }
      catch { return []; }
      for (const line of stdout.split("\n")) if (line.trim()) paths.add(line.trim());
    }
    return [...paths].sort();
  }

  return { head, changedFiles };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test apps/daemon/tests/workbench-git.test.mjs`
Expected: PASS, 3 tests

- [ ] **Step 6: Verify nothing else broke and commit**

Run: `npm test`
Expected: all existing suites still pass

```bash
git add lab/lib/process.mjs apps/daemon/lib/workbench/git.mjs apps/daemon/tests/workbench-git.test.mjs
git commit -m "feat(workbench): add cwd-aware process runner and git helper"
```

---

### Task 2: System map model and validator

**Files:**
- Create: `apps/daemon/lib/workbench/map-model.mjs`
- Test: `apps/daemon/tests/workbench-map-model.test.mjs`

**Interfaces:**
- Produces:
  - `validateSystemMap(map)` → `{ ok: boolean, errors: string[] }` — pure, no filesystem
  - `loadSystemMap({ projectRoot, readFileImpl })` → `Promise<{ map, errors }>`; throws `statusCode: 404` when `.ev/map.json` is absent
  - `checkCitations({ map, projectRoot, existsImpl })` → `Promise<{ nodeId, missing: string[] }[]>`
  - `nodeById(map, id)` → node object or `null`
  - `neighborsOf(map, id)` → `string[]` of node ids one edge away in either direction

**Map shape** (this is the contract every later task depends on):

```js
{
  schemaVersion: 1,
  grid: { cols: 24, rows: 16 },
  groups: [{ id: "core", label: "THE SYSTEM" }],
  nodes: [{
    id: "evidence-capture",          // kebab-case, unique
    name: "Evidence Capture",        // plain language, not a filename
    purpose: "One line.",
    group: "core",
    x: 4, y: 3,                      // integer grid cell, unique per node
    weight: 3,                       // 1..4, drives rendered area
    cites: ["apps/daemon/lib/evidence.mjs"]
  }],
  edges: [{ from: "evidence-capture", to: "explainer", kind: "data" }]
}
```

- [ ] **Step 1: Write the failing test**

```js
// apps/daemon/tests/workbench-map-model.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { validateSystemMap, checkCitations, nodeById, neighborsOf } from "../lib/workbench/map-model.mjs";

function validMap() {
  return {
    schemaVersion: 1,
    grid: { cols: 8, rows: 8 },
    groups: [{ id: "core", label: "CORE" }],
    nodes: [
      { id: "a", name: "Alpha", purpose: "p", group: "core", x: 1, y: 1, weight: 2, cites: ["src/a.mjs"] },
      { id: "b", name: "Beta", purpose: "p", group: "core", x: 3, y: 1, weight: 1, cites: ["src/b.mjs"] }
    ],
    edges: [{ from: "a", to: "b", kind: "data" }]
  };
}

test("a well-formed map validates", () => {
  assert.deepEqual(validateSystemMap(validMap()), { ok: true, errors: [] });
});

test("duplicate node ids are rejected", () => {
  const map = validMap();
  map.nodes[1].id = "a";
  const result = validateSystemMap(map);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /duplicate node id "a"/.test(error)));
});

test("two nodes occupying one cell are rejected", () => {
  const map = validMap();
  map.nodes[1].x = 1;
  const result = validateSystemMap(map);
  assert.ok(result.errors.some((error) => /cell 1,1/.test(error)));
});

test("positions outside the grid are rejected", () => {
  const map = validMap();
  map.nodes[1].x = 99;
  assert.ok(validateSystemMap(map).errors.some((error) => /outside the grid/.test(error)));
});

test("edges to unknown nodes are rejected", () => {
  const map = validMap();
  map.edges.push({ from: "a", to: "ghost", kind: "data" });
  assert.ok(validateSystemMap(map).errors.some((error) => /unknown node "ghost"/.test(error)));
});

test("a node with no citations is rejected", () => {
  const map = validMap();
  map.nodes[0].cites = [];
  assert.ok(validateSystemMap(map).errors.some((error) => /"a" cites no files/.test(error)));
});

test("checkCitations reports files that no longer exist", async () => {
  const present = new Set(["/repo/src/a.mjs"]);
  const result = await checkCitations({
    map: validMap(),
    projectRoot: "/repo",
    existsImpl: async (path) => present.has(path)
  });
  assert.deepEqual(result, [{ nodeId: "b", missing: ["src/b.mjs"] }]);
});

test("neighborsOf walks edges in both directions", () => {
  assert.deepEqual(neighborsOf(validMap(), "b"), ["a"]);
  assert.equal(nodeById(validMap(), "ghost"), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/daemon/tests/workbench-map-model.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```js
// apps/daemon/lib/workbench/map-model.mjs
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function validateSystemMap(map) {
  const errors = [];
  if (map?.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  const cols = map?.grid?.cols;
  const rows = map?.grid?.rows;
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) errors.push("grid.cols and grid.rows must be integers");
  if (!Array.isArray(map?.nodes) || !map.nodes.length) errors.push("nodes must be a non-empty array");
  if (!Array.isArray(map?.edges)) errors.push("edges must be an array");
  if (errors.length) return { ok: false, errors };

  const groupIds = new Set((map.groups ?? []).map((group) => group.id));
  const seenIds = new Set();
  const seenCells = new Set();
  for (const node of map.nodes) {
    if (!ID_PATTERN.test(node.id ?? "")) errors.push(`node id "${node.id}" must be kebab-case`);
    if (seenIds.has(node.id)) errors.push(`duplicate node id "${node.id}"`);
    seenIds.add(node.id);
    if (!node.name?.trim()) errors.push(`node "${node.id}" has no name`);
    if (!node.purpose?.trim()) errors.push(`node "${node.id}" has no purpose`);
    if (!groupIds.has(node.group)) errors.push(`node "${node.id}" references unknown group "${node.group}"`);
    if (!Number.isInteger(node.x) || !Number.isInteger(node.y) || node.x < 0 || node.y < 0 || node.x >= cols || node.y >= rows) {
      errors.push(`node "${node.id}" is outside the grid`);
    } else {
      const cell = `${node.x},${node.y}`;
      if (seenCells.has(cell)) errors.push(`nodes overlap at cell ${cell}`);
      seenCells.add(cell);
    }
    if (!Number.isInteger(node.weight) || node.weight < 1 || node.weight > 4) errors.push(`node "${node.id}" weight must be 1..4`);
    if (!Array.isArray(node.cites) || !node.cites.length) errors.push(`node "${node.id}" cites no files`);
  }
  for (const edge of map.edges) {
    for (const end of [edge.from, edge.to]) {
      if (!seenIds.has(end)) errors.push(`edge references unknown node "${end}"`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export async function loadSystemMap({ projectRoot, readFileImpl = readFile }) {
  const path = join(projectRoot, ".ev", "map.json");
  let source;
  try { source = await readFileImpl(path, "utf8"); }
  catch { throw Object.assign(new Error("No system map: .ev/map.json is missing"), { statusCode: 404 }); }
  let map;
  try { map = JSON.parse(source); }
  catch { throw Object.assign(new Error(".ev/map.json is not valid JSON"), { statusCode: 422 }); }
  const { errors } = validateSystemMap(map);
  return { map, errors };
}

async function fileExists(path) {
  try { await access(path); return true; }
  catch { return false; }
}

export async function checkCitations({ map, projectRoot, existsImpl = fileExists }) {
  const report = [];
  for (const node of map.nodes) {
    const missing = [];
    for (const cite of node.cites) {
      if (!(await existsImpl(join(projectRoot, cite)))) missing.push(cite);
    }
    if (missing.length) report.push({ nodeId: node.id, missing });
  }
  return report;
}

export function nodeById(map, id) {
  return map.nodes.find((node) => node.id === id) ?? null;
}

export function neighborsOf(map, id) {
  const found = new Set();
  for (const edge of map.edges) {
    if (edge.from === id) found.add(edge.to);
    if (edge.to === id) found.add(edge.from);
  }
  return [...found].sort();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test apps/daemon/tests/workbench-map-model.test.mjs`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/lib/workbench/map-model.mjs apps/daemon/tests/workbench-map-model.test.mjs
git commit -m "feat(workbench): add system map model and validator"
```

---

### Task 3: Author `.ev/map.json` for this repo

The dogfood step. The map must describe EV itself, because v1 is verified by using it on this repo.

**Files:**
- Create: `.ev/map.json`
- Test: `apps/daemon/tests/workbench-repo-map.test.mjs`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `validateSystemMap`, `checkCitations` from Task 2
- Produces: a committed, valid `.ev/map.json` whose every citation resolves

- [ ] **Step 1: Write the failing test**

```js
// apps/daemon/tests/workbench-repo-map.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSystemMap, checkCitations } from "../lib/workbench/map-model.mjs";

const projectRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

test("this repo's own map is valid", async () => {
  const { errors } = await loadSystemMap({ projectRoot });
  assert.deepEqual(errors, []);
});

test("every citation in this repo's map resolves to a real file", async () => {
  const { map } = await loadSystemMap({ projectRoot });
  assert.deepEqual(await checkCitations({ map, projectRoot }), []);
});

test("the map compresses the system to a legible size", async () => {
  const { map } = await loadSystemMap({ projectRoot });
  assert.ok(map.nodes.length >= 12 && map.nodes.length <= 40, `expected 12..40 nodes, got ${map.nodes.length}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/daemon/tests/workbench-repo-map.test.mjs`
Expected: FAIL — "No system map: .ev/map.json is missing"

- [ ] **Step 3: Author the map**

Write `.ev/map.json` describing the current daemon. Names are plain language, never filenames. Group nodes into `THE SURFACE`, `EXPLANATION`, `EXPERIMENTS`, `FLEET CONTROL`. Leave whole grid columns empty on the right — that reserved space is where future nodes land without moving existing ones.

```json
{
  "schemaVersion": 1,
  "grid": { "cols": 20, "rows": 12 },
  "groups": [
    { "id": "surface", "label": "THE SURFACE" },
    { "id": "explanation", "label": "EXPLANATION" },
    { "id": "experiments", "label": "EXPERIMENTS" },
    { "id": "fleet", "label": "FLEET CONTROL" }
  ],
  "nodes": [
    { "id": "http-daemon", "name": "HTTP Daemon", "purpose": "Routes every browser request and serves the static surfaces.", "group": "surface", "x": 2, "y": 5, "weight": 3, "cites": ["apps/daemon/server.mjs"] },
    { "id": "control-window", "name": "Control Window", "purpose": "The tmux workstation the operator drives.", "group": "surface", "x": 0, "y": 3, "weight": 2, "cites": ["apps/web/index.html", "apps/web/app.js"] },
    { "id": "explanation-window", "name": "Explanation Window", "purpose": "The read-only second window opened by WHY?.", "group": "surface", "x": 0, "y": 7, "weight": 2, "cites": ["apps/web/explain.html", "apps/web/explain.js"] },
    { "id": "event-ledger", "name": "Event Ledger", "purpose": "Append-only JSONL record every other part writes to.", "group": "surface", "x": 2, "y": 9, "weight": 3, "cites": ["apps/daemon/lib/store.mjs"] },
    { "id": "evidence-capture", "name": "Evidence Capture", "purpose": "Gathers pane, git, project and test evidence, redacted.", "group": "explanation", "x": 5, "y": 7, "weight": 4, "cites": ["apps/daemon/lib/evidence.mjs"] },
    { "id": "explainer", "name": "Explainer", "purpose": "Turns one question plus evidence into a typed mechanics model.", "group": "explanation", "x": 8, "y": 7, "weight": 3, "cites": ["apps/daemon/lib/explainer.mjs"] },
    { "id": "codex-thread", "name": "Codex Thread", "purpose": "The isolated read-only model conversation.", "group": "explanation", "x": 11, "y": 8, "weight": 2, "cites": ["apps/daemon/lib/codex-app-server.mjs"] },
    { "id": "presentation-budget", "name": "Presentation Budget", "purpose": "Deterministically bounds model output and handles malformed replies.", "group": "explanation", "x": 8, "y": 4, "weight": 2, "cites": ["apps/daemon/lib/presentation.mjs"] },
    { "id": "capability-spec", "name": "Capability Spec", "purpose": "Validates the project's declared executable capabilities.", "group": "experiments", "x": 12, "y": 4, "weight": 2, "cites": ["apps/daemon/lib/capability-spec.mjs", ".ev/capabilities.json"] },
    { "id": "experiment-runner", "name": "Experiment Runner", "purpose": "Executes one bounded scenario and persists an immutable receipt.", "group": "experiments", "x": 14, "y": 6, "weight": 4, "cites": ["apps/daemon/lib/experiment-runner.mjs"] },
    { "id": "experiment-adapters", "name": "Experiment Adapters", "purpose": "The only code allowed to actually run a capability.", "group": "experiments", "x": 16, "y": 8, "weight": 3, "cites": ["apps/daemon/lib/experiment-adapters.mjs"] },
    { "id": "tmux-inventory", "name": "Tmux Inventory", "purpose": "Discovers live sessions and panes.", "group": "fleet", "x": 5, "y": 1, "weight": 2, "cites": ["lab/lib/tmux.mjs"] },
    { "id": "attention-detector", "name": "Attention Detector", "purpose": "Spots panes that are blocked waiting on a human.", "group": "fleet", "x": 8, "y": 1, "weight": 2, "cites": ["apps/daemon/lib/attention.mjs"] },
    { "id": "voice-companion", "name": "Voice Companion", "purpose": "Routes an utterance to a read-only answer or an orchestrator handoff.", "group": "fleet", "x": 11, "y": 1, "weight": 2, "cites": ["apps/daemon/lib/companion.mjs"] },
    { "id": "process-runner", "name": "Process Runner", "purpose": "The single choke point for every child process.", "group": "surface", "x": 5, "y": 10, "weight": 1, "cites": ["lab/lib/process.mjs"] }
  ],
  "edges": [
    { "from": "control-window", "to": "http-daemon", "kind": "control" },
    { "from": "explanation-window", "to": "http-daemon", "kind": "control" },
    { "from": "http-daemon", "to": "event-ledger", "kind": "data" },
    { "from": "http-daemon", "to": "explainer", "kind": "control" },
    { "from": "http-daemon", "to": "experiment-runner", "kind": "control" },
    { "from": "http-daemon", "to": "tmux-inventory", "kind": "data" },
    { "from": "explainer", "to": "evidence-capture", "kind": "data" },
    { "from": "explainer", "to": "codex-thread", "kind": "control" },
    { "from": "explainer", "to": "presentation-budget", "kind": "data" },
    { "from": "explainer", "to": "event-ledger", "kind": "data" },
    { "from": "experiment-runner", "to": "capability-spec", "kind": "data" },
    { "from": "experiment-runner", "to": "experiment-adapters", "kind": "control" },
    { "from": "experiment-runner", "to": "evidence-capture", "kind": "data" },
    { "from": "experiment-runner", "to": "event-ledger", "kind": "data" },
    { "from": "tmux-inventory", "to": "process-runner", "kind": "control" },
    { "from": "attention-detector", "to": "tmux-inventory", "kind": "data" },
    { "from": "voice-companion", "to": "event-ledger", "kind": "data" },
    { "from": "evidence-capture", "to": "process-runner", "kind": "control" }
  ]
}
```

- [ ] **Step 4: Ignore transient workbench state**

Append to `.gitignore`:

```
.ev/sketches/
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test apps/daemon/tests/workbench-repo-map.test.mjs`
Expected: PASS, 3 tests. If a citation fails, fix the path in `.ev/map.json` — do not weaken the test.

- [ ] **Step 6: Commit**

```bash
git add .ev/map.json .gitignore apps/daemon/tests/workbench-repo-map.test.mjs
git commit -m "feat(workbench): author the system map for this repo"
```

---

### Task 4: Trace binding and off-map measurement

**Files:**
- Create: `apps/daemon/lib/workbench/trace-binding.mjs`
- Test: `apps/daemon/tests/workbench-trace-binding.test.mjs`

**Interfaces:**
- Consumes: the map shape from Task 2
- Produces:
  - `createTraceBinder(map)` → `{ nodeForFile(path), bind(frames) }`
  - `nodeForFile(path)` → `nodeId | null`, longest-prefix match against `cites`
  - `bind(frames)` → `{ walk, offMap, offMapRatio }` where `frames` is
    `[{ file: string, ms: number, status: "observed"|"predicted" }]`,
    `walk` is `[{ nodeId, ms, status, order }]` with consecutive same-node frames merged,
    `offMap` is `{ ms, files: string[] }`, and `offMapRatio` is offMap ms ÷ total ms (0 when total is 0)

- [ ] **Step 1: Write the failing test**

```js
// apps/daemon/tests/workbench-trace-binding.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createTraceBinder } from "../lib/workbench/trace-binding.mjs";

const map = {
  schemaVersion: 1,
  grid: { cols: 8, rows: 8 },
  groups: [{ id: "core", label: "CORE" }],
  nodes: [
    { id: "runner", name: "Runner", purpose: "p", group: "core", x: 1, y: 1, weight: 2, cites: ["apps/daemon/lib"] },
    { id: "adapters", name: "Adapters", purpose: "p", group: "core", x: 3, y: 1, weight: 2, cites: ["apps/daemon/lib/experiment-adapters.mjs"] }
  ],
  edges: []
};

test("the most specific citation wins", () => {
  const binder = createTraceBinder(map);
  assert.equal(binder.nodeForFile("apps/daemon/lib/experiment-adapters.mjs"), "adapters");
  assert.equal(binder.nodeForFile("apps/daemon/lib/store.mjs"), "runner");
  assert.equal(binder.nodeForFile("apps/web/app.js"), null);
});

test("consecutive frames in one node collapse into a single walk step", () => {
  const binder = createTraceBinder(map);
  const { walk } = binder.bind([
    { file: "apps/daemon/lib/store.mjs", ms: 4, status: "observed" },
    { file: "apps/daemon/lib/explainer.mjs", ms: 6, status: "observed" },
    { file: "apps/daemon/lib/experiment-adapters.mjs", ms: 10, status: "observed" }
  ]);
  assert.deepEqual(walk, [
    { nodeId: "runner", ms: 10, status: "observed", order: 0 },
    { nodeId: "adapters", ms: 10, status: "observed", order: 1 }
  ]);
});

test("a merged step is predicted when any of its frames is predicted", () => {
  const binder = createTraceBinder(map);
  const { walk } = binder.bind([
    { file: "apps/daemon/lib/store.mjs", ms: 1, status: "observed" },
    { file: "apps/daemon/lib/explainer.mjs", ms: 1, status: "predicted" }
  ]);
  assert.equal(walk[0].status, "predicted");
});

test("unbindable frames become off-map time", () => {
  const binder = createTraceBinder(map);
  const result = binder.bind([
    { file: "apps/daemon/lib/store.mjs", ms: 30, status: "observed" },
    { file: "node_modules/x/index.js", ms: 10, status: "observed" }
  ]);
  assert.deepEqual(result.offMap, { ms: 10, files: ["node_modules/x/index.js"] });
  assert.equal(result.offMapRatio, 0.25);
});

test("an empty trace reports a zero off-map ratio rather than NaN", () => {
  assert.equal(createTraceBinder(map).bind([]).offMapRatio, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/daemon/tests/workbench-trace-binding.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```js
// apps/daemon/lib/workbench/trace-binding.mjs
export function createTraceBinder(map) {
  const claims = [];
  for (const node of map.nodes) {
    for (const cite of node.cites) claims.push({ prefix: cite, nodeId: node.id });
  }
  claims.sort((a, b) => b.prefix.length - a.prefix.length);

  function nodeForFile(path) {
    if (typeof path !== "string") return null;
    const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
    for (const claim of claims) {
      if (normalized === claim.prefix || normalized.startsWith(`${claim.prefix}/`)) return claim.nodeId;
    }
    return null;
  }

  function bind(frames) {
    const walk = [];
    const offMapFiles = [];
    let offMapMs = 0;
    let totalMs = 0;
    for (const frame of frames) {
      const ms = Number(frame.ms) || 0;
      totalMs += ms;
      const nodeId = nodeForFile(frame.file);
      if (!nodeId) {
        offMapMs += ms;
        if (!offMapFiles.includes(frame.file)) offMapFiles.push(frame.file);
        continue;
      }
      const last = walk.at(-1);
      if (last && last.nodeId === nodeId) {
        last.ms += ms;
        if (frame.status === "predicted") last.status = "predicted";
        continue;
      }
      walk.push({ nodeId, ms, status: frame.status === "predicted" ? "predicted" : "observed", order: walk.length });
    }
    return {
      walk,
      offMap: { ms: offMapMs, files: offMapFiles },
      offMapRatio: totalMs === 0 ? 0 : offMapMs / totalMs
    };
  }

  return { nodeForFile, bind };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test apps/daemon/tests/workbench-trace-binding.test.mjs`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/lib/workbench/trace-binding.mjs apps/daemon/tests/workbench-trace-binding.test.mjs
git commit -m "feat(workbench): bind execution traces to map nodes with off-map measurement"
```

---

### Task 5: The Ledger — findings, staleness, and generated markdown

**Files:**
- Create: `apps/daemon/lib/workbench/ledger.mjs`
- Test: `apps/daemon/tests/workbench-ledger.test.mjs`

**Interfaces:**
- Consumes: `store.append(type, payload, correlationId)` and `store.all()` from `EventStore`
- Produces: `createLedger({ store, now = () => new Date().toISOString() })` →
  - `promote(input)` → `Promise<Finding>`; appends a `finding.promoted` event
  - `all()` → `Promise<Finding[]>`, newest first
  - `forNodes(nodeIds)` → `Promise<Finding[]>` touching any of the ids
  - `markStale(findings, changedFiles)` → `Finding[]` with a `stale` boolean added (pure)
  - `renderMarkdown(findings)` → `string`

**Finding shape:**

```js
{ findingId, questionId, claim, verdict, tier, surprise, nodeIds,
  receiptIds, gitHead, cites, stubbed, createdAt, stale }
```

`verdict` is `"confirmed" | "refuted" | "inconclusive"`. `tier` is `"sketch" | "branch" | "sweep"`.

- [ ] **Step 1: Write the failing test**

```js
// apps/daemon/tests/workbench-ledger.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createLedger } from "../lib/workbench/ledger.mjs";

function fakeStore() {
  const events = [];
  return {
    events,
    async append(type, payload, correlationId) {
      const event = { type, payload, correlationId, occurredAt: "2026-08-15T00:00:00.000Z" };
      events.push(event);
      return event;
    },
    async all() { return events; }
  };
}

const base = {
  questionId: "q1",
  claim: "Evidence capture stays under 200ms on this repo",
  verdict: "confirmed",
  tier: "sketch",
  surprise: false,
  nodeIds: ["evidence-capture"],
  receiptIds: ["experiment-abc"],
  gitHead: "abc123",
  cites: ["apps/daemon/lib/evidence.mjs"],
  stubbed: ["git subprocess"]
};

test("promoting writes one event and returns a finding with an id", async () => {
  const store = fakeStore();
  const ledger = createLedger({ store });
  const finding = await ledger.promote(base);
  assert.match(finding.findingId, /^finding-/);
  assert.equal(store.events.length, 1);
  assert.equal(store.events[0].type, "finding.promoted");
  assert.equal(store.events[0].correlationId, "q1");
});

test("nothing enters the ledger without an explicit promote", async () => {
  const ledger = createLedger({ store: fakeStore() });
  assert.deepEqual(await ledger.all(), []);
});

test("a sketch-tier finding must declare what it stubbed", async () => {
  const ledger = createLedger({ store: fakeStore() });
  await assert.rejects(
    () => ledger.promote({ ...base, stubbed: undefined }),
    /sketch-tier findings must declare stubbed/
  );
});

test("an unknown verdict is rejected", async () => {
  const ledger = createLedger({ store: fakeStore() });
  await assert.rejects(() => ledger.promote({ ...base, verdict: "great" }), /verdict must be/);
});

test("forNodes returns only findings touching the given nodes", async () => {
  const ledger = createLedger({ store: fakeStore() });
  await ledger.promote(base);
  await ledger.promote({ ...base, questionId: "q2", nodeIds: ["explainer"] });
  const found = await ledger.forNodes(["explainer"]);
  assert.equal(found.length, 1);
  assert.equal(found[0].questionId, "q2");
});

test("a finding goes stale when a file it cites changes", () => {
  const ledger = createLedger({ store: fakeStore() });
  const findings = [
    { ...base, findingId: "f1", cites: ["apps/daemon/lib/evidence.mjs"] },
    { ...base, findingId: "f2", cites: ["apps/daemon/lib/store.mjs"] }
  ];
  const marked = ledger.markStale(findings, ["apps/daemon/lib/evidence.mjs"]);
  assert.equal(marked.find((item) => item.findingId === "f1").stale, true);
  assert.equal(marked.find((item) => item.findingId === "f2").stale, false);
});

test("markdown shows the tier, the verdict, and what was stubbed", () => {
  const ledger = createLedger({ store: fakeStore() });
  const markdown = ledger.renderMarkdown([{ ...base, findingId: "f1", createdAt: "2026-08-15T00:00:00.000Z", stale: false }]);
  assert.match(markdown, /# Findings/);
  assert.match(markdown, /confirmed · sketch/);
  assert.match(markdown, /Stubbed: git subprocess/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/daemon/tests/workbench-ledger.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```js
// apps/daemon/lib/workbench/ledger.mjs
import { randomUUID } from "node:crypto";

const VERDICTS = new Set(["confirmed", "refuted", "inconclusive"]);
const TIERS = new Set(["sketch", "branch", "sweep"]);

export function createLedger({ store, now = () => new Date().toISOString() }) {
  async function promote(input) {
    if (!input?.claim?.trim()) throw Object.assign(new Error("A finding needs a claim"), { statusCode: 400 });
    if (!VERDICTS.has(input.verdict)) throw Object.assign(new Error("verdict must be confirmed, refuted, or inconclusive"), { statusCode: 400 });
    if (!TIERS.has(input.tier)) throw Object.assign(new Error("tier must be sketch, branch, or sweep"), { statusCode: 400 });
    if (!Array.isArray(input.nodeIds) || !input.nodeIds.length) throw Object.assign(new Error("A finding must name at least one node"), { statusCode: 400 });
    if (input.tier === "sketch" && !Array.isArray(input.stubbed)) {
      throw Object.assign(new Error("sketch-tier findings must declare stubbed"), { statusCode: 400 });
    }
    const finding = {
      findingId: `finding-${randomUUID().slice(0, 10)}`,
      questionId: input.questionId ?? null,
      claim: input.claim.trim(),
      verdict: input.verdict,
      tier: input.tier,
      surprise: Boolean(input.surprise),
      nodeIds: [...input.nodeIds],
      receiptIds: input.receiptIds ?? [],
      gitHead: input.gitHead ?? null,
      cites: input.cites ?? [],
      stubbed: input.stubbed ?? [],
      createdAt: now(),
      stale: false
    };
    await store.append("finding.promoted", { finding }, finding.questionId);
    return finding;
  }

  async function all() {
    return (await store.all())
      .filter((event) => event.type === "finding.promoted")
      .map((event) => event.payload.finding)
      .reverse();
  }

  async function forNodes(nodeIds) {
    const wanted = new Set(nodeIds);
    return (await all()).filter((finding) => finding.nodeIds.some((id) => wanted.has(id)));
  }

  function markStale(findings, changedFiles) {
    const changed = new Set(changedFiles);
    return findings.map((finding) => ({ ...finding, stale: finding.cites.some((cite) => changed.has(cite)) }));
  }

  function renderMarkdown(findings) {
    const lines = ["# Findings", "", "Generated by the workbench. Do not edit by hand.", ""];
    for (const finding of findings) {
      lines.push(`## ${finding.claim}`);
      lines.push("");
      lines.push(`**${finding.verdict} · ${finding.tier}**${finding.surprise ? " · surprising" : ""}${finding.stale ? " · may be stale" : ""}`);
      lines.push("");
      lines.push(`- Nodes: ${finding.nodeIds.join(", ")}`);
      if (finding.stubbed.length) lines.push(`- Stubbed: ${finding.stubbed.join(", ")}`);
      if (finding.receiptIds.length) lines.push(`- Receipts: ${finding.receiptIds.join(", ")}`);
      lines.push(`- Established at ${finding.createdAt} on ${finding.gitHead ?? "unknown head"}`);
      lines.push("");
    }
    return lines.join("\n");
  }

  return { promote, all, forNodes, markStale, renderMarkdown };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test apps/daemon/tests/workbench-ledger.test.mjs`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/lib/workbench/ledger.mjs apps/daemon/tests/workbench-ledger.test.mjs
git commit -m "feat(workbench): add the findings ledger with staleness and markdown output"
```

---

### Task 6: Evidence status per node

**Files:**
- Create: `apps/daemon/lib/workbench/evidence-status.mjs`
- Test: `apps/daemon/tests/workbench-evidence-status.test.mjs`

**Interfaces:**
- Consumes: the Finding shape from Task 5
- Produces: `evidenceStatusForNodes({ map, findings })` → `Record<nodeId, "observed"|"derived"|"predicted"|"unknown">`

**Rules,** strongest wins, and a stale finding is demoted one rank:

| Condition | Status |
| --- | --- |
| a non-stale `branch` or `sweep` finding touches the node | `observed` |
| a non-stale `sketch` finding, or a stale `branch`/`sweep` finding | `derived` |
| only a stale `sketch` finding | `predicted` |
| no finding at all | `unknown` |

- [ ] **Step 1: Write the failing test**

```js
// apps/daemon/tests/workbench-evidence-status.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { evidenceStatusForNodes } from "../lib/workbench/evidence-status.mjs";

const map = {
  nodes: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]
};

function finding(nodeId, tier, stale = false) {
  return { findingId: `f-${nodeId}`, nodeIds: [nodeId], tier, stale };
}

test("nodes with no findings are unknown", () => {
  assert.equal(evidenceStatusForNodes({ map, findings: [] }).a, "unknown");
});

test("a real branch run makes a node observed", () => {
  const status = evidenceStatusForNodes({ map, findings: [finding("a", "branch")] });
  assert.equal(status.a, "observed");
});

test("a sketch run makes a node derived, never observed", () => {
  const status = evidenceStatusForNodes({ map, findings: [finding("b", "sketch")] });
  assert.equal(status.b, "derived");
});

test("staleness demotes one rank", () => {
  const status = evidenceStatusForNodes({
    map,
    findings: [finding("c", "sweep", true), finding("d", "sketch", true)]
  });
  assert.equal(status.c, "derived");
  assert.equal(status.d, "predicted");
});

test("the strongest finding on a node wins", () => {
  const status = evidenceStatusForNodes({
    map,
    findings: [finding("a", "sketch"), finding("a", "branch")]
  });
  assert.equal(status.a, "observed");
});

test("every node in the map appears in the result", () => {
  const status = evidenceStatusForNodes({ map, findings: [] });
  assert.deepEqual(Object.keys(status).sort(), ["a", "b", "c", "d"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/daemon/tests/workbench-evidence-status.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```js
// apps/daemon/lib/workbench/evidence-status.mjs
const RANKS = ["unknown", "predicted", "derived", "observed"];

function rankFor(finding) {
  const base = finding.tier === "branch" || finding.tier === "sweep" ? 3 : 2;
  return finding.stale ? base - 1 : base;
}

export function evidenceStatusForNodes({ map, findings }) {
  const ranks = Object.fromEntries(map.nodes.map((node) => [node.id, 0]));
  for (const finding of findings) {
    const rank = rankFor(finding);
    for (const nodeId of finding.nodeIds) {
      if (!(nodeId in ranks)) continue;
      if (rank > ranks[nodeId]) ranks[nodeId] = rank;
    }
  }
  return Object.fromEntries(Object.entries(ranks).map(([nodeId, rank]) => [nodeId, RANKS[rank]]));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test apps/daemon/tests/workbench-evidence-status.test.mjs`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/lib/workbench/evidence-status.mjs apps/daemon/tests/workbench-evidence-status.test.mjs
git commit -m "feat(workbench): derive per-node evidence status from ledger findings"
```

---

### Task 7: Delta lens

**Files:**
- Create: `apps/daemon/lib/workbench/lens-delta.mjs`
- Test: `apps/daemon/tests/workbench-lens-delta.test.mjs`

**Interfaces:**
- Consumes: `createTraceBinder(map).nodeForFile` from Task 4, `neighborsOf` from Task 2
- Produces: `computeDelta({ map, changedFiles, evidenceStatus })` →
  `{ touched: string[], neighbors: string[], untouched: string[], unverified: string[], unmappedFiles: string[] }`
  where `unverified` is the subset of `touched` whose status is `predicted` or `unknown` — the highest-value signal in the product

- [ ] **Step 1: Write the failing test**

```js
// apps/daemon/tests/workbench-lens-delta.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { computeDelta } from "../lib/workbench/lens-delta.mjs";

const map = {
  nodes: [
    { id: "a", cites: ["src/a.mjs"] },
    { id: "b", cites: ["src/b.mjs"] },
    { id: "c", cites: ["src/c.mjs"] }
  ],
  edges: [{ from: "a", to: "b", kind: "data" }]
};

test("changed files resolve to touched nodes", () => {
  const result = computeDelta({ map, changedFiles: ["src/a.mjs"], evidenceStatus: { a: "observed", b: "observed", c: "observed" } });
  assert.deepEqual(result.touched, ["a"]);
});

test("one-hop neighbours are the blast radius and exclude touched nodes", () => {
  const result = computeDelta({ map, changedFiles: ["src/a.mjs"], evidenceStatus: { a: "observed", b: "observed", c: "observed" } });
  assert.deepEqual(result.neighbors, ["b"]);
  assert.deepEqual(result.untouched, ["c"]);
});

test("touched nodes with no real evidence are reported as unverified", () => {
  const result = computeDelta({
    map,
    changedFiles: ["src/a.mjs", "src/b.mjs"],
    evidenceStatus: { a: "unknown", b: "observed", c: "observed" }
  });
  assert.deepEqual(result.touched, ["a", "b"]);
  assert.deepEqual(result.unverified, ["a"]);
});

test("changed files outside the map are reported rather than dropped", () => {
  const result = computeDelta({ map, changedFiles: ["docs/README.md"], evidenceStatus: {} });
  assert.deepEqual(result.unmappedFiles, ["docs/README.md"]);
  assert.deepEqual(result.touched, []);
});

test("with no changes every node is untouched", () => {
  const result = computeDelta({ map, changedFiles: [], evidenceStatus: {} });
  assert.deepEqual(result.untouched, ["a", "b", "c"]);
  assert.deepEqual(result.unverified, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/daemon/tests/workbench-lens-delta.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```js
// apps/daemon/lib/workbench/lens-delta.mjs
import { createTraceBinder } from "./trace-binding.mjs";
import { neighborsOf } from "./map-model.mjs";

export function computeDelta({ map, changedFiles, evidenceStatus = {} }) {
  const binder = createTraceBinder(map);
  const touched = new Set();
  const unmappedFiles = [];
  for (const file of changedFiles) {
    const nodeId = binder.nodeForFile(file);
    if (nodeId) touched.add(nodeId);
    else unmappedFiles.push(file);
  }
  const neighbors = new Set();
  for (const nodeId of touched) {
    for (const neighbor of neighborsOf(map, nodeId)) if (!touched.has(neighbor)) neighbors.add(neighbor);
  }
  const untouched = map.nodes
    .map((node) => node.id)
    .filter((id) => !touched.has(id) && !neighbors.has(id));
  const unverified = [...touched].filter((id) => {
    const status = evidenceStatus[id] ?? "unknown";
    return status === "unknown" || status === "predicted";
  });
  return {
    touched: [...touched].sort(),
    neighbors: [...neighbors].sort(),
    untouched: untouched.sort(),
    unverified: unverified.sort(),
    unmappedFiles
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test apps/daemon/tests/workbench-lens-delta.test.mjs`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/lib/workbench/lens-delta.mjs apps/daemon/tests/workbench-lens-delta.test.mjs
git commit -m "feat(workbench): compute the delta lens with blast radius and unverified nodes"
```

---

### Task 8: The context envelope

The deixis mechanism. Deterministic, pure, and the reason the agent knows what "this" means.

**Files:**
- Create: `apps/daemon/lib/workbench/envelope.mjs`
- Test: `apps/daemon/tests/workbench-envelope.test.mjs`

**Interfaces:**
- Consumes: map from Task 2, findings from Task 5, evidence status from Task 6
- Produces: `buildEnvelope({ map, focus, level, lens, lastTrace, questionId, findings, evidenceStatus })` →

```js
{ focus: string[], level, lens, lastTrace, questionId,
  nodes: [{ id, name, purpose, cites, evidence }],
  findings: [{ findingId, claim, verdict, tier, stale }],
  neighbors: string[] }
```

- [ ] **Step 1: Write the failing test**

```js
// apps/daemon/tests/workbench-envelope.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { buildEnvelope } from "../lib/workbench/envelope.mjs";

const map = {
  nodes: [
    { id: "a", name: "Alpha", purpose: "Does alpha.", group: "core", x: 1, y: 1, weight: 2, cites: ["src/a.mjs"] },
    { id: "b", name: "Beta", purpose: "Does beta.", group: "core", x: 2, y: 1, weight: 2, cites: ["src/b.mjs"] }
  ],
  edges: [{ from: "a", to: "b", kind: "data" }]
};

const findings = [
  { findingId: "f1", claim: "alpha is fast", verdict: "confirmed", tier: "sketch", stale: false, nodeIds: ["a"] },
  { findingId: "f2", claim: "beta is slow", verdict: "refuted", tier: "branch", stale: false, nodeIds: ["b"] }
];

test("the envelope carries the focused node's identity and citations", () => {
  const envelope = buildEnvelope({
    map, focus: ["a"], level: "system", lens: "whole",
    lastTrace: null, questionId: null, findings, evidenceStatus: { a: "derived", b: "observed" }
  });
  assert.deepEqual(envelope.focus, ["a"]);
  assert.deepEqual(envelope.nodes, [{ id: "a", name: "Alpha", purpose: "Does alpha.", cites: ["src/a.mjs"], evidence: "derived" }]);
  assert.deepEqual(envelope.neighbors, ["b"]);
});

test("only findings touching the focus are included", () => {
  const envelope = buildEnvelope({
    map, focus: ["a"], level: "system", lens: "whole",
    lastTrace: null, questionId: null, findings, evidenceStatus: {}
  });
  assert.deepEqual(envelope.findings.map((item) => item.findingId), ["f1"]);
});

test("an unknown focus id is dropped rather than crashing", () => {
  const envelope = buildEnvelope({
    map, focus: ["ghost"], level: "system", lens: "whole",
    lastTrace: null, questionId: null, findings, evidenceStatus: {}
  });
  assert.deepEqual(envelope.nodes, []);
  assert.deepEqual(envelope.focus, []);
});

test("the envelope is deterministic for identical input", () => {
  const args = {
    map, focus: ["b", "a"], level: "inside", lens: "delta",
    lastTrace: "trace-1", questionId: "q1", findings, evidenceStatus: { a: "derived", b: "observed" }
  };
  assert.equal(JSON.stringify(buildEnvelope(args)), JSON.stringify(buildEnvelope(args)));
});

test("focus order is normalised so the envelope is stable", () => {
  const shared = { map, level: "system", lens: "whole", lastTrace: null, questionId: null, findings, evidenceStatus: {} };
  assert.deepEqual(buildEnvelope({ ...shared, focus: ["b", "a"] }).focus, ["a", "b"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/daemon/tests/workbench-envelope.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```js
// apps/daemon/lib/workbench/envelope.mjs
import { nodeById, neighborsOf } from "./map-model.mjs";

export function buildEnvelope({ map, focus, level, lens, lastTrace, questionId, findings, evidenceStatus }) {
  const wanted = [...new Set(focus ?? [])].sort();
  const resolved = wanted.map((id) => nodeById(map, id)).filter(Boolean);
  const focusIds = resolved.map((node) => node.id);
  const focusSet = new Set(focusIds);
  const neighbors = [...new Set(focusIds.flatMap((id) => neighborsOf(map, id)))]
    .filter((id) => !focusSet.has(id))
    .sort();
  return {
    focus: focusIds,
    level: level ?? "system",
    lens: lens ?? "whole",
    lastTrace: lastTrace ?? null,
    questionId: questionId ?? null,
    nodes: resolved.map((node) => ({
      id: node.id,
      name: node.name,
      purpose: node.purpose,
      cites: node.cites,
      evidence: evidenceStatus?.[node.id] ?? "unknown"
    })),
    findings: (findings ?? [])
      .filter((finding) => finding.nodeIds.some((id) => focusSet.has(id)))
      .map((finding) => ({
        findingId: finding.findingId,
        claim: finding.claim,
        verdict: finding.verdict,
        tier: finding.tier,
        stale: Boolean(finding.stale)
      })),
    neighbors
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test apps/daemon/tests/workbench-envelope.test.mjs`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/lib/workbench/envelope.mjs apps/daemon/tests/workbench-envelope.test.mjs
git commit -m "feat(workbench): build the deterministic agent context envelope"
```

---

### Task 9: Sketch rig runner

Tier 1 of the fidelity ladder. A rig is a standalone script at `.ev/sketches/<id>/rig.mjs` run in a child process, which reads inputs as JSON from `process.argv[2]` and writes one JSON object to stdout.

**Files:**
- Create: `apps/daemon/lib/workbench/sketch-rig.mjs`
- Test: `apps/daemon/tests/workbench-sketch-rig.test.mjs`

**Interfaces:**
- Consumes: `run` from `lab/lib/process.mjs`, `createTraceBinder` from Task 4, `store.append`
- Produces: `createSketchRigRunner({ projectRoot, store, map, runImpl = run, now })` →
  `runSketch({ sketchId, inputs })` → `Promise<SketchReceipt>`

**Rig output contract** (a rig that violates it produces no receipt):

```js
{ stubbed: string[],                                        // REQUIRED, may be empty
  frames: [{ file, ms, status }],                           // REQUIRED
  metrics: { latencyMs: number, iterations: number },       // REQUIRED
  assertions: [{ id, passed, expected, actual }] }          // optional, defaults []
```

**Receipt shape:**

```js
{ schemaVersion: 1, tier: "sketch", runId, sketchId, inputs, stubbed,
  walk, offMap, offMapRatio, metrics, assertions, status, startedAt, completedAt }
```

`status` is `"passed"` when every assertion passed, otherwise `"failed"`.

- [ ] **Step 1: Write the failing test**

```js
// apps/daemon/tests/workbench-sketch-rig.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createSketchRigRunner } from "../lib/workbench/sketch-rig.mjs";

const map = {
  nodes: [
    { id: "evidence-capture", name: "Evidence", purpose: "p", group: "g", x: 1, y: 1, weight: 2, cites: ["apps/daemon/lib/evidence.mjs"] },
    { id: "explainer", name: "Explainer", purpose: "p", group: "g", x: 2, y: 1, weight: 2, cites: ["apps/daemon/lib/explainer.mjs"] }
  ],
  edges: []
};

function fakeStore() {
  const events = [];
  return { events, async append(type, payload, correlationId) { events.push({ type, payload, correlationId }); } };
}

function runnerReturning(stdout) {
  return async () => ({ stdout, stderr: "", durationMs: 5 });
}

const goodOutput = JSON.stringify({
  stubbed: ["git subprocess"],
  frames: [
    { file: "apps/daemon/lib/evidence.mjs", ms: 30, status: "observed" },
    { file: "apps/daemon/lib/explainer.mjs", ms: 10, status: "observed" }
  ],
  metrics: { latencyMs: 40, iterations: 5 },
  assertions: [{ id: "under-200ms", passed: true, expected: "<200", actual: "40" }]
});

test("a well-formed rig produces a receipt with a bound walk", async () => {
  const store = fakeStore();
  const runner = createSketchRigRunner({ projectRoot: "/repo", store, map, runImpl: runnerReturning(goodOutput) });
  const receipt = await runner.runSketch({ sketchId: "evidence-cache", inputs: { n: 5 } });
  assert.equal(receipt.tier, "sketch");
  assert.equal(receipt.status, "passed");
  assert.deepEqual(receipt.walk.map((step) => step.nodeId), ["evidence-capture", "explainer"]);
  assert.deepEqual(receipt.stubbed, ["git subprocess"]);
  assert.equal(receipt.offMapRatio, 0);
});

test("a rig that does not declare stubs produces no receipt", async () => {
  const runner = createSketchRigRunner({
    projectRoot: "/repo", store: fakeStore(), map,
    runImpl: runnerReturning(JSON.stringify({ frames: [], metrics: { latencyMs: 1, iterations: 1 } }))
  });
  await assert.rejects(() => runner.runSketch({ sketchId: "bad", inputs: {} }), /must declare stubbed/);
});

test("non-JSON rig output is rejected with a clear message", async () => {
  const runner = createSketchRigRunner({
    projectRoot: "/repo", store: fakeStore(), map, runImpl: runnerReturning("boom, not json")
  });
  await assert.rejects(() => runner.runSketch({ sketchId: "bad", inputs: {} }), /did not emit valid JSON/);
});

test("a failing assertion makes the receipt failed, not an error", async () => {
  const output = JSON.parse(goodOutput);
  output.assertions = [{ id: "under-200ms", passed: false, expected: "<200", actual: "900" }];
  const runner = createSketchRigRunner({
    projectRoot: "/repo", store: fakeStore(), map, runImpl: runnerReturning(JSON.stringify(output))
  });
  const receipt = await runner.runSketch({ sketchId: "evidence-cache", inputs: {} });
  assert.equal(receipt.status, "failed");
});

test("a sketch id that escapes the sketches directory is refused", async () => {
  const runner = createSketchRigRunner({ projectRoot: "/repo", store: fakeStore(), map, runImpl: runnerReturning(goodOutput) });
  await assert.rejects(() => runner.runSketch({ sketchId: "../../etc", inputs: {} }), /sketchId must be kebab-case/);
});

test("both a start and a completion event are recorded", async () => {
  const store = fakeStore();
  const runner = createSketchRigRunner({ projectRoot: "/repo", store, map, runImpl: runnerReturning(goodOutput) });
  await runner.runSketch({ sketchId: "evidence-cache", inputs: {} });
  assert.deepEqual(store.events.map((event) => event.type), ["sketch.started", "sketch.completed"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/daemon/tests/workbench-sketch-rig.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```js
// apps/daemon/lib/workbench/sketch-rig.mjs
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { run } from "../../../../lab/lib/process.mjs";
import { createTraceBinder } from "./trace-binding.mjs";

const SKETCH_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function createSketchRigRunner({ projectRoot, store, map, runImpl = run, now = () => new Date().toISOString() }) {
  const binder = createTraceBinder(map);

  async function runSketch({ sketchId, inputs = {} }) {
    if (!SKETCH_ID.test(sketchId ?? "")) {
      throw Object.assign(new Error("sketchId must be kebab-case"), { statusCode: 400 });
    }
    const rigPath = join(projectRoot, ".ev", "sketches", sketchId, "rig.mjs");
    const runId = `sketch-${randomUUID().slice(0, 10)}`;
    const startedAt = now();
    await store.append("sketch.started", { runId, sketchId, inputs }, runId);

    let stdout;
    try {
      const result = await runImpl("node", [rigPath, JSON.stringify(inputs)], { cwd: projectRoot, timeoutMs: 60_000 });
      stdout = result.stdout;
    } catch (error) {
      await store.append("sketch.failed", { runId, sketchId, message: error.message }, runId);
      throw Object.assign(new Error(`Sketch rig "${sketchId}" did not run: ${error.message}`), { statusCode: 422 });
    }

    let output;
    try { output = JSON.parse(stdout); }
    catch {
      await store.append("sketch.failed", { runId, sketchId, message: "invalid JSON" }, runId);
      throw Object.assign(new Error(`Sketch rig "${sketchId}" did not emit valid JSON on stdout`), { statusCode: 422 });
    }

    if (!Array.isArray(output.stubbed)) {
      await store.append("sketch.failed", { runId, sketchId, message: "missing stubbed" }, runId);
      throw Object.assign(new Error(`Sketch rig "${sketchId}" must declare stubbed as an array`), { statusCode: 422 });
    }
    if (!Array.isArray(output.frames) || !output.metrics) {
      await store.append("sketch.failed", { runId, sketchId, message: "missing frames or metrics" }, runId);
      throw Object.assign(new Error(`Sketch rig "${sketchId}" must emit frames and metrics`), { statusCode: 422 });
    }

    const bound = binder.bind(output.frames);
    const assertions = output.assertions ?? [];
    const receipt = {
      schemaVersion: 1,
      tier: "sketch",
      runId,
      sketchId,
      inputs,
      stubbed: output.stubbed,
      walk: bound.walk,
      offMap: bound.offMap,
      offMapRatio: bound.offMapRatio,
      metrics: output.metrics,
      assertions,
      status: assertions.every((assertion) => assertion.passed) ? "passed" : "failed",
      startedAt,
      completedAt: now()
    };
    await store.append("sketch.completed", { receipt }, runId);
    return receipt;
  }

  return { runSketch };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test apps/daemon/tests/workbench-sketch-rig.test.mjs`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/lib/workbench/sketch-rig.mjs apps/daemon/tests/workbench-sketch-rig.test.mjs
git commit -m "feat(workbench): run tier-1 sketch rigs with mandatory stub declaration"
```

---

### Task 10: Workbench façade and HTTP routes

**Files:**
- Create: `apps/daemon/lib/workbench/index.mjs`
- Modify: `apps/daemon/server.mjs:14` (imports), `apps/daemon/server.mjs:45-49` (construction), `apps/daemon/server.mjs:234` (routes, insert before the `/api/experiments/` catch-all)
- Test: `apps/daemon/tests/workbench-facade.test.mjs`

**Interfaces:**
- Consumes: every module from Tasks 1–9
- Produces: `createWorkbench({ projectRoot, store, git, sketchRunner, loadMap })` →
  - `state({ base })` → `{ map, mapErrors, evidenceStatus, delta, findings, head, base }`
  - `envelope(input)` → the Task 8 envelope, resolved against current state
  - `promoteFinding(input)` → Finding, and rewrites `.ev/findings.md`
  - `runSketch({ sketchId, inputs })` → sketch receipt

**Routes:**

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/workbench/state?base=main` | full map state |
| POST | `/api/workbench/envelope` | envelope for a selection |
| POST | `/api/workbench/findings` | promoted finding |
| POST | `/api/workbench/sketches/run` | sketch receipt |

- [ ] **Step 1: Write the failing test**

```js
// apps/daemon/tests/workbench-facade.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkbench } from "../lib/workbench/index.mjs";

const map = {
  schemaVersion: 1,
  grid: { cols: 8, rows: 8 },
  groups: [{ id: "core", label: "CORE" }],
  nodes: [
    { id: "a", name: "Alpha", purpose: "p", group: "core", x: 1, y: 1, weight: 2, cites: ["src/a.mjs"] },
    { id: "b", name: "Beta", purpose: "p", group: "core", x: 3, y: 1, weight: 2, cites: ["src/b.mjs"] }
  ],
  edges: [{ from: "a", to: "b", kind: "data" }]
};

function fixture({ changedFiles = [] } = {}) {
  const events = [];
  const written = [];
  const store = {
    events,
    async append(type, payload, correlationId) { events.push({ type, payload, correlationId }); },
    async all() { return events; }
  };
  const workbench = createWorkbench({
    projectRoot: "/repo",
    store,
    git: { async head() { return "head1"; }, async changedFiles() { return changedFiles; } },
    sketchRunner: { async runSketch({ sketchId }) { return { runId: "sketch-1", sketchId, tier: "sketch", status: "passed" }; } },
    loadMap: async () => ({ map, errors: [] }),
    writeFileImpl: async (path, body) => { written.push({ path, body }); }
  });
  return { workbench, events, written };
}

test("state reports every node as unknown before any finding exists", async () => {
  const { workbench } = fixture();
  const state = await workbench.state({ base: "main" });
  assert.deepEqual(state.evidenceStatus, { a: "unknown", b: "unknown" });
  assert.deepEqual(state.mapErrors, []);
  assert.equal(state.head, "head1");
});

test("a promoted finding turns its node derived and appears in state", async () => {
  const { workbench } = fixture();
  await workbench.promoteFinding({
    questionId: "q1", claim: "alpha holds", verdict: "confirmed", tier: "sketch",
    nodeIds: ["a"], cites: ["src/a.mjs"], stubbed: []
  });
  const state = await workbench.state({ base: "main" });
  assert.equal(state.evidenceStatus.a, "derived");
  assert.equal(state.findings.length, 1);
});

test("promoting a finding rewrites the generated findings file", async () => {
  const { workbench, written } = fixture();
  await workbench.promoteFinding({
    questionId: "q1", claim: "alpha holds", verdict: "confirmed", tier: "sketch",
    nodeIds: ["a"], cites: ["src/a.mjs"], stubbed: []
  });
  assert.equal(written.at(-1).path, "/repo/.ev/findings.md");
  assert.match(written.at(-1).body, /alpha holds/);
});

test("a changed file marks its finding stale and demotes the node", async () => {
  const { workbench } = fixture({ changedFiles: ["src/a.mjs"] });
  await workbench.promoteFinding({
    questionId: "q1", claim: "alpha holds", verdict: "confirmed", tier: "branch",
    nodeIds: ["a"], cites: ["src/a.mjs"], stubbed: []
  });
  const state = await workbench.state({ base: "main" });
  assert.equal(state.evidenceStatus.a, "derived");
  assert.equal(state.delta.unverified.length, 0);
  assert.deepEqual(state.delta.touched, ["a"]);
});

test("the envelope resolves against live state", async () => {
  const { workbench } = fixture();
  const envelope = await workbench.envelope({ focus: ["a"], level: "system", lens: "whole" });
  assert.deepEqual(envelope.focus, ["a"]);
  assert.equal(envelope.nodes[0].evidence, "unknown");
  assert.deepEqual(envelope.neighbors, ["b"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/daemon/tests/workbench-facade.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Write the façade**

```js
// apps/daemon/lib/workbench/index.mjs
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadSystemMap } from "./map-model.mjs";
import { createLedger } from "./ledger.mjs";
import { evidenceStatusForNodes } from "./evidence-status.mjs";
import { computeDelta } from "./lens-delta.mjs";
import { buildEnvelope } from "./envelope.mjs";

export function createWorkbench({ projectRoot, store, git, sketchRunner, loadMap, writeFileImpl = writeFile }) {
  const ledger = createLedger({ store });
  const readMap = loadMap ?? (() => loadSystemMap({ projectRoot }));

  async function state({ base = "main" } = {}) {
    const { map, errors } = await readMap();
    const [head, changedFiles] = await Promise.all([git.head(projectRoot), git.changedFiles(projectRoot, base)]);
    const findings = ledger.markStale(await ledger.all(), changedFiles);
    const evidenceStatus = evidenceStatusForNodes({ map, findings });
    const delta = computeDelta({ map, changedFiles, evidenceStatus });
    return { map, mapErrors: errors, evidenceStatus, delta, findings, head, base, changedFiles };
  }

  async function envelope({ focus, level, lens, lastTrace = null, questionId = null, base = "main" }) {
    const current = await state({ base });
    return buildEnvelope({
      map: current.map,
      focus,
      level,
      lens,
      lastTrace,
      questionId,
      findings: current.findings,
      evidenceStatus: current.evidenceStatus
    });
  }

  async function promoteFinding(input) {
    const head = input.gitHead ?? (await git.head(projectRoot));
    const finding = await ledger.promote({ ...input, gitHead: head });
    await writeFileImpl(join(projectRoot, ".ev", "findings.md"), ledger.renderMarkdown(await ledger.all()), "utf8");
    return finding;
  }

  async function runSketch(input) {
    return sketchRunner.runSketch(input);
  }

  return { state, envelope, promoteFinding, runSketch };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test apps/daemon/tests/workbench-facade.test.mjs`
Expected: PASS, 5 tests

- [ ] **Step 5: Wire the daemon**

In `apps/daemon/server.mjs`, add after the existing imports on line 15:

```js
import { createGit } from "./lib/workbench/git.mjs";
import { createSketchRigRunner } from "./lib/workbench/sketch-rig.mjs";
import { createWorkbench } from "./lib/workbench/index.mjs";
import { loadSystemMap } from "./lib/workbench/map-model.mjs";
```

Add after the `experiments` construction (line 49):

```js
const workbenchGit = createGit();
const workbench = createWorkbench({
  projectRoot,
  store,
  git: workbenchGit,
  loadMap: () => loadSystemMap({ projectRoot }),
  sketchRunner: {
    async runSketch(input) {
      const { map } = await loadSystemMap({ projectRoot });
      return createSketchRigRunner({ projectRoot, store, map }).runSketch(input);
    }
  }
});
```

Insert these routes in `handleApi`, immediately **before** the `/api/experiments/` prefix match on line 235 (that block is a catch-all and would otherwise swallow nothing here, but keeping workbench routes together above it avoids future ordering bugs):

```js
  if (request.method === "GET" && url.pathname === "/api/workbench/state") {
    return json(response, 200, await workbench.state({ base: url.searchParams.get("base") ?? "main" }));
  }
  if (request.method === "POST" && url.pathname === "/api/workbench/envelope") {
    const body = await readJson(request);
    if (!Array.isArray(body.focus)) throw Object.assign(new Error("focus must be an array of node ids"), { statusCode: 400 });
    return json(response, 200, await workbench.envelope(body));
  }
  if (request.method === "POST" && url.pathname === "/api/workbench/findings") {
    return json(response, 200, await workbench.promoteFinding(await readJson(request)));
  }
  if (request.method === "POST" && url.pathname === "/api/workbench/sketches/run") {
    const body = await readJson(request);
    return json(response, 200, await workbench.runSketch({ sketchId: body.sketchId, inputs: body.inputs ?? {} }));
  }
```

- [ ] **Step 6: Verify the daemon boots and the route answers**

Run in one terminal: `npm run prototype`
Run in another: `curl -s http://127.0.0.1:4317/api/workbench/state | head -c 300`
Expected: JSON containing `"mapErrors":[]` and a `nodes` array. Stop the daemon afterwards.

- [ ] **Step 7: Run the full suite and commit**

Run: `npm test`
Expected: all suites pass

```bash
git add apps/daemon/lib/workbench/index.mjs apps/daemon/tests/workbench-facade.test.mjs apps/daemon/server.mjs
git commit -m "feat(workbench): expose map state, envelope, findings, and sketch runs over HTTP"
```

---

### Task 11: Visual encoding module and the SVG map

**Files:**
- Create: `apps/web/lib/encoding.mjs`, `apps/web/map.html`, `apps/web/map.css`
- Test: `apps/daemon/tests/web-encoding.test.mjs`

**Interfaces:**
- Produces:
  - `CELL` → `48` (pixels per grid cell)
  - `nodeGeometry(node)` → `{ x, y, width, height }` in pixels; area scales with `weight`
  - `fillForStatus(status)` → `"solid" | "hatch" | "hollow" | "ghost"`
  - `bandForNode(nodeId, delta)` → `"touched" | "unverified" | "neighbor" | "dim"`
  - `opacityForBand(band)` → number

- [ ] **Step 1: Write the failing test**

```js
// apps/daemon/tests/web-encoding.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { CELL, nodeGeometry, fillForStatus, bandForNode, opacityForBand } from "../../web/lib/encoding.mjs";

test("a node is centred in its grid cell and grows with weight", () => {
  const light = nodeGeometry({ x: 2, y: 1, weight: 1 });
  const heavy = nodeGeometry({ x: 2, y: 1, weight: 4 });
  assert.ok(heavy.width > light.width);
  assert.equal(light.x + light.width / 2, 2 * CELL + CELL / 2);
  assert.equal(light.y + light.height / 2, 1 * CELL + CELL / 2);
});

test("weight never produces a node wider than its cell", () => {
  for (const weight of [1, 2, 3, 4]) {
    assert.ok(nodeGeometry({ x: 0, y: 0, weight }).width <= CELL);
  }
});

test("evidence status maps to fill, never to colour", () => {
  assert.equal(fillForStatus("observed"), "solid");
  assert.equal(fillForStatus("derived"), "hatch");
  assert.equal(fillForStatus("predicted"), "hollow");
  assert.equal(fillForStatus("unknown"), "ghost");
  assert.equal(fillForStatus("nonsense"), "ghost");
});

test("touched-and-unverified outranks plain touched", () => {
  const delta = { touched: ["a", "b"], neighbors: ["c"], unverified: ["a"], untouched: ["d"] };
  assert.equal(bandForNode("a", delta), "unverified");
  assert.equal(bandForNode("b", delta), "touched");
  assert.equal(bandForNode("c", delta), "neighbor");
  assert.equal(bandForNode("d", delta), "dim");
});

test("dimming is real: untouched nodes are far fainter than touched", () => {
  assert.ok(opacityForBand("dim") < opacityForBand("neighbor"));
  assert.ok(opacityForBand("neighbor") < opacityForBand("touched"));
  assert.equal(opacityForBand("unverified"), 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/daemon/tests/web-encoding.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Write the encoding module**

```js
// apps/web/lib/encoding.mjs
export const CELL = 48;

const WEIGHT_SIZE = { 1: 18, 2: 26, 3: 34, 4: 42 };
const FILLS = { observed: "solid", derived: "hatch", predicted: "hollow", unknown: "ghost" };
const OPACITY = { unverified: 1, touched: 0.9, neighbor: 0.45, dim: 0.12 };

export function nodeGeometry(node) {
  const size = WEIGHT_SIZE[node.weight] ?? WEIGHT_SIZE[1];
  return {
    x: node.x * CELL + (CELL - size) / 2,
    y: node.y * CELL + (CELL - size) / 2,
    width: size,
    height: size
  };
}

export function fillForStatus(status) {
  return FILLS[status] ?? "ghost";
}

export function bandForNode(nodeId, delta) {
  if (!delta) return "touched";
  if (delta.unverified?.includes(nodeId)) return "unverified";
  if (delta.touched?.includes(nodeId)) return "touched";
  if (delta.neighbors?.includes(nodeId)) return "neighbor";
  return "dim";
}

export function opacityForBand(band) {
  return OPACITY[band] ?? OPACITY.dim;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test apps/daemon/tests/web-encoding.test.mjs`
Expected: PASS, 5 tests

- [ ] **Step 5: Write the page shell**

```html
<!-- apps/web/map.html -->
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Workbench</title>
<link rel="stylesheet" href="map.css">
</head>
<body>
<header class="bar">
  <span class="repo" id="repo">—</span>
  <nav class="lenses">
    <button data-lens="whole" class="on">WHOLE</button>
    <button data-lens="delta">DELTA</button>
  </nav>
  <span class="stat" id="stat"></span>
</header>
<main>
  <aside class="rail" id="rail"></aside>
  <section class="stage">
    <svg id="map" role="img" aria-label="System map"></svg>
    <footer class="hint">↑↓←→ MOVE · ? ASK · / INDEX · ENTER RUN · ESC CLEAR</footer>
  </section>
  <aside class="panel">
    <h1 id="focus-name">Nothing selected</h1>
    <p id="focus-purpose"></p>
    <dl id="focus-meta"></dl>
    <div id="thread" class="thread"></div>
    <form id="ask"><input id="ask-input" placeholder="Ask about the selection" autocomplete="off"></form>
  </aside>
</main>
<script type="module" src="map.js"></script>
</body>
</html>
```

- [ ] **Step 6: Write the stylesheet**

```css
/* apps/web/map.css */
:root {
  --paper: #cfc9a8;
  --ink: #23231d;
  --accent: #7a3b12;
  --rule: rgba(35, 35, 29, 0.28);
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink);
  font: 13px/1.5 ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace; }
.bar { display: flex; align-items: center; gap: 24px; padding: 8px 16px; border-bottom: 1px solid var(--rule); }
.lenses button { background: none; border: 1px solid var(--rule); color: inherit; font: inherit;
  padding: 2px 10px; cursor: pointer; letter-spacing: 0.08em; }
.lenses button.on { background: var(--ink); color: var(--paper); }
main { display: grid; grid-template-columns: 220px 1fr 340px; height: calc(100vh - 41px); }
.rail, .panel { overflow-y: auto; padding: 12px; }
.rail { border-right: 1px solid var(--rule); }
.panel { border-left: 1px solid var(--rule); }
.rail h2 { font-size: 10px; letter-spacing: 0.18em; opacity: 0.55; margin: 16px 0 6px; font-weight: 400; }
.rail button { display: block; width: 100%; text-align: left; background: none; border: none;
  color: inherit; font: inherit; padding: 3px 6px; cursor: pointer; }
.rail button[aria-current="true"] { background: var(--ink); color: var(--paper); }
.stage { position: relative; overflow: auto; }
svg { display: block; }
.hint { position: absolute; left: 16px; bottom: 10px; font-size: 10px; letter-spacing: 0.12em; opacity: 0.5; }
.node { cursor: pointer; }
.node rect { stroke: var(--ink); stroke-width: 1.25; }
.node[data-fill="solid"] rect { fill: var(--ink); }
.node[data-fill="hatch"] rect { fill: url(#hatch); }
.node[data-fill="hollow"] rect { fill: none; }
.node[data-fill="ghost"] rect { fill: none; stroke-dasharray: 3 3; stroke-opacity: 0.5; }
.node[data-selected="true"] rect { stroke: var(--accent); stroke-width: 2.5; }
.node text { font-size: 8px; letter-spacing: 0.06em; fill: var(--ink); pointer-events: none; }
.edge { stroke: var(--ink); stroke-opacity: 0.12; fill: none; }
.edge[data-lit="true"] { stroke-opacity: 0.7; }
.trace { stroke: var(--accent); stroke-width: 2.5; fill: none; }
.pulse { fill: var(--accent); }
.thread p { border-left: 2px solid var(--rule); padding-left: 8px; margin: 8px 0; }
#ask input { width: 100%; background: none; border: 1px solid var(--rule); color: inherit;
  font: inherit; padding: 6px; }
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/encoding.mjs apps/web/map.html apps/web/map.css apps/daemon/tests/web-encoding.test.mjs
git commit -m "feat(workbench): add the map surface shell and tested visual encoding"
```

---

### Task 12: Render, navigate, and animate

**Files:**
- Create: `apps/web/map.js`
- Test: manual browser verification (mandatory — see the spec's carried-forward limit)

**Interfaces:**
- Consumes: `GET /api/workbench/state`, `POST /api/workbench/envelope`, `POST /api/workbench/sketches/run` from Task 10; `apps/web/lib/encoding.mjs` from Task 11

- [ ] **Step 1: Write the renderer**

```js
// apps/web/map.js
import { CELL, nodeGeometry, fillForStatus, bandForNode, opacityForBand } from "./lib/encoding.mjs";

const svg = document.getElementById("map");
const rail = document.getElementById("rail");
const NS = "http://www.w3.org/2000/svg";
let state = null;
let lens = "whole";
let selected = null;

const el = (name, attrs = {}) => {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
};

async function load() {
  const response = await fetch("/api/workbench/state");
  state = await response.json();
  document.getElementById("repo").textContent = `${state.base} · ${state.head.slice(0, 7)}`;
  const hollow = Object.values(state.evidenceStatus).filter((status) => status === "unknown").length;
  document.getElementById("stat").textContent =
    `${state.map.nodes.length} nodes · ${hollow} unverified · ${state.delta.touched.length} touched`;
  renderRail();
  render();
}

function centre(node) {
  const box = nodeGeometry(node);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function render() {
  svg.innerHTML = "";
  svg.setAttribute("width", state.map.grid.cols * CELL);
  svg.setAttribute("height", state.map.grid.rows * CELL);

  const defs = el("defs");
  const pattern = el("pattern", { id: "hatch", width: 4, height: 4, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" });
  pattern.append(el("line", { x1: 0, y1: 0, x2: 0, y2: 4, stroke: "var(--ink)", "stroke-width": 1.6 }));
  defs.append(pattern);
  svg.append(defs);

  const byId = Object.fromEntries(state.map.nodes.map((node) => [node.id, node]));
  for (const edge of state.map.edges) {
    const from = centre(byId[edge.from]);
    const to = centre(byId[edge.to]);
    const lit = selected === edge.from || selected === edge.to;
    svg.append(el("path", { class: "edge", "data-lit": String(lit), d: `M${from.x} ${from.y}L${to.x} ${to.y}` }));
  }

  for (const node of state.map.nodes) {
    const box = nodeGeometry(node);
    const group = el("g", {
      class: "node",
      "data-id": node.id,
      "data-fill": fillForStatus(state.evidenceStatus[node.id]),
      "data-selected": String(selected === node.id),
      opacity: lens === "delta" ? opacityForBand(bandForNode(node.id, state.delta)) : 1
    });
    group.append(el("rect", { x: box.x, y: box.y, width: box.width, height: box.height }));
    const label = el("text", { x: box.x + box.width / 2, y: box.y + box.height + 9, "text-anchor": "middle" });
    label.textContent = node.name;
    group.append(label);
    group.addEventListener("click", () => select(node.id));
    svg.append(group);
  }
}

function renderRail() {
  rail.innerHTML = "";
  for (const group of state.map.groups) {
    const heading = document.createElement("h2");
    heading.textContent = group.label;
    rail.append(heading);
    for (const node of state.map.nodes.filter((item) => item.group === group.id)) {
      const button = document.createElement("button");
      button.textContent = node.name;
      button.dataset.id = node.id;
      button.addEventListener("click", () => select(node.id));
      rail.append(button);
    }
  }
}

async function select(nodeId) {
  selected = nodeId;
  for (const button of rail.querySelectorAll("button")) {
    button.setAttribute("aria-current", String(button.dataset.id === nodeId));
  }
  render();
  const response = await fetch("/api/workbench/envelope", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ focus: [nodeId], level: "system", lens })
  });
  const envelope = await response.json();
  const node = envelope.nodes[0];
  document.getElementById("focus-name").textContent = node?.name ?? "Nothing selected";
  document.getElementById("focus-purpose").textContent = node?.purpose ?? "";
  const meta = document.getElementById("focus-meta");
  meta.innerHTML = "";
  for (const [term, value] of [
    ["evidence", node?.evidence ?? "—"],
    ["cites", (node?.cites ?? []).join(", ") || "—"],
    ["neighbours", envelope.neighbors.join(", ") || "—"],
    ["findings", String(envelope.findings.length)]
  ]) {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = value;
    meta.append(dt, dd);
  }
  window.__envelope = envelope;
}
```

- [ ] **Step 2: Add keyboard navigation and trace animation**

Append to `apps/web/map.js`:

```js
function nearest(direction) {
  const current = state.map.nodes.find((node) => node.id === selected);
  if (!current) return state.map.nodes[0]?.id ?? null;
  const axis = direction === "left" || direction === "right" ? "x" : "y";
  const sign = direction === "right" || direction === "down" ? 1 : -1;
  const candidates = state.map.nodes
    .filter((node) => Math.sign(node[axis] - current[axis]) === sign)
    .sort((a, b) => {
      const primary = Math.abs(a[axis] - current[axis]) - Math.abs(b[axis] - current[axis]);
      const other = axis === "x" ? "y" : "x";
      return primary || Math.abs(a[other] - current[other]) - Math.abs(b[other] - current[other]);
    });
  return candidates[0]?.id ?? selected;
}

async function animateTrace(walk) {
  const byId = Object.fromEntries(state.map.nodes.map((node) => [node.id, node]));
  const points = walk.map((step) => centre(byId[step.nodeId])).filter(Boolean);
  if (points.length < 2) return;
  svg.append(el("path", { class: "trace", d: points.map((point, index) => `${index ? "L" : "M"}${point.x} ${point.y}`).join("") }));
  const dot = el("circle", { class: "pulse", r: 4, cx: points[0].x, cy: points[0].y });
  svg.append(dot);
  for (let index = 1; index < points.length; index += 1) {
    const step = walk[index];
    await new Promise((resolve) => setTimeout(resolve, Math.min(900, 120 + step.ms)));
    if (step.status === "failed") { dot.setAttribute("r", 7); return; }
    dot.setAttribute("cx", points[index].x);
    dot.setAttribute("cy", points[index].y);
  }
}

document.addEventListener("keydown", async (event) => {
  if (event.target.tagName === "INPUT") {
    if (event.key === "Escape") event.target.blur();
    return;
  }
  const moves = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
  if (moves[event.key]) { event.preventDefault(); return select(nearest(moves[event.key])); }
  if (event.key === "?") { event.preventDefault(); return document.getElementById("ask-input").focus(); }
  if (event.key === "/") { event.preventDefault(); return rail.querySelector("button")?.focus(); }
  if (event.key === "Escape") { selected = null; render(); }
});

for (const button of document.querySelectorAll(".lenses button")) {
  button.addEventListener("click", () => {
    lens = button.dataset.lens;
    for (const other of document.querySelectorAll(".lenses button")) other.classList.toggle("on", other === button);
    render();
  });
}

document.getElementById("ask").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.getElementById("ask-input");
  const paragraph = document.createElement("p");
  paragraph.textContent = `${input.value} — envelope focus: ${window.__envelope?.focus.join(", ") ?? "none"}`;
  document.getElementById("thread").append(paragraph);
  input.value = "";
});

window.runSketch = async (sketchId, inputs = {}) => {
  const response = await fetch("/api/workbench/sketches/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sketchId, inputs })
  });
  const receipt = await response.json();
  await animateTrace(receipt.walk ?? []);
  return receipt;
};

load();
```

- [ ] **Step 3: Create a real sketch rig to animate**

```js
// .ev/sketches/evidence-cache/rig.mjs
const inputs = JSON.parse(process.argv[2] ?? "{}");
const iterations = Number(inputs.iterations) || 5;
const started = performance.now();
let sum = 0;
for (let index = 0; index < iterations * 20_000; index += 1) sum += index % 7;
const latencyMs = performance.now() - started;
process.stdout.write(JSON.stringify({
  stubbed: ["git subprocess", "tmux capture"],
  frames: [
    { file: "apps/daemon/lib/evidence.mjs", ms: Math.round(latencyMs * 0.7), status: "observed" },
    { file: "apps/daemon/lib/explainer.mjs", ms: Math.round(latencyMs * 0.3), status: "observed" }
  ],
  metrics: { latencyMs: Math.round(latencyMs), iterations },
  assertions: [{ id: "under-200ms", passed: latencyMs < 200, expected: "<200ms", actual: `${Math.round(latencyMs)}ms` }],
  checksum: sum
}));
```

Note this directory is gitignored by Task 3 — it is a local scratch rig, not a committed artifact.

- [ ] **Step 4: Verify in the browser — mandatory**

Run: `npm run prototype`, then open `http://127.0.0.1:4317/map.html`.

Confirm each of these by looking, not by inference:

1. All nodes render, positioned on the grid, labelled, none overlapping.
2. Every node is dashed/hollow on first load (no findings exist yet).
3. Arrow keys move the selection spatially; the right panel updates each time.
4. `DELTA` visibly dims untouched nodes rather than brightening touched ones.
5. In the browser console, `await runSketch("evidence-cache", { iterations: 5 })` returns a receipt and a pulse travels the path.
6. `POST /api/workbench/findings` with that receipt's id turns the two nodes hatched after a reload.

Fix anything that does not hold before continuing.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test`
Expected: all suites pass

```bash
git add apps/web/map.js
git commit -m "feat(workbench): render, navigate, and animate traces on the map"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
| --- | --- |
| `map.json` + validator, hand-editable | 2, 3 |
| Pinned positions, no reshuffle | 2 (overlap + grid validation), 3 (reserved columns) |
| Flat 2D SVG, not isometric | 11, 12 |
| Evidence fill encoding, absence looks like absence | 6, 11 |
| Fidelity tier determines evidence status | 6 |
| Delta lens, blast radius, dim-not-highlight | 7, 11, 12 |
| Touched-and-hollow is the loudest signal | 7 (`unverified`), 11 (`bandForNode`) |
| Trace binding + off-map as a map-quality metric | 4 |
| Motion reserved for traces; arrest on failure | 12 |
| Keyboard-first navigation | 12 |
| Index rail grouped editorially | 11, 12 |
| Context envelope / deixis | 8, 10 |
| Tier-1 sketch rigs | 9 |
| Rigs must declare their own fakes | 9 (rejects missing `stubbed`) |
| Ledger: explicit promotion only | 5, 10 |
| Findings decay on git change | 5, 10 |
| Generated `findings.md` | 5, 10 |
| Browser verification mandatory | 12 Step 4 |

**Deferred per spec, with no task and that is correct:** tension lens, `compare`, *inside* level, tier-2 worktrees, tier-3 sweeps, bait markers, agent-authored map generation (v1 authors `.ev/map.json` by hand in Task 3), and the live agent thread behind the ask box (Task 12 Step 2 renders the envelope focus to prove deixis wiring; connecting it to the existing explainer is the first task of v2).

**Type consistency checked:** `nodeId` is the key everywhere. `Finding.stale` is written by `markStale` (Task 5) and read by `rankFor` (Task 6). `walk` entries are `{ nodeId, ms, status, order }` from Task 4 and consumed unchanged by Task 9's receipt and Task 12's `animateTrace`. `evidenceStatus` is `Record<nodeId, string>` produced in Task 6 and consumed in Tasks 7, 8, 10, 12. `delta` keys `touched / neighbors / untouched / unverified / unmappedFiles` are produced in Task 7 and read in Task 11's `bandForNode` and Task 12's stat line.

**One known gap, deliberate:** Task 12's ask box does not call a model. Wiring it to the existing read-only explainer requires deciding whether the explainer's pane-bound evidence capture should be replaced by the node envelope, which is a design decision rather than an implementation detail. v1 proves the envelope is correct and delivered; v2 connects it.
