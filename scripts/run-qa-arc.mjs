#!/usr/bin/env node
// Long-run evolution check. A model plays a person through a written life
// timeline (qa/arcs/*.json), talking to a real EV over simulated weeks. After
// each phase EV is asked fixed probe questions in a fresh conversation, and a
// judge model scores EV's memory and answers against that phase's ground truth.
// The per-phase scores form a drift curve: understanding should converge on
// the current truth, keep history as history, and not invent or resurrect.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { converse, memoryOf, memoryView, projectRoot, startServer } from "../qa/lib/ev-harness.mjs";
import { askModelJson } from "../qa/lib/model.mjs";

const DAY_MS = 86_400_000;
const { values: args } = parseArgs({
  options: {
    arc: { type: "string", default: "sam-12-weeks" },
    run: { type: "string" },
    phases: { type: "string" },
    "messages-per-session": { type: "string" },
    "sessions-per-phase": { type: "string" },
    "step-timeout-ms": { type: "string", default: "900000" },
    list: { type: "boolean", default: false },
    help: { type: "boolean", default: false }
  }
});

if (args.help) {
  console.log(`Usage: npm run qa:arc -- [--arc sam-12-weeks] [--run NAME] [--phases p1,p2] [--messages-per-session N] [--sessions-per-phase N]

Needs OPENCODE_API (or EV_QA_API_KEY) for the simulated user and judge, and
for EV itself. A run is resumable: phases already in data/qa-runs/<run>/arc-<arc>
are skipped, so --run with the same name continues the same person.`);
  process.exit(0);
}

if (args.list) {
  for (const name of (await readdir(join(projectRoot, "qa/arcs"))).filter((file) => file.endsWith(".json"))) {
    const arc = JSON.parse(await readFile(join(projectRoot, "qa/arcs", name), "utf8"));
    console.log(`${arc.id}  ${arc.phases.length} phases  ${arc.title}`);
  }
  process.exit(0);
}

const arc = JSON.parse(await readFile(join(projectRoot, "qa/arcs", `${args.arc}.json`), "utf8"));
const runId = args.run ?? `${arc.id}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const root = join(projectRoot, "data", "qa-runs", runId, `arc-${arc.id}`);
const dataDir = join(root, "ev-data");
const statePath = join(root, "state.json");
await mkdir(root, { recursive: true });
const state = existsSync(statePath) ? JSON.parse(await readFile(statePath, "utf8")) : { runId, arc: arc.id, phases: {} };
const timeoutMs = Number(args["step-timeout-ms"]);
const wanted = args.phases ? new Set(args.phases.split(",")) : null;
const messagesPerSession = Number(args["messages-per-session"] ?? arc.defaults.messagesPerSession);
const sessionsPerPhase = Number(args["sessions-per-phase"] ?? arc.defaults.sessionsPerPhase);

async function nextUserMessage({ phase, earlier, transcript, remaining }) {
  const input = [
    "You are role-playing a real person talking to their personal AI assistant, EV, in a chat app. Stay in character. Write only what this person would type next.",
    `Who you are:\n${arc.persona}`,
    earlier.length ? `Your life so far (already happened; you may refer back to it, misremember it, or contradict it if that fits your character):\n${earlier.map((item) => `- ${item.label}: ${item.situation}`).join("\n")}` : "",
    `Your life right now (${phase.label}):\n${phase.situation}`,
    `How to behave this phase:\n${phase.behaviour}`,
    `About ${Math.round(arc.defaults.workShare * 100)}% of your messages may ask EV to actually do something small (draft, research, a short script). The rest are chat, questions, opinions, venting, decisions, corrections.`,
    "Do not dump everything at once; spread information across messages like a real person. Do not narrate stage directions. Do not mention that you are role-playing.",
    `This chat session so far:\n${transcript.length ? transcript.map((line) => `${line.who}: ${line.text}`).join("\n") : "(new conversation; you are opening it)"}`,
    `Messages you have left in this session: ${remaining}.`,
    'Return JSON only: {"message": string, "kind": "chat"|"question"|"request"|"vent"|"decision"|"correction"|"other"}'
  ].filter(Boolean).join("\n\n");
  const value = await askModelJson(input, { maxOutputTokens: 600 });
  if (typeof value.message !== "string" || !value.message.trim()) throw new Error("Simulated user returned no message");
  return { text: value.message.trim().slice(0, 2_000), kind: value.kind ?? "other" };
}

async function judgePhase({ phase, memory, probes }) {
  const truth = phase.truth;
  const input = [
    "You grade how well a personal AI assistant (EV) currently understands a person, against ground truth written by the test author. EV's evidence is its stored memory and its answers to probe questions asked in a fresh conversation.",
    "For every ground-truth item decide how EV represents it now:",
    "- current items: correct (EV holds it as current), partial (vague or incomplete), stale (EV holds an older value as current), missing, wrong (contradicts it).",
    "- history items: kept_as_history (EV knows it used to be true), presented_as_current (stale), missing.",
    "- undecided items: kept_open (EV treats it as not yet decided), falsely_settled, missing.",
    "Also list: mustNotBelieve violations EV shows; contradictions inside EV's own account; facts EV states that appear nowhere in the truth (invented). Judge only from the evidence given. Missing is not wrong.",
    `Ground truth for ${phase.label}:\n${JSON.stringify(truth, null, 2)}`,
    `EV memory (claims):\n${JSON.stringify(memory, null, 2)}`,
    `Probe answers:\n${probes.map((probe) => `Q: ${probe.question}\nEV: ${[probe.reply, ...probe.later].filter(Boolean).join("\n")}`).join("\n\n")}`,
    'Return JSON only: {"items":[{"id":string,"kind":"current"|"history"|"undecided","status":string,"evidence":string}],"violations":[string],"contradictions":[string],"invented":[string],"summary":string}'
  ].join("\n\n");
  return askModelJson(input, { maxOutputTokens: 4_000, timeoutMs: 180_000 });
}

function score(judgement, phase) {
  const items = judgement.items ?? [];
  const of = (kind) => items.filter((item) => item.kind === kind);
  const ratio = (list, good) => list.length ? list.filter((item) => good.includes(item.status)).length / list.length : null;
  const current = of("current");
  return {
    currentCorrect: ratio(current, ["correct"]),
    currentCorrectOrPartial: ratio(current, ["correct", "partial"]),
    stale: items.filter((item) => ["stale", "presented_as_current"].includes(item.status)).length,
    historyKept: ratio(of("history"), ["kept_as_history"]),
    undecidedKeptOpen: ratio(of("undecided"), ["kept_open"]),
    violations: (judgement.violations ?? []).length,
    contradictions: (judgement.contradictions ?? []).length,
    invented: (judgement.invented ?? []).length,
    truthItems: phase.truth.current.length + phase.truth.history.length + phase.truth.undecided.length
  };
}

const pct = (value) => value === null || value === undefined ? "–" : `${Math.round(value * 100)}%`;

async function writeReport() {
  const lines = [
    `# ${arc.title}`, "",
    `Run \`${runId}\`. Each phase: ${sessionsPerPhase} session(s) × ${messagesPerSession} simulated messages, then ${arc.probes.length} probe questions in a fresh conversation, then a judge score against that phase's ground truth.`, "",
    "Healthy understanding: current-truth accuracy rises or holds as the arc goes on, stale stays near 0, history is kept, undecided stays open, and violations, contradictions and invented facts stay at 0.", "",
    "| Phase | Sim day | Msgs | Tasks | Memory claims | Current correct | Current ≥ partial | Stale | History kept | Undecided open | Must-not violations | Contradictions | Invented |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  ];
  for (const phase of arc.phases) {
    const result = state.phases[phase.id];
    if (!result) continue;
    const s = result.score ?? {};
    lines.push(`| ${phase.label} | ${phase.day} | ${result.messages} | ${result.tasks} | ${result.memory.length} | ${pct(s.currentCorrect)} | ${pct(s.currentCorrectOrPartial)} | ${s.stale ?? "–"} | ${pct(s.historyKept)} | ${pct(s.undecidedKeptOpen)} | ${s.violations ?? "–"} | ${s.contradictions ?? "–"} | ${s.invented ?? "–"} |`);
  }
  for (const phase of arc.phases) {
    const result = state.phases[phase.id];
    if (!result) continue;
    lines.push("", `## ${phase.label}`, "", result.judgement?.summary ?? (result.judgeError ? `Judge failed: ${result.judgeError}` : ""), "");
    for (const item of result.judgement?.items ?? []) lines.push(`- \`${item.id}\` (${item.kind}): **${item.status}**: ${item.evidence ?? ""}`);
    for (const key of ["violations", "contradictions", "invented"]) for (const entry of result.judgement?.[key] ?? []) lines.push(`- ${key}: ${entry}`);
    lines.push("", "Probe answers:", "");
    for (const probe of result.probes) lines.push(`> **${probe.question}**`, ...[probe.reply, ...probe.later].filter(Boolean).map((text) => `> ${String(text).replace(/\n/g, "\n> ")}`), "");
    lines.push("Memory at end of phase:", "", ...(result.memory.length ? result.memory.map((claim) => `- [${claim.scope}] ${claim.value}`) : ["- (empty)"]));
  }
  await writeFile(join(root, "drift.md"), `${lines.join("\n")}\n`);
}

console.log(`Arc ${arc.id}, run ${runId} → ${root}`);
for (const [phaseIndex, phase] of arc.phases.entries()) {
  if (wanted && !wanted.has(phase.id)) continue;
  if (state.phases[phase.id]) { console.log(`${phase.id} already done, skipping`); continue; }
  const earlier = arc.phases.slice(0, phaseIndex);
  const result = { phaseId: phase.id, sessions: [], probes: [], messages: 0, tasks: 0 };
  for (let session = 0; session < sessionsPerPhase; session++) {
    // Each session is a new conversation a day or so later.
    const server = await startServer(dataDir, join(root, `server-${phase.id}-s${session + 1}.log`), { timeOffsetMs: (phase.day + session) * DAY_MS });
    const conversationId = `arc-${phase.id}-s${session + 1}`;
    const transcript = [];
    try {
      for (let index = 0; index < messagesPerSession; index++) {
        const user = await nextUserMessage({ phase, earlier, transcript, remaining: messagesPerSession - index });
        transcript.push({ who: "Sam", text: user.text, kind: user.kind });
        const turn = await converse(server.baseUrl, conversationId, `${runId}-${conversationId}-m${index + 1}`, user.text, timeoutMs);
        for (const text of [turn.reply, ...turn.later].filter(Boolean)) transcript.push({ who: "EV", text });
        result.messages++;
        result.tasks += turn.started.length;
        if (turn.started.length) transcript.push({ who: "system", text: `(${turn.started.length} task(s) started: ${turn.started.map((task) => `${task.title} → ${task.status}`).join("; ")})` });
        console.log(`  ${phase.id} s${session + 1} m${index + 1} [${user.kind}] ${user.text.slice(0, 70)}${turn.started.length ? ` (+${turn.started.length} task)` : ""}`);
      }
      if (session === sessionsPerPhase - 1) {
        const probeConversation = `arc-${phase.id}-probe`;
        for (const [index, question] of arc.probes.entries()) {
          const turn = await converse(server.baseUrl, probeConversation, `${runId}-${probeConversation}-q${index + 1}`, question, timeoutMs);
          result.probes.push({ question, reply: turn.reply, later: turn.later, tasksStarted: turn.started.length });
        }
        result.memory = memoryView(await memoryOf(server.baseUrl));
      }
    } finally {
      await server.stop();
    }
    result.sessions.push({ conversationId, transcript });
  }
  try {
    result.judgement = await judgePhase({ phase, memory: result.memory, probes: result.probes });
    result.score = score(result.judgement, phase);
  } catch (error) {
    result.judgeError = error.message;
  }
  state.phases[phase.id] = result;
  await writeFile(statePath, JSON.stringify(state, null, 2));
  await writeFile(join(root, `transcript-${phase.id}.md`), result.sessions.map((session, index) => [`## ${phase.label}, session ${index + 1}`, "", ...session.transcript.map((line) => `**${line.who}:** ${line.text}`)].join("\n\n")).join("\n\n"));
  await writeReport();
  console.log(`${phase.id}: current ${pct(result.score?.currentCorrect)}, stale ${result.score?.stale ?? "–"}, violations ${result.score?.violations ?? "–"}`);
}
await writeReport();
console.log(`Drift report: ${join(root, "drift.md")}`);
