#!/usr/bin/env node
// Drives the real EV assistant through the scripted user timelines in qa/scenarios
// and writes a transcript plus a scorecard for a human to grade. It does not
// decide pass/fail on EV's wording; it only checks counts it can observe
// (tasks started) and records memory so drift is visible between sessions.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { TERMINAL, api, memoryOf, memoryView, projectRoot, settle, startServer, tasksIn } from "../qa/lib/ev-harness.mjs";

const scenarioDir = join(projectRoot, "qa", "scenarios");

const { values: args } = parseArgs({
  options: {
    list: { type: "boolean", default: false },
    scenario: { type: "string" },
    level: { type: "string" },
    session: { type: "string" },
    run: { type: "string" },
    "base-url": { type: "string" },
    "step-timeout-ms": { type: "string", default: "600000" },
    help: { type: "boolean", default: false }
  }
});

if (args.help) {
  console.log(`Usage: npm run qa -- [--list] [--scenario L4-01,L2-02 | --level 4] [--session N --run RUN_ID] [--base-url URL]

By default each scenario gets its own EV server with an empty data directory, so
every scenario starts from a person EV has never met. --session N runs only that
session; pass --run with the earlier run id to continue the same person later.
--base-url drives an already-running server instead (its memory is NOT reset).`);
  process.exit(0);
}

async function loadScenarios() {
  const files = (await readdir(scenarioDir)).filter((name) => name.endsWith(".json")).sort();
  const all = [];
  for (const file of files) {
    const level = JSON.parse(await readFile(join(scenarioDir, file), "utf8"));
    for (const scenario of level.scenarios) all.push({ ...scenario, level: level.level, levelName: level.name });
  }
  return all;
}

function selectScenarios(all) {
  if (args.scenario) {
    const ids = new Set(args.scenario.split(",").map((id) => id.trim()));
    const missing = [...ids].filter((id) => !all.some((scenario) => scenario.id === id));
    if (missing.length) throw new Error(`Unknown scenario: ${missing.join(", ")}`);
    return all.filter((scenario) => ids.has(scenario.id));
  }
  if (args.level) return all.filter((scenario) => String(scenario.level) === args.level);
  return all;
}

function findClaim(claims, match) {
  const needle = match.toLowerCase();
  const claim = claims.find((candidate) => String(candidate.current?.value ?? "").toLowerCase().includes(needle));
  if (!claim) throw new Error(`No active memory matches "${match}"`);
  return claim;
}

async function runAction(baseUrl, step, conversationId, timeoutMs) {
  if (step.do === "wait") return { settled: await settle(baseUrl, conversationId, timeoutMs) };
  if (step.do === "memory.remember") return api(baseUrl, "/api/assistant/memory", { action: "remember", value: step.value, scope: step.scope ?? "global" });
  if (["memory.correct", "memory.stop_use", "memory.erase"].includes(step.do)) {
    const claim = findClaim(await memoryOf(baseUrl), step.match);
    const action = step.do.slice("memory.".length);
    return api(baseUrl, "/api/assistant/memory", { action, claimId: claim.claimId, value: step.value, expectedRevision: claim.current.revision, expiresAt: step.expiresAt });
  }
  if (step.do === "task.cancel") {
    const running = (await tasksIn(baseUrl, conversationId)).filter((task) => !task.parentTaskId && !TERMINAL.has(task.status));
    const task = running.at(-1);
    if (!task) return { note: "No running task to cancel" };
    return api(baseUrl, `/api/assistant/tasks/${encodeURIComponent(task.taskId)}/commands`, { commandId: `qa-cancel-${Date.now()}`, type: "cancel", expectedRevision: task.revision });
  }
  throw new Error(`Unknown action: ${step.do}`);
}

function taskSummary(task) {
  const report = task.result?.report;
  return {
    taskId: task.taskId, title: task.title, status: task.status,
    outcome: report?.outcome ?? null,
    answer: report?.answer ?? task.result?.text ?? null,
    review: report?.verification?.qualityGate ? {
      pass: report.verification.qualityGate.pass,
      summary: report.verification.qualityGate.summary,
      unavailable: Boolean(report.verification.qualityGate.unavailable),
      unresolvedIssues: report.verification.unresolvedIssues ?? []
    } : null,
    plan: task.plan ? { goal: task.plan.goal, successCriteria: task.plan.successCriteria, subtasks: task.plan.subtasks?.length ?? 0 } : null,
    error: task.error ?? null,
    contextManifestId: task.contextManifestId
  };
}

async function runSession({ baseUrl, scenario, sessionIndex, runId, timeoutMs }) {
  const session = scenario.sessions[sessionIndex];
  const conversationId = `qa-${runId}-${scenario.id}-s${sessionIndex + 1}`.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 128);
  const steps = [];
  for (const [index, step] of session.steps.entries()) {
    const record = { index, step };
    try {
      if (step.say !== undefined) {
        const before = new Set((await tasksIn(baseUrl, conversationId)).map((task) => task.taskId));
        const turn = await api(baseUrl, "/api/assistant/messages", { clientMessageId: `${conversationId}-m${index + 1}`, conversationId, text: step.say });
        const reply = turn.messages?.find((message) => message.role === "assistant") ?? turn.messages?.at(-1);
        record.reply = reply?.content ?? null;
        record.replySequence = reply?.sequence ?? null;
        const settled = step.wait === false ? { tasks: await tasksIn(baseUrl, conversationId), timedOut: false } : await settle(baseUrl, conversationId, timeoutMs);
        const started = settled.tasks.filter((task) => !before.has(task.taskId) && !task.parentTaskId);
        record.timedOut = settled.timedOut;
        record.tasksStarted = started.map(taskSummary);
        if (typeof step.tasks === "number") {
          record.autoCheck = { name: `tasks started = ${step.tasks}`, pass: started.length === step.tasks, observed: started.length };
        }
      } else {
        record.action = await runAction(baseUrl, step, conversationId, timeoutMs);
      }
    } catch (error) {
      record.error = error.message;
    }
    steps.push(record);
    process.stdout.write(`  ${scenario.id} s${sessionIndex + 1} step ${index + 1}${record.autoCheck ? ` [${record.autoCheck.pass ? "ok" : "MISMATCH"}: ${record.autoCheck.name}, saw ${record.autoCheck.observed}]` : ""}${record.error ? ` ERROR ${record.error}` : ""}\n`);
  }
  // Late results: tasks sent with wait:false finish after the session's last step.
  const finalTasks = (await settle(baseUrl, conversationId, timeoutMs)).tasks.filter((task) => !task.parentTaskId).map(taskSummary);
  // EV posts its own messages when work settles; attach each to the step it follows.
  const { messages } = await api(baseUrl, `/api/assistant/conversation?conversationId=${encodeURIComponent(conversationId)}`);
  for (const message of messages.filter((candidate) => candidate.status === "update")) {
    const owner = steps.filter((record) => record.replySequence !== undefined && record.replySequence !== null && record.replySequence < message.sequence).at(-1);
    if (owner) (owner.laterMessages ??= []).push(message.content);
  }
  const memory = await memoryOf(baseUrl);
  const manifests = {};
  for (const task of finalTasks) {
    if (!task.contextManifestId) continue;
    try {
      const manifest = await api(baseUrl, `/api/assistant/memory/manifests/${encodeURIComponent(task.contextManifestId)}`);
      manifests[task.taskId] = manifest.claimRevisionIds.map((revisionId) => memory.find((claim) => claim.current?.revisionId === revisionId)?.current?.value ?? `(revision ${revisionId}, no longer current)`);
    } catch {}
  }
  return { label: session.label, note: session.note ?? null, conversationId, steps, finalTasks, manifests, memory: memoryView(memory) };
}

const quote = (text) => String(text ?? "(none)").trim().split("\n").map((line) => `> ${line}`).join("\n");

function scorecard(result) {
  const { scenario } = result;
  const lines = [
    `# ${scenario.id} · ${scenario.title}`, "",
    `Level ${scenario.level} (${scenario.levelName}). Guards against: ${scenario.guards}.`,
    `Run \`${result.runId}\`, ${result.startedAt}.`, "",
    "Grade each box from the transcript. Tick an **Expect** box only if it clearly happened; tick a **Fail** box if it happened at all. The scenario passes when every Expect is ticked and no Fail is ticked.", ""
  ];
  for (const [index, session] of result.sessions.entries()) {
    if (!session) continue;
    lines.push(`## Session ${index + 1}: ${session.label}`, "");
    if (session.note) lines.push(`_${session.note}_`, "");
    for (const record of session.steps) {
      const { step } = record;
      if (step.say !== undefined) {
        lines.push(`**User:** ${step.say}`, "", "**EV:**", quote(record.reply), "");
        for (const later of record.laterMessages ?? []) lines.push("**EV, later:**", quote(later), "");
        for (const task of record.tasksStarted ?? []) {
          lines.push(`Task \`${task.taskId}\` (${task.status}${task.outcome ? `, ${task.outcome}` : ""})${task.review ? `, review ${task.review.unavailable ? "UNAVAILABLE" : task.review.pass ? "passed" : "flagged issues"}` : ""}${task.error ? `, error ${task.error.code ?? ""}: ${task.error.message ?? ""}` : ""}`, "");
        }
        if (record.autoCheck) lines.push(`- Auto: ${record.autoCheck.name} → saw ${record.autoCheck.observed} ${record.autoCheck.pass ? "✅" : "❌"}`);
        for (const item of step.expect ?? []) lines.push(`- [ ] Expect: ${item}`);
        for (const item of step.fail ?? []) lines.push(`- [ ] Fail: ${item}`);
        if (step.memory) lines.push(`- [ ] Memory after this step: ${step.memory}`);
        if (step.probe) lines.push(`- Probe \`${step.probe}\`: compare this answer with the same probe in other sessions for drift.`);
        if (record.timedOut) lines.push("- ⚠️ Tasks were still running when the step timeout hit.");
        if (record.error) lines.push(`- ⚠️ Step error: ${record.error}`);
        lines.push("");
      } else {
        lines.push(`_Action \`${step.do}\`${step.match ? ` on "${step.match}"` : ""}${step.value ? `: ${step.value}` : ""}${record.error ? ` failed: ${record.error}` : ""}_`, "");
      }
    }
    lines.push("**Final task results this session:**", "");
    for (const task of session.finalTasks) {
      lines.push(`- \`${task.taskId}\` ${task.title}: ${task.status}${task.outcome ? ` / ${task.outcome}` : ""}`);
      if (task.answer) lines.push(quote(task.answer.slice(0, 1500)));
      if (session.manifests[task.taskId]) lines.push(`  Memory given to this task: ${session.manifests[task.taskId].length ? session.manifests[task.taskId].map((value) => `"${value}"`).join("; ") : "none"}`);
    }
    lines.push("", "**Memory at end of session:**", "");
    lines.push(...(session.memory.length ? session.memory.map((claim) => `- [${claim.scope}] ${claim.value} (rev ${claim.revision}, by ${claim.author})`) : ["- (empty)"]), "");
  }
  lines.push("## Verdict", "", "- [ ] Pass", "- [ ] Fail", "", "Notes:", "");
  return lines.join("\n");
}

const all = await loadScenarios();
if (args.list) {
  for (const scenario of all) console.log(`${scenario.id}  L${scenario.level}  ${scenario.title}  (${scenario.sessions.length} session${scenario.sessions.length === 1 ? "" : "s"})`);
  process.exit(0);
}
const selected = selectScenarios(all);
const runId = args.run ?? new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = join(projectRoot, "data", "qa-runs", runId);
await mkdir(runRoot, { recursive: true });
const timeoutMs = Number(args["step-timeout-ms"]);
const sessionFilter = args.session ? Number(args.session) - 1 : null;
if (args["base-url"]) console.log(`Driving ${args["base-url"]}. Its memory is shared with everything else on that server, so results may be contaminated.`);
console.log(`Run ${runId} → ${runRoot}`);

for (const scenario of selected) {
  const dir = join(runRoot, scenario.id);
  await mkdir(dir, { recursive: true });
  const resultPath = join(dir, "result.json");
  const result = existsSync(resultPath)
    ? JSON.parse(await readFile(resultPath, "utf8"))
    : { runId, scenario, startedAt: new Date().toISOString(), sessions: [] };
  result.scenario = scenario;
  const indexes = sessionFilter === null ? scenario.sessions.map((_, index) => index) : [sessionFilter].filter((index) => index < scenario.sessions.length);
  if (!indexes.length) continue;
  for (const index of indexes) {
    const session = scenario.sessions[index];
    // Each session runs on a fresh server process whose clock is shifted to the
    // session's simulated day, so expiry and "weeks later" can be exercised.
    const day = session.day ?? index;
    const server = args["base-url"]
      ? { baseUrl: args["base-url"], async stop() {} }
      : await startServer(join(dir, "ev-data"), join(dir, `server-s${index + 1}.log`), { timeOffsetMs: day * 86_400_000 });
    try {
      console.log(`${scenario.id} session ${index + 1} (day ${day}): ${session.label}`);
      result.sessions[index] = await runSession({ baseUrl: server.baseUrl, scenario, sessionIndex: index, runId, timeoutMs });
      await writeFile(resultPath, JSON.stringify(result, null, 2));
      await writeFile(join(dir, "scorecard.md"), scorecard(result));
    } finally {
      await server.stop();
    }
  }
}
// One page across every scenario this run has touched, including earlier --session calls.
const rows = [];
for (const name of (await readdir(runRoot)).sort()) {
  const path = join(runRoot, name, "result.json");
  if (!existsSync(path)) continue;
  const result = JSON.parse(await readFile(path, "utf8"));
  const sessions = result.sessions.filter(Boolean);
  const checks = sessions.flatMap((session) => session.steps.map((record) => record.autoCheck).filter(Boolean));
  const tasks = sessions.flatMap((session) => session.finalTasks);
  rows.push(`| ${name} | ${result.scenario.title} | ${sessions.length}/${result.scenario.sessions.length} | ${checks.filter((check) => check.pass).length}/${checks.length} | ${tasks.length} (${tasks.filter((task) => task.status === "failed").length} failed) | ${sessions.map((session) => session.memory.length).join(" → ")} | ${sessions.flatMap((session) => session.steps).filter((record) => record.error).length} |`);
}
await writeFile(join(runRoot, "summary.md"), [
  `# QA run ${runId}`, "",
  "Auto-checks only count tasks started per message; everything else is graded by hand in each scenario's scorecard.md.", "",
  "| Scenario | Title | Sessions run | Task-count checks passed | Tasks started | Memory claims per session | Step errors |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  ...rows, ""
].join("\n"));
console.log(`Scorecards: ${runRoot}/<scenario>/scorecard.md · summary: ${runRoot}/summary.md`);
