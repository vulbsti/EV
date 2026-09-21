import { lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, resolve, relative, sep } from "node:path";

const REQUIRED_FILES = [
  "run.json",
  "events.jsonl",
  "context-manifest.json",
  "scorecard.md",
  "issues.md",
  "decision.md",
  "ui/journey.md"
];
const REQUIRED_DIRECTORIES = ["receipts", "artifacts"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T/;
const PLACEHOLDER_RE = /^(?:\[?redacted\]?|(?:not[-_ ]?set|none|null|unknown|example|changeme|replace[-_ ]?me|your[-_ ]?[^ ]+))$/i;
const SECRET_KEY_RE = /(?:api[_-]?key|access[_-]?token|auth(?:entication)?[_-]?token|client[_-]?secret|password|passphrase|private[_-]?key|authorization|bearer)/i;
const SECRET_VALUE_RES = [
  /-----BEGIN [^-]*PRIVATE KEY-----/i,
  /\bBearer\s+(?!\[REDACTED\])\S+/i,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /https?:\/\/[^\s/:]+:[^\s/@]+@/i
];

function issue(code, message, path = null, details = {}) {
  return { code, message, ...(path ? { path } : {}), ...details };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasAny(value, paths) {
  return paths.some((path) => {
    let current = value;
    for (const key of path.split(".")) current = current?.[key];
    return nonEmptyString(current) || isObject(current) || Array.isArray(current) || (typeof current === "number" && Number.isFinite(current));
  });
}

function validDate(value) {
  return nonEmptyString(value) && ISO_DATE_RE.test(value) && Number.isFinite(Date.parse(value));
}

function pathInside(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function documentedLocation(bundlePath) {
  const absolute = resolve(bundlePath);
  const parts = absolute.split(sep);
  const marker = parts.lastIndexOf("assistant-runs");
  if (marker < 1 || parts[marker - 1] !== "artifacts") {
    return { valid: false, date: null, runId: null };
  }
  const date = parts[marker + 1];
  const runId = parts[marker + 2];
  const parsedDate = date && DATE_RE.test(date) ? new Date(`${date}T00:00:00.000Z`) : null;
  const validCalendarDate = parsedDate && !Number.isNaN(parsedDate.valueOf()) && parsedDate.toISOString().slice(0, 10) === date;
  return { valid: Boolean(validCalendarDate && nonEmptyString(runId) && marker + 3 === parts.length), date, runId };
}

async function readRegularFile(bundlePath, relativePath, issues) {
  const filePath = resolve(bundlePath, relativePath);
  if (!pathInside(filePath, resolve(bundlePath))) {
    issues.push(issue("unsafe-path", "Required path escapes the run bundle.", relativePath));
    return null;
  }
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      issues.push(issue("required-file", "Required entry is not a regular file.", relativePath));
      return null;
    }
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") issues.push(issue("missing-file", "Required file is missing.", relativePath));
    else issues.push(issue("unreadable-file", "Required file could not be read.", relativePath));
    return null;
  }
}

function parseJson(source, path, issues) {
  if (source === null) return null;
  try {
    return JSON.parse(source);
  } catch {
    // Do not include parser text: malformed input can contain a credential.
    issues.push(issue("invalid-json", "File is not valid JSON.", path));
    return null;
  }
}

function validateMetadata(run, location, issues) {
  if (!isObject(run)) {
    issues.push(issue("metadata-shape", "run.json must contain a JSON object.", "run.json"));
    return;
  }

  const required = [
    ["run-id", "run identifier", ["runId", "id"]],
    ["phase", "phase", ["phase", "phaseId"]],
    ["task", "task fixture", ["taskFixture", "task", "taskId"]],
    ["repository", "repository revision", ["repositoryRevision", "repoRevision", "repository.revision", "repository.commit", "repository.sha"]],
    ["feature-flags", "feature flags", ["featureFlags"]],
    ["schema-versions", "schema versions", ["schemaVersions"]],
    ["models", "model or model versions", ["models", "model", "modelVersions"]],
    ["provider", "provider", ["provider", "providerVersion"]],
    ["harness", "harness version", ["harness", "harnessVersion"]],
    ["mandate", "mandate revision", ["mandateRevision", "mandate.revision"]],
    ["started-at", "start time", ["startedAt", "startTime"]],
    ["ended-at", "end time", ["endedAt", "endTime"]],
    ["cost", "token/tool/provider cost", ["cost", "costs"]],
    ["links", "evidence links", ["links", "evidenceLinks"]],
    ["ui-evidence", "UI evidence disposition", ["uiEvidence"]]
  ];

  for (const [code, label, paths] of required) {
    if (!hasAny(run, paths)) issues.push(issue(`metadata-${code}`, `run.json is missing ${label}.`, "run.json"));
  }
  const runId = run.runId ?? run.id;
  if (nonEmptyString(runId) && runId !== location.runId) {
    issues.push(issue("metadata-run-id", "run.json run identifier does not match its directory.", "run.json"));
  }
  const runDate = run.date ?? run.runDate;
  if (runDate !== undefined && runDate !== location.date) {
    issues.push(issue("metadata-date", "run.json date does not match its directory.", "run.json"));
  }
  for (const field of ["startedAt", "startTime", "endedAt", "endTime"]) {
    if (run[field] !== undefined && !validDate(run[field])) issues.push(issue("metadata-time", `${field} must be an ISO-8601 timestamp.`, "run.json"));
  }
  if (validDate(run.startedAt) && validDate(run.endedAt) && Date.parse(run.endedAt) < Date.parse(run.startedAt)) {
    issues.push(issue("metadata-time-order", "end time must not precede start time.", "run.json"));
  }
  const screenshotStatus = run.uiEvidence?.screenshots?.status;
  if (!["captured_sanitized", "omitted_privacy", "not_applicable"].includes(screenshotStatus)) {
    issues.push(issue("metadata-screenshot-status", "run.json must declare whether screenshots were sanitized, omitted for privacy, or not applicable.", "run.json"));
  }
}

async function validateLinks(run, bundlePath, issues) {
  const links = run?.links ?? run?.evidenceLinks;
  if (!isObject(links)) return;
  for (const [name, value] of Object.entries(links)) {
    if (!nonEmptyString(value)) {
      issues.push(issue("invalid-link", `Evidence link ${name} must be a non-empty relative path.`, "run.json"));
      continue;
    }
    const target = resolve(bundlePath, value);
    if (isAbsolute(value) || !pathInside(target, bundlePath)) {
      issues.push(issue("unsafe-link", `Evidence link ${name} escapes the run bundle.`, "run.json"));
      continue;
    }
    try {
      await lstat(target);
    } catch {
      issues.push(issue("missing-link-target", `Evidence link ${name} does not resolve inside the bundle.`, "run.json"));
    }
  }
}

function validateContextManifest(manifest, issues) {
  if (!isObject(manifest)) {
    issues.push(issue("manifest-shape", "context-manifest.json must contain a JSON object.", "context-manifest.json"));
    return;
  }
  const sections = ["transcript", "taskBrief", "personView", "relationshipPolicy", "sourceEvidence", "memoryItems", "capabilities", "mandate"];
  for (const section of sections) {
    const value = manifest[section];
    if (!isObject(value) && !Array.isArray(value)) {
      issues.push(issue("manifest-section", `context-manifest.json is missing ${section}.`, "context-manifest.json"));
      continue;
    }
    if (isObject(value) && !nonEmptyString(value.revision) && !nonEmptyString(value.status)) {
      issues.push(issue("manifest-revision", `${section} must record a revision or explicit status.`, "context-manifest.json"));
    }
  }
}

function validateEvent(event, path, line, issues) {
  if (!isObject(event)) {
    issues.push(issue("event-shape", "Each events.jsonl record must be a JSON object.", path, { line }));
    return;
  }
  if (!Number.isInteger(event.schemaVersion) || event.schemaVersion < 1) issues.push(issue("event-schema", "Event schemaVersion must be a positive integer.", path, { line }));
  if (!nonEmptyString(event.eventId)) issues.push(issue("event-id", "Event eventId is required.", path, { line }));
  if (!nonEmptyString(event.type)) issues.push(issue("event-type", "Event type is required.", path, { line }));
  if (!validDate(event.occurredAt)) issues.push(issue("event-time", "Event occurredAt must be an ISO-8601 timestamp.", path, { line }));
}

function placeholder(value) {
  return PLACEHOLDER_RE.test(String(value).trim()) || /^\$\{[^}]+\}$/.test(String(value).trim());
}

function secretLikeLine(line) {
  const inspectableLine = line.replace(/\[REDACTED\]/gi, "");
  for (const pattern of SECRET_VALUE_RES) if (pattern.test(inspectableLine)) return "secret-like token pattern";
  const assignment = inspectableLine.match(/(?:["']?)([A-Za-z][A-Za-z0-9_.-]*)(?:["']?)\s*[:=]\s*(?:["'])([^"']+)(?:["'])/);
  if (assignment && SECRET_KEY_RE.test(assignment[1]) && !placeholder(assignment[2])) return "secret-like sensitive field";
  const bareAssignment = inspectableLine.match(/(?:^|\s)([A-Za-z][A-Za-z0-9_.-]*)\s*=\s*([^\s#]+)/);
  if (bareAssignment && SECRET_KEY_RE.test(bareAssignment[1]) && !placeholder(bareAssignment[2])) return "secret-like sensitive field";
  return null;
}

function scanForSecrets(source, path, issues) {
  if (source === null) return;
  source.split(/\r?\n/).forEach((line, index) => {
    const reason = secretLikeLine(line);
    if (reason) issues.push(issue("secret-like-value", "Potential secret-like value detected; value omitted.", path, { line: index + 1, reason }));
  });
}

async function validateDirectory(bundlePath, relativePath, issues) {
  const directoryPath = resolve(bundlePath, relativePath);
  try {
    const info = await lstat(directoryPath);
    if (!info.isDirectory() || info.isSymbolicLink()) issues.push(issue("required-directory", "Required entry is not a directory.", relativePath));
  } catch (error) {
    if (error?.code === "ENOENT") issues.push(issue("missing-directory", "Required directory is missing.", relativePath));
    else issues.push(issue("unreadable-directory", "Required directory could not be inspected.", relativePath));
  }
}

async function scanDirectoryFiles(bundlePath, relativePath, issues, seen = new Set()) {
  const directoryPath = resolve(bundlePath, relativePath);
  let entries;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryRelativePath = `${relativePath}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      issues.push(issue("unsafe-entry", "Bundle contains a symbolic link; entry was not read.", entryRelativePath));
      continue;
    }
    if (entry.isDirectory()) {
      await scanDirectoryFiles(bundlePath, entryRelativePath, issues, seen);
      continue;
    }
    if (!entry.isFile() || seen.has(entryRelativePath)) continue;
    seen.add(entryRelativePath);
    try {
      const source = await readFile(resolve(bundlePath, entryRelativePath), "utf8");
      scanForSecrets(source, entryRelativePath, issues);
    } catch {
      // Binary and unreadable optional evidence are not required for shape validation.
    }
  }
}

/** Validate one artifacts/assistant-runs/<date>/<run-id> evidence bundle. */
export async function validateAssistantRunBundle(bundlePath) {
  const issues = [];
  const absoluteBundlePath = resolve(bundlePath ?? "");
  const location = documentedLocation(absoluteBundlePath);
  if (!location.valid) issues.push(issue("bundle-location", "Bundle must be artifacts/assistant-runs/<YYYY-MM-DD>/<run-id>.", absoluteBundlePath));

  try {
    const info = await lstat(absoluteBundlePath);
    if (!info.isDirectory() || info.isSymbolicLink()) issues.push(issue("bundle-directory", "Bundle path is not a regular directory.", absoluteBundlePath));
  } catch (error) {
    issues.push(issue(error?.code === "ENOENT" ? "missing-bundle" : "unreadable-bundle", "Bundle directory could not be inspected.", absoluteBundlePath));
    return { valid: false, bundlePath: absoluteBundlePath, issues };
  }

  for (const relativePath of REQUIRED_FILES) {
    const source = await readRegularFile(absoluteBundlePath, relativePath, issues);
    if (source !== null) {
      scanForSecrets(source, relativePath, issues);
      if (["scorecard.md", "issues.md", "decision.md", "ui/journey.md"].includes(relativePath) && !source.trim()) {
        issues.push(issue("empty-document", "Required document must not be empty.", relativePath));
      }
      if (relativePath === "run.json") {
        const run = parseJson(source, relativePath, issues);
        validateMetadata(run, location, issues);
        await validateLinks(run, absoluteBundlePath, issues);
      }
      if (relativePath === "context-manifest.json") {
        const manifest = parseJson(source, relativePath, issues);
        validateContextManifest(manifest, issues);
      }
      if (relativePath === "events.jsonl") {
        for (const [index, line] of source.split(/\r?\n/).entries()) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            validateEvent(event, relativePath, index + 1, issues);
          } catch {
            issues.push(issue("invalid-jsonl", "events.jsonl contains an invalid JSON record.", relativePath, { line: index + 1 }));
          }
        }
      }
    }
  }
  for (const relativePath of REQUIRED_DIRECTORIES) await validateDirectory(absoluteBundlePath, relativePath, issues);
  for (const relativePath of REQUIRED_DIRECTORIES) await scanDirectoryFiles(absoluteBundlePath, relativePath, issues);

  return {
    valid: issues.length === 0,
    bundlePath: absoluteBundlePath,
    date: location.date,
    runId: location.runId,
    issues
  };
}

export const validateAssistantRun = validateAssistantRunBundle;
