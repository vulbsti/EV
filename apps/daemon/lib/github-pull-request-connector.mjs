import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const RESOURCE_PATTERN = /^github:\/\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/pulls\/(\d{1,10})$/;
const HTTPS_PATTERN = /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/pull\/(\d{1,10})(?:[/?#].*)?$/;

function codedError(code, message, details = null) {
  return Object.assign(new Error(message), { code, details });
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseResource(value) {
  if (typeof value !== "string" || !value.trim()) throw codedError("INVALID_RESOURCE", "GitHub pull request resource is required");
  const match = value.trim().match(RESOURCE_PATTERN) ?? value.trim().match(HTTPS_PATTERN);
  if (!match) throw codedError("INVALID_RESOURCE", "Resource must be a github.com pull request URL or github://owner/repo/pulls/number reference");
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number < 1) throw codedError("INVALID_RESOURCE", "Pull request number is invalid");
  return {
    owner: match[1],
    repo: match[2],
    number,
    resourceRef: `github://${match[1]}/${match[2]}/pulls/${number}`
  };
}

function boundedText(value, maxBytes) {
  const text = String(value ?? "");
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end)) > maxBytes) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

function redactUntrustedText(value) {
  return String(value ?? "")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED GITHUB TOKEN]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED GITHUB TOKEN]")
    .replace(/\bghcr_[A-Za-z0-9]{20,}\b/g, "[REDACTED GITHUB TOKEN]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g, "[REDACTED SLACK TOKEN]")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED API TOKEN]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[REDACTED API TOKEN]")
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED JWT]")
    .replace(/\b(api[_-]?key|(?:access|auth(?:entication)?|client)?[_-]?token|client[_-]?secret|password|passphrase|private[_-]?key|authorization)\b(\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|[^\s'"`]+)/gi, "$1$2[REDACTED]")
    .replace(/(https?:\/\/[^\s:@]+:)[^\s@]+@/gi, "$1[REDACTED]@");
}

function canonicalPayload(source, resource) {
  if (!source || typeof source !== "object" || Array.isArray(source)) throw codedError("CONNECTOR_RESPONSE_INVALID", "GitHub returned an invalid pull request object");
  if (Number(source.number) !== resource.number || typeof source.updated_at !== "string") {
    throw codedError("CONNECTOR_RESPONSE_INVALID", "GitHub pull request identity or update timestamp is missing");
  }
  const updatedAt = new Date(source.updated_at);
  if (!Number.isFinite(updatedAt.getTime())) throw codedError("CONNECTOR_RESPONSE_INVALID", "GitHub returned an invalid update timestamp");
  const body = boundedText(redactUntrustedText(source.body), 64 * 1024);
  const labels = Array.isArray(source.labels)
    ? source.labels.slice(0, 50).map((label) => ({ name: boundedText(redactUntrustedText(label?.name), 256).text }))
    : [];
  return {
    provider: "github",
    kind: "pull_request",
    repository: { owner: resource.owner, name: resource.repo },
    pullRequest: {
      number: resource.number,
      title: redactUntrustedText(source.title),
      body: body.text,
      bodyTruncated: body.truncated,
      state: String(source.state ?? "unknown"),
      isDraft: Boolean(source.draft),
      url: `https://github.com/${resource.owner}/${resource.repo}/pull/${resource.number}`,
      author: source.user?.login ? redactUntrustedText(source.user.login) : null,
      baseRef: source.base?.ref ? redactUntrustedText(source.base.ref) : null,
      headRef: source.head?.ref ? redactUntrustedText(source.head.ref) : null,
      headSha: source.head?.sha ? String(source.head.sha) : null,
      baseSha: source.base?.sha ? String(source.base.sha) : null,
      labels,
      changedFiles: Number.isSafeInteger(source.changed_files) ? source.changed_files : null,
      additions: Number.isSafeInteger(source.additions) ? source.additions : null,
      deletions: Number.isSafeInteger(source.deletions) ? source.deletions : null,
      updatedAt: updatedAt.toISOString(),
      closedAt: source.closed_at ? new Date(source.closed_at).toISOString() : null,
      mergedAt: source.merged_at ? new Date(source.merged_at).toISOString() : null
    }
  };
}

function providerRevision(updatedAt, contentHash) {
  // GitHub timestamps have second precision. Keep the content suffix instead
  // of pretending same-second edits have a provider-defined order. The
  // polling connector always reads current state; numeric out-of-order logic
  // remains available to providers that expose a real monotonic revision.
  return `${new Date(updatedAt).getTime()}:${contentHash.slice(0, 16)}`;
}

function connectorEnvironment(environment = process.env) {
  const allowed = ["PATH", "HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "GH_CONFIG_DIR", "NO_COLOR"];
  const result = { GH_PROMPT_DISABLED: "1", NO_COLOR: "1" };
  for (const name of allowed) if (typeof environment[name] === "string" && environment[name]) result[name] = environment[name];
  // Tokens are intentionally not copied. The trusted host-side gh client uses
  // its configured credential store; no credential enters a worker context.
  return result;
}

async function defaultExecutor({ endpoint, timeoutMs, environment }) {
  return execFileAsync("gh", ["api", "--hostname", "github.com", "--method", "GET", "--header", "Accept: application/vnd.github+json", endpoint], {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    env: connectorEnvironment(environment)
  });
}

function mapReadError(error) {
  const message = `${error?.message ?? ""}\n${error?.stderr ?? ""}`;
  if (/HTTP 401|authentication|not logged into/i.test(message)) throw codedError("CONNECTOR_AUTH_EXPIRED", "GitHub connection is not authenticated");
  if (/rate.?limit/i.test(message)) throw codedError("CONNECTOR_RATE_LIMITED", "GitHub read limit was reached; retry after the provider window resets");
  if (/HTTP 404|Not Found/i.test(message)) throw codedError("CONNECTOR_RESOURCE_UNAVAILABLE", "GitHub pull request is unavailable to this read-only connection");
  if (/HTTP 403|forbidden/i.test(message)) throw codedError("CONNECTOR_FORBIDDEN", "GitHub connection cannot read this pull request");
  if (/timed out|ETIMEDOUT|SIGTERM/i.test(message)) throw codedError("CONNECTOR_TIMEOUT", "GitHub did not answer within the connector timeout");
  throw codedError("CONNECTOR_READ_FAILED", "GitHub pull request could not be read");
}

export class GitHubPullRequestConnector {
  constructor({ executor = defaultExecutor, timeoutMs = 15_000, environment = process.env, clock = () => new Date() } = {}) {
    if (typeof executor !== "function") throw codedError("INVALID_CONNECTOR", "executor must be a function");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw codedError("INVALID_CONNECTOR", "timeoutMs must be between 100 and 60000");
    this.executor = executor;
    this.timeoutMs = timeoutMs;
    this.environment = environment;
    this.clock = clock;
  }

  normalizeResourceRef(value) {
    return parseResource(value).resourceRef;
  }

  _now() {
    const value = this.clock();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw codedError("INVALID_CONNECTOR", "connector clock returned an invalid timestamp");
    return date.toISOString();
  }

  async read({ resourceRef, cursor = null } = {}) {
    const resource = parseResource(resourceRef);
    const endpoint = `repos/${resource.owner}/${resource.repo}/pulls/${resource.number}`;
    let stdout;
    try {
      ({ stdout } = await this.executor({ endpoint, timeoutMs: this.timeoutMs, environment: this.environment }));
    } catch (error) {
      mapReadError(error);
    }
    if (typeof stdout !== "string" || Buffer.byteLength(stdout) > 1024 * 1024) throw codedError("CONNECTOR_RESPONSE_INVALID", "GitHub response is empty or too large");
    let source;
    try { source = JSON.parse(stdout); }
    catch { throw codedError("CONNECTOR_RESPONSE_INVALID", "GitHub returned malformed JSON"); }
    const payload = canonicalPayload(source, resource);
    const contentHash = hash(payload);
    const sourceRevision = providerRevision(payload.pullRequest.updatedAt, contentHash);
    return {
      resourceRef: resource.resourceRef,
      sourceRevision,
      cursor: `github-pr:${sourceRevision}:${contentHash.slice(0, 16)}`,
      previousCursor: cursor,
      state: "fresh",
      observedAt: this._now(),
      payload,
      contentHash,
      trust: "untrusted-data",
      connector: "github-pull-request-v1"
    };
  }
}

export { connectorEnvironment, parseResource as parseGitHubPullRequestResource };
export default GitHubPullRequestConnector;
