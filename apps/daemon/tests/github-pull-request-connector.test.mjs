import test from "node:test";
import assert from "node:assert/strict";

import { GitHubPullRequestConnector, connectorEnvironment, parseGitHubPullRequestResource } from "../lib/github-pull-request-connector.mjs";

function response(overrides = {}) {
  return {
    number: 2,
    title: "Launch alpha",
    body: "Date: 2026-09-30\nBlocker: review",
    state: "open",
    draft: false,
    html_url: "https://github.com/vulbsti/EV/pull/2",
    user: { login: "vulbsti" },
    base: { ref: "main" },
    head: { ref: "feat/alpha", sha: "abc123" },
    updated_at: "2026-09-22T01:02:03Z",
    closed_at: null,
    merged_at: null,
    ...overrides
  };
}

test("normalizes one strict GitHub PR resource and maps a canonical untrusted observation", async () => {
  const calls = [];
  const connector = new GitHubPullRequestConnector({ clock: () => new Date("2026-09-22T01:03:00Z"), executor: async (input) => {
    calls.push(input);
    return { stdout: JSON.stringify(response()), stderr: "" };
  } });
  assert.equal(connector.normalizeResourceRef("https://github.com/vulbsti/EV/pull/2"), "github://vulbsti/EV/pulls/2");
  const result = await connector.read({ resourceRef: "github://vulbsti/EV/pulls/2", cursor: "old" });
  assert.equal(calls[0].endpoint, "repos/vulbsti/EV/pulls/2");
  assert.equal(result.connector, "github-pull-request-v1");
  assert.equal(result.trust, "untrusted-data");
  assert.equal(result.previousCursor, "old");
  assert.match(result.sourceRevision, /^\d+:[a-f0-9]{16}$/);
  assert.equal(result.payload.pullRequest.body, "Date: 2026-09-30\nBlocker: review");
  assert.equal(result.payload.pullRequest.headSha, "abc123");
  assert.equal(result.observedAt, "2026-09-22T01:03:00.000Z");
});

test("stable content deduplicates while changed same-second content receives another revision", async () => {
  let body = "first";
  const connector = new GitHubPullRequestConnector({ executor: async () => ({ stdout: JSON.stringify(response({ body })), stderr: "" }) });
  const first = await connector.read({ resourceRef: "github://vulbsti/EV/pulls/2" });
  const repeat = await connector.read({ resourceRef: "github://vulbsti/EV/pulls/2" });
  assert.equal(first.sourceRevision, repeat.sourceRevision);
  body = "second";
  const changed = await connector.read({ resourceRef: "github://vulbsti/EV/pulls/2" });
  assert.notEqual(changed.sourceRevision, first.sourceRevision);
});

test("redacts recognizable secret-like source text before it enters durable worker input", async () => {
  const connector = new GitHubPullRequestConnector({ executor: async () => ({ stdout: JSON.stringify(response({
    title: "Launch with ghp_abcdefghijklmnopqrstuvwxyz123456",
    body: "Authorization: Bearer source-secret\napi_key=source-api-secret\ntoken=raw-secret\ngithub_pat_abcdefghijklmnopqrstuvwxyz123456\nghcr_abcdefghijklmnopqrstuvwxyz123456",
    labels: [{ name: "token=label-secret" }]
  })), stderr: "" }) });
  const result = await connector.read({ resourceRef: "github://vulbsti/EV/pulls/2" });
  assert.match(result.payload.pullRequest.title, /\[REDACTED GITHUB TOKEN\]/);
  assert.match(result.payload.pullRequest.body, /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(result.payload), /source-secret|source-api-secret|raw-secret|label-secret|ghp_abcdefghijklmnopqrstuvwxyz123456|github_pat_abcdefghijklmnopqrstuvwxyz123456|ghcr_abcdefghijklmnopqrstuvwxyz123456/);
});

test("unavailable resources and auth/rate-limit failures remain explicit", async () => {
  const missing = new GitHubPullRequestConnector({ executor: async () => { throw Object.assign(new Error("HTTP 404: Not Found"), { stderr: "HTTP 404" }); } });
  await assert.rejects(missing.read({ resourceRef: "github://vulbsti/EV/pulls/2", cursor: "known" }), (error) => error?.code === "CONNECTOR_RESOURCE_UNAVAILABLE");

  const auth = new GitHubPullRequestConnector({ executor: async () => { throw Object.assign(new Error("HTTP 401"), { stderr: "secret-provider-output" }); } });
  await assert.rejects(auth.read({ resourceRef: "github://vulbsti/EV/pulls/2" }), (error) => error?.code === "CONNECTOR_AUTH_EXPIRED" && !error.message.includes("secret-provider-output"));

  const limited = new GitHubPullRequestConnector({ executor: async () => { throw new Error("API rate limit exceeded"); } });
  await assert.rejects(limited.read({ resourceRef: "github://vulbsti/EV/pulls/2" }), (error) => error?.code === "CONNECTOR_RATE_LIMITED");
});

test("resource parsing rejects arbitrary hosts, paths, and argument-like references", () => {
  for (const value of [
    "https://example.com/vulbsti/EV/pull/2",
    "github://vulbsti/EV/issues/2",
    "github://-R/other/pulls/2 --method POST",
    "file:///tmp/secret"
  ]) assert.throws(() => parseGitHubPullRequestResource(value), (error) => error?.code === "INVALID_RESOURCE");
});

test("connector subprocess environment does not copy token variables", () => {
  const environment = connectorEnvironment({
    PATH: "/bin",
    HOME: "/tmp/home",
    GH_HOST: "attacker.example",
    GH_TOKEN: "must-not-copy",
    GITHUB_TOKEN: "must-not-copy",
    OPENAI_API_KEY: "must-not-copy"
  });
  assert.equal(environment.PATH, "/bin");
  assert.equal(environment.HOME, "/tmp/home");
  assert.equal(environment.GH_PROMPT_DISABLED, "1");
  assert.equal(environment.GH_TOKEN, undefined);
  assert.equal(environment.GITHUB_TOKEN, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.GH_HOST, undefined);
});
