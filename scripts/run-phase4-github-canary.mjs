#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AssistantSupervisor } from "../apps/daemon/lib/assistant-supervisor.mjs";
import { AssistantWorkerService } from "../apps/daemon/lib/assistant-worker-service.mjs";
import { GitHubPullRequestConnector } from "../apps/daemon/lib/github-pull-request-connector.mjs";
import { StandingResponsibilityStore } from "../apps/daemon/lib/standing-responsibility.mjs";
import { StandingResponsibilityRunner } from "../apps/daemon/lib/standing-runner.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const responsibilityId = `github-launch-watch-${Date.now()}`;
const root = join(projectRoot, "data", "assistant-standing-github", responsibilityId);
const workerRoot = join(root, "worker");
const artifactRoot = join(workerRoot, "artifacts");
const resourceRef = process.env.EV_GITHUB_CANARY_RESOURCE ?? "github://vulbsti/EV/pulls/2";
await mkdir(root, { recursive: true, mode: 0o700 });

const supervisor = await AssistantSupervisor.open({ statePath: join(workerRoot, "supervisor.sqlite"), artifactRoot });
const workers = new AssistantWorkerService({ supervisor, workerRoot });
await workers.start();
const store = StandingResponsibilityStore.open({ path: join(root, "standing.sqlite") });
const connector = new GitHubPullRequestConnector();

try {
  const live = await connector.read({ resourceRef });
  await store.createResponsibility({
    responsibilityId,
    ownerId: responsibilityId,
    mandate: {
      connector: "github-pull-request-v1",
      resourceRef: live.resourceRef,
      materialFields: ["pullRequest.title", "pullRequest.body", "pullRequest.state", "pullRequest.isDraft", "pullRequest.headSha"],
      freshnessMs: 5 * 60_000,
      preparedOutput: { instructions: "Prepare a concise launch-change briefing and next storyboard draft. Do not publish, comment, merge, push, label, or message anyone." },
      approvalBoundary: "prepare_only",
      reportingDestination: responsibilityId
    }
  });
  const runner = new StandingResponsibilityRunner({ store, connector, workerService: workers, workspaceRoot: join(workerRoot, "workspaces"), responsibilityId });
  const first = await runner.tick();
  const completed = await workers.waitForTask(first.consumed.supervisorTaskId);
  const duplicate = await runner.tick();
  const artifact = completed.artifacts[0];
  const delivered = await supervisor.readArtifact(artifact.artifactId);
  const text = delivered.contents.toString("utf8");
  const secretLike = /authorization\s*:|github_pat_|\bgho_|\bGH_TOKEN\b/i.test(text);
  const prepared = await store.listPreparedTasks({ responsibilityId });
  console.log(JSON.stringify({
    responsibilityId,
    provider: "github-pull-request-v1",
    realConnectedProvider: true,
    resourceRef: live.resourceRef,
    sourceRevision: live.sourceRevision,
    providerUpdatedAt: live.payload.pullRequest.updatedAt,
    task: { taskId: completed.taskId, status: completed.status, artifact },
    duplicate: { status: duplicate.status, deduped: duplicate.deduped, submitted: duplicate.submitted },
    preparedTaskCount: prepared.length,
    credentialMaterialInArtifact: secretLike,
    boundary: "prepare_only",
    providerWrites: 0
  }, null, 2));
  if (completed.status !== "completed" || duplicate.submitted !== null || prepared.length !== 1 || secretLike) process.exitCode = 1;
} finally {
  await workers.shutdown();
  store.close();
  supervisor.close();
}
