#!/usr/bin/env node
// Runs the behaviour checks and prints a scoreboard.
//
//   npm run verify                    everything
//   npm run verify -- --task 4        one task's checks
//   npm run verify -- Q-02 S-01       named checks, with full detail on failure
//   npm run verify -- --accept        record today's result as the new baseline
//   npm run verify -- --strict        exit non-zero unless every check passes
//   npm run verify -- --json          machine-readable result on stdout
//
// Exit code: 0 when nothing that used to hold has broken; 1 when a check the
// baseline says passes now fails, or the harness itself hit an error.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, startEV } from "./lib/ev.mjs";
import { NotBuilt } from "./lib/protocol.mjs";
import { selfTest } from "./lib/self-test.mjs";
import { gate } from "./lib/stand-in.mjs";

class Skip extends Error {}
const here = import.meta.dirname;
const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const valueOf = (name) => { const at = argv.indexOf(name); return at < 0 ? null : argv[at + 1]; };
const onlyTask = valueOf("--task");
const jobs = Number(valueOf("--jobs") ?? 6);
const named = argv.filter((arg, index) => /^[A-Z]-\d+$/.test(arg) && argv[index - 1] !== "--task");
const baselinePath = join(here, "baseline.json");
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));

const groups = [];
for (const file of readdirSync(join(here, "checks")).filter((name) => name.endsWith(".mjs")).sort()) {
  groups.push((await import(join(here, "checks", file))).default);
}
const all = groups.flatMap((group) => group.checks.map((check) => ({ ...check, group })));
const duplicate = all.find((check, index) => all.findIndex((other) => other.id === check.id) !== index);
if (duplicate) { console.error(`Two checks share the id ${duplicate.id}`); process.exit(2); }
const selected = all.filter((check) => named.length ? named.includes(check.id) : onlyTask ? String(check.group.task) === onlyTask : true);

async function runCheck(check) {
  if (!check.run) return { status: "open", reason: check.needs ?? "No check written yet." };
  const started = [];
  const context = {
    assert, gate, fixture, NotBuilt,
    /** For a check that cannot run on this machine (no browser, say). Never counts as a regression. */
    skip: (why) => { throw new Skip(why); },
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    /** Starts an isolated EV for this check; it is stopped when the check ends. */
    start: async (options = {}) => { const ev = await startEV({ ...options, keep: has("--keep") }); started.push(ev); return ev; }
  };
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`The check did not finish in ${(check.timeout ?? 45_000) / 1000} s`)), check.timeout ?? 45_000); });
  const startedAt = Date.now();
  let outcome;
  try {
    await Promise.race([check.run(context), limit]);
    outcome = { status: "pass" };
  } catch (error) {
    const notBuilt = error instanceof NotBuilt ? error.what : started.flatMap((ev) => ev.standIn.notBuilt)[0];
    outcome = error instanceof Skip ? { status: "skipped", reason: error.message } : notBuilt ? { status: "not-built", reason: notBuilt }
      : { status: "fail", reason: error instanceof assert.AssertionError ? error.message : error.stack ?? error.message };
  } finally { clearTimeout(timer); }
  // A pass that never exercised the thing it is about is not a pass.
  const missing = started.flatMap((ev) => ev.standIn.notBuilt)[0];
  if (outcome.status === "pass" && missing) outcome = { status: "not-built", reason: missing };
  // A script that threw is a broken check, not a verdict on EV.
  const scriptErrors = started.flatMap((ev) => ev.standIn.errors);
  if (scriptErrors.length) outcome = { status: "error", reason: scriptErrors[0] };
  outcome.ms = Date.now() - startedAt;
  outcome.log = started.map((ev) => ev.log.slice(-1_500)).join("\n---\n");
  if (has("--keep")) outcome.kept = started.map((ev) => ev.root);
  await Promise.all(started.map((ev) => ev.stop().catch(() => {})));
  return outcome;
}

// The tool-calling side of the stand-in has nothing in EV to talk to yet, so it is exercised against a reference loop first.
const harnessFault = await selfTest().catch((error) => error);
if (harnessFault) { console.error(`The verification harness failed its own self-test, so no result would mean anything:\n${harnessFault.stack ?? harnessFault}`); process.exit(2); }

const results = new Map();
const queue = [...selected];
await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, queue.length)) }, async () => {
  for (let check = queue.shift(); check; check = queue.shift()) results.set(check.id, await runCheck(check));
}));

const holds = (status) => status === "pass";
const regressions = selected.filter((check) => baseline[check.id] === "pass" && !["pass", "skipped"].includes(results.get(check.id).status));
const gained = selected.filter((check) => baseline[check.id] !== "pass" && holds(results.get(check.id).status));
const broken = selected.filter((check) => results.get(check.id).status === "error");

if (has("--accept")) {
  const next = { ...baseline };
  for (const check of selected) if (results.get(check.id).status !== "skipped") next[check.id] = holds(results.get(check.id).status) ? "pass" : "fail";
  const ordered = Object.fromEntries(all.map((check) => [check.id, next[check.id] ?? "fail"]));
  writeFileSync(baselinePath, `${JSON.stringify(ordered, null, 2)}\n`);
  writeFileSync(join(here, "BEHAVIOURS.md"), catalogue(ordered));
}

if (has("--json")) {
  console.log(JSON.stringify({
    passed: selected.filter((check) => holds(results.get(check.id).status)).length, total: selected.length,
    regressions: regressions.map((check) => check.id), gained: gained.map((check) => check.id),
    checks: selected.map((check) => ({ id: check.id, task: check.group.task, expect: check.expect, status: results.get(check.id).status, reason: results.get(check.id).reason ?? null, ms: results.get(check.id).ms }))
  }, null, 2));
} else {
  const mark = { pass: "✓", fail: "✗", "not-built": "○", open: "·", error: "!", skipped: "-" };
  const detail = named.length > 0 || has("--verbose");
  for (const group of groups) {
    const mine = selected.filter((check) => check.group === group);
    if (!mine.length) continue;
    console.log(`\n${group.task ? `Task ${group.task}  ` : ""}${group.name}  ${mine.filter((check) => holds(results.get(check.id).status)).length}/${mine.length}`);
    for (const check of mine) {
      const result = results.get(check.id);
      console.log(`  ${mark[result.status]} ${check.id}  ${check.expect}`);
      if (result.status === "pass") continue;
      const reason = String(result.reason ?? "").trim();
      const label = { "not-built": "not built: ", open: "open: ", error: "check is broken: ", skipped: "skipped here: ", fail: "" }[result.status];
      console.log(`        ${label}${detail ? reason.split("\n").join("\n        ") : reason.split("\n")[0].slice(0, 220)}`);
      if (detail && result.log?.trim()) console.log(`        EV log:\n          ${result.log.trim().split("\n").slice(-12).join("\n          ")}`);
      if (result.kept) console.log(`        kept: ${result.kept.join(", ")}`);
    }
  }
  const passed = selected.filter((check) => holds(results.get(check.id).status)).length;
  console.log(`\n${passed} of ${selected.length} behaviours hold.  ✓ holds  ✗ fails  ○ not built yet  · no check yet`);
  if (gained.length) console.log(`Newly holding: ${gained.map((check) => check.id).join(", ")}. Record with: npm run verify -- --accept`);
  if (regressions.length) console.log(`REGRESSED (held before, fails now): ${regressions.map((check) => check.id).join(", ")}`);
  if (broken.length) console.log(`Broken checks: ${broken.map((check) => check.id).join(", ")}`);
}

function catalogue(state) {
  const lines = [
    "# What EV is expected to do", "",
    "Generated by `npm run verify -- --accept` from `verify/checks/`. Do not edit by hand: change the check, then accept.", "",
    "Each line is one behaviour a person would notice. ✓ holds today, ✗ does not yet, · has no automatic check.", "",
    "None of these lines is a rule EV follows. They are of three kinds:", "",
    "- **Guarantees** hold whatever EV decides: nothing is lost, forgotten means gone, a restart changes nothing. These are the only things allowed to be fixed.",
    "- **Options** say what EV is able to do once it has judged what the person means: stop one thing and leave the rest, redirect work without losing it, send a follow-up into old work that has the context, or start something new. The check plays EV's decision and verifies that exactly that happens, and that the code never decides from the words in the message.",
    "- **Judgement**, whether EV picks the right option for this person in this situation, cannot be checked with a scripted model. It is checked with a real one, in pairs: the same words in two situations where the right action differs (`qa/scenarios/`, level 9). A system that works by rule passes at most one of each pair.", ""
  ];
  for (const group of groups) {
    lines.push(`## ${group.task ? `Task ${group.task}: ` : ""}${group.name}`, "", group.goal, "");
    for (const check of group.checks) lines.push(`- ${!check.run ? "·" : state[check.id] === "pass" ? "✓" : "✗"} **${check.id}** ${check.expect}${!check.run && check.needs ? ` _(${check.needs})_` : ""}`);
    if (group.live?.length) lines.push("", "Judgement, with a real model (`npm run qa`, scenario ids in `qa/scenarios/`):", "", ...group.live.map((line) => `- ${line}`));
    lines.push("");
  }
  return lines.join("\n");
}

process.exit(regressions.length || broken.length || (has("--strict") && selected.some((check) => !holds(results.get(check.id).status))) ? 1 : 0);
