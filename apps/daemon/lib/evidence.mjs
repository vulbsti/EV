import { createHash } from "node:crypto";
import { lstat, readFile, stat } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { run } from "../../../lab/lib/process.mjs";
import { redactCommandPreview, stripTerminalControls } from "./attention.mjs";

const MAX_PATCH_CHARS = 80_000;
const MAX_FILE_PATCH_CHARS = 7_000;
const MAX_TERMINAL_CHARS = 14_000;
const MAX_CHANGED_FILES = 30;
const MAX_PROJECT_CONTEXT_CHARS = 24_000;
const MAX_PROJECT_SOURCE_CHARS = 9_000;
const PROJECT_CONTEXT_PATHS = [".ev/project.md", "PROJECT.md", "README.md", "docs/PRODUCT_BLUEPRINT.md", "docs/PROTOTYPE.md", "AGENTS.md"];
const SENSITIVE_PATH = /(?:^|\/)(?:\.env(?:\..*)?|[^/]*(?:secret|credential|private[-_]?key)[^/]*|id_(?:rsa|ed25519)|[^/]*\.(?:pem|key|p12))$/i;

function truncate(value, limit) {
  const text = String(value ?? "");
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[truncated ${text.length - limit} characters]`;
}

export function redactEvidence(value) {
  return String(value ?? "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\b(\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|[^\s'"`]+)/gi, "$1$2[REDACTED]")
    .replace(/(https?:\/\/[^\s:@]+:)[^\s@]+@/gi, "$1[REDACTED]@");
}

function parseStatus(source) {
  const records = source.split("\0").filter(Boolean);
  const changes = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const code = record.slice(0, 2);
    const path = record.slice(3);
    let originalPath = null;
    if (/[RC]/.test(code) && records[index + 1]) originalPath = records[++index];
    changes.push({
      code,
      path: SENSITIVE_PATH.test(path) ? "[sensitive path redacted]" : path,
      originalPath: originalPath && !SENSITIVE_PATH.test(originalPath) ? originalPath : originalPath ? "[sensitive path redacted]" : null,
      sensitive: SENSITIVE_PATH.test(path),
      staged: code[0] !== " " && code[0] !== "?",
      unstaged: code[1] !== " "
    });
  }
  return changes;
}

async function git(repoRoot, args, options = {}) {
  return run("git", ["-C", repoRoot, ...args], { timeoutMs: options.timeoutMs ?? 8_000, maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024 });
}

async function findRepository(cwd) {
  try {
    const info = await stat(cwd);
    if (!info.isDirectory()) return null;
    return (await git(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim() || null;
  } catch {
    return null;
  }
}

async function capturePatch(repoRoot, changes) {
  let patch = "";
  for (const change of changes.filter((item) => !item.sensitive).slice(0, MAX_CHANGED_FILES)) {
    let filePatch = "";
    if (change.code === "??") {
      const absolutePath = resolve(repoRoot, change.path);
      if (!absolutePath.startsWith(`${resolve(repoRoot)}${sep}`)) continue;
      try {
        const info = await lstat(absolutePath);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 64_000) continue;
        const content = await readFile(absolutePath, "utf8");
        if (content.includes("\0")) continue;
        filePatch = `diff --git a/${change.path} b/${change.path}\nnew untracked file\n--- /dev/null\n+++ b/${change.path}\n${content.split("\n").map((line) => `+${line}`).join("\n")}\n`;
      } catch {}
    } else {
      for (const args of [
        ["diff", "--no-ext-diff", "--unified=2", "--", change.path],
        ["diff", "--cached", "--no-ext-diff", "--unified=2", "--", change.path]
      ]) {
        if (patch.length >= MAX_PATCH_CHARS) break;
        try { filePatch += (await git(repoRoot, args)).stdout; } catch {}
      }
    }
    patch += `${truncate(redactEvidence(filePatch), MAX_FILE_PATCH_CHARS)}\n`;
    if (patch.length >= MAX_PATCH_CHARS) break;
  }
  return truncate(redactEvidence(patch), MAX_PATCH_CHARS);
}

function validationSignals(terminalTail) {
  return stripTerminalControls(terminalTail)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && /\b(?:tests?|specs?|passed|failed|build|lint|typecheck|coverage)\b/i.test(line))
    .slice(-12)
    .map((line) => truncate(redactEvidence(line), 500));
}

async function captureWorkspace(cwd) {
  const repoRoot = await findRepository(cwd);
  if (!repoRoot) return { repository: false, cwd, limitations: ["The pane working directory is not inside a Git repository."] };

  const [branchResult, headResult, statusResult, logResult] = await Promise.all([
    git(repoRoot, ["branch", "--show-current"]).catch(() => ({ stdout: "" })),
    git(repoRoot, ["rev-parse", "--short", "HEAD"]).catch(() => ({ stdout: "unborn" })),
    git(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    git(repoRoot, ["log", "-5", "--pretty=format:%h%x09%s"]).catch(() => ({ stdout: "" }))
  ]);
  const changes = parseStatus(statusResult.stdout);
  return {
    repository: true,
    cwd,
    repoRoot,
    branch: branchResult.stdout.trim() || "detached",
    head: headResult.stdout.trim(),
    changes,
    recentCommits: logResult.stdout.split("\n").filter(Boolean),
    patch: await capturePatch(repoRoot, changes),
    limitations: changes.filter((item) => item.sensitive).length
      ? ["One or more sensitive paths were withheld from the explainer."]
      : []
  };
}

function firstProjectParagraph(source) {
  return source
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/^#+\s+.*$/gm, "").replace(/\s+/g, " ").trim())
    .find((paragraph) => paragraph && !paragraph.startsWith("```") && !/^[-*]\s/.test(paragraph)) ?? "";
}

async function captureProjectContext(workspace, cwd) {
  const root = workspace.repoRoot ?? cwd;
  const sources = [];
  let remaining = MAX_PROJECT_CONTEXT_CHARS;
  for (const relativePath of PROJECT_CONTEXT_PATHS) {
    if (remaining <= 0) break;
    const absolutePath = resolve(root, relativePath);
    if (absolutePath !== root && !absolutePath.startsWith(`${resolve(root)}${sep}`)) continue;
    try {
      const info = await lstat(absolutePath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000) continue;
      const content = redactEvidence(await readFile(absolutePath, "utf8"));
      if (content.includes("\0")) continue;
      const excerpt = truncate(content, Math.min(MAX_PROJECT_SOURCE_CHARS, remaining));
      sources.push({ path: relativePath, excerpt });
      remaining -= excerpt.length;
    } catch {}
  }

  let packageMetadata = null;
  try {
    const value = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
    packageMetadata = {
      name: String(value.name ?? "").slice(0, 160),
      description: String(value.description ?? "").slice(0, 500)
    };
  } catch {}

  const readme = sources.find((source) => source.path === "README.md")?.excerpt ?? "";
  const firstSource = sources[0]?.excerpt ?? "";
  const title = (readme || firstSource).match(/^#\s+(.+)$/m)?.[1]?.trim();
  const summary = firstProjectParagraph(readme)
    || packageMetadata?.description
    || firstProjectParagraph(firstSource)
    || "No explicit project purpose was found in the captured project files.";

  return {
    root,
    name: title || packageMetadata?.name || basename(root),
    summary: truncate(summary, 700),
    sources,
    sourcePaths: sources.map((source) => source.path),
    limitation: sources.length
      ? null
      : "No project-purpose document was found. Goal alignment cannot be established reliably."
  };
}

export async function captureExplanationEvidence({ pane, store }) {
  const capturedAt = new Date().toISOString();
  const cwd = resolve(pane.path);
  const terminalTail = truncate(redactEvidence(stripTerminalControls(pane.tail)), MAX_TERMINAL_CHARS);
  const workspace = await captureWorkspace(cwd);
  const project = await captureProjectContext(workspace, cwd);
  const recentEvents = (await store.recent(200))
    .filter((event) => event.correlationId === pane.paneId || event.payload?.paneId === pane.paneId)
    .slice(0, 20)
    .map((event) => ({ type: event.type, occurredAt: event.occurredAt, correlationId: event.correlationId }));
  const evidence = {
    capturedAt,
    target: {
      paneId: pane.paneId,
      sessionName: pane.sessionName,
      command: pane.command,
      cwd,
      activity: pane.activity,
      attention: pane.attention?.required ? { label: pane.attention.label, evidence: redactCommandPreview(pane.attention.evidence) } : null
    },
    project,
    workspace,
    terminalTail,
    validationSignals: validationSignals(terminalTail),
    recentEvents,
    provenance: [
      { source: "tmux capture", confidence: "heuristic", fact: "recent visible terminal output" },
      { source: "git working tree", confidence: workspace.repository ? "direct" : "unavailable", fact: "current files and diffs" },
      { source: "EV event ledger", confidence: "direct", fact: "actions sent through EV" }
    ],
    limitations: [
      "Terminal evidence is only a bounded recent console capture. It does not contain every command, change, tool event, older line, or the executor's hidden reasoning.",
      ...(project.limitation ? [project.limitation] : []),
      ...workspace.limitations
    ]
  };
  const { capturedAt: _capturedAt, ...revisionMaterial } = evidence;
  evidence.revision = createHash("sha256").update(JSON.stringify(revisionMaterial)).digest("hex").slice(0, 12);
  return evidence;
}

export function publicEvidence(evidence) {
  const { patch: _patch, ...workspace } = evidence.workspace;
  const { sources, ...project } = evidence.project;
  const { terminalTail: _terminalTail, ...summary } = evidence;
  return {
    ...summary,
    project: { ...project, sources: sources.map((source) => ({ path: source.path })) },
    workspace,
    terminalPreview: evidence.terminalTail.trimEnd().split("\n").slice(-8).join("\n")
  };
}
