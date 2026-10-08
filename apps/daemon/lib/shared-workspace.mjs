import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ensurePrivateDirectorySync, ensurePrivateFileSync } from "./file-permissions.mjs";

/**
 * Layout for one goal that several agents work on together:
 *
 *   <workspaceRoot>/<goalId>/
 *     shared/            written only by EV, read by every agent on this goal
 *       BRIEF.md         EV's reading of the ask: intent, criteria, quality bar
 *       CONTEXT.md       what the agents need to know about the user
 *       TEAM.md          every agent on the goal, its assignment, status, result
 *       REVIEW.md        EV's review rounds and verdicts
 *     tasks/<taskId>/    one agent's own working directory
 *
 * Agents write only inside their own task directory. Shared files change
 * through this module, which serializes writers per goal and replaces files
 * atomically so an agent never reads a half-written brief.
 */
export const SHARED_DIR = "shared";
export const TASKS_DIR = "tasks";

function inside(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep));
}

export function sharedLayout(goalId, taskId = goalId) {
  return { goal: goalId, shared: `${goalId}/${SHARED_DIR}`, workspace: `${goalId}/${TASKS_DIR}/${taskId}` };
}

const locks = new Map();

/** Runs `callback` with exclusive access to one goal's shared directory. */
export async function withSharedLock(sharedPath, callback) {
  const key = resolve(sharedPath);
  const previous = locks.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const chained = previous.then(() => current);
  locks.set(key, chained);
  await previous;
  try {
    return await callback();
  } finally {
    release();
    if (locks.get(key) === chained) locks.delete(key);
  }
}

async function atomicWrite(directory, name, contents) {
  const destination = resolve(directory, name);
  if (!inside(directory, destination) || destination === directory) throw Object.assign(new Error("shared file escapes its directory"), { code: "PATH_ESCAPE" });
  ensurePrivateDirectorySync(dirname(destination));
  const existing = await lstat(destination).catch(() => null);
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw Object.assign(new Error("shared file is not a regular file"), { code: "PATH_ESCAPE" });
  const temporary = join(dirname(destination), `.${name}.${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await handle.writeFile(contents);
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  ensurePrivateFileSync(destination);
  return destination;
}

/** Writes several shared files as one locked update. */
export async function writeSharedFiles(sharedPath, files) {
  ensurePrivateDirectorySync(sharedPath);
  return withSharedLock(sharedPath, async () => {
    const written = [];
    for (const [name, contents] of Object.entries(files)) {
      if (contents === null || contents === undefined) continue;
      written.push(await atomicWrite(sharedPath, name, typeof contents === "string" ? contents : String(contents)));
    }
    return written;
  });
}

function bullet(items) {
  return items?.length ? items.map((item) => `- ${item}`).join("\n") : "- None";
}

export function renderBrief(brief, request) {
  return [
    "# Brief",
    "",
    "EV wrote this from the user's request and what it knows about them. Every agent on this goal works to it, and EV reviews the result against it.",
    "",
    "## What the user wrote",
    "",
    brief.literalAsk || request || brief.goal,
    "",
    ...(request && brief.literalAsk && request !== brief.literalAsk ? ["## What EV understood them to ask", "", request, ""] : []),
    "## What they most likely want",
    "",
    brief.intent || brief.goal,
    ...(brief.servesGoal ? ["", `This serves their goal: ${brief.servesGoal}`] : []),
    "",
    "## Goal",
    "",
    brief.goal,
    "",
    "## Success criteria",
    "",
    bullet(brief.successCriteria),
    "",
    "## Quality the user expects",
    "",
    bullet(brief.qualityBar),
    "",
    "## Assumptions EV made",
    "",
    bullet(brief.assumptions),
    "",
    "## Still unknown",
    "",
    bullet(brief.unknowns),
    "",
    "## Budget",
    "",
    `- Review rounds: up to ${brief.budget?.maxReviewRounds ?? 1}`,
    ...(brief.budget?.maxTotalTokens ? [`- Tokens per agent (excluding cache reads): ${brief.budget.maxTotalTokens.toLocaleString("en-US")}`] : []),
    ""
  ].join("\n");
}

export function renderTeam(entries) {
  const rows = entries.map((entry) => [
    `## ${entry.title}`,
    "",
    `- Task: ${entry.taskId}${entry.retryOf ? ` (retry of ${entry.retryOf})` : ""}`,
    `- Status: ${entry.status}`,
    `- Directory: ${entry.workspacePath}`,
    ...(entry.assignment ? [`- Assignment: ${entry.assignment}`] : []),
    ...(entry.summary ? [`- Result: ${entry.summary}`] : [])
  ].join("\n"));
  return ["# Team", "", "Every agent working on this goal. Read a teammate's directory for its files; write only in your own.", "", ...rows, ""].join("\n");
}

export function renderReviews(reviews) {
  if (!reviews.length) return "# Review\n\nNo review yet.\n";
  return ["# Review", "", ...reviews.map((review, index) => [
    `## Round ${index + 1}: ${review.unavailable ? "not reviewed (reviewer unavailable)" : review.verdict === "accept" ? "accepted" : "revision requested"}`,
    "",
    review.summary || "",
    ...(review.criteria?.length ? ["", "Criteria:", ...review.criteria.map((item) => `- [${item.status}] ${item.criterion}${item.note ? `: ${item.note}` : ""}`)] : []),
    ...(review.missing?.length ? ["", "Missing:", bullet(review.missing)] : []),
    ...(review.feedback?.length ? ["", "Feedback:", bullet(review.feedback)] : []),
    ""
  ].join("\n"))].join("\n");
}
